import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { accessSync, createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  createTraceScopeTracer,
  AGENT_MIGRATION_RESUMABLE_CAPABILITIES,
  AGENT_MIGRATION_RESUMABLE_PROTOCOL,
  AGENT_MIGRATION_SOURCE_WORKSPACE_ARCHIVE_CAPABILITY,
  COMPUTER_CAPABILITY_SUPERVISOR_MUTATIONS,
  currentDate,
  currentTimeMs,
  formatTraceparent,
  getStaticRuntimeModelSourceSet,
  noopTracer,
  parseTraceparent,
  RUNTIMES,
  WIKI_WORKSPACE_PACK_CAPABILITY,
  type AgentConfig,
  type ComputerLifecycleExecutionAck,
  type AgentMigrationTransportLeaseMessage,
  type AgentMigrationTransferSummary,
  type AgentMigrationTransportReady,
  type MachineToServerMessage,
  type MachineShutdownReason,
  type RuntimeModelSourceOutcome,
  type RuntimeAccountUsageProvider,
  type RuntimeAccountUsageSnapshot,
  type ServerToMachineMessage,
  type TraceScope,
  type TraceSpanAttrContracts,
  type TraceStatus,
  type Tracer,
} from "@botiverse/raft-shared";
import {
  APP_CONFIG_TRACE_IDENTITY_KEYS,
  APP_SNAPSHOT_TRACE_IDENTITY_KEYS,
  APP_SOURCE_TRACE_IDENTITY_KEYS,
} from "@botiverse/raft-shared/src/appRuntimeTrace.js";
import { AgentProcessManager, classifySpawnFailure } from "./agentProcessManager.js";
import { getDriver } from "./drivers/index.js";
import { readCommandVersion, resolveCommandOnPath } from "./drivers/probe.js";
import {
  DaemonConnection,
  systemClock,
  type ConnectionOptions,
  type Clock,
} from "./connection.js";
import { createAgentAppInboxStore, type AgentAppInboxStore } from "./agentAppInbox.js";
import {
  createScopedAppStorageFactory,
  type ScopedAppStorageFactory,
} from "./scopedAppStorage.js";
import {
  createScopedAppStorageObserver,
  type ScopedAppStorageObserver,
} from "./scopedAppStorageObservability.js";
import {
  BUILT_IN_READY_CAPABILITIES,
  createBuiltInLocalScheduleRuntime,
} from "./registry.manifest.js";
import { logger } from "./logger.js";
import {
  acquireDaemonMachineLock,
  resolveDefaultMachineStateRoot,
  type DaemonMachineOwnerProvenance,
  type DaemonMachineLockHandle,
} from "./machineLock.js";
import {
  LocalRotatingTraceSink,
  computeTraceJitter,
  createTraceClient,
  NO_JITTER,
  type TraceJitter,
} from "@botiverse/raft-trace-client";
import { DaemonTraceBundleUploader } from "./traceBundleUpload.js";
import { SLOCK_HOME_ENV, listLegacyRaftStatePaths, resolveRaftHome, resolveRaftHomePath } from "./raftHome.js";
import { regenerateExistingOpencliWrappers } from "./drivers/cliTransport.js";
import { daemonFetch } from "./daemonFetch.js";
import { assertLegacyDaemonKeyNotAdoptedByComputer } from "./computerMigrationGuard.js";
import { ensureWikiAgentWorkspace } from "./wikiAgentWorkspace.js";
import { buildRuntimeModelSourceResultMessage } from "./runtimeModelSourceProjection.js";
import {
  AGENT_MIGRATION_TRANSPORT_HOST_ENV,
  AGENT_MIGRATION_TRANSPORT_PORT_ENV,
  AGENT_MIGRATION_TRANSPORT_PUBLIC_URL_ENV,
  createAgentMigrationHttpTransport,
  type AgentMigrationHttpTransport,
} from "./agentMigrationHttpTransport.js";
import { archiveCompletedAgentMigrationSourceWorkspace } from "./agentMigrationWorkspaceArchive.js";
import {
  summarizeAgentMigrationExportManifest,
} from "./agentMigrationExport.js";
import {
  AGENT_MIGRATION_OBJECT_STORE_CONTENT_TYPE,
  AgentMigrationObjectStoreBundleTooLargeError,
  AgentMigrationObjectStoreInsufficientDiskError,
  AgentMigrationObjectStoreManifestTooLargeError,
  buildAgentMigrationObjectStoreBundle,
  stageAgentMigrationObjectStoreBundle,
} from "./agentMigrationObjectStoreBundle.js";
import {
  buildAgentMigrationResumableBundle,
  classifyAgentMigrationTargetResidue,
  missingAgentMigrationChunks,
  stageAndCommitAgentMigrationResumableBundle,
  validateAgentMigrationControlManifest,
  verifyAndStoreAgentMigrationChunk,
  type AgentMigrationControlManifest,
} from "./agentMigrationResumableBundle.js";
import {
  buildAgentMigrationAdoptPlan,
  executeAgentMigrationAdoptPlan,
  type AgentMigrationRebindClient,
} from "./agentMigrationImport.js";

export * from "./agentMigrationExport.js";
export * from "./agentMigrationHttpTransport.js";
export * from "./agentMigrationObjectStoreBundle.js";
export * from "./agentMigrationResumableBundle.js";
export * from "./agentMigrationImport.js";
export * from "./legacySupervisor.js";
import { readSecretFileSync } from "./secretFile.js";
import {
  createRuntimeAccountUsageCollector,
  type RuntimeAccountUsageCollector,
} from "./runtimeAccountUsage/collector.js";

/**
 * Default endpoint for daemon trace bundle uploads. Always baked as the
 * fallback when no explicit URL is configured — per product decision, the
 * same hosted URL applies across environments (real users connect to
 * hosted prod anyway), with two explicit escape hatches:
 *
 *   1. `SLOCK_DAEMON_TRACE_UPLOAD_DISABLED=1` — highest priority off-switch
 *   2. `SLOCK_DAEMON_TRACE_UPLOAD_URL` — explicit override for any env
 *
 * Self-host / staging / play / local deployments that want no upload must
 * set `DISABLED=1`; those that want their own worker set the URL explicitly.
 */
const DEFAULT_TRACE_UPLOAD_URL = "https://slock-trace-upload.botiverse.dev";
const RUNNER_CREDENTIAL_SCOPES = ["send", "read", "mentions", "tasks", "reactions", "server", "channels", "knowledge", "mcp"] as const;
const RUNNER_CREDENTIAL_MINT_MAX_ATTEMPTS = 3;
const RUNNER_CREDENTIAL_MINT_RETRY_DELAY_MS = 250;
const MIGRATION_OBJECT_STORE_DOWNLOAD_RETRY_INITIAL_MS = 25;
const MIGRATION_OBJECT_STORE_DOWNLOAD_RETRY_MAX_MS = 250;

function migrationStatePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "migration";
}
const STUCK_TOOL_V0_IDENTITY_ATTRS = [
  "schema_version",
  "server_id",
  "machine_id",
  "agent_id",
  "launch_id",
  "runtime_session_id",
  "runtime_session_id_present",
  "runtime_turn_id",
  "tool_execution_instance_id",
  "runtime_tool_call_id_present",
  "process_instance_id",
  "producer_fact_id",
  "runtime",
  "runtime_version",
  "tool_class",
] as const;

