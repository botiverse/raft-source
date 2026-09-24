import { Router, type Response, type Router as RouterType } from "express";
import type { Server as SocketServer } from "socket.io";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import multer from "multer";
import {
  agentMigrationSupportRefSchema,
  currentDate,
  type AgentMigrationUserErrorCode,
} from "@botiverse/raft-shared";
import * as agentService from "../services/agentService.js";
import * as agentMigrationService from "../services/agentMigrationService.js";
import { OFFICIAL_ONBOARDING_AGENT_IDENTITY } from "../services/officialOnboardingAgentIdentity.js";
import * as agentRuntimeProfileService from "../services/agentRuntimeProfileService.js";
import * as machineService from "../services/machineService.js";
import * as onboardingService from "../services/onboardingService.js";
import * as serverService from "../services/serverService.js";
import { getDb } from "../db/index.js";
import { agentMigrations, agents, machines, serverMembers, servers } from "../db/schema.js";
import {
  AgentOrchestrator,
  KimiReasoningEffortUpgradeRequiredError,
  type MachineMigrationTransportState,
} from "../services/agentOrchestrator.js";
import { emitAgentMigrationUpdated } from "../services/agentMigrationRealtime.js";
import { handleMachineLocalRouting, sendMachineAffinityUnavailable } from "../machineLocalReplay.js";
import {
  buildLaunchPlan,
  AGENT_MIGRATION_RESUMABLE_CAPABILITIES,
  AGENT_MIGRATION_RESUMABLE_PROTOCOL,
  AGENT_MIGRATION_SOURCE_WORKSPACE_ARCHIVE_CAPABILITY,
  EXTERNAL_AGENT_RUNTIME_ID,
  EXTERNAL_AGENT_RUNTIME_MODEL,
  hydrateRuntimeConfig,
  hydrateRuntimeConfigWithTrace,
  isExternalAgentRuntime,
  isRuntimeDeprecated,
  parseRuntimeConfig,
  runtimeConfigModelValue,
  stripControlledRuntimeEnvVars,
  validateAgentName,
  REASONING_EFFORTS,
  RUNTIME_CONFIG_VERSION,
  RUNTIMES,
  type LaunchPlan,
  type ReasoningEffort,
  type RuntimeConfig,
  type ServerCapability,
  type ServerRole,
  asMachineId,
} from "@botiverse/raft-shared";
import { parseBrandedUuidFromBody } from "../lib/brandedParse.js";
import { actorCanChangeServerMemberRole, actorHasServerCapabilityInServer, actorRoleHasServerCapability, getActorServerRoleInServer, userCanActOnAgentResource } from "../lib/actorPermissions.js";
import { getCdnStorage } from "../services/storageService.js";
import { streamStorageResponse } from "../services/storageResponseStream.js";
import { decodePixelAvatarKey, renderPixelAvatarSvg } from "../services/pixelAvatarService.js";
import {
  createAvatarUpload,
  MAX_PROFILE_AVATAR_BYTES,
  PROFILE_AVATAR_BAD_FORMAT_MESSAGE,
  PROFILE_AVATAR_TOO_LARGE_MESSAGE,
  runSingleAvatarUpload,
  storeAgentAvatar,
} from "../services/avatarService.js";
import * as channelService from "../services/channelService.js";
import { addTraceEvent, createTraceDbQueryTracer, getCurrentTraceContext, tracePhase } from "../tracing/semanticTrace.js";
import { RouteFailureError, resolveRouteFailureKind, resolveRouteFailureSubkind, sanitizeRouteErrorMessage, traceRouteFailure } from "../tracing/routeFailure.js";
import { isPrincipalHandleConflictError } from "../services/principalHandleService.js";
import * as agentScopesService from "../services/agentScopesService.js";
import {
  ALLOWED_AGENT_CAPABILITIES,
  getLatestActiveAgentCredential,
  isAgentBootstrapSurfaceEnabled,
  issueAgentBootstrapToken,
  normalizeAgentCapabilities,
  type AgentCapability,
} from "../services/agentCredentialService.js";
import {
  AGENT_MIGRATION_FEATURE_FLAG_KEY,
  evaluateFeatureFlag,
} from "../services/featureFlagService.js";
import {
  projectExistingAgentRuntimeOptions,
  resolveRuntimeAdmissionPolicy,
} from "../services/runtimeAdmissionService.js";
import { requireTeamBillingFeature } from "../services/planService.js";
import {
  buildKimiSdkFormOptionSource,
  runtimeConfigIssue,
  validateKimiSdkSelection,
  validateRuntimeFormDefinitionRef,
} from "../services/runtimeFormDefinitionService.js";
import { sendJsonServerError } from "./errorResponse.js";
import {
  assertProviderConnectionModelCompatible,
  ProviderConnectionError,
  resolveProviderConnectionSelection,
} from "../services/providerConnectionService.js";
import { isProviderConnectionsEnabled } from "../services/providerConnectionFeature.js";
import {
  BuiltInModelCatalogError,
  builtInPresetSelectionChanged,
} from "../services/builtinModelCatalogCompatibility.js";
import { MachineCatalogStaleError } from "../services/machineCatalogAuthority.js";

export const agentRouter: RouterType = Router();

// Guest conversations use a channel-scoped public profile projection. Permit
// only the two reads which apply that projection below; every operational or
// mutation endpoint on this router remains fail-closed for Guests.
agentRouter.use(async (req, res, next) => {
  const callerRole = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
  const pathSegments = req.path.split("/").filter(Boolean);
  const isGuestPublicProfileRead = req.method === "GET"
    && (pathSegments.length === 0 || pathSegments.length === 1);
  if (callerRole === "guest" && !isGuestPublicProfileRead) {
    res.status(403).json({ error: "Guests cannot access the server Agent directory" });
    return;
  }
  next();
});
export const agentAvatarRouter: RouterType = Router();
const MAX_AGENT_DESCRIPTION_LENGTH = 3000;
const MIN_MIGRATION_DAEMON_VERSION = "0.72.7";
const KNOWN_REASONING_EFFORT_IDS = new Set<string>(REASONING_EFFORTS.map((effort) => effort.id));

function persistedAgentReasoningEffort(
  runtime: string,
  effort: LaunchPlan["reasoningEffort"],
): ReasoningEffort | null {
  if (runtime === "kimi-sdk" || effort === null) return null;
  return KNOWN_REASONING_EFFORT_IDS.has(effort) ? effort as ReasoningEffort : null;
}

function sendKimiReasoningEffortUpgradeRequired(
  res: Response,
  pointer: "/formDefinitionRef" | "/runtimeConfig/reasoningEffort",
  error = "Update Raft on this device before changing Kimi reasoning settings",
): void {
  res.status(409).json({
    error,
    code: "upgrade_required",
    issues: [{ code: "kimi_reasoning_effort_upgrade_required", pointer }],
  });
}

function kimiModelPublishesReasoningCapability(
  models: readonly { id: string; supportedReasoningEfforts?: readonly string[] }[],
  model: string,
  effort: string,
): boolean {
  return models
    .find((candidate) => candidate.id === model)
    ?.supportedReasoningEfforts
    ?.includes(effort) === true;
}
const MIGRATION_MACHINE_ONLINE_MAX_AGE_MS = 2 * 60 * 1000;
const ONBOARDING_MEMORY_SEED_ENV = "SLOCK_ONBOARDING_MEMORY_SEED";
const DEFAULT_DELETE_AGENT_STOP_TIMEOUT_MS = 2_000;
const MANAGEABLE_AGENT_SERVER_ROLES = ["admin", "member"] as const;
type ManageableAgentServerRole = typeof MANAGEABLE_AGENT_SERVER_ROLES[number];
type AgentSkillsListFailureReason =
  | "daemon_timeout"
  | "daemon_error"
  | "orchestrator_unavailable"
  | "unknown";

function sendProviderConnectionsDisabled(res: Response): void {
  res.status(404).json({
    error: "Provider connections are not enabled for this server",
    code: "provider_connections_disabled",
  });
}

function sendBuiltInCatalogError(
  res: Response,
  error: BuiltInModelCatalogError | MachineCatalogStaleError,
): void {
  if (error instanceof MachineCatalogStaleError) {
    res
      .status(409)
      .json({ error: error.message, code: error.code, recovery: "retry" });
    return;
  }
  res.status(409).json({
    error: error.message,
    code: error.code,
    requestedModel: error.requestedModel,
    daemonVersion: error.daemonVersion,
    computerVersion: error.computerVersion,
    catalogRuntimeVersion: error.catalogRuntimeVersion,
    recovery: error.recovery,
  });
}

function sendBuiltInCatalogUnavailable(
  res: Response,
  versions: { daemonVersion?: string | null; computerVersion?: string | null } = {},
): void {
  sendBuiltInCatalogError(
    res,
    new BuiltInModelCatalogError(
      "builtin_catalog_unavailable",
      "The target Computer's Built-in model catalog is unavailable. Retry after the Computer reconnects.",
      {
        daemonVersion: versions.daemonVersion ?? null,
        computerVersion: versions.computerVersion ?? null,
        recovery: "retry",
      },
    ),
  );
}
type MigrationTransferProvisioner = typeof agentMigrationService.provisionAgentMigrationObjectStoreTransfer;
type MigrationLeaseDelivery = agentMigrationService.AgentMigrationTransportLeaseDelivery;

class MigrationRoutePreflightError extends Error {
  constructor(
    readonly status: number,
    readonly code: "MIGRATION_TRANSPORT_NOT_PROVISIONED" | "MIGRATION_TRANSPORT_LOST" | "MIGRATION_TRANSPORT_PROVISION_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "MigrationRoutePreflightError";
  }
}

function getErrorClass(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "";
}

function classifyAgentSkillsListFailureReason(error: unknown): AgentSkillsListFailureReason {
  const message = getErrorMessage(error).toLowerCase();
  if (message.includes("timed out") || message.includes("timeout")) return "daemon_timeout";
  if (message.includes("machine websocket not ready") || message.includes("failed to send request")) return "daemon_error";
  if (message.includes("no connected machine")) return "orchestrator_unavailable";
  return "unknown";
}

function agentSkillsListErrorExcerpt(reason: AgentSkillsListFailureReason): string {
  switch (reason) {
    case "daemon_timeout":
      return "Skills list request timed out";
    case "daemon_error":
      return "Failed to send skills list request to daemon";
    case "orchestrator_unavailable":
      return "Agent has no connected machine";
    case "unknown":
      return "Unexpected skills list failure";
  }
}

