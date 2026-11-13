export { verifyBundledPiOAuth } from "./bundledPiOAuth";
export { verifyBundledKimiSdk } from "./drivers/index";
export { verifyBundledOarHost } from "./oarLoader";
import { applyDaemonConnectAttemptTimeout } from "./connectAttemptTimeout";
import {
  observeRuntimeCliVersions,
  readRuntimeCliVersionState,
  runtimeCliVersionDrift,
  writeRuntimeCliVersionState,
} from "./runtimeCliVersionTracker";
import path from "node:path";
import { resolveWorkspaceDirectoryPath } from "./workspaces";
import { readVolumeCapacity } from "./volumeCapacity";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { accessSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import {
  type FeedbackTranscriptSessionLookup,
  runtimeSessionHomeEnvVars,
  createTraceScopeTracer,
  COMPUTER_CAPABILITY_SERVICE_IPC_UNREACHABLE,
  COMPUTER_CAPABILITY_SUPERVISOR_MUTATIONS,
  clampComputerUpgradeDrain,
  DAEMON_CAPABILITY_COMPUTER_UPGRADE_DRAIN_V1,
  type ComputerUpgradeDrainRequest,
  currentDate,
  currentTimeMs,
  errorClassOf,
  formatTraceparent,
  getStaticRuntimeModelSourceSet,
  noopTracer,
  parseTraceparent,
  RUNTIMES,
  type ActiveSpan,
  type AgentConfig,
  type ComputerLastUpgradeReceipt,
  type ComputerInstallerRepairHint,
  type ComputerMigratedFrom,
  isComputerMigratedFrom,
  type LegacyCredentialExposureReport,
  type ComputerLifecycleExecutionAck,
  type AgentMigrationTransportLeaseMessage,
  type AgentMigrationTransportReady,
  type MachineToServerMessage,
  type MentionDeliveryTerminalErrorCode,
  type MachineShutdownReason,
  type RuntimeModelSourceOutcome,
  type RuntimeAccountUsageProvider,
  type RuntimeAccountUsageSnapshot,
  type ServerToMachineMessage,
  type TraceContext,
  type TraceScope,
  type TraceSpanAttrContracts,
  type TraceStatus,
  type Tracer,
  DAEMON_CAPABILITY_SEQUENCED_STATUS,
  DAEMON_CAPABILITY_INTERRUPT_SUBAGENT,
  DAEMON_CAPABILITY_INTERRUPT_TURN,
  DAEMON_CAPABILITY_RUNTIME_AUTH,
  DAEMON_CAPABILITY_RUNTIME_AUTH_V2,
  DAEMON_CAPABILITY_RUNTIME_AUTH_QWEN_PROVIDER,
  DAEMON_CAPABILITY_RUNTIME_AUTH_ANTIGRAVITY,
  DAEMON_CAPABILITY_RUNTIME_AUTH_ANTIGRAVITY_LOGOUT,
  DAEMON_CAPABILITY_RUNTIME_AUTH_PI,
  DAEMON_CAPABILITY_RUNTIME_AUTH_GROK,
  DAEMON_CAPABILITY_RUNTIME_AUTH_OPENCODE,
  DAEMON_CAPABILITY_RUNTIME_AUTH_CODEBUDDY,
  DAEMON_CAPABILITY_RUNTIME_LIMIT_RESET,
  DAEMON_CAPABILITY_RUNTIME_ACCOUNT_USAGE_ANTIGRAVITY,
  DAEMON_CAPABILITY_RUNTIME_LIMIT_RESET_CLAUDE_KINDS,
  DAEMON_CAPABILITY_STARTUP_READINESS,
  SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_LIMIT_RESETS_V1,
  SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_WINDOW_SCOPE_V1,
  SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_WINDOW_SCOPE_V2,
  isRuntimeAccountUsageProvider,
  isRuntimeLimitResetIdempotencyKey,
  isRuntimeLimitResetKind,
  type RuntimeLimitResetIdempotencyKey,
  type RuntimeLimitResetKind,
  type RuntimeLimitResetsReadResult,
  withoutLimitResets,
  withoutModelsScopes,
  withoutWindowScopes,
  claudeFiveHourLimitOf,
  type RuntimeLimitResetResult,
  type RuntimeAuthRuntime,
  asRuntimeAuthLoginId,
  isRuntimeAuthPastedCode,
  isRuntimeAuthRuntime,
  parseRuntimeAuthProviderConnectInput,
  runtimeAuthLoginRegionFits,
  runtimeAuthOAuthMethodFits,
  runtimeAuthProviderIdFits,
  runtimeAuthSupports,
  isValidMachineDiskStatus,
  DAEMON_CAPABILITY_RUNTIME_OUTCOME_V1,
  DAEMON_CAPABILITY_TASK_CREATE_FRESHNESS,
  DAEMON_CAPABILITY_RUNTIME_HOST_OAR,
  DAEMON_CAPABILITY_RUNTIME_HOST_OAR_CODEX,
  DAEMON_CAPABILITY_RUNTIME_HOST_OAR_CURSOR,
  DAEMON_CAPABILITY_RUNTIME_HOST_OAR_GROK,
  DAEMON_CAPABILITY_AGENT_CONTEXT_VIEW_V0,
  DAEMON_CAPABILITY_AGENT_CONTEXT_SEARCH_V0,
  DAEMON_CAPABILITY_AGENT_CONTEXT_VIEW_CODEX_ROOT_V1,
  DAEMON_CAPABILITY_RUNNER_CREDENTIAL_RECONCILE_V1,
  DAEMON_CAPABILITY_AGENT_CONFIG_PUSH,
  DAEMON_CAPABILITY_CONTROL_START_CATCHUP_V1,
  DAEMON_CAPABILITY_MODEL_LIMITS_REPORT_V1,
  SERVER_CAPABILITY_RUNTIME_OUTCOME_ACK_V1,
  SERVER_CAPABILITY_AGENT_SEND_INTENT_V1,
  SERVER_CAPABILITY_TURN_ENDED_V1,
  SERVER_CAPABILITY_STICKY_FAILURE_REASONS_V1,
  SERVER_CAPABILITY_RUNTIME_CREDENTIALS_CHANGED_V1,
  SERVER_CAPABILITY_RUNTIME_READINESS_V1,
  runtimeAuthRuntimeFor,
  SERVER_CAPABILITY_TASK_WRITE_LANDING_V1,
  SERVER_CAPABILITY_IDLE_TASK_REMINDER_V1,
  SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1,
  type RuntimeDetectionReport,
  SERVER_CAPABILITY_START_SPAWN_ERROR_V1,
  SERVER_CAPABILITY_SERVER_FEATURES_V1,
  SERVER_CAPABILITY_MIGRATION_BACKUP_IGNORE_SOURCES_V1,
  SERVER_CAPABILITY_MIGRATION_USER_IGNORE_RECEIPT_V1,
  SERVER_CAPABILITY_MIGRATION_SOURCE_DRAIN_PROGRESS_V1,
  type AgentMigrationSourceDrainWaitingFor,
  MIGRATION_USER_IGNORE_WRITE_FAILED,
  type AgentMigrationUserIgnoreAdditionsReceipt,
  type AgentStartNotSpawnedReason,
} from "@botiverse/raft-shared";
import {
  RUNTIME_OUTCOME_OUTBOX_DIR_NAME,
  RUNTIME_OUTCOME_STORAGE_BLOCKED_TEXT,
  RuntimeOutcomeOutbox,
  AUTOMATIC_START_REFUSAL_TEXT,
  isOutboxFrame,
  type OutboxFs,
  type OutboxStartAdmission,
  type RecoveryGrant,
} from "./runtimeOutcomeOutbox";
import {
  APP_CONFIG_TRACE_IDENTITY_KEYS,
  APP_SNAPSHOT_TRACE_IDENTITY_KEYS,
  APP_SOURCE_TRACE_IDENTITY_KEYS,
} from "@botiverse/raft-shared/src/appRuntimeTrace";
import { setAgentProcJobManager, setAgentProxyServerChecksTaskWriteLanding } from "./agentCredentialProxy";
import { ProcJobManager, procStopReasonForAgentStop, type ProcStopReason } from "./procJobs";
import { AgentProcessManager, classifySpawnFailure, StaleDispatchError, type RuntimeProcessGate } from "./agentProcessManager";
import { AgentEnvVarsNotAllowedError, OarOnlyStartError } from "./spawnFailureErrors";
import { AgentConfigRevisions } from "./agentConfigRevisions";
import { AgentHostRouter, runtimeLabel } from "./agentHost/agentHostRouter";
import { ComputerUpgradeDrainChannel, type ComputerUpgradeDrainPaths } from "./computerUpgradeDrain";
import { clampAgentDrainDeadlineMs, type AgentDrainSummary } from "./agentDrain";
import type { AgentNotIdleReason } from "./agentIdle";
import type { AgentLifecycleHost } from "./agentHost/agentLifecycleHost";
import { isOarHostEnabled, OAR_HOST_DISABLED_ENV, OarAgentHost, type OpenOarSession } from "./agentHost/oarAgentHost";
import { ExitStreaks } from "./planExit";
import { getDriver, resolveKimiHome, runtimeIdsShippedWithComputer } from "./drivers/index";
import type { RuntimeProbeUnavailableReason } from "./drivers/types";
import { readCommandVersion, resolveCommandOnPath } from "./drivers/probe";
import {
  DaemonConnection,
  systemClock,
  type ConnectionOptions,
  type Clock,
} from "./connection";
import { createAgentAppInboxStore, type AgentAppInboxStore } from "./agentAppInbox";
import { isServerContextMessage } from "./agentRuntimeInput";
import {
  createScopedAppStorageFactory,
  type ScopedAppStorageFactory,
} from "./scopedAppStorage";
import {
  createScopedAppStorageObserver,
  type ScopedAppStorageObserver,
} from "./scopedAppStorageObservability";
import {
  BUILT_IN_READY_CAPABILITIES,
  createBuiltInLocalScheduleRuntime,
} from "./registry.manifest";
import { runRuntimeDetectionRound, type RuntimeDetectionRoundHandle, type RuntimeDetectionRoundOptions, type RuntimeDetectionRoundResult } from "./runtimeDetectionRound";
import { logger } from "./logger";
import { runFeedbackTranscriptRequest } from "./feedbackTranscriptOutcomeUpload";
import { feedbackTranscriptCollectorErrorResult } from "./feedbackTranscriptCollector";
import {
  acquireDaemonMachineLock,
  resolveDefaultMachineStateRoot,
  type DaemonMachineOwnerProvenance,
  type DaemonMachineLockHandle,
} from "./machineLock";
import {
  LocalRotatingTraceSink,
  computeTraceJitter,
  createTraceClient,
  getActiveTraceContext,
  NO_JITTER,
  runWithActiveSpan,
  type TraceJitter,
} from "@botiverse/raft-trace-client";
import { DaemonTraceBundleUploader } from "./traceBundleUpload";
import { acceptServerTraceUploadUrl, resolveMachineTraceUploadUrl, resolveTraceUploadUrl, type ServerTraceUploadUrlRejection } from "./traceUploadUrl";
import { ProbeGate } from "./probeGate";
import { ServerFeaturesRefresh, type ServerFeaturesRefreshOptions } from "./serverFeaturesRefresh";
import { cursorSdkAvailable, loadOarOpencodeProviderAuth, loadOarPiProviderAuth, loadOarQwenProviderAuth, loadOarRuntime } from "./oarLoader";
import { OPENCODE_LOGIN_TIMEOUT_MS, OPENCODE_SIGN_IN_IDLE_MS, OPENCODE_SIGN_IN_TIMEOUT_MS, OpencodeSignIn } from "./runtimeAuth/opencodeProviderSignIn";
import { piSignInDeviceId, piSignInPaths } from "./runtimeAuth/piSignInStore";
import { RuntimeAuthHost, runtimeAuthRuntimesReadBy } from "./runtimeAuth/runtimeAuthHost";
import { loadKimiSdkAuth, readKimiCodeSignInStatus } from "./runtimeAuth/kimiSdkAuth";
import { readKimiSdkUsage } from "./runtimeAccountUsage/kimiSdkUsage";
import { RuntimeModelSourceCache, type RuntimeModelCacheRead } from "./runtimeModels/modelSourceCache";
import { RAFT_HOME_ENV, SLOCK_HOME_ENV, listLegacyRaftStatePaths, resolveRaftHome, resolveRaftHomePath } from "./raftHome";
import { regenerateExistingOpencliWrappers, removeStaleAgentTokenFiles } from "./drivers/cliTransport";
import { migrateAllLegacyBridgeArtifacts } from "./legacyBridgeArtifacts";
import { isLegacyMachineKey, legacyCredentialExposureForReady, recordLegacyCredentialExposure } from "./legacyCredentialExposure";
import { daemonFetch } from "./daemonFetch";
import {
  buildProviderProbeResultMessage,
  buildUnclaimedProviderProbeResult,
  claimProbeMaterialization,
  runProviderProbeCanary,
  type ProbeMaterialization,
} from "./providerProbe";
import { isProviderProbeRuntime } from "@botiverse/raft-shared";
import { VERSION as PI_SDK_VERSION } from "@earendil-works/pi-coding-agent";
import { asProviderProbeId } from "@botiverse/raft-shared";
import { assertLegacyDaemonKeyNotAdoptedByComputer } from "./computerMigrationGuard";
import { PROCESS_MEMORY_TRACE_ATTRS, serviceMemoryAttrs, startProcessMemoryReporter } from "./processMemory";
import { readMachineMemoryStatus } from "./machineMemory";
import { piSessionMemoryAttrs } from "./drivers/piSessionMemory";
import { buildRuntimeModelSourceResultMessage } from "./runtimeModelSourceProjection";
import {
  archiveCompletedAgentMigrationSourceWorkspace,
  quarantinePreexistingAgentWorkspace,
  type AgentMigrationWorkspaceArchiveOutcome,
} from "./agentMigrationWorkspaceArchive";
import {
  createRaftDiskWalkBudget,
  measureRaftDiskFootprint,
  removeMigrationGenerationBulk,
  runRaftDiskJanitor,
  scheduleRaftDiskJanitor,
  type RaftDiskFootprint,
} from "./raftDiskJanitor";
import type { AgentMigrationExportProgress } from "./agentMigrationExport";
import { AgentMigrationUserIgnoreWriteError, writeAgentMigrationUserIgnoreAdditions } from "./agentMigrationUserIgnore";
import {
  AgentMigrationChunkDigestMismatchError,
  classifyAgentMigrationTargetResidue,
  commitMarkerMatches,
  readCommitMarker,
  migrationStatePathSegment,
  missingAgentMigrationChunks,
  stageAndCommitAgentMigrationResumableBundle,
  streamAgentMigrationResumableBundle,
  validateAgentMigrationControlManifest,
  verifyAndStoreAgentMigrationChunk,
  type AgentMigrationControlChunk,
  type AgentMigrationControlManifest,
  type AgentMigrationPlacementStep,
} from "./agentMigrationResumableBundle";

export * from "./legacySupervisor";
import { hostOsVariant } from "./osVariant";
import { hostFacts, knownHostFacts } from "./hostFacts";
import { daemonInstallFacts } from "./daemonInstallFacts";
import { hostIdHash } from "./hostIdentity";
import { readSecretFileSync } from "./secretFile";
import { RecentDeliveryIds } from "./recentDeliveryIds";
import { CredentialDiskWatch, type CredentialDiskWatchDeps } from "./credentialDiskWatch";
import { RUNTIME_READINESS_FILE, RuntimeReadinessStore } from "./runtimeReadinessStore";
import { runSecurityCommand } from "./credentialSource";
import { ambientProcessEnv } from "./processEnvPatch";
import { DAEMON_MIGRATION_TRANSPORT_CAPABILITIES } from "./migrationTransportCapabilities";
import {
  createRuntimeAccountUsageCollector,
  type RuntimeAccountUsageCollector,
} from "./runtimeAccountUsage/collector";
import {
  claudeLimitResetsDrivable,
  createRuntimeLimitResetRedeemer,
  createRuntimeLimitResetsReader,
  type RuntimeLimitResetRedeemer,
  type RuntimeLimitResetReport,
  type RuntimeLimitResetsReader,
} from "./runtimeAccountUsage/limitReset";

const RUNNER_CREDENTIAL_SCOPES = ["send", "read", "mentions", "tasks", "reactions", "server", "channels", "knowledge", "mcp"] as const;
const RUNNER_CREDENTIAL_MINT_MAX_ATTEMPTS = 3;
const RUNNER_CREDENTIAL_MINT_RETRY_DELAY_MS = 250;
/** The feedback transcript result under RAFT_PRIVACY_MODE (feedbackTranscriptCollectorErrorResult). */
export const FEEDBACK_TRANSCRIPT_PRIVACY_MODE_ERROR = "privacy mode is on: no feedback transcript is collected";
const MIGRATION_OBJECT_STORE_DOWNLOAD_RETRY_INITIAL_MS = 25;
const MIGRATION_OBJECT_STORE_DOWNLOAD_RETRY_MAX_MS = 250;
// The target polls for the source's control while the source packs and
// uploads, which can take many minutes. The poll starts at 25 ms and doubles,
// so a quick migration is noticed within a few seconds; past ~25 s of waiting
// it settles at one request per 15 s. The server cannot push "control ready",
// so this cap is the most latency a long wait adds once the upload completes
// (small next to the minutes already spent), and it bounds one waiting target
// to ~4 requests a minute instead of ~30 (2 s cap). The lease TTL (hours) is
// far longer, and the last sleep is clamped to the lease's remaining time.
const MIGRATION_CONTROL_WAIT_RETRY_INITIAL_MS = MIGRATION_OBJECT_STORE_DOWNLOAD_RETRY_INITIAL_MS;
const MIGRATION_CONTROL_WAIT_RETRY_MAX_MS = 15_000;
// A chunk transfer that gets no HTTP response at all for this long means this
// Computer cannot reach object storage (proxy, firewall, outage). Give up so
// the migration fails with that reason instead of retrying until the lease
// expires hours later.
const MIGRATION_OBJECT_STORE_UNREACHABLE_MS = 5 * 60 * 1000;
// Matches the source's upload concurrency.
const MIGRATION_TARGET_CHUNK_DOWNLOAD_CONCURRENCY = 3;
/** A chunk whose bytes keep failing their digest is corrupt, not a network blip. */
const MIGRATION_CHUNK_DIGEST_MISMATCH_MAX_ATTEMPTS = 3;
// A body retry downloads the whole chunk again, so back off further than the
// header-level retries do.
const MIGRATION_CHUNK_BODY_RETRY_INITIAL_MS = 1_000;
const MIGRATION_CHUNK_BODY_RETRY_MAX_MS = 10_000;
const RETRYABLE_CHUNK_BODY_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

/**
 * True only for failures of the network stream itself (connection dropped or
 * timed out while the chunk body was streaming). Local file-system errors
 * (ENOSPC, EACCES, EROFS, ...) and our own MIGRATION_* errors never recover by
 * downloading again, so they fail the chunk at once with their real reason.
 */
function isRetryableChunkBodyError(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 5; depth += 1) {
    if (!(current instanceof Error)) return false;
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && (RETRYABLE_CHUNK_BODY_ERROR_CODES.has(code) || code.startsWith("UND_ERR_"))) {
      return true;
    }
    // undici reports a body cut off mid-stream as `TypeError: terminated`.
    if (current.name === "TypeError" && current.message === "terminated") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
const DISK_STATUS_FIRST_REPORT_DELAY_MS = 60_000;
/** Reconciler step 15 (B13): how long after a missing-runtime local stop the daemon re-detects runtimes. */
export const RUNTIME_ABSENT_REDETECT_DELAY_MS = 10_000;
const DISK_STATUS_REPORT_INTERVAL_MS = 60 * 60 * 1_000;
// Memory moves faster than disk; the machine picker reads the latest report.
const MEMORY_STATUS_REPORT_INTERVAL_MS = 5 * 60 * 1_000;
const STUCK_TOOL_V0_IDENTITY_ATTRS = [
  "schema_version",
  "server_id",
  "machine_id",
  "agent_id",
  "launch_id",
  // #424: the raw value is dropped by the sink and has no hash form; the fact
  // it carried ("this tool had a session") survives on the flag below, which is
  // #422 class B. Listing the bare key promised something the disk never gets.
  "runtime_session_id_present",
  "runtime_turn_id",
  "tool_execution_instance_id",
  "runtime_tool_call_id_present",
  "process_instance_id",
  // #424: `producer_fact_id` removed — scrubbed by the #460 ruling and its emit
  // deleted in #422, so the contract was naming a key nothing can supply.
  "runtime",
  "runtime_version",
  "tool_class",
] as const;

/** The most limit resets any account in a usage snapshot reports (Codex); absent when none reports a count. */
function limitResetsAvailableAttr(snapshot: RuntimeAccountUsageSnapshot): { limit_resets_available?: number } {
  const counts = snapshot.accounts.flatMap((account) => (account.limitResetsAvailable === undefined ? [] : [account.limitResetsAvailable]));
  return counts.length === 0 ? {} : { limit_resets_available: Math.max(...counts) };
}

/**
 * The retire runs ~20 s after the service start, and once more 10 min after a
 * passing failure (deviceSessionRetire.ts): look at the report again after each.
 */
const DEVICE_SESSION_RETIRE_LATE_FLUSHES_MS = [60_000, 11 * 60_000] as const;

export const DAEMON_CORE_TRACE_ATTR_CONTRACTS = {
  // task #1127. Registering this span is also how "never record argument
  // values" stops being a promise: the contract filter drops anything not
  // listed, so a later attempt to attach the stderr body cannot survive.
  "daemon.agent.tool_argument_parse_failed": {
    spanAttrs: [
      "agentId",
      "launchId",
      "runtime",
      "model",
    ],
  },
  // The user's ignore additions on a migration source: counts and the failure
  // reason only; the filter keeps a path or the user's name from being attached.
  "daemon.migration_transport.user_ignore": {
    spanAttrs: [
      "migration_ref",
      "role",
      "transfer_kind",
      "stage",
      "outcome",
      "written_count",
      "already_present_count",
      "rejected_count",
      "reason",
      "http_status",
    ],
  },
  // task #17: web login / logout. Runtime, outcome and counts only; the
  // contract filter keeps a link, code or account from ever being attached.
  // Per runtime: status, then how it is signed in as OAR names it (labels and
  // closed sets only, never the account). These four were emitted since #11069
  // but missing here, so the filter dropped them (#oar-raft:eea998ea).
  "daemon.runtime_auth.status.reported": {
    spanAttrs: ["trigger", ...(["claude", "codex", "kimi", "qoder", "qwen", "antigravity", "pi", "grok", "opencode", "codebuddy"] as const).flatMap((runtime) => [
      runtime,
      `${runtime}_method`,
      `${runtime}_plan`,
      `${runtime}_sign_in_kind`,
      `${runtime}_billing_kind`,
    ])],
  },
  "daemon.runtime_auth.message_dropped": { spanAttrs: ["type"] },
  // provider_id: Pi's provider (pi's /login id, a short checked pattern), never anything signed in.
  "daemon.runtime_auth.login.started": { spanAttrs: ["runtime", "region", "provider_id"] },
  "daemon.runtime_auth.login.event": { spanAttrs: ["kind"] },
  "daemon.runtime_auth.login.event_dropped": { spanAttrs: ["kind"] },
  "daemon.runtime_auth.login.code_dropped": { spanAttrs: ["reason"] },
  // error_kind: OpenCode's only (OAR's closed error kinds, or the queue's), never a message.
  "daemon.runtime_auth.login.result": { spanAttrs: ["runtime", "provider_id", "outcome", "reason", "error_kind", "code_prompts", "duration_ms"] },
  "daemon.runtime_auth.logout.result": { spanAttrs: ["runtime", "provider_id", "outcome", "reason", "error_kind", "duration_ms"] },
  "daemon.runtime_auth.rescan_models.failed": { spanAttrs: ["runtime"] },
  // Qwen Code's provider list and connect: the provider id (Qwen's menu id),
  // the outcome and OAR's error kind. Never the key, an endpoint or a model.
  "daemon.runtime_auth.providers.result": { spanAttrs: ["runtime", "outcome", "reason", "error_kind", "provider_count", "duration_ms"] },
  "daemon.runtime_auth.connect_provider.result": { spanAttrs: ["runtime", "provider_id", "outcome", "reason", "error_kind", "duration_ms"] },
  // #proj-raft-computer:#46: what a successful login or provider connect
  // released on that runtime's shared credential (invalid records, provider
  // limit and the waits it armed). Counts and closed reasons only.
  "daemon.runtime_auth.credentials_changed.listener_failed": { spanAttrs: ["runtime", "reason"] },
  // Reconciler step 15: an invalid credential released because its source
  // changed on disk. The runtime and kinds only: never a path (a home path
  // can hold a user name), a digest or content.
  "daemon.credential.disk_change_release": {
    spanAttrs: ["runtime", "credential_key_kind", "source_kind", "release_cause", "credential_invalid_released", "credential_invalid_reason"],
  },
  // Reconciler step 15: a released credential signs in as another account,
  // so the live process restarts. Booleans only: never an account id.
  "daemon.agent.credential_account.restart": {
    spanAttrs: ["agentId", "runtime", "launchId", "release_cause", "account_changed", "account_unknown", "held_count", "host"],
  },
  "daemon.agent.runtime_credentials_changed.cleared": {
    spanAttrs: ["runtime", "reason", "release_cause", "credential_invalid_released", "credential_invalid_reason", "provider_limit_backoffs_cleared", "live_backoffs_ended", "cooldowns_ended"],
  },
  // Reconciler step 15 (B12): live processes on another runtime CLI version
  // than the last detection. Versions and a count only, never agent ids.
  "daemon.agent.cli_version_drift": {
    spanAttrs: ["runtime", "from_version", "to_version", "direction", "live_agents", "from_versions"],
  },
  "daemon.runtime_account_usage.refresh": {
    spanAttrs: [
      "outcome",
      "provider",
      "reason",
      "account_count",
      "window_count",
      "health_classes",
      "parse_unavailable_count",
      // #oar-raft:#3: the most limit resets any account reports (Codex), when one reports a count.
      "limit_resets_available",
      "error_class",
    ],
  },
  // A limit-reset redeem from the web: the provider, the wire outcome and its
  // reason, OAR's own answer before the mapping (`oar_outcome`, e.g.
  // `not_attempted:busy`), and whether the usage read after it was sent.
  // Never the key. Claude adds the kind clicked and whether Claude's older
  // program spent its 5-hour reset unasked; `operation: "read"` is a read of
  // the resets held, with Claude Code's version and counts of kinds by state.
  // Never screen text.
  "daemon.runtime_account_usage.limit_reset": {
    spanAttrs: [
      "outcome", "provider", "reason", "snapshot_sent", "limit_resets_available", "duration_ms",
      "operation", "reset_kind", "claude_version", "oar_outcome", "program", "five_hour_spent", "available_kinds", "unknown_kinds",
    ],
  },
  "daemon.app_config.receive": {
    spanAttrs: [
      ...APP_CONFIG_TRACE_IDENTITY_KEYS,
      ...APP_SNAPSHOT_TRACE_IDENTITY_KEYS,
      "message_type",
      "outcome",
      "reason",
    ],
  },
  "daemon.app_inbox.mint": {
    spanAttrs: [...APP_SOURCE_TRACE_IDENTITY_KEYS, "outcome", "retention"],
  },
  "daemon.app_inbox.ack": {
    spanAttrs: [...APP_SOURCE_TRACE_IDENTITY_KEYS, "outcome", "retention"],
  },
  // #wg-ax:#17: one run of the reminder-server-ack@1 backfill (acks a daemon
  // before the token held only locally, sent to the Server). Counts only.
  "daemon.app_inbox.server_ack_backfill": {
    spanAttrs: ["owner_agent_id", "attempted", "accepted", "refused", "failed", "remaining", "done"],
  },
  "daemon.agent.app_inbox_notice": {
    spanAttrs: [
      ...APP_SOURCE_TRACE_IDENTITY_KEYS,
      "outcome",
      "mode",
      "pending_app_items",
      "message_identity_created",
      "failure_reason",
      "busy_retry_attempts",
      "busy_wait_ms",
    ],
  },
  "daemon.app_source.receive": {
    spanAttrs: [
      ...APP_SOURCE_TRACE_IDENTITY_KEYS,
      ...APP_SNAPSHOT_TRACE_IDENTITY_KEYS,
      "message_type",
      "outcome",
    ],
  },
  "daemon.app_source.snapshot_request": {
    spanAttrs: [
      ...APP_SNAPSHOT_TRACE_IDENTITY_KEYS,
      "outcome",
      "reason",
    ],
  },
  "daemon.app_source.arm": {
    spanAttrs: [...APP_SOURCE_TRACE_IDENTITY_KEYS, "outcome", "reason"],
  },
  "daemon.app_source.fire": {
    spanAttrs: [
      ...APP_SOURCE_TRACE_IDENTITY_KEYS,
      "outcome",
      "reason",
      "wake_enqueued",
      "catchup",
    ],
    endAttrs: [
      "item_id",
      "outcome",
      "reason",
      "wake_enqueued",
      "catchup",
      "error_class",
    ],
  },
  "daemon.app_source.receipt": {
    spanAttrs: [...APP_SOURCE_TRACE_IDENTITY_KEYS, "outcome", "catchup"],
  },
  "daemon.app_source.fire_request": {
    spanAttrs: [...APP_SOURCE_TRACE_IDENTITY_KEYS, "request_id", "catchup"],
    endAttrs: ["outcome", "error_class"],
  },
  "daemon.app_storage.failure": {
    spanAttrs: [
      "operation",
      "store",
      "app",
      "server_id",
      "writer_epoch",
      "outcome",
      "reason",
      "failure_generation",
      "corruption_class",
    ],
  },
  "daemon.app_storage.counter": {
    spanAttrs: [
      "operation",
      "store",
      "app",
      "server_id",
      "writer_epoch",
      "family",
      "count",
      "outcome",
      "reason",
      "observed_at",
      "failure_generation",
      "corruption_class",
    ],
  },
  "daemon.app_storage.alert": {
    spanAttrs: [
      "store",
      "app",
      "server_id",
      "writer_epoch",
      "family",
      "reason",
      "operation",
      "outcome",
      "failure_reason",
      "count",
      "window_ms",
      "observed_at",
      "corruption_class",
    ],
  },
  "daemon.app_storage.heartbeat": {
    spanAttrs: ["heartbeat", "family", "server_id", "writer_epoch", "observed_at"],
  },
  "daemon.app_storage.instrumentation": {
    spanAttrs: [
      "store",
      "app",
      "server_id",
      "writer_epoch",
      "family",
      "outcome",
      "reason",
      "observed_at",
    ],
  },
  "daemon.app_schedule.occurrence": {
    spanAttrs: [
      ...APP_SOURCE_TRACE_IDENTITY_KEYS,
      "occurrence",
      "phase",
      "outcome",
      "observed_at",
      "reason",
      "scheduled_due",
      "fire_delay_ms",
    ],
  },
  "daemon.app_schedule.delivery_alert": {
    spanAttrs: [
      ...APP_SOURCE_TRACE_IDENTITY_KEYS,
      "occurrence",
      "reason",
      "scheduled_due",
      "fire_delay_ms",
      "fired",
      "app_item_materialized",
      "wake_request_accepted",
      "turn_outcome",
      "acknowledged",
      "observed_at",
    ],
  },
  "daemon.lifecycle.start": {
    spanAttrs: ["machine_dir_present", "local_trace_enabled"],
    endAttrs: ["error_class"],
    eventAttrs: {
      "daemon.machine_lock.acquired": ["machine_dir_present"],
    },
  },
  "daemon.lifecycle.stop": {
    spanAttrs: ["machine_lock_present", "shutdown_reason", "stop_source", "stop_signal", "uptime_ms"],
  },
  // This daemon took over a machine lock another owner left behind (once per
  // process, right after acquiring it). No pid, no path: why it was stale
  // (owner_dead, pid_reused, incomplete), the platform, and for a reused
  // pid how it was told (the owner's recorded start identity, or its start
  // time against the lock's startedAt).
  "daemon.machine_lock.reclaimed": {
    spanAttrs: ["reason", "platform", "identity_source"],
  },
  // A runner of this Computer exited on the machine lock (the Computer
  // service recorded it); relayed by whichever runner connects next, once.
  // Whether that daemon could read the owner pid's start and the lock's
  // age bucket; never which pid, path or server.
  "daemon.machine_lock.conflict": {
    spanAttrs: ["platform", "owner_start_readable", "lock_age_days"],
  },
  "daemon.process.memory": {
    spanAttrs: [...PROCESS_MEMORY_TRACE_ATTRS],
  },
  "daemon.runner_credential_mint": {
    spanAttrs: ["agentId", "runtime"],
    endAttrs: ["error_class"],
  },
  "daemon.runner_credential_mint.retry": {
    spanAttrs: ["agentId", "runtime", "attempt", "max_attempts", "http_status", "code", "reason", "retryable"],
  },
  "daemon.runner_credential_mint.failed": {
    spanAttrs: ["agentId", "runtime", "http_status", "code", "reason", "retryable", "max_attempts"],
  },
  "daemon.agent.spawn.risky_variables": {
    spanAttrs: ["agentId", "runtime", "risky_variable_names", "invalid_variable_name_count"],
  },
  "daemon.agent.spawn.failed": {
    spanAttrs: [
      "agentId",
      "launchId",
      "start_dispatch_id",
      "runtime",
      "model",
      "failure_reason",
      "failure_classification",
      "session_id_present",
    ],
  },
  "daemon.runtime.node_host_launch": {
    // Which Codex install a launch picked (#14189), recorded by the legacy
    // driver and, with `host: "oar"`, by the OAR host's Codex launch.
    spanAttrs: ["agentId", "launchId", "runtime", "host", "candidate_source", "rejected_candidate_count", "rejection_kind", "host_kind", "electron_run_as_node"],
    endAttrs: ["error_class"],
  },
  "daemon.agent.process.error": {
    spanAttrs: ["agent_id", "server_id", "machine_id", "launch_id", "start_dispatch_id", "process_instance_id", "session_id_present", "runtime", "runtime_version", "error_class"],
  },
  "daemon.codex.request_instruction_shape": {
    spanAttrs: [
      "host",
      "agent_id",
      "server_id",
      "machine_id",
      "launch_id",
      "process_instance_id",
      "session_id",
      "session_id_present",
      "runtime",
      "runtime_version",
      "instruction_shape_schema_version",
      "source",
      "observation_phase",
      "session_request_method",
      "codex_app_server_version_state",
      "codex_app_server_version",
      "compaction_count_source",
      "compaction_starts_count",
      "compaction_finishes_count",
      "standing_instructions_present",
      "standing_instructions_state",
      "standing_instructions_utf8_bytes",
      "standing_instructions_sha256",
      "developer_instructions_present",
      "developer_instructions_state",
      "developer_instructions_utf8_bytes",
      "developer_instructions_sha256",
      "base_instructions_present",
      "base_instructions_state",
      "base_instructions_utf8_bytes",
      "base_instructions_sha256",
      "developer_instructions_match_standing",
    ],
  },
  "daemon.agent.start": {
    spanAttrs: ["agent_id", "launch_id", "start_dispatch_id", "runtime", "runtime_cli_version"],
    endAttrs: ["outcome", "error_class"],
  },
  "daemon.agent.start_dispatch.receipt": {
    spanAttrs: [
      "agent_id",
      "launch_id",
      "start_dispatch_id",
      "queue_state",
      "queue_depth",
      "queue_age_ms",
      "outcome",
    ],
  },
  "launch_residency_transition": {
    spanAttrs: [
      "span_name",
      "phase",
      "agent_launch_id",
      "agent_id",
      "server_id",
      "machine_id",
      "runtime",
      "driver",
      "launch_source",
      "state_instance_id",
      "transition_seq",
      "residency_transition_seq",
      "transition_kind",
      "phase_result",
      "close_result",
      "state",
      "residency",
      "agent_launch_id_present",
      "is_wait_state",
      "fence_kind",
      "deadline_unix_ms",
      "failure_kind",
      "negative_evidence_bucket",
    ],
  },
  "daemon.agent.delivery": {
    spanAttrs: ["agentId", "deliveryId", "delivery_correlation_id", "messageId", "message_id_present", "seq"],
    eventAttrs: {
      "daemon.receive": ["seq", "deliveryId"],
      "daemon.deliver_to_agent_manager": ["accepted"],
      "daemon.delivery.buffered_for_start": ["pending_count"],
      "daemon.ack.sent": ["seq"],
    },
    endAttrs: ["outcome", "ackSeq", "deliveryId", "error_class", "pending_count"],
  },
  "daemon.agent_proxy.request": {
    spanAttrs: [
      "agentId",
      "route_family",
      "route_path_version",
      "method",
      "trace_context_state",
      "proxy_launch_id_present",
      // Closed set: "launch" or "stable_entry" (#proj-raft-computer:#58).
      "via",
      "correlation_id",
    ],
    endAttrs: [
      "outcome",
      "local_response_kind",
      "http_status",
      "normalized_code",
      "response_started",
      "body_size_bucket",
      "response_complete",
      "failure_class",
      // Closed set: scrubbedProxyCauseCode maps anything unknown to
      // UPSTREAM_TRANSPORT_FAILURE, so no raw error text reaches the span.
      "cause_code",
      "third_party_ack_mode",
      "third_party_served_count",
      // Closed enums and counts from proxyFailureSpanAttrs: which layer
      // failed, which host class, whether an HTTP proxy was used, and how
      // many resolved addresses were tried / timed out (no addresses).
      "upstream_layer",
      "target_host_class",
      "via_http_proxy",
      "connect_attempted_addresses",
      "connect_timed_out_addresses",
    ],
  },
  "daemon.runtime_profile.control.received": {
    spanAttrs: ["agentId", "control_kind", "key_present", "launchId"],
    endAttrs: ["outcome", "error_class"],
  },
  "daemon.computer_control.received": {
    spanAttrs: ["action", "handled", "operation_id", "request_id"],
  },
  // One step of a web upgrade, often sent after the restart it spans
  // (delivered_late_ms / after_deadline); `reason` is the installer's
  // one-line, control-free text, bounded on the Computer. On a failed
  // receipt, `diagnostic` is the installer's own error, bounded and redacted
  // on the Computer (traceSafeDiagnostic), and `start_failure` /
  // `start_exit_code` classify a candidate that would not start (its stderr
  // stays on the machine). Every receipt (success included) also yields
  // `installer_finished` with the receipt's installer_version and
  // receipt_outcome, the engine's own error (engine_diagnostic, redacted like
  // `diagnostic`), K's operation phase/outcome/reason (engine_*), and the
  // installer's last start (last_start_*: slot candidate/previous, version,
  // succeeded, failure class and exit code; never stderr).
  // `installer_receipt_updated` is a later rewrite of an unresolved receipt;
  // `after_receipt` marks a service stop/start after the receipt existed.
  "daemon.computer_upgrade.step": {
    spanAttrs: [
      "request_id",
      "step",
      "outcome",
      "from_version",
      "target_version",
      "duration_ms",
      "error_code",
      "reason",
      "delivered_late_ms",
      "after_deadline",
      "supervisor",
      "kill_mode",
      "bytes",
      "version",
      "phase",
      "via",
      "diagnostic",
      "start_failure",
      "start_exit_code",
      "installer_version",
      "receipt_outcome",
      "engine_diagnostic",
      "engine_phase",
      "engine_outcome",
      "engine_reason",
      "last_start_slot",
      "last_start_version",
      "last_start_succeeded",
      "last_start_failure",
      "last_start_exit_code",
      "after_receipt",
    ],
  },
  // #proj-runtime:#47: what the Computer's start-time device session retire
  // ended with (deviceSessionRetire.ts), once per start, sent by the first
  // runner that claims it. Codes and counts only (never a token, key or id).
  "daemon.computer.device_session_retire": {
    spanAttrs: ["reason", "deleted", "keys_tried", "attempt", "http_status", "logout"],
  },
  "daemon.computer_control.replayed": {
    spanAttrs: ["action", "operation_id", "outcome"],
  },
  "daemon.ready.sent": {
    spanAttrs: ["runtimes_count", "running_agents_count", "idle_agents_count", "runtime_profile_reports_count"],
  },
  "daemon.runtime_profile.report.sent": {
    spanAttrs: ["agentId", "launchId", "runtime", "report_source", "model_present", "session_ref_present", "workspace_ref_present"],
  },
  "daemon.runtime.progress.activity.suppressed": {
    spanAttrs: ["agentId", "launchId", "runtime", "outcome", "source", "itemType", "payloadBytes"],
  },
  "daemon.runtime_models.detect": {
    spanAttrs: ["runtime", "request_id"],
    eventAttrs: {
      "daemon.pi.models.services_ready": ["available_models_count", "diagnostics_count", "diagnostic_info_count", "diagnostic_warning_count"],
      "daemon.pi.models.result": ["available_models_count", "returned_models_count", "diagnostics_count", "diagnostic_info_count", "diagnostic_warning_count", "outcome"],
    },
    // cache (fresh/stale/miss/forced/static) and joined_in_flight say why a read
    // was fast or slow; the handler set them but they were dropped here.
    endAttrs: ["outcome", "models_count", "default_model_present", "verified_as", "error_class", "cache", "joined_in_flight"],
  },
  // task #510: per-prompt span. `prompts_in_flight` is the cross-agent concurrency
  // observable — under the old process-env-patch lock it could never exceed 1
  // (every Pi prompt serialized process-wide); > 1 proves the queue is gone.
  // `queued_ms` is the queued -> prompt-start wait that users experienced as the
  // 60-165s stall.
  "daemon.pi.prompt": {
    spanAttrs: ["agentId", "launchId", "runtime", "queued_ms", "duration_ms", "prompts_in_flight_after"],
    eventAttrs: {
      "daemon.pi.prompt.start": ["agentId", "queued_ms", "prompts_in_flight"],
      "daemon.pi.provider_request.failed": [
        "phase",
        "response_started",
        "reason",
        "http_status",
        // #424: renamed from `session_id_present` and the bare
        // `runtime_session_id` removed — same value, one family. See pi.ts.
        "runtime_session_id_present",
        "launch_id_present",
        "launch_id",
      ],
    },
  },
  // pi session rotation (pi#10642, drivers/piSessionRotation.ts). Counts,
  // sizes and closed reasons only; never a path, an id or entry content.
  // `custom_type` is a pi/extension identifier, reduced to a short
  // [A-Za-z0-9._-] shape or "other".
  "pi.session.rotated": {
    spanAttrs: ["agentId", "launchId", "runtime", "entries_before", "bytes_before", "entries_after", "bytes_after"],
  },
  "pi.session.rotation_skipped": {
    spanAttrs: ["agentId", "launchId", "runtime", "reason", "session_bytes", "min_bytes", "user_extension_count"],
  },
  "pi.session.rotate_refused": {
    spanAttrs: ["agentId", "launchId", "runtime", "reason", "custom_type", "session_bytes"],
  },
  "pi.session.rotation_failed": {
    spanAttrs: ["agentId", "launchId", "runtime", "stage", "outcome", "error_class", "error_code"],
  },
  // Task #1310: one row per Pi provider call (drivers/piProviderCallTracker.ts).
  // Closed sets and bucketed durations only; never a URL, header, body or error text.
  "daemon.pi.provider_call.ended": {
    spanAttrs: [
      "agentId", "launchId", "runtime",
      "call_context", "api", "provider", "outcome", "phase", "http_responses_seen", "last_http_status", "error_class",
      "duration_ms_bucket", "ms_to_headers_bucket", "ms_to_first_event_bucket",
    ],
  },
  "daemon.runtime.tool.execution.started": {
    spanAttrs: [
      ...STUCK_TOOL_V0_IDENTITY_ATTRS,
      "execution_state",
      "process_capability",
    ],
  },
  "daemon.runtime.tool.process.spawned": {
    spanAttrs: [
      ...STUCK_TOOL_V0_IDENTITY_ATTRS,
      "process_state",
      "process_tree_tracking",
      "stdio_mode",
    ],
  },
  "daemon.runtime.tool.progress.observed": {
    spanAttrs: [
      ...STUCK_TOOL_V0_IDENTITY_ATTRS,
      "progress_source",
      "observed_bytes_bucket",
      "update_count_bucket",
    ],
  },
  "daemon.runtime.tool.process.exited": {
    spanAttrs: [
      ...STUCK_TOOL_V0_IDENTITY_ATTRS,
      "process_state",
      "exit_kind",
      "process_runtime_ms",
    ],
  },
  "daemon.runtime.tool.execution.finished": {
    spanAttrs: [
      ...STUCK_TOOL_V0_IDENTITY_ATTRS,
      "execution_state",
      // failed | aborted only: a closed enum, never command text or output.
      "failure_reason",
      "execution_runtime_ms",
      "process_exit_observed_before_finish",
    ],
  },
  "daemon.runtime.tool.diagnostic.snapshot": {
    spanAttrs: [
      ...STUCK_TOOL_V0_IDENTITY_ATTRS,
      "diagnostic_trigger",
      "classification",
      "tool_pending",
      "process_liveness",
      "process_liveness_source",
      "process_group_liveness",
      "progress_state",
      "tool_age_ms",
      "last_progress_age_ms",
      "observation_interval_ms",
      "runtime_inactivity_age_ms",
      "negative_evidence_bucket",
    ],
  },
  "daemon.pi.session.create": {
    spanAttrs: ["agentId", "launchId", "runtime", "model", "session_id_present", "requested_model"],
    eventAttrs: {
      "daemon.pi.session.services_ready": ["available_models_count", "diagnostics_count", "diagnostic_info_count", "diagnostic_warning_count", "agent_dir_source"],
      "daemon.pi.session.model_resolved": ["available_models_count", "requested_model", "requested_model_explicit", "resolved_model", "resolved_model_present"],
      "daemon.pi.session.missing_model": ["available_models_count", "requested_model"],
      "daemon.pi.session.started": ["requested_model", "resolved_model", "session_id_present"],
    },
    endAttrs: ["outcome", "available_models_count", "diagnostics_count", "diagnostic_info_count", "diagnostic_warning_count", "requested_model", "resolved_model", "resolved_model_present", "error_class"],
  },
  "daemon.builtin.session.create": {
    spanAttrs: ["agentId", "launchId", "runtime", "model", "session_id_present", "requested_model", "config_source", "host_user_state", "provider_id", "model_kind", "model_id", "base_url_present", "base_url_host_class", "provider_key_present", "provider_key_source"],
    eventAttrs: {
      "daemon.builtin.session.services_ready": ["available_models_count", "diagnostics_count", "diagnostic_info_count", "diagnostic_warning_count", "agent_dir_source", "config_source", "host_user_state", "provider_id", "model_kind", "model_id", "base_url_present", "base_url_host_class", "provider_key_present", "provider_key_source"],
      "daemon.builtin.session.model_resolved": ["available_models_count", "requested_model", "requested_model_explicit", "resolved_model", "resolved_model_present", "config_source", "host_user_state", "provider_id", "model_kind", "model_id", "base_url_present", "base_url_host_class", "provider_key_present", "provider_key_source"],
      // gatewayModelLimits.ts: outcome (ok|not_listed|no_limits|failed:<class>), cached (no request made
      // for this answer), provider_kind (gateway|openrouter), *_reported (booleans), format (only when ok:
      // generic|openrouter|cliproxyapi_pi, the reader that matched), fallback_read (the client_version=pi
      // catalog was consulted after the plain list gave no limit). Closed sets only; never a URL, key or body.
      "daemon.builtin.session.gateway_model_limits": ["outcome", "cached", "provider_kind", "context_window_reported", "max_tokens_reported", "format", "fallback_read"],
      "daemon.builtin.session.missing_model": ["available_models_count", "requested_model", "config_source", "host_user_state", "provider_id", "model_kind", "model_id", "base_url_present", "base_url_host_class", "provider_key_present", "provider_key_source"],
      "daemon.builtin.session.started": ["requested_model", "resolved_model", "session_id_present", "config_source", "host_user_state", "provider_id", "model_kind", "model_id", "base_url_present", "base_url_host_class", "provider_key_present", "provider_key_source"],
    },
    endAttrs: ["outcome", "available_models_count", "diagnostics_count", "diagnostic_info_count", "diagnostic_warning_count", "requested_model", "resolved_model", "resolved_model_present", "error_class", "config_source", "host_user_state", "provider_id", "model_kind", "model_id", "base_url_present", "base_url_host_class", "provider_key_present", "provider_key_source"],
  },
  "daemon.connection.local_disconnect_observed": {
    spanAttrs: ["running_agents_count", "idle_agents_count"],
  },
  "daemon.migration_transport.object_store": {
    spanAttrs: [
      "outcome",
      "role",
      "transfer_kind",
      "migration_ref",
      "stage",
      "operation",
      "agent_id_present",
      "migration_id_present",
      "session_id_present",
      "error_class",
      "error_code",
      "upstream_error_code",
      "http_status",
    ],
  },
  "daemon.migration_transport.resumable": {
    spanAttrs: [
      "outcome",
      "role",
      "transfer_kind",
      "migration_ref",
      "stage",
      "operation",
      "error_class",
      "error_code",
      "upstream_error_code",
      "http_status",
      "attempt",
      "retry_delay_ms",
      "chunk_count",
      "bundle_size_bucket",
      "control_bytes",
      "commit_outcome",
      "residue_class",
      "duration_ms",
      "chunks_removed",
      "chunks_freed_bytes",
    ],
  },
  "daemon.migration_transport.lease": {
    spanAttrs: [],
    endAttrs: [
      "outcome",
      "role",
      "transfer_kind",
      "migration_ref",
      "stage",
      "error_class",
      "agent_id_present",
      "migration_id_present",
      "session_id_present",
    ],
  },
  "daemon.migration_transport.transfer": {
    spanAttrs: ["role", "transfer_kind", "migration_ref", "stage", "download_concurrency"],
    endAttrs: ["outcome", "error_class"],
  },
  "daemon.migration_transport.placement": {
    spanAttrs: ["role", "transfer_kind", "migration_ref", "stage", "chunk_count", "file_count", "expanded_bytes"],
    endAttrs: ["outcome", "error_class"],
  },
  "daemon.agent.activity.produced": {
    // isHeartbeat/is_heartbeat (#460 V1) and process_instance_id (#460 V3)
    // were emitted by agentProcessManager but scrubbed here (pilot violation
    // V4): this list is a RUNTIME allowlist (SpanAttrContractTracer), so an
    // emission-site key that is not added here silently dies before disk.
    // Witness for the pair lives in agentProcessManager.builtin.e2e.test.ts
    // behind a contract-wrapped tracer (production-isomorphic oracle).
    // producerFactId/producer_fact_id and activity_kind/detail_kind are ALSO
    // emitted-and-scrubbed today; deliberately NOT added here — banned-join-
    // key discipline for the fact id (#460 classification ruling) means
    // widening needs its own ruling, not a drive-by.
    spanAttrs: ["agentId", "agent_id", "server_id", "machine_id", "activity", "detail_present", "entry_kinds", "ap_present", "launchId", "launch_id", "launch_id_present", "clientSeq", "client_seq", "client_seq_present", "correlation_id", "session_id_present", "runtime", "isHeartbeat", "is_heartbeat", "process_instance_id"],
  },
  "daemon.agent.status.transition": {
    spanAttrs: [
      "agentId",
      "agent_id",
      "agent_status",
      "previous_status",
      "previous_status_present",
      "status_changed",
      "launchId",
      "launch_id",
      "launch_id_present",
      "previous_launch_id_present",
      "launch_id_changed",
      "status_transition_seq",
      "observed_at_ms",
      "process_instance_id",
      "runtime",
      "session_id_present",
    ],
  },
  "daemon.agent.activity.skipped": {
    spanAttrs: ["agentId", "event_kind", "reason", "text_length"],
  },
  "daemon.agent.event.received_without_process": {
    spanAttrs: ["agentId", "event_kind", "runtime"],
  },
} satisfies TraceSpanAttrContracts;
export { subscribeDaemonLogs, type DaemonLogEvent, type DaemonLogLevel } from "./logger";
export {
  deleteWorkspaceDirectory,
  resolveWorkspaceDirectoryPath,
  scanWorkspaceDirectories,
} from "./workspaces";

export const DAEMON_CLI_USAGE = "Usage: slock-daemon --server-url <url> --api-key-file <path>";

export interface ParsedDaemonCliArgs {
  serverUrl: string;
  apiKey: string;
}

/**
 * task #1268: one detection round, reserved synchronously BEFORE the pending
 * ready is awaited (so concurrent rescans coalesce instead of starting two
 * children) and owned until it settles or is abandoned. `handle` is null while
 * the pending frame is in flight; `abandoned` makes every continuation a no-op.
 */
interface DetectionRoundRecord {
  handle: RuntimeDetectionRoundHandle | null;
  generation: number;
  roundId: number;
  publishCatalogForce: boolean;
  abandoned: boolean;
}

export interface RuntimeDetection {
  ids: string[];
  versions: Record<string, string>;
  diagnostics?: Record<string, string>;
  /** Structured cause per unavailable runtime, when its probe reported one. Daemon-local; not sent on the wire. */
  unavailableReasons?: Record<string, RuntimeProbeUnavailableReason>;
}

export type DefaultAgentEnvVarsProvider = (
  config: Pick<AgentConfig, "runtime" | "model" | "envVars">,
) => Promise<Record<string, string> | null> | Record<string, string> | null;

class RunnerCredentialMintError extends Error {
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

async function waitForAmbientBackoff(delayMs: number, signal?: AbortSignal): Promise<void> {
  // Accepted ambient timer: retry sleeps are bounded by upstream attempt limits or lease TTLs, not business-clock driven.
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForRunnerCredentialRetry(): Promise<void> {
  await waitForAmbientBackoff(RUNNER_CREDENTIAL_MINT_RETRY_DELAY_MS);
}

function isRetryableMigrationObjectStoreDownloadStatus(status: number): boolean {
  return status === 404
    || status === 408
    || status === 409
    || status === 425
    || status === 429
    || status >= 500;
}

function isRetryableResumableMigrationStatus(status: number, retryNotFound: boolean): boolean {
  return (retryNotFound && status === 404)
    || status === 408
    || status === 425
    || status === 429
    || status >= 500;
}

// Bundle-build progress is reported at most this often. The server slides the
// prep deadline only when the reported counts grew, so a stuck build that keeps
// reporting still times out.
const MIGRATION_SOURCE_PROGRESS_INTERVAL_MS = 30_000;
const MIGRATION_TARGET_STEP_RETRY_INITIAL_MS = 1_000;
const MIGRATION_TARGET_STEP_RETRY_MAX_MS = 30_000;
// Long enough to ride out a rolling server deploy; bounded well inside the
// arrival deadline so a genuinely broken server still fails the run.
const MIGRATION_TARGET_STEP_RETRY_BUDGET_MS = 5 * 60_000;

/** States in which a target control step has already taken effect. */
const MIGRATION_TARGET_STEP_APPLIED_STATES: Record<"start-transfer" | "flip-machine" | "arrived", readonly string[]> = {
  "start-transfer": ["in_transit", "arriving", "starting", "completed"],
  "flip-machine": ["arriving", "starting", "completed"],
  "arrived": ["starting", "completed"],
};

/** Network failures and 408/425/429/5xx responses may succeed on retry; 4xx decisions do not. */
export function isTransientMigrationStepFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = /^MIGRATION_TARGET_IMPORT_[A-Z_]+_FAILED:(\d{3})(?::|$)/.exec(error.message)?.[1]
    ?? /^MIGRATION_TARGET_IMPORT_LOOKUP_FAILED:(\d{3})$/.exec(error.message)?.[1];
  if (status) {
    const code = Number(status);
    return code === 408 || code === 425 || code === 429 || code >= 500;
  }
  // fetch() rejects with a TypeError ("fetch failed") on connection-level errors.
  return error instanceof TypeError || systemErrorCode(error) !== null || systemErrorCode(error.cause) !== null;
}

/**
 * Target control steps used to be sent once: a 5xx or dropped connection
 * during a server deploy failed the whole migration, even after the flip.
 * Retry transient failures with backoff, and before each retry read the
 * current view: the lost attempt may have committed, in which case the step is
 * done and must not be replayed. If it did not commit, the identical request
 * is resent; a generation change aborts the run instead (the server rejects
 * stale generations, and a retry must never borrow the new one).
 */
export async function retryMigrationTargetStep<B extends { migrationGeneration: string }>(input: {
  step: keyof typeof MIGRATION_TARGET_STEP_APPLIED_STATES;
  body: B;
  post: (body: B) => Promise<MigrationTargetImportView>;
  fetchView: () => Promise<MigrationTargetImportView>;
  onRetry?: (error: unknown, delayMs: number) => void;
  wait?: (delayMs: number) => Promise<void>;
  nowMs?: () => number;
}): Promise<MigrationTargetImportView> {
  const nowMs = input.nowMs ?? currentTimeMs;
  const wait = input.wait ?? ((delayMs: number) => waitForAmbientBackoff(delayMs));
  const retryUntilMs = nowMs() + MIGRATION_TARGET_STEP_RETRY_BUDGET_MS;
  let delayMs = MIGRATION_TARGET_STEP_RETRY_INITIAL_MS;
  while (true) {
    try {
      return await input.post(input.body);
    } catch (error) {
      if (!isTransientMigrationStepFailure(error) || nowMs() + delayMs > retryUntilMs) throw error;
      input.onRetry?.(error, delayMs);
    }
    await wait(delayMs);
    delayMs = Math.min(delayMs * 2, MIGRATION_TARGET_STEP_RETRY_MAX_MS);
    let current: MigrationTargetImportView;
    try {
      current = await input.fetchView();
    } catch (error) {
      if (!isTransientMigrationStepFailure(error) || nowMs() + delayMs > retryUntilMs) throw error;
      continue;
    }
    if (MIGRATION_TARGET_STEP_APPLIED_STATES[input.step].includes(current.state)) return current;
    // Never adopt a generation this run did not start with: a changed
    // generation means the run was superseded (canceled, re-provisioned), and
    // retrying under the new one would bypass the stale-generation guard.
    if (current.migrationGeneration !== input.body.migrationGeneration) {
      throw new Error("MIGRATION_TARGET_STEP_GENERATION_SUPERSEDED");
    }
  }
}

/**
 * The target's wait for the source's control manifest: poll until it is ready,
 * backing off from 25 ms to MIGRATION_CONTROL_WAIT_RETRY_MAX_MS, until the
 * lease expires. `poll` returns null for "not ready yet" (409 or a retryable
 * status) and throws to stop (410, other non-retryable statuses).
 */
export async function pollMigrationResumableControl<T>(input: {
  expiresAtMs: number;
  signal: AbortSignal;
  poll: () => Promise<T | null>;
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  nowMs?: () => number;
}): Promise<T> {
  const nowMs = input.nowMs ?? currentTimeMs;
  const wait = input.wait ?? waitForAmbientBackoff;
  let delayMs = MIGRATION_CONTROL_WAIT_RETRY_INITIAL_MS;
  while (nowMs() < input.expiresAtMs) {
    input.signal.throwIfAborted();
    const ready = await input.poll();
    if (ready !== null) return ready;
    const remainingMs = input.expiresAtMs - nowMs();
    if (remainingMs <= 0) break;
    await wait(Math.min(delayMs, remainingMs), input.signal);
    delayMs = Math.min(delayMs * 2, MIGRATION_CONTROL_WAIT_RETRY_MAX_MS);
  }
  throw new Error("MIGRATION_LEASE_EXPIRED");
}

function migrationTransferFailureMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 500);
}

export function migrationTransferFailureCode(err: unknown): string | undefined {
  // A Server that does not know it yet records MIGRATION_TRANSPORT_LOST and keeps detailCode.
  if (err instanceof AgentMigrationUserIgnoreWriteError) return MIGRATION_USER_IGNORE_WRITE_FAILED;
  const message = err instanceof Error ? err.message : String(err);
  const code = /^(MIGRATION_[A-Z0-9_]+)/.exec(message)?.[1];
  return code && RESUMABLE_MIGRATION_SPECIFIC_ERROR_CODES.has(code) ? code : undefined;
}

/**
 * The message's agentId when it is not a usable workspace directory name, else
 * null. Two checks that must agree: the characters that can leave a directory
 * on any platform, and resolveWorkspaceDirectoryPath's structural rule (the
 * resolved path is exactly one level below the root), which also catches
 * inputs nobody thought to list.
 */
export function unsafeAgentIdOf(msg: unknown): string | null {
  if (!msg || typeof msg !== "object" || !("agentId" in msg)) return null;
  const agentId = (msg as { agentId?: unknown }).agentId;
  if (agentId === undefined || agentId === null) return null;
  if (typeof agentId !== "string") return String(agentId);
  return agentId.length === 0
    || agentId === "."
    || agentId === ".."
    || /[/\\:\0]/.test(agentId)
    || resolveWorkspaceDirectoryPath(UNSAFE_AGENT_ID_PROBE_ROOT, agentId) === null
    ? agentId
    : null;
}

/** Any absolute root works for the structural check; it is never touched. */
const UNSAFE_AGENT_ID_PROBE_ROOT = path.resolve("/raft-agent-workspaces");

/**
 * Best-effort, non-secret classification of any transfer failure. `code` above
 * stays limited to the codes older servers understand; this is sent alongside
 * as `detailCode` so the server can keep the real cause instead of collapsing
 * everything else into MIGRATION_TRANSPORT_LOST.
 */
export function migrationTransferFailureDetailCode(err: unknown): string | undefined {
  if (err instanceof AgentMigrationUserIgnoreWriteError) return `${MIGRATION_USER_IGNORE_WRITE_FAILED}:${err.reason}`;
  const known = migrationTransferFailureCode(err);
  if (known) return known;
  if (err instanceof MigrationStepResponseError) {
    return `${err.errorCode}:${err.httpStatus}:${err.upstreamErrorCode}`;
  }
  const message = err instanceof Error ? err.message : String(err);
  const prefixed = /^(MIGRATION_[A-Z0-9_]+(?::[0-9]{3}(?::[A-Za-z0-9_]+)?)?)/.exec(message)?.[1];
  if (prefixed) return prefixed.slice(0, 160);
  if (!(err instanceof Error)) return undefined;
  const nodeCode = systemErrorCode(err) ?? systemErrorCode((err as { cause?: unknown }).cause);
  if (nodeCode) return err.message === "fetch failed" ? `FETCH_${nodeCode}` : `NODE_${nodeCode}`;
  if (err.message === "fetch failed") return "FETCH_FAILED";
  return /^[A-Za-z]{1,40}$/.test(err.name) ? `JS_${err.name}` : undefined;
}

function systemErrorCode(value: unknown): string | null {
  const code = value && typeof value === "object" ? (value as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^E[A-Z0-9_]{1,40}$/.test(code) ? code : null;
}

const RESUMABLE_MIGRATION_SPECIFIC_ERROR_CODES = new Set([
  "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED",
  "MIGRATION_WORKSPACE_ALREADY_EXISTS",
  "MIGRATION_WORKSPACE_COMPLETE_OLD_COPY",
  "MIGRATION_CHUNK_DIGEST_MISMATCH",
  "MIGRATION_WHOLE_BUNDLE_DIGEST_MISMATCH",
  "MIGRATION_LEASE_EXPIRED",
  "MIGRATION_GENERATION_STALE",
  "MIGRATION_CONTROL_MANIFEST_INVALID",
  "MIGRATION_CONTROL_MANIFEST_TOO_LARGE",
  "MIGRATION_TRANSFER_SUMMARY_CONFLICT",
]);

function normalizeResumableMigrationSpecificErrorCode(value: string): string | null {
  const normalized = value.toUpperCase();
  return RESUMABLE_MIGRATION_SPECIFIC_ERROR_CODES.has(normalized) ? normalized : null;
}

type MigrationTraceStage =
  | "lease"
  | "user_ignore"
  | "source_drain"
  | "source_quiesce"
  | "control_register"
  | "control_wait"
  | "chunk_plan"
  | "chunk_upload"
  | "chunk_download"
  | "chunk_receipt"
  | "upload_complete"
  | "arrival_report"
  | "cancel_cleanup"
  | "transport_lost_report"
  | "verify"
  | "unpack"
  | "commit"
  | "transfer";

class MigrationStepResponseError extends Error {
  constructor(
    readonly errorCode: string,
    readonly stage: MigrationTraceStage,
    readonly httpStatus: number,
    readonly upstreamErrorCode: string,
    messageSuffix: string,
  ) {
    super(
      RESUMABLE_MIGRATION_SPECIFIC_ERROR_CODES.has(errorCode)
        ? errorCode
        : `${errorCode}:${httpStatus}:${messageSuffix}`,
    );
    this.name = "MigrationStepResponseError";
  }
}

type MigrationStepResponseDiagnostics = {
  messageSuffix: string;
  upstreamErrorCode: string;
};

function normalizeMigrationUpstreamErrorCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^(?:migration_[a-z0-9_]{1,110}|MIGRATION_[A-Z0-9_]{1,110})$/.test(normalized)
    ? normalized
    : null;
}

async function migrationStepResponseDiagnostics(
  response: Response,
): Promise<MigrationStepResponseDiagnostics> {
  try {
    const body = await response.clone().json() as { code?: unknown; error?: unknown };
    const upstreamErrorCode = normalizeMigrationUpstreamErrorCode(body.code);
    if (upstreamErrorCode) {
      return { messageSuffix: upstreamErrorCode, upstreamErrorCode };
    }
    if (typeof body.error === "string" && body.error.length > 0) {
      return {
        messageSuffix: "upstream_error",
        upstreamErrorCode: `http_${response.status}`,
      };
    }
  } catch {
    // Fall through to the bounded HTTP classification.
  }
  return {
    messageSuffix: "http_error",
    upstreamErrorCode: `http_${response.status}`,
  };
}

async function migrationStepResponseError(
  errorCode: string,
  response: Response,
  stage: MigrationTraceStage,
): Promise<Error> {
  const diagnostics = await migrationStepResponseDiagnostics(response);
  const specific = normalizeResumableMigrationSpecificErrorCode(diagnostics.messageSuffix);
  return new MigrationStepResponseError(
    specific ?? errorCode,
    stage,
    response.status,
    diagnostics.upstreamErrorCode,
    diagnostics.messageSuffix,
  );
}

function migrationObjectStoreFailureTraceAttrs(err: unknown): Record<string, unknown> {
  if (err instanceof MigrationStepResponseError) {
    return {
      stage: err.stage,
      error_code: err.errorCode,
      upstream_error_code: err.upstreamErrorCode,
      http_status: err.httpStatus,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    stage: "transfer",
    error_code: /^(MIGRATION_[A-Z0-9_]+)/.exec(message)?.[1],
  };
}

/** Why a draining migration source waits, in the Server's fixed set (AGENT_MIGRATION_SOURCE_DRAIN_WAITING_FOR). */
function migrationSourceDrainWaitingFor(reason: AgentNotIdleReason): AgentMigrationSourceDrainWaitingFor {
  switch (reason) {
    case "agent_busy": return "turn";
    case "background_tasks": return "background_tasks";
    // Input written but not consumed yet, or a mention told but not settled by a turn end.
    case "delivery_in_flight":
    case "mention_in_flight": return "queued_input";
    default: return "other";
  }
}

function migrationTraceIdentityAttrs(
  lease: AgentMigrationTransportLeaseMessage,
  stage: MigrationTraceStage,
): Record<string, unknown> {
  return {
    migration_ref: lease.migrationRef,
    role: lease.role,
    transfer_kind: lease.transferKind,
    stage,
  };
}

/**
 * Runs `work` over `items` with at most `limit` in flight. After the first
 * failure no new item starts; in-flight items settle, then that failure throws.
 */
async function forEachWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  // Cast so TypeScript does not narrow to null: workers assign it inside closures.
  let failure = null as { error: unknown } | null;
  const worker = async () => {
    while (!failure && next < items.length) {
      const item = items[next++]!;
      try {
        await work(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure.error;
}

function migrationObjectStoreBundleSizeBucket(bytes: number): string {
  if (bytes < 1024 * 1024) return "lt_1_mib";
  if (bytes < 16 * 1024 * 1024) return "1_to_16_mib";
  if (bytes < 128 * 1024 * 1024) return "16_to_128_mib";
  if (bytes < 512 * 1024 * 1024) return "128_to_512_mib";
  if (bytes < 1024 * 1024 * 1024) return "512_mib_to_1_gib";
  if (bytes < 3 * 1024 * 1024 * 1024) return "1_to_3_gib";
  return "gte_3_gib";
}

async function migrationStepErrorSuffix(response: Response): Promise<string> {
  return (await migrationStepResponseDiagnostics(response)).messageSuffix;
}

declare const __RAFT_DAEMON_VERSION__: string | undefined;

const MODEL_CATALOG_RECONNECT_MIN_INTERVAL_MS = 30 * 60_000;
/**
 * Floor between the STARTS of two connect-triggered rounds, complete or not. A
 * connection that flaps faster than a round can finish (task #354: a reconnect
 * every ~21 s for two hours) never completes one, so the completion-based
 * throttle alone would re-spawn every runtime CLI on every reconnect.
 */
const MODEL_CATALOG_RECONNECT_MIN_START_INTERVAL_MS = 5 * 60_000;
const MODEL_CATALOG_MAX_MODELS = 300;
const MODEL_CATALOG_MAX_ID_LENGTH = 200;
const MODEL_CATALOG_MAX_LABEL_LENGTH = 80;
const CATALOG_CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * Labels come straight from each runtime CLI's output, so bound what crosses the
 * wire: at most MODEL_CATALOG_MAX_MODELS entries, control characters stripped,
 * labels trimmed to MODEL_CATALOG_MAX_LABEL_LENGTH. An entry whose id is empty,
 * too long or has control characters is dropped (an id is an identity, not
 * display text, so it is never rewritten); an empty label falls back to the id.
 */
/**
 * The catalog frame one detection gives, or null when none is sent: a live
 * list as is; nothing for an error, an unsupported runtime or no models (the
 * server keeps its copy), except when the detection follows a sign-in change
 * for that runtime (`authoritative`, Pi's) and says it has no models: then an
 * empty list that replaces the server's copy, so the model picker does not
 * keep offering the models of a provider that was signed out.
 */
export function runtimeModelCatalogFrame(
  runtime: string,
  outcome: RuntimeModelSourceOutcome,
  authoritative: boolean,
): Extract<MachineToServerMessage, { type: "machine:runtime_models:catalog" }> | null {
  const models = outcome.kind === "live" ? sanitizeCatalogModels(outcome.value.models) : [];
  if (models.length > 0) return { type: "machine:runtime_models:catalog", runtime, models };
  if (authoritative && (outcome.kind === "no_models" || outcome.kind === "live")) {
    return { type: "machine:runtime_models:catalog", runtime, models: [], authoritative: true };
  }
  return null;
}

export function sanitizeCatalogModels(
  models: ReadonlyArray<{ id: string; label: string }>,
): Array<{ id: string; label: string }> {
  const out: Array<{ id: string; label: string }> = [];
  for (const model of models) {
    if (out.length >= MODEL_CATALOG_MAX_MODELS) break;
    const id = typeof model.id === "string" ? model.id.trim() : "";
    if (!id || id.length > MODEL_CATALOG_MAX_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(id)) continue;
    const label = (typeof model.label === "string" ? model.label : "").replace(CATALOG_CONTROL_CHARS, "").trim();
    out.push({ id, label: (label || id).slice(0, MODEL_CATALOG_MAX_LABEL_LENGTH) });
  }
  return out;
}

// Who asked this daemon to stop. The host knows (the Computer service records
// its own kills); a signal it did not send is "external_signal". A caller that
// names no source records "unspecified", so a missing attr only means an older
// daemon. "machine_key_revoked": the Computer runner stops its agents after
// the server refused its key for good (reconciler step 15).
export type DaemonStopSource =
  | "service_shutdown"
  | "service_unmanaged"
  | "external_signal"
  | "machine_key_revoked"
  | "unspecified";

/** How a Computer runner's stop after its key was refused ended (reconciler step 15). */
export interface MachineKeyRevokedStopTrace {
  reason: string;
  outcome: "stopped" | "deadline" | "error";
  agentCount: number;
  remainingAgentCount: number;
  durationMs: number;
  deadlineMs: number;
}

export interface DaemonStopOptions {
  source?: DaemonStopSource;
  signal?: NodeJS.Signals;
}

export interface DaemonCoreOptions {
  serverUrl: string;
  apiKey: string;
  daemonVersion?: string;
  computerVersion?: string | null;
  /** Source commit baked into a CI-built Computer; absent on local builds. */
  computerBuildSha?: string | null;
  slockCliPath?: string;
  dataDir?: string;
  /** Test/embedded override; production resolves the canonical Raft home. */
  slockHome?: string;
  machineStateDir?: string;
  /** RFC 071 outbox directory (default: `<agents data dir>/.runtime-outcome-outbox`). */
  runtimeOutcomeOutboxDir?: string;
  /** Tests only: the durable-write steps of the outbox. */
  runtimeOutcomeOutboxFs?: OutboxFs;
  machineOwnerProvenance?: DaemonMachineOwnerProvenance;
  hostname?: string;
  osDescription?: string;
  runtimeDetector?: () => RuntimeDetection;
  /** task #1268: runs one detection round in a child (default: the real child runner); tests inject a fake. */
  runtimeDetectionRound?: (options: RuntimeDetectionRoundOptions) => RuntimeDetectionRoundHandle;
  /** task #1268: whole-round deadline passed to the child runner (default: runner's own). */
  runtimeDetectionDeadlineMs?: number;
  connectionOptions?: Partial<Pick<ConnectionOptions, "inboundWatchdogMs" | "minReconnectDelayMs" | "wsFactory" | "proxyEnv" | "clock">>;
  connectionFactory?: (options: ConnectionOptions) => DaemonConnection;
  agentManagerFactory?: (
    sendToServer: (msg: MachineToServerMessage) => void,
    daemonApiKey: string,
    options?: { dataDir?: string; serverUrl: string; defaultAgentEnvVarsProvider?: DefaultAgentEnvVarsProvider; slockCliPath?: string; slockHome?: string; tracer?: Tracer; daemonInstanceId?: string; appInboxForAgent?: (agentId: string) => AgentAppInboxStore; runtimeProcessGate?: RuntimeProcessGate; connectedServerId?: () => string | null; exitStreaks?: ExitStreaks },
  ) => AgentProcessManager;
  defaultAgentEnvVarsProvider?: DefaultAgentEnvVarsProvider;
  /**
   * RFC 060: run launches the server asks for (`AgentConfig.runtimeHost:
   * "oar"`) on OAR sessions, and advertise `runtime-host:oar`. Default on
   * unless `RAFT_DAEMON_OAR_HOST_DISABLED` is set.
   */
  oarHost?: boolean;
  /** Seam for tests: how the OAR host opens a session (OAR's `scriptedRuntime`). */
  openOarSession?: OpenOarSession;
  /** Seam for tests — injected into the ReminderCache so timers can be faked. */
  reminderClock?: Clock;
  /** Seam for tests: the server features refresh's delay, timers and request ids. */
  serverFeaturesRefresh?: Omit<ServerFeaturesRefreshOptions, "send">;
  /** Where the Computer reads this process's latest memory sample (doctor). */
  processMemorySamplePath?: string | null;
  /** Where the Computer reads how many agents are mid-turn (a quiet point for stop / Raft Desktop's move). */
  turnActivitySnapshotPath?: string | null;
  /** Reconciler step 15: RUNTIME_ABSENT_REDETECT_DELAY_MS (tests shorten it). */
  runtimeAbsentRedetectDelayMs?: number;
  /**
   * Reconciler step 13: the Computer service's drain files for this runner
   * (computerUpgradeDrain.ts). Set only by a Computer runner; with it the
   * daemon advertises DAEMON_CAPABILITY_COMPUTER_UPGRADE_DRAIN_V1 and relays a
   * web upgrade's `drain` to `onComputerControl`.
   */
  computerUpgradeDrainPaths?: ComputerUpgradeDrainPaths | null;
  /** The Computer service's memory sample, carried on this process's memory event. */
  serviceMemorySamplePath?: string | null;
  tracer?: Tracer;
  /**
   * This daemon's own RAFT_PRIVACY_MODE, read once at startup by the entry
   * point (index.ts, the Computer's runner). The daemon is in privacy mode
   * when this is on OR its server's `machine:context` says `privacyMode`: no
   * trace or feedback uploads.
   */
  privacyMode?: boolean;
  localTrace?: boolean;
  localTraceMaxFileBytes?: number;
  localTraceMaxFileAgeMs?: number;
  localTraceMaxFiles?: number;
  lifecycleHooks?: {
    onConnect?: () => void;
    onDisconnect?: () => void;
    onHandshakeRejected?: (event: { statusCode: number; reason: string | null }) => void;
  };
  /** Remote upgrade v2: summary of the last installer receipt, carried on `ready`. */
  getComputerLastUpgradeReceipt?: () => Promise<ComputerLastUpgradeReceipt | null>;
  /**
   * #proj-raft-computer task #34: advisory hint that the installer state needs
   * a repair run on the machine, or null. Carried on `ready`; re-read on the memory-report cadence
   * and after a failed web upgrade, and sent as `machine:installer_repair_hint`
   * when it changed.
   */
  getComputerInstallerRepairHint?: () => Promise<ComputerInstallerRepairHint | null>;
  /**
   * Raft Desktop moved this Computer from its embedded one (RAFT_HOME's
   * one-shot `computer/migrated-from.json`): what this server's next ready
   * says in `migratedFrom`, or null (none, or this server already had it).
   */
  getComputerMigratedFrom?: () => Promise<ComputerMigratedFrom | null>;
  /** A ready carrying `migratedFrom` went out: never again for this server (the note goes once every server had it). */
  onComputerMigratedFromSent?: () => Promise<void>;
  /**
   * The Computer's last device session retire outcome not yet sent (claimed:
   * once returned, no other runner gets it), or null.
   */
  collectComputerDeviceSessionRetire?: () => Promise<ComputerDeviceSessionRetireTrace | null>;
  /**
   * Machine-lock conflicts this Computer's runners met and not yet sent
   * (claimed: once returned, no other runner gets them).
   */
  collectComputerMachineLockConflicts?: () => Promise<ComputerMachineLockConflictTrace[]>;
  /** Remote upgrade steps not yet sent for this server, and the ack that marks them sent. */
  collectComputerUpgradeSteps?: (ctx: { relayedInReady: boolean }) => Promise<{ events: ComputerUpgradeStepTrace[]; ack: () => Promise<void> }>;
  /**
   * After a `ready` without the receipt of a web upgrade still inside its
   * deadline: resolves with the installer's failure once its receipt appears,
   * or null. A rolled-back installer restarts this (old) service before it
   * writes the receipt, so that `ready` could not carry it.
   */
  watchComputerUpgradeOutcome?: () => Promise<{ requestId: string; outcome: string; reason: string } | null>;
  /** Durable managed-Computer operation acknowledgements waiting for receipt. */
  getComputerLifecycleAcks?: () => ComputerLifecycleExecutionAck[];
  /** Fresh, async machine attestation used only for ready-phase evidence. */
  getComputerLifecycleReadyAcks?: () => Promise<ComputerLifecycleExecutionAck[]>;
  /** Remove one phase only after the server confirms it was reduced. */
  onComputerLifecycleReceipt?: (operationId: string, phase: "shutdown" | "ready") => void | Promise<void>;
  /**
   * Runs after the first ready is written on this connection. A managed
   * Computer may durably adopt one exact legacy K receipt. A narrowly typed
   * ready-pending result is retried on this connection generation only;
   * adoption asks core to replay ready with the new acknowledgement.
   * Booleans remain accepted for older embedded callers.
   */
  reconcileComputerLifecycleOrigin?: () =>
    ComputerLifecycleOriginReconcileResult
    | Promise<ComputerLifecycleOriginReconcileResult>;
  /**
   * Hook for managed-Computer remote control. When this runner is launched
   * by a Computer service, the service passes this so a `computer:restart`
   * / `computer:upgrade` WS command is relayed to the Computer supervisor's
   * restart/upgrade IPC mutation.
   * Absent for a raw daemon → those commands are ignored (no-op).
   *
   * For `upgrade`, the handler receives a `ComputerControlContext` carrying
   * the triggering `requestId` and upstream emitters. The managed runner is a
   * transport relay only: its supervisor owns download/swap/restart and emits
   * progress back over local IPC for this live WS. On success the replacement
   * runner used to report `done` here; v2 reads the reconnect version instead. On failure the
   * relay reports `done{ok:false}` in place.
   */
  onComputerControl?: (action: "restart" | "upgrade", ctx: ComputerControlContext) => void | Promise<void>;
  /**
   * Advertise only when machine-wide controls relay to the Computer
   * supervisor. Older Computer builds handled the same wire command inside a
   * single runner and must not be mistaken for this stronger contract.
   */
  computerControlViaSupervisor?: boolean;
  /**
   * The Computer runner could not reach its service's IPC seam at start: the
   * ready frame says so (`COMPUTER_CAPABILITY_SERVICE_IPC_UNREACHABLE`) and the
   * server offers manual upgrade commands instead of the Upgrade button.
   */
  computerServiceIpcUnreachable?: boolean;
  /** Report a persisted restart request only after this new runner generation
   * has connected and sent ready. The hook owns marker read/clear. */
  onComputerRestartReconcile?: (
    emitDone: (done: { requestId: string; ok: boolean; error?: string }) => void,
  ) => void | Promise<void>;
  /** Test seam; production collectors keep credentials and raw provider responses local. */
  runtimeAccountUsageCollector?: RuntimeAccountUsageCollector;
  /** Test seam for spending a limit reset; production redeems through OAR. */
  runtimeLimitResetRedeemer?: RuntimeLimitResetRedeemer;
  /** Test seam for reading the resets an account holds; production inspects through OAR (Claude). */
  runtimeLimitResetsReader?: RuntimeLimitResetsReader;
  /** Test seam: the platform the capabilities are advertised for; production is the host's. */
  platform?: NodeJS.Platform;
  /** task #17: web login / logout through OAR (injectable for tests). */
  runtimeAuthHost?: RuntimeAuthHost;
  /** Test seam: one runtime's model detection; production asks the runtime's driver or its static list. */
  runtimeModelDetector?: (runtime: string) => Promise<RuntimeModelSourceOutcome>;
  /** Test seam: where the credential disk watch reads (a temp home, a fake timer); production uses the user's home. */
  credentialDiskWatch?: Pick<CredentialDiskWatchDeps, "baseEnv" | "homeDir" | "platform" | "cwd" | "setInterval" | "clearInterval" | "now">;
}

export type ComputerLifecycleOriginReconcileResult =
  | boolean
  | { status: "adopted"; operationId: string }
  | {
      status: "retryable_ready_pending";
      operationId: string;
      code: "computer_offline" | "computer_lifecycle_completion_ready_pending";
    }
  | { status: "not_adopted" };

const COMPUTER_LIFECYCLE_ORIGIN_RECONCILE_MAX_ATTEMPTS = 3;
const COMPUTER_LIFECYCLE_ORIGIN_RECONCILE_RETRY_MS = 50;

/**
 * Context handed to `onComputerControl`. For `upgrade` it carries the exact
 * target; the Computer launches the installer and reports nothing (v2).
 */
/** The Computer's start-time device session retire outcome (`deviceSessionRetire.ts`). */
export interface ComputerDeviceSessionRetireTrace {
  reason: string;
  deleted: boolean;
  keysTried: number;
  attempt: number;
  httpStatus?: number;
  logout?: "ok" | "failed";
}

/**
 * A machine-lock conflict another runner of this Computer met and exited on
 * (`runnerLockConflict.ts`): whether that daemon could read the owner pid's
 * start (null: its error did not say) and how old the owner's lock was, in
 * coarse days. Never a pid, a path or that server's id.
 */
export interface ComputerMachineLockConflictTrace {
  ownerStartReadable: boolean | null;
  lockAgeDays: string;
}

/** One remote-upgrade step from the Computer's step log (`remoteUpgradeTrace.ts`). */
export interface ComputerUpgradeStepTrace {
  requestId: string;
  step: string;
  outcome: "ok" | "failed" | "skipped";
  atMs: number;
  deliveredLateMs: number;
  afterDeadline: boolean;
  fromVersion?: string;
  targetVersion?: string;
  durationMs?: number;
  errorCode?: string;
  reason?: string;
  supervisor?: string;
  killMode?: string;
  bytes?: number;
  version?: string;
  phase?: string;
  via?: string;
  diagnostic?: string;
  startFailure?: string;
  startExitCode?: number;
  installerVersion?: string;
  receiptOutcome?: string;
  engineDiagnostic?: string;
  enginePhase?: string;
  engineOutcome?: string;
  engineReason?: string;
  lastStartSlot?: string;
  lastStartVersion?: string;
  lastStartSucceeded?: boolean;
  lastStartFailure?: string;
  lastStartExitCode?: number;
  afterReceipt?: boolean;
}

export interface ComputerControlContext {
  /** Send the Computer's pending upgrade steps now (the launching runner, before it is stopped). */
  flushUpgradeSteps?: () => void;
  /** Canonical lifecycle operation identifier. */
  operationId?: string;
  /** Remote upgrade v2: exact target the Server resolved; the installer runs against it. */
  targetVersion?: string;
  /** Echoes the triggering `computer:upgrade{requestId}`; undefined if the
   *  command carried none. */
  requestId?: string;
  /**
   * Reconciler step 13: the Server asked to wait for quiet agents first,
   * clamped to COMPUTER_UPGRADE_DRAIN_MAX_DEADLINE_MS. Only on a runner with
   * the drain channel (`computerUpgradeDrainPaths`).
   */
  drain?: ComputerUpgradeDrainRequest;
}

export interface MigrationTargetImportView {
  migrationId: string;
  migrationRef: string;
  migrationGeneration: string;
  state: string;
  sourceMachineId: string;
  targetMachineId: string;
  agentId: string;
  manifestPath: string | null;
  manifestSha256: string | null;
  canDriveTargetImport: true;
}

type AgentMigrationCancelMessage = Extract<ServerToMachineMessage, { type: "machine:migration:cancel" }>;

interface MigrationTransferRunState {
  lease: AgentMigrationTransportLeaseMessage;
  controller: AbortController;
  promise: Promise<void>;
  workspacePlacementStarted: boolean;
  workspacePlaced: boolean;
  flipCommitted: boolean;
}

interface MigrationCancellationMarker {
  schemaVersion: "agent-migration-cancel/v1";
  agentId: string;
  migrationId: string;
  migrationRef: string;
  transportGeneration: string;
  sessionId: string;
  finalWorkspacePath: string;
  workspacePlacementStarted: boolean;
  workspacePlaced: boolean;
  flipCommitted: boolean;
}

interface AppliedMigrationCancellationReceipt {
  schemaVersion: "agent-migration-cancel-receipt/v1";
  agentId: string;
  migrationId: string;
  migrationRef: string;
  transportGeneration: string;
  cancelGeneration: string;
  role: "source" | "target";
  outcome: "cleaned" | "stopped";
}

export function parseDaemonCliArgs(args: string[]): ParsedDaemonCliArgs | null {
  let serverUrl = "";
  let apiKey = "";
  let apiKeyFile = process.env.SLOCK_DAEMON_API_KEY_FILE ?? "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--server-url" && args[i + 1]) serverUrl = args[++i];
    if (args[i] === "--api-key" && args[i + 1]) apiKey = args[++i];
    if (args[i] === "--api-key-file" && args[i + 1]) apiKeyFile = args[++i];
  }

  if (!apiKey && apiKeyFile) {
    try {
      apiKey = readSecretFileSync(apiKeyFile);
    } catch {
      apiKey = "";
    }
  }

  if (!serverUrl || !apiKey) return null;
  return { serverUrl, apiKey };
}

function readBakedDaemonVersion(): string | undefined {
  return typeof __RAFT_DAEMON_VERSION__ === "string" ? __RAFT_DAEMON_VERSION__ : undefined;
}

export function readDaemonVersion(
  moduleUrl: string = import.meta.url,
  bakedVersion: unknown = readBakedDaemonVersion(),
): string {
  // Computer SEA builds inline daemon core and have no daemon package.json at
  // runtime. The native bundler replaces an otherwise-absent identifier with
  // the daemon package version. Runtime environment variables cannot override
  // the package or baked process identity.
  const baked = bakedVersion;
  if (typeof baked === "string" && baked.length > 0) return baked;
  try {
    const require = createRequire(moduleUrl);
    return require("../package.json").version as string;
  } catch {
    return "0.0.0-dev";
  }
}

/**
 * Resolve the absolute path to the bundled `slock` cli entry script.
 * The CLI dist is copied into the daemon's own dist/cli/ during build,
 * so it ships inside the daemon package — no external @botiverse/raft
 * resolution needed at install time. This path is injected into agent
 * processes as `SLOCK_CLI_BIN` so the agent can invoke it via Bash
 * without depending on PATH.
 */
export function resolveRaftCliPath(moduleUrl: string = import.meta.url): string {
  const thisDir = path.dirname(fileURLToPath(moduleUrl));
  const bundledDistPath = path.resolve(thisDir, "cli", "index.js");

  try {
    accessSync(bundledDistPath);
    return bundledDistPath;
  } catch {
    const workspaceDistPath = path.resolve(thisDir, "..", "..", "cli", "dist", "index.js");
    accessSync(workspaceDistPath);
    return workspaceDistPath;
  }
}

/**
 * Non-fatal wrapper around {@link resolveRaftCliPath} for the constructor's
 * eager resolution. Returns "" when the CLI dist can't be located on disk
 * (e.g. SEA single-binary), deferring the hard requirement to agent-spawn time
 * where cliTransport throws a precise "slockCliPath is required" error. Lets
 * the daemon construct + connect + report ready regardless.
 */
export function resolveRaftCliPathOrEmpty(moduleUrl: string = import.meta.url): string {
  try {
    return resolveRaftCliPath(moduleUrl);
  } catch {
    return "";
  }
}

export { runBundledRaftCli } from "./bundledRaftCli";

/** task #1268: one runtime's outcome, reported as the round progresses (the detection child streams these). */
export interface RuntimeDetectionCheckedRuntime {
  runtime: string;
  available: boolean;
  version?: string;
  diagnostic?: string;
  unavailableReason?: RuntimeProbeUnavailableReason;
}

export interface RuntimeDetectionHooks {
  onRuntimeChecked?: (checked: RuntimeDetectionCheckedRuntime) => void;
}

export function detectRuntimes(tracer: Tracer = noopTracer, hooks: RuntimeDetectionHooks = {}): RuntimeDetection {
  const ids: string[] = [];
  const versions: Record<string, string> = {};
  const diagnostics: Record<string, string> = {};
  const unavailableReasons: Record<string, RuntimeProbeUnavailableReason> = {};
  const span = tracer.startSpan("daemon.runtime.detect", {
    surface: "daemon",
    kind: "internal",
    attrs: {
      known_runtime_count: RUNTIMES.length,
    },
  });

  // A runtime that runs only on the OAR host is offered only where that host
  // runs: not on Windows, not with the OAR host disabled (oarAgentHost.ts).
  const oarOnlyRunnable = process.platform !== "win32" && isOarHostEnabled();
  for (const runtime of RUNTIMES) {
    const driver = getDriver(runtime.id);
    if (driver.oarOnly && !oarOnlyRunnable) {
      hooks.onRuntimeChecked?.({ runtime: runtime.id, available: false });
      span.addEvent("daemon.runtime.detect.checked", { runtime: runtime.id, outcome: "unavailable", reason: "oar_host_unavailable" });
      continue;
    }
    let probeErrorPresent = false;
    try {
      if (driver.probe) {
        const probe = driver.probe();
        if (!probe.available) {
          if (probe.version) versions[runtime.id] = probe.version;
          if (probe.diagnostic) diagnostics[runtime.id] = probe.diagnostic;
          if (probe.unavailableReason) unavailableReasons[runtime.id] = probe.unavailableReason;
          hooks.onRuntimeChecked?.({
            runtime: runtime.id,
            available: false,
            ...(probe.version ? { version: probe.version } : {}),
            ...(probe.diagnostic ? { diagnostic: probe.diagnostic } : {}),
            ...(probe.unavailableReason ? { unavailableReason: probe.unavailableReason } : {}),
          });
          span.addEvent("daemon.runtime.detect.checked", {
            runtime: runtime.id,
            outcome: "unavailable",
            version_present: Boolean(probe.version),
            diagnostic_present: Boolean(probe.diagnostic),
            ...(probe.diagnostic ? { diagnostic: probe.diagnostic } : {}),
            // task #1240: lookup phase/ms/budget/outcome, never values or paths.
            ...(probe.lookupTiming ? { lookup_timing: probe.lookupTiming } : {}),
            binary_path_present: false,
          });
          continue;
        }
        ids.push(runtime.id);
        if (probe.version) versions[runtime.id] = probe.version;
        if (probe.diagnostic) diagnostics[runtime.id] = probe.diagnostic;
        hooks.onRuntimeChecked?.({
          runtime: runtime.id,
          available: true,
          ...(probe.version ? { version: probe.version } : {}),
          ...(probe.diagnostic ? { diagnostic: probe.diagnostic } : {}),
        });
        span.addEvent("daemon.runtime.detect.checked", {
          runtime: runtime.id,
          outcome: "available",
          version_present: Boolean(probe.version),
          diagnostic_present: Boolean(probe.diagnostic),
          ...(probe.diagnostic ? { diagnostic: probe.diagnostic } : {}),
          ...(probe.lookupTiming ? { lookup_timing: probe.lookupTiming } : {}),
          binary_path_present: false,
        });
        continue;
      }
    } catch {
      // Fall through to legacy PATH probing. Detection should be best-effort.
      probeErrorPresent = true;
    }

    const detectionBinaries = [runtime.binary];
    let detectedByPath = false;
    for (const binary of detectionBinaries) {
      const resolved = resolveCommandOnPath(binary);
      if (!resolved) continue;

      ids.push(runtime.id);
      detectedByPath = true;
      const version = readCommandVersion(binary);
      if (version) {
        versions[runtime.id] = version;
      }
      hooks.onRuntimeChecked?.({ runtime: runtime.id, available: true, ...(version ? { version } : {}) });
      span.addEvent("daemon.runtime.detect.checked", {
        runtime: runtime.id,
        outcome: "available",
        version_present: Boolean(version),
        binary_path_present: true,
        probe_error_present: probeErrorPresent,
      });
      break;
    }
    if (!detectedByPath) {
      hooks.onRuntimeChecked?.({ runtime: runtime.id, available: false });
      span.addEvent("daemon.runtime.detect.checked", {
        runtime: runtime.id,
        outcome: "unavailable",
        version_present: false,
        binary_path_present: false,
        probe_error_present: probeErrorPresent,
      });
    }
  }

  span.end("ok", {
    attrs: {
      detected_runtime_count: ids.length,
    },
  });
  return {
    ids,
    versions,
    ...(Object.keys(diagnostics).length > 0 ? { diagnostics } : {}),
    ...(Object.keys(unavailableReasons).length > 0 ? { unavailableReasons } : {}),
  };
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

function formatChannelTarget(msg: ServerToMachineMessage & { type: "agent:deliver" }): string {
  return msg.message.channel_type === "dm"
    ? `dm:@${msg.message.channel_name}`
    : `#${msg.message.channel_name}`;
}

/** A runtime-auth request id as the server mints it: a short opaque string. */
function isRuntimeAuthRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function summarizeIncomingMessage(msg: ServerToMachineMessage): string {
  switch (msg.type) {
    case "machine:context":
      return `(machine=${msg.machineId}, server=${msg.serverId})`;
    case "agent:start":
      return `(agent=${msg.agentId}, runtime=${msg.config.runtime}, model=${msg.config.model}, session=${msg.config.sessionId || "new"}${msg.wakeMessage ? ", wake=true" : ""})`;
    case "agent:config":
      // Never the env or a credential: the runtime, model and revision only.
      return `(agent=${msg.agentId}, runtime=${msg.config?.runtime}, model=${msg.config?.model}, revision=${msg.revision})`;
    case "agent:stop":
      return `(agent=${msg.agentId})`;
    case "agent:wake:outcome":
      return `(agent=${msg.agentId}, wake=${msg.wakeRequestId.slice(0, 8)}, outcome=${msg.outcome}${msg.reason ? `, reason=${msg.reason}` : ""})`;
    case "agent:reset-workspace":
      return `(agent=${msg.agentId})`;
    case "agent:deliver":
      return `(agent=${msg.agentId}, seq=${msg.seq}, from=@${msg.message.sender_name}, target=${formatChannelTarget(msg)})`;
    case "agent:inbox:purge":
      return `(agent=${msg.agentId}, channels=${msg.channelIds.length}, reason=${msg.reason || "server_purge"})`;
    case "agent:runtime_profile:migration":
      return `(agent=${msg.agentId}, migration=${msg.migrationKey})`;
    case "agent:runtime_profile:daemon_release_notice":
      return `(agent=${msg.agentId}, notice=${msg.noticeKey})`;
    case "agent:workspace:list":
      return `(agent=${msg.agentId}, dir=${msg.dirPath || "."}, hidden=${msg.includeHidden ? "yes" : "no"})`;
    case "agent:workspace:read":
      return `(agent=${msg.agentId}, path=${msg.path})`;
    case "agent:skills:list":
      return `(agent=${msg.agentId}, runtime=${msg.runtime || "auto"}, req=${msg.requestId || "legacy"})`;
    case "agent:diagnostic:session_transcript":
      return `(agent=${msg.agentId})`;
    case "agent:diagnostic:feedback_transcript":
      return `(agent=${msg.agentId}, feedbackReportId=${msg.feedbackReportId})`;
    case "agent:activity_probe":
      return `(agent=${msg.agentId}, probe=${msg.probeId.slice(0, 8)}, purpose=${msg.purpose})`;
    case "agent:context_view_request":
      return `(agent=${msg.agentId}, request=${String(msg.requestId).slice(0, 12)})`;
    case "machine:workspace:delete":
      return `(directory=${msg.directoryName})`;
    case "machine:runtime_models:detect":
      return `(runtime=${msg.runtime}, req=${msg.requestId})`;
    case "machine:runtime_account_usage:refresh":
      return `(provider=${msg.provider}, reason=${msg.reason}, req=${msg.requestId})`;
    case "machine:runtime_account_usage:limit_reset:redeem":
      // Type only: the fields are checked after this line; the key is not logged.
      return "";
    case "machine:runtime_account_usage:limit_resets:read":
      return "";
    case "machine:runtimes:rescan":
      return "(rescan runtimes)";
    case "machine:runtime_auth:login:start":
    case "machine:runtime_auth:login:code":
    case "machine:runtime_auth:login:cancel":
    case "machine:runtime_auth:logout":
    case "machine:runtime_auth:providers":
    case "machine:runtime_auth:connect_provider":
      // Type only: the fields are checked after this line, and a code or a key is never written anywhere.
      return "";
    case "machine:migration:source_workspace_archive":
      return `(agent=${msg.agentId}, migration=${msg.migrationId})`;
    case "machine:migration_transport:lease":
      return `(agent=${msg.agentId}, migration_ref=${msg.migrationRef}, session=${msg.sessionId}, provider=${msg.provider}, role=${msg.role}, kind=${msg.transferKind})`;
    case "machine:migration:cancel":
      return `(agent=${msg.agentId}, migration_ref=${msg.migrationRef}, role=${msg.role}, disposition=${msg.disposition})`;
    case "reminder.upsert":
      return `(agent=${msg.agentId}, id=${msg.reminder.reminderId}, v${msg.reminder.version}, fireAt=${msg.reminder.fireAt})`;
    case "reminder.cancel":
      return `(agent=${msg.agentId}, id=${msg.reminderId}, v${msg.version})`;
    case "reminder.snapshot":
      return `(agent=${msg.agentId}, count=${msg.reminders.length})`;
    default:
      return "";
  }
}

type AgentStartMessage = Extract<ServerToMachineMessage, { type: "agent:start" }>;
type AgentDeliverMessage = Extract<ServerToMachineMessage, { type: "agent:deliver" }>;
type AgentStartAckMessage = Extract<MachineToServerMessage, { type: "agent:start:ack" }>;

/** RFC 071 outbox: the daemon refused this start locally; no process was created. */
class LocalStartRefusedError extends Error {
  constructor(readonly reason: AgentStartNotSpawnedReason) {
    super(reason === "terminal_failure_outcome_storage_blocked"
      ? RUNTIME_OUTCOME_STORAGE_BLOCKED_TEXT
      : AUTOMATIC_START_REFUSAL_TEXT);
    this.name = "LocalStartRefusedError";
  }
}

/**
 * Which buffered delivery may be promoted to the START WAKE MESSAGE, or -1 for none.
 *
 * A mention delivery must NEVER be chosen. The chosen delivery is SPLICED OUT of the replay list,
 * so it never passes through handleMessage — and handleMessage is where the mention occurrence
 * transitions (daemon_received / daemon_pending / daemon_drained) are emitted. A mention promoted
 * to wake message would therefore complete delivery while its occurrence stayed at
 * "recorded, never delivered": precisely the unrecoverable state this whole spine exists to remove.
 * Excluding mentions here is what keeps them on the instrumented path, not what withholds them —
 * they are still replayed, and the agent still starts, because agent:start is what triggers the
 * start, not the presence of a wake message.
 *
 * Extracted as a pure exported function on 2026-08-20 so it can be tested at all. @Hipp found
 * during review of #6700 that this clause was load-bearing and had NO test: deleting
 * `&& !delivery.mentionDelivery` would silently make mentions unrecoverable and nothing would go
 * red. It was untestable in place because reaching it needs a timing race against agent start,
 * and a flaky test here would be worse than none.
 */
export function selectWakeDeliveryIndex(deliveries: readonly AgentDeliverMessage[]): number {
  // task #26: server context is held, never a wake; it rides the start's first prompt.
  return deliveries.findIndex((delivery) => delivery.transient !== true && !delivery.mentionDelivery && !isServerContextMessage(delivery.message));
}

/** SLOCK_HOME values a DaemonCore set itself (it was not given one), so a later core does not take them as chosen. */
const slockHomesSetByDaemon = new Set<string>();

function raftHomeEnvIsExplicit(): boolean {
  if (process.env[RAFT_HOME_ENV]?.trim()) return true;
  const slockHome = process.env[SLOCK_HOME_ENV]?.trim();
  return Boolean(slockHome) && !slockHomesSetByDaemon.has(slockHome!);
}

/**
 * Whether a migration source may add `excludedIgnoredBySource` to its transfer
 * summary. Both ends must accept it: the Server (capability
 * `migration:backup-ignore-sources-v1`) and the target Computer, which parses the
 * control manifest with the same strict schema (the source lease's
 * `targetAcceptsIgnoreSources`; absent means an older target, so no).
 */
export function migrationSummaryMayReportIgnoreSources(
  serverAccepts: boolean,
  lease: Pick<AgentMigrationTransportLeaseMessage, "targetAcceptsIgnoreSources">,
): boolean {
  return serverAccepts && lease.targetAcceptsIgnoreSources === true;
}

/**
 * A feedback request's `sessionLookup`, read as untrusted JSON: null unless
 * it names a runtime and a model; a session id that is not a string, and any
 * env var the runtime's session directory does not depend on, is dropped.
 * Exported for tests.
 */
export function feedbackTranscriptSessionLookupFromFrame(value: unknown): FeedbackTranscriptSessionLookup | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  if (typeof frame.runtime !== "string" || !frame.runtime || typeof frame.model !== "string") return null;
  // Only the keys the runtime's session directory depends on, whatever was sent.
  const sessionHomeEnv = frame.sessionHomeEnv && typeof frame.sessionHomeEnv === "object" && !Array.isArray(frame.sessionHomeEnv)
    ? runtimeSessionHomeEnvVars(frame.runtime, frame.sessionHomeEnv as Record<string, unknown>)
    : null;
  return {
    runtime: frame.runtime,
    model: frame.model,
    sessionHomeEnv,
    sessionId: typeof frame.sessionId === "string" && frame.sessionId ? frame.sessionId : null,
  };
}

export class DaemonCore {
  private readonly options: DaemonCoreOptions;
  private readonly daemonVersion: string;
  private readonly daemonInstanceId = randomUUID();
  // When this runner is launched by a managed Computer service, the service
  // passes the Computer bundle version explicitly. Reported in `ready` so the
  // server can surface it distinctly from the underlying daemonVersion.
  private readonly computerVersion: string | null;
  private readonly computerBuildSha: string | null;
  private readonly slockCliPath: string;
  private readonly slockHome: string;
  private readonly raftHomeExplicit: boolean;
  /**
   * Archive requests are retried by the server (and a cross-disk copy can
   * outlive the server's 15s wait), so a retry for the same agent joins the
   * in-flight run instead of starting a second copy beside it.
   */
  private readonly migrationSourceArchiveRuns = new Map<string, {
    migrationId: string;
    run: Promise<AgentMigrationWorkspaceArchiveOutcome>;
  }>();
  private readonly agentsDataDir: string;
  // One-shot guard: rewrite stale per-agent opencli wrappers to the current
  // self-healing form on the first connect of this daemon process (a SEA
  // computer switch / daemon upgrade restarts the daemon → triggers this).
  private opencliWrappersRegenerated = false;
  private legacyBridgeArtifactsMigrated = false;
  private staleAgentTokensRemoved = false;
  private readonly runtimeDetector: () => RuntimeDetection;
  private readonly runtimeModelDetector: ((runtime: string) => Promise<RuntimeModelSourceOutcome>) | null;
  private readonly agentManager: AgentProcessManager;
  /**
   * Agent lifecycle (start, stop, deliver, probe, running/session queries):
   * the process manager alone, or it and the OAR host behind the RFC 060
   * router. Workspace, skills, diagnostics and profile surfaces stay on the
   * process manager.
   */
  private readonly agentHosts: AgentLifecycleHost;
  /** Reconciler step 13: a Computer runner's half of a drained web upgrade. */
  private readonly upgradeDrain: ComputerUpgradeDrainChannel | null;
  /** RFC 060: this daemon runs OAR launches and advertises `runtime-host:oar`. */
  private readonly oarHostEnabled: boolean;
  private readonly connection: DaemonConnection;
  private readonly runtimeOutcomeOutbox: RuntimeOutcomeOutbox;
  /** RFC 071 outbox: whether the current connection's server acknowledges outbox frames. */
  private serverAcksRuntimeOutcomes = false;
  /** RFC 071 outbox: `breakerGeneration` per accepted launch, echoed as `generation` (bounded per agent). */
  private readonly launchGenerations = new Map<string, Map<string, number>>();
  private readonly appScheduleClock: Clock;
  private readonly lifecycleOriginClock: Clock;
  private lifecycleOriginConnectionGeneration = 0;
  /** Runtimes from the last `ready`; the catalog push covers exactly these. */
  private lastReadyRuntimes: readonly string[] = [];
  /** Runtime ids + versions from the last `ready`; a change lifts the reconnect throttle. */
  private lastReadyRuntimeSignature = "";
  /** task #1268: capabilities from this connection's `machine:context` (authoritative); null until it arrives. */
  private serverContextCapabilities: Set<string> | null = null;
  /** task #1268: the in-flight detection round, bound to the connection generation that started it. */
  private detectionRound: DetectionRoundRecord | null = null;
  private detectionRoundSeq = 0;
  /**
   * task #1268: every ready publication (synchronous inventory, pending, final
   * round result) claims a ticket BEFORE its first await; `sendReadyFrame`
   * re-checks the ticket right before `connection.send`, so a frame prepared
   * earlier can never be sent after a newer inventory (a pending held by
   * lifecycle acks while a synchronous rescan completes would otherwise leave
   * the server pending forever).
   */
  private readyPublicationSeq = 0;
  /** task #1268: a rescan asked for while a round was running; one more round follows, never a parallel one. */
  private detectionRescanRequested = false;
  /**
   * Runtimes whose next catalog detection follows a sign-in change made from
   * the web (Pi's): its result replaces the server's list even when empty.
   */
  private readonly authoritativeCatalogRuntimes = new Set<string>();
  /** Runtime CLI versions from the last ready frame, by runtime id (for start traces). */
  private lastReadyRuntimeVersions: Record<string, string> = {};
  /** Serializes the runtime CLI version record writes (one detection at a time). */
  private runtimeCliVersionWrite: Promise<void> = Promise.resolve();
  private catalogPublishInFlight = false;
  private catalogPublishQueued: { force: boolean } | null = null;
  private lastCatalogPublish: { atMs: number; runtimeSignature: string } | null = null;
  private lastCatalogRoundStartMs: number | null = null;
  private lifecycleOriginRetryTimer: unknown = null;
  private readonly localScheduleRuntime: ReturnType<typeof createBuiltInLocalScheduleRuntime>;
  private readonly appInboxes = new Map<string, AgentAppInboxStore>();
  private migrationTransferLease: AgentMigrationTransportLeaseMessage | null = null;
  private readonly migrationTransferRuns = new Map<string, MigrationTransferRunState>();
  private tracer: Tracer;
  private readonly injectedTracer: boolean;
  private machineLock: DaemonMachineLockHandle | null = null;
  private observedServerId: string | null = null;
  private observedMachineId: string | null = null;
  private authenticatedMachineContext: { serverId: string; machineId: string } | null = null;
  private scopedAppStorageFactory: ScopedAppStorageFactory | null = null;
  private scopedAppStorageObserver: ScopedAppStorageObserver | null = null;
  private machineContextConflict = false;
  private localTraceSink: LocalRotatingTraceSink | null = null;
  private traceBundleUploader: DaemonTraceBundleUploader | null = null;
  /**
   * The trace upload URL the attached server named in `machine:context`, when
   * it passed the allowlist (traceUploadUrl.ts); null otherwise. One daemon
   * serves one server, so this is per server by construction.
   */
  private serverTraceUploadUrl: string | null = null;
  /** The server's `machine:context` said `privacyMode: true` (RAFT_PRIVACY_MODE on the server). */
  private serverPrivacyMode = false;
  /** Last rejection warned about, so a reconnect loop logs it once. */
  private warnedServerTraceUploadUrlRejection: ServerTraceUploadUrlRejection | null = null;
  private diskJanitor: { stop(): void } | null = null;
  /** Reconciler step 15: releases an invalid credential that changed on disk (credentialDiskWatch.ts). */
  private credentialDiskWatch: CredentialDiskWatch | null = null;
  /** #proj-raft-computer:#68: persisted login facts, opened with the machine lock (runtimeReadinessStore.ts). */
  private runtimeReadiness: RuntimeReadinessStore | null = null;
  /** The server reads `machine:runtime_readiness` (SERVER_CAPABILITY_RUNTIME_READINESS_V1). */
  private serverReadsRuntimeReadiness = false;
  private processMemoryReporter: { stop(): void } | null = null;
  /** `raft proc` jobs of this runner's agents (procJobs.ts); null on Windows (v1) or before the lock. */
  private procJobManager: ProcJobManager | null = null;

  /**
   * `raft proc` at stop: the manager's sweep ends and it writes the ledger no
   * more (the jobs keep running); the next start opens a new one, which adopts
   * them.
   */
  private async closeProcJobs(): Promise<void> {
    const manager = this.procJobManager;
    if (!manager) return;
    this.procJobManager = null;
    setAgentProcJobManager(null);
    await manager.close();
  }

  /** Stop every running `raft proc` job of the agent; never rejects. */
  private async stopProcJobsForAgent(agentId: string, reason: ProcStopReason): Promise<void> {
    const manager = this.procJobManager;
    if (!manager) return;
    await manager.stopAllForAgent(agentId, reason).then(
      (stopped) => {
        if (stopped > 0) logger.info(`[Agent ${agentId}] Stopped ${stopped} raft proc job(s) (${reason})`);
      },
      (error: unknown) => {
        logger.warn(`[Agent ${agentId}] Stopping raft proc jobs (${reason}) failed: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
  }
  private startedAtMs: number | null = null;
  private raftDiskFootprint: { atMs: number; value: Promise<RaftDiskFootprint> } | null = null;
  private diskStatusTimer: ReturnType<typeof setTimeout> | null = null;
  private machineStatusReportsEnabled = true;
  private memoryStatusTimer: ReturnType<typeof setTimeout> | null = null;
  /** Reconciler step 15: one pending re-detection after a local restart found a runtime missing. */
  private runtimeRedetectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly runtimeAbsentRedetectDelayMs: number;
  private readonly coreStartingAgentIds = new Set<string>();
  /** Reconciler step 11: the order of the configs the server sends each agent (shared with both hosts). */
  private readonly configRevisions: AgentConfigRevisions;
  private readonly coreStartPendingDeliveries = new Map<string, AgentDeliverMessage[]>();
  private readonly recentlyAckedDeliveryIds = new RecentDeliveryIds();
  private readonly acceptedStartDispatches = new Map<string, AgentStartAckMessage>();
  private readonly acceptingStartDispatches = new Map<string, Promise<AgentStartAckMessage>>();
  private readonly handledComputerControlOperationIds = new Set<string>();
  /** Serializes step-log flushes so one step is never sent twice. */
  private computerUpgradeStepFlush: Promise<void> = Promise.resolve();
  private computerUpgradeOutcomeWatch: Promise<void> | null = null;
  private lastReadyCarriedUpgradeReceipt = false;
  /** JSON of the installer repair hint this connection last told the server (`ready` or its own message). */
  private reportedInstallerRepairHint = "null";
  /** The late looks at the device session retire outcome (flushComputerDeviceSessionRetire), scheduled once per process. */
  private deviceSessionRetireFlushTimers = new Set<NodeJS.Timeout>();
  private deviceSessionRetireLateFlushesScheduled = false;
  /** This process already sent `ready.migratedFrom` (getComputerMigratedFrom). */
  private migratedFromSent = false;
  /** One change report at a time, so a stale read can never be sent after a newer one. */
  private installerRepairHintReport: Promise<void> = Promise.resolve();
  private readonly runtimeAccountUsageCollector: RuntimeAccountUsageCollector;
  private readonly runtimeLimitResetRedeemer: RuntimeLimitResetRedeemer;
  private readonly runtimeLimitResetsReader: RuntimeLimitResetsReader;
  private readonly platform: NodeJS.Platform;
  private readonly runtimeAuth: RuntimeAuthHost;
  /**
   * task #17: the runtimes whose auth status the server reads
   * (SERVER_CAPABILITY_RUNTIME_AUTH_V1: Claude Code and Codex; _V2: all), or
   * null when it reads none.
   */
  private serverRuntimeAuthRuntimes: readonly RuntimeAuthRuntime[] | null = null;
  /** The server answers `server:features:request` (SERVER_CAPABILITY_SERVER_FEATURES_V1). */
  private serverFeaturesCapable = false;
  /** Asks the server for its current flag-derived agent config fields (serverFeaturesRefresh.ts). */
  private readonly serverFeaturesRefresh: ServerFeaturesRefresh;
  /** The last ready inventory's runtime ids, for a status report once the server says it reads one. */
  private runtimeAuthInventory: string[] | null = null;
  /** Reconciler step 15: the server reads `machine:runtime_credentials:changed` (SERVER_CAPABILITY_RUNTIME_CREDENTIALS_CHANGED_V1). */
  private serverReadsRuntimeCredentialsChanged = false;
  /** Overlapping model / usage probes for the same key join one run instead of each spawning a CLI (probeGate.ts). Uncapped across keys so no probe waits past the server's request budget. */
  private readonly probeGate = new ProbeGate();
  private readonly runtimeModelCache = new RuntimeModelSourceCache(currentTimeMs);
  private static readonly START_DISPATCH_RECEIPT_CACHE_SIZE = 1_024;

  constructor(options: DaemonCoreOptions) {
    this.runtimeAbsentRedetectDelayMs = options.runtimeAbsentRedetectDelayMs ?? RUNTIME_ABSENT_REDETECT_DELAY_MS;
    this.options = options;
    this.daemonVersion = options.daemonVersion ?? readDaemonVersion();
    this.computerVersion = options.computerVersion?.trim() || null;
    this.computerBuildSha = options.computerBuildSha?.trim() || null;
    // Resolve eagerly but NON-FATALLY: the slock CLI path is only needed when
    // an agent actually spawns (cliTransport injects it + throws a clear error
    // if empty). A daemon must still be able to construct + connect + report
    // ready when the CLI dist isn't a resolvable sidecar file — e.g. a SEA
    // single-binary where the CLI is bundled into the executable, not on disk.
    // Crashing the whole runner at construction (pre-connect) was wrong.
    this.slockCliPath = options.slockCliPath ?? resolveRaftCliPathOrEmpty();
    // The runtime CLI record is machine state: write it only to a Raft home
    // someone chose (option or RAFT_HOME/SLOCK_HOME, as the Computer service
    // sets), never to a fallback a test or ad-hoc run landed on.
    this.raftHomeExplicit = Boolean(options.slockHome) || raftHomeEnvIsExplicit();
    this.slockHome = options.slockHome ? path.resolve(options.slockHome) : resolveRaftHome();
    if (!options.slockHome) {
      process.env[SLOCK_HOME_ENV] = this.slockHome;
      if (!this.raftHomeExplicit) slockHomesSetByDaemon.add(this.slockHome);
    }
    this.injectedTracer = Boolean(options.tracer);
    this.tracer = this.withDaemonTraceScope(options.tracer ?? noopTracer);
    this.runtimeDetector = options.runtimeDetector ?? (() => detectRuntimes(this.tracer));
    this.runtimeModelDetector = options.runtimeModelDetector ?? null;
    this.runtimeAccountUsageCollector = options.runtimeAccountUsageCollector
      ?? createRuntimeAccountUsageCollector({
        localAccountSlot: this.slockHome,
        collectorVersion: this.daemonVersion,
        now: currentTimeMs,
        // Without the Kimi Code CLI, Kimi Code's usage is read on the SDK its agents run on (#triage:#253).
        oar: {
          kimiSdkUsage: () => {
            const home = resolveKimiHome(ambientProcessEnv());
            return readKimiSdkUsage({
              status: () => readKimiCodeSignInStatus(home),
              getManagedUsage: async () => (await loadKimiSdkAuth(home)).getManagedUsage(),
            });
          },
        },
      });
    // OAR runs Claude Code's /limit-reset (one session at a time per process,
    // idempotency keys in memory) and reads usage itself right before a
    // command that could spend Claude's older 5-hour reset. When it refuses a
    // redeem for consent, usage read again here (a key of its own, so it never
    // joins an earlier read) tells the 5-hour wall from a kind the account
    // cannot use here yet.
    this.platform = options.platform ?? process.platform;
    let fiveHourChecks = 0;
    this.runtimeLimitResetRedeemer = options.runtimeLimitResetRedeemer ?? createRuntimeLimitResetRedeemer({
      fiveHourLimit: async () => {
        fiveHourChecks += 1;
        const snapshot = await this.probeGate.run(`runtime_account_usage_after_limit_reset_refusal:claude:${fiveHourChecks}`, () => this.runtimeAccountUsageCollector("claude"));
        return claudeFiveHourLimitOf(snapshot);
      },
    });
    this.runtimeLimitResetsReader = options.runtimeLimitResetsReader ?? createRuntimeLimitResetsReader();
    this.serverFeaturesRefresh = new ServerFeaturesRefresh({
      ...options.serverFeaturesRefresh,
      send: (requestId) => {
        logger.info(`[Daemon] Asking the server for its current features (request ${requestId.slice(0, 8)})`);
        this.connection.send({ type: "server:features:request", requestId });
      },
    });
    this.runtimeAuth = options.runtimeAuthHost ?? new RuntimeAuthHost({
      // Pi signs in through its provider facade (loadPiAuth), never a Runtime's login.
      loadRuntime: (id) => (id === "pi" ? Promise.reject(new Error("Pi signs in per provider")) : loadOarRuntime(id)),
      // Kimi Code signs in on the SDK its agents run on, not OAR's kimi (no Kimi Code CLI needed), in
      // the home they read. Its status reads the stored tokens: the SDK loads for a login or logout only.
      kimiStatus: () => readKimiCodeSignInStatus(resolveKimiHome(ambientProcessEnv())),
      loadKimiAuth: () => loadKimiSdkAuth(resolveKimiHome(ambientProcessEnv())),
      // The one runtime OAR has a provider settings facade for.
      loadProviderAuth: async (id) => (id === "qwen" ? loadOarQwenProviderAuth() : null),
      // Pi's sign-ins in the daemon's own Pi agent dir: the auth.json the Pi runtime's agents read
      // unless one sets its own PI_CODING_AGENT_DIR. Never Built-in Pi's (per agent).
      loadPiAuth: () => loadOarPiProviderAuth(piSignInPaths()),
      piDeviceId: piSignInDeviceId,
      // OpenCode 2's sign-ins through its own server, in the daemon's environment (the store its agents
      // read): one facade for the daemon's life, closed in stop(). `loopback: "refuse"`: the person signs
      // in from another machine, so a sign-in only a browser on this one could finish is refused up front.
      opencode: new OpencodeSignIn({
        loadRuntime: () => loadOarRuntime("opencode"),
        create: (installation) => loadOarOpencodeProviderAuth(installation, {
          timeoutMs: OPENCODE_SIGN_IN_TIMEOUT_MS,
          loginTimeoutMs: OPENCODE_LOGIN_TIMEOUT_MS,
          idleMs: OPENCODE_SIGN_IN_IDLE_MS,
          loopback: "refuse",
        }),
        now: currentTimeMs,
      }),
      // Pi's models are those of the providers it can sign in to: the picker follows a change.
      // Authoritative for Pi: signing out its last provider clears the server's model list.
      rescanModels: (runtime) => this.rescanRuntimes(runtime),
      send: (message) => this.connection.send(message),
      recordEvent: (name, attrs) => this.recordDaemonEvent(name, attrs),
      now: currentTimeMs,
      // A report runs only while a server that reads it is connected.
      serverReads: () => (this.connection.connected ? this.serverRuntimeAuthRuntimes : null),
      // #proj-raft-computer:#46 stop-gap: agents on the machine-shared login
      // stop waiting on the old account. The legacy host releases the
      // sign-in's provider limit in the ledger both hosts share, which ends
      // the OAR host's waits too; the OAR host keeps no auth state.
      onCredentialsChanged: (runtime, reason) => this.agentManager.noteRuntimeCredentialsChanged(runtime, reason),
    });
    this.appScheduleClock = options.reminderClock ?? systemClock;
    this.lifecycleOriginClock = options.connectionOptions?.clock ?? systemClock;

    let connection!: DaemonConnection;

    this.agentsDataDir = options.dataDir ?? resolveRaftHomePath("agents", this.slockHome);
    // RFC 071 outbox: one gate for every agent host's spawns and rebinds.
    const runtimeProcessGate: RuntimeProcessGate = {
      openProcess: (agentId: string, processInstanceId: string, spawnLaunchId: string | null) =>
        this.runtimeOutcomeOutbox.openProcess(agentId, processInstanceId, spawnLaunchId),
      processExitedLocally: (agentId: string, processInstanceId: string) =>
        this.runtimeOutcomeOutbox.processExitedLocally(agentId, processInstanceId),
      processNotStarted: (agentId: string, processInstanceId: string) =>
        this.runtimeOutcomeOutbox.processNotStarted(agentId, processInstanceId),
      startRefusal: (agentId: string, launchId: string | null, recoveryGrant: RecoveryGrant | null) =>
        this.runtimeOutcomeOutbox.startDecision(agentId, launchId, recoveryGrant),
      waitForCapability: () => this.runtimeOutcomeOutbox.waitForCapability(),
    };
    // Reconciler step 10b: one record of every agent's crash streaks and
    // resume failures, for both hosts (planExit.ts): an agent's exits on
    // either host count into the same streaks.
    const exitStreaks = new ExitStreaks();
    const agentManagerOptions = {
      exitStreaks,
      dataDir: this.agentsDataDir,
      serverUrl: options.serverUrl,
      defaultAgentEnvVarsProvider: options.defaultAgentEnvVarsProvider,
      slockCliPath: this.slockCliPath,
      slockHome: this.slockHome,
      tracer: this.tracer,
      daemonVersion: this.daemonVersion,
      daemonInstanceId: this.daemonInstanceId,
      computerVersion: this.computerVersion,
      // Feedback evidence uploads keep env > default (not the server's choice).
      // Local privacy mode only; a server's arrives later and is refused per request (feedback_transcript).
      workerUrl: resolveMachineTraceUploadUrl(process.env, options.serverUrl, options.privacyMode === true) ?? undefined,
      serverConnected: () => connection?.connected ?? false,
      // View Context keeps each server's data apart on a Raft home several
      // per-server daemons share; fail closed after a context conflict.
      connectedServerId: () => (this.machineContextConflict ? null : this.authenticatedMachineContext?.serverId ?? this.observedServerId),
      appInboxForAgent: (agentId: string) => this.getAgentAppInbox(agentId),
      // Lazy: the local app runtime is created after the agent manager.
      onAgentWorkingToIdle: (agentId: string) => this.localScheduleRuntime?.onAgentWorkingToIdle(agentId),
      onRuntimeAbsentLocalStop: (runtime: string) => this.scheduleRuntimeRedetectAfterAbsent(runtime),
      detectedRuntimeCliVersion: (runtimeId: string) => this.lastReadyRuntimeVersions[runtimeId],
      // RFC 071 outbox: every spawn/rebind first durably records the process as open.
      runtimeProcessGate,
      activitySnapshotPath: options.turnActivitySnapshotPath ?? null,
    };

    this.runtimeOutcomeOutbox = new RuntimeOutcomeOutbox({
      dir: options.runtimeOutcomeOutboxDir ?? path.join(this.agentsDataDir, RUNTIME_OUTCOME_OUTBOX_DIR_NAME),
      daemonInstanceId: this.daemonInstanceId,
      send: (msg) => connection.send(msg),
      fs: options.runtimeOutcomeOutboxFs,
      trace: (name, attrs, status) => this.recordDaemonEvent(name, attrs, status),
    });
    // RFC 071: the agent manager's evidence frames go through the durable
    // outbox (write-ahead, stop-and-wait); everything else is sent directly.
    const sendAgentFrame = (msg: MachineToServerMessage) => this.routeAgentManagerFrame(msg, connection);
    const agentManager = options.agentManagerFactory
      ? options.agentManagerFactory(sendAgentFrame, options.apiKey, agentManagerOptions)
      : new AgentProcessManager(sendAgentFrame, options.apiKey, agentManagerOptions);
    this.agentManager = agentManager;
    // A test stand-in for the manager may have none: then one of the core's own.
    this.configRevisions = agentManager.configRevisions ?? new AgentConfigRevisions();
    this.oarHostEnabled = options.oarHost ?? isOarHostEnabled();
    if (this.oarHostEnabled) {
      const oarHost = new OarAgentHost({
        dataDir: this.agentsDataDir,
        detectedRuntimeCliVersion: (runtimeId: string) => this.lastReadyRuntimeVersions[runtimeId],
        serverUrl: options.serverUrl,
        daemonApiKey: options.apiKey,
        slockCliPath: this.slockCliPath,
        slockHome: this.slockHome,
        daemonVersion: this.daemonVersion,
        computerVersion: this.computerVersion,
        sendToServer: sendAgentFrame,
        nextClientSeq: (agentId) => agentManager.nextClientSeq(agentId),
        daemonInstanceId: () => this.daemonInstanceId,
        buildSpawnConfig: (agentId, config) => agentManager.buildSpawnConfig(agentId, config),
        // Reconciler step 5: an OAR launch starts after the agent's stopped legacy process has exited.
        legacyRuntimeExited: (agentId, signal) => agentManager.runtimeExited?.(agentId, signal) ?? Promise.resolve(),
        runtimeProcesses: {
          opened: (agentId, launchId) => agentManager.noteOarRuntimeOpened?.(agentId, launchId),
          closed: (agentId) => agentManager.noteOarRuntimeClosed?.(agentId),
        },
        isStaleClaim: (claimed) => {
          const current = agentManager.currentConnectionEpochId;
          return Boolean(claimed && current && claimed !== current);
        },
        gate: runtimeProcessGate,
        launches: {
          take: (agentId) => agentManager.takeAcceptedLaunches(agentId),
          settleNotSpawned: (agentId, launchId, reason) => agentManager.settleServerStartNotSpawned(agentId, launchId, reason),
          settleRebound: (agentId, launchId, processInstanceId) => agentManager.settleServerStartRebound(agentId, launchId, processInstanceId),
        },
        appInboxForAgent: (agentId) => this.getAgentAppInbox(agentId),
        // The same idle hook as the legacy host's (built-in apps, created below).
        onAgentWorkingToIdle: (agentId) => this.localScheduleRuntime?.onAgentWorkingToIdle(agentId),
        contextView: {
          sessionStarted: (agentId, session, enabled) => agentManager.noteHostedContextViewSession?.(agentId, session, enabled),
          messageCommitted: (agentId, input) => agentManager.noteHostedMessageCommitted?.(agentId, input),
        },
        sendRuntimeProfileReport: (agentId, session, source) => agentManager.sendHostedRuntimeProfileReport(agentId, session, source),
        recordEvent: (name, attrs, status, parent) => this.recordDaemonEvent(name, attrs, status, parent),
        // #proj-raft-computer:#46: one provider-limit ledger for both hosts.
        providerLimits: agentManager.providerLimitLedger,
        // Reconciler step 7: one memory of the runtime each session started on, for both hosts.
        sessionSpecs: agentManager.sessionSpecs,
        // Reconciler step 11: one order of pushed configs (and held pushes), for both hosts.
        configRevisions: this.configRevisions,
        // Reconciler step 11c: an OAR spec stop's handback, read by the legacy host's refusal.
        specHandbacks: agentManager.specHandbacks,
        // Reconciler step 9: one stalled-replacement streak per agent, for both hosts.
        stalledReplacements: agentManager.stalledReplacementStreaks,
        // Reconciler step 10b: the same exit streaks (planExit.ts), for both hosts.
        exitStreaks: agentManager.exitStreaks,
        ...(options.openOarSession ? { openSession: options.openOarSession } : {}),
      });
      agentManager.setHostedSessions?.({
        get: (agentId) => oarHost.hostedSession(agentId),
        agentIds: () => oarHost.hostedAgentIds(),
      });
      this.agentHosts = new AgentHostRouter(agentManager, oarHost, {
        recordEvent: (name, attrs, status) => this.recordDaemonEvent(name, attrs, status),
        settleNotSpawned: (agentId, launchId, reason) => agentManager.settleServerStartNotSpawned(agentId, launchId, reason),
        releaseUnusedCredential: (agentId, config, launchId) => agentManager.releaseUnheldRunnerCredential(agentId, config, launchId),
      });
    } else {
      this.agentHosts = agentManager;
    }
    // Reconciler step 15: a terminal sign-in releases a held credential as a
    // web login does (B7 / B8 / B9). Runs only while a credential is held.
    if (agentManager.providerLimitLedger) {
      this.credentialDiskWatch = new CredentialDiskWatch({
        ledger: agentManager.providerLimitLedger,
        recordEvent: (name, attrs) => this.recordDaemonEvent(name, attrs),
        baseEnv: ambientProcessEnv,
        runSecurity: runSecurityCommand,
        ...options.credentialDiskWatch,
        // PR 3: a terminal sign-in lifts the server's sign-in pauses that no
        // held record here knows of any more (after a daemon restart).
        onSharedCredentialsChanged: (runtime) => { void this.reportSharedCredentialsChanged(runtime); },
      });
    }
    const upgradeDrainPaths = options.computerUpgradeDrainPaths ?? null;
    this.upgradeDrain = upgradeDrainPaths
      ? new ComputerUpgradeDrainChannel({
          paths: upgradeDrainPaths,
          hosts: this.agentHosts,
          connected: () => this.connection.connected,
          send: (frame) => this.connection.send(frame),
          recordEvent: (name, attrs) => this.recordDaemonEvent(name, attrs),
        })
      : null;

    this.localScheduleRuntime = createBuiltInLocalScheduleRuntime({
      agentsDataDir: this.agentsDataDir,
      clock: this.appScheduleClock,
      getInbox: (agentId) => this.getAgentAppInbox(agentId),
      notifyInbox: (agentId, item, notice) =>
        this.agentHosts.notifyAgentAppInbox(agentId, item, notice),
      cleanerMeasureRaftDiskFootprint: () => this.measureRaftDiskFootprintCached(),
      // Quota is read from Claude's rate_limit_event on the legacy host only;
      // agents on the OAR host have no reading (undefined).
      cleanerProviderQuota: (agentId) => this.agentManager.providerQuota?.quotaFor(agentId),
      idleNoticeFacts: (agentId) => this.agentHosts.idleNoticeFacts(agentId),
      deliverIdleNotice: (agentId, text) => this.agentHosts.deliverIdleNotice(agentId, text),
      send: (message) => connection.send(message),
      trace: (name, attrs, status) =>
        this.recordDaemonEvent(name, { ...attrs }, status),
      // Lazy lookup: this.tracer is replaced once the local trace sink is
      // installed, so the runtime must not capture the startup tracer.
      tracer: {
        startSpan: (name, spanOptions) => this.tracer.startSpan(name, spanOptions),
        emitEvent: (name, eventOptions) => this.tracer.emitEvent(name, eventOptions),
      },
    });
    // The Cleaner's .raftbackupignore reminder: an agent's own credential hit
    // a provider usage limit (a shared credential's hit is not attributed).
    agentManager.providerLimitLedger?.subscribe((change) => {
      if (change.kind === "recorded" && change.source.agentId) {
        this.localScheduleRuntime.noteProviderLimitHit(change.source.agentId);
      }
    });

    const connectionFactory = options.connectionFactory ?? ((connOptions: ConnectionOptions) => new DaemonConnection(connOptions));

    connection = connectionFactory({
      serverUrl: options.serverUrl,
      apiKey: options.apiKey,
      ...options.connectionOptions,
      onMessage: (msg) => this.handleMessage(msg),
      onConnect: () => this.handleConnect(),
      onDisconnect: () => this.handleDisconnect(),
      onHandshakeRejected: (event) => this.handleHandshakeRejected(event),
      onTraceEvent: (name, attrs, status, parent) => this.recordDaemonEvent(name, attrs, status, parent),
      // Lazy lookup for the same reason as the app runtime tracer above.
      tracer: {
        startSpan: (name, spanOptions) => this.tracer.startSpan(name, spanOptions),
        emitEvent: (name, eventOptions) => this.tracer.emitEvent(name, eventOptions),
      },
    });

    this.connection = connection;
    this.localScheduleRuntime.start();
  }

  private getAgentAppInbox(agentId: string): AgentAppInboxStore {
    if (this.machineContextConflict) {
      this.recordDaemonEvent("daemon.app_storage.access_denied", {
        app_id: "system.agent-inbox",
        outcome: "denied",
        reason: "machine_context_conflict",
      }, "error");
      throw new Error("agent app inbox unavailable after authenticated machine context conflict");
    }
    const storageFactory = this.scopedAppStorageFactory;
    if (!storageFactory) {
      this.recordDaemonEvent("daemon.app_storage.access_denied", {
        app_id: "system.agent-inbox",
        outcome: "denied",
        reason: "machine_context_missing",
      }, "error");
      throw new Error("agent app inbox unavailable before authenticated machine context");
    }
    let store = this.appInboxes.get(agentId);
    if (!store) {
      const legacyDisposition = storageFactory.quarantineLegacyFile(
        `agent-inbox/${agentId}.json`,
        "system.agent-inbox",
      );
      if (legacyDisposition === "quarantined") {
        this.recordDaemonEvent("daemon.app_storage.legacy_quarantined", {
          app_id: "system.agent-inbox",
          owner_agent_id_present: true,
          reason: "unscoped_owner_unknown",
        }, "error");
      }
      store = createAgentAppInboxStore({
        registry: this.localScheduleRuntime.inboxRegistry,
        storage: storageFactory.open({
          appId: "system.agent-inbox",
          agentId,
        }),
        beforeAck: (item) => this.localScheduleRuntime.beforeAck(agentId, item),
        beforeServerAuthorizedAck: (item) => this.localScheduleRuntime.beforeServerAuthorizedAck(agentId, item),
        ownerAgentId: agentId,
        trace: (name, attrs, status) =>
          this.recordDaemonEvent(name, attrs, status),
      });
      this.appInboxes.set(agentId, store);
    }
    return store;
  }

  private resolveMachineStateRoot(): string {
    if (this.options.machineStateDir) return this.options.machineStateDir;
    if (this.options.dataDir) return path.join(path.dirname(this.options.dataDir), "machines");
    return resolveDefaultMachineStateRoot();
  }

  private shouldEnableLocalTrace(): boolean {
    if (this.injectedTracer) return false;
    if (!this.options.localTrace) return false;
    return process.env.SLOCK_DAEMON_LOCAL_TRACE !== "0";
  }

  private resolveTraceJitter(): TraceJitter {
    if (process.env.SLOCK_DAEMON_TRACE_JITTER_DISABLED === "1") return NO_JITTER;
    const lockId = this.machineLock?.lockId;
    return lockId ? computeTraceJitter(lockId) : NO_JITTER;
  }

  /**
   * Where the Computer redirects this daemon's stdout/stderr
   * (`<home>/computer/servers/<serverId>/runner.log`, legacy
   * `server-runner.log`; see packages/computer/src/paths.ts). Mirrored here
   * rather than imported: the daemon must not depend on the Computer package,
   * and deployed Computers already write these paths, so tier 2 works without
   * a Computer release. Empty until the server has told us which server we
   * are attached to.
   */
  private runnerLogPathCandidates(): string[] {
    const serverId = this.authenticatedMachineContext?.serverId ?? this.observedServerId;
    if (!serverId || !/^[A-Za-z0-9_-]{1,128}$/.test(serverId)) return [];
    const serverDir = path.join(this.slockHome, "computer", "servers", serverId);
    return [path.join(serverDir, "runner.log"), path.join(serverDir, "server-runner.log")];
  }

  private installLocalTraceSink(machineDir: string): void {
    if (!this.shouldEnableLocalTrace()) return;
    const jitter = this.resolveTraceJitter();
    this.localTraceSink = new LocalRotatingTraceSink({
      machineDir,
      maxFileBytes: this.options.localTraceMaxFileBytes ?? readPositiveIntegerEnv("SLOCK_DAEMON_TRACE_MAX_FILE_BYTES", 5 * 1024 * 1024),
      maxFileAgeMs: this.options.localTraceMaxFileAgeMs ?? readPositiveIntegerEnv("SLOCK_DAEMON_TRACE_MAX_FILE_AGE_MS", 5 * 60 * 1000),
      maxFileAgeJitterMs: jitter.maxFileAgeJitterMs,
      maxFiles: this.options.localTraceMaxFiles ?? readPositiveIntegerEnv("SLOCK_DAEMON_TRACE_MAX_FILES", 8),
    });
    this.tracer = this.withDaemonTraceScope(createTraceClient({
      source: "daemon",
      sinks: [this.localTraceSink],
    }));
    this.agentHosts.setTracer(this.tracer);
    this.agentHosts.setCliTransportTraceDir(path.join(machineDir, "traces"));
    this.agentManager.setMachineDir(machineDir);
  }

  private installTraceBundleUploader(machineDir: string): void {
    if (!this.shouldEnableLocalTrace()) return;
    if (this.traceBundleUploader) return;

    // DISABLED=1 > SLOCK_DAEMON_TRACE_UPLOAD_URL > allowlisted server URL >
    // the attached server's default (traceUploadUrl.ts). `workerUrl` is the machine-level URL (env >
    // default) for the Computer's diagnostics markers; this runner's own
    // bundles follow the server it is attached to.
    if (process.env.SLOCK_DAEMON_TRACE_UPLOAD_DISABLED === "1") return;
    // Null on a server that is not Raft's (traceUploadUrl.ts): the uploader is
    // still installed, since that server may name an allowlisted receiver
    // later (`machine:context`); until then nothing is uploaded.
    const workerUrl = resolveMachineTraceUploadUrl(process.env, this.options.serverUrl, this.privacyModeOn());
    this.traceBundleUploader = new DaemonTraceBundleUploader({
      machineDir,
      serverUrl: this.options.serverUrl,
      apiKey: this.options.apiKey,
      workerUrl,
      runnerWorkerUrl: () => this.runnerTraceUploadTarget() ?? { url: workerUrl, serverProvided: false },
      privacyMode: () => this.privacyModeOn(),
      tracer: this.tracer,
      currentFileProvider: () => this.localTraceSink?.getCurrentFile() ?? null,
      sinkReportProvider: {
        drain: () => this.localTraceSink?.drainSinkReport() ?? null,
        noteUndelivered: () => this.localTraceSink?.noteAttrDropReportUndelivered(),
      },
      jitter: this.resolveTraceJitter(),
    });
    this.traceBundleUploader.start();
  }

  /** Upload target for this runner's own trace bundles (null when disabled). */
  private runnerTraceUploadTarget(): { url: string; serverProvided: boolean } | null {
    const resolved = resolveTraceUploadUrl({
      env: process.env,
      serverTraceUploadUrl: this.serverTraceUploadUrl,
      serverUrl: this.options.serverUrl,
      privacyMode: this.privacyModeOn(),
    });
    return resolved.url === null ? null : { url: resolved.url, serverProvided: resolved.source === "server" };
  }

  /** RAFT_PRIVACY_MODE: this daemon's own (DaemonCoreOptions.privacyMode) or its server's (`machine:context`). */
  private privacyModeOn(): boolean {
    return this.options.privacyMode === true || this.serverPrivacyMode;
  }

  /**
   * Take the server's `traceUploadUrl` from `machine:context`. Absent (older
   * server, or none configured) or rejected → not used, so the upload goes to
   * SLOCK_DAEMON_TRACE_UPLOAD_URL if set, else the default. A rejected value
   * is warned about once, by reason only.
   */
  private applyServerTraceUploadUrl(raw: unknown): void {
    if (raw === undefined || raw === null || this.machineContextConflict) {
      this.serverTraceUploadUrl = null;
      return;
    }
    const check = acceptServerTraceUploadUrl(raw, { serverUrl: this.options.serverUrl });
    if (check.ok) {
      if (check.url !== this.serverTraceUploadUrl) {
        logger.info(`[Daemon] Server names trace upload receiver ${check.url}`);
      }
      this.serverTraceUploadUrl = check.url;
      this.warnedServerTraceUploadUrlRejection = null;
      return;
    }
    this.serverTraceUploadUrl = null;
    if (this.warnedServerTraceUploadUrlRejection !== check.reason) {
      this.warnedServerTraceUploadUrlRejection = check.reason;
      const fallback = resolveTraceUploadUrl({ env: process.env, serverTraceUploadUrl: null, serverUrl: this.options.serverUrl }).source;
      const using = fallback === "env" ? "SLOCK_DAEMON_TRACE_UPLOAD_URL"
        : fallback === "disabled" ? "nothing (uploads disabled)"
          : fallback === "none" ? "nothing (no receiver for this server)" : "the default receiver";
      logger.warn(`[Daemon] Ignoring the server's trace upload URL (${check.reason}); using ${using}`);
    }
  }

  /**
   * Bounded daily cleanup of Raft Computer's own migration data under
   * SLOCK_HOME (never agent workspaces). Several daemons may share one
   * SLOCK_HOME; every removal is idempotent.
   */
  private installDiskJanitor(): void {
    if (this.diskJanitor || process.env.SLOCK_DAEMON_DISK_JANITOR_DISABLED === "1") return;
    this.diskJanitor = scheduleRaftDiskJanitor({ pass: () => this.runDiskJanitorPass() });
  }

  private async runDiskJanitorPass(): Promise<void> {
    const startedAtMs = currentTimeMs();
    try {
      const result = await runRaftDiskJanitor({ slockHome: this.slockHome });
      for (const removal of result.backupsRemoved) {
        this.recordDaemonEvent("daemon.disk_janitor.backup_removed", {
          owner_agent_id: removal.ownerAgentId,
          backup_kind: removal.backupKind,
          age_days: removal.ageDays,
          freed_bytes: removal.freedBytes,
        });
      }
      // A fresh measurement after the sweep, so reports compare before/after.
      this.raftDiskFootprint = null;
      const footprint = await this.measureRaftDiskFootprintCached();
      this.recordDaemonEvent("daemon.disk_janitor.run", {
        outcome: "ok",
        migration_generations_cleaned: result.migrationGenerationsCleaned,
        migration_freed_bytes: result.migrationFreedBytes,
        backups_removed: result.backupsRemoved.length,
        backups_freed_bytes: result.backupsFreedBytes,
        sweep_outcome: result.sweepOutcome,
        duration_ms: currentTimeMs() - startedAtMs,
        ...footprint,
      });
    } catch (error) {
      this.recordDaemonEvent("daemon.disk_janitor.run", {
        outcome: "failed",
        error_class: errorClassOf(error),
        duration_ms: currentTimeMs() - startedAtMs,
      }, "error");
    }
  }

  /** One bounded walk per hour at most, shared by every caller. */
  private measureRaftDiskFootprintCached(): Promise<RaftDiskFootprint> {
    const nowMs = currentTimeMs();
    if (this.raftDiskFootprint && nowMs - this.raftDiskFootprint.atMs < 60 * 60 * 1_000) {
      return this.raftDiskFootprint.value;
    }
    const value = measureRaftDiskFootprint(this.slockHome);
    this.raftDiskFootprint = { atMs: nowMs, value };
    value.catch(() => {
      if (this.raftDiskFootprint?.value === value) this.raftDiskFootprint = null;
    });
    return value;
  }

  start() {
    logger.info("[Slock Daemon] Starting...");
    applyDaemonConnectAttemptTimeout();
    void hostFacts();
    // The shared contract schemas stay lazy here (built on first use). Do not
    // warm them: the daemon parses only a handful, and building all of them
    // costs every runner ~38 MB of heap. Broken schemas are caught by
    // shared's lazySchema tests and the server's startup warm.
    // RFC 071: reload un-acked evidence; it is resent with its original identities.
    this.runtimeOutcomeOutbox.load();
    logger.info(`[Slock Daemon] ${SLOCK_HOME_ENV}=${this.slockHome}`);
    for (const legacy of listLegacyRaftStatePaths(this.slockHome)) {
      logger.warn(
        `[Slock Daemon] Legacy Slock state exists outside ${SLOCK_HOME_ENV}: ${legacy.path}. ` +
          `This daemon will use ${legacy.destination}; migrate manually if that ${legacy.description} should move with this installation.`,
      );
    }
    assertLegacyDaemonKeyNotAdoptedByComputer({
      slockHome: this.slockHome,
      apiKey: this.options.apiKey,
    });
    let lifecycleSpan: ActiveSpan | null = null;
    if (!this.machineLock) {
      // The trace sink only exists after the lock is taken, so the start time
      // is captured first and given to the span once the sink is ready.
      const startTimeMs = currentTimeMs();
      this.startedAtMs = startTimeMs;
      this.machineLock = acquireDaemonMachineLock({
        apiKey: this.options.apiKey,
        serverUrl: this.options.serverUrl,
        rootDir: this.resolveMachineStateRoot(),
        ownerProvenance: this.options.machineOwnerProvenance,
      });
      logger.info(`[Slock Daemon] Acquired machine lock: ${this.machineLock.lockDir}`);
      // Reconciler step 5: the runtime process ledger and the orphan sweep
      // start with the lock, never behind the local-trace switch: runtimes
      // spawn detached either way, and nothing else reaps a crashed
      // daemon's runtimes. Starts wait for the sweep.
      this.agentManager.startRuntimeProcessLedger?.(this.machineLock.machineDir);
      this.openRuntimeReadiness(this.machineLock.machineDir);
      // `raft proc` (#proj-raft-computer:#59): the jobs' ledger sits next to
      // the runtime ledger; jobs a previous daemon left running are adopted
      // (the sweep above skips them). Not on Windows in v1.
      if (process.platform !== "win32" && !this.procJobManager) {
        this.procJobManager = ProcJobManager.start({
          machineDir: this.machineLock.machineDir,
          trace: (name, attrs, status) => this.recordDaemonEvent(name, attrs, status),
          runtimeRoots: (agentId) => this.agentManager.runtimeProcessesForAgent?.(agentId) ?? [],
        });
        this.agentManager.setProcJobPidFilter?.((pid) => this.procJobManager?.ownsPid(pid) ?? false);
        setAgentProcJobManager(this.procJobManager);
      }
      this.installLocalTraceSink(this.machineLock.machineDir);
      this.installTraceBundleUploader(this.machineLock.machineDir);
      this.installDiskJanitor();
      this.processMemoryReporter = startProcessMemoryReporter({
        clock: this.appScheduleClock,
        trace: (attrs) => this.recordDaemonEvent("daemon.process.memory", attrs),
        context: () => ({
          process_instance_id: this.daemonInstanceId,
          ...this.agentManager.getRunningAgentLoad(),
          // RFC 060: agents on the OAR host count too (their runtimes are daemon children).
          agents_running: this.agentHosts.getRunningAgentIds().length,
          ...serviceMemoryAttrs(this.options.serviceMemorySamplePath, this.appScheduleClock.now()),
          ...piSessionMemoryAttrs(this.appScheduleClock.now()),
        }),
        samplePath: this.options.processMemorySamplePath ?? null,
        onWriteError: (error) => logger.warn(`[Slock Daemon] Could not write the memory sample: ${String(error)}`),
      });
      lifecycleSpan = this.tracer.startSpan("daemon.lifecycle.start", {
        surface: "daemon",
        kind: "internal",
        startTimeMs,
        attrs: {
          machine_dir_present: true,
          local_trace_enabled: this.shouldEnableLocalTrace(),
        },
      });
      lifecycleSpan.addEvent("daemon.machine_lock.acquired", { machine_dir_present: true });
      const reclaimed = this.machineLock.reclaimed;
      if (reclaimed) {
        this.recordDaemonEvent("daemon.machine_lock.reclaimed", {
          reason: reclaimed.reason,
          platform: reclaimed.platform,
          ...(reclaimed.identitySource ? { identity_source: reclaimed.identitySource } : {}),
        }, "ok", lifecycleSpan.context);
      }
    }
    this.upgradeDrain?.start();
    try {
      this.connection.connect();
    } catch (err) {
      this.upgradeDrain?.stop();
      lifecycleSpan?.end("error", { attrs: { error_class: errorClassOf(err) } });
      this.traceBundleUploader?.stop();
      this.traceBundleUploader = null;
      this.processMemoryReporter?.stop();
      this.processMemoryReporter = null;
      this.machineLock.release();
      this.machineLock = null;
      throw err;
    }
    lifecycleSpan?.end("ok");
  }

  async stop(options: DaemonStopOptions = {}) {
    // Every login stopped, and OpenCode's sign-in server with them (its own watchdog is the backstop).
    await this.runtimeAuth.close();
    this.serverFeaturesRefresh.reset();
    // task #1268: a detection child must not outlive the daemon.
    this.abandonDetectionRound("stop");
    logger.info("[Slock Daemon] Shutting down...");
    const shutdownReason = this.resolveMachineShutdownReason();
    const span = this.tracer.startSpan("daemon.lifecycle.stop", {
      surface: "daemon",
      kind: "internal",
      attrs: {
        machine_lock_present: Boolean(this.machineLock),
        shutdown_reason: shutdownReason,
        // A run of short uptimes is a restart loop (signal-driven exits never
        // reach the Computer's crash budget, so nothing else surfaces it).
        stop_source: options.source ?? "unspecified",
        ...(options.signal ? { stop_signal: options.signal } : {}),
        ...(this.startedAtMs !== null ? { uptime_ms: currentTimeMs() - this.startedAtMs } : {}),
      },
    });
    this.localScheduleRuntime.stop();
    this.upgradeDrain?.stop();
    this.invalidateLifecycleOriginReconcile();
    this.scopedAppStorageObserver?.stop();
    this.scopedAppStorageObserver = null;
    this.traceBundleUploader?.stop();
    this.traceBundleUploader = null;
    this.processMemoryReporter?.stop();
    this.processMemoryReporter = null;
    this.diskJanitor?.stop();
    this.diskJanitor = null;
    this.credentialDiskWatch?.stop();
    this.credentialDiskWatch = null;
    this.runtimeReadiness?.close();
    this.runtimeReadiness = null;
    this.machineStatusReportsEnabled = false;
    if (this.diskStatusTimer !== null) clearTimeout(this.diskStatusTimer);
    this.diskStatusTimer = null;
    if (this.runtimeRedetectTimer !== null) clearTimeout(this.runtimeRedetectTimer);
    this.runtimeRedetectTimer = null;
    if (this.memoryStatusTimer !== null) clearTimeout(this.memoryStatusTimer);
    this.memoryStatusTimer = null;
    for (const timer of this.deviceSessionRetireFlushTimers) clearTimeout(timer);
    this.deviceSessionRetireFlushTimers.clear();
    try {
      // A graceful stop stores every exit (closing the open-launch records) before the outbox stops.
      await this.agentHosts.stopAll();
      span.addEvent("daemon.agents.stopped");
    } finally {
      this.runtimeOutcomeOutbox.stop();
      if (this.connection.connected) {
        const lifecycleAcks = this.options.getComputerLifecycleAcks?.()
          .filter((ack) => ack.phase === "shutdown");
        this.connection.send({
          type: "machine:shutdown",
          reason: shutdownReason,
          ...(lifecycleAcks && lifecycleAcks.length > 0 ? { lifecycleAcks } : {}),
        });
        span.addEvent("daemon.connection.shutdown_notice_sent", {
          outcome: "sent",
          shutdown_reason: shutdownReason,
        });
      } else {
        span.addEvent("daemon.connection.shutdown_notice_sent", {
          outcome: "skipped",
          reason: "not_connected",
          shutdown_reason: shutdownReason,
        });
      }
      this.connection.disconnect();
      span.addEvent("daemon.connection.disconnect_requested");
      // The runtime process ledger is written in the machine dir: its last
      // updates land before the stop resolves and the lock is released.
      await this.agentManager.settleRuntimeProcessLedger?.();
      await this.closeProcJobs();
      this.machineLock?.release();
      if (this.machineLock) span.addEvent("daemon.machine_lock.released");
      this.machineLock = null;
      span.end("ok");
    }
  }

  private resolveMachineShutdownReason(): MachineShutdownReason {
    return this.computerVersion ? "computer_stop" : "daemon_stop";
  }

  get connected(): boolean {
    return this.connection.connected;
  }

  getRunningAgentIds(): string[] {
    return this.agentHosts.getRunningAgentIds();
  }

  /**
   * The Computer runner bounds its `stop({ source: "machine_key_revoked" })`
   * and exits 77 when it ends or the bound passes; it records how here, just
   * before the exit (the local trace sink writes synchronously).
   */
  recordMachineKeyRevokedStop(trace: MachineKeyRevokedStopTrace): void {
    this.recordDaemonEvent("daemon.machine_key.revoked_stop", {
      reason: trace.reason,
      outcome: trace.outcome,
      agent_count: trace.agentCount,
      remaining_agent_count: trace.remainingAgentCount,
      duration_ms: trace.durationMs,
      deadline_ms: trace.deadlineMs,
    }, trace.outcome === "stopped" ? "ok" : "error");
  }

  // Records a point in time fact as a trace event. The event attaches to the
  // given parent, or to the span that is active right now.
  /**
   * Send the Computer's device session retire outcome, if one waits. The
   * retire runs ~20 s after the service starts (after this runner's first
   * ready, usually) and may retry 10 min later, so this runs at every ready
   * and, once per process, a minute and 11 minutes after the first.
   */
  private flushComputerDeviceSessionRetire(): void {
    const collect = this.options.collectComputerDeviceSessionRetire;
    if (!collect) return;
    const flush = (): void => {
      void collect()
        .then((report) => {
          if (!report) return;
          this.recordDaemonEvent("daemon.computer.device_session_retire", {
            reason: report.reason,
            deleted: report.deleted,
            keys_tried: report.keysTried,
            attempt: report.attempt,
            ...(report.httpStatus !== undefined ? { http_status: report.httpStatus } : {}),
            ...(report.logout !== undefined ? { logout: report.logout } : {}),
          }, report.deleted ? "ok" : "error");
        })
        .catch(() => { /* best effort: the next start reports again */ });
    };
    flush();
    if (this.deviceSessionRetireLateFlushesScheduled) return;
    this.deviceSessionRetireLateFlushesScheduled = true;
    for (const delayMs of DEVICE_SESSION_RETIRE_LATE_FLUSHES_MS) {
      const timer = setTimeout(() => {
        this.deviceSessionRetireFlushTimers.delete(timer);
        flush();
      }, delayMs);
      timer.unref?.();
      this.deviceSessionRetireFlushTimers.add(timer);
    }
  }

  /** Send the machine-lock conflicts other runners of this Computer exited on. */
  private flushComputerMachineLockConflicts(): void {
    const collect = this.options.collectComputerMachineLockConflicts;
    if (!collect) return;
    void collect()
      .then((conflicts) => {
        for (const conflict of conflicts) {
          this.recordDaemonEvent("daemon.machine_lock.conflict", {
            platform: process.platform,
            lock_age_days: conflict.lockAgeDays,
            ...(conflict.ownerStartReadable !== null ? { owner_start_readable: conflict.ownerStartReadable } : {}),
          }, "error");
        }
      })
      .catch(() => { /* best effort: claimed reports are gone, unclaimed ones go at the next ready */ });
  }

  /** Send the Computer's undelivered upgrade steps as trace events, then ack them. */
  private flushComputerUpgradeSteps(relayedInReady: boolean): Promise<void> {
    const collect = this.options.collectComputerUpgradeSteps;
    if (!collect) return Promise.resolve();
    this.computerUpgradeStepFlush = this.computerUpgradeStepFlush
      .then(async () => {
        const { events, ack } = await collect({ relayedInReady });
        for (const event of events) this.recordComputerUpgradeStep(event);
        await ack();
      })
      .catch((err) => {
        this.recordConnectLifecycleError("computer_upgrade_steps", "step_flush_threw", err);
      });
    return this.computerUpgradeStepFlush;
  }

  private recordComputerUpgradeStep(event: Omit<ComputerUpgradeStepTrace, "atMs">): void {
    this.recordDaemonEvent("daemon.computer_upgrade.step", {
      request_id: event.requestId,
      step: event.step,
      outcome: event.outcome,
      delivered_late_ms: event.deliveredLateMs,
      after_deadline: event.afterDeadline,
      ...(event.fromVersion !== undefined ? { from_version: event.fromVersion } : {}),
      ...(event.targetVersion !== undefined ? { target_version: event.targetVersion } : {}),
      ...(event.durationMs !== undefined ? { duration_ms: event.durationMs } : {}),
      ...(event.errorCode !== undefined ? { error_code: event.errorCode } : {}),
      ...(event.reason !== undefined ? { reason: event.reason } : {}),
      ...(event.supervisor !== undefined ? { supervisor: event.supervisor } : {}),
      ...(event.killMode !== undefined ? { kill_mode: event.killMode } : {}),
      ...(event.bytes !== undefined ? { bytes: event.bytes } : {}),
      ...(event.version !== undefined ? { version: event.version } : {}),
      ...(event.phase !== undefined ? { phase: event.phase } : {}),
      ...(event.via !== undefined ? { via: event.via } : {}),
      ...(event.diagnostic !== undefined ? { diagnostic: event.diagnostic } : {}),
      ...(event.startFailure !== undefined ? { start_failure: event.startFailure } : {}),
      ...(event.startExitCode !== undefined ? { start_exit_code: event.startExitCode } : {}),
      ...(event.installerVersion !== undefined ? { installer_version: event.installerVersion } : {}),
      ...(event.receiptOutcome !== undefined ? { receipt_outcome: event.receiptOutcome } : {}),
      ...(event.engineDiagnostic !== undefined ? { engine_diagnostic: event.engineDiagnostic } : {}),
      ...(event.enginePhase !== undefined ? { engine_phase: event.enginePhase } : {}),
      ...(event.engineOutcome !== undefined ? { engine_outcome: event.engineOutcome } : {}),
      ...(event.engineReason !== undefined ? { engine_reason: event.engineReason } : {}),
      ...(event.lastStartSlot !== undefined ? { last_start_slot: event.lastStartSlot } : {}),
      ...(event.lastStartVersion !== undefined ? { last_start_version: event.lastStartVersion } : {}),
      ...(event.lastStartSucceeded !== undefined ? { last_start_succeeded: event.lastStartSucceeded } : {}),
      ...(event.lastStartFailure !== undefined ? { last_start_failure: event.lastStartFailure } : {}),
      ...(event.lastStartExitCode !== undefined ? { last_start_exit_code: event.lastStartExitCode } : {}),
      ...(event.afterReceipt !== undefined ? { after_receipt: event.afterReceipt } : {}),
    }, event.outcome === "failed" ? "error" : "ok");
  }

  /** The upgrade's terminal frame reached the socket: the last step this side can see. */
  private recordComputerUpgradeReported(requestId: string, via: string, sent: boolean): void {
    this.recordComputerUpgradeStep({
      requestId,
      step: "reported",
      outcome: sent ? "ok" : "failed",
      deliveredLateMs: 0,
      afterDeadline: false,
      via,
      ...(sent ? {} : { errorCode: "socket_not_connected" }),
    });
  }

  /**
   * One watch per process: a restored (rolled-back) service connects before the
   * installer writes its receipt, so report the receipt when it appears.
   */
  private startComputerUpgradeOutcomeWatch(): void {
    const watch = this.options.watchComputerUpgradeOutcome;
    if (!watch || this.computerUpgradeOutcomeWatch) return;
    this.computerUpgradeOutcomeWatch = Promise.resolve()
      .then(() => watch())
      .then((failure) => {
        if (!failure) return;
        const sent = this.connection.connected;
        if (sent) {
          this.connection.send({
            type: "computer:upgrade:done",
            requestId: failure.requestId,
            ok: false,
            code: failure.outcome === "rolled_back" ? "upgrade_rolled_back" : "upgrade_installer_failed",
            reason: failure.reason.replace(/[\u0000-\u001f\u007f]+/gu, " ").slice(0, 2048),
          });
        }
        this.recordComputerUpgradeReported(failure.requestId, "late_receipt", sent);
        return this.flushComputerUpgradeSteps(false);
      })
      .catch((err) => {
        this.recordConnectLifecycleError("computer_upgrade_outcome_watch", "watch_threw", err);
      });
  }

  private recordDaemonEvent(
    name: string,
    attrs?: Record<string, unknown>,
    status: TraceStatus = "ok",
    parent?: TraceContext | null,
  ): void {
    this.tracer.emitEvent(name, {
      parent: parent ?? getActiveTraceContext(),
      surface: "daemon",
      attrs: { ...attrs, status },
    });
  }

  // Error-system boundary: the handleConnect/emitReady lifecycle hooks are
  // best-effort by design — a failed hook must never suppress the ready
  // report — but the failure's bounded identity still exits through a span
  // (closed site/reason + error_class), never only the logger.
  private recordConnectLifecycleError(site: string, reason: string, error: unknown): void {
    this.recordDaemonEvent("daemon.connect.lifecycle_error", {
      site,
      outcome: "error",
      reason,
      error_class: errorClassOf(error),
    }, "error");
  }

  private getMigrationTransportReady(): AgentMigrationTransportReady {
    return { ...this.getMigrationTransportReadyBase(), activeLeases: this.activeMigrationTransferLeases() };
  }

  /** Resumable transfer runs alive in this process; a restart empties this. */
  private activeMigrationTransferLeases(): NonNullable<AgentMigrationTransportReady["activeLeases"]> {
    const leases = new Map<string, NonNullable<AgentMigrationTransportReady["activeLeases"]>[number]>();
    for (const run of this.migrationTransferRuns.values()) {
      if (!run.lease.transportGeneration || run.controller.signal.aborted) continue;
      const entry = {
        migrationId: run.lease.migrationId,
        transportGeneration: run.lease.transportGeneration,
        role: run.lease.role,
      };
      leases.set(`${entry.migrationId}:${entry.transportGeneration}:${entry.role}`, entry);
    }
    return [...leases.values()];
  }

  private getMigrationTransportReadyBase(): AgentMigrationTransportReady {
    const transferLease = this.getActiveMigrationTransferLease();
    const capabilities = [...DAEMON_MIGRATION_TRANSPORT_CAPABILITIES];
    if (transferLease) {
      return {
        provisioned: true,
        endpoint: null,
        leaseSource: "server",
        provider: transferLease.provider,
        role: transferLease.role,
        transferKind: transferLease.transferKind,
        expiresAt: transferLease.expiresAt,
        maxBytes: transferLease.maxBytes,
        capabilities,
        observedAt: currentDate().toISOString(),
      };
    }

    return {
      provisioned: false,
      endpoint: null,
      leaseSource: null,
      capabilities,
      observedAt: currentDate().toISOString(),
    };
  }

  /**
   * Computer-scoped provider probe. The command carries no credential: the
   * daemon claims a one-time materialization with its own machine auth, runs
   * the bounded canary through the real provider adapter, and returns a
   * closed-category result. A claim failure still produces a failure result so
   * the Server never waits out the budget for a decidable carrier error.
   */
  private async handleProviderProbe(
    msg: Extract<ServerToMachineMessage, { type: "machine:provider_probe:request" }>,
  ): Promise<void> {
    const probeId = asProviderProbeId(msg.probeId);
    // Wave 1 only knows the Built-in canary adapter; a different runtime label
    // is a protocol violation and must never produce a Built-in receipt (F3).
    if (!isProviderProbeRuntime(msg.runtime)) {
      this.connection.send(await buildUnclaimedProviderProbeResult({
        requestId: msg.requestId,
        probeId,
      }));
      return;
    }
    let materialization: ProbeMaterialization;
    try {
      materialization = await claimProbeMaterialization({
        serverUrl: this.options.serverUrl,
        daemonApiKey: this.options.apiKey,
        probeId,
        claimRequestId: msg.requestId,
      });
    } catch {
      this.connection.send(await buildUnclaimedProviderProbeResult({
        requestId: msg.requestId,
        probeId,
      }));
      return;
    }
    const execution = await runProviderProbeCanary({ materialization, model: msg.model });
    this.connection.send(await buildProviderProbeResultMessage({
      requestId: msg.requestId,
      probeId,
      execution,
      authority: materialization.authority,
      daemonVersion: this.daemonVersion,
      computerVersion: this.computerVersion,
      runtimeVersion: PI_SDK_VERSION,
    }));
  }

  private getActiveMigrationTransferLease(): AgentMigrationTransportLeaseMessage | null {
    const lease = this.migrationTransferLease;
    if (!lease) return null;
    const expiresAtMs = Date.parse(lease.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= currentTimeMs()) return null;
    return lease;
  }

  private validateMigrationTransferLease(lease: AgentMigrationTransportLeaseMessage): void {
    if (!lease.agentId.trim()) throw new Error("migration transfer lease agent id is required");
    if (!lease.migrationId.trim()) throw new Error("migration transfer lease migration id is required");
    if (!/^mig_[A-Za-z0-9_-]{22}$/.test(lease.migrationRef)) throw new Error("migration transfer lease migrationRef is invalid");
    if (!lease.migrationGeneration.trim()) throw new Error("migration transfer lease migrationGeneration is required");
    if (!lease.sessionId.trim()) throw new Error("migration transfer lease session id is required");
    if (lease.provider !== "object_store") throw new Error(`unsupported migration transfer provider: ${lease.provider}`);
    if (lease.leaseSource !== "server") throw new Error(`unsupported migration transfer lease source: ${lease.leaseSource}`);
    if (lease.role !== "source" && lease.role !== "target") throw new Error(`unsupported migration transfer role: ${lease.role}`);
    if (lease.transferKind !== "upload" && lease.transferKind !== "download") {
      throw new Error(`unsupported migration transfer kind: ${lease.transferKind}`);
    }
    if (!lease.bearerToken.trim()) throw new Error("migration transfer lease bearer token is required");
    const expiresAtMs = Date.parse(lease.expiresAt);
    if (!lease.expiresAt.trim() || !Number.isFinite(expiresAtMs) || expiresAtMs <= currentTimeMs()) {
      throw new Error("migration transfer lease expiresAt must be a future timestamp");
    }
    if (!Number.isInteger(lease.maxBytes) || lease.maxBytes <= 0) {
      throw new Error("migration transfer lease maxBytes must be a positive integer");
    }
    if (
      !lease.controlUrl.trim()
      || !lease.leaseId.trim()
      || !lease.transportGeneration.trim()
      || !lease.sourceMachineId.trim()
      || !lease.targetMachineId.trim()
      || !Number.isSafeInteger(lease.expectedMigrationRevision)
    ) {
      throw new Error("MIGRATION_TRANSFER_LEASE_INVALID");
    }
  }

  private handleMigrationTransportLease(lease: AgentMigrationTransportLeaseMessage): void {
    const span = this.tracer.startSpan("daemon.migration_transport.lease", {
      surface: "daemon",
      kind: "internal",
    });
    try {
      const outcomeAttrs = this.applyMigrationTransferLease(lease, span.context);
      span.end("ok", { attrs: outcomeAttrs });
    } catch (err) {
      logger.error("[Slock Daemon] Failed to apply migration transport lease", err);
      span.end("error", {
        attrs: {
          outcome: "failed",
          lease_present: true,
          error_class: errorClassOf(err),
        },
      });
    }
  }

  // Applies the lease and returns the trace attrs that describe the outcome.
  private applyMigrationTransferLease(
    lease: AgentMigrationTransportLeaseMessage,
    leaseSpan: TraceContext,
  ): Record<string, unknown> {
    this.validateMigrationTransferLease(lease);
    if (
      this.migrationTransferLease?.agentId === lease.agentId
      && this.migrationTransferLease?.migrationId === lease.migrationId
      && this.migrationTransferLease?.migrationGeneration === lease.migrationGeneration
      && this.migrationTransferLease?.sessionId === lease.sessionId
      && this.migrationTransferLease?.role === lease.role
    ) {
      this.migrationTransferLease = lease;
      this.emitReadyIfConnected();
      this.startMigrationTransferRun(lease, leaseSpan);
      return {
        ...migrationTraceIdentityAttrs(lease, "lease"),
        outcome: "unchanged",
        agent_id_present: true,
        migration_id_present: true,
        session_id_present: true,
        migration_generation: lease.migrationGeneration,
        provider: lease.provider,
        role: lease.role,
        transfer_kind: lease.transferKind,
      };
    }

    this.migrationTransferLease = lease;
    this.emitReadyIfConnected();
    this.startMigrationTransferRun(lease, leaseSpan);
    return {
      ...migrationTraceIdentityAttrs(lease, "lease"),
      outcome: "applied",
      agent_id_present: true,
      migration_id_present: true,
      session_id_present: true,
      migration_generation: lease.migrationGeneration,
      provider: lease.provider,
      role: lease.role,
      transfer_kind: lease.transferKind,
      bearer_token_present: Boolean(lease.bearerToken),
    };
  }

  private startMigrationTransferRun(lease: AgentMigrationTransportLeaseMessage, leaseSpan: TraceContext): void {
    const key = [
      lease.agentId,
      lease.migrationId,
      lease.migrationGeneration,
      lease.sessionId,
      lease.role,
      lease.transportGeneration,
    ].join(":");
    if (this.migrationTransferRuns.has(key)) return;
    const controller = new AbortController();
    const run: MigrationTransferRunState = {
      lease,
      controller,
      promise: Promise.resolve(),
      workspacePlacementStarted: false,
      workspacePlaced: false,
      flipCommitted: false,
    };
    // The transfer runs longer than the lease message that started it, so it
    // gets its own span. Stage events inside the transfer attach to it.
    const span = this.tracer.startSpan("daemon.migration_transport.transfer", {
      parent: leaseSpan,
      surface: "daemon",
      kind: "internal",
      attrs: {
        ...migrationTraceIdentityAttrs(lease, "transfer"),
        ...(lease.role === "target" ? { download_concurrency: MIGRATION_TARGET_CHUNK_DOWNLOAD_CONCURRENCY } : {}),
      },
    });
    const promise = runWithActiveSpan(span, () => this.runMigrationTransferLease(lease, run))
      .then(() => {
        span.end("ok");
      })
      .catch(async (err: unknown) => {
        if (controller.signal.aborted) {
          span.end("cancelled", { attrs: { outcome: "canceled" } });
          this.recordDaemonEvent("daemon.migration_transport.object_store", {
            ...migrationTraceIdentityAttrs(lease, "transfer"),
            outcome: "canceled",
          }, "ok", span.context);
          return;
        }
        span.end("error", { attrs: { outcome: "failed", error_class: errorClassOf(err) } });
        logger.error("[Slock Daemon] Migration object-store transfer failed", err);
        this.recordDaemonEvent("daemon.migration_transport.object_store", {
          ...migrationTraceIdentityAttrs(lease, "transfer"),
          outcome: "failed",
          agent_id_present: Boolean(lease.agentId),
          migration_id_present: Boolean(lease.migrationId),
          session_id_present: Boolean(lease.sessionId),
          error_class: errorClassOf(err),
          ...migrationObjectStoreFailureTraceAttrs(err),
        }, "error", span.context);
        try {
          await this.reportMigrationTransportLost(lease, err);
        } catch (reportErr) {
          logger.error("[Slock Daemon] Failed to report migration transport loss", reportErr);
          this.recordDaemonEvent("daemon.migration_transport.object_store", {
            ...migrationTraceIdentityAttrs(lease, "transport_lost_report"),
            outcome: "transport_lost_report_failed",
            migration_id_present: Boolean(lease.migrationId),
            error_class: errorClassOf(reportErr),
          }, "error", span.context);
        }
      })
      .finally(() => {
        if (this.migrationTransferRuns.get(key) === run) this.migrationTransferRuns.delete(key);
      });
    run.promise = promise;
    this.migrationTransferRuns.set(key, run);
    void promise;
  }

  private async runMigrationTransferLease(
    lease: AgentMigrationTransportLeaseMessage,
    run: MigrationTransferRunState,
  ): Promise<void> {
    if (lease.role === "source") {
      await this.uploadResumableMigrationBundle(lease, run.controller.signal);
      return;
    }
    await this.downloadAndCommitResumableMigrationBundle(lease, run);
  }

  private migrationResumableControlUrl(
    lease: AgentMigrationTransportLeaseMessage,
    suffix: string,
  ): URL {
    // These requests carry the machine key: an absolute controlUrl on another
    // origin would send it there, so only this Computer's own server is used.
    const resolved = new URL(lease.controlUrl, this.options.serverUrl);
    if (resolved.origin !== new URL(this.options.serverUrl).origin) {
      throw new Error("MIGRATION_CONTROL_URL_CROSS_ORIGIN");
    }
    const base = resolved.toString().replace(/\/$/, "");
    return new URL(`${base}${suffix}`, this.options.serverUrl);
  }

  private migrationResumableControlHeaders(lease: AgentMigrationTransportLeaseMessage): Record<string, string> {
    return {
      ...this.internalComputerHeaders(),
      "X-Raft-Migration-Token": lease.bearerToken,
    };
  }

  /**
   * Throttled, fire-and-forget bundle-build progress for the server. Reports
   * never overlap and never fail the migration; a server without the endpoint
   * (404) disables reporting for this run. A report skipped by the throttle is
   * sent once the interval ends, so the latest counts are not lost before a
   * long quiet stretch.
   *
   * A user-ignore receipt rides the reports until one gets a non-5xx answer, and only to
   * a Server that advertises SERVER_CAPABILITY_MIGRATION_USER_IGNORE_RECEIPT_V1
   * (read per report; an older Server's strict schema rejects the field). For
   * such a Server the first report goes out at once, so the receipt does not
   * wait out the interval; any other Server gets exactly the old reports.
   */
  private createMigrationSourceProgressReporter(
    lease: AgentMigrationTransportLeaseMessage,
    signal: AbortSignal,
    userIgnoreReceipt: AgentMigrationUserIgnoreAdditionsReceipt | null = null,
  ): (progress: AgentMigrationExportProgress) => void {
    let unsentReceipt = userIgnoreReceipt;
    let lastSentAt = currentDate().getTime();
    let inFlight = false;
    let disabled = false;
    let pending: AgentMigrationExportProgress | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const clearFlush = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
    };
    signal.addEventListener("abort", clearFlush, { once: true });
    const send = (progress: AgentMigrationExportProgress) => {
      lastSentAt = currentDate().getTime();
      pending = null;
      clearFlush();
      inFlight = true;
      const receipt = unsentReceipt && this.serverAcceptsMigrationUserIgnoreReceipt() ? unsentReceipt : null;
      void daemonFetch(this.migrationResumableControlUrl(lease, "/source-progress"), {
        method: "POST",
        headers: {
          ...this.migrationResumableControlHeaders(lease),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          migrationGeneration: lease.transportGeneration,
          ...progress,
          ...(receipt ? { userIgnoreAdditions: receipt } : {}),
        }),
        signal,
      }).then((response) => {
        if (response.status === 404) disabled = true;
        // Any answer but a 5xx settles it; a Server that refuses the body must
        // not cost the run its progress reports. Network errors and 5xx retry.
        if (receipt && response.status < 500) {
          unsentReceipt = null;
          if (!response.ok) {
            this.recordDaemonEvent("daemon.migration_transport.user_ignore", {
              ...migrationTraceIdentityAttrs(lease, "user_ignore"),
              outcome: "receipt_refused",
              http_status: response.status,
              written_count: receipt.written,
              already_present_count: receipt.alreadyPresent,
              rejected_count: receipt.rejected.length,
            }, "error");
          }
        }
      }, () => undefined).finally(() => {
        inFlight = false;
      });
    };
    const report = (progress: AgentMigrationExportProgress) => {
      if (disabled || signal.aborted) return;
      const waitMs = lastSentAt + MIGRATION_SOURCE_PROGRESS_INTERVAL_MS - currentDate().getTime();
      if (inFlight || waitMs > 0) {
        pending = progress;
        if (!flushTimer) {
          flushTimer = setTimeout(() => {
            flushTimer = null;
            if (pending) report(pending);
          }, Math.max(waitMs, 1_000));
          flushTimer.unref?.();
        }
        return;
      }
      send(progress);
    };
    if (unsentReceipt && this.serverAcceptsMigrationUserIgnoreReceipt()) {
      send({ phase: "scanning", files: 0, bytes: 0 });
    }
    return report;
  }

  private async uploadResumableMigrationBundle(
    lease: AgentMigrationTransportLeaseMessage,
    signal: AbortSignal,
  ): Promise<void> {
    if (lease.transferKind !== "upload") throw new Error("MIGRATION_RESUMABLE_SOURCE_LEASE_INVALID");
    signal.throwIfAborted();
    const launchId = this.agentHosts.getAgentLaunchId(lease.agentId) ?? "none";
    const sessionId = this.agentHosts.getAgentSessionId(lease.agentId) ?? "none";
    await this.stopMigrationSourceAgent(lease, signal);
    if (this.agentHosts.getRunningAgentIds().includes(lease.agentId)) {
      throw new Error("MIGRATION_SOURCE_QUIESCE_FAILED");
    }
    const quiesceResponse = await daemonFetch(
      this.migrationResumableControlUrl(lease, "/source-quiesced"),
      {
        method: "POST",
        headers: {
          ...this.migrationResumableControlHeaders(lease),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          receipt: {
            schemaVersion: "agent-migration-quiesce/v1",
            migrationId: lease.migrationId,
            migrationGeneration: lease.transportGeneration,
            agentId: lease.agentId,
            sourceMachineId: lease.sourceMachineId,
            sourceRuntimeState: "stopped",
            stoppedAt: currentDate().toISOString(),
            actor: "migration",
            launchSessionIdentity: `launch:${launchId}:session:${sessionId}`,
            expectedRuntimeRevision: String(lease.expectedMigrationRevision),
          },
        }),
        signal,
      },
    );
    if (!quiesceResponse.ok) {
      throw await migrationStepResponseError(
        "MIGRATION_SOURCE_QUIESCE_REPORT_FAILED",
        quiesceResponse,
        "source_quiesce",
      );
    }

    const workspacePath = path.join(this.agentsDataDir, lease.agentId);
    // Before the export reads the ignore files, so it applies the new lines.
    const userIgnoreReceipt = await this.writeMigrationUserIgnoreAdditions(lease, workspacePath);
    signal.throwIfAborted();
    const streamed = await streamAgentMigrationResumableBundle({
      agentId: lease.agentId,
      migrationId: lease.migrationId,
      migrationGeneration: lease.transportGeneration,
      leaseId: lease.leaseId,
      sourceMachineId: lease.sourceMachineId,
      targetMachineId: lease.targetMachineId,
      workspacePath,
      maxBytes: lease.maxBytes,
      signal,
      onProgress: this.createMigrationSourceProgressReporter(lease, signal, userIgnoreReceipt),
      reportIgnoredBySource: () => migrationSummaryMayReportIgnoreSources(this.serverAcceptsMigrationIgnoreSources(), lease),
      uploadChunk: (chunk, bytes) => this.uploadStreamedMigrationChunk(lease, chunk, bytes, signal),
    });
    if (streamed.resizedEntryCount > 0) {
      logger.warn(
        `[Daemon] Migration ${lease.migrationRef}: ${streamed.resizedEntryCount} file(s) changed size while packing `
        + `and were cut or zero-padded to their listed size: ${streamed.resizedEntries.join(", ")}`,
      );
    }
    await this.registerAndCompleteResumableUpload(lease, streamed, signal);
  }

  /**
   * Reconciler step 14 (Q-H): the source stops the agent only once it is
   * quiet. The step 13 drain, for this agent only (AgentDrains): its new
   * deliveries and reminders are held, it is waited for until it is idle
   * (agentIdle.ts with `ignoreUntoldInbox`), at most until the lease's
   * `sourceDrainUntil` and AGENT_DRAIN_MAX_DEADLINE_MS, and then stopped as
   * before (stop·kill), with the hold still on. Its end hands nothing over
   * here: what was held went with the process and stays unread on the server
   * (the server queues a migrating agent's messages; the target answers them).
   * Control is never held: an owner's Stop during the wait stops it at once,
   * and the wait ends quiet at the next check.
   *
   * The migration cancelled during the wait: the hold is released (the held
   * input is delivered), the agent keeps running here, and the run ends
   * cancelled. An agent that cannot run (agentStopWaitReason: a credential
   * hold, an exhausted quota, a runtime mismatch) with no turn in flight is
   * not waited for: traced `not_runnable` with its reason; the stop, the
   * `raft proc` jobs, the quiesce and the bundle follow as for a quiet one.
   * A lease without `sourceDrainUntil` (an older Server, whose
   * prep deadline has no room for the wait) or a host without the drain
   * stops at once, as before. Traced `daemon.migration_transport.source_drain`.
   */
  private async stopMigrationSourceAgent(lease: AgentMigrationTransportLeaseMessage, signal: AbortSignal): Promise<void> {
    await this.drainAndStopMigrationSourceAgent(lease, signal);
    // `raft proc`: the agent is moving away, so its jobs here stop with it,
    // before its workspace is packed. Not when the wait was cancelled (that
    // throws above): the agent stays.
    await this.stopProcJobsForAgent(lease.agentId, "migrated");
  }

  private async drainAndStopMigrationSourceAgent(lease: AgentMigrationTransportLeaseMessage, signal: AbortSignal): Promise<void> {
    const { agentId } = lease;
    const drainUntilMs = lease.sourceDrainUntil === undefined ? Number.NaN : Date.parse(lease.sourceDrainUntil);
    const beginDrain = this.agentHosts.beginDrain;
    if (!Number.isFinite(drainUntilMs) || !beginDrain) {
      await this.agentHosts.stopAgent(agentId, { wait: true, silent: true });
      return;
    }
    const drainStartMs = currentTimeMs();
    const deadlineMs = clampAgentDrainDeadlineMs(drainUntilMs - drainStartMs);
    const trace = (outcome: "quiet" | "not_runnable" | "deadline" | "ended" | "aborted" | "not_running", attrs: Record<string, unknown> = {}) => {
      this.recordDaemonEvent("daemon.migration_transport.source_drain", {
        ...migrationTraceIdentityAttrs(lease, "source_drain"),
        outcome,
        deadline_ms: deadlineMs,
        ...attrs,
      });
    };
    if (!this.agentHosts.getRunningAgentIds().includes(agentId)) {
      trace("not_running", { waited_ms: 0 });
      await this.agentHosts.stopAgent(agentId, { wait: true, silent: true });
      return;
    }
    signal.throwIfAborted();
    const release = () => this.agentHosts.endDrain?.(agentId);
    signal.addEventListener("abort", release, { once: true });
    let summary: AgentDrainSummary;
    try {
      const drained = beginDrain.call(this.agentHosts, { deadlineMs, agentId });
      // The drain holds now (begin reads the host synchronously): why the agent is not quiet.
      this.reportMigrationSourceDraining(lease, signal, drainStartMs + deadlineMs, deadlineMs);
      summary = await drained;
    } finally {
      signal.removeEventListener("abort", release);
    }
    if (signal.aborted) {
      release();
      trace("aborted", { waited_ms: summary.durationMs });
      signal.throwIfAborted();
    }
    try {
      await this.agentHosts.stopAgent(agentId, { wait: true, silent: true });
    } finally {
      release();
    }
    // Quiet only because it cannot run (agentStopWaitReason): what a turn
    // would have settled was not waited for, and stays unread on the server.
    const notRunnable = summary.finished === "quiet" ? summary.notRunnable?.find((each) => each.agentId === agentId) : undefined;
    trace(notRunnable ? "not_runnable" : summary.finished, {
      waited_ms: summary.durationMs,
      hit_deadline: summary.finished === "deadline",
      live: summary.live,
      not_quiet_reason: summary.notQuiet.map((each) => each.reason).join(",") || undefined,
      ...(notRunnable ? { not_runnable_reason: notRunnable.reason, not_waited_for: notRunnable.settled } : {}),
    });
  }

  /**
   * One best-effort `draining` report to source-progress as the source drain
   * begins, so the owner sees what the migration waits for instead of a
   * silent stopping step. Only to a Server that advertises
   * SERVER_CAPABILITY_MIGRATION_SOURCE_DRAIN_PROGRESS_V1 (an older one's
   * strict schema refuses the phase), only for a wait with a deadline ahead,
   * and not when the agent is already quiet (the drain ends at once). Never
   * awaited: a failed or slow Server costs the drain nothing.
   */
  private reportMigrationSourceDraining(
    lease: AgentMigrationTransportLeaseMessage,
    signal: AbortSignal,
    drainUntilMs: number,
    deadlineMs: number,
  ): void {
    try {
      if (deadlineMs <= 0 || signal.aborted || !this.serverAcceptsMigrationSourceDrainProgress()) return;
      const progress = this.agentHosts.drainProgress?.(lease.agentId) ?? null;
      const reason = progress?.notQuiet.find((each) => each.agentId === lease.agentId)?.reason;
      if (progress && !reason) return;
      void daemonFetch(this.migrationResumableControlUrl(lease, "/source-progress"), {
        method: "POST",
        headers: {
          ...this.migrationResumableControlHeaders(lease),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          migrationGeneration: lease.transportGeneration,
          phase: "draining",
          drainUntil: new Date(drainUntilMs).toISOString(),
          ...(reason ? { waitingFor: migrationSourceDrainWaitingFor(reason) } : {}),
        }),
        signal,
      }).catch(() => undefined);
    } catch {
      // Best effort: the report never fails the drain.
    }
  }

  /**
   * Writes the source lease's `userIgnoreAdditions` into `.raftbackupignore.user`.
   * A failure fails the migration like any other source error (transport-lost
   * with MIGRATION_USER_IGNORE_WRITE_FAILED). Traces counts and the failure
   * reason only, never a path or the name.
   */
  private async writeMigrationUserIgnoreAdditions(
    lease: AgentMigrationTransportLeaseMessage,
    workspacePath: string,
  ): Promise<AgentMigrationUserIgnoreAdditionsReceipt | null> {
    try {
      const outcome = await writeAgentMigrationUserIgnoreAdditions({ workspacePath, lease, now: currentDate() });
      if (!outcome) return null;
      this.recordDaemonEvent("daemon.migration_transport.user_ignore", {
        ...migrationTraceIdentityAttrs(lease, "user_ignore"),
        outcome: outcome.receipt.written > 0 ? "written" : "already_present",
        written_count: outcome.receipt.written,
        already_present_count: outcome.receipt.alreadyPresent,
        rejected_count: outcome.rejectedCount,
      });
      return outcome.receipt;
    } catch (err) {
      this.recordDaemonEvent("daemon.migration_transport.user_ignore", {
        ...migrationTraceIdentityAttrs(lease, "user_ignore"),
        outcome: "failed",
        reason: err instanceof AgentMigrationUserIgnoreWriteError ? err.reason : "write_failed",
      }, "error");
      throw err instanceof AgentMigrationUserIgnoreWriteError ? err : new AgentMigrationUserIgnoreWriteError("write_failed");
    }
  }

  /** Streamed bundles: records the chunk with the server, then uploads it unless it is already there. */
  private async uploadStreamedMigrationChunk(
    lease: AgentMigrationTransportLeaseMessage,
    chunk: AgentMigrationControlChunk,
    bytes: Buffer,
    signal: AbortSignal,
  ): Promise<void> {
    const prepareResponse = await this.fetchResumableTransferWithRetry(
      lease,
      "chunk_plan",
      false,
      signal,
      () => daemonFetch(this.migrationResumableControlUrl(lease, `/stream-chunks/${chunk.index}`), {
        method: "POST",
        headers: {
          ...this.migrationResumableControlHeaders(lease),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          migrationGeneration: lease.transportGeneration,
          leaseId: lease.leaseId,
          sizeBytes: chunk.sizeBytes,
          sha256: chunk.sha256,
        }),
        signal,
      }),
    );
    if (!prepareResponse.ok) {
      throw await migrationStepResponseError("MIGRATION_CHUNK_PLAN_FAILED", prepareResponse, "chunk_plan");
    }
    const prepared = await prepareResponse.json() as { uploaded?: boolean; url?: string | null };
    if (prepared.uploaded === true) return;
    if (typeof prepared.url !== "string" || !prepared.url) throw new Error("MIGRATION_CHUNK_PLAN_MISMATCH");
    const uploadUrl = prepared.url;
    const upload = await this.fetchResumableTransferWithRetry(
      lease,
      "chunk_upload",
      false,
      signal,
      () => daemonFetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(chunk.sizeBytes),
        },
        body: bytes as Uint8Array<ArrayBuffer>,
        signal,
      }),
    );
    if (!upload.ok) throw new Error(`MIGRATION_CHUNK_UPLOAD_FAILED:${upload.status}`);
    await this.reportResumableChunkReceipt(lease, "source", chunk, upload.headers.get("etag"), signal);
  }

  /** Registers the control and completes the upload; every chunk was already streamed up. */
  private async registerAndCompleteResumableUpload(
    lease: AgentMigrationTransportLeaseMessage,
    built: { control: AgentMigrationControlManifest; controlSha256: string; controlBytes: number },
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const controlResponse = await daemonFetch(
      this.migrationResumableControlUrl(lease, "/control"),
      {
        method: "POST",
        headers: {
          ...this.migrationResumableControlHeaders(lease),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ control: built.control }),
        signal,
      },
    );
    if (!controlResponse.ok) {
      throw await migrationStepResponseError(
        "MIGRATION_CONTROL_REGISTER_FAILED",
        controlResponse,
        "control_register",
      );
    }
    const registered = await controlResponse.json() as { controlSha256?: string };
    if (registered.controlSha256 !== built.controlSha256) {
      throw new Error("MIGRATION_CONTROL_DIGEST_MISMATCH");
    }

    signal.throwIfAborted();
    const plan = await this.fetchResumableChunkPlan(lease, "source", signal);
    if (!plan.complete) throw new Error("MIGRATION_CHUNKS_MISSING");
    const completed = await daemonFetch(
      this.migrationResumableControlUrl(lease, "/upload-complete"),
      {
        method: "POST",
        headers: {
          ...this.migrationResumableControlHeaders(lease),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          migrationGeneration: lease.transportGeneration,
          leaseId: lease.leaseId,
          controlSha256: built.controlSha256,
        }),
        signal,
      },
    );
    if (!completed.ok) {
      throw await migrationStepResponseError(
        "MIGRATION_UPLOAD_COMPLETE_FAILED",
        completed,
        "upload_complete",
      );
    }
    this.recordDaemonEvent("daemon.migration_transport.resumable", {
      ...migrationTraceIdentityAttrs(lease, "upload_complete"),
      outcome: "uploaded",
      chunk_count: built.control.bundle.chunks.length,
      bundle_size_bucket: migrationObjectStoreBundleSizeBucket(built.control.bundle.totalBytes),
      control_bytes: built.controlBytes,
    });
  }

  private async downloadAndCommitResumableMigrationBundle(
    lease: AgentMigrationTransportLeaseMessage,
    run: MigrationTransferRunState,
  ): Promise<void> {
    if (lease.transferKind !== "download") throw new Error("MIGRATION_RESUMABLE_TARGET_LEASE_INVALID");
    const signal = run.controller.signal;
    signal.throwIfAborted();
    // Both durations are measured on this machine's clock, so they can be
    // read without subtracting timestamps taken on the source computer.
    const waitStartedAtMs = currentTimeMs();
    const { control, controlSha256 } = await this.waitForResumableControl(lease, signal);
    const controlReceivedAtMs = currentTimeMs();
    this.recordDaemonEvent("daemon.migration_transport.resumable", {
      ...migrationTraceIdentityAttrs(lease, "control_wait"),
      outcome: "control_received",
      chunk_count: control.bundle.chunks.length,
      duration_ms: controlReceivedAtMs - waitStartedAtMs,
    });
    if (
      control.identity.migrationId !== lease.migrationId
      || control.identity.migrationGeneration !== lease.transportGeneration
      || control.identity.leaseId !== lease.leaseId
      || control.identity.agentId !== lease.agentId
      || control.identity.targetMachineId !== lease.targetMachineId
    ) {
      throw new Error("MIGRATION_CONTROL_IDENTITY_MISMATCH");
    }
    const finalWorkspacePath = path.join(this.agentsDataDir, lease.agentId);
    let residue = await classifyAgentMigrationTargetResidue({
      control,
      controlSha256,
      slockHome: this.slockHome,
      finalWorkspacePath,
    });
    const staleWorkspace = residue.classification === "user-owned"
      || (residue.classification === "complete-old-copy"
        && residue.committed
        && !commitMarkerMatches(residue.committed, control, controlSha256));
    if (staleWorkspace) {
      // Until the flip the server keeps authority on the source, so this
      // directory is not the agent's live workspace, unless the agent is
      // somehow running here, in which case nothing is touched.
      if (this.agentHosts.getRunningAgentIds().includes(lease.agentId)) {
        throw new Error("MIGRATION_WORKSPACE_ALREADY_EXISTS");
      }
      const { quarantinePath } = await quarantinePreexistingAgentWorkspace({
        slockHome: this.slockHome,
        dataDir: this.agentsDataDir,
        agentId: lease.agentId,
        migrationId: lease.migrationId,
      });
      this.recordDaemonEvent("daemon.migration_transport.resumable", {
        ...migrationTraceIdentityAttrs(lease, "chunk_download"),
        outcome: "preexisting_workspace_quarantined",
        residue_class: residue.classification,
        quarantine_path_present: Boolean(quarantinePath),
      });
      residue = await classifyAgentMigrationTargetResidue({
        control,
        controlSha256,
        slockHome: this.slockHome,
        finalWorkspacePath,
      });
    }
    const chunksDirectory = path.join(residue.generationRootPath, "chunks");
    const missing = new Set(await missingAgentMigrationChunks({ control, chunksDirectory }));
    for (const chunk of control.bundle.chunks) {
      if (!missing.has(chunk.index)) {
        await this.reportResumableChunkReceipt(lease, "target", chunk, null, signal);
      }
    }
    while (true) {
      signal.throwIfAborted();
      const plan = await this.fetchResumableChunkPlan(lease, "target", signal);
      if (plan.complete) break;
      if (plan.chunks.length === 0) {
        await waitForAmbientBackoff(MIGRATION_OBJECT_STORE_DOWNLOAD_RETRY_INITIAL_MS, signal);
        continue;
      }
      const planned = plan.chunks.map((chunk) => {
        const expected = control.bundle.chunks[chunk.index];
        if (
          !expected
          || chunk.method !== "GET"
          || chunk.sizeBytes !== expected.sizeBytes
          || chunk.sha256 !== expected.sha256
        ) {
          throw new Error("MIGRATION_CHUNK_PLAN_MISMATCH");
        }
        return { chunk, expected };
      });
      await forEachWithConcurrency(planned, MIGRATION_TARGET_CHUNK_DOWNLOAD_CONCURRENCY, async ({ chunk, expected }) => {
        await this.downloadResumableChunkWithRetry(lease, control, chunk, chunksDirectory, signal);
        await this.reportResumableChunkReceipt(lease, "target", expected, null, signal);
      });
    }
    this.recordDaemonEvent("daemon.migration_transport.resumable", {
      ...migrationTraceIdentityAttrs(lease, "chunk_download"),
      outcome: "chunks_downloaded",
      chunk_count: control.bundle.chunks.length,
      duration_ms: currentTimeMs() - controlReceivedAtMs,
    });

    const targetImport = await this.fetchMigrationTargetImportView(lease.migrationId);
    if (targetImport.migrationRef !== lease.migrationRef) {
      throw new Error("MIGRATION_TARGET_IMPORT_REF_MISMATCH");
    }
    await this.writeMigrationCancellationMarker(lease, run, finalWorkspacePath);
    signal.throwIfAborted();
    const started = await this.postMigrationTargetImportStep(
      lease.migrationId,
      "start-transfer",
      { migrationGeneration: targetImport.migrationGeneration },
    );
    run.workspacePlacementStarted = true;
    await this.writeMigrationCancellationMarker(lease, run, finalWorkspacePath);
    const committed = await stageAndCommitAgentMigrationResumableBundle({
      control,
      controlSha256,
      slockHome: this.slockHome,
      chunksDirectory,
      finalWorkspacePath,
    }, {
      traceStep: (step, work) => this.traceMigrationPlacementStep(lease, control, step, work),
    });
    run.workspacePlaced = true;
    await this.writeMigrationCancellationMarker(lease, run, finalWorkspacePath);
    signal.throwIfAborted();
    const flipped = await this.postMigrationTargetImportStep(
      lease.migrationId,
      "flip-machine",
      { migrationGeneration: started.migrationGeneration },
    );
    run.flipCommitted = true;
    await this.writeMigrationCancellationMarker(lease, run, finalWorkspacePath);
    signal.throwIfAborted();
    const reportPath = path.join(residue.generationRootPath, "arrival-report-v2.json");
    const reportPayload = `${JSON.stringify({
      schemaVersion: "agent-arrival/v2",
      migrationId: lease.migrationId,
      migrationGeneration: lease.transportGeneration,
      agentId: lease.agentId,
      sourceMachineId: control.identity.sourceMachineId,
      targetMachineId: control.identity.targetMachineId,
      controlSha256,
      bundleSha256: control.bundle.sha256,
      chunkCount: control.bundle.chunks.length,
      commitOutcome: committed.outcome,
      residueClass: residue.classification,
      finalWorkspacePath: committed.finalWorkspacePath,
      arrivedAt: currentDate().toISOString(),
    })}\n`;
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, reportPayload, { mode: 0o600 });
    const reportSha256 = createHash("sha256").update(reportPayload).digest("hex");
    await this.postMigrationTargetImportStep(
      lease.migrationId,
      "arrived",
      {
        migrationGeneration: flipped.migrationGeneration,
        reportPath,
        reportSha256,
      },
    );
    await rm(this.migrationCancellationDirectory(lease.sessionId), { recursive: true, force: true });
    // Arrived and flipped: the Server no longer asks this generation for its
    // chunks, so the compressed workspace copy goes; the JSON report stays.
    const chunksFreedBytes = await removeMigrationGenerationBulk(
      residue.generationRootPath,
      createRaftDiskWalkBudget(),
    ).catch(() => null);
    this.recordDaemonEvent("daemon.migration_transport.resumable", {
      ...migrationTraceIdentityAttrs(lease, "arrival_report"),
      outcome: "committed",
      chunk_count: control.bundle.chunks.length,
      commit_outcome: committed.outcome,
      residue_class: residue.classification,
      ...(chunksFreedBytes === null ? { chunks_removed: false } : { chunks_removed: true, chunks_freed_bytes: chunksFreedBytes }),
    });
  }

  private async traceMigrationPlacementStep<T>(
    lease: AgentMigrationTransportLeaseMessage,
    control: AgentMigrationControlManifest,
    step: AgentMigrationPlacementStep,
    work: () => Promise<T>,
  ): Promise<T> {
    const span = this.tracer.startSpan("daemon.migration_transport.placement", {
      parent: getActiveTraceContext(),
      surface: "daemon",
      kind: "internal",
      attrs: {
        ...migrationTraceIdentityAttrs(lease, step),
        chunk_count: control.bundle.chunks.length,
        file_count: control.archive.entryCount,
        expanded_bytes: control.archive.expandedBytes,
      },
    });
    try {
      const result = await work();
      span.end("ok", { attrs: { outcome: "ok" } });
      return result;
    } catch (err) {
      span.end("error", { attrs: { outcome: "failed", error_class: errorClassOf(err) } });
      throw err;
    }
  }

  private async waitForResumableControl(
    lease: AgentMigrationTransportLeaseMessage,
    signal: AbortSignal,
  ): Promise<{
    control: AgentMigrationControlManifest;
    controlSha256: string;
  }> {
    return await pollMigrationResumableControl({
      expiresAtMs: Date.parse(lease.expiresAt),
      signal,
      poll: () => this.fetchResumableControlOnce(lease, signal),
    });
  }

  /** One control poll: the control once the upload is complete, null to poll again; throws to stop. */
  private async fetchResumableControlOnce(
    lease: AgentMigrationTransportLeaseMessage,
    signal: AbortSignal,
  ): Promise<{ control: AgentMigrationControlManifest; controlSha256: string } | null> {
    const url = this.migrationResumableControlUrl(lease, "/control");
    url.searchParams.set("role", "target");
    const response = await daemonFetch(url, {
      method: "GET",
      headers: this.migrationResumableControlHeaders(lease),
      signal,
    });
    if (response.ok) {
      const body = await response.json() as {
        control?: AgentMigrationControlManifest;
        controlSha256?: string;
        uploadComplete?: boolean;
      };
      if (body.control && body.controlSha256 && body.uploadComplete) {
        const validated = validateAgentMigrationControlManifest(body.control);
        if (validated.sha256 !== body.controlSha256) {
          throw new Error("MIGRATION_CONTROL_DIGEST_MISMATCH");
        }
        return { control: body.control, controlSha256: body.controlSha256 };
      }
    } else if (response.status !== 409 && !isRetryableMigrationObjectStoreDownloadStatus(response.status)) {
      throw await migrationStepResponseError(
        "MIGRATION_CONTROL_DOWNLOAD_FAILED",
        response,
        "control_wait",
      );
    }
    return null;
  }

  private async fetchResumableChunkPlan(
    lease: AgentMigrationTransportLeaseMessage,
    role: "source" | "target",
    signal: AbortSignal,
  ): Promise<{
    complete: boolean;
    chunks: Array<{ index: number; sizeBytes: number; sha256: string; method: "PUT" | "GET"; url: string }>;
  }> {
    const url = this.migrationResumableControlUrl(lease, "/chunks");
    url.searchParams.set("role", role);
    url.searchParams.set("cursor", "0");
    const response = await this.fetchResumableTransferWithRetry(
      lease,
      "chunk_plan",
      false,
      signal,
      () => daemonFetch(url, {
        method: "GET",
        headers: this.migrationResumableControlHeaders(lease),
        signal,
      }),
    );
    if (!response.ok) {
      throw await migrationStepResponseError(
        "MIGRATION_CHUNK_PLAN_FAILED",
        response,
        "chunk_plan",
      );
    }
    const body = await response.json() as {
      complete?: boolean;
      migrationGeneration?: string;
      leaseId?: string;
      chunks?: Array<{ index: number; sizeBytes: number; sha256: string; method: "PUT" | "GET"; url: string }>;
    };
    if (
      body.migrationGeneration !== lease.transportGeneration
      || body.leaseId !== lease.leaseId
      || typeof body.complete !== "boolean"
      || !Array.isArray(body.chunks)
    ) {
      throw new Error("MIGRATION_CHUNK_PLAN_MISMATCH");
    }
    return { complete: body.complete, chunks: body.chunks };
  }

  private async reportResumableChunkReceipt(
    lease: AgentMigrationTransportLeaseMessage,
    role: "source" | "target",
    chunk: { index: number; sizeBytes: number; sha256: string },
    etag: string | null,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.fetchResumableTransferWithRetry(
      lease,
      "chunk_receipt",
      false,
      signal,
      () => daemonFetch(
        this.migrationResumableControlUrl(lease, `/chunks/${chunk.index}/receipt`),
        {
          method: "POST",
          headers: {
            ...this.migrationResumableControlHeaders(lease),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            role,
            migrationGeneration: lease.transportGeneration,
            leaseId: lease.leaseId,
            chunkIndex: chunk.index,
            sizeBytes: chunk.sizeBytes,
            sha256: chunk.sha256,
            ...(etag ? { etag } : {}),
          }),
          signal,
        },
      ),
    );
    if (!response.ok) {
      throw await migrationStepResponseError(
        "MIGRATION_CHUNK_RECEIPT_FAILED",
        response,
        "chunk_receipt",
      );
    }
  }

  /**
   * Download and store one chunk. `fetchResumableTransferWithRetry` only covers
   * getting the response headers; a connection that drops while the body is
   * streaming throws from the pipeline instead, so retry the whole chunk here
   * until the lease expires, but only for network-stream failures
   * (isRetryableChunkBodyError); a digest mismatch gets 3 attempts, and any
   * other error (full disk, permissions, invalid control) fails at once.
   */
  private async downloadResumableChunkWithRetry(
    lease: AgentMigrationTransportLeaseMessage,
    control: AgentMigrationControlManifest,
    chunk: { index: number; url: string },
    chunksDirectory: string,
    signal: AbortSignal,
  ): Promise<void> {
    const expiresAtMs = Date.parse(lease.expiresAt);
    let attempt = 0;
    let digestMismatches = 0;
    let delayMs = MIGRATION_CHUNK_BODY_RETRY_INITIAL_MS;
    while (true) {
      signal.throwIfAborted();
      attempt += 1;
      const response = await this.fetchResumableTransferWithRetry(
        lease,
        "chunk_download",
        true,
        signal,
        () => daemonFetch(chunk.url, { method: "GET", signal }),
      );
      if (!response.ok || !response.body) {
        throw new Error(`MIGRATION_CHUNK_DOWNLOAD_FAILED:${response.status}`);
      }
      const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
      try {
        await verifyAndStoreAgentMigrationChunk({
          control,
          chunkIndex: chunk.index,
          chunk: body,
          chunksDirectory,
        });
        return;
      } catch (error) {
        // verifyAndStore may throw before reading the body; destroying the
        // stream cancels the response so the connection is released.
        body.destroy();
        signal.throwIfAborted();
        if (error instanceof AgentMigrationChunkDigestMismatchError) {
          digestMismatches += 1;
          if (digestMismatches >= MIGRATION_CHUNK_DIGEST_MISMATCH_MAX_ATTEMPTS) throw error;
        } else if (!isRetryableChunkBodyError(error)) {
          throw error;
        }
        const remainingMs = expiresAtMs - currentTimeMs();
        if (remainingMs <= 0) throw error;
        const sleepMs = Math.min(delayMs, remainingMs);
        this.recordDaemonEvent("daemon.migration_transport.resumable", {
          ...migrationTraceIdentityAttrs(lease, "chunk_download"),
          outcome: "retry",
          operation: "chunk_download",
          attempt,
          // A 2xx status marks a body failure: header-level retries never have one.
          http_status: response.status,
          error_class: errorClassOf(error),
          retry_delay_ms: sleepMs,
        });
        await waitForAmbientBackoff(sleepMs, signal);
        delayMs = Math.min(delayMs * 2, MIGRATION_CHUNK_BODY_RETRY_MAX_MS);
      }
    }
  }

  private async fetchResumableTransferWithRetry(
    lease: AgentMigrationTransportLeaseMessage,
    operation: "chunk_upload" | "chunk_download" | "chunk_plan" | "chunk_receipt",
    retryNotFound: boolean,
    signal: AbortSignal,
    request: () => Promise<Response>,
  ): Promise<Response> {
    const expiresAtMs = Date.parse(lease.expiresAt);
    let attempt = 0;
    let delayMs = MIGRATION_OBJECT_STORE_DOWNLOAD_RETRY_INITIAL_MS;
    let lastStatus: number | null = null;
    let lastErrorClass: string | null = null;
    let noResponseSinceMs: number | null = null;

    while (currentTimeMs() < expiresAtMs) {
      signal.throwIfAborted();
      attempt += 1;
      try {
        const response = await request();
        noResponseSinceMs = null;
        if (response.ok || !isRetryableResumableMigrationStatus(response.status, retryNotFound)) {
          return response;
        }
        lastStatus = response.status;
        lastErrorClass = null;
        await response.body?.cancel().catch(() => undefined);
      } catch (error) {
        signal.throwIfAborted();
        lastStatus = null;
        lastErrorClass = errorClassOf(error);
        noResponseSinceMs ??= currentTimeMs();
        if (
          (operation === "chunk_upload" || operation === "chunk_download")
          && currentTimeMs() - noResponseSinceMs >= MIGRATION_OBJECT_STORE_UNREACHABLE_MS
        ) {
          throw new Error("MIGRATION_OBJECT_STORE_UNREACHABLE");
        }
      }

      const remainingMs = expiresAtMs - currentTimeMs();
      if (remainingMs <= 0) break;
      const sleepMs = Math.min(delayMs, remainingMs);
      this.recordDaemonEvent("daemon.migration_transport.resumable", {
        ...migrationTraceIdentityAttrs(lease, operation === "chunk_upload"
          ? "chunk_upload"
          : operation === "chunk_download"
            ? "chunk_download"
            : operation === "chunk_plan"
              ? "chunk_plan"
              : "chunk_receipt"),
        outcome: "retry",
        operation,
        attempt,
        http_status: lastStatus,
        error_class: lastErrorClass,
        retry_delay_ms: sleepMs,
      });
      await waitForAmbientBackoff(sleepMs, signal);
      delayMs = Math.min(delayMs * 2, MIGRATION_OBJECT_STORE_DOWNLOAD_RETRY_MAX_MS);
    }
    throw new Error("MIGRATION_LEASE_EXPIRED");
  }

  private migrationCancellationDirectory(sessionId: string): string {
    return path.join(this.slockHome, "migrations", migrationStatePathSegment(sessionId));
  }

  private migrationCancellationMarkerPath(sessionId: string): string {
    return path.join(this.migrationCancellationDirectory(sessionId), "cancel-state.json");
  }

  private migrationCancellationReceiptPath(sessionId: string): string {
    return path.join(this.migrationCancellationDirectory(sessionId), "cancel-receipt.json");
  }

  private async writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await rename(temporaryPath, filePath);
  }

  private async writeMigrationCancellationMarker(
    lease: AgentMigrationTransportLeaseMessage,
    run: MigrationTransferRunState,
    finalWorkspacePath: string,
  ): Promise<void> {
    const marker: MigrationCancellationMarker = {
      schemaVersion: "agent-migration-cancel/v1",
      agentId: lease.agentId,
      migrationId: lease.migrationId,
      migrationRef: lease.migrationRef,
      transportGeneration: lease.transportGeneration,
      sessionId: lease.sessionId,
      finalWorkspacePath: path.resolve(finalWorkspacePath),
      workspacePlacementStarted: run.workspacePlacementStarted,
      workspacePlaced: run.workspacePlaced,
      flipCommitted: run.flipCommitted,
    };
    await this.writeJsonAtomically(this.migrationCancellationMarkerPath(lease.sessionId), marker);
  }

  private async readMigrationCancellationMarker(sessionId: string): Promise<MigrationCancellationMarker | null> {
    try {
      const value = JSON.parse(await readFile(this.migrationCancellationMarkerPath(sessionId), "utf8")) as Partial<MigrationCancellationMarker>;
      if (
        value.schemaVersion !== "agent-migration-cancel/v1"
        || typeof value.agentId !== "string"
        || typeof value.migrationId !== "string"
        || typeof value.migrationRef !== "string"
        || typeof value.transportGeneration !== "string"
        || typeof value.sessionId !== "string"
        || typeof value.finalWorkspacePath !== "string"
        || typeof value.workspacePlacementStarted !== "boolean"
        || typeof value.workspacePlaced !== "boolean"
        || typeof value.flipCommitted !== "boolean"
      ) {
        throw new Error("MIGRATION_CANCEL_MARKER_INVALID");
      }
      return value as MigrationCancellationMarker;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  private async readMigrationCancellationReceipt(sessionId: string): Promise<AppliedMigrationCancellationReceipt | null> {
    try {
      const value = JSON.parse(await readFile(this.migrationCancellationReceiptPath(sessionId), "utf8")) as Partial<AppliedMigrationCancellationReceipt>;
      if (
        value.schemaVersion !== "agent-migration-cancel-receipt/v1"
        || typeof value.agentId !== "string"
        || typeof value.migrationId !== "string"
        || typeof value.migrationRef !== "string"
        || typeof value.transportGeneration !== "string"
        || typeof value.cancelGeneration !== "string"
        || (value.role !== "source" && value.role !== "target")
        || (value.outcome !== "cleaned" && value.outcome !== "stopped")
      ) {
        throw new Error("MIGRATION_CANCEL_RECEIPT_INVALID");
      }
      return value as AppliedMigrationCancellationReceipt;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  private async handleMigrationCancellation(message: AgentMigrationCancelMessage): Promise<void> {
    const span = this.tracer.startSpan("daemon.migration_transport.cancel_cleanup", {
      surface: "daemon",
      kind: "internal",
      attrs: {
        role: message.role,
        migration_ref: message.migrationRef,
      },
    });
    const cleaned = await runWithActiveSpan(span, () => this.cleanUpCancelledMigration(message));
    span.end(cleaned ? "ok" : "error");
  }

  // Returns false when the cleanup failed. The failure is already reported
  // to the server and recorded as a trace event.
  private async cleanUpCancelledMigration(message: AgentMigrationCancelMessage): Promise<boolean> {
    try {
      if (!message.agentId.trim() || !message.migrationId.trim()) throw new Error("MIGRATION_CANCEL_IDENTITY_INVALID");
      if (!/^mig_[A-Za-z0-9_-]{22}$/.test(message.migrationRef)) throw new Error("MIGRATION_CANCEL_REF_INVALID");
      if (!message.transportGeneration.trim()) throw new Error("MIGRATION_TRANSPORT_GENERATION_INVALID");
      if (!message.cancelGeneration.trim()) throw new Error("MIGRATION_CANCEL_GENERATION_INVALID");
      if (!Number.isInteger(message.migrationRevision) || message.migrationRevision < 1) {
        throw new Error("MIGRATION_CANCEL_REVISION_INVALID");
      }
      const sessionKey = message.sessionId ?? message.migrationId;
      const priorReceipt = await this.readMigrationCancellationReceipt(sessionKey);
      if (priorReceipt) {
        if (
          priorReceipt.agentId !== message.agentId
          || priorReceipt.migrationId !== message.migrationId
          || priorReceipt.migrationRef !== message.migrationRef
          || priorReceipt.transportGeneration !== message.transportGeneration
          || priorReceipt.cancelGeneration !== message.cancelGeneration
          || priorReceipt.role !== message.role
        ) {
          throw new Error("MIGRATION_CANCEL_GENERATION_STALE");
        }
        await this.reportMigrationCancellation(message, priorReceipt.outcome);
        return true;
      }

      const matchingRuns = [...this.migrationTransferRuns.values()].filter((run) =>
        run.lease.agentId === message.agentId
        && run.lease.migrationId === message.migrationId
        && run.lease.migrationRef === message.migrationRef
        && run.lease.transportGeneration === message.transportGeneration
        && run.lease.role === message.role
      );
      const activeLeaseMatches = Boolean(
        this.migrationTransferLease?.agentId === message.agentId
        && this.migrationTransferLease?.migrationId === message.migrationId
        && this.migrationTransferLease?.migrationRef === message.migrationRef
        && this.migrationTransferLease?.transportGeneration === message.transportGeneration
        && this.migrationTransferLease?.role === message.role
      );
      for (const run of matchingRuns) run.controller.abort(new Error("MIGRATION_CANCEL_REQUESTED"));
      await Promise.allSettled(matchingRuns.map((run) => run.promise));

      let markerMatches = false;
      if (message.sessionId) {
        const marker = await this.readMigrationCancellationMarker(message.sessionId);
        if (marker) {
          const expectedFinalWorkspacePath = path.resolve(this.agentsDataDir, message.agentId);
          if (
            marker.agentId !== message.agentId
            || marker.migrationId !== message.migrationId
            || marker.migrationRef !== message.migrationRef
            || marker.transportGeneration !== message.transportGeneration
            || marker.sessionId !== message.sessionId
            || path.resolve(marker.finalWorkspacePath) !== expectedFinalWorkspacePath
          ) {
            throw new Error("MIGRATION_CANCEL_MARKER_IDENTITY_MISMATCH");
          }
          markerMatches = true;
          if (
            message.disposition === "pre_flip_source_authoritative"
            && marker.workspacePlacementStarted
            && !marker.flipCommitted
          ) {
            await rm(expectedFinalWorkspacePath, { recursive: true, force: true });
          }
        }
      }
      if (matchingRuns.length === 0 && !activeLeaseMatches && !markerMatches) {
        throw new Error("MIGRATION_CANCEL_GENERATION_UNOBSERVED");
      }
      if (message.sessionId) {
        // The legacy staged bundle and the cancellation marker share this
        // migration-owned directory. Clear it before recreating only the
        // durable idempotency receipt below.
        await rm(this.migrationCancellationDirectory(message.sessionId), { recursive: true, force: true });
      }
      // Resumable chunks, control state, and the arrival report live under
      // the immutable migration + transport-generation root. They remain
      // migration-owned after the authority flip, so both Computers must
      // remove this exact root before acknowledging cancellation. Keep the
      // target workspace separate: post-flip authority stays on the target.
      await rm(path.join(
        this.slockHome,
        "migrations",
        migrationStatePathSegment(message.migrationId),
        migrationStatePathSegment(message.transportGeneration),
      ), { recursive: true, force: true });
      if (message.stopAgent) {
        await this.agentHosts.stopAgent(message.agentId, { wait: true });
      }
      if (activeLeaseMatches) {
        this.migrationTransferLease = null;
        this.emitReadyIfConnected();
      }
      const outcome = message.stopAgent ? "stopped" : "cleaned";
      const receipt: AppliedMigrationCancellationReceipt = {
        schemaVersion: "agent-migration-cancel-receipt/v1",
        agentId: message.agentId,
        migrationId: message.migrationId,
        migrationRef: message.migrationRef,
        transportGeneration: message.transportGeneration,
        cancelGeneration: message.cancelGeneration,
        role: message.role,
        outcome,
      };
      await this.writeJsonAtomically(this.migrationCancellationReceiptPath(sessionKey), receipt);
      await this.reportMigrationCancellation(message, outcome);
      this.recordDaemonEvent("daemon.migration_transport.object_store", {
        stage: "cancel_cleanup",
        outcome: "cancel_acknowledged",
        role: message.role,
        migration_ref: message.migrationRef,
      });
      return true;
    } catch (err) {
      logger.error("[Slock Daemon] Migration cancellation cleanup failed", err);
      this.recordDaemonEvent("daemon.migration_transport.object_store", {
        stage: "cancel_cleanup",
        outcome: "cancel_cleanup_failed",
        role: message.role,
        migration_ref: message.migrationRef,
        error_class: errorClassOf(err),
        error_code: /^(MIGRATION_[A-Z0-9_]+)/.exec(
          err instanceof Error ? err.message : String(err),
        )?.[1],
      }, "error");
      try {
        await this.reportMigrationCancellation(
          message,
          "needs_attention",
          errorClassOf(err),
          err instanceof Error ? err.message : String(err),
        );
      } catch (reportErr) {
        logger.error("[Slock Daemon] Failed to report migration cancellation attention state", reportErr);
      }
      return false;
    }
  }

  private async reportMigrationCancellation(
    message: AgentMigrationCancelMessage,
    outcome: "cleaned" | "stopped" | "needs_attention",
    errorCode?: string,
    errorMessage?: string,
  ): Promise<void> {
    const url = new URL(`/internal/computer/agent-migrations/by-id/${encodeURIComponent(message.migrationId)}/cancel-ack`, this.options.serverUrl);
    const response = await daemonFetch(url, {
      method: "POST",
      headers: {
        ...this.internalComputerHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        migrationRef: message.migrationRef,
        transportGeneration: message.transportGeneration,
        cancelGeneration: message.cancelGeneration,
        role: message.role,
        outcome,
        errorCode,
        errorMessage,
      }),
    });
    if (!response.ok) {
      throw new Error(`MIGRATION_CANCEL_ACK_FAILED:${response.status}`);
    }
  }

  private async reportMigrationTransportLost(lease: AgentMigrationTransportLeaseMessage, err: unknown): Promise<void> {
    const url = new URL(`/internal/computer/agent-migrations/by-id/${encodeURIComponent(lease.migrationId)}/transport-lost`, this.options.serverUrl);
    const response = await daemonFetch(url, {
      method: "POST",
      headers: {
        ...this.internalComputerHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        role: lease.role,
        transferKind: lease.transferKind,
        code: migrationTransferFailureCode(err),
        // Lets the server ignore a stale run after re-provisioning (additive).
        ...(lease.transportGeneration ? { transportGeneration: lease.transportGeneration } : {}),
        detailCode: migrationTransferFailureDetailCode(err),
        message: migrationTransferFailureMessage(err),
      }),
    });
    if (!response.ok) {
      throw new Error(`MIGRATION_TRANSPORT_LOST_REPORT_FAILED:${response.status}`);
    }
    this.recordDaemonEvent("daemon.migration_transport.object_store", {
      ...migrationTraceIdentityAttrs(lease, "transport_lost_report"),
      outcome: "transport_lost_reported",
      migration_id_present: Boolean(lease.migrationId),
    });
  }

  private archiveMigrationSourceWorkspaceSerialized(
    agentId: string,
    migrationId: string,
    migrationCreatedAt?: string,
  ): Promise<AgentMigrationWorkspaceArchiveOutcome> {
    const inFlight = this.migrationSourceArchiveRuns.get(agentId);
    if (inFlight?.migrationId === migrationId) return inFlight.run;
    // A different migration of the same agent waits for the in-flight one:
    // both touch the same source directory and backup root.
    const run = (inFlight?.run.catch(() => undefined) ?? Promise.resolve())
      .then(() => this.assertMigrationSourceWorkspaceArchivable(agentId, migrationCreatedAt))
      .then(() => archiveCompletedAgentMigrationSourceWorkspace({
        slockHome: this.slockHome,
        dataDir: this.agentsDataDir,
        agentId,
        migrationId,
      }))
      .finally(() => {
        if (this.migrationSourceArchiveRuns.get(agentId)?.run === run) {
          this.migrationSourceArchiveRuns.delete(agentId);
        }
      });
    this.migrationSourceArchiveRuns.set(agentId, { migrationId, run });
    return run;
  }

  /**
   * The server checks the holder before asking, but a background retry reaches
   * the daemon after that check committed. The daemon is the last line: never
   * archive a workspace whose agent runs here, or one that a later migration
   * committed onto this computer (the agent moved back).
   */
  private async assertMigrationSourceWorkspaceArchivable(agentId: string, migrationCreatedAt?: string): Promise<void> {
    if (this.agentHosts.getRunningAgentIds().includes(agentId)) {
      throw new Error("MIGRATION_WORKSPACE_ARCHIVE_AGENT_RUNNING");
    }
    const createdAtMs = migrationCreatedAt ? Date.parse(migrationCreatedAt) : Number.NaN;
    if (!Number.isFinite(createdAtMs)) return;
    const marker = await readCommitMarker(path.join(this.agentsDataDir, agentId));
    if (marker && Date.parse(marker.committedAt) > createdAtMs) {
      throw new Error("MIGRATION_WORKSPACE_ARCHIVE_NEWER_OWNER");
    }
  }

  private async fetchMigrationTargetImportView(migrationId: string): Promise<MigrationTargetImportView> {
    const url = new URL(`/internal/computer/agent-migrations/by-id/${encodeURIComponent(migrationId)}`, this.options.serverUrl);
    const response = await daemonFetch(url, {
      method: "GET",
      headers: this.internalComputerHeaders(),
    });
    if (!response.ok) {
      throw new Error(`MIGRATION_TARGET_IMPORT_LOOKUP_FAILED:${response.status}`);
    }
    const body = await response.json() as { migration?: MigrationTargetImportView };
    if (!body.migration) throw new Error("MIGRATION_TARGET_IMPORT_VIEW_MISSING");
    return body.migration;
  }

  private async postMigrationTargetImportStep(
    migrationId: string,
    step: "start-transfer" | "flip-machine" | "arrived",
    body: {
      migrationGeneration: string;
      reportPath?: string;
      reportSha256?: string;
    },
  ): Promise<MigrationTargetImportView> {
    return await retryMigrationTargetStep({
      step,
      body,
      post: (attemptBody) => this.postMigrationTargetImportStepOnce(migrationId, step, attemptBody, true),
      fetchView: () => this.fetchMigrationTargetImportView(migrationId),
      onRetry: (error, delayMs) => this.recordDaemonEvent("daemon.migration_transport.target_step", {
        step,
        outcome: "retry",
        error_class: errorClassOf(error),
        delay_ms: delayMs,
      }),
    });
  }

  private async postMigrationTargetImportStepOnce(
    migrationId: string,
    step: "start-transfer" | "flip-machine" | "arrived",
    body: {
      migrationGeneration: string;
      reportPath?: string;
      reportSha256?: string;
    },
    allowStartGenerationRefresh: boolean,
  ): Promise<MigrationTargetImportView> {
    const url = new URL(`/internal/computer/agent-migrations/by-id/${encodeURIComponent(migrationId)}/${step}`, this.options.serverUrl);
    const response = await daemonFetch(url, {
      method: "POST",
      headers: {
        ...this.internalComputerHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const suffix = await migrationStepErrorSuffix(response);
      if (step === "start-transfer" && response.status === 409 && suffix === "migration_generation_stale" && allowStartGenerationRefresh) {
        const current = await this.fetchMigrationTargetImportView(migrationId);
        if (current.state === "in_transit") return current;
        if (current.state === "ready" && current.migrationGeneration !== body.migrationGeneration) {
          return await this.postMigrationTargetImportStepOnce(migrationId, step, {
            ...body,
            migrationGeneration: current.migrationGeneration,
          }, false);
        }
      }
      throw new Error(`MIGRATION_TARGET_IMPORT_${step.toUpperCase().replace("-", "_")}_FAILED:${response.status}:${suffix}`);
    }
    const responseBody = await response.json() as { migration?: MigrationTargetImportView };
    if (!responseBody.migration) throw new Error("MIGRATION_TARGET_IMPORT_VIEW_MISSING");
    return responseBody.migration;
  }

  private internalComputerHeaders(): Record<string, string> {
    return {
      "Authorization": `Bearer ${this.options.apiKey}`,
      "X-Raft-Client": "daemon-migration-object-store",
    };
  }

  private withDaemonTraceScope(tracer: Tracer): Tracer {
    const scopedTracer = () => createTraceScopeTracer(tracer, this.daemonTraceScope(), {
      spanAttrContracts: DAEMON_CORE_TRACE_ATTR_CONTRACTS,
    });
    return {
      startSpan: (name, options) => scopedTracer().startSpan(name, options),
      emitEvent: (name, options) => scopedTracer().emitEvent(name, options),
    };
  }

  private daemonTraceScope(): TraceScope {
    return {
      resource: {
        daemonVersion: this.daemonVersion,
        computerVersion: this.computerVersion,
        computerBuildSha: this.computerBuildSha,
      },
      actor: {
        serverId: this.observedServerId,
        machineId: this.observedMachineId,
      },
    };
  }

  private observeRuntimeContext(config: AgentConfig): void {
    const ctx = config.runtimeContext;
    if (!this.authenticatedMachineContext) {
      if (ctx?.serverId) this.observedServerId = ctx.serverId;
      if (ctx?.machineId) this.observedMachineId = ctx.machineId;
    }
  }

  /**
   * Same-machine grouping: answer with this machine's hash for the
   * authenticated server only. No context (or a conflicting one) or no
   * readable hardware ID means no reply; the Computer is then not grouped.
   */
  private async replyHostIdentity(): Promise<void> {
    const serverId = this.machineContextConflict ? undefined : this.authenticatedMachineContext?.serverId;
    if (!serverId) {
      this.recordDaemonEvent("daemon.host_identity.skipped", { reason: "no_context" });
      return;
    }
    const hash = await hostIdHash(serverId);
    if (!hash) {
      this.recordDaemonEvent("daemon.host_identity.skipped", { reason: "no_hardware_id" });
      return;
    }
    this.connection.send({ type: "machine:host_identity", hostIdHash: hash });
    this.recordDaemonEvent("daemon.host_identity.sent", {});
  }

  /** The server this connection authenticated as, or null before `machine:context` or after a conflict. */
  private boundServerId(): string | null {
    return this.machineContextConflict ? null : this.authenticatedMachineContext?.serverId ?? null;
  }

  private bindAuthenticatedMachineContext(
    context: Extract<ServerToMachineMessage, { type: "machine:context" }>,
  ): void {
    const current = this.authenticatedMachineContext;
    if (current) {
      if (current.machineId === context.machineId && current.serverId === context.serverId) return;
      this.machineContextConflict = true;
      this.scopedAppStorageFactory?.revoke();
      this.scopedAppStorageFactory = null;
      this.scopedAppStorageObserver?.stop();
      this.scopedAppStorageObserver = null;
      this.appInboxes.clear();
      this.recordDaemonEvent("daemon.machine_context.conflict", {
        machine_id_match: current.machineId === context.machineId,
        server_id_match: current.serverId === context.serverId,
      }, "error");
      logger.error("[Daemon] Authenticated machine context changed within one process; App storage is fail-closed until restart");
      return;
    }

    this.authenticatedMachineContext = {
      machineId: context.machineId,
      serverId: context.serverId,
    };
    this.observedMachineId = context.machineId;
    this.observedServerId = context.serverId;
    this.scopedAppStorageObserver = createScopedAppStorageObserver({
      clock: this.appScheduleClock,
      trace: (name, attrs, status) => this.recordDaemonEvent(name, attrs, status),
      serverId: context.serverId,
      writerEpoch: this.daemonInstanceId,
    });
    this.scopedAppStorageFactory = createScopedAppStorageFactory({
      slockHome: this.slockHome,
      owner: this.authenticatedMachineContext,
      writerEpoch: this.daemonInstanceId,
      onFailure: (event) => {
        this.recordDaemonEvent("daemon.app_storage.failure", {
          operation: event.operation,
          store: event.store,
          app: event.appId,
          server_id: event.serverId,
          writer_epoch: event.writerEpoch,
          outcome: event.outcome,
          reason: event.reason,
          ...(event.failureInstanceId === undefined
            ? {}
            : { failure_generation: event.failureInstanceId }),
          ...(event.observation === undefined
            ? {}
            : { corruption_class: event.observation }),
        }, "error");
        this.scopedAppStorageObserver?.observe(event);
      },
    });
    this.localScheduleRuntime.bindScopedStorage(this.scopedAppStorageFactory);
    this.recordDaemonEvent("daemon.machine_context.bound", {
      machine_id_present: true,
      server_id_present: true,
    });
  }

  private async requestRunnerCredentialOnce(agentId: string, config: AgentConfig): Promise<{ apiKey: string; credentialId: string | null }> {
    const url = new URL(`/internal/computer/runners/${encodeURIComponent(agentId)}/credentials`, this.options.serverUrl);
    const res = await daemonFetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
        "X-Raft-Client": "daemon-server-session-worker",
      },
      body: JSON.stringify({
        scopes: RUNNER_CREDENTIAL_SCOPES,
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

  private async mintRunnerCredential(
    agentId: string,
    config: AgentConfig,
    parent: TraceContext | null,
  ): Promise<{ apiKey: string; credentialId: string | null }> {
    if (config.agentCredentialKey) {
      return { apiKey: config.agentCredentialKey, credentialId: config.agentCredentialId ?? null };
    }
    const span = this.tracer.startSpan("daemon.runner_credential_mint", {
      parent,
      surface: "daemon",
      kind: "client",
      attrs: { agentId, runtime: config.runtime },
    });
    try {
      const credential = await this.mintRunnerCredentialWithRetry(agentId, config, span.context);
      span.end("ok");
      return credential;
    } catch (err) {
      span.end("error", { attrs: { error_class: errorClassOf(err) } });
      throw err;
    }
  }

  private async mintRunnerCredentialWithRetry(
    agentId: string,
    config: AgentConfig,
    mintSpan: TraceContext,
  ): Promise<{ apiKey: string; credentialId: string | null }> {
    if (process.env.SLOCK_AGENT_RUNNER_CREDENTIALS_DISABLED === "1") {
      throw new RunnerCredentialMintError("runner credential mint is disabled by SLOCK_AGENT_RUNNER_CREDENTIALS_DISABLED", {
        code: "runner_credentials_disabled",
      });
    }

    // `rfcs/034-slock-credential-rfc.zh.html#section-credential-model`:
    // Computer/server-session worker asks the server to mint an agent-scoped
    // runner credential. New daemon builds must not silently fall back to the
    // legacy `/internal/agent/:id/*` machine-on-behalf data plane. Server is
    // deployed first; daemon binary rollback is the release-safety mechanism.
    // Retry only retryable mint failures, then hard-fail agent:start loudly.
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= RUNNER_CREDENTIAL_MINT_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.requestRunnerCredentialOnce(agentId, config);
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
        }, detail.retryable && attempt < RUNNER_CREDENTIAL_MINT_MAX_ATTEMPTS ? "ok" : "error", mintSpan);
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
    }, "error", mintSpan);
    throw new RunnerCredentialMintError(
      `runner_credential_mint_failed: ${detail.message}. Managed runner startup requires /internal/computer credential mint; deploy server first or roll back the daemon binary.`,
      {
        code: detail.code,
        retryable: detail.retryable,
        status: detail.status,
      },
    );
  }

  private sendDeliveryAck(msg: AgentDeliverMessage, traceparent?: string): void {
    const ackSeq = msg.seq > 0 ? msg.seq : msg.message.seq ?? 0;
    const ack: MachineToServerMessage = {
      type: "agent:deliver:ack",
      agentId: msg.agentId,
      seq: ackSeq,
      deliveryId: msg.deliveryId,
      mentionDelivery: msg.mentionDelivery,
      ...(traceparent ? { traceparent } : {}),
    };
    this.connection.send(ack);
  }

  private sendMentionDeliveryTransition(
    msg: AgentDeliverMessage,
    stage: "daemon_received" | "daemon_pending" | "daemon_drained",
    outcome: "accepted" | "coalesced",
    traceparent?: string,
  ): void {
    if (!msg.mentionDelivery) return;
    this.connection.send({
      type: "agent:delivery:transition",
      agentId: msg.agentId,
      stage,
      outcome,
      mentionDelivery: msg.mentionDelivery,
      ...(traceparent ? { traceparent } : {}),
    });
  }

  /** task #1113: no process and no snapshot — hand the wake back to the Server with the delivery key. */
  private sendDeliveryRejectedNoProcess(msg: AgentDeliverMessage, traceparent?: string): void {
    this.connection.send({
      type: "agent:delivery:rejected",
      agentId: msg.agentId,
      seq: msg.seq > 0 ? msg.seq : msg.message.seq ?? 0,
      ...(msg.deliveryId ? { deliveryId: msg.deliveryId } : {}),
      reason: "no_process",
      ...(msg.mentionDelivery ? { mentionDelivery: msg.mentionDelivery } : {}),
      ...(traceparent ? { traceparent } : {}),
    });
  }

  private sendMentionDeliveryTerminalError(
    msg: AgentDeliverMessage,
    // task #154: single authoritative union from @botiverse/raft-shared
    // (previously a third inline copy that silently lacked REDELIVERY_EXHAUSTED).
    code: MentionDeliveryTerminalErrorCode,
    traceparent?: string,
  ): void {
    if (!msg.mentionDelivery) return;
    this.connection.send({
      type: "agent:delivery:terminal_error",
      agentId: msg.agentId,
      code,
      mentionDelivery: msg.mentionDelivery,
      ...(traceparent ? { traceparent } : {}),
    });
  }

  private rememberAcceptedStartDispatch(receipt: AgentStartAckMessage): void {
    this.acceptedStartDispatches.delete(receipt.startDispatchId);
    this.acceptedStartDispatches.set(receipt.startDispatchId, receipt);
    while (
      this.acceptedStartDispatches.size
      > DaemonCore.START_DISPATCH_RECEIPT_CACHE_SIZE
    ) {
      const oldest = this.acceptedStartDispatches.keys().next().value;
      if (typeof oldest !== "string") break;
      this.acceptedStartDispatches.delete(oldest);
    }
  }

  private sendStartDispatchReceipt(
    receipt: AgentStartAckMessage,
    outcome: "accepted" | "duplicate",
    startSpan: TraceContext,
  ): void {
    this.recordDaemonEvent("daemon.agent.start_dispatch.receipt", {
      agent_id: receipt.agentId,
      launch_id: receipt.launchId,
      start_dispatch_id: receipt.startDispatchId,
      queue_state: receipt.queueState,
      queue_depth: receipt.queueDepth,
      queue_age_ms: receipt.queueAgeMs,
      outcome,
    }, "ok", startSpan);
    this.connection.send({
      ...receipt,
      traceparent: formatTraceparent(startSpan),
    });
  }

  /**
   * RFC 071 outbox: route the agent manager's frames. Evidence frames get the
   * launch's `generation` and go through the outbox. A refusal for blocked
   * storage cannot be stored either, so it is sent best effort.
   */
  private routeAgentManagerFrame(msg: MachineToServerMessage, connection: DaemonConnection): void {
    if (!isOutboxFrame(msg)) {
      connection.send(msg);
      return;
    }
    const generation = this.launchGenerations.get(msg.agentId)?.get(msg.launchId);
    const frame = generation === undefined ? msg : { ...msg, generation };
    // Only to a server that acks: an older one does not understand the reason
    // (it gets no outbox frame; the refusal is queued like any other).
    if (this.serverAcksRuntimeOutcomes && frame.type === "agent:start:outcome" && frame.result.kind === "not_spawned"
      && frame.result.reason === "terminal_failure_outcome_storage_blocked") {
      connection.send(frame);
      return;
    }
    this.runtimeOutcomeOutbox.enqueue(frame);
  }

  private recordLaunchGeneration(msg: AgentStartMessage): void {
    if (!msg.launchId || msg.breakerGeneration === undefined) return;
    const byLaunch = this.launchGenerations.get(msg.agentId) ?? new Map<string, number>();
    byLaunch.set(msg.launchId, msg.breakerGeneration);
    while (byLaunch.size > 32) byLaunch.delete(byLaunch.keys().next().value!);
    this.launchGenerations.set(msg.agentId, byLaunch);
  }

  /**
   * RFC 071 outbox local refusal (see `RuntimeOutcomeOutbox.decideStart`).
   * A known storage failure or lost critical evidence refuses whatever
   * server is attached; only the ack-dependent parts (reserve, backlog-only
   * markers) need an acking server:
   *  - a start (human too) whose open request / epoch cannot be written, or
   *    (acks) with no reserve: `terminal_failure_outcome_storage_blocked`;
   *  - an AUTOMATIC start while the agent is unreliable, or has an un-acked
   *    marker of lost critical evidence no human takeover covers (any
   *    server), or (acks) a backlog-only marker: `terminal_failure_needs_manual`;
   *  - an admitted human start durably clears the unreliable state (the only
   *    way to clear it), records its takeover, and gets a recovery grant
   *    bound to its launch: the only thing that lets it through the spawn /
   *    rebind gate (passed explicitly to `startAgent`).
   */
  private localStartAdmission(msg: AgentStartMessage): OutboxStartAdmission {
    return this.runtimeOutcomeOutbox.admitServerStart(msg.agentId, {
      takeoverEpoch: msg.takeoverEpoch,
      humanStart: msg.humanStart,
      launchId: msg.launchId,
    });
  }

  private reportAgentStartFailure(msg: AgentStartMessage, err: unknown, startSpan?: TraceContext): void {
    if (err instanceof StaleDispatchError) {
      // task #365: already settled `stale_dispatch` where the process would
      // have been created; not a start failure, and the status stays as is.
      this.recordDaemonEvent("daemon.agent.start.stale_dispatch", {
        agentId: msg.agentId,
        launchId: msg.launchId,
        start_dispatch_id: msg.startDispatchId,
        checked_at: "spawn",
      }, "ok", startSpan);
      logger.warn(`[Agent ${msg.agentId}] Refused start ${msg.launchId ?? "(no launch)"} before spawning: claimed against an earlier connection`);
      return;
    }
    // RFC 071: a launch the process manager did not settle (spawned, rebound,
    // or its own not_spawned) failed here before any process existed.
    this.agentManager.settleServerStartNotSpawned(
      msg.agentId,
      msg.launchId,
      err instanceof LocalStartRefusedError || err instanceof OarOnlyStartError
        ? (err instanceof LocalStartRefusedError ? err.reason : err.notSpawnedReason)
        : "start_rejected",
    );
    const classification = classifySpawnFailure(err);
    logger.error(`[Agent ${msg.agentId}] Start failed (${classification.reason}): ${classification.detail}`);
    this.recordDaemonEvent("daemon.agent.spawn.failed", {
      agentId: msg.agentId,
      launchId: msg.launchId,
      start_dispatch_id: msg.startDispatchId,
      runtime: msg.config.runtime,
      model: msg.config.model,
      failure_reason: classification.reason,
      failure_classification: classification.reason === "runtime_spawn_failed"
        ? "unclassified_fallback"
        : "classified",
      session_id_present: Boolean(msg.config.sessionId),
      // The shown refusal text (with the way out) where this daemon refused the start itself.
      ...(err instanceof LocalStartRefusedError ? { local_refusal_detail: err.message } : {}),
      ...(err instanceof OarOnlyStartError ? { oar_only_host_reason: err.hostReason } : {}),
      // Variable names only, never values.
      ...(err instanceof AgentEnvVarsNotAllowedError
        ? { refused_variable_names: err.names.join(","), refused_invalid_name_count: err.invalidNameCount }
        : {}),
    }, "error", startSpan);
    // task #1123: the typed reason travels beside the human text so the web
    // picks copy by reason instead of parsing the detail string.
    this.agentManager.reportStartFailure(msg.agentId, msg.launchId, classification, msg.config.model);
  }

  /**
   * Reconciler step 11 (`agent:config`): the agent's current config. Dropped
   * when it is malformed or not newer than the last config applied for the
   * agent (AgentConfigRevisions: frames may arrive out of order); otherwise
   * the host that owns the agent takes it. Never a wake: a running session
   * whose runtime spec drifted is stopped once idle, and the next start runs
   * on the new config.
   */
  private handleAgentConfigMessage(msg: Extract<ServerToMachineMessage, { type: "agent:config" }>): void {
    const { agentId, revision } = msg;
    if (!msg.config || typeof msg.config !== "object" || typeof revision !== "number" || !Number.isFinite(revision)) {
      logger.warn(`[Agent ${agentId}] Ignoring malformed agent:config`);
      this.recordDaemonEvent("daemon.agent.config_push", { agentId, outcome: "malformed" }, "error");
      return;
    }
    if (!this.configRevisions.acceptPush(agentId, revision)) {
      const current = this.configRevisions.current(agentId);
      logger.info(`[Agent ${agentId}] Ignoring config revision ${revision}: revision ${current ?? "?"} already applied`);
      this.recordDaemonEvent("daemon.agent.config_push", { agentId, revision, current_revision: current, outcome: "stale_dropped" });
      return;
    }
    this.agentHosts.applyConfig?.(agentId, withConfigRevision(msg.config, revision), revision);
    this.localScheduleRuntime.noteMigrationReadiness(agentId, msg.config.migrationReadiness);
  }

  /**
   * Reconciler step 11d: the config revision each running agent applied, for
   * `ready`, so the server sends a push this daemon never got again. The
   * highest one applied (`AgentConfigRevisions.current`): an older start that
   * kept a newer pushed config reports the newer one, so the server never
   * re-sends what the daemon deliberately kept. Agents whose revision is
   * unknown (started by an older server, or before a daemon restart) are left
   * out.
   */
  private runningAgentConfigRevisions(runningAgentIds: readonly string[]): Record<string, number> {
    const revisions: Record<string, number> = {};
    for (const agentId of runningAgentIds) {
      const revision = this.configRevisions.current(agentId);
      if (revision !== undefined) revisions[agentId] = revision;
    }
    return revisions;
  }

  // One consumer span covers the whole start request, including duplicate
  // deliveries. It is passed down by value and never made active, because
  // the agent process started here outlives it.
  private handleAgentStartMessage(msg: AgentStartMessage): void {
    const span = this.tracer.startSpan("daemon.agent.start", {
      parent: parseTraceparent(msg.traceparent),
      surface: "daemon",
      kind: "consumer",
      attrs: {
        agent_id: msg.agentId,
        launch_id: msg.launchId,
        start_dispatch_id: msg.startDispatchId,
        runtime: msg.config.runtime,
        // The runtime CLI's own version as last detected (`runtime_version`
        // elsewhere is the daemon's), so starts can be grouped by it.
        runtime_cli_version: this.lastReadyRuntimeVersions[msg.config.runtime || "claude"] ?? undefined,
      },
    });
    const endWithFailure = (err: unknown) => {
      this.reportAgentStartFailure(msg, err, span.context);
      span.end("error", { attrs: { outcome: "failed", error_class: errorClassOf(err) } });
    };

    if (!msg.startDispatchId) {
      this.startAgentFromMessage(msg, span.context).then(
        () => span.end("ok", { attrs: { outcome: "started" } }),
        endWithFailure,
      );
      return;
    }

    const accepted = this.acceptedStartDispatches.get(msg.startDispatchId);
    if (accepted) {
      this.sendStartDispatchReceipt(accepted, "duplicate", span.context);
      span.end("ok", { attrs: { outcome: "duplicate" } });
      return;
    }
    const accepting = this.acceptingStartDispatches.get(msg.startDispatchId);
    if (accepting) {
      void accepting.then((receipt) => {
        this.sendStartDispatchReceipt(receipt, "duplicate", span.context);
        span.end("ok", { attrs: { outcome: "duplicate" } });
      }).catch((err: unknown) => {
        span.end("error", { attrs: { outcome: "duplicate_failed", error_class: errorClassOf(err) } });
      });
      return;
    }

    let resolveAccepted!: (receipt: AgentStartAckMessage) => void;
    let rejectAccepted!: (err: unknown) => void;
    const acceptance = new Promise<AgentStartAckMessage>((resolve, reject) => {
      resolveAccepted = resolve;
      rejectAccepted = reject;
    });
    // The first receipt path observes failure through startAgentFromMessage;
    // this promise exists only to fan acceptance out to duplicate deliveries.
    void acceptance.catch(() => {});
    this.acceptingStartDispatches.set(msg.startDispatchId, acceptance);
    this.startAgentFromMessage(msg, span.context, (receipt) => {
      this.rememberAcceptedStartDispatch(receipt);
      resolveAccepted(receipt);
      this.sendStartDispatchReceipt(receipt, "accepted", span.context);
    }).then(() => {
      span.end("ok", { attrs: { outcome: "started" } });
    }, (err: unknown) => {
      rejectAccepted(err);
      endWithFailure(err);
    }).finally(() => {
      this.acceptingStartDispatches.delete(msg.startDispatchId!);
    });
  }

  private async startAgentFromMessage(
    msg: AgentStartMessage,
    startSpan: TraceContext,
    onAccepted?: (receipt: AgentStartAckMessage) => void,
  ): Promise<void> {
    // RFC 071: from here this launch owes one final result (spawned, rebound,
    // or not_spawned); reportAgentStartFailure settles it if nothing else did.
    this.recordLaunchGeneration(msg);
    // A start refused at admission already has its result (`admission_full`).
    if (!this.agentManager.noteServerStartAccepted(msg.agentId, msg.launchId)) {
      this.reportAgentStartFailure(msg, new Error("Too many starts are still waiting for a result on this agent"), startSpan);
      return;
    }
    // task #365: an automatic start the server claimed against an earlier
    // connection (it left that replica before a reconnect, then arrived late)
    // must not create a process: the server may already have claimed another
    // start on this connection. Refused here at once when already stale; the
    // binding check is where the process is created (the process manager
    // re-checks after the credential mint and any start queue wait). Settled
    // `stale_dispatch` (never counted); the agent's status is left as it is,
    // since a current start may own it.
    const currentEpoch = this.agentManager.currentConnectionEpochId;
    const claimedEpoch = msg.type === "agent:start" ? msg.connectionEpochId : undefined;
    if (claimedEpoch && currentEpoch && claimedEpoch !== currentEpoch) {
      this.agentManager.settleServerStartNotSpawned(msg.agentId, msg.launchId, "stale_dispatch");
      this.recordDaemonEvent("daemon.agent.start.stale_dispatch", {
        agentId: msg.agentId,
        launchId: msg.launchId,
        start_dispatch_id: msg.startDispatchId,
      }, "ok", startSpan);
      logger.warn(`[Agent ${msg.agentId}] Refused start ${msg.launchId ?? "(no launch)"}: claimed against an earlier connection`);
      return;
    }
    // Before admission, so a start no host here can run takes no recovery grant.
    if (!this.oarHostEnabled) {
      const oarOnlyRefusal = oarOnlyStartWithoutOarHost(msg.config.runtime);
      if (oarOnlyRefusal) throw oarOnlyRefusal;
    }
    // RFC 071 outbox local refusal: before the agent counts as starting, so a
    // refused start leaves no starting state behind.
    const admission = this.localStartAdmission(msg);
    if (admission.refusal) throw new LocalStartRefusedError(admission.refusal);
    const recoveryGrant = admission.recoveryGrant;
    this.coreStartingAgentIds.add(msg.agentId);
    // Reminder sync fallback: a starting agent may own reminders that no
    // connect-time snapshot covered (e.g. it arrived by migration after this
    // connection was established). Guarded no-op when already synchronized.
    this.localScheduleRuntime.requestReminderSnapshotIfUnsynchronized(msg.agentId);
    this.localScheduleRuntime.requestAppConfigSnapshotIfMissing(msg.agentId);
    let wakeDeliveryAck: AgentDeliverMessage | null = null;
    let replayDeliveries: AgentDeliverMessage[] = [];
    try {
      this.observeRuntimeContext(msg.config);
      // #wg-rbac:#27: a start the hosts will rebind onto a running (or
      // starting, queued) launch runs on that launch's credential, so none is
      // minted for it; a minted one nothing used would stay valid. Decided
      // with no wait before `startAgent`, as the hosts decide. Should the host
      // still start it afresh, the spawn mints one (`buildSpawnConfig`); a
      // start minted here that ends up rebound is revoked by the host.
      const agentCredential = this.agentHosts.holdsAgentStart(msg.agentId)
        ? null
        : await this.mintRunnerCredential(msg.agentId, msg.config, startSpan);
      // task #1357 item 1: the config carries its revision into every copy,
      // so a Pi session reports the revision it was built from.
      const startConfig = withConfigRevision(msg.config, msg.type === "agent:start" ? msg.configRevision : undefined);
      const config = agentCredential
        ? { ...startConfig, agentCredentialKey: agentCredential.apiKey, agentCredentialId: agentCredential.credentialId }
        : startConfig;

      const pendingDeliveries = this.coreStartPendingDeliveries.get(msg.agentId) || [];
      this.coreStartPendingDeliveries.delete(msg.agentId);
      let wakeMessage = msg.wakeMessage;
      let wakeMessageTransient = msg.wakeMessageTransient ?? false;
      replayDeliveries = [...pendingDeliveries];
      if (!wakeMessage) {
        const wakeIndex = selectWakeDeliveryIndex(replayDeliveries);
        if (wakeIndex >= 0) {
          const [wakeDelivery] = replayDeliveries.splice(wakeIndex, 1);
          if (wakeDelivery) {
            wakeDeliveryAck = wakeDelivery;
            wakeMessage = wakeDelivery.message;
            wakeMessageTransient = wakeDelivery.transient ?? false;
          }
        }
      }

      // Reconciler step 11: this start's config is as new as its revision.
      this.configRevisions.noteStart(msg.agentId, msg.type === "agent:start" ? msg.configRevision : undefined, config);
      // A start older than an applied config keeps that config's readiness.
      if (!this.configRevisions.isStaleStart(config)) {
        this.localScheduleRuntime.noteMigrationReadiness(msg.agentId, msg.config.migrationReadiness);
      }
      const startPromise = this.agentHosts.startAgent(
        msg.agentId,
        config,
        wakeMessage,
        msg.unreadSummary,
        msg.resumePrompt,
        msg.launchId,
        wakeMessageTransient,
        msg.resumeMessages,
        msg.startDispatchId,
        startSpan,
        msg.catchupBatchId,
        recoveryGrant,
        claimedEpoch ?? null,
      );
      if (msg.startDispatchId) {
        const acceptance = this.agentHosts.getAgentStartAcceptance(msg.agentId);
        // Machine-local evidence for the dispatch → ack → frame chain (#1129):
        // the runner log must show which launch this daemon acknowledged.
        logger.info(
          `[Agent ${msg.agentId}] Start accepted ` +
          `(launchId=${msg.launchId ?? "none"}, dispatchId=${msg.startDispatchId}, queue=${acceptance.queueState})`,
        );
        onAccepted?.({
          type: "agent:start:ack",
          agentId: msg.agentId,
          launchId: msg.launchId,
          startDispatchId: msg.startDispatchId,
          queueState: acceptance.queueState,
          queueDepth: acceptance.queueDepth,
          queueAgeMs: acceptance.queueAgeMs,
          ...(acceptance.processInstanceId ? { processInstanceId: acceptance.processInstanceId } : {}),
        });
      }
      await startPromise;

      this.coreStartingAgentIds.delete(msg.agentId);
      if (wakeDeliveryAck && !wakeDeliveryAck.mentionDelivery) {
        this.sendDeliveryAck(wakeDeliveryAck);
      }
      for (const delivery of replayDeliveries) {
        this.handleMessage(delivery);
      }
    } catch (err) {
      this.coreStartPendingDeliveries.delete(msg.agentId);
      // A start that failed before its gate cannot keep its grant.
      this.runtimeOutcomeOutbox.releaseRecoveryGrant(recoveryGrant);
      throw err;
    } finally {
      this.coreStartingAgentIds.delete(msg.agentId);
    }
  }

  private handleMessage(msg: ServerToMachineMessage) {
    const summary = summarizeIncomingMessage(msg);
    logger.info(`[Daemon] Received ${msg.type}${summary ? ` ${summary}` : ""}`);
    // Every agent message names a workspace as path.join(dataDir, agentId)
    // (start, reset = rm -rf, workspace read/list, migration import): an id
    // that is not one path segment would reach outside dataDir.
    const unsafeAgentId = unsafeAgentIdOf(msg);
    if (unsafeAgentId !== null) {
      logger.warn(`[Daemon] Refused ${msg.type}: agentId is not a single path segment`);
      this.recordDaemonEvent("daemon.server_message.unsafe_agent_id", {
        message_type: msg.type,
        agent_id_length: unsafeAgentId.length,
      }, "error");
      return;
    }
    if (this.localScheduleRuntime.handleServerMessage(msg)) return;

    switch (msg.type) {
      case "machine:context":
        this.bindAuthenticatedMachineContext(msg);
        this.observeServerContextCapabilities(msg.capabilities ?? []);
        // Additive: an older server omits it (off). Each context restates it.
        this.serverPrivacyMode = msg.privacyMode === true;
        this.applyServerTraceUploadUrl(msg.traceUploadUrl);
        // RFC 071 outbox: deliver only to a server that acknowledges; an older
        // server (or a context conflict) pauses delivery and keeps the queue.
        this.serverAcksRuntimeOutcomes = !this.machineContextConflict
          && (msg.capabilities ?? []).includes(SERVER_CAPABILITY_RUNTIME_OUTCOME_ACK_V1);
        this.runtimeOutcomeOutbox.onServerContext(this.serverAcksRuntimeOutcomes);
        // Agent typing line: send intents only to a server that reads them.
        this.agentManager.setServerSendIntentCapable?.(!this.machineContextConflict
          && (msg.capabilities ?? []).includes(SERVER_CAPABILITY_AGENT_SEND_INTENT_V1));
        // Task writes attest by landing only to a server that checks by landing.
        setAgentProxyServerChecksTaskWriteLanding(!this.machineContextConflict
          && (msg.capabilities ?? []).includes(SERVER_CAPABILITY_TASK_WRITE_LANDING_V1));
        // First-turn ends (unread the agent owes nothing in): only to a server that reads them.
        this.agentHosts.setServerTurnEndedCapable?.(!this.machineContextConflict
          && (msg.capabilities ?? []).includes(SERVER_CAPABILITY_TURN_ENDED_V1));
        // Reconciler step 12: the start-failure reasons of a runtime that failed after it started.
        this.agentHosts.setServerStickyFailureReasonsCapable?.(!this.machineContextConflict
          && (msg.capabilities ?? []).includes(SERVER_CAPABILITY_STICKY_FAILURE_REASONS_V1));
        // Idle task reminder: asked only of a server that has the route.
        this.localScheduleRuntime.setServerIdleTaskReminderCapable(!this.machineContextConflict
          && (msg.capabilities ?? []).includes(SERVER_CAPABILITY_IDLE_TASK_REMINDER_V1));
        {
          // task #17: status queries run only for a server that reads the
          // report, and only for the runtimes it reads (an older server
          // refuses a report naming any other).
          const reads = runtimeAuthRuntimesReadBy(this.machineContextConflict ? [] : (msg.capabilities ?? []));
          const newlyReads = reads !== null && reads !== this.serverRuntimeAuthRuntimes;
          this.serverRuntimeAuthRuntimes = reads;
          if (newlyReads && this.runtimeAuthInventory) this.reportRuntimeAuthStatus("context", this.runtimeAuthInventory);
          this.serverReadsRuntimeCredentialsChanged = !this.machineContextConflict
            && (msg.capabilities ?? []).includes(SERVER_CAPABILITY_RUNTIME_CREDENTIALS_CHANGED_V1);
          this.syncSharedCredentialWatch();
        }
        // #proj-raft-computer:#68: the readiness snapshot on every connect to a server that reads it.
        this.serverReadsRuntimeReadiness = !this.machineContextConflict
          && (msg.capabilities ?? []).includes(SERVER_CAPABILITY_RUNTIME_READINESS_V1);
        this.sendRuntimeReadiness();
        // task #365: a proven never-created child is reported as `spawn_error`
        // only to a server that counts it AND acks outbox frames (the report
        // travels in the outbox; without acks it would sit there while the
        // crash report that feeds the #1119 breaker is gone). Automatic
        // starts claimed against another connection are refused (see
        // startAgentFromMessage).
        this.agentManager.setServerStartContext({
          spawnErrorCapable: this.serverAcksRuntimeOutcomes
            && (msg.capabilities ?? []).includes(SERVER_CAPABILITY_START_SPAWN_ERROR_V1),
          connectionEpochId: typeof msg.connectionEpochId === "string" && msg.connectionEpochId ? msg.connectionEpochId : null,
        });
        // Flag changes are not replayed after a disconnect, so every
        // (re)connect to a server that answers asks once (after a random delay).
        this.serverFeaturesCapable = !this.machineContextConflict
          && (msg.capabilities ?? []).includes(SERVER_CAPABILITY_SERVER_FEATURES_V1);
        this.agentManager.setServerFeaturesCapable?.(this.serverFeaturesCapable);
        if (this.serverFeaturesCapable) {
          this.serverFeaturesRefresh.schedule();
        } else {
          // No answers from this server (or a context for another one):
          // the last one no longer says anything about its starts.
          this.serverFeaturesRefresh.reset();
          this.agentManager.forgetServerFeatures?.();
        }
        break;

      // A flag affecting this server may have changed (shared featuresChanged.ts):
      // ask for the current values. Only for the server this connection is bound to.
      case "server:features-changed":
        if (this.serverFeaturesCapable && msg.serverId === this.boundServerId()) this.serverFeaturesRefresh.schedule();
        break;

      case "server:features": {
        const boundServerId = this.boundServerId();
        const outstanding = this.serverFeaturesRefresh.outstandingRequest;
        const features = this.serverFeaturesRefresh.acceptReply(msg, boundServerId);
        if (!features) {
          logger.warn(`[Daemon] Ignoring server:features (request ${String(msg.requestId).slice(0, 8)}, server ${String(msg.serverId).slice(0, 8)}): not the answer to the latest request on this connection's server`);
          break;
        }
        this.recordDaemonEvent("daemon.server_features.received", {
          enabled_apps_count: features.enabledApps?.length ?? 0,
          ...(outstanding ? { waited_ms: currentTimeMs() - outstanding.sentAtMs } : {}),
        });
        // Both hosts (the router hands it to each): a session that started
        // on other values is stopped once idle (reconciler step 6).
        this.agentHosts.applyServerFeatures?.(features);
        break;
      }

      case "machine:host_identity:request":
        void this.replyHostIdentity();
        break;

      case "agent:outcome:ack":
        this.runtimeOutcomeOutbox.ack(msg);
        break;

      case "agent:start":
        this.observeRuntimeContext(msg.config);
        logger.info(`[Agent ${msg.agentId}] Start requested (runtime=${msg.config.runtime}, model=${msg.config.model}, session=${msg.config.sessionId || "new"}${msg.wakeMessage ? ", wake=true" : ""})`);
        this.handleAgentStartMessage(msg);
        break;

      case "agent:config":
        this.handleAgentConfigMessage(msg);
        break;

      case "agent:stop": {
        // `reason` is additive (a server that predates it sends none); read
        // it as an optional string, so any other value reads as `lifecycle`.
        const stopReason = procStopReasonForAgentStop((msg as { reason?: unknown }).reason);
        logger.info(`[Agent ${msg.agentId}] Stop requested${stopReason ? ` (${stopReason})` : ""}`);
        this.agentHosts.stopAgent(msg.agentId);
        // `raft proc`: the owner's Stop, a delete or a migration ends the
        // agent's jobs; a lifecycle stop (or no reason) leaves them running.
        if (stopReason) void this.stopProcJobsForAgent(msg.agentId, stopReason);
        break;
      }

      case "agent:interrupt-turn": {
        // task #25 step 2: a person stopped this turn; the agent keeps running.
        logger.info(`[Agent ${msg.agentId}] Stop of the current turn requested`);
        const { agentId, requestId } = msg;
        void this.agentHosts.interruptTurn(agentId).then(
          (result) => this.connection.send({ type: "agent:interrupt-turn:result", agentId, requestId, ...result }),
          (error: unknown) => {
            logger.warn(`[Agent ${agentId}] Stopping the current turn failed: ${error instanceof Error ? error.message : String(error)}`);
            this.connection.send({ type: "agent:interrupt-turn:result", agentId, requestId, outcome: "not_running" });
          },
        );
        break;
      }

      case "agent:interrupt-subagent": {
        // #proj-runtime:#41: a person stopped one sub-agent; the agent keeps running.
        const { agentId, requestId, subagentTaskId } = msg;
        logger.info(`[Agent ${agentId}] Stop of a sub-agent requested`);
        void this.agentHosts.interruptSubagent(agentId, subagentTaskId).then(
          (outcome) => this.connection.send({ type: "agent:interrupt-subagent:result", agentId, requestId, outcome }),
          (error: unknown) => {
            logger.warn(`[Agent ${agentId}] Stopping a sub-agent failed: ${error instanceof Error ? error.message : String(error)}`);
            this.connection.send({ type: "agent:interrupt-subagent:result", agentId, requestId, outcome: "not_running" });
          },
        );
        break;
      }

      case "agent:wake:outcome":
        this.agentManager.handleServerWakeOutcome(msg);
        break;

      case "agent:reset-workspace":
        logger.info(`[Agent ${msg.agentId}] Workspace reset requested`);
        this.agentManager.resetWorkspace(msg.agentId);
        break;

      case "agent:inbox:purge":
        logger.info(`[Agent ${msg.agentId}] Inbox purge requested (${msg.channelIds.length} channels, reason=${msg.reason || "server_purge"})`);
        this.agentHosts.purgeInboxMessagesForChannels(msg.agentId, msg.channelIds, msg.reason || "server_purge");
        break;

      case "agent:deliver":
      {
        // Task #1295: a re-send of a plain delivery this daemon already acked
        // (the ack was late, not lost) gets the ack again and nothing else.
        // Mentions have their own duplicate_pending handling.
        if (!msg.mentionDelivery && msg.deliveryId && this.recentlyAckedDeliveryIds.has(msg.deliveryId, Date.now())) {
          this.sendDeliveryAck(msg, msg.traceparent);
          break;
        }
        const parent = parseTraceparent(msg.traceparent);
        const span = this.tracer.startSpan("daemon.agent.delivery", {
          parent,
          surface: "daemon",
          kind: "consumer",
          attrs: {
            agentId: msg.agentId,
            deliveryId: msg.deliveryId,
            delivery_correlation_id: msg.deliveryId ?? msg.message.message_id,
            messageId: msg.message.message_id,
            message_id_present: Boolean(msg.message.message_id),
            seq: msg.seq,
          },
        });
        logger.info(`[Agent ${msg.agentId}] Delivery received (seq=${msg.seq}, from=@${msg.message.sender_name}, target=${formatChannelTarget(msg)})`);
        try {
          span.addEvent("daemon.receive", { seq: msg.seq, deliveryId: msg.deliveryId });
          if (msg.mentionDelivery) {
            const machineId = this.authenticatedMachineContext?.machineId ?? this.observedMachineId;
            if (
              !machineId
              || msg.mentionDelivery.machineId !== machineId
              || msg.mentionDelivery.occurrenceId !== msg.deliveryId
              || msg.mentionDelivery.messageId !== msg.message.message_id
            ) {
              this.sendMentionDeliveryTerminalError(
                msg,
                machineId && msg.mentionDelivery.machineId !== machineId ? "IDENTITY_DRIFT" : "INSTRUMENT_FAILED",
                formatTraceparent(span.context),
              );
              span.end("ok", { attrs: { outcome: "mention-identity-rejected" } });
              break;
            }
          }
          if (this.coreStartingAgentIds.has(msg.agentId)) {
            const pending = this.coreStartPendingDeliveries.get(msg.agentId) || [];
            pending.push(msg);
            this.coreStartPendingDeliveries.set(msg.agentId, pending);
            span.addEvent("daemon.delivery.buffered_for_start", { pending_count: pending.length });
            span.end("ok", { attrs: { outcome: "buffered-for-start", pending_count: pending.length } });
            break;
          }

          // The routing facts the agent manager records for this delivery
          // (`daemon.agent.delivery.routed`, consumption, stdin retries) belong
          // under this span. Work that outlives the delivery, such as an idle
          // auto-restart spawn, leaves the scope inside the agent manager.
          const acceptedOrPromise = runWithActiveSpan(span, () => this.agentHosts.deliverMessage(msg.agentId, msg.message, {
            deliveryId: msg.deliveryId,
            transient: msg.transient ?? false,
            mentionDelivery: msg.mentionDelivery,
            onMentionTransition: (stage, outcome) => this.sendMentionDeliveryTransition(
              msg,
              stage,
              outcome,
              formatTraceparent(span.context),
            ),
            onMentionTerminalError: (code) => this.sendMentionDeliveryTerminalError(
              msg,
              code,
              formatTraceparent(span.context),
            ),
            onMentionAck: () => this.sendDeliveryAck(msg, formatTraceparent(span.context)),
            onRejectedNoProcess: () => this.sendDeliveryRejectedNoProcess(msg, formatTraceparent(span.context)),
          }));
          Promise.resolve(acceptedOrPromise).then((accepted) => {
            span.addEvent("daemon.deliver_to_agent_manager", { accepted });
            if (!accepted) {
              span.end("ok", { attrs: { outcome: "not-accepted" } });
              return;
            }
            if (msg.mentionDelivery) {
              span.end("ok", { attrs: { outcome: "mention-accepted-awaiting-terminal-ack", deliveryId: msg.deliveryId } });
              return;
            }
            const ackSeq = msg.seq > 0 ? msg.seq : msg.message.seq ?? 0;
            span.addEvent("daemon.ack.sent", { seq: ackSeq });
            this.sendDeliveryAck(msg, formatTraceparent(span.context));
            if (msg.deliveryId) this.recentlyAckedDeliveryIds.remember(msg.deliveryId, Date.now());
            span.end("ok", { attrs: { outcome: "ack-sent", ackSeq, deliveryId: msg.deliveryId } });
          }, (err: unknown) => {
            logger.error(`[Agent ${msg.agentId}] Delivery handling failed`, err);
            span.end("error", { attrs: { error_class: errorClassOf(err) } });
          });
        } catch (err) {
          span.end("error", { attrs: { error_class: errorClassOf(err) } });
          throw err;
        }
        break;
      }

      case "agent:runtime_profile:migration": {
        const span = this.tracer.startSpan("daemon.runtime_profile.control.received", {
          parent: parseTraceparent(msg.traceparent),
          surface: "daemon",
          kind: "consumer",
          attrs: {
            agentId: msg.agentId,
            control_kind: "migration",
            key_present: Boolean(msg.migrationKey),
            launchId: msg.launchId || undefined,
          },
        });
        logger.info(`[Agent ${msg.agentId}] Runtime profile migration received (${msg.migrationKey})`);
        Promise.resolve(
          this.agentHosts.deliverRuntimeProfileNotification(msg.agentId, msg.migrationKey, "migration", msg.message, formatTraceparent(span.context), msg.launchId || null),
        ).then((accepted) => {
          span.end("ok", { attrs: { outcome: accepted ? "accepted" : "no_injection_path" } });
        }, (err: unknown) => {
          logger.error(`[Agent ${msg.agentId}] Runtime profile migration handling failed`, err);
          span.end("error", { attrs: { error_class: errorClassOf(err) } });
        });
        break;
      }

      case "agent:runtime_profile:daemon_release_notice": {
        const span = this.tracer.startSpan("daemon.runtime_profile.control.received", {
          parent: parseTraceparent(msg.traceparent),
          surface: "daemon",
          kind: "consumer",
          attrs: {
            agentId: msg.agentId,
            control_kind: "daemon_release_notice",
            key_present: Boolean(msg.noticeKey),
            launchId: msg.launchId || undefined,
          },
        });
        logger.info(`[Agent ${msg.agentId}] Runtime profile daemon release notice received (${msg.noticeKey})`);
        Promise.resolve(
          this.agentHosts.deliverRuntimeProfileNotification(msg.agentId, msg.noticeKey, "daemon_release_notice", msg.message, formatTraceparent(span.context), msg.launchId || null),
        ).then((accepted) => {
          span.end("ok", { attrs: { outcome: accepted ? "accepted" : "no_injection_path" } });
        }, (err: unknown) => {
          logger.error(`[Agent ${msg.agentId}] Runtime profile daemon release notice handling failed`, err);
          span.end("error", { attrs: { error_class: errorClassOf(err) } });
        });
        break;
      }

      case "agent:workspace:list":
        this.agentManager.getFileTree(msg.agentId, msg.dirPath, Boolean(msg.includeHidden)).then((files) => {
          this.connection.send({ type: "agent:workspace:file_tree", agentId: msg.agentId, files, dirPath: msg.dirPath, includeHidden: Boolean(msg.includeHidden) });
        });
        break;

      case "agent:workspace:read":
        this.agentManager.readFile(msg.agentId, msg.path).then(({ content, binary, size, mimeType, encoding }) => {
          this.connection.send({
            type: "agent:workspace:file_content",
            agentId: msg.agentId,
            requestId: msg.requestId,
            content,
            binary,
            size,
            mimeType,
            encoding,
          });
        }).catch(() => {
          this.connection.send({
            type: "agent:workspace:file_content",
            agentId: msg.agentId,
            requestId: msg.requestId,
            content: null,
            binary: false,
            size: 0,
          });
        });
        break;

      case "agent:skills:list":
      {
        const span = this.tracer.startSpan("daemon.agent.skills.list", {
          surface: "daemon",
          kind: "internal",
          attrs: {
            agent_id: msg.agentId,
            runtime: msg.runtime || "auto",
            request_id_present: Boolean(msg.requestId),
            ...(msg.requestId ? { request_id: msg.requestId } : {}),
          },
        });
        this.agentManager.listSkills(msg.agentId, msg.runtime).then(({ global, workspace }) => {
          this.connection.send({ type: "agent:skills:list_result", agentId: msg.agentId, requestId: msg.requestId, global, workspace });
          span.end("ok", {
            attrs: {
              outcome: "skills_returned",
              global_count: global.length,
              workspace_count: workspace.length,
            },
          });
        }).catch((err: unknown) => {
          logger.error(`[Daemon] Failed to list skills for ${msg.agentId}`, err);
          this.connection.send({ type: "agent:skills:list_result", agentId: msg.agentId, requestId: msg.requestId, global: [], workspace: [] });
          span.end("error", {
            attrs: {
              outcome: "skills_list_failed",
              error_class: errorClassOf(err),
            },
          });
        });
        break;
      }

      case "agent:diagnostic:session_transcript":
        this.agentManager.getSessionTranscript(msg.agentId).then((result) => {
          this.connection.send({ type: "agent:diagnostic:session_transcript_result", agentId: msg.agentId, requestId: msg.requestId, ...result });
        }).catch((err: unknown) => {
          logger.error(`[Daemon] Failed to get session transcript for ${msg.agentId}`, err);
          this.connection.send({
            type: "agent:diagnostic:session_transcript_result",
            agentId: msg.agentId,
            requestId: msg.requestId,
            runtime: "unknown",
            sessionId: "unknown",
            reachable: false,
            path: null,
            transcript: null,
            sizeBytes: 0,
            truncated: false,
            redacted: false,
            tier: "unknown",
            error: err instanceof Error ? err.message : String(err),
          });
        });
        break;

      case "agent:diagnostic:feedback_transcript": {
        // task #1228 ①: collect → send the result frame → only then upload the
        // transcript_outcome object (best-effort, never retried, never able to
        // delay or rewrite the result).
        // RAFT_PRIVACY_MODE: nothing is collected or uploaded; the server gets
        // the collector's own error result (reachable: false) and nothing else.
        const privacyMode = this.privacyModeOn();
        const daemonVersion = readBakedDaemonVersion();
        const reportGeneratedAt = msg.feedbackReportGeneratedAt ?? currentDate().toISOString();
        void runFeedbackTranscriptRequest({
          collect: privacyMode ? async () => feedbackTranscriptCollectorErrorResult(FEEDBACK_TRANSCRIPT_PRIVACY_MODE_ERROR) : () => this.agentManager.collectFeedbackTranscript(msg.agentId, msg.feedbackReportId, {
            reportGeneratedAt,
            reportTimeSource: msg.feedbackReportTimeSource ?? "server_request_received",
          }, {
            serverLookup: feedbackTranscriptSessionLookupFromFrame(msg.sessionLookup),
            includeMachineLogTail: msg.includeMachineLogTail === true,
            machineLogPaths: this.runnerLogPathCandidates(),
            daemonVersion,
            requestId: msg.requestId,
          }),
          send: (result) => {
            this.connection.send({
              type: "agent:diagnostic:feedback_transcript_result",
              agentId: msg.agentId,
              feedbackReportId: msg.feedbackReportId,
              requestId: msg.requestId,
              ...result,
            });
          },
          uploadOutcome: (result) => this.agentManager.uploadFeedbackTranscriptOutcome(
            msg.agentId,
            msg.feedbackReportId,
            msg.requestId,
            result,
            daemonVersion ?? null,
          ),
          // task #1230: own budget, after the frame; never awaited here.
          uploadAgentEventTail: () => this.agentManager.uploadFeedbackAgentEventTail(
            msg.agentId,
            msg.feedbackReportId,
            msg.requestId,
            reportGeneratedAt,
          ),
          workerConfigured: !privacyMode && this.agentManager.feedbackUploadsConfigured,
          tag: `report=${msg.feedbackReportId} agent=${msg.agentId} request=${msg.requestId}`,
        });
        break;
      }

      case "agent:context_view_request":
      case "agent:context_search_request":
        // View Context v0, and an agent's search or read of a context:
        // answered by at most one result POST (never a frame); the manager
        // validates the frame and never throws.
        void this.agentManager.handleAgentContextViewRequest?.(msg);
        break;

      case "agent:activity_probe":
        // Server is asking for ground-truth current activity. Echo
        // back via the same `agent:activity` upstream channel,
        // tagged with the probeId so server can correlate. Keeps
        // this surface unobtrusive: probe response goes through the
        // existing ingest pipeline, with launch-guard / lifecycle
        // checks intact. See agentProcessManager.respondToActivityProbe.
        this.agentHosts.respondToActivityProbe(msg.agentId, msg.probeId);
        break;

      case "machine:workspace:scan":
        logger.info("[Daemon] Scanning all workspace directories");
        this.agentManager.scanAllWorkspaces().then((directories) => {
          this.connection.send({ type: "machine:workspace:scan_result", directories });
        });
        break;

      case "machine:workspace:delete":
        logger.info(`[Daemon] Deleting workspace directory: ${msg.directoryName}`);
        this.agentManager.deleteWorkspaceDirectory(msg.directoryName).then((success) => {
          if (success) {
            this.localScheduleRuntime.onAgentWorkspaceDeleted(msg.directoryName);
            // A workspace directory is named by its agent id: the agent is gone.
            void this.stopProcJobsForAgent(msg.directoryName, "agent_deleted");
          }
          this.connection.send({ type: "machine:workspace:delete_result", directoryName: msg.directoryName, success });
        });
        break;

      // Re-detect installed runtimes on demand. `emitReady` already re-runs the
      // detector and pushes the fresh capabilities, and the server fans those out
      // as `machine:capabilities` — so re-emitting IS the answer, no bespoke
      // result message needed.
      case "machine:runtimes:rescan":
        this.rescanRuntimes();
        break;

      case "machine:migration:source_workspace_archive": {
        void this.archiveMigrationSourceWorkspaceSerialized(msg.agentId, msg.migrationId, msg.migrationCreatedAt).then(
          (outcome) => {
            this.connection.send({
              type: "machine:migration:source_workspace_archive_result",
              requestId: msg.requestId,
              migrationId: msg.migrationId,
              agentId: msg.agentId,
              outcome,
            });
          },
          (error: unknown) => {
            logger.error(`[Daemon] Failed to archive migrated workspace for ${msg.agentId}`, error);
            const errorCode = migrationTransferFailureDetailCode(error);
            this.connection.send({
              type: "machine:migration:source_workspace_archive_result",
              requestId: msg.requestId,
              migrationId: msg.migrationId,
              agentId: msg.agentId,
              outcome: "error",
              ...(errorCode ? { errorCode } : {}),
            });
          },
        );
        break;
      }

      case "machine:provider_probe:request": {
        void this.handleProviderProbe(msg);
        break;
      }

      case "machine:runtime_models:detect": {
        const driver = getDriver(msg.runtime);
        const span = this.tracer.startSpan("daemon.runtime_models.detect", {
          surface: "daemon",
          kind: "internal",
          attrs: {
            runtime: msg.runtime,
            request_id: msg.requestId,
          },
        });
        const joinedInFlight = this.probeGate.activeKeys.includes(`runtime_models:${msg.runtime}`);
        const detect = this.readRuntimeModelOutcome(msg.runtime, span, msg.force === true);
        void detect.then(({ outcome: detectedOutcome, cache }) => {
          const resultMessage = buildRuntimeModelSourceResultMessage(
            msg.requestId,
            detectedOutcome,
            driver?.model.detectedModelsVerifiedAs ?? "suggestion_only",
          );
          const outcome = resultMessage.outcome!;
          this.connection.send(resultMessage);
          if (outcome.kind === "live") {
            span.end("ok", {
              attrs: {
                outcome: "models_returned",
                models_count: outcome.value.models.length,
                joined_in_flight: joinedInFlight,
                cache,
                default_model_present: Boolean(outcome.value.default),
                verified_as: driver?.model.detectedModelsVerifiedAs ?? "suggestion_only",
              },
            });
          } else {
            span.end("ok", {
              attrs: {
                outcome: outcome.kind,
                models_count: 0,
                joined_in_flight: joinedInFlight,
                cache,
              },
            });
          }
        }).catch((err: unknown) => {
          const reason = err instanceof Error ? err.message : String(err);
          this.connection.send({
            type: "machine:runtime_models:result",
            requestId: msg.requestId,
            outcome: { kind: "error", retryable: true },
            error: reason,
          });
          span.end("error", {
            attrs: {
              outcome: "error",
              error_class: errorClassOf(err),
            },
          });
        });
        break;
      }

      // task #17: every field is checked here; anything malformed is dropped
      // (a code is never echoed into a log or a trace, valid or not).
      case "machine:runtime_auth:login:start": {
        const loginId = typeof msg.loginId === "string" ? asRuntimeAuthLoginId(msg.loginId) : null;
        // Kimi's start carries the region the person chose, and no other runtime's does;
        // Pi's and OpenCode's the provider to sign in, and no other runtime's does;
        // OpenCode's may name the OAuth method the person chose.
        if (!loginId || !isRuntimeAuthRuntime(msg.runtime) || !runtimeAuthLoginRegionFits(msg.runtime, msg.region)
          || !runtimeAuthProviderIdFits(msg.runtime, msg.providerId) || !runtimeAuthOAuthMethodFits(msg.runtime, msg.oauthMethod)) {
          this.recordDaemonEvent("daemon.runtime_auth.message_dropped", { type: msg.type });
          break;
        }
        this.runtimeAuth.startLogin(loginId, msg.runtime, msg.region, msg.providerId, msg.oauthMethod);
        break;
      }
      case "machine:runtime_auth:login:code": {
        const loginId = typeof msg.loginId === "string" ? asRuntimeAuthLoginId(msg.loginId) : null;
        if (!loginId || !isRuntimeAuthPastedCode(msg.code)) {
          this.recordDaemonEvent("daemon.runtime_auth.message_dropped", { type: msg.type });
          break;
        }
        this.runtimeAuth.submitCode(loginId, msg.code);
        break;
      }
      case "machine:runtime_auth:login:cancel": {
        const loginId = typeof msg.loginId === "string" ? asRuntimeAuthLoginId(msg.loginId) : null;
        if (!loginId) {
          this.recordDaemonEvent("daemon.runtime_auth.message_dropped", { type: msg.type });
          break;
        }
        this.runtimeAuth.cancelLogin(loginId);
        break;
      }
      case "machine:runtime_auth:logout":
        if (!isRuntimeAuthRequestId(msg.requestId) || !isRuntimeAuthRuntime(msg.runtime) || !runtimeAuthProviderIdFits(msg.runtime, msg.providerId)) {
          this.recordDaemonEvent("daemon.runtime_auth.message_dropped", { type: msg.type });
          break;
        }
        void this.runtimeAuth.logout(msg.requestId, msg.runtime, msg.providerId);
        break;
      case "machine:runtime_auth:providers":
        if (!isRuntimeAuthRequestId(msg.requestId) || !isRuntimeAuthRuntime(msg.runtime) || !runtimeAuthSupports(msg.runtime, "connect_provider")) {
          this.recordDaemonEvent("daemon.runtime_auth.message_dropped", { type: msg.type });
          break;
        }
        void this.runtimeAuth.listProviders(msg.requestId, msg.runtime);
        break;
      case "machine:runtime_auth:connect_provider": {
        // The message carries a provider's API key. It is checked field by
        // field (no parser error can quote it), handed to the auth host, and
        // dropped from the message, so nothing that reads `msg` later (an
        // error report, a log) can reach it. Never logged or traced, valid or not.
        const input = parseRuntimeAuthProviderConnectInput(msg);
        Reflect.deleteProperty(msg, "apiKey");
        if (!input.ok || !isRuntimeAuthRequestId(msg.requestId) || !isRuntimeAuthRuntime(msg.runtime) || !runtimeAuthSupports(msg.runtime, "connect_provider")) {
          this.recordDaemonEvent("daemon.runtime_auth.message_dropped", { type: msg.type });
          break;
        }
        void this.runtimeAuth.connectProvider(msg.requestId, msg.runtime, input.input);
        break;
      }

      case "machine:runtime_account_usage:refresh": {
        const provider: RuntimeAccountUsageProvider = msg.provider;
        void this.probeGate.run(`runtime_account_usage:${provider}`, () => this.runtimeAccountUsageCollector(provider)).then((snapshot: RuntimeAccountUsageSnapshot) => {
          this.connection.send({
            type: "machine:runtime_account_usage:snapshot",
            requestId: msg.requestId,
            snapshot: this.snapshotForServer(snapshot),
          });
          this.recordDaemonEvent("daemon.runtime_account_usage.refresh", {
            outcome: "snapshot_sent",
            provider,
            reason: msg.reason,
            account_count: snapshot.accounts.length,
            window_count: snapshot.accounts.reduce((total, account) => total + account.windows.length, 0),
            health_classes: [...new Set(snapshot.accounts.map((account) => account.health))].sort().join(",") || "none",
            parse_unavailable_count: snapshot.accounts.reduce(
              (total, account) => total + account.windows.filter((window) => window.status === "parse_unavailable").length,
              0,
            ),
            ...limitResetsAvailableAttr(snapshot),
          });
        }).catch((err: unknown) => {
          logger.warn(`[Daemon] Runtime account usage refresh failed (${provider}): ${err instanceof Error ? err.message : String(err)}`);
          this.recordDaemonEvent("daemon.runtime_account_usage.refresh", {
            outcome: "collector_error",
            provider,
            reason: msg.reason,
            error_class: errorClassOf(err),
          });
        });
        break;
      }

      case "machine:runtime_account_usage:limit_reset:redeem":
        if (!isRuntimeAuthRequestId(msg.requestId) || !isRuntimeAccountUsageProvider(msg.provider) || !isRuntimeLimitResetIdempotencyKey(msg.idempotencyKey)
          || (msg.kind !== undefined && !isRuntimeLimitResetKind(msg.kind))) {
          this.recordDaemonEvent("daemon.runtime_account_usage.limit_reset", { outcome: "message_dropped" });
          break;
        }
        void this.redeemRuntimeLimitReset(msg.requestId, msg.provider, msg.idempotencyKey, msg.kind);
        break;

      case "machine:runtime_account_usage:limit_resets:read":
        if (!isRuntimeAuthRequestId(msg.requestId) || !isRuntimeAccountUsageProvider(msg.provider)) {
          this.recordDaemonEvent("daemon.runtime_account_usage.limit_reset", { operation: "read", outcome: "message_dropped" });
          break;
        }
        void this.readRuntimeLimitResets(msg.requestId, msg.provider, {
          // Anything but an explicit `false` is "at the limit": the refusal is the safe side.
          atFiveHourLimit: msg.atFiveHourLimit !== false,
          atFiveHourLimitConsent: msg.atFiveHourLimitConsent === true,
          includeFiveHour: msg.includeFiveHour === true,
        });
        break;

      case "machine:migration_transport:lease":
        this.handleMigrationTransportLease(msg);
        break;

      case "machine:migration:cancel":
        void this.handleMigrationCancellation(msg);
        break;

      case "ping":
        this.connection.send({ type: "pong" });
        break;

      case "computer:restart":
      case "computer:upgrade": {
        // Managed-Computer remote control. Only acts when this runner was
        // launched by a Computer service (onComputerControl wired); a raw
        // daemon has no service to drive and ignores it.
        const action = msg.type === "computer:restart" ? "restart" : "upgrade";
        const operationId = msg.operationId ?? msg.requestId;
        const requestId = msg.requestId ?? msg.operationId;
        const alreadyDurable = operationId
          ? this.options.getComputerLifecycleAcks?.().some((ack) =>
              (ack.operationId ?? ack.requestId) === operationId
            ) ?? false
          : false;
        if (operationId && (alreadyDurable || this.handledComputerControlOperationIds.has(operationId))) {
          this.recordDaemonEvent("daemon.computer_control.replayed", {
            action,
            operation_id: operationId,
            outcome: "ignored",
          });
          break;
        }
        if (operationId) this.handledComputerControlOperationIds.add(operationId);
        // Reconciler step 13: only a runner with the drain channel drains
        // (the service drains every runner through it), and never longer
        // than the cap, whatever the Server asked for.
        const drain = msg.type === "computer:upgrade" && this.upgradeDrain ? clampComputerUpgradeDrain(msg.drain) : null;
        this.recordDaemonEvent("daemon.computer_control.received", {
          action,
          handled: Boolean(this.options.onComputerControl),
          ...(operationId ? { operation_id: operationId } : {}),
          ...(requestId ? { request_id: requestId } : {}),
          ...(drain ? { drain_ms: drain.deadlineMs } : {}),
        });
        if (this.options.onComputerControl) {
          const ctx: ComputerControlContext = {
            flushUpgradeSteps: () => { void this.flushComputerUpgradeSteps(false); },
            operationId,
            requestId,
            ...(msg.type === "computer:upgrade" && typeof msg.targetVersion === "string" ? { targetVersion: msg.targetVersion } : {}),
            ...(drain ? { drain } : {}),
          };
          // May be async while the runner relays supervisor progress; don't
          // block the message loop — surface failures via logs/trace.
          void Promise.resolve()
            .then(() => this.options.onComputerControl!(action, ctx))
            .catch((err) => {
              const message = err instanceof Error ? err.message : String(err);
              const failure = /(?:^|\b)CONTROL_BUSY(?:\b|:)/.test(message)
                ? "control_busy"
                : /(?:^|\b)SELF_RELAUNCH_UNAVAILABLE(?:\b|:)/.test(message)
                  ? "self_relaunch_unavailable"
                  : /(?:^|\b)UPGRADE_START_REJECTED(?:\b|:)/.test(message)
                    ? "upgrade_start_rejected"
                    : /(?:^|\b)UPGRADE_INSTALLER_FAILED(?:\b|:)/.test(message)
                      ? "upgrade_installer_failed"
                      : "computer_control_failed";
              logger.error(
                `[Daemon] computer:${action} control handler failed: ${message}`,
              );
              if (!requestId) return;
              if (action === "restart") {
                this.connection.send({
                  type: "computer:restart:done",
                  requestId,
                  ok: false,
                  error: failure,
                });
                return;
              }
              // task #917: an upgrade that never reached the installer (a
              // supervisor that cannot be upgraded in place, a busy service,
              // an unreachable seam) has no reconnect to read back from. Settle
              // it now. Only the supervisor refusals also write a disk receipt
              // (recordRemoteUpgradeRefusal) that the next `ready` relays if
              // this message is lost; a busy or unreachable seam leaves no
              // receipt, so a lost message there waits out the request deadline.
              // An installer that gave up without stopping the service
              // (UPGRADE_INSTALLER_FAILED) is settled the same way.
              const sent = this.connection.connected;
              this.connection.send({
                type: "computer:upgrade:done",
                requestId,
                ok: false,
                code: failure,
                reason: message.replace(/[\u0000-\u001f\u007f]+/gu, " ").slice(0, 2048),
              });
              if (action === "upgrade") {
                this.recordComputerUpgradeReported(requestId, "upgrade_done", sent);
                void this.flushComputerUpgradeSteps(false);
                // The installer may have just left an operation it could not recover.
                void this.reportComputerInstallerRepairHintChange();
              }
            });
        } else {
          logger.info(`[Daemon] Ignoring computer:${action} — not launched by a Computer service.`);
        }
        break;
      }

      case "computer:lifecycle:receipt": {
        if (this.options.onComputerLifecycleReceipt) {
          void Promise.resolve(this.options.onComputerLifecycleReceipt(msg.operationId, msg.phase))
            .catch((err) => {
              logger.warn(
                `[Daemon] lifecycle receipt persistence failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
        }
        break;
      }
    }
  }

  /**
   * One detection path for both the on-demand `runtime_models:detect` request and
   * the unsolicited catalog push. Shares the probe gate key, so a push and a
   * request for the same runtime join one detection instead of spawning twice.
   */
  /**
   * The on-demand read behind a form's model list: served from the
   * stale-while-revalidate cache unless `force` (the form's refresh action).
   * Runtimes without their own detection answer from a static catalog and
   * need no cache.
   */
  private readRuntimeModelOutcome(
    runtime: string,
    span: ActiveSpan,
    force: boolean,
  ): Promise<{ outcome: RuntimeModelSourceOutcome; cache: RuntimeModelCacheRead | "static" }> {
    if (typeof getDriver(runtime)?.detectModels !== "function") {
      return this.detectRuntimeModelOutcome(runtime, span).then((outcome) => ({ outcome, cache: "static" as const }));
    }
    return this.runtimeModelCache.read(runtime, (mode) => {
      if (mode === "foreground") return this.detectRuntimeModelOutcome(runtime, span);
      const refreshSpan = this.tracer.startSpan("daemon.runtime_models.refresh", {
        surface: "daemon",
        kind: "internal",
        attrs: { runtime },
      });
      return this.detectRuntimeModelOutcome(runtime, refreshSpan).then(
        (outcome) => {
          refreshSpan.end("ok", { attrs: { outcome: outcome.kind } });
          return outcome;
        },
        (err: unknown) => {
          refreshSpan.end("error", { attrs: { outcome: "error", error_class: errorClassOf(err) } });
          throw err;
        },
      );
    }, { force });
  }

  private detectRuntimeModelOutcome(runtime: string, span: ActiveSpan): Promise<RuntimeModelSourceOutcome> {
    if (this.runtimeModelDetector) return this.runtimeModelDetector(runtime);
    const driver = getDriver(runtime);
    const staticSource = driver ? getStaticRuntimeModelSourceSet(runtime) : undefined;
    if (typeof driver?.detectModels === "function") {
      return this.probeGate.run(`runtime_models:${runtime}`, () => driver.detectModels!({ tracer: this.tracer, span }));
    }
    return Promise.resolve(staticSource ? { kind: "live", value: staticSource } : { kind: "unsupported" });
  }

  /**
   * Push each detected runtime's model list (id + the runtime's own label) so the
   * server holds the single copy every model-name surface reads. Runtimes run one
   * at a time to avoid spawning every CLI at once on connect. Only a live result
   * is sent: an error, missing login or unsupported runtime leaves the server's
   * previous copy in place rather than blanking it.
   */
  /**
   * Single-flight entry for the catalog push. Detection spawns each runtime's CLI
   * (some take seconds), so a flapping connection must not re-run it on every
   * reconnect: a connect-triggered push is skipped when a complete round ran
   * within MODEL_CATALOG_RECONNECT_MIN_INTERVAL_MS and the runtime ids/versions
   * are unchanged, or when any round (complete or not) started within
   * MODEL_CATALOG_RECONNECT_MIN_START_INTERVAL_MS. `rescan` forces a round. A trigger arriving mid-round is
   * folded into one follow-up round after the current one.
   */
  /**
   * Re-detects the installed runtimes and their models, and pushes both: the
   * server's `machine:runtimes:rescan`, and a Pi sign-in change from the web
   * (Pi lists the models of the providers it can authenticate). Only while
   * connected: the next connect detects anyway.
   */
  private rescanRuntimes(authoritativeFor?: string): void {
    if (!this.connection.connected) return;
    if (authoritativeFor) this.authoritativeCatalogRuntimes.add(authoritativeFor);
    void this.emitReady(undefined, { publishCatalogForce: true }).then((readySent) => {
      // task #1268: with async detection the catalog follows the round's inventory, not the pending frame.
      if (readySent && !this.detectionRound) this.requestRuntimeModelCatalogPublish(true);
    });
  }

  private requestRuntimeModelCatalogPublish(force: boolean): void {
    if (this.catalogPublishInFlight) {
      this.catalogPublishQueued = { force: force || (this.catalogPublishQueued?.force ?? false) };
      return;
    }
    const runtimeSignature = this.lastReadyRuntimeSignature;
    const now = currentTimeMs();
    if (!force) {
      if (
        this.lastCatalogPublish?.runtimeSignature === runtimeSignature
        && now - this.lastCatalogPublish.atMs < MODEL_CATALOG_RECONNECT_MIN_INTERVAL_MS
      ) {
        return;
      }
      if (this.lastCatalogRoundStartMs !== null && now - this.lastCatalogRoundStartMs < MODEL_CATALOG_RECONNECT_MIN_START_INTERVAL_MS) {
        return;
      }
    }
    this.lastCatalogRoundStartMs = now;
    this.catalogPublishInFlight = true;
    void this.publishRuntimeModelCatalogs()
      .then((completed) => {
        // Only a round that reached every runtime while connected counts; a
        // round cut short by a disconnect must not suppress the next connect.
        if (completed) this.lastCatalogPublish = { atMs: currentTimeMs(), runtimeSignature };
      })
      .finally(() => {
        this.catalogPublishInFlight = false;
        const queued = this.catalogPublishQueued;
        this.catalogPublishQueued = null;
        if (queued && this.connection.connected) this.requestRuntimeModelCatalogPublish(queued.force);
      });
  }

  /**
   * Returns true only when every runtime's result reached the same connection the
   * round started on. The connection generation moves on every disconnect and
   * connect, so a flap between two runtimes (even one that reconnects before the
   * next check) marks the round incomplete and the next connect pushes again.
   */
  private async publishRuntimeModelCatalogs(): Promise<boolean> {
    const generation = this.lifecycleOriginConnectionGeneration;
    const sameConnection = () => this.connection.connected && generation === this.lifecycleOriginConnectionGeneration;
    for (const runtime of this.lastReadyRuntimes) {
      if (!sameConnection()) return false;
      const span = this.tracer.startSpan("daemon.runtime_models.catalog", {
        surface: "daemon",
        kind: "internal",
        attrs: { runtime },
      });
      // Taken before the detection starts: only a detection that began after the
      // sign-in change may clear the list. A round already detecting when it
      // happened leaves the flag to the round queued behind it.
      const authoritative = this.authoritativeCatalogRuntimes.delete(runtime);
      try {
        const outcome = await this.detectRuntimeModelOutcome(runtime, span);
        // The connect-time push always detects afresh; it also warms the form cache.
        this.runtimeModelCache.store(runtime, outcome);
        const frame = runtimeModelCatalogFrame(runtime, outcome, authoritative);
        const models = frame?.models ?? [];
        if (frame) {
          if (!sameConnection()) {
            span.end("ok", { attrs: { outcome: "connection_changed", models_count: models.length } });
            if (authoritative) this.authoritativeCatalogRuntimes.add(runtime);
            return false;
          }
          this.connection.send(frame);
        }
        span.end("ok", { attrs: { outcome: models.length > 0 ? "sent" : frame ? "cleared" : outcome.kind, models_count: models.length } });
      } catch (err) {
        span.end("error", { attrs: { outcome: "error", error_class: errorClassOf(err) } });
      }
    }
    return sameConnection();
  }

  private emitReadyIfConnected(): void {
    if (this.connection.connected) void this.emitReady();
  }

  /** task #1268: may this connection's `ready` defer detection to a child round? Context wins over the handshake header. */
  private asyncDetectionAllowed(): boolean {
    const capabilities = this.serverContextCapabilities ?? new Set(this.connection.handshakeServerCapabilities);
    return capabilities.has(SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1);
  }

  /** The server's migration summary accepts `excludedIgnoredBySource`. Context wins over the handshake header. */
  private serverAcceptsMigrationIgnoreSources(): boolean {
    if (this.machineContextConflict) return false;
    const capabilities = this.serverContextCapabilities ?? new Set(this.connection.handshakeServerCapabilities);
    return capabilities.has(SERVER_CAPABILITY_MIGRATION_BACKUP_IGNORE_SOURCES_V1);
  }

  /** The server's source-progress report accepts `userIgnoreAdditions`. Context wins over the handshake header. */
  private serverAcceptsMigrationUserIgnoreReceipt(): boolean {
    if (this.machineContextConflict) return false;
    const capabilities = this.serverContextCapabilities ?? new Set(this.connection.handshakeServerCapabilities);
    return capabilities.has(SERVER_CAPABILITY_MIGRATION_USER_IGNORE_RECEIPT_V1);
  }

  /** The server's source-progress report accepts `phase: "draining"`. Context wins over the handshake header. */
  private serverAcceptsMigrationSourceDrainProgress(): boolean {
    if (this.machineContextConflict) return false;
    const capabilities = this.serverContextCapabilities ?? new Set(this.connection.handshakeServerCapabilities);
    return capabilities.has(SERVER_CAPABILITY_MIGRATION_SOURCE_DRAIN_PROGRESS_V1);
  }

  /** The server's usage snapshot schema reads `limitResetsAvailable`. Context wins over the handshake header. */
  private serverReadsLimitResets(): boolean {
    if (this.machineContextConflict) return false;
    const capabilities = this.serverContextCapabilities ?? new Set(this.connection.handshakeServerCapabilities);
    return capabilities.has(SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_LIMIT_RESETS_V1);
  }

  /**
   * Which window scopes the server's usage snapshot schema reads: every kind
   * (V2, `models` included), `account` and `model` only (V1), or none.
   * Context wins over the handshake header.
   */
  private serverWindowScopes(): "all" | "account_and_model" | "none" {
    if (this.machineContextConflict) return "none";
    const capabilities = this.serverContextCapabilities ?? new Set(this.connection.handshakeServerCapabilities);
    if (capabilities.has(SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_WINDOW_SCOPE_V2)) return "all";
    return capabilities.has(SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_WINDOW_SCOPE_V1) ? "account_and_model" : "none";
  }

  /**
   * A usage snapshot in the shape this server accepts: an older server's
   * strict schema refuses fields it does not know. A `models` scope a V1
   * server does not know leaves its window unscoped, never the snapshot
   * refused.
   */
  private snapshotForServer(snapshot: RuntimeAccountUsageSnapshot): RuntimeAccountUsageSnapshot {
    const withResets = this.serverReadsLimitResets() ? snapshot : withoutLimitResets(snapshot);
    switch (this.serverWindowScopes()) {
      case "all": return withResets;
      case "account_and_model": return withoutModelsScopes(withResets);
      case "none": return withoutWindowScopes(withResets);
    }
  }

  /**
   * Spends one of the provider account's limit resets (a person's confirmed
   * click on the web; the server checked who may), then reads that provider's
   * usage again whatever the outcome, and answers with both. The read's gate
   * key carries the request id, so it never joins a read that started before
   * this redeem landed, a scheduled one or another person's redeem.
   */
  private async redeemRuntimeLimitReset(requestId: string, provider: RuntimeAccountUsageProvider, idempotencyKey: RuntimeLimitResetIdempotencyKey, kind?: RuntimeLimitResetKind): Promise<void> {
    const startedAt = currentTimeMs();
    let report: RuntimeLimitResetReport = {};
    // The redeemer never throws (a rejection is `unknown`); this guards a test seam that does.
    const result: RuntimeLimitResetResult = await this.runtimeLimitResetRedeemer(provider, idempotencyKey, kind, (seen) => { report = seen; })
      .catch((): RuntimeLimitResetResult => ({ kind: "unknown" }));
    const snapshot = await this.probeGate
      .run(`runtime_account_usage_after_limit_reset:${provider}:${requestId}`, () => this.runtimeAccountUsageCollector(provider))
      .catch(() => null);
    this.connection.send({
      type: "machine:runtime_account_usage:limit_reset:result",
      requestId,
      result,
      ...(snapshot ? { snapshot: this.snapshotForServer(snapshot) } : {}),
    });
    this.recordDaemonEvent("daemon.runtime_account_usage.limit_reset", {
      outcome: result.kind,
      provider,
      ...("reason" in result ? { reason: result.reason } : {}),
      snapshot_sent: snapshot !== null,
      ...(snapshot?.accounts[0]?.limitResetsAvailable !== undefined ? { limit_resets_available: snapshot.accounts[0].limitResetsAvailable } : {}),
      ...(kind ? { reset_kind: kind } : {}),
      ...(result.kind === "unknown" && result.fiveHourSpent ? { five_hour_spent: true } : {}),
      ...(report.oarOutcome ? { oar_outcome: report.oarOutcome } : {}),
      duration_ms: currentTimeMs() - startedAt,
    });
  }

  /**
   * Reads which limit resets the provider account holds (a person's click on
   * the web; never a poll) and answers with them. Only a runtime with OAR's
   * `inspectLimitResets` (Claude) has kinds to read; an account at its 5-hour
   * limit is refused without consent.
   */
  private async readRuntimeLimitResets(
    requestId: string,
    provider: RuntimeAccountUsageProvider,
    input: { atFiveHourLimit: boolean; atFiveHourLimitConsent: boolean; includeFiveHour: boolean },
  ): Promise<void> {
    const startedAt = currentTimeMs();
    let report: RuntimeLimitResetReport = {};
    // The reader never throws (a rejection is `unknown`); this guards a test seam that does.
    const result: RuntimeLimitResetsReadResult = await this.runtimeLimitResetsReader(provider, input, (seen) => { report = seen; })
      .catch((): RuntimeLimitResetsReadResult => ({ kind: "unknown" }));
    this.connection.send({ type: "machine:runtime_account_usage:limit_resets:read:result", requestId, result });
    this.recordDaemonEvent("daemon.runtime_account_usage.limit_reset", {
      operation: "read",
      outcome: result.kind,
      provider,
      ...("reason" in result ? { reason: result.reason } : {}),
      ...(result.kind === "read" ? {
        ...(result.program ? { program: result.program } : {}),
        ...(result.fiveHourSpent ? { five_hour_spent: true } : {}),
        available_kinds: result.resets.filter((reset) => reset.state === "available").length,
        unknown_kinds: result.resets.filter((reset) => reset.state === "unknown").length,
      } : {}),
      ...(report.claudeVersion ? { claude_version: report.claudeVersion } : {}),
      ...(report.oarOutcome ? { oar_outcome: report.oarOutcome } : {}),
      duration_ms: currentTimeMs() - startedAt,
    });
  }

  private observeServerContextCapabilities(capabilities: readonly string[]): void {
    this.serverContextCapabilities = new Set(capabilities);
    const header = new Set(this.connection.handshakeServerCapabilities);
    const headerSaid = header.has(SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1);
    const contextSays = this.serverContextCapabilities.has(SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1);
    if (headerSaid === contextSays) return;
    // The header is only a pre-read of the context. A round already started on
    // the header's word keeps running: its final frame carries the full
    // inventory, which a server without the capability reads as an ordinary
    // ready. A header that under-reported simply means the first ready was
    // synchronous; later rescans follow the context.
    logger.warn(`[Daemon] Server capability mismatch for runtime detection: header=${headerSaid} context=${contextSays}; following machine:context`);
    this.recordDaemonEvent("daemon.runtime.detect.capability_mismatch", {
      header_async: headerSaid,
      context_async: contextSays,
      round_in_flight: Boolean(this.detectionRound),
    });
  }

  private abandonDetectionRound(reason: "reconnect" | "disconnect" | "stop" | "superseded_by_sync"): void {
    const round = this.detectionRound;
    this.detectionRescanRequested = false;
    if (!round) return;
    this.detectionRound = null;
    round.abandoned = true;
    this.recordDaemonEvent("daemon.runtime.detect.round_abandoned", {
      round_id: round.roundId,
      reason,
      child_started: Boolean(round.handle),
    }, "cancelled");
    round.handle?.cancel();
  }

  /**
   * Compare this detection's runtime CLI versions with the last ones recorded
   * on this Raft home: every change is a trace event; a downgrade also stays
   * as a notice for `raft-computer status` (see runtimeCliVersionTracker).
   * Runtimes that ship with the Computer are not CLIs on PATH and are left out.
   * Best-effort: a failed read or write never affects detection or ready.
   */
  private trackRuntimeCliVersions(detected: Record<string, string>): void {
    if (!this.raftHomeExplicit) return;
    this.runtimeCliVersionWrite = this.runtimeCliVersionWrite.then(async () => {
      const state = await readRuntimeCliVersionState(this.slockHome);
      const { changes, next } = observeRuntimeCliVersions(state, detected, currentDate(), runtimeIdsShippedWithComputer());
      for (const change of changes) {
        this.recordDaemonEvent("daemon.runtime.cli_changed", {
          runtime: change.runtime,
          from_version: change.from,
          to_version: change.to,
          direction: change.direction,
        }, change.direction === "downgrade" ? "error" : "ok");
        if (change.direction === "downgrade") {
          logger.warn(`[Daemon] ${change.runtime} CLI went from ${change.from} to ${change.to}; an older copy may be earlier on this Computer's PATH (see \`raft-computer status\`)`);
        }
      }
      if (JSON.stringify(next) !== JSON.stringify(state)) await writeRuntimeCliVersionState(this.slockHome, next);
    }).catch((error: unknown) => {
      logger.warn(`[Daemon] Runtime CLI version record not updated: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /**
   * Reconciler step 15 (B12, measure only, Q-4): live processes still running
   * another CLI version than this detection found, one event per runtime with
   * a count (never agent ids). Nothing is restarted; the data decides whether
   * a version change should restart agents at idle. The OAR host is not
   * counted: it keeps no per-process CLI version.
   */
  private traceRuntimeCliVersionDrift(detected: Record<string, string>): void {
    const live = this.agentManager.liveRuntimeCliVersions?.() ?? [];
    for (const drift of runtimeCliVersionDrift(live, detected)) {
      this.recordDaemonEvent("daemon.agent.cli_version_drift", {
        runtime: drift.runtime,
        from_version: drift.from,
        to_version: drift.to,
        direction: drift.direction,
        live_agents: drift.liveAgents,
        from_versions: drift.fromVersions,
      });
    }
  }

  private applyDetectionInventory(detection: RuntimeDetection): { runtimes: string[]; runtimeVersions: Record<string, string> } {
    const {
      ids: runtimes,
      versions: runtimeVersions,
      diagnostics: runtimeDiagnostics = {},
      unavailableReasons: runtimeUnavailableReasons = {},
    } = detection;
    this.lastReadyRuntimes = runtimes;
    this.lastReadyRuntimeSignature = JSON.stringify(runtimes.map((id) => [id, runtimeVersions[id] ?? null]));
    this.lastReadyRuntimeVersions = runtimeVersions;
    this.trackRuntimeCliVersions(runtimeVersions);
    this.traceRuntimeCliVersionDrift(runtimeVersions);
    const runtimeInfo = runtimes.map((id) => runtimeVersions[id] ? `${id} (${runtimeVersions[id]})` : id);
    logger.info(`[Daemon] Detected runtimes: ${runtimeInfo.join(", ") || "none"}`);
    for (const [runtime, diagnostic] of Object.entries(runtimeDiagnostics)) {
      // A missing optional runtime is an expected inventory state, re-probed on
      // every ready; only installed-but-broken runtimes (or unknown causes) warn.
      const notInstalled = !runtimes.includes(runtime) && runtimeUnavailableReasons[runtime] === "not_installed";
      const message = `[Daemon] Runtime ${runtime} diagnostic: ${diagnostic}`;
      if (notInstalled) logger.info(message);
      else logger.warn(message);
    }
    return { runtimes, runtimeVersions };
  }

  private async emitReady(
    expectedLifecycleGeneration?: number,
    options: { publishCatalogForce?: boolean } = {},
  ): Promise<boolean> {
    if (this.asyncDetectionAllowed()) {
      return this.emitReadyWithDetectionRound(expectedLifecycleGeneration, options.publishCatalogForce ?? false);
    }
    // Every inventory publication, synchronous or from a round, is ordered
    // through the single round record: a synchronous ready supersedes any round
    // still in flight (its result would be older than what is sent now), so a
    // capability downgrade followed by a rescan can never be overwritten later.
    this.abandonDetectionRound("superseded_by_sync");
    const ticket = ++this.readyPublicationSeq;
    const inventory = this.applyDetectionInventory(this.runtimeDetector());
    return this.sendReadyFrame({ inventory }, expectedLifecycleGeneration, ticket);
  }

  /**
   * task #1268: `ready` first (no inventory, `runtimeDetection: pending`), then
   * one detection round in a child; its result lands only on the connection
   * generation that started it and is followed by a second ready carrying the
   * inventory and `complete` / `incomplete`. A rescan during a round queues
   * exactly one more round instead of a parallel one.
   */
  private async emitReadyWithDetectionRound(expectedLifecycleGeneration: number | undefined, publishCatalogForce: boolean): Promise<boolean> {
    const generation = this.lifecycleOriginConnectionGeneration;
    if (this.detectionRound && this.detectionRound.generation === generation) {
      this.detectionRescanRequested = true;
      this.detectionRound.publishCatalogForce ||= publishCatalogForce;
      this.recordDaemonEvent("daemon.runtime.detect.rescan_coalesced", {
        round_id: this.detectionRound.roundId,
        child_started: Boolean(this.detectionRound.handle),
      });
      return true;
    }
    // Reserve the round before the first await: a second rescan arriving while
    // the pending frame is in flight must coalesce, not start a second child.
    const round: DetectionRoundRecord = { handle: null, generation, roundId: ++this.detectionRoundSeq, publishCatalogForce, abandoned: false };
    this.detectionRound = round;
    this.recordDaemonEvent("daemon.runtime.detect.round_reserved", { round_id: round.roundId, connection_generation: generation });
    const ticket = ++this.readyPublicationSeq;
    const sent = await this.sendReadyFrame({ inventory: null, runtimeDetection: { status: "pending" } }, expectedLifecycleGeneration, ticket);
    // Disconnected, stopped or superseded while the frame was in flight: the
    // record is no longer ours and nothing may start.
    if (round.abandoned || this.detectionRound !== round) return sent;
    if (!sent || generation !== this.lifecycleOriginConnectionGeneration || !this.connection.connected) {
      this.detectionRound = null;
      return sent;
    }
    this.startDetectionRound(round);
    return true;
  }

  private startDetectionRound(round: DetectionRoundRecord): void {
    const run = this.options.runtimeDetectionRound ?? runRuntimeDetectionRound;
    const handle = run({
      knownRuntimeIds: RUNTIMES.map((runtime) => runtime.id),
      ...(this.options.runtimeDetectionDeadlineMs !== undefined ? { deadlineMs: this.options.runtimeDetectionDeadlineMs } : {}),
    });
    round.handle = handle;
    this.recordDaemonEvent("daemon.runtime.detect.round_started", { round_id: round.roundId, connection_generation: round.generation });
    void handle.result.then(
      (result) => this.onDetectionRoundSettled(round, result),
      (error) => this.onDetectionRoundSettled(round, {
        status: "incomplete",
        reason: "child_failed",
        detection: { ids: [], versions: {} },
        unfinishedRuntimes: RUNTIMES.map((runtime) => runtime.id),
        durationMs: 0,
        detail: error instanceof Error ? error.message.slice(0, 200) : "runner rejected",
      }),
    );
  }

  private async onDetectionRoundSettled(round: DetectionRoundRecord, result: RuntimeDetectionRoundResult): Promise<void> {
    const { generation, roundId } = round;
    if (round.abandoned || this.detectionRound !== round) {
      // Abandoned (disconnect, stop, synchronous supersede) or not the current
      // round: the result lands nowhere. Its child was already killed; report
      // whether that kill was confirmed so a leftover probe is visible.
      if (result.status === "incomplete" && result.cleanup && !result.cleanup.childExited) {
        logger.warn(`[Daemon] Abandoned runtime detection round ${roundId}: child exit not confirmed within ${result.cleanup.waitedMs} ms`);
      }
      return;
    }
    this.detectionRound = null;
    // Claim the publication before any await below: a synchronous ready that
    // starts while this frame is being prepared must win over it.
    const ticket = ++this.readyPublicationSeq;
    if (result.status === "incomplete" && result.cleanup && !result.cleanup.childExited) {
      logger.warn(`[Daemon] Runtime detection round ${roundId}: child exit not confirmed within ${result.cleanup.waitedMs} ms after the kill; a probe may still be running`);
    }
    this.recordDaemonEvent("daemon.runtime.detect.round_settled", {
      round_id: roundId,
      status: result.status,
      duration_ms: result.durationMs,
      detected_runtime_count: result.detection.ids.length,
      ...(result.status === "incomplete"
        ? {
            reason: result.reason,
            unfinished_count: result.unfinishedRuntimes.length,
            ...(result.exitCode !== undefined ? { exit_code: result.exitCode ?? -1 } : {}),
            ...(result.detail ? { detail: result.detail } : {}),
            ...(result.cleanup ? { cleanup_child_exited: result.cleanup.childExited, cleanup_waited_ms: result.cleanup.waitedMs } : {}),
          }
        : {}),
    }, result.status === "complete" ? "ok" : "error");
    if (generation !== this.lifecycleOriginConnectionGeneration || !this.connection.connected) {
      logger.info(`[Daemon] Runtime detection round ${roundId} finished after its connection ended; result discarded`);
      return;
    }
    const inventory = this.applyDetectionInventory(result.detection);
    const report: RuntimeDetectionReport = result.status === "complete"
      ? { status: "complete", durationMs: result.durationMs }
      : { status: "incomplete", reason: result.reason, unfinishedRuntimes: result.unfinishedRuntimes, durationMs: result.durationMs };
    if (result.status === "incomplete") {
      logger.warn(`[Daemon] Runtime detection incomplete (${result.reason}${result.detail ? `: ${result.detail}` : ""}); not probed: ${result.unfinishedRuntimes.join(", ") || "none"}. Rescan from the Computer page to retry.`);
    }
    const sent = await this.sendReadyFrame({ inventory, runtimeDetection: report }, generation, ticket);
    if (!sent) return;
    this.requestRuntimeModelCatalogPublish(round.publishCatalogForce);
    if (this.detectionRescanRequested) {
      this.detectionRescanRequested = false;
      void this.emitReady(generation, { publishCatalogForce: true });
    }
  }

  private async sendReadyFrame(
    frame: { inventory: { runtimes: string[]; runtimeVersions: Record<string, string> } | null; runtimeDetection?: RuntimeDetectionReport },
    expectedLifecycleGeneration: number | undefined,
    publicationTicket: number,
  ): Promise<boolean> {
    const runningAgentIds = this.agentHosts.getRunningAgentIds();
    const idleAgentSessions = this.agentManager.getIdleAgentSessionIds();
    const runtimeProfileReports = this.agentManager.getAgentRuntimeProfileReports();

    let lifecycleAcks = this.options.getComputerLifecycleAcks?.() ?? [];
    if (this.options.getComputerLifecycleReadyAcks) {
      try {
        lifecycleAcks = await this.options.getComputerLifecycleReadyAcks();
      } catch (error) {
        logger.warn(`[Daemon] Computer lifecycle attestation skipped: ${error instanceof Error ? error.message : String(error)}`);
        this.recordConnectLifecycleError("lifecycle_attestation", "attestation_threw", error);
        lifecycleAcks = [];
      }
    }
    let legacyCredentialExposure: LegacyCredentialExposureReport | null = null;
    try {
      legacyCredentialExposure = legacyCredentialExposureForReady(this.slockHome, this.options.apiKey);
    } catch {
      legacyCredentialExposure = null;
    }
    // Awaited only with a Computer seam: a plain daemon's ready keeps its timing.
    const installerRepairHint = this.options.getComputerInstallerRepairHint ? await this.readComputerInstallerRepairHint() : null;
    // Once per server after Raft Desktop's move: the first ready that goes out carries it.
    const migratedFrom = this.options.getComputerMigratedFrom && !this.migratedFromSent
      ? await this.options.getComputerMigratedFrom().catch(() => null)
      : null;
    let lastUpgradeReceipt: ComputerLastUpgradeReceipt | null = null;
    if (this.options.getComputerLastUpgradeReceipt) {
      try {
        lastUpgradeReceipt = await this.options.getComputerLastUpgradeReceipt();
      } catch (error) {
        this.recordConnectLifecycleError("last_upgrade_receipt", "receipt_read_threw", error);
        lastUpgradeReceipt = null;
      }
    }
    if (expectedLifecycleGeneration !== undefined
      && (expectedLifecycleGeneration !== this.lifecycleOriginConnectionGeneration
        || !this.connection.connected)) {
      return false;
    }
    if (publicationTicket !== this.readyPublicationSeq) {
      // A newer ready publication started while this frame waited on the
      // awaits above; sending it now would put an older inventory (or a
      // pending with no round behind it) after the newer one.
      this.recordDaemonEvent("daemon.ready.superseded", {
        runtime_detection_status: frame.runtimeDetection?.status ?? "complete",
        ticket: publicationTicket,
        newest_ticket: this.readyPublicationSeq,
      }, "cancelled");
      return false;
    }
    const osVariant = hostOsVariant();
    // Started in start(); a ready sent before it finishes (macOS runs
    // system_profiler, ~0.3 s) omits it, and the inventory-carrying ready that
    // follows runtime detection, the one the Server persists, has it.
    const { deviceClass, hostProvider, osRelease, osId, osIdLike } = knownHostFacts();
    const { installKind, nodeOnPath } = daemonInstallFacts();
    // #wg-rbac:#27: read here, after the last await and in the same tick as the
    // send, so a credential minted while this frame was prepared is listed
    // once its process or start holds it. One minted later is not listed.
    const runnerCredentialIds = this.agentHosts.getHeldRunnerCredentialIds();
    this.connection.send({
      type: "ready",
      capabilities: [
        "agent:start",
        "agent:stop",
        "agent:deliver",
        "workspace:files",
        DAEMON_CAPABILITY_SEQUENCED_STATUS,
        DAEMON_CAPABILITY_INTERRUPT_TURN,
        DAEMON_CAPABILITY_INTERRUPT_SUBAGENT,
        DAEMON_CAPABILITY_RUNTIME_AUTH,
        // Kimi and Qoder sign in and out too (RUNTIME_AUTH_RUNTIMES).
        DAEMON_CAPABILITY_RUNTIME_AUTH_V2,
        // Qwen Code: its providers listed and a provider's API key saved from the web.
        DAEMON_CAPABILITY_RUNTIME_AUTH_QWEN_PROVIDER,
        // Antigravity's status and login (OAR 0.97), and its logout (OAR 0.98).
        DAEMON_CAPABILITY_RUNTIME_AUTH_ANTIGRAVITY,
        DAEMON_CAPABILITY_RUNTIME_AUTH_ANTIGRAVITY_LOGOUT,
        // Pi's sign-ins per provider: status, OAuth login, logout, API key (OAR's createPiProviderAuth).
        DAEMON_CAPABILITY_RUNTIME_AUTH_PI,
        // Grok Build's status, device-code login and logout (OAR 0.99).
        DAEMON_CAPABILITY_RUNTIME_AUTH_GROK,
        // OpenCode 2's sign-ins per provider: status, OAuth login, logout, API key (OAR 0.100 createOpencodeProviderAuth).
        DAEMON_CAPABILITY_RUNTIME_AUTH_OPENCODE,
        // CodeBuddy Code's status, sign-in link and logout (OAR's codebuddy runtime).
        DAEMON_CAPABILITY_RUNTIME_AUTH_CODEBUDDY,
        // Spends an account's limit reset from the web (OAR `redeemLimitReset`, Codex).
        DAEMON_CAPABILITY_RUNTIME_LIMIT_RESET,
        // Reads Antigravity's account usage: the bundled OAR (0.103+) has
        // `antigravityRuntime.accountUsage` (collector.test.ts pins it).
        DAEMON_CAPABILITY_RUNTIME_ACCOUNT_USAGE_ANTIGRAVITY,
        // Claude's limit resets by kind, and reading them (OAR 0.102
        // `inspectLimitResets` / `redeemLimitReset` with a `resetId`): only
        // where OAR drives Claude Code (Linux). Elsewhere (macOS) the card
        // keeps showing nothing, never a consent step for a read that could
        // only answer `unsupported_platform`.
        ...(claudeLimitResetsDrivable(this.platform) ? [DAEMON_CAPABILITY_RUNTIME_LIMIT_RESET_CLAUDE_KINDS] : []),
        // `agent:runtime:ready` on a launch's first runtime output.
        DAEMON_CAPABILITY_STARTUP_READINESS,
        // RFC 071: agent:runtime:outcome v1, process spawned/exited, rebind
        // ack processInstanceId, catchupBatchId echo.
        DAEMON_CAPABILITY_RUNTIME_OUTCOME_V1,
        // Task v2: POST /tasks from a message attests its thread (agentCredentialProxy).
        DAEMON_CAPABILITY_TASK_CREATE_FRESHNESS,
        // RFC 060: reads `AgentConfig.runtimeHost` and can run a launch on an
        // OAR session; the server asks for it only from a daemon offering this.
        ...(this.oarHostEnabled ? [DAEMON_CAPABILITY_RUNTIME_HOST_OAR, DAEMON_CAPABILITY_RUNTIME_HOST_OAR_CODEX, DAEMON_CAPABILITY_RUNTIME_HOST_OAR_GROK] : []),
        // #oar-raft:#10: Cursor through the SDK, only on Linux outside the SEA build with the SDK installed.
        ...(this.oarHostEnabled && cursorSdkAvailable() ? [DAEMON_CAPABILITY_RUNTIME_HOST_OAR_CURSOR] : []),
        // View Context v0: answers `agent:context_view_request` with one result
        // POST and sends `agent:context_view_availability` (agentContextView/),
        // for agents whose config has `agentContextView` on.
        DAEMON_CAPABILITY_AGENT_CONTEXT_VIEW_V0,
        // Agents searching a context (#wg-ax:#15): `agent:context_search_request`.
        DAEMON_CAPABILITY_AGENT_CONTEXT_SEARCH_V0,
        // A Codex agent's context is read only from its rollouts (#13469).
        DAEMON_CAPABILITY_AGENT_CONTEXT_VIEW_CODEX_ROOT_V1,
        // #wg-rbac:#27: `runnerCredentialIds` below lists every runner
        // credential held here; the server revokes this machine's others.
        DAEMON_CAPABILITY_RUNNER_CREDENTIAL_RECONCILE_V1,
        // Reconciler step 11: takes `agent:config` (a new config for a
        // running agent, applied at idle) instead of a restart.
        DAEMON_CAPABILITY_AGENT_CONFIG_PUSH,
        // RFC 071 F9: a runtime-profile control start also renders its
        // resume catch-up (startupInput.ts), so the server may count it as
        // the start that carried the owed catch-up.
        DAEMON_CAPABILITY_CONTROL_START_CATCHUP_V1,
        // task #1357 item 1: `agent:model_limits` for every Pi session built,
        // each live session's last one sent again after a reconnect.
        DAEMON_CAPABILITY_MODEL_LIMITS_REPORT_V1,
        ...BUILT_IN_READY_CAPABILITIES,
        ...(this.options.computerControlViaSupervisor
          ? [COMPUTER_CAPABILITY_SUPERVISOR_MUTATIONS]
          : []),
        // Reconciler step 13: a web upgrade may carry `drain` (computerUpgradeDrain.ts).
        ...(this.upgradeDrain ? [DAEMON_CAPABILITY_COMPUTER_UPGRADE_DRAIN_V1] : []),
        ...(this.options.computerServiceIpcUnreachable
          ? [COMPUTER_CAPABILITY_SERVICE_IPC_UNREACHABLE]
          : []),
      ],
      daemonInstanceId: this.daemonInstanceId,
      ...(this.runtimeOutcomeOutbox.unreliableAgents().length > 0
        ? { runtimeOutcomeUnreliableAgents: this.runtimeOutcomeOutbox.unreliableAgents() }
        : {}),
      // task #1268: a pending ready carries NO inventory fields at all.
      ...(frame.inventory ? { runtimes: frame.inventory.runtimes, runtimeVersions: frame.inventory.runtimeVersions } : {}),
      ...(frame.runtimeDetection ? { runtimeDetection: frame.runtimeDetection } : {}),
      runningAgents: runningAgentIds,
      runnerCredentialIds,
      runningAgentConfigRevisions: this.runningAgentConfigRevisions(runningAgentIds),
      hostname: this.options.hostname ?? os.hostname(),
      os: this.options.osDescription ?? `${os.platform()} ${os.arch()}`,
      ...(osVariant ? { osVariant } : {}),
      ...(deviceClass ? { deviceClass } : {}),
      ...(hostProvider ? { hostProvider } : {}),
      ...(osRelease ? { osRelease } : {}),
      ...(osId ? { osId } : {}),
      ...(osIdLike ? { osIdLike } : {}),
      ...(installKind ? { installKind } : {}),
      nodeOnPath,
      daemonVersion: this.daemonVersion,
      ...(this.computerVersion ? { computerVersion: this.computerVersion } : {}),
      migrationTransport: this.getMigrationTransportReady(),
      ...((this.options.getComputerLifecycleAcks || this.options.getComputerLifecycleReadyAcks)
        ? { lifecycleAcks }
        : {}),
      ...(lastUpgradeReceipt ? { lastUpgradeReceipt } : {}),
      ...(legacyCredentialExposure ? { legacyCredentialExposure } : {}),
      ...(installerRepairHint ? { installerRepairHint } : {}),
      ...(isComputerMigratedFrom(migratedFrom) ? { migratedFrom } : {}),
    });
    if (isComputerMigratedFrom(migratedFrom) && this.connection.connected) {
      this.migratedFromSent = true;
      void this.options.onComputerMigratedFromSent?.().catch((error: unknown) => {
        logger.warn(`[Daemon] migrated-from note not cleared: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    this.lastReadyCarriedUpgradeReceipt = lastUpgradeReceipt !== null;
    this.reportedInstallerRepairHint = JSON.stringify(installerRepairHint);
    // Fresh disk and memory reports shortly after every (re)connect, then
    // hourly (disk) and every 5 minutes (memory).
    this.scheduleDiskStatusReport(DISK_STATUS_FIRST_REPORT_DELAY_MS);
    this.scheduleMemoryStatusReport(DISK_STATUS_FIRST_REPORT_DELAY_MS);
    this.recordDaemonEvent("daemon.ready.sent", {
      runtimes_count: frame.inventory ? frame.inventory.runtimes.length : -1,
      runtime_detection_status: frame.runtimeDetection?.status ?? "complete",
      running_agents_count: runningAgentIds.length,
      idle_agents_count: idleAgentSessions.length,
      runtime_profile_reports_count: runtimeProfileReports.length,
      runner_credentials_count: runnerCredentialIds.length,
      ...(isComputerMigratedFrom(migratedFrom) ? { migrated_from: migratedFrom } : {}),
    });
    // View Context: the Server keeps the latest availability per agent; a new
    // connection hears it again for every running agent with the feature on.
    this.agentManager.reportAgentContextViewAvailability?.("ready");
    // task #17: each web-loginable runtime's auth status follows every ready
    // that carries an inventory (startup, reconnect, rescan).
    if (frame.inventory) {
      this.runtimeAuthInventory = [...frame.inventory.runtimes];
      if (this.serverRuntimeAuthRuntimes) this.reportRuntimeAuthStatus("ready", this.runtimeAuthInventory);
      this.syncSharedCredentialWatch();
    }
    return true;
  }

  /**
   * #proj-raft-computer:#68: the login facts this runner persists, in its
   * machine dir. They go back into the ledger before any agent starts, and
   * every change is sent to a server that reads them.
   */
  private openRuntimeReadiness(machineDir: string): void {
    const ledger = this.agentManager.providerLimitLedger;
    if (this.runtimeReadiness || !ledger) return;
    try {
      const store = new RuntimeReadinessStore({ file: path.join(machineDir, RUNTIME_READINESS_FILE) });
      store.load();
      store.attach(ledger);
      store.onChange(() => this.sendRuntimeReadiness());
      // #proj-raft-computer:#69: the machine logins are shared with the other
      // runners on this Computer; keep reading what they saw.
      store.startSharedLoginSync();
      this.runtimeReadiness = store;
    } catch (error) {
      logger.warn(`[Daemon] Runtime readiness store unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The full readiness snapshot, to a connected server that reads it (on connect and on change; never on a timer). */
  private sendRuntimeReadiness(): void {
    if (!this.runtimeReadiness || !this.serverReadsRuntimeReadiness || !this.connection.connected) return;
    this.connection.send({ type: "machine:runtime_readiness", ...this.runtimeReadiness.report() });
  }

  /**
   * Reconciler step 15 (PR 3): the shared credential homes are watched while
   * the connected server reads both the status report and the change frame,
   * for the runtimes detection found that it reads. The daemon is not told
   * which agents the server keeps paused for a sign-in, and a status query
   * cannot say (a revoked Codex token still reads `logged_in`), so the watch
   * does not wait for a status other than `logged_in`: a stat per source a
   * tick, and the status query only after a change.
   */
  private syncSharedCredentialWatch(): void {
    const watch = this.credentialDiskWatch;
    if (!watch) return;
    const reads = this.serverRuntimeAuthRuntimes;
    const active = this.connection.connected && this.serverReadsRuntimeCredentialsChanged && reads !== null && this.runtimeAuthInventory !== null;
    if (active) {
      const detected = new Set(this.runtimeAuthInventory!.map((runtime) => runtimeAuthRuntimeFor(runtime)));
      watch.setSharedHomes(reads!.filter((runtime) => detected.has(runtime)));
    }
    watch.setSharedHomesActive(active);
  }

  /**
   * A runtime's shared credential changed on disk: the status report follows
   * (the Computer card), and only when that fresh query reads it signed in
   * does the server hear `machine:runtime_credentials:changed`, which lifts
   * the sign-in pauses of the runtime's agents on the shared sign-in. A plain
   * status report never lifts anything.
   */
  private async reportSharedCredentialsChanged(runtime: RuntimeAuthRuntime): Promise<void> {
    let status: Awaited<ReturnType<RuntimeAuthHost["reportFreshStatus"]>> = null;
    try {
      status = await this.runtimeAuth.reportFreshStatus("credentials_changed_on_disk", runtime);
    } catch (error) {
      logger.warn(`[Daemon] Runtime auth status after a credential change failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const sent = status?.kind === "logged_in" && this.connection.connected && this.serverReadsRuntimeCredentialsChanged;
    if (sent) this.connection.send({ type: "machine:runtime_credentials:changed", runtime });
    this.recordDaemonEvent("daemon.runtime_credentials.changed", {
      runtime,
      auth_status: status?.kind ?? "none",
      outcome: sent ? "sent" : "not_sent",
    });
  }

  private reportRuntimeAuthStatus(trigger: string, inventory: readonly string[]): void {
    void this.runtimeAuth.reportStatus(trigger, inventory).catch((error: unknown) => {
      logger.warn(`[Daemon] Runtime auth status report failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /**
   * Reconciler step 15 (B13): a daemon-local restart stopped at its first
   * failure because the runtime is missing here, and the server paused the
   * agent ("runtime unavailable"). The server lifts that pause when a `ready`
   * lists the runtime again, but nothing sends one while the connection stays
   * up. A self-updating CLI is missing only for the moment it swaps its
   * binary, so re-detect once, RUNTIME_ABSENT_REDETECT_DELAY_MS later: the
   * same re-emit a web rescan does. Several stops in that window share one.
   */
  private scheduleRuntimeRedetectAfterAbsent(runtime: string): void {
    this.recordDaemonEvent("daemon.runtime.absent_redetect.scheduled", { runtime, delay_ms: this.runtimeAbsentRedetectDelayMs });
    if (this.runtimeRedetectTimer !== null) return;
    this.runtimeRedetectTimer = setTimeout(() => {
      this.runtimeRedetectTimer = null;
      if (!this.connection.connected) return;
      void this.emitReady(undefined, { publishCatalogForce: true }).then((readySent) => {
        if (readySent && !this.detectionRound) this.requestRuntimeModelCatalogPublish(true);
      });
    }, this.runtimeAbsentRedetectDelayMs);
    this.runtimeRedetectTimer.unref?.();
  }

  private scheduleDiskStatusReport(delayMs: number): void {
    if (this.diskStatusTimer !== null) clearTimeout(this.diskStatusTimer);
    this.diskStatusTimer = setTimeout(() => {
      this.diskStatusTimer = null;
      void this.sendDiskStatus().finally(() => {
        if (this.machineStatusReportsEnabled) this.scheduleDiskStatusReport(DISK_STATUS_REPORT_INTERVAL_MS);
      });
    }, delayMs);
    this.diskStatusTimer.unref?.();
  }

  private scheduleMemoryStatusReport(delayMs: number): void {
    if (this.memoryStatusTimer !== null) clearTimeout(this.memoryStatusTimer);
    this.memoryStatusTimer = setTimeout(() => {
      this.memoryStatusTimer = null;
      void this.reportComputerInstallerRepairHintChange();
      void this.sendMemoryStatus().finally(() => {
        if (this.machineStatusReportsEnabled) this.scheduleMemoryStatusReport(MEMORY_STATUS_REPORT_INTERVAL_MS);
      });
    }, delayMs);
    this.memoryStatusTimer.unref?.();
  }

  /** Null when there is nothing to hint, when unknown (no Computer seam) and when the read failed. */
  private async readComputerInstallerRepairHint(): Promise<ComputerInstallerRepairHint | null> {
    try {
      return (await this.options.getComputerInstallerRepairHint?.()) ?? null;
    } catch {
      return null;
    }
  }

  /** Tell the server when the hint changed since this connection last said it. */
  private reportComputerInstallerRepairHintChange(): Promise<void> {
    if (!this.options.getComputerInstallerRepairHint) return Promise.resolve();
    this.installerRepairHintReport = this.installerRepairHintReport.then(async () => {
      const hint = await this.readComputerInstallerRepairHint();
      const encoded = JSON.stringify(hint);
      if (encoded === this.reportedInstallerRepairHint || !this.connection.connected) return;
      this.connection.send({ type: "machine:installer_repair_hint", hint });
      this.reportedInstallerRepairHint = encoded;
    });
    return this.installerRepairHintReport;
  }

  private async sendMemoryStatus(): Promise<void> {
    const memory = await readMachineMemoryStatus().catch(() => null);
    if (!memory || !this.connection.connected) return;
    this.connection.send({ type: "machine:memory_status", ...memory });
  }

  private async sendDiskStatus(): Promise<void> {
    const disk = await readVolumeCapacity(this.agentsDataDir);
    if (!disk || !this.connection.connected) return;
    if (!isValidMachineDiskStatus(disk)) return;
    this.connection.send({ type: "machine:disk_status", ...disk });
  }

  private invalidateLifecycleOriginReconcile(): number {
    this.lifecycleOriginConnectionGeneration += 1;
    if (this.lifecycleOriginRetryTimer !== null) {
      this.lifecycleOriginClock.clearTimeout(this.lifecycleOriginRetryTimer);
      this.lifecycleOriginRetryTimer = null;
    }
    return this.lifecycleOriginConnectionGeneration;
  }

  private async reconcileComputerLifecycleOrigin(
    connectionGeneration: number,
    attempt: number,
    expectedOperationId?: string,
  ): Promise<void> {
    if (!this.options.reconcileComputerLifecycleOrigin
      || !this.connection.connected
      || connectionGeneration !== this.lifecycleOriginConnectionGeneration) {
      return;
    }
    try {
      const result = await this.options.reconcileComputerLifecycleOrigin();
      if (!this.connection.connected
        || connectionGeneration !== this.lifecycleOriginConnectionGeneration) {
        return;
      }
      const normalized = typeof result === "boolean"
        ? result
          ? { status: "adopted" as const, operationId: expectedOperationId }
          : { status: "not_adopted" as const }
        : result;
      const observedOperationId = "operationId" in normalized
        ? normalized.operationId
        : undefined;
      if (expectedOperationId && observedOperationId !== expectedOperationId) {
        logger.warn("[Daemon] Computer lifecycle origin reconcile stopped after operation identity changed");
        return;
      }
      if (normalized.status === "adopted") {
        await this.emitReady(connectionGeneration);
        return;
      }
      if (normalized.status !== "retryable_ready_pending") return;
      if (attempt >= COMPUTER_LIFECYCLE_ORIGIN_RECONCILE_MAX_ATTEMPTS) {
        logger.warn(
          `[Daemon] Computer lifecycle origin reconcile stopped after ${attempt} ready-pending attempts`,
        );
        return;
      }
      const operationId = expectedOperationId ?? normalized.operationId;
      this.lifecycleOriginRetryTimer = this.lifecycleOriginClock.setTimeout(() => {
        this.lifecycleOriginRetryTimer = null;
        void this.reconcileComputerLifecycleOrigin(
          connectionGeneration,
          attempt + 1,
          operationId,
        );
      }, COMPUTER_LIFECYCLE_ORIGIN_RECONCILE_RETRY_MS);
    } catch (err) {
      logger.warn(
        `[Daemon] Computer lifecycle origin reconcile skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.recordConnectLifecycleError("lifecycle_origin_reconcile", "reconcile_threw", err);
    }
  }

  private handleConnect() {
    const lifecycleOriginConnectionGeneration = this.invalidateLifecycleOriginReconcile();
    // task #1268: capabilities and detection rounds are per connection.
    this.serverContextCapabilities = null;
    this.abandonDetectionRound("reconnect");
    // Computer readiness tracks the live websocket handshake, not runtime
    // inventory. Publish that lifecycle edge before any synchronous probe can
    // delay the event loop (notably PowerShell Get-Command on fresh Windows
    // hosts). A failed hook must not suppress the daemon's fresh ready report.
    // Reconciler step 13 (Tenny f8ae3b79 condition 2): the upgrade intent of
    // the old connection is gone; a drain still holding lets go.
    this.upgradeDrain?.onConnected();
    try {
      this.options.lifecycleHooks?.onConnect?.();
    } catch (err) {
      logger.warn(`[Daemon] Connection lifecycle hook failed: ${err instanceof Error ? err.message : String(err)}`);
      this.recordConnectLifecycleError("lifecycle_hook", "lifecycle_hook_threw", err);
    }

    // One-shot on first connect: bring existing per-agent opencli wrappers to
    // the current self-healing form. A long-running agent whose wrapper predates
    // a package-tree mutation (e.g. an npm→SEA computer switch) otherwise keeps a
    // stale hardcoded path until it respawns. The per-spawn writer handles new
    // launches; this covers agents that don't respawn across the switch.
    if (!this.opencliWrappersRegenerated) {
      this.opencliWrappersRegenerated = true;
      try {
        const { scanned, rewritten, skipped } = regenerateExistingOpencliWrappers(this.agentsDataDir);
        if (scanned > 0) {
          logger.info(`[Daemon] Refreshed ${rewritten}/${scanned} opencli wrapper(s) to current self-healing form`);
        }
        if (skipped > 0) {
          // A workspace wrapper (or its `.slock`) that is not a plain file is left alone: never written through.
          this.recordDaemonEvent("daemon.opencli_wrapper_refresh.skipped", { skipped_count: skipped, scanned_count: scanned });
        }
      } catch (err) {
        logger.warn(`[Daemon] opencli wrapper refresh skipped: ${err instanceof Error ? err.message : String(err)}`);
        this.recordConnectLifecycleError("opencli_wrapper_refresh", "wrapper_refresh_threw", err);
      }
    }
    // #proj-raft-computer task #38: once per daemon process, remove the
    // credential-bearing chat-bridge entries older daemons left in agent
    // workspaces. Idempotent; launches clean their own workspace too, this
    // covers agents that do not start again.
    if (!this.legacyBridgeArtifactsMigrated) {
      this.legacyBridgeArtifactsMigrated = true;
      try {
        const summary = migrateAllLegacyBridgeArtifacts(this.agentsDataDir, { machineKey: this.options.apiKey || null });
        if (summary.removedEntries + summary.unlinked + summary.skipped > 0) {
          this.recordDaemonEvent("daemon.legacy_bridge_artifacts.migrated", {
            scanned_count: summary.scanned,
            removed_count: summary.removedEntries,
            unlinked_count: summary.unlinked,
            skipped_count: summary.skipped,
          });
        }
        if (summary.currentKeyExposed > 0) {
          // The file held this machine's CURRENT key, readable by the agent before
          // the cleanup: deleting it cannot undo that. Counts only, never the key.
          this.recordDaemonEvent("daemon.legacy_bridge_artifacts.current_key_exposed", { artifact_count: summary.currentKeyExposed }, "error");
          // A legacy key: kept so every `ready` tells the server (the owner is asked
          // to move this machine to a Computer credential). A Computer key: trace only.
          if (isLegacyMachineKey(this.options.apiKey)) {
            try {
              recordLegacyCredentialExposure(this.slockHome, this.options.apiKey, Date.now());
            } catch (err) {
              logger.warn(`[Daemon] credential exposure not recorded: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      } catch (err) {
        logger.warn(`[Daemon] legacy bridge artifact cleanup skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Once per daemon process: older daemons wrote the Computer's own key to
    // `agent-token` files the agents' runtimes can read, and nothing prunes
    // old launch directories. Counts only, never paths or contents.
    if (!this.staleAgentTokensRemoved) {
      this.staleAgentTokensRemoved = true;
      try {
        const { removed, skipped } = removeStaleAgentTokenFiles(this.slockHome, this.agentsDataDir);
        if (removed + skipped > 0) {
          logger.info(`[Daemon] Removed ${removed} stale agent-token file(s) left by older daemons; ${skipped} not a plain file, left alone`);
          this.recordDaemonEvent("daemon.stale_agent_tokens.removed", { removed_count: removed, skipped_count: skipped });
        }
      } catch (err) {
        logger.warn(`[Daemon] stale agent-token cleanup skipped: ${err instanceof Error ? err.message : String(err)}`);
        this.recordConnectLifecycleError("stale_agent_token_cleanup", "cleanup_threw", err);
      }
    }
    const initialReady = this.emitReady(lifecycleOriginConnectionGeneration);
    void initialReady.then((readySent) => {
      if (readySent) this.requestRuntimeModelCatalogPublish(false);
      // task #1357 item 1: after the ready that declares the capability, each
      // live Pi session's last limits report again (one sent while
      // disconnected was lost). The same session result, never a new session.
      if (readySent) {
        // Optional: test doubles of the manager may not implement it.
        for (const frame of this.agentManager.getModelLimitsReports?.() ?? []) this.connection.send(frame);
      }
      if (readySent) {
        this.flushComputerDeviceSessionRetire();
        this.flushComputerMachineLockConflicts();
        void this.flushComputerUpgradeSteps(this.lastReadyCarriedUpgradeReceipt);
        if (!this.lastReadyCarriedUpgradeReceipt) this.startComputerUpgradeOutcomeWatch();
      }
    });
    if (this.options.reconcileComputerLifecycleOrigin) {
      void initialReady
        .then((readySent) => readySent
          ? this.reconcileComputerLifecycleOrigin(lifecycleOriginConnectionGeneration, 1)
          : undefined)
        .catch((err) => {
          logger.warn(
            `[Daemon] Computer lifecycle origin reconcile skipped: ${err instanceof Error ? err.message : String(err)}`,
          );
          this.recordConnectLifecycleError("lifecycle_origin_reconcile", "reconcile_threw", err);
        });
    }
    // task #1103: wake requests parked while offline go out once per connect edge.
    this.agentManager.resendPendingServerWakes();
    const runningAgentIds = this.agentHosts.getRunningAgentIds();
    const idleAgentSessions = this.agentManager.getIdleAgentSessionIds();
    const runtimeProfileReports = this.agentManager.getAgentRuntimeProfileReports();

    if (this.options.onComputerRestartReconcile) {
      void Promise.resolve()
        .then(() =>
          this.options.onComputerRestartReconcile!((done) => {
            this.connection.send({ type: "computer:restart:done", ...done });
            this.recordDaemonEvent("daemon.computer_restart.reconciled", {
              request_id: done.requestId,
              ok: done.ok,
            });
          }),
        )
        .catch((err) => {
          logger.error(
            `[Daemon] computer restart reconcile failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          this.recordConnectLifecycleError("computer_restart_reconcile", "reconcile_threw", err);
        });
    }

    for (const agentId of runningAgentIds) {
      const sessionId = this.agentHosts.getAgentSessionId(agentId);
      const launchId = this.agentHosts.getAgentLaunchId(agentId);
      if (sessionId) {
        // TODO(lifecycle-v2/daemon-protocol): reconnect session replay should
        // be a canonical session_resynced/runtime_ready event with reconnect
        // window identity, not only legacy `agent:session`.
        this.connection.send({ type: "agent:session", agentId, sessionId, launchId: launchId || undefined });
      }
    }

    // Idle agents (Codex and others that exit normally between turns) also need
    // session resync so the server can preserve resume state across reconnects.
    for (const { agentId, sessionId, launchId } of idleAgentSessions) {
      // TODO(lifecycle-v2/daemon-protocol): idle session replay needs the same
      // canonical session_resynced/runtime_ready producer as running agents;
      // keep this legacy frame until the server no longer relies on adapter
      // inference for reconnect readiness.
      this.connection.send({ type: "agent:session", agentId, sessionId, launchId: launchId || undefined });
    }

    for (const report of runtimeProfileReports) {
      const span = this.tracer.startSpan("daemon.runtime_profile.report.sent", {
        surface: "daemon",
        kind: "producer",
        attrs: {
          agentId: report.agentId,
          launchId: report.launchId || undefined,
          runtime: report.facts.runtime,
          report_source: "connect",
          model_present: Boolean(report.facts.model),
          session_ref_present: Boolean(report.facts.sessionRef),
          workspace_ref_present: Boolean(report.facts.workspaceRef || report.facts.workspacePathRef),
        },
      });
      this.connection.send({
        type: "agent:runtime_profile",
        agentId: report.agentId,
        facts: report.facts,
        launchId: report.launchId || undefined,
        traceparent: formatTraceparent(span.context),
        source: "connect",
      });
      span.end("ok");
    }

    // Refill from the server's authoritative view. snapshot() applies
    // per-agent, so each request only replaces that agent's entries — no
    // global clear (which would race: the last snapshot to arrive would wipe
    // timers installed by earlier ones).
    const agentsForSnapshot = new Set<string>(runningAgentIds);
    for (const { agentId } of idleAgentSessions) {
      agentsForSnapshot.add(agentId);
    }
    this.localScheduleRuntime.onConnect();
    for (const agentId of agentsForSnapshot) {
      this.localScheduleRuntime.requestSnapshot(agentId);
    }

  }

  private handleDisconnect() {
    this.serverAcksRuntimeOutcomes = false;
    this.agentManager.setServerSendIntentCapable?.(false);
    this.agentHosts.setServerTurnEndedCapable?.(false);
    this.agentHosts.setServerStickyFailureReasonsCapable?.(false);
    this.localScheduleRuntime.setServerIdleTaskReminderCapable(false);
    // A request cannot be answered across a dropped connection; the next
    // context asks again.
    this.serverFeaturesCapable = false;
    this.serverFeaturesRefresh.reset();
    this.agentManager.setServerFeaturesCapable?.(false);
    // task #17: a login's link, code and result cannot cross a dropped
    // connection, so stop it rather than leave it holding the runtime.
    this.serverRuntimeAuthRuntimes = null;
    // Each connection sends its own inventory ready; a context arriving first must not probe the old one.
    this.runtimeAuthInventory = null;
    this.runtimeAuth.cancelAll();
    // The shared homes keep their last state; checks resume with the next context and ready.
    this.serverReadsRuntimeCredentialsChanged = false;
    this.credentialDiskWatch?.setSharedHomesActive(false);
    this.serverContextCapabilities = null;
    this.abandonDetectionRound("disconnect");
    this.runtimeOutcomeOutbox.onDisconnected();
    this.invalidateLifecycleOriginReconcile();
    logger.warn("[Daemon] Lost connection — agents continue running locally");
    this.recordDaemonEvent("daemon.connection.local_disconnect_observed", {
      running_agents_count: this.agentHosts.getRunningAgentIds().length,
      idle_agents_count: this.agentManager.getIdleAgentSessionIds().length,
    }, "cancelled");
    this.options.lifecycleHooks?.onDisconnect?.();
  }

  private handleHandshakeRejected(event: { statusCode: number; reason: string | null }) {
    this.options.lifecycleHooks?.onHandshakeRejected?.(event);
  }
}

/**
 * A start of an OAR-only runtime (drivers/oarOnly.ts) on a Computer whose OAR
 * host is turned off (`RAFT_DAEMON_OAR_HOST_DISABLED`): there is no router and
 * the legacy host cannot run it, so it fails before the agent counts as
 * starting. Null for every other runtime, including unknown ones (their start
 * fails as before).
 */
function oarOnlyStartWithoutOarHost(runtime: string): OarOnlyStartError | null {
  let driver;
  try {
    driver = getDriver(runtime);
  } catch {
    return null;
  }
  if (!driver.oarOnly) return null;
  return new OarOnlyStartError({
    runtimeId: runtime,
    hostReason: "oar_host_disabled",
    userMessage: `${runtimeLabel(runtime)} runs only on the OAR host, which is turned off on this Computer (${OAR_HOST_DISABLED_ENV}). Turn it back on, or move the agent to another Computer.`,
  });
}

/**
 * task #1357 item 1: `config` stamped with the server's revision of it
 * (`AgentConfig.configRevision`); unchanged when the server named none.
 */
export function withConfigRevision(config: AgentConfig, revision: number | undefined): AgentConfig {
  if (typeof revision !== "number" || !Number.isFinite(revision)) return config;
  return { ...config, configRevision: revision };
}
