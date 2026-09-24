import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import { isIP } from "node:net";
import type { Server as SocketServer } from "socket.io";
import type { WebSocket } from "ws";
import {
  asMachineId,
  type MachineId,
  EXTERNAL_AGENT_ACTIVITY_PROVENANCE,
  EXTERNAL_AGENT_ACTIVITY_TEXT_LIMIT,
  EXTERNAL_AGENT_ACTIVITY_TOOL_NAME_LIMIT,
  RUNTIME_ACCOUNT_USAGE_FEATURE_FLAG_KEY,
  WIKI_AGENT_WORKSPACE_ENABLED,
  WIKI_AGENT_WORKSPACE_ENV,
  WIKI_WORKSPACE_PACK_CAPABILITY,
  createTraceScopeTracer,
  currentDate,
  currentTimeMs,
  failpoints,
  formatTraceparent,
  getStaticRuntimeModelSourceSet,
  getToolActivityLabel,
  hydrateRuntimeConfig,
  isAgentActivityDetailKind,
  isCompleteWikiWorkspaceEnsureReceipt,
  isExternalAgentRuntime,
  noopTracer,
  normalizeActivity,
  normalizeActivityDetailKind,
  parseTraceparent,
  runtimeConfigToLaunchFields,
  runtimeModelSourceOutcomeFromSet,
  setClockTimeout,
  type ActiveSpan,
  type AgentMessage,
  type MentionDeliveryIdentitySnapshot,
  type ServerToMachineMessage,
  type MachineToServerMessage,
  type MachineShutdownReason,
  type ComputerLifecycleExecutionAck,
  type AgentConfig,
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
  type TraceContext,
  type Tracer,
  type ExternalAgentActivityEvent,
  type ExternalAgentActivityIngestRequest,
  type AgentMigrationTransportLeaseSource,
  type AgentMigrationTransportReady,
  type FeedbackTranscriptReportTimeSource,
  type FeedbackTranscriptWindow,
  type WikiWorkspaceEnsureReceipt,
  type RuntimeAccountUsageProvider,
  type RuntimeErrorActivityDiagnostic,
} from "@botiverse/raft-shared";
import {
  appConfigTraceAttrs,
  appSourceTraceAttrs,
  filterAppRuntimeTraceAttrs,
} from "@botiverse/raft-shared/src/appRuntimeTrace.js";
import type { AppConfigWireSnapshot } from "@botiverse/raft-shared/src/appConfigTransport.js";
import { RouteFailureError } from "../tracing/routeFailure.js";
import { composeReminderSnapshot } from "../apps/reminder/snapshotComposition.js";
import { resolveBuiltInMachineMessageDispatch } from "../registry.manifest.js";
import { listBuiltInAppConfigSnapshotsForAgent } from "./appConfigTransportComposition.js";
import type { AppSnapshotComposition } from "./appSnapshotComposition.js";
import { boundedErrorClass } from "../tracing/queryTrace.js";
import { getCurrentTraceContext, runWithTraceSpan } from "../tracing/semanticTrace.js";
import * as agentService from "./agentService.js";
import * as agentMigrationService from "./agentMigrationService.js";
import * as agentRuntimeProfileService from "./agentRuntimeProfileService.js";
import * as machineService from "./machineService.js";
import * as channelService from "./channelService.js";
import * as messageService from "./messageService.js";
import * as mentionDeliveryOccurrenceService from "./mentionDeliveryOccurrenceService.js";
import * as agentActivityLogService from "./agentActivityLogService.js";
import * as computerLifecycleOperationService from "./computerLifecycleOperationService.js";
import {
  recordComputerOfflineTransition,
  recordComputerOnlineTransition,
} from "./computerOutageNotificationService.js";
import { evaluateFeatureFlag } from "./featureFlagService.js";
import { runtimeAccountUsageCacheService } from "./runtimeAccountUsageCacheService.js";
import { getComputerLinkedMachineAttachers } from "./computerCredentialService.js";
import {
  evaluateBroadcastPolicy,
  isQueuedComputerUpgradePolicyCompatible,
  normalizeComputerPlatform,
  type ComputerBroadcastPolicyDecision,
  type EvaluateComputerBroadcastPolicyInput,
} from "./computerBroadcastPolicyService.js";
import type { PersistedAgentActivityHint } from "./agentActivityLogService.js";
import * as reminderService from "../apps/reminder/service.js";
import * as wikiService from "./wikiService.js";
import { WIKI_AGENT_WORKSPACE_PACK } from "../generated/wikiAgentWorkspacePack.js";
import { agentHasScope } from "./agentScopesService.js";
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
} from "./legacyAgentLifecycleAdapter.js";
import { createAgentLifecycleEvent, type AgentLifecycleEventType } from "./agentLifecycleEvents.js";
import {
  applyAgentLifecycleProjectionPlan,
  type AgentLifecycleProjectionWriterDeps,
  type LifecycleActivityBroadcastResult,
} from "./agentLifecycleProjectionWriter.js";
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
  reduceDaemonActivitySignal,
  rewriteDaemonActivityEntries,
  reduceRuntimeErrorActivityAction,
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
} from "./agentLifecycleReducer.js";

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
} from "./agentLifecycleReducer.js";
import { getServerPlan, getHistoryCutoff } from "./planService.js";
import {
  REPLICA_ID,
  routeMachineCommandWithResult,
  machineResponseRelay,
  routeInboxDelivery,
  routeInboxDeliveryWithReceipt,
  fingerprintAgentRuntimeError,
  publishExternalWakeSignal,
  type MachineCommandRouteResult,
  type RoutedInboxDeliveryOptions,
  type RoutedInboxDeliveryReceipt,
  type RoutedInboxDeliveryReceiptResult,
} from "../replicaRouter.js";
import { redisReplicaStateStore, type MachineMeta, type ReplicaStateStore } from "./replicaStateStore.js";
import {
  buildRuntimeTraceContext,
  projectMachineConnectTraceAttrs,
  projectOwnerTraceAttrs,
  type MachineConnectTraceContext,
} from "../tracing/migrationTraceContext.js";
import type { ComputerSourceFact } from "./computerBroadcastPolicyService.js";
import {
  MachineCatalogAuthority,
  MachineCatalogStaleError,
  type MachineConnectionGeneration,
} from "./machineCatalogAuthority.js";
import {
  BuiltInModelCatalogError,
  assertBuiltInPresetSupportedByCatalog,
  type BuiltInModelCatalogValidation,
} from "./builtinModelCatalogCompatibility.js";

export type MachineConnectionPrincipalKind = "computer" | "legacy_machine" | "unknown";

interface MachineConnection {
  ws: WebSocket;
  machineId: string;
  serverId: string;
  principalKind: MachineConnectionPrincipalKind;
  connectionEpochId: string;
  replicaGeneration: string | null;
  heartbeatTimer: unknown | null;
  runtimeAccountUsageTimer: unknown | null;
  lastPong: number;
  lastIngressAt: number;
  daemonVersion: string | null;
  capabilities: Set<string>;
  // Runtimes reported in the daemon `ready` message, held in-memory so
  // server-authoritative readiness (ServerSetupProjectionGate) derives runtime
  // from the SAME live "Ready" event as the client card — no DB-persist lag,
  // no double-source divergence. Null until `ready` is processed.
  runtimes: string[] | null;
  runtimeVersions: Record<string, string>;
  migrationTransport: MachineMigrationTransportState | null;
  shutdownIntent: MachineShutdownIntent | null;
  traceContext?: MachineConnectTraceContext;
  // Managed-Computer bundle version (`@botiverse/raft-computer`), reported in
  // `ready` when this connection is a Computer; null for a raw daemon.
  computerVersion: string | null;
}

