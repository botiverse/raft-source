import { APPSUMO_PLAN_LIMITS, type AppSumoEntitlement } from "./appsumoPlans";
export { AI_TRAINING_CRAWLERS, aiTrainingCrawlerRobotsLines } from "./aiTrainingCrawlers";
export { APPSUMO_PLAN_LIMITS, isAppSumoTier } from "./appsumoPlans";
export type { AppSumoTier, AppSumoEntitlement, AppSumoPlanLimits } from "./appsumoPlans";
export { normalizeAppSetupUrl, normalizeAppSetupDescription, projectAppSetup, asAppSetupInstallationId, AppSetupValidationError } from "./appSetup";
export type { AppSetupState, AppSetupInstallationId } from "./appSetup";
export { validateAnnouncementAudience, matchesAnnouncementAudience, matchesAnnouncementClient, asAnnouncementRecipientUserId, ANNOUNCEMENT_AUDIENCE_MAX_IDS, ANNOUNCEMENT_AUDIENCE_MAX_CLIENTS, ANNOUNCEMENT_CLIENT_PLATFORMS, validateAnnouncementAudienceRules, matchesAnnouncementRules, matchesAnnouncementDevices, announcementDeviceOf, ANNOUNCEMENT_DEVICES, announcementRuleFlagKeys, ANNOUNCEMENT_RULE_MAX_GROUPS, ANNOUNCEMENT_RULE_MAX_CONDITIONS, ANNOUNCEMENT_RULE_ROLES, ANNOUNCEMENT_RULE_PLANS, ANNOUNCEMENT_RULE_PLATFORMS, ANNOUNCEMENT_RULE_TIME_OPS, ANNOUNCEMENT_RULE_MAX_DAYS } from "../announcement-audience";
export type { AnnouncementAudience, AnnouncementClient, AnnouncementClientPlatform, AnnouncementClientTarget, AnnouncementDeliveryScope, AnnouncementAudienceSnapshot, AnnouncementRecipientUserId, AnnouncementAudienceRules, AnnouncementConditionGroup, AnnouncementCondition, AnnouncementRuleContext, AnnouncementRulePlatform, AnnouncementRuleMatch, AnnouncementDevice } from "../announcement-audience";
import type { ActivityTurnSummary, ActivityTurnTrigger } from "./activityTurnSummary";
import type { AnnouncementContent, AnnouncementPresentation } from "../announcement-presentation";
export { validateAnnouncementPresentation } from "../announcement-presentation";
export type { AnnouncementContent, AnnouncementPresentation } from "../announcement-presentation";
// Shared types for Slock — used by server, web, and machine (daemon process)

import { makeIsMember } from "./typeGuards";
import { EXTERNAL_AGENT_RUNTIME_DISPLAY_NAME, EXTERNAL_AGENT_RUNTIME_ID, EXTERNAL_AGENT_RUNTIME_MODEL, RUNTIMES, RuntimeInfo } from "./runtimeCatalog";
import { currentDate } from "./clock";
import {
  PI_BUILTIN_PROVIDER_API_KEY_ENV_KEYS_GENERATED,
  PI_BUILTIN_PROVIDER_BLOCKED_HOST_ENV_KEYS_GENERATED,
  PI_BUILTIN_PROVIDER_CONNECTION_PROBES_GENERATED,
  PI_BUILTIN_PROVIDER_DEFAULT_MODELS_GENERATED,
  PI_BUILTIN_PROVIDER_MODELS_GENERATED,
} from "./piBuiltinModels.generated";
import { formatRuntimeProviderModelLabel } from "./runtimeProviderDisplay";
import { hydrateLegacyRuntimeConfigWithTrace } from "./runtimeConfigLegacy";
import type { AttentionHint } from "./attentionDependencyOracle";
import type { ReadinessCode, RuntimeReadinessReport } from "./readiness";
import type { EXTERNAL_AGENT_ACTIVITY_LEGACY_STATUS_VALUES, RaftAgentStatus } from "./agentStatusStandard";
import type { EXTERNAL_AGENT_ACTIVITY_DRAIN_SCHEMA, EXTERNAL_AGENT_ACTIVITY_EVENT_SCHEMA, EXTERNAL_AGENT_ACTIVITY_INGEST_SCHEMA } from "./externalAgentActivity";
import type {
  ComputerBoundDueReceiptMessage,
  ServerBoundDueReceiptMessage,
} from "./apps/reminder/protocol";

export { formatUtcTimestamp } from "./utcTimestamp";
export {
  buildSearchSnippet,
  searchSnippetCharWidth,
  SEARCH_SNIPPET_ELLIPSIS,
  SEARCH_SNIPPET_WIDTH_AFTER_HIT,
  SEARCH_SNIPPET_WIDTH_BEFORE_HIT,
} from "./searchSnippet";
export { RAFT_THEME_IDS, PRO_RAFT_THEME_IDS, isRaftThemeId, effectiveRaftTheme, raftThemeHasDecor, raftThemeDecorShown } from "./raftThemes";
export type { RaftThemeId } from "./raftThemes";

export {
  joinRaftChannelByTarget,
  parseRaftRegularChannelTarget,
  type RaftChannelJoinClient,
  type RaftChannelJoinClientResult,
  type RaftChannelJoinError,
  type RaftChannelJoinFailure,
  type RaftChannelJoinOperation,
  type RaftChannelJoinRequest,
  type RaftChannelJoinResult,
  type RaftChannelJoinSuccess,
  type RaftChannelJoinTransportError,
} from "./agentApiChannelJoin";

export {
  AGENT_MIGRATION_STATES,
  MAX_AGENT_MIGRATION_TRANSPORT_BYTES,
  MAX_AGENT_MIGRATION_TRANSFER_FILE_COUNT,
  MAX_AGENT_MIGRATION_TRANSFER_BYTES,
  MAX_AGENT_MIGRATION_EXCLUDED_REGENERABLE_COUNT,
  AGENT_MIGRATION_SOURCE_BUILD_PHASES,
  agentMigrationSourceBuildProgressReportSchema,
  AGENT_MIGRATION_SOURCE_DRAIN_WAITING_FOR,
  agentMigrationSourceDrainProgressReportSchema,
  normalizeAgentMigrationSourceDrainWaitingFor,
  agentMigrationSupportRefSchema,
  agentMigrationTransferSummarySchema,
  agentMigrationUpdatedPayloadSchema,
  AGENT_MIGRATION_TARGET_KINDS,
  AGENT_MIGRATION_HOSTED_SKIP_REASONS,
  type AgentMigrationSourceBuildProgress,
  type AgentMigrationSourceDrain,
  type AgentMigrationSourceDrainRecord,
  type AgentMigrationSourceDrainWaitingFor,
  type AgentMigrationTransferProgress,
  type AgentMigrationTransferSummary,
  type AgentMigrationUpdatedPayload,
  type AgentMigrationTargetKind,
  type AgentMigrationHostedImportLimits,
  type AgentMigrationHostedSkipReason,
  type AgentMigrationHostedImportSummary,
  AGENT_MIGRATION_WORKSPACE_SIZE_ERROR_CODES,
  agentMigrationWorkspaceSizeErrorCode,
  type AgentMigrationWorkspaceSizeErrorCode,
  type AgentMigrationReadiness,
} from "./agentMigration";
export {
  agentMigrationLogEntrySchema,
  agentMigrationLogFailureKindSchema,
  agentMigrationLogOutcomeSchema,
  agentMigrationLogResponseSchema,
  type AgentMigrationLogEntry,
  type AgentMigrationLogFailureKind,
  type AgentMigrationLogOutcome,
  type AgentMigrationLogResponse,
} from "./agentMigrationLog";
export {
  AGENT_MIGRATION_TERMINAL_FAILURE_CODES,
  AGENT_MIGRATION_USER_ERROR_CODES,
  type AgentMigrationTerminalFailureCode,
  type AgentMigrationUserErrorCode,
} from "./agentMigrationErrors";
export {
  FEATURE_FLAG_ADMIN_COLUMN_PROJECTIONS,
  FEATURE_FLAG_ADMIN_OPERATOR_ROLE,
  FEATURE_FLAG_ADMIN_ANNOUNCEMENT_RULES_REACH_FUNCTION,
  FORBIDDEN_FEATURE_FLAG_ADMIN_PRIVILEGES,
  REQUIRED_FEATURE_FLAG_ADMIN_PRIVILEGES,
  FeatureFlagAdminPrivilegeError,
  featureFlagAdminPrivilegeLabel,
  readFeatureFlagAdminPrivilegeMatrix,
  verifyFeatureFlagAdminPrivileges,
  type FeatureFlagAdminPrivilegeCheck,
  type FeatureFlagAdminPrivilegeQuery,
} from "./featureFlagAdminPrivileges";
import type { DisplayLocale } from "./displayLocales";
import type { ProviderConnectionLaunchProjection } from "./providerConnections";
import type { ProviderProbeCategory, ProviderProbeDaemonCategory, ProviderProbeId } from "./providerProbes";
import type { RuntimeAccountUsageProvider, RuntimeAccountUsageSnapshot, RuntimeLimitResetIdempotencyKey, RuntimeLimitResetKind, RuntimeLimitResetResult, RuntimeLimitResetsReadResult } from "./runtimeAccountUsage";
import { RUNTIME_AUTH_RUNTIMES, RUNTIME_AUTH_V1_RUNTIMES, RUNTIME_AUTH_V2_RUNTIMES, runtimeAuthRuntimeFor, runtimeAuthSupports } from "./runtimeAuth";
import type {
  RuntimeAuthLoginEvent,
  RuntimeAuthLoginId,
  RuntimeAuthLoginRegion,
  RuntimeAuthLoginResult,
  RuntimeAuthLogoutResult,
  RuntimeAuthProviderConnectResult,
  RuntimeAuthProvidersResult,
  RuntimeAuthRuntime,
  RuntimeAuthStatusReport,
} from "./runtimeAuth";
import type { RuntimeModelCatalogEntry } from "./runtimeModelCatalog";
import type { AgentVisibleExternalMessageProvenance } from "./externalProjection";
import type { AgentMessageCardMarker } from "./messageCard";
import type { FeedbackTranscriptLookupOutcome, FeedbackTranscriptOutcomeObjectPlan, FeedbackTranscriptUploadOutcome } from "./feedbackTranscriptOutcome";

// Joint channel limits (contract v0.3 §18.6). Servers include the host and
// unexpired pending invite targets; the free-server cap uses the same billing
// projection as every other paid gate (`canUseProBillingFeatures`).
export const MAX_JOINT_CHANNEL_SERVERS = 30;
export const MAX_JOINT_CHANNEL_FREE_SERVERS = 2;
/** A Free server may host this many Joint Channels that another server has joined. */
export const MAX_FREE_SERVER_HOSTED_JOINT_CHANNELS = 1;
// §18.8: a joint that goes over the free-server cap after joining stays
// writable for this long, then becomes read-only until back within the cap.
export const JOINT_CHANNEL_OVER_LIMIT_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

export type AgentMessageSenderType = "human" | "agent" | "system" | "third_party_app";

export interface AgentThreadContextMessage {
  message_id: string;
  sender_name: string;
  sender_description?: string | null;
  /** IANA zone the human sender's browser reported (web sends); null otherwise. */
  sender_timezone?: string | null;
  /** RFC 077: the personal assistant that sent this as its owner (the sender). */
  delegated_by?: { name: string } | null;
  sender_type: AgentMessageSenderType;
  content: string;
  timestamp: string;
  seq?: number;
  external_message?: AgentVisibleExternalMessageProvenance;
}

export interface AgentThreadJoinContext {
  reason: "mentioned";
  parent_target: string;
  thread_target: string;
  suggested_read_history_target: string;
  /** The parent/root message anchors what problem this thread is actually about. */
  parent_message: AgentThreadContextMessage;
  /** A small recent window keeps the first reply from feeling like a blind guess. */
  recent_messages: AgentThreadContextMessage[];
  history_truncated: boolean;
}

export interface AgentThreadFollowReactivation {
  /** Exact Raft thread target that can be passed back to `raft thread unfollow`. */
  thread_target: string;
}
// Agent message delivered between server/machine/MCP bridge
/** Task v2: one task hanging under a delivered chat message (see `AgentMessage.source_tasks`). */
export type AgentMessageSourceTask = {
  number: number;
  status: "backlog" | "todo" | "in_progress" | "in_review" | "done" | "closed";
  assignee_type: "human" | "agent" | null;
  assignee_id: string | null;
  assignee_name: string | null;
};

/**
 * What a first-party app tells an agent about one of its objects
 * (AgentMessage.app_event): the app's id, the object kind, and the app's own
 * fields as its registered schema allows them.
 */
export type AgentAppEvent = { app: string; kind: string } & Record<string, unknown>;

export interface AgentMessage {
  channel_id: string;
  channel_name: string;
  channel_type: "channel" | "private" | "joint" | "dm" | "thread";
  sender_id: string;
  sender_name: string;
  sender_description?: string | null;
  /** IANA zone the human sender's browser reported (web sends); null otherwise. */
  sender_timezone?: string | null;
  /** RFC 077: the personal assistant that sent this as its owner (the sender). */
  delegated_by?: { name: string } | null;
  /**
   * RFC 082: set on a card message. `content` is its fallback text; renderers
   * add `card=r<revision>` (and `updated=` once replaced) to the header line,
   * and the card's own text (`text`, markdown) under the body.
   * Absent on every other message; older daemons ignore it.
   */
  message_card?: AgentMessageCardMarker | null;
  sender_type: AgentMessageSenderType;
  content: string;
  timestamp: string;
  seq?: number;
  /** The message UUID — first 8 chars can be used as thread target (e.g. #channel:shortid) */
  message_id?: string;
  /** True only when this delivered message directly mentioned the receiving agent. */
  mentioned?: boolean;
  /**
   * True only for notify-only mention delivery to a recipient who was not
   * added to the target. Renderers must show the honest reply limitation
   * without changing the persisted message content.
   */
  non_member_mention?: boolean;
  /** For thread messages: the parent channel name (e.g. "general") or peer name for DM threads */
  parent_channel_name?: string;
  /** For thread messages: the parent channel ID */
  parent_channel_id?: string;
  /** For thread messages: the parent channel type ("channel", "private", "joint", or "dm") */
  parent_channel_type?: "channel" | "private" | "joint" | "dm";
  /** Attached files */
  attachments?: { id: string; filename: string; mimeType: string; sizeBytes?: number }[];
  /** Task fields — present when the message is (or could be) a task */
  task_status?: "backlog" | "todo" | "in_progress" | "in_review" | "done" | "closed" | null;
  task_number?: number | null;
  task_assignee_type?: "human" | "agent" | null;
  task_assignee_id?: string | null;
  task_assignee_name?: string | null;
  /**
   * Latest mutable task text for an amended task host message. The immutable
   * `content` above remains the original message and must never be rewritten.
   */
  task_current_projection?: {
    title: string;
    description: string | null;
    revision: number;
    superseded: boolean;
    amended_at: string | null;
    amended_by_type: "user" | "agent" | "system" | null;
    amended_by_name: string | null;
    source: "tasks_current_projection";
  };
  /**
   * Task v2: every task whose source message is this chat message, ascending
   * by number. Set only on servers with task v2 conversations
   * (`task_v2_conversations_v0`); renderers then show
   * `[tasks #2 in_progress @cody, #4 todo]` instead of the single-task bracket.
   */
  source_tasks?: AgentMessageSourceTask[];
  /**
   * Task v2: set on a message in a task's own conversation, which reaches
   * runtimes as `channel_type: "thread"` under the task's channel
   * (`parent_channel_*`): the task's number. Renderers then address the
   * message by the task ref (`#channel:#7`, `dm:@peer:#7`, formatted by
   * raftRefs.formatRaftChannelTaskRef / formatRaftDmTaskRef) and say to reply
   * with `raft task reply`. Absent everywhere else; older daemons ignore it.
   */
  task_conversation_number?: number;
  /** Present when the agent was auto-joined into a thread and would otherwise only see the triggering @message. */
  thread_join_context?: AgentThreadJoinContext;
  /** Present only when this direct @mention reactivated an explicitly unfollowed thread. */
  thread_follow_reactivation?: AgentThreadFollowReactivation;
  /**
   * Structured D(t) attention-oracle hint. This is not the Agent API
   * `.attention` management-result envelope; consumers should branch on the
   * `schema` discriminator before interpreting the payload.
   */
  attention_hint?: AttentionHint;
  /** Internal trace context for daemon-injected synthetic control messages. Not rendered to the agent. */
  traceparent?: string;
  /**
   * Optional producer-fact lineage for message-shaped readouts derived from an
   * APM/lifecycle decision. Consumers must treat this as an opaque join key,
   * not user content or authorization.
   */
  producerFactId?: string;
  /** Structured third-party event delivery with explicit source provenance. */
  third_party_event?: {
    id: string;
    kind: "event" | "notification" | "action_request";
    client_id: string;
    client_name: string;
    external_event_id?: string | null;
    payload_hash: string;
    payload: Record<string, unknown>;
    /**
     * Set by the Server, from the event's row, when Raft's own system app wrote
     * it (the app's id): its payload is shown as written, as its content is.
     * Absent for an external app's event, whose payload is rendered inert.
     */
    system_app?: string;
    /**
     * RFC 081, on a push to the daemon only: the inbox item this event is
     * listed under, `app:<client_id>/<object.ref>` or `app:<client_id>` (the
     * app's fallback item). Set exactly when `inbox check` lists it as an app
     * item: inbox items on for the server (the flag and
     * RAFT_INBOX_ITEMS_LAUNCH_AT), the event from launch on (or from
     * RAFT_INBOX_ITEMS_APP_EVENTS_FROM, when set earlier), and not
     * RaftBench's (`system.raftbench`). Absent otherwise, and from older
     * servers.
     */
    inbox_item_target?: string;
    /**
     * #wg-ax:#24, with `inbox_item_target`: how many unread events that item
     * holds as this one is pushed, those that joined it without a wake
     * included (they are never pushed). Absent from older servers.
     */
    inbox_item_unread?: number;
    expires_at: string;
    source: {
      /** Public OAuth client id / app key, stable for display and integrations. */
      client_id: string;
      client_name: string;
      /** Internal OAuth client row id, stable for audit/revoke joins. */
      oauth_client_id: string;
      /** Hash of the resource-bound token row id; never the bearer token. */
      access_token_id_hash?: string | null;
      resource: string;
    };
  };
  /**
   * A first-party app's notification (first-party app mechanism §六): what a
   * `system.<app>` event is about, alongside its `third_party_event` (which
   * older daemons render as before). `app` is the app's id and `kind` the
   * object kind it is about; the rest is the app's, checked by the schema the
   * app registered. Set only on those events, and only when the payload
   * passes that schema; a client may render it itself (Artifacts:
   * formatArtifactNotice over an ArtifactAgentAppEvent) instead of the
   * event's one-line summary.
   */
  app_event?: AgentAppEvent;
  /** Ordinary external-origin conversation content; always inert. */
  external_message?: AgentVisibleExternalMessageProvenance;
}

export * from "./privacyMode";
export * from "./observedFailureSummary";
export * from "./agentNameGenerator";
export * from "./agentEnvVarPolicy";
export * from "./agentTyping";
export * from "./agentModelLimits";
export * from "./runtimeErrorVisibility";
export * from "./agentActivitySubscriptions";
export * from "./agentReadProgress";
export * from "./diagnosticRedaction";
export * from "./feedbackMachineEvidence";
export * from "./machineDuplicateConnection";
export * from "./computerUpgradeDrain";
export * from "./feedbackTranscriptOutcome";
export * from "./feedbackAgentEventTail";
export * from "./scopeAttestationBudget";
export * from "./activityMute";
export * from "./inboxRefreshTrigger";
export * from "./railTabOrder";
export * from "./assistantOtterShortcut";
export * from "./composerSendKey";
export * from "./shortcutOverrides";
export * from "./channelPermissions";
export * from "./channelThreadSort";
export * from "./channelAnnouncement";
export * from "./raftPermalinks";
export * from "./notificationDisplay";
export * from "./notificationCopy";
export * from "./raftRefs";
export { raftMath } from "./markdownMath";
export { drawnQuoteEnd } from "./markdownRanges";
export { markdownHeadings } from "./markdownOutline";
export type { MarkdownHeading } from "./markdownOutline";
export * from "./subConversation";
export * from "./dmPeerRef";
export * from "./liveExecutablePath";
export * from "./thirdPartyInertRenderer";
export * from "./agentRuntimeProvider";
export * from "./producerFactLineage";
export * from "./apmHeldFreshness";
export * from "./agentWriteLanding";
export * from "./emailValidation";
export * from "./serverSlugValidation";
export { MAX_PROFILE_AVATAR_BYTES } from "./profileAvatar";
export * from "./tracing/index";
export * from "./raftCliGuide";
export * from "./tracing/eventRows";
export * from "./scopeDbAppend";
export * from "./tracing/fields";
export * from "./tracing/memory";
export * from "./tracing/assertions";
export * from "./toolDisplay";
export * from "./activityTurnSummary";
export * from "./agentUsage";
export * from "./agentOperatorEvents";
export * from "./attachmentPreview";
export * from "./typeGuards";
export type { JsonValue } from "./jsonValue";
export * from "./brandedIds";
export * from "./actionCards";
export * from "./actionCardAuthority";
export * from "./actionCardSpec";
export * from "./actionCardMessages";
export * from "./actionCardSpecBuilder";
export * from "./delegatedReceipt";
export * from "./messageCard";
export * from "./messageCardMarkdown";
export * from "./featureFlags";
export * from "./featuresChanged";
export * from "./agentContextView";
export * from "./agentContextEntries";
export * from "./agentContextViewStatus";
export * from "./agentContextViewGrant";
export * from "./upgradeGates";
export * from "./productEvents";
export * from "./externalProjection";
export * from "./slackBridgeDelivery";
export * from "./slackBridgeProvisioning";
export * from "./agentApiContract";
export * from "./actorResolveContract";
export * from "./readStateContract";
export { lazySchemaStats, warmContractSchemas } from "./lazySchema";
export * from "./thirdPartyEventId";
export * from "./agentApiRouteMeta";
export * from "./assistantDelegationPolicy";
export { ASSISTANT_OWNER_NOTES_MAX_LENGTH } from "./assistantOwnerNotes";
export {
  FORWARD_TOO_MANY_MESSAGES_CODE,
  FORWARDED_BUNDLE_ATTACHMENT_KEYS,
  FORWARDED_BUNDLE_AUTHOR_KEYS,
  FORWARDED_BUNDLE_ITEM_KEYS,
  FORWARDED_BUNDLE_METADATA_KEYS,
  FORWARDED_BUNDLE_TARGET_KEYS,
  MAX_FORWARD_DESTINATIONS,
  MAX_FORWARD_MESSAGES,
  type ForwardedBundleAttachmentSnapshot,
  type ForwardedBundleAuthorSnapshot,
  type ForwardedBundleItem,
  type ForwardedBundleMetadata,
  type ForwardedBundleTargetSnapshot,
} from "./messageForward";
export * from "./agentApiDescription";
export * from "./agentMessageText";
export * from "./agentOps/index";
export * from "./refusal";
export * from "./refusalCodes";
export * from "./agentText/index";
export * from "./agentApiRawClient";
export * from "./agentApiClient";
export * from "./agentApiMessageClient";
export * from "./daemonApiContract";
export * from "./authRefreshTiming";
export * from "./socketHandshakeErrors";
export * from "./safeReturnPath";
export * from "./integrationInvitePaths";
export * from "./clock";
export * from "./daemonApiRawClient";
export * from "./daemonApiClient";
export * from "./agentInbox";
export * from "./agentInboxProjection";
export * from "./agentInboxApp";
export * from "./agentInboxItemRow";
export * from "./attentionDependencyOracle";
export * from "./runtimeProviderDisplay";
export * from "./runtimeAccountUsage";
export * from "./runtimeAuth";
export * from "./readiness";
export * from "./systemAttention";
export * from "./runtimeModelCatalog";
export * from "./externalAgentIntegration";
export * from "./translationLanguages";
export * from "./displayLocales";
export * from "./externalLinkSchemes";
export * from "./computerReleaseNotes";
export * from "./timeFormatPreference";
export * from "./legalAcceptance";
export * from "./agentScopes";
export * from "./oauthScopes";
export * from "./oauthRedirect";
export * from "./oauthClientCategories";
export * from "./appNotifications";
export * from "./desktopNotifications";
export * from "./notifications";
export type * from "./desktopBridge";
export * from "./computerCliContract";
export * from "./desktopRoutes";
export * from "./startupMemoryContract";
// sync-core now lives in its own workspace package; this stays as a
// compatibility re-export so existing `@botiverse/raft-shared` consumers keep working.
export * from "@botiverse/raft-sync-core";
export * from "./onboardingStateMachineContract";
export * from "./cindyOnboardingContent";
export * from "./knowledgeContext";
export * from "./requestOriginHeaders";
export * from "./cliStableEntry";
export * from "./procJobs";
export * from "./processStartTime";
export * from "./capabilityInventories";

// ── Reminders (contract types) ────────────────────────────────────────────────
// Server DB owns lifecycle/recurrence. The Computer keeps a durable, versioned
// local mirror and owns due-time delivery into typed Agent Inbox. It reports
// `armed` after durable installation and asynchronously reports `fire_receipt`
// after local item+wake; neither due-time path creates a Raft message.

// `migrated`: moved to the Reminder App by the legacy import (never fires again
// here; the reminder lives on in the app).
export type ReminderStatus = "scheduled" | "fired" | "canceled" | "migrated";
// Single source of truth for runtime validation: `satisfies` keeps this list
// aligned with the ReminderStatus union (a drift is a compile error), and the
// type-guard narrows a raw string to ReminderStatus without a cast.
export const REMINDER_STATUSES = ["scheduled", "fired", "canceled", "migrated"] as const satisfies readonly ReminderStatus[];
export const isReminderStatus = (s: string): s is ReminderStatus =>
  (REMINDER_STATUSES as readonly string[]).includes(s);

/**
 * Wire-shape recurrence descriptor. The server stores a richer structured
 * form (see `services/recurrence.ts`), but the daemon timer cache and UI
 * only need the kind + a human-readable description. Unknown kinds written
 * by a newer server surface as `kind="unsupported"` so older clients render
 * "(recurring, unknown rule)" instead of crashing.
 */
export interface ReminderRecurrence {
  kind: "interval" | "daily" | "weekly" | "unsupported";
  description: string;
}

/** Daemon-side cache shape: the minimum needed to hold a local timer. */
export interface ReminderJob {
  reminderId: string;
  ownerAgentId: string;
  msgId: string | null;
  title: string;
  /** ISO-8601 UTC */
  fireAt: string;
  version: number;
  /** Non-null when this reminder auto-reschedules after fire. */
  recurrence: ReminderRecurrence | null;
}

/**
 * Server-authoritative summary shape for humans / UI. The sidebar pending
 * list, agent profile pending section, and any list API consume this.
 * Includes fields the daemon timer cache doesn't need (status, createdAt,
 * msgRef, msgPermalink) so the UI never has to reach into daemon state.
 */
export interface ReminderSummary {
  reminderId: string;
  ownerAgentId: string;
  title: string;
  /** ISO-8601 UTC */
  fireAt: string;
  /** ISO-8601 UTC. Non-null after a reminder has fired at least once. */
  firedAt?: string | null;
  /** ISO-8601 UTC */
  createdAt: string;
  status: ReminderStatus;
  /** Rendered AX label (e.g. `#engineering:abc123`), or null for free-form reminders. */
  msgRef: string | null;
  /** Clickable absolute URL for the anchor message, or null. Server-computed via raftPermalinks. */
  msgPermalink: string | null;
  /** Non-null when this reminder auto-reschedules after fire. */
  recurrence: ReminderRecurrence | null;
}

/**
 * One event a connected app sent to an agent (`POST /oauth/agent-events`), as
 * listed in the Agent panel. Visible to the agent's creator and server
 * owners/admins only. `status` is the display status: an event not delivered
 * before `expiresAt` reads as `expired`.
 */
export interface AgentAppEventSummary {
  id: string;
  app: { clientId: string; clientKey: string; name: string; logoUrl: string | null };
  kind: "event" | "notification" | "action_request";
  summary: string;
  status: "queued" | "delivered" | "expired";
  externalEventId: string | null;
  /** ISO-8601 UTC */
  createdAt: string;
  /** ISO-8601 UTC, or null while not delivered. */
  deliveredAt: string | null;
  /** ISO-8601 UTC */
  expiresAt: string;
  payloadBytes: number;
}

export interface AgentAppEventListResponse {
  events: AgentAppEventSummary[];
  /** Pass as `before` to read the next (older) page; null on the last page. */
  nextCursor: string | null;
}

export interface AgentAppEventDetail extends AgentAppEventSummary {
  /** App-supplied data. Render as inert JSON, never as instructions or links. */
  payload: Record<string, unknown>;
}

export type ReminderEventType = "scheduled" | "fired" | "snoozed" | "updated" | "canceled" | "migrated";

export interface ReminderEventSummary {
  eventId: string;
  reminderId: string;
  eventType: ReminderEventType;
  actorType: "agent" | "human" | "system";
  actorId: string | null;
  occurredAt: string;
  nextFireAt: string | null;
  metadata: Record<string, unknown> | null;
}

// ── Agent Runtime Profile (restart-time reset/notice contract) ────────────────

export type AgentRuntimeProfileMigrationStatus = "stable" | "pending" | "migrating";
export type AgentRuntimeProfilePendingKind = "migration" | "daemon_release_notice";

export interface AgentRuntimeProfileRef {
  label?: string | null;
  path?: string | null;
  machineId?: string | null;
  runtime?: string | null;
  reachable?: boolean | null;
  reason?: string | null;
}

export interface AgentRuntimeProfileReport {
  runtime: string;
  model: string;
  reasoningEffort?: RuntimeReasoningEffort | null;
  executionMode?: "byoc" | "cloud" | string | null;
  workspaceRef?: AgentRuntimeProfileRef | string | null;
  workspacePathRef?: AgentRuntimeProfileRef | string | null;
  sessionRef?: AgentRuntimeProfileRef | string | null;
}

/**
 * Which daemon-side emit trigger produced a runtime-profile report. Lets the
 * server full-view `runtime_profile.report.ingest` span attribute report
 * volume by source without relying on (lossy) daemon trace coverage —
 * distinguishes a reconnect resync dump (`connect`) from per-turn / per-session
 * emits. See task #317.
 */
export type RuntimeProfileReportSource = "connect" | "session_init" | "turn_end" | "stop";

export type AgentMigrationTransportLeaseSource = "server" | "env";
export type AgentMigrationTransferProvider = "object_store" | "tunnel";
export type AgentMigrationTransferRole = "source" | "target";
export type AgentMigrationTransferKind = "upload" | "download" | "exposed_endpoint" | "peer_endpoint";

export interface AgentMigrationTransportReady {
  provisioned: boolean;
  endpoint: string | null;
  leaseSource: AgentMigrationTransportLeaseSource | null;
  provider?: AgentMigrationTransferProvider | null;
  role?: AgentMigrationTransferRole | null;
  transferKind?: AgentMigrationTransferKind | null;
  expiresAt?: string | null;
  maxBytes?: number | null;
  protocol?: string | null;
  capabilities?: string[] | null;
  /**
   * Transfer runs alive in this daemon process. Only meaningful when
   * `capabilities` includes AGENT_MIGRATION_CAPABILITY: then a pre-flip
   * migration missing here means its run was lost (e.g. restart).
   */
  activeLeases?: Array<{ migrationId: string; transportGeneration: string; role: AgentMigrationTransferRole }>;
  observedAt: string;
}

export interface AgentRuntimeProfileChange {
  field: string;
  before?: unknown;
  after?: unknown;
}

export interface AgentRuntimeProfileSnapshot {
  runtimeProfileFingerprint?: string;
  daemonVersion?: string | null;
  machineId?: string | null;
  machineName?: string | null;
  runtime?: string | null;
  model?: string | null;
  reasoningEffort?: RuntimeReasoningEffort | null;
  executionMode?: "byoc" | "cloud" | string | null;
  workspaceRef?: AgentRuntimeProfileRef | string | null;
  workspacePathRef?: AgentRuntimeProfileRef | string | null;
  sessionRef?: AgentRuntimeProfileRef | string | null;
  observedAt?: string | null;
}

export interface AgentRuntimeProfilePending {
  kind: AgentRuntimeProfilePendingKind;
  key: string;
  migratingSince?: string | null;
  lastNudgeAt?: string | null;
  nudgeCount?: number;
  before?: AgentRuntimeProfileSnapshot | null;
  after?: AgentRuntimeProfileSnapshot | null;
  changes?: AgentRuntimeProfileChange[];
  previousSessionRef?: AgentRuntimeProfileRef | string | null;
}

export interface AgentRuntimeProfileSummary {
  current?: AgentRuntimeProfileSnapshot | null;
  migrationStatus: AgentRuntimeProfileMigrationStatus;
  pending?: AgentRuntimeProfilePending | null;
}

// Server ↔ Machine WebSocket protocol
/** One conversation's messages the model was shown: `channelId` is the conversation (thread channel for threads). */
export interface AgentModelSeenItem {
  channelId: string;
  seqs: number[];
}

/** Most conversations one `agent:model-seen` report may carry; the Server ignores the rest, the daemon splits. */
export const MODEL_SEEN_MAX_ITEMS_PER_REPORT = 50;

export const DAEMON_CAPABILITY_MODEL_SEEN_BOUNDARY = "agent:model-seen-boundary";

/**
 * Task v2: the daemon attests what the model has seen of a source message's
 * thread on `POST /tasks` with a `source_message_id` (`0` when it never read
 * it), so the Server holds a create that would miss someone's reply there.
 */
export const DAEMON_CAPABILITY_TASK_CREATE_FRESHNESS = "agent:task-create-freshness";

/**
 * How the first turn of a launch ended, as `agent:turn:ended` reports it.
 * `completed`: not interrupted, no runtime error, and the model produced output.
 */
export type AgentTurnEndedOutcome = "completed" | "interrupted" | "failed";
export const AGENT_TURN_ENDED_OUTCOMES: readonly AgentTurnEndedOutcome[] = ["completed", "interrupted", "failed"];
/** Most unread-summary targets one `agent:turn:ended` may name; the Server ignores the rest. */
export const AGENT_TURN_ENDED_MAX_SHOWN_TARGETS = 64;
/**
 * Server capability (on `machine:context.capabilities`): the server reads
 * `agent:turn:ended`. Only then does the daemon send it.
 */
export const SERVER_CAPABILITY_TURN_ENDED_V1 = "agent:turn-ended-v1";
/**
 * The Server checks a task write against the conversation it lands in
 * (agentWriteLanding.ts): it reads `seenFor` and only a boundary attested for
 * that landing. A daemon attests task writes by landing only to a Server that
 * says so; an older one compares any `seenUpToSeq` with the board.
 */
export const SERVER_CAPABILITY_TASK_WRITE_LANDING_V1 = "agent:task-write-landing-v1";
/**
 * Idle task reminder (#wg-task-v2:#9): the Server answers
 * `POST /internal/agent-api/tasks/idle-nudge` (agent API `taskIdleNudge`). A
 * daemon asks it on an agent's Working→Idle edge only when the Server says so;
 * an older Server is never called. Always advertised: the per-server
 * `task_v2_conversations_v0` flag (shared with task v2) decides, server-side, whether anything is sent
 * (`send: false`, reason `disabled`, while it is off).
 */
export const SERVER_CAPABILITY_IDLE_TASK_REMINDER_V1 = "agent:idle-task-reminder-v1";
/**
 * RFC 069 §8: the daemon reports agent state only through sequenced, replayed
 * `agent:status` frames (`daemonInstanceId` + `clientSeq`, same counter as
 * activity). A server that sees this capability lets activity frames change
 * display only, never the state that wake decisions read.
 */
export const DAEMON_CAPABILITY_SEQUENCED_STATUS = "agent:status-sequenced";
/**
 * The daemon sends `agent:runtime:ready` when a launch's runtime emits its
 * first output (startup readiness), and its spawn-time `agent:status active`
 * is then only "the process exists". A server that sees this capability ends
 * a failed-start streak on that frame, never on `active`; for daemons without
 * it, `active` keeps ending the streak.
 */
export const DAEMON_CAPABILITY_STARTUP_READINESS = "agent:startup-readiness";
/**
 * task #25 step 2: the daemon answers `agent:interrupt-turn` with
 * `agent:interrupt-turn:result`. Without it the server tells the person the
 * computer needs an upgrade instead of sending the request.
 */
export const DAEMON_CAPABILITY_INTERRUPT_TURN = "agent:interrupt-turn";
/**
 * #proj-runtime:#41: the daemon answers `agent:interrupt-subagent` with
 * `agent:interrupt-subagent:result` (stop one running sub-agent; the agent
 * and its other sub-agents keep running). Without it the server tells the
 * person the computer needs an upgrade.
 */
export const DAEMON_CAPABILITY_INTERRUPT_SUBAGENT = "agent:interrupt-subagent";
/**
 * task #17: the daemon reports runtime auth status and answers
 * `machine:runtime_auth:*` (web login / logout for a Computer's runtimes).
 * Without it the web shows no login or logout buttons for this Computer.
 */
export const DAEMON_CAPABILITY_RUNTIME_AUTH = "machine:runtime-auth";
/**
 * The daemon also signs in and out every runtime in `RUNTIME_AUTH_RUNTIMES`
 * (Kimi, Qoder). A daemon with DAEMON_CAPABILITY_RUNTIME_AUTH alone knows
 * `RUNTIME_AUTH_V1_RUNTIMES` only and drops a login or logout for any other.
 */
export const DAEMON_CAPABILITY_RUNTIME_AUTH_V2 = "machine:runtime-auth:v2";
/**
 * The daemon also lists Qwen Code's model providers and saves a provider's
 * API key in Qwen's settings (`machine:runtime_auth:providers`,
 * `machine:runtime_auth:connect_provider`). A daemon without it drops both,
 * and does not report Qwen's status.
 */
export const DAEMON_CAPABILITY_RUNTIME_AUTH_QWEN_PROVIDER = "machine:runtime-auth:qwen-provider";
/**
 * The daemon also reports Antigravity's sign-in status and runs its login
 * (OAR 0.97 `agy acp --login`, the pasted code relayed). A daemon without it
 * drops a login for Antigravity and never reports it.
 */
export const DAEMON_CAPABILITY_RUNTIME_AUTH_ANTIGRAVITY = "machine:runtime-auth:antigravity";
/**
 * The daemon also signs the Pi runtime in and out per model provider, in the
 * Computer's own Pi sign-ins (`~/.pi/agent/auth.json`, OAR's
 * `createPiProviderAuth`): a login, a logout and a provider connect for `pi`
 * carry `providerId`, and the provider list (`machine:runtime_auth:providers`)
 * is pi's own `/login` list. A daemon without it drops all of them and never
 * reports Pi's status.
 */
export const DAEMON_CAPABILITY_RUNTIME_AUTH_PI = "machine:runtime-auth:pi";
/**
 * The daemon also reports Grok Build's sign-in status and runs its login and
 * logout (OAR 0.99: `grok login --device-auth`, its device code relayed;
 * `grok logout`, confirmed with `grok models`). A daemon without it (OAR 0.98
 * or older has no Grok sign-in) drops both and never reports Grok's status,
 * so it is never sent either: the web offers an upgrade instead.
 */
export const DAEMON_CAPABILITY_RUNTIME_AUTH_GROK = "machine:runtime-auth:grok";
/**
 * The daemon also signs OpenCode 2 in and out per provider, and saves a
 * provider's API key, through OpenCode's own server (OAR 0.100
 * `createOpencodeProviderAuth`, one long-lived facade per Computer): a login,
 * a logout and a provider connect for `opencode` carry `providerId`, a login
 * may name the OAuth method chosen (`oauthMethod`), and the provider list is
 * OpenCode's own integration registry. A daemon without it (OAR 0.99 or
 * older) drops all of them and never reports OpenCode's status: the web
 * offers an upgrade instead.
 */
export const DAEMON_CAPABILITY_RUNTIME_AUTH_OPENCODE = "machine:runtime-auth:opencode";
/**
 * The daemon also reports CodeBuddy Code's sign-in status and runs its login
 * and logout (OAR 0.100+: the stream-json `authenticate`, its link relayed;
 * `logout`, confirmed by `initialize.account`). A daemon without it (no
 * CodeBuddy in its OAR runtimes) drops both and never reports CodeBuddy's
 * status, so it is never sent either: the web offers an upgrade instead.
 */
export const DAEMON_CAPABILITY_RUNTIME_AUTH_CODEBUDDY = "machine:runtime-auth:codebuddy";

/**
 * The daemon also logs Antigravity out (OAR 0.98 agy ACP `logout`, confirmed
 * with `agy models`). A daemon with DAEMON_CAPABILITY_RUNTIME_AUTH_ANTIGRAVITY
 * but without this one runs on OAR 0.97, which has no Antigravity logout: it
 * would answer one unsupported, so it is never sent one.
 */
export const DAEMON_CAPABILITY_RUNTIME_AUTH_ANTIGRAVITY_LOGOUT = "machine:runtime-auth:antigravity-logout";

/**
 * Runtimes whose logout came after their login: a Computer signs them out from
 * the web only when its daemon advertises the capability named here.
 */
const RUNTIME_AUTH_LOGOUT_CAPABILITY: Readonly<Partial<Record<RuntimeAuthRuntime, string>>> = {
  antigravity: DAEMON_CAPABILITY_RUNTIME_AUTH_ANTIGRAVITY_LOGOUT,
};

/** Whether signing this runtime out needs a daemon capability beyond its sign-in (Antigravity's). */
export function runtimeAuthLogoutNeedsCapability(runtime: RuntimeAuthRuntime): boolean {
  return RUNTIME_AUTH_LOGOUT_CAPABILITY[runtime] !== undefined;
}

/** The runtimes a Computer signs out from the web, from its `ready` capabilities: those it signs in that have a logout it runs. */
export function runtimeAuthLogoutRuntimesOfComputer(capabilities: readonly string[]): readonly RuntimeAuthRuntime[] {
  return runtimeAuthRuntimesOfComputer(capabilities).filter((runtime) => {
    if (!runtimeAuthSupports(runtime, "logout")) return false;
    const capability = RUNTIME_AUTH_LOGOUT_CAPABILITY[runtime];
    return capability === undefined || capabilities.includes(capability);
  });
}

/**
 * The runtime each optional capability adds (on top of a V2 daemon's), in
 * `RUNTIME_AUTH_RUNTIMES` order. Lists are kept per combination, so the same
 * capabilities always give the same array.
 */
const RUNTIME_AUTH_OPTIONAL_CAPABILITIES: ReadonlyArray<readonly [RuntimeAuthRuntime, string]> = [
  ["qwen", DAEMON_CAPABILITY_RUNTIME_AUTH_QWEN_PROVIDER],
  ["antigravity", DAEMON_CAPABILITY_RUNTIME_AUTH_ANTIGRAVITY],
  ["pi", DAEMON_CAPABILITY_RUNTIME_AUTH_PI],
  ["grok", DAEMON_CAPABILITY_RUNTIME_AUTH_GROK],
  ["opencode", DAEMON_CAPABILITY_RUNTIME_AUTH_OPENCODE],
  ["codebuddy", DAEMON_CAPABILITY_RUNTIME_AUTH_CODEBUDDY],
];
const runtimeAuthRuntimeLists = new Map<string, readonly RuntimeAuthRuntime[]>();

/** The runtimes a Computer signs in and out (or connects a provider for) from the web, from its `ready` capabilities. */
export function runtimeAuthRuntimesOfComputer(capabilities: readonly string[]): readonly RuntimeAuthRuntime[] {
  if (!capabilities.includes(DAEMON_CAPABILITY_RUNTIME_AUTH)) return [];
  if (!capabilities.includes(DAEMON_CAPABILITY_RUNTIME_AUTH_V2)) return RUNTIME_AUTH_V1_RUNTIMES;
  const added = new Set(RUNTIME_AUTH_OPTIONAL_CAPABILITIES.filter(([, capability]) => capabilities.includes(capability)).map(([runtime]) => runtime));
  const key = [...added].join(",");
  let list = runtimeAuthRuntimeLists.get(key);
  if (!list) {
    const v2: readonly RuntimeAuthRuntime[] = RUNTIME_AUTH_V2_RUNTIMES;
    list = RUNTIME_AUTH_RUNTIMES.filter((runtime) => v2.includes(runtime) || added.has(runtime));
    runtimeAuthRuntimeLists.set(key, list);
  }
  return list;
}

/**
 * task #17 (server capability, on `machine:context.capabilities`): the server
 * reads `machine:runtime_auth:status`. Only then does the daemon run the
 * runtimes' status queries and send the report.
 */
export const SERVER_CAPABILITY_RUNTIME_AUTH_V1 = "machine:runtime-auth-v1";
/**
 * Server capability: the server reads the runtimes beyond
 * `RUNTIME_AUTH_V1_RUNTIMES` (Kimi, Qoder) in `machine:runtime_auth:status`
 * and ignores a runtime it does not know, so a runtime added later (Qwen
 * Code) needs no new capability: a server from before it drops that key and
 * keeps the rest. Without it the daemon reports `RUNTIME_AUTH_V1_RUNTIMES`
 * only: an older server refuses a whole report that names any other runtime.
 */
export const SERVER_CAPABILITY_RUNTIME_AUTH_V2 = "machine:runtime-auth-v2";
/**
 * Reconciler step 15 (server capability, on `machine:context.capabilities`):
 * the server reads `machine:runtime_credentials:changed` and lifts the sign-in
 * pauses of that runtime's agents on this Computer's shared sign-in. Only
 * then does the daemon watch the shared credential homes and send the frame.
 */
export const SERVER_CAPABILITY_RUNTIME_CREDENTIALS_CHANGED_V1 = "machine:runtime-credentials-changed-v1";
/**
 * Server capability (on `machine:context.capabilities`): the server's
 * runtime-usage snapshot schema reads `accounts[].limitResetsAvailable`. A
 * Computer includes that field only when the server advertises this; an older
 * server's strict schema would refuse the whole snapshot.
 */
export const SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_LIMIT_RESETS_V1 = "machine:runtime-account-usage:limit-resets-v1";
/**
 * Server capability (on `machine:context.capabilities`): the server's
 * runtime-usage snapshot schema reads `accounts[].windows[].scope` (OAR's
 * `AccountUsageWindow.scope`). A Computer includes that field only when the
 * server advertises this (`withoutWindowScopes` otherwise); an older server's
 * strict schema would refuse the whole snapshot.
 */
export const SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_WINDOW_SCOPE_V1 = "machine:runtime-account-usage:window-scope-v1";
/**
 * Server capability (on `machine:context.capabilities`): the server's
 * snapshot schema also reads a window scope of kind `models` (a group of
 * models sharing one quota, OAR 0.103's Antigravity "Gemini Models"). A
 * Computer talking to a server with only
 * SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_WINDOW_SCOPE_V1 sends such a window
 * without a scope (`withoutModelsScopes`): that server's strict schema would
 * refuse the whole snapshot.
 */
export const SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_WINDOW_SCOPE_V2 = "machine:runtime-account-usage:window-scope-v2";
/**
 * The daemon answers `machine:runtime_account_usage:limit_reset:redeem`
 * (spending one of an account's limit resets through OAR, Codex today) with
 * one `:result`. The server sends a redeem only to a Computer advertising it.
 */
export const DAEMON_CAPABILITY_RUNTIME_LIMIT_RESET = "machine:runtime-account-usage:limit-reset";
/**
 * The daemon answers Claude limit resets by kind: a redeem that names a
 * `kind` for provider `claude`, and
 * `machine:runtime_account_usage:limit_resets:read` (OAR 0.102
 * `redeemLimitReset` / `inspectLimitResets`). Advertised only on Linux, where
 * OAR drives Claude Code (a daemon before OAR 0.102 also required a tested
 * Claude Code version); elsewhere (macOS) the card offers nothing.
 */
export const DAEMON_CAPABILITY_RUNTIME_LIMIT_RESET_CLAUDE_KINDS = "runtime-limit-reset:claude-kinds";

/**
 * task #25 step 2: how a stop-this-turn request ended. `interrupted`: the
 * runtime's own interrupt ended the turn and the process kept running.
 * `restarted`: the runtime was restarted and resumes its session; only the
 * processes the turn started were killed. `not_running`: no turn was running.
 */
export const AGENT_TURN_INTERRUPT_OUTCOMES = ["interrupted", "restarted", "not_running"] as const;
export type AgentTurnInterruptOutcome = (typeof AGENT_TURN_INTERRUPT_OUTCOMES)[number];
export const isAgentTurnInterruptOutcome = makeIsMember(AGENT_TURN_INTERRUPT_OUTCOMES);

/**
 * #proj-runtime:#41: how a stop-this-sub-agent request ended. `interrupted`:
 * the runtime was asked to stop that sub-agent's turn. `not_running`: no
 * such sub-agent is running. `unsupported`: the agent's runtime cannot stop
 * one sub-agent (Codex and Claude Code can).
 */
export const AGENT_SUBAGENT_INTERRUPT_OUTCOMES = ["interrupted", "not_running", "unsupported"] as const;
export type AgentSubagentInterruptOutcome = (typeof AGENT_SUBAGENT_INTERRUPT_OUTCOMES)[number];
export const isAgentSubagentInterruptOutcome = makeIsMember(AGENT_SUBAGENT_INTERRUPT_OUTCOMES);
/** The longest sub-agent id a stop request may carry (`SubagentLineage.taskId`, a Codex thread id). */
export const SUBAGENT_TASK_ID_MAX_LENGTH = 160;

/**
 * RFC 071 §7: the daemon reports launch-bound runtime outcomes
 * (`agent:runtime:outcome` v1: E1 `terminal_failure`, E2 `turn_completed`)
 * and process identity (`agent:process_spawned`, `agent:process_exited`,
 * `processInstanceId` on a rebind `agent:start:ack`), and echoes
 * `catchupBatchId` from `agent:start`. Without it the terminal-failure
 * breaker never counts for this machine (RFC 7 "Old daemons").
 */
export const DAEMON_CAPABILITY_RUNTIME_OUTCOME_V1 = "agent:runtime-outcome-v1";
/**
 * RFC 060 (daemon capability, on `ready.capabilities`): the daemon can run an
 * agent's session through an OAR `Session` (its OAR host) next to its own
 * runtime drivers, and reads `AgentConfig.runtimeHost`. The server sets
 * `runtimeHost: "oar"` only for a daemon that advertised this; a daemon that
 * never did keeps its drivers. The daemon still decides per launch and runs a
 * launch the OAR host cannot run on its drivers.
 */
export const DAEMON_CAPABILITY_RUNTIME_HOST_OAR = "runtime-host:oar";
/**
 * #wg-ax:#3 (daemon capability, on `ready.capabilities`): this daemon's OAR
 * host is ready to run Codex. Earlier Computers advertise `runtime-host:oar`
 * and already carry an unfinished Codex launch, so the server asks them for
 * the OAR host for Codex only with this as well.
 */
export const DAEMON_CAPABILITY_RUNTIME_HOST_OAR_CODEX = "runtime-host:oar:codex";
/**
 * #oar-raft:#4 (daemon capability, on `ready.capabilities`): this daemon's OAR
 * host is ready to run Grok Build by default. Computers 1.0.56–1.0.67 already
 * advertise `runtime-host:oar` with a Grok launch but lack later fixes (effort
 * without a model, the host's own restart after an exit), so the server asks
 * them for the OAR host for Grok only with this as well.
 */
export const DAEMON_CAPABILITY_RUNTIME_HOST_OAR_GROK = "runtime-host:oar:grok";
/**
 * #oar-raft:#10 (daemon capability, on `ready.capabilities`): this daemon's
 * OAR host can run Cursor through the Cursor SDK (`@cursor/sdk`, in a Node
 * child per session). Advertised only on Linux, outside the single-file (SEA)
 * build, on Node 22.13 or newer, and where the SDK resolves. The server asks for the OAR host for
 * Cursor only with this and its `agent_runtime_oar_cursor` flag on.
 */
export const DAEMON_CAPABILITY_RUNTIME_HOST_OAR_CURSOR = "runtime-host:oar:cursor";
/**
 * #wg-rbac:#27 (daemon capability, on `ready.capabilities`): every `ready`
 * carries `runnerCredentialIds`, the runner credentials
 * (`AgentConfig.agentCredentialId`) the daemon holds when it builds the frame:
 * its live agent processes and sessions, and the starts it is running that
 * already carry one. An empty list means it holds none (a restarted daemon).
 * A credential minted after the frame was built is not in it. Without this
 * capability the field means nothing (`readyRunnerCredentialIds`).
 */
export const DAEMON_CAPABILITY_RUNNER_CREDENTIAL_RECONCILE_V1 = "runner-credential-reconcile:v1";

/**
 * #wg-rbac:#27 runner credential expiry: a daemon declaring this in `ready`
 * renews its runner credentials. Runner credentials its Computer mints then
 * expire (`expiresAt` in the mint response, 7 days out); the daemon renews
 * them through `POST /internal/computer/runners/:agentId/credentials/renew`
 * and treats a 401 `agent_credential_expired` as "renew, then retry once".
 * Without it, runner credentials never expire (as before).
 */
export const DAEMON_CAPABILITY_RUNNER_CREDENTIAL_RENEW_V1 = "runner-credential-renew:v1";

/**
 * Reconciler step 11 (daemon capability, on `ready.capabilities`): the daemon
 * takes `agent:config`, a new config for an agent it runs, without a restart
 * now. It keeps the config's last applied `revision` per agent (an
 * `agent:start` `configRevision` counts too) and drops a push at or below it;
 * a running session whose runtime spec drifted is stopped once idle, and the
 * next start runs on the new config. Its `ready` reports the applied revision
 * of each running agent (`runningAgentConfigRevisions`), so a push lost on the
 * way is sent again. Without it the server keeps restarting the agent for a
 * config change.
 */
export const DAEMON_CAPABILITY_AGENT_CONFIG_PUSH = "agent:config-push-v1";

/**
 * RFC 071 F9: an `agent:start` that carries both `config.runtimeProfileControl`
 * and `resumeMessages` (no wake message, no resume prompt) renders the resume
 * catch-up in that launch's first input, with the release notice. An older
 * daemon renders only the notice and drops the catch-up, so without this the
 * server does not count such a start as the one that carried the owed
 * catch-up (#1221): it stays owed for the next start.
 */
export const DAEMON_CAPABILITY_CONTROL_START_CATCHUP_V1 = "agent:control-start-catchup-v1";

/**
 * The runner credential ids a `ready` frame says the daemon holds, or null
 * when it makes no such claim: the capability is missing, or the field is
 * absent or not a list of non-empty strings. Null never means "holds none".
 * The frame is untrusted wire data (the server JSON-parses it), so this is
 * checked here, not trusted from the type. Ids are returned deduplicated.
 */
export function readyRunnerCredentialIds(
  ready: Pick<Extract<MachineToServerMessage, { type: "ready" }>, "capabilities" | "runnerCredentialIds">,
): string[] | null {
  if (!Array.isArray(ready.capabilities) || !ready.capabilities.includes(DAEMON_CAPABILITY_RUNNER_CREDENTIAL_RECONCILE_V1)) return null;
  const ids: unknown = ready.runnerCredentialIds;
  if (!Array.isArray(ids)) return null;
  const distinct = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0) return null;
    distinct.add(id);
  }
  return [...distinct];
}
/**
 * RFC 071 outbox (server capability, on `machine:context.capabilities`): the
 * server acknowledges every outbox frame with `agent:outcome:ack`. A daemon
 * sends outbox frames only to a server that advertises this; otherwise it
 * pauses and keeps its queue.
 */
export const SERVER_CAPABILITY_RUNTIME_OUTCOME_ACK_V1 = "agent:runtime-outcome-ack-v1";
/**
 * task #365 (server capability, on `machine:context.capabilities`): the server
 * counts a start the daemon proved never created a process (`not_spawned`
 * reason `spawn_error`) in its own bounded backoff, and stamps automatic
 * `agent:start` frames with the claim-time `connectionEpochId`. Without it the
 * daemon keeps today's behaviour (the failed spawn is reported as a crash, so
 * the #1119 crash-loop breaker still protects an older server).
 */
export const SERVER_CAPABILITY_START_SPAWN_ERROR_V1 = "agent:start-spawn-error-v1";
/**
 * task #1268 (server capability, on `machine:context.capabilities` AND on the
 * daemon WebSocket 101 response header `RAFT_SERVER_CAPABILITIES_HEADER`): the
 * server understands `ready.runtimeDetection`. Only then may a daemon send a
 * `pending` ready (no inventory fields) and finish detection afterwards; without
 * it the daemon keeps today's synchronous detection before `ready`.
 */
export const SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1 = "machine:runtime-detection-async-v1";
/**
 * Server capability (on `machine:context.capabilities`): the server answers
 * `server:features:request` with `server:features`, the flag-derived
 * `AgentConfig` fields of the connection's Server (`./featuresChanged`).
 * Without it the daemon never sends a request and keeps what each agent's
 * `agent:start` carried.
 */
export const SERVER_CAPABILITY_SERVER_FEATURES_V1 = "server:features-v1";
/**
 * Reconciler step 12 (server capability, on `machine:context.capabilities`):
 * the server counts the start-failure reasons `model_unsupported` and
 * `runtime_repeated_failure`, which a runtime reports only after it started
 * (so the start's readiness already reset the server's failed-start count):
 * each pauses automatic wakes at its first report. An older server drops a
 * reason it does not know, so the daemon reports `runtime_spawn_failed`
 * instead without it.
 */
export const SERVER_CAPABILITY_STICKY_FAILURE_REASONS_V1 = "agent:sticky-failure-reasons-v1";
/**
 * Server capability (on `machine:context.capabilities`): the server accepts
 * `transferSummary.excludedIgnoredBySource` (shared agentMigration.ts) in a
 * migration control manifest. A Computer includes that field only when the
 * Server advertises this; an older Server's strict summary schema would reject
 * the manifest.
 */
export const SERVER_CAPABILITY_MIGRATION_BACKUP_IGNORE_SOURCES_V1 = "migration:backup-ignore-sources-v1";
/**
 * Server capability (on `machine:context.capabilities`): the server accepts
 * `userIgnoreAdditions` (the receipt, ./agentMigrationUserIgnore) in a migration
 * source-progress report. A Computer includes it only when the Server
 * advertises this; an older Server's strict report schema would reject it.
 */
export const SERVER_CAPABILITY_MIGRATION_USER_IGNORE_RECEIPT_V1 = "migration:user-ignore-receipt-v1";
/**
 * Server capability (on `machine:context.capabilities`): the server accepts a
 * `{ phase: "draining", drainUntil, waitingFor? }` source-progress report
 * (agentMigrationSourceDrainProgressReportSchema) while the migration source
 * waits for its agent before quiesce, and shows it to the owner. A Computer
 * sends it only when the Server advertises this; an older Server's strict
 * build-progress schema would reject it.
 */
export const SERVER_CAPABILITY_MIGRATION_SOURCE_DRAIN_PROGRESS_V1 = "migration:source-drain-progress-v1";
/**
 * task #1268: HTTP response header on the daemon WebSocket upgrade (101) carrying
 * the server's machine-context capabilities, space-separated. The daemon reads it
 * before its first `ready` (the `machine:context` frame arrives after `open`);
 * `machine:context.capabilities` stays authoritative and corrects a mismatch.
 */
export const RAFT_SERVER_CAPABILITIES_HEADER = "raft-server-capabilities";
/**
 * task #1268: runtime detection state carried on `ready`. `pending` = detection
 * runs after this ready and the message carries NO inventory fields; `complete`
 * = `runtimes`/`runtimeVersions` are this round's full result; `incomplete` =
 * the round ended early (deadline, child failure, cancel) and
 * `unfinishedRuntimes` were not probed — their previous state is unconfirmed,
 * not unavailable. Absent on older daemons = `complete` (synchronous detection).
 */
export type RuntimeDetectionReport =
  | { status: "pending" }
  | { status: "complete"; durationMs: number }
  | { status: "incomplete"; reason: "deadline" | "child_failed" | "cancelled"; unfinishedRuntimes: string[]; durationMs: number };
export const COMPUTER_CAPABILITY_SUPERVISOR_MUTATIONS = "computer:supervisor-mutations-v1";
/**
 * A negative fact, sent only when this runner could not reach its Computer
 * service over the local IPC seam at start (a runner the service did not
 * launch, a service from another install root). Web upgrades go through that
 * seam, so the server offers this Computer the manual commands instead of the
 * Upgrade button (policy reason `service_unreachable`). Older Computers never
 * send it: absent means reachable or unknown, as before.
 */
export const COMPUTER_CAPABILITY_SERVICE_IPC_UNREACHABLE = "computer:service-ipc-unreachable-v1";

/**
 * Summary of the most recent external-installer upgrade receipt on a machine,
 * read once by the successor process and carried on `ready`. Only the
 * failure reason is consumed (one human-readable line); the outcome is the
 * version comparison the Server performs itself.
 */
export interface ComputerLastUpgradeReceipt {
  targetVersion: string;
  outcome: "promoted" | "rolled_back" | "failed" | "held" | "unresolved";
  reason?: string;
}

/**
 * Advisory on a failed web upgrade request (`upgradeRequest.failureHint` in
 * the machine list and `machine:upgrade-request`): the failure is one only a
 * run of the install command on the machine gets past, recognized by the
 * server in the reason the Computer gave (Computers up to today send only
 * text, no code). Never changes whether Upgrade is offered.
 *   unsafe_kill_mode — the service's systemd unit has a KillMode under which
 *     the installer would be killed with the service, so the Computer refused.
 *   installation_held — the installer could not move out of that unit, so it
 *     held the upgrade before stopping anything.
 * `unit` / `killMode` / `scope` only when the reason names them.
 */
export interface ComputerUpgradeFailureHint {
  reason: "unsafe_kill_mode" | "installation_held";
  unit?: string;
  killMode?: string;
  scope?: "user" | "system";
}
export const COMPUTER_LIFECYCLE_ACTIONS = ["start", "stop", "restart", "upgrade"] as const;
export type ComputerLifecycleAction = (typeof COMPUTER_LIFECYCLE_ACTIONS)[number];
export const COMPUTER_LIFECYCLE_TERMINALS = [
  "completed",
  "failed",
  "unconfirmed",
  "superseded",
  "rolled_back",
] as const;
export type ComputerLifecycleTerminal = (typeof COMPUTER_LIFECYCLE_TERMINALS)[number];
export interface ComputerLifecycleExecutionAck {
  /** Canonical identifier. Optional only during the requestId compatibility window. */
  operationId?: string;
  /** Legacy alias; when both are present they must identify the same operation. */
  requestId?: string;
  action: ComputerLifecycleAction;
  phase: "shutdown" | "ready";
  loadedComputerVersion?: string;
  /** Present only on a machine-wide D=Upgrade ready acknowledgement. */
  serviceGeneration?: string;
  managedSetRevision?: string;
  oldProcessIdentitiesDead?: boolean;
  deadProcessIdentities?: string[];
}

export type MentionDeliveryIdentitySnapshot = {
  occurrenceId: string;
  messageId: string;
  machineId: string;
  launchId: string;
  sessionId: string;
};

export type MentionDeliveryTransitionStage =
  | "daemon_received"
  | "daemon_pending"
  | "daemon_drained";

// Single authoritative definition of the terminal error codes on the
// mention-delivery wire (daemon → server `agent:delivery:terminal_error`) and
// in server persistence. task #154: this union previously existed in THREE
// places (here, packages/server/src/services/mentionDeliveryOccurrenceService.ts
// with an extra REDELIVERY_EXHAUSTED, and an inline copy in
// packages/daemon/src/core.ts) and the copies silently diverged — a reader of
// any one copy undercounted the codes. Everything now derives from this array;
// adding a member here propagates to every consumer at compile time.
export const MENTION_DELIVERY_TERMINAL_ERROR_CODES = [
  "IDENTITY_UNKNOWN",
  "IDENTITY_DRIFT",
  "QUOTA_LIMITED",
  "DELIVERY_REJECTED",
  "UNSUPPORTED_DELIVERY_PATH",
  "INSTRUMENT_FAILED",
  "REDELIVERY_EXHAUSTED",
] as const;

export type MentionDeliveryTerminalErrorCode = typeof MENTION_DELIVERY_TERMINAL_ERROR_CODES[number];

/** Bounded provenance of the winning terminal decision; absent on legacy rows.
 * The daemon code is the code actually received, not inferred from the final code.
 * No message bodies, runtime identities, or arbitrary diagnostic attributes.
 */
export type MentionDeliveryTerminalDecision = {
  layer: "daemon" | "server";
  stage: "terminal_receipt" | "stage_receipt" | "ack_receipt" | "recovery"
    | "retry" | "redrive" | "instrumentation_fallback" | "recovery_exhausted";
  originalDaemonCode: MentionDeliveryTerminalErrorCode | null;
};


/** RFC 071 §7: which terminal path ended the launch. */
export const AGENT_RUNTIME_TERMINAL_FAILURE_KINDS = [
  "compaction_failed",
  "compaction_input_too_large",
  "compaction_recovery_exhausted",
  "sticky_runtime_error",
  "fingerprint_fence",
  "billing_rejected",
] as const;
export type AgentRuntimeTerminalFailureKind = (typeof AGENT_RUNTIME_TERMINAL_FAILURE_KINDS)[number];

/** RFC 071 outbox: what a gap / cross-instance marker folded. */
export interface AgentRuntimeOutcomeGapCounts {
  e1: number;
  turnCompleted: number;
  spawned: number;
  exited: number;
  startOutcome: number;
}

/** RFC 071 §7: the `outcome` of an `agent:runtime:outcome` v1 frame. */
export type AgentRuntimeOutcome =
  | {
      kind: "terminal_failure";
      failureKind: AgentRuntimeTerminalFailureKind;
      /** 16 hex, from the RAW SDK/runtime text (never the display constant). */
      fingerprint: string;
      errorClass: RuntimeErrorClass;
    }
  | {
      kind: "turn_completed";
      textEvents: number;
      toolCalls: number;
      /** Only on the turn whose input rendered that batch, and only once per batch (RFC 071 §6). */
      catchupBatchId?: string;
      /**
       * With `catchupBatchId`: how many batch rows were rendered into that
       * turn's input. Always >= 1: a batch with zero rendered rows is never
       * echoed, so a cursor-only coverage (no rows) is the server's to settle
       * from read cursors, never from an echo.
       */
      catchupRenderedRows?: number;
    };

/**
 * Why no process was created for a launch the daemon accepted (RFC 071
 * `agent:start:outcome`). Sent only when the daemon KNOWS no process exists
 * for the launch; never for timeouts, disconnects or unknown results.
 *  - `start_rejected`: refused before the start reached the process manager
 *    (validation, credential, retired start type);
 *  - `spawn_failed`: the start failed before any runtime process existed;
 *  - `cancelled`: stopped or cancelled before any runtime process existed;
 *  - `deferred`: the runtime defers its spawn until a concrete message; a later
 *    spawn for the same launch reports `agent:process_spawned` with `respawn`;
 *  - `admission_full`: refused before acceptance because the agent already has
 *    the maximum number of launches still waiting for a final result.
 */
export const AGENT_START_NOT_SPAWNED_REASONS = [
  "start_rejected",
  "spawn_failed",
  "cancelled",
  "deferred",
  "admission_full",
  /** The daemon refused an automatic start locally: its outcome evidence has an un-acked gap, or is unreliable. */
  "terminal_failure_needs_manual",
  /** The daemon refused a start (human or automatic): its outcome outbox cannot reserve room for this launch until acks drain. */
  "terminal_failure_outcome_storage_blocked",
  /**
   * task #365: proven never created: the child has no pid and the spawn
   * syscall itself failed (EACCES, ENOENT, ...). Sent only to a server with
   * `SERVER_CAPABILITY_START_SPAWN_ERROR_V1`, which counts it in its own
   * bounded backoff. Says nothing about whether the cause is temporary.
   */
  "spawn_error",
  /** task #365: an automatic start claimed against an earlier connection (`connectionEpochId`); refused, never counted. */
  "stale_dispatch",
] as const;
export type AgentStartNotSpawnedReason = (typeof AGENT_START_NOT_SPAWNED_REASONS)[number];

export type AgentWakeRefusedReason =
  | "manual_stop"
  | "wake_lock_held"
  /** The Computer is below the server's version floor past its deadline; it runs no agents until upgraded. Older daemons log it as an unknown reason. */
  | "computer_version_unsupported"
  /**
   * Reconciler step 15 (B15): the Computer's access was revoked. In practice
   * never sent (a connected Computer is not revoked); listed so the type
   * matches the server's start refusals. Older daemons log it as unknown.
   */
  | "computer_access_revoked"
  /** task #1119: automatic wakes are paused after consecutive early exits; a human start lifts it. */
  | "wake_crash_loop_blocked"
  /**
   * RFC 071: the terminal-failure breaker is open and its backoff has not
   * passed; the next wake after it (or a manual start) retries.
   */
  | "terminal_failure_paused"
  /** RFC 071: one probe launch is already running under a lease. */
  | "terminal_failure_probe_in_flight"
  /**
   * RFC 071: an earlier process could not be confirmed stopped, or this
   * machine cannot report outcomes after protection; only a manual start
   * proceeds.
   */
  | "terminal_failure_needs_manual"
  /** RFC 071 outbox: the daemon's outcome storage is blocked until acknowledgements drain. */
  | "terminal_failure_outcome_storage_blocked"
  | "agent_not_found"
  | "machine_mismatch"
  | "server_error";

/** Why the server sent an `agent:stop` (its `reason`); absent reads as `lifecycle`. */
export type AgentStopReason = "owner_stop" | "deleted" | "migrated" | "lifecycle";

export type ServerToMachineMessage =
  /**
   * Authenticated websocket ownership context. The Server sends this as the
   * first frame after accepting a machine connection so the daemon can bind
   * Computer-local App state to a logical Server identity before use.
   */
  | { type: "machine:context"; machineId: string; serverId: string; /** Additive: server capabilities, e.g. `SERVER_CAPABILITY_RUNTIME_OUTCOME_ACK_V1`. */ capabilities?: string[]; /** Additive (task #365): the server's id for this connection; an automatic `agent:start` carrying another one is stale. */ connectionEpochId?: string; /** Additive: the trace-upload receiver this server wants its machines to use. The daemon accepts it only from a built-in allowlist (daemon traceUploadUrl.ts); older daemons ignore it, older servers omit it. */ traceUploadUrl?: string; /** Additive: the server runs with RAFT_PRIVACY_MODE on, so the daemon sends nothing to Raft's own services either (no trace or feedback uploads). Sent only when on; older daemons ignore it. */ privacyMode?: boolean }
  /**
   * Same-machine grouping: asks the daemon for its per-server host hash. Sent
   * after registration only while `computer_host_identity_v0` is on for the
   * server; older daemons ignore it.
   */
  | { type: "machine:host_identity:request" }
  /**
   * RFC 071 outbox: the server applied (or deliberately ignored) one outbox
   * entry. A normal entry is named by `(daemonInstanceId, clientSeq)`; a gap
   * or cross-instance marker by its `gapId`. The daemon deletes only the
   * exactly matching entry.
   */
  | { type: "agent:outcome:ack"; agentId: string; daemonInstanceId?: string; clientSeq?: number; gapId?: string }
  /**
   * `catchupBatchId` (RFC 071 §6/§7, optional): identifies the resume
   * catch-up batch carried in `resumeMessages`. A daemon with
   * `DAEMON_CAPABILITY_RUNTIME_OUTCOME_V1` echoes it once, on the
   * `turn_completed` outcome of the turn whose input rendered that batch.
   * Old daemons ignore it; then nothing is echoed and nothing is fulfilled.
   *
   * RFC 071 outbox (all optional, additive):
   *  - `breakerGeneration`: the breaker generation at claim; every outbox
   *    frame of this launch echoes it as `generation`.
   *  - `takeoverEpoch`: bumped by the server on each human takeover; a new
   *    value seals the daemon's open gap markers of the older epoch.
   *  - `humanStart`: an explicit human start (RFC 071 §5 E3). The daemon's
   *    local refusal of automatic starts does not apply to it.
   */
  | { type: "agent:start"; agentId: string; config: AgentConfig; wakeMessage?: AgentMessage; wakeMessageTransient?: boolean; resumeMessages?: AgentMessage[]; unreadSummary?: Record<string, number>; resumePrompt?: string; launchId?: string; startDispatchId?: string; traceparent?: string; catchupBatchId?: string; breakerGeneration?: number; takeoverEpoch?: number; humanStart?: boolean; /** Additive (task #365): the connection the server claimed this automatic start against; the daemon refuses it on any other connection. */ connectionEpochId?: string; /** Additive (reconciler step 11): the server's revision of `config`; an `agent:config` at or below it is stale. Absent on older servers. */ configRevision?: number }
  /**
   * Reconciler step 11 (`DAEMON_CAPABILITY_AGENT_CONFIG_PUSH`): the agent's
   * current config, for a daemon that runs or starts it. `revision` grows
   * with every config the server sends for the agent (pushes and starts); the
   * daemon drops one at or below the last it applied. Never wakes the agent:
   * a running session whose runtime spec drifted is stopped once idle, and
   * the next start runs on the new config. Older daemons ignore it.
   */
  | { type: "agent:config"; agentId: string; config: AgentConfig; revision: number }
  /**
   * `reason` (additive; older daemons ignore it) says why the server stops
   * the agent, so the daemon can decide what else goes with it (e.g. the
   * agent's `raft proc` jobs):
   *  - `owner_stop`: a person's explicit Stop of the agent;
   *  - `deleted`: the stop before the agent is deleted;
   *  - `migrated`: the agent is moving to another Computer;
   *  - `lifecycle` or absent: any other stop (lifecycle, enforcement,
   *    reset, internal). Read absent as `lifecycle`.
   */
  | { type: "agent:stop"; agentId: string; reason?: AgentStopReason }
  /** task #25 step 2: stop the agent's current turn, not the agent (DAEMON_CAPABILITY_INTERRUPT_TURN). */
  | { type: "agent:interrupt-turn"; agentId: string; requestId: string }
  /** #proj-runtime:#41: stop one running sub-agent, by its `SubagentLineage.taskId` (DAEMON_CAPABILITY_INTERRUPT_SUBAGENT). */
  | { type: "agent:interrupt-subagent"; agentId: string; requestId: string; subagentTaskId: string }
  /**
   * Answer to a daemon `agent:wake:request` (task #1103). `dispatched` means
   * the Server issued its ordinary `agent:start` for this agent; `refused` is
   * terminal for this request and carries why, so the daemon can surface it
   * instead of retrying locally.
   */
  | { type: "agent:wake:outcome"; agentId: string; wakeRequestId: string; outcome: "dispatched" | "refused"; reason?: AgentWakeRefusedReason }
  // Remote control of a managed Computer (web → server → machine WS → the
  // Computer's own service IPC). `computer:restart` → restart-service;
  // `computer:upgrade` → upgrade-start (§12 self-update). Additive: raw
  // daemons (and Computers running older bundles) ignore unknown types via
  // the daemon's unmatched-switch fallthrough, so this is backward-safe.
  | { type: "computer:restart"; operationId?: string; requestId?: string }
  // v2 (task #873): the Server resolves the exact target; the Computer runs
  // the external installer against it and reports nothing until it is back.
  // Reconciler step 13: `drain` (only to a daemon advertising
  // DAEMON_CAPABILITY_COMPUTER_UPGRADE_DRAIN_V1) waits for the agents to
  // finish their current work before the installer runs; see ./computerUpgradeDrain.
  | { type: "computer:upgrade"; operationId?: string; requestId?: string; targetVersion?: string; drain?: import("./computerUpgradeDrain").ComputerUpgradeDrainRequest }
  | { type: "computer:lifecycle:receipt"; operationId: string; phase: "shutdown" | "ready" }
  | { type: "agent:reset-workspace"; agentId: string }
  | { type: "agent:deliver"; agentId: string; message: AgentMessage; seq: number; traceparent?: string; deliveryId?: string; transient?: boolean; mentionDelivery?: MentionDeliveryIdentitySnapshot }
  | { type: "agent:inbox:purge"; agentId: string; channelIds: string[]; reason?: string }
  | { type: "agent:workspace:list"; agentId: string; dirPath?: string; includeHidden?: boolean }
  | { type: "agent:workspace:read"; agentId: string; path: string; requestId: string }
  | { type: "agent:skills:list"; agentId: string; runtime?: string; requestId?: string }
  | { type: "agent:diagnostic:session_transcript"; agentId: string; requestId: string }
  /**
   * `includeMachineLogTail` (task #272 tier 2): the machine OWNER opted in to
   * attach the redacted runner log tail for this one report. The server sets
   * it only after checking the reporter owns the machine; older daemons ignore
   * the field and upload the transcript exactly as before.
   */
  | {
      type: "agent:diagnostic:feedback_transcript"; agentId: string; feedbackReportId: string; requestId: string; feedbackReportGeneratedAt?: string; feedbackReportTimeSource?: FeedbackTranscriptReportTimeSource; includeMachineLogTail?: boolean;
      /** Additive; older daemons ignore it. See FeedbackTranscriptSessionLookup. */
      sessionLookup?: FeedbackTranscriptSessionLookup;
    }
  /**
   * Ask the daemon to re-emit current activity ground-truth for an agent.
   * Replaces the server-side "synthesize online when transient state is
   * stale" behaviour so the server stops inventing state.
   *
   * Daemon responds via the existing `agent:activity` upstream channel
   * with `probeId` echoed back so the server can correlate. Old daemons
   * that don't recognize this type fall through their unknown-type
   * switch silently (server-side fallback timer kicks in after 5s →
   * synth `online` like today).
   *
   * Introduced 2026-05-02 #engineering:72283cf7 task #340 (#1).
   */
  | { type: "agent:activity_probe"; agentId: string; probeId: string; purpose: "sweep" | "manual" }
  | { type: "machine:workspace:scan" }
  | { type: "machine:workspace:delete"; directoryName: string }
  /**
   * `force`: bypass the daemon's model-list cache (a form's refresh action).
   * Optional and additive: daemons without a cache ignore it, as they detect
   * on every request anyway.
   */
  | { type: "machine:runtime_models:detect"; requestId: string; runtime: string; force?: boolean }
  /**
   * Ask the owning Computer to run one bounded provider probe for an opaque
   * probe intent. Carries no credential, endpoint or connection id: the daemon
   * resolves the one-time materialization itself with machine auth. Older
   * daemons ignore the additive message, which the Server detects through the
   * missing `provider-probe:v1` capability before dispatch.
   */
  | {
      type: "machine:provider_probe:request";
      requestId: string;
      probeId: string;
      runtime: string;
      model: string;
    }
  /**
   * Ask the owning Computer to refresh one provider's sanitized account-usage
   * snapshot. This is never sent by a cache-read endpoint without the
   * owner/gate/cooldown checks. Older daemons ignore the additive message.
   */
  | {
      type: "machine:runtime_account_usage:refresh";
      requestId: string;
      provider: RuntimeAccountUsageProvider;
      reason: "manual" | "stale_or_missing" | "scheduled";
    }
  /**
   * DAEMON_CAPABILITY_RUNTIME_LIMIT_RESET: spend one of the provider
   * account's limit resets on this Computer (OAR `redeemLimitReset`, with the
   * idempotency key as given), then read its usage again. Answered by
   * `:limit_reset:result`. Sent only for a person who may act on the
   * Computer's runtimes; never from an agent route.
   */
  | {
      type: "machine:runtime_account_usage:limit_reset:redeem";
      requestId: string;
      provider: RuntimeAccountUsageProvider;
      idempotencyKey: RuntimeLimitResetIdempotencyKey;
      /**
       * DAEMON_CAPABILITY_RUNTIME_LIMIT_RESET_CLAUDE_KINDS: the one kind the
       * person clicked, for provider `claude`. A Claude redeem without it is
       * answered `unsupported`: the Computer never picks a kind.
       */
      kind?: RuntimeLimitResetKind;
    }
  /**
   * DAEMON_CAPABILITY_RUNTIME_LIMIT_RESET_CLAUDE_KINDS: read which limit
   * resets the provider account holds, by opening Claude Code's own command
   * for each kind and cancelling it. Answered by `:limit_resets:read:result`.
   * Sent only on a person's click, never from a poll: on an account that has
   * only Claude's older once-a-week reset, opening the command at the 5-hour
   * limit spends that reset with no confirmation. So `atFiveHourLimit` says
   * what usage shows (anything but `false` counts as at the limit), and the
   * Computer refuses unless `atFiveHourLimitConsent` says the person accepted
   * that. `includeFiveHour` (default false) also opens the 5-hour kind.
   */
  | {
      type: "machine:runtime_account_usage:limit_resets:read";
      requestId: string;
      provider: RuntimeAccountUsageProvider;
      atFiveHourLimit: boolean;
      atFiveHourLimitConsent?: boolean;
      includeFiveHour?: boolean;
    }
  /**
   * task #17 (DAEMON_CAPABILITY_RUNTIME_AUTH): start a web login for a runtime
   * on this Computer. The daemon runs OAR's login and answers with
   * `machine:runtime_auth:login:event`s and one `:result`. A runtime outside
   * `RUNTIME_AUTH_V1_RUNTIMES` is sent (here and in `:logout`) only to a
   * Computer with DAEMON_CAPABILITY_RUNTIME_AUTH_V2: an older daemon drops it.
   * `region`: the region the person chose, for a runtime whose login asks for
   * one (Kimi Code) and only for it (`runtimeAuthLoginRegionFits`).
   * `providerId`: the model provider to sign in, for a runtime that signs in
   * per provider (Pi, DAEMON_CAPABILITY_RUNTIME_AUTH_PI; OpenCode,
   * DAEMON_CAPABILITY_RUNTIME_AUTH_OPENCODE) and only for it
   * (`runtimeAuthProviderIdFits`). `oauthMethod`: the label of the OAuth
   * sign-in the person chose, for a runtime whose providers offer several
   * (OpenCode) and only for it (`runtimeAuthOAuthMethodFits`).
   */
  | { type: "machine:runtime_auth:login:start"; loginId: RuntimeAuthLoginId; runtime: RuntimeAuthRuntime; region?: RuntimeAuthLoginRegion; providerId?: string; oauthMethod?: string }
  /**
   * The one-time code the person pasted from the runtime's sign-in page
   * (Claude). Written to that login's prompt only; never logged or traced on
   * either side.
   */
  | { type: "machine:runtime_auth:login:code"; loginId: RuntimeAuthLoginId; code: string }
  | { type: "machine:runtime_auth:login:cancel"; loginId: RuntimeAuthLoginId }
  /** `providerId`: the provider to sign out, for a per-provider runtime (Pi) only. */
  | { type: "machine:runtime_auth:logout"; requestId: string; runtime: RuntimeAuthRuntime; providerId?: string }
  /**
   * DAEMON_CAPABILITY_RUNTIME_AUTH_QWEN_PROVIDER: the model providers a
   * runtime with `connect_provider` (Qwen Code) offers on this Computer, for
   * the person to choose one. Answered by `:providers:result`.
   */
  | { type: "machine:runtime_auth:providers"; requestId: string; runtime: RuntimeAuthRuntime }
  /**
   * Saves a provider's API key in that runtime's own settings on this
   * Computer (Qwen: user scope). `apiKey` is the secret: the server sends it
   * once, over this Computer's own socket (sealed between replicas), and
   * never stores, logs or traces it; the daemon hands it to OAR only and
   * never logs or traces it either. Answered by `:connect_provider:result`.
   */
  | {
      type: "machine:runtime_auth:connect_provider";
      requestId: string;
      runtime: RuntimeAuthRuntime;
      providerId: string;
      apiKey: string;
      baseUrl?: string;
      modelIds?: string[];
    }
  // Ask the computer to re-detect which runtimes are installed. The daemon answers
  // by re-emitting its ready/capabilities report, so there is no separate result
  // message — the existing capabilities push IS the response. Older daemons simply
  // ignore this, so callers must not block on it.
  | { type: "machine:runtimes:rescan" }
  | {
      type: "machine:migration:source_workspace_archive";
      requestId: string;
      migrationId: string;
      agentId: string;
      /**
       * Creation time of the migration being cleaned up (added; optional). A
       * daemon refuses to archive a workspace committed by a later migration.
       */
      migrationCreatedAt?: string;
    }
  | {
      type: "machine:migration_transport:lease";
      agentId: string;
      migrationId: string;
      migrationRef: string;
      migrationGeneration: string;
      sessionId: string;
      role: "source" | "target";
      provider: "object_store";
      transferKind: "upload" | "download";
      leaseSource: "server";
      bearerToken: string;
      expiresAt: string;
      maxBytes: number;
      controlUrl: string;
      leaseId: string;
      transportGeneration: string;
      sourceMachineId: string;
      targetMachineId: string;
      expectedMigrationRevision: number;
      sourceQuiesceReceipt?: import("./agentMigrationResumable").AgentMigrationSourceQuiesceReceipt;
      /**
       * Source lease only: the target Computer accepts `excludedIgnoredBySource` in the
       * transfer summary (it validates the control manifest with the same strict schema).
       * Absent or false: the source sends the summary without it.
       */
      targetAcceptsIgnoreSources?: boolean;
      /**
       * Source lease only (Computer 1.0.63+, AGENT_MIGRATION_SOURCE_USER_IGNORE_CAPABILITY):
       * paths the user picked to leave behind. Read it with
       * readAgentMigrationUserIgnoreAdditions; a malformed value fails the migration.
       */
      userIgnoreAdditions?: import("./agentMigrationUserIgnore").AgentMigrationUserIgnoreAdditions;
      /**
       * Source lease only (AGENT_MIGRATION_SOURCE_DRAIN_CAPABILITY, reconciler
       * step 14 Q-H): the source may wait until this time (ISO) for the agent to
       * be quiet before it stops it, holding new deliveries for it meanwhile;
       * the daemon waits at most AGENT_MIGRATION_SOURCE_DRAIN_MAX_MS. Absent:
       * stop at once (as before).
       */
      sourceDrainUntil?: string;
    }
  | { type: "agent:runtime_profile:migration"; agentId: string; migrationKey: string; message: string; launchId?: string; traceparent?: string }
  | {
      type: "machine:migration:cancel";
      agentId: string;
      migrationId: string;
      migrationRef: string;
      transportGeneration: string;
      cancelGeneration: string;
      migrationRevision: number;
      sessionId: string | null;
      role: "source" | "target";
      disposition: "pre_flip_source_authoritative" | "post_flip_target_authoritative";
      stopAgent: boolean;
    }
  | { type: "agent:runtime_profile:daemon_release_notice"; agentId: string; noticeKey: string; message: string; launchId?: string; traceparent?: string }
  | { type: "reminder.upsert"; agentId: string; reminder: ReminderJob }
  /**
   * Disarms the reminder's timer on the Computer. `canceled`: the reminder
   * itself was canceled, so the Computer also drops its un-acked local items
   * of it (RFC 081 D21). Absent: only disarmed (a one-time reminder's last
   * fire, a reminder moved to the Reminder App), the items stay.
   */
  | { type: "reminder.cancel"; agentId: string; reminderId: string; version: number; canceled?: true }
  | { type: "reminder.snapshot"; agentId: string; reminders: ReminderJob[] }
  | ComputerBoundDueReceiptMessage
  /**
   * Server→Computer app config transport (task #204). Typed envelope only —
   * no notification/timer/measure payload. Additive for older daemons.
   */
  | {
      type: "app_config.upsert";
      agentId: string;
      config: import("./appConfigTransport").AppConfigWireSnapshot;
    }
  | {
      type: "app_config.snapshot";
      agentId: string;
      configs: import("./appConfigTransport").AppConfigWireSnapshot[];
    }
  /** A flag affecting this Server may have changed: see `./featuresChanged`. Additive. */
  | import("./featuresChanged").ServerFeaturesChangedMachineMessage
  /** The answer to `server:features:request`: see `./featuresChanged`. Additive. */
  | import("./featuresChanged").ServerFeaturesMessage
  /** View Context: restore one message's model context; answered by a result POST, not a frame. See `./agentContextView`. Additive. */
  | import("./agentContextView").AgentContextViewRequestMessage
  /** Agents searching a context: answered by a result POST like a view. See `./agentContextEntries`. Additive. */
  | import("./agentContextEntries").AgentContextSearchRequestMessage
  | { type: "ping" };

export type AgentMigrationTransportLeaseMessage = Extract<ServerToMachineMessage, { type: "machine:migration_transport:lease" }>;

/**
 * Scrubbed, classified runtime-error facts that are safe to cross the daemon
 * protocol boundary. Keep every vocabulary closed: upstream exception names,
 * messages, paths, payloads, and arbitrary diagnostic fields do not belong on
 * this carrier.
 */
export const RUNTIME_ERROR_CLASSES = [
  "RuntimeError",
  "InputTooLargeError",
  "RateLimitError",
  "AuthError",
  "LauncherError",
  "NotFoundError",
  "ModelConfigError",
  "TimeoutError",
  "ProviderConnectionError",
  "ProviderStreamError",
  "ProviderServerError",
  "ProviderApiError",
  "OperationAbortedError",
  /** task #1127 — the model produced tool-call arguments the runtime could not deserialize. */
  "ToolArgumentParseError",
  /** task #1346: Claude rejects skip-permissions under root/sudo. */
  "RootPrivilegesError",
  /** task #917 — the provider's billing or credit balance is exhausted (HTTP 402). Retrying cannot succeed. */
  "BillingError",
  /**
   * One input is longer than the runtime takes at once, refused before it
   * was sent (OAR's `input_too_large` on a rejected prompt: Antigravity's
   * 185,000-byte bound). The message, not the session: shorten or split it.
   */
  "MessageTooLargeError",
] as const;
export type RuntimeErrorClass = (typeof RUNTIME_ERROR_CLASSES)[number];

export const RUNTIME_ERROR_REASONS = [
  "unclassified_runtime_error",
  "input_too_large",
  "rate_limited",
  "auth_failed",
  "launcher_error",
  "not_found",
  "model_config_error",
  "provider_timeout",
  "provider_connection_error",
  "provider_stream_error",
  "provider_server_error",
  "provider_api_error",
  "operation_aborted",
  /** task #1127 — pairs with ToolArgumentParseError. */
  "model_tool_args_invalid",
  "root_privileges",
  /** task #917 — pairs with BillingError. */
  "billing_exhausted",
  /** Pairs with MessageTooLargeError. */
  "message_too_large",
] as const;
export type RuntimeErrorReason = (typeof RUNTIME_ERROR_REASONS)[number];

export const RUNTIME_ERROR_REASON_PROVENANCES = [
  "runtime_error_event",
  "codex_native_reason",
  "daemon_fallback",
  /**
   * task #1127 — the reason was recovered from a pinned upstream stderr
   * sentence because no structured event carries the fact. Distinct from
   * `daemon_fallback`, which means the daemon guessed from whatever text it had:
   * this one names a specific, tested signature, so the share of typed errors
   * resting on text remains countable rather than hidden in the fallback bucket.
   */
  "codex_stderr_signature",
] as const;
export type RuntimeErrorReasonProvenance = (typeof RUNTIME_ERROR_REASON_PROVENANCES)[number];

/**
 * The one canonical class → reason pairing. The server rejects any carrier whose
 * reason disagrees with this, so keeping a second copy on the daemon side would
 * turn a compile error into a silently dropped carrier.
 */
export function runtimeErrorReasonForClass(errorClass: RuntimeErrorClass): RuntimeErrorReason {
  switch (errorClass) {
    case "InputTooLargeError": return "input_too_large";
    case "RateLimitError": return "rate_limited";
    case "AuthError": return "auth_failed";
    case "LauncherError": return "launcher_error";
    case "NotFoundError": return "not_found";
    case "ModelConfigError": return "model_config_error";
    case "TimeoutError": return "provider_timeout";
    case "ProviderConnectionError": return "provider_connection_error";
    case "ProviderStreamError": return "provider_stream_error";
    case "ProviderServerError": return "provider_server_error";
    case "ProviderApiError": return "provider_api_error";
    case "OperationAbortedError": return "operation_aborted";
    case "ToolArgumentParseError": return "model_tool_args_invalid";
    case "RootPrivilegesError": return "root_privileges";
    case "BillingError": return "billing_exhausted";
    case "MessageTooLargeError": return "message_too_large";
    case "RuntimeError": return "unclassified_runtime_error";
  }
}

/**
 * What the owner has to do before this agent can run again: sign in / fix the
 * provider credential, or pick a model the plan allows. Retrying cannot fix it.
 */
export type RuntimeErrorRequiredAction = "user_reauth" | "user_model_access";

export const RUNTIME_ERROR_REQUIRED_ACTIONS: readonly RuntimeErrorRequiredAction[] = ["user_reauth", "user_model_access"];

/**
 * #proj-raft-computer:#48 (reconciler step 4b): why the daemon counted an
 * agent's provider credential invalid: the sign-in or key was rejected
 * (`user_reauth`), the plan does not include the model (`user_model_access`),
 * or the billing balance is exhausted (`billing`). The first two are also the
 * `RuntimeErrorRequiredAction` the agent's runtime error carried.
 */
export const CREDENTIAL_INVALID_REASONS = ["user_reauth", "user_model_access", "billing"] as const;
export type CredentialInvalidReason = (typeof CREDENTIAL_INVALID_REASONS)[number];

/**
 * Why the daemon stopped counting the credential invalid: the credentials
 * changed (web login, provider connect), a turn on it produced model output,
 * a person stopped the agent (Retry, restart), or the agent's model changed
 * (`user_model_access` only). Trace data on the server: a cause it does not
 * know (a newer daemon) still lifts, reported as `other`.
 */
export const CREDENTIAL_RESTORED_RELEASE_CAUSES = ["credentials_changed", "model_output", "explicit_stop", "model_changed"] as const;
export type CredentialRestoredReleaseCause = (typeof CREDENTIAL_RESTORED_RELEASE_CAUSES)[number];

export type CredentialRestoredMessage = Extract<MachineToServerMessage, { type: "agent:credential:restored" }>;

/**
 * The server's reading of an `agent:credential:restored` frame: null when it
 * cannot be acted on (no agent, a reason this build does not know: no block
 * can match it); an unknown `releaseCause` is kept as `other`.
 */
export function parseCredentialRestoredMessage(
  msg: unknown,
): { agentId: string; reason: CredentialInvalidReason; releaseCause: CredentialRestoredReleaseCause | "other"; launchId: string | null } | null {
  if (!msg || typeof msg !== "object") return null;
  const candidate = msg as Record<string, unknown>;
  if (candidate.type !== "agent:credential:restored") return null;
  if (typeof candidate.agentId !== "string" || !candidate.agentId) return null;
  const reason = CREDENTIAL_INVALID_REASONS.find((each) => each === candidate.reason);
  if (!reason) return null;
  const releaseCause = CREDENTIAL_RESTORED_RELEASE_CAUSES.find((each) => each === candidate.releaseCause) ?? "other";
  return {
    agentId: candidate.agentId,
    reason,
    releaseCause,
    launchId: typeof candidate.launchId === "string" && candidate.launchId ? candidate.launchId : null,
  };
}

export interface RuntimeErrorActivityDiagnostic {
  errorClass: RuntimeErrorClass;
  errorReason: RuntimeErrorReason;
  /** 16-hex SHA-256 prefix of daemon-scrubbed text. Never hash raw text. */
  fingerprint: string;
  reasonProvenance: RuntimeErrorReasonProvenance;
  /** Absent means that the runtime event contract cannot answer this fact. */
  nativeReasonPresent?: boolean;
  /**
   * Set when the daemon decided the owner must act (the same decision that
   * stops the runtime). Absent: no action needed, or a daemon older than this
   * field.
   */
  requiredAction?: RuntimeErrorRequiredAction;
  /**
   * #proj-raft-computer:#68: the readiness code of the login fact this
   * error recorded (`verification_required`, still sent as `AuthError` +
   * `user_reauth` so older servers pause and tell the owner). The daemon
   * enforces that block and reports it in `machine:runtime_readiness`; a
   * server that reads the report neither pauses the agent for it nor tells
   * the owner per agent. Additive: older servers drop it.
   */
  readinessCode?: ReadinessCode;
}

/**
 * task #25 — the agent is stuck on one tool call: no runtime output at all for
 * `thresholdMs` since `quietSinceMs`. The daemon attaches it to every
 * `agent:activity` frame (heartbeats included) while that is true and drops it
 * as soon as anything moves, so the latest frame is the current state. Names,
 * kinds, times and counts only; never the command or its output.
 */
export interface ToolStuckActivityDiagnostic {
  /** Normalized tool name, e.g. "bash". */
  toolName: string;
  /** The tool's activity detail kind, e.g. "running_command". */
  toolDetailKind: AgentActivityDetailKind;
  /** When the call started (daemon clock, ms). */
  startedAtMs: number;
  /** When this quiet stretch began: the later of the call's start and the last runtime event. */
  quietSinceMs: number;
  thresholdMs: number;
  /** Deliveries queued behind the call on the daemon. */
  queuedMessages: number;
}

/**
 * task #1116 — typed carrier for the daemon's delivery-consumption observation
 * (task #1114). Ids, classes, counts and times only; never message text or
 * credentials. Attached to `agent:activity` with detailKind
 * "delivery_unconsumed" and passed through by the server unchanged.
 */
export interface DeliveryConsumptionActivityDiagnostic {
  launchId: string;
  episode: number;
  unconsumedDeliveries: number;
  firstUnconsumedAtMs: number | null;
  lastDeliveryAtMs: number | null;
  /** deliveryId ?? message_id ?? app-inbox item id. */
  lastDeliveryKey: string | null;
  lastDeliveryPath: "stdin_idle_delivery" | "stdin_turn_end_delivery" | "busy_stdin_notification" | "app_inbox_notice" | null;
  lastConsumptionKind: "thinking" | "text" | "tool_call" | "tool_output" | "turn_end" | null;
  lastConsumptionAtMs: number | null;
  lastRuntimeResult: { kind: "completed"; atMs: number; empty: boolean } | { kind: "error"; atMs: number; errorClass: string } | null;
  lastDeliveryErrorClass: string | null;
  processAlive: boolean;
}

/**
 * task #1119 — typed carrier for the server's wake crash-loop breaker state,
 * attached to `agent:activity` with detailKind "wake_crash_loop_blocked".
 * Counts, classes, ids and times only.
 */
export interface WakeCrashLoopActivityDiagnostic {
  episode: number;
  earlyExitCount: number;
  threshold: number;
  windowMs: number;
  blocked: boolean;
  blockedAtMs: number | null;
  firstExitAtMs: number | null;
  lastExitAtMs: number | null;
  lastExitKind: "machine_disconnected" | "agent_process_exited" | null;
  lastSignal: string | null;
  lastLaunchId: string | null;
}

export type FeedbackTranscriptReportTimeSource = "web_report_bundle" | "server_request_received";

/**
 * task #1120/#1123 — stable, machine-readable reason a daemon could not
 * launch an agent. Decided by typed error code on the daemon (never by message
 * text) and carried to the web unchanged so copy is chosen by reason, not by
 * parsing the detail string. Adding a member is compatible; older servers and
 * web builds ignore the carrier, older daemons never send it.
 */
export const SPAWN_FAILURE_REASONS = [
  "agent_proxy_bind_failed",
  "runner_credential_mint_failed",
  "provider_connection_materialization_failed",
  "runtime_not_found",
  "model_not_found",
  "runtime_version_too_old",
  "runtime_spawn_failed",
  "runtime_login_required",
  "runtime_config_invalid",
  "model_not_configured",
  "session_needs_reset",
  // task #1258: the saved session belongs to another major line of the
  // runtime (OpenCode 1.x vs 2.x); resuming is refused, never guessed.
  "session_runtime_mismatch",
  // task #1307: the provider API key holds a character that cannot be sent in
  // an HTTP header (pasted text, a line break, a non-Latin-1 character).
  "provider_api_key_invalid",
  // The runtime process started but never produced its first output within
  // the daemon's start timeout (a queued or rate-limited model, a CLI waiting
  // for input). Retryable: it counts toward START_FAILURE_THRESHOLD, and the
  // pause it leads to retries by itself after a cooldown.
  "runtime_start_timeout",
  // The agent's settings set an environment variable this Computer no longer
  // takes from the server because it makes processes run other code (PATH,
  // NODE_OPTIONS, LD_PRELOAD, ...; daemon agentEnvVarPolicy.ts).
  "env_var_not_allowed",
  // Reconciler step 12 (#proj-raft-computer:#48, row C9): the runtime started
  // and said it cannot use the agent's model (unknown, not enabled, not in the
  // plan). Sent only to a server that advertises
  // SERVER_CAPABILITY_STICKY_FAILURE_REASONS_V1.
  "model_unsupported",
  // Reconciler step 12 (rows C10-C11 and the crash-streak cap): the runtime
  // started and kept failing; the daemon counted the failures itself (the
  // same error N times, N crashes in a row) and gave the agent back. Sent only
  // to a server that advertises SERVER_CAPABILITY_STICKY_FAILURE_REASONS_V1.
  "runtime_repeated_failure",
] as const;
export type SpawnFailureReason = (typeof SPAWN_FAILURE_REASONS)[number];

/**
 * task #1242 — how the daemon's PATH lookup ended when a start failed with
 * `runtime_not_found`. Written from the Windows launch resolution (task
 * #1240); absent on older daemons and when the lookup had no verdict to give
 * (a plain POSIX ENOENT). Only `not_on_path` is a confirmed absence that may
 * suggest installing; the other three say the lookup did not decide, so copy
 * stays neutral. Unknown values are dropped by the server, never echoed.
 */
export const SPAWN_FAILURE_LOOKUP_REASONS = [
  "not_on_path",
  "lookup_timed_out",
  "lookup_permission_denied",
  "lookup_failed",
] as const;
export type SpawnFailureLookupReason = (typeof SPAWN_FAILURE_LOOKUP_REASONS)[number];
export function isSpawnFailureLookupReason(value: unknown): value is SpawnFailureLookupReason {
  return typeof value === "string" && (SPAWN_FAILURE_LOOKUP_REASONS as readonly string[]).includes(value);
}

/**
 * The computer does not have the agent's runtime (no CLI on PATH): retrying
 * cannot fix that, only installing it there or switching runtime. A lookup
 * that timed out or failed did not decide, so it counts like any failure.
 * One rule for the server's wake breaker and the daemon's own restarts.
 */
export function isRuntimeAbsentStartFailure(reason: string, lookupReason: SpawnFailureLookupReason | undefined): boolean {
  return reason === "runtime_not_found" && lookupReason !== "lookup_timed_out" && lookupReason !== "lookup_failed";
}

/**
 * task #1221 — start failures that retrying cannot fix: the runtime refused
 * this agent's configuration (model not configured, config invalid) or needs a
 * human login. The server stops automatic relaunches after one of these until
 * a person restarts the agent or changes its runtime configuration.
 */
export const NON_RETRYABLE_SPAWN_FAILURE_REASONS: readonly SpawnFailureReason[] = [
  "model_not_configured",
  "runtime_login_required",
  "runtime_config_invalid",
  // task #10: the session's context compaction failed repeatedly; resuming it
  // again cannot succeed. Only Reset Session (a new session id) gets out.
  "session_needs_reset",
  // task #1258: the session was made by another runtime major line; retrying
  // the same resume cannot succeed. Reset Session or reinstall that line.
  "session_runtime_mismatch",
  // The Computer refuses the setting itself; only removing it from the
  // agent's env vars gets out.
  "env_var_not_allowed",
  // Reconciler step 12: the runtime cannot use the model. Another model, the
  // credential changing (a new key or plan may have it) or a person's start
  // gets out.
  "model_unsupported",
];

/**
 * Start failures that are almost always configuration (the model name is not
 * in the runtime's list on this computer: renamed or removed upstream, or its
 * provider has no usable key there) but could be a momentarily empty model
 * list. The server retries once after SPAWN_FAILURE_RETRY_ONCE_DELAY_MS; a
 * second failure in a row stops automatic relaunches like the reasons above.
 */
export const RETRY_ONCE_SPAWN_FAILURE_REASONS: readonly SpawnFailureReason[] = [
  "model_not_found",
];
export const SPAWN_FAILURE_RETRY_ONCE_DELAY_MS = 60_000;

/**
 * task #1123 — typed carrier on the `runtime_unavailable` activity frame the
 * daemon sends when a start fails. `model` is present only for the model
 * reasons and `runtime_start_timeout` (the configured model name, not
 * provider output).
 */
export interface SpawnFailureActivityDiagnostic {
  reason: SpawnFailureReason;
  model?: string;
  /**
   * task #1242 — present only with `reason: "runtime_not_found"`, when the
   * daemon's PATH lookup could say how it ended. Absent means "no verdict":
   * the web must not read it as confirmed missing.
   */
  lookupReason?: SpawnFailureLookupReason;
  /**
   * Set by the server, never by a daemon: automatic restarts are paused after
   * this failure (a reason retrying cannot fix, or too many failed starts in a
   * row) until the owner changes the model or key settings or restarts the
   * agent. `reason` is the last failure.
   */
  autoRestartPaused?: boolean;
  /**
   * Set by the server, never by a daemon: when the paused agent's next
   * automatic try starts (epoch ms). Present only while a pause that retries
   * by itself (the server's PAUSE_RETRY_START_FAILURE_REASONS, such as
   * `runtime_start_timeout` and `runtime_repeated_failure`) is in effect.
   * Absent: no time known (an older server, or a pause only a person lifts).
   */
  pauseRetryAtMs?: number;
}

/**
 * #proj-raft-computer:#48 (reconciler step 4b) — why the daemon holds an
 * agent's deliveries for an invalid credential that another agent saw
 * rejected (see the daemon's `formatCredentialInvalidHeldNotice`): its sign-in
 * needs renewing, its plan does not include its model, or the provider
 * balance is exhausted. Additive and optional: an older daemon never sends
 * it, an older server or web ignores it.
 */
export type CredentialHoldReason = "user_reauth" | "user_model_access" | "billing";

export const CREDENTIAL_HOLD_REASONS: readonly CredentialHoldReason[] = ["user_reauth", "user_model_access", "billing"];

export function isCredentialHoldReason(value: unknown): value is CredentialHoldReason {
  return typeof value === "string" && (CREDENTIAL_HOLD_REASONS as readonly string[]).includes(value);
}

/**
 * Typed carrier on the idle `agent:activity` frame whose detail is the held
 * notice. Only on those frames: any later frame omits it, so the latest frame
 * is the current state. The server passes it through to the web unchanged.
 */
export interface CredentialHoldActivityDiagnostic {
  reason: CredentialHoldReason;
}
/** Tier-2 (task #272) machine log tail outcome, reported beside the transcript result. Absent from older daemons. */
export interface FeedbackMachineLogTailOutcome {
  reachable: boolean;
  traceBundleId?: string;
  fallbackReason?: string;
  error?: string;
  lineCount?: number;
  sourceLineCount?: number;
  truncated?: boolean;
}
/**
 * Outcome of the machine_evidence attachment, reported beside the transcript
 * result. Additive and absent from older daemons. Never decides the transcript
 * result: the transcript is uploaded and reported regardless of this outcome.
 *   uploaded    stored by the worker as kind machine_evidence
 *   omitted     not uploaded: even with every trace record dropped the object exceeds the byte cap
 *   unsupported the server or worker did not acknowledge the machine_evidence kind (older deployment); nothing uploaded
 *   failed      generation, signing or upload failed (see `error`)
 *   timeout     did not finish within the bounded wait; the transcript result was returned without it
 */
export interface FeedbackMachineEvidenceOutcome {
  status: "uploaded" | "omitted" | "unsupported" | "failed" | "timeout";
  traceBundleId?: string;
  error?: string;
  reason?: "over_byte_cap";
  /** Raw UTF-8 JSON bytes of the object (uploaded) or of its smallest form (omitted). */
  bytes?: number;
  truncated?: boolean;
  droppedOverBytes?: number;
  /** Sections whose provider failed; they were sent as null. */
  unavailable?: ("observedFailureSummary" | "feedbackTraceTail" | "feedbackMachineState")[];
}
export type FeedbackTranscriptWindowCoverage =
  | "covered"
  | "outside_report_window"
  | "timestamps_unavailable"
  | "report_time_invalid";
export type FeedbackTranscriptTruncationDirection = "head" | "tail" | "window";

export interface FeedbackTraceBundleTranscriptMetadata {
  feedbackReportTimeSource?: FeedbackTranscriptReportTimeSource;
  feedbackTranscriptFirstEventAt?: string;
  feedbackTranscriptLastEventAt?: string;
  feedbackTranscriptTruncated?: "true" | "false";
  feedbackTranscriptTruncationDirection?: FeedbackTranscriptTruncationDirection;
  feedbackTranscriptWindowCoverage?: FeedbackTranscriptWindowCoverage;
}

export const FEEDBACK_TRACE_BUNDLE_TRANSCRIPT_METADATA_KEYS = {
  feedbackReportTimeSource: true,
  feedbackTranscriptFirstEventAt: true,
  feedbackTranscriptLastEventAt: true,
  feedbackTranscriptTruncated: true,
  feedbackTranscriptTruncationDirection: true,
  feedbackTranscriptWindowCoverage: true,
} satisfies Record<keyof FeedbackTraceBundleTranscriptMetadata, true>;
export type FeedbackTraceBundleTranscriptMetadataKey =
  keyof typeof FEEDBACK_TRACE_BUNDLE_TRANSCRIPT_METADATA_KEYS;

export interface FeedbackTranscriptWindow {
  reportGeneratedAt: string;
  reportTimeSource: FeedbackTranscriptReportTimeSource;
  reportWindowStartAt: string;
  toleranceMs: number;
  coverage: FeedbackTranscriptWindowCoverage;
  transcriptFirstEventAt?: string;
  transcriptLastEventAt?: string;
}

/** Shape of `machine:host_identity.hostIdHash`; anything else is dropped by the Server. */
export const HOST_ID_HASH_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Coarse kind of machine a Computer runs on, for its icon. Reported by the
 * daemon (`ready.deviceClass`); the Server drops values outside this list.
 */
export const DEVICE_CLASSES = ["laptop", "mini", "studio", "imac", "desktop", "server", "vm", "container"] as const;
export type DeviceClass = (typeof DEVICE_CLASSES)[number];
export const isDeviceClass = (value: unknown): value is DeviceClass =>
  typeof value === "string" && (DEVICE_CLASSES as readonly string[]).includes(value);

/**
 * Cloud or VM platform a Computer runs on, with its display name. Recognized
 * on the machine from local files only (`ready.hostProvider`); the Server
 * drops ids outside this list. A platform that is not listed shows as a plain
 * VM. Add a row only with a source for how it is recognized (daemon
 * `hostFacts.ts`).
 */
export const HOST_PROVIDER_LABELS = {
  aws: "AWS",
  gcp: "Google Cloud",
  hetzner: "Hetzner Cloud",
  digitalocean: "DigitalOcean",
  vultr: "Vultr",
  linode: "Akamai (Linode)",
  scaleway: "Scaleway",
  alibaba: "Alibaba Cloud",
  upcloud: "UpCloud",
  exoscale: "Exoscale",
  openstack: "OpenStack",
  exe_dev: "exe.dev",
  sprites: "Sprites",
  fly: "Fly.io",
} as const;
export type HostProvider = keyof typeof HOST_PROVIDER_LABELS;
export const isHostProvider = (value: unknown): value is HostProvider =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(HOST_PROVIDER_LABELS, value);

/**
 * How the Computer's daemon itself is running (`ready.installKind`): the
 * single-file SEA build, Node with a JS entry, or Electron (Raft Desktop).
 * Same detection as the codex driver's `host_kind`; absent when the daemon
 * cannot tell and on older daemons.
 */
export const DAEMON_INSTALL_KINDS = ["sea", "node", "electron"] as const;
export type DaemonInstallKind = (typeof DAEMON_INSTALL_KINDS)[number];
export const isDaemonInstallKind = (value: unknown): value is DaemonInstallKind =>
  typeof value === "string" && (DAEMON_INSTALL_KINDS as readonly string[]).includes(value);

/**
 * Where this Computer came from (`ready.migratedFrom`), on its first ready to
 * each server after the move: `electron` = Raft Desktop's move from its
 * embedded Computer to the official install reached its `start` step (not
 * necessarily that the move then succeeded: `verify` comes after; the
 * product event desktop_computer_migration_finished says that). Desktop leaves a one-shot
 * `computer/migrated-from.json` in RAFT_HOME; the Computer deletes it once
 * every attached server has had it). Absent otherwise and on older daemons.
 */
export const COMPUTER_MIGRATED_FROM = ["electron"] as const;
export type ComputerMigratedFrom = (typeof COMPUTER_MIGRATED_FROM)[number];
export const isComputerMigratedFrom = (value: unknown): value is ComputerMigratedFrom =>
  typeof value === "string" && (COMPUTER_MIGRATED_FROM as readonly string[]).includes(value);

/**
 * Advisory hint that this Computer's installer state looks like it needs a
 * repair run by hand (#proj-raft-computer task #34), read by the Computer from
 * the installer's own files under `computer/installer/`:
 *   unrecovered_operation — `active.json` names an operation with no terminal
 *     receipt, and either that receipt says `unresolved` or (no receipt, not a
 *     repair in progress) the `metadata-damage.json` marker exists.
 * The installer's own retry reaches a repair within one request, yet machines
 * in production keep failing web upgrades with "An earlier installation could
 * not be recovered" for reasons not pinned down yet; running the install
 * command on the machine is the known working fix. The hint never blocks a
 * web upgrade: the web recommends the install command and still offers Upgrade.
 * Sent as `ready.installerRepairHint` and `machine:installer_repair_hint`;
 * absent when there is nothing to hint and on older Computers. Adding a reason
 * is additive: a server that does not know it ignores it.
 */
export const COMPUTER_INSTALLER_REPAIR_HINT_REASONS = ["unrecovered_operation"] as const;
export type ComputerInstallerRepairHintReason = (typeof COMPUTER_INSTALLER_REPAIR_HINT_REASONS)[number];
export interface ComputerInstallerRepairHint {
  reason: ComputerInstallerRepairHintReason;
}
/** The report when it names a known reason, else null (absent, malformed, or a reason this build does not know). */
export function parseComputerInstallerRepairHint(value: unknown): ComputerInstallerRepairHint | null {
  if (typeof value !== "object" || value === null) return null;
  const reason = (value as { reason?: unknown }).reason;
  return typeof reason === "string" && (COMPUTER_INSTALLER_REPAIR_HINT_REASONS as readonly string[]).includes(reason)
    ? { reason: reason as ComputerInstallerRepairHintReason }
    : null;
}

/**
 * os-release `ID` / `ID_LIKE` entries, for picking a distribution icon: the
 * spec allows only lowercase letters, digits and `._-` ("ubuntu", "rhel",
 * "opensuse-tumbleweed"). `ready.osIdLike` holds at most OS_ID_LIKE_MAX ids.
 */
const OS_ID_PATTERN = /^[a-z0-9._-]{1,32}$/;
export const OS_ID_LIKE_MAX = 4;
/** A valid os-release ID, or null. */
export function normalizeOsId(value: unknown): string | null {
  return typeof value === "string" && OS_ID_PATTERN.test(value) ? value : null;
}
/** Valid os-release ID_LIKE ids (invalid ones dropped, at most OS_ID_LIKE_MAX), or null when none. */
export function normalizeOsIdLike(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.filter((id): id is string => normalizeOsId(id) !== null).slice(0, OS_ID_LIKE_MAX);
  return ids.length > 0 ? ids : null;
}

/** Longest `ready.osRelease` the Server keeps ("Ubuntu 26.04"). */
export const OS_RELEASE_MAX_LENGTH = 64;
/** A reported OS name + version, or null when absent, empty or not plain printable text. */
export function normalizeOsRelease(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > OS_RELEASE_MAX_LENGTH || /[\p{Cc}\p{Cf}]/u.test(trimmed)) return null;
  return trimmed;
}

/** A machine key found where an agent could read it (ready frame, #proj-raft-computer task #38). */
export interface LegacyCredentialExposureReport {
  /** ISO time the daemon found it. */
  foundAt: string;
  /** First 16 hex characters of sha256(key), the server's `apiKeyFingerprint` scheme. */
  keyFingerprint: string;
}

/**
 * Why the daemon dropped an agent's session (`agent:session:invalidate`); the
 * server forgets the session whatever the reason (trace only). Additive.
 * `input_too_large` / `compaction_failed` (reconciler step 12, rows C8 and
 * C10): the session no longer fits the model, so a new one starts.
 * `runtime_host_migration` (#oar-raft:#10): the agent's runtime moved to
 * another host whose store cannot read the session (Cursor: a Cursor CLI
 * session on the Cursor SDK, or the reverse), so a new one starts. Older
 * servers read no reason.
 */
export type AgentSessionInvalidateReason =
  | "missing"
  | "provider_replay_rejected"
  | "repeated_early_crash"
  | "input_too_large"
  | "compaction_failed"
  | "runtime_host_migration";

export type MachineToServerMessage =
  /**
   * Reply to `machine:host_identity:request`: HMAC(key = this machine's
   * hardware ID, "raft-host-id-v1:" + serverId), 32 hex chars. Equal for every
   * Computer on one machine within a server, unrelated across servers; the
   * hardware ID itself never leaves the machine.
   */
  | { type: "machine:host_identity"; hostIdHash: string }
  /**
   * TODO(lifecycle-v2/daemon-protocol): `agent:status`,
   * `agent:activity`, and `agent:session` are legacy lifecycle signal
   * frames. The server currently adapts them into canonical lifecycle events
   * in `legacyAgentLifecycleAdapter`. The next protocol should add structured
   * daemon lifecycle events for runtime_ready/runtime_interrupted,
   * activity/progress, session_init/resync, runtime_stalled/provider_error,
   * and process_exit with explicit reason/correlation/window attrs. Once the
   * supported daemon window speaks that protocol, delete these lifecycle
   * compatibility frames from the reducer path.
   */
  | {
      type: "agent:status";
      agentId: string;
      status: string;
      launchId?: string;
      /**
       * task #1119: when `status` reports a process exit, the daemon attaches
       * how the process ended so the server's crash-loop breaker can record
       * the signal (ids/classes only). Absent on older daemons.
       */
      exit?: { code: number | null; signal: string | null };
      /**
       * RFC 069 §8 (with `DAEMON_CAPABILITY_SEQUENCED_STATUS`): the sending
       * daemon process and its per-agent sequence, shared with
       * `agent:activity`. Sequences compare only within one
       * `daemonInstanceId`. Absent on older daemons.
       */
      daemonInstanceId?: string;
      clientSeq?: number;
    }
  /**
   * `probeId` (optional) — when this activity message is the daemon's
   * response to a prior `agent:activity_probe`, the daemon echoes back
   * the server-issued `probeId`. Server uses it to correlate the
   * response with its pending probe and cancel the fallback timer.
   * Self-initiated activity broadcasts (heartbeat, transition, etc.)
   * leave `probeId` unset.
   *
   * `clientSeq` (optional) — daemon-side per-agent monotonic counter
   * (starts at 1 on daemon process start, increments on each emit).
   * `daemonInstanceId` identifies that daemon process lifetime. Server uses
   * `(daemonInstanceId, launchId, clientSeq)` as the dedupe key on ingest
   * and drops messages whose `clientSeq` is not strictly greater than
   * the highest seen for that daemon/launch generation. The process identity
   * stays stable across WS reconnects but changes across daemon restarts, so
   * reconnect replays remain deduped without carrying a stale watermark into
   * a new daemon process. Old daemons leave it unset and use the server-owned
   * legacy ingest epoch compatibility path.
   * Activity has no durable cross-process outbox: a daemon restart accepts
   * in-flight activity loss and never redelivers pre-restart facts under the
   * new process identity. This is what makes generations independent. Adding
   * a durable activity outbox would require content-level cross-generation
   * dedupe before replay can be enabled.
   *
   * Roll out the optional carrier server/shared first, then daemon producers.
   * Until every daemon sends it, absence must remain on the typed legacy
   * compatibility path rather than being interpreted as a process identity.
   * Introduced 2026-05-02 #engineering:72283cf7 task #340 PR B.
   */
  /**
   * `isHeartbeat` is the producer-declared replay-provenance bit
   * (lifecycle-v2 #457/#460): the daemon's activity heartbeat timer knows at
   * emission time that it re-broadcasts stale lastActivity, so it declares
   * true; every other send (genuine broadcast, probe response) declares
   * false explicitly. Absence = legacy daemon cohort, which the server
   * classifies through the content-identity compat shim only. Closed
   * three-state semantics — never infer it server-side from seq or
   * producerFactId (both advance on heartbeat replays).
   * Introduced 2026-07-04 #proj-runtime:19709f22 task #460 PR-beta-2.
   */
  /** task #25 step 2: the answer to `agent:interrupt-turn`; tool name and a duration only. */
  | { type: "agent:interrupt-turn:result"; agentId: string; requestId: string; outcome: AgentTurnInterruptOutcome; toolName?: string; stuckForMs?: number }
  /** #proj-runtime:#41: the answer to `agent:interrupt-subagent`. */
  | { type: "agent:interrupt-subagent:result"; agentId: string; requestId: string; outcome: AgentSubagentInterruptOutcome }
  | { type: "agent:activity"; agentId: string; activity?: string; activityKind?: AgentActivityKind; detail: string; detailKind?: AgentActivityDetailKind; entries?: DaemonTrajectoryEntry[]; launchId?: string; daemonInstanceId?: string; probeId?: string; clientSeq?: number; producerFactId?: string; observedAtMs?: number; isHeartbeat?: boolean; runtimeError?: RuntimeErrorActivityDiagnostic; deliveryConsumption?: DeliveryConsumptionActivityDiagnostic; spawnFailure?: SpawnFailureActivityDiagnostic; providerRequest?: import("./providerRequestActivity").ProviderRequestActivity; toolStuck?: ToolStuckActivityDiagnostic; credentialHold?: CredentialHoldActivityDiagnostic }
  /** Agent typing line: see `./agentTyping` (`AgentSendIntentFrame`). */
  | import("./agentTyping").AgentSendIntentFrame
  | { type: "agent:session"; agentId: string; sessionId: string; launchId?: string }
  | { type: "agent:session:invalidate"; agentId: string; sessionId: string; launchId?: string; reason: AgentSessionInvalidateReason }
  | { type: "agent:runtime_profile"; agentId: string; facts: AgentRuntimeProfileReport; launchId?: string; traceparent?: string; source?: RuntimeProfileReportSource }
  /** task #1357 item 1 (with `DAEMON_CAPABILITY_MODEL_LIMITS_REPORT_V1`): the model limits a Pi session was built with; see `./agentModelLimits`. */
  | import("./agentModelLimits").AgentModelLimitsFrame
  | { type: "agent:runtime_profile:migration:ack"; agentId: string; migrationKey: string; launchId?: string; traceparent?: string }
  | { type: "agent:runtime_profile:migration_done"; agentId: string; migrationKey: string; launchId?: string; traceparent?: string }
  | { type: "agent:runtime_profile:daemon_release_notice:ack"; agentId: string; noticeKey: string; launchId?: string; traceparent?: string }
  /**
   * The daemon has an app-inbox item due for an agent that has no local
   * process and no in-memory restart snapshot (e.g. every idle agent after a
   * daemon restart). The Server owns the agent config, so it decides and
   * dispatches the start (task #1103). `wakeRequestId` is derived from the
   * agent and the inbox item, so a duplicate fire or a resend after reconnect
   * carries the same id and the Server can replay its outcome.
   */
  | { type: "agent:wake:request"; agentId: string; wakeRequestId: string; reason: "app_inbox_notice"; appId: string; sourceRef: { kind: string; id: string; revision?: string }; pendingAppItems: number; traceparent?: string }
  /**
   * `processInstanceId` (RFC 071 §4.3 rule 2, optional): the registered
   * process that now carries `launchId`. Set only when `queueState` is
   * `running`/`rebound` AND a process is registered (a rebind); a
   * `queued`/`starting` ack never carries one, because the daemon mints the
   * id only after the spawn (it arrives on `agent:process_spawned`).
   */
  | { type: "agent:start:ack"; agentId: string; startDispatchId: string; launchId?: string; queueState: "queued" | "starting" | "running" | "rebound"; queueDepth: number; queueAgeMs: number; traceparent?: string; processInstanceId?: string }
  /**
   * RFC 071 §7 (with `DAEMON_CAPABILITY_RUNTIME_OUTCOME_V1`): a launch-bound
   * runtime outcome. E1 `terminal_failure` is sent once, from the daemon's
   * terminal cleanup, before the process record is removed; its fingerprint
   * is computed from the RAW runtime text, never from display copy. E2
   * `turn_completed` is sent at turn end only for a registered launch whose
   * turn produced model output with zero runtime errors. `clientSeq` is the
   * per-agent counter shared with `agent:status`/`agent:activity` (RFC 069
   * §8); it compares only within one `daemonInstanceId`. A server ignores a
   * frame with an unknown `v`. Servers without a handler drop the type.
   */
  | {
      type: "agent:runtime:outcome";
      v: 1;
      agentId: string;
      launchId: string;
      sessionId: string | null;
      daemonInstanceId: string;
      clientSeq: number;
      observedAtMs: number;
      traceparent?: string;
      outcome: AgentRuntimeOutcome;
      /** RFC 071 outbox: `breakerGeneration` of this launch's agent:start, when it had one. */
      generation?: number;
    }
  /**
   * RFC 071 §4.3 rule 2: sent right after a successful spawn, with the
   * process identity the daemon minted for it. `launchId` is the launch the
   * process was spawned for.
   */
  | {
      type: "agent:process_spawned";
      agentId: string;
      daemonInstanceId: string;
      processInstanceId: string;
      launchId: string;
      clientSeq: number;
      /**
       * Other launches the daemon accepted and folded into this spawn (a start
       * that arrived while this one was queued or starting). Each is bound to
       * this process identity; none of them gets a process of its own.
       */
      supersededLaunchIds?: string[];
      /**
       * True when no accepted server start was waiting for this spawn: the
       * daemon restarted the runtime on its own (idle/cold restart, a deferred
       * spawn woken by a message) under an already-settled `launchId`.
       */
      respawn?: boolean;
      /** RFC 071 outbox: `breakerGeneration` of `launchId`'s agent:start, when it had one. */
      generation?: number;
    }
  /**
   * RFC 071: the final result for an accepted launch that is not reported by
   * `agent:process_spawned`. Every launch the daemon accepts from
   * `agent:start` ends in exactly one of: named in a `process_spawned`
   * (`launchId` or `supersededLaunchIds`), `rebound` onto a running process,
   * or `not_spawned` with a reason. `not_spawned` is sent only when the
   * daemon knows no process was created for the launch.
   */
  | {
      type: "agent:start:outcome";
      agentId: string;
      daemonInstanceId: string;
      launchId: string;
      clientSeq: number;
      result:
        | { kind: "rebound"; processInstanceId: string }
        | { kind: "not_spawned"; reason: AgentStartNotSpawnedReason };
      /** RFC 071 outbox: `breakerGeneration` of this launch's agent:start, when it had one. */
      generation?: number;
    }
  /**
   * RFC 071 outbox markers. Overflow folds the oldest un-acked critical
   * frames of one daemon instance and takeover epoch into a gap; the counts
   * say what was folded. The server must treat the range conservatively.
   */
  | {
      type: "agent:runtime:outcome_gap";
      agentId: string;
      daemonInstanceId: string;
      gapId: string;
      fromSeq: number;
      toSeq: number;
      counts: AgentRuntimeOutcomeGapCounts;
      takeoverEpoch: number;
    }
  /** Gaps of more daemon instances than the outbox keeps, merged. */
  | {
      type: "agent:runtime:outcome_cross_instance_unknown";
      agentId: string;
      gapId: string;
      instances: string[];
      counts: AgentRuntimeOutcomeGapCounts;
      takeoverEpoch: number;
    }
  /** The daemon's outcome storage for this agent failed (write/fsync error or corrupt file): evidence may be missing. Best effort. */
  | { type: "agent:runtime:outcome_unreliable"; agentId: string; daemonInstanceId: string; takeoverEpoch: number }
  /**
   * RFC 071 §4.3 rule 3: sent from the runtime's own `exit` event with the
   * identity of the process that exited (closure-captured, not the current
   * registry entry), whether or not the daemon still has it registered.
   * `spawnLaunchId` is the launch it was spawned for: `null` when the daemon
   * started it on its own without a server launch (an internal restart) and
   * a server start was later rebound onto it (the rebind is never treated as
   * its birth). `launchId` is the associated launch: the last server launch
   * it carried (a rebind changes it). The process is identified by
   * `(daemonInstanceId, processInstanceId)`, the identity the server bound
   * through `process_spawned` or the `rebound` start outcome; a null
   * `spawnLaunchId` is settled by that identity only. The only exit evidence
   * the terminal-failure breaker uses.
   */
  | { type: "agent:process_exited"; agentId: string; daemonInstanceId: string; processInstanceId: string; spawnLaunchId: string | null; launchId: string; clientSeq: number; code: number | null; signal: string | null; /** RFC 071 outbox: `breakerGeneration` of `launchId`'s agent:start, when it had one. */ generation?: number }
  | { type: "agent:deliver:ack"; agentId: string; seq: number; traceparent?: string; deliveryId?: string; mentionDelivery?: MentionDeliveryIdentitySnapshot }
  /**
   * Message bodies the daemon itself put in front of the model (startup
   * catch-up, wake with thread context, full-body stdin delivery), reported
   * once the runtime showed it took the input. The Server moves the agent's
   * read position over them only where they join it without a gap. Sent with
   * or without `agent:model-seen-boundary`; that capability additionally
   * means pulls are reported elsewhere (design-model-seen-boundary).
   */
  | { type: "agent:model-seen"; agentId: string; launchId?: string; items: AgentModelSeenItem[] }
  /**
   * The first turn of a launch ended. `shownUnreadTargets`: the unread-summary
   * targets (`#channel`, `#channel:thread`, `dm:@peer`) that launch's start
   * input showed the model with their counts. On `completed` the Server marks
   * read, up to what the start's snapshot held, the ones the agent owes
   * nothing in (no DM, unread @mention or task); it never widens past its own
   * snapshot. Sent once per launch, only to a server with
   * SERVER_CAPABILITY_TURN_ENDED_V1.
   */
  | { type: "agent:turn:ended"; agentId: string; launchId: string; outcome: AgentTurnEndedOutcome; shownUnreadTargets: string[] }
  /**
   * `DAEMON_CAPABILITY_STARTUP_READINESS`: this launch's runtime emitted its
   * first output, once per runtime process (per-turn runtimes send it each
   * turn). Older servers ignore it.
   */
  | { type: "agent:runtime:ready"; agentId: string; launchId: string }
  /**
   * #proj-raft-computer:#48 (reconciler step 4b): the daemon no longer counts
   * this agent's credential invalid for `reason`, and the agent had shown
   * that error (its runtime error) or the held notice for it. Sent once per
   * agent and reason when the daemon releases its record (`releaseCause`).
   * The server lifts only an automatic-wake block of that same reason.
   * Additive: older servers ignore the type; older daemons never send it, and
   * a daemon that restarted has no record to release, so their blocks lift
   * only on a login or a person's start, as before. `launchId`: the agent's
   * launch at the release, trace only.
   */
  | { type: "agent:credential:restored"; agentId: string; reason: CredentialInvalidReason; releaseCause: CredentialRestoredReleaseCause; launchId?: string }
  | { type: "agent:delivery:transition"; agentId: string; stage: MentionDeliveryTransitionStage; outcome: "accepted" | "coalesced"; mentionDelivery: MentionDeliveryIdentitySnapshot; traceparent?: string }
  | { type: "agent:delivery:terminal_error"; agentId: string; code: MentionDeliveryTerminalErrorCode; mentionDelivery: MentionDeliveryIdentitySnapshot; traceparent?: string }
  /**
   * The daemon received an `agent:deliver` for an agent that has no running
   * process and no cached idle/restart config (task #1113). It cannot wake the
   * agent itself; the Server owns the config and must fall back to an
   * `agent:start` that carries this message. Keyed like the delivery ack
   * (deliveryId, else agentId+seq) so duplicates are idempotent.
   */
  | { type: "agent:delivery:rejected"; agentId: string; seq: number; deliveryId?: string; reason: "no_process"; mentionDelivery?: MentionDeliveryIdentitySnapshot; traceparent?: string }
  | { type: "agent:workspace:file_tree"; agentId: string; files: FileNode[]; dirPath?: string; includeHidden?: boolean }
  | { type: "agent:workspace:file_content"; agentId: string; requestId: string; content: string | null; binary: boolean; size?: number; mimeType?: string; encoding?: "utf-8" | "base64" }
  | { type: "agent:skills:list_result"; agentId: string; requestId?: string; global: SkillInfo[]; workspace: SkillInfo[] }
  | { type: "agent:diagnostic:session_transcript_result"; agentId: string; requestId: string; runtime: string; sessionId: string; reachable: boolean; path: string | null; fallbackReason?: string; transcript: string | null; sizeBytes: number; truncated: boolean; redacted: boolean; tier: string; error?: string }
  | {
      type: "agent:diagnostic:feedback_transcript_result"; agentId: string; feedbackReportId: string; requestId: string; traceBundleId?: string; reachable: boolean; fallbackReason?: string; error?: string; transcriptWindow?: FeedbackTranscriptWindow; machineLogTail?: FeedbackMachineLogTailOutcome; machineEvidence?: FeedbackMachineEvidenceOutcome;
      // task #1228 ① (additive; absent from older daemons, ignored by older servers).
      outcomeVersion?: 1;
      lookup?: FeedbackTranscriptLookupOutcome;
      upload?: FeedbackTranscriptUploadOutcome;
      outcomeObject?: FeedbackTranscriptOutcomeObjectPlan;
    }
  | { type: "machine:workspace:scan_result"; directories: WorkspaceDirectoryInfo[] }
  | { type: "machine:workspace:delete_result"; directoryName: string; success: boolean }
  | {
      type: "machine:migration:source_workspace_archive_result";
      requestId: string;
      migrationId: string;
      agentId: string;
      // "source_absent": nothing of the agent is left on the source (added; older
      // servers treat any non-"error" outcome as success).
      outcome: "archived" | "already_archived" | "source_absent" | "error";
      /** Code-shaped failure cause when outcome is "error" (added; optional). */
      errorCode?: string;
    }
  | {
      type: "machine:runtime_models:result";
      requestId: string;
      /**
       * Typed source truth. New servers prefer this field; the legacy fields
       * below remain during the daemon/server rolling-upgrade window.
       */
      outcome?: RuntimeModelSourceOutcome;
      models?: RuntimeModelInfo[];
      default?: string;
      error?: string;
    }
  /**
   * Unsolicited: this machine's current model list for one runtime, with the
   * runtime's own display names. The server keeps one copy per (machine,
   * runtime) and every model-name surface reads it, so the runtime config
   * selector and the rest of the UI show the same name. Sent only for a live
   * detection result; replaces the previous copy whole.
   */
  | {
      /**
       * Proactive model-list report (task #700): the daemon reports each
       * runtime's model list so every display surface can read one shared
       * catalog instead of re-deriving names. Sent on connect (after
       * `ready`, per runtime in `ready.runtimes`) and again after a runtime
       * rescan; whole-list replacement per runtime. Only `live` detections
       * are sent — errors/unsupported keep the server's previous copy.
       */
      type: "machine:runtime_models:catalog";
      runtime: string;
      models: RuntimeModelCatalogEntry[];
      /**
       * The detection is the runtime's own word that it has no models now
       * (Pi after its last provider was signed out from the web): `models` is
       * then empty and replaces the server's copy with none. Only sent with
       * an empty list, and only after a sign-in change; a server that
       * predates it refuses the empty list and keeps its copy, as before.
       */
      authoritative?: true;
    }
  | {
      type: "machine:provider_probe:result";
      requestId: string;
      probeId: ProviderProbeId;
      outcome: "success" | "failure";
      category: ProviderProbeDaemonCategory | null;
      latencyMs: number | null;
      responseSha256: string | null;
      responseBytes: number | null;
      resultDigest: string;
      authorityEcho: { connectionEpochId: string; replicaGeneration: string };
      daemonVersion: string | null;
      computerVersion: string | null;
      runtimeVersion: string | null;
      reply: string | null;
    }
  /** task #17: each web-loginable runtime's auth status, sent unprompted after detection and after a login or logout. */
  | { type: "machine:runtime_auth:status"; report: RuntimeAuthStatusReport }
  | { type: "machine:runtime_auth:login:event"; loginId: RuntimeAuthLoginId; event: RuntimeAuthLoginEvent }
  | { type: "machine:runtime_auth:login:result"; loginId: RuntimeAuthLoginId; result: RuntimeAuthLoginResult }
  | { type: "machine:runtime_auth:logout:result"; requestId: string; result: RuntimeAuthLogoutResult }
  | { type: "machine:runtime_auth:providers:result"; requestId: string; result: RuntimeAuthProvidersResult }
  | { type: "machine:runtime_auth:connect_provider:result"; requestId: string; result: RuntimeAuthProviderConnectResult }
  /**
   * Reconciler step 15: the runtime's machine-shared credential changed on
   * disk (a terminal sign-in) and a fresh status query read it signed in.
   * Sent only to a server with SERVER_CAPABILITY_RUNTIME_CREDENTIALS_CHANGED_V1.
   * The runtime only: never a path, a digest or an account.
   */
  | { type: "machine:runtime_credentials:changed"; runtime: RuntimeAuthRuntime }
  /**
   * #proj-raft-computer:#68: the facts only the daemon observes (its
   * logins), a full snapshot (`RuntimeReadinessReport`), on change and on
   * connect. Sent only to a server with SERVER_CAPABILITY_RUNTIME_READINESS_V1;
   * read with `parseRuntimeReadinessReport` (unknown codes kept with their
   * behaviour; an unreadable fact dropped, not the frame).
   */
  | ({ type: "machine:runtime_readiness" } & RuntimeReadinessReport)
  /** Closed, sanitized payload; provider credentials/raw responses never cross this boundary. */
  | {
      type: "machine:runtime_account_usage:snapshot";
      requestId?: string;
      snapshot: RuntimeAccountUsageSnapshot;
    }
  /**
   * How a limit-reset redeem ended, with the usage read the Computer ran right
   * after it (absent when that read could not be taken). The server writes the
   * snapshot to the usage cache like any other before answering the person.
   */
  | {
      type: "machine:runtime_account_usage:limit_reset:result";
      requestId: string;
      result: RuntimeLimitResetResult;
      snapshot?: RuntimeAccountUsageSnapshot;
    }
  /** How a `machine:runtime_account_usage:limit_resets:read` ended. */
  | {
      type: "machine:runtime_account_usage:limit_resets:read:result";
      requestId: string;
      result: RuntimeLimitResetsReadResult;
    }
  /**
   * Space on the disk holding agent data, sent on connect and hourly. Servers
   * that predate it ignore the unknown type.
   */
  | { type: "machine:disk_status"; availableBytes: number; totalBytes: number }
  /**
   * The machine's memory (Linux: MemAvailable), sent on connect and every
   * 5 minutes. Servers that predate it ignore the unknown type.
   */
  | { type: "machine:memory_status"; availableBytes: number; totalBytes: number }
  /**
   * #proj-raft-computer task #34: `ready.installerRepairHint` changed while the
   * connection stayed up (re-read every 5 minutes and after a failed web
   * upgrade); null = nothing to hint any more. Servers that predate it ignore the
   * unknown type and keep the value from `ready`.
   */
  | { type: "machine:installer_repair_hint"; hint: ComputerInstallerRepairHint | null }
  /**
   * Best-effort graceful shutdown notice sent immediately before the daemon
   * closes its WebSocket. The server uses it to distinguish an intentional
   * Computer/daemon stop from an unplanned transport disconnect.
   */
  | { type: "machine:shutdown"; reason: MachineShutdownReason; lifecycleAcks?: ComputerLifecycleExecutionAck[] }
  | ServerBoundDueReceiptMessage
  | { type: "reminder.snapshot.request"; agentId: string }
  /** Request Server→Computer refill of typed app config envelopes for one agent. */
  | { type: "app_config.snapshot.request"; agentId: string }
  /** Ask for the Server's current flag-derived agent config fields: see `./featuresChanged`. */
  | import("./featuresChanged").ServerFeaturesRequestMessage
  /** View Context: whether a context view is possible for one agent on this Computer. See `./agentContextView`. Additive. */
  | import("./agentContextView").AgentContextViewAvailabilityMessage
  | { type: "ping" }
  | { type: "pong" }
  /**
   * Terminal completion of a remote machine-wide Computer restart. The old
   * generation persists the request before exiting; the newly ready origin
   * runner emits this receipt after reconnect.
   */
  | { type: "computer:restart:done"; requestId: string; ok: boolean; error?: string }
  /**
   * task #917: terminal outcome of a remote `computer:upgrade` request that
   * never reached the installer. `ok: false` carries the refusal (an external
   * supervisor that cannot be upgraded in place, a busy service, an
   * unreachable IPC seam) so the server settles the request at once instead
   * of waiting out its deadline; the same receipt is also written to disk and
   * relayed on the next `ready`. Older servers ignore the type.
   */
  | { type: "computer:upgrade:done"; requestId: string; ok: boolean; reason?: string; code?: string }
  /** Reconciler step 13: a drained web upgrade's progress (./computerUpgradeDrain). Sent only for a request that carried `drain`. */
  | import("./computerUpgradeDrain").ComputerUpgradeDrainingMessage
  | { type: "ready"; capabilities?: string[]; /** RFC 069 §8: this daemon process's generation. */ daemonInstanceId?: string; /** RFC 071 outbox: agents whose outcome storage is unreliable; `agent:runtime-outcome-v1` does not apply to them. */ runtimeOutcomeUnreliableAgents?: string[]; /** task #1268: omitted entirely while `runtimeDetection.status` is "pending" (a pending ready carries no inventory); otherwise this round's detected runtime ids. */ runtimes?: string[]; runtimeVersions?: Record<string, string>; /** task #1268: absent on daemons that detect synchronously before ready (= complete). */ runtimeDetection?: RuntimeDetectionReport; runningAgents: string[]; hostname?: string; os?: string; /** Set only on WSL (`os` still says `linux`); absent on older daemons and other hosts. */ osVariant?: "wsl1" | "wsl2"; /** Coarse kind of machine for the Computer icon, classified on the machine (the model it comes from is not sent); absent when unknown and on older daemons. */ deviceClass?: DeviceClass; /** Cloud / VM platform recognized on the machine; absent when not recognized and on older daemons. */ hostProvider?: HostProvider; /** OS name and version, e.g. "Ubuntu 26.04" (Linux `/etc/os-release`); absent when unknown and on older daemons. */ osRelease?: string; /** os-release `ID` ("ubuntu"), for a distribution icon; absent when unknown and on older daemons. */ osId?: string; /** os-release `ID_LIKE` ("rhel", "fedora"), fallback for the icon; absent when empty. */ osIdLike?: string[]; /** How the daemon itself runs (DAEMON_INSTALL_KINDS); absent when unknown and on older daemons. */ installKind?: DaemonInstallKind; /** COMPUTER_MIGRATED_FROM: on the first ready to each server after Raft Desktop moved this Computer from its embedded one; absent otherwise and on older daemons. */ migratedFrom?: ComputerMigratedFrom; /** Whether an executable `node` is on the daemon's PATH (no path is sent); absent on older daemons. */ nodeOnPath?: boolean; daemonVersion?: string; computerVersion?: string; migrationTransport?: AgentMigrationTransportReady; lifecycleAcks?: ComputerLifecycleExecutionAck[]; lastUpgradeReceipt?: ComputerLastUpgradeReceipt; /** #proj-raft-computer task #38: this machine's CURRENT `sk_machine_*` key was found in a legacy file inside an agent workspace (removed since), so an agent may have read it. Fingerprint = first 16 hex of sha256(key), never the key; the server keeps it only while it is still the stored key. Absent on older daemons and when nothing was found. */ legacyCredentialExposure?: LegacyCredentialExposureReport; /** #proj-raft-computer task #34: advisory, the installer state looks like it needs a repair run on the machine (COMPUTER_INSTALLER_REPAIR_HINT_REASONS); never blocks a web upgrade. Absent when there is nothing to hint and on older Computers. */ installerRepairHint?: ComputerInstallerRepairHint ; /** #wg-rbac:#27: with DAEMON_CAPABILITY_RUNNER_CREDENTIAL_RECONCILE_V1 (always then, possibly empty), the runner credential ids (`AgentConfig.agentCredentialId`) the daemon holds as it builds this frame; read it through `readyRunnerCredentialIds`. Absent on older daemons. */ runnerCredentialIds?: string[]; /** Reconciler step 11d: with DAEMON_CAPABILITY_AGENT_CONFIG_PUSH, the highest config revision the daemon applied (`agent:config` `revision` or `agent:start` `configRevision`) for each agent in `runningAgents` whose revision it knows; the server re-sends the agent's config when its own revision is newer (a push lost on the way). An agent without an entry is not compared. Absent on older daemons. */ runningAgentConfigRevisions?: Record<string, number> };

export type MachineShutdownReason =
  | "computer_stop"
  | "daemon_stop"
  | "unknown";

export interface AgentRuntimeContext {
  /** The agent process receiving this context. */
  agentId?: string | null;
  /** Server/org context this launch is serving. */
  serverId?: string | null;
  /** Server-side machine UUID that owns this launch. */
  machineId?: string | null;
  /** Human-readable machine name from Slock. */
  machineName?: string | null;
  /** Human-authored machine description from Slock, when set. */
  machineDescription?: string | null;
  /** Daemon-reported host name, when known. */
  machineHostname?: string | null;
  /** Daemon-reported OS/platform, when known. */
  machineOs?: string | null;
  /** Connected daemon version, when known. */
  daemonVersion?: string | null;
  /** Local workspace path for this agent process, filled by the daemon. */
  workspacePath?: string | null;
}

export const RUNTIME_CONFIG_VERSION = 1 as const;

export type RuntimeId =
  | "builtin"
  | "claude"
  | "codex"
  | "grok"
  | "antigravity"
  | "kimi-sdk"
  | "kimi"
  | "copilot"
  | "cursor"
  | "gemini"
  | "opencode"
  | "pi"
  | "qwen"
  | "qoder"
  | "codebuddy"
  | "external";

/**
 * Claude Code runtime provider config.
 *
 * `apiKey` is intentionally still a plaintext persisted field in the current
 * runtime-config capability. This is a known gap, not a managed-secret or
 * SecretRef contract.
 */
export type ClaudeRuntimeProviderConfig = // Runtime-scoped; provider kinds from other runtime arms fail closed.
  | { kind: "default" }
  | { kind: "custom"; apiUrl: string; apiKey: string; authType?: ClaudeCustomProviderAuthType };

/**
 * How a Claude custom provider sends `apiKey`: `api_key` (absent too) as
 * ANTHROPIC_API_KEY (`x-api-key`), `auth_token` as ANTHROPIC_AUTH_TOKEN
 * (`Authorization: Bearer`). The key stays in `apiKey` either way, so a
 * Computer that predates this field still sees a complete custom provider and
 * isolates it; it just sends the key as `x-api-key`.
 */
export type ClaudeCustomProviderAuthType = "api_key" | "auth_token";

export function claudeCustomProviderAuthEnvKey(authType: ClaudeCustomProviderAuthType | undefined): "ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN" {
  return authType === "auth_token" ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY";
}

/**
 * Pi runtime provider config.
 *
 * `apiKey` is intentionally still a plaintext persisted field in the current
 * runtime-config capability. This is a known gap, not a managed-secret or
 * SecretRef contract.
 */
export type PiRuntimeProviderConfig = // Runtime-scoped; provider kinds from other runtime arms fail closed.
  | { kind: "default" }
  // Pi runtime built-in provider with a web-supplied API key. Maps to the
  // env var that the Pi SDK reads for that provider (see
  // PI_BUILTIN_PROVIDER_ENV_KEYS) so no auth.json mutation is needed.
  | { kind: "pi-builtin"; providerId: string; apiKey: string };

/**
 * Built-in / Quick Start provider config.
 *
 * `apiKey` is intentionally still a plaintext persisted field in the current
 * runtime-config capability. This is a known gap, not a managed-secret,
 * secret-store, or SecretRef contract.
 */
export type BuiltInRuntimeProviderConfig =
  | {
      /** Server-managed credential reference; contains no provider secret. */
      kind: "connection";
      connectionId: string;
    }
  | {
      kind: "preset";
      providerId: BuiltInRuntimeProviderId;
      apiKey: string;
    }
  | {
      kind: "gateway";
      providerId: BuiltInRuntimeGatewayProviderId;
      baseUrl: string;
      apiKey: string;
      /**
       * Operator-declared capability for a custom gateway model. Omission is
       * migration-compatible and has the same conservative meaning as false.
       */
      supportsImageInput?: boolean;
    };

export const BUILTIN_RUNTIME_PROVIDER_ENV_KEYS = PI_BUILTIN_PROVIDER_API_KEY_ENV_KEYS_GENERATED;
export type BuiltInRuntimeProviderId = keyof typeof BUILTIN_RUNTIME_PROVIDER_ENV_KEYS;

export const BUILTIN_RUNTIME_PROVIDERS = Object.entries(BUILTIN_RUNTIME_PROVIDER_ENV_KEYS).map(([id, envKey]) => ({ id, envKey })) as
  ReadonlyArray<{ id: BuiltInRuntimeProviderId; envKey: typeof BUILTIN_RUNTIME_PROVIDER_ENV_KEYS[BuiltInRuntimeProviderId] }>;

export const PI_BUILTIN_PROVIDER_ENV_KEYS: Record<string, string> = {
  deepseek: BUILTIN_RUNTIME_PROVIDER_ENV_KEYS.deepseek,
};

export const BUILTIN_RUNTIME_PROVIDER_BLOCKED_HOST_ENV_KEYS = Array.from(new Set(
  Object.values(PI_BUILTIN_PROVIDER_BLOCKED_HOST_ENV_KEYS_GENERATED).flat(),
)) as readonly string[];

export const BUILTIN_RUNTIME_GATEWAY_PROVIDERS = [
  { id: "openai-compatible", envKey: "OPENAI_API_KEY", baseUrlEnvKey: "OPENAI_BASE_URL" },
  { id: "anthropic-compatible", envKey: "ANTHROPIC_API_KEY", baseUrlEnvKey: "ANTHROPIC_BASE_URL" },
] as const;

export type BuiltInRuntimeGatewayProviderId = typeof BUILTIN_RUNTIME_GATEWAY_PROVIDERS[number]["id"];
export type BuiltInRuntimeAnyProviderId = BuiltInRuntimeProviderId | BuiltInRuntimeGatewayProviderId;

export const BUILTIN_RUNTIME_GATEWAY_PROVIDER_ENV_KEYS: Record<BuiltInRuntimeGatewayProviderId, string> =
  Object.fromEntries(BUILTIN_RUNTIME_GATEWAY_PROVIDERS.map((provider) => [provider.id, provider.envKey])) as Record<BuiltInRuntimeGatewayProviderId, string>;

export const BUILTIN_RUNTIME_GATEWAY_PROVIDER_BASE_URL_ENV_KEYS: Record<BuiltInRuntimeGatewayProviderId, string> =
  Object.fromEntries(BUILTIN_RUNTIME_GATEWAY_PROVIDERS.map((provider) => [provider.id, provider.baseUrlEnvKey])) as Record<BuiltInRuntimeGatewayProviderId, string>;

export const BUILTIN_RUNTIME_CONTROLLED_ENV_KEYS = Array.from(new Set([
  ...Object.values(BUILTIN_RUNTIME_PROVIDER_ENV_KEYS),
  ...Object.values(BUILTIN_RUNTIME_GATEWAY_PROVIDER_ENV_KEYS),
  ...Object.values(BUILTIN_RUNTIME_GATEWAY_PROVIDER_BASE_URL_ENV_KEYS),
])) as readonly string[];

export const BUILTIN_RUNTIME_HOST_PROVIDER_ENV_SCRUB_KEYS = Array.from(new Set([
  ...BUILTIN_RUNTIME_CONTROLLED_ENV_KEYS,
  ...BUILTIN_RUNTIME_PROVIDER_BLOCKED_HOST_ENV_KEYS,
])) as readonly string[];

/**
 * Per-provider model list shown when the user picks a Pi builtin provider in
 * the create-agent UI. Sourced from `piBuiltinModels.generated.ts` which is
 * auto-generated from `@earendil-works/pi-ai`'s `getModels(provider)` (run
 * `pnpm --filter @botiverse/raft-daemon generate:pi-builtin-models`).
 *
 * Model `id` is the full Pi-style `<provider>/<model>` string so it composes
 * with the existing model-label rendering in detectPiModelsFromRegistry.
 * Entries are sorted by the generator's newer/stronger-first heuristic; the
 * provider default is emitted separately in `PI_BUILTIN_PROVIDER_DEFAULT_MODELS`
 * so display order does not become default authority.
 *
 * The generator is locked in as the source of truth: a CI gate
 * (`pnpm --filter @botiverse/raft-daemon check:pi-builtin-models-fresh`)
 * regenerates and fails on any diff, so we can't drift from the SDK.
 */
export const PI_BUILTIN_PROVIDER_MODELS = PI_BUILTIN_PROVIDER_MODELS_GENERATED;
export const PI_BUILTIN_PROVIDER_DEFAULT_MODELS = PI_BUILTIN_PROVIDER_DEFAULT_MODELS_GENERATED;
export const PI_BUILTIN_PROVIDER_CONNECTION_PROBES = PI_BUILTIN_PROVIDER_CONNECTION_PROBES_GENERATED;

export type RuntimeModelConfig =
  | { kind: "preset"; id: string }
  | {
      kind: "custom";
      name: string;
      /**
       * #proj-runtime:#50: operator-declared limits for a Built-in custom
       * gateway model, in tokens. Set: the daemon registers the model with it
       * (source `agent_config`) instead of a catalog value or Raft's default.
       * Absent: as before. Only the `builtin` runtime accepts them.
       */
      contextWindow?: number;
      maxOutputTokens?: number;
    };

/** #proj-runtime:#50: bounds for a custom model's declared limits, in tokens. */
export const CUSTOM_MODEL_CONTEXT_WINDOW_MAX = 10_000_000;
export const CUSTOM_MODEL_MAX_OUTPUT_TOKENS_MAX = 1_000_000;

export type RuntimeModeConfig =
  | { kind: "default" }
  | { kind: "fast" };

interface RuntimeConfigBase { // Persisted source fields; launch/env mirrors are derived, not parsed back.
  version: typeof RUNTIME_CONFIG_VERSION;
  model: RuntimeModelConfig;
  mode: RuntimeModeConfig;
  reasoningEffort?: RuntimeReasoningEffort | null;
  envVars?: Record<string, string> | null;
}

export type ClaudeRuntimeConfig = RuntimeConfigBase & {
  runtime: "claude";
  provider?: ClaudeRuntimeProviderConfig;
  command?: string | null;
};

export type PiRuntimeConfig = RuntimeConfigBase & {
  runtime: "pi";
  provider?: PiRuntimeProviderConfig;
  command?: never;
};

export type BuiltInRuntimeConfig = RuntimeConfigBase & {
  runtime: "builtin";
  provider: BuiltInRuntimeProviderConfig;
  hostUserState: "forbidden";
  /** Opt in to extensions installed in the host Pi agent directory. */
  loadLocalPlugins?: boolean;
  command?: never;
};

export type ProviderlessRuntimeId = Exclude<RuntimeId, "builtin" | "claude" | "pi">; // Providerless in v1.

export type ProviderlessRuntimeConfig = RuntimeConfigBase & {
  runtime: ProviderlessRuntimeId;
  provider?: never; // Reject accidental provider payloads instead of silently ignoring them.
  command?: never;
};

export type RuntimeConfig = // Persisted source of truth; validate before deriving LaunchPlan/env.
  | BuiltInRuntimeConfig
  | ClaudeRuntimeConfig
  | PiRuntimeConfig
  | ProviderlessRuntimeConfig;

export interface AgentConfig {
  name: string;
  displayName: string | null;
  description: string | null;
  model: string;
  runtime: string;
  runtimeConfig?: RuntimeConfig | null;
  /** Ephemeral, credential-free metadata for a server-managed provider launch. */
  providerConnection?: ProviderConnectionLaunchProjection | null;
  /**
   * Reconciler step 11: the revision of the server-managed provider
   * connection the launch resolves (its endpoint or key changed). A running
   * session whose revision differs is restarted once idle; absent on either
   * side (an older server) compares as no change.
   */
  providerConnectionRevision?: string | number | null;
  /**
   * task #1357 item 1: the server's revision of this config (`agent:start`
   * `configRevision`, `agent:config` `revision`), stamped by the daemon when
   * it takes the config so it travels with every copy of it; a Pi session
   * reports the revision of the config it was built from. Servers do not send
   * it; absent when the server named no revision.
   */
  configRevision?: number;
  /**
   * Reconciler step 11: an opaque fingerprint of the agent's managed MCP
   * servers as a launch configures them. A running session whose fingerprint
   * differs is restarted once idle; absent on either side (an older server)
   * compares as no change.
   */
  managedMcpFingerprint?: string | null;
  reasoningEffort: RuntimeReasoningEffort | null;
  executionMode?: "byoc" | "cloud" | string | null;
  /**
   * RFC 060: which daemon host runs this launch. Absent or null: the daemon's
   * own runtime driver. `"oar"`: the daemon's OAR host, where it can run the
   * launch (it falls back to the driver otherwise). Set by the server only for
   * a daemon that advertises `DAEMON_CAPABILITY_RUNTIME_HOST_OAR` and only
   * while the Server's flag for the agent's runtime is on; evaluated per
   * start, so a flag change takes effect at the next start.
   */
  runtimeHost?: "oar" | null;
  envVars: Record<string, string> | null;
  sessionId: string | null;
  serverUrl: string;
  authToken: string;
  /**
   * Optional per-agent `sk_agent_*` credential — the bearer for the
   * `/internal/agent-api/*` surface where the acting agent is read from the
   * credential row, not a `:id` path param.
   *
   * Authority is the shared credential RFC (post-split — see
   * `#wg-raft-computer:0de1186e` discussion; pre-split equivalent is the
   * §3 credential isolation + §5 auth axis sections of the Computer RFC
   * v8.3.x). This docstring intentionally avoids naming a specific RFC
   * filename so the runner credential code does not need to follow doc
   * renames; cross-refs land in the contract index (task #9 follow-up).
   *
   * Server session worker runner credential contract:
   *   - The daemon stores this value in process memory and exposes a local
   *     proxy affordance to the `slock` wrapper (see `prepareCliTransport`).
   *   - The raw key, or any file pointer to it, MUST NOT be present in the
   *     spawned runtime env, workspace files, or CLI args. The
   *     local `slock` wrapper points short-lived CLI subprocesses at a
   *     launch-scoped local proxy; same-uid shells are contained by proxy
   *     capability enforcement and launch cleanup, not by file permissions.
   *   - The Computer's own key never stands in for it, in a file, env var
   *     or wrapper the runtime can read. The daemon mints this key for every
   *     launch or fails the start (`runner_credential_mint_failed`).
   *   - The daemon host process itself MUST NOT outbound-call
   *     `/internal/agent-api/*` with this credential — only the spawned
   *     runner (via the `slock` CLI wrapper) can use the local proxy. This
   *     isolates the agent-self surface to the runner's process boundary.
   *
   * Servers do not send it: the Computer (sk_computer_*) mints one for each
   * launch before the runtime starts.
   */
  agentCredentialKey?: string | null;
  /**
   * Server-side credential row id for a managed-runner credential minted for
   * this launch. Present only for daemon-managed runner credentials so the
   * server session worker can revoke the row when the launch ends.
   */
  agentCredentialId?: string | null;
  runtimeContext?: AgentRuntimeContext | null;
  /**
   * Spawn-time runtime-profile control. Server attaches this on
   * `agent:start` when the agent has a pending release notice that must be
   * surfaced before any inbox processing. Legacy migration controls may still
   * appear from older deployments, but runtime switches now reset the session
   * automatically; daemons acknowledge those legacy controls as no-ops instead
   * of surfacing them to the runtime — see
   * `agentRuntimeProfileService.getPendingRuntimeProfileControl()`.
   *
   * This is the spawn-time twin of the message-shaped runtime-profile
   * notification (the inbox path). Spawn-time can't deliver via stdin
   * because the agent process doesn't exist yet, so the control rides
   * along as a config field; once alive, the same control class is
   * delivered through the message pipeline (`agent:deliver` carrying
   * a `runtime_profile_*` message_id prefix) and wrapped by
   * `formatRuntimeProfileControlPrompt` instead.
   *
   * - `kind`    — `"daemon_release_notice"` for current deployments. `"migration"`
   *               is retained only as a legacy wire value; current daemons
   *               complete it without prompt/tool involvement.
   * - `key`     — opaque server-issued identifier. The daemon auto-acks on
   *               injection; agents never need to send it.
   * - `message` — fully rendered body the agent reads.
   */
  runtimeProfileControl?: {
    kind: AgentRuntimeProfilePendingKind;
    key: string;
    message: string;
  } | null;
  /**
   * RFC 070 constructed wake context (at-wake session recycling with a
   * constructed briefing, the cold-idle sweep, and the startup MEMORY.md
   * block). Formerly the server-evaluated `constructed_wake_context` feature
   * flag, retired on 2026-10-23.
   *
   * Always true from current servers; kept for older daemons; do not remove
   * until no supported daemon reads it. Older daemons treat absent or false as
   * off. Current daemons ignore the field: the behavior is always on, and the
   * local `RAFT_WAKE_RECYCLE=0` / `RAFT_STARTUP_MEMORY_BLOCK=0` env vars remain
   * the per-machine (or per-agent) off switches.
   */
  constructedWakeContext?: boolean;
  /**
   * Server-evaluated `subagent_delegation_prompt` feature flag. When true, a
   * daemon driver that declares sub-agent support adds the "Working through
   * sub-agents" section to the standing prompt. Absent or false means off;
   * older servers never send it, and drivers without sub-agent support ignore
   * it, so the prompt stays byte-identical to the ungated one.
   */
  subagentDelegation?: boolean;
  /**
   * Server-evaluated `agent_context_view_v0` feature flag (View Context v0).
   * When true, a daemon that advertises the context-view capability keeps
   * the per-agent send index and captured requests and answers context view
   * requests. Absent or false means off: it stops writing and answering at
   * once, keeps what it wrote, and removes it only after 24 hours continuously
   * off (turning it back on within that time resumes). Older servers never send it.
   */
  agentContextView?: boolean;
  /**
   * Server-evaluated `agent_inbox_items_v0` feature flag (RFC 081 inbox
   * items). When true, the server lists inbox items (`inbox check` rows) and
   * answers `inbox read` / `inbox dismiss`, so the daemon's wake-up notice and
   * the system prompt may teach `raft inbox read --target <item>`. Absent or
   * false means off (an evaluation failure too): keep teaching the
   * conversation-only list. Older servers never send it.
   */
  inboxItems?: boolean;
  /**
   * RFC 081: when inbox items launched on this deployment
   * (`RAFT_INBOX_ITEMS_LAUNCH_AT`), as an ISO 8601 time
   * (`Date.prototype.toISOString`). Present only when `inboxItems` is true,
   * absent (never null) otherwise; sent wherever `inboxItems` is
   * (`agent:start`, `server:features`). Reminders fired from this time on are
   * inbox items; older ones stay on the old path (D9, D16). App events may be
   * items from earlier (the server's RAFT_INBOX_ITEMS_APP_EVENTS_FROM): each
   * pushed one says so itself (`third_party_event.inbox_item_target`).
   * Older servers never send it; a reader that finds it absent or not a time
   * cannot tell pre- from post-launch fires.
   */
  inboxItemsLaunchAt?: string;
  /**
   * Server-evaluated `passive_ax` feature flag (RFC 072 §7, the passive AX
   * "peripheral vision": command-guidance holds and context-scoped thread
   * evidence). Absent or false means off; older servers never send it. The
   * daemon composes it with the local `RAFT_PASSIVE_AX=0` kill switch (which
   * cannot turn it on) and publishes the result in the context-generation
   * record the CLI reads; on the daemon's effective spawn config this field
   * already holds that composed value.
   */
  passiveAx?: boolean;
  /**
   * Server-evaluated `pi_session_rotation` feature flag (pi#10642: pi keeps a
   * session's compacted-away history in memory). When true, a pi or Built-in
   * runtime may rotate its session file after a compaction (same session id,
   * new file from the latest compaction). Absent or false means off; older
   * servers never send it, and other runtimes ignore it. The daemon's local
   * `RAFT_PI_SESSION_ROTATION=0` stays an off switch and cannot turn it on.
   */
  piSessionRotation?: boolean;
  /**
   * Server-evaluated `wake_recycle_oar` feature flag (#proj-runtime:#54,
   * RFC 070 for the OAR host). When true, the daemon's OAR host gives wake
   * recycle the context size and last activity of Codex and Grok sessions
   * from its session summary, and stops such a session once it is cold idle
   * (idle past the gap, context past the threshold, nothing open), so the
   * next wake starts a fresh session with a briefing instead of resuming the
   * whole context. Absent or false means off (today's behaviour); older
   * servers never send it and older daemons ignore it. The daemon's local
   * `RAFT_WAKE_RECYCLE=0` stays an off switch and cannot turn it on.
   */
  wakeRecycleOar?: boolean;
  /**
   * Server-evaluated `wake_recycle_tier_gate` feature flag (#proj-runtime:#54
   * phase 2, RFC 070). When true, wake recycle and the cold-idle stop gate on
   * the cache tier the session last wrote: a session whose last cache write
   * was the 5-minute tier counts as cold after the short gap (12 minutes by
   * default) instead of the hour, and once a session with a known tier is
   * past its gate the context floor is 64k instead of 128k. Sessions with no
   * known tier (Codex, Grok, Pi) keep today's thresholds. Absent or false
   * means off; older servers never send it and older daemons ignore it.
   */
  wakeRecycleTierGate?: boolean;
  /**
   * Server-evaluated `turn_end_compaction` feature flag (#proj-runtime:#54
   * phase 3). When true, an agent whose last model request carried more than
   * 250k tokens of context, on a model whose window is at least 400k, has its
   * runtime compact natively at a turn end with nothing running, held or
   * queued (Claude on the legacy host: `/compact`; Codex and Grok on the OAR
   * host: OAR `Session.compact()`). Absent or false means off; older servers
   * never send it and older daemons ignore it.
   */
  turnEndCompaction?: boolean;
  /**
   * Server-evaluated `wake_recycle_warm` feature flag (#proj-runtime:#54,
   * RFC 070 §6.5). When true, a session whose last model request carried more
   * than 250k tokens of context, on a model whose window is at least 400k, is
   * stopped at a clean turn end with nothing running, held or queued (after
   * two quiet minutes; at once past 500k), and the next start gives it a
   * fresh session with a briefing whatever the gap. Only for runtimes whose
   * resume facts the daemon reads (Claude; Codex and Grok on the OAR host
   * while `wakeRecycleOar` is on). Absent or false means off; older servers
   * never send it and older daemons ignore it. The daemon's local
   * `RAFT_WAKE_RECYCLE=0` stays an off switch and cannot turn it on.
   */
  wakeRecycleWarm?: boolean;
  /**
   * Installed-app discovery catalog (task #319). The daemon renders these
   * entries into the agent's system prompt so the agent knows which apps
   * exist on this server and when to reach for them — before it has logged
   * in to any of them.
   *
   * Contract:
   *   - Server-scoped, not agent-scoped: `services` is identical for every
   *     agent on a server, so it rides `agent:start` config rather than
   *     being fetched per-agent (the host is forbidden from outbound-calling
   *     `/internal/agent-api/*` with `agentCredentialKey`).
   *   - Only enabled, user-managed apps are included, and only those with a
   *     non-empty `whenToUse` — an app with no hint contributes nothing to
   *     the prompt.
   *   - All three strings are already inert-rendered server-side; the
   *     daemon MUST NOT unescape or re-render reference tokens.
   *   - Snapshot semantics: the catalog reflects the moment of agent:start;
   *     apps installed/disabled mid-session appear on the NEXT launch. An
   *     agent needing a fresher view can run `raft integration list`.
   *   - Optional and absent on old servers; an absent or empty catalog
   *     degrades to the historical prompt (no apps section).
   */
  installedApps?: AgentInstalledAppCatalogEntry[] | null;
  /**
   * Server-evaluated `reminder_app` rollout flag. When true, the prompt's
   * Reminders section and command-list entry point at the Reminder app (found
   * in the installed-app list) instead of `raft reminder schedule`, which the
   * Server then refuses with `reminders_moved_to_app`. Absent or false means
   * off; older servers never send it, and older daemons ignore it and learn of
   * the move from that refusal.
   */
  reminderApp?: boolean;
  /**
   * Server-evaluated `vault_app` rollout flag. When true, the prompt's
   * Credential handling section tells the agent to request secrets through
   * the Vault app. Absent or false means off.
   */
  vaultApp?: boolean;
  /**
   * Server-evaluated `task_v2_conversations_v0` flag. When true, the prompt's
   * Tasks section teaches task conversations (`raft task reply/read/view`,
   * refs `#channel:#7`). Absent or false keeps the historical text.
   */
  taskConversations?: boolean;
  /**
   * The ids of the first-party apps (the Server's app registry, such as
   * `artifacts`) whose feature flag is on for this Server, in registry order.
   * The prompt adds each known app's command-list entry, in the guide's own
   * order; unknown ids are skipped. Sent by current Servers on every start,
   * empty when none is on; absent on older Servers, which renders the
   * historical text. The Reminder and Vault apps are installed integrations,
   * not first-party apps: `reminderApp` and `vaultApp` keep covering them.
   */
  enabledApps?: string[];
  /**
   * How close the agent's workspace is to a migration's size limits: the
   * limits, the last measurement (from the last successful move, or a newer
   * size failure) and that failure's largest paths. The daemon's idle
   * cleaner uses it to remind the agent to keep `.raftbackupignore` current.
   * Sent on every start (and config push) by current Servers; absent when
   * the Server could not read it, and on older Servers. Not part of the
   * runtime spec, so a change never restarts the agent; older daemons ignore it.
   */
  migrationReadiness?: import("./agentMigration").AgentMigrationReadiness;
}

/** One entry of {@link AgentConfig.installedApps} — the prompt-facing
 * app directory. `whenToUse` is always non-empty here (server filters). */
export interface AgentInstalledAppCatalogEntry {
  name: string;
  description: string | null;
  whenToUse: string;
  /** `raft integration invoke --service <id>` id (the app's client id). Absent on older servers. */
  service?: string;
}

export type ProfileVisibilityMembershipStatus = "active" | "left" | "removed";

export interface ProfileCreatedAgentSummary {
  id: string;
  name: string;
  displayName: string | null;
  avatarUrl: string | null;
  runtime: string;
  external?: boolean;
  status: AgentStatus;
}

export type ProfileCreatorSummary =
  | {
      type: "human";
      id: string;
      name: string;
      displayName: string | null;
      avatarUrl: string | null;
      /** @deprecated Always ""; kept for older clients (see DEPRECATED_GRAVATAR_HASH). */
      gravatarHash: string;
    }
  | {
      type: "agent";
      id: string;
      name: string;
      displayName: string | null;
      avatarUrl: string | null;
      deletedAt: string | null;
    };

export interface HumanProfileView {
  kind: "human";
  id: string;
  isSelf: boolean;
  name: string;
  displayName: string | null;
  description: string | null;
  avatarUrl: string | null;
  email: string | null;
  role: "owner" | "admin" | "member" | "guest" | null;
  joinedAt: string | null;
  membershipStatus: ProfileVisibilityMembershipStatus;
  createdAgents: ProfileCreatedAgentSummary[];
}

export interface AgentProfileView {
  kind: "agent";
  id: string;
  isSelf: boolean;
  name: string;
  displayName: string | null;
  description: string | null;
  avatarUrl: string | null;
  status: AgentStatus;
  serverRole: "owner" | "admin" | "member" | null;
  runtime: string;
  external?: boolean;
  model: string;
  runtimeConfig?: RuntimeConfig | null;
  lastRuntimeError?: AgentRuntimeErrorState | null;
  reasoningEffort: ReasoningEffort | null;
  executionMode: "byoc" | "cloud" | string | null;
  computerId: string | null;
  computerName: string | null;
  computerHostname: string | null;
  daemonVersion: string | null;
  creator: ProfileCreatorSummary | null;
  createdAgents: ProfileCreatedAgentSummary[];
  createdAt: string;
  deletedAt: string | null;
}

export type ProfileView = HumanProfileView | AgentProfileView;

export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string;
  isHidden?: boolean;
  /**
   * A symbolic link. The workspace viewer never follows one: it is listed
   * with `isDirectory: false` and `size: 0`, its target is never sent, and
   * reading it answers like a missing file. Older clients that ignore this
   * flag show it as a file that fails to open.
   */
  isSymlink?: boolean;
  children?: FileNode[];
}

/** Summary info for a single agent workspace directory on a machine */
export interface WorkspaceDirectoryInfo {
  /** Directory name (= agentId UUID) */
  directoryName: string;
  /** Total size in bytes of all files */
  totalSizeBytes: number;
  /** Most recent modification time */
  lastModified: string;
  /** Number of top-level files */
  fileCount: number;
  /**
   * Where the workspace is on the machine, `~`-relative when under the user's
   * home (e.g. `~/.raft/agents/<id>/`). Absent from daemons before 1.0.46,
   * which only ever used `~/.slock/agents/`.
   */
  displayPath?: string;
}

/** A Claude Code skill (slash command) from SKILL.md */
export interface SkillInfo {
  /** Skill directory name */
  name: string;
  /** Display name from SKILL.md frontmatter */
  displayName: string;
  /** Description from SKILL.md frontmatter */
  description: string;
  /** Whether the skill is user-invocable */
  userInvocable: boolean;
  /** Source directory path where this skill was found */
  sourcePath?: string;
}

// Agent activity states. Single source of truth: the literal tuple derives the
// type, the runtime guard, and the legacy VALID_ACTIVITIES set, so they can
// never drift apart.
export const AGENT_ACTIVITIES = ["online", "thinking", "working", "error", "offline"] as const;
export type AgentActivity = (typeof AGENT_ACTIVITIES)[number];
export type AgentActivityKind = AgentActivity;
export const isAgentActivity = makeIsMember(AGENT_ACTIVITIES);
export const isAgentActivityKind = isAgentActivity;

export const AGENT_ACTIVITY_DETAIL_KINDS = [
  "none",
  "message_received",
  "freshness_hold",
  "starting",
  "runtime_starting",
  "idle",
  "running_command",
  "checking_messages",
  "compacting_context",
  "compaction_finished",
  "compaction_stale",
  "reviewing_changes",
  "review_finished",
  "review_stale",
  "runtime_reconnecting",
  "runtime_error",
  "runtime_crashed",
  /** task #1346: known Claude root/sudo startup refusal; crash semantics. */
  "claude_root_privileges",
  "runtime_unavailable",
  "runtime_stalled",
  /**
   * task #1116 — the daemon wrote stdin deliveries to a live process and no
   * model-driven runtime event followed for a whole episode (see
   * DeliveryConsumptionActivityDiagnostic). Observation only.
   */
  "delivery_unconsumed",
  /**
   * task #1119 — the server paused automatic wakes for this agent after
   * consecutive early exits (see WakeCrashLoopActivityDiagnostic). Only a
   * human start lifts it.
   */
  "wake_crash_loop_blocked",
  /**
   * RFC 071 §9 — the server's terminal-failure breaker stopped automatic
   * wakes for this agent: paused until a time after repeated terminal runtime
   * failures, or a manual start is needed. The server-authored detail says
   * which. A manual start lifts it.
   */
  "terminal_failure_paused",
  "stalled_recovery",
  "stopped",
  "ready",
  "runtime_interrupted",
  "machine_disconnected",
  "computer_started",
  "computer_restarted",
  "computer_upgraded",
  "computer_operation_failed",
  "daemon_activity",
  "external_activity",
  "synthetic_repair",
  "slock_action",
  "system_message",
  // Generic structured runtime-progress heartbeat (Claude --include-partial-messages
  // stream events / system status) — a "working" liveness signal with no rendered
  // content. NOT a subagent. (APM 1.6 6a)
  "runtime_progress",
  // Passive provider HTTP observation; not model progress or lifecycle authority.
  "provider_request_status",
  // Strong daemon execution-boundary events. These are intentionally distinct
  // from heartbeat/display rows so the server reducer can derive live activity
  // and elapsed/error transitions without parsing text or trajectory entries.
  "model_request_started",
  "model_response_started",
  "tool_started",
  "tool_end",
  "thinking_started",
  "thinking_end",
  // A subagent (Claude `Agent` tool) lifecycle/activity row, marked from explicit
  // parent_tool_use_id / task-lifecycle lineage — never inferred from display text.
  // (APM 1.6 6b)
  "subagent_activity",
  "other",
] as const;
export type AgentActivityDetailKind = (typeof AGENT_ACTIVITY_DETAIL_KINDS)[number];
export const isAgentActivityDetailKind = makeIsMember(AGENT_ACTIVITY_DETAIL_KINDS);
export type AgentStatus = "active" | "inactive" | "stopped";
export interface AgentRuntimeErrorState {
  /**
   * #wg-rbac:#57: scrubbed and capped (boundedRuntimeErrorDetail) on every
   * outbound path. A viewer who is not the agent's manager reads the code's
   * fixed sentence or GENERIC_RUNTIME_ERROR_MESSAGE here, never the error.
   */
  message: string;
  /**
   * #wg-rbac:#57: the common-case code (RUNTIME_ERROR_CODES), set by the
   * server on every outbound projection for every viewer. Absent: no code
   * applies (or a stored row read without projection).
   */
  code?: import("./runtimeErrorVisibility").RuntimeErrorCode;
  at: string;
  launchId?: string | null;
  actionRequired: boolean;
  /** #688(c): typed diagnostic tuple durable with the crash state. Absent for
   * untyped/legacy error authority (stays null), present only when a valid typed
   * RuntimeErrorActivityDiagnostic carrier established the authority. */
  errorClass?: RuntimeErrorClass;
  errorReason?: RuntimeErrorReason;
  fingerprint?: string;
  reasonProvenance?: RuntimeErrorReasonProvenance;
  /**
   * #proj-raft-computer:#48: the typed carrier's `requiredAction`, kept so the
   * web can tell what the owner must do. Absent for errors that need no
   * action, errors stored before this field, and daemons older than it.
   */
  requiredAction?: RuntimeErrorRequiredAction;
  /**
   * task #1351: one stored occurrence of this error (server-generated uuid),
   * so a clear can name the exact error it judged (compare-and-clear).
   * Absent on records stored before it.
   */
  occurrenceId?: string;
  /**
   * task #1351: the daemon process and its per-agent sequence of the activity
   * frame that set this error; with `launchId`, the domain in which a later
   * frame's clientSeq proves it came after. Absent on older daemons/records.
   */
  daemonInstanceId?: string;
  clientSeq?: number;
  /**
   * task #1351: a launch the server armed for a start while this record was
   * stored, so after it. Bound to this record: any newer error replaces the
   * record without it.
   */
  recoveryLaunchId?: string;
}

export const VALID_ACTIVITIES = new Set<AgentActivityKind>(AGENT_ACTIVITIES);

// Runtime catalog (RuntimeInfo, RUNTIMES, display names, external runtime): its own
// dependency-light module so SDK bundles can render runtime labels without this index.
export * from "./runtimeCatalog";

// ── Agent Trajectory ──

export * from "./externalAgentActivity";

export * from "./agentStatusStandard";

export type ExternalAgentActivityHookEventName =
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PostToolBatch"
  | "UserPromptSubmit"
  | "Stop"
  | "SessionStart"
  | "SessionEnd"
  // A subagent of this agent started / finished; only with the `subagent` marker.
  | "SubagentStart"
  | "SubagentStop"
  | (string & {});

export interface ExternalAgentActivityEvent {
  schema?: typeof EXTERNAL_AGENT_ACTIVITY_EVENT_SCHEMA | string;
  eventId?: string;
  event_id?: string;
  sessionId?: string;
  session_id?: string;
  hookEventName?: ExternalAgentActivityHookEventName;
  hook_event_name?: ExternalAgentActivityHookEventName;
  toolName?: string;
  tool_name?: string;
  /**
   * raft-agent-status.v1 agent status after this event (`online` idle/ready,
   * `thinking`, `working`, `error`, `offline`). Legacy hook-outcome values
   * (`started`/`succeeded`/`failed`/`completed`) are accepted and ignored for
   * status. An event may carry `status` without `hookEventName`.
   */
  status?: RaftAgentStatus | (typeof EXTERNAL_AGENT_ACTIVITY_LEGACY_STATUS_VALUES)[number];
  /** Optional one-line human detail for `status` (at most 200 characters). */
  detail?: string;
  occurredAt?: string;
  occurred_at?: string;
  durationMs?: number;
  duration_ms?: number;
  /** Tool call id (Claude Code `tool_use_id`); recorded as `callId` on the tool rows. */
  toolUseId?: string;
  tool_use_id?: string;
  /** Exit code of a command the tool ran; independent of `ok`. */
  exitCode?: number;
  exit_code?: number;
  /**
   * The event belongs to a subagent of this agent, not to the agent itself
   * (same marker as `SubagentLineage`). Such events are recorded in the
   * activity log under the subagent and never change the agent's status or
   * end its turn. Ids and enums only.
   */
  subagent?: SubagentLineage["subagent"];
  /** Whether the tool call itself succeeded. `null` = unknown (no `ok` recorded); absent = inferred from the hook name. */
  ok?: boolean | null;
  errorClass?: string;
  error_class?: string;
  toolInput?: unknown;
  tool_input?: unknown;
  toolOutput?: unknown;
  tool_output?: unknown;
  toolInputTruncated?: boolean;
  tool_input_truncated?: boolean;
  toolOutputTruncated?: boolean;
  tool_output_truncated?: boolean;
  truncated?: boolean;
}

export interface ExternalAgentActivityDrainResponse {
  schema: typeof EXTERNAL_AGENT_ACTIVITY_DRAIN_SCHEMA;
  events: ExternalAgentActivityEvent[];
  dropped?: number;
}

export interface ExternalAgentActivityIngestRequest {
  schema: typeof EXTERNAL_AGENT_ACTIVITY_INGEST_SCHEMA;
  coreSessionId?: string;
  adapterInstance?: string;
  events: ExternalAgentActivityEvent[];
  dropped?: number;
  /**
   * The turn ended. `snapshotId`: from this turn's `inbox.list`; `outcome`:
   * `completed` only for a natural end (not interrupted, timed out or failed);
   * `shownUnreadTargets`: the listed targets the model was shown. On
   * `completed` the Server marks read the ones the agent owes nothing in, up to
   * the snapshot's seqs, never past what that snapshot recorded.
   */
  turnEnded?: ExternalAgentTurnEnded;
}

export interface ExternalAgentTurnEnded {
  snapshotId: string;
  outcome: AgentTurnEndedOutcome;
  shownUnreadTargets: string[];
}

export interface TrajectoryProducerLineage {
  /**
   * Optional producer-fact lineage for entries derived from an APM or lifecycle
   * decision. Consumers must treat this as a join key only, not user content.
   */
  producerFactId?: string;
}

/**
 * Structured subagent lineage carried by trajectory entries that belong to a
 * Claude subagent (the `Agent` tool). Presence of this marker is the ONLY signal
 * that an entry is subagent-scoped — subagent-ness must never be inferred from
 * display text (APM 1.6 6b). Every field is a closed id / bounded token, never
 * raw prompt or raw output (Q8/provenance discipline). Consumers group
 * lineage-bearing rows under a subagent; rows without this marker stay flat and
 * must never render an empty subagent card.
 */
export interface SubagentLineage {
  subagent?: {
    /** Outer `Agent` tool_use id that owns this subagent turn. */
    parentToolUseId?: string;
    /** Declared subagent role (e.g. "Explore"), a bounded label, never content. */
    subagentType?: string;
    /** Claude `system` task-lifecycle envelope id (task_started/task_progress/…). */
    taskId?: string;
    /**
     * Bounded lifecycle phase of the subagent, from the `system` envelope kind.
     * `ended`: the subagent finished (hosted agents' `send_to_agent`), with
     * `outcome` and `reportChars`.
     */
    phase?: SubagentPhase;
    /**
     * How the subagent finished: with `phase: "ended"`, and with a
     * `notification` that carries a terminal status (Claude and Codex
     * subagents, daemons from #proj-runtime:#41 on).
     */
    outcome?: SubagentOutcome;
    /** Only with `phase: "ended"`: length of the subagent's report in characters (JS string length; never the report). */
    reportChars?: number;
  };
}

export const SUBAGENT_PHASES = ["started", "progress", "notification", "active", "ended"] as const;
export type SubagentPhase = (typeof SUBAGENT_PHASES)[number];
/** `ceiling`: stopped by a limit (turns, time or budget), not by the subagent itself. */
export const SUBAGENT_OUTCOMES = ["done", "failed", "stopped", "ceiling"] as const;
export type SubagentOutcome = (typeof SUBAGENT_OUTCOMES)[number];

/** Bounded runtime facts; never provider text, summaries, or prompt contents. */
export interface RuntimeCompactionInterruption {
  outcome: "compaction_failed_or_exhausted" | "aborted" | "unknown";
  reason: "manual" | "threshold" | "overflow" | "unknown";
  failureReason?: "recovery_exhausted" | "input_too_large" | "compaction_failed" | "unknown";
  willRetry: boolean | "unknown";
  /** Safe diagnostic projected from this exact compaction_end event. */
  failureDiagnostic?: RuntimeErrorActivityDiagnostic;
}

/** A single entry in the agent's trajectory log — rich activity data from stream-json */
/**
 * What a runtime reported when one tool call finished, carried on the
 * "Tool finished" status entry (`detailKind: "tool_end"`). Every field is
 * optional: a runtime that does not report a value leaves it out, and it
 * reads as unknown, never as success.
 */
export type ExternalHookTurnBoundary = "turn_start" | "turn_end" | "session_end";

export interface ToolCallOutcome {
  /** The runtime's id for the call; the matching `tool_start` entry carries the same `callId`. */
  callId?: string;
  /**
   * Whether the tool call itself succeeded. A command that ran and exited
   * non-zero is still `ok: true`; see `exitCode`.
   */
  ok?: boolean;
  /** Time from the call's start to its end in ms, measured by the daemon or reported by the runtime. */
  durationMs?: number;
  /** Exit status of the command the tool ran, as reported. Independent of `ok`. */
  exitCode?: number;
}

export type TrajectoryEntry =
  | ({ kind: "thinking"; text: string } & TrajectoryProducerLineage & SubagentLineage)
  | ({ kind: "tool_start"; toolName: string; toolInput: string; callId?: string } & TrajectoryProducerLineage & SubagentLineage)
  | ({ kind: "text"; text: string } & TrajectoryProducerLineage & SubagentLineage)
  // Durable history of an agent-visible action performed through Slock itself
  // (send / claim / reminder / profile update, etc.). This is not a live-status
  // subtitle, and it must not carry agent-facing recovery instructions.
  | ({ kind: "slock_action"; title: string; text: string } & TrajectoryProducerLineage)
  | ({ kind: "system"; title: string; text: string } & TrajectoryProducerLineage & SubagentLineage)
  | ({ kind: "compaction_started" } & TrajectoryProducerLineage)
  | ({ kind: "compaction_finished" } & TrajectoryProducerLineage)
  | ({
      kind: "status";
      activity: AgentActivityKind;
      activityKind?: AgentActivityKind;
      detail: string;
      detailKind?: AgentActivityDetailKind;
      compaction?: RuntimeCompactionInterruption;
      tool?: ToolCallOutcome;
      /**
       * A hook turn boundary (UserPromptSubmit / Stop / SessionEnd) stored for
       * an agent that reports its own status, where the hook-derived status is
       * not the agent's state (task #17 turn summaries read it).
       */
      hookBoundary?: ExternalHookTurnBoundary;
      /**
       * On the "Message received" status that opens a daemon turn: the message
       * that woke the agent, as the turn's summary will carry it (task #17).
       * The server folds the running turn from these rows. The raw activity
       * log returns it as is, behind `canInspectAgentPrivateSurfaces`, like a
       * `turn_summary` entry's trigger; only the Activity overview checks the
       * viewer's channel access (`viewTurnSummaries`).
       */
      trigger?: ActivityTurnTrigger;
    } & TrajectoryProducerLineage & SubagentLineage)
  // One record per finished turn (task #17): see activityTurnSummary.ts. The
  // Activity overview reads only these; the other kinds are the raw log.
  | ({ kind: "turn_summary"; summary: ActivityTurnSummary } & TrajectoryProducerLineage);

/**
 * Daemon-to-server trajectory payload. Daemons emit the full trajectory union
 * defined below (not status-only); the optional `activity`/`activityKind` fields
 * on `status` exist solely for the one-version legacy ingest window and are
 * rewritten by the server before persistence or broadcast.
 */
export type DaemonTrajectoryEntry =
  | Exclude<TrajectoryEntry, { kind: "status" }>
  | ({
      kind: "status";
      activity?: AgentActivityKind;
      activityKind?: AgentActivityKind;
      detail: string;
      detailKind?: AgentActivityDetailKind;
      compaction?: RuntimeCompactionInterruption;
      tool?: ToolCallOutcome;
      trigger?: ActivityTurnTrigger;
    } & TrajectoryProducerLineage & SubagentLineage);

/** Normalize backend activity string to a valid frontend AgentActivity.
 *  Maps unknown values to sensible defaults. */
export function normalizeActivity(raw: string | undefined, dbStatus?: string): AgentActivityKind {
  if (isAgentActivity(raw)) return raw;
  // Fallback from DB status
  if (dbStatus === "active") return "working";
  return "offline";
}

export function normalizeActivityDetailKind(raw: string | undefined): AgentActivityDetailKind {
  return isAgentActivityDetailKind(raw) ? raw : "other";
}

// ── Runtimes ──


/**
 * External-agent presence: an external agent is online when its credential was
 * seen (any authenticated agent-API call, or an open wake-hint stream's
 * heartbeat) within this window; otherwise the UI shows "last active".
 */
export const EXTERNAL_AGENT_ONLINE_WINDOW_MS = 120_000;

/**
 * Server → web socket event (`agent:seen`), pushed to the agent's server room
 * when an external agent's credential-use timestamp is persisted, and to the
 * other servers' projection rooms of the active joint channels it is in.
 */
export interface AgentSeenEvent {
  agentId: string;
  /** ISO timestamp — same value `GET /agents` serves as `lastSeenAt`. */
  lastSeenAt: string;
}


export type RuntimeCapabilityStatus = "available" | "not_installed" | "update_required";
export type RuntimeAdmissionStatus = "available_for_new" | "grandfathered_current";
/**
 * `feature_flag_off`: an agent stays on a runtime this server no longer
 * admits for new agents because its flag is off (the OAR-only runtimes'
 * `agent_runtime_oar_<id>`, server runtimeAdmissionService.ts). Its earlier
 * source, the `grok_runtime_v0` gate, was retired on 2026-10-23.
 */
export type RuntimeAdmissionReason = "feature_flag_off" | "deprecated" | null;

/**
 * A context-specific server projection for choosing a runtime.
 *
 * Capability and admission intentionally stay orthogonal: a daemon may report
 * a runtime that rollout policy does not admit for new use, while an existing
 * agent may retain a grandfathered runtime only while its machine still
 * reports that capability.
 */
export interface RuntimeSelectionOption {
  runtimeId: string;
  capabilityStatus: RuntimeCapabilityStatus;
  admissionStatus: RuntimeAdmissionStatus;
  admissionReason: RuntimeAdmissionReason;
  current: boolean;
  availableForNew: boolean;
  manageableForCurrentAgent: boolean;
  canSelectInThisContext: boolean;
  /**
   * Presence opts this row into the versioned Create Agent form protocol.
   * Omission is the migration-safe legacy contract; clients must not infer a
   * form renderer from runtimeId.
   */
  formDefinitionRef?: RuntimeFormDefinitionRef;
  /**
   * Presence means the server serves this runtime's form on protocol v2
   * (GET .../runtime-forms/v2/:runtimeId; packages/runtime-form README,
   * "Protocol v2"). Independent of `formDefinitionRef`: a runtime may have a v2
   * form without any v1 definition, and v1 clients never see it. Additive;
   * clients that do not know it ignore it.
   */
  runtimeFormV2?: RuntimeFormV2Marker;
}

export interface RuntimeFormV2Marker {
  protocolVersion: 2;
}

/**
 * Contract version of `GET /api/servers/:id/runtimes` (docs/contracts/server-runtime-catalog.md).
 * Additive only: it goes up when a field is added, never for a removal or a
 * rename. Clients ignore keys they do not know.
 */
export const SERVER_RUNTIME_CATALOG_VERSION = 1;

/** Where a catalog entry's `models` list stands against the Computer's own detection. */
export type ServerRuntimeCatalogModelsSource =
  /** The list is the runtime's closed source (STATIC_RUNTIME_MODEL_SOURCE_IDS). */
  | "static"
  /** The Computer's live detection decides; this list is the bundled fallback (may be empty). */
  | "fallback";

/**
 * One runtime this server offers, from the shared RUNTIMES catalog after the
 * server's runtime switches. Not machine-specific: whether a Computer can run
 * it stays in `.../machines/:machineId/runtime-options`.
 */
export interface ServerRuntimeCatalogEntry {
  id: string;
  displayName: string;
  abbreviation: string;
  /** CLI binary name detected on PATH; "" for in-process runtimes. */
  binary: string;
  supported: boolean;
  experimental: boolean;
  /** Hidden from new-agent selectors; listed so existing agents keep their name. */
  deprecated: boolean;
  /** Runs only on the Computer's OAR host. */
  oarOnly: boolean;
  models: RuntimeModelInfo[];
  modelsSource: ServerRuntimeCatalogModelsSource;
  /**
   * Every form a client may configure this runtime with; never empty. A client
   * offers the runtime only if it knows at least one entry, skips kinds it
   * does not know, and asks for an app update when it knows none. A new form
   * kind is a new entry, so an old client never mistakes it for another.
   */
  forms: ServerRuntimeCatalogForm[];
}

export type ServerRuntimeCatalogForm =
  /** The generic create payload (runtime, model, env vars): every runtime without a v1 form. */
  | { kind: "generic" }
  /** The frozen v1 form: `.../runtime-form-definitions/:runtimeId?schemaVersion=<schemaVersion>`. */
  | { kind: "v1"; schemaVersion: string }
  /** The current v2 form: `.../runtime-forms/v2/:runtimeId`. */
  | { kind: "v2" };

export interface ServerRuntimeCatalog {
  catalogVersion: typeof SERVER_RUNTIME_CATALOG_VERSION;
  runtimes: ServerRuntimeCatalogEntry[];
}

export interface RuntimeFormDefinitionRef {
  protocolVersion: 1;
  runtimeId: string;
  schemaVersion: string;
}

export const KIMI_SDK_FORM_SCHEMA_VERSION = "kimi-sdk.create.v1";
export const KIMI_SDK_FORM_DEFINITION_REF = {
  protocolVersion: 1,
  runtimeId: "kimi-sdk",
  schemaVersion: KIMI_SDK_FORM_SCHEMA_VERSION,
} as const satisfies RuntimeFormDefinitionRef;

export type AgentCreateStringFieldSchema = {
  type: "string";
  title: string;
  minLength?: number;
  format?: "uri";
  writeOnly?: boolean;
};

export type AgentCreateStringMapFieldSchema = {
  type: "object";
  title: string;
  additionalProperties: { type: "string" };
};

export type AgentCreateBooleanFieldSchema = {
  type: "boolean";
  title: string;
};

/** The deliberately small JSON Schema subset supported by the Web renderer. */
export interface AgentCreateDataSchema {
  type: "object";
  additionalProperties: false;
  required: string[];
  properties: Record<string, AgentCreateStringFieldSchema | AgentCreateStringMapFieldSchema | AgentCreateBooleanFieldSchema>;
}

export interface AgentCreateUiSchema {
  order: string[];
  layout: { advanced: string[] };
  visibility: Array<{
    pointer: string;
    when: { pointer: string; in: string[] };
  }>;
  localization: Record<string, {
    label: string;
    hint?: string;
    placeholder?: string;
  }>;
}

export interface AgentCreateFormOption {
  value: string;
  label: string;
  providerKind?: "preset" | "gateway";
  /** Live, per-model runtime capabilities. Omitted means no effort picker. */
  supportedReasoningEfforts?: string[];
  /** Must be one of supportedReasoningEfforts when present. */
  defaultReasoningEffort?: string;
}

interface AgentCreateFormOptionSourceBase {
  protocolVersion: 1;
  runtimeId: string;
  schemaVersion: string;
  sourceId: string;
  pointer: string;
}

/** A definition carries only bounded, version-bound source references. */
export type AgentCreateFormOptionSourceRef =
  | (AgentCreateFormOptionSourceBase & {
      kind: "select";
    })
  | (AgentCreateFormOptionSourceBase & {
      kind: "dependent_select";
      dependsOn: string;
    });

/** Values are fetched separately from the permission-aware source endpoint. */
export type AgentCreateFormOptionSource =
  | (AgentCreateFormOptionSourceBase & {
      kind: "select";
      options: AgentCreateFormOption[];
      defaultValue: string;
    })
  | (AgentCreateFormOptionSourceBase & {
      kind: "dependent_select";
      dependsOn: string;
      optionsByValue: Record<string, AgentCreateFormOption[]>;
      defaultValueByValue: Record<string, string>;
      customValueAllowedByValue: Record<string, boolean>;
    });

export interface AgentCreateFormDefinition {
  protocolVersion: 1;
  runtimeId: string;
  schemaVersion: string;
  dataSchema: AgentCreateDataSchema;
  uiSchema: AgentCreateUiSchema;
  capabilities: {
    providerKinds: Array<"preset" | "gateway">;
    writeOnlyPointers: string[];
    forbiddenPointers: string[];
  };
  optionSources: Record<string, AgentCreateFormOptionSourceRef>;
}

/** Web-internal materialized form after all exact source refs resolve. */
export type ResolvedAgentCreateFormDefinition = Omit<AgentCreateFormDefinition, "optionSources"> & {
  optionSources: Record<string, AgentCreateFormOptionSource>;
};

export interface AgentCreateFormIssue {
  code: string;
  pointer: string;
}

export interface RuntimeSelectionCatalog {
  context: "new_agent" | "existing_agent" | "setup";
  machineId: string | null;
  options: RuntimeSelectionOption[];
}


export {
  __resetFailpointsForTests,
  __setFailpointsForTests,
  failpoints,
  InMemoryFailpointRegistry,
  noopFailpointRegistry,
} from "./testing/failpoints";
export type {
  FailpointEffect,
  FailpointMode,
  FailpointRegistry,
  FailpointSpec,
  FailpointTraceEntry,
  InMemoryFailpointRegistryOptions,
  MaybePromise,
} from "./testing/failpoints";

// ── Runtime Models ──

export interface RuntimeModelInfo {
  /** Model ID passed to CLI (e.g. "sonnet", "gpt-5.3-codex") */
  id: string;
  /** Human-readable label (e.g. "Sonnet", "GPT-5.3 Codex") */
  label: string;
  /** Runtime-reported reasoning effort IDs accepted by this model, when known. */
  supportedReasoningEfforts?: string[];
  /** Runtime-reported default reasoning effort for this model, when known. */
  defaultReasoningEffort?: string;
  /** Runtime-reported service tier IDs accepted by this model, when known. */
  serviceTiers?: string[];
  /** Runtime-reported default service tier for this model, when known. */
  defaultServiceTier?: string;
  /**
   * Whether this model is expected to launch with the current runtime config.
   * Official CLI model catalogs can be marked launchable when launch is a
   * direct model-id argument; suggestion_only is for entries that may need
   * user provider config the machine has not verified.
   */
  verified?: "launchable" | "suggestion_only";
}

/**
 * A runtime's model catalog as reported by a specific machine, or declared by
 * a runtime whose source is an explicit closed static catalog. The `default`
 * field, when present, is the source's configured-default model.
 */
export interface RuntimeModelSet {
  models: RuntimeModelInfo[];
  default?: string;
  /**
   * Additive proof that a live model list came from the target runtime's own
   * versioned catalog. Absent on legacy daemons; callers that require the
   * Built-in preset compatibility guarantee must fail closed when it is absent.
   */
  catalog?: RuntimeModelCatalogCapability;
  /**
   * Additive: models the runtime listed but marked not usable now, with the
   * runtime's own reason (untrusted text: plain text only, see
   * sanitizeRuntimeModelUnavailable). Never part of `models`: web deploys
   * before Computers update, and older web/mobile clients offer every entry in
   * `models` as selectable, so a disabled model must stay out of it.
   */
  unavailable?: RuntimeModelUnavailable[];
}

export interface RuntimeModelUnavailable {
  id: string;
  label: string;
  /** The runtime's reason, trimmed and capped; may be empty. */
  reason: string;
}

const RUNTIME_MODEL_UNAVAILABLE_MAX_ENTRIES = 50;
const RUNTIME_MODEL_UNAVAILABLE_MAX_TEXT = 200;

function boundedRuntimeText(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > RUNTIME_MODEL_UNAVAILABLE_MAX_TEXT
    ? `${text.slice(0, RUNTIME_MODEL_UNAVAILABLE_MAX_TEXT - 1)}…`
    : text;
}

/**
 * Validate a runtime-reported unavailable list from any hop (daemon output,
 * the wire, a cache): well-formed entries only, whitespace collapsed, text
 * length-capped, ids de-duplicated, entry count capped. Undefined when nothing
 * is left.
 */
export function sanitizeRuntimeModelUnavailable(value: unknown): RuntimeModelUnavailable[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: RuntimeModelUnavailable[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (entries.length >= RUNTIME_MODEL_UNAVAILABLE_MAX_ENTRIES) break;
    if (!candidate || typeof candidate !== "object") continue;
    const { id, label, reason } = candidate as Record<string, unknown>;
    if (typeof id !== "string" || id.trim() === "" || id.length > RUNTIME_MODEL_UNAVAILABLE_MAX_TEXT || seen.has(id)) continue;
    seen.add(id);
    entries.push({
      id,
      label: typeof label === "string" && label.trim() ? boundedRuntimeText(label) : id,
      reason: typeof reason === "string" ? boundedRuntimeText(reason) : "",
    });
  }
  return entries.length > 0 ? entries : undefined;
}

export interface RuntimeModelCatalogCapability {
  protocolVersion: 1;
  runtime: "builtin";
  runtimeVersion: string;
  /**
   * Additive (task #10): the preset providers for which this Computer runs a
   * typed model id outside the catalog. Absent on older Computers, whose
   * parser rejects such a config: treat absent as none.
   */
  customModelProviderIds?: string[];
}

/**
 * Terminal model-source truth reported by a Computer.
 *
 * Bundled fallback options remain presentation metadata, never live availability.
 */
export type RuntimeModelSourceOutcome =
  | { kind: "live"; value: RuntimeModelSet }
  | { kind: "missing_config"; recovery?: string }
  | { kind: "no_models"; recovery?: string }
  | { kind: "unsupported" }
  | {
    kind: "error";
    retryable: boolean;
    code?: RuntimeModelDetectionErrorCode;
    /**
     * task #1242 — present only with `code: "runtime_not_found"`, when the
     * daemon's runtime probe could say how its PATH lookup ended. Absent on
     * older daemons and when the probe had no verdict; absent is not
     * "confirmed missing".
     */
    reason?: RuntimeModelDetectionLookupReason;
  };

/**
 * task #1242 — the daemon runtime probe's structured cause for an unavailable
 * runtime, carried beside `runtime_not_found`. Only `not_installed` is a
 * confirmed absence; the others say the lookup did not decide.
 */
export const RUNTIME_MODEL_DETECTION_LOOKUP_REASONS = [
  "not_installed",
  "probe_timeout",
  "permission_denied",
  "probe_failed",
] as const;
export type RuntimeModelDetectionLookupReason = (typeof RUNTIME_MODEL_DETECTION_LOOKUP_REASONS)[number];
export function isRuntimeModelDetectionLookupReason(value: unknown): value is RuntimeModelDetectionLookupReason {
  return typeof value === "string" && (RUNTIME_MODEL_DETECTION_LOOKUP_REASONS as readonly string[]).includes(value);
}

export const RUNTIME_MODEL_DETECTION_ERROR_CODES = [
  "runtime_not_found",
  "runtime_not_authenticated",
  "detect_timeout",
  "protocol_unsupported",
  "detect_failed",
  "computer_offline",
] as const;
export type RuntimeModelDetectionErrorCode = (typeof RUNTIME_MODEL_DETECTION_ERROR_CODES)[number];

// Grok 1.x can take over five seconds to initialize its model catalog.
export const GROK_MODEL_DETECTION_TIMEOUT_MS = 15_000;
// `cursor-agent models` asks Cursor's backend for the account's catalog and can
// exceed five seconds. With the daemon probe and the server request both at 5s
// the server gave up first, so the live list never arrived.
export const CURSOR_MODEL_DETECTION_TIMEOUT_MS = 15_000;
// One server-side budget for every runtime (artin 2026-09-27: 统一放宽到 20s).
// It must stay above the longest daemon probe (Grok/Cursor 15s) so the daemon
// can report its own timeout instead of losing the race.
export const MODEL_DETECTION_REQUEST_TIMEOUT_MS = 20_000;
export function runtimeModelDetectionRequestTimeoutMs(_runtime: string): number {
  return MODEL_DETECTION_REQUEST_TIMEOUT_MS;
}

export function isRuntimeModelDetectionErrorCode(value: unknown): value is RuntimeModelDetectionErrorCode {
  return typeof value === "string" && (RUNTIME_MODEL_DETECTION_ERROR_CODES as readonly string[]).includes(value);
}

/** Convert a detector's catalog into the closed source-outcome contract. */
export function runtimeModelSourceOutcomeFromSet(
  value: RuntimeModelSet | null | undefined,
): RuntimeModelSourceOutcome {
  return value?.models.length
    ? { kind: "live", value }
    : { kind: "no_models" };
}

/**
 * Runtimes whose bundled catalog is the runtime's declared closed source, not
 * a fallback for failed machine detection. Keep this list narrow: every other
 * runtime must prove availability from its Computer or report a non-live
 * outcome.
 */
export const STATIC_RUNTIME_MODEL_SOURCE_IDS = [
  "claude",
  "copilot",
  "gemini",
] as const;

/**
 * Verification applied by each declared static source when the daemon stamps
 * its catalog. The server also uses this contract when adapting an old daemon
 * that can only report `error: "unsupported"` for these runtimes.
 */
export const STATIC_RUNTIME_MODEL_SOURCE_VERIFICATION = {
  claude: "launchable",
  copilot: "launchable",
  gemini: "suggestion_only",
} as const satisfies Record<
  (typeof STATIC_RUNTIME_MODEL_SOURCE_IDS)[number],
  NonNullable<RuntimeModelInfo["verified"]>
>;

export function hasStaticRuntimeModelSource(runtimeId: string): boolean {
  return (STATIC_RUNTIME_MODEL_SOURCE_IDS as readonly string[]).includes(runtimeId);
}

/** Effort levels every listed Claude Code model accepts (`claude --effort`); never `ultra`. */
const CLAUDE_REASONING_EFFORTS: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

export const RUNTIME_MODELS: Record<string, RuntimeModelInfo[]> = {
  [EXTERNAL_AGENT_RUNTIME_ID]: [
    { id: EXTERNAL_AGENT_RUNTIME_MODEL, label: EXTERNAL_AGENT_RUNTIME_DISPLAY_NAME },
  ],
  builtin: Object.values(PI_BUILTIN_PROVIDER_MODELS)
    .flat()
    .map((model) => ({ id: model.id, label: model.label || formatRuntimeProviderModelLabel(model.id), verified: "launchable" as const })),
  claude: [
    // Claude Code takes `--effort low|medium|high|xhigh|max`, and every current
    // Claude model accepts `max`. Haiku 4.5 takes no effort at all, and the `haiku`
    // alias may still resolve to it, so both keep the base set; Claude Code drops an
    // effort a model does not take, and Opus/Sonnet 4.6 run `xhigh` as `high`
    // (OAR probe, #oar-raft 2026-10-14). Per-model levels should come from Claude
    // Code's own model list (`supportedEffortLevels`) rather than this table.
    { id: "opus", label: "Claude Opus", supportedReasoningEfforts: CLAUDE_REASONING_EFFORTS },
    { id: "fable", label: "Claude Fable", supportedReasoningEfforts: CLAUDE_REASONING_EFFORTS },
    { id: "sonnet", label: "Claude Sonnet", supportedReasoningEfforts: CLAUDE_REASONING_EFFORTS },
    { id: "haiku", label: "Claude Haiku" },
    { id: "claude-opus-5-5", label: "Claude Opus 5.5", supportedReasoningEfforts: CLAUDE_REASONING_EFFORTS },
    { id: "claude-opus-5", label: "Claude Opus 5", supportedReasoningEfforts: CLAUDE_REASONING_EFFORTS },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8", supportedReasoningEfforts: CLAUDE_REASONING_EFFORTS },
    { id: "claude-opus-4-7", label: "Claude Opus 4.7", supportedReasoningEfforts: CLAUDE_REASONING_EFFORTS },
    { id: "claude-opus-4-6", label: "Claude Opus 4.6", supportedReasoningEfforts: CLAUDE_REASONING_EFFORTS },
    { id: "claude-fable-5-2", label: "Claude Fable 5.2", supportedReasoningEfforts: CLAUDE_REASONING_EFFORTS },
    { id: "claude-fable-5-1", label: "Claude Fable 5.1", supportedReasoningEfforts: CLAUDE_REASONING_EFFORTS },
    { id: "claude-fable-5", label: "Claude Fable 5", supportedReasoningEfforts: CLAUDE_REASONING_EFFORTS },
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", supportedReasoningEfforts: CLAUDE_REASONING_EFFORTS },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5", supportedReasoningEfforts: CLAUDE_REASONING_EFFORTS },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", supportedReasoningEfforts: CLAUDE_REASONING_EFFORTS },
    { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", supportedReasoningEfforts: CLAUDE_REASONING_EFFORTS },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ],
  codex: [
    // Order and per-model reasoning metadata follow upstream Codex's bundled
    // catalog (codex-rs/models-manager/models.json, rust-v0.162.0): picker
    // priority, `default_reasoning_level`, `supported_reasoning_levels`.
    {
      id: "gpt-6.1-sol",
      label: "GPT-6.1 Sol",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultReasoningEffort: "low",
      verified: "launchable",
    },
    {
      id: "gpt-6-astra",
      label: "GPT-6-Astra",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultReasoningEffort: "low",
      verified: "launchable",
    },
    {
      id: "gpt-6-sol",
      label: "GPT-6 Sol",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultReasoningEffort: "medium",
      verified: "launchable",
    },
    {
      id: "gpt-6-luna",
      label: "GPT-6 Luna",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
      verified: "launchable",
    },
    {
      id: "gpt-5.6-sol",
      label: "GPT-5.6 Sol",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultReasoningEffort: "medium",
      verified: "launchable",
    },
    {
      id: "gpt-5.6-terra",
      label: "GPT-5.6 Terra",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultReasoningEffort: "medium",
      verified: "launchable",
    },
    {
      id: "gpt-5.6-luna",
      label: "GPT-5.6 Luna",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
      verified: "launchable",
    },
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
    { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" },
    { id: "gpt-5.2-codex", label: "GPT-5.2 Codex" },
    { id: "gpt-5.2", label: "GPT-5.2" },
    { id: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max" },
    { id: "gpt-5.1-codex", label: "GPT-5.1 Codex" },
    { id: "gpt-5-codex", label: "GPT-5 Codex" },
    { id: "gpt-5", label: "GPT-5" },
  ],
  grok: [
    {
      id: "grok-4.5",
      label: "Grok 4.5",
      supportedReasoningEfforts: ["high", "medium", "low"],
      defaultReasoningEffort: "high",
      verified: "launchable",
    },
    // New choice without changing the bundled default; live detection owns availability.
    { id: "grok-4.6", label: "Grok 4.6", verified: "suggestion_only" },
    {
      id: "grok-composer-2.5-fast",
      label: "Composer 2.5",
      verified: "launchable",
    },
  ],
  antigravity: [
    { id: "default", label: "AGY configured default", verified: "suggestion_only" },
  ],
  copilot: [
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "gpt-5.2", label: "GPT-5.2" },
    { id: "claude-4-sonnet", label: "Claude 4 Sonnet" },
    { id: "claude-4.5-sonnet", label: "Claude 4.5 Sonnet" },
  ],
  cursor: [
    { id: "composer-2-fast", label: "Composer 2 Fast" },
    { id: "composer-2", label: "Composer 2" },
    { id: "auto", label: "Auto" },
  ],
  gemini: [
    { id: "default", label: "Configured Default / Auto", verified: "suggestion_only" },
    { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (Preview)" },
    { id: "gemini-3-flash-preview", label: "Gemini 3 Flash (Preview)" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  ],
  opencode: [
    { id: "default", label: "Configured Default / Auto", verified: "suggestion_only" },
    { id: "deepseek/deepseek-v4-pro", label: formatRuntimeProviderModelLabel("deepseek/deepseek-v4-pro"), verified: "suggestion_only" },
    { id: "openrouter/anthropic/claude-opus-4.5", label: formatRuntimeProviderModelLabel("openrouter/anthropic/claude-opus-4.5"), verified: "suggestion_only" },
    { id: "fusecode/opus[1m]", label: formatRuntimeProviderModelLabel("fusecode/opus[1m]"), verified: "suggestion_only" },
  ],
  pi: [
    { id: "default", label: "Configured Default / Auto", verified: "suggestion_only" },
  ],
  // Kimi CLI resolves model keys from each user's local config, so the safest
  // built-in option is to defer to whatever default model the CLI already uses.
  kimi: [
    { id: "default", label: "Configured Default" },
  ],
  // kimi-sdk runs the Kimi Code SDK in-process. The daemon's
  // `detectKimiSdkModels()` reads the live model list from the user's
  // `<kimiHome>/config.toml` (populated by `kimi login` from Moonshot's
  // `/models` endpoint) and reports it to the server, so the picker reflects
  // whatever the user has actually provisioned — including new rollouts
  // (e.g. K2.7) without a daemon bump.
  //
  // This static entry is explanatory/default-seeding metadata plus ONE bounded
  // exception: the create-form option source may offer it as the managed
  // default when the machine reports missing_config (the normal first-install
  // shape — nothing provisioned yet). An empty grant (no_models) or a detector
  // error remains a typed non-live source and must never make this entry
  // selectable. Keeping one entry prevents getDefaultModel("kimi-sdk") from
  // falling through to Claude's "sonnet".
  "kimi-sdk": [
    { id: "kimi-code/kimi-for-coding", label: "Kimi for Coding (default)", verified: "launchable" },
  ],
};

/** Return a declared static catalog with daemon-equivalent verification. */
export function getStaticRuntimeModelSourceSet(
  runtimeId: string,
): RuntimeModelSet | undefined {
  if (!hasStaticRuntimeModelSource(runtimeId)) return undefined;

  const runtime = runtimeId as (typeof STATIC_RUNTIME_MODEL_SOURCE_IDS)[number];
  const verified = STATIC_RUNTIME_MODEL_SOURCE_VERIFICATION[runtime];
  return {
    models: (RUNTIME_MODELS[runtime] ?? []).map((model) => ({
      ...model,
      verified: model.verified ?? verified,
    })),
  };
}

/** Get the default model ID for a runtime. */
export function getDefaultModel(runtimeId: string): string {
  const models = RUNTIME_MODELS[runtimeId];
  return models?.[0]?.id ?? "sonnet";
}

/** Get a model's display label. Falls back to the raw model ID. */
export function getModelLabel(runtimeId: string, modelId: string): string {
  const models = RUNTIME_MODELS[runtimeId];
  return models?.find((m) => m.id === modelId)?.label ?? modelId;
}

/**
 * What a daemon needs to find an agent's session file when it holds nothing
 * for the agent: which runtime (and model) it runs, the env vars that
 * runtime's session directory is derived from, and the session id the server
 * stores for it (`agents.session_id`), as the next `agent:start` would carry
 * them. Nothing else of the agent's config: its runtime settings and its
 * other env vars can hold provider keys. A daemon keeps an agent's config and session id
 * in memory only, so after its own restart, or after the agent's terminal
 * failure, it has none (`no_config_in_memory`): then, and only then, it uses
 * this. The session id never comes from a web caller. What may be read does
 * not change: that session's file under the runtime's session directories
 * for this config, with the same path checks.
 */
export interface FeedbackTranscriptSessionLookup {
  runtime: string;
  model: string;
  /**
   * Only the agent's env vars that decide where the runtime keeps its
   * session files (`runtimeSessionHomeEnvVars`), never the rest: an agent's
   * env vars are where people put API keys, and a diagnostic request is no
   * reason for those to travel.
   */
  sessionHomeEnv: Record<string, string> | null;
  sessionId: string | null;
}

/**
 * Per runtime, the env vars its session directory is derived from. Each
 * daemon driver reads its home through the name declared here, so this list
 * and the derivation cannot drift apart: codex (`drivers/codexHome.ts`),
 * grok (`drivers/grokHome.ts`), kimi-sdk (`drivers/kimiCodeHome.ts`). A
 * runtime not listed keeps its sessions under the Computer user's home or
 * the agent's workspace, whatever its env vars say.
 */
export const CODEX_HOME_ENV = "CODEX_HOME";
export const GROK_HOME_ENV = "GROK_HOME";
export const KIMI_CODE_HOME_ENV = "KIMI_CODE_HOME";
export const RUNTIME_SESSION_HOME_ENV_KEYS: Readonly<Record<string, readonly string[]>> = {
  codex: [CODEX_HOME_ENV],
  grok: [GROK_HOME_ENV],
  "kimi-sdk": [KIMI_CODE_HOME_ENV],
};

/** `envVars` cut down to the keys `runtime`'s session directory depends on; null when none is set. */
export function runtimeSessionHomeEnvVars(runtime: string, envVars: Readonly<Record<string, unknown>> | null | undefined): Record<string, string> | null {
  const kept: Record<string, string> = {};
  for (const key of RUNTIME_SESSION_HOME_ENV_KEYS[runtime] ?? []) {
    const value = envVars?.[key];
    if (typeof value === "string") kept[key] = value;
  }
  return Object.keys(kept).length > 0 ? kept : null;
}

export interface RuntimeConfigHydrationInput {
  runtime?: string | null;
  model?: string | null;
  runtimeConfig?: unknown;
  reasoningEffort?: RuntimeReasoningEffort | null;
  envVars?: Record<string, string> | null;
}

export interface RuntimeConfigLaunchFields {
  runtime: string;
  model: string;
  mode: RuntimeModeConfig;
  reasoningEffort: RuntimeReasoningEffort | null;
  envVars: Record<string, string> | null;
  command?: string | null;
}

export type LaunchPlan = RuntimeConfigLaunchFields & { // Derived launch view; RuntimeConfig is the persisted source of truth, while LaunchPlan materializes legacy driver fields/env + trace after validation.
  configSource: RuntimeConfigSource;
  trace: RuntimeConfigLaunchTraceAttrs;
};

export type RuntimeConfigParseOutcome = "accepted" | "rejected" | "legacy_sanitized";

export type RuntimeConfigParseReason =
  | "not_object"
  | "unsupported_version"
  | "missing_runtime"
  | "unknown_field"
  | "invalid_model"
  | "invalid_mode"
  | "cross_runtime_provider"
  | "invalid_provider"
  | "invalid_env_vars"
  | "unsupported_command"
  | "invalid_command"
  | "invalid_reasoning_effort"
  | "unsupported_reasoning_effort"
  | "unsupported_fast_mode";

export interface RuntimeConfigParseTraceAttrs {
  outcome: RuntimeConfigParseOutcome;
  runtime?: string;
  provider_kind?: string;
  provider_id?: BuiltInRuntimeAnyProviderId;
  model_id?: string;
  model_kind?: RuntimeModelConfig["kind"];
  base_url_present?: boolean;
  base_url_host_class?: BuiltInRuntimeGatewayBaseUrlHostClass;
  reason?: RuntimeConfigParseReason;
  unknown_fields_dropped_count?: number;
}

export interface RuntimeConfigLaunchTraceAttrs {
  outcome: "materialized";
  runtime: string;
  provider_kind: string;
  provider_id?: BuiltInRuntimeAnyProviderId;
  model_id?: string;
  model_kind?: RuntimeModelConfig["kind"];
  base_url_present?: boolean;
  base_url_host_class?: BuiltInRuntimeGatewayBaseUrlHostClass;
  config_source: RuntimeConfigSource;
  provider_key_present: boolean;
  provider_key_source?: "runtime_config_plaintext";
  env_key_count: number;
}

export type BuiltInRuntimeGatewayBaseUrlHostClass = "localhost" | "private" | "public";

export type RuntimeConfigSource =
  | "agent_config"
  | "host_claude_config"
  | "host_runtime_config"
  | "local_pi_config";

export type RuntimeConfigParseResult =
  | { ok: true; config: RuntimeConfig; trace: RuntimeConfigParseTraceAttrs }
  | { ok: false; error: string; trace: RuntimeConfigParseTraceAttrs };

const CONTROLLED_RUNTIME_ENV_KEYS: Record<string, readonly string[]> = {
  // Built-in owns all provider credential/base-url env keys for its launch
  // plan. Scrub both keys we materialize and host provider keys Pi may read
  // directly, including defensive aliases such as ANTHROPIC_OAUTH_TOKEN.
  builtin: BUILTIN_RUNTIME_HOST_PROVIDER_ENV_SCRUB_KEYS,
  claude: ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_CUSTOM_MODEL_OPTION"],
  // Raft sets no Codex endpoint. Current Codex ignores this variable, but
  // older builds point the built-in OpenAI provider at it, where a ChatGPT
  // login on the computer would follow (#proj-raft-computer:38b688ec).
  codex: ["OPENAI_BASE_URL"],
  // Pi-runtime builtin-provider env vars (e.g. DEEPSEEK_API_KEY). Owned by
  // PiRuntimeProviderConfig.pi-builtin → buildLaunchPlan, not by
  // user-supplied envVars: reading from PI_BUILTIN_PROVIDER_ENV_KEYS keeps
  // this list in sync as new providers are added.
  pi: Object.values(PI_BUILTIN_PROVIDER_ENV_KEYS),
};

const RUNTIME_CONFIG_FIELDS = [
  "version",
  "runtime",
  "provider",
  "model",
  "mode",
  "reasoningEffort",
  "envVars",
  "command",
  "hostUserState",
  "loadLocalPlugins",
] as const;
const MODEL_CONFIG_FIELDS = ["kind", "id", "name", "contextWindow", "maxOutputTokens"] as const;
const MODE_CONFIG_FIELDS = ["kind"] as const;
const CLAUDE_DEFAULT_PROVIDER_FIELDS = ["kind"] as const;
const CLAUDE_CUSTOM_PROVIDER_FIELDS = ["kind", "apiUrl", "apiKey", "authType"] as const;
const PI_DEFAULT_PROVIDER_FIELDS = ["kind"] as const;
const PI_BUILTIN_PROVIDER_FIELDS = ["kind", "providerId", "apiKey"] as const;
const BUILTIN_PRESET_PROVIDER_FIELDS = ["kind", "providerId", "apiKey"] as const;
const BUILTIN_GATEWAY_PROVIDER_FIELDS = ["kind", "providerId", "baseUrl", "apiKey", "supportsImageInput"] as const;
const BUILTIN_CONNECTION_PROVIDER_FIELDS = ["kind", "connectionId"] as const;
const UNKNOWN_PROVIDER_FIELDS = ["kind"] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unknownFieldCount(record: Record<string, unknown>, knownFields: readonly string[]): number {
  const known = new Set(knownFields);
  return Object.keys(record).filter((key) => !known.has(key)).length;
}

function hasUnknownFields(record: Record<string, unknown>, knownFields: readonly string[]): boolean {
  return unknownFieldCount(record, knownFields) > 0;
}

function providerKnownFieldsFor(runtime: string | undefined, provider: Record<string, unknown>): readonly string[] {
  const kind = typeof provider.kind === "string" ? provider.kind : undefined;
  if (runtime === "builtin") {
    if (kind === "preset" || kind === "managed") return BUILTIN_PRESET_PROVIDER_FIELDS;
    if (kind === "gateway") return BUILTIN_GATEWAY_PROVIDER_FIELDS;
    if (kind === "connection") return BUILTIN_CONNECTION_PROVIDER_FIELDS;
  }
  if (runtime === "claude") {
    if (kind === "default") return CLAUDE_DEFAULT_PROVIDER_FIELDS;
    if (kind === "custom") return CLAUDE_CUSTOM_PROVIDER_FIELDS;
  }
  if (runtime === "pi") {
    if (kind === "default") return PI_DEFAULT_PROVIDER_FIELDS;
    if (kind === "pi-builtin") return PI_BUILTIN_PROVIDER_FIELDS;
  }
  return UNKNOWN_PROVIDER_FIELDS;
}

function providerKind(config: RuntimeConfig): string {
  return config.provider?.kind ?? "none";
}

function providerKeyPresent(config: RuntimeConfig): boolean {
  if (config.runtime === "builtin") {
    // Hydration may omit provider when private runtimeConfig was stripped.
    return Boolean(config.provider && config.provider.kind !== "connection" && config.provider.apiKey.length > 0);
  }
  if (config.runtime === "claude") return config.provider?.kind === "custom" && config.provider.apiKey.length > 0;
  if (config.runtime === "pi") return config.provider?.kind === "pi-builtin" && config.provider.apiKey.length > 0;
  return false;
}

function builtInSelectionTraceAttrs(config: RuntimeConfig): Pick<RuntimeConfigParseTraceAttrs, "provider_id" | "model_id" | "model_kind" | "base_url_present" | "base_url_host_class"> {
  if (config.runtime !== "builtin") return {};
  // Match runtimeConfigLegacy: member projections / agent:created can strip
  // private runtimeConfig, so Built-in may hydrate without provider. Trace
  // attrs must fail soft — never throw on read paths.
  const provider = config.provider;
  return {
    ...(provider && provider.kind !== "connection" ? { provider_id: provider.providerId } : {}),
    model_kind: config.model.kind,
    ...(config.model.kind === "preset" ? { model_id: config.model.id } : {}),
    ...(provider?.kind === "gateway"
      ? {
          base_url_present: true,
          base_url_host_class: classifyBuiltInGatewayBaseUrlHost(provider.baseUrl),
        }
      : {}),
  };
}

export function isBuiltInRuntimeProviderId(value: string): value is BuiltInRuntimeProviderId {
  return Object.prototype.hasOwnProperty.call(BUILTIN_RUNTIME_PROVIDER_ENV_KEYS, value);
}

export function isBuiltInRuntimeGatewayProviderId(value: string): value is BuiltInRuntimeGatewayProviderId {
  return Object.prototype.hasOwnProperty.call(BUILTIN_RUNTIME_GATEWAY_PROVIDER_ENV_KEYS, value);
}

/**
 * Built-in preset providers whose Model field also accepts a typed model id
 * that is not in Pi's catalog, and whose limits are explicit overrides for any
 * model, listed ones included (task #10, #wg-runtime-form). A stored custom
 * name is the provider's own API id (an OpenRouter id such as
 * `moonshotai/kimi-k2.6`), never Raft's `provider/` catalog value
 * (normalizeBuiltInPresetCustomModel). A Computer that runs such a model reports
 * the provider in its Built-in catalog's `customModelProviderIds`; an older
 * Computer's parser rejects the config, so the server checks that first.
 */
export const BUILTIN_RUNTIME_CUSTOM_MODEL_PRESET_PROVIDER_IDS: readonly BuiltInRuntimeProviderId[] = ["openrouter"];

export function isBuiltInRuntimeCustomModelPresetProviderId(value: string): boolean {
  return (BUILTIN_RUNTIME_CUSTOM_MODEL_PRESET_PROVIDER_IDS as readonly string[]).includes(value);
}

function normalizeEnvVars(envVars: unknown): Record<string, string> | null {
  if (!isPlainRecord(envVars)) return null;
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(envVars)) {
    if (typeof key === "string" && typeof value === "string") {
      normalized[key] = value;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

const RUNTIME_CONFIG_ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseStrictEnvVars(value: unknown): Record<string, string> | null | string {
  if (value === undefined || value === null) return null;
  if (!isPlainRecord(value)) return "runtimeConfig.envVars must be an object";
  const normalized: Record<string, string> = {};
  for (const [key, envValue] of Object.entries(value)) {
    if (typeof envValue !== "string") return "runtimeConfig.envVars keys and values must be strings";
    if (!RUNTIME_CONFIG_ENV_KEY_REGEX.test(key)) {
      return `Invalid runtimeConfig.envVars key "${key}": must match [A-Za-z_][A-Za-z0-9_]*`;
    }
    if (key.includes("\0") || envValue.includes("\0")) {
      return "runtimeConfig.envVars keys and values must not contain null bytes";
    }
    normalized[key] = envValue;
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

export function getControlledRuntimeEnvKeys(runtime: string): readonly string[] {
  return CONTROLLED_RUNTIME_ENV_KEYS[runtime] ?? [];
}

export function stripControlledRuntimeEnvVars(
  runtime: string,
  envVars: Record<string, string> | null | undefined,
): Record<string, string> | null {
  const normalized = normalizeEnvVars(envVars);
  if (!normalized) return null;
  for (const key of Object.keys(normalized)) {
    if (isControlledRuntimeEnvKey(runtime, key)) delete normalized[key];
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

/**
 * Whether `key` is one of the runtime's own env keys, in any case: Windows
 * reads env names case-insensitively, so `Anthropic_Base_Url` would still
 * reach the runtime as its base URL.
 */
export function isControlledRuntimeEnvKey(runtime: string, key: string): boolean {
  const upper = key.toUpperCase();
  return getControlledRuntimeEnvKeys(runtime).some((controlled) => controlled.toUpperCase() === upper);
}

function isPresetRuntimeModel(runtime: string, model: string): boolean {
  return (RUNTIME_MODELS[runtime] ?? []).some((candidate) => candidate.id === model);
}

/**
 * task #10: the provider's own model id (the "Pi id") for a Built-in catalog id
 * of a preset provider that takes a typed model: the catalog id minus exactly
 * one leading `<provider>/` (Raft's namespace). `openrouter/moonshotai/kimi-k2.6`
 * is `moonshotai/kimi-k2.6`; `openrouter/openrouter/auto` is `openrouter/auto`.
 */
export function builtInPresetProviderModelId(providerId: string, catalogId: string): string {
  const prefix = `${providerId}/`;
  return catalogId.startsWith(prefix) ? catalogId.slice(prefix.length) : catalogId;
}

/**
 * task #10: how every write path stores a typed model on a preset provider
 * that takes one (OpenRouter). Two steps, and the model a name means never
 * depends on its limits:
 *
 * 1. Resolve `custom.name` to the provider's API id (the "Pi id"), ignoring
 *    limits:
 *    - a name that is itself a listed API id (`openrouter/<name>` is a catalog
 *      id) IS that API id, unchanged: `openrouter/auto` (Pi lists
 *      `openrouter/openrouter/auto`), `moonshotai/kimi-k2.6`, `auto`;
 *    - else a name that is a listed catalog id is Raft's form: exactly one
 *      `openrouter/` comes off (`openrouter/openrouter/auto` ->
 *      `openrouter/auto`, `openrouter/moonshotai/kimi-k2.6` ->
 *      `moonshotai/kimi-k2.6`);
 *    - else (unlisted) the name is kept as typed, prefix and all: it is the
 *      API id the user gave. An unlisted `openrouter/<x>/<y>` could be an
 *      OpenRouter id or a mistyped Raft id; nothing can tell, so the name the
 *      provider gets is the one typed. The form never produces Raft's form for
 *      an unlisted model (a catalog selection is converted explicitly there).
 * 2. Then the limits decide only how it is stored: a listed API id without a
 *    limit is its preset (`openrouter/<API id>`); with a limit (an explicit
 *    override of the catalog's value) it is a custom model named by its API
 *    id; an unlisted id is custom as typed. So the provider only ever sees its
 *    own id, never Raft's `openrouter/` namespace, a stored config parses to
 *    itself, and clearing the limits gives the preset of the same model.
 */
function normalizeBuiltInPresetCustomModel(
  providerId: string,
  model: Extract<RuntimeModelConfig, { kind: "custom" }>,
): RuntimeModelConfig {
  const prefix = `${providerId}/`;
  const apiId = isBuiltInProviderModel(providerId, `${prefix}${model.name}`)
    ? model.name
    : isBuiltInProviderModel(providerId, model.name)
      ? builtInPresetProviderModelId(providerId, model.name)
      : model.name;
  if (!isBuiltInProviderModel(providerId, `${prefix}${apiId}`)) return model;
  const limited = model.contextWindow !== undefined || model.maxOutputTokens !== undefined;
  return limited ? { ...model, name: apiId } : { kind: "preset", id: `${prefix}${apiId}` };
}

function isBuiltInProviderModel(providerId: string, modelId: string): boolean {
  return (PI_BUILTIN_PROVIDER_MODELS[providerId] ?? []).some((candidate) => candidate.id === modelId);
}

function customProviderConfigError(provider: { apiUrl: string; apiKey: string }): string | null {
  if (!provider.apiUrl.trim()) return "runtimeConfig.provider.apiUrl is required";
  if (!provider.apiKey.trim()) return "runtimeConfig.provider.apiKey is required";
  let parsed: URL;
  try {
    parsed = new URL(provider.apiUrl);
  } catch {
    return "runtimeConfig.provider.apiUrl must be a valid URL";
  }
  if (parsed.username || parsed.password) {
    return "runtimeConfig.provider.apiUrl must not contain credentials";
  }
  return null;
}

function builtInGatewayProviderConfigError(provider: { baseUrl: string; apiKey: string }): string | null {
  if (!provider.baseUrl.trim()) return "runtimeConfig.provider.baseUrl is required";
  if (!provider.apiKey.trim()) return "runtimeConfig.provider.apiKey is required";
  let parsed: URL;
  try {
    parsed = new URL(provider.baseUrl);
  } catch {
    return "runtimeConfig.provider.baseUrl must be a valid URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "runtimeConfig.provider.baseUrl must use http:// or https://";
  }
  if (parsed.username || parsed.password) {
    return "runtimeConfig.provider.baseUrl must not contain credentials";
  }
  return null;
}

function classifyBuiltInGatewayBaseUrlHost(baseUrl: string): BuiltInRuntimeGatewayBaseUrlHostClass {
  let hostname = "";
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "public";
  }
  if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || hostname.startsWith("127.")) return "localhost";
  const ipv4 = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map((part) => Number(part));
    const [a, b] = octets;
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return "private";
  }
  if (
    hostname === "0.0.0.0"
    || hostname === "::"
    || hostname.startsWith("fc")
    || hostname.startsWith("fd")
    || hostname.startsWith("fe80:")
  ) {
    return "private";
  }
  return "public";
}

function isKnownReasoningEffort(value: unknown): value is KnownReasoningEffort {
  return (
    value === "off"
    || value === "minimal"
    || value === "low"
    || value === "medium"
    || value === "high"
    || value === "xhigh"
    || value === "max"
    || value === "ultra"
  );
}

function runtimeConfigError(reason: RuntimeConfigParseReason, error: string, runtime?: string, providerKindValue?: string): RuntimeConfigParseResult {
  return {
    ok: false,
    error,
    trace: {
      outcome: "rejected",
      ...(runtime ? { runtime } : {}),
      ...(providerKindValue ? { provider_kind: providerKindValue } : {}),
      reason,
    },
  };
}

function parseStrictModelConfig(runtime: string, value: unknown): RuntimeModelConfig | string {
  if (!isPlainRecord(value)) return "runtimeConfig.model must be an object";
  if (hasUnknownFields(value, MODEL_CONFIG_FIELDS)) return "runtimeConfig.model contains unknown fields";
  if (value.kind === "custom") {
    if (typeof value.name !== "string" || !value.name.trim()) return "runtimeConfig.model.name is required";
    const limits = parseCustomModelLimits(runtime, value);
    if (typeof limits === "string") return limits;
    return { kind: "custom", name: value.name.trim(), ...limits };
  }
  if (value.contextWindow !== undefined || value.maxOutputTokens !== undefined) {
    return "runtimeConfig.model limits are only for a custom model";
  }
  if (value.kind === "preset") {
    return typeof value.id === "string" && value.id.trim()
      ? { kind: "preset", id: value.id.trim() }
      : "runtimeConfig.model.id is required";
  }
  return "runtimeConfig.model.kind is invalid";
}

/** A custom model's optional declared limits (#proj-runtime:#50); null/absent: not set. */
export function parseCustomModelLimits(
  runtime: string,
  value: Record<string, unknown>,
): { contextWindow?: number; maxOutputTokens?: number } | string {
  const contextWindow = value.contextWindow ?? undefined;
  const maxOutputTokens = value.maxOutputTokens ?? undefined;
  if (contextWindow === undefined && maxOutputTokens === undefined) return {};
  if (runtime !== "builtin") return "runtimeConfig.model limits are only for the builtin runtime";
  if (contextWindow !== undefined && (!Number.isSafeInteger(contextWindow) || (contextWindow as number) <= 0 || (contextWindow as number) > CUSTOM_MODEL_CONTEXT_WINDOW_MAX)) {
    return `runtimeConfig.model.contextWindow must be a positive integer up to ${CUSTOM_MODEL_CONTEXT_WINDOW_MAX}`;
  }
  if (maxOutputTokens !== undefined && (!Number.isSafeInteger(maxOutputTokens) || (maxOutputTokens as number) <= 0 || (maxOutputTokens as number) > CUSTOM_MODEL_MAX_OUTPUT_TOKENS_MAX)) {
    return `runtimeConfig.model.maxOutputTokens must be a positive integer up to ${CUSTOM_MODEL_MAX_OUTPUT_TOKENS_MAX}`;
  }
  if (contextWindow !== undefined && maxOutputTokens !== undefined && (maxOutputTokens as number) > (contextWindow as number)) {
    return "runtimeConfig.model.maxOutputTokens must not exceed contextWindow";
  }
  return {
    ...(contextWindow !== undefined ? { contextWindow: contextWindow as number } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens: maxOutputTokens as number } : {}),
  };
}

function parseStrictModeConfig(value: unknown): RuntimeModeConfig | string {
  if (value === undefined || value === null) return { kind: "default" };
  if (!isPlainRecord(value)) return "runtimeConfig.mode must be an object";
  if (hasUnknownFields(value, MODE_CONFIG_FIELDS)) return "runtimeConfig.mode contains unknown fields";
  if (value.kind === "default" || value.kind === "fast") return { kind: value.kind };
  return "runtimeConfig.mode.kind is invalid";
}

function parseStrictProviderConfig(
  runtime: string,
  value: unknown,
): BuiltInRuntimeProviderConfig | ClaudeRuntimeProviderConfig | PiRuntimeProviderConfig | string | undefined {
  if (value === undefined || value === null) {
    if (runtime === "claude" || runtime === "pi") return { kind: "default" };
    if (runtime === "builtin") return "runtimeConfig.provider is required for runtime: builtin";
    return undefined;
  }
  if (!isPlainRecord(value)) return "runtimeConfig.provider must be an object";
  const rawKind = typeof value.kind === "string" ? value.kind : undefined;
  if (runtime === "builtin") {
    if (rawKind === "connection") {
      if (hasUnknownFields(value, providerKnownFieldsFor(runtime, value))) return "runtimeConfig.provider contains unknown fields";
      if (typeof value.connectionId !== "string" || !value.connectionId.trim()) {
        return "runtimeConfig.provider.connectionId is required";
      }
      return { kind: "connection", connectionId: value.connectionId.trim() };
    }
    if (rawKind === "preset") {
      if (hasUnknownFields(value, providerKnownFieldsFor(runtime, value))) return "runtimeConfig.provider contains unknown fields";
      if (typeof value.providerId !== "string" || !value.providerId.trim()) return "runtimeConfig.provider.providerId is required";
      if (typeof value.apiKey !== "string" || !value.apiKey.trim()) return "runtimeConfig.provider.apiKey is required";
      const providerId = value.providerId.trim();
      if (!isBuiltInRuntimeProviderId(providerId)) {
        return `runtimeConfig.provider.providerId ${providerId} is not a known Built-in provider`;
      }
      return { kind: "preset", providerId, apiKey: value.apiKey.trim() };
    }
    if (rawKind === "gateway") {
      if (hasUnknownFields(value, providerKnownFieldsFor(runtime, value))) return "runtimeConfig.provider contains unknown fields";
      if (typeof value.providerId !== "string" || !value.providerId.trim()) return "runtimeConfig.provider.providerId is required";
      if (typeof value.baseUrl !== "string" || !value.baseUrl.trim()) return "runtimeConfig.provider.baseUrl is required";
      if (typeof value.apiKey !== "string" || !value.apiKey.trim()) return "runtimeConfig.provider.apiKey is required";
      if (value.supportsImageInput !== undefined && typeof value.supportsImageInput !== "boolean") {
        return "runtimeConfig.provider.supportsImageInput must be a boolean";
      }
      const providerId = value.providerId.trim();
      if (!isBuiltInRuntimeGatewayProviderId(providerId)) {
        return `runtimeConfig.provider.providerId ${providerId} is not a known Built-in gateway provider`;
      }
      const provider = {
        kind: "gateway" as const,
        providerId,
        baseUrl: value.baseUrl.trim(),
        apiKey: value.apiKey.trim(),
        ...(value.supportsImageInput === undefined
          ? {}
          : { supportsImageInput: value.supportsImageInput }),
      };
      const error = builtInGatewayProviderConfigError(provider);
      if (error) return error;
      return provider;
    }
    if (rawKind === "default" || rawKind === "custom" || rawKind === "pi-builtin") {
      return "runtimeConfig.provider is not supported for runtime: builtin";
    }
    return "runtimeConfig.provider.kind is invalid";
  }
  if (runtime === "claude") {
    if (rawKind === "default") {
      return hasUnknownFields(value, providerKnownFieldsFor(runtime, value))
        ? "runtimeConfig.provider contains unknown fields"
        : { kind: "default" };
    }
    if (rawKind === "custom") {
      if (hasUnknownFields(value, providerKnownFieldsFor(runtime, value))) return "runtimeConfig.provider contains unknown fields";
      if (typeof value.apiUrl !== "string" || !value.apiUrl.trim()) return "runtimeConfig.provider.apiUrl is required";
      if (typeof value.apiKey !== "string" || !value.apiKey.trim()) return "runtimeConfig.provider.apiKey is required";
      if (value.authType !== undefined && value.authType !== "api_key" && value.authType !== "auth_token") {
        return "runtimeConfig.provider.authType must be api_key or auth_token";
      }
      const provider = {
        kind: "custom" as const,
        apiUrl: value.apiUrl.trim(),
        apiKey: value.apiKey.trim(),
        ...(value.authType === "auth_token" ? { authType: "auth_token" as const } : {}),
      };
      const error = customProviderConfigError(provider);
      if (error) return error;
      return provider;
    }
    if (rawKind === "pi-builtin") return "runtimeConfig.provider is not supported for runtime: claude";
    return "runtimeConfig.provider.kind is invalid";
  }
  if (runtime === "pi") {
    if (rawKind === "default") {
      return hasUnknownFields(value, providerKnownFieldsFor(runtime, value))
        ? "runtimeConfig.provider contains unknown fields"
        : { kind: "default" };
    }
    if (rawKind === "pi-builtin") {
      if (hasUnknownFields(value, providerKnownFieldsFor(runtime, value))) return "runtimeConfig.provider contains unknown fields";
      if (typeof value.providerId !== "string" || !value.providerId.trim()) return "runtimeConfig.provider.providerId is required";
      if (typeof value.apiKey !== "string" || !value.apiKey.trim()) return "runtimeConfig.provider.apiKey is required";
      if (!Object.prototype.hasOwnProperty.call(PI_BUILTIN_PROVIDER_ENV_KEYS, value.providerId.trim())) {
        return `runtimeConfig.provider.providerId ${value.providerId.trim()} is not a known Pi builtin provider`;
      }
      return { kind: "pi-builtin", providerId: value.providerId.trim(), apiKey: value.apiKey.trim() };
    }
    if (rawKind === "custom") return "runtimeConfig.provider is not supported for runtime: pi";
    return "runtimeConfig.provider.kind is invalid";
  }
  return `runtimeConfig.provider is not supported for runtime: ${runtime}`;
}

type ReasoningEffortParseResult =
  | { ok: true; value: RuntimeReasoningEffort | null }
  | { ok: false; error: string };

function parseStrictReasoningEffortConfig(runtime: string, value: unknown): ReasoningEffortParseResult {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!REASONING_EFFORT_RUNTIMES.has(runtime)) {
    return { ok: false, error: `runtimeConfig.reasoningEffort is not supported for runtime: ${runtime}` };
  }
  if (
    typeof value !== "string"
    || !value
    || value.trim() !== value
    || value.includes("\0")
    // Kimi Code owns its effort strings (its own "off" among them); every other
    // runtime uses the shared set, where off/minimal are Pi-only.
    || (runtime !== "kimi-sdk" && (!isKnownReasoningEffort(value) || !isReasoningEffortOfferedOnRuntime(runtime, value)))
  ) {
    return { ok: false, error: `Invalid reasoning effort: ${value}` };
  }
  return { ok: true, value };
}

function composeRuntimeConfig(input: {
  runtime: string;
  provider?: BuiltInRuntimeProviderConfig | ClaudeRuntimeProviderConfig | PiRuntimeProviderConfig;
  model: RuntimeModelConfig;
  mode: RuntimeModeConfig;
  reasoningEffort?: RuntimeReasoningEffort | null;
  envVars?: Record<string, string> | null;
  command?: string | null;
  loadLocalPlugins?: boolean;
}): RuntimeConfig {
  const base = {
    version: RUNTIME_CONFIG_VERSION,
    model: input.model,
    mode: input.mode,
    reasoningEffort: input.reasoningEffort ?? null,
    envVars: input.envVars ?? null,
  };
  if (input.runtime === "builtin") {
    return {
      ...base,
      runtime: "builtin",
      provider: input.provider as BuiltInRuntimeProviderConfig,
      hostUserState: "forbidden",
      ...(input.loadLocalPlugins !== undefined ? { loadLocalPlugins: input.loadLocalPlugins } : {}),
    };
  }
  if (input.runtime === "claude") {
    return {
      ...base,
      runtime: "claude",
      provider: input.provider as ClaudeRuntimeProviderConfig | undefined,
      ...(input.command ? { command: input.command } : {}),
    };
  }
  if (input.runtime === "pi") {
    return {
      ...base,
      runtime: "pi",
      provider: input.provider as PiRuntimeProviderConfig | undefined,
    };
  }
  return {
    ...base,
    runtime: input.runtime as ProviderlessRuntimeId,
  };
}

export function hydrateRuntimeConfig(input: RuntimeConfigHydrationInput): RuntimeConfig {
  return hydrateRuntimeConfigWithTrace(input).config;
}

/**
 * Reconstruct a complete current RuntimeConfig for read/launch paths from the
 * persisted structured runtimeConfig plus older agent columns
 * (`runtime`/`model`/`reasoningEffort`/`envVars`). "Hydrate" here means filling
 * the canonical object from storage-era shapes; it is not the strict write
 * validator. Current create/update requests must use parseRuntimeConfig.
 */
export function hydrateRuntimeConfigWithTrace(input: RuntimeConfigHydrationInput): { config: RuntimeConfig; trace: RuntimeConfigParseTraceAttrs } {
  return hydrateLegacyRuntimeConfigWithTrace(input, {
    runtimeConfigVersion: RUNTIME_CONFIG_VERSION,
    runtimeModels: RUNTIME_MODELS,
    runtimeConfigFields: RUNTIME_CONFIG_FIELDS,
    modelConfigFields: MODEL_CONFIG_FIELDS,
    modeConfigFields: MODE_CONFIG_FIELDS,
    getDefaultModel,
    builtinProviderEnvKeys: BUILTIN_RUNTIME_PROVIDER_ENV_KEYS,
    builtinGatewayProviderEnvKeys: BUILTIN_RUNTIME_GATEWAY_PROVIDER_ENV_KEYS,
    piBuiltinProviderEnvKeys: PI_BUILTIN_PROVIDER_ENV_KEYS,
    providerKnownFieldsFor,
    stripControlledRuntimeEnvVars,
    composeRuntimeConfig,
  });
}

export function parseRuntimeConfig(input: RuntimeConfigHydrationInput): RuntimeConfigParseResult {
  const raw = input.runtimeConfig;
  if (raw === undefined || raw === null) {
    const config = hydrateRuntimeConfig(input);
    if (config.runtime === "builtin") {
      return runtimeConfigError("invalid_provider", "runtimeConfig.provider is required for runtime: builtin", config.runtime, providerKind(config));
    }
    const providerError = config.runtime === "claude" && config.provider?.kind === "custom"
      ? customProviderConfigError(config.provider)
      : null;
    if (providerError) return runtimeConfigError(reasonForValidationError(providerError), providerError, config.runtime, providerKind(config));
    const reasoningEffort = parseStrictReasoningEffortConfig(config.runtime, config.reasoningEffort);
    if (!reasoningEffort.ok) {
      return runtimeConfigError(reasonForValidationError(reasoningEffort.error), reasoningEffort.error, config.runtime, providerKind(config));
    }
    return {
      ok: true,
      config,
      trace: { outcome: "accepted", runtime: config.runtime, provider_kind: providerKind(config), ...builtInSelectionTraceAttrs(config) },
    };
  }
  if (!isPlainRecord(raw)) return runtimeConfigError("not_object", "runtimeConfig must be an object");
  if (hasUnknownFields(raw, RUNTIME_CONFIG_FIELDS)) {
    return runtimeConfigError(
      "unknown_field",
      "runtimeConfig contains unknown fields",
      typeof raw.runtime === "string" ? raw.runtime : undefined,
      isPlainRecord(raw.provider) && typeof raw.provider.kind === "string" ? raw.provider.kind : undefined,
    );
  }
  if (raw.version !== RUNTIME_CONFIG_VERSION) {
    return runtimeConfigError("unsupported_version", "runtimeConfig version is unsupported");
  }
  const runtime = typeof raw.runtime === "string" ? raw.runtime.trim() : "";
  if (!runtime) return runtimeConfigError("missing_runtime", "runtimeConfig.runtime is required");
  // Installed mobile clients (kotlinx.serialization with encodeDefaults and
  // explicit nulls) send every optional field, unset ones as `null`. An
  // explicit null means "not set", exactly like an omitted key, so it must not
  // fail validation; any other non-boolean value is still refused, and a null
  // never turns local extensions on.
  const hostUserState = raw.hostUserState === null ? undefined : raw.hostUserState;
  const loadLocalPlugins = raw.loadLocalPlugins === null ? undefined : raw.loadLocalPlugins;
  if (runtime === "builtin" && hostUserState !== undefined && hostUserState !== "forbidden") {
    return runtimeConfigError("unknown_field", "runtimeConfig.hostUserState must be forbidden for runtime: builtin", runtime);
  }

  if (loadLocalPlugins !== undefined && (runtime !== "builtin" || typeof loadLocalPlugins !== "boolean")) {
    return runtimeConfigError("unknown_field", "runtimeConfig.loadLocalPlugins must be a boolean for runtime: builtin", runtime);
  }

  const parsedModel = parseStrictModelConfig(runtime, raw.model);
  if (typeof parsedModel === "string") return runtimeConfigError("invalid_model", parsedModel, runtime);
  let model: RuntimeModelConfig = parsedModel;

  const mode = parseStrictModeConfig(raw.mode);
  if (typeof mode === "string") return runtimeConfigError("invalid_mode", mode, runtime);
  if (mode.kind === "fast" && !RUNTIME_FAST_MODE_RUNTIMES.has(runtime)) {
    return runtimeConfigError("unsupported_fast_mode", `runtimeConfig.mode is not supported for runtime: ${runtime}`, runtime);
  }

  const rawProviderKind = isPlainRecord(raw.provider) && typeof raw.provider.kind === "string" ? raw.provider.kind : undefined;
  const provider = parseStrictProviderConfig(runtime, raw.provider);
  if (typeof provider === "string") {
    const reason: RuntimeConfigParseReason = provider.includes("not supported")
      ? "cross_runtime_provider"
      : provider.includes("unknown fields")
        ? "unknown_field"
        : "invalid_provider";
    return runtimeConfigError(reason, provider, runtime, rawProviderKind);
  }
  if (runtime === "builtin" && provider?.kind === "preset") {
    if (model.kind === "custom" && isBuiltInRuntimeCustomModelPresetProviderId(provider.providerId)) {
      model = normalizeBuiltInPresetCustomModel(provider.providerId, model);
    }
    if (model.kind === "custom" && !isBuiltInRuntimeCustomModelPresetProviderId(provider.providerId)) {
      const result = runtimeConfigError("invalid_model", "runtimeConfig.model.kind custom is not supported for runtime: builtin", runtime, rawProviderKind);
      return { ...result, trace: { ...result.trace, provider_id: provider.providerId, model_kind: model.kind } };
    }
    if (model.kind === "preset" && !isBuiltInProviderModel(provider.providerId, model.id)) {
      const result = runtimeConfigError("invalid_model", `runtimeConfig.model.id is not supported for Built-in provider ${provider.providerId}`, runtime, rawProviderKind);
      return { ...result, trace: { ...result.trace, provider_id: provider.providerId, model_kind: model.kind, model_id: model.id } };
    }
  }
  if (runtime === "builtin" && provider?.kind === "gateway" && model.kind !== "custom") {
    const result = runtimeConfigError("invalid_model", "runtimeConfig.model.kind preset is not supported for Built-in gateway providers", runtime, rawProviderKind);
    return {
      ...result,
      trace: {
        ...result.trace,
        provider_id: provider.providerId,
        model_kind: model.kind,
        ...(model.kind === "preset" ? { model_id: model.id } : {}),
        base_url_present: true,
        base_url_host_class: classifyBuiltInGatewayBaseUrlHost(provider.baseUrl),
      },
    };
  }

  const envVars = parseStrictEnvVars(raw.envVars);
  if (typeof envVars === "string") {
    return runtimeConfigError("invalid_env_vars", envVars, runtime, rawProviderKind);
  }

  let command: string | undefined;
  if (raw.command !== undefined && raw.command !== null) {
    if (runtime !== "claude") {
      return runtimeConfigError("unsupported_command", `runtimeConfig.command is not supported for runtime: ${runtime}`, runtime, rawProviderKind);
    }
    if (typeof raw.command !== "string" || !raw.command.trim()) {
      return runtimeConfigError("invalid_command", "runtimeConfig.command is required", runtime, rawProviderKind);
    }
    command = raw.command.trim();
    if (command.includes("\0")) {
      return runtimeConfigError("invalid_command", "runtimeConfig.command must not contain null bytes", runtime, rawProviderKind);
    }
  }

  const reasoningEffort = parseStrictReasoningEffortConfig(runtime, raw.reasoningEffort ?? input.reasoningEffort ?? null);
  if (!reasoningEffort.ok) {
    return runtimeConfigError(reasonForValidationError(reasoningEffort.error), reasoningEffort.error, runtime, rawProviderKind);
  }
  // Fail-closed per-model gate (task #496): max/ultra are Codex-GPT-5.6-only
  // (declared via `supportedReasoningEfforts`). Drop an effort a KNOWN preset model
  // doesn't allow, so e.g. Claude + ultra normalizes to null instead of persisting
  // / launching an invalid combo. The UI picker already hides it; this guards the
  // API/daemon path (Jianwei's fail-closed point). Custom models pass through —
  // their capability is unknown, so we don't over-restrict them.
  const gatedReasoningEffort = runtime !== "kimi-sdk" && reasoningEffort.value !== null
    && isKnownReasoningEffort(reasoningEffort.value) && model.kind === "preset"
    && !isReasoningEffortAllowedForModel(runtime, model.id, reasoningEffort.value)
    ? null
    : reasoningEffort.value;

  const config = composeRuntimeConfig({
    runtime,
    provider,
    model,
    mode,
    reasoningEffort: gatedReasoningEffort,
    loadLocalPlugins: loadLocalPlugins as boolean | undefined,
    envVars: stripControlledRuntimeEnvVars(runtime, envVars),
    command,
  });
  return {
    ok: true,
    config,
    trace: { outcome: "accepted", runtime: config.runtime, provider_kind: providerKind(config), ...builtInSelectionTraceAttrs(config) },
  };
}

export function runtimeConfigModelValue(config: RuntimeConfig): string {
  return config.model.kind === "custom" ? config.model.name : config.model.id;
}

/**
 * The config as it launches: a saved fast mode on a model that no longer runs
 * fast launches at the standard speed rather than failing
 * (RUNTIME_FAST_MODE_UNSUPPORTED_MODELS). The saved config is left as it is.
 */
export function runtimeConfigForLaunch(config: RuntimeConfig): RuntimeConfig {
  if (config.mode.kind !== "fast" || runtimeModelSupportsFastMode(config.runtime, runtimeConfigModelValue(config))) return config;
  return { ...config, mode: { kind: "default" } };
}

function reasonForValidationError(error: string): RuntimeConfigParseReason {
  if (error.includes("provider is not supported") || error.includes("provider.kind")) return "cross_runtime_provider";
  if (error.includes("mode is not supported")) return "unsupported_fast_mode";
  if (error.includes("mode.kind")) return "invalid_mode";
  if (error.includes("reasoningEffort is not supported")) return "unsupported_reasoning_effort";
  if (error.includes("Invalid reasoning effort")) return "invalid_reasoning_effort";
  if (error.includes("command is not supported")) return "unsupported_command";
  if (error.includes("command")) return "invalid_command";
  if (error.includes("model")) return "invalid_model";
  return "invalid_provider";
}

export function runtimeConfigSource(config: RuntimeConfig): RuntimeConfigSource {
  if (config.runtime === "builtin") return "agent_config";
  if (config.runtime === "claude") {
    return config.provider?.kind === "custom" ? "agent_config" : "host_claude_config";
  }
  if (config.runtime === "pi") {
    return config.provider?.kind === "pi-builtin" ? "agent_config" : "local_pi_config";
  }
  return config.provider ? "agent_config" : "host_runtime_config";
}

export function buildLaunchPlan(config: RuntimeConfig): LaunchPlan {
  // Compatibility bridge for existing runtime drivers: RuntimeConfig is the
  // persisted source of truth, while drivers still consume flat launch fields
  // plus env vars. Never infer provider/model/mode semantics back from this
  // LaunchPlan; re-parse or hydrate RuntimeConfig instead.
  const normalized = config;
  const generatedEnvVars: Record<string, string> = {};
  if (normalized.runtime === "builtin") {
    if (normalized.provider.kind === "preset") {
      const envKey = BUILTIN_RUNTIME_PROVIDER_ENV_KEYS[normalized.provider.providerId];
      if (envKey) generatedEnvVars[envKey] = normalized.provider.apiKey;
    }
    if (normalized.provider.kind === "gateway") {
      const apiKeyEnvKey = BUILTIN_RUNTIME_GATEWAY_PROVIDER_ENV_KEYS[normalized.provider.providerId];
      const baseUrlEnvKey = BUILTIN_RUNTIME_GATEWAY_PROVIDER_BASE_URL_ENV_KEYS[normalized.provider.providerId];
      if (apiKeyEnvKey) generatedEnvVars[apiKeyEnvKey] = normalized.provider.apiKey;
      if (baseUrlEnvKey) generatedEnvVars[baseUrlEnvKey] = normalized.provider.baseUrl;
    }
    // A managed connection is resolved server-side for an exact launch. The
    // shared projection deliberately emits no credential or provider env.
  }
  if (normalized.runtime === "claude") {
    if (normalized.provider?.kind === "custom") {
      generatedEnvVars.ANTHROPIC_BASE_URL = normalized.provider.apiUrl;
      generatedEnvVars[claudeCustomProviderAuthEnvKey(normalized.provider.authType)] = normalized.provider.apiKey;
    }
    if (normalized.model.kind === "custom") {
      generatedEnvVars.ANTHROPIC_CUSTOM_MODEL_OPTION = normalized.model.name;
    }
  }
  if (normalized.runtime === "pi" && normalized.provider?.kind === "pi-builtin") {
    const envKey = PI_BUILTIN_PROVIDER_ENV_KEYS[normalized.provider.providerId];
    if (envKey) generatedEnvVars[envKey] = normalized.provider.apiKey;
  }
  const envVars = {
    ...(normalized.envVars ?? {}),
    ...generatedEnvVars,
  };
  return { // Compatibility output for launch paths only; persist/re-parse RuntimeConfig for decisions instead of inferring config semantics back from env vars.
    runtime: normalized.runtime,
    model: runtimeConfigModelValue(normalized),
    mode: runtimeConfigForLaunch(normalized).mode,
    configSource: runtimeConfigSource(normalized),
    reasoningEffort: normalized.reasoningEffort ?? null,
    envVars: Object.keys(envVars).length > 0 ? envVars : null,
    ...(normalized.command ? { command: normalized.command } : {}),
    trace: {
      outcome: "materialized",
      runtime: normalized.runtime,
      provider_kind: providerKind(normalized),
      ...builtInSelectionTraceAttrs(normalized),
      config_source: runtimeConfigSource(normalized),
      provider_key_present: providerKeyPresent(normalized),
      ...(providerKeyPresent(normalized) ? { provider_key_source: "runtime_config_plaintext" as const } : {}),
      env_key_count: Object.keys(envVars).length,
    },
  };
}

export function runtimeConfigToLaunchFields(config: RuntimeConfig): RuntimeConfigLaunchFields {
  const { trace: _, configSource: _configSource, ...launchFields } = buildLaunchPlan(config);
  return launchFields;
}

/**
 * The env vars that move a runtime's credential store away from the one a
 * Computer's web login writes (the daemon runs that login in its own
 * environment, which an agent inherits). `HOME` moves every runtime's default
 * store. Qoder and Qwen Code have no override Raft knows of: only `HOME`
 * counts for them.
 */
/**
 * Env vars that give an agent its own credentials instead of the machine's
 * shared sign-in: a credential home (QWEN_HOME moves ~/.qwen; Qoder's
 * QODER(CN)_CONFIG_DIR_NAME renames ~/.qoder) or a key passed directly.
 */
const RUNTIME_CREDENTIAL_HOME_ENV: Readonly<Record<RuntimeAuthRuntime, readonly string[]>> = {
  // ANTHROPIC_API_KEY is not here: Raft scrubs it from a Claude agent's env
  // (CONTROLLED_RUNTIME_ENV_KEYS); an own key is a custom provider instead.
  claude: ["CLAUDE_CONFIG_DIR", "ANTHROPIC_AUTH_TOKEN"],
  codex: ["CODEX_HOME", "OPENAI_API_KEY"],
  kimi: ["KIMI_CODE_HOME"],
  qoder: ["QODER_CONFIG_DIR_NAME", "QODERCN_CONFIG_DIR_NAME", "QODER_PERSONAL_ACCESS_TOKEN"],
  qwen: ["QWEN_HOME"],
  // agy keeps its sign-in under $GEMINI_HOME/antigravity-cli/ (or a keyring it detects).
  antigravity: ["GEMINI_HOME"],
  // Pi's sign-ins are <agent dir>/auth.json; an agent with its own dir reads its own.
  pi: ["PI_CODING_AGENT_DIR"],
  // Grok keeps its sign-in in $GROK_HOME/auth.json (~/.grok by default). That
  // Grok Build reads XAI_API_KEY as a credential is assumed, not verified: an
  // agent with one is treated as on its own credential to be safe.
  grok: ["GROK_HOME", "XAI_API_KEY"],
  // OpenCode keeps its sign-ins under $XDG_DATA_HOME/opencode (~/.local/share
  // by default); an agent with its own data dir reads its own.
  opencode: ["XDG_DATA_HOME"],
  // CodeBuddy Code: CODEBUDDY_API_KEY signs it in without the account (OAR
  // reads it as configured, unvalidated); CODEBUDDY_INTERNET_ENVIRONMENT picks
  // the account service (OAR's login keeps it), so an agent with either is on
  // its own credential. Its sign-in store's location is not known: only
  // `HOME` moves it otherwise.
  codebuddy: ["CODEBUDDY_API_KEY", "CODEBUDDY_INTERNET_ENVIRONMENT"],
};

/**
 * #proj-raft-computer:#46: the runtime whose machine-shared sign-in this agent
 * runs on, or null when it runs on none: a runtime Raft cannot sign in from
 * the web, an agent with its own provider (a Claude custom provider's key),
 * or one whose own env vars point the runtime at another credential home. A
 * web login or provider connect for that runtime on the agent's Computer
 * changes this agent's credentials; for any other agent it changes nothing.
 * The daemon and the server apply this same rule.
 */
export function sharedCredentialsAuthRuntime(input: RuntimeConfigHydrationInput): RuntimeAuthRuntime | null {
  const authRuntime = runtimeAuthRuntimeFor(input.runtime || "claude");
  if (!authRuntime) return null;
  const config = hydrateRuntimeConfig(input);
  if (config.provider && config.provider.kind !== "default") return null;
  const agentEnv = runtimeConfigToLaunchFields(config).envVars ?? {};
  for (const name of ["HOME", ...RUNTIME_CREDENTIAL_HOME_ENV[authRuntime]]) {
    const value = agentEnv[name];
    if (typeof value === "string" && value.trim().length > 0) return null;
  }
  return authRuntime;
}

// ── Reasoning Effort ──

export type KnownReasoningEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
/**
 * Persisted agent-row reasoning values remain the closed, database-backed
 * vocabulary. Runtime-owned vocabularies live inside RuntimeConfig instead.
 */
export type ReasoningEffort = KnownReasoningEffort;
export type RuntimeReasoningEffort = ReasoningEffort | (string & {});

export const REASONING_EFFORTS: { id: KnownReasoningEffort; label: string }[] = [
  { id: "off", label: "No reasoning" },
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
  { id: "max", label: "Max" },
  { id: "ultra", label: "Ultra" },
];

/**
 * The reasoning efforts available to any reasoning-capable model that does NOT
 * declare an explicit `supportedReasoningEfforts` gate. `max`/`ultra` are opt-in
 * only — a model must declare them (Codex GPT-5.6+ declares both; Claude models
 * declare `max`, never `ultra`); they must never leak to models that inherit this
 * base set (e.g. a custom model id). tygg/stdrc 2026-07-10 task #496.
 */
export const BASE_REASONING_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh"];

/**
 * Pi and Built-in Pi offer every Pi thinking level for every model; Pi maps a
 * level a model does not take to one it does (`clampThinkingLevel`), so no
 * per-model list is kept (xxchan, #proj-runtime:980f40ee).
 */
export const PI_REASONING_EFFORTS: readonly ReasoningEffort[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const PI_REASONING_EFFORT_RUNTIMES: ReadonlySet<string> = new Set(["pi", "builtin"]);

/**
 * `off` and `minimal` are Pi thinking levels: in the shared vocabulary they
 * are offered and accepted on Pi runtimes only, whatever a model list
 * declares. Kimi Code is outside this rule: it owns its own effort strings.
 */
export function isReasoningEffortOfferedOnRuntime(runtime: string, effort: string): boolean {
  return (effort !== "off" && effort !== "minimal") || PI_REASONING_EFFORT_RUNTIMES.has(runtime);
}

/** The efforts a model that declares none offers: Pi's full set on Pi runtimes, else BASE. */
export function defaultReasoningEffortsForRuntime(runtime: string): readonly ReasoningEffort[] {
  return PI_REASONING_EFFORT_RUNTIMES.has(runtime) ? PI_REASONING_EFFORTS : BASE_REASONING_EFFORTS;
}

/**
 * Whether a model that declares no efforts still offers the runtime's base set
 * in the pickers (the v2 form, the bulk change). Antigravity and CodeBuddy Code
 * do not: their thought levels are per model and they can only apply a level
 * the Computer listed for that model (OAR `listModels` reads them for the
 * current model only).
 */
export function runtimeOffersUndeclaredReasoningEfforts(runtime: string): boolean {
  return runtime !== "antigravity" && runtime !== "codebuddy";
}

/**
 * Efforts the agents.reasoning_effort column and the agent API carry. `off` and
 * `minimal` (Pi only) live in runtimeConfig alone, so agent-facing responses
 * never show older CLIs a value their schema rejects.
 */
export type LegacyColumnReasoningEffort = Exclude<KnownReasoningEffort, "off" | "minimal">;
export const LEGACY_COLUMN_REASONING_EFFORTS: readonly LegacyColumnReasoningEffort[] = ["low", "medium", "high", "xhigh", "max", "ultra"];

/**
 * The reasoning efforts a model actually allows: its declared
 * `supportedReasoningEfforts` when present, else the base set. Single source of
 * truth for the picker (UI) and the persist/launch gate (backend), so `max`/
 * `ultra` cannot appear or be accepted for a model that doesn't declare them.
 */
export function allowedReasoningEffortsForModel(runtime: string, modelId: string): readonly string[] {
  const known = RUNTIME_MODELS[runtime]?.find((m) => m.id === modelId);
  const supported = known?.supportedReasoningEfforts;
  if (runtime === "kimi-sdk") return supported ?? [];
  if (supported && supported.length > 0) return supported;
  // A catalog model that declares none, on a runtime that applies only listed
  // levels (Antigravity's `default`: agy's own choice), allows none. A model
  // only the Computer lists is not in this static catalog: the v2 submit checks
  // it against the live list (reconcileWithLiveModels).
  if (known && !runtimeOffersUndeclaredReasoningEfforts(runtime)) return [];
  return defaultReasoningEffortsForRuntime(runtime);
}

/**
 * A runtime's model entry meaning "the runtime chooses" (no model is passed):
 * Antigravity's `default`. Model pickers keep it first and preselect it, so a
 * new agent or a bulk change leaves the choice to the runtime unless the user
 * picks a model.
 */
export function runtimeChoiceModel(runtime: string): RuntimeModelInfo | undefined {
  return runtime === "antigravity" ? RUNTIME_MODELS.antigravity?.find((model) => model.id === "default") : undefined;
}

/** Whether `effort` is allowed for the model — used to gate/normalize backend input. */
export function isReasoningEffortAllowedForModel(runtime: string, modelId: string, effort: ReasoningEffort): boolean {
  return allowedReasoningEffortsForModel(runtime, modelId).includes(effort);
}

/**
 * Runtimes that support configurable reasoning effort. Antigravity's is agy's
 * thought level, and CodeBuddy Code's its ACP thought level, each offered only
 * for a model whose levels the Computer lists (OAR `listModels`) and passed as
 * the OAR session's `effort`.
 */
export const REASONING_EFFORT_RUNTIMES = new Set(["builtin", "claude", "codex", "grok", "antigravity", "copilot", "pi", "kimi-sdk", "codebuddy"]);

/** Runtimes that support the shared fast-mode launch variant. */
export const RUNTIME_FAST_MODE_RUNTIMES = new Set(["claude", "codex"]);

/**
 * Models a fast-mode runtime does not run fast. Claude Code 2.1.316: fast mode
 * for Opus 4.8 is deprecated (2026-10-30) and removed on 2026-11-30, after
 * which a fast request for it fails instead of falling back to the standard
 * speed. Matched on the configured model id: the `opus` alias resolves to a
 * current model.
 */
const RUNTIME_FAST_MODE_UNSUPPORTED_MODELS: Partial<Record<string, ReadonlySet<string>>> = {
  claude: new Set(["claude-opus-4-8"]),
};

/**
 * Whether `runtime` runs `modelId` in fast mode; an empty id is the runtime's
 * default model. A trailing variant tag (Claude Code's `[1m]` context window)
 * names the same model.
 */
export function runtimeModelSupportsFastMode(runtime: string, modelId: string): boolean {
  const baseId = modelId.trim().replace(/\[[^\]]*\]$/, "");
  return RUNTIME_FAST_MODE_RUNTIMES.has(runtime) && !RUNTIME_FAST_MODE_UNSUPPORTED_MODELS[runtime]?.has(baseId);
}

// ── Task Board ──

/**
 * Task lifecycle status.
 *
 * `closed` is a terminal state that means "won't do" — the task was
 * deliberately abandoned (cancelled / won't-fix / duplicate / out-of-scope),
 * distinct from `done` which means "completed". A closed task can be
 * reopened by transitioning back to `todo`.
 *
 * Transition rules live in taskService.VALID_TRANSITIONS; route input
 * validation in routes/tasks.ts whitelists the literal values.
 *
 * stdrc 2026-05-08 #proj-task:5ca7dfa3:
 *   "Task除了 done，还应该该有一个closed 的状态，显示为红色，
 *    表示的是关掉并且不准备做了"
 *
 * `backlog` is "not now": work someone created or parked and doesn't plan to
 * do now (raft-design decision 0042). It is not active work. Task v2 only: a
 * write that asks for it on a pre-v2 task, or on a server without
 * `task_v2_conversations_v0`, is refused like an invalid status. Moving a task
 * into it takes an optional reason (`checkTaskStatusReason`).
 */
export type TaskStatus = "backlog" | "todo" | "in_progress" | "in_review" | "done" | "closed";
// Single source of truth for runtime validation (see REMINDER_STATUSES above).
export const TASK_STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "closed"] as const satisfies readonly TaskStatus[];

export { TASK_CLAIM_REASON_ALREADY_CLAIMED_BY_YOU } from "./taskClaimReason";
export * from "./taskCreateStatus";
export * from "./taskStatusReason";
export * from "./taskAssignReason";
export * from "./taskAssignmentNotice";
export const isTaskStatus = (s: string): s is TaskStatus =>
  (TASK_STATUSES as readonly string[]).includes(s);

/**
 * Structured receipt for a task that creates or owns an external resource.
 *
 * The task row, rather than a free-form chat message, is the authority source.
 * Every value is required and non-blank before the task may move to `done`.
 * `expiry` is an ISO timestamp and automatically schedules an expiry follow-up owned by
 * the resolved teardown Agent.
 */
export interface TaskResourceReceipt {
  object: string;
  purpose: string;
  teardown_owner: string;
  security_privacy: string;
  expiry: string;
  runbook: string;
  tracking: string;
}

export interface TaskInfo {
  id: string;
  /** Parent message of the task's own conversation thread (task v2: a hidden anchor). */
  messageId: string;
  /** Task v2: the visible chat message this task hangs under (many tasks per message). */
  sourceMessageId?: string | null;
  /** Task v2: messages in the task's own conversation thread (0 when none). */
  conversationReplyCount?: number;
  /**
   * Task v2: true when the conversation is the thread of a hidden task anchor
   * (created on a server with task_v2_conversations_v0, or backfilled); false
   * when it is the thread of a visible chat message (pre-v2 / converted).
   */
  conversationAnchored?: boolean;
  channelId: string;
  channelName?: string | null;
  channelType?: "channel" | "private" | "joint" | "dm" | "thread";
  taskNumber: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  createdByType: "user" | "agent";
  createdById: string;
  /** The creator's display name. */
  createdByName?: string;
  /** The creator's handle (servers before 2026-10 omit it). */
  createdByHandle?: string | null;
  claimedByType?: "user" | "agent" | null;
  claimedById?: string | null;
  claimedByName?: string | null;
  claimedAt?: string | null;
  completedAt?: string | null;
  requiresResourceReceipt?: boolean;
  resourceReceipt?: TaskResourceReceipt | null;
  resourceReceiptRecordedAt?: string | null;
  resourceTeardownOwnerAgentId?: string | null;
  resourceExpiryFollowupId?: string | null;
  createdAt: string;
}

export * from "./serverPermissions";
export * from "./taskPermissions";

// ── Server Plans ──

/** Plan identifiers stored in the database. */
export type ServerPlan = "free" | "founder" | "partner" | "pro";

/** Plans shown in the pricing comparison UI (includes coming-soon tiers). */
export type DisplayPlan = "free" | "pro" | "enterprise";

export interface PlanLimits {
  maxMachines: number;       // -1 = unlimited
  maxAgents: number;         // -1 = unlimited
  maxChannels: number;       // -1 = unlimited
  messageHistoryDays: number; // -1 = unlimited
  includedAgents: number;    // [UNUSED] legacy extra-agent billing field
}

export interface PlanConfig {
  displayName: string;
  limits: PlanLimits;
  comingSoon: boolean;
  price: number;             // monthly price in dollars (0 = free)
  priceLabel?: string;       // display-only override for non-numeric pricing copy
  priceCadence?: string | null;
  extraAgentPrice: number;   // [UNUSED] extra-agent billing disabled — always 0 for now
  displayFeatures?: string[];
  displayDescription?: string;
  displayNote?: string;
}

export interface BillingCapacity {
  maxHumans: number;          // -1 = unlimited
  maxAgents: number;          // -1 = unlimited
  maxUniversalSeats: number;  // -1 = not universal-seat based or unlimited
}

export interface BillingUsage {
  humans: number;
  agents: number;
  universalSeats: number;
}

export type BillingCapacityKind = "human" | "agent";

export interface BillingCapacityLimitState {
  reached: boolean;
  limitType: "human" | "agent" | "universal" | null;
  usage: number;
  limit: number;
  nextUsage: number;
}

/** The code on a refusal because the server has no seat left for one more human. */
export const HUMAN_SEAT_LIMIT_REACHED_CODE = "human_seat_limit_reached";
/**
 * The code on a refusal because a source-available deployment already has as
 * many people as the Raft License allows (Part I §2), and the change would
 * add one more: someone joining a server, becoming a member, or creating one.
 */
export const DEPLOYMENT_USER_LIMIT_REACHED_CODE = "deployment_user_limit_reached";
/** Where to ask for a license above the source-available edition's user limit. */
export const RAFT_LICENSE_CONTACT_EMAIL = "contact@raft.build";
/** The code on a refusal because the server has no room for one more agent: a Pro seat share, or Free's agent count. */
export const AGENT_LIMIT_REACHED_CODE = "agent_limit_reached";

/**
 * The numbers behind a seat or agent refusal, as `capacityLimit` next to
 * `error` and `code`, so a client can show why the action didn't fit and how
 * many seats would make it fit. Only members of the server get them.
 */
export interface CapacityLimitDetail {
  limitType: "human" | "agent" | "universal";
  /** Seats bought (`universal`), or the human or agent cap. */
  limit: number;
  /** Seats or members in use before the refused action. */
  usage: number;
  /** What `usage` would have been with it. */
  nextUsage: number;
  humans: number;
  agents: number;
}

/** Prepaid Pro time a Server has (task #19): the period that covers now, or the one that just ended while its grace days run. */
export interface PrepaidEntitlement {
  /** End of the paid time, ISO. Later periods already bought are included: renewing early extends it. */
  endsAt: string;
  /** endsAt plus PRO_PREPAID_GRACE_DAYS: the Server drops to Free after this. */
  graceEndsAt: string;
  /** Paid time is over and the grace days are running. */
  inGrace: boolean;
  /** Seats bought for now (in grace, the seats at the end). */
  seatQuantity: number;
}

export interface BillingEntitlementProjection {
  plan: ServerPlan;
  /** Present only for an active AppSumo license bound to this server. */
  appsumo?: AppSumoEntitlement;
  /** Present only when prepaid Pro time is what makes this Server Pro. */
  prepaid?: PrepaidEntitlement;
  status?: "active" | "past_due" | "canceled" | "incomplete" | null;
  billingInterval?: BillingInterval | null;
  provisionedHumanSeats?: number | null;
  provisionedAgentSeats?: number | null;
  /** Purchased Pro seats. Kept as proPackQuantity for storage/API compatibility. */
  proPackQuantity?: number | null;
  /** Deprecated storage/API fields; current Pro Seat billing always projects zero/null. */
  trialFreePackQuantity?: number | null;
  firstPackTrialEndsAt?: string | Date | null;
}

export interface BillingPriceSummary {
  billingInterval: BillingInterval;
  monthlyUsd: number;
  annualUsd: number | null;
  discountPercent: number;
  baseMonthlyUsd: number;
  overageMonthlyUsd: number;
  seatQuantity: number;
  packQuantity: number;
  humanSeatQuantity: number;
  agentSeatQuantity: number;
  agentSeatBlockQuantity: number;
}

export const PRO_SEAT_MONTHLY_USD = 10;
export const PRO_AGENT_SEAT_BLOCK_SIZE = 10;
export const PRO_AGENT_SEAT_FRACTION = 1 / PRO_AGENT_SEAT_BLOCK_SIZE;
export const PRO_SEAT_ANNUAL_MONTHLY_USD = 8.8;
export const PRO_SEAT_ANNUAL_USD = 105.6;
export const PRO_PACK_ANNUAL_DISCOUNT_PERCENT = 12;
export const PRO_HUMAN_SEAT_MONTHLY_USD = PRO_SEAT_MONTHLY_USD;
export const PRO_AGENT_SEAT_BLOCK_MONTHLY_USD = PRO_SEAT_MONTHLY_USD;
export const PRO_SEAT_LINE_ANNUAL_MONTHLY_USD = PRO_SEAT_ANNUAL_MONTHLY_USD;
export const PRO_HUMAN_SEAT_ANNUAL_USD = PRO_SEAT_ANNUAL_USD;
export const PRO_AGENT_SEAT_BLOCK_ANNUAL_USD = PRO_SEAT_ANNUAL_USD;
export const PRO_PACK_HUMAN_SEATS = 1;
export const PRO_PACK_AGENT_SEATS = PRO_AGENT_SEAT_BLOCK_SIZE;
export const PRO_PACK_MONTHLY_USD = PRO_SEAT_MONTHLY_USD;
export const PRO_PACK_ANNUAL_MONTHLY_USD = PRO_SEAT_ANNUAL_MONTHLY_USD;
export const PRO_PACK_ANNUAL_USD = PRO_SEAT_ANNUAL_USD;

// ── Prepaid Pro (task #19, #proj-commercial) ──
// Paid once (Alipay; Stripe has no Alipay subscriptions without an invite), no
// auto-renewal. Owners decided the periods (#proj-commercial:1d784041): a month
// or a year, as the subscription (no quarter, yezizp 2026-11-04). Prices
// live in Stripe as one-time Prices (docs/billing/prepaid-pro.md); clients get
// them from GET /api/billing/prepaid/offer, never from here.

export const PRO_PREPAID_MONTHS = [1, 12] as const;
export type ProPrepaidMonths = (typeof PRO_PREPAID_MONTHS)[number];
/** Days a lapsed prepaid period keeps Pro, with a reminder each day, before the Server drops to Free. */
export const PRO_PREPAID_GRACE_DAYS = 3;

export function isProPrepaidMonths(value: unknown): value is ProPrepaidMonths {
  return typeof value === "number" && (PRO_PREPAID_MONTHS as readonly number[]).includes(value);
}

/** One period on offer, priced by Stripe (minor units, per seat, for the whole period). */
export interface PrepaidOfferPeriod {
  months: ProPrepaidMonths;
  unitAmount: number;
  currency: string;
}

/** Why a prepaid checkout cannot start now; null when it can. */
export type PrepaidOfferUnavailableReason =
  | "disabled"            // pro_prepaid is off for this Server
  | "not_configured"      // Stripe or its prepaid Prices are missing
  | "other_paid_source";  // a subscription, AppSumo, founder/partner or Pro by hand

/** GET /api/billing/prepaid/offer (owners and admins). */
export interface PrepaidOffer {
  unavailableReason: PrepaidOfferUnavailableReason | null;
  /** Empty unless prices could be read. */
  periods: PrepaidOfferPeriod[];
  graceDays: number;
  /** Seats in use, rounded up (at least 1): a checkout may not buy fewer. */
  minimumSeatQuantity: number;
  /** Seats the current prepaid time has, else minimumSeatQuantity. */
  defaultSeatQuantity: number;
  /** Where a period bought now would start: the paid end while time or grace is left, else null (now). */
  renewalStartsAt: string | null;
}

/** Why seats cannot be added to prepaid time now; null when they can. */
export type PrepaidSeatsQuoteUnavailableReason =
  | "disabled"        // pro_prepaid is off for this Server
  | "not_configured"  // Stripe or its prepaid Prices are missing
  | "not_prepaid"     // no prepaid time on the Server (or another paid source)
  | "in_grace";       // the paid time has ended: renew instead

/**
 * GET /api/billing/prepaid/seats/quote (owners and admins): what adding seats
 * to the prepaid time costs now, by the days left (a started day counts
 * whole). The seats count from payment to `endsAt`, the end of the paid time.
 */
export interface PrepaidSeatsQuote {
  unavailableReason: PrepaidSeatsQuoteUnavailableReason | null;
  seatQuantity: number;
  /** Per added seat for the time left, in minor units; 0 when unavailable. */
  unitAmount: number;
  /** What the Checkout charges, in minor units (at least Stripe's minimum). */
  amountTotal: number;
  currency: string;
  /** The end of the paid time; null when unavailable. */
  endsAt: string | null;
  /** Days charged, summed over the paid periods left. */
  days: number;
  /** The amount was raised to Stripe's minimum charge. */
  minimumApplied: boolean;
}

export const PLAN_CONFIG: Record<ServerPlan, PlanConfig> = {
  free: {
    displayName: "Free",
    limits: { maxMachines: -1, maxAgents: -1, maxChannels: -1, messageHistoryDays: 30, includedAgents: -1 },
    comingSoon: false,
    price: 0,
    extraAgentPrice: 0,
    displayFeatures: [
      "Channels",
      "Tasks",
      "Agents on your own computers",
      "Agent reminders",
      "Basic observability",
      "30 days of message history",
      "100 MB file uploads/month",
    ],
  },
  founder: {
    displayName: "Founder",
    limits: { maxMachines: -1, maxAgents: -1, maxChannels: -1, messageHistoryDays: -1, includedAgents: -1 },
    comingSoon: false,
    price: 0,
    extraAgentPrice: 0,
  },
  partner: {
    displayName: "Partner",
    limits: { maxMachines: -1, maxAgents: -1, maxChannels: -1, messageHistoryDays: -1, includedAgents: -1 },
    comingSoon: false,
    price: 0,
    extraAgentPrice: 0,
  },
  pro: {
    displayName: "Pro",
    limits: { maxMachines: -1, maxAgents: PRO_PACK_AGENT_SEATS, maxChannels: -1, messageHistoryDays: -1, includedAgents: PRO_PACK_AGENT_SEATS },
    comingSoon: false,
    price: PRO_SEAT_MONTHLY_USD,
    extraAgentPrice: 0,
  },
};

/** Display-only plan configs for the pricing comparison UI. */
export const DISPLAY_PLAN_CONFIG: Record<DisplayPlan, PlanConfig> = {
  free: PLAN_CONFIG.free,
  pro: {
    displayName: "Pro",
    limits: { maxMachines: -1, maxAgents: -1, maxChannels: -1, messageHistoryDays: -1, includedAgents: -1 },
    comingSoon: false,
    price: PRO_SEAT_MONTHLY_USD,
    priceCadence: "/ seat / month",
    extraAgentPrice: 0,
    displayFeatures: [
      "Everything in Free",
      "Unlimited message history",
      "Higher file upload limits",
      "Joint channels",
      "More professional features coming soon",
    ],
    displayDescription: "For builders and teams scaling agent collaboration.",
    displayNote: `$${PRO_SEAT_ANNUAL_MONTHLY_USD.toFixed(2)} / seat / month when billed yearly. Each human uses 1 seat; each agent uses ${PRO_AGENT_SEAT_FRACTION} seat.`,
  },
  enterprise: {
    displayName: "Enterprise",
    limits: { maxMachines: -1, maxAgents: -1, maxChannels: -1, messageHistoryDays: -1, includedAgents: -1 },
    comingSoon: false,
    price: 0,
    priceLabel: "Coming soon",
    priceCadence: null,
    extraAgentPrice: 0,
    displayFeatures: [
      "Everything in Pro",
      "Private deployment options",
      "SSO and advanced access control",
      "Dedicated onboarding and rollout support",
    ],
    displayDescription: "For advanced deployment and governance needs.",
  },
};

/** Plans shown in the pricing comparison UI. */
export const DISPLAY_PLANS: DisplayPlan[] = ["free", "pro", "enterprise"];
export type BillingInterval = "monthly" | "annual";
export const DEFAULT_BILLING_INTERVAL: BillingInterval = "annual";
export const FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES = 100 * 1024 * 1024;
export const FREE_SINGLE_FILE_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;
export const PRO_SINGLE_FILE_UPLOAD_LIMIT_BYTES = 200 * 1024 * 1024;

export function getSingleFileUploadLimitBytes(plan: ServerPlan, now: Date = new Date()): number {
  return canUseProBillingFeatures(plan, now)
    ? PRO_SINGLE_FILE_UPLOAD_LIMIT_BYTES
    : FREE_SINGLE_FILE_UPLOAD_LIMIT_BYTES;
}

export function getSingleFileUploadLimitLabel(plan: ServerPlan, now: Date = new Date()): string {
  return canUseProBillingFeatures(plan, now) ? "200MB" : "50MB";
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.ceil(value));
}

/** Start date of the extended free trial for Free plan users. */
export const TRIAL_START_DATE = new Date("2026-04-18T00:00:00Z");

/**
 * End instant of the free full-featured trial.
 * 2026-06-05: extended +7 (51 → 58) per @tygg #proj-release directive (task #7) —
 * trial end 2026-06-08 → 2026-06-15 UTC; TRIAL_START_DATE unchanged.
 * 2026-06-13: final billing acceptance window ends 2026-06-22 UTC (58 → 65);
 * 2026-06-21: keep the trial active through all of 2026-06-22 in every time zone.
 */
export const TRIAL_END_DATE = new Date("2026-06-23T12:00:00Z");

/** Duration retained for UI/compatibility consumers; the actual cutoff is TRIAL_END_DATE. */
export const TRIAL_DURATION_DAYS = (TRIAL_END_DATE.getTime() - TRIAL_START_DATE.getTime()) / (24 * 60 * 60 * 1000);

/** Check if the free trial period is currently active. */
export function isTrialActive(now: Date = new Date()): boolean {
  return now >= TRIAL_START_DATE && now < TRIAL_END_DATE;
}

export function calculateProPackQuantity(provisionedHumans: number, provisionedAgents: number): number {
  return Math.max(1, Math.ceil(nonNegativeInteger(provisionedHumans) + nonNegativeInteger(provisionedAgents) * PRO_AGENT_SEAT_FRACTION));
}

/**
 * Seats in tenths, as an integer: a human is 10, an agent 1. Seat math adds
 * and compares these, never the 0.1 share itself, which drifts in floating
 * point: 1 human and 19 agents sum to 2.9000000000000004, so one more agent
 * came to 3.0000000000000004 and was refused 3 seats it fits exactly.
 */
export function seatTenths(humans: number, agents: number): number {
  return nonNegativeInteger(humans) * PRO_AGENT_SEAT_BLOCK_SIZE + nonNegativeInteger(agents);
}

/** Tenths back to seats, the nearest double to the decimal (29 → 2.9). */
export function seatsFromTenths(tenths: number): number {
  return tenths / PRO_AGENT_SEAT_BLOCK_SIZE;
}

/**
 * Seats to add so `needTenths` more fit beside `usedTenths` within `seats`
 * bought; 0 when it fits (and always for unlimited seats, -1).
 */
export function seatsShortFor(input: { seats: number; usedTenths: number; needTenths: number }): number {
  if (input.seats === -1) return 0;
  return Math.max(0, Math.ceil((input.usedTenths + input.needTenths) / PRO_AGENT_SEAT_BLOCK_SIZE) - input.seats);
}

/**
 * Someone a full invite or join link turned away (task #10, behind
 * `pro_seat_add`), as `GET /api/servers/:id/seat-join-blocks` lists them for
 * the notification center: owners and admins see everyone, a link's creator
 * the people their link turned away. Display names only.
 */
export interface SeatJoinBlock {
  id: string;
  /** Who couldn't join: the id a `join` seat request names. */
  userId: string;
  name: string;
  /** Who made the link or sent the invite they opened; null once that account is gone. */
  inviterUserId: string | null;
  inviterName: string | null;
  createdAt: string;
}

/** A full server's seats, as a seat refusal gives them: bought, and the people and agents taking them. */
export interface SeatJoinSeatUsage {
  seats: number;
  humans: number;
  agents: number;
}

export interface SeatJoinBlocksResponse {
  /** Empty unless the server's seats are still full; never someone who has joined since. */
  blocks: SeatJoinBlock[];
  /** With any blocks: the seats, for a viewer who can't read billing (a link's creator who is a member). */
  usage?: SeatJoinSeatUsage;
}

export function normalizeBillingInterval(value: unknown): BillingInterval {
  return value === "monthly" ? "monthly" : "annual";
}

export function calculateAgentSeatBlockQuantity(agentSeats: number): number {
  return Math.ceil(nonNegativeInteger(agentSeats) / PRO_AGENT_SEAT_BLOCK_SIZE);
}

export function calculateProSeatPrice(
  humanSeatQuantity: number,
  agentSeatQuantity: number,
  billingInterval: BillingInterval = DEFAULT_BILLING_INTERVAL,
): BillingPriceSummary {
  const humans = Math.max(1, nonNegativeInteger(humanSeatQuantity));
  const requestedAgents = nonNegativeInteger(agentSeatQuantity);
  const agentBlocks = calculateAgentSeatBlockQuantity(requestedAgents);
  const seatQuantity = calculateProPackQuantity(humans, requestedAgents);
  const provisionedAgents = seatQuantity * PRO_AGENT_SEAT_BLOCK_SIZE;
  const unitMonthlyUsd = billingInterval === "annual" ? PRO_SEAT_ANNUAL_MONTHLY_USD : PRO_SEAT_MONTHLY_USD;
  const monthlyUsd = seatQuantity * unitMonthlyUsd;
  return {
    billingInterval,
    monthlyUsd,
    annualUsd: billingInterval === "annual"
      ? seatQuantity * PRO_SEAT_ANNUAL_USD
      : null,
    discountPercent: billingInterval === "annual" ? PRO_PACK_ANNUAL_DISCOUNT_PERCENT : 0,
    baseMonthlyUsd: monthlyUsd,
    overageMonthlyUsd: 0,
    seatQuantity,
    packQuantity: seatQuantity,
    humanSeatQuantity: humans,
    agentSeatQuantity: provisionedAgents,
    agentSeatBlockQuantity: agentBlocks,
  };
}

export function calculateProPrice(packQuantity: number, billingInterval: BillingInterval = DEFAULT_BILLING_INTERVAL): BillingPriceSummary {
  const seatQuantity = Math.max(1, nonNegativeInteger(packQuantity));
  const unitMonthlyUsd = billingInterval === "annual" ? PRO_SEAT_ANNUAL_MONTHLY_USD : PRO_SEAT_MONTHLY_USD;
  const monthlyUsd = seatQuantity * unitMonthlyUsd;
  return {
    billingInterval,
    monthlyUsd,
    annualUsd: billingInterval === "annual" ? seatQuantity * PRO_SEAT_ANNUAL_USD : null,
    discountPercent: billingInterval === "annual" ? PRO_PACK_ANNUAL_DISCOUNT_PERCENT : 0,
    baseMonthlyUsd: monthlyUsd,
    overageMonthlyUsd: 0,
    seatQuantity,
    packQuantity: seatQuantity,
    humanSeatQuantity: seatQuantity,
    agentSeatQuantity: seatQuantity * PRO_AGENT_SEAT_BLOCK_SIZE,
    agentSeatBlockQuantity: seatQuantity,
  };
}

export function calculateProMonthlyPrice(packQuantity: number): BillingPriceSummary {
  return calculateProPrice(packQuantity, "monthly");
}

function getTrialFreeLimits(now: Date): PlanLimits {
  return isTrialActive(now)
    ? { maxMachines: -1, maxAgents: -1, maxChannels: -1, messageHistoryDays: -1, includedAgents: -1 }
    : PLAN_CONFIG.free.limits;
}

/** Get the effective limits for a plan. */
export function getEffectiveLimits(plan: ServerPlan, now: Date = new Date()): PlanLimits {
  if (plan === "free") return getTrialFreeLimits(now);
  return PLAN_CONFIG[plan].limits;
}

export function getBillingCapacity(entitlement: BillingEntitlementProjection, now: Date = new Date()): BillingCapacity {
  if (entitlement.plan === "pro" && entitlement.appsumo) {
    const limits = APPSUMO_PLAN_LIMITS[entitlement.appsumo.tier];
    return { maxHumans: limits.maxHumans, maxAgents: limits.maxAgents, maxUniversalSeats: -1 };
  }
  switch (entitlement.plan) {
    case "founder":
    case "partner":
      return { maxHumans: -1, maxAgents: -1, maxUniversalSeats: -1 };
    case "pro": {
      const fallbackPacks = Math.max(1, nonNegativeInteger(entitlement.proPackQuantity ?? 1));
      return {
        maxHumans: -1,
        maxAgents: -1,
        maxUniversalSeats: fallbackPacks,
      };
    }
    case "free": {
      const limits = getEffectiveLimits("free", now);
      return { maxHumans: -1, maxAgents: limits.maxAgents, maxUniversalSeats: -1 };
    }
  }
}

export function getBillingUsage(humans: number, agents: number): BillingUsage {
  const safeHumans = nonNegativeInteger(humans);
  const safeAgents = nonNegativeInteger(agents);
  return {
    humans: safeHumans,
    agents: safeAgents,
    universalSeats: seatsFromTenths(seatTenths(safeHumans, safeAgents)),
  };
}

export function getBillingCapacityLimitState(
  capacity: BillingCapacity,
  usage: BillingUsage,
  kind: BillingCapacityKind,
): BillingCapacityLimitState {
  if (kind === "human" && capacity.maxHumans !== -1 && usage.humans + 1 > capacity.maxHumans) {
    return {
      reached: true,
      limitType: "human",
      usage: usage.humans,
      limit: capacity.maxHumans,
      nextUsage: usage.humans + 1,
    };
  }
  if (kind === "agent" && capacity.maxAgents !== -1 && usage.agents + 1 > capacity.maxAgents) {
    return {
      reached: true,
      limitType: "agent",
      usage: usage.agents,
      limit: capacity.maxAgents,
      nextUsage: usage.agents + 1,
    };
  }
  if (capacity.maxUniversalSeats !== -1) {
    // In tenths, so 2.9 seats used + one agent fits 3 seats exactly.
    const nextTenths = Math.round(usage.universalSeats * PRO_AGENT_SEAT_BLOCK_SIZE)
      + (kind === "human" ? PRO_AGENT_SEAT_BLOCK_SIZE : 1);
    const nextUniversalSeats = seatsFromTenths(nextTenths);
    if (nextTenths > capacity.maxUniversalSeats * PRO_AGENT_SEAT_BLOCK_SIZE) {
      return {
        reached: true,
        limitType: "universal",
        usage: usage.universalSeats,
        limit: capacity.maxUniversalSeats,
        nextUsage: nextUniversalSeats,
      };
    }
  }
  return {
    reached: false,
    limitType: null,
    usage: kind === "human" ? usage.humans : usage.agents,
    limit: -1,
    nextUsage: kind === "human" ? usage.humans + 1 : usage.agents + 1,
  };
}

export function getBillingCapacityLimitLabel(kind: BillingCapacityKind, limitType: BillingCapacityLimitState["limitType"]): string {
  if (limitType === "universal") return "Seat limit";
  if (limitType === "human" || kind === "human") return "Human seat limit";
  return "Agent limit";
}

export function formatBillingCapacityLimitMessage(
  kind: BillingCapacityKind,
  capacityState: BillingCapacityLimitState,
  planDisplayName: string,
  suffix = "",
): string {
  const label = getBillingCapacityLimitLabel(kind, capacityState.limitType);
  return `${label} reached (${capacityState.usage}/${capacityState.limit} on ${planDisplayName} plan).${suffix}`;
}

export function formatProAgentSeatFraction(): string {
  return Number.isInteger(PRO_AGENT_SEAT_FRACTION)
    ? String(PRO_AGENT_SEAT_FRACTION)
    : String(Number(PRO_AGENT_SEAT_FRACTION.toFixed(6)));
}

export function canUseProBillingFeatures(plan: ServerPlan, now: Date = new Date()): boolean {
  return plan === "pro" || plan === "founder" || plan === "partner" || (plan === "free" && isTrialActive(now));
}

export const canUseTeamBillingFeatures = canUseProBillingFeatures;

// ── Downgrade Grace Period ──

export const DOWNGRADE_GRACE_PERIOD_DAYS = 7;

// ── Onboarding: #all reveal ──

/**
 * Under the onboarding opener, the virtual `#all` channel is born hidden and
 * reveals once the server has grown into a team — total members (humans +
 * agents) reaching this threshold. Baseline onboarding is owner (1 human) +
 * the Cindy OA (1 agent) = 2, so a 3rd member of either kind unlocks #all.
 */
export const ALL_CHANNEL_TEAM_THRESHOLD = 3;

// ── Name Validation ──

/**
 * Regex for valid `name` fields (user, agent, channel).
 * Must start with a letter; rest can be letters, digits, underscore, hyphen.
 * Disallows: pure numbers, leading digits, spaces, @, #, and other special characters.
 */
export const NAME_REGEX = /^[\p{L}][\p{L}\p{N}_-]*$/u;
export const NAME_MIN_LENGTH = 1;
export const NAME_MAX_LENGTH = 32;
export const RESERVED_AGENT_NAMES = [
  "all",
  "human",
  "humans",
  "agent",
  "agents",
  "here",
  "idle",
  "busy",
  "system",
  // `dm:@reminders` names each agent's private reminder conversation.
  "reminders",
] as const;

/** Validate a name and return an error message, or null if valid.
 *  Pass `minLength` to override the default minimum (e.g. 5 for user/server names). */
/**
 * Why a name is invalid, as data rather than an English sentence.
 *
 * `validateName` interpolates a label into an English frame, so a UI that
 * localizes only the label produces a MIXED-LANGUAGE string ("频道名称 is
 * required") -- worse than leaving it English. Localized surfaces take the
 * reason and format the whole sentence from their own catalog.
 */
export type NameValidationReason =
  | { code: "required" }
  | { code: "tooShort"; minLength: number }
  | { code: "tooLong"; maxLength: number }
  | { code: "pattern" };

export function validateNameReason(
  name: string,
  minLength = NAME_MIN_LENGTH,
): NameValidationReason | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return { code: "required" };
  if (trimmed.length < minLength) return { code: "tooShort", minLength };
  if (trimmed.length > NAME_MAX_LENGTH) return { code: "tooLong", maxLength: NAME_MAX_LENGTH };
  if (!NAME_REGEX.test(trimmed)) return { code: "pattern" };
  return null;
}

/**
 * English-sentence form, for server responses and unmigrated callers. Built on
 * validateNameReason so the two can never disagree about what is valid.
 */
export function validateName(name: string, label = "Name", minLength = NAME_MIN_LENGTH): string | null {
  const reason = validateNameReason(name, minLength);
  if (!reason) return null;
  switch (reason.code) {
    case "required":
      return `${label} is required`;
    case "tooShort":
      return `${label} must be at least ${reason.minLength} characters`;
    case "tooLong":
      return `${label} must be at most ${reason.maxLength} characters`;
    case "pattern":
      return `${label} must start with a letter and can only contain letters, numbers, hyphens, and underscores`;
  }
}

export function isReservedAgentName(name: string): boolean {
  const normalized = name.trim().replace(/^@/, "").toLowerCase();
  return (RESERVED_AGENT_NAMES as readonly string[]).includes(normalized);
}

export type AgentNameValidationReason =
  | NameValidationReason
  | { code: "reserved"; handle: string };

export function validateAgentNameReason(name: string): AgentNameValidationReason | null {
  if (name.trim().length === 0) return { code: "required" };
  if (isReservedAgentName(name)) {
    return { code: "reserved", handle: name.trim().replace(/^@/, "").toLowerCase() };
  }
  return validateNameReason(name);
}

export function validateAgentName(name: string, label = "Agent name"): string | null {
  const reason = validateAgentNameReason(name);
  if (!reason) return null;
  if (reason.code === "reserved") {
    return `${label} @${reason.handle} is reserved. Choose another name.`;
  }
  return validateName(name, label);
}

// ── Announcements ──

/** A single page inside a paginated announcement. */
export interface AnnouncementPage {
  title?: string;
  body: string;
}

/** Fully translated content for one renderable display locale. */
/** Announcement content is authored only for display locales shipped by Raft. */
export type AnnouncementContentByLocale = Partial<Record<DisplayLocale, AnnouncementContent>>;

/** An account-level popup announcement. Shown exactly once per user (by id)
 *  until dismissed; a new announcement always means a new id. */
export interface Announcement extends AnnouncementPresentation {
  id: string;
  title: string;
  pages: AnnouncementPage[];
  publishedAt: string;
  startsAt: string;
  endsAt: string | null;
  locale: DisplayLocale;
  /** Additive for installed clients; omitted legacy values mean version 1/account scope. */
  deliveryVersion?: number;
  deliveryScope?: import("../announcement-audience").AnnouncementDeliveryScope;
}

/**
 * Most sidebar cards one app entry shows, highest priority first. A dialog is
 * always shown alone; dialog and sidebar cards never share an entry.
 */
export const ANNOUNCEMENT_SIDEBAR_STACK_MAX = 5;

// ── Daemon Version ──

const SEMVER_TRIPLE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Parse `MAJOR.MINOR.PATCH` strictly. Returns null on any non-digit
 *  segment (incl. NaN-producing inputs like `"abc"` or `"0.0.62-rc1"`).
 *  Used by the comparison helpers below so a malformed input never
 *  silently becomes [NaN] and confuses the loop. */
function parseSemverTriple(v: string): [number, number, number] | null {
  const m = v.match(SEMVER_TRIPLE);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Check if a daemon version is outdated (below the latest known version).
 *  Returns false on missing or unparseable inputs (prefer-miss-over-mistrigger
 *  per [[feedback_client_gate_live_only_field]] family — a malformed version
 *  must not trigger "update available" or hard-disable the upgrade button). */
export function isDaemonOutdated(version: string | null | undefined, latestVersion: string | null | undefined): boolean {
  if (!version || !latestVersion) return false;
  const cur = parseSemverTriple(version);
  const latest = parseSemverTriple(latestVersion);
  if (cur === null || latest === null) return false;
  for (let i = 0; i < 3; i++) {
    if (cur[i] < latest[i]) return true;
    if (cur[i] > latest[i]) return false;
  }
  return false; // equal = not outdated
}

// ── Computer Version ──

/** Check if a managed-Computer (`@botiverse/raft-computer`) version is below
 *  the latest known. Same semantics as `isDaemonOutdated` (and the menu-bar
 *  app's `semverGreater` — Yingjun guardian note: don't fork "what counts as
 *  newer" between web / menu-bar, otherwise the menu says "update available"
 *  while the dashboard says nothing). Returns false on missing or
 *  unparseable inputs (prefer-miss-over-mis-trigger). */
export function isComputerOutdated(version: string | null | undefined, latestVersion: string | null | undefined): boolean {
  return isDaemonOutdated(version, latestVersion);
}

/** Full SemVer 2.0.0 (prerelease and build metadata allowed, no leading zeros
 *  in numeric parts). The form the server's upgrade policy accepts for a
 *  Computer's reported version and a published release; staging / rc / branch
 *  builds report prerelease versions such as `1.0.41-staging.<ts>.sha.<sha>`. */
const COMPUTER_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

export function isComputerSemver(value: string): boolean {
  if (!COMPUTER_SEMVER.test(value)) return false;
  const pre = value.split("+", 1)[0]!.split("-").slice(1).join("-");
  return !pre.split(".").some((part) => /^0\d+$/.test(part));
}

/** SemVer precedence of two Computer versions (-1 / 0 / 1); build metadata is
 *  ignored and a prerelease sorts below its release. The server's upgrade
 *  policy uses this for `already_current`; the web uses it for "is a newer
 *  version available". Both inputs must pass `isComputerSemver`. */
export function compareComputerVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const withoutBuild = value.split("+", 1)[0]!;
    const separator = withoutBuild.indexOf("-");
    return {
      core: (separator < 0 ? withoutBuild : withoutBuild.slice(0, separator)).split(".").map(BigInt),
      pre: separator < 0 ? null : withoutBuild.slice(separator + 1).split("."),
    };
  };
  const a = parse(left), b = parse(right);
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i]! < b.core[i]! ? -1 : 1;
  }
  if (a.pre === null || b.pre === null) return a.pre === b.pre ? 0 : a.pre === null ? 1 : -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Oldest Computer the web drives a remote upgrade v2 (task #873) on. v2 itself
 * landed in 1.0.37, but from 1.0.37–1.0.44 the old service's own upgrade path
 * proved unreliable in production: over 24 h (2026-10-18) 4 of 11 web upgrades
 * from ≤1.0.44 never took effect (acknowledged, then silent until the deadline,
 * or rolled back), against 11 of 11 from ≥1.0.45. Older Computers are not
 * driven from the web; the web shows a one-time hint to upgrade locally instead.
 */
export const COMPUTER_REMOTE_UPGRADE_MIN_VERSION = "1.0.45";

/** null when the version is unknown; otherwise whether the web may drive an
 *  upgrade. Full SemVer, fail-closed: a version that is not SemVer is not
 *  supported, and a prerelease sorts below its release (1.0.45-rc.1 is below
 *  1.0.45). The server projection and the upgrade route's guard both use this. */
export function isRemoteUpgradeSupported(version: string | null | undefined): boolean | null {
  const trimmed = version?.trim();
  if (!trimmed) return null;
  if (!isComputerSemver(trimmed)) return false;
  return compareComputerVersions(trimmed, COMPUTER_REMOTE_UPGRADE_MIN_VERSION) >= 0;
}

// ── Computer version floor (quarantine) ──
//
// Below the floor, and once the deadline has passed, the server keeps a
// Computer's connection but sends it no agent work (no agent:start, deliveries
// held) until it reconnects on a supported version. Before the deadline the
// gate is shown as a hint only. Upgrade and Computer control commands are
// never held: upgrading is the way out.

export type ComputerVersionGateReason = "computer_version_unsupported" | "computer_version_unknown";

/**
 * Why the agent list says an agent is not run (`blockedReason`): its Computer
 * is held below the version floor, or (reconciler step 15, B15) its Computer's
 * access was revoked: the agent stays bound to it and gets no wakes until it
 * is moved or the Computer is attached again. Additive: a client that does not
 * know a value shows the agent's ordinary state.
 */
export type AgentBlockedReason = ComputerVersionGateReason | "computer_access_revoked";

export interface ComputerVersionGate {
  /** `computer_version_unknown`: the Computer reported no (SemVer) version. */
  reason: ComputerVersionGateReason;
  minVersion: string;
  /** When the floor is (or will be) enforced; null when no deadline is set. */
  enforcedAt: string | null;
  /** True once agents on this Computer are no longer run. */
  enforced: boolean;
}

export interface ComputerVersionFloorPolicy {
  minVersion: string;
  /** ISO time after which the floor is enforced; null = hint only. */
  enforceAt: string | null;
  /** Emergency stop: false keeps every gate a hint. */
  enforcementEnabled: boolean;
}

/**
 * The gate for one Computer, or null when it is at or above the floor. The
 * comparison uses the release (major.minor.patch) only, so a prerelease or
 * staging build of the floor version (1.0.47-rc.1) is not gated.
 */
export function evaluateComputerVersionGate(
  version: string | null | undefined,
  policy: ComputerVersionFloorPolicy | null,
  nowMs: number,
): ComputerVersionGate | null {
  if (!policy || !isComputerSemver(policy.minVersion)) return null;
  const trimmed = version?.trim() ?? "";
  const known = trimmed !== "" && isComputerSemver(trimmed);
  const release = (value: string) => value.split("+", 1)[0]!.split("-", 1)[0]!;
  if (known && compareComputerVersions(release(trimmed), release(policy.minVersion)) >= 0) return null;
  const enforceAtMs = policy.enforceAt ? Date.parse(policy.enforceAt) : NaN;
  return {
    reason: known ? "computer_version_unsupported" : "computer_version_unknown",
    minVersion: policy.minVersion,
    enforcedAt: Number.isFinite(enforceAtMs) ? new Date(enforceAtMs).toISOString() : null,
    enforced: policy.enforcementEnabled && Number.isFinite(enforceAtMs) && nowMs >= enforceAtMs,
  };
}

/**
 * The Computer version floor (#proj-o11y, 2026-10-19). Change the floor or its
 * enforcement date here and nowhere else.
 *
 * - `minVersion`: the oldest Computer that gets no outdated notice. Between
 *   COMPUTER_REMOTE_UPGRADE_MIN_VERSION and this floor a Computer is asked to
 *   upgrade (the web's one-click upgrade still works there); below
 *   COMPUTER_REMOTE_UPGRADE_MIN_VERSION, or with no version at all, it needs a
 *   reinstall because the web cannot drive its upgrade.
 * - `enforcedAt`: ISO time from which Computers below the floor stop running
 *   agents; null while no date is set.
 *
 * The web's fallback for servers that do not send a per-machine `versionGate`
 * yet (see evaluateComputerVersionGate); keep it equal to the server's default
 * floor.
 */
export const COMPUTER_VERSION_FLOOR: { readonly minVersion: string; readonly enforcedAt: string | null } = {
  minVersion: "1.0.47",
  enforcedAt: null,
};

/**
 * Where a reported Computer version sits against a floor (default
 * COMPUTER_VERSION_FLOOR.minVersion), the way evaluateComputerVersionGate
 * judges it (release part only, so 1.0.47-rc.1 meets a 1.0.47 floor).
 * `unreported`: no version (very old Computers never send one; callers decide
 * whether "none yet" is final). `unparseable`: a version that is not SemVer
 * (the server gates it as computer_version_unknown). Below the floor, a version
 * the web can still upgrade (COMPUTER_REMOTE_UPGRADE_MIN_VERSION) is `upgrade`,
 * an older one `reinstall`. A floor that is not SemVer falls back to the default.
 */
export type ComputerVersionFloorStanding = "current" | "upgrade" | "reinstall" | "unreported" | "unparseable";

export function getComputerVersionFloorStanding(
  version: string | null | undefined,
  minVersion: string = COMPUTER_VERSION_FLOOR.minVersion,
): ComputerVersionFloorStanding {
  const trimmed = version?.trim();
  if (!trimmed) return "unreported";
  if (!isComputerSemver(trimmed)) return "unparseable";
  const floor = isComputerSemver(minVersion) ? minVersion : COMPUTER_VERSION_FLOOR.minVersion;
  const release = (value: string) => value.split("+", 1)[0]!.split("-", 1)[0]!;
  if (compareComputerVersions(release(trimmed), release(floor)) >= 0) return "current";
  return compareComputerVersions(trimmed, COMPUTER_REMOTE_UPGRADE_MIN_VERSION) < 0 ? "reinstall" : "upgrade";
}

// ── Server system notification feed ──
//
// Machine operational notices used to be re-derived independently by Web and
// KMP from `/machines`. This wire contract makes the server the sole authority
// for receiver eligibility, condition evaluation, copy parameters, severity,
// and dedupe identity. Consumers render this snapshot, keep dismissal state
// locally by `notification.id`, and must not re-evaluate machine state.
export const SERVER_SYSTEM_NOTIFICATIONS_CONTRACT_VERSION = "server-system-notifications-v1" as const;
export const MACHINE_SYSTEM_NOTIFICATION_SCHEMA_VERSION = 1 as const;

export type ServerSystemNotificationKind = "error" | "warning" | "info";
/** Same threshold as the cleaner's low-disk check (apps/cleaner/configProtocol). */
export const MACHINE_DISK_LOW_FREE_PERCENT = 10;
/**
 * At or above this much free space a disk is never "low", whatever the
 * percentage: 10% of a 2 TB disk is still 200 GB.
 */
export const MACHINE_DISK_LOW_MAX_AVAILABLE_BYTES = 20 * 1024 ** 3;

/** Latest disk report of a connected machine; byte counts are whole numbers. */
export interface MachineDiskStatus {
  availableBytes: number;
  totalBytes: number;
}

export function isValidMachineDiskStatus(value: unknown): value is MachineDiskStatus {
  if (!value || typeof value !== "object") return false;
  const { availableBytes, totalBytes } = value as Record<string, unknown>;
  return typeof availableBytes === "number" && typeof totalBytes === "number"
    && Number.isSafeInteger(availableBytes) && Number.isSafeInteger(totalBytes)
    && availableBytes >= 0 && totalBytes > 0 && availableBytes <= totalBytes;
}

/** Latest memory report of a connected machine; same shape and rules as the disk report. */
export type MachineMemoryStatus = MachineDiskStatus;

export function isValidMachineMemoryStatus(value: unknown): value is MachineMemoryStatus {
  return isValidMachineDiskStatus(value);
}

/** The one low-disk rule shared by the cleaner, the server and the web. */
export function isMachineDiskLow(disk: MachineDiskStatus | null | undefined): boolean {
  if (!disk) return false;
  return disk.availableBytes < MACHINE_DISK_LOW_MAX_AVAILABLE_BYTES
    && disk.availableBytes / disk.totalBytes * 100 < MACHINE_DISK_LOW_FREE_PERCENT;
}

export type MachineSystemNotificationType = "machine.offline" | "machine.outdated";
export type MachineSystemNotificationTitleCopyKey =
  | "machine.offline.title.one"
  | "machine.offline.title.many"
  | "machine.outdated.title.one"
  | "machine.outdated.title.many";
export type MachineSystemNotificationBodyCopyKey =
  | "machine.offline.body.active.one"
  | "machine.offline.body.active.many"
  | "machine.offline.body.idle.one"
  | "machine.offline.body.idle.many"
  | "machine.outdated.body";

export interface MachineSystemNotificationMachine {
  id: string;
  name: string;
}

export interface MachineSystemNotificationEvaluation {
  /** Eligibility is evaluated only against server-authoritative state. */
  clock: "server";
  evaluatedAt: string;
  /** No client timer: once canonical machine status is offline, it is eligible. */
  offlineAfterMs: 0;
  statusAuthority: "canonical_machine_read_model";
  /** Managed Computers intentionally use their separate aggregate attention contract. */
  runKind: "raw_daemon";
  /** Outdated means the raw daemon version trails the server release target. */
  versionAuthority: "latest_daemon_release";
}

export interface MachineSystemNotification {
  id: string;
  type: MachineSystemNotificationType;
  schemaVersion: typeof MACHINE_SYSTEM_NOTIFICATION_SCHEMA_VERSION;
  state: "active";
  kind: Exclude<ServerSystemNotificationKind, "info">;
  title: string;
  body: string;
  /** Stable localization descriptor; title/body remain English fallbacks. */
  copy: {
    titleKey: MachineSystemNotificationTitleCopyKey;
    bodyKey: MachineSystemNotificationBodyCopyKey;
    actionLabelKey: "common.view";
    params: {
      machineNames: string;
      machineCount: number;
      activeAgentCount: number;
      targetDaemonVersion: string | null;
    };
  };
  action: {
    label: "View";
    targetType: "machine";
    targetId: string;
  };
  payload: {
    machines: MachineSystemNotificationMachine[];
    activeAgentCount: number;
    targetDaemonVersion: string | null;
    evaluation: MachineSystemNotificationEvaluation;
  };
}

export interface ServerSystemNotificationsResponse {
  contractVersion: typeof SERVER_SYSTEM_NOTIFICATIONS_CONTRACT_VERSION;
  generatedAt: string;
  /** The response is the complete active set for this receiver and server. */
  snapshotMode: "replace";
  /** Opening the center does not create a read receipt; dismiss stays local. */
  clientState: {
    read: "none";
    dismiss: "local_by_notification_id";
  };
  notifications: MachineSystemNotification[];
}

/** True iff BOTH versions are present AND parse as `MAJOR.MINOR.PATCH`. The
 *  Computer-Upgrade gate uses this as a precondition to "we positively know
 *  there's nothing to upgrade" — otherwise a malformed string slipping in
 *  (cosmic ray / corrupted ready msg / future tag like `0.0.62-rc1`) would
 *  silently get treated as "up to date" and disable the button. Pair with
 *  `!isComputerOutdated(...)` for the full positive-no-upgrade check. */
export function bothComputerVersionsKnown(version: string | null | undefined, latestVersion: string | null | undefined): boolean {
  if (!version || !latestVersion) return false;
  return parseSemverTriple(version) !== null && parseSemverTriple(latestVersion) !== null;
}

export {
  TRACE_JOIN_KEYS,
  TRACE_ENTITY_FILTERABLE_DIMENSIONS,
  TRACE_FAMILY_REGISTRY,
  InvalidTraceEntityDimensionError,
  assertTraceFamilyEntityFilterable,
  traceFamilyRegistration,
  type TraceFamilyConsumer,
  type TraceFamilyName,
  type TraceFamilyRegistration,
  type TraceJoinKey,
  type TraceEntityFilterableDimension,
  type TracePrivacyTier,
} from "./tracing/traceFamilyRegistry";

export {
  STATE_TRANSITION_DOMAINS,
  STATE_TRANSITION_JOIN_FIELDS,
  STATE_TRANSITION_KEY_FIELDS,
  STATE_TRANSITION_META_FIELDS,
  buildStateTransitionTraceAttrs,
  type StateTransitionDomain,
  type StateTransitionOutcome,
  type StateTransitionTraceAttrs,
  type StateTransitionTraceInput,
  type StateTransitionTraceJoin,
  type StateTransitionTraceKey,
  type StateTransitionTraceMeta,
} from "./tracing/stateTransitionTrace";

export {
  STATE_VIOLATION_JOIN_FIELDS,
  STATE_VIOLATION_KEY_FIELDS,
  STATE_VIOLATION_KINDS,
  STATE_VIOLATION_META_FIELDS,
  buildStateViolationTraceAttrs,
  type StateViolationKind,
  type StateViolationTraceAttrs,
  type StateViolationTraceInput,
  type StateViolationTraceJoin,
  type StateViolationTraceKey,
  type StateViolationTraceMeta,
} from "./tracing/stateViolationTrace";

// ── Signup survey ──
//
// Asked once, between email verification and identity setup.
//
// The "how did you hear about us" half is NOT new: `referralSource` already exists
// on users, is already written by PATCH /api/auth/me, and already has a canonical
// option set that the owner-onboarding modal asks with. These are those exact
// values, lifted here so both surfaces read one list instead of two copies drifting.
// Changing a value here is a data migration, not a copy edit.
export const REFERRAL_SOURCES = [
  { id: "twitter_x", label: "Twitter / X" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "friend_colleague", label: "A friend or colleague" },
  { id: "search", label: "Search" },
  { id: "hn_reddit", label: "Hacker News / Reddit" },
  { id: "podcast_blog_newsletter", label: "Podcast / blog / newsletter" },
  { id: "other", label: "Other" },
] as const;

// The role IS new (no prior field existed; `users.role` is server membership, not
// occupation). Aimed at who actually adopts an agent platform, and at what would
// genuinely change how the onboarding agent introduces Raft.
export const SIGNUP_ROLES = [
  { id: "software_engineer", label: "Software engineer" },
  { id: "engineering_leader", label: "Tech lead" },
  { id: "founder", label: "Founder" },
  { id: "product", label: "Product manager" },
  { id: "design", label: "Designer" },
  { id: "data_ml", label: "Data / ML" },
  { id: "devops_it", label: "DevOps / IT" },
  { id: "student", label: "Student or learner" },
  { id: "other", label: "Other" },
] as const;

export type ReferralSourceId = typeof REFERRAL_SOURCES[number]["id"];
export type SignupRoleId = typeof SIGNUP_ROLES[number]["id"];

/**
 * Retired option ids: still accepted on write and labelled on read, just no longer
 * offered. Empty today. `hn_reddit` deliberately stays a single combined option:
 * it already has real rows behind it, and splitting it would strand them.
 */
export const REFERRAL_SOURCES_LEGACY = [] as ReadonlyArray<{ id: string; label: string }>;

export function isReferralSourceId(value: unknown): value is ReferralSourceId {
  return typeof value === "string" && REFERRAL_SOURCES.some((source) => source.id === value);
}

/** Write-side validation: current options, plus retired ids older clients may still send. */
export function isAcceptedReferralSourceId(value: unknown): boolean {
  return isReferralSourceId(value)
    || (typeof value === "string" && REFERRAL_SOURCES_LEGACY.some((source) => source.id === value));
}

/** Read-side label, including retired ids so historical rows still render. */
export function referralSourceLabel(id: string | null | undefined): string | null {
  return [...REFERRAL_SOURCES, ...REFERRAL_SOURCES_LEGACY].find((source) => source.id === id)?.label ?? null;
}

export function isSignupRoleId(value: unknown): value is SignupRoleId {
  return typeof value === "string" && SIGNUP_ROLES.some((role) => role.id === value);
}

/** Human-readable role, for the onboarding agent's briefing. */
export function signupRoleLabel(id: string | null | undefined): string | null {
  return SIGNUP_ROLES.find((role) => role.id === id)?.label ?? null;
}

export * from "./canonicalMessageManifest";
export * from "./canonicalMessageV2";
export * from "./agentMigrationResumable";
export * from "./agentMigrationRetry";
export * from "./agentMigrationUserIgnore";
export * from "./agentArchive";
export * from "./discussionGraph";
export * from "./managedMcp";
export * from "./providerConnections";
export * from "./providerProbes";


// ── Identity setup: who still owes us a handle ──
//
// A brand-new account is created with a placeholder handle (`pending_<hex>`) and no
// `profileSetupCompletedAt`, and it is sent to "Set up your account". The completion
// TIMESTAMP is the record of that; the HANDLE is the fact itself.
//
// They can disagree. A migration backfill that misses a row leaves a long-standing user
// with a real handle and a NULL timestamp — and reading the NULL alone drags them back
// through signup, asking them to choose a username they picked years ago (and cannot
// change afterwards). So the absence of a record never outweighs the presence of the
// thing it was supposed to record: a real handle means identity setup is done, stamp or
// no stamp. Only a placeholder still owes us anything.
export const PROFILE_SETUP_PLACEHOLDER_PREFIX = "pending_";

export function hasPlaceholderHandle(name: string | null | undefined): boolean {
  return !!name && name.toLowerCase().startsWith(PROFILE_SETUP_PLACEHOLDER_PREFIX);
}

export function accountNeedsIdentitySetup(user: {
  name?: string | null;
  profileSetupCompletedAt?: string | Date | null;
}): boolean {
  // Ask the FACT, not the flag that summarises it.
  //
  // This used to short-circuit on `profileSetupCompletedAt` — stamped means set up, whatever
  // the name says. So anything that stamped the date without giving the person a handle
  // produced a user who sailed through the gate still called `pending_7ec59ca5…`, and Cindy
  // greeted them by that. (I made exactly that user by hand and briefly reported the greeting
  // as a product bug; the guard I had climbed around was the one meant to prevent it.)
  //
  // "Has this person got a name" is the question the gate exists to ask, and the row already
  // answers it. The stamp was a proxy for that answer, and a proxy can disagree with the thing
  // it stands for.
  //
  // The legacy case still fails open by construction: a NULL stamp with a real handle is a row
  // the backfill missed, not a person who never set up — and a real handle is a real handle.
  return hasPlaceholderHandle(user.name) || !user.name;
}
export * from "./inboxScopeReadFrontier";

export * from "./channelConversionState";
export * from "./providerRequestActivity";

export * from "./appWhenToUse";

export * from "./raftbenchContract";

export {
  ARTIFACT_EXCERPT_BLOCKS_MAX_BYTES,
  ARTIFACT_EXCERPT_BLOCKS_MAX_ROWS,
  ARTIFACT_EXCERPT_BLOCKS_MAX_SPANS,
  ARTIFACT_EXCERPT_BLOCKS_MAX_TEXT_BYTES,
  ARTIFACT_EXCERPT_CODE_LINE_MAX_CHARS,
  ARTIFACT_EXCERPT_CODE_MAX_LINES,
  ARTIFACT_EXCERPT_IMAGE_ALT_MAX_CHARS,
  ARTIFACT_EXCERPT_IMAGES_MAX_COUNT,
  ARTIFACT_EXCERPT_TABLE_MAX_COLUMNS,
  ARTIFACT_EXCERPT_TABLE_MAX_ROWS,
  parseArtifactExcerptBlocks,
} from "./artifactExcerptBlocks";
export type { ArtifactExcerptBlock, ArtifactExcerptListItem, ArtifactExcerptSpan } from "./artifactExcerptBlocks";
export { ARTIFACT_CHECKED_KINDS, ARTIFACT_DRAFT_MAX_PER_ARTIFACT, ARTIFACT_DRAFT_TTL_DAYS, ARTIFACT_DRAFT_WARN_AFTER_DAYS, ARTIFACT_EXCERPT_MAX_CHARS, ARTIFACT_FRAMED_KINDS, ARTIFACT_INLINE_IMAGE_TYPES, ARTIFACT_PAGE_ANCHOR_MAX_LABEL, ARTIFACT_PAGE_ANCHOR_MAX_QUOTE, ARTIFACT_PAGE_ANCHOR_NAME, ARTIFACT_PAGE_DRAFT_MAX, ARTIFACT_PAGE_TEXT_UNSEEN, asArtifactCommentDraftId, asArtifactCommentId, asArtifactId, asArtifactReviewId, isArtifactCheckedKind, isArtifactFramedKind, isArtifactPageText } from "./workspaceArtifacts";
export { ARTIFACT_LEGACY_HOSTS, ARTIFACT_LINK_FIXED_HOSTS, artifactLinkId, artifactPagePath, isArtifactName, parseArtifactId, parseArtifactRef, parseLegacyArtifactLink, type ParseArtifactRefOptions, type ParsedArtifactRef, type ParsedLegacyArtifactLink } from "./artifactRef";
export { ARTIFACT_SHORT_ID_LENGTH, decodeArtifactShortId, encodeArtifactShortId } from "./artifactShortId";
export { artifactFileType, artifactFramedPagePath, artifactTitleFromFileName, artifactTitleFromHtml, type ArtifactFileType } from "./artifactFiles";
export { isGitPathSegment, isWellFormedArtifactFilePath } from "./artifactFilePath";
export { appEnabledPerEnv, enabledAppsEnvValue, RAFT_ENABLED_APPS_ENV } from "./enabledAppsEnv";
export * from "./agentApiArtifactsContract";
export * from "./agentApiArtifactChecksContract";
export { ARTIFACT_AGENT_NOTICE_REASONS, artifactAgentNoticeSchema, type ArtifactAgentAppEvent, type ArtifactAgentNotice, type ArtifactAgentNoticeReason } from "./artifactAgentNotice";
export { ARTIFACT_NOTICE_MAX_CHARS, formatArtifactNotice } from "./agentText/artifactNotices";
export {
  REACTION_NOTICE_EXCERPT_MAX_CHARS,
  REACTION_NOTICE_KIND,
  REACTION_NOTICE_READD_WINDOW_MS,
  REACTION_NOTICE_SUMMARY_EXCERPT_MAX_CHARS,
  REACTION_NOTICE_TTL_MS,
  REACTION_NOTICES_APP_ID,
  REACTION_NOTICES_SYSTEM_APP,
  formatReactionNoticeSummary,
  messageIdOfReactionNoticeInboxTarget,
  messageIdOfReactionNoticeObjectRef,
  REACTION_NOTICE_WITHDRAWN_SENTENCE,
  reactionNoticeOfAppEvent,
  reactionAgentNoticeSchema,
  reactionNoticeExcerpt,
  reactionNoticeInboxTarget,
  reactionNoticeObjectRef,
  type ReactionAgentAppEvent,
  type ReactionAgentNotice,
} from "./reactionAgentNotice";
export type {
  ArtifactActor,
  ArtifactShownActor,
  ArtifactAnnotationAnchor,
  ArtifactPageAnchor,
  ArtifactCapabilities,
  ArtifactCard,
  ArtifactCardUnseen,
  ArtifactComment,
  ArtifactCommentAnchor,
  ArtifactCommentDraft,
  ArtifactCommentDraftId,
  ArtifactCommentDraftInput,
  ArtifactCommentId,
  ArtifactCommentImage,
  ArtifactCommentPart,
  ArtifactDeletedReference,
  ArtifactFacts,
  ArtifactFile,
  ArtifactCheckedKind,
  ArtifactFramedKind,
  ArtifactHome,
  ArtifactId,
  ArtifactKind,
  ArtifactNoticeReason,
  ArtifactOrigin,
  ArtifactOriginVia,
  ArtifactPresence,
  ArtifactPreview,
  ArtifactReference,
  ArtifactReviewId,
  ArtifactVersionSummary,
  ArtifactViewerData,
  ArtifactReadAsUser,
  ArtifactReadAsUserFile,
  ArtifactReviewSubmitInput,
  ArtifactWebConversationArtifacts,
  ArtifactWillNotify,
} from "./workspaceArtifacts";
export { ARTIFACT_CHECK_SHOTS, ARTIFACT_COMMENT_IMAGE_MAX_BYTES, ARTIFACT_COMMENT_IMAGE_TYPES, ARTIFACT_COMMENT_MAX_CHARS, ARTIFACT_COMMENT_MAX_IMAGES, ARTIFACT_COMMENT_MAX_MENTIONS, ARTIFACT_CONVERSATION_PAGE_LIMIT, ARTIFACT_DASHBOARD_ALL_DEFAULT_DIRS, ARTIFACT_DASHBOARD_ALL_DIRS, ARTIFACT_DASHBOARD_ALL_PAGE_LIMIT, ARTIFACT_DASHBOARD_ALL_SORTS, ARTIFACT_DASHBOARD_AUTHORS_LIMIT, ARTIFACT_DASHBOARD_AUTHORS_MAX, ARTIFACT_DASHBOARD_CONVERSATIONS_LIMIT, ARTIFACT_DASHBOARD_HOMES, ARTIFACT_DASHBOARD_PAGE_LIMIT, ARTIFACT_DASHBOARD_SECTIONS, ARTIFACT_FRAME_SANDBOX, ARTIFACT_ATTACHMENT_SAVES_MAX_IDS, ARTIFACT_HOME_CHANGE_MAX_COUNTED, ARTIFACT_SAVE_MAX_BINARY_BYTES, ARTIFACT_SAVE_MAX_TEXT_BYTES, ARTIFACT_SHARE_AUDIENCE_MAX_COUNTED, ARTIFACT_SHARE_NOTE_MAX_CHARS, ARTIFACT_TAKEDOWN_REASON_MAX_CHARS, ARTIFACT_WEB_ERROR_CODES, artifactWebPaths, asArtifactInstanceVersion } from "./webArtifactsContract";
export type {
  ArtifactCheckShot,
  ArtifactCommentImageType,
  ArtifactDashboardAllCounts,
  ArtifactDashboardAllDir,
  ArtifactDashboardAllNews,
  ArtifactDashboardAllRow,
  ArtifactDashboardAllSort,
  ArtifactDashboardAuthor,
  ArtifactDashboardAuthorCandidate,
  ArtifactDashboardConversation,
  ArtifactDashboardFollowing,
  ArtifactDashboardHome,
  ArtifactDashboardPage,
  ArtifactDashboardRecent,
  ArtifactDashboardSection,
  ArtifactDashboardWaiting,
  ArtifactReviewRejected,
  ArtifactReviewSubmitted,
  ArtifactSearchHit,
  ArtifactWebAttachmentSaves,
  ArtifactWebCommentCreated,
  ArtifactWebCommentInput,
  ArtifactWebCommentsPage,
  ArtifactWebDashboard,
  ArtifactWebDashboardAll,
  ArtifactWebDashboardAuthors,
  ArtifactWebDashboardConversations,
  ArtifactWebErrorCode,
  ArtifactWebErrorDetails,
  ArtifactWebFileContent,
  ArtifactWebFrame,
  ArtifactWebFrameInput,
  ArtifactWebHomeChange,
  ArtifactWebHomeInput,
  ArtifactWebMentionCandidates,
  ArtifactWebResponses,
  ArtifactWebReview,
  ArtifactWebReviewDrafts,
  ArtifactWebReviewDraftSaved,
  ArtifactWebResolveInput,
  ArtifactWebThreadResolution,
  ArtifactWebImported,
  ArtifactWebImportInput,
  ArtifactWebLocation,
  ArtifactWebOpen,
  ArtifactWebSaved,
  ArtifactWebSaveInput,
  ArtifactWebShareAudience,
  ArtifactWebWidenRefusal,
  ArtifactWebShared,
  ArtifactWebShareInput,
  ArtifactWebTakedown,
  ArtifactWebTakedownInput,
  ArtifactWebTitleInput,
  ArtifactInstanceVersion,
} from "./webArtifactsContract";
export { ARTIFACT_PUBLIC_DESCRIPTION_MAX_CHARS, ARTIFACT_PUBLIC_MARKDOWN_MAX_BYTES, artifactPublicPaths } from "./publicArtifactsContract";
export {
  ARTIFACT_CHECK_MAX_BLOCKED_RESOURCES,
  ARTIFACT_CHECK_MAX_CONSOLE_ERRORS,
  ARTIFACT_CHECK_REPORT_MAX_BYTES,
  ARTIFACT_CHECK_SHOT_MAX_BYTES,
  ARTIFACT_CHECK_TEXT_MAX_CHARS,
  ARTIFACT_CHECK_TIMING_MAX_MS,
  ARTIFACT_CHECK_TIMING_STAGES,
  ARTIFACT_CHECK_VIEWPORTS,
  artifactCheckWorkerPaths,
} from "./artifactCheckContract";
export type { ArtifactCheckLease, ArtifactCheckLoad, ArtifactCheckReport, ArtifactCheckReportForm, ArtifactCheckResultAnswer, ArtifactCheckTiming, ArtifactCheckViewport } from "./artifactCheckContract";
export type { ArtifactPublicAttribution, ArtifactPublicFile, ArtifactPublicFrame, ArtifactPublicMeta, ArtifactPublicView } from "./publicArtifactsContract";
export { AGENT_API_META, appAgentApiRoutesOf, defineAppAgentApi, mergeAppAgentApis } from "./agentApiRoute";
export type { AgentApiRouteAuthority, AgentApiRouteVisibility, AppAgentApi, AppAgentApiRoute } from "./agentApiRoute";
export { firstPartyAppAgentApis } from "./apps";
export { asObjectFileId, OBJECT_SUMMARIES_MAX_ID_CHARS, OBJECT_SUMMARIES_MAX_REFS, OBJECT_WEB_ERROR_CODES, objectWebPaths } from "./webObjectsContract";
export type {
  ArtifactActivityTarget,
  ArtifactActivityUnread,
  ArtifactObjectRef,
  ObjectFileId,
  ObjectActivityTarget,
  ObjectActivityTargetOf,
  ObjectActivityUnread,
  ObjectActivityUnreadOf,
  ObjectDeletedOf,
  ObjectIdOf,
  ObjectRefOf,
  ObjectSummaries,
  ObjectSummariesInput,
  ObjectSummary,
  ObjectSummaryAnswer,
  ObjectSummaryKinds,
  ObjectSummaryOf,
  ObjectWebErrorCode,
  ObjectWebErrorDetails,
  SummarizedObjectKind,
} from "./webObjectsContract";
export {
  MENTION_AUDIENCE_ERROR_CODES,
  MENTION_AUDIENCE_MAX_CANDIDATES,
  MENTION_AUDIENCE_MAX_ID_CHARS,
  MENTION_AUDIENCE_QUERY_MAX_CHARS,
  asFirstPartyAppId,
  asFirstPartyObjectId,
  asFirstPartyObjectKind,
  mentionAudiencePaths,
} from "./mentionAudienceContract";
export type {
  FirstPartyAppId,
  FirstPartyObjectId,
  FirstPartyObjectKind,
  MentionAudience,
  MentionAudienceActor,
  MentionAudienceCandidates,
  MentionAudienceErrorCode,
  MentionAudienceInput,
} from "./mentionAudienceContract";
export {
  JOINT_INVITES_CHANGED_EVENT,
  LIST_CHANGED_EVENTS,
  PERMISSION_UPDATES_CHANGED_EVENT,
  SEAT_JOIN_BLOCKS_CHANGED_EVENT,
} from "./listChangedEvents";
export type { ListChangedEvent, ListChangedEventName } from "./listChangedEvents";
export { PRODUCT_FEEDBACK_APP_UNREAD_EVENT, PRODUCT_FEEDBACK_UNREAD_EVENT } from "./productFeedbackUnread";
export type {
  ProductFeedbackAppUnreadEvent,
  ProductFeedbackMobileAppSource,
  ProductFeedbackUnreadEvent,
} from "./productFeedbackUnread";
export { FEEDBACK_REPORT_SESSION_RECORD_EVENT } from "./feedbackReportSessionRecord";
export type { FeedbackReportSessionRecordEvent } from "./feedbackReportSessionRecord";
export { ACTIVITY_CHANGED_EVENT, OBJECT_ACTIVITY_ERROR_CODES, objectActivityWebPaths } from "./activityObjectsContract";
export type {
  ActivityChangedEvent,
  ObjectActivityAck,
  ObjectActivityDoneInput,
  ObjectActivityReadInput,
  ObjectActivityErrorCode,
  ObjectActivityInput,
  ObjectInboxActor,
  ObjectInboxEvent,
  ObjectInboxFields,
  ObjectInboxHome,
  ObjectInboxItem,
  ObjectInboxPreview,
  ObjectInboxReason,
  ObjectUnreadSummaryFields,
} from "./activityObjectsContract";
export { asSearchCursor, WEB_SEARCH_DEFAULT_LIMIT, WEB_SEARCH_ERROR_CODES, WEB_SEARCH_MAX_LIMIT, WEB_SEARCH_QUERY_MAX_CHARS, webSearchPath } from "./webSearchContract";
export type { SearchCursor, WebSearchApp, WebSearchErrorCode, WebSearchGroup, WebSearchGroupError, WebSearchItemsByApp, WebSearchQuery, WebSearchResponse } from "./webSearchContract";
export { MARKETPLACE_INSTALL_BUCKET_LABELS, MARKETPLACE_INSTALL_BUCKETS, marketplaceInstallBucket } from "./marketplaceInstalls";
export type { MarketplaceInstallBadge, MarketplaceInstallBucket } from "./marketplaceInstalls";
export { MARKETPLACE_LISTING_SORTS, MARKETPLACE_LISTING_TYPES, MARKETPLACE_LISTINGS_DEFAULT_LIMIT, MARKETPLACE_LISTINGS_ERROR_CODES, MARKETPLACE_LISTINGS_MAX_LIMIT, MARKETPLACE_LISTINGS_QUERY_MAX_CHARS } from "./marketplaceListingsContract";
export type { MarketplaceAppListing, MarketplaceCursor, MarketplaceListing, MarketplaceListingId, MarketplaceListingSort, MarketplaceListingsErrorCode, MarketplaceListingsQuery, MarketplaceListingsResponse, MarketplaceListingType, MarketplaceMcpListing } from "./marketplaceListingsContract";
export * from "./channelSideLayout";
export * from "./syncChanges";

export { PI_RESPONSE_NOTICE_TITLE, PI_RESPONSE_NOTICE_TEXT, piResponseNoticeKind, type PiResponseNoticeKind } from "./piResponseNotice";
export { MEMBER_REMOVAL_IMPACT_MAX_COMPUTER_NAMES } from "./memberRemovalImpact";
export type { MemberRemovalImpact } from "./memberRemovalImpact";
