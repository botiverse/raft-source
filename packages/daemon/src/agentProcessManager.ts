import { shellCommandHeadCategory } from "./runtimeTraceCategories";
import type { AgentApiHistoryConsumptionScope } from "@botiverse/raft-shared";
import { finishToolCall, noteToolCallStart } from "./toolCallOutcome";
import { listWorkspaceDirectory, readWorkspaceFile, type WorkspaceFileRead } from "./agentWorkspaceViewer";
import { AgentSendIntentTracker } from "./agentSendIntentTracker";
import { DEFAULT_TOOL_STUCK_THRESHOLD_MS, stuckToolActivityDetail, ToolStuckWatch } from "./toolStuckWatch";
import { linuxClockTicksPerSecond } from "./drivers/processTree";
import { AGENT_STOP_KILL_CONFIRM_MS, AGENT_STOP_KILL_GRACE_MS } from "./drivers/processStop";
import { reapRecordedOrphans, RuntimeProcessLedger, type OrphanReapDeps, type RuntimeProcessLedgerDeps } from "./drivers/runtimeProcessLedger";
import { filterProcJobsFromRuntimeRecords } from "./procJobs";
import type { AgentTurnInterruptOutcome } from "@botiverse/raft-shared";
import { TurnSummaryTracker, turnOutcomeForActivity, turnTriggerFromMessages } from "./turnSummaryTracker";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { lstat, readFile, readdir, rm, stat } from "node:fs/promises";
import { createHash, randomInt, randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { daemonFetch } from "./daemonFetch";
import { runtimeEventEndsThinking, trajectoryActivityProjection } from "./activity/agentActivityProducer";
import { LegacyActivitySink, type ActivityProducerContext, type ActivitySink } from "./activity/activitySink";
import { TurnActivitySnapshotWriter } from "./activity/turnActivitySnapshot";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
import {
  type ActivityTurnTrigger,
  type DeliveryConsumptionActivityDiagnostic,
  getToolActivityLabel,
  isRuntimeProgressDetailKind,
  normalizeToolDisplayInvocation,
  resolveToolSemantic,
  summarizeToolInput,
  type AgentMessage,
  type MentionDeliveryIdentitySnapshot,
  type MentionDeliveryTerminalErrorCode,
  type MentionDeliveryTransitionStage,
  type AgentInboxAppItem,
  type AgentConfig,
  type FeedbackTranscriptSessionLookup,
  type AgentRuntimeProfileReport,
  type RuntimeProfileReportSource,
  type FileNode,
  type MachineToServerMessage,
  type AgentRuntimeOutcome,
  type AgentStartNotSpawnedReason,
  type ServerToMachineMessage,
  type WorkspaceDirectoryInfo,
  type TrajectoryEntry,
  type SubagentLineage,
  type SubagentOutcome,
  type AgentSubagentInterruptOutcome,
  type AgentActivityDetailKind,
  type AgentActivityKind,
  type RuntimeErrorActivityDiagnostic,
  type ToolStuckActivityDiagnostic,
  type CredentialHoldActivityDiagnostic,
  type RuntimeCompactionInterruption,
  type ToolCallOutcome,
  type SkillInfo,
  type AttentionHint,
  errorClassOf,
  noopTracer,
  type ActiveSpan,
  formatTraceparent,
  parseTraceparent,
  type TraceContext,
  type Tracer,
  setClockTimeout,
  clearClockTimeout,
  type ObservedFailureSummary,
  type FeedbackMachineState,
  type FeedbackTraceTail,
  asFeedbackTranscriptLookupMethod,
  type FeedbackTranscriptContentKind,
  type FeedbackTranscriptLookupMethod,
  type FeedbackTranscriptLookupReason,
  type FeedbackTranscriptUploadableContentKind,
  MODEL_SEEN_MAX_ITEMS_PER_REPORT,
  AGENT_TURN_ENDED_MAX_SHOWN_TARGETS,
  type AgentTurnEndedOutcome,
  type RuntimeErrorClass,
  isRuntimeAbsentStartFailure,
  NON_RETRYABLE_SPAWN_FAILURE_REASONS,
  RETRY_ONCE_SPAWN_FAILURE_REASONS,
  agentServerFeaturesEqual,
  pickAgentServerFeatures,
  withAgentServerFeatures,
  type AgentServerFeatures,
  type RuntimeAuthRuntime,
} from "@botiverse/raft-shared";
import { appInboxItemTraceAttrs } from "@botiverse/raft-shared/src/appRuntimeTrace";
import { getActiveTraceContext, runWithActiveSpan, runWithoutActiveSpan, withCanonicalTraceAttributes } from "@botiverse/raft-trace-client";

/** Legacy identity keys whose canonical field may live on events (see `fields.ts` placement). */
const DAEMON_EVENT_CANONICAL_ALIAS_KEYS = ["agentId"] as const;

/**
 * The fence's fingerprint (a hash of the scrubbed error text, never the text)
 * under its own name and under `runtime_error_fingerprint`, the name every
 * other runtime-error record and the trace sink's diagnostic list use, so one
 * query joins a fence record to the errors it counted.
 */
function fingerprintFenceTraceAttrs(fingerprint: string): { fingerprint: string; runtime_error_fingerprint: string } {
  return { fingerprint, runtime_error_fingerprint: fingerprint };
}
import {
  collectFeedbackTranscriptAttachment,
  defaultFeedbackTranscriptReportWindow,
  type FeedbackTranscriptCollectionResult,
  type FeedbackTranscriptReportWindowInput,
} from "./feedbackTranscriptCollector";
import { collectFeedbackMachineLogTailAttachment } from "./feedbackMachineLogTail";
import { uploadFeedbackTranscriptOutcome, type FeedbackTranscriptOutcomeUploadStatus } from "./feedbackTranscriptOutcomeUpload";
import { startFeedbackAgentEventTail, type FeedbackAgentEventTailOutcome } from "./feedbackAgentEventTail";
import { collectFeedbackMachineState, collectFeedbackTraceTail, redactedOrNull } from "./feedbackMachineEvidence";
import { collectObservedFailureSummary } from "./observedFailureSummary";
import { parseSkillFrontmatter } from "./skillFrontmatter";
import { AgentContextViewService, type ContextViewAgentFacts } from "./agentContextView/agentContextViewService";
import { isPiRequestLogRuntime, piRequestLogFile } from "./agentContextView/piRequestLog";
import { codexContextSessionRoot } from "./agentContextView/contextViewSource";
import { isPathWithinAllowedRoots, readAndRedactTranscriptDetailed, readSessionTranscriptChain, TranscriptPathRejectedError } from "./sessionTranscriptReader";
import {
  allowedTranscriptRootsForRuntime,
  createChildProcessRuntimeSession,
  ensureRuntimeHomeDir,
  getDriver,
  projectCompactionInterruptionTraceAttrs, projectStructuredRuntimeTerminalFailure,
  projectCompactionInterruption, formatCompactionInterruption,
  resolveRuntimeHomeDir,
  resolveRuntimeSessionRef,
  resolveRuntimeSessionRefDetailed,
  runtimeTranscriptHomesForConfig,
  type RuntimeDriver,
  type ParsedEvent,
  type ResolveRuntimeSessionRefOptions,
  type RuntimeSession,
  type RuntimeSendResult,
  type RuntimeProviderCallSnapshot,
  type RuntimeStopOptions,
} from "./drivers/index";
import { logger } from "./logger";
import { bindContextGenerationToSession, configPassiveAx, planSpawnContextGeneration, readContextGeneration, rememberSessionContext, writeContextGeneration } from "./contextGeneration";
import { passiveRenderTraceAttrs, takePassiveRenderCounts } from "./passiveRenderCounts";
import { elideSeenSendersInMessages, openSenderLedger, senderLedgerPath } from "./senderLedger";
import { resolvePassiveAx } from "./passiveAxGate";
import { buildCliTransportDir } from "./drivers/cliTransport";
import { reapOrphanProcesses } from "./daemonOrphanReaper";
import { deleteWorkspaceDirectory, scanWorkspaceDirectories } from "./workspaces";
import { initializeLaunchWorkspace, withLocalRuntimeContext } from "./agentLaunchWorkspace";
import { appInboxItemNoticed, appInboxNoticeText, inboxItemsLaunchAtMs } from "./agentAppInboxNotice";
import { carryHeldRunnerCredential, revokeManagedRunnerCredential } from "./runnerCredentialRevoke";
import { AgentStartCoordinator, type AgentStartQueueItem, type PendingStartRebind } from "./agentStartCoordinator";
import type { CapabilityWait, RecoveryGrant, StartRefusalDecision } from "./runtimeOutcomeOutbox";
import { AgentStartDispatchProjection, type AgentStartAcceptance } from "./agentStartDispatchProjection";
import { AgentStartPendingDeliveryBuffer } from "./agentStartPendingDeliveryBuffer";
import {
  AgentNoProcessResidency,
  AgentNoProcessResidencyTransitions,
  type AgentNoProcessResidencyCloseResult,
  type AgentNoProcessResidencyEnterInput,
  type AgentNoProcessResidencySnapshot,
  type AgentNoProcessResidencyState,
  type AgentNoProcessResidencyTransitionIdentity,
  type AgentNoProcessResidencyTransitionRow,
} from "./agentNoProcessResidency";
import {
  credentialInvalidAppliesToModel,
  credentialInvalidNoticeKey,
  type CredentialInvalidReason,
  type CredentialInvalidRecord,
  type CredentialInvalidVisibility,
  type ProviderLimitChange,
  type ProviderLimitLedger,
} from "./providerLimitLedger";
import {
  AgentLifecycleRecords,
  buildAgentLifecycleRecords,
  type AgentLifecycleRecord,
  type AgentLifecycleRecordSnapshot,
  type AgentRestartSnapshot,
  ownProviderLimitCredentialKey,
  providerLimitCredentialKey,
  providerLimitCredentialKeyKind,
  sharedProviderLimitCredentialKey,
  type ProviderLimitBackoffRecord,
  type ProviderLimitCredentialKey,
  type ProviderLimitReleaseCause,
} from "./agentLifecycleRecord";
import {
  LAUNCH_RUNTIME_READINESS_TRANSITION_SPAN,
  LAUNCH_ACTIVATION_DELIVERY_TRANSITION_SPAN,
  buildLaunchReadinessEnterAttrs,
  buildLaunchReadinessCloseAttrs,
  buildLaunchActivationEnterAttrs,
  buildLaunchActivationCloseAttrs,
  launchReadinessNegativeEvidence,
  type LaunchCloseResult,
  type LaunchDeliveredVia,
  type LaunchFenceKind,
  type LaunchIdentityAttrs,
  type LaunchReadinessTransitionState,
  type LaunchActivationTransitionState,
} from "./launchPhaseTransition";
import { AgentVisibleDeliveryLedger, formatAgentMessageVisibleTarget, isThreadVisibleTarget, type AgentVisibleFreshnessView } from "./agentVisibleDeliveryLedger";
import {
  RUNTIME_PROFILE_DAEMON_NOTICE_MESSAGE_PREFIX,
  composeAxSurfaces,
  formatAppInboxNoticeSuffix,
  formatConcreteMessagesRuntimeInput,
  formatInboxUpdateRuntimeInput,
  inboxUpdateRenderOptions,
  formatRuntimeProfileControlPrompt,
  formatServerContextPrefix,
  formatSubagentsFinishedRuntimeInput,
  formatUnreadSummaryAddendum,
  formatUnreadSummaryRows,
  renderedUnreadSummaryTargets,
  threadJoinContextReceipts,
  inboxProjectionTraceAttrs,
  isServerContextMessage,
  projectThreadJoinContextsForRuntimeInput,
  runtimeProfileNotificationFromMessage,
  type AxSurfaceText,
  type RuntimeProfileControlKind,
} from "./agentRuntimeInput";
import { deriveForegroundTurnOrigin } from "./foregroundTurnOrigin";
import { planStartupInput } from "./startupInput";
import type { RuntimeTurnOrigin } from "./runtimeTurnOrigin";
import {
  buildBoundedVisibleCrashDetail,
  buildBoundedVisibleCrashProjection,
  buildClaudeStartupCrashRuntimeError,
  buildClaudeStartupCrashActivity,
} from "./claudeStartupCrashDiagnostic";
import {
  runtimeDisplayName,
  buildRuntimeErrorActivityDiagnostic,
  buildRuntimeErrorDiagnosticEnvelope,
  runtimeErrorTraceClassAttrs,
  providerErrorCodeClass,
  formatRuntimeInputTooLargeMessage,
  formatRuntimeResetSessionGuidance,
  formatRuntimeLoginRequiredMessage,
  formatRuntimeStartTimeoutMessage,
  isRuntimeInputTooLargeErrorText,
  formatRuntimeBillingExhaustedMessage,
  formatRuntimePlanAccessMessage,
  formatCredentialInvalidHeldNotice,
  isRuntimePlanAccessErrorText,
  credentialInvalidReasonOf,
  credentialProblemCodeOf,
  CREDENTIAL_PROBLEM_MESSAGES,
} from "./runtimeErrorDiagnostics";
import { isCodexToolArgumentParseErrorChunk } from "./codexToolArgumentParseSignature";
import { materializeProviderConnectionForSpawn } from "./providerConnectionLaunch";
import { applyStartupMemoryBlock, buildStartupMemoryBlock, resolveStartupMemoryBlockConfig } from "./startupMemoryBlock";
import { chooseSession, RESUME_FAILURE_THRESHOLD, type KnownResumeError } from "./chooseSession";
import { reportedStickyFailureReason, type SessionResetCause } from "./stickyFailureRecords";
import { crashStreakBackoffMs, crashStreakExhausted, formatCrashStreakExhaustedMessage, formatZeroEvidenceStreakMessage, planExit, type ExitFacts, type ExitPlan, type ExitStreaks, type RecoverableExitError } from "./planExit";
import {
  COLD_IDLE_RUNTIME_VERSION_FLOORS,
  COLD_IDLE_SWEEP_MS,
  applyWakeRecycleBriefing,
  coldIdleGate,
  decideColdIdle,
  describeAppliedWakeRecycle,
  describeRecycledWakeLogLine,
  planWakeSessionRecycle,
  recycleThresholdTraceAttrs,
  readRuntimeSessionResumeFacts,
  type ColdIdleSkipReason,
  type ColdIdleVerdict,
  type SessionResumeFacts,
  runtimeVersionAllowsColdIdle,
  wakeRecycleKindTraceAttrs,
} from "./wakeSessionRecycle";
import {
  WARM_RECYCLE_CANCELLED_EVENT,
  WARM_RECYCLE_MARKED_EVENT,
  WARM_RECYCLE_STOPPED_EVENT,
  WarmRecycleMarks,
  decideWarmRecycleMark,
  describeWarmRecycleCancelled,
  describeWarmRecycleMarked,
  describeWarmRecycleStopped,
  resolveWarmRecycleConfig,
  warmRecycleCoversRuntime,
  warmRecycleSenderKind,
  type WarmRecycleCancelReason,
  type WarmRecycleMark,
  type WarmRecycleSenderKind,
} from "./wakeRecycleWarm";
import { RuntimeProgressState } from "./runtimeProgressState";
import {
  DeliveryConsumptionWatch,
  QUEUED_INPUT_SETTLE_MS,
  isDeliveryConsumptionEvent,
  type DeliveryConsumptionSnapshot,
  type DeliveryWritePath,
} from "./deliveryConsumptionWatch";
import { computeInboxNoticeFingerprint, RuntimeNotificationState } from "./runtimeNotificationState";
import {
  clearSessionReadyDeliveryRetry,
  createSessionReadyDeliveryRetryState,
  flushIdleInboxDeliveryRetry as flushIdleInboxDeliveryRetryDebt,
  flushSessionReadyDeliveryRetry as flushSessionReadyDeliveryRetryDebt,
  prepareSessionInitDeliveryDebtRetry,
  queueAgentInboxMessage,
  scheduleSessionReadyDeliveryRetry as scheduleSessionReadyDeliveryRetryDebt,
  type SessionReadyDeliveryRetryFlushSource,
  type SessionReadyDeliveryRetryState,
} from "./agentInboxDeliveryDebt";
import { RuntimeBusyDeliveryCoordinator } from "./runtimeBusyDeliveryCoordinator";
import { runtimeDiagnosticTrajectoryEntry } from "./runtimeDiagnosticEntry";
import {
  runtimeDiagnosticTraceAttrs,
  runtimeRecoveryTraceAttrs,
  runtimeTurnEventTraceAttrs, normalizeAgentProcessErrorClass,
  type RuntimeDiagnosticEvent,
  type RuntimeRecoveryEvent,
} from "./runtimeEventTrace";
import {
  formatRuntimeErrorFingerprintFenceDetail,
  isProviderStreamFailureText,
  isRuntimeUsageLimitText,
  providerLimitBackoffDelayMs,
  QUOTA_RESET_BACKOFF_MAX_MS,
  RUNTIME_ERROR_DELIVERY_BACKOFF_BASE_MS,
  RUNTIME_ERROR_DELIVERY_BACKOFF_MAX_MS,
  runtimeErrorDeliveryBackoffDelayMs,
  recoverableRuntimeDeliveryBackoffReason,
  recoverableRuntimeProcessCloseReason,
  runtimeErrorFingerprintFenceResetEvent,
  runtimeErrorProviderLimit,
  type RuntimeErrorProviderLimit,
} from "./runtimeErrorDeliveryPolicy";
import { DecisionErrorWindow, pushRecentStderr, pushRecentStdout } from "./runtimeOutputWindow";
import { RuntimeProcessBindingFence } from "./runtimeProcessBindingFence";
import { ServerContextLedger } from "./serverContextLedger";
import type { ServerContext, ServerContextReach } from "./serverContextLedger";
import type { AgentAppInboxNoticeOptions, AgentAppInboxStore } from "./agentAppInbox";
import type { AgentIdleNoticeDelivery, AgentIdleNoticeFacts, HostedAgentSession } from "./agentHost/agentLifecycleHost";
import { AGENT_DRAIN_MAX_DEADLINE_MS, AgentDrains, type AgentDrainNotQuiet, type AgentDrainNotRunnable, type AgentDrainOptions, type AgentDrainProgress, type AgentDrainSummary } from "./agentDrain";
import {
  agentNotIdleReason,
  agentStopWaitReason,
  type AgentIdleFacts,
  type AgentIdleOptions,
  type AgentNotIdleReason,
  type AgentRunnableFacts,
  type AgentStopWait,
} from "./agentIdle";
import { AgentIdleHoldTracker, type IdleHoldGate } from "./agentIdleHold";
import { backgroundTaskForSubagentRow, defaultRuntimeDescendantReader, readDescendantEvidence, shouldTraceKeptCandidate, silentBackgroundTasks, silentTaskVerdict, type BackgroundTaskHealthRecord, type RuntimeDescendantReader } from "./backgroundTaskHealth";
import { enforceRuntimeLaunchVersion } from "./runtimeLaunchVersion";
import {
  addTurnSpanEvent,
  codexCommunicationGapAttrs,
  createRuntimeTraceCounters,
  noteRaftMessageSendAttempt,
  noteRaftMessageSendOutcome,
  noteRuntimeTraceCounter,
  runtimeToolingObservationAttrs,
  runtimeTraceCounterAttrs,
  type RuntimeTraceCounters,
} from "./runtimeCommunicationTrace";
import { activityTurnTokensFrom, noteTurnTokenUsage } from "./runtimeTurnTokens";
import { claudeCompactCommandOverridden, createLegacyTurnEndCompactionState, legacyTurnEndCompactionPreconditionFailure, noteLegacyTurnEndContext, type LegacyTurnEndCompactionState } from "./turnEndCompactionLegacy";
import { TURN_END_COMPACTION_EVENT, TURN_END_COMPACTION_LEGACY_RUNTIMES, turnEndCompactionLogLine, decideTurnEndCompaction, resolveTurnEndCompactionConfig, turnEndCompactionTraceAttrs, type TurnEndCompactionDriverOutcome, type TurnEndContextFacts } from "./turnEndCompaction";
import { hashRuntimeProfileKey, messagesTraceAttrs, type RuntimeTurnTraceOutcome } from "./runtimeTurnTrace";
import { resolveRaftHome, resolveRaftHomePath } from "./raftHome";
import {
  applyFreshSessionStandingPrompt,
  applyStandingPromptUpdate,
  planStandingPromptRefresh,
  stableStandingPromptConfig,
  standingPromptGoesInFirstInput,
  standingPromptHash,
  standingPromptRecordForReportedSession,
  standingPromptSessionBinding,
  StandingPromptLedger,
  type StandingPromptSessionBinding,
} from "./standingPromptRefresh";
import { changedAgentServerFeatureKeys, formatServerFeaturesNotice, serverFeaturesDrift } from "./serverFeaturesRefresh";
import { AgentConfigRevisions } from "./agentConfigRevisions";
import { SpecHandbacks } from "./specHandbacks";
import { ambientProcessEnv } from "./processEnvPatch";
import { credentialAccountCheck, createCredentialAccountReader, type CredentialAccount, type CredentialAccountCheck, type CredentialAccountReader } from "./credentialSource";
import { runtimeHostSessionDrop, runtimeSpecDrift, runtimeSpecOf, sessionDropReason, sessionDropReasonText, SessionSpecMemory, specChangeNeedsServerStart, type RuntimeSpecDriftKind, type SessionDropReason, type RuntimeSpecReconcileTrigger, type RuntimeSpecSnapshot } from "./runtimeSpec";
import { STALLED_REPLACEMENT_MAX_STREAK, STALLED_WITH_WORK_THRESHOLDS, type StalledReplacementStreaks, type StalledWithWorkDeliveryHold } from "./stalledWithWork";
import { SessionCompactionFailureLedger, SESSION_NEEDS_RESET_THRESHOLD } from "./sessionCompactionFailureLedger";
import {
  createTurnOutcomeCounters,
  noteTurnOutcomeEvent,
  terminalFailureFromRawText,
  terminalFailureFromRuntimeErrorEvent,
  turnCompletedOutcome,
  type TerminalRuntimeFailureEvidence,
  type TurnOutcomeCounters,
} from "./runtimeOutcome";
import { hasConfiguredCodexHome, resolveCodexHomeRootFromEnv } from "./drivers/codexHome";
import { isClaudeCustomProviderConfig } from "./drivers/claudeProviderIsolation";
import type { RuntimeAuthCredentialsChange } from "./runtimeAuth/runtimeAuthHost";
import { thirdPartyEventIdsFromEvents } from "./thirdPartyEventDeliveryReporter";
import { hasStableLocalMessageId, reportThirdPartyEventsDelivered, type AgentProxyFreshnessDecision, type AgentProxyInboxCoordinator, type AgentProxyVisibleMessage } from "./agentCredentialProxy";
import { buildAgentProxyInboxCoordinator } from "./agentProxyInboxCoordinator";
import { cleanupLaunchProxies } from "./launchProxyCleanup";
import { projectAgentInboxSnapshot, projectAgentInboxWholePreviewMessages, type AgentInboxTargetRow } from "./agentInboxProjection";
import { runtimeTelemetryVersionAttrs, sanitizeRuntimeTelemetryPayloadAttrs } from "./runtimeTelemetrySanitization";
import { ProviderQuotaState } from "./providerQuotaState";
import { bucketBytes, summarizeMessageInputBytes } from "./runtimeInputByteMetrics";
import { appInboxTurnTriggerAttrs, messageTurnTriggerAttrs } from "./turnTriggerTrace";
import {
  commitApmGatedSteeringDecisionState,
  createInitialApmGatedSteeringState,
  projectApmHeldFreshnessActivity,
  reduceApmGatedCompaction,
  reduceApmGatedCompactionBoundaryFlush,
  reduceApmGatedError,
  reduceApmGatedReview,
  reduceApmGatedReviewBoundaryFlush,
  reduceApmGatedTurnEnd,
  reduceApmToolUse,
  reduceApmIdleState,
  reduceApmColdIdleRecycleTermination,
  reduceApmStalledRecoveryTermination,
  classifyOpenToolRecovery,
  reduceApmStartupRequestErrorTermination,
  reduceApmStartupTimeoutTermination,
  projectApmRuntimeProgressStalledTrace, projectRuntimeToolDiagnosticActivity,
  projectApmRuntimeStallDiagnostic,
  projectApmRuntimeTerminationTrace,
  type ApmExpectedTerminationReason,
  type ApmGatedFlushReason,
  type ApmGatedSteeringEffect,
  type ApmGatedSteeringDecisionState,
} from "./apmStateMachine";

export { DecisionErrorWindow } from "./runtimeOutputWindow";

const DEFAULT_MAX_CONCURRENT_AGENT_STARTS = 5;
const DEFAULT_AGENT_START_INTERVAL_MS = 500;
const RUNNER_CREDENTIAL_MINT_MAX_ATTEMPTS = 3;

interface SenderElisionResult {
  messages: AgentMessage[];
  /** Call once with whether the stdin write succeeded. */
  settle: (delivered: boolean) => void;
}

function NO_SENDER_ELISION(messages: AgentMessage[]): SenderElisionResult {
  return { messages, settle: () => {} };
}

function assertNeverApmEffect(effect: never): never {
  throw new Error(`Unhandled APM gated steering effect: ${String(effect)}`);
}

const MODEL_WORK_EVENT_KINDS: ReadonlySet<ParsedEvent["kind"]> = new Set<ParsedEvent["kind"]>([
  "thinking",
  "text",
  "tool_call",
  "tool_output",
]);

function isModelWorkEvent(kind: ParsedEvent["kind"]): boolean {
  return MODEL_WORK_EVENT_KINDS.has(kind);
}

function runtimeSendFailureOutcome(result: RuntimeSendResult): "encode_failed" | "send_failed" {
  return !result.ok && result.reason === "unsupported" ? "encode_failed" : "send_failed";
}

const RUNNER_CREDENTIAL_MINT_RETRY_DELAY_MS = 250;
function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

function readNonNegativeIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

/**
 * task #1120: the manager's start failure wrapper. Carries the driver's typed
 * launch error as `cause` and mirrors its spawn-failure code so
 * `classifySpawnFailure` still decides by code after the message was rewritten.
 */
/**
 * task #365: the launch about to be spawned was claimed by the server against
 * another connection than the current one; no process was created for it.
 */
export class StaleDispatchError extends Error {
  constructor(agentId: string, readonly launchId: string) {
    super(`Runtime not started for ${agentId}: launch ${launchId} was claimed against an earlier connection`);
    this.name = "StaleDispatchError";
  }
}

/** RFC 071 outbox: the open-launch record could not be written, so the runtime process was not spawned. */
export class RuntimeOutcomeStorageBlockedError extends Error {
  constructor(agentId: string) {
    super(`Runtime not started for ${agentId}: runtime outcome storage failed (open-launch record not written)`);
    this.name = "RuntimeOutcomeStorageBlockedError";
  }
}

/** RFC 060: the agents another host runs, as the transcript and runtime-profile reads need them. */
export interface HostedAgentSessions {
  get(agentId: string): HostedAgentSession | null;
  agentIds(): string[];
}

/** RFC 071 outbox: "persist the open record, then spawn / rebind" (see runtimeOutcomeOutbox.ts). */
export interface RuntimeProcessGate {
  /** `spawnLaunchId` null: an internal start without a server launch (keyed by `processInstanceId`). */
  openProcess(agentId: string, processInstanceId: string, spawnLaunchId: string | null): boolean;
  /** The exit of a process started without a server launch and never rebound to one (it has no `process_exited` frame). */
  processExitedLocally(agentId: string, processInstanceId: string): void;
  /** A spawn that failed before its process was reported spawned: no runtime runs and no process frame will name it. */
  processNotStarted(agentId: string, processInstanceId: string): void;
  /**
   * Checked at the entry of the spawn and the rebind every start goes
   * through: the shown reason this agent may not be started or reused now
   * (the automatic-start rule: its runtime outcome evidence is known
   * incomplete), or null. `recoveryGrant` is the grant of the admitted human
   * start that `launchId` is, passed only for that start; it is spent by
   * this call. Every other start (crash respawn, cold start, rebind, ...)
   * passes null and is decided as automatic.
   */
  startRefusal(agentId: string, launchId: string | null, recoveryGrant: RecoveryGrant | null): StartRefusalDecision | null;
  /**
   * Wait for the current server connection's runtime-outcome capability. A
   * start that would create a process waits for it (held, not refused: its
   * messages stay buffered as for any starting agent). Cancellable: a stop
   * of the agent cancels that start's wait; the daemon stopping cancels all.
   */
  waitForCapability(): CapabilityWait;
}

/** The typed "executable not resolvable" failure with a known reason, anywhere in the cause chain. */
function launchUnresolvedCause(error: unknown): (RuntimeExecutableNotFoundError & { reason: string }) | null {
  for (let current = error, depth = 0; current && depth < 5; current = (current as { cause?: unknown }).cause, depth += 1) {
    if (current instanceof RuntimeExecutableNotFoundError && current.reason) {
      return current as RuntimeExecutableNotFoundError & { reason: string };
    }
  }
  return null;
}

export class RuntimeSessionStartError extends Error {
  readonly spawnFailureCode: SpawnFailureReason | null;

  constructor(message: string, cause: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RuntimeSessionStartError";
    this.spawnFailureCode = spawnFailureCodeOf(cause);
  }
}

/**
 * task #365: the runtime's child was proven never created: it has no pid and
 * the spawn syscall itself failed (EACCES, ENOENT, ...). Settled `not_spawned`
 * with reason `spawn_error` for a server that counts it
 * (`SERVER_CAPABILITY_START_SPAWN_ERROR_V1`). Says nothing about whether the
 * cause is temporary.
 */
export class RuntimeSpawnNoProcessError extends Error {
  constructor(message: string, readonly syscall: string | null) {
    super(message);
    this.name = "RuntimeSpawnNoProcessError";
  }
}

/** task #365: how long a start without a pid waits for its spawn error before its outcome is unknown. */
export const SPAWN_EVIDENCE_WAIT_MS = 5_000;

function isSpawnSyscall(syscall: string | null): boolean {
  return typeof syscall === "string" && /^spawn(\s|$)/.test(syscall);
}

export class RunnerCredentialMintError extends Error {
  /** task #1120: stable launch-failure class; `code` below is the mint-specific code. */
  readonly spawnFailureCode = "runner_credential_mint_failed" as const;
  readonly code: string;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, opts: { code: string; retryable?: boolean; status?: number }) {
    super(message);
    this.name = "RunnerCredentialMintError";
    this.code = opts.code;
    this.retryable = opts.retryable ?? false;
    this.status = opts.status;
  }
}

function isRetryableMintHttpFailure(status: number, code: string | null): boolean {
  if (code === "experimental_surface_disabled") return false;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function runnerCredentialErrorDetail(error: unknown): { message: string; code: string; retryable: boolean; status?: number } {
  if (error instanceof RunnerCredentialMintError) {
    return {
      message: error.message,
      code: error.code,
      retryable: error.retryable,
      status: error.status,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    message,
    code: "runner_credential_mint_network_error",
    retryable: true,
  };
}

async function waitForRunnerCredentialRetry(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, RUNNER_CREDENTIAL_MINT_RETRY_DELAY_MS));
}

function probeSubprocessOsState(pid: number | undefined): string {
  if (typeof pid !== "number") return "unknown";
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = status.match(/^State:\s+(\S)/m);
    if (match) {
      const code = match[1];
      if (code === "R") return "running";
      if (code === "S") return "sleeping";
      if (code === "D") return "uninterruptible_sleep";
      if (code === "Z") return "zombie";
      if (code === "T" || code === "t") return "stopped";
    }
    return "unknown";
  } catch {
    return "gone";
  }
}

/**
 * Task #1310: whether a model call was still open when a stall fired, and how
 * far the oldest one had got. Empty for runtimes that do not observe calls.
 */
function providerCallStallAttrs(ap: AgentProcess): Record<string, string | number> {
  let snapshot: RuntimeProviderCallSnapshot | undefined;
  try {
    snapshot = ap.runtime.providerCallSnapshot?.();
  } catch {
    return {};
  }
  if (!snapshot) return {};
  const { oldest } = snapshot;
  return {
    provider_calls_open: snapshot.openCount,
    ...(oldest ? {
      provider_call_phase: oldest.phase,
      provider_call_context: oldest.callContext,
      provider_call_age_ms_bucket: bucketMs(oldest.ageMs),
      ...(oldest.msSinceLastStreamEvent === undefined
        ? {}
        : { provider_call_ms_since_last_stream_event_bucket: bucketMs(oldest.msSinceLastStreamEvent) }),
    } : {}),
  };
}

function bucketMs(ms: number): string {
  if (ms < 1_000) return "<1s";
  if (ms < 10_000) return "1-10s";
  if (ms < 60_000) return "10-60s";
  if (ms < 300_000) return "1-5m";
  if (ms < 900_000) return "5-15m";
  if (ms < 3_600_000) return "15-60m";
  return ">60m";
}

/** task #25 step 2: how long a native interrupt has to end the turn before the runtime is restarted instead. */
const NATIVE_TURN_INTERRUPT_TIMEOUT_MS = 10_000;

export interface AgentTurnInterruptResult {
  outcome: AgentTurnInterruptOutcome;
  /** The tool call the turn was on, when one was open. */
  toolName?: string;
  /** How long that call had gone without output, when it was reported stuck. */
  stuckForMs?: number;
}

/** task #25: quiet time on one tool call before it is reported as stuck; 0 turns the report off. */
function toolStuckThresholdMs(): number {
  return readNonNegativeIntegerEnv("SLOCK_DAEMON_TOOL_STUCK_MS", DEFAULT_TOOL_STUCK_THRESHOLD_MS);
}

/**
 * The start timeout for one runtime: the env value when set, else the
 * runtime's own default. Some runtimes' first event only comes once the model
 * starts streaming, so their start includes the model's first token, and a
 * slow model or proxy (109 s seen, #proj-runtime:#52) is not a failed start:
 * OpenCode (`step_start`, every turn), Grok (its session and progress events
 * do not count, first start only) and Antigravity (its first model line).
 */
export function runtimeStartTimeoutMs(runtime: string): number {
  return readNonNegativeIntegerEnv(
    "SLOCK_DAEMON_RUNTIME_START_TIMEOUT_MS",
    RUNTIME_START_TIMEOUT_DEFAULT_MS[runtime] ?? DEFAULT_RUNTIME_START_TIMEOUT_MS,
  );
}

const SESSION_TRANSCRIPT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * One feedback/diagnostic transcript lookup. `transcriptContent` is decided
 * HERE, where the bytes are produced: only native_* results ever carry
 * `transcript` bytes; a daemon placeholder never does.
 */
export interface SessionTranscriptLookup {
  runtime: string;
  sessionId: string;
  reachable: boolean;
  path: string | null;
  /** Legacy free text for older servers; `reasonCode` is the typed form. */
  fallbackReason?: string;
  transcript: string | null;
  sizeBytes: number;
  truncated: boolean;
  truncationDirection?: "head" | "tail" | "window";
  redacted: boolean;
  tier: string;
  transcriptContent: FeedbackTranscriptContentKind;
  reasonCode?: FeedbackTranscriptLookupReason;
  lookupMethod: FeedbackTranscriptLookupMethod | null;
  /** LOCAL diagnostic only (home folded to `~`, bounded); never in the feedback frame or outcome. */
  searchedPaths: string[];
  /** Only for no_config_in_memory: whether `<dataDir>/<agentId>` exists locally. */
  workspaceDirPresent?: boolean;
  /** Size of the source file at read time (when one was read); a compressed file's decompressed size. */
  sourceBytes?: number;
  /** Uncompressed bytes kept (after windowing/redaction); == sizeBytes. */
  transcriptBytes: number;
}

/**
 * Bounds of the searched paths kept in the LOCAL session-transcript lookup
 * diagnostic. Local only: neither the feedback result frame nor the uploaded
 * transcript_outcome carries them.
 */
const TRANSCRIPT_LOOKUP_SEARCHED_PATHS_MAX = 4;
const TRANSCRIPT_LOOKUP_SEARCHED_PATH_MAX_CHARS = 160;

function runtimeTier(runtime: string): string {
  const tier1 = new Set(["claude", "codex", "grok", "kimi-sdk", "kimi", "pi"]);
  if (tier1.has(runtime)) return "tier1";
  return "tier2_or_fallback";
}

export { resolveRuntimeSessionRef };
export type { ResolveRuntimeSessionRefOptions };
export { classifySpawnFailure } from "./spawnFailureClassification";
import { classifySpawnFailure, startFailureActivity, startTimeoutClassification, type SpawnFailureClassification, type StartFailureActivity } from "./spawnFailureClassification";
import { RuntimeExecutableNotFoundError, RuntimeSessionNeedsResetError, spawnFailureCodeOf, type SpawnFailureReason } from "./spawnFailureErrors";
import { agentEnvVarsRefusal } from "./agentEnvVarPolicy";
export type { SpawnFailureClassification, SpawnFailureReason } from "./spawnFailureClassification";

/** Max chars for thinking/text content in trajectory entries (sent over WebSocket) */
const MAX_TRAJECTORY_TEXT = 2000;
const TRAJECTORY_COALESCE_MS = 350;

/** Interval (ms) at which the daemon re-sends the current activity to prevent server-side stale timeout */
const ACTIVITY_HEARTBEAT_MS = 60_000;
const STDIN_NOTIFICATION_INITIAL_DELAY_MS = 3_000;
/** A busy agent with no runtime progress for this long is treated as idle for
 * App Inbox notices (a missed turn-end event must not block them for hours). */
const APP_INBOX_BUSY_STALE_MS = 10 * 60_000;
/** How long an idle write may go without the runtime reporting a turn. */
const TURN_START_OBSERVATION_MS = 30_000;
const STDIN_NOTIFICATION_RETRY_DELAY_MS = 15_000;
const SESSION_READY_DELIVERY_RETRY_DELAY_MS = 15_000;
const RUNTIME_ERROR_FINGERPRINT_FENCE_THRESHOLD = 3;
/**
 * Task #1315: consecutive NotFoundError/404 runtime errors, whatever their
 * fingerprint, before the runtime is stopped. An engineering margin over the
 * same-fingerprint fence's 3, not a threshold proven safe by data.
 */
const RUNTIME_ERROR_CLASS_FENCE_THRESHOLD = 5;
/** A failed start the owner should keep seeing until the agent starts or is stopped. */
interface LastStartFailure extends StartFailureActivity {
  launchId: string | null;
}

/** RFC 071: accepted launches waiting for a final result, per agent (candidate bound). */
const ACCEPTED_LAUNCHES_PER_AGENT_MAX = 32;

// SPAWN-FAIL BACKOFF (界③ narrow): when auto_restart_from_idle / runtime_profile_auto_restart
// fail (startAgent throws — e.g. credential mint failure, runtime spawn error), the current
// behavior restores idleAgentConfigs and returns false; the NEXT message arrival walks the
// same path and triggers another failing startAgent. This is the per-agent token-burn-on-
// spawn-failure loop tygg's deep-think surfaced (#proj-o11y:9bf7d748): repeated spawn cost
// without backoff. Apply a per-agent cooldown after the first outer spawn failure (matches
// the runtime-error-delivery backoff pattern but anchored at spawn-fail) so a broken spawn
// path cannot burn one full spawn attempt per wake message.
const SPAWN_FAIL_BACKOFF_BASE_MS = 1_000;
const SPAWN_FAIL_BACKOFF_MAX_MS = 30_000;
const SPAWN_FAIL_BACKOFF_THRESHOLD = 0;
// After CRASH_STREAK_CAP daemon-local restart failures in a row (about 30s of
// backoff at 1s, 2s, 4s, 8s, 16s) the daemon stops restarting the agent by
// itself and hands it to the Server, whose wake breaker pauses it after as
// many failed starts and tells the owner. Typed configuration failures stop
// at once. Reconciler step 10a: the same cap and backoff function as the
// crash cap (planExit.ts, D5/D12).
// Runner credential mint has its own inner retry loop. Once that loop is
// exhausted, do not require three more wake cycles before suppressing retry.
const RUNNER_CREDENTIAL_MINT_BACKOFF_BASE_MS = 60_000;
const RUNNER_CREDENTIAL_MINT_BACKOFF_MAX_MS = 10 * 60_000;
const RUNNER_CREDENTIAL_MINT_BACKOFF_THRESHOLD = 0;
/** Compaction should normally finish quickly; surface missing finish events explicitly. */
const COMPACTION_STALE_MS = 5 * 60_000;
/** Review mode should normally finish within a turn; surface missing finish events explicitly. */
const REVIEW_STALE_MS = 10 * 60_000;
/**
 * Surface silent runtime stalls instead of letting activity heartbeats mask
 * them indefinitely; the same threshold makes a turn with queued work
 * stalled (stalledWithWork.ts, which also has the non-stdin one).
 */
const RUNTIME_PROGRESS_STALE_MS = STALLED_WITH_WORK_THRESHOLDS.stallMs;
/** Startup should either emit a runtime event or fail visibly; do not leave users on Starting forever. */
const DEFAULT_RUNTIME_START_TIMEOUT_MS = 2 * 60_000;
const MODEL_FIRST_TOKEN_START_TIMEOUT_MS = 10 * 60_000;
const RUNTIME_START_TIMEOUT_DEFAULT_MS: Readonly<Record<string, number>> = {
  opencode: MODEL_FIRST_TOKEN_START_TIMEOUT_MS,
  grok: MODEL_FIRST_TOKEN_START_TIMEOUT_MS,
  antigravity: MODEL_FIRST_TOKEN_START_TIMEOUT_MS,
};
/**
 * Reconciler step 5: which stop a runtime's stop was, for its traces
 * (`daemon.agent.stop.escalated`, `daemon.agent.stop.kill_unconfirmed`).
 * Every one of them is SIGTERM, then after AGENT_STOP_KILL_GRACE_MS a SIGKILL
 * of the process tree (RuntimeSession.stop).
 */
type AgentStopPath =
  | "explicit_stop"
  | "silent_stop"
  | "cold_idle_recycle"
  | "spec_restart"
  | "warm_recycle"
  | "terminal_runtime_error"
  | "stalled_recovery"
  | "startup_timeout"
  | "startup_request_error"
  | "turn_end"
  | "turn_interrupt"
  | "cancelled_start"
  | "stopped_start";
type AgentProcessTimer = ReturnType<typeof setTimeout>;

export type AgentProcessStartupContext = {
  wakeMessage: AgentMessage | undefined;
  unreadSummary: Record<string, number> | undefined;
  resumePrompt: string | undefined;
};

export type AgentProcessStartupState =
  | (AgentProcessStartupContext & { kind: "waiting"; timer: AgentProcessTimer | null })
  | (AgentProcessStartupContext & { kind: "ready" });

export type AgentProcessActivationState =
  | { kind: "idle" }
  | { kind: "open"; transition: LaunchActivationTransitionState }
  | { kind: "delivered" }
  | { kind: "closed" };

export type AgentProcessCompactionState =
  | { kind: "none" }
  | {
    kind: "active";
    startedAt: number;
    watchdog: AgentProcessTimer | null;
    /** The producer's id for this cycle (ParsedEvent `cycleId`), when it pairs start and end. */
    cycleId?: number;
    /**
     * Set when this compaction cycle began on an idle agent (no open turn) of
     * this runtime. Only a finish or interruption carrying this cycle's id
     * hands the agent back to idle. Turn output (text, thinking, a tool call)
     * during the cycle already ends it through completeCompactionIfActive.
     */
    startedIdleOn?: RuntimeSession;
  };

export type AgentProcessReviewState =
  | { kind: "none" }
  | { kind: "active"; startedAt: number; watchdog: AgentProcessTimer | null };

export type AgentProcessExitState =
  | { kind: "live" }
  | { kind: "exited"; code: number | null; signal: NodeJS.Signals | null };

export type PendingTrajectoryState = {
  kind: "thinking" | "text";
  text: string;
  timer: AgentProcessTimer;
  // APM 1.6 6b: closed subagent lineage for coalesced thinking/text rows. Only
  // present when the source row carried explicit lineage; never inferred.
  subagent?: SubagentLineage["subagent"];
};

function createAgentProcessStartupState(context: AgentProcessStartupContext): AgentProcessStartupState {
  return { kind: "waiting", timer: null, ...context };
}

function agentProcessStartupContext(startup: AgentProcessStartupState): AgentProcessStartupContext {
  return {
    wakeMessage: startup.wakeMessage,
    unreadSummary: startup.unreadSummary,
    resumePrompt: startup.resumePrompt,
  };
}

function agentProcessStartupReady(startup: AgentProcessStartupState): AgentProcessStartupState {
  return { kind: "ready", ...agentProcessStartupContext(startup) };
}

interface AgentProcess {
  /** The runtime CLI's version for this process, when known (`runtime_cli_version` on its turn spans). */
  runtimeCliVersion: string | null;
  /** Start time (ms) of each open tool call by the runtime's call id (toolCallOutcome.ts). */
  toolCallStarts?: Map<string, number>;
  /** Open tool calls by name and start, for the stuck-tool report (toolStuckWatch.ts). */
  toolStuck?: ToolStuckWatch;
  /** task #25 step 2: resolved by the next turn end, for a native interrupt to confirm it worked. */
  turnEndWaiters?: Set<(interrupted: boolean) => void>;
  /**
   * task #1277 — cancels this start attempt's probes and spawn. Aborted by
   * `stopAgent` and by the stop-epoch fence; bound to the attempt, never to
   * the connection, so a brief disconnect does not cancel a start.
   */
  launchAbort?: AbortController;
  providerRequest?: import("@botiverse/raft-shared").ProviderRequestActivity;
  /**
   * task #1357 item 1: the limits report of this process's live Pi session,
   * as first sent. Sent again, unchanged, after a reconnect (a frame lost while
   * disconnected); goes with the process.
   */
  modelLimitsReport?: Omit<import("@botiverse/raft-shared").AgentModelLimitsFrame, "launchId">;
  /**
   * task #13: the stable standing prompt this launch runs on, recorded per
   * session at session_init: its ledger hash, and which reported sessions it
   * actually reached (the others are recorded as not current).
   */
  standingPrompt?: { hash: string; binding: StandingPromptSessionBinding };
  /**
   * The runtime session this process was started to resume (null: a new
   * session, including a wake recycle). The idle task reminder treats the
   * session the runtime runs as new unless it is this one.
   */
  resumeSessionId?: string | null;
  /**
   * The agent's own model output (text, thinking, tool use; not a subagent's,
   * not an empty turn-start marker) was seen from this process. A resumed
   * launch that crashes without it counts toward the fresh-session fallback.
   */
  modelOutputObserved?: boolean;
  /** Any event was parsed from this process's output, an empty thinking marker included. */
  runtimeEventObserved?: boolean;
  runtime: RuntimeSession;
  driver: RuntimeDriver;
  inbox: AgentMessage[];
  config: AgentConfig;
  sessionId: string | null;
  sessionReadyForDelivery: boolean;
  launchId: string | null;
  startDispatchId: string | null;
  startup: AgentProcessStartupState;
  notifications: RuntimeNotificationState;
  /** Timer that periodically re-sends transient activity (working/thinking) to prevent server stale timeout */
  activityHeartbeat: ActivityHeartbeatTimerState;
  /**
   * Reconciler step 9: decides the process again at the moment its queued
   * work would cross the stall threshold (armStallDeadline). One timer per
   * process; it decides nothing itself.
   */
  stallDeadlineTimer?: ReturnType<typeof setTimeout>;
  /**
   * Task #1302: runtime ids of the tool calls counted in
   * gatedSteering.outstandingToolUses, so stalled recovery can match each tool
   * snapshot to one open call. Cleared whenever that count returns to zero.
   */
  openToolCallIds?: Set<string>;
  /**
   * Open phase-5 runtime-readiness exported-row transition (task #149). Set on
   * fence arm, cleared when the readiness wait closes (advanced / timeout /
   * terminal). Non-null = the readiness wait row is open and awaiting its
   * exactly-one close.
   */
  readinessTransition: LaunchReadinessTransitionState | null;
  activation: AgentProcessActivationState;
  compaction: AgentProcessCompactionState;
  /**
   * task #1362: a compaction the runtime started after its run ended and before
   * its turn end (`compaction_started.afterRunEnd`). New input waits behind the
   * compaction gate until both this cycle's finish or interruption and the turn
   * end have arrived, in either order; then it goes as an idle delivery. Until
   * then the session is still settling, so a busy steer would land after its
   * last look at the queue and an idle prompt would be refused mid-compaction.
   */
  compactionAfterRunEnd?: { cycleId?: number; ended: boolean; turnEnded: boolean };
  /** #proj-runtime:#54 phase 3: native compaction at a turn end past the size threshold (turnEndCompaction.ts). */
  turnEndCompaction?: LegacyTurnEndCompactionState;
  /**
   * RFC 072 §7.2: this spawn's CLI transport directory (the same path
   * `prepareCliTransport` creates and injects as SLOCK_CLI_TRANSPORT_DIR),
   * where a new context id is written at every `compaction_started`.
   */
  cliTransportDir: string;
  /**
   * The passive AX gate this process was spawned with (task #359), taken from
   * the spawn config so compaction writes publish the same value; `config` is
   * the live config and need not carry the composed gate.
   */
  passiveAx: boolean;
  /** The agent's CLI ledger (`agent-state/<id>/state.db`); undefined for an id that cannot name one. */
  agentLedgerPath?: string;
  /** Glimpse layer 2: the last turn end could not take the CLI's render counts, so the next one carries them over. */
  passiveRenderTakeFailed?: boolean;
  /**
   * RFC 072 context id of the model context this process is in now (glimpse
   * G0): planned before the spawn, replaced at every `compaction_started` and
   * when the runtime binds a different session; null when the replacement
   * could not be published. Under passive AX it scopes the daemon's freshness
   * evidence exactly as the CLI's (they read the same id).
   */
  contextId: string | null;
  review: AgentProcessReviewState;
  runtimeProgress: RuntimeProgressState;
  /** task #1114: stdin writes since the last runtime consumption signal (observation only). */
  deliveryConsumption: DeliveryConsumptionWatch;
  runtimeTraceSpan: ActiveSpan | null;
  /**
   * The trace context of the turn span that ended before its turn did (an
   * error ends the span; the runtime may report more errors until its turn
   * end). A `runtime.error` seen then joins that turn's trace instead of
   * landing with no trace id. Cleared at the turn end and when a turn opens.
   */
  endedRuntimeTurnTraceContext?: TraceContext | null;
  runtimeTraceCounters: RuntimeTraceCounters;
  /**
   * task #1260 — background tasks this process has started and not yet
   * finished (Claude `system` task_started → task_notification, keyed by
   * task_id). Owned by this process record only: a new launch starts empty, so
   * a late notification from an earlier process can never touch it. While it
   * is non-empty a turn end shows "waiting", not Idle; the main turn's
   * delivery semantics (isIdle) are untouched.
   */
  backgroundTasks: Map<string, BackgroundTaskRecord>;
  /**
   * #proj-runtime:#41 — the agent's last turn ended because it was stopped
   * (a user's Stop). A subagent finishing afterwards must not start the agent
   * again; the next turn end, of a turn someone else started, clears it.
   */
  lastTurnEndInterrupted?: boolean;
  /**
   * #proj-runtime:#41 — sub-agents a person stopped. The last of them ending
   * does not wake the agent with "your sub-agents have finished": it was
   * stopped on purpose.
   */
  userStoppedSubagents?: Set<string>;
  /**
   * A sub-agent ended on its own (not by a person's stop) while the agent's
   * turn was quiet, so its result waits for the agent. Cleared when the last
   * one ends (the wake decision) and at the agent's next turn end.
   */
  subagentResultUnread?: boolean;
  /** RFC 071 §4.4: model output and runtime errors since the previous turn end (E2 evidence). */
  turnOutcome: TurnOutcomeCounters;
  /**
   * RFC 071 §6: the catch-up batch this process's first turn rendered as
   * input (`resumeCatchupDeliveredAsInput`), echoed on that turn's clean
   * `turn_completed` only. Cleared at the first turn end whatever its
   * outcome, so a batch is echoed at most once.
   */
  catchupBatchEcho: { launchId: string; batchId: string; renderedRows: number } | null;
  /**
   * The unread-summary targets this process's start input showed with their
   * counts, reported once on the first turn end (`agent:turn:ended`).
   */
  startupUnreadShown: readonly string[];
  /** `agent:turn:ended` was sent for this process (at most once). */
  turnEndedReported: boolean;
  /** RFC 071: `agent:process_spawned` was sent for this process (at most once). */
  spawnReported: boolean;
  runtimeTelemetryResultSeq: number;
  lastActivityKind: AgentActivityKind;
  lastActivity: string;
  lastActivityDetail: string;
  lastActivityDetailKind: AgentActivityDetailKind;
  recentStdout: string[];
  recentStderr: string[];
  lastRuntimeError: string | null;
  /**
   * Reconciler step 4a: what this process shows of the invalid credential
   * holding it, its own error or the held notice (`credentialInvalidHeldNotice`).
   * Absent: nothing yet.
   */
  credentialInvalidVisibility?: CredentialInvalidVisibility | null;
  /**
   * Decision-only view of error signals, bounded by runtime liveness. Recovery /
   * RESTART classifiers read through this window so a stale error from a turn
   * the process has since moved past cannot restart a recovered agent.
   * `recentStderr` / `lastRuntimeError` stay full for diagnostics, user-facing
   * reporting, and sticky terminal-failure gating (auth / model-not-supported).
   */
  decisionErrorWindow: DecisionErrorWindow;
  runtimeErrorDeliveryBackoff: RuntimeErrorDeliveryBackoffState;
  sessionReadyDeliveryRetry: SessionReadyDeliveryRetryState;
  spawnError: string | null;
  /** task #365: `syscall` of the runtime's `error`, e.g. "spawn claude"; set only by that event. */
  spawnErrorSyscall: string | null;
  /**
   * task #365: this child was proven never created (no pid and a spawn-syscall
   * error) and its start was settled `not_spawned` / `spawn_error`. Its later
   * `exit` / `close` (Node emits `close` after a failed spawn, and the runtime
   * session synthesises an `exit` from it) must not report a process exit.
   */
  spawnNoProcess: boolean;
  processInstanceId: string;
  spawnedAtMs: number;
  exit: AgentProcessExitState;
  runtimeProfileTurnControl: RuntimeProfileTurnControl | null;
  pendingTrajectory: PendingTrajectoryState | null;
  /**
   * The told-history mark (RuntimeNotificationState.contributionMark) taken
   * when the daemon decided to stop this idle process (the cold-idle stop,
   * also used by a runtime spec restart). At its close only messages told
   * by then count as the agent's own deferral; one told to the dying process
   * after the SIGTERM still wakes the agent (isNotifiedDeferralAtColdIdleStop).
   */
  coldIdleStopToldMark?: number;
  /**
   * Reconciler step 6: the server features this process's session runs with
   * (what it spawned on; a running session never re-reads them). Its config
   * holds the ones it should run with: the two differ is the drift
   * (`reconcileSpec`). Never changes for the life of the process, except
   * on a rebind from a server that does not answer features (rebindRunningStart).
   */
  sessionServerFeatures: AgentServerFeatures;
  /**
   * Reconciler step 7: the runtime spec this process's session started with
   * (runtimeSpec.ts; hashes and a few non-secret facts, in memory only). Its
   * config, which a rebind replaces, holds the spec it should run with: the
   * two differ is the drift (`reconcileSpec`). Never changes for the life of
   * the process; the runtime profile reports from it (what is running).
   */
  startedSpec: RuntimeSpecSnapshot;
  /**
   * Reconciler step 15: the provider account this process signed in as at
   * its start (credentialSource.ts; a digest, in memory only), or null when
   * its runtime's account is not read. Compared when its invalid credential
   * is released for a credentials change (`credentialAccountCheck`).
   */
  credentialAccount: CredentialAccount | null;
  /**
   * Reconciler step 15: its credential now signs in as another account (or
   * one that cannot be read): a drift (`credential_account`), so it is
   * stopped once idle and started again on the same session.
   */
  credentialAccountChanged?: boolean;
  /** Reconciler step 6: decides the process again once input queued at its last turn end has settled (armQueuedInputSettle). */
  queuedInputSettleTimer?: ReturnType<typeof setTimeout>;
  /**
   * Seq'd messages whose bodies this daemon put in front of the model (startup
   * catch-up, wake with thread context, full-body stdin), reported as
   * `agent:model-seen` on the first model-driven event of this process after
   * the input. Dropped with the process if it ends first: the next start's
   * catch-up sends them again (a duplicate rather than a loss).
   */
  pendingModelSeen?: AgentMessage[];
  gatedSteering: ApmGatedSteeringDecisionState;
}

export type ActivityHeartbeatTimerState =
  | { kind: "inactive" }
  | { kind: "active"; timer: ReturnType<typeof setInterval> };

export type RuntimeErrorDeliveryBackoffState =
  | { kind: "idle"; attempts: 0; untilMs: 0; timer: null; reason: null }
  | { kind: "backing_off"; attempts: number; untilMs: number; timer: ReturnType<typeof setTimeout> | null; reason: string };

interface RuntimeErrorFingerprintFenceState {
  fingerprint: string;
  attempts: number;
  lastRuntimeError: string;
  /** The last error's class as its turn span carries it (`runtimeErrorTraceClassAttrs`), when known. */
  lastRuntimeErrorClass?: string;
  detail: string;
  launchId: string | null;
}

interface RuntimeErrorDeliveryFailure {
  detail: string;
  actionRequired: boolean;
  entries?: TrajectoryEntry[];
}

interface RuntimeErrorDeliveryBackoffFailPoint {
  terminalFailure?: RuntimeErrorDeliveryFailure | null;
  /** Test only. Its `kind` says which sticky failure it is; without one, `model_unsupported`. */
  stickyTerminalFailure?: (RuntimeErrorDeliveryFailure & { kind?: StickyFailureKind }) | null;
  reason?: string | null;
}

function createRuntimeErrorDeliveryBackoffState(): RuntimeErrorDeliveryBackoffState {
  return {
    kind: "idle",
    attempts: 0,
    untilMs: 0,
    timer: null,
    reason: null,
  };
}

/** The spawn-fail cooldown reason of a closed agent held for its invalid credential (`holdDeliveriesForCredentialInvalid`). */
const CREDENTIAL_INVALID_COOLDOWN_REASON = "credential_invalid";
/**
 * How long a closed agent waits for its invalid credential before its
 * buffered deliveries start it anyway (one try of the credential): the
 * longest provider-limit wait. A credentials change or a Retry ends it at once.
 */
const CREDENTIAL_INVALID_CLOSED_HOLD_MS = 60 * 60_000;

/** Revoked runner credential ids remembered so each is revoked once (oldest forgotten first). */
const REVOKED_RUNNER_CREDENTIAL_IDS_KEPT = 4096;

function stripManagedRunnerCredential(config: AgentConfig): AgentConfig {
  const { agentCredentialKey: _agentCredentialKey, agentCredentialId: _agentCredentialId, ...rest } = config;
  return rest;
}

type RuntimeProfileControlSource = "agent_config" | "message";

interface RuntimeProfileTurnControl {
  kind: RuntimeProfileControlKind;
  source: RuntimeProfileControlSource;
  keyHash: string | null;
  keyPresent: boolean;
  injectedAtMs: number;
}

function createGatedSteeringState(): ApmGatedSteeringDecisionState {
  return createInitialApmGatedSteeringState();
}

export interface AgentRuntimeProfileWireReport {
  agentId: string;
  facts: AgentRuntimeProfileReport;
  launchId: string | null;
}


function runtimeProfileNotificationTitle(kind: RuntimeProfileControlKind): string {
  return kind === "migration" ? "Runtime Profile reset" : "Runtime Profile notice";
}

function runtimeProfileTurnControl(
  kind: RuntimeProfileControlKind,
  key: string | null | undefined,
  source: RuntimeProfileControlSource,
): RuntimeProfileTurnControl {
  return {
    kind,
    source,
    keyHash: hashRuntimeProfileKey(key) ?? null,
    keyPresent: Boolean(key),
    injectedAtMs: Date.now(),
  };
}

function formatCrashReason(code: number | null, signal: NodeJS.Signals | null, ap: AgentProcess): string {
  const parts: string[] = [];

  if (signal) {
    parts.push(`signal ${signal}`);
  } else if (typeof code === "number") {
    parts.push(`exit code ${code}`);
  } else {
    parts.push("unknown exit");
  }

  if (ap.spawnError) {
    parts.push(`spawn error: ${ap.spawnError}`);
  }
  if (ap.lastRuntimeError) {
    parts.push(`runtime error: ${ap.lastRuntimeError}`);
  }
  if (ap.recentStderr.length > 0) {
    parts.push(`stderr: ${ap.recentStderr.join(" | ")}`);
  }
  if (!ap.lastRuntimeError && ap.recentStdout.length > 0) {
    parts.push(`stdout: ${ap.recentStdout.join(" | ")}`);
  }

  return parts.join(" | ");
}

function summarizeCrash(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `signal ${signal}`;
  if (typeof code === "number") return `exit code ${code}`;
  return "unknown exit";
}

/**
 * Whether a process that runs one turn ended it having got nowhere: no event at
 * all, or an error and no output (Gemini exits 0 after a blocked or empty
 * stream), and no send through the CLI. A turn that reports only `init` and
 * `result`, or only an empty thinking marker, had nothing to do (agents are told
 * not to answer system messages); that exit is clean. A long-lived process has
 * its own turn evidence (Codex's `codex_zero_evidence_turn_completed`).
 */
function perTurnProcessDidNothing(ap: AgentProcess): boolean {
  if (ap.driver.lifecycle.kind !== "per_turn") return false;
  const counters = ap.runtimeTraceCounters;
  const failedWithoutOutput = Boolean(ap.lastRuntimeError) && !ap.modelOutputObserved;
  return (!ap.runtimeEventObserved || failedWithoutOutput)
    && counters.raftMessagesSent === 0
    && counters.raftMessageSendsHeld === 0;
}

/** Reconciler step 10a: an exit's facts for `planExit`, and what acting on its plan needs besides. */
type ExitContext = {
  facts: ExitFacts;
  expectedTerminationReason: ApmExpectedTerminationReason;
  /** The sticky failure, else the terminal failure the close's text names. */
  failureDetail: RuntimeErrorDeliveryFailure | null;
  /** Reconciler step 12: the sticky failure the close's text names (one no error event reported). */
  sticky: StickyFailure | null;
  recoverableReason: RecoverableExitError | null;
  crashReason: string;
  /** Non-transient queued deliveries; the one that wakes the agent; the rest. */
  inbox: { pending: AgentMessage[]; wake: AgentMessage | undefined; buffered: AgentMessage[] };
};

type ExitActionContext = ExitContext & {
  code: number | null;
  signal: NodeJS.Signals | null;
  finalCode: number | null;
  finalSignal: NodeJS.Signals | null;
  turnBoundarySatisfied: boolean;
};

function closeSatisfiedTurnBoundary(ap: AgentProcess, expectedTermination: boolean): boolean {
  if (expectedTermination) return true;
  if (ap.runtime.descriptor.turnBoundary === "process_exit") return true;
  return !ap.runtimeTraceSpan;
}

type StartupRequestErrorEvent = Extract<ParsedEvent, { kind: "error" }> & {
  startupRequestMethod: NonNullable<Extract<ParsedEvent, { kind: "error" }>["startupRequestMethod"]>;
};

function isStartupRequestErrorEvent(event: ParsedEvent): event is StartupRequestErrorEvent {
  return event.kind === "error" && !!event.startupRequestMethod;
}

function runtimeRecoveryTrajectoryEntry(event: RuntimeRecoveryEvent): TrajectoryEntry {
  const lines = [event.message];
  if (event.details && event.details !== event.message) {
    lines.push(event.details);
  }
  return {
    kind: "system",
    title: event.source === "grok_resume_missing_session"
      ? "Grok resume recovery"
      : "Codex resume recovery",
    text: lines.join("\n"),
  };
}

type SubagentProgressEvent = Extract<ParsedEvent, { kind: "subagent_progress" }>;

/**
 * task #1260 — a background task observed on this process, by Claude's
 * task_id. `lastEventAtMs` follows every subagent-progress event naming it,
 * for the silent-task sweep (backgroundTaskHealth.ts).
 */
interface BackgroundTaskRecord extends BackgroundTaskHealthRecord {
  subagentType?: string;
  parentToolUseId?: string;
  taskKind?: SubagentProgressEvent["taskKind"];
}

type SessionResumeFactsReader = (runtime: string, sessionId: string, homeDir: string) => Promise<SessionResumeFacts>;

/**
 * What a cold-idle check (reconcileColdIdle) came to: `stopped`, or why the
 * process was left alone: a gate of wakeSessionRecycle.ts, not idle, already
 * being stopped, drifted from its spec (the spec stop decides it), or a
 * session that changed while its facts were read.
 */
type ColdIdleOutcome = "stopped" | ColdIdleSkipReason | "not_idle" | "stopping" | "spec_drift" | "session_changed";

/** The cold-idle step of one reconcile: decided at once, or a transcript read in flight. */
type ColdIdleStep =
  | { kind: "skipped"; reason: Exclude<ColdIdleOutcome, "stopped"> }
  | { kind: "checking"; outcome: Promise<ColdIdleOutcome> };

/** Bounded status line while the main turn has ended but background tasks still run. */
export function backgroundTasksWaitingDetail(count: number): string {
  return `Waiting for ${count} background task${count === 1 ? "" : "s"}`;
}

/**
 * Human-readable, BOUNDED detail line for a subagent lifecycle signal (APM 1.6
 * 6b). Built only from closed lifecycle tokens (phase + subagent role) — never
 * from raw prompt or output.
 */
function subagentProgressDetail(event: SubagentProgressEvent): string {
  const role = event.subagentType ? ` (${event.subagentType})` : "";
  switch (event.phase) {
    case "started":
      return `Subagent started${role}`;
    case "progress":
      return `Subagent working${role}`;
    case "notification":
      return event.taskStatus ? `Subagent ${event.taskStatus}${role}` : `Subagent update${role}`;
    default:
      return `Subagent working${role}`;
  }
}

/**
 * Closed subagent lineage marker for a `system` task-lifecycle signal. Only ids
 * + bounded phase/role — never inferred from text, no raw content. (APM 1.6 6b)
 */
function subagentLineageFromEvent(event: SubagentProgressEvent): SubagentLineage["subagent"] {
  return {
    ...(event.parentToolUseId ? { parentToolUseId: event.parentToolUseId } : {}),
    ...(event.subagentType ? { subagentType: event.subagentType } : {}),
    ...(event.taskId ? { taskId: event.taskId } : {}),
    phase: event.phase,
    // How it ended, so the Sub-agents view never reads the detail text.
    ...(event.phase === "notification" && event.taskStatus ? { outcome: SUBAGENT_TASK_STATUS_OUTCOME[event.taskStatus] } : {}),
  };
}

const SUBAGENT_TASK_STATUS_OUTCOME = {
  completed: "done",
  failed: "failed",
  stopped: "stopped",
} as const satisfies Record<NonNullable<SubagentProgressEvent["taskStatus"]>, SubagentOutcome>;

/** Closed-attr trace payload for a subagent lifecycle signal (Q8: ids as presence flags). */
function subagentProgressTraceAttrs(event: SubagentProgressEvent): Record<string, unknown> {
  return {
    kind: event.kind,
    source: event.source,
    phase: event.phase,
    parent_tool_use_id_present: Boolean(event.parentToolUseId),
    subagent_type_present: Boolean(event.subagentType),
    task_id_present: Boolean(event.taskId),
    last_tool_name_present: Boolean(event.lastToolName),
    payloadBytes: event.payloadBytes,
  };
}

type RuntimeDeliveryErrorEvent = Extract<ParsedEvent, { kind: "delivery_error" }>;

/**
 * Error signals a recovery/RESTART classifier may act on, bounded by runtime
 * liveness. Reads the decision-only view (cleared on the last runtime-progress
 * event), so an error from a turn the process has since moved past does not
 * restart or re-route a recovered agent. Error-class agnostic.
 *
 * Scope: this is for decisions that PROGRESS should invalidate (e.g.
 * stalled-recovery restart, session-resume). Terminal-failure GATING
 * (`classifyTerminalFailure`: auth / model-not-supported) is intentionally NOT
 * bounded here — those are sticky until an explicit user-turn recovery, not a
 * progress event — so it keeps reading the full history.
 */
function currentErrorCandidates(ap: AgentProcess): string[] {
  return ap.decisionErrorWindow.currentErrorCandidates();
}

function classifyTerminalFailure(ap: AgentProcess): RuntimeErrorDeliveryFailure | null {
  // Terminal-failure gating reads the FULL error history, not the progress-bounded
  // decision view: model-not-supported sticky failures are recovered only by an
  // explicit reconfiguration, not by runtime progress, so they must stay
  // detectable across progress events.
  const candidates = [
    ap.lastRuntimeError,
    ...ap.recentStderr,
  ].filter((value): value is string => !!value);

  for (const text of candidates) {
    // #proj-raft-computer:#46 (step 4a): a rejected sign-in, a plan without
    // the model or an exhausted billing balance is the credential's, not a
    // failure of this process: the credential ledger holds the agent's
    // deliveries until it changes (`noteCredentialInvalid`).
    if (credentialInvalidReasonOf(text)) continue;
    const diagnostics = buildRuntimeErrorDiagnosticEnvelope(text);
    const lower = text.toLowerCase();
    const inputTooLarge = diagnostics.spanAttrs.runtime_error_class === "InputTooLargeError";
    if (
      isRuntimeUsageLimitText(text) ||
      lower.includes("modelnotfounderror") ||
      lower.includes("requested entity was not found") ||
      lower.includes("model deprecated") ||
      lower.includes("model not found") ||
      lower.includes("model is not supported") ||
      lower.includes("unsupported model") ||
      lower.includes("codex_zero_evidence_turn_completed") ||
      /\bmodel\b.*\bnot supported\b/i.test(text) ||
      (inputTooLarge && ap.driver.id !== "claude") ||
      isProviderStreamFailureText(text) ||
      isRuntimeStartTimeoutText(text)
    ) {
      return {
        detail: inputTooLarge ? formatRuntimeInputTooLargeMessage(ap.driver.id) : text,
        // Action-required errors are credential-invalid (skipped above).
        actionRequired: false,
      };
    }
  }

  return null;
}

/**
 * Reconciler step 12: what a sticky failure does next. `input_too_large` and
 * `compaction_failed` (C8, a failed compaction): the session no longer fits,
 * a new one starts (once, `StickyFailureRecords.sessionReset`).
 * `model_unsupported` (C9): the agent is given back to the server at once.
 */
type StickyFailureKind = "input_too_large" | "compaction_failed" | "model_unsupported";

interface StickyFailure extends RuntimeErrorDeliveryFailure {
  kind: StickyFailureKind;
}

/**
 * A failure that sticks to the agent: the input is too large for the model
 * (C8; every runtime but Claude Code, which compacts on its own), or the
 * runtime cannot use the model (C9). A Codex turn that did nothing (C10) is
 * not one any more: it counts like a crash (D6, `noteCodexZeroEvidenceTurn`).
 */
function classifyStickyFailure(ap: AgentProcess): StickyFailure | null {
  const terminalFailure = classifyTerminalFailure(ap);
  if (!terminalFailure) return null;
  if (terminalFailure.detail === formatRuntimeInputTooLargeMessage(ap.driver.id)) return { ...terminalFailure, kind: "input_too_large" };
  if (/\b(?:model\b.*\bnot supported|unsupported\b.*\bmodel)\b/i.test(terminalFailure.detail)) return { ...terminalFailure, kind: "model_unsupported" };
  return null;
}

/** The Codex runtime completed a turn with no output, progress or token usage (C10). */
function isCodexZeroEvidenceTurnText(text: string): boolean {
  return /\bcodex_zero_evidence_turn_completed\b/i.test(text);
}

function formatRuntimeActionRequiredMessage(ap: AgentProcess, sourceText?: string | null): string {
  // task #352 — plan-without-model is action-required but is not a login
  // problem; it needs its own copy so the user changes the model or plan.
  if (isRuntimePlanAccessErrorText(sourceText ?? ap.lastRuntimeError ?? "")) {
    return formatRuntimePlanAccessMessage(ap.driver.id, ap.config.model);
  }
  if (ap.driver.id === "claude" && isClaudeCustomProviderConfig(ap.config)) {
    return "Claude Code custom provider authentication failed. Check this agent's custom Claude provider API key/API URL, then retry starting this agent.";
  }
  return formatRuntimeLoginRequiredMessage(ap.driver.id);
}

function buildRuntimeActionRequiredEntries(
  ap: AgentProcess,
  text: string,
  diagnostics: ReturnType<typeof buildRuntimeErrorDiagnosticEnvelope>,
): TrajectoryEntry[] {
  const excerpt = String(diagnostics.eventAttrs.runtime_error_message_excerpt ?? "").trim();
  const subtype = classifyRuntimeActionRequiredSubtype(ap, text);
  const detail = formatRuntimeActionRequiredMessage(ap, text);
  const diagnosticLabel = subtype === "provider_plan_access_error" ? "Runtime model-access diagnostic" : "Runtime auth diagnostic";
  const entries: TrajectoryEntry[] = [
    { kind: "text", text: `Error: ${detail}` },
    { kind: "text", text: `${diagnosticLabel}: ${subtype}` },
  ];
  if (excerpt) {
    entries.push({ kind: "text", text: `Raw error excerpt (redacted): ${excerpt}` });
  }
  if (ap.driver.id === "claude") {
    entries.push({
      kind: "text",
      text: isClaudeCustomProviderConfig(ap.config)
        ? "Claude auth mode: custom provider. Local Claude Code login does not fix this branch; check this agent's provider API key/API URL."
        : "Claude auth mode: default host login. If Terminal works, set this agent's Claude command to the absolute path from `which claude` and restart Raft Computer.",
    });
  }
  return entries;
}

function classifyRuntimeActionRequiredSubtype(ap: AgentProcess, text: string): string {
  if (isRuntimePlanAccessErrorText(text)) return "provider_plan_access_error";
  const lower = text.toLowerCase();
  const customClaudeProvider = ap.driver.id === "claude" && isClaudeCustomProviderConfig(ap.config);
  if (customClaudeProvider) {
    if (/\bmissing\b.*\b(?:api\s*)?key\b|\b(?:api\s*)?key\b.*\bnot set\b|\bmissing\b.*\btoken\b|\bno\b.*\btoken\b/i.test(text)) {
      return "custom_provider_missing_key";
    }
    if (/\binvalid\b.*\b(?:api\s*)?key\b|\bunauthorized\b|\b401\b|\b403\b|auth(?:entication)? failed/i.test(text)) {
      return "custom_provider_invalid_key";
    }
    return "custom_provider_auth_error";
  }
  if (ap.driver.id === "claude") {
    if (lower.includes("not logged in") || lower.includes("not signed in") || lower.includes("please log in") || lower.includes("login required")) {
      return "host_claude_login_required";
    }
    return "runtime_auth_error";
  }
  if (ap.driver.id === "builtin") return "builtin_provider_auth_error";
  return "runtime_auth_error";
}

/**
 * The user-visible error of an invalid credential (what to do: log in, change
 * the model or plan, add credits), with the diagnostic lines of the auth or
 * plan-access case.
 */
function credentialInvalidVisibleError(ap: AgentProcess, reason: CredentialInvalidReason, message: string): { detail: string; entries: TrajectoryEntry[] } {
  // #proj-raft-computer:#68: an account problem shows the daemon's own fixed text.
  const problem = credentialProblemCodeOf(message);
  if (problem) {
    const text = CREDENTIAL_PROBLEM_MESSAGES[problem];
    return { detail: text, entries: [{ kind: "text", text: `Error: ${text}` }] };
  }
  const detail = reason === "billing"
    ? formatRuntimeBillingExhaustedMessage(ap.driver.id)
    : formatRuntimeActionRequiredMessage(ap, message);
  const entries: TrajectoryEntry[] = reason === "billing"
    ? [{ kind: "text", text: `Error: ${detail}` }]
    : buildRuntimeActionRequiredEntries(ap, message, buildRuntimeErrorDiagnosticEnvelope(message));
  return { detail, entries };
}

/** The process's latest runtime error (or stderr line) that says its credential is invalid, if any. */
function credentialInvalidErrorOf(ap: AgentProcess): { reason: CredentialInvalidReason; text: string } | null {
  for (const text of [ap.lastRuntimeError, ...ap.recentStderr]) {
    if (!text) continue;
    const reason = credentialInvalidReasonOf(text);
    if (reason) return { reason, text };
  }
  return null;
}

/** Close paths that leave unconsumed deliveries to the Server's unread
 * catch-up on purpose (task #353). */
const EXPECTED_SERVER_CARRIED_EXIT_PATHS = new Set(["explicit_stop", "silent_stop", "cold_idle_recycle", "clean_exit_deferred"]);

function isRuntimeStartTimeoutText(text: string): boolean {
  return /did not finish starting (?:on this machine|within )/i.test(text);
}

/** Closed: a RuntimeErrorClass, or no class matched (a start timeout, or anything else). */
type RuntimeExitReason = RuntimeErrorClass | "runtime_start_timeout" | "unknown";

/**
 * Why a failed turn ended, for its `daemon.runtime.turn` span: the first
 * specific RuntimeErrorClass in the last runtime error and the stderr tail
 * (Raft's own start-timeout copy is not runtime output and is skipped), else
 * `unmatched`. Stderr is counted, never recorded.
 */
function runtimeFailureEndTraceAttrs(ap: AgentProcess, unmatched: "runtime_start_timeout" | "unknown"): {
  runtime_exit_reason: RuntimeExitReason;
  stderr_present: boolean;
  stderr_lines_count: number;
} {
  let reason: RuntimeExitReason = unmatched;
  for (const text of [ap.lastRuntimeError, ...ap.recentStderr]) {
    if (!text || isRuntimeStartTimeoutText(text)) continue;
    const { errorClass } = buildRuntimeErrorActivityDiagnostic(text);
    if (errorClass !== "RuntimeError") {
      reason = errorClass;
      break;
    }
  }
  return { runtime_exit_reason: reason, stderr_present: ap.recentStderr.length > 0, stderr_lines_count: ap.recentStderr.length };
}

function isCodexProviderReconnectLog(text: string): boolean {
  return /Reconnecting\.\.\.\s*\d+\s*\/\s*\d+/i.test(text);
}

/**
 * task #1127 — English fallback shown when the web has no catalog copy for
 * `model_tool_args_invalid` (older web, or a surface that renders the daemon
 * detail directly). The web substitutes its own en/zh string by reason.
 */
const CODEX_TOOL_ARGUMENT_PARSE_USER_MESSAGE =
  "The model produced tool-call arguments Codex could not parse, so the tool call was rejected — try a different model";

function isCodexBenignTransportLog(text: string): boolean {
  return /Falling back from WebSockets/i.test(text);
}

function isStdinClassRecoveryLine(text: string): boolean {
  return /write_stdin failed|stdin is closed|closed for this session|session.*closed/i.test(text);
}

function hasDirectStdinRecoveryEvidence(ap: AgentProcess): boolean {
  const candidates = currentErrorCandidates(ap);

  return candidates.some((text) => isStdinClassRecoveryLine(text));
}

/**
 * The generic resume fallback (AndyLok, #proj-raft-computer:#42): a Claude
 * agent SIGTERMed mid-task was restarted 4 times on the same stored session,
 * each launch exiting 1 within 1-4 s on the same error, until the server's
 * wake crash-loop breaker stopped waking it; it never tried a fresh session,
 * so the task it held stayed locked. The error was not one the per-runtime
 * matchers know, so the rule goes by shape instead of text: early crashes in
 * a row of launches that resumed one session (planExit,
 * RESUMED_EARLY_CRASH_WINDOW_MS) make `chooseSession` start a new one
 * (RESUME_FAILURE_THRESHOLD, reconciler step 10a row D4).
 */
export { RESUMED_EARLY_CRASH_WINDOW_MS } from "./planExit";

/** Reconciler step 12: a new session failed the same way as the one it replaced (`session_needs_reset`). */
function formatSessionStillFailsMessage(runtimeLabel: string, lastError: string): string {
  return `${runtimeLabel} failed again in the new session Raft started for it (${lastError}). Raft stopped starting new sessions. ${formatRuntimeResetSessionGuidance()}`;
}

function resumeSessionRecoveryReason(ap: AgentProcess): KnownResumeError | null {
  if (!ap.sessionId) return null;
  const candidates = currentErrorCandidates(ap);

  if (ap.driver.id === "claude") {
    return candidates.some((text) => /No conversation found with session ID/i.test(text)) ? "missing" : null;
  }

  if (ap.driver.id === "opencode") {
    if (candidates.some((text) => /Session not found/i.test(text) && text.includes(ap.sessionId!))) return "missing";
    if (candidates.some(isOpenCodeReplayRejectedByProvider)) return "provider_replay_rejected";
    return null;
  }

  if (ap.driver.id === "pi") {
    return candidates.some(isPiReplayRejectedByProvider) ? "provider_replay_rejected" : null;
  }

  if (ap.driver.id === "gemini") {
    return candidates.some((text) =>
      /Error resuming session:\s*Invalid session identifier/i.test(text) &&
      text.includes(ap.sessionId!),
    ) ? "missing" : null;
  }

  return null;
}

function isOpenCodeReplayRejectedByProvider(text: string): boolean {
  // Keep this exact: generic "Provider returned error" can be any upstream failure,
  // but this schema rejection means the stored replay transcript is unusable for the provider.
  return /Invalid request:\s*the message at position \d+ with role ['"]?assistant['"]? must not be empty/i.test(text);
}

function isPiReplayRejectedByProvider(text: string): boolean {
  return /Cannot continue from message role:\s*assistant/i.test(text);
}

function buildRuntimeStallDiagnostic(ap: AgentProcess, staleForMs: number, staleForMinutes: number) {
  return projectApmRuntimeStallDiagnostic({
    staleForMs,
    staleForMinutes,
    lastActivityKind: ap.lastActivityKind,
    lastActivity: ap.lastActivity,
    lastActivityDetail: ap.lastActivityDetail,
    lastActivityDetailKind: ap.lastActivityDetailKind,
    runtimeProgressLastEventKind: ap.runtimeProgress.lastEventKind,
    runtime: ap.config.runtime,
    model: ap.config.model,
    platform: process.platform,
    arch: process.arch,
    launchId: ap.launchId,
    sessionIdPresent: Boolean(ap.sessionId),
    inboxCount: ap.inbox.length,
    pendingNotificationCount: ap.notifications.pendingCount,
    processPidPresent: typeof ap.runtime.pid === "number",
    driverBusyDeliveryMode: ap.driver.busyDeliveryMode,
    supportsStdinNotification: ap.driver.supportsStdinNotification,
    outstandingToolUses: ap.gatedSteering.outstandingToolUses,
    compacting: ap.gatedSteering.compacting,
    reviewing: ap.gatedSteering.reviewing === true ? true : undefined,
    recentStderrCount: ap.recentStderr.length,
    recentStdoutCount: ap.recentStdout.length,
    runtimeTraceCounterAttrs: runtimeTraceCounterAttrs(ap),
  });
}

function buildRuntimeInputTraceAttrs(opts: {
  source: string;
  prompt: string;
  standingPrompt?: string;
  resumePrompt?: string;
  messages?: AgentMessage[];
  unreadSummary?: Record<string, number>;
  sessionIdPresent: boolean;
  nativeStandingPrompt: boolean;
  /** The standing prompt text rides in this input (fresh session without a native layer, or a task #13 re-delivery). */
  standingPromptInInput?: boolean;
  /** The server features notice rides in this input (formatServerFeaturesNotice). */
  serverFeaturesNoticeInInput?: boolean;
}): Record<string, unknown> {
  return {
    runtime_input_source: opts.source,
    runtime_input_prompt_bytes_bucket: bucketBytes(opts.prompt),
    runtime_input_standing_prompt_bytes_bucket: bucketBytes(opts.standingPrompt),
    runtime_input_resume_prompt_present: Boolean(opts.resumePrompt),
    runtime_input_resume_prompt_bytes_bucket: bucketBytes(opts.resumePrompt),
    runtime_input_session_present: opts.sessionIdPresent,
    runtime_input_native_standing_prompt_present: opts.nativeStandingPrompt,
    // A source-side fact (the prompt text itself never reaches the trace); the
    // `_present` suffix is what lets the local trace sink keep the key.
    runtime_input_standing_prompt_present: opts.standingPromptInInput === true,
    // Source-side too: the notice rode in this input.
    runtime_input_server_features_notice_present: opts.serverFeaturesNoticeInInput === true,
    runtime_input_unread_channels_count: opts.unreadSummary ? Object.keys(opts.unreadSummary).length : 0,
    ...attentionHintInputTraceAttrs(opts.messages),
    ...summarizeMessageInputBytes(opts.messages),
  };
}

function attentionHintInputTraceAttrs(messages?: AgentMessage[]): Record<string, unknown> {
  const hints = messages
    ?.map((message) => message.attention_hint)
    .filter((hint): hint is AttentionHint => Boolean(hint)) ?? [];
  if (hints.length === 0) return {};
  const triggers = [...new Set(hints.map((hint) => hint.trigger))].join(",");
  return {
    runtime_input_attention_hint_count: hints.length,
    runtime_input_attention_hint_triggers: triggers,
  };
}

interface DeliveryTraceContext {
  deliveryId?: string;
  transient?: boolean;
  mentionDelivery?: MentionDeliveryIdentitySnapshot;
  onMentionTransition?: (stage: MentionDeliveryTransitionStage, outcome: "accepted" | "coalesced") => void;
  onMentionTerminalError?: (code: MentionDeliveryTerminalErrorCode) => void;
  onMentionAck?: () => void;
  /** No process and no cached idle/restart config: the Server must wake with config (task #1113). */
  onRejectedNoProcess?: () => void;
}

interface TrackedMentionDelivery {
  agentId: string;
  messageId: string;
  /** The delivered row, kept so turn-end settlement can ask whether the runtime consumed it. */
  message: AgentMessage;
  state: "received" | "pending" | "drained";
  context: DeliveryTraceContext;
  /** task #9: the process whose first input named this message (a restart for it). */
  toldProcessInstanceId?: string;
}

interface PendingServerWake {
  wakeRequestId: string;
  itemId: string;
  appId: string;
  sourceRef: { kind: string; id: string; revision?: string };
  pendingAppItems: number;
  requestedAtMs: number;
  // Captured when the wake is first parked, so an offline resend still joins
  // the trace of the flow that created it.
  traceparent?: string;
}

/**
 * Deterministic per (agent, inbox item): a duplicate fire, a resend after
 * reconnect, or a re-fire after a daemon restart all carry the same id, so the
 * Server can replay its outcome instead of dispatching twice.
 */
function serverWakeRequestId(agentId: string, itemId: string): string {
  return createHash("sha256").update(`${agentId}\n${itemId}`).digest("hex").slice(0, 32);
}

/**
 * Progress kinds that prove the limited model is producing output again
 * (task #379). Not turn-start bookkeeping (`internal_progress`,
 * `runtime_diagnostic`, or an empty `thinking` marker, reported as
 * `thinking_marker`, task #386); not `tool_output`, which can be a tool started
 * before the limit finishing late; not `subagent_progress`, which can come
 * from a subagent on a different, unlimited model. A classified limit error
 * is an `error` event, never one of these.
 */
const RATE_LIMIT_BACKOFF_CLEARING_PROGRESS: ReadonlySet<string> = new Set([
  "text",
  "thinking",
  "tool_call",
]);

// The provider-limit delay policy is shared with the OAR host (runtimeErrorDeliveryPolicy.ts).
export { providerLimitBackoffDelayMs, QUOTA_RESET_BACKOFF_MAX_MS } from "./runtimeErrorDeliveryPolicy";

/**
 * The launch fields of a feedback request's `sessionLookup` as the config the
 * session lookup reads (runtime, the env vars its session directory derives
 * from, the session id). Nothing else of a config is used there.
 */
function agentConfigForSessionLookup(lookup: FeedbackTranscriptSessionLookup): AgentConfig {
  return {
    name: "",
    displayName: null,
    description: null,
    serverUrl: "",
    authToken: "",
    runtime: lookup.runtime,
    model: lookup.model,
    runtimeConfig: null,
    reasoningEffort: null,
    envVars: lookup.sessionHomeEnv,
    sessionId: lookup.sessionId,
  } as AgentConfig;
}

export class AgentProcessManager {
  private agents = new Map<string, AgentProcess>();
  private readonly revokedRunnerCredentialIds = new Set<string>();
  /** #wg-rbac:#27: what each spawn attempt in progress carries (`spawnAgentProcess`). */
  private readonly spawningRunnerConfigs = new Set<() => Array<AgentConfig | null>>();
  private turnActivity: TurnActivitySnapshotWriter = new TurnActivitySnapshotWriter(null);
  private readonly lifecycleRecords: AgentLifecycleRecords<RuntimeErrorDeliveryBackoffState, RuntimeErrorFingerprintFenceState>;

  /**
   * Where activity facts go (RFC 069 §7). The legacy sink frames them as
   * `agent:activity` (client sequence, producer fact id, heartbeat and probe
   * frames). Dependencies are read lazily so tests that swap `sendToServer` or
   * fake the clock still apply.
   */
  private readonly activitySink: ActivitySink = new LegacyActivitySink({
    sendToServer: (msg) => this.sendToServer(msg),
    nextClientSeq: (agentId) => this.lifecycleRecords.nextActivityClientSeq(agentId),
    daemonInstanceId: () => this.daemonInstanceId,
    recordEvent: (name, attrs, status) => this.recordDaemonEvent(name, attrs, status),
    now: () => Date.now(),
  });
  private agentStarts: AgentStartCoordinator;
  private agentStartDispatch: AgentStartDispatchProjection;
  private startingInboxes = new AgentStartPendingDeliveryBuffer();
  /**
   * Daemon-local coalescing only. Durable authority is the Server occurrence
   * row; an unacked pending row is replayed with the same occurrence id after
   * daemon restart and reconstructs this cache.
   */
  private readonly trackedMentionDeliveries = new Map<string, TrackedMentionDelivery>();
  /** Per-turn Activity overview records (task #17), keyed by agent id so they survive process exit. */
  private readonly turnSummaries = new TurnSummaryTracker();
  /**
   * Each agent's latest provider quota reading (Claude `rate_limit_event`).
   * Quota is account state, so it outlives a process and is kept across
   * launches; it is dropped with the agent's workspace.
   */
  readonly providerQuota = new ProviderQuotaState({
    now: () => this.clockNow(),
    recordEvent: (name, attrs) => this.recordDaemonEvent(name, attrs),
  });
  /**
   * task #9: the identity of an idle agent being restarted for a delivery,
   * between dropping its restart snapshot and its new process existing, so a
   * tracked mention arriving in that window is matched instead of rejected.
   */
  private readonly restartingIdentities = new Map<string, { launchId: string | null; sessionId: string | null }>();
  /** Monotonic ordering counter for launch phase-5/6 exported rows (audit only, not a pairing key). */
  private launchTransitionSeq = 0;
  private noProcessResidencyTransitions = new AgentNoProcessResidencyTransitions();
  private slockCliPath: string;
  private sendToServer: (msg: MachineToServerMessage) => void;
  /** Agent typing line: live `agent:send_intent` frames per agent (agentSendIntentTracker.ts). */
  private readonly sendIntents = new AgentSendIntentTracker({ send: (frame) => this.sendToServer(frame) });
  /** SERVER_CAPABILITY_TURN_ENDED_V1 on the current connection's `machine:context`. */
  private serverReadsTurnEnded = false;
  /** SERVER_CAPABILITY_STICKY_FAILURE_REASONS_V1 on the current connection's `machine:context` (reconciler step 12). */
  private serverCountsStickyReasons = false;
  /**
   * Server features: what each agent's session last ran with before they
   * changed, until its next spawn tells it what changed (formatServerFeaturesNotice).
   * Set once per change run: later changes keep the oldest base, so the notice
   * compares with what the session actually saw.
   */
  private readonly serverFeaturesNoticeBase = new Map<string, AgentServerFeatures>();
  /**
   * Server features on the current connection: whether its server answers
   * `server:features:request`, the last answer applied, and how many answers
   * were applied, so a start whose config was taken before the latest answer
   * (it was queued, spawning, or rebound) is brought up to it. Cleared when
   * the connection drops.
   */
  private serverFeaturesCapable = false;
  private serverFeaturesGeneration = 0;
  private lastAppliedServerFeatures: AgentServerFeatures | null = null;
  /** serverFeaturesGeneration when each agent's latest start config was taken (startAgent, then its spawn). */
  private readonly startConfigFeaturesGeneration = new Map<string, number>();
  /**
   * task #1103 — one parked server wake per agent. An app-inbox item that is
   * due for an agent with no local process and no in-memory restart snapshot
   * is handed to the Server (which owns the config) instead of being retried
   * locally. The slot is resent once per connect edge and cleared by the
   * Server's outcome or by the agent starting for any reason.
   */
  private readonly pendingServerWakes = new Map<string, PendingServerWake>();
  /**
   * task #925: agents whose next start answers a server wake for a due app
   * item. That start carries the item, so a runtime that defers empty starts
   * must still spawn for it.
   */
  private readonly serverWakeStartsOwed = new Map<string, string>();
  /** See `reportStartFailure`. */
  private readonly lastStartFailures = new Map<string, LastStartFailure>();
  /**
   * Reconciler step 11c: agents released for a config no host restarts
   * itself (here: another runtime or host, or a new session from an idle
   * snapshot; the OAR host: every spec stop). Shared with the OAR host. On
   * this host's clock: its deadline is read by this host's refusal, and its
   * deadline timer reports here (`reportSpecHandbackDeadline`).
   */
  readonly specHandbacks: SpecHandbacks;
  /**
   * Start timeouts in a row per agent. Unlike the spawn-fail backoff, which a
   * successful spawn resets, only startup readiness ends this streak: a start
   * timeout follows a successful spawn by definition.
   */
  private readonly startTimeoutStreaks = new Map<string, number>();
  /**
   * RFC 071 §6: the `catchupBatchId` of the latest server start per agent,
   * bound to that start's launchId. The spawn that renders the start's
   * resume catch-up as input takes it (a pending rebind replaces launchId and
   * resumeMessages together, so the launch match keeps them paired). One
   * slot per agent: every later start overwrites or clears it.
   */
  private readonly startCatchupBatches = new Map<string, { launchId: string; batchId: string }>();
  /**
   * RFC 071: launches accepted from server starts that have no final result
   * yet, in acceptance order. A spawn settles every launch waiting here
   * (folded starts become `supersededLaunchIds`); a spawn that fails or is
   * cancelled before a process exists settles them all `not_spawned`.
   */
  private readonly acceptedLaunches = new Map<string, string[]>();
  private daemonApiKey: string;
  private serverUrl: string;
  private slockHome: string;
  private dataDir: string;
  /** task #13: the standing prompt each Codex / Claude / … session runs on, on disk. */
  private standingPromptLedger: StandingPromptLedger;
  /** task #10: consecutive terminal compaction failures per Pi / Built-in session, on disk. */
  private compactionFailureLedger: SessionCompactionFailureLedger;
  private runtimeSessionHomeDir: string;
  /** Reconciler step 15: the account an agent's runtime signs in as (credentialSource.ts). */
  private readonly readCredentialAccount: CredentialAccountReader;
  private coldIdleSweepTimer: ReturnType<typeof setInterval> | null = null;
  /** How long each idle-gated action has been held by the same reason (agentIdleHold.ts). */
  private readonly idleHolds = new AgentIdleHoldTracker();
  /** Reconciler step 13: the drain (agentDrain.ts); held work waits in the inboxes and the start queue. */
  private readonly drain = new AgentDrains({
    host: "legacy",
    progress: (agentId) => this.computeDrainProgress(agentId),
    release: (agentId) => this.releaseDrainHeld(agentId),
    recordEvent: (name, attrs) => this.recordDaemonEvent(name, attrs),
    now: () => this.clockNow(),
  });
  /** Transient deliveries a drain held for a live process (they have no inbox row): delivered again at its end. */
  private drainHeldTransients: Array<{ agentId: string; message: AgentMessage; traceContext: DeliveryTraceContext }> = [];
  /**
   * Idle agents whose idle task reminder a drain answered `busy` (Tenny
   * f8ae3b79 condition 3): a reminder is not kept, and an agent already idle
   * sees no further Working→Idle edge, so the end of the drain gives it one.
   */
  private readonly drainRefusedIdleNotices = new Set<string>();
  /**
   * Reconciler step 7: the runtime and model each agent's last session
   * started on (memory only); a start that would resume it on another
   * runtime, or a Codex one on another model, opens a new session. Shared
   * with the OAR host (core.ts).
   */
  readonly sessionSpecs = new SessionSpecMemory();
  /**
   * Reconciler step 11: the order of the configs the server sends each agent
   * (`agent:config` revisions, `agent:start` configRevision). Shared with the
   * core, which drops a stale push before any host sees it.
   */
  readonly configRevisions = new AgentConfigRevisions();
  /** task #1357 item 1: `agent:model_limits` `seq`, per daemon process. */
  private modelLimitsSeq = 0;
  /** Reads a runtime's descendants for the silent background task check (tests fake it). */
  private readonly readRuntimeDescendants: RuntimeDescendantReader;
  /** Agents whose silent background tasks are being checked (one tree read at a time). */
  private readonly backgroundTaskChecks = new Set<string>();
  /** RFC 070 §6.5: sessions marked for a warm recycle, and the stops the next start decides on (wakeRecycleWarm.ts). */
  private readonly warmRecycle = new WarmRecycleMarks();
  /** The cold-idle transcript read in flight per agent (reconcileColdIdle): at most one. */
  private readonly coldIdleChecks = new Map<string, Promise<ColdIdleOutcome>>();
  private readonly readSessionResumeFacts: SessionResumeFactsReader;
  private frozenClockMs: number | null = null;
  private driverResolver: (runtimeId: string) => RuntimeDriver;
  private defaultAgentEnvVarsProvider: ((config: Pick<AgentConfig, "runtime" | "model" | "envVars">) => Promise<Record<string, string> | null> | Record<string, string> | null) | null;
  private tracer: Tracer;
  private stdinNotificationRetryMs: number;
  private readonly queuedInputSettleMs: number;
  /** Reconciler step 5: every stop's grace before the tree kill, and how long an exit is then awaited. */
  private readonly stopKill: { graceMs: number; confirmMs: number };
  /**
   * Reconciler step 5: runtimes that left `agents` on a stop (explicit,
   * silent, terminal failure, a start discarded by a stop) and have not been
   * seen to exit yet. The agent is released only once its exit is confirmed:
   * a new start of it waits here first (`runtimeExited`), so two
   * processes never run one agent.
   */
  private readonly exitingRuntimes = new Map<string, { runtimes: Set<RuntimeSession>; exited: Promise<void> }>();
  /**
   * Reconciler step 5, the orphan sweep: every runtime process this runner
   * spawns, recorded in its machine dir until its exit is confirmed
   * (`RuntimeProcessLedger`). Null until the machine dir is known.
   */
  private runtimeProcessLedger: RuntimeProcessLedger | null = null;
  /** `raft proc` jobs are this daemon's children too: never recorded (nor reaped) as runtimes. */
  private procJobOwnsPid: ((pid: number) => boolean) | null = null;
  /** The reap of what the previous daemon left running; every start waits for it. */
  private orphanSweep: Promise<void> | null = null;
  private orphanSweepPending = false;
  private readonly orphanReapDeps: OrphanReapDeps;
  private readonly runtimeProcessLedgerDeps: RuntimeProcessLedgerDeps;
  private sessionReadyDeliveryRetryMs: number;
  private runtimeErrorDeliveryBackoffBaseMs: number;
  private runtimeErrorDeliveryBackoffMaxMs: number;
  private runtimeErrorDeliveryBackoffJitterRatio: number;
  private runtimeErrorDeliveryBackoffJitterRandom: () => number;
  private runtimeErrorDeliveryBackoffFailPointForTesting: ((args: { agentId: string; message: string }) => RuntimeErrorDeliveryBackoffFailPoint | null | undefined) | null;
  private cliTransportTraceDir: string | null = null;
  /** Machine state root, for reading this machine's own trace corpus. */
  private machineDir: string | null = null;
  private readonly deliveryTraceContexts = new WeakMap<AgentMessage, DeliveryTraceContext>();
  /** When this daemon first received each delivered message (local clock), for `local_wait_ms`. */
  private readonly deliveryReceivedAtMs = new WeakMap<AgentMessage, number>();
  private readonly runtimeExitTraceAttrs = new WeakMap<RuntimeSession, Record<string, unknown>>();
  private readonly runtimeProcessBindingFence = new RuntimeProcessBindingFence({
    getCurrentProcess: (agentId) => this.agents.get(agentId) ?? null,
    recordTrace: (...args) => this.recordDaemonEvent(...args),
    now: () => this.clockNow(),
  });
  private readonly agentVisibleDelivery = new AgentVisibleDeliveryLedger();
  private readonly serverContext = new ServerContextLedger();
  /**
   * Per-agent lifecycle facts that outlive a single `AgentProcess`.
   *
   * The old implementation stored these as separate manager-level maps:
   * idle restart snapshots, terminal runtime failures, spawn-fail cooldown,
   * pending start rebinds, pending spawn causes, runtime-error fences, and the
   * activity client sequence. Keeping their storage under one owner makes the
   * lifecycle projection/invariants read the actual mutation boundary instead
   * of reconstructing it from unrelated fields.
   */
  private readonly daemonVersion: string | null;
  private readonly daemonInstanceId: string | null;
  /**
   * task #365: what the connected server advertised. `spawnErrorCapable`: it
   * counts a proven never-created child (`spawn_error`) in its own bounded
   * backoff; without it a failed spawn keeps today's crash reporting, which
   * an older server's #1119 breaker relies on. `connectionEpochId`: the
   * server's id for the current connection; an automatic start claimed
   * against another one is stale.
   */
  private serverStartContext: { spawnErrorCapable: boolean; connectionEpochId: string | null } = {
    spawnErrorCapable: false,
    connectionEpochId: null,
  };
  private readonly runtimeProcessGate: RuntimeProcessGate | null;
  /** RFC 071: per agent, the start held for the server capability (cancelled by a stop). */
  private readonly capabilityHolds = new Map<string, CapabilityWait>();
  private readonly computerVersion: string | null;
  private readonly workerUrl: string | null;
  private readonly fetchImpl: FetchLike;
  /** View Context v0: send index, availability reports and context view requests (agentContextView/). */
  private readonly contextView: AgentContextViewService;
  /** RFC 060: agents another host (the OAR host) runs; read by the transcript and runtime-profile reports. */
  private hostedSessions: HostedAgentSessions | null = null;
  /** The last session each agent had on another host, past its end: View Context reads it as it reads a restart snapshot. */
  private readonly lastHostedSessions = new Map<string, HostedAgentSession>();
  private readonly serverConnected: () => boolean;
  readonly #appInboxForAgent: ((agentId: string) => AgentAppInboxStore) | null;
  readonly #onAgentWorkingToIdle: ((agentId: string) => void) | null;
  readonly #onRuntimeAbsentLocalStop: ((runtime: string) => void) | null;
  /** Reports third-party events whose body a start's first prompt handed to the model. */
  readonly #reportThirdPartyEventsDelivered: (agentId: string, eventIds: readonly string[]) => void;
  /** The runtime CLI version the daemon last detected, by runtime id. */
  readonly #detectedRuntimeCliVersion: (runtimeId: string) => string | undefined;
  /** Per agent: the app items it was told of, by item id, each with its createdAtMs then (appInboxItemNoticed). */
  private readonly appInboxNoticedItemIds = new Map<string, Map<string, number | undefined>>();
  /**
   * per_turn runtimes (opencode, cursor, gemini, copilot) cannot take a notice
   * between or during turns. The notice waits for the process to exit:
   * a waking item (`wakeItemIds`) restarts the agent for it (as a queued
   * message would); advisory notices instead ride in the next start's first
   * input. The ids bind the wake to its own items (task #925): an advisory
   * item never inherits a wake whose item was acknowledged meanwhile.
   */
  private readonly appInboxNoticesAfterTurn = new Map<string, { wakeItemIds: ReadonlySet<string> }>();
  /**
   * A busy runtime that cannot take a notice right now (e.g. codex between
   * steerable points) fails the write; the caller retries each period and the
   * idle drain re-offers it. Trace the state change only: the first busy
   * failure, then the outcome that ends the wait (with attempts and wait).
   * The wait belongs to the item that started it: once that item has left the
   * Inbox (the agent read and acknowledged it during its turn, so no notice
   * ends the wait), the wait is over and is not charged to a later notice.
   * One wait per agent: if item B fails busy while A's wait is open, B's
   * failure counts as an attempt of A's wait, and B's own wait starts only
   * after A's ends, so B's reported wait leaves out the time before that.
   */
  private readonly appInboxBusyDeferrals = new Map<string, { itemId: string; firstAtMs: number; attempts: number }>();
  private readonly appInboxIdleDrains = new Set<string>();
  // After a runtime rejects a turn/start as busy, the idle drain waits one
  // retry interval instead of re-offering at once: the rejection marks the
  // agent idle again, and an immediate drain would be rejected the same way,
  // looping as fast as the runtime answers (10–25 writes/s seen on kimi-sdk).
  private readonly appInboxDrainDeferredUntil = new Map<string, number>();
  private readonly appInboxDeferredDrainTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly runtimeErrorProcessRestartTimers = new Map<string, unknown>();
  private readonly busyDelivery = new RuntimeBusyDeliveryCoordinator<AgentProcess>({
    nowMs: () => this.clockNow(),
    commitDecisionState: (...args) => this.commitGatedSteeringDecisionState(...args),
    flushDirectNotification: (...args) => this.flushPendingDirectStdinNotificationOnRuntimeProgress(...args),
    flushIdleDelivery: (...args) => this.flushIdleInboxDeliveryRetry(...args),
    recordDaemonEvent: (...args) => this.recordDaemonEvent(...args),
    recordRuntimeTraceEvent: (...args) => this.recordRuntimeTraceEvent(...args),
  });

  constructor(
    sendToServer: (msg: MachineToServerMessage) => void,
    daemonApiKey: string,
    opts: {
      dataDir?: string;
      serverUrl: string;
      workerUrl?: string;
      driverResolver?: (runtimeId: string) => RuntimeDriver;
      defaultAgentEnvVarsProvider?: (config: Pick<AgentConfig, "runtime" | "model" | "envVars">) => Promise<Record<string, string> | null> | Record<string, string> | null;
      slockCliPath?: string;
      slockHome?: string;
      tracer?: Tracer;
      daemonVersion?: string | null;
      daemonInstanceId?: string | null;
      computerVersion?: string | null;
      fetchImpl?: FetchLike;
      stdinNotificationRetryMs?: number;
      /** Reconciler step 6: QUEUED_INPUT_SETTLE_MS (tests shorten it). */
      queuedInputSettleMs?: number;
      /** Reconciler step 11d: SPEC_HANDBACK_START_DEADLINE_MS (tests shorten it). */
      specHandbackDeadlineMs?: number;
      /** Where this runner records how many agents are mid-turn (TurnActivitySnapshotWriter). */
      activitySnapshotPath?: string | null;
      /** Reconciler step 5: the stop grace and the exit confirmation window (tests shorten them). */
      stopKill?: { graceMs?: number; confirmMs?: number };
      /** Reconciler step 5: the orphan sweep's process access (tests). */
      orphanReap?: OrphanReapDeps;
      /** Reconciler step 5: the runtime process ledger's process access (tests). */
      runtimeProcessLedger?: RuntimeProcessLedgerDeps;
      sessionReadyDeliveryRetryMs?: number;
      runtimeErrorDeliveryBackoff?: {
        baseMs?: number;
        maxMs?: number;
        jitterRatio?: number;
        jitterRandom?: () => number;
        failPointForTesting?: (args: { agentId: string; message: string }) => RuntimeErrorDeliveryBackoffFailPoint | null | undefined;
      };
      runtimeSessionHomeDir?: string;
      /** Reconciler step 15: reads the account an agent's runtime signs in as; tests fake it. */
      credentialAccountReader?: CredentialAccountReader;
      runtimeStartScheduler?: {
        maxConcurrentStarts?: number;
        minStartIntervalMs?: number;
      };
      serverConnected?: () => boolean;
      /**
       * View Context: the server this daemon is connected to (its
       * `machine:context`); null until known. Default: never known, so no
       * whole-server View Context disk work runs.
       */
      connectedServerId?: () => string | null;
      appInboxForAgent?: (agentId: string) => AgentAppInboxStore;
      /** Called when an agent finishes work and goes from Working to Idle (built-in apps time advisory hints by it). */
      onAgentWorkingToIdle?: (agentId: string) => void;
      /**
       * A daemon-local restart stopped because the runtime is missing here
       * (isRuntimeAbsentStartFailure). The core re-detects runtimes shortly
       * after, so a runtime that was only mid-update (a self-updating CLI
       * swapping its binary) is listed again and the server lifts the pause.
       */
      onRuntimeAbsentLocalStop?: (runtime: string) => void;
      /** Defaults to the Agent Credential Proxy's delivered reporter (tests observe it here). */
      reportThirdPartyEventsDelivered?: (agentId: string, eventIds: readonly string[]) => void;
      /** The runtime CLI version the daemon last detected (its `ready.runtimeVersions`). */
      detectedRuntimeCliVersion?: (runtimeId: string) => string | undefined;
      /** RFC 071 outbox: every spawn and rebind first durably records the process as open. */
      runtimeProcessGate?: RuntimeProcessGate;
      /** The silent background task check's process tree read (backgroundTaskHealth.ts); tests fake it. */
      readRuntimeDescendants?: RuntimeDescendantReader;
      /** The cold-idle check's session facts read (wakeSessionRecycle.ts); tests fake it. */
      readSessionResumeFacts?: SessionResumeFactsReader;
      /**
       * Reconciler step 10b: the exit streaks (crash and cap streaks, the
       * early-crash record) both agent hosts share; core.ts creates one for
       * both. One of this host's own by default.
       */
      exitStreaks?: ExitStreaks;
    },
  ) {
    this.lifecycleRecords = new AgentLifecycleRecords<RuntimeErrorDeliveryBackoffState, RuntimeErrorFingerprintFenceState>(undefined, opts.exitStreaks);
    this.slockCliPath = opts.slockCliPath ?? "";
    // #proj-raft-computer:#46: limits the OAR host records or releases reach this host's agents.
    this.lifecycleRecords.providerLimitLedger.subscribe((change) => this.onProviderLimitChange(change));
    this.turnActivity = new TurnActivitySnapshotWriter(opts.activitySnapshotPath ?? null);
    // task #166 (S6): a known count from the start (nothing runs yet), so a
    // server with no agents, or none active since boot, is quiet, not unknown.
    this.turnActivity.update(0);
    this.sendToServer = sendToServer;
    this.daemonApiKey = daemonApiKey;
    this.serverUrl = opts.serverUrl;
    this.slockHome = opts.slockHome ? path.resolve(opts.slockHome) : resolveRaftHome();
    this.#appInboxForAgent = opts.appInboxForAgent ?? null;
    this.#onAgentWorkingToIdle = opts.onAgentWorkingToIdle ?? null;
    this.#onRuntimeAbsentLocalStop = opts.onRuntimeAbsentLocalStop ?? null;
    this.#reportThirdPartyEventsDelivered = opts.reportThirdPartyEventsDelivered ?? reportThirdPartyEventsDelivered;
    this.#detectedRuntimeCliVersion = opts.detectedRuntimeCliVersion ?? (() => undefined);
    this.dataDir = opts.dataDir || resolveRaftHomePath("agents", this.slockHome);
    this.standingPromptLedger = new StandingPromptLedger(this.dataDir, () => this.clockNow());
    this.compactionFailureLedger = new SessionCompactionFailureLedger(this.dataDir);
    this.runtimeSessionHomeDir = opts.runtimeSessionHomeDir || os.homedir();
    this.readCredentialAccount = opts.credentialAccountReader ?? createCredentialAccountReader(ambientProcessEnv);
    this.driverResolver = opts.driverResolver || getDriver;
    this.defaultAgentEnvVarsProvider = opts.defaultAgentEnvVarsProvider || null;
    this.tracer = opts.tracer ?? noopTracer;
    this.daemonVersion = opts.daemonVersion?.trim() || null;
    this.daemonInstanceId = opts.daemonInstanceId?.trim() || null;
    this.runtimeProcessGate = opts.runtimeProcessGate ?? null;
    this.readRuntimeDescendants = opts.readRuntimeDescendants ?? defaultRuntimeDescendantReader;
    this.readSessionResumeFacts = opts.readSessionResumeFacts ?? readRuntimeSessionResumeFacts;
    this.computerVersion = opts.computerVersion?.trim() || null;
    this.workerUrl = opts.workerUrl?.trim() || null;
    this.fetchImpl = opts.fetchImpl ?? (daemonFetch as FetchLike);
    this.contextView = new AgentContextViewService({
      raftHome: this.slockHome,
      connectedServerId: opts.connectedServerId ?? (() => null),
      serverUrl: this.serverUrl,
      apiKey: daemonApiKey,
      fetchImpl: (url, init) => this.fetchImpl(url.toString(), init),
      sendToServer: (frame) => this.sendToServer(frame),
      agentFacts: (agentId) => this.contextViewAgentFacts(agentId),
      runningAgentIds: () => [...this.agents.keys(), ...(this.hostedSessions?.agentIds() ?? [])],
      recordTrace: (name, attrs, status) => this.recordDaemonEvent(name, attrs, status),
    });
    this.serverConnected = opts.serverConnected ?? (() => true);
    this.queuedInputSettleMs = Math.max(0, Math.floor(opts.queuedInputSettleMs ?? QUEUED_INPUT_SETTLE_MS));
    this.specHandbacks = new SpecHandbacks(() => this.clockNow(), {
      deadlineMs: opts.specHandbackDeadlineMs,
      onDeadline: (agentId) => this.reportSpecHandbackDeadline(agentId),
    });
    this.stdinNotificationRetryMs = Math.max(
      0,
      Math.floor(opts.stdinNotificationRetryMs ?? STDIN_NOTIFICATION_RETRY_DELAY_MS),
    );
    this.stopKill = {
      graceMs: Math.max(0, Math.floor(opts.stopKill?.graceMs ?? AGENT_STOP_KILL_GRACE_MS)),
      confirmMs: Math.max(0, Math.floor(opts.stopKill?.confirmMs ?? AGENT_STOP_KILL_CONFIRM_MS)),
    };
    this.orphanReapDeps = { graceMs: this.stopKill.graceMs, confirmMs: this.stopKill.confirmMs, ...opts.orphanReap };
    this.runtimeProcessLedgerDeps = opts.runtimeProcessLedger ?? {};
    this.sessionReadyDeliveryRetryMs = Math.max(
      0,
      Math.floor(opts.sessionReadyDeliveryRetryMs ?? SESSION_READY_DELIVERY_RETRY_DELAY_MS),
    );
    this.runtimeErrorDeliveryBackoffBaseMs = Math.max(
      0,
      Math.floor(opts.runtimeErrorDeliveryBackoff?.baseMs ?? RUNTIME_ERROR_DELIVERY_BACKOFF_BASE_MS),
    );
    this.runtimeErrorDeliveryBackoffMaxMs = Math.max(
      this.runtimeErrorDeliveryBackoffBaseMs,
      Math.floor(opts.runtimeErrorDeliveryBackoff?.maxMs ?? RUNTIME_ERROR_DELIVERY_BACKOFF_MAX_MS),
    );
    this.runtimeErrorDeliveryBackoffJitterRatio = Math.max(
      0,
      Math.min(1, opts.runtimeErrorDeliveryBackoff?.jitterRatio ?? 0.1),
    );
    this.runtimeErrorDeliveryBackoffJitterRandom = opts.runtimeErrorDeliveryBackoff?.jitterRandom
      ?? (() => randomInt(1_000_000) / 1_000_000);
    this.runtimeErrorDeliveryBackoffFailPointForTesting = opts.runtimeErrorDeliveryBackoff?.failPointForTesting ?? null;
    this.agentStarts = new AgentStartCoordinator({
      maxConcurrentStarts: opts.runtimeStartScheduler?.maxConcurrentStarts
        ?? readPositiveIntegerEnv("SLOCK_DAEMON_MAX_CONCURRENT_AGENT_STARTS", DEFAULT_MAX_CONCURRENT_AGENT_STARTS),
      minStartIntervalMs: opts.runtimeStartScheduler?.minStartIntervalMs
        ?? readNonNegativeIntegerEnv("SLOCK_DAEMON_AGENT_START_INTERVAL_MS", DEFAULT_AGENT_START_INTERVAL_MS),
    });
    this.agentStartDispatch = new AgentStartDispatchProjection(
      this.agentStarts,
      () => this.clockNow(),
      (config) => this.runtimeLaunchPolicyTraceAttrs(config),
    );
    this.coldIdleSweepTimer = setInterval(
      () => void this.sweepColdIdleRuntimes(),
      readPositiveIntegerEnv("RAFT_WAKE_RECYCLE_SWEEP_MS", COLD_IDLE_SWEEP_MS),
    );
    this.coldIdleSweepTimer.unref?.();
  }

  /**
   * The 10-minute sweep: every live process is decided again by the one
   * reconcile entry (trigger `sweep`: spec drift, then cold idle), then its
   * silent background tasks are checked. Only a backstop for the spec: each
   * idle fact that flips re-decides it at once, so a spec stop traced with
   * trigger "sweep" means an entry is missing. For cold idle it is the
   * natural entry: a process turns cold by time passing, with no event.
   */
  private async sweepColdIdleRuntimes(): Promise<void> {
    try {
      const steps = [...this.agents].map(([agentId, ap]) => this.reconcileProcess(agentId, ap, "sweep").cold);
      await this.recordColdIdleSweep(steps);
    } finally {
      // Every live agent, whatever its cold-idle eligibility.
      await this.sweepSilentBackgroundTasks();
    }
  }

  /**
   * RFC 070 observability: one event per sweep with how many processes each
   * cold-idle gate held, once the transcript reads the sweep started (or
   * found in flight) have answered, so "the sweep never stops anything"
   * shows which gate it is. `stops` counts the cold-idle stops these reads
   * made (a spec stop is `skipped_spec_drift`).
   */
  private async recordColdIdleSweep(steps: readonly ColdIdleStep[]): Promise<void> {
    if (steps.length === 0) return;
    const outcomes = await Promise.all(steps.map((step) => step.kind === "checking" ? step.outcome : step.reason));
    const skipped: Record<string, number> = {};
    for (const outcome of outcomes) if (outcome !== "stopped") skipped[outcome] = (skipped[outcome] ?? 0) + 1;
    this.recordDaemonEvent("daemon.agent.cold_idle_sweep", {
      views: steps.length,
      stops: outcomes.filter((outcome) => outcome === "stopped").length,
      ...Object.fromEntries(Object.entries(skipped).map(([reason, n]) => [`skipped_${reason}`, n])),
    });
  }

  /**
   * A background task no event has named for BACKGROUND_TASK_SILENT_MS lost
   * its end event, unless the runtime still runs a process started since the
   * task did (backgroundTaskHealth.ts). One that is presumed ended leaves the
   * set as a natural end would, minus the wake: there is no result to read.
   */
  private async sweepSilentBackgroundTasks(): Promise<void> {
    await Promise.all([...this.agents.entries()].map(async ([agentId, ap]) => {
      if (ap.exit.kind !== "live" || this.backgroundTaskChecks.has(agentId)) return;
      if (silentBackgroundTasks(ap.backgroundTasks, this.clockNow()).length === 0) return;
      this.backgroundTaskChecks.add(agentId);
      const evidence = await readDescendantEvidence(ap.runtime.pid, this.readRuntimeDescendants)
        .finally(() => this.backgroundTaskChecks.delete(agentId));
      if (this.agents.get(agentId) !== ap || ap.exit.kind !== "live") return;
      // Re-read after the tree read: an event since then keeps a task.
      const nowMs = this.clockNow();
      let removed = 0;
      for (const { taskId, task, silentMs } of silentBackgroundTasks(ap.backgroundTasks, nowMs)) {
        const verdict = silentTaskVerdict(task, evidence);
        if (verdict.remove) {
          ap.backgroundTasks.delete(taskId);
          removed += 1;
        } else if (shouldTraceKeptCandidate(task, nowMs)) {
          task.presumedEndedTracedAtMs = nowMs;
        } else {
          continue;
        }
        this.recordDaemonEvent("daemon.runtime.background_task.presumed_ended", {
          agentId,
          launchId: ap.launchId || undefined,
          runtime: ap.config.runtime,
          task_kind: task.taskKind,
          subagent_type: task.subagentType,
          age_ms: nowMs - task.startedAtMs,
          silent_ms: silentMs,
          removed: verdict.remove,
          // Unknown (omitted) when the tree could not be read.
          ...(verdict.treeUnreadable ? { tree_unreadable: true } : { descendants_alive: verdict.descendantsAlive }),
          background_tasks_outstanding: ap.backgroundTasks.size,
        });
      }
      if (removed === 0) return;
      if (this.mainTurnIsQuiet(ap)) this.broadcastQuietTurnStatus(agentId, ap);
      if (ap.backgroundTasks.size === 0) this.reconcile(agentId, ap, "background_tasks_done");
    }));
  }

  /**
   * Stop an idle process on purpose, keeping its session (the next wake
   * resumes it, unless sessionIdAfterExit leaves none, or chooses a new one
   * for a cold session): the cold-idle stop and the runtime spec restart,
   * both decided by `reconcile`, and the warm-recycle stop (`stopForWarmRecycle`).
   * All stop with the reason `cold_idle_recycle`, which is what the exit path
   * (and the credential hold it renews) reads; `path` only names the stop in
   * its traces. The told-history mark taken first keeps a message told to the
   * process after this point from reading as a deferral at its close.
   */
  private beginColdIdleRecycleStop(agentId: string, ap: AgentProcess, label: string, path: "cold_idle_recycle" | "spec_restart" | "warm_recycle"): void {
    // The first stop's mark stands: a second stop before the exit (reconcile
    // makes none: it skips a process already being stopped) must not move it
    // past messages told in between.
    ap.coldIdleStopToldMark ??= ap.notifications.contributionMark();
    // RFC 070 §6.5: another stop (a spec restart, the cold-idle stop) ends a pending warm mark.
    if (path !== "warm_recycle") this.warmRecycle.dropPending(agentId);
    this.commitGatedSteeringDecisionState(agentId, ap, reduceApmColdIdleRecycleTermination(ap.gatedSteering).nextState);
    logger.info(`[Agent ${agentId}] ${label} stop: SIGTERM, SIGKILL of the process tree after ${this.stopKill.graceMs}ms`);
    // The process stays in `agents` until its close: that is where it is released.
    void this.stopRuntimeProcess(agentId, ap.runtime, path, { reason: "cold_idle_recycle", launchId: ap.launchId });
  }

  setTracer(tracer: Tracer): void {
    this.tracer = tracer;
  }

  setCliTransportTraceDir(traceDir: string | null): void {
    this.cliTransportTraceDir = traceDir;
  }

  setMachineDir(machineDir: string | null): void {
    this.machineDir = machineDir;
  }

  /**
   * Reconciler step 5: the runner's machine dir is known (its lock is held):
   * open the ledger of spawned runtime processes and reap what a previous
   * daemon left in it. Independent of local tracing: runtimes spawn detached
   * whether or not traces are written. Once per manager.
   */
  startRuntimeProcessLedger(machineDir: string): void {
    if (!this.runtimeProcessLedger) this.startOrphanSweep(machineDir);
  }

  /** `raft proc` (procJobs.ts): the agent's recorded runtime processes, as the runtime ledger has them. */
  runtimeProcessesForAgent(agentId: string): Array<{ pid: number; startIdentity: string; launchId: string | null }> {
    return (this.runtimeProcessLedger?.recordsForAgent(agentId) ?? [])
      .map((record) => ({ pid: record.pid, startIdentity: record.startIdentity, launchId: record.launchId }));
  }

  /** `raft proc` (procJobs.ts): which children of this daemon are jobs, not runtimes. */
  setProcJobPidFilter(ownsPid: ((pid: number) => boolean) | null): void {
    this.procJobOwnsPid = ownsPid;
  }

  /**
   * Reconciler step 5: reap the runtimes a previous daemon of this runner
   * left running (a crash, a SIGKILL): their groups outlive it. Runs in the
   * background from the moment the machine dir is known, before any start;
   * every start, on either host, waits for it (`runtimeExited`).
   */
  private startOrphanSweep(machineDir: string): void {
    const ledger = RuntimeProcessLedger.inMachineDir(machineDir, {
      ...this.runtimeProcessLedgerDeps,
      isForeignChild: (pid) => this.procJobOwnsPid?.(pid) ?? false,
    });
    this.runtimeProcessLedger = ledger;
    // A `raft proc` job an older record names is adopted by the job manager, never reaped here.
    const leftover = filterProcJobsFromRuntimeRecords(machineDir, ledger.takeLeftover());
    if (leftover.length === 0) {
      ledger.keep([]);
      return;
    }
    this.orphanSweepPending = true;
    this.orphanSweep = reapRecordedOrphans(leftover, this.orphanReapDeps).then((result) => {
      // What could not be confirmed gone stays recorded for the next daemon.
      ledger.keep(result.stillAlive);
      this.recordDaemonEvent("daemon.agent.orphan.reaped", {
        recorded_count: result.recorded,
        reaped_count: result.reaped.length,
        escalated_count: result.escalated.length,
        still_alive_count: result.stillAlive.length,
        skipped_count: result.skipped,
        pids: result.reaped.join(","),
        still_alive_pids: result.stillAlive.map((record) => record.pid).join(","),
        agent_count: new Set(leftover.map((record) => record.agentId)).size,
      }, result.stillAlive.length > 0 ? "error" : "ok");
      if (result.reaped.length > 0 || result.stillAlive.length > 0) {
        logger.warn(`[Slock Daemon] Reaped ${result.reaped.length} runtime process(es) a previous daemon left running`
          + `${result.stillAlive.length > 0 ? `; ${result.stillAlive.length} not seen to exit` : ""}`);
      }
    }).finally(() => {
      this.orphanSweepPending = false;
    });
  }

  /**
   * Daemon stop, after every agent stopped: the orphan sweep and every
   * ledger update still reading process identities have written the ledger,
   * so nothing writes into the machine dir once the stop resolves.
   */
  async settleRuntimeProcessLedger(): Promise<void> {
    await this.orphanSweep?.catch(() => {});
    await this.runtimeProcessLedger?.settled();
  }

  /** Reconciler step 5: an OAR session of the agent opened; its runtime (whose pid OAR keeps) is recorded. */
  noteOarRuntimeOpened(agentId: string, launchId: string | null): void {
    void this.runtimeProcessLedger?.recordUnrecordedChildren({ agentId, launchId });
  }

  /** Reconciler step 5: an OAR session of the agent was disposed; its runtime's record goes once it is gone. */
  noteOarRuntimeClosed(agentId: string): void {
    void this.runtimeProcessLedger?.pruneGone(agentId);
  }

  private assertStartPendingDeliveryInvariants(context: string): void {
    this.repairNonresidentRuntimeErrorFingerprintFences(context);
    this.repairNoProcessResidency(context);
    const residencySnapshot = this.noProcessResidencySnapshot();
    AgentNoProcessResidency.assertInvariants(context, residencySnapshot);
    this.lifecycleRecords.assertInvariants(context, this.agentLifecycleRecordSnapshot());
    this.startingInboxes.assertInvariants(
      context,
      AgentNoProcessResidency.allowedStartPendingSnapshot(residencySnapshot),
    );
  }

  /**
   * Repair no-process residency facts that drifted out of I2/I4 before the
   * global assertion runs (task #1102). The assertion below is a manager-wide
   * fail-closed gate: one agent's stale fact used to make EVERY agent's
   * read/history/send fail with LOCAL_DAEMON_STATE_INVALID until a daemon
   * restart (field: two machines, 2026-09-13). A stale fact is a bug in the
   * writer, so each repair is logged at error level and traced; it must never
   * become the silent normal path.
   *
   * - I4: pending start-delivery for an agent with no queued/starting/terminal/
   *   cooldown residency is dropped. The Server still holds the messages; the
   *   agent receives them as unread context on its next wake.
   * - I2: terminal failure coexisting with an idle restart config keeps the
   *   wakeable fact (restart config) and retires the terminal failure, so the
   *   next delivery restarts the agent instead of silently refusing.
   */
  private repairNoProcessResidency(context: string): void {
    const residencySnapshot = this.noProcessResidencySnapshot();
    const idle = new Set(residencySnapshot.idleAgentIds);
    for (const agentId of residencySnapshot.terminalFailureAgentIds) {
      if (!idle.has(agentId)) continue;
      this.lifecycleRecords.deleteTerminalFailure(agentId);
      logger.error(`[Agent ${agentId}] Repaired residency: terminal failure and idle restart config both present after ${context}; kept restart config`);
      this.recordDaemonEvent("daemon.agent.residency.repaired", {
        agentId,
        context,
        repair: "terminal_idle_overlap",
        kept: "idle_restart_config",
      }, "error");
    }

    const allowedPending = AgentNoProcessResidency.allowedStartPendingSnapshot(this.noProcessResidencySnapshot());
    const allowed = new Set<string>([
      ...allowedPending.queuedAgentIds,
      ...allowedPending.startingAgentIds,
      ...allowedPending.terminalRecoveryAgentIds,
      ...allowedPending.cooldownAgentIds,
    ]);
    for (const agentId of this.startingInboxes.agentIds()) {
      if (allowed.has(agentId)) continue;
      const droppedCount = this.startingInboxes.count(agentId);
      this.startingInboxes.cancelStart(agentId);
      logger.error(`[Agent ${agentId}] Repaired residency: dropped ${droppedCount} orphan pending delivery message(s) without residency after ${context}`);
      this.recordDaemonEvent("daemon.agent.residency.repaired", {
        agentId,
        context,
        repair: "orphan_pending_delivery",
        dropped_count: droppedCount,
      }, "error");
    }
  }

  private noProcessResidencySnapshot(): AgentNoProcessResidencySnapshot {
    const startSnapshot = this.agentStarts.snapshot();
    const now = this.clockNow();
    return {
      runningAgentIds: [...this.agents.keys()],
      queuedAgentIds: startSnapshot.queuedAgentIds,
      startingAgentIds: startSnapshot.startingAgentIds,
      idleAgentIds: [...this.lifecycleRecords.restartSnapshotAgentIds()],
      terminalFailureAgentIds: [...this.lifecycleRecords.terminalFailureAgentIds()],
      activeCooldownAgentIds: this.lifecycleRecords.activeSpawnFailBackoffAgentIds(
        now,
        (state, currentTime) => state.untilMs > currentTime,
      ),
      fingerprintFenceAgentIds: [...this.lifecycleRecords.runtimeErrorFingerprintFenceAgentIds()],
      pendingDeliveryAgentIds: this.startingInboxes.agentIds(),
    };
  }

  private agentLifecycleRecordSnapshot(): AgentLifecycleRecordSnapshot<RuntimeErrorDeliveryBackoffState, RuntimeErrorFingerprintFenceState> {
    const startSnapshot = this.agentStarts.snapshot();
    const now = this.clockNow();
    return this.lifecycleRecords.snapshot({
      runningAgentIds: [...this.agents.keys()],
      queuedAgentIds: startSnapshot.queuedAgentIds,
      startingAgentIds: startSnapshot.startingAgentIds,
      now,
      isSpawnFailBackoffActive: (state, currentTime) => state.untilMs > currentTime,
    });
  }

  private agentLifecycleRecord(agentId: string): AgentLifecycleRecord<RuntimeErrorDeliveryBackoffState, RuntimeErrorFingerprintFenceState> | undefined {
    return buildAgentLifecycleRecords(this.agentLifecycleRecordSnapshot()).get(agentId);
  }

  private getVisibleBoundary(agentId: string, target: string): number | undefined {
    return this.agentVisibleDelivery.getBoundary(agentId, target);
  }

  private getVisibleMessageIdSet(agentId: string, target: string): Set<string> | undefined {
    return this.agentVisibleDelivery.getMessageIdSet(agentId, target);
  }

  private isVisibleMessageModelSeen(agentId: string, target: string, message: { seq?: number; message_id?: string; id?: string }): boolean {
    return this.agentVisibleDelivery.isModelSeen(agentId, target, message);
  }

  /**
   * The RFC 072 context signal the CLI also honours (`enabledContextSignal`):
   * under passive AX, the id of the model context this process is in (null
   * when it could not be published); otherwise none, and evidence stays
   * process-wide.
   */
  private freshnessContext(agentId: string): { contextId: string | null } | undefined {
    const ap = this.agents.get(agentId);
    return ap?.passiveAx ? { contextId: ap.contextId } : undefined;
  }

  private visibleFreshnessView(agentId: string): AgentVisibleFreshnessView {
    return this.agentVisibleDelivery.freshnessView(agentId, this.freshnessContext(agentId));
  }

  private projectThreadJoinContextsForRuntimeInput(
    agentId: string,
    messages: readonly AgentMessage[],
    renderContext = true,
  ): { messages: AgentMessage[]; renderedContextMessages: AgentMessage[] } {
    return projectThreadJoinContextsForRuntimeInput(
      messages,
      (target) => this.getVisibleBoundary(agentId, target),
      renderContext,
    );
  }

  private recordRenderedThreadJoinContextReceipts(
    agentId: string,
    messages: readonly AgentMessage[],
  ): void {
    for (const receipt of threadJoinContextReceipts(messages)) {
      this.consumeVisibleMessages(agentId, receipt);
    }
  }

  // ----- SPAWN-FAIL BACKOFF (per-agent) ----------------------------------
  // Anchored at auto_restart_from_idle (apm:3596) + runtime_profile_auto_restart (apm:4137).
  // One outer spawn failure enters cooldown immediately so repeated wakes cannot burn one
  // full spawn attempt per delivery. Runner credential mint failures keep a longer cooldown
  // because one outer failure already means the inner credential-mint loop exhausted
  // RUNNER_CREDENTIAL_MINT_MAX_ATTEMPTS.
  // Successful spawn resets state. State lives outside AgentProcess because spawn fails BEFORE
  // ap exists and the rate-window must persist across stop/respawn (else stop/start churn
  // bypasses the cap — CC1 lifecycle pattern). Never advances any consume cursor or model-seen
  // state (3-cursor orthogonality with CC1/CC2).
  private getOrCreateSpawnFailBackoff(agentId: string): RuntimeErrorDeliveryBackoffState {
    return this.lifecycleRecords.getOrCreateSpawnFailBackoff(agentId, createRuntimeErrorDeliveryBackoffState);
  }

  private isSpawnFailBackoffActive(agentId: string): boolean {
    const state = this.lifecycleRecords.getSpawnFailBackoff(agentId);
    if (!state) return false;
    return state.untilMs > 0 && this.clockNow() < state.untilMs;
  }

  private clockNow(): number {
    return this.frozenClockMs ?? this.readWallClock();
  }

  /** Test seam for the wall clock; production reads Date.now(). */
  private readWallClock(): number {
    return Date.now();
  }

  /** Task #355: run a synchronous routing step so that every clock read inside
   * it (the routing decision, the invariant repair, the residency entry) sees
   * the same instant. Without this, a cooldown that expires between two reads
   * is "active" to the router and "gone" to the repair, and the repair drops
   * the deliveries the router just buffered. */
  private withClockFrozen<T>(nowMs: number, fn: () => T): T {
    const previous = this.frozenClockMs;
    this.frozenClockMs = nowMs;
    try {
      return fn();
    } finally {
      this.frozenClockMs = previous;
    }
  }

  private recordSpawnFailure(agentId: string, reason: string): { backoffActive: boolean; attempts: number; untilMs: number } {
    const state = this.getOrCreateSpawnFailBackoff(agentId);
    state.attempts += 1;
    state.reason = reason;
    const isRunnerCredentialMint = reason === "runner_credential_mint";
    const threshold = isRunnerCredentialMint
      ? RUNNER_CREDENTIAL_MINT_BACKOFF_THRESHOLD
      : SPAWN_FAIL_BACKOFF_THRESHOLD;
    const baseMs = isRunnerCredentialMint
      ? RUNNER_CREDENTIAL_MINT_BACKOFF_BASE_MS
      : SPAWN_FAIL_BACKOFF_BASE_MS;
    const maxMs = isRunnerCredentialMint
      ? RUNNER_CREDENTIAL_MINT_BACKOFF_MAX_MS
      : SPAWN_FAIL_BACKOFF_MAX_MS;
    if (state.attempts <= threshold) {
      // Below threshold: do NOT enter cooldown. Generic spawn failures use threshold 0,
      // so this branch is currently only for future non-immediate reasons.
      state.untilMs = 0;
      return { backoffActive: false, attempts: state.attempts, untilMs: 0 };
    }
    const baseDelay = crashStreakBackoffMs(state.attempts - threshold, { baseMs, maxMs, jitterRatio: 0, jitterUnit: 0 });
    state.untilMs = this.clockNow() + Math.floor(baseDelay);
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => this.onSpawnFailBackoffExpired(agentId), Math.max(1, state.untilMs - this.clockNow()));
    return { backoffActive: true, attempts: state.attempts, untilMs: state.untilMs };
  }

  /**
   * A start timed out and its process is gone. Count it toward the local
   * spawn-fail backoff, seeded from the start-timeout streak (a successful
   * spawn in between reset the backoff, not the streak), so daemon-local
   * restarts back off. After CRASH_STREAK_CAP in a row, stop restarting
   * locally: those restarts reuse one launch, which the server counts once;
   * every server start is a new launch its wake breaker counts.
   */
  private backOffAfterStartTimeout(agentId: string): void {
    const streak = (this.startTimeoutStreaks.get(agentId) ?? 0) + 1;
    this.startTimeoutStreaks.set(agentId, streak);
    const snapshot = this.lifecycleRecords.getRestartSnapshot(agentId);
    if (!snapshot) return;
    if (crashStreakExhausted(streak)) {
      this.lifecycleRecords.deleteRestartSnapshot(agentId);
      this.resetSpawnFailBackoff(agentId, "terminal");
      const dropped = this.startingInboxes.count(agentId);
      this.startingInboxes.cancelStart(agentId);
      logger.warn(`[Agent ${agentId}] Local restarts stopped after ${streak} start timeouts in a row; ${dropped} buffered delivery(ies) left to the Server`);
      this.recordDaemonEvent("daemon.agent.spawn.local_restart_stopped", {
        agentId,
        launchId: snapshot.launchId || undefined,
        runtime: snapshot.config.runtime,
        source: "startup_timeout",
        failure_reason: "runtime_start_timeout",
        stop_cause: "attempts_exhausted",
        attempts: streak,
        dropped_count: dropped,
      }, "error");
      return;
    }
    const state = this.getOrCreateSpawnFailBackoff(agentId);
    state.attempts = Math.max(state.attempts, streak - 1);
    const report = this.recordSpawnFailure(agentId, "runtime_start_timeout");
    if (report.backoffActive) {
      this.enterSpawnFailCooldownResidency(agentId, snapshot, report.untilMs, "startup_timeout", "runtime_start_timeout");
    }
    this.recordDaemonEvent("daemon.agent.spawn.fail_backoff", {
      agentId,
      source: "startup_timeout",
      reason: "runtime_start_timeout",
      attempts: report.attempts,
      start_timeout_count: streak,
      cooldown_active: report.backoffActive,
      until_ms: report.untilMs,
    });
  }

  private onSpawnFailBackoffExpired(agentId: string): void {
    const s = this.lifecycleRecords.getSpawnFailBackoff(agentId);
    if (!s) return;
    s.timer = null;
    s.untilMs = 0;
    // Task #355: deliveries buffered during the cooldown were promised a spawn
    // ("only delays the spawn, never drops"). Nothing else hands them over when
    // the cooldown ends, and the next invariant check would drop them as orphans
    // of an idle agent, so start the agent from its pending inbox here.
    const restartSnapshot = this.lifecycleRecords.getRestartSnapshot(agentId);
    const hasPendingWithoutProcess = this.startingInboxes.has(agentId)
      && !this.agents.has(agentId)
      && !this.agentStarts.hasQueued(agentId)
      && !this.agentStarts.hasStarting(agentId);
    if (restartSnapshot && hasPendingWithoutProcess) {
      this.lifecycleRecords.deleteRestartSnapshot(agentId);
      logger.info(`[Agent ${agentId}] Spawn-fail cooldown ended with ${this.startingInboxes.count(agentId)} buffered delivery(ies); starting from pending inbox`);
      this.recordDaemonEvent("daemon.agent.spawn_fail_cooldown.expired_restart", {
        agentId,
        launchId: restartSnapshot.launchId || undefined,
        pending_count: this.startingInboxes.count(agentId),
      });
      this.startAgent(agentId, restartSnapshot.config, undefined, undefined, undefined, restartSnapshot.launchId || undefined).then(
        () => this.resetSpawnFailBackoff(agentId),
        (err) => {
          logger.error(`[Agent ${agentId}] Failed to start from pending inbox after spawn-fail cooldown`, err);
          this.lifecycleRecords.setRestartSnapshot(agentId, restartSnapshot);
          const report = this.recordSpawnFailure(agentId, "spawn_error");
          if (this.stopLocalRestartAfterFailure(agentId, restartSnapshot, err, report.attempts, "spawn_fail_cooldown_expired")) return;
          if (report.backoffActive) {
            this.enterSpawnFailCooldownResidency(agentId, restartSnapshot, report.untilMs, "spawn_fail_cooldown_expired", "spawn_error");
          }
        },
      );
    }
    this.closeNoProcessResidency(agentId, "timeout", { negativeEvidenceBucket: "spawn_fail_cooldown_expired" });
  }

  private resetSpawnFailBackoff(agentId: string, closeResult: AgentNoProcessResidencyCloseResult = "advanced"): void {
    const state = this.lifecycleRecords.getSpawnFailBackoff(agentId);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    this.lifecycleRecords.deleteSpawnFailBackoff(agentId);
    this.closeNoProcessResidency(agentId, closeResult, { negativeEvidenceBucket: "spawn_fail_cooldown_reset" });
  }

  private armRuntimeErrorProcessRestart(
    agentId: string,
    ap: AgentProcess,
    reason: string,
    queuedWakeMessage: AgentMessage,
    bufferedRestartMessages: AgentMessage[],
    attempts: number,
    delayMs: number,
  ): void {
    const nextConfig = this.buildRestartSafeConfig(ap.config, ap.sessionId);
    const cached = {
      config: nextConfig,
      sessionId: ap.sessionId,
      launchId: ap.launchId,
      processInstanceId: ap.processInstanceId,
    };
    // Consecutive crashes grow the delay (10s, 20s, 40s ...; planExit's crash
    // streak, which lives in lifecycleRecords, not on `ap`, because each
    // crash replaces the process). With a fixed first attempt a runtime that
    // cannot reach its provider respawned every ~10s forever (AndyLok,
    // daemon 1.0.53: 760 cursor crashes in ~2h); it now backs off to the
    // policy's max (5 min) and keeps trying: a provider outage is not capped
    // (reconciler step 10a, D3; the cap counts every other crash).
    const untilMs = this.clockNow() + delayMs;
    const stopEpochAtSchedule = this.lifecycleRecords.stopEpoch(agentId);

    this.cancelRuntimeErrorProcessRestart(agentId);
    this.lifecycleRecords.setRestartSnapshot(agentId, cached);
    this.lifecycleRecords.deleteTerminalFailure(agentId);

    const previousCooldownState = this.lifecycleRecords.getSpawnFailBackoff(agentId);
    if (previousCooldownState?.kind === "backing_off" && previousCooldownState.timer) {
      clearTimeout(previousCooldownState.timer);
    }

    const timer = setClockTimeout(() => {
      if (this.lifecycleRecords.stopEpochChanged(agentId, stopEpochAtSchedule)) {
        this.cancelRuntimeErrorProcessRestart(agentId);
        return;
      }
      this.runtimeErrorProcessRestartTimers.delete(agentId);
      const currentCooldown = this.lifecycleRecords.getSpawnFailBackoff(agentId);
      if (currentCooldown !== cooldownState) return;
      if (this.agents.has(agentId) || this.agentStarts.hasQueued(agentId) || this.agentStarts.hasStarting(agentId)) return;

      this.lifecycleRecords.deleteSpawnFailBackoff(agentId);
      this.closeNoProcessResidency(agentId, "timeout", { negativeEvidenceBucket: "runtime_error_process_backoff_elapsed" });
      const restartSnapshot = this.lifecycleRecords.getRestartSnapshot(agentId);
      if (!restartSnapshot) return;
      this.lifecycleRecords.deleteRestartSnapshot(agentId);
      this.lifecycleRecords.setPendingSpawnCause(agentId, "restart_crash");
      const startPromise = this.startAgent(agentId, restartSnapshot.config, undefined, undefined, undefined, restartSnapshot.launchId || undefined);
      startPromise.catch((err) => {
        logger.error(`[Agent ${agentId}] Failed to restart after recoverable runtime error`, err);
        this.lifecycleRecords.setRestartSnapshot(agentId, restartSnapshot);
        this.sendAgentStatus(agentId, "inactive", restartSnapshot.launchId);
        this.broadcastActivity(agentId, "offline", "Runtime retry failed after recoverable provider error", [], restartSnapshot.launchId, "runtime_crashed");
      });
    }, Math.max(1, untilMs - this.clockNow())) as ReturnType<typeof setTimeout>;
    // The spawn-fail state keeps counting spawn failures only (a failed spawn
    // after this cooldown must not inherit the crash streak toward
    // CRASH_STREAK_CAP); the crash streak is reported on the event.
    const cooldownState: RuntimeErrorDeliveryBackoffState = {
      kind: "backing_off",
      attempts: 1,
      reason,
      untilMs,
      timer,
    };
    this.lifecycleRecords.activeSpawnFailBackoffs.set(agentId, cooldownState);
    timer.unref?.();
    this.runtimeErrorProcessRestartTimers.set(agentId, timer);
    this.startingInboxes.bufferMessagesDuringStart(agentId, [
      queuedWakeMessage,
      ...bufferedRestartMessages,
    ]);
    this.assertStartPendingDeliveryInvariants("recoverable-runtime-close-pending-inbox");

    this.enterSpawnFailCooldownResidency(agentId, { config: nextConfig, launchId: ap.launchId }, untilMs, "recoverable_runtime_error_process_close", reason);
    this.recordDaemonEvent("daemon.agent.runtime_error_process_restart.scheduled", {
      agentId,
      runtime: ap.config.runtime,
      model: ap.config.model,
      launchId: ap.launchId || undefined,
      reason,
      attempts,
      delay_ms: delayMs,
      until_ms: untilMs,
      inbox_count: 1 + bufferedRestartMessages.length,
      session_id_present: Boolean(ap.sessionId),
      restart_trigger: "timer",
    });
    this.sendAgentStatus(agentId, "active", ap.launchId);
  }

  /**
   * A recoverable close with nothing queued. The first one keeps the agent
   * wakeable as before; from the second in a row (planExit's
   * `holdNextWakeMs`) the next delivery is held (buffered by the idle
   * cooldown gate) until the crash backoff ends, and the spawn-fail expiry
   * starts the agent from that buffer. Returns the delay, or null when no
   * backoff applies.
   */
  private holdDeliveriesAfterRecoverableClose(agentId: string, ap: AgentProcess, reason: string, attempts: number, delayMs: number | undefined): number | null {
    if (delayMs === undefined) return null;
    const untilMs = this.clockNow() + delayMs;
    this.cancelRuntimeErrorProcessRestart(agentId);
    const previous = this.lifecycleRecords.getSpawnFailBackoff(agentId);
    if (previous?.timer) clearTimeout(previous.timer);
    const timer = setTimeout(() => this.onSpawnFailBackoffExpired(agentId), Math.max(1, delayMs));
    timer.unref?.();
    this.lifecycleRecords.activeSpawnFailBackoffs.set(agentId, { kind: "backing_off", attempts: 1, reason, untilMs, timer });
    this.enterSpawnFailCooldownResidency(agentId, { config: this.buildRestartSafeConfig(ap.config, ap.sessionId), launchId: ap.launchId }, untilMs, "recoverable_runtime_error_process_close", reason);
    this.recordDaemonEvent("daemon.agent.runtime_error_process_restart.scheduled", {
      agentId,
      runtime: ap.config.runtime,
      model: ap.config.model,
      launchId: ap.launchId || undefined,
      reason,
      attempts,
      delay_ms: delayMs,
      until_ms: untilMs,
      inbox_count: 0,
      session_id_present: Boolean(ap.sessionId),
      restart_trigger: "next_delivery",
    });
    return delayMs;
  }

  /**
   * Model output proves the provider is reachable again. An empty thinking
   * marker (task #386: Codex, Copilot, Kimi, OpenCode and Pi emit one at every
   * turn start) is not output, and a subagent may run on another model, so
   * neither resets the streak; same rule as the rate-limit backoff.
   */
  private resetRuntimeErrorCloseStreakAfterModelOutput(agentId: string, ap: AgentProcess, progressKind: string, fromSubagent: boolean): void {
    if (fromSubagent || !RATE_LIMIT_BACKOFF_CLEARING_PROGRESS.has(progressKind)) return;
    ap.modelOutputObserved = true;
    // Reconciler step 12: the runtime can use its model after all.
    this.lifecycleRecords.exitStreaks.sticky.forgetUnusableModel(agentId);
    this.lifecycleRecords.deleteResumedEarlyCrashStreak(agentId);
    this.resetStalledReplacementStreak(agentId);
    this.resetRuntimeErrorCloseStreak(agentId, `runtime_progress:${progressKind}`, ap);
  }

  /**
   * The generic resume fallback (planExit's early-crash rule): this exit of a
   * launch that resumed a stored session crashed early with no model output
   * and counted; `chooseSession` decided whether the next start is fresh.
   */
  private traceResumedEarlyCrash(agentId: string, ap: AgentProcess, plan: ExitPlan, code: number | null): void {
    const resumedSessionId = ap.resumeSessionId;
    if (!plan.earlyCrashCounted || !resumedSessionId) return;
    const fellBackFresh = plan.session.kind === "new" && plan.session.reason === "resume_failed";
    const consecutive = fellBackFresh ? plan.sessionFacts.resumeFailure?.earlyCrashes ?? 0 : plan.resumeFailures?.count ?? 0;
    const diagnostics = ap.lastRuntimeError ? buildRuntimeErrorDiagnosticEnvelope(ap.lastRuntimeError) : null;
    this.recordDaemonEvent("daemon.runtime.resume_failed", {
      ...this.processLifecycleIdentityAttrs(agentId, ap),
      // The session the launch resumed. Same convention as
      // processLifecycleIdentityAttrs: the daemon's only trace sink
      // (LocalRotatingTraceSink, trace-client sanitizeAttrs) writes it as a
      // machine-scoped `session_id_hash`, never in the clear, and the uploader
      // ships those files.
      session_id: resumedSessionId,
      session_id_present: true,
      consecutive_count: consecutive,
      threshold: RESUME_FAILURE_THRESHOLD,
      fell_back_fresh: fellBackFresh,
      exit_code: code,
      uptime_ms_bucket: bucketMs(Date.now() - ap.spawnedAtMs),
      last_event_kind: ap.lastActivityKind || undefined,
      runtime_error_class: diagnostics?.spanAttrs.runtime_error_class,
      runtime_error_fingerprint: diagnostics?.spanAttrs.runtime_error_fingerprint,
    }, "error");
  }

  /**
   * Reconciler step 10a: the facts of a process exit for `planExit`, read
   * once (after the close recorded an invalid credential it found), and what
   * acting on the plan needs besides.
   */
  private exitContextOf(
    agentId: string,
    ap: AgentProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
    turnBoundarySatisfied: boolean,
  ): ExitContext {
    const expectedTerminationReason = ap.gatedSteering.expectedTerminationReason;
    const stickyTerminalFailureDetail = classifyStickyFailure(ap);
    const failureDetail = stickyTerminalFailureDetail ?? classifyTerminalFailure(ap);
    const crashReason = formatCrashReason(code, signal, ap);
    // Raft's own start-timeout copy names likely provider causes ("rate-
    // limited") but is not runtime output: it must not make the close look
    // like a recoverable provider error.
    const recoverableReason = expectedTerminationReason === "startup_timeout" && isRuntimeStartTimeoutText(ap.lastRuntimeError ?? "")
      ? null
      : recoverableRuntimeProcessCloseReason(ap.lastRuntimeError || crashReason, failureDetail, stickyTerminalFailureDetail) as RecoverableExitError | null;
    const pending = ap.inbox.filter((message) => !this.isTransientDelivery(message));
    let wake: AgentMessage | undefined;
    const buffered: AgentMessage[] = [];
    for (const message of pending) {
      if (!wake && !this.isNotifiedDeferralAtColdIdleStop(ap, expectedTerminationReason, message) && !this.shouldDeferWakeMessage(agentId, ap.driver, message)) {
        wake = message;
      } else {
        buffered.push(message);
      }
    }
    const nowMs = this.clockNow();
    const facts: ExitFacts = {
      code,
      signal,
      oom: signal === "SIGKILL" && expectedTerminationReason === null,
      turnBoundarySatisfied,
      expectedTermination: expectedTerminationReason,
      runtimeError: Boolean(ap.lastRuntimeError),
      stickyFailure: Boolean(stickyTerminalFailureDetail),
      providerStreamFailure: Boolean(failureDetail && isProviderStreamFailureText(failureDetail.detail)),
      recoverableError: recoverableReason,
      inbox: { wakes: Boolean(wake), pending: pending.length > 0 },
      credential: {
        invalid: Boolean(this.credentialInvalidHold(agentId, ap.config)),
        limitUntilMs: this.lifecycleRecords.getProviderLimit(providerLimitCredentialKey(agentId, ap.config), nowMs)?.untilMs ?? null,
      },
      nowMs,
      session: {
        sessionId: ap.sessionId || ap.resumeSessionId || null,
        resumedSessionId: ap.resumeSessionId ?? null,
        knownResumeError: resumeSessionRecoveryReason(ap),
        resumeFailures: this.lifecycleRecords.getResumedEarlyCrashStreak(agentId),
      },
      modelOutput: Boolean(ap.modelOutputObserved),
      zeroEvidenceTurn: perTurnProcessDidNothing(ap),
      uptimeMs: Date.now() - ap.spawnedAtMs,
      crashStreak: this.lifecycleRecords.getRuntimeErrorCloseStreak(agentId),
      capStreak: this.lifecycleRecords.getCrashCapStreak(agentId),
      backoff: {
        baseMs: this.runtimeErrorDeliveryBackoffBaseMs,
        maxMs: this.runtimeErrorDeliveryBackoffMaxMs,
        jitterRatio: this.runtimeErrorDeliveryBackoffJitterRatio,
        jitterUnit: this.runtimeErrorDeliveryBackoffJitterRandom(),
      },
    };
    return { facts, expectedTerminationReason, failureDetail, sticky: stickyTerminalFailureDetail, recoverableReason, crashReason, inbox: { pending, wake, buffered } };
  }

  /** The plan's counters (crash streak, resume failures), its traces. */
  private recordExitPlan(agentId: string, ap: AgentProcess, plan: ExitPlan, code: number | null): void {
    if (plan.kind === "startup_request_error") this.resetRuntimeErrorCloseStreak(agentId, "startup_request_error_cleanup", ap);
    else this.lifecycleRecords.setRuntimeErrorCloseStreak(agentId, plan.crashStreak, plan.capStreak);
    this.lifecycleRecords.setResumedEarlyCrashStreak(agentId, plan.resumeFailures);
    this.traceResumedEarlyCrash(agentId, ap, plan, code);
    this.recordDaemonEvent("daemon.agent.exit.planned", {
      ...this.processLifecycleIdentityAttrs(agentId, ap),
      plan_kind: plan.kind,
      plan_start: typeof plan.start === "string" ? plan.start : "after",
      plan_start_after_ms: typeof plan.start === "string" ? undefined : plan.start.afterMs,
      plan_hold: plan.hold ?? undefined,
      plan_session: plan.session.kind === "new" ? `new:${plan.session.reason}` : plan.session.kind,
      crash_streak: plan.crashStreak,
      cap_streak: plan.capStreak,
      hand_to_server: plan.handToServer || undefined,
      keep_snapshot: plan.keepSnapshot,
    }, plan.clean ? "ok" : "error");
  }

  /** A snapshot of the closed process to start it again from (its session unless the spec moved, step 7). */
  private restartSnapshotAfterExit(ap: AgentProcess): AgentRestartSnapshot {
    const sessionId = this.sessionIdAfterExit(ap);
    return { config: this.buildRestartSafeConfig(ap.config, sessionId), sessionId, launchId: ap.launchId, processInstanceId: ap.processInstanceId };
  }

  /** Reconciler step 10a: what the close path does with `planExit`'s plan. */
  private actOnExitPlan(agentId: string, ap: AgentProcess, plan: ExitPlan, exit: ExitActionContext): void {
    const closeBeforeTurnBoundary = !exit.turnBoundarySatisfied;
    const crashActivity = buildClaudeStartupCrashActivity(ap, closeBeforeTurnBoundary, summarizeCrash(exit.finalCode, exit.finalSignal), exit.finalCode);
    const crashRuntimeError = () => buildClaudeStartupCrashRuntimeError(ap, closeBeforeTurnBoundary, exit.finalCode);
    const reason = exit.crashReason;

    if (plan.session.kind === "new" && plan.session.reason === "resume_failed") {
      // D4: chooseSession replaced the session; the server forgets it too.
      const staleSessionId = plan.session.sessionId;
      rememberSessionContext(ap.cliTransportDir, staleSessionId, null);
      this.sendToServer({ type: "agent:session:invalidate", agentId, sessionId: staleSessionId, launchId: ap.launchId || undefined, reason: plan.session.cause });
    }
    if (plan.handToServer) {
      this.handCrashStreakToServer(agentId, ap, plan, exit);
      return;
    }

    switch (plan.kind) {
      case "resume_failed":
        this.coldStartAfterResumeFailure(agentId, ap, plan, exit, crashActivity, closeBeforeTurnBoundary);
        return;
      case "clean":
        this.actOnCleanExit(agentId, ap, plan, exit);
        return;
      case "held_credential_invalid": {
        // Reconciler step 4a: a close while the credential is invalid (a
        // runtime that exits on the rejection) keeps the agent and its
        // restart snapshot; it waits for the credential, not a restart.
        this.holdDeliveriesForCredentialInvalid(agentId, ap, exit.inbox.pending, "credential_invalid_process_close");
        ap.inbox.splice(0);
        logger.warn(`[Agent ${agentId}] Process closed (${reason}) while its credential is invalid — deliveries held until it changes`);
        this.sendAgentStatus(agentId, "active", ap.launchId);
        const invalidError = credentialInvalidErrorOf(ap);
        if (invalidError) {
          const visible = credentialInvalidVisibleError(ap, invalidError.reason, invalidError.text);
          this.broadcastActivity(agentId, "error", visible.detail, visible.entries, ap.launchId, "runtime_error", undefined, undefined, buildRuntimeErrorActivityDiagnostic(invalidError.text));
        } else {
          // Held for another agent's record on the same credential.
          this.broadcastActivity(agentId, "offline", crashActivity.detail, [], ap.launchId, crashActivity.detailKind, undefined, undefined, crashRuntimeError());
        }
        return;
      }
      case "held_provider_limit":
        // A close inside a provider-limit backoff (Grace: a Claude quota
        // reported as a plain RuntimeError, so not a recoverable close by its
        // text) waits out the backoff instead of waking the agent into the
        // same limit or marking it inactive.
        this.holdDeliveriesForProviderLimitBackoff(agentId, ap, exit.inbox.pending, "provider_limit_backoff_process_close");
        ap.inbox.splice(0);
        logger.warn(`[Agent ${agentId}] Process closed (${reason}) inside a provider-limit backoff — deliveries held until it ends`);
        this.sendAgentStatus(agentId, "active", ap.launchId);
        break;
      case "zero_evidence_turn":
        // D6: the turn did nothing. Queued work waits for the streak's backoff
        // (the cap is above); with nothing queued it's a clean exit, counted.
        if (typeof plan.start === "object" && exit.inbox.wake) {
          ap.inbox.splice(0);
          this.lifecycleRecords.setRestartSnapshot(agentId, this.restartSnapshotAfterExit(ap));
          this.armRuntimeErrorProcessRestart(agentId, ap, "zero_evidence_turn", exit.inbox.wake, exit.inbox.buffered, plan.crashStreak, plan.start.afterMs);
          logger.warn(`[Agent ${agentId}] A turn ended having done nothing — retrying after backoff (attempt ${plan.crashStreak})`);
        } else {
          this.actOnCleanExit(agentId, ap, plan, exit);
        }
        break;
      case "recoverable": {
        // D3: restart after the crash streak's backoff (the cap is above).
        const recoverableReason = exit.recoverableReason!;
        ap.inbox.splice(0);
        this.lifecycleRecords.setRestartSnapshot(agentId, this.restartSnapshotAfterExit(ap));
        if (typeof plan.start === "object" && exit.inbox.wake) {
          this.armRuntimeErrorProcessRestart(agentId, ap, recoverableReason, exit.inbox.wake, exit.inbox.buffered, plan.crashStreak, plan.start.afterMs);
          logger.warn(`[Agent ${agentId}] Recoverable runtime error (${reason}) — retrying after backoff (attempt ${plan.crashStreak})`);
        } else {
          const holdMs = this.holdDeliveriesAfterRecoverableClose(agentId, ap, recoverableReason, plan.crashStreak, plan.holdNextWakeMs);
          logger.warn(`[Agent ${agentId}] Recoverable runtime error (${reason}) — keeping agent wakeable${holdMs === null ? "" : `; next delivery held ${holdMs}ms`}`);
          this.recordInboxDroppedOnExit(agentId, ap, "recoverable_error_no_wake", exit.inbox.buffered);
          this.sendAgentStatus(agentId, "active", ap.launchId);
        }
        break;
      }
      case "provider_stream_failure":
        this.lifecycleRecords.setRestartSnapshot(agentId, this.restartSnapshotAfterExit(ap));
        logger.warn(`[Agent ${agentId}] Recoverable provider stream failure (${reason}) — keeping agent wakeable`);
        this.recordInboxDroppedOnExit(agentId, ap, "provider_stream_failure", ap.inbox.splice(0));
        this.sendAgentStatus(agentId, "active", ap.launchId);
        break;
      case "startup_timeout":
        this.cacheStartupTimeoutRetryConfig(agentId, ap);
        logger.warn(`[Agent ${agentId}] Startup timeout cleanup completed (${reason})`);
        this.recordInboxDroppedOnExit(agentId, ap, "startup_timeout", ap.inbox.splice(0));
        this.backOffAfterStartTimeout(agentId);
        break;
      case "startup_request_error":
        this.lifecycleRecords.deleteRestartSnapshot(agentId);
        this.resetRuntimeErrorFingerprintFenceIfNonresident(agentId, "startup_request_error_cleanup", ap);
        logger.warn(`[Agent ${agentId}] Startup request failure cleanup completed (${reason})`);
        this.recordInboxDroppedOnExit(agentId, ap, "startup_request_error", ap.inbox.splice(0));
        break;
      case "crash":
        // D5: the next wake starts it again from the snapshot, which stays
        // (it is the agent's state). The crash counted into the streak, whose
        // cap (above) and the server's early-exit breaker end a loop; the
        // runtime-error fingerprint fence keeps counting across it too.
        this.lifecycleRecords.setRestartSnapshot(agentId, this.restartSnapshotAfterExit(ap));
        logger.error(`[Agent ${agentId}] Process crashed (${reason}) — inactive until the next wake (crash ${plan.crashStreak} in a row)`);
        this.recordInboxDroppedOnExit(agentId, ap, "nonrecoverable_crash", ap.inbox.splice(0));
        this.sendAgentStatus(agentId, "inactive", ap.launchId, { code: exit.code ?? null, signal: exit.signal ?? null });
        break;
      case "stopped":
        return;
    }

    const terminalFailureDetail = exit.failureDetail;
    if (terminalFailureDetail) {
      if (plan.kind !== "startup_timeout" && plan.kind !== "startup_request_error") {
        const { detail: visibleDetail, entries: visibleEntries } = buildBoundedVisibleCrashProjection(terminalFailureDetail.detail, terminalFailureDetail.entries);
        this.broadcastActivity(agentId, "error", visibleDetail, visibleEntries, ap.launchId, "runtime_error", undefined, undefined, crashRuntimeError());
      }
    } else if (plan.kind !== "startup_request_error") {
      this.broadcastActivity(agentId, "offline", crashActivity.detail, [], ap.launchId, crashActivity.detailKind, undefined, undefined, crashRuntimeError());
    }
  }

  /** D1 / D2: start now for queued work (unless the credential holds it), else wait for the next wake. */
  private actOnCleanExit(agentId: string, ap: AgentProcess, plan: ExitPlan, exit: ExitActionContext): void {
    // Reconciler step 7: no session to resume when the config's runtime
    // (or Codex model) is not the one the session started on.
    const nextSessionId = this.sessionIdAfterExit(ap);
    ap.inbox.splice(0);
    const { pending, wake: queuedWakeMessage, buffered: bufferedRestartMessages } = exit.inbox;
    // Reconciler step 6: the daemon's own stop of an idle process holds as the live process did.
    const ownIdleStop = exit.expectedTerminationReason === "cold_idle_recycle";
    if (queuedWakeMessage && plan.hold === "credential_invalid") {
      this.holdDeliveriesForCredentialInvalid(agentId, ap, pending, "clean_exit_credential_invalid", ownIdleStop);
      logger.info(`[Agent ${agentId}] Turn completed; queued message held until the credential is valid again`);
      this.broadcastIdleOrCredentialInvalid(agentId, ap);
      this.notifyAgentWorkingToIdle(agentId);
      return;
    }
    if (queuedWakeMessage && plan.hold === "provider_limit") {
      this.holdDeliveriesForProviderLimitBackoff(agentId, ap, pending, "clean_exit_provider_limit_backoff");
      logger.info(`[Agent ${agentId}] Turn completed; queued message held until the provider-limit backoff ends`);
      this.broadcastActivity(agentId, "online", "Process idle", [], undefined, "idle");
      this.notifyAgentWorkingToIdle(agentId);
      return;
    }
    if (plan.start === "now" && queuedWakeMessage) {
      logger.info(`[Agent ${agentId}] Turn completed; restarting immediately for queued message`);
      const nextConfig = this.buildRestartSafeConfig(ap.config, nextSessionId);
      this.lifecycleRecords.setRestartSnapshot(agentId, {
        config: nextConfig,
        sessionId: nextSessionId,
        launchId: ap.launchId,
        processInstanceId: ap.processInstanceId,
      });
      this.lifecycleRecords.deleteRestartSnapshot(agentId);
      if (exit.expectedTerminationReason === "stalled_recovery") {
        this.lifecycleRecords.setPendingSpawnCause(agentId, "restart_stall");
      }
      const startPromise = this.startAgent(agentId, nextConfig, queuedWakeMessage, undefined, undefined, ap.launchId || undefined);
      if (bufferedRestartMessages.length > 0) {
        this.startingInboxes.bufferMessagesDuringStart(agentId, bufferedRestartMessages);
        this.assertStartPendingDeliveryInvariants("clean-exit-pending-inbox-transfer");
      }
      startPromise.catch((err) => {
        logger.error(`[Agent ${agentId}] Failed to continue with queued message`, err);
        const snapshot = { config: nextConfig, sessionId: nextSessionId, launchId: ap.launchId, processInstanceId: ap.processInstanceId };
        if (this.reportRunnerCredentialMintFailure(agentId, err, ap.launchId, "queued_continuation")) {
          this.lifecycleRecords.setRestartSnapshot(agentId, snapshot);
          const report = this.recordSpawnFailure(agentId, "runner_credential_mint");
          this.assertStartPendingDeliveryInvariants("queued-continuation-runner-credential-mint-failure");
          if (report.backoffActive) {
            this.enterSpawnFailCooldownResidency(agentId, { config: nextConfig, launchId: ap.launchId }, report.untilMs, "queued_continuation", "runner_credential_mint");
          }
          this.recordDaemonEvent("daemon.agent.spawn.fail_backoff", {
            agentId,
            source: "queued_continuation",
            reason: "runner_credential_mint",
            attempts: report.attempts,
            cooldown_active: report.backoffActive,
            until_ms: report.untilMs,
          });
          return;
        }
        this.lifecycleRecords.setRestartSnapshot(agentId, snapshot);
        this.broadcastActivity(agentId, "online", "Process idle", [], undefined, "idle");
      });
      return;
    }

    this.recordInboxDroppedOnExit(
      agentId,
      ap,
      exit.expectedTerminationReason === "cold_idle_recycle" ? "cold_idle_recycle" : "clean_exit_deferred",
      bufferedRestartMessages,
    );
    // Normal exit (turn completed, idle timeout) — daemon is still online and can
    // restart the process on next message, so keep status active.
    // Cache config so we can auto-restart when a new message arrives.
    if (ownIdleStop && !plan.hold && this.specStopHandsBackToServer(ap)) {
      // Reconciler step 11 (decision 1): its config names another runtime or
      // host. No restart state is kept: the next delivery finds no process
      // and the server starts the agent, which the host router places.
      this.lifecycleRecords.deleteRestartSnapshot(agentId);
      this.specHandbacks.mark(agentId);
      this.recordDaemonEvent("daemon.agent.spec_restart_handed_to_server", { agentId, launchId: ap.launchId || undefined, stage: "close" });
      logger.info(`[Agent ${agentId}] Stopped for a new runtime or host; the server starts it at its next message`);
    } else {
      this.lifecycleRecords.setRestartSnapshot(agentId, this.restartSnapshotAfterExit(ap));
    }
    if (plan.hold === "credential_invalid") this.holdDeliveriesForCredentialInvalid(agentId, ap, [], "clean_exit_credential_invalid", ownIdleStop);
    else if (plan.hold === "provider_limit") this.holdDeliveriesForProviderLimitBackoff(agentId, ap, [], "clean_exit_provider_limit_backoff");
    if (!ap.driver.supportsStdinNotification) {
      logger.info(`[Agent ${agentId}] Turn completed; cached idle state for future restart`);
    }
    this.broadcastIdleOrCredentialInvalid(agentId, ap);
    this.wakeForAppInboxNoticeAfterTurn(agentId);
    this.notifyAgentWorkingToIdle(agentId);
  }

  /** D4: chooseSession dropped the session; start a new one at once with what was queued. */
  private coldStartAfterResumeFailure(
    agentId: string,
    ap: AgentProcess,
    plan: ExitPlan,
    exit: ExitActionContext,
    crashActivity: { detail: string; detailKind: AgentActivityDetailKind },
    closeBeforeTurnBoundary: boolean,
  ): void {
    if (plan.session.kind !== "new" || plan.session.reason !== "resume_failed") return;
    const cause = plan.session.cause;
    const staleSessionId = plan.session.sessionId;
    const runtimeLabel = runtimeDisplayName(ap.driver.id);
    const restartConfig = this.buildRestartSafeConfig(ap.config, null);
    const reasonText = cause === "provider_replay_rejected" ? "was rejected by the provider during replay"
      : cause === "repeated_early_crash" ? `crashed right after resuming ${RESUME_FAILURE_THRESHOLD} times in a row`
      : "is unavailable locally";
    const activityText = cause === "provider_replay_rejected"
      ? `Stored ${runtimeLabel} session replay rejected; cold-starting a new session…`
      : cause === "repeated_early_crash"
        ? `Stored ${runtimeLabel} session keeps crashing on resume; cold-starting a new session…`
        : `Stored ${runtimeLabel} session missing; cold-starting a new session…`;
    logger.warn(`[Agent ${agentId}] Stored ${runtimeLabel} session ${staleSessionId} ${reasonText}; falling back to cold start`);
    this.broadcastActivity(
      agentId,
      "working",
      activityText,
      [{
        kind: "text",
        text: `Stored ${runtimeLabel} session ${staleSessionId} ${reasonText}. Falling back to a cold start; earlier runtime context may not be restored.`,
      }],
      undefined,
      "runtime_unavailable",
    );
    this.lifecycleRecords.setPendingSpawnCause(agentId, "restart_crash");
    const coldStartCarriedMessages = ap.inbox.splice(0).filter((message) => !this.isTransientDelivery(message));
    const coldStartPromise = this.startAgent(
      agentId,
      restartConfig,
      ap.startup.wakeMessage,
      ap.startup.unreadSummary,
      ap.startup.resumePrompt,
      ap.launchId || undefined,
    );
    if (coldStartCarriedMessages.length > 0) {
      this.startingInboxes.bufferMessagesDuringStart(agentId, coldStartCarriedMessages);
      this.assertStartPendingDeliveryInvariants("cold-start-pending-inbox-transfer");
    }
    coldStartPromise.catch((err) => {
      logger.error(`[Agent ${agentId}] Cold start recovery failed`, err);
      this.recordInboxDroppedOnExit(agentId, ap, "cold_start_failed", coldStartCarriedMessages);
      // The status transition + crash broadcast below trace the OUTCOME;
      // this span preserves the bounded identity of the exception that
      // failed the recovery start itself.
      this.recordDaemonEvent("daemon.agent.cold_start_recovery_failed", {
        agentId,
        launchId: ap.launchId || undefined,
        outcome: "error",
        reason: "cold_start_recovery_threw",
        error_class: errorClassOf(err),
      }, "error");
      this.lifecycleRecords.deletePendingSpawnCause(agentId);
      this.sendAgentStatus(agentId, "inactive", ap.launchId, { code: exit.code ?? null, signal: exit.signal ?? null });
      this.broadcastActivity(agentId, "offline", crashActivity.detail, [], ap.launchId, crashActivity.detailKind, undefined, undefined, buildClaudeStartupCrashRuntimeError(ap, closeBeforeTurnBoundary, exit.finalCode));
    });
  }

  /**
   * Reconciler step 10a, capped: CRASH_STREAK_CAP crashes in a row that the
   * cap counts (D5, an unclassified stream failure, a resume failure's
   * crash; never a recoverable provider close, D3).
   * The daemon stops starting the agent itself, as after as many failed
   * spawns (D12, `stopLocalRestartAfterFailure`): the restart snapshot and
   * the buffered deliveries go (the server still holds those messages), the
   * failure is reported as a failed start, so the server's start-failure
   * breaker (F2) counts it and decides the next start, and the person sees
   * an error to restart from (no required action: Restart is the way out,
   * and an explicit stop ends the streak). Never just idle. The hand-off
   * event carries the last exit's sanitized facts (kind, code, signal, the
   * runtime error's class and fingerprint, never its text), so a provider
   * error the classes missed (counted as D5) shows up in the traces.
   */
  private handCrashStreakToServer(agentId: string, ap: AgentProcess, plan: ExitPlan, exit: ExitActionContext): void {
    this.cancelRuntimeErrorProcessRestart(agentId);
    this.lifecycleRecords.deleteRestartSnapshot(agentId);
    this.resetSpawnFailBackoff(agentId, "terminal");
    const droppedBuffered = this.startingInboxes.count(agentId);
    this.startingInboxes.cancelStart(agentId);
    this.recordInboxDroppedOnExit(agentId, ap, "crash_streak_exhausted", ap.inbox.splice(0));
    const summary = summarizeCrash(exit.finalCode, exit.finalSignal);
    logger.warn(`[Agent ${agentId}] Local restarts stopped after ${plan.capStreak} crashes in a row (${exit.crashReason}); ${droppedBuffered} buffered delivery(ies) left to the Server`);
    // Classified from what the recoverable-close rule read (the runtime's
    // error, else the exit's own output), so a provider error it missed shows.
    const lastErrorAttrs = buildRuntimeErrorDiagnosticEnvelope(ap.lastRuntimeError || exit.crashReason).spanAttrs;
    this.recordDaemonEvent("daemon.agent.spawn.local_restart_stopped", {
      agentId,
      launchId: ap.launchId || undefined,
      runtime: ap.config.runtime,
      // A batch on one runtime version points at our parsing before the user's provider (a
      // format change makes every turn look empty); the model names the provider.
      runtime_cli_version: this.runtimeCliVersionOf(ap),
      model: ap.config.model,
      source: "process_close",
      failure_reason: plan.kind,
      stop_cause: "attempts_exhausted",
      attempts: plan.capStreak,
      crash_streak: plan.crashStreak,
      dropped_count: droppedBuffered,
      // The last exit, sanitized: no error text.
      exit_kind: plan.kind,
      exit_code: exit.finalCode,
      exit_signal: exit.finalSignal ?? undefined,
      exit_oom: exit.facts.oom || undefined,
      exit_sticky_failure: exit.facts.stickyFailure || undefined,
      exit_provider_stream_failure: exit.facts.providerStreamFailure || undefined,
      exit_uptime_ms_bucket: bucketMs(exit.facts.uptimeMs),
      runtime_error_reported: Boolean(ap.lastRuntimeError),
      runtime_error_class: lastErrorAttrs.runtime_error_class,
      runtime_error_fingerprint: lastErrorAttrs.runtime_error_fingerprint,
      runtime_error_http_status: lastErrorAttrs.runtime_error_http_status,
    }, "error");
    // The exit itself, as every crash reports it (the early-exit breaker, F1).
    this.sendAgentStatus(agentId, "inactive", ap.launchId, { code: exit.code ?? null, signal: exit.signal ?? null });
    const detail = plan.kind === "zero_evidence_turn"
      ? formatZeroEvidenceStreakMessage(runtimeDisplayName(ap.driver.id), plan.capStreak)
      : formatCrashStreakExhaustedMessage(runtimeDisplayName(ap.driver.id), plan.capStreak, summary);
    // The failed start for the start-failure breaker (F2). Reconciler step 12:
    // these crashes came after the start was ready, whose readiness already
    // ended the server's failed-start count, so a plain failed start would
    // count 1 at every hand-off and never pause; the daemon counted them, and
    // `runtime_repeated_failure` pauses at this first report.
    const reason = reportedStickyFailureReason("runtime_repeated_failure", this.serverCountsStickyReasons);
    this.reportStartFailure(agentId, ap.launchId, { reason, detail, userMessage: detail }, ap.config.model);
    const { requiredAction: _requiredAction, ...runtimeError } = buildRuntimeErrorActivityDiagnostic(ap.lastRuntimeError || detail, { reasonProvenance: "daemon_fallback", nativeReasonPresent: false });
    const lastError = exit.failureDetail?.detail ?? ap.lastRuntimeError;
    this.broadcastActivity(
      agentId,
      "error",
      detail,
      [{ kind: "text", text: `Error: ${detail}` }, ...(lastError ? [{ kind: "text" as const, text: `Last error: ${buildBoundedVisibleCrashDetail(lastError)}` }] : [])],
      ap.launchId,
      "runtime_error",
      undefined,
      undefined,
      runtimeError,
    );
  }

  /**
   * Reconciler step 12 (row C10): a Codex turn that completed having done
   * nothing is not sticky any more. It counts like a crash (D6) into the
   * streaks `planExit` reads; the process stays, and the delivery backoff
   * holds the next delivery. True at CRASH_STREAK_CAP in a row (model output
   * ends the streak), when the agent goes to the server
   * (`handCodexZeroEvidenceStreakToServer`).
   */
  private noteCodexZeroEvidenceTurn(agentId: string, ap: AgentProcess): boolean {
    const crashStreak = this.lifecycleRecords.getRuntimeErrorCloseStreak(agentId) + 1;
    const capStreak = this.lifecycleRecords.getCrashCapStreak(agentId) + 1;
    this.lifecycleRecords.setRuntimeErrorCloseStreak(agentId, crashStreak, capStreak);
    const capped = crashStreakExhausted(capStreak);
    this.recordDaemonEvent("daemon.agent.zero_evidence_turn.counted", {
      agentId,
      launchId: ap.launchId || undefined,
      runtime: ap.config.runtime,
      crash_streak: crashStreak,
      cap_streak: capStreak,
      hand_to_server: capped || undefined,
    }, "error");
    return capped;
  }

  /** C10 at the cap: as `handCrashStreakToServer`, for a process that is still running. */
  private handCodexZeroEvidenceStreakToServer(agentId: string, ap: AgentProcess): void {
    const detail = formatZeroEvidenceStreakMessage(runtimeDisplayName(ap.driver.id), this.lifecycleRecords.getCrashCapStreak(agentId));
    this.releaseFailedProcess(agentId, ap, detail, terminalFailureFromRawText("sticky_runtime_error", ap.lastRuntimeError || detail));
    this.handStickyFailureToServer(agentId, ap, { reason: "runtime_repeated_failure", detail, cause: "zero_evidence_turn" });
  }

  private resetRuntimeErrorCloseStreak(agentId: string, resetSource: string, ap?: AgentProcess): void {
    const attempts = this.lifecycleRecords.getRuntimeErrorCloseStreak(agentId);
    if (!this.lifecycleRecords.deleteRuntimeErrorCloseStreak(agentId)) return;
    this.recordDaemonEvent("daemon.agent.runtime_error_process_restart.reset", {
      agentId,
      runtime: ap?.config.runtime,
      launchId: ap?.launchId || undefined,
      attempts,
      reset_source: resetSource,
    });
  }

  // ----- RUNTIME-ERROR FINGERPRINT FENCE (per-agent) ---------------------
  // The delivery backoff above is scoped to AgentProcess and is cleared when a
  // runtime process exits. Recoverable terminal errors intentionally keep an
  // idle restart cache so the next message can wake the agent, but that also
  // means a deterministic same-fingerprint runtime error can close/restart
  // forever. Keep this counter outside AgentProcess and reset only on real turn
  // progress or explicit stop.
  private runtimeErrorFingerprintFenceResetEvent(eventKind: ParsedEvent["kind"]): boolean {
    return runtimeErrorFingerprintFenceResetEvent(eventKind);
  }

  private resetRuntimeErrorFingerprintFence(agentId: string, resetSource: string, ap?: AgentProcess): void {
    const state = this.lifecycleRecords.getRuntimeErrorFingerprintFence(agentId);
    if (!state) return;
    this.lifecycleRecords.deleteRuntimeErrorFingerprintFence(agentId);
    this.recordDaemonEvent("daemon.agent.runtime_error_fingerprint_fence.reset", {
      agentId,
      runtime: ap?.config.runtime,
      model: ap?.config.model,
      launchId: ap?.launchId || state.launchId || undefined,
      ...fingerprintFenceTraceAttrs(state.fingerprint),
      attempts: state.attempts,
      reset_source: resetSource,
    }, "ok", this.runtimeTurnTraceparent(ap));
  }

  /**
   * The trace of the turn `ap` is in, or of the turn its runtime error just
   * ended: the fence records join it, as the turn's `runtime.error` does.
   * Undefined without one (the event then joins the active span, if any).
   */
  private runtimeTurnTraceparent(ap?: AgentProcess): string | undefined {
    const context = ap?.runtimeTraceSpan?.context ?? ap?.endedRuntimeTurnTraceContext;
    return context ? formatTraceparent(context) : undefined;
  }

  private resetRuntimeErrorFingerprintFenceIfNonresident(agentId: string, resetSource: string, ap?: AgentProcess): void {
    if (this.agents.has(agentId)) return;
    if (this.lifecycleRecords.getRestartSnapshot(agentId)) return;
    if (this.lifecycleRecords.getTerminalFailure(agentId)) return;
    this.resetRuntimeErrorFingerprintFence(agentId, resetSource, ap);
    this.resetRuntimeErrorClassFence(agentId, ap, resetSource);
  }

  private repairNonresidentRuntimeErrorFingerprintFences(context: string): void {
    for (const agentId of new Set([...this.lifecycleRecords.runtimeErrorFingerprintFenceAgentIds(), ...this.lifecycleRecords.runtimeErrorClassFenceAgentIds()])) {
      this.resetRuntimeErrorFingerprintFenceIfNonresident(agentId, `invariant_repair:${context}`);
    }
  }

  private formatRuntimeErrorFingerprintFenceDetail(state: RuntimeErrorFingerprintFenceState): string {
    return formatRuntimeErrorFingerprintFenceDetail(state);
  }

  /**
   * The last runtime error stays the visible state at a turn end. An invalid
   * credential's error keeps its diagnostic (the required action) on it, so
   * the latest error frame still says what the user must do.
   */
  private broadcastRuntimeErrorAtTurnEnd(agentId: string, ap: AgentProcess, message: string): void {
    const credentialInvalid = credentialInvalidReasonOf(message);
    if (!credentialInvalid) {
      this.broadcastActivity(agentId, "error", this.formatVisibleRuntimeErrorMessage(ap, message), [], undefined, "runtime_error");
      return;
    }
    const visible = credentialInvalidVisibleError(ap, credentialInvalid, message);
    this.broadcastActivity(agentId, "error", visible.detail, visible.entries, undefined, "runtime_error", undefined, undefined, buildRuntimeErrorActivityDiagnostic(message));
  }

  private formatVisibleRuntimeErrorMessage(ap: AgentProcess, message: string): string {
    if (isRuntimeInputTooLargeErrorText(message)) {
      return formatRuntimeInputTooLargeMessage(ap.driver.id);
    }
    const credentialInvalid = credentialInvalidReasonOf(message);
    const problem = credentialProblemCodeOf(message);
    if (problem) return CREDENTIAL_PROBLEM_MESSAGES[problem];
    if (credentialInvalid === "billing") return formatRuntimeBillingExhaustedMessage(ap.driver.id);
    if (credentialInvalid) return formatRuntimeActionRequiredMessage(ap, message);
    return message;
  }

  private noteRuntimeErrorFingerprintFence(
    agentId: string,
    ap: AgentProcess,
    message: string,
    fingerprint: string | null,
    terminalFailure: RuntimeErrorDeliveryFailure | null,
    stickyTerminalFailure: RuntimeErrorDeliveryFailure | null,
    errorClass?: string,
  ): RuntimeErrorFingerprintFenceState | null {
    if (!fingerprint) return null;
    if (stickyTerminalFailure || terminalFailure?.actionRequired) return null;

    let state = this.lifecycleRecords.getRuntimeErrorFingerprintFence(agentId);
    if (!state || state.fingerprint !== fingerprint) {
      state = {
        fingerprint,
        attempts: 0,
        lastRuntimeError: message,
        detail: "",
        launchId: ap.launchId,
      };
      this.lifecycleRecords.setRuntimeErrorFingerprintFence(agentId, state);
    }

    state.attempts += 1;
    state.lastRuntimeError = message;
    state.lastRuntimeErrorClass = errorClass;
    state.launchId = ap.launchId;
    state.detail = this.formatRuntimeErrorFingerprintFenceDetail({
      ...state,
      lastRuntimeError: this.formatVisibleRuntimeErrorMessage(ap, message),
    });
    const fenced = state.attempts >= RUNTIME_ERROR_FINGERPRINT_FENCE_THRESHOLD;

    this.recordDaemonEvent("daemon.agent.runtime_error_fingerprint_fence", {
      agentId,
      runtime: ap.config.runtime,
      model: ap.config.model,
      launchId: ap.launchId || undefined,
      ...fingerprintFenceTraceAttrs(fingerprint),
      attempts: state.attempts,
      threshold: RUNTIME_ERROR_FINGERPRINT_FENCE_THRESHOLD,
      fenced,
      runtime_error_class: errorClass ?? buildRuntimeErrorDiagnosticEnvelope(message).spanAttrs.runtime_error_class,
    }, fenced ? "error" : "ok", this.runtimeTurnTraceparent(ap));

    return fenced ? state : null;
  }

  private applyRuntimeErrorFingerprintFence(agentId: string, ap: AgentProcess, state: RuntimeErrorFingerprintFenceState): void {
    const runtimeErrorClass = state.lastRuntimeErrorClass
      ?? String(buildRuntimeErrorDiagnosticEnvelope(state.lastRuntimeError).spanAttrs.runtime_error_class);
    // task #352 — this path used to leave no runner.log line at all: when traces
    // were not uploaded, the SIGTERM below had no visible cause anywhere. One
    // line per trip (not per attempt), with the fields needed to attribute it.
    logger.warn(
      `[Agent ${agentId}] ${ap.driver.id} same-fingerprint runtime error fence tripped: `
      + `fingerprint=${state.fingerprint} attempts=${state.attempts}/${RUNTIME_ERROR_FINGERPRINT_FENCE_THRESHOLD} class=${runtimeErrorClass}; `
      + "stopping the runtime and handing the agent to the Server",
    );
    this.recordDaemonEvent("daemon.agent.runtime_error_fingerprint_fence.tripped", {
      agentId,
      runtime: ap.config.runtime,
      model: ap.config.model,
      launchId: ap.launchId || undefined,
      ...fingerprintFenceTraceAttrs(state.fingerprint),
      attempts: state.attempts,
      threshold: RUNTIME_ERROR_FINGERPRINT_FENCE_THRESHOLD,
      runtime_error_class: runtimeErrorClass,
    }, "error", this.runtimeTurnTraceparent(ap));
    // Reconciler step 12 (row C11): counted here, handed to the server at
    // this first trip (`runtime_repeated_failure`: it pauses and retries by
    // itself, a provider outage looks the same). The count starts over: the
    // server's try is a new episode.
    this.resetRuntimeErrorFingerprintFence(agentId, "tripped", ap);
    this.releaseFailedProcess(agentId, ap, state.detail, {
      failureKind: "fingerprint_fence",
      fingerprint: state.fingerprint,
      errorClass: terminalFailureFromRawText("fingerprint_fence", state.lastRuntimeError, state.lastRuntimeErrorClass).errorClass,
    });
    this.handStickyFailureToServer(agentId, ap, { reason: "runtime_repeated_failure", detail: state.detail, cause: "fingerprint_fence" });
  }

  /**
   * Task #1315: the same-fingerprint fence never trips when every error's text
   * differs (a request id, say), so a runtime could fail the same way for days.
   * Only NotFoundError with HTTP 404 present counts; anything else, including
   * an inconsistent class/status pair, clears the count. Reconciler step 12:
   * the count lives in the agent's lifecycle records, so it grows across
   * respawns as the same-fingerprint fence's does.
   */
  private noteRuntimeErrorClassFence(
    agentId: string,
    ap: AgentProcess,
    message: string,
    spanAttrs: Record<string, unknown>,
    terminalFailure: RuntimeErrorDeliveryFailure | null,
    stickyTerminalFailure: RuntimeErrorDeliveryFailure | null,
  ): { attempts: number; detail: string; lastRuntimeError: string; lastRuntimeErrorClass?: string } | null {
    const eligible = !stickyTerminalFailure
      && !terminalFailure?.actionRequired
      && spanAttrs.runtime_error_class === "NotFoundError"
      && spanAttrs.runtime_error_http_status === 404;
    if (!eligible) {
      this.resetRuntimeErrorClassFence(agentId, ap, "ineligible_error");
      return null;
    }
    const attempts = (this.lifecycleRecords.getRuntimeErrorClassFence(agentId)?.attempts ?? 0) + 1;
    this.lifecycleRecords.setRuntimeErrorClassFence(agentId, { attempts, lastRuntimeError: message });
    const fenced = attempts >= RUNTIME_ERROR_CLASS_FENCE_THRESHOLD;
    this.recordDaemonEvent("daemon.agent.runtime_error_class_fence", {
      agentId,
      runtime: ap.config.runtime,
      model: ap.config.model,
      launchId: ap.launchId || undefined,
      runtime_error_class: "NotFoundError",
      runtime_error_http_status: 404,
      runtime_error_fingerprint: spanAttrs.runtime_error_fingerprint,
      attempts,
      threshold: RUNTIME_ERROR_CLASS_FENCE_THRESHOLD,
      fenced,
    }, fenced ? "error" : "ok", this.runtimeTurnTraceparent(ap));
    if (!fenced) return null;
    return {
      attempts,
      lastRuntimeError: message,
      lastRuntimeErrorClass: "NotFoundError",
      detail: [
        `Runtime stopped after ${attempts} consecutive "not found" (HTTP 404) runtime errors with no progress in between.`,
        `Last error: ${this.formatVisibleRuntimeErrorMessage(ap, message)}`,
        "Check the configured model and endpoint; Raft retries it later by itself.",
      ].join(" "),
    };
  }

  private resetRuntimeErrorClassFence(agentId: string, ap: AgentProcess | undefined, resetSource: string): void {
    const state = this.lifecycleRecords.getRuntimeErrorClassFence(agentId);
    if (!state) return;
    this.lifecycleRecords.deleteRuntimeErrorClassFence(agentId);
    this.recordDaemonEvent("daemon.agent.runtime_error_class_fence.reset", {
      agentId,
      runtime: ap?.config.runtime,
      launchId: ap?.launchId || undefined,
      attempts: state.attempts,
      reset_source: resetSource,
    }, "ok", this.runtimeTurnTraceparent(ap));
  }

  private applyRuntimeErrorClassFence(agentId: string, ap: AgentProcess, state: { attempts: number; detail: string; lastRuntimeError: string; lastRuntimeErrorClass?: string }): void {
    logger.warn(
      `[Agent ${agentId}] ${ap.driver.id} repeated not-found runtime error fence tripped: `
      + `attempts=${state.attempts}/${RUNTIME_ERROR_CLASS_FENCE_THRESHOLD} class=NotFoundError status=404; `
      + "stopping the runtime and handing the agent to the Server",
    );
    this.recordDaemonEvent("daemon.agent.runtime_error_class_fence.tripped", {
      agentId,
      runtime: ap.config.runtime,
      model: ap.config.model,
      launchId: ap.launchId || undefined,
      runtime_error_class: "NotFoundError",
      runtime_error_http_status: 404,
      runtime_error_fingerprint: buildRuntimeErrorDiagnosticEnvelope(state.lastRuntimeError).spanAttrs.runtime_error_fingerprint,
      attempts: state.attempts,
      threshold: RUNTIME_ERROR_CLASS_FENCE_THRESHOLD,
    }, "error", this.runtimeTurnTraceparent(ap));
    // Reconciler step 12 (row C11): as the same-fingerprint fence.
    this.resetRuntimeErrorClassFence(agentId, ap, "tripped");
    // Reuses the existing wire value rather than extending the shared
    // AGENT_RUNTIME_TERMINAL_FAILURE_KINDS protocol. It does not mean an exact
    // fingerprint repeated: count this layer by its own trace events and detail.
    this.releaseFailedProcess(agentId, ap, state.detail, terminalFailureFromRawText("fingerprint_fence", state.lastRuntimeError, state.lastRuntimeErrorClass));
    this.handStickyFailureToServer(agentId, ap, { reason: "runtime_repeated_failure", detail: state.detail, cause: "class_fence" });
  }

  private scheduleStdinNotification(agentId: string, ap: AgentProcess, delayMs: number): boolean {
    return ap.notifications.schedule(() => {
      this.sendStdinNotification(agentId);
    }, delayMs);
  }

  private scheduleSessionReadyDeliveryRetry(agentId: string, ap: AgentProcess, reason: string): boolean {
    return scheduleSessionReadyDeliveryRetryDebt(agentId, ap, reason, {
      delayMs: this.sessionReadyDeliveryRetryMs,
      readyDelayCapMs: STDIN_NOTIFICATION_INITIAL_DELAY_MS,
      canDeliverToRuntimeSession: (process) => this.canDeliverToRuntimeSession(process),
      flush: (id, source) => this.flushSessionReadyDeliveryRetry(id, source),
      recordDaemonEvent: (...args) => this.recordDaemonEvent(...args),
    });
  }

  private flushSessionReadyDeliveryRetry(agentId: string, source: SessionReadyDeliveryRetryFlushSource): boolean {
    if (this.heldForCredentialInvalid(agentId) || this.drain.holds(agentId)) return false;
    return flushSessionReadyDeliveryRetryDebt(agentId, source, {
      getProcess: (id) => this.agents.get(id),
      canDeliverToRuntimeSession: (ap) => this.canDeliverToRuntimeSession(ap),
      isApmIdle: (ap) => this.isApmIdle(ap),
      commitApmIdleState: (id, ap, idle) => this.commitApmIdleState(id, ap, idle),
      startRuntimeTrace: (id, ap, name, messages) => this.startRuntimeTrace(id, ap, name, messages),
      deliverInboxUpdateViaStdin: (id, ap, messages, mode, deliverySource) => this.deliverInboxUpdateViaStdin(id, ap, messages, mode, deliverySource),
      sendStdinNotification: (id, options) => this.sendStdinNotification(id, options),
      recordDaemonEvent: (...args) => this.recordDaemonEvent(...args),
    });
  }

  private scheduleIdleInboxDeliveryRetry(agentId: string, ap: AgentProcess, notificationCount: number, source: string, traceName: string): boolean {
    if (notificationCount <= 0 || !ap.driver.supportsStdinNotification || !ap.sessionId) return false;
    ap.notifications.add(notificationCount);
    ap.notifications.clearTimer();
    return ap.notifications.schedule(() => {
      this.flushIdleInboxDeliveryRetry(agentId, source, traceName);
    }, this.stdinNotificationRetryMs);
  }

  private flushIdleInboxDeliveryRetry(agentId: string, source: string, traceName: string): boolean {
    if (this.heldForCredentialInvalid(agentId) || this.drain.holds(agentId)) return false;
    return flushIdleInboxDeliveryRetryDebt(agentId, source, traceName, {
      getProcess: (id) => this.agents.get(id),
      isApmIdle: (ap) => this.isApmIdle(ap),
      commitApmIdleState: (id, ap, idle) => this.commitApmIdleState(id, ap, idle),
      startRuntimeTrace: (id, ap, name, messages) => this.startRuntimeTrace(id, ap, name, messages),
      deliverInboxUpdateViaStdin: (id, ap, messages, mode, deliverySource) => this.deliverInboxUpdateViaStdin(id, ap, messages, mode, deliverySource),
      sendStdinNotification: (id, options) => this.sendStdinNotification(id, options),
      recordDaemonEvent: (...args) => this.recordDaemonEvent(...args),
    });
  }

  private flushAsyncRejectedIdleDelivery(agentId: string): boolean {
    return this.flushIdleInboxDeliveryRetry(
      agentId,
      "async_rejected_idle_delivery_retry",
      "daemon.agent.stdin_delivery.async_rejected.retry",
    );
  }

  /**
   * task #1114 — record one successful stdin write against the runtime
   * consumption clock and expose the result as typed observation. A write is
   * evidence of transport, not of consumption; the counter resets only on a
   * model-driven runtime event (see DeliveryConsumptionWatch). Observation
   * only: nothing here stops, restarts, retries or throttles anything.
   * `intoRunningTurn`: a busy write, which a runtime may queue for a turn of
   * its own after this one (agentIdle.ts `queuedInputPending`).
   */
  private observeDeliveryWrite(
    agentId: string,
    ap: AgentProcess,
    deliveryKey: string | null,
    path: DeliveryWritePath,
    intoRunningTurn: boolean,
  ): void {
    const nowMs = Date.now();
    const observation = ap.deliveryConsumption.recordWrite(deliveryKey, path, nowMs, intoRunningTurn, intoRunningTurn || ap.backgroundTasks.size > 0);
    const processAlive = ap.runtime.isAlive() ?? !ap.runtime.closed;
    this.recordDaemonEvent("daemon.agent.delivery.consumption", {
      agent_id: agentId,
      launch_id: ap.launchId || "",
      session_id_present: Boolean(ap.sessionId),
      runtime: ap.config.runtime,
      // Not `delivery_path`: the trace sink drops any `*_path` key as a
      // filesystem path, which left this field empty on every daemon version.
      delivery_write_kind: path,
      episode: observation.episode,
      unconsumed_deliveries: observation.unconsumedDeliveries,
      first_unconsumed_age_ms_bucket: observation.firstUnconsumedAtMs === null ? null : bucketMs(nowMs - observation.firstUnconsumedAtMs),
      last_delivery_key: observation.lastDeliveryKey,
      last_consumption_kind: observation.lastConsumption?.kind ?? null,
      last_consumption_age_ms_bucket: observation.lastConsumption ? bucketMs(nowMs - observation.lastConsumption.atMs) : null,
      last_runtime_result_kind: observation.lastRuntimeResult?.kind ?? null,
      last_runtime_result_class: observation.lastRuntimeResult?.kind === "error" ? observation.lastRuntimeResult.errorClass : null,
      last_runtime_result_empty: observation.lastRuntimeResult?.kind === "completed" ? observation.lastRuntimeResult.empty : null,
      last_delivery_error_class: observation.lastDeliveryError?.errorClass ?? null,
      process_alive: processAlive,
      threshold_crossed: observation.thresholdCrossed,
    }, observation.thresholdCrossed ? "error" : "ok");
    if (observation.thresholdCrossed) {
      const ageMs = observation.firstUnconsumedAtMs === null ? 0 : nowMs - observation.firstUnconsumedAtMs;
      logger.warn(
        `[Agent ${agentId}] ${observation.unconsumedDeliveries} stdin deliveries written since the last runtime consumption signal `
        + `(episode ${observation.episode}, first ${Math.round(ageMs / 1000)}s ago, process ${processAlive ? "alive" : "gone"}); observation only`,
      );
      // task #1116: project the typed state so the web can show it. Once per
      // episode, activity kind unchanged (this is a diagnostic, not a verdict).
      this.broadcastActivity(
        agentId,
        ap.lastActivityKind ?? "online",
        `${observation.unconsumedDeliveries} deliveries written, runtime not consuming`,
        [],
        ap.launchId || undefined,
        "delivery_unconsumed",
        undefined,
        undefined,
        undefined,
        {
          launchId: ap.launchId || "",
          episode: observation.episode,
          unconsumedDeliveries: observation.unconsumedDeliveries,
          firstUnconsumedAtMs: observation.firstUnconsumedAtMs,
          lastDeliveryAtMs: observation.lastDeliveryAtMs,
          lastDeliveryKey: observation.lastDeliveryKey,
          lastDeliveryPath: observation.lastDeliveryPath,
          lastConsumptionKind: observation.lastConsumption?.kind ?? null,
          lastConsumptionAtMs: observation.lastConsumption?.atMs ?? null,
          lastRuntimeResult: observation.lastRuntimeResult,
          lastDeliveryErrorClass: observation.lastDeliveryError?.errorClass ?? null,
          processAlive,
        },
      );
    }
  }

  /** task #1114: queryable delivery-consumption state for a live agent process, or null. */
  getDeliveryConsumptionSnapshot(agentId: string): DeliveryConsumptionSnapshot | null {
    return this.agents.get(agentId)?.deliveryConsumption.snapshot() ?? null;
  }

  /**
   * task #1114 — may this runtime event be attributed to the live process's
   * pending stdin writes? An event that names a session must name the live
   * one; an event without a session (or with the live one) counts only while a
   * turn is open on the process, because the daemon opens the turn when it
   * writes and a turn-less event has nothing to consume.
   */
  private deliveryConsumptionAssociation(
    ap: AgentProcess,
    event: ParsedEvent,
  ): "associated" | "session_mismatch" | "no_live_turn" {
    const eventSessionId = "sessionId" in event && typeof event.sessionId === "string" ? event.sessionId : undefined;
    // A named event must name the live session. An unknown live session
    // (ap.sessionId === null) fails closed: every write path requires a bound
    // session, so there is nothing a foreign-session event could have consumed.
    if (eventSessionId !== undefined && eventSessionId !== ap.sessionId) return "session_mismatch";
    if (!this.isApmIdle(ap)) return "associated";
    if (eventSessionId !== undefined) return "associated";
    return "no_live_turn";
  }

  private isApmIdle(ap: AgentProcess): boolean {
    return ap.gatedSteering.isIdle;
  }

  /**
   * Input waits at a compaction boundary: the runtime's own compaction (for a
   * runtime that takes no input during it), or a turn-end compaction asked of
   * an in-process runtime's API and not settled yet (#proj-runtime:#54). The
   * second is the daemon's own flag: it holds from the call, before the
   * runtime reports anything, and still holds if it never reports anything.
   */
  private compactionGateClosed(ap: AgentProcess): boolean {
    return (ap.gatedSteering.compacting && ap.driver.acceptsStdinDuringCompaction !== true) || this.driverCompactionHolds(ap);
  }

  private driverCompactionHolds(ap: AgentProcess): boolean {
    return ap.turnEndCompaction?.inFlight?.viaDriver === true;
  }

  /** Work the runtime has not been told about yet: a notice still waiting to
   * be written, or a queued message whose notice never reached this session.
   * Messages the agent was notified about and chose to leave unread are its own
   * deferral, not pending work — under inbox-notice delivery agents routinely
   * idle with dozens of them, so treating them as work kept the cold-idle stop
   * from ever firing. */
  private hasUntoldInboxWork(ap: AgentProcess): boolean {
    return ap.notifications.pendingCount > 0
      || ap.notifications.filterUncontributedMessages(ap.inbox, ap.sessionId).length > 0;
  }

  /**
   * pi session rotation (plan §1): a runtime with a rotation due rotates at a
   * turn end only while the agent is idle (agentIdle.ts). The runtime reads
   * this right before it rotates, after its own turn has settled.
   */
  private rotateRuntimeSessionIfDue(agentId: string, ap: AgentProcess): void {
    ap.runtime.rotateSessionIfDue?.(() => this.observeIdleHold(agentId, ap, "session_rotation", this.agentNotIdle(agentId, ap)));
  }

  /** Measure how long `gate` has been held by `reason` (agentIdleHold.ts); returns `reason`. */
  private observeIdleHold<R extends string | null>(agentId: string, ap: AgentProcess, gate: IdleHoldGate, reason: R): R {
    const long = this.idleHolds.observe(agentId, ap.processInstanceId, gate, reason, this.clockNow());
    if (long) {
      this.recordDaemonEvent("daemon.agent.idle_hold_long", {
        agentId,
        launchId: ap.launchId || undefined,
        runtime: ap.config.runtime,
        gate: long.gate,
        reason: long.reason,
        held_ms: long.heldMs,
      });
    }
    return reason;
  }

  /**
   * Why this agent's live process is not idle right now, or null
   * (agentNotIdleReason). `ignoreUntoldInbox` (a drain's quiet): a tracked
   * mention still queued here untold is untold inbox, not an open mention.
   */
  private agentNotIdle(agentId: string, ap: AgentProcess, options: AgentIdleOptions = {}): AgentNotIdleReason | null {
    const idle = this.agentIdleFacts(agentId, ap, options);
    return idle ? agentNotIdleReason(idle.facts, idle.options) : "agent_busy";
  }

  /**
   * A stop-wait's predicate (agentStopWaitReason, a drain's quiet): idle, or
   * not runnable with no turn in flight. Not this agent's live process: busy.
   */
  private agentStopWait(agentId: string, ap: AgentProcess, options: AgentIdleOptions = {}): AgentStopWait {
    const idle = this.agentIdleFacts(agentId, ap, options);
    if (!idle) return { notIdle: "agent_busy", notRunnable: null, settled: null };
    return agentStopWaitReason(idle.facts, this.agentRunnableFacts(agentId, ap), idle.options);
  }

  /**
   * agentNotRunnableReason's facts for this process: its spawn, its
   * credential's invalid record and quota (the ledger both hosts share), and
   * the runtime binding fence.
   */
  private agentRunnableFacts(agentId: string, ap: AgentProcess): AgentRunnableFacts {
    const ledger = this.lifecycleRecords.providerLimitLedger;
    const nowMs = Date.now();
    const limit = ledger.hasAny() ? ledger.get(providerLimitCredentialKey(agentId, ap.config), nowMs) : undefined;
    return {
      // A failed spawn (the `error` of a `spawn` syscall) leaves no process, before its exit is seen.
      processAlive: ap.exit.kind === "live" && !ap.spawnNoProcess && !(ap.spawnError !== null && ap.spawnErrorSyscall?.startsWith("spawn") === true),
      credentialInvalid: this.credentialInvalidHold(agentId, ap.config) !== undefined,
      // Hopeless only if it outlasts any drain; a short wait (no reset time: a 10 s backoff) is merely slow.
      quotaExhausted: limit !== undefined && limit.providerLimitKind === "quota_exhausted" && limit.untilMs - nowMs >= AGENT_DRAIN_MAX_DEADLINE_MS,
      runtimeMismatch: this.runtimeProcessBindingFence.refusesRuntime(ap),
    };
  }

  /** The idle facts of this agent's live process and the options they are read with; null when `ap` is not it. */
  private agentIdleFacts(agentId: string, ap: AgentProcess, options: AgentIdleOptions): { facts: AgentIdleFacts; options: AgentIdleOptions } | null {
    if (this.agents.get(agentId) !== ap || ap.exit.kind !== "live") return null;
    // A delivery held for this process's credential (a provider limit's wait,
    // an invalid credential) cannot reach the session until the hold lifts:
    // it is no work the session is doing or about to do. Counting it held
    // every idle-gated step (a config apply, an upgrade's drain, a cold
    // recycle) until the limit reset (#triage:#263).
    if (this.deliveriesHeld(agentId, ap)) options = { ...options, ignoreUntoldInbox: true };
    let trackedMentionOpen = false;
    for (const tracked of this.trackedMentionDeliveries.values()) {
      if (tracked.agentId !== agentId || tracked.state === "drained") continue;
      if (options.ignoreUntoldInbox && this.isTrackedMentionHeldUntold(ap, tracked)) continue;
      trackedMentionOpen = true;
    }
    return {
      facts: {
        turnEnded: this.isApmIdle(ap),
        backgroundTasks: ap.backgroundTasks.size,
        unconsumedStdin: ap.deliveryConsumption.snapshot().unconsumedDeliveries,
        queuedInputPending: ap.deliveryConsumption.queuedInputPending(Date.now(), this.queuedInputSettleMs),
        // A sub-agent result no turn has read yet is input too: Claude Code
        // opens that turn by itself right after the task's end.
        untoldInbox: this.hasUntoldInboxWork(ap) || ap.sessionReadyDeliveryRetry.kind === "scheduled" || ap.subagentResultUnread === true,
        trackedMentionOpen,
      },
      options,
    };
  }

  /** A tracked mention whose row still waits in this process's inbox, never told to its session. */
  private isTrackedMentionHeldUntold(ap: AgentProcess, tracked: TrackedMentionDelivery): boolean {
    if (tracked.toldProcessInstanceId === ap.processInstanceId) return false;
    const queued = ap.inbox.find((message) => message.message_id === tracked.messageId);
    return queued !== undefined && !ap.notifications.hasContributedMessage(queued, ap.sessionId);
  }

  /**
   * Reconciler step 13 (agentDrain.ts): hold new deliveries, reminders,
   * notices and starts, and resolve once every live process is quiet or the
   * deadline (at most AGENT_DRAIN_MAX_DEADLINE_MS) passed. Stops nothing.
   * Step 14: with `agentId`, that agent's input only (no start is held).
   */
  beginDrain(options: AgentDrainOptions): Promise<AgentDrainSummary> {
    return this.drain.begin(options);
  }

  /** Reconciler step 13: stop holding; the held deliveries and starts go on. Step 14: `agentId` ends that agent's drain only. */
  endDrain(agentId?: string): void {
    this.drain.end(agentId);
  }

  /** Reconciler step 13: the drain's progress now (the machine-wide one, or `agentId`'s); null when that drain does not hold. */
  drainProgress(agentId?: string): AgentDrainProgress | null {
    return this.drain.progress(agentId);
  }

  /**
   * Every live process that is not quiet (the idle definition without the
   * untold inbox a drain holds; one that cannot run with no turn in flight
   * is quiet, agentStopWaitReason), and every spawn already under way (its
   * first turn is coming). A process being stopped is going away and is not
   * waited for; a queued start is held by the drain.
   */
  private computeDrainProgress(only: string | null): AgentDrainProgress {
    const notQuiet: AgentDrainNotQuiet[] = [];
    const notRunnable: AgentDrainNotRunnable[] = [];
    let live = 0;
    for (const [agentId, ap] of this.agents) {
      if (only !== null && agentId !== only) continue;
      if (this.runtimeStopping(ap)) continue;
      live += 1;
      const wait = this.agentStopWait(agentId, ap, { ignoreUntoldInbox: true });
      if (wait.notIdle) notQuiet.push({ agentId, reason: wait.notIdle });
      else if (wait.notRunnable && wait.settled) notRunnable.push({ agentId, reason: wait.notRunnable, settled: wait.settled });
    }
    for (const agentId of this.agentStarts.snapshot().startingAgentIds) {
      if (only !== null && agentId !== only) continue;
      if (this.agents.has(agentId)) continue;
      live += 1;
      notQuiet.push({ agentId, reason: "agent_busy" });
    }
    return { live, notQuiet, notRunnable };
  }

  /**
   * The drain ended without a shutdown: what it held goes on as after a
   * credential release. The held inbox is flushed (a new turn when idle, a
   * notice when busy); a row the agent already read during the drain
   * (`raft message check`/`read` through this daemon) was taken out of the
   * inbox by consumeVisibleMessages, so it is not delivered again. Held
   * transient deliveries are routed again (the model-seen gate drops a seen
   * one), App Inbox notices are re-offered, and the start queue runs.
   *
   * Step 14 (`only`, a /migrate source): that agent's only. When the
   * migration stopped it first, nothing is handed over here: its inbox went
   * with the process (unread on the server, the target answers it), its held
   * transient deliveries are dropped (routing one again could start it here),
   * and no reminder is asked for.
   */
  private releaseDrainHeld(only: string | null): void {
    const transients = only === null ? this.drainHeldTransients : this.drainHeldTransients.filter((held) => held.agentId === only);
    this.drainHeldTransients = only === null ? [] : this.drainHeldTransients.filter((held) => held.agentId !== only);
    const live = (agentId: string) => {
      const ap = this.agents.get(agentId);
      return ap !== undefined && !this.runtimeStopping(ap);
    };
    const redeliver = only === null || live(only) ? transients : [];
    let flushed = 0;
    for (const [agentId, ap] of [...this.agents]) {
      if (only !== null && agentId !== only) continue;
      if (this.runtimeStopping(ap)) continue;
      if (ap.inbox.length > 0 && this.flushRuntimeErrorDeliveryBackoff(agentId)) flushed += 1;
      if (this.isApmIdle(ap)) this.drainAppInboxAfterIdleTransition(agentId);
    }
    for (const held of redeliver) void this.deliverMessage(held.agentId, held.message, held.traceContext);
    // An idle agent whose reminder the drain refused: one more idle edge, so
    // the reminder is asked for again now and not at some later turn end.
    const refusedReminders = only === null ? [...this.drainRefusedIdleNotices] : [...this.drainRefusedIdleNotices].filter((agentId) => agentId === only);
    for (const agentId of refusedReminders) this.drainRefusedIdleNotices.delete(agentId);
    let remindersAskedAgain = 0;
    for (const agentId of refusedReminders) {
      const ap = this.agents.get(agentId);
      if (!ap || this.runtimeStopping(ap) || !this.isApmIdle(ap) || this.hasUntoldInboxWork(ap)) continue;
      remindersAskedAgain += 1;
      this.notifyAgentWorkingToIdle(agentId);
    }
    this.recordDaemonEvent("daemon.agent.drain.released", {
      reminders_asked_again: remindersAskedAgain,
      host: "legacy",
      flushed_agents: flushed,
      transient_count: redeliver.length,
      ...(only === null ? {} : { agentId: only, agent_live: live(only), transients_dropped: transients.length - redeliver.length }),
      queued_starts: this.agentStarts.snapshot().queueDepth,
    });
    if (only === null) this.pumpAgentStartQueue();
  }

  /**
   * The Server's current flag-derived config fields (`server:features`, shared
   * featuresChanged.ts) for every agent this manager holds; they all belong to
   * the connection's Server. An agent already on them is left alone. Otherwise
   * its live config and restart snapshot take the new values, its next spawn
   * tells it what changed, and a running process whose session has drifted
   * from them is stopped once it is idle (reconcileSpec) so the next wake
   * starts on the new standing prompt. A per-turn driver needs no stop: its
   * next spawn already reads the updated config. A start already queued or spawning keeps the values its
   * `agent:start` carried.
   *
   * Agents on the OAR host get the same answer from the host router
   * (OarAgentHost.applyServerFeatures).
   */
  applyServerFeatures(features: AgentServerFeatures): void {
    this.serverFeaturesGeneration += 1;
    this.lastAppliedServerFeatures = features;
    for (const [agentId, ap] of this.agents) this.applyServerFeaturesToProcess(agentId, ap, features);
    for (const [agentId, snapshot] of [...this.lifecycleRecords.restartSnapshotEntries()]) {
      if (this.agents.has(agentId)) continue;
      const before = pickAgentServerFeatures(snapshot.config);
      if (agentServerFeaturesEqual(before, features)) continue;
      if (!this.serverFeaturesNoticeBase.has(agentId)) this.serverFeaturesNoticeBase.set(agentId, before);
      this.lifecycleRecords.setRestartSnapshot(agentId, { ...snapshot, config: withAgentServerFeatures(snapshot.config, features) });
      logger.info(`[Agent ${agentId}] Server features changed (${changedAgentServerFeatureKeys(before, features).join(", ")}); the next start uses them`);
    }
    // View Context: the same answer gates every agent this daemon holds or keeps data for.
    this.contextView.applyServerFlag(features.agentContextView === true, [
      ...this.agents.keys(),
      ...[...this.lifecycleRecords.restartSnapshotEntries()].map(([agentId]) => agentId),
      ...this.hostedSessions?.agentIds() ?? [],
      ...this.lastHostedSessions.keys(),
    ]);
  }

  /** RFC 060: a session of another host opened or took a newer start; View Context reads it as it does this host's agents. */
  noteHostedContextViewSession(agentId: string, session: HostedAgentSession, enabled: boolean): void {
    this.lastHostedSessions.set(agentId, session);
    this.contextView.onAgentStart(agentId, enabled);
  }

  /** RFC 060: the Server accepted a message an agent of another host sent. */
  noteHostedMessageCommitted(agentId: string, input: { messageId: string; route: "send" | "task_reply" }): void {
    this.contextView.onMessageCommitted(agentId, input.messageId, input.route);
  }

  /** View Context v0: `agent:context_view_request` (answered by one result POST, never a frame). */
  handleAgentContextViewRequest(frame: unknown): Promise<void> {
    return this.contextView.handleRequest(frame);
  }

  /** View Context v0: after every `ready`, each running agent's availability again (the Server keeps only the latest). */
  reportAgentContextViewAvailability(trigger: string): void {
    this.contextView.reportAllRunning(trigger);
  }

  /** What the context view needs to know of an agent: its runtime, session and where its session files may be read. */
  private contextViewAgentFacts(agentId: string): ContextViewAgentFacts {
    const agent = this.agents.get(agentId);
    const idle = this.lifecycleRecords.getRestartSnapshot(agentId);
    // RFC 060: running on another host; or it ran there last, and its messages can still be viewed.
    // A snapshot here is newer: a start on the other host removes it (AgentHostRouter), one here removes `lastHosted`.
    const hosted = agent ? null : this.hostedSessions?.get(agentId) ?? null;
    const lastHosted = agent || hosted || idle ? null : this.lastHostedSessions.get(agentId) ?? null;
    // A running process's own runtime and model (a rebind may name others: reconcileSpec).
    const config = agent ? { ...agent.config, ...agent.startedSpec.reported } : hosted?.config ?? idle?.config ?? lastHosted?.config ?? null;
    const runtime = config?.runtime ?? null;
    const sessionId = agent?.sessionId || hosted?.sessionId || idle?.sessionId || lastHosted?.sessionId || null;
    const workspaceDir = path.join(this.dataDir, agentId);
    const homeDir = agent?.runtime.currentRuntimeHomeDir
      || (config ? resolveRuntimeHomeDir(config, this.runtimeSessionHomeDir, workspaceDir, { agentId, slockHome: this.slockHome }) : this.runtimeSessionHomeDir);
    const transcriptHomes = config ? runtimeTranscriptHomesForConfig(config, this.runtimeSessionHomeDir) : {};
    const serverId = config?.runtimeContext?.serverId ?? null;
    if (isPiRequestLogRuntime(runtime)) {
      const root = this.contextView.requestLogRoot(agentId, serverId);
      return {
        runtime,
        serverId,
        sessionId,
        running: Boolean(agent || hosted),
        sessionRoot: root,
        allowedRoots: root ? [root] : [],
        resolveSessionFile: () => {
          const file = root && sessionId ? piRequestLogFile(root, sessionId) : null;
          return file && existsSync(file) ? file : null;
        },
      };
    }
    return {
      runtime,
      serverId,
      sessionId,
      running: Boolean(agent || hosted),
      sessionRoot: runtime === "claude"
        ? path.join(homeDir, ".claude", "projects")
        : runtime === "kimi-sdk"
          ? transcriptHomes.kimiCodeHome ?? null
          : runtime === "codex"
            ? codexContextSessionRoot(homeDir)
            : null,
      // Codex: its rollouts alone, never the rest of the Codex home or the workspace.
      allowedRoots: runtime === "codex"
        ? [codexContextSessionRoot(homeDir)]
        : runtime ? allowedTranscriptRootsForRuntime(runtime, homeDir, workspaceDir, transcriptHomes) : [],
      resolveSessionFile: () => {
        if (!runtime || !sessionId) return null;
        // No fallback dir: a miss writes no handoff marker into the workspace.
        const resolved = resolveRuntimeSessionRefDetailed(runtime, sessionId, homeDir, undefined, transcriptHomes);
        // A compressed Codex rollout can't be read; it's plain again once Codex resumes it.
        return resolved.resolution === "native" && resolved.ref.path && !resolved.ref.path.endsWith(".zst") ? resolved.ref.path : null;
      },
    };
  }

  /**
   * Whether the current connection's server answers `server:features:request`
   * (core: from `machine:context`, off on every disconnect). Only gates
   * rebinds; the last answer is kept across a plain reconnect (a start that
   * arrives after it is newer anyway).
   */
  setServerFeaturesCapable(capable: boolean): void {
    this.serverFeaturesCapable = capable;
  }

  /**
   * Forget the last answer (core: a context without the capability, or for
   * another server): a start is then compared with nothing.
   */
  forgetServerFeatures(): void {
    this.lastAppliedServerFeatures = null;
  }

  /**
   * applyServerFeatures for one live process: its config (and restart
   * snapshot) take `features` (adoptServerFeatures), and the process is
   * decided again.
   */
  private applyServerFeaturesToProcess(agentId: string, ap: AgentProcess, features: AgentServerFeatures): void {
    this.adoptServerFeatures(agentId, ap, features);
    this.reconcile(agentId, ap, "signal");
  }

  /**
   * A live process's config (and restart snapshot) take `features`. A
   * process whose session started on other values gets the notice base, so
   * its next spawn says what changed. Decides nothing (reconcile does).
   */
  private adoptServerFeatures(agentId: string, ap: AgentProcess, features: AgentServerFeatures): void {
    const configChanged = !agentServerFeaturesEqual(pickAgentServerFeatures(ap.config), features);
    if (configChanged || !agentServerFeaturesEqual(ap.sessionServerFeatures, features)) {
      if (!this.serverFeaturesNoticeBase.has(agentId)) this.serverFeaturesNoticeBase.set(agentId, ap.sessionServerFeatures);
      if (configChanged) {
        ap.config = withAgentServerFeatures(ap.config, features);
        const snapshot = this.lifecycleRecords.getRestartSnapshot(agentId);
        if (snapshot) {
          // The snapshot keeps its credential-free config; only the feature fields change.
          this.lifecycleRecords.setRestartSnapshot(agentId, { ...snapshot, config: withAgentServerFeatures(snapshot.config, features) });
        }
      }
      logger.info(`[Agent ${agentId}] Server features changed (${changedAgentServerFeatureKeys(ap.sessionServerFeatures, features).join(", ")})`);
    }
  }

  /** The last answer, when it was applied after this agent's latest start config was taken. */
  private serverFeaturesNewerThanStart(agentId: string): AgentServerFeatures | null {
    const taken = this.startConfigFeaturesGeneration.get(agentId);
    if (!this.lastAppliedServerFeatures || taken === undefined || this.serverFeaturesGeneration <= taken) return null;
    return this.lastAppliedServerFeatures;
  }

  /** What this process's runtime makes of the server features (serverFeatureChangeNeedsRestart). */
  private serverFeaturesRuntimeFacts(ap: AgentProcess): { supportsSubagents: boolean; rotatesSessions: boolean } {
    return {
      supportsSubagents: ap.driver.supportsSubagents === true,
      rotatesSessions: typeof ap.runtime.rotateSessionIfDue === "function",
    };
  }

  /**
   * The one reconcile entry for a live process (reconciler steps 6, 7, 8b
   * and 9): health first, then spec drift, then cold idle. A broken process
   * (stalled with work queued, reconcileHealth) is stopped at once (E2) and
   * started again for its queued work; spec drift and cold idle stop an idle
   * process on purpose (beginColdIdleRecycleStop), keeping its session for the
   * next start, which decides it (chooseSession). Nothing is stored between
   * calls but the one cold-idle read in flight, the stall deadline and the
   * stalled-replacement streak, and `trigger` is only traced: any call
   * decides the same, and a process already being stopped is not stopped
   * again. The fact that makes a process idle calls this (`trigger`: a turn
   * end, which is also where written input, a read message and a tracked
   * mention are consumed; input written into the turn that ended settling
   * with no turn of its own; the last background task's end; queued work
   * purged; a desired-spec signal); so do a delivery queued behind a turn and
   * the stall deadline (armStallDeadline); the 10-minute sweep calls it too.
   *
   * Returns whether the process has drifted from its spec (it is being
   * stopped for it, or will be at its next idle moment): no session rotation
   * starts under it. A cold-idle read in flight is not a stop and returns
   * false: it holds nothing (a rotation that changes the session voids it).
   */
  private reconcile(agentId: string, ap: AgentProcess, trigger: RuntimeSpecReconcileTrigger): boolean {
    return this.reconcileProcess(agentId, ap, trigger).specDrift;
  }

  /** `reconcile`, with what the cold-idle step did (the sweep counts it). */
  private reconcileProcess(agentId: string, ap: AgentProcess, trigger: RuntimeSpecReconcileTrigger): { specDrift: boolean; cold: ColdIdleStep } {
    // Reconciler step 13: every edge that can make a process idle can make it quiet.
    this.drain.check();
    if (this.reconcileHealth(agentId, ap, trigger)) return { specDrift: false, cold: { kind: "skipped", reason: "stopping" } };
    if (this.reconcileSpec(agentId, ap, trigger)) {
      // A drifted process is stopped for its spec (the stop says whether it
      // was also past the cold gap); the next start reads its context.
      this.idleHolds.forget(agentId, "cold_idle");
      return { specDrift: true, cold: { kind: "skipped", reason: "spec_drift" } };
    }
    return { specDrift: false, cold: this.reconcileColdIdle(agentId, ap, trigger) };
  }

  /**
   * Reconciler steps 6 and 7 (rules 6 and 7): a process whose session has
   * drifted from its config's runtime spec (`specDrift`) is stopped once it
   * is idle (agentIdle.ts, nothing else: a runtime error or an invalid
   * credential does not hold it), on purpose: the next wake starts on the
   * new config, resuming the session unless the drift needs a new one
   * (`sessionDropReason`: another runtime, or a Codex model). A process that
   * is not idle is left alone until the next `reconcile`.
   *
   * Returns whether the process has drifted.
   */
  private reconcileSpec(agentId: string, ap: AgentProcess, trigger: RuntimeSpecReconcileTrigger): boolean {
    const drift = this.specDrift(ap);
    // A config naming another runtime than the one this process is bound to:
    // the binding fence refuses its input and its output (`runtime_mismatch`)
    // from now on, its turn end included, so it would never be seen idle and
    // every delivery would be refused for as long as it lives. It is stopped
    // now, idle or not (also a per-turn process, or a config this Computer
    // cannot read, whose drift is empty). A turn it was running is lost with
    // it, as at a person's stop: messages it had not read stay unread on the
    // server, the ones it had already taken are not delivered again.
    const runtimeChanged = this.runtimeProcessBindingFence.refusesRuntime(ap);
    if (drift.length === 0 && !runtimeChanged) {
      // Nothing waits on an idle moment for the spec any more.
      this.idleHolds.forget(agentId, "spec_restart");
      return false;
    }
    // Gone, or already being stopped: its successor spawns from the updated config.
    if (this.agents.get(agentId) !== ap || ap.exit.kind !== "live" || ap.gatedSteering.expectedTerminationReason !== null) return true;
    if (runtimeChanged) {
      this.stopForSpecDrift(agentId, ap, drift.includes("runtime") ? drift : ["runtime", ...drift], trigger);
      return true;
    }
    // Reconciler step 15: deliveries held for the old account wait for the
    // new process (the stop's close starts it on them), not for this one. The
    // same when the drift drops the session (another runtime, or a Codex
    // model): this session would never tell them, and a delivery held for the
    // old runtime's usage limit made a switch away from it wait for that limit
    // to reset (#triage:#263).
    const nextSessionTakesInbox = drift.includes("credential_account") || sessionDropReason(ap.startedSpec, runtimeSpecOf(ap.config)) !== null;
    const idleOptions = nextSessionTakesInbox ? { ignoreUntoldInbox: true } : {};
    if (this.observeIdleHold(agentId, ap, "spec_restart", this.agentNotIdle(agentId, ap, idleOptions)) !== null) return true;
    this.stopForSpecDrift(agentId, ap, drift, trigger);
    return true;
  }

  /**
   * Reconciler step 8b (RFC 070 cold idle, wakeSessionRecycle.ts): an idle
   * process (agentNotIdle, the one idle definition: background tasks, input
   * not yet consumed and untold messages all hold it) with no event for
   * longer than the cold gap has its session's context read from the
   * transcript; past the threshold, it is stopped (`cold_idle_recycle`) and
   * the next wake's start recycles the session. The time compare runs first
   * and costs nothing; the read is async (one in flight per agent, never
   * awaited here). When it answers, everything is decided again (the process,
   * its session, a stop already underway, idle, the time since the last
   * event: a message may have arrived meanwhile) before anything is stopped.
   */
  private reconcileColdIdle(agentId: string, ap: AgentProcess, trigger: RuntimeSpecReconcileTrigger): ColdIdleStep {
    if (this.agents.get(agentId) !== ap || ap.exit.kind !== "live") return { kind: "skipped", reason: "not_idle" };
    if (ap.gatedSteering.expectedTerminationReason !== null) return { kind: "skipped", reason: "stopping" };
    const gate = this.coldIdleGateFor(ap);
    if (!gate.pass) {
      this.idleHolds.forget(agentId, "cold_idle");
      return { kind: "skipped", reason: gate.reason };
    }
    const inFlight = this.coldIdleChecks.get(agentId);
    if (inFlight) return { kind: "checking", outcome: inFlight };
    if (this.observeIdleHold(agentId, ap, "cold_idle", this.agentNotIdle(agentId, ap)) !== null) return { kind: "skipped", reason: "not_idle" };
    const outcome = this.checkColdIdle(agentId, ap, gate.sessionId, trigger)
      .catch((err: unknown): ColdIdleOutcome => {
        logger.warn(`[Agent ${agentId}] Cold-idle check failed: ${err instanceof Error ? err.message : String(err)}`);
        return "session_facts_unavailable";
      })
      .finally(() => {
        if (this.coldIdleChecks.get(agentId) === outcome) this.coldIdleChecks.delete(agentId);
      });
    this.coldIdleChecks.set(agentId, outcome);
    return { kind: "checking", outcome };
  }

  private coldIdleGateFor(ap: AgentProcess) {
    return coldIdleGate({
      config: ap.config,
      liveSessionId: ap.sessionId,
      lastEventAtMs: ap.runtimeProgress.lastEventAt,
      // The version this process runs (its launch's, else the last detected,
      // latched), read only for a runtime with a floor.
      runtimeCliVersion: COLD_IDLE_RUNTIME_VERSION_FLOORS[ap.config.runtime ?? "claude"] ? this.runtimeCliVersionOf(ap) : undefined,
      nowMs: this.clockNow(),
    });
  }

  /** The async half of reconcileColdIdle: read the facts, decide again, stop. */
  private async checkColdIdle(agentId: string, ap: AgentProcess, sessionId: string, trigger: RuntimeSpecReconcileTrigger): Promise<ColdIdleOutcome> {
    const facts = await this.readSessionResumeFacts(ap.config.runtime ?? "claude", sessionId, this.runtimeSessionHomeDir);
    // Decided again from scratch: the read took time.
    if (this.agents.get(agentId) !== ap || ap.exit.kind !== "live") return "not_idle";
    if (ap.gatedSteering.expectedTerminationReason !== null) return "stopping";
    const gate = this.coldIdleGateFor(ap);
    if (!gate.pass) return gate.reason;
    if (gate.sessionId !== sessionId) return "session_changed";
    if (this.observeIdleHold(agentId, ap, "cold_idle", this.agentNotIdle(agentId, ap)) !== null) return "not_idle";
    const verdict = decideColdIdle(facts, { config: gate.config, lastEventAtMs: ap.runtimeProgress.lastEventAt, nowMs: this.clockNow() });
    if (!verdict.cold) return verdict.reason;
    const drift = this.specDrift(ap);
    if (drift.length > 0) {
      // Drifted while the facts were read, and idle: the spec stop, which
      // says the session was cold too.
      this.stopForSpecDrift(agentId, ap, drift, trigger, verdict);
      return "spec_drift";
    }
    logger.info(`[Agent ${agentId}] Stopping cold idle runtime (idle ${Math.round(verdict.idleMs / 60_000)}m, ~${Math.round(verdict.priorContextTokens / 1000)}k context, session ${sessionId}, ${ap.inbox.length} notified unread, ${trigger}); next wake decides resume vs fresh briefing`);
    this.recordDaemonEvent("daemon.agent.cold_idle_stop", {
      agentId,
      session_id: sessionId,
      idle_ms: verdict.idleMs,
      prior_context_tokens: verdict.priorContextTokens,
      ...recycleThresholdTraceAttrs(verdict.thresholds),
      notified_unread_count: ap.inbox.length,
      trigger,
    });
    this.beginColdIdleRecycleStop(agentId, ap, "Cold idle", "cold_idle_recycle");
    return "stopped";
  }

  /**
   * The kinds this process's session has drifted on (runtimeSpec.ts): its
   * spec against its config's, and its server features (serverFeaturesDrift).
   * A per-turn runtime (gemini, cursor, copilot, opencode, antigravity) has
   * none: every turn is a new process, spawned from the config as it is then.
   * A runtime change still stops a per-turn process (`reconcileSpec`): the
   * binding fence refuses the rest of its turn.
   */
  private specDrift(ap: AgentProcess): RuntimeSpecDriftKind[] {
    if (ap.driver.lifecycle.kind === "per_turn") return [];
    const drift: RuntimeSpecDriftKind[] = runtimeSpecDrift(ap.startedSpec, runtimeSpecOf(ap.config));
    if (serverFeaturesDrift(ap.sessionServerFeatures, pickAgentServerFeatures(ap.config), this.serverFeaturesRuntimeFacts(ap)).length > 0) drift.push("features");
    if (ap.credentialAccountChanged) drift.push("credential_account");
    return drift;
  }

  /**
   * Reconciler step 11 (Tenny's decision 1): a process stopped on purpose
   * whose config names another runtime, or asks for another host, is never
   * started again by this host; the server's next start is
   * (specChangeNeedsServerStart). Its spec stop releases it at once
   * (`stopForSpecDrift`); a close whose config changed so during another
   * idle stop keeps no restart snapshot (actOnCleanExit).
   */
  private specStopHandsBackToServer(ap: AgentProcess): boolean {
    // Also another runtime in a config this Computer cannot read (the spec
    // compares nothing then; the binding fence still refuses the process).
    return specChangeNeedsServerStart(ap.startedSpec, runtimeSpecOf(ap.config)) || this.runtimeProcessBindingFence.refusesRuntime(ap);
  }

  /**
   * The session this process leaves for its next start: none when its
   * config's runtime (or Codex model) is not the one its session started on.
   */
  private sessionIdAfterExit(ap: AgentProcess): string | null {
    return sessionDropReason(ap.startedSpec, runtimeSpecOf(ap.config)) ? null : ap.sessionId;
  }

  private stopForSpecDrift(
    agentId: string,
    ap: AgentProcess,
    drift: readonly RuntimeSpecDriftKind[],
    trigger: RuntimeSpecReconcileTrigger,
    /** The cold-idle read that found the session cold, when the drift was found after it (reconcileColdIdle). */
    cold?: Extract<ColdIdleVerdict, { cold: true }>,
  ): void {
    const featureKeys = drift.includes("features") ? changedAgentServerFeatureKeys(ap.sessionServerFeatures, pickAgentServerFeatures(ap.config)) : [];
    // The next spawn says what changed, also after a rebind that set no base.
    if (featureKeys.length > 0 && !this.serverFeaturesNoticeBase.has(agentId)) this.serverFeaturesNoticeBase.set(agentId, ap.sessionServerFeatures);
    // Kinds only: never an env var's (or any other) key or value.
    this.recordDaemonEvent("daemon.agent.spec_restart_stop", {
      agentId,
      session_id: ap.sessionId,
      drift: drift.join(","),
      ...(featureKeys.length > 0 ? { changed_keys: featureKeys.join(",") } : {}),
      new_session: this.sessionIdAfterExit(ap) === null && ap.sessionId !== null,
      ...(this.specStopHandsBackToServer(ap) ? { hand_to_server: true } : {}),
      trigger,
      host: "legacy",
      ...this.specStopColdAttrs(ap, cold),
    });
    if (this.specStopHandsBackToServer(ap)) {
      // Reconciler step 11 (decision 1): another runtime or host. Released at
      // once, as the OAR host releases a session it ends for its spec: no
      // restart state, so nothing that arrives during the stop's grace
      // restarts it here. A delivery finds no process and is refused to the
      // server (a tracked mention ends IDENTITY_UNKNOWN and the server
      // redelivers it untracked), whose start the host router places; that
      // start waits for this process's exit (`exitingRuntimes`).
      logger.info(`[Agent ${agentId}] Stopping runtime for another runtime or host (${drift.join(", ")}; ${trigger}); the server starts it at its next message`);
      this.recordDaemonEvent("daemon.agent.spec_restart_handed_to_server", { agentId, launchId: ap.launchId || undefined, stage: "stop" });
      this.specHandbacks.mark(agentId);
      void this.stopAgent(agentId, { silent: true });
      return;
    }
    logger.info(`[Agent ${agentId}] Stopping idle runtime for a new runtime spec (${drift.join(", ")}; session ${ap.sessionId ?? "none"}, ${trigger}); next wake starts on it`);
    this.beginColdIdleRecycleStop(agentId, ap, "Runtime spec", "spec_restart");
  }

  /**
   * What a spec stop says of cold idle (reconciler step 8b): `cold` with its
   * facts when a cold-idle read found the session cold just before; else
   * `cold_gap` when the process is past the cold gap (the stop does not wait
   * for the context read). Either way the next start's chooseSession reads
   * the context and decides whether the session is recycled (rule 3).
   */
  private specStopColdAttrs(ap: AgentProcess, cold: Extract<ColdIdleVerdict, { cold: true }> | undefined): Record<string, unknown> {
    if (cold) return { cold: true, idle_ms: cold.idleMs, prior_context_tokens: cold.priorContextTokens };
    const gate = this.coldIdleGateFor(ap);
    return gate.pass ? { cold_gap: true, idle_ms: gate.sinceEventMs } : {};
  }

  /**
   * A turn end left input queued (written while the turn ran): the process
   * reads as not idle until the window passes with no new turn, or until the
   * turn that starts on it ends (agentIdle.ts `queuedInputPending`). Nothing
   * else reaches the moment the window passes, so it is decided again then;
   * a turn that starts ends with its own turn end. One timer per process; a
   * new turn or its exit clears it. A Node timer may fire up to a millisecond
   * before `Date.now()` has moved the full window; the window has then not
   * passed by the clock the decision reads (`queuedInputPending`), and with
   * nothing else to decide it again the agent would stay held: the timer
   * waits out the rest instead.
   */
  private armQueuedInputSettle(agentId: string, ap: AgentProcess): void {
    this.clearQueuedInputSettle(ap);
    const queued = ap.deliveryConsumption.queuedForNextTurn();
    if (!queued) return;
    const delayMs = Math.max(0, queued.turnEndAtMs + this.queuedInputSettleMs - Date.now());
    ap.queuedInputSettleTimer = setTimeout(() => {
      ap.queuedInputSettleTimer = undefined;
      if (this.agents.get(agentId) !== ap || ap.exit.kind !== "live") return;
      const pending = ap.deliveryConsumption.queuedForNextTurn();
      if (pending && !pending.taken && Date.now() - pending.turnEndAtMs < this.queuedInputSettleMs) {
        this.armQueuedInputSettle(agentId, ap);
        return;
      }
      this.reconcile(agentId, ap, "queued_input_settled");
    }, delayMs);
    ap.queuedInputSettleTimer.unref?.();
  }

  private clearQueuedInputSettle(ap: AgentProcess): void {
    if (ap.queuedInputSettleTimer !== undefined) clearTimeout(ap.queuedInputSettleTimer);
    ap.queuedInputSettleTimer = undefined;
  }

  /** A cold-idle stop (or a spec restart), or the end of a turn on a runtime the daemon
   * stops after every turn, must not turn the agent's deliberately-unread,
   * already-notified messages into an immediate restart wake: they stay unread
   * on the server and surface at the next real wake. Anything not yet told to
   * the session still wakes it as before.
   *
   * Task #389 (#ops-support #106): without the turn-end case, an opencode agent
   * that answered without reading one announced message was respawned at once
   * to be told about it again, by a new process with no record of the notice:
   * 385 paid turns in 74 minutes, stopped only by an unrelated runtime error. */
  private isNotifiedDeferralAtColdIdleStop(
    ap: AgentProcess,
    terminationReason: ApmExpectedTerminationReason,
    message: AgentMessage,
  ): boolean {
    // A cold-idle stop counts only what was told before it was decided: a
    // message told to the dying process after the SIGTERM still wakes it.
    return (terminationReason === "cold_idle_recycle" || terminationReason === "turn_end")
      && ap.notifications.hasContributedMessage(message, ap.sessionId, terminationReason === "cold_idle_recycle" ? ap.coldIdleStopToldMark : undefined);
  }

  private flushPendingDirectStdinNotificationOnRuntimeProgress(
    agentId: string,
    ap: AgentProcess,
    source: string,
  ): boolean {
    if (ap.notifications.pendingCount === 0) return false;
    if (this.isApmIdle(ap)) return false;
    if (!ap.sessionId) return false;
    if (!ap.driver.supportsStdinNotification) return false;
    if (ap.runtime.descriptor.busyDelivery !== "direct") return false;
    if (this.compactionGateClosed(ap)) return false;
    if (ap.gatedSteering.reviewing) return false;

    this.recordDaemonEvent("daemon.agent.stdin_notification.retry_signal", {
      agentId,
      runtime: ap.config.runtime,
      model: ap.config.model,
      launchId: ap.launchId || undefined,
      source,
      mode: "busy",
      pending_notification_count: ap.notifications.pendingCount,
      inbox_count: ap.inbox.length,
      session_id_present: true,
    });
    return this.sendStdinNotification(agentId, { forceUnsupportedRetry: true });
  }

  private clearRuntimeErrorDeliveryBackoff(ap: AgentProcess): void {
    if (ap.runtimeErrorDeliveryBackoff.kind === "backing_off" && ap.runtimeErrorDeliveryBackoff.timer) {
      clearTimeout(ap.runtimeErrorDeliveryBackoff.timer);
    }
    ap.runtimeErrorDeliveryBackoff = createRuntimeErrorDeliveryBackoffState();
  }

  private clearPendingTrajectoryTimer(ap: AgentProcess): void {
    if (ap.pendingTrajectory?.timer) {
      clearTimeout(ap.pendingTrajectory.timer);
    }
    ap.pendingTrajectory = null;
  }

  private clearActivityHeartbeat(ap: AgentProcess): void {
    if (ap.activityHeartbeat.kind === "inactive") return;
    clearInterval(ap.activityHeartbeat.timer);
    ap.activityHeartbeat = { kind: "inactive" };
  }

  /** `turnMessages` when these messages start a new turn (handed to an idle agent or a fresh process). */
  private broadcastMessageReceivedActivity(agentId: string, turnMessages?: AgentMessage[]): void {
    const trigger = turnMessages
      ? turnTriggerFromMessages(turnMessages.filter((message) => !runtimeProfileNotificationFromMessage(message)))
      : undefined;
    const previousTurn = turnMessages
      ? this.turnSummaries.begin(agentId, Date.now(), trigger, this.agents.get(agentId)?.lastActivityKind === "error" ? "failed" : "unknown")
      : [];
    this.broadcastActivity(agentId, "working", "Message received", previousTurn, undefined, "model_request_started", undefined, undefined, undefined, undefined, undefined, undefined, trigger);
  }

  private toolActivityDetailKind(toolName: string): AgentActivityDetailKind {
    switch (resolveToolSemantic(toolName) ?? toolName) {
      case "bash":
        return "running_command";
      case "check_messages":
      case "receive_message":
        return "checking_messages";
      default:
        return "tool_started";
    }
  }

  private disposeAgentProcessTimers(
    ap: AgentProcess,
    options: { includeCompactionWatchdog?: boolean } = {},
  ): void {
    this.clearRuntimeErrorDeliveryBackoff(ap);
    clearSessionReadyDeliveryRetry(ap);
    this.clearPendingTrajectoryTimer(ap);
    this.clearActivityHeartbeat(ap);
    this.clearRuntimeStartupTimeout(ap);
    if (options.includeCompactionWatchdog ?? true) {
      this.clearCompactionWatchdog(ap);
    }
    this.clearReviewWatchdog(ap);
    this.clearStallDeadline(ap);
  }

  /**
   * Reconciler step 9: one timer per process with queued work, at the moment
   * it would cross its stall threshold (stalledWithWork's `deadlineInMs`).
   * It only decides the process again (`stall_deadline`), as
   * armQueuedInputSettle does: when it fires after progress, that decision
   * finds the progress recent and arms the next deadline; with no work
   * queued any more it arms none. Cleared at the process's exit.
   */
  private armStallDeadline(agentId: string, ap: AgentProcess, delayMs: number): void {
    this.clearStallDeadline(ap);
    ap.stallDeadlineTimer = setTimeout(() => {
      ap.stallDeadlineTimer = undefined;
      if (this.agents.get(agentId) !== ap || ap.exit.kind !== "live") return;
      this.reconcile(agentId, ap, "stall_deadline");
    }, Math.max(0, delayMs));
    ap.stallDeadlineTimer.unref?.();
  }

  private clearStallDeadline(ap: AgentProcess): void {
    if (ap.stallDeadlineTimer !== undefined) clearTimeout(ap.stallDeadlineTimer);
    ap.stallDeadlineTimer = undefined;
  }

  /**
   * Progress, or a turn start, of a process with queued work and no deadline
   * armed (its last decision found nothing to wait for: an open tool, a hold,
   * no turn): the earliest moment it could be stalled is the stall threshold
   * from now (stalledWithWork's longer non-stdin threshold re-arms from there).
   * Decides nothing; costs one field read per event.
   */
  private armStallDeadlineForQueuedWork(agentId: string, ap: AgentProcess): void {
    if (ap.stallDeadlineTimer !== undefined || ap.inbox.length === 0) return;
    if (this.agents.get(agentId) !== ap || ap.exit.kind !== "live") return;
    this.armStallDeadline(agentId, ap, RUNTIME_PROGRESS_STALE_MS - ap.runtimeProgress.ageMs());
  }

  /**
   * Ends the process's live delivery backoff. The credential's provider limit
   * goes with it:
   * - own credentials (`agent:<id>`): always, as before the limit was keyed by
   *   credential.
   * - a shared sign-in (`shared:<runtime>`): only on real model output
   *   (`modelOutput`) from a turn this process started after the limit was
   *   recorded, even when this process's own backoff had already ended. That
   *   proves the account serves again, so the limit ends for every agent on
   *   the sign-in (`releaseProviderLimit`). Anything else (an
   *   unclassified error's turn end, turn-start bookkeeping, output streamed
   *   by a turn already running when another agent hit the limit) ends only
   *   this process's live backoff; the shared limit stays for the others.
   */
  private clearRuntimeErrorDeliveryBackoffWithTrace(
    agentId: string,
    ap: AgentProcess,
    resetSource: string,
    { modelOutput = false }: { modelOutput?: boolean } = {},
  ): void {
    const liveActive = ap.runtimeErrorDeliveryBackoff.attempts !== 0 || ap.runtimeErrorDeliveryBackoff.untilMs !== 0;
    // A process whose own backoff is over (or was never armed) can still prove
    // a shared sign-in's limit is gone; skip the key lookup while no limit exists.
    if (!liveActive && !(modelOutput && this.lifecycleRecords.hasProviderLimits())) return;
    const key = providerLimitCredentialKey(agentId, ap.config);
    const keyKind = providerLimitCredentialKeyKind(key);
    const sharedRecord = keyKind === "shared" && modelOutput ? this.lifecycleRecords.getProviderLimit(key, this.clockNow()) : undefined;
    const sharedLimitCleared = Boolean(sharedRecord && ap.runtimeProgress.currentTurnStartedAt >= sharedRecord.recordedAtMs);
    if (!liveActive && !sharedLimitCleared) return;
    const attempts = ap.runtimeErrorDeliveryBackoff.attempts;
    const reason = ap.runtimeErrorDeliveryBackoff.reason;
    this.clearRuntimeErrorDeliveryBackoff(ap);
    const providerLimitCleared = keyKind === "agent" ? this.lifecycleRecords.deleteProviderLimit(key) : sharedLimitCleared;
    const released = sharedRecord && sharedLimitCleared ? this.releaseProviderLimit(key, sharedRecord, "model_output") : null;
    this.recordDaemonEvent("daemon.agent.runtime_error_delivery_backoff.reset", {
      agentId,
      runtime: ap.config.runtime,
      model: ap.config.model,
      launchId: ap.launchId || undefined,
      reason: reason || undefined,
      attempts,
      reset_source: resetSource,
      credential_key_kind: keyKind,
      provider_limit_cleared: providerLimitCleared,
      ...(providerLimitCleared ? { release_cause: "model_output" } : {}),
      ...(released ? { shared_live_backoffs_ended: released.liveBackoffsEnded, shared_cooldowns_ended: released.cooldownsEnded } : {}),
    });
  }

  /**
   * Deletes the credential's provider limit and ends the waits it armed, as
   * if they had run out, through the same handlers their timers call: a live
   * process's delivery backoff with the limit's deadline (held deliveries go
   * to the process), and a closed agent's cooldown a close inside the limit
   * held it in (`holdDeliveriesForProviderLimitBackoff`; it starts from its
   * pending inbox). Only agents whose current config maps to `key`. No process
   * is stopped or restarted.
   */
  private releaseProviderLimit(
    key: ProviderLimitCredentialKey,
    record: ProviderLimitBackoffRecord,
    cause: ProviderLimitReleaseCause,
    { exceptAgentId }: { exceptAgentId?: string } = {},
  ): { liveBackoffsEnded: number; cooldownsEnded: number } {
    this.lifecycleRecords.providerLimitLedger.release(key, cause, { host: "legacy" });
    return this.endProviderLimitWaits(key, record, cause, { exceptAgentId });
  }

  /**
   * The waits a provider limit on `key` armed on this host end as if they had
   * run out (`releaseProviderLimit`); the limit is already gone from the
   * ledger (released here, or by the OAR host: `onProviderLimitChange`).
   */
  private endProviderLimitWaits(
    key: ProviderLimitCredentialKey,
    record: ProviderLimitBackoffRecord,
    cause: ProviderLimitReleaseCause,
    { exceptAgentId }: { exceptAgentId?: string } = {},
  ): { liveBackoffsEnded: number; cooldownsEnded: number } {
    let liveBackoffsEnded = 0;
    let cooldownsEnded = 0;
    const traceRelease = (agentId: string, config: AgentConfig, released: "live_backoff" | "cooldown") => {
      this.recordDaemonEvent("daemon.agent.runtime_error_delivery_backoff.reset", {
        agentId,
        runtime: config.runtime,
        model: config.model,
        reason: record.reason,
        attempts: record.attempts,
        reset_source: "provider_limit_released",
        release_cause: cause,
        released,
        credential_key_kind: providerLimitCredentialKeyKind(key),
      });
    };
    for (const [agentId, ap] of [...this.agents]) {
      if (agentId === exceptAgentId) continue;
      if (providerLimitCredentialKey(agentId, ap.config) !== key) continue;
      if (ap.runtimeErrorDeliveryBackoff.kind !== "backing_off" || ap.runtimeErrorDeliveryBackoff.untilMs !== record.untilMs) continue;
      this.clearRuntimeErrorDeliveryBackoff(ap);
      traceRelease(agentId, ap.config, "live_backoff");
      this.flushRuntimeErrorDeliveryBackoff(agentId);
      liveBackoffsEnded += 1;
    }
    for (const [agentId, cooldown] of [...this.lifecycleRecords.activeSpawnFailBackoffs]) {
      if (agentId === exceptAgentId || this.agents.has(agentId)) continue;
      const config = this.lifecycleRecords.getRestartSnapshot(agentId)?.config;
      if (!config || providerLimitCredentialKey(agentId, config) !== key) continue;
      if (cooldown.untilMs !== record.untilMs || cooldown.reason !== record.reason) continue;
      if (cooldown.timer) clearTimeout(cooldown.timer);
      traceRelease(agentId, config, "cooldown");
      this.onSpawnFailBackoffExpired(agentId);
      cooldownsEnded += 1;
    }
    return { liveBackoffsEnded, cooldownsEnded };
  }

  private clearRuntimeErrorDeliveryBackoffAfterProgress(agentId: string, ap: AgentProcess, eventKind: string, fromSubagent = false): void {
    // Reconciler step 4a: real model output (not a subagent's: it may run on
    // another model) proves the credential works again.
    if (!fromSubagent && RATE_LIMIT_BACKOFF_CLEARING_PROGRESS.has(eventKind)) this.releaseCredentialInvalidOnModelOutput(agentId, ap, eventKind);
    // task #379 (prod readback, 1.0.50): a provider limit backoff must survive
    // the start of the next turn. Claude emits `status: requesting` and stream
    // events as `internal_progress` at the start of EVERY turn, including the
    // one that immediately hits the same limit again, so clearing on them reset
    // the attempts to 1 each time: the delay never grew past ~10 s and a quota-
    // exhausted agent kept starting a turn per incoming message. Only real model
    // output (text/thinking/tool activity) proves the limit has cleared.
    // A subagent's own text/thinking/tool_call carries subagent lineage; it may
    // run on a different, unlimited model, so it is not the limited model
    // recovering (Huaihuai, #10353 review).
    if (ap.runtimeErrorDeliveryBackoff.reason === "rate_limited" && (fromSubagent || !RATE_LIMIT_BACKOFF_CLEARING_PROGRESS.has(eventKind))) {
      this.recordDaemonEvent("daemon.agent.runtime_error_delivery_backoff.reset_skipped", {
        agentId,
        runtime: ap.config.runtime,
        launchId: ap.launchId || undefined,
        reason: "rate_limited",
        attempts: ap.runtimeErrorDeliveryBackoff.attempts,
        event_kind: eventKind,
        from_subagent: fromSubagent,
      });
      return;
    }
    this.clearRuntimeErrorDeliveryBackoffWithTrace(agentId, ap, eventKind, {
      modelOutput: !fromSubagent && RATE_LIMIT_BACKOFF_CLEARING_PROGRESS.has(eventKind),
    });
  }

  /**
   * The delivery backoff a new process of this agent starts with: the
   * provider-limit backoff last armed on its credential (by its previous
   * process, or by any agent on the same shared sign-in), if nothing has
   * cleared it since. Its attempts carry over so the next limit hit keeps
   * growing the delay; a remaining wait holds deliveries as before. A limit
   * whose wait ended over PROVIDER_LIMIT_ATTEMPT_MEMORY_MS ago is gone
   * (pruned on read): the process starts with no backoff.
   */
  private restoreProviderLimitBackoff(agentId: string, config: AgentConfig, launchId: string | null): RuntimeErrorDeliveryBackoffState {
    const record = this.lifecycleRecords.getProviderLimit(providerLimitCredentialKey(agentId, config), this.clockNow());
    if (!record) return createRuntimeErrorDeliveryBackoffState();
    const remainingMs = Math.max(0, record.untilMs - Date.now());
    this.recordProviderLimitBackoffRestored(agentId, config, launchId, record, remainingMs, "process_start");
    return { kind: "backing_off", attempts: record.attempts, reason: record.reason, untilMs: record.untilMs, timer: null };
  }

  /**
   * Another agent on the shared sign-in `key` just hit its provider limit:
   * every other live process on that sign-in enters the same delivery backoff
   * (same deadline and reason) instead of each running into the limit itself.
   * Deliveries are held and flushed by the usual backoff timer; nothing is
   * stopped or restarted. A process already waiting at least as long keeps
   * its own wait.
   */
  private shareProviderLimitWithLiveAgents(sourceAgentId: string, key: ProviderLimitCredentialKey, record: ProviderLimitBackoffRecord): void {
    for (const [agentId, ap] of this.agents) {
      if (agentId === sourceAgentId) continue;
      if (providerLimitCredentialKey(agentId, ap.config) !== key) continue;
      const current = ap.runtimeErrorDeliveryBackoff;
      if (current.kind === "backing_off" && current.untilMs >= record.untilMs) continue;
      if (current.kind === "backing_off" && current.timer) clearTimeout(current.timer);
      ap.runtimeErrorDeliveryBackoff = {
        kind: "backing_off",
        attempts: Math.max(current.attempts, record.attempts),
        reason: record.reason,
        untilMs: record.untilMs,
        timer: null,
      };
      if (ap.inbox.length > 0) this.scheduleRuntimeErrorDeliveryBackoffFlush(agentId, ap);
      this.recordProviderLimitBackoffRestored(agentId, ap.config, ap.launchId, record, Math.max(0, record.untilMs - Date.now()), "shared_credential_limit");
    }
  }

  /**
   * The provider-limit ledger both agent hosts share (providerLimitLedger.ts):
   * the OAR host records and releases limits in it, and this host applies the
   * OAR host's changes to its own agents (`onProviderLimitChange`).
   */
  get providerLimitLedger(): ProviderLimitLedger {
    return this.lifecycleRecords.providerLimitLedger;
  }

  /** Reconciler step 9: the stalled-replacement streaks both agent hosts share (an agent runs on one at a time). */
  get stalledReplacementStreaks(): StalledReplacementStreaks {
    return this.lifecycleRecords.stalledReplacementStreaks;
  }

  /** Reconciler step 10b: the exit streaks both agent hosts share (core.ts hands one to each). */
  get exitStreaks(): ExitStreaks {
    return this.lifecycleRecords.exitStreaks;
  }

  /**
   * A limit the OAR host recorded or released (this host's own changes are
   * applied where they are made): a limit recorded on a shared sign-in holds
   * this host's live agents on it, as one of its own agents hitting it would
   * (`shareProviderLimitWithLiveAgents`); a released one ends the waits it
   * armed here (`endProviderLimitWaits`). An own credential's limit is the
   * OAR agent's alone: nothing here waits on it.
   */
  private onProviderLimitChange(change: ProviderLimitChange): void {
    if (change.kind === "invalid_recorded" || change.kind === "invalid_released") {
      this.applyCredentialInvalidChange(change);
      return;
    }
    if (change.source.host === "legacy") return;
    if (change.kind === "recorded") {
      if (providerLimitCredentialKeyKind(change.key) === "shared") {
        this.shareProviderLimitWithLiveAgents(change.source.agentId ?? "", change.key, change.record);
      }
      return;
    }
    this.endProviderLimitWaits(change.key, change.record, change.cause);
  }

  private recordProviderLimitBackoffRestored(
    agentId: string,
    config: AgentConfig,
    launchId: string | null,
    record: ProviderLimitBackoffRecord,
    remainingMs: number,
    restorePoint: "process_start" | "process_close" | "shared_credential_limit",
  ): void {
    const keyKind = providerLimitCredentialKeyKind(providerLimitCredentialKey(agentId, config));
    this.recordDaemonEvent("daemon.agent.runtime_error_delivery_backoff.restored", {
      agentId,
      runtime: config.runtime,
      model: config.model,
      launchId: launchId || undefined,
      reason: record.reason,
      attempts: record.attempts,
      provider_limit_kind: record.providerLimitKind,
      resets_at_reported: Boolean(record.resetsAt),
      remaining_ms_bucket: remainingMs > 0 ? bucketMs(remainingMs) : "elapsed",
      restore_point: restorePoint,
      restored_from_agent_record: true,
      credential_key_kind: keyKind,
    });
  }

  /**
   * A process closed while the agent's provider-limit backoff still runs.
   * Hold the agent in the spawn-fail cooldown until the backoff ends, as a
   * repeated recoverable close does: `messages` are buffered, later
   * deliveries are buffered by the cooldown gate, and the cooldown expiry
   * starts the agent from that buffer. Returns false when no wait remains.
   */
  private holdDeliveriesForProviderLimitBackoff(agentId: string, ap: AgentProcess, messages: AgentMessage[], source: string): boolean {
    const record = this.lifecycleRecords.getProviderLimit(providerLimitCredentialKey(agentId, ap.config), this.clockNow());
    if (!record) return false;
    const untilMs = record.untilMs;
    const remainingMs = untilMs - this.clockNow();
    if (remainingMs <= 0) return false;
    this.holdClosedAgentInCooldown(agentId, ap, messages, untilMs, record.reason, source);
    this.recordProviderLimitBackoffRestored(agentId, ap.config, ap.launchId, record, remainingMs, "process_close");
    return true;
  }

  /**
   * The closed agent waits in the spawn-fail cooldown until `untilMs`: its
   * restart snapshot is kept, `messages` are buffered, later deliveries are
   * buffered by the cooldown gate, and the cooldown's expiry (or an early
   * release) starts the agent from that buffer. `onExpired` replaces what
   * the expiry does.
   */
  private holdClosedAgentInCooldown(
    agentId: string,
    ap: AgentProcess,
    messages: AgentMessage[],
    untilMs: number,
    reason: string,
    source: string,
    onExpired: () => void = () => this.onSpawnFailBackoffExpired(agentId),
  ): void {
    const nextConfig = this.buildRestartSafeConfig(ap.config, ap.sessionId);
    this.lifecycleRecords.setRestartSnapshot(agentId, {
      config: nextConfig,
      sessionId: ap.sessionId,
      launchId: ap.launchId,
      processInstanceId: ap.processInstanceId,
    });
    this.cancelRuntimeErrorProcessRestart(agentId);
    const previous = this.lifecycleRecords.getSpawnFailBackoff(agentId);
    if (previous?.timer) clearTimeout(previous.timer);
    const timer = setTimeout(onExpired, Math.max(1, untilMs - this.clockNow()));
    timer.unref?.();
    this.lifecycleRecords.activeSpawnFailBackoffs.set(agentId, { kind: "backing_off", attempts: 1, reason, untilMs, timer });
    if (messages.length > 0) {
      this.startingInboxes.bufferMessagesDuringStart(agentId, messages);
    }
    this.assertStartPendingDeliveryInvariants("provider-limit-backoff-process-close");
    this.enterSpawnFailCooldownResidency(agentId, { config: nextConfig, launchId: ap.launchId }, untilMs, source, reason);
  }

  private runtimeErrorDeliveryBackoffRemainingMs(ap: AgentProcess): number {
    if (ap.runtimeErrorDeliveryBackoff.kind === "idle") return 0;
    return Math.max(0, ap.runtimeErrorDeliveryBackoff.untilMs - Date.now());
  }

  private runtimeErrorDeliveryBackoffTimerScheduled(ap: AgentProcess): boolean {
    return ap.runtimeErrorDeliveryBackoff.kind === "backing_off" && ap.runtimeErrorDeliveryBackoff.timer !== null;
  }

  private scheduleRuntimeErrorDeliveryBackoffFlush(agentId: string, ap: AgentProcess): boolean {
    const state = ap.runtimeErrorDeliveryBackoff;
    if (state.kind === "idle") return false;
    const delayMs = this.runtimeErrorDeliveryBackoffRemainingMs(ap);
    if (delayMs <= 0 || state.timer) return false;
    state.timer = setTimeout(() => {
      if (ap.runtimeErrorDeliveryBackoff === state) state.timer = null;
      this.flushRuntimeErrorDeliveryBackoff(agentId);
    }, delayMs);
    state.timer.unref?.();
    return true;
  }

  private recoverableRuntimeDeliveryBackoffReason(
    message: string,
    terminalFailure: RuntimeErrorDeliveryFailure | null,
    stickyTerminalFailure: RuntimeErrorDeliveryFailure | null,
    reasonOverride?: string | null,
  ): string | null {
    return recoverableRuntimeDeliveryBackoffReason(message, terminalFailure, stickyTerminalFailure, reasonOverride);
  }

  private noteRuntimeErrorDeliveryBackoff(
    agentId: string,
    ap: AgentProcess,
    message: string,
    terminalFailure: RuntimeErrorDeliveryFailure | null,
    stickyTerminalFailure: RuntimeErrorDeliveryFailure | null,
    reasonOverride?: string | null,
    providerLimit?: RuntimeErrorProviderLimit,
  ): boolean {
    const reason = this.recoverableRuntimeDeliveryBackoffReason(message, terminalFailure, stickyTerminalFailure, reasonOverride);
    if (!reason) return false;

    const attempts = ap.runtimeErrorDeliveryBackoff.attempts + 1;
    const exponentialDelayMs = this.computeRuntimeErrorDeliveryBackoffDelayMs(attempts);
    const delayMs = providerLimitBackoffDelayMs({ providerLimit, exponentialDelayMs, nowMs: Date.now() });
    const credentialKey = providerLimitCredentialKey(agentId, ap.config);
    const credentialKeyKind = providerLimitCredentialKeyKind(credentialKey);
    // A non-limit error never shortens the shared sign-in's limit: while the
    // account's wait outlasts this error's own delay, the process keeps
    // waiting for the account (as that limit, so a turn end or turn-start
    // bookkeeping does not end it either) instead of spending a request that
    // would only hit the limit again. Own credentials: unchanged.
    const sharedLimit = !providerLimit && credentialKeyKind === "shared" ? this.lifecycleRecords.getProviderLimit(credentialKey, this.clockNow()) : undefined;
    const heldBySharedLimit = sharedLimit && sharedLimit.untilMs > Date.now() + delayMs ? sharedLimit : undefined;

    if (ap.runtimeErrorDeliveryBackoff.kind === "backing_off" && ap.runtimeErrorDeliveryBackoff.timer) {
      clearTimeout(ap.runtimeErrorDeliveryBackoff.timer);
    }
    ap.runtimeErrorDeliveryBackoff = {
      kind: "backing_off",
      attempts,
      reason: heldBySharedLimit ? heldBySharedLimit.reason : reason,
      untilMs: heldBySharedLimit ? heldBySharedLimit.untilMs : Date.now() + delayMs,
      timer: null,
    };
    // The live backoff ends with this process; the credential's record keeps
    // a provider-limit one for the process that replaces it (Grace: a weekly
    // quota, and every respawn woke straight into the same limit), and for
    // every agent on the same shared sign-in (#proj-raft-computer:#46: the
    // limit is the account's).
    let keptLongerLimit = false;
    if (providerLimit) {
      const record: ProviderLimitBackoffRecord = {
        attempts,
        reason,
        untilMs: ap.runtimeErrorDeliveryBackoff.untilMs,
        providerLimitKind: providerLimit.kind,
        ...(providerLimit.resetsAt ? { resetsAt: providerLimit.resetsAt } : {}),
        recordedAtMs: Date.now(),
      };
      // Announced to the OAR host too: its agents on the same sign-in wait as well.
      // A longer limit still running on the credential stays (the ledger
      // keeps its end), and this process waits for it too.
      const stored = this.lifecycleRecords.providerLimitLedger.record(credentialKey, record, { host: "legacy", agentId });
      if (stored.untilMs > ap.runtimeErrorDeliveryBackoff.untilMs) {
        keptLongerLimit = true;
        ap.runtimeErrorDeliveryBackoff = { ...ap.runtimeErrorDeliveryBackoff, reason: stored.reason, untilMs: stored.untilMs };
      }
      if (credentialKeyKind === "shared") this.shareProviderLimitWithLiveAgents(agentId, credentialKey, stored);
    } else if (credentialKeyKind === "agent") {
      // Own credentials: the latest error is not a provider limit, so the next
      // process need not wait (unchanged). A shared sign-in's limit stays: one
      // agent's unrelated error says nothing about the account's quota.
      this.lifecycleRecords.deleteProviderLimit(credentialKey);
    }
    if (ap.inbox.length > 0) {
      this.scheduleRuntimeErrorDeliveryBackoffFlush(agentId, ap);
    }

    this.recordDaemonEvent("daemon.agent.runtime_error_delivery_backoff", {
      agentId,
      runtime: ap.config.runtime,
      model: ap.config.model,
      launchId: ap.launchId || undefined,
      reason,
      attempts,
      delay_ms: delayMs,
      until_ms: ap.runtimeErrorDeliveryBackoff.untilMs,
      ...(providerLimit
        ? {
          provider_limit_kind: providerLimit.kind,
          provider_limit_source: providerLimit.source,
          waits_for_reported_reset: delayMs !== Math.min(exponentialDelayMs, QUOTA_RESET_BACKOFF_MAX_MS),
          credential_key_kind: credentialKeyKind,
          ...(keptLongerLimit ? { kept_longer_limit: true } : {}),
        }
        : {}),
      ...(heldBySharedLimit ? { held_by_shared_limit: true, credential_key_kind: credentialKeyKind } : {}),
      inbox_count: ap.inbox.length,
      pending_notification_count: ap.notifications.pendingCount,
    });
    return true;
  }

  private computeRuntimeErrorDeliveryBackoffDelayMs(attempts: number): number {
    return runtimeErrorDeliveryBackoffDelayMs(attempts, {
      baseMs: this.runtimeErrorDeliveryBackoffBaseMs,
      maxMs: this.runtimeErrorDeliveryBackoffMaxMs,
      jitterRatio: this.runtimeErrorDeliveryBackoffJitterRatio,
      jitterUnit: this.runtimeErrorDeliveryBackoffJitterRandom(),
    });
  }

  private cancelRuntimeErrorProcessRestart(agentId: string): void {
    const timer = this.runtimeErrorProcessRestartTimers.get(agentId);
    if (timer) clearClockTimeout(timer);
    this.runtimeErrorProcessRestartTimers.delete(agentId);
  }

  private queueDeliveryForRuntimeErrorBackoff(agentId: string, ap: AgentProcess, message: AgentMessage): boolean {
    const remainingMs = this.runtimeErrorDeliveryBackoffRemainingMs(ap);
    if (remainingMs <= 0) return false;

    const isIdle = this.isApmIdle(ap);
    const queued = queueAgentInboxMessage(ap, message);
    if (!queued.duplicate && !isIdle && ap.driver.supportsStdinNotification && ap.sessionId) {
      ap.notifications.add();
    }
    const scheduled = this.scheduleRuntimeErrorDeliveryBackoffFlush(agentId, ap);
    this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
      outcome: "queued_runtime_error_backoff",
      accepted: true,
      process_present: true,
      runtime: ap.config.runtime,
      session_id_present: Boolean(ap.sessionId),
      launchId: ap.launchId || undefined,
      is_idle: isIdle,
      inbox_count: queued.inboxCount,
      duplicate_pending_delivery: queued.duplicate,
      pending_notification_count: ap.notifications.pendingCount,
      runtime_error_backoff_remaining_ms: remainingMs,
      runtime_error_backoff_attempts: ap.runtimeErrorDeliveryBackoff.attempts,
      runtime_error_backoff_reason: ap.runtimeErrorDeliveryBackoff.reason || undefined,
      runtime_error_backoff_timer_scheduled: scheduled || this.runtimeErrorDeliveryBackoffTimerScheduled(ap),
    }));
    return true;
  }

  private flushRuntimeErrorDeliveryBackoff(agentId: string): boolean {
    const ap = this.agents.get(agentId);
    if (!ap) return false;
    // Still held for an invalid credential: its release flushes again. So
    // does the end of a drain (reconciler step 13).
    if (this.credentialInvalidHold(agentId, ap.config) || this.drain.holds(agentId)) return false;

    const remainingMs = this.runtimeErrorDeliveryBackoffRemainingMs(ap);
    if (remainingMs > 0) {
      this.scheduleRuntimeErrorDeliveryBackoffFlush(agentId, ap);
      return false;
    }
    if (ap.inbox.length === 0) return false;

    const reason = ap.runtimeErrorDeliveryBackoff.reason || "runtime_error_backoff";
    if (this.isApmIdle(ap) && ap.driver.supportsStdinNotification && ap.sessionId) {
      ap.notifications.pruneContributedToPending(ap.inbox, ap.sessionId);
      const messages = ap.notifications.filterUncontributedMessages(ap.inbox, ap.sessionId);
      ap.notifications.clearPending();
      ap.notifications.clearTimer();
      if (messages.length === 0) {
        this.recordDaemonEvent("daemon.agent.runtime_error_delivery_backoff.flush", {
          agentId,
          runtime: ap.config.runtime,
          model: ap.config.model,
          launchId: ap.launchId || undefined,
          reason,
          mode: "idle",
          outcome: "suppressed_already_contributed",
          inbox_count: ap.inbox.length,
          messages_count: 0,
        });
        return false;
      }
      this.commitApmIdleState(agentId, ap, false);
      this.startRuntimeTrace(agentId, ap, "runtime-error-backoff-idle-delivery", messages);
      const accepted = this.deliverInboxUpdateViaStdin(
        agentId,
        ap,
        messages,
        "idle",
        "runtime_error_backoff_idle_delivery",
      );
      this.recordDaemonEvent("daemon.agent.runtime_error_delivery_backoff.flush", {
        agentId,
        runtime: ap.config.runtime,
        model: ap.config.model,
        launchId: ap.launchId || undefined,
        reason,
        mode: "idle",
        outcome: accepted ? "written" : "not_written",
        inbox_count: ap.inbox.length,
        messages_count: messages.length,
      });
      return accepted;
    }

    if (!ap.driver.supportsStdinNotification || !ap.sessionId) {
      this.recordDaemonEvent("daemon.agent.runtime_error_delivery_backoff.flush", {
        agentId,
        runtime: ap.config.runtime,
        model: ap.config.model,
        launchId: ap.launchId || undefined,
        reason,
        outcome: "queued_without_stdin",
        inbox_count: ap.inbox.length,
        session_id_present: Boolean(ap.sessionId),
        supports_stdin_notification: ap.driver.supportsStdinNotification,
      });
      return false;
    }

    if (ap.notifications.pendingCount === 0) {
      ap.notifications.add(ap.inbox.length);
    }
    const accepted = this.sendStdinNotification(agentId);
    this.recordDaemonEvent("daemon.agent.runtime_error_delivery_backoff.flush", {
      agentId,
      runtime: ap.config.runtime,
      model: ap.config.model,
      launchId: ap.launchId || undefined,
      reason,
      mode: "busy",
      outcome: accepted ? "written" : "not_written",
      inbox_count: ap.inbox.length,
      pending_notification_count: ap.notifications.pendingCount,
    });
    return accepted;
  }

  private allPendingVisibleMessages(agentId: string): AgentMessage[] {
    const collect = (messages: AgentMessage[] | undefined) =>
      (messages ?? []).filter((message) => !runtimeProfileNotificationFromMessage(message) && hasStableLocalMessageId(message));
    return [
      ...collect(this.agents.get(agentId)?.inbox),
      ...collect(this.startingInboxes.values(agentId)),
    ];
  }

  private pendingVisibleMessages(agentId: string, target: string): AgentMessage[] {
    return this.allPendingVisibleMessages(agentId).filter((message) => formatAgentMessageVisibleTarget(message) === target);
  }

  /**
   * An inbox notice the runtime accepted showed these messages' previews.
   * Each one shown whole counts as seen for freshness, so a reply is not held
   * for the message it answers. It is not consumed: it stays pending,
   * `raft message check` still serves it, and a redelivery is not dropped.
   * Without this, agents ran `raft message read --unread >/dev/null` to clear
   * the hold, which also marked unseen replies as seen.
   */
  private recordWholeNoticePreviewsSeen(agentId: string, noticeMessages: readonly AgentMessage[]): void {
    const shown = projectAgentInboxWholePreviewMessages(noticeMessages);
    if (shown.length === 0) return;
    this.agentVisibleDelivery.recordWholePreviewSeen(agentId, {
      messages: shown,
      contextId: this.freshnessContext(agentId)?.contextId,
    });
  }

  /**
   * Single-inbox consume point for messages that have been rendered into the
   * agent-visible input surface. Daemon pending inbox is only a runner cache:
   * once a message is visible through wake/stdin/check/read/held/preflight, the
   * same seq must not be injected later through the local pending queue.
   */
  private consumeVisibleMessages(
    agentId: string,
    input: { historyScope?: AgentApiHistoryConsumptionScope; target?: string; messages: AgentProxyVisibleMessage[]; boundarySeq?: number; source: string; responseBytes?: number },
  ): void {
    // Model-seen boundary contract: delivery/queue/wake signals are attention
    // signals only. They may populate exact-id suppression for the just-rendered
    // rows, but they must not advance the per-target high-water boundary because
    // sparse delivery of a high-seq @mention does not prove older seqs in that
    // target were consumed. The ledger therefore treats daemon attention
    // sources (`spawn_wake_message`, `stdin_*_delivery`,
    // `agent_api_events_local`, server views, self-authored commits, and
    // future/unknown strings) as exact-id-only unless the source explicitly
    // represents rendered or contiguous full-body content consumption.
    const { responseBytes, ...consumeInput } = input;
    const consumed = this.agentVisibleDelivery.recordConsumed(agentId, { ...consumeInput, contextId: this.freshnessContext(agentId)?.contextId });
    if (!consumed) return;
    this.completeTrackedMentionsSeenByModel(agentId);

    const suppress = (messages: AgentMessage[] | undefined): number => {
      if (!messages || messages.length === 0) return 0;
      let removed = 0;
      const retained = messages.filter((message) => {
        const matched = consumed.shouldSuppress(message);
        if (matched) removed += 1;
        return !matched;
      });
      messages.splice(0, messages.length, ...retained);
      return removed;
    };

    const active = this.agents.get(agentId);
    const removedActive = suppress(active?.inbox);
    const removedStarting = this.startingInboxes.suppressConsumed(agentId, consumed.shouldSuppress);
    this.assertStartPendingDeliveryInvariants("visible-consume");
    this.recordDaemonEvent("daemon.agent.inbox.visible_consumed", {
      agentId,
      source: input.source,
      // The telemetry sink stamps its own `source` ("daemon") over the one
      // above, so the consume source also travels under its own name.
      consume_source: input.source,
      targets: consumed.targets,
      targets_count: consumed.targets.length,
      thread_targets_count: consumed.targets.filter(isThreadVisibleTarget).length,
      messages_count: consumed.messagesCount,
      already_seen_count: consumed.alreadySeenCount,
      ...(responseBytes !== undefined && { response_bytes_bucket: bucketBytes(responseBytes) }),
      suppressed_pending_count: removedActive + removedStarting,
    });
  }

  purgeInboxMessagesForChannels(agentId: string, channelIds: readonly string[], reason = "server_purge"): { removedCount: number } {
    const channelIdSet = new Set(channelIds.filter((id) => typeof id === "string" && id.length > 0));
    if (channelIdSet.size === 0) return { removedCount: 0 };

    const purge = (messages: AgentMessage[] | undefined): number => {
      if (!messages || messages.length === 0) return 0;
      let removed = 0;
      const retained = messages.filter((message) => {
        const shouldRemove = channelIdSet.has(message.channel_id);
        if (shouldRemove) removed += 1;
        return !shouldRemove;
      });
      if (removed > 0) {
        messages.splice(0, messages.length, ...retained);
      }
      return removed;
    };

    const active = this.agents.get(agentId);
    const removedActive = purge(active?.inbox);
    const removedStarting = this.startingInboxes.purge(agentId, (message) => channelIdSet.has(message.channel_id));
    this.assertStartPendingDeliveryInvariants("purge-starting-inbox");
    if (active && removedActive > 0) {
      active.notifications.remove(removedActive);
      if (active.inbox.length === 0) {
        active.notifications.clear();
        this.clearRuntimeErrorDeliveryBackoff(active);
      }
      // Server features: queued work went away untold.
      this.reconcile(agentId, active, "delivery_consumed");
    }
    const removedCount = removedActive + removedStarting;
    this.recordDaemonEvent("daemon.agent.inbox.purged", {
      agentId,
      reason,
      channel_count: channelIdSet.size,
      removed_active_count: removedActive,
      removed_starting_count: removedStarting,
      removed_count: removedCount,
      active_inbox_count: active?.inbox.length ?? 0,
      starting_inbox_count: this.startingInboxes.count(agentId),
    });
    return { removedCount };
  }

  private createAgentProxyInboxCoordinator(agentId: string): AgentProxyInboxCoordinator {
    return buildAgentProxyInboxCoordinator({
      agentId,
      serverUrl: this.serverUrl,
      daemonApiKey: this.daemonApiKey,
      fetchImpl: this.fetchImpl,
      // Freshness evidence follows the model's current context (glimpse G0):
      // facts from before a compaction must not vouch for a send or a claim.
      getBoundary: (target) => this.visibleFreshnessView(agentId).getBoundary(target),
      getPendingMessages: (target) => this.pendingVisibleMessages(agentId, target),
      isMessageModelSeen: ({ target, message }) => this.visibleFreshnessView(agentId).isModelSeen(target, message),
      getExactSeenSeqs: (target) => this.visibleFreshnessView(agentId).getExactSeenSeqs(target),
      getContextId: () => this.agents.get(agentId)?.contextId ?? null,
      getAllPendingMessages: () => this.allPendingVisibleMessages(agentId),
      consumeVisibleMessages: (input) => this.consumeVisibleMessages(agentId, input),
      recordHeldWriteSpan: (input) => this.agentVisibleDelivery.recordHeldWriteSpan(agentId, {
        ...input,
        contextId: this.freshnessContext(agentId)?.contextId,
      }),
      getHeldWriteSpan: ({ target, writeKey }) => this.agentVisibleDelivery.getHeldWriteSpan(agentId, this.freshnessContext(agentId), target, writeKey),
      getThreadTargetOfMessage: ({ parentTarget, messageId }) => this.agentVisibleDelivery.threadTargetOfMessage(agentId, parentTarget, messageId),
      recordTrace: (name, attrs, status) => this.recordDaemonEvent(name, attrs, status),
      recordFreshnessDecisionActivity: (input, producerFactId) => {
        this.recordFreshnessDecisionActivity(agentId, input, producerFactId);
      },
      recordSendOutcome: (outcome) => {
        this.turnSummaries.noteSendOutcome(agentId, outcome, Date.now());
        const ap = this.agents.get(agentId);
        if (ap?.runtimeTraceSpan) noteRaftMessageSendOutcome(ap.runtimeTraceCounters, outcome.state);
      },
      recordMessageCommitted: ({ messageId, route }) => this.contextView.onMessageCommitted(agentId, messageId, route),
    });
  }

  private recordFreshnessDecisionActivity(agentId: string, input: AgentProxyFreshnessDecision, producerFactId: string): void {
    if (input.freshnessContextMode === "withheld" || (input.decision !== "local_hold" && input.decision !== "syncing_hold")) return;
    const ap = this.agents.get(agentId);
    const messageCount = input.decision === "syncing_hold"
      ? input.heldMessageCount ?? input.pendingCount ?? 0
      : input.pendingCount ?? input.heldMessageCount ?? 0;
    const activity = projectApmHeldFreshnessActivity({
      producerFactId,
      action: input.action,
      decision: input.decision,
      target: input.target,
      messageCount,
    });

    this.activitySink.send({
      agentId,
      activityKind: activity.statusEntry.activity,
      detail: activity.statusEntry.detail,
      detailKind: activity.statusEntry.detailKind,
      entries: activity.entries,
      launchId: ap?.launchId || undefined,
      clientSeq: ap ? this.activitySink.nextClientSeq(agentId) : undefined,
      isHeartbeat: false,
    });
  }

  private recordRuntimeDiagnosticActivity(agentId: string, ap: AgentProcess, event: RuntimeDiagnosticEvent): void {
    this.activitySink.send({
      agentId,
      activityKind: ap.lastActivityKind || "online",
      detail: ap.lastActivityDetail || "",
      detailKind: ap.lastActivityDetailKind,
      entries: [runtimeDiagnosticTrajectoryEntry(event)],
      launchId: ap.launchId || undefined,
      clientSeq: this.activitySink.nextClientSeq(agentId),
      isHeartbeat: false,
    });
    this.recordDaemonEvent("daemon.runtime.diagnostic", {
      agentId,
      launchId: ap.launchId || undefined,
      runtime: ap.config.runtime,
      ...runtimeDiagnosticTraceAttrs(event),
    });
  }

  // Project bounded Working liveness without raw content or subagent state.
  private maybeBroadcastRuntimeProgressActivity(
    agentId: string,
    ap: AgentProcess,
    event: Extract<ParsedEvent, { kind: "internal_progress" }>,
  ): void {
    // Transport progress cannot cross a terminal APM idle boundary.
    if (this.isApmIdle(ap)) {
      this.recordDaemonEvent("daemon.runtime.progress.activity.suppressed", {
        agentId,
        launchId: ap.launchId || undefined,
        runtime: ap.config.runtime,
        outcome: "apm_idle",
        source: event.source,
        itemType: event.itemType,
        payloadBytes: event.payloadBytes,
      });
      return;
    }

    // Preserve richer live activity and transition into generic Working once.
    const alreadyLive = ap.lastActivityKind === "working" || ap.lastActivityKind === "thinking";
    if (alreadyLive) return;
    this.broadcastActivity(agentId, "working", "Working", [], undefined, "runtime_progress");
  }

  private recordSubagentProgressActivity(agentId: string, ap: AgentProcess, event: SubagentProgressEvent): void {
    this.flushPendingTrajectory(agentId);
    const backgroundTasksChanged = this.noteBackgroundTaskLifecycle(ap, event);
    // A shell command Claude Code runs as a task (`local_bash`, also a
    // foreground one that runs a few seconds) is not a sub-agent: no
    // sub-agent row in Activity. A backgrounded one is still work the quiet
    // turn waits for (task #1260), so its start and end re-state that status.
    if (event.taskKind === "command" || event.taskKind === "other") {
      this.recordDaemonEvent("daemon.runtime.background_task.progress", {
        agentId,
        launchId: ap.launchId || undefined,
        runtime: ap.config.runtime,
        phase: event.phase,
        task_kind: event.taskKind,
        background_tasks_outstanding: ap.backgroundTasks.size,
      });
      if (backgroundTasksChanged && this.mainTurnIsQuiet(ap)) this.broadcastQuietTurnStatus(agentId, ap);
      return;
    }
    this.broadcastActivity(
      agentId,
      "working",
      subagentProgressDetail(event),
      [],
      undefined,
      "subagent_activity",
      "working",
      subagentLineageFromEvent(event),
    );
    this.recordDaemonEvent("daemon.runtime.subagent.progress", {
      agentId,
      launchId: ap.launchId || undefined,
      runtime: ap.config.runtime,
      ...subagentProgressTraceAttrs(event),
      background_tasks_outstanding: ap.backgroundTasks.size,
    });
    // A task ended while the main turn is over and nothing new has started:
    // the status must say what is left (fewer tasks, or Idle), otherwise the
    // "Subagent completed" line above would be the last word on a quiet agent.
    // Re-stated on every notification, whether or not it changed the set, so
    // the last line is always the current count.
    const quiet = event.phase === "notification" && this.mainTurnIsQuiet(ap);
    // A sub-agent's end. It was a person's stop only if it ended stopped: a
    // stop refused because the sub-agent had just finished on its own still
    // leaves a result to read. Its id is forgotten either way.
    if (event.phase === "notification" && event.taskStatus !== undefined && event.taskId !== undefined) {
      const stoppedByUser = ap.userStoppedSubagents?.delete(event.taskId) === true && event.taskStatus === "stopped";
      if (quiet && backgroundTasksChanged && !stoppedByUser) ap.subagentResultUnread = true;
    }
    if (quiet) {
      this.broadcastQuietTurnStatus(agentId, ap);
      if (backgroundTasksChanged && ap.backgroundTasks.size === 0 && ap.driver.needsWakeAfterSubagents) {
        // Wake if any sub-agent ended on its own since the turn went quiet,
        // not only the last one: stopping A after B finished leaves B's result.
        const unread = ap.subagentResultUnread === true;
        ap.subagentResultUnread = false;
        if (unread) {
          this.wakeAfterSubagentsFinished(agentId, ap);
        } else {
          this.recordDaemonEvent("daemon.runtime.subagent.finished_wake", { agentId, launchId: ap.launchId || undefined, runtime: ap.config.runtime, outcome: "stopped_by_user" });
        }
      }
    }
  }

  /**
   * #proj-runtime:#41 — the last subagent finished after the agent's turn
   * ended, on a runtime that only queues the results for the next turn
   * (Codex). Start that turn, as Claude Code does by itself, so the agent
   * acts on the results instead of holding them until its next message.
   * Only into an idle live session with nothing else waiting: a pending
   * message or notice starts the turn anyway and carries the results with it.
   */
  private wakeAfterSubagentsFinished(agentId: string, ap: AgentProcess): void {
    const outcome = ((): string => {
      if (!this.canDeliverToRuntimeSession(ap)) return "not_deliverable";
      // The process is being stopped on purpose (cold-idle recycle, restart).
      if (ap.gatedSteering.expectedTerminationReason !== null) return "stopping";
      // Someone stopped the agent's turn: finishing subagents do not undo that.
      if (ap.lastTurnEndInterrupted) return "turn_stopped";
      if (this.hasUntoldInboxWork(ap) || this.appInboxIdleDrains.has(agentId)) return "messages_pending";
      // A runtime in a failure state is not woken: only a person or a message
      // starts it (a backoff, a sticky failure, or an error still showing).
      if (this.runtimeErrorDeliveryBackoffRemainingMs(ap) > 0 || classifyStickyFailure(ap) || ap.lastRuntimeError || this.credentialInvalidHold(agentId, ap.config)) return "blocked";
      if (!ap.driver.supportsStdinNotification) return "unsupported";
      // Claim the turn before writing, and give it back if the write did not
      // land (as deliverIdleNotice does).
      this.commitApmIdleState(agentId, ap, false);
      this.startRuntimeTrace(agentId, ap, "subagents-finished", undefined, { trigger_kind: "wake_hint" });
      let result: RuntimeSendResult | undefined;
      try {
        result = this.sendRuntimeInput(
          agentId,
          ap,
          { mode: "idle", text: formatSubagentsFinishedRuntimeInput(), sessionId: ap.sessionId },
          "subagents_finished",
        );
      } finally {
        if (!result?.ok) {
          this.endRuntimeTrace(ap, "error", { outcome: "subagents_finished_not_written", ...runtimeTraceCounterAttrs(ap) });
          this.restoreApmIdleWithoutDrain(agentId, ap);
        }
      }
      if (!result.ok) return "write_failed";
      this.watchTurnStart(agentId, ap, "subagents_finished");
      return "written";
    })();
    this.recordDaemonEvent("daemon.runtime.subagent.finished_wake", {
      agentId,
      launchId: ap.launchId || undefined,
      runtime: ap.config.runtime,
      outcome,
    }, outcome === "write_failed" ? "error" : "ok");
  }

  /**
   * task #1260 — keep the per-process background task set in step with the
   * lifecycle signal. Dedupes by task_id: a second `started` for a known id
   * and a `notification` for an unknown id change nothing. A task leaves the
   * set only on a notification whose status is one of the documented
   * terminal values (completed | failed | stopped); a notification without a
   * recognised status is not completion evidence — the envelope's name alone
   * proves nothing — so the task stays outstanding (review finding).
   * Returns whether the set changed.
   */
  private noteBackgroundTaskLifecycle(ap: AgentProcess, event: SubagentProgressEvent): boolean {
    if (!event.taskId) return false;
    const nowMs = this.clockNow();
    const known = ap.backgroundTasks.get(event.taskId);
    // Any event naming the task (progress included) says it still runs.
    if (known) known.lastEventAtMs = nowMs;
    if (event.phase === "started") {
      if (known) return false;
      ap.backgroundTasks.set(event.taskId, {
        startedAtMs: nowMs,
        lastEventAtMs: nowMs,
        ...(event.subagentType ? { subagentType: event.subagentType } : {}),
        ...(event.parentToolUseId ? { parentToolUseId: event.parentToolUseId } : {}),
        ...(event.taskKind ? { taskKind: event.taskKind } : {}),
      });
      return true;
    }
    if (event.phase === "notification" && event.taskStatus !== undefined) {
      return ap.backgroundTasks.delete(event.taskId);
    }
    return false;
  }

  /** The main turn has ended (protocol idle) and no new turn has opened since. */
  private mainTurnIsQuiet(ap: AgentProcess): boolean {
    return this.isApmIdle(ap) && ap.runtimeTraceSpan === null && ap.exit.kind === "live";
  }

  /**
   * task #1260 — the status of a quiet main turn: Idle when nothing runs in
   * the background, otherwise a "waiting" line that is still `working` to the
   * reader. Never touches isIdle: inbound messages are delivered exactly as
   * before while the agent waits.
   */
  private broadcastQuietTurnStatus(agentId: string, ap: AgentProcess): void {
    const outstanding = ap.backgroundTasks.size;
    if (outstanding > 0) {
      this.broadcastActivity(agentId, "working", backgroundTasksWaitingDetail(outstanding), [], undefined, "subagent_activity", "working");
      return;
    }
    this.broadcastActivity(agentId, "online", "Idle", [], undefined, "idle");
  }

  private recordRuntimeRecoveryActivity(agentId: string, ap: AgentProcess, event: RuntimeRecoveryEvent): void {
    this.activitySink.send({
      agentId,
      activityKind: ap.lastActivityKind || "online",
      detail: ap.lastActivityDetail || "",
      detailKind: ap.lastActivityDetailKind,
      entries: [runtimeRecoveryTrajectoryEntry(event)],
      launchId: ap.launchId || undefined,
      clientSeq: this.activitySink.nextClientSeq(agentId),
      isHeartbeat: false,
    });
    this.recordDaemonEvent("daemon.runtime.recovery.visible", {
      agentId,
      launchId: ap.launchId || undefined,
      runtime: ap.config.runtime,
      ...runtimeRecoveryTraceAttrs(event),
    });
  }

  // Records a point in time fact as a trace event. The event attaches to the
  // given parent, or to the span that is active right now.
  private recordDaemonEvent(
    name: string,
    attrs?: Record<string, unknown>,
    status: "ok" | "error" | "cancelled" = "ok",
    parentTraceparent?: string | null,
  ): void {
    // Daemon events historically spell the agent identity in camelCase
    // (`agentId`), while the trace backend promotes and groups by `agent_id`.
    // Emit both so per-agent delivery/start counts are queryable. Only
    // `agentId` is canonicalized here: `agent_id` is `span_or_event` in the
    // shared field registry, whereas `launch_id` / `session_id` / `server_id` /
    // `machine_id` are span-only there and must not be added to events.
    this.tracer.emitEvent(name, {
      parent: parseTraceparent(parentTraceparent) ?? getActiveTraceContext(),
      surface: "daemon",
      attrs: { ...withCanonicalTraceAttributes(attrs ?? {}, { keys: DAEMON_EVENT_CANONICAL_ALIAS_KEYS }), status },
    });
  }

  private emitNoProcessResidencyRows(rows: readonly AgentNoProcessResidencyTransitionRow[]): void {
    for (const row of rows) {
      this.recordDaemonEvent("launch_residency_transition", row);
    }
  }

  private noProcessResidencyIdentity(
    agentId: string,
    config: AgentConfig,
    launchId: string | null | undefined,
    launchSource: string,
    driverId?: string,
  ): AgentNoProcessResidencyTransitionIdentity {
    const runtimeContext = config.runtimeContext;
    const agentLaunchIdPresent = typeof launchId === "string" && launchId.length > 0;
    return {
      agentId,
      agentLaunchId: agentLaunchIdPresent ? launchId : "missing_launch_id",
      agentLaunchIdPresent,
      serverId: runtimeContext?.serverId || "unknown_server",
      machineId: runtimeContext?.machineId || "unknown_machine",
      runtime: config.runtime || "unknown_runtime",
      driver: driverId || this.driverResolver(config.runtime || "claude").id,
      launchSource,
    };
  }

  private enterNoProcessResidency(
    state: AgentNoProcessResidencyState,
    identity: AgentNoProcessResidencyTransitionIdentity,
    opts: Omit<AgentNoProcessResidencyEnterInput, keyof AgentNoProcessResidencyTransitionIdentity | "state">,
  ): void {
    const launchEvidence = identity.agentLaunchIdPresent
      ? {}
      : {
          failureKind: opts.failureKind ?? "missing_launch_id",
          negativeEvidenceBucket: opts.negativeEvidenceBucket ?? "missing_launch_id",
        };
    this.emitNoProcessResidencyRows(this.noProcessResidencyTransitions.enter({
      ...identity,
      state,
      ...opts,
      ...launchEvidence,
    }));
  }

  private closeNoProcessResidency(
    agentId: string,
    closeResult: AgentNoProcessResidencyCloseResult,
    opts: { failureKind?: string; negativeEvidenceBucket?: string } = {},
  ): void {
    this.emitNoProcessResidencyRows(this.noProcessResidencyTransitions.close(agentId, {
      closeResult,
      failureKind: opts.failureKind,
      negativeEvidenceBucket: opts.negativeEvidenceBucket,
    }));
  }

  private startLaunchSource(config: AgentConfig, wakeMessage?: AgentMessage, resumePrompt?: string): string {
    if (config.runtimeProfileControl && !wakeMessage) return "runtime_profile";
    if (config.sessionId || resumePrompt) return "session_resume";
    if (wakeMessage) return "wake_message";
    return "explicit_start";
  }

  private enterSpawnFailCooldownResidency(
    agentId: string,
    cached: { config: AgentConfig; launchId: string | null },
    untilMs: number,
    source: string,
    reason: string,
  ): void {
    if (untilMs <= this.clockNow()) return;
    this.enterNoProcessResidency(
      "spawn_fail_cooldown",
      this.noProcessResidencyIdentity(agentId, cached.config, cached.launchId, source),
      {
        isWaitState: true,
        fenceKind: "spawn_fail_backoff",
        deadlineUnixMs: untilMs,
        failureKind: reason,
        negativeEvidenceBucket: reason,
      },
    );
  }

  private processLifecycleIdentityAttrs(agentId: string, ap: AgentProcess): Record<string, unknown> {
    const runtimeContext = ap.config.runtimeContext;
    return {
      agent_id: agentId,
      server_id: runtimeContext?.serverId,
      machine_id: runtimeContext?.machineId,
      launch_id: ap.launchId || undefined,
      start_dispatch_id: ap.startDispatchId || undefined,
      process_instance_id: ap.processInstanceId,
      session_id: ap.sessionId || undefined,
      session_id_present: Boolean(ap.sessionId),
      runtime: ap.config.runtime,
      runtime_version: runtimeContext?.daemonVersion,
      pid: typeof ap.runtime.pid === "number" ? ap.runtime.pid : undefined,
    };
  }

  private runtimeLaunchPolicyTraceAttrs(config: AgentConfig): Record<string, unknown> {
    if (config.runtime !== "claude") return {};
    const customProvider = isClaudeCustomProviderConfig(config);
    if (!customProvider) {
      return {
        claude_custom_provider: false,
      };
    }
    return {
      claude_custom_provider: true,
      claude_custom_provider_settings_sources_policy: "project,local",
      claude_custom_provider_inherited_provider_scrub: true,
      claude_custom_provider_host_managed_flag: false,
      claude_custom_provider_home_override: false,
      claude_custom_provider_config_dir_override: false,
    };
  }

  private getDeliveryTraceContext(message: AgentMessage): DeliveryTraceContext {
    return this.deliveryTraceContexts.get(message) ?? {};
  }

  /** Invariant (task #353): a queued delivery the runtime never consumed is
   * carried into the next start by the daemon, or left unread on the Server
   * for its catch-up at the next start, and every close that does not carry it
   * in the daemon says so here. `expected` marks paths that rely on the Server
   * by design (stop, cold-idle recycle, deferred notices); the rest lose the
   * wake until something else starts the agent, so they log a warning. */
  private recordInboxDroppedOnExit(agentId: string, ap: AgentProcess, exitPath: string, messages: AgentMessage[]): void {
    const dropped = messages.filter((message) => !this.isTransientDelivery(message));
    if (dropped.length === 0) return;
    const expected = EXPECTED_SERVER_CARRIED_EXIT_PATHS.has(exitPath);
    const line = `[Agent ${agentId}] Runtime closed via ${exitPath} with ${dropped.length} unconsumed queued message(s); not carried by the daemon, they stay unread on the server`;
    if (expected) logger.info(line);
    else logger.warn(line);
    this.recordDaemonEvent("daemon.agent.inbox.dropped_on_exit", {
      agentId,
      launchId: ap.launchId || undefined,
      runtime: ap.config.runtime,
      // `exit_reason`, not `exit_path`: the local trace sink drops any key
      // containing a `path` segment, so `exit_path` never reached disk.
      exit_reason: exitPath,
      dropped_count: dropped.length,
      expected,
    }, expected ? "ok" : "error");
  }

  private isTransientDelivery(message: AgentMessage): boolean {
    return this.getDeliveryTraceContext(message).transient === true;
  }

  private deliveryTraceAttrs(agentId: string, message: AgentMessage, attrs: Record<string, unknown> = {}): Record<string, unknown> {
    const context = this.getDeliveryTraceContext(message);
    const deliveryCorrelationId = context.deliveryId ?? message.message_id;
    return {
      agentId,
      deliveryId: context.deliveryId,
      delivery_correlation_id: deliveryCorrelationId,
      channel_type: message.channel_type,
      sender_type: message.sender_type,
      messageId: message.message_id,
      message_id_present: Boolean(message.message_id),
      transient_delivery: context.transient === true,
      ...attrs,
    };
  }

  private recordStartRebind(agentId: string, start: PendingStartRebind, reason: string, previousLaunchId: string | null, nextLaunchId: string | null, sessionId: string | null): void {
    this.recordDaemonEvent("daemon.agent.start.rebound", {
      ...this.agentStartDispatch.traceAttrs(
        agentId,
        start.config,
        start.wakeMessage,
        start.unreadSummary,
        start.resumePrompt,
        start.launchId,
        start.wakeMessageTransient ?? false,
      ),
      reason,
      previous_launch_id_present: Boolean(previousLaunchId),
      next_launch_id_present: Boolean(nextLaunchId),
      session_id_present: Boolean(sessionId),
    });
  }

  private initialAgentProcessSessionId(driver: RuntimeDriver, config: AgentConfig): string | null {
    if (driver.requiresSessionInitForDelivery) return null;
    return config.sessionId || null;
  }

  private initialSessionReadyForDelivery(driver: RuntimeDriver, config: AgentConfig, sessionId: string | null): boolean {
    if (!sessionId) return false;
    // A configured resume target already names an existing runtime conversation.
    if (config.sessionId && config.sessionId === sessionId) return true;
    return driver.liveSessionReadyAt !== "turn_end";
  }

  private markSessionReadyForDelivery(ap: AgentProcess, source: "session_init" | "turn_end"): void {
    if (ap.sessionId && (source === "turn_end" || ap.driver.liveSessionReadyAt !== "turn_end")) {
      ap.sessionReadyForDelivery = true;
    }
  }

  private canDeliverToRuntimeSession(ap: AgentProcess): boolean {
    return Boolean(ap.sessionId && ap.sessionReadyForDelivery);
  }

  private restartSafeSessionId(ap: AgentProcess): string | null {
    return ap.sessionId || (ap.driver.requiresSessionInitForDelivery ? ap.config.sessionId || null : null);
  }

  private sameWakeMessage(left: AgentMessage | undefined, right: AgentMessage | undefined): boolean {
    if (!left || !right) return left === right;
    if (left.message_id && right.message_id) return left.message_id === right.message_id;
    return left === right;
  }

  private rebindQueuedStart(agentId: string, start: PendingStartRebind, reason: string): boolean {
    const item = this.agentStarts.getQueued(agentId);
    if (!item) {
      return false;
    }

    const previousLaunchId = item.launchId || null;
    const nextLaunchId = start.launchId || previousLaunchId;
    const previousWakeMessage = item.wakeMessage;
    this.startingInboxes.rebindWake(
      agentId,
      previousWakeMessage,
      start.wakeMessage,
      (left, right) => this.sameWakeMessage(left, right),
    );
    this.assertStartPendingDeliveryInvariants("rebind-queued-start");

    // #wg-rbac:#27: the queued start keeps the runner credential it holds.
    // Reconciler step 11: and its config, when this start's is older than one already applied.
    const carried = this.carryRunnerCredential(agentId, item.config, start);
    if (!this.configRevisions.isStaleStart(start.config)) item.config = carried;
    item.unreadSummary = start.unreadSummary;
    item.resumePrompt = start.resumePrompt;
    item.launchId = nextLaunchId || undefined;
    // RFC 071: a recovery grant stays with the launch it is bound to; the
    // queued start keeps one only while it still carries that launch.
    const recoveryGrant = start.recoveryGrant ?? item.recoveryGrant ?? null;
    item.recoveryGrant = recoveryGrant && recoveryGrant.launchId === nextLaunchId ? recoveryGrant : null;
    // task #365: the claimed epoch belongs to the launch the item now carries.
    item.claimedConnectionEpochId = start.launchId && start.launchId === nextLaunchId
      ? start.claimedConnectionEpochId ?? null
      : item.claimedConnectionEpochId ?? null;
    item.startDispatchId = start.startDispatchId ?? item.startDispatchId;
    if (start.wakeMessage) {
      item.wakeMessage = start.wakeMessage;
      item.wakeMessageTransient = start.wakeMessageTransient;
    }

    this.recordStartRebind(
      agentId,
      { ...start, launchId: nextLaunchId || undefined },
      reason,
      previousLaunchId,
      nextLaunchId,
      null,
    );
    return true;
  }

  private rebindRunningStart(agentId: string, start: PendingStartRebind, reason: string): boolean {
    const ap = this.agents.get(agentId);
    if (!ap) {
      this.deferStartRebind(agentId, {
        ...start,
        stopEpochAtRebind: this.lifecycleRecords.stopEpoch(agentId),
      });
      return false;
    }
    if (this.stopProcessForStartOfAnotherRuntime(agentId, start.config, start.launchId)) {
      // Started on its own (queued behind that stop), with its wake.
      void this.startAgent(agentId, start.config, start.wakeMessage, start.unreadSummary, start.resumePrompt, start.launchId, start.wakeMessageTransient, start.resumeMessages, start.startDispatchId, null, undefined, start.recoveryGrant ?? null, start.claimedConnectionEpochId ?? null)
        .catch((err: unknown) => logger.warn(`[Agent ${agentId}] Start of another runtime failed: ${err instanceof Error ? err.message : String(err)}`));
      return false;
    }
    // #wg-rbac:#27: the running process keeps its own runner credential (below,
    // and when the rebind is refused); the one this start brought is revoked.
    this.carryRunnerCredential(agentId, ap.config, start);
    // RFC 071 outbox: the automatic-start rule decides the reuse (only the
    // admitted human start this is passes on its own grant), and the reused
    // process must be durably open before it carries this launch.
    const rebindRefusal = this.runtimeProcessGate && this.daemonInstanceId
      ? this.runtimeProcessGate.startRefusal(agentId, start.launchId || null, start.recoveryGrant ?? null)
      : null;
    if (rebindRefusal !== null) {
      this.refuseRunningRebind(agentId, start, rebindRefusal.reason, rebindRefusal.detail);
      return false;
    }
    if (this.runtimeProcessGate && this.daemonInstanceId
      && !this.runtimeProcessGate.openProcess(agentId, ap.processInstanceId, ap.launchId || start.launchId || null)) {
      this.refuseRunningRebind(agentId, start, "terminal_failure_outcome_storage_blocked", "Start rebind refused: runtime outcome storage failed");
      return false;
    }

    const previousLaunchId = ap.launchId;
    const nextLaunchId = start.launchId || ap.launchId || null;
    const requiresSessionInit = ap.driver.requiresSessionInitForDelivery === true;
    // Reconciler step 7: a process that has no session yet does not take one
    // that started on another runtime (or Codex model) than it runs.
    const startSessionId = (ap.sessionId || requiresSessionInit) ? null : this.sessionIdUnlessSpecChanged(agentId, start.config.sessionId, ap.startedSpec, start.launchId, start.config);
    const nextSessionId = ap.sessionId || startSessionId;
    const nextSessionReadyForDelivery = nextSessionId
      ? (nextSessionId === ap.sessionId ? ap.sessionReadyForDelivery : this.initialSessionReadyForDelivery(ap.driver, start.config, nextSessionId))
      : false;
    const nextConfigSessionId = nextSessionId || (
      requiresSessionInit
        ? start.config.sessionId || null
        : ap.config.sessionId || start.config.sessionId || null
    );
    this.runtimeProcessBindingFence.rebindLaunch(agentId, ap, nextLaunchId);
    this.runtimeProcessBindingFence.rebindSession(agentId, ap, nextSessionId, "server_start_rebind");
    ap.launchId = nextLaunchId;
    ap.startDispatchId = start.startDispatchId ?? ap.startDispatchId;
    ap.sessionId = nextSessionId;
    this.serverContext.noteSession(agentId, ap.processInstanceId, nextSessionId);
    ap.sessionReadyForDelivery = nextSessionReadyForDelivery;
    // Reconciler step 11: a start older than a config already applied rebinds
    // the launch, session and wake, but the running config stays the newer one.
    const staleConfig = this.configRevisions.isStaleStart(start.config);
    if (staleConfig) {
      this.recordDaemonEvent("daemon.agent.config_push", { agentId, outcome: "stale_start_config_kept", launchId: nextLaunchId || undefined });
      logger.info(`[Agent ${agentId}] Start rebound; its config is older than the one applied, which stays`);
    }
    this.replaceRunningConfig(agentId, ap, staleConfig ? ap.config : start.config, nextConfigSessionId);

    this.recordStartRebind(agentId, start, reason, previousLaunchId, nextLaunchId, nextSessionId);
    // RFC 071: this launch is carried by the registered process.
    if (start.launchId) this.settleLaunches(agentId, [start.launchId], { kind: "rebound", processInstanceId: ap.processInstanceId });

    this.sendAgentStatus(agentId, "active", nextLaunchId);
    // A process that already produced output is ready for the launch it now carries.
    if (ap.startup.kind === "ready") this.sendStartupReady(agentId, ap);
    this.reportSession(agentId, ap, nextSessionId);
    if (start.wakeMessage) {
      const accepted = this.deliverMessage(agentId, start.wakeMessage, { transient: start.wakeMessageTransient === true });
      if (accepted instanceof Promise) {
        accepted.catch((err) => {
          logger.error(`[Agent ${agentId}] Failed to deliver wake message after start rebind`, err);
          this.recordDaemonEvent("daemon.agent.wake_delivery_failed", {
            agentId,
            outcome: "error",
            reason: "wake_delivery_threw",
            error_class: errorClassOf(err),
          }, "error");
        });
      }
    }

    return true;
  }

  /**
   * A start whose config names another runtime than the running process is
   * bound to is never rebound onto it: the binding fence would refuse all its
   * input and output from then on (`runtime_mismatch`). The process is
   * stopped (silently: the start owns the status), and the start spawns its
   * own runtime once that exit is seen (`exitingRuntimes`). A start older than
   * the applied config replaces nothing (it keeps the running config). A turn
   * the process was running is lost, as at a person's stop. Returns whether
   * it stopped the process.
   */
  private stopProcessForStartOfAnotherRuntime(agentId: string, config: AgentConfig, launchId: string | undefined): boolean {
    const running = this.agents.get(agentId);
    if (!running || this.configRevisions.isStaleStart(config) || !this.runtimeProcessBindingFence.refusesRuntime(running, config.runtime)) return false;
    this.recordDaemonEvent("daemon.agent.start.replaces_process", {
      agentId,
      launchId,
      runtime: config.runtime,
      previous_runtime: running.driver.id,
      process_instance_id: running.processInstanceId,
    });
    logger.info(`[Agent ${agentId}] Start names ${config.runtime}; stopping the ${running.driver.id} process instead of rebinding onto it`);
    void this.stopAgent(agentId, { silent: true });
    return true;
  }

  /**
   * The live process takes `config` as the config it should run with (a
   * rebound start, reconciler step 11's `agent:config`): it keeps its own
   * runner credential and `sessionId`, its restart snapshot follows, and one
   * entry decides it (`reconcile`): a drifted spec stops it once idle. Both
   * callers go through here, so they cannot diverge. Wakes nothing.
   */
  private replaceRunningConfig(agentId: string, ap: AgentProcess, config: AgentConfig, sessionId: string | null): void {
    const { agentCredentialKey, agentCredentialId } = ap.config;
    const heldBeforeRebind = Boolean(this.credentialInvalidHold(agentId, ap.config));
    const featuresBeforeRebind = pickAgentServerFeatures(ap.config);
    ap.config = { ...stripManagedRunnerCredential(config), sessionId, agentCredentialKey, agentCredentialId };
    // Reconciler step 4a: a rebound start with another model (or credential)
    // may end the invalid credential's hold on this process.
    this.releaseCredentialInvalidForModelChange(agentId, ap.config);
    const heldAfterRebind = Boolean(this.credentialInvalidHold(agentId, ap.config));
    if (heldBeforeRebind && !heldAfterRebind) this.endCredentialInvalidHeldNotice(agentId, ap, "model_changed");
    if (!heldBeforeRebind && heldAfterRebind) this.publishCredentialInvalidHeldNotice(agentId, ap, "config_changed");
    if (heldBeforeRebind && !heldAfterRebind && ap.inbox.length > 0) {
      queueMicrotask(() => this.flushRuntimeErrorDeliveryBackoff(agentId));
    }
    this.lifecycleRecords.setRestartSnapshot(agentId, {
      config: this.buildRestartSafeConfig(ap.config, sessionId),
      sessionId,
      launchId: ap.launchId,
      processInstanceId: ap.processInstanceId,
    });
    // Reconciler step 7: the rebound config is the spec the process should
    // run with; one entry decides it (reconcile). Server features: on a
    // server that answers them, the config takes the rebound values, or a
    // later answer than that config. On one that does not, rebound values
    // that differ are taken as the session's, as before: no features restart
    // without server:features-v1 (every other spec kind still counts).
    if (this.serverFeaturesCapable) {
      this.adoptServerFeatures(agentId, ap, this.serverFeaturesNewerThanStart(agentId) ?? pickAgentServerFeatures(ap.config));
    } else if (!agentServerFeaturesEqual(featuresBeforeRebind, pickAgentServerFeatures(ap.config))) {
      ap.sessionServerFeatures = pickAgentServerFeatures(ap.config);
    }
    this.reconcile(agentId, ap, "signal");
  }

  /**
   * Reconciler step 11 (`agent:config`, ordered by the core with
   * AgentConfigRevisions): the agent's current config, never a wake.
   *
   * - A live process takes it (`replaceRunningConfig`): a spec that drifted
   *   stops it once idle (turn end, empty inbox), the next start runs on it.
   *   A per-turn runtime has no drift: its next turn spawns from it.
   * - No process: held (AgentConfigRevisions) for the next registration on
   *   either host, which applies it if it is newer than the start it carries
   *   (`applyHeldConfigPush`, the OAR host's `startHosted`).
   * - And with only a restart snapshot (idle): the snapshot takes it, so the
   *   next wake starts on it; one that needs a new session or another
   *   runtime or host is dropped instead, and the next delivery finds no
   *   process: the server starts the agent (`specChangeNeedsServerStart`).
   *
   * Unlike a start, it never wakes, rebinds a launch or reports a session.
   */
  applyConfig(agentId: string, config: AgentConfig, revision: number): void {
    const ap = this.agents.get(agentId);
    // Kept for the next registration on either host: a start older than it
    // may still register a new process (AgentConfigRevisions).
    this.configRevisions.holdPush(agentId, { config, revision });
    if (ap) {
      this.applyConfigToProcess(agentId, ap, config, revision, "running");
      return;
    }
    // No process: a start may be queued or spawning here, minting its
    // credential in the core, or on its way to the OAR host. The
    // registration decides the held push against its start.
    const record = this.agentLifecycleRecord(agentId);
    if (!this.agentStarts.hasStarting(agentId) && !this.agentStarts.hasQueued(agentId)
      && (record?.kind === "idle" || record?.kind === "cooldown")) {
      this.applyConfigToRestartSnapshot(agentId, record.restartSnapshot, config, revision);
      return;
    }
    this.recordDaemonEvent("daemon.agent.config_push", { agentId, revision, outcome: "held_until_registered" });
  }

  private applyConfigToProcess(agentId: string, ap: AgentProcess, config: AgentConfig, revision: number, stage: "running" | "registered"): void {
    // As a start: this config is as new as the server features applied so far.
    this.startConfigFeaturesGeneration.set(agentId, this.serverFeaturesGeneration);
    this.replaceRunningConfig(agentId, ap, config, ap.sessionId || ap.config.sessionId || null);
    const drift = this.specDrift(ap);
    this.recordDaemonEvent("daemon.agent.config_push", {
      agentId,
      revision,
      outcome: "applied",
      stage,
      launchId: ap.launchId || undefined,
      // Kinds only, never a value.
      drift: drift.join(",") || undefined,
    });
    logger.info(`[Agent ${agentId}] Config revision ${revision} applied${drift.length > 0 ? ` (spec drift: ${drift.join(", ")}; restarts once idle)` : ""}`);
  }

  private applyConfigToRestartSnapshot(agentId: string, snapshot: AgentRestartSnapshot, config: AgentConfig, revision: number): void {
    const before = runtimeSpecOf(snapshot.config);
    const after = runtimeSpecOf(config);
    if (specChangeNeedsServerStart(before, after) || sessionDropReason(before, after) !== null) {
      this.lifecycleRecords.deleteRestartSnapshot(agentId);
      this.specHandbacks.mark(agentId);
      this.recordDaemonEvent("daemon.agent.config_push", { agentId, revision, outcome: "idle_handed_to_server" });
      logger.info(`[Agent ${agentId}] Config revision ${revision} needs a new session or host; the server starts the agent at its next message`);
      return;
    }
    this.lifecycleRecords.setRestartSnapshot(agentId, { ...snapshot, config: this.buildRestartSafeConfig(config, snapshot.sessionId) });
    this.recordDaemonEvent("daemon.agent.config_push", { agentId, revision, outcome: "idle_snapshot_updated" });
  }

  /**
   * A config pushed before the agent's process registered: applied now if it
   * is newer than the start the process carries (AgentConfigRevisions), else
   * dropped.
   */
  private applyHeldConfigPush(agentId: string, ap: AgentProcess): void {
    const held = this.configRevisions.takeHeldPush(agentId);
    if (!held) return;
    if (!held.applies) {
      this.recordDaemonEvent("daemon.agent.config_push", { agentId, revision: held.push.revision, outcome: "held_dropped_stale" });
      logger.info(`[Agent ${agentId}] Config revision ${held.push.revision} pushed before registration is not newer than its start; dropped`);
      return;
    }
    this.applyConfigToProcess(agentId, ap, held.push.config, held.push.revision, "registered");
  }

  /**
   * The one place this host reports a process's session to the server
   * (`agent:session`; also `getAgentSessionId`): never one whose config no
   * longer takes it (#13295 residual). After a Codex model or runtime change
   * the server forgets the session; a process still running the old one must
   * not report it back, or the next start resumes it.
   */
  private reportableSessionId(ap: AgentProcess | undefined, sessionId: string | null | undefined): string | null {
    if (!sessionId) return null;
    if (ap && sessionDropReason(ap.startedSpec, runtimeSpecOf(ap.config)) !== null) return null;
    return sessionId;
  }

  private reportSession(agentId: string, ap: AgentProcess | undefined, sessionId: string | null | undefined): void {
    const reportable = this.reportableSessionId(ap, sessionId);
    if (!reportable) return;
    this.sendToServer({ type: "agent:session", agentId, sessionId: reportable, launchId: ap?.launchId || undefined });
  }

  /**
   * RFC 071 outbox: the rebind gate refused to let the running process carry
   * this start. The process keeps running as it was (the refusal does not
   * stop it); the start's launch gets its refusal, and its wake message is
   * not lost: it is delivered like any message to the running process.
   */
  private refuseRunningRebind(
    agentId: string,
    start: PendingStartRebind,
    reason: "terminal_failure_needs_manual" | "terminal_failure_outcome_storage_blocked",
    detail: string,
  ): void {
    logger.warn(`[Agent ${agentId}] ${detail}`);
    this.recordDaemonEvent("daemon.agent.start.refused", {
      agentId,
      launchId: start.launchId,
      stage: "rebind",
      reason,
      refusal_detail: detail,
    }, "error");
    if (start.launchId) this.settleLaunches(agentId, [start.launchId], { kind: "not_spawned", reason });
    if (start.wakeMessage) this.keepRefusedWakeMessage(agentId, start.wakeMessage, start.wakeMessageTransient === true);
  }

  private keepRefusedWakeMessage(agentId: string, message: AgentMessage, transient: boolean): void {
    const accepted = this.deliverMessage(agentId, message, { transient });
    if (accepted instanceof Promise) {
      accepted.catch((err) => {
        logger.error(`[Agent ${agentId}] Failed to deliver the wake message of a refused start`, err);
        this.recordDaemonEvent("daemon.agent.wake_delivery_failed", {
          agentId,
          outcome: "error",
          reason: "refused_start_wake_delivery_threw",
          error_class: errorClassOf(err),
        }, "error");
      });
    }
  }

  /**
   * RFC 071 outbox: the spawn gate refused a start under the automatic-start
   * rule (the agent is unreliable, or has an un-acked gap / cross marker no
   * persisted human takeover covers). Nothing is spawned. The agent takes the existing no-process
   * refusal state (terminal failure record, as a terminal runtime error
   * does): its start-pending messages are kept, the wake message of this
   * start and of a deferred rebind are added to them, later deliveries are
   * kept the same way and no automatic restart is attempted; the reason
   * (`detail`, with the way out) is logged, traced and shown. A human start
   * (a server `agent:start` with `humanStart`) is the way out.
   */
  private refuseUnreliableSpawn(
    agentId: string,
    start: { config: AgentConfig; wakeMessage?: AgentMessage; wakeMessageTransient: boolean; launchId?: string; startDispatchId?: string },
    detail: string,
    spawnTraceparent: string,
    reason: "terminal_failure_needs_manual" | "terminal_failure_outcome_storage_blocked" = "terminal_failure_needs_manual",
  ): void {
    const pending = this.lifecycleRecords.getPendingStartRebind(agentId);
    this.lifecycleRecords.deletePendingStartRebind(agentId);
    this.lifecycleRecords.deletePendingSpawnCause(agentId);
    const kept: AgentMessage[] = [];
    for (const candidate of [
      { message: start.wakeMessage, transient: start.wakeMessageTransient },
      { message: pending?.wakeMessage, transient: pending?.wakeMessageTransient === true },
    ]) {
      if (!candidate.message || candidate.transient) continue;
      if (kept.some((message) => this.sameWakeMessage(message, candidate.message))) continue;
      if (this.startingInboxes.values(agentId).some((message) => this.sameWakeMessage(message, candidate.message))) continue;
      kept.push(candidate.message);
    }
    const launchId = pending?.launchId || start.launchId || null;
    // Every accepted server launch still waiting gets its result, with the
    // refusal's own reason (storage_blocked and needs_manual clear differently).
    this.settleAllAcceptedLaunches(agentId, reason);
    this.cancelRuntimeErrorProcessRestart(agentId);
    this.lifecycleRecords.setTerminalFailure(agentId, { detail, launchId });
    if (kept.length > 0) this.startingInboxes.bufferMessagesDuringStart(agentId, kept);
    this.closeNoProcessResidency(agentId, "terminal", { negativeEvidenceBucket: "runtime_outcome_unreliable" });
    this.enterNoProcessResidency(
      "terminal_runtime_error",
      this.noProcessResidencyIdentity(agentId, pending?.config ?? start.config, launchId, "terminal_runtime_error"),
      {
        isWaitState: false,
        failureKind: "runtime_outcome_unreliable",
        negativeEvidenceBucket: "runtime_outcome_unreliable",
      },
    );
    this.assertStartPendingDeliveryInvariants("unreliable-start-refused");
    logger.warn(`[Agent ${agentId}] Start refused, nothing spawned: ${detail}`);
    this.recordDaemonEvent("daemon.agent.start.refused", {
      agentId,
      launchId: launchId || undefined,
      start_dispatch_id: start.startDispatchId,
      stage: "spawn",
      reason: "runtime_outcome_unreliable",
      refusal_detail: detail,
      kept_message_count: this.startingInboxes.count(agentId),
    }, "error", spawnTraceparent);
    this.sendAgentStatus(agentId, "inactive", launchId);
    this.broadcastActivity(agentId, "error", detail, [], launchId, "runtime_error");
  }

  /**
   * RFC 071: DaemonCore accepted a server `agent:start` for this launch. The
   * launch now owes exactly one final result: named in `process_spawned`
   * (its own launch or `supersededLaunchIds`), `rebound` onto a running
   * process, or `not_spawned` with a reason. Internal restarts never call this.
   */
  noteServerStartAccepted(agentId: string, launchId: string | undefined): boolean {
    if (!launchId) return true;
    const pending = this.acceptedLaunches.get(agentId) ?? [];
    if (pending.includes(launchId)) return true;
    // Bounded admission: never drop an accepted launch. When the agent already
    // has the maximum number of launches waiting for a result, this start is
    // refused before acceptance and gets its own correlated final result.
    if (pending.length >= ACCEPTED_LAUNCHES_PER_AGENT_MAX) {
      if (this.daemonInstanceId) {
        this.sendToServer({
          type: "agent:start:outcome",
          agentId,
          daemonInstanceId: this.daemonInstanceId,
          launchId,
          clientSeq: this.activitySink.nextClientSeq(agentId),
          result: { kind: "not_spawned", reason: "admission_full" },
        });
      }
      return false;
    }
    pending.push(launchId);
    this.acceptedLaunches.set(agentId, pending);
    return true;
  }

  /** task #365: from `machine:context` (see `serverStartContext`). */
  setServerStartContext(context: { spawnErrorCapable: boolean; connectionEpochId: string | null }): void {
    this.serverStartContext = { ...context };
  }

  /** Agent typing line: the connected server accepts `agent:send_intent` (false on disconnect). */
  setServerSendIntentCapable(capable: boolean): void {
    this.sendIntents.setCapable(capable);
  }

  /** The current server reads `agent:turn:ended` (SERVER_CAPABILITY_TURN_ENDED_V1). */
  setServerTurnEndedCapable(capable: boolean): void {
    this.serverReadsTurnEnded = capable;
  }

  /**
   * Reconciler step 12: the current server counts `model_unsupported` and
   * `runtime_repeated_failure` (SERVER_CAPABILITY_STICKY_FAILURE_REASONS_V1);
   * otherwise those are reported as `runtime_spawn_failed`.
   */
  setServerStickyFailureReasonsCapable(capable: boolean): void {
    this.serverCountsStickyReasons = capable;
  }

  /** task #365: the current connection's server-side id, null before `machine:context` or from an older server. */
  /**
   * task #365: a start's claimed connection epoch (`claimedConnectionEpochId`,
   * carried with the start itself) names another connection than the current
   * one. A start without one (older server, human start, daemon-internal
   * restart) has no claim to check.
   */
  private isStaleClaim(claimedConnectionEpochId: string | null): boolean {
    const current = this.serverStartContext.connectionEpochId;
    return Boolean(claimedConnectionEpochId && current && claimedConnectionEpochId !== current);
  }

  get currentConnectionEpochId(): string | null {
    return this.serverStartContext.connectionEpochId;
  }

  /** task #365: whether a proven never-created child is reported as `not_spawned: spawn_error` (else: today's crash path). */
  get reportsSpawnError(): boolean {
    return this.serverStartContext.spawnErrorCapable;
  }

  /**
   * task #365: after `start()` returned without a pid, wait for the spawn
   * outcome. `spawn_error`: the runtime's `error` named a spawn syscall (the
   * listener in spawnAgentProcess records it; an error that fired before this
   * call is seen through `spawnErrorSyscall`). `closed`: the child closed with
   * no spawn error. `unknown`: neither within the bound; whether a process was
   * created is not known.
   */
  private waitForSpawnEvidence(runtime: RuntimeSession, ap: AgentProcess, timeoutMs: number): Promise<"spawn_error" | "closed" | "unknown"> {
    if (isSpawnSyscall(ap.spawnErrorSyscall)) return Promise.resolve("spawn_error");
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: "spawn_error" | "closed" | "unknown") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      // Registered after spawnAgentProcess's own error listener, so the
      // syscall is already recorded when this one runs.
      runtime.on("error", () => {
        if (isSpawnSyscall(ap.spawnErrorSyscall)) finish("spawn_error");
      });
      runtime.on("close", () => finish(isSpawnSyscall(ap.spawnErrorSyscall) ? "spawn_error" : "closed"));
      const timer = setTimeout(() => finish("unknown"), timeoutMs);
      (timer as { unref?: () => void }).unref?.();
    });
  }

  /**
   * task #365: a start whose spawn outcome stayed unknown past the bound. It
   * is not settled and its pending identity stays (the server keeps it in
   * `unexited`, so automatic starts stay refused); the record stays
   * registered, so the agent cannot overlap it. A spawn error that arrives
   * later proves it never existed and settles it then.
   */
  private holdUnknownSpawn(agentId: string, ap: AgentProcess, runtime: RuntimeSession, launchId: string | null): void {
    runtime.on("error", () => {
      if (!isSpawnSyscall(ap.spawnErrorSyscall) || this.agents.get(agentId) !== ap) return;
      ap.spawnNoProcess = true;
      this.settleAllAcceptedLaunches(agentId, "spawn_error");
      if (!ap.spawnReported && this.runtimeProcessGate && this.daemonInstanceId) {
        this.runtimeProcessGate.processNotStarted(agentId, ap.processInstanceId);
      }
      this.agentStarts.clearStarting(agentId);
      const error = new RuntimeSpawnNoProcessError(ap.spawnError ?? "spawn failed", ap.spawnErrorSyscall);
      this.cleanupFailedRuntimeStart(agentId, ap, error);
      this.recordDaemonEvent("daemon.agent.spawn.late_spawn_error", { agentId, launchId: launchId ?? undefined });
      this.sendAgentStatus(agentId, "inactive", launchId);
    });
  }

  /**
   * RFC 071: a start DaemonCore failed on its own (before or around the
   * process manager). Settles the launch `not_spawned` only if it is still
   * waiting for a result; a launch the process manager already settled
   * (spawned, rebound, or failed with its own reason) is left alone.
   */
  settleServerStartNotSpawned(agentId: string, launchId: string | undefined, reason: AgentStartNotSpawnedReason): void {
    if (!launchId || !this.acceptedLaunches.get(agentId)?.includes(launchId)) return;
    this.settleLaunches(agentId, [launchId], { kind: "not_spawned", reason });
  }

  getAgentStartAcceptance(agentId: string): AgentStartAcceptance {
    const acceptance = this.agentStartDispatch.acceptance(agentId, this.agents.has(agentId));
    // RFC 071 §4.3 rule 2: a rebind names the registered process that now
    // carries the launch. A queued/starting start has no process yet; its id
    // is minted after the spawn and sent on agent:process_spawned.
    if (acceptance.queueState !== "running" && acceptance.queueState !== "rebound") return acceptance;
    const registered = this.agents.get(agentId);
    return registered ? { ...acceptance, processInstanceId: registered.processInstanceId } : acceptance;
  }

  /**
   * Wake an Agent because its Computer-local typed Inbox gained an app item.
   * This is deliberately not an AgentMessage: no channel/message/sender
   * identity is fabricated and no Server delivery cursor is touched.
   */
  async notifyAgentAppInbox(
    agentId: string,
    item: AgentInboxAppItem,
    noticeOptions?: AgentAppInboxNoticeOptions,
  ): Promise<boolean> {
    const traceAttrs = appInboxItemTraceAttrs(agentId, item);
    const appItems = this.#appInboxForAgent?.(agentId).list() ?? [];
    this.pruneAppInboxNoticeMemo(agentId, appItems);
    const waited = this.appInboxBusyDeferrals.get(agentId);
    if (waited && !appItems.some((pending) => pending.itemId === waited.itemId)) {
      this.appInboxBusyDeferrals.delete(agentId);
    }
    const count = appItems.length;
    const recordNotice = (
      outcome: string,
      status: "ok" | "error",
      mode?: "idle" | "busy",
      extra?: Record<string, unknown>,
    ) => {
      const deferral = this.appInboxBusyDeferrals.get(agentId);
      if (deferral) this.appInboxBusyDeferrals.delete(agentId);
      this.recordDaemonEvent("daemon.agent.app_inbox_notice", {
        ...traceAttrs,
        outcome,
        ...(mode ? { mode } : {}),
        pending_app_items: count,
        message_identity_created: false,
        ...extra,
        ...(deferral
          ? {
            busy_retry_attempts: deferral.attempts,
            busy_wait_ms: Math.max(0, this.clockNow() - deferral.firstAtMs),
          }
          : {}),
      }, status);
    };
    if (count === 0) {
      recordNotice("empty", "error");
      return false;
    }
    const undelivered = this.undeliveredAppInboxItems(agentId, appItems);
    if (undelivered.length === 0) {
      recordNotice("already_delivered", "ok");
      return true;
    }
    const ap = this.agents.get(agentId);
    const noticeFor = (config: AgentConfig, driver: RuntimeDriver, pendingMessages: number) => appInboxNoticeText({
      items: appItems,
      undelivered,
      pendingMessages,
      driver,
      options: inboxUpdateRenderOptions(config),
      inboxItemsLaunchAtMs: inboxItemsLaunchAtMs(config),
      nowMs: this.clockNow(),
    });
    if (ap && this.canDeliverToRuntimeSession(ap)) {
      const notice = noticeFor(ap.config, ap.driver, ap.inbox.length);
      const idle = this.isApmIdle(ap);
      const mode = idle ? "idle" : "busy";
      if (!idle && noticeOptions?.requireIdle) {
        // Not marked delivered: the next idle drain offers it.
        recordNotice("deferred_until_idle", "ok", mode);
        return true;
      }
      if (this.drain.holds(agentId)) {
        // Reconciler step 13: not marked delivered; the end of the drain offers it again.
        recordNotice("held_for_drain", "ok", mode);
        return true;
      }
      if ((idle && !ap.driver.supportsStdinNotification) || (!idle && ap.runtime.descriptor.busyDelivery !== "direct")) {
        if (ap.driver.lifecycle.kind === "per_turn") {
          const wakeItemIds = new Set(this.appInboxNoticesAfterTurn.get(agentId)?.wakeItemIds ?? []);
          if (noticeOptions?.startStoppedAgent !== false) wakeItemIds.add(item.itemId);
          this.appInboxNoticesAfterTurn.set(agentId, { wakeItemIds });
          recordNotice("deferred_until_turn_exit", "ok", mode);
          return true;
        }
        recordNotice("unsupported_delivery", "error", mode);
        return false;
      }
      // Claim the turn before writing (the write may synchronously emit runtime
      // events), but never leave the agent marked busy by a write that did not
      // land: a stuck busy flag makes every later notice take the busy path,
      // which a non-steerable runtime refuses forever.
      if (idle) {
        this.commitApmIdleState(agentId, ap, false);
        this.startRuntimeTrace(agentId, ap, "app-inbox-notice", undefined, appInboxTurnTriggerAttrs(undelivered, this.clockNow()));
      }
      let result!: RuntimeSendResult;
      try {
        result = this.sendRuntimeInput(
          agentId,
          ap,
          { mode, text: notice, sessionId: ap.sessionId },
          "app_inbox_notice",
        );
      } finally {
        if (idle && !result?.ok) {
          this.endRuntimeTrace(ap, "error", { outcome: "app_inbox_notice_not_written", ...runtimeTraceCounterAttrs(ap) });
          this.restoreApmIdleWithoutDrain(agentId, ap);
        }
      }
      if (!result.ok && mode === "busy") {
        // Busy must be backed by evidence; if it is not, offer the notice the
        // idle way instead of retrying a write the runtime will keep refusing.
        const drainHeld = this.appInboxIdleDrains.has(agentId);
        if (!drainHeld) this.appInboxIdleDrains.add(agentId);
        let cleared = false;
        try {
          cleared = this.revertBusyWithoutLiveTurn(agentId, ap, "app_inbox_notice")
            || this.clearStaleBusy(agentId, ap, "app_inbox_notice");
        } finally {
          if (!drainHeld) this.appInboxIdleDrains.delete(agentId);
        }
        if (cleared) {
          recordNotice("busy_state_cleared", "ok", mode, { failure_reason: result.reason });
          return this.notifyAgentAppInbox(agentId, item, noticeOptions);
        }
      }
      if (!result.ok && mode === "busy") {
        const deferral = this.appInboxBusyDeferrals.get(agentId);
        if (deferral) {
          deferral.attempts += 1;
        } else {
          recordNotice("write_failed", "error", mode, { failure_reason: result.reason });
          this.appInboxBusyDeferrals.set(agentId, { itemId: item.itemId, firstAtMs: this.clockNow(), attempts: 1 });
        }
        return false;
      }
      recordNotice(
        result.ok ? "written" : "write_failed",
        result.ok ? "ok" : "error",
        mode,
        result.ok ? undefined : { failure_reason: result.reason },
      );
      if (result.ok) {
        if (idle) this.watchTurnStart(agentId, ap, "app_inbox_notice");
        this.markAppInboxNoticeDelivered(agentId, appItems);
        this.observeDeliveryWrite(agentId, ap, item.itemId, "app_inbox_notice", mode === "busy");
      }
      return result.ok;
    }

    if (noticeOptions?.startStoppedAgent === false) {
      // Advisory item: it stays in the Inbox and the next ordinary wake
      // surfaces it. Not marked delivered, so that wake still notices it.
      recordNotice("advisory_not_running", "ok");
      return true;
    }
    const lifecycleRecord = this.agentLifecycleRecord(agentId);
    if (lifecycleRecord === undefined || lifecycleRecord.kind === "terminal") {
      // No process and no restart snapshot: every idle agent is in this state
      // after a daemon restart or upgrade. The Server owns the config, so the
      // wake is its decision (task #1103); nothing is retried locally.
      return this.requestServerWake(agentId, item, count, recordNotice);
    }
    if (lifecycleRecord.kind !== "idle") {
      recordNotice("not_idle", "error");
      return false;
    }
    const cached = lifecycleRecord.restartSnapshot;
    this.lifecycleRecords.deleteRestartSnapshot(agentId);
    const notice = noticeFor(cached.config, this.driverResolver(cached.config.runtime || "claude"), 0);
    try {
      // The new process outlives this notice flow, so its later events must
      // not inherit the span that triggered the restart.
      await runWithoutActiveSpan(() => this.startAgent(
        agentId,
        cached.config,
        undefined,
        undefined,
        notice,
        cached.launchId || undefined,
      ));
      recordNotice("restart_requested", "ok", "idle");
      this.markAppInboxNoticeDelivered(agentId, appItems);
      return true;
    } catch (error) {
      this.lifecycleRecords.setRestartSnapshot(agentId, cached);
      logger.error(`[Agent ${agentId}] Failed to restart for app Inbox notice`, error);
      recordNotice("restart_failed", "error", "idle");
      return false;
    }
  }

  /**
   * Idle task reminder (#wg-task-v2:#9): the live session the reminder asks
   * about. Null when no process with a deliverable session runs the agent: a
   * stopped agent is never asked about, so never woken.
   */
  idleNoticeFacts(agentId: string): AgentIdleNoticeFacts | null {
    const ap = this.agents.get(agentId);
    if (!ap || ap.exit.kind !== "live" || !this.canDeliverToRuntimeSession(ap)) return null;
    const resumeSessionId = ap.resumeSessionId ?? null;
    return {
      sessionId: ap.sessionId,
      launchId: ap.launchId,
      resumed: Boolean(resumeSessionId) && ap.sessionId === resumeSessionId,
      backgroundTasks: ap.backgroundTasks.size,
      blocked: this.runtimeErrorDeliveryBackoffRemainingMs(ap) > 0 || Boolean(this.credentialInvalidHold(agentId, ap.config)),
      deliveriesPending: this.hasUntoldInboxWork(ap) || this.appInboxIdleDrains.has(agentId),
      contextId: this.reportedContextId(ap),
    };
  }

  /** The context id a notice may count earlier notices against: only where the runtime reports compaction (null otherwise). */
  private reportedContextId(ap: AgentProcess): string | null {
    if (ap.driver.session.compaction !== "reported") return null;
    const record = readContextGeneration(ap.cliTransportDir);
    return record?.compactionReported ? record.contextId : null;
  }

  /**
   * Idle task reminder (#wg-task-v2:#9): write `text` as a new turn, only into
   * a live session that is idle with nothing else waiting for it (messages
   * and notices go first). Otherwise nothing is written and nothing is kept:
   * the reminder is asked for again at the next Working→Idle edge. Like an app
   * Inbox notice it is not an AgentMessage and touches no delivery cursor.
   */
  async deliverIdleNotice(agentId: string, text: string): Promise<AgentIdleNoticeDelivery> {
    const ap = this.agents.get(agentId);
    if (!ap || ap.exit.kind !== "live" || !this.canDeliverToRuntimeSession(ap)) return "not_running";
    if (!this.isApmIdle(ap)) return "busy";
    // Reconciler step 13: a drain starts no turn for a reminder; the end of the drain asks for it again.
    if (this.drain.holds(agentId)) {
      this.drainRefusedIdleNotices.add(agentId);
      return "busy";
    }
    if (this.hasUntoldInboxWork(ap) || this.appInboxIdleDrains.has(agentId)) return "messages_pending";
    // A runtime that only takes input at a process start (per_turn) has no idle session to write into.
    if (!ap.driver.supportsStdinNotification) return "unsupported";
    // Claim the turn before writing, and give it back if the write did not land
    // (as notifyAgentAppInbox does).
    this.commitApmIdleState(agentId, ap, false);
    this.startRuntimeTrace(agentId, ap, "idle-task-reminder", undefined, { trigger_kind: "wake_hint" });
    let result: RuntimeSendResult | undefined;
    try {
      result = this.sendRuntimeInput(
        agentId,
        ap,
        { mode: "idle", text, sessionId: ap.sessionId },
        "idle_task_reminder",
      );
    } finally {
      if (!result?.ok) {
        this.endRuntimeTrace(ap, "error", { outcome: "idle_task_reminder_not_written", ...runtimeTraceCounterAttrs(ap) });
        this.restoreApmIdleWithoutDrain(agentId, ap);
      }
    }
    if (!result.ok) return "write_failed";
    this.watchTurnStart(agentId, ap, "idle_task_reminder");
    return "written";
  }

  /**
   * A per_turn process exited with a deferred, waking app notice: deliver it
   * now through the no-process path, which restarts the agent with it.
   */
  private wakeForAppInboxNoticeAfterTurn(agentId: string): void {
    const deferral = this.appInboxNoticesAfterTurn.get(agentId);
    if (!deferral || deferral.wakeItemIds.size === 0) return;
    let appItems: readonly AgentInboxAppItem[];
    try {
      appItems = this.#appInboxForAgent?.(agentId).list() ?? [];
    } catch (error) {
      // Runs inside process-exit handling: a store failure must not escape.
      // The deferral is kept, so the next start still carries the notice.
      this.recordAppInboxUnavailable(agentId, "turn_exit_wake", error);
      return;
    }
    const pending = this.undeliveredAppInboxItems(agentId, appItems);
    if (pending.length === 0) {
      this.appInboxNoticesAfterTurn.delete(agentId);
      return;
    }
    const waking = pending.find((item) => deferral.wakeItemIds.has(item.itemId));
    if (!waking) {
      // Only advisory items are left: they ride the next start, waking nothing.
      this.appInboxNoticesAfterTurn.set(agentId, { wakeItemIds: new Set() });
      return;
    }
    this.appInboxNoticesAfterTurn.delete(agentId);
    void this.notifyAgentAppInbox(agentId, waking).catch((error) => {
      logger.error(`[Agent ${agentId}] Failed to wake for a deferred App Inbox notice`, error);
    });
  }

  /**
   * The deferred app notice for a per_turn start's first input, or null. A
   * store failure never fails the start: the deferral is kept for a later one.
   */
  private takeAppInboxNoticeForStartInput(agentId: string, config: AgentConfig, driver: RuntimeDriver): { text: AxSurfaceText; items: readonly AgentInboxAppItem[]; wakeItemIds: ReadonlySet<string> } | null {
    const deferral = this.appInboxNoticesAfterTurn.get(agentId);
    if (!deferral) return null;
    let appItems: readonly AgentInboxAppItem[];
    try {
      appItems = this.#appInboxForAgent?.(agentId).list() ?? [];
    } catch (error) {
      this.recordAppInboxUnavailable(agentId, "start_input", error);
      return null;
    }
    this.appInboxNoticesAfterTurn.delete(agentId);
    const pending = this.undeliveredAppInboxItems(agentId, appItems);
    if (pending.length === 0) return null;
    // task #925: marked delivered only once the process exists (the caller),
    // so a failed spawn leaves the notice for the next start.
    this.recordDaemonEvent("daemon.agent.app_inbox_notice", {
      ...appInboxItemTraceAttrs(agentId, pending[0]!),
      outcome: "carried_in_start_input",
      pending_app_items: appItems.length,
      message_identity_created: false,
    });
    const notice = appInboxNoticeText({
      items: appItems,
      undelivered: pending,
      pendingMessages: 0,
      driver,
      options: inboxUpdateRenderOptions(config),
      inboxItemsLaunchAtMs: inboxItemsLaunchAtMs(config),
      nowMs: this.clockNow(),
    });
    return { text: formatAppInboxNoticeSuffix(notice), items: appItems, wakeItemIds: deferral.wakeItemIds };
  }

  private recordAppInboxUnavailable(agentId: string, route: "turn_exit_wake" | "start_input" | "start_defer_check", error: unknown): void {
    logger.error(`[Agent ${agentId}] App Inbox unavailable for a deferred notice (${route})`, error);
    this.recordDaemonEvent("daemon.agent.app_inbox_notice", {
      owner_agent_id_present: true,
      outcome: "app_inbox_unavailable",
      route,
      message_identity_created: false,
      error_class: errorClassOf(error),
    }, "error");
  }

  private requestServerWake(
    agentId: string,
    item: AgentInboxAppItem,
    pendingAppItems: number,
    recordNotice: (outcome: string, status: "ok" | "error") => void,
  ): boolean {
    const existing = this.pendingServerWakes.get(agentId);
    if (existing && existing.itemId === item.itemId) {
      // Duplicate fire while the Server has not answered yet: the parked
      // request already carries this exact item and id.
      recordNotice("server_wake_pending", "ok");
      return true;
    }
    const pending: PendingServerWake = {
      wakeRequestId: serverWakeRequestId(agentId, item.itemId),
      itemId: item.itemId,
      appId: item.appId,
      sourceRef: {
        kind: item.sourceRef.kind,
        id: item.sourceRef.id,
        ...(item.sourceRef.revision !== undefined ? { revision: item.sourceRef.revision } : {}),
      },
      pendingAppItems,
      requestedAtMs: this.clockNow(),
    };
    const activeContext = getActiveTraceContext();
    if (activeContext) pending.traceparent = formatTraceparent(activeContext);
    this.pendingServerWakes.set(agentId, pending);
    if (!this.serverConnected()) {
      // Parked, not dropped: handleConnect resends it once. No local timer.
      recordNotice("server_wake_queued_offline", "ok");
      return true;
    }
    this.sendToServer(this.serverWakeRequestMessage(agentId, pending));
    recordNotice("server_wake_requested", "ok");
    return true;
  }

  private serverWakeRequestMessage(
    agentId: string,
    pending: PendingServerWake,
  ): Extract<MachineToServerMessage, { type: "agent:wake:request" }> {
    return {
      type: "agent:wake:request",
      agentId,
      wakeRequestId: pending.wakeRequestId,
      reason: "app_inbox_notice",
      appId: pending.appId,
      sourceRef: pending.sourceRef,
      pendingAppItems: pending.pendingAppItems,
      ...(pending.traceparent ? { traceparent: pending.traceparent } : {}),
    };
  }

  /** Resend every parked server wake once; called on each connect edge. */
  resendPendingServerWakes(): void {
    for (const [agentId, pending] of this.pendingServerWakes) {
      this.sendToServer(this.serverWakeRequestMessage(agentId, pending));
      this.recordDaemonEvent("daemon.agent.server_wake.resent", {
        agent_id: agentId,
        wake_request_id: pending.wakeRequestId,
        item_id: pending.itemId,
        requested_at_ms: pending.requestedAtMs,
      }, "ok");
    }
  }

  /** The Server's typed answer to a parked wake request. */
  handleServerWakeOutcome(msg: Extract<ServerToMachineMessage, { type: "agent:wake:outcome" }>): void {
    const pending = this.pendingServerWakes.get(msg.agentId);
    const attrs = {
      agent_id: msg.agentId,
      wake_request_id: msg.wakeRequestId,
      outcome: msg.outcome,
      ...(msg.reason ? { reason: msg.reason } : {}),
      matched_pending: pending?.wakeRequestId === msg.wakeRequestId,
    };
    if (!pending || pending.wakeRequestId !== msg.wakeRequestId) {
      // Stale or unknown: never apply it to a different live request.
      this.recordDaemonEvent("daemon.agent.server_wake.outcome", { ...attrs, ignored: true }, "ok");
      return;
    }
    this.pendingServerWakes.delete(msg.agentId);
    if (msg.outcome === "dispatched") {
      this.recordDaemonEvent("daemon.agent.server_wake.outcome", attrs, "ok");
      return;
    }
    // Refused is terminal for this request; the inbox item stays visible and
    // the next fire may ask again (the Server may have changed its answer).
    logger.error(`[Agent ${msg.agentId}] Server refused wake for due app-inbox item ${pending.itemId}: ${msg.reason ?? "unspecified"}`);
    this.recordDaemonEvent("daemon.agent.server_wake.outcome", attrs, "error");
  }

  /**
   * `recoveryGrant`: only for the admitted human start `launchId` is (RFC 071
   * outbox); every internal caller (restart, cold start, ...) passes none and
   * is checked as an automatic start.
   */
  async startAgent(agentId: string, config: AgentConfig, wakeMessage?: AgentMessage, unreadSummary?: Record<string, number>, resumePrompt?: string, launchId?: string, wakeMessageTransient = false, resumeMessages?: AgentMessage[], startDispatchId?: string, traceParent?: TraceContext | null, catchupBatchId?: string, recoveryGrant: RecoveryGrant | null = null, claimedConnectionEpochId: string | null = null) {
    // task #26: a server start woken by its own server context (the owner
    // facts) holds it and starts without a wake message; the facts ride the
    // start's first prompt instead of becoming an inbox row.
    if (wakeMessage && isServerContextMessage(wakeMessage)) {
      this.holdServerContext(agentId, wakeMessage);
      wakeMessage = undefined;
    }
    if (resumeMessages?.some(isServerContextMessage)) {
      for (const message of resumeMessages.filter(isServerContextMessage)) this.holdServerContext(agentId, message);
      resumeMessages = resumeMessages.filter((message) => !isServerContextMessage(message));
    }
    // Any start settles a parked server wake: the pending app-inbox items are
    // replayed to the new process by the ordinary start path.
    const answeredServerWake = this.pendingServerWakes.get(agentId);
    this.pendingServerWakes.delete(agentId);
    if (answeredServerWake) this.serverWakeStartsOwed.set(agentId, answeredServerWake.itemId);
    if (launchId && catchupBatchId) {
      this.startCatchupBatches.set(agentId, { launchId, batchId: catchupBatchId });
    } else {
      this.startCatchupBatches.delete(agentId);
    }
    // Supersede pending stop completions before queuing or awaiting startup.
    // Even a failed replacement owns the newer status.
    this.lifecycleRecords.recordStart(agentId);
    this.forgetSpecHandback(agentId);
    // Server features: this config is as new as the answers applied so far.
    this.startConfigFeaturesGeneration.set(agentId, this.serverFeaturesGeneration);
    // Back on this host: what it last ran on another host is no longer what it runs.
    this.lastHostedSessions.delete(agentId);
    this.contextView.observeFlag(agentId, config.agentContextView === true, "start");
    this.releaseCredentialInvalidForModelChange(agentId, config);
    // Reconciler step 12: another runtime or model may work.
    this.lifecycleRecords.exitStreaks.sticky.forgetUnusableModelUnless(agentId, config.runtime || "claude", config.model);
    this.recordDaemonEvent("daemon.agent.start.requested", this.agentStartDispatch.traceAttrs(agentId, config, wakeMessage, unreadSummary, resumePrompt, launchId, wakeMessageTransient, resumeMessages, startDispatchId));
    // A start of another runtime queues behind the stop of the running process.
    this.stopProcessForStartOfAnotherRuntime(agentId, config, launchId);
    if (this.agents.has(agentId)) {
      this.recordDaemonEvent("daemon.agent.start.ignored", {
        ...this.agentStartDispatch.traceAttrs(agentId, config, wakeMessage, unreadSummary, resumePrompt, launchId, wakeMessageTransient, resumeMessages, startDispatchId),
        reason: "already_running",
      });
      this.rebindRunningStart(agentId, { config, wakeMessage, unreadSummary, resumePrompt, launchId, wakeMessageTransient, resumeMessages, startDispatchId, recoveryGrant, claimedConnectionEpochId }, "already_running");
      logger.info(`[Agent ${agentId}] Start rebound (already running, launchId=${launchId ?? "none"})`);
      void this.contextView.reportAvailability(agentId, "rebind", true);
      return;
    }
    if (this.agentStarts.hasStarting(agentId)) {
      this.recordDaemonEvent("daemon.agent.start.ignored", {
        ...this.agentStartDispatch.traceAttrs(agentId, config, wakeMessage, unreadSummary, resumePrompt, launchId, wakeMessageTransient, resumeMessages, startDispatchId),
        reason: "already_starting",
      });
      this.deferStartRebind(agentId, {
        config,
        wakeMessage,
        unreadSummary,
        resumePrompt,
        launchId,
        wakeMessageTransient,
        resumeMessages,
        startDispatchId,
        recoveryGrant,
        claimedConnectionEpochId,
        stopEpochAtRebind: this.lifecycleRecords.stopEpoch(agentId),
      });
      logger.info(`[Agent ${agentId}] Start rebind deferred (startup in progress)`);
      return;
    }
    if (this.agentStarts.hasQueued(agentId)) {
      this.recordDaemonEvent("daemon.agent.start.ignored", {
        ...this.agentStartDispatch.traceAttrs(agentId, config, wakeMessage, unreadSummary, resumePrompt, launchId, wakeMessageTransient, resumeMessages, startDispatchId),
        reason: "already_queued",
      });
      this.rebindQueuedStart(agentId, { config, wakeMessage, unreadSummary, resumePrompt, launchId, wakeMessageTransient, resumeMessages, startDispatchId, recoveryGrant, claimedConnectionEpochId }, "already_queued");
      logger.info(`[Agent ${agentId}] Queued start rebound (startup already queued)`);
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const item: AgentStartQueueItem = {
        agentId,
        startDispatchId,
        enqueuedAtMs: this.clockNow(),
        config,
        wakeMessage,
        wakeMessageTransient,
        resumeMessages,
        unreadSummary,
        resumePrompt,
        launchId,
        recoveryGrant,
        claimedConnectionEpochId,
        traceParent: traceParent ?? getActiveTraceContext(),
        resolve,
        reject,
      };
      this.agentStarts.enqueue(item);
      this.recordDaemonEvent("daemon.agent.start.queued", this.agentStartDispatch.traceAttrs(agentId, config, wakeMessage, unreadSummary, resumePrompt, launchId, wakeMessageTransient, resumeMessages, startDispatchId));
      const startSnapshot = this.agentStarts.snapshot();
      this.enterNoProcessResidency(
        "queued_start",
        this.noProcessResidencyIdentity(agentId, config, launchId, this.startLaunchSource(config, wakeMessage, resumePrompt)),
        {
          isWaitState: true,
          fenceKind: "start_scheduler",
          deadlineUnixMs: this.clockNow() + Math.max(1, startSnapshot.minStartIntervalMs),
        },
      );
      logger.info(
        `[Agent ${agentId}] Start queued ` +
        `(launchId=${launchId ?? "none"}, queue=${startSnapshot.queueDepth}, active=${startSnapshot.activeStarts}, ` +
        `max=${startSnapshot.maxConcurrentStarts}, interval=${startSnapshot.minStartIntervalMs}ms)`,
      );
      this.pumpAgentStartQueue();
    });
  }

  private pumpAgentStartQueue() {
    // Reconciler step 13: a drain holds queued starts (acked as queued); its end runs the queue.
    // A drain of one agent (step 14) holds no start.
    if (this.drain.holdingStarts) return;
    const pumpState = this.agentStarts.getPumpState();
    if (pumpState.kind === "blocked") return;
    if (pumpState.kind === "rate_limited") {
      const { item: next, waitMs } = pumpState;
      this.recordDaemonEvent("daemon.agent.start.rate_limited", {
        ...this.agentStartDispatch.traceAttrs(next.agentId, next.config, next.wakeMessage, next.unreadSummary, next.resumePrompt, next.launchId, next.wakeMessageTransient, next.resumeMessages, next.startDispatchId),
        wait_ms: waitMs,
      });
      this.agentStarts.schedulePump(waitMs, () => this.pumpAgentStartQueue());
      return;
    }

    const dequeued = this.agentStarts.dequeue();
    if (dequeued.kind === "empty") return;
    if (dequeued.kind === "stale") {
      const { item } = dequeued;
      this.closeNoProcessResidency(item.agentId, "suppressed", { negativeEvidenceBucket: "stale_queue_item" });
      this.recordDaemonEvent("daemon.agent.start.skipped", {
        ...this.agentStartDispatch.traceAttrs(item.agentId, item.config, item.wakeMessage, item.unreadSummary, item.resumePrompt, item.launchId, item.wakeMessageTransient, item.resumeMessages, item.startDispatchId),
        reason: "stale_queue_item",
      });
      this.pumpAgentStartQueue();
      return;
    }
    const { item } = dequeued;

    if (this.agents.has(item.agentId) || this.agentStarts.hasStarting(item.agentId)) {
      this.closeNoProcessResidency(item.agentId, "suppressed", { negativeEvidenceBucket: "already_running_or_starting" });
      this.recordDaemonEvent("daemon.agent.start.skipped", {
        ...this.agentStartDispatch.traceAttrs(item.agentId, item.config, item.wakeMessage, item.unreadSummary, item.resumePrompt, item.launchId, item.wakeMessageTransient, item.resumeMessages, item.startDispatchId),
        reason: "already_running_or_starting",
      });
      if (this.agents.has(item.agentId)) {
        this.rebindRunningStart(item.agentId, item, "already_running_or_starting");
      } else {
        this.deferStartRebind(item.agentId, {
          ...item,
          stopEpochAtRebind: this.lifecycleRecords.stopEpoch(item.agentId),
        });
      }
      logger.info(`[Agent ${item.agentId}] Queued start skipped (already running or starting)`);
      item.resolve();
      this.pumpAgentStartQueue();
      return;
    }

    this.agentStarts.claimStartSlot(item.agentId);
    this.enterNoProcessResidency(
      "starting_process",
      this.noProcessResidencyIdentity(item.agentId, item.config, item.launchId, this.startLaunchSource(item.config, item.wakeMessage, item.resumePrompt)),
      {
        isWaitState: true,
        fenceKind: "runtime_start_timeout",
        deadlineUnixMs: this.clockNow() + runtimeStartTimeoutMs(item.config.runtime),
      },
    );
    const startSnapshot = this.agentStarts.snapshot();
    logger.info(
      `[Agent ${item.agentId}] Dequeued start ` +
      `(launchId=${item.launchId ?? "none"}, remaining=${startSnapshot.queueDepth}, active=${startSnapshot.activeStarts})`,
    );
    this.recordDaemonEvent("daemon.agent.start.dequeued", {
      ...this.agentStartDispatch.traceAttrs(item.agentId, item.config, item.wakeMessage, item.unreadSummary, item.resumePrompt, item.launchId, item.wakeMessageTransient, item.resumeMessages, item.startDispatchId),
      queue_age_ms: Math.max(0, this.clockNow() - item.enqueuedAtMs),
    });
    this.startAgentNow(
      item.agentId,
      item.config,
      item.wakeMessage,
      item.unreadSummary,
      item.resumePrompt,
      item.launchId,
      item.wakeMessageTransient ?? false,
      item.resumeMessages,
      item.startDispatchId,
      item.traceParent ?? null,
      item.recoveryGrant ?? null,
      item.claimedConnectionEpochId ?? null,
    ).then(() => {
      this.releaseAgentStartSlot(item.agentId, "spawn attempted");
      item.resolve();
    }, (err) => {
      this.releaseAgentStartSlot(item.agentId, "start failed");
      item.reject(err);
    });
  }

  private releaseAgentStartSlot(agentId: string, reason: string): void {
    if (!this.agentStarts.releaseStartSlot()) return;
    const startSnapshot = this.agentStarts.snapshot();
    this.recordDaemonEvent("daemon.agent.start.slot_released", {
      agentId,
      reason,
      active_starts: startSnapshot.activeStarts,
      queue_depth: startSnapshot.queueDepth,
      max_concurrent_starts: startSnapshot.maxConcurrentStarts,
    });
    logger.info(
      `[Agent ${agentId}] Start slot released (${reason}) ` +
      `(active=${startSnapshot.activeStarts}, queue=${startSnapshot.queueDepth})`,
    );
    this.pumpAgentStartQueue();
  }

  private cancelQueuedAgentStart(agentId: string, reason: string): boolean {
    const item = this.agentStarts.cancelQueued(agentId);
    if (!item) return false;
    this.closeNoProcessResidency(agentId, "suppressed", { negativeEvidenceBucket: "start_cancelled" });
    this.startingInboxes.cancelStart(agentId);
    this.assertStartPendingDeliveryInvariants("cancel-queued-start");
    this.recordDaemonEvent("daemon.agent.start.cancelled", {
      ...this.agentStartDispatch.traceAttrs(agentId, item.config, item.wakeMessage, item.unreadSummary, item.resumePrompt, item.launchId, item.wakeMessageTransient, item.resumeMessages, item.startDispatchId),
      reason,
    }, "cancelled");
    logger.info(`[Agent ${agentId}] Queued start cancelled (${reason})`);
    this.settleAllAcceptedLaunches(agentId, "cancelled");
    this.releaseUnheldRunnerCredential(agentId, item.config, item.launchId || null);
    item.resolve();
    return true;
  }

  private cancelAllQueuedAgentStarts(reason: string) {
    const cancelled = this.agentStarts.cancelAllQueued((item) => {
      this.closeNoProcessResidency(item.agentId, "suppressed", { negativeEvidenceBucket: "start_cancelled" });
      this.recordDaemonEvent("daemon.agent.start.cancelled", {
        ...this.agentStartDispatch.traceAttrs(item.agentId, item.config, item.wakeMessage, item.unreadSummary, item.resumePrompt, item.launchId, item.wakeMessageTransient, item.resumeMessages, item.startDispatchId),
        reason,
      }, "cancelled");
      logger.info(`[Agent ${item.agentId}] Queued start cancelled (${reason})`);
      this.settleAllAcceptedLaunches(item.agentId, "cancelled");
      this.releaseUnheldRunnerCredential(item.agentId, item.config, item.launchId || null);
    });
    for (const item of cancelled) {
      item.resolve();
    }
    this.startingInboxes.cancelAllStarts();
    this.assertStartPendingDeliveryInvariants("cancel-all-queued-starts");
  }

  // Wraps one spawn attempt in a short span. The spawn span is passed down
  // by value and is not made active, because the new process outlives it and
  // its later events must not attach to this span.
  private async startAgentNow(agentId: string, config: AgentConfig, wakeMessage?: AgentMessage, unreadSummary?: Record<string, number>, resumePrompt?: string, launchId?: string, wakeMessageTransient = false, resumeMessages?: AgentMessage[], startDispatchId?: string, traceParent: TraceContext | null = null, recoveryGrant: RecoveryGrant | null = null, claimedConnectionEpochId: string | null = null) {
    const spawnSpan = this.tracer.startSpan("daemon.agent.spawn", {
      parent: traceParent,
      surface: "daemon",
      kind: "internal",
      attrs: {
        agentId,
        launchId,
        start_dispatch_id: startDispatchId,
        runtime: config.runtime,
      },
    });
    try {
      await runWithoutActiveSpan(() => this.spawnAgentProcess(
        formatTraceparent(spawnSpan.context),
        agentId,
        config,
        wakeMessage,
        unreadSummary,
        resumePrompt,
        launchId,
        wakeMessageTransient,
        resumeMessages,
        startDispatchId,
        recoveryGrant,
        claimedConnectionEpochId,
      ));
      spawnSpan.end("ok");
    } catch (err) {
      const unresolved = launchUnresolvedCause(err);
      if (unresolved) {
        // Path-free: how many launches the no-cmd.exe Windows resolution turns away, and why.
        this.recordDaemonEvent("daemon.agent.launch_unresolved", {
          agentId,
          launchId,
          runtime: config.runtime,
          reason: unresolved.reason,
          platform: process.platform,
        }, "error", formatTraceparent(spawnSpan.context));
      }
      spawnSpan.end("error", { attrs: { error_class: errorClassOf(err) } });
      throw err;
    }
  }

  private async spawnAgentProcess(spawnTraceparent: string, agentId: string, config: AgentConfig, wakeMessage?: AgentMessage, unreadSummary?: Record<string, number>, resumePrompt?: string, launchId?: string, wakeMessageTransient = false, resumeMessages?: AgentMessage[], startDispatchId?: string, recoveryGrant: RecoveryGrant | null = null, claimedConnectionEpochId: string | null = null) {
    if (this.agents.has(agentId)) {
      this.recordDaemonEvent("daemon.agent.spawn.skipped", {
        ...this.agentStartDispatch.traceAttrs(agentId, config, wakeMessage, unreadSummary, resumePrompt, launchId, wakeMessageTransient, resumeMessages, startDispatchId),
        reason: "already_running",
      }, "ok", spawnTraceparent);
      this.rebindRunningStart(agentId, { config, wakeMessage, unreadSummary, resumePrompt, launchId, wakeMessageTransient, resumeMessages, startDispatchId, recoveryGrant, claimedConnectionEpochId }, "already_running");
      logger.info(`[Agent ${agentId}] Start rebound (already running, launchId=${launchId ?? "none"})`);
      return;
    }
    if (this.agentStarts.hasStarting(agentId)) {
      this.recordDaemonEvent("daemon.agent.spawn.skipped", {
        ...this.agentStartDispatch.traceAttrs(agentId, config, wakeMessage, unreadSummary, resumePrompt, launchId, wakeMessageTransient, resumeMessages, startDispatchId),
        reason: "already_starting",
      }, "ok", spawnTraceparent);
      this.deferStartRebind(agentId, {
        config,
        wakeMessage,
        unreadSummary,
        resumePrompt,
        launchId,
        wakeMessageTransient,
        resumeMessages,
        startDispatchId,
        recoveryGrant,
        claimedConnectionEpochId,
        stopEpochAtRebind: this.lifecycleRecords.stopEpoch(agentId),
      });
      logger.info(`[Agent ${agentId}] Start rebind deferred (startup in progress)`);
      return;
    }
    let startStopEpoch = this.lifecycleRecords.stopEpoch(agentId);
    this.agentStarts.markStarting(agentId);
    // Reconciler step 5: what a previous daemon left running is reaped first.
    if (this.orphanSweepPending && this.orphanSweep) {
      this.recordDaemonEvent("daemon.agent.start.waiting_for_orphan_reap", { agentId, launchId }, "ok", spawnTraceparent);
      await this.orphanSweep;
    }
    // Reconciler step 5: a stopped process of this agent that has not been
    // seen to exit yet (at most the stop grace plus the confirmation window)
    // is waited for first, so two processes never run one agent. Deliveries
    // meanwhile are buffered for this start, as during any start.
    const exiting = this.exitingRuntimes.get(agentId);
    if (exiting) {
      this.recordDaemonEvent("daemon.agent.start.waiting_for_exit", {
        agentId,
        launchId,
        exiting_count: exiting.runtimes.size,
      }, "ok", spawnTraceparent);
      await this.runtimeExited(agentId);
      if (this.lifecycleRecords.stopEpochChanged(agentId, startStopEpoch)) {
        // A stop arrived meanwhile: nothing spawned, every waiting launch settled.
        this.agentStarts.clearStarting(agentId);
        this.lifecycleRecords.deletePendingStartRebind(agentId);
        this.closeNoProcessResidency(agentId, "suppressed", { negativeEvidenceBucket: "explicit_stop" });
        this.settleAllAcceptedLaunches(agentId, "cancelled");
        this.recordDaemonEvent("daemon.agent.start.held_cancelled", { agentId, launchId, reason: "stopped_while_previous_exited" });
        return;
      }
    }
    let agentProcess: AgentProcess | null = null;
    // The config the launch was built with (its runner credential may be minted at spawn).
    let spawnConfig: AgentConfig | null = null;
    let pendingStartRebind: PendingStartRebind | undefined;
    const originalLaunchId = launchId || null;
    let carriedAppNotice: { items: readonly AgentInboxAppItem[]; wakeItemIds: ReadonlySet<string> } | null = null;
    // task #925: a notice this start carried that never reached a process
    // stays owed to the next start (a waking one may start the agent again).
    const keepCarriedAppNoticeOwed = () => {
      if (carriedAppNotice && !this.appInboxNoticesAfterTurn.has(agentId)) {
        this.appInboxNoticesAfterTurn.set(agentId, { wakeItemIds: carriedAppNotice.wakeItemIds });
      }
      carriedAppNotice = null;
    };
    // #wg-rbac:#27: until this attempt ends, the runner credentials it carries
    // (its start's, one minted at spawn) count as held (`getHeldRunnerCredentialIds`).
    const heldBySpawn = (): Array<AgentConfig | null> => [config, spawnConfig];
    this.spawningRunnerConfigs.add(heldBySpawn);
    try {

    const agentDataDir = path.join(this.dataDir, agentId);
    await initializeLaunchWorkspace(agentDataDir, agentId, config);
    // Reconciler step 8a: the session rules whose facts are known here (step
    // 7's spec drop, then task #10's refusal), before the start waits.
    config = this.withStartSessionChoice(agentId, config, launchId, { stuck: true });

    // RFC 071 outbox: the one spawn entry every start goes through (server
    // starts, crash respawn, wake / message cold start, restart on message,
    // deferred spawn, cooldown restart), decided by the automatic-start rule.
    // Only an admitted human start passes on its own grant: this start's, or
    // that of a server start deferred onto it (it takes this spawn over, below);
    // the grant counts only for the launch this spawn will carry. Nothing
    // below has consumed a message yet, and messages the caller hands over
    // while the start is pending are already buffered by now.
    if (this.runtimeProcessGate && this.daemonInstanceId) {
      // Held until this connection's capability is confirmed: the process's
      // mode (reliable / compat) is fixed at launch from it.
      // Cancellable: a stop of this agent (stopAgent) or the daemon stopping
      // ends the wait with `false`; it is never ended by pretending.
      const wait = this.runtimeProcessGate.waitForCapability();
      this.capabilityHolds.set(agentId, wait);
      const confirmed = await wait.confirmed;
      if (this.capabilityHolds.get(agentId) === wait) this.capabilityHolds.delete(agentId);
      if (!confirmed || this.lifecycleRecords.stopEpochChanged(agentId, startStopEpoch)) {
        // Nothing spawned: the starting state ends here (the caller releases
        // the start slot on return), and every launch still waiting is settled.
        this.agentStarts.clearStarting(agentId);
        this.lifecycleRecords.deletePendingStartRebind(agentId);
        this.closeNoProcessResidency(agentId, "suppressed", { negativeEvidenceBucket: "explicit_stop" });
        this.settleAllAcceptedLaunches(agentId, "cancelled");
        this.recordDaemonEvent("daemon.agent.start.held_cancelled", { agentId, launchId, reason: confirmed ? "stopped_after_confirmation" : "wait_cancelled" });
        return;
      }
    }
    const deferredStart = this.lifecycleRecords.getPendingStartRebind(agentId);
    const spawnRefusal = this.runtimeProcessGate && this.daemonInstanceId
      ? this.runtimeProcessGate.startRefusal(
        agentId,
        deferredStart?.launchId || launchId || null,
        deferredStart?.recoveryGrant ?? recoveryGrant,
      )
      : null;
    if (spawnRefusal !== null) {
      this.agentStarts.clearStarting(agentId);
      if (this.lifecycleRecords.stopEpochChanged(agentId, startStopEpoch)) {
        // A stop arrived meanwhile: it wins; no refusal state is left behind.
        this.closeNoProcessResidency(agentId, "suppressed", { negativeEvidenceBucket: "explicit_stop" });
        this.settleAllAcceptedLaunches(agentId, "cancelled");
        return;
      }
      this.refuseUnreliableSpawn(agentId, { config, wakeMessage, wakeMessageTransient, launchId, startDispatchId }, spawnRefusal.detail, spawnTraceparent, spawnRefusal.reason);
      return;
    }

    pendingStartRebind = this.lifecycleRecords.getPendingStartRebind(agentId);
    if (pendingStartRebind) {
      this.lifecycleRecords.deletePendingStartRebind(agentId);
      const previousWakeMessage = wakeMessage;
      this.startingInboxes.rebindWake(
        agentId,
        previousWakeMessage,
        pendingStartRebind.wakeMessage,
        (left, right) => this.sameWakeMessage(left, right),
      );
      this.assertStartPendingDeliveryInvariants("rebind-starting-start");

      // A deferred rebind carries no runner credential (`deferStartRebind`):
      // this start's own credential, if it has one, is the one it runs with.
      config = this.carryRunnerCredential(agentId, config, pendingStartRebind);
      unreadSummary = pendingStartRebind.unreadSummary;
      resumePrompt = pendingStartRebind.resumePrompt;
      if (pendingStartRebind.launchId) claimedConnectionEpochId = pendingStartRebind.claimedConnectionEpochId ?? null;
      launchId = pendingStartRebind.launchId || launchId;
      resumeMessages = pendingStartRebind.resumeMessages;
      startStopEpoch = pendingStartRebind.stopEpochAtRebind ?? startStopEpoch;
      if (pendingStartRebind.wakeMessage) {
        wakeMessage = pendingStartRebind.wakeMessage;
        wakeMessageTransient = pendingStartRebind.wakeMessageTransient === true;
      }
    }

    // A deferred rebind's config may name the session again.
    if (pendingStartRebind) config = this.withStartSessionChoice(agentId, config, launchId, { stuck: false });

    // Server features: an answer applied after this start's config was taken
    // (while it was queued or waiting for a rebind) wins over it, and the
    // notice tells the session what changed.
    const newerServerFeatures = this.serverFeaturesNewerThanStart(agentId);
    if (newerServerFeatures && !agentServerFeaturesEqual(pickAgentServerFeatures(config), newerServerFeatures)) {
      if (!this.serverFeaturesNoticeBase.has(agentId)) this.serverFeaturesNoticeBase.set(agentId, pickAgentServerFeatures(config));
      config = withAgentServerFeatures(config, newerServerFeatures);
    }
    this.startConfigFeaturesGeneration.set(agentId, this.serverFeaturesGeneration);
    const serverFeaturesGenerationAtSpawn = this.serverFeaturesGeneration;
    this.contextView.observeFlag(agentId, config.agentContextView === true, "start");

    this.enterNoProcessResidency(
      "starting_process",
      this.noProcessResidencyIdentity(agentId, config, launchId, this.startLaunchSource(config, wakeMessage, resumePrompt)),
      {
        isWaitState: true,
        fenceKind: "runtime_start_timeout",
        deadlineUnixMs: this.clockNow() + runtimeStartTimeoutMs(config.runtime),
      },
    );
    this.recordDaemonEvent("daemon.agent.spawn.started", this.agentStartDispatch.traceAttrs(agentId, config, wakeMessage, unreadSummary, resumePrompt, launchId, wakeMessageTransient, resumeMessages, startDispatchId), "ok", spawnTraceparent);

    const driver = this.driverResolver(config.runtime || "claude");
    const legacyWakeRuntimeProfile = wakeMessage ? runtimeProfileNotificationFromMessage(wakeMessage) : null;
    if (legacyWakeRuntimeProfile?.kind === "migration") {
      this.completeDeprecatedRuntimeProfileMigration(
        agentId,
        legacyWakeRuntimeProfile.key,
        launchId || null,
        wakeMessage?.traceparent,
        "wake_message",
      );
      wakeMessage = undefined;
    }

    let runtimeConfig = withLocalRuntimeContext(config, agentId, agentDataDir);
    const legacyRuntimeProfileControl = runtimeConfig.runtimeProfileControl?.kind === "migration"
      ? runtimeConfig.runtimeProfileControl
      : null;
    if (legacyRuntimeProfileControl) {
      this.completeDeprecatedRuntimeProfileMigration(
        agentId,
        legacyRuntimeProfileControl.key,
        launchId || null,
        undefined,
        "agent_config",
      );
      runtimeConfig = { ...runtimeConfig, runtimeProfileControl: null };
    }

    enforceRuntimeLaunchVersion(driver, runtimeConfig, { workingDirectory: agentDataDir }, (warning) => {
      logger.warn(`[Agent ${agentId}] ${warning}`);
      this.broadcastActivity(
        agentId,
        "working",
        warning,
        [{ kind: "system", title: "Runtime update recommended", text: warning }],
        launchId || null,
        "runtime_starting",
      );
    });
    // RFC 070 phase 1: at a cold wake with a large prior context, retire the
    // session (drop driver `--resume`) but keep the ladder's resume semantics.
    // §6.5: a warm-recycle stop remembered for this agent is taken by this
    // start, whatever it decides (a resume for any other reason forgets it).
    const warmStop = this.warmRecycle.takeStopped(agentId);
    const wakeRecycle = await planWakeSessionRecycle({ config: runtimeConfig, hasResumePrompt: Boolean(resumePrompt), homeDir: this.runtimeSessionHomeDir, warmStop });
    // A warm stop this start resumed anyway (a resume prompt, a runtime-profile
    // control, unknown facts): marking that session again would stop it after
    // every turn end only for the next start to resume it again.
    if (warmStop && wakeRecycle.action === "resume") this.warmRecycle.decline(agentId, warmStop.sessionId);
    if (wakeRecycle.action === "resume") {
      // RFC 070 observability: the recycle's resume reason (env off switch, warm
      // cache, small context, unreadable transcript, ...) was a local log line
      // only; trace it so a fleet that never recycles shows why.
      this.recordDaemonEvent("daemon.agent.wake_recycle_skipped", {
        agentId,
        runtime: runtimeConfig.runtime ?? "claude",
        reason: wakeRecycle.reason,
        has_session: Boolean(runtimeConfig.sessionId),
        ...(wakeRecycle.thresholds ? recycleThresholdTraceAttrs(wakeRecycle.thresholds) : {}),
        ...(warmStop ? { warm_stop_dropped: true, band: warmStop.band } : {}),
      });
    }
    // Reconciler step 8a: the last session rule, from the plan's facts.
    const wakeChoice = chooseSession({ sessionId: runtimeConfig.sessionId, wakeRecycle });
    if (wakeChoice.kind === "new" && wakeChoice.reason === "wake_recycle") {
      if (runtimeConfig.sessionId) {
        rememberSessionContext(buildCliTransportDir(this.slockHome, agentId, launchId), runtimeConfig.sessionId, null);
      }
      runtimeConfig = { ...runtimeConfig, sessionId: null };
      const applied = describeAppliedWakeRecycle(agentId, wakeChoice.recycle);
      const startTriggerKind = messageTurnTriggerAttrs(wakeMessage ? [wakeMessage] : undefined, this.clockNow(), () => undefined).trigger_kind;
      this.recordDaemonEvent("daemon.agent.wake_recycle", { ...applied.traceAttrs, ...wakeRecycleKindTraceAttrs(wakeChoice.recycle, typeof startTriggerKind === "string" ? startTriggerKind : undefined) });
      logger.info(`[Agent ${agentId}] ${applied.logLine}`);
      logger.info(describeRecycledWakeLogLine(agentId, wakeChoice.recycle, "legacy"));
    }
    const isResume = !!runtimeConfig.sessionId || wakeRecycle.action === "recycle";
    const standingPrompt = driver.buildSystemPrompt(runtimeConfig, agentId);
    // task #13: a resumed session may still run on the standing prompt it
    // started with; plan re-delivering the current one (standingPromptRefresh.ts).
    const stableStandingPrompt = String(driver.buildSystemPrompt(stableStandingPromptConfig(runtimeConfig), agentId));
    const stableStandingPromptHash = standingPromptHash(stableStandingPrompt, { nativeStandingPrompt: Boolean(driver.supportsNativeStandingPrompt) });
    const standingPromptRefresh = {
      hash: stableStandingPromptHash,
      plan: planStandingPromptRefresh({
        ledger: this.standingPromptLedger,
        agentId,
        resumeSessionId: runtimeConfig.sessionId ?? null,
        refreshesOnResume: driver.standingPromptRefreshesOnResume === true,
        promptHash: stableStandingPromptHash,
        nowMs: this.clockNow(),
      }),
    };
    // A resumed session that keeps its original standing prompt never sees a
    // release notice placed there, so it gets the notice in its first input.
    const standingPromptReachesSession = !runtimeConfig.sessionId || driver.standingPromptRefreshesOnResume === true;
    // A runtime without a native standing prompt gets it at the front of a
    // fresh session's first input, whatever starts the session (applied once,
    // after the input below is chosen).
    const standingPromptInFirstInput = standingPromptGoesInFirstInput({
      nativeStandingPrompt: Boolean(driver.supportsNativeStandingPrompt),
      resumeSessionId: runtimeConfig.sessionId ?? null,
    });
    const startupInput = planStartupInput({
      driver,
      runtimeConfig,
      isResume,
      standingPromptReachesSession,
      standingPromptInFirstInput,
      wakeMessage,
      wakeMessageTransient,
      resumePrompt,
      resumeMessages,
      unreadSummary,
      startingInboxMessages: this.startingInboxes.values(agentId),
      projectThreadJoinContexts: (messages, renderContext) => this.projectThreadJoinContextsForRuntimeInput(agentId, messages, renderContext),
    });
    let { prompt, promptSource } = startupInput;
    const {
      wakeMessageDeliveredAsInboxUpdate,
      spawnAnnouncedMessages,
      inboxNoticeMessages,
      wakeMessageDeliveredWithThreadContext,
      startingInboxDeliveredAsInput,
      resumeCatchupDeliveredAsInput,
      wakeMessageWithheldByResumePrompt,
      unreadSummaryShown,
      renderedStartupThreadContextMessages,
      startingInboxMessages,
      resumeCatchupMessages,
      resumeCatchupInputMessages,
      wakeMessageProjection,
      resumeCatchupProjection,
      startingInboxProjection,
      startupBodyMessages,
      firstInputMessages,
      startOrigin,
    } = startupInput;
    // Server features changed since this agent's session last ran
    // (applyServerFeatures): say what changed, once, right ahead of this
    // input's wake or catch-up content, so it follows the standing
    // instructions it refers to (a re-delivered or inlined standing prompt,
    // and any briefing, go in front below). The base is dropped only once the
    // start has committed.
    const serverFeaturesNoticeBase = this.serverFeaturesNoticeBase.get(agentId);
    const serverFeaturesNotice = serverFeaturesNoticeBase
      ? formatServerFeaturesNotice(serverFeaturesNoticeBase, pickAgentServerFeatures(runtimeConfig), { supportsSubagents: driver.supportsSubagents === true })
      : null;
    if (serverFeaturesNotice) prompt = composeAxSurfaces(serverFeaturesNotice, prompt);
    ({ prompt, promptSource } = applyWakeRecycleBriefing(wakeRecycle, prompt, promptSource));
    // Startup memory block (RFC 070 §6 follow-up): every fresh session gets
    // the MEMORY.md head pushed instead of relying on the standing-prompt
    // read. The recycle path injects its own copy inside the briefing (so the
    // block lands between briefing chrome and the constructed panel); this
    // covers the remaining fresh starts — creation, session/full reset, and
    // runtime switches that cleared the session.
    if (!runtimeConfig.sessionId && wakeRecycle.action !== "recycle") {
      const memoryBlockConfig = resolveStartupMemoryBlockConfig(runtimeConfig.envVars);
      if (memoryBlockConfig.enabled) {
        const memoryBlock = await buildStartupMemoryBlock({ workspacePath: agentDataDir, budgetTokens: memoryBlockConfig.budgetTokens });
        if (memoryBlock) {
          ({ prompt, promptSource } = applyStartupMemoryBlock(memoryBlock, prompt, promptSource));
          logger.info(`[Agent ${agentId}] Startup memory block injected for fresh session (source ${promptSource})`);
        }
      }
    }
    prompt = applyFreshSessionStandingPrompt(standingPromptInFirstInput, standingPrompt, prompt);
    ({ prompt, promptSource } = applyStandingPromptUpdate(standingPromptRefresh.plan, stableStandingPrompt, prompt, promptSource));
    if (standingPromptRefresh.plan.action === "inject" || standingPromptRefresh.plan.action === "baseline_unknown") {
      this.recordDaemonEvent("daemon.agent.standing_prompt_stale", {
        agentId,
        launchId: launchId || undefined,
        runtime: runtimeConfig.runtime ?? "claude",
        action: standingPromptRefresh.plan.action === "inject" ? "injected" : "baseline_unknown",
        ...(standingPromptRefresh.plan.action === "inject" ? { stale_for_ms: standingPromptRefresh.plan.staleForMs } : {}),
      });
    }
    const runtimeInputTraceAttrs = buildRuntimeInputTraceAttrs({
      source: promptSource,
      prompt,
      standingPrompt,
      resumePrompt,
      messages: wakeMessage
        ? wakeMessageProjection.messages
        : resumeCatchupInputMessages.length > 0
          ? resumeCatchupProjection.messages
          : startingInboxMessages.length > 0
            ? startingInboxProjection.messages
            : undefined,
      unreadSummary,
      sessionIdPresent: isResume,
      nativeStandingPrompt: Boolean(driver.supportsNativeStandingPrompt),
      standingPromptInInput: standingPromptInFirstInput || standingPromptRefresh.plan.action === "inject",
      serverFeaturesNoticeInInput: serverFeaturesNotice !== null,
    });

    const effectiveLaunchId = launchId || null;

    // task #925: a start that carries a waking app notice is not empty. The
    // notice is either this start's resume prompt (the idle restart for it) or
    // a due item the Server woke the agent for.
    const serverWakeItemId = this.serverWakeStartsOwed.get(agentId);
    this.serverWakeStartsOwed.delete(agentId);
    const appNoticeOwed = driver.deferSpawnUntilMessage === true && !wakeMessage && !resumePrompt
      ? this.owesWakingAppInboxNotice(agentId, serverWakeItemId)
      : "none";
    // The App Inbox could not be read: the server wake's identity is kept for
    // the next start to check again (task #925), never widened or dropped.
    if (appNoticeOwed === "unknown" && serverWakeItemId !== undefined) {
      this.serverWakeStartsOwed.set(agentId, serverWakeItemId);
    }
    const owesAppNotice = appNoticeOwed === "owed";
    // Task #50: an agent held for its invalid credential (billing, sign-in)
    // waits out the hold whoever starts it. A server wake used to spawn it
    // anyway, spend one more provider request on the same refusal and re-arm
    // the hold. Its messages join the held ones; the launch settles
    // `deferred`, as an empty deferred start does. A start that switches
    // models has already released the hold (startAgent), and a person's
    // stop then start releases it at the stop.
    const credentialHold = this.lifecycleRecords.getSpawnFailBackoff(agentId);
    if (credentialHold?.reason === CREDENTIAL_INVALID_COOLDOWN_REASON
      && credentialHold.untilMs > this.clockNow()
      && this.credentialInvalidHold(agentId, runtimeConfig)) {
      if (effectiveLaunchId && this.isStaleClaim(claimedConnectionEpochId)) {
        throw new StaleDispatchError(agentId, effectiveLaunchId);
      }
      const pendingMessages = this.startingInboxes.drainOnSpawn(agentId);
      this.agentStarts.clearStarting(agentId);
      this.closeNoProcessResidency(agentId, "suppressed", { negativeEvidenceBucket: "credential_invalid_hold" });
      this.assertStartPendingDeliveryInvariants("credential-hold-start-drain");
      if (this.lifecycleRecords.stopEpochChanged(agentId, startStopEpoch)) {
        this.closeNoProcessResidency(agentId, "suppressed", { negativeEvidenceBucket: "explicit_stop" });
        this.settleAllAcceptedLaunches(agentId, "cancelled");
        return;
      }
      this.settleAllAcceptedLaunches(agentId, "deferred");
      this.lifecycleRecords.setRestartSnapshot(agentId, {
        config: this.buildRestartSafeConfig(runtimeConfig, runtimeConfig.sessionId || null),
        sessionId: runtimeConfig.sessionId || null,
        launchId: effectiveLaunchId,
      });
      this.sendAgentStatus(agentId, "active", effectiveLaunchId);
      const heldMessages = [
        ...(wakeMessage && !wakeMessageTransient ? [wakeMessage] : []),
        ...(resumeMessages ?? []),
        ...pendingMessages,
      ];
      this.recordDaemonEvent("daemon.agent.start.held_credential_invalid", {
        ...this.agentStartDispatch.traceAttrs(agentId, config, wakeMessage, unreadSummary, resumePrompt, effectiveLaunchId || undefined, wakeMessageTransient, resumeMessages, startDispatchId),
        invalid_reason: this.credentialInvalidHold(agentId, runtimeConfig)?.invalidReason,
        hold_remaining_ms: Math.max(0, credentialHold.untilMs - this.clockNow()),
        held_messages_count: heldMessages.length,
      }, "ok", spawnTraceparent);
      logger.info(`[Agent ${agentId}] Start held: its credential is invalid until a sign-in or the hold ends`);
      for (const message of heldMessages) {
        this.deliverMessage(agentId, message);
      }
      return;
    }
    const canDeferEmptyStart =
      driver.deferSpawnUntilMessage === true &&
      !wakeMessage &&
      !resumePrompt &&
      !owesAppNotice &&
      !runtimeConfig.runtimeProfileControl &&
      resumeCatchupInputMessages.length === 0 &&
      (!unreadSummary || Object.keys(unreadSummary).length === 0);
    if (canDeferEmptyStart) {
      // task #365: a stale launch is refused, not settled `deferred` (which
      // would also report the agent active for a start that never counted).
      if (effectiveLaunchId && this.isStaleClaim(claimedConnectionEpochId)) {
        throw new StaleDispatchError(agentId, effectiveLaunchId);
      }
      const pendingMessages = this.startingInboxes.drainOnSpawn(agentId);
      this.agentStarts.clearStarting(agentId);
      this.closeNoProcessResidency(agentId, "suppressed", { negativeEvidenceBucket: "defer_until_concrete_message" });
      this.assertStartPendingDeliveryInvariants("defer-empty-start-drain");
      if (this.lifecycleRecords.stopEpochChanged(agentId, startStopEpoch)) {
        this.closeNoProcessResidency(agentId, "suppressed", { negativeEvidenceBucket: "explicit_stop" });
        logger.info(`[Agent ${agentId}] Deferred ${driver.id} spawn suppressed by stop request`);
        this.settleAllAcceptedLaunches(agentId, "cancelled");
        return;
      }
      // RFC 071: no process exists for these launches; a later message-driven
      // spawn reports itself as a respawn.
      this.settleAllAcceptedLaunches(agentId, "deferred");
      this.lifecycleRecords.setRestartSnapshot(agentId, {
        config: this.buildRestartSafeConfig(runtimeConfig, runtimeConfig.sessionId || null),
        sessionId: runtimeConfig.sessionId || null,
        launchId: effectiveLaunchId,
        // No live AgentProcess in this adoption branch — omit rather than
        // fabricate; the marker's processInstanceId is nullable by contract.
      });
      this.sendAgentStatus(agentId, "active", effectiveLaunchId);
      this.broadcastActivity(agentId, "online", "Process idle", [], undefined, "idle");
      this.recordDaemonEvent("daemon.agent.spawn.deferred", {
        ...this.agentStartDispatch.traceAttrs(agentId, config, wakeMessage, unreadSummary, resumePrompt, effectiveLaunchId || undefined, wakeMessageTransient, resumeMessages, startDispatchId),
        pending_messages_count: pendingMessages.length,
        reason: "defer_until_concrete_message",
      }, "ok", spawnTraceparent);
      logger.info(`[Agent ${agentId}] Deferred ${driver.id} spawn until first concrete message`);
      for (const message of pendingMessages) {
        this.deliverMessage(agentId, message);
      }
      return;
    }

    // A per_turn runtime's deferred app notice rides in this start's first
    // input (a restart for the notice itself already carries it as the prompt).
    if (!resumePrompt) {
      if (owesAppNotice && serverWakeItemId !== undefined) {
        const wakeItemIds = new Set(this.appInboxNoticesAfterTurn.get(agentId)?.wakeItemIds ?? []);
        wakeItemIds.add(serverWakeItemId);
        this.appInboxNoticesAfterTurn.set(agentId, { wakeItemIds });
      }
      const appNotice = this.takeAppInboxNoticeForStartInput(agentId, runtimeConfig, driver);
      if (appNotice) {
        prompt = composeAxSurfaces(prompt, appNotice.text);
        carriedAppNotice = { items: appNotice.items, wakeItemIds: appNotice.wakeItemIds };
      }
    }
    const effectiveConfig = await this.buildSpawnConfig(agentId, runtimeConfig);
    spawnConfig = effectiveConfig;
    const processInstanceId = randomUUID();
    // task #1277: one cancel per start attempt, carried to the driver as
    // `launchSignal` and aborted by a stop that lands while the driver is
    // still resolving or spawning.
    const launchAbort = new AbortController();
    const catchupBatchEcho = this.takeStartCatchupBatch(
      agentId,
      effectiveLaunchId,
      resumeCatchupDeliveredAsInput ? resumeCatchupMessages.length : 0,
    );
    // glimpse G0: the context id this spawn publishes, decided now so the start
    // input booked below is stamped with the id the CLI will read.
    const contextGeneration = planSpawnContextGeneration(
      buildCliTransportDir(this.slockHome, agentId, effectiveLaunchId),
      { compaction: driver.session.compaction, resumeSessionId: effectiveConfig.sessionId },
    );
    const runtimeContext = {
      agentId,
      config: effectiveConfig,
      standingPrompt,
      prompt,
      contextViewRequestLogDir: () => this.contextView.requestLogDir(agentId),
      workingDirectory: agentDataDir,
      slockCliPath: this.slockCliPath,
      daemonVersion: this.daemonVersion,
      computerVersion: this.computerVersion,
      daemonApiKey: this.daemonApiKey,
      slockHome: this.slockHome,
      launchId: effectiveLaunchId,
      processInstanceId,
      agentCredentialProxyInboxCoordinator: this.createAgentProxyInboxCoordinator(agentId),
      // The live config, as the wake-up notice reads it (server:features updates it).
      agentCredentialProxyInboxItems: () => inboxUpdateRenderOptions(this.agents.get(agentId)?.config ?? effectiveConfig).inboxItems === true,
      contextGeneration,
      agentAppInbox: this.#appInboxForAgent?.(agentId),
      cliTransportTraceDir: this.cliTransportTraceDir,
      tracer: this.tracer,
      launchSignal: launchAbort.signal,
      assertLaunchCurrent: () => {
        if (effectiveLaunchId && this.isStaleClaim(claimedConnectionEpochId)) {
          throw new StaleDispatchError(agentId, effectiveLaunchId);
        }
      },
    };
    const runtime = driver.createSession?.(runtimeContext) ?? createChildProcessRuntimeSession(driver, runtimeContext);
    const liveProcessConfig: AgentConfig = {
      ...runtimeConfig,
      serverUrl: effectiveConfig.serverUrl,
      agentCredentialKey: effectiveConfig.agentCredentialKey,
      agentCredentialId: effectiveConfig.agentCredentialId,
    };
    const initialSessionId = this.initialAgentProcessSessionId(driver, liveProcessConfig);
    const restartSessionId = initialSessionId || (driver.requiresSessionInitForDelivery ? liveProcessConfig.sessionId || null : null);
    this.runtimeProcessBindingFence.bind(runtime, {
      agentId,
      serverId: runtimeConfig.runtimeContext?.serverId ?? null,
      machineId: runtimeConfig.runtimeContext?.machineId ?? null,
      configuredRuntimeId: runtimeConfig.runtime,
      driverId: driver.id,
      initialLaunchId: effectiveLaunchId,
      activeLaunchId: effectiveLaunchId,
      startSessionId: effectiveConfig.sessionId || null,
      activeSessionId: initialSessionId,
      processInstanceId,
    });

    const startupInputMessages = (wakeMessageDeliveredAsInboxUpdate || wakeMessageWithheldByResumePrompt) && wakeMessage
      ? [wakeMessage, ...startingInboxMessages]
      : resumeCatchupDeliveredAsInput
        ? resumeCatchupInputMessages
        : startingInboxMessages;
    agentProcess = {
      ...(driver.standingPromptRefreshesOnResume ? {} : {
        standingPrompt: {
          hash: standingPromptRefresh.hash,
          binding: standingPromptSessionBinding({
            nativeStandingPrompt: Boolean(driver.supportsNativeStandingPrompt),
            resumeSessionId: runtimeConfig.sessionId ?? null,
            promptInFirstInput: standingPromptInFirstInput || standingPromptRefresh.plan.action === "inject",
          }),
        },
      }),
      launchAbort,
      resumeSessionId: effectiveConfig.sessionId || null,
      runtime,
      driver,
      runtimeCliVersion: null,
      inbox: startupInputMessages,
      config: liveProcessConfig,
      sessionId: initialSessionId,
      sessionReadyForDelivery: this.initialSessionReadyForDelivery(driver, liveProcessConfig, initialSessionId),
      launchId: effectiveLaunchId,
      startDispatchId: startDispatchId || null,
      startup: createAgentProcessStartupState({
        wakeMessage,
        unreadSummary,
        resumePrompt,
      }),
      notifications: new RuntimeNotificationState(),
      activityHeartbeat: { kind: "inactive" },
      readinessTransition: null,
      activation: { kind: "idle" },
      compaction: { kind: "none" },
      cliTransportDir: buildCliTransportDir(this.slockHome, agentId, effectiveLaunchId),
      passiveAx: configPassiveAx(effectiveConfig),
      agentLedgerPath: senderLedgerPath(this.slockHome, agentId),
      contextId: contextGeneration.contextId,
      review: { kind: "none" },
      runtimeProgress: new RuntimeProgressState(Date.now()),
      deliveryConsumption: new DeliveryConsumptionWatch(),
      runtimeTraceSpan: null,
      runtimeTraceCounters: createRuntimeTraceCounters(),
      backgroundTasks: new Map(),
      sessionServerFeatures: pickAgentServerFeatures(runtimeConfig),
      startedSpec: runtimeSpecOf(runtimeConfig),
      credentialAccount: this.credentialAccountAtStart(runtimeConfig),
      turnOutcome: createTurnOutcomeCounters(),
      catchupBatchEcho,
      startupUnreadShown: unreadSummaryShown ? renderedUnreadSummaryTargets(unreadSummary) : [],
      turnEndedReported: false,
      spawnReported: false,
      runtimeTelemetryResultSeq: 0,
      lastActivityKind: "offline",
      lastActivity: "",
      lastActivityDetail: "",
      lastActivityDetailKind: "runtime_unavailable",
      recentStdout: [],
      recentStderr: [],
      lastRuntimeError: null,
      decisionErrorWindow: new DecisionErrorWindow(),
      runtimeErrorDeliveryBackoff: this.restoreProviderLimitBackoff(agentId, runtimeConfig, effectiveLaunchId),
      sessionReadyDeliveryRetry: createSessionReadyDeliveryRetryState(),
      spawnError: null,
      spawnErrorSyscall: null,
      spawnNoProcess: false,
      processInstanceId,
      spawnedAtMs: Date.now(),
      exit: { kind: "live" },
      runtimeProfileTurnControl: liveProcessConfig.runtimeProfileControl
        ? runtimeProfileTurnControl(liveProcessConfig.runtimeProfileControl.kind, liveProcessConfig.runtimeProfileControl.key, "agent_config")
        : null,
      pendingTrajectory: null,
      gatedSteering: createGatedSteeringState(),
    };
    this.startingInboxes.drainOnSpawn(agentId);
    this.agents.set(agentId, agentProcess);
    // View Context: a (re)started agent's availability, now that its process is known.
    this.contextView.onAgentStart(agentId, agentProcess.config.agentContextView === true);
    this.markTrackedMentionsToldAtStart(agentId, processInstanceId, firstInputMessages);
    if (this.lifecycleRecords.stopEpochChanged(agentId, startStopEpoch)) {
      // RFC 071: the runtime has not been started, so no child exists.
      this.settleAllAcceptedLaunches(agentId, "cancelled");
      keepCarriedAppNoticeOwed();
      await this.cleanupStoppedRuntimeStart(agentId, agentProcess);
      return;
    }
    this.lifecycleRecords.setRestartSnapshot(agentId, {
      config: this.buildRestartSafeConfig(runtimeConfig, restartSessionId),
      sessionId: restartSessionId,
      launchId: effectiveLaunchId,
      processInstanceId: agentProcess.processInstanceId,
    });
    if (pendingStartRebind) {
      this.recordStartRebind(agentId, pendingStartRebind, "startup_registered", originalLaunchId, effectiveLaunchId, agentProcess.sessionId);
    }
    this.startRuntimeTrace(
      agentId,
      agentProcess,
      "spawn",
      wakeMessage ? [wakeMessage] : resumeCatchupInputMessages.length > 0 ? resumeCatchupInputMessages : undefined,
      // Catch-up messages ride along with a restart; they did not trigger it.
      wakeMessage ? runtimeInputTraceAttrs : { ...runtimeInputTraceAttrs, trigger_kind: "other" },
    );
    this.agentStarts.clearStarting(agentId);
    if (runtimeConfig.runtimeProfileControl) {
      this.ackInjectedRuntimeProfileControl(agentId, runtimeConfig.runtimeProfileControl, agentProcess.launchId);
    }
    if (wakeMessageDeliveredAsInboxUpdate) {
      this.recordInboxUpdateProjection(agentId, agentProcess, agentProcess.inbox, "spawn_wake_inbox_update", "wake", prompt);
    } else if (wakeMessageDeliveredWithThreadContext && wakeMessage) {
      this.notePushedModelBodies(agentProcess, startupBodyMessages);
      this.recordRenderedThreadJoinContextReceipts(agentId, renderedStartupThreadContextMessages);
      this.consumeVisibleMessages(agentId, { messages: [wakeMessage], source: "spawn_wake_message" });
      this.ackInjectedRuntimeProfileMessages(agentId, [wakeMessage], agentProcess.launchId);
    } else if (resumeCatchupDeliveredAsInput) {
      this.notePushedModelBodies(agentProcess, startupBodyMessages);
      this.recordInboxUpdateProjection(agentId, agentProcess, resumeCatchupInputMessages, "spawn_resume_catchup_inbox", "wake", prompt);
      this.recordRenderedThreadJoinContextReceipts(agentId, renderedStartupThreadContextMessages);
      this.consumeVisibleMessages(agentId, { messages: resumeCatchupInputMessages, source: "spawn_resume_catchup_inbox" });
      this.ackInjectedRuntimeProfileMessages(agentId, resumeCatchupInputMessages, agentProcess.launchId);
    } else if (startingInboxDeliveredAsInput) {
      // Only the rendered thread context carries bodies; the rest is a notice.
      // A message the notice only names stays pending and unseen, exactly as
      // in a wake_inbox_update start: the next `raft message check` serves its
      // body (and, for a third-party event, reports it delivered). It is told
      // (spawnAnnouncedMessages), so it is not announced again. Runtime-profile
      // controls are consumed and acked here as before.
      const shownBodies = new Set(startupBodyMessages);
      const consumedStartingInboxMessages = startingInboxMessages.filter((message) =>
        shownBodies.has(message) || runtimeProfileNotificationFromMessage(message));
      this.notePushedModelBodies(agentProcess, startupBodyMessages);
      this.recordInboxUpdateProjection(agentId, agentProcess, startingInboxMessages, "spawn_starting_inbox_update", "wake", prompt);
      this.recordRenderedThreadJoinContextReceipts(agentId, renderedStartupThreadContextMessages);
      if (consumedStartingInboxMessages.length > 0) {
        this.consumeVisibleMessages(agentId, { messages: consumedStartingInboxMessages, source: "spawn_starting_inbox_update" });
      }
      this.ackInjectedRuntimeProfileMessages(agentId, startingInboxMessages, agentProcess.launchId);
    } else if (wakeMessage && !wakeMessageTransient && !wakeMessageWithheldByResumePrompt) {
      this.consumeVisibleMessages(agentId, { messages: [wakeMessage], source: "spawn_wake_message" });
      this.ackInjectedRuntimeProfileMessages(agentId, [wakeMessage], agentProcess.launchId);
    }
    this.recordWholeNoticePreviewsSeen(agentId, inboxNoticeMessages);

    const boundAgentProcess = agentProcess;
    runtime.on("stdout", (chunkText) => {
      if (!this.runtimeProcessBindingFence.acceptOutput(agentId, boundAgentProcess, runtime, "stdout")) return;
      if (runtime.descriptor.stdout.channel === "structured_protocol") return;
      boundAgentProcess.recentStdout = pushRecentStdout(boundAgentProcess.recentStdout, chunkText);
    });

    runtime.on("runtime_event", (event) => {
      if (!this.runtimeProcessBindingFence.acceptOutput(agentId, boundAgentProcess, runtime, `runtime_event:${event.kind}`)) {
        this.runtimeProcessBindingFence.recordMissingProcessEvent(agentId, event, driver.id);
        return;
      }
      boundAgentProcess.runtimeEventObserved = true;
      const wasIdle = this.isApmIdle(boundAgentProcess);
      this.handleParsedEvent(agentId, event, driver);
      if (wasIdle) this.revertBusyWithoutLiveTurn(agentId, boundAgentProcess, `event:${event.kind}`);
    });

    runtime.on("stderr", (text) => {
      if (!text) return;
      if (!this.runtimeProcessBindingFence.acceptOutput(agentId, boundAgentProcess, runtime, "stderr")) return;
      const current = boundAgentProcess;
      if (driver.id === "codex" && isCodexProviderReconnectLog(text)) {
        current.recentStderr = pushRecentStderr(current.recentStderr, text);
        current.decisionErrorWindow.recordStderr(text);
        this.recordDaemonEvent("daemon.agent.provider_reconnect", {
          agentId,
          launchId: current.launchId || undefined,
          runtime: config.runtime,
          model: config.model,
        });
        this.broadcastActivity(agentId, "working", "Codex reconnecting to provider…", [
          { kind: "text", text },
        ], undefined, "runtime_reconnecting");
        logger.info(`[Agent ${agentId} stderr]: ${text}`);
        return;
      }
      // task #1127: Codex's tool router rejects tool-call arguments it cannot
      // deserialize and reports it only on stderr — no app-server notification
      // carries the fact, so without this branch the turn goes quiet and the
      // agent looks idle. Observation only: never restart, never retry. See
      // codexToolArgumentParseSignature.ts for why a text match is sanctioned
      // here and nowhere else.
      if (driver.id === "codex" && isCodexToolArgumentParseErrorChunk(text)) {
        current.recentStderr = pushRecentStderr(current.recentStderr, text);
        current.decisionErrorWindow.recordStderr(text);
        this.recordDaemonEvent("daemon.agent.tool_argument_parse_failed", {
          agentId,
          launchId: current.launchId || undefined,
          runtime: config.runtime,
          // Per-model counting is the point of the trace. The rejected argument
          // values are never recorded: they are model output and can hold
          // anything the user typed.
          model: config.model,
        }, "error");
        this.broadcastActivity(
          agentId,
          "error",
          CODEX_TOOL_ARGUMENT_PARSE_USER_MESSAGE,
          [{ kind: "text", text }],
          undefined,
          "runtime_error",
          undefined,
          undefined,
          buildRuntimeErrorActivityDiagnostic(text, {
            errorClass: "ToolArgumentParseError",
            reasonProvenance: "codex_stderr_signature",
            nativeReasonPresent: false,
          }),
        );
        logger.error(`[Agent ${agentId} stderr]: ${text}`);
        return;
      }
      // Codex CLI emits noisy but benign WebSocket fallback logs on stderr — suppress them.
      if (driver.id === "codex" && isCodexBenignTransportLog(text)) return;
      current.recentStderr = pushRecentStderr(current.recentStderr, text);
      current.decisionErrorWindow.recordStderr(text);
      logger.error(`[Agent ${agentId} stderr]: ${text}`);
    });

    runtime.on("error", (err) => {
      if (!this.runtimeProcessBindingFence.acceptOutput(agentId, boundAgentProcess, runtime, "error")) return;
      const current = boundAgentProcess;
      current.spawnError = err.message;
      const syscall = (err as NodeJS.ErrnoException).syscall;
      current.spawnErrorSyscall = typeof syscall === "string" ? syscall : null;
      this.clearRuntimeStartupTimeout(current);
      this.recordDaemonEvent("daemon.agent.process.error", {
        ...this.processLifecycleIdentityAttrs(agentId, current),
        error_class: normalizeAgentProcessErrorClass(err),
      }, "error");
      logger.error(`[Agent ${agentId}] Process error: ${err.message}`);
    });

    runtime.on("exit", ({ code, signal, reason: exitReason }) => {
      // task #365: a child proven never created was already settled
      // `not_spawned`; there is no process whose exit could be reported.
      if (boundAgentProcess.spawnNoProcess) {
        this.recordDaemonEvent("daemon.agent.process.exit_ignored", {
          agentId,
          reason: "spawn_no_process",
          exit_code: code,
        });
        return;
      }
      const current = this.agents.get(agentId);
      if (current && current.runtime === runtime) {
        current.exit = { kind: "exited", code, signal };
      }
      // Reconciler step 5: a kill whose exit was never seen releases the
      // agent here all the same, but it is no evidence of an exit: nothing
      // is reported as exited (daemon.agent.stop.kill_unconfirmed says why).
      const exitUnconfirmed = exitReason === "kill_unconfirmed";
      // Only a confirmed exit ends its record: an unconfirmed one stays for
      // the next daemon's orphan sweep.
      if (!exitUnconfirmed) this.runtimeProcessLedger?.forget(runtime.pid);
      // RFC 071 §4.3 rule 3: the identity comes from THIS runtime's closure
      // (the process that exited), never from the registry, which may already
      // hold a newer process for the agent or nothing at all.
      const exitFrameSent = !exitUnconfirmed && this.sendProcessExited(agentId, boundAgentProcess, effectiveLaunchId, code, signal);
      // RFC 071 outbox: a process started without a server launch and never
      // rebound to one has no process_exited frame; its exit is recorded
      // locally and durably instead.
      if (!exitUnconfirmed && !exitFrameSent && !effectiveLaunchId && this.runtimeProcessGate && this.daemonInstanceId) {
        this.runtimeProcessGate.processExitedLocally(agentId, boundAgentProcess.processInstanceId);
      }
      const exitTraceAttrs = this.runtimeExitTraceAttrs.get(runtime);
      this.recordDaemonEvent("daemon.agent.process.exited", {
        agentId,
        launchId: current?.launchId || undefined,
        runtime: config.runtime,
        model: config.model,
        exit_code: code,
        exit_signal: signal,
        clean_exit: code === 0,
        ...(exitUnconfirmed ? { exit_unconfirmed: true } : {}),
        runtime_trace_active: Boolean(current?.runtimeTraceSpan),
        inbox_count: current?.inbox.length ?? 0,
        pending_notification_count: current?.notifications.pendingCount ?? 0,
        ...exitTraceAttrs,
      });
      // Use the closure-captured agentProcess: stopAgent deletes from
      // this.agents before the runtime exits, so the map lookup above
      // returns undefined for explicit stops. The lifecycle span must
      // fire for every exit path.
      if (agentProcess) {
        const stopSource = exitTraceAttrs?.stop_source as string | undefined;
        const exitCause = stopSource?.includes("stall") ? "stall_kill"
          : stopSource === "disconnect" ? "disconnect_kill"
          : stopSource === "daemon_exit" ? "parent_exit"
          : stopSource === "explicit_request" || stopSource === "daemon_internal" || code === 0 ? "expected_terminate"
          : "crash";
        // last_event_age_ms_bucket is anchored on the last runtime event, not on
        // the turn start that stall decisions use (2026-06-22 lifecycle contract).
        const lastEventAgeMs = agentProcess.runtimeProgress.lastEventAgeMs();
        this.recordDaemonEvent("daemon.runtime.process.exit", {
          ...this.processLifecycleIdentityAttrs(agentId, agentProcess),
          exit_code: code,
          exit_signal: signal,
          cause: exitCause,
          last_event_kind: agentProcess.lastActivityKind || undefined,
          last_event_age_ms_bucket: bucketMs(lastEventAgeMs),
          uptime_ms_bucket: bucketMs(Date.now() - agentProcess.spawnedAtMs),
        }, code === 0 ? "ok" : "error");
        // A SIGKILL the daemon did not send: on Linux almost always the kernel
        // OOM killer (#triage:#169). Counted separately so a memory kill can be
        // told apart from an ordinary crash and later reported to the owner.
        if (signal === "SIGKILL" && exitCause === "crash") {
          this.recordDaemonEvent("daemon.agent.process_killed", {
            ...this.processLifecycleIdentityAttrs(agentId, agentProcess),
            exit_signal: signal,
            uptime_ms_bucket: bucketMs(Date.now() - agentProcess.spawnedAtMs),
          }, "error");
        }
      }
      logger.info(`[Agent ${agentId}] Process exited with code ${code}${signal ? ` (signal ${signal})` : ""}`);
    });

    runtime.on("close", ({ code, signal }) => {
      if (this.agents.has(agentId)) {
        const ap = this.agents.get(agentId)!;
        // Guard: if a new process was already spawned for this agent, don't touch it.
        // This happens when a process is replaced (e.g. restart on new message),
        // new process is added to the map, then the old process's exit handler fires.
        if (ap.runtime !== runtime) return;
        ap.notifications.clearTimer();
        this.sendIntents.endAll(agentId);
        this.disposeAgentProcessTimers(ap, { includeCompactionWatchdog: false });
        this.closeRuntimeReadinessTransition(ap, "terminal");
        this.closeActivationTransition(ap, "terminal");

        const finalCode = ap.exit.kind === "exited" ? ap.exit.code ?? code : code;
        const finalSignal = ap.exit.kind === "exited" ? ap.exit.signal ?? signal : signal;
        const expectedTerminationReason = ap.gatedSteering.expectedTerminationReason;
        const expectedTermination = Boolean(expectedTerminationReason);
        const turnBoundarySatisfied = closeSatisfiedTurnBoundary(ap, expectedTermination);
        // Reconciler step 4a: a runtime that exits on a rejected credential,
        // or names it only on stderr, before an error event recorded it: the
        // credential is invalid all the same (the close below then waits for
        // it instead of marking the agent crashed).
        const closeCredentialError = !expectedTermination && !(finalCode === 0 && turnBoundarySatisfied) ? credentialInvalidErrorOf(ap) : null;
        if (closeCredentialError && !this.credentialInvalidHold(agentId, ap.config)) {
          this.noteCredentialInvalid(agentId, ap, closeCredentialError.reason, closeCredentialError.text, "process_close");
        }

        // Reconciler step 10a: gather the facts, plan the exit (planExit.ts), act on it.
        const exit = this.exitContextOf(agentId, ap, finalCode, finalSignal, turnBoundarySatisfied);
        const plan = planExit(exit.facts);
        // Reconciler step 12: a sticky failure only the close's own output
        // names (an error event acts on it at once) is acted on as at that
        // event, not as a crash: no exit plan counts it.
        const closeSticky = expectedTerminationReason === null ? exit.sticky : null;
        if (!closeSticky) this.recordExitPlan(agentId, ap, plan, finalCode);
        this.endRuntimeTrace(ap, plan.clean ? "ok" : "error", {
          outcome: plan.clean ? "process-exit" : "process-crash",
          expectedTerminationReason: expectedTerminationReason || undefined,
          runtime_turn_boundary: ap.runtime.descriptor.turnBoundary,
          runtime_turn_boundary_satisfied: turnBoundarySatisfied,
          runtime_exit_before_turn_boundary: !turnBoundarySatisfied || undefined,
          exitCode: finalCode,
          exitSignal: finalSignal,
          ...runtimeTraceCounterAttrs(ap),
          ...(plan.clean ? {} : runtimeFailureEndTraceAttrs(ap, "unknown")),
          ...this.finalizeRuntimeProfileTurnControl(agentId, ap, "process_exit"),
        });

        this.interruptCompactionIfActive(agentId);
        cleanupLaunchProxies(agentId);
        this.revokeManagedRunnerCredential(agentId, ap.config, ap.launchId);
        this.rememberSessionSpec(agentId, ap);
        this.agents.delete(agentId);
        this.idleHolds.forget(agentId);
        // RFC 070 §6.5: a mark this process never reached its stop for goes with it (a stop it made is kept).
        this.warmRecycle.dropPending(agentId);
        this.clearQueuedInputSettle(ap);
        this.noteTurnActivity();

        if (closeSticky) {
          this.actOnStickyFailure(agentId, ap, closeSticky, terminalFailureFromRawText("sticky_runtime_error", ap.lastRuntimeError || closeSticky.detail));
        } else {
          this.actOnExitPlan(agentId, ap, plan, { ...exit, code, signal, finalCode, finalSignal, turnBoundarySatisfied });
        }
      }
    });

    // task #365: checked here and again by the driver itself after its last
    // await, right before the child (or native session) is created
    // (`assertLaunchCurrent`): a launch claimed against another connection
    // never gets a process.
    if (effectiveLaunchId && this.isStaleClaim(claimedConnectionEpochId)) {
      throw new StaleDispatchError(agentId, effectiveLaunchId);
    }
    let startResult: RuntimeSendResult;
    // task #26: held server context rides ahead of the first prompt; it counts
    // as delivered only once the start is committed below. It and the
    // memory-limit note go ahead of everything in `prompt`, including the
    // standing prompt of a fresh session without a native layer.
    const startReach = { processInstanceId: agentProcess.processInstanceId, sessionId: effectiveConfig.sessionId || null };
    const startServerContext = this.serverContext.pending(agentId, startReach);
    // task #1120: keep the driver's typed launch failure so the classifier can
    // decide by code; the flattened `error` string is for logs/diagnostics only.
    let startFailureCause: unknown = undefined;
    // RFC 071 outbox: persist the open record, then spawn. Every runtime
    // process (server start, respawn, restart) is created here, internal
    // starts without a server launchId included (keyed by processInstanceId).
    if (this.runtimeProcessGate && this.daemonInstanceId
      && !this.runtimeProcessGate.openProcess(agentId, processInstanceId, effectiveLaunchId)) {
      throw new RuntimeOutcomeStorageBlockedError(agentId);
    }
    try {
      startResult = await this.runtimeProcessBindingFence.start(
        agentId,
        agentProcess,
        { text: startServerContext ? formatServerContextPrefix(startServerContext.body) + prompt : prompt, sessionId: startReach.sessionId, origin: startOrigin },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      startFailureCause = error;
      startResult = { ok: false, reason: "runtime_error", error: message };
    }
    // Reconciler step 5: recorded until its exit is confirmed, so a daemon
    // that dies first has the next one reap it (the orphan sweep).
    void this.runtimeProcessLedger?.record(runtime.pid, { agentId, launchId: effectiveLaunchId, host: "legacy" });
    // task #365: the driver refused a stale launch before creating anything:
    // not a runtime failure, and never a spawn_error.
    if (startFailureCause instanceof StaleDispatchError) throw startFailureCause;
    // task #1277: a stop that landed while the driver was resolving or
    // spawning (or a newer attempt that replaced this one) must not commit
    // this start: no `active`, no startup timeout, no failure accounting. The
    // attempt cleans up only what it holds. The server then sees the same
    // frames as for a stop before the start: the stop's own `inactive` and
    // the launches settled (or, for a child that was created, `process_spawned`
    // followed by its exit).
    if (this.lifecycleRecords.stopEpochChanged(agentId, startStopEpoch) || this.agents.get(agentId) !== agentProcess) {
      keepCarriedAppNoticeOwed();
      await this.discardCancelledRuntimeStart(agentId, agentProcess, runtime, effectiveLaunchId, startResult, spawnTraceparent);
      return;
    }
    // task #365: `start()` reports ok once the driver returned a child, pid or
    // not; a failed spawn (EACCES, ENOENT) has no pid and its error arrives a
    // tick later. With a server that counts it, prove the outcome before
    // reporting a process: never `process_spawned` / `active` for a child that
    // was not created. An older server keeps today's path (the crash it reports
    // is what its #1119 breaker counts).
    if (startResult.ok && typeof runtime.pid !== "number" && this.serverStartContext.spawnErrorCapable) {
      const evidence = await this.waitForSpawnEvidence(runtime, agentProcess, SPAWN_EVIDENCE_WAIT_MS);
      if (evidence === "spawn_error") {
        agentProcess.spawnNoProcess = true;
        const message = agentProcess.spawnError ?? "spawn failed";
        startFailureCause = new RuntimeSpawnNoProcessError(message, agentProcess.spawnErrorSyscall);
        startResult = { ok: false, reason: "runtime_error", error: message };
      } else if (evidence === "closed") {
        startFailureCause = new Error("runtime closed before a process id was observed");
        startResult = { ok: false, reason: "runtime_error", error: "runtime closed before a process id was observed" };
      } else {
        this.recordDaemonEvent("daemon.agent.spawn.evidence_timeout", {
          agentId,
          launchId: effectiveLaunchId ?? undefined,
          wait_ms: SPAWN_EVIDENCE_WAIT_MS,
        });
        logger.warn(`[Agent ${agentId}] No pid and no spawn error within ${SPAWN_EVIDENCE_WAIT_MS}ms; start outcome unknown, holding it`);
        keepCarriedAppNoticeOwed();
        this.holdUnknownSpawn(agentId, agentProcess, runtime, effectiveLaunchId);
        return;
      }
    }
    if (!startResult.ok && typeof runtime.pid === "number") {
      // RFC 071 negative control: the start failed but a child process was
      // created. It is reported as spawned (its exit follows), never as
      // not_spawned.
      this.sendProcessSpawned(agentId, agentProcess, effectiveLaunchId);
    }
    if (!startResult.ok) {
      const diagnostics = startResult.error ? buildRuntimeErrorDiagnosticEnvelope(startResult.error) : null;
      this.recordDaemonEvent("daemon.agent.runtime_start.failed", {
        ...this.agentStartDispatch.traceAttrs(agentId, effectiveConfig, wakeMessage, unreadSummary, resumePrompt, agentProcess.launchId || undefined, wakeMessageTransient, undefined, startDispatchId),
        runtime_start_reason: startResult.reason,
        error_present: Boolean(startResult.error),
        runtime_error_class: diagnostics?.spanAttrs.runtime_error_class,
        // The typed launch code (as on daemon.agent.spawn.failed) plus the
        // scrubbed fingerprint and HTTP status, so failures group by cause
        // without the raw text.
        failure_reason: spawnFailureCodeOf(startFailureCause) ?? "runtime_spawn_failed",
        runtime_error_fingerprint: diagnostics?.spanAttrs.runtime_error_fingerprint,
        runtime_error_http_status: diagnostics?.spanAttrs.runtime_error_http_status,
      }, "error", spawnTraceparent);
      if (startResult.error) {
        agentProcess.lastRuntimeError = startResult.error;
        agentProcess.decisionErrorWindow.recordRuntimeError(startResult.error);
      }
      if (startResult.error && diagnostics?.spanAttrs.runtime_error_action_required === true) {
        const visibleErrorMessage = formatRuntimeActionRequiredMessage(agentProcess, startResult.error);
        this.broadcastActivity(agentId, "error", visibleErrorMessage,
          buildRuntimeActionRequiredEntries(agentProcess, startResult.error, diagnostics), agentProcess.launchId, "runtime_error");
      } else if (diagnostics?.spanAttrs.runtime_error_class === "InputTooLargeError") {
        const visibleErrorMessage = formatRuntimeInputTooLargeMessage(agentProcess.driver.id);
        this.broadcastActivity(agentId, "error", visibleErrorMessage, [
          { kind: "text", text: `Error: ${visibleErrorMessage}` },
        ], agentProcess.launchId, "runtime_error");
      }
      const visibleStartError = diagnostics?.spanAttrs.runtime_error_class === "InputTooLargeError"
        ? formatRuntimeInputTooLargeMessage(agentProcess.driver.id)
        : startResult.error;
      throw new RuntimeSessionStartError(
        `Runtime session failed to start: ${startResult.reason}${visibleStartError ? ` (${visibleStartError})` : ""}`,
        startFailureCause,
      );
    }
    // RFC 071 §4.3 rule 2: the identity of the process this launch spawned.
    this.sendProcessSpawned(agentId, agentProcess, effectiveLaunchId);
    this.lastStartFailures.delete(agentId);
    // The start committed with the server features notice (or there was
    // nothing to tell): drop its base (a start that failed keeps it). Values
    // that reached this process while it was being started (an answer applied
    // before it was registered, or to it since) still count: the session runs
    // on what it spawned with, so it drifts from them like any other.
    this.serverFeaturesNoticeBase.delete(agentId);
    const waitingServerFeatures = this.serverFeaturesGeneration > serverFeaturesGenerationAtSpawn && this.lastAppliedServerFeatures
      ? this.lastAppliedServerFeatures
      : pickAgentServerFeatures(agentProcess.config);
    this.applyServerFeaturesToProcess(agentId, agentProcess, waitingServerFeatures);
    // The start committed. A spawn-fail cooldown it overlaps (a server start
    // that arrived during one, e.g. after a start timeout) has nothing left to
    // hold back, and a running process with an active cooldown is not a valid
    // record. A failed start keeps the cooldown (task #357).
    if (this.isSpawnFailBackoffActive(agentId)) this.resetSpawnFailBackoff(agentId);
    // The process only: its session counts once the runtime reports it
    // (noteSession), since a spawned process may still drop the prompt.
    this.noteServerContextWritten(agentId, { processInstanceId: startReach.processInstanceId }, startServerContext, "start");
    // Task #389: the spawn prompt announced these messages, exactly as a stdin
    // inbox notice does, so record them as told to this session: only now that
    // the start committed (a failed start records nothing), and only what the
    // prompt held. A per-turn runtime that ends with one of them unread must
    // not be respawned to be told again (isNotifiedDeferralAtColdIdleStop).
    if (spawnAnnouncedMessages.length > 0) {
      agentProcess.notifications.recordNoticeWritten(
        computeInboxNoticeFingerprint(spawnAnnouncedMessages),
        agentProcess.sessionId,
        spawnAnnouncedMessages,
      );
    }
    // The prompt handed these third-party event bodies to the model (a resume
    // catch-up that folded the wake, or rendered context), and no `/events`
    // serve will carry them: report them delivered now that the start
    // committed. A content-free notice reports nothing. The reporter skips an
    // agent with no proxy registration.
    const startupThirdPartyEventIds = thirdPartyEventIdsFromEvents(startupBodyMessages);
    if (startupThirdPartyEventIds.length > 0) {
      this.#reportThirdPartyEventsDelivered(agentId, startupThirdPartyEventIds);
    }
    const startupAcceptedMessages = wakeMessage ? [wakeMessage] : resumeCatchupInputMessages.length > 0 ? resumeCatchupInputMessages : startingInboxMessages;
    if (this.containsOrdinaryInboxMessage(startupAcceptedMessages)) this.broadcastMessageReceivedActivity(agentId, startupAcceptedMessages);
    this.closeNoProcessResidency(agentId, "advanced");
    if (this.lifecycleRecords.deleteTerminalFailure(agentId)) {
      this.closeNoProcessResidency(agentId, "advanced", { negativeEvidenceBucket: "terminal_recovery_start_succeeded" });
    }
    this.assertStartPendingDeliveryInvariants("spawn-drain");
    if (carriedAppNotice) {
      this.markAppInboxNoticeDelivered(agentId, carriedAppNotice.items);
      carriedAppNotice = null;
    }
    this.recordDaemonEvent("daemon.agent.spawn.created", {
      ...this.agentStartDispatch.traceAttrs(agentId, effectiveConfig, wakeMessage, unreadSummary, resumePrompt, agentProcess.launchId || undefined, wakeMessageTransient, undefined, startDispatchId),
      detached: false,
      new_session: false,
      process_pid_present: typeof runtime.pid === "number",
    }, "ok", spawnTraceparent);
    const pendingCause = this.lifecycleRecords.getPendingSpawnCause(agentId);
    this.lifecycleRecords.deletePendingSpawnCause(agentId);
    const startCause = pendingCause
      ?? (isResume ? "session_resume" : wakeMessage ? "wake_message" : "explicit_start");
    this.recordDaemonEvent("daemon.runtime.process.spawn", {
      ...this.processLifecycleIdentityAttrs(agentId, agentProcess),
      start_dispatch_id: startDispatchId,
      start_cause: startCause,
      credential_type: effectiveConfig.agentCredentialKey ? "managed_runner" : "legacy_machine",
      session_id_present: Boolean(agentProcess.sessionId),
      launch_id_present: Boolean(agentProcess.launchId),
    }, "ok", spawnTraceparent);

    this.sendAgentStatus(agentId, "active", agentProcess.launchId);
    if (pendingStartRebind) this.reportSession(agentId, agentProcess, agentProcess.sessionId);
    this.broadcastActivity(agentId, "working", "Starting\u2026", [], undefined, "starting");
    this.startRuntimeStartupTimeout(agentId, agentProcess, startCause);

    // Phase-6 activation delivery: open the wait when this launch carries an
    // initial activation (wake / buffered inbox). When that activation was
    // folded into the spawn prompt it is delivered synchronously here \u2014 close
    // advanced(spawn_prompt). Otherwise (transient wake / resume / deferred) it
    // is delivered post-ready via stdin, so leave the row open until then.
    if (wakeMessage || startingInboxMessages.length > 0) {
      this.openActivationTransition(agentId, agentProcess, startCause);
      if (wakeMessageDeliveredAsInboxUpdate || startingInboxDeliveredAsInput) {
        this.closeActivationTransition(agentProcess, "advanced", "spawn_prompt");
      }
    }

    // A start that arrived while this spawn was being prepared, after the
    // deferred rebind above was taken, is still pending. The server armed its
    // launch guard for that newer launch, so unless this process carries it,
    // every frame of this launch is dropped as stale until the server restarts.
    const lateStartRebind = this.lifecycleRecords.getPendingStartRebind(agentId);
    if (lateStartRebind) {
      this.lifecycleRecords.deletePendingStartRebind(agentId);
      this.rebindRunningStart(agentId, lateStartRebind, "already_starting_late");
    }
    // Reconciler step 11: a config pushed while this process was starting
    // (unless the late start replaced it: then its own registration takes it).
    if (this.agents.get(agentId) === agentProcess) this.applyHeldConfigPush(agentId, agentProcess);

    } catch (err) {
      keepCarriedAppNoticeOwed();
      if (err instanceof StaleDispatchError) {
        // task #365: only the stale launch is refused; the agent's status is
        // left alone (a current start may own it). A start that arrived
        // while this one was being prepared is started on its own.
        this.settleServerStartNotSpawned(agentId, err.launchId, "stale_dispatch");
        if (agentProcess && !agentProcess.spawnReported && this.runtimeProcessGate && this.daemonInstanceId) {
          this.runtimeProcessGate.processNotStarted(agentId, agentProcess.processInstanceId);
        }
        this.agentStarts.clearStarting(agentId);
        this.closeNoProcessResidency(agentId, "suppressed", { negativeEvidenceBucket: "start_cancelled" });
        this.cleanupFailedRuntimeStart(agentId, agentProcess, err);
        const late = this.lifecycleRecords.getPendingStartRebind(agentId);
        this.lifecycleRecords.deletePendingStartRebind(agentId);
        if (late) {
          void this.startAgent(agentId, late.config, late.wakeMessage, late.unreadSummary, late.resumePrompt, late.launchId, late.wakeMessageTransient, late.resumeMessages, late.startDispatchId, null, undefined, late.recoveryGrant, late.claimedConnectionEpochId ?? null)
            .catch((startErr: unknown) => logger.warn(`[Agent ${agentId}] Start after a refused stale launch failed: ${startErr instanceof Error ? startErr.message : String(startErr)}`));
        }
        throw err;
      }
      // RFC 071: every launch still waiting has no process: either no child
      // was created, or it was folded after the child was reported (then it
      // was never carried by it).
      this.settleAllAcceptedLaunches(
        agentId,
        err instanceof RuntimeOutcomeStorageBlockedError
          ? "terminal_failure_outcome_storage_blocked"
          : agentProcess?.spawnNoProcess ? "spawn_error" : "spawn_failed",
      );
      // Never reported spawned: no process exists and no process_exited will
      // close its open record, so close it now (else a restart reads it as unknown).
      if (agentProcess && !agentProcess.spawnReported && this.runtimeProcessGate && this.daemonInstanceId) {
        this.runtimeProcessGate.processNotStarted(agentId, agentProcess.processInstanceId);
      }
      this.agentStarts.clearStarting(agentId);
      this.closeNoProcessResidency(agentId, "terminal", { negativeEvidenceBucket: "runtime_start_failed" });
      this.lifecycleRecords.deletePendingStartRebind(agentId);
      this.cleanupFailedRuntimeStart(agentId, agentProcess, err);
      throw err;
    } finally {
      this.spawningRunnerConfigs.delete(heldBySpawn);
      // #wg-rbac:#27: however this attempt ended (refused, cancelled, stale,
      // failed), a credential it brought or minted that no process holds is
      // revoked; one a process holds is revoked at that process's end.
      this.releaseUnheldRunnerCredential(agentId, config, launchId || originalLaunchId);
      if (spawnConfig) this.releaseUnheldRunnerCredential(agentId, spawnConfig, launchId || originalLaunchId);
    }
  }

  /**
   * task #1277 — the driver's spawn returned for a start that was stopped (or
   * replaced) meanwhile. Nothing of it is committed; only what this attempt
   * holds is ended. A child that was created is reported as spawned so its
   * exit follows (RFC 071 negative control); otherwise the launches settle as
   * cancelled. The stop that cancelled this start already sent its `inactive`.
   */
  private async discardCancelledRuntimeStart(
    agentId: string,
    ap: AgentProcess,
    runtime: RuntimeSession,
    launchId: string | null,
    startResult: RuntimeSendResult,
    traceparent: string | undefined,
  ): Promise<void> {
    const pidPresent = typeof runtime.pid === "number";
    const superseded = this.agents.get(agentId) !== ap && this.agents.has(agentId);
    // A child the driver created is reported as spawned (RFC 071 negative
    // control), pid or not. A pid-less ok start under a server that counts
    // spawn errors is proven the same way the committed path proves it; an
    // unknown outcome is reported as spawned, since the cleanup below ends it
    // and its exit gives the server a terminal state either way.
    let childCreated = pidPresent || startResult.ok;
    if (startResult.ok && !pidPresent && this.serverStartContext.spawnErrorCapable) {
      childCreated = (await this.waitForSpawnEvidence(runtime, ap, SPAWN_EVIDENCE_WAIT_MS)) !== "spawn_error";
    }
    this.recordDaemonEvent("daemon.agent.runtime_start.cancelled", {
      agentId,
      launchId: launchId ?? undefined,
      process_pid_present: pidPresent,
      child_created: childCreated,
      superseded,
    }, "ok", traceparent);
    // Only the launch this attempt owns is settled or reported. The agent-wide
    // accepted-launch list may already hold a newer attempt's launch, still
    // pending in its own spawn: that one keeps waiting for its own outcome.
    if (childCreated) {
      this.sendProcessSpawnedForOwnLaunch(agentId, ap, launchId);
    } else if (launchId) {
      this.settleLaunches(agentId, [launchId], { kind: "not_spawned", reason: "cancelled" });
    }
    this.closeRuntimeReadinessTransition(ap, "terminal");
    this.closeActivationTransition(ap, "terminal");
    if (childCreated) {
      // Only this attempt's runtime: a newer instance under the same agentId is
      // never touched. The exit is observed, never assumed: SIGTERM, a short
      // grace, SIGKILL, then a bounded wait for the exit event.
      const cleanup = await this.endCancelledStartChild(agentId, ap, runtime);
      this.recordDaemonEvent("daemon.agent.runtime_start.cancelled.cleanup", {
        agentId,
        launchId: launchId ?? undefined,
        child_exited: cleanup.childExited,
        waited_ms: Math.round(cleanup.waitedMs),
        escalated: cleanup.escalated,
      }, cleanup.childExited ? "ok" : "error", traceparent);
      if (!cleanup.childExited) {
        logger.warn(`[Agent ${agentId}] Cleanup of a cancelled start's child is unconfirmed: no exit observed within ${this.stopKill.confirmMs}ms after SIGKILL`);
      }
    }
    logger.info(`[Agent ${agentId}] Runtime start cancelled during spawn; not committed${superseded ? " (superseded by a newer attempt)" : ""}`);
  }

  /**
   * task #1277 — `process_spawned` that claims only this attempt's own launch:
   * no folding of other waiting launches (a newer attempt may own them).
   */
  private sendProcessSpawnedForOwnLaunch(agentId: string, ap: AgentProcess, launchId: string | null): void {
    if (ap.spawnReported) return;
    ap.spawnReported = true;
    const waiting = this.acceptedLaunches.get(agentId);
    const owned = Boolean(launchId && waiting?.includes(launchId));
    if (owned && waiting && launchId) {
      waiting.splice(waiting.indexOf(launchId), 1);
      if (waiting.length === 0) this.acceptedLaunches.delete(agentId);
    }
    if (!launchId || !this.daemonInstanceId) return;
    this.sendToServer({
      type: "agent:process_spawned",
      agentId,
      daemonInstanceId: this.daemonInstanceId,
      processInstanceId: ap.processInstanceId,
      launchId,
      clientSeq: this.activitySink.nextClientSeq(agentId),
      ...(owned ? {} : { respawn: true }),
    });
  }

  /** Ends the child of a cancelled start (the one stop, reconciler step 5) and reports whether its exit was observed. */
  private async endCancelledStartChild(
    agentId: string,
    ap: AgentProcess,
    runtime: RuntimeSession,
  ): Promise<{ childExited: boolean; waitedMs: number; escalated: boolean }> {
    const startedAt = process.hrtime.bigint();
    const stopped = this.stopRuntimeProcess(agentId, runtime, "cancelled_start", { reason: "explicit_request", launchId: ap.launchId });
    // Never in `agents`, but a later start of the agent still waits for its exit.
    this.trackExitingRuntime(agentId, runtime, stopped);
    const outcome = await stopped;
    return {
      childExited: outcome.exitConfirmed,
      waitedMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
      escalated: outcome.escalated,
    };
  }

  private async cleanupStoppedRuntimeStart(agentId: string, ap: AgentProcess): Promise<void> {
    if (this.agents.get(agentId) !== ap) return;
    ap.launchAbort?.abort();

    this.agentStarts.clearStarting(agentId);
    this.lifecycleRecords.deletePendingStartRebind(agentId);
    this.lifecycleRecords.deletePendingSpawnCause(agentId);
    this.lifecycleRecords.deleteRestartSnapshot(agentId);
    this.startingInboxes.cancelStart(agentId);
    ap.notifications.clearTimer();
    this.sendIntents.endAll(agentId);
    this.disposeAgentProcessTimers(ap);
    this.closeRuntimeReadinessTransition(ap, "terminal");
    this.closeActivationTransition(ap, "terminal");
    cleanupLaunchProxies(agentId);
    this.revokeManagedRunnerCredential(agentId, ap.config, ap.launchId);
    this.agents.delete(agentId);
    this.idleHolds.forget(agentId);
    this.noteTurnActivity();
    this.closeNoProcessResidency(agentId, "suppressed", { negativeEvidenceBucket: "explicit_stop" });
    this.assertStartPendingDeliveryInvariants("runtime-start-stop-epoch-fence");
    this.runtimeExitTraceAttrs.set(ap.runtime, {
      stop_source: "explicit_request",
      stop_wait_requested: false,
      stop_silent: false,
      stop_epoch_fence: true,
    });
    // Out of `agents` above; released once its exit is confirmed.
    const exited = this.stopRuntimeProcess(agentId, ap.runtime, "stopped_start", { reason: "explicit_request", launchId: ap.launchId });
    this.trackExitingRuntime(agentId, ap.runtime, exited);
    await exited;
    logger.info(`[Agent ${agentId}] Runtime start discarded after stop request`);
  }

  private suppressFailedRestartAfterStop(agentId: string, stopEpochAtRestart: number, source: string): boolean {
    if (!this.lifecycleRecords.stopEpochChanged(agentId, stopEpochAtRestart)) return false;

    this.lifecycleRecords.deleteRestartSnapshot(agentId);
    this.lifecycleRecords.deletePendingStartRebind(agentId);
    this.lifecycleRecords.deletePendingSpawnCause(agentId);
    this.startingInboxes.cancelStart(agentId);
    this.closeNoProcessResidency(agentId, "suppressed", { negativeEvidenceBucket: "explicit_stop" });
    this.assertStartPendingDeliveryInvariants(`${source}-stop-epoch-fence`);
    logger.info(`[Agent ${agentId}] Failed ${source} restart suppressed after stop request`);
    return true;
  }

  private cleanupFailedRuntimeStart(agentId: string, ap: AgentProcess | null, err: unknown): void {
    if (!ap) return;
    if (this.agents.get(agentId) !== ap) return;

    ap.notifications.clearTimer();
    this.sendIntents.endAll(agentId);
    this.disposeAgentProcessTimers(ap);
    this.closeRuntimeReadinessTransition(ap, "terminal");
    this.closeActivationTransition(ap, "terminal");
    this.endRuntimeTrace(ap, "error", {
      outcome: "runtime-start-failed",
      failure_detail: err instanceof Error ? err.message : String(err),
      ...runtimeTraceCounterAttrs(ap),
      ...this.finalizeRuntimeProfileTurnControl(agentId, ap, "runtime_error"),
    });
    cleanupLaunchProxies(agentId);
    this.revokeManagedRunnerCredential(agentId, ap.config, ap.launchId);
    this.agents.delete(agentId);
    this.idleHolds.forget(agentId);
    this.noteTurnActivity();
    this.lifecycleRecords.deleteRestartSnapshot(agentId);
    if (this.lifecycleRecords.deleteTerminalFailure(agentId)) {
      this.closeNoProcessResidency(agentId, "terminal", { negativeEvidenceBucket: "runtime_start_failed" });
    }
    // task #357: a start can fail while a spawn-fail cooldown is still active
    // (a server `agent:start` or manual start during the cooldown). The
    // manager's own restart paths re-cache the restart config in their catch;
    // outside callers only rethrow, and a cooldown without a restart config
    // is an invariant violation that rejects every later wake of this agent
    // (reminders, deliveries, profile reports) until the cooldown ends. A
    // real runtime start failure keeps the cooldown restartable from the
    // config that was just attempted. A refusal that never started anything
    // (outbox storage blocked; a start the Server already superseded) must
    // NOT be re-cached: the cooldown expiry would otherwise restart a launch
    // the Server refused, so drop the backoff and leave the next start to it.
    if (this.isSpawnFailBackoffActive(agentId)) {
      // task #365: a stale launch (claimed against an earlier connection) is
      // also a refusal, never re-cached.
      if (err instanceof RuntimeOutcomeStorageBlockedError || err instanceof StaleDispatchError) {
        this.resetSpawnFailBackoff(agentId, "suppressed");
      } else {
        this.lifecycleRecords.setRestartSnapshot(agentId, {
          config: this.buildRestartSafeConfig(ap.config, ap.sessionId),
          sessionId: ap.sessionId,
          launchId: ap.launchId,
          processInstanceId: ap.processInstanceId,
        });
      }
    }
    this.resetRuntimeErrorFingerprintFenceIfNonresident(agentId, "runtime_start_failed_cleanup", ap);
  }

  /**
   * Reconciler step 12: end a live process that failed for good (a sticky
   * failure, a fence), the runtime outcome first (RFC 071 §7 E1, sent while
   * launchId and sessionId are still readable, test W-1). Only the process:
   * no terminal record (those are RFC 071's `refuseUnreliableSpawn` only),
   * no crash-streak reset, no delivery kept here; what follows is the
   * caller's (`actOnStickyFailure`, `handStickyFailureToServer`). Its exit is
   * not planned (it is out of `agents` before it).
   */
  private releaseFailedProcess(
    agentId: string,
    ap: AgentProcess,
    detail: string,
    failure: TerminalRuntimeFailureEvidence,
  ): void {
    if (this.agents.get(agentId) !== ap) return;
    this.sendRuntimeOutcome(agentId, ap, {
      kind: "terminal_failure",
      failureKind: failure.failureKind,
      fingerprint: failure.fingerprint,
      errorClass: failure.errorClass,
    });

    ap.notifications.clear();
    this.sendIntents.endAll(agentId);
    this.disposeAgentProcessTimers(ap);
    this.closeRuntimeReadinessTransition(ap, "terminal");
    this.closeActivationTransition(ap, "terminal");
    cleanupLaunchProxies(agentId);
    this.revokeManagedRunnerCredential(agentId, ap.config, ap.launchId);
    this.rememberSessionSpec(agentId, ap);
    this.agents.delete(agentId);
    this.idleHolds.forget(agentId);
    this.warmRecycle.dropPending(agentId);
    this.clearQueuedInputSettle(ap);
    this.noteTurnActivity();

    const diagnostics = buildRuntimeErrorDiagnosticEnvelope(detail);
    // task #352 — attribute the SIGTERM in runner.log by the raw runtime error.
    logger.warn(
      `[Agent ${agentId}] ${ap.driver.id} failed for good: `
      + `class=${failure.errorClass} fingerprint=${failure.fingerprint} `
      + `inbox=${ap.inbox.length} pending_notifications=${ap.notifications.pendingCount}; terminating runtime process (SIGTERM)`,
    );
    this.recordDaemonEvent("daemon.agent.terminal_runtime_error.cleanup", {
      agentId,
      launchId: ap.launchId || undefined,
      runtime: ap.config.runtime,
      model: ap.config.model,
      session_id_present: Boolean(ap.sessionId),
      process_pid_present: typeof ap.runtime.pid === "number",
      inbox_count: ap.inbox.length,
      pending_notification_count: ap.notifications.pendingCount,
      runtime_error_class: diagnostics.spanAttrs.runtime_error_class,
      failure_kind: failure.failureKind,
    }, "error");
    this.runtimeExitTraceAttrs.set(ap.runtime, {
      stop_source: "terminal_runtime_error",
      runtime_error_class: diagnostics.spanAttrs.runtime_error_class,
    });
    // Out of `agents` above; released once its exit is confirmed.
    this.trackExitingRuntime(
      agentId,
      ap.runtime,
      this.stopRuntimeProcess(agentId, ap.runtime, "terminal_runtime_error", { reason: "terminal_runtime_error", launchId: ap.launchId }),
    );
  }

  /**
   * Reconciler step 12 (rows C8, C9, a failed compaction): a sticky failure,
   * from the runtime's error event (the process is still registered: it is
   * ended here) or from its close's output (already gone). The runtime
   * outcome (E1) is sent either way.
   * - The model cannot be used (C9): recorded (`StickyFailureRecords`), and
   *   the agent is given back to the server at once (`model_unsupported`).
   * - The session no longer fits (C8 on every runtime but Claude Code, a
   *   failed compaction): a new session (`replaceSessionAfterStickyFailure`),
   *   once; the same failure again before a turn of the new session
   *   completes is given back to the server as `session_needs_reset`.
   */
  private actOnStickyFailure(agentId: string, ap: AgentProcess, sticky: StickyFailure, evidence: TerminalRuntimeFailureEvidence): void {
    if (this.agents.get(agentId) === ap) {
      this.releaseFailedProcess(agentId, ap, sticky.detail, evidence);
    } else {
      this.sendRuntimeOutcome(agentId, ap, { kind: "terminal_failure", failureKind: evidence.failureKind, fingerprint: evidence.fingerprint, errorClass: evidence.errorClass });
    }
    const records = this.lifecycleRecords.exitStreaks.sticky;
    const label = runtimeDisplayName(ap.driver.id);
    if (sticky.kind === "model_unsupported") {
      records.noteUnusableModel(agentId, { runtime: ap.config.runtime || "claude", model: ap.config.model ?? null });
      this.handStickyFailureToServer(agentId, ap, {
        reason: "model_unsupported",
        detail: `${label} cannot use this model: ${sticky.detail}`,
        cause: "model_unsupported",
      });
      return;
    }
    const previous = records.sessionReset(agentId);
    if (previous) {
      this.handStickyFailureToServer(agentId, ap, {
        reason: "session_needs_reset",
        detail: formatSessionStillFailsMessage(label, sticky.detail),
        cause: sticky.kind,
      });
      return;
    }
    this.replaceSessionAfterStickyFailure(agentId, ap, sticky.kind === "compaction_failed" ? "compaction_failed" : "input_too_large");
  }

  /**
   * Reconciler step 12 (row C8): the session no longer fits the model. The
   * server forgets it (`agent:session:invalidate`, as D4 does) and the agent
   * starts on a new one with what was queued, once (the next wake does, with
   * nothing queued). What the agent had not read stays unread on the server.
   */
  private replaceSessionAfterStickyFailure(agentId: string, ap: AgentProcess, cause: SessionResetCause): void {
    const staleSessionId = ap.driver.currentSessionId ?? ap.sessionId ?? ap.resumeSessionId ?? ap.config.sessionId ?? null;
    this.lifecycleRecords.exitStreaks.sticky.noteSessionReset(agentId, cause);
    this.cancelRuntimeErrorProcessRestart(agentId);
    this.resetSpawnFailBackoff(agentId, "suppressed");
    if (staleSessionId) {
      rememberSessionContext(ap.cliTransportDir, staleSessionId, null);
      this.sendToServer({ type: "agent:session:invalidate", agentId, sessionId: staleSessionId, launchId: ap.launchId || undefined, reason: cause });
    }
    const restartConfig = this.buildRestartSafeConfig(ap.config, null);
    const snapshot = { config: restartConfig, sessionId: null, launchId: ap.launchId, processInstanceId: ap.processInstanceId };
    const carried = ap.inbox.splice(0).filter((message) => !this.isTransientDelivery(message));
    const label = runtimeDisplayName(ap.driver.id);
    const what = cause === "input_too_large" ? "no longer fits the model's input limit" : "could not be compacted";
    this.recordDaemonEvent("daemon.agent.session_replaced", {
      agentId,
      launchId: ap.launchId || undefined,
      runtime: ap.config.runtime,
      cause,
      session_id_present: Boolean(staleSessionId),
      carried_count: carried.length,
    }, "error");
    logger.warn(`[Agent ${agentId}] ${label} session ${what}; starting a new session (${carried.length} queued delivery(ies) carried)`);
    if (carried.length === 0) {
      // Nothing waits: the next wake starts the new session.
      this.lifecycleRecords.setRestartSnapshot(agentId, snapshot);
      this.sendAgentStatus(agentId, "active", ap.launchId);
      this.broadcastActivity(agentId, "online", `${label} session ${what}; the next message starts a new session`, [], undefined, "idle");
      return;
    }
    this.broadcastActivity(agentId, "working", `${label} session ${what}; starting a new session…`, [{
      kind: "text",
      text: `The ${label} session ${what}. Starting a new session; earlier runtime context is not restored. Raft messages and workspace files are kept.`,
    }], undefined, "runtime_unavailable");
    this.lifecycleRecords.setPendingSpawnCause(agentId, "restart_crash");
    const [wake, ...rest] = carried;
    const startPromise = this.startAgent(agentId, restartConfig, wake, undefined, undefined, ap.launchId || undefined);
    if (rest.length > 0) {
      this.startingInboxes.bufferMessagesDuringStart(agentId, rest);
      this.assertStartPendingDeliveryInvariants("session-replaced-pending-inbox-transfer");
    }
    startPromise.catch((err) => {
      logger.error(`[Agent ${agentId}] Starting a new session failed`, err);
      this.recordInboxDroppedOnExit(agentId, ap, "session_replace_failed", carried);
      this.lifecycleRecords.deletePendingSpawnCause(agentId);
      if (!this.agents.has(agentId)) this.lifecycleRecords.setRestartSnapshot(agentId, snapshot);
      this.sendAgentStatus(agentId, "inactive", ap.launchId);
    });
  }

  /**
   * Reconciler step 12: the agent is given back to the server at its first
   * report of a failure a new message would only repeat (C9, C11, a session
   * that still fails after a new one; the crash-streak cap uses
   * `handCrashStreakToServer`). As after the cap: no restart snapshot, no
   * buffered delivery (the server still holds them), a failed start with a
   * typed reason that pauses the server's automatic wakes at once
   * (`reportedStickyFailureReason`: `runtime_spawn_failed` to a server that
   * does not count it), and an error the person sees.
   */
  private handStickyFailureToServer(
    agentId: string,
    ap: AgentProcess,
    handoff: { reason: "model_unsupported" | "runtime_repeated_failure" | "session_needs_reset"; detail: string; cause: string },
  ): void {
    this.cancelRuntimeErrorProcessRestart(agentId);
    this.lifecycleRecords.deleteRestartSnapshot(agentId);
    this.resetSpawnFailBackoff(agentId, "terminal");
    const droppedBuffered = this.startingInboxes.count(agentId);
    this.startingInboxes.cancelStart(agentId);
    this.recordInboxDroppedOnExit(agentId, ap, "sticky_failure_handed_to_server", ap.inbox.splice(0));
    const reason = reportedStickyFailureReason(handoff.reason, this.serverCountsStickyReasons);
    const lastError = ap.lastRuntimeError || null;
    const lastErrorAttrs = buildRuntimeErrorDiagnosticEnvelope(lastError || handoff.detail).spanAttrs;
    logger.warn(`[Agent ${agentId}] ${ap.driver.id} failed for good (${handoff.cause}); reported to the Server as ${reason}, ${droppedBuffered} buffered delivery(ies) left to it`);
    this.recordDaemonEvent("daemon.agent.sticky_failure.handed_to_server", {
      agentId,
      launchId: ap.launchId || undefined,
      runtime: ap.config.runtime,
      model: ap.config.model,
      cause: handoff.cause,
      reason: handoff.reason,
      reported_reason: reason,
      dropped_count: droppedBuffered,
      runtime_error_class: lastErrorAttrs.runtime_error_class,
      runtime_error_fingerprint: lastErrorAttrs.runtime_error_fingerprint,
    }, "error");
    this.reportStartFailure(agentId, ap.launchId, { reason, detail: handoff.detail, userMessage: handoff.detail }, ap.config.model);
    // The detail already names the error the person can act on (never the raw provider text).
    const { requiredAction: _requiredAction, ...runtimeError } = buildRuntimeErrorActivityDiagnostic(lastError || handoff.detail, { reasonProvenance: "daemon_fallback", nativeReasonPresent: false });
    this.broadcastActivity(
      agentId,
      "error",
      handoff.detail,
      [{ kind: "text", text: `Error: ${handoff.detail}` }],
      ap.launchId,
      "runtime_error",
      undefined,
      undefined,
      runtimeError,
    );
  }

  private cacheStartupTimeoutRetryConfig(agentId: string, ap: AgentProcess): void {
    const retrySessionId = this.restartSafeSessionId(ap);
    const retryConfig = this.buildRestartSafeConfig(ap.config, retrySessionId);
    this.lifecycleRecords.setRestartSnapshot(agentId, {
      config: retryConfig,
      sessionId: retrySessionId,
      launchId: ap.launchId,
      processInstanceId: ap.processInstanceId,
    });
    this.recordDaemonEvent("daemon.agent.startup_timeout.retry_config_cached", {
      agentId,
      launchId: ap.launchId || undefined,
      runtime: ap.config.runtime,
      session_id_present: Boolean(ap.sessionId),
    });
  }

  private buildRestartSafeConfig(config: AgentConfig, sessionId: string | null): AgentConfig {
    const stripped = stripManagedRunnerCredential(config);
    return {
      ...stripped,
      serverUrl: this.serverUrl,
      sessionId,
    };
  }

  /** The config a launch runs with (daemon server URL, runner credential, provider, machine env defaults); every agent host launches with it. */
  async buildSpawnConfig(agentId: string, config: AgentConfig): Promise<AgentConfig> {
    // Every launch passes here. Env vars that can make this computer run other
    // code (agentEnvVarPolicy.ts) are recorded, by name only, and the agent
    // still starts: xxchan chose refusing new writes on the server over
    // blocking here (#proj-raft-computer:bbea62a0). Local defaults merged
    // below are not checked.
    const riskyEnvVars = agentEnvVarsRefusal(config);
    if (riskyEnvVars) {
      logger.warn(`[Agent ${agentId}] Settings set env vars that can make this computer run other code: ${riskyEnvVars.names.join(", ") || "(none by name)"}${riskyEnvVars.invalidNameCount > 0 ? `, ${riskyEnvVars.invalidNameCount} invalid name(s)` : ""}; starting anyway`);
      this.recordDaemonEvent("daemon.agent.spawn.risky_variables", {
        agentId,
        runtime: config.runtime,
        risky_variable_names: riskyEnvVars.names.join(","),
        invalid_variable_name_count: riskyEnvVars.invalidNameCount,
      }, "ok");
    }
    // The daemon's live connection target is authoritative for agent-side chat
    // bridge / CLI callbacks even when server config points at another origin.
    const baseConfig = config.serverUrl === this.serverUrl
      ? config
      : { ...config, serverUrl: this.serverUrl };
    const credentialedConfig = await this.ensureManagedRunnerCredential(agentId, baseConfig);
    let runnerConfig: AgentConfig;
    try {
      runnerConfig = await materializeProviderConnectionForSpawn(credentialedConfig, { serverUrl: this.serverUrl, daemonApiKey: this.daemonApiKey, agentId });
    } catch (err) {
      // A credential minted here for a launch that never gets its config.
      if (credentialedConfig !== baseConfig) this.revokeManagedRunnerCredential(agentId, credentialedConfig, null);
      throw err;
    }
    let effectiveConfig = runnerConfig;
    if (this.defaultAgentEnvVarsProvider) {
      try {
        const defaultEnvVars = await this.defaultAgentEnvVarsProvider({
          runtime: runnerConfig.runtime,
          model: runnerConfig.model,
          envVars: runnerConfig.envVars,
        });
        const mergedEnvVars = { ...(defaultEnvVars ?? {}), ...(runnerConfig.envVars ?? {}) };
        if (!this.sameEnvVars(mergedEnvVars, runnerConfig.envVars)) {
          effectiveConfig = { ...runnerConfig, envVars: mergedEnvVars };
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        logger.warn(
          `[Agent ${agentId}] Failed to resolve default runtime env vars — continuing without machine-level defaults (${reason})`,
        );
      }
    }
    // task #359: the server's passive_ax flag composed with the local
    // RAFT_PASSIVE_AX kill switch (agent env_vars over process env). The
    // context-generation writer reads the effective value from here.
    const passiveAx = resolvePassiveAx(effectiveConfig.passiveAx, effectiveConfig.envVars);
    if ((effectiveConfig.passiveAx === true) !== passiveAx) {
      effectiveConfig = { ...effectiveConfig, passiveAx };
    }
    return effectiveConfig;
  }

  private async requestManagedRunnerCredentialOnce(agentId: string, config: AgentConfig): Promise<{ apiKey: string; credentialId: string | null }> {
    const url = new URL(`/internal/computer/runners/${encodeURIComponent(agentId)}/credentials`, this.serverUrl);
    const res = await daemonFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.daemonApiKey}`,
        "Content-Type": "application/json",
        "X-Raft-Client": "daemon-server-session-worker",
      },
      body: JSON.stringify({
        scopes: ["send", "read", "mentions", "tasks", "reactions", "server", "channels", "knowledge", "mcp"],
        name: `runner:${config.runtime}:${agentId.slice(0, 8)}`,
      }),
    });
    if (!res.ok) {
      const contentType = res.headers.get("content-type") ?? "";
      let detail = `HTTP ${res.status}`;
      let code: string | null = null;
      if (contentType.includes("application/json")) {
        const body = await res.json().catch(() => null) as { error?: unknown; code?: unknown } | null;
        const error = typeof body?.error === "string" ? body.error : null;
        code = typeof body?.code === "string" ? body.code : null;
        detail = [detail, code, error].filter(Boolean).join(" ");
      }
      throw new RunnerCredentialMintError(detail, {
        code: code ?? "runner_credential_mint_http_error",
        retryable: isRetryableMintHttpFailure(res.status, code),
        status: res.status,
      });
    }

    const body = await res.json().catch(() => null) as { apiKey?: unknown; credentialId?: unknown } | null;
    if (typeof body?.apiKey !== "string" || !body.apiKey.startsWith("sk_agent_")) {
      throw new RunnerCredentialMintError("invalid_agent_credential_payload", {
        code: "invalid_agent_credential_payload",
      });
    }
    return {
      apiKey: body.apiKey,
      credentialId: typeof body.credentialId === "string" ? body.credentialId : null,
    };
  }

  private async ensureManagedRunnerCredential(agentId: string, config: AgentConfig): Promise<AgentConfig> {
    if (config.agentCredentialKey) return config;
    const span = this.tracer.startSpan("daemon.runner_credential_mint", {
      parent: getActiveTraceContext(),
      surface: "daemon",
      kind: "client",
      attrs: { agentId, runtime: config.runtime },
    });
    try {
      const nextConfig = await this.mintManagedRunnerCredentialWithRetry(agentId, config, formatTraceparent(span.context));
      span.end("ok");
      return nextConfig;
    } catch (err) {
      span.end("error", { attrs: { error_class: errorClassOf(err) } });
      throw err;
    }
  }

  private async mintManagedRunnerCredentialWithRetry(
    agentId: string,
    config: AgentConfig,
    mintTraceparent: string,
  ): Promise<AgentConfig> {
    if (process.env.SLOCK_AGENT_RUNNER_CREDENTIALS_DISABLED === "1") {
      throw new RunnerCredentialMintError("runner credential mint is disabled by SLOCK_AGENT_RUNNER_CREDENTIALS_DISABLED", {
        code: "runner_credentials_disabled",
      });
    }

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= RUNNER_CREDENTIAL_MINT_MAX_ATTEMPTS; attempt += 1) {
      try {
        const credential = await this.requestManagedRunnerCredentialOnce(agentId, config);
        return {
          ...config,
          agentCredentialKey: credential.apiKey,
          agentCredentialId: credential.credentialId,
        };
      } catch (err) {
        lastError = err;
        const detail = runnerCredentialErrorDetail(err);
        this.recordDaemonEvent("daemon.runner_credential_mint.retry", {
          agentId,
          runtime: config.runtime,
          attempt,
          max_attempts: RUNNER_CREDENTIAL_MINT_MAX_ATTEMPTS,
          http_status: detail.status,
          code: detail.code,
          reason: detail.message,
          retryable: detail.retryable,
        }, detail.retryable && attempt < RUNNER_CREDENTIAL_MINT_MAX_ATTEMPTS ? "ok" : "error", mintTraceparent);
        if (!detail.retryable || attempt >= RUNNER_CREDENTIAL_MINT_MAX_ATTEMPTS) break;
        await waitForRunnerCredentialRetry();
      }
    }

    const detail = runnerCredentialErrorDetail(lastError);
    this.recordDaemonEvent("daemon.runner_credential_mint.failed", {
      agentId,
      runtime: config.runtime,
      http_status: detail.status,
      code: detail.code,
      reason: detail.message,
      retryable: detail.retryable,
      max_attempts: RUNNER_CREDENTIAL_MINT_MAX_ATTEMPTS,
    }, "error", mintTraceparent);
    throw new RunnerCredentialMintError(
      `runner_credential_mint_failed: ${detail.message}. Managed runner startup requires /internal/computer credential mint; deploy server first or roll back the daemon binary.`,
      {
        code: detail.code,
        retryable: detail.retryable,
        status: detail.status,
      },
    );
  }

  /**
   * RFC 060: what this host holds for an agent. "active": a process, a start
   * in progress or a queued start; "idle": only a cached idle restart config.
   */
  /**
   * Reconciler step 11d: a handback whose refusal reported a start reached
   * its deadline with no start: report what a refusal now would, the runtime
   * unavailable, so Retry shows. Any start or stop of the agent ended the
   * handback (and its timer) before this, so the agent has no process; the
   * check only guards a start this host ran without the router.
   */
  private reportSpecHandbackDeadline(agentId: string): void {
    if (this.agents.has(agentId) || this.agentStarts.hasQueued(agentId) || this.agentStarts.hasStarting(agentId)) return;
    this.recordDaemonEvent("daemon.agent.spec_handback_deadline", { agentId });
    this.sendAgentStatus(agentId, "inactive", null);
    this.broadcastActivity(agentId, "offline", "Process unavailable; restart required", [], undefined, "runtime_unavailable");
  }

  /** Reconciler step 11c: the agent starts (here or on the OAR host), so a later refusal is no longer its handback (`specHandbacks`). */
  forgetSpecHandback(agentId: string): void {
    this.specHandbacks.forget(agentId);
  }

  agentHostState(agentId: string): "none" | "idle" | "active" {
    if (this.agents.has(agentId) || this.agentStarts.hasStarting(agentId) || this.agentStarts.hasQueued(agentId)) return "active";
    return this.lifecycleRecords.getRestartSnapshot(agentId) ? "idle" : "none";
  }

  holdsAgentStart(agentId: string): boolean {
    return this.agentHostState(agentId) === "active";
  }

  /**
   * RFC 069 §8: the per-agent client sequence that activity, status and the
   * RFC 071 frames share. Every agent host draws from this one counter, or the
   * server drops frames of an agent that moved between hosts as out of order.
   */
  nextClientSeq(agentId: string): number {
    return this.activitySink.nextClientSeq(agentId);
  }

  /**
   * RFC 071 for another agent host (RFC 060): take every accepted launch of
   * this agent still waiting for its result, which that host's
   * `process_spawned` names (the spawn's own launch and `supersededLaunchIds`).
   */
  takeAcceptedLaunches(agentId: string): string[] {
    const waiting = this.acceptedLaunches.get(agentId) ?? [];
    this.acceptedLaunches.delete(agentId);
    return [...waiting];
  }

  /** RFC 071 for another agent host: this launch is carried by that host's running process. */
  settleServerStartRebound(agentId: string, launchId: string, processInstanceId: string): void {
    this.settleLaunches(agentId, [launchId], { kind: "rebound", processInstanceId });
  }

  /** RFC 060: agents another host runs, for the transcript and runtime-profile reads. */
  setHostedSessions(sessions: HostedAgentSessions | null): void {
    this.hostedSessions = sessions;
  }

  /**
   * #wg-rbac:#27: a rebound start runs on `held`'s runner credential (the
   * process's, or the start it is folded into); the credential the start
   * brought, if another, is revoked here, once. Returns the start's config
   * with the credential it runs with.
   */
  private carryRunnerCredential(agentId: string, held: AgentConfig | null, start: { config: AgentConfig; launchId?: string }): AgentConfig {
    const { config, unused } = carryHeldRunnerCredential(held, start.config);
    if (unused) this.revokeManagedRunnerCredential(agentId, unused, start.launchId || null);
    return config;
  }

  /**
   * A start that arrived while one is starting waits as the pending rebind
   * (replacing an earlier one). It never carries a runner credential: the
   * start in progress spawns with its own (or mints one at spawn), and a
   * pending rebind may be dropped by a stop or a failure. Its credential is
   * revoked now.
   */
  private deferStartRebind(agentId: string, start: PendingStartRebind): void {
    const config = this.carryRunnerCredential(agentId, null, start);
    this.configRevisions.carryStaleMark(start.config, config);
    this.lifecycleRecords.setPendingStartRebind(agentId, { ...start, config });
  }

  /**
   * #wg-rbac:#27: a start's runner credential that no live process holds (a
   * cancelled queued start, a spawn that failed, was refused or was stale, an
   * OAR-only start no host ran) is revoked, once. A credential a process of
   * this host holds is left to that process's end.
   */
  releaseUnheldRunnerCredential(agentId: string, config: AgentConfig, launchId: string | null): void {
    const key = config.agentCredentialKey;
    if (!key || !config.agentCredentialId) return;
    for (const ap of this.agents.values()) {
      if (ap.config.agentCredentialKey === key) return;
    }
    this.revokeManagedRunnerCredential(agentId, config, launchId);
  }

  private revokeManagedRunnerCredential(agentId: string, config: AgentConfig, launchId: string | null): void {
    // Exactly once per credential: a start's cleanup and its process's end may both reach here.
    const credentialId = config.agentCredentialId;
    if (credentialId) {
      if (this.revokedRunnerCredentialIds.has(credentialId)) return;
      this.revokedRunnerCredentialIds.add(credentialId);
      if (this.revokedRunnerCredentialIds.size > REVOKED_RUNNER_CREDENTIAL_IDS_KEPT) {
        const oldest = this.revokedRunnerCredentialIds.values().next().value;
        if (oldest !== undefined) this.revokedRunnerCredentialIds.delete(oldest);
      }
    }
    revokeManagedRunnerCredential({
      serverUrl: this.serverUrl,
      daemonApiKey: this.daemonApiKey,
      agentId,
      config,
      launchId,
      // Through the injectable fetch (defaults to daemonFetch) so tests that fake
      // the server see the DELETE instead of it leaving the process; the module
      // -level call used to send real requests from every stop under test.
      fetchImpl: (url, init) => this.fetchImpl(url, init),
      recordEvent: (name, attrs, status) => this.recordDaemonEvent(name, attrs, status),
    });
  }

  private sameEnvVars(left: Record<string, string> | null | undefined, right: Record<string, string> | null | undefined): boolean {
    const leftKeys = Object.keys(left ?? {});
    const rightKeys = Object.keys(right ?? {});
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }
    return leftKeys.every((key) => left?.[key] === right?.[key]);
  }

  private enqueueRuntimeProfileNotification(agentId: string, ap: AgentProcess, message: AgentMessage, kind: "migration" | "daemon_release_notice", key: string): void {
    const queued = queueAgentInboxMessage(ap, message);
    if (!queued.duplicate && ap.driver.supportsStdinNotification && ap.sessionId) {
      ap.notifications.add();
      if (!ap.notifications.hasTimer) {
        this.scheduleStdinNotification(agentId, ap, STDIN_NOTIFICATION_INITIAL_DELAY_MS);
      }
    }
    this.recordDaemonEvent("daemon.agent.runtime_profile.routed", {
      agentId,
      kind,
      key_present: Boolean(key),
      key_hash: hashRuntimeProfileKey(key),
      outcome: ap.sessionId ? "queued_busy" : "queued_before_session",
      runtime: ap.config.runtime,
      session_id_present: Boolean(ap.sessionId),
      launchId: ap.launchId || undefined,
      inbox_count: queued.inboxCount,
      duplicate_pending_delivery: queued.duplicate,
      pending_notification_count: ap.notifications.pendingCount,
      busy_delivery_mode: ap.driver.busyDeliveryMode,
      supports_stdin_notification: ap.driver.supportsStdinNotification,
    });
    logger.info(
      `[Agent ${agentId}] Queued runtime profile ${kind} ${key} for ${ap.sessionId ? "busy" : "pre-session"} ${ap.driver.id} delivery`,
    );
  }

  private queueRuntimeProfileNotificationDuringStart(
    agentId: string,
    message: AgentMessage,
    kind: "migration" | "daemon_release_notice",
    key: string,
  ): void {
    const startingInboxCount = this.startingInboxes.bufferDuringStart(agentId, message);
    this.assertStartPendingDeliveryInvariants("runtime-profile-during-start");
    const queuedStart = this.agentStarts.getQueued(agentId);
    this.recordDaemonEvent("daemon.agent.runtime_profile.routed", {
      agentId,
      kind,
      key_present: Boolean(key),
      key_hash: hashRuntimeProfileKey(key),
      outcome: "queued_during_start",
      startup_pending: true,
      starting_inbox_count: startingInboxCount,
      launchId: queuedStart?.launchId,
    });
    logger.info(`[Agent ${agentId}] Queued runtime profile ${kind} ${key} during startup`);
  }

  private containsOrdinaryInboxMessage(messages: AgentMessage[]): boolean {
    return messages.some((message) => !runtimeProfileNotificationFromMessage(message));
  }

  /**
   * #proj-raft-computer:#46: a web login or provider connect for `authRuntime`
   * succeeded on this Computer (RuntimeAuthHost `onCredentialsChanged`): the
   * runtime's machine-shared credential (`shared:<runtime>`;
   * `sharedCredentialsAuthRuntime`) has a new version. What its old version
   * left ends, for every agent on it on both hosts:
   * - it is no longer invalid (reconciler step 4a): the agents it held get
   *   their held deliveries in the same process, with no human message
   *   (`applyCredentialInvalidChange`);
   * - its provider limit (the new account may have quota), and the live
   *   backoffs or closed agents' cooldowns it armed. Those end as if their
   *   wait had run out, through the same handlers their timers call: held
   *   deliveries go to the process, or the agent starts from its pending
   *   inbox (`releaseProviderLimit`).
   * Own credentials (`agent:<id>`: own credential home or key) stay. No
   * process is stopped or restarted. A logout clears nothing.
   */
  noteRuntimeCredentialsChanged(authRuntime: RuntimeAuthRuntime, reason: RuntimeAuthCredentialsChange): void {
    if (reason === "logout") return;
    // Reconciler step 12: a new sign-in or plan may have the model (both hosts' records).
    const sticky = this.lifecycleRecords.exitStreaks.sticky;
    for (const [agentId, unusable] of sticky.unusableModelAgents()) {
      if (unusable.runtime === authRuntime) sticky.forgetUnusableModel(agentId);
    }
    const key = sharedProviderLimitCredentialKey(authRuntime);
    const invalidReleased = this.lifecycleRecords.providerLimitLedger.releaseInvalid(key, "credentials_changed", { host: "legacy" });
    const record = this.lifecycleRecords.getProviderLimit(key, this.clockNow());
    const released = record ? this.releaseProviderLimit(key, record, "credentials_changed") : null;
    this.recordDaemonEvent("daemon.agent.runtime_credentials_changed.cleared", {
      runtime: authRuntime,
      reason,
      ...(record || invalidReleased.length > 0 ? { release_cause: "credentials_changed" } : {}),
      credential_invalid_released: invalidReleased.length,
      ...(invalidReleased.length > 0 ? { credential_invalid_reason: invalidReleased.map((each) => each.invalidReason).join(",") } : {}),
      provider_limit_backoffs_cleared: record ? 1 : 0,
      live_backoffs_ended: released?.liveBackoffsEnded ?? 0,
      cooldowns_ended: released?.cooldownsEnded ?? 0,
    });
  }

  // ----- CREDENTIAL VALIDITY (#proj-raft-computer:#46, reconciler step 4a) ---

  /** Reconciler step 15: the account a process starting on `config` signs in as (never throws). */
  private credentialAccountAtStart(config: AgentConfig): CredentialAccount | null {
    try {
      return this.readCredentialAccount(config);
    } catch {
      return { kind: "unknown" };
    }
  }

  /** Reconciler step 15: the account this process started with against the one its credential signs in as now. */
  private credentialAccountCheckOf(ap: AgentProcess): ReturnType<typeof credentialAccountCheck> {
    return credentialAccountCheck(ap.credentialAccount, ap.credentialAccount ? this.credentialAccountAtStart(ap.config) : null);
  }

  /**
   * Reconciler step 15 (task #48, Tenny): the credential holding this process
   * was released for a credentials change and now signs in as another
   * account (or one that cannot be read, while the start's was known). A
   * live Codex or Claude process keeps the account it started with (for
   * Claude verified by a live test, task #48, Otter bfe2d441), so its held
   * deliveries do not go to it: it drifts (`credential_account`), and the
   * spec restart stops it once idle (its held deliveries do not count) and
   * starts it again on the same session with them (`actOnCleanExit`).
   */
  private restartForCredentialAccount(agentId: string, ap: AgentProcess, check: CredentialAccountCheck): void {
    ap.credentialAccountChanged = true;
    this.recordDaemonEvent("daemon.agent.credential_account.restart", {
      agentId,
      runtime: ap.config.runtime,
      launchId: ap.launchId || undefined,
      release_cause: "credentials_changed",
      account_changed: check === "account_changed",
      account_unknown: check === "account_unknown",
      held_count: ap.inbox.length,
      host: "legacy",
    });
    logger.info(`[Agent ${agentId}] Credential now signs in as ${check === "account_changed" ? "another account" : "an account that cannot be read"}; restarting the idle process on its session`);
    this.reconcile(agentId, ap, "credentials_changed");
  }

  /**
   * The invalid record holding this agent's deliveries, if any: one on its
   * credential (`providerLimitCredentialKey`), for `user_model_access` only
   * while the agent runs that model. Derived from the ledger alone: the hold
   * ends the moment the record is released, on either host.
   */
  private credentialInvalidHold(agentId: string, config: AgentConfig): CredentialInvalidRecord | undefined {
    const ledger = this.lifecycleRecords.providerLimitLedger;
    if (!ledger.hasAnyInvalid()) return undefined;
    return ledger.invalidFor(providerLimitCredentialKey(agentId, config), config.model);
  }

  /**
   * A process that ended cleanly: "Process idle", unless its own invalid
   * credential holds it, whose error (what to do) stays the visible state.
   */
  private broadcastIdleOrCredentialInvalid(agentId: string, ap: AgentProcess): void {
    const invalidError = this.credentialInvalidHold(agentId, ap.config) ? credentialInvalidErrorOf(ap) : null;
    if (!invalidError) {
      this.broadcastActivity(agentId, "online", "Process idle", [], undefined, "idle");
      return;
    }
    const visible = credentialInvalidVisibleError(ap, invalidError.reason, invalidError.text);
    this.broadcastActivity(agentId, "error", visible.detail, visible.entries, ap.launchId, "runtime_error", undefined, undefined, buildRuntimeErrorActivityDiagnostic(invalidError.text));
  }

  /** Whether the live process of `agentId` is held for an invalid credential (a retry timer's gate; the release flushes). */
  /** Whether this process's deliveries wait on a hold now: its provider limit's backoff, or an invalid credential. */
  private deliveriesHeld(agentId: string, ap: AgentProcess): boolean {
    return this.runtimeErrorDeliveryBackoffRemainingMs(ap) > 0 || this.heldForCredentialInvalid(agentId);
  }

  private heldForCredentialInvalid(agentId: string): boolean {
    const ap = this.agents.get(agentId);
    return Boolean(ap && this.credentialInvalidHold(agentId, ap.config));
  }

  /**
   * The held notice this process shows while an invalid record it did not
   * see rejected itself holds it (another agent on its shared sign-in
   * reported it, or an earlier process of this agent did): null when nothing
   * holds it or it shows its own error. Shown as its idle status (every
   * "online"/"idle" frame while it is held, `broadcastActivity`), never as a
   * runtime error: no `runtimeError` carrier, so no `requiredAction` and no
   * `AuthError` class, and not the `runtime_error` detail kind, so the server
   * neither stores it as the agent's runtime error nor blocks its wakes.
   */
  private credentialInvalidHeldNotice(agentId: string, ap: AgentProcess): { text: string; noticeKey: string; record: CredentialInvalidRecord; key: ProviderLimitCredentialKey } | null {
    if (ap.credentialInvalidVisibility?.kind === "own_error") return null;
    const record = this.credentialInvalidHold(agentId, ap.config);
    if (!record) return null;
    const key = providerLimitCredentialKey(agentId, ap.config);
    return {
      text: formatCredentialInvalidHeldNotice(ap.driver.id, record, ap.config.model, providerLimitCredentialKeyKind(key) === "shared"),
      noticeKey: credentialInvalidNoticeKey(record),
      record,
      key,
    };
  }

  /**
   * The process now shows the held notice `notice`: remembered, and traced
   * the first time for this record (`daemon.agent.credential_invalid.notice`).
   */
  private noteCredentialInvalidHeldNoticeShown(
    agentId: string,
    ap: AgentProcess,
    notice: NonNullable<ReturnType<AgentProcessManager["credentialInvalidHeldNotice"]>>,
    trigger: string,
  ): void {
    const current = ap.credentialInvalidVisibility;
    if (current?.kind === "notice" && current.noticeKey === notice.noticeKey) return;
    ap.credentialInvalidVisibility = { kind: "notice", noticeKey: notice.noticeKey };
    this.lifecycleRecords.providerLimitLedger.noteInvalidShown(notice.key, notice.record, {
      agentId,
      host: "legacy",
      reason: notice.record.invalidReason,
      shownAs: "notice",
    });
    this.recordDaemonEvent("daemon.agent.credential_invalid.notice", {
      agentId,
      runtime: ap.config.runtime,
      model: ap.config.model,
      launchId: ap.launchId || undefined,
      notice: "shown",
      visible: true,
      trigger,
      credential_invalid_reason: notice.record.invalidReason,
      credential_key_kind: providerLimitCredentialKeyKind(notice.key),
      host: "legacy",
    });
  }

  /**
   * Reconciler step 4a: a live process just became held by an invalid record
   * it did not see itself (`trigger`: recorded by another agent on its
   * credential, or its config now matches one): it shows the held notice
   * now, once per record. A process that is busy (or in an error or offline
   * state) shows it with its next idle status instead.
   */
  private publishCredentialInvalidHeldNotice(agentId: string, ap: AgentProcess, trigger: string): void {
    const notice = this.credentialInvalidHeldNotice(agentId, ap);
    if (!notice) return;
    const current = ap.credentialInvalidVisibility;
    if (current?.kind === "notice" && current.noticeKey === notice.noticeKey) return;
    if (ap.lastActivityKind !== "online") return;
    this.noteCredentialInvalidHeldNoticeShown(agentId, ap, notice, trigger);
    this.broadcastActivity(agentId, "online", notice.text, [], undefined, "idle");
  }

  /**
   * The invalid record no longer holds this process (`cause`): it stops
   * showing the held notice. An idle process shows "Process idle" again, as
   * it does after any other wait; a busy one's own frames replace the notice.
   * Its own error is left as it is: model output clears it, as before.
   */
  private endCredentialInvalidHeldNotice(agentId: string, ap: AgentProcess, cause: string): void {
    const shown = ap.credentialInvalidVisibility;
    ap.credentialInvalidVisibility = null;
    if (shown?.kind !== "notice") return;
    this.recordDaemonEvent("daemon.agent.credential_invalid.notice", {
      agentId,
      runtime: ap.config.runtime,
      model: ap.config.model,
      launchId: ap.launchId || undefined,
      notice: "cleared",
      visible: false,
      release_cause: cause,
      host: "legacy",
    });
    if (ap.lastActivityKind === "online") this.broadcastActivity(agentId, "online", "Process idle", [], undefined, "idle");
  }

  /**
   * The runtime said the agent's credential is invalid (`reason`): recorded
   * on the credential, announced to both hosts. The process is kept (its
   * background tasks too), its restart snapshot stays, and its deliveries,
   * like those of every agent the record applies to, are held until the
   * record is released. Returns the user-visible error it shows.
   */
  private noteCredentialInvalid(
    agentId: string,
    ap: AgentProcess,
    reason: CredentialInvalidReason,
    message: string,
    source: "runtime_error" | "delivery_rejected" | "process_close",
  ): { detail: string; entries: TrajectoryEntry[]; traceAttrs: Record<string, unknown> } {
    const key = providerLimitCredentialKey(agentId, ap.config);
    const traceAttrs = { credential_invalid_reason: reason, credential_key_kind: providerLimitCredentialKeyKind(key), host: "legacy" };
    ap.notifications.clearTimer();
    // This process shows its own error (what to do), not the held notice.
    ap.credentialInvalidVisibility = { kind: "own_error" };
    const readinessCode = credentialProblemCodeOf(message);
    this.lifecycleRecords.providerLimitLedger.recordInvalid(key, {
      invalidReason: reason,
      ...(reason === "user_model_access" ? { model: ap.config.model } : {}),
      recordedAtMs: Date.now(),
      ...(readinessCode ? { code: readinessCode } : {}),
    }, { host: "legacy", agentId }, ap.config);
    this.recordDaemonEvent("daemon.agent.credential_invalid.recorded", {
      agentId,
      runtime: ap.config.runtime,
      model: ap.config.model,
      launchId: ap.launchId || undefined,
      source,
      inbox_count: ap.inbox.length,
      background_tasks_outstanding: ap.backgroundTasks.size,
      ...traceAttrs,
    }, "error");
    logger.warn(`[Agent ${agentId}] ${ap.driver.id} credential invalid (${reason}); process kept, deliveries held until the credential changes`);
    return { ...credentialInvalidVisibleError(ap, reason, message), traceAttrs };
  }

  /**
   * An invalid record changed on either host (the ledger announces both
   * hosts' changes here, this host's own included). Recorded: the other live
   * agents it now holds say so in a trace, and show the held notice
   * (`publishCredentialInvalidHeldNotice`). Released: every live agent on the
   * credential no longer held stops showing it
   * (`endCredentialInvalidHeldNotice`) and gets its held deliveries, in the
   * same process (`flushRuntimeErrorDeliveryBackoff`; a provider-limit wait
   * still running keeps them), and a closed agent held in a cooldown at its
   * close starts from its pending inbox. An explicit stop's own agent is left
   * to the stop.
   */
  private applyCredentialInvalidChange(change: Extract<ProviderLimitChange, { kind: "invalid_recorded" | "invalid_released" }>): void {
    const attrs = {
      credential_invalid_reason: change.record.invalidReason,
      credential_key_kind: providerLimitCredentialKeyKind(change.key),
      source_host: change.source.host,
      host: "legacy",
    };
    if (change.kind === "invalid_recorded") {
      for (const [agentId, ap] of this.agents) {
        if (agentId === change.source.agentId || providerLimitCredentialKey(agentId, ap.config) !== change.key) continue;
        if (!credentialInvalidAppliesToModel(change.record, ap.config.model)) continue;
        this.recordDaemonEvent("daemon.agent.credential_invalid.held", {
          agentId,
          runtime: ap.config.runtime,
          model: ap.config.model,
          launchId: ap.launchId || undefined,
          restore_point: "shared_credential_invalid",
          inbox_count: ap.inbox.length,
          ...attrs,
        });
        this.publishCredentialInvalidHeldNotice(agentId, ap, "recorded");
      }
      return;
    }
    this.reportCredentialRestored(change);
    const exceptAgentId = change.cause === "explicit_stop" ? change.source.agentId : undefined;
    for (const [agentId, ap] of [...this.agents]) {
      if (agentId === exceptAgentId || providerLimitCredentialKey(agentId, ap.config) !== change.key) continue;
      if (!credentialInvalidAppliesToModel(change.record, ap.config.model) || this.credentialInvalidHold(agentId, ap.config)) continue;
      // The rejection this process saw is over: it must not count again
      // (a later close re-reading it, `credentialInvalidErrorOf`).
      if (ap.lastRuntimeError && credentialInvalidReasonOf(ap.lastRuntimeError)) ap.lastRuntimeError = null;
      ap.recentStderr = ap.recentStderr.filter((line) => !credentialInvalidReasonOf(line));
      this.endCredentialInvalidHeldNotice(agentId, ap, change.cause);
      const account = change.cause === "credentials_changed" ? this.credentialAccountCheckOf(ap) : null;
      this.recordDaemonEvent("daemon.agent.credential_invalid.released", {
        agentId,
        runtime: ap.config.runtime,
        model: ap.config.model,
        launchId: ap.launchId || undefined,
        release_cause: change.cause,
        released: account?.restart ? "account_restart" : "held_deliveries",
        held_count: ap.inbox.length,
        ...(account ? { account_check: account.check } : {}),
        ...attrs,
      });
      if (account?.restart) {
        this.restartForCredentialAccount(agentId, ap, account.check);
        continue;
      }
      this.flushRuntimeErrorDeliveryBackoff(agentId);
    }
    for (const [agentId, cooldown] of [...this.lifecycleRecords.activeSpawnFailBackoffs]) {
      if (agentId === exceptAgentId || this.agents.has(agentId) || cooldown.reason !== CREDENTIAL_INVALID_COOLDOWN_REASON) continue;
      const config = this.lifecycleRecords.getRestartSnapshot(agentId)?.config;
      if (!config || providerLimitCredentialKey(agentId, config) !== change.key) continue;
      if (!credentialInvalidAppliesToModel(change.record, config.model) || this.credentialInvalidHold(agentId, config)) continue;
      if (cooldown.timer) clearTimeout(cooldown.timer);
      this.recordDaemonEvent("daemon.agent.credential_invalid.released", {
        agentId,
        runtime: config.runtime,
        model: config.model,
        release_cause: change.cause,
        released: "cooldown",
        held_count: this.startingInboxes.count(agentId),
        ...attrs,
      });
      this.onSpawnFailBackoffExpired(agentId);
    }
  }

  /**
   * Reconciler step 4b: the released record no longer holds the agents of
   * this host that showed it (its own runtime error, or the held notice;
   * live or closed): the server is told, per agent and the reason it showed
   * (`agent:credential:restored`), so it lifts an automatic-wake block it set
   * for that reason only. Agents that never showed it are not reported.
   */
  private reportCredentialRestored(change: Extract<ProviderLimitChange, { kind: "invalid_released" }>): void {
    for (const shown of change.shown) {
      if (shown.host !== "legacy") continue;
      const ap = this.agents.get(shown.agentId);
      this.sendToServer({
        type: "agent:credential:restored",
        agentId: shown.agentId,
        reason: shown.reason,
        releaseCause: change.cause,
        ...(ap?.launchId ? { launchId: ap.launchId } : {}),
      });
      this.recordDaemonEvent("daemon.agent.credential_invalid.restored_reported", {
        agentId: shown.agentId,
        runtime: ap?.config.runtime,
        model: ap?.config.model,
        launchId: ap?.launchId || undefined,
        credential_invalid_reason: shown.reason,
        released_record_reason: change.record.invalidReason,
        release_cause: change.cause,
        shown_as: shown.shownAs,
        agent_live: Boolean(ap),
        credential_key_kind: providerLimitCredentialKeyKind(change.key),
        source_host: change.source.host,
        host: "legacy",
      });
    }
  }

  /**
   * Model output from a turn this process started after the record: the
   * credential evidently works (for that model), so it is valid again for
   * every agent on it, on both hosts.
   */
  private releaseCredentialInvalidOnModelOutput(agentId: string, ap: AgentProcess, eventKind: string): void {
    const ledger = this.lifecycleRecords.providerLimitLedger;
    if (!ledger.hasAnyInvalid()) return;
    const turnStartedAtMs = ap.runtimeProgress.currentTurnStartedAt;
    const released = ledger.releaseInvalid(
      providerLimitCredentialKey(agentId, ap.config),
      "model_output",
      { host: "legacy", agentId },
      (record) => credentialInvalidAppliesToModel(record, ap.config.model) && turnStartedAtMs > record.recordedAtMs,
      turnStartedAtMs,
    );
    if (released.length === 0) return;
    this.recordDaemonEvent("daemon.agent.credential_invalid.cleared", {
      agentId,
      runtime: ap.config.runtime,
      model: ap.config.model,
      launchId: ap.launchId || undefined,
      reset_source: eventKind,
      release_cause: "model_output",
      credential_invalid_reason: released.map((each) => each.invalidReason).join(","),
      credential_key_kind: providerLimitCredentialKeyKind(providerLimitCredentialKey(agentId, ap.config)),
      host: "legacy",
    });
    // This process is not held any more either.
    if (ap.inbox.length > 0) this.flushRuntimeErrorDeliveryBackoff(agentId);
  }

  /**
   * The agent now runs `config.model`: a `user_model_access` record about
   * another model on its own credential no longer applies to anyone
   * (`model_changed`). On a shared sign-in the record stays for the other
   * agents on that model; this agent is simply no longer held by it.
   */
  private releaseCredentialInvalidForModelChange(agentId: string, config: AgentConfig): void {
    const ledger = this.lifecycleRecords.providerLimitLedger;
    if (!ledger.hasAnyInvalid()) return;
    const key = providerLimitCredentialKey(agentId, config);
    if (providerLimitCredentialKeyKind(key) !== "agent") return;
    ledger.releaseInvalid(key, "model_changed", { host: "legacy", agentId },
      (record) => record.invalidReason === "user_model_access" && !credentialInvalidAppliesToModel(record, config.model));
  }

  /**
   * A process closed while its credential is invalid: as for a provider
   * limit (`holdDeliveriesForProviderLimitBackoff`), its restart snapshot
   * is kept and the agent waits in the spawn-fail cooldown with `messages`
   * buffered (later deliveries too), instead of being restarted into the
   * same rejection or marked inactive. The release of the record ends the
   * cooldown at once (`applyCredentialInvalidChange`); the cooldown needs a
   * deadline, so after CREDENTIAL_INVALID_CLOSED_HOLD_MS it starts the agent
   * from its buffer, which tries the credential once. Returns false when the
   * credential is valid.
   *
   * `ownIdleStop`: the daemon stopped the idle process itself (a runtime
   * spec restart or a cold-idle stop, reconciler steps 6, 7 and 8b: both stop
   * with the reason `cold_idle_recycle`). Nothing
   * asked for a start, and the live process it replaced held its deliveries
   * for as long as the credential stayed invalid: so does the closed agent.
   * Its deadline only renews the hold while the credential is still invalid
   * (renewCredentialInvalidHold); the release or a person's stop ends it.
   */
  private holdDeliveriesForCredentialInvalid(agentId: string, ap: AgentProcess, messages: AgentMessage[], source: string, ownIdleStop = false): boolean {
    const invalid = this.credentialInvalidHold(agentId, ap.config);
    if (!invalid) return false;
    const untilMs = this.clockNow() + CREDENTIAL_INVALID_CLOSED_HOLD_MS;
    this.holdClosedAgentInCooldown(
      agentId,
      ap,
      messages,
      untilMs,
      CREDENTIAL_INVALID_COOLDOWN_REASON,
      source,
      ownIdleStop ? () => this.renewCredentialInvalidHold(agentId) : undefined,
    );
    this.recordDaemonEvent("daemon.agent.credential_invalid.held", {
      agentId,
      runtime: ap.config.runtime,
      model: ap.config.model,
      launchId: ap.launchId || undefined,
      restore_point: "process_close",
      held_count: messages.length,
      credential_invalid_reason: invalid.invalidReason,
      credential_key_kind: providerLimitCredentialKeyKind(providerLimitCredentialKey(agentId, ap.config)),
      host: "legacy",
      ...(ownIdleStop ? { own_idle_stop: true } : {}),
    });
    return true;
  }

  /**
   * The deadline of a credential hold that began at the daemon's own idle
   * stop (holdDeliveriesForCredentialInvalid `ownIdleStop`): while the
   * credential is still invalid the hold goes on, its buffered deliveries
   * with it; otherwise (or once the agent is no longer held there) the
   * cooldown ends as any other.
   */
  private renewCredentialInvalidHold(agentId: string): void {
    const state = this.lifecycleRecords.getSpawnFailBackoff(agentId);
    const config = this.lifecycleRecords.getRestartSnapshot(agentId)?.config;
    if (!state || state.kind !== "backing_off" || state.reason !== CREDENTIAL_INVALID_COOLDOWN_REASON || !config
      || this.agents.has(agentId) || !this.credentialInvalidHold(agentId, config)) {
      this.onSpawnFailBackoffExpired(agentId);
      return;
    }
    state.untilMs = this.clockNow() + CREDENTIAL_INVALID_CLOSED_HOLD_MS;
    state.timer = setTimeout(() => this.renewCredentialInvalidHold(agentId), CREDENTIAL_INVALID_CLOSED_HOLD_MS);
    state.timer.unref?.();
    this.recordDaemonEvent("daemon.agent.credential_invalid.hold_renewed", {
      agentId,
      runtime: config.runtime,
      held_count: this.startingInboxes.count(agentId),
    });
  }

  /**
   * task #379: an explicit (user) stop, and so a manual restart (the Server's
   * stop then start), is a human "try again": the agent starts with no
   * provider-limit backoff. The limit is its credential's, so the release
   * covers every agent on a shared sign-in too (#proj-raft-computer:#46, the
   * same rule as the human Retry); if the account is still limited, the next
   * request records it again for all of them, at the cost of one request.
   * The stopping process itself is left to the stop: nothing is flushed to it.
   */
  private releaseProviderLimitForExplicitStop(agentId: string, config: AgentConfig | undefined): void {
    const keys = new Set<ProviderLimitCredentialKey>([ownProviderLimitCredentialKey(agentId)]);
    if (config) keys.add(providerLimitCredentialKey(agentId, config));
    // Reconciler step 4a, Q4: the manual Retry of an invalid credential. It
    // counts as valid again for every agent on it; if it is not, the next
    // request records it again.
    for (const key of keys) {
      const released = this.lifecycleRecords.providerLimitLedger.releaseInvalid(key, "explicit_stop", { host: "legacy", agentId });
      if (released.length === 0) continue;
      this.recordDaemonEvent("daemon.agent.credential_invalid.cleared", {
        agentId,
        runtime: config?.runtime,
        model: config?.model,
        reset_source: "explicit_stop",
        release_cause: "explicit_stop",
        credential_invalid_reason: released.map((each) => each.invalidReason).join(","),
        credential_key_kind: providerLimitCredentialKeyKind(key),
        host: "legacy",
      });
    }
    for (const key of keys) {
      const record = this.lifecycleRecords.getProviderLimit(key, this.clockNow());
      if (!record) continue;
      const released = this.releaseProviderLimit(key, record, "explicit_stop", { exceptAgentId: agentId });
      this.recordDaemonEvent("daemon.agent.runtime_error_delivery_backoff.reset", {
        agentId,
        runtime: config?.runtime,
        model: config?.model,
        reason: record.reason,
        attempts: record.attempts,
        reset_source: "explicit_stop",
        release_cause: "explicit_stop",
        credential_key_kind: providerLimitCredentialKeyKind(key),
        provider_limit_cleared: true,
        shared_live_backoffs_ended: released.liveBackoffsEnded,
        shared_cooldowns_ended: released.cooldownsEnded,
      });
    }
  }

  async stopAgent(agentId: string, { wait = false, silent = false }: { wait?: boolean; silent?: boolean } = {}) {
    const startEpochAtStop = this.lifecycleRecords.startEpoch(agentId);
    // Read before the restart snapshot goes: a closed agent's credential is only on it.
    const configAtStop = this.agents.get(agentId)?.config ?? this.lifecycleRecords.getRestartSnapshot(agentId)?.config;
    this.lifecycleRecords.recordStop(agentId);
    // RFC 070 §6.5: a stop ends a pending warm mark and its timer; an explicit
    // one (also how an agent leaves this computer) forgets everything kept for it.
    if (silent) this.warmRecycle.dropPending(agentId);
    else this.warmRecycle.forget(agentId);
    // Server features: an explicit stop (also how an agent leaves this
    // computer for good) drops the notice base; the agent's next start is the
    // Server's, with the current values.
    if (!silent) {
      this.serverFeaturesNoticeBase.delete(agentId);
      this.startConfigFeaturesGeneration.delete(agentId);
      this.forgetSpecHandback(agentId);
    }
    // RFC 071: a start held for the server capability ends now (no spawn).
    this.capabilityHolds.get(agentId)?.cancel();
    this.cancelQueuedAgentStart(agentId, "stop requested");
    this.lifecycleRecords.deletePendingStartRebind(agentId);
    // Reconciler step 11: a push held for a start ends with an explicit stop
    // (a silent one, the host router moving the agent, keeps it for the OAR start).
    if (!silent) this.configRevisions.forgetHeldPush(agentId);
    this.lifecycleRecords.deleteRestartSnapshot(agentId);
    this.cancelRuntimeErrorProcessRestart(agentId);
    if (!silent) {
      this.resetSpawnFailBackoff(agentId, "suppressed");
      this.resetRuntimeErrorCloseStreak(agentId, "explicit_stop");
      this.lifecycleRecords.deleteResumedEarlyCrashStreak(agentId);
      this.resetStalledReplacementStreak(agentId);
      this.releaseProviderLimitForExplicitStop(agentId, configAtStop);
      this.lastStartFailures.delete(agentId);
      // Reconciler step 12: a person's stop is the way out of a sticky
      // failure (a session reset, an unusable model) and of the 404 count.
      this.lifecycleRecords.exitStreaks.sticky.forget(agentId);
      this.resetRuntimeErrorClassFence(agentId, this.agents.get(agentId), "explicit_stop");
    } else if (!this.agents.has(agentId) && this.isSpawnFailBackoffActive(agentId)) {
      // task #357: a silent stop keeps the backoff so stop/start churn of a
      // live process cannot bypass the cap, but with no process and the
      // restart config just deleted there is nothing the cooldown could
      // restart; the next start is the Server's. Keeping the backoff would
      // leave "active cooldown without restart config", which rejects every
      // later wake of this agent until the cooldown runs out.
      this.resetSpawnFailBackoff(agentId, "suppressed");
    }
    if (this.lifecycleRecords.deleteTerminalFailure(agentId)) {
      this.closeNoProcessResidency(agentId, "suppressed", { negativeEvidenceBucket: "explicit_stop" });
    }
    const ap = this.agents.get(agentId);
    if (!ap) {
      // No process: the residency facts above are gone, so any start-pending
      // delivery buffered under terminal-recovery or cooldown residency would
      // now be an orphan (I4). Explicit stop is a user-driven lifecycle
      // boundary: drop the local buffer (the Server keeps the messages) and
      // prove the manager-wide invariants still hold before returning
      // (task #1102: this exact orphan took a whole machine offline).
      const droppedCount = this.startingInboxes.count(agentId);
      if (droppedCount > 0) {
        this.startingInboxes.cancelStart(agentId);
        this.recordDaemonEvent("daemon.agent.start_pending.dropped_on_stop", {
          agentId,
          dropped_count: droppedCount,
          silent,
        });
      }
      this.assertStartPendingDeliveryInvariants(silent ? "silent-stop-no-process" : "stop-no-process");
      if (!silent) {
        // Task #17: no frame can carry what the tracker still holds for a
        // process that is gone; an explicit stop ends it (and its memory).
        this.turnSummaries.release(agentId);
        logger.info(`[Agent ${agentId}] Stop requested but no running process was found${droppedCount > 0 ? ` (dropped ${droppedCount} pending message(s))` : ""}`);
      }
      return;
    }

    // task #1277: a start still resolving or spawning for this process is
    // cancelled here; the attempt itself discards its result (never commits).
    ap.launchAbort?.abort();
    ap.notifications.clearTimer();
    this.sendIntents.endAll(agentId);
    this.disposeAgentProcessTimers(ap);

    cleanupLaunchProxies(agentId);
    this.revokeManagedRunnerCredential(agentId, ap.config, ap.launchId);
    this.rememberSessionSpec(agentId, ap);
    this.agents.delete(agentId);
    this.idleHolds.forget(agentId);
    this.noteTurnActivity();
    this.recordInboxDroppedOnExit(agentId, ap, silent ? "silent_stop" : "explicit_stop", ap.inbox.splice(0));
    if (!silent) {
      // Activity clientSeq belongs to the ingest generation, not one runtime
      // child. Launchless Stop/Start keeps daemonInstanceId, so resetting here
      // reopens 1 in the same dedup namespace. Preserve it for this manager
      // lifetime; a new manager rotates the daemon generation.
      // CC1 (id-set lifecycle): the per-agent consume-boundary high-water and
      // exact-id dedup set (CL-CC2 visible-state) are never otherwise pruned —
      // without this they grow unbounded across the agent's stop/start churn.
      // This delivery ledger is independent from the activity clientSeq clock
      // above. Only clear it on the explicit user-driven lifecycle boundary.
      // A silent respawn under the SAME launchId must KEEP the set,
      // else a not-yet-boundary-covered set-only id could be re-delivered and
      // miss dedup → re-wakeup (CL-CC2-4 boundary-aware-pruning precondition).
      this.agentVisibleDelivery.clearAgent(agentId);
      // Spawn-fail backoff state: explicit stop = fresh launch = reset counter (otherwise
      // a deliberate user-driven restart sees stale backoff and gets gated). Silent stop
      // preserves to prevent stop/start churn from bypassing the cap (same CC1 reasoning).
      this.resetSpawnFailBackoff(agentId, "suppressed");
      this.resetRuntimeErrorFingerprintFence(agentId, "explicit_stop", ap);
    }
    this.runtimeExitTraceAttrs.set(ap.runtime, {
      stop_source: silent ? "daemon_internal" : "explicit_request",
      stop_wait_requested: wait,
      stop_silent: silent,
    });
    // task #25 / reconciler step 5: every stop escalates. A runtime that
    // ignores SIGTERM, or one whose tool command does, is SIGKILLed with its
    // process tree after the grace. The agent left `agents` above (no new work
    // reaches it), but it is released only once its exit is confirmed: a new
    // start of it waits for that (`exitingRuntimes`), and the stop reports
    // "Stopped" only then. `wait` is kept for callers; every stop now waits.
    const exited = this.stopRuntimeProcess(agentId, ap.runtime, silent ? "silent_stop" : "explicit_stop", {
      reason: silent ? "daemon_internal" : "explicit_request",
      launchId: ap.launchId,
    });
    this.trackExitingRuntime(agentId, ap.runtime, exited);
    await exited;
    if (!silent) {
      // stop() can resolve after a later start has run, queued, or failed.
      // Compare the start generation, not launchId (which can be absent/reused)
      // or current process presence (a failed/idle replacement may be absent).
      if (this.lifecycleRecords.startEpochChanged(agentId, startEpochAtStop)) {
        logger.info(`[Agent ${agentId}] Suppressed stale stop status after replacement start`);
      } else {
        this.sendRuntimeProfileReportFor(agentId, ap.config, ap.sessionId, ap.launchId, "stop");
        // Report status change to server (user-initiated stop)
        this.sendAgentStatus(agentId, "inactive", ap.launchId);
        this.broadcastActivity(agentId, "offline", "Stopped", [], undefined, "stopped");
        logger.info(`[Agent ${agentId}] Stopped by request`);
      }
    }
  }

  /**
   * Reconciler step 5 (invariant 3): the one way this host stops a runtime
   * process, on every path. SIGTERM (the runtime's own shutdown), then after
   * the stop grace a SIGKILL of the whole process tree (RuntimeSession.stop);
   * settles once the exit is observed, or once it is given up as unconfirmed
   * (`daemon.agent.stop.kill_unconfirmed`; the session then reports the exit
   * itself so the agent is released). Never rejects.
   */
  private stopRuntimeProcess(
    agentId: string,
    runtime: RuntimeSession,
    path: AgentStopPath,
    opts: {
      signal?: NodeJS.Signals;
      reason?: string;
      launchId?: string | null;
      turnTreeKill?: RuntimeStopOptions["turnTreeKill"];
      onEscalated?: (escalation: { graceMs: number; treeKilledCount: number }) => void;
    } = {},
  ): Promise<{ escalated: boolean; exitConfirmed: boolean }> {
    const { graceMs, confirmMs } = this.stopKill;
    const outcome = { escalated: false, exitConfirmed: true };
    const attrs = { agentId, launchId: opts.launchId || undefined, path, grace_ms: graceMs };
    const recordUnconfirmed = (pid: number | undefined) => {
      if (!outcome.exitConfirmed) return;
      outcome.exitConfirmed = false;
      this.recordDaemonEvent("daemon.agent.stop.kill_unconfirmed", {
        ...attrs,
        pid,
        confirm_ms: confirmMs,
        subprocess_os_state: probeSubprocessOsState(pid),
      }, "error");
      logger.warn(`[Agent ${agentId}] Runtime pid=${pid ?? "none"} (${path} stop) not seen to exit ${confirmMs}ms after SIGKILL; released anyway`);
    };
    let stopped: Promise<void>;
    try {
      stopped = Promise.resolve(runtime.stop({
        signal: opts.signal ?? "SIGTERM",
        reason: opts.reason,
        forceAfterMs: graceMs,
        confirmAfterMs: confirmMs,
        turnTreeKill: opts.turnTreeKill,
        onEscalated: ({ graceMs: escalatedAfterMs, treeKilledCount }) => {
          outcome.escalated = true;
          this.recordDaemonEvent("daemon.agent.stop.escalated", {
            ...attrs,
            grace_ms: escalatedAfterMs,
            tree_killed_count: treeKilledCount,
            pid_present: typeof runtime.pid === "number",
          }, "error");
          logger.warn(`[Agent ${agentId}] Runtime did not exit ${escalatedAfterMs}ms after SIGTERM (${path} stop); SIGKILLed its process tree (${treeKilledCount} process(es))`);
          opts.onEscalated?.({ graceMs: escalatedAfterMs, treeKilledCount });
        },
        onKillUnconfirmed: ({ pid }) => recordUnconfirmed(pid),
      })).catch((err) => {
        logger.warn(`[Agent ${agentId}] ${path} stop failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    } catch (err) {
      logger.warn(`[Agent ${agentId}] ${path} stop failed: ${err instanceof Error ? err.message : String(err)}`);
      stopped = Promise.resolve();
    }
    // A backstop for a session whose stop never settles (an in-process
    // session hung in its own abort): the agent is released all the same.
    return new Promise((resolve) => {
      const backstop = setTimeout(() => {
        recordUnconfirmed(runtime.pid);
        resolve(outcome);
      }, graceMs + 2 * confirmMs);
      void stopped.then(() => {
        clearTimeout(backstop);
        resolve(outcome);
      });
    });
  }

  /** Reconciler step 5: a runtime that left `agents` stays tracked until `exited` settles. */
  private trackExitingRuntime(agentId: string, runtime: RuntimeSession, exited: Promise<unknown>): void {
    const entry = this.exitingRuntimes.get(agentId) ?? { runtimes: new Set<RuntimeSession>(), exited: Promise.resolve() };
    entry.runtimes.add(runtime);
    entry.exited = Promise.all([entry.exited, exited]).then(() => {});
    this.exitingRuntimes.set(agentId, entry);
    void exited.then(() => {
      entry.runtimes.delete(runtime);
      if (entry.runtimes.size === 0 && this.exitingRuntimes.get(agentId) === entry) this.exitingRuntimes.delete(agentId);
    });
  }

  /**
   * Resolves once no stopped runtime of the agent is still exiting (at once
   * if none is), or once `signal` aborts. A start on either host waits here
   * first: two processes never run one agent.
   */
  runtimeExited(agentId: string, signal?: AbortSignal): Promise<void> {
    const exiting = this.whenRuntimeExited(agentId);
    if (!exiting || !signal) return exiting ?? Promise.resolve();
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => { signal.removeEventListener("abort", done); resolve(); };
      signal.addEventListener("abort", done, { once: true });
      void exiting.then(done);
    });
  }

  /** The orphan sweep (while it runs), then the agent's exiting runtimes. */
  private whenRuntimeExited(agentId: string): Promise<void> | null {
    const sweep = this.orphanSweepPending ? this.orphanSweep : null;
    const exiting = this.exitingRuntimes.get(agentId)?.exited ?? null;
    if (sweep && exiting) return Promise.all([sweep, exiting]).then(() => {});
    return sweep ?? exiting;
  }

  /** A stopped runtime of the agent has not been seen to exit yet. */
  hasExitingRuntime(agentId: string): boolean {
    return this.exitingRuntimes.has(agentId);
  }

  /**
   * Reconciler step 5: the process is being stopped (its SIGTERM is out, the
   * grace is running). Nothing is written to it; deliveries wait in its inbox
   * and its close hands them to the next process.
   */
  private runtimeStopping(ap: AgentProcess): boolean {
    return ap.gatedSteering.expectedTerminationReason !== null || ap.exit.kind !== "live";
  }

  private beginTrackedMentionDelivery(
    agentId: string,
    message: AgentMessage,
    ap: AgentProcess | undefined,
    context: DeliveryTraceContext,
  ): "untracked" | "accepted" | "duplicate_pending" | "duplicate_drained" | "rejected" {
    const tracked = context.mentionDelivery;
    if (!tracked) return "untracked";
    const reject = (code: MentionDeliveryTerminalErrorCode) => {
      context.onMentionTerminalError?.(code);
      return "rejected" as const;
    };
    if (
      !context.deliveryId
      || context.deliveryId !== tracked.occurrenceId
      || tracked.messageId !== message.message_id
    ) {
      return reject("INSTRUMENT_FAILED");
    }
    // task #9: a per_turn runtime (cursor, gemini, copilot) has no process
    // between turns; its idle restart snapshot carries the same identity and
    // the delivery restarts it, so the mention is tracked against that.
    const identity = ap ?? this.noProcessMentionIdentity(agentId);
    if (!identity?.launchId || !identity.sessionId) return reject("IDENTITY_UNKNOWN");
    if (identity.launchId !== tracked.launchId || identity.sessionId !== tracked.sessionId) {
      return reject("IDENTITY_DRIFT");
    }
    const existing = this.trackedMentionDeliveries.get(tracked.occurrenceId);
    if (existing) {
      existing.context = context;
      if (existing.agentId !== agentId || existing.messageId !== tracked.messageId) {
        return reject("INSTRUMENT_FAILED");
      }
      if (existing.state === "drained") return "duplicate_drained";
      // task #9 follow-up: pending, but no process, start or start buffer holds
      // it any more (a continuation restart failed and dropped its input). The
      // redelivery is routed again instead of coalescing into a dead entry.
      if (
        existing.state === "pending"
        && !ap
        && !this.agentStarts.hasStarting(agentId)
        && !this.agentStarts.hasQueued(agentId)
        && !this.startingInboxes.has(agentId)
      ) {
        existing.message = message;
        return "accepted";
      }
      context.onMentionTransition?.("daemon_pending", "coalesced");
      return "duplicate_pending";
    }
    this.trackedMentionDeliveries.set(tracked.occurrenceId, {
      agentId,
      messageId: tracked.messageId,
      message,
      state: "received",
      context,
    });
    context.onMentionTransition?.("daemon_received", "accepted");
    return "accepted";
  }

  /** task #9: pending tracked mentions this process's first input names were told to it. */
  private markTrackedMentionsToldAtStart(agentId: string, processInstanceId: string, messages: readonly AgentMessage[]): void {
    if (messages.length === 0) return;
    const ids = new Set(messages.map((message) => message.message_id));
    for (const tracked of this.trackedMentionDeliveries.values()) {
      if (tracked.agentId === agentId && tracked.state === "pending" && ids.has(tracked.messageId)) {
        tracked.toldProcessInstanceId = processInstanceId;
      }
    }
  }

  /** The identity a delivery will restart an idle agent with, or null when it would not restart it. */
  private noProcessMentionIdentity(agentId: string): { launchId: string | null; sessionId: string | null } | null {
    const restarting = this.restartingIdentities.get(agentId);
    if (restarting) return restarting;
    const lifecycleRecord = this.agentLifecycleRecord(agentId);
    if (lifecycleRecord?.kind !== "idle" && lifecycleRecord?.kind !== "cooldown") return null;
    return { launchId: lifecycleRecord.restartSnapshot.launchId, sessionId: lifecycleRecord.restartSnapshot.sessionId };
  }

  /** A tracked mention the delivery could not hand to any process: terminal, and released. */
  private failTrackedMention(context: DeliveryTraceContext, code: MentionDeliveryTerminalErrorCode): void {
    const occurrenceId = context.mentionDelivery?.occurrenceId;
    if (!occurrenceId || !this.trackedMentionDeliveries.has(occurrenceId)) return;
    this.trackedMentionDeliveries.delete(occurrenceId);
    context.onMentionTerminalError?.(code);
  }

  private markTrackedMentionPending(context: DeliveryTraceContext, outcome: "accepted" | "coalesced" = "accepted"): void {
    const occurrenceId = context.mentionDelivery?.occurrenceId;
    if (!occurrenceId) return;
    const tracked = this.trackedMentionDeliveries.get(occurrenceId);
    if (!tracked) {
      context.onMentionTerminalError?.("INSTRUMENT_FAILED");
      return;
    }
    tracked.state = "pending";
    tracked.context = context;
    context.onMentionTransition?.("daemon_pending", outcome);
  }

  private completeTrackedMentionDelivery(context: DeliveryTraceContext): void {
    const occurrenceId = context.mentionDelivery?.occurrenceId;
    if (!occurrenceId) return;
    const tracked = this.trackedMentionDeliveries.get(occurrenceId);
    if (!tracked) {
      context.onMentionTerminalError?.("INSTRUMENT_FAILED");
      return;
    }
    if (tracked.state !== "drained") {
      tracked.state = "drained";
      tracked.context = context;
      context.onMentionTransition?.("daemon_drained", "accepted");
    }
    context.onMentionAck?.();
  }

  /** A compaction or review boundary buffers busy notices until it ends. */
  private busyNoticeHeldAtBoundary(ap: AgentProcess): boolean {
    return this.compactionGateClosed(ap) || ap.gatedSteering.reviewing === true;
  }

  /** The agent read these tracked mentions (check/read made them model-seen): ACK them now, not at the turn end. */
  private completeTrackedMentionsSeenByModel(agentId: string): void {
    for (const tracked of [...this.trackedMentionDeliveries.values()]) {
      if (tracked.agentId !== agentId || tracked.state !== "pending") continue;
      if (!this.isVisibleMessageModelSeen(agentId, formatAgentMessageVisibleTarget(tracked.message), tracked.message)) continue;
      this.completeTrackedMentionDelivery(tracked.context);
    }
  }

  private completePendingTrackedMentions(agentId: string): void {
    for (const tracked of this.trackedMentionDeliveries.values()) {
      if (tracked.agentId !== agentId || tracked.state !== "pending") continue;
      this.completeTrackedMentionDelivery(tracked.context);
    }
  }

  /**
   * task #285: a busy tracked mention waits for the turn boundary. When that
   * boundary writes no fresh notice, the occurrence must still end here —
   * otherwise it stays pending, the agent goes idle with nothing to wake it,
   * and every server re-send of the occurrence lands on `duplicate_pending`
   * and is answered with silence, forever.
   */
  private settleUndeliveredTrackedMentionsAtTurnEnd(agentId: string, ap: AgentProcess): void {
    for (const [occurrenceId, tracked] of [...this.trackedMentionDeliveries.entries()]) {
      if (tracked.agentId !== agentId || tracked.state !== "pending") continue;
      const queued = ap.inbox.find((message) => message.message_id === tracked.messageId);
      // task #9: named in this process's first input → told. Still queued on a
      // per_turn runtime but not yet told → the restart after this turn carries
      // it, and that process's turn end settles it.
      if (tracked.toldProcessInstanceId === ap.processInstanceId) {
        this.completeTrackedMentionDelivery(tracked.context);
        continue;
      }
      if (queued && ap.driver.lifecycle.kind === "per_turn") continue;
      // Held for an invalid credential, or by a drain: it goes (and is settled) after the release.
      if (queued && (this.credentialInvalidHold(agentId, ap.config) || this.drain.holds(agentId))) continue;
      // Still queued: told only if its notice reached this session. Gone from the inbox: told
      // only if the runtime consumed it (check/read record it model-seen). A server purge
      // (e.g. membership removed) also removes the row, and that must not read as delivered.
      const toldRuntime = queued
        ? ap.notifications.hasContributedMessage(queued, ap.sessionId)
        : this.isVisibleMessageModelSeen(agentId, formatAgentMessageVisibleTarget(tracked.message), tracked.message);
      if (toldRuntime) {
        this.completeTrackedMentionDelivery(tracked.context);
      } else {
        tracked.context.onMentionTerminalError?.("DELIVERY_REJECTED");
        // Terminal: release the entry so later turn ends do not report it again.
        this.trackedMentionDeliveries.delete(occurrenceId);
      }
    }
  }

  private holdServerContext(agentId: string, message: AgentMessage): boolean {
    const id = message.message_id ?? "server-context";
    const changed = this.serverContext.hold(agentId, { id, body: message.content });
    this.recordDaemonEvent("daemon.agent.server_context.held", {
      agentId,
      context_id: id,
      changed,
      process_present: this.agents.has(agentId),
    });
    return true;
  }

  /**
   * Every input written to a running runtime goes through here (task #26):
   * held server context the process or its session has not had yet rides
   * ahead of it. A start's first prompt does the same in startAgent.
   */
  private sendRuntimeInput(
    agentId: string,
    ap: AgentProcess,
    input: { mode: "idle" | "busy"; text: string; sessionId?: string | null; origin?: RuntimeTurnOrigin | null },
    source: string,
  ): RuntimeSendResult {
    // Reconciler step 5: nothing is written to a process being stopped; the
    // caller re-queues what it was sending (as for any refused send).
    if (this.runtimeStopping(ap)) return { ok: false, reason: "closed" };
    // Any other input opens real work: its end runs the idle hooks again.
    if (source !== "turn_end_compaction" && ap.turnEndCompaction) ap.turnEndCompaction.skipNextIdleHooks = false;
    const reach = { processInstanceId: ap.processInstanceId, sessionId: input.sessionId };
    const context = this.serverContext.pending(agentId, reach);
    const result = this.runtimeProcessBindingFence.send(agentId, ap, context ? { ...input, text: formatServerContextPrefix(context.body) + input.text } : input, source);
    if (result.ok) {
      this.noteServerContextWritten(agentId, reach, context, source);
    }
    return result;
  }

  private noteServerContextWritten(agentId: string, reach: ServerContextReach, context: ServerContext | null, source: string): void {
    this.serverContext.noteWritten(agentId, reach, context);
    if (!context) return;
    this.recordDaemonEvent("daemon.agent.server_context.written", {
      agentId,
      context_id: context.id,
      source,
      process_instance_id: reach.processInstanceId,
      session_present: Boolean(reach.sessionId),
    });
  }

  deliverMessage(agentId: string, message: AgentMessage, traceContext: DeliveryTraceContext = {}): boolean | Promise<boolean> {
    // task #26: server context about the agent's own setup is held and rides
    // ahead of its next input; it never becomes an inbox row or a wake.
    if (isServerContextMessage(message)) return this.holdServerContext(agentId, message);
    if (traceContext.deliveryId || traceContext.transient) {
      this.deliveryTraceContexts.set(message, traceContext);
    }
    if (!this.deliveryReceivedAtMs.has(message)) this.deliveryReceivedAtMs.set(message, this.clockNow());
    const transientDelivery = this.isTransientDelivery(message);
    // Reconciler step 12: a sticky failure only the runtime's stderr named
    // (no error event acted on it) is acted on before anything is routed to
    // its process: the delivery then meets what follows (no process, so the
    // server's start; or the new session's start).
    const stickyProcess = this.agents.get(agentId);
    const latentSticky = stickyProcess ? classifyStickyFailure(stickyProcess) : null;
    if (stickyProcess && latentSticky) {
      this.actOnStickyFailure(agentId, stickyProcess, latentSticky, terminalFailureFromRawText("sticky_runtime_error", stickyProcess.lastRuntimeError || latentSticky.detail));
    }
    const ap = this.agents.get(agentId);
    if (this.drain.holds(agentId) && transientDelivery && ap && !this.runtimeStopping(ap)) {
      // Reconciler step 13: a transient delivery has no inbox row; the drain
      // keeps it and routes it again at its end.
      this.drainHeldTransients.push({ agentId, message, traceContext });
      // RFC 070 §6.5: it reaches this session at the drain's end; the session is kept for it.
      this.cancelWarmRecycle(agentId, ap, { reason: "delivery", senderKind: warmRecycleSenderKind(message.sender_type) });
      this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
        outcome: "transient_held_for_drain",
        accepted: true,
        process_present: true,
        runtime: ap.config.runtime,
        launchId: ap.launchId || undefined,
      }));
      return true;
    }
    const trackedBegin = this.beginTrackedMentionDelivery(agentId, message, ap, traceContext);
    if (trackedBegin === "rejected") return false;
    if (trackedBegin === "duplicate_pending") return true;
    if (trackedBegin === "duplicate_drained") {
      traceContext.onMentionAck?.();
      return true;
    }

    // Delivery-side visible-boundary gate (methodology run 1, seam ①②). A seq the
    // model has ALREADY consumed (wake/stdin/check/read/held/preflight) must not be
    // re-injected through ANY delivery branch on a server reconnect re-push /
    // cross-replica mirror. deliverMessage previously had NO boundary gate, so a
    // re-delivered already-consumed seq re-entered the inbox AND re-incremented the
    // user-visible notification counter (re-notify). Placed at ENTRY so it covers
    // every push path (during-start startingInbox, sticky-queued, idle/busy inbox,
    // auto-restart-from-idle) BEFORE any inbox push / notifications.add() / restart
    // (Kai cut-point). Non-transient only; the authoritative consumed boundary is
    // the single source (DG-LIVE-EVIDENCE: live gating derives from the authoritative
    // consumed-boundary, not a re-pushed copy). seq<=boundary → drop.
    if (!transientDelivery && this.isVisibleMessageModelSeen(agentId, formatAgentMessageVisibleTarget(message), message)) {
      this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
        outcome: "dropped_already_consumed",
        accepted: true,
        process_present: Boolean(this.agents.get(agentId)),
      }));
      if (trackedBegin === "accepted") this.completeTrackedMentionDelivery(traceContext);
      return true;
    }

    // RFC 070 §6.5: a delivery inside the quiet period keeps the session.
    if (ap) this.cancelWarmRecycle(agentId, ap, { reason: "delivery", senderKind: warmRecycleSenderKind(message.sender_type) });

    if (!ap) {
      // task #9: a tracked mention accepted here reaches a process only through
      // the start it joins; it is settled at that process's first turn end.
      if (trackedBegin === "accepted") this.markTrackedMentionPending(traceContext);
      if (this.agentStarts.hasStarting(agentId) || this.agentStarts.hasQueued(agentId)) {
        if (transientDelivery) {
          const queuedStart = this.agentStarts.getQueued(agentId);
          this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
            outcome: "transient_dropped_during_start",
            accepted: true,
            process_present: false,
            startup_pending: true,
            launchId: queuedStart?.launchId,
          }));
          return true;
        }
        const queuedStart = this.agentStarts.getQueued(agentId);
        const startingInboxCount = this.startingInboxes.bufferDuringStart(agentId, message);
        this.assertStartPendingDeliveryInvariants("delivery-during-start");
        this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
          outcome: "queued_during_start",
          accepted: true,
          process_present: false,
          startup_pending: true,
          starting_inbox_count: startingInboxCount,
          launchId: queuedStart?.launchId,
        }));
        return true;
      }

      const lifecycleRecord = this.agentLifecycleRecord(agentId);
      if (lifecycleRecord?.kind === "terminal") {
        const { terminalFailure } = lifecycleRecord;
        if (transientDelivery) {
          this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
            outcome: "transient_dropped_terminal_runtime_error_no_process",
            accepted: true,
            process_present: false,
            cached_idle_config_present: false,
            terminal_runtime_failure: true,
            launchId: terminalFailure.launchId || undefined,
          }));
          return true;
        }
        const startingInboxCount = this.startingInboxes.bufferDuringStart(agentId, message);
        this.assertStartPendingDeliveryInvariants("delivery-terminal-runtime-error");
        this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
          outcome: "queued_terminal_runtime_error_no_process",
          accepted: true,
          process_present: false,
          cached_idle_config_present: false,
          terminal_runtime_failure: true,
          starting_inbox_count: startingInboxCount,
          launchId: terminalFailure.launchId || undefined,
        }));
        this.sendAgentStatus(agentId, "inactive", terminalFailure.launchId);
        this.broadcastActivity(agentId, "error", terminalFailure.detail, [], terminalFailure.launchId, "runtime_error");
        return true;
      }

      // Reconciler step 12 (row C9): the daemon does not start the agent
      // itself on a runtime and model the runtime said it cannot use; the
      // delivery finds no process, and the server decides the next start.
      const unusableModelRestart = (lifecycleRecord?.kind === "idle" || lifecycleRecord?.kind === "cooldown")
        && this.lifecycleRecords.exitStreaks.sticky.isUnusableModel(agentId, lifecycleRecord.restartSnapshot.config.runtime || "claude", lifecycleRecord.restartSnapshot.config.model);
      if (unusableModelRestart) {
        this.cancelRuntimeErrorProcessRestart(agentId);
        this.lifecycleRecords.deleteRestartSnapshot(agentId);
        this.resetSpawnFailBackoff(agentId, "terminal");
        this.recordDaemonEvent("daemon.agent.restart.refused_unusable_model", { agentId, runtime: lifecycleRecord.restartSnapshot.config.runtime });
      }
      // Process not running — auto-restart if we have a cached config (normal exit)
      if (!unusableModelRestart && (lifecycleRecord?.kind === "idle" || lifecycleRecord?.kind === "cooldown")) {
        const cached = lifecycleRecord.restartSnapshot;
        const driver = this.driverResolver(cached.config.runtime || "claude");
        if (!transientDelivery && this.shouldDeferWakeMessage(agentId, driver, message)) {
          this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
            outcome: "deferred_wake_message",
            accepted: true,
            process_present: false,
            cached_idle_config_present: true,
            runtime: cached.config.runtime,
            session_id_present: Boolean(cached.sessionId),
            launchId: cached.launchId || undefined,
          }));
          return true;
        }
        logger.info(`[Agent ${agentId}] Starting from idle state for new message`);
        // SPAWN-FAIL BACKOFF gate: if previous spawn attempts exceeded the threshold and
        // we're inside an active cooldown window, defer this spawn — leave the message in
        // startingInboxes so it is delivered when cooldown expires + next msg arrives or
        // the next successful spawn drains. NEVER drops the message; only delays the spawn.
        // Task #355: re-read the clock once here and use that single instant for
        // the buffer, the invariant repair and the residency entry. If the
        // cooldown has already expired, fall through and start now instead.
        const cooldownNowMs = this.clockNow();
        if (lifecycleRecord.kind === "cooldown" && lifecycleRecord.spawnFailBackoff.untilMs > cooldownNowMs) {
          const state = lifecycleRecord.spawnFailBackoff;
          const startingInboxCount = this.withClockFrozen(cooldownNowMs, () => {
            const count = this.startingInboxes.bufferDuringStart(agentId, message);
            this.assertStartPendingDeliveryInvariants("delivery-spawn-fail-cooldown");
            this.enterSpawnFailCooldownResidency(agentId, cached, state.untilMs, "idle_auto_restart", "spawn_fail_cooldown_active");
            return count;
          });
          this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
            outcome: "spawn_fail_cooldown_active",
            accepted: true,
            process_present: false,
            cached_idle_config_present: true,
            runtime: cached.config.runtime,
            session_id_present: Boolean(cached.sessionId),
            launchId: cached.launchId || undefined,
            spawn_fail_attempts: state.attempts,
            spawn_fail_until_ms: state.untilMs,
            starting_inbox_count: startingInboxCount,
          }));
          return true;
        }
        const restartFromPendingInbox = !transientDelivery && this.startingInboxes.has(agentId);
        if (restartFromPendingInbox) {
          this.startingInboxes.bufferDuringStart(agentId, message);
        }
        this.cancelRuntimeErrorProcessRestart(agentId);
        this.lifecycleRecords.deleteRestartSnapshot(agentId);
        this.restartingIdentities.set(agentId, { launchId: cached.launchId, sessionId: cached.sessionId });
        const restartStopEpoch = this.lifecycleRecords.stopEpoch(agentId);
        this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
          outcome: "auto_restart_from_idle",
          accepted: true,
          process_present: false,
          cached_idle_config_present: true,
          runtime: cached.config.runtime,
          session_id_present: Boolean(cached.sessionId),
          launchId: cached.launchId || undefined,
        }));
        // The restarted process and the start-queue pump timer outlive this
        // delivery, so their later events must not inherit the delivery span
        // that happened to trigger the restart.
        return runWithoutActiveSpan(() => this.startAgent(
          agentId,
          cached.config,
          restartFromPendingInbox ? undefined : message,
          undefined,
          undefined,
          cached.launchId || undefined,
          restartFromPendingInbox ? false : transientDelivery,
        )).then(() => {
          this.restartingIdentities.delete(agentId);
          // Successful spawn resets backoff (single success → counter zero, no half-state).
          this.resetSpawnFailBackoff(agentId);
          this.assertStartPendingDeliveryInvariants("idle-auto-restart-success");
          return true;
        }, (err) => {
          this.restartingIdentities.delete(agentId);
          if (trackedBegin === "accepted") this.failTrackedMention(traceContext, "DELIVERY_REJECTED");
          logger.error(`[Agent ${agentId}] Failed to auto-restart`, err);
          if (this.suppressFailedRestartAfterStop(agentId, restartStopEpoch, "idle-auto-restart")) {
            return false;
          }
          if (this.reportRunnerCredentialMintFailure(agentId, err, cached.launchId, "idle_auto_restart")) {
            this.lifecycleRecords.setRestartSnapshot(agentId, cached);
            // Credential-mint failure has its own user-visible handling; still count for backoff
            // so a stream of mint-failures doesn't keep spawning.
            const report = this.recordSpawnFailure(agentId, "runner_credential_mint");
            this.assertStartPendingDeliveryInvariants("idle-auto-restart-runner-credential-mint-failure");
            if (report.backoffActive) {
              this.enterSpawnFailCooldownResidency(agentId, cached, report.untilMs, "idle_auto_restart", "runner_credential_mint");
            }
            this.recordDaemonEvent("daemon.agent.spawn.fail_backoff", {
              agentId,
              source: "idle_auto_restart",
              reason: "runner_credential_mint",
              attempts: report.attempts,
              cooldown_active: report.backoffActive,
              until_ms: report.untilMs,
            });
            return false;
          }
          this.lifecycleRecords.setRestartSnapshot(agentId, cached);
          const report = this.recordSpawnFailure(agentId, "spawn_error");
          if (this.stopLocalRestartAfterFailure(agentId, cached, err, report.attempts, "idle_auto_restart")) {
            this.assertStartPendingDeliveryInvariants("idle-auto-restart-stopped");
            return false;
          }
          this.assertStartPendingDeliveryInvariants("idle-auto-restart-spawn-failure");
          if (report.backoffActive) {
            this.enterSpawnFailCooldownResidency(agentId, cached, report.untilMs, "idle_auto_restart", "spawn_error");
          }
          this.recordDaemonEvent("daemon.agent.spawn.fail_backoff", {
            agentId,
            source: "idle_auto_restart",
            reason: "spawn_error",
            attempts: report.attempts,
            cooldown_active: report.backoffActive,
            until_ms: report.untilMs,
          });
          return false;
        });
      }

      if (!transientDelivery && (this.agentStarts.hasQueued(agentId) || this.agentStarts.hasStarting(agentId))) {
        const startingInboxCount = this.startingInboxes.bufferDuringStart(agentId, message);
        this.assertStartPendingDeliveryInvariants("delivery-queued-or-starting");
        this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
          outcome: this.agentStarts.hasStarting(agentId) ? "queued_for_starting_process" : "queued_for_queued_start",
          accepted: true,
          process_present: false,
          cached_idle_config_present: false,
          starting_inbox_count: startingInboxCount,
        }));
        return true;
      }

      logger.warn(`[Agent ${agentId}] Delivery received but no running process or cached idle config exists`);
      if (transientDelivery) {
        this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
          outcome: "transient_dropped_no_process",
          accepted: true,
          process_present: false,
          cached_idle_config_present: false,
        }));
        return true;
      }
      this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
        outcome: "rejected_no_process",
        accepted: false,
        process_present: false,
        cached_idle_config_present: false,
      }), "error");
      traceContext.onRejectedNoProcess?.();
      const lastStartFailure = this.lastStartFailures.get(agentId);
      if (lastStartFailure) {
        // Keep showing why the agent is not running, not a bare "restart required".
        this.sendAgentStatus(agentId, "inactive", lastStartFailure.launchId);
        this.sendStartFailureActivity(agentId, lastStartFailure);
      } else if (this.specHandbacks.awaitingStart(agentId)) {
        // Reconciler step 11c: released for a new runtime, host or session;
        // this refusal is how the server's start comes. A start, not an error
        // that asks for a restart. Step 11d: only until the handback's
        // deadline; a start that has not come by then may never come (a lost
        // refusal, a replica switch), so the refusal after it offers Retry.
        this.sendAgentStatus(agentId, "inactive", null);
        this.broadcastActivity(agentId, "working", "Starting with the new runtime config\u2026", [], undefined, "starting");
        // Step 11d: if no start (and no further refusal) comes by the
        // deadline, the agent must not show "Starting" for ever.
        this.specHandbacks.armDeadline(agentId);
      } else {
        this.sendAgentStatus(agentId, "inactive", null);
        this.broadcastActivity(agentId, "offline", "Process unavailable; restart required", [], undefined, "runtime_unavailable");
      }
      return false;
    }

    this.busyDelivery.reconcile(agentId, ap, "delivery_route");
    const isIdle = this.isApmIdle(ap);

    // Reconciler step 5: a process being stopped (SIGTERM out, the grace
    // running) is never written to. The delivery waits in its inbox; the
    // process's close hands the inbox on (the restart it triggers, or the
    // next wake), as for any message queued at an exit.
    if (this.runtimeStopping(ap)) {
      const stoppingAttrs = {
        accepted: true,
        process_present: true,
        runtime: ap.config.runtime,
        launchId: ap.launchId || undefined,
        stop_reason: ap.gatedSteering.expectedTerminationReason ?? "exited",
      };
      if (transientDelivery) {
        this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
          outcome: "transient_dropped_while_stopping",
          ...stoppingAttrs,
        }));
        return true;
      }
      const queued = queueAgentInboxMessage(ap, message);
      if (trackedBegin === "accepted") this.markTrackedMentionPending(traceContext, queued.duplicate ? "coalesced" : "accepted");
      this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
        outcome: "queued_while_stopping",
        ...stoppingAttrs,
        inbox_count: queued.inboxCount,
        duplicate_pending_delivery: queued.duplicate,
      }));
      return true;
    }

    if (!transientDelivery && this.drain.holds(agentId)) {
      // Reconciler step 13: held in the inbox (acked: custody, as for an
      // invalid credential), never told to the session while the drain
      // runs; the agent can still read it (`raft message check`), which
      // takes it out. The end of the drain flushes what is left.
      const queued = queueAgentInboxMessage(ap, message);
      if (trackedBegin === "accepted") this.markTrackedMentionPending(traceContext, queued.duplicate ? "coalesced" : "accepted");
      this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
        outcome: "held_for_drain",
        accepted: true,
        process_present: true,
        runtime: ap.config.runtime,
        launchId: ap.launchId || undefined,
        is_idle: isIdle,
        inbox_count: queued.inboxCount,
        duplicate_pending_delivery: queued.duplicate,
      }));
      return true;
    }

    if (trackedBegin === "accepted" && !isIdle) {
      if (!ap.driver.supportsStdinNotification && ap.driver.lifecycle.kind === "per_turn") {
        // task #9: a per_turn runtime takes no input mid-turn. The mention waits
        // in the inbox; the restart after this turn's exit carries it, and it
        // is settled at that process's turn end.
        const queued = queueAgentInboxMessage(ap, message);
        this.markTrackedMentionPending(traceContext, queued.duplicate ? "coalesced" : "accepted");
        this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
          outcome: queued.duplicate ? "coalesced_busy_mention" : "queued_busy_mention",
          accepted: true,
          process_present: true,
          runtime: ap.config.runtime,
        }));
        return true;
      }
      if (!ap.driver.supportsStdinNotification || !ap.sessionId) {
        this.failTrackedMention(traceContext, "UNSUPPORTED_DELIVERY_PATH");
        return false;
      }
      if (!this.canDeliverToRuntimeSession(ap)) {
        // A fresh session that is not yet resumable (Claude: until its first
        // turn ends) holds the mention as it holds any message: in the inbox,
        // written by the session-ready retry or at the turn's end, which
        // settles it. Refusing it here dropped it for good: nothing redelivers
        // a refused delivery (Bencher, under load; Tenny P1).
        const queued = queueAgentInboxMessage(ap, message);
        this.markTrackedMentionPending(traceContext, queued.duplicate ? "coalesced" : "accepted");
        const retryScheduled = this.scheduleSessionReadyDeliveryRetry(agentId, ap, "queued_before_session_ready");
        this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
          outcome: "queued_before_session_ready_mention",
          accepted: true,
          process_present: true,
          runtime: ap.config.runtime,
          session_id_present: true,
          session_ready_for_delivery: false,
          launchId: ap.launchId || undefined,
          is_idle: isIdle,
          inbox_count: queued.inboxCount,
          duplicate_pending_delivery: queued.duplicate,
          session_ready_delivery_retry_scheduled: retryScheduled || ap.sessionReadyDeliveryRetry.kind === "scheduled",
        }));
        return true;
      }
      const queued = queueAgentInboxMessage(ap, message);
      ap.notifications.add();
      // A busy tracked mention gets the same mid-turn notice as any message
      // (no new turn, no wait for this one to end), unless a compaction or
      // review boundary is holding notices. It is ACKed when the agent reads
      // it (consumeVisibleMessages), else at the turn end as before.
      if (this.busyNoticeHeldAtBoundary(ap)) {
        ap.notifications.clearTimer();
      } else if (!ap.notifications.hasTimer) {
        this.scheduleStdinNotification(agentId, ap, STDIN_NOTIFICATION_INITIAL_DELAY_MS);
      }
      this.markTrackedMentionPending(traceContext, queued.duplicate ? "coalesced" : "accepted");
      this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
        outcome: queued.duplicate ? "coalesced_busy_mention" : "queued_busy_mention",
        accepted: true,
        process_present: true,
        runtime: ap.config.runtime,
        session_id_present: true,
        launchId: ap.launchId || undefined,
        inbox_count: queued.inboxCount,
        duplicate_pending_delivery: queued.duplicate,
        pending_notification_count: ap.notifications.pendingCount,
        notification_timer_present: ap.notifications.hasTimer,
      }));
      return true;
    }

    if (!transientDelivery && this.shouldDeferWakeMessage(agentId, ap.driver, message)) {
      this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
        outcome: "deferred_wake_message",
        accepted: true,
        process_present: true,
        runtime: ap.config.runtime,
        session_id_present: Boolean(ap.sessionId),
        launchId: ap.launchId || undefined,
        is_idle: isIdle,
        inbox_count: ap.inbox.length,
      }));
      if (trackedBegin === "accepted") {
        this.failTrackedMention(traceContext, "UNSUPPORTED_DELIVERY_PATH");
        return false;
      }
      return true;
    }

    // #proj-raft-computer:#46 (reconciler step 4a): the agent's credential is
    // invalid. The delivery is held in the inbox (a tracked mention stays
    // pending) until the credential changes, a turn on it produces model
    // output, or a person stops the agent; then it goes to this process. An
    // autonomous wake is dropped: it would only hit the same rejection.
    const credentialInvalid = this.credentialInvalidHold(agentId, ap.config);
    if (credentialInvalid) {
      const invalidAttrs = {
        accepted: true,
        process_present: true,
        runtime: ap.config.runtime,
        session_id_present: Boolean(ap.sessionId),
        launchId: ap.launchId || undefined,
        is_idle: isIdle,
        credential_invalid_reason: credentialInvalid.invalidReason,
        credential_key_kind: providerLimitCredentialKeyKind(providerLimitCredentialKey(agentId, ap.config)),
        host: "legacy",
      };
      if (transientDelivery) {
        this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
          outcome: "transient_dropped_credential_invalid",
          ...invalidAttrs,
        }));
        return true;
      }
      const queued = queueAgentInboxMessage(ap, message);
      if (trackedBegin === "accepted") this.markTrackedMentionPending(traceContext, queued.duplicate ? "coalesced" : "accepted");
      this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
        outcome: "queued_credential_invalid",
        ...invalidAttrs,
        inbox_count: queued.inboxCount,
        duplicate_pending_delivery: queued.duplicate,
      }));
      return true;
    }

    if (trackedBegin === "accepted" && this.runtimeErrorDeliveryBackoffRemainingMs(ap) > 0) {
      // Terminal for this occurrence, so it is released here too: a tracked
      // entry left `received` (never queued, never told) read as an open
      // mention, so the agent idle in its backoff was never idle (a drain
      // waited until the process was killed, #proj-raft-computer:#62), and
      // nothing else ever removed it (the turn-end settle only takes `pending`).
      this.failTrackedMention(
        traceContext,
        ap.runtimeErrorDeliveryBackoff.reason === "rate_limited" ? "QUOTA_LIMITED" : "DELIVERY_REJECTED",
      );
      return false;
    }
    if (!transientDelivery && this.queueDeliveryForRuntimeErrorBackoff(agentId, ap, message)) {
      return true;
    }

    if (isIdle && ap.driver.supportsStdinNotification && this.canDeliverToRuntimeSession(ap)) {
      // Agent's turn is complete and process is waiting for stdin input.
      // Send a content-free Inbox update to start a new turn; message bodies
      // stay in the daemon-local inbox until explicit check/read consumption.
      if (transientDelivery) {
        const exposeTransient = () => {
          this.commitApmIdleState(agentId, ap, false);
          this.startRuntimeTrace(agentId, ap, "stdin-idle-delivery", [message]);
          const stdinAccepted = this.deliverMessagesViaStdin(
            agentId,
            ap,
            [message],
            "idle",
            { transient: true },
          );
          this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
            outcome: "stdin_idle_transient_delivery",
            accepted: true,
            process_present: true,
            runtime: ap.config.runtime,
            session_id_present: true,
            session_ready_for_delivery: true,
            launchId: ap.launchId || undefined,
            stdin_delivery_accepted: stdinAccepted,
            delivered_messages_count: 1,
            inbox_count: ap.inbox.length,
          }));
          return true;
        };
        return exposeTransient();
      }
      ap.notifications.pruneContributedToPending(ap.inbox, ap.sessionId);
      const noticeFingerprint = computeInboxNoticeFingerprint([message]);
      const messageAlreadyPending = noticeFingerprint.length > 0
        && ap.inbox.some((pending) => computeInboxNoticeFingerprint([pending]) === noticeFingerprint);
      const messageAlreadyContributed = ap.notifications.hasContributedMessage(message, ap.sessionId);
      // Delivery-ack only means this content-free prompt was written to stdin;
      // it is not a consume/model-seen signal. Suppress only while the same row
      // is still pending locally, so a stale write memo can never hide a message.
      if (messageAlreadyPending && (messageAlreadyContributed || ap.notifications.isDuplicateNotice(noticeFingerprint, ap.sessionId))) {
        this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
          outcome: "suppressed_duplicate_stdin_idle_delivery",
          accepted: true,
          process_present: true,
          runtime: ap.config.runtime,
          session_id_present: true,
          session_ready_for_delivery: true,
          launchId: ap.launchId || undefined,
          is_idle: isIdle,
          inbox_count: ap.inbox.length,
          pending_notification_count: ap.notifications.pendingCount,
        }));
        logger.info(`[Agent ${agentId}] Suppressing duplicate idle stdin inbox update (unread-set unchanged since last write); pending=${ap.inbox.length}`);
        return true;
      }
      ap.inbox.push(message);
      const nextMessages = [...ap.inbox];
      this.commitApmIdleState(agentId, ap, false);
      this.startRuntimeTrace(agentId, ap, "stdin-idle-delivery", [message]);
      const stdinAccepted = this.deliverInboxUpdateViaStdin(
        agentId,
        ap,
        [message],
        "idle",
        "stdin_idle_delivery",
      );
      this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
        outcome: "stdin_idle_delivery",
        accepted: true,
        process_present: true,
        runtime: ap.config.runtime,
        session_id_present: true,
        launchId: ap.launchId || undefined,
        stdin_delivery_accepted: stdinAccepted,
        delivered_messages_count: nextMessages.length,
      }));
      if (trackedBegin === "accepted") {
        if (stdinAccepted) {
          this.completeTrackedMentionDelivery(traceContext);
        } else {
          this.failTrackedMention(traceContext, "DELIVERY_REJECTED");
        }
      }
      return true;
    }

    // Agent is busy — queue message in inbox
    if (transientDelivery) {
      this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
        outcome: "transient_dropped_busy",
        accepted: true,
        process_present: true,
        runtime: ap.config.runtime,
        session_id_present: Boolean(ap.sessionId),
        launchId: ap.launchId || undefined,
        is_idle: isIdle,
        inbox_count: ap.inbox.length,
      }));
      return true;
    }
    const queued = queueAgentInboxMessage(ap, message);

    // Reconciler step 9: queued work makes the process's health a question
    // (stalled with work, reconcileHealth); a stop already underway keeps the
    // message for its restart.
    this.reconcile(agentId, ap, "delivery_arrived");
    if (ap.gatedSteering.expectedTerminationReason === "stalled_recovery" || ap.gatedSteering.expectedTerminationReason === "turn_interrupt") {
      this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
        outcome: "queued_stalled_recovery",
        accepted: true,
        process_present: true,
        runtime: ap.config.runtime,
        session_id_present: Boolean(ap.sessionId),
        launchId: ap.launchId || undefined,
        inbox_count: queued.inboxCount,
        duplicate_pending_delivery: queued.duplicate,
      }));
      return true;
    }

    if (!ap.driver.supportsStdinNotification) {
      this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
        outcome: "queued_busy_non_stdin",
        accepted: true,
        process_present: true,
        runtime: ap.config.runtime,
        session_id_present: Boolean(ap.sessionId),
        launchId: ap.launchId || undefined,
        inbox_count: queued.inboxCount,
        duplicate_pending_delivery: queued.duplicate,
      }));
      return true;
    }
    if (!ap.sessionId) {
      this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
        outcome: "queued_before_session",
        accepted: true,
        process_present: true,
        runtime: ap.config.runtime,
        session_id_present: false,
        launchId: ap.launchId || undefined,
        inbox_count: queued.inboxCount,
        duplicate_pending_delivery: queued.duplicate,
      }));
      return true;
    } // agent not initialized yet

    if (!this.canDeliverToRuntimeSession(ap)) {
      const retryScheduled = this.scheduleSessionReadyDeliveryRetry(agentId, ap, "queued_before_session_ready");
      this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
        outcome: "queued_before_session_ready",
        accepted: true,
        process_present: true,
        runtime: ap.config.runtime,
        session_id_present: true,
        session_ready_for_delivery: false,
        launchId: ap.launchId || undefined,
        is_idle: isIdle,
        inbox_count: queued.inboxCount,
        duplicate_pending_delivery: queued.duplicate,
        session_ready_delivery_retry_scheduled: retryScheduled || ap.sessionReadyDeliveryRetry.kind === "scheduled",
      }));
      return true;
    }

    if (this.compactionGateClosed(ap)) {
      ap.notifications.add();
      ap.notifications.clearTimer();
      this.recordRuntimeTraceEvent(agentId, ap, "runtime.compaction_boundary.delivery_buffered", {
        pendingNotificationCount: ap.notifications.pendingCount,
        pendingMessages: ap.inbox.length,
        busyDeliveryMode: ap.driver.busyDeliveryMode,
      });
      this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
        outcome: "queued_compaction_boundary",
        accepted: true,
        process_present: true,
        runtime: ap.config.runtime,
        session_id_present: true,
        launchId: ap.launchId || undefined,
        inbox_count: queued.inboxCount,
        duplicate_pending_delivery: queued.duplicate,
        pending_notification_count: ap.notifications.pendingCount,
        busy_delivery_mode: ap.driver.busyDeliveryMode,
        notification_timer_present: false,
      }));
      return true;
    }

    if (ap.gatedSteering.reviewing) {
      ap.notifications.add();
      ap.notifications.clearTimer();
      this.recordRuntimeTraceEvent(agentId, ap, "runtime.review_boundary.delivery_buffered", {
        pendingNotificationCount: ap.notifications.pendingCount,
        pendingMessages: ap.inbox.length,
        busyDeliveryMode: ap.driver.busyDeliveryMode,
      });
      this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
        outcome: "queued_review_boundary",
        accepted: true,
        process_present: true,
        runtime: ap.config.runtime,
        session_id_present: true,
        launchId: ap.launchId || undefined,
        inbox_count: queued.inboxCount,
        duplicate_pending_delivery: queued.duplicate,
        pending_notification_count: ap.notifications.pendingCount,
        busy_delivery_mode: ap.driver.busyDeliveryMode,
        notification_timer_present: false,
      }));
      return true;
    }

    ap.notifications.add();
    if (!ap.notifications.hasTimer) {
      this.scheduleStdinNotification(agentId, ap, STDIN_NOTIFICATION_INITIAL_DELAY_MS);
    }
    this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
      outcome: "queued_busy_notification",
      accepted: true,
      process_present: true,
      runtime: ap.config.runtime,
      session_id_present: true,
      inbox_count: queued.inboxCount,
      duplicate_pending_delivery: queued.duplicate,
      pending_notification_count: ap.notifications.pendingCount,
      notification_timer_present: ap.notifications.hasTimer,
    }));
    return true;
  }

  async resetWorkspace(agentId: string) {
    const agentDataDir = path.join(this.dataDir, agentId);
    try {
      await rm(agentDataDir, { recursive: true, force: true });
      logger.info(`[Agent ${agentId}] Workspace reset complete (${agentDataDir})`);
    } catch (err) {
      logger.error(`[Agent ${agentId}] Workspace reset failed`, err);
      this.recordDaemonEvent("daemon.agent.workspace_reset_failed", {
        agentId,
        outcome: "error",
        reason: "workspace_reset_threw",
        error_class: errorClassOf(err),
      }, "error");
    }
  }

  async stopAll() {
    // Clear idle configs so no auto-restarts happen during shutdown.
    // Use silent: true so agents stay "active" in DB — on daemon reconnect,
    // the server's ready handler will auto-restart them.
    if (this.coldIdleSweepTimer) clearInterval(this.coldIdleSweepTimer);
    this.coldIdleSweepTimer = null;
    this.warmRecycle.clear();
    this.contextView.dispose();
    this.specHandbacks.dispose();
    this.drain.dispose();
    this.cancelAllQueuedAgentStarts("daemon shutdown");
    // RFC 071: starts held for the server capability end without a spawn.
    for (const wait of [...this.capabilityHolds.values()]) wait.cancel();
    this.lifecycleRecords.clearRestartSnapshots();
    // task #357: the restart configs are gone, so an agent still inside a
    // spawn-fail cooldown would read as "active cooldown without restart
    // config" at the next manager-wide invariant check during this shutdown.
    // The backoff is in-memory only and the process is exiting; drop it.
    for (const agentId of [...this.lifecycleRecords.activeSpawnFailBackoffs.keys()]) {
      this.resetSpawnFailBackoff(agentId, "suppressed");
    }

    // Task #17: these stops are silent (no closing frame), so a held empty
    // wake would go with the daemon. Publish it while each launch is still
    // the one the server expects.
    for (const [agentId, ap] of this.agents) this.publishReleasedTurn(agentId, ap);

    // Snapshot the runtimes (not bare pids) before stopAgent clears the agents
    // Map: the reaper re-checks each one right before signalling. Runtimes
    // already stopped but not yet seen to exit are included.
    const runtimes = [
      ...[...this.agents.values()].map((ap) => ap.runtime),
      ...[...this.exitingRuntimes.values()].flatMap((entry) => [...entry.runtimes]),
    ];
    const pids = runtimes.flatMap((runtime) => (typeof runtime.pid === "number" ? [runtime.pid] : []));

    const ids = [...this.agents.keys()];

    const span = this.tracer.startSpan("daemon.agent.stop_all", {
      surface: "daemon",
      kind: "internal",
      attrs: {
        agent_count: ids.length,
        pid_count: pids.length,
        pids: pids.join(","),
      },
    });
    try {
      await runWithActiveSpan(span, () => this.stopAllAgents(ids, runtimes));
      span.end("ok");
    } catch (err) {
      span.end("error", { attrs: { error_class: errorClassOf(err) } });
      throw err;
    }
  }

  private async stopAllAgents(ids: string[], runtimes: Array<Pick<RuntimeSession, "pid" | "closed">>): Promise<void> {
    await Promise.all(ids.map((id) => this.stopAgent(id, { wait: true, silent: true })));
    // Reconciler step 5: and every runtime an earlier stop is still ending.
    await Promise.all([...this.exitingRuntimes.keys()].map((id) => this.runtimeExited(id)));

    // Only children we have not reaped yet. The kernel can reuse a pid only
    // after its parent reaps the child, and Node sets exitCode/signalCode in
    // that same callback, so a closed runtime's pid may already belong to an
    // unrelated process: signalling it could SIGKILL that process. An open
    // runtime's pid is still ours (#proj-dx:7a5efdf3).
    const pids = runtimes.flatMap((runtime) =>
      !runtime.closed && typeof runtime.pid === "number" ? [runtime.pid] : []);

    // Shutdown process-tree orphan safeguard: the RuntimeSessions are torn down
    // by now, so the whole-tree survivor probe + SIGKILL is session-independent
    // by design and lives in the dedicated reaper (a distinct boundary from
    // per-session RuntimeSession IO, RS-011).
    const reapedSurvivors = await reapOrphanProcesses(
      pids,
      logger,
      (name, attrs, status) => this.recordDaemonEvent(name, attrs, status),
    );
    if (!reapedSurvivors) {
      this.recordDaemonEvent("daemon.agent.stop_all.completed", {
        agent_count: ids.length,
        survivor_count: 0,
        outcome: "all_dead",
      });
    }
  }

  getRunningAgentIds(): string[] {
    return [...this.agents.keys()];
  }

  /**
   * #wg-rbac:#27: the runner credentials this host holds right now: its
   * processes', and those of the starts it is queueing or spawning (a start
   * that ends without a process revokes its own). Read synchronously.
   */
  getHeldRunnerCredentialIds(): string[] {
    const ids = new Set<string>();
    const hold = (config: AgentConfig | null | undefined) => {
      if (config?.agentCredentialId) ids.add(config.agentCredentialId);
    };
    for (const ap of this.agents.values()) hold(ap.config);
    for (const item of this.agentStarts.queuedItems()) hold(item.config);
    for (const carried of this.spawningRunnerConfigs) for (const config of carried()) hold(config);
    return [...ids];
  }

  /** Running agents, and how many run inside this process (SDK transport). */
  getRunningAgentLoad(): { agents_running: number; agents_in_process: number } {
    let inProcess = 0;
    for (const ap of this.agents.values()) if (ap.runtime.descriptor.transport === "sdk") inProcess++;
    return { agents_running: this.agents.size, agents_in_process: inProcess };
  }

  /**
   * Reconciler step 15 (B12, measure only): the runtime CLI version of each
   * live long-lived process whose version is already known (latched at its
   * first turn, or its driver's launch). Reads only: a version not latched
   * yet stays unlatched, so a detection that just changed cannot be read as
   * the process's own. A per-turn runtime has no live session to drift.
   */
  liveRuntimeCliVersions(): Array<{ runtime: string; version: string }> {
    const live: Array<{ runtime: string; version: string }> = [];
    for (const ap of this.agents.values()) {
      if (ap.driver.lifecycle.kind === "per_turn") continue;
      const version = ap.runtimeCliVersion ?? ap.driver.launchedCliVersion ?? null;
      if (version) live.push({ runtime: ap.config.runtime || "claude", version });
    }
    return live;
  }

  private shouldDeferWakeMessage(agentId: string, driver: RuntimeDriver, message: AgentMessage): boolean {
    if (!driver.shouldDeferWakeMessage?.(message)) return false;
    logger.info(`[Agent ${agentId}] Deferred non-concrete wake message for ${driver.id}`);
    return true;
  }

  private completeDeprecatedRuntimeProfileMigration(
    agentId: string,
    migrationKey: string,
    launchId: string | null,
    traceparent: string | undefined,
    source: "agent_config" | "wake_message" | "runtime_profile_message",
  ): void {
    this.sendToServer({
      type: "agent:runtime_profile:migration:ack",
      agentId,
      migrationKey,
      launchId: launchId || undefined,
      traceparent,
    });
    this.sendToServer({
      type: "agent:runtime_profile:migration_done",
      agentId,
      migrationKey,
      launchId: launchId || undefined,
      traceparent,
    });
    this.recordDaemonEvent("daemon.runtime_profile.migration.deprecated_noop", {
      agentId,
      key_present: Boolean(migrationKey),
      key_hash: hashRuntimeProfileKey(migrationKey),
      launchId: launchId || undefined,
      source,
    });
    logger.info(`[Agent ${agentId}] Completed deprecated Runtime Profile migration ${migrationKey} as reset-session no-op`);
  }

  getAgentSessionId(agentId: string): string | null {
    const ap = this.agents.get(agentId);
    return this.reportableSessionId(ap, ap?.sessionId);
  }

  getAgentLaunchId(agentId: string): string | null {
    return this.agents.get(agentId)?.launchId ?? null;
  }

  getIdleAgentSessionIds(): Array<{ agentId: string; sessionId: string; launchId: string | null }> {
    const result: Array<{ agentId: string; sessionId: string; launchId: string | null }> = [];
    for (const [agentId, { sessionId, launchId }] of this.lifecycleRecords.restartSnapshotEntries()) {
      if (this.agents.has(agentId)) continue;
      if (sessionId) result.push({ agentId, sessionId, launchId });
    }
    return result;
  }

  private buildRuntimeProfileReport(
    agentId: string,
    config: AgentConfig,
    sessionId: string | null,
    launchId: string | null,
    observedRuntimeHomeDir?: string | null,
    processInstanceId?: string,
  ): AgentRuntimeProfileWireReport {
    const workspacePath = path.join(this.dataDir, agentId);
    const runtimeHomeDir = observedRuntimeHomeDir
      || resolveRuntimeHomeDir(config, this.runtimeSessionHomeDir, workspacePath, { agentId, slockHome: this.slockHome });
    return {
      agentId,
      launchId,
      facts: {
        runtime: config.runtime,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        executionMode: config.executionMode || "byoc",
        workspacePathRef: {
          label: "workspace",
          path: workspacePath,
          reachable: true,
        },
        sessionRef: sessionId ? resolveRuntimeSessionRef(config.runtime, sessionId, runtimeHomeDir, workspacePath, {
          ...runtimeTranscriptHomesForConfig(config, this.runtimeSessionHomeDir),
          agentId,
          workingDirectory: workspacePath,
          // Join keys come from the CALLER's context (running agent OR idle
          // restart snapshot) — reading only live state here left the
          // restart/adopt path writing launchId:null markers, exactly the
          // V3 class this exists to close (Leiysky review on #3863).
          launchId: launchId || undefined,
          processInstanceId: processInstanceId ?? this.agents.get(agentId)?.processInstanceId,
        }) : null,
      },
    };
  }

  getAgentRuntimeProfileReport(agentId: string): AgentRuntimeProfileWireReport | null {
    const running = this.agents.get(agentId);
    if (running) {
      return this.buildRuntimeProfileReport(
        agentId,
        // Reconciler step 7: what is running, not what a rebind asked for
        // (the process runs that from its next start, reconcileSpec).
        { ...running.config, ...running.startedSpec.reported },
        running.sessionId,
        running.launchId,
        running.runtime.currentRuntimeHomeDir,
        running.processInstanceId,
      );
    }
    const idle = this.lifecycleRecords.getRestartSnapshot(agentId);
    if (idle) {
      return this.buildRuntimeProfileReport(agentId, idle.config, idle.sessionId, idle.launchId, null, idle.processInstanceId);
    }
    const hosted = this.hostedSessions?.get(agentId);
    if (hosted) {
      return this.buildRuntimeProfileReport(agentId, hosted.config, hosted.sessionId, hosted.launchId, null, hosted.processInstanceId);
    }
    return null;
  }

  /**
   * task #1357 item 1: each live Pi session's last limits report, for the
   * reconnect re-send. The same session result as first sent (same seq and
   * observation time), with the launch its process carries now.
   */
  getModelLimitsReports(): import("@botiverse/raft-shared").AgentModelLimitsFrame[] {
    const frames: import("@botiverse/raft-shared").AgentModelLimitsFrame[] = [];
    for (const ap of this.agents.values()) {
      if (ap.modelLimitsReport) frames.push(this.modelLimitsFrame(ap.modelLimitsReport, ap));
    }
    return frames;
  }

  private modelLimitsFrame(
    report: Omit<import("@botiverse/raft-shared").AgentModelLimitsFrame, "launchId">,
    ap: AgentProcess,
  ): import("@botiverse/raft-shared").AgentModelLimitsFrame {
    return { ...report, ...(ap.launchId ? { launchId: ap.launchId } : {}) };
  }

  /**
   * task #1357 item 1: a Pi session was opened (a start, a rebuild, a
   * rotation's reopen) with these limits registered. Kept on the process and
   * sent; a revision the daemon does not know (an older server) is not
   * reported, since the server could not tell which config it belongs to,
   * nor is one without a daemon instance id (the server orders by it).
   */
  private recordModelLimits(agentId: string, ap: AgentProcess, event: Extract<ParsedEvent, { kind: "model_limits" }>): void {
    if (event.configRevision === null) {
      this.recordDaemonEvent("daemon.agent.model_limits", { agentId, launchId: ap.launchId || undefined, outcome: "skipped_no_revision" });
      return;
    }
    if (!this.daemonInstanceId) {
      this.recordDaemonEvent("daemon.agent.model_limits", { agentId, launchId: ap.launchId || undefined, outcome: "skipped_no_instance" });
      return;
    }
    this.modelLimitsSeq += 1;
    const report = {
      type: "agent:model_limits" as const,
      v: 1 as const,
      agentId,
      sessionId: event.sessionId,
      configRevision: event.configRevision,
      daemonInstanceId: this.daemonInstanceId,
      seq: this.modelLimitsSeq,
      observedAtMs: Date.now(),
      runtime: ap.config.runtime,
      modelLimits: event.modelLimits,
    };
    ap.modelLimitsReport = report;
    this.recordDaemonEvent("daemon.agent.model_limits", {
      agentId,
      launchId: ap.launchId || undefined,
      outcome: "sent",
      config_revision: event.configRevision,
      context_window_source: event.modelLimits.contextWindow.source,
      max_tokens_source: event.modelLimits.maxTokens.source,
    });
    this.sendToServer(this.modelLimitsFrame(report, ap));
  }

  getAgentRuntimeProfileReports(): AgentRuntimeProfileWireReport[] {
    const reports: AgentRuntimeProfileWireReport[] = [];
    const seen = new Set<string>();
    for (const agentId of this.agents.keys()) {
      const report = this.getAgentRuntimeProfileReport(agentId);
      if (report) {
        reports.push(report);
        seen.add(agentId);
      }
    }
    for (const agentId of this.lifecycleRecords.restartSnapshotAgentIds()) {
      if (seen.has(agentId)) continue;
      const report = this.getAgentRuntimeProfileReport(agentId);
      if (report) {
        reports.push(report);
        seen.add(agentId);
      }
    }
    for (const agentId of this.hostedSessions?.agentIds() ?? []) {
      if (seen.has(agentId)) continue;
      const report = this.getAgentRuntimeProfileReport(agentId);
      if (report) reports.push(report);
    }
    return reports;
  }

  deliverRuntimeProfileNotification(
    agentId: string,
    key: string,
    kind: "migration" | "daemon_release_notice",
    content: string,
    traceparent?: string,
    launchId?: string | null,
  ): boolean | Promise<boolean> {
    const span = this.tracer.startSpan("daemon.runtime_profile.control.inject", {
      parent: parseTraceparent(traceparent),
      surface: "daemon",
      kind: "consumer",
      attrs: {
        agentId,
        control_kind: kind,
        key_present: Boolean(key),
        key_hash: hashRuntimeProfileKey(key),
      },
    });
    if (kind === "migration") {
      this.completeDeprecatedRuntimeProfileMigration(
        agentId,
        key,
        launchId || null,
        formatTraceparent(span.context),
        "runtime_profile_message",
      );
      span.end("ok", { attrs: { outcome: "deprecated_noop_completed", launchId: launchId || undefined } });
      return true;
    }
    const now = new Date().toISOString();
    const message: AgentMessage = {
      channel_id: "system",
      channel_name: "system",
      channel_type: "dm",
      sender_id: "system",
      sender_name: "system",
      sender_type: "system",
      content,
      timestamp: now,
      message_id: `${RUNTIME_PROFILE_DAEMON_NOTICE_MESSAGE_PREFIX}${key}`,
      traceparent: formatTraceparent(span.context),
    };

    const ap = this.agents.get(agentId);
    const isIdle = ap ? this.isApmIdle(ap) : false;
    const sessionReadyForDelivery = ap ? this.canDeliverToRuntimeSession(ap) : false;
    // Reconciler step 13: a drain queues it in the inbox, which the drain holds.
    if (ap && (this.drain.holds(agentId) || (!(sessionReadyForDelivery && ap.driver.supportsStdinNotification && isIdle) && !(sessionReadyForDelivery && ap.runtime.descriptor.busyDelivery === "direct")))) {
      this.enqueueRuntimeProfileNotification(agentId, ap, message, kind, key);
      span.end("ok", {
        attrs: {
          outcome: ap.sessionId ? "queued_busy" : "queued_before_session",
          runtime: ap.config.runtime,
          launchId: ap.launchId || undefined,
          session_id_present: Boolean(ap.sessionId),
          session_ready_for_delivery: sessionReadyForDelivery,
          supports_stdin_notification: ap.driver.supportsStdinNotification,
          busy_delivery_mode: ap.driver.busyDeliveryMode,
        },
      });
      return true;
    }

    if (ap && sessionReadyForDelivery && ap.driver.supportsStdinNotification && isIdle) {
      this.commitApmIdleState(agentId, ap, false);
      this.startRuntimeTrace(agentId, ap, "runtime-profile", [message]);
      const written = this.deliverMessagesViaStdin(agentId, ap, [message], "idle");
      span.end(written ? "ok" : "error", {
        attrs: {
          outcome: written ? "stdin_idle" : "stdin_failed",
          runtime: ap.config.runtime,
          launchId: ap.launchId || undefined,
          session_id_present: true,
          supports_stdin_notification: true,
          busy_delivery_mode: ap.driver.busyDeliveryMode,
        },
      });
      return written;
    }

    if (ap && sessionReadyForDelivery && ap.runtime.descriptor.busyDelivery === "direct") {
      const written = this.deliverMessagesViaStdin(agentId, ap, [message], "busy");
      span.end(written ? "ok" : "error", {
        attrs: {
          outcome: written ? "stdin_busy" : "stdin_failed",
          runtime: ap.config.runtime,
          launchId: ap.launchId || undefined,
          session_id_present: true,
          supports_stdin_notification: ap.driver.supportsStdinNotification,
          busy_delivery_mode: ap.driver.busyDeliveryMode,
        },
      });
      return written;
    }

    if (this.agentStarts.hasStarting(agentId) || this.agentStarts.hasQueued(agentId)) {
      const queuedStart = this.agentStarts.getQueued(agentId);
      this.queueRuntimeProfileNotificationDuringStart(agentId, message, kind, key);
      span.end("ok", {
        attrs: {
          outcome: "queued_during_start",
          startup_pending: true,
          launchId: queuedStart?.launchId,
        },
      });
      return true;
    }

    const lifecycleRecord = this.agentLifecycleRecord(agentId);
    if (lifecycleRecord?.kind === "idle" || lifecycleRecord?.kind === "cooldown") {
      const cached = lifecycleRecord.restartSnapshot;
      logger.info(`[Agent ${agentId}] Starting from idle state for runtime profile ${kind} ${key}`);
      // SPAWN-FAIL BACKOFF gate (mirror of auto_restart_from_idle path).
      if (lifecycleRecord.kind === "cooldown") {
        const state = lifecycleRecord.spawnFailBackoff;
        this.enterSpawnFailCooldownResidency(agentId, cached, state.untilMs, "runtime_profile_auto_restart", "spawn_fail_cooldown_active");
        span.end("ok", {
          attrs: {
            outcome: "spawn_fail_cooldown_active",
            runtime: cached.config.runtime,
            launchId: cached.launchId || undefined,
            spawn_fail_attempts: state.attempts,
            spawn_fail_until_ms: state.untilMs,
          },
        });
        return true;
      }
      this.lifecycleRecords.deleteRestartSnapshot(agentId);
      const restartStopEpoch = this.lifecycleRecords.stopEpoch(agentId);
      return this.startAgent(agentId, cached.config, message, undefined, undefined, cached.launchId || undefined).then(() => {
        this.resetSpawnFailBackoff(agentId);
        this.assertStartPendingDeliveryInvariants("runtime-profile-auto-restart-success");
        return true;
      }, (err) => {
        logger.error(`[Agent ${agentId}] Failed to auto-restart for runtime profile notification`, err);
        if (this.suppressFailedRestartAfterStop(agentId, restartStopEpoch, "runtime-profile-auto-restart")) {
          span.end("ok", {
            attrs: {
              outcome: "suppressed_after_stop",
              runtime: cached.config.runtime,
              launchId: cached.launchId || undefined,
            },
          });
          return false;
        }
        if (this.reportRunnerCredentialMintFailure(agentId, err, cached.launchId, "runtime_profile_auto_restart")) {
          this.lifecycleRecords.setRestartSnapshot(agentId, cached);
          const report = this.recordSpawnFailure(agentId, "runner_credential_mint");
          this.assertStartPendingDeliveryInvariants("runtime-profile-auto-restart-runner-credential-mint-failure");
          if (report.backoffActive) {
            this.enterSpawnFailCooldownResidency(agentId, cached, report.untilMs, "runtime_profile_auto_restart", "runner_credential_mint");
          }
          this.recordDaemonEvent("daemon.agent.spawn.fail_backoff", {
            agentId,
            source: "runtime_profile_auto_restart",
            reason: "runner_credential_mint",
            attempts: report.attempts,
            cooldown_active: report.backoffActive,
            until_ms: report.untilMs,
          });
          span.end("error", {
            attrs: {
              outcome: "runner_credential_mint_failed",
              runtime: cached.config.runtime,
              launchId: cached.launchId || undefined,
            },
          });
          return false;
        }
        this.lifecycleRecords.setRestartSnapshot(agentId, cached);
        const report = this.recordSpawnFailure(agentId, "spawn_error");
        if (this.stopLocalRestartAfterFailure(agentId, cached, err, report.attempts, "runtime_profile_auto_restart")) {
          this.assertStartPendingDeliveryInvariants("runtime-profile-auto-restart-stopped");
          span.end("error", {
            attrs: {
              outcome: "local_restart_stopped",
              runtime: cached.config.runtime,
              launchId: cached.launchId || undefined,
            },
          });
          return false;
        }
        this.assertStartPendingDeliveryInvariants("runtime-profile-auto-restart-spawn-failure");
        if (report.backoffActive) {
          this.enterSpawnFailCooldownResidency(agentId, cached, report.untilMs, "runtime_profile_auto_restart", "spawn_error");
        }
        this.recordDaemonEvent("daemon.agent.spawn.fail_backoff", {
          agentId,
          source: "runtime_profile_auto_restart",
          reason: "spawn_error",
          attempts: report.attempts,
          cooldown_active: report.backoffActive,
          until_ms: report.untilMs,
        });
        span.end("error", {
          attrs: {
            outcome: "restart_failed",
            runtime: cached.config.runtime,
            launchId: cached.launchId || undefined,
          },
        });
        return false;
      });
    }

    logger.warn(`[Agent ${agentId}] Runtime profile ${kind} ${key} has no runtime injection path yet; leaving unacked for retry`);
    span.end("ok", { attrs: { outcome: "no_path" } });
    return false;
  }

  private ackInjectedRuntimeProfileMessages(agentId: string, messages: AgentMessage[], launchId: string | null) {
    for (const message of messages) {
      const notification = runtimeProfileNotificationFromMessage(message);
      if (!notification) continue;
      if (notification.kind === "migration") {
        this.completeDeprecatedRuntimeProfileMigration(agentId, notification.key, launchId, message.traceparent, "runtime_profile_message");
        continue;
      }
      const title = runtimeProfileNotificationTitle(notification.kind);
      this.broadcastActivity(agentId, "working", title, [{ kind: "system", title, text: message.content }], launchId, "system_message");
      this.sendToServer({
        type: "agent:runtime_profile:daemon_release_notice:ack",
        agentId,
        noticeKey: notification.key,
        launchId: launchId || undefined,
        traceparent: message.traceparent,
      });
    }
  }

  private ackInjectedRuntimeProfileControl(
    agentId: string,
    control: NonNullable<AgentConfig["runtimeProfileControl"]>,
    launchId: string | null,
  ) {
    const span = this.tracer.startSpan("daemon.runtime_profile.control.inject", {
      parent: getActiveTraceContext(),
      surface: "daemon",
      kind: "internal",
      attrs: {
        agentId,
        control_kind: control.kind,
        key_present: Boolean(control.key),
        key_hash: hashRuntimeProfileKey(control.key),
        launchId: launchId || undefined,
        source: "agent_config",
      },
    });
    const title = runtimeProfileNotificationTitle(control.kind);
    if (control.kind === "migration") {
      this.completeDeprecatedRuntimeProfileMigration(agentId, control.key, launchId, formatTraceparent(span.context), "agent_config");
      span.end("ok", { attrs: { outcome: "deprecated_noop_completed" } });
      return;
    }
    this.broadcastActivity(agentId, "working", title, [{ kind: "system", title, text: control.message }], launchId, "system_message");
    this.sendToServer({
      type: "agent:runtime_profile:daemon_release_notice:ack",
      agentId,
      noticeKey: control.key,
      launchId: launchId || undefined,
      traceparent: formatTraceparent(span.context),
    });
    span.end("ok", { attrs: { outcome: "agent_config_ack_sent" } });
  }

  private sendRuntimeProfileWireReport(report: AgentRuntimeProfileWireReport, source: RuntimeProfileReportSource) {
    const span = this.tracer.startSpan("daemon.runtime_profile.report.sent", {
      parent: getActiveTraceContext(),
      surface: "daemon",
      kind: "producer",
      attrs: {
        agentId: report.agentId,
        launchId: report.launchId || undefined,
        runtime: report.facts.runtime,
        report_source: source,
        model_present: Boolean(report.facts.model),
        session_ref_present: Boolean(report.facts.sessionRef),
        workspace_ref_present: Boolean(report.facts.workspaceRef || report.facts.workspacePathRef),
      },
    });
    this.sendToServer({
      type: "agent:runtime_profile",
      agentId: report.agentId,
      facts: report.facts,
      launchId: report.launchId || undefined,
      traceparent: formatTraceparent(span.context),
      source,
    });
    span.end("ok");
  }

  private sendRuntimeProfileReportFor(
    agentId: string,
    config: AgentConfig,
    sessionId: string | null,
    launchId: string | null,
    source: RuntimeProfileReportSource,
  ) {
    this.sendRuntimeProfileWireReport(this.buildRuntimeProfileReport(agentId, config, sessionId, launchId), source);
  }

  /** RFC 060: the report of a session another host runs (the OAR host), built as this host builds its own. */
  sendHostedRuntimeProfileReport(
    agentId: string,
    hosted: HostedAgentSession,
    source: RuntimeProfileReportSource,
  ): void {
    this.sendRuntimeProfileWireReport(
      this.buildRuntimeProfileReport(agentId, hosted.config, hosted.sessionId, hosted.launchId, null, hosted.processInstanceId),
      source,
    );
  }

  private sendRuntimeProfileReport(agentId: string, source: RuntimeProfileReportSource) {
    const report = this.getAgentRuntimeProfileReport(agentId);
    if (!report) return;
    this.sendRuntimeProfileWireReport(report, source);
  }

  // Machine-level workspace scanning

  async scanAllWorkspaces(): Promise<WorkspaceDirectoryInfo[]> {
    return scanWorkspaceDirectories(this.dataDir);
  }

  async deleteWorkspaceDirectory(directoryName: string): Promise<boolean> {
    const deleted = await deleteWorkspaceDirectory(this.dataDir, directoryName);
    // A workspace directory is named by its agent id: the agent is gone here.
    if (deleted) this.providerQuota.forget(directoryName);
    return deleted;
  }

  // Workspace file browsing

  async getFileTree(agentId: string, dirPath?: string, includeHidden = false): Promise<FileNode[]> {
    return listWorkspaceDirectory(path.join(this.dataDir, agentId), dirPath, includeHidden);
  }

  async readFile(agentId: string, filePath: string): Promise<WorkspaceFileRead> {
    return readWorkspaceFile(path.join(this.dataDir, agentId), filePath);
  }

  // Skill scanning

  // Per-runtime skill search paths (relative to home dir for global, workspace dir for workspace).
  // To add a new runtime, add an entry here.
  private static readonly SKILL_PATHS: Record<string, { global: string[]; workspace: string[] }> = {
    claude: {
      // Claude reads shared skills via symlinks in ~/.claude/skills/, not from ~/.agents/skills/
      global: [".claude/skills", ".claude/commands"],
      workspace: [".claude/skills", ".claude/commands"],
    },
    codex: {
      // Codex natively scans ~/.agents/skills/ and has built-in .system skills
      global: [".codex/skills", ".codex/skills/.system", ".agents/skills"],
      workspace: [".codex/skills", ".agents/skills"],
    },
  };

  async getSessionTranscript(
    agentId: string,
    options: {
      anchorAt?: string;
      /**
       * The feedback request's `sessionLookup` (FeedbackTranscriptSessionLookup):
       * used only when this daemon holds nothing for the agent. Its config and
       * session id live in memory alone, so they are gone after a daemon
       * restart and after the agent's terminal failure, which is when people
       * report an agent.
       */
      serverLookup?: FeedbackTranscriptSessionLookup | null;
    } = {},
  ): Promise<SessionTranscriptLookup> {
    const agent = this.agents.get(agentId);
    const idle = this.lifecycleRecords.getRestartSnapshot(agentId);
    // RFC 060: an agent another host runs (the OAR host) is read the same way.
    const hosted = !agent && !idle ? this.hostedSessions?.get(agentId) ?? null : null;
    // What this daemon knows wins; the server's copy only fills the gap.
    const fromServer = !agent && !idle && !hosted && options.serverLookup ? agentConfigForSessionLookup(options.serverLookup) : null;
    const config = agent?.config ?? idle?.config ?? hosted?.config ?? fromServer;
    // SECURITY: only the sessionId bound to the agent is ever read: this
    // daemon's own, or the one the server stores for the agent and would
    // start it with. A web caller never supplies one (the request names an
    // agent; the server adds its record). The runtime's session directories
    // for that config are shared by the agents and CLI sessions of one OS
    // login, as they are for a running agent; the path checks below are the same.
    const actualSessionId = agent?.sessionId || idle?.sessionId || hosted?.sessionId || fromServer?.sessionId || null;
    const workspaceDir = path.join(this.dataDir, agentId);

    if (!config) {
      // An OBSERVATION about this daemon's memory and its local directory only:
      // it does not say where (or whether) the agent ran.
      const workspaceDirPresent = await stat(workspaceDir).then((info) => info.isDirectory(), () => false);
      return {
        runtime: "unknown",
        sessionId: actualSessionId || "unknown",
        reachable: false,
        path: null,
        fallbackReason: "no agent config in this daemon's memory (no live process, no restart snapshot)",
        transcript: null,
        sizeBytes: 0,
        truncated: false,
        redacted: false,
        tier: "unknown",
        transcriptContent: "absent",
        reasonCode: "no_config_in_memory",
        lookupMethod: "in_memory_agent_config",
        searchedPaths: this.foldTranscriptLookupPaths([workspaceDir]),
        workspaceDirPresent,
        transcriptBytes: 0,
      };
    }

    const runtime = config.runtime;
    // A report about an agent this daemon holds nothing for only reads: it
    // creates no runtime home and (below) writes no handoff marker.
    const homeDir = agent?.runtime.currentRuntimeHomeDir
      || (fromServer
        ? resolveRuntimeHomeDir(config, this.runtimeSessionHomeDir, workspaceDir, { agentId, slockHome: this.slockHome })
        : ensureRuntimeHomeDir(config, this.runtimeSessionHomeDir, workspaceDir, { agentId, slockHome: this.slockHome }));

    if (!actualSessionId) {
      return {
        runtime,
        sessionId: "unknown",
        reachable: false,
        path: null,
        fallbackReason: "no session id available",
        transcript: null,
        sizeBytes: 0,
        truncated: false,
        redacted: false,
        tier: runtimeTier(runtime),
        transcriptContent: "absent",
        reasonCode: "no_session_id",
        lookupMethod: null,
        searchedPaths: [],
        transcriptBytes: 0,
      };
    }

    // The resolver still writes the workspace handoff marker on a native miss
    // (the runtime-profile join depends on it); the feedback path reads the
    // typed resolution and never treats that file as a transcript.
    // kimi-sdk: its SDK home (KIMI_CODE_HOME / ~/.kimi-code), not homeDir.
    const transcriptHomes = runtimeTranscriptHomesForConfig(config, this.runtimeSessionHomeDir);
    const resolved = resolveRuntimeSessionRefDetailed(runtime, actualSessionId, homeDir, fromServer ? undefined : workspaceDir, {
      ...transcriptHomes,
      agentId,
      workingDirectory: workspaceDir,
      launchId: this.agents.get(agentId)?.launchId || undefined,
      processInstanceId: this.agents.get(agentId)?.processInstanceId,
    });
    const ref = resolved.ref;
    const lookupMethod = asFeedbackTranscriptLookupMethod(resolved.lookupMethod);
    const searchedPaths = this.foldTranscriptLookupPaths(resolved.searchedPaths, homeDir);

    const tier = runtimeTier(runtime);
    const span = this.tracer.startSpan("daemon.session_transcript.read", {
      parent: getActiveTraceContext(),
      surface: "daemon",
      kind: "internal",
      attrs: {
        agentId,
        runtime,
        sessionId: actualSessionId,
        reachable: resolved.resolution === "native",
        resolution: resolved.resolution,
        tier,
        lookup_method: resolved.lookupMethod,
        // memory: this daemon held the agent; server: the request's sessionLookup filled the gap.
        config_source: fromServer ? "server" : "memory",
      },
    });

    const base = { runtime, sessionId: actualSessionId, tier, lookupMethod, searchedPaths };
    const notRead = (
      reasonCode: FeedbackTranscriptLookupReason,
      transcriptContent: FeedbackTranscriptContentKind,
      fallbackReason: string,
      extra: { sourceBytes?: number; path?: string | null; truncated?: boolean; truncationDirection?: "head" | "tail" | "window" } = {},
    ): SessionTranscriptLookup => ({
      ...base,
      reachable: false,
      path: extra.path ?? null,
      fallbackReason,
      transcript: null,
      sizeBytes: 0,
      truncated: extra.truncated ?? false,
      ...(extra.truncationDirection ? { truncationDirection: extra.truncationDirection } : {}),
      redacted: false,
      transcriptContent,
      reasonCode,
      transcriptBytes: 0,
      ...(extra.sourceBytes !== undefined ? { sourceBytes: extra.sourceBytes } : {}),
    });

    if (resolved.resolution !== "native" || !ref.path) {
      const reasonCode = resolved.lookupMethod === "none" ? "runtime_has_no_native_lookup" : "native_session_file_not_found";
      span.end("ok", { attrs: { transcript_present: false, reason_code: reasonCode } });
      return notRead(
        reasonCode,
        resolved.resolution === "daemon_handoff" ? "placeholder" : "absent",
        reasonCode === "runtime_has_no_native_lookup"
          ? `this daemon has no native session lookup for runtime ${runtime}`
          : `native session file not found (lookup ${resolved.lookupMethod})`,
      );
    }

    const allowedRoots = allowedTranscriptRootsForRuntime(runtime, homeDir, workspaceDir, transcriptHomes);
    let targetPath: string;
    let transcriptContent: FeedbackTranscriptUploadableContentKind = "native_session_file";
    try {
      const resolvedPath = path.resolve(ref.path);
      if (!(await isPathWithinAllowedRoots(resolvedPath, allowedRoots))) {
        throw new TranscriptPathRejectedError("resolved session path is outside allowed runtime directories");
      }
      // A runtime whose lookup yields a session directory (the legacy kimi
      // CLI layout), read the primary STATE file: the runtime's state, not
      // necessarily a conversation, so it is labelled native_state_file.
      // (kimi-sdk resolves to its wire.jsonl conversation log, a file.)
      const info = await lstat(resolvedPath);
      if (info.isSymbolicLink()) throw new TranscriptPathRejectedError("symbolic links are not allowed");
      targetPath = resolvedPath;
      if (info.isDirectory()) {
        targetPath = path.join(resolvedPath, "state.json");
        transcriptContent = "native_state_file";
      }
      if (!(await isPathWithinAllowedRoots(targetPath, allowedRoots))) {
        throw new TranscriptPathRejectedError("resolved session state path is outside allowed runtime directories");
      }
    } catch (err) {
      const rejected = err instanceof TranscriptPathRejectedError;
      span.end("error", { attrs: { error_class: err instanceof Error ? err.name : "Error", reason_code: rejected ? "path_rejected" : "read_failed" } });
      return notRead(rejected ? "path_rejected" : "read_failed", "absent", rejected ? "session path rejected" : "session path could not be inspected", { path: ref.path });
    }

    const read = await readSessionTranscriptChain(targetPath, resolved.sessionChain, allowedRoots, SESSION_TRANSCRIPT_MAX_BYTES, options.anchorAt);
    if (!read.ok) {
      // `detail` (e.g. compressed_unsupported) stays daemon-side: the shared
      // reason code is read_failed, which every server version accepts.
      span.end("error", { attrs: { error_class: read.errorClass, reason_code: read.failure, ...(read.detail ? { read_detail: read.detail } : {}) } });
      return notRead(
        read.failure,
        "absent",
        read.failure === "path_rejected"
          ? "session path rejected"
          : read.detail
            ? `session file could not be read (${read.detail})`
            : "session file could not be read",
        { path: ref.path },
      );
    }
    const transcriptBytes = Buffer.byteLength(read.text, "utf8");
    if (read.sourceBytes === 0 || transcriptBytes === 0) {
      const reasonCode = read.sourceBytes === 0 ? "session_file_empty" : "window_empty";
      span.end("ok", { attrs: { transcript_present: false, reason_code: reasonCode, source_bytes: read.sourceBytes } });
      return notRead(reasonCode, "absent", reasonCode === "session_file_empty" ? "session file is empty" : "no complete record in the bounded read window", { sourceBytes: read.sourceBytes, path: ref.path, truncated: read.truncated, truncationDirection: read.truncationDirection });
    }
    span.end("ok", { attrs: { transcript_present: true, transcript_content: transcriptContent, size_bytes: transcriptBytes, source_bytes: read.sourceBytes, truncated: read.truncated, redacted: true, earlier_files: read.earlierFiles, chain_stop: read.chainStop } });
    return {
      ...base,
      reachable: true,
      path: ref.path,
      transcript: read.text,
      sizeBytes: transcriptBytes,
      truncated: read.truncated,
      truncationDirection: read.truncationDirection,
      redacted: true,
      transcriptContent,
      sourceBytes: read.sourceBytes,
      transcriptBytes,
    };
  }

  /**
   * Searched paths for the LOCAL lookup diagnostic only (home directories
   * folded to `~`, bounded). A custom dataDir stays absolute, which is why
   * these never enter the feedback result frame or transcript_outcome.
   */
  private foldTranscriptLookupPaths(paths: readonly string[], runtimeHomeDir?: string): string[] {
    const homes = [...new Set([runtimeHomeDir, this.runtimeSessionHomeDir, os.homedir()].filter((h): h is string => Boolean(h)))]
      .sort((a, b) => b.length - a.length);
    return paths.slice(0, TRANSCRIPT_LOOKUP_SEARCHED_PATHS_MAX).map((p) => {
      const home = homes.find((h) => p === h || p.startsWith(`${h}${path.sep}`));
      const folded = home ? `~${p.slice(home.length)}` : p;
      return folded.length > TRANSCRIPT_LOOKUP_SEARCHED_PATH_MAX_CHARS
        ? `…${folded.slice(folded.length - TRANSCRIPT_LOOKUP_SEARCHED_PATH_MAX_CHARS + 1)}`
        : folded;
    });
  }

  /**
   * Collect the agent's current session transcript and upload it as a trace
   * bundle linked to a feedback report. The transcript is read using only the
   * sessionId bound to the agent (this daemon's, or the server's stored one from
   * the request's sessionLookup); a web caller never supplies a session id.
   */
  async collectFeedbackTranscript(
    agentId: string,
    feedbackReportId: string,
    reportWindow: FeedbackTranscriptReportWindowInput = defaultFeedbackTranscriptReportWindow(),
    options: {
      /** The feedback request's `sessionLookup`: see getSessionTranscript's `serverLookup`. */
      serverLookup?: FeedbackTranscriptSessionLookup | null;
      /** Tier 2 (task #272): owner opted in; `machineLogPaths` are the runner log candidates. */
      includeMachineLogTail?: boolean;
      machineLogPaths?: readonly string[];
      /** task #279: the running daemon's own version for the machine-state summary. */
      daemonVersion?: string;
      /** task #1228 ①: the server's request id, signed into the transcript claims. */
      requestId?: string;
    } = {},
  ): Promise<FeedbackTranscriptCollectionResult> {
    return collectFeedbackTranscriptAttachment({
      agentId,
      feedbackReportId,
      reportWindow,
      ...(options.requestId ? { requestId: options.requestId } : {}),
      getSessionTranscript: () => this.getSessionTranscript(agentId, { anchorAt: reportWindow.reportGeneratedAt, serverLookup: options.serverLookup }),
      getObservedFailureSummary: (window) => this.buildObservedFailureSummary(agentId, window),
      getMachineEvidence: (window) => this.buildFeedbackMachineEvidence(window, options.daemonVersion),
      machineLogTail: {
        include: options.includeMachineLogTail === true,
        collect: (window) => collectFeedbackMachineLogTailAttachment({
          agentId,
          feedbackReportId,
          window,
          source: { paths: options.machineLogPaths ?? [] },
          serverUrl: this.serverUrl,
          daemonApiKey: this.daemonApiKey,
          workerUrl: this.workerUrl,
          tracer: this.tracer,
          fetchImpl: this.fetchImpl,
        }),
      },
      serverUrl: this.serverUrl,
      daemonApiKey: this.daemonApiKey,
      workerUrl: this.workerUrl,
      tracer: this.tracer,
      fetchImpl: this.fetchImpl,
    });
  }

  /** Whether this daemon can upload feedback attachments at all (worker URL configured). */
  get feedbackUploadsConfigured(): boolean {
    return Boolean(this.workerUrl);
  }

  /**
   * task #1228 ①: upload the transcript_outcome object for one request. Call
   * only AFTER the result frame was sent. Never rejects; never retries.
   */
  uploadFeedbackTranscriptOutcome(
    agentId: string,
    feedbackReportId: string,
    requestId: string,
    result: FeedbackTranscriptCollectionResult,
    daemonVersion: string | null,
  ): Promise<FeedbackTranscriptOutcomeUploadStatus | "not_attempted"> {
    if (!this.workerUrl) return Promise.resolve("not_attempted");
    return uploadFeedbackTranscriptOutcome({
      result,
      agentId,
      feedbackReportId,
      requestId,
      daemonVersion,
      serverUrl: this.serverUrl,
      daemonApiKey: this.daemonApiKey,
      workerUrl: this.workerUrl,
      tracer: this.tracer,
      fetchImpl: this.fetchImpl,
    });
  }

  /**
   * task #1230: collect and upload the agent_event_tail object for one
   * request. Call only AFTER the result frame was sent. Never rejects; its own
   * budget aborts the scan and every upload hop; never retried.
   */
  uploadFeedbackAgentEventTail(
    agentId: string,
    feedbackReportId: string,
    requestId: string,
    reportGeneratedAt: string,
  ): Promise<FeedbackAgentEventTailOutcome | "not_attempted"> {
    if (!this.workerUrl) return Promise.resolve("not_attempted");
    return startFeedbackAgentEventTail({
      agentId,
      feedbackReportId,
      requestId,
      reportGeneratedAt,
      machineDir: this.machineDir,
      serverUrl: this.serverUrl,
      daemonApiKey: this.daemonApiKey,
      workerUrl: this.workerUrl,
      tracer: this.tracer,
      fetchImpl: this.fetchImpl,
    });
  }

  /**
   * Tier-1 machine-side context for a feedback upload.
   *
   * Fails to `null` rather than throwing, on purpose: this is a diagnostic
   * add-on riding on the channel users report problems through, so it must not
   * be able to break the upload. `null` means "could not build", NOT "nothing
   * happened" -- the summary's own empty list already carries that distinction
   * and is emitted normally.
   */
  /**
   * task #279: default machine evidence. Fails to nulls, never throws; each
   * value passes the shared redaction as an exit guard and is dropped (not
   * altered) if redaction would change it.
   */
  private async buildFeedbackMachineEvidence(
    window: { from: string; to: string },
    daemonVersion: string | undefined,
  ): Promise<{ traceTail: FeedbackTraceTail | null; machineState: FeedbackMachineState | null }> {
    const machineDir = this.machineDir;
    let traceTail: FeedbackTraceTail | null = null;
    let machineState: FeedbackMachineState | null = null;
    try {
      traceTail = machineDir ? redactedOrNull(await collectFeedbackTraceTail({ machineDir, window })) : null;
    } catch (err) {
      logger.warn(`[FeedbackEvidence] trace tail unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      machineState = redactedOrNull(await collectFeedbackMachineState({ slockHome: this.slockHome, daemonVersion }));
    } catch (err) {
      logger.warn(`[FeedbackEvidence] machine state unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { traceTail, machineState };
  }

  private async buildObservedFailureSummary(
    agentId: string,
    window: { from: string; to: string },
  ): Promise<ObservedFailureSummary | null> {
    const machineDir = this.machineDir;
    if (!machineDir) return null;
    try {
      return await collectObservedFailureSummary({
        machineDir,
        agentId,
        from: window.from,
        to: window.to,
      });
    } catch (err) {
      logger.warn(`[FeedbackTranscript] observed failure summary unavailable for agent=${agentId}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  async listSkills(agentId: string, runtimeHint?: string): Promise<{ global: SkillInfo[]; workspace: SkillInfo[] }> {
    const agent = this.agents.get(agentId);
    const idle = this.lifecycleRecords.getRestartSnapshot(agentId);
    const config = agent?.config ?? idle?.config ?? null;
    const runtime = runtimeHint || config?.runtime || "claude";
    const workspaceDir = path.join(this.dataDir, agentId);
    const hostHome = os.homedir();
    const home = agent?.runtime.currentRuntimeHomeDir
      || (config
        ? ensureRuntimeHomeDir(config, hostHome, workspaceDir, { agentId, slockHome: this.slockHome })
        : runtime === "codex"
          ? resolveCodexHomeRootFromEnv(process.env, { defaultHomeDir: hostHome, cwd: workspaceDir })
          : hostHome);

    const paths = AgentProcessManager.SKILL_PATHS[runtime] || AgentProcessManager.SKILL_PATHS.claude;

    const globalDirs = runtime === "codex"
      ? [
        path.join(home, "skills"),
        path.join(home, "skills", ".system"),
        path.join(home, ".agents", "skills"),
        ...(hasConfiguredCodexHome(config) ? [] : [path.join(hostHome, ".agents", "skills")]),
      ]
      : paths.global.map((p) => path.join(home, p));
    const workspaceDirs = paths.workspace.map((p) => path.join(workspaceDir, p));

    const globalResults = await Promise.all(
      globalDirs.map((dir) => this.scanSkillsDir(dir)),
    );
    const workspaceResults = await Promise.all(
      workspaceDirs.map((dir) => this.scanSkillsDir(dir)),
    );

    // Deduplicate by skill name (first occurrence wins)
    const dedup = (skills: SkillInfo[]) => {
      const seen = new Set<string>();
      return skills.filter((s) => {
        if (seen.has(s.name)) return false;
        seen.add(s.name);
        return true;
      });
    };

    // Shorten home directory to ~ in source paths
    const shorten = (skills: SkillInfo[]) =>
      skills.map((s) => ({
        ...s,
        sourcePath: s.sourcePath?.startsWith(home) ? "~" + s.sourcePath.slice(home.length) : s.sourcePath,
      }));

    return {
      global: shorten(dedup(globalResults.flat())),
      workspace: shorten(dedup(workspaceResults.flat())),
    };
  }

  private async scanSkillsDir(dir: string): Promise<SkillInfo[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const skills: SkillInfo[] = [];
    for (const entry of entries) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        // Standard skill: directory (or symlink to directory) with SKILL.md
        const skillMd = path.join(dir, entry.name, "SKILL.md");
        try {
          const content = await readFile(skillMd, "utf-8");
          const skill = this.parseSkillMd(entry.name, content);
          skill.sourcePath = dir;
          skills.push(skill);
        } catch {
          // No SKILL.md — skip
        }
      } else if (entry.name.endsWith(".md")) {
        // Legacy command: bare .md file (e.g. ~/.claude/commands/foo.md)
        const cmdName = entry.name.replace(/\.md$/, "");
        try {
          const content = await readFile(path.join(dir, entry.name), "utf-8");
          const skill = this.parseSkillMd(cmdName, content);
          skill.sourcePath = dir;
          skills.push(skill);
        } catch {
          // Unreadable — skip
        }
      }
    }
    return skills;
  }

  private parseSkillMd(dirName: string, content: string): SkillInfo {
    const info: SkillInfo = {
      name: dirName,
      displayName: dirName,
      description: "",
      userInvocable: false,
    };

    const frontmatter = parseSkillFrontmatter(content);
    if (frontmatter.name !== undefined) info.displayName = frontmatter.name;
    // Trimmed here rather than in the parser: the parser reports YAML truth,
    // including the trailing newline that distinguishes clip from strip from
    // keep, and SkillInfo.description is a presentation field where that
    // newline is noise. Chomping stays observable to anyone parsing directly.
    if (frontmatter.description !== undefined) info.description = frontmatter.description.trim();
    if (frontmatter["user-invocable"] !== undefined) {
      info.userInvocable = frontmatter["user-invocable"] === "true";
    }
    return info;
  }

  // Private methods

  /**
   * Broadcast an activity change — emits a single agent:activity event that carries
   * both the status (for the dot indicator) and trajectory entries (for the activity log).
   *
   * TODO(lifecycle-v2/daemon-protocol): split this legacy frame into
   * structured lifecycle producers. Runtime progress, transient heartbeat,
   * provider/runtime error, process exit, and user-visible activity entries
   * should carry explicit reason/correlation/window attrs so the server no
   * longer infers lifecycle semantics from generic activity strings.
   */
  /** task #166: record how many agents are mid-turn (working/thinking) for the Computer's quiet point. */
  private noteTurnActivity(): void {
    let active = 0;
    for (const agent of this.agents.values()) {
      if (agent.lastActivityKind === "working" || agent.lastActivityKind === "thinking") active += 1;
    }
    this.turnActivity.update(active);
  }

  private broadcastActivity(
    agentId: string,
    activityKind: AgentActivityKind,
    detail: string,
    extraTrajectory: TrajectoryEntry[] = [],
    launchIdOverride?: string | null,
    detailKind?: AgentActivityDetailKind,
    activityDisplay: string = activityKind,
    // APM 1.6 6b: closed subagent lineage marker attached to the built status
    // entry so lineage-bearing activity groups under a subagent card. Never
    // inferred; carries only ids/bounded tokens, no raw content.
    subagentLineage?: SubagentLineage["subagent"],
    runtimeError?: RuntimeErrorActivityDiagnostic,
    deliveryConsumption?: DeliveryConsumptionActivityDiagnostic,
    compaction?: RuntimeCompactionInterruption,
    // What the runtime reported for a finished tool call (tool_end frames only).
    toolOutcome?: ToolCallOutcome,
    // The message that opened a turn ("Message received" frames only), so the
    // server can show the running turn's trigger before its summary arrives.
    turnTrigger?: ActivityTurnTrigger,
  ) {
    const ap = this.agents.get(agentId);
    // Reconciler step 4a: while an invalid record another agent reported
    // holds this process, its idle status is the held notice. Step 4b: the
    // frame carries the reason typed (`credentialHold`), so the web can show
    // it without reading the text; every other frame omits it.
    let credentialHold: CredentialHoldActivityDiagnostic | undefined;
    if (ap && activityKind === "online" && detailKind === "idle") {
      const notice = this.credentialInvalidHeldNotice(agentId, ap);
      if (notice) {
        detail = notice.text;
        credentialHold = { reason: notice.record.invalidReason };
        this.noteCredentialInvalidHeldNoticeShown(agentId, ap, notice, "idle");
      }
    }

    // Build trajectory: any extra entries (thinking/text/tool_start) + a status entry.
    // Tool starts and thinking progress already convey the activity. Keep their live
    // activity update, but do not add a redundant (or blank) status row to the log.
    const entries: TrajectoryEntry[] = [...extraTrajectory];
    const hasToolStart = entries.some((e) => e.kind === "tool_start");
    const isTrajectoryProgressFrame =
      detail === "" &&
      (detailKind === "thinking_started" || detailKind === "model_response_started") &&
      entries.every((e) => e.kind === "thinking" || e.kind === "text");
    if (!hasToolStart && !isTrajectoryProgressFrame) {
      entries.push({
        kind: "status",
        activity: activityKind,
        detail,
        detailKind,
        ...(subagentLineage ? { subagent: subagentLineage } : {}),
        ...(compaction ? { compaction } : {}),
        ...(toolOutcome ? { tool: toolOutcome } : {}),
        ...(turnTrigger ? { trigger: turnTrigger } : {}),
      });
    }
    // Task #17: fold this frame into the agent's turn summary; the frame that
    // ends the turn carries the summary entry. Any frame may also carry an
    // empty wake the tracker held and now publishes as it was: first, since
    // that turn ended before this frame (readers take a turn_summary as an
    // end, which must not cut off this frame's own work).
    // Only a trajectory progress frame's text is the runtime's output (the
    // turn's last text); the text rows of error, reconnect and recovery
    // frames are the daemon's own diagnostics.
    const now = Date.now();
    const observed = isTrajectoryProgressFrame ? entries : entries.filter((entry) => entry.kind !== "text");
    entries.unshift(...this.turnSummaries.observe(agentId, observed, now));
    const turnOutcome = turnOutcomeForActivity(activityKind, detailKind);
    if (turnOutcome) entries.push(...this.turnSummaries.finish(agentId, turnOutcome, now));
    const launchId = launchIdOverride || ap?.launchId || undefined;
    const sentDetailKind = this.activitySink.publishFact({
      agentId,
      activityKind,
      detail,
      detailKind,
      entries,
      launchId,
      runtimeError,
      providerRequest: ap?.providerRequest,
      deliveryConsumption,
      toolStuck: ap ? this.currentToolStuck(ap) : undefined,
      credentialHold,
    }, this.activityProducerContext(ap));
    if (!sentDetailKind) return;

    // Manage heartbeat timer: keep re-sending transient activities (working/thinking)
    // every ACTIVITY_HEARTBEAT_MS to prevent the server's stale-activity sweep from
    // resetting the status to "online" during long-running operations.
    if (ap) {
      ap.lastActivityKind = activityKind;
      this.noteTurnActivity();
      ap.lastActivity = activityDisplay;
      ap.lastActivityDetail = detail;
      ap.lastActivityDetailKind = sentDetailKind;
      if (activityKind === "working" || activityKind === "thinking") {
        if (ap.activityHeartbeat.kind === "inactive") {
          const timer = setInterval(() => {
            this.reportStuckToolCallIfNeeded(agentId, ap);
            if (this.markRuntimeProgressStaleIfNeeded(agentId, ap)) return;
            this.recordRuntimeTraceEvent(agentId, ap, "activity.heartbeat.sent", {
              activity: ap.lastActivityKind,
              detailKind: ap.lastActivityDetailKind,
            });
            this.activitySink.publishHeartbeat({
              agentId,
              activityKind: ap.lastActivityKind,
              providerRequest: ap.providerRequest,
              detail: ap.lastActivityDetail,
              detailKind: ap.lastActivityDetailKind,
              launchId: launchIdOverride || ap.launchId || undefined,
              toolStuck: this.currentToolStuck(ap),
            }, this.activityProducerContext(ap));
          }, ACTIVITY_HEARTBEAT_MS);
          ap.activityHeartbeat = { kind: "active", timer };
        }
      } else {
        // Non-transient activity (online/offline) — stop heartbeat
        this.clearActivityHeartbeat(ap);
      }
    }
  }

  /**
   * Task #17: publish a held empty wake (TurnSummaryTracker.release) when the
   * agent's process goes away without a frame of its own to carry it. It
   * rides on a re-statement of the agent's current activity under its
   * current launch: the server's launch guard accepts it and the live state
   * stays as it was. Only a state the frame alone describes (idle, runtime
   * progress) is re-stated: a runtime error or an unconsumed delivery has a
   * carrier this daemon no longer holds, and re-stating it without that
   * would rewrite the server's record. The held wake is lost then.
   */
  private publishReleasedTurn(agentId: string, ap: AgentProcess): void {
    const entries = this.turnSummaries.release(agentId);
    if (entries.length === 0) return;
    const restatable = (ap.lastActivityKind === "online" && ap.lastActivityDetailKind === "idle")
      || isRuntimeProgressDetailKind(ap.lastActivityDetailKind);
    if (!restatable) return;
    this.activitySink.publishFact({
      agentId,
      activityKind: ap.lastActivityKind,
      detail: ap.lastActivityDetail,
      detailKind: ap.lastActivityDetailKind,
      entries,
      launchId: ap.launchId || undefined,
      providerRequest: ap.providerRequest,
      toolStuck: this.currentToolStuck(ap),
      credentialHold: this.shownCredentialHold(agentId, ap, ap.lastActivityKind, ap.lastActivityDetailKind),
    }, this.activityProducerContext(ap));
  }

  /**
   * Reconciler step 4b: the typed reason of the held notice a re-stated
   * frame (probe reply, released turn) carries, when the state it re-states
   * is the idle status showing that notice. Undefined otherwise.
   */
  private shownCredentialHold(
    agentId: string,
    ap: AgentProcess,
    activityKind: AgentActivityKind,
    detailKind: AgentActivityDetailKind | undefined,
  ): CredentialHoldActivityDiagnostic | undefined {
    if (activityKind !== "online" || detailKind !== "idle") return undefined;
    if (ap.credentialInvalidVisibility?.kind !== "notice") return undefined;
    const notice = this.credentialInvalidHeldNotice(agentId, ap);
    return notice ? { reason: notice.record.invalidReason } : undefined;
  }

  /** What the produced-activity trace records about the agent process. */
  private activityProducerContext(ap: AgentProcess | undefined): ActivityProducerContext {
    const runtimeContext = ap?.config.runtimeContext;
    return {
      present: Boolean(ap),
      serverId: runtimeContext?.serverId,
      machineId: runtimeContext?.machineId,
      processInstanceId: ap?.processInstanceId,
      sessionIdPresent: Boolean(ap?.sessionId),
      runtime: ap?.config.runtime,
    };
  }

  /**
   * Respond to a server-issued `agent:activity_probe`. Echoes the
   * agent's current `lastActivity` back through the existing
   * `agent:activity` upstream channel with the matching `probeId`.
   *
   * Why this exists: the server's stale-activity sweep used to
   * synthesize `online` whenever a transient state went 90s without
   * an update. That invented state without consulting ground truth
   * and produced "agent shows green/idle but is actually working" UI
   * staleness (#engineering:72283cf7 task #340 RCA).
   *
   * The new flow: server sends `agent:activity_probe` for stale
   * agents, daemon replies here with the *real* current activity, and
   * the server only falls back to synth-online if the probe times out
   * (5s). The body is intentionally minimal — no entries, no
   * heartbeat side-effects, no state mutation. We just echo what we
   * already know.
   *
   * If the agent is no longer running locally (`ap` undefined), we
   * report `offline` so the server stops believing the agent is busy.
   */
  public respondToActivityProbe(agentId: string, probeId: string) {
    const ap = this.agents.get(agentId);
    const stickyTerminalFailure = ap ? classifyStickyFailure(ap) : null;
    const hasPendingInjectionDebt = Boolean(ap && ap.inbox.length > 0 && !stickyTerminalFailure && !this.credentialInvalidHold(agentId, ap.config));
    const activityKind: AgentActivityKind = hasPendingInjectionDebt ? "working" : ap?.lastActivityKind || "offline";
    const detail = hasPendingInjectionDebt ? "Message received" : ap?.lastActivityDetail || (ap ? "" : "Agent not running");
    const detailKind: AgentActivityDetailKind = hasPendingInjectionDebt ? "message_received" : ap?.lastActivityDetailKind ?? "runtime_unavailable";
    const launchId = ap?.launchId || undefined;
    const toolStuck = ap ? this.currentToolStuck(ap) : undefined;
    const credentialHold = ap ? this.shownCredentialHold(agentId, ap, activityKind, detailKind) : undefined;
    this.activitySink.respondToProbe({ agentId, activityKind, detail, detailKind, launchId, ...(toolStuck ? { toolStuck } : {}), ...(credentialHold ? { credentialHold } : {}) }, probeId, this.activityProducerContext(ap));
    if (hasPendingInjectionDebt) {
      this.recordDaemonEvent("daemon.agent.activity_probe.pending_delivery", {
        agentId,
        probeId,
        launchId,
        runtime: ap?.config.runtime,
        inbox_count: ap?.inbox.length,
        session_id_present: Boolean(ap?.sessionId),
        session_ready_for_delivery: ap ? this.canDeliverToRuntimeSession(ap) : false,
      });
    }
  }

  private flushPendingTrajectory(agentId: string) {
    const ap = this.agents.get(agentId);
    const pending = ap?.pendingTrajectory;
    if (!ap || !pending) return;

    clearTimeout(pending.timer);
    ap.pendingTrajectory = null;

    const text = pending.text.length > MAX_TRAJECTORY_TEXT
      ? pending.text.slice(0, MAX_TRAJECTORY_TEXT) + "\u2026"
      : pending.text;
    if (!text) return;

    const entry: TrajectoryEntry = pending.kind === "thinking"
      ? { kind: "thinking", text, ...(pending.subagent ? { subagent: pending.subagent } : {}) }
      : { kind: "text", text, ...(pending.subagent ? { subagent: pending.subagent } : {}) };
    const projection = trajectoryActivityProjection(pending.kind);
    this.broadcastActivity(agentId, projection.activityKind, "", [entry], undefined, projection.detailKind);
  }

  private queueTrajectoryText(
    agentId: string,
    kind: "thinking" | "text",
    text: string,
    // APM 1.6 6b: explicit subagent lineage from the source row, if any.
    subagent?: SubagentLineage["subagent"],
  ) {
    const ap = this.agents.get(agentId);
    if (!ap) {
      this.recordDaemonEvent("daemon.agent.activity.skipped", {
        agentId,
        event_kind: kind,
        reason: "agent_process_missing",
        text_length: text.length,
      });
      return;
    }

    const projection = trajectoryActivityProjection(kind);
    if (!text) {
      this.broadcastActivity(agentId, projection.activityKind, "", [], undefined, projection.detailKind);
      return;
    }

    const pending = ap.pendingTrajectory;
    // Only coalesce rows that share BOTH kind and subagent lineage so a subagent
    // thinking block can't merge into a top-level one (or vice versa).
    const sameLineage = JSON.stringify(pending?.subagent ?? null) === JSON.stringify(subagent ?? null);
    if (pending && pending.kind === kind && sameLineage) {
      pending.text += text;
      clearTimeout(pending.timer);
      pending.timer = setTimeout(() => this.flushPendingTrajectory(agentId), TRAJECTORY_COALESCE_MS);
      return;
    }

    this.flushPendingTrajectory(agentId);
    if (ap.lastActivityKind !== projection.activityKind || ap.lastActivityDetailKind !== projection.detailKind) {
      this.broadcastActivity(agentId, projection.activityKind, "", [], undefined, projection.detailKind);
    }
    ap.pendingTrajectory = {
      kind,
      text,
      ...(subagent ? { subagent } : {}),
      timer: setTimeout(() => this.flushPendingTrajectory(agentId), TRAJECTORY_COALESCE_MS),
    };
  }

  private clearCompactionWatchdog(ap: AgentProcess) {
    if (ap.compaction.kind === "active" && ap.compaction.watchdog) {
      clearTimeout(ap.compaction.watchdog);
    }
    ap.compaction = { kind: "none" };
  }

  private mergeRuntimeExitTraceAttrs(runtime: RuntimeSession, attrs: Record<string, unknown>) {
    this.runtimeExitTraceAttrs.set(runtime, {
      ...(this.runtimeExitTraceAttrs.get(runtime) ?? {}),
      ...attrs,
    });
  }

  /**
   * The stalled runtime's stop escalated (reconciler step 5: the one grace,
   * then the tree kill in RuntimeSession.stop): the stall's own traces.
   */
  private noteStalledRecoveryEscalation(
    agentId: string,
    ap: AgentProcess,
    runtimeLabel: string,
    queuedMessagesAtSignal: number,
    staleForMs: number,
    graceMs: number,
  ) {
    this.mergeRuntimeExitTraceAttrs(ap.runtime, {
      stalled_recovery_sigterm_timeout: true,
      stalled_recovery_sigterm_timeout_ms: graceMs,
    });
    this.recordDaemonEvent("daemon.agent.stalled_recovery.sigterm_timeout", {
      agentId,
      launchId: ap.launchId || undefined,
      runtime: ap.config.runtime,
      model: ap.config.model,
      runtime_label: runtimeLabel,
      queued_messages_count: ap.inbox.length,
      queued_messages_at_signal: queuedMessagesAtSignal,
      stale_age_ms_at_signal: staleForMs,
      timeout_ms: graceMs,
      process_pid_present: typeof ap.runtime.pid === "number",
      session_id_present: Boolean(ap.sessionId),
      supports_stdin_notification: ap.driver.supportsStdinNotification,
      busy_delivery_mode: ap.driver.busyDeliveryMode,
    }, "error");
    this.recordDaemonEvent("daemon.runtime.stall.recovery_action", {
      ...this.processLifecycleIdentityAttrs(agentId, ap),
      action: "sigkill_escalation",
      outcome: "initiated",
      delay_ms_bucket: bucketMs(graceMs),
    }, "error");
  }

  private startCompactionWatchdog(agentId: string, ap: AgentProcess, cycle: { cycleId?: number; startedIdle?: boolean } = {}) {
    const previous = ap.compaction;
    // A repeated start of the cycle already open keeps how that cycle began.
    const repeated = previous.kind === "active" && (cycle.cycleId === undefined || cycle.cycleId === previous.cycleId);
    const startedIdleOn = repeated ? previous.startedIdleOn : cycle.startedIdle ? ap.runtime : undefined;
    this.clearCompactionWatchdog(ap);
    const startedAt = Date.now();
    const watchdog = setTimeout(() => {
      this.markCompactionStale(agentId, startedAt);
    }, COMPACTION_STALE_MS);
    ap.compaction = {
      kind: "active",
      startedAt,
      watchdog,
      ...(cycle.cycleId === undefined ? {} : { cycleId: cycle.cycleId }),
      ...(startedIdleOn ? { startedIdleOn } : {}),
    };
  }

  /** Whether a finish or interruption is the open idle cycle's own end: same runtime, same producer cycle id. */
  private endsIdleCompactionCycle(ap: AgentProcess, cycle: AgentProcessCompactionState | undefined, cycleId: number | undefined): boolean {
    return cycle?.kind === "active"
      && cycle.startedIdleOn === ap.runtime
      && cycle.cycleId !== undefined
      && cycleId === cycle.cycleId;
  }

  /**
   * task #1362: the finish or interruption of a compaction held by
   * `compactionAfterRunEnd`. Records the end and closes the watchdog; returns
   * false (nothing to do) for a repeated end. The
   * compaction gate stays shut: input still waits for the turn end.
   */
  private endCompactionAfterRunEnd(
    agentId: string,
    ap: AgentProcess,
    cycleId: number | undefined,
    traceName: "runtime.context_compaction.finished" | "runtime.context_compaction.interrupted",
    traceAttrs: Record<string, unknown> = {},
  ): boolean {
    // Another cycle's end never gets here: the cycle-mismatch guard before this
    // drops it while the held cycle is open, and once it has ended any end is a repeat.
    const held = ap.compactionAfterRunEnd!;
    if (held.ended) {
      this.recordRuntimeTraceEvent(agentId, ap, traceName, { ...traceAttrs, stray: true, after_run_end: true, compaction_cycle_id_present: cycleId !== undefined });
      return false;
    }
    held.ended = true;
    this.recordRuntimeTraceEvent(agentId, ap, traceName, { ...traceAttrs, after_run_end: true, awaiting_turn_end: !held.turnEnded, compaction_cycle_id_present: cycleId !== undefined });
    this.clearCompactionWatchdog(ap);
    return true;
  }

  /** task #1362: both the held compaction's end and the turn end are in: open the gate and deliver what waited, once, as idle. */
  private releaseCompactionAfterRunEnd(agentId: string, ap: AgentProcess, options: { showQuietStatus: boolean }): void {
    ap.compactionAfterRunEnd = undefined;
    this.commitGatedSteeringDecisionState(agentId, ap, reduceApmGatedCompaction(ap.gatedSteering, { kind: "compaction_finished" }).nextState);
    // Only reached after the turn end, which left its reconcile and rotation check to this release.
    this.restoreIdleAfterIdleCompaction(agentId, ap, { ...options, rotateSessionIfDue: true });
  }

  /**
   * A compaction that ran on an idle agent ended without any turn taking over:
   * the agent is idle again. Its queued messages are delivered the way a turn
   * end delivers them; without any, it goes back to its quiet status. The
   * compaction gate held new messages until now.
   */
  private restoreIdleAfterIdleCompaction(agentId: string, ap: AgentProcess, options: { showQuietStatus: boolean; rotateSessionIfDue?: boolean }): void {
    // A turn-end compaction through the runtime's API is still running: its settle releases (releaseDriverCompactionHold).
    if (this.driverCompactionHolds(ap)) return;
    this.recordRuntimeTraceEvent(agentId, ap, "runtime.context_compaction.idle_restored", { inboxCount: ap.inbox.length });
    const reduction = reduceApmGatedTurnEnd(ap.gatedSteering, {
      inboxLength: ap.inbox.length,
      supportsStdinNotification: ap.driver.supportsStdinNotification,
      hasSession: this.canDeliverToRuntimeSession(ap),
      canDeliverWithoutSession: !ap.driver.requiresSessionInitForDelivery,
      terminateProcessOnTurnEnd: false,
    });
    this.commitGatedSteeringDecisionState(agentId, ap, reduction.nextState);
    const deliverStdinEffect = reduction.effects.find((effect) => effect.kind === "deliver_stdin");
    if (deliverStdinEffect && this.executeApmGatedSteeringEffect(agentId, ap, deliverStdinEffect)) {
      this.completePendingTrackedMentions(agentId);
      return;
    }
    this.commitApmIdleState(agentId, ap, true);
    if (options.showQuietStatus) this.broadcastQuietTurnStatus(agentId, ap);
    // Server features: back to idle, as at a turn end. A turn end that waited for
    // this (task #1362) also owes its session rotation check, as that turn end would
    // have done; a delivery above started a new turn, whose own end checks again.
    if (!this.reconcile(agentId, ap, "turn_end") && options.rotateSessionIfDue) this.rotateRuntimeSessionIfDue(agentId, ap);
  }

  private markCompactionStale(agentId: string, startedAt: number) {
    const ap = this.agents.get(agentId);
    if (!ap || ap.compaction.kind !== "active" || ap.compaction.startedAt !== startedAt) return;
    ap.compaction = { ...ap.compaction, watchdog: null };
    this.broadcastActivity(agentId, "working", "Context compaction still running; no finish event observed", [], undefined, "compaction_stale");
  }

  private startReviewWatchdog(agentId: string, ap: AgentProcess) {
    this.clearReviewWatchdog(ap);
    const startedAt = Date.now();
    const watchdog = setTimeout(() => {
      this.markReviewStale(agentId, startedAt);
    }, REVIEW_STALE_MS);
    ap.review = { kind: "active", startedAt, watchdog };
  }

  private clearReviewWatchdog(ap: AgentProcess) {
    if (ap.review.kind === "active" && ap.review.watchdog) {
      clearTimeout(ap.review.watchdog);
    }
    ap.review = { kind: "none" };
  }

  private markReviewStale(agentId: string, startedAt: number) {
    const ap = this.agents.get(agentId);
    if (!ap || ap.review.kind !== "active" || ap.review.startedAt !== startedAt) return;
    ap.review = { ...ap.review, watchdog: null };
    this.broadcastActivity(agentId, "working", "Review mode still active; no finish event observed", [], undefined, "review_stale");
    // Restore delivery — suppress was gated on ap.gatedSteering.reviewing, which is now resolved via review_finished below.
    const reduction = reduceApmGatedReview(ap.gatedSteering, { kind: "review_finished" });
    this.commitGatedSteeringDecisionState(agentId, ap, reduction.nextState);
    this.flushReviewBoundaryMessages(agentId, ap);
  }

  private completeCompactionIfActive(
    agentId: string,
    detail = "Context compaction finished",
    options: { flushBoundaryMessages?: boolean } = {},
  ) {
    const ap = this.agents.get(agentId);
    if (!ap || ap.compaction.kind !== "active") return;
    this.clearCompactionWatchdog(ap);
    this.broadcastActivity(agentId, "working", detail, [{ kind: "compaction_finished" }], undefined, "compaction_finished");
    const reduction = reduceApmGatedCompaction(ap.gatedSteering, { kind: "compaction_finished" });
    this.commitGatedSteeringDecisionState(agentId, ap, reduction.nextState);
    if (options.flushBoundaryMessages ?? true) {
      this.flushCompactionBoundaryMessages(agentId, ap);
    }
    this.commitApmIdleState(agentId, ap, false);
  }

  private interruptCompactionIfActive(
    agentId: string,
    options: {
      detail?: string;
      detailKind?: AgentActivityDetailKind;
      entries?: TrajectoryEntry[];
      flushBoundaryMessages?: boolean;
      traceAttrs?: Record<string, unknown>;
    } = {},
  ) {
    const ap = this.agents.get(agentId);
    if (!ap || (ap.compaction.kind !== "active" && !ap.gatedSteering.compacting)) return false;
    this.clearCompactionWatchdog(ap);
    const reduction = reduceApmGatedCompaction(ap.gatedSteering, { kind: "compaction_interrupted" });
    this.commitGatedSteeringDecisionState(agentId, ap, reduction.nextState);
    if (options.traceAttrs) {
      this.recordRuntimeTraceEvent(agentId, ap, "runtime.context_compaction.interrupted", options.traceAttrs);
    }
    if (options.detail) {
      this.broadcastActivity(
        agentId,
        "error",
        options.detail,
        options.entries ?? [],
        undefined,
        options.detailKind ?? "runtime_error",
      );
    }
    if (options.flushBoundaryMessages) {
      this.flushCompactionBoundaryMessages(agentId, ap);
    }
    return true;
  }

  private flushReviewBoundaryMessages(agentId: string, ap: AgentProcess) {
    const reduction = reduceApmGatedReviewBoundaryFlush(ap.gatedSteering, {
      hasSession: Boolean(ap.sessionId),
      supportsStdinNotification: ap.driver.supportsStdinNotification,
      inboxLength: ap.inbox.length,
      pendingNotificationCount: ap.notifications.pendingCount,
    });
    for (const effect of reduction.effects) {
      this.executeApmGatedSteeringEffect(agentId, ap, effect);
    }
  }

  private interruptReviewIfActive(agentId: string) {
    const ap = this.agents.get(agentId);
    if (!ap?.gatedSteering.reviewing) return;
    const reduction = reduceApmGatedReview(ap.gatedSteering, { kind: "review_finished" });
    this.commitGatedSteeringDecisionState(agentId, ap, reduction.nextState);
  }

  private messagesTraceAttrs(messages?: AgentMessage[]): Record<string, unknown> {
    return messagesTraceAttrs(messages, (message) => this.getDeliveryTraceContext(message).deliveryId);
  }

  private recordAttentionHintsShown(agentId: string, rows: readonly AgentInboxTargetRow[], source: string): void {
    for (const row of rows) {
      const hint = row.attentionHint;
      if (!hint) continue;
      this.recordDaemonEvent("attention_hint_shown", {
        agentId,
        trigger: hint.trigger,
        scope: hint.scope,
        suggested_command: hint.suggested_command,
        copy_version: hint.copy_version,
        epoch_ms: Date.now(),
        source,
        target: row.target,
        K: hint.thresholds.K,
        k: hint.thresholds.k,
        window_ms: hint.thresholds.window_ms,
      });
    }
  }

  private runtimeProfileTurnControlTraceAttrs(control: RuntimeProfileTurnControl | null): Record<string, unknown> {
    if (!control) return {};
    const pendingAgeMs = Math.max(0, Date.now() - control.injectedAtMs);
    return {
      runtime_profile_control_kind: control.kind,
      runtime_profile_control_source: control.source,
      runtime_profile_key_hash: control.keyHash || undefined,
      runtime_profile_key_present: control.keyPresent,
      runtime_profile_pending_age_ms: pendingAgeMs,
      runtime_profile_requires_ack: false,
    };
  }

  private activateRuntimeProfileTurnControl(
    ap: AgentProcess,
    control: RuntimeProfileTurnControl | null,
  ): void {
    ap.runtimeProfileTurnControl = control;
  }

  private runtimeProfileTurnControlFromMessages(
    messages?: AgentMessage[],
    source: RuntimeProfileControlSource = "message",
  ): RuntimeProfileTurnControl | null {
    const notifications = messages
      ?.map((message) => runtimeProfileNotificationFromMessage(message))
      .filter((candidate): candidate is { kind: RuntimeProfileControlKind; key: string } => Boolean(candidate)) ?? [];
    const notification = notifications.find((candidate) => candidate.kind === "migration")
      ?? notifications[0];
    if (!notification) return null;
    return runtimeProfileTurnControl(notification.kind, notification.key, source);
  }

  private finalizeRuntimeProfileTurnControl(agentId: string, ap: AgentProcess, terminal: "turn_end" | "runtime_error" | "runtime_stalled" | "process_exit"): Record<string, unknown> {
    const control = ap.runtimeProfileTurnControl;
    if (!control) return {};
    const attrs = this.runtimeProfileTurnControlTraceAttrs(control);
    ap.runtimeProfileTurnControl = null;
    return {
      ...attrs,
      runtime_profile_turn_terminal: terminal,
      runtime_profile_turn_outcome: control.kind === "migration"
        ? "reset_session_notice"
        : "notice_only",
    };
  }

  private startRuntimeTrace(
    agentId: string,
    ap: AgentProcess,
    reason: string,
    messages?: AgentMessage[],
    inputTraceAttrs: Record<string, unknown> = {},
  ): ActiveSpan {
    if (ap.runtimeTraceSpan) return ap.runtimeTraceSpan;
    ap.runtimeTraceCounters = createRuntimeTraceCounters();
    ap.endedRuntimeTurnTraceContext = null;

    const messageControl = this.runtimeProfileTurnControlFromMessages(messages);
    if (messageControl) {
      this.activateRuntimeProfileTurnControl(ap, messageControl);
    }

    // Callers that know the trigger better (app inbox, restart) pass trigger_kind.
    const triggerAttrs = inputTraceAttrs.trigger_kind === undefined
      ? messageTurnTriggerAttrs(messages, this.clockNow(), (message) => this.deliveryReceivedAtMs.get(message))
      : {};
    // RFC 070 §6.5: any turn that starts before the warm-recycle stop drops it
    // (an app item or reminder is a delivery; a turn the daemon or the runtime
    // opened is just "no longer idle").
    const triggerKind = String(inputTraceAttrs.trigger_kind ?? triggerAttrs.trigger_kind ?? "other");
    const appDelivery = triggerKind === "app" || triggerKind === "reminder";
    this.cancelWarmRecycle(agentId, ap, messages?.length
      ? { reason: "delivery", senderKind: warmRecycleSenderKind(messages[0]!.sender_type), triggerKind }
      : appDelivery ? { reason: "delivery", senderKind: "app", triggerKind } : { reason: "not_idle", triggerKind });
    const span = this.tracer.startSpan("daemon.runtime.turn", {
      parent: getActiveTraceContext(),
      surface: "daemon",
      kind: "internal",
      attrs: {
        agentId,
        runtime: ap.config.runtime,
        model: ap.config.model,
        runtime_cli_version: this.runtimeCliVersionOf(ap),
        reason,
        hasSession: Boolean(ap.sessionId),
        sessionReadyForDelivery: ap.sessionReadyForDelivery,
        ...this.processLifecycleIdentityAttrs(agentId, ap),
        ...this.messagesTraceAttrs(messages),
        ...triggerAttrs,
        ...inputTraceAttrs,
        ...this.runtimeLaunchPolicyTraceAttrs(ap.config),
        ...this.runtimeProfileTurnControlTraceAttrs(ap.runtimeProfileTurnControl),
        ...piTurnFlagTraceAttrs(ap.config),
      },
    });
    span.addEvent("daemon.turn.started", {
      reason,
      sessionReadyForDelivery: ap.sessionReadyForDelivery,
      ...this.processLifecycleIdentityAttrs(agentId, ap),
      ...this.messagesTraceAttrs(messages),
      ...triggerAttrs,
      ...inputTraceAttrs,
      ...this.runtimeLaunchPolicyTraceAttrs(ap.config),
      ...this.runtimeProfileTurnControlTraceAttrs(ap.runtimeProfileTurnControl),
    });
    ap.runtimeTraceSpan = span;
    return span;
  }

  /**
   * The CLI version this process runs: what its driver read at spawn, else the
   * version the daemon last detected for the runtime. Kept once known.
   */
  private runtimeCliVersionOf(ap: AgentProcess): string | undefined {
    ap.runtimeCliVersion ??= ap.driver.launchedCliVersion || this.#detectedRuntimeCliVersion(ap.config.runtime || "claude") || null;
    return ap.runtimeCliVersion ?? undefined;
  }

  // Every way a turn ends names its outcome, so the turn span never ends
  // without one.
  private endRuntimeTrace(
    ap: AgentProcess,
    status: "ok" | "error" | "cancelled",
    attrs: { outcome: RuntimeTurnTraceOutcome } & Record<string, unknown>,
  ) {
    if (!ap.runtimeTraceSpan) return;
    ap.runtimeTraceSpan.end(status, { attrs: { ...attrs, ...this.takePassiveRenderTraceAttrs(ap) } });
    // Only a runtime error leaves its turn open (more errors may follow before
    // the turn end); any other end (idle, stall, delivery failure) closes it.
    ap.endedRuntimeTurnTraceContext = attrs.outcome === "runtime-error" ? ap.runtimeTraceSpan.context : null;
    ap.runtimeTraceSpan = null;
  }

  /**
   * Glimpse layer 2: what the agent's raft CLI printed of passive AX during
   * the turn now ending, taken out of its ledger (passiveRenderCounts.ts).
   * Only with passive AX on for this launch; otherwise no attributes.
   */
  private takePassiveRenderTraceAttrs(ap: AgentProcess): Record<string, unknown> {
    if (!ap.passiveAx) return {};
    // Must never stop the span from ending.
    try {
      const take = takePassiveRenderCounts(ap.agentLedgerPath);
      const carriedOver = ap.passiveRenderTakeFailed === true;
      ap.passiveRenderTakeFailed = take.outcome === "ledger_busy" || take.outcome === "unknown_version" || take.outcome === "unavailable";
      return passiveRenderTraceAttrs(take, ap.contextId, carriedOver);
    } catch {
      return { passive_render_outcome: "unavailable" };
    }
  }

  // Adds the fact to the open turn span. A turn span is opened only when a
  // turn really starts, so a fact seen outside a turn becomes a standalone
  // event instead of opening a turn.
  private recordRuntimeTraceEvent(agentId: string, ap: AgentProcess, name: string, attrs?: Record<string, unknown>) {
    const eventAttrs = {
      ...this.processLifecycleIdentityAttrs(agentId, ap),
      ...attrs,
    };
    if (ap.runtimeTraceSpan) {
      addTurnSpanEvent(ap.runtimeTraceSpan, ap.runtimeTraceCounters, name, eventAttrs);
      return;
    }
    // A runtime error after its turn's span ended (a second error in the same
    // turn) still belongs to that turn: it joins the turn's trace.
    const endedTurnContext = name === "runtime.error" ? ap.endedRuntimeTurnTraceContext : null;
    this.recordDaemonEvent(
      `daemon.${name}`,
      { agentId, runtime: ap.config.runtime, ...eventAttrs },
      "ok",
      endedTurnContext ? formatTraceparent(endedTurnContext) : undefined,
    );
  }

  // task #917 — a rejected turn/start used to be restored and redelivered every
  // stdinNotificationRetryMs with no bound, so a provider that rejects every
  // prompt (Grok Build 402 "usage balance exhausted") looped into the same
  // session forever, and the same-fingerprint fence never saw it because it
  // only counted `error` events. Billing failures now stop at once; any other
  // rejected turn/start counts toward that fence. Busy rejections and steers are
  // ordinary back-pressure and never count.
  private stopOnTerminalDeliveryError(
    agentId: string,
    ap: AgentProcess,
    event: RuntimeDeliveryErrorEvent,
  ): boolean {
    if (event.code === "turn.agent_busy" || event.requestMethod !== "turn/start") return false;
    const diagnostics = buildRuntimeErrorDiagnosticEnvelope(event.message);
    let detail: string;
    const credentialInvalid = credentialInvalidReasonOf(event.message);
    if (credentialInvalid) {
      // Reconciler step 4a: an exhausted balance (task #917: Grok Build 402),
      // a rejected sign-in or a plan without the model is the credential's.
      // The process and session are kept; the rejected input goes back to
      // the inbox, held with every later delivery until the credential
      // changes or a person stops the agent (no redelivery into the same
      // rejection meanwhile).
      const invalid = this.noteCredentialInvalid(agentId, ap, credentialInvalid, event.message, "delivery_rejected");
      detail = invalid.detail;
      this.recordDaemonEvent("daemon.agent.stdin_delivery.terminal_rejected", {
        agentId,
        launchId: ap.launchId || undefined,
        runtime: ap.config.runtime,
        model: ap.config.model,
        request_method: event.requestMethod,
        source: event.source,
        runtime_error_class: diagnostics.spanAttrs.runtime_error_class,
        runtime_error_fingerprint: diagnostics.spanAttrs.runtime_error_fingerprint,
        ...invalid.traceAttrs,
      }, "error");
      this.restoreRuntimeDeliveryAfterAsyncRejection(agentId, ap, event);
    } else {
      const fingerprint = typeof diagnostics.spanAttrs.runtime_error_fingerprint === "string"
        ? diagnostics.spanAttrs.runtime_error_fingerprint
        : null;
      const fence = this.noteRuntimeErrorFingerprintFence(agentId, ap, event.message, fingerprint, null, null);
      if (!fence) return false;
      detail = fence.detail;
      this.applyRuntimeErrorFingerprintFence(agentId, ap, fence);
    }
    this.broadcastActivity(
      agentId,
      "error",
      detail,
      [{ kind: "text", text: `Error: ${detail}` }],
      ap.launchId,
      "runtime_error",
      "error",
      undefined,
      buildRuntimeErrorActivityDiagnostic(event.message),
    );
    return true;
  }

  private restoreRuntimeDeliveryAfterAsyncRejection(
    agentId: string,
    ap: AgentProcess,
    event: RuntimeDeliveryErrorEvent,
  ): void {
    const pendingBefore = ap.notifications.pendingCount;
    const restoredMessages = ap.inbox.filter((message) =>
      ap.notifications.hasContributedMessage(message, ap.sessionId)
    );
    ap.notifications.clearNoticeFingerprint();
    const restoredNotificationCount = ap.driver.supportsStdinNotification && ap.sessionId && restoredMessages.length > 0
      ? ap.notifications.add(restoredMessages.length)
      : 0;
    const busyRejection = event.code === "turn.agent_busy";
    if (event.requestMethod === "turn/start") {
      // A rejected turn/start may have carried an App Inbox notice; forget
      // which items it covered so the idle drain below offers them again.
      this.appInboxNoticedItemIds.delete(agentId);
      // The runtime said it is busy: offer again after the retry interval,
      // not on the idle transition this commit triggers.
      if (busyRejection) this.appInboxDrainDeferredUntil.set(agentId, this.clockNow() + this.stdinNotificationRetryMs);
      this.commitApmIdleState(agentId, ap, true);
    }
    const idleRetryScheduled = event.requestMethod === "turn/start" && restoredNotificationCount > 0
      ? ap.notifications.schedule(() => {
          this.flushAsyncRejectedIdleDelivery(agentId);
        }, this.stdinNotificationRetryMs)
      : false;

    const attrs = {
      request_method: event.requestMethod,
      source: event.source, error_code: event.code ?? "runtime.delivery_error",
      payloadBytes: event.payloadBytes,
      inbox_count: ap.inbox.length,
      restored_messages_count: restoredMessages.length,
      pending_notification_count_before: pendingBefore,
      pending_notification_count_after: ap.notifications.pendingCount,
      restored_notification_count: restoredNotificationCount,
      session_id_present: Boolean(ap.sessionId),
      supports_stdin_notification: ap.driver.supportsStdinNotification,
      busy_delivery_mode: ap.driver.busyDeliveryMode,
      restored_idle_state: event.requestMethod === "turn/start",
      idle_retry_scheduled: idleRetryScheduled,
      app_inbox_drain_deferred_ms: event.requestMethod === "turn/start" && busyRejection ? this.stdinNotificationRetryMs : 0,
    };
    this.recordRuntimeTraceEvent(agentId, ap, "runtime.delivery.async_rejected", attrs);
    this.recordDaemonEvent("daemon.agent.stdin_delivery.async_rejected", {
      agentId,
      launchId: ap.launchId || undefined,
      runtime: ap.config.runtime,
      model: ap.config.model,
      ...attrs,
    }, "error");
  }

  private noteRuntimeProgress(agentId: string, ap: AgentProcess, eventKind?: ParsedEvent["kind"]) {
    ap.runtimeProgress.noteRuntimeEvent(eventKind);
    this.invalidateRecoveryErrorView(ap);
    this.armStallDeadlineForQueuedWork(agentId, ap);
  }

  /**
   * Invalidate the decision-only error view on a liveness signal. The process is
   * alive and has moved past any error it logged earlier in the turn, so a stale
   * error must not keep restarting/re-routing a recovered agent. Error-class
   * agnostic; a genuinely current failure re-populates the view after this point.
   * Called on BOTH progress paths — ordinary runtime events and
   * `internal_progress` (raw runtime activity that stale-recovery already treats
   * as liveness). `recentStderr`/`lastRuntimeError` are untouched and stay full
   * for diagnostics, user-facing reporting, and sticky terminal-failure gating.
   */
  private invalidateRecoveryErrorView(ap: AgentProcess) {
    ap.decisionErrorWindow.noteRuntimeProgress();
  }

  private commitGatedSteeringDecisionState(
    agentId: string,
    ap: AgentProcess,
    nextState: ApmGatedSteeringDecisionState,
  ): void {
    const wasIdle = this.isApmIdle(ap);
    ap.gatedSteering = commitApmGatedSteeringDecisionState(nextState);
    if (ap.gatedSteering.outstandingToolUses === 0) ap.openToolCallIds?.clear();
    if (!wasIdle && this.isApmIdle(ap)) {
      // A restore after an unwritten notice is not the end of any work.
      // The `/compact` turn's own end is no end of the agent's work: its idle hooks already ran.
      const afterTurnEndCompaction = ap.turnEndCompaction?.skipNextIdleHooks === true;
      if (ap.turnEndCompaction) ap.turnEndCompaction.skipNextIdleHooks = false;
      if (!this.appInboxIdleDrains.has(agentId) && !afterTurnEndCompaction) this.notifyAgentWorkingToIdle(agentId);
      this.drainAppInboxAfterIdleTransition(agentId);
      // Only one of the two acts on a turn end: warm recycle goes first when
      // its gate passes (the session is about to be replaced; compacting it
      // first would pay for a context nothing resumes).
      if (!this.maybeMarkWarmRecycle(agentId, ap)) this.maybeCompactAtTurnEnd(agentId, ap);
    }
  }

  /**
   * RFC 070 §6.5 (wakeRecycleWarm.ts): at a clean turn end with nothing
   * running, held or queued, a session whose last request carried more than
   * the warm threshold (on a window of at least 400k) is marked. Past the
   * ceiling it is stopped now; otherwise after the quiet period, unless a
   * delivery arrives first (`cancelWarmRecycle`). Returns whether it marked.
   */
  private maybeMarkWarmRecycle(agentId: string, ap: AgentProcess): boolean {
    const config = resolveWarmRecycleConfig(ap.config);
    if (!config.enabled) return false;
    const sessionId = ap.sessionId || ap.driver.currentSessionId || null;
    // A mark cancelled before its stop (a delivery, another turn) skipped its
    // turn end's compaction: this turn end is compaction's, below the ceiling
    // (asked once; the turn end after it may mark again).
    const yieldToCompaction = sessionId ? this.warmRecycle.takeYield(agentId, sessionId) : false;
    const state = ap.turnEndCompaction;
    // The turn-end compaction gate's facts: the last result's context and the model's window.
    const decision = state && sessionId && !state.inFlight && !state.attempting && !this.warmRecycle.declined(agentId, sessionId) && this.warmRecycleStoppable(agentId, ap)
      ? decideWarmRecycleMark(config, state.facts)
      : null;
    if (!sessionId || !decision?.mark || (yieldToCompaction && decision.band === "quiet")) {
      // This turn end decides again: a mark an earlier one left is not kept past it.
      this.warmRecycle.cancel(agentId);
      return false;
    }
    const mark: WarmRecycleMark = { sessionId, contextTokens: decision.contextTokens, windowTokens: decision.windowTokens, band: decision.band, markedAtMs: this.clockNow() };
    this.warmRecycle.mark(agentId, mark, decision.band === "quiet" ? { quietMs: config.quietMs, onQuiet: () => this.stopForWarmRecycle(agentId, ap) } : null);
    const described = describeWarmRecycleMarked(this.warmRecycleTraceBase(agentId, ap), mark, config);
    this.recordDaemonEvent(WARM_RECYCLE_MARKED_EVENT, described.attrs);
    logger.info(described.logLine);
    // After this turn end's own handling has finished; decided again there.
    if (decision.band === "ceiling") queueMicrotask(() => this.stopForWarmRecycle(agentId, ap));
    return true;
  }

  private warmRecycleTraceBase(agentId: string, ap: AgentProcess) {
    return { agentId, launchId: ap.launchId || undefined, runtime: ap.config.runtime, host: "legacy" as const };
  }

  /**
   * Whether this process may be marked, and later stopped, for a warm
   * recycle: a runtime whose facts the next start reads, on a CLI the
   * cold-idle stop trusts to show its background tasks, idle as the cold-idle
   * stop reads it (agentNotIdle), with the last turn ended by the runtime
   * itself and no failure, compaction, stop or delivery in the way.
   */
  private warmRecycleStoppable(agentId: string, ap: AgentProcess): boolean {
    const runtime = ap.config.runtime ?? "claude";
    if (this.agents.get(agentId) !== ap || ap.exit.kind !== "live") return false;
    if (ap.driver.lifecycle.kind === "per_turn" || !warmRecycleCoversRuntime("legacy", runtime, ap.config)) return false;
    if (!runtimeVersionAllowsColdIdle(runtime, COLD_IDLE_RUNTIME_VERSION_FLOORS[runtime] ? this.runtimeCliVersionOf(ap) : undefined)) return false;
    if (ap.gatedSteering.expectedTerminationReason !== null || this.runtimeStopping(ap)) return false;
    if (ap.lastTurnEndInterrupted === true) return false;
    if (ap.gatedSteering.compacting || ap.compaction?.kind === "active") return false;
    if (this.agentNotIdle(agentId, ap) !== null) return false;
    if (this.hasUntoldInboxWork(ap) || this.appInboxIdleDrains.has(agentId) || this.appInboxDeferredDrainTimers.has(agentId)) return false;
    // A drain holds deliveries (a transient one is routed again at its end): nothing is stopped under it.
    if (this.drain.holds(agentId)) return false;
    return !(this.runtimeErrorDeliveryBackoffRemainingMs(ap) > 0 || Boolean(classifyStickyFailure(ap)) || Boolean(ap.lastRuntimeError) || Boolean(this.credentialInvalidHold(agentId, ap.config)));
  }

  /**
   * The warm-recycle stop: everything is decided again (the quiet period
   * passed, or the mark's own turn end finished), then the process is stopped
   * through the cold-idle stop, keeping its session; the next start finds the
   * stop remembered and recycles (`planWakeSessionRecycle`, `warmStop`).
   */
  private stopForWarmRecycle(agentId: string, ap: AgentProcess): void {
    const mark = this.warmRecycle.pending(agentId);
    if (!mark) return;
    const sessionId = ap.sessionId || ap.driver.currentSessionId || null;
    if (sessionId !== mark.sessionId || !resolveWarmRecycleConfig(ap.config).enabled || !this.warmRecycleStoppable(agentId, ap)) {
      this.cancelWarmRecycle(agentId, ap, { reason: "not_idle" });
      return;
    }
    const nowMs = this.clockNow();
    this.warmRecycle.stopped(agentId, nowMs);
    const described = describeWarmRecycleStopped(this.warmRecycleTraceBase(agentId, ap), mark, nowMs);
    this.recordDaemonEvent(WARM_RECYCLE_STOPPED_EVENT, described.attrs);
    logger.info(described.logLine);
    this.beginColdIdleRecycleStop(agentId, ap, "Warm recycle", "warm_recycle");
  }

  /** A delivery (or a turn the session started) before the stop: the session keeps running, and its next clean turn end decides again. */
  private cancelWarmRecycle(agentId: string, ap: AgentProcess, cause: { reason: WarmRecycleCancelReason; senderKind?: WarmRecycleSenderKind; triggerKind?: string }): void {
    // The mark skipped its turn end's compaction: the next turn end is compaction's (`takeYield`).
    const mark = this.warmRecycle.cancel(agentId, { yieldNext: true });
    if (!mark) return;
    const described = describeWarmRecycleCancelled(this.warmRecycleTraceBase(agentId, ap), mark, this.clockNow(), cause);
    this.recordDaemonEvent(WARM_RECYCLE_CANCELLED_EVENT, described.attrs);
    logger.info(described.logLine);
  }

  /**
   * #proj-runtime:#54 phase 3: at a turn end with nothing running, held or
   * queued, a Claude session whose last request carried more than the
   * threshold (on a window of at least 400k) is asked to compact with
   * Claude Code's own `/compact`, as a turn of its own. A delivery that
   * arrives meanwhile waits as it does behind any turn; the turn's end
   * settles the outcome (`settleTurnEndCompaction`).
   */
  private maybeCompactAtTurnEnd(agentId: string, ap: AgentProcess): void {
    if (!TURN_END_COMPACTION_LEGACY_RUNTIMES.has(ap.config.runtime ?? "")) return;
    const config = resolveTurnEndCompactionConfig(ap.config);
    if (!config.enabled) return;
    const state = (ap.turnEndCompaction ??= createLegacyTurnEndCompactionState());
    if (state.inFlight || state.attempting) return;
    // In-process runtimes (Pi, Built-in, Kimi SDK) compact through their own API, not a `/compact` turn.
    if (ap.runtime.compactAtTurnEnd && ap.runtime.turnEndContextFacts) {
      void this.compactThroughDriverAtTurnEnd(agentId, ap, config, state);
      return;
    }
    const sessionId = ap.sessionId || ap.driver.currentSessionId || null;
    const armed = state.arming.observe(sessionId, state.facts.contextTokens, config.minContextTokens);
    const decision = decideTurnEndCompaction(config, state.facts, armed);
    const base = { agentId, launchId: ap.launchId || undefined, runtime: ap.config.runtime, host: "legacy", ...turnEndCompactionTraceAttrs(config, state.facts) };
    if (!decision.fire) {
      // One event per session and reason, so a busy agent's every turn end doesn't repeat it.
      const key = `${sessionId ?? ""}:${decision.reason}`;
      if (state.lastSkipKey !== key) {
        state.lastSkipKey = key;
        this.recordDaemonEvent(TURN_END_COMPACTION_EVENT, { ...base, outcome: `skipped:${decision.reason}` });
      }
      return;
    }
    const blocked = legacyTurnEndCompactionPreconditionFailure({
      notIdleReason: this.agentNotIdle(agentId, ap),
      compacting: ap.gatedSteering.compacting || ap.compaction?.kind === "active",
      stopping: ap.gatedSteering.expectedTerminationReason !== null || this.runtimeStopping(ap),
      untoldInbox: this.hasUntoldInboxWork(ap) || this.appInboxIdleDrains.has(agentId),
      failureState: this.runtimeErrorDeliveryBackoffRemainingMs(ap) > 0 || Boolean(classifyStickyFailure(ap)) || Boolean(ap.lastRuntimeError) || Boolean(this.credentialInvalidHold(agentId, ap.config)),
      serverContextPending: this.serverContext.pending(agentId, { processInstanceId: ap.processInstanceId, sessionId }) !== null,
      deliverable: this.canDeliverToRuntimeSession(ap) && ap.driver.supportsStdinNotification === true,
      commandOverridden: claudeCompactCommandOverridden({
        workspaceDir: path.join(this.dataDir, agentId),
        homeDir: ap.runtime.currentRuntimeHomeDir || resolveRuntimeHomeDir(ap.config, this.runtimeSessionHomeDir, path.join(this.dataDir, agentId), { agentId, slockHome: this.slockHome }),
        claudeConfigDir: ap.config.envVars?.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR,
      }),
    });
    if (blocked) {
      // Not this turn end; the next one decides again (the arm is kept).
      this.recordDaemonEvent(TURN_END_COMPACTION_EVENT, { ...base, outcome: `skipped:${blocked}` });
      return;
    }
    // Claim the turn before writing, and give it back if the write did not land (as the subagents-finished wake does).
    // The give-back is an idle edge too: `attempting` keeps it from coming straight back here.
    state.attempting = true;
    let result: RuntimeSendResult | undefined;
    try {
      this.commitApmIdleState(agentId, ap, false);
      this.startRuntimeTrace(agentId, ap, "turn-end-compaction", undefined, { trigger_kind: "turn_end_compaction" });
      result = this.sendRuntimeInput(agentId, ap, { mode: "idle", text: "/compact", sessionId: ap.sessionId }, "turn_end_compaction");
    } finally {
      if (!result?.ok) {
        this.endRuntimeTrace(ap, "error", { outcome: "turn_end_compaction_not_written", ...runtimeTraceCounterAttrs(ap) });
        this.restoreApmIdleWithoutDrain(agentId, ap);
      }
      state.attempting = false;
    }
    if (!result.ok) {
      this.recordDaemonEvent(TURN_END_COMPACTION_EVENT, { ...base, outcome: "failed:not_written" }, "error");
      return;
    }
    state.arming.markFired();
    state.inFlight = { startedAtMs: Date.now(), finishedAtMs: null, contextTokens: state.facts.contextTokens };
    // What the runtime's own compaction shows, from the moment it is asked for: the agent already answered, and is not stuck.
    this.broadcastActivity(agentId, "working", "Compacting context", [], undefined, "compacting_context");
    this.recordDaemonEvent(TURN_END_COMPACTION_EVENT, { ...base, outcome: "started" });
  }

  /**
   * #proj-runtime:#54 phase 3 for in-process runtimes: the same decision and
   * preconditions as Claude's, then the runtime's own compaction, awaited. Its
   * compaction events gate deliveries and restore idle as any compaction's do
   * (that idle edge runs no idle hooks: `skipNextIdleHooks`). A refusal keeps
   * the arm; a failure stays disarmed until the context is back under the
   * threshold, so a compaction that fails for good (Pi: it sticks to the
   * session) is not retried at every turn end.
   */
  private async compactThroughDriverAtTurnEnd(agentId: string, ap: AgentProcess, config: ReturnType<typeof resolveTurnEndCompactionConfig>, state: LegacyTurnEndCompactionState): Promise<void> {
    state.attempting = true;
    try {
      const facts = await ap.runtime.turnEndContextFacts!();
      if (facts.contextTokens !== null) state.facts.contextTokens = facts.contextTokens;
      if (facts.windowTokens !== null) state.facts.windowTokens = facts.windowTokens;
    } catch {
      // Unknown facts never fire (decideTurnEndCompaction).
    } finally {
      state.attempting = false;
    }
    if (this.agents.get(agentId) !== ap || !this.isApmIdle(ap) || state.inFlight) return;
    const sessionId = ap.sessionId || ap.driver.currentSessionId || null;
    const armed = state.arming.observe(sessionId, state.facts.contextTokens, config.minContextTokens);
    const decision = decideTurnEndCompaction(config, state.facts, armed);
    const base = { agentId, launchId: ap.launchId || undefined, runtime: ap.config.runtime, host: "legacy", ...turnEndCompactionTraceAttrs(config, state.facts) };
    if (!decision.fire) {
      const key = `${sessionId ?? ""}:${decision.reason}`;
      if (state.lastSkipKey !== key) {
        state.lastSkipKey = key;
        this.recordDaemonEvent(TURN_END_COMPACTION_EVENT, { ...base, outcome: `skipped:${decision.reason}` });
      }
      return;
    }
    const blocked = legacyTurnEndCompactionPreconditionFailure({
      notIdleReason: this.agentNotIdle(agentId, ap),
      compacting: ap.gatedSteering.compacting || ap.compaction?.kind === "active",
      stopping: ap.gatedSteering.expectedTerminationReason !== null || this.runtimeStopping(ap),
      untoldInbox: this.hasUntoldInboxWork(ap) || this.appInboxIdleDrains.has(agentId),
      failureState: this.runtimeErrorDeliveryBackoffRemainingMs(ap) > 0 || Boolean(classifyStickyFailure(ap)) || Boolean(ap.lastRuntimeError) || Boolean(this.credentialInvalidHold(agentId, ap.config)),
      // Nothing is written to the runtime: no server context rides on it, and no command can shadow it.
      serverContextPending: false,
      deliverable: this.canDeliverToRuntimeSession(ap),
      commandOverridden: false,
    });
    if (blocked) {
      this.recordDaemonEvent(TURN_END_COMPACTION_EVENT, { ...base, outcome: `skipped:${blocked}` });
      return;
    }
    const startedAtMs = Date.now();
    state.arming.markFired();
    // The daemon's own hold, from this moment: the agent is not idle (no idle
    // writer starts a turn) and every delivery waits at the compaction gate
    // (`compactionGateClosed`) until the call settles, whatever the runtime
    // reports meanwhile (Pi: compact() and a prompt at once abort each other).
    state.inFlight = { startedAtMs, finishedAtMs: null, contextTokens: state.facts.contextTokens, viaDriver: true };
    this.commitApmIdleState(agentId, ap, false);
    this.broadcastActivity(agentId, "working", "Compacting context", [], undefined, "compacting_context");
    this.recordDaemonEvent(TURN_END_COMPACTION_EVENT, { ...base, outcome: "started" });
    // The release below is an idle edge of its own: no end of the agent's work, so it runs no idle hooks.
    state.skipNextIdleHooks = true;
    let outcome: TurnEndCompactionDriverOutcome;
    // One cap for every driver (Kimi's own wait is 10 min; Pi's compact() has
    // none): past it the waiting deliveries win over the compaction. A late
    // answer from the runtime is ignored; the hold is already gone.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<TurnEndCompactionDriverOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "failed", reason: "timeout" }), config.driverTimeoutMs);
      timer.unref?.();
    });
    try {
      outcome = await Promise.race([ap.runtime.compactAtTurnEnd!(), timedOut]);
    } catch (error) {
      outcome = { kind: "failed", reason: "threw" };
      logger.warn(`[Agent ${agentId}] Turn-end compaction failed to run: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (outcome.kind === "failed" && outcome.reason === "timeout") {
      logger.warn(`[Agent ${agentId}] Turn-end compaction did not settle within ${Math.round(config.driverTimeoutMs / 1000)}s; cancelling it, then releasing the deliveries it held`);
      // Cancel before releasing: a prompt written into a session that is still
      // compacting is refused (Pi), which would lose the message the hold kept.
      if (ap.runtime.cancelTurnEndCompaction) {
        let cancelTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          ap.runtime.cancelTurnEndCompaction().catch(() => undefined),
          new Promise<void>((resolve) => { cancelTimer = setTimeout(resolve, 10_000); cancelTimer.unref?.(); }),
        ]);
        if (cancelTimer) clearTimeout(cancelTimer);
      }
    }
    if (outcome.kind === "refused") state.arming.rearm();
    const nowMs = Date.now();
    const held = ap.inbox.length;
    let after: TurnEndContextFacts | null = null;
    if (outcome.kind === "completed" && this.agents.get(agentId) === ap) {
      try { after = await ap.runtime.turnEndContextFacts!(); } catch { after = null; }
    }
    this.recordDaemonEvent(TURN_END_COMPACTION_EVENT, {
      ...base,
      outcome: outcome.kind === "completed" ? "completed" : `${outcome.kind}:${outcome.reason}`,
      duration_ms: nowMs - startedAtMs,
      ...(after?.contextTokens != null ? { context_after_tokens: after.contextTokens } : {}),
      deliveries_held: held,
      ...(held > 0 ? { hold_ms: nowMs - startedAtMs } : {}),
    }, outcome.kind === "failed" ? "error" : "ok");
    logger.info(turnEndCompactionLogLine({ agentId, host: "legacy", outcome: outcome.kind === "completed" ? "completed" : `${outcome.kind}:${outcome.reason}`, contextTokens: state.inFlight?.contextTokens ?? null, contextAfterTokens: after?.contextTokens ?? null, durationMs: nowMs - startedAtMs }));
    this.releaseDriverCompactionHold(agentId, ap, state);
  }

  /**
   * The turn-end compaction call settled (completed, refused, failed or
   * thrown): drop the hold, close a runtime compaction it left open, and go
   * back to idle the way an idle compaction's end does, which writes what
   * waited, once, in order (restoreIdleAfterIdleCompaction).
   */
  private releaseDriverCompactionHold(agentId: string, ap: AgentProcess, state: LegacyTurnEndCompactionState): void {
    if (!state.inFlight?.viaDriver) return;
    state.inFlight = null;
    if (this.agents.get(agentId) !== ap || ap.exit.kind !== "live" || this.runtimeStopping(ap)) return;
    if (ap.compaction.kind === "active") this.clearCompactionWatchdog(ap);
    if (ap.gatedSteering.compacting) {
      this.commitGatedSteeringDecisionState(agentId, ap, reduceApmGatedCompaction(ap.gatedSteering, { kind: "compaction_finished" }).nextState);
    }
    this.restoreIdleAfterIdleCompaction(agentId, ap, { showQuietStatus: true });
  }

  /** The `/compact` turn ended: completed when Claude reported its compaction finished, else failed. */
  private settleTurnEndCompaction(agentId: string, ap: AgentProcess): void {
    const state = ap.turnEndCompaction;
    const inFlight = state?.inFlight;
    // A compaction through the runtime's API is no turn: its call's settle ends it, not a turn end.
    if (!state || !inFlight || inFlight.viaDriver) return;
    state.inFlight = null;
    state.skipNextIdleHooks = true;
    const nowMs = Date.now();
    const held = ap.inbox.length;
    this.recordDaemonEvent(TURN_END_COMPACTION_EVENT, {
      agentId,
      launchId: ap.launchId || undefined,
      runtime: ap.config.runtime,
      host: "legacy",
      outcome: inFlight.finishedAtMs !== null ? "completed" : "failed:not_compacted",
      duration_ms: nowMs - inFlight.startedAtMs,
      ...(inFlight.contextTokens !== null ? { context_tokens: inFlight.contextTokens } : {}),
      deliveries_held: held,
      // Deliveries queued behind the /compact turn waited at most this long.
      ...(held > 0 ? { hold_ms: nowMs - inFlight.startedAtMs } : {}),
    }, inFlight.finishedAtMs !== null ? "ok" : "error");
    logger.info(turnEndCompactionLogLine({ agentId, host: "legacy", outcome: inFlight.finishedAtMs !== null ? "completed" : "failed:not_compacted", contextTokens: inFlight.contextTokens, durationMs: nowMs - inFlight.startedAtMs }));
  }

  private notifyAgentWorkingToIdle(agentId: string): void {
    if (!this.#onAgentWorkingToIdle) return;
    try {
      this.#onAgentWorkingToIdle(agentId);
    } catch (error) {
      // Runs inside runtime event and process-exit handling; never let it escape.
      logger.error(`[Agent ${agentId}] Working-to-idle listener failed`, error);
    }
  }

  private commitApmIdleState(agentId: string, ap: AgentProcess, nextIsIdle: boolean): void {
    const reduction = reduceApmIdleState(ap.gatedSteering, { isIdle: nextIsIdle });
    this.commitGatedSteeringDecisionState(agentId, ap, reduction.nextState);
  }

  private pruneAppInboxNoticeMemo(agentId: string, items: readonly AgentInboxAppItem[]): void {
    const delivered = this.appInboxNoticedItemIds.get(agentId);
    if (!delivered) return;
    const current = new Set(items.map((item) => item.itemId));
    for (const itemId of delivered.keys()) {
      if (!current.has(itemId)) delivered.delete(itemId);
    }
    if (delivered.size === 0) this.appInboxNoticedItemIds.delete(agentId);
  }

  /**
   * task #925: does this start owe the agent a waking app notice? Only a
   * notice that may start a stopped agent counts (a server wake, or a per_turn
   * deferral marked `wake`), and only while an item is still undelivered; an
   * advisory deferral or an already delivered item never makes an empty start
   * call the model. A store failure is `unknown`: nothing is spawned for it,
   * and the caller keeps the wake's identity for the next start.
   */
  private owesWakingAppInboxNotice(agentId: string, serverWakeItemId: string | undefined): "owed" | "none" | "unknown" {
    const afterTurnWakeIds = this.appInboxNoticesAfterTurn.get(agentId)?.wakeItemIds;
    if (serverWakeItemId === undefined && !afterTurnWakeIds?.size) return "none";
    let appItems: readonly AgentInboxAppItem[];
    try {
      appItems = this.#appInboxForAgent?.(agentId).list() ?? [];
    } catch (error) {
      this.recordAppInboxUnavailable(agentId, "start_defer_check", error);
      return "unknown";
    }
    // A wake is owed only while its own item is undelivered: an advisory item
    // noted since then never makes this start call the model.
    return this.undeliveredAppInboxItems(agentId, appItems)
      .some((item) => item.itemId === serverWakeItemId || afterTurnWakeIds?.has(item.itemId) === true)
      ? "owed"
      : "none";
  }

  private undeliveredAppInboxItems(
    agentId: string,
    items: readonly AgentInboxAppItem[],
  ): AgentInboxAppItem[] {
    const delivered = this.appInboxNoticedItemIds.get(agentId);
    if (!delivered) return [...items];
    return items.filter((item) => !appInboxItemNoticed(delivered, item));
  }

  private markAppInboxNoticeDelivered(agentId: string, items: readonly AgentInboxAppItem[]): void {
    let delivered = this.appInboxNoticedItemIds.get(agentId);
    if (!delivered) {
      delivered = new Map();
      this.appInboxNoticedItemIds.set(agentId, delivered);
    }
    // The wake is a prompt to inspect the App Inbox, so one successful notice
    // covers all pending items visible at that point. Later distinct items are
    // outside this memo and still get their own wake.
    for (const item of items) delivered.set(item.itemId, item.createdAtMs);
  }

  /**
   * Busy must come from an observed turn. A runtime that reports its own turn
   * lifecycle can emit a stray event after a turn ended (Codex: an orphan
   * `tool_output` minutes later); that event must not leave the agent marked
   * busy with no turn to end it, or every later notice takes the busy path.
   */
  private revertBusyWithoutLiveTurn(agentId: string, ap: AgentProcess, source: string): boolean {
    if (this.agents.get(agentId) !== ap) return false;
    if (this.isApmIdle(ap) || ap.driver.hasLiveTurn !== false) return false;
    this.recordDaemonEvent("daemon.agent.busy_state_reverted", {
      agentId,
      launchId: ap.launchId || undefined,
      runtime: ap.config.runtime,
      reason: "no_live_turn",
      source,
    }, "error");
    this.returnToIdle(agentId, ap);
    return true;
  }

  /**
   * Busy for this long with no runtime progress while the runtime reports no
   * live turn means a turn end was missed; clear it instead of trusting it.
   * Runtimes that do not report turns keep the flag: silence alone is not
   * evidence (a long quiet tool run is legitimately busy).
   */
  private clearStaleBusy(agentId: string, ap: AgentProcess, source: string): boolean {
    if (this.isApmIdle(ap) || ap.driver.hasLiveTurn !== false) return false;
    const ageMs = ap.runtimeProgress.ageMs(this.clockNow());
    if (ageMs < APP_INBOX_BUSY_STALE_MS) return false;
    this.recordDaemonEvent("daemon.agent.busy_state_stale", {
      agentId,
      launchId: ap.launchId || undefined,
      runtime: ap.config.runtime,
      runtime_progress_age_ms: ageMs,
      source,
    }, "error");
    this.returnToIdle(agentId, ap);
    return true;
  }

  /**
   * "Written" is not "running": after an idle write, a runtime that reports
   * its own turn lifecycle must show the turn within a short window, or the
   * agent returns to idle instead of waiting for a turn end that never comes.
   */
  private watchTurnStart(agentId: string, ap: AgentProcess, source: string): void {
    if (ap.driver.hasLiveTurn === undefined) return;
    const writtenAtMs = this.clockNow();
    const timer = setTimeout(() => {
      if (this.agents.get(agentId) !== ap || this.isApmIdle(ap)) return;
      if (ap.driver.hasLiveTurn !== false) return;
      if (ap.runtimeProgress.lastEventAt > writtenAtMs) return;
      this.recordDaemonEvent("daemon.agent.turn_start_not_observed", {
        agentId,
        launchId: ap.launchId || undefined,
        runtime: ap.config.runtime,
        source,
        wait_ms: TURN_START_OBSERVATION_MS,
      }, "error");
      this.returnToIdle(agentId, ap);
    }, TURN_START_OBSERVATION_MS);
    (timer as { unref?: () => void }).unref?.();
  }

  /** Close any open turn trace and publish idle (stops the working heartbeat). */
  private returnToIdle(agentId: string, ap: AgentProcess): void {
    this.endRuntimeTrace(ap, "error", { outcome: "busy_state_cleared", ...runtimeTraceCounterAttrs(ap) });
    this.commitApmIdleState(agentId, ap, true);
    this.broadcastQuietTurnStatus(agentId, ap);
  }

  /** Mark the agent idle again without re-entering the idle App Inbox drain:
   * the caller is already handling the notice. */
  private restoreApmIdleWithoutDrain(agentId: string, ap: AgentProcess): void {
    const drainHeld = this.appInboxIdleDrains.has(agentId);
    if (!drainHeld) this.appInboxIdleDrains.add(agentId);
    try {
      this.commitApmIdleState(agentId, ap, true);
    } finally {
      if (!drainHeld) this.appInboxIdleDrains.delete(agentId);
    }
  }

  private drainAppInboxAfterIdleTransition(agentId: string): void {
    if (!this.#appInboxForAgent) return;
    if (this.appInboxIdleDrains.has(agentId)) return;
    const deferredUntil = this.appInboxDrainDeferredUntil.get(agentId);
    if (deferredUntil !== undefined) {
      const waitMs = deferredUntil - this.clockNow();
      if (waitMs > 0) {
        if (!this.appInboxDeferredDrainTimers.has(agentId)) {
          const timer = setTimeout(() => {
            this.appInboxDeferredDrainTimers.delete(agentId);
            const current = this.agents.get(agentId);
            if (current && this.isApmIdle(current)) this.drainAppInboxAfterIdleTransition(agentId);
          }, waitMs);
          timer.unref?.();
          this.appInboxDeferredDrainTimers.set(agentId, timer);
        }
        return;
      }
      this.appInboxDrainDeferredUntil.delete(agentId);
    }
    let appItems: readonly AgentInboxAppItem[];
    try {
      appItems = this.#appInboxForAgent(agentId).list();
    } catch (error) {
      // This method runs synchronously inside a runtime event listener. Letting
      // a scoped-store failure escape here would crash the daemon instead of
      // leaving the occurrence on its bounded retry path.
      logger.error(`[Agent ${agentId}] Failed to read App Inbox after idle transition`, error);
      this.recordDaemonEvent("daemon.agent.app_inbox_notice", {
        owner_agent_id_present: true,
        outcome: "store_read_failed",
        message_identity_created: false,
      }, "error");
      return;
    }
    this.pruneAppInboxNoticeMemo(agentId, appItems);
    const pending = this.undeliveredAppInboxItems(agentId, appItems);
    if (pending.length === 0) return;

    this.appInboxIdleDrains.add(agentId);
    // The agent is live here; the drain only re-offers pending items and must
    // not upgrade an advisory notice into a wake (a per_turn deferral keeps
    // whatever wake intent the original notice had).
    void this.notifyAgentAppInbox(agentId, pending[0]!, { startStoppedAgent: false })
      .catch((error) => {
        logger.error(`[Agent ${agentId}] Failed to drain App Inbox after idle transition`, error);
        // Backstop for throws outside notifyAgentAppInbox's own traced failure
        // outcomes (see the store-read catch above).
        this.recordDaemonEvent("daemon.agent.app_inbox_notice", {
          owner_agent_id_present: true,
          outcome: "drain_threw",
          message_identity_created: false,
          error_class: errorClassOf(error),
        }, "error");
      })
      .finally(() => {
        this.appInboxIdleDrains.delete(agentId);
      });
  }

  private recordApmGatedSteeringEffectTrace(
    agentId: string,
    ap: AgentProcess,
    effect: ApmGatedSteeringEffect,
    attrs: Record<string, unknown>,
  ): void {
    this.recordDaemonEvent("daemon.apm.gated_effect", {
      agentId,
      launchId: ap.launchId || undefined,
      runtime: ap.config.runtime,
      effect_kind: effect.kind,
      reason: effect.reason,
      target: "runtime-stdin",
      stdin_mode: effect.stdinMode,
      clause_id: effect.clauseId,
      pending_messages: ap.inbox.length,
      ...attrs,
    });
  }

  private executeApmGatedSteeringEffect(
    agentId: string,
    ap: AgentProcess,
    effect: ApmGatedSteeringEffect,
  ): boolean {
    switch (effect.kind) {
      case "notify_stdin":
        {
          const written = this.sendStdinNotification(agentId);
          this.recordApmGatedSteeringEffectTrace(agentId, ap, effect, {
            outcome: written ? "written" : "not_written",
          });
          return written;
        }
      case "deliver_stdin": {
        if (this.driverCompactionHolds(ap)) {
          // #proj-runtime:#54: a turn-end compaction through the runtime's API is running; its settle delivers the inbox.
          this.recordApmGatedSteeringEffectTrace(agentId, ap, effect, { outcome: "suppressed_turn_end_compaction", delivered_messages_count: 0 });
          return false;
        }
        if (this.drain.holds(agentId)) {
          // Reconciler step 13: held; the end of the drain flushes the inbox.
          this.recordApmGatedSteeringEffectTrace(agentId, ap, effect, { outcome: "suppressed_drain", delivered_messages_count: 0 });
          return false;
        }
        const credentialInvalid = this.credentialInvalidHold(agentId, ap.config);
        if (credentialInvalid) {
          // Held for the invalid credential; its release flushes the inbox.
          this.recordApmGatedSteeringEffectTrace(agentId, ap, effect, {
            outcome: "suppressed_credential_invalid",
            credential_invalid_reason: credentialInvalid.invalidReason,
            delivered_messages_count: 0,
          });
          return false;
        }
        const runtimeErrorBackoffRemainingMs = this.runtimeErrorDeliveryBackoffRemainingMs(ap);
        if (runtimeErrorBackoffRemainingMs > 0) {
          const scheduled = this.scheduleRuntimeErrorDeliveryBackoffFlush(agentId, ap);
          this.recordApmGatedSteeringEffectTrace(agentId, ap, effect, {
            outcome: "suppressed_runtime_error_backoff",
            runtime_error_backoff_remaining_ms: runtimeErrorBackoffRemainingMs,
            runtime_error_backoff_attempts: ap.runtimeErrorDeliveryBackoff.attempts,
            runtime_error_backoff_reason: ap.runtimeErrorDeliveryBackoff.reason || undefined,
            runtime_error_backoff_timer_scheduled: scheduled || this.runtimeErrorDeliveryBackoffTimerScheduled(ap),
            delivered_messages_count: 0,
          });
          return false;
        }
        const messages = [...ap.inbox];
        ap.notifications.pruneContributedToPending(ap.inbox, ap.sessionId);
        ap.notifications.clearPending();
        ap.notifications.clearTimer();
        if (messages.length === 0) {
          this.recordApmGatedSteeringEffectTrace(agentId, ap, effect, {
            outcome: "empty",
            delivered_messages_count: 0,
          });
          return true;
        }
        const runtimeProfileMessages = messages.filter((message) => runtimeProfileNotificationFromMessage(message));
        const ordinaryMessageCandidates = messages.filter((message) => !runtimeProfileNotificationFromMessage(message));
        let ordinaryMessages = ap.notifications.filterUncontributedMessages(
          ordinaryMessageCandidates,
          ap.sessionId,
        );
        // RETIRED 2026-08-03 (task #524 regression, Tenny-authorized revert):
        // the turn_end delivery-debt re-arm introduced by #5911 is removed.
        // It re-delivered already-contributed messages on EVERY turn_end:
        // clearNoticeFingerprint() erased all dedup memory, the resulting write
        // re-recorded the same identity via recordNoticeWritten(), and the next
        // turn_end retriggered on that record — a fixpoint with no terminating
        // edge, since delivery never consumes the inbox. A non-reading agent
        // (wedged / rate-limited / mute-session) burned one turn admission plus
        // one injection per turn indefinitely, reopening the #58 retry-storm
        // class. Re-establish only under task #70's redesign: at-least-once
        // anchored on "debt genuinely unconsumed", with a suppression memo that
        // survives the turn boundary.
        const rearmedDeliveryDebt = false;
        if (runtimeProfileMessages.length === 0 && ordinaryMessages.length === 0) {
          this.recordApmGatedSteeringEffectTrace(agentId, ap, effect, {
            outcome: "suppressed_already_contributed",
            delivered_messages_count: 0,
          });
          return false;
        }
        let accepted = true;
        if (runtimeProfileMessages.length > 0) {
          ap.inbox.splice(0, ap.inbox.length, ...ordinaryMessageCandidates);
          accepted = this.deliverMessagesViaStdin(agentId, ap, runtimeProfileMessages, effect.stdinMode);
        }
        if (ordinaryMessages.length > 0) {
          accepted = this.deliverInboxUpdateViaStdin(
            agentId,
            ap,
            ordinaryMessages,
            effect.stdinMode,
            `stdin_${effect.stdinMode}_delivery`,
          ) && accepted;
        }
        this.recordApmGatedSteeringEffectTrace(agentId, ap, effect, {
          outcome: accepted ? "written" : "not_written",
          delivered_messages_count: runtimeProfileMessages.length + ordinaryMessages.length,
          rearmed_delivery_debt: rearmedDeliveryDebt,
        });
        return accepted;
      }
      default:
        return assertNeverApmEffect(effect);
    }
  }

  private flushCompactionBoundaryMessages(agentId: string, ap: AgentProcess): boolean {
    if (this.driverCompactionHolds(ap)) return false;
    const reduction = reduceApmGatedCompactionBoundaryFlush(ap.gatedSteering, {
      hasSession: Boolean(ap.sessionId),
      supportsStdinNotification: ap.driver.supportsStdinNotification,
      inboxLength: ap.inbox.length,
      pendingNotificationCount: ap.notifications.pendingCount,
    });
    if (reduction.effects.length === 0) return false;

    ap.notifications.clearTimer();
    for (const effect of reduction.effects) {
      this.executeApmGatedSteeringEffect(agentId, ap, effect);
    }
    return true;
  }

  private launchIdentityAttrs(agentId: string, ap: AgentProcess, launchSource: string): LaunchIdentityAttrs {
    const runtimeContext = ap.config.runtimeContext;
    return {
      agent_launch_id: ap.launchId ?? null,
      agent_id: agentId,
      server_id: runtimeContext?.serverId ?? null,
      machine_id: runtimeContext?.machineId ?? null,
      runtime: ap.config.runtime,
      driver: ap.driver.id,
      launch_source: launchSource,
    };
  }

  /**
   * Phase-5 exported-row ENTER: opens the runtime-readiness wait row (task
   * #149). Idempotent — a second call while a row is open is a no-op so the
   * (agent_launch_id, state_instance_id) pair keeps exactly-one enter.
   */
  private openRuntimeReadinessTransition(
    agentId: string,
    ap: AgentProcess,
    launchSource: string,
    fenceKind: LaunchFenceKind,
    deadlineUnixMs: number | null,
  ): void {
    if (ap.readinessTransition) return;
    const identity = this.launchIdentityAttrs(agentId, ap, launchSource);
    const state: LaunchReadinessTransitionState = {
      stateInstanceId: randomUUID(),
      enterSeq: this.launchTransitionSeq++,
      identity,
      fenceKind,
      deadlineUnixMs,
      negativeEvidenceBucket: launchReadinessNegativeEvidence(identity),
    };
    ap.readinessTransition = state;
    this.recordDaemonEvent(LAUNCH_RUNTIME_READINESS_TRANSITION_SPAN, buildLaunchReadinessEnterAttrs(state));
  }

  /**
   * Phase-5 exported-row CLOSE: closes the open runtime-readiness wait row with
   * a closed `close_result` (task #149). Idempotent — no-op when no row is open,
   * so overlapping close paths (ready event, timeout fire, process exit,
   * cleanup) emit exactly one close.
   */
  private closeRuntimeReadinessTransition(ap: AgentProcess, closeResult: LaunchCloseResult): void {
    const state = ap.readinessTransition;
    if (!state) return;
    ap.readinessTransition = null;
    this.recordDaemonEvent(
      LAUNCH_RUNTIME_READINESS_TRANSITION_SPAN,
      buildLaunchReadinessCloseAttrs(state, closeResult, this.launchTransitionSeq++),
      closeResult === "advanced" ? "ok" : "error",
    );
  }

  /**
   * Phase-6 exported-row ENTER: opens the activation-delivery wait row when a
   * launch carries an initial activation (wake / buffered inbox) not yet
   * delivered (task #149). Idempotent + only opens when there is something to
   * deliver, so explicit starts with no activation produce no phase-6 row.
   */
  private openActivationTransition(agentId: string, ap: AgentProcess, launchSource: string): void {
    if (ap.activation.kind !== "idle") return;
    const identity = this.launchIdentityAttrs(agentId, ap, launchSource);
    const state: LaunchActivationTransitionState = {
      stateInstanceId: randomUUID(),
      enterSeq: this.launchTransitionSeq++,
      identity,
      negativeEvidenceBucket: launchReadinessNegativeEvidence(identity),
    };
    ap.activation = { kind: "open", transition: state };
    this.recordDaemonEvent(LAUNCH_ACTIVATION_DELIVERY_TRANSITION_SPAN, buildLaunchActivationEnterAttrs(state));
  }

  /**
   * Phase-6 exported-row CLOSE: closes the open activation-delivery wait with a
   * closed `close_result` (+ `delivered_via` on advanced). Idempotent — no-op
   * when no row is open, so overlapping paths (spawn-prompt, first stdin,
   * process exit, cleanup) emit exactly one close. Marks the initial activation
   * delivered on `advanced` so later normal deliveries are not re-counted.
   */
  private closeActivationTransition(ap: AgentProcess, closeResult: LaunchCloseResult, deliveredVia?: LaunchDeliveredVia): void {
    if (ap.activation.kind !== "open") {
      if (closeResult === "advanced" && ap.activation.kind === "idle") {
        ap.activation = { kind: "delivered" };
      }
      return;
    }
    const state = ap.activation.transition;
    ap.activation = closeResult === "advanced" ? { kind: "delivered" } : { kind: "closed" };
    this.recordDaemonEvent(
      LAUNCH_ACTIVATION_DELIVERY_TRANSITION_SPAN,
      buildLaunchActivationCloseAttrs(state, closeResult, this.launchTransitionSeq++, deliveredVia),
      closeResult === "advanced" ? "ok" : "error",
    );
  }

  private startRuntimeStartupTimeout(agentId: string, ap: AgentProcess, launchSource: string) {
    const timeoutMs = runtimeStartTimeoutMs(ap.config.runtime);
    const fenced = timeoutMs > 0;
    this.openRuntimeReadinessTransition(
      agentId,
      ap,
      launchSource,
      fenced ? "runtime_startup_timeout" : "none",
      fenced ? Date.now() + timeoutMs : null,
    );
    if (!fenced) return;
    if (ap.startup.kind !== "waiting") return;
    const timer = setTimeout(() => {
      this.handleRuntimeStartupTimeout(agentId, ap, timeoutMs);
    }, timeoutMs);
    timer.unref?.();
    ap.startup = { ...ap.startup, timer };
  }

  private clearRuntimeStartupTimeout(ap: AgentProcess) {
    if (ap.startup.kind !== "waiting" || !ap.startup.timer) return;
    clearTimeout(ap.startup.timer);
    ap.startup = { ...ap.startup, timer: null };
  }

  /**
   * The runtime's first output event (startup readiness): the only real
   * progress of a start. Ends the agent's start-timeout streak and tells the
   * server (DAEMON_CAPABILITY_STARTUP_READINESS), which ends its failed-start
   * streak on this, not on the spawn-time `active`.
   */
  private markRuntimeStartupReady(agentId: string, ap: AgentProcess) {
    if (ap.startup.kind === "ready") return;
    this.clearRuntimeStartupTimeout(ap);
    ap.startup = agentProcessStartupReady(ap.startup);
    this.startTimeoutStreaks.delete(agentId);
    this.sendStartupReady(agentId, ap);
  }

  private sendStartupReady(agentId: string, ap: AgentProcess): void {
    if (!ap.launchId) return;
    this.sendToServer({ type: "agent:runtime:ready", agentId, launchId: ap.launchId });
  }

  private runtimeStartupReadinessSatisfiedByEvent(ap: AgentProcess, event: ParsedEvent): boolean {
    if ((ap.driver.startupReadiness ?? "first_event") !== "initial_turn") {
      return true;
    }

    return event.kind !== "session_init"
      && event.kind !== "internal_progress"
      && event.kind !== "runtime_diagnostic"
      && event.kind !== "runtime_recovery";
  }

  private handleRuntimeStartupTimeout(agentId: string, ap: AgentProcess, timeoutMs: number) {
    const current = this.agents.get(agentId);
    if (current !== ap) return;
    const reduction = reduceApmStartupTimeoutTermination(ap.gatedSteering, {
      hasRuntimeProgressEvent: ap.startup.kind === "ready",
    });
    if (!reduction.shouldTerminate) {
      // Fence fired but APM permitted continuation: the readiness wait stays
      // open (deadline already elapsed) and closes later on ready/exit. Leaving
      // it open is intentional — an over-budget open readiness row is the
      // queryable "stuck past deadline" evidence.
      this.clearRuntimeStartupTimeout(ap);
      return;
    }
    this.closeRuntimeReadinessTransition(ap, "timeout");
    this.clearRuntimeStartupTimeout(ap);
    this.commitGatedSteeringDecisionState(agentId, ap, reduction.nextState);

    const terminalFailureDetail = classifyTerminalFailure(ap);
    // Classified before the timeout's own copy becomes the last runtime error.
    const failureEndAttrs = runtimeFailureEndTraceAttrs(ap, "runtime_start_timeout");
    const detail = terminalFailureDetail?.detail ?? formatRuntimeStartTimeoutMessage(ap.driver.id, { timeoutMs, model: ap.config.model });
    ap.lastRuntimeError = detail;
    ap.decisionErrorWindow.recordRuntimeError(detail);
    ap.runtimeProgress.markStale();

    const staleForMs = Math.max(timeoutMs, ap.runtimeProgress.ageMs());
    const diagnostic = buildRuntimeStallDiagnostic(ap, staleForMs, Math.max(1, Math.floor(staleForMs / 60_000)));
    const projection = projectApmRuntimeTerminationTrace({
      reason: "startup_timeout",
      timeoutMs,
    });
    this.recordRuntimeTraceEvent(agentId, ap, projection.runtimeEventName, {
      ...projection.runtimeEventAttrs,
      ...diagnostic.traceAttrs,
    });
    this.endRuntimeTrace(ap, "error", {
      outcome: "runtime-start-failed",
      ...projection.runtimeSpanAttrs,
      ...runtimeTraceCounterAttrs(ap),
      ...failureEndAttrs,
      ...this.finalizeRuntimeProfileTurnControl(agentId, ap, "runtime_stalled"),
    });

    logger.warn(`[Agent ${agentId}] ${ap.driver.id} did not reach startup readiness within ${timeoutMs}ms; terminating process`);
    this.broadcastActivity(agentId, "error", detail, [{ kind: "text", text: `Error: ${detail}` }], ap.launchId, "runtime_error");
    // A typed start failure (with `inactive`), so the server's wake breaker
    // counts it toward its failed-start pause.
    this.reportStartFailure(agentId, ap.launchId, startTimeoutClassification(detail), ap.config.model);
    this.cacheStartupTimeoutRetryConfig(agentId, ap);
    this.runtimeExitTraceAttrs.set(ap.runtime, projection.processExitAttrs);
    void this.stopRuntimeProcess(agentId, ap.runtime, "startup_timeout", { reason: projection.runtimeStopReason, launchId: ap.launchId });
  }

  private handleRuntimeStartupRequestError(agentId: string, ap: AgentProcess, event: StartupRequestErrorEvent) {
    const current = this.agents.get(agentId);
    if (current !== ap) return;
    this.closeRuntimeReadinessTransition(ap, "terminal");
    this.closeActivationTransition(ap, "terminal");
    this.clearRuntimeStartupTimeout(ap);
    this.interruptCompactionIfActive(agentId);
    this.interruptReviewIfActive(agentId);
    this.flushPendingTrajectory(agentId);

    const reduction = reduceApmStartupRequestErrorTermination(ap.gatedSteering);
    this.commitGatedSteeringDecisionState(agentId, ap, reduction.nextState);

    ap.lastRuntimeError = event.message;
    ap.decisionErrorWindow.recordRuntimeError(event.message);
    ap.runtimeProgress.markStale();
    ap.notifications.clearPending();
    ap.notifications.clearTimer();

    const diagnostics = buildRuntimeErrorDiagnosticEnvelope(event.message);
    const visibleErrorMessage = diagnostics.spanAttrs.runtime_error_action_required === true
      ? formatRuntimeActionRequiredMessage(ap, event.message)
      : event.message;
    const failureAttrs = {
      turn_outcome: "failed",
      turn_subtype: "runtime_start_failed",
      turn_reason: "startup_request_error",
      runtime_start_failure_kind: "startup_request_error",
      startup_request_method: event.startupRequestMethod,
      ...diagnostics.eventAttrs,
    };

    noteRuntimeTraceCounter(ap.runtimeTraceCounters, event);
    this.recordRuntimeTraceEvent(agentId, ap, "runtime.event.received", {
      kind: event.kind,
      startup_request_method: event.startupRequestMethod,
    });
    this.recordRuntimeTraceEvent(agentId, ap, "runtime.start.request_failed", failureAttrs);
    this.endRuntimeTrace(ap, "error", {
      outcome: "runtime-start-failed",
      ...failureAttrs,
      ...diagnostics.spanAttrs,
      ...runtimeTraceCounterAttrs(ap),
      ...runtimeFailureEndTraceAttrs(ap, "unknown"),
      ...this.finalizeRuntimeProfileTurnControl(agentId, ap, "runtime_error"),
    });

    logger.warn(
      `[Agent ${agentId}] ${ap.driver.id} startup request ${event.startupRequestMethod} failed; terminating unusable runtime process`,
    );
    // The typed carrier (as on the regular runtime error paths) lets the
    // server see an error that needs the owner (a Codex or Grok login failing
    // at initialize, before any output): it pauses automatic wakes and tells
    // the owner once, and ends a start-timeout pause's self-retry when this
    // start was its try. Daemons before this send no carrier here, so the
    // server cannot tell; such a pause keeps retrying on its cooldown.
    this.broadcastActivity(agentId, "error", visibleErrorMessage, [
      { kind: "text", text: `Error: ${visibleErrorMessage}` },
    ], ap.launchId, "runtime_error", "error", undefined, buildRuntimeErrorActivityDiagnostic(event.message));
    this.sendAgentStatus(agentId, "inactive", ap.launchId);
    this.lifecycleRecords.deleteRestartSnapshot(agentId);
    this.runtimeExitTraceAttrs.set(ap.runtime, {
      stop_source: "startup_request_error",
      expectedTerminationReason: "startup_request_error",
      startup_request_method: event.startupRequestMethod,
      runtime_error_class: diagnostics.spanAttrs.runtime_error_class,
    });
    void this.stopRuntimeProcess(agentId, ap.runtime, "startup_request_error", { reason: "startup_request_error", launchId: ap.launchId });
  }

  /**
   * task #25: a tool call with no runtime output for the threshold is reported
   * once per quiet episode, so the agent's status shows which command it is
   * stuck on instead of a plain "busy" (shown in the web only; nobody is sent
   * a DM or notification about it). Observation only; the activity detail stays
   * on the heartbeat until the next runtime event replaces it.
   */
  private reportStuckToolCallIfNeeded(agentId: string, ap: AgentProcess): void {
    const thresholdMs = toolStuckThresholdMs();
    const nowMs = Date.now();
    const stuck = ap.toolStuck?.takeStuck(nowMs, ap.runtimeProgress.lastEventAt, thresholdMs);
    if (!stuck) return;
    const detailKind = this.toolActivityDetailKind(stuck.toolName);
    this.recordDaemonEvent("daemon.runtime.tool.stuck", {
      ...this.processLifecycleIdentityAttrs(agentId, ap),
      tool: stuck.toolName,
      tool_detail_kind: detailKind,
      tool_age_ms_bucket: bucketMs(nowMs - stuck.startedAtMs),
      quiet_ms_bucket: bucketMs(nowMs - stuck.quietSinceMs),
      threshold_ms: thresholdMs,
      open_tool_calls: stuck.openToolCalls,
      queued_messages: ap.inbox.length,
      subprocess_pid_alive: this.probeRuntimeProcessLiveness(ap),
    }, "error");
    logger.warn(`[Agent ${agentId}] ${stuck.toolName} has produced no output for ${Math.round((nowMs - stuck.quietSinceMs) / 60_000)}m (${ap.inbox.length} queued message(s))`);
    this.broadcastActivity(agentId, "working", stuckToolActivityDetail(getToolActivityLabel(stuck.toolName), thresholdMs), [], undefined, detailKind);
  }

  /**
   * task #25 step 2: a person stops the agent's current turn without stopping
   * the agent. A runtime with a native interrupt (Claude Code, Pi / Built-in)
   * ends the turn and keeps its process; the turn's end confirms it. Any other
   * runtime, or a native interrupt that does not end the turn in time, is
   * restarted and resumes its session, and only the processes this turn
   * started are killed with it: a dev server from an earlier turn and the
   * session's MCP servers stay, and anything whose start time cannot be read
   * is left alone (and counted).
   */
  /**
   * #proj-runtime:#41 — a person stops one running sub-agent (Codex: its
   * thread's turn); the agent and its other sub-agents keep running. The
   * sub-agent's own turn end records it as stopped, as any end would.
   */
  async interruptSubagent(agentId: string, subagentTaskId: string): Promise<AgentSubagentInterruptOutcome> {
    const ap = this.agents.get(agentId);
    const outcome = ((): AgentSubagentInterruptOutcome => {
      if (!ap || ap.exit.kind !== "live" || ap.gatedSteering.expectedTerminationReason !== null) return "not_running";
      if (!ap.driver.encodeSubagentInterruptRequest && !ap.driver.stopsSubagentsInSession) return "unsupported";
      // Only a subagent this process saw start and not yet end.
      if (!ap.backgroundTasks.has(subagentTaskId)) return "not_running";
      const sent = ap.runtime.interruptSubagent?.(subagentTaskId) ?? "unsupported";
      if (sent !== "sent") return sent;
      (ap.userStoppedSubagents ??= new Set()).add(subagentTaskId);
      return "interrupted";
    })();
    this.recordDaemonEvent("daemon.agent.subagent_interrupt", {
      agentId,
      ...(ap ? { launchId: ap.launchId || undefined, runtime: ap.config.runtime } : {}),
      outcome,
    });
    return outcome;
  }

  async interruptTurn(agentId: string): Promise<AgentTurnInterruptResult> {
    const ap = this.agents.get(agentId);
    if (!ap || ap.gatedSteering.isIdle || ap.gatedSteering.expectedTerminationReason !== null) {
      this.recordDaemonEvent("daemon.agent.turn_interrupt", {
        agentId,
        outcome: "not_running",
        reason: !ap ? "no_process" : ap.gatedSteering.isIdle ? "idle" : "terminating",
      });
      return { outcome: "not_running" };
    }
    // Agent typing line: the agent is no longer about to post.
    this.sendIntents.endAll(agentId);
    const nowMs = Date.now();
    const stuck = this.currentToolStuck(ap);
    const openTool = ap.toolStuck?.oldestOpenCall();
    const context: Omit<AgentTurnInterruptResult, "outcome"> = stuck
      ? { toolName: stuck.toolName, stuckForMs: nowMs - stuck.quietSinceMs }
      : openTool
        ? { toolName: openTool.toolName }
        : {};
    const traceContext = {
      ...this.processLifecycleIdentityAttrs(agentId, ap),
      tool: context.toolName,
      tool_stuck: Boolean(stuck),
      stuck_for_ms_bucket: context.stuckForMs !== undefined ? bucketMs(context.stuckForMs) : undefined,
    };

    if (ap.runtime.interruptTurn) {
      // Taken now: at turn end a queued message may start the next turn at once.
      // A first turn rides the spawn, so only its open tool dates what it started.
      const notedTurnStart = ap.runtimeProgress.notedTurnStartedAt;
      const nativeKillFromMs = notedTurnStart !== null
        ? Math.min(notedTurnStart, openTool?.startedAtMs ?? Number.POSITIVE_INFINITY)
        : openTool?.startedAtMs;
      let turnEndedAtMs = Number.POSITIVE_INFINITY;
      let settle: (ended: boolean) => void = () => {};
      const turnEnded = new Promise<boolean>((resolve) => {
        settle = resolve;
      });
      const waiters = ap.turnEndWaiters ??= new Set();
      const onTurnEnd = () => {
        turnEndedAtMs = Date.now();
        settle(true);
      };
      waiters.add(onTurnEnd);
      const timer = setTimeout(() => settle(false), NATIVE_TURN_INTERRUPT_TIMEOUT_MS);
      timer.unref?.();
      const sent = ap.runtime.interruptTurn();
      if (sent !== "sent") settle(false);
      const ended = await turnEnded;
      clearTimeout(timer);
      waiters.delete(onTurnEnd);
      if (ended) {
        if (ap.runtime.killTurnProcesses) {
          if (nativeKillFromMs === undefined) {
            this.recordDaemonEvent("daemon.agent.turn_interrupt.tree_kill", { ...traceContext, method: "native", skip_reason: "first_turn_without_open_tool" });
          } else {
            const { killed, leftAlone } = await ap.runtime.killTurnProcesses(nativeKillFromMs, turnEndedAtMs);
            this.recordDaemonEvent("daemon.agent.turn_interrupt.tree_kill", {
              ...traceContext,
              method: "native",
              killed_count: killed,
              left_alone_count: leftAlone,
            });
          }
        }
        this.recordDaemonEvent("daemon.agent.turn_interrupt", { ...traceContext, outcome: "interrupted", method: "native" });
        this.broadcastActivity(agentId, "online", "Turn stopped", [], undefined, "idle");
        return { outcome: "interrupted", ...context };
      }
      if (this.agents.get(agentId) !== ap) return { outcome: "not_running", ...context };
      this.recordDaemonEvent("daemon.agent.turn_interrupt.native_fallback", {
        ...traceContext,
        reason: sent === "sent" ? "turn_did_not_end" : "unsupported",
      }, "error");
    }

    this.commitGatedSteeringDecisionState(agentId, ap, { ...ap.gatedSteering, expectedTerminationReason: "turn_interrupt" });
    const turnStartedAtMs = Math.min(ap.runtimeProgress.currentTurnStartedAt, openTool?.startedAtMs ?? Number.POSITIVE_INFINITY);
    this.runtimeExitTraceAttrs.set(ap.runtime, { stop_source: "turn_interrupt", expectedTerminationReason: "turn_interrupt" });
    this.broadcastActivity(agentId, "working", "Stopping this turn: restarting the runtime", [], undefined, "stalled_recovery");
    // The process stop is the one stop (reconciler step 5); what this turn
    // started is selected separately (`turnTreeKill`), never the whole tree.
    await this.stopRuntimeProcess(agentId, ap.runtime, "turn_interrupt", {
      reason: "turn_interrupt",
      launchId: ap.launchId,
      turnTreeKill: {
        startedAtOrAfterMs: turnStartedAtMs,
        onResult: ({ killed, leftAlone }) => {
          this.recordDaemonEvent("daemon.agent.turn_interrupt.tree_kill", {
            ...traceContext,
            killed_count: killed,
            left_alone_count: leftAlone,
            ...(process.platform === "linux" ? { clock_ticks_per_second: linuxClockTicksPerSecond() } : {}),
          });
        },
      },
    });
    this.recordDaemonEvent("daemon.agent.turn_interrupt", { ...traceContext, outcome: "restarted", method: "restart" });
    return { outcome: "restarted", ...context };
  }

  /** task #25: the stuck state every activity frame carries while it lasts. */
  private currentToolStuck(ap: AgentProcess): ToolStuckActivityDiagnostic | undefined {
    const thresholdMs = toolStuckThresholdMs();
    const stuck = ap.toolStuck?.current(Date.now(), ap.runtimeProgress.lastEventAt, thresholdMs);
    if (!stuck) return undefined;
    return {
      toolName: stuck.toolName,
      toolDetailKind: this.toolActivityDetailKind(stuck.toolName),
      startedAtMs: stuck.startedAtMs,
      quietSinceMs: stuck.quietSinceMs,
      thresholdMs,
      queuedMessages: ap.inbox.length,
    };
  }

  private markRuntimeProgressStaleIfNeeded(agentId: string, ap: AgentProcess): boolean {
    if (ap.lastActivityKind !== "working" && ap.lastActivityKind !== "thinking") return false;
    if (ap.runtimeProgress.isStale) return true;

    const staleForMs = ap.runtimeProgress.ageMs();
    if (staleForMs < RUNTIME_PROGRESS_STALE_MS) return false; const toolDiagnosticSnapshots = ap.runtime.emitToolDiagnosticSnapshots?.({ trigger: "runtime_inactivity_tripwire", runtimeInactivityAgeMs: staleForMs, observationIntervalMs: RUNTIME_PROGRESS_STALE_MS }) ?? [];

    const subprocessPidAlive = this.probeRuntimeProcessLiveness(ap);
    if (subprocessPidAlive === true) {
      this.recordDaemonEvent("daemon.runtime.stall.suppressed_alive", {
        ...this.processLifecycleIdentityAttrs(agentId, ap),
        last_event_kind: ap.lastActivityKind || undefined,
        last_event_age_ms_bucket: bucketMs(ap.runtimeProgress.lastEventAgeMs()),
        subprocess_pid_alive: true,
        subprocess_socket_alive: !ap.runtime.closed,
        daemon_connected_to_server: this.serverConnected(),
        inbox_count: ap.inbox.length,
        // The inbox keeps messages already given to the session; this many were
        // never told (AndyLok #o11y-alerts:7f2b4167), and background tasks
        // still running explain a silence by themselves.
        inbox_untold_count: ap.notifications.filterUncontributedMessages(ap.inbox, ap.sessionId).length,
        background_tasks: ap.backgroundTasks.size,
        outstanding_tool_uses: ap.gatedSteering.outstandingToolUses,
      });
      this.recordRuntimeTraceEvent(agentId, ap, "runtime.progress.silent_alive", {
        staleForMs: bucketMs(staleForMs),
        lastActivity: ap.lastActivityKind || undefined,
        lastActivityDetailKind: ap.lastActivityDetailKind,
      });
      // An alive runtime can still hold a turn that never ends (10-23, a codex
      // turn silent for 5 h with messages queued in its first minutes). With
      // work queued it is decided by reconcile at its stall deadline
      // (reconciler step 9, stalledWithWork), not by this heartbeat.
      // An alive runtime that stays silent is not stalled, but it is not proven
      // busy either: without a live turn the busy flag is cleared, not kept
      // alive by this heartbeat forever.
      this.clearStaleBusy(agentId, ap, "activity_heartbeat");
      return false;
    }

    ap.runtimeProgress.markStale();
    const staleForMinutes = Math.max(1, Math.floor(staleForMs / 60_000));
    const diagnostic = buildRuntimeStallDiagnostic(ap, staleForMs, staleForMinutes);
    const providerCallAttrs = providerCallStallAttrs(ap);
    const projection = projectApmRuntimeProgressStalledTrace({
      turnReason: diagnostic.turnReason,
      staleForMs,
      lastActivity: ap.lastActivityKind,
      lastActivityDetailPresent: diagnostic.lastActivityDetailPresent,
      lastActivityDetailKind: diagnostic.lastActivityDetailKind,
    });
    this.recordRuntimeTraceEvent(agentId, ap, projection.runtimeEventName, {
      ...projection.runtimeEventAttrs,
      ...diagnostic.traceAttrs,
      ...providerCallAttrs,
    });
    this.endRuntimeTrace(ap, "error", {
      outcome: "runtime-stalled",
      ...projection.runtimeSpanAttrs,
      ...runtimeTraceCounterAttrs(ap),
      ...this.finalizeRuntimeProfileTurnControl(agentId, ap, "runtime_stalled"),
    });
    this.recordDaemonEvent("daemon.runtime.stall.detected", {
      ...this.processLifecycleIdentityAttrs(agentId, ap),
      last_event_kind: ap.lastActivityKind || undefined,
      last_event_age_ms_bucket: bucketMs(ap.runtimeProgress.lastEventAgeMs()),
      subprocess_pid_alive: subprocessPidAlive,
      subprocess_socket_alive: !ap.runtime.closed,
      daemon_connected_to_server: this.serverConnected(),
      ...providerCallAttrs,
    }, "error");
    // Only the fact (row C15). Queued work is decided by reconcile
    // (reconciler step 9): at its stall deadline, a delivery or the sweep.
    this.broadcastActivity(agentId, "error", projectRuntimeToolDiagnosticActivity(toolDiagnosticSnapshots, diagnostic.detail), [], undefined, "runtime_stalled");
    return true;
  }

  private probeRuntimeProcessLiveness(ap: AgentProcess): boolean | undefined {
    // Liveness is queried through the RuntimeSession boundary (RS-011) rather
    // than poking the raw pid here. See RuntimeSession.isAlive.
    return ap.runtime.isAlive();
  }

  /**
   * Task #1302: a direct-stdin runtime with an open tool call never restarted
   * for queued messages, so a tool that would never return pinned the inbox
   * forever. Ask the runtime what the open tool is doing, but only when an
   * open tool is the remaining question (the snapshot emits a trace fact);
   * the reducer still owns the runtime-shape gates.
   */
  private openToolHoldsNoLiveWork(agentId: string, ap: AgentProcess, staleForMs: number): boolean {
    if (
      ap.gatedSteering.outstandingToolUses === 0
      || ap.inbox.length === 0
      || !ap.sessionId
      || ap.gatedSteering.expectedTerminationReason === "stalled_recovery"
      || (staleForMs < RUNTIME_PROGRESS_STALE_MS && !ap.runtimeProgress.isStale)
      || !ap.runtime.emitToolDiagnosticSnapshots
    ) {
      return false;
    }
    const snapshots = ap.runtime.emitToolDiagnosticSnapshots({
      trigger: "queued_message_recovery",
      runtimeInactivityAgeMs: staleForMs,
      observationIntervalMs: RUNTIME_PROGRESS_STALE_MS,
    });
    const decision = classifyOpenToolRecovery(snapshots, {
      outstandingToolUses: ap.gatedSteering.outstandingToolUses,
      openToolCallIds: [...(ap.openToolCallIds ?? [])],
    });
    this.recordDaemonEvent("daemon.runtime.stall.open_tool_recovery", {
      ...this.processLifecycleIdentityAttrs(agentId, ap),
      decision,
      outstanding_tool_uses: ap.gatedSteering.outstandingToolUses,
      inbox_count: ap.inbox.length,
      snapshot_count: snapshots.length,
      stale_for_ms_bucket: bucketMs(staleForMs),
    });
    return decision === "no_live_work";
  }

  /**
   * Reconciler step 9 (rule 3, E2; row C14): the process's health, decided by
   * stalledWithWork from facts read here. Broken (stalled with work queued)
   * stops it at once, without waiting for idle, and the close path starts it
   * again for the queued work, resuming its session (replaceStalledProcess).
   * Not broken, with only time missing, arms the one stall deadline. The open
   * tool's diagnostic snapshots are read only when an open tool is the
   * remaining question (openToolHoldsNoLiveWork). Returns whether a stall stop
   * of this process is underway (a turn interrupt counts: it is a stop too).
   */
  private reconcileHealth(agentId: string, ap: AgentProcess, trigger: RuntimeSpecReconcileTrigger): boolean {
    if (this.agents.get(agentId) !== ap || ap.exit.kind !== "live") return false;
    const staleForMs = ap.runtimeProgress.ageMs();
    const facts = {
      inboxLength: ap.inbox.length,
      turnInProgress: !this.isApmIdle(ap),
      deliveryHold: this.stalledWithWorkDeliveryHold(agentId, ap),
      supportsStdinNotification: ap.driver.supportsStdinNotification,
      busyDeliveryMode: ap.driver.busyDeliveryMode,
      hasSession: Boolean(ap.sessionId),
      hasDirectStdinRecoveryEvidence: hasDirectStdinRecoveryEvidence(ap),
      openToolHoldsNoLiveWork: false,
      processAlive: ap.driver.supportsStdinNotification ? undefined : this.probeRuntimeProcessLiveness(ap),
      runtimeProgressIsStale: ap.runtimeProgress.isStale,
      staleForMs,
    };
    let reduction = reduceApmStalledRecoveryTermination(ap.gatedSteering, facts);
    if (reduction.blockedReason === "runtime_not_restartable" && ap.gatedSteering.outstandingToolUses > 0 && ap.driver.supportsStdinNotification) {
      reduction = reduceApmStalledRecoveryTermination(ap.gatedSteering, {
        ...facts,
        openToolHoldsNoLiveWork: this.openToolHoldsNoLiveWork(agentId, ap, staleForMs),
      });
    }
    if (reduction.alreadyRecovering) {
      this.clearStallDeadline(ap);
      return true;
    }
    if (!reduction.shouldTerminate) {
      if (reduction.verdict.broken === false && reduction.verdict.deadlineInMs !== undefined) {
        this.armStallDeadline(agentId, ap, reduction.verdict.deadlineInMs);
      } else {
        this.clearStallDeadline(ap);
      }
      return false;
    }
    this.clearStallDeadline(ap);
    const streak = this.lifecycleRecords.getStalledReplacementStreak(agentId);
    if (streak.count >= STALLED_REPLACEMENT_MAX_STREAK) {
      this.giveUpStalledReplacement(agentId, ap, trigger, streak, staleForMs);
      return false;
    }
    this.replaceStalledProcess(agentId, ap, trigger, reduction.nextState, staleForMs, this.lifecycleRecords.noteStalledReplacement(agentId));
    return true;
  }

  /** Why queued messages wait on purpose (stalledWithWork's `deliveryHold`): the same holds a delivery is queued behind. */
  private stalledWithWorkDeliveryHold(agentId: string, ap: AgentProcess): StalledWithWorkDeliveryHold | null {
    if (this.drain.holds(agentId)) return "drain";
    if (this.credentialInvalidHold(agentId, ap.config)) return "credential_invalid";
    const limit = this.lifecycleRecords.getProviderLimit(providerLimitCredentialKey(agentId, ap.config), this.clockNow());
    if (limit && limit.untilMs > this.clockNow()) return "provider_limit";
    if (this.runtimeErrorDeliveryBackoffRemainingMs(ap) > 0) return "runtime_error_backoff";
    return null;
  }

  /**
   * Reconciler step 9: a process judged stalled again after
   * STALLED_REPLACEMENT_MAX_STREAK replacements in a row with no model output
   * or turn end in between is left as it is (no stop, no restart): traced and
   * shown once per streak. Model output, a turn end or a person's stop (the
   * Retry) ends the streak.
   */
  private giveUpStalledReplacement(
    agentId: string,
    ap: AgentProcess,
    trigger: RuntimeSpecReconcileTrigger,
    streak: { count: number; gaveUp: boolean },
    staleForMs: number,
  ): void {
    if (streak.gaveUp) return;
    this.lifecycleRecords.noteStalledReplacementGaveUp(agentId);
    const runtimeLabel = runtimeDisplayName(ap.driver.id);
    logger.warn(
      `[Agent ${agentId}] ${runtimeLabel} stalled again with ${ap.inbox.length} queued message(s) after ${streak.count} replacements in a row; not replacing it again`,
    );
    this.recordDaemonEvent("daemon.agent.stalled_recovery.gave_up", {
      ...this.processLifecycleIdentityAttrs(agentId, ap),
      streak: streak.count,
      trigger,
      queued_messages_count: ap.inbox.length,
      stale_for_ms_bucket: bucketMs(staleForMs),
    }, "error");
    this.broadcastActivity(agentId, "error", `${runtimeLabel} stalled repeatedly with queued messages; restart it to retry`, [], undefined, "runtime_error");
  }

  /** Model output or a turn end: the stalled-replacement streak (reconciler step 9) ends. */
  private resetStalledReplacementStreak(agentId: string): void {
    this.lifecycleRecords.deleteStalledReplacementStreak(agentId);
  }

  /**
   * E2 for a stall: the stalled-recovery stop (SIGTERM now, whatever the
   * turn); the close path restarts the agent with the queued messages,
   * resuming the session (`restart_stall`).
   */
  private replaceStalledProcess(
    agentId: string,
    ap: AgentProcess,
    trigger: RuntimeSpecReconcileTrigger,
    nextState: ApmGatedSteeringDecisionState,
    staleForMs: number,
    streak: number,
  ): void {
    this.commitGatedSteeringDecisionState(agentId, ap, nextState);
    const staleForMinutes = Math.max(1, Math.floor(staleForMs / 60_000));
    ap.runtimeProgress.markStale();
    const diagnostic = buildRuntimeStallDiagnostic(ap, staleForMs, staleForMinutes);
    const projection = projectApmRuntimeTerminationTrace({
      reason: "stalled_recovery",
      turnReason: diagnostic.turnReason,
      staleForMs,
      lastActivity: ap.lastActivityKind,
      lastActivityDetailPresent: diagnostic.lastActivityDetailPresent,
      lastActivityDetailKind: diagnostic.lastActivityDetailKind,
      pendingMessages: ap.inbox.length,
      recoveryAction: "terminate_for_queued_message",
    });
    this.recordRuntimeTraceEvent(agentId, ap, projection.runtimeEventName, {
      ...projection.runtimeEventAttrs,
      ...diagnostic.traceAttrs,
    });
    this.endRuntimeTrace(ap, "error", {
      outcome: "runtime-stalled",
      ...projection.runtimeSpanAttrs,
      ...runtimeTraceCounterAttrs(ap),
      ...this.finalizeRuntimeProfileTurnControl(agentId, ap, "runtime_stalled"),
    });

    const runtimeLabel = runtimeDisplayName(ap.driver.id);
    logger.warn(
      `[Agent ${agentId}] ${runtimeLabel} process stalled for ${staleForMinutes}m with ${ap.inbox.length} queued message(s); terminating for restart`,
    );
    this.broadcastActivity(agentId, "working", `Restarting stalled ${runtimeLabel} runtime for queued message`, [], undefined, "stalled_recovery");
    this.runtimeExitTraceAttrs.set(ap.runtime, projection.processExitAttrs);
    const queuedMessagesAtSignal = ap.inbox.length;
    void this.stopRuntimeProcess(agentId, ap.runtime, "stalled_recovery", {
      reason: projection.runtimeStopReason,
      launchId: ap.launchId,
      onEscalated: ({ graceMs }) => this.noteStalledRecoveryEscalation(agentId, ap, runtimeLabel, queuedMessagesAtSignal, staleForMs, graceMs),
    });
    this.recordDaemonEvent("daemon.runtime.stall.recovery_action", {
      ...this.processLifecycleIdentityAttrs(agentId, ap),
      action: "terminate_for_restart",
      outcome: "initiated",
      delay_ms_bucket: bucketMs(staleForMs),
      trigger,
      streak,
    });
  }

  /** Handle a single ParsedEvent from any runtime driver */
  private notePushedModelBodies(ap: AgentProcess, messages: readonly AgentMessage[]): void {
    const reportable = messages.filter((message) =>
      typeof message.seq === "number" && message.seq > 0
      && Boolean(message.channel_id)
      && !runtimeProfileNotificationFromMessage(message));
    if (reportable.length === 0) return;
    ap.pendingModelSeen = [...(ap.pendingModelSeen ?? []), ...reportable];
  }

  /**
   * The first model-driven event of this process after the input shows the
   * runtime took it (no driver echoes consumed input), so the pushed bodies
   * are reported now.
   */
  private flushModelSeen(agentId: string, ap: AgentProcess): void {
    const pending = ap.pendingModelSeen;
    if (!pending || pending.length === 0) return;
    ap.pendingModelSeen = [];
    const byChannel = new Map<string, Set<number>>();
    for (const message of pending) {
      const seqs = byChannel.get(message.channel_id) ?? new Set<number>();
      seqs.add(message.seq!);
      byChannel.set(message.channel_id, seqs);
    }
    const items = [...byChannel].map(([channelId, seqs]) => ({ channelId, seqs: [...seqs].sort((a, b) => a - b) }));
    for (let start = 0; start < items.length; start += MODEL_SEEN_MAX_ITEMS_PER_REPORT) {
      this.sendToServer({
        type: "agent:model-seen",
        agentId,
        launchId: ap.launchId || undefined,
        items: items.slice(start, start + MODEL_SEEN_MAX_ITEMS_PER_REPORT),
      });
    }
    this.recordDaemonEvent("daemon.agent.model_seen.reported", {
      agentId,
      launchId: ap.launchId || undefined,
      conversations_count: items.length,
      messages_count: pending.length,
    });
  }

  private handleParsedEvent(agentId: string, event: ParsedEvent, driver: RuntimeDriver) {
    const ap = this.agents.get(agentId);
    // task #1114: only model-driven runtime events prove that stdin writes were
    // consumed, and only when they belong to the live session/turn of this
    // process. The process-binding fence upstream already rejects events from a
    // stale launch; this gate covers a stale session or a turn-less event on
    // the live process (a bare event with no open turn cannot be attributed to
    // an unconsumed write).
    if (ap && isDeliveryConsumptionEvent(event.kind)) {
      const association = this.deliveryConsumptionAssociation(ap, event);
      if (association === "associated") {
        ap.deliveryConsumption.recordConsumption(event.kind, Date.now());
        this.flushModelSeen(agentId, ap);
      } else {
        this.recordDaemonEvent("daemon.agent.delivery.consumption.ignored", {
          agent_id: agentId,
          launch_id: ap.launchId || "",
          event_kind: event.kind,
          reason: association,
          session_id_present: Boolean(ap.sessionId),
          unconsumed_deliveries: ap.deliveryConsumption.snapshot().unconsumedDeliveries,
        });
      }
    }
    if (event.kind === "model_limits") {
      // Display evidence only: not model progress, consumption or lifecycle.
      if (ap) this.recordModelLimits(agentId, ap, event);
      return;
    }
    if (event.kind === "provider_request") {
      if (!ap) return;
      ap.providerRequest = event.activity;
      const { provider, phase } = event.activity;
      // `waiting` and `responding` fire on every provider HTTP request, so an
      // ordinary turn posted two activity rows that only restated "a model call
      // happened" — the surrounding tool/thinking rows already say that, and the
      // pair crowded them out of the log (@artin, 1.0.36). Those two phases stay
      // on `ap.providerRequest`, which rides along on later activity frames; only
      // the log row is gone. `failed`/`cancelled` are rare and are the sole
      // user-visible signal that a stall is the provider's, so they still post.
      if (phase === "waiting" || phase === "responding") return;
      const detail = phase === "failed" ? `Model service request failed (${provider})` : `Model request cancelled (${provider})`;
      this.broadcastActivity(agentId, ap.lastActivityKind ?? "working", detail, [], ap.launchId, "provider_request_status");
      // Display only: not model progress, readiness, consumption or lifecycle authority.
      return;
    }
    if (event.kind === "telemetry") {
      if (ap) this.recordRuntimeTelemetry(agentId, ap, event);
      if (event.providerQuota) this.providerQuota.observe(agentId, ap?.config.runtime ?? driver.id, event.providerQuota);
      return;
    }
    if (event.kind === "send_intent") {
      // Display hint only: not model progress, readiness or lifecycle.
      if (ap) this.sendIntents.start(agentId, { callId: event.callId, target: event.target, early: event.early, launchId: ap.launchId || undefined });
      return;
    }
    if (event.kind === "runtime_tooling") {
      if (ap) {
        this.recordRuntimeToolingObservation(agentId, ap, event);
      } else {
        this.recordDaemonEvent("daemon.runtime.tooling.exposure_without_process", {
          agentId,
          runtime: driver.id,
          ...runtimeToolingObservationAttrs(event),
        });
      }
      return;
    }
    if (event.kind === "delivery_error") {
      if (ap) {
        ap.deliveryConsumption.recordDeliveryError("runtime_delivery_error", Date.now());
        // task #26: the rejected input may have carried the server context,
        // including one that stops the agent here.
        this.serverContext.forgetReach(agentId, { processInstanceId: ap.processInstanceId, sessionId: ap.sessionId });
        if (this.stopOnTerminalDeliveryError(agentId, ap, event)) return;
        this.restoreRuntimeDeliveryAfterAsyncRejection(agentId, ap, event);
        this.interruptCompactionIfActive(agentId, {
          detail: `Context compaction interrupted after runtime delivery failed: ${event.message}`,
          entries: [{ kind: "text", text: `Error: ${event.message}` }],
          flushBoundaryMessages: true,
          traceAttrs: {
            reason: "delivery_error",
            request_method: event.requestMethod,
            source: event.source,
            payloadBytes: event.payloadBytes,
          },
        });
      } else {
        this.recordDaemonEvent("daemon.agent.delivery_error.received_without_process", {
          agentId,
          event_kind: event.kind,
          runtime: driver.id,
          request_method: event.requestMethod,
          source: event.source,
          payloadBytes: event.payloadBytes,
        });
      }
      return;
    }
    if (ap && isStartupRequestErrorEvent(event)) {
      this.handleRuntimeStartupRequestError(agentId, ap, event);
      return;
    }
    if (ap) {
      const wasStalled = ap.runtimeProgress.isStale;
      if (this.runtimeStartupReadinessSatisfiedByEvent(ap, event)) {
        this.markRuntimeStartupReady(agentId, ap);
        this.closeRuntimeReadinessTransition(ap, "advanced");
      }
      // Model output with no open turn means the runtime started a turn by
      // itself, so the turn span opens here. Other events never open a turn,
      // nor does a subagent's output: a Codex subagent keeps working after the
      // agent's turn ended. Open before counting so this first event is kept
      // in the new counters.
      if (isModelWorkEvent(event.kind) && !("subagent" in event && event.subagent)) {
        this.startRuntimeTrace(agentId, ap, "runtime-progress");
        // Model work: a turn runs on input the last turn end left queued
        // (pending until that turn ends, which decides again).
        ap.deliveryConsumption.noteTurnStarted();
        this.clearQueuedInputSettle(ap);
      }
      // A sub-agent's own row says its background task still runs (backgroundTaskHealth.ts).
      if ("subagent" in event && event.subagent) {
        const taskId = backgroundTaskForSubagentRow(ap.backgroundTasks, event.subagent);
        const task = taskId === null ? undefined : ap.backgroundTasks.get(taskId);
        if (task) task.lastEventAtMs = this.clockNow();
      }
      noteRuntimeTraceCounter(ap.runtimeTraceCounters, event);
      noteTurnOutcomeEvent(ap.turnOutcome, event);
      const eventAttrs = event.kind === "internal_progress"
        ? {
            kind: event.kind,
            source: event.source,
            itemType: event.itemType,
            payloadBytes: event.payloadBytes,
            ...(event.role ? { role: event.role } : {}),
            ...(event.phase ? { phase: event.phase } : {}),
          }
        : event.kind === "subagent_progress"
          ? {
              kind: event.kind,
              source: event.source,
              phase: event.phase,
              parent_tool_use_id_present: Boolean(event.parentToolUseId),
              subagent_type_present: Boolean(event.subagentType),
              task_id_present: Boolean(event.taskId),
              last_tool_name_present: Boolean(event.lastToolName),
              payloadBytes: event.payloadBytes,
            }
        : event.kind === "runtime_diagnostic"
          ? runtimeDiagnosticTraceAttrs(event)
        : event.kind === "runtime_recovery"
          ? runtimeRecoveryTraceAttrs(event)
          : runtimeTurnEventTraceAttrs(event);
      this.recordRuntimeTraceEvent(agentId, ap, "runtime.event.received", eventAttrs);
      const recordProgressObservedAfterStall = () => {
        if (!wasStalled) return;
        this.recordRuntimeTraceEvent(agentId, ap, "runtime.progress.observed", { afterStall: true });
      };
      if (event.kind === "internal_progress") {
        ap.runtimeProgress.noteInternalProgress();
        this.armStallDeadlineForQueuedWork(agentId, ap);
        recordProgressObservedAfterStall();
        this.invalidateRecoveryErrorView(ap);
        this.clearRuntimeErrorDeliveryBackoffAfterProgress(agentId, ap, event.kind);
        this.recordRuntimeTraceEvent(agentId, ap, "runtime.progress.internal_observed", {
          turn_outcome: "held",
          turn_subtype: "runtime_progress",
          turn_reason: "internal_activity_observed",
          signal: event.source,
          source: "runtime_event",
          runtime: ap.config.runtime,
          itemType: event.itemType,
          payloadBytes: event.payloadBytes,
          ...(event.role ? { role: event.role } : {}),
          ...(event.phase ? { phase: event.phase } : {}),
        });
        // Surface quiet long turns once; the heartbeat carries subsequent liveness.
        this.maybeBroadcastRuntimeProgressActivity(agentId, ap, event);
        return;
      }

      if (event.kind === "subagent_progress") {
        this.noteRuntimeProgress(agentId, ap, event.kind);
        recordProgressObservedAfterStall();
        this.invalidateRecoveryErrorView(ap);
        this.clearRuntimeErrorDeliveryBackoffAfterProgress(agentId, ap, event.kind);
        const backgroundTasksBefore = ap.backgroundTasks.size;
        this.recordSubagentProgressActivity(agentId, ap, event);
        // Server features: the last background task ended (after any wake it started).
        if (backgroundTasksBefore > 0 && ap.backgroundTasks.size === 0) this.reconcile(agentId, ap, "background_tasks_done");
        return;
      }
      if (event.kind === "runtime_diagnostic") {
        // An observation of missing output is not evidence of successful progress.
        // Preserve readiness, stale/error counters and retry/backoff state.
        if (event.severity === "info") {
          this.recordRuntimeDiagnosticActivity(agentId, ap, event);
          return;
        }
        this.noteRuntimeProgress(agentId, ap, event.kind);
        recordProgressObservedAfterStall();
        this.clearRuntimeErrorDeliveryBackoffAfterProgress(agentId, ap, event.kind);
        this.recordRuntimeDiagnosticActivity(agentId, ap, event);
        return;
      }
      if (event.kind === "runtime_recovery") {
        this.recordRuntimeRecoveryActivity(agentId, ap, event);
        return;
      }
      this.noteRuntimeProgress(agentId, ap, event.kind);
      // A turn end resets the crash streak only when no runtime error preceded
      // it (cursor reports a failed turn as error + turn_end). Model output
      // resets it in the text/thinking/tool_call handlers below.
      if (event.kind === "turn_end" && !ap.lastRuntimeError) {
        this.resetRuntimeErrorCloseStreak(agentId, "runtime_progress:turn_end", ap);
        // Reconciler step 12: a turn of the new session completed with output; it fits again.
        if (ap.modelOutputObserved) this.lifecycleRecords.exitStreaks.sticky.endSessionReset(agentId);
      }
      if (event.kind === "turn_end") this.resetStalledReplacementStreak(agentId);
      if (this.runtimeErrorFingerprintFenceResetEvent(event.kind)) {
        this.resetRuntimeErrorFingerprintFence(agentId, `runtime_progress:${event.kind}`, ap);
        this.resetRuntimeErrorClassFence(agentId, ap, `runtime_progress:${event.kind}`);
      }
      recordProgressObservedAfterStall();
    } else if (event.kind !== "internal_progress") {
      this.recordDaemonEvent("daemon.agent.event.received_without_process", {
        agentId,
        event_kind: event.kind,
        runtime: driver.id,
      });
    }

    if (ap && runtimeEventEndsThinking(event.kind) && ap.lastActivityDetailKind === "thinking_started") {
      this.flushPendingTrajectory(agentId); this.broadcastActivity(agentId, "working", "Thinking finished", [], undefined, "thinking_end");
      this.recordRuntimeTraceEvent(agentId, ap, "runtime.thinking.finished", { reason: event.kind });
    }

    switch (event.kind) {
      case "session_init":
        if (ap) {
          const previousSessionId = ap.sessionId;
          // RFC 072 §7.2.3: the runtime's own report decides which session the
          // published context id belongs to; a different session than the one
          // this process started on gets a new id.
          ap.contextId = bindContextGenerationToSession(ap.cliTransportDir, {
            runtime: ap.config.runtime,
            compaction: ap.driver.session.compaction,
            sessionId: event.sessionId,
            expectedSessionId: previousSessionId ?? ap.config.sessionId ?? null,
          });
          this.runtimeProcessBindingFence.rebindSession(agentId, ap, event.sessionId, "session_init");
          ap.sessionId = event.sessionId;
          this.serverContext.noteSession(agentId, ap.processInstanceId, event.sessionId);
          if (ap.standingPrompt) {
            const reported = standingPromptRecordForReportedSession(ap.standingPrompt.binding, event.sessionId, ap.standingPrompt.hash);
            ap.standingPrompt = { hash: ap.standingPrompt.hash, binding: reported.binding };
            this.recordSessionStandingPrompt(agentId, event.sessionId, reported.promptHash);
          }
          const retryReason = prepareSessionInitDeliveryDebtRetry(ap, previousSessionId);
          if (retryReason) this.scheduleSessionReadyDeliveryRetry(agentId, ap, retryReason);
        }
        // TODO(lifecycle-v2/daemon-protocol): session_init should produce a
        // canonical runtime_ready/session_init lifecycle event with launchId
        // and sessionId. This legacy `agent:session` is retained only for the
        // server adapter path.
        this.reportSession(agentId, ap, event.sessionId);
        this.sendRuntimeProfileReport(agentId, "session_init");
        break;

      case "thinking": {
        // A subagent's output says nothing about the agent's own compaction.
        if (!event.subagent) this.completeCompactionIfActive(agentId, "Context compaction finished (inferred from resumed output)");
        this.queueTrajectoryText(agentId, "thinking", event.text, event.subagent);
        if (ap) {
          // task #386: Codex (turn/started), Copilot, Kimi and OpenCode mark a
          // turn or step start with an empty thinking event before the model
          // has produced anything; it is bookkeeping, not recovery.
          const progressKind = event.text.length > 0 ? event.kind : "thinking_marker";
          this.clearRuntimeErrorDeliveryBackoffAfterProgress(agentId, ap, progressKind, Boolean(event.subagent));
          this.resetRuntimeErrorCloseStreakAfterModelOutput(agentId, ap, progressKind, Boolean(event.subagent));
          // A subagent's output is not the agent's turn: a Codex subagent keeps
          // writing after the agent's turn ended, and must not make it busy.
          if (!event.subagent) this.busyDelivery.applyAssistantContinuation(agentId, ap, event.kind, event.runtimeTurn);
        }
        break;
      }

      case "text": {
        // A subagent's output says nothing about the agent's own compaction.
        if (!event.subagent) this.completeCompactionIfActive(agentId, "Context compaction finished (inferred from resumed output)");
        this.queueTrajectoryText(agentId, "text", event.text, event.subagent);
        if (ap) {
          this.clearRuntimeErrorDeliveryBackoffAfterProgress(agentId, ap, event.kind, Boolean(event.subagent));
          this.resetRuntimeErrorCloseStreakAfterModelOutput(agentId, ap, event.kind, Boolean(event.subagent));
          if (!event.subagent) this.busyDelivery.applyAssistantContinuation(agentId, ap, event.kind, event.runtimeTurn);
        }
        break;
      }

      case "tool_call": {
        // A subagent's output says nothing about the agent's own compaction.
        if (!event.subagent) this.completeCompactionIfActive(agentId, "Context compaction finished (inferred from resumed tool use)");
        this.flushPendingTrajectory(agentId);
        const invocation = normalizeToolDisplayInvocation(event.name, event.input);
        if (ap) {
          noteRaftMessageSendAttempt(ap.runtimeTraceCounters, invocation.toolName);
          this.clearRuntimeErrorDeliveryBackoffAfterProgress(agentId, ap, event.kind, Boolean(event.subagent));
          this.resetRuntimeErrorCloseStreakAfterModelOutput(agentId, ap, event.kind, Boolean(event.subagent));
          const commandHead = shellCommandHeadCategory((event.input as { command?: unknown } | null | undefined)?.command);
          this.recordRuntimeTraceEvent(agentId, ap, "tool.call.started", {
            tool: invocation.toolName,
            ...(commandHead ? { command_head: commandHead } : {}),
          });
          // A subagent's tool is not one of the agent's open tool uses (see text).
          if (!event.subagent) this.commitGatedSteeringDecisionState(agentId, ap, reduceApmToolUse(ap.gatedSteering, { kind: "tool_call" }).nextState);
          if (event.callId && !event.subagent) (ap.openToolCallIds ??= new Set()).add(event.callId);
          // Agent typing line, late path: a send the driver did not announce while it streamed.
          if (!event.subagent) {
            this.sendIntents.noteToolCall(agentId, { callId: event.callId, name: event.name, input: event.input, launchId: ap.launchId || undefined });
          }
          // A busy notice the encoder refused (Codex: a turn accepted but not yet
          // started; Codex no longer closes steering at a tool's end) was otherwise
          // retried only on thinking/text. A turn that chains tools without visible
          // reasoning can steer here, at the next tool start, instead of holding the
          // notice until the turn ended.
          if (!event.subagent && ap.notifications.hasEncodeFailedNotice(ap.sessionId)) {
            this.flushPendingDirectStdinNotificationOnRuntimeProgress(agentId, ap, "tool_call");
          }
        }
        const inputSummary = summarizeToolInput(invocation.toolName, invocation.input);
        const detail = getToolActivityLabel(invocation.toolName);
        // APM 1.6 6b: preserve any explicit subagent lineage on the tool_start
        // entry so inner subagent tool calls group under a subagent. No lineage
        // → flat, ordinary tool_start (unchanged behavior).
        if (ap) {
          noteToolCallStart(ap.toolCallStarts ??= new Map(), event.callId, Date.now());
          (ap.toolStuck ??= new ToolStuckWatch()).noteToolStart(event.callId, invocation.toolName, Date.now());
        }
        this.broadcastActivity(agentId, "working", detail, [{
          kind: "tool_start",
          toolName: invocation.toolName,
          toolInput: inputSummary,
          ...(event.callId ? { callId: event.callId } : {}),
          ...(event.subagent ? { subagent: event.subagent } : {}),
        }], undefined, event.subagent ? "subagent_activity" : this.toolActivityDetailKind(invocation.toolName));
        break;
      }

      case "tool_output": {
        const invocation = normalizeToolDisplayInvocation(event.name, {});
        if (ap) {
          this.clearRuntimeErrorDeliveryBackoffAfterProgress(agentId, ap, event.kind);
          this.recordRuntimeTraceEvent(agentId, ap, "tool.output.observed", { tool: invocation.toolName });
          this.recordRuntimeTraceEvent(agentId, ap, "runtime.continuation.expected");
          if (event.callId) ap.openToolCallIds?.delete(event.callId);
          if (!event.subagent) this.commitGatedSteeringDecisionState(agentId, ap, reduceApmToolUse(ap.gatedSteering, { kind: "tool_output" }).nextState);
        }
        if (!event.subagent) this.sendIntents.noteToolOutput(agentId, event.callId);
        const outcome = finishToolCall(ap ? ap.toolCallStarts ??= new Map() : new Map(), event, Date.now());
        ap?.toolStuck?.noteToolEnd(event.callId);
        this.broadcastActivity(agentId, "working", "Tool finished", [], undefined, "tool_end", undefined, undefined, undefined, undefined, undefined, outcome);
        break;
      }

      case "compaction_started":
        this.flushPendingTrajectory(agentId);
        // RFC 072 §7.2.3: the context may be gone from here on (interrupted or
        // stale compactions included), so the new context id is issued at
        // start; finished / interrupted / stale do not issue another.
        if (ap) {
          const contextId = writeContextGeneration(ap.cliTransportDir, { reason: "compaction", runtime: ap.config.runtime, compaction: ap.driver.session.compaction, passiveAx: ap.passiveAx });
          ap.contextId = contextId;
          // A later resume of this session must not get the pre-compaction id;
          // a failed write forgets the session instead.
          if (ap.sessionId) rememberSessionContext(ap.cliTransportDir, ap.sessionId, contextId);
        }
        if (ap) this.recordRuntimeTraceEvent(agentId, ap, "runtime.context_compaction.started", { compaction_cycle_id_present: event.cycleId !== undefined });
        // Read before the compaction gate below marks the agent busy.
        if (ap) this.startCompactionWatchdog(agentId, ap, { cycleId: event.cycleId, startedIdle: ap.gatedSteering.isIdle && !ap.gatedSteering.compacting });
        if (ap && event.afterRunEnd === true) {
          const held = ap.compactionAfterRunEnd;
          // A repeated start of the cycle already held keeps what it has seen.
          if (!held || held.cycleId !== event.cycleId) {
            ap.compactionAfterRunEnd = { cycleId: event.cycleId, ended: false, turnEnded: held?.turnEnded ?? false };
          }
          this.recordRuntimeTraceEvent(agentId, ap, "runtime.context_compaction.after_run_end", { compaction_cycle_id_present: event.cycleId !== undefined });
        }
        this.broadcastActivity(agentId, "working", "Compacting context", [{ kind: "compaction_started" }], undefined, "compacting_context");
        if (ap) {
          const reduction = reduceApmGatedCompaction(ap.gatedSteering, { kind: "compaction_started" });
          this.commitGatedSteeringDecisionState(agentId, ap, reduction.nextState);
        }
        break;

      case "compaction_finished": {
        this.flushPendingTrajectory(agentId);
        if (ap?.turnEndCompaction?.inFlight && ap.turnEndCompaction.inFlight.finishedAtMs === null) ap.turnEndCompaction.inFlight.finishedAtMs = Date.now();
        const finishedCycle = ap?.compaction;
        if (ap && finishedCycle?.kind !== "active" && !ap.gatedSteering.compacting && ap.gatedSteering.isIdle) {
          // No compaction is open and the agent is idle: a repeated or late
          // finish. It must not mark the idle agent busy again.
          this.recordRuntimeTraceEvent(agentId, ap, "runtime.context_compaction.finished", { stray: true, compaction_cycle_id_present: event.cycleId !== undefined });
          break;
        }
        if (ap && finishedCycle?.kind === "active" && finishedCycle.cycleId !== undefined && event.cycleId !== undefined && event.cycleId !== finishedCycle.cycleId) {
          // Another cycle's (late or repeated) finish must not end the one open now.
          this.recordRuntimeTraceEvent(agentId, ap, "runtime.context_compaction.finished", { stray: true, cycle_mismatch: true, compaction_cycle_id_present: true });
          break;
        }
        if (ap && ap.compactionAfterRunEnd) {
          if (!this.endCompactionAfterRunEnd(agentId, ap, event.cycleId, "runtime.context_compaction.finished")) break;
          if (ap.driver.session.compactionFailure === "sticks_to_session") this.compactionFailureLedger.clear(agentId);
          this.broadcastActivity(agentId, "working", "Context compaction finished", [{ kind: "compaction_finished" }], undefined, "compaction_finished");
          if (ap.compactionAfterRunEnd?.turnEnded) this.releaseCompactionAfterRunEnd(agentId, ap, { showQuietStatus: true });
          break;
        }
        if (ap) this.recordRuntimeTraceEvent(agentId, ap, "runtime.context_compaction.finished", { compaction_cycle_id_present: event.cycleId !== undefined });
        if (ap && ap.driver.session.compactionFailure === "sticks_to_session") this.compactionFailureLedger.clear(agentId);
        if (ap) this.clearCompactionWatchdog(ap);
        this.broadcastActivity(agentId, "working", "Context compaction finished", [{ kind: "compaction_finished" }], undefined, "compaction_finished");
        if (ap) {
          const reduction = reduceApmGatedCompaction(ap.gatedSteering, { kind: "compaction_finished" });
          this.commitGatedSteeringDecisionState(agentId, ap, reduction.nextState);
          if (this.endsIdleCompactionCycle(ap, finishedCycle, event.cycleId)) {
            this.restoreIdleAfterIdleCompaction(agentId, ap, { showQuietStatus: true });
          } else {
            this.flushCompactionBoundaryMessages(agentId, ap);
          }
        }
        break;
      }

      case "compaction_interrupted": {
        this.flushPendingTrajectory(agentId);
        const interruptedCycle = ap?.compaction;
        if (ap && interruptedCycle?.kind === "active" && interruptedCycle.cycleId !== undefined && event.cycleId !== undefined && event.cycleId !== interruptedCycle.cycleId) {
          // Another cycle's (late or repeated) interruption must not end the one open now.
          this.recordRuntimeTraceEvent(agentId, ap, "runtime.context_compaction.interrupted", {
            ...projectCompactionInterruptionTraceAttrs(event),
            stray: true,
            cycle_mismatch: true,
            compaction_cycle_id_present: true,
          });
          break;
        }
        if (ap && ap.compactionAfterRunEnd) {
          if (!this.endCompactionAfterRunEnd(agentId, ap, event.cycleId, "runtime.context_compaction.interrupted", projectCompactionInterruptionTraceAttrs(event))) break;
          const heldFacts = projectCompactionInterruption(event);
          this.broadcastActivity(
            agentId,
            heldFacts.outcome === "aborted" ? "working" : "error",
            formatCompactionInterruption(heldFacts),
            [], undefined,
            heldFacts.outcome === "aborted" ? "system_message" : "runtime_error",
            undefined, undefined, undefined, undefined, heldFacts,
          );
          // A failure stays the visible status; a retry (willRetry) runs on and its turn end releases.
          if (ap.compactionAfterRunEnd?.turnEnded) this.releaseCompactionAfterRunEnd(agentId, ap, { showQuietStatus: heldFacts.outcome === "aborted" });
          break;
        }
        this.interruptCompactionIfActive(agentId);
        // Overflow recovery can be exhausted after a successful finish, when
        // there is no active compaction. Its terminal fact must still survive.
        const facts = projectCompactionInterruption(event);
        if (ap) this.recordRuntimeTraceEvent(agentId, ap, "runtime.context_compaction.interrupted", { ...projectCompactionInterruptionTraceAttrs(event), compaction_cycle_id_present: event.cycleId !== undefined });
        this.broadcastActivity(
          agentId,
          facts.outcome === "aborted" ? "working" : "error",
          formatCompactionInterruption(facts),
          [], undefined,
          facts.outcome === "aborted" ? "system_message" : "runtime_error",
          undefined, undefined, undefined, undefined, facts,
        );
        if (ap && this.endsIdleCompactionCycle(ap, interruptedCycle, event.cycleId)) {
          // Back to idle for delivery; a failure stays the visible status.
          this.restoreIdleAfterIdleCompaction(agentId, ap, { showQuietStatus: facts.outcome === "aborted" });
        }
        break;
      }
      case "review_started":
        this.flushPendingTrajectory(agentId);
        if (ap) this.recordRuntimeTraceEvent(agentId, ap, "runtime.review_mode.started");
        this.broadcastActivity(agentId, "working", "Reviewing changes", [], undefined, "reviewing_changes");
        if (ap) {
          const reduction = reduceApmGatedReview(ap.gatedSteering, { kind: "review_started" });
          this.commitGatedSteeringDecisionState(agentId, ap, reduction.nextState);
          this.startReviewWatchdog(agentId, ap);
        }
        break;

      case "review_finished":
        this.flushPendingTrajectory(agentId);
        if (ap) {
          this.clearReviewWatchdog(ap);
          this.recordRuntimeTraceEvent(agentId, ap, "runtime.review_mode.finished");
        }
        this.broadcastActivity(agentId, "working", "Review finished", [], undefined, "review_finished");
        if (ap) {
          const reduction = reduceApmGatedReview(ap.gatedSteering, { kind: "review_finished" });
          this.commitGatedSteeringDecisionState(agentId, ap, reduction.nextState);
          this.flushReviewBoundaryMessages(agentId, ap);
        }
        break;

      case "turn_end":
        this.sendIntents.endAll(agentId);
        // The turn is over: a later error no longer joins its trace.
        if (ap) ap.endedRuntimeTurnTraceContext = null;
        if (ap?.turnEndCompaction?.inFlight) this.settleTurnEndCompaction(agentId, ap);
        if (ap) {
          ap.lastTurnEndInterrupted = event.interrupted === true;
          // The turn that just ended had any waiting sub-agent results in its input.
          ap.subagentResultUnread = false;
          ap.toolStuck?.clear();
          if (ap.turnEndWaiters?.size) {
            const waiters = [...ap.turnEndWaiters];
            ap.turnEndWaiters.clear();
            for (const resolve of waiters) resolve(event.interrupted === true);
          }
          this.recordRuntimeTraceEvent(agentId, ap, "runtime.turn.completed");
          this.recordCodexZeroToolZeroSendCompletion(agentId, ap);
        }
        // task #1362: a compaction held since after the run's end. Its end and
        // this turn end both release it, in whichever order they come.
        const heldCompaction = ap?.compactionAfterRunEnd;
        const holdForCompaction = Boolean(heldCompaction && !heldCompaction.ended);
        if (ap && heldCompaction) {
          heldCompaction.turnEnded = true;
          this.recordRuntimeTraceEvent(agentId, ap, "runtime.context_compaction.after_run_end_turn_end", { compaction_ended: heldCompaction.ended });
          if (heldCompaction.ended) {
            // Its end came first: open the gate, and this turn end delivers what waited.
            ap.compactionAfterRunEnd = undefined;
            this.commitGatedSteeringDecisionState(agentId, ap, reduceApmGatedCompaction(ap.gatedSteering, { kind: "compaction_finished" }).nextState);
          }
        }
        if (!holdForCompaction) {
          this.completeCompactionIfActive(agentId, "Context compaction finished (inferred from turn end)", {
            flushBoundaryMessages: false,
          });
        }
        this.flushPendingTrajectory(agentId);
        const turnEndSessionId = event.sessionId ?? ap?.driver.currentSessionId ?? undefined;
        // RFC 071 §4.4 E2: decided inside `if (ap)` (a registered launch, so a
        // turn end after terminal cleanup never qualifies), sent after this
        // turn's agent:session frame below.
        let turnCompleted: AgentRuntimeOutcome | null = null;
        if (ap) {
          if (turnEndSessionId) {
            this.runtimeProcessBindingFence.rebindSession(agentId, ap, turnEndSessionId, "turn_end");
            ap.sessionId = turnEndSessionId;
            this.serverContext.noteSession(agentId, ap.processInstanceId, turnEndSessionId);
          }
          this.markSessionReadyForDelivery(ap, "turn_end");
          clearSessionReadyDeliveryRetry(ap);
          // Reconciler step 12: a sticky failure no error event acted on
          // (only the runtime's stderr named it) is acted on after this turn end.
          const stickyTerminalFailure = classifyStickyFailure(ap);
          // The turn's own token counts go on its summary (agent usage,
          // #proj-o11y:42f2af5c): numbers and the model name only.
          this.turnSummaries.noteTokens(agentId, activityTurnTokensFrom(ap.runtimeTraceCounters.tokens, ap.config.model));
          // Messages queued during the turn are handed over below as the next
          // turn with no idle frame in between; this turn closes as it ended.
          this.turnSummaries.noteRuntimeTurnEnd(
            agentId,
            event.interrupted === true ? "interrupted" : stickyTerminalFailure || ap.turnOutcome.runtimeErrors > 0 ? "failed" : "completed",
            Date.now(),
          );
          const batchEcho = ap.catchupBatchEcho && ap.catchupBatchEcho.launchId === ap.launchId
            ? ap.catchupBatchEcho
            : null;
          turnCompleted = turnCompletedOutcome(ap.turnOutcome, Boolean(stickyTerminalFailure), batchEcho);
          // The first turn end closes the batch turn whatever its outcome
          // (echo at most once), and opens the next turn's counters.
          ap.catchupBatchEcho = null;
          ap.turnOutcome = createTurnOutcomeCounters();
          if (!stickyTerminalFailure && ap.runtimeErrorDeliveryBackoff.reason === "runtime_error") {
            this.clearRuntimeErrorDeliveryBackoffWithTrace(agentId, ap, "turn_end_unclassified_runtime_error");
          }
          const reduction = reduceApmGatedTurnEnd(ap.gatedSteering, {
            // A held compaction still runs: what is queued goes when it ends.
            inboxLength: stickyTerminalFailure || holdForCompaction ? 0 : ap.inbox.length,
            supportsStdinNotification: ap.driver.supportsStdinNotification,
            hasSession: this.canDeliverToRuntimeSession(ap),
            canDeliverWithoutSession: !ap.driver.requiresSessionInitForDelivery,
            terminateProcessOnTurnEnd: ap.driver.terminateProcessOnTurnEnd === true,
          });
          this.commitGatedSteeringDecisionState(agentId, ap, holdForCompaction ? { ...reduction.nextState, isIdle: false, compacting: true } : reduction.nextState);
          // Turn completed — check if there are queued messages to deliver
          const deliverStdinEffect = reduction.effects.find((effect) => effect.kind === "deliver_stdin");
          if (deliverStdinEffect) {
            const deliveredAtTurnEnd = this.executeApmGatedSteeringEffect(agentId, ap, deliverStdinEffect);
            if (deliveredAtTurnEnd) {
              this.completePendingTrackedMentions(agentId);
            } else {
              this.settleUndeliveredTrackedMentionsAtTurnEnd(agentId, ap);
              this.commitApmIdleState(agentId, ap, true);
              if (stickyTerminalFailure) {
                this.broadcastActivity(agentId, "error", stickyTerminalFailure.detail, [], undefined, "runtime_error");
              } else if (ap.lastRuntimeError && (ap.runtimeErrorDeliveryBackoff.attempts > 0 || this.credentialInvalidHold(agentId, ap.config))) {
                this.broadcastRuntimeErrorAtTurnEnd(agentId, ap, ap.lastRuntimeError);
              } else {
                // task #1260: Idle, or "waiting" while background tasks run.
                this.broadcastQuietTurnStatus(agentId, ap);
              }
            }
          } else {
            // Held behind the compaction, not refused: settled when it is delivered.
            if (!holdForCompaction) this.settleUndeliveredTrackedMentionsAtTurnEnd(agentId, ap);
            // No pending messages — mark idle, process stays alive waiting for stdin
            if (stickyTerminalFailure) {
              this.broadcastActivity(agentId, "error", stickyTerminalFailure.detail, [], undefined, "runtime_error");
            } else if (ap.lastRuntimeError) {
              // Runtime CLIs such as Claude can emit `error` immediately followed
              // by `turn_end`. The process is stdin-wakeable again, but the last
              // user-visible state must remain the error until a new inbox message
              // starts, otherwise the failure is only discoverable in Activity.
              this.broadcastRuntimeErrorAtTurnEnd(agentId, ap, ap.lastRuntimeError);
            } else if (!holdForCompaction) {
              // task #1260: Idle, or "waiting" while background tasks run.
              // (A held compaction keeps showing; its end shows the quiet status.)
              this.broadcastQuietTurnStatus(agentId, ap);
            }
          }
          this.endRuntimeTrace(ap, stickyTerminalFailure ? "error" : "ok", {
            outcome: stickyTerminalFailure ? "runtime-error-with-turn-end" : "turn-completed",
            ...(stickyTerminalFailure ? { terminalRuntimeError: true } : {}),
            ...runtimeTraceCounterAttrs(ap),
            ...this.finalizeRuntimeProfileTurnControl(agentId, ap, stickyTerminalFailure ? "runtime_error" : "turn_end"),
          });
          ap.endedRuntimeTurnTraceContext = null;
          if (ap.driver.terminateProcessOnTurnEnd) {
            logger.info(`[Agent ${agentId}] Turn completed; terminating ${ap.driver.id} process`);
            const projection = projectApmRuntimeTerminationTrace({ reason: "turn_end" });
            this.runtimeExitTraceAttrs.set(ap.runtime, projection.processExitAttrs);
            void this.stopRuntimeProcess(agentId, ap.runtime, "turn_end", { reason: projection.runtimeStopReason, launchId: ap.launchId });
          }
        }
        if (turnEndSessionId) {
          // TODO(lifecycle-v2/daemon-protocol): turn_end session resync should
          // reuse the canonical session_resynced/runtime_ready producer rather
          // than another legacy `agent:session` frame.
          this.reportSession(agentId, ap, turnEndSessionId);
          this.sendRuntimeProfileReport(agentId, "turn_end");
        }
        if (ap && turnCompleted) this.sendRuntimeOutcome(agentId, ap, turnCompleted);
        if (ap) this.reportFirstTurnEnded(agentId, ap, event.interrupted === true ? "interrupted" : turnCompleted ? "completed" : "failed");
        if (ap && this.agents.get(agentId) === ap) {
          const sticky = classifyStickyFailure(ap);
          if (sticky) {
            this.actOnStickyFailure(agentId, ap, sticky, terminalFailureFromRawText("sticky_runtime_error", ap.lastRuntimeError || sticky.detail));
            break;
          }
        }
        // Server features: a turn end is a "became idle" fact (reconciler
        // step 6). A process that has drifted is replaced, so no session
        // rotation starts under it (a rotation still due comes back after the
        // next compaction).
        if (ap) this.armQueuedInputSettle(agentId, ap);
        // A held compaction still runs in this session: its release reconciles and checks rotation (task #1362).
        if (ap && !holdForCompaction && !this.reconcile(agentId, ap, "turn_end")) this.rotateRuntimeSessionIfDue(agentId, ap);
        break;

      case "error": {
        this.interruptCompactionIfActive(agentId);
        this.interruptReviewIfActive(agentId);
        this.flushPendingTrajectory(agentId);
        const compaction = event.compaction ? projectCompactionInterruption(event.compaction) : undefined;
        if (ap && compaction) {
          this.recordRuntimeTraceEvent(agentId, ap, "runtime.context_compaction.interrupted", projectCompactionInterruptionTraceAttrs(compaction));
        }
        if (ap) {
          ap.lastRuntimeError = event.message;
          ap.decisionErrorWindow.recordRuntimeError(event.message);
          if (this.deliveryConsumptionAssociation(ap, event) === "associated") {
            const errorClass = buildRuntimeErrorDiagnosticEnvelope(event.message).spanAttrs.runtime_error_class;
            ap.deliveryConsumption.recordRuntimeError(typeof errorClass === "string" ? errorClass : "unclassified", Date.now());
          }
        }
        let visibleErrorMessage = event.message;
        let visibleErrorEntries: TrajectoryEntry[] | undefined;
        // Reconciler step 12: what a sticky failure does next, after its error is shown.
        let afterVisibleError: (() => void) | null = null;
        // The runtime's structured provider limit, or a usage limit known only
        // from the error's wording (C5): one path from here on.
        const providerLimit = runtimeErrorProviderLimit(event);
        if (ap) {
          const runtimeErrorDiagnostics = buildRuntimeErrorDiagnosticEnvelope(event.message);
          // The class and HTTP status the turn span and its runtime.error
          // record carry: the runtime's typed API error when it reported one
          // (a Claude rate_limit, verification_required, ...).
          const runtimeErrorTraceClass = runtimeErrorTraceClassAttrs(runtimeErrorDiagnostics, event.message, event.providerError);
          const compactionDiagnosticAttrs = compaction?.failureDiagnostic
            ? {
                runtime_error_class: compaction.failureDiagnostic.errorClass,
                turn_reason: compaction.failureDiagnostic.errorReason,
                runtime_error_fingerprint: compaction.failureDiagnostic.fingerprint,
              }
            : {};
          const runtimeErrorFingerprint = typeof runtimeErrorDiagnostics.spanAttrs.runtime_error_fingerprint === "string"
            ? runtimeErrorDiagnostics.spanAttrs.runtime_error_fingerprint
            : null;
          if (runtimeErrorDiagnostics.spanAttrs.runtime_error_class === "InputTooLargeError") {
            visibleErrorMessage = formatRuntimeInputTooLargeMessage(ap.driver.id);
          }
          const backoffFailPoint = this.runtimeErrorDeliveryBackoffFailPointForTesting?.({
            agentId,
            message: event.message,
          }) ?? null;
          const structuredCompactionTerminalFailure = projectStructuredRuntimeTerminalFailure(event, ap.driver.id);
          if (structuredCompactionTerminalFailure) this.countTerminalCompactionFailure(agentId, ap, event);
          // #proj-raft-computer:#46 (reconciler step 4a): a rejected sign-in, a
          // plan without the model or an exhausted billing balance makes the
          // agent's credential invalid; the process is not broken. It is
          // recorded on the credential (both hosts hold every agent it
          // applies to), the process and its background tasks are kept, and
          // deliveries wait until the credential changes, a turn on it
          // produces model output, or a person stops the agent (Retry). No
          // stop, no terminal cleanup, no fence, no timed backoff.
          const credentialInvalidReason = !backoffFailPoint && !structuredCompactionTerminalFailure && !providerLimit
            ? credentialInvalidReasonOf(event.message)
            : null;
          if (credentialInvalidReason) {
            const invalid = this.noteCredentialInvalid(agentId, ap, credentialInvalidReason, event.message, "runtime_error");
            visibleErrorMessage = invalid.detail;
            visibleErrorEntries = invalid.entries;
            this.commitGatedSteeringDecisionState(agentId, ap, reduceApmGatedError(ap.gatedSteering, {
              terminalWakeable: ap.driver.supportsStdinNotification,
            }).nextState);
            this.recordRuntimeTraceEvent(agentId, ap, "runtime.error", {
              ...runtimeErrorDiagnostics.eventAttrs,
              ...runtimeErrorTraceClass,
              ...invalid.traceAttrs,
              ...runtimeTraceCounterAttrs(ap),
            });
            this.endRuntimeTrace(ap, "error", {
              outcome: "runtime-error",
              ...runtimeErrorDiagnostics.spanAttrs,
              ...runtimeErrorTraceClass,
              ...invalid.traceAttrs,
              ...runtimeTraceCounterAttrs(ap),
              ...this.finalizeRuntimeProfileTurnControl(agentId, ap, "runtime_error"),
            });
          } else {
            const terminalFailure = backoffFailPoint && Object.prototype.hasOwnProperty.call(backoffFailPoint, "terminalFailure")
              ? backoffFailPoint.terminalFailure ?? null
              : structuredCompactionTerminalFailure ?? classifyTerminalFailure(ap);
            // Reconciler step 12: a failed compaction sticks to the session as
            // a session that no longer fits does (C8): both get a new one.
            const failPointSticky = backoffFailPoint && Object.prototype.hasOwnProperty.call(backoffFailPoint, "stickyTerminalFailure")
              ? backoffFailPoint.stickyTerminalFailure ?? null
              : undefined;
            const stickyTerminalFailure: StickyFailure | null = failPointSticky !== undefined
              ? failPointSticky && { ...failPointSticky, kind: failPointSticky.kind ?? "model_unsupported" }
              : structuredCompactionTerminalFailure
                ? { ...structuredCompactionTerminalFailure, kind: "compaction_failed" }
                : classifyStickyFailure(ap);
            // C10: a Codex turn that did nothing counts like a crash (D6), not
            // toward the same-fingerprint fence.
            const codexZeroEvidence = !stickyTerminalFailure && isCodexZeroEvidenceTurnText(event.message);
            // A provider limit the runtime declared (a used-up quota or a
            // throttle: its structured limit, its typed rate_limit code, or
            // usage-limit wording) is a wait the provider-limit backoff and the
            // credential ledger handle, not a failure repeating: it never
            // counts toward the same-fingerprint fence. Its texts differ only
            // in the reset time, which the fingerprint ignores, so counting
            // them would stop an agent for waiting on its limit. A rate-limit
            // class known only from the text (a 429, "model is at capacity")
            // still counts, as before: that is how a capacity crash loop stops.
            const providerLimitError = Boolean(providerLimit) || providerErrorCodeClass(event.providerError) === "RateLimitError";
            // task #379: a provider limit (used-up quota or a short throttle)
            // takes the existing rate-limit delivery backoff. That backoff
            // survives turn_end, holds deliveries until it expires, and reports
            // QUOTA_LIMITED to tracked senders; real progress clears it. A
            // usage limit known only from its wording takes it too, as a
            // quota with no reported reset, instead of the plain terminal-error
            // backoff it used to get (#proj-raft-computer:#46, C5).
            const backoffReasonOverride = backoffFailPoint && Object.prototype.hasOwnProperty.call(backoffFailPoint, "reason")
              ? backoffFailPoint.reason ?? null
              : providerLimit
                ? "rate_limited"
                : undefined;
            const reduction = reduceApmGatedError(ap.gatedSteering, {
              terminalWakeable: Boolean(ap.driver.supportsStdinNotification && terminalFailure && !terminalFailure.actionRequired),
            });
            this.commitGatedSteeringDecisionState(agentId, ap, reduction.nextState);
            const fingerprintFence = this.noteRuntimeErrorFingerprintFence(
              agentId,
              ap,
              event.message,
              codexZeroEvidence || providerLimitError ? null : runtimeErrorFingerprint,
              terminalFailure,
              stickyTerminalFailure,
              String(runtimeErrorTraceClass.runtime_error_class),
            );
            const classFence = this.noteRuntimeErrorClassFence(
              agentId,
              ap,
              event.message,
              { ...runtimeErrorDiagnostics.spanAttrs, ...runtimeErrorTraceClass },
              terminalFailure,
              stickyTerminalFailure,
            );
            visibleErrorMessage = fingerprintFence?.detail ?? classFence?.detail ?? structuredCompactionTerminalFailure?.detail ?? visibleErrorMessage;
            // task #379: show a reset time only when the runtime reported one.
            if (!fingerprintFence && !classFence && providerLimit?.kind === "quota_exhausted" && providerLimit.resetsAt) {
              visibleErrorMessage = `${visibleErrorMessage} (limit resets at ${providerLimit.resetsAt})`;
            }
            visibleErrorEntries = terminalFailure?.entries;
            this.noteRuntimeErrorDeliveryBackoff(agentId, ap, event.message, terminalFailure, stickyTerminalFailure, backoffReasonOverride, providerLimit);
            // The Activity overview shows a run of these turns as one wait for the reset.
            if (providerLimit?.kind === "quota_exhausted") {
              const resetsAt = providerLimit.resetsAt ? Date.parse(providerLimit.resetsAt) : Number.NaN;
              this.turnSummaries.noteUsageLimit(agentId, Number.isFinite(resetsAt) ? resetsAt : undefined);
            }
            this.recordRuntimeTraceEvent(agentId, ap, "runtime.error", {
              ...runtimeErrorDiagnostics.eventAttrs,
              ...runtimeErrorTraceClass,
              ...(providerLimit
                ? {
                  provider_limit_kind: providerLimit.kind,
                  provider_limit_source: providerLimit.source,
                  provider_limit_reset_reported: Boolean(providerLimit.resetsAt),
                }
                : {}),
              ...compactionDiagnosticAttrs,
              ...runtimeTraceCounterAttrs(ap),
            });
            this.endRuntimeTrace(ap, "error", {
              outcome: "runtime-error",
              ...runtimeErrorDiagnostics.spanAttrs,
              ...runtimeErrorTraceClass,
              ...compactionDiagnosticAttrs,
              ...runtimeTraceCounterAttrs(ap),
              ...this.finalizeRuntimeProfileTurnControl(agentId, ap, "runtime_error"),
            });
            if (fingerprintFence) {
              this.applyRuntimeErrorFingerprintFence(agentId, ap, fingerprintFence);
            } else if (classFence) {
              this.applyRuntimeErrorClassFence(agentId, ap, classFence);
            } else if (stickyTerminalFailure) {
              // Reconciler step 12, every runtime (one that exits on its own
              // too): a new session, or the agent back to the server, once
              // the error is shown. RFC 071 §7 / test W-2: the compaction
              // diagnostic carries the raw SDK text's fingerprint;
              // event.message may be the display constant.
              const evidence = terminalFailureFromRuntimeErrorEvent(event, compaction);
              const failedProcess = ap;
              afterVisibleError = () => this.actOnStickyFailure(agentId, failedProcess, stickyTerminalFailure, evidence);
            } else if (codexZeroEvidence && this.noteCodexZeroEvidenceTurn(agentId, ap)) {
              const failedProcess = ap;
              afterVisibleError = () => this.handCodexZeroEvidenceStreakToServer(agentId, failedProcess);
            } else if (ap.driver.supportsStdinNotification && terminalFailure) {
              ap.notifications.clearPending();
              ap.notifications.clearTimer();
              logger.info(`[Agent ${agentId}] Marked ${ap.driver.id} wakeable after terminal runtime error`);
            }
          }
        }
        const activityDiagnostic = compaction?.failureDiagnostic ?? buildRuntimeErrorActivityDiagnostic(event.message, {
          ...(typeof event.nativeReasonPresent === "boolean"
            ? { nativeReasonPresent: event.nativeReasonPresent }
            : {}),
          ...(event.reasonProvenance ? { reasonProvenance: event.reasonProvenance } : {}),
          // A provider limit (the runtime's own, e.g. Claude Code's "You've hit
          // your weekly limit · resets ...", or a usage limit known from its
          // wording): the carrier says so instead of re-deriving the class from
          // wording the text classifier does not know.
          ...(providerLimit ? { errorClass: "RateLimitError" as const } : {}),
        });
        this.broadcastActivity(
          agentId,
          "error",
          visibleErrorMessage,
          visibleErrorEntries ?? (compaction ? [] : [{ kind: "text", text: `Error: ${visibleErrorMessage}` }]),
          undefined,
          "runtime_error",
          "error",
          undefined,
          activityDiagnostic,
          undefined,
          compaction,
        );
        afterVisibleError?.();
        break;
      }
    }
  }

  private recordRuntimeTelemetry(agentId: string, ap: AgentProcess, event: Extract<ParsedEvent, { kind: "telemetry" }>) {
    const sessionId = ap.driver.currentSessionId ?? event.sessionId ?? ap.sessionId ?? ap.config.sessionId;
    const telemetryAttrs = {
      ...sanitizeRuntimeTelemetryPayloadAttrs(event.attrs),
      ...this.runtimeTelemetryVersionAttrs(),
      ...(event.source ? { source: event.source } : {}),
      ...(event.usageKind ? { usageKind: event.usageKind } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(event.turnId ? { turnId: event.turnId } : {}),
      ...this.runtimeTelemetryResultIdentity(agentId, ap, event),
    };
    const attrs = {
      agentId,
      launchId: ap.launchId || undefined,
      runtime: ap.config.runtime,
      model: ap.config.model,
      telemetry_name: event.name,
      ...telemetryAttrs,
    };
    if (ap.runtimeTraceSpan) {
      const telemetryEventName = `runtime.telemetry.${event.name}`;
      addTurnSpanEvent(ap.runtimeTraceSpan, ap.runtimeTraceCounters, telemetryEventName, telemetryAttrs);
      noteTurnTokenUsage(ap.runtimeTraceCounters.tokens, event);
    }
    // #proj-runtime:#54 phase 3: the size facts a turn end decides on.
    noteLegacyTurnEndContext((ap.turnEndCompaction ??= createLegacyTurnEndCompactionState()), event);
    this.recordDaemonEvent(`daemon.runtime.telemetry.${event.name}`, attrs);
  }

  private recordRuntimeToolingObservation(
    agentId: string,
    ap: AgentProcess,
    event: Extract<ParsedEvent, { kind: "runtime_tooling" }>,
  ): void {
    const attrs = runtimeToolingObservationAttrs(event);
    this.recordRuntimeTraceEvent(agentId, ap, "runtime.tooling.exposure", attrs);
    this.recordDaemonEvent("daemon.runtime.tooling.exposure", {
      ...this.processLifecycleIdentityAttrs(agentId, ap),
      ...attrs,
    });
  }

  private recordCodexZeroToolZeroSendCompletion(agentId: string, ap: AgentProcess): void {
    const attrs = codexCommunicationGapAttrs(ap.driver.id, ap.runtimeTraceCounters);
    if (!attrs) return;
    this.recordRuntimeTraceEvent(agentId, ap, "runtime.turn.communication_gap", attrs);
    this.recordDaemonEvent("daemon.runtime.turn.communication_gap", {
      ...this.processLifecycleIdentityAttrs(agentId, ap),
      ...attrs,
    });
  }

  private runtimeTelemetryResultIdentity(
    agentId: string,
    ap: AgentProcess,
    event: Extract<ParsedEvent, { kind: "telemetry" }>,
  ): Record<string, string> {
    if (event.runtimeResultId) return { runtimeResultId: event.runtimeResultId };
    if (event.name !== "token_usage" || event.source !== "claude_result_usage") return {};
    const sequence = ++ap.runtimeTelemetryResultSeq;
    const scope = ap.launchId || agentId;
    return {
      runtimeResultId: `${scope}:claude_result_usage:${sequence}`,
      runtimeResultIdSource: "daemon_sequence",
    };
  }

  private runtimeTelemetryVersionAttrs(): Record<string, string | boolean> {
    return runtimeTelemetryVersionAttrs(this.daemonVersion, this.computerVersion);
  }

  /**
   * RFC 071 §6: the batch of the start whose launch this spawn carries, with
   * the number of its rows the spawn rendered as input. The slot is taken
   * either way, so a batch the spawn did not render (for example a resume
   * prompt or a wake message took the first input) can never be echoed later.
   */
  private takeStartCatchupBatch(
    agentId: string,
    launchId: string | null,
    renderedRows: number,
  ): { launchId: string; batchId: string; renderedRows: number } | null {
    const slot = this.startCatchupBatches.get(agentId);
    if (!slot || !launchId || slot.launchId !== launchId) return null;
    this.startCatchupBatches.delete(agentId);
    // A batch with no rendered rows is armed with 0 rows and never echoed
    // (turnCompletedOutcome). A runtime-profile control start renders its
    // batch too (F9, startupInput.ts).
    return { ...slot, renderedRows };
  }

  /**
   * RFC 071 §7 `agent:runtime:outcome` v1. Requires a launchId and this
   * daemon's instance id (no launch, no frame: the same as an old daemon).
   * clientSeq is the per-agent counter shared with agent:status/activity.
   */
  /**
   * The first turn end of this process, once: how it ended and which unread
   * targets its start input showed. On `completed` the server marks read the
   * ones the agent owes nothing in, up to its own start snapshot. A launch with
   * no launchId has nothing for the server to match it to.
   */
  private reportFirstTurnEnded(agentId: string, ap: AgentProcess, outcome: AgentTurnEndedOutcome): void {
    if (ap.turnEndedReported) return;
    ap.turnEndedReported = true;
    if (!this.serverReadsTurnEnded || !ap.launchId) return;
    this.sendToServer({
      type: "agent:turn:ended",
      agentId,
      launchId: ap.launchId,
      outcome,
      shownUnreadTargets: ap.startupUnreadShown.slice(0, AGENT_TURN_ENDED_MAX_SHOWN_TARGETS),
    });
  }

  private sendRuntimeOutcome(agentId: string, ap: AgentProcess, outcome: AgentRuntimeOutcome): void {
    const launchId = ap.launchId || null;
    if (!launchId || !this.daemonInstanceId) return;
    const sessionId = ap.driver.currentSessionId ?? ap.sessionId ?? ap.config.sessionId ?? null;
    const observedAtMs = this.clockNow();
    this.sendToServer({
      type: "agent:runtime:outcome",
      v: 1,
      agentId,
      launchId,
      sessionId,
      daemonInstanceId: this.daemonInstanceId,
      clientSeq: this.activitySink.nextClientSeq(agentId),
      observedAtMs,
      outcome,
    });
    this.recordDaemonEvent("daemon.agent.runtime_outcome.sent", {
      agentId,
      launchId,
      kind: outcome.kind,
      ...(outcome.kind === "terminal_failure"
        ? { failure_kind: outcome.failureKind, fingerprint: outcome.fingerprint, runtime_error_class: outcome.errorClass }
        : {
            text_events_count: outcome.textEvents,
            tool_calls_count: outcome.toolCalls,
            catchup_batch_echoed: Boolean(outcome.catchupBatchId),
          }),
      session_id_present: Boolean(sessionId),
    });
  }

  /**
   * RFC 071 §4.3 rule 2: the process identity minted for this spawn. Every
   * accepted launch still waiting for a result is bound to it: the spawn's
   * own launch, and the starts folded into it (`supersededLaunchIds`). With
   * none waiting, the daemon started this runtime on its own (`respawn`).
   * Sent at most once per process.
   */
  private sendProcessSpawned(agentId: string, ap: AgentProcess, spawnLaunchId: string | null): void {
    if (ap.spawnReported) return;
    ap.spawnReported = true;
    const waiting = this.acceptedLaunches.get(agentId) ?? [];
    this.acceptedLaunches.delete(agentId);
    if (!spawnLaunchId || !this.daemonInstanceId) return;
    const supersededLaunchIds = waiting.filter((launchId) => launchId !== spawnLaunchId);
    this.sendToServer({
      type: "agent:process_spawned",
      agentId,
      daemonInstanceId: this.daemonInstanceId,
      processInstanceId: ap.processInstanceId,
      launchId: spawnLaunchId,
      clientSeq: this.activitySink.nextClientSeq(agentId),
      ...(supersededLaunchIds.length > 0 ? { supersededLaunchIds } : {}),
      ...(waiting.includes(spawnLaunchId) ? {} : { respawn: true }),
    });
  }

  /** RFC 071: settle every accepted launch of this agent that is still waiting. */
  private settleAllAcceptedLaunches(agentId: string, reason: AgentStartNotSpawnedReason): void {
    const waiting = this.acceptedLaunches.get(agentId);
    if (!waiting || waiting.length === 0) return;
    this.settleLaunches(agentId, [...waiting], { kind: "not_spawned", reason });
  }

  /**
   * RFC 071 `agent:start:outcome`: the final result of accepted launches that
   * `process_spawned` does not name. Only launches still waiting are settled,
   * so each launch gets exactly one result.
   */
  private settleLaunches(
    agentId: string,
    launchIds: string[],
    result: Extract<MachineToServerMessage, { type: "agent:start:outcome" }>["result"],
  ): void {
    const waiting = this.acceptedLaunches.get(agentId);
    if (!waiting) return;
    for (const launchId of launchIds) {
      const index = waiting.indexOf(launchId);
      if (index < 0) continue;
      waiting.splice(index, 1);
      if (!this.daemonInstanceId) continue;
      this.sendToServer({
        type: "agent:start:outcome",
        agentId,
        daemonInstanceId: this.daemonInstanceId,
        launchId,
        clientSeq: this.activitySink.nextClientSeq(agentId),
        result,
      });
    }
    if (waiting.length === 0) this.acceptedLaunches.delete(agentId);
  }

  /**
   * RFC 071 §4.3 rule 3: `process` is the closure-captured record of the
   * runtime that exited (it keeps its identity after the registry forgot it);
   * `spawnLaunchId` is its birth launch, null for a process the daemon
   * started on its own without one, and stays null after a server start is
   * rebound onto it (a rebind is never its birth). `launchId` is the last
   * launch it carried (a rebind moves it). Sent whenever the process carried
   * a server launch at birth or through a rebind; returns whether it was.
   */
  private sendProcessExited(
    agentId: string,
    process: AgentProcess,
    spawnLaunchId: string | null,
    code: number | null,
    signal: string | null,
  ): boolean {
    const lastLaunchId = process.launchId || spawnLaunchId;
    if (!lastLaunchId || !this.daemonInstanceId) return false;
    this.sendToServer({
      type: "agent:process_exited",
      agentId,
      daemonInstanceId: this.daemonInstanceId,
      processInstanceId: process.processInstanceId,
      spawnLaunchId: spawnLaunchId || null,
      launchId: lastLaunchId,
      clientSeq: this.activitySink.nextClientSeq(agentId),
      code,
      signal,
    });
    return true;
  }

  private sendAgentStatus(
    agentId: string,
    status: string,
    launchId: string | null,
    // task #1119: how the process ended (code/signal) when `status` reports an
    // exit, so the server's wake crash-loop breaker can record the signal.
    exit?: { code: number | null; signal: string | null },
  ) {
    const normalizedLaunchId = launchId || null;
    const ap = this.agents.get(agentId);
    this.recordDaemonEvent("daemon.agent.status.transition", this.lifecycleRecords.agentStatusTransitionAttrs({ agentId, status, launchId: normalizedLaunchId, observedAtMs: this.clockNow(), processInstanceId: ap?.processInstanceId, runtime: ap?.config.runtime, sessionIdPresent: ap ? Boolean(ap.sessionId) : undefined }));
    // RFC 069 §8: status is the only state channel, so it is sequenced with the
    // agent's activity (same counter) and tagged with this process's generation;
    // the server accepts it only in order and only from the connected process.
    this.sendToServer({
      type: "agent:status",
      agentId,
      status,
      launchId: normalizedLaunchId || undefined,
      ...(exit ? { exit } : {}),
      ...(this.daemonInstanceId ? { daemonInstanceId: this.daemonInstanceId } : {}),
      clientSeq: this.activitySink.nextClientSeq(agentId),
    });
  }

  /**
   * RFC 069 §8: a start that failed before the manager settled it (core-side
   * refusal, start pump overflow) still reports `inactive` on
   * the sequenced status channel, so the server orders it against this
   * process's other status frames instead of taking the legacy path.
   */
  reportStartFailureStatus(agentId: string, launchId: string | null | undefined): void {
    this.sendAgentStatus(agentId, "inactive", launchId ?? null);
  }

  /**
   * A start failed: a server-dispatched one, or a daemon-local restart this
   * manager stopped retrying. Report `inactive` and the failure's activity, and
   * remember it until the agent starts or is stopped, so a delivery that later
   * finds no process shows this failure again instead of a bare "restart
   * required" (the owner keeps seeing what to fix).
   */
  reportStartFailure(
    agentId: string,
    launchId: string | null | undefined,
    classification: SpawnFailureClassification,
    model: string | null | undefined,
  ): void {
    const report: LastStartFailure = { launchId: launchId ?? null, ...startFailureActivity(classification, model) };
    this.lastStartFailures.set(agentId, report);
    this.sendAgentStatus(agentId, "inactive", report.launchId);
    this.sendStartFailureActivity(agentId, report);
  }

  private sendStartFailureActivity(agentId: string, report: LastStartFailure): void {
    // Accepted ambient clock: telemetry records the daemon's observed wall-clock time for this failure.
    this.sendToServer({
      type: "agent:activity",
      agentId,
      detail: report.detail,
      detailKind: "runtime_unavailable",
      ...(report.launchId ? { launchId: report.launchId } : {}),
      observedAtMs: Date.now(),
      isHeartbeat: false,
      spawnFailure: report.spawnFailure,
    });
  }

  /**
   * task #10: count a terminal compaction failure against the session it
   * happened in (on disk, so restarts do not reset it).
   */
  private countTerminalCompactionFailure(agentId: string, ap: AgentProcess, event: ParsedEvent): void {
    if (ap.driver.session.compactionFailure !== "sticks_to_session") return;
    const sessionId = ap.driver.currentSessionId ?? ap.sessionId ?? ap.config.sessionId ?? null;
    if (!sessionId) return;
    let count: number;
    try {
      count = this.compactionFailureLedger.recordFailure(agentId, sessionId, ap.config.model ?? null);
    } catch (error) {
      logger.warn(`[Agent ${agentId}] compaction failure not recorded: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.recordDaemonEvent("daemon.agent.compaction.terminal_failure_counted", {
      agentId,
      launchId: ap.launchId || undefined,
      runtime: ap.config.runtime,
      model: ap.config.model,
      failure_reason: event.kind === "error" ? event.compaction?.failureReason ?? "unknown" : "unknown",
      consecutive_failures: count,
      needs_reset: count >= SESSION_NEEDS_RESET_THRESHOLD,
    });
  }

  /**
   * Reconciler step 8a (`chooseSession`): `config` without its session when
   * this daemon knows that session started on another runtime, or is a Codex
   * session that started on another model (step 7, SessionSpecMemory): the
   * start opens a new one, traced with the reason only, never a model name.
   * With `stuck`, a start that would resume a session that needs a reset
   * (task #10) is refused instead.
   */
  private withStartSessionChoice(agentId: string, config: AgentConfig, launchId: string | undefined, rules: { stuck: boolean }): AgentConfig {
    if (!config.sessionId) return config;
    const choice = chooseSession({
      sessionId: config.sessionId,
      // #oar-raft:#10: a Cursor SDK session (the OAR host's) cannot be resumed by the Cursor CLI.
      specDrop: this.sessionSpecs.sessionToDrop(agentId, config.sessionId, runtimeSpecOf(config))
        ?? runtimeHostSessionDrop(config.runtime, config.sessionId, "legacy"),
      ...(rules.stuck ? { stuckFailures: this.stuckSessionFailures(agentId, config) } : {}),
    });
    if (choice.kind === "refuse") {
      this.recordDaemonEvent("daemon.agent.start.session_needs_reset", {
        agentId,
        launchId: launchId || undefined,
        runtime: config.runtime,
        model: config.model,
        consecutive_failures: choice.failures,
      }, "error");
      throw new RuntimeSessionNeedsResetError({ runtimeId: config.runtime, failures: choice.failures });
    }
    if (choice.kind === "new" && choice.reason === "spec_drop") {
      this.traceSessionDroppedForSpec(agentId, config.sessionId, choice.dropReason, launchId, config);
      return { ...config, sessionId: null };
    }
    return config;
  }

  /** `sessionId`, or null (traced) when it started on another runtime or Codex model than `desired` (step 7). */
  private sessionIdUnlessSpecChanged(
    agentId: string,
    sessionId: string | null | undefined,
    desired: Pick<RuntimeSpecSnapshot, "runtime" | "model">,
    launchId: string | null | undefined,
    config: Pick<AgentConfig, "envVars">,
  ): string | null {
    if (!sessionId) return null;
    const choice = chooseSession({ sessionId, specDrop: this.sessionSpecs.sessionToDrop(agentId, sessionId, desired) ?? runtimeHostSessionDrop(desired.runtime, sessionId, "legacy") });
    if (choice.kind === "resume") return choice.sessionId;
    if (choice.kind === "new" && choice.reason === "spec_drop") this.traceSessionDroppedForSpec(agentId, sessionId, choice.dropReason, launchId, config);
    return null;
  }

  private traceSessionDroppedForSpec(
    agentId: string,
    sessionId: string,
    reason: SessionDropReason,
    launchId: string | null | undefined,
    config: Pick<AgentConfig, "envVars">,
  ): void {
    logger.info(`[Agent ${agentId}] Not resuming session ${sessionId}: it started on ${sessionDropReasonText(reason)}; a new session starts`);
    this.recordDaemonEvent("daemon.agent.session_dropped_for_spec", { agentId, launchId: launchId || undefined, reason, host: "legacy" });
    // #oar-raft:#10: a Cursor SDK session (the OAR host's) the Cursor CLI
    // cannot resume. The server forgets it, and the owner is told why a new
    // session started (not an error).
    if (reason === "runtime_host_changed") {
      this.sendToServer({ type: "agent:session:invalidate", agentId, sessionId, ...(launchId ? { launchId } : {}), reason: "runtime_host_migration" });
      this.broadcastActivity(
        agentId,
        "working",
        "Starting a new Cursor session…",
        [{ kind: "system", title: "New Cursor session", text: CURSOR_CLI_MIGRATION_TEXT }],
        launchId || null,
        "runtime_starting",
      );
    }
  }

  /** Reconciler step 7: the session a process ran, and the runtime and model it started on, for the next start's check. */
  private rememberSessionSpec(agentId: string, ap: AgentProcess): void {
    this.sessionSpecs.remember(agentId, ap.sessionId, ap.startedSpec);
  }

  /**
   * task #10: the consecutive compaction failures of `config`'s session when
   * its runtime's compaction failures stick to the session and they reached
   * SESSION_NEEDS_RESET_THRESHOLD, else null. Resuming it fails the same way
   * every time, so the start is refused as `session_needs_reset`
   * (`withStartSessionChoice`): the start-failure path reports it and the
   * Server pauses automatic starts; Reset Session (a new session id) or
   * another model gets out.
   */
  private stuckSessionFailures(agentId: string, config: AgentConfig): number | null {
    if (!config.sessionId) return null;
    let compactionFailure: RuntimeDriver["session"]["compactionFailure"];
    try {
      compactionFailure = this.driverResolver(config.runtime || "claude").session.compactionFailure;
    } catch {
      return null; // An unknown runtime fails at spawn, as it always has.
    }
    if (compactionFailure !== "sticks_to_session") return null;
    return this.compactionFailureLedger.needsReset(agentId, config.sessionId, config.model ?? null);
  }

  /**
   * task #13: once the runtime reports the session a launch runs on, record
   * the standing prompt it runs on (a fresh session got the current one,
   * natively or in its first input; a resumed one got it re-delivered, or is
   * recorded as its baseline). A session the prompt did not reach is recorded
   * as UNDELIVERED_STANDING_PROMPT_HASH, so its next resume re-delivers it.
   */
  private recordSessionStandingPrompt(agentId: string, sessionId: string, promptHash: string): void {
    try {
      const current = this.standingPromptLedger.read(agentId);
      if (current?.sessionId === sessionId && current.promptHash === promptHash) return;
      this.standingPromptLedger.write(agentId, sessionId, promptHash);
    } catch (error) {
      logger.warn(`[Agent ${agentId}] standing prompt record not written: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * A daemon-local restart (idle auto-restart, runtime-profile restart, end of
   * a spawn-fail cooldown) failed. Stop restarting the agent locally when the
   * failure is configuration the server decides retries for (a reason retrying
   * cannot fix, a retry-once reason, or the runtime missing on this computer:
   * `isRuntimeAbsentStartFailure`, the server's own rule) or after CRASH_STREAK_CAP
   * failures in a row: drop the restart snapshot and the buffered deliveries
   * (the Server still holds those messages; the next start carries them as
   * unread) and report the failure like a server-started one, so the owner
   * sees why and the Server's wake breaker counts it. Returns true when it
   * stopped.
   */
  private stopLocalRestartAfterFailure(
    agentId: string,
    cached: { config: AgentConfig; launchId: string | null },
    err: unknown,
    attempts: number,
    source: string,
  ): boolean {
    const classification = classifySpawnFailure(err);
    const runtimeAbsent = isRuntimeAbsentStartFailure(classification.reason, classification.lookupReason);
    const configuration = NON_RETRYABLE_SPAWN_FAILURE_REASONS.includes(classification.reason)
      || RETRY_ONCE_SPAWN_FAILURE_REASONS.includes(classification.reason)
      || runtimeAbsent;
    if (!configuration && !crashStreakExhausted(attempts)) return false;
    this.lifecycleRecords.deleteRestartSnapshot(agentId);
    this.resetSpawnFailBackoff(agentId, "terminal");
    const dropped = this.startingInboxes.count(agentId);
    this.startingInboxes.cancelStart(agentId);
    logger.warn(`[Agent ${agentId}] Local restarts stopped after ${attempts} failed start(s) (${classification.reason}); ${dropped} buffered delivery(ies) left to the Server`);
    this.recordDaemonEvent("daemon.agent.spawn.local_restart_stopped", {
      agentId,
      launchId: cached.launchId || undefined,
      runtime: cached.config.runtime,
      source,
      failure_reason: classification.reason,
      stop_cause: configuration ? "configuration" : "attempts_exhausted",
      attempts,
      dropped_count: dropped,
    }, "error");
    this.reportStartFailure(agentId, cached.launchId, classification, cached.config.model);
    if (runtimeAbsent) {
      try {
        this.#onRuntimeAbsentLocalStop?.(cached.config.runtime);
      } catch (hookError) {
        logger.warn(`[Agent ${agentId}] Runtime re-detection after a missing runtime failed to schedule: ${hookError instanceof Error ? hookError.message : String(hookError)}`);
      }
    }
    return true;
  }

  private reportRunnerCredentialMintFailure(
    agentId: string,
    err: unknown,
    launchId: string | null,
    source: "idle_auto_restart" | "queued_continuation" | "runtime_profile_auto_restart",
  ): boolean {
    if (!(err instanceof RunnerCredentialMintError)) return false;
    const detail = runnerCredentialErrorDetail(err);
    this.recordDaemonEvent("daemon.runner_credential_mint.hard_fail", {
      agentId,
      launchId: launchId || undefined,
      source,
      http_status: detail.status,
      code: detail.code,
      reason: detail.message,
      retryable: detail.retryable,
    }, "error");
    const reason = err.message;
    this.sendAgentStatus(agentId, "inactive", launchId);
    this.broadcastActivity(
      agentId,
      "error",
      `Start failed: ${reason}`,
      [{ kind: "text", text: `Error: ${reason}` }],
      launchId,
      "runtime_error",
    );
    return true;
  }

  /** Send a batched notification to the agent via stdin about pending messages */
  private sendStdinNotification(agentId: string, options: { forceUnsupportedRetry?: boolean } = {}): boolean {
    const ap = this.agents.get(agentId);
    if (!ap) return false;

    const closedResult = this.busyDelivery.flushClosedNotificationDebt(agentId, ap);
    if (closedResult !== undefined) return closedResult;

    const count = ap.notifications.takePendingAndClearTimer();

    if (count === 0) return false;
    if (this.drain.holds(agentId)) {
      // Reconciler step 13: held; the end of the drain flushes the inbox.
      ap.notifications.add(count);
      this.recordDaemonEvent("daemon.agent.stdin_notification", {
        agentId,
        runtime: ap.config.runtime,
        launchId: ap.launchId || undefined,
        outcome: "suppressed_drain",
        pending_notification_count: count,
        inbox_count: ap.inbox.length,
      });
      return false;
    }
    const credentialInvalid = this.credentialInvalidHold(agentId, ap.config);
    if (credentialInvalid) {
      // Held for the invalid credential; its release flushes the inbox.
      ap.notifications.add(count);
      this.recordDaemonEvent("daemon.agent.stdin_notification", {
        agentId,
        runtime: ap.config.runtime,
        model: ap.config.model,
        launchId: ap.launchId || undefined,
        outcome: "suppressed_credential_invalid",
        pending_notification_count: count,
        inbox_count: ap.inbox.length,
        credential_invalid_reason: credentialInvalid.invalidReason,
      });
      return false;
    }
    const idleResult = this.busyDelivery.flushNotificationDebtIfIdle(agentId, ap, count);
    if (idleResult !== undefined) return idleResult;
    if (!ap.sessionId) {
      ap.notifications.add(count);
      return false;
    }
    if (!this.canDeliverToRuntimeSession(ap)) {
      ap.notifications.add(count);
      this.recordDaemonEvent("daemon.agent.stdin_notification", {
        agentId,
        runtime: ap.config.runtime,
        model: ap.config.model,
        launchId: ap.launchId || undefined,
        outcome: "suppressed_session_not_ready",
        mode: "busy",
        pending_notification_count: count,
        inbox_count: ap.inbox.length,
        session_id_present: true,
        session_ready_for_delivery: false,
      });
      return false;
    }
    const runtimeErrorBackoffRemainingMs = this.runtimeErrorDeliveryBackoffRemainingMs(ap);
    if (runtimeErrorBackoffRemainingMs > 0) {
      ap.notifications.add(count);
      const scheduled = this.scheduleRuntimeErrorDeliveryBackoffFlush(agentId, ap);
      this.recordDaemonEvent("daemon.agent.stdin_notification", {
        agentId,
        runtime: ap.config.runtime,
        model: ap.config.model,
        launchId: ap.launchId || undefined,
        outcome: "suppressed_runtime_error_backoff",
        mode: "busy",
        pending_notification_count: count,
        inbox_count: ap.inbox.length,
        session_id_present: true,
        runtime_error_backoff_remaining_ms: runtimeErrorBackoffRemainingMs,
        runtime_error_backoff_attempts: ap.runtimeErrorDeliveryBackoff.attempts,
        runtime_error_backoff_reason: ap.runtimeErrorDeliveryBackoff.reason || undefined,
        runtime_error_backoff_timer_scheduled: scheduled || this.runtimeErrorDeliveryBackoffTimerScheduled(ap),
      });
      return false;
    }
    if (this.compactionGateClosed(ap)) {
      this.recordRuntimeTraceEvent(agentId, ap, "runtime.compaction_boundary.delivery_suppressed", {
        pendingNotificationCount: count,
        pendingMessages: ap.inbox.length,
        busyDeliveryMode: ap.driver.busyDeliveryMode,
      });
      ap.notifications.add(count);
      logger.info(
        `[Agent ${agentId}] Suppressing stdin delivery until context compaction finishes; pending=${ap.inbox.length}`,
      );
      return false;
    }
    if (ap.gatedSteering.reviewing) {
      this.recordRuntimeTraceEvent(agentId, ap, "runtime.review_boundary.delivery_suppressed", {
        pendingNotificationCount: count,
        pendingMessages: ap.inbox.length,
        busyDeliveryMode: ap.driver.busyDeliveryMode,
      });
      ap.notifications.add(count);
      logger.info(
        `[Agent ${agentId}] Suppressing stdin delivery until review mode finishes; pending=${ap.inbox.length}`,
      );
      return false;
    }

    const inboxCount = ap.inbox.length;
    if (inboxCount === 0) return false;
    ap.notifications.pruneContributedToPending(ap.inbox, ap.sessionId);
    const changedMessageCandidates = ap.inbox.slice(Math.max(0, ap.inbox.length - count));
    const changedMessages = ap.notifications.filterUncontributedMessages(changedMessageCandidates, ap.sessionId);
    if (changedMessages.length === 0) {
      this.recordDaemonEvent("daemon.agent.stdin_notification", {
        agentId,
        runtime: ap.config.runtime,
        model: ap.config.model,
        launchId: ap.launchId || undefined,
        outcome: "suppressed_already_contributed",
        mode: "busy",
        pending_notification_count: count,
        inbox_count: ap.inbox.length,
        session_id_present: true,
      });
      logger.info(`[Agent ${agentId}] Suppressing stdin inbox notice because all candidate messages already contributed; pending=${ap.inbox.length}`);
      return false;
    }
    // Derived dedup-key (#58): if this exact unread-set was already written in
    // this session and not yet consumed, suppress instead of re-injecting (the
    // inbox-notice retry-storm class: a wedged/rate-limited runtime never
    // consumes, so the same changed set is re-projected every cycle). The
    // already-contributed filter above gives each pending message at-most-once
    // contribution across ordinary retries, progress flushes, and cooldown
    // flushes; the pending total still comes from ap.inbox. The debt was already
    // taken by takePendingAndClearTimer above, so a true duplicate needs no
    // re-queue. Empty fingerprint never dedups (fail toward sending).
    const noticeFingerprint = computeInboxNoticeFingerprint(changedMessages);
    if (ap.notifications.isDuplicateNotice(noticeFingerprint, ap.sessionId)) {
      this.recordDaemonEvent("daemon.agent.stdin_notification", {
        agentId,
        runtime: ap.config.runtime,
        model: ap.config.model,
        launchId: ap.launchId || undefined,
        outcome: "suppressed_duplicate",
        mode: "busy",
        pending_notification_count: count,
        inbox_count: ap.inbox.length,
        session_id_present: true,
      });
      logger.info(`[Agent ${agentId}] Suppressing duplicate stdin inbox notice (unread-set unchanged since last write); pending=${ap.inbox.length}`);
      return false;
    }
    if (!options.forceUnsupportedRetry && ap.notifications.isDuplicateEncodeFailedNotice(noticeFingerprint, ap.sessionId)) {
      ap.notifications.add(count);
      this.recordDaemonEvent("daemon.agent.stdin_notification", {
        agentId,
        runtime: ap.config.runtime,
        model: ap.config.model,
        launchId: ap.launchId || undefined,
        outcome: "suppressed_duplicate_encode_failed",
        mode: "busy",
        pending_notification_count: count,
        inbox_count: ap.inbox.length,
        session_id_present: true,
      });
      logger.info(`[Agent ${agentId}] Suppressing duplicate unsupported stdin inbox notice (unread-set unchanged since last encode failure); pending=${ap.inbox.length}`);
      return false;
    }
    const inboxRows = projectAgentInboxSnapshot(changedMessages);
    const notification = formatInboxUpdateRuntimeInput(changedMessages, ap.driver, inboxCount, inboxUpdateRenderOptions(ap.config));
    const notificationByteCount = Buffer.byteLength(notification, "utf8");
    const projectionAttrs = inboxProjectionTraceAttrs(inboxRows, inboxCount);
    this.recordDaemonEvent("daemon.agent.inbox_projection.delta", {
      agentId,
      source: "busy_stdin_notification",
      ...projectionAttrs,
    });
    logger.info(`[Agent ${agentId}] Sending stdin inbox update: ${inboxRows.length} changed target(s), ${inboxCount} pending message(s)`);

    const sendResult = this.sendRuntimeInput(
      agentId,
      ap,
      { mode: "busy", text: notification, sessionId: ap.sessionId },
      "busy_stdin_notification",
    );
    if (sendResult.ok) {
      this.recordWholeNoticePreviewsSeen(agentId, changedMessages);
      this.recordDaemonEvent("daemon.agent.inbox_update.pushed", {
        agentId,
        runtime: ap.config.runtime,
        model: ap.config.model,
        launchId: ap.launchId || undefined,
        mode: "busy",
        source: "busy_stdin_notification",
        notification_byte_count: notificationByteCount,
        ...projectionAttrs,
      });
      this.recordDaemonEvent("daemon.agent.stdin_notification", {
        agentId,
        runtime: ap.config.runtime,
        model: ap.config.model,
        launchId: ap.launchId || undefined,
        outcome: "written",
        mode: "busy",
        pending_notification_count: count,
        inbox_count: inboxCount,
        inbox_target_count: inboxRows.length,
        session_id_present: true,
      });
      this.recordAttentionHintsShown(agentId, inboxRows, "busy_stdin_notification");
      // Register the written unread-set ONLY after a successful stdin write, so
      // a failed write leaves the prior memo intact and the retry resends the
      // same set without registering a fresh notify (Cody#1). Scoped to the
      // current session (Cody#2) — see RuntimeNotificationState.
      ap.notifications.recordNoticeWritten(noticeFingerprint, ap.sessionId, changedMessages);
      this.observeDeliveryWrite(agentId, ap, changedMessages.at(-1)?.message_id ?? null, "busy_stdin_notification", !this.isApmIdle(ap));
      return true;
    } else {
      ap.notifications.add(count);
      const retryScheduled = ap.runtime.descriptor.busyDelivery === "direct" && sendResult.reason !== "unsupported"
        ? this.scheduleStdinNotification(agentId, ap, this.stdinNotificationRetryMs)
        : false;
      const outcome = runtimeSendFailureOutcome(sendResult);
      if (outcome === "encode_failed") {
        ap.notifications.recordNoticeEncodeFailed(noticeFingerprint, ap.sessionId);
      }
      this.recordDaemonEvent("daemon.agent.stdin_notification", {
        agentId,
        runtime: ap.config.runtime,
        model: ap.config.model,
        launchId: ap.launchId || undefined,
        outcome,
        mode: "busy",
        failure_reason: sendResult.reason,
        failure_error: sendResult.error,
        pending_notification_count: count,
        retry_scheduled: retryScheduled,
        notification_timer_present: ap.notifications.hasTimer,
        inbox_count: inboxCount,
        inbox_target_count: inboxRows.length,
        session_id_present: true,
      }, "error");
      return false;
    }
  }

  /**
   * One event per written delivery, under its own delivery id. The batch event
   * names only the first message's id, so a delivery queued earlier (e.g.
   * `queued_busy_mention`) could not be joined to the write that finally
   * carried it to the runtime.
   */
  private recordDeliveriesWritten(agentId: string, ap: AgentProcess, messages: readonly AgentMessage[], writeKind: "inbox_update" | "messages"): void {
    for (const message of messages) {
      const deliveryId = this.getDeliveryTraceContext(message).deliveryId;
      if (!deliveryId) continue;
      this.recordDaemonEvent("daemon.agent.delivery.written", {
        agentId,
        launchId: ap.launchId || undefined,
        deliveryId,
        delivery_correlation_id: deliveryId,
        messageId: message.message_id,
        delivery_write_kind: writeKind,
        batch_count: messages.length,
      });
    }
  }

  private recordInboxUpdateProjection(
    agentId: string,
    ap: AgentProcess,
    messages: readonly AgentMessage[],
    source: string,
    mode: "wake" | "idle" | "busy",
    renderedInput: string,
    totalPendingMessages = messages.length,
  ): Record<string, unknown> {
    const rows = projectAgentInboxSnapshot(messages);
    const projectionAttrs = inboxProjectionTraceAttrs(rows, totalPendingMessages);
    this.recordDaemonEvent("daemon.agent.inbox_projection.delta", {
      agentId,
      source,
      ...projectionAttrs,
    });
    this.recordDaemonEvent("daemon.agent.inbox_update.pushed", {
      agentId,
      runtime: ap.config.runtime,
      model: ap.config.model,
      launchId: ap.launchId || undefined,
      mode,
      source,
      notification_byte_count: Buffer.byteLength(renderedInput, "utf8"),
      cursors_advanced: "none",
      ...projectionAttrs,
    });
    return projectionAttrs;
  }

  /**
   * Sender descriptions already shown in this model context are dropped from
   * live stdin delivery (passive resource "sender", policy "once"); see
   * senderLedger.ts. Call `settle` with the stdin write result. Startup
   * prompts are not elided: a spawn is a new context anyway.
   */
  private elideSeenSenders(agentId: string, ap: AgentProcess, messages: AgentMessage[]): SenderElisionResult {
    if (messages.length === 0 || !ap.passiveAx || ap.driver.session.compaction !== "reported") return NO_SENDER_ELISION(messages);
    const record = readContextGeneration(ap.cliTransportDir);
    if (!record || record.passiveAx !== true || !record.compactionReported) return NO_SENDER_ELISION(messages);
    const dbPath = senderLedgerPath(this.slockHome, agentId);
    const ledger = dbPath ? openSenderLedger(dbPath, record.contextId) : undefined;
    if (!ledger) return NO_SENDER_ELISION(messages);
    try {
      const { messages: elided, claimed } = elideSeenSendersInMessages(messages, ledger.claim);
      return {
        messages: elided,
        settle: (delivered) => {
          if (!delivered) ledger.release(claimed);
          ledger.close();
        },
      };
    } catch {
      ledger.close();
      return NO_SENDER_ELISION(messages);
    }
  }

  private deliverInboxUpdateViaStdin(
    agentId: string,
    ap: AgentProcess,
    messages: AgentMessage[],
    mode: "idle" | "busy",
    source: string,
  ): boolean {
    if (messages.length === 0) return true;
    const runtimeProjection = this.projectThreadJoinContextsForRuntimeInput(agentId, messages);
    const renderedContextMessageSet = new Set(runtimeProjection.renderedContextMessages);
    const pendingNoticeMessages = messages.filter((message) => !renderedContextMessageSet.has(message));
    const rows = projectAgentInboxSnapshot(messages);
    const senderElision = this.elideSeenSenders(agentId, ap, runtimeProjection.renderedContextMessages);
    const prompt = runtimeProjection.renderedContextMessages.length > 0
      ? formatConcreteMessagesRuntimeInput(
        senderElision.messages,
        ap.driver,
        pendingNoticeMessages.length > 0
          ? formatInboxUpdateRuntimeInput(pendingNoticeMessages, ap.driver, ap.inbox.length, inboxUpdateRenderOptions(ap.config))
          : undefined,
      )
      : formatInboxUpdateRuntimeInput(messages, ap.driver, ap.inbox.length, inboxUpdateRenderOptions(ap.config));
    const projectionAttrs = this.recordInboxUpdateProjection(agentId, ap, messages, source, mode, prompt, ap.inbox.length);
    const inputTraceAttrs = buildRuntimeInputTraceAttrs({
      source,
      prompt,
      messages: runtimeProjection.messages,
      sessionIdPresent: Boolean(ap.sessionId),
      nativeStandingPrompt: Boolean(ap.driver.supportsNativeStandingPrompt),
    });
    this.recordRuntimeTraceEvent(agentId, ap, "runtime.input.prepared", inputTraceAttrs);

    const sendResult = this.sendRuntimeInput(
      agentId,
      ap,
      {
        mode,
        text: prompt,
        sessionId: ap.sessionId,
        // task #21: an idle delivery whose envelopes are a single concrete message starts a turn
        // answering it, even though `prompt` is usually a content-free inbox notice. A busy steer
        // never names an origin (the session would ignore it anyway). App-inbox notices, transient
        // system notices and runtime-profile control are sent elsewhere and carry none.
        origin: mode === "idle" ? deriveForegroundTurnOrigin(messages) : null,
      },
      source,
    );
    senderElision.settle(sendResult.ok);
    if (!sendResult.ok) {
      const retryNotificationCount = mode === "idle" && ap.driver.supportsStdinNotification && ap.sessionId
        ? messages.length
        : 0;
      const retrySource = source.endsWith("_retry") ? source : `${source}_retry`;
      const retryScheduled = mode === "idle"
        ? this.scheduleIdleInboxDeliveryRetry(
          agentId,
          ap,
          retryNotificationCount,
          retrySource,
          "daemon.agent.stdin_delivery.idle_retry",
        )
        : false;
      if (mode === "idle") {
        this.commitApmIdleState(agentId, ap, true);
      }
      logger.warn(
        `[Agent ${agentId}] Failed to deliver ${mode} inbox update; ${messages.length === 1 ? "message remains" : "messages remain"} pending`,
      );
      this.recordDaemonEvent("daemon.agent.stdin_delivery", {
        agentId,
        launchId: ap.launchId || undefined,
        runtime: ap.config.runtime,
        model: ap.config.model,
        mode,
        messages_count: messages.length,
        session_id_present: Boolean(ap.sessionId),
        inbox_count: ap.inbox.length,
        pending_notification_count: ap.notifications.pendingCount,
        busy_delivery_mode: ap.driver.busyDeliveryMode,
        supports_stdin_notification: ap.driver.supportsStdinNotification,
        ...this.messagesTraceAttrs(messages),
        ...inputTraceAttrs,
        ...projectionAttrs,
        outcome: runtimeSendFailureOutcome(sendResult),
        failure_reason: sendResult.reason,
        failure_error: sendResult.error,
        requeued_messages_count: retryNotificationCount,
        retry_scheduled: retryScheduled,
        notification_timer_present: ap.notifications.hasTimer,
        cursors_advanced: "none",
      }, "error");
      return false;
    }

    // An idle write starts a new turn; stall age counts from here, not from the
    // previous turn's last runtime event.
    if (mode === "idle") {
      ap.runtimeProgress.noteTurnStarted();
      this.armStallDeadlineForQueuedWork(agentId, ap);
    }
    if (this.containsOrdinaryInboxMessage(messages)) this.broadcastMessageReceivedActivity(agentId, mode === "idle" ? messages : undefined);
    const senders = [...new Set(messages.map((message) => `@${message.sender_name}`))].join(", ");
    logger.info(
      `[Agent ${agentId}] Delivering ${mode} inbox update for ${messages.length === 1 ? "message" : `${messages.length} messages`} from ${senders}`,
    );
    if (this.containsOrdinaryInboxMessage(messages)) {
      ap.lastRuntimeError = null;
    }
    if (runtimeProjection.renderedContextMessages.length > 0) {
      this.notePushedModelBodies(ap, runtimeProjection.renderedContextMessages);
      this.recordRenderedThreadJoinContextReceipts(agentId, runtimeProjection.renderedContextMessages);
      this.consumeVisibleMessages(agentId, {
        messages: runtimeProjection.renderedContextMessages,
        source: "stdin_thread_context_delivery",
      });
    }
    this.recordWholeNoticePreviewsSeen(
      agentId,
      runtimeProjection.renderedContextMessages.length > 0 ? pendingNoticeMessages : messages,
    );
    this.recordDaemonEvent("daemon.agent.stdin_delivery", {
      agentId,
      launchId: ap.launchId || undefined,
      runtime: ap.config.runtime,
      model: ap.config.model,
      mode,
      messages_count: messages.length,
      session_id_present: Boolean(ap.sessionId),
      inbox_count: ap.inbox.length,
      pending_notification_count: ap.notifications.pendingCount,
      busy_delivery_mode: ap.driver.busyDeliveryMode,
      supports_stdin_notification: ap.driver.supportsStdinNotification,
      ...this.messagesTraceAttrs(runtimeProjection.messages),
      ...inputTraceAttrs,
      ...projectionAttrs,
      outcome: "written", accepted_as: sendResult.acceptedAs,
      stdin_write_attempted: true,
      rendered_thread_context_count: runtimeProjection.renderedContextMessages.length,
      rendered_thread_context_truncated_count: runtimeProjection.renderedContextMessages
        .filter((message) => message.thread_join_context?.history_truncated).length,
      cursors_advanced: "none",
    });
    this.recordAttentionHintsShown(agentId, rows, source);
    if (pendingNoticeMessages.length > 0) {
      ap.notifications.recordNoticeWritten(
        computeInboxNoticeFingerprint(pendingNoticeMessages),
        ap.sessionId,
        pendingNoticeMessages,
      );
    }
    this.observeDeliveryWrite(
      agentId,
      ap,
      messages.at(-1)?.message_id ?? null,
      mode === "idle" ? "stdin_idle_delivery" : "stdin_turn_end_delivery",
      mode === "busy",
    );
    this.recordDeliveriesWritten(agentId, ap, messages, "inbox_update");
    if (mode === "idle") this.watchTurnStart(agentId, ap, source);
    // Phase-6: first successful post-ready delivery closes the activation wait.
    this.closeActivationTransition(ap, "advanced", "stdin");
    return true;
  }

  /** Deliver a message to an agent via stdin, formatting it the same way as the MCP bridge */
  private deliverMessagesViaStdin(
    agentId: string,
    ap: AgentProcess,
    messages: AgentMessage[],
    mode: "idle" | "busy",
    options: { transient?: boolean } = {},
  ): boolean {
    if (messages.length === 0) return true;
    const runtimeProfileMigrationMessages = messages.filter((message) => runtimeProfileNotificationFromMessage(message)?.kind === "migration");
    if (runtimeProfileMigrationMessages.length > 0) {
      for (const message of runtimeProfileMigrationMessages) {
        const notification = runtimeProfileNotificationFromMessage(message);
        if (notification?.kind === "migration") {
          this.completeDeprecatedRuntimeProfileMigration(agentId, notification.key, ap.launchId, message.traceparent, "runtime_profile_message");
        }
      }
      messages = messages.filter((message) => runtimeProfileNotificationFromMessage(message)?.kind !== "migration");
      this.recordDaemonEvent("daemon.agent.runtime_profile.deprecated_migration_filtered", {
        agentId,
        launchId: ap.launchId || undefined,
        runtime: ap.config.runtime,
        mode,
        filtered_messages_count: runtimeProfileMigrationMessages.length,
        remaining_messages_count: messages.length,
      });
      if (messages.length === 0) {
        if (mode === "idle") {
          this.commitApmIdleState(agentId, ap, true);
        }
        return true;
      }
    }
    const runtimeProjection = this.projectThreadJoinContextsForRuntimeInput(
      agentId,
      messages,
      options.transient !== true,
    );
    const traceAttrs = {
      agentId,
      launchId: ap.launchId || undefined,
      runtime: ap.config.runtime,
      model: ap.config.model,
      mode,
      messages_count: messages.length,
      session_id_present: Boolean(ap.sessionId),
      inbox_count: ap.inbox.length,
      pending_notification_count: ap.notifications.pendingCount,
      busy_delivery_mode: ap.driver.busyDeliveryMode,
      supports_stdin_notification: ap.driver.supportsStdinNotification,
      transient_delivery: options.transient === true,
      ...this.messagesTraceAttrs(runtimeProjection.messages),
    };

    const traceSource = options.transient ? `stdin_${mode}_transient_delivery` : `stdin_${mode}_delivery`;
    const controlPrompt = formatRuntimeProfileControlPrompt(runtimeProjection.messages);
    // A control prompt renders no message lines, so it claims no senders.
    const senderElision = controlPrompt ? NO_SENDER_ELISION(runtimeProjection.messages) : this.elideSeenSenders(agentId, ap, runtimeProjection.messages);
    const prompt = controlPrompt ?? formatConcreteMessagesRuntimeInput(senderElision.messages, ap.driver);
    const inputTraceAttrs = buildRuntimeInputTraceAttrs({
      source: traceSource,
      prompt,
      messages: runtimeProjection.messages,
      sessionIdPresent: Boolean(ap.sessionId),
      nativeStandingPrompt: Boolean(ap.driver.supportsNativeStandingPrompt),
    });
    this.recordRuntimeTraceEvent(agentId, ap, "runtime.input.prepared", inputTraceAttrs);

    const sendResult = this.sendRuntimeInput(
      agentId,
      ap,
      { mode, text: prompt, sessionId: ap.sessionId },
      traceSource,
    );
    senderElision.settle(sendResult.ok);
    if (!sendResult.ok) {
      // Preserve queued work if the runtime cannot encode the live delivery yet.
      // This is especially important for protocol-steering runtimes where the
      // active turn id may disappear during a narrow state-transition window.
      if (!options.transient) {
        ap.inbox.unshift(...messages);
      }
      if (mode === "idle") {
        this.commitApmIdleState(agentId, ap, true);
      }
      logger.warn(
        `[Agent ${agentId}] Failed to deliver ${mode} stdin input; re-queued ${messages.length === 1 ? "message" : `${messages.length} messages`}`,
      );
      this.recordDaemonEvent("daemon.agent.stdin_delivery", {
        ...traceAttrs,
        ...inputTraceAttrs,
        outcome: runtimeSendFailureOutcome(sendResult),
        failure_reason: sendResult.reason,
        failure_error: sendResult.error,
        requeued_messages_count: options.transient ? 0 : messages.length,
      }, "error");
      return false;
    }

    if (mode === "idle") {
      ap.runtimeProgress.noteTurnStarted();
      this.armStallDeadlineForQueuedWork(agentId, ap);
    }
    if (this.containsOrdinaryInboxMessage(messages)) this.broadcastMessageReceivedActivity(agentId, mode === "idle" ? messages : undefined);
    if (!options.transient) {
      this.notePushedModelBodies(ap, [...messages, ...runtimeProjection.renderedContextMessages]);
      this.recordRenderedThreadJoinContextReceipts(agentId, runtimeProjection.renderedContextMessages);
      this.consumeVisibleMessages(agentId, { messages, source: traceSource });
    }
    const senders = [...new Set(messages.map((message) => `@${message.sender_name}`))].join(", ");
    logger.info(
      `[Agent ${agentId}] Delivering ${mode} ${messages.length === 1 ? "message" : `${messages.length} messages`} via stdin from ${senders}`,
    );
    if (this.containsOrdinaryInboxMessage(messages)) {
      ap.lastRuntimeError = null;
    }
    this.ackInjectedRuntimeProfileMessages(agentId, messages, ap.launchId);
    this.recordDaemonEvent("daemon.agent.stdin_delivery", {
      ...traceAttrs,
      ...inputTraceAttrs,
      outcome: "written", accepted_as: sendResult.acceptedAs,
      stdin_write_attempted: true,
      rendered_thread_context_count: runtimeProjection.renderedContextMessages.length,
      rendered_thread_context_truncated_count: runtimeProjection.renderedContextMessages
        .filter((message) => message.thread_join_context?.history_truncated).length,
    });
    this.recordDeliveriesWritten(agentId, ap, messages, "messages");
    if (mode === "idle") this.watchTurnStart(agentId, ap, traceSource);
    // Phase-6: first successful post-ready delivery closes the activation wait.
    this.closeActivationTransition(ap, "advanced", "stdin");
    return true;
  }
}

/**
 * #oar-raft:#10: the Activity Log row when the legacy host (the Cursor CLI)
 * leaves a Cursor SDK session for a new session, with the likely reason.
 * (Agent env vars no longer keep Cursor off the SDK: OAR 0.101's child takes them.)
 */
export const CURSOR_CLI_MIGRATION_TEXT = "This agent runs on the Cursor CLI again because Cursor through the Cursor SDK is off or not available for it on this Computer. The Cursor CLI can't continue sessions from the Cursor SDK, so it started a new Cursor session. Its memory and Raft history are unchanged.";

/**
 * #runtime-watch:#1: `wake_recycle_warm` changes what a Pi turn costs, so it is
 * on every Pi and Built-in turn span and request bytes and tokens split by it.
 * It is read live at each turn end, so it comes from `config`.
 */
function piTurnFlagTraceAttrs(config: AgentConfig): Record<string, boolean> {
  if (config.runtime !== "pi" && config.runtime !== "builtin") return {};
  return { wake_recycle_warm: config.wakeRecycleWarm === true };
}