// Daemon-reported capabilities we persist then reflect to the client card. Held
// per machine so a transient DB-write failure can be retried by the server
// itself (see enqueueCapabilitiesPersist) instead of waiting for the daemon to
// send another `ready`.
interface CapabilitiesPersistPayload {
  runtimes: string[];
  runtimeVersions?: Record<string, string>;
  hostname?: string;
  os?: string;
  daemonVersion?: string | null;
  computerVersion?: string | null;
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

export const MACHINE_MIGRATION_TRANSPORT_FRESH_MS = 2 * 60 * 1000;

function parseMigrationTransportTimestamp(value: string | null | undefined): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isLoopbackMigrationTransportEndpoint(endpoint: string | null | undefined): boolean {
  if (typeof endpoint !== "string" || !endpoint.trim()) return true;
  let host: string;
  try {
    host = new URL(endpoint.trim()).hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  } catch {
    return true;
  }
  if (host === "localhost" || host === "0.0.0.0" || host === "::" || host === "::1") return true;
  if (isIP(host) === 4 && host.startsWith("127.")) return true;
  return false;
}

export function isUsableMachineMigrationTransport(
  state: MachineMigrationTransportState | null | undefined,
  opts: { nowMs?: number; freshMs?: number } = {},
): boolean {
  if (!state?.provisioned) return false;
  if (state.leaseSource !== "server") return false;
  if (isLoopbackMigrationTransportEndpoint(state.endpoint)) return false;

  const capturedAtMs = parseMigrationTransportTimestamp(state.capturedAt);
  if (capturedAtMs === null) return false;
  const nowMs = opts.nowMs ?? currentTimeMs();
  const ageMs = nowMs - capturedAtMs;
  return ageMs >= 0 && ageMs <= (opts.freshMs ?? MACHINE_MIGRATION_TRANSPORT_FRESH_MS);
}

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

const systemOrchestratorClock: OrchestratorClock = {
  now: () => Date.now(),
  scheduleRepeated: (fn, ms) => setInterval(fn, ms),
  cancelRepeated: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
  setTimeout: setClockTimeout,
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export function runtimeAccountUsageProvidersForRuntimes(runtimes: readonly string[]): RuntimeAccountUsageProvider[] {
  const providers = new Set<RuntimeAccountUsageProvider>();
  for (const runtime of runtimes) {
    if (runtime === "claude" || runtime === "codex" || runtime === "grok") providers.add(runtime);
    if (runtime === "kimi" || runtime === "kimi-sdk") providers.add("kimi");
  }
  return [...providers];
}

export function runtimeAccountUsageProvidersForScheduledCollection(
  runtimes: readonly string[],
  gateEnabled: boolean,
): RuntimeAccountUsageProvider[] {
  return gateEnabled ? runtimeAccountUsageProvidersForRuntimes(runtimes) : [];
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

function oldestInboxMessageAgeMs(messages: AgentMessage[], now: number): number | undefined {
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
  cause?: "heartbeat_timeout" | "socket_close" | "socket_error" | "computer_machine_unlinked" | "legacy_machine_key_migrated";
  closeCode?: number;
  closeReason?: string;
  errorMessage?: string;
  shutdownIntent?: MachineShutdownIntent;
}

const MACHINE_UNLINKED_CLOSE_CODE = 4001;
const MACHINE_UNLINKED_CLOSE_REASON = "computer_machine_unlinked";
const LEGACY_PRINCIPAL_FENCED_CLOSE_CODE = 4002;
const LEGACY_PRINCIPAL_FENCED_CLOSE_REASON = "legacy_machine_key_migrated";

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
  parkedReason?: "machine_offline";
  firstAttemptAt: number;
  lastAttemptAt: number;
}

type AgentStartMessage = Extract<
  ServerToMachineMessage,
  { type: "agent:start" | "agent:start:wiki" }
>;

type AgentStartDispatchTerminalReason =
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

interface AgentInbox {
  inbox: AgentMessage[];
  pendingReceive: {
    resolve: (messages: AgentMessage[]) => void;
    timer: ReturnType<typeof setTimeout>;
    finish: (messages: AgentMessage[]) => void;
  } | null;
}

interface StartAgentOptions {
  resumePrompt?: string;
  wakeMessage?: AgentMessage;
  wakeMessageTransient?: boolean;
  requireQueueReceipt?: boolean;
}

export type AgentStartDispatchResult =
  | { outcome: "dispatched" }
  | { outcome: "skipped"; reason: "manual_stop" | "wake_lock_held" };

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

type ActivitySnapshot = {
  activity: AgentActivityKind;
  detail: string;
  detailKind: AgentActivityDetailKind;
  observedAtMs?: number;
  updatedAt: number;
};

type ActivityClockSnapshot = {
  observedAtMs?: number;
  updatedAt: number;
};

type VisibleActivity = {
  activity: AgentActivityKind;
  activityDetail: string;
};

type MachineReachability = "local" | "remote" | "offline" | "none" | "external-reported";

type ActivityHintSource = "local-cache" | "redis";

type WeakOfflineSource = "owner_missing" | "replica_state_unavailable" | "self_owner_without_local_connection";

type WeakOfflineCompetingFact = "redis_busy_activity" | "persisted_busy_activity";

type ActivityTraceOptions = {
  parent?: TraceContext | null;
};

type RuntimeContextMachine = {
  name: string;
  description: string | null;
  hostname: string | null;
  os: string | null;
} | null;

function runtimeStateFromAgentActivity(activity: AgentActivity): LifecycleRuntimeState {
  if (activity === "thinking" || activity === "working") return activity;
  if (activity === "error") return "crashed";
  if (activity === "offline") return "interrupted";
  return "running_idle";
}

export type AgentLifecycleAction = "start" | "stop" | "reset" | "wake";
export type AgentLifecycleOutcome = "attempted" | "completed" | "failed" | "skipped" | "suppressed";
export type AgentLifecycleCause = "message" | "manual" | "resume" | "internal" | "restart" | "session" | "full";

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
}

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

export interface ReceivePlanInput {
  hasBufferedMessages: boolean;
  block: boolean;
}

export type ReceivePlanAction =
  | "return-buffered"
  | "return-empty"
  | "install-waiter";

export function planReceiveAction(input: ReceivePlanInput): ReceivePlanAction {
  if (input.hasBufferedMessages) {
    return "return-buffered";
  }
  return input.block ? "install-waiter" : "return-empty";
}

export interface AckPartitionInput {
  inbox: AgentMessage[];
  ackedSeqs: Set<number>;
  ackedMessageIds?: Set<string>;
}

export interface AckPartitionResult {
  removed: AgentMessage[];
  retained: AgentMessage[];
}

export function partitionAcknowledgedMessages(input: AckPartitionInput): AckPartitionResult {
  const removed: AgentMessage[] = [];
  const retained: AgentMessage[] = [];

  for (const message of input.inbox) {
    if (
      (message.seq && input.ackedSeqs.has(message.seq))
      || (!message.seq && message.message_id && input.ackedMessageIds?.has(message.message_id))
    ) {
      removed.push(message);
    } else {
      retained.push(message);
    }
  }

  return { removed, retained };
}

export interface TargetScopedAckPartitionInput {
  inbox: AgentMessage[];
  channelId: string;
  ackedSeqs: Set<number>;
}

export function partitionTargetScopedAcknowledgedMessages(input: TargetScopedAckPartitionInput): AckPartitionResult {
  const removed: AgentMessage[] = [];
  const retained: AgentMessage[] = [];

  for (const message of input.inbox) {
    if (message.channel_id === input.channelId && message.seq && input.ackedSeqs.has(message.seq)) {
      removed.push(message);
    } else {
      retained.push(message);
    }
  }

  return { removed, retained };
}

export interface TargetScopedAckUpToSeqPartitionInput {
  inbox: AgentMessage[];
  channelId: string;
  maxSeq: number;
}

export function partitionTargetScopedMessagesUpToSeq(input: TargetScopedAckUpToSeqPartitionInput): AckPartitionResult {
  const removed: AgentMessage[] = [];
  const retained: AgentMessage[] = [];

  for (const message of input.inbox) {
    if (message.channel_id === input.channelId && message.seq && message.seq <= input.maxSeq) {
      removed.push(message);
    } else {
      retained.push(message);
    }
  }

  return { removed, retained };
}

export interface LocalInboxEnqueuePlanInput {
  hasSeqDuplicate: boolean;
  hasMessageIdDuplicate: boolean;
}

export type LocalInboxEnqueuePlanAction = "enqueue" | "skip-duplicate";

export function planLocalInboxEnqueueAction(input: LocalInboxEnqueuePlanInput): LocalInboxEnqueuePlanAction {
  return input.hasSeqDuplicate || input.hasMessageIdDuplicate ? "skip-duplicate" : "enqueue";
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
   * Internal migration protocol deliveries pierce zen(migrating). Ordinary
   * channel/thread/DM traffic is queued and replayed after the migration gate
   * clears.
   */
  migrationProtocol?: boolean;
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

interface LocalInboxApplyContext {
  inbox: AgentInbox;
  message: AgentMessage;
  notifyPendingReceive?: boolean;
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

interface ReceiveApplyContext {
  agentId: string;
  timeoutMs: number;
  signal?: AbortSignal;
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
]);

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

export function mapExternalPluginActivityEvent(event: ExternalAgentActivityEvent): MappedExternalPluginActivity | null {
  const hookEventName = externalActivityString(event.hookEventName ?? event.hook_event_name, 80);
  const eventId = externalActivityString(event.eventId ?? event.event_id, 160);
  if (!hookEventName || !eventId) return null;

  const producerFactId = buildExternalPluginProducerFactId(eventId);
  const toolName = externalActivityString(event.toolName ?? event.tool_name, EXTERNAL_AGENT_ACTIVITY_TOOL_NAME_LIMIT) ?? "tool";
  const detail = getToolActivityLabel(toolName);
  const occurredAtMs = externalActivityTimeMs(event.occurredAt ?? event.occurred_at);
  const dedupeKey = `external-agent-activity:${eventId}`;

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
    return {
      activity: "working",
      detail,
      entries: [{
        kind: "system",
        title,
        text,
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

function buildExternalPluginProducerFactId(eventId: string): string {
  const safe = eventId.replace(/[^A-Za-z0-9_:/-]/g, "_").slice(0, 160) || "unknown";
  return `${EXTERNAL_AGENT_ACTIVITY_PROVENANCE}:${safe}`;
}

type ResetApplyContext = {
  agentId: string;
  serverId: string | null;
  mode: "restart" | "session" | "full";
  previousStatus: AgentStatus | null;
  machineId: string | null;
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
 * AgentOrchestrator routes agent commands to the appropriate machine via WebSocket.
 */
export class AgentOrchestrator extends EventEmitter {
  private io: SocketServer | null = null;
  private machineConnections = new Map<string, MachineConnection>();
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
  private machineStatusVersions = new Map<string, number>();
  private pendingMachineDisconnects = new Map<string, PendingMachineDisconnectProjection>();
  private pendingAgentSkillsListRequests = new Map<string, PendingAgentSkillsListRequest>();
  private pendingAgentDeliveryAcks = new Map<string, PendingAgentDeliveryAck>();
  private pendingAgentStartAcks = new Map<string, PendingAgentStartAck>();
  private terminalAgentStartDispatches = new Map<string, AgentStartDispatchTerminalReason>();
  private agentInboxes = new Map<string, AgentInbox>();
  private agentActivity = new Map<string, ActivitySnapshot>();
  private activityDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private agentStateCache = new Map<string, CachedAgentState>();
  private resetInProgress = new Map<string, "restart" | "session" | "full">();
  private lastReadyOnlineBroadcastAt = new Map<string, number>();
  private lifecycleEventsByAgent = new Map<string, AgentLifecycleRingBuffer>();
  private staleActivityTimer: unknown | null = null;
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
  private activityDaemonGenerationsByAgent = new Map<string, string[]>();
  private kimiActivityCircuitByLaunch = new Map<string, KimiActivityCircuitState>();
  private daemonIngressRateLimitWindows = new Map<string, DaemonIngressRateLimitWindow>();
  private daemonIngressTotalRateLimitWindows = new Map<string, DaemonIngressRateLimitWindow>();
  private lastIngressReplicaRefreshAt = new Map<string, number>();

  /**
   * Per-agent monotonic counter for outbound `agent:activity` socket
   * emits. Lets the client drop stale pushes that arrive out-of-order
   * during reconnect storms. Resets on server restart — the client
   * also clears its own lastSeen on `socket.connect`, which fires
   * `loadAgents()` and replaces the dot state wholesale, so the
   * reset window is self-healing.
   */
  private activityServerSeq = new Map<string, number>();
  private runtimeProfileHeartbeatNudgeSentAt = new Map<string, number>();
  private computerControlRelayTraceState = new Map<string, {
    lastAt: number;
    phase?: string;
    percentBucket?: number;
  }>();

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
  private static AGENT_DELIVERY_ACK_TIMEOUT_MS = 5_000;
  private static AGENT_DELIVERY_ACK_MAX_ATTEMPTS = 24;
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
  private static ACTIVITY_DAEMON_GENERATIONS_PER_AGENT = 4;
  /** Retain a small recent lifecycle buffer for debugging/tests without introducing persistence yet. */
  private static MAX_LIFECYCLE_EVENTS = 500;
  private readonly daemonIngressRateLimitWindowMs: number;
  private readonly daemonIngressRateLimitMaxEvents: number;
  private readonly daemonIngressRateLimitMaxEventsPerMachine: number;
  private readonly daemonIngressRateLimitDisabled: boolean;

  constructor(
    private readonly replicaStateStore: ReplicaStateStore = redisReplicaStateStore,
    private readonly clock: OrchestratorClock = systemOrchestratorClock,
    private readonly tracer: Tracer = noopTracer,
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
  }

  getCurrentTimeMs(): number {
    return this.clock.now();
  }

  private recordBuiltInAppTrace(
    name: string,
    attrs: Record<string, unknown>,
    status: "ok" | "error" = "ok",
  ): void {
    const span = this.tracer.startSpan(name, {
      surface: "server",
      kind: "internal",
      attrs: filterAppRuntimeTraceAttrs(attrs),
    });
    span.end(status);
  }

  private async deliverBuiltInAppSnapshot<T>(input: {
    machineId: string;
    messageType: "reminder.snapshot" | "app_config.snapshot";
    spanName: "server.app_source.transport" | "server.app_config.transport";
    composition: AppSnapshotComposition<T>;
    buildMessage: (values: T[]) => ServerToMachineMessage;
  }): Promise<void> {
    const snapshotFailed = input.composition.terminals.some(
      (terminal) => terminal.outcome === "snapshot_failed",
    );
    let sent = false;
    if (!snapshotFailed) {
      try {
        sent = await this.sendToMachine(
          input.machineId,
          input.buildMessage(input.composition.envelopes.map((envelope) => envelope.value)),
        );
      } catch {
        sent = false;
      }
    }
    for (const envelope of input.composition.envelopes) {
      this.recordBuiltInAppTrace(input.spanName, {
        ...envelope.traceAttrs,
        machine_id: input.machineId,
        message_type: input.messageType,
        outcome: sent ? "sent" : "send_failed",
      }, sent ? "ok" : "error");
    }
    for (const terminal of input.composition.terminals) {
      const failed = terminal.outcome === "snapshot_failed";
      this.recordBuiltInAppTrace(input.spanName, {
        ...terminal.traceAttrs,
        machine_id: input.machineId,
        message_type: input.messageType,
        outcome: failed ? "snapshot_failed" : sent ? "sent_empty" : "send_failed",
        ...(failed ? { reason: terminal.reason } : {}),
      }, failed || !sent ? "error" : "ok");
    }
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

  protected async persistAgentStatus(agentId: string, status: AgentStatus, sessionId?: string) {
    await agentService.updateAgentStatus(agentId, status, sessionId);
  }

  /**
   * Signal-driven status writes (ready reconcile, daemon `agent:status`/`agent:session`)
   * gate on the in-memory cache, but the cache is replica-local and never
   * invalidated cross-replica. Route signal writes through the DB-layer guard so
   * a stale `active` cache on another replica cannot resurrect a stopped agent.
   */
  protected async persistAgentStatusFromSignal(agentId: string, status: AgentStatus, sessionId?: string) {
    return agentService.updateAgentStatusFromSignal(agentId, status, sessionId);
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

  protected async clearPersistedAgentLastRuntimeError(agentId: string) {
    return agentService.clearAgentLastRuntimeError(agentId);
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

  private lifecycleProjectionWriterDeps(): AgentLifecycleProjectionWriterDeps {
    return {
      broadcastActivity: (agentId, activity, detail, detailKind, entries, nowOverride, options) =>
        this.broadcastActivity(agentId, activity, detail, detailKind, entries, nowOverride, options),
      broadcastReadyOnline: (agentId, span) => this.broadcastReadyOnline(agentId, span),
      emitLifecyclePlanShadowVerdict: (agentId, signal, span) =>
        this.emitActivityWriterShadowVerdict(span, agentId, {
          activity: signal.activity,
          detailKind: signal.detailKind,
          observationClass: signal.observationClass,
          site: "lifecycle_plan",
          planKind: signal.planKind,
        }),
      clearInbox: (agentId) => this.clearAgentInbox(agentId),
      clearLaunchGuard: (agentId) => this.clearLaunchGuard(agentId),
      maybeResolveStartingActivity: (agentId, span) => this.maybeResolveStartingActivity(agentId, span),
      persistAgentStatus: (agentId, status, sessionId) => this.persistAgentStatus(agentId, status, sessionId),
      persistAgentStatusFromSignal: (agentId, status, sessionId) =>
        this.persistAgentStatusFromSignal(agentId, status, sessionId),
      releaseWakeLock: (agentId) => this.releaseWakeLock(agentId),
      terminalizeFreshnessHold: (agentId, reason, span) => this.terminalizeFreshnessHold(agentId, reason, span),
      sendBestEffortStopToMachine: (machineId, agentId) => this.sendBestEffortToMachine(
        machineId,
        { type: "agent:stop", agentId },
        `best-effort lifecycle stop send failed for agent ${agentId}`,
      ),
      sendStopToMachine: async (machineId, agentId) => {
        const sent = await this.sendToMachine(machineId, { type: "agent:stop", agentId });
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
        this.sweepStaleActivities();
        void this.sweepComputerLifecycleOperations().catch(() => {});
        void this.dispatchPendingComputerLifecycleOperations().catch(() => {});
      }, 30_000);
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
   * cancels the fallback. If the machine is unreachable, we fall back
   * to the legacy synth-online behaviour. If a connected daemon probe
   * times out, we preserve the last busy state instead of inventing
   * online/idle: a missed probe is not proof that a long tool call
   * finished.
   *
   * The pure-function `planStaleActivitySweepAction` + protected
   * `applyStaleActivitySweepAction` seam is preserved for tests; the
   * probe machinery wraps but doesn't replace it.
   */
  private sweepStaleActivities() {
    const now = this.clock.now();
    for (const [agentId, entry] of this.agentActivity) {
      const action = planStaleActivitySweepAction({
        isTransient: this.isTransientActivity(entry.activity),
        ageSec: (now - this.getActivityObservedAtMs(entry)) / 1000,
        staleAfterSec: AgentOrchestrator.ACTIVITY_STALE_SEC,
      });
      if (action === "keep-current") continue;

      // Resolve the agent's machine from the in-memory state cache. If
      // we have no cached entry (rare in steady state — the agent was
      // never seen by this replica), fast-path straight to synth-online.
      // If the machine is not connected locally but Redis still says a
      // different replica owns the machine, this replica is a non-owner:
      // preserve the busy state instead of inventing online.
      //
      // NOTE: this cache can be stale during a machine migration (the
      // agent moved but cache still points at the old machine). In
      // that window the probe goes to the wrong daemon → no response
      // → 5s fallback refreshes the existing busy state instead of
      // synth'ing online. Migration-aware probe routing can be a
      // follow-up. (@Tenny note d8459ab7)
      const cached = this.agentStateCache.get(agentId);
      const machineId = cached?.machineId ?? null;
      if (!machineId) {
        this.applyStaleActivitySweepAction({ action, agentId, now });
        continue;
      }
      if (!this.machineConnections.has(machineId)) {
        void this.handleStaleActivityWithoutLocalMachine(agentId, machineId, action, now);
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
      void this.issueActivityProbe(agentId, machineId, now);
    }
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

    const probeId = crypto.randomUUID();
    const fallbackTimer = setTimeout(() => {
      // Probe timed out — daemon crashed, unreachable, or too slow.
      if (this.pendingActivityProbes.delete(probeId)) {
        fallbackToBusySnapshot();
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

    const serverId = this.agentStateCache.get(agentId)?.serverId ?? "unknown";
    const span = this.tracer.startSpan("server.agent.stale_activity.busy_preserved", {
      surface: "server",
      kind: "internal",
      attrs: {
        agent_id: agentId,
        server_id: serverId,
        previous_activity: current.activity,
        detail_present: Boolean(current.detail),
        repair_kind: "probe_timeout_busy_preserved",
      },
    });
    // A probe timeout is not a new runtime or delivery observation. Keep the
    // existing snapshot in memory, but do not re-broadcast it: re-emitting a
    // stale message_received snapshot mints a new user-visible/durable fact and
    // launders its freshness on every sweep cadence. The legacy
    // preserve_rebroadcast site value remains stable for trace consumers, while
    // the verdict records the canonical no-authority/no-clock-advance outcome.
    span.addEvent(
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
    span.end("ok", {
      attrs: {
        authority: "scheduler_repair",
        previous_activity: current.activity,
        candidate_activity: current.activity,
        served_activity: current.activity,
        projection_outcome: "preserved_without_write",
        outcome: "preserved_without_write",
        reason: "synthetic_no_authority",
        advances_observed_clock: "none",
      },
    });
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
    const span = this.tracer.startSpan("server.agent.synthetic_repair.apply", {
      surface: "server",
      kind: "internal",
      attrs: {
        agent_id: context.agentId,
        server_id: serverId,
        synthetic_repair: true,
        repair_kind: "stale_sweep",
        source: "scheduler",
      },
    });
    const current = this.agentActivity.get(context.agentId);
    // Keep the legacy online candidate in the shadow verdict so the rejected
    // heuristic remains measurable, but do not project it into activity truth.
    this.emitSyntheticRepairShadowVerdict(span, context.agentId, context.now);
    span.end("ok", {
      attrs: {
        authority: "scheduler_repair",
        previous_activity: current?.activity ?? "none",
        candidate_activity: "online",
        served_activity: current?.activity ?? "none",
        projection_outcome: "preserved_without_write",
        outcome: "preserved_without_write",
        reason: "synthetic_no_authority",
        advances_observed_clock: "none",
      },
    });
  }

  /**
   * Shared gamma shadow emitter for the two synthetic-repair apply sites
   * (stale_sweep / transient_normalization). The signal records the rejected
   * legacy online candidate even though canonical repair is now trace-only.
   * This keeps the former whitewash measurable without minting it as truth.
   */
  private emitSyntheticRepairShadowVerdict(span: ActiveSpan, agentId: string, nowMs: number) {
    const current = this.agentActivity.get(agentId);
    span.addEvent(
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
   * see AGENT_ACTIVITY_WRITER_REGISTRY). Rides the caller's span when one
   * exists; otherwise opens a dedicated self-ended span. The fallback is
   * the g1 Phase-B lesson: a serving-map write must never be trace-
   * invisible for lack of a parent span — that is exactly how the traceless
   * online writer stayed unattributable. Trace-only; zero behavior change.
   */
  private emitActivityWriterShadowVerdict(
    span: ActiveSpan | null | undefined,
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
    if (span) {
      span.addEvent("lifecycle_v2.shadow_verdict", attrs);
      return;
    }
    const fallback = this.tracer.startSpan("server.agent.activity_writer.shadow", {
      surface: "server",
      kind: "internal",
      attrs: { agent_id: agentId, writer_site: signal.site },
    });
    fallback.addEvent("lifecycle_v2.shadow_verdict", attrs);
    fallback.end("ok");
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
    this.emitActivityWriterShadowVerdict(span, agentId, {
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

  async recordExternalAgentActivity(
    agentId: string,
    request: ExternalAgentActivityIngestRequest,
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
      },
    });
    let acceptedCount = 0;
    let rejectedCount = 0;
    try {
      for (const event of request.events) {
        const mapped = mapExternalPluginActivityEvent(event);
        if (!mapped) {
          rejectedCount += 1;
          continue;
        }
        acceptedCount += 1;
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
        });
        await applyAgentLifecycleProjectionPlan(plan, this.lifecycleProjectionWriterDeps(), span);
      }
      span.end("ok", {
        attrs: {
          outcome: acceptedCount > 0 ? "accepted" : "dropped",
          reason: acceptedCount > 0 ? "external_activity_mapped" : "no_mappable_events",
          accepted_count: acceptedCount,
          rejected_count: rejectedCount,
        },
      });
    } catch (err) {
      span.end("error", {
        attrs: {
          outcome: "error",
          reason: "external_activity_projection_failed",
          accepted_count: acceptedCount,
          rejected_count: rejectedCount,
          error_class: err instanceof Error ? err.name : typeof err,
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
    this.emitActivityWriterShadowVerdict(null, agentId, {
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

  private formatRuntimeErrorActivity(error: AgentRuntimeErrorState): VisibleActivity {
    return this.formatActivity("error", error.message);
  }

  private async rememberRuntimeError(agentId: string, error: AgentRuntimeErrorState): Promise<boolean> {
    // Redis is an authority only for a value the durable row accepted. Publish
    // nothing (including the process-local shadow) when persistence is a no-op
    // or throws, otherwise another replica could observe Redis-only truth.
    const persisted = await this.persistAgentLastRuntimeError(agentId, error);
    if (!persisted) return false;

    this.updateCache(agentId, { lastRuntimeError: error });
    // gamma-2 shadow: the error state is daemon-reported ground truth
    // (observed); classification note filed for Kai's calibration table.
    this.emitActivityWriterShadowVerdict(null, agentId, {
      activity: "error",
      detailKind: "runtime_error",
      observationClass: "observed",
      site: "runtime_error",
    });
    const now = this.clock.now();
    const errorObservedAtMs = Date.parse(error.at);
    this.writeAgentActivitySnapshot(agentId, "error", error.message, "runtime_error", now, {
      observedAtMs: Number.isFinite(errorObservedAtMs) ? errorObservedAtMs : now,
      arbitration: {
        observationClass: "observed",
        signalSite: "runtime_error",
      },
    });
    await this.mirrorAgentRuntimeError(agentId, error);
    return persisted;
  }

  private async clearLastRuntimeError(agentId: string): Promise<boolean> {
    // A Redis tombstone must never outrun the durable clear. Keeping all local
    // projections unchanged on rejection also prevents this replica from
    // claiming recovery that persistence did not accept.
    const persisted = await this.clearPersistedAgentLastRuntimeError(agentId);
    if (!persisted) return false;

    this.updateCache(agentId, { lastRuntimeError: null });
    const current = this.agentActivity.get(agentId);
    if (current?.activity === "error") {
      // gamma-2 shadow: the error->online restore is a server-derived write
      // (the recovery observation itself flows through ingest separately).
      this.emitActivityWriterShadowVerdict(null, agentId, {
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
    return persisted;
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
  }): AgentRuntimeErrorState {
    const typed = input.typed ? {
      errorClass: input.typed.errorClass,
      errorReason: input.typed.errorReason,
      fingerprint: input.typed.fingerprint,
      reasonProvenance: input.typed.reasonProvenance,
    } : {};
    return {
      message: input.detail || "Agent encountered an error",
      at: new Date(input.atMs ?? this.clock.now()).toISOString(),
      ...(input.launchId !== undefined ? { launchId: input.launchId } : {}),
      actionRequired: true,
      ...typed,
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
    this.emitActivityWriterShadowVerdict(span, agentId, {
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
    this.emitActivityWriterShadowVerdict(span, agentId, {
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
    this.emitActivityWriterShadowVerdict(span, agentId, {
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
        const mirror = await this.replicaStateStore.getAgentRuntimeError(agentId);
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
        const freshAgent = await this.getAuthoritativeAgentForDelivery(agentId);
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

    const freshAgent = await this.getAuthoritativeAgentForDelivery(agentId);
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
      const span = this.tracer.startSpan("server.agent.synthetic_repair.apply", {
        surface: "server",
        kind: "internal",
        attrs: {
          agent_id: context.agentId,
          server_id: serverId,
          synthetic_repair: true,
          repair_kind: "transient_normalization",
          source: "scheduler",
        },
      });
      const current = this.agentActivity.get(context.agentId);
      // Record the rejected online candidate, then serve online only as an
      // ephemeral read view. No map, persistence, broadcast, or clock write.
      this.emitSyntheticRepairShadowVerdict(span, context.agentId, context.now);
      span.end("ok", {
        attrs: {
          authority: "scheduler_repair",
          previous_activity: current?.activity ?? "none",
          candidate_activity: "online",
          served_activity: "online",
          projection_outcome: "served_ephemeral",
          outcome: "served_ephemeral",
          reason: "synthetic_no_authority",
          advances_observed_clock: "none",
        },
      });
    }
    return this.formatActivity("online");
  }

  private async getMachineReachability(agent: CachedAgentState | null): Promise<MachineReachability> {
    return planMachineReachability(await this.loadMachineReachabilityPlanInput({ agent }));
  }

  protected async loadMachineReachabilityPlanInput(
    context: MachineReachabilityInputContext,
  ): Promise<MachineReachabilityPlanInput> {
    const machineId = context.agent?.machineId ?? null;
    const replicaStateAvailable = this.replicaStateStore.isAvailable();
    const hasLocalMachine = Boolean(machineId && this.hasMachineLocally(machineId));
    const ownerReplica = machineId && replicaStateAvailable && !hasLocalMachine
      ? await this.replicaStateStore.getMachineReplicaOwner(machineId)
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
  ): Promise<VisibleActivity | null> {
    span.addEvent("activity.hint.seen", {
      source,
      activity: snapshot.activity,
    });

    const planInput = await this.loadActivityHintResolutionPlanInput({
      agent,
      snapshot,
      source,
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
    const reachabilityInput = await this.loadMachineReachabilityPlanInput({ agent: context.agent });
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
      return this.formatActivity(context.snapshot.activity, context.snapshot.detail);
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
    return this.formatActivity(context.snapshot.activity, context.snapshot.detail);
  }

  private async resolveDerivedActivity(agent: CachedAgentState | null): Promise<VisibleActivity> {
    const reachability = await this.getMachineReachability(agent);

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
  ): Promise<VisibleActivity | null> {
    const reachabilityInput = await this.loadMachineReachabilityPlanInput({ agent });
    const reachability = planMachineReachability(reachabilityInput);
    const persisted = await this.loadLatestPersistedActivityHint(agentId);
    const isExternal = reachability === "external-reported";
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
  private async getCachedAgent(agentId: string): Promise<CachedAgentState | null> {
    const cached = this.agentStateCache.get(agentId);
    if (cached) return cached;

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

  /**
   * Passive-delivery scope check. Default impl reads `agent_scopes` via
   * `agentHasScope`; deterministic tests override to bypass DB. See
   * `DeliverMessageOptions.intrinsic` for the full design rationale.
   */
  protected async hasPassiveDeliveryScope(agentId: string): Promise<boolean> {
    return agentHasScope(agentId, "inbox:receive");
  }

  // `protected` for the same reason: arms ②③ must get past identity resolution to reach the
  // branch under test, and stubbing it is the only way to do that without seeding a full agent row.
  protected async getAuthoritativeAgentForDelivery(agentId: string): Promise<CachedAgentState | null> {
    const persisted = await this.loadAgentForDelivery(agentId);
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
    if (this.isMachineHeartbeatStale(conn)) {
      const span = this.tracer.startSpan("server.machine.websocket.heartbeat", {
        surface: "server",
        kind: "internal",
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
      });
      console.log(`[Machine ${machineId}] Heartbeat timeout — terminating socket`);
      span.addEvent("heartbeat.timeout", {
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
      span.end("error", {
        attrs: {
          outcome: "heartbeat_timeout",
          terminated_socket: true,
        },
      });
      return;
    }

    void this.sendToMachine(machineId, { type: "ping" })
      .then((sent) => {
        if (sent) return;
        this.tracer.startSpan("server.machine.websocket.heartbeat", {
          surface: "server",
          kind: "internal",
          attrs: {
            machine_id: machineId,
            server_id: conn.serverId,
            machine_id_present: Boolean(machineId),
            server_id_present: Boolean(conn.serverId),
            daemon_version_present: Boolean(conn.daemonVersion),
            ws_ready_state: conn.ws.readyState,
            last_pong_age_ms_bucket: durationMsBucket(lastPongAgeMs),
            heartbeat_timeout_ms: AgentOrchestrator.MACHINE_HEARTBEAT_TIMEOUT_MS,
            outcome: "ping_send_failed",
            sent: false,
          },
        }).end("error");
      })
      .catch((err) => {
        console.warn(`[Machine ${machineId}] best-effort ping send failed:`, err);
        this.tracer.startSpan("server.machine.websocket.heartbeat", {
          surface: "server",
          kind: "internal",
          attrs: {
            machine_id: machineId,
            server_id: conn.serverId,
            machine_id_present: Boolean(machineId),
            server_id_present: Boolean(conn.serverId),
            daemon_version_present: Boolean(conn.daemonVersion),
            ws_ready_state: conn.ws.readyState,
            last_pong_age_ms_bucket: durationMsBucket(lastPongAgeMs),
            heartbeat_timeout_ms: AgentOrchestrator.MACHINE_HEARTBEAT_TIMEOUT_MS,
            outcome: "ping_send_failed",
            sent: false,
            error_class: err instanceof Error ? err.name : typeof err,
          },
        }).end("error");
      });
  }

  protected startMachineHeartbeat(machineId: string, conn: MachineConnection) {
    this.tracer.startSpan("server.machine.websocket.heartbeat_timer", {
      surface: "server",
      kind: "internal",
      attrs: {
        machine_id: machineId,
        server_id: conn.serverId,
        machine_id_present: Boolean(machineId),
        server_id_present: Boolean(conn.serverId),
        interval_ms: 30_000,
        outcome: "started",
      },
    }).end("ok");
    conn.heartbeatTimer = this.clock.scheduleRepeated(() => this.onMachineHeartbeatTick(machineId, conn), 30_000);
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

  protected async isRuntimeAccountUsageFeatureEnabled(serverId: string): Promise<boolean> {
    return (await evaluateFeatureFlag({
      key: RUNTIME_ACCOUNT_USAGE_FEATURE_FLAG_KEY,
      serverId,
    })).enabled;
  }

  protected async writeRuntimeAccountUsageSnapshot(machineId: string, snapshot: unknown): Promise<void> {
    await runtimeAccountUsageCacheService.write(machineId, snapshot);
  }

  protected async collectScheduledRuntimeAccountUsage(machineId: string, conn: MachineConnection): Promise<void> {
    if (this.machineConnections.get(machineId) !== conn || !conn.runtimes) return;
    if (!await this.isRuntimeAccountUsageDataBoundaryAuthorized(machineId, conn)) return;
    const gateEnabled = await this.isRuntimeAccountUsageFeatureEnabled(conn.serverId);
    for (const provider of runtimeAccountUsageProvidersForScheduledCollection(conn.runtimes, gateEnabled)) {
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

  protected async persistMachineCapabilities(
    machineId: string,
    runtimes: string[],
    hostname?: string,
    os?: string,
    daemonVersion?: string | null,
  ) {
    await machineService.updateMachineRuntimes(machineId, runtimes, hostname, os, daemonVersion);
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
    source: "ready" | "lifecycle_ack" | "upgrade_done",
  ): Promise<void> {
    if (!computerVersion?.trim()) return;
    try {
      const updated = await this.persistMachineComputerVersion(
        machineId,
        computerVersion,
        new Date(this.clock.now()),
      );
      this.tracer.startSpan("server.machine.computer_version.persist", {
        surface: "server",
        kind: "internal",
        attrs: {
          machine_id: machineId,
          source,
          outcome: updated ? "updated" : "unchanged",
        },
      }).end("ok");
    } catch (err) {
      this.tracer.startSpan("server.machine.computer_version.persist", {
        surface: "server",
        kind: "internal",
        attrs: {
          machine_id: machineId,
          source,
          outcome: "failed",
          error_class: err instanceof Error ? err.name : typeof err,
        },
      }).end("error");
    }
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
        await this.persistMachineCapabilities(machineId, payload.runtimes, payload.hostname, payload.os, payload.daemonVersion);
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
        this.tracer.startSpan("server.machine.capabilities.persist_retry", {
          surface: "server",
          kind: "internal",
          attrs: {
            machine_id: machineId,
            attempt: failed.attempt,
            retry_delay_ms: delayMs,
            reason: "capabilities_persist_failed",
            error_class: err instanceof Error ? err.name : typeof err,
            outcome: alerting ? "alerting" : "retrying",
          },
        }).end(alerting ? "error" : "ok");
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
        this.io?.to(`server:${conn.serverId}`).emit("machine:capabilities", {
          machineId,
          runtimes: payload.runtimes,
          runtimeVersions: payload.runtimeVersions ?? {},
          hostname: payload.hostname,
          os: payload.os,
          daemonVersion: payload.daemonVersion,
          computerVersion: payload.computerVersion,
        });
      }
      return;
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
    span?: ActiveSpan,
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
      span,
    );
  }

  private peekLocalInboxWakeMessage(agentId: string): AgentMessage | null {
    return this.agentInboxes.get(agentId)?.inbox[0] ?? null;
  }

  private removeLocalInboxWakeMessage(agentId: string, message: AgentMessage): boolean {
    const inbox = this.agentInboxes.get(agentId);
    if (!inbox || inbox.inbox.length === 0) return false;

    const index = inbox.inbox.findIndex((candidate) => {
      if (message.seq && candidate.seq === message.seq) return true;
      return Boolean(!message.seq && message.message_id && candidate.message_id === message.message_id);
    });
    if (index < 0) return false;

    inbox.inbox.splice(index, 1);
    return true;
  }

  private async maybeWakePendingInboxAfterReady(
    machineId: string,
    agent: ReadyReconcileAgent,
    span?: ActiveSpan,
  ): Promise<boolean> {
    const wakeMessage = this.peekLocalInboxWakeMessage(agent.id);
    if (!wakeMessage) {
      return false;
    }

    const wakeInput = await this.loadWakePlanInput(agent.id, agent.status);
    const action = planWakeAction(wakeInput);
    span?.addEvent("machine.ready.pending_inbox_wake.planned", {
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
      span?.addEvent("machine.ready.pending_inbox_wake.not_started", {
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
    const removed = this.removeLocalInboxWakeMessage(agent.id, wakeMessage);
    span?.addEvent("machine.ready.pending_inbox_wake.started", {
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
    if (conn.runtimeAccountUsageTimer) this.clock.cancelRepeated(conn.runtimeAccountUsageTimer);
    // Cancel any in-flight capabilities-persist retry: once the daemon is gone
    // there is nothing to converge, and the next `ready` on reconnect re-enqueues.
    this.cancelPendingCapabilities(machineId);
    try {
      if (conn.ws.readyState === 1) conn.ws.close(close?.code, close?.reason);
    } catch { /* ignore */ }
    this.machineConnections.delete(machineId);
    if (conn.replicaGeneration) {
      this.machineCatalogAuthority.completeReplacement(machineId, {
        connectionEpochId: conn.connectionEpochId,
        replicaGeneration: conn.replicaGeneration,
      });
    }
    this.lastIngressReplicaRefreshAt.delete(machineId);
    this.tracer.startSpan("server.machine.websocket.heartbeat_timer", {
      surface: "server",
      kind: "internal",
      attrs: {
        machine_id: machineId,
        server_id: conn.serverId,
        machine_id_present: Boolean(machineId),
        server_id_present: Boolean(conn.serverId),
        timer_present: hadHeartbeatTimer,
        outcome: "cleared",
      },
    }).end("ok");

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
  ) {
    const replacedExistingConnection = this.machineConnections.has(machineId);
    const canceledPendingDisconnect = this.cancelPendingMachineDisconnect(machineId);
    const connectionTraceAttrs = projectMachineConnectTraceAttrs(traceContext);
    const span = this.tracer.startSpan("server.machine.connection.register", {
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

      await this.clearMachineConnection(machineId, false);

      const conn: MachineConnection = {
        ws,
        machineId,
        serverId,
        principalKind,
        connectionEpochId: `machine:${machineId}:connection:${crypto.randomUUID()}`,
        replicaGeneration: null,
        heartbeatTimer: null,
        runtimeAccountUsageTimer: null,
        lastPong: this.clock.now(),
        lastIngressAt: this.clock.now(),
        daemonVersion: null,
        capabilities: new Set(),
        runtimes: null,
        runtimeVersions: {},
        migrationTransport: null,
        shutdownIntent: null,
        computerVersion: null,
        traceContext,
      };

      this.startMachineHeartbeat(machineId, conn);

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
        span.addEvent("machine.replica.register_committed", {
          outcome: "committed",
          ...connectionTraceAttrs,
        });
      } catch (err) {
        console.error(
          `[Machine ${machineId}] Failed to register replica mapping:`,
          err instanceof Error ? err.message : err,
        );
        span.addEvent("machine.replica.register_failed", {
          outcome: "failed",
          reason: "replica_register_failed",
          error_class: err instanceof Error ? err.name : typeof err,
        });
        await this.clearMachineConnection(machineId, false, {
          code: 1011,
          reason: "replica_registration_failed",
        }, ws);
        span.end("error", {
          attrs: {
            outcome: "replica_register_failed",
            reason: "replica_register_failed",
            error_class: err instanceof Error ? err.name : typeof err,
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
      span.addEvent("machine.status.emitted", {
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
        span.addEvent("machine.outage_recovery.recorded", {
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
        span.addEvent("machine.outage_recovery.failed", {
          outcome: "failed",
          error_class: err instanceof Error ? err.name : typeof err,
        });
      }
      this.retryPendingAgentDeliveriesForMachine(machineId, "register");
      this.retryPendingAgentStartsForMachine(machineId, "register");

      // Auto-assign this machine to any BYOC agents in the server that have no machine
      try {
        await this.autoAssignConnectedMachine(serverId, machineId);
        span.addEvent("machine.auto_assign.completed", {
          outcome: "completed",
        });
      } catch (err) {
        console.error(`[Machine ${machineId}] Failed to auto-assign agents:`, err);
        span.addEvent("machine.auto_assign.failed", {
          outcome: "failed",
          reason: "auto_assign_failed",
          error_class: err instanceof Error ? err.name : typeof err,
        });
      }

      console.log(`[Machine ${machineId}] Connected (server: ${serverId})`);
      span.end("ok", { attrs: { outcome: "registered", status_version: statusVersion } });
    } catch (err) {
      span.end("error", {
        attrs: {
          outcome: "error",
          reason: "direct_delivery_exception",
          error_class: err instanceof Error ? err.name : typeof err,
        },
      });
      throw err;
    }
  }

  async unregisterMachine(machineId: string): Promise<void> {
    this.cancelPendingMachineDisconnect(machineId);
    await this.clearMachineConnection(machineId, true);
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

  protected claimPendingComputerLifecycleDispatches(machineIds: string[]) {
    return computerLifecycleOperationService.claimPendingComputerLifecycleDispatches(machineIds);
  }

  protected releaseComputerLifecycleDispatchLease(operationId: string) {
    return computerLifecycleOperationService.releaseComputerLifecycleDispatchLease(operationId);
  }

  protected markComputerLifecycleCommandSent(operationId: string) {
    return computerLifecycleOperationService.markComputerLifecycleCommandSent(operationId);
  }

  protected async loadComputerBroadcastMachine(machineId: string): Promise<{ os: string | null } | null> {
    const machine = await machineService.getMachine(asMachineId(machineId));
    return machine ? { os: machine.os } : null;
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
      if (operation.action === "upgrade") {
        const machine = await this.loadComputerBroadcastMachine(operation.machineId);
        const decision = await this.evaluateComputerBroadcastPolicy({
          source: await this.getMachineComputerVersionFact(operation.machineId),
          platform: normalizeComputerPlatform(machine?.os),
          requestedTargetVersion: operation.targetVersion,
          now: new Date(this.clock.now()),
        });
        if (decision.reasonCode === "hands_unavailable") {
          // A temporary release-authority outage is not a withdrawn target.
          // Release the dispatch lease; the existing operation deadline still bounds retries.
          await this.releaseComputerLifecycleDispatchLease(operation.operationId);
          continue;
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
          this.tracer.startSpan("server.computer.operation.command.refused", {
            surface: "server",
            kind: "internal",
            attrs: {
              operation_id: operation.operationId,
              machine_id: operation.machineId,
              action: operation.action,
              policy_revision: decision.policyRevision ?? "unknown",
              policy_reason: decision.reasonCode,
              outcome: "refused",
            },
          }).end("error");
          continue;
        }
      }
      const { sent } = await this.sendComputerControl(
        operation.machineId,
        operation.action,
        operation.operationId,
      );
      if (!sent) {
        await this.releaseComputerLifecycleDispatchLease(operation.operationId);
        continue;
      }
      await this.markComputerLifecycleCommandSent(operation.operationId);
      this.tracer.startSpan("server.computer.operation.command.sent", {
        surface: "server",
        kind: "internal",
        attrs: {
          operation_id: operation.operationId,
          machine_id: operation.machineId,
          action: operation.action,
          outcome: "sent",
        },
      }).end("ok");
    }
  }

  private async sweepComputerLifecycleOperations(): Promise<void> {
    const results = await computerLifecycleOperationService.expirePendingComputerLifecycleOperations();
    for (const result of results) {
      if (result.status !== "terminal") continue;
      const span = this.tracer.startSpan("server.computer.operation.terminal", {
        surface: "server",
        kind: "internal",
        attrs: {
          operation_id: result.fact.operationId,
          server_id: result.fact.serverId,
          machine_id: result.fact.machineId,
          action: result.fact.action,
          terminal: result.fact.terminal,
          projection_count: result.projections.length,
          outcome: result.fact.terminal,
        },
      });
      span.addEvent("operation.terminal", {
        operation_id: result.fact.operationId,
        terminal: result.fact.terminal,
        outcome: result.fact.terminal,
      });
      span.addEvent("activity.projected", {
        operation_id: result.fact.operationId,
        projection_count: result.projections.length,
        outcome: "history_only",
      });
      span.end("error");
    }
  }

  async sendAgentMigrationTransportLease(
    machineId: string,
    msg: Extract<ServerToMachineMessage, { type: "machine:migration_transport:lease" }>,
  ): Promise<void> {
    await this.sendRequiredToMachine(machineId, msg, "Machine WebSocket not ready for migration transfer lease");
  }

  protected getMachineResponseRelay() { return machineResponseRelay; }

  private recordMachineResponseRelay(event: string, attrs: Record<string, string | boolean>): void {
    this.tracer.startSpan(`server.machine.response.${event}`, {
      surface: "server", kind: "internal", attrs,
    }).end(event === "failed" || event === "forward_failed" ? "error" : "ok");
  }

  async archiveAgentMigrationSourceWorkspace(
    machineId: string,
    input: { migrationId: string; agentId: string },
  ): Promise<"archived" | "already_archived"> {
    const requestId = crypto.randomUUID();
    if (!this.machineConnections.has(machineId)) {
      const response = await this.getMachineResponseRelay().request({
        requestId, machineId, type: "machine:migration:source_workspace_archive_result", ...input,
      }, 15_000, () => this.sendRequiredToMachine(machineId, {
        type: "machine:migration:source_workspace_archive", requestId, ...input,
      }), (event, attrs) => this.recordMachineResponseRelay(event, attrs));
      if (response.type !== "machine:migration:source_workspace_archive_result" || response.outcome === "error") {
        throw new RouteFailureError("unknown", "Migration source workspace archive failed");
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
          reject(new RouteFailureError(
            "unknown",
            "Migration source workspace archive failed",
          ));
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
    const result = await this.observeComputerLifecycleAck({
      machineId,
      serverId,
      connectionEpoch,
      acknowledgement,
    });
    if (result.status === "rejected") return;
    if (acknowledgement.phase === "ready" && acknowledgement.loadedComputerVersion) {
      await this.recordReportedMachineComputerVersion(
        machineId,
        acknowledgement.loadedComputerVersion,
        "lifecycle_ack",
      );
    }
    const operationId = result.status === "terminal" ? result.fact.operationId : result.operationId;
    const acknowledgementSpan = this.tracer.startSpan("server.computer.operation.ack.received", {
      surface: "server",
      kind: "internal",
      attrs: {
        operation_id: operationId,
        server_id: serverId,
        machine_id: machineId,
        action: acknowledgement.action,
        phase: acknowledgement.phase,
        outcome: result.status,
      },
    });
    acknowledgementSpan.addEvent("operation.ack.received", {
      operation_id: operationId,
      action: acknowledgement.action,
      phase: acknowledgement.phase,
      outcome: result.status,
    });
    if (result.status === "terminal") {
      acknowledgementSpan.addEvent("operation.terminal", {
        operation_id: operationId,
        action: result.fact.action,
        terminal: result.fact.terminal,
        outcome: result.fact.terminal,
      });
      acknowledgementSpan.addEvent("activity.projected", {
        operation_id: operationId,
        projection_count: result.projections.length,
        outcome: "history_only",
      });
      this.tracer.startSpan("server.computer.operation.terminal", {
        surface: "server",
        kind: "internal",
        attrs: {
          operation_id: operationId,
          server_id: serverId,
          machine_id: machineId,
          action: result.fact.action,
          terminal: result.fact.terminal,
          projection_count: result.projections.length,
          outcome: result.fact.terminal,
        },
      }).end(result.fact.terminal === "completed" ? "ok" : "error");
    }
    acknowledgementSpan.end(result.status === "terminal" && result.fact.terminal !== "completed" ? "error" : "ok");
    await this.sendToMachine(machineId, {
      type: "computer:lifecycle:receipt",
      operationId: computerLifecycleOperationService.resolveComputerLifecycleOperationId(acknowledgement)
        ?? operationId,
      phase: acknowledgement.phase,
    });
  }

  private shouldTraceComputerUpgradeProgress(requestId: string, phase: string, percent: unknown): boolean {
    const now = this.clock.now();
    const percentBucket = typeof percent === "number" ? Math.floor(percent / 10) * 10 : undefined;
    const last = this.computerControlRelayTraceState.get(requestId);
    const shouldTrace =
      !last ||
      last.phase !== phase ||
      last.percentBucket !== percentBucket ||
      now - last.lastAt >= 15_000;
    if (shouldTrace) {
      this.computerControlRelayTraceState.set(requestId, { lastAt: now, phase, percentBucket });
    }
    return shouldTrace;
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

  private traceComputerControlRelay(
    machineId: string,
    conn: MachineConnection,
    msg: MachineToServerMessage,
  ): void {
    if (msg.type === "computer:restart:done") {
      this.tracer.startSpan("server.computer.control.relay", {
        surface: "server",
        kind: "internal",
        attrs: {
          action: "restart",
          event_type: msg.type,
          server_id: conn.serverId,
          machine_id: machineId,
          request_id: msg.requestId,
          ok: msg.ok,
          error_present: Boolean(msg.error),
        },
      }).end(msg.ok ? "ok" : "error");
      return;
    }
    if (msg.type === "computer:upgrade:progress") {
      if (!this.shouldTraceComputerUpgradeProgress(msg.requestId, msg.phase, msg.percent)) return;
      this.tracer.startSpan("server.computer.control.relay", {
        surface: "server",
        kind: "internal",
        attrs: {
          action: "upgrade",
          event_type: msg.type,
          server_id: conn.serverId,
          machine_id: machineId,
          request_id: msg.requestId,
          phase: msg.phase,
          percent_present: typeof msg.percent === "number",
          percent_bucket: typeof msg.percent === "number" ? Math.floor(msg.percent / 10) * 10 : undefined,
        },
      }).end("ok");
      return;
    }
    if (msg.type === "computer:upgrade:done") {
      this.computerControlRelayTraceState.delete(msg.requestId);
      this.tracer.startSpan("server.computer.control.relay", {
        surface: "server",
        kind: "internal",
        attrs: {
          action: "upgrade",
          event_type: msg.type,
          server_id: conn.serverId,
          machine_id: machineId,
          request_id: msg.requestId,
          ok: msg.ok,
          rolled_back: msg.rolledBack ?? false,
          new_version_present: Boolean(msg.newVersion),
          error_present: Boolean(msg.error),
        },
      }).end(msg.ok ? "ok" : "error");
    }
  }

  /** Check if a daemon supports the launchId lifecycle guard (requires >= 0.30.1). */
  private daemonSupportsLaunchGuard(machineId: string): boolean {
    return supportsLaunchGuardForDaemonVersion(this.getMachineDaemonVersion(machineId));
  }

  protected prepareStartLaunchGuard(agentId: string, machineId: string | null): string | undefined {
    if (!machineId || !this.daemonSupportsLaunchGuard(machineId)) {
      return undefined;
    }
    const launchId = crypto.randomUUID();
    this.setLaunchGuard(agentId, launchId);
    return launchId;
  }

  protected rollbackStartLaunchGuard(agentId: string, launchId?: string) {
    if (launchId) {
      this.clearLaunchGuard(agentId);
    }
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
    if (this.staleActivityTimer) {
      this.clock.cancelRepeated(this.staleActivityTimer);
      this.staleActivityTimer = null;
    }
    for (const timer of this.activityDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.activityDebounceTimers.clear();
    for (const pending of this.pendingMachineDisconnects.values()) {
      this.clock.clearTimeout(pending.timer);
    }
    this.pendingMachineDisconnects.clear();
    for (const pending of this.pendingAgentDeliveryAcks.values()) {
      if (pending.timer) this.clock.clearTimeout(pending.timer);
    }
    this.pendingAgentDeliveryAcks.clear();
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
      surface: "server",
      kind: "internal",
      attrs: {
        machine_id: machineId,
        machine_id_present: Boolean(machineId),
        cause: context.cause || "socket_close",
        close_code_present: context.closeCode !== undefined,
        close_reason_present: Boolean(context.closeReason),
        error_present: Boolean(context.errorMessage),
        shutdown_intent_present: Boolean(context.shutdownIntent),
        shutdown_reason: context.shutdownIntent?.reason,
      },
    });
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
    this.emit(`machine:disconnect:${machineId}`, disconnectContext);
    await this.clearMachineConnection(machineId, false);
    this.dispatchComputerLifecycleDisconnectObservation({
      machineId,
      serverId,
      connectionEpoch: connectionEpochId,
    });
    span.addEvent("operation.disconnect_observation.dispatched", { outcome: "dispatched" });

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
    void this.observeComputerLifecycleDisconnect(input).then(
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
        span.addEvent("machine.replica.register_repaired_after_reconnect", {
          outcome: "repaired",
          reason: "reconnected_during_projection",
          ...projectMachineConnectTraceAttrs(conn?.traceContext ?? buildRuntimeTraceContext()),
        });
      } catch (err) {
        console.error(
          `[Machine ${machineId}] Failed to repair replica mapping after reconnect:`,
          err instanceof Error ? err.message : err,
        );
        span.addEvent("machine.replica.register_repair_failed", {
          outcome: "failed",
          reason: "replica_register_repair_failed",
          error_class: err instanceof Error ? err.name : typeof err,
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
        span.addEvent("machine.outage.recorded", {
          outcome: outage.status,
          ...(outage.status === "created" ? { occurrence_id_present: Boolean(outage.occurrenceId) } : {}),
          ...(outage.status === "suppressed_planned" ? { suppress_reason: outage.reason } : {}),
        });
      } catch (err) {
        console.warn(
          `[Machine ${machineId}] Failed to record Computer outage transition:`,
          err instanceof Error ? err.message : err,
        );
        span.addEvent("machine.outage.failed", {
          outcome: "failed",
          error_class: err instanceof Error ? err.name : typeof err,
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
          if (this.clearAgentInbox(agent.id)) {
            pendingReceivesResolvedCount += 1;
          }
        }
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
        span.addEvent("machine.status.emitted", {
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
          error_class: err instanceof Error ? err.name : typeof err,
          status_version: statusVersion,
          shutdown_intent_present: Boolean(context.shutdownIntent),
          shutdown_reason: context.shutdownIntent?.reason,
        },
      });
    }
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
      limit: this.daemonIngressRateLimitMaxEvents,
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
    const span = this.tracer.startSpan("server.daemon.ingress.rate_limit", {
      surface: "server",
      kind: "internal",
      attrs: {
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
      },
    });

    if (decision.action === "drop") {
      span.end("ok", {
        attrs: {
          outcome: "dropped",
          reason: "daemon_ingress_rate_limited",
          dropped_count: decision.droppedCount,
          retry_after_ms: decision.retryAfterMs,
        },
      });
      return;
    }

    span.end("ok", {
      attrs: {
        outcome: "suppressed_aggregate",
        reason: "daemon_ingress_rate_limited",
        suppressed_count: decision.aggregateDroppedCount,
      },
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
      await builtInDispatch.handle({
        host: this,
        machineId,
        agent,
        daemonVersion: conn?.daemonVersion ?? null,
        computerVersion: conn?.computerVersion ?? null,
        capabilities: conn?.capabilities ?? new Set(),
        nowMs: this.clock.now(),
        send: (message) => this.sendToMachine(machineId, message),
        trace: (name, attrs, status) => this.recordBuiltInAppTrace(name, attrs, status),
        emit: (event, payload) => {
          this.io?.to(`server:${agent.serverId}`).emit(event, payload);
        },
      });
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
        try {
          await this.updateMachineHeartbeat(machineId);
        } catch (err) {
          console.error(`[Machine ${machineId}] Failed to update heartbeat:`, err);
          this.tracer.startSpan("server.machine.websocket.pong_received", {
            surface: "server",
            kind: "internal",
            attrs: {
              machine_id: machineId,
              server_id: conn?.serverId,
              machine_id_present: Boolean(machineId),
              server_id_present: Boolean(conn?.serverId),
              previous_last_pong_age_ms_bucket: previousLastPong == null ? "unknown" : durationMsBucket(this.clock.now() - previousLastPong),
              outcome: "heartbeat_persist_failed",
              connection_present: Boolean(conn),
              error_class: err instanceof Error ? err.name : typeof err,
            },
          }).end("error");
        }
        // Refresh machine→replica TTL in Redis so cross-replica routing stays valid
        this.replicaStateStore.refreshMachineReplica(
          machineId,
          conn?.traceContext ?? buildRuntimeTraceContext(),
          conn?.replicaGeneration ?? undefined,
        ).catch(() => {});
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
            })
            .catch(() => {});
        }
        await this.maybePiggybackRuntimeProfileMigrationNudgesForMachine(machineId);
        break;
      }

      case "machine:runtime_account_usage:snapshot":
      {
        // Re-authorize at the source-to-cache boundary. Raw/legacy principals
        // and Computers that no longer have an attaching human must never
        // populate the private runtime-usage cache, even while the flag is on.
        if (!conn || !await this.isRuntimeAccountUsageDataBoundaryAuthorized(machineId, conn)) break;
        if (!await this.isRuntimeAccountUsageFeatureEnabled(conn.serverId)) break;
        await this.writeRuntimeAccountUsageSnapshot(machineId, msg.snapshot);
        break;
      }

      case "machine:shutdown":
      {
        if (conn) {
          for (const acknowledgement of msg.lifecycleAcks ?? []) {
            await this.handleComputerLifecycleAcknowledgement(
              machineId,
              conn.serverId,
              conn.connectionEpochId,
              acknowledgement,
            );
          }
          const reason = normalizeMachineShutdownReason(msg.reason);
          conn.shutdownIntent = {
            reason,
            receivedAtMs: this.clock.now(),
          };
          this.tracer.startSpan("server.machine.shutdown_intent.received", {
            surface: "server",
            kind: "internal",
            attrs: {
              machine_id: machineId,
              server_id: conn.serverId,
              machine_id_present: Boolean(machineId),
              server_id_present: Boolean(conn.serverId),
              shutdown_reason: reason,
            },
          }).end("ok", { attrs: { outcome: "recorded" } });
        }
        break;
      }

      case "computer:restart:done":
      case "computer:upgrade:progress":
      case "computer:upgrade:done":
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
          if (msg.type === "computer:upgrade:done" && msg.ok && !msg.rolledBack && msg.newVersion) {
            await this.recordReportedMachineComputerVersion(
              machineId,
              msg.newVersion,
              "upgrade_done",
            );
          }
          this.io?.to(`server:${conn.serverId}`).emit(msg.type, { machineId, ...msg });
          this.traceComputerControlRelay(machineId, conn, msg);
          if (msg.type === "computer:upgrade:progress" && msg.targetVersion) {
            await computerLifecycleOperationService.recordComputerLifecycleUpgradeTarget({
              operationId: msg.requestId,
              serverId: conn.serverId,
              machineId,
              targetVersion: msg.targetVersion,
            });
          }
          if (msg.type === "computer:restart:done" && !msg.ok) {
            const reason = msg.error === "control_busy" || msg.error === "self_relaunch_unavailable"
              ? msg.error
              : "restart_reported_failure";
            const terminalization = await this.terminalizeComputerLifecycleOperation({
              operationId: msg.requestId,
              serverId: conn.serverId,
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
          if (msg.type === "computer:upgrade:done" && !msg.ok) {
            const terminalization = await this.terminalizeComputerLifecycleOperation({
              operationId: msg.requestId,
              serverId: conn.serverId,
              machineId,
              terminal: msg.rolledBack ? "rolled_back" : "failed",
              reason: msg.rolledBack ? "upgrade_rolled_back" : "upgrade_reported_failure",
              ...(msg.newVersion ? { loadedComputerVersion: msg.newVersion } : {}),
            });
            await this.sendComputerLifecycleFailureReceipts(
              machineId,
              msg.requestId,
              terminalization,
            );
          }
        }
        break;
      }

      case "ready":
      {
        const readyCapturedAtMs = ingressAtMs;
        const runtimeVersions = normalizeRuntimeVersions(msg.runtimeVersions, msg.runtimes);
        const migrationTransport = normalizeMigrationTransportReady(msg.migrationTransport, readyCapturedAtMs);
        const span = this.tracer.startSpan("server.machine.ready.reconcile", {
          surface: "server",
          kind: "internal",
          attrs: {
            machine_id: machineId,
            server_id: conn?.serverId,
            machine_id_present: Boolean(machineId),
            server_id_present: Boolean(conn?.serverId),
            runtimes_count: msg.runtimes.length,
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
            ...projectMachineConnectTraceAttrs(conn?.traceContext ?? buildRuntimeTraceContext()),
          },
        });
        const actionCounts: Record<string, number> = {};
        let invalid_status_count = 0;
        let requestStartCount = 0;
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
          console.log(`[Machine ${machineId}] Ready, runtimes: ${msg.runtimes.join(", ") || "none"}, version: ${msg.daemonVersion || "unknown"}, running agents: ${msg.runningAgents.join(", ") || "none"}`);
          // Store version in memory (transient connection state)
          if (conn) {
            conn.daemonVersion = msg.daemonVersion ?? null;
            conn.capabilities = new Set((msg.capabilities ?? []).filter((capability) => typeof capability === "string" && capability.trim()));
            conn.computerVersion = msg.computerVersion ?? null;
            conn.migrationTransport = migrationTransport;
            void this.dispatchPendingComputerLifecycleOperations().catch(() => {});
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
                ...machineMetaFromMigrationTransport(migrationTransport),
              })
              .catch(() => {});
          }
          await this.recordReportedMachineComputerVersion(
            machineId,
            msg.computerVersion,
            "ready",
          );
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
          span.addEvent("machine.capabilities.enqueued", {
            outcome: "enqueued",
            runtimes_count: msg.runtimes.length,
          });
          await this.enqueueCapabilitiesPersist(machineId, {
            runtimes: msg.runtimes,
            runtimeVersions,
            hostname: msg.hostname,
            os: msg.os,
            daemonVersion: msg.daemonVersion,
            computerVersion: msg.computerVersion,
          });
          if (conn) this.startRuntimeAccountUsageSchedule(machineId, conn);

          // Reconcile all agents assigned to this machine:
          // - running now => mark active
          // - active but missing => keep wakeable/online, mark only runtime process absent
          // - inactive/stopped => stay non-running until an explicit wake path
          try {
            const runningSet = new Set(msg.runningAgents);
            const machineAgents = await this.loadAgentsForReadyReconcile(machineId);
            span.addEvent("machine.ready.agents.loaded", {
              outcome: "loaded",
              agents_count: machineAgents.length,
            });
            for (const agent of machineAgents) {
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
                  span,
                );
                continue;
              }

              const action = planReadyReconcileAction({
                status: narrowedStatus,
                running,
                resetMode: this.getResetMode(agent.id),
              });
              actionCounts[action] = (actionCounts[action] ?? 0) + 1;
              await this.applyReadyReconcileAction(machineId, agent, action, span);
              if (action === "mark-wakeable-not-running" && await this.maybeWakePendingInboxAfterReady(machineId, agent, span)) {
                requestStartCount += 1;
              }
            }
          } catch (err) {
            console.error(`[Machine ${machineId}] Failed to reconcile agents:`, err);
            span.addEvent("machine.ready.reconcile_failed", {
              outcome: "failed",
              reason: "ready_reconcile_failed",
              error_class: err instanceof Error ? err.name : typeof err,
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
            span.addEvent("machine.ready.mention_recovery_failed", {
              outcome: "failed",
              reason: "mention_recovery_failed",
              error_class: err instanceof Error ? err.name : typeof err,
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
            span.addEvent("machine.ready.reminder_snapshot_push_failed", {
              outcome: "failed",
              reason: "reminder_snapshot_push_failed",
              error_class: err instanceof Error ? err.name : typeof err,
            });
          }
          this.retryPendingAgentDeliveriesForMachine(machineId, "ready_reconcile");
          this.retryPendingAgentStartsForMachine(machineId, "ready_reconcile");
          span.end("ok", {
            attrs: {
              outcome: "processed",
              invalid_status_count,
              force_stop_and_stay_offline_count: actionCounts["force-stop-and-stay-offline"] ?? 0,
              mark_inactive_offline_count: actionCounts["mark-inactive-offline"] ?? 0,
              mark_wakeable_not_running_count: actionCounts["mark-wakeable-not-running"] ?? 0,
              mark_active_online_count: actionCounts["mark-active-online"] ?? 0,
              stay_offline_count: actionCounts["stay-offline"] ?? 0,
              request_start_count: requestStartCount,
            },
          });
        } catch (err) {
          span.end("error", { attrs: { error_class: err instanceof Error ? err.name : typeof err } });
          throw err;
        }
        break;
      }

      case "agent:status": {
        const span = this.tracer.startSpan("server.agent.status.ingest", {
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
        const finish = (outcome: string, attrs?: Record<string, unknown>) => {
          span.end("ok", { attrs: { outcome, ...attrs } });
        };
        try {
          span.addEvent("agent.status.received", {
            outcome: "received",
            reason: "daemon_status",
            reported_status: msg.status,
            launch_id_present: Boolean(msg.launchId),
          });
          const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
          if (!agent) {
            finish("dropped", { reason: "validation_failed" });
            break;
          }
          if (!this.shouldAcceptLifecycleEvent(machineId, agent, msg.type, msg.launchId, span)) {
            span.addEvent("agent.status.lifecycle_guard.checked", {
              outcome: "rejected",
              reason: "lifecycle_guard",
              accepted: false,
              launch_id_present: Boolean(msg.launchId),
            });
            finish("dropped", { reason: "lifecycle_guard" });
            break;
          }
          span.addEvent("agent.status.lifecycle_guard.checked", {
            outcome: "accepted",
            reason: "lifecycle_guard",
            accepted: true,
            launch_id_present: Boolean(msg.launchId),
          });
          const normalizedStatus = normalizeDaemonAgentStatus(msg.status);
          if (!normalizedStatus) {
            console.warn(`[Machine ${machineId}] Unknown agent status "${msg.status}" for ${msg.agentId}, ignoring`);
            finish("dropped", { reason: "unknown_status" });
            break;
          }
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
          span.addEvent("agent.status.action.planned", {
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
            if (action === "persist-active" || action === "persist-inactive" || action === "persist-stopped") {
              span.addEvent("agent.status.persisted", {
                outcome: "persisted",
                reason: "status_signal",
                next_status: nextStatus,
              });
            }
          } catch (err) {
            console.error(`[Machine ${machineId}] Failed to apply agent ${msg.agentId} status projection:`, err);
            span.addEvent("agent.status.persist_failed", {
              outcome: "error",
              reason: "status_projection_failed",
              error_class: err instanceof Error ? err.name : typeof err,
              next_status: nextStatus,
            });
            finish("error", {
              action,
              next_status: nextStatus,
              error_class: err instanceof Error ? err.name : typeof err,
              ...liveActivityAttrs,
            });
            break;
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
              error_class: err instanceof Error ? err.name : typeof err,
            },
          });
          throw err;
        }
        break;
      }

      case "agent:activity": {
        const joinTraceAttrs = daemonActivityJoinTraceAttrs(msg);
        const span = this.tracer.startSpan("server.agent.activity.ingest", {
          surface: "server",
          attrs: {
            agent_id_present: Boolean(msg.agentId),
            machine_id_present: Boolean(machineId),
            ...joinTraceAttrs,
          },
        });
        span.addEvent("activity.ingest.received", {
          activity: msg.activity,
          hasEntries: Boolean(msg.entries?.length),
          hasLaunchId: Boolean(msg.launchId),
          ...joinTraceAttrs,
        });

        const drop = (reason: ActivityIngestionDropReason, attrs?: Record<string, unknown>) => {
          span.addEvent("activity.ingest.dropped", { reason, ...joinTraceAttrs, ...attrs });
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
            break;
          }
          const agent = validation.agent;

          const lifecycleAction = this.getLifecycleEventAcceptanceAction(agent, msg.launchId);
          span.addEvent("lifecycle_guard.checked", {
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
            break;
          }

          if (msg.detailKind !== undefined && !isAgentActivityDetailKind(msg.detailKind)) {
            drop("unknown_activity_detail_kind", {
              detail_kind_present: true,
            });
            break;
          }
          if (
            msg.detailKind !== undefined
            && !(msg.detailKind in CANONICAL_DAEMON_ACTIVITY_BY_DETAIL_KIND)
          ) {
            drop("non_fact_activity_detail_kind", {
              detail_kind: msg.detailKind,
              detail_kind_present: true,
            });
            break;
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
              span.addEvent("activity.ingest.dropped_stale_seq", {
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
              break;
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
            runtimeState: runtimeStateFromAgentActivity(activity),
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
            break;
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
            break;
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
          span.addEvent("activity.ingest.accepted", acceptedAttrs);
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
            span.addEvent(
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
          const currentRuntimeError = this.agentStateCache.get(msg.agentId)?.lastRuntimeError ?? agent.lastRuntimeError ?? null;
          // #688(b): a crash is durable typed authority only when it rides a valid
          // typed RuntimeErrorActivityDiagnostic carrier (normalized server-side).
          const normalizedTypedRuntimeError = normalizeRuntimeErrorActivityDiagnostic(
            (msg as { runtimeError?: RuntimeErrorActivityDiagnostic | Record<string, unknown> | null } | null)?.runtimeError ?? null,
          );
          const runtimeErrorAction = reduceRuntimeErrorActivityAction({
            signal: activitySignal,
            currentErrorPresent: currentRuntimeError !== null,
            isHeartbeat: msg.isHeartbeat,
            typedRuntimeCarrierPresent: normalizedTypedRuntimeError !== null,
          });
          const shouldPreserveVisibleRuntimeError = currentRuntimeError
            && runtimeErrorAction === "preserve"
            && (activity === "online" || activity === "working" || activity === "thinking");
          if (shouldPreserveVisibleRuntimeError) {
            span.addEvent("runtime_error_state.preserved", {
              reason: activitySignal.source === "legacy_detail_kind_missing"
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
              span.addEvent("activity.probe.response_consumed", { probe_id_present: true });
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
            break;
          }
          const result = await applyAgentLifecycleProjectionPlan(
            reduceDaemonActivityLifecycle({
              action,
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
          );
          if (runtimeErrorAction === "set") {
            await this.rememberRuntimeError(msg.agentId, this.buildRuntimeErrorState({
              detail: msg.detail,
              launchId: msg.launchId,
              typed: normalizedTypedRuntimeError,
            }));
            span.addEvent("runtime_error_state.persisted", {
              action_required: true,
              source: activitySignal.source,
              detail_kind: detailKind,
            });
          } else if (runtimeErrorAction === "clear") {
            await this.clearLastRuntimeError(msg.agentId);
            span.addEvent("runtime_error_state.cleared", {
              reason: "strong_typed_runtime_progress",
              detail_kind: detailKind,
            });
          }
          if (result.liveActivityResult) {
            span.addEvent("status.read_model.updated", {
              from: result.liveActivityResult.previousActivity ?? null,
              to: result.liveActivityResult.nextActivity ?? activity,
            });
          }
          if (result.liveActivityResult?.action === "persist-and-emit-now") {
            span.addEvent("activity.log.persist_scheduled", {
              entryCount: result.liveActivityResult.persistedEntryCount ?? 0,
            });
          } else {
            span.addEvent("activity.log.persist_skipped", {
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
            span.addEvent("activity.probe.response_consumed", { probe_id_present: true });
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
          span.addEvent("activity.ingest.failed", {
            error_class: err instanceof Error ? err.name : typeof err,
          });
          span.end("error");
          throw err;
        }
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
          if (action === "persist-active-session") {
            if (result.dbStatusApplied === false) {
              this.agentStateCache.delete(msg.agentId);
            } else {
              await this.clearLastRuntimeError(msg.agentId);
              this.broadcastAgentSession(agent.serverId, msg.agentId, msg.sessionId);
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
          this.broadcastAgentSession(agent.serverId, msg.agentId, null);
        }
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
        const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
        if (!agent) {
          span.end("ok", { attrs: { outcome: "invalid-agent", reason: "invalid_agent" } });
          break;
        }
        if (!this.shouldAcceptLifecycleEvent(machineId, agent, msg.type, msg.launchId)) {
          span.end("ok", { attrs: { outcome: "stale-launch", reason: "stale_launch" } });
          break;
        }
        if (msg.facts.runtime === "kimi") {
          span.end("ok", { attrs: { outcome: "skipped-kimi-runtime", reason: "unsupported_runtime" } });
          break;
        }
        const context = await agentRuntimeProfileService.loadAgentRuntimeProfileContext(msg.agentId);
        if (!context) {
          console.warn(`[Machine ${machineId}] Dropping runtime profile report for ${msg.agentId}: missing runtime profile context`);
          span.end("ok", { attrs: { outcome: "missing-context", reason: "missing_context" } });
          break;
        }
        try {
          await runWithTraceSpan(span, () => agentRuntimeProfileService.recordAgentRuntimeProfile({
            serverId: agent.serverId,
            agentId: msg.agentId,
            machineId,
            daemonVersion: conn?.daemonVersion ?? context.machine.daemonVersion ?? null,
            facts: msg.facts,
          }), scopedTracer);
          span.end("ok", { attrs: { outcome: "recorded", reason: "profile_recorded" } });
        } catch (err) {
          console.error(`[Machine ${machineId}] Failed to record runtime profile for ${msg.agentId}:`, err);
          span.end("error", { attrs: { outcome: "record-failed", reason: "record_failed", error_class: err instanceof Error ? err.name : typeof err } });
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
        const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
        if (!agent) {
          span.end("ok", { attrs: { outcome: "invalid-agent", reason: "invalid_agent" } });
          break;
        }
        if (!this.shouldAcceptLifecycleEvent(machineId, agent, msg.type, msg.launchId)) {
          span.end("ok", { attrs: { outcome: "stale-launch", reason: "stale_launch" } });
          break;
        }
        try {
          await agentRuntimeProfileService.markRuntimeProfileMigrationDelivered(msg.agentId, msg.migrationKey, msg.launchId || null);
          span.end("ok", { attrs: { outcome: "delivered", reason: "ack_delivered" } });
        } catch (err) {
          console.error(`[Machine ${machineId}] Failed to mark runtime profile migration delivered ${msg.migrationKey} for ${msg.agentId}:`, err);
          span.end("error", { attrs: { outcome: "mark-failed", reason: "mark_failed", error_class: err instanceof Error ? err.name : typeof err } });
        }
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
        const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
        if (!agent) {
          span.end("ok", { attrs: { outcome: "invalid-agent", reason: "invalid_agent" } });
          break;
        }
        if (!this.shouldAcceptLifecycleEvent(machineId, agent, msg.type, msg.launchId)) {
          span.end("ok", { attrs: { outcome: "stale-launch", reason: "stale_launch" } });
          break;
        }
        try {
          const handled = await agentRuntimeProfileService.markRuntimeProfileMigrationHandled(msg.agentId, msg.migrationKey, msg.launchId || null);
          if (handled) {
            await this.deliverPendingRuntimeProfileMigration(machineId, agent, msg.launchId);
          }
          span.end("ok", { attrs: { outcome: handled ? "handled" : "not-handled", reason: handled ? "migration_handled" : "no_matching_migration" } });
        } catch (err) {
          console.error(`[Machine ${machineId}] Failed to mark runtime profile migration handled ${msg.migrationKey} for ${msg.agentId}:`, err);
          span.end("error", { attrs: { outcome: "handle-failed", reason: "handle_failed", error_class: err instanceof Error ? err.name : typeof err } });
        }
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
        const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
        if (!agent) {
          span.end("ok", { attrs: { outcome: "invalid-agent", reason: "invalid_agent" } });
          break;
        }
        if (!this.shouldAcceptLifecycleEvent(machineId, agent, msg.type, msg.launchId)) {
          span.end("ok", { attrs: { outcome: "stale-launch", reason: "stale_launch" } });
          break;
        }
        try {
          await runWithTraceSpan(
            span,
            () => agentRuntimeProfileService.markRuntimeProfileMigrationDelivered(msg.agentId, msg.noticeKey, msg.launchId || null),
            this.tracer,
          );
          span.end("ok", { attrs: { outcome: "delivered", reason: "notice_ack_delivered" } });
        } catch (err) {
          console.error(`[Machine ${machineId}] Failed to ack runtime profile daemon release notice ${msg.noticeKey} for ${msg.agentId}:`, err);
          span.end("error", { attrs: { outcome: "mark-failed", reason: "mark_failed", error_class: err instanceof Error ? err.name : typeof err } });
        }
        break;
      }

      case "agent:start:ack": {
        const pending = this.pendingAgentStartAcks.get(msg.startDispatchId);
        if (!pending) {
          const terminalReason = this.terminalAgentStartDispatches.get(msg.startDispatchId);
          this.tracer.startSpan("server.agent.start_dispatch.ack", {
            parent: parseTraceparent(msg.traceparent),
            surface: "server",
            kind: "consumer",
            attrs: {
              agent_id: msg.agentId,
              machine_id: machineId,
              launch_id: msg.launchId,
              start_dispatch_id: msg.startDispatchId,
              queue_state: msg.queueState,
              queue_depth: msg.queueDepth,
              queue_age_ms: msg.queueAgeMs,
              outcome: terminalReason ? "ignored_terminal" : "unknown_dispatch",
              terminal_reason: terminalReason ?? null,
            },
          }).end("ok");
          break;
        }
        if (
          pending.machineId !== machineId
          || pending.msg.agentId !== msg.agentId
          || pending.msg.launchId !== msg.launchId
        ) {
          this.tracer.startSpan("server.agent.start_dispatch.ack", {
            parent: parseTraceparent(msg.traceparent ?? pending.msg.traceparent),
            surface: "server",
            kind: "consumer",
            attrs: {
              ...this.startDispatchTraceAttrs(pending),
              outcome: "rejected",
              terminal_reason: null,
              reason: "identity_mismatch",
              queue_state: msg.queueState,
              daemon_queue_depth: msg.queueDepth,
              daemon_queue_age_ms: msg.queueAgeMs,
            },
          }).end("ok");
          break;
        }
        this.terminalizePendingAgentStart(msg.startDispatchId, "acked", "acked", {
          queue_state: msg.queueState,
          daemon_queue_depth: msg.queueDepth,
          daemon_queue_age_ms: msg.queueAgeMs,
        });
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
          });
          break;
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

      case "agent:delivery:terminal_error": {
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
          const terminal = await mentionDeliveryOccurrenceService.recordMentionDeliveryIdentityDriftForIdentity({
            occurrenceId: msg.mentionDelivery.occurrenceId,
            agentId: msg.agentId,
            messageId: msg.mentionDelivery.messageId,
            identity: msg.mentionDelivery,
          });
          if (terminal) this.clearPendingAgentDeliveryAck({
            agentId: msg.agentId,
            seq: terminal.deliveryPayload?.seq ?? 0,
            deliveryId: msg.mentionDelivery.occurrenceId,
          });
          break;
        }
        const terminal = await mentionDeliveryOccurrenceService.recordMentionDeliveryTerminalError({
          occurrenceId: msg.mentionDelivery.occurrenceId,
          agentId: msg.agentId,
          messageId: msg.mentionDelivery.messageId,
          identity: msg.mentionDelivery,
          code: msg.code,
        });
        if (terminal) this.clearPendingAgentDeliveryAck({
          agentId: msg.agentId,
          seq: terminal.deliveryPayload?.seq ?? 0,
          deliveryId: msg.mentionDelivery.occurrenceId,
        });
        break;
      }

      case "agent:deliver:ack": {
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
        span.addEvent("server.ack.received", {
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
          break;
        }
        if (msg.mentionDelivery) {
          if (
            msg.mentionDelivery.machineId !== machineId
          ) {
            span.end("ok", { attrs: { outcome: "identity-mismatch", reason: "mention_identity_mismatch" } });
            break;
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
            });
            if (terminal) this.clearPendingAgentDeliveryAck({
              agentId: msg.agentId,
              seq: terminal.deliveryPayload?.seq ?? 0,
              deliveryId: msg.mentionDelivery.occurrenceId,
            });
            span.end("ok", { attrs: { outcome: "identity-drift", reason: "mention_identity_drift" } });
            break;
          }
          const durableAck = await mentionDeliveryOccurrenceService.recordMentionDeliveryAck({
            occurrenceId: msg.mentionDelivery.occurrenceId,
            agentId: msg.agentId,
            messageId: msg.mentionDelivery.messageId,
            identity: msg.mentionDelivery,
          });
          if (!durableAck) {
            span.end("ok", { attrs: { outcome: "durable-ack-rejected", reason: "mention_ack_not_joinable" } });
            break;
          }
        }
        const pendingCleared = this.clearPendingAgentDeliveryAck(msg);
        const ackResult = this.acknowledgeDeliveredMessages(msg.agentId, [msg.seq]);
        if (ackResult.removedCount > 0) {
          span.addEvent("inbox.cleared", {
            outcome: "cleared",
            reason: "acknowledged_seq",
            action: "clear_inbox",
            removedCount: ackResult.removedCount,
          });
          const turnActiveWrite = this.recordDeliveryAckTurnActive(msg.agentId, agent, span);
          if (turnActiveWrite) {
            const turnActiveArbitration = turnActiveWrite.arbitration;
            span.addEvent("turn_active.observed", {
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
          span.addEvent("pending_delivery.cleared", {
            outcome: "cleared",
            reason: "delivery_acknowledged",
            action: "clear_pending_delivery",
          });
        } else {
          span.addEvent("inbox.clear.noop", {
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
        try {
          const recorded = await reminderService.recordReminderArmed(
            sourceId,
            msg.agentId,
            msg.version,
          );
          this.recordBuiltInAppTrace(
            "server.app_source.receipt",
            {
              ...traceAttrs,
              machine_id: machineId,
              receipt_type: msg.type,
              outcome: recorded ? "recorded" : "not_recorded",
              ...(!recorded ? { reason: "identity_mismatch_or_missing" } : {}),
            },
            recorded ? "ok" : "error",
          );
        } catch (err) {
          this.recordBuiltInAppTrace("server.app_source.receipt", {
            ...traceAttrs,
            machine_id: machineId,
            receipt_type: msg.type,
            outcome: "record_failed",
          }, "error");
          console.error(`[Machine ${machineId}] Failed to record reminder arm ${sourceId}:`, err);
        }
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
        try {
          const recorded = await reminderService.markReminderNotArmed(
            sourceId,
            msg.agentId,
            msg.version,
          );
          this.recordBuiltInAppTrace(
            "server.app_source.receipt",
            {
              ...traceAttrs,
              machine_id: machineId,
              receipt_type: msg.type,
              outcome: recorded ? "recorded" : "not_recorded",
              reason: recorded ? msg.reason : "identity_mismatch_or_missing",
            },
            recorded ? "ok" : "error",
          );
        } catch (err) {
          this.recordBuiltInAppTrace("server.app_source.receipt", {
            ...traceAttrs,
            machine_id: machineId,
            receipt_type: msg.type,
            outcome: "record_failed",
            reason: msg.reason,
          }, "error");
          console.error(`[Machine ${machineId}] Failed to record reminder arm rejection ${sourceId}:`, err);
        }
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
            this.recordBuiltInAppTrace("server.app_source.receipt", {
              ...traceAttrs,
              machine_id: machineId,
              receipt_type: msg.type,
              outcome: "rejected",
              reason: "server_mismatch_or_missing",
            }, "error");
            console.warn(`[Machine ${machineId}] reminder.fire_receipt server mismatch or missing reminder ${sourceId}`);
            break;
          }
          if (action === "reject") {
            this.recordBuiltInAppTrace("server.app_source.receipt", {
              ...traceAttrs,
              machine_id: machineId,
              receipt_type: msg.type,
              outcome: "rejected",
              reason: "owner_or_revision_mismatch",
            }, "error");
            console.warn(`[Machine ${machineId}] reminder.fire_receipt owner mismatch for current revision ${sourceId}`);
            break;
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
            this.recordBuiltInAppTrace(
              "server.app_source.receipt",
              {
                ...traceAttrs,
                machine_id: machineId,
                receipt_type: msg.type,
                outcome: acked
                  ? "historical_ack_sent"
                  : "historical_ack_failed",
                catchup: msg.catchup,
              },
              acked ? "ok" : "error",
            );
            break;
          }
          const converged = await reminderService.getReminderById(sourceId);
          if (converged && converged.serverId === agent.serverId && converged.version > msg.version) {
            const acked = await this.sendToMachine(machineId, {
              type: "reminder.fire_receipt.ack",
              agentId: msg.agentId,
              reminderId: sourceId,
              version: msg.version,
            });
            this.recordBuiltInAppTrace(
              "server.app_source.receipt",
              {
                ...traceAttrs,
                machine_id: machineId,
                receipt_type: msg.type,
                outcome: acked ? "converged_ack_sent" : "converged_ack_failed",
                catchup: msg.catchup,
              },
              acked ? "ok" : "error",
            );
          } else {
            this.recordBuiltInAppTrace("server.app_source.receipt", {
              ...traceAttrs,
              machine_id: machineId,
              receipt_type: msg.type,
              outcome: "converged_without_ack",
              catchup: msg.catchup,
            });
          }
        } catch (err) {
          this.recordBuiltInAppTrace("server.app_source.receipt", {
            ...traceAttrs,
            machine_id: machineId,
            receipt_type: msg.type,
            outcome: "convergence_failed",
          }, "error");
          console.error(`[Machine ${machineId}] Failed to converge reminder receipt ${sourceId}:`, err);
        }
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

      case "agent:skills:list_result":
        this.observeAgentSkillsListResult(machineId, msg);
        this.emit(`machine:response:${machineId}`, msg);
        break;

      case "agent:workspace:file_tree":
      case "agent:workspace:file_content":
      case "agent:workspace:wiki_ensured":
      case "machine:workspace:scan_result":
      case "machine:workspace:delete_result":
      case "machine:migration:source_workspace_archive_result":
      case "machine:runtime_models:result":
      case "agent:diagnostic:session_transcript_result":
      case "agent:diagnostic:feedback_transcript_result":
        // These are responses to workspace/machine/diagnostic requests — emit events for pending promises
        this.emit(`machine:response:${machineId}`, msg);
        if (msg.type === "machine:runtime_models:result" || msg.type === "machine:migration:source_workspace_archive_result") {
          void this.getMachineResponseRelay().forward(machineId, msg,
            (event, attrs) => this.recordMachineResponseRelay(event, attrs));
        }
        break;
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

    this.replicaStateStore
      .refreshMachineReplica(
        machineId,
        conn.traceContext ?? buildRuntimeTraceContext(),
        conn.replicaGeneration ?? undefined,
      )
      .catch(() => {});
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
    const traceAttrs = protocolSourceTraceAttrs({
      ownerAgentId: agentId,
      sourceId: row.id,
      version: row.version,
      messageType: outgoing.type,
    });
    const agent = await agentService.getAgent(agentId, false, {
      dbCallsite: "agent_orchestrator.reminder_push",
    });
    if (!agent?.machineId) {
      this.recordBuiltInAppTrace(
        "server.app_source.transport",
        {
          ...traceAttrs,
          message_type: outgoing.type,
          outcome: "owner_offline",
        },
        "error",
      );
      return false;
    }
    const sent = await this.sendToMachine(agent.machineId, outgoing);
    this.recordBuiltInAppTrace(
      "server.app_source.transport",
      {
        ...traceAttrs,
        machine_id: agent.machineId,
        message_type: outgoing.type,
        outcome: sent ? "sent" : "send_failed",
      },
      sent ? "ok" : "error",
    );
    return sent;
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
    const traceAttrs = appConfigTraceAttrs(config);
    const agent = await agentService.getAgent(agentId, false, {
      dbCallsite: "agent_orchestrator.app_config_push",
    });
    if (!agent?.machineId) {
      this.recordBuiltInAppTrace(
        "server.app_config.transport",
        {
          ...traceAttrs,
          message_type: "app_config.upsert",
          outcome: "owner_offline",
        },
        "error",
      );
      return false;
    }
    const sent = await this.sendToMachine(agent.machineId, {
      type: "app_config.upsert",
      agentId,
      config,
    });
    this.recordBuiltInAppTrace(
      "server.app_config.transport",
      {
        ...traceAttrs,
        machine_id: agent.machineId,
        message_type: "app_config.upsert",
        outcome: sent ? "sent" : "send_failed",
      },
      sent ? "ok" : "error",
    );
    return sent;
  }

  async pushReminderCancel(agentId: string, sourceId: string, version: number): Promise<boolean> {
    const outgoing = {
      type: "reminder.cancel",
      agentId,
      reminderId: sourceId,
      version,
    } satisfies ServerToMachineMessage;
    const traceAttrs = protocolSourceTraceAttrs({
      ownerAgentId: agentId,
      sourceId,
      version,
      messageType: outgoing.type,
    });
    const agent = await agentService.getAgent(agentId, false, {
      dbCallsite: "agent_orchestrator.reminder_push",
    });
    if (!agent?.machineId) {
      this.recordBuiltInAppTrace(
        "server.app_source.transport",
        {
          ...traceAttrs,
          message_type: outgoing.type,
          outcome: "owner_offline",
        },
        "error",
      );
      return false;
    }
    const sent = await this.sendToMachine(agent.machineId, outgoing);
    this.recordBuiltInAppTrace(
      "server.app_source.transport",
      {
        ...traceAttrs,
        machine_id: agent.machineId,
        message_type: outgoing.type,
        outcome: sent ? "sent" : "send_failed",
      },
      sent ? "ok" : "error",
    );
    return sent;
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
    if (activeAgents.length === 0) return;

    const disabled = readBooleanEnv("SLOCK_DISABLE_MIGRATION_NUDGE_PIGGYBACK");
    const cooldownMs = readPositiveIntegerEnv(
      "SLOCK_MIGRATION_NUDGE_PIGGYBACK_COOLDOWN_MS",
      AgentOrchestrator.RUNTIME_PROFILE_HEARTBEAT_NUDGE_COOLDOWN_MS,
    );
    const now = this.clock.now();
    let activeAgentsCount = 0;
    let disabledCount = 0;
    let cooldownCount = 0;
    let sentCount = 0;
    let sendFailedCount = 0;
    let noCandidateCount = 0;
    let notOnlineCount = 0;

    try {
      for (const agent of activeAgents) {
        activeAgentsCount += 1;
        const action = planRuntimeProfileHeartbeatNudgeAction({
          disabled,
          lastSentAt: this.runtimeProfileHeartbeatNudgeSentAt.get(this.runtimeProfileHeartbeatNudgeKey(machineId, agent.id)) ?? null,
          now,
          cooldownMs,
        });
        if (action === "disabled") {
          disabledCount += 1;
          continue;
        }
        if (action === "cooldown") {
          cooldownCount += 1;
          continue;
        }
        const outcome = await this.maybePiggybackRuntimeProfileMigrationNudge(machineId, agent, undefined, {
          source: "heartbeat",
          nudgeIntervalMs: cooldownMs,
        });
        if (outcome === "sent") sentCount += 1;
        if (outcome === "send_failed") sendFailedCount += 1;
        if (outcome === "no_candidate") noCandidateCount += 1;
        if (outcome === "not_online") notOnlineCount += 1;
      }
      if (disabled || sentCount > 0 || sendFailedCount > 0) {
        this.tracer.startSpan("server.runtime_profile.heartbeat_nudge.scan", {
          surface: "server",
          kind: "internal",
          attrs: {
            event_kind: "runtime_profile",
            machine_id: machineId,
            machine_id_present: true,
            disabled,
            cooldown_ms: cooldownMs,
            active_agents_count: activeAgentsCount,
            disabled_count: disabledCount,
            cooldown_count: cooldownCount,
            sent_count: sentCount,
            send_failed_count: sendFailedCount,
            no_candidate_count: noCandidateCount,
            not_online_count: notOnlineCount,
          },
        }).end("ok", { attrs: { outcome: sentCount > 0 ? "sent" : "skipped", reason: disabled ? "disabled" : "scan_completed" } });
      }
    } catch (err) {
      this.tracer.startSpan("server.runtime_profile.heartbeat_nudge.scan", {
        surface: "server",
        kind: "internal",
        attrs: {
          event_kind: "runtime_profile",
          machine_id: machineId,
          machine_id_present: true,
          disabled,
          cooldown_ms: cooldownMs,
          active_agents_count: activeAgentsCount,
          disabled_count: disabledCount,
          cooldown_count: cooldownCount,
          sent_count: sentCount,
          send_failed_count: sendFailedCount,
          no_candidate_count: noCandidateCount,
          not_online_count: notOnlineCount,
          error_class: err instanceof Error ? err.name : typeof err,
        },
      }).end("error", { attrs: { outcome: "error", reason: "scan_failed" } });
      throw err;
    }
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
    let handled = false;
    try {
      handled = await agentRuntimeProfileService.markRuntimeProfileMigrationHandled(
        agentId,
        migrationKey,
        launchId || null,
      );
      if (handled) {
        await this.deliverPendingRuntimeProfileMigration(agent.machineId, agent, launchId || undefined);
      }
    } catch (err) {
      span.end("error", { attrs: { machine_id: agent.machineId, server_id: agent.serverId, outcome: "handle-failed", reason: "handle_failed", error_class: err instanceof Error ? err.name : typeof err } });
      throw err;
    }
    span.end("ok", { attrs: { machine_id: agent.machineId, server_id: agent.serverId, outcome: handled ? "handled" : "not-handled", reason: handled ? "migration_handled" : "no_matching_migration" } });
    return handled;
  }

  private async flushRuntimeProfileGatedInbox(
    machineId: string,
    agent: CachedAgentState,
  ): Promise<void> {
    const inbox = this.agentInboxes.get(agent.id);
    if (!inbox || inbox.inbox.length === 0) return;
    const oldestMessageAgeMs = oldestInboxMessageAgeMs(inbox.inbox, this.clock.now());
    const span = this.tracer.startSpan("server.runtime_profile.gated_inbox.flush", {
      surface: "server",
      kind: "producer",
      attrs: {
        event_kind: "runtime_profile",
        agent_id: agent.id,
        machine_id: machineId,
        server_id: agent.serverId,
        agent_id_present: Boolean(agent.id),
        machine_id_present: true,
        inbox_count: inbox.inbox.length,
        oldest_message_age_ms: oldestMessageAgeMs,
        oldest_message_age_bucket: durationMsBucket(oldestMessageAgeMs),
      },
    });
    let sentCount = 0;
    let sendFailedCount = 0;
    for (const message of [...inbox.inbox]) {
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
  ): Promise<boolean> {
    return routeInboxDelivery(agentId, machineId, message, localMachineIds);
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
        reroute: () => this.routeMachineCommandCrossReplica(
          machineId,
          msg,
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
        const routeResult = normalizeMachineCommandRouteResult(await context.reroute());
        context.onRouteResult?.(routeResult);
        this.traceMachineCommandRoute(context.machineId, context.msg, routeResult);
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

  private traceMachineCommandRoute(
    machineId: string,
    msg: ServerToMachineMessage,
    routeResult: MachineCommandRouteResult,
  ): void {
    const routeAttrs = projectMachineCommandRouteTraceAttrs(routeResult);
    const identityAttrs = {
      machine_id: machineId,
      ...("agentId" in msg && typeof msg.agentId === "string" ? { agent_id: msg.agentId } : {}),
    };
    const span = this.tracer.startSpan("server.machine.command.route", {
      surface: "server",
      kind: "internal",
      attrs: {
        ...identityAttrs,
        source: "sendToMachine",
        action: "route_machine_command",
        message_type: msg.type,
        ...routeAttrs,
      },
    });
    span.addEvent("machine.command.route", {
      event_kind: "machine_command_route",
      outcome: routeResult.routed ? "routed" : "not_routed",
      reason: routeResult.reason,
      ...identityAttrs,
      ...routeAttrs,
    });
    span.end("ok", {
      attrs: {
        outcome: routeResult.routed ? "routed" : "not_routed",
        reason: routeResult.reason,
        ...identityAttrs,
        ...routeAttrs,
      },
    });
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
    this.tracer.startSpan("server.agent.start_dispatch.terminal", {
      parent: parseTraceparent(pending.msg.traceparent),
      surface: "server",
      kind: "producer",
      attrs: {
        ...terminalTraceAttrs,
        outcome,
        terminal_reason: reason,
        ...extraAttrs,
      },
    }).end("ok");
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
    this.tracer.startSpan("server.agent.start_dispatch.created", {
      parent: parseTraceparent(msg.traceparent),
      surface: "server",
      kind: "producer",
      attrs: {
        ...this.startDispatchTraceAttrs(pending),
        outcome: "created",
      },
    }).end("ok");
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

  private traceInitialAgentStartAttempt(
    pending: PendingAgentStartAck,
    sent: boolean,
  ): void {
    this.tracer.startSpan("server.agent.start_dispatch.attempted", {
      parent: parseTraceparent(pending.msg.traceparent),
      surface: "server",
      kind: "producer",
      attrs: {
        ...this.startDispatchTraceAttrs(pending),
        outcome: sent ? "sent" : "send_failed",
      },
    }).end(sent ? "ok" : "error");
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
    const agent = await this.getAuthoritativeAgentForDelivery(pending.msg.agentId);
    if (!agent) {
      this.terminalizePendingAgentStart(startDispatchId, "superseded");
      return;
    }
    if (agent.machineId !== pending.machineId) {
      this.terminalizePendingAgentStart(startDispatchId, "machine_reassigned", "terminal", {
        current_machine_id_present: agent.machineId != null,
      });
      return;
    }
    if (agent.status === "stopped") {
      this.terminalizePendingAgentStart(startDispatchId, "stopped");
      return;
    }
    const cached = this.agentStateCache.get(pending.msg.agentId);
    if (
      pending.msg.launchId
      && cached?.expectedLaunchId
      && cached.expectedLaunchId !== pending.msg.launchId
    ) {
      this.terminalizePendingAgentStart(startDispatchId, "superseded");
      return;
    }
    if (pending.attempts >= AgentOrchestrator.AGENT_START_ACK_MAX_ATTEMPTS) {
      const terminal = this.terminalizePendingAgentStart(
        startDispatchId,
        "retry_exhausted",
      );
      if (terminal) {
        this.updateCache(terminal.msg.agentId, {
          status: "inactive",
          runtimeState: "not_running",
        });
        await this.persistAgentStatus(terminal.msg.agentId, "inactive");
        this.broadcastActivity(
          terminal.msg.agentId,
          "offline",
          "Start delivery could not reach the Computer",
          "runtime_unavailable",
          [],
          undefined,
          { launchId: terminal.msg.launchId },
        );
      }
      return;
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
      this.tracer.startSpan("server.agent.start_dispatch.retry", {
        parent: parseTraceparent(pending.msg.traceparent),
        surface: "server",
        kind: "producer",
        attrs: {
          ...this.startDispatchTraceAttrs(pending),
          retry_reason: reason,
          outcome: "parked",
          terminal_reason: null,
        },
      }).end("ok");
      return;
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
      this.tracer.startSpan("server.agent.start_dispatch.retry", {
        parent: parseTraceparent(pending.msg.traceparent),
        surface: "server",
        kind: "producer",
        attrs: {
          ...this.startDispatchTraceAttrs(pending),
          retry_reason: reason,
          outcome: "routed",
          terminal_reason: null,
        },
      }).end("ok");
      return;
    }
    this.scheduleAgentStartAckTimeout(pending);
    this.tracer.startSpan("server.agent.start_dispatch.retry", {
      parent: parseTraceparent(pending.msg.traceparent),
      surface: "server",
      kind: "producer",
      attrs: {
        ...this.startDispatchTraceAttrs(pending),
        retry_reason: reason,
        outcome: sent ? "replayed" : "scheduled",
        terminal_reason: null,
      },
    }).end("ok");
  }

  private async sendAgentStartWithAckRetry(
    machineId: string,
    msg: AgentStartMessage & { startDispatchId: string },
  ): Promise<boolean> {
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
    if (pending) this.traceInitialAgentStartAttempt(pending, sent);
    return sent;
  }

  private sendLocalAgentStartWithAckRetry(
    machineId: string,
    msg: AgentStartMessage & { startDispatchId: string },
  ): boolean {
    this.trackPendingAgentStart(machineId, msg);
    const sent = this.sendToLocalMachine(machineId, msg);
    const pending = this.pendingAgentStartAcks.get(msg.startDispatchId);
    if (sent && pending) {
      pending.attempts += 1;
      pending.lastAttemptAt = this.clock.now();
    }
    if (pending) this.traceInitialAgentStartAttempt(pending, sent);
    return sent;
  }

  private agentDeliveryAckKey(msg: Pick<Extract<ServerToMachineMessage, { type: "agent:deliver" }>, "agentId" | "seq" | "deliveryId">): string {
    return msg.deliveryId ? `delivery:${msg.deliveryId}` : `seq:${msg.agentId}:${msg.seq}`;
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
      if (scheduleTimeout) {
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
    };
    this.pendingAgentDeliveryAcks.set(key, pending);
    if (scheduleTimeout) {
      this.scheduleAgentDeliveryAckTimeout(key, pending);
    }
  }

  private scheduleAgentDeliveryAckTimeout(key: string, pending: PendingAgentDeliveryAck): void {
    if (pending.timer) {
      this.clock.clearTimeout(pending.timer);
    }
    pending.timer = this.scheduleOnClock(() => {
      void this.retryPendingAgentDelivery(key, "ack_timeout");
    }, AgentOrchestrator.AGENT_DELIVERY_ACK_TIMEOUT_MS);
    const timerWithUnref = pending.timer as { unref?: () => void } | null;
    timerWithUnref?.unref?.();
  }

  private clearPendingAgentDeliveryAck(msg: Pick<Extract<MachineToServerMessage, { type: "agent:deliver:ack" }>, "agentId" | "seq" | "deliveryId">): boolean {
    const key = this.findAgentDeliveryAckKey(msg.agentId, msg.seq, msg.deliveryId);
    if (!key) return false;
    const pending = this.pendingAgentDeliveryAcks.get(key);
    if (pending?.timer) this.clock.clearTimeout(pending.timer);
    return this.pendingAgentDeliveryAcks.delete(key);
  }

  private clearPendingAgentDeliveryAcksForAgent(agentId: string): number {
    let cleared = 0;
    for (const [key, pending] of [...this.pendingAgentDeliveryAcks.entries()]) {
      if (pending.msg.agentId !== agentId) continue;
      if (pending.timer) this.clock.clearTimeout(pending.timer);
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
          await mentionDeliveryOccurrenceService.recordMentionDeliveryIdentityDrift(row.occurrenceId);
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

  private parkPendingAgentDeliveryAck(
    pending: PendingAgentDeliveryAck,
    reason: "machine_offline",
  ): void {
    if (pending.timer) {
      this.clock.clearTimeout(pending.timer);
      pending.timer = null;
    }
    pending.parked = true;
    pending.parkedReason = reason;
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
      );
      return {
        allowed: false,
        reason: "mention_identity_drift",
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

  private async retryPendingAgentDelivery(key: string, reason: "ack_timeout" | "ready_reconcile" | "register"): Promise<void> {
    const pending = this.pendingAgentDeliveryAcks.get(key);
    if (!pending) return;
    if (pending.parked && reason === "ack_timeout") {
      return;
    }
    if (pending.attempts >= AgentOrchestrator.AGENT_DELIVERY_ACK_MAX_ATTEMPTS) {
      if (pending.timer) this.clock.clearTimeout(pending.timer);
      this.pendingAgentDeliveryAcks.delete(key);
      const ownerTraceAttrs = await this.getMachineOwnerTraceAttrs(pending.machineId);
      this.tracer.startSpan("server.agent.delivery.retry", {
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
          first_attempt_age_ms: this.clock.now() - pending.firstAttemptAt,
          outcome: "gave_up",
          reason: "ack_retry_exhausted",
          ...ownerTraceAttrs,
        },
      }).end("ok");
      return;
    }

    const localAtRetry = this.hasMachineLocally(pending.machineId);
    const ownerTraceAttrs = await this.getMachineOwnerTraceAttrs(pending.machineId);
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
    try {
      const gate = await this.loadPendingAgentDeliveryRetryGate(pending);
      span.addEvent("server.delivery.retry.gate", {
        outcome: gate.allowed ? "allowed" : "dropped",
        reason: gate.reason,
        wake_action: gate.wakeAction,
        current_status: gate.currentStatus,
        current_machine_id_present: gate.currentMachineId != null,
        machine_matches: gate.currentMachineId === pending.machineId,
      });
      if (!gate.allowed) {
        if (pending.timer) this.clock.clearTimeout(pending.timer);
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
      span.addEvent("server.delivery.retry.machine_status", {
        machine_status: machineStatus,
        retry_reason: reason,
      });
      if (machineStatus === "offline") {
        this.parkPendingAgentDeliveryAck(pending, "machine_offline");
        span.end("ok", {
          attrs: {
            outcome: "parked",
            reason: "machine_offline",
            wake_action: gate.wakeAction,
            current_status: gate.currentStatus,
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
      span.addEvent("server.delivery.retry.sent", {
        outcome: sent ? "sent" : "not_sent",
        reason: sent ? (localAtRetry ? "local_socket_present" : "routed_to_owner") : "machine_unreachable",
        deliveryId: pending.msg.deliveryId,
        seq: pending.msg.seq,
        ...deliveryTraceAttrs,
      });
      if (sent && !localAtRetry) {
        if (pending.timer) this.clock.clearTimeout(pending.timer);
        this.pendingAgentDeliveryAcks.delete(key);
        span.end("ok", { attrs: { outcome: "routed", reason: "routed_to_owner", ...deliveryTraceAttrs } });
        return;
      }
      this.scheduleAgentDeliveryAckTimeout(key, pending);
      span.end("ok", { attrs: { outcome: sent ? "resent" : "scheduled", reason: sent ? "local_retry_sent" : "machine_unreachable", ...deliveryTraceAttrs } });
    } catch (err) {
      this.scheduleAgentDeliveryAckTimeout(key, pending);
      span.end("error", { attrs: { outcome: "scheduled", reason: "retry_error", error_class: err instanceof Error ? err.name : typeof err } });
      console.warn(`[Machine ${pending.machineId}] agent delivery retry failed for ${pending.msg.agentId}:`, err);
    }
  }

  protected async sendAgentDeliveryWithAckRetry(
    machineId: string,
    msg: Extract<ServerToMachineMessage, { type: "agent:deliver" }>,
    errorContext: string,
  ): Promise<boolean> {
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
      () => this.handleLocalRoutedMachineCommand(machineId, msg),
      async () => normalizeMachineCommandRouteResult(
        await this.routeMachineCommandCrossReplica(machineId, msg, localMachineIds),
      ).routed,
      () => false,
    );
  }

  private async handleLocalRoutedMachineCommand(machineId: string, msg: ServerToMachineMessage): Promise<boolean> {
    if (
      (msg.type === "agent:start" || msg.type === "agent:start:wiki")
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

  async handleRoutedInboxDelivery(agentId: string, machineId: string | null, message: AgentMessage): Promise<boolean> {
    const agent = await this.getCachedAgent(agentId);
    if (!agent || agent.status !== "active" || !agent.machineId) {
      return true;
    }
    if (!await this.canAgentAccessDeliveryTarget(agentId, agent, message)) {
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
      () => this.routeInboxDeliveryCrossReplica(agentId, targetMachineId, message, localMachineIds),
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

  protected async canAgentAccessDeliveryTarget(agentId: string, agent: CachedAgentState, message: AgentMessage): Promise<boolean> {
    if (message.third_party_event) return true;
    try {
      const channel = await channelService.getChannel(message.channel_id);
      if (!channel || channel.serverId !== agent.serverId) {
        return false;
      }
      return channelService.canAgentAccessChannel(message.channel_id, agentId);
    } catch (error) {
      console.warn(`[Agent ${agentId}] Dropping delivery for ${message.channel_id}: target visibility check failed`, error);
      return false;
    }
  }

  /**
   * Validate that an incoming machine-originated agent event actually belongs to
   * the machine/server that sent it. This prevents a buggy or compromised daemon
   * from overwriting another agent's activity/status/trajectory.
   */
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

  protected async loadAgentForStart(agentId: string) {
    return agentService.getAgent(agentId, false, {
      dbCallsite: "agent_orchestrator.start",
    });
  }

  protected async resetPersistedAgentSession(agentId: string, status: AgentStatus = "inactive") {
    await agentService.resetAgentSession(agentId, status);
  }

  private broadcastAgentSession(serverId: string, agentId: string, sessionId: string | null) {
    this.io?.to(`server:${serverId}`).emit("agent:session", { agentId, sessionId });
  }

  private releaseWakeLock(agentId: string) {
    if (!this.replicaStateStore.isAvailable()) return;
    this.replicaStateStore.releaseWakeLock(agentId).catch(() => {});
  }

  private clearAgentInbox(agentId: string): boolean {
    const inbox = this.agentInboxes.get(agentId);
    let resolvedPendingReceive = false;
    if (inbox?.pendingReceive) {
      clearTimeout(inbox.pendingReceive.timer);
      inbox.pendingReceive.resolve([]);
      resolvedPendingReceive = true;
    }
    this.agentInboxes.delete(agentId);
    return resolvedPendingReceive;
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

  private async loadWakePlanInput(
    agentId: string,
    status: AgentStatus,
    options: { migrationProtocol?: boolean } = {},
  ): Promise<WakePlanInput> {
    // TODO(lifecycle-v2/state-snapshot): delivery wake planning currently
    // builds a minimal in-memory state from DB status, reset state, and
    // runtime-profile gate. If machine reachability becomes authoritative for
    // delivery wake decisions, extend this builder to read the machine owner/
    // connection state instead of leaving reachability as "unknown".
    const migrationGateStatus: agentMigrationService.AgentMigrationGateStatus = options.migrationProtocol
      ? { migration: null }
      : await agentMigrationService.getAgentMigrationGateStatus(agentId);
    const controlGate = migrationGateStatus.migration
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
    if (migrationGateStatus.expiredLifecycleEvent) {
      const span = this.tracer.startSpan("server.agent.migration.deadline_expired", {
        surface: "server",
        kind: "internal",
        attrs: {
          agent_id_present: Boolean(agentId),
          migration_event_type: migrationGateStatus.expiredLifecycleEvent.eventType,
          control_gate: state.controlGate,
        },
      });
      try {
        await applyAgentLifecycleProjectionPlan(
          reduceAgentMigrationControlLifecycle({
            event: migrationGateStatus.expiredLifecycleEvent,
            state,
          }),
          this.lifecycleProjectionWriterDeps(),
          span,
        );
        span.end("ok");
      } catch (err) {
        span.end("error", { attrs: { error_class: err instanceof Error ? err.name : typeof err } });
      }
    }
    return { state };
  }

  async startAgent(agentId: string, options: StartAgentOptions = {}): Promise<AgentStartDispatchResult> {
    const { resumePrompt, wakeMessage, wakeMessageTransient } = options;
    // Load from DB (and populate cache) for start — need full state
    const agent = await this.loadAgentForStart(agentId);
    const startCause = wakeMessage ? "message" : resumePrompt ? "resume" : "manual";
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
    if (wakeMessage && previousStatus === "stopped") {
      this.updateCache(agentId, { status: "stopped" });
      this.recordLifecycleEvent({
        agentId,
        machineId: agent.machineId,
        action: "wake",
        outcome: "suppressed",
        cause: "message",
        previousStatus,
      });
      return { outcome: "skipped", reason: "manual_stop" };
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
    const wikiWorkspaceConfigured = (
      launchRuntimeFields.envVars?.[WIKI_AGENT_WORKSPACE_ENV] || ""
    ).trim().toLowerCase() === WIKI_AGENT_WORKSPACE_ENABLED;

    // Catalog preflight and generation lease are both before wake locks,
    // cache/status mutation, credentials/session work, and spawn dispatch.
    const catalogValidation = await this.validateBuiltInPresetForMachine(
      agent.machineId,
      normalizedRuntimeConfig,
    );
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

    // Populate/refresh cache
    const state: CachedAgentState = {
      id: agent.id,
      status: "active",
      machineId: agent.machineId,
      sessionId: agent.sessionId,
      expectedLaunchId: null,
      launchGuardMode: "legacy",
      serverId: agent.serverId,
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

    const machine = agent.machineId ? await this.loadRuntimeContextMachine(asMachineId(agent.machineId)) : null;
    const daemonVersion = agent.machineId ? this.getMachineDaemonVersion(agent.machineId) : null;
    const config: AgentConfig = {
      name: agent.name,
      displayName: agent.displayName,
      description: agent.description,
      model: launchRuntimeFields.model,
      runtime: launchRuntimeFields.runtime,
      runtimeConfig: normalizedRuntimeConfig,
      reasoningEffort: launchRuntimeFields.reasoningEffort,
      executionMode: agent.executionMode,
      envVars: launchRuntimeFields.envVars,
      sessionId: agent.sessionId,
      serverUrl: process.env.SERVER_URL || `http://localhost:${process.env.PORT || 3001}`,
      authToken: "", // Daemon will use its own API key
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
    const runtimeProfileControl = await agentRuntimeProfileService.getPendingRuntimeProfileControl(agentId);
    if (runtimeProfileControl) {
      config.runtimeProfileControl = runtimeProfileControl;
    }

    // Query unread rows so resume can deterministically re-drive durable
    // messages that arrived while a manual-stopped/sessioned agent was offline.
    let unreadSummary: Record<string, number> | undefined;
    let resumeMessages: AgentMessage[] | undefined;
    if (agent.sessionId) {
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
        const plan = await getServerPlan(agent.serverId);
        const historyCutoff = getHistoryCutoff(plan);
        const counts = await channelService.getAgentUnreadCounts(agentId, historyCutoff);
        if (Object.keys(counts).length > 0) unreadSummary = counts;
        if (!wakeMessage && !resumePrompt) {
          const catchup = await messageService.getAgentResumeCatchupMessages(agentId, historyCutoff);
          if (catchup.messages.length > 0) resumeMessages = catchup.messages;
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
      } catch (err) {
        span.addEvent("resume_catchup.failed", {
          outcome: "failed",
          reason: "query_failed",
          error_type: err instanceof Error ? err.name : typeof err,
        });
        span.end("error", {
          attrs: {
            outcome: "failed",
            reason: "query_failed",
            error_class: err instanceof Error ? err.name : typeof err,
          },
        });
      }
    }

    // Only set launch guard if the daemon supports it (>= 0.30.1).
    // Old daemons ignore the launchId field and never echo it back,
    // which causes all their lifecycle events to be silently dropped.
    const launchId = this.prepareStartLaunchGuard(agentId, agent.machineId);
    const startDispatchId = crypto.randomUUID();
    const startDispatchSpan = this.tracer.startSpan("server.agent.start_dispatch", {
      surface: "server",
      kind: "producer",
      attrs: {
        agent_id: agentId,
        machine_id: agent.machineId,
        launch_id: launchId,
        start_dispatch_id: startDispatchId,
        start_cause: startCause,
      },
    });
    const startFields = {
      agentId,
      config,
      wakeMessage,
      wakeMessageTransient: wakeMessage ? wakeMessageTransient : undefined,
      ...(resumeMessages ? { resumeMessages } : {}),
      unreadSummary,
      resumePrompt,
      launchId,
      startDispatchId,
      traceparent: formatTraceparent(startDispatchSpan.context),
    };
    const startMessage: ServerToMachineMessage = wikiWorkspaceConfigured
      ? {
        type: "agent:start:wiki",
        wikiWorkspacePack: WIKI_AGENT_WORKSPACE_PACK,
        ...startFields,
      }
      : {
        type: "agent:start",
        ...startFields,
      };
    try {
      if (options.requireQueueReceipt) {
        // Strict manual Notify cannot publish cross-replica without a target-side
        // queue acknowledgement. Fail before publishing so a retry cannot wake
        // a remote daemon twice after the source reports `dropped`.
        if (!this.sendLocalAgentStartWithAckRetry(
          agent.machineId,
          startMessage as AgentStartMessage & { startDispatchId: string },
        )) {
          throw new CrossReplicaQueueReceiptUnavailableError();
        }
      } else {
        if (!await this.sendAgentStartWithAckRetry(
          agent.machineId,
          startMessage as AgentStartMessage & { startDispatchId: string },
        )) {
          throw new RouteFailureError(
            "daemon_offline",
            "Machine offline. Please start your local daemon.",
          );
        }
      }
      startDispatchSpan.end("ok", {
        attrs: {
          outcome: "sent",
          queue_depth: this.pendingStartQueueDepth(agent.machineId),
        },
      });
    } catch (err) {
      startDispatchSpan.end("error", {
        attrs: {
          outcome: "send_failed",
          error_class: err instanceof Error ? err.name : typeof err,
        },
      });
      this.terminalizePendingAgentStart(startDispatchId, "superseded");
      this.updateCache(agentId, { status: rollbackStatus });
      this.rollbackStartLaunchGuard(agentId, launchId);
      if (wakeLockHeld) this.releaseWakeLock(agentId);
      this.recordLifecycleEvent({
        agentId,
        machineId: agent.machineId,
        action: "start",
        outcome: "failed",
        cause: startCause,
        previousStatus,
        detail: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    this.advanceActivityIngestEpoch(agentId);

    // Init inbox
    if (!this.agentInboxes.has(agentId)) {
      this.agentInboxes.set(agentId, { inbox: [], pendingReceive: null });
    }

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
    } catch (err) {
      span.end("error", { attrs: { error_class: err instanceof Error ? err.name : typeof err } });
      throw err;
    }
    return { outcome: "dispatched" };
    } finally {
      releaseCatalogAuthority();
    }
  }

  async stopAgent(agentId: string, reason: StopAgentReason = "manual") {
    const agent = await this.getCachedAgent(agentId);
    if (!agent) return;
    const previousStatus = agent.status;
    const action = planStopAction({ reason });
    const nextStatus: AgentStatus = action === "persist-stopped" ? "stopped" : "inactive";
    const context: StopApplyContext = {
      agentId,
      serverId: agent.serverId,
      machineId: agent.machineId,
      reason,
      previousStatus,
      nextStatus,
    };

    await this.applyStopAction(context);
  }

  protected async applyStopAction(context: StopApplyContext) {
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
        this.lifecycleProjectionWriterDeps(),
        span,
      );
      if (context.reason === "manual") {
        await this.clearLastRuntimeError(context.agentId);
      }
      if (context.reason === "internal") {
        const nextIngestEpoch = this.advanceActivityIngestEpoch(context.agentId);
        span.addEvent("activity.ingest.rebaseline", {
          reason: "internal_stop",
          activity_ingest_epoch: nextIngestEpoch,
        });
      }
      const clearedPendingDeliveries = this.clearPendingAgentDeliveryAcksForAgent(context.agentId);
      if (clearedPendingDeliveries > 0) {
        span.addEvent("server.delivery.retry.cleared", {
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
        span.addEvent("server.start_dispatch.cleared", {
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
    } catch (err) {
      span.end("error", { attrs: { error_class: err instanceof Error ? err.name : typeof err } });
      throw err;
    }
  }

  async resetAgent(
    agentId: string,
    mode: "restart" | "session" | "full",
    options: { restartEvenIfInactive?: boolean; restartIfStopped?: boolean } = {},
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
        mode,
        previousStatus,
        machineId: agentBefore?.machineId ?? null,
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
      await this.stopAgent(context.agentId, "internal");
    }

    if (plan.includes("clear-session")) {
      const resetStatus = context.previousStatus === "stopped" ? "stopped" : "inactive";
      await this.resetPersistedAgentSession(context.agentId, resetStatus);
      this.updateCache(context.agentId, { sessionId: null, status: resetStatus });
      if (context.serverId) {
        this.broadcastAgentSession(context.serverId, context.agentId, null);
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
      await this.startAgent(context.agentId);
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

  async getAgentDaemonVersion(agentId: string): Promise<string | null> {
    const result = await this.getMachineForAgent(agentId);
    return result?.conn.daemonVersion ?? null;
  }

  async agentSupportsWikiWorkspacePack(agentId: string): Promise<boolean> {
    const result = await this.getMachineForAgent(agentId);
    return result?.conn.capabilities.has(WIKI_WORKSPACE_PACK_CAPABILITY) === true;
  }

  async ensureWikiAgentWorkspace(agentId: string): Promise<WikiWorkspaceEnsureReceipt> {
    const result = await this.getMachineForAgent(agentId);
    if (!result) throw new Error("Wiki Agent has no connected Computer");
    const { machineId } = result;
    const requestId = crypto.randomUUID();
    return new Promise(async (resolve, reject) => {
      const timeout = this.scheduleOnClock(() => {
        this.removeListener(`machine:response:${machineId}`, handler);
        reject(new Error("Wiki workspace ensure request timed out"));
      }, 15_000);

      const handler = (msg: MachineToServerMessage) => {
        if (
          msg.type !== "agent:workspace:wiki_ensured"
          || msg.agentId !== agentId
          || msg.requestId !== requestId
        ) {
          return;
        }
        this.clock.clearTimeout(timeout);
        this.removeListener(`machine:response:${machineId}`, handler);
        if (!msg.success) {
          reject(new Error(msg.error || "Wiki workspace ensure failed"));
          return;
        }
        const receipt = { agentId, packId: msg.packId, files: msg.files };
        if (!isCompleteWikiWorkspaceEnsureReceipt(receipt, agentId, WIKI_AGENT_WORKSPACE_PACK)) {
          reject(new Error("Wiki workspace ensure returned an incomplete receipt"));
          return;
        }
        resolve(receipt);
      };

      this.on(`machine:response:${machineId}`, handler);
      try {
        await this.sendRequiredToMachine(machineId, {
          type: "agent:workspace:ensure-wiki",
          agentId,
          requestId,
          pack: WIKI_AGENT_WORKSPACE_PACK,
        });
      } catch {
        this.clock.clearTimeout(timeout);
        this.removeListener(`machine:response:${machineId}`, handler);
        reject(new Error("Failed to send Wiki workspace ensure request — Computer is not ready"));
      }
    });
  }

  async getAgentFileTree(agentId: string, dirPath?: string, includeHidden = false): Promise<FileNode[]> {
    const result = await this.getMachineForAgent(agentId);
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

  async detectMachineRuntimeModels(machineId: string, runtime: string): Promise<RuntimeModelSourceOutcome> {
    // Plain model discovery does not consume connection-generation authority.
    // Built-in admission continues to use the local, fenced WithAuthority path.
    if (!this.machineConnections.has(machineId)) {
      const requestId = crypto.randomUUID();
      const response = await this.getMachineResponseRelay().request({
        requestId, machineId, type: "machine:runtime_models:result",
      }, 5_000, () => this.sendRequiredToMachine(machineId, {
        type: "machine:runtime_models:detect", requestId, runtime,
      }), (event, attrs) => this.recordMachineResponseRelay(event, attrs));
      if (response.type !== "machine:runtime_models:result") throw new Error("Unexpected model response");
      return projectRuntimeModelSourceResult(response, runtime);
    }
    return (
      await this.detectMachineRuntimeModelsWithAuthority(machineId, runtime)
    ).outcome;
  }

  async detectMachineRuntimeModelsWithAuthority(
    machineId: string,
    runtime: string,
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
      }, 5_000);

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
        await this.sendRequiredToMachine(machineId, { type: "machine:runtime_models:detect", requestId, runtime });
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
    if (
      config.runtime !== "builtin" ||
      config.provider.kind !== "preset" ||
      config.model.kind !== "preset"
    )
      return null;
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
          requestedModel: config.model.id,
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

  async readAgentFile(agentId: string, filePath: string): Promise<{ content: string | null; binary: boolean; size: number; mimeType?: string; encoding?: "utf-8" | "base64" }> {
    const result = await this.getMachineForAgent(agentId);
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

  private traceAgentSkillsListRequest(outcome: string, attrs: Record<string, unknown>, status: "ok" | "error" = "ok"): void {
    this.tracer.startSpan("server.agent.skills.list", {
      surface: "server",
      kind: "internal",
      attrs: {
        outcome,
        ...attrs,
      },
    }).end(status);
  }

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

    if (msg.requestId) {
      const pending = this.pendingAgentSkillsListRequests.get(msg.requestId);
      if (!pending) {
        this.traceAgentSkillsListRequest("unmatched_request_id", {
          ...baseAttrs,
          request_id: msg.requestId,
        });
        return;
      }

      if (pending.agentId !== msg.agentId) {
        this.traceAgentSkillsListRequest("wrong_agent_for_request_id", {
          ...baseAttrs,
          request_id: msg.requestId,
          expected_agent_id: pending.agentId,
          runtime: pending.runtime,
          duration_ms: Math.max(0, this.clock.now() - pending.startedAtMs),
        }, "error");
        return;
      }

      if (pending.machineId !== machineId) {
        this.traceAgentSkillsListRequest("wrong_machine_for_request_id", {
          ...baseAttrs,
          request_id: msg.requestId,
          expected_machine_id: pending.machineId,
          runtime: pending.runtime,
          duration_ms: Math.max(0, this.clock.now() - pending.startedAtMs),
        }, "error");
        return;
      }

      this.traceAgentSkillsListRequest(pending.timedOut ? "late_after_timeout" : "result_before_timeout", {
        ...baseAttrs,
        request_id: msg.requestId,
        runtime: pending.runtime,
        duration_ms: Math.max(0, this.clock.now() - pending.startedAtMs),
      });
      return;
    }

    const matchingPending = this.countMatchingLegacyAgentSkillsPending(machineId, msg.agentId);

    if (matchingPending.activeCount > 0) {
      this.traceAgentSkillsListRequest(matchingPending.activeCount === 1 ? "legacy_unscoped_result" : "legacy_ambiguous_result", {
        ...baseAttrs,
        matching_pending_count: matchingPending.activeCount,
        retained_timeout_count: matchingPending.retainedTimeoutCount,
      }, matchingPending.activeCount === 1 ? "ok" : "error");
      return;
    }

    if (matchingPending.retainedTimeoutCount > 0) {
      this.traceAgentSkillsListRequest("legacy_late_after_timeout", {
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
        this.traceAgentSkillsListRequest("timeout", {
          agent_id: agentId,
          machine_id: machineId,
          runtime: pending.runtime,
          request_id: requestId,
          timeout_ms: AgentOrchestrator.AGENT_SKILLS_LIST_TIMEOUT_MS,
        }, "error");
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
        resolve({ global: msg.global, workspace: msg.workspace });
      };

      const disconnectHandler = (context: MachineDisconnectContext = {}) => {
        if (settled) return;
        settled = true;
        this.traceAgentSkillsListRequest("disconnected_before_result", {
          agent_id: agentId,
          machine_id: machineId,
          runtime: pending.runtime,
          request_id: requestId,
          duration_ms: Math.max(0, this.clock.now() - startedAtMs),
          disconnect_cause: context.cause || "socket_close",
        }, "error");
        cleanup();
        reject(new RouteFailureError("daemon_offline", "Machine disconnected while listing skills"));
      };

      this.pendingAgentSkillsListRequests.set(requestId, pending);
      this.on(eventName, handler);
      this.on(disconnectEventName, disconnectHandler);

      try {
        await this.sendRequiredToMachine(machineId, { type: "agent:skills:list", agentId, runtime, requestId });
      } catch {
        if (settled) return;
        settled = true;
        cleanup();
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
  ): Promise<{
    traceBundleId?: string;
    reachable: boolean;
    fallbackReason?: string;
    error?: string;
    transcriptWindow?: FeedbackTranscriptWindow;
  }> {
    const result = await this.getMachineForAgent(agentId);
    if (!result) throw new Error("Agent has no connected machine");
    const { machineId } = result;

    const requestId = crypto.randomUUID();

    return new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeListener(`machine:response:${machineId}`, handler);
        reject(new Error("Feedback transcript request timed out"));
      }, 30_000);

      const handler = (msg: MachineToServerMessage) => {
        if (msg.type === "agent:diagnostic:feedback_transcript_result" && msg.agentId === agentId && msg.feedbackReportId === feedbackReportId && msg.requestId === requestId) {
          clearTimeout(timeout);
          this.removeListener(`machine:response:${machineId}`, handler);
          resolve({
            traceBundleId: msg.traceBundleId,
            reachable: msg.reachable,
            fallbackReason: msg.fallbackReason,
            error: msg.error,
            transcriptWindow: msg.transcriptWindow,
          });
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
        });
      } catch {
        clearTimeout(timeout);
        this.removeListener(`machine:response:${machineId}`, handler);
        reject(new Error("Failed to send request — machine WebSocket not ready"));
      }
    });
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
        reject(new Error("Delete timed out"));
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

  async deliverMessage(
    agentId: string,
    message: AgentMessage,
    options: DeliverMessageOptions = {},
  ): Promise<AgentMessageDeliveryResult> {
    const agent = await this.getAuthoritativeAgentForDelivery(agentId);
    if (!agent) return { status: "dropped", reason: "agent_unavailable" };
    const requireQueueReceipt = options.requireQueueReceipt === true
      || options.reconcileNonMemberMention === true;
    // Passive scope gate — see DeliverMessageOptions.intrinsic. We drop rather
    // than enqueue and return a typed receipt to the caller: a revoked agent
    // should not see historical channel traffic when the scope is later restored. The
    // server-side audit trail lives on the scope toggle itself
    // (revision + updatedAt + updatedByUserId on `agent_scopes`).
    if (!options.intrinsic && !options.adminAuthority) {
      const allowed = await this.hasPassiveDeliveryScope(agentId).catch(() => false);
      if (!allowed) return { status: "dropped", reason: "passive_scope_revoked" };
    }
    if (!options.intrinsic && !await this.canAgentAccessDeliveryTarget(agentId, agent, message)) {
      return { status: "dropped", reason: "target_access_changed" };
    }
    if (requireQueueReceipt && agent.machineId) {
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
      this.reconcileQueuedNonMemberMention(agentId, message);
    }
    // External agents are supplied/observed, never Slock-launched
    // (SHA-V0-006C): there is no managed wake path for them. Buffer the
    // delivery in the local inbox so the step1 bridge's content-free
    // `/wake-hints` peek can surface it (rfcs/035 D7) and the runtime drains
    // bodies via its own direct `message check`. Transient synthetic
    // messages (e.g. reminder fire) have no ackable `seq` and would pin the
    // inbox forever — drop them, same rule as the control-gate path below.
    if (isExternalAgentRuntime(agent.runtime)) {
      if (!options.transient) {
        this.deliverToLocalInbox(agentId, message, { notifyPendingReceive: false });
        // Wake the agent's SSE wake-hint stream subscribers (D7 T1, task
        // #72). Content-free signal only: listeners re-peek the inbox and
        // build hints themselves — nothing here drains or advances cursors.
        this.emit("external-inbox-delivered", agentId);
        // Option C (#wg-external-agent 2026-06-11): the emit above is
        // process-local, but the agent's SSE stream may be connected to
        // another replica. Broadcast a content-free signal so that replica's
        // stream flushes immediately (its flush re-audits durable truth, so
        // duplicates/loss are harmless); the heartbeat peek stays the floor.
        void this.publishExternalWakeSignalCrossReplica(agentId);
        return { status: "queued", reason: "external_inbox" };
      }
      return { status: "dropped", reason: "transient_delivery_unsupported" };
    }
    const wakeInput = await this.loadWakePlanInput(agentId, agent.status, {
      migrationProtocol: options.migrationProtocol ?? false,
    });
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
      await mentionDeliveryOccurrenceService.recordMentionDeliveryIdentityDrift(row.occurrenceId);
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
      span.end("error", { attrs: { error_class: err instanceof Error ? err.name : typeof err } });
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
        if (startResult.reason === "manual_stop") {
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
    let inbox = this.agentInboxes.get(agentId);
    if (!inbox) {
      inbox = { inbox: [], pendingReceive: null };
      this.agentInboxes.set(agentId, inbox);
    }

    if (
      options.reconcileNonMemberMention === true
      && this.reconcileQueuedNonMemberMention(agentId, message)
    ) {
      return;
    }

    const action = planLocalInboxEnqueueAction({
      hasSeqDuplicate: Boolean(message.seq && inbox.inbox.some((queued) => queued.seq === message.seq)),
      hasMessageIdDuplicate: Boolean(!message.seq && message.message_id && inbox.inbox.some((queued) => queued.message_id === message.message_id)),
    });
    if (action === "enqueue") {
      this.applyLocalInboxEnqueue({
        inbox,
        message,
        notifyPendingReceive: options.notifyPendingReceive ?? true,
      });
    }
  }

  private reconcileQueuedNonMemberMention(agentId: string, message: AgentMessage): boolean {
    const inbox = this.agentInboxes.get(agentId);
    if (!inbox || !message.seq || message.non_member_mention === true) return false;

    const duplicateIndex = inbox.inbox.findIndex((queued) => queued.seq === message.seq);
    if (duplicateIndex < 0 || inbox.inbox[duplicateIndex]?.non_member_mention !== true) return false;
    inbox.inbox[duplicateIndex] = message;
    return true;
  }

  protected applyLocalInboxEnqueue(context: LocalInboxApplyContext) {
    context.inbox.inbox.push(context.message);
    if (context.inbox.inbox.length > 1000) {
      context.inbox.inbox.shift();
    }

    if (context.notifyPendingReceive !== false && context.inbox.pendingReceive) {
      clearTimeout(context.inbox.pendingReceive.timer);
      context.inbox.pendingReceive.resolve([...context.inbox.inbox]);
      context.inbox.pendingReceive = null;
    }
  }

  async receiveMessages(agentId: string, block: boolean, timeoutMs: number, signal?: AbortSignal): Promise<AgentMessage[]> {
    if (await agentRuntimeProfileService.isRuntimeProfileMigrationGated(agentId)) {
      const agent = await this.getCachedAgent(agentId);
      const inbox = this.agentInboxes.get(agentId);
      const pendingMigration = await agentRuntimeProfileService.getPendingRuntimeProfileMigration(agentId);
      const oldestMessageAgeMs = oldestInboxMessageAgeMs(inbox?.inbox ?? [], this.clock.now());
      const pendingAgeMs = pendingMigration?.migratingSince
        ? Math.max(0, this.clock.now() - pendingMigration.migratingSince.getTime())
        : undefined;
      const span = this.tracer.startSpan("server.runtime_profile.gated_inbox.receive_blocked", {
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
          inbox_count: inbox?.inbox.length ?? 0,
          pending_receive_present: Boolean(inbox?.pendingReceive),
          oldest_message_age_ms: oldestMessageAgeMs,
          oldest_message_age_bucket: durationMsBucket(oldestMessageAgeMs),
          block,
          timeout_ms: timeoutMs,
        },
      });
      try {
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
      } catch (err) {
        span.end("error", {
          attrs: {
            outcome: "nudge_failed",
            reason: "nudge_failed",
            error_class: err instanceof Error ? err.name : typeof err,
          },
        });
        throw err;
      }
      span.end("ok", { attrs: { outcome: "gated_by_runtime_profile_migration", reason: "runtime_profile_migration_gate" } });
      return [];
    }
    let inbox = this.agentInboxes.get(agentId);
    if (!inbox) {
      inbox = { inbox: [], pendingReceive: null };
      this.agentInboxes.set(agentId, inbox);
    }

    const action = planReceiveAction({
      hasBufferedMessages: inbox.inbox.length > 0,
      block,
    });

    if (action === "return-buffered") {
      return Promise.resolve([...inbox.inbox]);
    }

    if (action === "return-empty") return Promise.resolve([]);
    return this.installReceiveWaiter({
      agentId,
      timeoutMs,
      signal,
    });
  }

  /**
   * Content-free bridge wake hints must be a peek, not a receive/drain.
   * This returns a copy of the current volatile server inbox without installing
   * a pending receive waiter and without acknowledging delivery.
   */
  peekPendingMessages(agentId: string): AgentMessage[] {
    const inbox = this.agentInboxes.get(agentId);
    return inbox ? [...inbox.inbox] : [];
  }

  protected installReceiveWaiter(context: ReceiveApplyContext): Promise<AgentMessage[]> {
    return new Promise((resolve) => {
      let finished = false;
      let timer: ReturnType<typeof setTimeout>;
      let cleanupAbortListener = () => {};

      const finish = (messages: AgentMessage[]) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        cleanupAbortListener();
        const ib = this.agentInboxes.get(context.agentId);
        if (ib?.pendingReceive === pendingReceive) {
          ib.pendingReceive = null;
        }
        resolve(messages);
      };

      timer = setTimeout(() => {
        // Return empty — the bridge returns a "take a rest" hint to the agent,
        // keeping the process alive until new messages arrive via stdin.
        finish([]);
      }, context.timeoutMs);

      const pendingReceive = { resolve, timer, finish };
      const inbox = this.agentInboxes.get(context.agentId);

      // Only one blocked receive can be active per agent. If a second long-poll
      // arrives, supersede the old waiter so it doesn't hang indefinitely or let
      // a stale abort/timeout clear the newer waiter.
      if (inbox?.pendingReceive) {
        inbox.pendingReceive.finish([]);
      }

      // If the HTTP connection is aborted, clean up gracefully
      if (context.signal) {
        const onAbort = () => finish([]);
        if (context.signal.aborted) {
          finish([]);
          return;
        }
        context.signal.addEventListener("abort", onAbort, { once: true });
        cleanupAbortListener = () => context.signal?.removeEventListener("abort", onAbort);
      }

      if (!inbox) {
        this.agentInboxes.set(context.agentId, { inbox: [], pendingReceive });
        return;
      }
      inbox.pendingReceive = pendingReceive;
    });
  }

  acknowledgeDeliveredMessages(agentId: string, seqs: number[], messageIds: string[] = []): { removedCount: number } {
    if (seqs.length === 0 && messageIds.length === 0) return { removedCount: 0 };
    const inbox = this.agentInboxes.get(agentId);
    if (!inbox || inbox.inbox.length === 0) return { removedCount: 0 };

    const { removed, retained } = partitionAcknowledgedMessages({
      inbox: inbox.inbox,
      ackedSeqs: new Set(seqs),
      ackedMessageIds: new Set(messageIds),
    });

    if (removed.length === 0) return { removedCount: 0 };
    inbox.inbox = retained;
    return { removedCount: removed.length };
  }

  discardUndeliverableMessages(agentId: string, messages: AgentMessage[]): { removedCount: number } {
    if (messages.length === 0) return { removedCount: 0 };
    const inbox = this.agentInboxes.get(agentId);
    if (!inbox || inbox.inbox.length === 0) return { removedCount: 0 };

    const seqs = new Set<number>();
    const seqlessMessageIds = new Set<string>();
    for (const message of messages) {
      if (Number.isInteger(message.seq) && (message.seq ?? 0) > 0) {
        seqs.add(message.seq!);
      } else if (message.message_id) {
        seqlessMessageIds.add(message.message_id);
      }
    }
    if (seqs.size === 0 && seqlessMessageIds.size === 0) return { removedCount: 0 };

    const retained: AgentMessage[] = [];
    let removedCount = 0;
    for (const queued of inbox.inbox) {
      const matchesSeq = Number.isInteger(queued.seq) && seqs.has(queued.seq!);
      const matchesSeqlessId = !queued.seq && Boolean(queued.message_id) && seqlessMessageIds.has(queued.message_id!);
      if (matchesSeq || matchesSeqlessId) {
        removedCount += 1;
      } else {
        retained.push(queued);
      }
    }

    if (removedCount === 0) return { removedCount: 0 };
    inbox.inbox = retained;
    return { removedCount };
  }

  private discardMessagesForChannels(agentId: string, channelIds: readonly string[]): { removedCount: number } {
    const channelIdSet = new Set(channelIds.filter((id) => typeof id === "string" && id.length > 0));
    if (channelIdSet.size === 0) return { removedCount: 0 };
    const inbox = this.agentInboxes.get(agentId);
    if (!inbox || inbox.inbox.length === 0) return { removedCount: 0 };

    const retained: AgentMessage[] = [];
    let removedCount = 0;
    for (const queued of inbox.inbox) {
      if (channelIdSet.has(queued.channel_id)) {
        removedCount += 1;
      } else {
        retained.push(queued);
      }
    }
    if (removedCount === 0) return { removedCount: 0 };
    inbox.inbox = retained;
    return { removedCount };
  }

  async purgeAgentInboxForChannels(
    agentId: string,
    channelIds: readonly string[],
    reason = "channel_membership_removed",
  ): Promise<{ localRemovedCount: number; machineSent: boolean }> {
    const local = this.discardMessagesForChannels(agentId, channelIds);
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
    if (seqs.length === 0) return { removedCount: 0 };
    const inbox = this.agentInboxes.get(agentId);
    if (!inbox || inbox.inbox.length === 0) return { removedCount: 0 };

    const { removed, retained } = partitionTargetScopedAcknowledgedMessages({
      inbox: inbox.inbox,
      channelId,
      ackedSeqs: new Set(seqs),
    });

    if (removed.length === 0) return { removedCount: 0 };
    inbox.inbox = retained;
    return { removedCount: removed.length };
  }

  acknowledgeDeliveredMessagesForChannelUpToSeq(agentId: string, channelId: string, maxSeq: number): { removedCount: number } {
    if (!Number.isInteger(maxSeq) || maxSeq <= 0) return { removedCount: 0 };
    const inbox = this.agentInboxes.get(agentId);
    if (!inbox || inbox.inbox.length === 0) return { removedCount: 0 };

    const { removed, retained } = partitionTargetScopedMessagesUpToSeq({
      inbox: inbox.inbox,
      channelId,
      maxSeq,
    });

    if (removed.length === 0) return { removedCount: 0 };
    inbox.inbox = retained;
    return { removedCount: removed.length };
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
      let agent = await this.getCachedAgent(agentId);
      let localMachineId = agent?.machineId ?? null;
      let hostedLocally = localMachineId !== null && this.hasMachineLocally(localMachineId);
      let redisActivity: {
        activity: AgentActivityKind;
        detail: string;
        detailKind: AgentActivityDetailKind;
        updatedAt: number;
      } | null | undefined;
      if (agent?.status === "stopped") {
        if (!hostedLocally && this.replicaStateStore.isAvailable()) {
          redisActivity = await this.replicaStateStore.getAgentActivity(agentId);
          if (redisActivity && redisActivity.activity !== "offline") {
            const freshAgent = await this.getAuthoritativeAgentForDelivery(agentId);
            if (freshAgent) agent = freshAgent;
          }
        }
      }
      if (agent?.status === "stopped") {
        const stopped = this.formatActivity("offline", "Stopped");
        span.end("ok", { attrs: { outcome: stopped.activity, source: "stopped-status" } });
        return stopped;
      }

      const runtimeErrorResolution = await this.resolveLastRuntimeErrorActivity(agentId, agent);
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

      // When the agent's machine is connected to THIS replica, the in-memory
      // cache is authoritative and fresh (it is written on every broadcast).
      if (activityCached && hostedLocally) {
        const resolved = await this.resolveActivityHint(agentId, agent, activityCached, "local-cache", span);
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
        redisActivity ??= await this.replicaStateStore.getAgentActivity(agentId);
        if (redisActivity) {
          if (redisActivity.activity === "offline" && agent && !hostedLocally) {
            const freshAgent = await this.getAuthoritativeAgentForDelivery(agentId);
            if (freshAgent) agent = freshAgent;
            const redisOfflineDetail = redisActivity.detail.trim();
            const hasSpecificRedisOfflineDetail = redisOfflineDetail !== "" && redisOfflineDetail.toLowerCase() !== "stopped";
            if (freshAgent?.status === "stopped" && !hasSpecificRedisOfflineDetail) {
              const stopped = this.formatActivity("offline", "Stopped");
              span.end("ok", { attrs: { outcome: stopped.activity, source: "redis-stopped-refresh" } });
              return stopped;
            }
          }
          const resolved = await this.resolveActivityHint(agentId, agent, redisActivity, "redis", span);
          if (resolved) {
            span.end("ok", { attrs: { outcome: resolved.activity, source: "redis" } });
            return resolved;
          }
        }
      }

      const persisted = await this.resolveRecentPersistedActivity(agentId, agent, span);
      if (persisted) {
        span.end("ok", { attrs: { outcome: persisted.activity, source: "persisted" } });
        return persisted;
      }
      const derived = await this.resolveDerivedActivity(agent);
      span.end("ok", { attrs: { outcome: derived.activity, source: "derived" } });
      return derived;
    } catch (err) {
      span.addEvent("activity.resolve.failed", {
        error_class: err instanceof Error ? err.name : typeof err,
      });
      span.end("error");
      throw err;
    }
  }

  async listRecentActivityLog(agentId: string, limit = 50) {
    return this.loadPersistedActivityLog(agentId, limit);
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
    const snapshot: ActivitySnapshot = {
      activity: nextActivity,
      detail: nextDetail,
      detailKind: nextDetailKind,
      ...(nextObservedAtMs !== undefined ? { observedAtMs: nextObservedAtMs } : {}),
      updatedAt: now,
    };

    this.agentActivity.set(agentId, snapshot);

    // Mirror to Redis for cross-replica consistency (fire-and-forget)
    this.replicaStateStore.setAgentActivity(agentId, nextActivity, nextDetail, nextDetailKind, nextObservedAtMs).catch(() => {});

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
    if (!this.isAgentActivityKernelArbitrationEnabled()) {
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
        lastObservedAtMs: input.current?.observedAtMs ?? input.current?.updatedAt ?? 0,
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
      this.emitActivity(context.agentId, latest.activity, latest.detail, latest.detailKind, this.clock.now());
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
    return agentActivityLogService.appendAgentActivityEvent(agentId, activity, detail, entries, createdAt, dedupeKey);
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
    },
  ) {
    const agent = await this.getCachedAgent(agentId);
    if (agent) {
      // Bump per-agent monotonic seq before emit so the client can
      // drop pushes that arrive out-of-order during reconnect storms
      // (a race between socket-pushed updates and an in-flight
      // `loadAgents()` REST call). Resets on server restart — the
      // client also clears its own lastSeen on `socket.connect`,
      // which fires `loadAgents()` and replaces dot state wholesale,
      // so the reset window is self-healing.
      // (#engineering:72283cf7 task #340 PR B)
      const nextSeq = (this.activityServerSeq.get(agentId) ?? 0) + 1;
      this.activityServerSeq.set(agentId, nextSeq);
      const publicPayload = {
        agentId,
        activity,
        activityKind: activity,
        detail,
        detailKind,
        timestamp,
        serverSeq: nextSeq,
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
      const doEmit = () => {
        // Server and joint projection rooms can include members who may not be
        // allowed to inspect the agent's private workspace/action trajectory.
        // Keep raw entries behind the creator/admin activity-log hydration path.
        this.io?.to(`server:${agent.serverId}`).emit("agent:activity", publicPayload);
        void this.emitJointActivityToProjectionRooms(agent.id, agent.serverId, publicPayload);
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

  private async emitJointActivityToProjectionRooms(
    agentId: string,
    sourceServerId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      const channelIds = await this.loadJointActivityProjectionChannelIdsForAgent(agentId, sourceServerId);
      for (const channelId of channelIds) {
        this.io?.to(`channel:${channelId}`).emit("agent:activity", payload);
      }
    } catch (err) {
      console.error("[AgentOrchestrator] Failed to fan out joint activity", err);
    }
  }

  protected async loadJointActivityProjectionChannelIdsForAgent(agentId: string, sourceServerId: string): Promise<string[]> {
    return channelService.listJointActivityProjectionChannelIdsForAgent(agentId, sourceServerId);
  }
}