function parseSemverTriple(value: string | null | undefined): [number, number, number] | null {
  if (!value) return null;
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function daemonVersionAtLeast(value: string | null | undefined, minimum: string): boolean {
  const current = parseSemverTriple(value);
  const floor = parseSemverTriple(minimum);
  if (!current || !floor) return false;
  for (let i = 0; i < 3; i += 1) {
    if (current[i] > floor[i]) return true;
    if (current[i] < floor[i]) return false;
  }
  return true;
}

function machineSupportsRuntime(runtimes: string[] | null, runtime: string): boolean {
  return Array.isArray(runtimes) && runtimes.includes(runtime);
}

type MigrationComputerCapabilitySide = "source" | "target";
type MigrationComputerCapabilityReason =
  | "daemon_version_unconfirmed"
  | "daemon_version_too_old"
  | "runtime_unconfirmed"
  | "runtime_missing";

interface MigrationComputerCapabilityFailure {
  side: MigrationComputerCapabilitySide;
  reason: MigrationComputerCapabilityReason;
  minimumDaemonVersion?: string;
  runtime?: string;
}

interface MigrationComputerCapabilityDetails {
  failures: MigrationComputerCapabilityFailure[];
}

type MigrationErrorDetails = (
  | MigrationResumableCapabilityDetail
  | MigrationComputerCapabilityDetails
);

function computerCapabilityFailures(args: {
  sourceDaemonVersion: string | null | undefined;
  targetDaemonVersion: string | null | undefined;
  sourceRuntimes: string[] | null;
  targetRuntimes: string[] | null;
  runtime: string;
}): MigrationComputerCapabilityFailure[] {
  const failures: MigrationComputerCapabilityFailure[] = [];
  const computers = [
    {
      side: "source" as const,
      daemonVersion: args.sourceDaemonVersion,
      runtimes: args.sourceRuntimes,
    },
    {
      side: "target" as const,
      daemonVersion: args.targetDaemonVersion,
      runtimes: args.targetRuntimes,
    },
  ];

  for (const computer of computers) {
    if (!parseSemverTriple(computer.daemonVersion)) {
      failures.push({
        side: computer.side,
        reason: "daemon_version_unconfirmed",
        minimumDaemonVersion: MIN_MIGRATION_DAEMON_VERSION,
      });
    } else if (!daemonVersionAtLeast(computer.daemonVersion, MIN_MIGRATION_DAEMON_VERSION)) {
      failures.push({
        side: computer.side,
        reason: "daemon_version_too_old",
        minimumDaemonVersion: MIN_MIGRATION_DAEMON_VERSION,
      });
    }

    if (!Array.isArray(computer.runtimes)) {
      failures.push({
        side: computer.side,
        reason: "runtime_unconfirmed",
        runtime: args.runtime,
      });
    } else if (!machineSupportsRuntime(computer.runtimes, args.runtime)) {
      failures.push({
        side: computer.side,
        reason: "runtime_missing",
        runtime: args.runtime,
      });
    }
  }

  return failures;
}

function sendGrokRuntimeDisabled(res: Response): void {
  res.status(403).json({
    error: "Grok Build is not enabled on this server",
    code: "grok_runtime_disabled",
  });
}

function sendRuntimeCapabilityUnavailable(res: Response, runtime: string): void {
  res.status(409).json({
    error: `${runtime === "grok" ? "Grok Build" : runtime} is not available on this computer`,
    code: "runtime_capability_unavailable",
  });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

type MigrationResumableCapabilitySide = "source" | "target";
type MigrationResumableCapabilityReason =
  | "protocol_missing"
  | "protocol_old"
  | "capability_missing";

interface MigrationResumableCapabilityDetail {
  side: MigrationResumableCapabilitySide;
  reason: MigrationResumableCapabilityReason;
}

function resumableCapabilityReason(
  transport: Pick<MachineMigrationTransportState, "protocol" | "capabilities"> | null,
  side: MigrationResumableCapabilitySide,
): MigrationResumableCapabilityReason | null {
  if (!transport?.protocol) return "protocol_missing";
  if (transport.protocol !== AGENT_MIGRATION_RESUMABLE_PROTOCOL) return "protocol_old";
  if (!AGENT_MIGRATION_RESUMABLE_CAPABILITIES.every((capability) =>
    transport.capabilities?.includes(capability))) {
    return "capability_missing";
  }
  if (
    side === "source"
    && !transport.capabilities?.includes(AGENT_MIGRATION_SOURCE_WORKSPACE_ARCHIVE_CAPABILITY)
  ) {
    return "capability_missing";
  }
  return null;
}

function resumableCapabilityDetail(
  source: Pick<MachineMigrationTransportState, "protocol" | "capabilities"> | null,
  target: Pick<MachineMigrationTransportState, "protocol" | "capabilities"> | null,
): MigrationResumableCapabilityDetail | null {
  const sourceReason = resumableCapabilityReason(source, "source");
  if (sourceReason) return { side: "source", reason: sourceReason };
  const targetReason = resumableCapabilityReason(target, "target");
  return targetReason ? { side: "target", reason: targetReason } : null;
}

function sendMigrationError(
  res: Response,
  status: number,
  code: AgentMigrationUserErrorCode,
  error: string,
  details?: MigrationErrorDetails,
): void {
  res.status(status).json({
    error,
    code,
    details: {
      ...details,
      failureReason: code,
    },
  });
}

function isoOrNull(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function serializeOwnerMigrationStatus(row: agentMigrationService.AgentMigrationRow) {
  return {
    migrationRef: row.supportRef,
    agentId: row.agentId,
    state: row.state,
    sourceMachineId: row.sourceMachineId,
    targetMachineId: row.targetMachineId,
    provider: row.transportProvider,
    failureReason: row.failureReason,
    abortReason: row.abortReason,
    transportErrorCode: row.transportErrorCode,
    transportErrorMessage: row.transportErrorMessage,
    prepDeadlineAt: row.prepDeadlineAt.toISOString(),
    transferDeadlineAt: row.transferDeadlineAt.toISOString(),
    arrivalDeadlineAt: row.arrivalDeadlineAt.toISOString(),
    transportProvisioningStartedAt: isoOrNull(row.transportProvisioningStartedAt),
    transportProvisionedAt: isoOrNull(row.transportProvisionedAt),
    transportProvisionFailedAt: isoOrNull(row.transportProvisionFailedAt),
    transportLostAt: isoOrNull(row.transportLostAt),
    transportTeardownAt: isoOrNull(row.transportTeardownAt),
    readyAt: isoOrNull(row.readyAt),
    flippedAt: isoOrNull(row.flippedAt),
    arrivedAt: isoOrNull(row.arrivedAt),
    completedAt: isoOrNull(row.completedAt),
    abortedAt: isoOrNull(row.abortedAt),
    canceledAt: isoOrNull(row.canceledAt),
    cancelDisposition: row.cancelDisposition,
    cancelReason: row.cancelReason,
    cancelNeedsAttention: Boolean(row.cancelNeedsAttentionAt),
    cancelDispatchAttempts: row.cancelDispatchAttempts,
    cancelLastDispatchAt: isoOrNull(row.cancelLastDispatchAt),
    cancelAttentionDeadlineAt: isoOrNull(row.cancelAttentionDeadlineAt),
    cancelNeedsAttentionAt: isoOrNull(row.cancelNeedsAttentionAt),
    cancelErrorCode: row.cancelErrorCode,
    cancelErrorMessage: row.cancelErrorMessage,
    cancelSourceAcknowledgedAt: isoOrNull(row.cancelSourceAckAt),
    cancelSourceOutcome: row.cancelSourceOutcome,
    cancelTargetAcknowledgedAt: isoOrNull(row.cancelTargetAckAt),
    cancelTargetOutcome: row.cancelTargetOutcome,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function getMigrationTransferProvisioner(req: { app: { get(name: string): unknown } }): MigrationTransferProvisioner {
  return (req.app.get("agentMigrationObjectStoreTransferProvisioner") as MigrationTransferProvisioner | undefined)
    ?? agentMigrationService.provisionAgentMigrationObjectStoreTransfer;
}

function leaseStateFromDelivery(
  delivery: MigrationLeaseDelivery,
): agentMigrationService.AgentMigrationTransferLeaseState {
  const msg = delivery.message;
  return {
    provider: msg.provider,
    role: msg.role,
    transferKind: msg.transferKind,
    leaseSource: msg.leaseSource,
    migrationId: msg.migrationId,
    migrationGeneration: msg.migrationGeneration,
    sessionId: msg.sessionId,
    expiresAt: msg.expiresAt,
    maxBytes: msg.maxBytes,
  };
}

function assertMigrationTransferLeaseReady(input: {
  migration: agentMigrationService.AgentMigrationRow;
  source: MigrationLeaseDelivery;
  target: MigrationLeaseDelivery;
  now: Date;
}): void {
  const sourceVerdict = agentMigrationService.evaluateAgentMigrationTransferLeaseReady({
    migration: input.migration,
    lease: leaseStateFromDelivery(input.source),
    role: "source",
    now: input.now,
  });
  if (!sourceVerdict.ready) {
    throw new MigrationRoutePreflightError(
      422,
      sourceVerdict.code,
      `Source migration transfer lease is not ready: ${sourceVerdict.reason}`,
    );
  }

  const targetVerdict = agentMigrationService.evaluateAgentMigrationTransferLeaseReady({
    migration: input.migration,
    lease: leaseStateFromDelivery(input.target),
    role: "target",
    now: input.now,
  });
  if (!targetVerdict.ready) {
    throw new MigrationRoutePreflightError(
      422,
      targetVerdict.code,
      `Target migration transfer lease is not ready: ${targetVerdict.reason}`,
    );
  }
}

function recordAgentSkillsListFailed(
  error: unknown,
  input: { durationMs: number; runtime?: string | null; httpStatus: number; responseCode: string },
): void {
  const reason = classifyAgentSkillsListFailureReason(error);
  const errorSubkind = resolveRouteFailureSubkind(error);
  addTraceEvent("agent.skills.list.failed", {
    route_action: "skills_list",
    outcome: "error",
    reason,
    error_class: getErrorClass(error),
    error_kind: resolveRouteFailureKind(errorSubkind),
    error_subkind: errorSubkind,
    error_message: agentSkillsListErrorExcerpt(reason),
    duration_ms: Math.max(0, Math.round(input.durationMs)),
    runtime: input.runtime || "unknown",
    http_status: input.httpStatus,
    response_code: input.responseCode,
  });
}

async function ensureCreatorAgentDmVisible(opts: {
  serverId: string;
  creatorUserId: string;
  agentId: string;
  io?: SocketServer;
}) {
  const dm = await channelService.findOrCreateDM(opts.serverId, opts.creatorUserId, opts.agentId);
  if (!dm) return;
  const payload = { channelId: dm.id };
  opts.io?.to(`channel:${dm.id}`).emit("dm:new", payload);
  opts.io?.to(`user:${opts.creatorUserId}`).emit("dm:new", payload);
}

function isActiveCindyAgent(agent: { name: string }): boolean {
  return agent.name.trim().toLowerCase() === OFFICIAL_ONBOARDING_AGENT_IDENTITY.name.toLowerCase();
}

type OnboardingIdentityValue = string | null;
type OnboardingIdentitySnapshot = {
  name: OnboardingIdentityValue;
  displayName: OnboardingIdentityValue;
  role: OnboardingIdentityValue;
  serverRole: OnboardingIdentityValue;
  avatarUrl: OnboardingIdentityValue;
};

function onboardingIdentitySnapshot(agent: {
  name: string;
  displayName: string | null;
  description: string | null;
  avatarUrl: string | null;
}, serverRole: OnboardingIdentityValue): OnboardingIdentitySnapshot {
  return {
    name: agent.name,
    displayName: agent.displayName,
    role: agent.description,
    serverRole,
    avatarUrl: agent.avatarUrl,
  };
}

function buildOfficialOnboardingIdentityAdoption(agent: {
  name: string;
  displayName: string | null;
  description: string | null;
  avatarUrl: string | null;
}, serverRole: OnboardingIdentityValue) {
  const currentIdentity = onboardingIdentitySnapshot(agent, serverRole);
  const officialIdentity: OnboardingIdentitySnapshot = {
    name: OFFICIAL_ONBOARDING_AGENT_IDENTITY.name,
    displayName: OFFICIAL_ONBOARDING_AGENT_IDENTITY.displayName,
    role: OFFICIAL_ONBOARDING_AGENT_IDENTITY.description,
    serverRole: OFFICIAL_ONBOARDING_AGENT_IDENTITY.serverRole,
    avatarUrl: OFFICIAL_ONBOARDING_AGENT_IDENTITY.avatarUrl,
  };
  const labels: Record<keyof OnboardingIdentitySnapshot, string> = {
    name: "Name",
    displayName: "Display name",
    role: "Role",
    serverRole: "Server role",
    avatarUrl: "Avatar",
  };
  const changes = (Object.keys(officialIdentity) as Array<keyof OnboardingIdentitySnapshot>)
    .filter((field) => currentIdentity[field] !== officialIdentity[field])
    .map((field) => ({
      field,
      label: labels[field],
      before: currentIdentity[field],
      after: officialIdentity[field],
    }));

  return {
    canAdopt: changes.length > 0,
    currentIdentity,
    officialIdentity,
    changes,
  };
}

function deleteAgentStopTimeoutMs() {
  const raw = process.env.SLOCK_AGENT_DELETE_STOP_TIMEOUT_MS;
  if (!raw) return DEFAULT_DELETE_AGENT_STOP_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DELETE_AGENT_STOP_TIMEOUT_MS;
}

async function stopAgentBeforeDelete(agentOrchestrator: AgentOrchestrator, agentId: string) {
  const stopPromise = agentOrchestrator
    .stopAgent(agentId, "internal")
    .catch((error) => {
      console.warn(
        `[agents] delete ${agentId}: stop before delete failed`,
        error instanceof Error ? error.message : error,
      );
    });

  const timeoutMs = deleteAgentStopTimeoutMs();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeout = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  try {
    const outcome = await Promise.race([stopPromise.then(() => "stopped" as const), timeoutPromise]);
    if (outcome === "timeout") {
      console.warn(`[agents] delete ${agentId}: stop timed out after ${timeoutMs}ms; continuing with delete`);
    }
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

// Env var key must be a valid identifier: letters, digits, underscores; must start with letter or underscore
const ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The validated user-supplied env map: a plain string->string record whose keys
 * are valid shell identifiers and whose keys/values contain no null bytes. This
 * is the parsed shape callers should flow downstream — not the raw `unknown`
 * request body.
 */
export type UserEnvVars = Record<string, string>;

/** Discriminated parse result so callers branch on `ok` instead of re-reading the raw bag. */
export type ParseEnvVarsResult =
  | { ok: true; value: UserEnvVars | null }
  | { ok: false; reason: string };

/**
 * Parse-don't-validate: turn an `unknown` env payload into a typed
 * {@link UserEnvVars} (or null when absent), or a discriminated failure with the
 * rejection reason. `null`/`undefined` parse to `{ ok: true, value: null }`
 * (no-op: "not provided / clear"), preserving the prior `envVars == null` =>
 * valid behavior. Same shape rules + messages as the previous validator.
 */
function parseEnvVars(envVars: unknown): ParseEnvVarsResult {
  if (envVars == null) return { ok: true, value: null };
  if (typeof envVars !== "object" || Array.isArray(envVars)) {
    return { ok: false, reason: "envVars must be an object" };
  }
  const parsed: UserEnvVars = {};
  for (const [k, v] of Object.entries(envVars as Record<string, unknown>)) {
    if (typeof k !== "string" || typeof v !== "string") {
      return { ok: false, reason: "envVars keys and values must be strings" };
    }
    if (!ENV_KEY_REGEX.test(k)) {
      return { ok: false, reason: `Invalid env var key "${k}": must match [A-Za-z_][A-Za-z0-9_]*` };
    }
    if (k.includes("\0") || v.includes("\0")) {
      return { ok: false, reason: "envVars keys and values must not contain null bytes" };
    }
    // TODO(typed-boundary): split provider-controlled/reserved env keys
    // (provider/model launch mirrors) out of the user env map at this boundary
    // — that is a behavior change, kept out of the parse-don't-validate refactor.
    parsed[k] = v;
  }
  return { ok: true, value: parsed };
}

/** Strip envVars/runtimeConfig from agent payload (secrets should not leak to non-admins). */
function stripEnvVars<T extends Record<string, unknown>>(agent: T): Omit<T, "envVars" | "runtimeConfig"> {
  const { envVars: _, runtimeConfig: __, ...rest } = agent;
  return rest;
}

function withHydratedRuntimeConfig<
  T extends {
    runtime: string;
    model: string;
    runtimeConfig?: unknown;
    reasoningEffort?: ReasoningEffort | null;
    envVars?: Record<string, string> | null;
  },
>(agent: T): T & { runtimeConfig: RuntimeConfig } {
  // API read path: tolerate and sanitize historical DB rows so old agents remain
  // visible. Request create/update uses normalizeRequestRuntimeConfig below,
  // which parse-rejects malformed current RuntimeConfig instead.
  const hydrated = hydrateRuntimeConfigWithTrace(agent);
  addTraceEvent("server.runtime_config.parse", { ...hydrated.trace });
  return {
    ...agent,
    runtimeConfig: hydrated.config,
  };
}

function redactWriteOnlyRuntimeConfig(config: RuntimeConfig): RuntimeConfig {
  if (config.runtime !== "builtin") return config;
  if (config.provider.kind === "connection") return config;
  return {
    ...config,
    provider: { ...config.provider, apiKey: "" },
  };
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Update-only writeOnly semantics: omitting a Built-in provider secret keeps
 * the existing secret, but only while runtime/provider identity is unchanged.
 * Explicit blank/null values and provider switches still reach the parser and
 * fail closed; clients can never recover the retained value.
 */
function retainOmittedBuiltInProviderSecret(
  incoming: unknown,
  existing: RuntimeConfig,
): unknown {
  if (
    !isRecordValue(incoming)
    || typeof incoming.runtime !== "string"
    || incoming.runtime.trim() !== "builtin"
    || existing.runtime !== "builtin"
  ) return incoming;
  if (!isRecordValue(incoming.provider) || Object.hasOwn(incoming.provider, "apiKey")) return incoming;
  if (incoming.provider.kind === "connection" || existing.provider.kind === "connection") return incoming;
  if (
    incoming.provider.kind !== existing.provider.kind
    || incoming.provider.providerId !== existing.provider.providerId
    || !existing.provider.apiKey
  ) return incoming;
  if (
    existing.provider.kind === "gateway"
    && (
      typeof incoming.provider.baseUrl !== "string"
      || incoming.provider.baseUrl.trim() !== existing.provider.baseUrl.trim()
    )
  ) return incoming;
  return {
    ...incoming,
    provider: { ...incoming.provider, apiKey: existing.provider.apiKey },
  };
}

type LegacyKimiRuntimeConfigResult =
  | { ok: true; runtimeConfig: unknown }
  | { ok: false };

/**
 * Released Web clients predate Kimi's form-definition protocol. They rebuild a
 * same-model RuntimeConfig with `reasoningEffort: null` even when the persisted
 * open value is unknown to their closed enum. Treat no-ref Kimi writes as a
 * compatibility arm, never as authority to manage the effort:
 *
 * - same model: retain the persisted value byte-for-byte;
 * - model change while either side carries an effort: reject and require the
 *   schema-aware client so an incompatible value is neither leaked nor erased;
 * - no existing effort: a no-ref client may continue to submit only null.
 */
function retainLegacyKimiReasoningEffort(
  incoming: unknown,
  existing: RuntimeConfig,
): LegacyKimiRuntimeConfigResult {
  if (!isRecordValue(incoming) || existing.runtime !== "kimi-sdk") {
    return { ok: true, runtimeConfig: incoming };
  }
  const parsed = parseRuntimeConfig({ runtimeConfig: incoming });
  if (!parsed.ok || parsed.config.runtime !== "kimi-sdk") {
    return { ok: true, runtimeConfig: incoming };
  }
  const existingEffort = existing.reasoningEffort ?? null;
  const incomingEffort = parsed.config.reasoningEffort ?? null;
  const sameModel = runtimeConfigModelValue(parsed.config) === runtimeConfigModelValue(existing);
  if (!sameModel) {
    return existingEffort === null && incomingEffort === null
      ? { ok: true, runtimeConfig: incoming }
      : { ok: false };
  }
  if (existingEffort === null) {
    return incomingEffort === null
      ? { ok: true, runtimeConfig: incoming }
      : { ok: false };
  }
  if (incomingEffort !== null) return { ok: false };
  return {
    ok: true,
    runtimeConfig: { ...incoming, reasoningEffort: existingEffort },
  };
}

/**
 * Project the storage/runtime sentinel into a stable API boolean so clients do
 * not need to reinterpret external-agent storage details.
 */
function withExternalProjection<T extends { runtime: string }>(agent: T): T & { external: boolean } {
  return {
    ...agent,
    external: isExternalAgentRuntime(agent.runtime),
  };
}

function withAgentProjection<T extends {
  runtime: string;
  model: string;
  runtimeConfig?: unknown;
  reasoningEffort?: ReasoningEffort | null;
  envVars?: Record<string, string> | null;
}>(agent: T): T & { runtimeConfig: RuntimeConfig; external: boolean } {
  const projected = withHydratedRuntimeConfig(agent);
  return withExternalProjection({
    ...projected,
    runtimeConfig: redactWriteOnlyRuntimeConfig(projected.runtimeConfig),
  });
}

function withServerRoleProjection<T extends { id: string }>(
  agent: T,
  serverRole: ServerRole | null,
): T & { serverRole: ServerRole | null } {
  return {
    ...agent,
    serverRole,
  };
}

function withRuntimeConfigEnvVars(config: RuntimeConfig, extra: Record<string, string>): RuntimeConfig {
  if (Object.keys(extra).length === 0) return config;
  // Compatibility overlay for server-owned env injection such as onboarding
  // memory seeds. Caller/user env is sanitized separately; this helper is not a
  // backdoor for provider/model launch mirrors.
  return {
    ...config,
    envVars: {
      ...(config.envVars ?? {}),
      ...extra,
    },
  };
}

function deprecatedRuntimeSelectionError(runtime: string): string {
  return `Runtime is deprecated and cannot be selected: ${runtime}`;
}

function normalizeRequestRuntimeConfig(input: {
  runtimeConfig?: unknown;
  runtime?: string | null;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  envVars?: Record<string, string> | null;
  envVarsExplicit?: boolean;
  extraEnvVars?: Record<string, string>;
}): { runtimeConfig: RuntimeConfig | null; launch: LaunchPlan | null; persistedEnvVars: Record<string, string> | null; error: string | null } {
  const parsed = parseRuntimeConfig(input);
  addTraceEvent("server.runtime_config.parse", { ...parsed.trace });
  if (!parsed.ok) {
    return { runtimeConfig: null, launch: null, persistedEnvVars: null, error: parsed.error };
  }
  const hydratedConfig = parsed.config;
  const runtimeConfig = withRuntimeConfigEnvVars(
    input.envVarsExplicit
      ? {
          ...hydratedConfig,
          // Legacy API clients can still send top-level envVars beside
          // runtimeConfig. Treat them as user env only, strip runtime-owned
          // provider/model mirror keys, and keep structured RuntimeConfig as
          // the canonical write contract.
          envVars: stripControlledRuntimeEnvVars(hydratedConfig.runtime, input.envVars),
        }
      : hydratedConfig,
    input.extraEnvVars ?? {},
  );
  const launch = buildLaunchPlan(runtimeConfig); // Derive launch mirrors/env only after parse/validation; RuntimeConfig remains the canonical request/DB contract.
  addTraceEvent("server.runtime_config.launch_plan", { ...launch.trace });
  const parsedEnvVars = parseEnvVars(launch.envVars);
  if (!parsedEnvVars.ok) return { runtimeConfig, launch: null, persistedEnvVars: null, error: parsedEnvVars.reason };
  return {
    runtimeConfig,
    launch,
    persistedEnvVars: runtimeConfig.runtime === "builtin" ? runtimeConfig.envVars ?? null : parsedEnvVars.value,
    error: null,
  };
}

/**
 * Dedicated external-agent create builder. External agents are supplied and
 * observed, not launched by Slock, so caller-provided managed runtime launch
 * fields are intentionally discarded in favor of the external sentinel config.
 * This also avoids routing the request through managed normalize/pin/feed paths.
 * Keep this explicit: it is a compatibility boundary for imported/external
 * agents, not a managed-runtime fallback that should accept arbitrary
 * runtimeConfig payloads.
 */
function buildExternalAgentCreateInput(input: {
  machineId?: unknown;
  runtimeConfig?: unknown;
  runtime?: unknown;
  model?: unknown;
  reasoningEffort?: unknown;
  envVars?: unknown;
}): { runtimeConfig: RuntimeConfig; error: string | null } {
  if (input.machineId !== undefined && input.machineId !== null && input.machineId !== "") {
    return {
      runtimeConfig: hydrateRuntimeConfig({
        runtime: EXTERNAL_AGENT_RUNTIME_ID,
        model: EXTERNAL_AGENT_RUNTIME_MODEL,
      }),
      error: "External agents cannot be assigned to a Computer",
    };
  }
  const runtimeConfig = hydrateRuntimeConfig({
    runtime: EXTERNAL_AGENT_RUNTIME_ID,
    model: EXTERNAL_AGENT_RUNTIME_MODEL,
    runtimeConfig: {
      version: RUNTIME_CONFIG_VERSION,
      runtime: EXTERNAL_AGENT_RUNTIME_ID,
      model: { kind: "preset", id: EXTERNAL_AGENT_RUNTIME_MODEL },
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars: null,
    },
    reasoningEffort: null,
    envVars: null,
  });
  return { runtimeConfig, error: null };
}

/**
 * External agent kind is immutable in step0. Any managed runtime field update
 * would move the agent back into a Slock-owned launch contract, so PATCH rejects
 * the whole family as a single boundary.
 */
function isManagedRuntimeFieldTouched(body: Record<string, unknown>): boolean {
  return body.runtime !== undefined
    || body.model !== undefined
    || body.runtimeConfig !== undefined
    || body.reasoningEffort !== undefined
    || body.envVars !== undefined;
}

/**
 * External agents do not accept managed lifecycle commands such as assign,
 * start, or stop because Raft does not own their external process.
 */
function respondExternalManagedLifecycleUnsupported(res: Response): void {
  res.status(400).json({ error: "External agents do not use Raft-managed runtime lifecycle" });
}

/** Detect failed before mutation: keep explicit effort and let the caller retry. */
function sendKimiModelDetectUnavailable(
  res: Response,
  error: RouteFailureError,
  action: "create" | "update",
  serverId: string | undefined,
): void {
  const timedOut = error.subkind === "daemon_timeout";
  const code = timedOut ? "runtime_model_source_timeout" : "runtime_model_source_offline";
  traceRouteFailure(`agent.${action}.failed`, error, {
    route_action: action, http_status: 409, response_code: code, server_id: serverId,
  });
  res.status(409).json({
    error: timedOut
      ? "Kimi model validation timed out. Your settings were not saved; try again."
      : "The selected computer is unavailable. Reconnect it and try again; your settings were not saved.",
    code,
    issues: [{ code, pointer: "/runtimeConfig/model" }],
  });
}

function responseForAgentRouteFailure(err: unknown): { status: number; code: string } {
  if (err instanceof KimiReasoningEffortUpgradeRequiredError) {
    return { status: 409, code: err.code };
  }
  const subkind = resolveRouteFailureSubkind(err);
  switch (subkind) {
    case "daemon_offline":
      return { status: 409, code: "machine_offline" };
    case "daemon_timeout":
      return { status: 504, code: "daemon_timeout" };
    case "daemon_error_unsupported":
    case "daemon_threw":
    case "unknown":
      return { status: 500, code: "internal_error" };
  }
}

/**
 * Joint-channel visibility grants only conversation/profile/status context for
 * peer-server agents. It must not inherit the viewer's local admin role into
 * the remote server or expose runtime/control-plane details.
 */
function toJointAgentProfile(agent: Record<string, unknown>): Record<string, unknown> {
  return {
    id: agent.id,
    serverId: agent.serverId,
    serverName: agent.serverName ?? null,
    serverSlug: agent.serverSlug ?? null,
    name: agent.name,
    displayName: agent.displayName ?? null,
    avatarUrl: agent.avatarUrl ?? null,
    description: agent.description ?? null,
    status: agent.status,
    external: typeof agent.runtime === "string" ? isExternalAgentRuntime(agent.runtime) : false,
    deletedAt: agent.deletedAt ?? null,
    createdAt: agent.createdAt,
    activity: agent.activity ?? "offline",
    activityDetail: "",
  };
}

function toGuestChannelAgentProfile(agent: Record<string, unknown>): Record<string, unknown> {
  return {
    id: agent.id,
    serverId: agent.serverId,
    name: agent.name,
    displayName: agent.displayName ?? null,
    avatarUrl: agent.avatarUrl ?? null,
    description: agent.description ?? null,
    status: agent.status,
    deletedAt: agent.deletedAt ?? null,
    createdAt: agent.createdAt,
    activity: agent.activity ?? "offline",
    activityDetail: "",
    profileProjection: "channel_summary",
  };
}

function getCreatorEnrichmentStats(
  agents: Array<{ creatorType: string | null; creatorId: string | null }>,
): { userCreatorCount: number; agentCreatorCount: number } {
  const userCreatorIds = new Set<string>();
  const agentCreatorIds = new Set<string>();
  for (const agent of agents) {
    if (!agent.creatorType || !agent.creatorId) continue;
    if (agent.creatorType === "user") {
      userCreatorIds.add(agent.creatorId);
    } else if (agent.creatorType === "agent") {
      agentCreatorIds.add(agent.creatorId);
    }
  }
  return {
    userCreatorCount: userCreatorIds.size,
    agentCreatorCount: agentCreatorIds.size,
  };
}

/**
 * Default-deny visibility check for everything beyond the public Profile tab.
 *
 * Spec (#proj-server:175df9ee): only the agent's human creator and users with
 * `editAgents` (server owner / admin) can see the agent's private surfaces.
 * Profile is the **only** public surface; any new endpoint that exposes
 * agent-internal information (workspace, activity, DMs, reminders, skills, …)
 * must run through this check by default — adding new internal info should
 * NOT silently widen visibility.
 */
export async function canInspectAgentPrivateSurfaces(
  serverId: string,
  userId: string,
  agent: { creatorType: string | null; creatorId: string | null },
): Promise<boolean> {
  const callerRole = await getActorServerRoleInServer(serverId, "user", userId);
  return userCanActOnAgentResource(callerRole, userId, agent, "editAgents");
}

async function currentUserCanActOnAgent(
  serverId: string,
  userId: string,
  agent: { creatorType: string | null; creatorId: string | null },
  capability: ServerCapability,
): Promise<boolean> {
  const callerRole = await getActorServerRoleInServer(serverId, "user", userId);
  return userCanActOnAgentResource(callerRole, userId, agent, capability);
}

// List all agents in server
agentRouter.get("/", async (req, res) => {
  try {
    addTraceEvent("agents.list.started");
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    const callerRole = await tracePhase(
      () => getActorServerRoleInServer(req.serverId!, "user", req.userId!),
      (durationMs, result) => ({
        name: "agent.permissions.checked",
        attrs: {
          can_manage: actorRoleHasServerCapability(result, "editAgents"),
        },
      }),
    );
    const list = await tracePhase(
      () => agentService.listAgents(req.serverId!, true, {
        traceQuery: createTraceDbQueryTracer("agents.loaded"),
      }),
      (durationMs, result) => ({
        name: "agents.loaded",
        attrs: {
          agents_count: result.length,
        },
      }),
    );
    const guestVisibleAgentIds = callerRole === "guest"
      ? await channelService.getAgentIdsVisibleThroughLocalChannels(req.serverId!, req.userId!)
      : null;
    const scopedList = guestVisibleAgentIds
      ? list.filter((agent) => guestVisibleAgentIds.has(agent.id))
      : list;
    if (callerRole === "guest") {
      const publicProfiles = await Promise.all(scopedList.map(async (agent) => {
        const { activity, activityDetail } = await agentOrchestrator.getActivity(agent.id, {
          parent: getCurrentTraceContext(),
        });
        return toGuestChannelAgentProfile({ ...agent, activity, activityDetail });
      }));
      addTraceEvent("response.ready", {
        agents_count: publicProfiles.length,
        profile_projection: "channel_summary",
      });
      res.json(publicProfiles);
      return;
    }
    const runtimeProfileByAgent = await tracePhase(
      () => agentRuntimeProfileService.getAgentRuntimeProfileSummaries(scopedList.map((a) => a.id), {
        traceQuery: createTraceDbQueryTracer("runtime_profiles.loaded"),
      }),
      (durationMs, result) => ({
        name: "runtime_profiles.loaded",
        attrs: {
          agents_count: list.length,
          runtime_profiles_count: result.size,
        },
      }),
    );
    const roleByAgent = await tracePhase(
      () => serverService.getServerAgentRoleMap(req.serverId!),
      (durationMs, result) => ({
        name: "agent_server_roles.loaded",
        attrs: {
          agents_count: result.size,
        },
      }),
    );
    // Fetch activities (in-memory orchestrator lookup, fast) per-agent then
    // batch-enrich creator + createdAgents via one combined DB pass instead
    // of 2N queries. See agentService.batchEnrichAgentsWithCreatorProfile.
    const withActivity = await tracePhase(
      () => Promise.all(scopedList.map(async (a) => {
        const { activity, activityDetail } = await agentOrchestrator.getActivity(a.id, {
          parent: getCurrentTraceContext(),
        });
        return {
          ...withServerRoleProjection(withAgentProjection(a), roleByAgent.get(a.id) ?? null),
          activity,
          activityDetail,
          runtimeProfile: runtimeProfileByAgent.get(a.id) ?? null,
        };
      })),
      (durationMs, result) => ({
        name: "activities.loaded",
        attrs: {
          agents_count: result.length,
        },
      }),
    );
    const creatorStats = getCreatorEnrichmentStats(withActivity);
    const enrichedAll = await tracePhase(
      () => agentService.batchEnrichAgentsWithCreatorProfile(withActivity, {
        traceQuery: createTraceDbQueryTracer("creators.enriched"),
      }),
      (durationMs, result) => ({
        name: "creators.enriched",
        attrs: {
          batched: true,
          agents_count: result.length,
          creator_user_count: creatorStats.userCreatorCount,
          creator_agent_count: creatorStats.agentCreatorCount,
        },
      }),
    );
    const enriched = enrichedAll.map((agent) => userCanActOnAgentResource(
      callerRole,
      req.userId!,
      agent,
      "editAgents",
    ) ? agent : stripEnvVars(agent));
    const strippedCount = enrichedAll.filter((agent) => !userCanActOnAgentResource(
      callerRole,
      req.userId!,
      agent,
      "editAgents",
    )).length;
    addTraceEvent("response.ready", {
      agents_count: enriched.length,
      env_vars_stripped: strippedCount > 0,
    });
    res.json(enriched);
  } catch {
    res.status(500).json({ error: "Failed to list agents" });
  }
});

// Create agent — accepts machineId and program, auto-starts after creation
agentRouter.post("/", async (req, res) => {
  try {
    if (!await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "createAgents")) {
      res.status(403).json({ error: "The `createAgents` capability is required to create agents" });
      return;
    }
    // Optimistic setup-state token for the create-vs-reset race. Both operations serialize
    // on the agent lock in the service; this request-start snapshot tells the winner whether
    // the caller was queued behind a reset and must retry from the now-current screen.
    const [ownerSetupAtRequestStart] = await getDb()
      .select({ status: serverMembers.setupStatus })
      .from(servers)
      .leftJoin(serverMembers, and(
        eq(serverMembers.serverId, servers.id),
        eq(serverMembers.userId, servers.ownerId),
      ))
      .where(eq(servers.id, req.serverId!))
      .limit(1);
    const expectedSetupStatus = ownerSetupAtRequestStart?.status ?? null;
    const { name, description, model, runtime, runtimeConfig, formDefinitionRef, reasoningEffort, machineId, envVars, avatarUrl } = req.body;
    const external = req.body?.external === true;
    const onboarding = req.body?.onboarding === true;
    if (external && onboarding) {
      res.status(400).json({ error: "Onboarding agent cannot be external" });
      return;
    }
    const createName = onboarding ? OFFICIAL_ONBOARDING_AGENT_IDENTITY.name : name;
    const createDescription = onboarding ? OFFICIAL_ONBOARDING_AGENT_IDENTITY.description : description;
    const createAvatarUrl = onboarding ? OFFICIAL_ONBOARDING_AGENT_IDENTITY.avatarUrl : avatarUrl;
    const nameError = validateAgentName(createName, "Agent name");
    if (nameError) {
      res.status(400).json({ error: nameError });
      return;
    }
    if (createDescription && (typeof createDescription !== "string" || createDescription.length > MAX_AGENT_DESCRIPTION_LENGTH)) {
      res.status(400).json({ error: `Description must be a string of at most ${MAX_AGENT_DESCRIPTION_LENGTH} characters` });
      return;
    }
    if (createAvatarUrl !== undefined && createAvatarUrl !== null) {
      if (typeof createAvatarUrl !== "string" || !createAvatarUrl.startsWith("pixel:")) {
        res.status(400).json({ error: "avatarUrl must be a pixel: URL at creation time" });
        return;
      }
    }
    if (external && formDefinitionRef !== undefined) {
      res.status(400).json({
        error: "External agents cannot use runtime form definitions",
        issues: [{ code: "external_form_definition_forbidden", pointer: "/formDefinitionRef" }],
      });
      return;
    }
    const rawRuntimeConfigRuntime = runtimeConfig && typeof runtimeConfig === "object" && !Array.isArray(runtimeConfig)
      ? (runtimeConfig as Record<string, unknown>).runtime
      : undefined;
    // Keep the missing-ref boundary on the same canonical runtime identity as
    // parseRuntimeConfig. Otherwise whitespace-normalized Built-in requests can
    // bypass the schema gate before the parser turns them into `builtin`.
    const runtimeConfigRuntime = typeof rawRuntimeConfigRuntime === "string"
      ? rawRuntimeConfigRuntime.trim()
      : rawRuntimeConfigRuntime;
    if (!external && runtimeConfigRuntime === "builtin" && formDefinitionRef === undefined) {
      res.status(409).json({
        error: "This runtime requires a runtime form definition reference",
        issues: [{ code: "form_definition_ref_required", pointer: "/formDefinitionRef" }],
      });
      return;
    }
    // A present form ref is a fail-closed protocol boundary: validate the
    // envelope before consulting the runtime parser, and never fall back to
    // the legacy/external request shape for an unknown/stale version.
    if (formDefinitionRef !== undefined) {
      const refIssues = validateRuntimeFormDefinitionRef(formDefinitionRef);
      if (refIssues.length > 0) {
        res.status(409).json({ error: "Runtime form definition is stale or invalid", issues: refIssues });
        return;
      }
      const schemaParsed = parseRuntimeConfig({ runtimeConfig });
      if (!schemaParsed.ok) {
        addTraceEvent("server.runtime_config.parse", { ...schemaParsed.trace });
        res.status(400).json({
          error: "Runtime configuration is invalid",
          issues: [runtimeConfigIssue(schemaParsed.error)],
        });
        return;
      }
      const refRuntimeId = (formDefinitionRef as { runtimeId?: unknown }).runtimeId;
      if (schemaParsed.config.runtime !== refRuntimeId) {
        res.status(400).json({
          error: "Runtime configuration does not match form definition",
          issues: [{ code: "form_runtime_mismatch", pointer: "/runtimeConfig/runtime" }],
        });
        return;
      }
    }
    if (external) {
      const externalInput = buildExternalAgentCreateInput({
        machineId,
        runtimeConfig,
        runtime,
        model,
        reasoningEffort,
        envVars,
      });
      if (externalInput.error) {
        res.status(400).json({ error: externalInput.error });
        return;
      }
      const agent = await agentService.createAgent(req.serverId!, createName.trim(), {
        description: createDescription,
        model: EXTERNAL_AGENT_RUNTIME_MODEL,
        runtime: EXTERNAL_AGENT_RUNTIME_ID,
        runtimeConfig: externalInput.runtimeConfig,
        reasoningEffort: undefined,
        machineId: undefined,
        envVars: undefined,
        avatarUrl: createAvatarUrl || undefined,
        creatorType: "user",
        creatorId: req.userId!,
        expectedSetupStatus,
      });
      const io = req.app.get("io") as SocketServer | undefined;
      await ensureCreatorAgentDmVisible({
        serverId: req.serverId!,
        creatorUserId: req.userId!,
        agentId: agent.id,
        io,
      });
      const result = await agentService.enrichAgentWithCreatorProfile(withServerRoleProjection(withAgentProjection(agent), "member"));
      io?.to(`server:${req.serverId}`).emit("agent:created", { agent: stripEnvVars(result) });
      res.json(result);
      return;
    }

    // Validate reasoningEffort
    const validEffortIds = new Set<string>(REASONING_EFFORTS.map((r) => r.id));
    if (reasoningEffort && runtimeConfigRuntime !== "kimi-sdk" && !validEffortIds.has(reasoningEffort)) {
      res.status(400).json({ error: `Invalid reasoning effort: ${reasoningEffort}` });
      return;
    }
    // Parse envVars into a typed map at this boundary; downstream flows the
    // parsed value rather than the raw request bag.
    const parsedEnvVars = parseEnvVars(envVars);
    if (!parsedEnvVars.ok) {
      res.status(400).json({ error: parsedEnvVars.reason });
      return;
    }
    // Validate machineId belongs to this server. req.body is `any`, so parse the
    // value into a branded MachineId at this boundary before getMachine trusts it.
    let assignedMachine: Awaited<ReturnType<typeof machineService.getMachine>> | null = null;
    if (machineId) {
      const parsedMachineId = parseBrandedUuidFromBody(machineId, asMachineId, "machineId", res);
      if (!parsedMachineId) return;
      assignedMachine = await machineService.getMachine(parsedMachineId);
      if (!assignedMachine || assignedMachine.serverId !== req.serverId) {
        res.status(400).json({ error: "Machine not found in this server" });
        return;
      }
    }
    const isCindyOnboardingAgent = onboarding;
    if (isCindyOnboardingAgent) {
      const server = await serverService.getServer(req.serverId!);
      if (server?.onboardingAgentId) {
        const existingOnboardingAgent = await agentService.getAgent(server.onboardingAgentId);
        if (existingOnboardingAgent && existingOnboardingAgent.serverId === req.serverId) {
          res.status(409).json({
            error: "Onboarding agent already exists in this server",
            onboardingAgentId: existingOnboardingAgent.id,
          });
          return;
        }
      }
    }
    const existingAgents = isCindyOnboardingAgent ? await agentService.listAgents(req.serverId!) : [];
    if (isCindyOnboardingAgent && existingAgents.some(isActiveCindyAgent)) {
      res.status(409).json({ error: "Cindy agent already exists in this server" });
      return;
    }
    const normalizedConfig = normalizeRequestRuntimeConfig({
      runtimeConfig,
      runtime,
      model,
      reasoningEffort,
      envVars: parsedEnvVars.value,
      envVarsExplicit: envVars !== undefined,
      extraEnvVars: isCindyOnboardingAgent ? { [ONBOARDING_MEMORY_SEED_ENV]: "first-cindy" } : undefined,
    });
    if (normalizedConfig.error || !normalizedConfig.launch || !normalizedConfig.runtimeConfig) {
      res.status(400).json({ error: normalizedConfig.error });
      return;
    }
    if (
      normalizedConfig.runtimeConfig.runtime === "kimi-sdk"
      && formDefinitionRef === undefined
      && normalizedConfig.launch.reasoningEffort !== null
    ) {
      sendKimiReasoningEffortUpgradeRequired(res, "/formDefinitionRef");
      return;
    }
    if (isRuntimeDeprecated(normalizedConfig.launch.runtime)) {
      res.status(400).json({ error: deprecatedRuntimeSelectionError(normalizedConfig.launch.runtime) });
      return;
    }
    if (
      normalizedConfig.launch.runtime === "grok"
      && !(await resolveRuntimeAdmissionPolicy({
        userId: req.userId!,
        serverId: req.serverId!,
      })).grokRuntimeEnabled
    ) {
      sendGrokRuntimeDisabled(res);
      return;
    }

    let agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    if (normalizedConfig.runtimeConfig.runtime === "kimi-sdk") {
      if (!assignedMachine) {
        res.status(409).json({
          error: "Kimi model validation requires an assigned computer",
          issues: [{ code: "runtime_model_source_unavailable", pointer: "/machineId" }],
        });
        return;
      }
      let detected: Awaited<ReturnType<AgentOrchestrator["detectMachineRuntimeModels"]>> | null = null;
      try {
        detected = await agentOrchestrator.detectMachineRuntimeModels(assignedMachine.id, "kimi-sdk");
      } catch (error) {
        // Legacy daemons may not provide a model table. Preserve the existing
        // creation contract when no reasoning effort was requested; explicit
        // effort still requires live capability data and must fail closed.
        if (!(error instanceof RouteFailureError)
          || (error.subkind !== "daemon_timeout" && error.subkind !== "daemon_offline")) throw error;
        if (normalizedConfig.launch.reasoningEffort !== null) {
          sendKimiModelDetectUnavailable(res, error, "create", req.serverId);
          return;
        }
      }
      // PRODUCT DECISION (@artin, 2026-09-06, #proj-uiux:8cf7b0a7): supporting Computers
      // older than 1.0.25 outranks giving an actionable creation-time error. Those
      // Computers DO implement the detect call (handler landed 2026-04-14, #768 --
      // earlier than every computer-v1.0.x tag), so they *answer*; a machine whose Kimi
      // is simply not logged in answers `missing_config` and would be refused here.
      // Refusing it is what @artin rejected. So an answered non-live result is downgraded
      // exactly as v1.12.2 does in production -- with `unsupported` still kept as a 409.
      // Cost accepted by @artin: a not-logged-in user creates successfully and only sees
      // the failure at runtime. ⛔ Do not re-narrow this without asking him.
      if (detected && detected.kind !== "live") {
        if (normalizedConfig.launch.reasoningEffort !== null || detected.kind === "unsupported") {
          res.status(409).json({
            error: "Kimi model source is unavailable",
            issues: [{ code: `runtime_model_source_${detected.kind}`, pointer: "/runtimeConfig/model" }],
          });
          return;
        }
        detected = null;
      }
      if (
        detected
        && normalizedConfig.launch.reasoningEffort !== null
        && !kimiModelPublishesReasoningCapability(
          detected.value.models,
          normalizedConfig.launch.model,
          normalizedConfig.launch.reasoningEffort,
        )
      ) {
        const selectedModel = detected.value.models.find((candidate) => candidate.id === normalizedConfig.launch!.model);
        if (selectedModel && !selectedModel.supportedReasoningEfforts?.length) {
          sendKimiReasoningEffortUpgradeRequired(res, "/runtimeConfig/reasoningEffort", "Update Raft on the selected computer before using Kimi reasoning settings");
          return;
        }
      }
      const selectionIssues = detected
        ? validateKimiSdkSelection({
            source: buildKimiSdkFormOptionSource({ models: detected.value.models, defaultModel: detected.value.default }),
            model: normalizedConfig.launch.model,
            reasoningEffort: normalizedConfig.launch.reasoningEffort,
          })
        : [];
      if (selectionIssues.length > 0) {
        res.status(400).json({ error: "Kimi runtime selection is invalid", issues: selectionIssues });
        return;
      }
    }
    if (
      normalizedConfig.launch.runtime === "grok"
      && assignedMachine
      && !machineSupportsRuntime(assignedMachine.runtimes, "grok")
    ) {
      sendRuntimeCapabilityUnavailable(res, "grok");
      return;
    }

    let providerConnection = null;
    if (
      normalizedConfig.runtimeConfig.runtime === "builtin"
      && normalizedConfig.runtimeConfig.provider.kind === "connection"
    ) {
      if (!await isProviderConnectionsEnabled(req.serverId!)) {
        sendProviderConnectionsDisabled(res);
        return;
      }
      providerConnection = await resolveProviderConnectionSelection(
        req.serverId!,
        normalizedConfig.runtimeConfig.provider.connectionId,
      );
    }
    if (providerConnection && normalizedConfig.runtimeConfig.runtime === "builtin") {
      assertProviderConnectionModelCompatible(providerConnection.providerId, normalizedConfig.runtimeConfig.model);
    }

    let releaseCatalogAuthority: () => void = () => undefined;
    if (
      normalizedConfig.runtimeConfig.runtime === "builtin" &&
      normalizedConfig.runtimeConfig.provider.kind === "preset" &&
      normalizedConfig.runtimeConfig.model.kind === "preset"
    ) {
      if (!assignedMachine) {
        res.status(409).json({
          error:
            "A target Computer is required to validate this Built-in model",
          code: "builtin_catalog_target_required",
          recovery: "select_computer",
        });
        return;
      }
      const routing = await handleMachineLocalRouting(
        req,
        res,
        assignedMachine.id,
        () => agentOrchestrator.hasMachineLocally(assignedMachine!.id),
      );
      if (routing === "handled") return;
      if (routing !== "confirmed_local") {
        sendBuiltInCatalogUnavailable(res, assignedMachine);
        return;
      }
      const validation =
        await agentOrchestrator.validateBuiltInPresetForMachine(
          assignedMachine.id,
          normalizedConfig.runtimeConfig,
        );
      if (validation) {
        releaseCatalogAuthority =
          agentOrchestrator.acquireBuiltInCatalogAuthority(
            assignedMachine.id,
            validation.authority,
          );
      }
    }

    let agent: Awaited<ReturnType<typeof agentService.createAgent>>;
    try {
      agent = await agentService.createAgent(req.serverId!, createName.trim(), {
        description: createDescription,
        model: normalizedConfig.launch.model,
        runtime: normalizedConfig.launch.runtime,
        runtimeConfig: normalizedConfig.runtimeConfig,
        // The legacy agents.reasoning_effort column is a closed enum. Kimi's
        // live, open-ended vocabulary is persisted only in RuntimeConfig, which
        // is also the launch authority.
        reasoningEffort: persistedAgentReasoningEffort(
          normalizedConfig.launch.runtime,
          normalizedConfig.launch.reasoningEffort,
        ) ?? undefined,
        machineId,
        envVars: normalizedConfig.persistedEnvVars ?? undefined,
        avatarUrl: createAvatarUrl || undefined,
        creatorType: "user",
        creatorId: req.userId!,
        expectedSetupStatus,
        ...(providerConnection ? {
          providerConnection: {
            ...providerConnection,
            updatedByUserId: req.userId!,
          },
        } : {}),
      });
    } finally {
      releaseCatalogAuthority();
    }

    if (isCindyOnboardingAgent) {
      await serverService.updateServerOnboardingAgent(req.serverId!, agent.id);
      await serverService.updateAgentMemberRole(req.serverId!, agent.id, "admin");
    }

    const io = req.app.get("io") as SocketServer | undefined;
    await ensureCreatorAgentDmVisible({
      serverId: req.serverId!,
      creatorUserId: req.userId!,
      agentId: agent.id,
      io,
    });

    // Auto-start the agent if it has a machine assigned
    if (agent.machineId) {
      try {
        await agentOrchestrator.startAgent(agent.id);
      } catch (startErr: any) {
        console.warn(`[Agent ${agent.id}] Auto-start failed: ${startErr.message}`);
      }
    }

    // Opener is system-sends-as-OA — fire at creation, not at runtime start
    if (io) {
      void onboardingService
        .triggerOwnerOnboardingOnAgentActivation(io, agentOrchestrator, req.serverId!, agent.id)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[Onboarding] Failed to trigger owner onboarding for agent ${agent.id}: ${msg}`);
        });
    }

    // When a 2nd agent unlocks #all, notify the onboarding agent, then have the
    // newly created agent greet the team agentically. Sequenced so the unlock has
    // flipped #all live before the greeting checks its visibility.
    if (io) {
      void (async () => {
        try {
          await onboardingService.triggerAllChannelUnlockOnboarding(io, agentOrchestrator, req.serverId!);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[Onboarding] Failed to trigger #all unlock for server ${req.serverId}: ${msg}`);
        }
        try {
          await onboardingService.triggerNewAgentAllChannelGreeting(io, agentOrchestrator, req.serverId!, agent.id);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[Onboarding] Failed to trigger #all greeting for agent ${agent.id}: ${msg}`);
        }
      })();
    }

    const oaServerRole = isCindyOnboardingAgent ? "admin" : "member";
    // Notify all clients in this server
    const result = await agentService.enrichAgentWithCreatorProfile(withServerRoleProjection(withAgentProjection(agent), oaServerRole));

    io?.to(`server:${req.serverId}`).emit("agent:created", { agent: stripEnvVars(result) });

    res.json(result);
  } catch (err: any) {
    const msg = err?.message || "";
    if (
      err instanceof BuiltInModelCatalogError ||
      err instanceof MachineCatalogStaleError
    ) {
      sendBuiltInCatalogError(res, err);
    } else if (err instanceof agentService.ServerSetupChangedRetryError) {
      res.status(409).json({ error: err.code });
    } else if (err instanceof ProviderConnectionError) {
      res.status(err.code === "provider_connection_invalid" ? 400 : 409).json({ error: err.message, code: err.code });
    } else if (isPrincipalHandleConflictError(err) || msg.includes("already taken")) {
      res.status(409).json({ error: msg });
    } else if (msg.includes("limit reached")) {
      res.status(400).json({ error: msg });
    } else {
      // A silent 500 here hid a ReferenceError for a whole release: the response
      // is identical whether the daemon failed or this handler did. traceRouteFailure
      // resolves error_subkind (daemon_timeout / daemon_offline / ...) and sanitizes
      // the message; never log payload, envVars or credentials.
      traceRouteFailure("agent.create.failed", err, {
        route_action: "create",
        http_status: 500,
        response_code: "internal_error",
        server_id: req.serverId,
      });
      console.error(
        "agent.create error:",
        `server=${req.serverId}`,
        err?.constructor?.name,
        sanitizeRouteErrorMessage(msg),
      );
      res.status(500).json({ error: "Failed to create agent" });
    }
  }
});

agentRouter.get("/:id/onboarding-identity-adoption", async (req, res) => {
  try {
    const [server, agent] = await Promise.all([
      serverService.getServer(req.serverId!),
      agentService.getAgent(req.params.id),
    ]);
    if (!agent || agent.serverId !== req.serverId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    if (!await currentUserCanActOnAgent(req.serverId!, req.userId!, agent, "editAgents")) {
      res.status(403).json({ error: "The `editAgents` capability or human creator authority is required to edit agents" });
      return;
    }
    if (server?.onboardingAgentId !== agent.id) {
      res.status(400).json({ error: "Agent is not this server's onboarding agent" });
      return;
    }

    const currentServerRole = await getActorServerRoleInServer(req.serverId!, "agent", agent.id);
    res.json(buildOfficialOnboardingIdentityAdoption(agent, currentServerRole));
  } catch {
    res.status(500).json({ error: "Failed to load onboarding identity adoption" });
  }
});

agentRouter.post("/:id/onboarding-identity-adoption", async (req, res) => {
  try {
    const [server, existing] = await Promise.all([
      serverService.getServer(req.serverId!),
      agentService.getAgent(req.params.id),
    ]);
    if (!existing || existing.serverId !== req.serverId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    if (!await currentUserCanActOnAgent(req.serverId!, req.userId!, existing, "editAgents")) {
      res.status(403).json({ error: "The `editAgents` capability or human creator authority is required to edit agents" });
      return;
    }
    if (server?.onboardingAgentId !== existing.id) {
      res.status(400).json({ error: "Agent is not this server's onboarding agent" });
      return;
    }

    const currentServerRole = await getActorServerRoleInServer(req.serverId!, "agent", existing.id);
    const adoption = buildOfficialOnboardingIdentityAdoption(existing, currentServerRole);
    const updated = adoption.canAdopt
      ? await agentService.adoptOfficialOnboardingAgentIdentity(req.serverId!, existing.id, OFFICIAL_ONBOARDING_AGENT_IDENTITY)
      : existing;
    if (!updated) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const runtimeProfile = await agentRuntimeProfileService.getAgentRuntimeProfileSummary(updated.id);
    const projectedServerRole = await getActorServerRoleInServer(req.serverId!, "agent", updated.id);
    const agent = await agentService.enrichAgentWithCreatorProfile({
      ...withServerRoleProjection(withAgentProjection(updated), projectedServerRole),
      runtimeProfile,
    });
    res.json({
      ...buildOfficialOnboardingIdentityAdoption(updated, projectedServerRole),
      appliedChanges: adoption.changes,
      agent,
    });
  } catch (err: unknown) {
    if (isPrincipalHandleConflictError(err)) {
      res.status(409).json({ error: err instanceof Error ? err.message : "Agent name is already taken" });
      return;
    }
    res.status(500).json({ error: "Failed to adopt onboarding identity" });
  }
});

// Get agent (includes deleted agents for profile viewing)
agentRouter.get("/:id", async (req, res) => {
  try {
    const agent = await agentService.getAgent(req.params.id, true);
    const canViewViaJoint = agent && agent.serverId !== req.serverId
      ? await channelService.canUserSeeAgentThroughJointChannel(req.serverId!, req.userId!, agent.id)
      : false;
    if (!agent || (agent.serverId !== req.serverId && !canViewViaJoint)) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const callerRole = agent.serverId === req.serverId
      ? await getActorServerRoleInServer(req.serverId!, "user", req.userId!)
      : null;
    if (
      callerRole === "guest"
      && !await channelService.canUserSeeAgentThroughLocalChannel(req.serverId!, req.userId!, agent.id)
    ) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const canManage = agent.serverId === req.serverId
      && userCanActOnAgentResource(callerRole, req.userId!, agent, "editAgents");
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    const { activity, activityDetail } = await agentOrchestrator.getActivity(agent.id, {
      parent: getCurrentTraceContext(),
    });
    if (canViewViaJoint) {
      const sourceServer = await serverService.getServer(agent.serverId);
      res.json(toJointAgentProfile({
        ...agent,
        serverName: sourceServer?.name ?? null,
        serverSlug: sourceServer?.slug ?? null,
        activity,
        activityDetail,
      }));
      return;
    }
    if (callerRole === "guest") {
      res.json(toGuestChannelAgentProfile({ ...agent, activity, activityDetail }));
      return;
    }
    const runtimeProfile = await agentRuntimeProfileService.getAgentRuntimeProfileSummary(agent.id);
    const serverRole = await getActorServerRoleInServer(req.serverId!, "agent", agent.id);
    const result = await agentService.enrichAgentWithCreatorProfile({
      ...withServerRoleProjection(withAgentProjection(agent), serverRole),
      activity,
      activityDetail,
      runtimeProfile,
    });
    res.json(canManage ? result : stripEnvVars(result));
  } catch {
    res.status(500).json({ error: "Failed to get agent" });
  }
});

agentRouter.get("/:id/runtime-options", async (req, res) => {
  try {
    if (!await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "viewAgents")) {
      res.status(403).json({ error: "The `viewAgents` capability is required to inspect runtime options" });
      return;
    }
    const agent = await agentService.getAgent(req.params.id);
    if (!agent || agent.serverId !== req.serverId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const machine = agent.machineId
      ? await machineService.getMachine(asMachineId(agent.machineId))
      : null;
    const policy = await resolveRuntimeAdmissionPolicy({
      userId: req.userId!,
      serverId: req.serverId!,
    });
    res.json({
      context: "existing_agent",
      machineId: machine?.serverId === req.serverId ? machine.id : null,
      options: projectExistingAgentRuntimeOptions(
        machine?.serverId === req.serverId ? machine.runtimes ?? [] : [],
        agent.runtime,
        policy,
      ),
    });
  } catch {
    res.status(500).json({ error: "Failed to load runtime options" });
  }
});

// External setup status is derived from active credential state. It is an
// identity/setup signal, not runtime liveness for an external process.
agentRouter.get("/:id/external-status", async (req, res) => {
  try {
    const agent = await agentService.getAgent(req.params.id);
    if (!agent || agent.serverId !== req.serverId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    if (!isExternalAgentRuntime(agent.runtime)) {
      res.status(400).json({ error: "Agent is not external" });
      return;
    }
    if (!await canInspectAgentPrivateSurfaces(req.serverId!, req.userId!, agent)) {
      res.status(403).json({ error: "The `editAgents` capability or human creator authority is required to view external setup status" });
      return;
    }
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    const credential = await getLatestActiveAgentCredential(agent.id);
    const setupState = credential
      ? credential.lastUsedAt
        ? "connected"
        : "credential_minted"
      : "waiting_for_login";
    const recentActivity = await agentOrchestrator.listRecentActivityLog(agent.id, 1);
    const lastActivityAt = recentActivity.length > 0 ? recentActivity[0].timestamp : null;
    res.json({
      setupState,
      credentialLastUsedAt: credential?.lastUsedAt ? credential.lastUsedAt.toISOString() : null,
      lastActivityAt,
    });
  } catch {
    res.status(500).json({ error: "Failed to get external agent status" });
  }
});

// Get recent durable activity/trajectory log for an agent
agentRouter.get("/:id/activity-log", async (req, res) => {
  try {
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    const agent = await agentService.getAgent(req.params.id, true);
    if (!agent || agent.serverId !== req.serverId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    if (!await canInspectAgentPrivateSurfaces(req.serverId!, req.userId!, agent)) {
      res.status(403).json({ error: "The `editAgents` capability or human creator authority is required to view agent activity" });
      return;
    }

    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 200)) : 50;
    const entries = await agentOrchestrator.listRecentActivityLog(agent.id, limit);
    res.json(entries);
  } catch {
    res.status(500).json({ error: "Failed to load activity log" });
  }
});

agentRouter.get("/:id/agent-dms", async (req, res) => {
  try {
    const agent = await agentService.getAgent(req.params.id, true);
    if (!agent || agent.serverId !== req.serverId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    if (!await canInspectAgentPrivateSurfaces(req.serverId!, req.userId!, agent)) {
      res.status(403).json({ error: "The `editAgents` capability or human creator authority is required to view agent DMs" });
      return;
    }

    const conversations = await channelService.listAgentToAgentDMsForAgent(req.serverId!, agent.id);
    res.json(conversations);
  } catch {
    res.status(500).json({ error: "Failed to load agent DMs" });
  }
});

agentRouter.get("/:id/channels", async (req, res) => {
  try {
    const agent = await agentService.getAgent(req.params.id, true);
    if (!agent || agent.serverId !== req.serverId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    if (!await canInspectAgentPrivateSurfaces(req.serverId!, req.userId!, agent)) {
      res.status(403).json({ error: "The `editAgents` capability or human creator authority is required to view agent channels" });
      return;
    }

    const channels = await channelService.getAgentChannels(agent.id, req.userId!);
    res.json(channels);
  } catch {
    res.status(500).json({ error: "Failed to load agent channels" });
  }
});

// Update agent profile
agentRouter.patch("/:id", async (req, res) => {
  try {
    const existing = await agentService.getAgent(req.params.id);
    if (!existing || existing.serverId !== req.serverId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    if (!await currentUserCanActOnAgent(req.serverId!, req.userId!, existing, "editAgents")) {
      res.status(403).json({ error: "The `editAgents` capability or human creator authority is required to edit agents" });
      return;
    }
    const { displayName, description, avatarUrl, model, runtime, runtimeConfig, formDefinitionRef, reasoningEffort, envVars, restartMode, serverRole: requestedServerRole } = req.body;
    if (isExternalAgentRuntime(existing.runtime) && isManagedRuntimeFieldTouched(req.body ?? {})) {
      res.status(400).json({ error: "External agent runtime fields are immutable" });
      return;
    }
    if (description !== undefined && description !== null && (typeof description !== "string" || description.length > MAX_AGENT_DESCRIPTION_LENGTH)) {
      res.status(400).json({ error: `Description must be a string of at most ${MAX_AGENT_DESCRIPTION_LENGTH} characters` });
      return;
    }
    if (runtime !== undefined && typeof runtime !== "string") {
      res.status(400).json({ error: "Runtime must be a string" });
      return;
    }
    if (runtime !== undefined) {
      const validRuntimeIds = new Set(RUNTIMES.filter((r) => r.supported).map((r) => r.id));
      if (!validRuntimeIds.has(runtime)) {
        res.status(400).json({ error: `Invalid runtime: ${runtime}` });
        return;
      }
    }
    // Validate reasoningEffort if provided (null is valid — clears the value)
    if (reasoningEffort != null) {
      const validEffortIds = new Set<string>(REASONING_EFFORTS.map((r) => r.id));
      const targetRuntime = runtime ?? existing.runtime;
      if (targetRuntime !== "kimi-sdk" && !validEffortIds.has(reasoningEffort)) {
        res.status(400).json({ error: `Invalid reasoning effort: ${reasoningEffort}` });
        return;
      }
    }
    if (restartMode !== undefined && restartMode !== "restart" && restartMode !== "session") {
      res.status(400).json({ error: `Invalid restart mode: ${restartMode}` });
      return;
    }
    let nextServerRole: ManageableAgentServerRole | undefined;
    if (requestedServerRole !== undefined) {
      if (requestedServerRole !== "admin" && requestedServerRole !== "member") {
        res.status(400).json({ error: "Role must be admin or member" });
        return;
      }
      nextServerRole = requestedServerRole;
      const callerRole = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
      if (!actorRoleHasServerCapability(callerRole, "changeMemberRoles")) {
        res.status(403).json({ error: "The `changeMemberRoles` capability is required to change agent roles" });
        return;
      }
      const targetRole = await getActorServerRoleInServer(req.serverId!, "agent", existing.id);
      if (!targetRole) {
        res.status(404).json({ error: "Agent server membership not found" });
        return;
      }
      if (!actorCanChangeServerMemberRole(callerRole, targetRole, requestedServerRole)) {
        res.status(403).json({ error: "You are not allowed to make that role change" });
        return;
      }
    }
    // Validate avatarUrl if provided (null is valid — clears to pixel avatar)
    if (avatarUrl !== undefined && avatarUrl !== null) {
      const isPixel = avatarUrl.startsWith("pixel:");
      const isRelativeAvatar = /^\/api\/avatars\/[0-9a-f-]+\/[0-9a-f]+\.webp$/.test(avatarUrl);
      const cdnBaseUrl = process.env.CDN_BASE_URL;
      const isCdnUrl = cdnBaseUrl && avatarUrl.startsWith(cdnBaseUrl);
      if (!isPixel && !isRelativeAvatar && !isCdnUrl) {
        res.status(400).json({ error: "Invalid avatar URL" });
        return;
      }
    }
    // Parse envVars only when an actual value is provided. Update semantics are
    // preserved exactly: undefined = "not provided, keep existing"; null =
    // "clear"; an object = "set" (parsed into a typed map here).
    let parsedUpdateEnvVars: UserEnvVars | null = null;
    if (envVars !== undefined && envVars !== null) {
      const result = parseEnvVars(envVars);
      if (!result.ok) {
        res.status(400).json({ error: result.reason });
        return;
      }
      parsedUpdateEnvVars = result.value;
    }
    const runtimeConfigTouched = runtimeConfig !== undefined
      || runtime !== undefined
      || model !== undefined
      || reasoningEffort !== undefined
      || envVars !== undefined;
    const rawUpdatedRuntime = runtimeConfig && typeof runtimeConfig === "object" && !Array.isArray(runtimeConfig)
      ? (runtimeConfig as Record<string, unknown>).runtime
      : runtime ?? existing.runtime;
    const updatedRuntime = typeof rawUpdatedRuntime === "string" ? rawUpdatedRuntime.trim() : rawUpdatedRuntime;
    const existingRuntimeConfig = hydrateRuntimeConfig(existing);
    let requestRuntimeConfig = runtimeConfig;
    if (runtimeConfigTouched && updatedRuntime === "kimi-sdk" && formDefinitionRef === undefined) {
      if (reasoningEffort !== undefined && reasoningEffort !== null) {
        sendKimiReasoningEffortUpgradeRequired(res, "/formDefinitionRef");
        return;
      }
      if (runtimeConfig !== undefined) {
        const legacyResult = retainLegacyKimiReasoningEffort(runtimeConfig, existingRuntimeConfig);
        if (!legacyResult.ok) {
          sendKimiReasoningEffortUpgradeRequired(
            res,
            "/formDefinitionRef",
            "Update Raft on this device, then reselect the Kimi model and reasoning setting",
          );
          return;
        }
        requestRuntimeConfig = legacyResult.runtimeConfig;
      } else if (
        existingRuntimeConfig.runtime === "kimi-sdk"
        && existingRuntimeConfig.reasoningEffort !== null
        && model !== undefined
        && model !== runtimeConfigModelValue(existingRuntimeConfig)
      ) {
        sendKimiReasoningEffortUpgradeRequired(
          res,
          "/formDefinitionRef",
          "Update Raft on this device, then reselect the Kimi model and reasoning setting",
        );
        return;
      }
    }
    if (formDefinitionRef !== undefined) {
      const refIssues = validateRuntimeFormDefinitionRef(formDefinitionRef);
      if (refIssues.length > 0) {
        res.status(409).json({ error: "Runtime form definition is stale or invalid", issues: refIssues });
        return;
      }
      if ((formDefinitionRef as { runtimeId?: unknown }).runtimeId !== updatedRuntime) {
        res.status(400).json({
          error: "Runtime configuration does not match form definition",
          issues: [{ code: "form_runtime_mismatch", pointer: "/runtimeConfig/runtime" }],
        });
        return;
      }
    }
    const normalizedConfig = runtimeConfigTouched
      ? normalizeRequestRuntimeConfig({
          runtimeConfig: requestRuntimeConfig !== undefined
            ? retainOmittedBuiltInProviderSecret(requestRuntimeConfig, existingRuntimeConfig)
            : existing.runtimeConfig,
          runtime: runtime ?? existing.runtime,
          model: model ?? existing.model,
          reasoningEffort: reasoningEffort !== undefined ? reasoningEffort : existing.reasoningEffort,
          // undefined => keep existing; null => clear; value => the parsed map.
          envVars: envVars === undefined ? existing.envVars : parsedUpdateEnvVars,
          envVarsExplicit: envVars !== undefined,
        })
      : null;
    if (normalizedConfig?.error || (normalizedConfig && (!normalizedConfig.launch || !normalizedConfig.runtimeConfig))) {
      res.status(400).json({ error: normalizedConfig.error });
      return;
    }
    const normalizedLaunch = normalizedConfig?.launch ?? null;
    if (normalizedLaunch && isRuntimeDeprecated(normalizedLaunch.runtime) && normalizedLaunch.runtime !== existing.runtime) {
      res.status(400).json({ error: deprecatedRuntimeSelectionError(normalizedLaunch.runtime) });
      return;
    }
    if (
      normalizedLaunch?.runtime === "grok"
      && existing.runtime !== "grok"
      && !(await resolveRuntimeAdmissionPolicy({
        userId: req.userId!,
        serverId: req.serverId!,
      })).grokRuntimeEnabled
    ) {
      sendGrokRuntimeDisabled(res);
      return;
    }
    if (normalizedLaunch?.runtime === "grok") {
      const machine = existing.machineId
        ? await machineService.getMachine(asMachineId(existing.machineId))
        : null;
      if (!machine || machine.serverId !== req.serverId || !machineSupportsRuntime(machine.runtimes, "grok")) {
        sendRuntimeCapabilityUnavailable(res, "grok");
        return;
      }
    }
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    if (normalizedConfig?.runtimeConfig?.runtime === "kimi-sdk") {
      if (!existing.machineId) {
        res.status(409).json({
          error: "Kimi model validation requires an assigned computer",
          issues: [{ code: "runtime_model_source_unavailable", pointer: "/machineId" }],
        });
        return;
      }
      let detected: Awaited<ReturnType<AgentOrchestrator["detectMachineRuntimeModels"]>> | null = null;
      try {
        detected = await agentOrchestrator.detectMachineRuntimeModels(existing.machineId, "kimi-sdk");
      } catch (error) {
        if (!(error instanceof RouteFailureError)
          || (error.subkind !== "daemon_timeout" && error.subkind !== "daemon_offline")) throw error;
        if (normalizedConfig.launch!.reasoningEffort !== null) {
          sendKimiModelDetectUnavailable(res, error, "update", req.serverId);
          return;
        }
      }
      // PRODUCT DECISION (@artin, 2026-09-06, #proj-uiux:8cf7b0a7): supporting Computers
      // older than 1.0.25 outranks giving an actionable creation-time error. Those
      // Computers DO implement the detect call (handler landed 2026-04-14, #768 --
      // earlier than every computer-v1.0.x tag), so they *answer*; a machine whose Kimi
      // is simply not logged in answers `missing_config` and would be refused here.
      // Refusing it is what @artin rejected. So an answered non-live result is downgraded
      // exactly as v1.12.2 does in production -- with `unsupported` still kept as a 409.
      // Cost accepted by @artin: a not-logged-in user creates successfully and only sees
      // the failure at runtime. ⛔ Do not re-narrow this without asking him.
      if (detected && detected.kind !== "live") {
        if (normalizedConfig.launch!.reasoningEffort !== null || detected.kind === "unsupported") {
          res.status(409).json({
            error: "Kimi model source is unavailable",
            issues: [{ code: `runtime_model_source_${detected.kind}`, pointer: "/runtimeConfig/model" }],
          });
          return;
        }
        detected = null;
      }
      if (detected?.kind === "live") {
        if (
          normalizedConfig.launch!.reasoningEffort !== null
          && !kimiModelPublishesReasoningCapability(
            detected.value.models,
            normalizedConfig.launch!.model,
            normalizedConfig.launch!.reasoningEffort,
          )
        ) {
          const selectedModel = detected.value.models.find((candidate) => candidate.id === normalizedConfig.launch!.model);
          if (selectedModel && !selectedModel.supportedReasoningEfforts?.length) {
            sendKimiReasoningEffortUpgradeRequired(res, "/runtimeConfig/reasoningEffort", "Update Raft on the selected computer before using Kimi reasoning settings");
            return;
          }
        }
        const selectionIssues = validateKimiSdkSelection({
          source: buildKimiSdkFormOptionSource({ models: detected.value.models, defaultModel: detected.value.default }),
          model: normalizedConfig.launch!.model,
          reasoningEffort: normalizedConfig.launch!.reasoningEffort,
        });
        if (selectionIssues.length > 0) {
          res.status(400).json({ error: "Kimi runtime selection is invalid", issues: selectionIssues });
          return;
        }
      }
    }

    const normalizedRuntimeConfig = normalizedConfig?.runtimeConfig ?? null;
    let providerConnection = null;
    if (
      normalizedRuntimeConfig?.runtime === "builtin"
      && normalizedRuntimeConfig.provider.kind === "connection"
    ) {
      if (!await isProviderConnectionsEnabled(req.serverId!)) {
        sendProviderConnectionsDisabled(res);
        return;
      }
      providerConnection = await resolveProviderConnectionSelection(
        req.serverId!,
        normalizedRuntimeConfig.provider.connectionId,
      );
    }
    if (providerConnection && normalizedRuntimeConfig?.runtime === "builtin") {
      assertProviderConnectionModelCompatible(providerConnection.providerId, normalizedRuntimeConfig.model);
    }
    let releaseCatalogAuthority: () => void = () => undefined;
    if (
      normalizedRuntimeConfig?.runtime === "builtin" &&
      normalizedRuntimeConfig.provider.kind === "preset" &&
      normalizedRuntimeConfig.model.kind === "preset" &&
      builtInPresetSelectionChanged(
        existingRuntimeConfig,
        normalizedRuntimeConfig,
      )
    ) {
      if (!existing.machineId) {
        res.status(409).json({
          error:
            "A target Computer is required to validate this Built-in model",
          code: "builtin_catalog_target_required",
          recovery: "select_computer",
        });
        return;
      }
      const routing = await handleMachineLocalRouting(
        req,
        res,
        existing.machineId,
        () => agentOrchestrator.hasMachineLocally(existing.machineId!),
      );
      if (routing === "handled") return;
      if (routing !== "confirmed_local") {
        sendBuiltInCatalogUnavailable(res);
        return;
      }
      const validation =
        await agentOrchestrator.validateBuiltInPresetForMachine(
          existing.machineId,
          normalizedRuntimeConfig,
        );
      if (validation) {
        releaseCatalogAuthority =
          agentOrchestrator.acquireBuiltInCatalogAuthority(
            existing.machineId,
            validation.authority,
          );
      }
    }
    const runtimeChanged = normalizedLaunch !== null && normalizedLaunch.runtime !== existing.runtime;
    const profileFieldsTouched = displayName !== undefined || description !== undefined || avatarUrl !== undefined;
    const updateAgentRow = profileFieldsTouched || runtimeChanged || normalizedConfig !== null;
    let updated: Awaited<ReturnType<typeof agentService.updateAgent>>;
    try {
      if (nextServerRole !== undefined) {
        const currentRole = await getActorServerRoleInServer(
          req.serverId!,
          "agent",
          existing.id,
        );
        if (currentRole && currentRole !== nextServerRole) {
          await serverService.updateAgentMemberRole(
            req.serverId!,
            existing.id,
            nextServerRole,
          );
        }
      }
      updated = updateAgentRow
        ? await agentService.updateAgent(req.params.id, {
            displayName,
            description,
            avatarUrl,
            ...(runtimeChanged ? { sessionId: null } : {}),
            ...(normalizedLaunch && normalizedRuntimeConfig
              ? {
                  model: normalizedLaunch.model,
                  runtime: normalizedLaunch.runtime,
                  runtimeConfig: normalizedRuntimeConfig,
                  reasoningEffort: persistedAgentReasoningEffort(
                    normalizedLaunch.runtime,
                    normalizedLaunch.reasoningEffort,
                  ),
                  envVars: normalizedConfig!.persistedEnvVars,
                  providerConnection: providerConnection
                    ? { ...providerConnection, updatedByUserId: req.userId! }
                    : null,
                }
              : {}),
          })
        : existing;
    } finally {
      releaseCatalogAuthority();
    }
    if (!updated) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const runtimeConfigChanged = normalizedRuntimeConfig !== null
      && JSON.stringify(normalizedRuntimeConfig) !== JSON.stringify(existingRuntimeConfig);
    const runtimeProfileIdentityChanged =
      runtimeChanged
      || (normalizedLaunch !== null && normalizedLaunch.model !== existing.model)
      || (normalizedLaunch !== null && (normalizedLaunch.reasoningEffort ?? null) !== (existing.reasoningEffort ?? null))
      || runtimeConfigChanged;
    if (restartMode && runtimeProfileIdentityChanged) {
      await agentRuntimeProfileService.queueRuntimeProfileMigrationForAgentSettings(req.params.id);
    }
    agentOrchestrator.evictCache(req.params.id);
    if (restartMode) {
      // Runtime switches intentionally reset the native runtime session. So does
      // a Codex MODEL switch (tygg/Tenny 2026-07-10): Codex `thread/resume` pins
      // the model of the resumed thread, so a plain restart keeps launching the
      // old model (root of the 5.5→5.6 switch-not-applying report). Clearing the
      // session (mode "session" → fresh `thread/start`) makes the new model take
      // effect 100%. A reasoning-effort-only change stays on the caller-selected
      // mode (restart is reliable: `thread/resume` + fresh `model_reasoning_effort`
      // applies per request). Codex-scoped; other runtimes keep the caller mode.
      // model+effort changing together still resets exactly once (session).
      // Server enforces this regardless of the client-sent mode — the client
      // warning is UX, the invariant lives here (source-of-truth, not the caller).
      const codexModelChanged =
        (normalizedLaunch?.runtime ?? existing.runtime) === "codex"
        && normalizedLaunch !== null
        && normalizedLaunch.model !== existing.model;
      const effectiveRestartMode = runtimeChanged || codexModelChanged ? "session" : restartMode;
      await agentOrchestrator.resetAgent(req.params.id, effectiveRestartMode, { restartIfStopped: false });
    }
    const runtimeProfile = await agentRuntimeProfileService.getAgentRuntimeProfileSummary(req.params.id);
    const refreshed = await agentService.getAgent(req.params.id) ?? updated;
    const projectedServerRole = await getActorServerRoleInServer(req.serverId!, "agent", refreshed.id);
    res.json(await agentService.enrichAgentWithCreatorProfile({
      ...withServerRoleProjection(withAgentProjection(refreshed), projectedServerRole),
      runtimeProfile,
    }));
  } catch (error) {
    if (error instanceof BuiltInModelCatalogError ||
      error instanceof MachineCatalogStaleError
    ) {
      sendBuiltInCatalogError(res, error);
      return;
    }
    if (error instanceof ProviderConnectionError) {
      res.status(error.code === "provider_connection_invalid" ? 400 : 409).json({ error: error.message, code: error.code });
      return;
    }
    traceRouteFailure("agent.update.failed", error, {
      route_action: "update",
      http_status: 500,
      response_code: "internal_error",
      server_id: req.serverId,
      agent_id: req.params.id,
    });
    console.error(
      "agent.update error:",
      `server=${req.serverId} agent=${req.params.id}`,
      (error as Error)?.constructor?.name,
      sanitizeRouteErrorMessage((error as Error)?.message ?? ""),
    );
    res.status(500).json({ error: "Failed to update agent" });
  }
});

// Upload agent avatar
const avatarUpload = createAvatarUpload();

agentRouter.post("/:id/avatar", async (req, res) => {
  try {
    const agentId = req.params.id as string;
    const agent = await agentService.getAgent(agentId);
    if (!agent || agent.serverId !== req.serverId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    if (!await currentUserCanActOnAgent(req.serverId!, req.userId!, agent, "editAgents")) {
      res.status(403).json({ error: "The `editAgents` capability or human creator authority is required to edit agents" });
      return;
    }
    const file = await runSingleAvatarUpload(avatarUpload, req);
    if (!file) {
      res.status(400).json({ error: "No file provided" });
      return;
    }
    const avatarUrl = await storeAgentAvatar(req.serverId!, agent.avatarUrl, file.buffer);

    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    agentOrchestrator.evictCache(agentId);
    const updated = await agentService.updateAgent(agentId, { avatarUrl });
    res.json(updated);
  } catch (err: any) {
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      res.status(400).json({
        error: PROFILE_AVATAR_TOO_LARGE_MESSAGE,
        errorCode: "PROFILE_AVATAR_TOO_LARGE",
        maxBytes: MAX_PROFILE_AVATAR_BYTES,
      });
      return;
    }
    if (err.message?.includes(PROFILE_AVATAR_BAD_FORMAT_MESSAGE)) {
      res.status(400).json({
        error: err.message,
        errorCode: "PROFILE_AVATAR_BAD_FORMAT",
      });
      return;
    }
    console.error("Avatar upload error:", err);
    res.status(500).json({ error: "Failed to upload avatar" });
  }
});

// Serve profile avatar (local dev fallback — in production, CDN serves directly)
agentAvatarRouter.get("/pixel/:encodedKey.svg", (req, res) => {
  const key = decodePixelAvatarKey(req.params.encodedKey);
  if (!key) {
    res.status(400).json({ error: "Invalid pixel avatar key" });
    return;
  }

  const svg = renderPixelAvatarSvg(key);
  if (!svg) {
    res.status(404).json({ error: "Pixel avatar not found" });
    return;
  }

  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.send(svg);
});

agentAvatarRouter.get("/:namespace/:filename", async (req, res) => {
  try {
    const { namespace, filename } = req.params;
    if (!/^[0-9a-f]+\.webp$/.test(filename)) {
      res.status(400).json({ error: "Invalid filename" });
      return;
    }
    // Uploaded profile avatars are written to the public CDN bucket when one
    // is configured. Keep the local/main bucket as a development fallback;
    // using only getStorage() makes the capture API return 500 for otherwise
    // valid CDN-backed human avatars.
    const storage = getCdnStorage();
    if (!storage) {
      res.status(500).json({ error: "Storage not configured" });
      return;
    }
    const storageKey = `avatars/${namespace}/${filename}`;
    const stream = await storage.get(storageKey);
    res.setHeader("Content-Type", "image/webp");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    await streamStorageResponse(stream, res);
  } catch {
    if (res.destroyed || res.headersSent) return;
    res.status(500).json({ error: "Failed to serve avatar" });
  }
});

// Owner-initiated no-card migration. The owner's click is the authorization;
// this route is the single identity/capability gate before any grant is minted.
agentRouter.get("/:id/migration", async (req, res) => {
  try {
    const flag = await evaluateFeatureFlag({
      key: AGENT_MIGRATION_FEATURE_FLAG_KEY,
      serverId: req.serverId!,
      userId: req.userId!,
    });
    if (!flag.enabled) {
      sendMigrationError(res, 403, "agent_migration_ui_disabled", "Agent migration UI is not enabled on this server");
      return;
    }

    const agent = await agentService.getAgent(req.params.id, true);
    if (!agent || agent.serverId !== req.serverId || agent.deletedAt) {
      sendMigrationError(res, 404, "AGENT_NOT_FOUND", "Agent not found");
      return;
    }
    if (!await currentUserCanActOnAgent(req.serverId!, req.userId!, agent, "migrateAgents")) {
      sendMigrationError(res, 403, "not_supported", "The `migrateAgents` capability or human creator authority is required to inspect agent migration status");
      return;
    }

    const migration = await agentMigrationService.getLatestAgentMigration(agent.id, undefined, currentDate());
    res.json({
      migration: migration ? serializeOwnerMigrationStatus(migration) : null,
    });
  } catch (err) {
    console.error("[agents] migration status error:", err);
    sendMigrationError(
      res,
      500,
      "MIGRATION_STATUS_FAILED",
      err instanceof Error ? err.message : "Failed to get migration status",
    );
  }
});

agentRouter.post("/:id/migration/cancel", async (req, res) => {
  try {
    const flag = await evaluateFeatureFlag({
      key: AGENT_MIGRATION_FEATURE_FLAG_KEY,
      serverId: req.serverId!,
      userId: req.userId!,
    });
    if (!flag.enabled) {
      sendMigrationError(res, 403, "agent_migration_ui_disabled", "Agent migration UI is not enabled on this server");
      return;
    }
    const agent = await agentService.getAgent(req.params.id, true);
    if (!agent || agent.serverId !== req.serverId || agent.deletedAt) {
      sendMigrationError(res, 404, "AGENT_NOT_FOUND", "Agent not found");
      return;
    }
    if (!await currentUserCanActOnAgent(req.serverId!, req.userId!, agent, "migrateAgents")) {
      sendMigrationError(res, 403, "not_supported", "The `migrateAgents` capability or human creator authority is required to cancel an agent migration");
      return;
    }
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, "migrationId")) {
      sendMigrationError(res, 400, "MIGRATION_REF_INVALID", "migrationId is not accepted; use migrationRef");
      return;
    }
    const migrationRefResult = agentMigrationSupportRefSchema.safeParse(req.body?.migrationRef);
    if (!migrationRefResult.success) {
      sendMigrationError(res, 400, "MIGRATION_REF_INVALID", "migrationRef is required");
      return;
    }
    const expectedRevision = req.body?.expectedRevision;
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      sendMigrationError(res, 400, "MIGRATION_REVISION_INVALID", "expectedRevision must be a positive integer");
      return;
    }

    const requested = await agentMigrationService.requestAgentMigrationCancellation({
      agentId: agent.id,
      migrationRef: migrationRefResult.data,
      expectedRevision,
      initiatedByUserId: req.userId!,
      reason: typeof req.body?.reason === "string" && req.body.reason.trim()
        ? req.body.reason.trim().slice(0, 200)
        : "owner_cancel",
    });
    const io = req.app.get("io") as SocketServer | undefined;
    await emitAgentMigrationUpdated(io, requested.migration);

    let current = requested.migration;
    if (requested.dispatch === "required") {
      const orchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
      const deliveries = agentMigrationService.buildAgentMigrationCancellationDeliveries(requested.migration);
      if (!orchestrator || typeof orchestrator.sendAgentMigrationCancel !== "function") {
        const sourceDelivery = deliveries.find((delivery) => delivery.message.role === "source")!;
        current = await agentMigrationService.acknowledgeAgentMigrationCancellation({
          migrationId: current.id,
          migrationRef: current.supportRef,
          transportGeneration: current.cancelTransportGeneration!,
          cancelGeneration: current.cancelGeneration!,
          serverId: current.serverId,
          machineId: sourceDelivery.machineId,
          role: "source",
          outcome: "needs_attention",
          errorCode: "cancel_dispatch_unavailable",
          errorMessage: "Migration cancellation dispatch is unavailable",
        });
        await emitAgentMigrationUpdated(io, current);
        res.status(current.state.startsWith("cancel_requested_") ? 202 : 200).json({
          migration: serializeOwnerMigrationStatus(current),
        });
        return;
      }
      const results = await Promise.allSettled(deliveries.map((delivery) =>
        orchestrator.sendAgentMigrationCancel(delivery.machineId, delivery.message)
      ));
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        if (result.status === "fulfilled") continue;
        const delivery = deliveries[index];
        current = await agentMigrationService.acknowledgeAgentMigrationCancellation({
          migrationId: current.id,
          migrationRef: current.supportRef,
          transportGeneration: current.cancelTransportGeneration!,
          cancelGeneration: current.cancelGeneration!,
          serverId: current.serverId,
          machineId: delivery.machineId,
          role: delivery.message.role,
          outcome: "needs_attention",
          errorCode: "cancel_dispatch_failed",
          errorMessage: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
        await emitAgentMigrationUpdated(io, current);
      }
    }

    res.status(current.state.startsWith("cancel_requested_") ? 202 : 200).json({
      migration: serializeOwnerMigrationStatus(current),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "MIGRATION_NOT_FOUND") {
      sendMigrationError(res, 404, "MIGRATION_NOT_FOUND", "Migration not found");
      return;
    }
    if (message === "MIGRATION_REVISION_STALE" || message === "MIGRATION_CONCURRENT_UPDATE") {
      sendMigrationError(res, 409, message, "Migration changed concurrently");
      return;
    }
    console.error("[agents] migration cancel error:", err);
    sendMigrationError(res, 500, "MIGRATION_CANCEL_FAILED", "Failed to request migration cancellation");
  }
});

agentRouter.post("/:id/migrate", async (req, res) => {
  try {
    const flag = await evaluateFeatureFlag({
      key: AGENT_MIGRATION_FEATURE_FLAG_KEY,
      serverId: req.serverId!,
      userId: req.userId!,
    });
    if (!flag.enabled) {
      sendMigrationError(res, 403, "agent_migration_ui_disabled", "Agent migration UI is not enabled on this server");
      return;
    }

    const subjectAgent = await agentService.getAgent(req.params.id);
    if (!subjectAgent || subjectAgent.serverId !== req.serverId) {
      sendMigrationError(res, 404, "AGENT_NOT_FOUND", "Agent not found");
      return;
    }
    if (!await currentUserCanActOnAgent(req.serverId!, req.userId!, subjectAgent, "migrateAgents")) {
      sendMigrationError(res, 403, "not_supported", "The `migrateAgents` capability or human creator authority is required to start an agent migration");
      return;
    }

    const targetComputer = typeof req.body?.targetComputer === "string" ? req.body.targetComputer.trim() : "";
    if (!targetComputer) {
      sendMigrationError(res, 400, "TARGET_COMPUTER_REQUIRED", "targetComputer is required");
      return;
    }

    const db = getDb();
    const now = currentDate();
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    const validation = await db.transaction(async (tx) => {
      const [agent] = await tx
        .select()
        .from(agents)
        .where(and(eq(agents.id, req.params.id), eq(agents.serverId, req.serverId!), isNull(agents.deletedAt)))
        .limit(1);
      if (!agent) {
        return { status: 404, code: "AGENT_NOT_FOUND", error: "Agent not found" } as const;
      }
      if (!agent.machineId) {
        return { status: 409, code: "AGENT_HAS_NO_SOURCE_MACHINE", error: "Agent has no source computer" } as const;
      }

      const [sourceMachine] = await tx
        .select()
        .from(machines)
        .where(and(eq(machines.id, agent.machineId), eq(machines.serverId, req.serverId!)))
        .limit(1);
      const [targetMachine] = await tx
        .select()
        .from(machines)
        .where(and(
          eq(machines.serverId, req.serverId!),
          isUuid(targetComputer)
            ? or(eq(machines.id, targetComputer), eq(machines.name, targetComputer))
            : eq(machines.name, targetComputer),
        ))
        .limit(1);
      if (!targetMachine) {
        return { status: 422, code: "TARGET_COMPUTER_NOT_IN_SERVER", error: "Target computer is not in this server" } as const;
      }
      if (targetMachine.id === agent.machineId) {
        return { status: 409, code: "TARGET_COMPUTER_MATCHES_SOURCE", error: "Target computer matches the source computer" } as const;
      }
      if (!sourceMachine) {
        return { status: 409, code: "AGENT_HAS_NO_SOURCE_MACHINE", error: "Agent source computer is not available" } as const;
      }

      const sourceDaemonVersion = agentOrchestrator?.getMachineDaemonVersion(agent.machineId) ?? sourceMachine.daemonVersion;
      const targetDaemonVersion = agentOrchestrator?.getMachineDaemonVersion(targetMachine.id) ?? targetMachine.daemonVersion;
      const capabilityFailures = computerCapabilityFailures({
        sourceDaemonVersion,
        targetDaemonVersion,
        sourceRuntimes: sourceMachine.runtimes,
        targetRuntimes: targetMachine.runtimes,
        runtime: agent.runtime,
      });
      if (capabilityFailures.length > 0) {
        return {
          status: 422,
          code: "COMPUTER_CAPABILITY_INSUFFICIENT",
          error: `Both source and target computers must run daemon >= ${MIN_MIGRATION_DAEMON_VERSION} with compatible runtime support`,
          details: { failures: capabilityFailures },
        } as const;
      }

      const [sourceMigrationTransport, targetMigrationTransport] = await Promise.all([
        agentOrchestrator?.getMachineMigrationTransport(sourceMachine.id) ?? null,
        agentOrchestrator?.getMachineMigrationTransport(targetMachine.id) ?? null,
      ]);
      const capabilityDetail = resumableCapabilityDetail(
        sourceMigrationTransport,
        targetMigrationTransport,
      );
      if (capabilityDetail) {
        return {
          status: 422,
          code: "MIGRATION_RESUMABLE_CAPABILITY_REQUIRED",
          error: "Both source and target computers must advertise the resumable migration protocol; mixed or old versions cannot downgrade",
          details: capabilityDetail,
        } as const;
      }

      const targetStatus = agentOrchestrator ? await agentOrchestrator.getMachineStatus(targetMachine.id) : "offline";
      const heartbeatFresh = Boolean(
        targetMachine.lastHeartbeat &&
        now.getTime() - targetMachine.lastHeartbeat.getTime() <= MIGRATION_MACHINE_ONLINE_MAX_AGE_MS,
      );
      if (targetStatus !== "online" || !heartbeatFresh) {
        return { status: 409, code: "TARGET_COMPUTER_OFFLINE", error: "Target computer is not online" } as const;
      }

      const [activeMigration] = await tx
        .select({ id: agentMigrations.id })
        .from(agentMigrations)
        .where(and(
          eq(agentMigrations.agentId, agent.id),
          inArray(agentMigrations.state, [...agentMigrationService.ACTIVE_AGENT_MIGRATION_STATES]),
        ))
        .limit(1);
      if (activeMigration) {
        return { status: 409, code: "MIGRATION_ALREADY_IN_PROGRESS", error: "Agent already has an active migration" } as const;
      }

      return {
        validated: {
          agentId: agent.id,
          targetMachineId: targetMachine.id,
          runtimeConfig: hydrateRuntimeConfig(agent),
        },
      } as const;
    });

    if (!("validated" in validation) || !validation.validated) {
      const failure = validation;
      sendMigrationError(
        res,
        failure.status,
        failure.code,
        failure.error,
        "details" in failure ? failure.details : undefined,
      );
      return;
    }
    const validatedMigration = validation.validated;
    let releaseCatalogAuthority: () => void = () => undefined;
    if (
      validatedMigration.runtimeConfig.runtime === "builtin" &&
      validatedMigration.runtimeConfig.provider.kind === "preset" &&
      validatedMigration.runtimeConfig.model.kind === "preset"
    ) {
      if (!agentOrchestrator) {
        sendBuiltInCatalogUnavailable(res);
        return;
      }
      const routing = await handleMachineLocalRouting(
        req,
        res,
        validatedMigration.targetMachineId,
        () =>
          agentOrchestrator.hasMachineLocally(
            validatedMigration.targetMachineId,
          ),
      );
      if (routing === "handled") return;
      if (routing !== "confirmed_local") {
        sendBuiltInCatalogUnavailable(res);
        return;
      }
      const catalogValidation =
        await agentOrchestrator.validateBuiltInPresetForMachine(
          validatedMigration.targetMachineId,
          validatedMigration.runtimeConfig,
        );
      if (catalogValidation) {
        releaseCatalogAuthority =
          agentOrchestrator.acquireBuiltInCatalogAuthority(
            validatedMigration.targetMachineId,
            catalogValidation.authority,
          );
      }
    }

    try {

    // Preserve the existing feature-flag, owner/admin, target, capability,
    // online, and active-migration error precedence. The paywall is the final
    // start-only gate before any transport is provisioned or grant is minted.
    try {
      await requireTeamBillingFeature(db, req.serverId!, "Agent migration", now);
    } catch (err) {
      if (err instanceof Error && err.message === "Agent migration requires the Pro plan.") {
        sendMigrationError(res, 403, "MIGRATION_PRO_PLAN_REQUIRED", err.message);
        return;
      }
      throw err;
    }
    let transferProvision: agentMigrationService.AgentMigrationObjectStoreTransferProvision;
    try {
      transferProvision = await getMigrationTransferProvisioner(req)();
    } catch (err) {
      sendMigrationError(
        res,
        422,
        "MIGRATION_TRANSPORT_PROVISION_FAILED",
        err instanceof Error ? err.message : "Failed to provision migration transfer lease",
      );
      return;
    }

    const out = await db.transaction(async (tx) => {
      try {
        const provisioning = await agentMigrationService.beginAgentMigrationProvisioning({
          agentId: validatedMigration.agentId,
          targetMachineId: validatedMigration.targetMachineId,
          initiatedByUserId: req.userId!,
          now,
          transportProvider: transferProvision.provider,
          transportSessionId: transferProvision.sessionId,
          sourceTransferUrl: transferProvision.sourceTransferUrl,
          targetTransferUrl: transferProvision.targetTransferUrl,
          transportLeaseMs: transferProvision.leaseMs,
          transportMaxBytes: transferProvision.maxBytes,
        }, tx);
        assertMigrationTransferLeaseReady({
          migration: provisioning.migration,
          source: provisioning.source,
          target: provisioning.target,
          now,
        });
        return { provisioning } as const;
      } catch (err) {
        const message = err instanceof Error ? err.message : "";
        if (/idx_agent_migrations_active_agent|duplicate key|constraint/i.test(message)) {
          return { status: 409, code: "MIGRATION_ALREADY_IN_PROGRESS", error: "Agent already has an active migration" } as const;
        }
        throw err;
      }
    });

    const provisioning = "provisioning" in out ? out.provisioning : null;
    if (provisioning) {
      const io = req.app.get("io") as SocketServer | undefined;
      await emitAgentMigrationUpdated(io, provisioning.migration);
      try {
        await Promise.all([
          agentOrchestrator?.sendAgentMigrationTransportLease(provisioning.source.machineId, provisioning.source.message),
          agentOrchestrator?.sendAgentMigrationTransportLease(provisioning.target.machineId, provisioning.target.message),
        ]);
      } catch (err) {
        const failed = await agentMigrationService.markAgentMigrationTransportProvisionFailed({
          migrationId: provisioning.migration.id,
          message: err instanceof Error ? err.message : "Failed to send migration transfer lease",
        });
        if (failed) await emitAgentMigrationUpdated(io, failed);
        sendMigrationError(
          res,
          422,
          "MIGRATION_TRANSPORT_PROVISION_FAILED",
          err instanceof Error ? err.message : "Failed to send migration transfer lease",
        );
        return;
      }
      const migration = provisioning.migration;
      res.json({
        migrationRef: migration.supportRef,
        state: migration.state,
        sourceMachineId: migration.sourceMachineId,
        targetMachineId: migration.targetMachineId,
        prepDeadlineAt: migration.prepDeadlineAt.toISOString(),
        transferDeadlineAt: migration.transferDeadlineAt.toISOString(),
        arrivalDeadlineAt: migration.arrivalDeadlineAt.toISOString(),
      });
      return;
    }
    if ("status" in out && typeof out.status === "number") {
      sendMigrationError(res, out.status, out.code, out.error);
      return;
    }
    throw new Error("Migration start returned no provisioning or failure result");
    } finally {
      releaseCatalogAuthority();
    }
  } catch (err: unknown) {
    if (
      err instanceof BuiltInModelCatalogError ||
      err instanceof MachineCatalogStaleError
    ) {
      sendBuiltInCatalogError(res, err);
      return;
    }
    if (err instanceof MigrationRoutePreflightError) {
      sendMigrationError(res, err.status, err.code, err.message);
      return;
    }
    console.error("[agents] migrate error:", err);
    sendMigrationError(
      res,
      500,
      "MIGRATION_START_FAILED",
      err instanceof Error ? err.message : "Failed to start migration",
    );
  }
});

// Start agent (routes to machine via agentOrchestrator)
agentRouter.post("/:id/start", async (req, res) => {
  try {
    const agent = await agentService.getAgent(req.params.id);
    if (!agent || agent.serverId !== req.serverId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    if (!await currentUserCanActOnAgent(req.serverId!, req.userId!, agent, "controlAgentRuntime")) {
      res.status(403).json({ error: "The `controlAgentRuntime` capability or human creator authority is required to control agents" });
      return;
    }
    if (isExternalAgentRuntime(agent.runtime)) {
      respondExternalManagedLifecycleUnsupported(res);
      return;
    }
    if (!agent.machineId) {
      addTraceEvent("agent.start.rejected", {
        reason: "machine_unassigned",
        http_status: 409,
      });
      res.status(409).json({ error: "No machine assigned. Please assign a machine to this agent first.", code: "machine_unassigned" });
      return;
    }
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    if (agent.machineId) {
      const routing = await handleMachineLocalRouting(
        req,
        res,
        agent.machineId,
        () => agentOrchestrator.hasMachineLocally(agent.machineId!),
      );
      if (routing === "handled") return;
      if (routing !== "confirmed_local") {
        sendMachineAffinityUnavailable(res, agent.machineId);
        return;
      }
    }
    const startResult = await agentOrchestrator.startAgent(req.params.id);
    const migration = startResult.outcome === "dispatched"
      ? await agentMigrationService.getLatestAgentMigration(agent.id, undefined, currentDate())
      : null;
    if (migration?.state === "starting" && migration.targetMachineId === agent.machineId) {
      const completed = await agentMigrationService.completeAgentMigrationAutoStart({
        grantKey: migration.grantKey,
        agentId: agent.id,
        targetMachineId: migration.targetMachineId,
      });
      await emitAgentMigrationUpdated(req.app.get("io") as SocketServer | undefined, completed);
    }
    const io = req.app.get("io") as SocketServer | undefined;
    if (io) {
      void onboardingService
        .triggerOwnerOnboardingOnAgentActivation(io, agentOrchestrator, req.serverId!, req.params.id)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[Onboarding] Failed to trigger owner onboarding for started agent ${req.params.id}: ${msg}`);
        });
    }
    res.json({ ok: true });
  } catch (err: any) {
    if (
      err instanceof BuiltInModelCatalogError ||
      err instanceof MachineCatalogStaleError
    ) {
      sendBuiltInCatalogError(res, err);
      return;
    }
    const failure = responseForAgentRouteFailure(err);
    traceRouteFailure("agent.start.failed", err, {
      route_action: "start",
      http_status: failure.status,
      response_code: failure.code,
    });
    res.status(failure.status).json({
      error: failure.status >= 500 && failure.code === "internal_error"
        ? "Failed to start agent"
        : err.message || "Failed to start agent",
      code: failure.code,
    });
  }
});

// Stop agent
agentRouter.post("/:id/stop", async (req, res) => {
  try {
    const agent = await agentService.getAgent(req.params.id);
    if (!agent || agent.serverId !== req.serverId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    if (!await currentUserCanActOnAgent(req.serverId!, req.userId!, agent, "controlAgentRuntime")) {
      res.status(403).json({ error: "The `controlAgentRuntime` capability or human creator authority is required to control agents" });
      return;
    }
    if (isExternalAgentRuntime(agent.runtime)) {
      respondExternalManagedLifecycleUnsupported(res);
      return;
    }
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    await agentOrchestrator.stopAgent(req.params.id);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to stop agent" });
  }
});

// Reset/restart agent
agentRouter.post("/:id/reset", async (req, res) => {
  try {
    const agent = await agentService.getAgent(req.params.id);
    if (!agent || agent.serverId !== req.serverId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    // Support new mode param, fall back to legacy clearWorkspace for backwards compat
    let mode: "restart" | "session" | "full";
    if (req.body.mode && ["restart", "session", "full"].includes(req.body.mode)) {
      mode = req.body.mode;
    } else {
      mode = req.body.clearWorkspace ? "full" : "session";
    }
    const requiredCapability = mode === "full" ? "resetAgentWorkspace" : "controlAgentRuntime";
    if (!await currentUserCanActOnAgent(req.serverId!, req.userId!, agent, requiredCapability)) {
      res.status(403).json({
        error: mode === "full"
          ? "The `resetAgentWorkspace` capability or human creator authority is required to reset agent workspaces"
          : "The `controlAgentRuntime` capability or human creator authority is required to control agents",
      });
      return;
    }
    if (isExternalAgentRuntime(agent.runtime)) {
      respondExternalManagedLifecycleUnsupported(res);
      return;
    }
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    await agentOrchestrator.resetAgent(req.params.id, mode);
    res.json({ ok: true });
  } catch (err: any) {
    if (err instanceof KimiReasoningEffortUpgradeRequiredError) {
      res.status(409).json({ error: err.message, code: err.code });
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to reset agent",
      code: "agent_reset_failed",
      logPrefix: "[Agents] Failed to reset agent",
      err,
    });
  }
});

// Delete agent
agentRouter.delete("/:id", async (req, res) => {
  try {
    const agent = await agentService.getAgent(req.params.id);
    if (!agent || agent.serverId !== req.serverId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    if (!await currentUserCanActOnAgent(req.serverId!, req.userId!, agent, "deleteAgents")) {
      res.status(403).json({ error: "The `deleteAgents` capability or human creator authority is required to delete agents" });
      return;
    }
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    if (!isExternalAgentRuntime(agent.runtime)) {
      await stopAgentBeforeDelete(agentOrchestrator, req.params.id);
    }
    agentOrchestrator.evictCache(req.params.id);
    await agentService.deleteAgent(req.params.id);

    // Notify all clients in this server
    const io = req.app.get("io");
    io?.to(`server:${req.serverId}`).emit("agent:deleted", { agentId: req.params.id });

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to delete agent" });
  }
});

// Assign machine to agent
agentRouter.post("/:id/assign-machine", async (req, res) => {
  try {
    const agent = await agentService.getAgent(req.params.id);
    if (!agent || agent.serverId !== req.serverId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    if (!await currentUserCanActOnAgent(req.serverId!, req.userId!, agent, "migrateAgents")) {
      res.status(403).json({ error: "The `migrateAgents` capability or human creator authority is required to assign agent machines" });
      return;
    }
    if (isExternalAgentRuntime(agent.runtime)) {
      res.status(400).json({ error: "External agents cannot be assigned to a Computer" });
      return;
    }
    const { machineId } = req.body;
    // Validate machineId belongs to this server. req.body is `any`, so parse the
    // value into a branded MachineId at this boundary before getMachine trusts it.
    let targetMachine: Awaited<
      ReturnType<typeof machineService.getMachine>
    > | null = null;
    if (machineId) {
      const parsedMachineId = parseBrandedUuidFromBody(machineId, asMachineId, "machineId", res);
      if (!parsedMachineId) return;
      targetMachine = await machineService.getMachine(parsedMachineId);
      if (!targetMachine || targetMachine.serverId !== req.serverId) {
        res.status(400).json({ error: "Machine not found in this server" });
        return;
      }
    }
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    let releaseCatalogAuthority: () => void = () => undefined;
    if (targetMachine) {
      const config = hydrateRuntimeConfig(agent);
      if (
        config.runtime === "builtin" &&
        config.provider.kind === "preset" &&
        config.model.kind === "preset"
      ) {
        const routing = await handleMachineLocalRouting(
          req,
          res,
          targetMachine.id,
          () => agentOrchestrator.hasMachineLocally(targetMachine!.id),
        );
        if (routing === "handled") return;
        if (routing !== "confirmed_local") {
          sendBuiltInCatalogUnavailable(res, targetMachine);
          return;
        }
        const validation =
          await agentOrchestrator.validateBuiltInPresetForMachine(
            targetMachine.id,
            config,
          );
        if (validation) {
          releaseCatalogAuthority =
            agentOrchestrator.acquireBuiltInCatalogAuthority(
              targetMachine.id,
              validation.authority,
            );
        }
      }
    }
    try {
      agentOrchestrator.evictCache(req.params.id);
      await agentService.assignMachine(req.params.id, machineId || null);
    } finally {
      releaseCatalogAuthority();
    }
    res.json({ ok: true });
  } catch (err) {
    if (
      err instanceof BuiltInModelCatalogError ||
      err instanceof MachineCatalogStaleError
    ) {
      sendBuiltInCatalogError(res, err);
      return;
    }
    res.status(500).json({ error: "Failed to assign machine" });
  }
});

// Get agent workspace file tree (relayed to daemon via WebSocket)
agentRouter.get("/:id/workspace-files", async (req, res) => {
  try {
    const agent = await agentService.getAgent(req.params.id);
    if (!agent || agent.serverId !== req.serverId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    if (!await canInspectAgentPrivateSurfaces(req.serverId!, req.userId!, agent)) {
      res.status(403).json({ error: "The `editAgents` capability or human creator authority is required to view agent workspace" });
      return;
    }
    if (!agent.machineId) {
      addTraceEvent("agent.workspace.list.rejected", {
        route_action: "workspace_list",
        outcome: "error",
        reason: "machine_unassigned",
        http_status: 409,
        response_code: "machine_unassigned",
      });
      res.status(409).json({
        error: "No machine assigned. Please assign a machine to this agent first.",
        code: "machine_unassigned",
      });
      return;
    }
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;

    const routing = await handleMachineLocalRouting(
      req,
      res,
      agent.machineId,
      () => agentOrchestrator.hasMachineLocally(agent.machineId!),
    );
    if (routing === "handled") return;
    if (routing !== "confirmed_local") {
      sendMachineAffinityUnavailable(res, agent.machineId);
      return;
    }

    const dirPath = req.query.dirPath as string | undefined;
    const includeHidden = req.query.includeHidden === "true";
    const files = await agentOrchestrator.getAgentFileTree(req.params.id, dirPath || undefined, includeHidden);
    res.json({ files });
  } catch (err: any) {
    const failure = responseForAgentRouteFailure(err);
    if (failure.code !== "internal_error") {
      traceRouteFailure("agent.workspace.list.failed", err, {
        route_action: "workspace_list",
        outcome: "error",
        http_status: failure.status,
        response_code: failure.code,
      });
      res.status(failure.status).json({
        error: failure.code === "machine_offline"
          ? "Agent has no connected machine"
          : "Workspace file list request timed out",
        code: failure.code,
      });
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to get workspace files",
      code: "agent_workspace_files_failed",
      logPrefix: "[Agents] Failed to get workspace files",
      err,
    });
  }
});

// Read a file from agent workspace (relayed to daemon via WebSocket)
agentRouter.get("/:id/workspace-files/read", async (req, res) => {
  try {
    const agent = await agentService.getAgent(req.params.id);
    if (!agent || agent.serverId !== req.serverId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    if (!await canInspectAgentPrivateSurfaces(req.serverId!, req.userId!, agent)) {
      res.status(403).json({ error: "The `editAgents` capability or human creator authority is required to view agent workspace" });
      return;
    }
    const filePath = req.query.path as string;
    if (!filePath) {
      res.status(400).json({ error: "path query parameter is required" });
      return;
    }
    if (!agent.machineId) {
      addTraceEvent("agent.workspace.read.rejected", {
        route_action: "workspace_read",
        outcome: "error",
        reason: "machine_unassigned",
        http_status: 409,
        response_code: "machine_unassigned",
      });
      res.status(409).json({
        error: "No machine assigned. Please assign a machine to this agent first.",
        code: "machine_unassigned",
      });
      return;
    }
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;

    const routing = await handleMachineLocalRouting(
      req,
      res,
      agent.machineId,
      () => agentOrchestrator.hasMachineLocally(agent.machineId!),
    );
    if (routing === "handled") return;
    if (routing !== "confirmed_local") {
      sendMachineAffinityUnavailable(res, agent.machineId);
      return;
    }

    const result = await agentOrchestrator.readAgentFile(req.params.id, filePath);
    res.json({
      path: filePath,
      content: result.content,
      binary: result.binary,
      size: result.size,
      mimeType: result.mimeType,
      encoding: result.encoding,
      modifiedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    const failure = responseForAgentRouteFailure(err);
    if (failure.code !== "internal_error") {
      traceRouteFailure("agent.workspace.read.failed", err, {
        route_action: "workspace_read",
        outcome: "error",
        http_status: failure.status,
        response_code: failure.code,
      });
      res.status(failure.status).json({
        error: failure.code === "machine_offline"
          ? "Agent has no connected machine"
          : "Workspace file read request timed out",
        code: failure.code,
      });
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to read file",
      code: "agent_workspace_read_failed",
      logPrefix: "[Agents] Failed to read workspace file",
      err,
    });
  }
});

// List agent skills (global + workspace) — relayed to daemon via WebSocket
agentRouter.get("/:id/skills", async (req, res) => {
  let skillsListStartedAt = performance.now();
  let skillsListRuntime: string | null | undefined;
  try {
    const agent = await agentService.getAgent(req.params.id);
    if (!agent || agent.serverId !== req.serverId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    if (!await canInspectAgentPrivateSurfaces(req.serverId!, req.userId!, agent)) {
      res.status(403).json({ error: "The `editAgents` capability or human creator authority is required to view agent workspace" });
      return;
    }
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;

    if (agent.machineId) {
      const routing = await handleMachineLocalRouting(
        req,
        res,
        agent.machineId,
        () => agentOrchestrator.hasMachineLocally(agent.machineId!),
      );
      if (routing === "handled") return;
      if (routing !== "confirmed_local") {
        sendMachineAffinityUnavailable(res, agent.machineId);
        return;
      }
    }

    skillsListRuntime = agent.runtime;
    skillsListStartedAt = performance.now();
    const skills = await agentOrchestrator.getAgentSkills(req.params.id, agent.runtime);
    res.json(skills);
  } catch (err: any) {
    const failure = responseForAgentRouteFailure(err);
    recordAgentSkillsListFailed(err, {
      durationMs: performance.now() - skillsListStartedAt,
      runtime: skillsListRuntime,
      httpStatus: failure.status,
      responseCode: failure.code,
    });
    res.status(failure.status).json({
      error: failure.status >= 500 && failure.code === "internal_error"
        ? "Failed to list skills"
        : err.message || "Failed to list skills",
      code: failure.code,
    });
  }
});

// ── Agent permission scope grants (creator + admin) ────────────────────────
//
// Visibility: the agent's human creator OR any user with `editAgents`
// (server owner / admin) can read and edit. Per stdrc 2026-05-13
// (#proj-permission:1414ca65 msg=afe74ee3) the creator owns the agent and
// should be able to revoke its capabilities directly without going through
// a server admin.
//
// Wire shape mirrors `AgentScopeSet` from @botiverse/raft-shared. Whole-set updates
// only — partial scope adds/removes are not supported (locked at
// #proj-permission:10bdc2c9). The post-write set is broadcast over the
// `agent:scope-updated` ws event by Noel's hot-swap layer.

agentRouter.get("/:id/scopes", async (req, res) => {
  try {
    const agent = await agentService.getAgent(req.params.id);
    if (!agent || agent.serverId !== req.serverId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    if (!await canInspectAgentPrivateSurfaces(req.serverId!, req.userId!, agent)) {
      res.status(403).json({ error: "The `editAgents` capability or human creator authority is required to read agent scopes" });
      return;
    }
    const set = await agentScopesService.loadAgentScopes(req.params.id);
    res.json(set);
  } catch (err) {
    if (err instanceof agentScopesService.AgentScopesNotFoundError) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    console.error("agents.scopes.read error:", err);
    res.status(500).json({ error: "Failed to load agent scopes" });
  }
});

agentRouter.put("/:id/scopes", async (req, res) => {
  try {
    const agent = await agentService.getAgent(req.params.id);
    if (!agent || agent.serverId !== req.serverId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    if (!await canInspectAgentPrivateSurfaces(req.serverId!, req.userId!, agent)) {
      res.status(403).json({ error: "The `editAgents` capability or human creator authority is required to update agent scopes" });
      return;
    }
    const body = (req.body ?? {}) as { scopes?: unknown; mode?: unknown };
    if (body.mode === "default") {
      const set = await agentScopesService.resetAgentScopesToDefault({
        agentId: req.params.id,
        updatedByUserId: req.userId!,
      });
      res.json(set);
      return;
    }
    if (!Array.isArray(body.scopes)) {
      res.status(400).json({ error: "scopes must be an array of scope literals" });
      return;
    }
    const set = await agentScopesService.updateAgentScopes({
      agentId: req.params.id,
      scopes: body.scopes as readonly string[],
      updatedByUserId: req.userId!,
    });
    // TODO(noel): emit `agent:scope-updated` over ws so daemon caches hot-swap
    // without the next CLI/MCP call paying the DB read. Wire is the
    // `AgentScopeSet` wire shape, sent verbatim. Tracked at #proj-permission:10bdc2c9.
    res.json(set);
  } catch (err) {
    if (err instanceof agentScopesService.AgentScopesNotFoundError) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    console.error("agents.scopes.update error:", err);
    res.status(500).json({ error: "Failed to update agent scopes" });
  }
});

// Issue a one-time bootstrap token for an agent (web-session mint).
//
// `rfcs/034-slock-credential-rfc.zh.html#section-credential-model`
// self-hosted-runner bootstrap token issue path. This unpublished external
// surface is gated off by default; tests and future rollout can opt in with
// SLOCK_SELF_HOSTED_RUNNER_BOOTSTRAP_ENABLED=true. The caller must be
// authenticated, verified, have the `issueAgentCredentials` server capability
// (or be the Agent's human creator), and the
// resource must belong to the active server. The response includes the raw
// token EXACTLY ONCE — the UI is responsible for surfacing it to the operator
// when the surface is explicitly enabled.
//
// Request body: { scopes?: string[], ttlMs?: number }
//   - scopes: subset of ALLOWED_AGENT_CAPABILITIES. Defaults to ALL caps when
//     omitted — the operator should narrow at issuance time when known.
//   - ttlMs: optional override (default 30 minutes via service layer).
agentRouter.post("/:id/bootstrap-tokens", async (req, res) => {
  if (!isAgentBootstrapSurfaceEnabled()) {
    res.status(404).json({
      error: "Self-hosted runner bootstrap is not enabled",
      code: "self_hosted_runner_bootstrap_disabled",
    });
    return;
  }

  try {
    const agent = await agentService.getAgent(req.params.id, true);
    if (!agent || agent.serverId !== req.serverId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const canManage = await currentUserCanActOnAgent(
      req.serverId!,
      req.userId!,
      agent,
      "issueAgentCredentials",
    );
    if (!canManage) {
      res.status(403).json({
        error: "The `issueAgentCredentials` capability or human creator authority is required to issue agent bootstrap tokens",
        code: "insufficient_role",
      });
      return;
    }

    const body = (req.body ?? {}) as { scopes?: unknown; ttlMs?: unknown };

    // Default scope = all allowed caps. Narrow if caller passes a subset.
    let scopes: AgentCapability[];
    if (body.scopes === undefined) {
      scopes = [...ALLOWED_AGENT_CAPABILITIES];
    } else if (!Array.isArray(body.scopes)) {
      res.status(400).json({
        error: "scopes must be an array of capability literals",
        code: "scopes_invalid",
      });
      return;
    } else {
      try {
        scopes = normalizeAgentCapabilities(body.scopes as readonly string[]);
      } catch {
        res.status(400).json({
          error: `scopes must each be one of: ${ALLOWED_AGENT_CAPABILITIES.join(", ")}`,
          code: "scopes_invalid",
        });
        return;
      }
      if (scopes.length === 0) {
        res.status(400).json({
          error: "scopes must include at least one capability",
          code: "scopes_empty",
        });
        return;
      }
    }

    let ttlMs: number | undefined;
    if (body.ttlMs !== undefined) {
      if (typeof body.ttlMs !== "number" || !Number.isFinite(body.ttlMs) || body.ttlMs <= 0) {
        res.status(400).json({
          error: "ttlMs must be a positive number of milliseconds",
          code: "ttl_invalid",
        });
        return;
      }
      // Cap at 24h to bound blast radius of accidental long-lived tokens.
      const MAX_TTL_MS = 24 * 60 * 60 * 1000;
      if (body.ttlMs > MAX_TTL_MS) {
        res.status(400).json({
          error: "ttlMs cannot exceed 24 hours",
          code: "ttl_too_long",
        });
        return;
      }
      ttlMs = body.ttlMs;
    }

    const issued = await issueAgentBootstrapToken({
      agentId: agent.id,
      serverId: req.serverId!,
      issuedByUserId: req.userId!,
      scopes,
      ttlMs,
    });

    res.status(201).json({
      tokenId: issued.tokenId,
      // Raw token is surfaced exactly once; UI must copy-to-clipboard now.
      bootstrapToken: issued.rawToken,
      tokenPrefix: issued.tokenPrefix,
      ttlExpiresAt: issued.ttlExpiresAt.toISOString(),
      scopes: issued.scopes,
      agentId: agent.id,
      agentName: agent.name,
      serverId: req.serverId!,
    });
  } catch (err) {
    if (err instanceof Error) {
      if (err.message === "agent_missing") {
        res.status(404).json({ error: "Agent not found", code: "agent_missing" });
        return;
      }
      if (err.message === "agent_server_mismatch") {
        // Defense-in-depth — should already be caught by the 404 above.
        res.status(404).json({ error: "Agent not found", code: "agent_missing" });
        return;
      }
    }
    console.error("agents.bootstrap-tokens.issue error:", err);
    res.status(500).json({ error: "Failed to issue bootstrap token" });
  }
});

// Note: `POST /api/agents/:id/credentials` lives in
// `packages/server/src/routes/agentCredentials.ts` and is mounted in
// `app.ts` BEFORE this router. It deliberately does NOT require
// `X-Server-Id` (it derives the server context from `agent.serverId`)
// so a CLI caller doesn't have to know the serverId out-of-band. See
// `#proj-runtime:3d515727` (XX msg=dc316ca3 / Hao msg=b50c93bd) for
// the §3 invariant: CLI resource-explicit surfaces derive server
// context from the subject row, not from active-server header.