export const DAEMON_CORE_TRACE_ATTR_CONTRACTS = {
  "daemon.runtime_account_usage.refresh": {
    spanAttrs: [
      "outcome",
      "provider",
      "reason",
      "account_count",
      "window_count",
      "health_classes",
      "parse_unavailable_count",
      "error_class",
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
  "daemon.agent.app_inbox_notice": {
    spanAttrs: [
      ...APP_SOURCE_TRACE_IDENTITY_KEYS,
      "outcome",
      "mode",
      "pending_app_items",
      "message_identity_created",
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
  },
  "daemon.app_source.receipt": {
    spanAttrs: [...APP_SOURCE_TRACE_IDENTITY_KEYS, "outcome", "catchup"],
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
    eventAttrs: {
      "daemon.machine_lock.acquired": ["machine_dir_present"],
    },
  },
  "daemon.lifecycle.stop": {
    spanAttrs: ["machine_lock_present"],
  },
  "daemon.runner_credential_mint.retry": {
    spanAttrs: ["agentId", "runtime", "attempt", "max_attempts", "status", "code", "reason", "retryable"],
  },
  "daemon.runner_credential_mint.failed": {
    spanAttrs: ["agentId", "runtime", "status", "code", "reason", "retryable", "max_attempts"],
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
    spanAttrs: ["agentId", "launchId", "runtime", "candidate_source", "host_kind", "electron_run_as_node"],
    endAttrs: ["error_class"],
  },
  "daemon.agent.process.error": {
    spanAttrs: ["agent_id", "server_id", "machine_id", "launch_id", "start_dispatch_id", "process_instance_id", "session_id_present", "runtime", "runtime_version", "error_class"],
  },
  "daemon.codex.request_instruction_shape": {
    spanAttrs: [
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
      "residency_state_instance_id",
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
      "route_family",
      "method",
      "trace_context_state",
      "proxy_launch_id_present",
      "correlation_id",
    ],
    endAttrs: [
      "outcome",
      "local_response_kind",
      "http_status",
      "normalized_code",
      "response_started",
    ],
  },
  "daemon.runtime_profile.control.received": {
    spanAttrs: ["agentId", "control_kind", "key_present", "launchId"],
    endAttrs: ["outcome", "error_class"],
  },
  "daemon.computer_control.received": {
    spanAttrs: ["action", "handled", "operation_id", "request_id"],
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
    spanAttrs: ["runtime", "requestId"],
    eventAttrs: {
      "daemon.pi.models.services_ready": ["available_models_count", "diagnostics_count", "diagnostic_info_count", "diagnostic_warning_count"],
      "daemon.pi.models.result": ["available_models_count", "returned_models_count", "diagnostics_count", "diagnostic_info_count", "diagnostic_warning_count", "outcome"],
    },
    endAttrs: ["outcome", "models_count", "default_model_present", "verified_as", "error_class"],
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
        "session_id_present",
        "runtime_session_id",
        "launch_id_present",
        "launch_id",
      ],
    },
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
      "endpoint_class",
      "http_status",
      "content_length_present",
      "upload_body_mode",
      "bundle_size_bucket",
      "bundle_content_bytes",
      "max_bytes",
      "manifest_sha_present",
      "attempt",
      "status",
      "retry_delay_ms",
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
      "status",
      "retry_delay_ms",
      "chunk_count",
      "bundle_size_bucket",
      "control_bytes",
      "commit_outcome",
      "residue_class",
    ],
  },
  "daemon.migration_transport.lease": {
    spanAttrs: [
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
      "status",
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
export { subscribeDaemonLogs, type DaemonLogEvent, type DaemonLogLevel } from "./logger.js";
export {
  deleteWorkspaceDirectory,
  resolveWorkspaceDirectoryPath,
  scanWorkspaceDirectories,
} from "./workspaces.js";

export const DAEMON_CLI_USAGE = "Usage: slock-daemon --server-url <url> --api-key-file <path>";

export interface ParsedDaemonCliArgs {
  serverUrl: string;
  apiKey: string;
}

export interface RuntimeDetection {
  ids: string[];
  versions: Record<string, string>;
  diagnostics?: Record<string, string>;
}

export type DefaultAgentEnvVarsProvider = (
  config: Pick<AgentConfig, "runtime" | "model" | "envVars">,
) => Promise<Record<string, string> | null> | Record<string, string> | null;

class RunnerCredentialMintError extends Error {
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

function migrationTransferFailureMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 500);
}

export function migrationTransferFailureCode(err: unknown): string | undefined {
  if (
    err instanceof AgentMigrationObjectStoreBundleTooLargeError
    || err instanceof AgentMigrationObjectStoreManifestTooLargeError
    || err instanceof AgentMigrationObjectStoreInsufficientDiskError
  ) {
    return err.code;
  }
  const message = err instanceof Error ? err.message : String(err);
  const code = /^(MIGRATION_[A-Z0-9_]+)/.exec(message)?.[1];
  return code && RESUMABLE_MIGRATION_SPECIFIC_ERROR_CODES.has(code) ? code : undefined;
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
  | "source_ready_report"
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

class MigrationObjectStoreUploadHttpError extends Error {
  constructor(
    readonly status: number,
    readonly archiveBytes: number,
  ) {
    super(`MIGRATION_OBJECT_STORE_UPLOAD_FAILED:${status}`);
    this.name = "MigrationObjectStoreUploadHttpError";
  }
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
  if (!(err instanceof MigrationObjectStoreUploadHttpError)) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      stage: "transfer",
      error_code: /^(MIGRATION_[A-Z0-9_]+)/.exec(message)?.[1],
    };
  }
  return {
    stage: "transfer",
    error_code: "MIGRATION_OBJECT_STORE_UPLOAD_FAILED",
    endpoint_class: "object_store",
    http_status: err.status,
    content_length_present: true,
    upload_body_mode: "spooled_file",
    bundle_size_bucket: migrationObjectStoreBundleSizeBucket(err.archiveBytes),
  };
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

export interface DaemonCoreOptions {
  serverUrl: string;
  apiKey: string;
  daemonVersion?: string;
  computerVersion?: string | null;
  slockCliPath?: string;
  dataDir?: string;
  /** Test/embedded override; production resolves the canonical Raft home. */
  slockHome?: string;
  machineStateDir?: string;
  machineOwnerProvenance?: DaemonMachineOwnerProvenance;
  hostname?: string;
  osDescription?: string;
  runtimeDetector?: () => RuntimeDetection;
  connectionOptions?: Partial<Pick<ConnectionOptions, "inboundWatchdogMs" | "minReconnectDelayMs" | "wsFactory" | "proxyEnv" | "clock">>;
  connectionFactory?: (options: ConnectionOptions) => DaemonConnection;
  agentManagerFactory?: (
    sendToServer: (msg: MachineToServerMessage) => void,
    daemonApiKey: string,
    options?: { dataDir?: string; serverUrl: string; defaultAgentEnvVarsProvider?: DefaultAgentEnvVarsProvider; slockCliPath?: string; slockHome?: string; tracer?: Tracer; daemonInstanceId?: string; appInboxForAgent?: (agentId: string) => AgentAppInboxStore },
  ) => AgentProcessManager;
  defaultAgentEnvVarsProvider?: DefaultAgentEnvVarsProvider;
  /** Seam for tests — injected into the ReminderCache so timers can be faked. */
  reminderClock?: Clock;
  tracer?: Tracer;
  localTrace?: boolean;
  localTraceMaxFileBytes?: number;
  localTraceMaxFileAgeMs?: number;
  localTraceMaxFiles?: number;
  lifecycleHooks?: {
    onConnect?: () => void;
    onDisconnect?: () => void;
    onHandshakeRejected?: (event: { statusCode: number; reason: string | null }) => void;
  };
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
   * runner reports `done` via `onComputerUpgradeReconcile`; on failure the
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
   * Called once after `ready` is sent on each (re)connect. A managed Computer
   * uses this to detect that THIS process booted from a freshly swapped binary
   * (a pending-upgrade marker is present) and report `computer:upgrade:done`,
   * stitching the upgrade's connection blip via the marker's `requestId`. The
   * hook owns reading + clearing its own marker; `emitDone` sends the upstream
   * frame (core fills `type`). Absent for a raw daemon.
   */
  onComputerUpgradeReconcile?: (
    emitDone: (done: { requestId: string; ok: boolean; newVersion?: string; rolledBack?: boolean; error?: string }) => void,
    emitProgress: (progress: { requestId: string; phase: "restarting"; message: string }) => void,
  ) => void | Promise<void>;
  /** Report a persisted restart request only after this new runner generation
   * has connected and sent ready. The hook owns marker read/clear. */
  onComputerRestartReconcile?: (
    emitDone: (done: { requestId: string; ok: boolean; error?: string }) => void,
  ) => void | Promise<void>;
  /** Test seam; production creates the transport only when listen env is configured. */
  migrationTransport?: AgentMigrationHttpTransport | null;
  /** Test seam; production collectors keep credentials and raw provider responses local. */
  runtimeAccountUsageCollector?: RuntimeAccountUsageCollector;
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
 * Context handed to `onComputerControl` for the `upgrade` action so the
 * managed Computer can stream progress + terminal outcome over the runner's
 * live WS without owning the connection itself.
 */
export interface ComputerControlContext {
  /** Canonical lifecycle operation identifier. */
  operationId?: string;
  /** Echoes the triggering `computer:upgrade{requestId}`; undefined if the
   *  command carried none. */
  requestId?: string;
  /** Stream upgrade progress upstream. core fills `type` + `requestId`;
   *  safe no-op if the connection has since dropped. */
  emitUpgradeProgress: (ev: {
    phase: "downloading" | "verifying" | "applying" | "restarting";
    message?: string;
    percent?: number;
    fromVersion?: string;
    targetVersion?: string;
  }) => void;
  /** Report a terminal upgrade outcome upstream. Used by the upgrading
   *  process only on FAILURE (no restart happens) — on success the process
   *  exits and the respawned binary reports `done` via the reconnect path. */
  emitUpgradeDone: (ev: { ok: boolean; newVersion?: string; rolledBack?: boolean; error?: string }) => void;
}

interface MigrationTargetImportView {
  grantKey: string;
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

/**
 * Run the bundled `slock` CLI in-process with `argv` as its arguments.
 *
 * The busybox/self-re-exec answer to "how does an agent call `slock` on a SEA
 * single-binary Computer". A SEA binary can't spawn `node <cli-script>` (no
 * node, no sidecar script), so instead the SEA binary re-execs itself in a CLI
 * mode (`<exe> __cli <args>`) and this runs the CLI it bundled. The CLI entry
 * runs `program.parseAsync(process.argv)` on import, so we rewrite argv to look
 * like a normal `slock <args>` invocation and then load it. A fresh process is
 * spawned per agent `slock` call (the cliTransport wrapper execs `<exe> __cli`),
 * so there is no module-cache reuse concern. Importing the entry here also pulls
 * the CLI into the SEA bundle's import graph (it is otherwise only referenced by
 * path via {@link resolveRaftCliPath} and would not be embedded).
 */
export async function runBundledRaftCli(argv: string[]): Promise<void> {
  process.argv = [process.execPath, "slock", ...argv];
  // Static specifier (so esbuild embeds the CLI into the SEA bundle), but the
  // CLI dist ships no .d.ts beside index.js → TS7016. It is a side-effecting
  // "run the CLI" import, not a typed module.
  // @ts-expect-error - untyped CLI entry; importing it runs program.parseAsync.
  await import("@botiverse/raft/dist/index.js");
}

export function detectRuntimes(tracer: Tracer = noopTracer): RuntimeDetection {
  const ids: string[] = [];
  const versions: Record<string, string> = {};
  const diagnostics: Record<string, string> = {};
  const span = tracer.startSpan("daemon.runtime.detect", {
    surface: "daemon",
    kind: "internal",
    attrs: {
      known_runtime_count: RUNTIMES.length,
    },
  });

  for (const runtime of RUNTIMES) {
    const driver = getDriver(runtime.id);
    let probeErrorPresent = false;
    try {
      if (driver.probe) {
        const probe = driver.probe();
        if (!probe.available) {
          if (probe.version) versions[runtime.id] = probe.version;
          if (probe.diagnostic) diagnostics[runtime.id] = probe.diagnostic;
          span.addEvent("daemon.runtime.detect.checked", {
            runtime: runtime.id,
            outcome: "unavailable",
            version_present: Boolean(probe.version),
            diagnostic_present: Boolean(probe.diagnostic),
            ...(probe.diagnostic ? { diagnostic: probe.diagnostic } : {}),
            binary_path_present: false,
          });
          continue;
        }
        ids.push(runtime.id);
        if (probe.version) versions[runtime.id] = probe.version;
        if (probe.diagnostic) diagnostics[runtime.id] = probe.diagnostic;
        span.addEvent("daemon.runtime.detect.checked", {
          runtime: runtime.id,
          outcome: "available",
          version_present: Boolean(probe.version),
          diagnostic_present: Boolean(probe.diagnostic),
          ...(probe.diagnostic ? { diagnostic: probe.diagnostic } : {}),
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
  return { ids, versions, ...(Object.keys(diagnostics).length > 0 ? { diagnostics } : {}) };
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

function hasAgentMigrationHttpTransportListenConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env[AGENT_MIGRATION_TRANSPORT_HOST_ENV]?.trim()
    || env[AGENT_MIGRATION_TRANSPORT_PORT_ENV]?.trim()
    || env[AGENT_MIGRATION_TRANSPORT_PUBLIC_URL_ENV]?.trim()
  );
}

function formatChannelTarget(msg: ServerToMachineMessage & { type: "agent:deliver" }): string {
  return msg.message.channel_type === "dm"
    ? `dm:@${msg.message.channel_name}`
    : `#${msg.message.channel_name}`;
}

function summarizeIncomingMessage(msg: ServerToMachineMessage): string {
  switch (msg.type) {
    case "machine:context":
      return `(machine=${msg.machineId}, server=${msg.serverId})`;
    case "agent:start":
      return `(agent=${msg.agentId}, runtime=${msg.config.runtime}, model=${msg.config.model}, session=${msg.config.sessionId || "new"}${msg.wakeMessage ? ", wake=true" : ""})`;
    case "agent:start:wiki":
      return `(agent=${msg.agentId}, runtime=${msg.config.runtime}, model=${msg.config.model}, session=${msg.config.sessionId || "new"}, wikiPack=${msg.wikiWorkspacePack.packId.slice(0, 12)}${msg.wakeMessage ? ", wake=true" : ""})`;
    case "agent:stop":
      return `(agent=${msg.agentId})`;
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
    case "agent:workspace:ensure-wiki":
      return `(agent=${msg.agentId}, pack=${msg.pack.packId.slice(0, 12)})`;
    case "agent:skills:list":
      return `(agent=${msg.agentId}, runtime=${msg.runtime || "auto"}, req=${msg.requestId || "legacy"})`;
    case "agent:diagnostic:session_transcript":
      return `(agent=${msg.agentId})`;
    case "agent:diagnostic:feedback_transcript":
      return `(agent=${msg.agentId}, feedbackReportId=${msg.feedbackReportId})`;
    case "agent:activity_probe":
      return `(agent=${msg.agentId}, probe=${msg.probeId.slice(0, 8)}, purpose=${msg.purpose})`;
    case "machine:workspace:delete":
      return `(directory=${msg.directoryName})`;
    case "machine:runtime_models:detect":
      return `(runtime=${msg.runtime}, req=${msg.requestId})`;
    case "machine:runtime_account_usage:refresh":
      return `(provider=${msg.provider}, reason=${msg.reason}, req=${msg.requestId})`;
    case "machine:runtimes:rescan":
      return "(rescan runtimes)";
    case "machine:migration:source_workspace_archive":
      return `(agent=${msg.agentId}, migration=${msg.migrationId})`;
    case "machine:migration_transport:lease":
      return `(agent=${msg.agentId}, migration_ref=${msg.migrationRef}, session=${msg.sessionId}, provider=${msg.provider}, role=${msg.role}, kind=${msg.transferKind}, url=${msg.url ? "set" : "missing"})`;
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

type AgentStartMessage =
  | Extract<ServerToMachineMessage, { type: "agent:start" }>
  | Extract<ServerToMachineMessage, { type: "agent:start:wiki" }>;
type AgentDeliverMessage = Extract<ServerToMachineMessage, { type: "agent:deliver" }>;
type AgentStartAckMessage = Extract<MachineToServerMessage, { type: "agent:start:ack" }>;

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
  return deliveries.findIndex((delivery) => delivery.transient !== true && !delivery.mentionDelivery);
}

export class DaemonCore {
  private readonly options: DaemonCoreOptions;
  private readonly daemonVersion: string;
  private readonly daemonInstanceId = randomUUID();
  // When this runner is launched by a managed Computer service, the service
  // passes the Computer bundle version explicitly. Reported in `ready` so the
  // server can surface it distinctly from the underlying daemonVersion.
  private readonly computerVersion: string | null;
  private readonly slockCliPath: string;
  private readonly slockHome: string;
  private readonly agentsDataDir: string;
  // One-shot guard: rewrite stale per-agent opencli wrappers to the current
  // self-healing form on the first connect of this daemon process (a SEA
  // computer switch / daemon upgrade restarts the daemon → triggers this).
  private opencliWrappersRegenerated = false;
  private readonly runtimeDetector: () => RuntimeDetection;
  private readonly agentManager: AgentProcessManager;
  private readonly connection: DaemonConnection;
  private readonly appScheduleClock: Clock;
  private readonly lifecycleOriginClock: Clock;
  private lifecycleOriginConnectionGeneration = 0;
  private lifecycleOriginRetryTimer: unknown = null;
  private readonly localScheduleRuntime: ReturnType<typeof createBuiltInLocalScheduleRuntime>;
  private readonly appInboxes = new Map<string, AgentAppInboxStore>();
  private readonly migrationTransport: AgentMigrationHttpTransport | null;
  private migrationTransportListenPromise: Promise<void> | null = null;
  private migrationTransportListening = false;
  private migrationTransportUrl: string | null = null;
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
  private readonly coreStartingAgentIds = new Set<string>();
  private readonly coreStartPendingDeliveries = new Map<string, AgentDeliverMessage[]>();
  private readonly acceptedStartDispatches = new Map<string, AgentStartAckMessage>();
  private readonly acceptingStartDispatches = new Map<string, Promise<AgentStartAckMessage>>();
  private readonly handledComputerControlOperationIds = new Set<string>();
  private readonly runtimeAccountUsageCollector: RuntimeAccountUsageCollector;
  private static readonly START_DISPATCH_RECEIPT_CACHE_SIZE = 1_024;

  constructor(options: DaemonCoreOptions) {
    this.options = options;
    this.daemonVersion = options.daemonVersion ?? readDaemonVersion();
    this.computerVersion = options.computerVersion?.trim() || null;
    // Resolve eagerly but NON-FATALLY: the slock CLI path is only needed when
    // an agent actually spawns (cliTransport injects it + throws a clear error
    // if empty). A daemon must still be able to construct + connect + report
    // ready when the CLI dist isn't a resolvable sidecar file — e.g. a SEA
    // single-binary where the CLI is bundled into the executable, not on disk.
    // Crashing the whole runner at construction (pre-connect) was wrong.
    this.slockCliPath = options.slockCliPath ?? resolveRaftCliPathOrEmpty();
    this.slockHome = options.slockHome ? path.resolve(options.slockHome) : resolveRaftHome();
    if (!options.slockHome) process.env[SLOCK_HOME_ENV] = this.slockHome;
    this.injectedTracer = Boolean(options.tracer);
    this.tracer = this.withDaemonTraceScope(options.tracer ?? noopTracer);
    this.runtimeDetector = options.runtimeDetector ?? (() => detectRuntimes(this.tracer));
    this.runtimeAccountUsageCollector = options.runtimeAccountUsageCollector
      ?? createRuntimeAccountUsageCollector({
        localAccountSlot: this.slockHome,
        collectorVersion: this.daemonVersion,
        now: currentTimeMs,
      });
    this.appScheduleClock = options.reminderClock ?? systemClock;
    this.lifecycleOriginClock = options.connectionOptions?.clock ?? systemClock;

    this.migrationTransport = options.migrationTransport === undefined
      ? (hasAgentMigrationHttpTransportListenConfig() ? createAgentMigrationHttpTransport() : null)
      : options.migrationTransport;

    let connection!: DaemonConnection;

    this.agentsDataDir = options.dataDir ?? resolveRaftHomePath("agents", this.slockHome);
    const traceUploadDisabled = process.env.SLOCK_DAEMON_TRACE_UPLOAD_DISABLED === "1";
    const agentManagerOptions = {
      dataDir: this.agentsDataDir,
      serverUrl: options.serverUrl,
      defaultAgentEnvVarsProvider: options.defaultAgentEnvVarsProvider,
      slockCliPath: this.slockCliPath,
      slockHome: this.slockHome,
      tracer: this.tracer,
      daemonVersion: this.daemonVersion,
      daemonInstanceId: this.daemonInstanceId,
      computerVersion: this.computerVersion,
      workerUrl: traceUploadDisabled ? undefined : (process.env.SLOCK_DAEMON_TRACE_UPLOAD_URL || DEFAULT_TRACE_UPLOAD_URL),
      serverConnected: () => connection?.connected ?? false,
      appInboxForAgent: (agentId: string) => this.getAgentAppInbox(agentId),
    };

    this.agentManager = options.agentManagerFactory
      ? options.agentManagerFactory((msg) => connection.send(msg), options.apiKey, agentManagerOptions)
      : new AgentProcessManager((msg) => connection.send(msg), options.apiKey, agentManagerOptions);

    this.localScheduleRuntime = createBuiltInLocalScheduleRuntime({
      agentsDataDir: this.agentsDataDir,
      clock: this.appScheduleClock,
      getInbox: (agentId) => this.getAgentAppInbox(agentId),
      notifyInbox: (agentId, item) =>
        this.agentManager.notifyAgentAppInbox(agentId, item),
      send: (message) => connection.send(message),
      trace: (name, attrs, status) =>
        this.recordDaemonTrace(name, { ...attrs }, status),
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
      onTraceEvent: (name, attrs, status) => this.recordDaemonTrace(name, attrs, status),
    });

    this.connection = connection;
    this.localScheduleRuntime.start();
  }

  private getAgentAppInbox(agentId: string): AgentAppInboxStore {
    if (this.machineContextConflict) {
      this.recordDaemonTrace("daemon.app_storage.access_denied", {
        app_id: "system.agent-inbox",
        outcome: "denied",
        reason: "machine_context_conflict",
      }, "error");
      throw new Error("agent app inbox unavailable after authenticated machine context conflict");
    }
    const storageFactory = this.scopedAppStorageFactory;
    if (!storageFactory) {
      this.recordDaemonTrace("daemon.app_storage.access_denied", {
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
        this.recordDaemonTrace("daemon.app_storage.legacy_quarantined", {
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
          this.recordDaemonTrace(name, attrs, status),
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
    this.agentManager.setTracer(this.tracer);
    this.agentManager.setCliTransportTraceDir(path.join(machineDir, "traces"));
  }

  private installTraceBundleUploader(machineDir: string): void {
    if (!this.shouldEnableLocalTrace()) return;
    if (this.traceBundleUploader) return;

    // Highest priority off-switch: SLOCK_DAEMON_TRACE_UPLOAD_DISABLED=1
    if (process.env.SLOCK_DAEMON_TRACE_UPLOAD_DISABLED === "1") return;

    // Explicit URL override wins; otherwise fall back to the baked default.
    // Self-host / local / staging etc. must use DISABLED=1 to opt out or
    // set their own SLOCK_DAEMON_TRACE_UPLOAD_URL to redirect.
    const workerUrl = process.env.SLOCK_DAEMON_TRACE_UPLOAD_URL || DEFAULT_TRACE_UPLOAD_URL;
    this.traceBundleUploader = new DaemonTraceBundleUploader({
      machineDir,
      serverUrl: this.options.serverUrl,
      apiKey: this.options.apiKey,
      workerUrl,
      tracer: this.tracer,
      currentFileProvider: () => this.localTraceSink?.getCurrentFile() ?? null,
      jitter: this.resolveTraceJitter(),
    });
    this.traceBundleUploader.start();
  }

  start() {
    logger.info("[Slock Daemon] Starting...");
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
    if (!this.machineLock) {
      this.machineLock = acquireDaemonMachineLock({
        apiKey: this.options.apiKey,
        serverUrl: this.options.serverUrl,
        rootDir: this.resolveMachineStateRoot(),
        ownerProvenance: this.options.machineOwnerProvenance,
      });
      logger.info(`[Slock Daemon] Acquired machine lock: ${this.machineLock.lockDir}`);
      this.installLocalTraceSink(this.machineLock.machineDir);
      this.installTraceBundleUploader(this.machineLock.machineDir);
      const span = this.tracer.startSpan("daemon.lifecycle.start", {
        surface: "daemon",
        kind: "internal",
        attrs: {
          machine_dir_present: true,
          local_trace_enabled: this.shouldEnableLocalTrace(),
        },
      });
      span.addEvent("daemon.machine_lock.acquired", { machine_dir_present: true });
      span.end("ok");
    }
    if (this.migrationTransport) {
      this.startMigrationTransport();
    }
    try {
      this.connection.connect();
    } catch (err) {
      void this.stopMigrationTransport();
      this.traceBundleUploader?.stop();
      this.traceBundleUploader = null;
      this.machineLock.release();
      this.machineLock = null;
      throw err;
    }
  }

  async stop() {
    logger.info("[Slock Daemon] Shutting down...");
    const shutdownReason = this.resolveMachineShutdownReason();
    const span = this.tracer.startSpan("daemon.lifecycle.stop", {
      surface: "daemon",
      kind: "internal",
      attrs: {
        machine_lock_present: Boolean(this.machineLock),
        shutdown_reason: shutdownReason,
      },
    });
    this.localScheduleRuntime.stop();
    this.invalidateLifecycleOriginReconcile();
    this.scopedAppStorageObserver?.stop();
    this.scopedAppStorageObserver = null;
    this.traceBundleUploader?.stop();
    this.traceBundleUploader = null;
    try {
      await this.agentManager.stopAll();
      span.addEvent("daemon.agents.stopped");
    } finally {
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
      await this.stopMigrationTransport();
      this.connection.disconnect();
      span.addEvent("daemon.connection.disconnect_requested");
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
    return this.agentManager.getRunningAgentIds();
  }

  private recordDaemonTrace(name: string, attrs?: Record<string, unknown>, status: TraceStatus = "ok"): void {
    const span = this.tracer.startSpan(name, {
      surface: "daemon",
      kind: "internal",
      attrs,
    });
    span.end(status);
  }

  private getMigrationTransportReady(): AgentMigrationTransportReady {
    const transferLease = this.getActiveMigrationTransferLease();
    if (transferLease) {
      return {
        provisioned: true,
        endpoint: transferLease.url,
        leaseSource: "server",
        provider: transferLease.provider,
        role: transferLease.role,
        transferKind: transferLease.transferKind,
        url: transferLease.url,
        expiresAt: transferLease.expiresAt,
        maxBytes: transferLease.maxBytes,
        protocol: AGENT_MIGRATION_RESUMABLE_PROTOCOL,
        capabilities: [
          ...AGENT_MIGRATION_RESUMABLE_CAPABILITIES,
          AGENT_MIGRATION_SOURCE_WORKSPACE_ARCHIVE_CAPABILITY,
        ],
        observedAt: currentDate().toISOString(),
      };
    }

    const endpoint = this.migrationTransportListening ? this.migrationTransportUrl : null;
    return {
      provisioned: Boolean(endpoint),
      endpoint,
      leaseSource: endpoint ? "env" : null,
      protocol: AGENT_MIGRATION_RESUMABLE_PROTOCOL,
      capabilities: [
        ...AGENT_MIGRATION_RESUMABLE_CAPABILITIES,
        AGENT_MIGRATION_SOURCE_WORKSPACE_ARCHIVE_CAPABILITY,
      ],
      observedAt: currentDate().toISOString(),
    };
  }

  private startMigrationTransport(): void {
    if (!this.migrationTransport || this.migrationTransportListenPromise) return;

    this.migrationTransportListenPromise = this.migrationTransport.listen()
      .then(({ url }) => {
        this.migrationTransportListening = true;
        this.migrationTransportUrl = url;
        logger.info(`[Slock Daemon] Agent migration HTTP transport listening: ${url}`);
        this.recordDaemonTrace("daemon.migration_transport.listen", {
          outcome: "listening",
          url_present: Boolean(url),
        });
      })
      .catch((err: unknown) => {
        this.migrationTransportListening = false;
        this.migrationTransportUrl = null;
        logger.error("[Slock Daemon] Agent migration HTTP transport failed to listen", err);
        this.recordDaemonTrace("daemon.migration_transport.listen", {
          outcome: "failed",
          error_class: err instanceof Error ? err.name : typeof err,
        }, "error");
      });
  }

  private async stopMigrationTransport(): Promise<void> {
    if (!this.migrationTransport) return;

    const listenPromise = this.migrationTransportListenPromise;
    this.migrationTransportListenPromise = null;
    if (listenPromise) await listenPromise;
    if (!this.migrationTransportListening) return;

    try {
      await this.migrationTransport.close();
      this.migrationTransportUrl = null;
      logger.info("[Slock Daemon] Agent migration HTTP transport stopped");
      this.recordDaemonTrace("daemon.migration_transport.stop", { outcome: "stopped" });
    } catch (err) {
      logger.error("[Slock Daemon] Agent migration HTTP transport failed to stop", err);
      this.recordDaemonTrace("daemon.migration_transport.stop", {
        outcome: "failed",
        error_class: err instanceof Error ? err.name : typeof err,
      }, "error");
    } finally {
      this.migrationTransportListening = false;
      this.migrationTransportUrl = null;
    }
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
    if (!lease.url.trim()) throw new Error("migration transfer lease url is required");
    if (!lease.bearerToken.trim()) throw new Error("migration transfer lease bearer token is required");
    const expiresAtMs = Date.parse(lease.expiresAt);
    if (!lease.expiresAt.trim() || !Number.isFinite(expiresAtMs) || expiresAtMs <= currentTimeMs()) {
      throw new Error("migration transfer lease expiresAt must be a future timestamp");
    }
    if (!Number.isInteger(lease.maxBytes) || lease.maxBytes <= 0) {
      throw new Error("migration transfer lease maxBytes must be a positive integer");
    }
    if (lease.protocol !== undefined) {
      if (lease.protocol !== AGENT_MIGRATION_RESUMABLE_PROTOCOL) {
        throw new Error("MIGRATION_RESUMABLE_PROTOCOL_UNSUPPORTED");
      }
      if (
        !Array.isArray(lease.capabilities)
        || !AGENT_MIGRATION_RESUMABLE_CAPABILITIES.every((capability) =>
          lease.capabilities?.includes(capability))
        || !lease.controlUrl?.trim()
        || !lease.leaseId?.trim()
        || !lease.transportGeneration?.trim()
        || !lease.sourceMachineId?.trim()
        || !lease.targetMachineId?.trim()
        || !Number.isSafeInteger(lease.expectedMigrationRevision)
      ) {
        throw new Error("MIGRATION_RESUMABLE_CAPABILITY_REQUIRED");
      }
    }
  }

  private handleMigrationTransportLease(lease: AgentMigrationTransportLeaseMessage): void {
    try {
      this.applyMigrationTransferLease(lease);
    } catch (err) {
      logger.error("[Slock Daemon] Failed to apply migration transport lease", err);
      this.recordDaemonTrace("daemon.migration_transport.lease", {
        outcome: "failed",
        lease_present: true,
        error_class: err instanceof Error ? err.name : typeof err,
      }, "error");
    }
  }

  private applyMigrationTransferLease(lease: AgentMigrationTransportLeaseMessage): void {
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
      this.recordDaemonTrace("daemon.migration_transport.lease", {
        ...migrationTraceIdentityAttrs(lease, "lease"),
        outcome: "unchanged",
        agent_id_present: true,
        migration_id_present: true,
        session_id_present: true,
        migration_generation: lease.migrationGeneration,
        provider: lease.provider,
        role: lease.role,
        transfer_kind: lease.transferKind,
      });
      this.startMigrationTransferRun(lease);
      return;
    }

    this.migrationTransferLease = lease;
    this.emitReadyIfConnected();
    this.recordDaemonTrace("daemon.migration_transport.lease", {
      ...migrationTraceIdentityAttrs(lease, "lease"),
      outcome: "applied",
      agent_id_present: true,
      migration_id_present: true,
      session_id_present: true,
      migration_generation: lease.migrationGeneration,
      provider: lease.provider,
      role: lease.role,
      transfer_kind: lease.transferKind,
      url_present: Boolean(lease.url),
      bearer_token_present: Boolean(lease.bearerToken),
    });
    this.startMigrationTransferRun(lease);
  }

  private startMigrationTransferRun(lease: AgentMigrationTransportLeaseMessage): void {
    const key = [
      lease.agentId,
      lease.migrationId,
      lease.migrationGeneration,
      lease.sessionId,
      lease.role,
      lease.transportGeneration ?? "legacy",
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
    const promise = this.runMigrationTransferLease(lease, run)
      .catch(async (err: unknown) => {
        if (controller.signal.aborted) {
          this.recordDaemonTrace("daemon.migration_transport.object_store", {
            ...migrationTraceIdentityAttrs(lease, "transfer"),
            outcome: "canceled",
          });
          return;
        }
        logger.error("[Slock Daemon] Migration object-store transfer failed", err);
        this.recordDaemonTrace("daemon.migration_transport.object_store", {
          ...migrationTraceIdentityAttrs(lease, "transfer"),
          outcome: "failed",
          agent_id_present: Boolean(lease.agentId),
          migration_id_present: Boolean(lease.migrationId),
          session_id_present: Boolean(lease.sessionId),
          error_class: err instanceof Error ? err.name : typeof err,
          ...migrationObjectStoreFailureTraceAttrs(err),
        }, "error");
        try {
          await this.reportMigrationTransportLost(lease, err);
        } catch (reportErr) {
          logger.error("[Slock Daemon] Failed to report migration transport loss", reportErr);
          this.recordDaemonTrace("daemon.migration_transport.object_store", {
            ...migrationTraceIdentityAttrs(lease, "transport_lost_report"),
            outcome: "transport_lost_report_failed",
            migration_id_present: Boolean(lease.migrationId),
            error_class: reportErr instanceof Error ? reportErr.name : typeof reportErr,
          }, "error");
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
    if (lease.provider !== "object_store") return;
    const signal = run.controller.signal;
    if (lease.protocol === AGENT_MIGRATION_RESUMABLE_PROTOCOL) {
      if (lease.role === "source") {
        await this.uploadResumableMigrationBundle(lease, signal);
        return;
      }
      await this.downloadAndCommitResumableMigrationBundle(lease, run);
      return;
    }
    if (lease.role === "source") {
      await this.uploadMigrationObjectStoreBundle(lease, signal);
      return;
    }
    await this.downloadAndImportMigrationObjectStoreBundle(lease, run);
  }

  private migrationObjectStoreHeaders(lease: AgentMigrationTransportLeaseMessage): HeadersInit {
    return {
      "X-Raft-Migration-Token": lease.bearerToken,
    };
  }

  private migrationResumableControlUrl(
    lease: AgentMigrationTransportLeaseMessage,
    suffix: string,
  ): URL {
    if (!lease.controlUrl) throw new Error("MIGRATION_RESUMABLE_CONTROL_URL_MISSING");
    const base = new URL(lease.controlUrl, this.options.serverUrl).toString().replace(/\/$/, "");
    return new URL(`${base}${suffix}`, this.options.serverUrl);
  }

  private migrationResumableControlHeaders(lease: AgentMigrationTransportLeaseMessage): Record<string, string> {
    return {
      ...this.internalComputerHeaders(),
      "X-Raft-Migration-Token": lease.bearerToken,
    };
  }

  private async uploadResumableMigrationBundle(
    lease: AgentMigrationTransportLeaseMessage,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      lease.transferKind !== "upload"
      || !lease.transportGeneration
      || !lease.leaseId
      || !Number.isSafeInteger(lease.expectedMigrationRevision)
      || !lease.sourceMachineId
      || !lease.targetMachineId
    ) {
      throw new Error("MIGRATION_RESUMABLE_SOURCE_LEASE_INVALID");
    }
    signal.throwIfAborted();
    const launchId = this.agentManager.getAgentLaunchId(lease.agentId) ?? "none";
    const sessionId = this.agentManager.getAgentSessionId(lease.agentId) ?? "none";
    await this.agentManager.stopAgent(lease.agentId, { wait: true, silent: true });
    if (this.agentManager.getRunningAgentIds().includes(lease.agentId)) {
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

    const spoolParentPath = path.join(
      this.slockHome,
      "migrations",
      migrationStatePathSegment(lease.migrationId),
      migrationStatePathSegment(lease.transportGeneration),
      "source-spool",
    );
    const built = await buildAgentMigrationResumableBundle({
      agentId: lease.agentId,
      migrationId: lease.migrationId,
      migrationGeneration: lease.transportGeneration,
      leaseId: lease.leaseId,
      sourceMachineId: lease.sourceMachineId,
      targetMachineId: lease.targetMachineId,
      slockHome: this.slockHome,
      workspacePath: path.join(this.agentsDataDir, lease.agentId),
      maxBytes: lease.maxBytes,
      spoolParentPath,
    });
    try {
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

      while (true) {
        signal.throwIfAborted();
        const plan = await this.fetchResumableChunkPlan(lease, "source", signal);
        if (plan.complete) break;
        if (plan.chunks.length === 0) throw new Error("MIGRATION_CHUNK_PLAN_EMPTY");
        for (const chunk of plan.chunks) {
          const expected = built.control.bundle.chunks[chunk.index];
          if (
            !expected
            || chunk.method !== "PUT"
            || chunk.sizeBytes !== expected.sizeBytes
            || chunk.sha256 !== expected.sha256
          ) {
            throw new Error("MIGRATION_CHUNK_PLAN_MISMATCH");
          }
          const upload = await this.fetchResumableTransferWithRetry(
            lease,
            "chunk_upload",
            false,
            signal,
            () => daemonFetch(chunk.url, {
              method: "PUT",
              headers: {
                "Content-Type": "application/octet-stream",
                "Content-Length": String(expected.sizeBytes),
              },
              body: Readable.toWeb(built.openChunk(chunk.index)) as BodyInit,
              duplex: "half",
              signal,
            }),
          );
          if (!upload.ok) throw new Error(`MIGRATION_CHUNK_UPLOAD_FAILED:${upload.status}`);
          await this.reportResumableChunkReceipt(lease, "source", expected, upload.headers.get("etag"), signal);
        }
      }
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
      this.recordDaemonTrace("daemon.migration_transport.resumable", {
        ...migrationTraceIdentityAttrs(lease, "upload_complete"),
        outcome: "uploaded",
        chunk_count: built.control.bundle.chunks.length,
        bundle_size_bucket: migrationObjectStoreBundleSizeBucket(built.control.bundle.totalBytes),
        control_bytes: built.controlBytes,
      });
    } finally {
      await rm(built.spoolDirectory, { recursive: true, force: true });
    }
  }

  private async downloadAndCommitResumableMigrationBundle(
    lease: AgentMigrationTransportLeaseMessage,
    run: MigrationTransferRunState,
  ): Promise<void> {
    if (
      lease.transferKind !== "download"
      || !lease.transportGeneration
      || !lease.leaseId
      || !lease.targetMachineId
    ) {
      throw new Error("MIGRATION_RESUMABLE_TARGET_LEASE_INVALID");
    }
    const signal = run.controller.signal;
    signal.throwIfAborted();
    const { control, controlSha256 } = await this.waitForResumableControl(lease, signal);
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
    const residue = await classifyAgentMigrationTargetResidue({
      control,
      controlSha256,
      slockHome: this.slockHome,
      finalWorkspacePath,
    });
    if (residue.classification === "user-owned") {
      throw new Error("MIGRATION_WORKSPACE_ALREADY_EXISTS");
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
      for (const chunk of plan.chunks) {
        const expected = control.bundle.chunks[chunk.index];
        if (
          !expected
          || chunk.method !== "GET"
          || chunk.sizeBytes !== expected.sizeBytes
          || chunk.sha256 !== expected.sha256
        ) {
          throw new Error("MIGRATION_CHUNK_PLAN_MISMATCH");
        }
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
        await verifyAndStoreAgentMigrationChunk({
          control,
          chunkIndex: chunk.index,
          chunk: Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
          chunksDirectory,
        });
        await this.reportResumableChunkReceipt(lease, "target", expected, null, signal);
      }
    }

    const targetImport = await this.fetchMigrationTargetImportView(lease.migrationId);
    if (targetImport.migrationRef !== lease.migrationRef) {
      throw new Error("MIGRATION_TARGET_IMPORT_REF_MISMATCH");
    }
    await this.writeMigrationCancellationMarker(lease, run, finalWorkspacePath);
    signal.throwIfAborted();
    const started = await this.postMigrationTargetImportStep(
      targetImport.grantKey,
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
    });
    run.workspacePlaced = true;
    await this.writeMigrationCancellationMarker(lease, run, finalWorkspacePath);
    signal.throwIfAborted();
    const flipped = await this.postMigrationTargetImportStep(
      targetImport.grantKey,
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
      targetImport.grantKey,
      "arrived",
      {
        migrationGeneration: flipped.migrationGeneration,
        reportPath,
        reportSha256,
      },
    );
    await rm(this.migrationCancellationDirectory(lease.sessionId), { recursive: true, force: true });
    this.recordDaemonTrace("daemon.migration_transport.resumable", {
      ...migrationTraceIdentityAttrs(lease, "arrival_report"),
      outcome: "committed",
      chunk_count: control.bundle.chunks.length,
      commit_outcome: committed.outcome,
      residue_class: residue.classification,
    });
  }

  private async waitForResumableControl(
    lease: AgentMigrationTransportLeaseMessage,
    signal: AbortSignal,
  ): Promise<{
    control: AgentMigrationControlManifest;
    controlSha256: string;
  }> {
    const expiresAtMs = Date.parse(lease.expiresAt);
    let delayMs = MIGRATION_OBJECT_STORE_DOWNLOAD_RETRY_INITIAL_MS;
    while (currentTimeMs() < expiresAtMs) {
      signal.throwIfAborted();
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
      const remainingMs = expiresAtMs - currentTimeMs();
      if (remainingMs <= 0) break;
      await waitForAmbientBackoff(Math.min(delayMs, remainingMs), signal);
      delayMs = Math.min(delayMs * 2, MIGRATION_OBJECT_STORE_DOWNLOAD_RETRY_MAX_MS);
    }
    throw new Error("MIGRATION_LEASE_EXPIRED");
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
    if (!lease.transportGeneration || !lease.leaseId) {
      throw new Error("MIGRATION_RESUMABLE_LEASE_IDENTITY_MISSING");
    }
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

    while (currentTimeMs() < expiresAtMs) {
      signal.throwIfAborted();
      attempt += 1;
      try {
        const response = await request();
        if (response.ok || !isRetryableResumableMigrationStatus(response.status, retryNotFound)) {
          return response;
        }
        lastStatus = response.status;
        lastErrorClass = null;
        await response.body?.cancel().catch(() => undefined);
      } catch (error) {
        lastStatus = null;
        lastErrorClass = error instanceof Error ? error.name : typeof error;
      }

      const remainingMs = expiresAtMs - currentTimeMs();
      if (remainingMs <= 0) break;
      const sleepMs = Math.min(delayMs, remainingMs);
      this.recordDaemonTrace("daemon.migration_transport.resumable", {
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
        status: lastStatus,
        error_class: lastErrorClass,
        retry_delay_ms: sleepMs,
      });
      await waitForAmbientBackoff(sleepMs, signal);
      delayMs = Math.min(delayMs * 2, MIGRATION_OBJECT_STORE_DOWNLOAD_RETRY_MAX_MS);
    }
    throw new Error("MIGRATION_LEASE_EXPIRED");
  }

  private async uploadMigrationObjectStoreBundle(
    lease: AgentMigrationTransportLeaseMessage,
    signal: AbortSignal,
  ): Promise<void> {
    if (lease.transferKind !== "upload") {
      throw new Error("MIGRATION_OBJECT_STORE_SOURCE_KIND_MISMATCH");
    }
    signal.throwIfAborted();
    const built = await buildAgentMigrationObjectStoreBundle({
      agentId: lease.agentId,
      slockHome: this.slockHome,
      workspacePath: path.join(this.agentsDataDir, lease.agentId),
      maxBytes: lease.maxBytes,
    });
    const spoolDirectory = await mkdtemp(path.join(os.tmpdir(), "raft-agent-migration-upload-"));
    const spoolPath = path.join(spoolDirectory, "bundle.tar.gz");
    let archiveBytes = 0;
    let uploadStatus = 0;
    try {
      await pipeline(
        built.bundle,
        createWriteStream(spoolPath, { flags: "wx", mode: 0o600 }),
        { signal },
      );
      archiveBytes = (await stat(spoolPath)).size;
      const response = await daemonFetch(lease.url, {
        method: "PUT",
        headers: {
          ...this.migrationObjectStoreHeaders(lease),
          "Content-Type": AGENT_MIGRATION_OBJECT_STORE_CONTENT_TYPE,
          "Content-Length": String(archiveBytes),
        },
        body: Readable.toWeb(createReadStream(spoolPath)) as BodyInit,
        duplex: "half",
        signal,
      });
      if (!response.ok) {
        throw new MigrationObjectStoreUploadHttpError(response.status, archiveBytes);
      }
      uploadStatus = response.status;
    } finally {
      await rm(spoolDirectory, { recursive: true, force: true });
    }
    await this.reportMigrationSourceReady(
      lease,
      built.manifestSha256,
      summarizeAgentMigrationExportManifest(built.manifest),
    );
    this.recordDaemonTrace("daemon.migration_transport.object_store", {
      ...migrationTraceIdentityAttrs(lease, "source_ready_report"),
      outcome: "uploaded",
      endpoint_class: "object_store",
      http_status: uploadStatus,
      content_length_present: true,
      upload_body_mode: "spooled_file",
      bundle_size_bucket: migrationObjectStoreBundleSizeBucket(archiveBytes),
      bundle_content_bytes: built.contentBytes,
      max_bytes: lease.maxBytes,
    });
  }

  private async downloadAndImportMigrationObjectStoreBundle(
    lease: AgentMigrationTransportLeaseMessage,
    run: MigrationTransferRunState,
  ): Promise<void> {
    if (lease.transferKind !== "download") {
      throw new Error("MIGRATION_OBJECT_STORE_TARGET_KIND_MISMATCH");
    }
    const signal = run.controller.signal;
    const response = await this.downloadMigrationObjectStoreBundleWithRetry(lease, signal);
    if (!response.body) throw new Error("MIGRATION_OBJECT_STORE_DOWNLOAD_BODY_MISSING");
    const staged = await stageAgentMigrationObjectStoreBundle({
      bundle: Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
      slockHome: this.slockHome,
      sessionId: lease.sessionId,
      maxBytes: lease.maxBytes,
      signal,
    });
    const targetImport = await this.fetchMigrationTargetImportView(lease.migrationId);
    if (targetImport.agentId !== lease.agentId) {
      throw new Error("MIGRATION_TARGET_IMPORT_AGENT_MISMATCH");
    }
    if (targetImport.migrationRef !== lease.migrationRef) {
      throw new Error("MIGRATION_TARGET_IMPORT_REF_MISMATCH");
    }
    if (targetImport.manifestSha256 && targetImport.manifestSha256 !== staged.manifestSha256) {
      throw new Error("MIGRATION_TARGET_IMPORT_MANIFEST_SHA_MISMATCH");
    }

    const plan = await buildAgentMigrationAdoptPlan({
      sourceKind: "staged_bundle",
      slockHome: this.slockHome,
      stagingWorkspacePath: staged.stagingWorkspacePath,
      finalWorkspacePath: path.join(this.agentsDataDir, lease.agentId),
      manifest: staged.manifest,
      manifestSha256: staged.manifestSha256,
      generation: {
        grantKey: targetImport.grantKey,
        migrationGeneration: targetImport.migrationGeneration,
        sourceMachineId: targetImport.sourceMachineId,
        targetMachineId: targetImport.targetMachineId,
        localMachineId: targetImport.targetMachineId,
      },
    });
    await this.writeMigrationCancellationMarker(lease, run, plan.finalWorkspacePath);
    await executeAgentMigrationAdoptPlan(
      plan,
      this.migrationRebindClient(targetImport.grantKey),
      currentDate(),
      {
        signal,
        onWorkspacePlacementStarting: async () => {
          run.workspacePlacementStarted = true;
          await this.writeMigrationCancellationMarker(lease, run, plan.finalWorkspacePath);
        },
        onWorkspacePlaced: async () => {
          run.workspacePlaced = true;
          await this.writeMigrationCancellationMarker(lease, run, plan.finalWorkspacePath);
        },
        onFlipCommitted: async () => {
          run.flipCommitted = true;
          await this.writeMigrationCancellationMarker(lease, run, plan.finalWorkspacePath);
        },
      },
    );
    await rm(this.migrationCancellationDirectory(lease.sessionId), { recursive: true, force: true });
    this.recordDaemonTrace("daemon.migration_transport.object_store", {
      ...migrationTraceIdentityAttrs(lease, "arrival_report"),
      outcome: "imported",
      bundle_content_bytes: staged.contentBytes,
      manifest_sha_present: true,
    });
  }

  private async downloadMigrationObjectStoreBundleWithRetry(
    lease: AgentMigrationTransportLeaseMessage,
    signal: AbortSignal,
  ): Promise<Response> {
    const expiresAtMs = Date.parse(lease.expiresAt);
    let attempt = 0;
    let delayMs = MIGRATION_OBJECT_STORE_DOWNLOAD_RETRY_INITIAL_MS;
    let lastStatus: number | null = null;
    let lastErrorClass: string | null = null;

    while (currentTimeMs() < expiresAtMs) {
      signal.throwIfAborted();
      attempt += 1;
      try {
        const response = await daemonFetch(lease.url, {
          method: "GET",
          headers: this.migrationObjectStoreHeaders(lease),
          signal,
        });
        if (response.ok) {
          return response;
        }
        lastStatus = response.status;
        lastErrorClass = null;
        if (!isRetryableMigrationObjectStoreDownloadStatus(response.status)) {
          throw new Error(`MIGRATION_OBJECT_STORE_DOWNLOAD_FAILED:${response.status}`);
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("MIGRATION_OBJECT_STORE_DOWNLOAD_FAILED:")) {
          throw err;
        }
        lastErrorClass = err instanceof Error ? err.name : typeof err;
      }

      const remainingMs = expiresAtMs - currentTimeMs();
      if (remainingMs <= 0) break;
      const sleepMs = Math.min(delayMs, remainingMs);
      this.recordDaemonTrace("daemon.migration_transport.object_store", {
        ...migrationTraceIdentityAttrs(lease, "chunk_download"),
        outcome: "download_retry",
        attempt,
        status: lastStatus,
        error_class: lastErrorClass,
        retry_delay_ms: sleepMs,
      });
      await waitForAmbientBackoff(sleepMs, signal);
      delayMs = Math.min(delayMs * 2, MIGRATION_OBJECT_STORE_DOWNLOAD_RETRY_MAX_MS);
    }

    const suffix = lastStatus !== null ? String(lastStatus) : (lastErrorClass ?? "unknown");
    throw new Error(`MIGRATION_OBJECT_STORE_DOWNLOAD_RETRY_EXHAUSTED:${suffix}`);
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
      transportGeneration: lease.transportGeneration ?? lease.migrationGeneration,
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
        return;
      }

      const matchingRuns = [...this.migrationTransferRuns.values()].filter((run) =>
        run.lease.agentId === message.agentId
        && run.lease.migrationId === message.migrationId
        && run.lease.migrationRef === message.migrationRef
        && (run.lease.transportGeneration ?? run.lease.migrationGeneration) === message.transportGeneration
        && run.lease.role === message.role
      );
      const activeLeaseMatches = Boolean(
        this.migrationTransferLease?.agentId === message.agentId
        && this.migrationTransferLease?.migrationId === message.migrationId
        && this.migrationTransferLease?.migrationRef === message.migrationRef
        && (this.migrationTransferLease?.transportGeneration ?? this.migrationTransferLease?.migrationGeneration) === message.transportGeneration
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
        await this.agentManager.stopAgent(message.agentId, { wait: true });
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
      this.recordDaemonTrace("daemon.migration_transport.object_store", {
        stage: "cancel_cleanup",
        outcome: "cancel_acknowledged",
        role: message.role,
        migration_ref: message.migrationRef,
      });
    } catch (err) {
      logger.error("[Slock Daemon] Migration cancellation cleanup failed", err);
      this.recordDaemonTrace("daemon.migration_transport.object_store", {
        stage: "cancel_cleanup",
        outcome: "cancel_cleanup_failed",
        role: message.role,
        migration_ref: message.migrationRef,
        error_class: err instanceof Error ? err.name : typeof err,
        error_code: /^(MIGRATION_[A-Z0-9_]+)/.exec(
          err instanceof Error ? err.message : String(err),
        )?.[1],
      }, "error");
      try {
        await this.reportMigrationCancellation(
          message,
          "needs_attention",
          err instanceof Error ? err.name : typeof err,
          err instanceof Error ? err.message : String(err),
        );
      } catch (reportErr) {
        logger.error("[Slock Daemon] Failed to report migration cancellation attention state", reportErr);
      }
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
        message: migrationTransferFailureMessage(err),
      }),
    });
    if (!response.ok) {
      throw new Error(`MIGRATION_TRANSPORT_LOST_REPORT_FAILED:${response.status}`);
    }
    this.recordDaemonTrace("daemon.migration_transport.object_store", {
      ...migrationTraceIdentityAttrs(lease, "transport_lost_report"),
      outcome: "transport_lost_reported",
      migration_id_present: Boolean(lease.migrationId),
    });
  }

  private async reportMigrationSourceReady(
    lease: AgentMigrationTransportLeaseMessage,
    manifestSha256: string,
    transferSummary: AgentMigrationTransferSummary,
  ): Promise<void> {
    const url = new URL(`/internal/computer/agent-migrations/by-id/${encodeURIComponent(lease.migrationId)}/source-ready`, this.options.serverUrl);
    const response = await daemonFetch(url, {
      method: "POST",
      headers: {
        ...this.internalComputerHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        manifestPath: `object-store:${lease.sessionId}/manifest.json`,
        manifestSha256,
        transferSummary,
      }),
    });
    if (!response.ok) {
      throw new Error(`MIGRATION_SOURCE_READY_REPORT_FAILED:${response.status}:${await migrationStepErrorSuffix(response)}`);
    }
    this.recordDaemonTrace("daemon.migration_transport.object_store", {
      ...migrationTraceIdentityAttrs(lease, "source_ready_report"),
      outcome: "source_ready_reported",
      migration_id_present: Boolean(lease.migrationId),
    });
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

  private async fetchMigrationTargetImportViewByGrantKey(grantKey: string): Promise<MigrationTargetImportView> {
    const url = new URL(`/internal/computer/agent-migrations/${encodeURIComponent(grantKey)}`, this.options.serverUrl);
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

  private migrationRebindClient(grantKey: string): AgentMigrationRebindClient {
    return {
      startTransfer: (input) => this.postMigrationTargetImportStep(grantKey, "start-transfer", input),
      flipMachine: (input) => this.postMigrationTargetImportStep(grantKey, "flip-machine", input),
      markArrived: (input) => this.postMigrationTargetImportStep(grantKey, "arrived", input),
    };
  }

  private async postMigrationTargetImportStep(
    grantKey: string,
    step: "start-transfer" | "flip-machine" | "arrived",
    body: {
      migrationGeneration: string;
      reportPath?: string;
      reportSha256?: string;
    },
  ): Promise<MigrationTargetImportView> {
    return await this.postMigrationTargetImportStepOnce(grantKey, step, body, true);
  }

  private async postMigrationTargetImportStepOnce(
    grantKey: string,
    step: "start-transfer" | "flip-machine" | "arrived",
    body: {
      migrationGeneration: string;
      reportPath?: string;
      reportSha256?: string;
    },
    allowStartGenerationRefresh: boolean,
  ): Promise<MigrationTargetImportView> {
    const url = new URL(`/internal/computer/agent-migrations/${encodeURIComponent(grantKey)}/${step}`, this.options.serverUrl);
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
        const current = await this.fetchMigrationTargetImportViewByGrantKey(grantKey);
        if (current.state === "in_transit") return current;
        if (current.state === "ready" && current.migrationGeneration !== body.migrationGeneration) {
          return await this.postMigrationTargetImportStepOnce(grantKey, step, {
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
    return {
      startSpan: (name, options) => createTraceScopeTracer(tracer, this.daemonTraceScope(), {
        spanAttrContracts: DAEMON_CORE_TRACE_ATTR_CONTRACTS,
      }).startSpan(name, options),
    };
  }

  private daemonTraceScope(): TraceScope {
    return {
      resource: {
        daemonVersion: this.daemonVersion,
        computerVersion: this.computerVersion,
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
      this.recordDaemonTrace("daemon.machine_context.conflict", {
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
      trace: (name, attrs, status) => this.recordDaemonTrace(name, attrs, status),
      serverId: context.serverId,
      writerEpoch: this.daemonInstanceId,
    });
    this.scopedAppStorageFactory = createScopedAppStorageFactory({
      slockHome: this.slockHome,
      owner: this.authenticatedMachineContext,
      writerEpoch: this.daemonInstanceId,
      onFailure: (event) => {
        this.recordDaemonTrace("daemon.app_storage.failure", {
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
    this.recordDaemonTrace("daemon.machine_context.bound", {
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

  private async mintRunnerCredential(agentId: string, config: AgentConfig): Promise<{ apiKey: string; credentialId: string | null }> {
    if (config.agentCredentialKey) {
      return { apiKey: config.agentCredentialKey, credentialId: config.agentCredentialId ?? null };
    }
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
        this.recordDaemonTrace("daemon.runner_credential_mint.retry", {
          agentId,
          runtime: config.runtime,
          attempt,
          max_attempts: RUNNER_CREDENTIAL_MINT_MAX_ATTEMPTS,
          status: detail.status,
          code: detail.code,
          reason: detail.message,
          retryable: detail.retryable,
        }, detail.retryable && attempt < RUNNER_CREDENTIAL_MINT_MAX_ATTEMPTS ? "ok" : "error");
        if (!detail.retryable || attempt >= RUNNER_CREDENTIAL_MINT_MAX_ATTEMPTS) break;
        await waitForRunnerCredentialRetry();
      }
    }

    const detail = runnerCredentialErrorDetail(lastError);
    this.recordDaemonTrace("daemon.runner_credential_mint.failed", {
      agentId,
      runtime: config.runtime,
      status: detail.status,
      code: detail.code,
      reason: detail.message,
      retryable: detail.retryable,
      max_attempts: RUNNER_CREDENTIAL_MINT_MAX_ATTEMPTS,
    }, "error");
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

  private sendMentionDeliveryTerminalError(
    msg: AgentDeliverMessage,
    code: "IDENTITY_UNKNOWN" | "IDENTITY_DRIFT" | "QUOTA_LIMITED" | "DELIVERY_REJECTED" | "UNSUPPORTED_DELIVERY_PATH" | "INSTRUMENT_FAILED",
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
    msg: AgentStartMessage,
    outcome: "accepted" | "duplicate",
  ): void {
    const span = this.tracer.startSpan("daemon.agent.start_dispatch.receipt", {
      parent: parseTraceparent(msg.traceparent),
      surface: "daemon",
      kind: "consumer",
      attrs: {
        agent_id: receipt.agentId,
        launch_id: receipt.launchId,
        start_dispatch_id: receipt.startDispatchId,
        queue_state: receipt.queueState,
        queue_depth: receipt.queueDepth,
        queue_age_ms: receipt.queueAgeMs,
        outcome,
      },
    });
    this.connection.send({
      ...receipt,
      traceparent: formatTraceparent(span.context),
    });
    span.end("ok");
  }

  private reportAgentStartFailure(msg: AgentStartMessage, err: unknown): void {
    const classification = classifySpawnFailure(err);
    logger.error(`[Agent ${msg.agentId}] Start failed (${classification.reason}): ${classification.detail}`);
    this.recordDaemonTrace("daemon.agent.spawn.failed", {
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
    }, "error");
    this.connection.send({ type: "agent:status", agentId: msg.agentId, status: "inactive", launchId: msg.launchId });
    // Accepted ambient clock: telemetry records the daemon's observed wall-clock time for this failure.
    this.connection.send({
      type: "agent:activity",
      agentId: msg.agentId,
      detail: classification.userMessage,
      detailKind: "runtime_unavailable",
      launchId: msg.launchId,
      observedAtMs: Date.now(),
      isHeartbeat: false,
    });
  }

  private handleAgentStartMessage(msg: AgentStartMessage): void {
    if (!msg.startDispatchId) {
      this.startAgentFromMessage(msg).catch((err: unknown) => {
        this.reportAgentStartFailure(msg, err);
      });
      return;
    }

    const accepted = this.acceptedStartDispatches.get(msg.startDispatchId);
    if (accepted) {
      this.sendStartDispatchReceipt(accepted, msg, "duplicate");
      return;
    }
    const accepting = this.acceptingStartDispatches.get(msg.startDispatchId);
    if (accepting) {
      void accepting.then((receipt) => {
        this.sendStartDispatchReceipt(receipt, msg, "duplicate");
      }).catch(() => {});
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
    this.startAgentFromMessage(msg, (receipt) => {
      this.rememberAcceptedStartDispatch(receipt);
      resolveAccepted(receipt);
      this.sendStartDispatchReceipt(receipt, msg, "accepted");
    }).catch((err: unknown) => {
      rejectAccepted(err);
      this.reportAgentStartFailure(msg, err);
    }).finally(() => {
      this.acceptingStartDispatches.delete(msg.startDispatchId!);
    });
  }

  private async startAgentFromMessage(
    msg: AgentStartMessage,
    onAccepted?: (receipt: AgentStartAckMessage) => void,
  ): Promise<void> {
    this.coreStartingAgentIds.add(msg.agentId);
    // Reminder sync fallback: a starting agent may own reminders that no
    // connect-time snapshot covered (e.g. it arrived by migration after this
    // connection was established). Guarded no-op when already synchronized.
    this.localScheduleRuntime.requestReminderSnapshotIfUnsynchronized(msg.agentId);
    let wakeDeliveryAck: AgentDeliverMessage | null = null;
    let replayDeliveries: AgentDeliverMessage[] = [];
    try {
      this.observeRuntimeContext(msg.config);
      if (msg.type === "agent:start:wiki") {
        await ensureWikiAgentWorkspace(
          msg.agentId,
          path.join(this.agentsDataDir, msg.agentId),
          msg.wikiWorkspacePack,
        );
      }
      const agentCredential = await this.mintRunnerCredential(msg.agentId, msg.config);
      const config = { ...msg.config, agentCredentialKey: agentCredential.apiKey, agentCredentialId: agentCredential.credentialId };

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

      const startPromise = this.agentManager.startAgent(
        msg.agentId,
        config,
        wakeMessage,
        msg.unreadSummary,
        msg.resumePrompt,
        msg.launchId,
        wakeMessageTransient,
        msg.resumeMessages,
        msg.startDispatchId,
      );
      if (msg.startDispatchId) {
        const acceptance = this.agentManager.getAgentStartAcceptance(msg.agentId);
        onAccepted?.({
          type: "agent:start:ack",
          agentId: msg.agentId,
          launchId: msg.launchId,
          startDispatchId: msg.startDispatchId,
          queueState: acceptance.queueState,
          queueDepth: acceptance.queueDepth,
          queueAgeMs: acceptance.queueAgeMs,
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
      throw err;
    } finally {
      this.coreStartingAgentIds.delete(msg.agentId);
    }
  }

  private handleMessage(msg: ServerToMachineMessage) {
    const summary = summarizeIncomingMessage(msg);
    logger.info(`[Daemon] Received ${msg.type}${summary ? ` ${summary}` : ""}`);
    if (this.localScheduleRuntime.handleServerMessage(msg)) return;

    switch (msg.type) {
      case "machine:context":
        this.bindAuthenticatedMachineContext(msg);
        break;

      case "agent:start":
      case "agent:start:wiki":
        this.observeRuntimeContext(msg.config);
        logger.info(`[Agent ${msg.agentId}] Start requested (runtime=${msg.config.runtime}, model=${msg.config.model}, session=${msg.config.sessionId || "new"}${msg.wakeMessage ? ", wake=true" : ""})`);
        this.handleAgentStartMessage(msg);
        break;

      case "agent:stop":
        logger.info(`[Agent ${msg.agentId}] Stop requested`);
        this.agentManager.stopAgent(msg.agentId);
        break;

      case "agent:reset-workspace":
        logger.info(`[Agent ${msg.agentId}] Workspace reset requested`);
        this.agentManager.resetWorkspace(msg.agentId);
        break;

      case "agent:inbox:purge":
        logger.info(`[Agent ${msg.agentId}] Inbox purge requested (${msg.channelIds.length} channels, reason=${msg.reason || "server_purge"})`);
        this.agentManager.purgeInboxMessagesForChannels(msg.agentId, msg.channelIds, msg.reason || "server_purge");
        break;

      case "agent:deliver":
      {
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

          const acceptedOrPromise = this.agentManager.deliverMessage(msg.agentId, msg.message, {
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
          });
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
            span.end("ok", { attrs: { outcome: "ack-sent", ackSeq, deliveryId: msg.deliveryId } });
          }, (err: unknown) => {
            logger.error(`[Agent ${msg.agentId}] Delivery handling failed`, err);
            span.end("error", { attrs: { error_class: err instanceof Error ? err.name : typeof err } });
          });
        } catch (err) {
          span.end("error", { attrs: { error_class: err instanceof Error ? err.name : typeof err } });
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
          this.agentManager.deliverRuntimeProfileNotification(msg.agentId, msg.migrationKey, "migration", msg.message, formatTraceparent(span.context), msg.launchId || null),
        ).then((accepted) => {
          span.end("ok", { attrs: { outcome: accepted ? "accepted" : "no_injection_path" } });
        }, (err: unknown) => {
          logger.error(`[Agent ${msg.agentId}] Runtime profile migration handling failed`, err);
          span.end("error", { attrs: { error_class: err instanceof Error ? err.name : typeof err } });
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
          this.agentManager.deliverRuntimeProfileNotification(msg.agentId, msg.noticeKey, "daemon_release_notice", msg.message, formatTraceparent(span.context), msg.launchId || null),
        ).then((accepted) => {
          span.end("ok", { attrs: { outcome: accepted ? "accepted" : "no_injection_path" } });
        }, (err: unknown) => {
          logger.error(`[Agent ${msg.agentId}] Runtime profile daemon release notice handling failed`, err);
          span.end("error", { attrs: { error_class: err instanceof Error ? err.name : typeof err } });
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

      case "agent:workspace:ensure-wiki":
        ensureWikiAgentWorkspace(msg.agentId, path.join(this.agentsDataDir, msg.agentId), msg.pack).then((receipt) => {
          this.connection.send({
            type: "agent:workspace:wiki_ensured",
            agentId: msg.agentId,
            requestId: msg.requestId,
            success: true,
            packId: receipt.packId,
            files: receipt.files,
          });
        }).catch((err: unknown) => {
          logger.error(`[Daemon] Failed to ensure Wiki workspace for ${msg.agentId}`, err);
          this.connection.send({
            type: "agent:workspace:wiki_ensured",
            agentId: msg.agentId,
            requestId: msg.requestId,
            success: false,
            packId: msg.pack.packId,
            files: [],
            error: err instanceof Error ? err.message : "Unknown Wiki workspace error",
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
              error_class: err instanceof Error ? err.name : typeof err,
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

      case "agent:diagnostic:feedback_transcript":
        this.agentManager.collectFeedbackTranscript(msg.agentId, msg.feedbackReportId, {
          reportGeneratedAt: msg.feedbackReportGeneratedAt ?? currentDate().toISOString(),
          reportTimeSource: msg.feedbackReportTimeSource ?? "server_request_received",
        }).then((result) => {
          this.connection.send({
            type: "agent:diagnostic:feedback_transcript_result",
            agentId: msg.agentId,
            feedbackReportId: msg.feedbackReportId,
            requestId: msg.requestId,
            ...result,
          });
        }).catch((err: unknown) => {
          logger.error(`[Daemon] Failed to collect feedback transcript for ${msg.agentId}`, err);
          this.connection.send({
            type: "agent:diagnostic:feedback_transcript_result",
            agentId: msg.agentId,
            feedbackReportId: msg.feedbackReportId,
            requestId: msg.requestId,
            reachable: false,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        break;

      case "agent:activity_probe":
        // Server is asking for ground-truth current activity. Echo
        // back via the same `agent:activity` upstream channel,
        // tagged with the probeId so server can correlate. Keeps
        // this surface unobtrusive: probe response goes through the
        // existing ingest pipeline, with launch-guard / lifecycle
        // checks intact. See agentProcessManager.respondToActivityProbe.
        this.agentManager.respondToActivityProbe(msg.agentId, msg.probeId);
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
          this.connection.send({ type: "machine:workspace:delete_result", directoryName: msg.directoryName, success });
        });
        break;

      // Re-detect installed runtimes on demand. `emitReady` already re-runs the
      // detector and pushes the fresh capabilities, and the server fans those out
      // as `machine:capabilities` — so re-emitting IS the answer, no bespoke
      // result message needed.
      case "machine:runtimes:rescan":
        this.emitReadyIfConnected();
        break;

      case "machine:migration:source_workspace_archive": {
        void archiveCompletedAgentMigrationSourceWorkspace({
          slockHome: this.slockHome,
          dataDir: this.agentsDataDir,
          agentId: msg.agentId,
          migrationId: msg.migrationId,
        }).then(
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
            this.connection.send({
              type: "machine:migration:source_workspace_archive_result",
              requestId: msg.requestId,
              migrationId: msg.migrationId,
              agentId: msg.agentId,
              outcome: "error",
            });
          },
        );
        break;
      }

      case "machine:runtime_models:detect": {
        const driver = getDriver(msg.runtime);
        const staticSource = driver
          ? getStaticRuntimeModelSourceSet(msg.runtime)
          : undefined;
        const span = this.tracer.startSpan("daemon.runtime_models.detect", {
          surface: "daemon",
          kind: "internal",
          attrs: {
            runtime: msg.runtime,
            requestId: msg.requestId,
          },
        });
        const detect: Promise<RuntimeModelSourceOutcome> = typeof driver?.detectModels === "function"
          ? driver.detectModels({ tracer: this.tracer, span })
          : Promise.resolve(
              staticSource
                ? { kind: "live", value: staticSource }
                : { kind: "unsupported" },
            );
        void detect.then((detectedOutcome) => {
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
                default_model_present: Boolean(outcome.value.default),
                verified_as: driver?.model.detectedModelsVerifiedAs ?? "suggestion_only",
              },
            });
          } else {
            span.end("ok", {
              attrs: {
                outcome: outcome.kind,
                models_count: 0,
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
              error_class: err instanceof Error ? err.name : typeof err,
            },
          });
        });
        break;
      }

      case "machine:runtime_account_usage:refresh": {
        const provider: RuntimeAccountUsageProvider = msg.provider;
        void this.runtimeAccountUsageCollector(provider).then((snapshot: RuntimeAccountUsageSnapshot) => {
          this.connection.send({
            type: "machine:runtime_account_usage:snapshot",
            requestId: msg.requestId,
            snapshot,
          });
          this.recordDaemonTrace("daemon.runtime_account_usage.refresh", {
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
          });
        }).catch((err: unknown) => {
          logger.warn(`[Daemon] Runtime account usage refresh failed (${provider}): ${err instanceof Error ? err.message : String(err)}`);
          this.recordDaemonTrace("daemon.runtime_account_usage.refresh", {
            outcome: "collector_error",
            provider,
            reason: msg.reason,
            error_class: err instanceof Error ? err.name : typeof err,
          });
        });
        break;
      }

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
          this.recordDaemonTrace("daemon.computer_control.replayed", {
            action,
            operation_id: operationId,
            outcome: "ignored",
          });
          break;
        }
        if (operationId) this.handledComputerControlOperationIds.add(operationId);
        this.recordDaemonTrace("daemon.computer_control.received", {
          action,
          handled: Boolean(this.options.onComputerControl),
          ...(operationId ? { operation_id: operationId } : {}),
          ...(requestId ? { request_id: requestId } : {}),
        });
        if (this.options.onComputerControl) {
          const ctx: ComputerControlContext = {
            operationId,
            requestId,
            emitUpgradeProgress: (ev) => {
              if (!requestId) return;
              this.connection.send({ type: "computer:upgrade:progress", requestId, ...ev });
            },
            emitUpgradeDone: (ev) => {
              if (!requestId) return;
              this.connection.send({ type: "computer:upgrade:done", requestId, ...ev });
            },
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
              } else {
                ctx.emitUpgradeDone({ ok: false, error: failure });
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

  private emitReadyIfConnected(): void {
    if (this.connection.connected) void this.emitReady();
  }

  private async emitReady(expectedLifecycleGeneration?: number): Promise<boolean> {
    const { ids: runtimes, versions: runtimeVersions, diagnostics: runtimeDiagnostics = {} } = this.runtimeDetector();
    const runtimeInfo = runtimes.map((id) => runtimeVersions[id] ? `${id} (${runtimeVersions[id]})` : id);
    logger.info(`[Daemon] Detected runtimes: ${runtimeInfo.join(", ") || "none"}`);
    for (const [runtime, diagnostic] of Object.entries(runtimeDiagnostics)) {
      logger.warn(`[Daemon] Runtime ${runtime} diagnostic: ${diagnostic}`);
    }
    const runningAgentIds = this.agentManager.getRunningAgentIds();
    const idleAgentSessions = this.agentManager.getIdleAgentSessionIds();
    const runtimeProfileReports = this.agentManager.getAgentRuntimeProfileReports();

    let lifecycleAcks = this.options.getComputerLifecycleAcks?.() ?? [];
    if (this.options.getComputerLifecycleReadyAcks) {
      try {
        lifecycleAcks = await this.options.getComputerLifecycleReadyAcks();
      } catch (error) {
        logger.warn(`[Daemon] Computer lifecycle attestation skipped: ${error instanceof Error ? error.message : String(error)}`);
        lifecycleAcks = [];
      }
    }
    if (expectedLifecycleGeneration !== undefined
      && (expectedLifecycleGeneration !== this.lifecycleOriginConnectionGeneration
        || !this.connection.connected)) {
      return false;
    }
    this.connection.send({
      type: "ready",
      capabilities: [
        "agent:start",
        "agent:stop",
        "agent:deliver",
        "workspace:files",
        WIKI_WORKSPACE_PACK_CAPABILITY,
        ...BUILT_IN_READY_CAPABILITIES,
        ...(this.options.computerControlViaSupervisor
          ? [COMPUTER_CAPABILITY_SUPERVISOR_MUTATIONS]
          : []),
      ],
      runtimes,
      runtimeVersions,
      runningAgents: runningAgentIds,
      hostname: this.options.hostname ?? os.hostname(),
      os: this.options.osDescription ?? `${os.platform()} ${os.arch()}`,
      daemonVersion: this.daemonVersion,
      ...(this.computerVersion ? { computerVersion: this.computerVersion } : {}),
      migrationTransport: this.getMigrationTransportReady(),
      ...((this.options.getComputerLifecycleAcks || this.options.getComputerLifecycleReadyAcks)
        ? { lifecycleAcks }
        : {}),
    });
    this.recordDaemonTrace("daemon.ready.sent", {
      runtimes_count: runtimes.length,
      running_agents_count: runningAgentIds.length,
      idle_agents_count: idleAgentSessions.length,
      runtime_profile_reports_count: runtimeProfileReports.length,
    });
    return true;
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
    }
  }

  private handleConnect() {
    const lifecycleOriginConnectionGeneration = this.invalidateLifecycleOriginReconcile();
    // Computer readiness tracks the live websocket handshake, not runtime
    // inventory. Publish that lifecycle edge before any synchronous probe can
    // delay the event loop (notably PowerShell Get-Command on fresh Windows
    // hosts). A failed hook must not suppress the daemon's fresh ready report.
    try {
      this.options.lifecycleHooks?.onConnect?.();
    } catch (err) {
      logger.warn(`[Daemon] Connection lifecycle hook failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // One-shot on first connect: bring existing per-agent opencli wrappers to
    // the current self-healing form. A long-running agent whose wrapper predates
    // a package-tree mutation (e.g. an npm→SEA computer switch) otherwise keeps a
    // stale hardcoded path until it respawns. The per-spawn writer handles new
    // launches; this covers agents that don't respawn across the switch.
    if (!this.opencliWrappersRegenerated) {
      this.opencliWrappersRegenerated = true;
      try {
        const { scanned, rewritten } = regenerateExistingOpencliWrappers(this.agentsDataDir);
        if (scanned > 0) {
          logger.info(`[Daemon] Refreshed ${rewritten}/${scanned} opencli wrapper(s) to current self-healing form`);
        }
      } catch (err) {
        logger.warn(`[Daemon] opencli wrapper refresh skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const initialReady = this.emitReady(lifecycleOriginConnectionGeneration);
    if (this.options.reconcileComputerLifecycleOrigin) {
      void initialReady
        .then((readySent) => readySent
          ? this.reconcileComputerLifecycleOrigin(lifecycleOriginConnectionGeneration, 1)
          : undefined)
        .catch((err) => {
          logger.warn(
            `[Daemon] Computer lifecycle origin reconcile skipped: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }
    const runningAgentIds = this.agentManager.getRunningAgentIds();
    const idleAgentSessions = this.agentManager.getIdleAgentSessionIds();
    const runtimeProfileReports = this.agentManager.getAgentRuntimeProfileReports();

    // Managed-Computer SEA upgrade blip-stitch: if THIS process booted from a
    // freshly swapped binary, report `computer:upgrade:done` upstream now that
    // the WS is back. The hook reads + clears its own pending-upgrade marker.
    if (this.options.onComputerUpgradeReconcile) {
      void Promise.resolve()
        .then(() =>
          this.options.onComputerUpgradeReconcile!(
            (done) => {
              this.connection.send({ type: "computer:upgrade:done", ...done });
              this.recordDaemonTrace("daemon.computer_upgrade.reconciled", {
                request_id: done.requestId,
                ok: done.ok,
                ...(done.newVersion ? { new_version: done.newVersion } : {}),
              });
            },
            (progress) => {
              this.connection.send({ type: "computer:upgrade:progress", ...progress });
            },
          ),
        )
        .catch((err) => {
          logger.error(
            `[Daemon] computer upgrade reconcile failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }

    if (this.options.onComputerRestartReconcile) {
      void Promise.resolve()
        .then(() =>
          this.options.onComputerRestartReconcile!((done) => {
            this.connection.send({ type: "computer:restart:done", ...done });
            this.recordDaemonTrace("daemon.computer_restart.reconciled", {
              request_id: done.requestId,
              ok: done.ok,
            });
          }),
        )
        .catch((err) => {
          logger.error(
            `[Daemon] computer restart reconcile failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }

    for (const agentId of runningAgentIds) {
      const sessionId = this.agentManager.getAgentSessionId(agentId);
      const launchId = this.agentManager.getAgentLaunchId(agentId);
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
    this.invalidateLifecycleOriginReconcile();
    logger.warn("[Daemon] Lost connection — agents continue running locally");
    this.recordDaemonTrace("daemon.connection.local_disconnect_observed", {
      running_agents_count: this.agentManager.getRunningAgentIds().length,
      idle_agents_count: this.agentManager.getIdleAgentSessionIds().length,
    }, "cancelled");
    this.options.lifecycleHooks?.onDisconnect?.();
  }

  private handleHandshakeRejected(event: { statusCode: number; reason: string | null }) {
    this.options.lifecycleHooks?.onHandshakeRejected?.(event);
  }
}
