import { LocalAgentInboxes } from "./localAgentInboxes";
import { recordAgentSystemRestart } from "./agentOperatorEvents";
import { inboxItemsLaunch, inboxItemsOnWith } from "./inboxItemsLaunch";
import { EventEmitter } from "node:events";
import { AgentActivityStateFanout } from "./agentActivityStateFanout";
import { AGENT_ACTIVITY_STATE_EVENT, agentActivityCapableServerRoom, agentActivityRoom } from "@botiverse/raft-shared";
import { closeConnectionsForDrain, MACHINE_DRAIN_CLOSE_CODE, MACHINE_DRAIN_CLOSE_REASON } from "./machineDrain";
import crypto from "node:crypto";
import type { Server as SocketServer } from "socket.io";
import { agentActivityStateRoom, agentEventRoom, socketUserServerRoom } from "../socket/platformScope";
import { projectRuntimeErrorActivityDetail } from "./agentRuntimeErrorVisibility";
import type { WebSocket } from "ws";
import {
  DAEMON_LOG_TURN_BOUNDARIES,
  isRuntimeProgressEntry,
  readDaemonTurnSummary,
  summarizeTurnsFromLog,
  type ActivityTurnOutcome,
  type ExternalHookTurnBoundary,
  type ActivityTurnSummary,
  DAEMON_CAPABILITY_RUNTIME_HOST_OAR,
  DAEMON_CAPABILITY_RUNTIME_HOST_OAR_CODEX,
  DAEMON_CAPABILITY_RUNTIME_HOST_OAR_CURSOR,
  DAEMON_CAPABILITY_RUNTIME_HOST_OAR_GROK,
  DAEMON_CAPABILITY_AGENT_CONFIG_PUSH,
  DAEMON_CAPABILITY_CONTROL_START_CATCHUP_V1,
  DAEMON_CAPABILITY_SEQUENCED_STATUS,
  DAEMON_CAPABILITY_INTERRUPT_SUBAGENT,
  DAEMON_CAPABILITY_INTERRUPT_TURN,
  DAEMON_CAPABILITY_COMPUTER_UPGRADE_DRAIN_V1,
  COMPUTER_UPGRADE_DRAIN_MAX_DEADLINE_MS,
  COMPUTER_UPGRADE_DRAIN_MAX_LISTED_AGENTS,
  DAEMON_CAPABILITY_STARTUP_READINESS,
  parseCredentialRestoredMessage,
  parseRuntimeReadinessReport,
  RUNTIME_AUTH_LOGOUT_RELAY_BUDGET_MS,
  RUNTIME_AUTH_PROVIDER_RELAY_BUDGET_MS,
  RUNTIME_AUTH_RUNTIMES,
  asRuntimeAuthLoginId,
  runtimeAuthLoginEventSchema,
  runtimeAuthLoginResultSchema,
  runtimeAuthProviderConnectResultSchema,
  runtimeAuthProvidersResultSchema,
  runtimeAuthLogoutRuntimesOfComputer,
  runtimeAuthRuntimesOfComputer,
  runtimeAuthStatusReportSchema,
  isRuntimeAuthRuntime,
  runtimeAuthSupports,
  type RuntimeAuthLoginEventPush,
  type RuntimeAuthLoginResultPush,
  type RuntimeAuthLogoutResult,
  type RuntimeAuthProviderConnectInput,
  type RuntimeAuthProviderConnectResult,
  type RuntimeAuthProvidersResult,
  type RuntimeAuthRuntime,
  type AgentSubagentInterruptOutcome,
  type AgentTurnInterruptOutcome,
  DAEMON_CAPABILITY_RUNTIME_OUTCOME_V1,
  type AgentWakeRefusedReason,
  asMachineId,
  type MachineId,
  EXTERNAL_AGENT_ACTIVITY_PROVENANCE,
  EXTERNAL_AGENT_ACTIVITY_TEXT_LIMIT,
  EXTERNAL_AGENT_ACTIVITY_TOOL_NAME_LIMIT,
  RAFT_AGENT_STATUS_DETAIL_LIMIT,
  isRaftAgentStatus,
  type RaftAgentStatus,
  createTraceScopeTracer,
  currentDate,
  currentRandomUnit,
  currentTimeMs,
  failpoints,
  formatTraceparent,
  getStaticRuntimeModelSourceSet,
  getToolActivityLabel,
  hydrateRuntimeConfig,
  sharedCredentialsAuthRuntime,
  isAgentActivityDetailKind,
  isExternalAgentRuntime,
  noopTracer,
  normalizeActivity,
  PROVIDER_PROBE_BUDGET_MS,
  PROVIDER_PROBE_RELAY_BUDGET_MS,
  RUNTIME_ACCOUNT_USAGE_RELAY_BUDGET_MS,
  RUNTIME_LIMIT_RESET_RELAY_BUDGET_MS,
  RUNTIME_LIMIT_RESET_CLAUDE_RELAY_BUDGET_MS,
  DAEMON_CAPABILITY_RUNTIME_LIMIT_RESET,
  runtimeAccountUsageReadableWith,
  DAEMON_CAPABILITY_RUNTIME_LIMIT_RESET_CLAUDE_KINDS,
  normalizeActivityDetailKind,
  parseTraceparent,
  runtimeConfigForLaunch,
  runtimeConfigToLaunchFields,
  runtimeModelSourceOutcomeFromSet,
  runtimeModelDetectionRequestTimeoutMs,
  setClockTimeout,
  type ActiveSpan,
  type AgentMessage,
  type MentionDeliveryIdentitySnapshot,
  type ServerToMachineMessage,
  type MachineToServerMessage,
  type MachineDiskStatus,
  isMachineDiskLow,
  isValidMachineDiskStatus,
  type MachineMemoryStatus,
  isValidMachineMemoryStatus,
  type MachineShutdownReason,
  type ComputerLifecycleExecutionAck,
  type AgentConfig,
  type AgentServerFeatures,
  TASK_V2_CONVERSATIONS_FEATURE_FLAG_KEY,
  AGENT_CONTEXT_VIEW_FEATURE_FLAG_KEY,
  AGENT_INBOX_ITEMS_FEATURE_FLAG_KEY,
  AGENT_CONTEXT_VIEW_AVAILABILITY_TYPE,
  DAEMON_CAPABILITY_AGENT_CONTEXT_VIEW_V0,
  readAgentContextViewAvailability,
  type AgentContextViewRequestMessage,
  type WorkspaceDirectoryInfo,
  type FileNode,
  type TrajectoryEntry,
  type ReasoningEffort,
  type RuntimeReasoningEffort,
  type RuntimeConfig,
  type SkillInfo,
  type AgentStatus,
  type RuntimeModelInfo,
  type RuntimeModelSourceOutcome,
  type AgentActivity,
  type AgentActivityDetailKind,
  type AgentActivityKind,
  type AgentRuntimeErrorState,
  boundedRuntimeErrorDetail,
  GENERIC_RUNTIME_ERROR_MESSAGE,
  isRuntimeErrorDetailActivity,
  type TraceAttributes,
  type TraceContext,
  type TraceStatus,
  type Tracer,
  type ExternalAgentActivityEvent,
  type SubagentLineage,
  type ExternalAgentActivityIngestRequest,
  type AgentMigrationTransportLeaseSource,
  type AgentMigrationTransportReady,
  type FeedbackTranscriptReportTimeSource,
  type FeedbackTranscriptSessionLookup,
  runtimeSessionHomeEnvVars,
  type FeedbackMachineEvidenceOutcome,
  type FeedbackTranscriptLookupOutcome,
  type FeedbackTranscriptOutcomeObjectPlan,
  type FeedbackTranscriptUploadOutcome,
  type FeedbackMachineLogTailOutcome,
  type FeedbackTranscriptWindow,
  type RuntimeAccountUsageProvider,
  type RuntimeErrorActivityDiagnostic,
  type RuntimeErrorRequiredAction,
  type DeliveryConsumptionActivityDiagnostic,
  type WakeCrashLoopActivityDiagnostic,
  type SpawnFailureActivityDiagnostic,
  type ToolStuckActivityDiagnostic,
  type CredentialHoldActivityDiagnostic,
  isDeviceClass,
  isHostProvider,
  isDaemonInstallKind,
  isComputerMigratedFrom,
  parseComputerInstallerRepairHint,
  type ComputerInstallerRepairHint,
  type DaemonInstallKind,
  normalizeOsRelease,
  normalizeOsId,
  normalizeOsIdLike,
  AGENT_MIGRATION_CAPABILITY,
  AGENT_MIGRATION_TARGET_IGNORE_SOURCES_CAPABILITY,
  MODEL_SEEN_MAX_ITEMS_PER_REPORT,
  MACHINE_DUPLICATE_CONNECTION_CLOSE_CODE,
  MACHINE_DUPLICATE_CONNECTION_CLOSE_REASON,
  MACHINE_DUPLICATE_CONNECTION_HELD_CLOSE_REASON,
  evaluateComputerVersionGate,
  compareComputerVersions,
  isComputerSemver,
  AGENT_TURN_ENDED_OUTCOMES,
  isOarOnlyRuntime,
  isRuntimeAbsentStartFailure,
  COMPUTER_CAPABILITY_SERVICE_IPC_UNREACHABLE,
  readyRunnerCredentialIds,
  type AgentStopReason,
  type ComputerVersionGate,
  type RuntimeLimitResetIdempotencyKey,
  type RuntimeLimitResetKind,
} from "@botiverse/raft-shared";
import {
  FeedbackTranscriptLateResults,
  feedbackTranscriptOutcomeSpanAttrsSafely,
  readFeedbackTranscriptResultOutcomeSafely,
} from "./feedbackTranscriptLateResults";
import {
  appConfigTraceAttrs,
  appSourceTraceAttrs,
  filterAppRuntimeTraceAttrs,
} from "@botiverse/raft-shared/src/appRuntimeTrace";
import { wakeRequestAppRefTraceAttrs } from "./wakeRequestAppRef";
import type { AppConfigWireSnapshot } from "@botiverse/raft-shared/src/appConfigTransport";
import { RouteFailureError } from "../tracing/routeFailure";
import { applyAgentModelSeen as applyAgentModelSeenToReadPosition } from "./agentModelSeen";
import { TurnEndUnreadSnapshots, snapshotForUnreadSummary, type UnreadSummarySnapshotTargets } from "./turnEndUnreadSnapshot";
import { owedReadBacklogTargets, settleUnowedReadBacklog, type UnowedReadBacklogTarget } from "./unowedReadBacklog";
import { getDb } from "../db/index";
import { AgentMigrationSourceArchiveError } from "./agentMigrationSourceArchive";
import { composeReminderSnapshot } from "../apps/reminder/snapshotComposition";
import { resolveBuiltInMachineMessageDispatch } from "../registry.manifest";
import {
  RUNTIME_OUTCOME_ACK_ENABLED,
  ingestRuntimeOutcomeOutboxMessage,
  type RuntimeOutcomeOutboxMessage,
} from "../runtimeOutcomeOutboxIngest";
import { newMachineConnectionEpochId } from "./machineContext";
import { TerminalFailureBreaker, type CombinedClaimResult } from "../terminalFailureBreakerStore";
import {
  buildCatchupBatch,
  isTerminalBreakerProtecting,
  isSpawnErrorRetryDue,
  spawnErrorRetryJitterMs,
  terminalBlockView,
  type CatchupObligation,
  type TerminalBlockView,
  type TerminalFailureBreakerState,
  type TerminalStartControl,
  type TerminalWakeRefusal,
} from "../terminalFailureBreaker";
import { redisTerminalFailureBreakerStore } from "../terminalFailureBreakerRedisStore";
import { listBuiltInAppConfigSnapshotsForAgent } from "./appConfigTransportComposition";
import { isProbeCarrierFactLive, parseProbeCarrierMeta } from "./probeCarrierFact";
import type { AppSnapshotComposition } from "./appSnapshotComposition";
import { boundedErrorClass } from "../tracing/queryTrace";
import { pgSqlState } from "../db/migrationPreflight";
import {
  addTraceEvent,
  errorClassOf,
  getCurrentTraceContext,
  getCurrentTraceSpan,
  recordTraceEvent,
  runWithTraceSpan,
  withTraceRoot,
} from "../tracing/semanticTrace";
import * as agentService from "./agentService";
import * as agentMigrationService from "./agentMigrationService";
import * as agentRuntimeProfileService from "./agentRuntimeProfileService";
import { listModelLimitsAgents, parseAgentModelLimitsFrame, recordAgentModelLimitsReport } from "./agentModelLimitsService";
import * as machineService from "./machineService";
import { computerVersionFloor as sharedComputerVersionFloor } from "./computerVersionFloorService";
import * as computerHostIdentityService from "./computerHostIdentityService";
import { isHostIdHash } from "./computerHostIdentityService";
import * as channelService from "./channelService";
import * as messageService from "./messageService";
import * as oauthService from "./oauthService";
import { partitionDeliverableSystemAppEventMessages } from "./systemAppDeliveryGuards";
import { renderPushedMessages } from "./agentFacingContent";
import {
  daemonReportsDeliveredThirdPartyEvents,
  listManagedAgentsWithPendingThirdPartyEvents,
  planReconnectRedelivery,
  redeliverPendingThirdPartyAgentEvents,
  resolveOutageStart,
  type OutageStart,
} from "./thirdPartyAgentEventRedelivery";
import * as mentionDeliveryOccurrenceService from "./mentionDeliveryOccurrenceService";
import * as agentActivityLogService from "./agentActivityLogService";
import * as computerLifecycleOperationService from "./computerLifecycleOperationService";
import { dispatchPendingAgentArchiveOps, type AgentArchiveDispatchPort } from "./agentArchiveService";
import * as computerUpgradeRequestService from "./computerUpgradeRequestService";
import type { ComputerUpgradeDrainProgress } from "./computerUpgradeRequestService";
import {
  recordComputerOfflineTransition,
  recordComputerOnlineTransition,
} from "./computerOutageNotificationService";
import { legacyRuntimeStateFromActivity } from "./legacyActivityStateInference";
import { recordAgentContextReturned } from "../tracing/agentContextReturnTrace";
import { agentIdHashAttrs } from "../tracing/traceIdentity";
import { reminderAppActiveForServerStrict } from "./reminderAppGate";
import { AgentTypingRegistry, parseAgentSendIntentFrame, type AgentSendIntentOutcome, type AgentTypingTargetPreview } from "./agentTypingService";
import { previewAgentPostTarget } from "../routes/agentWritableTarget";
import { previewAgentTaskReplyTarget } from "./agentTypingTaskTarget";
import { READY_WAKE_LOST_DELIVERIES_FEATURE_FLAG_KEY, RUNNER_CREDENTIAL_RECONCILE_FEATURE_FLAG_KEY, agentRuntimeOarDisabled, agentRuntimeOarFeatureFlagKey, evaluateFeatureFlag, evaluateFeatureFlags, PASSIVE_AX_FEATURE_FLAG_KEY, PI_SESSION_ROTATION_FEATURE_FLAG_KEY, REMINDER_APP_FEATURE_FLAG_KEY, WAKE_RECYCLE_OAR_FEATURE_FLAG_KEY, WAKE_RECYCLE_TIER_GATE_FEATURE_FLAG_KEY, WAKE_RECYCLE_WARM_FEATURE_FLAG_KEY, TURN_END_COMPACTION_FEATURE_FLAG_KEY, SUBAGENT_DELEGATION_FEATURE_FLAG_KEY, VAULT_APP_FEATURE_FLAG_KEY, type AgentRuntimeOarFeatureFlagKey } from "./featureFlagService";
import { runtimeAccountUsageCacheService } from "./runtimeAccountUsageCacheService";
import { runtimeAuthService } from "./runtimeAuthService";
import { openAfterReplicaHop, sealForReplicaHop, type ReplicaHopRefusal } from "./runtimeAuthReplicaSeal";
import { usageLimitAttentionService } from "./usageLimitAttentionService";
import { applyRuntimeModelCatalogReport, machineRuntimeModelCatalogService } from "./machineRuntimeModelCatalogService";
import { getComputerLinkedMachineAttachers } from "./computerCredentialService";
import { findAccessRevokedMachineIds } from "./computerAgents";
import { RUNNER_CREDENTIAL_RECONCILE_GRACE_MS, countRunnerCredentialsNotHeld, revokeRunnerCredentialsNotHeld } from "./agentCredentialService";
import {
  evaluateBroadcastPolicy,
  isQueuedComputerUpgradePolicyCompatible,
  normalizeComputerPlatform,
  type ComputerBroadcastPolicyDecision,
  type EvaluateComputerBroadcastPolicyInput,
} from "./computerBroadcastPolicyService";
import type { PersistedAgentActivityHint } from "./agentActivityLogService";
import { continuesEmptyWake, lastTextOf, type RunningTurn } from "./activityTurnMerge";
import * as reminderService from "../apps/reminder/service";
import { agentHasScope, existingAgentsHaveScope } from "./agentScopesService";
import {
  adaptDaemonActivityLifecycleEvent,
  adaptDaemonSessionLifecycleEvent,
  adaptDaemonStatusLifecycleEvent,
  adaptMachineDisconnectLifecycleEvent,
  adaptMachineShutdownLifecycleEvent,
  adaptReadyReconcileLifecycleEvent,
  adaptRuntimeProfileControlLifecycleEvent,
  adaptStartLifecycleEvent,
  adaptStopLifecycleEvent,
  normalizeRuntimeErrorActivityDiagnostic,
  runtimeErrorRequiredAction,
} from "./legacyAgentLifecycleAdapter";
import { normalizeDeliveryConsumptionActivityDiagnostic } from "./deliveryConsumptionActivityDiagnostic";
import { DEFAULT_WAKE_CRASH_LOOP_RULES, PAUSE_RETRY_BASE_MS, PAUSE_RETRY_MAX_MS, PAUSE_RETRY_START_FAILURE_REASONS, WakeCrashLoopBreaker, type WakeCrashLoopExit, type WakeCrashLoopStartRecord } from "./wakeCrashLoopBreaker";
import { postAgentActionRequiredNotice } from "./agentActionRequiredNoticeService";
import { readinessNoticeKey, readinessNoticePlan, releaseReadinessNotices, storeRuntimeReadinessReport } from "./runtimeReadinessService";
import { postAutomaticWakePausedNotice } from "./automaticWakePausedNotice";
import { isLegacyStartFailureDetail, isLegacyUnkindedStartFailure, legacySpawnFailureCarrier } from "./legacySpawnFailure";
import { normalizeExternalSubagentMarker } from "./externalSubagentMarker";
import { normalizeSpawnFailureActivityDiagnostic } from "./spawnFailureActivityDiagnostic";
import { normalizeToolStuckActivityDiagnostic } from "./toolStuckActivityDiagnostic";
import { normalizeCredentialHoldActivityDiagnostic } from "./credentialHoldActivityDiagnostic";
import { createAgentLifecycleEvent, type AgentLifecycleEventType } from "./agentLifecycleEvents";
import {
  applyAgentLifecycleProjectionPlan,
  type AgentLifecycleProjectionWriterDeps,
  type LifecycleActivityBroadcastResult,
} from "./agentLifecycleProjectionWriter";
import {
  buildAgentLifecycleStateSnapshot,
  buildLifecycleShadowVerdictAttrs,
  CANONICAL_DAEMON_ACTIVITY_BY_DETAIL_KIND,
  arbitrateLifecycleProjection,
  classifyDaemonActivityObservation,
  legacyActivityToCanonicalProjection,
  planActivitySignalAction,
  planSessionSignalAction,
  planStatusSignalAction,
  planWakeAction,
  reduceDaemonActivityLifecycle,
  planSequencedStatus,
  type SequencedStatusVerdict,
  type SequencedStatusVersion,
  reduceDaemonActivitySignal,
  rewriteDaemonActivityEntries,
  reduceRuntimeErrorActivityAction,
  runtimeErrorClearsOnlyOnModelOutput,
  isModelOutputRecoveryFrame,
  reduceDaemonSessionLifecycle,
  reduceDaemonStatusLifecycle,
  reduceAgentMigrationControlLifecycle,
  reduceExternalActivityLifecycle,
  reduceMachineDisconnectLifecycle,
  reduceMachineShutdownLifecycle,
  reduceReadyReconcileLifecycle,
  reduceRuntimeProfileControlLifecycle,
  reduceStartLifecycle,
  reduceStopLifecycle,
  type DaemonReportedAgentStatus,
  type LifecycleObservationClass,
  type LifecycleArbitrationVerdict,
  type LifecycleRuntimeState,
  type LifecycleShadowSignalSite,
  type WakePlanAction,
  type WakePlanInput,
  type StatusSignalPlanAction,
  type StatusSignalPlanInput,
  type SessionSignalPlanAction,
  type SessionSignalPlanInput,
  type ActivitySignalPlanAction,
  type ActivitySignalPlanInput,
} from "./agentLifecycleReducer";

export {
  buildAgentLifecycleStateSnapshot,
  planActivitySignalAction,
  planSessionSignalAction,
  planStatusSignalAction,
  planWakeAction,
  type ActivitySignalPlanAction,
  type ActivitySignalPlanInput,
  type DaemonReportedAgentStatus,
  type SessionSignalPlanAction,
  type SessionSignalPlanInput,
  type StatusSignalPlanAction,
  type StatusSignalPlanInput,
  type WakePlanAction,
  type WakePlanInput,
} from "./agentLifecycleReducer";
import { getServerPlan, getHistoryCutoff } from "./planService";
import { agentConfigRevisionInputs } from "./agentConfigRevision";
import { loadAgentMigrationReadiness } from "./agentMigrationReadiness";
import {
  REPLICA_ID,
  type MachineDuplicateHold,
  routeStartIntent,
  START_INTENT_OWNER_MOVED,
  START_INTENT_UNANSWERED,
  StartIntentOwnerMovedError,
  StartIntentRemoteError,
  StartIntentTimeoutError,
  StartIntentTransportError,
  replicaSupportsOwnerIntents,
  type OwnerIntent,
  type StartIntentRequest,
  type StartIntentResult,
  routeMachineCommandWithResult,
  machineResponseRelay,
  routeInboxDelivery,
  routeInboxDeliveryWithReceipt,
  fingerprintAgentRuntimeError,
  publishExternalWakeSignal,
  publishAgentTypingPosted,
  type AgentTypingPostedSignal,
  type MachineCommandRouteResult,
  type RoutedInboxDeliveryOptions,
  type RoutedInboxDeliveryReceipt,
  type RoutedInboxDeliveryReceiptResult,
} from "../replicaRouter";
import {
  redisReplicaStateStore,
  type AgentContextViewAvailabilityRecord,
  type AgentRuntimeErrorMirror,
  type MachineMeta,
  type PersistedActivityTypedCarriers,
  type PersistedAgentActivity,
  type ReplicaStateStore,
} from "./replicaStateStore";
import {
  buildRuntimeTraceContext,
  projectMachineConnectTraceAttrs,
  projectOwnerTraceAttrs,
  type MachineConnectTraceContext,
} from "../tracing/migrationTraceContext";
import {
  agentDeliveryAckSeconds,
  agentDeliveryOutcomesTotal,
  provideAgentDeliveryPending,
  daemonVersionLabel,
  releaseAgentDeliveryPending,
  agentDeliveryTrackedTotal,
  machineConnectionsRefusedTotal,
  machineCloseCodeLabel,
  machineConnectionLifetimeLabel,
  machineDisconnectsTotal,
  agentWakePauseTransitionsTotal,
  machineCommandRouteTotal,
  machineOwnerRefreshTotal,
  machineDuplicateConnectionsTotal,
  machineDuplicateConnectionActionsTotal,
} from "../metrics";
import type { ComputerSourceFact } from "./computerBroadcastPolicyService";
import { enabledFirstPartyAppIdsStrict } from "./firstPartyAppFlags";
import {
  MachineCatalogAuthority,
  MachineCatalogStaleError,
  type MachineConnectionGeneration,
} from "./machineCatalogAuthority";
import {
  BuiltInModelCatalogError,
  assertBuiltInPresetSupportedByCatalog,
  isBuiltInCatalogCheckedSelection,
  type BuiltInModelCatalogValidation,
} from "./builtinModelCatalogCompatibility";

export type MachineConnectionPrincipalKind = "computer" | "legacy_machine" | "unknown";

interface MachineConnection {
  ws: WebSocket;
  machineId: string;
  serverId: string;
  principalKind: MachineConnectionPrincipalKind;
  connectionEpochId: string;
  replicaGeneration: string | null;
  heartbeatTimer: unknown | null;
  // Task #354: WebSocket protocol-level keepalive, separate from the 30s
  // application heartbeat above. Null when disabled.
  wsPingTimer: unknown | null;
  runtimeAccountUsageTimer: unknown | null;
  lastPong: number;
  lastIngressAt: number;
  // When this connection was accepted; SLI 4 failure outcomes are bucketed by
  // connection age (task #432). Optional so hand-built test connections compile.
  connectedAt?: number;
  // When this replica saw the machine's previous socket close (taken from
  // machineLastDisconnectAt when this connection registered): a candidate
  // outage start for the app-event reconnect pass.
  previousCloseAt?: number;
  // Task #1295: when this connection last sent any agent:deliver:ack; a recent
  // one defers due delivery re-sends.
  lastDeliveryAckAt?: number;
  daemonVersion: string | null;
  // Task #374: closed because another replica holds a live, renewing
  // connection for this machine. Its disconnect is local cleanup only.
  closedAsDuplicate?: boolean;
  // Task #374: short hash of the hostname the daemon reported in `ready`
  // (never the name itself). A clue for duplicate reports, not host identity.
  reportedHostnameHash?: string | null;
  // WSL flavour the daemon reported in `ready` (its `os` still says linux);
  // null on older daemons and other hosts. Telemetry grouping only.
  osVariant?: "wsl1" | "wsl2" | null;
  // Task #374: when this connection, as lease holder, last published its
  // daemon identity next to the lease (observation for duplicate detection).
  lastReplicaInstancePublishedAt?: number;
  // Task #374: evidence that another replica holds this machine's owner lease
  // and keeps renewing it while this socket is alive. Cleared by a refresh
  // that succeeds; reported once per connection.
  duplicateLeaseEvidence?: {
    firstRejectedAt: number;
    lastForeignUpdatedAtMs: number;
    foreignAdvances: number;
    reported: boolean;
  };
  capabilities: Set<string>;
  // Reconciler step 13: the Computer's latest `computer:upgrade:draining`
  // (in memory, this connection only; the request row does not change).
  upgradeDrain?: ComputerUpgradeDrainProgress;
  // Runtimes reported in the daemon `ready` message, held in-memory so
  // server-authoritative readiness (ServerSetupProjectionGate) derives runtime
  // from the SAME live "Ready" event as the client card — no DB-persist lag,
  // no double-source divergence. Null until `ready` is processed.
  runtimes: string[] | null;
  runtimeVersions: Record<string, string>;
  /**
   * task #1268: the daemon's runtime detection state for this connection. A
   * `pending` ready carries no inventory and leaves `runtimes` untouched; an
   * `incomplete` ready names the runtimes it never probed, whose previous
   * state is kept and marked unconfirmed (never unavailable). Null until a
   * ready is processed; synchronous daemons are `complete`.
   */
  runtimeDetection?: MachineRuntimeDetectionState | null;
  // Latest `machine:disk_status` of this connection; null until reported.
  diskStatus?: MachineDiskStatus | null;
  // Latest `machine:memory_status` of this connection; null until reported.
  memoryStatus?: MachineMemoryStatus | null;
  // #proj-raft-computer task #34: advisory, the installer needs a repair run on
  // the machine (`ready.installerRepairHint`, then `machine:installer_repair_hint`);
  // null when there is nothing to hint and for Computers that never report it.
  installerRepairHint?: ComputerInstallerRepairHint | null;
  migrationTransport: MachineMigrationTransportState | null;
  shutdownIntent: MachineShutdownIntent | null;
  traceContext?: MachineConnectTraceContext;
  // Managed-Computer bundle version (`@botiverse/raft-computer`), reported in
  // `ready` when this connection is a Computer; null for a raw daemon.
  computerVersion: string | null;
  // Below the Computer version floor (computerVersionFloorService): set on
  // `ready`, refreshed by the periodic sweep. `enforced` holds agent work.
  versionGate?: ComputerVersionGate | null;
  // RFC 069 §8: the daemon process on this connection (from `ready`); sequenced
  // status frames from any other daemon process are stale.
  daemonInstanceId: string | null;
  // RFC 071 outbox: agents whose outcome storage this daemon reports as
  // unreliable (`ready.runtimeOutcomeUnreliableAgents`, or an
  // `agent:runtime:outcome_unreliable` notice). `agent:runtime-outcome-v1`
  // does not apply to them.
  runtimeOutcomeUnreliableAgents?: Set<string>;
  // #wg-rbac:#27: set by this connection's first `ready`; only that one
  // reconciles runner credentials (a later ready can miss a start's key
  // whose mint response is still on its way).
  runnerCredentialReconcileSeen?: boolean;
  // Reconciler step 11d: the config revision re-sent to each agent on this
  // connection after a `ready` reported an older applied one. One re-send per
  // revision per connection: a daemon that keeps reporting the older revision
  // (the push failed to apply) is not sent it again until it reconnects.
  configResentRevisions?: Map<string, number>;
}

// Daemon-reported capabilities we persist then reflect to the client card. Held
// per machine so a transient DB-write failure can be retried by the server
// itself (see enqueueCapabilitiesPersist) instead of waiting for the daemon to
// send another `ready`.
/** task #1268: detection state fanned out with `machine:capabilities` and kept on the connection. */
export interface MachineRuntimeDetectionState {
  status: "pending" | "complete" | "incomplete";
  /** `incomplete` only: runtimes whose previous state is retained unconfirmed. */
  unfinishedRuntimes?: string[];
  /** `incomplete` only: why the daemon's round ended early. */
  reason?: "deadline" | "child_failed" | "cancelled";
  updatedAtMs: number;
}

/**
 * task #1268: null when the daemon sent no report (it detects synchronously
 * before ready, i.e. complete); the fan-out then carries no `runtimeDetection`
 * and web treats absence as complete.
 */
export function normalizeRuntimeDetectionReport(value: unknown, nowMs: number): MachineRuntimeDetectionState | null {
  if (!value || typeof value !== "object") return null;
  const report = value as { status?: unknown; unfinishedRuntimes?: unknown; reason?: unknown };
  if (report.status === "pending") return { status: "pending", updatedAtMs: nowMs };
  if (report.status === "incomplete") {
    const unfinished = Array.isArray(report.unfinishedRuntimes)
      ? report.unfinishedRuntimes.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      : [];
    const reason = report.reason === "deadline" || report.reason === "child_failed" || report.reason === "cancelled" ? report.reason : "child_failed";
    return { status: "incomplete", unfinishedRuntimes: unfinished, reason, updatedAtMs: nowMs };
  }
  return { status: "complete", updatedAtMs: nowMs };
}

/** task #1268: the last confirmed inventory a pending/incomplete ready is laid over. */
export interface MachineRuntimeInventory {
  runtimes: string[];
  runtimeVersions: Record<string, string>;
}

/**
 * task #1268: an incomplete round keeps the previous state (presence and
 * version) of every runtime it never probed; probed runtimes take the new
 * result. Pure, so the merge is testable without a connection.
 */
export function mergeIncompleteRuntimeInventory(
  previous: MachineRuntimeInventory | null,
  reported: MachineRuntimeInventory,
  unfinishedRuntimes: readonly string[],
): MachineRuntimeInventory {
  const unfinished = new Set(unfinishedRuntimes);
  const runtimes = new Set(reported.runtimes);
  const runtimeVersions: Record<string, string> = { ...reported.runtimeVersions };
  for (const runtime of previous?.runtimes ?? []) {
    if (!unfinished.has(runtime)) continue;
    runtimes.add(runtime);
    const version = previous?.runtimeVersions[runtime];
    if (version && !runtimeVersions[runtime]) runtimeVersions[runtime] = version;
  }
  return { runtimes: [...runtimes], runtimeVersions };
}

interface CapabilitiesPersistPayload {
  runtimes: string[];
  runtimeVersions?: Record<string, string>;
  runtimeDetection?: MachineRuntimeDetectionState;
  hostname?: string;
  os?: string;
  /** Validated device class, host provider and OS release; each null when absent (unknown / older daemon). */
  host?: machineService.MachineHostFacts;
  daemonVersion?: string | null;
  computerVersion?: string | null;
}

/**
 * Reconciler step 11d: `ready.runningAgentConfigRevisions`, the revision each
 * running agent applied on the daemon, checked (untrusted wire data). Entries
 * that are not a finite number are left out: that agent is not compared.
 */
function readyAgentConfigRevisions(value: unknown): Map<string, number> {
  const revisions = new Map<string, number>();
  if (!value || typeof value !== "object" || Array.isArray(value)) return revisions;
  for (const [agentId, revision] of Object.entries(value)) {
    if (typeof revision === "number" && Number.isFinite(revision)) revisions.set(agentId, revision);
  }
  return revisions;
}

function normalizeRuntimeVersions(value: unknown, runtimes: readonly string[]): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const allowed = new Set(runtimes);
  const versions: Record<string, string> = {};
  for (const [runtimeId, rawVersion] of Object.entries(value).slice(0, 32)) {
    if (!allowed.has(runtimeId) || runtimeId.length > 64 || typeof rawVersion !== "string") continue;
    const version = rawVersion.trim();
    if (!version || version.length > 128) continue;
    versions[runtimeId] = version;
  }
  return versions;
}

/** task #1268: the owner replica's last fanned-out detection state, or null. */
function runtimeDetectionFromMachineMeta(meta: MachineMeta | null): MachineRuntimeDetectionState | null {
  if (typeof meta?.probeRuntimeDetection !== "string" || !meta.probeRuntimeDetection) return null;
  try {
    const parsed = JSON.parse(meta.probeRuntimeDetection) as unknown;
    const normalized = normalizeRuntimeDetectionReport(parsed, 0);
    if (!normalized) return null;
    const updatedAtMs = typeof (parsed as { updatedAtMs?: unknown }).updatedAtMs === "number" ? (parsed as { updatedAtMs: number }).updatedAtMs : 0;
    return { ...normalized, updatedAtMs };
  } catch {
    return null;
  }
}

function runtimeVersionsFromMachineMeta(meta: MachineMeta | null): Record<string, string> {
  if (typeof meta?.runtimeVersions !== "string" || !meta.runtimeVersions) return {};
  try {
    const parsed = JSON.parse(meta.runtimeVersions) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const versions: Record<string, string> = {};
    for (const [runtimeId, rawVersion] of Object.entries(parsed).slice(0, 32)) {
      if (runtimeId.length > 64 || typeof rawVersion !== "string") continue;
      const version = rawVersion.trim();
      if (!version || version.length > 128) continue;
      versions[runtimeId] = version;
    }
    return versions;
  } catch {
    return {};
  }
}

interface CapabilitiesWriteState {
  // The most recent payload we still owe the DB. A newer `ready` overwrites it
  // in place; only ONE writer (runCapabilitiesWriter) ever persists, so writes
  // are serialized and the last write is always this latest payload.
  latest: CapabilitiesPersistPayload;
  // Monotonic per-machine generation (from capabilitiesGenerationSeq, which is
  // NOT reset when this entry is cleared). Used to detect that a newer payload
  // arrived while a persist was in flight so the writer loops again.
  generation: number;
  // True while a persist is in flight for this machine. The single-writer lock:
  // a concurrent `ready` only updates `latest`/`generation`; it must not start a
  // second persist, so an older write can never land after a newer one.
  writing: boolean;
  attempt: number;
  timer: unknown | null;
  // Set when the connection is cleared while a write is in flight; the writer
  // loop sees it after the persist resolves and stops without emitting.
  cancelled: boolean;
}

export interface MachineMigrationTransportState extends AgentMigrationTransportReady {
  capturedAt: string;
}

export interface MachineRuntimeModelDetection {
  outcome: RuntimeModelSourceOutcome;
  authority: MachineConnectionGeneration;
  daemonVersion: string | null;
  computerVersion: string | null;
}

/**
 * task #358: a sessioned start whose resume catch-up could not read the inbox
 * (chain unavailable, or the query failed) carries this as its resume prompt.
 * Without it the start has no summary and no catch-up, and the daemon's prompt
 * chain reads that as "no new messages while you were away" — "not checked"
 * presented as "nothing arrived". The daemon already renders `resumePrompt` as
 * the startup input, on old and new versions alike, so no protocol field.
 */
export const RESUME_CATCHUP_UNAVAILABLE_PROMPT =
  "Messages that arrived while you were away could not be checked: the inbox source was unavailable when you started. Run `raft message check` once to see what is pending, then handle it or stop.";

function normalizeMigrationTransportReady(
  input: AgentMigrationTransportReady | undefined,
  capturedAtMs: number,
): MachineMigrationTransportState | null {
  if (!input || typeof input !== "object") return null;
  const leaseSource = input.leaseSource === "server" || input.leaseSource === "env" ? input.leaseSource : null;
  const endpoint = typeof input.endpoint === "string" && input.endpoint.trim() ? input.endpoint.trim() : null;
  const observedAt = typeof input.observedAt === "string" && input.observedAt.trim()
    ? input.observedAt.trim()
    : new Date(capturedAtMs).toISOString();
  return {
    provisioned: input.provisioned === true,
    endpoint,
    leaseSource,
    protocol: typeof input.protocol === "string" && input.protocol.trim() ? input.protocol.trim() : null,
    capabilities: Array.isArray(input.capabilities)
      ? [...new Set(input.capabilities.filter((value): value is string => typeof value === "string" && value.length > 0))].sort()
      : null,
    observedAt,
    capturedAt: new Date(capturedAtMs).toISOString(),
  };
}

/** `MachineMeta.installerRepairHint`: JSON of the report, or null when there is nothing to hint. */
function installerRepairHintMeta(hint: ComputerInstallerRepairHint | null): string | null {
  return hint ? JSON.stringify(hint) : null;
}

function machineMetaFromMigrationTransport(
  migrationTransport: MachineMigrationTransportState | null,
): Pick<MachineMeta,
  | "migrationTransportProvisioned"
  | "migrationTransportEndpoint"
  | "migrationTransportLeaseSource"
  | "migrationTransportObservedAt"
  | "migrationTransportCapturedAt"
  | "migrationTransportProtocol"
  | "migrationTransportCapabilities"
> {
  return {
    migrationTransportProvisioned: migrationTransport ? (migrationTransport.provisioned ? "1" : "0") : null,
    migrationTransportEndpoint: migrationTransport?.endpoint ?? null,
    migrationTransportLeaseSource: migrationTransport?.leaseSource ?? null,
    migrationTransportObservedAt: migrationTransport?.observedAt ?? null,
    migrationTransportCapturedAt: migrationTransport?.capturedAt ?? null,
    migrationTransportProtocol: migrationTransport?.protocol ?? null,
    migrationTransportCapabilities: migrationTransport?.capabilities
      ? JSON.stringify(migrationTransport.capabilities)
      : null,
  };
}

function migrationTransportFromMachineMeta(meta: MachineMeta | null): MachineMigrationTransportState | null {
  if (!meta?.migrationTransportCapturedAt) return null;
  const rawLeaseSource = meta.migrationTransportLeaseSource;
  const leaseSource: AgentMigrationTransportLeaseSource | null = rawLeaseSource === "server" || rawLeaseSource === "env"
    ? rawLeaseSource
    : null;
  return {
    provisioned: meta.migrationTransportProvisioned === "1",
    endpoint: meta.migrationTransportEndpoint ?? null,
    leaseSource,
    protocol: meta.migrationTransportProtocol ?? null,
    capabilities: parseMachineMigrationTransportCapabilities(meta.migrationTransportCapabilities),
    observedAt: meta.migrationTransportObservedAt ?? meta.migrationTransportCapturedAt,
    capturedAt: meta.migrationTransportCapturedAt,
  };
}

function parseMachineMigrationTransportCapabilities(value: string | null | undefined): string[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? [...new Set(parsed)].sort()
      : null;
  } catch {
    return null;
  }
}

interface MachineShutdownIntent {
  reason: MachineShutdownReason;
  receivedAtMs: number;
}

interface OrchestratorClock {
  now(): number;
  scheduleRepeated(fn: () => void, ms: number): unknown;
  cancelRepeated(timer: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

/**
 * Next outbound `agent:activity` serverSeq: wall-clock milliseconds, bumped
 * past the previous value this replica issued (so two pushes in the same
 * millisecond, or after the clock steps back, still increase). Every replica (and a restarted
 * one) therefore issues seqs above what an earlier replica issued, so the
 * client's "drop if not newer" check keeps accepting pushes after the daemon
 * reconnects elsewhere. This assumes replica clocks are NTP-synced (ms-level
 * on ECS): skew only matters for pushes that close together, but a replica
 * whose clock ran far behind would have its pushes dropped until its clock
 * passed the last seq the browser saw.
 */
export function nextActivityServerSeq(previous: number, nowMs: number): number {
  return Math.max(nowMs, previous + 1);
}

const systemOrchestratorClock: OrchestratorClock = {
  now: () => Date.now(),
  scheduleRepeated: (fn, ms) => setInterval(fn, ms),
  cancelRepeated: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
  setTimeout: setClockTimeout,
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/**
 * The usage providers to read on a Computer with these runtimes and daemon
 * capabilities: Antigravity only where the daemon reads it
 * (DAEMON_CAPABILITY_RUNTIME_ACCOUNT_USAGE_ANTIGRAVITY).
 */
export function runtimeAccountUsageProvidersForRuntimes(runtimes: readonly string[], daemonCapabilities: Iterable<string>): RuntimeAccountUsageProvider[] {
  const providers = new Set<RuntimeAccountUsageProvider>();
  for (const runtime of runtimes) {
    if (runtime === "claude" || runtime === "codex" || runtime === "grok" || runtime === "antigravity") providers.add(runtime);
    if (runtime === "kimi" || runtime === "kimi-sdk") providers.add("kimi");
  }
  const capabilities = [...daemonCapabilities];
  return [...providers].filter((provider) => runtimeAccountUsageReadableWith(provider, capabilities));
}

export function runtimeAccountUsageIntervalMs(machineId: string): number {
  const baseMs = 15 * 60_000;
  const jitterRangeMs = 2 * 60_000;
  return baseMs + crypto.createHash("sha256").update(machineId).digest().readUInt32BE(0) % jitterRangeMs;
}

type RuntimeModelSourceResultMessage = Extract<MachineToServerMessage, { type: "machine:runtime_models:result" }>;

/** Project both new and legacy daemon result carriers into one closed truth. */
export function projectRuntimeModelSourceResult(
  msg: RuntimeModelSourceResultMessage,
  runtime: string,
): RuntimeModelSourceOutcome {
  if (msg.outcome) return msg.outcome;
  if (msg.error) {
    const staticSource = msg.error === "unsupported"
      ? getStaticRuntimeModelSourceSet(runtime)
      : undefined;
    if (staticSource) {
      return { kind: "live", value: staticSource };
    }
    return msg.error === "unsupported"
      ? { kind: "unsupported" }
      : { kind: "error", retryable: true };
  }
  return runtimeModelSourceOutcomeFromSet({ models: msg.models ?? [], default: msg.default });
}

function readBooleanEnv(name: string): boolean {
  const raw = process.env[name];
  if (!raw) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function readAnyBooleanEnv(names: string[]): boolean {
  return names.some((name) => readBooleanEnv(name));
}

function readNonNegativeIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

function durationMsBucket(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "unknown";
  if (ms === 0) return "0";
  if (ms <= 1_000) return "1s";
  if (ms <= 10_000) return "1s-10s";
  if (ms <= 30_000) return "10s-30s";
  if (ms <= 60_000) return "30s-60s";
  if (ms <= 120_000) return "60s-120s";
  return "120s+";
}

function hashRuntimeProfileKey(key: string | null | undefined): string | undefined {
  if (!key) return undefined;
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
}

// The daemon->server `agent:runtime_profile` frame is `JSON.parse(...) as MachineToServerMessage`
// with no runtime schema, so `source` is an untrusted wire value. Allowlist-normalize before it
// lands on a ScopeDB span attr: only the four known emit sources pass through, everything else
// (including absent / malformed) collapses to "unknown". Closed-set-at-boundary; see task #317.
const RUNTIME_PROFILE_REPORT_SOURCES = new Set(["connect", "session_init", "turn_end", "stop"]);
const MACHINE_SHUTDOWN_REASONS = new Set<MachineShutdownReason>(["computer_stop", "daemon_stop", "unknown"]);
const MACHINE_REPLICA_UNREGISTER_TIMEOUT_MS = 1000;
const MACHINE_REPLICA_REPAIR_MAX_REPLACEMENTS = 4;

function requireReplicaGeneration(generation: unknown): string {
  if (typeof generation !== "string" || generation.trim().length === 0) {
    throw new Error("Machine replica registration returned an empty generation");
  }
  return generation;
}
const COMPUTER_LIFECYCLE_DISCONNECT_OBSERVATION_TIMEOUT_MS = 1000;
const MACHINE_DISCONNECT_PROJECTION_GRACE_MS = 2000;
/** Fire the retry-once retry just after its hold ends, so the gate never sees it a tick early. */
const START_FAILURE_RETRY_SLACK_MS = 250;
export function normalizeRuntimeProfileReportSource(source: unknown): string {
  return typeof source === "string" && RUNTIME_PROFILE_REPORT_SOURCES.has(source) ? source : "unknown";
}

function normalizeMachineShutdownReason(reason: unknown): MachineShutdownReason {
  return typeof reason === "string" && MACHINE_SHUTDOWN_REASONS.has(reason as MachineShutdownReason)
    ? reason as MachineShutdownReason
    : "unknown";
}

function runtimeProfileSessionId(ref: unknown): string | undefined {
  if (typeof ref === "string") {
    const trimmed = ref.trim();
    return trimmed || undefined;
  }
  if (ref && typeof ref === "object" && "label" in ref && typeof ref.label === "string") {
    const trimmed = ref.label.trim();
    return trimmed || undefined;
  }
  return undefined;
}

function liveActivityRootTraceAttrs(
  result: LifecycleActivityBroadcastResult | undefined,
): Record<string, unknown> {
  if (!result) {
    return { live_activity_updated: false };
  }
  if (result.action === "kernel-preserve") {
    return {
      live_activity_updated: false,
      live_activity_arbitration_enabled: true,
      live_activity_arbitration_action: result.arbitration?.verdictAction ?? "preserve",
      live_activity_arbitration_reason: result.arbitration?.reason ?? "unknown",
      previous_activity_status: result.previousActivity ?? "none",
      next_activity_status: result.nextActivity,
      activity_status: result.nextActivity,
    };
  }
  const previous = result.previousActivity ?? "none";
  return {
    live_activity_updated: true,
    live_activity_arbitration_enabled: result.arbitration?.enabled ?? false,
    live_activity_arbitration_action: result.arbitration?.verdictAction ?? "legacy",
    live_activity_arbitration_reason: result.arbitration?.reason ?? "legacy_disabled",
    previous_activity_status: previous,
    next_activity_status: result.nextActivity,
    activity_status: result.nextActivity,
    activity_transition: `${previous}->${result.nextActivity}`,
  };
}

function oldestInboxMessageAgeMs(messages: readonly AgentMessage[], now: number): number | undefined {
  let oldest: number | undefined;
  for (const message of messages) {
    if (!message.timestamp) continue;
    const timestampMs = Date.parse(message.timestamp);
    if (!Number.isFinite(timestampMs)) continue;
    oldest = oldest == null ? timestampMs : Math.min(oldest, timestampMs);
  }
  return oldest == null ? undefined : Math.max(0, now - oldest);
}

interface MachineDisconnectContext {
  cause?:
    | "heartbeat_timeout"
    | "socket_close"
    | "socket_error"
    | "computer_machine_unlinked"
    | "legacy_machine_key_migrated"
    | "machine_credential_rotated"
    | "machine_credential_revoked";
  closeCode?: number;
  closeReason?: string;
  errorMessage?: string;
  shutdownIntent?: MachineShutdownIntent;
}

const MACHINE_UNLINKED_CLOSE_CODE = 4001;
const MACHINE_UNLINKED_CLOSE_REASON = "computer_machine_unlinked";
const LEGACY_PRINCIPAL_FENCED_CLOSE_CODE = 4002;
/** The machine's credential changed (rotated / revoked); the daemon reconnects and the handshake decides. */
const MACHINE_CREDENTIAL_CHANGED_CLOSE_CODE = 4004;
const LEGACY_PRINCIPAL_FENCED_CLOSE_REASON = "legacy_machine_key_migrated";
// Task #374: 4003, shared with the daemon, which picks its backoff from the reason.
const DUPLICATE_MACHINE_CONNECTION_CLOSE_CODE = MACHINE_DUPLICATE_CONNECTION_CLOSE_CODE;

/**
 * Task #374: the first 12 hex characters of sha256 over the reported hostname.
 * Only used to compare what two daemons reported; it is not anonymisation
 * (hostnames are guessable) and equal names do not prove the same host.
 */
export function reportedHostnameHash(hostname: unknown): string | null {
  if (typeof hostname !== "string" || !hostname.trim()) return null;
  return crypto.createHash("sha256").update(hostname.trim().toLowerCase(), "utf8").digest("hex").slice(0, 12);
}

/** First daemon release that waits 5 minutes after a duplicate refusal (#9348). */
const DUPLICATE_RECONNECT_DELAY_DAEMON_VERSION = "1.0.47";

/**
 * True when a daemon version predates the duplicate reconnect delay, or is
 * unknown (a version that never reported is far more likely old than new).
 */
export function daemonLacksDuplicateReconnectDelay(version: string | null | undefined): boolean {
  if (!version || !isComputerSemver(version)) return true;
  return compareComputerVersions(version, DUPLICATE_RECONNECT_DELAY_DAEMON_VERSION) < 0;
}

/** Task #374 enforcement is off unless SLOCK_MACHINE_DUPLICATE_CONNECTION_ENFORCEMENT is 1/true. */
export function duplicateMachineConnectionEnforcementEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.SLOCK_MACHINE_DUPLICATE_CONNECTION_ENFORCEMENT?.trim().toLowerCase();
  return value === "1" || value === "true";
}

interface PendingMachineDisconnectProjection {
  serverId: string;
  connectionEpochId: string;
  replicaGeneration: string | null;
  context: MachineDisconnectContext;
  timer: unknown;
}

interface PendingAgentSkillsListRequest {
  agentId: string;
  machineId: string;
  runtime: string;
  startedAtMs: number;
  timedOut: boolean;
  timeoutTimer: unknown | null;
  observationTimer: unknown | null;
}

interface PendingAgentDeliveryAck {
  machineId: string;
  msg: Extract<ServerToMachineMessage, { type: "agent:deliver" }>;
  timer: unknown | null;
  attempts: number;
  parked: boolean;
  parkedReason?: "machine_offline" | "computer_version_held";
  /** When the current parked period began; bounds how long a record may stay parked. */
  parkedAt?: number;
  /**
   * A tracked mention the daemon reported `daemon_pending` for: it reached the
   * daemon and waits for the agent to be told (possibly the end of the current
   * turn). SLI 4 counts arrival here; re-sends stop (task #432).
   */
  arrivedAt?: number;
  firstAttemptAt: number;
  lastAttemptAt: number;
  /**
   * When this record began its current wait for an ack on a live connection:
   * the first send, a reconnect re-send, or the re-send after a park. The
   * give-up bounds count from here, so time offline never counts against a
   * delivery; `firstAttemptAt` stays the SLO latency start (task #1295).
   */
  ackWaitStartedAt: number;
  /** Ack timeouts scheduled in the current wait; indexes the re-send backoff (task #1295). */
  ackWaits: number;
  /** SLO v1 SLI 4: the machine socket was open on this replica when the record was created. */
  onlineAtFirstAttempt: boolean;
  /**
   * The machine's daemon version when the record was created, as a metric
   * label value; fixed for the record so its tracked, latency and outcome
   * samples share one label set.
   */
  daemonVersion: string;
}

type AgentDeliveryOutcome =
  | "acked"
  | "gave_up"
  | "dropped"
  | "routed"
  | "terminal"
  | "agent_stopped"
  | "converted_to_wake"
  | "replica_shutdown"
  | "parked_expired"
  | "held_expired";

/**
 * What a give-up leaves behind so a late ack can still be counted: the SLO
 * labels and the identity for the log line, not the message itself.
 */
interface GaveUpAgentDelivery {
  givenUpAt: number;
  machineId: string;
  agentId: string;
  seq: number;
  deliveryId: string | null;
  labels: ReturnType<typeof agentDeliverySloLabels>;
}

type AgentStartMessage = Extract<ServerToMachineMessage, { type: "agent:start" }>;

type AgentStartDispatchTerminalReason =
  /** task #365: the daemon refused the start as claimed against an earlier connection. */
  | "stale_dispatch"
  | "acked"
  | "stopped"
  | "superseded"
  | "machine_reassigned"
  | "retry_exhausted";

interface PendingAgentStartAck {
  machineId: string;
  msg: AgentStartMessage & { startDispatchId: string };
  timer: unknown | null;
  attempts: number;
  parked: boolean;
  createdAt: number;
  lastAttemptAt: number;
  nextRetryAt: number | null;
}

interface StartAgentOptions {
  /**
   * Daemon-requested wake for a due app-inbox item (task #1103), the one
   * automatic retry after a retry-once start failure (see
   * `RETRY_ONCE_SPAWN_FAILURE_REASONS`), or `internal`: the spawn-error retry
   * sweep (task #365), or `ready_owed`: the wake a daemon `ready` owes an
   * agent whose wake a restart lost (reconciler step 13 F9,
   * startReadyOwedWakePass; never forwarded to another replica). All are
   * automatic starts, never a human start.
   */
  startCause?: "app_inbox_wake" | "start_failure_retry" | "internal" | "ready_owed";
  /**
   * task #365, set only for an `internal` start (startAgentForRetry) and a
   * `ready_owed` one (F9, the socket whose `ready` owes it): the epoch of
   * this replica's socket for the agent's machine when it decided to run the
   * start here. The start is stamped with it, so the daemon refuses it on
   * any other connection.
   */
  localConnectionEpochId?: string;
  resumePrompt?: string;
  wakeMessage?: AgentMessage;
  wakeMessageTransient?: boolean;
  requireQueueReceipt?: boolean;
  /**
   * RFC 071 §5: an explicit human start (E3) for the terminal-failure
   * breaker. Set only by named human control routes; never inferred from
   * `startCause` (task #1119 keeps its own rule). Every start without it is
   * automatic for that breaker.
   */
  control?: TerminalHumanStartControl;
}

/** RFC 071: what a start knows about its machine's outcome reporting (see `terminalStartContext`). */
interface TerminalStartContext {
  /** `agent:runtime-outcome-v1` applies to this agent here; `unknown` off the socket-owning replica. */
  capability: boolean | "unknown";
  /** The daemon advertises `agent:runtime-outcome-v1` (it has the outcome outbox), reliable or not. */
  daemonReportsOutcomes: boolean;
  daemonInstanceId: string | null;
}

/**
 * The lifecycle cause of a start. The retry after a retry-once start failure
 * stands in for the message wakes its hold refused, so it is a message cause:
 * automatic, never human.
 */
function lifecycleStartCause(options: StartAgentOptions): "message" | "manual" | "resume" | "app_inbox_wake" | "internal" | "ready_owed" {
  if (options.startCause === "start_failure_retry") return "message";
  return options.startCause ?? (options.wakeMessage ? "message" : options.resumePrompt ? "resume" : "manual");
}

/** RFC 071 §5: the only start control the terminal-failure breaker treats as human. */
export type TerminalHumanStartControl = "human_start";

/** RFC 071: refusals of the terminal-failure breaker (`AgentWakeRefusedReason` members). */
export type TerminalStartRefusal = TerminalWakeRefusal;

export type AgentStartDispatchResult =
  | { outcome: "dispatched" }
  | { outcome: "skipped"; reason: "manual_stop" | "wake_lock_held" | "wake_crash_loop_blocked" | "computer_version_unsupported" | "computer_access_revoked" | TerminalStartRefusal };

/** RFC 071 §9: the server-authored detail of a `terminal_failure_paused` activity (ids/classes/times only). */
export function terminalBlockDetail(view: TerminalBlockView): string {
  if (view.kind === "paused") {
    const why = view.failureKind ? ` after repeated runtime failures (${view.failureKind})` : " after repeated runtime failures";
    return `Automatic wake paused until ${new Date(view.blockedUntilMs).toISOString()}${why}. `
      + "The next message, reminder or manual start after that retries; a manual start lifts it now.";
  }
  const why = view.reason === "outcome_unobservable"
    ? "This computer can no longer report runtime outcomes for this agent."
    : view.reason === "outcome_evidence_lost"
      ? "Runtime outcome reports for this agent were lost."
      : "The previous runtime process could not be confirmed stopped.";
  return `Automatic wake stopped: ${why} A manual start is needed.`;
}

/**
 * RFC 071: the terminal-failure breaker's record could not be read or
 * written, so the start's pending entry cannot be recorded before dispatch
 * (RFC 4.3 rule 1). The start is not dispatched.
 */
export class TerminalBreakerStorageUnavailableError extends Error {
  readonly code = "terminal_failure_breaker_storage_unavailable" as const;

  constructor(readonly cause: unknown) {
    super("Agent start not dispatched: the terminal-failure breaker state is unavailable");
    this.name = "TerminalBreakerStorageUnavailableError";
  }
}

class CrossReplicaQueueReceiptUnavailableError extends Error {
  constructor() {
    super("Cross-replica dispatch has no target-side queue acknowledgement");
    this.name = "CrossReplicaQueueReceiptUnavailableError";
  }
}

export class KimiReasoningEffortUpgradeRequiredError extends Error {
  readonly code = "upgrade_required" as const;

  constructor() {
    super("Update Raft on this computer before starting a Kimi agent with an explicit reasoning setting");
    this.name = "KimiReasoningEffortUpgradeRequiredError";
  }
}

type StopAgentReason = "manual" | "internal";

/** Reconciler step 11b: whether `applyAgentConfig` sent the agent's daemon its new config. */
export type AgentConfigApplyOutcome = "pushed" | "not_pushed";

/** Whether the stop reached the daemon. False: only the server-side state changed. */
export interface AgentStopResult {
  delivered: boolean;
}

export interface ResetAgentOptions {
  restartEvenIfInactive?: boolean;
  restartIfStopped?: boolean;
  /**
   * RFC 071 §5: an E3 reset. Set by the human reset route, and by a settings
   * change whose runtime values really differ. The terminal-failure breaker
   * lifts, and the restart is a human takeover start. Absent: the reset's
   * restart is an automatic start for that breaker.
   */
  terminalControl?: "human_reset" | "runtime_config_changed";
}
type PersistedAgentRow = NonNullable<Awaited<ReturnType<typeof agentService.getAgent>>>;

/** Cached agent state for delivery — avoids DB reads in hot path. */
interface CachedAgentState {
  id: string;
  /**
   * User/server intent, not proof that a runtime process is currently alive.
   * `active` means the agent is allowed to be served and may be lazy-woken.
   * Manual `stopped` is the true offline/unwakeable state.
   */
  status: AgentStatus;
  machineId: string | null;
  sessionId: string | null;
  expectedLaunchId: string | null;
  launchGuardMode: "legacy" | "guarded";
  serverId: string;
  /** Set for a personal assistant: its events reach only this user (agentEventRoom). */
  assistantOwnerUserId: string | null;
  name: string;
  displayName: string | null;
  description: string | null;
  model: string;
  runtime: string;
  runtimeConfig: RuntimeConfig;
  lastRuntimeError: AgentRuntimeErrorState | null;
  /**
   * Ephemeral runtime-process presence/state observed from daemon signals.
   * Daemon restart can make this `not_running` while `status` remains active.
   */
  runtimeState: LifecycleRuntimeState;
  reasoningEffort: RuntimeReasoningEffort | null;
  envVars: Record<string, string> | null;
}

/**
 * task #25 step 2: the daemon may wait up to 10 s for a native interrupt to
 * end the turn before it restarts the runtime instead, then answers.
 */
const INTERRUPT_TURN_RELAY_BUDGET_MS = 20_000;

export type AgentTurnInterruptRequestResult =
  | { outcome: AgentTurnInterruptOutcome; toolName?: string; stuckForMs?: number }
  | { outcome: "computer_offline" | "computer_upgrade_required" };

export type AgentSubagentInterruptRequestResult =
  | { outcome: AgentSubagentInterruptOutcome }
  | { outcome: "computer_offline" | "computer_upgrade_required" };

type ActivitySnapshot = {
  activity: AgentActivityKind;
  detail: string;
  detailKind: AgentActivityDetailKind;
  observedAtMs?: number;
  updatedAt: number;
  /**
   * task #1116: present only while detailKind === "delivery_unconsumed". The
   * daemon's typed observation carrier, passed through unchanged for the web.
   * Mirrored with the snapshot to the replica state store so non-owner
   * replicas read it back (task #1116); a later activity write drops it.
   */
  deliveryConsumption?: DeliveryConsumptionActivityDiagnostic;
  /** task #1119: present only while detailKind === "wake_crash_loop_blocked". */
  wakeCrashLoop?: WakeCrashLoopActivityDiagnostic;
  /**
   * task #1123: present only while detailKind === "runtime_unavailable" after
   * a failed start. The daemon's typed reason, passed through unchanged.
   */
  spawnFailure?: SpawnFailureActivityDiagnostic;
  /**
   * task #25: the daemon's stuck-tool state, whatever the detail kind. The
   * daemon puts it on every frame while the agent is stuck, so it is exactly
   * the latest daemon frame's value; any other write clears it.
   */
  toolStuck?: ToolStuckActivityDiagnostic;
  /**
   * Reconciler step 4b: present only while detailKind === "idle" and the
   * daemon's idle frame showed the credential-invalid held notice. The
   * daemon's typed reason, passed through unchanged; any other write drops it.
   */
  credentialHold?: CredentialHoldActivityDiagnostic;
};

type ActivityClockSnapshot = {
  observedAtMs?: number;
  updatedAt: number;
};

type VisibleActivity = {
  activity: AgentActivityKind;
  activityDetail: string;
  /** task #1116: typed detail kind of the served snapshot, when one exists. */
  activityDetailKind?: AgentActivityDetailKind;
  /** task #1116: the daemon's delivery-consumption carrier, when the served snapshot is delivery_unconsumed. */
  deliveryConsumption?: DeliveryConsumptionActivityDiagnostic;
  /** task #1119: the server's wake crash-loop breaker state, when the served snapshot is wake_crash_loop_blocked. */
  wakeCrashLoop?: WakeCrashLoopActivityDiagnostic;
  /** task #1123: the daemon's typed spawn-failure reason, when the served snapshot is runtime_unavailable. */
  spawnFailure?: SpawnFailureActivityDiagnostic;
  /** task #25: the agent is stuck on a tool call, whatever the served detail kind. */
  toolStuck?: ToolStuckActivityDiagnostic;
  /** Reconciler step 4b: the held notice's typed reason, when the served snapshot is an idle frame showing it. */
  credentialHold?: CredentialHoldActivityDiagnostic;
};

type MachineReachability = "local" | "remote" | "offline" | "none" | "external-reported";

/**
 * task #1116 / #1119: the typed carriers that travel with the activity snapshot
 * — on the socket payload, and in the same shared-store write so a non-owner
 * replica's refresh read-back exposes them. Only the carrier matching the
 * served detail kind rides; a write of any other kind carries none, which
 * clears the mirrored field.
 */
function snapshotTypedCarriers(snapshot: ActivitySnapshot): ActivityTypedCarriers | undefined {
  const kindCarrier = kindTypedCarrier(snapshot);
  // task #25: not tied to a detail kind; rides along with any of them.
  if (!snapshot.toolStuck) return kindCarrier;
  return { ...kindCarrier, toolStuck: snapshot.toolStuck };
}

function kindTypedCarrier(snapshot: ActivitySnapshot): ActivityTypedCarriers | undefined {
  if (snapshot.detailKind === "delivery_unconsumed" && snapshot.deliveryConsumption) {
    return { deliveryConsumption: snapshot.deliveryConsumption };
  }
  if (snapshot.detailKind === "wake_crash_loop_blocked" && snapshot.wakeCrashLoop) {
    return { wakeCrashLoop: snapshot.wakeCrashLoop };
  }
  if (snapshot.detailKind === "runtime_unavailable" && snapshot.spawnFailure) {
    return { spawnFailure: snapshot.spawnFailure };
  }
  if (snapshot.detailKind === "idle" && snapshot.credentialHold) {
    return { credentialHold: snapshot.credentialHold };
  }
  return undefined;
}

/**
 * task #1116: rebuild a snapshot from the shared mirror, carriers included, so
 * the non-owner read path formats exactly what the owner wrote.
 */
function activitySnapshotFromPersisted(persisted: PersistedAgentActivity | null): ActivitySnapshot | null {
  if (!persisted) return null;
  const { carriers, ...rest } = persisted;
  return {
    ...rest,
    ...(carriers?.deliveryConsumption ? { deliveryConsumption: carriers.deliveryConsumption } : {}),
    ...(carriers?.wakeCrashLoop ? { wakeCrashLoop: carriers.wakeCrashLoop } : {}),
    ...(carriers?.spawnFailure ? { spawnFailure: carriers.spawnFailure } : {}),
    ...(carriers?.toolStuck ? { toolStuck: carriers.toolStuck } : {}),
    ...(carriers?.credentialHold ? { credentialHold: carriers.credentialHold } : {}),
  };
}

type ActivityHintSource = "local-cache" | "redis";

type WeakOfflineSource = "owner_missing" | "replica_state_unavailable" | "self_owner_without_local_connection";

type WeakOfflineCompetingFact = "redis_busy_activity" | "persisted_busy_activity";

/**
 * Reads an agent-list request fetched for every listed agent up front (one
 * round trip each), served to the per-agent activity resolution in place of
 * its one-key-at-a-time reads. Absent key = not prefetched: read as before.
 */
type ActivityReadPrefetch = {
  agentActivity: Map<string, PersistedAgentActivity | null>;
  runtimeError: Map<string, AgentRuntimeErrorMirror | null>;
  replicaOwner: Map<string, string | null>;
  latestHint: Map<string, PersistedAgentActivityHint | null>;
};

/**
 * One channel's delivery gates read for all of its recipients at once: each
 * agent's row (null = unavailable), whether the agent can access the channel,
 * whether it holds the passive-delivery scope and whether an active migration
 * gates it. An agent missing from `access`, `passiveScope` or
 * `migrationGated` is checked on its own.
 */
export type DeliveryGates = {
  agents: Map<string, PersistedAgentRow | null>;
  access: Map<string, boolean>;
  passiveScope: Map<string, boolean>;
  migrationGated: Map<string, boolean>;
  raftbenchServices?: Set<string>;
};

type ActivityTraceOptions = {
  parent?: TraceContext | null;
  /**
   * The agent's row as the caller loaded it in this request (e.g. the agent
   * list). Stands in for the cache-miss and authoritative re-reads, which would
   * return the same row moments later: a live row seeds the cache, a deleted
   * row resolves as "no agent" (getAgent excludes deleted rows) without a query.
   */
  persistedAgent?: PersistedAgentRow;
  /** Reads getActivities made for the whole list; a key present here is not read again. */
  prefetched?: ActivityReadPrefetch;
};

type RuntimeContextMachine = {
  name: string;
  description: string | null;
  hostname: string | null;
  os: string | null;
} | null;

export type AgentLifecycleAction = "start" | "stop" | "reset" | "wake";
export type AgentLifecycleOutcome = "attempted" | "completed" | "failed" | "skipped" | "suppressed";
export type AgentLifecycleCause = "message" | "manual" | "resume" | "app_inbox_wake" | "internal" | "ready_owed" | "restart" | "session" | "full";

export interface StaleActivitySweepPlanInput {
  isTransient: boolean;
  ageSec: number;
  staleAfterSec: number;
}

export type StaleActivitySweepPlanAction = "keep-current" | "sweep-online";

export function planStaleActivitySweepAction(input: StaleActivitySweepPlanInput): StaleActivitySweepPlanAction {
  return input.isTransient && input.ageSec > input.staleAfterSec ? "sweep-online" : "keep-current";
}

export interface ActivityBroadcastPlanInput {
  hasEntries: boolean;
  isHeartbeat: boolean;
  isProbeResponse: boolean;
  isDeliveryAckTurnActive: boolean;
  shouldPersistStatusOnly: boolean;
}

export type ActivityBroadcastPlanAction =
  | "persist-and-emit-now"
  | "heartbeat-refresh"
  | "probe-refresh"
  | "delivery-ack-refresh"
  | "debounce-only";
type ActivityBroadcastWriteAction = ActivityBroadcastPlanAction | "kernel-preserve";

interface ActivityWriteArbitrationTrace {
  enabled: boolean;
  reason: LifecycleArbitrationVerdict["reason"] | "legacy_disabled";
  verdictAction: LifecycleArbitrationVerdict["action"] | "legacy";
}

export function planActivityBroadcastAction(input: ActivityBroadcastPlanInput): ActivityBroadcastPlanAction {
  // Entries are authoritative history even if a buggy producer marks the
  // frame as a replay. Status-only heartbeat/probe snapshots and the
  // delivery-ack turn-active overlay are refresh-only by contract: they
  // reassert current truth, not a new user-visible fact.
  if (input.hasEntries) return "persist-and-emit-now";
  if (input.isHeartbeat) return "heartbeat-refresh";
  if (input.isProbeResponse) return "probe-refresh";
  if (input.isDeliveryAckTurnActive) return "delivery-ack-refresh";
  return input.shouldPersistStatusOnly ? "persist-and-emit-now" : "debounce-only";
}

export interface RuntimeProfileHeartbeatNudgePlanInput {
  disabled: boolean;
  lastSentAt: number | null;
  now: number;
  cooldownMs: number;
}

export type RuntimeProfileHeartbeatNudgePlanAction = "disabled" | "cooldown" | "allow";

export function planRuntimeProfileHeartbeatNudgeAction(
  input: RuntimeProfileHeartbeatNudgePlanInput,
): RuntimeProfileHeartbeatNudgePlanAction {
  if (input.disabled) return "disabled";
  if (input.lastSentAt !== null && input.now - input.lastSentAt < input.cooldownMs) {
    return "cooldown";
  }
  return "allow";
}

export interface ReminderFireReceiptPlanInput {
  reminderExists: boolean;
  reminderServerMatchesAgent: boolean;
  reminderOwnerAgentId: string | null;
  reminderVersion: number;
  reminderStatus: string;
  receiptAgentId: string;
  receiptVersion: number;
}

export type ReminderFireReceiptPlanAction =
  | "reject"
  | "converge-current"
  | "ack-historical"
  | "noop";

export function shouldEmitReminderFiredLifecycle(result: { fired: boolean }): boolean {
  return result.fired;
}

/**
 * A fire receipt is authorized by the Computer agent that owned the revision
 * which fired. A later owner rebind must not strand that already-committed
 * historical receipt, while a receipt for the current/future revision must
 * still match the current owner.
 */
export function planReminderFireReceiptAction(
  input: ReminderFireReceiptPlanInput,
): ReminderFireReceiptPlanAction {
  if (!input.reminderExists || !input.reminderServerMatchesAgent) return "reject";
  if (
    input.reminderVersion <= input.receiptVersion &&
    input.reminderOwnerAgentId !== input.receiptAgentId
  ) {
    return "reject";
  }
  if (input.reminderVersion > input.receiptVersion) return "ack-historical";
  if (input.reminderVersion === input.receiptVersion && input.reminderStatus === "scheduled") {
    return "converge-current";
  }
  return "noop";
}

function protocolSourceTraceAttrs(input: {
  ownerAgentId: string;
  sourceId: string;
  version: number;
  messageType: string;
}) {
  return appSourceTraceAttrs({
    ownerAgentId: input.ownerAgentId,
    sourceRef: {
      kind: input.messageType.split(".", 1)[0]!,
      id: input.sourceId,
      revision: String(input.version),
    },
  });
}

type ActivityBroadcastTraceResult = {
  action: ActivityBroadcastWriteAction;
  arbitration?: ActivityWriteArbitrationTrace;
  persistedEntryCount: number;
  previousActivity: AgentActivityKind | null;
  nextActivity: AgentActivityKind;
  persistence?: Promise<ActivityPersistenceOutcome>;
};

interface AgentActivitySnapshotWriteResult {
  action: "map-write" | "kernel-preserve";
  arbitration: ActivityWriteArbitrationTrace;
  nextActivity: AgentActivityKind;
  previousActivity: AgentActivityKind | null;
  snapshot?: ActivitySnapshot;
}

type ActivityPersistenceOutcome = "applied" | "deduped" | "error";

type DeliveryAckTurnActiveGate = {
  admit: boolean;
  reason: "runtime_liveness_failed_or_unknown" | "stale_runtime_observation" | null;
  runtimeState: LifecycleRuntimeState;
  currentActivity: AgentActivityKind | null;
  observedAgeSec: number | null;
};

export interface ActivityHintResolutionPlanInput {
  hasStoppedOfflineHint: boolean;
  reachability: MachineReachability;
  shouldTrustRecoveredOfflineHint: boolean;
  weakOfflineSource?: WeakOfflineSource;
  weakOfflineCompetingFact?: WeakOfflineCompetingFact;
  source: ActivityHintSource;
  isFreshLocalCache: boolean;
}

export type ActivityHintResolutionPlanAction =
  | "return-snapshot"
  | "return-offline"
  | "ignore-hint"
  | "return-read-through-snapshot";

type ActivityHintArbitrationReason =
  | "trusted_snapshot"
  | "owner_mirror_read_through";

export function planActivityHintResolutionAction(
  input: ActivityHintResolutionPlanInput,
): ActivityHintResolutionPlanAction {
  if (input.reachability === "local") {
    return "return-snapshot";
  }

  if (input.hasStoppedOfflineHint) {
    return "return-snapshot";
  }

  if (input.reachability === "offline" || input.reachability === "none") {
    if (input.weakOfflineSource && input.weakOfflineCompetingFact) {
      return input.source === "local-cache" ? "return-snapshot" : "return-read-through-snapshot";
    }
    return "return-offline";
  }

  if (input.reachability === "external-reported") {
    return "return-read-through-snapshot";
  }

  if (input.shouldTrustRecoveredOfflineHint) {
    return "ignore-hint";
  }

  if (input.source === "local-cache") {
    return input.isFreshLocalCache ? "return-snapshot" : "ignore-hint";
  }

  return "return-read-through-snapshot";
}

export interface MachineReachabilityPlanInput {
  hasMachineId: boolean;
  hasLocalMachine: boolean;
  replicaStateAvailable: boolean;
  ownerReplica: string | null;
  isExternalRuntime: boolean;
}

export function planMachineReachability(input: MachineReachabilityPlanInput): MachineReachability {
  if (!input.hasMachineId) {
    return input.isExternalRuntime ? "external-reported" : "none";
  }

  if (input.hasLocalMachine) {
    return "local";
  }

  if (!input.replicaStateAvailable) {
    return "offline";
  }

  if (!input.ownerReplica || input.ownerReplica === REPLICA_ID) {
    return "offline";
  }

  return "remote";
}

interface MachineReachabilityInputContext {
  agent: CachedAgentState | null;
  prefetched?: ActivityReadPrefetch;
}

export interface StaleTransientNormalizationPlanInput {
  isTransient: boolean;
  ageSec: number;
  staleAfterSec: number;
}

export type StaleTransientNormalizationPlanAction = "keep-current" | "normalize-online";

export function planStaleTransientNormalizationAction(
  input: StaleTransientNormalizationPlanInput,
): StaleTransientNormalizationPlanAction {
  return input.isTransient && input.ageSec > input.staleAfterSec ? "normalize-online" : "keep-current";
}

interface StaleActivitySweepApplyContext {
  action: StaleActivitySweepPlanAction;
  agentId: string;
  now: number;
}

interface ActivityBroadcastApplyContext {
  action: ActivityBroadcastPlanAction;
  agentId: string;
  activity: AgentActivityKind;
  detail: string;
  detailKind: AgentActivityDetailKind;
  now: number;
  persistedEntries: TrajectoryEntry[];
  dedupeKey?: string;
  /**
   * Optional daemon-side join keys (task #136). When present, threaded
   * into the Socket.IO `agent:activity` payload alongside `serverSeq`
   * so feedback-export bundles can exact-join the broadcast row back
   * to `server.agent.activity.ingest`. Status-only debounced broadcasts
   * don't carry these because their final-state emit can merge multiple
   * upstream daemon messages with different launch keys.
   */
  launchId?: string;
  clientSeq?: number;
  probeId?: string;
  producerFactId?: string;
  isHeartbeat?: boolean;
  /** task #1116/#1119: typed carriers of the snapshot this broadcast wrote, so the emit does not depend on a later snapshot. */
  carriers?: ActivityTypedCarriers;
}

type ActivityTypedCarriers = PersistedActivityTypedCarriers;

type ActivityBroadcastArbitrationInput = {
  observationClass: LifecycleObservationClass;
  signalSite: LifecycleShadowSignalSite;
  planKind?: AgentLifecycleEventType;
};

interface ActivityHintResolutionApplyContext {
  action: ActivityHintResolutionPlanAction;
  agentId: string;
  snapshot: ActivitySnapshot;
}

interface ActivityHintResolutionInputContext {
  agent: CachedAgentState | null;
  snapshot: ActivitySnapshot;
  source: ActivityHintSource;
  prefetched?: ActivityReadPrefetch;
}

interface StaleTransientNormalizationApplyContext {
  action: StaleTransientNormalizationPlanAction;
  agentId: string;
  source: ActivityHintSource;
  now: number;
}

export interface SendToMachinePlanInput {
  hasReadyLocalConnection: boolean;
  canReroute: boolean;
}

export type SendToMachinePlanAction =
  | "send-locally"
  | "reroute-then-warn"
  | "warn-offline";

/**
 * The HTTP status a POST redrive answers with, as a pure function of the orchestrator verdict.
 *
 * EXTRACTED 2026-08-20 because @Kabi's CHANGES REQUIRED measured this write path at ZERO arms
 * across all three of its layers (route, authorize function, orchestrator method) — and the
 * mapping lived inline in a nested ternary inside the route, where nothing could reach it without
 * standing up an HTTP app.
 *
 * The distinction this function exists to protect is "queued" versus "everything else". A redrive
 * that did not queue must never answer 202, because 202 is the only answer a caller reads as
 * "delivery was re-attempted". ACKED and CAS_MISMATCH are the two verdicts most likely to be
 * mistaken for success by a future edit: the first means the message already arrived, the second
 * means someone else moved the row first — in both cases re-delivering would duplicate.
 */
// DERIVED FROM THE PRODUCER, NEVER HAND-LISTED. My first version enumerated these by hand and was
// wrong in both directions: it omitted BROKEN_HOP and invented three states that do not exist.
// tsc caught it, but the deeper point is that a hand-copied enumeration silently rots the moment
// the method gains a verdict — and this mapping's whole job is to be exhaustive over that set.
export type MentionRedriveVerdict =
  Awaited<ReturnType<AgentOrchestrator["redriveMentionDelivery"]>>["status"];

export function planMentionRedriveHttpStatus(verdict: MentionRedriveVerdict): 202 | 404 | 409 {
  if (verdict === "REDRIVE_QUEUED") return 202;
  if (verdict === "NOT_JOINABLE") return 404;
  return 409;
}

export function planSendToMachineAction(input: SendToMachinePlanInput): SendToMachinePlanAction {
  if (input.hasReadyLocalConnection) {
    return "send-locally";
  }
  return input.canReroute ? "reroute-then-warn" : "warn-offline";
}

function normalizeMachineCommandRouteResult(result: boolean | MachineCommandRouteResult): MachineCommandRouteResult {
  if (typeof result !== "boolean") return result;
  return {
    routed: result,
    reason: result ? "published" : "owner_missing",
    ownerReplicaPresent: false,
    ownerReplicaCurrent: false,
    ownerCohort: "unknown",
    ownerRequestHostClass: "unknown",
    ownerRequestHostPresent: false,
    receiverPresent: false,
    receiverKind: "none",
    receiverReplicaCurrent: false,
  };
}

export function projectMachineCommandRouteTraceAttrs(result: MachineCommandRouteResult): Record<string, unknown> {
  return {
    router_reason: result.reason,
    router_routed: result.routed,
    ...(result.ownerReplicaPresent !== undefined ? { owner_replica_present: result.ownerReplicaPresent } : {}),
    ...(result.ownerReplicaCurrent !== undefined ? { owner_replica_current: result.ownerReplicaCurrent } : {}),
    ...(result.ownerReplicaTtlSeconds !== undefined ? { owner_replica_ttl_seconds: result.ownerReplicaTtlSeconds } : {}),
    ...(result.ownerReplicaAgeMs !== undefined ? { owner_replica_age_ms: result.ownerReplicaAgeMs } : {}),
    ...(result.receiverPresent !== undefined ? { receiver_present: result.receiverPresent } : {}),
    ...(result.receiverKind !== undefined ? { receiver_kind: result.receiverKind } : {}),
    ...(result.receiverReplicaCurrent !== undefined ? { receiver_replica_current: result.receiverReplicaCurrent } : {}),
    ...(result.publishReceivers !== undefined ? { publish_receivers: result.publishReceivers } : {}),
    ...(result.staleOwnerCleanupResult !== undefined ? { stale_owner_cleanup_result: result.staleOwnerCleanupResult } : {}),
    ...(result.staleOwnerCleanupReason !== undefined ? { stale_owner_cleanup_reason: result.staleOwnerCleanupReason } : {}),
  };
}

export interface StopPlanInput {
  reason: StopAgentReason;
}

export type StopPlanAction = "persist-stopped" | "persist-inactive";

export function planStopAction(input: StopPlanInput): StopPlanAction {
  return input.reason === "manual" ? "persist-stopped" : "persist-inactive";
}

export interface LocalDeliveryGatePlanInput {
  hasAgent: boolean;
  status: AgentStatus | null;
  machineMatches: boolean;
}

export type LocalDeliveryGatePlanAction = "deliver-locally" | "drop-delivery";

export function planLocalDeliveryGateAction(input: LocalDeliveryGatePlanInput): LocalDeliveryGatePlanAction {
  if (!input.hasAgent) {
    return "drop-delivery";
  }
  return input.status === "active" && input.machineMatches ? "deliver-locally" : "drop-delivery";
}

export interface RoutedOwnershipPlanInput {
  machineIsLocal: boolean;
  canReroute: boolean;
}

export type RoutedOwnershipPlanAction =
  | "handle-locally"
  | "reroute-then-fallback"
  | "fallback";

export function planRoutedOwnershipAction(input: RoutedOwnershipPlanInput): RoutedOwnershipPlanAction {
  if (input.machineIsLocal) {
    return "handle-locally";
  }
  return input.canReroute ? "reroute-then-fallback" : "fallback";
}

interface StopApplyContext {
  agentId: string;
  serverId: string;
  machineId: string | null;
  reason: StopAgentReason;
  /** The `agent:stop` reason for the daemon; absent: none is sent (a lifecycle stop). */
  daemonReason?: AgentStopReason;
  previousStatus: AgentStatus;
  nextStatus: AgentStatus;
}

interface WakeApplyContext {
  agentId: string;
  machineId: string | null;
  previousStatus: AgentStatus;
  resetMode: "restart" | "session" | "full" | null;
  transient?: boolean;
  requireQueueReceipt?: boolean;
  mentionDeliveryOccurrenceId?: string;
}

const DELIVERY_CHANNEL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DELIVERY_CHANNEL_LABEL_RE = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * Bounded telemetry label for an AgentMessage channel_id: `uuid` for a real
 * channel id, the label itself for synthetic targets such as
 * `onboarding-context` (prefix before `:` only, so ids embedded after it never
 * leak), `other` for anything else.
 */
export function deliveryChannelKind(channelId: string | null | undefined): string {
  if (!channelId) return "none";
  if (DELIVERY_CHANNEL_UUID_RE.test(channelId)) return "uuid";
  const label = channelId.split(":", 1)[0] ?? "";
  return DELIVERY_CHANNEL_LABEL_RE.test(label) ? label : "other";
}

interface DirectDeliveryContext {
  agentId: string;
  machineId: string | null;
  /**
   * Require proof that this server established replayable inbox state before
   * returning `queued`. Redis pub/sub publication alone does not satisfy this:
   * the target replica may have no subscriber or may reject the enqueue after
   * revalidating agent state/access.
   */
  requireQueueReceipt?: boolean;
  /**
   * Skip the replayable inbox enqueue and just do a best-effort ws send.
   * Used for transient wakes where:
   *   - the wake doesn't have a `seq` allocated from `messages.seq`, so the
   *     inbox can't ack/remove it (`partitionAcknowledgedMessages` requires
   *     truthy seq), and
   *   - re-delivering on reconnect would be wrong: the audit lives in
   *     `reminder_events`, the owner sees fire history via the reminder UI,
   *     and a missed wake is recoverable on the agent's own initiative.
   */
  transient?: boolean;
  mentionDeliveryOccurrenceId?: string;
  /**
   * `DeliverMessageOptions.intrinsic` of the original server-side call. The
   * sending replica already skipped the target visibility check for it, so the
   * plain cross-replica inbox route forwards it in the replica envelope and the
   * owning replica skips the same check (see `handleRoutedInboxDelivery`).
   */
  intrinsic?: boolean;
}

/**
 * Options for `agentOrchestrator.deliverMessage`.
 */
export interface DeliverMessageOptions {
  /** Skip the replayable inbox; ws-send only. See `DirectDeliveryContext.transient`. */
  transient?: boolean;
  /**
   * Return `queued` only when this process can prove replayable inbox state was
   * established. Cross-replica pub/sub remains best-effort until it has a
   * target-side typed acknowledgement.
   */
  requireQueueReceipt?: boolean;
  /**
   * Bypass the `inbox:receive` scope gate because the delivery was initiated by
   * a server owner/admin. This keeps a human authority lane open even when an
   * agent's ordinary inbox notifications are disabled.
   */
  adminAuthority?: boolean;
  /**
   * Bypass the `inbox:receive` scope gate. Set by intrinsic deliveries that
   * the agent cannot opt out of: reminder fire wakes, action-card execution
   * notices, and other author-owned events about the agent's own state.
   *
   * Default false — chat / in-channel system / task message deliveries all
   * gate by `inbox:receive`. This is intentionally separate from
   * `message:read`: read gates active CLI/history access; inbox:receive gates
   * passive server delivery and wake.
   *
   * The "intrinsic" lane is the same model as Discord gateway intents vs
   * session events: inbox receive gates other-principal content; the bot always
   * gets its own session/lifecycle events. In Slock terms, channel
   * messages are other-principal content (gated); reminder fires and
   * action-card notices are author-owned (intrinsic).
   */
  intrinsic?: boolean;
  /**
   * Replace a queued same-seq `non_member_mention` projection after the
   * recipient has authoritatively become a channel member. This must only be
   * set by the membership transaction; an ordinary replay without the marker
   * remains strict dedupe and cannot infer a capability upgrade.
   */
  reconcileNonMemberMention?: boolean;
  /** Stable message_mentions.id for the one durable mention occurrence. */
  mentionDeliveryOccurrenceId?: string;
}

/** Server-side handoff receipt. `queued` never proves daemon/model consumption. */
export type AgentMessageDeliveryResult =
  | {
      status: "queued";
      reason: "external_inbox" | "control_gate_inbox" | "wake_accepted" | "replayable_inbox" | "direct_dispatch";
    }
  | {
      status: "dropped";
      reason:
        | "agent_unavailable"
        | "raftbench_service_no_chat"
        | "passive_scope_revoked"
        | "target_access_changed"
        | "transient_delivery_unsupported"
        | "reset_in_progress"
        | "wake_failed"
        | "wake_suppressed"
        | "cross_replica_receipt_unavailable"
        | "agent_state_changed";
    };

function normalizeRoutedInboxDeliveryReceipt(
  receipt: RoutedInboxDeliveryReceipt,
): AgentMessageDeliveryResult {
  if (receipt.status === "queued") {
    const reason = receipt.reason;
    if (
      reason === "external_inbox"
      || reason === "control_gate_inbox"
      || reason === "wake_accepted"
      || reason === "replayable_inbox"
      || reason === "direct_dispatch"
    ) {
      return { status: "queued", reason };
    }
    return { status: "dropped", reason: "cross_replica_receipt_unavailable" };
  }

  const reason = receipt.reason;
  if (
    reason === "agent_unavailable"
    || reason === "raftbench_service_no_chat"
    || reason === "passive_scope_revoked"
    || reason === "target_access_changed"
    || reason === "transient_delivery_unsupported"
    || reason === "reset_in_progress"
    || reason === "wake_failed"
    || reason === "wake_suppressed"
    || reason === "cross_replica_receipt_unavailable"
    || reason === "agent_state_changed"
  ) {
    return { status: "dropped", reason };
  }
  return { status: "dropped", reason: "cross_replica_receipt_unavailable" };
}

interface LocalDeliveryGateApplyContext {
  action: LocalDeliveryGatePlanAction;
  agentId: string;
  message: AgentMessage;
}

interface SendToMachineApplyContext {
  action: SendToMachinePlanAction;
  machineId: string;
  msg: ServerToMachineMessage;
  sendLocally: () => boolean;
  reroute: () => Promise<boolean | MachineCommandRouteResult>;
  onRouteResult?: (result: MachineCommandRouteResult) => void;
}

interface RoutedOwnershipApplyContext {
  action: RoutedOwnershipPlanAction;
  handleLocally: () => boolean | Promise<boolean>;
  rerouteToCurrentOwner: () => Promise<boolean>;
  fallback: () => boolean | Promise<boolean>;
}

export interface ReadyReconcilePlanInput {
  status: AgentStatus;
  running: boolean;
  resetMode: "restart" | "session" | "full" | null;
}

export type ReadyReconcilePlanAction =
  | "force-stop-and-stay-offline"
  | "mark-active-online"
  | "mark-wakeable-not-running"
  | "mark-inactive-offline"
  | "stay-offline";

/** F9: one `ready`'s owed-wake pass (startReadyOwedWakePass). */
interface ReadyOwedWakeRun {
  agentIds: string[];
  serverId: string;
  /** The socket whose `ready` this is: the pass stops once it is replaced, and its starts carry it. */
  connectionEpochId: string;
}

/**
 * F9: the conversations the agent is offered unread in past its read position,
 * from its inbox chain rows, each up to the newest message it is offered: the
 * latest message where it is subscribed, the latest @mention of it where it is
 * not (a muted channel, where only a mention pierces the mute). The chain view
 * owns the offer rules (membership, active follow, mute), the same rules that
 * decide which messages are delivered (and so wake) at all.
 */
export function readyOwedCandidateTargets(rows: readonly channelService.AgentInboxChainRow[]): UnowedReadBacklogTarget[] {
  const targets: UnowedReadBacklogTarget[] = [];
  for (const row of rows) {
    if (row.offeredUnread <= 0) continue;
    const throughSeq = row.subscribed ? row.latestSeq : row.maxMentionSeq;
    if (throughSeq === null || throughSeq <= row.lastReadSeq) continue;
    targets.push({ channelId: row.targetId, throughSeq });
  }
  return targets;
}

export function planReadyReconcileAction(input: ReadyReconcilePlanInput): ReadyReconcilePlanAction {
  if (input.running) {
    if (input.status === "stopped" || input.resetMode) {
      return "force-stop-and-stay-offline";
    }
    return "mark-active-online";
  }

  if (input.status !== "active") {
    return "stay-offline";
  }

  // Missing from daemon ready means the runtime process is absent, not that the
  // agent was manually stopped. Keep active agents wakeable unless a reset gate
  // is deliberately draining the old process/session.
  return input.resetMode ? "mark-inactive-offline" : "mark-wakeable-not-running";
}

export interface ResetPlanInput {
  mode: "restart" | "session" | "full";
  hasMachine: boolean;
  restart?: boolean;
}

export type ResetPlanAction = "stop-internal" | "clear-session" | "reset-workspace" | "restart";

export function planResetActions(input: ResetPlanInput): ResetPlanAction[] {
  const actions: ResetPlanAction[] = ["stop-internal"];

  if (input.mode === "session" || input.mode === "full") {
    actions.push("clear-session");
  }

  if (input.mode === "full" && input.hasMachine) {
    actions.push("reset-workspace");
  }

  if (input.restart !== false) {
    actions.push("restart");
  }
  return actions;
}

export function normalizeDaemonAgentStatus(status: string): DaemonReportedAgentStatus {
  if (status === "sleeping") return "active";
  return status === "active" || status === "inactive" ? status : null;
}

export interface LifecycleEventAcceptanceInput {
  launchGuardMode: "legacy" | "guarded";
  expectedLaunchId: string | null;
  launchId?: string;
}

export type LifecycleEventAcceptanceAction =
  | "accept"
  | "ignore-legacy-for-guarded"
  | "ignore-stale-launch";

type MachineAgentValidationDropReason =
  | "missing_server_context"
  | "unknown_agent"
  | "machine_or_server_mismatch";

type MachineAgentValidationResult =
  | { agent: CachedAgentState; dropReason: null }
  | { agent: null; dropReason: MachineAgentValidationDropReason };

type ActivityIngestionDropReason =
  | MachineAgentValidationDropReason
  | "legacy_lifecycle_event"
  | "stale_launch_guard"
  | "agent_stopped"
  | "reset_window"
  | "activity_plan_ignore"
  | "stale_client_seq"
  | "unknown_activity_detail_kind"
  | "non_fact_activity_detail_kind"
  | "kimi_activity_circuit_breaker";

const DAEMON_INGRESS_RATE_LIMITED_MESSAGE_TYPES = new Set<MachineToServerMessage["type"]>([
  "agent:status",
  "agent:activity",
  "agent:session",
  "agent:session:invalidate",
  "agent:runtime_profile",
  "agent:runtime_profile:migration:ack",
  "agent:runtime_profile:migration_done",
  "agent:runtime_profile:daemon_release_notice:ack",
  // RFC 071: a best-effort notice, not an outbox entry. The outbox entries
  // (RUNTIME_OUTCOME_OUTBOX_MESSAGE_TYPES) are deliberately NOT listed: a drop
  // would stall that agent's queue (no ack) or lose evidence (ack), and the
  // daemon's stop-and-wait already bounds their rate.
  "agent:runtime:outcome_unreliable",
  // Agent typing line: best-effort UI hint; a drop only shortens the line.
  "agent:send_intent",
  // A daemon asks at most once per (re)connect and per change burst; a drop
  // only leaves its agents on the values they have until the next change.
  "server:features:request",
  // #68: sent on connect and on change only; each may store and notify, so
  // a flood is dropped (DAEMON_INGRESS_TYPE_MAX_EVENTS). A dropped report is
  // superseded by the next one (its full snapshot, a higher seq).
  "machine:runtime_readiness",
]);

/** Per-type budgets below the default, for message types that are rare by design. */
const DAEMON_INGRESS_TYPE_MAX_EVENTS: Partial<Record<MachineToServerMessage["type"], number>> = {
  "machine:runtime_readiness": 20,
};

type DaemonIngressRateLimitWindow = {
  startedAt: number;
  count: number;
  droppedCount: number;
};

type DaemonIngressRateLimitScope = "message_type" | "machine_total";

type DaemonIngressRateLimitTraceAttrs = {
  scope: DaemonIngressRateLimitScope;
  limit: number;
  messageType?: MachineToServerMessage["type"];
};

type DaemonIngressRateLimitDecision =
  | { action: "allow"; aggregateDrops?: Array<DaemonIngressRateLimitTraceAttrs & { aggregateDroppedCount: number }> }
  | { action: "drop"; droppedCount: number; retryAfterMs: number; trace: boolean; attrs: DaemonIngressRateLimitTraceAttrs };

type DaemonIngressRateLimitBucketDecision =
  | { action: "allow"; aggregateDrop?: DaemonIngressRateLimitTraceAttrs & { aggregateDroppedCount: number } }
  | { action: "drop"; droppedCount: number; retryAfterMs: number; trace: boolean; attrs: DaemonIngressRateLimitTraceAttrs };

type KimiActivityCircuitState = {
  emittedSignatures: Set<string>;
  lastEmittedAt: number;
  lastObservedAt: number;
  suppressedCount: number;
};

type KimiActivityCircuitDecision =
  | { action: "allow"; aggregateSuppressedCount?: number }
  | { action: "suppress"; suppressedCount: number };

function isStartIntentOwnerMoved(error: unknown): boolean {
  return error instanceof StartIntentOwnerMovedError
    || (error instanceof StartIntentRemoteError && error.failure.name === START_INTENT_OWNER_MOVED);
}

/**
 * Rethrow a routed-intent failure with the class callers already branch on, so
 * routes keep answering 409 machine_offline / 504 daemon_timeout instead of a
 * generic 500 when the owner is gone, slow or moved.
 */
/**
 * How runOnOwner placed an agent operation. `local_machine`, `self_owner`,
 * `no_machine` and `no_replica_state` run here by design; the fallbacks run
 * here only because the owner could not be used.
 */
type OwnerRouteDecision =
  | "routed"
  | "route_failed"
  | "local_machine"
  | "self_owner"
  | "no_machine"
  | "no_replica_state"
  | "no_owner"
  | "owner_without_intents"
  | "lookup_failed";

const OWNER_ROUTE_FALLBACKS: ReadonlySet<OwnerRouteDecision> = new Set(["no_owner", "owner_without_intents", "lookup_failed"]);

function rehydrateStartIntentError(error: unknown): unknown {
  if (error instanceof StartIntentTimeoutError) return new RouteFailureError("daemon_timeout", error.message);
  if (error instanceof StartIntentTransportError) return new RouteFailureError("daemon_offline", error.message);
  if (isStartIntentOwnerMoved(error)) return new RouteFailureError("daemon_offline", (error as Error).message);
  if (!(error instanceof StartIntentRemoteError)) return error;
  const { name, message, subkind } = error.failure;
  if (name === "RouteFailureError" && subkind) {
    try {
      return new RouteFailureError(subkind as ConstructorParameters<typeof RouteFailureError>[0], message);
    } catch {
      return error;
    }
  }
  if (name === "CrossReplicaQueueReceiptUnavailableError") return new CrossReplicaQueueReceiptUnavailableError();
  return error;
}

/**
 * #wg-rbac:#57: a daemon activity frame whose detail is a runtime error's text:
 * an error activity, or a runtime-error / crash detail kind.
 */
export function isDaemonRuntimeErrorActivityFrame(msg: Pick<Extract<MachineToServerMessage, { type: "agent:activity" }>, "activity" | "activityKind" | "detailKind">): boolean {
  return isRuntimeErrorDetailActivity({ activity: msg.activityKind ?? msg.activity, detailKind: msg.detailKind });
}

function daemonActivityJoinTraceAttrs(msg: Extract<MachineToServerMessage, { type: "agent:activity" }>): Record<string, unknown> {
  return {
    ...(typeof msg.launchId === "string" ? { launchId: msg.launchId, launch_id: msg.launchId } : {}),
    launch_id_present: typeof msg.launchId === "string",
    ...(typeof msg.daemonInstanceId === "string"
      ? { daemonInstanceId: msg.daemonInstanceId, daemon_instance_id: msg.daemonInstanceId }
      : {}),
    daemon_instance_id_present: typeof msg.daemonInstanceId === "string",
    activity_sequence_generation: typeof msg.daemonInstanceId === "string"
      ? "daemon_instance"
      : "legacy_server_epoch",
    ...(typeof msg.clientSeq === "number" ? { clientSeq: msg.clientSeq, client_seq: msg.clientSeq } : {}),
    client_seq_present: typeof msg.clientSeq === "number",
    ...(typeof msg.probeId === "string" ? { probe_id_present: true } : { probe_id_present: false }),
    ...(typeof msg.producerFactId === "string"
      ? {
          producerFactId: msg.producerFactId,
          producer_fact_id: msg.producerFactId,
        }
      : {}),
    // REDUNDANT, not independent: when this is true the raw `producer_fact_id`
    // is on this same span, just above. Kept under case 2 of the #422 item-3
    // rule (@Leiysky) — a flag is only a defect when it claims a value that is
    // not on the surface, which is the daemon's case, not this one.
    producer_fact_id_present: typeof msg.producerFactId === "string",
    ...(typeof msg.isHeartbeat === "boolean" ? { is_heartbeat: msg.isHeartbeat } : {}),
    correlation_id: typeof msg.producerFactId === "string"
      ? msg.producerFactId
      : `agent:${msg.agentId}:daemonActivity:${msg.launchId ?? "legacy"}:${msg.clientSeq ?? "unsequenced"}`,
  };
}

function daemonActivityDropRowAttrs(input: {
  atMs: number;
  observationClass: LifecycleObservationClass;
  probeIdPresent?: boolean;
}): Record<string, unknown> {
  if (input.probeIdPresent === true) {
    return {
      event_kind: "activity_snapshot",
      source: "activity_probe",
      authority: "activity_probe",
      observation_class: "liveness_observation",
      advances_observed_clock: "none",
      shadow_observation_class: "liveness_observation",
    };
  }
  if (input.observationClass === "replayed") {
    return {
      event_kind: "activity_replayed",
      source: "replay_tooling",
      authority: "replay_tooling",
      observation_class: "activity_replay",
      advances_observed_clock: "none",
      shadow_observation_class: "activity_replay",
    };
  }
  if (input.observationClass === "observed") {
    return {
      event_kind: "activity_observed",
      source: "daemon_runtime",
      authority: "daemon_runtime",
      observation_class: "activity_assertion",
      activity_observed_at_ms: input.atMs,
      advances_observed_clock: "activity",
      shadow_observation_class: "activity_assertion",
    };
  }
  if (input.observationClass === "observed_turn_active") {
    return {
      event_kind: "turn_active",
      source: "daemon_runtime",
      authority: "observed_turn_active",
      observation_class: "observed_turn_active",
      activity_observed_at_ms: input.atMs,
      advances_observed_clock: "activity",
      shadow_observation_class: "observed_turn_active",
    };
  }
  return {
    event_kind: "synthetic_repair",
    source: "scheduler_repair",
    authority: "scheduler_repair",
    observation_class: "synthetic_diagnostic",
    advances_observed_clock: "none",
    shadow_observation_class: "synthetic_diagnostic",
  };
}

export function planLifecycleEventAcceptance(
  input: LifecycleEventAcceptanceInput,
): LifecycleEventAcceptanceAction {
  if (input.launchGuardMode !== "guarded" || !input.expectedLaunchId) {
    return "accept";
  }

  if (!input.launchId) {
    return "ignore-legacy-for-guarded";
  }

  if (input.launchId !== input.expectedLaunchId) {
    return "ignore-stale-launch";
  }

  return "accept";
}

export function supportsLaunchGuardForDaemonVersion(version: string | null): boolean {
  if (!version) return false;
  // Strip pre-release suffixes (e.g. "0.30.1-alpha.1" -> "0.30.1")
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const [, major, minor, patch] = match.map(Number);
  // launchId was introduced in 0.30.1 (PR #518)
  if (major > 0) return true;
  if (minor > 30) return true;
  if (minor === 30 && patch >= 1) return true;
  return false;
}

function narrowPersistedAgentStatus(status: string): AgentStatus | null {
  return status === "active" || status === "inactive" || status === "stopped"
    ? status
    : null;
}

export function narrowReadyReconcileStatus(status: string): AgentStatus | null {
  return narrowPersistedAgentStatus(status);
}

type ReadyReconcileAgent = Awaited<ReturnType<AgentOrchestrator["loadAgentsForReadyReconcile"]>>[number];
type ActivityProducer = "lifecycle" | "slock_cli" | "runtime_tool" | "control" | "message_io";

interface ActivityProducerEvent {
  producer: ActivityProducer;
  summary: string;
  outcome?: "started" | "succeeded" | "failed";
  command?: string;
  target?: string;
  correlationId?: string;
}

interface MappedExternalPluginActivity {
  activity: AgentActivity;
  detail: string;
  entries: TrajectoryEntry[];
  occurredAtMs?: number;
  dedupeKey?: string;
}

/** Hook names `mapExternalPluginActivityEvent` maps; anything else is traced as `other`. */
const EXTERNAL_ACTIVITY_HOOK_EVENT_NAMES: ReadonlySet<string> = new Set([
  "BridgeFatal", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch",
  "UserPromptSubmit", "Stop", "SessionStart", "SessionEnd", "SubagentStart", "SubagentStop",
]);

/** The distinct values in a batch, sorted and comma-joined; null when none. */
function externalActivityClosedValues(values: Array<string | null>): string | null {
  const distinct = [...new Set(values.filter((value): value is string => value !== null))].sort();
  return distinct.length > 0 ? distinct.join(",") : null;
}

/**
 * A turn the provider ended on purpose: a BridgeFatal whose errorClass starts
 * with `stopped:` (the owner's stop, or the agent's delete). The status line it
 * shows, never an error (Tenny); null for any other event.
 */
export function externalStoppedTurnDetail(event: ExternalAgentActivityEvent): string | null {
  const hookEventName = externalActivityString(event.hookEventName ?? event.hook_event_name, 80);
  if (hookEventName !== "BridgeFatal") return null;
  const errorClass = externalActivityString(event.errorClass ?? event.error_class, 120);
  if (!errorClass?.startsWith("stopped:")) return null;
  const reason = errorClass.slice("stopped:".length).trim();
  if (reason === "by owner") return "Stopped by owner";
  if (reason === "agent deleted") return "Stopped: agent deleted";
  return "Stopped";
}

/** Rows the server refolds per external batch when it has no turn yet to start from (task #17). */
const EXTERNAL_TURN_SUMMARY_WINDOW_ROWS = 400;
/** Most rows refolded after the last settled turn (one long turn fits). */
const EXTERNAL_TURN_SUMMARY_REFOLD_ROWS = 2000;
/** A reported "online" followed by "working" within this is one turn (status streams flap). */
const EXTERNAL_SOFT_END_GRACE_MS = 15_000;
/** Most activity rows read for the running turn on an overview load (one long turn fits). */
const RUNNING_TURN_ROWS = 2000;

const EXTERNAL_STATUS_REPORT_PROVENANCE = "external/status-reported:";

/** A status the agent reported itself (raft-agent-status.v1), as stored. */
function externalReportedStatus(entry: TrajectoryEntry): Extract<TrajectoryEntry, { kind: "status" }> | null {
  return entry.kind === "status" && typeof entry.producerFactId === "string" && entry.producerFactId.startsWith(EXTERNAL_STATUS_REPORT_PROVENANCE)
    ? entry
    : null;
}

/** The hook turn boundary a stored row marks, whether stored as the status (no status protocol) or kept beside it. */
function externalHookBoundary(entry: TrajectoryEntry): ExternalHookTurnBoundary | null {
  if (entry.kind !== "status" || !isExternalHookEntry(entry)) return null;
  if (entry.hookBoundary) return entry.hookBoundary;
  return (entry.detailKind && EXTERNAL_HOOK_BOUNDARY_BY_DETAIL_KIND[entry.detailKind]) ?? null;
}

function externalHookTurnOutcome(entry: TrajectoryEntry): ActivityTurnOutcome | null {
  const boundary = externalHookBoundary(entry);
  if (boundary === "turn_end") return "completed";
  if (boundary === "session_end") return "interrupted";
  if (entry.kind === "system" && entry.title === "Turn stopped") return "interrupted";
  if (entry.kind === "system" && entry.title === "Bridge fatal") return "failed";
  return null;
}

function externalReportedTurnOutcome(entry: TrajectoryEntry): ActivityTurnOutcome | null {
  const reported = externalReportedStatus(entry);
  if (reported?.activity === "online") return "completed";
  if (reported?.activity === "error") return "failed";
  if (reported?.activity === "offline") return "interrupted";
  return null;
}

/**
 * How an external agent's stored rows split into turns (Tenny): by its hooks
 * when it sends any (UserPromptSubmit opens, Stop / SessionEnd / BridgeFatal
 * close: cody), otherwise by the status it reports itself (busy after idle
 * opens; idle, error or offline closes, and a brief "online" between two busy
 * reports does not split a turn).
 */
function externalTurnBoundaries(rows: readonly { entry: TrajectoryEntry }[], knownHookReporter: boolean) {
  const byHooks = knownHookReporter || rows.some((row) => externalHookBoundary(row.entry) !== null);
  if (byHooks) {
    return {
      turnStart: (entry: TrajectoryEntry) => (externalHookBoundary(entry) === "turn_start" ? {} : null),
      turnEnd: externalHookTurnOutcome,
    };
  }
  return {
    turnStart: (entry: TrajectoryEntry) => {
      const reported = externalReportedStatus(entry);
      return reported && (reported.activity === "working" || reported.activity === "thinking") ? {} : null;
    },
    turnEnd: (entry: TrajectoryEntry) => externalReportedTurnOutcome(entry) ?? externalHookTurnOutcome(entry),
    softEnd: (entry: TrajectoryEntry) => externalReportedStatus(entry) !== null,
    softEndGraceMs: EXTERNAL_SOFT_END_GRACE_MS,
  };
}

const EXTERNAL_HOOK_BOUNDARY_BY_DETAIL_KIND: Partial<Record<string, ExternalHookTurnBoundary>> = {
  message_received: "turn_start",
  ready: "turn_end",
  stopped: "session_end",
};

/**
 * What a hook stores when the agent's own reported status replaces the
 * hook-derived one. Status rows go, except (task #17):
 * - the Tool finished outcome row, which marks a step, not the agent's state
 *   (the restart hint skips tool_end);
 * - turn boundaries (UserPromptSubmit / Stop / SessionEnd), kept so the turn
 *   summary can use them, with `detailKind` "external_activity": the same
 *   kind a reported status row has, so the restart hint read from this row
 *   says nothing the reported status did not.
 */
function externalLogOnlyEntries(entries: readonly TrajectoryEntry[]): TrajectoryEntry[] {
  return entries.flatMap((entry): TrajectoryEntry[] => {
    if (entry.kind !== "status" || entry.detailKind === "tool_end") return [entry];
    const hookBoundary = entry.detailKind ? EXTERNAL_HOOK_BOUNDARY_BY_DETAIL_KIND[entry.detailKind] : undefined;
    if (hookBoundary && isExternalHookEntry(entry)) return [{ ...entry, detailKind: "external_activity", hookBoundary }];
    return [];
  });
}

function isExternalHookEntry(entry: TrajectoryEntry): boolean {
  return typeof entry.producerFactId === "string" && entry.producerFactId.startsWith(`${EXTERNAL_AGENT_ACTIVITY_PROVENANCE}:`);
}

export function mapExternalPluginActivityEvent(event: ExternalAgentActivityEvent): MappedExternalPluginActivity | null {
  const hookEventName = externalActivityString(event.hookEventName ?? event.hook_event_name, 80);
  const eventId = externalActivityString(event.eventId ?? event.event_id, 160);
  if (!hookEventName || !eventId) return null;

  const producerFactId = buildExternalPluginProducerFactId(eventId);
  const toolName = externalActivityString(event.toolName ?? event.tool_name, EXTERNAL_AGENT_ACTIVITY_TOOL_NAME_LIMIT) ?? "tool";
  const detail = getToolActivityLabel(toolName);
  const occurredAtMs = externalActivityTimeMs(event.occurredAt ?? event.occurred_at);
  const dedupeKey = externalAgentActivityDedupeKey(eventId);
  const callId = externalActivityString(event.toolUseId ?? event.tool_use_id, 160);

  const stoppedDetail = externalStoppedTurnDetail(event);
  if (stoppedDetail) {
    return {
      activity: "online",
      detail: stoppedDetail,
      entries: [{
        kind: "status",
        activity: "online",
        activityKind: "online",
        detail: stoppedDetail,
        detailKind: "external_activity",
        producerFactId,
      }, {
        kind: "system",
        title: "Turn stopped",
        text: stoppedDetail,
        producerFactId,
      }],
      occurredAtMs,
      dedupeKey,
    };
  }

  if (hookEventName === "BridgeFatal") {
    const errorClass = externalActivityString(event.errorClass ?? event.error_class, 120) ?? "BridgeFatal";
    const output = truncateExternalActivityText(
      event.toolOutput ?? event.tool_output ?? "",
      event.toolOutputTruncated ?? event.tool_output_truncated ?? event.truncated,
    );
    const detail = `Bridge fatal: ${errorClass}`;
    return {
      activity: "error",
      detail,
      entries: [{
        kind: "status",
        activity: "error",
        activityKind: "error",
        detail,
        detailKind: "external_activity",
        producerFactId,
      }, {
        kind: "system",
        title: "Bridge fatal",
        text: [errorClass, output.text].filter(Boolean).join("\n"),
        producerFactId,
      }],
      occurredAtMs,
      dedupeKey,
    };
  }

  if (hookEventName === "PreToolUse") {
    const input = truncateExternalActivityText(
      event.toolInput ?? event.tool_input ?? "",
      event.toolInputTruncated ?? event.tool_input_truncated ?? event.truncated,
    );
    return {
      activity: "working",
      detail,
      entries: [{
        kind: "tool_start",
        toolName,
        toolInput: input.text,
        ...(callId ? { callId } : {}),
        producerFactId,
      }],
      occurredAtMs,
      dedupeKey,
    };
  }

  if (hookEventName === "PostToolUse" || hookEventName === "PostToolUseFailure") {
    const output = truncateExternalActivityText(
      event.toolOutput ?? event.tool_output ?? "",
      event.toolOutputTruncated ?? event.tool_output_truncated ?? event.truncated,
    );
    const errorClass = externalActivityString(event.errorClass ?? event.error_class, 120);
    const title = hookEventName === "PostToolUseFailure" ? `Tool failed: ${toolName}` : `Tool output: ${toolName}`;
    const text = [errorClass, output.text].filter(Boolean).join("\n");
    const rawDuration = event.durationMs ?? event.duration_ms;
    const durationMs = typeof rawDuration === "number" && Number.isFinite(rawDuration) && rawDuration >= 0 ? Math.round(rawDuration) : undefined;
    const rawExitCode = event.exitCode ?? event.exit_code;
    const exitCode = typeof rawExitCode === "number" && Number.isSafeInteger(rawExitCode) ? rawExitCode : undefined;
    // An explicit boolean `ok` wins (a hosted bridge may know a non-zero exit
    // still ran); `ok: null` says the outcome is unknown (cancelled, result
    // lost) and records no `ok`; without `ok` the hook name decides.
    const ok = typeof event.ok === "boolean" ? event.ok : event.ok === null ? undefined : hookEventName !== "PostToolUseFailure";
    return {
      activity: "working",
      detail,
      entries: [{
        kind: "system",
        title,
        text,
        producerFactId,
      }, {
        // The same "Tool finished" outcome row managed agents record, so the
        // activity view reads one shape whatever produced the tool call.
        kind: "status",
        activity: "working",
        detail: "Tool finished",
        detailKind: "tool_end",
        tool: {
          ...(callId ? { callId } : {}),
          ...(ok !== undefined ? { ok } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(exitCode !== undefined ? { exitCode } : {}),
        },
        producerFactId,
      }],
      occurredAtMs,
      dedupeKey,
    };
  }

  if (hookEventName === "PostToolBatch") {
    return {
      activity: "working",
      detail: "Tool batch complete",
      entries: [{
        kind: "status",
        activity: "working",
        activityKind: "working",
        detail: "Tool batch complete",
        detailKind: "external_activity",
        producerFactId,
      }],
      occurredAtMs,
      dedupeKey,
    };
  }

  if (hookEventName === "UserPromptSubmit") {
    return {
      activity: "working",
      detail: "Message received",
      entries: [{
        kind: "status",
        activity: "working",
        activityKind: "working",
        detail: "Message received",
        detailKind: "message_received",
        producerFactId,
      }],
      occurredAtMs,
      dedupeKey,
    };
  }

  if (hookEventName === "Stop" || hookEventName === "SessionStart" || hookEventName === "SessionEnd") {
    const activity: AgentActivity = hookEventName === "SessionEnd" ? "offline" : "online";
    const detailText = hookEventName === "SessionEnd" ? "Session ended" : "";
    return {
      activity,
      detail: detailText,
      entries: [{
        kind: "status",
        activity,
        activityKind: activity,
        detail: detailText,
        detailKind: hookEventName === "SessionEnd" ? "stopped" : "ready",
        producerFactId,
      }],
      occurredAtMs,
      dedupeKey,
    };
  }

  return null;
}

/** A subagent's event, recorded under the subagent without touching the agent's status or turn. */
export interface MappedExternalSubagentActivity {
  entries: TrajectoryEntry[];
  occurredAtMs?: number;
  dedupeKey: string;
}

/**
 * An event carrying the `subagent` marker belongs to a subagent of this agent
 * (hosted agents' `send_to_agent`): SubagentStart, the child's Pre/PostToolUse,
 * SubagentStop. Its rows go to the log with the marker; it never reports the
 * agent's own status, and a child's turn boundary is not the agent's, so
 * status rows other than the tool outcome are dropped. Null when unusable.
 */
export function mapExternalSubagentActivityEvent(
  event: ExternalAgentActivityEvent,
  subagent: NonNullable<SubagentLineage["subagent"]>,
): MappedExternalSubagentActivity | null {
  const hookEventName = externalActivityString(event.hookEventName ?? event.hook_event_name, 80);
  const eventId = externalActivityString(event.eventId ?? event.event_id, 160);
  if (!hookEventName || !eventId) return null;
  const occurredAtMs = externalActivityTimeMs(event.occurredAt ?? event.occurred_at);
  const dedupeKey = externalAgentActivityDedupeKey(eventId);
  if (hookEventName === "SubagentStart" || hookEventName === "SubagentStop") {
    return {
      entries: [{
        kind: "system",
        title: hookEventName === "SubagentStart" ? "Subagent started" : "Subagent finished",
        // Bounded label / enum only, never the task or the report.
        text: (hookEventName === "SubagentStart" ? subagent.subagentType : subagent.outcome) ?? "",
        producerFactId: buildExternalPluginProducerFactId(eventId),
        subagent,
      }],
      ...(occurredAtMs !== undefined ? { occurredAtMs } : {}),
      dedupeKey,
    };
  }
  const mapped = mapExternalPluginActivityEvent(event);
  if (!mapped) return null;
  const entries = scopeEntriesToSubagent(mapped.entries, subagent);
  if (entries.length === 0) return null;
  return { entries, ...(occurredAtMs !== undefined ? { occurredAtMs } : {}), dedupeKey };
}

function scopeEntriesToSubagent(
  entries: readonly TrajectoryEntry[],
  subagent: NonNullable<SubagentLineage["subagent"]>,
): TrajectoryEntry[] {
  return entries.flatMap((entry): TrajectoryEntry[] => {
    switch (entry.kind) {
      case "status":
        // The tool outcome marks a step; any other status row would be the child's state.
        return entry.detailKind === "tool_end" ? [{ ...entry, subagent }] : [];
      case "tool_start":
      case "system":
      case "text":
      case "thinking":
        return [{ ...entry, subagent }];
      default:
        return [];
    }
  });
}

function truncateExternalActivityText(value: unknown, alreadyTruncated?: unknown): { text: string; truncated: boolean } {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  const marker = "\n[truncated]";
  const shouldMark = Boolean(alreadyTruncated);
  if (text.length > EXTERNAL_AGENT_ACTIVITY_TEXT_LIMIT) {
    return {
      text: `${text.slice(0, Math.max(0, EXTERNAL_AGENT_ACTIVITY_TEXT_LIMIT - marker.length))}${marker}`,
      truncated: true,
    };
  }
  if (shouldMark && !text.includes("[truncated]")) {
    const marked = `${text}${marker}`;
    return {
      text: marked.length > EXTERNAL_AGENT_ACTIVITY_TEXT_LIMIT
        ? `${marked.slice(0, Math.max(0, EXTERNAL_AGENT_ACTIVITY_TEXT_LIMIT - marker.length))}${marker}`
        : marked,
      truncated: true,
    };
  }
  return { text, truncated: shouldMark };
}

function externalActivityString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

function externalActivityTimeMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function normalizeExternalActivityDroppedCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function externalAgentActivityDedupeKey(eventId: string): string {
  return `external-agent-activity:${eventId}`;
}

type PlannedExternalActivityEvent =
  | { kind: "hook"; mapped: MappedExternalPluginActivity }
  | { kind: "subagent"; mapped: MappedExternalSubagentActivity }
  | {
    kind: "status";
    eventId: string;
    status: RaftAgentStatus;
    detail: string;
    occurredAtMs: number;
    mapped: MappedExternalPluginActivity | null;
  };

function buildExternalStatusProducerFactId(eventId: string): string {
  const safe = eventId.replace(/[^A-Za-z0-9_:/-]/g, "_").slice(0, 160) || "unknown";
  return `external/status-reported:${safe}`;
}

function buildExternalPluginProducerFactId(eventId: string): string {
  const safe = eventId.replace(/[^A-Za-z0-9_:/-]/g, "_").slice(0, 160) || "unknown";
  return `${EXTERNAL_AGENT_ACTIVITY_PROVENANCE}:${safe}`;
}

type ResetApplyContext = {
  agentId: string;
  serverId: string | null;
  assistantOwnerUserId: string | null;
  mode: "restart" | "session" | "full";
  previousStatus: AgentStatus | null;
  machineId: string | null;
  /** RFC 071 §5: this reset is an E3 (a human reset, or a real runtime-config change). */
  terminalControl?: "human_reset" | "runtime_config_changed";
};

export interface AgentLifecycleEvent {
  at: number;
  agentId: string;
  machineId: string | null;
  action: AgentLifecycleAction;
  outcome: AgentLifecycleOutcome;
  cause: AgentLifecycleCause;
  previousStatus?: AgentStatus | null;
  nextStatus?: AgentStatus | null;
  detail?: string;
}

type AgentLifecycleRingBuffer = {
  events: AgentLifecycleEvent[];
  nextIndex: number;
  size: number;
};

/**
 * Classification of one best-effort built-in App transport send. The variant
 * fields double as the transport span's attributes: a result spreads directly
 * onto the span. `send_skipped` marks a send that was never attempted because
 * the snapshot composition itself failed.
 *
 * `send_failed.reason` value domain (verified against ws@8.20 + replicaRouter):
 * - `machine_unreachable` — sendToMachine returned false (no ready connection
 *   / reroute unavailable), or ws.send() sync-threw its not-open Error (the
 *   socket is mid-handshake; ws only sync-throws while CONNECTING, CLOSING /
 *   CLOSED go through an async error event instead). Both mean "connection
 *   unready", not a code fault.
 * - `send_threw` — any other exception. `error_class` then carries the
 *   bounded identity via `errorClassOf` (exception name; `""` names and
 *   non-Error throws route to sentinels — "unknown" / typeof strings). Named
 *   replica-router error classes never reach here: the reroute branch
 *   swallows its own errors in applySendToMachineAction.
 */
type AppTransportSendResult =
  | { outcome: "sent" }
  | { outcome: "send_skipped"; reason: "snapshot_failed" }
  | { outcome: "send_failed"; reason: "machine_unreachable" | "send_threw"; error_class?: string };

/**
 * A persisted chat message: it has a durable row (a positive seq) and can be
 * re-read from the agent's inbox. Third-party app events and other notices
 * without a durable row are not.
 */
export function isDurableAgentInboxMessage(message: AgentMessage): boolean {
  return Number.isInteger(message.seq) && (message.seq ?? 0) > 0 && !message.third_party_event;
}

/**
 * AgentOrchestrator routes agent commands to the appropriate machine via WebSocket.
 */
/** SLO v1 SLI 4 labels shared by the tracked, ack-latency and outcome metrics. */
function agentDeliverySloLabels(pending: PendingAgentDeliveryAck): {
  online_at_first_attempt: string;
  delivery_kind: "mention" | "plain";
  daemon_version: string;
} {
  return {
    online_at_first_attempt: String(pending.onlineAtFirstAttempt),
    delivery_kind: pending.msg.mentionDelivery ? "mention" : "plain",
    daemon_version: pending.daemonVersion,
  };
}

/** Rejection message of `deleteMachineWorkspaceDir` when the Computer has not answered yet. */
const WORKSPACE_DELETE_TIMED_OUT = "Delete timed out";

export class AgentOrchestrator extends EventEmitter {
  private io: SocketServer | null = null;
  /** #wg-rbac:#57: who may read an agent's runtime error text, per agent, briefly cached. */
  static readonly RUNTIME_ERROR_VIEWER_CACHE_TTL_MS = 30_000;
  private static readonly RUNTIME_ERROR_VIEWER_CACHE_MAX = 10_000;
  private readonly runtimeErrorViewerCache = new Map<string, { userIds: string[]; readAtMs: number }>();
  /** The coarse agent state for capable clients (agentActivityStateFanout.ts). */
  protected readonly agentActivityStateFanout = new AgentActivityStateFanout(
    (room, payload) => {
      this.io?.to(room).emit(AGENT_ACTIVITY_STATE_EVENT, payload);
    },
    {
      now: () => this.clock.now(),
      setTimeout: (fn, ms) => this.clock.setTimeout(fn, ms),
      clearTimeout: (timer) => this.clock.clearTimeout(timer),
    },
  );
  /** Agent typing line: live `agent:send_intent` calls on this replica (agentTypingService). */
  protected readonly agentTyping = new AgentTypingRegistry({
    now: () => this.clock.now(),
    emit: (room, event, payload) => this.emitAgentTyping(room, event, payload),
    previewTarget: (serverId, agentId, target) => this.previewAgentTypingTarget(serverId, agentId, target),
  });
  private machineConnections = new Map<string, MachineConnection>();
  /** Computer connections held by this process; read by the per-task load sample. */
  get machineConnectionCount(): number {
    return this.machineConnections.size;
  }
  private machineCatalogAuthority = new MachineCatalogAuthority((machineId) => {
    const conn = this.machineConnections.get(machineId);
    return conn?.replicaGeneration
      ? {
          connectionEpochId: conn.connectionEpochId,
          replicaGeneration: conn.replicaGeneration,
        }
      : null;
  });
  // Latest capabilities write we still owe the DB, per machine. Present only
  // while a persist is in flight or awaiting a backoff retry; deleted once it
  // lands (or the connection is cleared). See enqueueCapabilitiesPersist.
  private capabilitiesWrites = new Map<string, CapabilitiesWriteState>();
  // Monotonic per-machine generation counter. NEVER reset when a write entry is
  // cleared, so a generation value is never reused for the same machine — this
  // is what makes an ABA match (an old in-flight generation coinciding with a
  // freshly-created entry) impossible. Swept only on shutdown.
  private capabilitiesGenerationSeq = new Map<string, number>();
  private legacyPrincipalFences = new Set<string>();
  /** Set once this task starts draining (task #268). The drain going-away
   * closes a snapshot of the connections it finds; a daemon that reconnects
   * to this same task during the seconds before the ALB deregisters it would
   * not be in that snapshot and would be hard-cut with 1006 at the
   * deregistration-delay expiry, which is the failure the drain exists to
   * remove. So a draining task refuses new machine connections with the same
   * 1001 `server_draining`, and the daemon's normal reconnect lands elsewhere. */
  private drainingMachineConnections = false;
  private drainRefusedMachineConnections = 0;
  private machineStatusVersions = new Map<string, number>();
  private pendingMachineDisconnects = new Map<string, PendingMachineDisconnectProjection>();
  private pendingAgentSkillsListRequests = new Map<string, PendingAgentSkillsListRequest>();
  private pendingAgentDeliveryAcks = new Map<string, PendingAgentDeliveryAck>();
  // Insertion order is give-up order, so the oldest tombstones come first.
  private gaveUpAgentDeliveries = new Map<string, GaveUpAgentDelivery>();
  private pendingAgentStartAcks = new Map<string, PendingAgentStartAck>();
  /**
   * When this replica last saw each machine's socket close, until the next
   * connection of that machine registers here and takes it (previousCloseAt).
   * In memory: another replica's closes are not here.
   */
  private machineLastDisconnectAt = new Map<string, number>();
  /** App-event reconnect passes in flight, by machine (`ready` does not await them; shutdown does). */
  private readonly thirdPartyEventReconnectPasses = new Map<string, Promise<void>>();
  /** F9: the owed-wake pass in flight per machine, and the `ready` that came during it (run once more after it). */
  private readonly readyOwedWakePasses = new Map<string, { done: Promise<void>; rerun: ReadyOwedWakeRun | null }>();
  /** F9: when this server process may take its next owed-wake check (READY_OWED_WAKE_GLOBAL_INTERVAL_MS apart). */
  private readyOwedWakeNextSlotAtMs = 0;
  private readyOwedWakeStopped = false;
  private readonly readyOwedWakeRandom: () => number;
  // replica-local: agents a start is being prepared for on this replica, until
  // its dispatch is recorded in pendingAgentStartAcks (see startAgentHere).
  private readonly startsInProgress = new Set<string>();
  private terminalAgentStartDispatches = new Map<string, AgentStartDispatchTerminalReason>();
  private readonly localInboxes = new LocalAgentInboxes();
  private agentActivity = new Map<string, ActivitySnapshot>();
  /**
   * The stale phase each agent's busy-preserve diagnostics were last recorded
   * for, keyed on the snapshot's observed time (task #proj-o11y:#25, Tenny
   * 9652d110). The stale sweep keeps a busy snapshot without writing it, so the
   * same agent stays stale and used to emit `busy_preserved` and a
   * `preserve_rebroadcast` shadow verdict every 30 s on every replica: about a
   * million lines an hour, growing with uptime, with nothing changing. Now one
   * pair per stale phase; a new observation starts a new phase.
   */
  private readonly busyPreservedPhase = new Map<string, string>();
  /**
   * Preserve legs skipped as repeats of an already recorded phase since the
   * previous sweep span closed (`preserved_repeat_count`). Probe-timeout
   * fallbacks fire after their sweep span ends, so their repeats land in the
   * next span: right in total, one cycle late per span.
   */
  private busyPreservedRepeats = 0;
  /**
   * task #1116: carrier captured from an accepted `agent:activity` frame with
   * detailKind "delivery_unconsumed", consumed by the very next snapshot write
   * for that agent (attached when that write is delivery_unconsumed, dropped
   * otherwise). Never read for any decision.
   */
  private pendingDeliveryConsumption = new Map<string, DeliveryConsumptionActivityDiagnostic>();
  /**
   * task #1119: automatic-wake crash-loop breaker. Consulted before every
   * non-human start; fed by dispatched starts and by early exits (daemon
   * process exit / runner disconnect). Process-local like the wake lock's
   * intent: a replica failover starts a fresh episode.
   */
  /**
   * task #1119: episode state lives in the replica state store (CAS), so a block
   * survives a replica switch and only a human start/resume clears it.
   */
  private readonly wakeCrashLoopBreaker: WakeCrashLoopBreaker;
  /**
   * The unread summary each agent's current launch was started with, until that
   * launch's first turn ends (`agent:turn:ended`): a completed turn settles the
   * conversations it owes nothing in (unowedReadBacklog.ts).
   */
  private readonly turnEndUnreadSnapshots = new TurnEndUnreadSnapshots(() => this.clock.now());
  /** task #1228 ①: timed-out feedback transcript requests whose late result is still recorded. */
  private readonly feedbackTranscriptLateResults = new FeedbackTranscriptLateResults(() => this.clock.now());
  /** RFC 071 part 3: commits outbox frames (state + watermark in one write) before they are acked. */
  private readonly terminalFailureBreaker: TerminalFailureBreaker;
  /** RFC 071 §9: the last block shown per agent, so a block is projected once. */
  private readonly projectedTerminalBlocks = new Map<string, string>();
  /** RFC 071 part 3: handle outbox frames only when the server advertises the ack capability (dormant). */
  private readonly runtimeOutcomeAckEnabled: boolean = RUNTIME_OUTCOME_ACK_ENABLED;
  /** task #1119: carrier captured at block time, attached by the next snapshot write of that kind. */
  private pendingWakeCrashLoop = new Map<string, WakeCrashLoopActivityDiagnostic>();
  /**
   * task #1123: typed spawn-failure carrier captured at ingest, attached on the
   * runtime_unavailable snapshot write. `null` records that the frame CARRIED NO
   * carrier (e.g. a probe response "Agent not running" from the same daemon),
   * which must clear the previous one rather than inherit it: a new fact
   * without a carrier is not the same observation (XX, #7793 review).
   */
  private pendingSpawnFailure = new Map<string, SpawnFailureActivityDiagnostic | null>();
  /**
   * task #25: the stuck-tool state of the daemon frame being applied, set just
   * before the frame's lifecycle plan runs and removed after it. Only that
   * frame's snapshot write takes it; every other write (a server-authored
   * state, a sweep) clears the snapshot's state.
   */
  private pendingToolStuck = new Map<string, ToolStuckActivityDiagnostic>();
  /**
   * Reconciler step 4b: the credential-hold carrier of the daemon frame being
   * ingested (null: the frame had none), taken by its snapshot write only, so
   * a fresh idle frame always decides and the latest frame is the state.
   */
  private pendingCredentialHold = new Map<string, CredentialHoldActivityDiagnostic | null>();
  private activityDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private agentStateCache = new Map<string, CachedAgentState>();
  private resetInProgress = new Map<string, "restart" | "session" | "full">();
  private lastReadyOnlineBroadcastAt = new Map<string, number>();
  private lifecycleEventsByAgent = new Map<string, AgentLifecycleRingBuffer>();
  private staleActivityTimer: unknown | null = null;
  /** task #365: per-replica retry sweep for wakes refused by the spawn-error backoff (only while RFC 071 is enabled). */
  private spawnErrorRetryTimer: unknown | null = null;
  private spawnErrorRetrySweepRunning = false;
  static readonly SPAWN_ERROR_RETRY_SWEEP_MS = 60_000;
  /**
   * In-flight activity probes keyed by probeId. Each entry holds the
   * fallback timer that fires synth-online if the daemon never replies
   * (legacy sweep behaviour) and the snapshot time used to detect
   * "fresh organic activity arrived" without the probe needing to
   * complete. Cleared by handleActivityProbeResponse on probe-response
   * or by the timer's own callback on timeout.
   */
  private pendingActivityProbes = new Map<
    string,
    { agentId: string; startedAt: number; fallbackTimer: ReturnType<typeof setTimeout> }
  >();

  /**
   * Ingest dedup state for `agent:activity` from daemons, keyed by
   * `${agentId}:daemon:${daemonInstanceId}:launch:${launchId|legacy}` for
   * current daemons, `${agentId}:launch:${launchId}` for older daemons with a
   * launch id, or
   * `${agentId}:legacy:${serverIngestEpoch}` for legacy/no-launch frames.
   * Stores the highest `clientSeq` seen for that key. New launchId resets
   * naturally; server-controlled starts/resets/internal stop boundaries also
   * advance the legacy ingest epoch so no-launch daemons can re-baseline their
   * clientSeq clock without preserving stale watermarks from the previous
   * runtime generation. Launch-present frames intentionally do not use the
   * legacy epoch; same-launch replay protection must survive lifecycle churn.
   * (#engineering:72283cf7 task #340 PR B, #proj-o11y task #180)
   */
  private lastClientSeqByActivityIngestKey = new Map<string, number>();
  private activityIngestEpochByAgent = new Map<string, number>();
  /**
   * External agents known to have adopted raft-agent-status.v1
   * (`agents.status_protocol_adopted_at`). The flag only ever goes NULL -> set,
   * so a positive read is cached for the process lifetime; a negative read is
   * never cached, so an adoption accepted on another replica takes effect on
   * this one at the next `/activity` batch.
   */
  private statusProtocolAdoptedAgents = new Set<string>();
  /** External agents seen sending hook turn boundaries (task #17 turn splitting). */
  private readonly externalHookTurnAgents = new Set<string>();
  private activityDaemonGenerationsByAgent = new Map<string, string[]>();
  private kimiActivityCircuitByLaunch = new Map<string, KimiActivityCircuitState>();
  private daemonIngressRateLimitWindows = new Map<string, DaemonIngressRateLimitWindow>();
  private daemonIngressTotalRateLimitWindows = new Map<string, DaemonIngressRateLimitWindow>();
  private lastIngressReplicaRefreshAt = new Map<string, number>();

  /**
   * Last `serverSeq` this replica emitted on an outbound `agent:activity`
   * socket push (one value for all agents). The client drops pushes whose seq
   * is not above the last one it saw for that agent. The seq is wall-clock
   * based (`nextActivityServerSeq`), so a push from another replica or after
   * a restart still compares newer; a per-replica counter starting at 1 made
   * the client drop every push after the daemon moved replicas.
   */
  private lastActivityServerSeq = 0;
  /** RFC 069 §8: last applied sequenced status per agent. */
  private sequencedStatusVersions = new Map<string, SequencedStatusVersion>();
  private runtimeProfileHeartbeatNudgeSentAt = new Map<string, number>();

  /** Max seconds a transient activity (working/thinking) can stay before auto-reset */
  private static ACTIVITY_STALE_SEC = 90;
  /**
   * Soft timeout for an `agent:activity_probe` round-trip. If the
   * daemon doesn't respond within this window, the sweep falls back
   * to the legacy synth-online behaviour. Tuned so a single missed
   * sweep cycle (30s) plus normal WS RTT plus daemon `respondToActivityProbe`
   * processing time fits comfortably; if the daemon is genuinely
   * stuck/unreachable, fallback fires as before.
   * Introduced 2026-05-02 #engineering:72283cf7 task #340.
   */
  private static ACTIVITY_PROBE_TIMEOUT_MS = 5_000;
  private static RUNTIME_PROFILE_MIGRATION_NUDGE_AFTER_MS = 5 * 60_000;
  private static RUNTIME_PROFILE_MIGRATION_NUDGE_INTERVAL_MS = 15 * 60_000;
  private static RUNTIME_PROFILE_MIGRATION_MAX_NUDGES = 3;
  private static RUNTIME_PROFILE_HEARTBEAT_NUDGE_COOLDOWN_MS = 24 * 60 * 60_000;
  private static MACHINE_HEARTBEAT_TIMEOUT_MS = 60_000;
  // Task #1295: ack-timeout re-sends back off (5, 10, 20, then every 40 s) and
  // give up by age, not by count. A fixed 5 s re-send fed a backlogged daemon
  // one more copy per delivery every 5 s (10-15: 53 give-ups were late acks).
  private static AGENT_DELIVERY_ACK_BACKOFF_MS = [5_000, 10_000, 20_000, 40_000] as const;
  private static AGENT_DELIVERY_GIVE_UP_AFTER_MS = 120_000;
  // A connection that acked any delivery this recently is alive but behind, so
  // a due re-send waits for the next backoff point instead; deferring stretches
  // the give-up to the second bound, never further.
  private static AGENT_DELIVERY_LIVE_ACK_WINDOW_MS = 5_000;
  private static AGENT_DELIVERY_DEFERRED_GIVE_UP_AFTER_MS = 5 * 60_000;
  // A parked delivery record (machine offline) checks the machine's status this
  // often, and ends as parked_expired after the max age (task #432).
  private static AGENT_DELIVERY_PARKED_PROBE_MS = 30_000;
  private static AGENT_DELIVERY_PARKED_MAX_MS = 30 * 60_000;
  /**
   * A delivery held for a Computer below the version floor waits for the
   * upgrade, not for a reconnect, so it outlives the offline park; bounded so
   * a machine that never comes back does not keep it in memory forever. The
   * message itself stays in the durable inbox either way.
   */
  private static AGENT_DELIVERY_VERSION_HELD_MAX_MS = 7 * 24 * 60 * 60_000;
  protected computerVersionFloor = sharedComputerVersionFloor;
  // A mention that reached the daemon (daemon_pending) stays an in-flight cycle
  // until its final ack or terminal error, at most this long (task #432).
  private static AGENT_DELIVERY_HELD_MAX_MS = 30 * 60_000;
  // A give-up keeps a tombstone this long, so an ack that arrives after it is
  // counted as acked_after_gave_up instead of vanishing (10-15: a daemon that
  // stalled ~2 min acked 53 deliveries 4-6s after the server gave up).
  private static AGENT_DELIVERY_GAVE_UP_TOMBSTONE_MS = 10 * 60_000;
  private static AGENT_DELIVERY_GAVE_UP_TOMBSTONE_MAX = 10_000;
  /**
   * Task #354: interval for WebSocket protocol ping frames on machine
   * connections. Some machines sit behind a middlebox (proxy/NAT/VPN) that
   * drops connections idle for ~12-20s, which is shorter than the 30s
   * application heartbeat, so every connection died before its first ping and
   * the daemon reconnected in a loop (close 1006 on daemons 1.0.16-1.0.25).
   * A ping frame is answered by the `ws` client with a pong automatically, so
   * this keeps the path non-idle for every daemon version without a daemon
   * release. Deliberately emits no span: it would be one row per machine every
   * few seconds. 0 disables it.
   */
  private static MACHINE_WS_PING_DEFAULT_INTERVAL_MS = 5_000;
  private static AGENT_START_ACK_TIMEOUT_MS = 5_000;
  private static AGENT_START_ACK_MAX_ATTEMPTS = 24;
  private static AGENT_START_TERMINAL_CACHE_SIZE = 1_024;
  /** Debounce window for activity broadcasts (ms) */
  private static ACTIVITY_DEBOUNCE_MS = 200;
  private static KIMI_ACTIVITY_CIRCUIT_WINDOW_MS = 30_000;
  private static KIMI_ACTIVITY_CIRCUIT_AGGREGATE_MS = 60_000;
  private static DAEMON_INGRESS_RATE_LIMIT_DEFAULT_WINDOW_MS = 10_000;
  private static DAEMON_INGRESS_RATE_LIMIT_DEFAULT_MAX_EVENTS = 2_000;
  private static DAEMON_INGRESS_RATE_LIMIT_DEFAULT_MAX_EVENTS_PER_MACHINE = 3_000;
  private static INGRESS_REPLICA_REFRESH_MIN_INTERVAL_MS = 15_000;
  /**
   * Task #374 duplicate-connection evidence: the other replica's lease must
   * have been renewed at least this many times, over at least this long,
   * while this socket kept being refused. A normal cross-replica reconnect
   * hand-off ends with this socket closing (no more pongs, no more refreshes)
   * well before both hold.
   */
  private static DUPLICATE_LEASE_MIN_FOREIGN_ADVANCES = 2;
  private static DUPLICATE_LEASE_MIN_DURATION_MS = 60_000;
  /**
   * Task #374 hold: after the older socket is closed, a new connection for the
   * machine is refused while the winner is alive, i.e. while the lease is still
   * the winner's and was renewed within DUPLICATE_HOLD_WINNER_ALIVE_MS (1.5
   * pong intervals). A winner that only lost its own socket stops renewing, so
   * its reconnect is accepted at most one window later. The record itself
   * lives DUPLICATE_HOLD_TTL_SECONDS and is extended by each refusal, so a
   * loser that keeps reconnecting stays out while the winner lives.
   */
  private static DUPLICATE_HOLD_WINNER_ALIVE_MS = 45_000;
  private static DUPLICATE_HOLD_TTL_SECONDS = 600;
  /** Half the 300 s lease TTL: the instance record never outlives a live holder's lease by much. */
  private static REPLICA_INSTANCE_PUBLISH_INTERVAL_MS = 150_000;
  protected duplicateConnectionEnforcement = duplicateMachineConnectionEnforcementEnabled();
  private static ACTIVITY_DAEMON_GENERATIONS_PER_AGENT = 4;
  /** Retain a small recent lifecycle buffer for debugging/tests without introducing persistence yet. */
  private static MAX_LIFECYCLE_EVENTS = 500;
  private readonly daemonIngressRateLimitWindowMs: number;
  private readonly daemonIngressRateLimitMaxEvents: number;
  private readonly daemonIngressRateLimitMaxEventsPerMachine: number;
  private readonly daemonIngressRateLimitDisabled: boolean;
  private readonly machineWsPingIntervalMs: number;

  constructor(
    private readonly replicaStateStore: ReplicaStateStore = redisReplicaStateStore,
    private readonly clock: OrchestratorClock = systemOrchestratorClock,
    private readonly tracer: Tracer = noopTracer,
    /** Uniform [0, 1) source for timing jitter (the pause-retry try times); injected like the clock. */
    random: () => number = currentRandomUnit,
  ) {
    super();
    this.daemonIngressRateLimitWindowMs = readPositiveIntegerEnv(
      "SLOCK_DAEMON_INGRESS_RATE_LIMIT_WINDOW_MS",
      AgentOrchestrator.DAEMON_INGRESS_RATE_LIMIT_DEFAULT_WINDOW_MS,
    );
    this.daemonIngressRateLimitMaxEvents = readPositiveIntegerEnv(
      "SLOCK_DAEMON_INGRESS_RATE_LIMIT_MAX_EVENTS",
      AgentOrchestrator.DAEMON_INGRESS_RATE_LIMIT_DEFAULT_MAX_EVENTS,
    );
    this.daemonIngressRateLimitMaxEventsPerMachine = readPositiveIntegerEnv(
      "SLOCK_DAEMON_INGRESS_RATE_LIMIT_MAX_EVENTS_PER_MACHINE",
      AgentOrchestrator.DAEMON_INGRESS_RATE_LIMIT_DEFAULT_MAX_EVENTS_PER_MACHINE,
    );
    this.daemonIngressRateLimitDisabled = readBooleanEnv("SLOCK_DISABLE_DAEMON_INGRESS_RATE_LIMIT");
    this.machineWsPingIntervalMs = readNonNegativeIntegerEnv(
      "SLOCK_MACHINE_WS_PING_INTERVAL_MS",
      AgentOrchestrator.MACHINE_WS_PING_DEFAULT_INTERVAL_MS,
    );
    this.readyOwedWakeRandom = random;
    // The combined claim records a pause's try too: same jitter source.
    this.terminalFailureBreaker = new TerminalFailureBreaker(redisTerminalFailureBreakerStore, { ...DEFAULT_WAKE_CRASH_LOOP_RULES, random });
    this.wakeCrashLoopBreaker = new WakeCrashLoopBreaker({
      getWakeCrashLoopState: (agentId) => this.replicaStateStore.getWakeCrashLoopState(agentId),
      compareAndSetWakeCrashLoopState: (agentId, expectedVersion, state) =>
        this.replicaStateStore.compareAndSetWakeCrashLoopState(agentId, expectedVersion, state),
    }, {
      // First cooldown before a start-timeout pause tries again by itself.
      pauseRetryBaseMs: readPositiveIntegerEnv("SLOCK_START_FAILURE_PAUSE_RETRY_MS", PAUSE_RETRY_BASE_MS),
      random,
    });
    provideAgentDeliveryPending(this.agentDeliveryPendingProvider);
  }

  private readonly agentDeliveryPendingProvider = (): Array<{ parked: boolean; daemonVersion: string; count: number }> => {
    const counts = new Map<string, { parked: boolean; daemonVersion: string; count: number }>();
    for (const pending of this.pendingAgentDeliveryAcks.values()) {
      const key = `${pending.parked}|${pending.daemonVersion}`;
      const entry = counts.get(key);
      if (entry) entry.count += 1;
      else counts.set(key, { parked: pending.parked, daemonVersion: pending.daemonVersion, count: 1 });
    }
    return [...counts.values()];
  };

  getCurrentTimeMs(): number {
    return this.clock.now();
  }

  /**
   * Make an already started span the active span while work runs, so child
   * spans and trace events nest under it.
   */
  private runInActiveSpan<T>(span: ActiveSpan, work: () => T): T {
    return runWithTraceSpan(span, work, getCurrentTraceContext() ? undefined : this.tracer);
  }

  private recordEvent(name: string, attrs?: TraceAttributes): void {
    recordTraceEvent(name, attrs, this.tracer);
  }

  /**
   * Run work inside a span. The span is a child of the active span when there
   * is one, and a root otherwise. A root carries this.tracer so that child
   * spans and trace events under it use the same tracer.
   */
  private async runInTraceSpan<T>(
    name: string,
    options: { attrs?: TraceAttributes; parent?: TraceContext | null; kind?: "internal" | "consumer" | "producer" },
    work: () => Promise<T>,
    finish?: (result: T) => { status?: TraceStatus; attrs?: TraceAttributes },
  ): Promise<T> {
    const current = getCurrentTraceContext();
    const span = this.tracer.startSpan(name, {
      parent: options.parent !== undefined ? options.parent : current,
      surface: "server",
      kind: options.kind ?? "internal",
      attrs: options.attrs,
    });
    try {
      const result = await runWithTraceSpan(span, work, current ? undefined : this.tracer);
      const outcome = finish?.(result);
      span.end(outcome?.status ?? "ok", outcome?.attrs ? { attrs: outcome.attrs } : undefined);
      return result;
    } catch (error) {
      span.end("error", { attrs: { error_class: errorClassOf(error) } });
      throw error;
    }
  }

  /**
   * Run one app source receipt as a span under the current span. The work reports the receipt
   * outcome through setReceiptOutcome; the last call wins and is written on
   * the span when the work ends.
   */
  private async runAppSourceReceipt(
    attrs: TraceAttributes,
    work: (setReceiptOutcome: (attrs: Record<string, unknown>, status?: TraceStatus) => void) => Promise<void>,
    parent?: TraceContext | null,
  ): Promise<void> {
    let receiptOutcome: { attrs: TraceAttributes; status: TraceStatus } | null = null;
    await this.runInTraceSpan(
      "server.app_source.receipt",
      // A daemon that sent its traceparent gets the receipt on its trace;
      // otherwise the receipt stays under the current (socket) span.
      parent ? { attrs, parent, kind: "consumer" } : { attrs },
      () => work((outcomeAttrs, status) => {
        receiptOutcome = { attrs: filterAppRuntimeTraceAttrs(outcomeAttrs), status: status ?? "ok" };
      }),
      () => receiptOutcome ?? {},
    );
  }

  /**
   * Classification of one best-effort machine send. The variant fields are
   * also the span attributes: they spread directly onto the transport span.
   */
  private async trySendAppTransport(
    machineId: string,
    message: ServerToMachineMessage,
  ): Promise<AppTransportSendResult> {
    try {
      return (await this.sendToMachine(machineId, message))
        ? { outcome: "sent" }
        : { outcome: "send_failed", reason: "machine_unreachable" };
    } catch (err) {
      // ws@8.20 sync-throws `Error('WebSocket is not open: readyState 0 (CONNECTING)')`
      // while the socket is mid-handshake; CLOSING/CLOSED surface as an async
      // ws error event instead of this catch. The sync throw means "connection
      // unready", same as a false return — not a code fault.
      if (err instanceof Error && err.message.startsWith("WebSocket is not open")) {
        return { outcome: "send_failed", reason: "machine_unreachable" };
      }
      return {
        outcome: "send_failed",
        reason: "send_threw",
        error_class: errorClassOf(err),
      };
    }
  }

  /**
   * Best-effort push of one built-in App message to its owner's machine.
   * An unassigned owner (agent without a machine) is a designed, recovered
   * state — the daemon refills via snapshot on reconnect — so it traces as
   * ok, never as error. Send failures trace as error with a low-cardinality
   * reason and stay on the boolean return; they never throw.
   */
  private async sendAppTransport(input: {
    spanName: "server.app_source.transport" | "server.app_config.transport";
    traceAttrs: Record<string, unknown>;
    machineId: string | null;
    message: ServerToMachineMessage;
  }): Promise<boolean> {
    if (!input.machineId) {
      this.recordEvent(input.spanName, filterAppRuntimeTraceAttrs({
        ...input.traceAttrs,
        message_type: input.message.type,
        outcome: "owner_offline",
      }));
      return false;
    }
    const machineId = input.machineId;
    const result = await this.runInTraceSpan(
      input.spanName,
      {
        attrs: filterAppRuntimeTraceAttrs({
          ...input.traceAttrs,
          machine_id: machineId,
          message_type: input.message.type,
        }),
      },
      () => this.trySendAppTransport(machineId, input.message),
      (sendResult) => ({
        status: sendResult.outcome === "sent" ? "ok" : "error",
        attrs: filterAppRuntimeTraceAttrs({ ...sendResult }),
      }),
    );
    return result.outcome === "sent";
  }

  private async deliverBuiltInAppSnapshot<T>(input: {
    machineId: string;
    messageType: "reminder.snapshot" | "app_config.snapshot";
    spanName: "server.app_source.transport" | "server.app_config.transport";
    composition: AppSnapshotComposition<T>;
    buildMessage: (values: T[]) => ServerToMachineMessage;
  }): Promise<void> {
    await this.runInTraceSpan(
      input.spanName,
      {
        attrs: filterAppRuntimeTraceAttrs({
          machine_id: input.machineId,
          message_type: input.messageType,
        }),
      },
      async () => {
        const snapshotFailed = input.composition.terminals.some(
          (terminal) => terminal.outcome === "snapshot_failed",
        );
        const sendResult: AppTransportSendResult = snapshotFailed
          ? { outcome: "send_skipped", reason: "snapshot_failed" }
          : await this.trySendAppTransport(
            input.machineId,
            input.buildMessage(input.composition.envelopes.map((envelope) => envelope.value)),
          );
        const sent = sendResult.outcome === "sent";
        for (const envelope of input.composition.envelopes) {
          this.recordEvent(input.spanName, filterAppRuntimeTraceAttrs({
            ...envelope.traceAttrs,
            machine_id: input.machineId,
            message_type: input.messageType,
            ...sendResult,
          }));
        }
        for (const terminal of input.composition.terminals) {
          const failed = terminal.outcome === "snapshot_failed";
          this.recordEvent(input.spanName, filterAppRuntimeTraceAttrs({
            ...terminal.traceAttrs,
            machine_id: input.machineId,
            message_type: input.messageType,
            ...(failed
              ? { outcome: "snapshot_failed", reason: terminal.reason }
              : sent
                ? { outcome: "sent_empty" }
                : sendResult),
          }));
        }
        return sendResult;
      },
      (sendResult) => ({
        status: sendResult.outcome === "sent" ? "ok" : "error",
        attrs: filterAppRuntimeTraceAttrs({ ...sendResult }),
      }),
    );
  }

  /**
   * Machine-connect reminder coverage (task #2, #proj-reminder): push a
   * reminder snapshot for EVERY agent on this machine that owns scheduled
   * reminders — authoritatively from the reminders table, independent of
   * whether the agent has a running/idle session. The daemon's own
   * connect-time requests cover only session-holding agents; an owner outside
   * that set never gets its reminders loaded into the local scheduler, so
   * missed fires neither trigger nor advance until an unrelated upsert forces
   * a snapshot. The daemon applies unsolicited reminder.snapshot messages
   * per-agent (idempotent replace), so pushing is safe alongside its own
   * requests.
   */
  protected async pushReminderSnapshotsForMachine(machineId: string): Promise<void> {
    const ownerAgentIds = await reminderService.listScheduledReminderOwnersForMachine(machineId);
    for (const agentId of ownerAgentIds) {
      const composition = await composeReminderSnapshot(agentId);
      await this.deliverBuiltInAppSnapshot({
        machineId,
        messageType: "reminder.snapshot",
        spanName: "server.app_source.transport",
        composition,
        buildMessage: (reminders) => ({
          type: "reminder.snapshot",
          agentId,
          reminders,
        }),
      });
    }
  }

  /**
   * Machine-connect app-config coverage: the same gap as reminders above. A
   * freshly started daemon has no running/idle sessions at connect, so it
   * requests no app_config snapshot, and system.cleaner never arms its
   * per-owner schedule until some later reconnect or config edit. Push every
   * agent's built-in app config on ready; the daemon applies unsolicited
   * snapshots per owner (same revision is a no-op).
   */
  protected async pushAppConfigSnapshotsForMachine(machineId: string): Promise<void> {
    const machineAgents = await agentService.getAgentsForMachine(machineId);
    for (const agent of machineAgents) {
      const composition = await listBuiltInAppConfigSnapshotsForAgent({
        serverId: agent.serverId,
        ownerAgentId: agent.id,
      });
      await this.deliverBuiltInAppSnapshot({
        machineId,
        messageType: "app_config.snapshot",
        spanName: "server.app_config.transport",
        composition,
        buildMessage: (configs) => ({
          type: "app_config.snapshot",
          agentId: agent.id,
          configs,
        }),
      });
    }
  }

  protected async persistAgentStatus(agentId: string, status: AgentStatus, sessionId?: string) {
    await agentService.updateAgentStatus(agentId, status, sessionId);
  }

  /**
   * Signal-driven status writes (ready reconcile, daemon `agent:status`/`agent:session`)
   * gate on the in-memory cache, but the cache is replica-local and never
   * invalidated cross-replica. Route signal writes through the DB-layer guard so
   * a stale `active` cache on another replica cannot resurrect a stopped agent,
   * and a process on a Computer the agent was moved away from cannot overwrite
   * its status or session (the write is fenced by `machineId` in SQL).
   */
  protected async persistAgentStatusFromSignal(
    agentId: string,
    status: AgentStatus,
    write: { machineId: string; sessionId?: string },
  ): Promise<agentService.AgentSignalStatusWriteOutcome> {
    return agentService.updateAgentStatusFromSignal(agentId, status, write);
  }

  /**
   * The signal write seam behind the lifecycle projection writer. A write the
   * Machine fence drops means this replica's cache still places the agent on
   * the signal's Computer: evict it so the next read reloads the row.
   */
  private async persistAgentStatusFromSignalFenced(
    agentId: string,
    status: AgentStatus,
    write: { machineId: string | null; sessionId?: string },
  ): Promise<agentService.AgentSignalStatusWriteOutcome> {
    const outcome = write.machineId
      ? await this.persistAgentStatusFromSignal(agentId, status, {
        machineId: write.machineId,
        ...(write.sessionId !== undefined ? { sessionId: write.sessionId } : {}),
      })
      : "machine_fenced";
    if (outcome === "machine_fenced") {
      this.agentStateCache.delete(agentId);
      this.recordEvent("agent.status.signal.machine_fenced", {
        outcome: "dropped",
        reason: write.machineId ? "agent_not_on_signal_machine" : "signal_machine_unknown",
        next_status: status,
        session_present: write.sessionId !== undefined,
      });
    }
    return outcome;
  }

  protected async invalidatePersistedAgentSessionFromSignal(
    agentId: string,
    expectedSessionId: string,
    expectedMachineId: string,
  ) {
    return agentService.invalidateAgentSessionFromSignal(agentId, expectedSessionId, expectedMachineId);
  }

  protected async persistAgentLastRuntimeError(agentId: string, lastRuntimeError: AgentRuntimeErrorState) {
    return agentService.setAgentLastRuntimeError(agentId, lastRuntimeError);
  }

  protected async clearPersistedAgentLastRuntimeError(agentId: string): Promise<agentService.AgentRuntimeErrorClearResult | null> {
    return agentService.clearAgentLastRuntimeErrorUnlessBilling(agentId);
  }

  /** task #1351 proof-and-clear: the BillingError this frame proves recovered, removed; null when nothing matched. */
  protected async clearPersistedBillingErrorOnRecovery(
    agentId: string,
    frame: agentService.RuntimeErrorFrameEvidence,
  ): Promise<AgentRuntimeErrorState | null> {
    return agentService.clearAgentBillingErrorOnRecovery(agentId, frame);
  }

  protected async stampPersistedRuntimeErrorRecoveryLaunch(agentId: string, launchId: string): Promise<AgentRuntimeErrorState | null> {
    return agentService.stampAgentRuntimeErrorRecoveryLaunch(agentId, launchId);
  }

  protected async loadAgentForSessionBroadcast(agentId: string) {
    return agentService.getAgent(agentId, false, {
      dbCallsite: "agent_orchestrator.session_broadcast_reload",
    });
  }

  private getLifecycleBuffer(agentId: string): AgentLifecycleRingBuffer {
    let buffer = this.lifecycleEventsByAgent.get(agentId);
    if (!buffer) {
      buffer = {
        events: new Array<AgentLifecycleEvent>(AgentOrchestrator.MAX_LIFECYCLE_EVENTS),
        nextIndex: 0,
        size: 0,
      };
      this.lifecycleEventsByAgent.set(agentId, buffer);
    }
    return buffer;
  }

  private readLifecycleBuffer(buffer: AgentLifecycleRingBuffer, limit: number): AgentLifecycleEvent[] {
    const count = Math.min(limit, buffer.size);
    if (count === 0) return [];

    const start = (buffer.nextIndex - count + AgentOrchestrator.MAX_LIFECYCLE_EVENTS) % AgentOrchestrator.MAX_LIFECYCLE_EVENTS;
    const events: AgentLifecycleEvent[] = [];

    for (let i = 0; i < count; i += 1) {
      const index = (start + i) % AgentOrchestrator.MAX_LIFECYCLE_EVENTS;
      const event = buffer.events[index];
      if (event) events.push(event);
    }

    return events;
  }

  protected recordLifecycleEvent(event: Omit<AgentLifecycleEvent, "at">) {
    const enriched: AgentLifecycleEvent = {
      at: this.clock.now(),
      ...event,
    };
    const buffer = this.getLifecycleBuffer(enriched.agentId);
    buffer.events[buffer.nextIndex] = enriched;
    buffer.nextIndex = (buffer.nextIndex + 1) % AgentOrchestrator.MAX_LIFECYCLE_EVENTS;
    buffer.size = Math.min(buffer.size + 1, AgentOrchestrator.MAX_LIFECYCLE_EVENTS);
    this.emit("agent:lifecycle", enriched);
  }

  getRecentLifecycleEvents(agentId?: string, limit = 50): AgentLifecycleEvent[] {
    if (agentId) {
      const buffer = this.lifecycleEventsByAgent.get(agentId);
      return buffer ? this.readLifecycleBuffer(buffer, limit) : [];
    }

    const events = [...this.lifecycleEventsByAgent.values()]
      .flatMap((buffer) => this.readLifecycleBuffer(buffer, AgentOrchestrator.MAX_LIFECYCLE_EVENTS))
      .sort((a, b) => a.at - b.at);

    return events.slice(-limit);
  }

  private makeLifecycleCorrelationId(...parts: Array<string | null | undefined>): string {
    return parts.filter((part): part is string => Boolean(part)).join(":");
  }

  private makeLifecycleDedupeKey(...parts: Array<string | null | undefined>): string {
    return parts.filter((part): part is string => Boolean(part)).join(":");
  }

  private makeReadyReconcileActivityDedupeKey(input: {
    agentId: string;
    machineId: string;
    connectionEpochId?: string;
    agentStatus: AgentStatus;
    action: ReadyReconcilePlanAction;
  }): string {
    const incidentKind = input.agentStatus === "stopped"
      ? "manualStop"
      : input.action === "mark-active-online"
        ? "readyOnline"
        : input.action === "mark-wakeable-not-running"
          ? "wakeableNotRunning"
          : "runtimeInterrupted";
    return this.makeLifecycleDedupeKey(
      "agent",
      input.agentId,
      "machine",
      input.machineId,
      "connectionEpoch",
      input.connectionEpochId ?? "unknown",
      "readyReconcile",
      incidentKind,
    );
  }

  private getConnectionEpochId(machineId: string | null | undefined): string | undefined {
    if (!machineId) return undefined;
    return this.machineConnections.get(machineId)?.connectionEpochId;
  }

  /**
   * `stopReason`: the `agent:stop` reason an awaited stop send carries (only
   * an explicit stop sets one: the owner's Stop, or the stop before a delete).
   * Best-effort lifecycle stops never carry one.
   */
  private lifecycleProjectionWriterDeps(options: { stopReason?: AgentStopReason } = {}): AgentLifecycleProjectionWriterDeps {
    return {
      broadcastActivity: (agentId, activity, detail, detailKind, entries, nowOverride, options) =>
        this.broadcastActivity(agentId, activity, detail, detailKind, entries, nowOverride, options),
      broadcastReadyOnline: (agentId, span) => this.broadcastReadyOnline(agentId, span),
      emitLifecyclePlanShadowVerdict: (agentId, signal, span) =>
        this.emitActivityWriterShadowVerdict(agentId, {
          activity: signal.activity,
          detailKind: signal.detailKind,
          observationClass: signal.observationClass,
          site: "lifecycle_plan",
          planKind: signal.planKind,
        }),
      clearInbox: (agentId) => this.localInboxes.clear(agentId),
      clearLaunchGuard: (agentId) => this.clearLaunchGuard(agentId),
      maybeResolveStartingActivity: (agentId, span) => this.maybeResolveStartingActivity(agentId, span),
      persistAgentStatus: (agentId, status, sessionId) => this.persistAgentStatus(agentId, status, sessionId),
      persistAgentStatusFromSignal: (agentId, status, write) =>
        this.persistAgentStatusFromSignalFenced(agentId, status, write),
      releaseWakeLock: (agentId) => this.releaseWakeLock(agentId),
      terminalizeFreshnessHold: (agentId, reason, span) => this.terminalizeFreshnessHold(agentId, reason, span),
      sendBestEffortStopToMachine: (machineId, agentId) => this.sendBestEffortToMachine(
        machineId,
        { type: "agent:stop", agentId },
        `best-effort lifecycle stop send failed for agent ${agentId}`,
      ),
      sendStopToMachine: async (machineId, agentId) => {
        const sent = await this.sendToMachine(
          machineId,
          options.stopReason ? { type: "agent:stop", agentId, reason: options.stopReason } : { type: "agent:stop", agentId },
        );
        if (!sent) {
          console.warn(`[Orchestrator] stopAgent ${agentId}: machine ${machineId} unreachable, applying lifecycle projection anyway`);
        }
        return sent;
      },
      updateCache: (agentId, updates) => this.updateCache(agentId, updates),
    };
  }

  setIO(io: SocketServer) {
    this.io = io;
    // Periodically sweep stale transient activities (working/thinking stuck due to missed events)
    if (!this.staleActivityTimer) {
      void this.sweepComputerLifecycleOperations().catch(() => {});
      void this.dispatchPendingComputerLifecycleOperations().catch(() => {});
      this.staleActivityTimer = this.clock.scheduleRepeated(() => {
        void this.sweepStaleActivities();
        void this.sweepComputerLifecycleOperations().catch(() => {});
        void this.dispatchPendingComputerLifecycleOperations().catch(() => {});
        void this.dispatchPendingAgentArchiveOps().catch(() => {});
        void this.sweepComputerVersionGates().catch(() => {});
      }, 30_000);
    }
    if (this.runtimeOutcomeAckEnabled && !this.spawnErrorRetryTimer) {
      this.spawnErrorRetryTimer = this.clock.scheduleRepeated(() => {
        void this.sweepSpawnErrorRetries().catch(() => {});
      }, AgentOrchestrator.SPAWN_ERROR_RETRY_SWEEP_MS);
    }
  }

  /**
   * Reset any working/thinking activities that have been stale for too long.
   *
   * Behaviour change 2026-05-02 (#engineering:72283cf7 task #340 PR A):
   * instead of synthesizing `online` immediately when a transient state
   * goes 90s without an update, we first ask the agent's daemon for
   * ground truth via `agent:activity_probe`. The daemon's response
   * arrives via the existing `agent:activity` upstream channel and
   * cancels the fallback. Expired non-local shadows are disposed without
   * publishing activity. If a connected daemon probe times out, we preserve
   * the last busy state instead of inventing
   * online/idle: a missed probe is not proof that a long tool call
   * finished.
   *
   * The pure-function `planStaleActivitySweepAction` + protected
   * `applyStaleActivitySweepAction` seam is preserved for tests; the
   * probe machinery wraps but doesn't replace it.
   */
  private async sweepStaleActivities(): Promise<void> {
    await this.runInTraceSpan(
      "server.agent.stale_activity.sweep",
      { parent: null, attrs: { replica_id: REPLICA_ID } },
      () => this.sweepStaleActivitiesInSpan(),
      ({ staleCount, evictedCount }) => {
        const preservedRepeatCount = this.busyPreservedRepeats;
        this.busyPreservedRepeats = 0;
        return { attrs: {
          stale_count: staleCount,
          preserved_repeat_count: preservedRepeatCount,
          evicted_count: evictedCount,
          activity_cache_size: this.agentActivity.size,
        } };
      },
    );
  }

  private async sweepStaleActivitiesInSpan(): Promise<{ staleCount: number; evictedCount: number }> {
    const now = this.clock.now();
    const pendingWork: Promise<void>[] = [];
    let staleCount = 0;
    let evictedCount = 0;
    const snapshots = [...this.agentActivity.entries()];
    const expired = (entry: ActivitySnapshot) => now - entry.updatedAt > AgentOrchestrator.ACTIVITY_STALE_SEC * 1000;
    const hasLocalMachine = [...this.machineConnections.keys()].some((id) => this.hasMachineLocally(id));
    // evictCache() also invalidates placement on config/session changes. A
    // missing cached agent is not proof that its Computer is remote. Resolve
    // only these misses in bounded batches, without adding a per-agent query.
    const missingPlacements = hasLocalMachine
      ? snapshots.filter(([id, entry]) => (
        expired(entry) && !this.isServerActivityBlock(entry.detailKind) && !this.agentStateCache.has(id)
      )).map(([id]) => id)
      : [];
    const resolvedPlacements = new Map<string, string | null>();
    for (let offset = 0; offset < missingPlacements.length; offset += 500) {
      const ids = missingPlacements.slice(offset, offset + 500);
      try {
        const rows = await this.loadAgentPlacements(ids);
        for (const id of ids) resolvedPlacements.set(id, null);
        for (const row of rows) resolvedPlacements.set(row.id, row.deletedAt ? null : row.machineId);
      } catch {
        // Keep unresolved entries on lookup failure; retry next sweep.
        this.recordEvent("server.agent.stale_activity.placement_lookup_failed", { agent_count: ids.length });
      }
    }
    for (const [agentId, entry] of snapshots) {
      // A real activity frame may have replaced the snapshot during a lookup.
      if (this.agentActivity.get(agentId) !== entry) continue;
      const cached = this.agentStateCache.get(agentId);
      const machineId = cached ? cached.machineId : resolvedPlacements.get(agentId) ?? null;
      const placementKnown = Boolean(cached) || !hasLocalMachine || resolvedPlacements.has(agentId);
      // Server-authored blocks remain authority even on a non-owner. Ordinary
      // shadows are read through Redis by getActivity and must not accumulate
      // over the fleet's ownership history. Expire by write clock, including
      // idle/error rows, without changing the owner's shared state.
      if (expired(entry) && !this.isServerActivityBlock(entry.detailKind) && placementKnown
        && (!machineId || !this.hasMachineLocally(machineId))) {
        this.forgetLocalActivitySnapshot(agentId);
        evictedCount += 1;
        continue;
      }
      const action = planStaleActivitySweepAction({
        isTransient: this.isTransientActivity(entry.activity),
        ageSec: (now - this.getActivityObservedAtMs(entry)) / 1000,
        staleAfterSec: AgentOrchestrator.ACTIVITY_STALE_SEC,
      });
      if (action === "keep-current") continue;
      staleCount += 1;

      // Ask a locally connected Computer for a fresh observation. Missing or
      // uncertain placement only produces diagnostics; it cannot establish idle.
      if (!machineId) {
        this.applyStaleActivitySweepAction({ action, agentId, now });
        continue;
      }
      if (!this.machineConnections.has(machineId)) {
        pendingWork.push(this.handleStaleActivityWithoutLocalMachine(agentId, machineId, action, now));
        continue;
      }

      // Skip if another probe for this agent is already in flight.
      let alreadyInFlight = false;
      for (const pending of this.pendingActivityProbes.values()) {
        if (pending.agentId === agentId) {
          alreadyInFlight = true;
          break;
        }
      }
      if (alreadyInFlight) continue;

      // Probe path — async, fires fallback timer if no response in 5s.
      pendingWork.push(this.issueActivityProbe(agentId, machineId, now));
    }
    await Promise.allSettled(pendingWork);
    return { staleCount, evictedCount };
  }

  private async handleStaleActivityWithoutLocalMachine(
    agentId: string,
    machineId: string,
    action: StaleActivitySweepPlanAction,
    now: number,
  ) {
    try {
      const ownerReplica = this.replicaStateStore.isAvailable()
        ? await this.replicaStateStore.getMachineReplicaOwner(machineId)
        : null;
      if (ownerReplica && ownerReplica !== REPLICA_ID) {
        this.refreshStaleTransientActivity(agentId, now);
        return;
      }
    } catch {
      // Fall through to the legacy synthetic repair when replica reachability
      // cannot be proven. A Redis outage is not positive evidence of a live
      // remote owner.
    }
    this.applyStaleActivitySweepAction({ action, agentId, now });
  }

  /**
   * Send `agent:activity_probe` to the daemon and arm a 5s fallback
   * timer. On daemon response (`agent:activity` carrying matching
   * `probeId`) `handleActivityProbeResponse` cancels the timer. If
   * the probe times out, keep the last busy state visible; timeout is
   * ambiguous between "daemon wedged" and "long tool call", so it
   * must not be rendered as idle/online.
   *
   * TODO(lifecycle-v2/daemon-protocol): replace this legacy probe/request
   * pair with a canonical activity_snapshot_request / activity_snapshot
   * exchange. The response should be a read-only state snapshot, not another
   * `agent:activity` event that the server has to distinguish from lifecycle
   * mutation.
   */
  private async issueActivityProbe(agentId: string, machineId: string, sweepNow: number) {
    const fallbackToBusySnapshot = () => this.refreshStaleTransientActivity(agentId, this.clock.now());
    const fallbackAfterTimeout = () => {
      void this.runInTraceSpan(
        "server.agent.activity_probe.timeout",
        { parent: null, attrs: { agent_id: agentId, machine_id: machineId } },
        async () => fallbackToBusySnapshot(),
      );
    };

    const probeId = crypto.randomUUID();
    const fallbackTimer = setTimeout(() => {
      // Probe timed out — daemon crashed, unreachable, or too slow.
      if (this.pendingActivityProbes.delete(probeId)) {
        fallbackAfterTimeout();
      }
    }, AgentOrchestrator.ACTIVITY_PROBE_TIMEOUT_MS);

    this.pendingActivityProbes.set(probeId, {
      agentId,
      startedAt: sweepNow,
      fallbackTimer,
    });

    try {
      const sent = await this.sendToMachine(machineId, {
        type: "agent:activity_probe",
        agentId,
        probeId,
        purpose: "sweep",
      });
      if (!sent) {
        if (this.pendingActivityProbes.delete(probeId)) {
          clearTimeout(fallbackTimer);
          fallbackToBusySnapshot();
        }
      }
    } catch {
      if (this.pendingActivityProbes.delete(probeId)) {
        clearTimeout(fallbackTimer);
        fallbackToBusySnapshot();
      }
    }
  }

  private refreshStaleTransientActivity(agentId: string, now: number) {
    const current = this.agentActivity.get(agentId);
    if (!current || !this.isTransientActivity(current.activity)) {
      this.applyStaleActivitySweepAction({ action: "sweep-online", agentId, now });
      return;
    }

    // "Starting…" is a TRANSITIONAL working state, not genuine busy work:
    // `isFreshBusyActivity` deliberately excludes it (working + "Starting…"
    // → false). It must resolve to `online`, not be preserved. Preserving it
    // here used to re-stamp its age every sweep and pin the activity bar/status-
    // history on "Starting" indefinitely when a relaunch's ready path didn't
    // fire `maybeResolveStartingActivity` — the agent is live and producing
    // activity, yet the visible state is stuck. Route this explicit transition
    // to the same resolve path instead. (#161 starting-line closure)
    // Gated on the closed `detailKind` (not display text) to stay consistent
    // with `maybeResolveStartingActivity` and the T4 no-text-as-semantics rule.
    if (
      current.activity === "working"
      && (current.detailKind === "starting" || current.detailKind === "runtime_starting")
    ) {
      this.maybeResolveStartingActivity(agentId);
      return;
    }

    // One diagnostic pair per stale phase: the snapshot is not rewritten here,
    // so a repeat of the same phase carries no new information.
    // Keyed on the observed clock and the content: a synthetic rewrite keeps
    // observedAtMs but may change the activity or its kind, which is a new phase.
    const phase = `${current.observedAtMs ?? current.updatedAt}:${current.activity}:${current.detailKind ?? ""}`;
    if (this.busyPreservedPhase.get(agentId) === phase) {
      this.busyPreservedRepeats += 1;
      return;
    }
    this.busyPreservedPhase.set(agentId, phase);
    const serverId = this.agentStateCache.get(agentId)?.serverId ?? "unknown";
    // A probe timeout is not a new runtime or delivery observation. Keep the
    // existing snapshot in memory, but do not re-broadcast it: re-emitting a
    // stale message_received snapshot mints a new user-visible/durable fact and
    // launders its freshness on every sweep cadence. The legacy
    // preserve_rebroadcast site value remains stable for trace consumers, while
    // the verdict records the canonical no-authority/no-clock-advance outcome.
    this.recordEvent("server.agent.stale_activity.busy_preserved", {
      agent_id: agentId,
      server_id: serverId,
      previous_activity: current.activity,
      detail_present: Boolean(current.detail),
      repair_kind: "probe_timeout_busy_preserved",
      authority: "scheduler_repair",
      candidate_activity: current.activity,
      served_activity: current.activity,
      projection_outcome: "preserved_without_write",
      outcome: "preserved_without_write",
      reason: "synthetic_no_authority",
      advances_observed_clock: "none",
    });
    this.recordEvent(
      "lifecycle_v2.shadow_verdict",
      buildLifecycleShadowVerdictAttrs(
        {
          activity: current.activity,
          detail: current.detail,
          detailKind: current.detailKind,
          updatedAtMs: current.observedAtMs ?? current.updatedAt,
        },
        {
          activity: current.activity,
          agentId,
          detailKind: current.detailKind,
          atMs: now,
          // Server-originated: the sweep carries no launch generation.
          currentLaunchGeneration: null,
          launchGeneration: null,
          observationClass: "synthetic",
          site: "preserve_rebroadcast",
        },
      ),
    );
  }

  /**
   * Cancel the fallback timer when the daemon's probe response arrives.
   * Called from the `agent:activity` ingest path when the inbound
   * message carries a matching `probeId`. The activity payload itself
   * still flows through the normal broadcast pipeline (so the new
   * ground-truth state propagates to clients via standard means);
   * this method just stops the synth-fallback from also firing.
   */
  private handleActivityProbeResponse(probeId: string) {
    const pending = this.pendingActivityProbes.get(probeId);
    if (!pending) return;
    clearTimeout(pending.fallbackTimer);
    this.pendingActivityProbes.delete(probeId);
  }

  protected applyStaleActivitySweepAction(context: StaleActivitySweepApplyContext) {
    if (context.action === "keep-current") {
      return;
    }
    const serverId = this.agentStateCache.get(context.agentId)?.serverId ?? "unknown";
    const current = this.agentActivity.get(context.agentId);
    this.recordEvent("server.agent.synthetic_repair.apply", {
      agent_id: context.agentId,
      server_id: serverId,
      synthetic_repair: true,
      repair_kind: "stale_sweep",
      source: "scheduler",
      authority: "scheduler_repair",
      previous_activity: current?.activity ?? "none",
      candidate_activity: "online",
      served_activity: current?.activity ?? "none",
      projection_outcome: "preserved_without_write",
      outcome: "preserved_without_write",
      reason: "synthetic_no_authority",
      advances_observed_clock: "none",
    });
    // Keep the legacy online candidate in the shadow verdict so the rejected
    // heuristic remains measurable, but do not project it into activity truth.
    this.emitSyntheticRepairShadowVerdict(context.agentId, context.now);
  }

  /**
   * Shared gamma shadow emitter for the two synthetic-repair apply sites
   * (stale_sweep / transient_normalization). The signal records the rejected
   * legacy online candidate even though canonical repair is now trace-only.
   * This keeps the former whitewash measurable without minting it as truth.
   */
  private emitSyntheticRepairShadowVerdict(agentId: string, nowMs: number) {
    const current = this.agentActivity.get(agentId);
    this.recordEvent(
      "lifecycle_v2.shadow_verdict",
      buildLifecycleShadowVerdictAttrs(
        current
          ? {
              activity: current.activity,
              detail: current.detail,
              detailKind: current.detailKind,
              updatedAtMs: current.observedAtMs ?? current.updatedAt,
            }
          : undefined,
        {
          activity: "online",
          agentId,
          detailKind: "synthetic_repair",
          atMs: nowMs,
          // Server-originated repair: no launch generation is carried.
          currentLaunchGeneration: null,
          launchGeneration: null,
          observationClass: "synthetic",
          site: "synthetic_repair",
        },
      ),
    );
  }

  /**
   * gamma-2 write-site closure emitter (task #460): shared by the five
   * previously unshadowed agentActivity writers (starting_resolve /
   * ready_online / slock_action_status / hint_resolution / runtime_error —
   * see AGENT_ACTIVITY_WRITER_REGISTRY). The verdict is a standalone trace
   * event. It links to the active span when there is one, and is still
   * recorded when there is none, so a serving map write is never invisible
   * in traces. Trace only; zero behavior change.
   */
  private emitActivityWriterShadowVerdict(
    agentId: string,
    signal: {
      activity: AgentActivityKind;
      detailKind?: AgentActivityDetailKind | null;
      observationClass: LifecycleObservationClass;
      site: LifecycleShadowSignalSite;
      planKind?: AgentLifecycleEventType;
    },
  ) {
    const current = this.agentActivity.get(agentId);
    const attrs = buildLifecycleShadowVerdictAttrs(
      current
        ? {
            activity: current.activity,
            detail: current.detail,
            detailKind: current.detailKind,
            updatedAtMs: current.observedAtMs ?? current.updatedAt,
          }
        : undefined,
      {
        activity: signal.activity,
        agentId,
        detailKind: signal.detailKind ?? null,
        atMs: this.clock.now(),
        // Server-originated writers carry no launch generation.
        currentLaunchGeneration: null,
        launchGeneration: null,
        observationClass: signal.observationClass,
        site: signal.site,
        ...(signal.planKind !== undefined ? { planKind: signal.planKind } : {}),
      },
    );
    this.recordEvent("lifecycle_v2.shadow_verdict", attrs);
  }

  private shouldRecordDeliveryAckTurnActive(agentId: string, agent: CachedAgentState | null): DeliveryAckTurnActiveGate {
    const runtimeState = agent?.runtimeState ?? this.agentStateCache.get(agentId)?.runtimeState ?? "unknown";
    const current = this.agentActivity.get(agentId) ?? null;
    const observedAgeSec = current ? this.getActivityAgeSec(current) : null;
    const liveRuntimeState = runtimeState === "starting" || runtimeState === "running_idle" || runtimeState === "working" || runtimeState === "thinking";

    if (!liveRuntimeState) {
      return {
        admit: false,
        reason: "runtime_liveness_failed_or_unknown",
        runtimeState,
        currentActivity: current?.activity ?? null,
        observedAgeSec,
      };
    }

    if (
      current
      && this.isTransientActivity(current.activity)
      && observedAgeSec !== null
      && observedAgeSec > AgentOrchestrator.ACTIVITY_STALE_SEC
    ) {
      return {
        admit: false,
        reason: "stale_runtime_observation",
        runtimeState,
        currentActivity: current.activity,
        observedAgeSec,
      };
    }

    return {
      admit: true,
      reason: null,
      runtimeState,
      currentActivity: current?.activity ?? null,
      observedAgeSec,
    };
  }

  private recordDeliveryAckTurnActive(
    agentId: string,
    agent: CachedAgentState | null,
    span?: ActiveSpan | null,
  ): ActivityBroadcastTraceResult | null {
    const gate = this.shouldRecordDeliveryAckTurnActive(agentId, agent);
    if (!gate.admit) {
      span?.addEvent("turn_active.skipped", {
        outcome: "skipped",
        reason: gate.reason,
        runtime_state: gate.runtimeState,
        current_activity: gate.currentActivity,
        observed_age_sec: gate.observedAgeSec,
      });
      return null;
    }

    const now = this.clock.now();
    this.emitActivityWriterShadowVerdict(agentId, {
      activity: "working",
      detailKind: "message_received",
      observationClass: "observed_turn_active",
      site: "delivery_ack",
    });
    return this.broadcastActivity(agentId, "working", "Message received", "message_received", undefined, now, {
      observedAtMs: now,
      isDeliveryAckTurnActive: true,
      arbitration: {
        observationClass: "observed_turn_active",
        signalSite: "delivery_ack",
      },
    });
  }

  private isTransientActivity(activity: string): boolean {
    return activity === "working" || activity === "thinking";
  }

  private shouldPersistStatusOnlyActivity(
    activity: AgentActivityKind,
    detailKind: AgentActivityDetailKind,
  ): boolean {
    // Only the terminal activities that can currently arrive without explicit
    // trajectory entries need synthesis here. `stopped` / `crashed` are not
    // AgentActivity values routed through broadcastActivity; they are rendered as
    // `offline` or `error` before reaching this seam.
    if (activity === "offline" || activity === "error") return true;
    if (activity !== "working") return false;
    return detailKind === "starting"
      || detailKind === "runtime_starting"
      || detailKind === "message_received"
      || detailKind === "compaction_stale"
      || detailKind === "stalled_recovery";
  }

  recordActivityProducerEvent(agentId: string, event: ActivityProducerEvent) {
    const summary = this.formatActivityProducerField(event.summary, 120) || "Agent activity";
    const lines = [
      event.target ? `target: ${this.formatActivityProducerField(event.target, 160)}` : null,
      event.outcome && event.outcome !== "succeeded" ? `status: ${event.outcome}` : null,
    ].filter((line): line is string => Boolean(line));

    return this.broadcastRaftAction(agentId, {
      title: summary,
      text: lines.join("\n"),
    });
  }

  recordRaftCliAction(
    agentId: string,
    event: Omit<ActivityProducerEvent, "producer" | "outcome"> & { outcome?: "succeeded" | "failed" },
  ) {
    return this.recordActivityProducerEvent(agentId, {
      producer: "slock_cli",
      outcome: "succeeded",
      ...event,
    });
  }

  // Append a durable Raft workspace action. Live status/detail remains owned by
  // lifecycle/status projection; this helper must not author a new subtitle for it.
  async recordAgentRaftAction(
    agentId: string,
    event: {
      title: string;
      text: string;
      producerFactId?: string;
      activity?: AgentActivity;
      activityDetail?: string;
      dedupeKey?: string;
    },
  ): Promise<void> {
    const result = this.broadcastRaftAction(agentId, event);
    await result.persistence;
  }

  /**
   * Activity ingest (`raft-agent-activity-ingest.v1`). Hook events map to the
   * activity log / trajectory and, for agents that never adopted
   * raft-agent-status.v1, also to the live status. An event carrying a
   * raft-agent-status.v1 `status` (with or without a hook) drives the live
   * status directly (status + optional detail) through the same
   * external-signal lifecycle path, so latest-occurredAt-wins arbitration
   * holds; a replayed status `eventId` is skipped. The first accepted status
   * durably marks the agent as a status.v1 reporter, after which hook-derived
   * status no longer drives its dot (hook events are still logged).
   */
  async recordExternalAgentActivity(
    agentId: string,
    // Input-only: accept readonly event arrays (e.g. `as const` fixtures).
    request: Omit<ExternalAgentActivityIngestRequest, "events"> & {
      readonly events: readonly ExternalAgentActivityEvent[];
    },
    serverId?: string,
  ): Promise<{ acceptedCount: number; rejectedCount: number; droppedCount: number }> {
    const resolvedServerId = serverId ?? this.agentStateCache.get(agentId)?.serverId ?? "unknown";
    const span = this.tracer.startSpan("server.external_agent.activity.ingest", {
      surface: "server",
      kind: "internal",
      attrs: {
        agent_id: agentId,
        server_id: resolvedServerId,
        session_id: request.coreSessionId,
        event_count: request.events.length,
        // Which inputs drove the projection, from closed sets only (AndyLok): the
        // reported statuses and hook names in the batch, unknown names as `other`.
        status: externalActivityClosedValues(request.events.map((event) => isRaftAgentStatus(event.status) ? event.status : null)),
        hook_event_name: externalActivityClosedValues(request.events.map((event) => {
          const name = event.hookEventName ?? event.hook_event_name;
          if (typeof name !== "string" || name.length === 0) return null;
          return EXTERNAL_ACTIVITY_HOOK_EVENT_NAMES.has(name) ? name : "other";
        })),
      },
    });
    let acceptedCount = 0;
    let rejectedCount = 0;
    let statusCount = 0;
    let loggedOnlyCount = 0;
    let statusProtocolAdopted = false;
    try {
      const planned: PlannedExternalActivityEvent[] = [];
      for (const event of request.events) {
        // A subagent's event is not this agent's: logged under the subagent,
        // whatever status it carries.
        const subagent = normalizeExternalSubagentMarker(event.subagent);
        if (subagent) {
          const mapped = mapExternalSubagentActivityEvent(event, subagent);
          if (!mapped) {
            rejectedCount += 1;
            continue;
          }
          planned.push({ kind: "subagent", mapped });
          continue;
        }
        // A stopped turn is calm whatever status the runtime reported with it.
        const stoppedDetail = externalStoppedTurnDetail(event);
        const reported = isRaftAgentStatus(event.status) ? event.status : undefined;
        const status = reported && stoppedDetail ? "online" : reported;
        if (!status) {
          const mapped = mapExternalPluginActivityEvent(event);
          if (!mapped) {
            rejectedCount += 1;
            continue;
          }
          planned.push({ kind: "hook", mapped });
          continue;
        }
        const eventId = externalActivityString(event.eventId ?? event.event_id, 160);
        const occurredAtMs = externalActivityTimeMs(event.occurredAt ?? event.occurred_at);
        if (!eventId || occurredAtMs === undefined) {
          rejectedCount += 1;
          continue;
        }
        planned.push({
          kind: "status",
          eventId,
          status,
          detail: stoppedDetail ?? (typeof event.detail === "string" ? event.detail.slice(0, RAFT_AGENT_STATUS_DETAIL_LIMIT) : ""),
          occurredAtMs,
          mapped: mapExternalPluginActivityEvent(event),
        });
      }

      // Dedupe status reports by eventId: within the batch and against events
      // already recorded (the activity-log dedupe key is durable).
      const statusKeys = [...new Set(planned.flatMap((item) => (
        item.kind === "status" ? [externalAgentActivityDedupeKey(item.eventId)] : []
      )))];
      const recorded = statusKeys.length > 0
        ? await this.loadExistingActivityDedupeKeys(agentId, statusKeys)
        : new Set<string>();
      const seenStatusKeys = new Set<string>();
      const fresh = planned.filter((item) => {
        if (item.kind !== "status") return true;
        const key = externalAgentActivityDedupeKey(item.eventId);
        if (recorded.has(key) || seenStatusKeys.has(key)) {
          rejectedCount += 1;
          return false;
        }
        seenStatusKeys.add(key);
        return true;
      });

      if (fresh.some((item) => item.kind === "status")) {
        await this.markExternalStatusProtocolAdopted(agentId);
        statusProtocolAdopted = true;
      } else if (fresh.length > 0) {
        statusProtocolAdopted = await this.isExternalStatusProtocolAdopted(agentId);
      }

      for (const item of fresh) {
        acceptedCount += 1;
        const receivedAtMs = this.clock.now();
        if (item.kind === "subagent") {
          const observedAtMs = Math.min(item.mapped.occurredAtMs ?? receivedAtMs, receivedAtMs);
          if (await this.persistExternalSubagentActivity(agentId, item.mapped.entries, observedAtMs, item.mapped.dedupeKey)) {
            loggedOnlyCount += 1;
          }
          continue;
        }
        if (item.kind === "hook") {
          const { mapped } = item;
          const observedAtMs = Math.min(mapped.occurredAtMs ?? receivedAtMs, receivedAtMs);
          if (statusProtocolAdopted) {
            if (await this.persistExternalActivityLogOnly(agentId, mapped.entries, observedAtMs, mapped.dedupeKey)) {
              loggedOnlyCount += 1;
            }
            continue;
          }
          const eventId = mapped.dedupeKey ?? `external-activity-${acceptedCount}`;
          const lifecycleEvent = createAgentLifecycleEvent({
            serverId: resolvedServerId,
            agentId,
            eventType: "external_agent_signal",
            actor: "external",
            source: "external_cli",
            reason: "external_activity",
            correlationId: `agent:${agentId}:externalActivity:${eventId}`,
            occurredAt: mapped.occurredAtMs ? new Date(mapped.occurredAtMs) : new Date(this.clock.now()),
            attrs: {
              activity_status: mapped.activity,
              external_event_id: eventId.slice(0, 128),
            },
          });
          const plan = reduceExternalActivityLifecycle({
            event: lifecycleEvent,
            activity: mapped.activity,
            detail: mapped.detail,
            entries: mapped.entries,
            dedupeKey: mapped.dedupeKey,
            occurredAtMs: mapped.occurredAtMs,
            observedAtMs,
          });
          const applied = await applyAgentLifecycleProjectionPlan(plan, this.lifecycleProjectionWriterDeps(), span);
          // A hook older than the live status (a later batch, or a PreToolUse
          // back-dated to the tool's start) does not override it, but it is
          // still part of the agent's history and of its turn (task #17).
          if (applied.liveActivityResult?.action === "kernel-preserve") {
            await this.persistBackdatedExternalHookRow(agentId, mapped.entries, mapped.occurredAtMs ?? observedAtMs, mapped.dedupeKey);
          }
          continue;
        }

        statusCount += 1;
        const observedAtMs = Math.min(item.occurredAtMs, receivedAtMs);
        const dedupeKey = externalAgentActivityDedupeKey(item.eventId);
        // The hook's usual log entries ride along; its hook-derived status
        // entry is replaced by the reported status.
        // Tool outcome rows stay (task #17): they are per-step markers, not a status.
        const hookEntries = externalLogOnlyEntries(item.mapped?.entries ?? []);
        const lifecycleEvent = createAgentLifecycleEvent({
          serverId: resolvedServerId,
          agentId,
          eventType: "external_agent_signal",
          actor: "external",
          source: "external_cli",
          reason: "external_activity",
          correlationId: `agent:${agentId}:externalActivity:${dedupeKey}`,
          occurredAt: new Date(observedAtMs),
          attrs: {
            activity_status: item.status,
            external_event_id: dedupeKey.slice(0, 128),
            external_signal_kind: "status_report",
          },
        });
        const reportedStatusEntry: TrajectoryEntry = {
          kind: "status",
          activity: item.status,
          activityKind: item.status,
          detail: item.detail,
          detailKind: "external_activity",
          producerFactId: buildExternalStatusProducerFactId(item.eventId),
        };
        const plan = reduceExternalActivityLifecycle({
          event: lifecycleEvent,
          activity: item.status,
          detail: item.detail,
          entries: [...hookEntries, reportedStatusEntry],
          dedupeKey,
          occurredAtMs: observedAtMs,
          observedAtMs,
        });
        const applied = await applyAgentLifecycleProjectionPlan(plan, this.lifecycleProjectionWriterDeps(), span);
        // A stale status (older than the live one: a later batch, a back-dated
        // event) does not override it, but it and the hook it rode on are still
        // history, recorded at their own time (task #17: the turn summary folds
        // them; being older than the latest row they cannot become the hint).
        if (applied.liveActivityResult?.action === "kernel-preserve") {
          await this.persistBackdatedExternalHookRow(agentId, [...hookEntries, reportedStatusEntry], observedAtMs, dedupeKey);
        }
      }
      // Every accepted batch can complete or change a turn, whichever path its
      // events took (hooks, reported statuses, or both).
      // A subagent's events are never part of a parent turn, so a batch of only
      // those changes no turn and needs no refold.
      const eventTimes = fresh.flatMap((item) => item.kind === "subagent" ? [] : [Math.min(
        item.kind === "status" ? item.occurredAtMs : item.mapped.occurredAtMs ?? this.clock.now(),
        this.clock.now(),
      )]);
      if (eventTimes.length > 0) await this.rebuildExternalTurnSummaries(agentId, Math.min(...eventTimes));
      span.end("ok", {
        attrs: {
          outcome: acceptedCount > 0 ? "accepted" : "dropped",
          reason: acceptedCount > 0 ? "external_activity_mapped" : "no_mappable_events",
          accepted_count: acceptedCount,
          rejected_count: rejectedCount,
          status_count: statusCount,
          logged_only_count: loggedOnlyCount,
          status_protocol_adopted: statusProtocolAdopted,
        },
      });
    } catch (err) {
      span.end("error", {
        attrs: {
          outcome: "error",
          reason: "external_activity_projection_failed",
          accepted_count: acceptedCount,
          rejected_count: rejectedCount,
          error_class: errorClassOf(err),
        },
      });
      throw err;
    }

    return {
      acceptedCount,
      rejectedCount,
      droppedCount: normalizeExternalActivityDroppedCount(request.dropped),
    };
  }

  /** Whether the agent reports raft-agent-status.v1 (durable; cached once seen). */
  async isExternalStatusProtocolAdopted(agentId: string): Promise<boolean> {
    if (this.statusProtocolAdoptedAgents.has(agentId)) return true;
    const adoptedAt = await this.loadStatusProtocolAdoptedAt(agentId);
    if (!adoptedAt) return false;
    this.statusProtocolAdoptedAgents.add(agentId);
    return true;
  }

  private async markExternalStatusProtocolAdopted(agentId: string): Promise<void> {
    if (this.statusProtocolAdoptedAgents.has(agentId)) return;
    await this.persistStatusProtocolAdopted(agentId, new Date(this.clock.now()));
    this.statusProtocolAdoptedAgents.add(agentId);
  }

  protected async loadStatusProtocolAdoptedAt(agentId: string): Promise<Date | null> {
    return agentService.getAgentStatusProtocolAdoptedAt(agentId);
  }

  protected async persistStatusProtocolAdopted(agentId: string, adoptedAt: Date): Promise<void> {
    await agentService.markAgentStatusProtocolAdopted(agentId, adoptedAt);
  }

  protected async loadExistingActivityDedupeKeys(agentId: string, dedupeKeys: readonly string[]): Promise<Set<string>> {
    return agentActivityLogService.listExistingAgentActivityDedupeKeys(agentId, dedupeKeys);
  }

  /**
   * Record hook activity in the activity log / trajectory without touching the
   * live status (status.v1 reporters, or a hook riding a stale status).
   * Hook-derived `status` entries are dropped: they are the status derivation
   * the agent replaced. The row carries the current live status so a restart
   * hint read from the log does not resurrect a hook-derived one.
   */
  private async persistExternalActivityLogOnly(
    agentId: string,
    mappedEntries: readonly TrajectoryEntry[],
    observedAtMs: number,
    dedupeKey: string | undefined,
  ): Promise<boolean> {
    const entries = externalLogOnlyEntries(mappedEntries);
    if (entries.length === 0) return false;
    try {
      const current = await this.liveActivityForLogRow(agentId);
      return await this.persistActivityEvent(
        agentId,
        current.activity,
        current.detail,
        entries,
        new Date(observedAtMs),
        dedupeKey,
      );
    } catch (err) {
      console.warn(`[ActivityLog ${agentId}] Failed to persist external activity event:`, err);
      return false;
    }
  }

  /**
   * The agent's live status for a row that must not change it (log-only and
   * subagent rows): the row's activity is what the restart hint reads back.
   * The ingest runs on whichever replica got the request, so this replica's
   * cache may be stale; the shared mirror wins when it is at least as new.
   */
  private async liveActivityForLogRow(agentId: string): Promise<{ activity: AgentActivityKind; detail: string }> {
    const local = this.agentActivity.get(agentId) ?? null;
    let shared: PersistedAgentActivity | null = null;
    if (this.replicaStateStore.isAvailable()) {
      try {
        shared = await this.replicaStateStore.getAgentActivity(agentId);
      } catch (err) {
        console.warn(`[ActivityLog ${agentId}] Shared activity unreadable; using this replica's:`, err);
      }
    }
    const current = shared && (!local || shared.updatedAt >= local.updatedAt) ? shared : local;
    return { activity: current?.activity ?? "online", detail: current?.detail ?? "" };
  }

  /**
   * A subagent's rows, at their own time, under the agent's current status:
   * the agent's status, live dot and restart hint are not the subagent's.
   */
  private async persistExternalSubagentActivity(
    agentId: string,
    entries: TrajectoryEntry[],
    observedAtMs: number,
    dedupeKey: string,
  ): Promise<boolean> {
    try {
      const current = await this.liveActivityForLogRow(agentId);
      return await this.persistActivityEvent(agentId, current.activity, current.detail, entries, new Date(observedAtMs), dedupeKey);
    } catch (err) {
      console.warn(`[ActivityLog ${agentId}] Failed to persist subagent activity event:`, err);
      return false;
    }
  }

  /**
   * Record a hook row that lost to a newer live status, at its own time and
   * with all its entries (turn boundaries and tool outcomes included). Being
   * older than the latest row, it cannot become the restart hint.
   */
  private async persistBackdatedExternalHookRow(
    agentId: string,
    entries: readonly TrajectoryEntry[],
    occurredAtMs: number,
    dedupeKey: string | undefined,
  ): Promise<void> {
    if (entries.length === 0) return;
    const current = this.agentActivity.get(agentId);
    try {
      await this.persistActivityEvent(agentId, current?.activity ?? "online", current?.detail ?? "", [...entries], new Date(occurredAtMs), dedupeKey);
    } catch (err) {
      console.warn(`[ActivityLog ${agentId}] Failed to persist back-dated external hook row:`, err);
    }
  }

  private broadcastRaftAction(
    agentId: string,
    event: {
      title: string;
      text: string;
      producerFactId?: string;
      activity?: AgentActivity;
      activityDetail?: string;
      dedupeKey?: string;
    },
  ): ActivityBroadcastTraceResult {
    const current = this.agentActivity.get(agentId);
    const envelopeActivity = event.activity ?? current?.activity ?? "online";
    const envelopeDetail = event.activityDetail ?? current?.detail ?? "";
    const entries: TrajectoryEntry[] = [
      ...(event.activity && event.activityDetail
        ? [{
            kind: "status" as const,
            activity: event.activity,
            activityKind: event.activity,
            detail: event.activityDetail,
            detailKind: "slock_action" as const,
            ...(event.producerFactId ? { producerFactId: event.producerFactId } : {}),
          }]
        : []),
      {
        // Ordinary `slock_action` entries append durable workspace history only.
        // Callers with a real status transition must pass explicit activity
        // fields so reload recovery sees the same status as the live envelope.
        kind: "slock_action",
        title: event.title,
        text: event.text,
        ...(event.producerFactId ? { producerFactId: event.producerFactId } : {}),
      },
    ];
    // gamma-2 shadow: the two caller families are distinguishable and
    // classify differently (gamma-2.1, Kai calibration v3 §B split):
    // - explicit status transition (SMR-006 statusEntry family): an
    //   AUTHORIZED control command — class "control", kernel verdict
    //   replace/control_command_authority (authoritative writer of its own
    //   axis; never a downgrade — this family only writes working).
    // - history append (CLI action records, no activity fields): claims no
    //   new value — plain synthetic; preserve is the correct filing.
    this.emitActivityWriterShadowVerdict(agentId, {
      activity: envelopeActivity,
      detailKind: event.activity && event.activityDetail ? "slock_action" : current?.detailKind ?? "none",
      observationClass: event.activity && event.activityDetail ? "control" : "synthetic",
      site: "slock_action_status",
    });
    return this.broadcastActivity(
      agentId,
      envelopeActivity,
      envelopeDetail,
      event.activity && event.activityDetail ? "slock_action" : current?.detailKind ?? "none",
      entries,
      undefined,
      event.dedupeKey ? { dedupeKey: event.dedupeKey } : undefined,
    );
  }

  private formatActivityProducerField(value: string, maxLength: number): string {
    const singleLine = value.replace(/\s+/g, " ").trim();
    if (singleLine.length <= maxLength) return singleLine;
    return `${singleLine.slice(0, Math.max(0, maxLength - 1))}\u2026`;
  }

  private formatActivity(activity: AgentActivityKind, detail = ""): VisibleActivity {
    return { activity, activityDetail: detail };
  }

  /**
   * task #1116: refresh read-back must expose the typed detail kind and, for a
   * delivery_unconsumed snapshot, the daemon's carrier — otherwise a page load
   * would silently drop what the live socket frame showed.
   */
  private formatActivityFromSnapshot(snapshot: ActivitySnapshot): VisibleActivity {
    // Scoped to the delivery_unconsumed observation for now: the plain
    // {activity, activityDetail} shape is asserted verbatim by many callers and
    // tests, and only this kind has a typed carrier the web must not lose.
    // task #1123: a failed start keeps its typed carrier too; runtime_unavailable
    // without a carrier keeps the plain shape so untyped callers see no change.
    const carriesSpawnFailure = snapshot.detailKind === "runtime_unavailable" && snapshot.spawnFailure !== undefined;
    // Reconciler step 4b: so does an idle status showing the held notice.
    const carriesCredentialHold = snapshot.detailKind === "idle" && snapshot.credentialHold !== undefined;
    // #wg-rbac:#57: a runtime error / crash detail keeps its kind, so every
    // reader can project it per viewer even on a non-error activity.
    const carriesRuntimeErrorDetail = isRuntimeErrorDetailActivity({ activity: null, detailKind: snapshot.detailKind });
    if (
      !carriesRuntimeErrorDetail
      && snapshot.detailKind !== "delivery_unconsumed"
      && snapshot.detailKind !== "wake_crash_loop_blocked"
      && snapshot.detailKind !== "terminal_failure_paused"
      && !carriesSpawnFailure
      && !carriesCredentialHold
      && !snapshot.toolStuck
    ) {
      return this.formatActivity(snapshot.activity, snapshot.detail);
    }
    return {
      activity: snapshot.activity,
      activityDetail: snapshot.detail,
      activityDetailKind: snapshot.detailKind,
      ...(snapshot.deliveryConsumption ? { deliveryConsumption: snapshot.deliveryConsumption } : {}),
      ...(snapshot.wakeCrashLoop ? { wakeCrashLoop: snapshot.wakeCrashLoop } : {}),
      ...(snapshot.spawnFailure ? { spawnFailure: snapshot.spawnFailure } : {}),
      ...(snapshot.toolStuck ? { toolStuck: snapshot.toolStuck } : {}),
      ...(carriesCredentialHold ? { credentialHold: snapshot.credentialHold } : {}),
    };
  }

  /**
   * A start made real progress (see `applyWakeCrashLoopStartSucceeded`): its
   * owed catch-up reached the runtime, the failed-start streak ends, and a
   * self-retrying pause whose try this was lifts.
   */
  private async observeStartProgress(agentId: string, launchId: string): Promise<{ changed: boolean; unpaused: boolean }> {
    await this.wakeCrashLoopBreaker.confirmCatchupDelivered(agentId, launchId);
    const progress = await this.wakeCrashLoopBreaker.recordStartSucceeded(agentId, launchId);
    if (progress.unpaused) {
      this.clearPauseRetry(agentId);
      this.recordEvent("wake.block_lifted", { cause: "pause_retry_succeeded" });
    }
    return progress;
  }

  private readonly pauseRetryTimers = new Map<string, unknown>();

  /**
   * The pause-retry timer lives in this replica's memory only, so a restart,
   * a deploy or a machine moving to another replica loses it. The replica
   * that receives the machine's `ready` re-arms it for every agent there
   * still in a self-retrying pause, from the record's current retry time
   * (replacing any timer it still holds, which may be stale); a time already
   * past fires promptly. Two fires at the same instant start the agent once
   * because of the start path's own guards (the replica wake lock and
   * `startsInProgress`), not the breaker. The breaker's compare-and-set only
   * moves `pauseRetryAtMs` forward when a try starts, so a later re-arm or
   * fire finds nothing due. Best effort.
   */
  private async rearmPauseRetry(agentId: string): Promise<void> {
    try {
      const retryAtMs = await this.wakeCrashLoopBreaker.pauseRetryAtMs(agentId);
      // No clear on null: this read can race a pause committed meanwhile
      // (frames from one socket run concurrently), and a timer whose record
      // has no retry time already does nothing when it fires.
      if (retryAtMs === null) return;
      this.schedulePauseRetry(agentId, retryAtMs);
      this.recordEvent("wake.pause_retry.rearmed", { due: retryAtMs <= this.clock.now() });
    } catch (error) {
      console.warn(`[Agent ${agentId}] Re-arming the pause retry failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private clearPauseRetry(agentId: string): void {
    const timer = this.pauseRetryTimers.get(agentId);
    if (timer === undefined) return;
    this.pauseRetryTimers.delete(agentId);
    this.clock.clearTimeout(timer);
  }

  /**
   * The try of a self-retrying pause (see PAUSE_RETRY_BASE_MS), at
   * `retryAtMs`. Process-local and best effort, like the retry-once retry: if
   * this replica goes away first, the first message after that time is the
   * try instead. Each try arms the next one (cooldown doubled) in the
   * breaker, so the chain follows the breaker's time and ends when the pause
   * does or the time stops moving forward.
   */
  private schedulePauseRetry(agentId: string, retryAtMs: number): void {
    this.clearPauseRetry(agentId);
    const timer = this.scheduleUnrefOnClock(() => {
      this.pauseRetryTimers.delete(agentId);
      void (async () => {
        // A person, a config change or another replica's try may have moved on.
        const due = await this.wakeCrashLoopBreaker.pauseRetryAtMs(agentId);
        if (due === null) return;
        if (due > this.clock.now()) {
          this.schedulePauseRetry(agentId, due);
          return;
        }
        const result = await this.startAgent(agentId, { startCause: "start_failure_retry" });
        if (result.outcome === "dispatched") await recordAgentSystemRestart(agentId, new Date(this.clock.now()));
        this.recordEvent("wake.pause_retry", {
          outcome: result.outcome,
          ...(result.outcome === "skipped" ? { reason: result.reason } : {}),
        });
        const next = await this.wakeCrashLoopBreaker.pauseRetryAtMs(agentId);
        if (next !== null && next > due) this.schedulePauseRetry(agentId, next);
      })().catch((error: unknown) => console.warn(`[Agent ${agentId}] Retry of a paused agent did not dispatch: ${error instanceof Error ? error.message : String(error)}`));
    }, Math.max(0, retryAtMs - this.clock.now()) + START_FAILURE_RETRY_SLACK_MS);
    this.pauseRetryTimers.set(agentId, timer);
  }

  /**
   * A self-retrying pause's try hit something only a person can fix (a start
   * failure or a runtime error that needs the owner): no more tries by
   * itself, the pause now waits for a person with the new reason.
   */
  private recordPauseRetryEnded(
    agentId: string,
    input: { previousReason: string | null; reason: string; runtime: string | null; model: string | null },
  ): void {
    this.clearPauseRetry(agentId);
    this.recordEvent("wake.pause_retry.ended", {
      previous_reason: input.previousReason ?? undefined,
      reason: input.reason,
      runtime: input.runtime ?? undefined,
      model: input.model ?? undefined,
    });
    const cached = this.agentStateCache.get(agentId);
    this.recordLifecycleEvent({
      agentId,
      machineId: cached?.machineId ?? null,
      action: "wake",
      outcome: "suppressed",
      cause: "message",
      previousStatus: cached?.status ?? null,
      detail: "pause_retry_ended",
    });
    console.warn(
      `[Agent ${agentId}] Pause retry ended: the try needs the owner (${input.reason}, was ${input.previousReason ?? "unknown"}); `
      + "a manual start or a runtime config change lifts it",
    );
  }

  /**
   * Feed a daemon-reported start failure into the wake breaker (see
   * `applyWakeCrashLoopStartFailure`) and return the carrier to show: marked
   * `autoRestartPaused` while automatic wakes are blocked, so the owner sees
   * that only a model/key change or a restart brings the agent back. A
   * retry-once failure schedules the one retry here.
   */
  private async observeStartFailure(
    agentId: string,
    launchId: string | null,
    carrier: SpawnFailureActivityDiagnostic,
    where: { runtime: string; machineId: string; model: string | null },
  ): Promise<SpawnFailureActivityDiagnostic> {
    try {
      const nowMs = this.clock.now();
      const runtimeAbsent = isRuntimeAbsentStartFailure(carrier.reason, carrier.lookupReason);
      // Reconciler step 12: a runtime that kept failing after it started
      // (`runtime_repeated_failure`) pauses and retries by itself too, but
      // its owner is not told then: the start-timeout notice's copy is about
      // starts that never come up, and a provider outage would tell every
      // owner at once. The agent's page shows the pause. Once its cooldown
      // reaches the cap the owner is told, once (`pauseRetryCapNoticeDue`).
      const startTimeout = carrier.reason === "runtime_start_timeout";
      // The owner hears once per runtime and computer that the runtime is
      // missing there, and once per runtime and model that starts time out.
      // A self-retrying pause whose try fails for another reason is news too
      // (the first notice said Raft would retry by itself): once per reason.
      const noticeFingerprint = runtimeAbsent
        ? `runtime_not_found:${where.runtime}:${where.machineId}`
        : `${carrier.reason}:${where.runtime}:${where.model ?? ""}`;
      const result = await this.wakeCrashLoopBreaker.recordStartFailure(agentId, {
        launchId,
        reason: carrier.reason,
        ...(carrier.lookupReason ? { lookupReason: carrier.lookupReason } : {}),
        nowMs,
        noticeFingerprint,
        noticeOnBlock: runtimeAbsent || startTimeout,
      });
      this.recordEvent("wake.start_failure", {
        outcome: result.outcome,
        ...agentIdHashAttrs(agentId),
        reason: carrier.reason,
        start_failure_count: result.startFailureCount,
        blocked: result.blocked,
        launch_id_present: launchId !== null,
        // Why automatic wakes are paused, and for what: a reason shared by many
        // agents at once (a provider outage) shows up as one pause_reason.
        ...(result.outcome === "blocked" || result.outcome === "pause_retry_ended"
          ? { pause_reason: carrier.reason, runtime: where.runtime, model: where.model ?? undefined }
          : {}),
        ...(result.pauseRetryAtMs !== null ? { pause_retry_in_ms: Math.max(0, result.pauseRetryAtMs - nowMs) } : {}),
      });
      if (result.outcome === "blocked") {
        const cached = this.agentStateCache.get(agentId);
        this.recordLifecycleEvent({
          agentId,
          machineId: cached?.machineId ?? null,
          action: "wake",
          outcome: "suppressed",
          cause: "message",
          previousStatus: cached?.status ?? null,
          detail: "start_failure_needs_action",
        });
        console.warn(
          `[Agent ${agentId}] Automatic wakes paused: start failed (${carrier.reason}, ${result.startFailureCount} in a row); `
          + (result.pauseRetryAtMs !== null
            ? `tries again by itself at ${new Date(result.pauseRetryAtMs).toISOString()}; a manual start or a runtime config change lifts it now`
            : "a manual start or a runtime config change lifts it"),
        );
      }
      if (result.outcome === "pause_retry_ended") {
        this.recordPauseRetryEnded(agentId, { previousReason: result.previousPauseReason, reason: carrier.reason, runtime: where.runtime, model: where.model });
      }
      if (result.outcome === "retry_scheduled" && result.retryAfterMs !== null) {
        this.scheduleStartFailureRetry(agentId, result.retryAfterMs - nowMs);
      }
      // A pause that tries again by itself: arm its try (a failed try's report
      // finds the next one already armed in the breaker).
      if (result.pauseRetryAtMs !== null) this.schedulePauseRetry(agentId, result.pauseRetryAtMs);
      if (result.notify && startTimeout) {
        const notified = await this.postStartTimeoutPausedNotice(agentId, {
          runtime: where.runtime,
          model: where.model,
          failedStarts: result.startFailureCount,
          retryInMs: result.pauseRetryAtMs !== null ? Math.max(0, result.pauseRetryAtMs - nowMs) : null,
        });
        this.recordEvent("wake.start_timeout_paused.owner_notice", { outcome: notified ? "posted" : "no_owner", runtime: where.runtime });
        if (notified) await this.wakeCrashLoopBreaker.markActionRequiredNotified(agentId, noticeFingerprint);
      } else if (result.notify && runtimeAbsent) {
        const notified = await this.postRuntimeUnavailableNotice(agentId, where);
        this.recordEvent("wake.runtime_unavailable.owner_notice", { outcome: notified ? "posted" : "no_owner", runtime: where.runtime });
        // Only a posted notice counts as told: a failed post is retried on the next block.
        if (notified) await this.wakeCrashLoopBreaker.markActionRequiredNotified(agentId, noticeFingerprint);
      } else if (result.notify) {
        const notified = await this.postStartFailurePausedNotice(agentId, { runtime: where.runtime, reason: carrier.reason });
        this.recordEvent("wake.start_failure_paused.owner_notice", { outcome: notified ? "posted" : "no_owner", reason: carrier.reason });
        if (notified) await this.wakeCrashLoopBreaker.markActionRequiredNotified(agentId, noticeFingerprint);
      } else if (result.alreadyNotified) {
        // The owner was already told about this runtime and computer (or
        // model, or reason): say so, or the pause reads as a missing notice.
        const notice = startTimeout ? "start_timeout_paused" : runtimeAbsent ? "runtime_unavailable" : "start_failure_paused";
        this.recordEvent(`wake.${notice}.owner_notice`, {
          outcome: "already_notified",
          ...(notice === "start_failure_paused" ? { reason: carrier.reason } : { runtime: where.runtime }),
        });
      }
      if (result.pauseRetryCapNoticeDue) await this.notifyPauseRetryCapped(agentId, { runtime: where.runtime, reason: carrier.reason });
      if (!result.blocked) return carrier;
      // A transient failure of a self-retrying pause's try is just a failed
      // try: show the pause it stays in (its own copy says Raft tries again by
      // itself), not that reason's "fix it, then restart" copy. The daemon's
      // detail still says what happened.
      const pauseReason = PAUSE_RETRY_START_FAILURE_REASONS.find((reason) => reason === result.previousPauseReason);
      const shown: SpawnFailureActivityDiagnostic = result.pauseRetryAtMs !== null && pauseReason !== undefined && pauseReason !== carrier.reason
        ? { reason: pauseReason, autoRestartPaused: true }
        : { ...carrier, autoRestartPaused: true };
      // Reconciler step 12 follow-up: the next try's time is the server's own
      // (the daemon's carrier never brings one: the normalizer drops it), and
      // only for a pause that retries by itself.
      delete shown.pauseRetryAtMs;
      if (result.pauseRetryAtMs !== null && PAUSE_RETRY_START_FAILURE_REASONS.includes(shown.reason)) shown.pauseRetryAtMs = result.pauseRetryAtMs;
      return shown;
    } catch (error) {
      console.error(`[Agent ${agentId}] Failed to record a start failure:`, error);
      return carrier;
    }
  }

  /**
   * The current start's runtime stopped on an error only the owner can fix.
   * Retrying cannot help, so automatic wakes stop now (messages and reminders
   * wait as the owed catch-up) until a human start or a runtime config change;
   * the owner is told once per distinct error. Best effort: a failure here
   * leaves the agent waking as before, and is logged.
   */
  private async observeRuntimeActionRequired(
    agentId: string,
    input: { launchId: string | null; requiredAction: RuntimeErrorRequiredAction; fingerprint: string },
  ): Promise<void> {
    try {
      const result = await this.wakeCrashLoopBreaker.recordActionRequired(agentId, {
        launchId: input.launchId,
        reason: input.requiredAction,
        fingerprint: input.fingerprint,
        nowMs: this.clock.now(),
      });
      this.recordEvent("wake.runtime_action_required", {
        outcome: result.outcome,
        required_action: input.requiredAction,
        notify: result.notify,
        launch_id_present: input.launchId !== null,
      });
      if (result.outcome === "pause_retry_ended") {
        const cached = this.agentStateCache.get(agentId);
        this.recordPauseRetryEnded(agentId, { previousReason: result.previousPauseReason ?? null, reason: input.requiredAction, runtime: cached?.runtime ?? null, model: cached?.model ?? null });
      } else if (result.outcome !== "blocked") {
        return;
      }
      if (result.outcome === "blocked") {
        const cached = this.agentStateCache.get(agentId);
        this.recordLifecycleEvent({
          agentId,
          machineId: cached?.machineId ?? null,
          action: "wake",
          outcome: "suppressed",
          cause: "message",
          previousStatus: cached?.status ?? null,
          detail: "runtime_action_required",
        });
        console.warn(
          `[Agent ${agentId}] Automatic wakes paused: runtime error needs the owner (${input.requiredAction}); `
          + "a manual start or a runtime config change lifts it",
        );
      }
      if (!result.notify) return;
      const notified = await this.postRuntimeActionRequiredNotice(agentId, input.requiredAction);
      this.recordEvent("wake.runtime_action_required.owner_notice", { outcome: notified ? "posted" : "no_owner" });
      // Only a posted notice counts as told: a failed post is retried on the next occurrence.
      if (notified) await this.wakeCrashLoopBreaker.markActionRequiredNotified(agentId, input.fingerprint);
    } catch (error) {
      console.error(`[Agent ${agentId}] Failed to record a runtime error that needs the owner:`, error);
    }
  }

  private async forgetRuntimeActionRequiredNotice(agentId: string): Promise<void> {
    try {
      await this.wakeCrashLoopBreaker.forgetActionRequiredNotice(agentId);
    } catch (error) {
      console.error(`[Agent ${agentId}] Failed to reset the needs-action notice:`, error);
    }
  }

  protected async postRuntimeActionRequiredNotice(
    agentId: string,
    requiredAction: RuntimeErrorRequiredAction,
  ): Promise<boolean> {
    if (!this.io) return false;
    return postAgentActionRequiredNotice(this.io, this, { agentId, notice: { kind: "runtime_error", requiredAction } });
  }

  protected async postStartFailurePausedNotice(
    agentId: string,
    input: { runtime: string; reason: string },
  ): Promise<boolean> {
    if (!this.io) return false;
    return postAgentActionRequiredNotice(this.io, this, { agentId, notice: { kind: "start_failure_paused", ...input } });
  }

  /**
   * Reconciler step 12 follow-up: a `runtime_repeated_failure` pause's tries
   * reached the 8-hour cap and the last one failed too. Tell the owner once
   * (the breaker's `pauseRetryCapNotified`, recorded only after a posted
   * notice, so a failed post is tried again on the next failed try).
   */
  private async notifyPauseRetryCapped(agentId: string, input: { runtime: string; reason: string }): Promise<void> {
    try {
      const notified = await this.postPauseRetryCappedNotice(agentId, { ...input, retryEveryMs: PAUSE_RETRY_MAX_MS });
      this.recordEvent("wake.pause_retry_capped.owner_notice", { outcome: notified ? "posted" : "no_owner", reason: input.reason, runtime: input.runtime });
      if (notified) await this.wakeCrashLoopBreaker.markPauseRetryCapNotified(agentId);
    } catch (error) {
      // Best effort: the pause itself stands; the next failed try asks again.
      console.warn(`[Agent ${agentId}] Telling the owner the pause retries reached the cap failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  protected async postPauseRetryCappedNotice(
    agentId: string,
    input: { runtime: string; reason: string; retryEveryMs: number },
  ): Promise<boolean> {
    if (!this.io) return false;
    return postAgentActionRequiredNotice(this.io, this, { agentId, notice: { kind: "pause_retry_capped", ...input } });
  }

  protected async postStartTimeoutPausedNotice(
    agentId: string,
    input: { runtime: string; model: string | null; failedStarts: number; retryInMs: number | null },
  ): Promise<boolean> {
    if (!this.io) return false;
    return postAgentActionRequiredNotice(this.io, this, { agentId, notice: { kind: "runtime_start_timeout", ...input } });
  }

  protected async postRuntimeUnavailableNotice(
    agentId: string,
    where: { runtime: string; machineId: string },
  ): Promise<boolean> {
    if (!this.io) return false;
    return postAgentActionRequiredNotice(this.io, this, {
      agentId,
      notice: { kind: "runtime_unavailable", runtime: where.runtime, machineId: where.machineId },
    });
  }

  /**
   * The one automatic retry after a retry-once start failure. Process-local
   * and best effort: if this replica goes away first, the next message wakes
   * the agent instead (the hold has expired by then). The retry start carries
   * the unread catch-up the hold owed.
   */
  private scheduleStartFailureRetry(agentId: string, delayMs: number): void {
    this.scheduleUnrefOnClock(() => {
      void this.startAgent(agentId, { startCause: "start_failure_retry" }).then(
        async (result) => {
          if (result.outcome === "dispatched") await recordAgentSystemRestart(agentId, new Date(this.clock.now()));
          this.recordEvent("wake.start_failure_retry", {
            outcome: result.outcome,
            ...(result.outcome === "skipped" ? { reason: result.reason } : {}),
          });
        },
        (error: unknown) => console.warn(`[Agent ${agentId}] Retry after a failed start did not dispatch: ${error instanceof Error ? error.message : String(error)}`),
      );
    }, Math.max(0, delayMs) + START_FAILURE_RETRY_SLACK_MS);
  }

  /**
   * task #1221: the runtime configuration changed; lift a start-failure (or
   * crash-loop) block. RFC 071 §5 (F3): the terminal-failure breaker lifts
   * only when a runtime value actually differs (`runtimeValuesChanged`);
   * field presence alone is not a change.
   */
  async liftWakeBlockForConfigChange(agentId: string, options: { runtimeValuesChanged?: boolean; runtimeOrModelChanged?: boolean } = {}): Promise<void> {
    if (await this.wakeCrashLoopBreaker.liftForConfigChange(agentId)) {
      this.recordEvent("wake.block_lifted", { cause: "runtime_config_changed" });
    }
    if (options.runtimeValuesChanged === true) await this.liftTerminalBreaker(agentId, "runtime_config_changed");
    // #triage:#263: an error the old runtime or model reported (a usage limit
    // above all) says nothing about the new one; it stayed until that model
    // produced output or someone stopped the agent. Cleared like a manual stop
    // clears it: a BillingError stays (task #1351, the row decides).
    if (options.runtimeOrModelChanged === true && await this.clearLastRuntimeError(agentId)) {
      this.recordEvent("runtime_error_state.cleared", { reason: "runtime_or_model_changed" });
    }
  }

  /**
   * RFC 071 §5 E3 other than a human start: reset or a real runtime-config
   * change. Closed, generation+1, counts reset; `unexited` and needs-manual
   * stay. Best effort: a failed lift leaves the breaker as it was (the
   * conservative side) and is logged.
   */
  private async liftTerminalBreaker(agentId: string, cause: "human_reset" | "runtime_config_changed"): Promise<void> {
    // Dormant (RUNTIME_OUTCOME_ACK_ENABLED false): the breaker store is never touched.
    if (!this.runtimeOutcomeAckEnabled) return;
    try {
      await this.terminalFailureBreaker.lift(agentId, { cause, nowMs: this.clock.now() });
      this.recordEvent("terminal_breaker.lifted", { cause });
    } catch (error) {
      console.warn(`[Agent ${agentId}] terminal-failure breaker lift (${cause}) failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * RFC 071 §9: show the person why automatic wakes stopped, once per block,
   * as an offline activity with detailKind `terminal_failure_paused`. Paused:
   * until when, why, and that the next wake after it (or a manual start)
   * retries. Needs manual: why, and that only a manual start proceeds (never
   * "will retry"). Best effort: a failure to read is logged, nothing else.
   */
  private async projectTerminalBlock(agentId: string, options: { includeNeedsManual: boolean }): Promise<void> {
    if (!this.runtimeOutcomeAckEnabled) return;
    let view: TerminalBlockView | null;
    try {
      view = terminalBlockView(await this.terminalFailureBreaker.read(agentId, this.clock.now()), this.clock.now());
    } catch (error) {
      console.warn(`[Agent ${agentId}] terminal-failure breaker block not shown: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (view === null || (view.kind === "needs_manual" && !options.includeNeedsManual)) return;
    const key = view.kind === "paused" ? `paused:${view.blockedUntilMs}` : `needs_manual:${view.reason}`;
    if (this.projectedTerminalBlocks.get(agentId) === key) return;
    this.projectedTerminalBlocks.set(agentId, key);
    this.broadcastActivity(agentId, "offline", terminalBlockDetail(view), "terminal_failure_paused", []);
    this.recordEvent("terminal_breaker.block_shown", { agent_id: agentId, kind: view.kind, ...(view.kind === "needs_manual" ? { reason: view.reason } : { blocked_until_ms: view.blockedUntilMs }) });
  }

  /**
   * task #365: a wake refused while the spawn-error backoff held is retried by
   * nobody else (the daemon's refused outcome is final, and RFC 071 itself
   * only retries on the next wake). Each replica sweeps the agents of the
   * machines whose sockets it holds and starts those whose backoff, plus
   * their fixed per-agent jitter, has passed and that still have an unserved
   * wake demand (`isSpawnErrorRetryDue`). A person's Stop wins: a `stopped`
   * agent is skipped (and Stop cancels the demand). The start goes through
   * the normal gate and the combined claim, so two replicas that both see
   * the agent due produce one probe; the loser is refused
   * `terminal_failure_probe_in_flight`.
   */
  async sweepSpawnErrorRetries(): Promise<void> {
    if (!this.runtimeOutcomeAckEnabled || this.spawnErrorRetrySweepRunning) return;
    this.spawnErrorRetrySweepRunning = true;
    try {
      for (const machineId of [...this.machineConnections.keys()]) {
        const agents = await agentService.getAgentsForMachine(machineId);
        for (const agent of agents) {
          if (agent.status === "stopped") continue;
          const nowMs = this.clock.now();
          let due: boolean;
          try {
            due = isSpawnErrorRetryDue(await this.terminalFailureBreaker.read(agent.id, nowMs), { nowMs, jitterMs: spawnErrorRetryJitterMs(agent.id) });
          } catch (error) {
            console.warn(`[Agent ${agent.id}] spawn-error retry check failed: ${error instanceof Error ? error.message : String(error)}`);
            continue;
          }
          if (!due) continue;
          try {
            const result = await this.startAgentForRetry(agent.id);
            agentWakePauseTransitionsTotal.inc({ kind: result.outcome === "dispatched" ? "retry_dispatched" : "retry_refused" });
            this.recordEvent("terminal_breaker.spawn_error_retry", {
              agent_id: agent.id,
              outcome: result.outcome,
              ...(result.outcome === "skipped" ? { reason: result.reason } : {}),
            });
          } catch (error) {
            agentWakePauseTransitionsTotal.inc({ kind: "retry_error" });
            this.recordEvent("terminal_breaker.spawn_error_retry", { agent_id: agent.id, outcome: "error" });
            console.warn(`[Agent ${agent.id}] spawn-error retry start failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    } finally {
      this.spawnErrorRetrySweepRunning = false;
    }
  }

  /**
   * task #365: the daemon refused `launchId` because it was claimed against an
   * earlier connection (a frame resent after a reconnect, or one that arrived
   * late). The refusal is the receipt: the dispatch stops retrying here (it
   * would only be refused again), and the agent's status is left alone (a
   * current start may own it). The breaker already removed the launch's
   * pending entry and unclaimed its wake demand; if demand is left, it is
   * re-served once, now, as a fresh start: the normal gate and claim on this
   * replica's current connection, stamped with its epoch. A start whose
   * outcome is unknown is never repeated on a timeout: only this refusal
   * (proof that no process was created for that frame) leads here.
   */
  /**
   * The refused frame's pending dispatch lives on the replica that holds the
   * machine socket (a routed start is tracked by the receiving owner), which
   * is also where the daemon's refusal arrives.
   */
  private stopStaleDispatchRetries(agentId: string, launchId: string): void {
    for (const [startDispatchId, pending] of [...this.pendingAgentStartAcks.entries()]) {
      if (pending.msg.agentId === agentId && pending.msg.launchId === launchId) {
        this.terminalizePendingAgentStart(startDispatchId, "stale_dispatch");
      }
    }
  }

  private async reserveStaleDispatch(agentId: string, launchId: string): Promise<void> {
    let state: TerminalFailureBreakerState;
    try {
      state = await this.terminalFailureBreaker.read(agentId, this.clock.now());
    } catch (error) {
      console.warn(`[Agent ${agentId}] stale start re-serve skipped: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (state.wakeDemand === null || state.wakeDemand.claimedLaunchId !== null) return;
    try {
      const result = await this.startAgentForRetry(agentId);
      this.recordEvent("terminal_breaker.stale_dispatch_reserved", {
        agent_id: agentId,
        launch_id: launchId,
        outcome: result.outcome,
        ...(result.outcome === "skipped" ? { reason: result.reason } : {}),
      });
    } catch (error) {
      console.warn(`[Agent ${agentId}] stale start re-serve failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** RFC 071 §4.3 rule 4: a `ready` from a daemon instance. Best effort per agent (logged). */
  private async observeTerminalDaemonReady(agentId: string, daemonInstanceId: string): Promise<void> {
    if (!this.runtimeOutcomeAckEnabled) return;
    try {
      const wrote = await this.terminalFailureBreaker.recordDaemonReady(agentId, { daemonInstanceId, nowMs: this.clock.now() });
      if (wrote) this.recordEvent("terminal_breaker.daemon_ready", { agent_id: agentId, daemon_instance_id: daemonInstanceId });
    } catch (error) {
      console.warn(`[Agent ${agentId}] terminal-failure breaker ready not recorded: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * task #365: `{ connectionEpochId }` of the machine's socket on this
   * replica, while this server advertises `agent:start-spawn-error-v1` (which
   * rides on the ack switch); otherwise nothing, and `agent:start` is
   * unchanged.
   */
  private claimTimeConnectionEpoch(machineId: string | null): { connectionEpochId?: string } {
    if (!this.runtimeOutcomeAckEnabled || !machineId) return {};
    const epoch = this.machineConnections.get(machineId)?.connectionEpochId;
    return epoch ? { connectionEpochId: epoch } : {};
  }

  /**
   * RFC 071: what the terminal-failure breaker knows about the machine a
   * start goes to. `capability` is the daemon's `agent:runtime-outcome-v1`,
   * minus agents whose outcome storage it reports as unreliable, and only
   * while this server consumes outcome frames (`runtimeOutcomeAckEnabled`);
   * `unknown` when this replica does not hold the machine's socket.
   */
  private terminalStartContext(agentId: string, machineId: string | null): TerminalStartContext {
    const conn = machineId ? this.machineConnections.get(machineId) : undefined;
    if (!conn) return { capability: "unknown", daemonReportsOutcomes: false, daemonInstanceId: null };
    // Outcomes are observable only while this server also consumes (and acks) the frames.
    const daemonReportsOutcomes = this.runtimeOutcomeAckEnabled && conn.capabilities.has(DAEMON_CAPABILITY_RUNTIME_OUTCOME_V1);
    const capability = daemonReportsOutcomes && !(conn.runtimeOutcomeUnreliableAgents?.has(agentId) ?? false);
    return { capability, daemonReportsOutcomes, daemonInstanceId: conn.daemonInstanceId };
  }

  /**
   * Does this start go through the terminal claim? Every start to a machine
   * that reports outcomes for the agent (its pending entry must be written
   * before dispatch). A human start also when the daemon has an outbox but
   * reports the agent's storage unreliable (only a human start resolves it,
   * and the daemon needs `humanStart`), or when the record is protecting (the
   * takeover must be recorded, RFC X-4(b)). Otherwise, notably every start
   * to a daemon without `agent:runtime-outcome-v1` on a never-protected
   * record, nothing changes: no terminal write, no new agent:start field.
   */
  private async usesTerminalClaim(agentId: string, context: TerminalStartContext, control: TerminalStartControl): Promise<boolean> {
    // Dormant: no claim, no read — a start behaves exactly as before RFC 071.
    if (!this.runtimeOutcomeAckEnabled) return false;
    if (context.capability === true) return true;
    if (control !== "human_start") return false;
    if (context.daemonReportsOutcomes) return true;
    return isTerminalBreakerProtecting(await this.terminalFailureBreaker.read(agentId, this.clock.now()));
  }

  /**
   * RFC 071 §4.3 fast reject for an automatic start. It persists what a
   * refusal learned (needs-manual, the refused message's owed ceiling); the
   * claim decides. Store errors propagate: an automatic start that cannot
   * consult the breaker does not start (fail closed).
   * `unknown` capability (not this replica's machine): a protected record
   * refuses without writing anything; a never-protected one passes.
   */
  private async terminalStartGate(
    agentId: string,
    context: { capability: boolean | "unknown" },
    wakeMessage: AgentMessage | undefined,
    wakeDemand = false,
  ): Promise<TerminalWakeRefusal | null> {
    // Dormant: no gate and no store read, so a store failure cannot refuse a start.
    if (!this.runtimeOutcomeAckEnabled) return null;
    const nowMs = this.clock.now();
    if (context.capability === "unknown") {
      const state = await this.terminalFailureBreaker.read(agentId, nowMs);
      return isTerminalBreakerProtecting(state) ? "terminal_failure_needs_manual" : null;
    }
    const owed = wakeMessage && typeof wakeMessage.seq === "number" && wakeMessage.channel_id
      ? { conversationId: wakeMessage.channel_id, seq: wakeMessage.seq }
      : null;
    const decision = await this.terminalFailureBreaker.gate(agentId, { nowMs, capability: context.capability, wakeMessage: owed, wakeDemand });
    return decision === "pass" ? null : decision;
  }

  /**
   * RFC 071 §6: the open catch-up obligation a claimed start must carry, or
   * null. A read failure carries no batch: nothing is fulfilled, so the
   * obligation stays and the next start carries it (never fail open on it).
   */
  private async readTerminalCatchupObligation(agentId: string): Promise<CatchupObligation | null> {
    if (!this.runtimeOutcomeAckEnabled) return null;
    try {
      return (await this.terminalFailureBreaker.read(agentId, this.clock.now())).catchupObligation;
    } catch (error) {
      console.warn(`[Agent ${agentId}] terminal-failure breaker obligation not read; this start carries no batch: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * RFC 071 §6: record what this start's catch-up build learned, in one CAS:
   * owed conversations whose read cursor passed their ceiling are settled
   * (recorded on the batch as settled-by-cursor, not coverage; the obligation
   * may become null without an echo); then, if anything is still owed and the
   * start renders rows (`rendered` non-null), the batch (contiguous-prefix
   * coverage; a folded wake row is out of prefix) becomes the pending batch of
   * the claimed launch and its id is returned for `agent:start`. Null when no
   * batch was attached (nothing left owed, no rows, another launch claimed,
   * store error): the start then carries no id.
   */
  private async recordTerminalCatchupBuild(
    agentId: string,
    launchId: string,
    obligation: CatchupObligation,
    input: NonNullable<messageService.AgentResumeCatchupResult["obligationBatch"]>,
    rendered: AgentMessage[] | null,
    foldedWakeAppended: boolean,
  ): Promise<string | null> {
    const { owedReadCursors, ...buildInput } = input;
    const batch = rendered === null ? null : buildCatchupBatch(obligation, {
      ...buildInput,
      batchId: crypto.randomUUID(),
      launchId,
      builtAtMs: this.clock.now(),
      // Every row the daemon renders, in order: its echo reports this count.
      rendered: rendered.map((message, index) => ({
        // Diagnostics only; a live wake row always has an id.
        id: message.message_id ?? "",
        conversationId: message.channel_id,
        // A folded wake without a seq can never extend coverage (out of prefix).
        seq: typeof message.seq === "number" ? message.seq : 0,
        appendedOutOfOrder: foldedWakeAppended && index === rendered.length - 1,
      })),
    });
    let recorded: Awaited<ReturnType<TerminalFailureBreaker["recordCatchupBuild"]>> = { attached: false, settled: [], obligationCleared: false };
    try {
      recorded = await this.terminalFailureBreaker.recordCatchupBuild(agentId, this.clock.now(), { readCursors: owedReadCursors, batch });
    } catch (error) {
      console.warn(`[Agent ${agentId}] terminal-failure breaker batch not recorded; this start carries no batch: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.recordEvent("terminal_breaker.catchup_batch", {
      agent_id: agentId,
      batch_id: batch?.batchId ?? null,
      launch_id: launchId,
      attached: recorded.attached,
      settled_by_cursor: recorded.settled.length,
      obligation_fulfilled: recorded.obligationCleared,
      message_count: batch?.messages.length ?? 0,
      covered_conversations: batch?.coverage.length ?? 0,
      truncated_conversations: batch?.coverage.filter((entry) => entry.truncated).length ?? 0,
      candidate_cap_hit: batch?.candidateCapHit ?? false,
    });
    return recorded.attached && batch ? batch.batchId : null;
  }

  /** RFC 071 §4.3 step 3: the one claim over both breaker keys. */
  private claimTerminalStart(
    agentId: string,
    input: {
      launchId: string | undefined;
      sessionId: string | null;
      context: TerminalStartContext;
      control: TerminalStartControl;
      human: boolean;
      wakeDemand: boolean;
    },
  ): Promise<CombinedClaimResult> {
    return this.terminalFailureBreaker.claimStart(agentId, {
      // A start without a launchId still claims (a human takeover must be
      // recorded); its terminal launch can never be bound by a frame.
      launchId: input.launchId ?? `unbound:${crypto.randomUUID()}`,
      crashLoopLaunchId: input.launchId ?? null,
      nowMs: this.clock.now(),
      resumedSessionId: input.sessionId,
      daemonInstanceId: input.context.daemonInstanceId,
      capability: input.context.capability === true,
      control: input.control,
      human: input.human,
      wakeDemand: input.wakeDemand,
    });
  }

  private recordTerminalWakeSuppressed(
    agentId: string,
    machineId: string | null,
    startCause: AgentLifecycleCause,
    previousStatus: AgentStatus | null,
    refusal: TerminalWakeRefusal,
    context: { capability: boolean | "unknown" },
  ): void {
    this.recordLifecycleEvent({
      agentId,
      machineId,
      action: "wake",
      outcome: "suppressed",
      cause: startCause,
      previousStatus,
      detail: refusal,
    });
    this.recordEvent("terminal_breaker.wake_suppressed", {
      start_cause: startCause,
      reason: refusal,
      capability: String(context.capability),
    });
  }

  /**
   * task #1119: feed one exit into the breaker. When this exit crosses the
   * threshold, project the block once as a typed offline activity (counts,
   * classes, ids, times only). No stop/start/retry is issued here.
   */
  private async observeWakeCrashLoopExit(agentId: string, exit: WakeCrashLoopExit, span?: ActiveSpan | null): Promise<void> {
    const observation = await this.wakeCrashLoopBreaker.recordExit(agentId, exit, this.clock.now());
    span?.addEvent("wake_crash_loop.exit_observed", {
      counted: observation.counted,
      rejected: observation.rejected ?? "none",
      blocked_now: observation.blockedNow,
      early_exit_count: observation.snapshot.earlyExitCount,
      episode: observation.snapshot.episode,
      exit_kind: exit.kind,
      evidence_present: exit.evidence !== null,
      launch_id_present: exit.launchId !== null,
    });
    if (!observation.blockedNow) return;
    const cached = this.agentStateCache.get(agentId);
    this.recordLifecycleEvent({
      agentId,
      machineId: cached?.machineId ?? null,
      action: "wake",
      outcome: "suppressed",
      cause: "message",
      previousStatus: cached?.status ?? null,
      detail: "wake_crash_loop_armed",
    });
    console.warn(
      `[Agent ${agentId}] Automatic wakes paused: ${observation.snapshot.earlyExitCount} early exits in a row `
      + `(episode ${observation.snapshot.episode}, last ${exit.kind}${exit.evidence?.signal ? ` ${exit.evidence.signal}` : ""}); a manual start lifts it`,
    );
    this.pendingWakeCrashLoop.set(agentId, observation.snapshot);
    this.broadcastActivity(
      agentId,
      "offline",
      `Automatic wake paused after ${observation.snapshot.earlyExitCount} early exits`,
      "wake_crash_loop_blocked",
      [],
      undefined,
      { ...(observation.snapshot.lastLaunchId ? { launchId: observation.snapshot.lastLaunchId } : {}) },
    );
    // Tell the owner once per trip: `blockedNow` is true only on the exit
    // that moved the breaker to blocked (one compare-and-set winner across
    // replicas); later exits while blocked are rejected as already_blocked,
    // and only a reset (human start, manual stop) lets it trip again.
    void this.noticeAutomaticWakePaused(agentId, observation.snapshot.earlyExitCount);
  }

  private async noticeAutomaticWakePaused(agentId: string, earlyExits: number): Promise<void> {
    try {
      const outcome = await this.postAutomaticWakePausedNotice(agentId, { earlyExits });
      this.recordEvent("wake_crash_loop.owner_notice", { outcome });
    } catch (error) {
      console.error(`[Agent ${agentId}] Failed to tell the owner that automatic wakes are paused:`, error);
    }
  }

  protected async postAutomaticWakePausedNotice(agentId: string, input: { earlyExits: number }): Promise<"posted" | "no_owner" | "no_socket_server"> {
    if (!this.io) return "no_socket_server";
    return (await postAutomaticWakePausedNotice(this.io, this, { agentId, earlyExits: input.earlyExits })) ? "posted" : "no_owner";
  }

  private formatRuntimeErrorActivity(error: AgentRuntimeErrorState): VisibleActivity {
    // #wg-rbac:#57: a row stored before ingest scrubbing is scrubbed on read.
    return this.formatActivity("error", boundedRuntimeErrorDetail(error.message));
  }

  private async rememberRuntimeError(agentId: string, error: AgentRuntimeErrorState): Promise<boolean> {
    // Redis is an authority only for a value the durable row accepted. Publish
    // nothing (including the process-local shadow) when persistence is a no-op
    // or throws, otherwise another replica could observe Redis-only truth.
    // `durable` is what the row holds now: `error`, or the same error already
    // stored a moment ago (crash loop; see setAgentLastRuntimeError). Cache and
    // Redis carry that, so they never differ from the row.
    const durable = await this.persistAgentLastRuntimeError(agentId, error);
    if (!durable) return false;
    if (error.errorClass === "BillingError" && durable.occurrenceId !== error.occurrenceId) {
      // task #1351: the stored BillingError is not provably older (a replay,
      // or a late 402 from another launch): it keeps its evidence.
      this.recordEvent("runtime_error_state.write_refused", { reason: "billing_not_newer", stored_class: durable.errorClass ?? "untyped" });
    }

    this.updateCache(agentId, { lastRuntimeError: durable });
    // gamma-2 shadow: the error state is daemon-reported ground truth
    // (observed); classification note filed for Kai's calibration table.
    this.emitActivityWriterShadowVerdict(agentId, {
      activity: "error",
      detailKind: "runtime_error",
      observationClass: "observed",
      site: "runtime_error",
    });
    const now = this.clock.now();
    // The row's error, not the incoming one: a refused BillingError write
    // (task #1351) must not show its own text over the stored occurrence.
    const errorObservedAtMs = Date.parse(durable.at);
    this.writeAgentActivitySnapshot(agentId, "error", boundedRuntimeErrorDetail(durable.message), "runtime_error", now, {
      observedAtMs: Number.isFinite(errorObservedAtMs) ? errorObservedAtMs : now,
      arbitration: {
        observationClass: "observed",
        signalSite: "runtime_error",
      },
    });
    await this.mirrorAgentRuntimeError(agentId, durable);
    return true;
  }

  /**
   * Clear any stored runtime error except a BillingError, as the database
   * decides (agentService.clearAgentLastRuntimeErrorUnlessBilling). Only a
   * clear that removed a row's error updates the cache, the activity, Redis and
   * open pages; when the row kept its error (a BillingError), this replica's
   * cache takes what the row holds instead.
   */
  private async clearLastRuntimeError(agentId: string): Promise<boolean> {
    const cachedBefore = this.agentStateCache.get(agentId);
    // A Redis tombstone must never outrun the durable clear. Keeping all local
    // projections unchanged on rejection also prevents this replica from
    // claiming recovery that persistence did not accept.
    const result = await this.clearPersistedAgentLastRuntimeError(agentId);
    if (!result) return false;
    if (!result.cleared) {
      await this.syncCachedRuntimeError(agentId, result.current);
      return false;
    }
    await this.applyRuntimeErrorCleared(agentId, cachedBefore);
    return true;
  }

  /** After the row's error was removed: the cache, the error->online activity, Redis, then open pages. */
  private async applyRuntimeErrorCleared(agentId: string, cachedBefore: CachedAgentState | undefined): Promise<void> {
    this.updateCache(agentId, { lastRuntimeError: null });
    const current = this.agentActivity.get(agentId);
    if (current?.activity === "error") {
      // gamma-2 shadow: the error->online restore is a server-derived write
      // (the recovery observation itself flows through ingest separately).
      this.emitActivityWriterShadowVerdict(agentId, {
        activity: "online",
        detailKind: "none",
        observationClass: "synthetic",
        site: "runtime_error",
      });
      this.writeAgentActivitySnapshot(agentId, "online", "", "none", this.clock.now(), {
        arbitration: {
          observationClass: "synthetic",
          signalSite: "runtime_error",
        },
      });
    }
    await this.mirrorAgentRuntimeError(agentId, null);
    await this.broadcastRuntimeErrorCleared(agentId, cachedBefore);
  }

  /** task #1351: a stale replica cache takes the stored error the database just reported. */
  private async syncCachedRuntimeError(agentId: string, durable: AgentRuntimeErrorState | null): Promise<void> {
    const cached = this.agentStateCache.get(agentId);
    if (!cached || JSON.stringify(cached.lastRuntimeError ?? null) === JSON.stringify(durable)) return;
    this.updateCache(agentId, { lastRuntimeError: durable });
    this.recordEvent("runtime_error_state.cache_resynced", { present: durable !== null, error_class: durable?.errorClass ?? "none" });
    await this.mirrorAgentRuntimeError(agentId, durable);
  }

  /**
   * task #1351: a start armed `launchId`. If the database holds a BillingError
   * now, that launch came after it: stamp it on that record (R2 of
   * agentService.clearAgentBillingErrorOnRecovery). Best effort: without the stamp the error is
   * only kept longer.
   */
  private async stampRuntimeErrorRecoveryLaunch(agentId: string, launchId: string | undefined): Promise<void> {
    if (launchId === undefined) return;
    try {
      const stamped = await this.stampPersistedRuntimeErrorRecoveryLaunch(agentId, launchId);
      if (stamped) {
        this.updateCache(agentId, { lastRuntimeError: stamped });
        this.recordEvent("runtime_error_state.recovery_launch_stamped", { error_class: stamped.errorClass ?? "untyped" });
      }
    } catch (err) {
      console.warn(
        `[Orchestrator] Failed to stamp the recovery launch on agent ${agentId}'s runtime error:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * task #1351: open agent pages show the stored error (the billing banner and
   * the other typed banners) from the agent record; tell them to re-read it
   * (`agent:updated`, as a profile change does) once its clear is durable.
   */
  private async broadcastRuntimeErrorCleared(agentId: string, cached: CachedAgentState | undefined): Promise<void> {
    if (!this.io) return;
    try {
      const agent = cached ?? await this.getCachedAgent(agentId);
      if (!agent) return;
      this.io.to(agentEventRoom(agent.serverId, agent.assistantOwnerUserId)).emit("agent:updated", { agentId });
    } catch (err) {
      console.warn(
        `[Orchestrator] Failed to announce runtime error clear for agent ${agentId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  private async mirrorAgentRuntimeError(
    agentId: string,
    error: AgentRuntimeErrorState | null,
  ): Promise<void> {
    if (!this.replicaStateStore.isAvailable()) return;
    try {
      // Unlike the lossy activity projection mirror, this write is awaited:
      // getActivity treats the Redis record as cross-replica authority.
      await this.replicaStateStore.setAgentRuntimeError(agentId, error);
    } catch (err) {
      // Redis degradation must not suppress the durable DB write. Readers that
      // cannot verify Redis authority re-source from persistence and never use
      // their process-local shadow.
      console.warn(
        `[Orchestrator] Failed to mirror runtime error for agent ${agentId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  private buildRuntimeErrorState(input: {
    detail: string;
    launchId?: string;
    atMs?: number;
    /** #688(c): the normalized typed diagnostic that established this state, if any. */
    typed?: RuntimeErrorActivityDiagnostic | null;
    /** task #1351: the setting frame's daemon process and sequence (kept for a BillingError). */
    daemonInstanceId?: string;
    clientSeq?: number;
  }): AgentRuntimeErrorState {
    const typed = input.typed ? {
      errorClass: input.typed.errorClass,
      errorReason: input.typed.errorReason,
      fingerprint: input.typed.fingerprint,
      reasonProvenance: input.typed.reasonProvenance,
      // #proj-raft-computer:#48: what the owner must do, so the web can say it.
      ...(input.typed.requiredAction ? { requiredAction: input.typed.requiredAction } : {}),
    } : {};
    return {
      message: boundedRuntimeErrorDetail(input.detail) || GENERIC_RUNTIME_ERROR_MESSAGE,
      at: new Date(input.atMs ?? this.clock.now()).toISOString(),
      ...(input.launchId !== undefined ? { launchId: input.launchId } : {}),
      actionRequired: true,
      ...typed,
      // task #1351: a BillingError is cleared only by proof against its own
      // occurrence and set-frame evidence; other classes keep their shape.
      ...(input.typed?.errorClass === "BillingError" ? {
        occurrenceId: crypto.randomUUID(),
        ...(typeof input.daemonInstanceId === "string" ? { daemonInstanceId: input.daemonInstanceId } : {}),
        // Compared in SQL as bigint: only a safe integer is evidence.
        ...(Number.isSafeInteger(input.clientSeq) ? { clientSeq: input.clientSeq } : {}),
      } : {}),
    };
  }

  private isStartingActivitySnapshot(snapshot: ActivitySnapshot & { detailKind?: string | null }): boolean {
    if (snapshot.activity !== "working") return false;
    if (snapshot.detailKind === "starting" || snapshot.detailKind === "runtime_starting") return true;
    return snapshot.detail === "Starting…";
  }

  protected maybeResolveStartingActivity(agentId: string, span?: ActiveSpan | null) {
    const current = this.agentActivity.get(agentId);
    if (!current) {
      span?.addEvent("starting_activity.resolve", { outcome: "skip", reason: "no_current_activity" });
      return;
    }
    if (current.activity !== "working") {
      span?.addEvent("starting_activity.resolve", { outcome: "skip", reason: "not_working", current_activity: current.activity });
      return;
    }
    if (!this.isStartingActivitySnapshot(current)) {
      span?.addEvent("starting_activity.resolve", { outcome: "skip", reason: "not_starting_detail", current_detail_kind: current.detailKind });
      return;
    }
    span?.addEvent("starting_activity.resolve", { outcome: "resolved", reason: "starting_activity_snapshot" });
    // gamma-2 shadow: g1 Phase A pinned this resolve racing the first real
    // working of a launch and stomping it with online (arrival-order LWW).
    // The kernel refuses that authority (synthetic vs fresh observed).
    this.emitActivityWriterShadowVerdict(agentId, {
      activity: "online",
      detailKind: "none",
      observationClass: "synthetic",
      site: "starting_resolve",
    });
    this.broadcastActivity(agentId, "online", "", "none", [{ kind: "status", activity: "online", activityKind: "online", detail: "", detailKind: "none" }]);
  }

  private isFreshnessHoldActivitySnapshot(snapshot: ActivitySnapshot & { detailKind?: string | null }): boolean {
    return snapshot.activity === "working"
      && snapshot.detailKind === "slock_action"
      && snapshot.detail === "Send held by freshness check";
  }

  protected terminalizeFreshnessHold(
    agentId: string,
    reason: "freshness_hold_terminalized",
    span?: ActiveSpan | null,
  ) {
    const producerFactId = `lifecycle_plan:${reason}`;
    const current = this.agentActivity.get(agentId);
    if (!current) {
      span?.addEvent("freshness_hold.terminalize", { outcome: "skip", reason: "no_current_activity" });
      return;
    }
    if (!this.isFreshnessHoldActivitySnapshot(current)) {
      span?.addEvent("freshness_hold.terminalize", {
        outcome: "skip",
        reason: "not_freshness_hold",
        current_activity: current.activity,
        current_detail_kind: current.detailKind,
      });
      return;
    }
    span?.addEvent("freshness_hold.terminalize", { outcome: "resolved", reason });
    this.emitActivityWriterShadowVerdict(agentId, {
      activity: "online",
      detailKind: "idle",
      observationClass: "control",
      site: "lifecycle_plan",
    });
    this.broadcastActivity(
      agentId,
      "online",
      "",
      "idle",
      [{ kind: "status", activity: "online", activityKind: "online", detail: "", detailKind: "idle", producerFactId }],
      undefined,
      {
        producerFactId,
        arbitration: {
          observationClass: "control",
          signalSite: "lifecycle_plan",
        },
      },
    );
  }

  private isFreshBusyActivity(snapshot: ActivitySnapshot | PersistedAgentActivityHint): boolean {
    if (!this.isTransientActivity(snapshot.activity)) return false;
    if (snapshot.activity === "working" && (snapshot.detailKind === "starting" || snapshot.detailKind === "runtime_starting")) return false;
    return this.getActivityAgeSec(snapshot) <= AgentOrchestrator.ACTIVITY_STALE_SEC;
  }

  private async shouldPreserveBusyActivity(agentId: string): Promise<boolean> {
    const current = this.agentActivity.get(agentId);
    if (current && this.isFreshBusyActivity(current)) return true;

    const persisted = await this.loadLatestPersistedActivityHint(agentId);
    return Boolean(persisted && this.isFreshBusyActivity(persisted));
  }

  private isDurableRecoveryActivity(activity: string): boolean {
    return activity === "offline" || activity === "error";
  }

  private static READY_ONLINE_DEDUP_MS = 1000;

  private async broadcastReadyOnline(agentId: string, span?: ActiveSpan | null) {
    const now = this.clock.now();
    const lastBroadcast = this.lastReadyOnlineBroadcastAt.get(agentId) ?? 0;
    if (now - lastBroadcast < AgentOrchestrator.READY_ONLINE_DEDUP_MS) {
      span?.addEvent("ready_online.resolve", { agent_id: agentId, outcome: "skip", reason: "dedup_window" });
      return;
    }
    this.lastReadyOnlineBroadcastAt.set(agentId, now);

    const current = this.agentActivity.get(agentId);
    if (current && this.isFreshBusyActivity(current)) {
      span?.addEvent("ready_online.resolve", { agent_id: agentId, outcome: "skip", reason: "fresh_busy_cached", cached_activity: current.activity });
      return;
    }

    const persisted = await this.loadLatestPersistedActivityHint(agentId);
    if (persisted && this.isFreshBusyActivity(persisted)) {
      span?.addEvent("ready_online.resolve", { agent_id: agentId, outcome: "skip", reason: "fresh_busy_persisted", persisted_activity: persisted.activity });
      return;
    }

    const agent = await this.getCachedAgent(agentId);
    if (agent?.lastRuntimeError) {
      span?.addEvent("ready_online.resolve", { agent_id: agentId, outcome: "skip", reason: "runtime_error_state" });
      return;
    }

    const previous = current ?? persisted;
    const hasDurableRecovery = Boolean(previous && this.isDurableRecoveryActivity(previous.activity));
    const entries: TrajectoryEntry[] | undefined =
      hasDurableRecovery
        ? [{ kind: "status", activity: "online", activityKind: "online", detail: "", detailKind: "none" }]
        : undefined;

    span?.addEvent("ready_online.resolve", {
      agent_id: agentId,
      outcome: "broadcast",
      previous_activity: previous?.activity ?? "none",
      has_trajectory_entry: hasDurableRecovery,
    });
    // gamma-2 shadow: machine-ready reconcile synthesizing an agent-axis
    // online claim (g1 saw it fire twice on one daemon reconnect).
    this.emitActivityWriterShadowVerdict(agentId, {
      activity: "online",
      detailKind: "none",
      observationClass: "synthetic",
      site: "ready_online",
    });
    this.broadcastActivity(agentId, "online", "", "none", entries);
  }

  private async resolveLastRuntimeErrorActivity(
    agentId: string,
    agent: CachedAgentState | null,
    loadAuthoritativeAgent: () => Promise<CachedAgentState | null> = () => this.getAuthoritativeAgentForDelivery(agentId),
    prefetched?: ActivityReadPrefetch,
  ): Promise<{
    agent: CachedAgentState | null;
    activity: VisibleActivity | null;
    source: "runtime-error-l1" | "runtime-error-redis" | "runtime-error-persisted" | null;
  }> {
    if (agent?.status === "stopped") {
      return { agent, activity: null, source: null };
    }

    if (this.replicaStateStore.isAvailable()) {
      try {
        const mirror = await this.readAgentRuntimeErrorForActivity(agentId, prefetched);
        if (mirror) {
          const localError = agent?.lastRuntimeError ?? null;
          const localMatches = fingerprintAgentRuntimeError(localError) === mirror.fingerprint
            && localError?.actionRequired === mirror.error?.actionRequired;
          if (!localMatches) {
            this.updateCache(agentId, { lastRuntimeError: mirror.error });
            if (agent) agent.lastRuntimeError = mirror.error;
          }
          const error = localMatches ? localError : mirror.error;
          return {
            agent,
            activity: error ? this.formatRuntimeErrorActivity(error) : null,
            source: error ? (localMatches ? "runtime-error-l1" : "runtime-error-redis") : null,
          };
        }

        // A missing mirror is a rollout/expiry cache miss, not authority for a
        // process-local value. Re-source from DB once and seed an explicit error
        // or clear record so subsequent replica reads converge without a DB hit.
        const freshAgent = await loadAuthoritativeAgent();
        if (freshAgent) {
          await this.mirrorAgentRuntimeError(agentId, freshAgent.lastRuntimeError);
        }
        return {
          agent: freshAgent,
          activity: freshAgent?.lastRuntimeError
            ? this.formatRuntimeErrorActivity(freshAgent.lastRuntimeError)
            : null,
          source: freshAgent?.lastRuntimeError ? "runtime-error-persisted" : null,
        };
      } catch (err) {
        // Treat an unreachable Redis command exactly like isAvailable=false.
        // The durable read below is authoritative; local memory is never used.
        console.warn(
          `[Orchestrator] Failed to read runtime error mirror for agent ${agentId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    const freshAgent = await loadAuthoritativeAgent();
    return {
      agent: freshAgent,
      activity: freshAgent?.lastRuntimeError
        ? this.formatRuntimeErrorActivity(freshAgent.lastRuntimeError)
        : null,
      source: freshAgent?.lastRuntimeError ? "runtime-error-persisted" : null,
    };
  }

  private getActivityObservedAtMs(snapshot: ActivityClockSnapshot): number {
    return snapshot.observedAtMs ?? snapshot.updatedAt;
  }

  private getActivityAgeSec(snapshot: ActivityClockSnapshot): number {
    return (this.clock.now() - this.getActivityObservedAtMs(snapshot)) / 1000;
  }

  private getWeakOfflineSource(
    input: MachineReachabilityPlanInput,
    reachability: MachineReachability,
  ): WeakOfflineSource | null {
    if (reachability !== "offline") return null;
    if (!input.replicaStateAvailable) return "replica_state_unavailable";
    if (input.ownerReplica === REPLICA_ID && !input.hasLocalMachine) {
      return "self_owner_without_local_connection";
    }
    if (input.hasMachineId && !input.ownerReplica) return "owner_missing";
    return null;
  }

  private getWeakOfflineCompetingFact(
    snapshot: ActivitySnapshot | PersistedAgentActivityHint,
    source: ActivityHintSource | "persisted",
  ): WeakOfflineCompetingFact | null {
    if (!this.isFreshBusyActivity(snapshot)) return null;
    if (source === "persisted") return "persisted_busy_activity";
    if (source === "redis" && "observedAtMs" in snapshot && snapshot.observedAtMs !== undefined) {
      return "redis_busy_activity";
    }
    return null;
  }

  private getSuppressibleWeakOfflineSource(
    agent: CachedAgentState | null,
    reachabilityInput: MachineReachabilityPlanInput,
    reachability: MachineReachability,
  ): WeakOfflineSource | null {
    if (!agent || agent.status !== "active") return null;
    const weakSource = this.getWeakOfflineSource(reachabilityInput, reachability);
    return weakSource === "owner_missing" ? weakSource : null;
  }

  private normalizeStaleTransientActivity(
    agentId: string,
    snapshot: ActivitySnapshot,
    source: ActivityHintSource,
  ): VisibleActivity | null {
    const action = planStaleTransientNormalizationAction({
      isTransient: this.isTransientActivity(snapshot.activity),
      ageSec: this.getActivityAgeSec(snapshot),
      staleAfterSec: AgentOrchestrator.ACTIVITY_STALE_SEC,
    });
    return this.applyStaleTransientNormalizationAction({
      action,
      agentId,
      source,
      now: this.clock.now(),
    });
  }

  protected applyStaleTransientNormalizationAction(
    context: StaleTransientNormalizationApplyContext,
  ): VisibleActivity | null {
    if (context.action === "keep-current") {
      return null;
    }

    if (context.source === "local-cache") {
      const serverId = this.agentStateCache.get(context.agentId)?.serverId ?? "unknown";
      const current = this.agentActivity.get(context.agentId);
      this.recordEvent("server.agent.synthetic_repair.apply", {
        agent_id: context.agentId,
        server_id: serverId,
        synthetic_repair: true,
        repair_kind: "transient_normalization",
        source: "scheduler",
        authority: "scheduler_repair",
        previous_activity: current?.activity ?? "none",
        candidate_activity: "online",
        served_activity: "online",
        projection_outcome: "served_ephemeral",
        outcome: "served_ephemeral",
        reason: "synthetic_no_authority",
        advances_observed_clock: "none",
      });
      // Record the rejected online candidate, then serve online only as an
      // ephemeral read view. No map, persistence, broadcast, or clock write.
      this.emitSyntheticRepairShadowVerdict(context.agentId, context.now);
    }
    return this.formatActivity("online");
  }

  private async getMachineReachability(agent: CachedAgentState | null, prefetched?: ActivityReadPrefetch): Promise<MachineReachability> {
    return planMachineReachability(await this.loadMachineReachabilityPlanInput({ agent, prefetched }));
  }

  protected async loadMachineReachabilityPlanInput(
    context: MachineReachabilityInputContext,
  ): Promise<MachineReachabilityPlanInput> {
    const machineId = context.agent?.machineId ?? null;
    const replicaStateAvailable = this.replicaStateStore.isAvailable();
    const hasLocalMachine = Boolean(machineId && this.hasMachineLocally(machineId));
    const ownerReplica = machineId && replicaStateAvailable && !hasLocalMachine
      ? await this.readMachineReplicaOwnerForActivity(machineId, context.prefetched)
      : null;

    return {
      hasMachineId: Boolean(machineId),
      hasLocalMachine,
      replicaStateAvailable,
      ownerReplica,
      isExternalRuntime: isExternalAgentRuntime(context.agent?.runtime),
    };
  }

  private shouldTrustRecoveredOfflineHint(
    agent: CachedAgentState | null,
    snapshot: ActivitySnapshot,
    reachability: MachineReachability,
  ): boolean {
    return snapshot.activity === "offline"
      && agent?.status === "active"
      && reachability !== "offline"
      && reachability !== "none";
  }

  private async resolveActivityHint(
    agentId: string,
    agent: CachedAgentState | null,
    snapshot: ActivitySnapshot,
    source: ActivityHintSource,
    span: ActiveSpan,
    prefetched?: ActivityReadPrefetch,
  ): Promise<VisibleActivity | null> {
    span.addEvent("activity.hint.seen", {
      source,
      activity: snapshot.activity,
    });

    const planInput = await this.loadActivityHintResolutionPlanInput({
      agent,
      snapshot,
      source,
      prefetched,
    });
    span.addEvent("activity.reachability.resolved", {
      source,
      reachability: planInput.reachability,
      agentStatus: agent?.status ?? null,
      hasMachineId: Boolean(agent?.machineId),
    });

    const action = planActivityHintResolutionAction(planInput);
    if (planInput.weakOfflineSource && planInput.weakOfflineCompetingFact) {
      span.addEvent("suppressed_weak_offline", {
        weak_source: planInput.weakOfflineSource,
        competing_fact: planInput.weakOfflineCompetingFact,
        hint_source: source,
        reachability: planInput.reachability,
        resolved_activity: snapshot.activity,
      });
    }
    if (action === "return-offline" || action === "ignore-hint") {
      span.addEvent("activity.hint.ignored", {
        source,
        reason: action === "return-offline" ? "hard-reachability-offline" : "hint-not-trusted",
      });
      return this.applyActivityHintResolutionAction({
        action,
        agentId,
        snapshot,
      });
    }

    const normalized = this.normalizeStaleTransientActivity(agentId, snapshot, source);
    if (normalized) {
      span.addEvent("activity.hint.normalized", {
        source,
        activity: snapshot.activity,
        result: normalized.activity,
      });
      return normalized;
    }

    span.addEvent("activity.hint.candidate", {
      hint_source: source,
      candidate_activity: snapshot.activity,
      // trace_events_v2 compatibility alias; the raw event carries the
      // candidate-specific field above.
      resolved_activity: snapshot.activity,
    });

    const resolved = this.applyActivityHintResolutionAction({
      action,
      agentId,
      snapshot,
    });
    if (resolved) {
      this.emitActivityHintApplied(
        span,
        source,
        snapshot.activity,
        resolved.activity,
        action === "return-read-through-snapshot" ? "owner_mirror_read_through" : "trusted_snapshot",
      );
    }
    return resolved;
  }

  private emitActivityHintApplied(
    span: ActiveSpan,
    source: ActivityHintSource,
    candidateActivity: AgentActivityKind,
    servedActivity: AgentActivityKind,
    arbitrationReason: ActivityHintArbitrationReason,
  ): void {
    span.addEvent("activity.hint.applied", {
      hint_source: source,
      candidate_activity: candidateActivity,
      served_activity: servedActivity,
      write_action: "none",
      arbitration_reason: arbitrationReason,
      // Keep the closed decision queryable through the existing event-row
      // schema while the raw event uses the more precise contract names.
      resolved_activity: candidateActivity,
      next_activity: servedActivity,
      action: "none",
      reason: arbitrationReason,
    });
  }

  protected async loadActivityHintResolutionPlanInput(
    context: ActivityHintResolutionInputContext,
  ): Promise<ActivityHintResolutionPlanInput> {
    const reachabilityInput = await this.loadMachineReachabilityPlanInput({ agent: context.agent, prefetched: context.prefetched });
    const reachability = planMachineReachability(reachabilityInput);
    const hasStoppedOfflineHint = context.snapshot.activity === "offline" && context.snapshot.detailKind === "stopped";
    const weakOfflineSource = hasStoppedOfflineHint ? null : this.getSuppressibleWeakOfflineSource(
      context.agent,
      reachabilityInput,
      reachability,
    );
    const weakOfflineCompetingFact = weakOfflineSource
      ? this.getWeakOfflineCompetingFact(context.snapshot, context.source)
      : null;
    return {
      hasStoppedOfflineHint,
      reachability,
      shouldTrustRecoveredOfflineHint: this.shouldTrustRecoveredOfflineHint(
        context.agent,
        context.snapshot,
        reachability,
      ),
      ...(weakOfflineSource ? { weakOfflineSource } : {}),
      ...(weakOfflineCompetingFact ? { weakOfflineCompetingFact } : {}),
      source: context.source,
      isFreshLocalCache: this.getActivityAgeSec(context.snapshot) < 15,
    };
  }

  protected applyActivityHintResolutionAction(
    context: ActivityHintResolutionApplyContext,
  ): VisibleActivity | null {
    if (context.action === "return-snapshot") {
      return this.formatActivityFromSnapshot(context.snapshot);
    }

    if (context.action === "return-offline") {
      return this.formatActivity("offline");
    }

    if (context.action === "ignore-hint") {
      return null;
    }

    // A non-owner Redis mirror is authoritative for this read, but it is not a
    // local observation. Serve it directly without promoting it into this
    // replica's local serving authority.
    return this.formatActivityFromSnapshot(context.snapshot);
  }

  private async resolveDerivedActivity(agent: CachedAgentState | null, prefetched?: ActivityReadPrefetch): Promise<VisibleActivity> {
    const reachability = await this.getMachineReachability(agent, prefetched);

    if (reachability === "external-reported") {
      return this.formatActivity("offline");
    }

    const isReachable = reachability === "local" || reachability === "remote";
    return this.formatActivity(
      agent
      && isReachable
      && agent.status === "active"
        ? "online"
        : "offline",
    );
  }

  private async resolveRecentPersistedActivity(
    agentId: string,
    agent: CachedAgentState | null,
    span: ActiveSpan,
    prefetched?: ActivityReadPrefetch,
  ): Promise<VisibleActivity | null> {
    const reachabilityInput = await this.loadMachineReachabilityPlanInput({ agent, prefetched });
    const reachability = planMachineReachability(reachabilityInput);
    const isExternal = reachability === "external-reported";
    // These rule the persisted hint out below whatever it holds; skip its query
    // (every listed deleted / inactive agent paid it on every agent-list read).
    if (!agent || (!isExternal && agent.status !== "active")) return null;
    const persisted = await this.readLatestPersistedActivityHintForActivity(agentId, prefetched);
    const weakOfflineSource = this.getSuppressibleWeakOfflineSource(agent, reachabilityInput, reachability);
    const weakOfflineCompetingFact = weakOfflineSource && persisted
      ? this.getWeakOfflineCompetingFact(persisted, "persisted")
      : null;

    if (
      !agent
      || (!isExternal && agent.status !== "active")
      || (!isExternal && (reachability === "offline" || reachability === "none") && !weakOfflineCompetingFact)
      || !persisted
      || !this.isTransientActivity(persisted.activity)
      || this.getActivityAgeSec(persisted) > AgentOrchestrator.ACTIVITY_STALE_SEC
    ) {
      return null;
    }

    if (weakOfflineSource && weakOfflineCompetingFact) {
      span.addEvent("suppressed_weak_offline", {
        weak_source: weakOfflineSource,
        competing_fact: weakOfflineCompetingFact,
        hint_source: "persisted",
        reachability,
        resolved_activity: persisted.activity,
      });
    }

    return this.formatActivity(persisted.activity, persisted.detail);
  }

  // Agent state cache management

  /** Get cached agent state, falling back to DB on cache miss */
  private async getCachedAgent(agentId: string, knownRow?: PersistedAgentRow): Promise<CachedAgentState | null> {
    const cached = this.agentStateCache.get(agentId);
    if (cached) return cached;

    // The caller's row from this request answers the miss without a query:
    // a deleted row is what getAgent(id, false) would return as null.
    if (knownRow) {
      if (knownRow.deletedAt) return null;
      const seeded = this.cachedStateFromPersistedAgent(knownRow);
      this.agentStateCache.set(agentId, seeded);
      return seeded;
    }

    // Cache miss — load from DB and populate cache
    const agent = await agentService.getAgent(agentId, false, {
      dbCallsite: "agent_orchestrator.cache_miss",
    });
    if (!agent) return null;

    const state = this.cachedStateFromPersistedAgent(agent);
    this.agentStateCache.set(agentId, state);
    return state;
  }

  private cachedStateFromPersistedAgent(agent: PersistedAgentRow, existing?: CachedAgentState): CachedAgentState {
    const runtimeConfig = hydrateRuntimeConfig(agent);
    const launchRuntimeFields = runtimeConfigToLaunchFields(runtimeConfig);
    return {
      id: agent.id,
      status: agent.status,
      machineId: agent.machineId,
      sessionId: agent.sessionId,
      expectedLaunchId: existing?.expectedLaunchId ?? null,
      launchGuardMode: existing?.launchGuardMode ?? "legacy",
      serverId: agent.serverId,
      assistantOwnerUserId: agent.assistantOwnerUserId,
      name: agent.name,
      displayName: agent.displayName,
      description: agent.description,
      model: launchRuntimeFields.model,
      runtime: launchRuntimeFields.runtime,
      lastRuntimeError: agent.lastRuntimeError ?? null,
      runtimeState: existing?.machineId === agent.machineId ? existing.runtimeState : "unknown",
      reasoningEffort: launchRuntimeFields.reasoningEffort,
      runtimeConfig,
      envVars: launchRuntimeFields.envVars,
    };
  }

  protected async loadAgentForDelivery(agentId: string): Promise<PersistedAgentRow | null> {
    return agentService.getAgent(agentId, false, {
      dbCallsite: "agent_orchestrator.delivery",
    });
  }

  /** loadAgentForDelivery for several agents in one query; absent ids map to null. */
  protected async loadAgentsForDelivery(agentIds: readonly string[]): Promise<Map<string, PersistedAgentRow | null>> {
    const rows = await agentService.getAgentsByIds(agentIds);
    const byId = new Map<string, PersistedAgentRow | null>(agentIds.map((id) => [id, null]));
    for (const row of rows) byId.set(row.id, row);
    return byId;
  }

  /**
   * canAgentAccessDeliveryTarget's answer for these agents on one channel (not
   * a third-party event): the channel is in the agent's server and the agent
   * can access it. A fixed number of queries for any number of agents.
   */
  protected async loadDeliveryTargetAccess(
    channelId: string,
    agents: ReadonlyArray<{ id: string; serverId: string }>,
  ): Promise<Map<string, boolean>> {
    const channel = await channelService.getChannel(channelId);
    const accessible = channel
      ? await channelService.filterAgentsWithChannelAccess(channelId, agents.map((agent) => agent.id))
      : new Set<string>();
    return new Map(agents.map((agent) => [
      agent.id,
      Boolean(channel) && channel!.serverId === agent.serverId && accessible.has(agent.id),
    ]));
  }

  /**
   * The delivery gates (agent rows, channel access) for these agents on one
   * channel, in a fixed number of queries, to pass to deliverMessage. Whatever
   * fails to load is left to the per-agent checks (null = all of it).
   */
  async loadDeliveryGates(channelId: string, agentIds: readonly string[]): Promise<DeliveryGates | null> {
    let agents: Map<string, PersistedAgentRow | null>;
    try {
      agents = await this.loadAgentsForDelivery(agentIds);
    } catch {
      return null;
    }
    const live = [...agents.values()].filter((row): row is PersistedAgentRow => Boolean(row));
    // Whatever fails below is checked per agent, with its own error handling.
    const [access, passiveScope, migrationGated, raftbenchServices] = await Promise.all([
      live.length > 0 ? this.loadDeliveryTargetAccess(channelId, live).catch(() => new Map<string, boolean>()) : new Map<string, boolean>(),
      live.length > 0 ? this.loadPassiveDeliveryScopes(live.map((row) => row.id)).catch(() => new Map<string, boolean>()) : new Map<string, boolean>(),
      live.length > 0 ? this.loadMigrationGates(live.map((row) => row.id)).catch(() => new Map<string, boolean>()) : new Map<string, boolean>(),
      this.loadRaftBenchServiceAgentIds(live.map(row => row.id)),
    ]);
    return { agents, access, passiveScope, migrationGated, raftbenchServices };
  }

  /**
   * Passive-delivery scope check. Default impl reads `agent_scopes` via
   * `agentHasScope`; deterministic tests override to bypass DB. See
   * `DeliverMessageOptions.intrinsic` for the full design rationale.
   */
  protected async hasPassiveDeliveryScope(agentId: string): Promise<boolean> {
    return agentHasScope(agentId, "inbox:receive");
  }

  /** hasPassiveDeliveryScope for several existing agents in one query. */
  protected async loadPassiveDeliveryScopes(agentIds: readonly string[]): Promise<Map<string, boolean>> {
    return existingAgentsHaveScope(agentIds, "inbox:receive");
  }

  /** Whether an active migration gates each agent's delivery (loadWakePlanInput's first read), in one query. */
  protected async loadMigrationGates(agentIds: readonly string[]): Promise<Map<string, boolean>> {
    return agentMigrationService.getAgentMigrationGateActive(agentIds);
  }

  // `protected` for the same reason: arms ②③ must get past identity resolution to reach the
  // branch under test, and stubbing it is the only way to do that without seeding a full agent row.
  private async readAgentActivityForActivity(agentId: string, prefetch?: ActivityReadPrefetch): Promise<PersistedAgentActivity | null> {
    if (prefetch?.agentActivity.has(agentId)) return prefetch.agentActivity.get(agentId) ?? null;
    return this.replicaStateStore.getAgentActivity(agentId);
  }

  private async readAgentRuntimeErrorForActivity(agentId: string, prefetch?: ActivityReadPrefetch): Promise<AgentRuntimeErrorMirror | null> {
    if (prefetch?.runtimeError.has(agentId)) return prefetch.runtimeError.get(agentId) ?? null;
    return this.replicaStateStore.getAgentRuntimeError(agentId);
  }

  private async readMachineReplicaOwnerForActivity(machineId: string, prefetch?: ActivityReadPrefetch): Promise<string | null> {
    if (prefetch?.replicaOwner.has(machineId)) return prefetch.replicaOwner.get(machineId) ?? null;
    return this.replicaStateStore.getMachineReplicaOwner(machineId);
  }

  private async readLatestPersistedActivityHintForActivity(agentId: string, prefetch?: ActivityReadPrefetch): Promise<PersistedAgentActivityHint | null> {
    if (prefetch?.latestHint.has(agentId)) return prefetch.latestHint.get(agentId) ?? null;
    return this.loadLatestPersistedActivityHint(agentId);
  }

  protected async loadLatestPersistedActivityHints(agentIds: readonly string[]) {
    return agentActivityLogService.getLatestAgentActivityHints(agentIds);
  }

  /**
   * getActivity for a listed page of agents (GET /api/agents): the same
   * per-agent resolution, with its reads fetched for the whole list up front --
   * the Redis activity snapshots, runtime-error mirrors and machine owners in
   * one round trip each, and the latest persisted activity in one indexed
   * query -- instead of one key at a time per agent (a 362-agent server took
   * p95 ~0.9s). A deleted agent is offline without any read: it has no live
   * state, and the web never shows live state for one. A failed batch read
   * fails the call, as a failed read for any one agent did when each agent
   * read on its own; there is no per-agent retry, so resolving the list does
   * no I/O per agent.
   */
  async getActivities(rows: readonly PersistedAgentRow[], options: ActivityTraceOptions = {}): Promise<VisibleActivity[]> {
    const live = rows.filter((row) => !row.deletedAt);
    const prefetch: ActivityReadPrefetch = {
      agentActivity: new Map(),
      runtimeError: new Map(),
      replicaOwner: new Map(),
      latestHint: new Map(),
    };
    const liveIds = live.map((row) => row.id);
    const machineIds = [...new Set(live.map((row) => row.machineId).filter((id): id is string => Boolean(id)))];
    const store = this.replicaStateStore;
    const loadInto = async <K, V>(load: () => Promise<Map<K, V>>, into: Map<K, V>) => {
      for (const [key, value] of await load()) into.set(key, value);
    };
    await Promise.all([
      store.isAvailable() && liveIds.length > 0
        ? loadInto(
          () => store.getAgentActivities
            ? store.getAgentActivities(liveIds)
            : this.mapEach(liveIds, (id) => store.getAgentActivity(id)),
          prefetch.agentActivity,
        )
        : null,
      store.isAvailable() && liveIds.length > 0
        ? loadInto(
          () => store.getAgentRuntimeErrors
            ? store.getAgentRuntimeErrors(liveIds)
            : this.mapEach(liveIds, (id) => store.getAgentRuntimeError(id)),
          prefetch.runtimeError,
        )
        : null,
      store.isAvailable() && machineIds.length > 0
        ? loadInto(
          () => store.getMachineReplicaOwners
            ? store.getMachineReplicaOwners(machineIds)
            : this.mapEach(machineIds, (id) => store.getMachineReplicaOwner(id)),
          prefetch.replicaOwner,
        )
        : null,
      liveIds.length > 0 ? loadInto(() => this.loadLatestPersistedActivityHints(liveIds), prefetch.latestHint) : null,
    ]);

    return (
      // fanout-ok: every read is prefetched above (rows, Redis, latest hints); per agent this is in-memory work.
      Promise.all(rows.map((row) => row.deletedAt
        ? Promise.resolve(this.formatActivity("offline"))
        : this.getActivity(row.id, { ...options, persistedAgent: row, prefetched: prefetch }))));
  }

  private async mapEach<V>(keys: readonly string[], read: (key: string) => Promise<V>): Promise<Map<string, V>> {
    const values = await Promise.all(keys.map(read));
    return new Map(keys.map((key, index) => [key, values[index]!]));
  }

  /**
   * getAuthoritativeAgentForDelivery for activity reads. A deleted row loaded by
   * the caller in this request answers it without a query, with the same effect
   * (getAgent excludes deleted rows: the cache entry is dropped, null returned).
   */
  private async getAuthoritativeAgentForActivity(
    agentId: string,
    knownRow: PersistedAgentRow | undefined,
  ): Promise<CachedAgentState | null> {
    if (knownRow?.deletedAt) {
      this.agentStateCache.delete(agentId);
      return null;
    }
    if (knownRow) {
      // Loaded by the caller in this request: as fresh as a re-read now.
      const state = this.cachedStateFromPersistedAgent(knownRow, this.agentStateCache.get(agentId));
      this.agentStateCache.set(agentId, state);
      return state;
    }
    return this.getAuthoritativeAgentForDelivery(agentId);
  }

  protected async getAuthoritativeAgentForDelivery(agentId: string): Promise<CachedAgentState | null> {
    return this.applyPersistedAgentForDelivery(agentId, await this.loadAgentForDelivery(agentId));
  }

  private applyPersistedAgentForDelivery(agentId: string, persisted: PersistedAgentRow | null): CachedAgentState | null {
    if (!persisted) {
      this.agentStateCache.delete(agentId);
      return null;
    }

    const state = this.cachedStateFromPersistedAgent(persisted, this.agentStateCache.get(agentId));
    this.agentStateCache.set(agentId, state);
    return state;
  }

  /** Update cache entry (partial update) */
  private updateCache(agentId: string, updates: Partial<CachedAgentState>) {
    const cached = this.agentStateCache.get(agentId);
    if (cached) {
      Object.assign(cached, updates);
    }
  }

  protected setLaunchGuard(agentId: string, launchId: string) {
    this.updateCache(agentId, { expectedLaunchId: launchId, launchGuardMode: "guarded" });
  }

  protected clearLaunchGuard(agentId: string) {
    this.updateCache(agentId, { expectedLaunchId: null, launchGuardMode: "legacy" });
  }

  protected shouldAcceptLifecycleEvent(
    machineId: string,
    agent: CachedAgentState,
    messageType: MachineToServerMessage["type"],
    launchId?: string,
    span?: ActiveSpan | null,
  ): boolean {
    const action = this.getLifecycleEventAcceptanceAction(agent, launchId);

    if (action === "accept") {
      return true;
    }

    this.handleRejectedLifecycleEvent(machineId, agent, messageType, launchId, action, span);
    return false;
  }

  protected getLifecycleEventAcceptanceAction(
    agent: CachedAgentState,
    launchId?: string,
  ): LifecycleEventAcceptanceAction {
    return planLifecycleEventAcceptance({
      launchGuardMode: agent.launchGuardMode,
      expectedLaunchId: agent.expectedLaunchId,
      launchId,
    });
  }

  private logLifecycleEventDrop(
    machineId: string,
    agent: CachedAgentState,
    messageType: MachineToServerMessage["type"],
    launchId: string | undefined,
    action: Exclude<LifecycleEventAcceptanceAction, "accept">,
  ) {
    if (action === "ignore-legacy-for-guarded") {
      console.warn(
        `[Machine ${machineId}] Ignoring legacy ${messageType} for guarded agent ${agent.name} (${agent.expectedLaunchId})`,
      );
      return;
    }

    console.warn(
      `[Machine ${machineId}] Ignoring stale ${messageType} for agent ${agent.name}: expected launch ${agent.expectedLaunchId}, got ${launchId}`,
    );
  }

  private handleRejectedLifecycleEvent(
    machineId: string,
    agent: CachedAgentState,
    messageType: MachineToServerMessage["type"],
    launchId: string | undefined,
    action: Exclude<LifecycleEventAcceptanceAction, "accept">,
    span?: ActiveSpan | null,
  ) {
    this.logLifecycleEventDrop(machineId, agent, messageType, launchId, action);
    if (!this.shouldResolveStartingActivityForRejectedLifecycleEvent(agent.id)) return;

    span?.addEvent("lifecycle_guard.starting_resolve_on_reject", {
      action,
      message_type: messageType,
    });
    this.maybeResolveStartingActivity(agent.id, span);
  }

  private shouldResolveStartingActivityForRejectedLifecycleEvent(agentId: string): boolean {
    const current = this.agentActivity.get(agentId);
    return Boolean(current && this.isStartingActivitySnapshot(current));
  }

  /** Remove agent from cache */
  evictCache(agentId: string) {
    this.agentStateCache.delete(agentId);
    this.runtimeErrorViewerCache.delete(agentId);
  }

  /**
   * When the agent was last observed idle (`online`: its turn ended; `offline`:
   * its runtime is gone), as the observation time the server recorded (never
   * later than when it arrived); null while it is busy or nothing is known.
   * The WeChat turn record starts a new turn at a hand-off only after such an
   * observation (wechatTurn.ts). Reads the shared activity (Redis: the
   * runtime's `/activity` reports reach any replica) and this replica's own,
   * whichever was written last.
   */
  async getTurnIdleObservedAtMs(agentId: string): Promise<number | null> {
    const local = this.agentActivity.get(agentId) ?? null;
    const shared = await this.replicaStateStore.getAgentActivity(agentId).catch(() => null);
    const latest = !shared ? local : !local ? shared : shared.updatedAt >= local.updatedAt ? shared : local;
    if (!latest || (latest.activity !== "online" && latest.activity !== "offline")) return null;
    return typeof latest.observedAtMs === "number" ? latest.observedAtMs : null;
  }

  /** After an agent is deleted (committed): its held coarse state is dropped, not sent. */
  forgetAgentActivity(agentId: string) {
    this.forgetLocalActivitySnapshot(agentId);
    this.agentActivityStateFanout.forget(agentId);
    void this.replicaStateStore.clearAgentContextViewAvailability(agentId).catch((err) => {
      console.warn(`[AgentOrchestrator] Failed to clear context view availability for ${agentId}:`, err);
    });
  }

  private isServerActivityBlock(kind: AgentActivityDetailKind | undefined): boolean {
    return kind === "wake_crash_loop_blocked" || kind === "terminal_failure_paused";
  }

  /** Local cache disposal only: never clear the current owner's shared state. */
  private forgetLocalActivitySnapshot(agentId: string) {
    this.agentActivity.delete(agentId);
    this.busyPreservedPhase.delete(agentId);
    const debounce = this.activityDebounceTimers.get(agentId);
    if (debounce) clearTimeout(debounce);
    this.activityDebounceTimers.delete(agentId);
    for (const [probeId, probe] of this.pendingActivityProbes) {
      if (probe.agentId !== agentId) continue;
      clearTimeout(probe.fallbackTimer);
      this.pendingActivityProbes.delete(probeId);
    }
  }

  /** View Context: the latest availability report stored for the agent (any replica), or null. */
  async getAgentContextViewAvailability(agentId: string): Promise<AgentContextViewAvailabilityRecord | null> {
    return this.replicaStateStore.getAgentContextViewAvailability(agentId);
  }

  /**
   * Whether the Computer's daemon advertised `capability` on its current
   * connection, from any replica: the live connection when local, else the
   * owner's mirrored ready capabilities (readProbeCarrierFact).
   */
  /**
   * task #1357 item 1: an input of the agents' `modelLimits` signal changed
   * (their session, their config revision): clients re-read them. Only
   * agents that have such a signal are told. Best effort.
   */
  async notifyModelLimitsChanged(where: { agentIds: readonly string[] }): Promise<void> {
    if (!this.io) return;
    try {
      for (const agent of await listModelLimitsAgents(where)) {
        this.io.to(agentEventRoom(agent.serverId, agent.assistantOwnerUserId)).emit("agent:updated", { agentId: agent.id });
      }
    } catch (err) {
      console.warn(`[ModelLimits] agent:updated push failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * `machineAdvertisesCapability` for a start decision: a failed read (the
   * shared store) counts as "not declared" and is logged, never failing the
   * start.
   */
  private async machineDeclaresCapabilityForStart(machineId: string | null | undefined, capability: string): Promise<boolean> {
    if (!machineId) return false;
    try {
      return await this.machineAdvertisesCapability(machineId, capability);
    } catch (err) {
      console.warn(`[Machine ${machineId}] capability ${capability} unreadable for a start, treated as not declared: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async machineAdvertisesCapability(machineId: string, capability: string): Promise<boolean> {
    const local = this.machineConnections.get(machineId);
    if (local) return local.capabilities.has(capability);
    return (await this.readProbeCarrierFact(machineId))?.capabilities.includes(capability) === true;
  }

  /**
   * View Context: send one `agent:context_view_request` to the Computer from
   * any replica (locally, or through the owner replica). Fire and forget: the
   * daemon answers with a result POST, never a frame. False when no replica
   * holds the Computer's connection.
   */
  async sendAgentContextViewRequest(machineId: string, message: AgentContextViewRequestMessage): Promise<boolean> {
    return this.sendToMachine(machineId, message);
  }

  // Machine WebSocket management

  private latestHeartbeatProofAt(conn: MachineConnection): number {
    return Math.max(conn.lastPong, conn.lastIngressAt);
  }

  private isMachineHeartbeatStale(conn: MachineConnection): boolean {
    return this.clock.now() - this.latestHeartbeatProofAt(conn) > AgentOrchestrator.MACHINE_HEARTBEAT_TIMEOUT_MS;
  }

  protected onMachineHeartbeatTick(machineId: string, conn: MachineConnection) {
    const lastPongAgeMs = this.clock.now() - conn.lastPong;
    const lastIngressAgeMs = this.clock.now() - conn.lastIngressAt;
    const heartbeatProofAgeMs = this.clock.now() - this.latestHeartbeatProofAt(conn);
    void this.runInTraceSpan(
      "server.machine.websocket.heartbeat",
      {
        parent: null,
        attrs: {
          machine_id: machineId,
          server_id: conn.serverId,
          machine_id_present: Boolean(machineId),
          server_id_present: Boolean(conn.serverId),
          daemon_version_present: Boolean(conn.daemonVersion),
          ws_ready_state: conn.ws.readyState,
          last_pong_age_ms_bucket: durationMsBucket(lastPongAgeMs),
          last_ingress_age_ms_bucket: durationMsBucket(lastIngressAgeMs),
          heartbeat_proof_age_ms_bucket: durationMsBucket(heartbeatProofAgeMs),
          heartbeat_timeout_ms: AgentOrchestrator.MACHINE_HEARTBEAT_TIMEOUT_MS,
        },
      },
      async (): Promise<{ status: TraceStatus; attrs: TraceAttributes }> => {
        if (this.isMachineHeartbeatStale(conn)) {
          console.log(`[Machine ${machineId}] Heartbeat timeout — terminating socket`);
          this.recordEvent("heartbeat.timeout", {
            outcome: "heartbeat_timeout",
            reason: "heartbeat_timeout",
            last_pong_age_ms_bucket: durationMsBucket(lastPongAgeMs),
            last_ingress_age_ms_bucket: durationMsBucket(lastIngressAgeMs),
            heartbeat_proof_age_ms_bucket: durationMsBucket(heartbeatProofAgeMs),
            ws_ready_state: conn.ws.readyState,
          });
          // Use terminate() (TCP RST) rather than close() so the connection is
          // dropped even in half-open / black-hole network conditions.
          try { conn.ws.terminate(); } catch { /* ignore */ }
          void this.handleMachineDisconnect(machineId, conn.ws, { cause: "heartbeat_timeout" });
          return { status: "error", attrs: { outcome: "heartbeat_timeout", terminated_socket: true } };
        }
        try {
          const sent = await this.sendToMachine(machineId, { type: "ping" });
          return sent
            ? { status: "ok", attrs: { outcome: "ping_sent", sent: true } }
            : { status: "error", attrs: { outcome: "ping_send_failed", sent: false } };
        } catch (err) {
          console.warn(`[Machine ${machineId}] best-effort ping send failed:`, err);
          return {
            status: "error",
            attrs: { outcome: "ping_send_failed", sent: false, error_class: errorClassOf(err) },
          };
        }
      },
      (result) => result,
    );
  }

  protected startMachineHeartbeat(machineId: string, conn: MachineConnection) {
    this.recordEvent("server.machine.websocket.heartbeat_timer", {
      machine_id: machineId,
      server_id: conn.serverId,
      machine_id_present: Boolean(machineId),
      server_id_present: Boolean(conn.serverId),
      interval_ms: 30_000,
      outcome: "started",
    });
    conn.heartbeatTimer = this.clock.scheduleRepeated(() => this.onMachineHeartbeatTick(machineId, conn), 30_000);
    this.startMachineWsPing(conn);
  }

  private startMachineWsPing(conn: MachineConnection) {
    if (conn.wsPingTimer) this.clock.cancelRepeated(conn.wsPingTimer);
    conn.wsPingTimer = null;
    if (this.machineWsPingIntervalMs <= 0) return;
    conn.wsPingTimer = this.clock.scheduleRepeated(() => {
      // Only an OPEN socket can carry a ping; `ws` throws otherwise. Closing
      // and closed sockets are cleaned up by clearMachineConnection.
      if (conn.ws.readyState !== 1) return;
      try {
        conn.ws.ping();
      } catch {
        // Best effort: a failed keepalive must never affect the connection's
        // bookkeeping. The 30s heartbeat still owns liveness decisions.
      }
    }, this.machineWsPingIntervalMs);
  }

  protected async loadRuntimeAccountUsageAttacher(serverId: string, machineId: string): Promise<string | null> {
    return (await getComputerLinkedMachineAttachers(serverId)).get(machineId) ?? null;
  }

  protected async isRuntimeAccountUsageDataBoundaryAuthorized(
    machineId: string,
    conn: MachineConnection,
  ): Promise<boolean> {
    if (this.machineConnections.get(machineId) !== conn || conn.principalKind !== "computer") return false;
    const attachedBy = await this.loadRuntimeAccountUsageAttacher(conn.serverId, machineId);
    return this.machineConnections.get(machineId) === conn && Boolean(attachedBy);
  }

  protected async writeRuntimeAccountUsageSnapshot(machineId: string, snapshot: unknown): Promise<void> {
    const parsed = await runtimeAccountUsageCacheService.write(machineId, snapshot);
    if (!parsed) return;
    try {
      await usageLimitAttentionService.ingest(machineId, parsed);
    } catch (error) {
      // Attention is a side projection of the usage snapshot. It must never break the existing
      // usage cache write or a correlated manual-refresh response.
      console.warn("[UsageLimitAttention] projection failed", {
        machineId,
        errorClass: errorClassOf(error),
      });
    }
  }

  protected async collectScheduledRuntimeAccountUsage(machineId: string, conn: MachineConnection): Promise<void> {
    if (this.machineConnections.get(machineId) !== conn || !conn.runtimes) return;
    if (!await this.isRuntimeAccountUsageDataBoundaryAuthorized(machineId, conn)) return;
    for (const provider of runtimeAccountUsageProvidersForRuntimes(conn.runtimes, conn.capabilities)) {
      if (!await runtimeAccountUsageCacheService.tryAcquireRefresh(machineId, provider)) continue;
      await this.requestRuntimeAccountUsageRefresh(machineId, provider, "scheduled");
    }
  }

  private startRuntimeAccountUsageSchedule(machineId: string, conn: MachineConnection): void {
    if (conn.runtimeAccountUsageTimer) this.clock.cancelRepeated(conn.runtimeAccountUsageTimer);
    void this.collectScheduledRuntimeAccountUsage(machineId, conn).catch(() => {});
    conn.runtimeAccountUsageTimer = this.clock.scheduleRepeated(() => {
      void this.collectScheduledRuntimeAccountUsage(machineId, conn).catch(() => {});
    }, runtimeAccountUsageIntervalMs(machineId));
    (conn.runtimeAccountUsageTimer as { unref?: () => void })?.unref?.();
  }

  protected async autoAssignConnectedMachine(serverId: string, machineId: string) {
    await agentService.autoAssignMachine(serverId, machineId);
  }

  protected async loadAgentsForDisconnect(machineId: string) {
    return agentService.getAgentsForMachine(machineId);
  }

  /** Same-machine grouping: ask a freshly ready daemon for its per-server host hash while the flag is on. */
  protected async requestHostIdentity(machineId: string, serverId: string): Promise<void> {
    try {
      if (!(await computerHostIdentityService.isHostIdentityEnabled(serverId))) return;
      await this.sendToMachine(machineId, { type: "machine:host_identity:request" });
    } catch (error) {
      console.warn(`[Machine ${machineId}] host identity request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  protected async storeHostIdentity(machineId: string, serverId: string, hostIdHash: string): Promise<void> {
    try {
      if (!(await computerHostIdentityService.isHostIdentityEnabled(serverId))) {
        this.recordEvent("server.computer.host_identity.dropped", { reason: "flag_off" });
        return;
      }
      await computerHostIdentityService.recordHostIdHash(machineId, hostIdHash, new Date(this.clock.now()));
      this.recordEvent("server.computer.host_identity.stored", {});
    } catch (error) {
      this.recordEvent("server.computer.host_identity.dropped", { reason: "write_failed" });
      console.warn(`[Machine ${machineId}] host identity write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  protected async persistMachineCapabilities(
    machineId: string,
    runtimes: string[],
    hostname?: string,
    os?: string,
    daemonVersion?: string | null,
    host?: machineService.MachineHostFacts,
  ) {
    await machineService.updateMachineRuntimes(machineId, runtimes, hostname, os, daemonVersion, host);
  }

  /**
   * task #1268: the last confirmed inventory when this connection has none yet
   * (a `pending` ready is the FIRST frame of a fresh connection, whose
   * `conn.runtimes` is null): the persisted `machines.runtimes` column plus the
   * replica meta's versions. Null when neither can be read; callers then keep
   * nothing rather than invent an empty list.
   */
  protected async loadPersistedMachineInventory(machineId: string): Promise<MachineRuntimeInventory | null> {
    try {
      const machine = await machineService.getMachine(machineId as Parameters<typeof machineService.getMachine>[0]);
      if (!machine) return null;
      let runtimeVersions: Record<string, string> = {};
      if (this.replicaStateStore.isAvailable()) {
        try {
          runtimeVersions = runtimeVersionsFromMachineMeta(await this.replicaStateStore.getMachineMeta(machineId));
        } catch {
          runtimeVersions = {};
        }
      }
      return { runtimes: [...(machine.runtimes ?? [])], runtimeVersions };
    } catch (error) {
      console.warn(`[Orchestrator] persisted runtime inventory unavailable for ${machineId}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  protected async persistMachineComputerVersion(
    machineId: string,
    computerVersion: string | null | undefined,
    reportedAt: Date,
  ): Promise<boolean> {
    return machineService.recordMachineComputerVersion(machineId, computerVersion, reportedAt);
  }

  private async recordReportedMachineComputerVersion(
    machineId: string,
    computerVersion: string | null | undefined,
    source: "ready" | "lifecycle_ack",
  ): Promise<void> {
    if (!computerVersion?.trim()) return;
    await this.runInTraceSpan(
      "server.machine.computer_version.persist",
      { attrs: { machine_id: machineId, source } },
      async (): Promise<{ status: TraceStatus; attrs: TraceAttributes }> => {
        try {
          const updated = await this.persistMachineComputerVersion(
            machineId,
            computerVersion,
            new Date(this.clock.now()),
          );
          return { status: "ok", attrs: { outcome: updated ? "updated" : "unchanged" } };
        } catch (err) {
          return { status: "error", attrs: { outcome: "failed", error_class: errorClassOf(err) } };
        }
      },
      (result) => result,
    );
  }

  private static readonly CAPABILITIES_PERSIST_RETRY_BASE_MS = 500;
  private static readonly CAPABILITIES_PERSIST_RETRY_MAX_MS = 30_000;
  // After this many consecutive failures we escalate to a loud trace so a stuck
  // control-plane write is visible; we keep retrying at the capped interval
  // rather than giving up. Giving up would silently strand the owner on Screen B
  // (the setup projection reads the persisted column), which is the very
  // liveness gap this path closes.
  private static readonly CAPABILITIES_PERSIST_ALERT_AFTER_ATTEMPTS = 5;
  private static readonly AGENT_SKILLS_LIST_TIMEOUT_MS = 15_000;
  private static readonly AGENT_SKILLS_LIST_LATE_RESULT_OBSERVATION_MS = 60_000;

  /**
   * The one place in this file that schedules on the injected clock.
   *
   * Keep scheduling centralized so callers share the same deterministic test
   * seam and typed-handle behavior. Callers that must not hold the process open
   * still call `.unref()` on the handle they get back.
   */
  private scheduleOnClock(fn: () => void, ms: number): unknown {
    return this.clock.setTimeout(fn, ms);
  }

  /** `scheduleOnClock` for a timer that must not hold the process open (the start-failure retries). */
  private scheduleUnrefOnClock(fn: () => void, ms: number): unknown {
    const timer = this.scheduleOnClock(fn, ms);
    (timer as { unref?: () => void } | null)?.unref?.();
    return timer;
  }

  private nextCapabilitiesGeneration(machineId: string): number {
    const next = (this.capabilitiesGenerationSeq.get(machineId) ?? 0) + 1;
    this.capabilitiesGenerationSeq.set(machineId, next);
    return next;
  }

  /**
   * Persist daemon-reported capabilities, then — ONLY after the write lands —
   * update the in-memory connection and emit the client `machine:capabilities`
   * card. The setup projection reads the persisted `machines.runtimes` column as
   * its single cross-replica source, so the card and conn must never advance
   * past what actually reached the DB (otherwise the card shows "runtime
   * detected" while the projection reads the un-persisted column → Next dead).
   *
   * Two invariants, both structural (not "decide who wins afterwards"):
   *
   * 1. Liveness (#4695): a transient persist failure must NOT depend on the
   *    daemon sending another `ready` to recover. runCapabilitiesWriter retries
   *    the latest payload itself on a capped exponential backoff until it lands.
   *
   * 2. Single-writer serialization (@铁根/@Dozy/@Jianwei/@Jiayuan): at most ONE
   *    persist is in flight per machine. A concurrent `ready` only overwrites
   *    `latest` + bumps the monotonic generation — it does NOT start a second
   *    persist. This is what makes it *impossible* for an older write to land
   *    after a newer one (the earlier "post-await generation guard" only shielded
   *    conn/card; it could not un-write a stale DB row that was already in flight).
   *    The last write is always the latest payload, so DB/conn/card converge.
   *
   * A newer payload supersedes in place (monotonic generation, never reused →
   * no ABA); disconnect cancels or, if a write is in flight, marks the entry so
   * the loop finishes without emitting; we never hard-exhaust — a persistently
   * failing write escalates to a loud trace but keeps converging.
   *
   * Out of scope (Jiayuan's follow-up ledger): distinguishing clearly
   * non-retryable failures (constraint/permission/missing-row) and giving the
   * owner a user-visible retry via a separate `capabilities_persist_failed`
   * gateReason on a path independent of this failing write — not reusing
   * `runtime_error` and not writing a "DB-write-failed" marker through the same
   * failing DB.
   */
  protected async enqueueCapabilitiesPersist(machineId: string, payload: CapabilitiesPersistPayload): Promise<void> {
    const generation = this.nextCapabilitiesGeneration(machineId);
    const existing = this.capabilitiesWrites.get(machineId);
    if (existing) {
      // Overwrite the pending payload in place. If a persist is currently in
      // flight (writing), the running loop will pick this up when it resolves;
      // we must not start a second concurrent writer.
      if (existing.timer != null) {
        this.clock.clearTimeout(existing.timer);
        existing.timer = null;
      }
      existing.latest = payload;
      existing.generation = generation;
      existing.attempt = 0;
      existing.cancelled = false;
    } else {
      this.capabilitiesWrites.set(machineId, { latest: payload, generation, writing: false, timer: null, attempt: 0, cancelled: false });
    }
    // Await so the happy path persists + emits before the `ready` handler
    // returns (unchanged from the previous inline persist). If a writer is
    // already running this returns immediately and that writer converges.
    await this.runCapabilitiesWriter(machineId);
  }

  private async runCapabilitiesWriter(machineId: string): Promise<void> {
    const start = this.capabilitiesWrites.get(machineId);
    // Single-writer lock: only one loop persists for this machine at a time.
    if (!start || start.writing) return;
    start.writing = true;

    while (true) {
      const state = this.capabilitiesWrites.get(machineId);
      if (!state) return;
      if (state.cancelled) {
        this.capabilitiesWrites.delete(machineId);
        return;
      }
      const writeGeneration = state.generation;
      const payload = state.latest;

      try {
        await this.runInTraceSpan(
          "server.machine.capabilities.persist",
          { attrs: { machine_id: machineId, attempt: state.attempt + 1 } },
          () => this.persistMachineCapabilities(machineId, payload.runtimes, payload.hostname, payload.os, payload.daemonVersion, payload.host),
        );
      } catch (err) {
        const failed = this.capabilitiesWrites.get(machineId);
        if (!failed || failed.cancelled) {
          if (failed) this.capabilitiesWrites.delete(machineId);
          return;
        }
        failed.attempt += 1;
        // Release the writer lock; the backoff timer re-enters the loop, which
        // will pick up whatever the latest payload is by then.
        failed.writing = false;
        const delayMs = Math.min(
          AgentOrchestrator.CAPABILITIES_PERSIST_RETRY_BASE_MS * 2 ** (failed.attempt - 1),
          AgentOrchestrator.CAPABILITIES_PERSIST_RETRY_MAX_MS,
        );
        const alerting = failed.attempt >= AgentOrchestrator.CAPABILITIES_PERSIST_ALERT_AFTER_ATTEMPTS;
        this.recordEvent("server.machine.capabilities.persist_retry", {
          machine_id: machineId,
          attempt: failed.attempt,
          retry_delay_ms: delayMs,
          reason: "capabilities_persist_failed",
          error_class: errorClassOf(err),
          outcome: alerting ? "alerting" : "retrying",
        });
        if (alerting) {
          console.error(`[Machine ${machineId}] capabilities persist still failing after ${failed.attempt} attempts; retrying every ${delayMs}ms:`, err);
        }
        const timer = this.scheduleOnClock(() => {
          const scheduled = this.capabilitiesWrites.get(machineId);
          if (scheduled) scheduled.timer = null;
          void this.runCapabilitiesWriter(machineId);
        }, delayMs);
        // A best-effort background retry must never keep the process alive on
        // its own (a real server stays up via its listeners; tests must be able
        // to exit while a retry is pending). No-op on the fake test clock.
        (timer as { unref?: () => void })?.unref?.();
        failed.timer = timer;
        return;
      }

      const after = this.capabilitiesWrites.get(machineId);
      if (!after) return;
      if (after.cancelled) {
        this.capabilitiesWrites.delete(machineId);
        return;
      }
      if (after.generation !== writeGeneration) {
        // A newer payload arrived while we were writing. Keep the writer lock
        // and loop again to persist it — the older write we just did is
        // therefore never the last word, and the newer one lands strictly after.
        after.attempt = 0;
        continue;
      }

      // Converged on the latest generation: update conn + emit exactly once,
      // then clear the pending write.
      this.capabilitiesWrites.delete(machineId);
      const conn = this.machineConnections.get(machineId);
      if (conn) {
        conn.runtimes = payload.runtimes;
        conn.runtimeVersions = payload.runtimeVersions ?? {};
        // task #1268: the detection state of an inventory-carrying ready lands
        // together with the persisted inventory, here, and is mirrored to the
        // replica meta at the same moment (a synchronous ready carries none).
        conn.runtimeDetection = payload.runtimeDetection ?? null;
        if (this.replicaStateStore.isAvailable()) {
          this.replicaStateStore
            .setMachineMeta(machineId, { probeRuntimeDetection: payload.runtimeDetection ? JSON.stringify(payload.runtimeDetection) : null })
            .catch(() => {});
        }
        this.io?.to(`server:${conn.serverId}`).emit("machine:capabilities", {
          machineId,
          runtimes: payload.runtimes,
          runtimeVersions: payload.runtimeVersions ?? {},
          ...(conn.runtimeDetection ? { runtimeDetection: conn.runtimeDetection } : {}),
          hostname: payload.hostname,
          os: payload.os,
          deviceClass: payload.host?.deviceClass ?? null,
          hostProvider: payload.host?.hostProvider ?? null,
          osRelease: payload.host?.osRelease ?? null,
          osId: payload.host?.osId ?? null,
          osIdLike: payload.host?.osIdLike ?? null,
          daemonVersion: payload.daemonVersion,
          computerVersion: payload.computerVersion,
          versionGate: conn.versionGate ?? null,
        });
      }
      await this.liftRuntimeUnavailableBlocks(machineId, payload.runtimes);
      return;
    }
  }

  /**
   * The computer reported its runtimes: agents there paused only because their
   * runtime was missing wake normally again once it is listed. Best effort.
   */
  private async liftRuntimeUnavailableBlocks(machineId: string, runtimes: readonly string[]): Promise<void> {
    try {
      const machineAgents = await this.loadAgentsForReadyReconcile(machineId);
      for (const agent of machineAgents) {
        if (!runtimes.includes(agent.runtime)) continue;
        if (await this.wakeCrashLoopBreaker.liftForRuntimeAvailable(agent.id)) {
          this.recordEvent("wake.block_lifted", { cause: "runtime_available", runtime: agent.runtime });
        }
      }
    } catch (error) {
      console.warn(`[Machine ${machineId}] Lifting runtime-unavailable pauses failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  protected cancelPendingCapabilities(machineId: string): void {
    const state = this.capabilitiesWrites.get(machineId);
    if (!state) return;
    if (state.timer != null) {
      this.clock.clearTimeout(state.timer);
      state.timer = null;
    }
    // If a persist is in flight, do NOT delete the entry (that would let a
    // reconnect start a second concurrent writer). Mark it so the running loop
    // exits without emitting once the in-flight write resolves.
    if (state.writing) {
      state.cancelled = true;
    } else {
      this.capabilitiesWrites.delete(machineId);
    }
  }

  protected async loadAgentsForReadyReconcile(machineId: string) {
    return agentService.getAgentsForMachine(machineId);
  }

  protected async loadRuntimeContextMachine(machineId: MachineId): Promise<RuntimeContextMachine> {
    const machine = await machineService.getMachine(machineId);
    return machine
      ? { name: machine.name, description: machine.description, hostname: machine.hostname, os: machine.os }
      : null;
  }

  protected async applyReadyReconcileAction(
    machineId: string,
    agent: ReadyReconcileAgent,
    action: ReadyReconcilePlanAction,
  ): Promise<void> {
    if (!this.agentStateCache.has(agent.id)) {
      this.agentStateCache.set(agent.id, this.cachedStateFromPersistedAgent(agent));
    }
    const connectionEpochId = this.getConnectionEpochId(machineId);
    const activityDedupeKey = this.makeReadyReconcileActivityDedupeKey({
      agentId: agent.id,
      machineId,
      connectionEpochId,
      agentStatus: agent.status,
      action,
    });
    // TODO(lifecycle-v2/server-producer): ready reconcile is server-owned.
    // Have the reconcile planner produce canonical runtime_ready,
    // runtime_interrupted, or ready_reconciled lifecycle events directly with
    // connectionEpochId/reason attrs, then delete this legacy adapter call.
    const { event } = adaptReadyReconcileLifecycleEvent({
      serverId: agent.serverId,
      agentId: agent.id,
      machineId,
      action,
      agentStatus: agent.status,
      connectionEpochId,
      now: () => new Date(this.clock.now()),
    });
    const state = buildAgentLifecycleStateSnapshot({
      dbStatus: agent.status,
      machineId,
      machineReachability: "reachable",
      runtimeState: action === "mark-active-online"
        ? "running_idle"
        : action === "mark-wakeable-not-running"
          ? "not_running"
        : action === "mark-inactive-offline"
          ? "interrupted"
          : "not_running",
    });
    await applyAgentLifecycleProjectionPlan(
      reduceReadyReconcileLifecycle({
        action,
        activityDedupeKey,
        event,
        state,
      }),
      this.lifecycleProjectionWriterDeps(),
      getCurrentTraceSpan(),
    );
  }

  /**
   * Buffered messages that may be handed over again (agent:start wake, gated
   * inbox flush): system-app events go through their app's delivery guard
   * (systemAppDeliveryGuards), and the ones it vetoes are dropped from the
   * buffer; the ones it withholds (fail closed) stay buffered, not handed
   * over. Order kept; with no guarded system-app event, no query. Callers
   * skip the call (and its await) when no message is a third-party event.
   */
  private async guardBufferedSystemAppEvents(agentId: string, messages: AgentMessage[]): Promise<AgentMessage[]> {
    const { deliverable, vetoed } = await partitionDeliverableSystemAppEventMessages(messages, agentId);
    if (vetoed.length > 0) this.discardUndeliverableMessages(agentId, vetoed);
    return deliverable;
  }

  /**
   * False when `message` (a third-party event; callers skip the call for any
   * other message) is a system-app event its app's delivery guard does not
   * allow now (a vetoed one is expired by the check).
   */
  protected async isSystemAppEventDeliverable(agentId: string, message: AgentMessage): Promise<boolean> {
    const { deliverable } = await partitionDeliverableSystemAppEventMessages([message], agentId);
    return deliverable.length === 1;
  }

  private async maybeWakePendingInboxAfterReady(
    machineId: string,
    agent: ReadyReconcileAgent,
  ): Promise<boolean> {
    if (!this.localInboxes.peekFirst(agent.id)) {
      return false;
    }
    if (this.machineConnections.get(machineId)?.versionGate?.enforced) {
      // Held for the version floor: the message stays queued for after the upgrade.
      return false;
    }
    // The wake hands the message over in agent:start: the oldest buffered
    // message a system-app delivery guard does not keep back.
    const buffered = this.localInboxes.peek(agent.id);
    const [wakeMessage] = buffered.some((message) => message.third_party_event)
      ? await this.guardBufferedSystemAppEvents(agent.id, buffered)
      : buffered;
    if (!wakeMessage) {
      return false;
    }

    const wakeInput = await this.loadWakePlanInput(agent.id, agent.status);
    const action = planWakeAction(wakeInput);
    this.recordEvent("machine.ready.pending_inbox_wake.planned", {
      agent_id: agent.id,
      machine_id: machineId,
      agent_id_present: Boolean(agent.id),
      machine_id_present: Boolean(machineId),
      message_id_present: Boolean(wakeMessage.message_id),
      seq: wakeMessage.seq ?? 0,
      db_status: wakeInput.state.dbStatus,
      runtime_state: wakeInput.state.runtimeState,
      reset_mode: wakeInput.state.resetMode ?? null,
      control_gate: wakeInput.state.controlGate,
      action,
    });

    if (action !== "attempt-wake") {
      return false;
    }

    await this.applyWakeAction({
      agentId: agent.id,
      machineId,
      previousStatus: agent.status,
      resetMode: wakeInput.state.resetMode,
    }, wakeMessage, action);

    const woke = this.agentStateCache.get(agent.id)?.runtimeState === "starting";
    if (!woke) {
      this.recordEvent("machine.ready.pending_inbox_wake.not_started", {
        agent_id: agent.id,
        machine_id: machineId,
        agent_id_present: Boolean(agent.id),
        machine_id_present: Boolean(machineId),
        seq: wakeMessage.seq ?? 0,
      });
      return false;
    }

    // The pending message is now embedded in agent:start as wakeMessage. Daemon
    // startup-wake messages are not sent as agent:deliver, so they do not emit
    // a delivery ack to drain this replay inbox entry.
    const removed = this.localInboxes.removeWakeMessage(agent.id, wakeMessage);
    this.recordEvent("machine.ready.pending_inbox_wake.started", {
      agent_id: agent.id,
      machine_id: machineId,
      agent_id_present: Boolean(agent.id),
      machine_id_present: Boolean(machineId),
      seq: wakeMessage.seq ?? 0,
      removed_from_inbox: removed,
    });
    return true;
  }

  private async bumpMachineStatusVersion(machineId: string): Promise<number> {
    if (this.replicaStateStore.isAvailable()) {
      return this.replicaStateStore.bumpMachineStatusVersion(machineId);
    }
    const next = (this.machineStatusVersions.get(machineId) ?? 0) + 1;
    this.machineStatusVersions.set(machineId, next);
    return next;
  }

  async getMachineStatusVersion(machineId: string): Promise<number> {
    if (this.replicaStateStore.isAvailable()) {
      return this.replicaStateStore.getMachineStatusVersion(machineId);
    }
    return this.machineStatusVersions.get(machineId) ?? 0;
  }

  private async clearMachineConnection(
    machineId: string,
    unregisterReplica: boolean,
    close?: { code: number; reason: string },
    expectedWs?: WebSocket,
  ): Promise<void> {
    let conn = this.machineConnections.get(machineId);
    if (!conn || (expectedWs && conn.ws !== expectedWs)) {
      try {
        if (expectedWs?.readyState === 1) expectedWs.close(close?.code, close?.reason);
      } catch { /* ignore */ }
      return;
    }
    if (conn.replicaGeneration) {
      const replacementGeneration = {
        connectionEpochId: conn.connectionEpochId,
        replicaGeneration: conn.replicaGeneration,
      };
      // Fence new catalog readers first, then wait for already-authorized
      // persist/dispatch work. Revalidate the socket after the await because a
      // concurrent clear may have completed while this caller was queued.
      try {
        await this.machineCatalogAuthority.beginReplacement(
          machineId,
          replacementGeneration,
        );
      } catch (error) {
        if (error instanceof MachineCatalogStaleError) return;
        throw error;
      }
      const current = this.machineConnections.get(machineId);
      if (!current || current.ws !== conn.ws) {
        this.machineCatalogAuthority.completeReplacement(
          machineId,
          replacementGeneration,
        );
        return;
      }
      conn = current;
    }

    const hadHeartbeatTimer = Boolean(conn.heartbeatTimer);
    if (conn.heartbeatTimer) this.clock.cancelRepeated(conn.heartbeatTimer);
    if (conn.wsPingTimer) {
      this.clock.cancelRepeated(conn.wsPingTimer);
      conn.wsPingTimer = null;
    }
    if (conn.runtimeAccountUsageTimer) this.clock.cancelRepeated(conn.runtimeAccountUsageTimer);
    // Cancel any in-flight capabilities-persist retry: once the daemon is gone
    // there is nothing to converge, and the next `ready` on reconnect re-enqueues.
    this.cancelPendingCapabilities(machineId);
    try {
      if (conn.ws.readyState === 1) conn.ws.close(close?.code, close?.reason);
    } catch { /* ignore */ }
    this.machineConnections.delete(machineId);
    // RFC 069 §8: this process can no longer send status; a reconnect starts a
    // fresh sequence check, so its versions only hold memory.
    if (conn.daemonInstanceId) {
      for (const [agentId, version] of this.sequencedStatusVersions) {
        if (version.daemonInstanceId === conn.daemonInstanceId) this.sequencedStatusVersions.delete(agentId);
      }
    }
    if (conn.replicaGeneration) {
      this.machineCatalogAuthority.completeReplacement(machineId, {
        connectionEpochId: conn.connectionEpochId,
        replicaGeneration: conn.replicaGeneration,
      });
    }
    this.lastIngressReplicaRefreshAt.delete(machineId);
    this.recordEvent("server.machine.websocket.heartbeat_timer", {
      machine_id: machineId,
      server_id: conn.serverId,
      machine_id_present: Boolean(machineId),
      server_id_present: Boolean(conn.serverId),
      timer_present: hadHeartbeatTimer,
      outcome: "cleared",
    });

    if (unregisterReplica) {
      // Drop the meta mirror too so non-owner replicas don't keep returning
      // stale state after the daemon hangs up. The TTL would evict orphans
      // eventually, but clean unregister is cheaper and keeps REST reads
      // consistent with the offline status event.
      await this.commitMachineReplicaDisconnectState(
        machineId,
        conn.replicaGeneration ?? undefined,
      );
    }
  }

  private cancelPendingMachineDisconnect(machineId: string): boolean {
    const pending = this.pendingMachineDisconnects.get(machineId);
    if (!pending) return false;
    this.clock.clearTimeout(pending.timer);
    this.pendingMachineDisconnects.delete(machineId);
    return true;
  }

  private async commitMachineReplicaDisconnectState(
    machineId: string,
    expectedGeneration?: string,
  ): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const operations = Promise.allSettled([
      this.replicaStateStore.unregisterMachineReplica(machineId, expectedGeneration),
      this.replicaStateStore.clearMachineMeta(machineId),
    ]);
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => resolve("timeout"), MACHINE_REPLICA_UNREGISTER_TIMEOUT_MS);
    });

    const result = await Promise.race([operations, timeoutPromise]);
    if (timeout) clearTimeout(timeout);
    if (result === "timeout") {
      console.warn(`[Machine ${machineId}] Timed out unregistering replica state before offline emit`);
      return;
    }

    const rejected = result.filter((entry): entry is PromiseRejectedResult => entry.status === "rejected");
    if (rejected.length > 0) {
      const noun = rejected.length === 1 ? "entry" : "entries";
      console.warn(`[Machine ${machineId}] Failed to unregister ${rejected.length} replica state ${noun} before offline emit`);
    }
  }

  /**
   * A stale registration can finish after its successor and overwrite that
   * successor's owner generation. Reassert the exact generation already
   * committed for the currently active socket, then revalidate the socket and
   * generation after every async write. A replacement that lands while the
   * repair is in flight is repaired in turn; sustained churn fails closed
   * instead of leaving a request-ready local socket without a Redis owner.
   */
  private async convergeMachineReplicaAfterStaleCommit(
    machineId: string,
    staleGeneration: string,
  ): Promise<void> {
    let observedStoreGeneration = staleGeneration;

    for (let attempt = 0; attempt < MACHINE_REPLICA_REPAIR_MAX_REPLACEMENTS; attempt += 1) {
      const active = this.machineConnections.get(machineId);
      if (!active) {
        await this.replicaStateStore.unregisterMachineReplica(machineId, observedStoreGeneration);
        return;
      }

      const activeGeneration = active.replicaGeneration;
      if (!activeGeneration) {
        // A replacement still awaiting its own owner commit is not locally
        // request-ready. Remove only the stale write and let that pending
        // registration establish its own generation.
        await this.replicaStateStore.unregisterMachineReplica(machineId, observedStoreGeneration);
        return;
      }

      try {
        await this.replicaStateStore.restoreMachineReplicaGeneration(
          machineId,
          activeGeneration,
          active.traceContext ?? buildRuntimeTraceContext(),
        );
      } catch (err) {
        await Promise.allSettled([
          this.replicaStateStore.unregisterMachineReplica(machineId, observedStoreGeneration),
          this.replicaStateStore.unregisterMachineReplica(machineId, activeGeneration),
        ]);
        if (
          this.machineConnections.get(machineId)?.ws === active.ws
          && active.replicaGeneration === activeGeneration
        ) {
          await this.clearMachineConnection(machineId, false, {
            code: 1011,
            reason: "replica_registration_failed",
          }, active.ws);
        }
        throw err;
      }

      observedStoreGeneration = activeGeneration;
      const current = this.machineConnections.get(machineId);
      if (current?.ws === active.ws && current.replicaGeneration === activeGeneration) return;
    }

    await this.replicaStateStore.unregisterMachineReplica(machineId, observedStoreGeneration)
      .catch(() => undefined);
    const current = this.machineConnections.get(machineId);
    if (current) {
      await this.clearMachineConnection(machineId, true, {
        code: 1011,
        reason: "replica_registration_failed",
      }, current.ws);
    }
    throw new Error("Machine replica registration repair did not converge");
  }

  protected async isLegacyMachinePrincipalMigrated(machineId: string): Promise<boolean> {
    const machine = await machineService.getMachine(asMachineId(machineId));
    return Boolean(machine?.legacyKeyMigratedAt);
  }

  private async isLegacyPrincipalFenced(machineId: string): Promise<boolean> {
    if (this.legacyPrincipalFences.has(machineId)) return true;
    const migrated = await this.isLegacyMachinePrincipalMigrated(machineId);
    // Re-check the process-local fence after the DB await. The adoption CAS
    // broadcast can land while this read is in flight.
    return migrated || this.legacyPrincipalFences.has(machineId);
  }

  /** Going-away for a connection that arrived after the drain started: closed
   * with 1001 `server_draining` and never registered, so it is neither owned
   * by this replica nor left for the ALB to cut. Counted and logged per
   * refusal; prod acceptance for task #268 reads how often this fires. */
  private async refuseMachineConnectionWhileDraining(
    machineId: string,
    ws: WebSocket,
    traceContext: MachineConnectTraceContext,
  ): Promise<void> {
    this.drainRefusedMachineConnections += 1;
    try {
      if (ws.readyState === 1) ws.close(MACHINE_DRAIN_CLOSE_CODE, MACHINE_DRAIN_CLOSE_REASON);
    } catch {
      // The socket is already torn down; nothing was registered either way.
    }
    console.log(
      `[Slock] Drain going-away: refused new machine connection while draining (machine=${machineId}, refused_total=${this.drainRefusedMachineConnections})`,
    );
    this.tracer.emitEvent("server.machine.connection.refused_while_draining", {
      surface: "server",
      attrs: {
        machine_id: machineId,
        drain_refused_total: this.drainRefusedMachineConnections,
        ...projectMachineConnectTraceAttrs(traceContext),
      },
    });
    // Counted after the socket is closed: refused before register/ready, so
    // the version is the one the machine last reported (its record). At most
    // one read per refusal, only during a drain.
    const version = await this.loadMachineDaemonVersion(machineId).catch(() => null);
    machineConnectionsRefusedTotal.inc({ reason: "draining", daemon_version: daemonVersionLabel(version) });
  }

  private closeUnregisteredLegacySocket(ws: WebSocket): void {
    try {
      if (ws.readyState === 1) {
        ws.close(LEGACY_PRINCIPAL_FENCED_CLOSE_CODE, LEGACY_PRINCIPAL_FENCED_CLOSE_REASON);
      }
    } catch {
      // The caller still returns without registering ownership.
    }
  }

  async fenceMachinePrincipalConnections(
    machineId: string,
    principalKind: "legacy_machine",
  ): Promise<boolean> {
    this.legacyPrincipalFences.add(machineId);
    const conn = this.machineConnections.get(machineId);
    if (!conn || conn.principalKind !== principalKind) return false;

    try {
      conn.ws.close(LEGACY_PRINCIPAL_FENCED_CLOSE_CODE, LEGACY_PRINCIPAL_FENCED_CLOSE_REASON);
    } catch {
      // Disconnect handling below removes server-side ownership even when the
      // transport has already torn down.
    }
    await this.handleMachineDisconnect(machineId, conn.ws, {
      cause: LEGACY_PRINCIPAL_FENCED_CLOSE_REASON,
      closeCode: LEGACY_PRINCIPAL_FENCED_CLOSE_CODE,
      closeReason: LEGACY_PRINCIPAL_FENCED_CLOSE_REASON,
    });
    return true;
  }

  async registerMachine(
    machineId: string,
    serverId: string,
    ws: WebSocket,
    traceContext: MachineConnectTraceContext = buildRuntimeTraceContext(),
    principalKind: MachineConnectionPrincipalKind = "unknown",
    /** The epoch `machine:context` already carried (task #365); minted here when absent. */
    connectionEpochId: string = newMachineConnectionEpochId(machineId),
  ) {
    if (this.drainingMachineConnections) {
      await this.refuseMachineConnectionWhileDraining(machineId, ws, traceContext);
      return;
    }
    const replacedExistingConnection = this.machineConnections.has(machineId);
    const canceledPendingDisconnect = this.cancelPendingMachineDisconnect(machineId);
    const connectionTraceAttrs = projectMachineConnectTraceAttrs(traceContext);
    const span = this.tracer.startSpan("server.machine.connection.register", {
      parent: getCurrentTraceContext(),
      surface: "server",
      kind: "internal",
      attrs: {
        machine_id: machineId,
        server_id: serverId,
        machine_id_present: Boolean(machineId),
        server_id_present: Boolean(serverId),
        replaced_existing_connection: replacedExistingConnection,
        canceled_pending_disconnect: canceledPendingDisconnect,
        principal_kind: principalKind,
        ...connectionTraceAttrs,
      },
    });
    await this.runInActiveSpan(span, async () => {
      // A same-replica reconnect is a connection handoff, not a true ownership drop.
      // If we unregister the replica mapping here, the stale async delete can land after
      // the fresh register and briefly strand the machine as "offline" to other replicas.
      try {
        const current = this.machineConnections.get(machineId);
        if (
          principalKind === "legacy_machine"
          && (current?.principalKind === "computer" || await this.isLegacyPrincipalFenced(machineId))
        ) {
          this.closeUnregisteredLegacySocket(ws);
          span.end("ok", { attrs: { outcome: "legacy_principal_fenced" } });
          return;
        }

        // Task #374: the winner of a duplicate decision is still alive; this
        // connection would take its lease and restart the kicking. Refused
        // before anything is registered or replaced.
        const hold = await this.heldDuplicateMachineConnection(machineId);
        if (hold) {
          machineDuplicateConnectionActionsTotal.inc({
            action: "refused_held",
            daemon_version: daemonVersionLabel(hold.closedDaemonVersion),
          });
          await this.replicaStateStore.touchMachineDuplicateHold?.(machineId, AgentOrchestrator.DUPLICATE_HOLD_TTL_SECONDS)
            .catch(() => {});
          if (ws.readyState === 1) ws.close(DUPLICATE_MACHINE_CONNECTION_CLOSE_CODE, MACHINE_DUPLICATE_CONNECTION_HELD_CLOSE_REASON);
          span.end("ok", { attrs: { outcome: "duplicate_machine_connection_held" } });
          return;
        }

        await this.clearMachineConnection(machineId, false);

        const conn: MachineConnection = {
          ws,
          machineId,
          serverId,
          principalKind,
          connectionEpochId,
          replicaGeneration: null,
          heartbeatTimer: null,
          wsPingTimer: null,
          runtimeAccountUsageTimer: null,
          lastPong: this.clock.now(),
          lastIngressAt: this.clock.now(),
          connectedAt: this.clock.now(),
          previousCloseAt: this.machineLastDisconnectAt.get(machineId),
          daemonVersion: null,
          capabilities: new Set(),
          runtimes: null,
          runtimeVersions: {},
          migrationTransport: null,
          shutdownIntent: null,
          computerVersion: null,
          daemonInstanceId: null,
          traceContext,
        };

        this.startMachineHeartbeat(machineId, conn);

        // Taken by this connection: a later `ready` on another session must
        // not find an older session's close here.
        this.machineLastDisconnectAt.delete(machineId);
        this.machineConnections.set(machineId, conn);

        // A legacy handshake can authenticate immediately before the adoption
        // CAS and finish registering immediately after it. Revalidate after the
        // connection becomes locally visible: a fence that lands before this
        // point is observed by the set/DB check; one that lands after this point
        // sees the registered principal and closes it.
        if (principalKind === "legacy_machine" && await this.isLegacyPrincipalFenced(machineId)) {
          if (this.machineConnections.get(machineId)?.ws === ws) {
            await this.fenceMachinePrincipalConnections(machineId, principalKind);
          } else {
            this.closeUnregisteredLegacySocket(ws);
          }
          span.end("ok", { attrs: { outcome: "legacy_principal_fenced" } });
          return;
        }

        // Commit the machine→replica owner mapping in Redis BEFORE emitting the
        // online status event. The web client treats receipt of this event as the
        // trigger for an authoritative reloadMachines REST; that REST can land on a
        // different replica and resolve cross-replica reachability from the owner
        // mapping. If we emit online before the mapping is committed, the soonest
        // cross-replica read returns offline and the client (which has no repair /
        // re-poll loop) latches offline until a manual refresh — the multi-replica
        // "restart -> offline -> never auto online" symptom (#wg-raft-computer #89).
        // Registration is the readiness commit for this connection. Surfacing
        // online or accepting queued work without it strands cross-replica
        // requests behind an owner key that was never established.
        try {
          const replicaGeneration = requireReplicaGeneration(
            await this.replicaStateStore.registerMachineReplica(machineId, traceContext),
          );
          const activeConnection = this.machineConnections.get(machineId);
          if (activeConnection?.ws !== ws) {
            if (activeConnection) {
              let activeGeneration: string;
              try {
                activeGeneration = requireReplicaGeneration(
                  await this.replicaStateStore.registerMachineReplica(
                    machineId,
                    activeConnection.traceContext ?? buildRuntimeTraceContext(),
                  ),
                );
              } catch (err) {
                // The stale commit replaced the successor's earlier lease, so a
                // failed recommit cannot leave that successor request-ready.
                await this.replicaStateStore.unregisterMachineReplica(machineId, replicaGeneration)
                  .catch(() => undefined);
                if (this.machineConnections.get(machineId)?.ws === activeConnection.ws) {
                  await this.clearMachineConnection(machineId, false, {
                    code: 1011,
                    reason: "replica_registration_failed",
                  }, activeConnection.ws);
                }
                throw err;
              }
              if (this.machineConnections.get(machineId)?.ws === activeConnection.ws) {
                activeConnection.replicaGeneration = activeGeneration;
              } else {
                // The successor disconnected or was replaced while its repair
                // commit was in flight. Exact cleanup is sufficient for a
                // disconnect; a replacement must also have its already-committed
                // generation reasserted because the stale repair overwrote it.
                await this.convergeMachineReplicaAfterStaleCommit(machineId, activeGeneration);
              }
            } else {
              // The stale registration completed after every local connection
              // disappeared. Do not leave its lease routable for the full TTL.
              await this.replicaStateStore.unregisterMachineReplica(machineId, replicaGeneration);
            }
            try {
              if (ws.readyState === 1) ws.close(1000, "superseded_connection");
            } catch { /* ignore */ }
            span.end("ok", { attrs: { outcome: "superseded_connection" } });
            return;
          }
          conn.replicaGeneration = replicaGeneration;
          // machine_id + server_id (plain, as on the connect span and the
          // daemon's events) let a rollout readout join each Computer's
          // disconnect with the task it re-registered on (instance_id, version).
          this.recordEvent("machine.replica.register_committed", {
            outcome: "committed",
            machine_id: machineId,
            server_id: serverId,
            ...connectionTraceAttrs,
          });
        } catch (err) {
          console.error(
            `[Machine ${machineId}] Failed to register replica mapping:`,
            err instanceof Error ? err.message : err,
          );
          this.recordEvent("machine.replica.register_failed", {
            outcome: "failed",
            reason: "replica_register_failed",
            error_class: errorClassOf(err),
          });
          await this.clearMachineConnection(machineId, false, {
            code: 1011,
            reason: "replica_registration_failed",
          }, ws);
          span.end("error", {
            attrs: {
              outcome: "replica_register_failed",
              reason: "replica_register_failed",
              error_class: errorClassOf(err),
            },
          });
          return;
        }

        const statusVersion = await this.bumpMachineStatusVersion(machineId);

        this.io?.to(`server:${serverId}`).emit("machine:status", {
          machineId,
          status: "online",
          statusVersion,
        });
        this.emit("machine:online", { machineId, serverId });
        this.recordEvent("machine.status.emitted", {
          outcome: "emitted",
          status: "online",
          status_version: statusVersion,
        });
        try {
          const recovery = await recordComputerOnlineTransition({
            serverId,
            machineId,
            now: new Date(this.clock.now()),
          });
          this.recordEvent("machine.outage_recovery.recorded", {
            outcome: "recorded",
            recovered_count: recovery.recovered,
            suppressed_flaps_count: recovery.suppressedFlaps,
            offline_emitted_count: recovery.offlineEmitted,
            online_emitted_count: recovery.onlineEmitted,
          });
        } catch (err) {
          console.warn(
            `[Machine ${machineId}] Failed to record Computer outage recovery:`,
            err instanceof Error ? err.message : err,
          );
          this.recordEvent("machine.outage_recovery.failed", {
            outcome: "failed",
            error_class: errorClassOf(err),
          });
        }
        this.retryPendingAgentDeliveriesForMachine(machineId, "register");
        this.retryPendingAgentStartsForMachine(machineId, "register");

        // Auto-assign this machine to any BYOC agents in the server that have no machine
        try {
          await this.autoAssignConnectedMachine(serverId, machineId);
          this.recordEvent("machine.auto_assign.completed", {
            outcome: "completed",
          });
        } catch (err) {
          console.error(`[Machine ${machineId}] Failed to auto-assign agents:`, err);
          this.recordEvent("machine.auto_assign.failed", {
            outcome: "failed",
            reason: "auto_assign_failed",
            error_class: errorClassOf(err),
          });
        }

        console.log(`[Machine ${machineId}] Connected (server: ${serverId})`);
        span.end("ok", { attrs: { outcome: "registered", status_version: statusVersion } });
      } catch (err) {
        span.end("error", {
          attrs: {
            outcome: "error",
            reason: "direct_delivery_exception",
            error_class: errorClassOf(err),
          },
        });
        throw err;
      }
    });
  }

  async unregisterMachine(machineId: string): Promise<void> {
    this.cancelPendingMachineDisconnect(machineId);
    await this.clearMachineConnection(machineId, true);
  }

  /**
   * Closes this replica's socket for `machineId`, if it holds one authenticated
   * by the key that changed. Any close makes the daemon reconnect; the
   * handshake then accepts the new key or refuses the old one with its usual
   * reason. Reached on every replica through dropMachineConnectionEverywhere.
   */
  async dropMachineConnectionForCredentialChange(
    machineId: string,
    reason: "credential_rotated" | "credential_revoked",
  ): Promise<boolean> {
    const conn = this.machineConnections.get(machineId);
    // Only the connection the changed key authenticated: rotating the legacy
    // sk_machine_* key leaves a Computer connection on the same machine alone,
    // and revoking a Computer leaves a legacy one alone.
    const affectedPrincipal = reason === "credential_rotated" ? "legacy_machine" : "computer";
    if (!conn || conn.principalKind !== affectedPrincipal) return false;
    const closeReason = `machine_${reason}` as const;
    try {
      conn.ws.close(MACHINE_CREDENTIAL_CHANGED_CLOSE_CODE, closeReason);
    } catch {
      // `handleMachineDisconnect` below still removes server-side ownership.
    }
    await this.handleMachineDisconnect(machineId, conn.ws, {
      cause: closeReason,
      closeCode: MACHINE_CREDENTIAL_CHANGED_CLOSE_CODE,
      closeReason,
    });
    const pending = this.pendingMachineDisconnects.get(machineId);
    if (pending) {
      await this.applyMachineDisconnectProjection(machineId, pending);
    }
    return true;
  }

  async disconnectMachineForUnlink(machineId: string): Promise<boolean> {
    const conn = this.machineConnections.get(machineId);
    if (!conn) return false;

    try {
      conn.ws.close(MACHINE_UNLINKED_CLOSE_CODE, MACHINE_UNLINKED_CLOSE_REASON);
    } catch {
      // `handleMachineDisconnect` below still removes server-side ownership.
    }

    await this.handleMachineDisconnect(machineId, conn.ws, {
      cause: MACHINE_UNLINKED_CLOSE_REASON,
      closeCode: MACHINE_UNLINKED_CLOSE_CODE,
      closeReason: MACHINE_UNLINKED_CLOSE_REASON,
    });
    const pending = this.pendingMachineDisconnects.get(machineId);
    if (pending) {
      await this.applyMachineDisconnectProjection(machineId, pending);
    }
    return true;
  }

  /**
   * Going-away for every live machine connection, paced per connection
   * across the caller's budget (task #261).
   *
   * Called when this task starts draining (or as a SIGTERM fallback). The
   * sockets are closed with 1001 `server_draining`; each close still runs
   * the normal ws `close` handler, so connection bookkeeping stays on the
   * existing path. See machineDrain.ts for the pacing semantics and the
   * measured-span result.
   */
  async closeMachineConnectionsForDrain(options?: {
    spreadMs?: number;
  }): Promise<{ closed: number; spanMs: number }> {
    // Refuse new connections from this point on (see drainingMachineConnections);
    // set before the snapshot so no connection can slip between the two.
    this.drainingMachineConnections = true;
    return closeConnectionsForDrain(this.machineConnections.values(), options);
  }

  /** True once the drain going-away has started on this task (task #268). */
  get isDrainingMachineConnections(): boolean {
    return this.drainingMachineConnections;
  }

  /** Machine connections refused with 1001 since the drain started. */
  get drainRefusedMachineConnectionCount(): number {
    return this.drainRefusedMachineConnections;
  }

  /** Get the daemon version for a connected machine (null if offline or unknown). */
  getMachineDaemonVersion(machineId: string): string | null {
    return this.machineConnections.get(machineId)?.daemonVersion ?? null;
  }

  /** True iff the connected daemon explicitly advertised this capability in `ready`. */
  hasMachineCapability(machineId: string | null | undefined, capability: string): boolean {
    if (!machineId) return false;
    return this.machineConnections.get(machineId)?.capabilities.has(capability) === true;
  }

  async getMachineMigrationTransport(machineId: string): Promise<MachineMigrationTransportState | null> {
    const local = this.machineConnections.get(machineId)?.migrationTransport;
    if (local) return local;
    if (!this.replicaStateStore.isAvailable()) return local ?? null;
    try {
      return migrationTransportFromMachineMeta(await this.replicaStateStore.getMachineMeta(machineId));
    } catch {
      return local ?? null;
    }
  }

  /**
   * Managed-Computer bundle version reported in `ready`, or null.
   *
   * Owner-replica fast path: read the in-memory `machineConnections`. If
   * this replica owns the machine connection, the value is already in
   * RAM and no Redis round-trip happens.
   *
   * Non-owner replica fallback: REST handlers land on whichever replica
   * the load balancer picked, not necessarily the owner; in that case the
   * in-memory map is empty and we fall back to the cross-replica meta
   * mirror in Redis (#wg-raft-computer task #95). Returns null when
   * neither has a value (Redis unavailable or never written).
   */
  async getMachineComputerVersion(machineId: string): Promise<string | null> {
    return (await this.getMachineComputerVersionFact(machineId))?.version ?? null;
  }

  /**
   * Live Computer-version fact used by source-aware broadcast policy.
   *
   * Value, freshness, and provenance travel together so no caller can admit
   * an upgrade from a value-only read. The owner uses current connection
   * ingress; non-owner replicas use the heartbeat-refreshed meta mirror.
   */
  async getMachineComputerVersionFact(machineId: string): Promise<ComputerSourceFact | null> {
    const local = this.machineConnections.get(machineId);
    if (local) {
      return {
        version: local.computerVersion ?? null,
        observedAt: new Date(local.lastIngressAt).toISOString(),
        provenance: "owner_connection",
      };
    }
    if (!this.replicaStateStore.isAvailable()) return null;
    try {
      const meta = await this.replicaStateStore.getMachineMeta(machineId);
      if (meta?.computerVersion === undefined && meta?.computerVersionObservedAt === undefined) {
        return null;
      }
      return {
        version: meta.computerVersion ?? null,
        observedAt: meta.computerVersionObservedAt ?? null,
        provenance: "replica_meta",
      };
    } catch {
      return null;
    }
  }

  /**
   * #proj-raft-computer task #34: advisory hint that the Computer's installer
   * needs a repair run on the machine (owner memory, else the Redis mirror);
   * null when there is nothing to hint or it was never reported (older Computers).
   */
  async getMachineInstallerRepairHint(machineId: string): Promise<ComputerInstallerRepairHint | null> {
    const local = this.machineConnections.get(machineId);
    if (local) return local.installerRepairHint ?? null;
    if (!this.replicaStateStore.isAvailable()) return null;
    try {
      const raw = (await this.replicaStateStore.getMachineMeta(machineId))?.installerRepairHint;
      return raw ? parseComputerInstallerRepairHint(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }

  /** Latest disk report of a connected machine (owner memory, else the Redis mirror). */
  async getMachineDiskStatus(machineId: string): Promise<MachineDiskStatus | null> {
    const local = this.machineConnections.get(machineId);
    if (local) return local.diskStatus ?? null;
    if (!this.replicaStateStore.isAvailable()) return null;
    try {
      const meta = await this.replicaStateStore.getMachineMeta(machineId);
      const disk = { availableBytes: Number(meta?.diskAvailableBytes), totalBytes: Number(meta?.diskTotalBytes) };
      return isValidMachineDiskStatus(disk) ? disk : null;
    } catch {
      return null;
    }
  }

  /** Latest memory report of a connected machine (owner memory, else the Redis mirror). */
  async getMachineMemoryStatus(machineId: string): Promise<MachineMemoryStatus | null> {
    const local = this.machineConnections.get(machineId);
    if (local) return local.memoryStatus ?? null;
    if (!this.replicaStateStore.isAvailable()) return null;
    try {
      const meta = await this.replicaStateStore.getMachineMeta(machineId);
      const memory = { availableBytes: Number(meta?.memoryAvailableBytes), totalBytes: Number(meta?.memoryTotalBytes) };
      return isValidMachineMemoryStatus(memory) ? memory : null;
    } catch {
      return null;
    }
  }

  /** Runtime binary/package versions reported by the current daemon ready frame. */
  async getMachineRuntimeVersions(machineId: string): Promise<Record<string, string>> {
    const local = this.machineConnections.get(machineId);
    if (local) return { ...(local.runtimeVersions ?? {}) };
    if (!this.replicaStateStore.isAvailable()) return {};
    try {
      return runtimeVersionsFromMachineMeta(await this.replicaStateStore.getMachineMeta(machineId));
    } catch {
      return {};
    }
  }

  /** WSL flavour from this replica's live connection; null when not WSL or not local. */
  getMachineOsVariant(machineId: string): "wsl1" | "wsl2" | null {
    return this.machineConnections.get(machineId)?.osVariant ?? null;
  }

  getMachineConnectionEpoch(machineId: string): string | null {
    return this.machineConnections.get(machineId)?.connectionEpochId ?? null;
  }

  /**
   * Relay a managed-Computer control command (restart / upgrade) over the
   * machine's live WS connection to its Computer service. Returns false if
   * the machine has no live connection (offline). Public wrapper over the
   * protected `sendToMachine` for the `/computer/:action` route.
   */
  async sendComputerControl(
    machineId: string,
    action: "restart" | "upgrade",
    operationId: string = crypto.randomUUID(),
  ): Promise<{ sent: boolean; requestId: string }> {
    // requestId-for-everything: the managed Computer threads this id through
    // the whole upgrade (progress frames + the post-restart `done` report).
    // It is REQUIRED for the SEA in-process upgrade path to trigger — without
    // it the runner falls back to the legacy detached `raft-computer upgrade`.
    const requestId = operationId;
    const sent = await this.sendToMachine(machineId, {
      type: action === "restart" ? "computer:restart" : "computer:upgrade",
      operationId,
      requestId,
    });
    return { sent, requestId };
  }

  /**
   * Remote upgrade v2 (task #873): send the exact target; the machine's next
   * reconnect is the only readback.
   */
  async sendComputerUpgrade(
    machineId: string,
    targetVersion: string,
    requestId: string,
    options: { drainMs?: number | null } = {},
  ): Promise<{ sent: boolean }> {
    const sent = await this.sendToMachine(machineId, {
      type: "computer:upgrade",
      operationId: requestId,
      requestId,
      targetVersion,
      ...(options.drainMs ? { drain: { deadlineMs: options.drainMs } } : {}),
    });
    return { sent };
  }

  /**
   * Reconciler step 13: how long a web upgrade of this Computer first waits
   * for its agents to finish their work, or null when its daemon cannot
   * drain (it does not advertise DAEMON_CAPABILITY_COMPUTER_UPGRADE_DRAIN_V1:
   * the upgrade runs at once, as before). No flag (Tenny Q-E); the daemon
   * clamps it again.
   */
  async computerUpgradeDrainMs(machineId: string): Promise<number | null> {
    return (await this.machineAdvertisesCapability(machineId, DAEMON_CAPABILITY_COMPUTER_UPGRADE_DRAIN_V1))
      ? COMPUTER_UPGRADE_DRAIN_MAX_DEADLINE_MS
      : null;
  }

  /** Reconciler step 13: the latest drain report of a Computer connected to this replica. */
  getComputerUpgradeDrain(machineId: string): ComputerUpgradeDrainProgress | null {
    return this.machineConnections.get(machineId)?.upgradeDrain ?? null;
  }
  protected claimPendingComputerLifecycleDispatches(machineIds: string[]) {
    return computerLifecycleOperationService.claimPendingComputerLifecycleDispatches(machineIds);
  }

  protected releaseComputerLifecycleDispatchLease(operationId: string) {
    return computerLifecycleOperationService.releaseComputerLifecycleDispatchLease(operationId);
  }

  protected markComputerLifecycleCommandSent(operationId: string) {
    return computerLifecycleOperationService.markComputerLifecycleCommandSent(operationId);
  }

  protected async loadComputerBroadcastMachine(
    machineId: string,
  ): Promise<{ os: string | null; installKind: DaemonInstallKind | null } | null> {
    const machine = await machineService.getMachine(asMachineId(machineId));
    return machine
      ? { os: machine.os, installKind: isDaemonInstallKind(machine.installKind) ? machine.installKind : null }
      : null;
  }

  protected evaluateComputerBroadcastPolicy(
    input: EvaluateComputerBroadcastPolicyInput,
  ): ComputerBroadcastPolicyDecision | Promise<ComputerBroadcastPolicyDecision> {
    return evaluateBroadcastPolicy(input);
  }

  protected async dispatchPendingComputerLifecycleOperations(): Promise<void> {
    const claimed = await this.claimPendingComputerLifecycleDispatches([
      ...this.machineConnections.keys(),
    ]);
    for (const operation of claimed) {
      await this.runInTraceSpan(
        "server.computer.operation.command",
        {
          attrs: {
            operation_id: operation.operationId,
            machine_id: operation.machineId,
            action: operation.action,
          },
        },
        async (): Promise<string> => {
          if (operation.action === "upgrade") {
            const machine = await this.loadComputerBroadcastMachine(operation.machineId);
            const decision = await this.evaluateComputerBroadcastPolicy({
              source: await this.getMachineComputerVersionFact(operation.machineId),
              platform: normalizeComputerPlatform(machine?.os),
              requestedTargetVersion: operation.targetVersion,
              now: new Date(this.clock.now()),
              serverId: operation.serverId,
              serviceUnreachable: this.hasMachineCapability(operation.machineId, COMPUTER_CAPABILITY_SERVICE_IPC_UNREACHABLE),
              installKind: machine?.installKind ?? null,
            });
            if (decision.reasonCode === "hands_unavailable") {
              // A temporary release-authority outage is not a withdrawn target.
              // Release the dispatch lease; the existing operation deadline still bounds retries.
              await this.releaseComputerLifecycleDispatchLease(operation.operationId);
              return "hands_unavailable";
            }
            if (!isQueuedComputerUpgradePolicyCompatible(
              operation.broadcastPolicyDecision,
              decision,
            )) {
              const reason = decision.eligibility === "no_broadcast"
                ? `computer_broadcast_revalidation_${decision.reasonCode}`
                : "computer_broadcast_revalidation_incompatible";
              await this.terminalizeComputerLifecycleOperation({
                operationId: operation.operationId,
                serverId: operation.serverId,
                machineId: operation.machineId,
                terminal: "failed",
                reason,
              });
              this.recordEvent("server.computer.operation.command.refused", {
                operation_id: operation.operationId,
                machine_id: operation.machineId,
                action: operation.action,
                policy_revision: decision.policyRevision ?? "unknown",
                policy_reason: decision.reasonCode,
                outcome: "refused",
              });
              return "refused";
            }
          }
          const { sent } = await this.sendComputerControl(
            operation.machineId,
            operation.action,
            operation.operationId,
          );
          if (!sent) {
            await this.releaseComputerLifecycleDispatchLease(operation.operationId);
            return "send_failed";
          }
          await this.markComputerLifecycleCommandSent(operation.operationId);
          this.recordEvent("server.computer.operation.command.sent", {
            operation_id: operation.operationId,
            machine_id: operation.machineId,
            action: operation.action,
            outcome: "sent",
          });
          return "sent";
        },
        (outcome) => ({ status: outcome === "refused" ? "error" : "ok", attrs: { outcome } }),
      );
    }
  }

  /**
   * Agent work for this machine is held: it is below the Computer version
   * floor and the deadline has passed (computerVersionFloorService). The owner
   * replica reads its connection; another replica evaluates the mirrored
   * version. Unknown machine state is not held (offline is handled apart).
   */
  async isMachineAgentWorkHeld(machineId: string): Promise<boolean> {
    const local = this.machineConnections.get(machineId);
    if (local) return local.versionGate?.enforced === true;
    const nowMs = this.clock.now();
    if (!this.computerVersionFloor.enforcementDue(nowMs)) return false;
    const serverId = await this.serverIdOfMachine(machineId);
    if (!serverId) return false;
    const policy = await this.computerVersionFloor.policy(nowMs, serverId);
    if (!policy?.enforcementEnabled) return false;
    const fact = await this.getMachineComputerVersionFact(machineId);
    if (!fact) return false;
    return evaluateComputerVersionGate(fact.version, policy, nowMs)?.enforced === true;
  }

  /**
   * Reconciler step 15 (B15): the machine's Computer access was revoked (its
   * key, and any other way it could connect: findAccessRevokedMachineIds), so
   * it can never come back under it. Its agents stay bound (Tenny Q-7) and
   * get no starts or wakes until they are moved or the key is live again. A
   * machine connected here is not revoked: a revoke drops its socket after
   * commit (deviceSessionKeys.closeDeviceSessionKeys), and while it is still
   * up it can run what it is sent. A failed read is not revoked (the start
   * then goes on as before and finds the machine offline).
   */
  async isMachineAccessRevoked(machineId: string): Promise<boolean> {
    if (this.machineConnections.has(machineId)) return false;
    try {
      return (await findAccessRevokedMachineIds(getDb(), [machineId])).has(machineId);
    } catch (error) {
      console.warn(`[Machine ${machineId}] Computer access check failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** A machine's server never changes, so the lookup is cached. */
  private readonly machineServerIds = new Map<string, string>();
  private async serverIdOfMachine(machineId: string): Promise<string | null> {
    const known = this.machineServerIds.get(machineId);
    if (known) return known;
    const machine = await machineService.getMachine(asMachineId(machineId)).catch(() => null);
    if (!machine) return null;
    this.machineServerIds.set(machineId, machine.serverId);
    return machine.serverId;
  }

  /**
   * Re-evaluate one connection's version gate (on `ready`, and every sweep so
   * a deadline passing or the emergency stop flipping takes effect without a
   * reconnect). Enforcing and lifting are trace events; a change is pushed to
   * the web as `machine:capabilities.versionGate`.
   */
  private async refreshMachineVersionGate(machineId: string, conn: MachineConnection, cause: "ready" | "sweep"): Promise<void> {
    let gate: ComputerVersionGate | null;
    try {
      gate = await this.computerVersionFloor.gate(conn.computerVersion, this.clock.now(), conn.serverId);
    } catch (error) {
      console.warn(`[Machine ${machineId}] version gate evaluation failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const before = cause === "ready" ? undefined : conn.versionGate ?? null;
    conn.versionGate = gate;
    const changed = cause === "sweep" && JSON.stringify(before) !== JSON.stringify(gate);
    if (changed) {
      this.io?.to(`server:${conn.serverId}`).emit("machine:capabilities", { machineId, versionGate: gate });
    }
    const attrs = {
      machine_id: machineId,
      server_id: conn.serverId,
      computer_version: conn.computerVersion ?? "",
      cause,
      held_agents: new Set([...this.pendingAgentDeliveryAcks.values()]
        .filter((pending) => pending.machineId === machineId && pending.parkedReason === "computer_version_held")
        .map((pending) => pending.msg.agentId)).size,
    };
    if (gate?.enforced && (cause === "ready" || before?.enforced !== true)) {
      this.recordEvent("server.computer.version_gate.enforced", { ...attrs, reason: gate.reason, min_version: gate.minVersion });
      return;
    }
    if (gate?.enforced) return;
    if (cause === "sweep") {
      if (before?.enforced) this.recordEvent("server.computer.version_gate.lifted", { ...attrs, lifted_by: "policy" });
      return;
    }
    // On `ready`: lifted when the version this machine last reported would be
    // held under the policy now in force (upgraded or reinstalled since).
    const policy = await this.computerVersionFloor.policy(this.clock.now(), conn.serverId).catch(() => null);
    if (!policy?.enforcementEnabled) return;
    const previous = await machineService.getRecordedMachineComputerVersion(machineId).catch(() => undefined);
    if (previous === undefined) return;
    if (evaluateComputerVersionGate(previous, policy, this.clock.now())?.enforced) {
      this.recordEvent("server.computer.version_gate.lifted", { ...attrs, lifted_by: "upgrade", previous_version: previous ?? "" });
    }
  }

  private async sweepComputerVersionGates(): Promise<void> {
    for (const [machineId, conn] of this.machineConnections) {
      // Not evaluated until this connection's `ready` (versionGate undefined).
      if (conn.versionGate === undefined) continue;
      await this.refreshMachineVersionGate(machineId, conn, "sweep");
    }
  }

  private async sweepComputerLifecycleOperations(): Promise<void> {
    try {
      const expired = await computerUpgradeRequestService.expireComputerUpgradeRequests(new Date(this.clock.now()));
      for (const row of expired) {
        this.recordEvent("server.computer.upgrade_request.expired", computerUpgradeRequestService.computerUpgradeRequestTraceAttrs(row));
        this.io?.to(`server:${row.serverId}`).emit("machine:upgrade-request", { machineId: row.machineId, upgradeRequest: computerUpgradeRequestService.projectComputerUpgradeRequest(row) });
      }
    } catch (error) {
      console.warn(`[Orchestrator] upgrade request expiry sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.runInTraceSpan(
      "server.computer.operation.sweep",
      {},
      async () => {
        const results = await computerLifecycleOperationService.expirePendingComputerLifecycleOperations();
        let terminalCount = 0;
        for (const result of results) {
          if (result.status !== "terminal") continue;
          terminalCount += 1;
          this.recordEvent("operation.terminal", {
            operation_id: result.fact.operationId,
            server_id: result.fact.serverId,
            machine_id: result.fact.machineId,
            action: result.fact.action,
            terminal: result.fact.terminal,
            outcome: result.fact.terminal,
          });
          this.recordEvent("activity.projected", {
            operation_id: result.fact.operationId,
            projection_count: result.projections.length,
            outcome: "history_only",
          });
        }
        return terminalCount;
      },
      (terminalCount) => ({ status: terminalCount > 0 ? "error" : "ok", attrs: { terminal_count: terminalCount } }),
    );
  }

  /**
   * A daemon that restarted before the flip lost its in-memory transfer run.
   * Only daemons that report every live run (AGENT_MIGRATION_CAPABILITY) are
   * trusted here. For each pre-flip migration involving this machine whose run
   * is missing from the report: a lost target run gets its lease re-issued
   * under the same generation (resumable download, no re-upload); a lost source
   * run before upload completion rotates to a new transport generation and
   * both daemons get fresh leases. The peer's old run is then rejected as stale
   * and its transport-lost report (tagged with the old generation) is ignored.
   * Mixed versions: an old peer daemon tags no generation, so its stale report
   * can still fail the new generation, no worse than before this recovery.
   */
  private async reprovisionLostMigrationTransfers(
    machineId: string,
    ready: { capabilities?: string[]; migrationTransport?: AgentMigrationTransportReady },
  ): Promise<void> {
    if (!ready.migrationTransport?.capabilities?.includes(AGENT_MIGRATION_CAPABILITY)) return;
    const reported = new Set((ready.migrationTransport?.activeLeases ?? [])
      .map((lease) => `${lease.migrationId}:${lease.transportGeneration}`));
    const migrations = await agentMigrationService.listAgentMigrationsAwaitingTransportOnMachine(machineId);
    for (const migration of migrations) {
      if (!migration.transportGeneration) continue;
      if (reported.has(`${migration.id}:${migration.transportGeneration}`)) continue;
      const role = migration.sourceMachineId === machineId ? "source" : "target";
      const recovery = agentMigrationService.agentMigrationLostRunRecovery(migration, role);
      if (recovery === "reissue_target_lease") {
        // Target lost its run: resume its download under the same generation.
        const delivery = await agentMigrationService.reissueAgentMigrationTargetLease({
          migrationId: migration.id,
          expectedTransportGeneration: migration.transportGeneration,
        });
        if (!delivery) continue;
        this.recordEvent("machine.ready.migration_target_lease_reissued", { outcome: "reissued" });
        await this.sendAgentMigrationTransportLease(delivery.machineId, delivery.message);
        continue;
      }
      if (recovery !== "rotate_generation") continue;
      // Source lost its run before the upload completed: start a new generation.
      const provision = await agentMigrationService.provisionAgentMigrationObjectStoreTransfer();
      const result = await agentMigrationService.reprovisionAgentMigrationTransport({
        migrationId: migration.id,
        expectedTransportGeneration: migration.transportGeneration,
        provision,
      });
      if (!result) continue;
      this.recordEvent("machine.ready.migration_transport_reprovisioned", {
        outcome: "reprovisioned",
        machine_role: role,
      });
      // A hosted target has no daemon: only the source gets the new generation.
      const sends = await Promise.allSettled([
        this.sendAgentMigrationTransportLease(result.source.machineId, result.source.message),
        ...(result.target ? [this.sendAgentMigrationTransportLease(result.target.machineId, result.target.message)] : []),
      ]);
      for (const send of sends) {
        if (send.status === "rejected") {
          // An offline target later gets its lease re-issued (same generation) when it reconnects.
          console.warn(`[Machine ${machineId}] Re-provisioned migration lease not delivered:`, send.reason);
        }
      }
    }
  }

  async sendAgentMigrationTransportLease(
    machineId: string,
    msg: Extract<ServerToMachineMessage, { type: "machine:migration_transport:lease" }>,
  ): Promise<void> {
    await this.sendRequiredToMachine(
      machineId,
      await this.withTargetIgnoreSourcesAcceptance(msg),
      "Machine WebSocket not ready for migration transfer lease",
    );
  }

  /**
   * Every source lease send (start, re-provision, reconnect) passes here, so
   * the flag follows what the target advertises now. A hosted target is not a
   * machine and gets no flag: the source keeps the summary it always sent.
   */
  private async withTargetIgnoreSourcesAcceptance(
    msg: Extract<ServerToMachineMessage, { type: "machine:migration_transport:lease" }>,
  ): Promise<Extract<ServerToMachineMessage, { type: "machine:migration_transport:lease" }>> {
    if (msg.role !== "source") return msg;
    const target = await this.getMachineMigrationTransport(msg.targetMachineId);
    return target?.capabilities?.includes(AGENT_MIGRATION_TARGET_IGNORE_SOURCES_CAPABILITY)
      ? { ...msg, targetAcceptsIgnoreSources: true }
      : msg;
  }

  protected getMachineResponseRelay() { return machineResponseRelay; }

  private recordMachineResponseRelay(event: string, attrs: Record<string, string | boolean>): void {
    this.recordEvent(`server.machine.response.${event}`, attrs);
  }

  async archiveAgentMigrationSourceWorkspace(
    machineId: string,
    input: { migrationId: string; agentId: string; migrationCreatedAt?: string },
  ): Promise<"archived" | "already_archived" | "source_absent"> {
    const requestId = crypto.randomUUID();
    if (!this.machineConnections.has(machineId)) {
      const response = await this.getMachineResponseRelay().request({
        requestId, machineId, type: "machine:migration:source_workspace_archive_result", ...input,
      }, 15_000, () => this.sendRequiredToMachine(machineId, {
        type: "machine:migration:source_workspace_archive", requestId, ...input,
      }), (event, attrs) => this.recordMachineResponseRelay(event, attrs));
      if (response.type !== "machine:migration:source_workspace_archive_result" || response.outcome === "error") {
        throw new AgentMigrationSourceArchiveError(
          response.type === "machine:migration:source_workspace_archive_result" ? response.errorCode : undefined,
        );
      }
      return response.outcome;
    }
    const eventName = `machine:response:${machineId}`;

    return new Promise((resolve, reject) => {
      const timeout = this.scheduleOnClock(() => {
        this.removeListener(eventName, handler);
        reject(new RouteFailureError(
          "daemon_timeout",
          "Migration source workspace archive timed out",
        ));
      }, 15_000);

      const handler = (message: MachineToServerMessage) => {
        if (
          message.type !== "machine:migration:source_workspace_archive_result"
          || message.requestId !== requestId
          || message.migrationId !== input.migrationId
          || message.agentId !== input.agentId
        ) {
          return;
        }

        this.clock.clearTimeout(timeout);
        this.removeListener(eventName, handler);
        if (message.outcome === "error") {
          reject(new AgentMigrationSourceArchiveError(message.errorCode));
          return;
        }
        resolve(message.outcome);
      };

      this.on(eventName, handler);
      void this.sendRequiredToMachine(
        machineId,
        {
          type: "machine:migration:source_workspace_archive",
          requestId,
          migrationId: input.migrationId,
          agentId: input.agentId,
          ...(input.migrationCreatedAt ? { migrationCreatedAt: input.migrationCreatedAt } : {}),
        },
        "Machine WebSocket not ready for migration source workspace archive",
      ).catch((error) => {
        this.clock.clearTimeout(timeout);
        this.removeListener(eventName, handler);
        reject(error);
      });
    });
  }

  async sendAgentMigrationCancel(
    machineId: string,
    msg: Extract<ServerToMachineMessage, { type: "machine:migration:cancel" }>,
  ): Promise<void> {
    await this.sendRequiredToMachine(machineId, msg, "Machine WebSocket not ready for migration cancellation");
  }

  protected observeComputerLifecycleAck(
    input: Parameters<typeof computerLifecycleOperationService.observeComputerLifecycleAck>[0],
  ) {
    return computerLifecycleOperationService.observeComputerLifecycleAck(input);
  }

  private async handleComputerLifecycleAcknowledgement(
    machineId: string,
    serverId: string,
    connectionEpoch: string,
    acknowledgement: ComputerLifecycleExecutionAck,
  ): Promise<void> {
    await this.runInTraceSpan(
      "server.computer.operation.ack.received",
      {
        attrs: {
          server_id: serverId,
          machine_id: machineId,
          action: acknowledgement.action,
          phase: acknowledgement.phase,
        },
      },
      async (): Promise<{ status: TraceStatus; attrs: TraceAttributes }> => {
        const result = await this.observeComputerLifecycleAck({
          machineId,
          serverId,
          connectionEpoch,
          acknowledgement,
        });
        if (result.status === "rejected") {
          return { status: "ok", attrs: { outcome: result.status } };
        }
        if (acknowledgement.phase === "ready" && acknowledgement.loadedComputerVersion) {
          await this.recordReportedMachineComputerVersion(
            machineId,
            acknowledgement.loadedComputerVersion,
            "lifecycle_ack",
          );
        }
        const operationId = result.status === "terminal" ? result.fact.operationId : result.operationId;
        this.recordEvent("operation.ack.received", {
          operation_id: operationId,
          action: acknowledgement.action,
          phase: acknowledgement.phase,
          outcome: result.status,
        });
        if (result.status === "terminal") {
          this.recordEvent("operation.terminal", {
            operation_id: operationId,
            server_id: serverId,
            machine_id: machineId,
            action: result.fact.action,
            terminal: result.fact.terminal,
            outcome: result.fact.terminal,
          });
          this.recordEvent("activity.projected", {
            operation_id: operationId,
            projection_count: result.projections.length,
            outcome: "history_only",
          });
        }
        await this.sendToMachine(machineId, {
          type: "computer:lifecycle:receipt",
          operationId: computerLifecycleOperationService.resolveComputerLifecycleOperationId(acknowledgement)
            ?? operationId,
          phase: acknowledgement.phase,
        });
        return {
          status: result.status === "terminal" && result.fact.terminal !== "completed" ? "error" : "ok",
          attrs: { operation_id: operationId, outcome: result.status },
        };
      },
      (outcome) => outcome,
    );
  }


  protected terminalizeComputerLifecycleOperation(
    input: Parameters<typeof computerLifecycleOperationService.terminalizeComputerLifecycleOperation>[0],
  ) {
    return computerLifecycleOperationService.terminalizeComputerLifecycleOperation(input);
  }

  private async sendComputerLifecycleFailureReceipts(
    machineId: string,
    operationId: string,
    terminalization: Awaited<ReturnType<typeof computerLifecycleOperationService.terminalizeComputerLifecycleOperation>>,
  ): Promise<void> {
    if (terminalization.status !== "terminal") return;
    await this.sendToMachine(machineId, {
      type: "computer:lifecycle:receipt",
      operationId,
      phase: "shutdown",
    });
    await this.sendToMachine(machineId, {
      type: "computer:lifecycle:receipt",
      operationId,
      phase: "ready",
    });
  }

  /**
   * The daemon version a start dispatch must reason about. The local
   * connection is authoritative when this replica owns the machine; otherwise
   * the owner replica's shared machine meta carries the same `ready` fact.
   * Task #1129: a replica without the connection used to read null here,
   * dispatched the start without a launchId, and left the agent guarded on
   * the previous launch — every frame of the new process was then dropped.
   */
  protected async resolveMachineDaemonVersionForStart(machineId: string): Promise<string | null> {
    const local = this.getMachineDaemonVersion(machineId);
    if (local) return local;
    if (!this.replicaStateStore.isAvailable()) return null;
    try {
      return (await this.replicaStateStore.getMachineMeta(machineId))?.daemonVersion ?? null;
    } catch {
      return null;
    }
  }

  /** Check if a daemon supports the launchId lifecycle guard (requires >= 0.30.1). */
  private async daemonSupportsLaunchGuard(machineId: string): Promise<boolean> {
    return supportsLaunchGuardForDaemonVersion(await this.resolveMachineDaemonVersionForStart(machineId));
  }

  /** The guard state a start dispatch found, so a failed send can put it back. */
  protected snapshotLaunchGuard(agentId: string): Pick<CachedAgentState, "expectedLaunchId" | "launchGuardMode"> {
    const cached = this.agentStateCache.get(agentId);
    return {
      expectedLaunchId: cached?.expectedLaunchId ?? null,
      launchGuardMode: cached?.launchGuardMode ?? "legacy",
    };
  }

  /**
   * Arm the guard for the launch about to be sent, or — when this start
   * cannot carry a launchId — drop to legacy so the frames it produces are
   * not rejected against a launch that is no longer running. A start that
   * goes out without a launchId while the agent stays guarded is exactly the
   * fleet-wide drop of 2026-09-14.
   */
  protected async prepareStartLaunchGuard(agentId: string, machineId: string | null): Promise<string | undefined> {
    const launchId = await this.planStartLaunchId(machineId);
    this.armStartLaunchGuard(agentId, launchId);
    await this.stampRuntimeErrorRecoveryLaunch(agentId, launchId);
    return launchId;
  }

  /** The launchId a start will carry (a plain value; nothing is armed), or undefined when the daemon cannot carry one. */
  protected async planStartLaunchId(machineId: string | null): Promise<string | undefined> {
    if (!machineId || !(await this.daemonSupportsLaunchGuard(machineId))) return undefined;
    return crypto.randomUUID();
  }

  /** Arm the guard for a planned launch, or drop to legacy when the start carries none. */
  protected armStartLaunchGuard(agentId: string, launchId: string | undefined): void {
    if (launchId === undefined) {
      this.clearLaunchGuard(agentId);
      return;
    }
    this.setLaunchGuard(agentId, launchId);
  }

  /**
   * A send that failed did not replace the running process, so the guard
   * goes back to what it was — not to legacy, which would accept frames from
   * any launch. RFC 071 §4.3 (H-13): compare-and-restore. Only while the
   * guard is still the one this start armed; a concurrent start that armed
   * its own guard since keeps it.
   */
  protected rollbackStartLaunchGuard(
    agentId: string,
    previous: Pick<CachedAgentState, "expectedLaunchId" | "launchGuardMode">,
    armedLaunchId: string | undefined,
  ) {
    const current = this.snapshotLaunchGuard(agentId);
    const stillOurs = armedLaunchId === undefined
      ? current.expectedLaunchId === null && current.launchGuardMode === "legacy"
      : current.expectedLaunchId === armedLaunchId;
    if (!stillOurs) {
      this.recordEvent("terminal_breaker.rollback", { step: "guard", outcome: "rollback_skipped_not_owner" });
      return;
    }
    this.updateCache(agentId, { expectedLaunchId: previous.expectedLaunchId, launchGuardMode: previous.launchGuardMode });
  }

  /** Resolve current machine status from live reachability instead of trusting stale DB state. */
  async getMachineStatus(machineId: string): Promise<"online" | "offline"> {
    if (this.hasMachineLocally(machineId)) return "online";
    if (this.pendingMachineDisconnects.has(machineId)) return "online";
    if (this.replicaStateStore.isAvailable()) {
      const ownerReplica = await this.replicaStateStore.getMachineReplicaOwner(machineId);
      return ownerReplica && ownerReplica !== REPLICA_ID ? "online" : "offline";
    }
    return "offline";
  }

  /**
   * Runtimes reported in the daemon `ready` message for a locally-connected
   * machine, straight from the live connection (same live "Ready" event as the
   * client machine:capabilities emit). Null before `ready` is processed or when
   * the machine is not connected on this replica. Used by server-authoritative
   * readiness so its runtime fact stays same-source with the client card
   * instead of reading the lagging persisted `machines.runtimes` column.
   */
  getMachineRuntimes(machineId: string): string[] | null {
    return this.machineConnections.get(machineId)?.runtimes ?? null;
  }

  private async getMachineOwnerTraceAttrs(machineId: string): Promise<Record<string, unknown>> {
    const localConn = this.machineConnections.get(machineId);
    if (localConn?.ws.readyState === 1) {
      return {
        ...projectOwnerTraceAttrs(localConn.traceContext ?? buildRuntimeTraceContext()),
        owner_replica_present: true,
        owner_replica_current: true,
      };
    }
    if (!this.replicaStateStore.isAvailable()) {
      return {
        ...projectOwnerTraceAttrs(null),
        owner_replica_present: false,
        owner_replica_current: false,
      };
    }
    try {
      const [ownerReplica, ownerContext] = await Promise.all([
        this.replicaStateStore.getMachineReplicaOwner(machineId),
        this.replicaStateStore.getMachineReplicaTraceContext?.(machineId) ?? Promise.resolve(null),
      ]);
      return {
        ...projectOwnerTraceAttrs(ownerContext),
        owner_replica_present: Boolean(ownerReplica),
        owner_replica_current: ownerReplica === REPLICA_ID,
      };
    } catch {
      return {
        ...projectOwnerTraceAttrs(null),
        owner_replica_present: false,
        owner_replica_current: false,
      };
    }
  }

  /** What the agent archive dispatch needs from this replica. */
  agentArchiveDispatchPort(): AgentArchiveDispatchPort {
    return {
      localMachineIds: () => [...this.machineConnections.keys()].filter((machineId) => this.hasMachineLocally(machineId)),
      hasMachineLocally: (machineId) => this.hasMachineLocally(machineId),
      deleteMachineWorkspaceDir: (machineId, directoryName) => this.deleteMachineWorkspaceDir(machineId, directoryName).then(
        (ok) => (ok ? "deleted" : "failed"),
        // A large workspace can take longer than the wait; the Computer keeps deleting.
        (err: unknown) => (err instanceof Error && err.message === WORKSPACE_DELETE_TIMED_OUT ? "timed_out" : Promise.reject(err)),
      ),
    };
  }

  dispatchPendingAgentArchiveOps(): Promise<void> {
    return dispatchPendingAgentArchiveOps(this.agentArchiveDispatchPort(), this.io);
  }

  /** One Computer's ops only (it just sent `ready`); the 30 s sweep covers every other Computer. */
  dispatchPendingAgentArchiveOpsForMachine(machineId: string): Promise<void> {
    return dispatchPendingAgentArchiveOps(this.agentArchiveDispatchPort(), this.io, { machineIds: [machineId] });
  }

  /** Check if a machine is connected to THIS replica (for fly-replay routing). */
  hasMachineLocally(machineId: string): boolean {
    const conn = this.machineConnections.get(machineId);
    return !!conn
      && conn.replicaGeneration !== null
      && conn.ws.readyState === 1
      && !this.isMachineHeartbeatStale(conn);
  }

  /** Close all machine connections and timers (for graceful shutdown). */
  async shutdown(): Promise<void> {
    this.stopReadyOwedWakePasses();
    this.localInboxes.clearAll();
    if (this.spawnErrorRetryTimer) {
      this.clock.cancelRepeated(this.spawnErrorRetryTimer);
      this.spawnErrorRetryTimer = null;
    }
    if (this.staleActivityTimer) {
      this.clock.cancelRepeated(this.staleActivityTimer);
      this.staleActivityTimer = null;
    }
    for (const timer of this.activityDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.activityDebounceTimers.clear();
    for (const timer of this.pauseRetryTimers.values()) this.clock.clearTimeout(timer);
    this.pauseRetryTimers.clear();
    for (const pending of this.pendingMachineDisconnects.values()) {
      this.clock.clearTimeout(pending.timer);
    }
    this.pendingMachineDisconnects.clear();
    let shutdownPending = 0;
    let shutdownPendingParked = 0;
    for (const pending of this.pendingAgentDeliveryAcks.values()) {
      if (pending.timer) this.clock.clearTimeout(pending.timer);
      this.recordAgentDeliveryOutcome(pending, "replica_shutdown");
      shutdownPending += 1;
      if (pending.parked) shutdownPendingParked += 1;
    }
    this.pendingAgentDeliveryAcks.clear();
    this.gaveUpAgentDeliveries.clear();
    releaseAgentDeliveryPending(this.agentDeliveryPendingProvider);
    // The replica_shutdown counter is incremented as the process exits, after
    // the last metrics scrape, so it never reaches AMP. This line is the only
    // count of delivery records still awaiting an ack when a replica stops.
    // Logged even at 0, so a missing line means shutdown did not run.
    console.log(`[Orchestrator] shutdown: ${shutdownPending} agent deliveries still awaiting ack (${shutdownPendingParked} parked)`);
    for (const pending of this.pendingAgentStartAcks.values()) {
      if (pending.timer) this.clock.clearTimeout(pending.timer);
    }
    this.pendingAgentStartAcks.clear();
    this.terminalAgentStartDispatches.clear();
    for (const write of this.capabilitiesWrites.values()) {
      if (write.timer != null) this.clock.clearTimeout(write.timer);
      write.cancelled = true;
    }
    this.capabilitiesWrites.clear();
    this.capabilitiesGenerationSeq.clear();
    const machineIds = [...this.machineConnections.keys()];
    const unregisters = machineIds.map(async (machineId) => {
      try {
        await this.unregisterMachine(machineId);
      } catch (err) {
        console.warn(
          `[Machine ${machineId}] Failed to unregister during orchestrator shutdown:`,
          err instanceof Error ? err.message : err,
        );
      }
    });
    this.lifecycleEventsByAgent.clear();
    await Promise.allSettled(unregisters);
  }

  async handleMachineDisconnect(machineId: string, ws?: WebSocket, context: MachineDisconnectContext = {}) {
    const span = this.tracer.startSpan("server.machine.connection.disconnect", {
      parent: getCurrentTraceContext(),
      surface: "server",
      kind: "internal",
      attrs: {
        machine_id: machineId,
        machine_id_present: Boolean(machineId),
        cause: context.cause || "socket_close",
        close_code_present: context.closeCode !== undefined,
        close_code: context.closeCode,
        close_reason_present: Boolean(context.closeReason),
        error_present: Boolean(context.errorMessage),
        shutdown_intent_present: Boolean(context.shutdownIntent),
        shutdown_reason: context.shutdownIntent?.reason,
      },
    });
    await this.runInActiveSpan(span, async () => {
      const conn = this.machineConnections.get(machineId);
      // Ignore stale disconnect from a previous socket (e.g. after reconnect)
      if (ws && conn && conn.ws !== ws) {
        console.log(`[Machine ${machineId}] Ignoring stale disconnect from previous socket`);
        span.end("ok", { attrs: { outcome: "ignored_stale_socket" } });
        return;
      }
      // Ignore duplicate disconnect (error + close both fire on same socket)
      if (!conn) {
        span.end("ok", { attrs: { outcome: "ignored_duplicate" } });
        return;
      }
      const serverId = conn.serverId;
      const connectionEpochId = conn.connectionEpochId;
      const replicaGeneration = conn.replicaGeneration;
      const shutdownIntent = context.shutdownIntent ?? conn.shutdownIntent ?? undefined;
      const disconnectContext: MachineDisconnectContext = shutdownIntent
        ? { ...context, shutdownIntent }
        : context;
      machineDisconnectsTotal.inc({
        cause: context.cause || "socket_close",
        close_code: machineCloseCodeLabel(context.closeCode),
        shutdown_reason: shutdownIntent?.reason ?? "none",
        daemon_version: daemonVersionLabel(conn.daemonVersion),
        conn_age: machineConnectionLifetimeLabel(
          conn.connectedAt === undefined ? undefined : this.clock.now() - conn.connectedAt,
        ),
      });
      this.emit(`machine:disconnect:${machineId}`, disconnectContext);
      this.machineLastDisconnectAt.set(machineId, this.clock.now());
      await this.clearMachineConnection(machineId, false);
      this.agentTyping.endForMachine(machineId);
      this.dispatchComputerLifecycleDisconnectObservation({
        machineId,
        serverId,
        connectionEpoch: connectionEpochId,
      });
      this.recordEvent("operation.disconnect_observation.dispatched", { outcome: "dispatched" });

      // Task #374: this socket was closed because another replica holds a
      // live, renewing connection for the machine. The machine is not
      // offline: no outage record, no agent disconnect projection, no
      // replica unregister or meta clear (both belong to the winner).
      if (conn.closedAsDuplicate) {
        span.end("ok", { attrs: { outcome: "duplicate_closed_local_only", server_id: serverId } });
        return;
      }

      // task #17: the Computer cancels its running logins when the connection
      // drops (their link, code and result cannot cross it); end them here
      // too, so the person sees it now rather than at the login's TTL.
      void this.endRuntimeAuthLoginsForMachine(machineId, connectionEpochId ?? null);

      this.cancelPendingMachineDisconnect(machineId);
      const pending: PendingMachineDisconnectProjection = {
        serverId,
        connectionEpochId,
        replicaGeneration,
        context: disconnectContext,
        timer: null,
      };
      pending.timer = this.scheduleOnClock(() => {
        void this.applyMachineDisconnectProjection(machineId, pending);
      }, MACHINE_DISCONNECT_PROJECTION_GRACE_MS);
      this.pendingMachineDisconnects.set(machineId, pending);
      span.end("ok", {
        attrs: {
          outcome: "scheduled",
          server_id: serverId,
          connection_epoch_present: Boolean(connectionEpochId),
          projection_grace_ms: MACHINE_DISCONNECT_PROJECTION_GRACE_MS,
          shutdown_intent_present: Boolean(shutdownIntent),
          shutdown_reason: shutdownIntent?.reason,
        },
      });
    });
  }

  protected observeComputerLifecycleDisconnect(
    input: Parameters<typeof computerLifecycleOperationService.observeComputerLifecycleDisconnect>[0],
  ) {
    return computerLifecycleOperationService.observeComputerLifecycleDisconnect(input);
  }

  private dispatchComputerLifecycleDisconnectObservation(
    input: Parameters<typeof computerLifecycleOperationService.observeComputerLifecycleDisconnect>[0],
  ): void {
    const sidecarSpan = this.tracer.startSpan("server.computer.operation.disconnect_observation", {
      parent: getCurrentTraceContext(),
      surface: "server",
      kind: "internal",
      attrs: {
        machine_id: input.machineId,
        server_id: input.serverId,
        operation_phase: "disconnect",
      },
    });
    let settled = false;
    const finish = (outcome: "recorded" | "error" | "timeout", errorClass?: string) => {
      if (settled) return;
      settled = true;
      this.clock.clearTimeout(timer);
      sidecarSpan.end(outcome === "recorded" ? "ok" : "error", {
        attrs: {
          outcome,
          ...(errorClass ? { error_class: errorClass } : {}),
        },
      });
      if (outcome !== "recorded") {
        console.warn(`[Machine ${input.machineId}] Lifecycle disconnect observation ${outcome} (${errorClass ?? "unknown"})`);
      }
    };
    const timer = this.scheduleOnClock(() => {
      finish("timeout", "timeout");
    }, COMPUTER_LIFECYCLE_DISCONNECT_OBSERVATION_TIMEOUT_MS);
    void this.runInActiveSpan(sidecarSpan, () => this.observeComputerLifecycleDisconnect(input)).then(
      () => finish("recorded"),
      (error) => finish("error", boundedErrorClass(error)),
    );
  }

  private async applyMachineDisconnectProjection(
    machineId: string,
    pending: PendingMachineDisconnectProjection,
  ) {
    const currentPending = this.pendingMachineDisconnects.get(machineId);
    if (currentPending !== pending) return;
    if (this.machineConnections.has(machineId)) {
      this.cancelPendingMachineDisconnect(machineId);
      return;
    }

    this.pendingMachineDisconnects.delete(machineId);
    const { serverId, connectionEpochId, context } = pending;
    const span = this.tracer.startSpan("server.machine.connection.disconnect_projection", {
      surface: "server",
      kind: "internal",
      attrs: {
        machine_id: machineId,
        server_id: serverId,
        machine_id_present: Boolean(machineId),
        server_id_present: Boolean(serverId),
        cause: context.cause || "socket_close",
        close_code_present: context.closeCode !== undefined,
        close_reason_present: Boolean(context.closeReason),
        error_present: Boolean(context.errorMessage),
        shutdown_intent_present: Boolean(context.shutdownIntent),
        shutdown_reason: context.shutdownIntent?.reason,
        connection_epoch_present: Boolean(connectionEpochId),
        projection_grace_ms: MACHINE_DISCONNECT_PROJECTION_GRACE_MS,
      },
    });
    await this.runInActiveSpan(span, async () => {

      await this.commitMachineReplicaDisconnectState(
        machineId,
        pending.replicaGeneration ?? undefined,
      );
      if (this.machineConnections.has(machineId)) {
        try {
          const conn = this.machineConnections.get(machineId);
          if (!conn) throw new Error("Machine connection disappeared before replica repair");
          conn.replicaGeneration = null;
          const replicaGeneration = requireReplicaGeneration(
            await this.replicaStateStore.registerMachineReplica(
              machineId,
              conn.traceContext ?? buildRuntimeTraceContext(),
            ),
          );
          if (this.machineConnections.get(machineId)?.ws === conn.ws) {
            conn.replicaGeneration = replicaGeneration;
          } else {
            await this.replicaStateStore.unregisterMachineReplica(machineId, replicaGeneration);
          }
          this.recordEvent("machine.replica.register_repaired_after_reconnect", {
            outcome: "repaired",
            reason: "reconnected_during_projection",
            ...projectMachineConnectTraceAttrs(conn?.traceContext ?? buildRuntimeTraceContext()),
          });
        } catch (err) {
          console.error(
            `[Machine ${machineId}] Failed to repair replica mapping after reconnect:`,
            err instanceof Error ? err.message : err,
          );
          this.recordEvent("machine.replica.register_repair_failed", {
            outcome: "failed",
            reason: "replica_register_repair_failed",
            error_class: errorClassOf(err),
          });
          const conn = this.machineConnections.get(machineId);
          if (conn?.replicaGeneration === null) {
            await this.clearMachineConnection(machineId, false, {
              code: 1011,
              reason: "replica_registration_failed",
            }, conn.ws);
          }
        }
        span.end("ok", { attrs: { outcome: "canceled_after_reconnect" } });
        return;
      }

      // Mark all active agents on this machine offline, but preserve enough
      // lifecycle state for a future explicit work item to lazy-wake them.
      try {
        try {
          const outage = await recordComputerOfflineTransition({
            serverId,
            machineId,
            connectionEpochId,
            shutdownIntent: context.shutdownIntent,
            now: new Date(this.clock.now()),
          });
          this.recordEvent("machine.outage.recorded", {
            outcome: outage.status,
            ...(outage.status === "created" ? { occurrence_id_present: Boolean(outage.occurrenceId) } : {}),
            ...(outage.status === "suppressed_planned" ? { suppress_reason: outage.reason } : {}),
          });
        } catch (err) {
          console.warn(
            `[Machine ${machineId}] Failed to record Computer outage transition:`,
            err instanceof Error ? err.message : err,
          );
          this.recordEvent("machine.outage.failed", {
            outcome: "failed",
            error_class: errorClassOf(err),
          });
        }
        const machineAgents = await this.loadAgentsForDisconnect(machineId);
        let activeAgentsCount = 0;
        let pendingReceivesResolvedCount = 0;
        for (const agent of machineAgents) {
          this.releaseWakeLock(agent.id);
          if (agent.status === "active") {
            activeAgentsCount += 1;
            const shutdownIntent = context.shutdownIntent;
            const activityDedupeKey = this.makeLifecycleDedupeKey(
              "agent",
              agent.id,
              "machine",
              machineId,
              "connectionEpoch",
              connectionEpochId,
              shutdownIntent ? "shutdown" : "disconnect",
            );
            const disconnectCause = context.cause || "socket_close";
            await applyAgentLifecycleProjectionPlan(
              shutdownIntent
                ? reduceMachineShutdownLifecycle({
                  activityDedupeKey,
                  event: adaptMachineShutdownLifecycleEvent({
                    serverId: agent.serverId,
                    agentId: agent.id,
                    machineId,
                    connectionEpochId,
                    disconnectCause,
                    previousStatus: agent.status,
                    shutdownReason: shutdownIntent.reason,
                    now: () => new Date(this.clock.now()),
                  }).event,
                  shutdownReason: shutdownIntent.reason,
                  state: buildAgentLifecycleStateSnapshot({
                    dbStatus: agent.status,
                    machineId,
                    machineReachability: "unreachable",
                    runtimeState: "interrupted",
                  }),
                })
                : reduceMachineDisconnectLifecycle({
                  activityDedupeKey,
                  // TODO(lifecycle-v2/server-producer): machine disconnect is a
                  // server-owned reachability transition. Emit canonical
                  // machine_disconnected events from the disconnect planner with
                  // the connection epoch and cause, then delete this adapter call.
                  event: adaptMachineDisconnectLifecycleEvent({
                    serverId: agent.serverId,
                    agentId: agent.id,
                    machineId,
                    reason: context.cause === "heartbeat_timeout"
                      ? "heartbeat_timeout"
                      : context.cause === "computer_machine_unlinked"
                        ? "computer_machine_unlinked"
                        : "machine_disconnect",
                    connectionEpochId,
                    disconnectCause,
                    previousStatus: agent.status,
                    now: () => new Date(this.clock.now()),
                  }).event,
                  state: buildAgentLifecycleStateSnapshot({
                    dbStatus: agent.status,
                    machineId,
                    machineReachability: "unreachable",
                    runtimeState: "interrupted",
                  }),
                }),
              this.lifecycleProjectionWriterDeps(),
              span,
            );

            // Clean up inbox
            if (this.localInboxes.clear(agent.id)) {
              pendingReceivesResolvedCount += 1;
            }
          }
          // task #1119: a machine disconnect is deliberately NOT fed to the wake
          // crash-loop breaker. A transport loss carries no exit evidence, so it
          // cannot prove the runner died; only a daemon-reported process exit
          // (agent:status inactive with exit evidence + launchId) counts.
        }

        let statusVersion: number | null = null;
        if (serverId) {
          statusVersion = await this.bumpMachineStatusVersion(machineId);
          this.io?.to(`server:${serverId}`).emit("machine:status", {
            machineId,
            status: "offline",
            statusVersion,
            cause: context.shutdownIntent ? "machine_shutdown" : context.cause || "socket_close",
            ...(context.shutdownIntent ? { shutdownReason: context.shutdownIntent.reason } : {}),
          });
          this.recordEvent("machine.status.emitted", {
            outcome: "emitted",
            status: "offline",
            status_version: statusVersion,
            shutdown_intent_present: Boolean(context.shutdownIntent),
            shutdown_reason: context.shutdownIntent?.reason,
          });
        }

        const detailParts = [
          `reason=${context.cause || "socket_close"}`,
          `affected_agents=${machineAgents.length}`,
        ];
        if (context.shutdownIntent) detailParts.push(`shutdown_reason=${context.shutdownIntent.reason}`);
        if (context.closeCode !== undefined) detailParts.push(`code=${context.closeCode}`);
        if (context.closeReason) detailParts.push(`close_reason=${JSON.stringify(context.closeReason)}`);
        if (context.errorMessage) detailParts.push(`error=${JSON.stringify(context.errorMessage)}`);
        console.log(`[Machine ${machineId}] Disconnected (${detailParts.join(", ")})`);
        span.end("ok", {
          attrs: {
            outcome: "processed",
            affected_agents_count: machineAgents.length,
            active_agents_count: activeAgentsCount,
            pending_receives_resolved_count: pendingReceivesResolvedCount,
            status_version: statusVersion,
            shutdown_intent_present: Boolean(context.shutdownIntent),
            shutdown_reason: context.shutdownIntent?.reason,
          },
        });
      } catch (err) {
        console.error(`[Machine ${machineId}] Failed to clean up agents on disconnect:`, err);
        let statusVersion: number | null = null;
        if (serverId) {
          statusVersion = await this.bumpMachineStatusVersion(machineId);
          this.io?.to(`server:${serverId}`).emit("machine:status", {
            machineId,
            status: "offline",
            statusVersion,
            cause: context.shutdownIntent ? "machine_shutdown" : context.cause || "socket_close",
            ...(context.shutdownIntent ? { shutdownReason: context.shutdownIntent.reason } : {}),
          });
        }
        span.end("error", {
          attrs: {
            outcome: "cleanup_failed",
            error_class: errorClassOf(err),
            status_version: statusVersion,
            shutdown_intent_present: Boolean(context.shutdownIntent),
            shutdown_reason: context.shutdownIntent?.reason,
          },
        });
      }
    });
  }

  private planDaemonIngressRateLimit(
    machineId: string,
    messageType: MachineToServerMessage["type"],
  ): DaemonIngressRateLimitDecision {
    if (this.daemonIngressRateLimitDisabled || !DAEMON_INGRESS_RATE_LIMITED_MESSAGE_TYPES.has(messageType)) {
      return { action: "allow" };
    }

    const totalDecision = this.planDaemonIngressRateLimitBucket({
      windows: this.daemonIngressTotalRateLimitWindows,
      key: machineId,
      limit: this.daemonIngressRateLimitMaxEventsPerMachine,
      scope: "machine_total",
    });
    if (totalDecision.action === "drop") {
      return totalDecision;
    }

    const messageTypeDecision = this.planDaemonIngressRateLimitBucket({
      windows: this.daemonIngressRateLimitWindows,
      key: `${machineId}:${messageType}`,
      limit: Math.min(this.daemonIngressRateLimitMaxEvents, DAEMON_INGRESS_TYPE_MAX_EVENTS[messageType] ?? Number.POSITIVE_INFINITY),
      scope: "message_type",
      messageType,
    });
    if (messageTypeDecision.action === "drop") {
      return messageTypeDecision;
    }

    const aggregateDrops = [totalDecision.aggregateDrop, messageTypeDecision.aggregateDrop]
      .filter((drop): drop is DaemonIngressRateLimitTraceAttrs & { aggregateDroppedCount: number } => Boolean(drop));

    return aggregateDrops.length > 0
      ? { action: "allow", aggregateDrops }
      : { action: "allow" };
  }

  private planDaemonIngressRateLimitBucket(input: {
    windows: Map<string, DaemonIngressRateLimitWindow>;
    key: string;
    limit: number;
    scope: DaemonIngressRateLimitScope;
    messageType?: MachineToServerMessage["type"];
  }): DaemonIngressRateLimitBucketDecision {
    const now = this.clock.now();
    const existing = input.windows.get(input.key);
    const traceAttrs: DaemonIngressRateLimitTraceAttrs = {
      scope: input.scope,
      limit: input.limit,
      ...(input.messageType ? { messageType: input.messageType } : {}),
    };
    if (!existing || now - existing.startedAt >= this.daemonIngressRateLimitWindowMs) {
      const aggregateDroppedCount = existing?.droppedCount;
      input.windows.set(input.key, {
        startedAt: now,
        count: 1,
        droppedCount: 0,
      });
      return aggregateDroppedCount
        ? { action: "allow", aggregateDrop: { ...traceAttrs, aggregateDroppedCount } }
        : { action: "allow" };
    }

    existing.count += 1;
    if (existing.count <= input.limit) {
      return { action: "allow" };
    }

    existing.droppedCount += 1;
    return {
      action: "drop",
      droppedCount: existing.droppedCount,
      retryAfterMs: Math.max(0, existing.startedAt + this.daemonIngressRateLimitWindowMs - now),
      trace: existing.droppedCount === 1 || existing.droppedCount % 1_000 === 0,
      attrs: traceAttrs,
    };
  }

  private traceDaemonIngressRateLimit(
    machineId: string,
    serverId: string | undefined,
    messageType: MachineToServerMessage["type"],
    decision:
      | Extract<DaemonIngressRateLimitDecision, { action: "drop" }>
      | (DaemonIngressRateLimitTraceAttrs & { action: "aggregate"; aggregateDroppedCount: number }),
    msg?: MachineToServerMessage,
  ) {
    const agentId = msg && "agentId" in msg && typeof msg.agentId === "string" ? msg.agentId : undefined;
    const traceAttrs = decision.action === "drop" ? decision.attrs : decision;
    const baseAttrs = {
      machine_id: machineId,
      server_id: serverId,
      machine_id_present: Boolean(machineId),
      server_id_present: Boolean(serverId),
      agent_id: agentId,
      agent_id_present: Boolean(agentId),
      scope: traceAttrs.scope,
      message_type: traceAttrs.scope === "message_type" ? traceAttrs.messageType ?? messageType : undefined,
      window_ms: this.daemonIngressRateLimitWindowMs,
      limit: traceAttrs.limit,
      max_events: traceAttrs.limit,
    };
    if (decision.action === "drop") {
      this.recordEvent("server.daemon.ingress.rate_limit", {
        ...baseAttrs,
        outcome: "dropped",
        reason: "daemon_ingress_rate_limited",
        dropped_count: decision.droppedCount,
        retry_after_ms: decision.retryAfterMs,
      });
      return;
    }
    this.recordEvent("server.daemon.ingress.rate_limit", {
      ...baseAttrs,
      outcome: "suppressed_aggregate",
      reason: "daemon_ingress_rate_limited",
      suppressed_count: decision.aggregateDroppedCount,
    });
  }

  /**
   * #wg-rbac:#27: the first `ready` of a connection said which runner
   * credentials the daemon holds; revoke this Machine's others
   * (revokeRunnerCredentialsNotHeld). Not awaited: it delays nothing in the
   * ready, and a failure only leaves them for the next connection.
   */
  private startRunnerCredentialReconcile(machineId: string, serverId: string, heldIds: string[], readyAtMs: number): void {
    const now = new Date(this.clock.now());
    void (async () => {
      if ((await evaluateFeatureFlag({ key: RUNNER_CREDENTIAL_RECONCILE_FEATURE_FLAG_KEY, serverId })).enabled !== true) {
        // Switch off: count what it would revoke (writes nothing) and log it per Machine.
        const counted = await countRunnerCredentialsNotHeld({
          machineId,
          heldIds,
          issuedBefore: new Date(readyAtMs - RUNNER_CREDENTIAL_RECONCILE_GRACE_MS),
          now,
        });
        this.recordEvent("server.machine.runner_credentials.reconciled", {
          outcome: counted === null ? "refused_too_many" : "count_only",
          machine_id: machineId,
          held_count: heldIds.length,
          would_revoke_count: counted?.wouldRevoke ?? 0,
          would_revoke_used_24h_count: counted?.usedLast24h ?? 0,
        });
        return;
      }
      const revoked = await revokeRunnerCredentialsNotHeld({
        machineId,
        heldIds,
        issuedBefore: new Date(readyAtMs - RUNNER_CREDENTIAL_RECONCILE_GRACE_MS),
        now,
      });
      this.recordEvent("server.machine.runner_credentials.reconciled", {
        outcome: revoked === null ? "refused_too_many" : "ok",
        held_count: heldIds.length,
        revoked_count: revoked ?? 0,
      });
    })().catch((error) => {
      this.recordEvent("server.machine.runner_credentials.reconciled", { outcome: "error", error_class: errorClassOf(error) });
    });
  }

  async handleMachineMessage(machineId: string, msg: MachineToServerMessage, ws?: WebSocket) {
    const conn = this.machineConnections.get(machineId);
    // A replaced socket can still have a buffered message callback queued.
    // Never let an old legacy principal act through the current Computer
    // connection's machineId after a handoff.
    if (ws && (!conn || conn.ws !== ws)) return;
    const daemonIngressRateLimit = this.planDaemonIngressRateLimit(machineId, msg.type);
    if (daemonIngressRateLimit.action === "drop") {
      if (daemonIngressRateLimit.trace) {
        this.traceDaemonIngressRateLimit(machineId, conn?.serverId, msg.type, daemonIngressRateLimit, msg);
      }
      return;
    }
    for (const aggregateDrop of daemonIngressRateLimit.aggregateDrops ?? []) {
      this.traceDaemonIngressRateLimit(
        machineId,
        conn?.serverId,
        msg.type,
        { action: "aggregate", ...aggregateDrop },
        msg,
      );
    }

    // One accepted frame has one observation time. Owner memory and the
    // cross-replica mirror must not disagree because the clock ticked between
    // two projections of the same ready/pong frame.
    const ingressAtMs = this.clock.now();
    if (conn) {
      conn.lastIngressAt = ingressAtMs;
    }
    this.refreshReplicaLivenessFromDaemonIngress(machineId, conn, msg.type);

    const builtInDispatch = resolveBuiltInMachineMessageDispatch(msg);
    if (builtInDispatch) {
      const agent = await this.validateMachineAgentMessage(
        machineId,
        conn?.serverId ?? null,
        builtInDispatch.agentId,
        msg.type,
      );
      if (!agent) return;
      await this.runAppSourceReceipt(
        {
          machine_id: machineId,
          server_id: agent.serverId,
          agent_id: agent.id,
          receipt_type: msg.type,
        },
        (setReceiptOutcome) => builtInDispatch.handle({
          host: this,
          machineId,
          agent,
          daemonVersion: conn?.daemonVersion ?? null,
          computerVersion: conn?.computerVersion ?? null,
          capabilities: conn?.capabilities ?? new Set(),
          nowMs: this.clock.now(),
          send: (message) => this.sendToMachine(machineId, message),
          setReceiptOutcome,
          emit: (event, payload) => {
            this.io?.to(`server:${agent.serverId}`).emit(event, payload);
          },
          io: this.io,
        }),
        "traceparent" in msg && typeof msg.traceparent === "string" ? parseTraceparent(msg.traceparent) : null,
      );
      return;
    }

    switch (msg.type) {
      case "ping":
      {
        await this.sendToMachine(machineId, { type: "ping" });
        break;
      }

      case "pong":
      {
        const previousLastPong = conn?.lastPong ?? null;
        if (conn) conn.lastPong = ingressAtMs;
        let heartbeatError: unknown = null;
        await this.runInTraceSpan(
          "server.machine.websocket.pong_received",
          {
            attrs: {
              machine_id: machineId,
              server_id: conn?.serverId,
              machine_id_present: Boolean(machineId),
              server_id_present: Boolean(conn?.serverId),
              previous_last_pong_age_ms_bucket: previousLastPong == null ? "unknown" : durationMsBucket(this.clock.now() - previousLastPong),
              connection_present: Boolean(conn),
            },
          },
          async () => {
            try {
              await this.updateMachineHeartbeat(machineId);
            } catch (err) {
              console.error(`[Machine ${machineId}] Failed to update heartbeat:`, err);
              heartbeatError = err;
            }
            // Refresh machine→replica TTL in Redis so cross-replica routing stays valid
            this.refreshMachineOwnerLease(machineId, conn, "pong");
            // Upsert the cross-replica meta mirror with the connection's current
            // live fields. Beyond just bumping TTL, this self-heals two narrow
            // failure modes: (1) the original `ready` write missed Redis (e.g.
            // a transient outage right when the daemon connected), and (2) the
            // entry was evicted by Redis under pressure. Either way, the very
            // next heartbeat re-populates fields + resets the deadline so
            // non-owner replica REST stops returning null. Best-effort —
            // a Redis miss here is silent. Only the owner replica enters this
            // branch (conn is the local-replica connection state).
            if (conn) {
              this.replicaStateStore
                .setMachineMeta(machineId, {
                  computerVersion: conn.computerVersion ?? null,
                  computerVersionObservedAt: new Date(ingressAtMs).toISOString(),
                  daemonVersion: conn.daemonVersion ?? null,
                  runtimeVersions: JSON.stringify(conn.runtimeVersions ?? {}),
                  ...machineMetaFromMigrationTransport(conn.migrationTransport),
                  ...this.probeCarrierMetaFields(conn),
                })
                .catch(() => {});
            }
            await this.maybePiggybackRuntimeProfileMigrationNudgesForMachine(machineId);
          },
          () => heartbeatError == null
            ? { attrs: { outcome: "heartbeat_persisted" } }
            : { status: "error", attrs: { outcome: "heartbeat_persist_failed", error_class: errorClassOf(heartbeatError) } },
        );
        break;
      }

      case "machine:runtime_account_usage:snapshot":
      {
        // Re-authorize at the source-to-cache boundary. Raw/legacy principals
        // and Computers that no longer have an attaching human must never
        // populate the private runtime-usage cache.
        if (!conn || !await this.isRuntimeAccountUsageDataBoundaryAuthorized(machineId, conn)) break;
        await this.writeRuntimeAccountUsageSnapshot(machineId, msg.snapshot);
        // Manual refreshes wait on this reply through the cross-replica relay.
        // Forward only after the cache write above, so a resolved waiter finds
        // the snapshot already cached; the relay is a side channel here, the
        // write above stays the single cache mutation. Snapshots without a
        // requestId have no waiter and are skipped by forward().
        void this.getMachineResponseRelay().forward(machineId, msg,
          (event, attrs) => this.recordMachineResponseRelay(event, attrs));
        break;
      }

      case "machine:runtime_account_usage:limit_reset:result":
      {
        // The usage read after the redeem goes into the private cache through
        // the same boundary as any snapshot, and before the reply is forwarded,
        // so the person's answer and the cache agree. The reply itself is
        // forwarded without its snapshot when the boundary refuses it.
        if (!conn) break;
        const authorized = await this.isRuntimeAccountUsageDataBoundaryAuthorized(machineId, conn);
        if (authorized && msg.snapshot !== undefined) {
          // A failed cache write must not lose the person's answer: they
          // need to know whether a reset was spent; the card re-reads usage.
          await this.writeRuntimeAccountUsageSnapshot(machineId, msg.snapshot).catch((error: unknown) => {
            addTraceEvent("runtime_account_usage.limit_reset.snapshot_write_failed", { machine_id: machineId, error_class: errorClassOf(error) });
          });
        }
        const { snapshot: _snapshot, ...withoutSnapshot } = msg;
        void this.getMachineResponseRelay().forward(machineId, authorized ? msg : withoutSnapshot,
          (event, attrs) => this.recordMachineResponseRelay(event, attrs));
        break;
      }

      // task #17: runtime login / logout (docs/contracts/runtime-auth.md).
      case "machine:runtime_auth:status": {
        // Same boundary as the usage cache: only a Computer with an attaching
        // human may populate a status that names (masked) accounts.
        if (!conn || !await this.isRuntimeAccountUsageDataBoundaryAuthorized(machineId, conn)) break;
        const parsed = runtimeAuthStatusReportSchema.safeParse(msg.report);
        if (!parsed.success) {
          addTraceEvent("runtime_auth.status.rejected", { machine_id: machineId });
          break;
        }
        await runtimeAuthService.recordStatus(machineId, parsed.data);
        // Content-free: each viewer re-reads the machine through its own permission check.
        this.io?.to(`server:${conn.serverId}`).emit("machine:runtime_auth:updated", { machineId });
        break;
      }
      case "machine:runtime_auth:login:event":
      case "machine:runtime_auth:login:result": {
        if (!conn || !await this.isRuntimeAccountUsageDataBoundaryAuthorized(machineId, conn)) break;
        await this.relayRuntimeAuthLogin(machineId, msg);
        break;
      }
      // Reconciler step 15: a terminal sign-in on this Computer (its shared
      // credential changed on disk and a fresh status query read it signed
      // in). Only this machine's own connection, only a runtime this server
      // knows; it lifts this machine's agents of that runtime on the shared
      // sign-in, sign-in pauses only. A status report alone never lifts.
      // #proj-raft-computer:#68: the facts only the daemon observes (its
      // logins). Stored and shown; never enforced here (the daemon holds the
      // agents), so a lost "recovered" report cannot block them.
      case "machine:runtime_readiness": {
        if (!conn) break;
        await this.ingestRuntimeReadiness(machineId, conn.serverId, msg);
        break;
      }
      case "machine:runtime_credentials:changed": {
        if (!conn) break;
        if (!isRuntimeAuthRuntime(msg.runtime)) {
          addTraceEvent("runtime_credentials.changed.dropped", { machine_id: machineId, reason: "unknown_runtime" });
          break;
        }
        // Every lift starts a fresh crash-loop episode: at most one disk lift
        // per machine and runtime per window, so a credential file that keeps
        // changing on an unusable account cannot cycle the breaker.
        let claimed = false;
        try {
          claimed = (await this.replicaStateStore.claimDiskCredentialLift?.(machineId, msg.runtime)) ?? false;
        } catch (err) {
          addTraceEvent("runtime_credentials.changed.throttled", { machine_id: machineId, runtime: msg.runtime, reason: "claim_failed", error_class: errorClassOf(err) });
          break;
        }
        if (!claimed) {
          addTraceEvent("runtime_credentials.changed.throttled", { machine_id: machineId, runtime: msg.runtime, reason: "window" });
          break;
        }
        await this.liftRuntimeCredentialBlocks(machineId, msg.runtime, "disk");
        break;
      }

      case "machine:runtime_auth:logout:result":
      case "machine:runtime_auth:providers:result":
      case "machine:runtime_auth:connect_provider:result":
      // Which Claude limit resets the account holds: no snapshot, nothing cached; relayed to the person who asked.
      case "machine:runtime_account_usage:limit_resets:read:result":
        if (!conn) break;
        void this.getMachineResponseRelay().forward(machineId, msg,
          (event, attrs) => this.recordMachineResponseRelay(event, attrs));
        break;

      case "machine:host_identity":
      {
        // Same-machine grouping: stored only while the flag is on for this
        // server, and only a well-formed hash; the value is never echoed back.
        if (!conn || !isHostIdHash(msg.hostIdHash)) {
          this.recordEvent("server.computer.host_identity.dropped", { reason: conn ? "malformed" : "no_connection" });
          break;
        }
        void this.storeHostIdentity(machineId, conn.serverId, msg.hostIdHash);
        break;
      }

      case "machine:disk_status":
      {
        if (!conn) break;
        const disk = { availableBytes: msg.availableBytes, totalBytes: msg.totalBytes };
        if (!isValidMachineDiskStatus(disk)) break;
        const wasLow = isMachineDiskLow(conn.diskStatus);
        conn.diskStatus = disk;
        // One row per report keeps a disk history per machine in ScopeDB.
        this.recordEvent("server.machine.disk_sample", {
          machine_id: machineId,
          daemon_version: conn.daemonVersion ?? "unknown",
          disk_available_bytes: disk.availableBytes,
          disk_total_bytes: disk.totalBytes,
        });
        this.replicaStateStore
          .setMachineMeta(machineId, {
            diskAvailableBytes: String(disk.availableBytes),
            diskTotalBytes: String(disk.totalBytes),
          })
          .catch(() => {});
        // Clients refetch machines only when the warning appears or clears,
        // not on every hourly report.
        if (wasLow !== isMachineDiskLow(disk)) {
          this.io?.to(`server:${conn.serverId}`).emit("machine:updated", {
            serverId: conn.serverId,
            machineId,
          });
        }
        break;
      }

      case "machine:memory_status":
      {
        // Read on demand (machine picker); no client push for a 5-minute report.
        if (!conn) break;
        const memory = { availableBytes: msg.availableBytes, totalBytes: msg.totalBytes };
        if (!isValidMachineMemoryStatus(memory)) break;
        conn.memoryStatus = memory;
        // One row per report (every 5 minutes per Computer) keeps a memory
        // history per machine in ScopeDB; the meta above holds only the latest.
        this.recordEvent("server.machine.memory_sample", {
          machine_id: machineId,
          daemon_version: conn.daemonVersion ?? "unknown",
          memory_available_bytes: memory.availableBytes,
          memory_total_bytes: memory.totalBytes,
        });
        this.replicaStateStore
          .setMachineMeta(machineId, {
            memoryAvailableBytes: String(memory.availableBytes),
            memoryTotalBytes: String(memory.totalBytes),
          })
          .catch(() => {});
        break;
      }


      case "machine:installer_repair_hint":
      {
        if (!conn) break;
        const hint = parseComputerInstallerRepairHint(msg.hint);
        const changed = JSON.stringify(hint) !== JSON.stringify(conn.installerRepairHint ?? null);
        conn.installerRepairHint = hint;
        this.replicaStateStore
          .setMachineMeta(machineId, { installerRepairHint: installerRepairHintMeta(hint) })
          .catch(() => {});
        // The machine list carries the hint.
        if (changed) {
          this.io?.to(`server:${conn.serverId}`).emit("machine:updated", {
            serverId: conn.serverId,
            machineId,
          });
        }
        break;
      }

      case "machine:runtime_models:catalog":
      {
        // Proactive model-list report (task #700). The catalog is display
        // data that every member may read, so it does not need the private
        // usage boundary; it is still validated strictly at the boundary and
        // a malformed report keeps the previous copy.
        if (conn) {
          await applyRuntimeModelCatalogReport(machineRuntimeModelCatalogService, machineId, msg);
        }
        break;
      }

      case "machine:shutdown":
      {
        if (conn) {
          const shutdownConn = conn;
          const reason = normalizeMachineShutdownReason(msg.reason);
          await this.runInTraceSpan(
            "server.machine.shutdown_intent.received",
            {
              attrs: {
                machine_id: machineId,
                server_id: shutdownConn.serverId,
                machine_id_present: Boolean(machineId),
                server_id_present: Boolean(shutdownConn.serverId),
                shutdown_reason: reason,
              },
            },
            async () => {
              for (const acknowledgement of msg.lifecycleAcks ?? []) {
                await this.handleComputerLifecycleAcknowledgement(
                  machineId,
                  shutdownConn.serverId,
                  shutdownConn.connectionEpochId,
                  acknowledgement,
                );
              }
              shutdownConn.shutdownIntent = {
                reason,
                receivedAtMs: this.clock.now(),
              };
            },
            () => ({ attrs: { outcome: "recorded" } }),
          );
        }
        break;
      }

      case "computer:upgrade:draining": {
        // Reconciler step 13: the Computer waits for its agents before its
        // installer runs. Kept on the connection and pushed to the web; the
        // request row (and its stretched deadline) is unchanged.
        if (!conn || typeof msg.requestId !== "string") break;
        const progress: ComputerUpgradeDrainProgress = {
          requestId: msg.requestId,
          deadlineAt: typeof msg.deadlineAt === "string" ? msg.deadlineAt : "",
          live: Number.isSafeInteger(msg.live) ? msg.live : 0,
          notQuietAgentIds: Array.isArray(msg.notQuietAgentIds)
            ? msg.notQuietAgentIds.filter((id): id is string => typeof id === "string").slice(0, COMPUTER_UPGRADE_DRAIN_MAX_LISTED_AGENTS)
            : [],
          ...(msg.finished === "quiet" || msg.finished === "deadline" || msg.finished === "ended" ? { finished: msg.finished } : {}),
        };
        const first = conn.upgradeDrain?.requestId !== progress.requestId;
        conn.upgradeDrain = progress;
        if (first || progress.finished) {
          this.recordEvent("server.computer.upgrade_request.draining", {
            request_id: progress.requestId,
            machine_id: machineId,
            live: progress.live,
            not_quiet: progress.notQuietAgentIds.length,
            finished: progress.finished ?? "",
          });
        }
        try {
          const open = await computerUpgradeRequestService.getOpenComputerUpgradeRequest(machineId);
          if (open && open.id === progress.requestId) {
            this.io?.to(`server:${conn.serverId}`).emit("machine:upgrade-request", { machineId, upgradeRequest: computerUpgradeRequestService.projectComputerUpgradeRequest(open, progress) });
          }
        } catch (error) {
          console.warn(`[Orchestrator] upgrade drain progress for ${machineId} not pushed: ${error instanceof Error ? error.message : String(error)}`);
        }
        break;
      }

      case "computer:upgrade:done": {
        // Remote upgrade v2: the request never reached the installer, the
        // installer gave up without stopping the service, or it restored the
        // old service before writing its receipt; no reconnect will carry a
        // receipt for it. A failure settles the request by id now (scoped to
        // this machine) instead of at the deadline.
        // `ok: true` means the installer started; the reconnect settles it.
        if (msg.ok) break;
        try {
          const settled = await computerUpgradeRequestService.settleRefusedComputerUpgradeRequest({
            machineId,
            requestId: msg.requestId,
            reason: msg.reason ?? msg.code ?? "computer_refused",
            code: msg.code ?? null,
            observedVersion: conn?.computerVersion ?? null,
            now: new Date(this.clock.now()),
          });
          if (settled && settled.outcome === null) {
            // An `unresolved` installer receipt: recorded on the still-open
            // request, which a later installer worker may yet finish; the
            // deadline sweep settles it failed if not. The web keeps the
            // request in progress, so nothing is pushed.
            this.recordEvent("server.computer.upgrade_request.unresolved_recorded", {
              ...computerUpgradeRequestService.computerUpgradeRequestTraceAttrs(settled),
              code: msg.code ?? "",
              via: "upgrade_done",
            });
            break;
          }
          if (settled) {
            this.recordEvent("server.computer.upgrade_request.refused", {
              ...computerUpgradeRequestService.computerUpgradeRequestTraceAttrs(settled),
              request_id: msg.requestId,
              machine_id: machineId,
              code: msg.code ?? "",
              outcome: "settled",
            });
          } else {
            // No open request: already settled (a second report of the same
            // outcome), expired, or not a web upgrade request at all (a
            // lifecycle-operation upgrade, an old Computer replaying a stale
            // refusal). Counted on its own so it does not bury real refusals.
            this.recordEvent("server.computer.upgrade_request.done_unmatched", {
              request_id: msg.requestId,
              machine_id: machineId,
              code: msg.code ?? "",
              // For a lifecycle-operation upgrade this is the only clue.
              reason: computerUpgradeRequestService.traceSafeUpgradeReason(msg.reason),
            });
          }
          if (settled && conn) {
            this.io?.to(`server:${conn.serverId}`).emit("machine:upgrade-request", { machineId, upgradeRequest: computerUpgradeRequestService.projectComputerUpgradeRequest(settled) });
          }
        } catch (error) {
          console.warn(`[Orchestrator] upgrade refusal settle failed for ${machineId}: ${error instanceof Error ? error.message : String(error)}`);
        }
        break;
      }

      case "computer:restart:done":
      {
        // Relay managed Computer operation frames to web clients.
        // The daemon frame carries only `requestId` (it doesn't know its own
        // server-machine id); the server is the sole party that knows which
        // machine this connection is, so we ADD `machineId` here. The web
        // (machineStore/MachineDetailPanel) routes by machineId and correlates
        // by requestId. Emitted to the same `server:<id>` room as
        // machine:capabilities/status, so the Redis adapter fans it out to web
        // clients on any replica (the daemon WS is pinned to this replica).
        // Additive + best-effort: a pre-relay server just dropped these frames.
        if (conn) {
          // Durable-before-projection (task #356 / #5092): persist a successful,
          // non-rolled-back upgrade's new version BEFORE relaying the done frame
          // to web, so a reload in the relay->reload window cannot read a stale
          // version. recordReportedMachineComputerVersion swallows DB errors, so
          // on a failed persist we still relay the operation-fact but leave the
          // old row for ready/lifecycle-ack replay to converge (Web must not
          // optimistically claim the new version). Only ok && !rolledBack
          // advances the row — a failed/rolled-back frame that still carries
          // newVersion must not (previously an unguarded persist ran below).
          const relayConn = conn;
          await this.runInTraceSpan(
            "server.computer.control.relay",
            {
              attrs: {
                action: "restart",
                event_type: msg.type,
                server_id: relayConn.serverId,
                machine_id: machineId,
                request_id: msg.requestId,
                ok: msg.ok,
                error_present: Boolean(msg.error),
              },
            },
            async () => {
              this.io?.to(`server:${relayConn.serverId}`).emit(msg.type, computerRestartDoneWebFrame(machineId, msg));
              if (!msg.ok) {
                const reason = msg.error === "control_busy" || msg.error === "self_relaunch_unavailable"
                  ? msg.error
                  : "restart_reported_failure";
                const terminalization = await this.terminalizeComputerLifecycleOperation({
                  operationId: msg.requestId,
                  serverId: relayConn.serverId,
                  machineId,
                  terminal: "failed",
                  reason,
                });
                await this.sendComputerLifecycleFailureReceipts(
                  machineId,
                  msg.requestId,
                  terminalization,
                );
              }
            },
            () => ({ status: msg.ok ? "ok" : "error" }),
          );
        }
        break;
      }

      case "ready":
      {
        // RFC 069 §8: pin the daemon instance and capabilities before the
        // first await below. Inbound frames are handled concurrently, so a
        // status or activity frame sent right after `ready` must not observe
        // the connection as unpinned (status falls back to the unsequenced
        // path, activity to legacy state inference) while ready reconciles.
        if (conn) {
          conn.daemonInstanceId = typeof msg.daemonInstanceId === "string" && msg.daemonInstanceId.trim() ? msg.daemonInstanceId : null;
          conn.reportedHostnameHash = reportedHostnameHash(msg.hostname);
          conn.osVariant = msg.osVariant === "wsl1" || msg.osVariant === "wsl2" ? msg.osVariant : null;
          conn.capabilities = new Set((msg.capabilities ?? []).filter((capability) => typeof capability === "string" && capability.trim()));
        }
        const readyCapturedAtMs = ingressAtMs;
        // #wg-rbac:#27: decided before the first await, so of two readies
        // handled concurrently only the connection's first reconciles.
        const firstReady = conn ? !conn.runnerCredentialReconcileSeen : false;
        if (conn) conn.runnerCredentialReconcileSeen = true;
        const heldRunnerCredentialIds = firstReady ? readyRunnerCredentialIds(msg) : null;
        // task #1268: a `pending` ready carries no inventory and must not touch
        // `machines.runtimes`; an `incomplete` ready keeps the unprobed runtimes'
        // previous state. Both are status, fanned out as `runtimeDetection`.
        const runtimeDetection = normalizeRuntimeDetectionReport(msg.runtimeDetection, this.clock.now());
        const inventoryPending = runtimeDetection?.status === "pending";
        // The inventory a pending/incomplete ready is laid over. A pending ready
        // is the first frame of a fresh connection, so `conn.runtimes` is null
        // then and the persisted column is the only "previous" there is.
        const previousInventory: MachineRuntimeInventory | null = runtimeDetection && runtimeDetection.status !== "complete"
          ? (conn?.runtimes
              ? { runtimes: conn.runtimes, runtimeVersions: conn.runtimeVersions }
              : await this.loadPersistedMachineInventory(machineId))
          : null;
        // archer (#9665): when the previous inventory cannot be read, a pending
        // fan-out carries no inventory fields and an incomplete ready persists
        // nothing (status only), so old values are never replaced by guesses.
        const previousInventoryUnknown = runtimeDetection !== null && runtimeDetection.status !== "complete" && previousInventory === null;
        const reportedInventory: MachineRuntimeInventory = inventoryPending
          ? { runtimes: previousInventory?.runtimes ?? [], runtimeVersions: previousInventory?.runtimeVersions ?? {} }
          : runtimeDetection?.status === "incomplete"
            ? mergeIncompleteRuntimeInventory(
                previousInventory,
                { runtimes: msg.runtimes ?? [], runtimeVersions: normalizeRuntimeVersions(msg.runtimeVersions, msg.runtimes ?? []) },
                runtimeDetection.unfinishedRuntimes ?? [],
              )
            : { runtimes: msg.runtimes ?? [], runtimeVersions: normalizeRuntimeVersions(msg.runtimeVersions, msg.runtimes ?? []) };
        const reportedRuntimes = reportedInventory.runtimes;
        const runtimeVersions = reportedInventory.runtimeVersions;
        // Mirror the detection state on the connection BEFORE the first await
        // and before the replica meta is written below (probeCarrierMetaFields
        // carries it), so a remote replica never reads the previous round's
        // state — but ONLY for states that carry no inventory write: `pending`,
        // an `incomplete` whose previous inventory is unknown (status only), and
        // a synchronous ready (null, which clears an earlier async state). A
        // `complete` (or persisting `incomplete`) becomes visible only when the
        // capabilities writer has converged (see runCapabilitiesWriter): while
        // the DB write keeps failing the state stays `pending`, so an old
        // inventory is never shown as confirmed (archer + Huaihuai, #9680).
        const statusOnlyReport = runtimeDetection === null
          || inventoryPending
          || (runtimeDetection.status === "incomplete" && previousInventoryUnknown);
        if (conn && statusOnlyReport) conn.runtimeDetection = runtimeDetection;
        const migrationTransport = normalizeMigrationTransportReady(msg.migrationTransport, readyCapturedAtMs);
        const span = this.tracer.startSpan("server.machine.ready.reconcile", {
          parent: getCurrentTraceContext(),
          surface: "server",
          kind: "internal",
          attrs: {
            machine_id: machineId,
            server_id: conn?.serverId,
            machine_id_present: Boolean(machineId),
            server_id_present: Boolean(conn?.serverId),
            runtimes_count: reportedRuntimes.length,
            runtime_detection_status: runtimeDetection?.status ?? "complete",
            running_agents_count: msg.runningAgents.length,
            daemon_version_present: Boolean(msg.daemonVersion),
            ...(msg.daemonVersion ? { daemonVersion: msg.daemonVersion } : {}),
            ...(msg.daemonVersion ? { daemon_version: msg.daemonVersion } : {}),
            computer_version_present: Boolean(msg.computerVersion),
            ...(msg.computerVersion ? { computerVersion: msg.computerVersion } : {}),
            ...(msg.computerVersion ? { computer_version: msg.computerVersion } : {}),
            migration_transport_present: Boolean(migrationTransport),
            migration_transport_provisioned: migrationTransport?.provisioned ?? false,
            migration_transport_endpoint_present: Boolean(migrationTransport?.endpoint),
            ...(migrationTransport?.leaseSource ? { migration_transport_lease_source: migrationTransport.leaseSource } : {}),
            hostname_present: Boolean(msg.hostname),
            os_present: Boolean(msg.os),
            ...(conn?.osVariant ? { os_variant: conn.osVariant } : {}),
            ...(isDaemonInstallKind(msg.installKind) ? { install_kind: msg.installKind } : {}),
            // The first ready to this server after Raft Desktop moved the
            // Computer from its embedded one (COMPUTER_MIGRATED_FROM): how the
            // data team counts migrated machines that came back. A value
            // outside the list is never recorded, only flagged.
            ...(isComputerMigratedFrom(msg.migratedFrom) ? { migrated_from: msg.migratedFrom } : {}),
            ...(msg.migratedFrom !== undefined && !isComputerMigratedFrom(msg.migratedFrom) ? { migrated_from_invalid: true } : {}),
            ...projectMachineConnectTraceAttrs(conn?.traceContext ?? buildRuntimeTraceContext()),
          },
        });
        const actionCounts: Record<string, number> = {};
        let invalid_status_count = 0;
        let requestStartCount = 0;
        // Managed agents assigned to this machine: their pending app events are
        // re-delivered once the reconcile below is done.
        let readyManagedAgentIds: string[] = [];
        // F9: the agents left wakeable and not running with no buffered wake (startReadyOwedWakePass).
        const readyOwedWakeCandidates: string[] = [];
        let foreignRunningCount = 0;
        let foreignRunningStoppedCount = 0;
        await this.runInActiveSpan(span, async () => {
          try {
            if (conn) {
              for (const acknowledgement of msg.lifecycleAcks ?? []) {
                await this.handleComputerLifecycleAcknowledgement(
                  machineId,
                  conn.serverId,
                  conn.connectionEpochId,
                  acknowledgement,
                );
              }
            }
            console.log(`[Machine ${machineId}] Ready (detection ${runtimeDetection?.status ?? "complete"}), runtimes: ${inventoryPending ? "(pending)" : reportedRuntimes.join(", ") || "none"}, version: ${msg.daemonVersion || "unknown"}, running agents: ${msg.runningAgents.join(", ") || "none"}`);
            // Store version in memory (transient connection state)
            if (conn) {
              conn.daemonVersion = msg.daemonVersion ?? null;
              conn.runtimeOutcomeUnreliableAgents = new Set((msg.runtimeOutcomeUnreliableAgents ?? []).filter((id) => typeof id === "string" && id.length > 0));
              conn.computerVersion = msg.computerVersion ?? null;
              conn.migrationTransport = migrationTransport;
              conn.installerRepairHint = parseComputerInstallerRepairHint(msg.installerRepairHint);
              void this.dispatchPendingComputerLifecycleOperations().catch(() => {});
              // Only this Computer: a sweep of every Computer on the replica per
              // `ready` multiplied in reconnect waves (prod 10-16 20:54Z, one ECS
              // task stopped: 225 readies in a minute, 100-134 claim
              // transactions each, up to 130 PG connections per trace).
              void this.dispatchPendingAgentArchiveOpsForMachine(machineId).catch(() => {});
            }
            // Mirror the same fields through the replica state store so REST
            // handlers that land on a non-owner replica can still surface
            // them. In-memory above stays the owner-replica source of truth;
            // the Redis hash is a TTL'd cross-replica view (see
            // replicaRouter.MachineMeta — same seam will absorb hostname/os
            // and any other owner-only live field as ApplePI's cross-replica
            // coherence contract picks them up). Best-effort: a Redis miss
            // logs nothing and the read path falls back to in-memory.
            if (this.replicaStateStore.isAvailable()) {
              this.replicaStateStore
                .setMachineMeta(machineId, {
                  computerVersion: msg.computerVersion ?? null,
                  computerVersionObservedAt: new Date(readyCapturedAtMs).toISOString(),
                  daemonVersion: msg.daemonVersion ?? null,
                  runtimeVersions: JSON.stringify(runtimeVersions),
                  hostname: msg.hostname ?? null,
                  os: msg.os ?? null,
                  installerRepairHint: installerRepairHintMeta(parseComputerInstallerRepairHint(msg.installerRepairHint)),
                  ...machineMetaFromMigrationTransport(migrationTransport),
                  ...(conn ? this.probeCarrierMetaFields(conn, runtimeVersions) : {}),
                })
                .catch(() => {});
            }
            // Before the version is persisted: a lift compares against the last recorded one.
            if (conn) await this.refreshMachineVersionGate(machineId, conn, "ready");
            await this.recordReportedMachineComputerVersion(
              machineId,
              msg.computerVersion,
              "ready",
            );
            // #proj-raft-computer task #38: the daemon found this machine's current
            // key where an agent could read it. Kept only while it is the stored key.
            const exposure = msg.legacyCredentialExposure;
            if (exposure && typeof exposure.foundAt === "string" && typeof exposure.keyFingerprint === "string"
              && /^[0-9a-f]{16}$/.test(exposure.keyFingerprint) && !Number.isNaN(Date.parse(exposure.foundAt))) {
              try {
                const foundAt = new Date(Math.min(Date.parse(exposure.foundAt), this.clock.now()));
                const stored = await machineService.recordCredentialExposure(machineId, { foundAt, keyFingerprint: exposure.keyFingerprint });
                this.recordEvent("server.machine.credential_exposure.reported", { outcome: stored ? "stored" : "not_current_key" });
              } catch (error) {
                console.warn(`[Orchestrator] credential exposure not stored for ${machineId}: ${error instanceof Error ? error.message : String(error)}`);
              }
            }
            // Remote upgrade v2: the reported version settles any open request.
            try {
              const settled = await computerUpgradeRequestService.observeComputerVersionForUpgradeRequests({
                machineId,
                reportedVersion: msg.computerVersion,
                receipt: msg.lastUpgradeReceipt ?? null,
                now: new Date(this.clock.now()),
              });
              if (settled && settled.outcome === null) {
                // An `unresolved` receipt, recorded on the still-open request
                // (see computer:upgrade:done); nothing settles yet.
                this.recordEvent("server.computer.upgrade_request.unresolved_recorded", {
                  ...computerUpgradeRequestService.computerUpgradeRequestTraceAttrs(settled),
                  via: "ready",
                });
              } else if (settled) {
                // A late success replaces the outcome the deadline gave it
                // (`replaces_outcome`): count it once, not as both.
                this.recordEvent("server.computer.upgrade_request.settled", {
                  ...computerUpgradeRequestService.computerUpgradeRequestTraceAttrs(settled),
                  ...("replacedOutcome" in settled ? { replaces_outcome: settled.replacedOutcome } : {}),
                });
                if (conn) this.io?.to(`server:${conn.serverId}`).emit("machine:upgrade-request", { machineId, upgradeRequest: computerUpgradeRequestService.projectComputerUpgradeRequest(settled) });
              }
            } catch (error) {
              console.warn(`[Orchestrator] upgrade request observation failed for ${machineId}: ${error instanceof Error ? error.message : String(error)}`);
            }
            // Persist runtimes to DB, then (only after the write lands) update the
            // in-memory connection + emit the client card. `machines.runtimes` is
            // the SINGLE source the setup projection reads (one row, visible from
            // every replica), so this write is not bookkeeping — it IS the fact,
            // and the card must never advance past it: a "detected" card over an
            // un-persisted column leaves Next dead with nothing on screen to
            // explain it, and diverges across replicas. Telling someone a thing is
            // ready when the only record of it failed to write is worse than
            // saying nothing — they can retry a silence, they cannot argue with a
            // lie (@Jianwei, 2026-07-13). So we do not announce what we did not
            // record; and a transient failure is retried by the server itself on a
            // capped backoff (it does NOT wait for the daemon to send another
            // `ready`), with a newer `ready` superseding the pending payload. See
            // enqueueCapabilitiesPersist and task #154 / #4691 / #4694.
            if (runtimeDetection && (inventoryPending || (runtimeDetection.status === "incomplete" && previousInventoryUnknown))) {
              // task #1268: status only. The persisted column and `conn.runtimes`
              // keep their last confirmed value; web learns "detecting" from the
              // explicit state, never from an empty list. When even the persisted
              // inventory could not be read, the fan-out carries no inventory
              // fields at all (archer, #9665) and an incomplete round persists
              // nothing rather than overwrite unknown old values.
              if (conn) {
                conn.runtimeDetection = runtimeDetection;
                this.io?.to(`server:${conn.serverId}`).emit("machine:capabilities", {
                  machineId,
                  ...(previousInventoryUnknown ? {} : { runtimes: reportedRuntimes, runtimeVersions }),
                  runtimeDetection,
                  hostname: msg.hostname,
                  os: msg.os,
                  daemonVersion: msg.daemonVersion,
                  computerVersion: msg.computerVersion ?? null,
                  versionGate: conn.versionGate ?? null,
                });
              }
              this.recordEvent("machine.capabilities.detection_pending", {
                outcome: inventoryPending ? "pending" : "incomplete_without_previous",
                previous_inventory_known: !previousInventoryUnknown,
              });
            } else {
              this.recordEvent("machine.capabilities.enqueued", {
                outcome: "enqueued",
                runtimes_count: reportedRuntimes.length,
                runtime_detection_status: runtimeDetection?.status ?? "complete",
              });
              await this.enqueueCapabilitiesPersist(machineId, {
                runtimes: reportedRuntimes,
                runtimeVersions,
                ...(runtimeDetection ? { runtimeDetection } : {}),
                hostname: msg.hostname,
                os: msg.os,
                host: {
                  deviceClass: isDeviceClass(msg.deviceClass) ? msg.deviceClass : null,
                  hostProvider: isHostProvider(msg.hostProvider) ? msg.hostProvider : null,
                  osRelease: normalizeOsRelease(msg.osRelease),
                  osId: normalizeOsId(msg.osId),
                  osIdLike: normalizeOsIdLike(msg.osIdLike),
                  installKind: isDaemonInstallKind(msg.installKind) ? msg.installKind : null,
                  nodeOnPath: typeof msg.nodeOnPath === "boolean" ? msg.nodeOnPath : null,
                },
                daemonVersion: msg.daemonVersion,
                computerVersion: msg.computerVersion,
              });
            }
            if (conn) this.startRuntimeAccountUsageSchedule(machineId, conn);
            if (conn) void this.requestHostIdentity(machineId, conn.serverId);

            // Reconcile all agents assigned to this machine:
            // - running now => mark active
            // - active but missing => keep wakeable/online, mark only runtime process absent
            // - inactive/stopped => stay non-running until an explicit wake path
            try {
              const runningSet = new Set(msg.runningAgents);
              const machineAgents = await this.loadAgentsForReadyReconcile(machineId);
              readyManagedAgentIds = machineAgents.filter((agent) => !isExternalAgentRuntime(agent.runtime)).map((agent) => agent.id);
              this.recordEvent("machine.ready.agents.loaded", {
                outcome: "loaded",
                agents_count: machineAgents.length,
              });
              const readyDaemonInstanceId = conn?.daemonInstanceId ?? null;
              for (const agent of machineAgents) {
                // RFC 071 §4.3 rule 4, before anything below may wake the agent:
                // processes of an earlier daemon instance can no longer be seen
                // to exit on this connection unless that instance's queue replays.
                if (readyDaemonInstanceId) await this.observeTerminalDaemonReady(agent.id, readyDaemonInstanceId);
                await this.rearmPauseRetry(agent.id);
                const running = runningSet.has(agent.id);
                const narrowedStatus = narrowReadyReconcileStatus(agent.status);
                if (!narrowedStatus) {
                  console.warn(
                    `[Machine ${machineId}] Invalid persisted agent status ${JSON.stringify(agent.status)} for ${agent.id}; failing closed`,
                  );
                  invalid_status_count += 1;
                  const action = running ? "force-stop-and-stay-offline" : "stay-offline";
                  actionCounts[action] = (actionCounts[action] ?? 0) + 1;
                  await this.applyReadyReconcileAction(
                    machineId,
                    { ...agent, status: "inactive" },
                    action,
                  );
                  continue;
                }

                const action = planReadyReconcileAction({
                  status: narrowedStatus,
                  running,
                  resetMode: this.getResetMode(agent.id),
                });
                if (action === "mark-wakeable-not-running" && this.hasPendingAgentStart(agent.id, machineId)) {
                  // The ready list predates a start this replica already sent
                  // (still waiting for its ack). Marking the agent not running
                  // would drop that start's launch guard and wake lock, and the
                  // pending-inbox wake would send a second start with a new
                  // launch. The daemon runs whichever start arrives last while
                  // the guard keeps the one sent last, so a reorder left every
                  // frame of the running launch dropped as stale for hours.
                  actionCounts["start-in-flight"] = (actionCounts["start-in-flight"] ?? 0) + 1;
                  this.recordEvent("machine.ready.reconcile.start_in_flight", {
                    agent_id: agent.id,
                    machine_id: machineId,
                    outcome: "skipped",
                  });
                  continue;
                }
                actionCounts[action] = (actionCounts[action] ?? 0) + 1;
                await this.applyReadyReconcileAction(machineId, agent, action);
                if (action === "mark-wakeable-not-running") {
                  if (await this.maybeWakePendingInboxAfterReady(machineId, agent)) {
                    requestStartCount += 1;
                  } else if (!isExternalAgentRuntime(agent.runtime)) {
                    readyOwedWakeCandidates.push(agent.id);
                  }
                }
              }
              if (conn) await this.resendLostAgentConfigs(conn, machineAgents, runningSet, readyAgentConfigRevisions(msg.runningAgentConfigRevisions));
              ({ foreign: foreignRunningCount, stopped: foreignRunningStoppedCount } = await this.reconcileForeignRunningAgents(
                machineId,
                msg.runningAgents.filter((agentId) => !machineAgents.some((agent) => agent.id === agentId)),
              ));
            } catch (err) {
              console.error(`[Machine ${machineId}] Failed to reconcile agents:`, err);
              this.recordEvent("machine.ready.reconcile_failed", {
                outcome: "failed",
                reason: "ready_reconcile_failed",
                error_class: errorClassOf(err),
              });
            }
            try {
              await this.recoverDurableMentionDeliveriesForMachine(machineId);
            } catch (err) {
              // Ready reconciliation must keep the ordinary task #166 retry
              // executor live even when durable occurrence storage is
              // temporarily unavailable. A later agent:session event re-runs
              // the authoritative durable recovery path.
              console.error(`[Machine ${machineId}] Failed to recover durable mention deliveries:`, err);
              this.recordEvent("machine.ready.mention_recovery_failed", {
                outcome: "failed",
                reason: "mention_recovery_failed",
                error_class: errorClassOf(err),
              });
            }
            try {
              await this.pushReminderSnapshotsForMachine(machineId);
            } catch (err) {
              // Coverage push is additive: the daemon still requests snapshots
              // for running/idle agents itself, and an unsynchronized upsert
              // triggers a per-owner snapshot. Failing here must not take down
              // ready processing.
              console.error(`[Machine ${machineId}] Failed to push reminder snapshots:`, err);
              this.recordEvent("machine.ready.reminder_snapshot_push_failed", {
                outcome: "failed",
                reason: "reminder_snapshot_push_failed",
                error_class: errorClassOf(err),
              });
            }
            try {
              await this.pushAppConfigSnapshotsForMachine(machineId);
            } catch (err) {
              console.error(`[Machine ${machineId}] Failed to push app config snapshots:`, err);
              this.recordEvent("machine.ready.app_config_snapshot_push_failed", {
                outcome: "failed",
                reason: "app_config_snapshot_push_failed",
                error_class: errorClassOf(err),
              });
            }
            try {
              await this.reprovisionLostMigrationTransfers(machineId, msg);
            } catch (err) {
              console.error(`[Machine ${machineId}] Failed to re-provision lost migration transfers:`, err);
              this.recordEvent("machine.ready.migration_reprovision_failed", {
                outcome: "failed",
                reason: "migration_reprovision_failed",
                error_class: errorClassOf(err),
              });
            }
            this.retryPendingAgentDeliveriesForMachine(machineId, "ready_reconcile");
            this.retryPendingAgentStartsForMachine(machineId, "ready_reconcile");
            // App events have no durable chain row, so the resume catch-up
            // never carries one whose push was lost during a real outage:
            // send them again (this replica holds the socket). Not awaited,
            // so it delays neither the retries above nor this span.
            this.startThirdPartyEventReconnectPass(machineId, readyManagedAgentIds, conn);
            // F9: wake the agents whose wake the restart lost. Not awaited.
            this.startReadyOwedWakePass(machineId, readyOwedWakeCandidates, conn);
            if (heldRunnerCredentialIds && conn) this.startRunnerCredentialReconcile(machineId, conn.serverId, heldRunnerCredentialIds, readyCapturedAtMs);
            span.end("ok", {
              attrs: {
                outcome: "processed",
                invalid_status_count,
                force_stop_and_stay_offline_count: actionCounts["force-stop-and-stay-offline"] ?? 0,
                mark_inactive_offline_count: actionCounts["mark-inactive-offline"] ?? 0,
                mark_wakeable_not_running_count: actionCounts["mark-wakeable-not-running"] ?? 0,
                mark_active_online_count: actionCounts["mark-active-online"] ?? 0,
                stay_offline_count: actionCounts["stay-offline"] ?? 0,
                start_in_flight_count: actionCounts["start-in-flight"] ?? 0,
                foreign_running_count: foreignRunningCount,
                foreign_running_stopped_count: foreignRunningStoppedCount,
                request_start_count: requestStartCount,
              },
            });
          } catch (err) {
            span.end("error", { attrs: { error_class: errorClassOf(err) } });
            throw err;
          }
        });
        break;
      }

      case "agent:status": {
        const span = this.tracer.startSpan("server.agent.status.ingest", {
          parent: getCurrentTraceContext(),
          surface: "server",
          kind: "internal",
          attrs: {
            agent_id: msg.agentId,
            machine_id: machineId,
            server_id: conn?.serverId,
            launch_id: msg.launchId,
            agent_id_present: Boolean(msg.agentId),
            machine_id_present: Boolean(machineId),
            launch_id_present: Boolean(msg.launchId),
            reported_status: msg.status,
          },
        });
        // RFC 069 §8 rollout evidence: which status path this frame took.
        let sequencedStatus: SequencedStatusVerdict["kind"] | undefined;
        const finish = (outcome: string, attrs?: Record<string, unknown>) => {
          span.end("ok", { attrs: { outcome, ...(sequencedStatus ? { sequenced_status: sequencedStatus } : {}), ...attrs } });
        };
        await this.runInActiveSpan(span, async () => {
          try {
            this.recordEvent("agent.status.received", {
              outcome: "received",
              reason: "daemon_status",
              reported_status: msg.status,
              launch_id_present: Boolean(msg.launchId),
            });
            const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
            if (!agent) {
              finish("dropped", { reason: "validation_failed" });
              return;
            }
            // RFC 069 §8: status is the agent's only state channel for sequenced
            // daemons; apply it in order, and only from the connected process.
            const sequenced = planSequencedStatus({
              connectionInstanceId: conn?.daemonInstanceId ?? null,
              frameInstanceId: msg.daemonInstanceId,
              frameSeq: msg.clientSeq,
              last: this.sequencedStatusVersions.get(msg.agentId),
            });
            sequencedStatus = sequenced.kind;
            if (sequenced.kind === "stale_instance" || sequenced.kind === "stale_seq") {
              this.recordEvent("agent.status.sequenced.dropped", { outcome: "dropped", reason: sequenced.kind });
              finish("dropped", { reason: sequenced.kind });
              return;
            }
            if (!this.shouldAcceptLifecycleEvent(machineId, agent, msg.type, msg.launchId, span)) {
              this.recordEvent("agent.status.lifecycle_guard.checked", {
                outcome: "rejected",
                reason: "lifecycle_guard",
                accepted: false,
                launch_id_present: Boolean(msg.launchId),
              });
              finish("dropped", { reason: "lifecycle_guard" });
              return;
            }
            this.recordEvent("agent.status.lifecycle_guard.checked", {
              outcome: "accepted",
              reason: "lifecycle_guard",
              accepted: true,
              launch_id_present: Boolean(msg.launchId),
            });
            const normalizedStatus = normalizeDaemonAgentStatus(msg.status);
            if (!normalizedStatus) {
              console.warn(`[Machine ${machineId}] Unknown agent status "${msg.status}" for ${msg.agentId}, ignoring`);
              finish("dropped", { reason: "unknown_status" });
              return;
            }
            if (sequenced.kind === "accept") this.sequencedStatusVersions.set(msg.agentId, sequenced.next);
            this.acknowledgePendingAgentStartFromLifecycle(
              msg.agentId,
              msg.launchId,
              "agent_status",
            );
            const resetMode = this.getResetMode(msg.agentId);
            const state = buildAgentLifecycleStateSnapshot({
              dbStatus: agent.status,
              launchId: msg.launchId,
              machineId,
              machineReachability: "reachable",
              resetMode,
              runtimeState: normalizedStatus === "active" ? "running_idle" : "not_running",
            });
            const action = planStatusSignalAction({
              reportedStatus: normalizedStatus,
              state,
            });
            this.recordEvent("agent.status.action.planned", {
              outcome: "planned",
              reason: "status_signal_action",
              current_status: agent.status,
              normalized_status: normalizedStatus,
              action,
            });
            const nextStatus: AgentStatus =
              action === "persist-active" ? "active"
                : action === "persist-stopped" ? "stopped"
                  : "inactive";
            // TODO(lifecycle-v2/daemon-protocol): replace legacy `agent:status`
            // ingestion with daemon-emitted canonical runtime_ready or
            // runtime_interrupted events carrying reason, launchId, correlationId,
            // and reset/window attrs. This call site is the server compatibility
            // boundary until all supported daemons speak that protocol.
            const { event } = adaptDaemonStatusLifecycleEvent({
              serverId: agent.serverId,
              agentId: msg.agentId,
              machineId,
              launchId: msg.launchId,
              currentStatus: agent.status,
              normalizedStatus,
              resetMode,
              now: () => new Date(this.clock.now()),
            });
            let liveActivityAttrs = liveActivityRootTraceAttrs(undefined);
            try {
              const result = await applyAgentLifecycleProjectionPlan(
                reduceDaemonStatusLifecycle({
                  action,
                  event,
                  nextStatus,
                  state,
                }),
                this.lifecycleProjectionWriterDeps(),
                span,
              );
              liveActivityAttrs = liveActivityRootTraceAttrs(result.liveActivityResult);
              if (result.dbStatusMachineFenced) {
                // The agent lives on another Computer now: this process's exit
                // or start is not the agent's (no crash-loop or start progress).
                finish("dropped", { reason: "machine_fenced", action, next_status: nextStatus, ...liveActivityAttrs });
                return;
              }
              if (action === "persist-active" || action === "persist-inactive" || action === "persist-stopped") {
                this.recordEvent("agent.status.persisted", {
                  outcome: "persisted",
                  reason: "status_signal",
                  next_status: nextStatus,
                });
              }
            } catch (err) {
              console.error(`[Machine ${machineId}] Failed to apply agent ${msg.agentId} status projection:`, err);
              this.recordEvent("agent.status.persist_failed", {
                outcome: "error",
                reason: "status_projection_failed",
                error_class: errorClassOf(err),
                next_status: nextStatus,
              });
              finish("error", {
                action,
                next_status: nextStatus,
                error_class: errorClassOf(err),
                ...liveActivityAttrs,
              });
              return;
            }
            // task #1119: a daemon-reported process exit shortly after a start is
            // an early exit for the wake crash-loop breaker. The breaker itself
            // refuses frames without exit evidence or whose launchId does not
            // match the current start. `stopped` is operator intent and never
            // counts.
            // A daemon with DAEMON_CAPABILITY_STARTUP_READINESS reports `active`
            // when the process exists; only its `agent:runtime:ready` (the
            // runtime's first output) is progress. Older daemons: `active` is.
            if (
              normalizedStatus === "active"
              && typeof msg.launchId === "string"
              && !conn?.capabilities.has(DAEMON_CAPABILITY_STARTUP_READINESS)
            ) {
              await this.observeStartProgress(msg.agentId, msg.launchId);
            }
            if (normalizedStatus === "inactive") {
              const exit = (msg as { exit?: { code: number | null; signal: string | null } }).exit;
              await this.observeWakeCrashLoopExit(msg.agentId, {
                kind: "agent_process_exited",
                evidence: exit ? { code: exit.code ?? null, signal: exit.signal ?? null } : null,
                launchId: msg.launchId ?? null,
              }, span);
            }
            finish(action === "ignore" || action === "ignore-and-release-wake-lock" ? "ignored" : "persisted", {
              action,
              next_status: nextStatus,
              ...liveActivityAttrs,
            });
          } catch (err) {
            span.end("error", {
              attrs: {
                outcome: "error",
                reason: "status_ingest_exception",
                error_class: errorClassOf(err),
              },
            });
            throw err;
          }
        });
        break;
      }

      case "agent:activity": {
        // #wg-rbac:#57: the one point where a runtime error's text enters the
        // server. Scrub and cap it here, so the activity snapshot, the stored
        // last_runtime_error and every push carry only the bounded text.
        if (isDaemonRuntimeErrorActivityFrame(msg) && typeof msg.detail === "string") {
          msg.detail = boundedRuntimeErrorDetail(msg.detail);
        }
        const joinTraceAttrs = daemonActivityJoinTraceAttrs(msg);
        const span = this.tracer.startSpan("server.agent.activity.ingest", {
          parent: getCurrentTraceContext(),
          surface: "server",
          attrs: {
            agent_id_present: Boolean(msg.agentId),
            machine_id_present: Boolean(machineId),
            ...joinTraceAttrs,
          },
        });
        await this.runInActiveSpan(span, async () => {
          this.recordEvent("activity.ingest.received", {
            activity: msg.activity,
            hasEntries: Boolean(msg.entries?.length),
            hasLaunchId: Boolean(msg.launchId),
            ...joinTraceAttrs,
          });

          const drop = (reason: ActivityIngestionDropReason, attrs?: Record<string, unknown>) => {
            this.recordEvent("activity.ingest.dropped", { reason, ...joinTraceAttrs, ...attrs });
            span.end("ok", { attrs: { outcome: "dropped", reason, ...joinTraceAttrs } });
          };

          try {
            const validation = await this.validateMachineAgentMessageWithReason(
              machineId,
              conn?.serverId ?? null,
              msg.agentId,
              msg.type,
            );
            if (!validation.agent) {
              drop(validation.dropReason);
              return;
            }
            const agent = validation.agent;

            const lifecycleAction = this.getLifecycleEventAcceptanceAction(agent, msg.launchId);
            this.recordEvent("lifecycle_guard.checked", {
              action: lifecycleAction,
              guardMode: agent.launchGuardMode,
              hasExpectedLaunchId: Boolean(agent.expectedLaunchId),
              hasLaunchId: Boolean(msg.launchId),
            });
            if (lifecycleAction !== "accept") {
              this.handleRejectedLifecycleEvent(machineId, agent, msg.type, msg.launchId, lifecycleAction, span);
              // Lifecycle-v2 shadow accounting (#460): the shadow's
              // stale-generation axis is observable ONLY on these guard-drop
              // rows — at the accept path both generations are identical
              // post-guard, so the arbitration stale-generation branch is a
              // structural dead branch there (#459 DoD note 4). The class is
              // computed with the same production classifier as the accept
              // path; the generation axis itself is named by the drop reason.
              {
                const droppedSnapshot = this.agentActivity.get(msg.agentId);
                const droppedObservationClass = classifyDaemonActivityObservation({
                  declaredHeartbeat: typeof msg.isHeartbeat === "boolean" ? msg.isHeartbeat : null,
                  incoming: {
                    activity: normalizeActivity(msg.activityKind ?? msg.activity, agent.status),
                    detail: msg.detail,
                    detailKind: normalizeActivityDetailKind(msg.detailKind),
                    hasEntries: Boolean(msg.entries?.length),
                    probeId: typeof msg.probeId === "string" ? msg.probeId : null,
                  },
                  lastAccepted: droppedSnapshot
                    ? {
                        activity: droppedSnapshot.activity,
                        detail: droppedSnapshot.detail,
                        detailKind: droppedSnapshot.detailKind,
                        hasEntries: false,
                      }
                    : undefined,
                });
                drop(
                  lifecycleAction === "ignore-legacy-for-guarded"
                    ? "legacy_lifecycle_event"
                    : "stale_launch_guard",
                  {
                    ...daemonActivityDropRowAttrs({
                      atMs: typeof msg.observedAtMs === "number" && Number.isFinite(msg.observedAtMs)
                        ? msg.observedAtMs
                        : this.clock.now(),
                      observationClass: droppedObservationClass,
                      probeIdPresent: typeof msg.probeId === "string",
                    }),
                  },
                );
              }
              return;
            }

            if (msg.detailKind !== undefined && !isAgentActivityDetailKind(msg.detailKind)) {
              drop("unknown_activity_detail_kind", {
                detail_kind_present: true,
              });
              return;
            }
            if (
              msg.detailKind !== undefined
              && !(msg.detailKind in CANONICAL_DAEMON_ACTIVITY_BY_DETAIL_KIND)
            ) {
              drop("non_fact_activity_detail_kind", {
                detail_kind: msg.detailKind,
                detail_kind_present: true,
              });
              return;
            }

            // Ingest dedup by (daemonInstanceId, launchId, clientSeq), with the
            // pre-carrier serverIngestEpoch/launchId key retained for compat.
            // Daemon-emitted activity messages can arrive out-of-order across
            // WS reconnects (a re-queued heartbeat can land after a newer
            // transition). Drop any whose clientSeq isn't strictly greater
            // than the highest seen for that server/runtime generation.
            // A new daemon process identity owns an independent sequence space.
            // New launchId also resets naturally, and server-controlled
            // starts/resets advance serverIngestEpoch so legacy/no-launch daemons
            // can reset after a deliberate new runtime generation. Daemons that
            // leave clientSeq unset retain pre-dedup behaviour.
            // (#engineering:72283cf7 task #340 PR B)
            if (typeof msg.clientSeq === "number") {
              const activityIngestKey = this.getActivityIngestSeqKey(
                msg.agentId,
                msg.launchId,
                msg.daemonInstanceId,
              );
              const lastSeen = this.lastClientSeqByActivityIngestKey.get(activityIngestKey);
              if (lastSeen !== undefined && msg.clientSeq <= lastSeen) {
                this.recordEvent("activity.ingest.dropped_stale_seq", {
                  clientSeq: msg.clientSeq,
                  lastSeen,
                  ...joinTraceAttrs,
                });
                drop("stale_client_seq", {
                  clientSeq: msg.clientSeq,
                  lastSeen,
                  // Lifecycle-v2 replay accounting (#460): a stale/duplicate
                  // clientSeq is the wire-level replay species; the in-window
                  // heartbeat replay species is classified at the accept path.
                  ...daemonActivityDropRowAttrs({
                    atMs: typeof msg.observedAtMs === "number" && Number.isFinite(msg.observedAtMs)
                      ? msg.observedAtMs
                      : this.clock.now(),
                    observationClass: "replayed",
                  }),
                });
                return;
              }
              this.lastClientSeqByActivityIngestKey.set(activityIngestKey, msg.clientSeq);
            }

            const resetMode = this.getResetMode(msg.agentId);
            const declaredActivity = msg.activityKind ?? msg.activity;
            const legacyActivity = declaredActivity === undefined
              ? undefined
              : normalizeActivity(declaredActivity, agent.status);
            const activitySignal = reduceDaemonActivitySignal({
              detailKind: msg.detailKind,
              legacyActivity,
            });
            const activity = activitySignal.activity;
            const detailKind = activitySignal.detailKind;
            const entries = rewriteDaemonActivityEntries(msg.entries, activitySignal);
            const state = buildAgentLifecycleStateSnapshot({
              dbStatus: agent.status,
              launchId: msg.launchId,
              machineId,
              machineReachability: "reachable",
              resetMode,
              // Sequenced-status daemons report state themselves; only legacy
              // daemons have it inferred from activity (RFC 069 §8).
              runtimeState: conn?.capabilities.has(DAEMON_CAPABILITY_SEQUENCED_STATUS)
                ? agent.runtimeState
                : legacyRuntimeStateFromActivity(activity),
            });
            const action = planActivitySignalAction({
              state,
            });
            // TODO(lifecycle-v2/daemon-protocol): replace the remaining legacy
            // `agent:activity` envelope with structured daemon events. The server
            // reducer above already owns canonical detailKind -> activityKind;
            // this adapter now only translates the accepted lifecycle envelope.
            const { event } = adaptDaemonActivityLifecycleEvent({
              serverId: agent.serverId,
              agentId: msg.agentId,
              machineId,
              launchId: msg.launchId,
              clientSeq: msg.clientSeq,
              currentStatus: agent.status,
              resetMode,
              activity,
              hasEntries: Boolean(entries?.length),
              runtimeError: msg.runtimeError,
              now: () => new Date(this.clock.now()),
            });
            if (action === "ignore") {
              const result = await applyAgentLifecycleProjectionPlan(
                reduceDaemonActivityLifecycle({
                  action,
                  event,
                  activity,
                  detail: msg.detail,
                  detailKind,
                  entries,
                  state,
                  // task #136: pass-through join keys for downstream Socket.IO
                  // emit. Server-internal dedup still happens above against
                  // `lastClientSeqByActivityIngestKey`; these are not the dedup keys.
                  ...(typeof msg.launchId === "string" ? { launchId: msg.launchId } : {}),
                  ...(typeof msg.clientSeq === "number" ? { clientSeq: msg.clientSeq } : {}),
                  ...(typeof msg.probeId === "string" ? { probeId: msg.probeId } : {}),
                  ...(typeof msg.producerFactId === "string" ? { producerFactId: msg.producerFactId } : {}),
                }),
                this.lifecycleProjectionWriterDeps(),
                span,
              );
              drop(
                agent.status === "stopped"
                  ? "agent_stopped"
                  : resetMode
                    ? "reset_window"
                    : "activity_plan_ignore",
                {
                  agentStatus: agent.status,
                  resetMode,
                  normalized_activity: activity,
                  activity_kind: activity,
                  detail_kind: detailKind,
                  activity_status: activity,
                  ...liveActivityRootTraceAttrs(result.liveActivityResult),
                },
              );
              return;
            }

            const kimiCircuitDecision = this.planKimiActivityCircuitBreaker({
              agent,
              activity,
              entries,
              launchId: msg.launchId,
              probeId: msg.probeId,
              now: this.clock.now(),
            });
            if (kimiCircuitDecision.action === "suppress") {
              drop("kimi_activity_circuit_breaker", {
                activity,
                launchId: msg.launchId ?? null,
                activity_kind: activity,
                detail_kind: detailKind,
                suppressedCount: kimiCircuitDecision.suppressedCount,
                normalized_activity: activity,
                activity_status: activity,
                ...liveActivityRootTraceAttrs(undefined),
              });
              return;
            }

            const acceptedAttrs: Record<string, unknown> = {
              activity,
              activity_kind: activity,
              detail_kind: detailKind,
              activity_signal_source: activitySignal.source,
              hasEntries: Boolean(entries?.length),
              ...joinTraceAttrs,
            };
            if (kimiCircuitDecision.aggregateSuppressedCount) {
              acceptedAttrs.kimiCircuitAggregateSuppressedCount =
                kimiCircuitDecision.aggregateSuppressedCount;
            }
            this.recordEvent("activity.ingest.accepted", acceptedAttrs);
            const shadowSnapshot = this.agentActivity.get(msg.agentId);
            const acceptedObservedAtMs = typeof msg.observedAtMs === "number" && Number.isFinite(msg.observedAtMs)
              ? msg.observedAtMs
              : this.clock.now();
            const acceptedObservationClass = classifyDaemonActivityObservation({
              declaredHeartbeat: typeof msg.isHeartbeat === "boolean" ? msg.isHeartbeat : null,
              incoming: {
                activity,
                detail: msg.detail,
                detailKind,
                hasEntries: Boolean(entries?.length),
                probeId: typeof msg.probeId === "string" ? msg.probeId : null,
              },
              lastAccepted: shadowSnapshot
                ? {
                    activity: shadowSnapshot.activity,
                    detail: shadowSnapshot.detail,
                    detailKind: shadowSnapshot.detailKind,
                    // Only the content axes of the last accepted signal
                    // participate in identity comparison.
                    hasEntries: false,
                  }
                : undefined,
            });

            // Lifecycle-v2 shadow verdict (task #460 PR-beta-2, trace-only).
            // Stateless: the arbitration state is built in place from the live
            // snapshot — no new store. `startingAffordance` is fed from the
            // production detailKind truth source (isStartingActivitySnapshot),
            // never inferred from a projection value. Oracle scope: per-step
            // divergence against the live projection, not trajectory
            // equivalence (#459 DoD). Zero behavior change: the verdict goes
            // to the span only.
            {
              this.recordEvent(
                "lifecycle_v2.shadow_verdict",
                buildLifecycleShadowVerdictAttrs(
                  shadowSnapshot
                    ? {
                        activity: shadowSnapshot.activity,
                        detail: shadowSnapshot.detail,
                        detailKind: shadowSnapshot.detailKind,
                        updatedAtMs: shadowSnapshot.observedAtMs ?? shadowSnapshot.updatedAt,
                      }
                    : undefined,
                  {
                    activity,
                    agentId: msg.agentId,
                    detailKind,
                    atMs: acceptedObservedAtMs,
                    // Launch-guard acceptance ran above, so the accepted
                    // launchId IS the current generation at this site; the
                    // stale-generation kernel path binds at the guard's
                    // reject path, not here.
                    currentLaunchGeneration: msg.launchId ?? null,
                    launchGeneration: msg.launchId ?? null,
                    observationClass: acceptedObservationClass,
                    probeIdPresent: typeof msg.probeId === "string",
                    site: "daemon_ingest",
                  },
                ),
              );
            }
            let currentRuntimeError = this.agentStateCache.get(msg.agentId)?.lastRuntimeError ?? agent.lastRuntimeError ?? null;
            // #688(b): a crash is durable typed authority only when it rides a valid
            // typed RuntimeErrorActivityDiagnostic carrier (normalized server-side).
            const normalizedTypedRuntimeError = normalizeRuntimeErrorActivityDiagnostic(
              (msg as { runtimeError?: RuntimeErrorActivityDiagnostic | Record<string, unknown> | null } | null)?.runtimeError ?? null,
            );
            let runtimeErrorAction = reduceRuntimeErrorActivityAction({
              signal: activitySignal,
              currentErrorPresent: currentRuntimeError !== null,
              currentErrorClearsOnlyOnModelOutput: runtimeErrorClearsOnlyOnModelOutput(currentRuntimeError),
              isHeartbeat: msg.isHeartbeat,
              typedRuntimeCarrierPresent: normalizedTypedRuntimeError !== null,
            });
            // task #1351: every model-output frame that got past the dedupe,
            // launch guard and heartbeat checks above asks the database, in this
            // frame and whatever this replica's cache shows, whether it proves a
            // stored BillingError recovered (one proof-and-clear statement; no
            // write when nothing matches). Nothing else clears a BillingError.
            let billingRecoveryUnproven = false;
            if (isModelOutputRecoveryFrame({ signal: activitySignal, isHeartbeat: msg.isHeartbeat, entries: msg.entries })) {
              const cachedBefore = this.agentStateCache.get(msg.agentId);
              // Best effort, like the recovery stamp: a failed proof keeps the
              // error (shown longer) and never fails this frame's ingest.
              const removed = await this.clearPersistedBillingErrorOnRecovery(msg.agentId, {
                launchId: msg.launchId ?? null,
                daemonInstanceId: msg.daemonInstanceId ?? null,
                clientSeq: Number.isSafeInteger(msg.clientSeq) ? msg.clientSeq as number : null,
              }).catch((err: unknown) => {
                console.warn(`[Orchestrator] Billing recovery proof failed for agent ${msg.agentId}:`, err);
                this.recordEvent("runtime_error_state.preserved", { reason: "billing_proof_failed", error_class: errorClassOf(err) });
                return null;
              });
              if (removed) {
                await this.applyRuntimeErrorCleared(msg.agentId, cachedBefore);
                await this.forgetRuntimeActionRequiredNotice(msg.agentId);
                this.recordEvent("runtime_error_state.cleared", {
                  // Trace label only, read off the removed row; the SQL decided.
                  reason: typeof msg.launchId === "string" && removed.recoveryLaunchId === msg.launchId && removed.launchId !== msg.launchId
                    ? "billing_recovery_launch"
                    : "billing_same_launch_seq",
                  detail_kind: detailKind,
                });
                currentRuntimeError = null;
                runtimeErrorAction = "preserve";
              } else if (currentRuntimeError?.errorClass === "BillingError") {
                // Unproven. The row may hold a generic error this cache missed
                // (clear it, as this frame would), else the cache learns the row.
                if (await this.clearLastRuntimeError(msg.agentId)) {
                  this.recordEvent("runtime_error_state.cleared", { reason: "strong_typed_runtime_progress", detail_kind: detailKind });
                  currentRuntimeError = null;
                } else {
                  currentRuntimeError = this.agentStateCache.get(msg.agentId)?.lastRuntimeError ?? null;
                  billingRecoveryUnproven = currentRuntimeError?.errorClass === "BillingError";
                }
                runtimeErrorAction = "preserve";
              }
            }
            // task #1116: capture the typed delivery-consumption carrier so the
            // snapshot write below can attach it. Observation only — no action.
            if (detailKind === "delivery_unconsumed") {
              const normalizedDeliveryConsumption = normalizeDeliveryConsumptionActivityDiagnostic(
                (msg as { deliveryConsumption?: DeliveryConsumptionActivityDiagnostic | Record<string, unknown> | null }).deliveryConsumption ?? null,
              );
              if (normalizedDeliveryConsumption) {
                this.pendingDeliveryConsumption.set(msg.agentId, normalizedDeliveryConsumption);
              } else {
                this.pendingDeliveryConsumption.delete(msg.agentId);
              }
              this.recordEvent("delivery_consumption.carrier", { present: normalizedDeliveryConsumption !== null });
            }
            // task #1123: same discipline for the typed spawn-failure reason on a
            // failed-start frame. Observation only — the reason picks web copy.
            const legacyUnkindedStartFailure = isLegacyUnkindedStartFailure({
              detailKind: msg.detailKind,
              activity: declaredActivity,
              detail: msg.detail,
            });
            if (detailKind === "runtime_unavailable" || legacyUnkindedStartFailure) {
              const normalizedSpawnFailure = normalizeSpawnFailureActivityDiagnostic(
                (msg as { spawnFailure?: SpawnFailureActivityDiagnostic | Record<string, unknown> | null }).spawnFailure ?? null,
              );
              // A daemon older than the carrier still reported a failed start
              // (one of its fixed messages): count it too, or nothing ever
              // stops its automatic wakes.
              const legacySpawnFailure = normalizedSpawnFailure === null && isLegacyStartFailureDetail(msg.detail)
                ? legacySpawnFailureCarrier({ detail: msg.detail, runtime: agent.runtime, machineRuntimes: conn?.runtimes ?? null })
                : null;
              const spawnFailure = normalizedSpawnFailure ?? legacySpawnFailure;
              this.recordEvent("spawn_failure.carrier", {
                present: normalizedSpawnFailure !== null,
                reason: spawnFailure?.reason,
                ...(legacySpawnFailure ? { legacy_frame: legacyUnkindedStartFailure ? "no_detail_kind" : "no_carrier" } : {}),
              });
              // task #1221: count the failed start; a reason retrying cannot
              // fix, a retry-once reason failing twice, or too many failures in
              // a row stops automatic wakes until a person restarts the agent or
              // its runtime configuration changes. Messages stay in the inbox.
              // Awaited so this frame already shows the pause.
              this.pendingSpawnFailure.set(
                msg.agentId,
                spawnFailure
                  ? await this.observeStartFailure(msg.agentId, typeof msg.launchId === "string" ? msg.launchId : null, spawnFailure, {
                    runtime: agent.runtime,
                    machineId,
                    model: spawnFailure.model ?? agent.model ?? null,
                  })
                  : null,
              );
            }
            const shouldPreserveVisibleRuntimeError = currentRuntimeError
              && runtimeErrorAction === "preserve"
              && (activity === "online" || activity === "working" || activity === "thinking");
            if (shouldPreserveVisibleRuntimeError) {
              this.recordEvent("runtime_error_state.preserved", {
                reason: billingRecoveryUnproven
                  ? "billing_recovery_unproven"
                  : activitySignal.source === "legacy_detail_kind_missing"
                  ? "weak_legacy_signal"
                  : msg.isHeartbeat !== false
                    ? "heartbeat_or_unclassified_frame"
                    : "non_progress_detail_kind",
                activity,
                detail_kind: detailKind,
                activity_signal_source: activitySignal.source,
              });
              if (msg.probeId) {
                this.handleActivityProbeResponse(msg.probeId);
                this.recordEvent("activity.probe.response_consumed", { probe_id_present: true });
              }
              span.end("ok", {
                attrs: {
                  outcome: "accepted",
                  normalized_activity: activity,
                  activity_status: activity,
                  has_entries: Boolean(entries?.length),
                  runtime_error_state_preserved: true,
                  activity_signal_source: activitySignal.source,
                  ...joinTraceAttrs,
                },
              });
              return;
            }
            // task #25: this frame's stuck-tool state, taken by its snapshot
            // write only. A frame without it clears the state.
            const toolStuck = normalizeToolStuckActivityDiagnostic(
              (msg as { toolStuck?: ToolStuckActivityDiagnostic | Record<string, unknown> | null }).toolStuck ?? null,
            );
            if (toolStuck) this.pendingToolStuck.set(msg.agentId, toolStuck);
            else this.pendingToolStuck.delete(msg.agentId);
            // Reconciler step 4b: likewise this frame's credential-hold reason
            // (an older daemon never sends one: the plain idle status).
            this.pendingCredentialHold.set(msg.agentId, normalizeCredentialHoldActivityDiagnostic(
              (msg as { credentialHold?: CredentialHoldActivityDiagnostic | Record<string, unknown> | null }).credentialHold ?? null,
            ));
            const result = await applyAgentLifecycleProjectionPlan(
              reduceDaemonActivityLifecycle({
                action,
                // RFC 069 §8: sequenced-status daemons own agent state; activity is display only.
                activityDrivesInstanceState: !conn?.capabilities.has(DAEMON_CAPABILITY_SEQUENCED_STATUS),
                event,
                activity,
                detail: msg.detail,
                detailKind,
                entries,
                state,
                observedAtMs: acceptedObservedAtMs,
                observationClass: acceptedObservationClass,
                // task #136: pass-through join keys for downstream Socket.IO
                // emit. This is the accepted-path branch — the one that
                // actually produces the live socket payload. Without this
                // the keys are dropped before emit and feedback-export
                // bundles classify every fresh activity row as
                // `join_key_missing`. (Stone's BLOCKER review on PR #3257.)
                ...(typeof msg.launchId === "string" ? { launchId: msg.launchId } : {}),
                ...(typeof msg.clientSeq === "number" ? { clientSeq: msg.clientSeq } : {}),
                ...(typeof msg.probeId === "string" ? { probeId: msg.probeId } : {}),
                ...(typeof msg.producerFactId === "string" ? { producerFactId: msg.producerFactId } : {}),
                ...(typeof msg.isHeartbeat === "boolean" ? { isHeartbeat: msg.isHeartbeat } : {}),
              }),
              this.lifecycleProjectionWriterDeps(),
              span,
            ).finally(() => {
              this.pendingToolStuck.delete(msg.agentId);
              this.pendingCredentialHold.delete(msg.agentId);
            });
            if (runtimeErrorAction === "set") {
              const persisted = await this.rememberRuntimeError(msg.agentId, this.buildRuntimeErrorState({
                detail: msg.detail,
                launchId: msg.launchId,
                typed: normalizedTypedRuntimeError,
                daemonInstanceId: msg.daemonInstanceId,
                clientSeq: typeof msg.clientSeq === "number" ? msg.clientSeq : undefined,
              }));
              this.recordEvent("runtime_error_state.persisted", {
                action_required: true,
                source: activitySignal.source,
                detail_kind: detailKind,
              });
              const requiredAction = runtimeErrorRequiredAction(normalizedTypedRuntimeError);
              // #proj-raft-computer:#68: a login fact the daemon enforces and
              // reports (`machine:runtime_readiness`): shown, but no wake
              // pause and no per-agent notice here (one per login instead).
              if (persisted && requiredAction && normalizedTypedRuntimeError && !normalizedTypedRuntimeError.readinessCode) {
                await this.observeRuntimeActionRequired(msg.agentId, {
                  launchId: typeof msg.launchId === "string" ? msg.launchId : null,
                  requiredAction,
                  fingerprint: normalizedTypedRuntimeError.fingerprint,
                });
              }
            } else if (runtimeErrorAction === "clear") {
              if (await this.clearLastRuntimeError(msg.agentId)) {
                await this.forgetRuntimeActionRequiredNotice(msg.agentId);
                this.recordEvent("runtime_error_state.cleared", {
                  reason: "strong_typed_runtime_progress",
                  detail_kind: detailKind,
                });
              } else if (this.agentStateCache.get(msg.agentId)?.lastRuntimeError?.errorClass === "BillingError") {
                this.recordEvent("runtime_error_state.preserved", { reason: "billing_in_store", detail_kind: detailKind });
              }
            }
            if (result.liveActivityResult) {
              this.recordEvent("status.read_model.updated", {
                from: result.liveActivityResult.previousActivity ?? null,
                to: result.liveActivityResult.nextActivity ?? activity,
              });
            }
            if (result.liveActivityResult?.action === "persist-and-emit-now") {
              this.recordEvent("activity.log.persist_scheduled", {
                entryCount: result.liveActivityResult.persistedEntryCount ?? 0,
              });
            } else {
              this.recordEvent("activity.log.persist_skipped", {
                reason: result.liveActivityResult?.action === "kernel-preserve"
                  ? "kernel_preserve"
                  : result.liveActivityResult?.action === "heartbeat-refresh"
                    ? "heartbeat_refresh"
                    : result.liveActivityResult?.action === "probe-refresh"
                      ? "probe_refresh"
                      : "debounce_only",
              });
            }
            // If this activity is the daemon's response to a server-issued
            // `agent:activity_probe`, cancel the pending fallback timer.
            // The activity broadcast above already updated agent state and
            // pushed to clients; the fallback's job (synth-online) is
            // moot. Lifecycle-dropped messages skip this — that's
            // intentional, the fallback should still fire if the
            // probe response was rejected. (#engineering:72283cf7 #340 PR A)
            if (msg.probeId) {
              this.handleActivityProbeResponse(msg.probeId);
              this.recordEvent("activity.probe.response_consumed", { probe_id_present: true });
            }
            span.end("ok", {
              attrs: {
                outcome: "accepted",
                normalized_activity: activity,
                activity_status: activity,
                has_entries: Boolean(entries?.length),
                activity_log_action: result.liveActivityResult?.action ?? "none",
                activity_log_entry_count: result.liveActivityResult?.persistedEntryCount ?? 0,
                ...joinTraceAttrs,
                ...liveActivityRootTraceAttrs(result.liveActivityResult),
              },
            });
          } catch (err) {
            this.recordEvent("activity.ingest.failed", {
              error_class: errorClassOf(err),
            });
            span.end("error");
            throw err;
          }
        });
        break;
      }

      case "agent:session": {
        const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
        if (!agent) {
          break;
        }
        if (!this.shouldAcceptLifecycleEvent(machineId, agent, msg.type, msg.launchId)) {
          break;
        }
        // Read before the projection below updates the cached agent in place.
        const previousSessionId = agent.sessionId;
        this.acknowledgePendingAgentStartFromLifecycle(
          msg.agentId,
          msg.launchId,
          "agent_session",
        );
        const resetMode = this.getResetMode(msg.agentId);
        const state = buildAgentLifecycleStateSnapshot({
          dbStatus: agent.status,
          launchId: msg.launchId,
          machineId,
          machineReachability: "reachable",
          resetMode,
          runtimeState: "running_idle",
          sessionId: agent.sessionId,
        });
        const action = planSessionSignalAction({ state });
        // TODO(lifecycle-v2/daemon-protocol): replace legacy `agent:session`
        // ingestion with canonical runtime_ready/session_init or session_resync
        // events. The daemon producer should include launchId and reconnect/
        // connection-window identity so the server does not infer readiness
        // solely from session presence.
        const { event } = adaptDaemonSessionLifecycleEvent({
          serverId: agent.serverId,
          agentId: msg.agentId,
          machineId,
          launchId: msg.launchId,
          currentStatus: agent.status,
          resetMode,
          now: () => new Date(this.clock.now()),
        });
        try {
          const result = await applyAgentLifecycleProjectionPlan(
            reduceDaemonSessionLifecycle({
              action,
              event,
              sessionId: msg.sessionId,
              state,
            }),
            this.lifecycleProjectionWriterDeps(),
          );
          // task #1357 item 1: which stored limits report applies follows the
          // session; clients re-read (the status is derived from the database).
          if (result.dbStatusMachineFenced) break;
          if (previousSessionId !== msg.sessionId) void this.notifyModelLimitsChanged({ agentIds: [msg.agentId] });
          if (action === "persist-active-session") {
            if (result.dbStatusApplied === false) {
              this.agentStateCache.delete(msg.agentId);
            } else {
              // A session report is not model output: a provider-limit or
              // billing error stays until the provider serves a request
              // (runtimeErrorClearsOnlyOnModelOutput).
              const currentRuntimeError = this.agentStateCache.get(msg.agentId)?.lastRuntimeError ?? agent.lastRuntimeError ?? null;
              if (runtimeErrorClearsOnlyOnModelOutput(currentRuntimeError)) {
                this.recordEvent("runtime_error_state.preserved", {
                  reason: currentRuntimeError?.errorClass === "BillingError"
                    ? "billing_session_signal"
                    : "provider_limit_session_signal",
                  detail_kind: "session",
                });
              } else {
                // Never a BillingError, even when this replica's cache is stale.
                await this.clearLastRuntimeError(msg.agentId);
              }
              this.broadcastAgentSession(agent, msg.sessionId);
              if (msg.launchId) {
                await this.recoverDurableMentionDeliveriesForAgent(msg.agentId, {
                  machineId,
                  launchId: msg.launchId,
                  sessionId: msg.sessionId,
                });
              }
            }
          }
        } catch (err) {
          console.error(`[Machine ${machineId}] Failed to update agent ${msg.agentId} session:`, err);
        }
        break;
      }

      case "agent:session:invalidate": {
        const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
        if (!agent) {
          break;
        }
        if (!this.shouldAcceptLifecycleEvent(machineId, agent, msg.type, msg.launchId)) {
          break;
        }
        const invalidated = await this.invalidatePersistedAgentSessionFromSignal(msg.agentId, msg.sessionId, machineId);
        if (invalidated) {
          this.updateCache(msg.agentId, { sessionId: null });
          this.broadcastAgentSession(agent, null);
        }
        break;
      }

      case "agent:context_view_availability": {
        // View Context: keep the latest report per agent with the Computer
        // that sent it; the status route ignores one from another Computer.
        const report = readAgentContextViewAvailability(msg);
        if (!report) {
          console.debug(`[Machine ${machineId}] Dropping malformed ${AGENT_CONTEXT_VIEW_AVAILABILITY_TYPE}`);
          break;
        }
        const span = this.tracer.startSpan("server.agent_context_view.availability.ingest", {
          surface: "server",
          kind: "consumer",
          attrs: {
            event_kind: "agent_context_view_availability",
            agent_id: report.agentId,
            machine_id: machineId,
            server_id: conn?.serverId,
            runtime: report.runtime,
            supported: report.supported,
          },
        });
        await runWithTraceSpan(span, async () => {
          const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, report.agentId, msg.type);
          if (!agent) {
            span.end("ok", { attrs: { outcome: "invalid-agent", reason: "invalid_agent" } });
            return;
          }
          if (!this.hasMachineCapability(machineId, DAEMON_CAPABILITY_AGENT_CONTEXT_VIEW_V0)) {
            span.end("ok", { attrs: { outcome: "not-advertised", reason: "capability_missing" } });
            return;
          }
          const { type: _type, ...stored } = report;
          try {
            await this.replicaStateStore.setAgentContextViewAvailability(report.agentId, {
              machineId,
              report: stored,
              receivedAt: new Date(this.clock.now()).toISOString(),
            });
            span.end("ok", { attrs: { outcome: "recorded", reason: "report_recorded" } });
          } catch (err) {
            console.warn(`[Machine ${machineId}] Failed to store context view availability for ${report.agentId}:`, err);
            span.end("error", { attrs: { outcome: "record-failed", reason: "record_failed", error_class: errorClassOf(err) } });
          }
        });
        break;
      }

      case "agent:runtime_profile": {
        const scopedTracer = createTraceScopeTracer(this.tracer, {
          actor: {
            serverId: conn?.serverId ?? undefined,
            agentId: msg.agentId,
            machineId,
            launchId: msg.launchId,
            sessionId: runtimeProfileSessionId(msg.facts.sessionRef),
          },
        });
        const span = scopedTracer.startSpan("server.runtime_profile.report.ingest", {
          parent: parseTraceparent(msg.traceparent),
          surface: "server",
          kind: "consumer",
          attrs: {
            // Actor identity comes from the typed TraceScope projection so every
            // early-return keeps the same closed identity contract.
            event_kind: "runtime_profile",
            runtime: msg.facts.runtime,
            report_source: normalizeRuntimeProfileReportSource(msg.source),
            model_present: Boolean(msg.facts.model),
            session_ref_present: Boolean(msg.facts.sessionRef),
            workspace_ref_present: Boolean(msg.facts.workspaceRef || msg.facts.workspacePathRef),
          },
        });
        await runWithTraceSpan(span, async () => {
          const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
          if (!agent) {
            span.end("ok", { attrs: { outcome: "invalid-agent", reason: "invalid_agent" } });
            return;
          }
          if (!this.shouldAcceptLifecycleEvent(machineId, agent, msg.type, msg.launchId)) {
            span.end("ok", { attrs: { outcome: "stale-launch", reason: "stale_launch" } });
            return;
          }
          if (msg.facts.runtime === "kimi") {
            span.end("ok", { attrs: { outcome: "skipped-kimi-runtime", reason: "unsupported_runtime" } });
            return;
          }
          const context = await agentRuntimeProfileService.loadAgentRuntimeProfileContext(msg.agentId);
          if (!context) {
            console.warn(`[Machine ${machineId}] Dropping runtime profile report for ${msg.agentId}: missing runtime profile context`);
            span.end("ok", { attrs: { outcome: "missing-context", reason: "missing_context" } });
            return;
          }
          try {
            const recorded = await agentRuntimeProfileService.recordAgentRuntimeProfile({
              serverId: agent.serverId,
              agentId: msg.agentId,
              machineId,
              daemonVersion: conn?.daemonVersion ?? context.machine.daemonVersion ?? null,
              facts: msg.facts,
            });
            // Reconciler step 11b: a config applied when idle shows up as a new
            // running runtime or model; clients re-read the agent on agent:updated.
            if (recorded.runtimeIdentityChanged) {
              this.io?.to(agentEventRoom(agent.serverId, agent.assistantOwnerUserId)).emit("agent:updated", { agentId: msg.agentId });
            }
            span.end("ok", { attrs: { outcome: "recorded", reason: "profile_recorded" } });
          } catch (err) {
            console.error(`[Machine ${machineId}] Failed to record runtime profile for ${msg.agentId}:`, err);
            span.end("error", { attrs: { outcome: "record-failed", reason: "record_failed", error_class: errorClassOf(err) } });
          }
        }, scopedTracer);
        break;
      }

      case "agent:model_limits": {
        // task #1357 item 1: the limits a Pi session registered. Untrusted
        // wire data: validated whole. Accepted only from the agent's current
        // Computer and, while the launch guard is armed, for its launch; the
        // write itself re-checks the Computer and the revision in the
        // database and keeps the newest report (agentModelLimitsService), so
        // a stale, late or re-sent report never replaces a newer one also
        // when the guard is not armed (legacy mode, after a server restart).
        // The launch check is the side-effect-free one: a display report must
        // not resolve a starting activity the way a rejected lifecycle event does.
        const frame = parseAgentModelLimitsFrame(msg);
        if (!frame) {
          console.warn(`[Machine ${machineId}] Dropping malformed agent:model_limits`);
          break;
        }
        // Bound to the daemon process the server recognises: this frame came
        // in on the machine's current connection (a superseded socket's
        // frames stop at the top of handleMachineMessage) and names the
        // instance that connection's ready declared. A late frame of an old
        // process, or of one before a server restart, is dropped here.
        if (!conn?.daemonInstanceId || frame.daemonInstanceId !== conn.daemonInstanceId) {
          console.warn(`[Machine ${machineId}] Dropping agent:model_limits for ${frame.agentId}: not from the current daemon instance`);
          break;
        }
        // The write touches only this instance's own row
        // (agentModelLimitsService), so a frame that pauses below while its
        // process is replaced can never overwrite another process's result.
        const agent = await this.validateMachineAgentMessage(machineId, conn.serverId ?? null, frame.agentId, msg.type);
        if (!agent) break;
        if (this.getLifecycleEventAcceptanceAction(agent, frame.launchId) !== "accept") break;
        try {
          const outcome = await recordAgentModelLimitsReport({ serverId: agent.serverId, machineId, frame });
          if (outcome === "stored") {
            this.io?.to(agentEventRoom(agent.serverId, agent.assistantOwnerUserId)).emit("agent:updated", { agentId: frame.agentId });
          }
        } catch (err) {
          console.error(`[Machine ${machineId}] Failed to record model limits for ${frame.agentId}:`, err);
        }
        break;
      }

      case "agent:runtime_profile:migration:ack": {
        const span = this.tracer.startSpan("server.runtime_profile.control.inject_ack", {
          parent: parseTraceparent(msg.traceparent),
          surface: "server",
          kind: "consumer",
          attrs: {
            event_kind: "runtime_profile",
            agent_id: msg.agentId,
            machine_id: machineId,
            server_id: conn?.serverId,
            launch_id: msg.launchId,
            agent_id_present: Boolean(msg.agentId),
            machine_id_present: Boolean(machineId),
            launch_id_present: Boolean(msg.launchId),
            control_kind: "migration",
            key_present: Boolean(msg.migrationKey),
          },
        });
        await this.runInActiveSpan(span, async () => {
          const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
          if (!agent) {
            span.end("ok", { attrs: { outcome: "invalid-agent", reason: "invalid_agent" } });
            return;
          }
          if (!this.shouldAcceptLifecycleEvent(machineId, agent, msg.type, msg.launchId)) {
            span.end("ok", { attrs: { outcome: "stale-launch", reason: "stale_launch" } });
            return;
          }
          try {
            await agentRuntimeProfileService.markRuntimeProfileMigrationDelivered(msg.agentId, msg.migrationKey, msg.launchId || null);
            span.end("ok", { attrs: { outcome: "delivered", reason: "ack_delivered" } });
          } catch (err) {
            console.error(`[Machine ${machineId}] Failed to mark runtime profile migration delivered ${msg.migrationKey} for ${msg.agentId}:`, err);
            span.end("error", { attrs: { outcome: "mark-failed", reason: "mark_failed", error_class: errorClassOf(err) } });
          }
        });
        break;
      }

      case "agent:runtime_profile:migration_done": {
        const span = this.tracer.startSpan("server.runtime_profile.migration_done", {
          parent: parseTraceparent(msg.traceparent),
          surface: "server",
          kind: "consumer",
          attrs: {
            event_kind: "runtime_profile",
            agent_id: msg.agentId,
            machine_id: machineId,
            server_id: conn?.serverId,
            launch_id: msg.launchId,
            agent_id_present: Boolean(msg.agentId),
            machine_id_present: Boolean(machineId),
            launch_id_present: Boolean(msg.launchId),
            key_present: Boolean(msg.migrationKey),
            source: "daemon",
          },
        });
        await this.runInActiveSpan(span, async () => {
          const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
          if (!agent) {
            span.end("ok", { attrs: { outcome: "invalid-agent", reason: "invalid_agent" } });
            return;
          }
          if (!this.shouldAcceptLifecycleEvent(machineId, agent, msg.type, msg.launchId)) {
            span.end("ok", { attrs: { outcome: "stale-launch", reason: "stale_launch" } });
            return;
          }
          try {
            const handled = await agentRuntimeProfileService.markRuntimeProfileMigrationHandled(msg.agentId, msg.migrationKey, msg.launchId || null);
            if (handled) {
              await this.deliverPendingRuntimeProfileMigration(machineId, agent, msg.launchId);
            }
            span.end("ok", { attrs: { outcome: handled ? "handled" : "not-handled", reason: handled ? "migration_handled" : "no_matching_migration" } });
          } catch (err) {
            console.error(`[Machine ${machineId}] Failed to mark runtime profile migration handled ${msg.migrationKey} for ${msg.agentId}:`, err);
            span.end("error", { attrs: { outcome: "handle-failed", reason: "handle_failed", error_class: errorClassOf(err) } });
          }
        });
        break;
      }

      case "agent:runtime_profile:daemon_release_notice:ack": {
        const span = this.tracer.startSpan("server.runtime_profile.control.inject_ack", {
          parent: parseTraceparent(msg.traceparent),
          surface: "server",
          kind: "consumer",
          attrs: {
            event_kind: "runtime_profile",
            agent_id: msg.agentId,
            machine_id: machineId,
            server_id: conn?.serverId,
            launch_id: msg.launchId,
            agent_id_present: Boolean(msg.agentId),
            machine_id_present: Boolean(machineId),
            launch_id_present: Boolean(msg.launchId),
            control_kind: "daemon_release_notice",
            key_present: Boolean(msg.noticeKey),
          },
        });
        await this.runInActiveSpan(span, async () => {
          const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
          if (!agent) {
            span.end("ok", { attrs: { outcome: "invalid-agent", reason: "invalid_agent" } });
            return;
          }
          if (!this.shouldAcceptLifecycleEvent(machineId, agent, msg.type, msg.launchId)) {
            span.end("ok", { attrs: { outcome: "stale-launch", reason: "stale_launch" } });
            return;
          }
          try {
            await agentRuntimeProfileService.markRuntimeProfileMigrationDelivered(msg.agentId, msg.noticeKey, msg.launchId || null);
            span.end("ok", { attrs: { outcome: "delivered", reason: "notice_ack_delivered" } });
          } catch (err) {
            console.error(`[Machine ${machineId}] Failed to ack runtime profile daemon release notice ${msg.noticeKey} for ${msg.agentId}:`, err);
            span.end("error", { attrs: { outcome: "mark-failed", reason: "mark_failed", error_class: errorClassOf(err) } });
          }
        });
        break;
      }

      case "agent:start:ack": {
        const pending = this.pendingAgentStartAcks.get(msg.startDispatchId);
        const ackAttrs = {
          queue_state: msg.queueState,
          daemon_queue_depth: msg.queueDepth,
          daemon_queue_age_ms: msg.queueAgeMs,
        };
        if (!pending) {
          const terminalReason = this.terminalAgentStartDispatches.get(msg.startDispatchId);
          await this.runInTraceSpan(
            "server.agent.start_dispatch.ack",
            {
              kind: "consumer",
              parent: parseTraceparent(msg.traceparent),
              attrs: {
                agent_id: msg.agentId,
                machine_id: machineId,
                launch_id: msg.launchId,
                start_dispatch_id: msg.startDispatchId,
                queue_state: msg.queueState,
                queue_depth: msg.queueDepth,
                queue_age_ms: msg.queueAgeMs,
              },
            },
            async () => {},
            () => ({
              attrs: {
                outcome: terminalReason ? "ignored_terminal" : "unknown_dispatch",
                terminal_reason: terminalReason ?? null,
              },
            }),
          );
          break;
        }
        const identityMatches = pending.machineId === machineId
          && pending.msg.agentId === msg.agentId
          && pending.msg.launchId === msg.launchId;
        await this.runInTraceSpan(
          "server.agent.start_dispatch.ack",
          {
            kind: "consumer",
            parent: parseTraceparent(msg.traceparent ?? pending.msg.traceparent),
            attrs: {
              ...this.startDispatchTraceAttrs(pending),
              ...ackAttrs,
            },
          },
          async () => {
            if (identityMatches) {
              this.terminalizePendingAgentStart(msg.startDispatchId, "acked", "acked", ackAttrs);
            }
          },
          () => ({
            attrs: identityMatches
              ? { outcome: "acked", terminal_reason: "acked" }
              : { outcome: "rejected", terminal_reason: null, reason: "identity_mismatch" },
          }),
        );
        break;
      }

      case "agent:send_intent": {
        await this.handleAgentSendIntent(machineId, conn?.serverId ?? null, msg);
        break;
      }

      case "agent:model-seen": {
        await this.runInTraceSpan(
          "server.agent.model_seen.ingest",
          {
            kind: "consumer",
            attrs: {
              agent_id: msg.agentId,
              machine_id: machineId,
              launch_id_present: Boolean(msg.launchId),
              items_count: msg.items.length,
            },
          },
          async (): Promise<TraceAttributes> => {
            const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
            if (!agent) return { outcome: "dropped", reason: "invalid_agent" };
            // A report from a launch the guard no longer expects describes a
            // process that is gone; it must not move the read position.
            if (this.getLifecycleEventAcceptanceAction(agent, msg.launchId) !== "accept") {
              return { outcome: "dropped", reason: "stale_launch" };
            }
            let advanced = 0;
            let unchanged = 0;
            // Each item costs reads and maybe a write; a daemon never sends more
            // than the cap in one report, so the rest is ignored (positions stay).
            const items = msg.items.slice(0, MODEL_SEEN_MAX_ITEMS_PER_REPORT);
            for (const item of items) {
              const result = await this.applyAgentModelSeen({
                agentId: msg.agentId,
                serverId: agent.serverId ?? null,
                channelId: item.channelId,
                seqs: item.seqs,
              });
              if (result.outcome === "advanced") advanced += 1;
              else unchanged += 1;
            }
            return {
              outcome: "applied",
              advanced_count: advanced,
              unchanged_count: unchanged,
              ignored_items_count: msg.items.length - items.length,
            };
          },
          (attrs) => ({ attrs }),
        );
        break;
      }

      case "agent:runtime:ready": {
        await this.runInTraceSpan(
          "server.agent.runtime_ready.ingest",
          { kind: "consumer", attrs: { agent_id: msg.agentId, machine_id: machineId } },
          async (): Promise<TraceAttributes> => {
            if (typeof msg.launchId !== "string" || !msg.launchId) return { outcome: "dropped", reason: "invalid_frame" };
            const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
            if (!agent) return { outcome: "dropped", reason: "invalid_agent" };
            // The breaker itself ignores a launch that is not its current start.
            const progress = await this.observeStartProgress(msg.agentId, msg.launchId);
            return { outcome: progress.changed ? "streak_cleared" : "unchanged", unpaused: progress.unpaused };
          },
          (attrs) => ({ attrs }),
        );
        break;
      }

      // #proj-raft-computer:#48 (reconciler step 4b): the daemon no longer
      // counts this agent's credential invalid for `reason` (and the agent
      // had shown that error or the held notice). Only a wake block of the
      // same reason lifts. Older daemons never send it; their blocks lift on
      // a login or a person's start, as before.
      case "agent:credential:restored": {
        await this.runInTraceSpan(
          "server.agent.credential_restored.ingest",
          { kind: "consumer", attrs: { agent_id: msg.agentId, machine_id: machineId } },
          async (): Promise<TraceAttributes> => {
            const restored = parseCredentialRestoredMessage(msg);
            if (!restored) return { outcome: "dropped", reason: "invalid_frame" };
            const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, restored.agentId, msg.type);
            if (!agent) return { outcome: "dropped", reason: "invalid_agent" };
            const lifted = await this.wakeCrashLoopBreaker.liftForCredentialRestored(restored.agentId, restored.reason);
            if (lifted) {
              this.recordEvent("wake.block_lifted", {
                cause: "credential_restored",
                source: "daemon_frame",
                release_cause: restored.releaseCause,
                lifted_reason: restored.reason,
                launch_id_present: restored.launchId !== null,
              });
            }
            return {
              outcome: lifted ? "block_lifted" : "unchanged",
              credential_invalid_reason: restored.reason,
              release_cause: restored.releaseCause,
            };
          },
          (attrs) => ({ attrs }),
        );
        break;
      }

      case "agent:turn:ended": {
        await this.runInTraceSpan(
          "server.agent.turn_ended.ingest",
          {
            kind: "consumer",
            attrs: {
              agent_id: msg.agentId,
              machine_id: machineId,
              outcome: typeof msg.outcome === "string" ? msg.outcome : "invalid",
            },
          },
          async (): Promise<TraceAttributes> => {
            if (
              typeof msg.launchId !== "string" || !msg.launchId
              || !(AGENT_TURN_ENDED_OUTCOMES as readonly unknown[]).includes(msg.outcome)
              || !Array.isArray(msg.shownUnreadTargets)
            ) {
              return { outcome: "dropped", reason: "invalid_frame" };
            }
            const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
            if (!agent) return { outcome: "dropped", reason: "invalid_agent" };
            // Only the launch the guard expects: a stale launch's frame must not
            // settle (or consume) the current launch's snapshot.
            if (this.getLifecycleEventAcceptanceAction(agent, msg.launchId) !== "accept") {
              return { outcome: "dropped", reason: "stale_launch" };
            }
            const taken = this.turnEndUnreadSnapshots.take(msg.agentId, {
              launchId: msg.launchId,
              outcome: msg.outcome,
              shownUnreadTargets: msg.shownUnreadTargets.filter((target): target is string => typeof target === "string"),
            });
            if (taken.kind !== "settle") return { outcome: "skipped", reason: taken.kind };
            const settled = await this.settleUnowedReadBacklog(msg.agentId, taken.targets);
            return {
              outcome: "settled",
              shown_target_count: taken.shownCount,
              ignored_target_count: taken.ignoredCount,
              conversation_count: settled.conversations,
              message_count: settled.messages,
              kept_conversation_count: settled.keptConversations,
            };
          },
          (attrs) => ({ attrs }),
        );
        break;
      }

      case "agent:delivery:transition": {
        const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
        if (
          !agent
          || msg.mentionDelivery.machineId !== machineId
        ) {
          break;
        }
        if (
          msg.mentionDelivery.launchId !== agent.expectedLaunchId
          || msg.mentionDelivery.sessionId !== agent.sessionId
        ) {
          await mentionDeliveryOccurrenceService.recordMentionDeliveryIdentityDriftForIdentity({
            occurrenceId: msg.mentionDelivery.occurrenceId,
            agentId: msg.agentId,
            messageId: msg.mentionDelivery.messageId,
            identity: msg.mentionDelivery,
            stage: "stage_receipt",
          });
          break;
        }
        if (msg.stage === "daemon_pending") {
          this.recordAgentDeliveryArrival(msg.agentId, msg.mentionDelivery.occurrenceId);
        }
        await mentionDeliveryOccurrenceService.recordMentionDeliveryDaemonTransition({
          occurrenceId: msg.mentionDelivery.occurrenceId,
          agentId: msg.agentId,
          messageId: msg.mentionDelivery.messageId,
          identity: msg.mentionDelivery,
          stage: msg.stage,
          outcome: msg.outcome,
        });
        break;
      }

      case "agent:wake:request": {
        await this.handleAgentWakeRequest(machineId, conn?.serverId ?? null, msg);
        break;
      }

      case "agent:runtime:outcome":
      case "agent:process_spawned":
      case "agent:process_exited":
      case "agent:start:outcome":
      case "agent:runtime:outcome_gap":
      case "agent:runtime:outcome_cross_instance_unknown": {
        await this.handleRuntimeOutcomeOutboxMessage(machineId, conn, msg);
        break;
      }

      case "agent:runtime:outcome_unreliable": {
        // RFC 071 outbox, best effort: the daemon's evidence for this agent may
        // be missing until a human start resolves it. Until the next `ready`,
        // `agent:runtime-outcome-v1` does not apply to the agent here.
        if (!conn || !this.runtimeOutcomeAckEnabled) break;
        const agent = await this.validateMachineAgentMessage(machineId, conn.serverId, msg.agentId, msg.type);
        if (!agent) break;
        (conn.runtimeOutcomeUnreliableAgents ??= new Set()).add(msg.agentId);
        this.recordEvent("terminal_breaker.outcome_unreliable", { agent_id: msg.agentId, daemon_instance_id: msg.daemonInstanceId });
        break;
      }

      case "agent:delivery:rejected": {
        await this.handleAgentDeliveryRejected(machineId, conn?.serverId ?? null, msg);
        break;
      }

      case "agent:delivery:terminal_error": {
        const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
        if (
          !agent
          || msg.mentionDelivery.machineId !== machineId
        ) {
          break;
        }
        const receipt = {
          occurrenceId: msg.mentionDelivery.occurrenceId,
          agentId: msg.agentId,
          messageId: msg.mentionDelivery.messageId,
          identity: msg.mentionDelivery,
        };
        const terminal = (
          msg.mentionDelivery.launchId !== agent.expectedLaunchId
          || msg.mentionDelivery.sessionId !== agent.sessionId
        )
          ? await mentionDeliveryOccurrenceService.recordMentionDeliveryIdentityDriftForIdentity({
            ...receipt,
            stage: "terminal_receipt",
            originalDaemonCode: msg.code,
          })
          : await mentionDeliveryOccurrenceService.recordMentionDeliveryTerminalError({ ...receipt, code: msg.code });
        // Already ended at the daemon's stage receipt (IDENTITY_DRIFT), which sent
        // nothing: this refusal says the message was not delivered (Bencher).
        const claimed = terminal ?? await mentionDeliveryOccurrenceService.claimStageDriftForDaemonTerminal({ ...receipt, code: msg.code });
        if (claimed) {
          this.clearPendingAgentDeliveryAck({
            agentId: msg.agentId,
            seq: claimed.deliveryPayload?.seq ?? 0,
            deliveryId: msg.mentionDelivery.occurrenceId,
          }, "terminal");
          await this.redeliverUntrackedAfterMentionTerminal(machineId, msg.agentId, claimed.deliveryPayload, msg.code);
        }
        break;
      }

      case "agent:deliver:ack": {
        if (conn) conn.lastDeliveryAckAt = this.clock.now();
        const span = this.tracer.startSpan("server.agent.delivery.ack", {
          parent: parseTraceparent(msg.traceparent),
          surface: "server",
          kind: "server",
          attrs: {
            agent_id: msg.agentId,
            machine_id: machineId,
            server_id: conn?.serverId,
            agent_id_present: Boolean(msg.agentId),
            machine_id_present: Boolean(machineId),
            deliveryId: msg.deliveryId,
            delivery_correlation_id: msg.deliveryId,
            seq: msg.seq,
            ...projectMachineConnectTraceAttrs(conn?.traceContext ?? buildRuntimeTraceContext()),
          },
        });
        await this.runInActiveSpan(span, async () => {
          this.recordEvent("server.ack.received", {
            outcome: "received",
            reason: "daemon_delivery_ack",
            seq: msg.seq,
            deliveryId: msg.deliveryId,
          });
          const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
          if (!agent) {
            span.end("ok", {
              attrs: {
                outcome: "invalid-agent",
                reason: "invalid_agent",
              },
            });
            return;
          }
          if (msg.mentionDelivery) {
            if (
              msg.mentionDelivery.machineId !== machineId
            ) {
              span.end("ok", { attrs: { outcome: "identity-mismatch", reason: "mention_identity_mismatch" } });
              return;
            }
            if (
              msg.mentionDelivery.launchId !== agent.expectedLaunchId
              || msg.mentionDelivery.sessionId !== agent.sessionId
            ) {
              const terminal = await mentionDeliveryOccurrenceService.recordMentionDeliveryIdentityDriftForIdentity({
                occurrenceId: msg.mentionDelivery.occurrenceId,
                agentId: msg.agentId,
                messageId: msg.mentionDelivery.messageId,
                identity: msg.mentionDelivery,
                stage: "ack_receipt",
              });
              if (terminal) this.clearPendingAgentDeliveryAck({
                agentId: msg.agentId,
                seq: terminal.deliveryPayload?.seq ?? 0,
                deliveryId: msg.mentionDelivery.occurrenceId,
              }, "terminal");
              span.end("ok", { attrs: { outcome: "identity-drift", reason: "mention_identity_drift" } });
              return;
            }
            const durableAck = await mentionDeliveryOccurrenceService.recordMentionDeliveryAck({
              occurrenceId: msg.mentionDelivery.occurrenceId,
              agentId: msg.agentId,
              messageId: msg.mentionDelivery.messageId,
              identity: msg.mentionDelivery,
            });
            if (!durableAck) {
              span.end("ok", { attrs: { outcome: "durable-ack-rejected", reason: "mention_ack_not_joinable" } });
              return;
            }
          }
          const pendingCleared = this.clearPendingAgentDeliveryAck(msg, "acked");
          const ackResult = this.acknowledgeDeliveredMessages(msg.agentId, [msg.seq]);
          if (ackResult.removedCount > 0) {
            this.recordEvent("inbox.cleared", {
              outcome: "cleared",
              reason: "acknowledged_seq",
              action: "clear_inbox",
              removedCount: ackResult.removedCount,
            });
            const turnActiveWrite = this.recordDeliveryAckTurnActive(msg.agentId, agent, span);
            if (turnActiveWrite) {
              const turnActiveArbitration = turnActiveWrite.arbitration;
              this.recordEvent("turn_active.observed", {
                outcome: turnActiveWrite.action === "kernel-preserve" ? "preserved" : "applied",
                reason: "daemon_delivery_ack",
                activity: turnActiveWrite.nextActivity,
                activity_log_action: turnActiveWrite.action,
                activity_log_entry_count: turnActiveWrite.persistedEntryCount,
                arbitration_reason: turnActiveArbitration?.reason,
                arbitration_action: turnActiveArbitration?.verdictAction,
              });
            }
          } else if (pendingCleared) {
            this.recordEvent("pending_delivery.cleared", {
              outcome: "cleared",
              reason: "delivery_acknowledged",
              action: "clear_pending_delivery",
            });
          } else {
            this.recordEvent("inbox.clear.noop", {
              outcome: "noop",
              reason: "seq_not_pending",
              action: "clear_inbox",
            });
          }
          span.end("ok", {
            attrs: {
              outcome: ackResult.removedCount > 0 ? "cleared-inbox" : "noop",
              reason: ackResult.removedCount > 0 ? "acknowledged_seq" : "seq_not_pending",
              ack_result: ackResult.removedCount > 0 ? "acknowledged_seq" : "seq_not_pending",
            },
          });
        });
        break;
      }

      case "reminder.armed": {
        const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
        if (!agent) break;
        const sourceId = msg.reminderId;
        const traceAttrs = protocolSourceTraceAttrs({
          ownerAgentId: msg.agentId,
          sourceId,
          version: msg.version,
          messageType: msg.type,
        });
        await this.runAppSourceReceipt(
          { ...traceAttrs, machine_id: machineId, server_id: agent.serverId, agent_id: agent.id, receipt_type: msg.type },
          async (setReceiptOutcome) => {
            try {
              const recorded = await reminderService.recordReminderArmed(
                sourceId,
                msg.agentId,
                msg.version,
              );
              setReceiptOutcome(
                {
                  outcome: recorded ? "recorded" : "not_recorded",
                  ...(!recorded ? { reason: "identity_mismatch_or_missing" } : {}),
                },
                recorded ? "ok" : "error",
              );
            } catch (err) {
              setReceiptOutcome({
                outcome: "record_failed",
                reason: "record_reminder_armed_threw",
                error_class: errorClassOf(err),
              }, "error");
              console.error(`[Machine ${machineId}] Failed to record reminder arm ${sourceId}:`, err);
            }
          },
        );
        break;
      }

      case "reminder.arm_rejected": {
        const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
        if (!agent) break;
        const sourceId = msg.reminderId;
        const traceAttrs = protocolSourceTraceAttrs({
          ownerAgentId: msg.agentId,
          sourceId,
          version: msg.version,
          messageType: msg.type,
        });
        await this.runAppSourceReceipt(
          { ...traceAttrs, machine_id: machineId, server_id: agent.serverId, agent_id: agent.id, receipt_type: msg.type },
          async (setReceiptOutcome) => {
            try {
              const recorded = await reminderService.markReminderNotArmed(
                sourceId,
                msg.agentId,
                msg.version,
              );
              setReceiptOutcome(
                {
                  outcome: recorded ? "recorded" : "not_recorded",
                  reason: recorded ? msg.reason : "identity_mismatch_or_missing",
                },
                recorded ? "ok" : "error",
              );
            } catch (err) {
              setReceiptOutcome({
                outcome: "record_failed",
                reason: "mark_reminder_not_armed_threw",
                error_class: errorClassOf(err),
              }, "error");
              console.error(`[Machine ${machineId}] Failed to record reminder arm rejection ${sourceId}:`, err);
            }
          },
        );
        break;
      }

      case "reminder.fire_receipt": {
        const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
        if (!agent) break;
        const sourceId = msg.reminderId;
        const traceAttrs = protocolSourceTraceAttrs({
          ownerAgentId: msg.agentId,
          sourceId,
          version: msg.version,
          messageType: msg.type,
        });
        await this.runAppSourceReceipt(
          { ...traceAttrs, machine_id: machineId, server_id: agent.serverId, agent_id: agent.id, receipt_type: msg.type },
          async (setReceiptOutcome) => {
            try {
              const existing = await reminderService.getReminderById(sourceId);
              const action = planReminderFireReceiptAction({
                reminderExists: existing !== null,
                reminderServerMatchesAgent: existing?.serverId === agent.serverId,
                reminderOwnerAgentId: existing?.ownerAgentId ?? null,
                reminderVersion: existing?.version ?? 0,
                reminderStatus: existing?.status ?? "missing",
                receiptAgentId: msg.agentId,
                receiptVersion: msg.version,
              });
              if (action === "reject" && (!existing || existing.serverId !== agent.serverId)) {
                setReceiptOutcome({
                  outcome: "rejected",
                  reason: "server_mismatch_or_missing",
                }, "error");
                console.warn(`[Machine ${machineId}] reminder.fire_receipt server mismatch or missing reminder ${sourceId}`);
                return;
              }
              if (action === "reject") {
                setReceiptOutcome({
                  outcome: "rejected",
                  reason: "owner_or_revision_mismatch",
                }, "error");
                console.warn(`[Machine ${machineId}] reminder.fire_receipt owner mismatch for current revision ${sourceId}`);
                return;
              }
              if (action === "converge-current") {
                const result = await reminderService.fireReminder(sourceId, msg.version, { catchup: msg.catchup });
                // `result.ok`, NOT truthiness: a refusal is now an object and would
                // pass a bare `if (result)`, sending us into the success branch with
                // an undefined row.
                //
                // Wording is deliberately generic: this layer routes fire receipts
                // for any app and has no business naming one, which is exactly what
                // the app-name ratchet enforces. The FIELDS are the reviewed
                // observability surface (@Huaihuai) and must all survive -- the
                // owning service only logs the premature case, and machineId does
                // not exist down there at all.
                if (!result.ok) {
                  console.warn(
                    `[Machine ${machineId}] scheduled fire refused for ${sourceId}: `
                    + `reason=${result.reason} now=${result.now.toISOString()} `
                    + `dueAt=${result.fireAt?.toISOString() ?? "unknown"}`,
                  );
                } else {
                  const fired = result.row;
                  if (shouldEmitReminderFiredLifecycle(result)) {
                    this.io?.to(`server:${fired.serverId}`).emit("reminder:fired", {
                      reminderId: fired.id,
                      ownerAgentId: fired.ownerAgentId,
                      firedAt: fired.firedAt?.toISOString() ?? msg.firedAtClient,
                      catchup: result.catchup,
                      nextFireAt: result.nextFireAt?.toISOString() ?? null,
                    });
                  }
                  if (result.nextFireAt) {
                    await this.pushReminderUpsert(fired.ownerAgentId, fired);
                  } else {
                    await this.pushReminderCancel(fired.ownerAgentId, fired.id, fired.version);
                  }
                }
              }
              if (action === "ack-historical") {
                const acked = await this.sendToMachine(machineId, {
                  type: "reminder.fire_receipt.ack",
                  agentId: msg.agentId,
                  reminderId: sourceId,
                  version: msg.version,
                });
                setReceiptOutcome(
                  {
                    outcome: acked
                      ? "historical_ack_sent"
                      : "historical_ack_failed",
                    catchup: msg.catchup,
                  },
                  acked ? "ok" : "error",
                );
                return;
              }
              const converged = await reminderService.getReminderById(sourceId);
              if (converged && converged.serverId === agent.serverId && converged.version > msg.version) {
                const acked = await this.sendToMachine(machineId, {
                  type: "reminder.fire_receipt.ack",
                  agentId: msg.agentId,
                  reminderId: sourceId,
                  version: msg.version,
                });
                setReceiptOutcome(
                  {
                    outcome: acked ? "converged_ack_sent" : "converged_ack_failed",
                    ...(acked ? {} : { reason: "machine_unreachable" }),
                    catchup: msg.catchup,
                  },
                  acked ? "ok" : "error",
                );
              } else {
                setReceiptOutcome({
                  outcome: "converged_without_ack",
                  catchup: msg.catchup,
                });
              }
            } catch (err) {
              setReceiptOutcome({
                outcome: "convergence_failed",
                reason: "reminder_convergence_threw",
                error_class: errorClassOf(err),
              }, "error");
              console.error(`[Machine ${machineId}] Failed to converge reminder receipt ${sourceId}:`, err);
            }
          },
        );
        break;
      }

      case "reminder.snapshot.request": {
        const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
        if (!agent) break;
        const composition = await composeReminderSnapshot(msg.agentId);
        await this.deliverBuiltInAppSnapshot({
          machineId,
          messageType: "reminder.snapshot",
          spanName: "server.app_source.transport",
          composition,
          buildMessage: (reminders) => ({
            type: "reminder.snapshot",
            agentId: msg.agentId,
            reminders,
          }),
        });
        break;
      }

      case "app_config.snapshot.request": {
        const agent = await this.validateMachineAgentMessage(
          machineId,
          conn?.serverId ?? null,
          msg.agentId,
          msg.type,
        );
        if (!agent) break;
        const composition = await listBuiltInAppConfigSnapshotsForAgent({
          serverId: agent.serverId,
          ownerAgentId: msg.agentId,
        });
        await this.deliverBuiltInAppSnapshot({
          machineId,
          messageType: "app_config.snapshot",
          spanName: "server.app_config.transport",
          composition,
          buildMessage: (configs) => ({
            type: "app_config.snapshot",
            agentId: msg.agentId,
            configs,
          }),
        });
        break;
      }

      // The current flag-derived agent config fields of the Server this
      // connection is bound to (shared featuresChanged.ts), never another's.
      // A failed evaluation or send answers nothing: the daemon keeps the
      // values it has (an evaluation that failed must never read as "all off").
      case "server:features:request": {
        const serverId = conn?.serverId ?? null;
        if (!serverId || typeof msg.requestId !== "string" || !msg.requestId || msg.requestId.length > 128) break;
        try {
          const features = await this.agentServerFeaturesStrict(serverId);
          const sendResult = await this.trySendAppTransport(machineId, {
            type: "server:features",
            requestId: msg.requestId,
            serverId,
            features,
          });
          if (sendResult.outcome !== "sent") {
            console.warn(`[Machine ${machineId}] server:features not sent (${sendResult.reason})`);
          }
        } catch (err) {
          console.warn(`[Machine ${machineId}] server:features evaluation failed; not answering`, err);
        }
        break;
      }

      case "agent:skills:list_result":
        this.observeAgentSkillsListResult(machineId, msg);
        this.emit(`machine:response:${machineId}`, msg);
        break;

      // task #25 step 2: the daemon's answer to a stop-this-turn request; the
      // person's request may be waiting on another replica.
      case "agent:interrupt-turn:result":
      // #proj-runtime:#41: the daemon's answer to a stop-this-sub-agent request.
      case "agent:interrupt-subagent:result":
        this.emit(`machine:response:${machineId}`, msg);
        void this.getMachineResponseRelay().forward(machineId, msg,
          (event, attrs) => this.recordMachineResponseRelay(event, attrs));
        break;

      case "agent:workspace:file_tree":
      case "agent:workspace:file_content":
      case "machine:workspace:scan_result":
      case "machine:workspace:delete_result":
      case "machine:migration:source_workspace_archive_result":
      case "machine:runtime_models:result":
      case "machine:provider_probe:result":
      case "agent:diagnostic:session_transcript_result":
      case "agent:diagnostic:feedback_transcript_result":
        if (msg.type === "agent:diagnostic:feedback_transcript_result") this.observeLateFeedbackTranscriptResult(machineId, msg);
        // These are responses to workspace/machine/diagnostic requests — emit events for pending promises
        this.emit(`machine:response:${machineId}`, msg);
        if (
          msg.type === "machine:runtime_models:result"
          || msg.type === "machine:migration:source_workspace_archive_result"
          || msg.type === "machine:provider_probe:result"
        ) {
          void this.getMachineResponseRelay().forward(machineId, msg,
            (event, attrs) => this.recordMachineResponseRelay(event, attrs));
        }
        break;
    }
  }

  /**
   * RFC 071 part 3: commit the frame (breaker state + outbox watermark, one
   * compare-and-set), then ack it on the machine. Nothing while the ack
   * capability is not advertised. A frame for an agent this machine does not
   * own, a held frame, or a failed commit gets no ack: the daemon keeps it.
   */
  private async handleRuntimeOutcomeOutboxMessage(
    machineId: string,
    conn: MachineConnection | undefined,
    msg: RuntimeOutcomeOutboxMessage,
  ): Promise<void> {
    if (!this.runtimeOutcomeAckEnabled) return;
    const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
    if (!agent) return;
    const result = await ingestRuntimeOutcomeOutboxMessage(
      {
        applyOutboxFrame: async (agentId, frame, input) => {
          const applied = await this.terminalFailureBreaker.applyOutboxFrame(agentId, frame, input);
          if (applied.startFailureWithdrawn) {
            // task #365: the #1119 start-failure streak had already counted
            // this start before its outbox arrived; that one contribution was
            // withdrawn in the same commit. A retry-once timer it scheduled
            // may still fire; its start is refused by the RFC 071 pause.
            this.recordEvent("wake.start_failure_owned_by_terminal_breaker", {
              agent_id: agentId,
              launch_id: frame.kind === "start_not_spawned" ? frame.launchId : undefined,
              unblocked: applied.startFailureUnblocked === true,
            });
          }
          return applied;
        },
        applyOutcomeMarker: (agentId, marker, input) => this.terminalFailureBreaker.applyOutcomeMarker(agentId, marker, input),
        send: (message) => this.sendToMachine(machineId, message),
      },
      msg,
      {
        nowMs: this.clock.now(),
        // RFC 071 §6: an E1 that opens the breaker owes each unread
        // conversation up to its latest unread seq. Read only for an E1.
        unreadCeilings: msg.type === "agent:runtime:outcome" && msg.outcome?.kind === "terminal_failure"
          ? await this.terminalUnreadCeilings(msg.agentId)
          : null,
        persistedSessionId: agent.sessionId,
      },
    );
    if (result.kind === "commit_failed") {
      console.warn(`[Machine ${machineId}] RFC 071 outbox ${msg.type} for agent ${msg.agentId} not committed; not acked, the daemon resends:`, result.error);
      return;
    }
    // RFC 071 §9: a frame that opened the breaker shows the pause once. A
    // needs-manual block is shown when it refuses a wake (the agent may still
    // be running when the evidence of an earlier process is found lost).
    if (result.kind === "acked" && !result.duplicate && result.outcome === "spawn_error_counted") {
      agentWakePauseTransitionsTotal.inc({ kind: "spawn_error_counted" });
    }
    if (
      result.kind === "acked" && !result.duplicate
      && msg.type === "agent:start:outcome" && msg.result?.kind === "not_spawned" && msg.result.reason === "stale_dispatch"
    ) {
      // Whether or not the launch is still current: the daemon will refuse
      // every resend of that frame, so stop resending it (review of #9140).
      this.stopStaleDispatchRetries(msg.agentId, msg.launchId);
      if (result.outcome === "stale_dispatch_released") await this.reserveStaleDispatch(msg.agentId, msg.launchId);
    }
    if (result.kind === "acked" && !result.duplicate) await this.projectTerminalBlock(msg.agentId, { includeNeedsManual: false });
  }

  /**
   * RFC 071 §6 "what is owed": conversation -> latest unread seq from the
   * agent's inbox chain. Null when the chain cannot be read, which owes every
   * unread row (`owedOverflow`, the conservative side).
   */
  private async terminalUnreadCeilings(agentId: string): Promise<Record<string, number> | null> {
    try {
      const inbox = await this.selectResumeInbox(agentId);
      if (inbox.source === "unavailable") return null;
      const ceilings: Record<string, number> = {};
      for (const row of inbox.rows) {
        const latest = row.latestSeq ?? row.maxMentionSeq;
        if (row.offeredUnread > 0 && latest !== null && latest > row.lastReadSeq) {
          ceilings[row.targetId] = Math.max(ceilings[row.targetId] ?? latest, latest);
        }
      }
      return ceilings;
    } catch (error) {
      console.warn(`[Agent ${agentId}] unread snapshot for the terminal-failure breaker failed; every unread row is owed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private refreshReplicaLivenessFromDaemonIngress(
    machineId: string,
    conn: MachineConnection | undefined,
    messageType: MachineToServerMessage["type"],
  ) {
    if (!conn || !this.replicaStateStore.isAvailable()) return;
    if (messageType === "pong") return;

    const now = this.clock.now();
    const last = this.lastIngressReplicaRefreshAt.get(machineId);
    if (last !== undefined && now - last < AgentOrchestrator.INGRESS_REPLICA_REFRESH_MIN_INTERVAL_MS) {
      return;
    }
    this.lastIngressReplicaRefreshAt.set(machineId, now);

    this.refreshMachineOwnerLease(machineId, conn, "ingress");
  }

  /**
   * Best-effort lease refresh, but never silent (task #440): a refresh that
   * keeps not writing leaves a live socket unroutable from every other replica.
   */
  private refreshMachineOwnerLease(
    machineId: string,
    conn: MachineConnection | undefined,
    trigger: "pong" | "ingress",
  ): void {
    const record = (result: string, errorClass?: string) => {
      machineOwnerRefreshTotal.inc({ trigger, result });
      if (result === "refreshed") return;
      this.recordEvent("machine.replica.refresh", {
        outcome: result === "error" ? "error" : "not_refreshed",
        result,
        trigger,
        machine_id: machineId,
        ...(errorClass ? { error_class: errorClass } : {}),
      });
    };
    const traceParent = getCurrentTraceContext();
    this.replicaStateStore
      .refreshMachineReplica(
        machineId,
        conn?.traceContext ?? buildRuntimeTraceContext(),
        conn?.replicaGeneration ?? undefined,
      )
      .then(
        (result) => {
          record(result ?? "unknown");
          if (!conn) return;
          if (result === "refreshed") {
            conn.duplicateLeaseEvidence = undefined;
            this.publishReplicaInstance(machineId, conn);
          }
          if (result === "rejected_other_lease") void this.observeForeignOwnerLease(machineId, conn, traceParent);
        },
        (err) => record("error", errorClassOf(err)),
      );
  }

  /**
   * Task #374 observation: the lease holder records which daemon is behind the
   * lease, so the side that keeps being refused can name both daemons when it
   * reports a duplicate. Written at most every half TTL per connection, and
   * only once the daemon has identified itself in `ready`. Old daemons send no
   * instance id in `ready`; their version and hostname hash are still published.
   */
  private publishReplicaInstance(machineId: string, conn: MachineConnection): void {
    // `ready` sets the hostname hash (to a hash or null); undefined means not yet identified.
    if (!conn.replicaGeneration || conn.reportedHostnameHash === undefined) return;
    const now = this.clock.now();
    if (
      conn.lastReplicaInstancePublishedAt !== undefined
      && now - conn.lastReplicaInstancePublishedAt < AgentOrchestrator.REPLICA_INSTANCE_PUBLISH_INTERVAL_MS
    ) return;
    conn.lastReplicaInstancePublishedAt = now;
    void this.replicaStateStore.setMachineReplicaInstance?.(machineId, {
      generation: conn.replicaGeneration,
      daemonInstanceId: conn.daemonInstanceId,
      daemonVersion: conn.daemonVersion,
      reportedHostnameHash: conn.reportedHostnameHash ?? null,
    })?.catch(() => {
      conn.lastReplicaInstancePublishedAt = undefined;
    });
  }

  /**
   * Task #374, observation only. This socket's refresh was refused because the
   * lease is held elsewhere. That alone also happens briefly during a normal
   * reconnect hand-off, so it counts as a second live connection only when the
   * holder is another replica whose lease keeps being renewed (its
   * `replica_updated_at` advances) while this socket stays alive and refused.
   */
  private async observeForeignOwnerLease(
    machineId: string,
    conn: MachineConnection,
    traceParent: ReturnType<typeof getCurrentTraceContext>,
  ): Promise<void> {
    let lease: Awaited<ReturnType<NonNullable<ReplicaStateStore["getMachineReplicaLease"]>>>;
    try {
      lease = await this.replicaStateStore.getMachineReplicaLease?.(machineId) ?? null;
    } catch {
      return;
    }
    if (this.machineConnections.get(machineId) !== conn) return;
    if (!lease?.replicaId || lease.replicaId === REPLICA_ID || lease.updatedAtMs === null) return;
    const now = this.clock.now();
    const evidence = conn.duplicateLeaseEvidence ??= {
      firstRejectedAt: now,
      lastForeignUpdatedAtMs: lease.updatedAtMs,
      foreignAdvances: 0,
      reported: false,
    };
    if (lease.updatedAtMs > evidence.lastForeignUpdatedAtMs) {
      evidence.foreignAdvances += 1;
      evidence.lastForeignUpdatedAtMs = lease.updatedAtMs;
    }
    if (
      evidence.reported
      || evidence.foreignAdvances < AgentOrchestrator.DUPLICATE_LEASE_MIN_FOREIGN_ADVANCES
      || now - evidence.firstRejectedAt < AgentOrchestrator.DUPLICATE_LEASE_MIN_DURATION_MS
    ) return;
    evidence.reported = true;
    machineDuplicateConnectionsTotal.inc({ daemon_version: daemonVersionLabel(conn.daemonVersion) });
    // Newest wins: this socket is the one being refused, so it is the older
    // one (a registration always takes the lease). Closing needs the winner's
    // generation for the hold; without it the decision is left to a later pass.
    const winnerGeneration = typeof lease.generation === "string" && lease.generation ? lease.generation : null;
    const enforce = this.duplicateConnectionEnforcement && winnerGeneration !== null;
    const span = this.tracer.startSpan("server.machine.duplicate_connection", {
      parent: traceParent ?? null,
      surface: "server",
      kind: "internal",
      attrs: { machine_id: machineId },
    });
    span.addEvent("machine.connection.duplicate_detected", {
      machine_id: machineId,
      daemon_version: daemonVersionLabel(conn.daemonVersion),
      foreign_lease_advances: evidence.foreignAdvances,
      refused_for_ms: now - evidence.firstRejectedAt,
      // Clues about both daemons, not attribution. Instance ids are per
      // process, so they only separate "one process, two sockets" from "two
      // processes". The reported hostnames being the same or different is a
      // hint (names repeat across hosts and change on one host); telling two
      // installs on one host from two hosts needs separate evidence.
      refused_daemon_instance_id: conn.daemonInstanceId ?? "unknown",
      holder_daemon_instance_id: lease.instance?.daemonInstanceId ?? "unknown",
      holder_daemon_version: daemonVersionLabel(lease.instance?.daemonVersion ?? null),
      // Compared only when both sides sent an instance id; old daemons send none.
      same_daemon_instance: !conn.daemonInstanceId || !lease.instance?.daemonInstanceId
        ? "unknown"
        : conn.daemonInstanceId === lease.instance.daemonInstanceId ? "same" : "different",
      refused_hostname_hash: conn.reportedHostnameHash ?? "unknown",
      holder_hostname_hash: lease.instance?.reportedHostnameHash ?? "unknown",
      reported_hostname_match: !conn.reportedHostnameHash || !lease.instance?.reportedHostnameHash
        ? "unknown"
        : conn.reportedHostnameHash === lease.instance.reportedHostnameHash ? "same" : "different",
      enforcement: enforce ? "closed_older" : "observe_only",
    });
    if (enforce) {
      try {
        await this.replicaStateStore.setMachineDuplicateHold?.(
          machineId,
          { replicaId: lease.replicaId, generation: winnerGeneration!, closedDaemonVersion: conn.daemonVersion },
          AgentOrchestrator.DUPLICATE_HOLD_TTL_SECONDS,
        );
      } catch (error) {
        span.addEvent("machine.connection.duplicate_hold_write_failed", { error_class: errorClassOf(error) });
      }
      machineDuplicateConnectionActionsTotal.inc({ action: "closed_older", daemon_version: daemonVersionLabel(conn.daemonVersion) });
      conn.closedAsDuplicate = true;
      if (conn.ws.readyState === 1) {
        conn.ws.close(DUPLICATE_MACHINE_CONNECTION_CLOSE_CODE, MACHINE_DUPLICATE_CONNECTION_CLOSE_REASON);
      }
    }
    span.end("ok");
  }

  /**
   * Task #374: refuse a held duplicate during the WebSocket handshake, before
   * the upgrade. Daemons reset their reconnect backoff when a socket opens, so
   * the after-open close in registerMachine makes an old daemon retry at once;
   * a rejected handshake never opens, and the daemon's backoff keeps growing
   * (to 30 s on 1.0.18). Returns true when the caller must answer 409 and not
   * upgrade. registerMachine keeps its own check for a hold that appears
   * between the handshake and registration.
   */
  async refuseHeldDuplicateAtHandshake(machineId: string): Promise<boolean> {
    const hold = await this.heldDuplicateMachineConnection(machineId);
    if (!hold) return false;
    // Daemons since 1.0.47 (#9348) wait 5 minutes after the after-open 4003
    // refusal; a handshake rejection reaches them as a normal failure (<=30 s
    // backoff) until their release handles 409 the same way. Keep them on the
    // 4003 path; only daemons without that delay, or of unknown version, are
    // refused here.
    if (!daemonLacksDuplicateReconnectDelay(hold.closedDaemonVersion)) return false;
    machineDuplicateConnectionActionsTotal.inc({
      action: "refused_held_handshake",
      daemon_version: daemonVersionLabel(hold.closedDaemonVersion),
    });
    await this.replicaStateStore.touchMachineDuplicateHold?.(machineId, AgentOrchestrator.DUPLICATE_HOLD_TTL_SECONDS)
      .catch(() => {});
    return true;
  }

  /**
   * Task #374: whether a new connection for `machineId` must be refused because
   * the winner of an earlier duplicate decision is still alive. Fails open: any
   * read error, a missing record or a winner that stopped renewing lets the
   * connection through as before.
   */
  private async heldDuplicateMachineConnection(machineId: string): Promise<MachineDuplicateHold | null> {
    if (!this.duplicateConnectionEnforcement) return null;
    try {
      const hold = await this.replicaStateStore.getMachineDuplicateHold?.(machineId);
      if (!hold) return null;
      const lease = await this.replicaStateStore.getMachineReplicaLease?.(machineId);
      if (!lease || lease.replicaId !== hold.replicaId || lease.generation !== hold.generation) return null;
      if (lease.updatedAtMs === null) return null;
      if (this.clock.now() - lease.updatedAtMs > AgentOrchestrator.DUPLICATE_HOLD_WINNER_ALIVE_MS) return null;
      return hold;
    } catch {
      return null;
    }
  }

  /**
   * Push a reminder to the daemon that owns the agent. Best-effort: if the
   * machine is offline, the daemon will request a snapshot on reconnect.
   */
  async pushReminderUpsert(agentId: string, row: reminderService.ReminderRow): Promise<boolean> {
    const outgoing = {
      type: "reminder.upsert",
      agentId,
      reminder: reminderService.toReminderJob(row),
    } satisfies ServerToMachineMessage;
    const agent = await agentService.getAgent(agentId, false, {
      dbCallsite: "agent_orchestrator.reminder_push",
    });
    return this.sendAppTransport({
      spanName: "server.app_source.transport",
      traceAttrs: protocolSourceTraceAttrs({
        ownerAgentId: agentId,
        sourceId: row.id,
        version: row.version,
        messageType: outgoing.type,
      }),
      machineId: agent?.machineId ?? null,
      message: outgoing,
    });
  }

  /**
   * Push one typed app-config envelope to the agent's Computer (task #204).
   * Best-effort: an offline machine refills via app_config.snapshot.request on
   * reconnect, so a dropped push is recovered rather than silently lost.
   */
  async pushAppConfigUpsert(
    agentId: string,
    config: AppConfigWireSnapshot,
  ): Promise<boolean> {
    const agent = await agentService.getAgent(agentId, false, {
      dbCallsite: "agent_orchestrator.app_config_push",
    });
    return this.sendAppTransport({
      spanName: "server.app_config.transport",
      traceAttrs: appConfigTraceAttrs(config),
      machineId: agent?.machineId ?? null,
      message: {
        type: "app_config.upsert",
        agentId,
        config,
      },
    });
  }

  /**
   * Disarms the reminder on its owner's Computer. `canceled`: the reminder
   * itself was canceled (not its last fire, not a move to the Reminder App),
   * so the Computer also drops its un-acked local items of it (RFC 081 D21).
   */
  async pushReminderCancel(agentId: string, sourceId: string, version: number, opts: { canceled?: boolean } = {}): Promise<boolean> {
    const outgoing = {
      type: "reminder.cancel",
      agentId,
      reminderId: sourceId,
      version,
      ...(opts.canceled ? { canceled: true as const } : {}),
    } satisfies ServerToMachineMessage;
    const agent = await agentService.getAgent(agentId, false, {
      dbCallsite: "agent_orchestrator.reminder_push",
    });
    return this.sendAppTransport({
      spanName: "server.app_source.transport",
      traceAttrs: protocolSourceTraceAttrs({
        ownerAgentId: agentId,
        sourceId,
        version,
        messageType: outgoing.type,
      }),
      machineId: agent?.machineId ?? null,
      message: outgoing,
    });
  }

  private async deliverPendingRuntimeProfileMigration(
    machineId: string,
    agent: CachedAgentState,
    launchId?: string,
  ): Promise<void> {
    await agentRuntimeProfileService.clearRuntimeProfileMigrationForReset(agent.id, launchId || null);

    const notice = await agentRuntimeProfileService.getPendingRuntimeProfileNotice(agent.id);
    if (!notice?.pendingKey) return;
    const span = this.tracer.startSpan("server.runtime_profile.control.delivery", {
      parent: getCurrentTraceContext(),
      surface: "server",
      kind: "producer",
      attrs: {
        event_kind: "runtime_profile",
        agent_id: agent.id,
        machine_id: machineId,
        server_id: agent.serverId,
        launch_id: agent.expectedLaunchId || launchId,
        agent_id_present: true,
        machine_id_present: true,
        launch_id_present: Boolean(agent.expectedLaunchId || launchId),
        control_kind: "daemon_release_notice",
        key_present: true,
        migration_status: notice.migrationStatus,
        pending_kind: notice.pendingKind,
        delivery_reason: "pending",
      },
    });
    const sent = await this.sendToMachine(machineId, {
      type: "agent:runtime_profile:daemon_release_notice",
      agentId: agent.id,
      noticeKey: notice.pendingKey,
      message: agentRuntimeProfileService.renderRuntimeProfileMigrationMessage(notice),
      launchId: agent.expectedLaunchId || launchId,
      traceparent: formatTraceparent(span.context),
    });
    span.end(sent ? "ok" : "error", { attrs: { outcome: sent ? "sent" : "send_failed", reason: sent ? "notice_sent" : "send_failed" } });
  }

  private async maybePiggybackRuntimeProfileMigrationNudge(
    machineId: string,
    agent: CachedAgentState,
    launchId?: string,
    options: { source?: "heartbeat" | "user_path"; nudgeIntervalMs?: number } = {},
  ): Promise<"sent" | "send_failed" | "not_online" | "no_candidate"> {
    const activity = this.agentActivity.get(agent.id);
    if (activity && activity.activity !== "online") return "not_online";

    const pending = await agentRuntimeProfileService.getRuntimeProfileMigrationNudgeCandidate(
      agent.id,
      new Date(this.clock.now()),
      AgentOrchestrator.RUNTIME_PROFILE_MIGRATION_NUDGE_AFTER_MS,
      options.nudgeIntervalMs ?? AgentOrchestrator.RUNTIME_PROFILE_MIGRATION_NUDGE_INTERVAL_MS,
      AgentOrchestrator.RUNTIME_PROFILE_MIGRATION_MAX_NUDGES,
    );
    if (!pending?.pendingKey) return "no_candidate";

    const span = this.tracer.startSpan("server.runtime_profile.control.delivery", {
      parent: getCurrentTraceContext(),
      surface: "server",
      kind: "producer",
      attrs: {
        event_kind: "runtime_profile",
        agent_id: agent.id,
        machine_id: machineId,
        server_id: agent.serverId,
        launch_id: agent.expectedLaunchId || launchId,
        agent_id_present: true,
        machine_id_present: true,
        launch_id_present: Boolean(agent.expectedLaunchId || launchId),
        control_kind: "migration",
        key_present: true,
        migration_status: pending.migrationStatus,
        pending_kind: pending.pendingKind,
        delivery_reason: options.source === "heartbeat" ? "heartbeat_nudge" : "user_path_nudge",
      },
    });
    const sent = await this.sendToMachine(machineId, {
      type: "agent:runtime_profile:migration",
      agentId: agent.id,
      migrationKey: pending.pendingKey,
      message: agentRuntimeProfileService.renderRuntimeProfileMigrationNudgeMessage(pending),
      launchId: agent.expectedLaunchId || launchId,
      traceparent: formatTraceparent(span.context),
    });
    if (sent) {
      await agentRuntimeProfileService.markRuntimeProfileMigrationNudged(agent.id, pending.pendingKey);
      if (options.source === "heartbeat") {
        this.runtimeProfileHeartbeatNudgeSentAt.set(this.runtimeProfileHeartbeatNudgeKey(machineId, agent.id), this.clock.now());
      }
      span.end("ok", { attrs: { outcome: "sent", reason: "nudge_sent" } });
      return "sent";
    }
    span.end("error", { attrs: { outcome: "send_failed", reason: "send_failed" } });
    return "send_failed";
  }

  private async maybePiggybackRuntimeProfileMigrationNudgesForMachine(machineId: string): Promise<void> {
    const activeAgents = [...this.agentStateCache.values()]
      .filter((agent) => agent.machineId === machineId && agent.status === "active");
    const disabled = readBooleanEnv("SLOCK_DISABLE_MIGRATION_NUDGE_PIGGYBACK");
    const cooldownMs = readPositiveIntegerEnv(
      "SLOCK_MIGRATION_NUDGE_PIGGYBACK_COOLDOWN_MS",
      AgentOrchestrator.RUNTIME_PROFILE_HEARTBEAT_NUDGE_COOLDOWN_MS,
    );
    const now = this.clock.now();
    const counts = {
      active_agents_count: 0,
      disabled_count: 0,
      cooldown_count: 0,
      sent_count: 0,
      send_failed_count: 0,
      no_candidate_count: 0,
      not_online_count: 0,
    };

    await this.runInTraceSpan(
      "server.runtime_profile.heartbeat_nudge.scan",
      {
        attrs: {
          event_kind: "runtime_profile",
          machine_id: machineId,
          machine_id_present: true,
          disabled,
          cooldown_ms: cooldownMs,
        },
      },
      async () => {
        for (const agent of activeAgents) {
          counts.active_agents_count += 1;
          const action = planRuntimeProfileHeartbeatNudgeAction({
            disabled,
            lastSentAt: this.runtimeProfileHeartbeatNudgeSentAt.get(this.runtimeProfileHeartbeatNudgeKey(machineId, agent.id)) ?? null,
            now,
            cooldownMs,
          });
          if (action === "disabled") {
            counts.disabled_count += 1;
            continue;
          }
          if (action === "cooldown") {
            counts.cooldown_count += 1;
            continue;
          }
          const outcome = await this.maybePiggybackRuntimeProfileMigrationNudge(machineId, agent, undefined, {
            source: "heartbeat",
            nudgeIntervalMs: cooldownMs,
          });
          if (outcome === "sent") counts.sent_count += 1;
          if (outcome === "send_failed") counts.send_failed_count += 1;
          if (outcome === "no_candidate") counts.no_candidate_count += 1;
          if (outcome === "not_online") counts.not_online_count += 1;
        }
      },
      () => ({
        attrs: {
          ...counts,
          outcome: counts.sent_count > 0 ? "sent" : "skipped",
          reason: disabled ? "disabled" : activeAgents.length === 0 ? "no_active_agents" : "scan_completed",
        },
      }),
    );
  }

  private runtimeProfileHeartbeatNudgeKey(machineId: string, agentId: string): string {
    return `${machineId}:${agentId}`;
  }

  async completeRuntimeProfileMigrationFromAgent(
    agentId: string,
    migrationKey: string,
    launchId?: string | null,
  ): Promise<boolean> {
    const span = this.tracer.startSpan("server.runtime_profile.migration_done", {
      parent: getCurrentTraceContext(),
      surface: "server",
      kind: "server",
      attrs: {
        event_kind: "runtime_profile",
        agent_id: agentId,
        launch_id: launchId ?? undefined,
        agent_id_present: Boolean(agentId),
        key_present: Boolean(migrationKey),
        launch_id_present: Boolean(launchId),
        source: "tool",
      },
    });
    const agent = await this.getCachedAgent(agentId);
    if (!agent?.machineId) {
      span.end("ok", { attrs: { outcome: "missing-agent-or-machine", reason: "missing_agent_or_machine" } });
      return false;
    }
    if (!this.shouldAcceptLifecycleEvent(agent.machineId, agent, "agent:runtime_profile:migration_done", launchId || undefined)) {
      span.end("ok", { attrs: { machine_id: agent.machineId, server_id: agent.serverId, outcome: "stale-launch", reason: "stale_launch" } });
      return false;
    }
    const machineId = agent.machineId;
    let handled = false;
    try {
      handled = await this.runInActiveSpan(span, async () => {
        const marked = await agentRuntimeProfileService.markRuntimeProfileMigrationHandled(
          agentId,
          migrationKey,
          launchId || null,
        );
        if (marked) {
          await this.deliverPendingRuntimeProfileMigration(machineId, agent, launchId || undefined);
        }
        return marked;
      });
    } catch (err) {
      span.end("error", { attrs: { machine_id: agent.machineId, server_id: agent.serverId, outcome: "handle-failed", reason: "handle_failed", error_class: errorClassOf(err) } });
      throw err;
    }
    span.end("ok", { attrs: { machine_id: agent.machineId, server_id: agent.serverId, outcome: handled ? "handled" : "not-handled", reason: handled ? "migration_handled" : "no_matching_migration" } });
    return handled;
  }

  private async flushRuntimeProfileGatedInbox(
    machineId: string,
    agent: CachedAgentState,
  ): Promise<void> {
    const inbox = this.localInboxes.snapshot(agent.id);
    if (!inbox || inbox.messages.length === 0) return;
    const oldestMessageAgeMs = oldestInboxMessageAgeMs(inbox.messages, this.clock.now());
    const span = this.tracer.startSpan("server.runtime_profile.gated_inbox.flush", {
      parent: getCurrentTraceContext(),
      surface: "server",
      kind: "producer",
      attrs: {
        event_kind: "runtime_profile",
        agent_id: agent.id,
        machine_id: machineId,
        server_id: agent.serverId,
        agent_id_present: Boolean(agent.id),
        machine_id_present: true,
        inbox_count: inbox.messages.length,
        oldest_message_age_ms: oldestMessageAgeMs,
        oldest_message_age_bucket: durationMsBucket(oldestMessageAgeMs),
      },
    });
    let sentCount = 0;
    let sendFailedCount = 0;
    const buffered = [...inbox.messages];
    const flushed = buffered.some((message) => message.third_party_event)
      ? await this.guardBufferedSystemAppEvents(agent.id, buffered)
      : buffered;
    for (const message of flushed) {
      const deliveryId = crypto.randomUUID();
      const sent = await this.sendAgentDeliveryWithAckRetry(machineId, {
        type: "agent:deliver",
        agentId: agent.id,
        message,
        seq: message.seq ?? 0,
        deliveryId,
        traceparent: formatTraceparent(span.context),
      }, `runtime profile gated inbox flush failed for agent ${agent.id}`);
      if (sent) {
        sentCount += 1;
      } else {
        sendFailedCount += 1;
      }
    }
    span.end(sendFailedCount > 0 ? "error" : "ok", {
      attrs: {
        sent_count: sentCount,
        send_failed_count: sendFailedCount,
        outcome: sendFailedCount > 0 ? "partial_failure" : "sent",
        reason: sendFailedCount > 0 ? "send_failed" : "gated_inbox_flushed",
      },
    });
  }

  /** Messages that are expected to fail silently (fire-and-forget during deploy transitions) */
  private static SILENT_SEND_TYPES = new Set(["ping", "agent:stop"]);

  protected getRoutableLocalMachineIds(): Set<string> {
    const localIds = new Set<string>();
    for (const [machineId, conn] of this.machineConnections.entries()) {
      if (conn.ws.readyState === 1) {
        localIds.add(machineId);
      }
    }
    return localIds;
  }

  protected async routeMachineCommandCrossReplica(
    machineId: string,
    msg: ServerToMachineMessage,
    localMachineIds: Set<string>,
  ): Promise<boolean | MachineCommandRouteResult> {
    return routeMachineCommandWithResult(machineId, msg, localMachineIds);
  }

  /** Re-emit a cross-replica external wake signal on the local emitter. */
  handleRoutedExternalWakeSignal(agentId: string): void {
    this.emit("external-inbox-delivered", agentId);
  }

  protected async publishExternalWakeSignalCrossReplica(agentId: string): Promise<void> {
    return publishExternalWakeSignal(agentId);
  }

  protected async routeInboxDeliveryCrossReplica(
    agentId: string,
    machineId: string,
    message: AgentMessage,
    localMachineIds: Set<string>,
    deliveryOptions: RoutedInboxDeliveryOptions = {},
  ): Promise<boolean> {
    return routeInboxDelivery(agentId, machineId, message, localMachineIds, deliveryOptions);
  }

  protected async routeInboxDeliveryWithReceiptCrossReplica(
    agentId: string,
    machineId: string,
    message: AgentMessage,
    localMachineIds: Set<string>,
    deliveryOptions: RoutedInboxDeliveryOptions,
  ): Promise<RoutedInboxDeliveryReceiptResult> {
    return routeInboxDeliveryWithReceipt(agentId, machineId, message, localMachineIds, deliveryOptions);
  }

  protected async sendToMachine(
    machineId: string,
    msg: ServerToMachineMessage,
    options: { onRouteResult?: (result: MachineCommandRouteResult) => void } = {},
  ): Promise<boolean> {
    const dispatch = async (): Promise<boolean> => {
      const conn = this.machineConnections.get(machineId);
      const hasReadyLocalConnection = Boolean(conn && conn.ws.readyState === 1);
      const action = planSendToMachineAction({
        hasReadyLocalConnection,
        canReroute: this.replicaStateStore.isAvailable(),
      });
      return this.applySendToMachineAction({
        action,
        machineId,
        msg,
        sendLocally: () => {
          if (!conn) return false;
          conn.ws.send(JSON.stringify(msg));
          return true;
        },
        // A provider connect's API key crosses Redis sealed (runtimeAuthReplicaSeal.ts).
        reroute: () => this.routeMachineCommandCrossReplica(
          machineId,
          sealForReplicaHop(machineId, msg),
          this.getRoutableLocalMachineIds(),
        ),
        onRouteResult: options.onRouteResult,
      });
    };

    if (!failpoints.enabled) {
      return dispatch();
    }

    const result = await failpoints.hit<boolean>(
      "server.agentOrchestrator.sendToMachine.dispatch",
      { machineId, msgType: msg.type },
      dispatch,
    );
    return result ?? false;
  }

  protected async applySendToMachineAction(context: SendToMachineApplyContext): Promise<boolean> {
    if (context.action === "send-locally") {
      return context.sendLocally();
    }

    if (context.action === "reroute-then-warn") {
      try {
        const routeResult = await this.routeMachineCommand(context);
        context.onRouteResult?.(routeResult);
        if (routeResult.routed) return true;
      } catch (err: any) {
        console.error(`[ReplicaRouter] Failed to route to machine ${context.machineId}:`, err.message);
      }
    }

    if (!AgentOrchestrator.SILENT_SEND_TYPES.has(context.msg.type)) {
      console.warn(`[Machine ${context.machineId}] sendToMachine: no connection found (msg: ${context.msg.type})`);
    }
    return false;
  }

  private async routeMachineCommand(context: SendToMachineApplyContext): Promise<MachineCommandRouteResult> {
    const { machineId, msg } = context;
    const identityAttrs = {
      machine_id: machineId,
      ...("agentId" in msg && typeof msg.agentId === "string" ? { agent_id: msg.agentId } : {}),
    };
    return this.runInTraceSpan(
      "server.machine.command.route",
      {
        attrs: {
          ...identityAttrs,
          source: "sendToMachine",
          action: "route_machine_command",
          message_type: msg.type,
        },
      },
      async () => {
        const routeResult = normalizeMachineCommandRouteResult(await context.reroute());
        machineCommandRouteTotal.inc({
          outcome: routeResult.routed ? "routed" : "not_routed",
          reason: routeResult.reason,
          message_type: msg.type,
        });
        this.recordEvent("machine.command.route", {
          event_kind: "machine_command_route",
          outcome: routeResult.routed ? "routed" : "not_routed",
          reason: routeResult.reason,
          ...identityAttrs,
          ...projectMachineCommandRouteTraceAttrs(routeResult),
        });
        return routeResult;
      },
      (routeResult) => ({
        attrs: {
          outcome: routeResult.routed ? "routed" : "not_routed",
          reason: routeResult.reason,
          ...identityAttrs,
          ...projectMachineCommandRouteTraceAttrs(routeResult),
        },
      }),
    );
  }

  protected async sendRequiredToMachine(
    machineId: string,
    msg: ServerToMachineMessage,
    offlineMessage = "Machine WebSocket not ready",
  ): Promise<"local" | "cross_replica"> {
    let routeResult: MachineCommandRouteResult | undefined;
    const sent = await this.sendToMachine(machineId, msg, {
      onRouteResult: (result) => {
        routeResult = result;
      },
    });
    if (!sent) {
      throw new RouteFailureError("daemon_offline", offlineMessage);
    }
    return routeResult?.routed ? "cross_replica" : "local";
  }

  protected sendBestEffortToMachine(machineId: string, msg: ServerToMachineMessage, errorContext: string): void {
    void this.sendToMachine(machineId, msg).catch((err) => {
      console.warn(`[Machine ${machineId}] ${errorContext}:`, err);
    });
  }

  private pendingStartQueueDepth(machineId: string): number {
    let depth = 0;
    for (const pending of this.pendingAgentStartAcks.values()) {
      if (pending.machineId === machineId) depth += 1;
    }
    return depth;
  }

  private startDispatchTraceAttrs(pending: PendingAgentStartAck): Record<string, unknown> {
    return {
      agent_id: pending.msg.agentId,
      machine_id: pending.machineId,
      launch_id: pending.msg.launchId,
      start_dispatch_id: pending.msg.startDispatchId,
      agent_id_present: Boolean(pending.msg.agentId),
      machine_id_present: Boolean(pending.machineId),
      launch_id_present: Boolean(pending.msg.launchId),
      queue_age_ms: Math.max(0, this.clock.now() - pending.createdAt),
      queue_depth: this.pendingStartQueueDepth(pending.machineId),
      attempts: pending.attempts,
      last_attempt_at_ms: pending.lastAttemptAt,
      next_retry_at_ms: pending.nextRetryAt,
      parked: pending.parked,
    };
  }

  private rememberTerminalStartDispatch(
    startDispatchId: string,
    reason: AgentStartDispatchTerminalReason,
  ): void {
    this.terminalAgentStartDispatches.delete(startDispatchId);
    this.terminalAgentStartDispatches.set(startDispatchId, reason);
    while (
      this.terminalAgentStartDispatches.size
      > AgentOrchestrator.AGENT_START_TERMINAL_CACHE_SIZE
    ) {
      const oldest = this.terminalAgentStartDispatches.keys().next().value;
      if (typeof oldest !== "string") break;
      this.terminalAgentStartDispatches.delete(oldest);
    }
  }

  private terminalizePendingAgentStart(
    startDispatchId: string,
    reason: AgentStartDispatchTerminalReason,
    outcome: "acked" | "terminal" = reason === "acked" ? "acked" : "terminal",
    extraAttrs: Record<string, unknown> = {},
  ): PendingAgentStartAck | null {
    const pending = this.pendingAgentStartAcks.get(startDispatchId);
    if (!pending) return null;
    if (pending.timer) this.clock.clearTimeout(pending.timer);
    pending.timer = null;
    pending.nextRetryAt = null;
    const terminalTraceAttrs = this.startDispatchTraceAttrs(pending);
    this.pendingAgentStartAcks.delete(startDispatchId);
    this.rememberTerminalStartDispatch(startDispatchId, reason);
    this.recordEvent("server.agent.start_dispatch.terminal", {
      ...terminalTraceAttrs,
      outcome,
      terminal_reason: reason,
      ...extraAttrs,
    });
    return pending;
  }

  private clearPendingAgentStartsForAgent(
    agentId: string,
    reason: Extract<AgentStartDispatchTerminalReason, "stopped" | "superseded">,
  ): number {
    const dispatchIds = [...this.pendingAgentStartAcks.values()]
      .filter((pending) => pending.msg.agentId === agentId)
      .map((pending) => pending.msg.startDispatchId);
    for (const startDispatchId of dispatchIds) {
      this.terminalizePendingAgentStart(startDispatchId, reason);
    }
    return dispatchIds.length;
  }

  private acknowledgePendingAgentStartFromLifecycle(
    agentId: string,
    launchId: string | undefined,
    source: "agent_status" | "agent_session",
  ): void {
    for (const pending of [...this.pendingAgentStartAcks.values()]) {
      if (pending.msg.agentId !== agentId) continue;
      if (pending.msg.launchId && launchId && pending.msg.launchId !== launchId) {
        continue;
      }
      this.terminalizePendingAgentStart(
        pending.msg.startDispatchId,
        "acked",
        "acked",
        { ack_source: source },
      );
    }
  }

  /**
   * Agents the daemon reports running that the database does not place on
   * this machine: deleted, or moved to another machine (e.g. a migration that
   * flipped while this daemon was away). Reads the primary, not a cache.
   *
   * A deleted agent is stopped: nothing can own it any more, and left running
   * it is reported again on every reconnect. Production (v1.21.1, 34 h) showed
   * only deleted agents, all long gone and idle (#infra:4df7de2a). A moved
   * agent stays observe-only until production shows what those look like (an
   * agent mid-migration must not be stopped by the wrong side).
   */
  private async reconcileForeignRunningAgents(
    machineId: string,
    agentIds: string[],
  ): Promise<{ foreign: number; stopped: number }> {
    if (agentIds.length === 0) return { foreign: 0, stopped: 0 };
    const placements = new Map((await this.loadAgentPlacements(agentIds)).map((row) => [row.id, row]));
    let foreign = 0;
    let stopped = 0;
    for (const agentId of agentIds) {
      const placement = placements.get(agentId);
      if (placement && !placement.deletedAt && placement.machineId === machineId) continue;
      foreign += 1;
      const reason = !placement || placement.deletedAt ? "deleted" : "moved";
      let enforcement: "stopped" | "stop_not_sent" | "observe_only" = "observe_only";
      if (reason === "deleted") {
        enforcement = await this.sendToMachine(machineId, { type: "agent:stop", agentId }) ? "stopped" : "stop_not_sent";
        if (enforcement === "stopped") stopped += 1;
      }
      this.recordEvent("machine.ready.reconcile.foreign_running", {
        agent_id: agentId,
        machine_id: machineId,
        reason,
        current_machine_id_present: Boolean(placement?.machineId),
        enforcement,
      });
    }
    return { foreign, stopped };
  }

  protected async loadAgentPlacements(agentIds: string[]) {
    return agentService.getAgentPlacements(agentIds);
  }

  /** Move the agent's read position over messages its daemon reported the model was shown. */
  protected settleUnowedReadBacklog(agentId: string, targets: Parameters<typeof settleUnowedReadBacklog>[2]) {
    return settleUnowedReadBacklog(getDb(), agentId, targets);
  }

  protected applyAgentModelSeen(input: Parameters<typeof applyAgentModelSeenToReadPosition>[0]) {
    return applyAgentModelSeenToReadPosition(input);
  }

  /** Whether this replica sent `agentId` a start, on any machine, that is not acknowledged yet. */
  private hasPendingAgentStartForAgent(agentId: string): boolean {
    for (const pending of this.pendingAgentStartAcks.values()) {
      if (pending.msg.agentId === agentId) return true;
    }
    return false;
  }

  /** Whether this replica sent `agentId` a start on `machineId` that is not acknowledged yet. */
  private hasPendingAgentStart(agentId: string, machineId: string): boolean {
    for (const pending of this.pendingAgentStartAcks.values()) {
      if (pending.msg.agentId === agentId && pending.machineId === machineId) return true;
    }
    return false;
  }

  private trackPendingAgentStart(
    machineId: string,
    msg: AgentStartMessage & { startDispatchId: string },
    options: { scheduleTimeout?: boolean } = {},
  ): void {
    const existing = this.pendingAgentStartAcks.get(msg.startDispatchId);
    if (existing) {
      existing.machineId = machineId;
      existing.msg = msg;
      return;
    }
    this.clearPendingAgentStartsForAgent(msg.agentId, "superseded");
    const now = this.clock.now();
    const pending: PendingAgentStartAck = {
      machineId,
      msg,
      timer: null,
      attempts: 0,
      parked: false,
      createdAt: now,
      lastAttemptAt: 0,
      nextRetryAt: null,
    };
    this.pendingAgentStartAcks.set(msg.startDispatchId, pending);
    this.recordEvent("server.agent.start_dispatch.created", {
      ...this.startDispatchTraceAttrs(pending),
      outcome: "created",
    });
    if (options.scheduleTimeout ?? true) {
      this.scheduleAgentStartAckTimeout(pending);
    }
  }

  private scheduleAgentStartAckTimeout(pending: PendingAgentStartAck): void {
    if (pending.timer) this.clock.clearTimeout(pending.timer);
    pending.nextRetryAt = this.clock.now() + AgentOrchestrator.AGENT_START_ACK_TIMEOUT_MS;
    pending.timer = this.scheduleOnClock(() => {
      void this.retryPendingAgentStart(pending.msg.startDispatchId, "ack_timeout");
    }, AgentOrchestrator.AGENT_START_ACK_TIMEOUT_MS);
    const timerWithUnref = pending.timer as { unref?: () => void } | null;
    timerWithUnref?.unref?.();
  }

  private startDispatchAttemptSpan(machineId: string, msg: AgentStartMessage & { startDispatchId: string }): ActiveSpan {
    return this.tracer.startSpan("server.agent.start_dispatch.attempted", {
      parent: getCurrentTraceContext() ?? parseTraceparent(msg.traceparent),
      surface: "server",
      kind: "producer",
      attrs: {
        agent_id: msg.agentId,
        machine_id: machineId,
        launch_id: msg.launchId,
        start_dispatch_id: msg.startDispatchId,
      },
    });
  }

  private endStartDispatchAttemptSpan(span: ActiveSpan, pending: PendingAgentStartAck | undefined, sent: boolean): void {
    span.end(sent ? "ok" : "error", {
      attrs: {
        ...(pending ? this.startDispatchTraceAttrs(pending) : {}),
        outcome: sent ? "sent" : "send_failed",
      },
    });
  }

  private retryPendingAgentStartsForMachine(
    machineId: string,
    reason: "register" | "ready_reconcile",
  ): void {
    for (const pending of [...this.pendingAgentStartAcks.values()]) {
      if (pending.machineId === machineId) {
        void this.retryPendingAgentStart(pending.msg.startDispatchId, reason);
      }
    }
  }

  private async retryPendingAgentStart(
    startDispatchId: string,
    reason: "ack_timeout" | "register" | "ready_reconcile",
  ): Promise<void> {
    const pending = this.pendingAgentStartAcks.get(startDispatchId);
    if (!pending) return;
    let retryOutcome: TraceAttributes = {};
    await this.runInTraceSpan(
      "server.agent.start_dispatch.retry",
      {
        kind: "producer",
        parent: parseTraceparent(pending.msg.traceparent),
        attrs: {
          agent_id: pending.msg.agentId,
          machine_id: pending.machineId,
          launch_id: pending.msg.launchId,
          start_dispatch_id: startDispatchId,
          retry_reason: reason,
        },
      },
      async () => {
        retryOutcome = await this.retryPendingAgentStartInSpan(pending, startDispatchId);
      },
      () => ({ attrs: retryOutcome }),
    );
  }

  /**
   * Runs one retry of a pending start and returns the attributes that
   * describe what happened. The caller puts them on the retry span.
   */
  private async retryPendingAgentStartInSpan(
    pending: PendingAgentStartAck,
    startDispatchId: string,
  ): Promise<TraceAttributes> {
    const terminal = (terminalReason: AgentStartDispatchTerminalReason): TraceAttributes => ({
      outcome: "terminal",
      terminal_reason: terminalReason,
    });
    const agent = await this.getAuthoritativeAgentForDelivery(pending.msg.agentId);
    if (!agent) {
      this.terminalizePendingAgentStart(startDispatchId, "superseded");
      return terminal("superseded");
    }
    if (agent.machineId !== pending.machineId) {
      this.terminalizePendingAgentStart(startDispatchId, "machine_reassigned", "terminal", {
        current_machine_id_present: agent.machineId != null,
      });
      return terminal("machine_reassigned");
    }
    if (agent.status === "stopped") {
      this.terminalizePendingAgentStart(startDispatchId, "stopped");
      return terminal("stopped");
    }
    const cached = this.agentStateCache.get(pending.msg.agentId);
    if (
      pending.msg.launchId
      && cached?.expectedLaunchId
      && cached.expectedLaunchId !== pending.msg.launchId
    ) {
      this.terminalizePendingAgentStart(startDispatchId, "superseded");
      return terminal("superseded");
    }
    if (pending.attempts >= AgentOrchestrator.AGENT_START_ACK_MAX_ATTEMPTS) {
      const exhausted = this.terminalizePendingAgentStart(
        startDispatchId,
        "retry_exhausted",
      );
      if (exhausted) {
        this.updateCache(exhausted.msg.agentId, {
          status: "inactive",
          runtimeState: "not_running",
        });
        await this.persistAgentStatus(exhausted.msg.agentId, "inactive");
        this.broadcastActivity(
          exhausted.msg.agentId,
          "offline",
          "Start delivery could not reach the Computer",
          "runtime_unavailable",
          [],
          undefined,
          { launchId: exhausted.msg.launchId },
        );
      }
      return terminal("retry_exhausted");
    }

    const machineStatus = await this.getMachineStatus(pending.machineId);
    if (machineStatus === "offline") {
      if (pending.timer) this.clock.clearTimeout(pending.timer);
      pending.timer = null;
      pending.parked = true;
      // A reconnect can register on another replica, so this replica may not
      // receive the register/ready callbacks that normally unpark the start.
      // Keep probing ownership without consuming a delivery attempt.
      this.scheduleAgentStartAckTimeout(pending);
      return {
        ...this.startDispatchTraceAttrs(pending),
        outcome: "parked",
        terminal_reason: null,
      };
    }

    const localAtRetry = this.hasMachineLocally(pending.machineId);
    const sent = await this.sendToMachine(pending.machineId, pending.msg);
    if (sent) {
      pending.attempts += 1;
      pending.lastAttemptAt = this.clock.now();
      pending.parked = false;
    }
    if (sent && !localAtRetry) {
      if (pending.timer) this.clock.clearTimeout(pending.timer);
      pending.timer = null;
      pending.nextRetryAt = null;
      this.pendingAgentStartAcks.delete(startDispatchId);
      return {
        ...this.startDispatchTraceAttrs(pending),
        outcome: "routed",
        terminal_reason: null,
      };
    }
    this.scheduleAgentStartAckTimeout(pending);
    return {
      ...this.startDispatchTraceAttrs(pending),
      outcome: sent ? "replayed" : "scheduled",
      terminal_reason: null,
    };
  }

  private async sendAgentStartWithAckRetry(
    machineId: string,
    msg: AgentStartMessage & { startDispatchId: string },
  ): Promise<boolean> {
    const span = this.startDispatchAttemptSpan(machineId, msg);
    try {
      return await this.runInActiveSpan(span, async () => {
        const localAtSend = this.hasMachineLocally(machineId);
        if (localAtSend) {
          this.trackPendingAgentStart(machineId, msg);
        }
        const sent = await this.sendToMachine(machineId, msg);
        let pending = this.pendingAgentStartAcks.get(msg.startDispatchId);
        if (sent && pending) {
          pending.attempts += 1;
          pending.lastAttemptAt = this.clock.now();
        }
        if (!sent && !pending) {
          this.trackPendingAgentStart(machineId, msg);
          pending = this.pendingAgentStartAcks.get(msg.startDispatchId);
        }
        this.endStartDispatchAttemptSpan(span, pending, sent);
        return sent;
      });
    } catch (error) {
      span.end("error", { attrs: { outcome: "send_failed", error_class: errorClassOf(error) } });
      throw error;
    }
  }

  private sendLocalAgentStartWithAckRetry(
    machineId: string,
    msg: AgentStartMessage & { startDispatchId: string },
  ): boolean {
    const span = this.startDispatchAttemptSpan(machineId, msg);
    try {
      return this.runInActiveSpan(span, () => {
        this.trackPendingAgentStart(machineId, msg);
        const sent = this.sendToLocalMachine(machineId, msg);
        const pending = this.pendingAgentStartAcks.get(msg.startDispatchId);
        if (sent && pending) {
          pending.attempts += 1;
          pending.lastAttemptAt = this.clock.now();
        }
        this.endStartDispatchAttemptSpan(span, pending, sent);
        return sent;
      });
    } catch (error) {
      span.end("error", { attrs: { outcome: "send_failed", error_class: errorClassOf(error) } });
      throw error;
    }
  }

  private agentDeliveryAckKey(msg: Pick<Extract<ServerToMachineMessage, { type: "agent:deliver" }>, "agentId" | "seq" | "deliveryId">): string {
    return msg.deliveryId ? `delivery:${msg.deliveryId}` : `seq:${msg.agentId}:${msg.seq}`;
  }

  /**
   * An ack-retry cycle is in flight only while it can still exhaust. A parked cycle (machine went
   * offline) ignores ack timeouts and is never unparked for tracked mentions, so treating it as in
   * flight would let every recovery trigger re-send without spending budget, forever.
   */
  private hasLiveAgentDeliveryAckCycle(msg: Pick<Extract<ServerToMachineMessage, { type: "agent:deliver" }>, "agentId" | "seq" | "deliveryId">): boolean {
    const pending = this.pendingAgentDeliveryAcks.get(this.agentDeliveryAckKey(msg));
    return Boolean(pending && !pending.parked);
  }

  private findAgentDeliveryAckKey(agentId: string, seq: number, deliveryId?: string): string | null {
    if (deliveryId) {
      const deliveryKey = `delivery:${deliveryId}`;
      if (this.pendingAgentDeliveryAcks.has(deliveryKey)) return deliveryKey;
    }
    const seqKey = `seq:${agentId}:${seq}`;
    if (this.pendingAgentDeliveryAcks.has(seqKey)) return seqKey;
    for (const [key, pending] of this.pendingAgentDeliveryAcks.entries()) {
      if (pending.msg.agentId === agentId && pending.msg.seq === seq) return key;
    }
    return null;
  }

  private trackPendingAgentDeliveryAck(
    machineId: string,
    msg: Extract<ServerToMachineMessage, { type: "agent:deliver" }>,
    options: { scheduleTimeout?: boolean } = {},
  ): void {
    const scheduleTimeout = options.scheduleTimeout ?? true;
    const key = this.agentDeliveryAckKey(msg);
    const existing = this.pendingAgentDeliveryAcks.get(key);
    if (existing) {
      existing.machineId = machineId;
      existing.msg = msg;
      existing.lastAttemptAt = this.clock.now();
      // A parked record stays parked on a re-send (task #285: a parked cycle is
      // not in flight, so mention recovery keeps spending its budget). Keep its
      // status probe rather than an ack timeout it would ignore (task #432).
      if (scheduleTimeout && !existing.parked && existing.arrivedAt === undefined) {
        this.scheduleAgentDeliveryAckTimeout(key, existing);
      }
      return;
    }

    const now = this.clock.now();
    const pending: PendingAgentDeliveryAck = {
      machineId,
      msg,
      timer: null,
      attempts: 1,
      parked: false,
      firstAttemptAt: now,
      lastAttemptAt: now,
      ackWaitStartedAt: now,
      ackWaits: 0,
      onlineAtFirstAttempt: this.hasMachineLocally(machineId),
      daemonVersion: daemonVersionLabel(this.machineConnections.get(machineId)?.daemonVersion),
    };
    this.pendingAgentDeliveryAcks.set(key, pending);
    // A re-send after a give-up is a new record; its ack is on time, not late.
    this.gaveUpAgentDeliveries.delete(key);
    agentDeliveryTrackedTotal.inc(agentDeliverySloLabels(pending));
    if (scheduleTimeout) {
      this.scheduleAgentDeliveryAckTimeout(key, pending);
    }
  }

  private scheduleAgentDeliveryAckTimeout(key: string, pending: PendingAgentDeliveryAck): void {
    if (pending.timer) {
      this.clock.clearTimeout(pending.timer);
    }
    const backoff = AgentOrchestrator.AGENT_DELIVERY_ACK_BACKOFF_MS;
    let delayMs: number = backoff[Math.min(pending.ackWaits, backoff.length - 1)];
    pending.ackWaits += 1;
    // Land exactly on a give-up bound rather than one backoff step past it.
    const ageMs = this.clock.now() - pending.ackWaitStartedAt;
    for (const boundMs of [
      AgentOrchestrator.AGENT_DELIVERY_GIVE_UP_AFTER_MS,
      AgentOrchestrator.AGENT_DELIVERY_DEFERRED_GIVE_UP_AFTER_MS,
    ]) {
      if (ageMs < boundMs) {
        delayMs = Math.min(delayMs, boundMs - ageMs);
        break;
      }
    }
    pending.timer = this.scheduleOnClock(() => {
      void this.retryPendingAgentDelivery(key, "ack_timeout");
    }, delayMs);
    const timerWithUnref = pending.timer as { unref?: () => void } | null;
    timerWithUnref?.unref?.();
  }

  private clearPendingAgentDeliveryAck(
    msg: Pick<Extract<MachineToServerMessage, { type: "agent:deliver:ack" }>, "agentId" | "seq" | "deliveryId">,
    outcome: "acked" | "terminal",
  ): boolean {
    const key = this.findAgentDeliveryAckKey(msg.agentId, msg.seq, msg.deliveryId);
    if (!key) {
      if (outcome === "acked") this.recordAgentDeliveryAckedAfterGaveUp(msg);
      return false;
    }
    const pending = this.pendingAgentDeliveryAcks.get(key);
    if (pending?.timer) this.clock.clearTimeout(pending.timer);
    if (pending) {
      // A mention that already arrived (daemon_pending) was observed then.
      if (outcome === "acked" && pending.arrivedAt === undefined) {
        agentDeliveryAckSeconds.observe(
          agentDeliverySloLabels(pending),
          (this.clock.now() - pending.firstAttemptAt) / 1000,
        );
      }
      this.recordAgentDeliveryOutcome(pending, outcome);
    }
    return this.pendingAgentDeliveryAcks.delete(key);
  }

  private recordAgentDeliveryOutcome(pending: PendingAgentDeliveryAck, outcome: AgentDeliveryOutcome): void {
    agentDeliveryOutcomesTotal.inc({
      outcome,
      ...agentDeliverySloLabels(pending),
      conn_age: outcome === "gave_up" || outcome === "dropped" ? this.machineConnectionAgeBucket(pending.machineId) : "n/a",
    });
  }

  /**
   * Coarse age of this replica's connection to the machine, for failure
   * outcomes only: it separates state that builds up on a long-lived
   * connection from state that builds up on the replica (task #432).
   */
  private machineConnectionAgeBucket(machineId: string): "none" | "unknown" | "<1h" | "1-6h" | ">6h" {
    const conn = this.machineConnections.get(machineId);
    if (!conn) return "none";
    if (conn.connectedAt === undefined) return "unknown";
    const ageMs = this.clock.now() - conn.connectedAt;
    if (ageMs < 3_600_000) return "<1h";
    if (ageMs < 6 * 3_600_000) return "1-6h";
    return ">6h";
  }

  private clearPendingAgentDeliveryAcksForAgent(agentId: string): number {
    let cleared = 0;
    for (const [key, pending] of [...this.pendingAgentDeliveryAcks.entries()]) {
      if (pending.msg.agentId !== agentId) continue;
      if (pending.timer) this.clock.clearTimeout(pending.timer);
      this.recordAgentDeliveryOutcome(pending, "agent_stopped");
      this.pendingAgentDeliveryAcks.delete(key);
      cleared += 1;
    }
    return cleared;
  }

  private retryPendingAgentDeliveriesForMachine(machineId: string, reason: "ready_reconcile" | "register"): void {
    for (const [key, pending] of [...this.pendingAgentDeliveryAcks.entries()]) {
      // Tracked mention obligations are rebuilt from the durable occurrence
      // state on ready. The task #166 map remains only their timer/dispatch
      // executor; it must not become a second recovery authority.
      if (pending.msg.mentionDelivery) continue;
      if (pending.machineId === machineId) {
        void this.retryPendingAgentDelivery(key, reason);
      }
    }
  }

  private async recoverDurableMentionDeliveriesForMachine(machineId: string): Promise<void> {
    const rows = await mentionDeliveryOccurrenceService.listRecoverableMentionDeliveries(machineId);
    const agentIds = new Set(rows.map((row) => row.agentId));
    for (const agentId of agentIds) {
      const agent = await this.getCachedAgent(agentId);
      if (
        !agent
        || agent.machineId !== machineId
        || !agent.expectedLaunchId
        || !agent.sessionId
      ) {
        continue;
      }
      await this.recoverDurableMentionDeliveriesForAgent(agentId, {
        machineId,
        launchId: agent.expectedLaunchId,
        sessionId: agent.sessionId,
      });
    }
  }

  private async recoverDurableMentionDeliveriesForAgent(
    agentId: string,
    runtimeIdentity: Pick<MentionDeliveryIdentitySnapshot, "machineId" | "launchId" | "sessionId">,
  ): Promise<void> {
    const rows = await mentionDeliveryOccurrenceService.listRecoverableMentionDeliveriesForAgent(
      runtimeIdentity.machineId,
      agentId,
    );
    for (const row of rows) {
      if (!row.deliveryPayload) continue;
      const identity: MentionDeliveryIdentitySnapshot = {
        occurrenceId: row.occurrenceId,
        messageId: row.messageId,
        ...runtimeIdentity,
      };
      let current = row;
      if (row.serverDecidedAt) {
        if (
          row.machineIdSnapshot !== identity.machineId
          || row.launchIdSnapshot !== identity.launchId
          || row.sessionIdSnapshot !== identity.sessionId
        ) {
          await mentionDeliveryOccurrenceService.recordMentionDeliveryIdentityDrift(row.occurrenceId, "recovery");
          continue;
        }
      } else {
        const decided = await mentionDeliveryOccurrenceService.recordMentionDeliveryServerDecision({
          occurrenceId: row.occurrenceId,
          payload: row.deliveryPayload,
          identity,
        });
        if (!decided) continue;
        current = decided;
      }
      if (current.state === "daemon_drained") continue;
      // task #285: every agent:session (each session_init and turn_end) and machine-ready
      // re-arms this listing. A round is one ack-retry cycle, so a trigger while this
      // occurrence's cycle is still in flight re-sends without spending budget; only starting
      // a new cycle does. Past the budget the occurrence is written terminal and leaves the
      // listing, which is what stops the loop for daemons that never terminalise it.
      const cycleInFlight = this.hasLiveAgentDeliveryAckCycle({
        agentId,
        seq: row.deliveryPayload.seq ?? 0,
        deliveryId: row.occurrenceId,
      });
      if (!cycleInFlight) {
        const recovery = await mentionDeliveryOccurrenceService.claimMentionDeliveryRecovery({
          occurrenceId: current.occurrenceId,
          expectedVersion: current.version,
        });
        if (recovery.status !== "claimed") continue;
      }
      await this.enqueueToLocalInboxIfStillActive(agentId, identity.machineId, row.deliveryPayload);
      await this.sendAgentDeliveryWithAckRetry(identity.machineId, {
        type: "agent:deliver",
        agentId,
        message: row.deliveryPayload,
        seq: row.deliveryPayload.seq ?? 0,
        deliveryId: row.occurrenceId,
        mentionDelivery: identity,
      }, `durable mention recovery failed for agent ${agentId}`);
    }
  }

  private rememberGaveUpAgentDelivery(key: string, pending: PendingAgentDeliveryAck): void {
    const now = this.clock.now();
    for (const [oldKey, entry] of this.gaveUpAgentDeliveries) {
      const expired = now - entry.givenUpAt >= AgentOrchestrator.AGENT_DELIVERY_GAVE_UP_TOMBSTONE_MS;
      if (!expired && this.gaveUpAgentDeliveries.size < AgentOrchestrator.AGENT_DELIVERY_GAVE_UP_TOMBSTONE_MAX) break;
      this.gaveUpAgentDeliveries.delete(oldKey);
    }
    this.gaveUpAgentDeliveries.delete(key);
    this.gaveUpAgentDeliveries.set(key, {
      givenUpAt: now,
      machineId: pending.machineId,
      agentId: pending.msg.agentId,
      seq: pending.msg.seq,
      deliveryId: pending.msg.deliveryId ?? null,
      labels: agentDeliverySloLabels(pending),
    });
  }

  /**
   * An ack for a delivery this replica already gave up on: the daemon did get
   * it. Counted (and logged next to agent_delivery.gave_up, joinable on
   * delivery_correlation_id) so
   * real non-delivery is gave_up minus acked_after_gave_up. Delivery itself is
   * unchanged: the record is gone and nothing is re-sent.
   */
  private recordAgentDeliveryAckedAfterGaveUp(
    msg: Pick<Extract<MachineToServerMessage, { type: "agent:deliver:ack" }>, "agentId" | "seq" | "deliveryId">,
  ): void {
    const keys = msg.deliveryId ? [`delivery:${msg.deliveryId}`] : [];
    keys.push(`seq:${msg.agentId}:${msg.seq}`);
    const key = keys.find((candidate) => this.gaveUpAgentDeliveries.has(candidate));
    if (!key) return;
    const entry = this.gaveUpAgentDeliveries.get(key)!;
    this.gaveUpAgentDeliveries.delete(key);
    const sinceGaveUpMs = this.clock.now() - entry.givenUpAt;
    if (sinceGaveUpMs >= AgentOrchestrator.AGENT_DELIVERY_GAVE_UP_TOMBSTONE_MS) return;
    agentDeliveryOutcomesTotal.inc({ outcome: "acked_after_gave_up", ...entry.labels, conn_age: "n/a" });
    console.log(JSON.stringify({
      event: "agent_delivery.acked_after_gave_up",
      machine_id: entry.machineId,
      agent_id: entry.agentId,
      delivery_correlation_id: entry.deliveryId,
      seq: entry.seq,
      delivery_kind: entry.labels.delivery_kind,
      daemon_version: entry.labels.daemon_version,
      since_gave_up_ms: sinceGaveUpMs,
    }));
  }

  private async logAgentDeliveryGaveUp(pending: PendingAgentDeliveryAck): Promise<void> {
    const conn = this.machineConnections.get(pending.machineId);
    let daemonVersion = conn?.daemonVersion ?? null;
    let daemonVersionSource: "connection" | "machine_record" | "none" = daemonVersion ? "connection" : "none";
    if (!daemonVersion) {
      // The machine is not connected here (or has not sent ready): fall back
      // to the version it last reported, so a non-local give-up still names it.
      daemonVersion = await this.loadMachineDaemonVersion(pending.machineId).catch(() => null);
      if (daemonVersion) daemonVersionSource = "machine_record";
    }
    console.log(JSON.stringify({
      event: "agent_delivery.gave_up",
      machine_id: pending.machineId,
      agent_id: pending.msg.agentId,
      delivery_correlation_id: pending.msg.deliveryId ?? null,
      seq: pending.msg.seq,
      local_socket_present: this.hasMachineLocally(pending.machineId),
      daemon_version: daemonVersion,
      daemon_version_source: daemonVersionSource,
      delivery_kind: pending.msg.mentionDelivery ? "mention" : "plain",
      conn_age: this.machineConnectionAgeBucket(pending.machineId),
      attempts: pending.attempts,
      first_attempt_age_ms: this.clock.now() - pending.firstAttemptAt,
    }));
  }

  protected async loadMachineDaemonVersion(machineId: string): Promise<string | null> {
    const machine = await machineService.getMachine(asMachineId(machineId));
    return machine?.daemonVersion ?? null;
  }

  /**
   * SLO v1 SLI 4 (task #432): a tracked mention is acked only once the agent
   * has been told, which can wait for the end of the current turn, so a long
   * turn turned an arrived mention into gave_up (78% of give-ups in a trace
   * sample). `daemon_pending` is the daemon saying it has the message: count
   * arrival here, measured from the first attempt, and stop re-sending. The
   * record stays as an in-flight cycle (task #285: re-sends inside a live cycle
   * do not spend recovery budget) until the final ack or terminal error, at
   * most AGENT_DELIVERY_HELD_MAX_MS, then ends as held_expired.
   */
  private recordAgentDeliveryArrival(agentId: string, deliveryId: string): void {
    const key = `delivery:${deliveryId}`;
    const pending = this.pendingAgentDeliveryAcks.get(key);
    if (!pending || pending.msg.agentId !== agentId || pending.arrivedAt !== undefined) return;
    const now = this.clock.now();
    pending.arrivedAt = now;
    agentDeliveryAckSeconds.observe(agentDeliverySloLabels(pending), (now - pending.firstAttemptAt) / 1000);
    if (pending.timer) this.clock.clearTimeout(pending.timer);
    pending.parked = false;
    pending.parkedReason = undefined;
    pending.parkedAt = undefined;
    pending.timer = this.scheduleOnClock(() => {
      const current = this.pendingAgentDeliveryAcks.get(key);
      if (current !== pending) return;
      this.recordAgentDeliveryOutcome(pending, "held_expired");
      this.pendingAgentDeliveryAcks.delete(key);
    }, AgentOrchestrator.AGENT_DELIVERY_HELD_MAX_MS);
    const timerWithUnref = pending.timer as { unref?: () => void } | null;
    timerWithUnref?.unref?.();
  }

  private parkPendingAgentDeliveryAck(
    key: string,
    pending: PendingAgentDeliveryAck,
    reason: "machine_offline" | "computer_version_held",
  ): void {
    if (pending.timer) {
      this.clock.clearTimeout(pending.timer);
      pending.timer = null;
    }
    if (!pending.parked) pending.parkedAt = this.clock.now();
    pending.parked = true;
    pending.parkedReason = reason;
    this.scheduleParkedAgentDeliveryProbe(key, pending);
  }

  private scheduleParkedAgentDeliveryProbe(key: string, pending: PendingAgentDeliveryAck): void {
    pending.timer = this.scheduleOnClock(() => {
      void this.probeParkedAgentDelivery(key).catch((err) => {
        console.warn(`[Machine ${pending.machineId}] parked agent delivery probe failed for ${pending.msg.agentId}:`, err);
      });
    }, AgentOrchestrator.AGENT_DELIVERY_PARKED_PROBE_MS);
    const timerWithUnref = pending.timer as { unref?: () => void } | null;
    timerWithUnref?.unref?.();
  }

  /**
   * A parked record used to be woken only by its machine re-registering on
   * this same replica. A machine that reconnected to another replica, or never
   * came back, left it with no timer and no outcome until the process exited
   * (task #432: ~100/h fleet-wide). Like a parked start, keep probing the
   * machine's status without spending a delivery attempt:
   * - machine still offline: probe again, until the max age ends the record
   *   as parked_expired (a miss);
   * - machine online, plain delivery: unpark and retry, which re-sends here or
   *   routes it to the owning replica;
   * - machine online, tracked mention: ready-time durable mention recovery on
   *   the owning replica re-sends and re-tracks it, so this copy ends as routed.
   */
  private async probeParkedAgentDelivery(key: string): Promise<void> {
    const pending = this.pendingAgentDeliveryAcks.get(key);
    if (!pending?.parked) return;
    pending.timer = null;
    const versionHeld = pending.parkedReason === "computer_version_held";
    const maxParkedMs = versionHeld
      ? AgentOrchestrator.AGENT_DELIVERY_VERSION_HELD_MAX_MS
      : AgentOrchestrator.AGENT_DELIVERY_PARKED_MAX_MS;
    if (this.clock.now() - (pending.parkedAt ?? this.clock.now()) >= maxParkedMs) {
      this.recordAgentDeliveryOutcome(pending, "parked_expired");
      this.pendingAgentDeliveryAcks.delete(key);
      return;
    }
    if (versionHeld) {
      let held: boolean;
      try {
        held = await this.isMachineAgentWorkHeld(pending.machineId);
      } catch {
        held = true;
      }
      if (this.pendingAgentDeliveryAcks.get(key) !== pending || !pending.parked) return;
      if (held) {
        this.scheduleParkedAgentDeliveryProbe(key, pending);
        return;
      }
    }
    let machineStatus: "online" | "offline";
    try {
      machineStatus = await this.getMachineStatus(pending.machineId);
    } catch {
      if (this.pendingAgentDeliveryAcks.get(key) === pending && pending.parked) this.scheduleParkedAgentDeliveryProbe(key, pending);
      return;
    }
    // The record may have been acked, re-sent or cleared during the read.
    if (this.pendingAgentDeliveryAcks.get(key) !== pending || !pending.parked) return;
    if (machineStatus === "offline") {
      this.scheduleParkedAgentDeliveryProbe(key, pending);
      return;
    }
    if (pending.msg.mentionDelivery) {
      this.recordAgentDeliveryOutcome(pending, "routed");
      this.pendingAgentDeliveryAcks.delete(key);
      return;
    }
    pending.parked = false;
    pending.parkedReason = undefined;
    pending.parkedAt = undefined;
    // The machine is back: a new wait, not the tail of the one before the park.
    this.restartAgentDeliveryAckWait(pending);
    await this.retryPendingAgentDelivery(key, "ack_timeout");
  }

  private async loadPendingAgentDeliveryRetryGate(pending: PendingAgentDeliveryAck): Promise<{
    allowed: boolean;
    reason: string;
    wakeAction?: WakePlanAction;
    currentStatus?: AgentStatus;
    currentMachineId?: string | null;
  }> {
    const agent = await this.getAuthoritativeAgentForDelivery(pending.msg.agentId);
    if (!agent) {
      return { allowed: false, reason: "agent_missing" };
    }
    if (agent.machineId !== pending.machineId) {
      return {
        allowed: false,
        reason: "machine_mismatch",
        currentMachineId: agent.machineId,
        currentStatus: agent.status,
      };
    }
    if (pending.msg.mentionDelivery && (
      pending.msg.mentionDelivery.machineId !== agent.machineId
      || pending.msg.mentionDelivery.launchId !== agent.expectedLaunchId
      || pending.msg.mentionDelivery.sessionId !== agent.sessionId
    )) {
      await mentionDeliveryOccurrenceService.recordMentionDeliveryIdentityDrift(
        pending.msg.mentionDelivery.occurrenceId,
        "retry",
      );
      return {
        allowed: false,
        reason: "mention_identity_drift",
        currentMachineId: agent.machineId,
        currentStatus: agent.status,
      };
    }

    // The ack retry re-sends the first push of a system-app event: its
    // delivery guard is asked again (the recipient may have lost access).
    if (pending.msg.message.third_party_event && !await this.isSystemAppEventDeliverable(pending.msg.agentId, pending.msg.message)) {
      return {
        allowed: false,
        reason: "system_app_delivery_withheld",
        currentMachineId: agent.machineId,
        currentStatus: agent.status,
      };
    }

    const wakeInput = await this.loadWakePlanInput(pending.msg.agentId, agent.status);
    const wakeAction = planWakeAction(wakeInput);
    if (wakeAction !== "deliver-directly") {
      return {
        allowed: false,
        reason: "wake_plan_not_direct",
        wakeAction,
        currentMachineId: agent.machineId,
        currentStatus: agent.status,
      };
    }

    return {
      allowed: true,
      reason: "deliver_directly",
      wakeAction,
      currentMachineId: agent.machineId,
      currentStatus: agent.status,
    };
  }

  private restartAgentDeliveryAckWait(pending: PendingAgentDeliveryAck): void {
    pending.ackWaitStartedAt = this.clock.now();
    pending.ackWaits = 0;
  }

  private machineAckedDeliveryRecently(machineId: string): boolean {
    const lastAckAt = this.machineConnections.get(machineId)?.lastDeliveryAckAt;
    return lastAckAt !== undefined
      && this.clock.now() - lastAckAt <= AgentOrchestrator.AGENT_DELIVERY_LIVE_ACK_WINDOW_MS;
  }

  private async retryPendingAgentDelivery(key: string, reason: "ack_timeout" | "ready_reconcile" | "register"): Promise<void> {
    const pending = this.pendingAgentDeliveryAcks.get(key);
    if (!pending) return;
    // Still the live record for this key after an await. Two triggers for one
    // record (an ack timeout and a register, say) run concurrently, and an ack,
    // terminal error, stop or daemon_pending can settle it during an await;
    // without this check a retry recorded a second outcome, e.g. gave_up
    // twice (task #432).
    const stillCurrent = () => this.pendingAgentDeliveryAcks.get(key) === pending && pending.arrivedAt === undefined;
    if (pending.parked && reason === "ack_timeout") {
      return;
    }
    // Already at the daemon (daemon_pending): a re-send would only meet the
    // daemon's duplicate_pending and be answered with silence (task #432).
    if (pending.arrivedAt !== undefined) return;
    const localAtRetry = this.hasMachineLocally(pending.machineId);
    const ownerTraceAttrs = await this.getMachineOwnerTraceAttrs(pending.machineId);
    if (!stillCurrent()) return;
    const span = this.tracer.startSpan("server.agent.delivery.retry", {
      parent: parseTraceparent(pending.msg.traceparent),
      surface: "server",
      kind: "producer",
      attrs: {
        agent_id: pending.msg.agentId,
        machine_id: pending.machineId,
        agent_id_present: Boolean(pending.msg.agentId),
        machine_id_present: Boolean(pending.machineId),
        deliveryId: pending.msg.deliveryId,
        delivery_correlation_id: pending.msg.deliveryId,
        seq: pending.msg.seq,
        attempts: pending.attempts,
        retry_reason: reason,
        parked: pending.parked,
        parked_reason: pending.parkedReason,
        local_socket_present: localAtRetry,
        ...ownerTraceAttrs,
      },
    });
    // A reconnect starts a new wait on a new connection (task #1295).
    if (reason !== "ack_timeout") this.restartAgentDeliveryAckWait(pending);
    const ageMs = this.clock.now() - pending.ackWaitStartedAt;
    if (
      reason === "ack_timeout"
      && ageMs < AgentOrchestrator.AGENT_DELIVERY_DEFERRED_GIVE_UP_AFTER_MS
      && this.machineAckedDeliveryRecently(pending.machineId)
    ) {
      // Task #1295: the daemon is acking other deliveries, so this one is queued
      // behind them, not lost; another copy would only lengthen that queue.
      this.scheduleAgentDeliveryAckTimeout(key, pending);
      span.end("ok", { attrs: { ack_wait_age_ms: ageMs, outcome: "deferred", reason: "connection_acking" } });
      return;
    }
    if (ageMs >= AgentOrchestrator.AGENT_DELIVERY_GIVE_UP_AFTER_MS) {
      if (pending.timer) this.clock.clearTimeout(pending.timer);
      this.recordAgentDeliveryOutcome(pending, "gave_up");
      this.pendingAgentDeliveryAcks.delete(key);
      this.rememberGaveUpAgentDelivery(key, pending);
      // Task #432: gave_up concentrates on a few replicas (10-18% of their
      // deliveries vs 1-8% elsewhere), i.e. on a few machines, and the metrics
      // carry no machine. One JSON line per give-up (a few hundred per hour)
      // names them in CloudWatch; field names follow the
      // server.agent.delivery.retry span so queries join the trace.
      await this.logAgentDeliveryGaveUp(pending);
      span.end("ok", {
        attrs: {
          first_attempt_age_ms: this.clock.now() - pending.firstAttemptAt,
          ack_wait_age_ms: ageMs,
          outcome: "gave_up",
          reason: "ack_retry_exhausted",
        },
      });
      return;
    }
    await this.runInActiveSpan(span, async () => {
      try {
        const gate = await this.loadPendingAgentDeliveryRetryGate(pending);
        if (!stillCurrent()) {
          span.end("ok", { attrs: { outcome: "superseded", reason: "settled_during_retry" } });
          return;
        }
        this.recordEvent("server.delivery.retry.gate", {
          outcome: gate.allowed ? "allowed" : "dropped",
          reason: gate.reason,
          wake_action: gate.wakeAction,
          current_status: gate.currentStatus,
          current_machine_id_present: gate.currentMachineId != null,
          machine_matches: gate.currentMachineId === pending.machineId,
        });
        if (!gate.allowed) {
          if (pending.timer) this.clock.clearTimeout(pending.timer);
          this.recordAgentDeliveryOutcome(pending, "dropped");
          this.pendingAgentDeliveryAcks.delete(key);
          span.end("ok", {
            attrs: {
              outcome: "dropped",
              reason: gate.reason,
              wake_action: gate.wakeAction,
              current_status: gate.currentStatus,
            },
          });
          return;
        }

        const machineStatus = await this.getMachineStatus(pending.machineId);
        if (!stillCurrent()) {
          span.end("ok", { attrs: { outcome: "superseded", reason: "settled_during_retry" } });
          return;
        }
        this.recordEvent("server.delivery.retry.machine_status", {
          machine_status: machineStatus,
          retry_reason: reason,
        });
        if (machineStatus === "online" && await this.isMachineAgentWorkHeld(pending.machineId)) {
          this.parkPendingAgentDeliveryAck(key, pending, "computer_version_held");
          span.end("ok", {
            attrs: {
              outcome: "parked",
              reason: "computer_version_held",
              wake_action: gate.wakeAction,
              current_status: gate.currentStatus,
            },
          });
          return;
        }
        if (machineStatus === "offline") {
          this.parkPendingAgentDeliveryAck(key, pending, "machine_offline");
          // An app event has no durable chain row: this park is what the
          // machine-ready / sweep re-delivery (thirdPartyAgentEventRedelivery)
          // recovers. Tie it to the event.
          const thirdPartyEventId = pending.msg.message.third_party_event?.id;
          if (thirdPartyEventId) {
            this.recordEvent("server.third_party_event.parked", {
              outcome: "parked_machine_offline",
              third_party_event_id: thirdPartyEventId,
              agent_id: pending.msg.agentId,
              machine_id: pending.machineId,
              deliveryId: pending.msg.deliveryId,
            });
          }
          span.end("ok", {
            attrs: {
              outcome: "parked",
              reason: "machine_offline",
              wake_action: gate.wakeAction,
              current_status: gate.currentStatus,
              ...(thirdPartyEventId ? { third_party_event_id: thirdPartyEventId, third_party_event_outcome: "parked_machine_offline" } : {}),
            },
          });
          return;
        }

        pending.parked = false;
        pending.parkedReason = undefined;
        pending.attempts += 1;
        pending.lastAttemptAt = this.clock.now();
        let routeTraceAttrs: Record<string, unknown> = {};
        const sent = await this.sendToMachine(pending.machineId, pending.msg, {
          onRouteResult: (routeResult) => {
            routeTraceAttrs = projectMachineCommandRouteTraceAttrs(routeResult);
          },
        });
        const deliveryTraceAttrs = { ...ownerTraceAttrs, ...routeTraceAttrs };
        if (!stillCurrent()) {
          span.end("ok", { attrs: { outcome: "superseded", reason: "settled_during_retry", ...deliveryTraceAttrs } });
          return;
        }
        this.recordEvent("server.delivery.retry.sent", {
          outcome: sent ? "sent" : "not_sent",
          reason: sent ? (localAtRetry ? "local_socket_present" : "routed_to_owner") : "machine_unreachable",
          deliveryId: pending.msg.deliveryId,
          seq: pending.msg.seq,
          ...deliveryTraceAttrs,
        });
        if (sent && !localAtRetry) {
          if (pending.timer) this.clock.clearTimeout(pending.timer);
          this.recordAgentDeliveryOutcome(pending, "routed");
          this.pendingAgentDeliveryAcks.delete(key);
          span.end("ok", { attrs: { outcome: "routed", reason: "routed_to_owner", ...deliveryTraceAttrs } });
          return;
        }
        this.scheduleAgentDeliveryAckTimeout(key, pending);
        span.end("ok", { attrs: { outcome: sent ? "resent" : "scheduled", reason: sent ? "local_retry_sent" : "machine_unreachable", ...deliveryTraceAttrs } });
      } catch (err) {
        if (stillCurrent()) this.scheduleAgentDeliveryAckTimeout(key, pending);
        span.end("error", { attrs: { outcome: "scheduled", reason: "retry_error", error_class: errorClassOf(err) } });
        console.warn(`[Machine ${pending.machineId}] agent delivery retry failed for ${pending.msg.agentId}:`, err);
      }
    });
  }

  /**
   * A daemon ended a tracked mention with a terminal error: the tracking is
   * over, but the message has not reached the agent (every code is about the
   * delivery path or the tracking, never about the message). Send it once
   * more as a plain delivery, under the ordinary ack-retry cycle, so no
   * daemon refusal drops a message (Tenny, P1: a fresh Claude session refused
   * tracked mentions and nothing redelivered them). Only the call whose
   * terminal write won comes here, so it is sent once; a daemon that already
   * holds or saw the message drops the copy as a duplicate.
   */
  private async redeliverUntrackedAfterMentionTerminal(
    machineId: string,
    agentId: string,
    payload: AgentMessage | null | undefined,
    code: string,
  ): Promise<void> {
    if (!payload) return;
    console.warn("[MentionDelivery] terminal error; redelivering untracked", { agentId, code, seq: payload.seq ?? 0 });
    await this.sendAgentDeliveryWithAckRetry(machineId, {
      type: "agent:deliver",
      agentId,
      message: payload,
      seq: payload.seq ?? 0,
      deliveryId: crypto.randomUUID(),
    }, `untracked redelivery after mention terminal error failed for agent ${agentId}`);
  }

  protected async sendAgentDeliveryWithAckRetry(
    machineId: string,
    msg: Extract<ServerToMachineMessage, { type: "agent:deliver" }>,
    errorContext: string,
  ): Promise<boolean> {
    // An app event's content as the pull paths hand it over: an external app's
    // inert, Raft's own system apps' as a message (agentFacingContent.ts). Done
    // before tracking, so a retry or a delivery-rejected wake reuses it.
    if (msg.message.sender_type === "third_party_app") {
      const serverId = this.agentStateCache.get(msg.agentId)?.serverId ?? this.machineConnections.get(machineId)?.serverId;
      const [message] = await renderPushedMessages([msg.message], msg.agentId, serverId);
      msg = { ...msg, message: message! };
    }
    // Glimpse layer-1 input duplication: the server offers this body to the agent.
    // No launch: the cached expected launch is this instance's and can be stale.
    recordAgentContextReturned({
      source: "delivery",
      agentId: msg.agentId,
      channelId: msg.message.channel_id,
      seqs: [msg.seq],
    });
    // Below the Computer version floor: hold the delivery, unsent, until the
    // machine reconnects on a supported version (the park probe re-checks).
    if (await this.isMachineAgentWorkHeld(machineId).catch(() => false)) {
      this.trackPendingAgentDeliveryAck(machineId, msg);
      const key = this.findAgentDeliveryAckKey(msg.agentId, msg.seq, msg.deliveryId);
      const pending = key ? this.pendingAgentDeliveryAcks.get(key) : undefined;
      if (key && pending) this.parkPendingAgentDeliveryAck(key, pending, "computer_version_held");
      return false;
    }
    const localAtSend = this.hasMachineLocally(machineId);
    if (localAtSend) {
      this.trackPendingAgentDeliveryAck(machineId, msg);
    }
    try {
      const sent = await this.sendToMachine(machineId, msg);
      if (!sent && !this.findAgentDeliveryAckKey(msg.agentId, msg.seq, msg.deliveryId)) {
        this.trackPendingAgentDeliveryAck(machineId, msg);
      }
      return sent;
    } catch (err) {
      if (!this.findAgentDeliveryAckKey(msg.agentId, msg.seq, msg.deliveryId)) {
        this.trackPendingAgentDeliveryAck(machineId, msg);
      }
      console.warn(`[Machine ${machineId}] ${errorContext}:`, err);
      return false;
    }
  }

  protected async resolveRoutedMachineOwnership(
    machineId: string,
    localMachineIds: Set<string>,
    handleLocally: () => boolean | Promise<boolean>,
    rerouteToCurrentOwner: () => Promise<boolean>,
    fallback: () => boolean | Promise<boolean>,
  ): Promise<boolean> {
    const action = planRoutedOwnershipAction({
      machineIsLocal: localMachineIds.has(machineId),
      canReroute: this.replicaStateStore.isAvailable(),
    });

    return this.applyRoutedOwnershipAction({
      action,
      handleLocally,
      rerouteToCurrentOwner,
      fallback,
    });
  }

  protected async applyRoutedOwnershipAction(context: RoutedOwnershipApplyContext): Promise<boolean> {
    if (context.action === "handle-locally") {
      return await context.handleLocally();
    }

    if (context.action === "reroute-then-fallback") {
      const rerouted = await context.rerouteToCurrentOwner();
      if (rerouted) {
        return true;
      }
    }

    return await context.fallback();
  }

  /** This replica's ready machine connections and the Server each one serves. */
  listLocalMachineServers(): Array<{ machineId: string; serverId: string }> {
    const result: Array<{ machineId: string; serverId: string }> = [];
    for (const [machineId, conn] of this.machineConnections.entries()) {
      if (conn.ws.readyState === 1) result.push({ machineId, serverId: conn.serverId });
    }
    return result;
  }

  /** Send directly to a local machine connection (used by ReplicaRouter callback) */
  sendToLocalMachine(machineId: string, msg: ServerToMachineMessage): boolean {
    const conn = this.machineConnections.get(machineId);
    if (!conn || conn.ws.readyState !== 1) return false;
    conn.ws.send(JSON.stringify(msg));
    return true;
  }

  async handleRoutedMachineCommand(machineId: string, msg: ServerToMachineMessage): Promise<boolean> {
    const localMachineIds = this.getRoutableLocalMachineIds();
    return this.resolveRoutedMachineOwnership(
      machineId,
      localMachineIds,
      () => {
        // A provider connect arrives sealed; only the socket's own replica opens it.
        const opened = openAfterReplicaHop(machineId, msg);
        if (opened.ok) return this.handleLocalRoutedMachineCommand(machineId, opened.message);
        this.refuseSealedConnect(machineId, opened.reason, opened.requestId);
        return true;
      },
      async () => normalizeMachineCommandRouteResult(
        await this.routeMachineCommandCrossReplica(machineId, msg, localMachineIds),
      ).routed,
      () => false,
    );
  }

  private async handleLocalRoutedMachineCommand(machineId: string, msg: ServerToMachineMessage): Promise<boolean> {
    if (
      msg.type === "agent:start"
      && msg.startDispatchId
      && this.terminalAgentStartDispatches.has(msg.startDispatchId)
    ) {
      // Task #368: a peer's resend of a start this replica already settled
      // (superseded, acked, stale…). Re-tracking it would supersede the
      // agent's current pending start, and re-arming the guard would point it
      // back at the old launch, so the current launch's frames would be
      // dropped as stale. Report it handled so the peer stops retrying.
      this.recordEvent("server.agent.start_dispatch.routed_resend_ignored", {
        agent_id: msg.agentId,
        machine_id: machineId,
        launch_id: msg.launchId,
        start_dispatch_id: msg.startDispatchId,
        terminal_reason: this.terminalAgentStartDispatches.get(msg.startDispatchId),
      });
      return true;
    }
    if (msg.type === "agent:start") {
      // A peer that could not route the start as an intent (owner without
      // intent support) prepared it and armed only its own guard. This
      // replica receives the launch's frames, so it arms the guard for the
      // launch it is about to send; otherwise every frame of that launch is
      // dropped against the older one as stale_launch_guard.
      this.armStartLaunchGuard(msg.agentId, msg.launchId);
    }
    if (
      msg.type === "agent:start"
      && msg.startDispatchId
    ) {
      return await this.sendAgentStartWithAckRetry(
        machineId,
        msg as AgentStartMessage & { startDispatchId: string },
      );
    }

    if (msg.type === "agent:deliver" && await this.maybeWakeForRoutedAgentDeliver(machineId, msg)) {
      return true;
    }

    if (msg.type === "agent:deliver") {
      this.trackPendingAgentDeliveryAck(machineId, msg);
      return this.sendToLocalMachine(machineId, msg);
    }

    return this.sendToLocalMachine(machineId, msg);
  }

  private async maybeWakeForRoutedAgentDeliver(
    machineId: string,
    msg: Extract<ServerToMachineMessage, { type: "agent:deliver" }>,
  ): Promise<boolean> {
    const agent = await this.getAuthoritativeAgentForDelivery(msg.agentId);
    if (!agent || agent.machineId !== machineId) {
      return false;
    }

    const wakeInput = await this.loadWakePlanInput(msg.agentId, agent.status);
    const action = planWakeAction(wakeInput);
    if (action === "deliver-directly") {
      return false;
    }
    if (action === "suppress-control-gate") {
      if (!msg.transient) {
        this.deliverToLocalInbox(msg.agentId, msg.message, { notifyPendingReceive: false });
      }
      await this.maybePiggybackRuntimeProfileMigrationNudge(machineId, agent);
      return true;
    }

    await this.applyWakeAction({
      agentId: msg.agentId,
      machineId: agent.machineId,
      previousStatus: agent.status,
      resetMode: wakeInput.state.resetMode,
      transient: msg.transient ?? false,
    }, msg.message, action);
    return true;
  }

  /**
   * Owner side of the plain cross-replica inbox route. Only reachable from the
   * replica router's `inbox:deliver` envelope on Redis pub/sub, which only
   * server replicas publish. `deliveryOptions.intrinsic` comes from that
   * envelope (set by the sending replica from its own `DeliverMessageOptions`),
   * never from the `AgentMessage` payload, so a payload carrying an
   * `intrinsic` field is still visibility-checked.
   */
  async handleRoutedInboxDelivery(
    agentId: string,
    machineId: string | null,
    message: AgentMessage,
    deliveryOptions: RoutedInboxDeliveryOptions = {},
  ): Promise<boolean> {
    const agent = await this.getCachedAgent(agentId);
    if (!agent || agent.status !== "active" || !agent.machineId) {
      return true;
    }
    // Intrinsic deliveries (e.g. onboarding owner facts) carry a label, not a
    // channel id, as channel_id; the sender skipped this check for them.
    if (deliveryOptions.intrinsic !== true && !await this.canAgentAccessDeliveryTarget(agentId, agent, message)) {
      return true;
    }

    // Old routed payloads may not carry machineId; use current cached ownership as
    // the contract anchor so mixed-version server windows still route correctly.
    const targetMachineId = agent.machineId;
    const localMachineIds = this.getRoutableLocalMachineIds();
    return this.resolveRoutedMachineOwnership(
      targetMachineId,
      localMachineIds,
      () => this.deliverToLocalInboxIfStillActive(agentId, targetMachineId, message),
      () => this.routeInboxDeliveryCrossReplica(agentId, targetMachineId, message, localMachineIds, deliveryOptions),
      () => this.deliverToLocalInboxIfStillActive(agentId, targetMachineId, message),
    );
  }

  async handleRoutedInboxDeliveryWithReceipt(
    agentId: string,
    machineId: string | null,
    message: AgentMessage,
    deliveryOptions: RoutedInboxDeliveryOptions = {},
  ): Promise<AgentMessageDeliveryResult> {
    if (!machineId || !this.getRoutableLocalMachineIds().has(machineId)) {
      return { status: "dropped", reason: "cross_replica_receipt_unavailable" };
    }
    const agent = await this.getCachedAgent(agentId);
    if (!agent || agent.machineId !== machineId) {
      return { status: "dropped", reason: "agent_state_changed" };
    }
    return this.deliverMessage(agentId, message, {
      ...deliveryOptions,
      requireQueueReceipt: true,
    });
  }

  protected async canAgentAccessDeliveryTarget(
    agentId: string,
    agent: CachedAgentState,
    message: AgentMessage,
    // The batch-read answer for this agent's row (deliverMessagesOnChannel), if any.
    knownAccess?: boolean,
  ): Promise<boolean> {
    if (message.third_party_event) return true;
    let checkError: unknown = null;
    return this.runInTraceSpan(
      "server.agent_delivery.visibility_check",
      {
        attrs: {
          agent_id: agentId,
          channel_id: message.channel_id,
        },
      },
      async () => {
        try {
          if (knownAccess !== undefined) return knownAccess;
          const channel = await channelService.getChannel(message.channel_id);
          if (!channel || channel.serverId !== agent.serverId) {
            return false;
          }
          return await channelService.canAgentAccessChannel(message.channel_id, agentId);
        } catch (error) {
          console.warn(`[Agent ${agentId}] Dropping delivery for ${message.channel_id}: target visibility check failed`, error);
          checkError = error;
          this.recordEvent("server.agent_delivery.visibility_check_failed", {
            agent_id: agentId,
            channel_id: message.channel_id,
            channel_kind: deliveryChannelKind(message.channel_id),
            outcome: "error",
            reason: "visibility_check_threw",
            error_class: errorClassOf(error),
            error_code: pgSqlState(error) ?? "none",
          });
          return false;
        }
      },
      (allowed) => checkError == null
        ? { attrs: { outcome: allowed ? "allowed" : "denied" } }
        : {
          status: "error",
          attrs: {
            outcome: "error",
            reason: "visibility_check_threw",
            error_class: errorClassOf(checkError),
            error_code: pgSqlState(checkError) ?? "none",
            channel_kind: deliveryChannelKind(message.channel_id),
          },
        },
    );
  }

  /**
   * Validate that an incoming machine-originated agent event actually belongs to
   * the machine/server that sent it. This prevents a buggy or compromised daemon
   * from overwriting another agent's activity/status/trajectory.
   */
  /**
   * task #1103 — a daemon asks the Server to wake an agent that has a due
   * app-inbox item but no local process and no restart snapshot. The Server
   * owns the config, so it decides through the ordinary startAgent path and
   * answers with a typed outcome. A dispatched id is replayed for a while so a
   * duplicate fire or a resend after reconnect never dispatches twice.
   */
  private readonly recentAgentWakeDispatches = new Map<string, { agentId: string; atMs: number }>();
  private static readonly AGENT_WAKE_DISPATCH_REPLAY_MS = 5 * 60_000;
  private static readonly AGENT_WAKE_DISPATCH_REPLAY_MAX_ENTRIES = 4096;

  /** Keyed by wakeRequestId: one agent may have several ids in flight (A, B, then A resent). */
  private rememberAgentWakeDispatch(wakeRequestId: string, agentId: string): void {
    const now = this.clock.now();
    for (const [id, entry] of this.recentAgentWakeDispatches) {
      if (now - entry.atMs >= AgentOrchestrator.AGENT_WAKE_DISPATCH_REPLAY_MS) this.recentAgentWakeDispatches.delete(id);
    }
    while (this.recentAgentWakeDispatches.size >= AgentOrchestrator.AGENT_WAKE_DISPATCH_REPLAY_MAX_ENTRIES) {
      const oldest = this.recentAgentWakeDispatches.keys().next().value;
      if (oldest === undefined) break;
      this.recentAgentWakeDispatches.delete(oldest);
    }
    this.recentAgentWakeDispatches.set(wakeRequestId, { agentId, atMs: now });
  }

  private replayableAgentWakeDispatch(wakeRequestId: string, agentId: string): boolean {
    const entry = this.recentAgentWakeDispatches.get(wakeRequestId);
    if (!entry) return false;
    if (entry.agentId !== agentId || this.clock.now() - entry.atMs >= AgentOrchestrator.AGENT_WAKE_DISPATCH_REPLAY_MS) {
      this.recentAgentWakeDispatches.delete(wakeRequestId);
      return false;
    }
    return true;
  }

  private async handleAgentWakeRequest(
    machineId: string,
    serverId: string | null,
    msg: Extract<MachineToServerMessage, { type: "agent:wake:request" }>,
  ): Promise<void> {
    // The daemon sends its traceparent with the request, so the start
    // dispatch and the agent:start it produces stay on the daemon's trace.
    await withTraceRoot(this.tracer, "server.agent.wake_request", {
      parent: parseTraceparent(msg.traceparent),
      surface: "server",
      kind: "consumer",
      attrs: {
        agent_id: msg.agentId,
        machine_id: machineId,
        wake_request_id: msg.wakeRequestId,
        wake_reason: msg.reason,
        pending_app_items: msg.pendingAppItems,
        // The machine is authenticated; its CONTENT is not. Validate the app
        // reference against the SERVER's own known-app set before it becomes
        // span attributes — see wakeRequestAppRef.ts. The wake itself is
        // unaffected either way.
        ...wakeRequestAppRefTraceAttrs({
          appId: msg.appId,
          ownerAgentId: msg.agentId,
          sourceRef: msg.sourceRef,
        }),
      },
    }, () => this.answerAgentWakeRequest(machineId, serverId, msg));
  }

  private async answerAgentWakeRequest(
    machineId: string,
    serverId: string | null,
    msg: Extract<MachineToServerMessage, { type: "agent:wake:request" }>,
  ): Promise<void> {
    const answer = (outcome: "dispatched" | "refused", reason?: AgentWakeRefusedReason) => {
      addTraceEvent("wake_request.answered", {
        outcome,
        reason: reason ?? null,
      });
      return this.sendToMachine(machineId, {
        type: "agent:wake:outcome",
        agentId: msg.agentId,
        wakeRequestId: msg.wakeRequestId,
        outcome,
        ...(reason ? { reason } : {}),
      });
    };
    const validation = await this.validateMachineAgentMessageWithReason(machineId, serverId, msg.agentId, msg.type);
    if (!validation.agent) {
      await answer("refused", validation.dropReason === "unknown_agent" ? "agent_not_found" : "machine_mismatch");
      return;
    }
    if (this.replayableAgentWakeDispatch(msg.wakeRequestId, msg.agentId)) {
      await answer("dispatched");
      return;
    }
    try {
      const result = await this.startAgent(msg.agentId, { startCause: "app_inbox_wake" });
      if (result.outcome === "dispatched") {
        this.rememberAgentWakeDispatch(msg.wakeRequestId, msg.agentId);
        console.log(`[Agent ${msg.agentId}] Wake dispatched for daemon app-inbox request ${msg.wakeRequestId} (${msg.appId} ${msg.sourceRef.kind}:${msg.sourceRef.id})`);
        await answer("dispatched");
        return;
      }
      console.log(`[Agent ${msg.agentId}] Wake refused for daemon app-inbox request ${msg.wakeRequestId}: ${result.reason}`);
      await answer("refused", result.reason);
    } catch (error) {
      console.error(`[Agent ${msg.agentId}] Wake request ${msg.wakeRequestId} failed:`, error);
      await answer("refused", "server_error");
    }
  }

  /**
   * task #1113 — the daemon could not deliver because the agent has no
   * process and no cached config. The Server owns the config: settle the
   * pending delivery as converted and dispatch one ordinary start that
   * carries the message as its wake message. Idempotent per delivery key: a
   * duplicate rejection finds no pending delivery and is ignored.
   */
  private async handleAgentDeliveryRejected(
    machineId: string,
    serverId: string | null,
    msg: Extract<MachineToServerMessage, { type: "agent:delivery:rejected" }>,
  ): Promise<void> {
    let rejectedOutcome: TraceAttributes = { outcome: "invalid_agent" };
    await this.runInTraceSpan(
      "server.agent.delivery.rejected",
      {
        kind: "consumer",
        parent: parseTraceparent(msg.traceparent),
        attrs: {
          agent_id: msg.agentId,
          machine_id: machineId,
          seq: msg.seq,
          deliveryId: msg.deliveryId ?? null,
          reason: msg.reason,
        },
      },
      () => this.handleAgentDeliveryRejectedInSpan(machineId, serverId, msg, (outcome, extra = {}) => {
        rejectedOutcome = { outcome, ...(extra as TraceAttributes) };
      }),
      () => ({
        status: String(rejectedOutcome.outcome).startsWith("start_failed") ? "error" : "ok",
        attrs: rejectedOutcome,
      }),
    );
  }

  private async handleAgentDeliveryRejectedInSpan(
    machineId: string,
    serverId: string | null,
    msg: Extract<MachineToServerMessage, { type: "agent:delivery:rejected" }>,
    trace: (outcome: string, extra?: Record<string, unknown>) => void,
  ): Promise<void> {
    const agent = await this.validateMachineAgentMessage(machineId, serverId, msg.agentId, msg.type);
    if (!agent) return;
    const key = this.findAgentDeliveryAckKey(msg.agentId, msg.seq, msg.deliveryId);
    const pending = key ? this.pendingAgentDeliveryAcks.get(key) : undefined;
    if (!key || !pending) {
      trace("ignored_no_pending");
      return;
    }
    if (pending.machineId !== machineId) {
      trace("ignored_other_machine", { pending_machine_id: pending.machineId });
      return;
    }
    // Settle the delivery here: the start below is its continuation, and the
    // ordinary retry-until-gave-up path must not redeliver the same message.
    if (pending.timer) this.clock.clearTimeout(pending.timer);
    this.recordAgentDeliveryOutcome(pending, "converted_to_wake");
    this.pendingAgentDeliveryAcks.delete(key);
    // The start re-sends the first push: a system-app event goes through its
    // delivery guard again; one it does not allow ends here.
    if (pending.msg.message.third_party_event && !await this.isSystemAppEventDeliverable(msg.agentId, pending.msg.message)) {
      trace("system_app_delivery_withheld");
      return;
    }
    let result: AgentStartDispatchResult;
    try {
      result = await this.startAgent(msg.agentId, {
        wakeMessage: pending.msg.message,
        ...(pending.msg.transient ? { wakeMessageTransient: true } : {}),
      });
    } catch (error) {
      console.error(`[Agent ${msg.agentId}] Wake start after rejected delivery ${key} failed:`, error);
      // Keep the delivery observable through the ordinary ack-retry path.
      this.trackPendingAgentDeliveryAck(machineId, pending.msg);
      trace("start_failed_retracked", {
        error_class: errorClassOf(error),
      });
      return;
    }
    if (result.outcome === "dispatched") {
      console.log(`[Agent ${msg.agentId}] Rejected delivery ${key} converted into a wake start`);
      trace("converted_to_wake_start");
      return;
    }
    if (result.reason === "wake_lock_held") {
      // Another replica is starting this agent; the starting process will take
      // the ordinary redelivery.
      this.trackPendingAgentDeliveryAck(machineId, pending.msg);
      trace("start_skipped_wake_lock_held_retracked");
      return;
    }
    // manual_stop: the agent is offline by user intent; the delivery ends here
    // with a typed outcome instead of retrying until gave_up.
    trace(`start_skipped_${result.reason}`);
  }

  private async validateMachineAgentMessage(
    machineId: string,
    serverId: string | null,
    agentId: string,
    messageType: string
  ): Promise<CachedAgentState | null> {
    const result = await this.validateMachineAgentMessageWithReason(machineId, serverId, agentId, messageType);
    return result.agent;
  }

  private async validateMachineAgentMessageWithReason(
    machineId: string,
    serverId: string | null,
    agentId: string,
    messageType: string
  ): Promise<MachineAgentValidationResult> {
    if (!serverId) {
      console.warn(`[Machine ${machineId}] Dropping ${messageType} for agent ${agentId}: missing server context`);
      return { agent: null, dropReason: "missing_server_context" };
    }

    const agent = await this.getCachedAgent(agentId);
    if (!agent) {
      console.warn(`[Machine ${machineId}] Dropping ${messageType} for unknown agent ${agentId}`);
      return { agent: null, dropReason: "unknown_agent" };
    }

    if (agent.machineId !== machineId || agent.serverId !== serverId) {
      console.warn(
        `[Machine ${machineId}] Dropping ${messageType} for agent ${agentId}: ` +
        `expected machine=${agent.machineId ?? "null"} server=${agent.serverId}, got machine=${machineId} server=${serverId}`
      );
      return { agent: null, dropReason: "machine_or_server_mismatch" };
    }

    return { agent, dropReason: null };
  }

  protected async getMachineForAgent(agentId: string): Promise<{ machineId: string; conn: MachineConnection } | null> {
    const agent = await agentService.getAgent(agentId, false, {
      dbCallsite: "agent_orchestrator.machine_lookup",
    });
    if (!agent?.machineId) return null;
    const conn = this.machineConnections.get(agent.machineId);
    if (!conn) return null;
    return { machineId: agent.machineId, conn };
  }

  // Agent lifecycle

  /** Test seam: the resume recovery read (the unified chain). */
  protected async selectResumeInbox(agentId: string): Promise<channelService.AgentInboxChainSelection> {
    return channelService.selectAgentInboxChainRows(agentId);
  }

  protected async loadAgentForStart(agentId: string) {
    return agentService.getAgent(agentId, false, {
      dbCallsite: "agent_orchestrator.start",
    });
  }

  protected async resetPersistedAgentSession(agentId: string, status: AgentStatus = "inactive") {
    await agentService.resetAgentSession(agentId, status);
  }

  private broadcastAgentSession(agent: Pick<CachedAgentState, "id" | "serverId" | "assistantOwnerUserId">, sessionId: string | null) {
    this.io?.to(agentEventRoom(agent.serverId, agent.assistantOwnerUserId)).emit("agent:session", { agentId: agent.id, sessionId });
  }

  private releaseWakeLock(agentId: string) {
    if (!this.replicaStateStore.isAvailable()) return;
    this.replicaStateStore.releaseWakeLock(agentId).catch(() => {});
  }

  protected getResetMode(agentId: string): "restart" | "session" | "full" | null {
    return this.resetInProgress.get(agentId) ?? null;
  }

  private getActivityIngestSeqKey(
    agentId: string,
    launchId: string | undefined,
    daemonInstanceId?: string,
  ): string {
    if (daemonInstanceId) {
      this.observeActivityDaemonGeneration(agentId, daemonInstanceId);
      return `${agentId}:daemon:${daemonInstanceId}:launch:${launchId ?? "legacy"}`;
    }
    if (launchId) return `${agentId}:launch:${launchId}`;
    const epoch = this.activityIngestEpochByAgent.get(agentId) ?? 0;
    return `${agentId}:legacy:${epoch}`;
  }

  private observeActivityDaemonGeneration(agentId: string, daemonInstanceId: string): void {
    const generations = this.activityDaemonGenerationsByAgent.get(agentId) ?? [];
    if (generations.includes(daemonInstanceId)) return;

    generations.push(daemonInstanceId);
    while (generations.length > AgentOrchestrator.ACTIVITY_DAEMON_GENERATIONS_PER_AGENT) {
      const expired = generations.shift();
      if (!expired) continue;
      const expiredPrefix = `${agentId}:daemon:${expired}:`;
      for (const key of this.lastClientSeqByActivityIngestKey.keys()) {
        if (key.startsWith(expiredPrefix)) {
          this.lastClientSeqByActivityIngestKey.delete(key);
        }
      }
    }
    this.activityDaemonGenerationsByAgent.set(agentId, generations);
  }

  private advanceActivityIngestEpoch(agentId: string): number {
    const next = (this.activityIngestEpochByAgent.get(agentId) ?? 0) + 1;
    this.activityIngestEpochByAgent.set(agentId, next);
    const legacyPrefix = `${agentId}:legacy:`;
    for (const key of this.lastClientSeqByActivityIngestKey.keys()) {
      if (key.startsWith(legacyPrefix)) {
        this.lastClientSeqByActivityIngestKey.delete(key);
      }
    }
    return next;
  }

  /** Protected so deterministic tests can replace the DB-backed gate reads with a fixed lifecycle snapshot. */
  protected async loadWakePlanInput(
    agentId: string,
    status: AgentStatus,
    // The batch-read migration gate for this agent (deliverMessagesOnChannel), if any.
    knownMigrationGated?: boolean,
  ): Promise<WakePlanInput> {
    // TODO(lifecycle-v2/state-snapshot): delivery wake planning currently
    // builds a minimal in-memory state from DB status, reset state, and
    // runtime-profile gate. If machine reachability becomes authoritative for
    // delivery wake decisions, extend this builder to read the machine owner/
    // connection state instead of leaving reachability as "unknown".
    const migrationGated = knownMigrationGated
      ?? Boolean((await agentMigrationService.getAgentMigrationGateStatus(agentId)).migration);
    const controlGate = migrationGated
      ? "zen_migrating"
      : await agentRuntimeProfileService.isRuntimeProfileMigrationGated(agentId)
        ? "runtime_profile_migration"
        : "open";
    const state = buildAgentLifecycleStateSnapshot({
      controlGate,
      dbStatus: status,
      resetMode: this.getResetMode(agentId),
      runtimeState: this.agentStateCache.get(agentId)?.runtimeState,
    });
    return { state };
  }

  /**
   * Emit `migration_aborted` for a migration the deadline sweep just aborted. The sweep's revision-checked update makes
   * it the single writer of each abort, so this runs exactly once per aborted migration.
   */
  async recordAgentMigrationAborted(migration: agentMigrationService.AgentMigrationRow, occurredAt: Date): Promise<void> {
    const event = agentMigrationService.createAgentMigrationLifecycleEvent({ migration, occurredAt });
    const agent = await this.getCachedAgent(migration.agentId);
    if (!agent) return;
    const { state } = await this.loadWakePlanInput(migration.agentId, agent.status);
    const span = this.tracer.startSpan("server.agent.migration.deadline_expired", {
      surface: "server",
      kind: "internal",
      attrs: {
        agent_id_present: Boolean(migration.agentId),
        migration_event_type: event.eventType,
        control_gate: state.controlGate,
      },
    });
    try {
      await applyAgentLifecycleProjectionPlan(
        reduceAgentMigrationControlLifecycle({ event, state }),
        this.lifecycleProjectionWriterDeps(),
        span,
      );
      span.end("ok");
    } catch (err) {
      span.end("error", { attrs: { error_class: errorClassOf(err) } });
    }
  }

  /**
   * Start an agent on the replica that owns its machine socket. That replica
   * is the one that checks the new launch's frames against the launchId it
   * minted, so the start is prepared there rather than here and forwarded as
   * a finished command. Without this, a start prepared on a peer leaves the
   * owner expecting an older launch and every frame of the new one is dropped
   * as stale_launch_guard.
   */
  async startAgent(agentId: string, options: StartAgentOptions = {}): Promise<AgentStartDispatchResult> {
    // task #365: an `internal` start is never forwarded; see startAgentForRetry.
    if (options.startCause === "internal") throw new Error("internal starts go through startAgentForRetry");
    // F9: only the replica holding the socket whose `ready` owes the wake starts it (an older owner would not know the cause).
    const { startCause } = options;
    if (startCause === "ready_owed") throw new Error("ready owed wakes go through startReadyOwedWakePass");
    const routed = this.mayRunOnOwner(agentId) ? await this.runOnOwner(agentId, { kind: "start", options: { ...options, startCause } }) : null;
    if (!routed) return this.startAgentHere(agentId, options);
    return routed as AgentStartDispatchResult;
  }

  /**
   * task #365: the spawn-error retry sweep's start runs only on the replica
   * that holds the machine's socket; it is never handed to an owner (an
   * older owner would not know `internal` and has no stopped guard for it).
   * The check is made here, where a start would otherwise be forwarded, and
   * the start is stamped with that socket's epoch: if the machine reconnects
   * after this point, the daemon refuses the start (`stale_dispatch`). A
   * skipped start keeps its demand; the next sweep decides again.
   */
  async startAgentForRetry(agentId: string): Promise<AgentStartDispatchResult | { outcome: "skipped"; reason: "not_local_machine" }> {
    const agent = await this.loadAgentForStart(agentId);
    const epoch = agent?.machineId ? this.machineConnections.get(agent.machineId)?.connectionEpochId : undefined;
    if (!epoch) {
      this.recordEvent("terminal_breaker.spawn_error_retry_not_local", { agent_id: agentId });
      return { outcome: "skipped", reason: "not_local_machine" };
    }
    return this.startAgentHere(agentId, { startCause: "internal", localConnectionEpochId: epoch });
  }

  /**
   * Synchronous pre-check: false only when there is no shared replica state
   * (a single-replica deployment), so that path keeps its previous timing.
   * Whether the machine is local is decided in runOnOwner from the database:
   * this replica's cache is not told when a migration moves the agent.
   */
  protected mayRunOnOwner(_agentId: string): boolean {
    return this.replicaStateStore.isAvailable();
  }

  /**
   * Hand an agent operation to the replica that owns the agent's machine
   * socket. Returns null when it runs here: the machine socket is here (or
   * this replica is the registered owner while its registration completes),
   * the agent has no machine, or -- the fallbacks -- no owner is known, the
   * owner cannot answer intents, or the agent could not be loaded. Every
   * decision is recorded as `server.agent.owner_route`.
   */
  protected async runOnOwner(agentId: string, intent: OwnerIntent): Promise<StartIntentResult | null> {
    const decide = (route: OwnerRouteDecision, attrs: Record<string, unknown> = {}): null => {
      this.recordOwnerRoute(agentId, intent.kind, route, attrs);
      return null;
    };
    if (!this.replicaStateStore.isAvailable()) return decide("no_replica_state");
    // The owner refuses before running anything when its socket moved or the
    // agent no longer runs on that machine, so one more lookup cannot run the
    // operation twice.
    for (let attempt = 0; ; attempt += 1) {
      let agent: Awaited<ReturnType<AgentOrchestrator["loadAgentForStart"]>>;
      try {
        agent = await this.loadAgentForStart(agentId);
      } catch (error) {
        return decide("lookup_failed", { error_class: errorClassOf(error) });
      }
      const machineId = agent?.machineId;
      if (!agent || !machineId) return decide("no_machine");
      if (this.hasMachineLocally(machineId)) return decide("local_machine");
      const owner = await this.replicaStateStore.getMachineReplicaOwner(machineId);
      if (!owner) return decide("no_owner");
      // Registered here but not yet routable (registration in progress): the
      // local send reaches the socket, so this is the normal path.
      if (owner === REPLICA_ID) return decide("self_owner");
      if (!await this.ownerAcceptsIntents(owner)) return decide("owner_without_intents");
      try {
        const result = await this.routeIntentToOwner(owner, { requestId: crypto.randomUUID(), machineId, agentId, intent });
        this.recordOwnerRoute(agentId, intent.kind, "routed", { attempt });
        return result;
      } catch (error) {
        if (attempt === 0 && isStartIntentOwnerMoved(error)) continue;
        this.recordOwnerRoute(agentId, intent.kind, "route_failed", { attempt, error_class: errorClassOf(error) });
        throw rehydrateStartIntentError(error);
      }
    }
  }

  private recordOwnerRoute(
    agentId: string,
    intentKind: OwnerIntent["kind"],
    route: OwnerRouteDecision,
    attrs: Record<string, unknown> = {},
  ): void {
    this.recordEvent("server.agent.owner_route", {
      agent_id: agentId,
      intent_kind: intentKind,
      route,
      fallback: OWNER_ROUTE_FALLBACKS.has(route),
      ...attrs,
    });
  }

  /**
   * A runtime's RFC 060 OAR flag, per server, default off, riding only the
   * agent:start config. Evaluated at every agent start; any evaluation
   * failure keeps it off. (The server features flags are read by
   * evaluateAgentServerFeatures.)
   */
  protected async startConfigFlagEnabled(
    key: AgentRuntimeOarFeatureFlagKey,
    serverId: string | null | undefined,
  ): Promise<boolean> {
    if (!serverId) return false;
    try {
      return (await evaluateFeatureFlag({ key, serverId })).enabled === true;
    } catch (error) {
      console.warn(`[AgentOrchestrator] ${key} evaluation failed; leaving it off`, error);
      return false;
    }
  }

  /**
   * The `AgentConfig` fields this Server's flags decide, the same for every
   * agent of it (shared `AGENT_SERVER_FEATURE_KEYS`), as `agent:start` sets
   * them: a boolean present only when on. Lenient: an evaluation group that
   * fails reads as off (each per-server flag, the Reminder app's install
   * check, the first-party apps), and the other groups still count. The same
   * evaluation as agentServerFeaturesStrict, so the two never drift.
   */
  protected async agentServerFeatures(serverId: string | null): Promise<AgentServerFeatures> {
    if (!serverId) return { enabledApps: [] };
    return this.evaluateAgentServerFeatures(serverId, "off");
  }

  /**
   * agentServerFeatures for `server:features:request`, without its failure
   * fallbacks: any evaluation failure throws, so the request is answered with
   * nothing (the daemon keeps its values) instead of "all off", which would
   * restart every agent and tell it that its apps were turned off.
   */
  protected async agentServerFeaturesStrict(serverId: string): Promise<AgentServerFeatures> {
    return this.evaluateAgentServerFeatures(serverId, "throw");
  }

  /**
   * The one evaluation behind both: the per-server flags in one batch, then
   * the Reminder app's install check (the same gate as the legacy-write
   * refusal: the flag, or installed and migrated) and the first-party apps.
   * `onFailure` decides what a failed group gives: "throw", or "off" (logged).
   */
  private async evaluateAgentServerFeatures(serverId: string, onFailure: "throw" | "off"): Promise<AgentServerFeatures> {
    const group = async <T>(name: string, read: () => Promise<T>, off: T): Promise<T> => {
      if (onFailure === "throw") return read();
      try {
        return await read();
      } catch (error) {
        console.warn(`[AgentOrchestrator] ${name} evaluation failed; leaving it off`, error);
        return off;
      }
    };
    const keys = [
      SUBAGENT_DELEGATION_FEATURE_FLAG_KEY,
      PASSIVE_AX_FEATURE_FLAG_KEY,
      REMINDER_APP_FEATURE_FLAG_KEY,
      VAULT_APP_FEATURE_FLAG_KEY,
      PI_SESSION_ROTATION_FEATURE_FLAG_KEY,
      // Wake recycle on the OAR host (#proj-runtime:#54): resume facts from the session summary, and its cold-idle stop.
      WAKE_RECYCLE_OAR_FEATURE_FLAG_KEY,
      // Wake recycle gated on the cache tier the session last wrote (#proj-runtime:#54 phase 2).
      WAKE_RECYCLE_TIER_GATE_FEATURE_FLAG_KEY,
      // Native compaction at a turn end past a size threshold (#proj-runtime:#54 phase 3).
      TURN_END_COMPACTION_FEATURE_FLAG_KEY,
      // Warm wake recycle: a large session is stopped at a clean turn end and starts fresh (#proj-runtime:#54, RFC 070 §6.5).
      WAKE_RECYCLE_WARM_FEATURE_FLAG_KEY,
      // Task v2: the prompt teaches task conversations (`raft task reply`, refs).
      TASK_V2_CONVERSATIONS_FEATURE_FLAG_KEY,
      // View Context: the daemon keeps its send index and answers view requests.
      AGENT_CONTEXT_VIEW_FEATURE_FLAG_KEY,
      // RFC 081: the wake-up and the prompt teach `raft inbox read` only where the server answers it.
      AGENT_INBOX_ITEMS_FEATURE_FLAG_KEY,
    ] as const;
    const readFlags = async (batch: readonly (typeof keys)[number][]) => {
      const answers = await evaluateFeatureFlags(batch.map((key) => ({ key, serverId })));
      return batch.filter((_, index) => answers[index]?.enabled === true);
    };
    let on: Set<string>;
    try {
      on = new Set<string>(await readFlags(keys));
    } catch (error) {
      if (onFailure === "throw") throw error;
      // A failure may belong to one flag's rules (an audience, a lab, a
      // plan): read each flag on its own, so only the failing one reads as
      // off and the others keep agent:start's prompt paired with the gates
      // that read them (reminderAppGate, taskConversationsGate).
      console.warn("[AgentOrchestrator] server feature flags batch evaluation failed; reading each flag on its own", error);
      on = new Set<string>();
      for (const key of keys) {
        if ((await group(key, () => readFlags([key]), [])).length > 0) on.add(key);
      }
    }
    const reminderApp = await group(
      "Reminder app install",
      () => reminderAppActiveForServerStrict(serverId, on.has(REMINDER_APP_FEATURE_FLAG_KEY)),
      false,
    );
    // First-party apps on for this server (their registry ids), always sent
    // (empty: none on), so a current daemon can tell it from an older
    // server's absent field. The Reminder and Vault apps stay on their
    // booleans, which older daemons read.
    const enabledApps = await group("first-party app flags", () => enabledFirstPartyAppIdsStrict(serverId), [] as string[]);
    const features: AgentServerFeatures = {};
    if (on.has(SUBAGENT_DELEGATION_FEATURE_FLAG_KEY)) features.subagentDelegation = true;
    if (on.has(PASSIVE_AX_FEATURE_FLAG_KEY)) features.passiveAx = true;
    if (reminderApp) features.reminderApp = true;
    if (on.has(VAULT_APP_FEATURE_FLAG_KEY)) features.vaultApp = true;
    if (on.has(PI_SESSION_ROTATION_FEATURE_FLAG_KEY)) features.piSessionRotation = true;
    if (on.has(WAKE_RECYCLE_OAR_FEATURE_FLAG_KEY)) features.wakeRecycleOar = true;
    if (on.has(WAKE_RECYCLE_TIER_GATE_FEATURE_FLAG_KEY)) features.wakeRecycleTierGate = true;
    if (on.has(TURN_END_COMPACTION_FEATURE_FLAG_KEY)) features.turnEndCompaction = true;
    if (on.has(WAKE_RECYCLE_WARM_FEATURE_FLAG_KEY)) features.wakeRecycleWarm = true;
    if (on.has(TASK_V2_CONVERSATIONS_FEATURE_FLAG_KEY)) features.taskConversations = true;
    if (on.has(AGENT_CONTEXT_VIEW_FEATURE_FLAG_KEY)) features.agentContextView = true;
    // RFC 081: the flag and a launch time (RAFT_INBOX_ITEMS_LAUNCH_AT), the same switch the inbox routes answer by.
    // The launch time rides beside it (only then), so the daemon can tell reminders fired after launch (D9, D16).
    const inboxItemsLaunchAt = inboxItemsOnWith(on.has(AGENT_INBOX_ITEMS_FEATURE_FLAG_KEY)) ? inboxItemsLaunch()?.at.toISOString() : undefined;
    if (inboxItemsLaunchAt !== undefined) {
      features.inboxItems = true;
      features.inboxItemsLaunchAt = inboxItemsLaunchAt;
    }
    features.enabledApps = enabledApps;
    return features;
  }

  /**
   * RFC 060: whether this start asks the daemon for its OAR host. Only a
   * daemon that advertised `runtime-host:oar` on this connection reads
   * `runtimeHost`; an older Computer never advertised it and keeps its
   * drivers whatever the flag says (no version comparison: the capability is
   * the contract). Then the runtime's own flag, per server, default off
   * (Codex has none: `runtime-host:oar:codex` decides); the server kill switch
   * turns every runtime off.
   */
  protected async agentRuntimeOarRequested(
    machineId: string | null | undefined,
    serverId: string | null | undefined,
    runtime: string | null | undefined,
  ): Promise<boolean> {
    if (!this.hasMachineCapability(machineId, DAEMON_CAPABILITY_RUNTIME_HOST_OAR)) return false;
    // No legacy driver to choose instead: its flag admitted it at create/switch.
    if (isOarOnlyRuntime(runtime)) return true;
    if (agentRuntimeOarDisabled()) return false;
    // Codex: no flag (retired, #raft-architecture:#32). Earlier Computers
    // advertise the OAR host with an unfinished Codex launch, so the
    // capability alone decides.
    if (runtime === "codex") return this.hasMachineCapability(machineId, DAEMON_CAPABILITY_RUNTIME_HOST_OAR_CODEX);
    const key = agentRuntimeOarFeatureFlagKey(runtime);
    if (!key) return false;
    // Earlier Computers carry a Grok launch without the fixes it needs by default (#oar-raft:#4).
    if (runtime === "grok" && !this.hasMachineCapability(machineId, DAEMON_CAPABILITY_RUNTIME_HOST_OAR_GROK)) return false;
    // #oar-raft:#10: only a Computer that can load the Cursor SDK (Linux, non-SEA) runs Cursor on OAR.
    if (runtime === "cursor" && !this.hasMachineCapability(machineId, DAEMON_CAPABILITY_RUNTIME_HOST_OAR_CURSOR)) return false;
    return this.startConfigFlagEnabled(key, serverId);
  }

  /**
   * Agent typing line (`agent:send_intent`). Same ownership and launch checks
   * as the other per-agent frames; the registry then resolves the target
   * read-only and emits to the conversation room.
   */
  private async handleAgentSendIntent(machineId: string, serverId: string | null, msg: unknown): Promise<AgentSendIntentOutcome | "invalid_frame" | "invalid_agent" | "stale_launch" | "failed"> {
    const frame = parseAgentSendIntentFrame(msg);
    if (!frame) return "invalid_frame";
    const agent = await this.validateMachineAgentMessage(machineId, serverId, frame.agentId, "agent:send_intent");
    if (!agent || !agent.machineId) return "invalid_agent";
    if (this.getLifecycleEventAcceptanceAction(agent, frame.launchId) !== "accept") return "stale_launch";
    try {
      return await this.agentTyping.handle({ id: agent.id, serverId: agent.serverId, machineId: agent.machineId }, frame);
    } catch (err) {
      console.warn(`[Machine ${machineId}] agent:send_intent for ${frame.agentId} failed`, err);
      return "failed";
    }
  }

  /**
   * Agent typing line: the agent's message landed (the agent send route).
   * The call that posted it is usually still running (`send … && raft task
   * update …`) and its daemon keeps refreshing `start`; close the agent's
   * lines into that conversation and mark their calls ended, here and on the
   * replica holding the agent's machine socket. A thread is matched by its
   * root message. Never throws.
   */
  async endAgentTypingForPostedMessage(input: {
    agentId: string;
    serverId: string;
    channelId: string;
    channelType: string;
    target?: string;
  }): Promise<void> {
    try {
      let signal: AgentTypingPostedSignal;
      if (input.channelType === "thread" || input.channelType === "task") {
        const thread = await channelService.getChannel(input.channelId);
        if (thread?.type === "task") {
          // Task v2: the line is keyed by the task conversation itself (its
          // own room), whatever type the posting surface reported.
          signal = { agentId: input.agentId, channelId: thread.id, parentMessageId: null };
        } else {
          if (!thread?.parentMessageId) return;
          signal = { agentId: input.agentId, channelId: thread.parentChannelId ?? null, parentMessageId: thread.parentMessageId };
        }
      } else {
        signal = { agentId: input.agentId, channelId: input.channelId, parentMessageId: null };
      }
      if (input.target !== undefined) signal.target = input.target;
      this.handleRoutedAgentTypingPosted(signal);
      // Typing state lives on the replica holding the agent's machine socket:
      // tell that one only (no-op when it's this replica).
      const machineId = (await this.getCachedAgent(input.agentId))?.machineId ?? null;
      await publishAgentTypingPosted(signal, machineId);
    } catch (err) {
      console.warn(`[AgentOrchestrator] agent typing end for ${input.agentId}'s message failed`, err);
    }
  }

  /** Agent typing line: an agent's message landed (this replica's send, or another's via Redis). */
  handleRoutedAgentTypingPosted(signal: AgentTypingPostedSignal): void {
    const conversation = signal.parentMessageId !== null
      ? { channelId: signal.channelId, parentMessageId: signal.parentMessageId }
      : signal.channelId !== null
        ? { channelId: signal.channelId, parentMessageId: null }
        : null;
    if (!conversation) return;
    this.agentTyping.endForPostedMessage(signal.agentId, conversation, signal.target);
  }

  /**
   * Test seam: the read-only target resolution of the typing line. A task v2
   * ref (`raft task reply "#chan:#7"`) resolves to the task's conversation;
   * anything else is a message target.
   */
  protected async previewAgentTypingTarget(serverId: string, agentId: string, target: string): Promise<AgentTypingTargetPreview | null> {
    return await previewAgentTaskReplyTarget(serverId, agentId, target)
      ?? await previewAgentPostTarget(serverId, agentId, target);
  }

  /** The conversation room only; never `server:<id>` (the server room carries no targets). */
  protected emitAgentTyping(room: string, event: string, payload: unknown): void {
    this.io?.to(room).emit(event, payload);
  }

  protected ownerAcceptsIntents(replicaId: string): Promise<boolean> {
    return replicaSupportsOwnerIntents(replicaId);
  }

  protected routeIntentToOwner(ownerReplicaId: string, request: StartIntentRequest): Promise<StartIntentResult> {
    return routeStartIntent(ownerReplicaId, request);
  }

  /**
   * Run an operation another replica routed here. Only the replica that still
   * holds the machine's socket, for the machine the agent is on now, may run
   * it; otherwise the requester is told the owner moved and looks again.
   */
  async handleStartIntent(request: StartIntentRequest): Promise<StartIntentResult> {
    if (!this.hasMachineLocally(request.machineId)) {
      throw new StartIntentOwnerMovedError();
    }
    // A requester with a stale cache can route by the agent's previous
    // machine. Running it here would dispatch to the new machine from a
    // replica that does not hold its socket, which is what routing avoids.
    const agent = await this.loadAgentForStart(request.agentId);
    if (agent && agent.machineId !== request.machineId) {
      throw new StartIntentOwnerMovedError();
    }
    const { intent } = request;
    switch (intent.kind) {
      case "start":
        return this.startAgentHere(request.agentId, intent.options);
      case "stop":
        await this.stopAgentHere(request.agentId, intent.reason, intent.daemonReason);
        return { outcome: "done" };
      case "reset":
        await this.resetAgentHere(request.agentId, intent.mode, intent.options);
        return { outcome: "done" };
      case "config":
        return { outcome: "config", pushed: await this.applyAgentConfigHere(request.agentId) === "pushed" };
    }
  }

  /**
   * The one entry every start on this replica goes through (direct starts and
   * owner intents alike): at most one start per agent is in flight here, from
   * the moment a start begins until its ack settles it. Two starts for the
   * same agent a few ms apart (e.g. two rejected deliveries both converted to
   * a wake, or a ready reconcile wake racing them) each create a launch; the
   * daemon runs whichever arrives first while the server keeps the one acked
   * last, and every frame of the running launch is then dropped as stale for
   * hours. The later start is skipped like a held wake lock: its caller
   * re-tracks the delivery, and the start already in flight carries it. The
   * Redis wake lock stays the cross-replica guard; this check also holds when
   * that lock is released early (an exit status of the previous process
   * releases it) or Redis is unavailable.
   */
  protected async startAgentHere(agentId: string, options: StartAgentOptions = {}): Promise<AgentStartDispatchResult> {
    if (this.startsInProgress.has(agentId) || this.hasPendingAgentStartForAgent(agentId)) {
      this.recordLifecycleEvent({
        agentId,
        machineId: null,
        action: "start",
        outcome: "skipped",
        cause: lifecycleStartCause(options),
        detail: "start_in_flight",
      });
      console.log(`[Agent ${agentId}] Start skipped: a start for this agent is already in flight on this replica`);
      if (options.requireQueueReceipt) {
        throw new CrossReplicaQueueReceiptUnavailableError();
      }
      // Same contract as a held wake lock: another start is bringing the agent up.
      return { outcome: "skipped", reason: "wake_lock_held" };
    }
    this.startsInProgress.add(agentId);
    try {
      return await this.startAgentHereUnguarded(agentId, options);
    } finally {
      this.startsInProgress.delete(agentId);
    }
  }

  /**
   * Reconciler step 11b: the `AgentConfig` the agent runs on, from the
   * database, as both `agent:start` and `agent:config` send it. Reads only:
   * no cache write, wake lock or catalog authority (the start takes those).
   */
  protected async buildAgentConfig(agent: PersistedAgentRow): Promise<AgentConfig> {
    const normalizedRuntimeConfig = hydrateRuntimeConfig(agent);
    const launchRuntimeFields = runtimeConfigToLaunchFields(normalizedRuntimeConfig);
    const machine = agent.machineId ? await this.loadRuntimeContextMachine(asMachineId(agent.machineId)) : null;
    const daemonVersion = agent.machineId ? this.getMachineDaemonVersion(agent.machineId) : null;
    const config: AgentConfig = {
      name: agent.name,
      displayName: agent.displayName,
      description: agent.description,
      model: launchRuntimeFields.model,
      runtime: launchRuntimeFields.runtime,
      // As it launches: a daemon derives launch flags from this with its own
      // bundled rules, so a model that no longer runs fast is sent without fast
      // mode for daemons that predate that rule.
      runtimeConfig: runtimeConfigForLaunch(normalizedRuntimeConfig),
      reasoningEffort: launchRuntimeFields.reasoningEffort,
      executionMode: agent.executionMode,
      envVars: launchRuntimeFields.envVars,
      sessionId: agent.sessionId,
      serverUrl: process.env.SERVER_URL || `http://localhost:${process.env.PORT || 3001}`,
      authToken: "", // Current daemons ignore it: the Computer mints a runner credential per launch
      // RFC 070 constructed wake context is always on (the
      // `constructed_wake_context` flag was retired on 2026-10-23). Current
      // daemons ignore this field; it is sent only for older daemons, which
      // treat absent or false as off.
      constructedWakeContext: true,
      runtimeContext: {
        agentId: agent.id,
        serverId: agent.serverId,
        machineId: agent.machineId,
        machineName: machine?.name ?? null,
        machineDescription: machine?.description ?? null,
        machineHostname: machine?.hostname ?? null,
        machineOs: machine?.os ?? null,
        daemonVersion,
        workspacePath: null,
      },
    };
    const runtimeProfileControl = await agentRuntimeProfileService.getPendingRuntimeProfileControl(agent.id);
    if (runtimeProfileControl) {
      config.runtimeProfileControl = runtimeProfileControl;
    }
    // The Server's flag-derived fields, the same ones `server:features` answers.
    Object.assign(config, await this.agentServerFeatures(agent.serverId));
    // RFC 060: run this launch on the daemon's OAR host (capable daemons only, per-runtime flag).
    if (await this.agentRuntimeOarRequested(agent.machineId, agent.serverId, launchRuntimeFields.runtime)) {
      config.runtimeHost = "oar";
    }

    // task #319 — installed-app catalog rides agent:start config (server-level
    // data, identical for all agents on this server). A catalog failure must
    // never block or break agent start; the daemon degrades to no section.
    try {
      const installedApps = await oauthService.listInstalledAppPromptCatalog(agent.serverId);
      if (installedApps.length > 0) {
        config.installedApps = installedApps;
      }
    } catch (err) {
      this.tracer.emitEvent("server.agent.installed_app_catalog_failed", {
        surface: "server",
        attrs: {
          agent_id: agent.id,
          server_id: agent.serverId,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }

    // How close the workspace is to a migration's size limits, for the
    // daemon's .raftbackupignore reminder. Not in the runtime spec, so it never
    // restarts the agent. Like the catalog, a failure never blocks a start:
    // the field is left out.
    try {
      config.migrationReadiness = await loadAgentMigrationReadiness(agent.id);
    } catch (err) {
      this.tracer.emitEvent("server.agent.migration_readiness_failed", {
        surface: "server",
        attrs: {
          agent_id: agent.id,
          server_id: agent.serverId,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }

    // The parts of the launch the daemon's runtime spec compares but cannot
    // see in the config (its managed MCP servers, its provider connection's
    // key and endpoint). Like the catalog above, a failure never blocks a
    // start: the field is left out, which the daemon reads as no change.
    try {
      Object.assign(config, await agentConfigRevisionInputs(agent.serverId, agent.id));
    } catch (err) {
      console.warn(`[Agent ${agent.id}] Config revision inputs unavailable; leaving them out:`, err instanceof Error ? err.message : err);
    }
    return config;
  }

  private async startAgentHereUnguarded(agentId: string, options: StartAgentOptions = {}): Promise<AgentStartDispatchResult> {
    const { resumePrompt, wakeMessageTransient } = options;
    let { wakeMessage } = options;
    // Load from DB (and populate cache) for start — need full state
    const agent = await this.loadAgentForStart(agentId);
    const startCause = lifecycleStartCause(options);
    if (!agent) {
      this.recordLifecycleEvent({
        agentId,
        machineId: null,
        action: "start",
        outcome: "failed",
        cause: startCause,
        detail: "agent_not_found",
      });
      throw new Error(`Agent ${agentId} not found`);
    }
    const previousStatus = narrowPersistedAgentStatus(agent.status);
    if (!previousStatus) {
      console.warn(
        `[Agent ${agentId}] Invalid persisted agent status ${JSON.stringify(agent.status)} before start; failing closed`,
      );
    }
    // A manual stop is the one truly offline state: neither a message wake, a
    // daemon app-inbox wake (task #1103), the start-failure retry, the
    // spawn-error retry sweep (task #365) nor a `ready` owed wake (F9) may
    // undo it; only a manual start does.
    if ((wakeMessage || options.startCause === "app_inbox_wake" || options.startCause === "start_failure_retry" || options.startCause === "internal" || options.startCause === "ready_owed") && previousStatus === "stopped") {
      this.updateCache(agentId, { status: "stopped" });
      this.recordLifecycleEvent({
        agentId,
        machineId: agent.machineId,
        action: "wake",
        outcome: "suppressed",
        cause: startCause,
        previousStatus,
      });
      return { outcome: "skipped", reason: "manual_stop" };
    }
    // Reconciler step 15 (B15): the Computer's access was revoked: no start
    // or wake, a manual one included, can reach it. Refused before the
    // breakers so none of this is counted as a crash or a failed start; a
    // wake message stays in the durable inbox, as for a manual stop.
    if (agent.machineId && await this.isMachineAccessRevoked(agent.machineId)) {
      this.recordLifecycleEvent({
        agentId,
        machineId: agent.machineId,
        action: "wake",
        outcome: "suppressed",
        cause: startCause,
        previousStatus,
        detail: "computer_access_revoked",
      });
      this.recordEvent("server.agent.wake.suppressed", {
        agent_id: agentId,
        machine_id: agent.machineId,
        start_cause: startCause,
        reason: "computer_access_revoked",
      });
      return { outcome: "skipped", reason: "computer_access_revoked" };
    }
    // Below the Computer version floor past its deadline: no agent runs on
    // this machine, not even on a manual start, until it is upgraded. A wake
    // message stays in the durable inbox, as for a manual stop.
    if (agent.machineId && await this.isMachineAgentWorkHeld(agent.machineId)) {
      this.recordLifecycleEvent({
        agentId,
        machineId: agent.machineId,
        action: "wake",
        outcome: "suppressed",
        cause: startCause,
        previousStatus,
        detail: "computer_version_unsupported",
      });
      return { outcome: "skipped", reason: "computer_version_unsupported" };
    }
    // task #1119: after consecutive early exits, automatic wakes (message,
    // app-inbox, rejected-delivery conversion) are paused for the episode;
    // so are they after a start failure retrying cannot fix or too many failed
    // starts in a row, and for the wait before a retry-once retry. A human
    // start/resume always passes and opens a new episode below.
    const humanStart = startCause === "manual" || startCause === "resume";
    const wakeHold = humanStart ? null : await this.wakeCrashLoopBreaker.automaticWakeHold(agentId, this.clock.now());
    if (wakeHold) {
      this.recordLifecycleEvent({
        agentId,
        machineId: agent.machineId,
        action: "wake",
        outcome: "suppressed",
        cause: startCause,
        previousStatus,
        detail: wakeHold.kind === "retry_pending" ? "start_failure_retry_pending" : "wake_crash_loop_blocked",
      });
      return { outcome: "skipped", reason: "wake_crash_loop_blocked" };
    }
    // RFC 071 §4.3/§5: the terminal-failure breaker gates every start that is
    // not an explicit human control (the #1119 inference above is not used:
    // tracked mentions, migrations and auto-starts reach "manual" there, F2).
    // The gate only reads (and records what a refusal learned); the claim
    // below decides. Gate order (RFC 7): manual stop, #1119, then this.
    const terminalControl: TerminalStartControl = options.control === "human_start" ? "human_start" : "automatic";
    const terminalContext = this.terminalStartContext(agentId, agent.machineId);
    if (terminalControl === "automatic") {
      // task #365: a refused message or app-inbox wake is not retried by
      // anyone else; the refusal records it as demand for the retry sweep.
      const wakeDemand = startCause === "message" || startCause === "app_inbox_wake";
      const refusal = await this.terminalStartGate(agentId, terminalContext, wakeMessage, wakeDemand).catch((error: unknown) => {
        this.recordLifecycleEvent({
          agentId,
          machineId: agent.machineId,
          action: "start",
          outcome: "failed",
          cause: startCause,
          previousStatus,
          detail: "terminal_failure_breaker_storage_unavailable",
        });
        throw new TerminalBreakerStorageUnavailableError(error);
      });
      if (refusal) {
        this.recordTerminalWakeSuppressed(agentId, agent.machineId, startCause, previousStatus, refusal, terminalContext);
        await this.projectTerminalBlock(agentId, { includeNeedsManual: true });
        return { outcome: "skipped", reason: refusal };
      }
    }
    const rollbackStatus = previousStatus ?? "inactive";

    if (isExternalAgentRuntime(agent.runtime)) {
      this.recordLifecycleEvent({
        agentId,
        machineId: agent.machineId,
        action: "start",
        outcome: "failed",
        cause: startCause,
        previousStatus,
        detail: "external_agent_not_startable",
      });
      throw new Error("External agents are operator-run; Slock never starts or manages their runtime (SHA-V0-006C).");
    }

    if (!agent.machineId) {
      this.recordLifecycleEvent({
        agentId,
        machineId: null,
        action: "start",
        outcome: "failed",
        cause: startCause,
        previousStatus,
        detail: "machine_unassigned",
      });
      throw new Error("No machine assigned. Please assign a machine to this agent first.");
    }

    const normalizedRuntimeConfig = hydrateRuntimeConfig(agent);
    const launchRuntimeFields = runtimeConfigToLaunchFields(normalizedRuntimeConfig);
    if (launchRuntimeFields.runtime === "kimi-sdk" && launchRuntimeFields.reasoningEffort !== null) {
      const detected = await this.detectMachineRuntimeModels(agent.machineId, "kimi-sdk");
      const selectedModel = detected.kind === "live"
        ? detected.value.models.find((candidate) => candidate.id === launchRuntimeFields.model)
        : undefined;
      if (
        detected.kind === "live"
        && !selectedModel?.supportedReasoningEfforts?.includes(launchRuntimeFields.reasoningEffort)
      ) {
        this.recordLifecycleEvent({
          agentId,
          machineId: agent.machineId,
          action: "start",
          outcome: "failed",
          cause: startCause,
          previousStatus,
          detail: "kimi_reasoning_effort_upgrade_required",
        });
        throw new KimiReasoningEffortUpgradeRequiredError();
      }
    }

    // Catalog detect is diagnostic, not a delivery gate: the catch below swallows every
    // BuiltInModelCatalogError -- all four codes of BuiltInModelCatalogErrorCode -- and continues
    // the spawn, so the runtime reports the real start failure instead of the preflight guessing at
    // one. Continuing here does not promise the model resolves or runs.
    //
    // The write paths are narrower: validateBuiltInPresetForWrite in routes/agents.ts demotes only
    // builtin_model_unsupported_by_target; the other codes still reject there.
    let catalogValidation: Awaited<
      ReturnType<AgentOrchestrator["validateBuiltInPresetForMachine"]>
    > = null;
    try {
      catalogValidation = await this.validateBuiltInPresetForMachine(
        agent.machineId,
        normalizedRuntimeConfig,
      );
    } catch (error) {
      if (error instanceof BuiltInModelCatalogError) {
        console.warn(
          `[Agent ${agentId}] Built-in catalog preflight ${error.code}; continuing spawn so runtime can fail the start: ${error.message}`,
        );
      } else {
        throw error;
      }
    }
    const releaseCatalogAuthority = catalogValidation
      ? this.acquireBuiltInCatalogAuthority(
          agent.machineId,
          catalogValidation.authority,
        )
      : () => undefined;

    try {
    let wakeLockHeld = false;
    if (this.replicaStateStore.isAvailable()) {
      wakeLockHeld = await this.replicaStateStore.acquireWakeLock(agentId);
      if (!wakeLockHeld) {
        this.recordLifecycleEvent({
          agentId,
          machineId: agent.machineId,
          action: "start",
          outcome: "skipped",
          cause: startCause,
          previousStatus,
          detail: "wake_lock_held",
        });
        console.log(`[Agent ${agentId}] Start skipped: wake lock held on another replica`);
        if (options.requireQueueReceipt) {
          throw new CrossReplicaQueueReceiptUnavailableError();
        }
        return { outcome: "skipped", reason: "wake_lock_held" };
      }
    }

    // The guard state this start found. It is carried into the refreshed
    // cache entry unchanged: prepareStartLaunchGuard() below decides whether
    // the new launch replaces it or the start drops to legacy, and a failed
    // send restores it (task #1129). Resetting it to legacy here would let a
    // failed dispatch accept frames from any launch.
    const launchGuardBeforeStart = this.snapshotLaunchGuard(agentId);
    // Populate/refresh cache
    const state: CachedAgentState = {
      id: agent.id,
      status: "active",
      machineId: agent.machineId,
      sessionId: agent.sessionId,
      expectedLaunchId: launchGuardBeforeStart.expectedLaunchId,
      launchGuardMode: launchGuardBeforeStart.launchGuardMode,
      serverId: agent.serverId,
      assistantOwnerUserId: agent.assistantOwnerUserId,
      name: agent.name,
      displayName: agent.displayName,
      description: agent.description,
      model: launchRuntimeFields.model,
      runtime: launchRuntimeFields.runtime,
      lastRuntimeError: agent.lastRuntimeError ?? null,
      runtimeConfig: normalizedRuntimeConfig,
      runtimeState: "starting",
      reasoningEffort: launchRuntimeFields.reasoningEffort,
      envVars: launchRuntimeFields.envVars,
    };
    this.agentStateCache.set(agentId, state);

    const config = await this.buildAgentConfig(agent);

    // RFC 071 §4.3: whether this start goes through the terminal claim. Always
    // false while RUNTIME_OUTCOME_ACK_ENABLED is false (no store read).
    const claimTerminal = await this.usesTerminalClaim(agentId, terminalContext, terminalControl).catch((error: unknown) => {
      this.updateCache(agentId, { status: rollbackStatus });
      if (wakeLockHeld) this.releaseWakeLock(agentId);
      throw new TerminalBreakerStorageUnavailableError(error);
    });
    // RFC 071 §6: a claimed start carries the next batch of the terminal
    // breaker's catch-up obligation. Null on every unclaimed start, so the
    // catch-up below is exactly today's.
    const terminalObligation = claimTerminal ? await this.readTerminalCatchupObligation(agentId) : null;

    // Query unread rows so resume can deterministically re-drive durable
    // messages that arrived while a manual-stopped/sessioned agent was offline.
    let unreadSummary: Record<string, number> | undefined;
    let unreadSnapshot: UnreadSummarySnapshotTargets = new Map();
    let resumeMessages: AgentMessage[] | undefined;
    // RFC 071 §6: the obligation batch's inputs (only with `terminalObligation`).
    let obligationBatch: messageService.AgentResumeCatchupResult["obligationBatch"];
    let foldedWakeAppended = false;
    // task #358: set when the catch-up ran but could not read the inbox.
    let catchupUnverified = false;
    // task #1221: messages refused as wakes during a start-failure block are
    // owed to the start that follows it, whether or not the agent has a session
    // (a fresh session has no history to resume, so without this they would
    // only surface if the agent read its inbox itself).
    const catchupOwed = await this.wakeCrashLoopBreaker.isCatchupOwed(agentId);
    // RFC 071 §6: every start while a terminal obligation exists builds the
    // catch-up from the durable chain, even with no session, and folds a wake.
    const catchupReplacesWake = (catchupOwed || terminalObligation !== null) && wakeMessage !== undefined && !wakeMessageTransient;
    // F9: a `ready` owed wake carries no wake message; the catch-up is what it
    // owes, so it is built with or without a session.
    if (agent.sessionId || catchupOwed || terminalObligation !== null || options.startCause === "ready_owed") {
      const span = this.tracer.startSpan("server.agent.resume_catchup.prepare", {
        surface: "server",
        kind: "internal",
        attrs: {
          agent_id: agentId,
          machine_id: agent.machineId,
          server_id: agent.serverId,
          session_id: agent.sessionId,
          agent_id_present: Boolean(agentId),
          machine_id_present: Boolean(agent.machineId),
          session_id_present: Boolean(agent.sessionId),
          start_cause: startCause,
          wake_message_present: Boolean(wakeMessage),
          resume_prompt_present: Boolean(resumePrompt),
        },
      });
      try {
        // One read of the unified chain feeds both the summary and the catch-up.
        // It is the only recovery source: when it is unavailable the resume
        // carries no summary or catch-up, and the start proceeds (live delivery
        // is unaffected).
        const inbox = await this.selectResumeInbox(agentId);
        if (inbox.source === "unavailable") {
          catchupUnverified = true;
          span.addEvent("resume_catchup.skipped", {
            outcome: "inbox_unavailable",
            reason: inbox.reason,
          });
          span.end("ok", { attrs: { outcome: "skipped", reason: "inbox_unavailable" } });
        } else {
          const chain = inbox.rows;
          span.addEvent("resume_catchup.inbox_source", {
            source: inbox.source,
            reason: "chain",
            chain_row_count: chain.length,
          });
          const plan = await getServerPlan(agent.serverId);
          const historyCutoff = getHistoryCutoff(plan);
          const dmRefs = await channelService.resolveAgentInboxDmRefs(agentId, chain);
          const counts = await channelService.getAgentUnreadCounts(agentId, chain, dmRefs);
          if (Object.keys(counts).length > 0) {
            unreadSummary = channelService.capAgentUnreadSummary(counts);
            unreadSnapshot = snapshotForUnreadSummary(await channelService.getAgentUnreadSummaryTargets(agentId, chain, dmRefs), unreadSummary);
          }
          if ((!wakeMessage || catchupReplacesWake) && !resumePrompt) {
            const catchup = await messageService.getAgentResumeCatchupMessages(
              agentId,
              historyCutoff,
              terminalObligation ? { chain, obligation: terminalObligation } : { chain },
            );
            obligationBatch = catchup.obligationBatch;
            // task #1221: the owed catch-up has nothing left unread (read
            // since): it is settled, not owed to a later start.
            if (catchupOwed && catchup.messages.length === 0) {
              await this.wakeCrashLoopBreaker.clearCatchupOwedNothingUnread(agentId).catch((err: unknown) => {
                console.warn(`[Agent ${agentId}] owed catch-up with nothing unread not cleared: ${err instanceof Error ? err.message : String(err)}`);
              });
              span.addEvent("resume_catchup.owed_settled", { outcome: "nothing_unread", reason: "nothing_unread" });
            }
            if (catchup.messages.length > 0) {
              resumeMessages = catchup.messages;
              // The daemon ignores resumeMessages when a wake message is present,
              // so the catch-up replaces the wake. The catch-up is bounded; if it
              // left the wake message out, append it so it is never dropped.
              if (catchupReplacesWake && wakeMessage) {
                const wake = wakeMessage;
                if (!catchup.messages.some((m) => m.message_id === wake.message_id)) {
                  resumeMessages = [...catchup.messages, wake];
                  foldedWakeAppended = true;
                }
                wakeMessage = undefined;
              }
            }
            span.addEvent("resume_catchup.selected", {
              outcome: catchup.messages.length > 0
                ? "messages_selected"
                : Object.keys(counts).length > 0
                  ? "summary_only"
                  : "none",
              reason: catchup.messages.length > 0
                ? "messages_selected"
                : Object.keys(counts).length > 0
                  ? "unread_summary_only"
                  : "no_unread",
              unread_channel_count: Object.keys(counts).length,
              candidate_channel_count: catchup.candidateChannelCount,
              resume_message_count: catchup.messages.length,
              resume_max_seq_present: catchup.maxSeq != null,
            });
          } else {
            span.addEvent("resume_catchup.skipped", {
              outcome: wakeMessage ? "wake_message_present" : "resume_prompt_present",
              reason: wakeMessage ? "wake_message_present" : "resume_prompt_present",
              unread_channel_count: Object.keys(counts).length,
            });
          }
          span.end("ok", { attrs: { outcome: "prepared", reason: "resume_catchup_checked" } });
        }
      } catch (err) {
        catchupUnverified = true;
        span.addEvent("resume_catchup.failed", {
          outcome: "failed",
          reason: "query_failed",
          error_type: errorClassOf(err),
        });
        span.end("error", {
          attrs: {
            outcome: "failed",
            reason: "query_failed",
            error_class: errorClassOf(err),
          },
        });
      }
    }

    // Only set launch guard if the daemon supports it (>= 0.30.1).
    // Old daemons ignore the launchId field and never echo it back,
    // which causes all their lifecycle events to be silently dropped.
    // RFC 071 §4.3: the launchId is minted first, the breakers are claimed,
    // and only then is the guard armed, so a start that loses the claim has
    // touched nothing shared.
    const launchId = await this.planStartLaunchId(agent.machineId);
    let terminalClaim: Extract<CombinedClaimResult, { ok: true }> | null = null;
    if (claimTerminal) {
      const claimed = await this.claimTerminalStart(agentId, {
        launchId,
        sessionId: agent.sessionId ?? null,
        context: terminalContext,
        control: terminalControl,
        human: humanStart,
        // task #365: an admitted wake is demand as well as a refused one.
        wakeDemand: startCause === "message" || startCause === "app_inbox_wake",
      }).catch((error: unknown) => {
        // RFC 071 storage: a start whose pending entry cannot be recorded is
        // not dispatched (RFC 4.3 rule 1), human or automatic. Same cleanup as
        // a failed dispatch; nothing shared was written.
        this.updateCache(agentId, { status: rollbackStatus });
        if (wakeLockHeld) this.releaseWakeLock(agentId);
        this.recordLifecycleEvent({
          agentId,
          machineId: agent.machineId,
          action: "start",
          outcome: "failed",
          cause: startCause,
          previousStatus,
          detail: "terminal_failure_breaker_storage_unavailable",
        });
        throw new TerminalBreakerStorageUnavailableError(error);
      });
      if (!claimed.ok) {
        // A concurrent claimer won (or #1119 blocked in between): nothing was written.
        this.updateCache(agentId, { status: rollbackStatus });
        if (wakeLockHeld) this.releaseWakeLock(agentId);
        if (claimed.reason !== "wake_crash_loop_blocked" && (startCause === "message" || startCause === "app_inbox_wake")) {
          // task #365: the wake passed the gate but lost the claim (another
          // replica's probe won). Run the gate again so the refusal records
          // it as demand; if that probe never spawns, the sweep re-serves it.
          await this.terminalStartGate(agentId, terminalContext, wakeMessage, true).catch((error: unknown) => {
            console.warn(`[Agent ${agentId}] wake demand after a lost claim not recorded: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
        if (claimed.reason === "wake_crash_loop_blocked") {
          this.recordLifecycleEvent({
            agentId,
            machineId: agent.machineId,
            action: "wake",
            outcome: "suppressed",
            cause: startCause,
            previousStatus,
            detail: "wake_crash_loop_blocked",
          });
        } else {
          this.recordTerminalWakeSuppressed(agentId, agent.machineId, startCause, previousStatus, claimed.reason, terminalContext);
          await this.projectTerminalBlock(agentId, { includeNeedsManual: true });
        }
        return { outcome: "skipped", reason: claimed.reason };
      }
      terminalClaim = claimed;
    }
    this.armStartLaunchGuard(agentId, launchId);
    await this.stampRuntimeErrorRecoveryLaunch(agentId, launchId);
    const startDispatchId = crypto.randomUUID();
    // task #358: a caller's own resume prompt or a wake message already gives
    // the agent something true to act on. Otherwise, if the catch-up could not
    // be read, say so instead of letting the daemon report an empty resume.
    const startResumePrompt = resumePrompt
      ?? (catchupUnverified && agent.sessionId && !wakeMessage ? RESUME_CATCHUP_UNAVAILABLE_PROMPT : undefined);
    // RFC 071 §6/§7: the batch this start carries, recorded on the claimed
    // launch BEFORE dispatch so its echo can be matched. Only a start whose
    // input is the resume catch-up (no wake message, no resume prompt).
    // Every such build also settles the owed conversations the read cursor
    // has passed (RFC 6 "read cursor"), even when no row is left to render.
    const rendersCatchup = Boolean(resumeMessages && resumeMessages.length > 0 && !wakeMessage && !startResumePrompt);
    // RFC 071 F9: a daemon without DAEMON_CAPABILITY_CONTROL_START_CATCHUP_V1
    // renders only the release notice of a start that also carries
    // runtimeProfileControl, and drops the catch-up. When the catch-up is one
    // the server tracks (#1221 owed, or a terminal obligation), the control is
    // left off this start so the catch-up goes through: the notice stays
    // pending and comes with a later start. (The OAR host of such a daemon does
    // not even ack a notice that came with a start, so leaving it on would
    // drop the catch-up on every start.)
    const controlStartRendersCatchup = rendersCatchup && config.runtimeProfileControl
      ? await this.machineDeclaresCapabilityForStart(agent.machineId, DAEMON_CAPABILITY_CONTROL_START_CATCHUP_V1)
      : false;
    if (rendersCatchup && config.runtimeProfileControl && !controlStartRendersCatchup && (catchupOwed || terminalObligation !== null)) {
      delete config.runtimeProfileControl;
      this.recordEvent("server.agent.start.runtime_profile_control_deferred", { agent_id: agentId, reason: "daemon_without_control_start_catchup" });
    }
    const catchupBatchId = terminalClaim && terminalObligation && obligationBatch && launchId
      ? await this.recordTerminalCatchupBuild(agentId, launchId, terminalObligation, obligationBatch, rendersCatchup ? resumeMessages! : null, foldedWakeAppended)
      : null;
    const startDispatchSpan = this.tracer.startSpan("server.agent.start_dispatch", {
      parent: getCurrentTraceContext(),
      surface: "server",
      kind: "producer",
      attrs: {
        agent_id: agentId,
        machine_id: agent.machineId,
        launch_id: launchId,
        start_dispatch_id: startDispatchId,
        start_cause: startCause,
        resume_prompt_source: resumePrompt ? "caller" : startResumePrompt ? "catchup_unverified" : "none",
      },
    });
    // App events in the wake and resume messages as the pull paths hand them over (agentFacingContent.ts).
    if (wakeMessage) [wakeMessage] = await renderPushedMessages([wakeMessage], agentId, agent.serverId);
    if (resumeMessages) resumeMessages = await renderPushedMessages(resumeMessages, agentId, agent.serverId);
    const startFields = {
      agentId,
      config,
      // Reconciler step 11b: the revision this config was read at (an `agent:config` at or below it is stale).
      ...(typeof agent.configRevision === "number" ? { configRevision: agent.configRevision } : {}),
      wakeMessage,
      wakeMessageTransient: wakeMessage ? wakeMessageTransient : undefined,
      ...(resumeMessages ? { resumeMessages } : {}),
      unreadSummary,
      resumePrompt: startResumePrompt,
      launchId,
      startDispatchId,
      traceparent: formatTraceparent(startDispatchSpan.context),
      // RFC 071 outbox: only on a start the terminal breaker claimed. An older
      // daemon ignores them; a start that was not claimed is unchanged.
      ...(terminalClaim
        ? {
          breakerGeneration: terminalClaim.token.generation,
          takeoverEpoch: terminalClaim.token.takeoverEpoch,
          ...(catchupBatchId ? { catchupBatchId } : {}),
          ...(terminalControl === "human_start" ? { humanStart: true } : {}),
        }
        : {}),
      // task #365: an automatic start carries the epoch of the connection it
      // was claimed against (only a socket this replica holds); the daemon
      // refuses it on any other connection (`not_spawned: stale_dispatch`).
      ...(options.localConnectionEpochId
        ? { connectionEpochId: options.localConnectionEpochId }
        : terminalClaim && terminalControl === "automatic" ? this.claimTimeConnectionEpoch(agent.machineId) : {}),
    };
    const startMessage: ServerToMachineMessage = { type: "agent:start", ...startFields };
    // Replaces what the previous launch left; settled only by this launch's first completed turn.
    this.turnEndUnreadSnapshots.record(agentId, launchId ?? undefined, unreadSnapshot);
    // task #1119: record the start BEFORE the dispatch leaves this replica, so
    // an exit that becomes visible while the send is still in flight already
    // has its start on record (review counterexample: a fast crash landed at
    // count 0). The write sits inside the dispatch's failure scope: if the
    // shared store rejects it, or the send fails, the same cleanup runs
    // (guard rollback, wake lock release, lifecycle event) and the record is
    // rolled back when it was written.
    const targetMachineId = agent.machineId;
    await this.runInActiveSpan(startDispatchSpan, async () => {
      // RFC 071: a claimed start already wrote its #1119 start in the combined claim.
      let wakeCrashLoopStartRecord: WakeCrashLoopStartRecord | null = terminalClaim?.crashLoopStart ?? null;
      // Whether the agent:start may have left this replica: only a send that
      // returned false (or never ran) proves it did not (RFC X-6(b)).
      let dispatchMayHaveLeft = false;
      try {
        if (!terminalClaim) {
          wakeCrashLoopStartRecord = await this.wakeCrashLoopBreaker.recordStart(
            agentId,
            launchId ?? null,
            this.clock.now(),
            { human: humanStart },
          );
        }
        // task #1221: only a start that actually carries the owed catch-up
        // (resumeMessages the daemon will use: no wake message, no resume
        // prompt) can clear it, and only once its runtime reports active.
        // RFC 071 F9: a control start carries it only on a daemon that renders
        // both (the control was taken off this start otherwise, above).
        if (
          catchupOwed && launchId && resumeMessages && resumeMessages.length > 0 && !wakeMessage && !resumePrompt
          && (!config.runtimeProfileControl || controlStartRendersCatchup)
        ) {
          await this.wakeCrashLoopBreaker.markCatchupCarried(agentId, launchId);
        }
        if (options.requireQueueReceipt) {
          // Strict manual Notify cannot publish cross-replica without a target-side
          // queue acknowledgement. Fail before publishing so a retry cannot wake
          // a remote daemon twice after the source reports `dropped`.
          dispatchMayHaveLeft = true;
          const sent = this.sendLocalAgentStartWithAckRetry(
            targetMachineId,
            startMessage as AgentStartMessage & { startDispatchId: string },
          );
          dispatchMayHaveLeft = sent;
          if (!sent) {
            throw new CrossReplicaQueueReceiptUnavailableError();
          }
        } else {
          dispatchMayHaveLeft = true;
          const sent = await this.sendAgentStartWithAckRetry(
            targetMachineId,
            startMessage as AgentStartMessage & { startDispatchId: string },
          );
          dispatchMayHaveLeft = sent;
          if (!sent) {
            throw new RouteFailureError(
              "daemon_offline",
              "Machine offline. Please start your local daemon.",
            );
          }
        }
        // RFC 071 §9: a dispatched start ends any shown block; the next one is shown again.
        this.projectedTerminalBlocks.delete(agentId);
        // A person's start (Retry, restart) lifted a wake block, e.g. one for
        // a rejected credential (reconciler step 4b trace). Only once the
        // start left: a failed send rolls the block back.
        if (humanStart && wakeCrashLoopStartRecord?.previous.blocked) {
          this.recordEvent("wake.block_lifted", {
            cause: "human_start",
            source: "server_retry",
            release_cause: "human_start",
            lifted_reason: wakeCrashLoopStartRecord.previous.needsActionReason ?? null,
          });
        }
        if (terminalControl === "human_start") {
          // RFC 071 outbox: a human start is the daemon's only way out of
          // unreliable outcome storage; its next `ready` lists the agent again
          // if the daemon could not resolve it.
          this.machineConnections.get(targetMachineId)?.runtimeOutcomeUnreliableAgents?.delete(agentId);
        }
        startDispatchSpan.end("ok", {
          attrs: {
            outcome: "sent",
            queue_depth: this.pendingStartQueueDepth(targetMachineId),
          },
        });
      } catch (err) {
        startDispatchSpan.end("error", {
          attrs: {
            outcome: "send_failed",
            error_class: errorClassOf(err),
          },
        });
        this.terminalizePendingAgentStart(startDispatchId, "superseded");
        this.updateCache(agentId, { status: rollbackStatus });
        this.rollbackStartLaunchGuard(agentId, launchGuardBeforeStart, launchId);
        if (wakeLockHeld) this.releaseWakeLock(agentId);
        if (terminalClaim) {
          // RFC 071 §4.3: ownership-checked; the pending entry stays unless the start provably never left.
          try {
            const outcome = await this.terminalFailureBreaker.rollbackClaim(agentId, terminalClaim.token, {
              nowMs: this.clock.now(),
              dispatchLeftReplica: dispatchMayHaveLeft,
            });
            this.recordEvent("terminal_breaker.rollback", { step: "claim", outcome, dispatch_left_replica: dispatchMayHaveLeft });
          } catch (rollbackErr) {
            console.warn(`[Agent ${agentId}] terminal-failure breaker claim rollback failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`);
          }
        }
        if (wakeCrashLoopStartRecord) {
          // Shared-store rollback is best effort: a failure here must not stop
          // the local cleanup above or the lifecycle record below.
          try {
            await this.wakeCrashLoopBreaker.rollbackStart(agentId, wakeCrashLoopStartRecord);
          } catch (rollbackErr) {
            console.warn(`[Agent ${agentId}] wake crash-loop start rollback failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`);
          }
        }
        this.recordLifecycleEvent({
          agentId,
          machineId: targetMachineId,
          action: "start",
          outcome: "failed",
          cause: startCause,
          previousStatus,
          detail: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    });
    this.advanceActivityIngestEpoch(agentId);

    // Init inbox
    this.localInboxes.ensure(agentId);

    // TODO(lifecycle-v2/server-producer): manual/lazy/resume start is
    // server-owned. Construct the canonical runtime_spawned event at the start
    // planner boundary (or make the planner return it) and remove this legacy
    // action adapter once start no longer flows through the compatibility layer.
    const { event } = adaptStartLifecycleEvent({
      serverId: agent.serverId,
      agentId,
      machineId: agent.machineId,
      launchId,
      previousStatus,
      startCause,
      now: () => new Date(this.clock.now()),
    });
    const span = this.tracer.startSpan("server.agent.lifecycle.start.apply", {
      parent: getCurrentTraceContext(),
      surface: "server",
      kind: "internal",
      attrs: {
        agent_id: agentId,
        authority: "server_control",
        event_kind: "start_requested",
        machine_id: agent.machineId,
        previous_status: previousStatus ?? null,
        reason: event.reason,
        server_id: agent.serverId,
        source: "server_control",
        start_cause: startCause,
      },
    });
    try {
      await this.runInActiveSpan(span, async () => {
        const result = await applyAgentLifecycleProjectionPlan(
          reduceStartLifecycle({
            event,
            state: buildAgentLifecycleStateSnapshot({
              dbStatus: previousStatus ?? agent.status,
              intentState: "running_allowed",
              launchId,
              machineId: agent.machineId,
              machineReachability: agent.machineId ? "reachable" : "unknown",
              runtimeState: "starting",
            }),
          }),
          this.lifecycleProjectionWriterDeps(),
          span,
        );
        this.recordLifecycleEvent({
          agentId,
          machineId: agent.machineId,
          action: "start",
          outcome: "completed",
          cause: startCause,
          previousStatus,
          nextStatus: "active",
        });
        span.end("ok", {
          attrs: {
            outcome: "applied",
            ...liveActivityRootTraceAttrs(result.liveActivityResult),
          },
        });
      });
    } catch (err) {
      span.end("error", { attrs: { error_class: errorClassOf(err) } });
      throw err;
    }
    return { outcome: "dispatched" };
    } finally {
      releaseCatalogAuthority();
    }
  }

  /**
   * Stop on the replica that owns the machine socket, so the guards and
   * trackers the stop clears are the ones that replica checks frames against.
   */
  async stopAgent(
    agentId: string,
    reason: StopAgentReason = "manual",
    options: {
      withinReset?: boolean;
      /**
       * What the daemon is told (`agent:stop` `reason`): `owner_stop` from a
       * person's Stop (the agent's Stop, the channel's stop-all, an assistant
       * pause), `deleted` from the stop before an agent or account delete.
       * Absent: no reason (a lifecycle stop; `raft proc` jobs keep running).
       */
      daemonReason?: AgentStopReason;
    } = {},
  ): Promise<AgentStopResult> {
    const { daemonReason } = options;
    if (this.mayRunOnOwner(agentId) && await this.runOnOwner(agentId, { kind: "stop", reason, ...(daemonReason ? { daemonReason } : {}) })) return { delivered: true };
    const result = await this.stopAgentHere(agentId, reason, daemonReason);
    if (result.delivered) return result;
    // No replica holds the machine socket, so the daemon was not told.
    if (reason === "manual") {
      // The agent is persisted `stopped`; ready reconcile force-stops it when
      // the daemon reconnects (force-stop-and-stay-offline).
      this.recordEvent("server.agent.stop.undelivered", { agent_id: agentId, reason, applies_on: "reconnect" });
      return result;
    }
    // An internal stop persists `inactive`, which is also what an observed
    // disconnect writes, so ready reconcile cannot tell "we want it stopped"
    // from "we saw it go away" and adopts a still-running process. Until RFC
    // 072 records the intent itself, this stop is lost when undelivered.
    this.recordEvent("server.agent.stop.undelivered", {
      agent_id: agentId,
      reason,
      applies_on: "none",
      within_reset: options.withinReset === true,
    });
    // A reset still clears the session offline (stop_undelivered is recorded
    // above); a standalone internal stop tells its caller.
    if (options.withinReset) return result;
    throw new RouteFailureError("daemon_offline", `Agent ${agentId} stop could not reach its Computer`);
  }

  protected async stopAgentHere(
    agentId: string,
    reason: StopAgentReason = "manual",
    daemonReason?: AgentStopReason,
  ): Promise<AgentStopResult> {
    // Agent typing line: a stopped (or about-to-be-deleted) agent is not typing.
    this.agentTyping.endForAgent(agentId);
    // task #1119: an operator stop is intent, not a crash; forget the streak.
    // It also lifts a block (a person's "try again", e.g. Retry on a rejected
    // credential): reconciler step 4b traces that lift.
    if (reason === "manual") {
      const { liftedBlock } = await this.wakeCrashLoopBreaker.recordManualStop(agentId);
      if (liftedBlock) {
        this.recordEvent("wake.block_lifted", {
          cause: "manual_stop",
          source: "server_retry",
          release_cause: "explicit_stop",
          lifted_reason: liftedBlock.reason,
        });
      }
    }
    // RFC 071 §5: not E3. A probe in flight is cleared (half_open → open, step unchanged).
    if (reason === "manual" && this.runtimeOutcomeAckEnabled) {
      await this.terminalFailureBreaker.recordManualStop(agentId, this.clock.now()).catch((error: unknown) => {
        console.warn(`[Agent ${agentId}] terminal-failure breaker manual stop not recorded: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    const agent = await this.getCachedAgent(agentId);
    if (!agent) return { delivered: true };
    const previousStatus = agent.status;
    const action = planStopAction({ reason });
    const nextStatus: AgentStatus = action === "persist-stopped" ? "stopped" : "inactive";
    const context: StopApplyContext = {
      agentId,
      serverId: agent.serverId,
      machineId: agent.machineId,
      reason,
      ...(daemonReason ? { daemonReason } : {}),
      previousStatus,
      nextStatus,
    };

    return this.applyStopAction(context);
  }

  protected async applyStopAction(context: StopApplyContext): Promise<AgentStopResult> {
    const correlationId = this.makeLifecycleCorrelationId(
      "agent",
      context.agentId,
      "stop",
      context.reason,
      crypto.randomUUID(),
    );
    // TODO(lifecycle-v2/server-producer): stop is server-owned. Have the stop
    // planner emit canonical manual_stop_requested/runtime_interrupted events
    // with the stop correlation id and reason, then delete this adapter call.
    const { event } = adaptStopLifecycleEvent({
      serverId: context.serverId,
      agentId: context.agentId,
      machineId: context.machineId,
      reason: context.reason,
      previousStatus: context.previousStatus,
      nextStatus: context.nextStatus,
      stopCorrelationId: correlationId,
      now: () => new Date(this.clock.now()),
    });
    const activityDedupeKey = this.makeLifecycleDedupeKey("agent", context.agentId, "stop", correlationId);
    const span = this.tracer.startSpan("server.agent.lifecycle.stop.apply", {
      parent: getCurrentTraceContext(),
      surface: "server",
      kind: "internal",
      attrs: {
        agent_id: context.agentId,
        authority: "server_control",
        event_kind: "stop_requested",
        machine_id: context.machineId,
        reason: context.reason,
        previous_status: context.previousStatus,
        next_status: context.nextStatus,
        server_id: context.serverId,
        source: "server_control",
      },
    });
    try {
      return await this.runInActiveSpan(span, async (): Promise<AgentStopResult> => {
        const result = await applyAgentLifecycleProjectionPlan(
          reduceStopLifecycle({
            activityDedupeKey,
            event,
            nextStatus: context.nextStatus,
            state: buildAgentLifecycleStateSnapshot({
              dbStatus: context.previousStatus,
              intentState: context.nextStatus === "stopped" ? "manual_stopped" : "running_allowed",
              machineId: context.machineId,
              machineReachability: context.machineId ? "reachable" : "unknown",
              runtimeState: "not_running",
            }),
          }),
          this.lifecycleProjectionWriterDeps(context.daemonReason ? { stopReason: context.daemonReason } : {}),
          span,
        );
        if (context.reason === "manual") {
          // task #1351: a Stop does not top up a provider balance, so a stored
          // BillingError (and its banner) stays; every other error clears. The
          // database decides, not this replica's cache.
          const cleared = await this.clearLastRuntimeError(context.agentId);
          if (!cleared && this.agentStateCache.get(context.agentId)?.lastRuntimeError?.errorClass === "BillingError") {
            this.recordEvent("runtime_error_state.preserved", { reason: "billing_manual_stop", detail_kind: "manual_stop" });
          }
        }
        if (context.reason === "internal") {
          const nextIngestEpoch = this.advanceActivityIngestEpoch(context.agentId);
          this.recordEvent("activity.ingest.rebaseline", {
            reason: "internal_stop",
            activity_ingest_epoch: nextIngestEpoch,
          });
        }
        const clearedPendingDeliveries = this.clearPendingAgentDeliveryAcksForAgent(context.agentId);
        if (clearedPendingDeliveries > 0) {
          this.recordEvent("server.delivery.retry.cleared", {
            outcome: "cleared",
            reason: "agent_stopped",
            pending_delivery_count: clearedPendingDeliveries,
          });
        }
        const clearedPendingStarts = this.clearPendingAgentStartsForAgent(
          context.agentId,
          "stopped",
        );
        if (clearedPendingStarts > 0) {
          this.recordEvent("server.start_dispatch.cleared", {
            outcome: "terminal",
            terminal_reason: "stopped",
            pending_start_count: clearedPendingStarts,
          });
        }
        this.recordLifecycleEvent({
          agentId: context.agentId,
          machineId: context.machineId,
          action: "stop",
          outcome: "completed",
          cause: context.reason,
          previousStatus: context.previousStatus,
          nextStatus: context.nextStatus,
        });
        span.end("ok", {
          attrs: {
            outcome: "applied",
            stop_sent: result.stopSent ?? false,
            ...liveActivityRootTraceAttrs(result.liveActivityResult),
          },
        });
        // No machine means no process to stop.
        return { delivered: result.stopSent !== false };
      });
    } catch (err) {
      span.end("error", { attrs: { error_class: errorClassOf(err) } });
      throw err;
    }
  }

  /**
   * Reset on the replica that owns the machine socket: its reset window is the
   * one consulted when the old process's frames arrive, and the stop/start the
   * reset performs then run there too.
   */
  async resetAgent(
    agentId: string,
    mode: "restart" | "session" | "full",
    options: ResetAgentOptions = {},
  ) {
    if (this.mayRunOnOwner(agentId) && await this.runOnOwner(agentId, { kind: "reset", mode, options })) return;
    await this.resetAgentHere(agentId, mode, options);
  }

  /**
   * Reconciler step 11b: send the agent's current config to the daemon that
   * runs it, which restarts the agent on it once idle. Runs on the replica
   * that holds the machine's socket (only the intent's kind crosses replicas).
   * `not_pushed`: nothing was sent (the daemon lacks
   * `DAEMON_CAPABILITY_AGENT_CONFIG_PUSH`, the agent is not running there, the
   * machine is not connected, or the owner replica is an older build), and
   * the caller applies its own fallback. Never throws: the change it follows
   * has already committed.
   */
  async applyAgentConfig(agentId: string): Promise<AgentConfigApplyOutcome> {
    try {
      if (this.mayRunOnOwner(agentId)) {
        const routed = await this.runOnOwner(agentId, { kind: "config" });
        if (routed) return routed.outcome === "config" && routed.pushed ? "pushed" : "not_pushed";
      }
      return await this.applyAgentConfigHere(agentId);
    } catch (error) {
      const unanswered = error instanceof StartIntentRemoteError && error.failure.name === START_INTENT_UNANSWERED;
      this.recordEvent("server.agent.config_push", {
        agent_id: agentId,
        outcome: "not_pushed",
        reason: unanswered ? "owner_without_config_intent" : "route_failed",
        error_class: errorClassOf(error),
      });
      return "not_pushed";
    }
  }

  protected async applyAgentConfigHere(agentId: string): Promise<AgentConfigApplyOutcome> {
    const notPushed = (reason: string): AgentConfigApplyOutcome => {
      this.recordEvent("server.agent.config_push", { agent_id: agentId, outcome: "not_pushed", reason });
      return "not_pushed";
    };
    const agent = await this.loadAgentForStart(agentId);
    const machineId = agent?.machineId;
    if (!agent || !machineId) return notPushed("no_machine");
    if (!this.machineConnections.has(machineId)) return notPushed("machine_not_local");
    if (!this.hasMachineCapability(machineId, DAEMON_CAPABILITY_AGENT_CONFIG_PUSH)) return notPushed("daemon_without_capability");
    // `active`: the agent runs, or is being started, on that machine (a
    // process exit or a stop persists `inactive`/`stopped`). A config change
    // for an agent that does not run reaches it with its next start.
    if (agent.status !== "active") return notPushed("agent_not_running");
    const frame: ServerToMachineMessage = {
      type: "agent:config",
      agentId,
      config: await this.buildAgentConfig(agent),
      revision: agent.configRevision,
    };
    if (!this.sendAgentConfigLocally(machineId, frame)) return notPushed("send_failed");
    this.recordEvent("server.agent.config_push", {
      agent_id: agentId,
      machine_id: machineId,
      outcome: "pushed",
      revision: agent.configRevision,
    });
    return "pushed";
  }

  /**
   * Reconciler step 11d: after a `ready`, send the config again to each
   * running agent whose daemon applied an older revision than the database's
   * (the push was lost: the socket dropped with it in flight, or the daemon
   * was not connected). The daemon reports the highest revision it applied,
   * also when an older start kept a newer pushed config (11a's stale start),
   * so this never re-sends a config the daemon chose to keep. Bounded to one
   * re-send per agent and revision per connection: a daemon reporting the
   * older revision again (a second `ready`, or a push it did not apply) is
   * not sent it again until it reconnects. Agents the daemon reports no
   * revision for (older daemons, a revision it does not know) are not
   * compared; `applyAgentConfig` checks the capability and the agent's status.
   */
  private async resendLostAgentConfigs(
    conn: MachineConnection,
    machineAgents: ReadonlyArray<{ id: string; configRevision: number }>,
    runningSet: ReadonlySet<string>,
    applied: ReadonlyMap<string, number>,
  ): Promise<void> {
    if (applied.size === 0) return;
    const resent = conn.configResentRevisions ??= new Map();
    for (const agent of machineAgents) {
      const appliedRevision = applied.get(agent.id);
      if (appliedRevision === undefined || !runningSet.has(agent.id)) continue;
      if (appliedRevision >= agent.configRevision) continue;
      // Claimed before the await: two readies handled concurrently re-send once.
      if ((resent.get(agent.id) ?? -Infinity) >= agent.configRevision) {
        this.recordEvent("server.agent.config_resend", { agent_id: agent.id, outcome: "skipped", reason: "already_resent", revision: agent.configRevision, applied_revision: appliedRevision });
        continue;
      }
      resent.set(agent.id, agent.configRevision);
      const outcome = await this.applyAgentConfig(agent.id);
      this.recordEvent("server.agent.config_resend", { agent_id: agent.id, outcome, revision: agent.configRevision, applied_revision: appliedRevision });
    }
  }

  /** Local socket only: an `agent:config` never crosses Redis (its env vars may hold secrets). */
  protected sendAgentConfigLocally(machineId: string, frame: ServerToMachineMessage): boolean {
    const conn = this.machineConnections.get(machineId);
    if (!conn || conn.ws.readyState !== 1) return false;
    conn.ws.send(JSON.stringify(frame));
    return true;
  }

  protected async resetAgentHere(
    agentId: string,
    mode: "restart" | "session" | "full",
    options: ResetAgentOptions = {},
  ) {
    if (this.resetInProgress.has(agentId)) {
      this.recordLifecycleEvent({
        agentId,
        machineId: null,
        action: "reset",
        outcome: "skipped",
        cause: mode,
        detail: "reset_in_progress",
      });
      return;
    }
    this.resetInProgress.set(agentId, mode);
    try {
      // Get machine info before stopping (cache may be populated)
      const agentBefore = await this.getCachedAgent(agentId);
      const previousStatus = agentBefore?.status ?? null;
      const shouldRestart = agentBefore?.status === "stopped"
        ? (options.restartIfStopped ?? true)
        : ((options.restartEvenIfInactive ?? true) || agentBefore?.status === "active");
      const plan = planResetActions({
        mode,
        hasMachine: Boolean(agentBefore?.machineId),
        restart: shouldRestart,
      });
      const context: ResetApplyContext = {
        agentId,
        serverId: agentBefore?.serverId ?? null,
        assistantOwnerUserId: agentBefore?.assistantOwnerUserId ?? null,
        mode,
        previousStatus,
        machineId: agentBefore?.machineId ?? null,
        ...(options.terminalControl ? { terminalControl: options.terminalControl } : {}),
      };
      this.recordLifecycleEvent({
        agentId,
        machineId: agentBefore?.machineId ?? null,
        action: "reset",
        outcome: "attempted",
        cause: mode,
        previousStatus,
      });
      await this.applyResetPlan(context, plan);
    } finally {
      this.resetInProgress.delete(agentId);
    }
  }

  protected async applyResetPlan(context: ResetApplyContext, plan: ResetPlanAction[]) {
    if (plan.includes("stop-internal")) {
      await this.stopAgent(context.agentId, "internal", { withinReset: true });
    }
    // RFC 071 §5: an E3 reset lifts the terminal-failure breaker whether or
    // not the plan restarts (session / full drop the failing session). The
    // restart below is then the human takeover start.
    if (context.terminalControl) await this.liftTerminalBreaker(context.agentId, context.terminalControl);

    if (plan.includes("clear-session")) {
      const resetStatus = context.previousStatus === "stopped" ? "stopped" : "inactive";
      await this.resetPersistedAgentSession(context.agentId, resetStatus);
      this.updateCache(context.agentId, { sessionId: null, status: resetStatus });
      if (context.serverId) {
        this.broadcastAgentSession({ id: context.agentId, serverId: context.serverId, assistantOwnerUserId: context.assistantOwnerUserId }, null);
      }
      this.clearLaunchGuard(context.agentId);
      this.advanceActivityIngestEpoch(context.agentId);
    }

    if (plan.includes("reset-workspace") && context.machineId) {
      this.sendBestEffortToMachine(
        context.machineId,
        { type: "agent:reset-workspace", agentId: context.agentId },
        `best-effort reset-workspace send failed for agent ${context.agentId}`,
      );
    }

    // Some caller-driven resets only need to clear session state; restart remains explicit in the plan.
    if (!plan.includes("restart")) return;

    try {
      await this.startAgent(context.agentId, context.terminalControl ? { control: "human_start" } : {});
      const restarted = await this.getCachedAgent(context.agentId);
      this.recordLifecycleEvent({
        agentId: context.agentId,
        machineId: restarted?.machineId ?? context.machineId,
        action: "reset",
        outcome: "completed",
        cause: context.mode,
        previousStatus: context.previousStatus,
        nextStatus: restarted?.status ?? "active",
      });
    } catch {
      // If restart fails (e.g. no machine), agent stays offline — that's fine.
      const failed = await this.getCachedAgent(context.agentId);
      this.recordLifecycleEvent({
        agentId: context.agentId,
        machineId: failed?.machineId ?? context.machineId,
        action: "reset",
        outcome: "failed",
        cause: context.mode,
        previousStatus: context.previousStatus,
        nextStatus: failed?.status ?? null,
      });
    }
  }

  // Agent workspace file browsing

  /**
   * `archivedOnMachineId`: an archived agent has no `daemon_id`; its archive
   * record names the Computer that still holds the workspace.
   */
  async getAgentFileTree(agentId: string, dirPath?: string, includeHidden = false, archivedOnMachineId?: string): Promise<FileNode[]> {
    const result = archivedOnMachineId
      ? (this.hasMachineLocally(archivedOnMachineId) ? { machineId: archivedOnMachineId } : null)
      : await this.getMachineForAgent(agentId);
    if (!result) throw new RouteFailureError("daemon_offline", "Agent has no connected machine");
    const { machineId } = result;

    return new Promise(async (resolve, reject) => {
      const timeout = this.scheduleOnClock(() => {
        this.removeListener(`machine:response:${machineId}`, handler);
        reject(new RouteFailureError("daemon_timeout", "File tree request timed out"));
      }, 15_000);

      const handler = (msg: MachineToServerMessage) => {
        if (
          msg.type === "agent:workspace:file_tree"
          && msg.agentId === agentId
          && msg.dirPath === dirPath
          && Boolean(msg.includeHidden) === includeHidden
        ) {
          this.clock.clearTimeout(timeout);
          this.removeListener(`machine:response:${machineId}`, handler);
          resolve(msg.files);
        }
      };

      this.on(`machine:response:${machineId}`, handler);

      try {
        await this.sendRequiredToMachine(machineId, { type: "agent:workspace:list", agentId, dirPath, includeHidden });
      } catch {
        this.clock.clearTimeout(timeout);
        this.removeListener(`machine:response:${machineId}`, handler);
        reject(new RouteFailureError("daemon_offline", "Failed to send request — machine WebSocket not ready"));
      }
    });
  }

  /**
   * Ask a computer to re-detect which runtimes are installed.
   *
   * Fire-and-forget by design: the daemon answers by re-emitting its capabilities,
   * which flow back through the normal `machine:capabilities` push. There is no
   * reply to await, and an older daemon that does not know this message simply
   * ignores it — so this must never be something the UI blocks on.
   */
  async rescanMachineRuntimes(machineId: string): Promise<boolean> {
    return this.sendToMachine(machineId, { type: "machine:runtimes:rescan" });
  }

  async requestRuntimeAccountUsageRefresh(
    machineId: string,
    provider: RuntimeAccountUsageProvider,
    reason: "manual" | "stale_or_missing" | "scheduled",
  ): Promise<boolean> {
    return this.sendToMachine(machineId, {
      type: "machine:runtime_account_usage:refresh",
      requestId: crypto.randomUUID(),
      provider,
      reason,
    });
  }

  /**
   * Manual runtime-account usage refresh: send the refresh command and wait
   * for the correlated snapshot through the cross-replica relay (same carrier
   * shape as requestProviderProbe). Background refreshes
   * (scheduled/stale_or_missing) stay fire-and-forget on
   * requestRuntimeAccountUsageRefresh — only the manual route blocks on the
   * machine's reply. The snapshot message itself still flows through the
   * inbound switch, which re-authorizes at the data boundary and writes the
   * private cache before forwarding to this relay; this method never touches
   * the cache. Failures are typed: daemon_offline when the command could not
   * be sent, daemon_timeout when no snapshot arrived within the relay budget.
   */
  async requestRuntimeAccountUsageRefreshAndAwait(
    machineId: string,
    provider: RuntimeAccountUsageProvider,
  ): Promise<Extract<MachineToServerMessage, { type: "machine:runtime_account_usage:snapshot" }>> {
    const requestId = crypto.randomUUID();
    const response = await this.getMachineResponseRelay().request({
      requestId, machineId, type: "machine:runtime_account_usage:snapshot",
    }, RUNTIME_ACCOUNT_USAGE_RELAY_BUDGET_MS, () => this.sendRequiredToMachine(machineId, {
      type: "machine:runtime_account_usage:refresh",
      requestId,
      provider,
      reason: "manual",
    }), (event, attrs) => this.recordMachineResponseRelay(event, attrs));
    if (response.type !== "machine:runtime_account_usage:snapshot") throw new Error("Unexpected runtime account usage response");
    return response;
  }

  /**
   * Computer-scoped provider probe carrier. Mirrors the runtime-models seam:
   * requestId correlation, cross-replica relay, typed daemon_offline /
   * daemon_timeout failures and the probe budget (distinct from the 5s model
   * budget). The command carries no credential; the daemon materializes with
   * its own machine auth.
   */
  /**
   * task #17: forwards a login's event or result to the person who started
   * it, on their own sockets only (the user room spans replicas through the
   * Socket.IO adapter). A login this Computer does not own is dropped.
   */
  private async relayRuntimeAuthLogin(
    machineId: string,
    msg: Extract<MachineToServerMessage, { type: "machine:runtime_auth:login:event" | "machine:runtime_auth:login:result" }>,
  ): Promise<void> {
    const loginId = typeof msg.loginId === "string" ? asRuntimeAuthLoginId(msg.loginId) : null;
    const session = loginId ? await runtimeAuthService.getSession(loginId) : null;
    if (!loginId || !session || session.machineId !== machineId) {
      addTraceEvent("runtime_auth.login.relay_dropped", { machine_id: machineId, type: msg.type, reason: session ? "other_machine" : "unknown_login" });
      return;
    }
    const room = `user:${session.requesterUserId}`;
    if (msg.type === "machine:runtime_auth:login:event") {
      const event = runtimeAuthLoginEventSchema.safeParse(msg.event);
      if (!event.success) return;
      const push: RuntimeAuthLoginEventPush & { serverId: string } = { serverId: session.serverId, machineId, runtime: session.runtime, loginId, event: event.data };
      this.io?.to(room).emit("runtime_auth:login:event", push);
      addTraceEvent("runtime_auth.login.event", { machine_id: machineId, runtime: session.runtime, kind: event.data.kind });
      return;
    }
    const result = runtimeAuthLoginResultSchema.safeParse(msg.result);
    const checked = result.success ? result.data : { kind: "failed" as const, reason: "process_failed" as const };
    await runtimeAuthService.endLogin(session);
    if (checked.kind === "logged_in") await this.liftRuntimeCredentialBlocks(machineId, session.runtime, "login");
    const push: RuntimeAuthLoginResultPush & { serverId: string } = { serverId: session.serverId, machineId, runtime: session.runtime, loginId, result: checked };
    this.io?.to(room).emit("runtime_auth:login:result", push);
    addTraceEvent("runtime_auth.login.result", {
      machine_id: machineId,
      runtime: session.runtime,
      user_id: session.requesterUserId,
      outcome: checked.kind,
      ...("reason" in checked ? { reason: checked.reason } : {}),
      duration_ms: this.clock.now() - session.startedAtMs,
    });
  }

  private async endRuntimeAuthLoginsForMachine(machineId: string, connectionEpochId: string | null): Promise<void> {
    try {
      for (const runtime of RUNTIME_AUTH_RUNTIMES) {
        const session = await runtimeAuthService.getActiveSession(machineId, runtime);
        if (!session || session.machineId !== machineId) continue;
        // Only the logins this very connection ran. When either side has no
        // connection id it cannot be told apart from a newer connection's, so
        // it is left to its TTL rather than ended by a late disconnect.
        if (!session.connectionEpochId || !connectionEpochId || session.connectionEpochId !== connectionEpochId) continue;
        await runtimeAuthService.endLogin(session);
        const push: RuntimeAuthLoginResultPush & { serverId: string } = { serverId: session.serverId, machineId, runtime, loginId: session.loginId, result: { kind: "cancelled" } };
        this.io?.to(`user:${session.requesterUserId}`).emit("runtime_auth:login:result", push);
        addTraceEvent("runtime_auth.login.result", { machine_id: machineId, runtime, user_id: session.requesterUserId, outcome: "cancelled", reason: "computer_disconnected" });
      }
    } catch (err) {
      console.warn(`[RuntimeAuth ${machineId}] Failed to end logins on disconnect:`, errorClassOf(err));
    }
  }

  /**
   * task #17: whether this Computer can take a web login or logout now, the
   * runtimes its daemon signs in (Kimi and Qoder only from one with
   * DAEMON_CAPABILITY_RUNTIME_AUTH_V2), and the connection that would run it
   * (a login is bound to it, so a late disconnect of an older connection
   * cannot end a newer one's login). `logoutRuntimes`: those it also signs
   * out (Antigravity only from one with
   * DAEMON_CAPABILITY_RUNTIME_AUTH_ANTIGRAVITY_LOGOUT).
   */
  async runtimeAuthAvailability(machineId: string): Promise<
    | { state: "ok"; connectionEpochId: string | null; runtimes: readonly RuntimeAuthRuntime[]; logoutRuntimes: readonly RuntimeAuthRuntime[] }
    | { state: "computer_offline" | "computer_upgrade_required" }
  > {
    const fact = await this.readProbeCarrierFact(machineId);
    if (!fact) return { state: "computer_offline" };
    const runtimes = runtimeAuthRuntimesOfComputer(fact.capabilities);
    if (runtimes.length === 0) return { state: "computer_upgrade_required" };
    return { state: "ok", connectionEpochId: fact.connectionEpochId ?? null, runtimes, logoutRuntimes: runtimeAuthLogoutRuntimesOfComputer(fact.capabilities) };
  }

  /** task #17: a login start, code or cancel; rejects with RouteFailureError daemon_offline when the Computer cannot be reached. */
  async sendRuntimeAuthCommand(machineId: string, message: Extract<ServerToMachineMessage, { type: "machine:runtime_auth:login:start" | "machine:runtime_auth:login:code" | "machine:runtime_auth:login:cancel" }>): Promise<void> {
    await this.sendRequiredToMachine(machineId, message);
  }

  /**
   * task #17: logs a runtime out on the Computer and returns OAR's answer.
   * `providerId`: the one provider to sign out, for a runtime that signs in
   * per provider (Pi); checked by the caller (`runtimeAuthProviderIdFits`).
   */
  async logoutRuntime(machineId: string, runtime: RuntimeAuthRuntime, providerId?: string): Promise<RuntimeAuthLogoutResult> {
    const requestId = crypto.randomUUID();
    const response = await this.getMachineResponseRelay().request({
      requestId, machineId, type: "machine:runtime_auth:logout:result",
    }, RUNTIME_AUTH_LOGOUT_RELAY_BUDGET_MS, () => this.sendRequiredToMachine(machineId, {
      type: "machine:runtime_auth:logout",
      requestId,
      runtime,
      ...(providerId ? { providerId } : {}),
    }), (event, attrs) => this.recordMachineResponseRelay(event, attrs));
    if (response.type !== "machine:runtime_auth:logout:result") throw new Error("Unexpected logout response");
    return response.result;
  }

  /**
   * Whether this Computer's daemon reads the provider's usage
   * (`runtimeAccountUsageReadableWith`): `unknown` while it is offline (the
   * cache answers then).
   */
  async runtimeAccountUsageReadable(machineId: string, provider: RuntimeAccountUsageProvider): Promise<"readable" | "unsupported" | "unknown"> {
    if (runtimeAccountUsageReadableWith(provider, [])) return "readable";
    const fact = await this.readProbeCarrierFact(machineId);
    if (!fact) return "unknown";
    return runtimeAccountUsageReadableWith(provider, fact.capabilities) ? "readable" : "unsupported";
  }

  /** Whether this Computer is online and its daemon spends limit resets (DAEMON_CAPABILITY_RUNTIME_LIMIT_RESET). */
  async runtimeLimitResetAvailability(machineId: string): Promise<"ok" | "computer_offline" | "computer_upgrade_required"> {
    const fact = await this.readProbeCarrierFact(machineId);
    if (!fact) return "computer_offline";
    return fact.capabilities.includes(DAEMON_CAPABILITY_RUNTIME_LIMIT_RESET) ? "ok" : "computer_upgrade_required";
  }

  /**
   * Whether this Computer is online and its daemon answers Claude limit
   * resets by kind (DAEMON_CAPABILITY_RUNTIME_LIMIT_RESET_CLAUDE_KINDS: a
   * Computer on Linux; one before OAR 0.102 also only with a tested Claude
   * Code).
   */
  async claudeLimitResetAvailability(machineId: string): Promise<"ok" | "computer_offline" | "computer_upgrade_required"> {
    const fact = await this.readProbeCarrierFact(machineId);
    if (!fact) return "computer_offline";
    return fact.capabilities.includes(DAEMON_CAPABILITY_RUNTIME_LIMIT_RESET_CLAUDE_KINDS) ? "ok" : "computer_upgrade_required";
  }

  /**
   * Spends one of the provider account's limit resets on the Computer, with
   * the idempotency key as the person's click minted it, and returns the
   * Computer's outcome and the usage it read right after (already written to
   * the cache by the inbound switch). Rejects with RouteFailureError
   * daemon_offline / daemon_timeout; after a timeout it is not known whether
   * a reset was spent, so the caller retries with the same key. `kind`: the
   * one Claude reset the person chose (only to a Computer with
   * DAEMON_CAPABILITY_RUNTIME_LIMIT_RESET_CLAUDE_KINDS); Claude Code takes
   * longer, so it has its own relay budget.
   */
  async redeemRuntimeLimitReset(
    machineId: string,
    provider: RuntimeAccountUsageProvider,
    idempotencyKey: RuntimeLimitResetIdempotencyKey,
    kind?: RuntimeLimitResetKind,
  ): Promise<Extract<MachineToServerMessage, { type: "machine:runtime_account_usage:limit_reset:result" }>> {
    const requestId = crypto.randomUUID();
    const response = await this.getMachineResponseRelay().request({
      requestId, machineId, type: "machine:runtime_account_usage:limit_reset:result",
    }, kind ? RUNTIME_LIMIT_RESET_CLAUDE_RELAY_BUDGET_MS : RUNTIME_LIMIT_RESET_RELAY_BUDGET_MS, () => this.sendRequiredToMachine(machineId, {
      type: "machine:runtime_account_usage:limit_reset:redeem",
      requestId,
      provider,
      idempotencyKey,
      ...(kind ? { kind } : {}),
    }), (event, attrs) => this.recordMachineResponseRelay(event, attrs));
    if (response.type !== "machine:runtime_account_usage:limit_reset:result") throw new Error("Unexpected limit reset response");
    return response;
  }

  /**
   * Reads which limit resets the provider account holds on the Computer
   * (Claude: its daemon opens Claude Code's command for each kind and
   * cancels it). Only on a person's click. `atFiveHourLimit` is what the
   * cached usage says (anything but a clear "not at the limit" is `true`);
   * the Computer refuses a read there unless `atFiveHourLimitConsent`.
   * Rejects with RouteFailureError daemon_offline / daemon_timeout.
   */
  async readRuntimeLimitResets(
    machineId: string,
    provider: RuntimeAccountUsageProvider,
    input: { atFiveHourLimit: boolean; atFiveHourLimitConsent: boolean; includeFiveHour: boolean },
  ): Promise<Extract<MachineToServerMessage, { type: "machine:runtime_account_usage:limit_resets:read:result" }>> {
    const requestId = crypto.randomUUID();
    const response = await this.getMachineResponseRelay().request({
      requestId, machineId, type: "machine:runtime_account_usage:limit_resets:read:result",
    }, RUNTIME_LIMIT_RESET_CLAUDE_RELAY_BUDGET_MS, () => this.sendRequiredToMachine(machineId, {
      type: "machine:runtime_account_usage:limit_resets:read",
      requestId,
      provider,
      atFiveHourLimit: input.atFiveHourLimit,
      ...(input.atFiveHourLimitConsent ? { atFiveHourLimitConsent: true } : {}),
      ...(input.includeFiveHour ? { includeFiveHour: true } : {}),
    }), (event, attrs) => this.recordMachineResponseRelay(event, attrs));
    if (response.type !== "machine:runtime_account_usage:limit_resets:read:result") throw new Error("Unexpected limit resets read response");
    return response;
  }

  /**
   * A sealed provider connect this replica could not open: nothing is sent to
   * the Computer. One that cannot be opened at all (sent in the clear,
   * changed, sealed with another secret) is answered at once as
   * `relay_failed`, so the person is told instead of waiting out the relay
   * budget. An expired or replayed copy is not answered: the person who
   * sent it is no longer waiting, or the first copy is already on its way.
   */
  private refuseSealedConnect(machineId: string, reason: ReplicaHopRefusal, requestId: string | null): void {
    addTraceEvent("runtime_auth.connect_provider.hop_refused", { machine_id: machineId, reason });
    if (!requestId || reason === "expired" || reason === "replayed") return;
    void this.getMachineResponseRelay().forward(machineId, {
      type: "machine:runtime_auth:connect_provider:result",
      requestId,
      result: { kind: "failed", reason: "relay_failed" },
    }, (event, attrs) => this.recordMachineResponseRelay(event, attrs));
  }

  /**
   * The model providers a runtime with `connect_provider` (Qwen Code) offers
   * on the Computer, read there for the person choosing one. Typed failures
   * as for a logout: daemon_offline, daemon_timeout.
   */
  async listRuntimeProviders(machineId: string, runtime: RuntimeAuthRuntime): Promise<RuntimeAuthProvidersResult> {
    if (!runtimeAuthSupports(runtime, "connect_provider")) throw new Error(`${runtime} has no provider connect`);
    const requestId = crypto.randomUUID();
    const response = await this.getMachineResponseRelay().request({
      requestId, machineId, type: "machine:runtime_auth:providers:result",
    }, RUNTIME_AUTH_PROVIDER_RELAY_BUDGET_MS, () => this.sendRequiredToMachine(machineId, {
      type: "machine:runtime_auth:providers",
      requestId,
      runtime,
    }), (event, attrs) => this.recordMachineResponseRelay(event, attrs));
    if (response.type !== "machine:runtime_auth:providers:result") throw new Error("Unexpected providers response");
    const parsed = runtimeAuthProvidersResultSchema.safeParse(response.result);
    return parsed.success ? parsed.data : { kind: "failed", reason: "invalid_response" };
  }

  /**
   * Saves a provider's API key in the runtime's settings on the Computer.
   * The key is sent once, in this one command over the Computer's socket
   * (sealed if it crosses replicas), and kept nowhere: not in the reply
   * record, not in a trace, not in a log. The reply carries the outcome only.
   */
  async connectRuntimeProvider(machineId: string, runtime: RuntimeAuthRuntime, input: RuntimeAuthProviderConnectInput): Promise<RuntimeAuthProviderConnectResult> {
    if (!runtimeAuthSupports(runtime, "connect_provider")) throw new Error(`${runtime} has no provider connect`);
    const requestId = crypto.randomUUID();
    const response = await this.getMachineResponseRelay().request({
      requestId, machineId, type: "machine:runtime_auth:connect_provider:result",
    }, RUNTIME_AUTH_PROVIDER_RELAY_BUDGET_MS, () => this.sendRequiredToMachine(machineId, {
      type: "machine:runtime_auth:connect_provider",
      requestId,
      runtime,
      ...input,
    }), (event, attrs) => this.recordMachineResponseRelay(event, attrs));
    if (response.type !== "machine:runtime_auth:connect_provider:result") throw new Error("Unexpected connect response");
    const parsed = runtimeAuthProviderConnectResultSchema.safeParse(response.result);
    const result: RuntimeAuthProviderConnectResult = parsed.success ? parsed.data : { kind: "failed", reason: "invalid_response" };
    if (result.kind === "connected") await this.liftRuntimeCredentialBlocks(machineId, runtime, "connect_provider");
    return result;
  }

  /**
   * #proj-raft-computer:#68: store the Computer's readiness report unless an
   * older one (`seq` not above the stored), tell every viewer of the
   * Computer and its agents to re-read (content-free: each read is trimmed
   * for its viewer), and tell the owner once about each blocked fact that
   * just appeared, one notice listing the agents it holds, at most once a day
   * per login and code (readinessFactsToNotify), claimed in the store's
   * transaction so racing reports tell once; a claim nobody was told about
   * is given back. Best effort.
   */
  private async ingestRuntimeReadiness(machineId: string, serverId: string, msg: unknown): Promise<void> {
    const report = parseRuntimeReadinessReport(msg);
    if (!report) return;
    try {
      const receivedAtMs = this.clock.now();
      const stored = await storeRuntimeReadinessReport(machineId, report, new Date(receivedAtMs));
      if (!stored) return;
      this.io?.to(`server:${serverId}`).emit("machine:updated", { serverId, machineId });
      const agents = await this.loadAgentsForReadyReconcile(machineId);
      for (const room of new Set(agents.map((agent) => agentEventRoom(agent.serverId, agent.assistantOwnerUserId)))) {
        this.io?.to(room).emit("agent:updated", { machineId });
      }
      const fresh = stored.toNotify;
      if (fresh.length === 0) return;
      const told: string[] = [];
      if (!this.io) {
        await releaseReadinessNotices(machineId, fresh.map((fact) => readinessNoticeKey(fact)!), receivedAtMs);
        return;
      }
      const machine = await machineService.getMachine(asMachineId(machineId));
      const candidates = agents.map((agent) => ({ ...agent, ownerUserId: agent.creatorType === "user" ? agent.creatorId : null }));
      for (const fact of fresh) {
        const plan = readinessNoticePlan(fact, candidates, machine?.ownerUserId ?? machine?.userId ?? null);
        if (!plan || fact.resource.kind !== "login") continue;
        const machineLogin = fact.resource.key.startsWith("shared:");
        const runtime = machineLogin ? fact.resource.key.slice("shared:".length) : candidates.find((agent) => agent.id === plan.agents[0]!.id)?.runtime ?? "claude";
        const agentNames = plan.agents.map((agent) => agent.name);
        // One notice, in the DM with the first affected agent that has one with the recipient.
        for (const agent of plan.agents) {
          const posted = await postAgentActionRequiredNotice(this.io, this, {
            agentId: agent.id,
            ownerUserId: plan.recipientUserId,
            notice: { kind: "readiness_blocked", code: fact.code, runtime, computerName: machine?.name ?? "", machineLogin, agentNames },
          }).catch(() => false);
          if (posted) {
            told.push(readinessNoticeKey(fact)!);
            break;
          }
        }
      }
      const untold = fresh.map((fact) => readinessNoticeKey(fact)!).filter((key) => !told.includes(key));
      await releaseReadinessNotices(machineId, untold, receivedAtMs);
    } catch (error) {
      console.warn(`[Machine ${machineId}] Runtime readiness report failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * #proj-raft-computer:#46 stop-gap: a web login or provider connect for
   * `runtime` succeeded on this Computer. Agents there on that runtime's
   * machine-shared credentials (`sharedCredentialsAuthRuntime`: not one with
   * its own credential home in its env vars or its own provider) were paused
   * only because the old sign-in was rejected or missing: they wake normally
   * again, as after a runtime config change, but only that block is lifted.
   * Nothing is started here. The daemon clears its own side
   * (AgentProcessManager.noteRuntimeCredentialsChanged). Best effort.
   * `disk` (reconciler step 15, the daemon's
   * `machine:runtime_credentials:changed`): a sign-in in a terminal, which
   * lifts the sign-in pauses only (`liftForCredentialsChange` scope `sign_in`).
   */
  private async liftRuntimeCredentialBlocks(machineId: string, runtime: RuntimeAuthRuntime, reason: "login" | "connect_provider" | "disk"): Promise<void> {
    try {
      for (const agent of await this.loadAgentsForReadyReconcile(machineId)) {
        if (sharedCredentialsAuthRuntime(agent) !== runtime) continue;
        if (await this.wakeCrashLoopBreaker.liftForCredentialsChange(agent.id, reason === "disk" ? "sign_in" : "credentials_change")) {
          this.recordEvent("wake.block_lifted", {
            cause: "runtime_credentials_changed",
            source: "credentials_change",
            release_cause: "credentials_changed",
            runtime,
            credentials_change: reason,
          });
        }
      }
    } catch (error) {
      console.warn(`[Machine ${machineId}] Lifting sign-in pauses after a ${reason} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * task #25 step 2: a person stops the agent's current turn; the agent keeps
   * running. Works from any replica: the computer's capability comes from the
   * cross-replica carrier fact and the daemon's answer through the response
   * relay. A computer whose daemon predates the command is told apart, so the
   * person can be asked to upgrade it instead of waiting for a timeout.
   */
  async interruptAgentTurn(agentId: string, machineId: string | null): Promise<AgentTurnInterruptRequestResult> {
    if (!machineId) return { outcome: "not_running" };
    const fact = await this.readProbeCarrierFact(machineId);
    if (!fact) return { outcome: "computer_offline" };
    if (!fact.capabilities.includes(DAEMON_CAPABILITY_INTERRUPT_TURN)) return { outcome: "computer_upgrade_required" };
    const requestId = crypto.randomUUID();
    const response = await this.getMachineResponseRelay().request({
      requestId, machineId, type: "agent:interrupt-turn:result", agentId,
    }, INTERRUPT_TURN_RELAY_BUDGET_MS, () => this.sendRequiredToMachine(machineId, {
      type: "agent:interrupt-turn",
      agentId,
      requestId,
    }), (event, attrs) => this.recordMachineResponseRelay(event, attrs));
    if (response.type !== "agent:interrupt-turn:result") throw new Error("Unexpected interrupt-turn response");
    return {
      outcome: response.outcome,
      ...(typeof response.toolName === "string" ? { toolName: response.toolName } : {}),
      ...(typeof response.stuckForMs === "number" ? { stuckForMs: response.stuckForMs } : {}),
    };
  }

  /**
   * #proj-runtime:#41: a person stops one of the agent's running sub-agents;
   * the agent and its other sub-agents keep running. Same carrier and relay
   * as interruptAgentTurn.
   */
  async interruptAgentSubagent(agentId: string, machineId: string | null, subagentTaskId: string): Promise<AgentSubagentInterruptRequestResult> {
    if (!machineId) return { outcome: "not_running" };
    const fact = await this.readProbeCarrierFact(machineId);
    if (!fact) return { outcome: "computer_offline" };
    if (!fact.capabilities.includes(DAEMON_CAPABILITY_INTERRUPT_SUBAGENT)) return { outcome: "computer_upgrade_required" };
    const requestId = crypto.randomUUID();
    const response = await this.getMachineResponseRelay().request({
      requestId, machineId, type: "agent:interrupt-subagent:result", agentId,
    }, INTERRUPT_TURN_RELAY_BUDGET_MS, () => this.sendRequiredToMachine(machineId, {
      type: "agent:interrupt-subagent",
      agentId,
      requestId,
      subagentTaskId,
    }), (event, attrs) => this.recordMachineResponseRelay(event, attrs));
    if (response.type !== "agent:interrupt-subagent:result") throw new Error("Unexpected interrupt-subagent response");
    return { outcome: response.outcome };
  }

  async requestProviderProbe(
    machineId: string,
    input: { requestId: string; probeId: string; runtime: string; model: string },
  ): Promise<Extract<MachineToServerMessage, { type: "machine:provider_probe:result" }>> {
    const response = await this.getMachineResponseRelay().request({
      requestId: input.requestId, machineId, type: "machine:provider_probe:result", probeId: input.probeId,
    }, PROVIDER_PROBE_RELAY_BUDGET_MS, () => this.sendRequiredToMachine(machineId, {
      type: "machine:provider_probe:request",
      requestId: input.requestId,
      probeId: input.probeId,
      runtime: input.runtime,
      model: input.model,
    }), (event, attrs) => this.recordMachineResponseRelay(event, attrs));
    if (response.type !== "machine:provider_probe:result") throw new Error("Unexpected probe response");
    return response;
  }

  /**
   * Probe carrier fact fields mirrored through the replica state store so a
   * non-owner replica can verify dispatch authority (F1). Rewritten on ready
   * and every heartbeat while the connection is live.
   */
  private probeCarrierMetaFields(
    conn: MachineConnection,
    normalizedRuntimeVersions?: Record<string, string>,
  ): {
    probeCapabilities: string;
    probeConnectionEpochId: string | null;
    probeReplicaGeneration: string | null;
    probeObservedAt: string;
    probeRuntimeVersions: string;
    probeRuntimeDetection: string | null;
  } {
    return {
      probeCapabilities: JSON.stringify([...conn.capabilities].sort()),
      probeConnectionEpochId: conn.connectionEpochId ?? null,
      probeReplicaGeneration: conn.replicaGeneration ?? null,
      probeObservedAt: new Date(currentTimeMs()).toISOString(),
      probeRuntimeVersions: JSON.stringify(normalizedRuntimeVersions ?? conn.runtimeVersions ?? {}),
      probeRuntimeDetection: conn.runtimeDetection ? JSON.stringify(conn.runtimeDetection) : null,
    };
  }

  /**
   * task #1268: the machine's runtime detection state (pending / complete /
   * incomplete with unfinished runtimes), from the owner replica's connection
   * or the replica meta. Null for synchronous daemons and unknown machines.
   */
  async getMachineRuntimeDetection(machineId: string): Promise<MachineRuntimeDetectionState | null> {
    const local = this.machineConnections.get(machineId);
    if (local) return local.runtimeDetection ?? null;
    if (!this.replicaStateStore.isAvailable()) return null;
    try {
      return runtimeDetectionFromMachineMeta(await this.replicaStateStore.getMachineMeta(machineId));
    } catch {
      return null;
    }
  }

  /**
   * Cross-replica probe carrier fact: the owner replica's live connection when
   * local, otherwise the Redis machine-meta mirror. Freshness is bounded so a
   * forgotten connection can never keep authorizing probes.
   */
  async readProbeCarrierFact(machineId: string): Promise<{
    capabilities: string[];
    connectionEpochId: string;
    replicaGeneration: string;
    daemonVersion: string | null;
    computerVersion: string | null;
    runtimes: string[];
    runtimeVersions: Record<string, string>;
  } | null> {
    const local = this.machineConnections.get(machineId);
    if (local?.connectionEpochId && local.replicaGeneration) {
      // Owner replica: the live socket must be open and the heartbeat fresh,
      // otherwise the fact is not authoritative for a new dispatch.
      if (local.ws.readyState !== 1 || this.isMachineHeartbeatStale(local)) return null;
      return {
        capabilities: [...local.capabilities],
        connectionEpochId: local.connectionEpochId,
        replicaGeneration: local.replicaGeneration,
        daemonVersion: local.daemonVersion ?? null,
        computerVersion: local.computerVersion ?? null,
        runtimes: [...(local.runtimes ?? [])],
        runtimeVersions: { ...(local.runtimeVersions ?? {}) },
      };
    }
    const meta = await this.replicaStateStore.getMachineMeta(machineId);
    const snapshot = parseProbeCarrierMeta(meta ?? {});
    if (!snapshot || !isProbeCarrierFactLive(snapshot, currentTimeMs())) return null;
    return {
      capabilities: snapshot.capabilities,
      connectionEpochId: snapshot.connectionEpochId,
      replicaGeneration: snapshot.replicaGeneration,
      daemonVersion: snapshot.daemonVersion,
      computerVersion: snapshot.computerVersion,
      runtimes: Object.keys(snapshot.runtimeVersions),
      runtimeVersions: snapshot.runtimeVersions,
    };
  }

  /** Dispatch authority of the current machine connection, if any. */
  getMachineAuthority(machineId: string): { connectionEpochId: string; replicaGeneration: string } | null {
    const connection = this.machineConnections.get(machineId);
    if (!connection?.connectionEpochId || !connection.replicaGeneration) return null;
    return {
      connectionEpochId: connection.connectionEpochId,
      replicaGeneration: connection.replicaGeneration,
    };
  }

  /**
   * `force`: bypass the Computer's model-list cache (a form's refresh action,
   * `?refresh=1`). Daemons without the cache ignore it; they detect every time.
   */
  async detectMachineRuntimeModels(
    machineId: string,
    runtime: string,
    options: { force?: boolean } = {},
  ): Promise<RuntimeModelSourceOutcome> {
    // Plain model discovery does not consume connection-generation authority.
    // Built-in admission continues to use the local, fenced WithAuthority path.
    let outcome: RuntimeModelSourceOutcome;
    if (!this.machineConnections.has(machineId)) {
      const requestId = crypto.randomUUID();
      const response = await this.getMachineResponseRelay().request({
        requestId, machineId, type: "machine:runtime_models:result",
      }, runtimeModelDetectionRequestTimeoutMs(runtime), () => this.sendRequiredToMachine(machineId, {
        type: "machine:runtime_models:detect", requestId, runtime, ...(options.force ? { force: true } : {}),
      }), (event, attrs) => this.recordMachineResponseRelay(event, attrs));
      if (response.type !== "machine:runtime_models:result") throw new Error("Unexpected model response");
      outcome = projectRuntimeModelSourceResult(response, runtime);
    } else {
      outcome = (
        await this.detectMachineRuntimeModelsWithAuthority(machineId, runtime, options)
      ).outcome;
    }
    // A live detection is a fresh report of the machine's model list; keep
    // the shared display catalog current without waiting for the proactive
    // `machine:runtime_models:catalog` frame (task #700).
    if (outcome.kind === "live") {
      await machineRuntimeModelCatalogService.writeRuntime(machineId, runtime, outcome.value.models);
    }
    return outcome;
  }

  async detectMachineRuntimeModelsWithAuthority(
    machineId: string,
    runtime: string,
    options: { force?: boolean } = {},
  ): Promise<MachineRuntimeModelDetection> {
    const connection = this.machineConnections.get(machineId);
    if (
      !connection ||
      !connection.replicaGeneration ||
      connection.ws.readyState !== 1 ||
      this.isMachineHeartbeatStale(connection)
    ) {
      throw new RouteFailureError(
        "daemon_offline",
        "Failed to send request — machine WebSocket not ready",
      );
    }
    const authority = {
      connectionEpochId: connection.connectionEpochId,
      replicaGeneration: connection.replicaGeneration,
    };
    const requestId = crypto.randomUUID();

    return new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeListener(`machine:response:${machineId}`, handler);
        // Server-structural classification: we waited and the daemon never
        // answered. This is knowable at the throw site, so tag it.
        reject(new RouteFailureError("daemon_timeout", "Runtime model detect request timed out"));
      }, runtimeModelDetectionRequestTimeoutMs(runtime));

      const handler = (msg: MachineToServerMessage) => {
        if (msg.type === "machine:runtime_models:result" && msg.requestId === requestId) {
          clearTimeout(timeout);
          this.removeListener(`machine:response:${machineId}`, handler);
          const current = this.machineConnections.get(machineId);
          if (
            current?.connectionEpochId !== authority.connectionEpochId ||
            current.replicaGeneration !== authority.replicaGeneration
          ) {
            reject(new MachineCatalogStaleError());
            return;
          }
          resolve({
            outcome: projectRuntimeModelSourceResult(msg, runtime),
            authority,
            daemonVersion: current.daemonVersion,
            computerVersion: current.computerVersion,
          });
        }
      };

      this.on(`machine:response:${machineId}`, handler);

      try {
        await this.sendRequiredToMachine(machineId, {
          type: "machine:runtime_models:detect",
          requestId,
          runtime,
          ...(options.force ? { force: true } : {}),
        });
      } catch {
        clearTimeout(timeout);
        this.removeListener(`machine:response:${machineId}`, handler);
        // Server-structural classification: send failed because the machine WS
        // is not ready — i.e. the daemon is effectively offline for this call.
        reject(new RouteFailureError("daemon_offline", "Failed to send request — machine WebSocket not ready"));
      }
    });
  }

  async validateBuiltInPresetForMachine(
    machineId: string,
    config: RuntimeConfig,
  ): Promise<
    | (BuiltInModelCatalogValidation & {
        authority: MachineConnectionGeneration;
      })
    | null
  > {
    if (!isBuiltInCatalogCheckedSelection(config)) return null;
    const requestedModel = config.model.kind === "preset" ? config.model.id : config.model.name;
    let detection: MachineRuntimeModelDetection;
    try {
      detection = await this.detectMachineRuntimeModelsWithAuthority(
        machineId,
        "builtin",
      );
    } catch (error) {
      if (!(error instanceof RouteFailureError)) throw error;
      const connection = this.machineConnections.get(machineId);
      throw new BuiltInModelCatalogError(
        "builtin_catalog_unavailable",
        "The target Computer's Built-in model catalog is unavailable. Retry after the Computer reconnects.",
        {
          requestedModel,
          daemonVersion: connection?.daemonVersion ?? null,
          computerVersion: connection?.computerVersion ?? null,
          recovery: "retry",
        },
      );
    }
    const validation = assertBuiltInPresetSupportedByCatalog(
      config,
      detection.outcome,
      {
        machineId,
        daemonVersion: detection.daemonVersion,
        computerVersion: detection.computerVersion,
      },
    );
    return validation
      ? { ...validation, authority: detection.authority }
      : null;
  }

  acquireBuiltInCatalogAuthority(
    machineId: string,
    authority: MachineConnectionGeneration,
  ): () => void {
    return this.machineCatalogAuthority.acquire(machineId, authority);
  }

  async readAgentFile(agentId: string, filePath: string, archivedOnMachineId?: string): Promise<{ content: string | null; binary: boolean; size: number; mimeType?: string; encoding?: "utf-8" | "base64" }> {
    const result = archivedOnMachineId
      ? (this.hasMachineLocally(archivedOnMachineId) ? { machineId: archivedOnMachineId } : null)
      : await this.getMachineForAgent(agentId);
    if (!result) throw new RouteFailureError("daemon_offline", "Agent has no connected machine");
    const { machineId } = result;

    const requestId = crypto.randomUUID();

    return new Promise(async (resolve, reject) => {
      const timeout = this.scheduleOnClock(() => {
        this.removeListener(`machine:response:${machineId}`, handler);
        reject(new RouteFailureError("daemon_timeout", "File read request timed out"));
      }, 15_000);

      const handler = (msg: MachineToServerMessage) => {
        if (msg.type === "agent:workspace:file_content" && msg.agentId === agentId && msg.requestId === requestId) {
          this.clock.clearTimeout(timeout);
          this.removeListener(`machine:response:${machineId}`, handler);
          resolve({
            content: msg.content,
            binary: msg.binary,
            size: msg.size ?? (msg.content ? Buffer.byteLength(msg.content, msg.encoding === "base64" ? "base64" : "utf-8") : 0),
            mimeType: msg.mimeType,
            encoding: msg.encoding,
          });
        }
      };

      this.on(`machine:response:${machineId}`, handler);

      try {
        await this.sendRequiredToMachine(machineId, { type: "agent:workspace:read", agentId, path: filePath, requestId });
      } catch {
        this.clock.clearTimeout(timeout);
        this.removeListener(`machine:response:${machineId}`, handler);
        reject(new RouteFailureError("daemon_offline", "Failed to send request — machine WebSocket not ready"));
      }
    });
  }

  // Agent skills listing

  /**
   * Record one skills list result as a span under the machine message span. The way the result matches
   * a pending request is recorded as a server.agent.skills.list event on it.
   */
  private observeAgentSkillsListResult(
    machineId: string,
    msg: Extract<MachineToServerMessage, { type: "agent:skills:list_result" }>,
  ): void {
    const baseAttrs = {
      agent_id: msg.agentId,
      machine_id: machineId,
      request_id_present: Boolean(msg.requestId),
      global_count: msg.global.length,
      workspace_count: msg.workspace.length,
    };
    const span = this.tracer.startSpan("server.agent.skills.list_result", {
      parent: getCurrentTraceContext(),
      surface: "server",
      kind: "consumer",
      attrs: { ...baseAttrs, request_id: msg.requestId },
    });
    let resultOutcome = "ignored";
    let resultStatus: TraceStatus = "ok";
    const recordResult = (outcome: string, attrs: TraceAttributes, status: TraceStatus = "ok") => {
      resultOutcome = outcome;
      resultStatus = status;
      this.recordEvent("server.agent.skills.list", { outcome, ...attrs });
    };
    try {
      this.runInActiveSpan(span, () => this.matchAgentSkillsListResult(machineId, msg, baseAttrs, recordResult));
    } catch (error) {
      span.end("error", { attrs: { error_class: errorClassOf(error) } });
      throw error;
    }
    span.end(resultStatus, { attrs: { outcome: resultOutcome } });
  }

  private matchAgentSkillsListResult(
    machineId: string,
    msg: Extract<MachineToServerMessage, { type: "agent:skills:list_result" }>,
    baseAttrs: TraceAttributes,
    recordResult: (outcome: string, attrs: TraceAttributes, status?: TraceStatus) => void,
  ): void {
    if (msg.requestId) {
      const pending = this.pendingAgentSkillsListRequests.get(msg.requestId);
      if (!pending) {
        recordResult("unmatched_request_id", {
          ...baseAttrs,
          request_id: msg.requestId,
        });
        return;
      }

      if (pending.agentId !== msg.agentId) {
        recordResult("wrong_agent_for_request_id", {
          ...baseAttrs,
          request_id: msg.requestId,
          expected_agent_id: pending.agentId,
          runtime: pending.runtime,
          duration_ms: Math.max(0, this.clock.now() - pending.startedAtMs),
        }, "error");
        return;
      }

      if (pending.machineId !== machineId) {
        recordResult("wrong_machine_for_request_id", {
          ...baseAttrs,
          request_id: msg.requestId,
          expected_machine_id: pending.machineId,
          runtime: pending.runtime,
          duration_ms: Math.max(0, this.clock.now() - pending.startedAtMs),
        }, "error");
        return;
      }

      recordResult(pending.timedOut ? "late_after_timeout" : "result_before_timeout", {
        ...baseAttrs,
        request_id: msg.requestId,
        runtime: pending.runtime,
        duration_ms: Math.max(0, this.clock.now() - pending.startedAtMs),
      });
      return;
    }

    const matchingPending = this.countMatchingLegacyAgentSkillsPending(machineId, msg.agentId);

    if (matchingPending.activeCount > 0) {
      recordResult(matchingPending.activeCount === 1 ? "legacy_unscoped_result" : "legacy_ambiguous_result", {
        ...baseAttrs,
        matching_pending_count: matchingPending.activeCount,
        retained_timeout_count: matchingPending.retainedTimeoutCount,
      }, matchingPending.activeCount === 1 ? "ok" : "error");
      return;
    }

    if (matchingPending.retainedTimeoutCount > 0) {
      recordResult("legacy_late_after_timeout", {
        ...baseAttrs,
        matching_pending_count: 0,
        retained_timeout_count: matchingPending.retainedTimeoutCount,
      });
    }
  }

  private countMatchingLegacyAgentSkillsPending(machineId: string, agentId: string): { activeCount: number; retainedTimeoutCount: number } {
    let activeCount = 0;
    let retainedTimeoutCount = 0;
    for (const pending of this.pendingAgentSkillsListRequests.values()) {
      if (pending.machineId === machineId && pending.agentId === agentId) {
        if (pending.timedOut) {
          retainedTimeoutCount += 1;
        } else {
          activeCount += 1;
        }
      }
    }
    return { activeCount, retainedTimeoutCount };
  }

  async getAgentSkills(agentId: string, runtime?: string): Promise<{ global: SkillInfo[]; workspace: SkillInfo[] }> {
    const result = await this.getMachineForAgent(agentId);
    if (!result) throw new RouteFailureError("daemon_offline", "Agent has no connected machine");
    const { machineId } = result;

    return new Promise(async (resolve, reject) => {
      const eventName = `machine:response:${machineId}`;
      const disconnectEventName = `machine:disconnect:${machineId}`;
      const requestId = crypto.randomUUID();
      const startedAtMs = this.clock.now();
      let settled = false;
      const span = this.tracer.startSpan("server.agent.skills.list", {
        parent: getCurrentTraceContext(),
        surface: "server",
        kind: "internal",
        attrs: {
          agent_id: agentId,
          machine_id: machineId,
          runtime: runtime || "auto",
          request_id: requestId,
        },
      });
      const endSpan = (status: TraceStatus, attrs: TraceAttributes) => {
        span.end(status, {
          attrs: { ...attrs, duration_ms: Math.max(0, this.clock.now() - startedAtMs) },
        });
      };
      const pending: PendingAgentSkillsListRequest = {
        agentId,
        machineId,
        runtime: runtime || "auto",
        startedAtMs,
        timedOut: false,
        timeoutTimer: null,
        observationTimer: null,
      };

      const cleanup = () => {
        if (pending.timeoutTimer) {
          this.clock.clearTimeout(pending.timeoutTimer);
          pending.timeoutTimer = null;
        }
        if (pending.observationTimer) {
          this.clock.clearTimeout(pending.observationTimer);
          pending.observationTimer = null;
        }
        this.removeListener(eventName, handler);
        this.removeListener(disconnectEventName, disconnectHandler);
        this.pendingAgentSkillsListRequests.delete(requestId);
      };

      const timeout = this.scheduleOnClock(() => {
        if (settled) return;
        settled = true;
        pending.timedOut = true;
        pending.timeoutTimer = null;
        endSpan("error", {
          outcome: "timeout",
          timeout_ms: AgentOrchestrator.AGENT_SKILLS_LIST_TIMEOUT_MS,
        });
        reject(new RouteFailureError("daemon_timeout", "Skills list request timed out"));
        pending.observationTimer = this.scheduleOnClock(() => {
          cleanup();
        }, AgentOrchestrator.AGENT_SKILLS_LIST_LATE_RESULT_OBSERVATION_MS);
      }, AgentOrchestrator.AGENT_SKILLS_LIST_TIMEOUT_MS);
      pending.timeoutTimer = timeout;

      const handler = (msg: MachineToServerMessage) => {
        if (msg.type !== "agent:skills:list_result" || msg.agentId !== agentId) return;
        if (msg.requestId && msg.requestId !== requestId) return;
        if (!msg.requestId && this.countMatchingLegacyAgentSkillsPending(machineId, agentId).activeCount !== 1) return;
        if (settled) {
          cleanup();
          return;
        }
        settled = true;
        cleanup();
        endSpan("ok", {
          outcome: "result_received",
          global_count: msg.global.length,
          workspace_count: msg.workspace.length,
        });
        resolve({ global: msg.global, workspace: msg.workspace });
      };

      const disconnectHandler = (context: MachineDisconnectContext = {}) => {
        if (settled) return;
        settled = true;
        endSpan("error", {
          outcome: "disconnected_before_result",
          disconnect_cause: context.cause || "socket_close",
        });
        cleanup();
        reject(new RouteFailureError("daemon_offline", "Machine disconnected while listing skills"));
      };

      this.pendingAgentSkillsListRequests.set(requestId, pending);
      this.on(eventName, handler);
      this.on(disconnectEventName, disconnectHandler);

      try {
        await this.runInActiveSpan(span, () =>
          this.sendRequiredToMachine(machineId, { type: "agent:skills:list", agentId, runtime, requestId }));
      } catch (error) {
        if (settled) return;
        settled = true;
        cleanup();
        endSpan("error", { outcome: "send_failed", error_class: errorClassOf(error) });
        reject(new RouteFailureError("daemon_offline", "Failed to send request — machine WebSocket not ready"));
      }
    });
  }

  async getAgentSessionTranscript(agentId: string): Promise<{
    runtime: string;
    sessionId: string;
    reachable: boolean;
    path: string | null;
    fallbackReason?: string;
    transcript: string | null;
    sizeBytes: number;
    truncated: boolean;
    redacted: boolean;
    tier: string;
    error?: string;
  }> {
    const result = await this.getMachineForAgent(agentId);
    if (!result) throw new Error("Agent has no connected machine");
    const { machineId } = result;

    const requestId = crypto.randomUUID();

    return new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeListener(`machine:response:${machineId}`, handler);
        reject(new Error("Session transcript request timed out"));
      }, 15_000);

      const handler = (msg: MachineToServerMessage) => {
        if (msg.type === "agent:diagnostic:session_transcript_result" && msg.agentId === agentId && msg.requestId === requestId) {
          clearTimeout(timeout);
          this.removeListener(`machine:response:${machineId}`, handler);
          resolve({
            runtime: msg.runtime,
            sessionId: msg.sessionId,
            reachable: msg.reachable,
            path: msg.path,
            fallbackReason: msg.fallbackReason,
            transcript: msg.transcript,
            sizeBytes: msg.sizeBytes,
            truncated: msg.truncated,
            redacted: msg.redacted,
            tier: msg.tier,
            error: msg.error,
          });
        }
      };

      this.on(`machine:response:${machineId}`, handler);

      try {
        await this.sendRequiredToMachine(machineId, { type: "agent:diagnostic:session_transcript", agentId, requestId });
      } catch {
        clearTimeout(timeout);
        this.removeListener(`machine:response:${machineId}`, handler);
        reject(new Error("Failed to send request — machine WebSocket not ready"));
      }
    });
  }

  /**
   * The launch fields and stored session id of an agent, for a feedback
   * transcript request (FeedbackTranscriptSessionLookup): what the session
   * lookup needs of the values `buildAgentConfig` puts in an `agent:start`,
   * and of the env vars only those the session directory depends on.
   * Null when the agent cannot be read.
   */
  private async feedbackTranscriptSessionLookup(agentId: string): Promise<FeedbackTranscriptSessionLookup | null> {
    try {
      const agent = await this.loadAgentForDelivery(agentId);
      if (!agent) return null;
      const launch = runtimeConfigToLaunchFields(hydrateRuntimeConfig(agent));
      return {
        runtime: launch.runtime,
        model: launch.model,
        // Never the agent's runtime settings or its other env vars (provider keys live there).
        sessionHomeEnv: runtimeSessionHomeEnvVars(launch.runtime, launch.envVars),
        sessionId: agent.sessionId,
      };
    } catch (err) {
      console.warn(`[Agent ${agentId}] Feedback transcript session lookup unavailable; the daemon will use its own memory:`, err instanceof Error ? err.message : err);
      return null;
    }
  }

  /**
   * Ask the daemon to collect the agent's current session transcript and upload
   * it as a trace bundle linked to a feedback report. This is intentionally
   * fire-and-forget from the HTTP route's perspective: callers receive a job id
   * immediately and the transcript upload proceeds in the background.
   */
  async collectFeedbackTranscript(
    agentId: string,
    feedbackReportId: string,
    reportWindow: {
      reportGeneratedAt: string;
      reportTimeSource: FeedbackTranscriptReportTimeSource;
    },
    options: { includeMachineLogTail?: boolean } = {},
  ): Promise<{
    traceBundleId?: string;
    reachable: boolean;
    fallbackReason?: string;
    error?: string;
    transcriptWindow?: FeedbackTranscriptWindow;
    machineLogTail?: FeedbackMachineLogTailOutcome;
    machineEvidence?: FeedbackMachineEvidenceOutcome;
    outcomeVersion?: 1;
    lookup?: FeedbackTranscriptLookupOutcome;
    upload?: FeedbackTranscriptUploadOutcome;
    outcomeObject?: FeedbackTranscriptOutcomeObjectPlan;
  }> {
    // task #1228 ①: one span per request, ended with the state the server
    // observed (machine_not_connected | send_failed | daemon_timeout | result).
    // Best-effort like every span: absent when trace export is off.
    const span = this.tracer.startSpan("server.feedback_transcript.request", {
      surface: "server",
      kind: "internal",
      attrs: {
        feedback_report_id: feedbackReportId,
        agent_id: agentId,
        report_time_source: reportWindow.reportTimeSource,
        include_machine_log_tail: options.includeMachineLogTail === true,
      },
    });
    const result = await this.getMachineForAgent(agentId);
    if (!result) {
      span.end("error", { attrs: { state: "machine_not_connected" } });
      throw new Error("Agent has no connected machine");
    }
    const { machineId } = result;

    const requestId = crypto.randomUUID();
    // Never a reason to fail the request: without it the daemon answers from its own memory, as before.
    const sessionLookup = await this.feedbackTranscriptSessionLookup(agentId);

    return new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeListener(`machine:response:${machineId}`, handler);
        // The route never waits; remember the request so a late result is
        // still recorded (bounded, TTL'd, ownership-checked, once).
        this.feedbackTranscriptLateResults.remember(requestId, { machineId, agentId, feedbackReportId });
        span.end("error", { attrs: { machine_id: machineId, request_id: requestId, state: "daemon_timeout" } });
        reject(new Error("Feedback transcript request timed out"));
      }, 30_000);

      const handler = (msg: MachineToServerMessage) => {
        if (msg.type === "agent:diagnostic:feedback_transcript_result" && msg.agentId === agentId && msg.feedbackReportId === feedbackReportId && msg.requestId === requestId) {
          clearTimeout(timeout);
          this.removeListener(`machine:response:${machineId}`, handler);
          // task #1228 ①: the typed fields are untrusted (the WebSocket layer
          // only JSON.parses). Only the strictly validated projection is
          // forwarded; a malformed one is dropped (legacy-compatible result)
          // and recorded as invalid. resolve runs BEFORE any span work, and
          // span work can never throw, so the request always completes.
          const read = readFeedbackTranscriptResultOutcomeSafely(msg);
          resolve({
            traceBundleId: msg.traceBundleId,
            reachable: msg.reachable,
            fallbackReason: msg.fallbackReason,
            error: msg.error,
            transcriptWindow: msg.transcriptWindow,
            ...(msg.machineLogTail ? { machineLogTail: msg.machineLogTail } : {}),
            ...(msg.machineEvidence ? { machineEvidence: msg.machineEvidence } : {}),
            ...(read.status === "typed"
              ? {
                outcomeVersion: 1 as const,
                lookup: read.lookup,
                upload: read.upload,
                ...(read.outcomeObject ? { outcomeObject: read.outcomeObject } : {}),
              }
              : {}),
          });
          try {
            span.end("ok", { attrs: { machine_id: machineId, request_id: requestId, state: "result", ...feedbackTranscriptOutcomeSpanAttrsSafely(msg, read) } });
          } catch {
            // Best-effort like every span; never affects the request.
          }
        }
      };

      this.on(`machine:response:${machineId}`, handler);

      try {
        await this.sendRequiredToMachine(machineId, {
          type: "agent:diagnostic:feedback_transcript",
          agentId,
          feedbackReportId,
          requestId,
          feedbackReportGeneratedAt: reportWindow.reportGeneratedAt,
          feedbackReportTimeSource: reportWindow.reportTimeSource,
          // A daemon that holds nothing for the agent (after its restart, or
          // the agent's terminal failure) finds the session file with it.
          ...(sessionLookup ? { sessionLookup } : {}),
          // Only ever true after the route verified the reporter owns the machine.
          ...(options.includeMachineLogTail ? { includeMachineLogTail: true } : {}),
        });
      } catch {
        clearTimeout(timeout);
        this.removeListener(`machine:response:${machineId}`, handler);
        span.end("error", { attrs: { machine_id: machineId, request_id: requestId, state: "send_failed" } });
        reject(new Error("Failed to send request — machine WebSocket not ready"));
      }
    });
  }

  /**
   * A feedback transcript result for a request the server already stopped
   * waiting for: recorded as `server.feedback_transcript.outcome{late}` when it
   * comes from the machine/agent/report it was asked of, once, within the TTL.
   * In-time results are not in the map and are ignored here.
   *
   * The entry is consumed only by a frame that is from the right
   * machine/agent/report AND whose typed fields are valid (or absent: an
   * older daemon). A malformed frame is recorded as rejected
   * (`invalid_outcome`) and leaves the entry in place, so a later valid frame
   * is still accepted once. Never throws: it runs before the in-time handlers.
   */
  private observeLateFeedbackTranscriptResult(
    machineId: string,
    msg: Extract<MachineToServerMessage, { type: "agent:diagnostic:feedback_transcript_result" }>,
  ): void {
    try {
      this.observeLateFeedbackTranscriptResultUnsafe(machineId, msg);
    } catch {
      // Observation only; must never break message handling.
    }
  }

  private observeLateFeedbackTranscriptResultUnsafe(
    machineId: string,
    msg: Extract<MachineToServerMessage, { type: "agent:diagnostic:feedback_transcript_result" }>,
  ): void {
    const decision = this.feedbackTranscriptLateResults.check(machineId, msg);
    if (decision.status === "unknown") return;
    if (decision.status === "accepted") {
      const read = readFeedbackTranscriptResultOutcomeSafely(msg);
      if (read.status === "invalid") {
        const rejected = this.tracer.startSpan("server.feedback_transcript.late_result_rejected", {
          surface: "server",
          kind: "internal",
          attrs: {
            machine_id: machineId,
            request_id: msg.requestId,
            reason: "invalid_outcome",
            ...feedbackTranscriptOutcomeSpanAttrsSafely(msg, read),
          },
        });
        rejected.end("error");
        return;
      }
      this.feedbackTranscriptLateResults.consume(msg.requestId);
      const span = this.tracer.startSpan("server.feedback_transcript.outcome", {
        surface: "server",
        kind: "internal",
        attrs: {
          late: true,
          late_by_ms: decision.lateByMs,
          feedback_report_id: msg.feedbackReportId,
          agent_id: msg.agentId,
          machine_id: machineId,
          request_id: msg.requestId,
          ...feedbackTranscriptOutcomeSpanAttrsSafely(msg, read),
        },
      });
      span.end("ok");
      return;
    }
    const span = this.tracer.startSpan("server.feedback_transcript.late_result_rejected", {
      surface: "server",
      kind: "internal",
      attrs: {
        machine_id: machineId,
        request_id: msg.requestId,
        reason: decision.status === "expired" ? "expired" : `ownership_mismatch_${decision.field}`,
      },
    });
    span.end("error");
  }

  // Machine workspace scanning

  async scanMachineWorkspaces(machineId: string): Promise<WorkspaceDirectoryInfo[]> {
    const conn = this.machineConnections.get(machineId);
    if (!conn || conn.ws.readyState !== 1) {
      throw new Error("Machine is not connected");
    }

    return new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeListener(`machine:response:${machineId}`, handler);
        reject(new Error("Workspace scan timed out"));
      }, 15_000);

      const handler = (msg: MachineToServerMessage) => {
        if (msg.type === "machine:workspace:scan_result") {
          clearTimeout(timeout);
          this.removeListener(`machine:response:${machineId}`, handler);
          resolve(msg.directories);
        }
      };

      this.on(`machine:response:${machineId}`, handler);
      try {
        await this.sendRequiredToMachine(machineId, { type: "machine:workspace:scan" });
      } catch {
        clearTimeout(timeout);
        this.removeListener(`machine:response:${machineId}`, handler);
        reject(new Error("Failed to send request — machine WebSocket not ready"));
      }
    });
  }

  async deleteMachineWorkspaceDir(machineId: string, directoryName: string): Promise<boolean> {
    const conn = this.machineConnections.get(machineId);
    if (!conn || conn.ws.readyState !== 1) {
      throw new Error("Machine is not connected");
    }

    return new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeListener(`machine:response:${machineId}`, handler);
        reject(new Error(WORKSPACE_DELETE_TIMED_OUT));
      }, 15_000);

      const handler = (msg: MachineToServerMessage) => {
        if (msg.type === "machine:workspace:delete_result" && msg.directoryName === directoryName) {
          clearTimeout(timeout);
          this.removeListener(`machine:response:${machineId}`, handler);
          resolve(msg.success);
        }
      };

      this.on(`machine:response:${machineId}`, handler);
      try {
        await this.sendRequiredToMachine(machineId, { type: "machine:workspace:delete", directoryName });
      } catch {
        clearTimeout(timeout);
        this.removeListener(`machine:response:${machineId}`, handler);
        reject(new Error("Failed to send request — machine WebSocket not ready"));
      }
    });
  }

  /**
   * deliverMessage's gates (passive scope unless intrinsic / admin authority,
   * target access) for persisted messages an EXTERNAL agent pulls from its
   * inbox rather than receiving into the buffer. One result per item.
   */
  protected loadRaftBenchServiceAgentIds(agentIds: readonly string[]): Promise<Set<string>> {
    return agentService.raftBenchServiceAgentIds(agentIds);
  }

  protected async isRaftBenchServiceAgent(agentId: string): Promise<boolean> {
    return (await this.loadRaftBenchServiceAgentIds([agentId])).has(agentId);
  }

  async filterExternalInboxDeliveries(
    agentId: string,
    items: Array<{ message: AgentMessage; options: DeliverMessageOptions }>,
  ): Promise<boolean[]> {
    if (items.length === 0) return [];
    const agent = await this.getAuthoritativeAgentForDelivery(agentId);
    if (!agent) return items.map(() => false);
    const serviceOnly = await this.isRaftBenchServiceAgent(agentId);
    let passiveScope: boolean | null = null;
    const results: boolean[] = [];
    for (const { message, options } of items) {
      if (serviceOnly && message.third_party_event?.client_id !== "system.raftbench") {
        results.push(false);
        continue;
      }
      if (!options.intrinsic && !options.adminAuthority) {
        passiveScope ??= await this.hasPassiveDeliveryScope(agentId).catch(() => false);
        if (!passiveScope) {
          results.push(false);
          continue;
        }
      }
      results.push(options.intrinsic ? true : await this.canAgentAccessDeliveryTarget(agentId, agent, message));
    }
    return results;
  }

  /** The persisted last heartbeat of a machine (the last pong of any replica's connection), if any. */
  protected async loadMachineLastHeartbeat(machineId: string): Promise<Date | null> {
    return (await machineService.getMachine(asMachineId(machineId)))?.lastHeartbeat ?? null;
  }

  /**
   * App event ids this replica still re-sends itself: an ack-retry record
   * (live or parked) or a pending start carrying one. Re-delivery skips them,
   * so a short outage does not reach the daemon twice.
   */
  private thirdPartyEventIdsInFlight(): string[] {
    const ids = new Set<string>();
    for (const pending of this.pendingAgentDeliveryAcks.values()) {
      const id = pending.msg.message.third_party_event?.id;
      if (id) ids.add(id);
    }
    for (const pending of this.pendingAgentStartAcks.values()) {
      const wake = (pending.msg as { wakeMessage?: AgentMessage }).wakeMessage;
      if (wake?.third_party_event?.id) ids.add(wake.third_party_event.id);
    }
    return [...ids];
  }

  /**
   * The outage start for the reconnect pass (resolveOutageStart): the persisted
   * last heartbeat, replaced by this replica's close time of the previous
   * connection when that is not earlier. A failed heartbeat read is not
   * "unknown, use the close time": the pass is skipped.
   */
  private async machineOutageStart(
    machineId: string,
    conn: { connectedAt?: number; previousCloseAt?: number } | undefined,
    connectedAtMs: number,
  ): Promise<OutageStart> {
    let lastHeartbeat: Date | null | "read_failed";
    try {
      lastHeartbeat = await this.loadMachineLastHeartbeat(machineId);
    } catch {
      lastHeartbeat = "read_failed";
    }
    return resolveOutageStart({ lastHeartbeat, closedAt: conn?.previousCloseAt, connectedAt: connectedAtMs });
  }

  /** Starts the reconnect pass for a `ready` without waiting for it (shutdown does). */
  private startThirdPartyEventReconnectPass(
    machineId: string,
    agentIds: readonly string[],
    conn: { connectedAt?: number; previousCloseAt?: number; daemonVersion: string | null } | undefined,
  ): void {
    const pass = this.runThirdPartyEventReconnectPass(machineId, agentIds, conn)
      .finally(() => {
        if (this.thirdPartyEventReconnectPasses.get(machineId) === pass) this.thirdPartyEventReconnectPasses.delete(machineId);
      });
    this.thirdPartyEventReconnectPasses.set(machineId, pass);
  }

  /** F9 load control: a pass starts after a uniform random delay in [0, this) from its `ready`. */
  static readonly READY_OWED_WAKE_MAX_DELAY_MS = 30_000;
  /** F9 load control: owed-wake checks run at most this many at a time per machine. */
  static readonly READY_OWED_WAKE_MACHINE_CONCURRENCY = 2;
  /**
   * F9 load control: owed-wake checks start at least this far apart across the
   * whole server process (at most 10 a second), whatever the number of
   * machines: a rolling server deploy reconnects every machine at once.
   */
  static readonly READY_OWED_WAKE_GLOBAL_INTERVAL_MS = 100;
  /**
   * F9 time floor (Tenny): only messages created at most this long before the
   * check are owed to this wake. Deliveries a restart lost are recent by
   * definition; an older owed backlog stays with the existing paths (the next
   * message, a reminder, a manual start, the agent's own inbox check).
   */
  static readonly READY_OWED_WAKE_MAX_AGE_MS = 24 * 60 * 60_000;

  private readonly readyOwedWakeSleeps = new Set<{ handle: unknown; resolve: () => void }>();

  private sleepForReadyOwedWake(ms: number): Promise<void> {
    if (ms <= 0 || this.readyOwedWakeStopped) return Promise.resolve();
    return new Promise((resolve) => {
      const sleep = { handle: null as unknown, resolve };
      sleep.handle = this.clock.setTimeout(() => {
        this.readyOwedWakeSleeps.delete(sleep);
        resolve();
      }, ms);
      this.readyOwedWakeSleeps.add(sleep);
    });
  }

  private stopReadyOwedWakePasses(): void {
    this.readyOwedWakeStopped = true;
    for (const sleep of this.readyOwedWakeSleeps) {
      this.clock.clearTimeout(sleep.handle);
      sleep.resolve();
    }
    this.readyOwedWakeSleeps.clear();
  }

  /** The next process-wide owed-wake slot (READY_OWED_WAKE_GLOBAL_INTERVAL_MS apart); resolves when it is due. */
  private takeReadyOwedWakeSlot(): Promise<void> {
    const now = this.clock.now();
    const at = Math.max(now, this.readyOwedWakeNextSlotAtMs);
    this.readyOwedWakeNextSlotAtMs = at + AgentOrchestrator.READY_OWED_WAKE_GLOBAL_INTERVAL_MS;
    return this.sleepForReadyOwedWake(at - now);
  }

  /**
   * Reconciler step 13 F9: a daemon `ready` wakes the agents whose wake a
   * restart lost. Before this, `ready` woke an agent only for a message this
   * replica still buffered in memory (maybeWakePendingInboxAfterReady); a
   * delivery the daemon had acked and then lost with its process (restart,
   * crash, upgrade), or a wake lost with the server replica, stayed unread
   * with nothing to wake the agent.
   *
   * Who: the agents the ready reconcile left wakeable and not running
   * (`mark-wakeable-not-running`: status active, no reset) with no buffered
   * wake, managed runtimes only. Only what the restart lost wakes them, never
   * "any unread" (Tenny, step 13 Q-D):
   *
   *   - offered: a conversation the chain view offers the agent unread in, up
   *     to the newest message it is offered (readyOwedCandidateTargets: the
   *     same membership, follow and mute rules that decide delivery, and with
   *     it the wake of a not-running agent: planWakeAction `attempt-wake`);
   *   - not consumed: past the agent's read position in Postgres. On a
   *     Computer that position moves when the model is shown a message
   *     (`agent:model-seen`), when the agent reads it itself (`raft message
   *     check` / `raft inbox check`), or replies after it; for a daemon
   *     without model-seen, at its delivery ack. A message the agent read
   *     mid-turn through the CLI is therefore never owed (Otter);
   *   - owed: a DM (or a thread in one), an unread @mention of the agent, or
   *     an unread message assigning it a task (owedReadBacklogTargets, the
   *     rule a completed first turn settles everything else by,
   *     unowedReadBacklog.ts). Plain channel traffic, a muted channel's
   *     messages and anything already read never wake;
   *   - recent: the owed message was created at most
   *     READY_OWED_WAKE_MAX_AGE_MS (24 h) before the check (Tenny): what a
   *     restart lost is recent; older backlog stays with the existing paths;
   *   - new to this wake: created after the check of the last owed wake
   *     dispatched for the agent (`ready_owed_wake_at` in the replica state
   *     store, shared by every replica, 24 h TTL, written only for a dispatched
   *     start). Each owed message wakes the agent through this path at most
   *     once, even if the woken agent never reads it and the daemon keeps
   *     restarting. Without the mark (store unreadable) nothing is woken.
   *
   * Every gate of a start still applies (startAgentHere: manual stop, the
   * version floor, the wake-crash-loop pause, the terminal-failure breaker
   * with its billing/credential failures; planWakeAction: migrations and
   * resets). The start carries no wake message: its catch-up, built with or
   * without a session, is what it owes.
   *
   * Load: not awaited by the `ready`; starts after a random delay
   * (READY_OWED_WAKE_MAX_DELAY_MS), checks READY_OWED_WAKE_MACHINE_CONCURRENCY
   * agents at a time, each check on a process-wide slot
   * (READY_OWED_WAKE_GLOBAL_INTERVAL_MS); one pass per machine (a `ready`
   * during it runs it once more afterwards); it stops once the socket is
   * replaced. Behind READY_WAKE_LOST_DELIVERIES_FEATURE_FLAG_KEY (default on).
   */
  private startReadyOwedWakePass(machineId: string, agentIds: readonly string[], conn: MachineConnection | undefined): void {
    if (agentIds.length === 0 || !conn || this.readyOwedWakeStopped) return;
    const run: ReadyOwedWakeRun = { agentIds: [...agentIds], serverId: conn.serverId, connectionEpochId: conn.connectionEpochId };
    const inFlight = this.readyOwedWakePasses.get(machineId);
    if (inFlight) {
      inFlight.rerun = run;
      this.recordEvent("machine.ready.owed_wake.deferred", { machine_id: machineId, agents_count: run.agentIds.length });
      return;
    }
    const state: { done: Promise<void>; rerun: ReadyOwedWakeRun | null } = { done: Promise.resolve(), rerun: null };
    this.readyOwedWakePasses.set(machineId, state);
    state.done = (async () => {
      let next: ReadyOwedWakeRun | null = run;
      while (next && !this.readyOwedWakeStopped) {
        state.rerun = null;
        await this.runReadyOwedWakePass(machineId, next);
        next = state.rerun;
      }
    })().finally(() => {
      if (this.readyOwedWakePasses.get(machineId) === state) this.readyOwedWakePasses.delete(machineId);
    });
  }

  /** Waits for the owed-wake passes in flight (tests). */
  async awaitReadyOwedWakePasses(): Promise<void> {
    // fanout-ok: awaits promises already in flight (one per machine pass); no I/O is started here.
    await Promise.all([...this.readyOwedWakePasses.values()].map((state) => state.done));
  }

  private isReadyOwedWakeConnectionCurrent(machineId: string, run: ReadyOwedWakeRun): boolean {
    return !this.readyOwedWakeStopped && this.machineConnections.get(machineId)?.connectionEpochId === run.connectionEpochId;
  }

  /** READY_WAKE_LOST_DELIVERIES_FEATURE_FLAG_KEY: no flag row is on; an evaluation failure is off. */
  protected async isReadyOwedWakeEnabled(serverId: string): Promise<boolean> {
    try {
      const evaluation = await evaluateFeatureFlag({ key: READY_WAKE_LOST_DELIVERIES_FEATURE_FLAG_KEY, serverId });
      return evaluation.reason === "missing_flag" ? true : evaluation.enabled;
    } catch (error) {
      console.warn(`[Orchestrator] ${READY_WAKE_LOST_DELIVERIES_FEATURE_FLAG_KEY} not evaluated for server ${serverId}; the ready owed wake is skipped:`, error instanceof Error ? error.message : error);
      return false;
    }
  }

  /** Never throws. */
  private async runReadyOwedWakePass(machineId: string, run: ReadyOwedWakeRun): Promise<void> {
    const counts = { checked: 0, owed: 0, started: 0 };
    try {
      await this.sleepForReadyOwedWake(Math.floor(this.readyOwedWakeRandom() * AgentOrchestrator.READY_OWED_WAKE_MAX_DELAY_MS));
      if (!this.isReadyOwedWakeConnectionCurrent(machineId, run)) {
        this.recordEvent("machine.ready.owed_wake.skipped", { machine_id: machineId, reason: "connection_replaced" });
        return;
      }
      if (!await this.isReadyOwedWakeEnabled(run.serverId)) {
        this.recordEvent("machine.ready.owed_wake.skipped", { machine_id: machineId, reason: "flag_off" });
        return;
      }
      const queue = [...run.agentIds];
      const worker = async () => {
        for (let agentId = queue.shift(); agentId !== undefined; agentId = queue.shift()) {
          await this.takeReadyOwedWakeSlot();
          if (!this.isReadyOwedWakeConnectionCurrent(machineId, run)) {
            queue.length = 0;
            return;
          }
          counts.checked += 1;
          const outcome = await this.maybeWakeOwedAfterReady(machineId, agentId, run);
          if (outcome !== "nothing_owed") counts.owed += 1;
          if (outcome === "started") counts.started += 1;
        }
      };
      await Promise.all(Array.from({ length: Math.min(AgentOrchestrator.READY_OWED_WAKE_MACHINE_CONCURRENCY, queue.length) }, worker));
      this.recordEvent("machine.ready.owed_wake.finished", {
        machine_id: machineId,
        agents_count: run.agentIds.length,
        checked_count: counts.checked,
        owed_count: counts.owed,
        started_count: counts.started,
      });
    } catch (err) {
      console.error(`[Orchestrator] ready owed wake pass failed for machine ${machineId}:`, err);
      this.recordEvent("machine.ready.owed_wake.failed", { machine_id: machineId, error_class: errorClassOf(err), ...counts });
    }
  }

  /**
   * Test seam: the conversations the agent owes something in past its read
   * position, created since `createdSince` (null: the chain is unavailable).
   */
  protected async readReadyOwedTargets(agentId: string, createdSince: Date): Promise<string[] | null> {
    const inbox = await this.selectResumeInbox(agentId);
    if (inbox.source === "unavailable") return null;
    const targets = readyOwedCandidateTargets(inbox.rows);
    if (targets.length === 0) return [];
    return owedReadBacklogTargets(getDb(), agentId, targets, { createdSince });
  }

  private async maybeWakeOwedAfterReady(
    machineId: string,
    agentId: string,
    run: ReadyOwedWakeRun,
  ): Promise<"nothing_owed" | "started" | "suppressed"> {
    const suppressed = (reason: string, attrs: Record<string, unknown> = {}) => {
      this.recordEvent("machine.ready.owed_wake.suppressed", { agent_id: agentId, machine_id: machineId, reason, ...attrs });
      return "suppressed" as const;
    };
    // The agent may have been woken, stopped or moved since its `ready`.
    const cached = this.agentStateCache.get(agentId);
    if (!cached || cached.machineId !== machineId || cached.status !== "active" || cached.runtimeState !== "not_running") return "nothing_owed";
    if (this.startsInProgress.has(agentId) || this.hasPendingAgentStartForAgent(agentId)) return "nothing_owed";
    // A buffered message wakes the agent through its own path.
    if (this.localInboxes.peekFirst(agentId)) return "nothing_owed";
    // The owed set is read as of now: messages created after it are the next wake's.
    const checkedAtMs = this.clock.now();
    let lastWakeAtMs: number | null;
    try {
      if (!this.replicaStateStore.getReadyOwedWakeAt || !this.replicaStateStore.setReadyOwedWakeAt) {
        return suppressed("wake_mark_unavailable");
      }
      lastWakeAtMs = await this.replicaStateStore.getReadyOwedWakeAt(agentId);
    } catch (err) {
      return suppressed("wake_mark_unavailable", { error_class: errorClassOf(err) });
    }
    const createdSinceMs = Math.max(
      checkedAtMs - AgentOrchestrator.READY_OWED_WAKE_MAX_AGE_MS,
      lastWakeAtMs === null ? Number.NEGATIVE_INFINITY : lastWakeAtMs + 1,
    );
    let owed: string[] | null;
    try {
      owed = await this.readReadyOwedTargets(agentId, new Date(createdSinceMs));
    } catch (err) {
      return suppressed("owed_read_failed", { error_class: errorClassOf(err) });
    }
    if (owed === null) return suppressed("chain_unavailable");
    if (owed.length === 0) return "nothing_owed";
    const wakeInput = await this.loadWakePlanInput(agentId, cached.status);
    const action = planWakeAction(wakeInput);
    this.recordEvent("machine.ready.owed_wake.planned", {
      agent_id: agentId,
      machine_id: machineId,
      owed_conversation_count: owed.length,
      session_id_present: Boolean(cached.sessionId),
      action,
    });
    if (action !== "attempt-wake") return suppressed(action);
    let result: AgentStartDispatchResult;
    try {
      result = await this.startAgentHere(agentId, { startCause: "ready_owed", localConnectionEpochId: run.connectionEpochId });
    } catch (err) {
      return suppressed("start_failed", { error_class: errorClassOf(err) });
    }
    if (result.outcome !== "dispatched") return suppressed(result.reason);
    // Only a dispatched start marks the wake; a refused one leaves the next ready free to wake.
    let markWritten = true;
    try {
      await this.replicaStateStore.setReadyOwedWakeAt(agentId, checkedAtMs);
    } catch (err) {
      markWritten = false;
      console.warn(`[Orchestrator] ready owed wake mark not written for agent ${agentId}; a later ready may wake it again:`, err instanceof Error ? err.message : err);
    }
    this.recordEvent("machine.ready.owed_wake.started", {
      agent_id: agentId,
      machine_id: machineId,
      owed_conversation_count: owed.length,
      wake_mark_written: markWritten,
      previous_wake_mark_present: lastWakeAtMs !== null,
    });
    return "started";
  }

  /** Waits, at most `timeoutMs`, for the reconnect passes in flight (shutdown, tests). */
  async awaitThirdPartyEventReconnectPasses(timeoutMs = 10_000): Promise<void> {
    const passes = [...this.thirdPartyEventReconnectPasses.values()];
    if (passes.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(passes).then(() => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); }),
    ]);
    if (timer) clearTimeout(timer);
  }

  /**
   * The app-event reconnect pass for a machine's `ready`
   * (thirdPartyAgentEventRedelivery): only after an outage longer than a
   * parked ack-retry record lives, with a known start, from a daemon that
   * reports delivered events; otherwise traced as skipped. Never throws.
   */
  protected async runThirdPartyEventReconnectPass(
    machineId: string,
    agentIds: readonly string[],
    conn: { connectedAt?: number; previousCloseAt?: number; daemonVersion: string | null } | undefined,
  ): Promise<void> {
    if (agentIds.length === 0) return;
    try {
      const reconnectedAtMs = conn?.connectedAt ?? this.clock.now();
      const plan = planReconnectRedelivery({
        daemonVersion: conn?.daemonVersion,
        outageStart: await this.machineOutageStart(machineId, conn, reconnectedAtMs),
        reconnectedAt: new Date(reconnectedAtMs),
        parkedMaxMs: AgentOrchestrator.AGENT_DELIVERY_PARKED_MAX_MS,
      });
      if (plan.action !== "run") {
        this.recordEvent("server.third_party_event.redeliver_skipped", {
          trigger: "machine_ready",
          outcome: plan.action,
          machine_id: machineId,
          ...("outageMs" in plan ? { outage_ms_bucket: durationMsBucket(plan.outageMs) } : {}),
        });
        return;
      }
      await redeliverPendingThirdPartyAgentEvents({
        trigger: "machine_ready",
        outageStartedAt: plan.outageStartedAt,
        agentIds,
        excludeEventIds: this.thirdPartyEventIdsInFlight(),
        parkedMaxMs: AgentOrchestrator.AGENT_DELIVERY_PARKED_MAX_MS,
        deliverer: this,
        tracer: this.tracer,
        machineId,
      });
    } catch (err) {
      console.error(`[Orchestrator] third-party event reconnect pass failed for machine ${machineId}:`, err);
      this.recordEvent("server.third_party_event.redeliver_failed", {
        outcome: "failed",
        trigger: "machine_ready",
        machine_id: machineId,
        error_class: errorClassOf(err),
      });
    }
  }

  /**
   * The re-delivery sweep (safety net): the managed agents whose computer is
   * connected to this replica, with a daemon that reports delivered events,
   * and that have a pending app event.
   */
  async sweepPendingThirdPartyAgentEvents(): Promise<void> {
    const machineIds: string[] = [];
    let oldDaemons = 0;
    for (const machineId of this.getRoutableLocalMachineIds()) {
      if (daemonReportsDeliveredThirdPartyEvents(this.machineConnections.get(machineId)?.daemonVersion)) machineIds.push(machineId);
      else oldDaemons += 1;
    }
    if (oldDaemons > 0) {
      this.recordEvent("server.third_party_event.redeliver_skipped", { trigger: "sweep", outcome: "skipped_old_daemon", machines_count: oldDaemons });
    }
    if (machineIds.length === 0) return;
    try {
      const agentIds = await listManagedAgentsWithPendingThirdPartyEvents({ machineIds, parkedMaxMs: AgentOrchestrator.AGENT_DELIVERY_PARKED_MAX_MS });
      await redeliverPendingThirdPartyAgentEvents({
        trigger: "sweep",
        agentIds,
        excludeEventIds: this.thirdPartyEventIdsInFlight(),
        parkedMaxMs: AgentOrchestrator.AGENT_DELIVERY_PARKED_MAX_MS,
        deliverer: this,
        tracer: this.tracer,
      });
    } catch (err) {
      console.error("[Orchestrator] third-party event sweep failed:", err);
      this.recordEvent("server.third_party_event.redeliver_failed", { outcome: "failed", trigger: "sweep", error_class: errorClassOf(err) });
    }
  }

  /**
   * Deliver one message to one agent. `gates` carries this agent's row and
   * channel access when the caller already read them for a whole channel
   * (deliverMessagesOnChannel); without it the gates are read for this agent.
   */
  async deliverMessage(
    agentId: string,
    message: AgentMessage,
    options: DeliverMessageOptions = {},
    gates?: DeliveryGates | null,
  ): Promise<AgentMessageDeliveryResult> {
    return this.deliverMessageWithGates(agentId, message, options, gates ?? null);
  }

  /**
   * deliverMessage for several agents on one channel (each with its own
   * payload and options): the agent rows and channel access are read for all
   * of them in a fixed number of queries, then each agent goes through
   * deliverMessage with those answers. One result promise per delivery, in
   * order. A single delivery reads its gates on its own.
   */
  deliverMessagesOnChannel(
    channelId: string,
    deliveries: ReadonlyArray<{ agentId: string; message: AgentMessage; options?: DeliverMessageOptions }>,
  ): Array<Promise<AgentMessageDeliveryResult>> {
    const agentIds = [...new Set(deliveries.map((delivery) => delivery.agentId))];
    const gates = agentIds.length > 1 ? this.loadDeliveryGates(channelId, agentIds) : Promise.resolve(null);
    return deliveries.map(({ agentId, message, options }) => gates.then((loaded) =>
      this.deliverMessage(agentId, message, options ?? {}, loaded && message.channel_id === channelId ? loaded : null)));
  }

  private async deliverMessageWithGates(
    agentId: string,
    message: AgentMessage,
    options: DeliverMessageOptions,
    gates: DeliveryGates | null,
  ): Promise<AgentMessageDeliveryResult> {
    const agent = gates?.agents.has(agentId)
      ? this.applyPersistedAgentForDelivery(agentId, gates.agents.get(agentId) ?? null)
      : await this.getAuthoritativeAgentForDelivery(agentId);
    if (!agent) return { status: "dropped", reason: "agent_unavailable" };
    // Channel membership grants context reads, never passive chat delivery.
    // Check before cross-replica routing, local buffering and webhook emission.
    if ((gates?.raftbenchServices?.has(agentId) ?? await this.isRaftBenchServiceAgent(agentId))
      && message.third_party_event?.client_id !== "system.raftbench") {
      return { status: "dropped", reason: "raftbench_service_no_chat" };
    }
    const requireQueueReceipt = options.requireQueueReceipt === true
      || options.reconcileNonMemberMention === true;
    // Passive scope gate — see DeliverMessageOptions.intrinsic. We drop rather
    // than enqueue and return a typed receipt to the caller: a revoked agent
    // should not see historical channel traffic when the scope is later restored. The
    // server-side audit trail lives on the scope toggle itself
    // (revision + updatedAt + updatedByUserId on `agent_scopes`).
    if (!options.intrinsic && !options.adminAuthority) {
      const allowed = gates?.passiveScope.get(agentId)
        ?? await this.hasPassiveDeliveryScope(agentId).catch(() => false);
      if (!allowed) return { status: "dropped", reason: "passive_scope_revoked" };
    }
    if (!options.intrinsic && !await this.canAgentAccessDeliveryTarget(agentId, agent, message, gates?.access.get(agentId))) {
      return { status: "dropped", reason: "target_access_changed" };
    }
    // A tracked mention carries the launch/session identity the daemon checks
    // it against. Only the socket owner holds the current identity, so hand
    // the whole delivery to the owner rather than stamping
    // this replica's cached identity on it.
    const routeTrackedMention = Boolean(options.mentionDeliveryOccurrenceId)
      && Boolean(agent.machineId);
    if ((requireQueueReceipt || routeTrackedMention) && agent.machineId) {
      const localMachineIds = this.getRoutableLocalMachineIds();
      if (!localMachineIds.has(agent.machineId) && this.replicaStateStore.isAvailable()) {
        const routed = await this.routeInboxDeliveryWithReceiptCrossReplica(
          agentId,
          agent.machineId,
          message,
          localMachineIds,
          options,
        );
        if (routed.routed) {
          return normalizeRoutedInboxDeliveryReceipt(routed.receipt);
        }
      }
    }
    if (options.reconcileNonMemberMention) {
      this.localInboxes.reconcileNonMemberMention(agentId, message);
    }
    // External agents are supplied/observed, never Slock-launched
    // (SHA-V0-006C): there is no managed wake path for them. Signal the
    // content-free `/wake-hints` surfaces (rfcs/035 D7); the runtime drains
    // bodies via its own direct `message check`. Transient synthetic
    // messages (e.g. reminder fire) have no ackable `seq` and would pin the
    // inbox forever — drop them, same rule as the control-gate path below.
    if (isExternalAgentRuntime(agent.runtime)) {
      if (!options.transient) {
        // A persisted message is pulled from the agent's durable inbox on its
        // next call (messageService.pullExternalAgentInbox); only items with no
        // durable row are buffered here.
        if (!isDurableAgentInboxMessage(message)) {
          this.deliverToLocalInbox(agentId, message, { notifyPendingReceive: false });
        }
        // Wake the agent's SSE wake-hint stream subscribers (D7 T1, task
        // #72). Content-free signal only: listeners re-peek the inbox and
        // build hints themselves — nothing here drains or advances cursors.
        // The message itself rides along (second listener argument) for the
        // inbox push, which POSTs it directly (agentInboxPushService), the
        // external counterpart of `agent:deliver`. Signals relayed from
        // another replica carry no message.
        this.emit("external-inbox-delivered", agentId, message);
        // Option C (#wg-external-agent 2026-06-11): the emit above is
        // process-local, but the agent's SSE stream may be connected to
        // another replica. Broadcast a content-free signal so that replica's
        // stream flushes immediately (its flush pulls the durable inbox, so
        // duplicates/loss are harmless); the heartbeat pull stays the floor.
        void this.publishExternalWakeSignalCrossReplica(agentId);
        return { status: "queued", reason: "external_inbox" };
      }
      return { status: "dropped", reason: "transient_delivery_unsupported" };
    }
    const wakeInput = await this.loadWakePlanInput(agentId, agent.status, gates?.migrationGated.get(agentId));
    const action = planWakeAction(wakeInput);
    if (action === "suppress-control-gate") {
      // Migration-gated path normally enqueues into the local inbox so the wake
      // is delivered after the gate clears. For transient wakes (e.g. reminder
      // fire) we DROP instead of enqueue: the synthetic AgentMessage has no
      // ackable seq, so it would sit in the inbox forever and re-fire on every
      // receive/reconnect once the gate lifts. Audit lives in `reminder_events`;
      // owner observes via reminder UI (status=fired). Best-effort delivery
      // semantics are intentional — reminder fire is fire-and-observe.
      if (!options.transient) {
        this.deliverToLocalInbox(agentId, message, { notifyPendingReceive: false });
      }
      if (wakeInput.state.controlGate === "runtime_profile_migration" && agent.machineId) {
        await this.maybePiggybackRuntimeProfileMigrationNudge(agent.machineId, agent);
      }
      return options.transient
        ? { status: "dropped", reason: "transient_delivery_unsupported" }
        : { status: "queued", reason: "control_gate_inbox" };
    }
    // Hotfix (mention-push incident 2026-08-27): tracked-mention delivery must
    // not be silently demoted to replayable-inbox-only when the daemon-side
    // session identity is unavailable. applyDirectDelivery's identity gate
    // returned before span creation on missing expectedLaunchId/sessionId —
    // for machines whose daemon never established that identity the whole
    // @ push vanished until next contact. Restore ordinary immediate delivery
    // semantics: CAS-terminalize the occurrence and deliver untracked (plain
    // ws frame + durable inbox + embedded wake content). Only the caller whose
    // CAS wins (row still in its pre-decision fanout state) owns that untracked
    // push; a null CAS means another path already terminalized or decided this
    // occurrence, and emitting a second copy here would double-deliver.
    let mentionDeliveryOccurrenceId = options.mentionDeliveryOccurrenceId;
    if (
      mentionDeliveryOccurrenceId
      && (
        !message.message_id
        || !agent.machineId
        || !this.agentStateCache.get(agentId)?.expectedLaunchId
        || !this.agentStateCache.get(agentId)?.sessionId
      )
    ) {
      let abandoned: Awaited<ReturnType<typeof mentionDeliveryOccurrenceService.abandonMentionDeliveryWithoutInstrumentation>>;
      try {
        abandoned = await mentionDeliveryOccurrenceService.abandonMentionDeliveryWithoutInstrumentation({
          occurrenceId: mentionDeliveryOccurrenceId,
        });
      } catch {
        // Ownership unknown (the CAS itself failed to execute): do not push a
        // copy we cannot prove we own. The row stays `recorded`, so durable
        // recovery redrives it once the agent's identity is established —
        // delayed, never lost, never doubled.
        return { status: "queued", reason: "replayable_inbox" };
      }
      if (!abandoned) {
        // Lost the CAS: already terminal (a previous fallback call delivered),
        // already server-decided (tracked path owns it), or no such row. Same
        // idempotency shape as the tracked decision guard: no second copy.
        return { status: "dropped", reason: "agent_state_changed" };
      }
      mentionDeliveryOccurrenceId = undefined;
    }
    if (action !== "deliver-directly") {
      return this.applyWakeAction({
        agentId,
        machineId: agent.machineId,
        previousStatus: agent.status,
        resetMode: wakeInput.state.resetMode,
        transient: options.transient ?? false,
        requireQueueReceipt,
        mentionDeliveryOccurrenceId,
      }, message, action);
    }
    return this.applyDirectDelivery({
      agentId,
      machineId: agent.machineId,
      transient: options.transient ?? false,
      requireQueueReceipt,
      mentionDeliveryOccurrenceId,
      intrinsic: options.intrinsic === true,
    }, message);
  }

  async redriveMentionDelivery(
    messageId: string,
    agentId: string,
    expectedVersion: number,
  ): Promise<
    | { status: "REDRIVE_QUEUED"; occurrenceId: string; version: number }
    | { status: "NOT_JOINABLE" | "IDENTITY_UNKNOWN" | "IDENTITY_DRIFT" | "CAS_MISMATCH" }
    | mentionDeliveryOccurrenceService.MentionDeliveryLookupResult
  > {
    const row = await mentionDeliveryOccurrenceService.getMentionDeliveryOccurrence(messageId, agentId);
    if (!row || !row.deliveryPayload) return { status: "NOT_JOINABLE" };
    const currentResult = mentionDeliveryOccurrenceService.evaluateMentionDeliveryOccurrence(row);
    if (
      currentResult.status === "ACKED"
      || currentResult.status === "TERMINAL_ERROR"
      || currentResult.status === "INSTRUMENT_FAILED"
    ) return currentResult;
    const agent = await this.getAuthoritativeAgentForDelivery(agentId);
    if (!agent?.machineId || !agent.expectedLaunchId || !agent.sessionId) {
      return { status: "IDENTITY_UNKNOWN" };
    }
    const identity: MentionDeliveryIdentitySnapshot = {
      occurrenceId: row.occurrenceId,
      messageId: row.messageId,
      machineId: agent.machineId,
      launchId: agent.expectedLaunchId,
      sessionId: agent.sessionId,
    };
    if (
      row.machineIdSnapshot !== identity.machineId
      || row.launchIdSnapshot !== identity.launchId
      || row.sessionIdSnapshot !== identity.sessionId
    ) {
      await mentionDeliveryOccurrenceService.recordMentionDeliveryIdentityDrift(row.occurrenceId, "redrive");
      return { status: "IDENTITY_DRIFT" };
    }
    const claimed = await mentionDeliveryOccurrenceService.claimMentionDeliveryRedrive({
      occurrenceId: row.occurrenceId,
      expectedVersion,
      identity,
    });
    if (!claimed) return { status: "CAS_MISMATCH" };
    await this.enqueueToLocalInboxIfStillActive(agentId, identity.machineId, row.deliveryPayload);
    await this.sendAgentDeliveryWithAckRetry(identity.machineId, {
      type: "agent:deliver",
      agentId,
      message: row.deliveryPayload,
      seq: row.deliveryPayload.seq ?? 0,
      deliveryId: row.occurrenceId,
      mentionDelivery: identity,
    }, `operator mention redrive failed for agent ${agentId}`);
    return { status: "REDRIVE_QUEUED", occurrenceId: row.occurrenceId, version: claimed.version };
  }

  protected async applyDirectDelivery(
    context: DirectDeliveryContext,
    message: AgentMessage,
  ): Promise<AgentMessageDeliveryResult> {
    const cachedAgent = this.agentStateCache.get(context.agentId);
    const serverId = cachedAgent?.serverId;
    const deliveryId = context.mentionDeliveryOccurrenceId ?? crypto.randomUUID();
    let mentionDelivery: MentionDeliveryIdentitySnapshot | undefined;
    if (context.mentionDeliveryOccurrenceId) {
      if (
        !message.message_id
        || !context.machineId
        || !cachedAgent?.expectedLaunchId
        || !cachedAgent.sessionId
      ) {
        return { status: "queued", reason: "replayable_inbox" };
      }
      mentionDelivery = {
        occurrenceId: context.mentionDeliveryOccurrenceId,
        messageId: message.message_id,
        machineId: context.machineId,
        launchId: cachedAgent.expectedLaunchId,
        sessionId: cachedAgent.sessionId,
      };
      const decision = await mentionDeliveryOccurrenceService.recordMentionDeliveryServerDecision({
        occurrenceId: context.mentionDeliveryOccurrenceId,
        payload: message,
        identity: mentionDelivery,
      });
      if (!decision) {
        return { status: "dropped", reason: "agent_state_changed" };
      }
    }
    const span = this.tracer.startSpan("server.agent.delivery", {
      parent: getCurrentTraceContext(),
      surface: "server",
      kind: "producer",
      attrs: {
        agent_id: context.agentId,
        machine_id: context.machineId ?? undefined,
        server_id: serverId,
        agent_id_present: Boolean(context.agentId),
        machine_id_present: Boolean(context.machineId),
        server_id_present: Boolean(serverId),
        deliveryId,
        delivery_correlation_id: deliveryId,
        message_id_present: Boolean(message.message_id),
        seq: message.seq ?? 0,
        ...(message.third_party_event?.id ? { third_party_event_id: message.third_party_event.id } : {}),
      },
    });
    span.addEvent("server.deliver.enqueued", {
      outcome: "enqueued",
      reason: "direct_delivery",
      seq: message.seq ?? 0,
      deliveryId,
    });

    try {
      let inboxPath: "routed" | "local" | "local-fallback" | "strict-remote-skip" | "transient-skip" = "local";
      let queued = false;
      // Establish replayable inbox state before direct websocket delivery. The
      // daemon can ack immediately from ws.send(); if the inbox does not exist yet,
      // that ack is lost and weak-network recovery can replay a delivered message.
      //
      // Transient deliveries (e.g. reminder fire) intentionally skip this: their
      // synthetic AgentMessage has no `seq` from `messages.seq`, so the inbox
      // could never ack/remove it (see `partitionAcknowledgedMessages`). Audit
      // lives elsewhere (`reminder_events`) and a missed wake is recoverable
      // via the owner's reminder UI, so best-effort ws send is correct.
      if (context.transient) {
        inboxPath = "transient-skip";
        span.addEvent("inbox.skipped", {
          outcome: "skipped",
          reason: "transient_delivery",
          path: inboxPath,
        });
      } else if (
        context.requireQueueReceipt
        && context.machineId
        && !this.getRoutableLocalMachineIds().has(context.machineId)
      ) {
        // The receipt RPC is attempted before the local delivery plan. Reaching
        // this branch means no current target replica could own that contract;
        // do not fall back to the legacy publish-only route, because it could
        // mutate a remote inbox before this replica reports `dropped`.
        inboxPath = "strict-remote-skip";
        span.addEvent("inbox.routed", {
          outcome: "skipped",
          reason: "cross_replica_receipt_unavailable",
          path: inboxPath,
        });
      } else if (context.machineId && this.replicaStateStore.isAvailable()) {
        const routed = await this.routeInboxDeliveryCrossReplica(
          context.agentId,
          context.machineId,
          message,
          this.getRoutableLocalMachineIds(),
          context.intrinsic ? { intrinsic: true } : {},
        );
        if (routed) {
          inboxPath = "routed";
          // Pub/sub publication is only a route signal. It does not prove the
          // target replica accepted the message into its replayable inbox.
          queued = !context.requireQueueReceipt;
          span.addEvent("inbox.routed", {
            outcome: context.requireQueueReceipt ? "unconfirmed" : "routed",
            reason: context.requireQueueReceipt
              ? "cross_replica_receipt_unavailable"
              : "cross_replica_inbox",
            path: inboxPath,
          });
        } else {
          inboxPath = "local-fallback";
          queued = await this.enqueueToLocalInboxIfStillActive(context.agentId, context.machineId, message);
          span.addEvent("inbox.ready", {
            outcome: "prepared",
            reason: "local_fallback_inbox",
            path: inboxPath,
          });
        }
      } else {
        queued = await this.enqueueToLocalInboxIfStillActive(context.agentId, context.machineId, message);
        span.addEvent("inbox.ready", {
          outcome: "prepared",
          reason: "local_inbox",
          path: inboxPath,
        });
      }

      if (!context.transient && !queued) {
        const reason = inboxPath === "routed" || inboxPath === "strict-remote-skip"
          ? "cross_replica_receipt_unavailable"
          : "agent_state_changed";
        span.end("ok", {
          attrs: {
            outcome: "dropped",
            reason,
          },
        });
        return { status: "dropped", reason };
      }

      if (context.transient && !context.machineId) {
        span.end("ok", {
          attrs: {
            outcome: "dropped",
            reason: "agent_state_changed",
          },
        });
        return { status: "dropped", reason: "agent_state_changed" };
      }

      // Try to deliver to the machine directly (daemon auto-restarts idle processes;
      // sendToMachine handles cross-replica routing via Redis).
      if (context.machineId) {
        span.addEvent("server.ws.send.attempted", {
          outcome: "attempted",
          reason: "machine_present",
          machine_id_present: true,
        });
        void this.sendAgentDeliveryWithAckRetry(context.machineId, {
          type: "agent:deliver",
          agentId: context.agentId,
          message,
          seq: message.seq ?? 0,
          traceparent: formatTraceparent(span.context),
          deliveryId,
          transient: context.transient || undefined,
          mentionDelivery,
        }, `deliverMessage send failed for agent ${context.agentId}`);
      }
      span.end("ok", {
        attrs: {
          outcome: context.machineId ? "ws-send-attempted" : "inbox-only",
          reason: context.machineId ? "machine_present" : "machine_absent",
        },
      });
      return {
        status: "queued",
        reason: context.transient ? "direct_dispatch" : "replayable_inbox",
      };
    } catch (err) {
      span.end("error", { attrs: { error_class: errorClassOf(err) } });
      throw err;
    }
  }

  protected async applyWakeAction(
    context: WakeApplyContext,
    message: AgentMessage,
    action: Exclude<WakePlanAction, "deliver-directly">,
  ): Promise<AgentMessageDeliveryResult> {
    if (action === "suppress-reset") {
      this.recordLifecycleEvent({
        agentId: context.agentId,
        machineId: context.machineId,
        action: "wake",
        outcome: "suppressed",
        cause: "message",
        previousStatus: context.previousStatus,
        detail: `reset_in_progress:${context.resetMode}`,
      });
      return { status: "dropped", reason: "reset_in_progress" };
    }
    if (action === "attempt-wake") {
      this.recordLifecycleEvent({
        agentId: context.agentId,
        machineId: context.machineId,
        action: "wake",
        outcome: "attempted",
        cause: "message",
        previousStatus: context.previousStatus,
      });
      try {
        const startResult = await this.startAgent(context.agentId, {
          // A tracked mention is not embedded in agent:start because the
          // concrete session identity does not exist yet. Start the runtime,
          // then agent:session rebuilds the existing ACK obligation from the
          // durable occurrence and sends the same occurrence id once.
          wakeMessage: context.mentionDeliveryOccurrenceId ? undefined : message,
          wakeMessageTransient: context.mentionDeliveryOccurrenceId ? undefined : context.transient ?? false,
          requireQueueReceipt: context.requireQueueReceipt ?? false,
        });
        if (startResult.outcome === "dispatched") {
          return { status: "queued", reason: "wake_accepted" };
        }
        if (
          startResult.reason === "manual_stop"
          || startResult.reason === "computer_version_unsupported"
          || startResult.reason === "computer_access_revoked"
          || startResult.reason === "wake_crash_loop_blocked"
          || startResult.reason === "terminal_failure_paused"
          || startResult.reason === "terminal_failure_probe_in_flight"
          || startResult.reason === "terminal_failure_needs_manual"
        ) {
          // RFC 071: the message is neither consumed nor acked; it stays in the durable inbox.
          return { status: "dropped", reason: "wake_suppressed" };
        }
        if (context.requireQueueReceipt) {
          return { status: "dropped", reason: "cross_replica_receipt_unavailable" };
        }
        if (context.transient) {
          return { status: "dropped", reason: "transient_delivery_unsupported" };
        }

        // Another replica owns the in-flight start and its start payload cannot
        // contain this later message. Retain the message on this replica so a
        // subsequent receive/reconnect can replay it instead of falsely
        // reporting that the wake accepted content it never handed off.
        const queued = await this.enqueueWakeLockFallbackToLocalInbox(
          context.agentId,
          context.machineId,
          message,
        );
        return queued
          ? { status: "queued", reason: "replayable_inbox" }
          : { status: "dropped", reason: "agent_state_changed" };
      } catch (err) {
        this.recordLifecycleEvent({
          agentId: context.agentId,
          machineId: context.machineId,
          action: "wake",
          outcome: "failed",
          cause: "message",
          previousStatus: context.previousStatus,
          detail: err instanceof Error ? err.message : String(err),
        });
        console.warn(`[Orchestrator] deliverMessage ${context.agentId}: failed to wake inactive agent: ${err instanceof Error ? err.message : String(err)}`);
        if (err instanceof CrossReplicaQueueReceiptUnavailableError) {
          return { status: "dropped", reason: "cross_replica_receipt_unavailable" };
        }
        return { status: "dropped", reason: "wake_failed" };
      }
    }
    this.recordLifecycleEvent({
      agentId: context.agentId,
      machineId: context.machineId,
      action: "wake",
      outcome: "suppressed",
      cause: "message",
      previousStatus: context.previousStatus,
    });
    return { status: "dropped", reason: "wake_suppressed" };
  }

  private async enqueueWakeLockFallbackToLocalInbox(
    agentId: string,
    expectedMachineId: string | null,
    message: AgentMessage,
  ): Promise<boolean> {
    const latest = await this.getAuthoritativeAgentForDelivery(agentId);
    if (!latest || latest.status === "stopped" || latest.machineId !== expectedMachineId) {
      return false;
    }
    this.deliverToLocalInbox(agentId, message);
    return true;
  }

  // `protected`, not private, PURELY so a test can count deliveries. @Kabi's probe shape for the
  // "AND no delivery happened" half of the redrive arms is: override the delivery call with a
  // counter and assert the (rc, count) PAIR. With this private, a counter could see only ONE of
  // the two delivery calls on the queued path, so a count of 0 would not mean "nothing was
  // delivered" — it would mean "I could not see one of the two ways it delivers".
  protected async enqueueToLocalInboxIfStillActive(
    agentId: string,
    expectedMachineId: string | null,
    message: AgentMessage,
  ): Promise<boolean> {
    const latest = await this.getAuthoritativeAgentForDelivery(agentId);
    const action = planLocalDeliveryGateAction({
      hasAgent: Boolean(latest),
      status: latest?.status ?? null,
      machineMatches: latest?.machineId === expectedMachineId,
    });
    this.applyLocalDeliveryGateAction({
      action,
      agentId,
      message,
    });
    return action === "deliver-locally";
  }

  private async deliverToLocalInboxIfStillActive(
    agentId: string,
    expectedMachineId: string | null,
    message: AgentMessage,
  ): Promise<boolean> {
    await this.enqueueToLocalInboxIfStillActive(agentId, expectedMachineId, message);
    // Replica routing asks whether this replica handled the command, not
    // whether the late delivery was still eligible to enqueue. A stale drop is
    // therefore handled=true even though the receipt-facing path reports it as
    // dropped.
    return true;
  }

  protected applyLocalDeliveryGateAction(context: LocalDeliveryGateApplyContext): boolean {
    if (context.action === "drop-delivery") {
      return true;
    }

    this.deliverToLocalInbox(context.agentId, context.message);
    return true;
  }

  /** Deliver a message to a local agent inbox. Used by deliverMessage and ReplicaRouter. */
  deliverToLocalInbox(
    agentId: string,
    message: AgentMessage,
    options: {
      notifyPendingReceive?: boolean;
      reconcileNonMemberMention?: boolean;
    } = {},
  ) {
    this.localInboxes.enqueue(agentId, message, options);
  }

  async receiveMessages(agentId: string, block: boolean, timeoutMs: number, signal?: AbortSignal): Promise<AgentMessage[]> {
    if (await this.isRaftBenchServiceAgent(agentId)) {
      this.localInboxes.retain(agentId, message => message.third_party_event?.client_id === "system.raftbench");
    }
    if (await agentRuntimeProfileService.isRuntimeProfileMigrationGated(agentId)) {
      const agent = await this.getCachedAgent(agentId);
      const pendingMigration = await agentRuntimeProfileService.getPendingRuntimeProfileMigration(agentId);
      const inbox = this.localInboxes.snapshot(agentId);
      const oldestMessageAgeMs = oldestInboxMessageAgeMs(inbox?.messages ?? [], this.clock.now());
      const pendingAgeMs = pendingMigration?.migratingSince
        ? Math.max(0, this.clock.now() - pendingMigration.migratingSince.getTime())
        : undefined;
      const span = this.tracer.startSpan("server.runtime_profile.gated_inbox.receive_blocked", {
        parent: getCurrentTraceContext(),
        surface: "server",
        kind: "internal",
        attrs: {
          event_kind: "runtime_profile",
          agent_id: agentId,
          machine_id: agent?.machineId,
          server_id: agent?.serverId,
          agent_id_present: Boolean(agentId),
          machine_id_present: Boolean(agent?.machineId),
          pending_kind: pendingMigration?.pendingKind,
          pending_key_present: Boolean(pendingMigration?.pendingKey),
          pending_key_hash: hashRuntimeProfileKey(pendingMigration?.pendingKey),
          migration_status: pendingMigration?.migrationStatus,
          pending_age_ms: pendingAgeMs,
          pending_age_bucket: durationMsBucket(pendingAgeMs),
          inbox_count: inbox?.messages.length ?? 0,
          pending_receive_present: inbox?.receiving ?? false,
          oldest_message_age_ms: oldestMessageAgeMs,
          oldest_message_age_bucket: durationMsBucket(oldestMessageAgeMs),
          block,
          timeout_ms: timeoutMs,
        },
      });
      try {
        await this.runInActiveSpan(span, async () => {
          if (agent?.machineId) {
            await this.maybePiggybackRuntimeProfileMigrationNudge(agent.machineId, agent);
          }
          if (agent) {
            const pendingKeyHash = hashRuntimeProfileKey(pendingMigration?.pendingKey);
            // TODO(lifecycle-v2/server-producer): this is the server-side half of
            // runtime-profile control gating. Emit canonical
            // runtime_profile_control_changed from the gate planner when it marks
            // controlGate=runtime_profile_migration, then remove this adapter use.
            const { event } = adaptRuntimeProfileControlLifecycleEvent({
              serverId: agent.serverId,
              agentId,
              machineId: agent.machineId,
              source: "server",
              controlGate: "runtime_profile_migration",
              pendingKeyHash,
              now: () => new Date(this.clock.now()),
              attrs: {
                pending_kind: pendingMigration?.pendingKind,
                migration_status: pendingMigration?.migrationStatus,
              },
            });
            await applyAgentLifecycleProjectionPlan(
              reduceRuntimeProfileControlLifecycle({
                event,
                state: buildAgentLifecycleStateSnapshot({
                  controlGate: "runtime_profile_migration",
                  dbStatus: agent.status,
                  machineId: agent.machineId,
                  machineReachability: agent.machineId ? "reachable" : "unknown",
                }),
              }),
              this.lifecycleProjectionWriterDeps(),
              span,
            );
          }
        });
      } catch (err) {
        span.end("error", {
          attrs: {
            outcome: "nudge_failed",
            reason: "nudge_failed",
            error_class: errorClassOf(err),
          },
        });
        throw err;
      }
      span.end("ok", { attrs: { outcome: "gated_by_runtime_profile_migration", reason: "runtime_profile_migration_gate" } });
      return [];
    }
    return this.localInboxes.receive(agentId, block, timeoutMs, signal);
  }

  /**
   * Content-free bridge wake hints must be a peek, not a receive/drain.
   * This returns a copy of the current volatile server inbox without installing
   * a pending receive waiter and without acknowledging delivery.
   */
  peekPendingMessages(agentId: string): AgentMessage[] {
    return this.localInboxes.peek(agentId);
  }

  acknowledgeDeliveredMessages(agentId: string, seqs: number[], messageIds: string[] = []): { removedCount: number } {
    return this.localInboxes.acknowledge(agentId, seqs, messageIds);
  }

  discardUndeliverableMessages(agentId: string, messages: AgentMessage[]): { removedCount: number } {
    return this.localInboxes.discard(agentId, messages);
  }

  async purgeAgentInboxForChannels(
    agentId: string,
    channelIds: readonly string[],
    reason = "channel_membership_removed",
  ): Promise<{ localRemovedCount: number; machineSent: boolean }> {
    const local = this.localInboxes.discardForChannels(agentId, channelIds);
    const agent = await this.getCachedAgent(agentId);
    let machineSent = false;
    const dedupedChannelIds = [...new Set(channelIds.filter((id) => typeof id === "string" && id.length > 0))];
    if (agent?.machineId && dedupedChannelIds.length > 0) {
      this.sendBestEffortToMachine(agent.machineId, {
        type: "agent:inbox:purge",
        agentId,
        channelIds: dedupedChannelIds,
        reason,
      }, `purgeAgentInboxForChannels send failed for agent ${agentId}`);
      machineSent = true;
    }
    return { localRemovedCount: local.removedCount, machineSent };
  }

  async purgeAgentInboxForChannelTree(
    agentId: string,
    parentChannelId: string,
    reason = "channel_membership_removed",
  ): Promise<{ localRemovedCount: number; machineSent: boolean }> {
    const threadChannelIds = await this.listThreadChannelIdsForInboxPurge(parentChannelId);
    return this.purgeAgentInboxForChannels(agentId, [parentChannelId, ...threadChannelIds], reason);
  }

  protected async listThreadChannelIdsForInboxPurge(parentChannelId: string): Promise<string[]> {
    return channelService.listThreadChannelIdsForParentChannel(parentChannelId);
  }

  acknowledgeDeliveredMessagesForChannel(agentId: string, channelId: string, seqs: number[]): { removedCount: number } {
    return this.localInboxes.acknowledgeForChannel(agentId, channelId, seqs);
  }

  acknowledgeDeliveredMessagesForChannelUpToSeq(agentId: string, channelId: string, maxSeq: number): { removedCount: number } {
    return this.localInboxes.acknowledgeForChannelUpToSeq(agentId, channelId, maxSeq);
  }

  /**
   * Pick the fresher of a local-cache snapshot vs the Redis cross-replica mirror
   * by `updatedAt`. On a tie the local cache wins (it was observed here). Returns
   * null when neither source has a snapshot.
   */
  async getActivity(agentId: string, options: ActivityTraceOptions = {}): Promise<VisibleActivity> {
    const span = this.tracer.startSpan("server.agent.activity.resolve", {
      parent: options.parent ?? null,
      surface: "server",
      kind: "internal",
      // This span is per getActivity(agentId). If resolve ever batches multiple
      // agents in one span, move raw identity to event-level attrs instead.
      attrs: { agent_id: agentId, agent_id_present: Boolean(agentId) },
    });
    try {
      const knownRow = options.persistedAgent?.id === agentId ? options.persistedAgent : undefined;
      const prefetched = options.prefetched;
      const authoritativeAgent = () => this.getAuthoritativeAgentForActivity(agentId, knownRow);
      let agent = await this.getCachedAgent(agentId, knownRow);
      let localMachineId = agent?.machineId ?? null;
      let hostedLocally = localMachineId !== null && this.hasMachineLocally(localMachineId);
      let redisActivity: ActivitySnapshot | null | undefined;
      if (agent?.status === "stopped") {
        if (!hostedLocally && this.replicaStateStore.isAvailable()) {
          redisActivity = activitySnapshotFromPersisted(await this.readAgentActivityForActivity(agentId, prefetched));
          if (redisActivity && redisActivity.activity !== "offline") {
            const freshAgent = await authoritativeAgent();
            if (freshAgent) agent = freshAgent;
          }
        }
      }
      if (agent?.status === "stopped") {
        const stopped = this.formatActivity("offline", "Stopped");
        span.end("ok", { attrs: { outcome: stopped.activity, source: "stopped-status" } });
        return stopped;
      }

      const runtimeErrorResolution = await this.resolveLastRuntimeErrorActivity(agentId, agent, authoritativeAgent, prefetched);
      agent = runtimeErrorResolution.agent;
      localMachineId = agent?.machineId ?? null;
      hostedLocally = localMachineId !== null && this.hasMachineLocally(localMachineId);
      if (agent?.status === "stopped") {
        const stopped = this.formatActivity("offline", "Stopped");
        span.end("ok", { attrs: { outcome: stopped.activity, source: "stopped-status-refresh" } });
        return stopped;
      }
      if (runtimeErrorResolution.activity) {
        span.end("ok", {
          attrs: {
            outcome: runtimeErrorResolution.activity.activity,
            source: "runtime-error-state",
            runtime_error_authority: runtimeErrorResolution.source ?? "runtime-error-persisted",
          },
        });
        return runtimeErrorResolution.activity;
      }

      const activityCached = this.agentActivity.get(agentId);

      // task #1119: a wake crash-loop block is server-authored state, not a
      // daemon observation, so machine reachability arbitration does not
      // apply to it: while the served snapshot (local or shared mirror) is
      // wake_crash_loop_blocked, serve it as-is on every replica. A human
      // start writes the next snapshot and thereby lifts it.
      // RFC 071 §9: the terminal-failure breaker's block is server-authored the same way.
      const blockedSnapshot = this.isServerActivityBlock(activityCached?.detailKind)
        ? activityCached
        : !activityCached && this.replicaStateStore.isAvailable()
          ? (redisActivity ??= activitySnapshotFromPersisted(await this.readAgentActivityForActivity(agentId, prefetched)))
          : null;
      if (blockedSnapshot && this.isServerActivityBlock(blockedSnapshot.detailKind)) {
        const blocked = this.formatActivityFromSnapshot(blockedSnapshot);
        span.end("ok", { attrs: { outcome: blocked.activity, source: activityCached ? "local-cache" : "redis", typed_state: blockedSnapshot.detailKind } });
        return blocked;
      }

      // When the agent's machine is connected to THIS replica, the in-memory
      // cache is authoritative and fresh (it is written on every broadcast).
      if (activityCached && hostedLocally) {
        const resolved = await this.resolveActivityHint(agentId, agent, activityCached, "local-cache", span, prefetched);
        if (resolved) {
          span.end("ok", { attrs: { outcome: resolved.activity, source: "local-cache" } });
          return resolved;
        }
      }

      // Non-owner read-through (cross-replica cache-coherence contract CC-004 /
      // CC-004a). The agent is not hosted on this replica, so the Redis mirror
      // written by the owning replica is the authoritative cross-replica source.
      // Read through it; NEVER prefer the process-lifetime local shadow — it has
      // no authority for a non-owned agent and was the A.3 staleness vector (a
      // stale-but-timestamp-recent local entry must not mask the owner's value).
      // When Redis is unreachable, pass through to the durable activity log /
      // derived state below rather than fall back to the local shadow, so
      // INV-CC-FRESH holds even under Redis degradation.
      if (this.replicaStateStore.isAvailable()) {
        redisActivity ??= activitySnapshotFromPersisted(await this.readAgentActivityForActivity(agentId, prefetched));
        if (redisActivity) {
          if (redisActivity.activity === "offline" && agent && !hostedLocally) {
            const freshAgent = await authoritativeAgent();
            if (freshAgent) agent = freshAgent;
            const redisOfflineDetail = redisActivity.detail.trim();
            const hasSpecificRedisOfflineDetail = redisOfflineDetail !== "" && redisOfflineDetail.toLowerCase() !== "stopped";
            if (freshAgent?.status === "stopped" && !hasSpecificRedisOfflineDetail) {
              const stopped = this.formatActivity("offline", "Stopped");
              span.end("ok", { attrs: { outcome: stopped.activity, source: "redis-stopped-refresh" } });
              return stopped;
            }
          }
          const resolved = await this.resolveActivityHint(agentId, agent, redisActivity, "redis", span, prefetched);
          if (resolved) {
            span.end("ok", { attrs: { outcome: resolved.activity, source: "redis" } });
            return resolved;
          }
        }
      }

      const persisted = await this.resolveRecentPersistedActivity(agentId, agent, span, prefetched);
      if (persisted) {
        span.end("ok", { attrs: { outcome: persisted.activity, source: "persisted" } });
        return persisted;
      }
      const derived = await this.resolveDerivedActivity(agent, prefetched);
      span.end("ok", { attrs: { outcome: derived.activity, source: "derived" } });
      return derived;
    } catch (err) {
      span.addEvent("activity.resolve.failed", {
        error_class: errorClassOf(err),
      });
      span.end("error");
      throw err;
    }
  }

  async listRecentActivityLog(agentId: string, limit = 50) {
    return this.loadPersistedActivityLog(agentId, limit);
  }

  /**
   * Diagnostics: when the live status snapshot was observed (the reporter's
   * occurredAt when known, else when this server recorded it), from the fresher
   * of the local snapshot and the cross-replica mirror. Null when neither exists.
   */
  async getLiveActivityObservedAtMs(agentId: string): Promise<number | null> {
    const local = this.agentActivity.get(agentId) ?? null;
    const mirrored = this.replicaStateStore.isAvailable()
      ? activitySnapshotFromPersisted(await this.readAgentActivityForActivity(agentId))
      : null;
    const snapshot = local && (!mirrored || local.updatedAt >= mirrored.updatedAt) ? local : mirrored;
    return snapshot ? this.getActivityObservedAtMs(snapshot) : null;
  }

  /**
   * Unified activity broadcast — emits a single `agent:activity` Socket.io event
   * carrying both the status (activity/detail) and trajectory entries.
   *
   * When trajectory entries are present, the event is emitted immediately (entries
   * must not be dropped). Explicit heartbeats, read-only activity-probe snapshots,
   * and the delivery-ack turn-active overlay emit refresh-only frames without
   * persistence; other status-only updates are debounced to merge rapid changes.
   */
  private broadcastActivity(
    agentId: string,
    activity: AgentActivityKind,
    detail: string = "",
    detailKind: AgentActivityDetailKind = "other",
    entries?: TrajectoryEntry[],
    nowOverride?: number,
    options: {
      dedupeKey?: string;
      launchId?: string;
      clientSeq?: number;
      probeId?: string;
      producerFactId?: string;
      observedAtMs?: number;
      isHeartbeat?: boolean;
      isDeliveryAckTurnActive?: boolean;
      arbitration?: ActivityBroadcastArbitrationInput;
    } = {},
  ): ActivityBroadcastTraceResult {
    const now = nowOverride ?? this.clock.now();
    const writeResult = this.writeAgentActivitySnapshot(agentId, activity, detail, detailKind, now, {
      launchId: options.launchId,
      observedAtMs: options.observedAtMs,
      arbitration: options.arbitration,
    });

    if (writeResult.action === "kernel-preserve") {
      return {
        action: "kernel-preserve",
        arbitration: writeResult.arbitration,
        persistedEntryCount: 0,
        previousActivity: writeResult.previousActivity,
        nextActivity: writeResult.nextActivity,
      };
    }

    const snapshot = writeResult.snapshot;
    if (!snapshot) {
      return {
        action: "kernel-preserve",
        arbitration: writeResult.arbitration,
        persistedEntryCount: 0,
        previousActivity: writeResult.previousActivity,
        nextActivity: writeResult.nextActivity,
      };
    }
    const nextActivity = snapshot.activity;
    const nextDetail = snapshot.detail;
    const nextDetailKind = snapshot.detailKind;

    const hasEntries = Boolean(entries && entries.length > 0);
    const shouldPersistStatusOnly = !hasEntries && this.shouldPersistStatusOnlyActivity(nextActivity, nextDetailKind);
    const action = planActivityBroadcastAction({
      hasEntries,
      isHeartbeat: options.isHeartbeat === true,
      isProbeResponse: options.probeId !== undefined,
      isDeliveryAckTurnActive: options.isDeliveryAckTurnActive === true,
      shouldPersistStatusOnly,
    });
    const persistedEntries: TrajectoryEntry[] = hasEntries
      ? (entries ?? [])
      : [{ kind: "status", activity: nextActivity, activityKind: nextActivity, detail: nextDetail, detailKind: nextDetailKind }];

    const persistence = this.applyActivityBroadcastAction({
      action,
      agentId,
      activity: nextActivity,
      detail: nextDetail,
      detailKind: nextDetailKind,
      now,
      persistedEntries,
      dedupeKey: options.dedupeKey,
      carriers: snapshotTypedCarriers(snapshot),
      // Pass-through join keys (task #136). Only attached to the
      // persist-and-emit-now path; status-only debounced emits drop
      // them on purpose so the final-state merge doesn't claim a
      // launch key that belongs to a particular pre-debounce
      // transition. Feedback-export classifies dropped rows as
      // `join_key_missing`.
      ...(options.launchId !== undefined ? { launchId: options.launchId } : {}),
      ...(options.clientSeq !== undefined ? { clientSeq: options.clientSeq } : {}),
      ...(options.probeId !== undefined ? { probeId: options.probeId } : {}),
      ...(options.producerFactId !== undefined ? { producerFactId: options.producerFactId } : {}),
      ...(options.isHeartbeat !== undefined ? { isHeartbeat: options.isHeartbeat } : {}),
    });

    return {
      action,
      arbitration: writeResult.arbitration,
      persistedEntryCount: action === "heartbeat-refresh"
        || action === "probe-refresh"
        || action === "delivery-ack-refresh"
        ? 0
        : persistedEntries.length,
      previousActivity: writeResult.previousActivity,
      nextActivity,
      persistence,
    };
  }

  private writeAgentActivitySnapshot(
    agentId: string,
    activity: AgentActivityKind,
    detail: string = "",
    detailKind: AgentActivityDetailKind = "other",
    now: number = this.clock.now(),
    options: {
      launchId?: string;
      observedAtMs?: number;
      arbitration?: ActivityBroadcastArbitrationInput;
    } = {},
  ): AgentActivitySnapshotWriteResult {
    const observedAtMs = options.observedAtMs ?? now;
    const observedAtMsExplicit = options.observedAtMs !== undefined;
    const current = this.agentActivity.get(agentId);
    const previousActivity = current?.activity ?? null;
    const arbitration = options.arbitration ?? {
      observationClass: "observed" as const,
      signalSite: "lifecycle_plan" as const,
    };
    const arbitrationDecision = this.planActivityBroadcastArbitration({
      activity,
      current,
      detailKind,
      launchId: options.launchId,
      now,
      observedAtMs,
      observedAtMsExplicit,
      signal: arbitration,
    });

    if (!arbitrationDecision.admit) {
      return {
        action: "kernel-preserve" as const,
        arbitration: {
          enabled: true,
          reason: arbitrationDecision.verdict?.reason ?? "legacy_disabled",
          verdictAction: arbitrationDecision.verdict?.action ?? "legacy",
        },
        previousActivity,
        nextActivity: current?.activity ?? activity,
      };
    }

    const nextActivity = arbitrationDecision.activity;
    const nextDetail = arbitrationDecision.detail ?? detail;
    const nextDetailKind = arbitrationDecision.detailKind ?? detailKind;
    const nextObservedAtMs = arbitrationDecision.observedAtMs ?? current?.observedAtMs;
    // task #1116: the carrier rides only a delivery_unconsumed write; any other
    // write drops it (and the pending capture) so it never lingers.
    const deliveryConsumption = nextDetailKind === "delivery_unconsumed"
      ? this.pendingDeliveryConsumption.get(agentId) ?? current?.deliveryConsumption
      : undefined;
    this.pendingDeliveryConsumption.delete(agentId);
    const wakeCrashLoop = nextDetailKind === "wake_crash_loop_blocked"
      ? this.pendingWakeCrashLoop.get(agentId) ?? current?.wakeCrashLoop
      : undefined;
    this.pendingWakeCrashLoop.delete(agentId);
    // task #1123: likewise the spawn-failure reason rides only a
    // runtime_unavailable write and is dropped by any other write.
    // A fresh runtime_unavailable ingest always decides (carrier or explicit
    // none); only a write that did not come from such a frame keeps the
    // current observation.
    const spawnFailure = nextDetailKind === "runtime_unavailable"
      ? (this.pendingSpawnFailure.has(agentId)
        ? this.pendingSpawnFailure.get(agentId) ?? undefined
        : current?.spawnFailure)
      : undefined;
    this.pendingSpawnFailure.delete(agentId);
    const toolStuck = this.pendingToolStuck.get(agentId);
    this.pendingToolStuck.delete(agentId);
    // Reconciler step 4b: the held notice's reason rides only an idle write.
    // A daemon frame always decides (its carrier, or none); only a write that
    // did not come from one keeps the current observation.
    const credentialHold = nextDetailKind === "idle"
      ? (this.pendingCredentialHold.has(agentId)
        ? this.pendingCredentialHold.get(agentId) ?? undefined
        : current?.credentialHold)
      : undefined;
    this.pendingCredentialHold.delete(agentId);
    const snapshot: ActivitySnapshot = {
      activity: nextActivity,
      detail: nextDetail,
      detailKind: nextDetailKind,
      ...(nextObservedAtMs !== undefined ? { observedAtMs: nextObservedAtMs } : {}),
      updatedAt: now,
      ...(deliveryConsumption ? { deliveryConsumption } : {}),
      ...(wakeCrashLoop ? { wakeCrashLoop } : {}),
      ...(spawnFailure ? { spawnFailure } : {}),
      ...(toolStuck ? { toolStuck } : {}),
      ...(credentialHold ? { credentialHold } : {}),
    };

    this.agentActivity.set(agentId, snapshot);

    // Mirror to Redis for cross-replica consistency (fire-and-forget). The
    // typed carrier rides the same write so a non-owner replica's refresh
    // read-back exposes it (task #1116).
    this.replicaStateStore
      .setAgentActivity(agentId, nextActivity, nextDetail, nextDetailKind, nextObservedAtMs, snapshotTypedCarriers(snapshot))
      .catch(() => {});

    return {
      action: "map-write",
      arbitration: {
        enabled: arbitrationDecision.enabled,
        reason: arbitrationDecision.verdict?.reason ?? "legacy_disabled",
        verdictAction: arbitrationDecision.verdict?.action ?? "legacy",
      },
      previousActivity,
      nextActivity,
      snapshot,
    };
  }

  private isAgentActivityKernelArbitrationEnabled(): boolean {
    if (readAnyBooleanEnv([
      "RAFT_DISABLE_AGENT_ACTIVITY_KERNEL_ARBITRATION",
      "SLOCK_DISABLE_AGENT_ACTIVITY_KERNEL_ARBITRATION",
    ])) {
      return false;
    }
    return readAnyBooleanEnv([
      "RAFT_ENABLE_AGENT_ACTIVITY_KERNEL_ARBITRATION",
      "SLOCK_ENABLE_AGENT_ACTIVITY_KERNEL_ARBITRATION",
    ]);
  }

  private planActivityBroadcastArbitration(input: {
    activity: AgentActivityKind;
    current?: ActivitySnapshot;
    detailKind: AgentActivityDetailKind;
    launchId?: string;
    now: number;
    observedAtMs: number;
    observedAtMsExplicit: boolean;
    signal: ActivityBroadcastArbitrationInput;
  }): {
    activity: AgentActivityKind;
    admit: boolean;
    detail?: string;
    detailKind?: AgentActivityDetailKind;
    enabled: boolean;
    observedAtMs?: number;
    verdict?: LifecycleArbitrationVerdict;
  } {
    // External-agent activity (plugin hook events forwarded over the agent
    // API) always goes through the kernel: those events arrive over HTTP in
    // batches and may be reordered, so latest-occurredAt-wins must hold
    // regardless of the managed-agent rollout flag. Managed behavior is
    // unchanged: it still follows the env flag.
    const isExternalSignal = input.signal.planKind === "external_agent_signal";
    if (!isExternalSignal && !this.isAgentActivityKernelArbitrationEnabled()) {
      return {
        activity: input.activity,
        admit: true,
        detailKind: input.detailKind,
        enabled: false,
        observedAtMs: input.signal.observationClass === "observed"
          ? input.observedAtMsExplicit
            ? input.observedAtMs
            : input.current?.observedAtMs
          : input.current?.observedAtMs,
      };
    }

    const currentProjection = input.current
      ? legacyActivityToCanonicalProjection(input.current.activity, input.current.detailKind)
      : "unknown";
    const incomingProjection = legacyActivityToCanonicalProjection(input.activity, input.detailKind);
    const verdict = arbitrateLifecycleProjection(
      {
        currentLaunchGeneration: input.launchId ?? null,
        // External ordering compares only against previously observed external
        // time; an unrelated server-side write's wall-clock updatedAt must not
        // make a slightly-skewed client event look stale.
        lastObservedAtMs: input.current?.observedAtMs
          ?? (isExternalSignal ? 0 : input.current?.updatedAt ?? 0),
        projection: currentProjection,
        startingAffordance: input.current ? this.isStartingActivitySnapshot(input.current) : false,
      },
      {
        atMs: input.observedAtMs,
        launchGeneration: input.launchId ?? null,
        observationClass: input.signal.observationClass,
        projection: incomingProjection,
      },
    );

    if (
      verdict.action === "preserve"
      || (verdict.action === "arbitrate" && verdict.projection === currentProjection && incomingProjection !== currentProjection)
    ) {
      return {
        activity: input.current?.activity ?? input.activity,
        admit: false,
        detail: input.current?.detail,
        detailKind: input.current?.detailKind,
        enabled: true,
        observedAtMs: input.current?.observedAtMs,
        verdict,
      };
    }

    if (verdict.action === "degrade_unknown") {
      return {
        activity: input.current?.activity ?? input.activity,
        admit: false,
        detail: input.current?.detail,
        detailKind: input.current?.detailKind,
        enabled: true,
        observedAtMs: input.current?.observedAtMs,
        verdict,
      };
    }

    if (verdict.action === "resolve_starting") {
      return {
        activity: "online",
        admit: true,
        detail: "",
        detailKind: "idle",
        enabled: true,
        observedAtMs: input.current?.observedAtMs,
        verdict,
      };
    }

    const admittedObservedAtMs = input.signal.observationClass === "observed"
      || input.signal.observationClass === "observed_turn_active"
      ? Math.max(input.current?.observedAtMs ?? 0, input.observedAtMs)
      : input.current?.observedAtMs;
    return {
      activity: input.activity,
      admit: true,
      detailKind: input.detailKind,
      enabled: true,
      observedAtMs: admittedObservedAtMs,
      verdict,
    };
  }

  protected applyActivityBroadcastAction(context: ActivityBroadcastApplyContext): Promise<ActivityPersistenceOutcome> | undefined {
    if (context.action === "persist-and-emit-now") {
      const persistence = this.persistActivityEvent(
        context.agentId,
        context.activity,
        context.detail,
        context.persistedEntries,
        new Date(context.now),
        context.dedupeKey,
      ).then((inserted): ActivityPersistenceOutcome => inserted ? "applied" : "deduped")
        .catch((err): ActivityPersistenceOutcome => {
          console.warn(`[ActivityLog ${context.agentId}] Failed to persist activity event:`, err);
          return "error";
        });

      // Trajectory entries present — emit immediately (cancel any pending debounce)
      const existing = this.activityDebounceTimers.get(context.agentId);
      if (existing) {
        clearTimeout(existing);
        this.activityDebounceTimers.delete(context.agentId);
      }
      this.emitActivity(
        context.agentId,
        context.activity,
        context.detail,
        context.detailKind,
        context.now,
        context.persistedEntries,
        // Pass-through join keys on the immediate-emit path (task #136).
        // Status-only debounced emits below (line ~5800) intentionally
        // do not carry these — see ActivityBroadcastApplyContext doc.
        {
          ...(context.launchId !== undefined ? { launchId: context.launchId } : {}),
          ...(context.clientSeq !== undefined ? { clientSeq: context.clientSeq } : {}),
          ...(context.probeId !== undefined ? { probeId: context.probeId } : {}),
          ...(context.producerFactId !== undefined ? { producerFactId: context.producerFactId } : {}),
          ...(context.carriers ? { carriers: context.carriers } : {}),
        },
      );
      return persistence;
    }

    if (
      context.action === "heartbeat-refresh"
      || context.action === "probe-refresh"
      || context.action === "delivery-ack-refresh"
    ) {
      const existing = this.activityDebounceTimers.get(context.agentId);
      if (existing) {
        clearTimeout(existing);
        this.activityDebounceTimers.delete(context.agentId);
      }
      void this.emitActivity(
        context.agentId,
        context.activity,
        context.detail,
        context.detailKind,
        context.now,
        undefined,
        {
          ...(context.launchId !== undefined ? { launchId: context.launchId } : {}),
          ...(context.clientSeq !== undefined ? { clientSeq: context.clientSeq } : {}),
          ...(context.probeId !== undefined ? { probeId: context.probeId } : {}),
          ...(context.producerFactId !== undefined ? { producerFactId: context.producerFactId } : {}),
          ...(context.action === "heartbeat-refresh" ? { isHeartbeat: true } : {}),
          isRefreshOnly: true,
          ...(context.carriers ? { carriers: context.carriers } : {}),
        },
      );
      return undefined;
    }

    // Status-only update — debounce to merge rapid state changes
    const existing = this.activityDebounceTimers.get(context.agentId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.activityDebounceTimers.delete(context.agentId);
      const latest = this.agentActivity.get(context.agentId);
      if (!latest) return;
      this.emitActivity(context.agentId, latest.activity, latest.detail, latest.detailKind, this.clock.now(), undefined, {
        carriers: snapshotTypedCarriers(latest),
      });
    }, AgentOrchestrator.ACTIVITY_DEBOUNCE_MS);

    this.activityDebounceTimers.set(context.agentId, timer);
    return undefined;
  }

  protected async updateMachineHeartbeat(machineId: string) {
    await machineService.updateHeartbeat(machineId);
  }

  protected async persistActivityEvent(
    agentId: string,
    activity: string,
    detail: string,
    entries: TrajectoryEntry[],
    createdAt: Date,
    dedupeKey?: string,
  ): Promise<boolean> {
    if (this.shouldSkipActivityLogPersistence(agentId)) {
      return false;
    }
    const inserted = await agentActivityLogService.appendAgentActivityEvent(agentId, activity, detail, entries, createdAt, dedupeKey);
    await this.persistDaemonTurnSummaries(agentId, entries);
    return inserted;
  }

  /**
   * Task #17: a daemon's `turn_summary` entries also go to the per-turn
   * summary table the Activity overview reads. Keyed by the turn's start, so a
   * replayed frame rewrites the same row. Best effort: the log row stands.
   */
  private async persistDaemonTurnSummaries(agentId: string, entries: readonly TrajectoryEntry[]): Promise<void> {
    // Stored as a producer may report it (readDaemonTurnSummary): only the
    // ActivityTurnSummary fields, rebuilt from their known shapes; an
    // implausible summary (bad times, an unreadable trigger) is not stored.
    // What the server attaches, `running` and anything else are never the
    // daemon's to set.
    const turns = entries.flatMap((entry) => {
      const summary = entry.kind === "turn_summary" ? readDaemonTurnSummary(entry.summary) : undefined;
      return summary ? [{ turnKey: `daemon:${summary.startedAt}`, summary }] : [];
    });
    if (turns.length === 0) return;
    try {
      await this.upsertTurnSummaries(agentId, turns);
    } catch (err) {
      console.warn(`[ActivityLog ${agentId}] Failed to persist turn summaries:`, err);
    }
  }

  protected async upsertTurnSummaries(agentId: string, turns: readonly { turnKey: string; summary: ActivityTurnSummary }[]): Promise<void> {
    await agentActivityLogService.upsertAgentTurnSummaries(agentId, turns);
  }

  /** Newest finished turns first (Activity overview, task #17). */
  async listTurnSummaries(
    agentId: string,
    options: { limit?: number; before?: agentActivityLogService.TurnSummaryCursor } = {},
  ): Promise<{ summaries: agentActivityLogService.StoredTurnSummary[]; next?: agentActivityLogService.TurnSummaryCursor }> {
    return this.loadTurnSummaries(agentId, options);
  }

  /** One stored turn of the agent by row id, or null. */
  async getTurnSummary(agentId: string, id: string): Promise<agentActivityLogService.StoredTurnSummary | null> {
    return agentActivityLogService.getAgentTurnSummary(agentId, id);
  }

  /**
   * The turn still running (Activity overview, task #17): the agent's activity
   * rows after `afterMs` (the newest finished turn's end; null when none has
   * finished, then its latest rows) folded the way its finished turns are, by
   * the external agent's own boundaries or the daemon's. Null when no turn is
   * open in them. Its `endedAt` is now. The rows alone cannot say the agent is
   * still busy (an error or a lost idle leaves a turn open): callers ask only
   * while its live activity is working or thinking. At most RUNNING_TURN_ROWS
   * rows from the turn's start: a longer turn's counts stop there.
   */
  async getRunningTurn(agentId: string, afterMs: number | null): Promise<RunningTurn | null> {
    const loaded = afterMs === null
      ? await this.loadPersistedActivityLog(agentId, RUNNING_TURN_ROWS)
      : await this.loadPersistedActivityLogAfter(agentId, afterMs, RUNNING_TURN_ROWS);
    const external = this.externalHookTurnAgents.has(agentId)
      || loaded.some((row) => isExternalHookEntry(row.entry) || externalReportedStatus(row.entry) !== null);
    // As in rebuildExternalTurnSummaries: a hosted subagent's steps are never a parent turn's.
    const rows = external ? loaded.filter((row) => !(row.entry as SubagentLineage).subagent) : loaded;
    const boundaries = external ? externalTurnBoundaries(rows, this.externalHookTurnAgents.has(agentId)) : DAEMON_LOG_TURN_BOUNDARIES;
    if (rows.length === 0) return null;
    const now = this.clock.now();
    const sends = await this.loadAgentSentMessagesBetween(agentId, Math.min(...rows.map((row) => row.timestamp)), now);
    const { turns, open } = summarizeTurnsFromLog(rows, { ...boundaries, sends });
    if (!open) return null;
    const turn = { ...open.summary, endedAt: Math.max(now, open.summary.startedAt) };
    const continuesPreviousTurn = !external && isRuntimeProgressEntry(rows[open.startIndex]!.entry);
    // A newer daemon holds an empty wake and stores it only with the work
    // that follows (TurnSummaryTracker), so until then it is in these rows
    // alone, closed by its idle: the work takes its trigger and start here,
    // as the stored turn will.
    const wake = turns.at(-1)?.summary;
    if (continuesPreviousTurn && !turn.trigger && wake && continuesEmptyWake(wake, turn.startedAt)) {
      return { turn: { ...turn, startedAt: wake.startedAt, trigger: wake.trigger, ...lastTextOf(turn, wake) }, continuesPreviousTurn };
    }
    return { turn, continuesPreviousTurn };
  }

  protected async loadTurnSummaries(
    agentId: string,
    options: { limit?: number; before?: agentActivityLogService.TurnSummaryCursor },
  ): Promise<{ summaries: agentActivityLogService.StoredTurnSummary[]; next?: agentActivityLogService.TurnSummaryCursor }> {
    return agentActivityLogService.listAgentTurnSummaries(agentId, options);
  }

  protected async loadLastTurnEndBefore(agentId: string, beforeMs: number): Promise<number | null> {
    return agentActivityLogService.latestAgentTurnEndBefore(agentId, beforeMs);
  }

  protected async loadPersistedActivityLogAfter(agentId: string, afterMs: number, limit: number) {
    return agentActivityLogService.listAgentTrajectoryAfter(agentId, afterMs, limit);
  }

  protected async loadAgentSentMessagesBetween(agentId: string, fromMs: number, toMs: number): Promise<{ at: number; messageId: string }[]> {
    return agentActivityLogService.listAgentSentMessagesBetween(agentId, fromMs, toMs);
  }

  /**
   * Task #17: rebuild turn summaries for an agent without a daemon from its
   * stored hook rows. Hook events arrive in batches and out of order (a
   * PreToolUse carries the tool's back-dated start), so every batch refolds
   * the recent window in event-time order and upserts each closed turn it
   * touched; a late event rewrites its turn's row.
   */
  private async rebuildExternalTurnSummaries(agentId: string, touchedFromMs: number): Promise<void> {
    try {
      // Refold only from the last turn that ended before the earliest event in
      // this batch (less the soft-end grace, which can still extend it): older
      // turns cannot change, so the cost per batch stays one turn or so.
      const boundary = await this.loadLastTurnEndBefore(agentId, touchedFromMs - EXTERNAL_SOFT_END_GRACE_MS);
      const loaded = boundary === null
        ? await this.loadPersistedActivityLog(agentId, EXTERNAL_TURN_SUMMARY_WINDOW_ROWS)
        : await this.loadPersistedActivityLogAfter(agentId, boundary, EXTERNAL_TURN_SUMMARY_REFOLD_ROWS);
      // A hosted subagent runs on its own, between the parent's turns (the
      // parent ends its turn after spawning it; the report wakes a new one), so
      // its steps are the subagent's, never a parent turn's.
      const rows = loaded.filter((row) => !(row.entry as SubagentLineage).subagent);
      if (rows.length === 0) return;
      const windowStart = Math.min(...rows.map((row) => row.timestamp));
      const sends = await this.loadAgentSentMessagesBetween(agentId, windowStart, this.clock.now());
      // Once an agent has sent hook boundaries it is split by hooks for good,
      // so a window that starts before this turn's UserPromptSubmit arrived
      // does not fall back to statuses and key the turn differently.
      if (rows.some((row) => externalHookBoundary(row.entry) !== null)) this.externalHookTurnAgents.add(agentId);
      const turns = summarizeTurnsFromLog(rows, { ...externalTurnBoundaries(rows, this.externalHookTurnAgents.has(agentId)), sends }).turns.filter((turn) => turn.summary.endedAt >= touchedFromMs || boundary !== null);
      if (turns.length === 0) return;
      await this.upsertTurnSummaries(agentId, turns.map((turn) => {
        const start = rows[turn.startIndex]!.entry;
        return { turnKey: `external:${start.producerFactId ?? rows[turn.startIndex]!.timestamp}`, summary: turn.summary };
      }));
    } catch (err) {
      console.warn(`[ActivityLog ${agentId}] Failed to rebuild external turn summaries:`, err);
    }
  }

  private shouldSkipActivityLogPersistence(agentId: string): boolean {
    const agent = this.agentStateCache.get(agentId);
    return agent ? hydrateRuntimeConfig(agent).runtime === "kimi" : false;
  }

  private planKimiActivityCircuitBreaker(input: {
    activity: AgentActivity;
    agent: CachedAgentState;
    entries?: TrajectoryEntry[];
    launchId?: string | null;
    now: number;
    probeId?: string;
  }): KimiActivityCircuitDecision {
    const runtime = hydrateRuntimeConfig(input.agent).runtime;

    // Workaround for Kimi CLI crash loops observed in production on 2026-06-04.
    // Kimi can alternate repeated `error`/`working` updates for the same launch
    // fast enough to saturate lifecycle projection, Redis mirror, and Socket.IO
    // fanout. Keep the CLI usable by preserving user messages, probes,
    // launch/clientSeq guards, terminal states, and genuinely new trajectory
    // entries; only collapse repeated same-launch crash/working signatures
    // before the expensive projection writer. Delete this once daemon activity
    // is split into first-class lifecycle/progress/log-entry protocols.
    const candidateSignature =
      runtime === "kimi"
      && Boolean(input.launchId)
      && !input.probeId
      && (input.activity === "error" || input.activity === "working")
        ? this.kimiActivityCircuitSignature(input.activity, input.entries)
        : null;

    if (!candidateSignature) {
      if (
        runtime === "kimi"
        && input.launchId
        && (input.activity === "offline" || input.activity === "online")
      ) {
        this.kimiActivityCircuitByLaunch.delete(`${input.agent.id}:${input.launchId}`);
      }
      return { action: "allow" };
    }

    const key = `${input.agent.id}:${input.launchId}`;
    const existing = this.kimiActivityCircuitByLaunch.get(key);
    if (!existing || input.now - existing.lastObservedAt > AgentOrchestrator.KIMI_ACTIVITY_CIRCUIT_WINDOW_MS) {
      this.kimiActivityCircuitByLaunch.set(key, {
        emittedSignatures: new Set([candidateSignature]),
        lastEmittedAt: input.now,
        lastObservedAt: input.now,
        suppressedCount: 0,
      });
      return { action: "allow" };
    }

    existing.lastObservedAt = input.now;

    if (!existing.emittedSignatures.has(candidateSignature)) {
      existing.emittedSignatures.add(candidateSignature);
      return { action: "allow" };
    }

    if (input.now - existing.lastEmittedAt >= AgentOrchestrator.KIMI_ACTIVITY_CIRCUIT_AGGREGATE_MS) {
      const aggregateSuppressedCount = existing.suppressedCount;
      existing.lastEmittedAt = input.now;
      existing.suppressedCount = 0;
      return { action: "allow", aggregateSuppressedCount };
    }

    existing.suppressedCount += 1;
    return { action: "suppress", suppressedCount: existing.suppressedCount };
  }

  private kimiActivityCircuitSignature(activity: AgentActivity, entries?: TrajectoryEntry[]): string {
    if (!entries?.length) return "status-only";

    const entrySignature = entries
      .map((entry) => {
        switch (entry.kind) {
          case "thinking":
          case "text":
            return `${entry.kind}:${entry.text}`;
          case "tool_start":
            return `tool_start:${entry.toolName}:${entry.toolInput}`;
          case "slock_action":
          case "system":
            return `${entry.kind}:${entry.title}:${entry.text}`;
          case "compaction_started":
          case "compaction_finished":
            return entry.kind;
          case "status":
            return `status:${entry.activity}:${entry.detail}`;
        }
      })
      .join("\n")
      .slice(0, 4000);

    return `${activity}:${entrySignature}`;
  }

  protected async loadPersistedActivityLog(agentId: string, limit: number) {
    return agentActivityLogService.listRecentAgentTrajectory(agentId, limit);
  }

  protected async loadLatestPersistedActivityHint(agentId: string) {
    return agentActivityLogService.getLatestAgentActivityHint(agentId);
  }

  private async emitActivity(
    agentId: string,
    activity: AgentActivityKind,
    detail: string,
    detailKind: AgentActivityDetailKind,
    timestamp: number,
    entries?: TrajectoryEntry[],
    joinKeys?: {
      launchId?: string;
      clientSeq?: number;
      probeId?: string;
      producerFactId?: string;
      isHeartbeat?: boolean;
      isRefreshOnly?: boolean;
      carriers?: ActivityTypedCarriers;
    },
  ) {
    const agent = await this.getCachedAgent(agentId);
    if (agent) {
      // Bump the monotonic seq before emit so the client can
      // drop pushes that arrive out-of-order during reconnect storms
      // (a race between socket-pushed updates and an in-flight
      // `loadAgents()` REST call). (#engineering:72283cf7 task #340 PR B)
      const nextSeq = nextActivityServerSeq(this.lastActivityServerSeq, this.clock.now());
      this.lastActivityServerSeq = nextSeq;
      // task #1116: pass the daemon's typed carrier through when this emit is
      // the delivery_unconsumed observation (ids/classes/counts only).
      // Prefer the carrier of the snapshot this emit is for; fall back to the
      // current snapshot for legacy call sites that did not thread it.
      const current = this.agentActivity.get(agentId);
      const deliveryConsumption = detailKind === "delivery_unconsumed"
        ? joinKeys?.carriers?.deliveryConsumption ?? current?.deliveryConsumption
        : undefined;
      const wakeCrashLoop = detailKind === "wake_crash_loop_blocked"
        ? joinKeys?.carriers?.wakeCrashLoop ?? current?.wakeCrashLoop
        : undefined;
      // task #1123: the typed spawn-failure reason rides the runtime_unavailable emit.
      const spawnFailure = detailKind === "runtime_unavailable"
        ? this.agentActivity.get(agentId)?.spawnFailure
        : undefined;
      // task #25: the stuck-tool state of the snapshot this emit is for.
      const toolStuck = joinKeys?.carriers ? joinKeys.carriers.toolStuck : current?.toolStuck;
      // Reconciler step 4b: the held notice's reason rides the idle emit of
      // the snapshot this emit is for.
      const credentialHold = detailKind === "idle"
        ? (joinKeys?.carriers ? joinKeys.carriers.credentialHold : current?.credentialHold)
        : undefined;
      const publicPayload = {
        agentId,
        activity,
        activityKind: activity,
        detail,
        detailKind,
        timestamp,
        serverSeq: nextSeq,
        ...(deliveryConsumption ? { deliveryConsumption } : {}),
        ...(wakeCrashLoop ? { wakeCrashLoop } : {}),
        ...(spawnFailure ? { spawnFailure } : {}),
        ...(toolStuck ? { toolStuck } : {}),
        ...(credentialHold ? { credentialHold } : {}),
        // Daemon socket-message join keys (task #136). `serverSeq` is the
        // server-side monotonic identity for THIS broadcast; `clientSeq`
        // is the daemon-side monotonic identity for the inbound message
        // that produced it. Keep them as separate fields so feedback-
        // export bundles can exact-join the latter against
        // `server.agent.activity.ingest` correlationId
        // `agent:<agentId>:daemonActivity:<launchId|legacy>:<clientSeq>`.
        ...(joinKeys?.launchId !== undefined ? { launchId: joinKeys.launchId } : {}),
        ...(joinKeys?.clientSeq !== undefined ? { clientSeq: joinKeys.clientSeq } : {}),
        ...(joinKeys?.probeId !== undefined ? { probeId: joinKeys.probeId } : {}),
        ...(joinKeys?.producerFactId !== undefined ? { producerFactId: joinKeys.producerFactId } : {}),
        ...(joinKeys?.isHeartbeat !== undefined ? { isHeartbeat: joinKeys.isHeartbeat } : {}),
        ...(joinKeys?.isRefreshOnly !== undefined ? { isRefreshOnly: joinKeys.isRefreshOnly } : {}),
      };
      // #wg-rbac:#57: an error activity's text reaches only the agent's
      // managers (the creator, `editAgents`; an assistant's owner, who alone is
      // in its agentEventRoom). Every other socket gets the code and its fixed
      // sentence, or the generic message. The managers' sockets on this server
      // are taken out of the member push and get theirs in their own rooms.
      const runtimeErrorPush = isRuntimeErrorDetailActivity({ activity, detailKind })
        ? await this.runtimeErrorActivityPush(agent, agentId, { activity, detailKind, detail }, publicPayload)
        : null;
      const doEmit = () => {
        if (runtimeErrorPush) {
          const { memberPayload, managerPayload, managerRooms } = runtimeErrorPush;
          this.io?.to(agentEventRoom(agent.serverId, agent.assistantOwnerUserId)).except(agentActivityCapableServerRoom(agent.serverId)).except(managerRooms).emit("agent:activity", memberPayload);
          this.io?.to(agentActivityRoom(agentId)).except(managerRooms).emit("agent:activity", memberPayload);
          if (managerRooms.length > 0) this.io?.to(managerRooms).emit("agent:activity", managerPayload);
        }
        // Server and joint projection rooms can include members who may not be
        // allowed to inspect the agent's private workspace/action trajectory.
        // Keep raw entries behind the creator/admin activity-log hydration path.
        // A client that declared AGENT_ACTIVITY_SUBSCRIPTIONS_CAPABILITY is in
        // the server's capable room: it gets the detail only for the agents it
        // subscribed to (their own room), and the coarse state for all (the
        // fanout below). Every other client (the mobile App, an old web tab)
        // keeps the server-wide push unchanged (#proj-frontend:#8).
        // A personal assistant's activity reaches only its owner (agentEventRoom):
        // anyone else would learn that its owner is using it right now.
        if (!runtimeErrorPush) {
          this.io?.to(agentEventRoom(agent.serverId, agent.assistantOwnerUserId)).except(agentActivityCapableServerRoom(agent.serverId)).emit("agent:activity", publicPayload);
          this.io?.to(agentActivityRoom(agentId)).emit("agent:activity", publicPayload);
        }
        this.agentActivityStateFanout.observe(agentActivityStateRoom(agent.serverId, agent.assistantOwnerUserId), agentId, activity, timestamp, nextSeq);
        // Joint membership exposes basic presence, never the agent's unrelated
        // work summary, diagnostics, or runtime correlation identifiers.
        void this.emitJointActivityToProjectionRooms(agent.id, agent.serverId, {
          agentId,
          activity,
          activityKind: activity,
          detail: "",
          timestamp,
          serverSeq: nextSeq,
        });
      };
      // Injectable seam for the realtime push. Per cache-coherence contract
      // CC-006 the push is best-effort (drop/delay/reorder) and MUST NOT be
      // load-bearing for correctness — convergence is owed to write-through +
      // pull. Tests inject drop/delay here to prove that. Production uses the
      // noop failpoint registry: the fast path below runs the emit synchronously,
      // identical to before.
      if (!failpoints.enabled) {
        doEmit();
        return;
      }
      await failpoints.hit("server.agentActivity.emit", { agentId, activity, serverSeq: nextSeq }, doEmit);
    }
  }

  /**
   * #wg-rbac:#57: the two pushes of an error activity. A personal assistant's
   * agentEventRoom is its owner's alone, so its one push is the manager's.
   * When the managers cannot be read, nobody gets the text (they re-read it
   * over REST).
   */
  private async runtimeErrorActivityPush<P extends { detail: string }>(
    agent: CachedAgentState,
    agentId: string,
    shown: { activity: AgentActivityKind; detailKind: AgentActivityDetailKind; detail: string },
    payload: P,
  ): Promise<{ memberPayload: P & { errorCode?: string }; managerPayload: P & { errorCode?: string }; managerRooms: string[] }> {
    const lastRuntimeError = this.agentStateCache.get(agentId)?.lastRuntimeError ?? agent.lastRuntimeError ?? null;
    const manager = projectRuntimeErrorActivityDetail({ ...shown, lastRuntimeError }, "manager");
    const member = projectRuntimeErrorActivityDetail({ ...shown, lastRuntimeError }, "member");
    const managerPayload = { ...payload, ...manager };
    if (agent.assistantOwnerUserId) {
      return { memberPayload: managerPayload, managerPayload, managerRooms: [] };
    }
    let managerUserIds: string[] = [];
    try {
      managerUserIds = await this.runtimeErrorDetailViewerUserIds(agentId);
    } catch (err) {
      this.recordEvent("runtime_error_detail.viewers_unavailable", { error_class: errorClassOf(err) });
    }
    return {
      memberPayload: { ...payload, ...member },
      managerPayload,
      managerRooms: managerUserIds.map((userId) => socketUserServerRoom(userId, agent.serverId)),
    };
  }

  /**
   * The managers of an agent, read at most once per RUNTIME_ERROR_VIEWER_CACHE_TTL_MS
   * per agent (an error can be pushed in bursts). A role or creator change
   * takes effect within the TTL; a failed read is not cached.
   */
  private async runtimeErrorDetailViewerUserIds(agentId: string): Promise<string[]> {
    const now = this.clock.now();
    const cached = this.runtimeErrorViewerCache.get(agentId);
    if (cached && now - cached.readAtMs < AgentOrchestrator.RUNTIME_ERROR_VIEWER_CACHE_TTL_MS) return cached.userIds;
    const userIds = await this.loadRuntimeErrorDetailViewerUserIds(agentId);
    if (this.runtimeErrorViewerCache.size >= AgentOrchestrator.RUNTIME_ERROR_VIEWER_CACHE_MAX) this.runtimeErrorViewerCache.clear();
    this.runtimeErrorViewerCache.set(agentId, { userIds, readAtMs: now });
    return userIds;
  }

  protected async loadRuntimeErrorDetailViewerUserIds(agentId: string): Promise<string[]> {
    return agentService.listAgentRuntimeErrorDetailViewerUserIds(agentId);
  }

  private async emitJointActivityToProjectionRooms(
    agentId: string,
    sourceServerId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      const channelIds = await this.loadJointActivityProjectionChannelIdsForAgent(agentId, sourceServerId);
      for (const channelId of channelIds) {
        this.io?.to(`channel:${channelId}`).except(`server:${sourceServerId}`).emit("agent:activity", payload);
      }
    } catch (err) {
      console.error("[AgentOrchestrator] Failed to fan out joint activity", err);
    }
  }

  protected async loadJointActivityProjectionChannelIdsForAgent(agentId: string, sourceServerId: string): Promise<string[]> {
    return channelService.listJointActivityProjectionChannelIdsForAgent(agentId, sourceServerId);
  }
}

/**
 * The web copy of a `computer:restart:done` receipt: only the declared fields, with
 * the server's own `machineId` last so the daemon cannot name another machine. The
 * daemon's frame used to be spread whole into every web client in the server room.
 */
export function computerRestartDoneWebFrame(
  machineId: string,
  msg: { type: "computer:restart:done"; requestId: string; ok: boolean; error?: string },
): { type: "computer:restart:done"; machineId: string; requestId: string; ok: boolean; error?: string } {
  const frame: { type: "computer:restart:done"; machineId: string; requestId: string; ok: boolean; error?: string } = {
    type: msg.type,
    machineId,
    requestId: String(msg.requestId),
    ok: msg.ok === true,
  };
  if (typeof msg.error === "string") frame.error = msg.error.slice(0, COMPUTER_RESTART_ERROR_MAX_LENGTH);
  return frame;
}

const COMPUTER_RESTART_ERROR_MAX_LENGTH = 200;
