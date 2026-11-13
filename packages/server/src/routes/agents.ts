import { agentReadinessForViewer, loadComputerReadinessInputs, loadMemberDisplayNames, readinessAgentOwnerUserId, readinessViewerForRole, type ComputerReadinessInputs } from "../services/runtimeReadinessService";
import { AgentLoungeAgentNotFoundError, openOrCreateAgentLounge } from "../services/agentLoungeService";
import { mcpAgentOwnerUserId } from "../services/managedMcpConnectionOwnership";
import { AssistantCannotUseComputerError, findAccessRevokedMachineIds, MachineKeyRevokedError, machineTakesAgents } from "../services/computerAgents";
import { resolveAgentContextViewStatus } from "../services/agentContextViewStatusService";
import { AGENT_CONTEXT_VIEW_NOT_FOUND, type AgentContextViewRelay } from "../services/agentContextViewRelay";
import { listAgentContextViews } from "../services/agentContextViewService";
import { Router, type Request, type Response, type Router as RouterType } from "express";
import { mapWithConcurrency } from "../lib/mapWithConcurrency";
import { parseRuntimeFormV2ClientCapabilities, RUNTIME_FORM_V2_CLIENT_CAPABILITIES_QUERY, type RuntimeFormV2SubmitRef } from "@botiverse/raft-runtime-form";
import type { Server as SocketServer } from "socket.io";
import { broadcastAgentUpdated } from "./agentUpdatedBroadcast";
import { agentEventRoom } from "../socket/platformScope";
import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import multer from "multer";
import {
  AGENT_ARCHIVE_WORKSPACE_CHOICES,
  AGENT_CONTEXT_VIEW_FEATURE_FLAG_KEY,
  type AgentContextViewRecordList,
  agentMigrationSupportRefSchema,
  currentDate,
  type AgentArchiveWorkspaceChoice,
  type AgentMigrationTransferProgress,
  type AgentMigrationUserErrorCode,
} from "@botiverse/raft-shared";
import { emitAgentApprovalCards } from "../services/agentRuntimeApprovalService";
import { respondInvalidOrExpiredToken } from "../middleware/auth";
import { DeviceSessionRevokedError, lockLiveSessionFamily, webSessionFamilyOf } from "../services/sessionService";
import { refuseWithoutRecentSecondFactor } from "./secondFactor";
import * as agentService from "../services/agentService";
import { assertActionCardWritable, isActionCardConversionError } from "../services/actionCardConversionService";
import * as agentActivityLogService from "../services/agentActivityLogService";
import * as assistantService from "../services/assistantService";
import { AssistantSendAsOwnerError, retractDelegatedMessage, setAssistantSendAsOwner } from "../services/assistantSendAsOwnerService";
import { listOwnerSettingChanges } from "../services/assistantOwnerSettingsService";
import { listOwnerActionChanges } from "../services/assistantOwnerActions";
import * as agentMigrationService from "../services/agentMigrationService";
import { OFFICIAL_ONBOARDING_AGENT_IDENTITY } from "../services/officialOnboardingAgentIdentity";
import * as agentRuntimeProfileService from "../services/agentRuntimeProfileService";
import { getAgentModelLimitsWarning, getAgentModelLimitsWarnings } from "../services/agentModelLimitsService";
import { bumpAgentConfigRevision } from "../services/agentConfigRevision";
import * as machineService from "../services/machineService";
import * as onboardingService from "../services/onboardingService";
import * as serverService from "../services/serverService";
import { getDb, type DatabaseTransaction } from "../db/index";
import { FencedAuthorizationDeniedError, ServerMembershipRevokedError, withActorMembershipFence } from "../lib/actorMembershipFence";
import { agentRuntimeProvisions, agents, channels, machines, messages, oauthClientInstalls, oauthClients, raftbenchServiceAgents, serverMembers, servers, serverAgentMembers, users } from "../db/schema";
import { convertFailedHostedCindyToComputer, HostedCindyConversionError, resolveHostedCindySetupState } from "../services/hostedCindyService";
import {
  AgentOrchestrator,
  KimiReasoningEffortUpgradeRequiredError,
} from "../services/agentOrchestrator";
import { emitAgentMigrationUpdated } from "../services/agentMigrationRealtime";
import {
  handleMachineLocalProbeRouting,
  handleMachineLocalRouting,
  isMachineLocalReplayFailure,
  machineLocalReplayFailureCode,
  sendMachineAffinityUnavailable,
} from "../machineLocalReplay";
import {
  setRequestTraceComputerProbeState,
  setRequestTraceComputerTarget,
  setRequestTraceErrorCode,
} from "../middleware/requestObservability";
import {
  computerProbeCacheFor,
  computerProbeFreshness,
  type AgentSkillsList,
  type ComputerProbeAnswer,
} from "../services/computerProbeCacheService";
import {
  buildLaunchPlan,
  AGENT_MIGRATION_CAPABILITY,
  AGENT_MIGRATION_SOURCE_DRAIN_CAPABILITY,
  EXTERNAL_AGENT_RUNTIME_ID,
  EXTERNAL_AGENT_RUNTIME_MODEL,
  hydrateRuntimeConfig,
  hydrateRuntimeConfigWithTrace,
  isExternalAgentRuntime,
  getRuntimeDisplayName,
  isOarOnlyRuntime,
  parseRuntimeConfig,
  runtimeConfigModelValue,
  stripControlledRuntimeEnvVars,
  newlyWrittenDisallowedAgentEnvVarNames,
  validateAgentName,
  REASONING_EFFORTS,
  LEGACY_COLUMN_REASONING_EFFORTS,
  RUNTIME_CONFIG_VERSION,
  RUNTIMES,
  type AgentCreateFormIssue,
  type LaunchPlan,
  type ReasoningEffort,
  type LegacyColumnReasoningEffort,
  type RuntimeConfig,
  type ServerCapability,
  type ServerRole,
  asMachineId,
} from "@botiverse/raft-shared";
import { parseBrandedUuidFromBody } from "../lib/brandedParse";
import { connectorAssignableToAgent, actorCanChangeAgentServerMemberRole, actorHasServerCapabilityInServer, decideAgentConnectorAuthority, decideAgentResourceAuthority, withAssistantOwnerMembership, actorRoleHasServerCapability, canViewAgentContext, getActorServerRoleInServer, roleCanInspectAgentPrivateSurfaces, userCanActOnAgentResource } from "../lib/actorPermissions";
import { cdnPublicBaseUrl, getCdnStorage, isStorageNotFoundError } from "../services/storageService";
import { streamStorageResponse } from "../services/storageResponseStream";
import { DEFAULT_PIXEL_AVATAR_KEY, decodePixelAvatarKey, renderPixelAvatarSvg } from "../services/pixelAvatarService";
import { isHumanAvatarUrl } from "@botiverse/raft-shared/src/humanAvatar";
import { HUMAN_AVATAR_ART_REVISION } from "@botiverse/raft-shared/src/humanAvatarArt";
import {
  createAvatarUpload,
  MAX_PROFILE_AVATAR_BYTES,
  PROFILE_AVATAR_BAD_FORMAT_MESSAGE,
  PROFILE_AVATAR_TOO_LARGE_MESSAGE,
  runSingleAvatarUpload,
  storeAgentAvatar,
} from "../services/avatarService";
import * as channelService from "../services/channelService";
import {
  attachTriggerAppEvents,
  attachTurnAppEvents,
  attachTurnSentMessages,
  triggerAppEventRef,
  TURN_SENT_EDGE_MS,
  turnWindows,
  viewTurnSummaries,
} from "../services/activityTurnSummaryView";
import { loadTurnTriggerFacts } from "../services/activityTurnTriggerFacts";
import { listAgentAppEventsDeliveredBetween, resolveAgentAppEventRefs } from "../services/agentAppEventsService";
import { withRunningTurn, type CurrentTurn } from "../services/activityTurnMerge";
import { postAgentServerRoleChangedNotice } from "../services/agentServerRoleNoticeService";
import { addTraceEvent, createTraceDbQueryTracer, errorClassOf, getCurrentTraceContext, recordTraceEvent, tracePhase } from "../tracing/semanticTrace";
import { RouteFailureError, resolveRouteFailureKind, resolveRouteFailureSubkind, traceRouteFailure } from "../tracing/routeFailure";
import { AssistantReservedHandleError, isPrincipalHandleConflictError } from "../services/principalHandleService";
import { isAgentFindableBy } from "../services/agentMemberListPolicy";
import * as agentScopesService from "../services/agentScopesService";
import {
  DEFAULT_EXTERNAL_AGENT_CAPABILITIES,
  externalAgentSetupState,
  getAgentsLastSeenAt,
  isAgentBootstrapSurfaceEnabled,
  issueAgentBootstrapToken,
  resolveRequestedAgentCapabilities,
} from "../services/agentCredentialService";
import { enforceAgentCredentialMintRate } from "../services/agentCredentialMintLimits";
import { broadcastAgentCredentialRevocation } from "../replicaRouter";
import { evaluateFeatureFlag } from "../services/featureFlagService";
import {
  isRuntimeAdmittedForNewUse,
  isRuntimeDeprecatedForServer,
  projectExistingAgentRuntimeOptions,
  resolveRuntimeAdmissionPolicy,
  runtimeOptionProjectionFromHeaders,
} from "../services/runtimeAdmissionService";
import { CapacityLimitError, requireTeamBillingFeature } from "../services/planService";
import { notePaywallHit } from "./paywallHit";
import { agentMigrationRetryComparison, readRetriedAgentMigration } from "../services/agentMigrationRetry";
import {
  acquireMigrationTargetCatalogAuthority,
  getMigrationTransferProvisioner,
  hasActiveAgentMigration,
  isUuid,
  leaseStateFromDelivery,
  machineSupportsRuntime,
  MigrationRoutePreflightError,
  provisionComputerMigrationStart,
  sendBuiltInCatalogError,
  sendBuiltInCatalogUnavailable,
  sendComputerMigrationLeases,
  validateBuiltInPresetForWrite,
  validateComputerMigrationStart,
  type MigrationErrorDetails,
} from "./agentMigrationStart";
import {
  buildKimiSdkFormOptionSource,
  runtimeConfigIssue,
  validateKimiSdkSelection,
  validateRuntimeFormDefinitionRef,
} from "../services/runtimeFormDefinitionService";
import {
  buildRuntimeConfigFromFormValues,
  buildRuntimeFormV2EditBodyForServer,
  guardBuiltInEditFromClient,
  withBuiltInEditVisibility,
  formValuesPointerForRuntimeConfigPointer,
  SAVED_CONNECTION_VALUE_PREFIX,
  reconcileRuntimeFormV2SubmissionWithLiveModels,
  redactWriteOnlyRuntimeConfig,
  retainOmittedClaudeAuthType,
  retainOmittedWriteOnlySecrets,

  isRuntimeFormV2SubmitProtocol,
  validateRuntimeFormV2SubmitRef,
  type RuntimeFormValuesOptions,
} from "../services/runtimeFormV2Registry";
import { localizeRuntimeFormV2, runtimeFormCopyLocale, setRuntimeFormCopyHeaders } from "../services/runtimeFormV2Copy";
import { isRuntimeFormV3Request, serveRuntimeFormV3 } from "../services/runtimeFormV3";
import { sendJsonServerError } from "./errorResponse";
import {
  AgentArchiveError,
  emitAgentArchiveUpdated,
  getAgentArchive,
  listArchivedAgents,
  recordAgentArchive,
  requestAgentArchiveWorkspaceOp,
  toAgentArchiveView,
  type AgentArchiveRow,
} from "../services/agentArchiveService";
import { APP_BOT_LIFECYCLE_MANAGED } from "../services/appBotIdentityService";
import {
  assertProviderConnectionModelCompatible,
  ProviderConnectionError,
  SAVED_CONNECTION_ID_SHAPE,
  resolveProviderConnectionSelection,
} from "../services/providerConnectionService";
import { isProviderConnectionsEnabled } from "../services/providerConnectionFeature";
import { builtInTypedModelProvidersFor } from "../services/builtInTypedModelProviders";
import { type AgentOperatorEventStoredKind } from "@botiverse/raft-shared";
import { listAgentOperatorEvents, recordAgentOperatorEvent, type AgentOperatorEventDetailsInput } from "../services/agentOperatorEvents";
import { AGENT_LOUNGE_FEATURE_FLAG_KEY, coarseAgentActivityState, AGENT_MIGRATION_HOSTED_FEATURE_FLAG_KEY, HOSTED_DEFAULT_MODEL, isAgentRuntimeProviderKind, SUBAGENT_TASK_ID_MAX_LENGTH } from "@botiverse/raft-shared";
import { AgentRuntimeProviderError, resolveProviderConfig } from "../services/agentRuntimeProviderService";
import { fetchProvisionImportLimits } from "../services/agentRuntimeProvisionImport";
import { confirmHostedAgentMigration, getHostedMigrationReview, HostedMigrationConfirmError } from "../services/hostedAgentMigrationService";
import {
  assertProviderProvisioningAvailable,
  beginProvisionedAgentDeletion,
  fetchProviderAgentStatus,
  getHostedRuntimeSummaries,
  getHostedRuntimeSummary,
  kickAgentRuntimeProvisionWorker,
  noteProvisionedAgentProfileEdit,
  recordAgentProvisioning,
  retryAgentProvisioning,
  stopHostedAgentTurn,
} from "../services/agentRuntimeProvisionService";
import { kickAppNotificationDelivery } from "../services/appNotificationDeliveryService";
import { ensureServerModelPickerSynced } from "../services/hostedRuntimeServerPlanSync";
import {
  fetchHostedAgentUsage,
  listHostedAgentWorkspaceFiles,
  parseHostedUsageQuery,
  readHostedAgentWorkspaceFile,
  type ProviderSurfaceResult,
} from "../services/agentRuntimeProviderSurfaceService";
import {
  checkHostedModelChoice,
  hostedModelForCreate,
  isHostedModelPickerEnabled,
  getHostedAgentModel,
  setHostedAgentModel,
  type HostedAgentModelResult,
  type HostedModelChoiceResult,
} from "../services/hostedAgentModelService";
import { getExternalAgentDiagnostics } from "../services/externalAgentDiagnosticsService";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { sendAgentRuntimeProviderError } from "./agentRuntimeProviders";
import {
  assignAgentConnectionConnector,
  confirmAgentConnection,
  disconnectAgentConnection,
  disconnectAgentConnectionConnector,
  findAgentConnectionConnector,
  getAgentConnectionStatus,
  startAgentConnection,
  type AgentConnectionFailure,
  type AgentConnectionReconnect,
  type AgentConnectionRemoved,
  type AgentConnectionViewer,
} from "../services/agentConnectionService";
import { newAuditOperationId, recordIntegrationAuditEvent, recordIntegrationAuditEventBestEffort, serverAuditContextMetadata } from "../services/integrationAuditService";
import { isRuntimeErrorDetailActivity, type AgentRuntimeErrorState, type RuntimeErrorCode } from "@botiverse/raft-shared";
import { projectRuntimeErrorActivityDetail, projectRuntimeErrorState, type RuntimeErrorViewer } from "../services/agentRuntimeErrorVisibility";
import { AGENT_CONNECTION_CONNECTOR_ID_RE, type AgentBlockedReason, isAgentConnectionProvider, refusalSentenceProblem, type AgentConnectionProvider, type AgentConnectionRemovedView, type ServerId, type TraceAttributes } from "@botiverse/raft-shared";
import { refuse } from "../lib/refusal";
import { isAgentRuntimeProviderKillSwitched } from "../services/agentRuntimeProviderFeature";

// The provider kind stays out of the message: people see "cloud agent", not the provider name.
function hostedRuntimeDisabledError(): AgentRuntimeProviderError {
  return new AgentRuntimeProviderError("Cloud agents are not enabled for this server", "agent_runtime_provider_disabled");
}

/**
 * A failed hosted-runtime surface proxy (workspace or usage): provider 400/404
 * pass through as 400/404; not provisioned/active or provider not configured is
 * 409 `hosted_runtime_<surface>_not_ready`; provider errors and network failures
 * are 502 `hosted_runtime_<surface>_unavailable`.
 */
function sendHostedSurfaceFailure(
  res: Response,
  failure: Exclude<ProviderSurfaceResult<unknown>, { kind: "ok" }>,
  surface: "workspace" | "usage",
): { status: number; code: string; reason: string } {
  let response: { status: number; code: string; reason: string; body: Record<string, unknown> };
  switch (failure.kind) {
    case "bad_request":
      response = {
        status: 400,
        code: `hosted_runtime_${surface}_bad_request`,
        reason: failure.error?.code ?? "bad_request",
        body: { error: failure.error?.message || "The provider rejected the request", providerCode: failure.error?.code ?? null },
      };
      break;
    case "not_found":
      response = {
        status: 404,
        code: `hosted_runtime_${surface}_not_found`,
        reason: failure.error?.code ?? "not_found",
        body: { error: failure.error?.message || "Not found", providerCode: failure.error?.code ?? null },
      };
      break;
    case "unavailable":
      // Not provisioned or not active yet, or no provider on this deployment.
      response = {
        status: 409,
        code: `hosted_runtime_${surface}_not_ready`,
        reason: failure.reason,
        body: { error: "The cloud runtime is not ready", reason: failure.reason },
      };
      break;
    case "upstream_unavailable":
      response = {
        status: 502,
        code: `hosted_runtime_${surface}_unavailable`,
        reason: failure.reason,
        body: { error: "The cloud runtime is unavailable right now", reason: failure.reason },
      };
      break;
  }
  res.status(response.status).json({ ...response.body, code: response.code });
  return { status: response.status, code: response.code, reason: response.reason };
}
import {
  BuiltInModelCatalogError,
  builtInPresetSelectionChanged,
  isBuiltInCatalogCheckedSelection,
} from "../services/builtinModelCatalogCompatibility";
import { MachineCatalogStaleError } from "../services/machineCatalogAuthority";
import { projectAssistantPause, resumeAssistant, stopAssistant } from "../services/assistantLifecycleService";
import { guardUuidPathParams } from "../lib/uuidPathParams";
import { hideUnfindableAgentsInPath } from "./unfindableAgentGate";

export const agentRouter: RouterType = Router();

// Uniform 404 for a non-UUID agent :id (task #12), before any handler runs.
guardUuidPathParams(agentRouter, { id: "Agent", messageId: "Agent" });

// The one gate for every by-id operation under /:id, read or write: another
// person's personal assistant (agentFindableBy; server owners and admins
// included) is answered exactly as an id that names no agent. First, so no
// later middleware or handler ever reads or acts on it.
hideUnfindableAgentsInPath(agentRouter);

// View Context's reads answer a Guest themselves, with the same 404 as every
// other refusal (canViewAgentContext never admits a Guest), so a Guest cannot
// tell a View Context route from an unknown agent.
const CONTEXT_VIEW_READ_PATH = /^\/[^/]+\/(?:context-view\/status|context-views|messages\/[^/]+\/context)$/;

// Guest conversations use a channel-scoped public profile projection. Permit
// only the two reads which apply that projection below (and View Context's
// reads, above); every operational or mutation endpoint on this router remains
// fail-closed for Guests.
agentRouter.use(async (req, res, next) => {
  const callerRole = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
  const pathSegments = req.path.split("/").filter(Boolean);
  const isGuestPublicProfileRead = req.method === "GET"
    && (pathSegments.length === 0 || pathSegments.length === 1);
  const isContextViewRead = req.method === "GET" && CONTEXT_VIEW_READ_PATH.test(req.path);
  if (callerRole === "guest" && !isGuestPublicProfileRead && !isContextViewRead) {
    res.status(403).json({ error: "Guests can't open the server's agent directory" });
    return;
  }
  next();
});

const ASSISTANT_OWNER_ONLY_ERROR = {
  error: "Only this assistant's owner can manage it; an owner or admin of the server can only stop it",
  code: "assistant_owner_only",
} as const;

// A personal assistant's lifecycle is its owner's alone. Since
// hideUnfindableAgentsInPath nobody else reaches this with an assistant's id
// (it reads as unknown); this stays as a second line. Every write under /:id
// is refused here with one code, before any handler; each handler's own check and its membership fence then re-run
// the same decision (`decideAgentResourceAuthority`).
// Mounted without a `/:id` path on purpose: that would fire the `id` UUID param
// guard for every first segment, 404ing static routes such as GET /archived.
agentRouter.use(async (req, res, next) => {
  try {
    const [id, ...rest] = req.path.split("/").filter(Boolean);
    if (req.method === "GET" || req.method === "HEAD" || !id || !isUuid(id)) {
      next();
      return;
    }
    // The path under /:id, as a route there sees it ("/" for /:id itself).
    const subPath = `/${rest.join("/")}`;
    const [agent] = await getDb()
      .select({ creatorType: agents.creatorType, creatorId: agents.creatorId, assistantOwnerUserId: agents.assistantOwnerUserId })
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.serverId, req.serverId!)))
      .limit(1);
    if (!agent?.assistantOwnerUserId) {
      next();
      return;
    }
    const callerRole = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
    // The web's one stop control for a hosted agent is Stop turn (`/interrupt-turn`):
    // for someone else's assistant, a server owner/admin's press is the Stop (a pause).
    const stop = req.method === "POST" && (subPath === "/stop" || subPath === "/interrupt-turn");
    // Deleting (or cleaning up the archive of) an assistant whose owner left is
    // the one other thing a server owner/admin may do.
    const deletion = (req.method === "DELETE" && subPath === "/") || subPath.startsWith("/archive");
    const subject = deletion ? await withAssistantOwnerMembership(req.serverId!, agent) : agent;
    if (decideAgentResourceAuthority(callerRole, req.userId!, subject, deletion ? "deleteAgents" : "controlAgentRuntime", { stop }) === "assistant_owner_only") {
      res.status(403).json(ASSISTANT_OWNER_ONLY_ERROR);
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
});
export const agentAvatarRouter: RouterType = Router();
const MAX_AGENT_DESCRIPTION_LENGTH = 3000;
// The legacy column (and the agent API built from it) never carries Pi's
// `off`/`minimal`: older CLIs validate that field against the older set.
const KNOWN_REASONING_EFFORT_IDS = new Set<string>(LEGACY_COLUMN_REASONING_EFFORTS);

function persistedAgentReasoningEffort(
  runtime: string,
  effort: LaunchPlan["reasoningEffort"],
): LegacyColumnReasoningEffort | null {
  if (runtime === "kimi-sdk" || effort === null) return null;
  return KNOWN_REASONING_EFFORT_IDS.has(effort) ? effort as LegacyColumnReasoningEffort : null;
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






function getErrorClass(error: unknown): string {
  return errorClassOf(error);
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




function sendRuntimeCapabilityUnavailable(res: Response, runtime: string): void {
  res.status(409).json({
    error: isOarOnlyRuntime(runtime)
      ? `${getRuntimeDisplayName(runtime)} is not available on this computer: install its CLI there, and update the Computer if it does not list ${getRuntimeDisplayName(runtime)} yet`
      : `${getRuntimeDisplayName(runtime)} is not available on this computer`,
    code: "runtime_capability_unavailable",
  });
}

function sendRuntimeDisabled(res: Response, runtime: string): void {
  res.status(403).json({
    error: `${getRuntimeDisplayName(runtime)} is not enabled on this server`,
    code: "runtime_disabled",
  });
}

/** Runtimes an agent can be created on or switched to only with a Computer that reports them. */
function runtimeNeedsReportingComputer(runtime: string): boolean {
  return runtime === "grok" || isOarOnlyRuntime(runtime);
}




export function sendMigrationError(
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

function serializeOwnerMigrationStatus(
  row: agentMigrationService.AgentMigrationRow,
  transferProgress: AgentMigrationTransferProgress | null = null,
) {
  return {
    migrationRef: row.supportRef,
    agentId: row.agentId,
    state: row.state,
    sourceMachineId: row.sourceMachineId,
    // Additive: older web bundles keep reading targetMachineId (null for hosted).
    targetKind: row.targetKind,
    targetMachineId: row.targetMachineId,
    provider: row.transportProvider,
    failureReason: row.failureReason,
    abortReason: row.abortReason,
    transportErrorCode: row.transportErrorCode,
    transportErrorMessage: row.transportErrorMessage,
    sourceWorkspaceArchivedAt: row.sourceWorkspaceArchivedAt?.toISOString() ?? null,
    sourceWorkspaceArchiveAbandonedAt: row.sourceWorkspaceArchiveAbandonedAt?.toISOString() ?? null,
    sourceWorkspaceArchiveLastError: row.sourceWorkspaceArchiveLastError,
    sourceQuiescedAt: isoOrNull(row.sourceQuiescedAt),
    // Additive: until when the source waits for the agent to be quiet before it
    // stops it (null once quiesced, or when the source stops at once).
    sourceDrainUntil: isoOrNull(agentMigrationService.sourceDrainUntil(row)),
    sourceBuildProgress: agentMigrationService.sourceBuildProgressOf(row),
    // Additive (SERVER_CAPABILITY_MIGRATION_SOURCE_DRAIN_PROGRESS_V1): what the
    // draining source waits for (`waitingFor`, fixed set or null) and until when
    // (`until`, ISO, within sourceDrainUntil). Null once quiesced or unreported.
    sourceDrain: agentMigrationService.sourceDrainOf(row),
    // What the source did with the paths the user chose to leave out (null until it reports).
    userIgnoreReceipt: row.userIgnoreReceipt ?? null,
    // Additive: an agent's own retry of a size-failed migration (POST
    // /internal/agent-api/migrations/retry) names the failed migration it
    // repeats and the agent that asked; null for a migration a person started.
    retryOfMigrationId: row.retryOfMigrationId,
    triggeredByAgentId: row.triggeredByAgentId,
    transferProgress,
    prepDeadlineAt: row.prepDeadlineAt.toISOString(),
    transferDeadlineAt: row.transferDeadlineAt.toISOString(),
    arrivalDeadlineAt: row.arrivalDeadlineAt.toISOString(),
    transportProvisioningStartedAt: isoOrNull(row.transportProvisioningStartedAt),
    transportProvisionedAt: isoOrNull(row.transportProvisionedAt),
    transportControlRegisteredAt: isoOrNull(row.transportControlRegisteredAt),
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
    .stopAgent(agentId, "internal", { daemonReason: "deleted" })
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
/**
 * #wg-rbac:#57: the runtime error as this viewer may read it: a manager gets
 * the scrubbed, capped text, everyone else the code's fixed sentence or the
 * generic message; both get the code (`lastRuntimeError.code`,
 * `activityErrorCode`). Also covers rows stored before ingest scrubbing.
 */
function withRuntimeErrorProjection<T extends { activity?: unknown; activityDetail?: unknown; activityDetailKind?: unknown; lastRuntimeError?: AgentRuntimeErrorState | null }>(
  agent: T,
  viewer: RuntimeErrorViewer,
): T & { activityErrorCode?: RuntimeErrorCode } {
  const lastRuntimeError = agent.lastRuntimeError ?? null;
  const projected: T & { activityErrorCode?: RuntimeErrorCode } = {
    ...agent,
    ...("lastRuntimeError" in agent ? { lastRuntimeError: projectRuntimeErrorState(lastRuntimeError, viewer) } : {}),
  };
  const activity = typeof agent.activity === "string" ? agent.activity : null;
  const detailKind = typeof agent.activityDetailKind === "string" ? agent.activityDetailKind : null;
  if (isRuntimeErrorDetailActivity({ activity, detailKind }) && typeof agent.activityDetail === "string") {
    const { detail, errorCode } = projectRuntimeErrorActivityDetail({ activity, detailKind, detail: agent.activityDetail, lastRuntimeError }, viewer);
    projected.activityDetail = detail;
    if (errorCode) projected.activityErrorCode = errorCode;
  }
  return projected;
}

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

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

/**
 * Installed mobile clients send `loadLocalPlugins: null` for "not set" on every
 * PATCH (kotlinx.serialization with explicit nulls). A model-only edit must not
 * silently switch local extensions off, so null keeps the stored choice for a
 * Built-in agent staying on Built-in; otherwise it is dropped (not set). An
 * explicit true/false is left for parseRuntimeConfig to validate.
 */
function retainNullLoadLocalPlugins(runtimeConfig: unknown, existing: RuntimeConfig): unknown {
  if (!runtimeConfig || typeof runtimeConfig !== "object" || Array.isArray(runtimeConfig)) return runtimeConfig;
  const incoming = runtimeConfig as Record<string, unknown>;
  if (incoming.loadLocalPlugins !== null) return runtimeConfig;
  const { loadLocalPlugins: _dropped, ...rest } = incoming;
  if (incoming.runtime === "builtin" && existing.runtime === "builtin" && typeof existing.loadLocalPlugins === "boolean") {
    return { ...rest, loadLocalPlugins: existing.loadLocalPlugins };
  }
  return rest;
}
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

/** The one place a new agent is announced. A personal assistant's goes to its owner only (agentEventRoom). */
function broadcastAgentCreated<T extends Record<string, unknown> & { serverId: string; assistantOwnerUserId: string | null }>(
  io: SocketServer | undefined,
  agent: T,
): void {
  io?.to(agentEventRoom(agent.serverId, agent.assistantOwnerUserId)).emit("agent:created", { agent: stripEnvVars(agent) });
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

/**
 * Refuses a save that adds or changes an env var that can make the agent's
 * computer run other code (PATH, NODE_OPTIONS, LD_PRELOAD, ...; shared
 * agentEnvVarPolicy.ts). Values the agent already had, unchanged, still save:
 * xxchan chose refusing new writes here over blocking on the Computer
 * (#proj-raft-computer:bbea62a0). Names only in the response, never values.
 */
function refuseNewlyWrittenRiskyEnvVars(
  res: Response,
  previous: Record<string, string> | null | undefined,
  next: Record<string, string> | null | undefined,
): boolean {
  const names = newlyWrittenDisallowedAgentEnvVarNames(previous, next);
  if (names.length === 0) return false;
  addTraceEvent("server.agent.env_var_write_refused", { refused_variable_count: names.length, refused_variable_names: names.join(",") });
  const pathHint = names.some((name) => name.toUpperCase() === "PATH")
    ? " Agents already get PATH from their computer: on macOS and Linux add the directory to your login shell's startup file and restart the Computer service; on Windows add it to your user PATH, then sign out and back in."
    : "";
  res.status(400).json({
    error: `Environment variables ${names.join(", ")} can make the agent's computer run other programs, so they can't be added or changed in an agent's settings. Remove them and save again.${pathHint}`,
    code: "env_var_not_allowed",
    names,
  });
  return true;
}

/**
 * The legacy reasoningEffort an update hands parseRuntimeConfig, which uses it
 * only when the submitted runtimeConfig has no value (`raw ?? legacy`). An
 * explicit null in the submitted config is a clear, so it must not be refilled
 * from the stored column; neither may another runtime's stored effort (task
 * #1334: Pi on high switched to OpenCode failed with "reasoningEffort is not
 * supported"). The stored value still fills in when the request leaves the
 * field out on the same runtime.
 */
function updateReasoningEffortFallback<Effort>(
  requestEffort: Effort | undefined,
  requestRuntimeConfig: unknown,
  updatedRuntime: unknown,
  existing: { runtime: string; reasoningEffort: Effort },
): Effort | null {
  if (requestEffort !== undefined) return requestEffort;
  if (requestRuntimeConfig === undefined) return existing.reasoningEffort;
  if (requestRuntimeConfig && typeof requestRuntimeConfig === "object" && Object.hasOwn(requestRuntimeConfig, "reasoningEffort")) return null;
  return updatedRuntime === existing.runtime ? existing.reasoningEffort : null;
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

/**
 * `{ global, workspace, state, fetchedAt? }`: the Computer's list (ok), its last
 * list after the wait budget (stale), or empty lists (unavailable).
 */
function sendAgentSkillsAnswer(res: Response, answer: ComputerProbeAnswer<AgentSkillsList>): void {
  setRequestTraceComputerProbeState(res, answer.state);
  const skills = answer.state === "unavailable" ? { global: [], workspace: [] } : answer.value;
  res.json({ global: skills.global, workspace: skills.workspace, ...computerProbeFreshness(answer) });
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
    raftbenchService: agent.raftbenchService === true,
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
    raftbenchService: agent.raftbenchService === true,
    status: agent.status,
    deletedAt: agent.deletedAt ?? null,
    ...(typeof agent.inMemberLists === "boolean" ? { inMemberLists: agent.inMemberLists } : {}),
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
  agent: { creatorType: string | null; creatorId: string | null; assistantOwnerUserId: string | null },
): Promise<boolean> {
  const callerRole = await getActorServerRoleInServer(serverId, "user", userId);
  return roleCanInspectAgentPrivateSurfaces(callerRole, userId, agent);
}

/**
 * Protocol v2 submit (create and edit alike): the client sends field values and
 * the server assembles the runtimeConfig, which then goes through the same
 * validation as any request. The envelope is checked against the v2 registry
 * (runtimeFormV2Registry), never the v1 refs: a runtime may have a v2 form and
 * no v1 form. Issues from the later validation point at /runtimeConfig/...; a v2
 * client only has field values, so they are rewritten to /formValues/<field>.
 * Returns undefined for a non-v2 request, "handled" when a 400 was sent.
 */
/**
 * v2 saved-connection submits (capability `provider.saved_connection`): the
 * connection's provider is resolved server-side BEFORE the field mapping, so
 * the model kind follows the connection (a gateway connection always stores a
 * custom model even when the typed name collides with a built-in preset id),
 * never the client's value. An unavailable connection throws
 * ProviderConnectionError, which each route's catch maps exactly like the
 * direct flow. Flag off or not a connection submit: undefined, and the static
 * fallback in the registry applies.
 */
async function savedConnectionProviderIdForSubmit(req: Request): Promise<string | undefined> {
  const ref = req.body?.formDefinitionRef as { protocolVersion?: unknown; runtimeId?: unknown } | undefined;
  if (!isRuntimeFormV2SubmitProtocol(ref?.protocolVersion) || ref?.runtimeId !== "builtin") return undefined;
  const providerId = (req.body?.formValues as { providerId?: unknown } | undefined)?.providerId;
  if (typeof providerId !== "string" || !providerId.startsWith(SAVED_CONNECTION_VALUE_PREFIX)) return undefined;
  const connectionId = providerId.slice(SAVED_CONNECTION_VALUE_PREFIX.length).trim();
  if (!connectionId || !SAVED_CONNECTION_ID_SHAPE.test(connectionId)) return undefined;
  if (!await isProviderConnectionsEnabled(req.serverId!)) return undefined;
  const resolved = await resolveProviderConnectionSelection(req.serverId!, connectionId);
  return resolved.providerId;
}

/**
 * #proj-runtime:#50: a non-v2 edit whose runtimeConfig keeps the same Built-in
 * custom model but sends neither limit (a client that predates them) keeps the
 * stored `contextWindow` / `maxOutputTokens`, as a write-only secret is kept.
 * A model or runtime change, or either field sent, is taken as written.
 */
function keepStoredCustomModelLimits(runtimeConfig: unknown, existing: Parameters<typeof hydrateRuntimeConfig>[0]): unknown {
  const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isRecord(runtimeConfig) || runtimeConfig.runtime !== "builtin" || !isRecord(runtimeConfig.model)) return runtimeConfig;
  const incoming = runtimeConfig.model;
  if (incoming.kind !== "custom" || "contextWindow" in incoming || "maxOutputTokens" in incoming) return runtimeConfig;
  let stored: ReturnType<typeof hydrateRuntimeConfig>;
  try {
    stored = hydrateRuntimeConfig(existing);
  } catch {
    return runtimeConfig;
  }
  if (stored.runtime !== "builtin" || stored.model.kind !== "custom") return runtimeConfig;
  if (typeof incoming.name !== "string" || incoming.name.trim() !== stored.model.name) return runtimeConfig;
  const { contextWindow, maxOutputTokens } = stored.model;
  if (contextWindow === undefined && maxOutputTokens === undefined) return runtimeConfig;
  return {
    ...runtimeConfig,
    model: {
      ...incoming,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    },
  };
}

function adoptRuntimeFormV2Submission(
  req: Request,
  res: Response,
  options: RuntimeFormValuesOptions & { editing: boolean },
): { runtimeConfig: Record<string, unknown>; formDefinitionRef: RuntimeFormV2SubmitRef } | "handled" | undefined {
  const ref = req.body?.formDefinitionRef as { protocolVersion?: unknown; runtimeId?: unknown } | undefined;
  // protocolVersion 2 or 3: the same formValues semantics (v3 only changes the form's shape).
  if (!isRuntimeFormV2SubmitProtocol(ref?.protocolVersion)) return undefined;
  const refIssues = validateRuntimeFormV2SubmitRef(ref);
  if (refIssues.length > 0) {
    res.status(400).json({ error: "This runtime has no v2 runtime form", issues: refIssues });
    return "handled";
  }
  // An untrusted saved-connection id is a field-level 400 here — before any
  // resolution or DB lookup (a well-formed but absent id stays a 409 from the
  // route's connection resolution; the service also fail-closes on shape).
  if (ref.runtimeId === "builtin") {
    const submittedProviderId = (req.body?.formValues as { providerId?: unknown } | undefined)?.providerId;
    if (typeof submittedProviderId === "string" && submittedProviderId.startsWith(SAVED_CONNECTION_VALUE_PREFIX)) {
      const submittedConnectionId = submittedProviderId.slice(SAVED_CONNECTION_VALUE_PREFIX.length).trim();
      if (!submittedConnectionId || !SAVED_CONNECTION_ID_SHAPE.test(submittedConnectionId)) {
        res.status(400).json({
          error: "Runtime form values are invalid",
          issues: [{
            code: submittedConnectionId ? "connection_id_malformed" : "select_valid_provider",
            pointer: "/formValues/providerId",
          }],
        });
        return "handled";
      }
    }
  }
  let formValues: unknown = req.body?.formValues;
  // task #10: an edit save from a client that cannot show a typed OpenRouter
  // model or its limits keeps what a newer client stored, or is refused when
  // it changes the target (guardBuiltInEditFromClient).
  if (ref.runtimeId === "builtin" && options.editing) {
    const clientCapabilities = parseRuntimeFormV2ClientCapabilities(req.query[RUNTIME_FORM_V2_CLIENT_CAPABILITIES_QUERY]);
    const guard = guardBuiltInEditFromClient(formValues, options.existing, clientCapabilities);
    if (!guard.ok) {
      refuse(res, 409, { code: guard.issue.code, error: guard.message, details: { issues: [guard.issue] } });
      return "handled";
    }
    formValues = guard.values;
  }
  const built = buildRuntimeConfigFromFormValues(ref.runtimeId, formValues, options);
  if (!built.ok) {
    res.status(400).json({ error: built.message ?? "Runtime form values are invalid", issues: [built.issue] });
    return "handled";
  }
  const sendJson = res.json.bind(res);
  res.json = (payload: unknown) => {
    const issues = (payload as { issues?: unknown } | null)?.issues;
    if (Array.isArray(issues)) {
      for (const issue of issues as Array<{ pointer?: unknown }>) {
        if (typeof issue?.pointer === "string") {
          issue.pointer = formValuesPointerForRuntimeConfigPointer(ref.runtimeId, issue.pointer);
        }
      }
    }
    return sendJson(payload);
  };
  return { runtimeConfig: built.runtimeConfig, formDefinitionRef: built.formDefinitionRef };
}

/**
 * v2 submit: let the Computer's live model list decide what the static
 * validation could not (reconcileRuntimeFormV2SubmissionWithLiveModels): keep a
 * reasoning effort the live option offers, refuse one it does not, and store a
 * live-listed model as a preset. Updates `normalized` in place; returns the 400
 * body when the selection is refused.
 */
async function applyRuntimeFormV2LiveModels(
  req: Request,
  normalized: { runtimeConfig: RuntimeConfig | null; launch: LaunchPlan | null },
  submittedReasoningEffort: unknown,
  machineId: string | null | undefined,
  existing: RuntimeConfig | null = null,
): Promise<{ error: string; issues: AgentCreateFormIssue[] } | null> {
  if (!normalized.runtimeConfig) return null;
  const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
  const result = await reconcileRuntimeFormV2SubmissionWithLiveModels({
    runtimeConfig: normalized.runtimeConfig,
    submittedReasoningEffort,
    existing,
    machineId,
    detect: (id, runtime) => agentOrchestrator.detectMachineRuntimeModels(id, runtime),
  });
  if (result.kind === "rejected") {
    return { error: "This reasoning effort is not available for the selected model on this computer", issues: [result.issue] };
  }
  if (result.kind === "updated") {
    normalized.runtimeConfig = result.runtimeConfig;
    normalized.launch = buildLaunchPlan(result.runtimeConfig);
  }
  return null;
}

async function currentUserCanActOnAgent(
  serverId: string,
  userId: string,
  agent: { creatorType: string | null; creatorId: string | null; assistantOwnerUserId: string | null },
  capability: ServerCapability,
  options: { stop?: boolean } = {},
): Promise<boolean> {
  const callerRole = await getActorServerRoleInServer(serverId, "user", userId);
  const subject = capability === "deleteAgents" ? await withAssistantOwnerMembership(serverId, agent) : agent;
  return userCanActOnAgentResource(callerRole, userId, subject, capability, options);
}

/**
 * The GET /api/agents items for one human (guests: the channel-summary
 * profiles of the agents they share a channel with), and the route's
 * `response.ready` trace attributes. `agentIds` (GET /api/sync/changes
 * rebuilding changed rows) reads only those agents; each row is the row the
 * full list shows that viewer, live activity included.
 */
export async function buildAgentListItems(input: {
  serverId: ServerId;
  userId: string;
  agentOrchestrator: AgentOrchestrator;
  agentIds?: readonly string[];
}): Promise<{ agents: Array<Record<string, unknown>>; responseReady: TraceAttributes }> {
  const { serverId, userId, agentOrchestrator, agentIds } = input;
  const callerRole = await tracePhase(
    () => getActorServerRoleInServer(serverId, "user", userId),
    (durationMs, result) => ({
      name: "agent.permissions.checked",
      attrs: {
        can_manage: actorRoleHasServerCapability(result, "editAgents"),
      },
    }),
  );
  const list = await tracePhase(
    () => agentService.listAgents(serverId, true, {
      traceQuery: createTraceDbQueryTracer("agents.loaded"),
      agentIds,
    }),
    (durationMs, result) => ({
      name: "agents.loaded",
      attrs: {
        agents_count: result.length,
      },
    }),
  );
  const guestVisibleAgentIds = callerRole === "guest"
    ? await channelService.getAgentIdsVisibleThroughLocalChannels(serverId, userId)
    : null;
  // Another person's personal assistant is never listed, to any role (server
  // owners and admins included); the caller's own is (agentFindableBy).
  const findable = list.filter((agent) => isAgentFindableBy({ userId }, agent));
  const scopedList = guestVisibleAgentIds
    ? findable.filter((agent) => guestVisibleAgentIds.has(agent.id))
    : findable;
  const serviceRows = scopedList.length ? await getDb().select({ agentId: raftbenchServiceAgents.agentId })
    .from(raftbenchServiceAgents).where(and(eq(raftbenchServiceAgents.serverId, serverId), inArray(raftbenchServiceAgents.agentId, scopedList.map(agent => agent.id)))) : [];
  const serviceIds = new Set(serviceRows.map(row => row.agentId));
  // The directory keeps a removed App Bot and the caller's own personal
  // assistant (old messages and its DM resolve it here) and says whether
  // member lists show it; ordinary agents omit it.
  const listedBotIds = await agentService.filterAgentIdsInMemberLists(
    scopedList.filter((agent) => agent.managedByAppInstallId).map((agent) => agent.id),
  );
  const withMemberListing = <T extends { id: string; managedByAppInstallId: string | null; assistantOwnerUserId: string | null }>(agent: T) => (
    agent.assistantOwnerUserId ? { ...agent, inMemberLists: false }
      : agent.managedByAppInstallId ? { ...agent, inMemberLists: listedBotIds.has(agent.id) } : agent
  );
  if (callerRole === "guest") {
    const guestActivities = await agentOrchestrator.getActivities(scopedList, { parent: getCurrentTraceContext() });
    const publicProfiles = scopedList.map((agent, index) => {
      const { activity, activityDetail } = guestActivities[index]!;
      return toGuestChannelAgentProfile(withMemberListing({ ...agent, activity, activityDetail, raftbenchService: serviceIds.has(agent.id) }));
    });
    return {
      agents: publicProfiles,
      responseReady: { agents_count: publicProfiles.length, profile_projection: "channel_summary" },
    };
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
    () => agentIds ? serverService.getAgentMemberRoles(serverId, agentIds) : serverService.getServerAgentRoleMap(serverId),
    (durationMs, result) => ({
      name: "agent_server_roles.loaded",
      attrs: {
        agents_count: result.size,
      },
    }),
  );
  // External-agent presence: max(credential last_used_at) per external
  // agent, one batched query for the page (managed agents have none).
  const externalAgentIds = scopedList.filter((a) => isExternalAgentRuntime(a.runtime)).map((a) => a.id);
  const lastSeenByAgent = externalAgentIds.length > 0
    ? await getAgentsLastSeenAt(externalAgentIds)
    : new Map<string, Date>();
  // Reconciler step 15 (B15): agents on a Computer whose access was revoked (one query for the page).
  const listedMachineIds = [...new Set(scopedList.map((a) => a.machineId).filter((id): id is string => Boolean(id)))];
  const accessRevokedMachineIds = await findAccessRevokedMachineIds(getDb(), listedMachineIds).catch((error: unknown) => {
    addTraceEvent("agent.list.computer_access.failed", { error_class: errorClassOf(error) });
    return new Set<string>();
  });
  // Version floor: agents on a Computer held below it (one check per machine).
  const heldMachineIds = new Set<string>();
  // A machine on another replica costs a query, so bound the fan-out.
  await mapWithConcurrency(listedMachineIds.filter((id) => !accessRevokedMachineIds.has(id)), 8, async (machineId) => {
    // One machine's failed check must not fail the whole list: treat it as
    // not held (the agent shows its ordinary state) and record why.
    try {
      if (await agentOrchestrator.isMachineAgentWorkHeld(machineId)) heldMachineIds.add(machineId);
    } catch (error) {
      addTraceEvent("agent.list.version_gate.failed", { machine_id: machineId, error_class: errorClassOf(error) });
    }
  });
  // #proj-raft-computer:#68: each agent's readiness (its Computer, runtime and
  // login), trimmed for this viewer. One read per Computer; a failure leaves
  // the field out (the old fields still say what they said).
  const readinessInputs = await loadComputerReadinessInputs(listedMachineIds, agentOrchestrator, heldMachineIds).catch((error: unknown) => {
    addTraceEvent("agent.list.readiness.failed", { error_class: errorClassOf(error) });
    return new Map<string, ComputerReadinessInputs>();
  });
  // Who fixes an agent's own problem, by name (kept for viewers who may not see the reason).
  const readinessOwnerNames = readinessInputs.size > 0
    ? await loadMemberDisplayNames(serverId, scopedList.map((a) => readinessAgentOwnerUserId(a))).catch(() => new Map<string, string>())
    : new Map<string, string>();
  const readinessViewer = readinessViewerForRole(userId, callerRole);
  const readinessNowMs = agentOrchestrator.getCurrentTimeMs();
  // task #1357 item 1: the Raft-defaults signal of each Built-in custom gateway agent.
  const builtInAgents = scopedList.filter((a) => a.runtime === "builtin");
  const modelLimitsByAgent = builtInAgents.length === 0 ? new Map() : await getAgentModelLimitsWarnings({
    agents: builtInAgents.map((a) => ({ id: a.id, serverId: a.serverId, runtimeConfig: withHydratedRuntimeConfig(a).runtimeConfig })),
  }).catch((error: unknown) => {
    addTraceEvent("agent.model_limits.failed", { error_class: errorClassOf(error) });
    return new Map();
  });
  // Fetch activities (in-memory orchestrator lookup, fast) per-agent then
  // batch-enrich creator + createdAgents via one combined DB pass instead
  // of 2N queries. See agentService.batchEnrichAgentsWithCreatorProfile.
  const withActivity = await tracePhase(
    async () => (await agentOrchestrator.getActivities(scopedList, { parent: getCurrentTraceContext() })).map((resolved, index) => {
      const a = scopedList[index]!;
      const { activity, activityDetail, activityDetailKind, deliveryConsumption, wakeCrashLoop, toolStuck, credentialHold } = resolved;
      return {
        ...withServerRoleProjection(withAgentProjection(a), roleByAgent.get(a.id) ?? null),
        raftbenchService: serviceIds.has(a.id),
        activity,
        activityDetail,
        // task #1116: typed detail kind + delivery-consumption carrier survive a refresh.
        ...(activityDetailKind !== undefined ? { activityDetailKind } : {}),
        ...(deliveryConsumption !== undefined ? { deliveryConsumption } : {}),
        ...(wakeCrashLoop !== undefined ? { wakeCrashLoop } : {}),
        ...(toolStuck !== undefined ? { toolStuck } : {}),
        // Reconciler step 4b: the held notice's typed reason survives a refresh.
        ...(credentialHold !== undefined ? { credentialHold } : {}),
        runtimeProfile: runtimeProfileByAgent.get(a.id) ?? null,
        ...(modelLimitsByAgent.has(a.id) ? { modelLimits: modelLimitsByAgent.get(a.id) } : {}),
        blockedReason: agentBlockedReason(a.machineId, accessRevokedMachineIds, heldMachineIds),
        ...(a.machineId && readinessInputs.has(a.machineId)
          ? { readiness: agentReadinessForViewer(a, readinessInputs.get(a.machineId)!, readinessViewer, readinessNowMs, readinessOwnerNames.get(readinessAgentOwnerUserId(a) ?? "")) }
          : {}),
        ...(isExternalAgentRuntime(a.runtime)
          ? { lastSeenAt: lastSeenByAgent.get(a.id)?.toISOString() ?? null }
          : {}),
      };
    }),
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
  const hostedRuntimeByAgent = await getHostedRuntimeSummaries(externalAgentIds);
  // App-attribution for managed bots, batched: install → client in one query
  // (the detail route does the same join for a single agent). Without it the
  // panel renders "Unknown app" from list-loaded data.
  const managedInstallIds = [...new Set(scopedList.map((a) => a.managedByAppInstallId).filter((id): id is string => Boolean(id)))];
  const managedByAppByInstall = new Map<string, { clientId: string; name: string; logoUrl: string | null; description: string | null; botStatusText: string | null }>();
  if (managedInstallIds.length > 0) {
    const appRows = await getDb().select({
      installId: oauthClientInstalls.id,
      clientId: oauthClients.id,
      name: oauthClients.name,
      logoUrl: oauthClients.logoUrl,
      description: oauthClients.description,
      botStatusText: oauthClientInstalls.botStatusText,
    }).from(oauthClientInstalls)
      .innerJoin(oauthClients, eq(oauthClients.id, oauthClientInstalls.clientId))
      .where(inArray(oauthClientInstalls.id, managedInstallIds));
    for (const row of appRows) {
      managedByAppByInstall.set(row.installId, { clientId: row.clientId, name: row.name, logoUrl: row.logoUrl, description: row.description ?? null, botStatusText: row.botStatusText ?? null });
    }
  }
  const enriched = enrichedAll.map((agent) => {
    const withAttribution = agent.managedByAppInstallId
      ? withMemberListing({ ...agent, managedByApp: managedByAppByInstall.get(agent.managedByAppInstallId) ?? null })
      : withMemberListing(agent);
    if (!userCanActOnAgentResource(callerRole, userId, withAttribution, "editAgents")) return stripEnvVars(withRuntimeErrorProjection(withAttribution, "member"));
    const hostedRuntime = hostedRuntimeByAgent.get(withAttribution.id);
    const managed = withRuntimeErrorProjection(withAttribution, "manager");
    return hostedRuntime ? { ...managed, hostedRuntime } : managed;
  });
  const strippedCount = enrichedAll.filter((agent) => !userCanActOnAgentResource(
    callerRole,
    userId,
    agent,
    "editAgents",
  )).length;
  return {
    agents: await projectAssistantPause(enriched, { userId, role: callerRole ?? null }),
    responseReady: { agents_count: enriched.length, env_vars_stripped: strippedCount > 0 },
  };
}

// List all agents in server

agentRouter.get("/", async (req, res) => {
  try {
    addTraceEvent("agents.list.started");
    const { agents, responseReady } = await buildAgentListItems({
      serverId: req.serverId!,
      userId: req.userId!,
      agentOrchestrator: req.app.get("agentOrchestrator") as AgentOrchestrator,
    });
    addTraceEvent("response.ready", responseReady);
    res.json(agents);
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
    const { name, description, model, runtime, reasoningEffort, machineId, envVars, avatarUrl, actionCardMessageId, actionCardConfirmationVersion } = req.body;
    let { runtimeConfig, formDefinitionRef } = req.body;
    const external = req.body?.external === true;
    let v2Submitted = false;
    let v2SubmittedReasoningEffort: unknown = null;
    if (!external) {
      const v2 = adoptRuntimeFormV2Submission(req, res, {
        editing: false,
        savedConnectionProviderId: await savedConnectionProviderIdForSubmit(req),
      });
      if (v2 === "handled") return;
      if (v2) ({ runtimeConfig, formDefinitionRef } = v2);
      v2Submitted = v2 !== undefined;
      v2SubmittedReasoningEffort = v2 ? v2.runtimeConfig.reasoningEffort : null;
    }
    const onboarding = req.body?.onboarding === true;
    if (external && onboarding) {
      res.status(400).json({ error: "Onboarding agent cannot be external" });
      return;
    }
    const createName = onboarding ? OFFICIAL_ONBOARDING_AGENT_IDENTITY.name : name;
    const createDescription = onboarding ? OFFICIAL_ONBOARDING_AGENT_IDENTITY.description : description;
    const createAvatarUrl = onboarding ? OFFICIAL_ONBOARDING_AGENT_IDENTITY.avatarUrl : avatarUrl;
    // A missing or non-string name is refused like an empty one (validateAgentName trims it).
    const nameError = validateAgentName(typeof createName === "string" ? createName : "", "Agent name");
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
      // Only the server sets the assistant avatar, and only on an assistant.
      if (assistantService.isReservedAssistantAvatarUrl(createAvatarUrl)) {
        res.status(400).json({ error: assistantService.AVATAR_RESERVED_ERROR, code: assistantService.AVATAR_RESERVED_CODE });
        return;
      }
    }
    // A dialog opened from an action card: refuse a frozen/stale card before any
    // Computer round-trip (Kimi model detection, catalog validation). createAgent
    // re-checks it inside the create transaction.
    if (typeof actionCardMessageId === "string") {
      if (!isUuid(actionCardMessageId)) {
        res.status(400).json({ error: "actionCardMessageId must be a UUID" });
        return;
      }
      await assertActionCardWritable(
        req.serverId!,
        actionCardMessageId,
        typeof actionCardConfirmationVersion === "number" ? actionCardConfirmationVersion : undefined,
      );
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
      // A v2 envelope was already checked against the v2 registry.
      const refIssues = v2Submitted ? [] : validateRuntimeFormDefinitionRef(formDefinitionRef);
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
    // Hosted runtime provider (raft-agent-provider.v1): only for external agents.
    const rawProvider = req.body?.provider;
    if (rawProvider !== undefined && rawProvider !== null) {
      if (!external) {
        res.status(400).json({ error: "provider is only valid for external agents", code: "agent_runtime_provider_invalid" });
        return;
      }
      if (!isAgentRuntimeProviderKind(rawProvider)) {
        res.status(400).json({ error: `Unknown runtime provider: ${String(rawProvider).slice(0, 40)}`, code: "agent_runtime_provider_invalid" });
        return;
      }
    }
    const hostedProvider = external && isAgentRuntimeProviderKind(rawProvider) ? rawProvider : null;
    // The model a hosted agent starts on: an offered id, or absent/null for the provider's default.
    const rawHostedModel = req.body?.hostedModel;
    if (rawHostedModel !== undefined && rawHostedModel !== null && !hostedProvider) {
      res.status(400).json({ error: "hostedModel is only valid for a cloud agent", code: "hosted_runtime_model_invalid" });
      return;
    }
    const hostedModel = parseHostedModelChoice(rawHostedModel);
    if (hostedModel === undefined) {
      res.status(400).json({ error: "`hostedModel` must be a model id or null", code: "hosted_runtime_model_invalid" });
      return;
    }
    if (hostedProvider) {
      await assertProviderProvisioningAvailable(req.serverId!, hostedProvider);
      const choice = await checkHostedModelChoice(req.serverId!, hostedProvider, hostedModel);
      if (sendHostedModelChoiceRefusal(res, choice, "create")) return;
    }
    // Where the server may not pick (`antiproton_model_picker` off), no model is sent: the provider decides.
    const provisionedHostedModel = hostedProvider ? await hostedModelForCreate(req.serverId!, hostedModel) : hostedModel;
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
        // Task #93 line G: re-check `createAgents` under a share lock on the creator's member row inside the create lock.
        actorCapabilityFence: { userId: req.userId!, capability: "createAgents" },
        configChangeSource: "agents_route_create",
        expectedSetupStatus,
        actionCardMessageId: typeof actionCardMessageId === "string" ? actionCardMessageId : undefined,
        actionCardConfirmationVersion: typeof actionCardConfirmationVersion === "number" ? actionCardConfirmationVersion : undefined,
        ...(hostedProvider ? {
          afterInsert: (tx, created) => recordAgentProvisioning(tx, {
            agent: created,
            provider: hostedProvider,
            createdByUserId: req.userId!,
            model: provisionedHostedModel,
          }),
        } : {}),
      });
      if (hostedProvider) kickAgentRuntimeProvisionWorker();
      const io = req.app.get("io") as SocketServer | undefined;
      await ensureCreatorAgentDmVisible({
        serverId: req.serverId!,
        creatorUserId: req.userId!,
        agentId: agent.id,
        io,
      });
      const result = await agentService.enrichAgentWithCreatorProfile(withServerRoleProjection(withAgentProjection(agent), "member"));
      broadcastAgentCreated(io, result);
      const hostedRuntime = hostedProvider ? await getHostedRuntimeSummary(agent.id) : null;
      res.json(hostedRuntime ? { ...result, hostedRuntime } : result);
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
      // Checked again under the machine row lock when the agent is written (computerAgents.ts).
      if (!await machineTakesAgents(getDb(), assignedMachine.id)) {
        sendMachineKeyRevoked(res);
        return;
      }
    }
    const isCindyOnboardingAgent = onboarding;
    // A hosted Cindy that failed setup (antiproton_cindy) is converted in place to the
    // computer Cindy this request describes, instead of a second Cindy being created.
    let convertHostedCindyId: string | null = null;
    if (isCindyOnboardingAgent) {
      const server = await serverService.getServer(req.serverId!);
      if (server?.onboardingAgentId) {
        const existingOnboardingAgent = await agentService.getAgent(server.onboardingAgentId);
        if (existingOnboardingAgent && existingOnboardingAgent.serverId === req.serverId) {
          const hostedState = await resolveHostedCindySetupState({ serverId: req.serverId!, agentId: existingOnboardingAgent.id });
          if (hostedState !== "failed") {
            res.status(409).json({
              error: "Onboarding agent already exists in this server",
              onboardingAgentId: existingOnboardingAgent.id,
            });
            return;
          }
          convertHostedCindyId = existingOnboardingAgent.id;
        }
      }
    }
    const existingAgents = isCindyOnboardingAgent && !convertHostedCindyId ? await agentService.listAgents(req.serverId!) : [];
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
    if (refuseNewlyWrittenRiskyEnvVars(res, null, normalizedConfig.runtimeConfig.envVars)) return;
    if (v2Submitted) {
      const live = await applyRuntimeFormV2LiveModels(req, normalizedConfig, v2SubmittedReasoningEffort, assignedMachine?.id);
      if (live) {
        res.status(400).json(live);
        return;
      }
    }
    if (
      normalizedConfig.runtimeConfig.runtime === "kimi-sdk"
      && formDefinitionRef === undefined
      && normalizedConfig.launch.reasoningEffort !== null
    ) {
      sendKimiReasoningEffortUpgradeRequired(res, "/formDefinitionRef");
      return;
    }
    const createAdmissionPolicy = await resolveRuntimeAdmissionPolicy({ userId: req.userId!, serverId: req.serverId! });
    if (isRuntimeDeprecatedForServer(normalizedConfig.launch.runtime, createAdmissionPolicy)) {
      res.status(400).json({ error: deprecatedRuntimeSelectionError(normalizedConfig.launch.runtime) });
      return;
    }
    if (!isRuntimeAdmittedForNewUse(normalizedConfig.launch.runtime, createAdmissionPolicy)) {
      sendRuntimeDisabled(res, normalizedConfig.launch.runtime);
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
      runtimeNeedsReportingComputer(normalizedConfig.launch.runtime)
      // An OAR-only runtime has nothing to run on without a Computer.
      && (assignedMachine
        ? !machineSupportsRuntime(assignedMachine.runtimes, normalizedConfig.launch.runtime)
        : isOarOnlyRuntime(normalizedConfig.launch.runtime))
    ) {
      sendRuntimeCapabilityUnavailable(res, normalizedConfig.launch.runtime);
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
      isBuiltInCatalogCheckedSelection(normalizedConfig.runtimeConfig)
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
        await validateBuiltInPresetForWrite(
          agentOrchestrator,
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
      if (convertHostedCindyId) {
        await convertFailedHostedCindyToComputer({
          serverId: req.serverId!,
          agentId: convertHostedCindyId,
          actorUserId: req.userId!,
          runtime: normalizedConfig.launch.runtime,
          model: normalizedConfig.launch.model,
          runtimeConfig: normalizedConfig.runtimeConfig,
          reasoningEffort: persistedAgentReasoningEffort(normalizedConfig.launch.runtime, normalizedConfig.launch.reasoningEffort) ?? null,
          envVars: normalizedConfig.persistedEnvVars ?? null,
          machineId: assignedMachine?.id ?? null,
        });
        const [converted] = await getDb().select().from(agents).where(eq(agents.id, convertHostedCindyId));
        agent = converted!;
      } else agent = await agentService.createAgent(req.serverId!, createName.trim(), {
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
        // Task #93 line G: re-check `createAgents` under a share lock on the creator's member row inside the create lock.
        actorCapabilityFence: { userId: req.userId!, capability: "createAgents" },
        configChangeSource: "agents_route_create",
        expectedSetupStatus,
        actionCardMessageId: typeof actionCardMessageId === "string" ? actionCardMessageId : undefined,
        actionCardConfirmationVersion: typeof actionCardConfirmationVersion === "number" ? actionCardConfirmationVersion : undefined,
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
      await serverService.grantOnboardingAgentRole(req.serverId!, agent.id, "admin");
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

    broadcastAgentCreated(io, result);

    res.json(result);
  } catch (err: any) {
    const msg = err?.message || "";
    if (err instanceof ServerMembershipRevokedError) {
      // Task #93 line G: the creator's removal committed after the request-level check; nothing was created.
      res.status(403).json({ error: err.message });
    } else if (err instanceof FencedAuthorizationDeniedError) {
      // Task #93 line G: the creator lost `createAgents` (demotion) before the create committed; nothing was created.
      res.status(403).json({ error: "The `createAgents` capability is required to create agents" });
    } else if (
      err instanceof BuiltInModelCatalogError ||
      err instanceof MachineCatalogStaleError
    ) {
      sendBuiltInCatalogError(res, err);
    } else if (err instanceof agentService.ServerSetupChangedRetryError) {
      res.status(409).json({ error: err.code });
    } else if (err instanceof MachineKeyRevokedError) {
      sendMachineKeyRevoked(res);
    } else if (err instanceof AssistantCannotUseComputerError) {
      sendAssistantCannotUseComputer(res);
    } else if (err instanceof ProviderConnectionError) {
      res.status(err.code === "provider_connection_invalid" ? 400 : 409).json({ error: err.message, code: err.code });
    } else if (err instanceof AgentRuntimeProviderError) {
      sendAgentRuntimeProviderError(res, err);
    } else if (err instanceof HostedCindyConversionError) {
      // The hosted Cindy stays as she was; converting her again is safe.
      res.status(503).json({ error: err.message, code: "hosted_cindy_delete_unconfirmed" });
    } else if (err instanceof AssistantReservedHandleError) {
      // Refused by the name alone, whether or not such an assistant exists.
      res.status(400).json({ error: msg, code: err.code });
    } else if (isActionCardConversionError(err)) {
      // The source action card is frozen by a channel conversion or needs
      // reconfirmation: an expected 409 the dialog shows, not a server fault.
      res.status(err.status).json({ error: err.message, code: err.code });
    } else if (isPrincipalHandleConflictError(err) || msg.includes("already taken")) {
      res.status(409).json({ error: msg });
    } else if (err instanceof CapacityLimitError) {
      notePaywallHit(req, "seat_limit_agent_create");
      // The code and the numbers, so the client can offer to add seats (or ask the owner).
      res.status(400).json({ error: msg, code: err.code, capacityLimit: err.detail });
    } else if (msg.includes("limit reached")) {
      notePaywallHit(req, "seat_limit_agent_create");
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
      sendJsonServerError(req, res, {
        error: "Failed to create agent",
        logPrefix: "agent.create error:",
        err,
      });
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
    // A personal assistant keeps Ottie's name and avatar.
    if (existing.assistantOwnerUserId) {
      res.status(403).json({ error: assistantService.ASSISTANT_PROFILE_FIXED_ERROR, code: assistantService.ASSISTANT_PROFILE_FIXED_CODE });
      return;
    }

    const currentServerRole = await getActorServerRoleInServer(req.serverId!, "agent", existing.id);
    const adoption = buildOfficialOnboardingIdentityAdoption(existing, currentServerRole);
    const updated = adoption.canAdopt
      ? await withFencedAgentAuthority(req.serverId!, req.userId!, existing.id, "editAgents", (tx) =>
        agentService.adoptOfficialOnboardingAgentIdentity(req.serverId!, existing.id, OFFICIAL_ONBOARDING_AGENT_IDENTITY, { executor: tx }))
      : existing;
    if (!updated) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    // Adoption rewrites the name, display name, description and avatar: other open clients must re-read.
    if (adoption.canAdopt) broadcastAgentUpdated(req, req.serverId!, updated.id);
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
    if (err instanceof ServerMembershipRevokedError) {
      res.status(403).json({ error: err.message });
      return;
    }
    if (err instanceof FencedAuthorizationDeniedError) {
      if (err.reason === "not_found") {
        res.status(404).json({ error: "Agent not found" });
      } else {
        res.status(403).json({ error: "The `editAgents` capability or human creator authority is required to edit agents" });
      }
      return;
    }
    if (isPrincipalHandleConflictError(err)) {
      res.status(409).json({ error: err instanceof Error ? err.message : "Agent name is already taken" });
      return;
    }
    res.status(500).json({ error: "Failed to adopt onboarding identity" });
  }
});

// Get agent (includes deleted agents for profile viewing)
// Archived (formerly deleted) agents of this server, for Settings. Registered
// before `/:id` so the literal path wins.
agentRouter.get("/archived", async (req, res) => {
  try {
    // Guests see only agents of channels they are in; the archive list is for members.
    const callerRole = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
    if (!callerRole || callerRole === "guest") {
      res.status(403).json({ error: "Archived agents are visible to server members only" });
      return;
    }
    res.json({ agents: await listArchivedAgents(req.serverId!, req.userId!) });
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to list archived agents", code: "archived_agents_list_failed", logPrefix: "[Agents] Failed to list archived agents", err });
  }
});

agentRouter.get("/:id", async (req, res) => {
  try {
    const agent = await agentService.getAgent(req.params.id, true);
    const canViewViaJoint = agent && agent.serverId !== req.serverId
      ? await channelService.canUserSeeAgentThroughJointChannel(req.serverId!, req.userId!, agent.id)
      : false;
    // Another person's personal assistant reads as missing, to every role
    // (agentFindableBy), as it does in the list.
    if (!agent || (agent.serverId !== req.serverId && !canViewViaJoint) || !isAgentFindableBy({ userId: req.userId! }, agent)) {
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
    const { activity, activityDetail, activityDetailKind, deliveryConsumption, wakeCrashLoop, toolStuck, credentialHold } = await agentOrchestrator.getActivity(agent.id, {
      parent: getCurrentTraceContext(),
    });
    const [serviceBinding] = await getDb().select({ agentId: raftbenchServiceAgents.agentId })
      .from(raftbenchServiceAgents).where(and(eq(raftbenchServiceAgents.serverId, agent.serverId), eq(raftbenchServiceAgents.agentId, agent.id))).limit(1);
    const raftbenchService = !!serviceBinding;
    if (canViewViaJoint) {
      const sourceServer = await serverService.getServer(agent.serverId);
      res.json(toJointAgentProfile({
        ...agent,
        serverName: sourceServer?.name ?? null,
        serverSlug: sourceServer?.slug ?? null,
        activity,
        activityDetail,
        raftbenchService,
      }));
      return;
    }
    // As in the list: a fetched profile must not put a removed Bot or an
    // assistant back in member lists.
    const memberListing = agent.assistantOwnerUserId
      ? { inMemberLists: false }
      : agent.managedByAppInstallId
        ? { inMemberLists: (await agentService.filterAgentIdsInMemberLists([agent.id])).has(agent.id) }
        : {};
    if (callerRole === "guest") {
      res.json(toGuestChannelAgentProfile({ ...agent, ...memberListing, activity, activityDetail, raftbenchService }));
      return;
    }
    const runtimeProfile = await agentRuntimeProfileService.getAgentRuntimeProfileSummary(agent.id);
    // task #1357 item 1: the Raft-defaults signal, derived here (the web never
    // infers it); only for a Built-in custom gateway model.
    const modelLimits = await getAgentModelLimitsWarning({
      agentId: agent.id,
      serverId: agent.serverId,
      runtimeConfig: withHydratedRuntimeConfig(agent).runtimeConfig,
    }).catch((error: unknown) => {
      // Display only: a failed lookup never fails the agent read or write.
      addTraceEvent("agent.model_limits.failed", { error_class: errorClassOf(error) });
      return null;
    });
    const serverRole = await getActorServerRoleInServer(req.serverId!, "agent", agent.id);
    // App-attribution for managed bots: install → client, so the UI can show
    // "BOT / provided by <app>" without a second round-trip.
    let managedByApp: { clientId: string; name: string; logoUrl: string | null; description: string | null; botStatusText: string | null } | null = null;
    if (agent.managedByAppInstallId) {
      const db = getDb();
      const [row] = await db.select({
        clientId: oauthClients.id,
        name: oauthClients.name,
        logoUrl: oauthClients.logoUrl,
        description: oauthClients.description,
        botStatusText: oauthClientInstalls.botStatusText,
      }).from(oauthClientInstalls)
        .innerJoin(oauthClients, eq(oauthClients.id, oauthClientInstalls.clientId))
        .where(eq(oauthClientInstalls.id, agent.managedByAppInstallId))
        .limit(1);
      managedByApp = row ?? null;
    }
    const result = await agentService.enrichAgentWithCreatorProfile({
      ...withServerRoleProjection(withAgentProjection(agent), serverRole),
      raftbenchService,
      activity,
      activityDetail,
      // task #1116: typed detail kind + delivery-consumption carrier survive a refresh.
      ...(activityDetailKind !== undefined ? { activityDetailKind } : {}),
      ...(deliveryConsumption !== undefined ? { deliveryConsumption } : {}),
      ...(wakeCrashLoop !== undefined ? { wakeCrashLoop } : {}),
      ...(toolStuck !== undefined ? { toolStuck } : {}),
      ...(credentialHold !== undefined ? { credentialHold } : {}),
      runtimeProfile,
      ...(modelLimits ? { modelLimits } : {}),
      managedByApp,
      ...memberListing,
    });
    const [projected] = await projectAssistantPause([result], { userId: req.userId!, role: callerRole ?? null });
    if (!canManage) {
      res.json(stripEnvVars(withRuntimeErrorProjection(projected!, "member")));
      return;
    }
    const hostedRuntime = isExternalAgentRuntime(agent.runtime) ? await getHostedRuntimeSummary(agent.id) : null;
    const managed = withRuntimeErrorProjection(projected!, "manager");
    res.json(hostedRuntime ? { ...managed, hostedRuntime } : managed);
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
    res.json({
      context: "existing_agent",
      machineId: machine?.serverId === req.serverId ? machine.id : null,
      options: projectExistingAgentRuntimeOptions(
        machine?.serverId === req.serverId ? machine.runtimes ?? [] : [],
        agent.runtime,
        runtimeOptionProjectionFromHeaders(req.headers),
        await resolveRuntimeAdmissionPolicy({ userId: req.userId!, serverId: req.serverId! }),
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
    const { setupState, credentialLastUsedAt } = await externalAgentSetupState(agent.id);
    const recentActivity = await agentOrchestrator.listRecentActivityLog(agent.id, 1);
    const lastActivityAt = recentActivity.length > 0 ? recentActivity[0].timestamp : null;
    const hostedRuntime = await getHostedRuntimeSummary(agent.id);
    res.json({
      setupState,
      credentialLastUsedAt: credentialLastUsedAt ? credentialLastUsedAt.toISOString() : null,
      // How its person said it would connect (null: made before this; shown as an existing agent's CLI login).
      externalSetupMethod: agent.externalSetupMethod ?? null,
      lastActivityAt,
      ...(hostedRuntime ? { hostedRuntime } : {}),
    });
  } catch {
    res.status(500).json({ error: "Failed to get external agent status" });
  }
});

// How an external agent's person means to connect it (#wg-external-agent-ux:#2): set by the create dialog
// right after the agent is made, and by the agent page's "Build it with the SDK instead" / "Use an existing
// agent instead". Only which instructions the page shows first; it changes no credential or connection.
agentRouter.put("/:id/external-setup-method", async (req, res) => {
  const denied = "Changing how this agent connects needs the `editAgents` capability, or being the person who made it.";
  try {
    const agent = await agentService.getAgent(req.params.id);
    if (!agent || agent.serverId !== req.serverId) {
      refuse(res, 404, { code: "agent_not_found", error: "No agent in this server has that id." });
      return;
    }
    // Authority first (Warden, #14534): what kind of agent it is is told only to someone who may change it.
    if (!await currentUserCanActOnAgent(req.serverId!, req.userId!, agent, "editAgents")) {
      refuse(res, 403, { code: "insufficient_role", error: denied });
      return;
    }
    if (!isExternalAgentRuntime(agent.runtime)) {
      refuse(res, 400, { code: "agent_not_external", error: "Only an external agent has a setup method." });
      return;
    }
    const method = (req.body as { method?: unknown } | undefined)?.method;
    if (method !== "existing_agent" && method !== "sdk") {
      refuse(res, 400, { code: "external_setup_method_invalid", error: "Send method as existing_agent or sdk." });
      return;
    }
    // Written under the actor's authority fence, as PATCH /agents/:id, scopes and credentials are.
    await withFencedAgentAuthority(req.serverId!, req.userId!, agent.id, "editAgents", (tx) =>
      tx.update(agents).set({ externalSetupMethod: method }).where(eq(agents.id, agent.id)));
    res.json({ externalSetupMethod: method });
  } catch (err) {
    if (err instanceof ServerMembershipRevokedError) {
      refuse(res, 403, { code: "server_membership_revoked", error: err.message });
      return;
    }
    if (err instanceof FencedAuthorizationDeniedError) {
      if (err.reason === "not_found") refuse(res, 404, { code: "agent_not_found", error: "No agent in this server has that id." });
      else refuse(res, 403, { code: "insufficient_role", error: denied });
      return;
    }
    res.status(500).json({ error: "Failed to set how the agent connects" });
  }
});

// Diagnostics for external agents (the agent panel's "Copy diagnostic info"):
// presence, reported status, push webhook, cursor pulls, provisioning and
// account connections. Same access as the other private agent surfaces; the
// view carries no secrets (the push endpoint is reduced to its host).
agentRouter.get("/:id/external-diagnostics", async (req, res) => {
  try {
    const agent = await agentService.getAgent(req.params.id);
    if (!agent || agent.serverId !== req.serverId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    if (!isExternalAgentRuntime(agent.runtime)) {
      res.status(400).json({ error: "Agent is not external", code: "agent_not_external" });
      return;
    }
    const callerRole = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
    if (!roleCanInspectAgentPrivateSurfaces(callerRole, req.userId!, agent)) {
      res.status(403).json({ error: "The `editAgents` capability or human creator authority is required to view external agent diagnostics" });
      return;
    }
    const diagnostics = await getExternalAgentDiagnostics({
      agent,
      agentOrchestrator: req.app.get("agentOrchestrator") as AgentOrchestrator,
      viewer: { userId: req.userId!, role: callerRole, agentOwnerUserId: mcpAgentOwnerUserId(agent) },
    });
    res.setHeader("Cache-Control", "no-store");
    res.json(diagnostics);
  } catch (err) {
    console.error("[agents] external diagnostics failed", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to get external agent diagnostics" });
  }
});

// View Context (status, view, who viewed). Every refusal (flag off for this
// Server, an agent that is missing, deleted or another Server's, a message that
// is not this agent's, a caller who may not view it) is the same 404 as an
// unknown agent, so the answer tells none of them apart. Access is read fresh
// on every request and checked before anything about the Computer.
async function findContextViewableAgent(req: Request) {
  const flag = await evaluateFeatureFlag({ key: AGENT_CONTEXT_VIEW_FEATURE_FLAG_KEY, serverId: req.serverId!, userId: req.userId! });
  if (!flag.enabled) return null;
  const agent = await agentService.getAgent(String(req.params.id));
  if (!agent || agent.serverId !== req.serverId) return null;
  return await canViewAgentContext(req.serverId!, req.userId!, agent) ? agent : null;
}

const contextViewNotFound = (res: Response) => res.status(404).json(AGENT_CONTEXT_VIEW_NOT_FOUND);

// Whether the context behind the agent's messages can be opened now, and why not.
agentRouter.get("/:id/context-view/status", async (req, res) => {
  try {
    const agent = await findContextViewableAgent(req);
    if (!agent) {
      contextViewNotFound(res);
      return;
    }
    const status = await resolveAgentContextViewStatus(agent, req.app.get("agentOrchestrator") as AgentOrchestrator);
    res.setHeader("Cache-Control", "no-store");
    res.json(status);
  } catch (err) {
    console.error("[agents] context view status failed", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to get the context view status" });
  }
});

// The model context behind one message the agent sent (agentContextViewRelay.ts):
// `{ok:true, context}` streamed from the agent's Computer, or
// `{ok:false, reason, computer, computerOwner}`.
agentRouter.get("/:id/messages/:messageId/context", async (req, res) => {
  try {
    const agent = await findContextViewableAgent(req);
    const [message] = agent
      ? await getDb()
        .select({ id: messages.id })
        .from(messages)
        .innerJoin(channels, eq(channels.id, messages.channelId))
        .where(and(
          eq(messages.id, String(req.params.messageId)),
          eq(messages.senderType, "agent"),
          eq(messages.senderId, agent.id),
          eq(channels.serverId, agent.serverId),
        ))
        .limit(1)
      : [];
    if (!agent || !message) {
      contextViewNotFound(res);
      return;
    }
    const relay = req.app.get("agentContextViewRelay") as AgentContextViewRelay;
    await relay.openView({
      res,
      viewerUserId: req.userId!,
      agent: { id: agent.id, serverId: agent.serverId, runtime: agent.runtime, machineId: agent.machineId ? asMachineId(agent.machineId) : null },
      messageId: message.id,
      orchestrator: req.app.get("agentOrchestrator") as AgentOrchestrator,
    });
  } catch (err) {
    console.error("[agents] context view failed", serializeErrorForLog(err));
    if (!res.headersSent) res.status(500).json({ error: "Failed to get the context view" });
  }
});

// Who viewed the agent's context (optionally for one message), newest first.
// The refusal rule runs first; a malformed messageId is then the same 404
// (no message of this agent has that id), so nothing tells a refusal apart.
agentRouter.get("/:id/context-views", async (req, res) => {
  try {
    const agent = await findContextViewableAgent(req);
    const messageId = req.query.messageId;
    if (!agent || (messageId !== undefined && (typeof messageId !== "string" || !isUuid(messageId)))) {
      contextViewNotFound(res);
      return;
    }
    const views = await listAgentContextViews({ serverId: agent.serverId, agentId: agent.id, messageId });
    res.setHeader("Cache-Control", "no-store");
    res.json({ views } satisfies AgentContextViewRecordList);
  } catch (err) {
    console.error("[agents] context views failed", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to list the context views" });
  }
});

// Hosted runtime provisioning (raft-agent-provider.v1): our record plus, when
// provisioned, the provider's own view (push status) as a passthrough.
agentRouter.get("/:id/hosted-runtime", async (req, res) => {
  try {
    const agent = await agentService.getAgent(req.params.id);
    if (!agent || agent.serverId !== req.serverId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    if (!await canInspectAgentPrivateSurfaces(req.serverId!, req.userId!, agent)) {
      res.status(403).json({ error: "The `editAgents` capability or human creator authority is required to view cloud agent status" });
      return;
    }
    const hostedRuntime = await getHostedRuntimeSummary(agent.id);
    if (!hostedRuntime) {
      res.status(404).json({ error: "Agent is not a cloud agent", code: "hosted_runtime_missing" });
      return;
    }
    if (await isAgentRuntimeProviderKillSwitched(hostedRuntime.provider)) {
      sendAgentRuntimeProviderError(res, hostedRuntimeDisabledError());
      return;
    }
    const provider = req.query.live === "1"
      ? await fetchProviderAgentStatus(agent.id)
      : null;
    // A hosted Cindy's setup state for her DM's banner: `failed` only once she is past
    // the 3-minute timeout and the automatic retry (null when not a hosted Cindy).
    const onboardingSetup = await resolveHostedCindySetupState({ serverId: req.serverId!, agentId: agent.id });
    res.setHeader("Cache-Control", "no-store");
    res.json({
      hostedRuntime,
      onboardingSetup,
      ...(provider ? { provider: provider.kind === "ok" ? { status: provider.status } : { unavailable: provider.reason } } : {}),
    });
  } catch {
    res.status(500).json({ error: "Failed to get cloud agent status" });
  }
});

// Usage of a hosted agent (tokens, tool calls) as reported by its provider, in
// time buckets. Default: the last 7 days, daily buckets; at most 31 days.
agentRouter.get("/:id/hosted-runtime/usage", async (req, res) => {
  try {
    const agent = await agentService.getAgent(req.params.id);
    if (!agent || agent.serverId !== req.serverId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    if (!await canInspectAgentPrivateSurfaces(req.serverId!, req.userId!, agent)) {
      res.status(403).json({ error: "The `editAgents` capability or human creator authority is required to view cloud agent usage" });
      return;
    }
    const hostedRuntime = await getHostedRuntimeSummary(agent.id);
    if (!hostedRuntime) {
      res.status(404).json({ error: "Agent is not a cloud agent", code: "hosted_runtime_missing" });
      return;
    }
    if (await isAgentRuntimeProviderKillSwitched(hostedRuntime.provider)) {
      sendAgentRuntimeProviderError(res, hostedRuntimeDisabledError());
      return;
    }
    const query = parseHostedUsageQuery(req.query, new Date());
    if (!query.ok) {
      res.status(400).json({ error: query.error, code: "hosted_runtime_usage_invalid_query" });
      return;
    }
    const result = await fetchHostedAgentUsage(agent.id, { from: query.from, to: query.to, bucket: query.bucket });
    res.setHeader("Cache-Control", "no-store");
    if (result.kind !== "ok") {
      const failure = sendHostedSurfaceFailure(res, result, "usage");
      addTraceEvent("agent.hosted_runtime.usage.failed", {
        route_action: "hosted_runtime_usage",
        outcome: "error",
        reason: failure.reason,
        http_status: failure.status,
        response_code: failure.code,
      });
      return;
    }
    res.json(result.body);
  } catch {
    res.status(500).json({ error: "Failed to get cloud agent usage" });
  }
});

function sendHostedModelFailure(
  res: Response,
  failure: Exclude<HostedAgentModelResult, { kind: "ok" }>,
): { status: number; code: string; reason: string } {
  const providerCode = "error" in failure ? failure.error?.code ?? null : null;
  const [status, code, error] = ((): [number, string, string] => {
    switch (failure.kind) {
      case "not_listed": return [422, "hosted_runtime_model_not_offered", "The provider does not offer this model"];
      case "locked": return [409, "hosted_runtime_model_locked", "An administrator has set this agent's model"];
      case "bad_request": return [400, "hosted_runtime_model_bad_request", failure.error?.message || "The provider rejected the request"];
      case "not_found": return [404, "hosted_runtime_model_not_found", failure.error?.message || "Not found"];
      case "unavailable": return [409, "hosted_runtime_model_not_ready", "The cloud runtime is not ready"];
      case "upstream_unavailable": return [502, "hosted_runtime_model_unavailable", "The cloud runtime is unavailable right now"];
    }
  })();
  const reason = "reason" in failure ? failure.reason : providerCode ?? failure.kind;
  res.status(status).json({ error, code, ...(providerCode ? { providerCode } : {}), ...("reason" in failure ? { reason: failure.reason } : {}) });
  return { status, code, reason };
}

/** `undefined` for an invalid value; absent and `null` both mean the provider's default. */
function parseHostedModelChoice(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string" && raw.trim().length > 0 && raw.length <= 200) return raw.trim();
  return undefined;
}

/**
 * Refuses a model picked for a new (or re-provisioned) hosted agent before
 * anything is written. Returns true when a refusal was sent.
 */
function sendHostedModelChoiceRefusal(res: Response, choice: HostedModelChoiceResult, action: "create" | "retry"): boolean {
  if (choice.kind === "ok") return false;
  const [status, code, error] = ((): [number, string, string] => {
    switch (choice.kind) {
      case "not_listed": return [422, "hosted_runtime_model_not_offered", "The provider does not offer this model; pick one from the current list"];
      case "locked": return [409, "hosted_runtime_model_locked", "An administrator sets the model on this server; leave the model out to use it"];
      case "picker_disabled": return [403, "model_picker_disabled", "This server does not pick a cloud agent model; leave the model out"];
      default: return [502, "hosted_runtime_model_unavailable", "The cloud runtime is unavailable right now"];
    }
  })();
  addTraceEvent("agent.hosted_runtime.model_choice.refused", {
    route_action: action === "create" ? "agent_create" : "hosted_runtime_retry",
    outcome: "error",
    reason: "reason" in choice ? choice.reason : choice.kind,
    http_status: status,
    response_code: code,
  });
  res.status(status).json({ error, code });
  return true;
}

async function hostedModelAgentGuard(
  req: Request,
  res: Response,
  action: "view" | "change",
): Promise<{ id: string } | null> {
  const agent = await agentService.getAgent(String(req.params.id));
  if (!agent || agent.serverId !== req.serverId) {
    res.status(404).json({ error: "Agent not found" });
    return null;
  }
  const allowed = action === "view"
    ? await canInspectAgentPrivateSurfaces(req.serverId!, req.userId!, agent)
    : await currentUserCanActOnAgent(req.serverId!, req.userId!, agent, "editAgents");
  if (!allowed) {
    res.status(403).json({ error: `The \`editAgents\` capability or human creator authority is required to ${action} a cloud agent's model` });
    return null;
  }
  const hostedRuntime = await getHostedRuntimeSummary(agent.id);
  if (!hostedRuntime) {
    res.status(404).json({ error: "Agent is not a cloud agent", code: "hosted_runtime_missing" });
    return null;
  }
  if (await isAgentRuntimeProviderKillSwitched(hostedRuntime.provider)) {
    sendAgentRuntimeProviderError(res, hostedRuntimeDisabledError());
    return null;
  }
  return { id: agent.id };
}

// The model a hosted agent runs on, and the models its provider offers.
agentRouter.get("/:id/hosted-runtime/model", async (req, res) => {
  try {
    const agent = await hostedModelAgentGuard(req, res, "view");
    if (!agent) return;
    const result = await getHostedAgentModel(agent.id);
    res.setHeader("Cache-Control", "no-store");
    if (result.kind !== "ok") {
      const failure = sendHostedModelFailure(res, result);
      addTraceEvent("agent.hosted_runtime.model.failed", {
        route_action: "hosted_runtime_model_read", outcome: "error",
        reason: failure.reason, http_status: failure.status, response_code: failure.code,
      });
      return;
    }
    res.json(result.view);
  } catch {
    res.status(500).json({ error: "Failed to get the cloud agent's model" });
  }
});

// Pick an offered model ({model: id}) or follow the provider's default
// ({model: null}). Takes effect from the agent's next turn.
agentRouter.put("/:id/hosted-runtime/model", async (req, res) => {
  try {
    const agent = await hostedModelAgentGuard(req, res, "change");
    if (!agent) return;
    const raw = (req.body as { model?: unknown } | undefined)?.model;
    if (!(raw === null || (typeof raw === "string" && raw.trim().length > 0 && raw.length <= 200))) {
      res.status(400).json({ error: "`model` must be a model id or null", code: "hosted_runtime_model_invalid" });
      return;
    }
    // Where the server may not pick, only Raft's model (or the default) is accepted.
    if (raw !== null && raw.trim() !== HOSTED_DEFAULT_MODEL && !await isHostedModelPickerEnabled(req.serverId!)) {
      addTraceEvent("agent.hosted_runtime.model.failed", {
        route_action: "hosted_runtime_model_change", outcome: "error",
        reason: "picker_disabled", http_status: 403, response_code: "model_picker_disabled",
      });
      res.status(403).json({ error: "This server does not pick a cloud agent model", code: "model_picker_disabled" });
      return;
    }
    // Without the picker, "DeepSeek Flash" means "what we decide": follow the provider's default.
    const picked = raw === null || (raw.trim() === HOSTED_DEFAULT_MODEL && !await isHostedModelPickerEnabled(req.serverId!)) ? null : raw.trim();
    // A flag flipped on moments ago may not have reached the provider yet.
    if (picked !== null) await ensureServerModelPickerSynced(req.serverId!);
    const result = await setHostedAgentModel(agent.id, picked);
    res.setHeader("Cache-Control", "no-store");
    if (result.kind !== "ok") {
      const failure = sendHostedModelFailure(res, result);
      addTraceEvent("agent.hosted_runtime.model.failed", {
        route_action: "hosted_runtime_model_change", outcome: "error",
        reason: failure.reason, http_status: failure.status, response_code: failure.code,
      });
      return;
    }
    addTraceEvent("agent.hosted_runtime.model.changed", {
      route_action: "hosted_runtime_model_change", outcome: "ok",
      model_source: result.view.source, follows_default: raw === null,
    });
    res.json(result.view);
  } catch {
    res.status(500).json({ error: "Failed to change the cloud agent's model" });
  }
});

/**
 * Agent Lounge v0 (#proj-chat:#15): open the agent's lounge, creating it on
 * first open. 404 while agent_lounge_v0 is off for this Server, and for an
 * agent the caller cannot reach (another Server's, deleted, or a personal
 * assistant, which stays in its owner's DM). Guests cannot open one. Opening
 * does not join the caller; their first post does.
 */
agentRouter.post("/:id/lounge", async (req, res) => {
  try {
    const flag = await evaluateFeatureFlag({ key: AGENT_LOUNGE_FEATURE_FLAG_KEY, serverId: req.serverId!, userId: req.userId! });
    if (!flag.enabled) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const role = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
    if (role === null || role === "guest") {
      res.status(403).json({ error: "Guests can't open an agent's lounge", code: "agent_lounge_guest" });
      return;
    }
    const agent = await agentService.getAgent(req.params.id);
    if (!agent || agent.serverId !== req.serverId || agent.assistantOwnerUserId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const { channel, created } = await openOrCreateAgentLounge(req.serverId!, agent.id);
    const joined = await channelService.isChannelHuman(channel.id, req.userId!);
    const canPost = channel.archivedAt === null && await channelService.canUserPostToChannel(channel.id, req.userId!);
    res.status(created ? 201 : 200).json({
      channel: { ...channel, loungeAgentId: agent.id, joined },
      joined,
      canPost,
    });
  } catch (err) {
    if (err instanceof AgentLoungeAgentNotFoundError) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    res.status(500).json({ error: "Failed to open agent lounge" });
  }
});

agentRouter.post("/:id/hosted-runtime/retry", async (req, res) => {
  try {
    const agent = await agentService.getAgent(req.params.id);
    if (!agent || agent.serverId !== req.serverId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    if (!await currentUserCanActOnAgent(req.serverId!, req.userId!, agent, "editAgents")) {
      res.status(403).json({ error: "The `editAgents` capability or human creator authority is required to retry provisioning" });
      return;
    }
    const existingHostedRuntime = await getHostedRuntimeSummary(agent.id);
    if (existingHostedRuntime && await isAgentRuntimeProviderKillSwitched(existingHostedRuntime.provider)) {
      sendAgentRuntimeProviderError(res, hostedRuntimeDisabledError());
      return;
    }
    // After the provider refused the picked model, the retry names the model again.
    const rawModel = (req.body as { model?: unknown } | undefined)?.model;
    let model: string | null | undefined;
    if (rawModel !== undefined) {
      model = parseHostedModelChoice(rawModel);
      if (model === undefined) {
        res.status(400).json({ error: "`model` must be a model id or null", code: "hosted_runtime_model_invalid" });
        return;
      }
      if (existingHostedRuntime?.retryNeedsModel) {
        const choice = await checkHostedModelChoice(req.serverId!, existingHostedRuntime.provider, model);
        if (sendHostedModelChoiceRefusal(res, choice, "retry")) return;
      }
    }
    const outcome = await withFencedAgentAuthority(req.serverId!, req.userId!, agent.id, "editAgents", (tx) =>
      retryAgentProvisioning(tx, agent.id, { model }));
    if (outcome === "not_found") {
      res.status(404).json({ error: "Agent is not a cloud agent", code: "hosted_runtime_missing" });
      return;
    }
    if (outcome === "nothing_to_retry") {
      res.status(409).json({ error: "Nothing to retry", code: "hosted_runtime_nothing_to_retry" });
      return;
    }
    if (outcome === "model_required") {
      res.status(409).json({
        error: "The provider refused the picked model; retry with `model` set to an offered id, or null for the default",
        code: "hosted_runtime_model_required",
      });
      return;
    }
    kickAgentRuntimeProvisionWorker();
    res.json({ hostedRuntime: await getHostedRuntimeSummary(agent.id) });
  } catch (err) {
    if (err instanceof ServerMembershipRevokedError) {
      res.status(403).json({ error: err.message });
      return;
    }
    if (err instanceof FencedAuthorizationDeniedError) {
      if (err.reason === "not_found") res.status(404).json({ error: "Agent not found" });
      else res.status(403).json({ error: "The `editAgents` capability or human creator authority is required to retry provisioning" });
      return;
    }
    res.status(500).json({ error: "Failed to retry provisioning" });
  }
});

// Account connections of provider-backed agents (raft-agent-provider.v1
// connections extension): the provider runs the OAuth flow and keeps the token;
// Raft starts it, reads status and disconnects. Only the agent's human creator
// or a server owner/admin (`editAgents`) may act; guests never.
// Their refusals leave through refuse() (lib/refusal.ts), in the shared
// envelope; the codes a client acts on are in REFUSAL_CODES.
const AGENT_CONNECTION_FORBIDDEN = "Only the agent's creator or a server owner/admin can manage its connections";

// Connections are tenant-level connectors shared by the server's agents:
// assigning one to an agent, reconnecting or disconnecting it additionally
// needs the connector's creator or a server owner/admin
// (decideAgentConnectorAuthority), and assigning also needs it to be the agent's
// owner's (connectorAssignableToAgent).
// The provider re-checks a creator claim (`403 not_creator`), answered the same.
const AGENT_CONNECTION_CONNECTOR_FORBIDDEN = "Only the connection's creator or a server admin can reconnect, switch or disconnect it";
// A connection acts as whoever signed it in, so an agent uses only its owner's (#proj-assistant:#23).
const AGENT_CONNECTION_SWITCH_OWNER_REQUIRED = "This connection belongs to someone else. An agent can only use a connection its owner created";
const AGENT_CONNECTION_CONNECT_OWNER_REQUIRED = "Only this agent's owner can connect a new account to it, so it never acts as someone else";

function refuseAgentConnectionInvalid(res: Response, error: string, details?: Record<string, unknown>): void {
  refuse(res, 400, { code: "agent_connection_invalid", error, ...withDetails(details) });
}

function refuseConnectorForbidden(res: Response, details?: Record<string, unknown>): void {
  refuse(res, 403, { code: "agent_connection_connector_forbidden", error: AGENT_CONNECTION_CONNECTOR_FORBIDDEN, ...withDetails(details) });
}

async function loadAgentForConnection(req: Request, res: Response): Promise<{ agent: { id: string; serverId: string }; provider: AgentConnectionProvider; viewer: AgentConnectionViewer } | null> {
  const provider = req.params.provider;
  if (!isAgentConnectionProvider(provider)) {
    refuse(res, 404, { code: "agent_connection_provider_unknown", error: "There are no account connections for that provider; only GitHub can be connected." });
    return null;
  }
  const agent = await agentService.getAgent(String(req.params.id));
  if (!agent || agent.serverId !== req.serverId) {
    res.status(404).json({ error: "Agent not found" });
    return null;
  }
  const callerRole = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
  if (!callerRole || callerRole === "guest" || !roleCanInspectAgentPrivateSurfaces(callerRole, req.userId!, agent)) {
    refuse(res, 403, { code: "agent_connection_forbidden", error: AGENT_CONNECTION_FORBIDDEN });
    return null;
  }
  return { agent: { id: agent.id, serverId: agent.serverId }, provider, viewer: { userId: req.userId!, role: callerRole, agentOwnerUserId: mcpAgentOwnerUserId(agent) } };
}

/**
 * Loads the agent (agent-level permission) and the connector the request
 * names, then decides the caller's authority over that connector. Answers the
 * request itself and returns null when refused; never calls the provider's
 * mutating routes without an acting role.
 */
async function loadConnectorAction(
  req: Request,
  res: Response,
  connectorId: unknown,
): Promise<{ agent: { id: string; serverId: string }; provider: AgentConnectionProvider; viewer: AgentConnectionViewer; connectorId: string; connectorCreatorId: string | null; actingRole: "creator" | "admin" } | null> {
  const loaded = await loadAgentForConnection(req, res);
  if (!loaded) return null;
  if (typeof connectorId !== "string" || !connectorId) {
    refuseAgentConnectionInvalid(res, "Name the connection to use: connectorId is required");
    return null;
  }
  const decided = await decideConnectorAction(res, loaded, connectorId);
  return decided ? { ...loaded, ...decided } : null;
}

/**
 * The connector rule for an agent the caller may already manage: looks the
 * connector up in the provider's list (its creator) and decides the acting role
 * (decideAgentConnectorAuthority: its creator, else a server owner/admin).
 * Answers the request itself and returns null when the connector is unknown
 * (404 connector_not_found) or the caller may not act on it (403
 * connector_forbidden). Used by PUT, the connector DELETE and a reconnect POST.
 */
async function decideConnectorAction(
  res: Response,
  loaded: { agent: { id: string; serverId: string }; provider: AgentConnectionProvider; viewer: AgentConnectionViewer },
  connectorId: string,
): Promise<{ connectorId: string; connectorCreatorId: string | null; actingRole: "creator" | "admin" } | null> {
  const found = await findAgentConnectionConnector(loaded.agent, loaded.provider, connectorId);
  if (!found.ok) {
    sendAgentConnectionFailure(res, found.failure);
    return null;
  }
  const actingRole = decideAgentConnectorAuthority(loaded.viewer.role, loaded.viewer.userId, found.value.creatorRaftUserId);
  if (!actingRole) {
    refuseConnectorForbidden(res);
    return null;
  }
  return { connectorId: found.value.id, connectorCreatorId: found.value.creatorRaftUserId, actingRole };
}

/**
 * A removal that took: 204 as it always was, or 200 `{revokeOnGithub: true}`
 * when the provider could not reach a copy of the credential (an added body;
 * a client that ignores it is told nothing new).
 */
function sendAgentConnectionRemoved(res: Response, removed: AgentConnectionRemoved): void {
  if (!removed.revokeOnGithub) {
    res.status(204).end();
    return;
  }
  const body: AgentConnectionRemovedView = { revokeOnGithub: true };
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json(body);
}

/**
 * The provider's own words about a refusal, as `details` of a listed code
 * (`providerCode`, `providerStatus`, `providerMessage`, sanitized): for the
 * web's "Copy details" and its reading of setup refusals; understanding the
 * refusal never depends on them.
 */
function providerRefusalDetails(code: string | null, status: number | null, message: string | null): Record<string, unknown> | undefined {
  const details = {
    ...(code ? { providerCode: code } : {}),
    ...(status !== null ? { providerStatus: status } : {}),
    ...(message ? { providerMessage: message } : {}),
  };
  return Object.keys(details).length > 0 ? details : undefined;
}

/**
 * A refusal the provider explained: its message is the sentence when it reads
 * as one (one line, a space, no command; refusalSentenceProblem), else Raft's
 * own, so a provider's message never trips the refusal check.
 */
function providerSentence(message: string | null, fallback: string): string {
  return message && refusalSentenceProblem(message) === null ? message : fallback;
}

function withDetails(details: Record<string, unknown> | undefined): { details?: Record<string, unknown> } {
  return details ? { details } : {};
}

function sendAgentConnectionFailure(res: Response, failure: AgentConnectionFailure): void {
  switch (failure.kind) {
    case "not_hosted":
      refuse(res, 400, { code: "agent_connection_not_provider_backed", error: "This agent is not a cloud agent, so it has no account connections" });
      return;
    case "disabled":
      sendAgentRuntimeProviderError(res, hostedRuntimeDisabledError());
      return;
    case "not_configured":
      refuse(res, 409, { code: "agent_runtime_provider_not_configured", error: "Cloud agents are not configured on this deployment" });
      return;
    case "not_active":
      refuse(res, 409, { code: "agent_connection_agent_not_active", error: "The agent is not provisioned on its provider yet; try again once it is ready" });
      return;
    case "unsupported":
      refuse(res, 409, { code: "agent_connection_unsupported", error: "The agent's provider does not support account connections" });
      return;
    case "agent_missing_at_provider":
      refuse(res, 409, {
        code: "agent_connection_agent_missing_at_provider",
        error: "This agent no longer exists at its provider; connections are unavailable. Recreate the agent.",
        ...withDetails(providerRefusalDetails(null, null, failure.message)),
      });
      return;
    case "connector_disconnect_partial":
      // A 5xx, not a refusal: the provider did part of the work, and the same call finishes it.
      res.status(502).json({
        error: "Disconnect partially completed; retry to finish",
        code: "agent_connection_connector_disconnect_partial",
        failedCount: failure.failedCount,
        ...(failure.revokeOnGithub ? { revokeOnGithub: true } : {}),
      });
      return;
    case "connection_disconnect_not_cleared":
      refuse(res, 409, {
        code: "agent_connection_disconnect_not_cleared",
        error: "The agent still holds the connection's credential; the connection was kept. Try again",
      });
      return;
    case "connector_not_found":
      refuse(res, 404, { code: "agent_connection_connector_not_found", error: "That connection does not exist on this server any more; reload the connections" });
      return;
    case "pending_invalid":
      refuse(res, 404, {
        code: "agent_connection_pending_invalid",
        error: "The connection link expired, was already used, or was started by someone else; start again",
        ...withDetails(providerRefusalDetails(failure.providerCode, failure.providerCode ? 404 : null, failure.message)),
      });
      return;
    case "connector_forbidden":
      refuseConnectorForbidden(res, providerRefusalDetails(failure.providerCode, failure.httpStatus, failure.message));
      return;
    case "account_mismatch":
      refuse(res, 409, {
        code: "agent_connection_account_mismatch",
        error: "The GitHub account you authorized is not the one this connection belongs to, so nothing was changed. Sign in to GitHub as the connection's account, then reconnect.",
        ...withDetails(providerRefusalDetails(failure.providerCode, failure.httpStatus, failure.message)),
      });
      return;
    case "provider_error":
      // Any other provider 4xx is a refusal with a reason the user can act on (e.g. the
      // agent has no or several GitHub plugin mounts): its message, sanitized, is the sentence.
      if (failure.httpStatus !== null && failure.httpStatus >= 400 && failure.httpStatus < 500) {
        refuse(res, 409, {
          code: "agent_connection_provider_refused",
          error: providerSentence(failure.message, "The agent's provider refused the request"),
          ...withDetails(providerRefusalDetails(failure.code, failure.httpStatus, failure.message)),
        });
        return;
      }
      res.status(502).json({
        error: "The provider could not complete the request",
        code: "agent_connection_provider_error",
        providerCode: failure.code,
        providerMessage: failure.message,
        providerStatus: failure.httpStatus,
      });
      return;
  }
}

function agentConnectionFailureCode(failure: AgentConnectionFailure): string {
  return failure.kind === "provider_error" ? failure.code : failure.kind;
}

agentRouter.get("/:id/connections/:provider", async (req, res) => {
  try {
    const loaded = await loadAgentForConnection(req, res);
    if (!loaded) return;
    const outcome = await getAgentConnectionStatus(loaded.agent, loaded.provider, loaded.viewer);
    if (!outcome.ok) {
      sendAgentConnectionFailure(res, outcome.failure);
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(outcome.value);
  } catch {
    res.status(500).json({ error: "Failed to get connection status" });
  }
});

const AGENT_CONNECTION_START_FIELDS: ReadonlySet<string> = new Set(["access", "connectorId"]);

// Start the provider's OAuth flow. With `connectorId` it is a reconnect in
// place: the provider replaces that connector's tokens at confirm (same id,
// every agent on it mended) instead of creating a new connector. Naming a
// connector needs the connector rule on top of managing the agent, decided
// here as for PUT and the connector DELETE, before the provider is called.
agentRouter.post("/:id/connections/:provider", async (req, res) => {
  try {
    const loaded = await loadAgentForConnection(req, res);
    if (!loaded) return;
    const body: Record<string, unknown> = req.body && typeof req.body === "object" ? req.body : {};
    const unknownField = Object.keys(body).find((key) => !AGENT_CONNECTION_START_FIELDS.has(key));
    if (unknownField !== undefined) {
      refuseAgentConnectionInvalid(res, "The body takes only access and connectorId", { field: unknownField.slice(0, 100) });
      return;
    }
    const rawAccess = body.access;
    if (rawAccess !== undefined && rawAccess !== null && rawAccess !== "private") {
      refuseAgentConnectionInvalid(res, "access must be \"private\" when present, for private repositories");
      return;
    }
    const access = rawAccess === "private" ? "private" : null;
    const rawConnectorId = body.connectorId;
    let reconnect: AgentConnectionReconnect | null = null;
    if (rawConnectorId !== undefined && rawConnectorId !== null) {
      if (typeof rawConnectorId !== "string" || !AGENT_CONNECTION_CONNECTOR_ID_RE.test(rawConnectorId)) {
        refuseAgentConnectionInvalid(res, "connectorId must be the id of one of the agent's connections, to reconnect it in place");
        return;
      }
      reconnect = await decideConnectorAction(res, loaded, rawConnectorId);
      if (!reconnect) return;
    } else if (loaded.viewer.userId !== loaded.viewer.agentOwnerUserId) {
      // A new connection is made by the signed-in person and bound to this agent at confirm.
      refuse(res, 403, { code: "agent_connection_owner_required", error: AGENT_CONNECTION_CONNECT_OWNER_REQUIRED });
      return;
    }
    const outcome = await startAgentConnection(loaded.agent, loaded.provider, { initiatedByUserId: req.userId!, access, reconnect });
    addTraceEvent("agent.connection.connect_initiated", {
      connection_provider: loaded.provider,
      access: access ?? "public",
      reconnect: reconnect !== null,
      ...(reconnect ? { acting_role: reconnect.actingRole } : {}),
      outcome: outcome.ok ? "success" : "failure",
      ...(outcome.ok ? {} : { error_code: agentConnectionFailureCode(outcome.failure) }),
    });
    await recordIntegrationAuditEventBestEffort({
      serverId: loaded.agent.serverId,
      eventType: "agent_connection.connect_initiated",
      outcome: outcome.ok ? "success" : "failure",
      source: "web",
      actor: { type: "human", id: req.userId! },
      subject: { type: "agent", id: loaded.agent.id },
      target: { type: "agent", id: loaded.agent.id },
      metadata: {
        connectionProvider: loaded.provider,
        access: access ?? "public",
        ...(reconnect ? { connectorId: reconnect.connectorId, actingRole: reconnect.actingRole } : {}),
        ...(outcome.ok ? { scopes: outcome.value.scopes } : { errorCode: agentConnectionFailureCode(outcome.failure) }),
      },
    });
    if (!outcome.ok) {
      sendAgentConnectionFailure(res, outcome.failure);
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(outcome.value);
  } catch {
    res.status(500).json({ error: "Failed to start connection" });
  }
});

// The provider parked the OAuth result as pending; confirm it for the signed-in
// user (re-authorized here), never for the `by` the browser brought back.
agentRouter.post("/:id/connections/:provider/confirm", async (req, res) => {
  try {
    const loaded = await loadAgentForConnection(req, res);
    if (!loaded) return;
    const pending = req.body?.pending;
    if (typeof pending !== "string" || !pending) {
      refuseAgentConnectionInvalid(res, "pending is required: the id the provider sent back with the browser");
      return;
    }
    const outcome = await confirmAgentConnection(loaded.agent, loaded.provider, { pending, confirmedByUserId: req.userId! }, loaded.viewer);
    addTraceEvent("agent.connection.confirmed", {
      connection_provider: loaded.provider,
      outcome: outcome.ok ? "success" : "failure",
      ...(outcome.ok ? {} : { error_code: agentConnectionFailureCode(outcome.failure) }),
    });
    await recordIntegrationAuditEventBestEffort({
      serverId: loaded.agent.serverId,
      eventType: "agent_connection.confirmed",
      outcome: outcome.ok ? "success" : "failure",
      source: "web",
      actor: { type: "human", id: req.userId! },
      subject: { type: "agent", id: loaded.agent.id },
      target: { type: "agent", id: loaded.agent.id },
      metadata: {
        connectionProvider: loaded.provider,
        ...(outcome.ok
          ? outcome.value.supported
            ? { account: outcome.value.account, connectorId: outcome.value.connectorId }
            : { account: null }
          : { errorCode: agentConnectionFailureCode(outcome.failure) }),
      },
    });
    if (!outcome.ok) {
      sendAgentConnectionFailure(res, outcome.failure);
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(outcome.value);
  } catch {
    res.status(500).json({ error: "Failed to confirm connection" });
  }
});

// Point this agent at a connector its owner created (creator or owner/admin of
// the connector, on top of managing the agent).
agentRouter.put("/:id/connections/:provider", async (req, res) => {
  try {
    const loaded = await loadConnectorAction(req, res, req.body?.connectorId);
    if (!loaded) return;
    if (!connectorAssignableToAgent(loaded.connectorCreatorId, loaded.viewer.agentOwnerUserId)) {
      refuse(res, 403, { code: "agent_connection_owner_required", error: AGENT_CONNECTION_SWITCH_OWNER_REQUIRED });
      return;
    }
    const outcome = await assignAgentConnectionConnector(
      loaded.agent,
      loaded.provider,
      { connectorId: loaded.connectorId, actingRaftUserId: req.userId!, actingRole: loaded.actingRole },
      loaded.viewer,
    );
    addTraceEvent("agent.connection.connector_assigned", {
      connection_provider: loaded.provider,
      acting_role: loaded.actingRole,
      outcome: outcome.ok ? "success" : "failure",
      ...(outcome.ok ? {} : { error_code: agentConnectionFailureCode(outcome.failure) }),
    });
    await recordIntegrationAuditEventBestEffort({
      serverId: loaded.agent.serverId,
      eventType: "agent_connection.connector_assigned",
      outcome: outcome.ok ? "success" : "failure",
      source: "web",
      actor: { type: "human", id: req.userId! },
      subject: { type: "agent", id: loaded.agent.id },
      target: { type: "agent", id: loaded.agent.id },
      metadata: {
        connectionProvider: loaded.provider,
        connectorId: loaded.connectorId,
        actingRole: loaded.actingRole,
        ...(outcome.ok ? {} : { errorCode: agentConnectionFailureCode(outcome.failure) }),
      },
    });
    if (!outcome.ok) {
      sendAgentConnectionFailure(res, outcome.failure);
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(outcome.value);
  } catch {
    res.status(500).json({ error: "Failed to switch connection" });
  }
});

// Disconnect a whole connector: every agent using it loses access. Addressed
// through an agent the caller can manage (the connector list comes from that
// agent's status), plus creator or owner/admin of the connector.
agentRouter.delete("/:id/connections/:provider/connectors/:connectorId", async (req, res) => {
  try {
    const loaded = await loadConnectorAction(req, res, req.params.connectorId);
    if (!loaded) return;
    const outcome = await disconnectAgentConnectionConnector(loaded.agent, {
      connectorId: loaded.connectorId,
      actingRaftUserId: req.userId!,
      actingRole: loaded.actingRole,
    });
    addTraceEvent("agent.connection.connector_disconnected", {
      connection_provider: loaded.provider,
      acting_role: loaded.actingRole,
      outcome: outcome.ok ? "success" : "failure",
      ...(outcome.ok ? {} : { error_code: agentConnectionFailureCode(outcome.failure) }),
    });
    await recordIntegrationAuditEventBestEffort({
      serverId: loaded.agent.serverId,
      eventType: "agent_connection.connector_disconnected",
      outcome: outcome.ok ? "success" : "failure",
      source: "web",
      actor: { type: "human", id: req.userId! },
      subject: { type: "agent", id: loaded.agent.id },
      target: { type: "agent", id: loaded.agent.id },
      metadata: {
        connectionProvider: loaded.provider,
        connectorId: loaded.connectorId,
        actingRole: loaded.actingRole,
        ...(outcome.ok ? {} : { errorCode: agentConnectionFailureCode(outcome.failure) }),
      },
    });
    if (!outcome.ok) {
      sendAgentConnectionFailure(res, outcome.failure);
      return;
    }
    sendAgentConnectionRemoved(res, outcome.value);
  } catch {
    res.status(500).json({ error: "Failed to disconnect the connection" });
  }
});

// Detach this agent from its connector; the connector stays for other agents.
agentRouter.delete("/:id/connections/:provider", async (req, res) => {
  try {
    const loaded = await loadAgentForConnection(req, res);
    if (!loaded) return;
    const outcome = await disconnectAgentConnection(loaded.agent, loaded.provider);
    addTraceEvent("agent.connection.disconnected", {
      connection_provider: loaded.provider,
      outcome: outcome.ok ? "success" : "failure",
      ...(outcome.ok ? {} : { error_code: agentConnectionFailureCode(outcome.failure) }),
    });
    await recordIntegrationAuditEventBestEffort({
      serverId: loaded.agent.serverId,
      eventType: "agent_connection.disconnected",
      outcome: outcome.ok ? "success" : "failure",
      source: "web",
      actor: { type: "human", id: req.userId! },
      subject: { type: "agent", id: loaded.agent.id },
      target: { type: "agent", id: loaded.agent.id },
      metadata: {
        connectionProvider: loaded.provider,
        ...(outcome.ok ? {} : { errorCode: agentConnectionFailureCode(outcome.failure) }),
      },
    });
    if (!outcome.ok) {
      sendAgentConnectionFailure(res, outcome.failure);
      return;
    }
    sendAgentConnectionRemoved(res, outcome.value);
  } catch {
    res.status(500).json({ error: "Failed to disconnect" });
  }
});

// Get recent durable activity/trajectory log for an agent
/**
 * Most rows one `/activity-log` read returns: as many as the web keeps live
 * (MAX_TRAJECTORY_ENTRIES), so a reload shows the same Raw log and Sub-agents
 * list as the page had before it.
 */
const AGENT_ACTIVITY_LOG_MAX_LIMIT = 500;

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
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, AGENT_ACTIVITY_LOG_MAX_LIMIT)) : 50;
    const entries = await agentOrchestrator.listRecentActivityLog(agent.id, limit);
    res.json(entries);
  } catch {
    res.status(500).json({ error: "Failed to load activity log" });
  }
});

/** A turn of the Activity overview before it is viewed: a stored one, or the running one. */
type OverviewTurn = agentActivityLogService.StoredTurnSummary | CurrentTurn;
/** A turn just outside what is shown, which takes part in splitting server time between turns (turnWindows). */
type NeighbourTurn = { startedAt: number; endedAt: number; lastReplyMessageId?: string };

/**
 * Turns as the Activity overview shows them (task #17), in the order given
 * (newest first, the running one first when there is one), for one viewer:
 * the presentation step of `/activity-summaries`.
 * `neighbours` are the turns just outside them, so a message or app event at
 * the edge belongs to the same turn wherever it is read.
 */
async function presentOverviewTurns(input: {
  agentId: string;
  serverId: string;
  /** Whether the viewer reads a conversation a trigger or a sent message names. */
  canAccess: (channelId: string) => Promise<boolean>;
  turns: readonly OverviewTurn[];
  neighbours: readonly NeighbourTurn[];
}) {
  const { agentId, serverId, canAccess, turns, neighbours } = input;
  // Triggers the viewer may see are named from the server's own channel and
  // message rows (one batch for the page), never from the daemon's text.
  const viewed = await viewTurnSummaries(turns, canAccess, (refs) => loadTurnTriggerFacts(agentId, serverId, refs));
  // The server time these turns own reaches halfway to the neighbours, so
  // read that far (and at least the edge slack). A turn's own last reply can
  // only push a boundary later, to a send inside this range, so the final
  // windows stay inside it.
  const windows = turnWindows(viewed, { neighbours });
  const fromMs = Math.min(...windows.map((window) => window.from), ...viewed.map((summary) => summary.startedAt - TURN_SENT_EDGE_MS));
  const toMs = Math.max(...windows.map((window) => window.to), ...viewed.map((summary) => summary.endedAt + TURN_SENT_EDGE_MS));
  // Every message each turn sent (one query, newest first), visible ones by
  // id. A full result means older ones were cut: those turns keep their
  // last-reply card rather than show a partial list. The app events (Stamp,
  // Reminders, ...) delivered in the same range, split the same way, and the
  // ones that woke a turn, by name: the same audience as the agent's app
  // events list (canInspectAgentPrivateSurfaces), and only its name and
  // summary, never the payload.
  const SENT_QUERY_LIMIT = 2000;
  const APP_EVENT_QUERY_LIMIT = 2000;
  const triggerRefs = viewed.flatMap((summary) => triggerAppEventRef(summary.trigger) ?? []);
  const [sends, delivered, resolvedTriggers] = viewed.length === 0 ? [[], [], new Map()] : await Promise.all([
    agentActivityLogService.listAgentSentMessagesWithChannelsBetween(agentId, fromMs, toMs, SENT_QUERY_LIMIT),
    listAgentAppEventsDeliveredBetween({ agentId, fromMs, toMs, limit: APP_EVENT_QUERY_LIMIT }),
    resolveAgentAppEventRefs({ agentId, refs: triggerRefs }),
  ]);
  const truncated = sends.length >= SENT_QUERY_LIMIT;
  const withSent = await attachTurnSentMessages(viewed, sends, canAccess, {
    neighbours,
    ...(truncated ? { listedFromMs: sends.at(-1)!.at } : {}),
  });
  return attachTriggerAppEvents(attachTurnAppEvents(withSent, delivered, {
    neighbours,
    sends,
    ...(delivered.length >= APP_EVENT_QUERY_LIMIT ? { listedFromMs: delivered.at(-1)!.deliveredAt } : {}),
  }), resolvedTriggers);
}

// Per-turn summaries for the Activity overview (task #17), newest first. The
// first page (no `before`) also carries `current`, the turn still running if
// one is (RunningActivityTurnSummary: `running: true`, no outcome, `endedAt`
// the time of this response), viewed like the finished ones. Older clients
// ignore it.
agentRouter.get("/:id/activity-summaries", async (req, res) => {
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
    // `before` is the previous page's `next`: "<endedAtMs>:<row id>".
    const beforeMatch = typeof req.query.before === "string" ? /^(\d+):([0-9a-f-]{36})$/i.exec(req.query.before) : null;
    const { summaries: finished, next } = await agentOrchestrator.listTurnSummaries(agent.id, {
      ...(Number.isFinite(rawLimit) ? { limit: rawLimit } : {}),
      ...(beforeMatch ? { before: { endedAt: Number(beforeMatch[1]), id: beforeMatch[2]! } } : {}),
    });
    // The running turn is folded from the activity rows after the newest
    // finished turn; work that went on after an empty wake takes it over.
    // Only while the agent's live activity is busy: rows left open by an
    // error (a usage limit) or a lost idle are no running turn. "Waiting for
    // N background tasks" is reported as working and counts: work goes on.
    const live = beforeMatch ? null : await agentOrchestrator.getActivity(agent.id, { parent: getCurrentTraceContext() });
    const busy = live !== null && coarseAgentActivityState(live.activity) === "busy";
    const { summaries, current } = await withRunningTurn(agentOrchestrator, agent.id, finished, busy);
    // The running turn is the newest, so it splits sent messages with the rest.
    const turns: OverviewTurn[] = current ? [current, ...summaries] : summaries;
    // The turns just outside this page, so a message or app event at the
    // page's edge belongs to the same turn on both pages.
    const [older, newer] = turns.length === 0 ? [null, null] : await Promise.all([
      next ? agentOrchestrator.listTurnSummaries(agent.id, { limit: 1, before: next }).then((page) => page.summaries[0] ?? null) : null,
      beforeMatch ? agentOrchestrator.getTurnSummary(agent.id, beforeMatch[2]!) : null,
    ]);
    const neighbours = [older, newer].filter((turn) => turn !== null);
    const serverId = req.serverId!;
    const userId = req.userId!;
    const canAccess = (channelId: string) => channelService.canUserAccessChannel(channelId, userId, serverId);
    const listed = await presentOverviewTurns({ agentId: agent.id, serverId, canAccess, turns, neighbours });
    res.json({
      summaries: current ? listed.slice(1) : listed,
      ...(next ? { next: `${next.endedAt}:${next.id}` } : {}),
      ...(current ? { current: listed[0] } : {}),
    });
  } catch {
    res.status(500).json({ error: "Failed to load activity summaries" });
  }
});

/**
 * #proj-runtime:#51: what people did to the agent (and Raft's own restarts)
 * in a time window, newest first, for the Activity overview. Same access as
 * the overview's turns. `since` / `until` are epoch ms.
 */
agentRouter.get("/:id/operator-events", async (req, res) => {
  try {
    const agent = await agentService.getAgent(req.params.id, true);
    if (!agent || agent.serverId !== req.serverId) {
      refuse(res, 404, { code: "agent_not_found", error: "That agent does not exist on this server." });
      return;
    }
    if (!await canInspectAgentPrivateSurfaces(req.serverId!, req.userId!, agent)) {
      refuse(res, 403, { code: "agent_activity_forbidden", error: "Viewing this agent's activity needs the editAgents capability or being its human creator." });
      return;
    }
    const epochMs = (value: unknown): number | undefined => {
      if (typeof value !== "string" || !/^\d{1,15}$/.test(value)) return undefined;
      return Number(value);
    };
    const rawLimit = Number(req.query.limit);
    const page = await listAgentOperatorEvents(agent, {
      sinceMs: epochMs(req.query.since),
      untilMs: epochMs(req.query.until),
      ...(Number.isFinite(rawLimit) ? { limit: rawLimit } : {}),
    });
    res.json(page);
  } catch {
    res.status(500).json({ error: "Failed to load agent operator events" });
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

// Runtime form protocol v2 for editing: the same form create uses, plus this
// agent's current values (writeOnly fields omitted). Clients never map a
// stored runtimeConfig back to fields themselves.
agentRouter.get("/:id/runtime-form", async (req, res) => {
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
    // The hydrated config, as the agent read, launch and the PATCH's `existing`
    // see it: older rows keep a Claude custom provider only in the envVars
    // launch mirrors, and the raw column would show it with a blank URL that
    // the save then cannot match.
    // Per-server build: a builtin edit on a server with provider connections
    // carries the saved-connection capability, x-connectionOwned markers and the
    // revision token (services/runtimeFormV2Registry).
    const clientCapabilities = parseRuntimeFormV2ClientCapabilities(req.query[RUNTIME_FORM_V2_CLIENT_CAPABILITIES_QUERY]);
    const hydrated = hydrateRuntimeConfig(existing);
    let body = await buildRuntimeFormV2EditBodyForServer(existing.runtime, hydrated, req.serverId!, clientCapabilities);
    if (body && existing.runtime === "builtin") {
      // task #10: the same client + Computer gate as the create form, plus
      // the agent's own stored limits / typed model (withBuiltInEditVisibility).
      const machine = existing.machineId ? await machineService.getMachine(asMachineId(existing.machineId)) : null;
      const typed = await builtInTypedModelProvidersFor({
        req,
        res,
        serverId: req.serverId!,
        machine: machine && machine.serverId === req.serverId ? machine : null,
        clientCapabilities,
      });
      if (typed === "handled") return;
      body = withBuiltInEditVisibility(body, typed, clientCapabilities, hydrated);
    }
    if (!body) {
      res.status(404).json({
        error: "This agent's runtime configuration has no editable runtime form",
        issues: [{ code: "no_runtime_form", pointer: "/runtimeConfig" }],
      });
      return;
    }
    // runtime_form.v3: the same edit body in v3 shapes (services/runtimeFormV3).
    if (isRuntimeFormV3Request(clientCapabilities)) {
      body = await serveRuntimeFormV3(body, {
        runtimeId: existing.runtime,
        serverId: req.serverId!,
        clientCapabilities,
        connectionsVisible: await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "manageExternalAuth"),
      });
    }
    const locale = runtimeFormCopyLocale(req.get("accept-language"));
    setRuntimeFormCopyHeaders(res, locale);
    res.json(localizeRuntimeFormV2(body, locale));
  } catch {
    res.status(500).json({ error: "Failed to load runtime form" });
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
    const { displayName, description, avatarUrl, model, runtime, reasoningEffort, envVars, restartMode, serverRole: requestedServerRole } = req.body;
    // Same fence as the upload route: a managed bot's avatar follows the app
    // logo; JSON writes must not shadow it either.
    if (avatarUrl !== undefined && existing.managedByAppInstallId) {
      res.status(403).json({ error: "A managed bot's avatar follows its app's logo and cannot be changed here", code: "app_bot_avatar_managed" });
      return;
    }
    // A personal assistant is always Ottie (name and avatar); its avatar is reserved for assistants.
    const profileRefusal = assistantService.agentProfileWriteRefusal(existing, { displayName, avatarUrl });
    if (profileRefusal) {
      res.status(profileRefusal.status).json({ error: profileRefusal.error, code: profileRefusal.code });
      return;
    }
    let { runtimeConfig, formDefinitionRef } = req.body;
    let v2Submitted = false;
    let v2SubmittedReasoningEffort: unknown = null;
    if (!isExternalAgentRuntime(existing.runtime)) {
      const v2 = adoptRuntimeFormV2Submission(req, res, {
        editing: true,
        // Fields a v2 form does not show keep their stored value.
        existing: hydrateRuntimeConfig(existing),
        savedConnectionProviderId: await savedConnectionProviderIdForSubmit(req),
      });
      if (v2 === "handled") return;
      if (v2) ({ runtimeConfig, formDefinitionRef } = v2);
      v2Submitted = v2 !== undefined;
      v2SubmittedReasoningEffort = v2 ? v2.runtimeConfig.reasoningEffort : null;
    }
    // #proj-runtime:#50: a full runtimeConfig from a client that predates the
    // custom model's limits (a v1 save) carries none; keep the stored ones. A v2
    // submit says what it means: its blank field clears them.
    if (!v2Submitted) runtimeConfig = keepStoredCustomModelLimits(runtimeConfig, existing);
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
      if (!actorCanChangeAgentServerMemberRole(callerRole, targetRole, requestedServerRole)) {
        res.status(403).json({ error: "You are not allowed to make that role change" });
        return;
      }
    }
    // Validate avatarUrl if provided (null is valid — clears to pixel avatar)
    if (avatarUrl !== undefined && avatarUrl !== null) {
      const isPixel = avatarUrl.startsWith("pixel:");
      const isRelativeAvatar = /^\/api\/avatars\/[0-9a-f-]+\/[0-9a-f]+\.webp$/.test(avatarUrl);
      const cdnBase = cdnPublicBaseUrl();
      const isCdnUrl = cdnBase !== null && avatarUrl.startsWith(cdnBase);
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
    let requestRuntimeConfig = retainNullLoadLocalPlugins(runtimeConfig, existingRuntimeConfig);
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
      // A v2 envelope was already checked against the v2 registry.
      const refIssues = v2Submitted ? [] : validateRuntimeFormDefinitionRef(formDefinitionRef);
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
            ? retainOmittedWriteOnlySecrets(
                v2Submitted ? requestRuntimeConfig : retainOmittedClaudeAuthType(requestRuntimeConfig, existingRuntimeConfig),
                existingRuntimeConfig,
              )
            : existing.runtimeConfig,
          runtime: runtime ?? existing.runtime,
          model: model ?? existing.model,
          reasoningEffort: updateReasoningEffortFallback(reasoningEffort, requestRuntimeConfig, updatedRuntime, existing),
          // undefined => keep existing; null => clear; value => the parsed map.
          envVars: envVars === undefined ? existing.envVars : parsedUpdateEnvVars,
          envVarsExplicit: envVars !== undefined,
        })
      : null;
    if (normalizedConfig?.error || (normalizedConfig && (!normalizedConfig.launch || !normalizedConfig.runtimeConfig))) {
      res.status(400).json({ error: normalizedConfig.error });
      return;
    }
    if (normalizedConfig?.runtimeConfig && refuseNewlyWrittenRiskyEnvVars(res, existingRuntimeConfig.envVars, normalizedConfig.runtimeConfig.envVars)) return;
    if (v2Submitted && normalizedConfig) {
      const live = await applyRuntimeFormV2LiveModels(req, normalizedConfig, v2SubmittedReasoningEffort, existing.machineId, existingRuntimeConfig);
      if (live) {
        res.status(400).json(live);
        return;
      }
    }
    const normalizedLaunch = normalizedConfig?.launch ?? null;
    const switchAdmissionPolicy = normalizedLaunch && normalizedLaunch.runtime !== existing.runtime
      ? await resolveRuntimeAdmissionPolicy({ userId: req.userId!, serverId: req.serverId! })
      : null;
    if (normalizedLaunch && switchAdmissionPolicy && isRuntimeDeprecatedForServer(normalizedLaunch.runtime, switchAdmissionPolicy)) {
      res.status(400).json({ error: deprecatedRuntimeSelectionError(normalizedLaunch.runtime) });
      return;
    }
    if (normalizedLaunch && switchAdmissionPolicy && !isRuntimeAdmittedForNewUse(normalizedLaunch.runtime, switchAdmissionPolicy)) {
      sendRuntimeDisabled(res, normalizedLaunch.runtime);
      return;
    }
    if (normalizedLaunch && runtimeNeedsReportingComputer(normalizedLaunch.runtime)) {
      const machine = existing.machineId
        ? await machineService.getMachine(asMachineId(existing.machineId))
        : null;
      if (!machine || machine.serverId !== req.serverId || !machineSupportsRuntime(machine.runtimes, normalizedLaunch.runtime)) {
        sendRuntimeCapabilityUnavailable(res, normalizedLaunch.runtime);
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
      normalizedRuntimeConfig &&
      isBuiltInCatalogCheckedSelection(normalizedRuntimeConfig) &&
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
        await validateBuiltInPresetForWrite(
          agentOrchestrator,
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
    // Codex `thread/resume` pins the resumed thread's model (see restartMode
    // below), so a Codex model switch needs a fresh thread just as a runtime
    // switch does. The stored session is cleared with or without restartMode:
    // a stopped agent's next start would otherwise resume the old thread on
    // the old model.
    const codexModelChanged =
      (normalizedLaunch?.runtime ?? existing.runtime) === "codex"
      && normalizedLaunch !== null
      && normalizedLaunch.model !== existing.model;
    const profileFieldsTouched = displayName !== undefined || description !== undefined || avatarUrl !== undefined;
    const updateAgentRow = profileFieldsTouched || runtimeChanged || normalizedConfig !== null;
    const runtimeConfigChanged = normalizedRuntimeConfig !== null
      && JSON.stringify(normalizedRuntimeConfig) !== JSON.stringify(existingRuntimeConfig);
    const runtimeProfileIdentityChanged =
      runtimeChanged
      || (normalizedLaunch !== null && normalizedLaunch.model !== existing.model)
      // Against the stored effort: runtimeConfig holds the Pi-only levels the
      // legacy column cannot (off, minimal), so an unchanged one is not a change.
      || (normalizedLaunch !== null
        && (normalizedLaunch.reasoningEffort ?? null) !== (existingRuntimeConfig?.reasoningEffort ?? existing.reasoningEffort ?? null))
      || runtimeConfigChanged;
    // RFC 071 §5 (F3): the terminal-failure breaker lifts only when a runtime,
    // model, reasoning or env VALUE differs from the stored one.
    const runtimeValuesChanged = runtimeProfileIdentityChanged
      || (normalizedConfig !== null
        && JSON.stringify(normalizedConfig.persistedEnvVars ?? null) !== JSON.stringify(existing.envVars ?? null));
    let updated: Awaited<ReturnType<typeof agentService.updateAgent>>;
    // Task #91: the Agent role change, the agent row update and the runtime-profile migration enqueue commit in one
    // fenced transaction: caller member row (share) → agent row (update) → agent member row. The request-level checks
    // above stay as fast refusals; the predicates are re-evaluated here under the locks. Telemetry, cache eviction
    // and the restart run only after commit (the restart is a runtime effect that task #93 fences).
    const afterCommit: Array<() => void> = [];
    let serverRoleChange: { previousRole: ServerRole; nextRole: ServerRole } | null = null;
    try {
      updated = await withFencedAgentAuthority(req.serverId!, req.userId!, req.params.id, "editAgents", async (tx, lockedRole) => {
        if (nextServerRole !== undefined) {
          const [agentMembership] = await tx
            .select({ role: serverAgentMembers.role })
            .from(serverAgentMembers)
            .where(and(eq(serverAgentMembers.serverId, req.serverId!), eq(serverAgentMembers.agentId, existing.id)))
            .for("update");
          if (!agentMembership) throw new FencedAuthorizationDeniedError("not_found");
          if (
            !actorRoleHasServerCapability(lockedRole, "changeMemberRoles")
            || !actorCanChangeAgentServerMemberRole(lockedRole, agentMembership.role, nextServerRole)
          ) {
            throw new FencedAuthorizationDeniedError("forbidden");
          }
          if (agentMembership.role !== nextServerRole) {
            await serverService.updateAgentMemberRole(req.serverId!, existing.id, nextServerRole, { executor: tx });
            await recordIntegrationAuditEvent({
              serverId: req.serverId!,
              eventType: "membership.agent_role_changed",
              outcome: "success",
              source: "web",
              actor: { type: "human", id: req.userId! },
              target: { type: "agent", id: existing.id },
              metadata: { agentId: existing.id, previousRole: agentMembership.role, nextRole: nextServerRole, ...serverAuditContextMetadata({ actorRole: lockedRole }) },
              diff: { role: { before: agentMembership.role, after: nextServerRole } },
            }, tx);
            serverRoleChange = { previousRole: agentMembership.role, nextRole: nextServerRole };
          }
        }
        const row = updateAgentRow
          ? await agentService.updateAgent(req.params.id, {
            displayName,
            description,
            avatarUrl,
            ...(runtimeChanged || codexModelChanged ? { sessionId: null } : {}),
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
          }, { executor: tx, configChange: { source: "agents_route_update", actor: { kind: "user", id: req.userId! } } })
          : existing;
        if (row && restartMode && runtimeProfileIdentityChanged) {
          await agentRuntimeProfileService.queueRuntimeProfileMigrationForAgentSettings(req.params.id, { executor: tx, afterCommit });
        }
        // Reconciler step 11b: the config the daemon runs on changed; its revision moves with this write.
        if (row && runtimeValuesChanged) await bumpAgentConfigRevision(tx, [req.params.id]);
        // Hosted runtime: name/instructions edits reach the provider as an ordered PATCH.
        if (row && (displayName !== undefined || description !== undefined)
          && await noteProvisionedAgentProfileEdit(tx, req.params.id)) {
          afterCommit.push(kickAgentRuntimeProvisionWorker);
        }
        return row;
      });
    } finally {
      releaseCatalogAuthority();
    }
    for (const effect of afterCommit) effect();
    if (!updated) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    agentOrchestrator.evictCache(req.params.id);
    broadcastAgentUpdated(req, req.serverId!, req.params.id, existing.assistantOwnerUserId);
    // Assigned inside the transaction callback, which TypeScript's narrowing cannot see.
    const roleChange = serverRoleChange as { previousRole: ServerRole; nextRole: ServerRole } | null;
    const io = req.app.get("io") as SocketServer | undefined;
    if (roleChange && io) {
      // Best effort: the role already changed; the notice only tells the agent.
      await postAgentServerRoleChangedNotice(io, agentOrchestrator, {
        serverId: req.serverId!,
        agentId: req.params.id,
        actorUserId: req.userId!,
        ...roleChange,
      }).catch((err: unknown) => {
        console.error("agents: failed to post server role change notice:", err);
      });
    }
    // task #1221: a runtime-config/model change may fix what blocked automatic
    // wakes after a non-retryable start failure; lift it so the next wake starts.
    if (runtimeConfigTouched || model !== undefined || runtime !== undefined) {
      await agentOrchestrator.liftWakeBlockForConfigChange(req.params.id, {
        runtimeValuesChanged,
        runtimeOrModelChanged: runtimeChanged || (normalizedLaunch !== null && normalizedLaunch.model !== existing.model),
      });
    }
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
      const effectiveRestartMode = runtimeChanged || codexModelChanged ? "session" : restartMode;
      await agentOrchestrator.resetAgent(req.params.id, effectiveRestartMode, {
        restartIfStopped: false,
        ...(runtimeValuesChanged ? { terminalControl: "runtime_config_changed" as const } : {}),
      });
    }
    // Reconciler step 11b: without restartMode a running agent is not
    // interrupted. Its daemon gets the new config and restarts it once idle
    // (`when_idle`); a daemon that cannot take it (or an agent that is not
    // running) keeps today's behaviour: the change is saved and the next
    // start uses it (`saved`).
    let configApply: "when_idle" | "restarted" | "saved" = restartMode ? "restarted" : "saved";
    if (!restartMode && runtimeValuesChanged && await agentOrchestrator.applyAgentConfig(req.params.id) === "pushed") {
      configApply = "when_idle";
    }
    const runtimeProfile = await agentRuntimeProfileService.getAgentRuntimeProfileSummary(req.params.id);
    const refreshed = await agentService.getAgent(req.params.id) ?? updated;
    const projectedServerRole = await getActorServerRoleInServer(req.serverId!, "agent", refreshed.id);
    // task #1357 item 1: the answer replaces the client's copy, so it carries the
    // signal for the saved config, never the old one.
    const modelLimits = await getAgentModelLimitsWarning({
      agentId: refreshed.id,
      serverId: refreshed.serverId,
      runtimeConfig: withHydratedRuntimeConfig(refreshed).runtimeConfig,
    }).catch((error: unknown) => {
      // Display only: a failed lookup never fails the agent read or write.
      addTraceEvent("agent.model_limits.failed", { error_class: errorClassOf(error) });
      return null;
    });
    res.json({
      ...await agentService.enrichAgentWithCreatorProfile({
        ...withServerRoleProjection(withAgentProjection(refreshed), projectedServerRole),
        runtimeProfile,
        // Null rather than absent: the client merges this answer into its copy.
        modelLimits,
      }),
      configApply,
    });
  } catch (error) {
    if (error instanceof ServerMembershipRevokedError) {
      res.status(403).json({ error: error.message });
      return;
    }
    if (error instanceof FencedAuthorizationDeniedError) {
      if (error.reason === "not_found") {
        res.status(404).json({ error: "Agent not found" });
      } else {
        res.status(403).json({ error: "Not authorized to update this agent" });
      }
      return;
    }
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
    sendJsonServerError(req, res, {
      error: "Failed to update agent",
      logPrefix: "agent.update error:",
      err: error,
    });
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
    // A managed bot's avatar IS its app's logo (Slack model): it changes via
    // the app's settings, never through agent profile writes — otherwise an
    // old upload would shadow the logo the identity is supposed to follow.
    if (agent.managedByAppInstallId) {
      res.status(403).json({ error: "A managed bot's avatar follows its app's logo and cannot be changed here", code: "app_bot_avatar_managed" });
      return;
    }
    // A personal assistant's avatar is always Ottie's.
    if (agent.assistantOwnerUserId) {
      res.status(403).json({ error: assistantService.ASSISTANT_PROFILE_FIXED_ERROR, code: assistantService.ASSISTANT_PROFILE_FIXED_CODE });
      return;
    }
    const file = await runSingleAvatarUpload(avatarUpload, req);
    if (!file) {
      res.status(400).json({ error: "No file provided" });
      return;
    }
    const avatarUrl = await storeAgentAvatar(req.serverId!, agent.avatarUrl, file.buffer);

    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    // Task #91: the avatar URL write is re-authorized inside the write transaction. The stored image grants no authority.
    // The agent cache is evicted after commit so a concurrent read cannot re-cache the pre-write row.
    const updated = await withFencedAgentAuthority(req.serverId!, req.userId!, agentId, "editAgents", (tx) =>
      agentService.updateAgent(agentId, { avatarUrl }, { executor: tx }));
    agentOrchestrator.evictCache(agentId);
    broadcastAgentUpdated(req, req.serverId!, agentId);
    res.json(updated);
  } catch (err: any) {
    if (err instanceof ServerMembershipRevokedError) {
      res.status(403).json({ error: err.message });
      return;
    }
    if (err instanceof FencedAuthorizationDeniedError) {
      if (err.reason === "not_found") {
        res.status(404).json({ error: "Agent not found" });
      } else {
        res.status(403).json({ error: "The `editAgents` capability or human creator authority is required to edit agents" });
      }
      return;
    }
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
    sendJsonServerError(req, res, {
      error: "Failed to upload avatar",
      logPrefix: "Avatar upload error:",
      err,
    });
  }
});

// A pixel avatar as SVG, for clients that can't draw the sprite themselves
// (app installations, OAuth userinfo `picture`). Served by this route in every
// environment: unlike uploaded avatars, pixel SVGs are not stored on the CDN.
agentAvatarRouter.get("/pixel/:encodedKey.svg", (req, res) => {
  const key = decodePixelAvatarKey(req.params.encodedKey);
  if (!key) {
    res.status(400).json({ error: "Invalid pixel avatar key" });
    return;
  }

  const svg = renderPixelAvatarSvg(key);
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  if (svg) {
    // A person's built avatar is cached for good only at the URL of the art
    // drawn (`?art=<revision>`, humanAvatarSvgPath): any other URL may outlive
    // this art, so it is cached briefly, like an unknown key.
    const stableUrl = !isHumanAvatarUrl(key) || req.query.art === HUMAN_AVATAR_ART_REVISION;
    res.setHeader("Cache-Control", stableUrl ? "public, max-age=31536000, immutable" : "public, max-age=300");
    res.send(svg);
    return;
  }
  // A key this server doesn't know (e.g. an avatar added in a newer build)
  // draws the default avatar. Cache it briefly only, so the real sprite
  // shows once this server knows the key.
  res.setHeader("Cache-Control", "public, max-age=300");
  res.send(renderPixelAvatarSvg(DEFAULT_PIXEL_AVATAR_KEY));
});

const AVATAR_NAMESPACE_RE = /^(?:users|(?:server-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

agentAvatarRouter.get("/:namespace/:filename", async (req, res) => {
  try {
    const { namespace, filename } = req.params;
    if (!/^[0-9a-f]+\.webp$/.test(filename)) {
      res.status(400).json({ error: "Invalid filename" });
      return;
    }
    // The namespaces avatarService writes (an agent's server id, `server-<id>`,
    // `users`): anything else names no avatar, so a decoded `../` never
    // reaches a storage key.
    if (!AVATAR_NAMESPACE_RE.test(namespace)) {
      refuse(res, 404, { code: "avatar_not_found", error: "No avatar has this address; use the avatar URL from the profile." });
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
  } catch (err) {
    if (res.destroyed || res.headersSent) return;
    // An error is never cached as the avatar's immutable image.
    res.removeHeader("Cache-Control");
    // A stored avatar that is gone (deleted when replaced or with its
    // account) is not found; any other storage failure stays a 500.
    if (isStorageNotFoundError(err)) {
      refuse(res, 404, { code: "avatar_not_found", error: "No avatar has this address; use the avatar URL from the profile." });
      return;
    }
    res.status(500).json({ error: "Failed to serve avatar" });
  }
});

// Owner-initiated no-card migration. The owner's click is the authorization;
// this route is the single identity/capability gate before any grant is minted.
agentRouter.get("/:id/migration", async (req, res) => {
  try {
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
    const hosted = migration?.targetKind === "hosted" ? await getHostedMigrationReview(migration.id) : null;
    const transferProgress = migration ? await agentMigrationService.getAgentMigrationTransferProgress(migration) : null;
    // A retry: what the failed attempt measured next to what this one packs (null otherwise).
    const retriedMigration = migration?.retryOfMigrationId ? await readRetriedAgentMigration(getDb(), migration) : null;
    const retryComparison = migration?.retryOfMigrationId ? agentMigrationRetryComparison(migration, retriedMigration) : null;
    // Who started it, while they are still a member of this server; null otherwise.
    const initiator = migration
      ? await agentService.getAgentCreator({ serverId: agent.serverId, creatorType: "user", creatorId: migration.initiatedByUserId })
      : null;
    const initiatedBy = initiator ? { id: initiator.id, name: initiator.name, displayName: initiator.displayName } : null;
    res.json({
      migration: migration
        ? { ...serializeOwnerMigrationStatus(migration, transferProgress), initiatedBy, retryComparison, ...(hosted ? { hosted } : {}) }
        : null,
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
      // Task #93 line C: re-authorize the canceller under row locks inside the cancellation transaction.
      actorFence: { serverId: req.serverId!, userId: req.userId!, capability: "migrateAgents" },
      reason: typeof req.body?.reason === "string" && req.body.reason.trim()
        ? req.body.reason.trim().slice(0, 200)
        : "owner_cancel",
    });
    const io = req.app.get("io") as SocketServer | undefined;
    await emitAgentMigrationUpdated(io, requested.migration);
    await recordOperatorAction(req, agent, "migration_cancelled");

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
    if (err instanceof ServerMembershipRevokedError) {
      sendMigrationError(res, 403, "not_supported", err.message);
      return;
    }
    if (err instanceof FencedAuthorizationDeniedError) {
      if (err.reason === "not_found") {
        sendMigrationError(res, 404, "AGENT_NOT_FOUND", "Agent not found");
      } else {
        sendMigrationError(res, 403, "not_supported", "The `migrateAgents` capability or human creator authority is required to cancel an agent migration");
      }
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (message === "MIGRATION_NOT_FOUND") {
      sendMigrationError(res, 404, "MIGRATION_NOT_FOUND", "Migration not found");
      return;
    }
    if (message === "MIGRATION_REVISION_STALE" || message === "MIGRATION_CONCURRENT_UPDATE") {
      sendMigrationError(res, 409, message, "Migration changed concurrently");
      return;
    }
    if (message === "MIGRATION_NOT_CANCELABLE") {
      sendMigrationError(res, 409, "MIGRATION_NOT_CANCELABLE", "The agent already moved to the cloud; this migration can no longer be canceled");
      return;
    }
    console.error("[agents] migration cancel error:", err);
    sendMigrationError(res, 500, "MIGRATION_CANCEL_FAILED", "Failed to request migration cancellation");
  }
});

// The user confirmed a hosted migration's review (which files come over, that
// they will live at the provider, that this is final): switch the agent.
agentRouter.post("/:id/migration/confirm-hosted", async (req, res) => {
  try {
    const agent = await agentService.getAgent(req.params.id);
    if (!agent || agent.serverId !== req.serverId) {
      sendMigrationError(res, 404, "AGENT_NOT_FOUND", "Agent not found");
      return;
    }
    if (!await currentUserCanActOnAgent(req.serverId!, req.userId!, agent, "migrateAgents")) {
      sendMigrationError(res, 403, "not_supported", "The `migrateAgents` capability or human creator authority is required to confirm an agent migration");
      return;
    }
    if (!await hostedAgentMigrationEnabled(req)) {
      sendMigrationError(res, 403, "HOSTED_TARGET_UNAVAILABLE", "Moving agents to the cloud is not enabled on this server");
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
    const migration = await confirmHostedAgentMigration({
      serverId: req.serverId!,
      agentId: agent.id,
      migrationRef: migrationRefResult.data,
      expectedRevision,
      userId: req.userId!,
    });
    kickAgentRuntimeProvisionWorker();
    // The source Computer's runner credentials were revoked: close their open streams.
    await broadcastAgentCredentialRevocation(agent.id);
    await emitAgentMigrationUpdated(req.app.get("io") as SocketServer | undefined, migration);
    res.json({ migration: serializeOwnerMigrationStatus(migration) });
  } catch (err) {
    if (err instanceof FencedAuthorizationDeniedError) {
      if (err.reason === "not_found") sendMigrationError(res, 404, "AGENT_NOT_FOUND", "Agent not found");
      else sendMigrationError(res, 403, "not_supported", "The `migrateAgents` capability or human creator authority is required to confirm an agent migration");
      return;
    }
    if (err instanceof HostedMigrationConfirmError) {
      const status = err.code === "MIGRATION_NOT_FOUND" ? 404 : 409;
      const code = err.code === "MIGRATION_SOURCE_MACHINE_MISMATCH" ? "HOSTED_REVIEW_NOT_READY" : err.code;
      sendMigrationError(res, status, code, err.message);
      return;
    }
    console.error("[agents] hosted migration confirm error:", err);
    sendMigrationError(res, 500, "MIGRATION_START_FAILED", "Failed to confirm the move to the cloud");
  }
});

agentRouter.post("/:id/migrate", async (req, res) => {
  try {
    const subjectAgent = await agentService.getAgent(req.params.id);
    if (!subjectAgent || subjectAgent.serverId !== req.serverId) {
      sendMigrationError(res, 404, "AGENT_NOT_FOUND", "Agent not found");
      return;
    }
    if (!await currentUserCanActOnAgent(req.serverId!, req.userId!, subjectAgent, "migrateAgents")) {
      sendMigrationError(res, 403, "not_supported", "The `migrateAgents` capability or human creator authority is required to start an agent migration");
      return;
    }
    // A personal assistant is never on a machine (agents_assistant_not_on_machine), so it has nothing to move.
    if (subjectAgent.assistantOwnerUserId) {
      sendMigrationError(res, 409, "not_supported", new AssistantCannotUseComputerError().message);
      return;
    }

    if (isHostedMigrationTargetBody(req.body?.target)) {
      await startHostedAgentMigration(req, res, req.body.target);
      return;
    }

    const targetComputer = typeof req.body?.targetComputer === "string" ? req.body.targetComputer.trim() : "";
    if (!targetComputer) {
      sendMigrationError(res, 400, "TARGET_COMPUTER_REQUIRED", "targetComputer is required");
      return;
    }

    const now = currentDate();
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    const validation = await validateComputerMigrationStart({
      serverId: req.serverId!,
      agentId: req.params.id,
      targetComputer,
      orchestrator: agentOrchestrator,
      now,
    });
    if ("failure" in validation) {
      const failure = validation.failure;
      sendMigrationError(res, failure.status, failure.code, failure.error, failure.details);
      return;
    }
    const validatedMigration = validation.validated;
    const releaseCatalogAuthority = await acquireMigrationTargetCatalogAuthority(req, res, agentOrchestrator, validatedMigration);
    if (releaseCatalogAuthority === "handled") return;

    try {

    // Nothing to stop or bring over: no paywall (it gates moving a workspace;
    // this replaces assign-machine, which had none), no transport, no migration row.
    if (validatedMigration.placeWithoutSource) {
      await placeAgentWithoutSourceOnTarget(req, res, {
        agentId: validatedMigration.agentId,
        revokedSourceMachineId: validatedMigration.revokedSourceMachineId,
        targetMachineId: validatedMigration.targetMachineId,
        assistantOwnerUserId: subjectAgent.assistantOwnerUserId,
        now,
      });
      return;
    }

    // Preserve the existing owner/admin, target, capability,
    // online, and active-migration error precedence. The paywall is the final
    // start-only gate before any transport is provisioned or grant is minted.
    const started = await provisionComputerMigrationStart({
      serverId: req.serverId!,
      validated: validatedMigration,
      initiatedByUserId: req.userId!,
      actorFence: { serverId: req.serverId!, userId: req.userId!, capability: "migrateAgents" },
      provisioner: getMigrationTransferProvisioner(req),
      now,
    });
    if ("failure" in started) {
      if ("planRequired" in started.failure) notePaywallHit(req, "agent_migration");
      sendMigrationError(res, started.failure.status, started.failure.code, started.failure.error);
      return;
    }

    const provisioning = started.provisioning;
    const io = req.app.get("io") as SocketServer | undefined;
    await emitAgentMigrationUpdated(io, provisioning.migration);
    await recordOperatorAction(req, { id: provisioning.migration.agentId, serverId: req.serverId! }, "migration_started", {
      fromMachineId: provisioning.source.machineId,
      toMachineId: provisioning.target.machineId,
    });
    const leaseFailure = await sendComputerMigrationLeases({ io, orchestrator: agentOrchestrator, provisioning });
    if (leaseFailure) {
      sendMigrationError(res, leaseFailure.status, leaseFailure.code, leaseFailure.error);
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
    if (err instanceof ServerMembershipRevokedError) {
      sendMigrationError(res, 403, "not_supported", err.message);
      return;
    }
    if (err instanceof FencedAuthorizationDeniedError) {
      if (err.reason === "not_found") {
        sendMigrationError(res, 404, "AGENT_NOT_FOUND", "Agent not found");
      } else {
        sendMigrationError(res, 403, "not_supported", "The `migrateAgents` capability or human creator authority is required to start an agent migration");
      }
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

/**
 * The end of `POST /agents/:id/migrate` for an agent on no Computer (or on
 * one whose access was revoked, `revokedSourceMachineId`), once the
 * target checks passed: placed on the target in one transaction
 * (agentMigrationService.placeAgentWithoutSource), then the after-commit
 * notices a finished move sends (credential streams, agent:updated, model
 * limits). It is not started: a message that wakes it starts a fresh session there.
 * 200 with the migration start response's fields, `outcome:
 * "placed_without_source"`, `state: "completed"` and no `migrationRef` (there is
 * no migration record to follow); `sourceMachineId` is the revoked Computer's, else null.
 */
async function placeAgentWithoutSourceOnTarget(
  req: Request,
  res: Response,
  input: { agentId: string; revokedSourceMachineId: string | null; targetMachineId: string; assistantOwnerUserId: string | null; now: Date },
): Promise<void> {
  let result: agentMigrationService.AgentPlacementWithoutSourceResult;
  try {
    result = await agentMigrationService.placeAgentWithoutSource({
      agentId: input.agentId,
      revokedSourceMachineId: input.revokedSourceMachineId,
      targetMachineId: input.targetMachineId,
      actorFence: { serverId: req.serverId!, userId: req.userId!, capability: "migrateAgents" },
      now: input.now,
    });
  } catch (err) {
    if (err instanceof MachineKeyRevokedError) {
      sendMigrationError(res, 409, "MIGRATION_TARGET_COMPUTER_DETACHED", err.message);
      return;
    }
    if (err instanceof AssistantCannotUseComputerError) {
      sendMigrationError(res, 409, "not_supported", err.message);
      return;
    }
    throw err;
  }
  if (!result.placed) {
    if (result.code === "MIGRATION_ALREADY_IN_PROGRESS") {
      sendMigrationError(res, 409, "MIGRATION_ALREADY_IN_PROGRESS", "Agent already has an active migration");
    } else {
      sendMigrationError(res, 409, "MIGRATION_CONCURRENT_UPDATE", "The agent's computer changed meanwhile; reload and try again");
    }
    return;
  }
  const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
  agentOrchestrator?.evictCache?.(input.agentId);
  // Runner credentials minted by any other Machine were revoked: close their open streams.
  await broadcastAgentCredentialRevocation(input.agentId);
  broadcastAgentUpdated(req, req.serverId!, input.agentId, input.assistantOwnerUserId);
  // task #1357 item 1: another Computer: the Raft-defaults signal changes.
  await agentOrchestrator?.notifyModelLimitsChanged?.({ agentIds: [input.agentId] });
  res.json({
    outcome: "placed_without_source",
    migrationRef: null,
    state: "completed",
    sourceMachineId: input.revokedSourceMachineId,
    targetMachineId: input.targetMachineId,
  });
}

function isHostedMigrationTargetBody(value: unknown): value is { kind: "hosted"; provider?: unknown; hostedModel?: unknown } {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "hosted";
}

/**
 * `POST /agents/:id/migrate` with `target: {kind: "hosted", provider?: "antiproton", hostedModel?}`:
 * move a Computer agent to Raft hosted under the same agent identity. The
 * source side is the Computer migration's (quiesce + bundle upload); there is
 * no target daemon, so only the source gets a lease and the server's hosted
 * importer takes over at `ready`. Caller has passed the permission checks.
 */
/** The hosted target has its own gate (agent_migration_hosted_v0), on top of Pro and antiproton_hosted_runtime provisioning checked by the caller. */
async function hostedAgentMigrationEnabled(req: Request): Promise<boolean> {
  const flag = await evaluateFeatureFlag({
    key: AGENT_MIGRATION_HOSTED_FEATURE_FLAG_KEY,
    serverId: req.serverId!,
    userId: req.userId!,
  });
  return flag.enabled;
}

async function startHostedAgentMigration(
  req: Request,
  res: Response,
  target: { kind: "hosted"; provider?: unknown; hostedModel?: unknown },
): Promise<void> {
  if (!await hostedAgentMigrationEnabled(req)) {
    sendMigrationError(res, 403, "HOSTED_TARGET_UNAVAILABLE", "Moving agents to the cloud is not enabled on this server");
    return;
  }
  const provider = target.provider ?? "antiproton";
  if (provider !== "antiproton") {
    sendMigrationError(res, 422, "HOSTED_TARGET_UNAVAILABLE", "Unknown cloud provider");
    return;
  }
  const hostedModel = parseHostedModelChoice(target.hostedModel);
  if (hostedModel === undefined) {
    sendMigrationError(res, 400, "HOSTED_TARGET_MODEL_INVALID", "`target.hostedModel` must be a model id or null");
    return;
  }
  try {
    await assertProviderProvisioningAvailable(req.serverId!, provider);
  } catch (err) {
    if (err instanceof AgentRuntimeProviderError) {
      sendMigrationError(res, 409, "HOSTED_TARGET_UNAVAILABLE", err.message);
      return;
    }
    throw err;
  }

  const db = getDb();
  const now = currentDate();
  const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
  const validation = await db.transaction(async (tx) => {
    const [agent] = await tx
      .select()
      .from(agents)
      .where(and(eq(agents.id, String(req.params.id)), eq(agents.serverId, req.serverId!), isNull(agents.deletedAt)))
      .limit(1);
    if (!agent) return { status: 404, code: "AGENT_NOT_FOUND", error: "Agent not found" } as const;
    if (!agent.machineId) {
      return { status: 409, code: "AGENT_HAS_NO_SOURCE_MACHINE", error: "Agent has no source computer" } as const;
    }
    const [sourceMachine] = await tx
      .select()
      .from(machines)
      .where(and(eq(machines.id, agent.machineId), eq(machines.serverId, req.serverId!)))
      .limit(1);
    // Reconciler step 15 (B15): a Computer whose access was revoked cannot upload the agent.
    if (!sourceMachine || (await findAccessRevokedMachineIds(tx, [sourceMachine.id])).has(sourceMachine.id)) {
      return { status: 409, code: "AGENT_HAS_NO_SOURCE_MACHINE", error: "Agent source computer is not available" } as const;
    }
    const sourceTransport = await agentOrchestrator?.getMachineMigrationTransport(sourceMachine.id) ?? null;
    if (!sourceTransport?.capabilities?.includes(AGENT_MIGRATION_CAPABILITY)) {
      return {
        status: 422,
        code: "MIGRATION_RESUMABLE_CAPABILITY_REQUIRED",
        error: `The source computer must run a Raft Computer that supports ${AGENT_MIGRATION_CAPABILITY}; upgrade it`,
        details: { side: "source", reason: "capability_missing" },
      } as const;
    }
    // The provider keys hosted agents by Raft agent id and never re-creates a
    // deleted one, and Raft keeps one provisioning row per agent: an agent that
    // ever had a hosted runtime record cannot move to hosted again.
    const [existingProvision] = await tx
      .select({ agentId: agentRuntimeProvisions.agentId })
      .from(agentRuntimeProvisions)
      .where(eq(agentRuntimeProvisions.agentId, agent.id))
      .limit(1);
    if (existingProvision) {
      return { status: 409, code: "HOSTED_TARGET_ALREADY_USED", error: "This agent has already run in the cloud" } as const;
    }
    if (await hasActiveAgentMigration(tx, agent.id)) {
      return { status: 409, code: "MIGRATION_ALREADY_IN_PROGRESS", error: "Agent already has an active migration" } as const;
    }
    return {
      validated: {
        agentId: agent.id,
        // Reconciler step 14 (Q-H): the source waits for its agent to be quiet before it stops it.
        sourceDrainsBeforeStop: sourceTransport?.capabilities?.includes(AGENT_MIGRATION_SOURCE_DRAIN_CAPABILITY) === true,
      },
    } as const;
  });
  if (!("validated" in validation) || !validation.validated) {
    sendMigrationError(res, validation.status, validation.code, validation.error, "details" in validation ? validation.details : undefined);
    return;
  }
  const { agentId, sourceDrainsBeforeStop } = validation.validated;

  const choice = await checkHostedModelChoice(req.serverId!, provider, hostedModel);
  if (choice.kind !== "ok") {
    const upstream = choice.kind !== "not_listed" && choice.kind !== "locked" && choice.kind !== "picker_disabled";
    sendMigrationError(
      res,
      upstream ? 502 : 422,
      upstream ? "HOSTED_TARGET_UNAVAILABLE" : "HOSTED_TARGET_MODEL_INVALID",
      upstream ? "The cloud is unavailable right now" : `This model cannot be used for a cloud agent here (${choice.kind})`,
    );
    return;
  }
  const provisionedModel = await hostedModelForCreate(req.serverId!, hostedModel);

  const providerConfig = resolveProviderConfig(provider);
  const limits = providerConfig ? await fetchProvisionImportLimits(providerConfig) : null;
  if (!limits?.ok) {
    sendMigrationError(res, 502, "HOSTED_TARGET_UNAVAILABLE", "Raft hosted did not report its import limits");
    return;
  }

  try {
    await requireTeamBillingFeature(db, req.serverId!, "Agent migration", now);
  } catch (err) {
    if (err instanceof Error && err.message === "Agent migration requires the Pro plan.") {
      notePaywallHit(req, "agent_migration");
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
      const provisioning = await agentMigrationService.beginHostedAgentMigrationProvisioning({
        agentId,
        sourceDrainsBeforeStop,
        hostedTarget: { provider, hostedModel: provisionedModel, importLimits: limits.limits },
        initiatedByUserId: req.userId!,
        actorFence: { serverId: req.serverId!, userId: req.userId!, capability: "migrateAgents" },
        now,
        transportProvider: transferProvision.provider,
        transportSessionId: transferProvision.sessionId,
        transportLeaseMs: transferProvision.leaseMs,
        transportMaxBytes: Math.min(transferProvision.maxBytes, agentMigrationService.DEFAULT_HOSTED_AGENT_MIGRATION_TRANSPORT_MAX_BYTES),
      }, tx);
      const sourceVerdict = agentMigrationService.evaluateAgentMigrationTransferLeaseReady({
        migration: provisioning.migration,
        lease: leaseStateFromDelivery(provisioning.source),
        role: "source",
        now,
      });
      if (!sourceVerdict.ready) {
        throw new MigrationRoutePreflightError(422, sourceVerdict.code, `Source migration transfer lease is not ready: ${sourceVerdict.reason}`);
      }
      return { provisioning } as const;
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (/idx_agent_migrations_active_agent|duplicate key|constraint/i.test(message)) {
        return { status: 409, code: "MIGRATION_ALREADY_IN_PROGRESS", error: "Agent already has an active migration" } as const;
      }
      throw err;
    }
  });
  if (!("provisioning" in out) || !out.provisioning) {
    sendMigrationError(res, out.status, out.code, out.error);
    return;
  }
  const { migration, source } = out.provisioning;
  const io = req.app.get("io") as SocketServer | undefined;
  await emitAgentMigrationUpdated(io, migration);
  await recordOperatorAction(req, { id: migration.agentId, serverId: req.serverId! }, "migration_started", { fromMachineId: source.machineId });
  try {
    await agentOrchestrator?.sendAgentMigrationTransportLease(source.machineId, source.message);
  } catch (err) {
    const failed = await agentMigrationService.markAgentMigrationTransportProvisionFailed({
      migrationId: migration.id,
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
  res.json({
    migrationRef: migration.supportRef,
    state: migration.state,
    targetKind: migration.targetKind,
    sourceMachineId: migration.sourceMachineId,
    targetMachineId: null,
    prepDeadlineAt: migration.prepDeadlineAt.toISOString(),
    transferDeadlineAt: migration.transferDeadlineAt.toISOString(),
    arrivalDeadlineAt: migration.arrivalDeadlineAt.toISOString(),
  });
}

// Start agent (routes to machine via agentOrchestrator)
/**
 * #proj-runtime:#51: the person's action on this agent, for its Activity
 * overview. Called after the action was accepted; never fails the request.
 */
function recordOperatorAction(req: Request, agent: { id: string; serverId: string }, kind: AgentOperatorEventStoredKind, details?: AgentOperatorEventDetailsInput): Promise<boolean> {
  return recordAgentOperatorEvent({ serverId: agent.serverId, agentId: agent.id, kind, actorUserId: req.userId ?? null, details });
}

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
    // A personal assistant an admin paused: its owner's Start lifts the pause
    // (a hosted assistant has nothing else to start; the next wake runs it).
    let resumed = false;
    if (agent.assistantOwnerUserId) {
      resumed = await withFencedAgentAuthority(req.serverId!, req.userId!, agent.id, "controlAgentRuntime", (tx) => resumeAssistant(tx, agent.id));
      recordTraceEvent("server.assistant.resume", { agent_id: agent.id, actor_user_id: req.userId!, resumed });
      // The agent payload no longer shows the pause: clients re-read it.
      if (resumed) broadcastAgentUpdated(req, req.serverId!, agent.id, agent.assistantOwnerUserId);
      if (isExternalAgentRuntime(agent.runtime)) {
        if (resumed) await recordOperatorAction(req, agent, "start");
        res.json({ ok: true, resumed });
        return;
      }
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
    // Reconciler step 15 (B15): no replica holds a revoked Computer, so say why here, before routing to one.
    if (await agentOrchestrator.isMachineAccessRevoked(agent.machineId)) {
      addTraceEvent("agent.start.rejected", { reason: "computer_access_revoked", http_status: 409 });
      sendComputerAccessRevoked(res);
      return;
    }
    if (agent.machineId) {
      const routing = await handleMachineLocalRouting(
        req,
        res,
        agent.machineId,
        () => agentOrchestrator.hasMachineLocally(agent.machineId!),
      );
      if (routing === "handled") return;
      if (routing !== "confirmed_local") {
        sendMachineAffinityUnavailable(res, agent.machineId, routing);
        return;
      }
    }
    // RFC 071 §5: a person pressed Start/Resume: the explicit human start (E3).
    const startResult = await agentOrchestrator.startAgent(req.params.id, { control: "human_start" });
    if (startResult.outcome === "skipped" && startResult.reason === "computer_access_revoked") {
      sendComputerAccessRevoked(res);
      return;
    }
    if (startResult.outcome === "skipped" && startResult.reason === "computer_version_unsupported") {
      res.status(409).json({
        error: "This agent's Computer is too old to run agents. Reinstall Raft Computer on that machine, then start the agent again.",
        code: "computer_version_unsupported",
      });
      return;
    }
    await recordOperatorAction(req, agent, "start");
    const migration = startResult.outcome === "dispatched"
      ? await agentMigrationService.getLatestAgentMigration(agent.id, undefined, currentDate())
      : null;
    if (migration?.state === "starting" && migration.targetMachineId === agent.machineId) {
      const completed = await agentMigrationService.completeAgentMigrationAutoStart({
        migrationId: migration.id,
        agentId: agent.id,
        targetMachineId: migration.targetMachineId,
        // Task #93 line C: the completion write re-authorizes the starter under row locks. The runtime start above was
        // already dispatched; fencing that effect is line A's membership epoch, not this write.
        actorFence: { serverId: req.serverId!, userId: req.userId!, capability: "controlAgentRuntime" },
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
    if (err instanceof FencedAuthorizationDeniedError) {
      res.status(err.reason === "not_found" ? 404 : 403).json(err.reason === "not_found" ? { error: "Agent not found" } : ASSISTANT_OWNER_ONLY_ERROR);
      return;
    }
    if (
      err instanceof BuiltInModelCatalogError ||
      err instanceof MachineCatalogStaleError
    ) {
      sendBuiltInCatalogError(res, err);
      return;
    }
    if (err instanceof ServerMembershipRevokedError) {
      res.status(403).json({ error: err.message });
      return;
    }
    if (err instanceof FencedAuthorizationDeniedError) {
      if (err.reason === "not_found") {
        res.status(404).json({ error: "Agent not found" });
      } else {
        res.status(403).json({ error: "The `controlAgentRuntime` capability or human creator authority is required to control agents" });
      }
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
    // Stopping an agent is a server owner/admin's (or its creator's) call;
    // members keep restart, reset session and Stop turn (cindyz, 2026-10-29).
    if (!await currentUserCanActOnAgent(req.serverId!, req.userId!, agent, "stopAgents", { stop: true })) {
      res.status(403).json({ error: "The `stopAgents` capability or human creator authority is required to stop agents" });
      return;
    }
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    // A personal assistant: its owner stops the turn; a server owner/admin
    // pauses it (and the owner is told). One path with a channel's stop-all.
    if (agent.assistantOwnerUserId) {
      const stopped = await stopAssistant({
        io: req.app.get("io") as SocketServer | undefined,
        orchestrator: agentOrchestrator,
        serverId: req.serverId!,
        agent: { ...agent, assistantOwnerUserId: agent.assistantOwnerUserId },
        actorUserId: req.userId!,
      });
      if (stopped.ok) {
        if (stopped.paused) await recordOperatorAction(req, agent, "stop");
        else if (stopped.result === "interrupted") await recordOperatorAction(req, agent, "turn_stopped");
        res.json({ ok: true, result: stopped.result, paused: stopped.paused, ...(stopped.appliesOnReconnect ? { appliesOnReconnect: true } : {}) });
      } else if (stopped.code === "not_hosted") {
        respondExternalManagedLifecycleUnsupported(res);
      } else {
        res.status(503).json({ error: "Couldn't stop the agent's current turn. Try again.", code: "hosted_stop_failed", paused: stopped.paused });
      }
      return;
    }
    if (isExternalAgentRuntime(agent.runtime)) {
      // A hosted agent: the provider interrupts the running turn, the agent stays.
      const hosted = await stopHostedAgentTurn(agent.id, agent.serverId);
      if (hosted.kind === "not_hosted") {
        respondExternalManagedLifecycleUnsupported(res);
      } else if (hosted.kind === "failed") {
        res.status(503).json({ error: "Couldn't stop the agent's current turn. Try again.", code: "hosted_stop_failed" });
      } else {
        if (hosted.kind === "interrupted") await recordOperatorAction(req, agent, "turn_stopped");
        res.json({ ok: true, result: hosted.kind });
      }
      return;
    }
    // The owner's explicit Stop: the only stop that tells the daemon
    // `owner_stop` (it also stops the agent's `raft proc` jobs).
    const stopped = await agentOrchestrator.stopAgent(req.params.id, "manual", { daemonReason: "owner_stop" });
    await recordOperatorAction(req, agent, "stop");
    // Undelivered: the agent is recorded stopped and its Computer stops it
    // when it reconnects.
    res.json(stopped?.delivered === false ? { ok: true, appliesOnReconnect: true } : { ok: true });
  } catch (err) {
    if (err instanceof FencedAuthorizationDeniedError) {
      res.status(err.reason === "not_found" ? 404 : 403).json(err.reason === "not_found" ? { error: "Agent not found" } : ASSISTANT_OWNER_ONLY_ERROR);
      return;
    }
    res.status(500).json({ error: "Failed to stop agent" });
  }
});

/**
 * task #25 step 2: stop the agent's current turn, not the agent. Same
 * authority as Stop (people only; an agent has no session on this router).
 * A hosted agent's provider stops the turn; a Computer agent's daemon does,
 * natively or by restarting the runtime into the same session. A Computer
 * too old for the command is reported as such instead of timing out.
 */
agentRouter.post("/:id/interrupt-turn", async (req, res) => {
  const agent = await agentService.getAgent(req.params.id).catch(() => null);
  if (!agent || agent.serverId !== req.serverId) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  const trace = (outcome: string, extra: Record<string, unknown> = {}) => addTraceEvent("agent.turn_interrupt", {
    agent_id: agent.id,
    server_id: agent.serverId,
    user_id: req.userId!,
    runtime: agent.runtime,
    outcome,
    ...extra,
  });
  try {
    // Someone else's assistant: a server owner/admin's Stop turn is the assistant Stop (pause, trace, owner told).
    if (agent.assistantOwnerUserId && agent.assistantOwnerUserId !== req.userId) {
      const stopped = await stopAssistant({
        io: req.app.get("io") as SocketServer | undefined,
        orchestrator: req.app.get("agentOrchestrator") as AgentOrchestrator,
        serverId: req.serverId!,
        agent: { ...agent, assistantOwnerUserId: agent.assistantOwnerUserId },
        actorUserId: req.userId!,
      });
      trace(stopped.ok ? stopped.result : stopped.code, { assistant_paused: stopped.paused });
      if (stopped.ok && stopped.paused) await recordOperatorAction(req, agent, "stop");
      else if (stopped.ok && stopped.result === "interrupted") await recordOperatorAction(req, agent, "turn_stopped");
      if (stopped.ok) res.json({ outcome: stopped.result, paused: stopped.paused });
      else if (stopped.code === "not_hosted") respondExternalManagedLifecycleUnsupported(res);
      else res.status(503).json({ error: "Couldn't stop the agent's current turn. Try again.", code: "hosted_stop_failed", paused: stopped.paused });
      return;
    }
    if (!await currentUserCanActOnAgent(req.serverId!, req.userId!, agent, "controlAgentRuntime")) {
      res.status(403).json({ error: "The `controlAgentRuntime` capability or human creator authority is required to control agents" });
      return;
    }
    if (isExternalAgentRuntime(agent.runtime)) {
      const hosted = await stopHostedAgentTurn(agent.id, agent.serverId);
      if (hosted.kind === "not_hosted") {
        respondExternalManagedLifecycleUnsupported(res);
      } else if (hosted.kind === "failed") {
        trace("failed", { hosted: true });
        res.status(503).json({ error: "Couldn't stop the agent's current turn. Try again.", code: "hosted_stop_failed" });
      } else {
        trace(hosted.kind, { hosted: true });
        if (hosted.kind === "interrupted") await recordOperatorAction(req, agent, "turn_stopped");
        res.json({ outcome: hosted.kind });
      }
      return;
    }
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    const result = await agentOrchestrator.interruptAgentTurn(agent.id, agent.machineId ?? null);
    if (result.outcome === "computer_offline") {
      trace(result.outcome);
      res.status(409).json({ error: "This agent's computer is offline.", code: "computer_offline" });
      return;
    }
    if (result.outcome === "computer_upgrade_required") {
      trace(result.outcome);
      res.status(409).json({
        error: "This agent's computer needs an upgrade before a single turn can be stopped. You can stop the whole agent instead.",
        code: "computer_upgrade_required",
      });
      return;
    }
    trace(result.outcome, {
      ...("toolName" in result && result.toolName ? { tool: result.toolName } : {}),
      ...("stuckForMs" in result && result.stuckForMs !== undefined ? { stuck_for_ms: result.stuckForMs } : {}),
    });
    if (result.outcome === "interrupted" || result.outcome === "restarted") await recordOperatorAction(req, agent, "turn_stopped");
    res.json(result);
  } catch (error) {
    if (error instanceof RouteFailureError && (error.subkind === "daemon_timeout" || error.subkind === "daemon_offline")) {
      trace(error.subkind);
      res.status(error.subkind === "daemon_timeout" ? 504 : 409).json({
        error: error.subkind === "daemon_timeout"
          ? "The agent's computer did not answer in time. Try again, or stop the whole agent."
          : "This agent's computer is offline.",
        code: error.subkind === "daemon_timeout" ? "computer_timeout" : "computer_offline",
      });
      return;
    }
    if (error instanceof FencedAuthorizationDeniedError) {
      trace("forbidden");
      res.status(error.reason === "not_found" ? 404 : 403).json(error.reason === "not_found" ? { error: "Agent not found" } : ASSISTANT_OWNER_ONLY_ERROR);
      return;
    }
    trace("error");
    res.status(500).json({ error: "Failed to stop the agent's current turn" });
  }
});

// #proj-runtime:#41: stop one running sub-agent (Codex, Claude Code); the agent and its
// other sub-agents keep running. Same authority as Stop turn.
agentRouter.post("/:id/subagents/:taskId/interrupt", async (req, res) => {
  const agent = await agentService.getAgent(req.params.id).catch(() => null);
  if (!agent || agent.serverId !== req.serverId) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  const taskId = req.params.taskId;
  if (!taskId || taskId.length > SUBAGENT_TASK_ID_MAX_LENGTH) {
    res.status(400).json({ error: "Invalid sub-agent id" });
    return;
  }
  const trace = (outcome: string) => addTraceEvent("agent.subagent_interrupt", {
    agent_id: agent.id,
    server_id: agent.serverId,
    user_id: req.userId!,
    runtime: agent.runtime,
    outcome,
  });
  try {
    // Someone else's assistant: its owner only, as for its other controls.
    if (agent.assistantOwnerUserId && agent.assistantOwnerUserId !== req.userId) {
      trace("forbidden");
      res.status(403).json(ASSISTANT_OWNER_ONLY_ERROR);
      return;
    }
    if (!await currentUserCanActOnAgent(req.serverId!, req.userId!, agent, "controlAgentRuntime")) {
      trace("forbidden");
      res.status(403).json({ error: "The `controlAgentRuntime` capability or human creator authority is required to control agents" });
      return;
    }
    if (isExternalAgentRuntime(agent.runtime)) {
      trace("unsupported");
      res.json({ outcome: "unsupported" });
      return;
    }
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    const result = await agentOrchestrator.interruptAgentSubagent(agent.id, agent.machineId ?? null, taskId);
    trace(result.outcome);
    if (result.outcome === "computer_offline") {
      res.status(409).json({ error: "This agent's computer is offline.", code: "computer_offline" });
      return;
    }
    if (result.outcome === "computer_upgrade_required") {
      res.status(409).json({ error: "This agent's computer needs an upgrade before a sub-agent can be stopped.", code: "computer_upgrade_required" });
      return;
    }
    res.json(result);
  } catch (error) {
    if (error instanceof RouteFailureError && (error.subkind === "daemon_timeout" || error.subkind === "daemon_offline")) {
      trace(error.subkind);
      res.status(error.subkind === "daemon_timeout" ? 504 : 409).json({
        error: error.subkind === "daemon_timeout" ? "The agent's computer did not answer in time. Try again." : "This agent's computer is offline.",
        code: error.subkind === "daemon_timeout" ? "computer_timeout" : "computer_offline",
      });
      return;
    }
    if (error instanceof FencedAuthorizationDeniedError) {
      trace("forbidden");
      res.status(error.reason === "not_found" ? 404 : 403).json(error.reason === "not_found" ? { error: "Agent not found" } : ASSISTANT_OWNER_ONLY_ERROR);
      return;
    }
    trace("error");
    res.status(500).json({ error: "Failed to stop the sub-agent" });
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
    // Reset is a lifecycle command, not a request for the runtime to be fully
    // healthy before the HTTP response can complete.  The UI can project the
    // agent into its existing "starting" state immediately and receive the
    // eventual lifecycle/activity updates over the normal realtime channel.
    // Keep the authorization/external-runtime checks above synchronous so
    // invalid requests still fail before acknowledging the command.
    // RFC 071 §5: a human reset (restart / session / full) is E3.
    void agentOrchestrator.resetAgent(req.params.id, mode, { terminalControl: "human_reset" }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Agents] Background reset failed for ${req.params.id}: ${msg}`);
    });
    await recordOperatorAction(req, agent, mode === "restart" ? "restart" : mode === "session" ? "reset_session" : "reset_full");
    res.status(202).json({ ok: true, status: "accepted" });
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

// Archive agent (the former delete). Body `{ workspace: "keep" | "delete" }`;
// without a body the workspace is kept, which is what delete always did.
/**
 * The archive (delete) of one agent by the requesting person, re-authorized
 * inside the write transaction (`deleteAgents`, or the person who created it).
 * Shared by `DELETE /api/agents/:id` and "my assistant" (RFC 075 v4); callers
 * have already stopped a Computer-run agent.
 */
async function archiveAgentAsUser(req: Request, agentId: string, workspaceChoice: AgentArchiveWorkspaceChoice): Promise<void> {
  const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
  // Task #91: the delete itself is re-authorized inside the write transaction. Stopping the runtime is a runtime
  // effect whose ordering is task #93's contract. Cache eviction happens after commit.
  // Hosted runtime: the agent's credentials are revoked inside this transaction, before the
  // provisioning worker can issue the provider DELETE (it only sees the tombstone after commit).
  const { hostedDeletion, archive, assistantOwnerUserId } = await withFencedAgentAuthority(req.serverId!, req.userId!, agentId, "deleteAgents", async (tx, lockedRole) => {
    // The archive's and the hosted deletion's credential revocations are one operation.
    const audit = { actorRole: lockedRole, operationId: newAuditOperationId() };
    // Re-checked under the agent row lock taken by the fence.
    if (await agentMigrationService.getActiveAgentMigration(agentId, tx)) {
      throw new AgentArchiveError("archive_migration_active", 409, "This agent is being migrated. Wait for the migration to finish or cancel it first.");
    }
    // An App-managed bot lives and goes with its App installation; archived
    // here, a later re-add of the bot would meet a deleted agent.
    const [managed] = await tx.select({ installId: agents.managedByAppInstallId, assistantOwnerUserId: agents.assistantOwnerUserId }).from(agents).where(eq(agents.id, agentId)).limit(1);
    if (managed?.installId) {
      throw new AgentArchiveError(APP_BOT_LIFECYCLE_MANAGED.code, 409, APP_BOT_LIFECYCLE_MANAGED.message);
    }
    // Before deleteAgent clears daemon_id: the archive remembers the Computer.
    const archive = await recordAgentArchive(tx, { agentId, userId: req.userId!, choice: workspaceChoice, audit });
    await agentService.deleteAgent(agentId, { executor: tx });
    return { hostedDeletion: await beginProvisionedAgentDeletion(tx, agentId, req.userId!, audit), archive, assistantOwnerUserId: managed?.assistantOwnerUserId ?? null };
  });
  if (hostedDeletion) kickAgentRuntimeProvisionWorker();
  emitAgentArchiveUpdated(req.app.get("io"), archive, assistantOwnerUserId);
  if (archive.pendingOp) void agentOrchestrator.dispatchPendingAgentArchiveOps?.().catch(() => {});
  kickAppNotificationDelivery();
  agentOrchestrator.evictCache(agentId);
  agentOrchestrator.forgetAgentActivity?.(agentId);
  // After commit: the agent's sk_agent_* credentials are now unusable; close
  // its open wake-hint streams on every replica.
  await broadcastAgentCredentialRevocation(agentId);
  // Notify all clients in this server (a personal assistant: only its owner's).
  const io = req.app.get("io");
  io?.to(agentEventRoom(req.serverId!, assistantOwnerUserId)).emit("agent:deleted", { agentId });
  // Its held calls' cards now say they can no longer be decided (deleteAgent wrote them).
  await emitAgentApprovalCards(io, agentId).catch(() => {});
}

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
    // Before stopping anything; archiveAgentAsUser re-checks under the row lock.
    if (agent.managedByAppInstallId) {
      res.status(409).json({ error: APP_BOT_LIFECYCLE_MANAGED.message, code: APP_BOT_LIFECYCLE_MANAGED.code });
      return;
    }
    const requestedWorkspace = (req.body as { workspace?: unknown } | undefined)?.workspace ?? "keep";
    if (!(AGENT_ARCHIVE_WORKSPACE_CHOICES as readonly unknown[]).includes(requestedWorkspace)) {
      res.status(400).json({ error: "workspace must be keep or delete", code: "archive_workspace_choice_invalid" });
      return;
    }
    const workspaceChoice = requestedWorkspace as AgentArchiveWorkspaceChoice;
    if (workspaceChoice !== "keep" && (!agent.machineId || isExternalAgentRuntime(agent.runtime) || agent.executionMode === "cloud")) {
      res.status(409).json({ error: "This agent has no workspace on a Computer.", code: "archive_workspace_unavailable" });
      return;
    }
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    // An agent that is moving between Computers cannot be archived until the move ends.
    if (await agentMigrationService.getActiveAgentMigration(req.params.id)) {
      res.status(409).json({ error: "This agent is being migrated. Wait for the migration to finish or cancel it first.", code: "archive_migration_active" });
      return;
    }
    if (!isExternalAgentRuntime(agent.runtime)) {
      await stopAgentBeforeDelete(agentOrchestrator, req.params.id);
    }
    // Task #91: the delete itself is re-authorized inside the write transaction. Stopping the runtime above is a runtime
    // effect whose ordering is task #93's contract. Cache eviction happens after commit.
    // Hosted runtime: the agent's credentials are revoked inside this transaction, before the
    // provisioning worker can issue the provider DELETE (it only sees the tombstone after commit).
    await archiveAgentAsUser(req, req.params.id, workspaceChoice);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof ServerMembershipRevokedError) {
      res.status(403).json({ error: err.message });
      return;
    }
    if (err instanceof FencedAuthorizationDeniedError) {
      if (err.reason === "not_found") {
        res.status(404).json({ error: "Agent not found" });
      } else {
        res.status(403).json({ error: "The `deleteAgents` capability or human creator authority is required to delete agents" });
      }
      return;
    }
    if (err instanceof AgentArchiveError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    res.status(500).json({ error: "Failed to delete agent" });
  }
});

async function loadArchivedAgentForRoute(req: Request, res: Response, capability: "deleteAgents" | "inspect") {
  const agent = await agentService.getAgent(String(req.params.id), true);
  if (!agent || agent.serverId !== req.serverId || !agent.deletedAt || !isAgentFindableBy({ userId: req.userId! }, agent)) {
    res.status(404).json({ error: "Archived agent not found", code: "agent_not_archived" });
    return null;
  }
  const allowed = capability === "inspect"
    ? await canInspectAgentPrivateSurfaces(req.serverId!, req.userId!, agent)
    : await currentUserCanActOnAgent(req.serverId!, req.userId!, agent, "deleteAgents");
  if (!allowed) {
    res.status(403).json({ error: "You cannot manage this archived agent's workspace" });
    return null;
  }
  return agent;
}

function sendAgentArchiveRouteError(req: Request, res: Response, err: unknown, logPrefix: string): void {
  if (err instanceof FencedAuthorizationDeniedError) {
    res.status(err.reason === "not_found" ? 404 : 403).json({
      error: err.reason === "not_found" ? "Archived agent not found" : "You cannot manage this archived agent's workspace",
    });
    return;
  }
  if (err instanceof AgentArchiveError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  sendJsonServerError(req, res, { error: "Agent archive request failed", code: "agent_archive_failed", logPrefix, err });
}

// The archive record of an archived agent: where its workspace is and the op in progress.
agentRouter.get("/:id/archive", async (req, res) => {
  try {
    const agent = await loadArchivedAgentForRoute(req, res, "inspect");
    if (!agent) return;
    const archive = await getAgentArchive(agent.id);
    const orchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    res.json({ archive: archive ? toAgentArchiveView(archive, orchestrator?.agentArchiveDispatchPort?.()) : null });
  } catch (err) {
    sendAgentArchiveRouteError(req, res, err, "[Agents] Failed to read agent archive");
  }
});

// Delete the workspace of an archived agent that kept it on its Computer.
agentRouter.post("/:id/archive/workspace", async (req, res) => {
  try {
    const agent = await loadArchivedAgentForRoute(req, res, "deleteAgents");
    if (!agent) return;
    const action = (req.body as { action?: unknown } | undefined)?.action;
    if (action !== "delete") {
      res.status(400).json({ error: "action must be delete", code: "archive_workspace_action_invalid" });
      return;
    }
    const archive = await withFencedArchivedAgentAuthority(req.serverId!, req.userId!, agent.id, (tx) =>
      requestAgentArchiveWorkspaceOp({
        agentId: agent.id,
        serverId: req.serverId!,
        userId: req.userId!,
        op: action,
      }, tx));
    const orchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    emitAgentArchiveUpdated(req.app.get("io"), archive);
    void orchestrator.dispatchPendingAgentArchiveOps?.().catch(() => {});
    res.json({ archive: toAgentArchiveView(archive, orchestrator.agentArchiveDispatchPort?.()) });
  } catch (err) {
    sendAgentArchiveRouteError(req, res, err, "[Agents] Failed to request archive workspace op");
  }
});

/** The agent list's `blockedReason`: a revoked Computer first (it never connects, so no version applies). */
function agentBlockedReason(machineId: string | null, accessRevoked: ReadonlySet<string>, versionHeld: ReadonlySet<string>): AgentBlockedReason | null {
  if (!machineId) return null;
  if (accessRevoked.has(machineId)) return "computer_access_revoked";
  return versionHeld.has(machineId) ? "computer_version_unsupported" : null;
}

/** Reconciler step 15 (B15): a start for an agent whose Computer's access was revoked (it stays bound to it). */
function sendComputerAccessRevoked(res: Response): void {
  refuse(res, 409, {
    code: "computer_access_revoked",
    error: "This agent's Computer lost its access to this server (its key was revoked) and cannot connect, so the agent cannot start. Move the agent to another computer. Attaching that machine again adds it as a new computer, which the agent then has to be moved to.",
  });
}

/** 409: the agent's workspace lives on a Computer whose access was revoked, so it cannot be read. */
function sendWorkspaceComputerAccessRevoked(res: Response): void {
  refuse(res, 409, {
    code: "computer_access_revoked",
    error: "This agent's Computer lost its access to this server (its key was revoked) and cannot connect, so its workspace cannot be read. Move the agent to another computer.",
  });
}

/** 409: the chosen machine's Computer key was revoked (detached); it takes no agents until attached again. */
function sendMachineKeyRevoked(res: Response): void {
  const err = new MachineKeyRevokedError();
  res.status(409).json({ error: err.message, code: err.code });
}

/**
 * Name the Computer a workspace request waits on (hashed id, versions,
 * runtime) on its request span, so a 504 or a refusal can be matched to the
 * machine (#proj-o11y:#29).
 */
async function traceWorkspaceComputerTarget(res: Response, machineId: string, runtime: string): Promise<void> {
  const machine = await machineService.getMachine(asMachineId(machineId));
  setRequestTraceComputerTarget(res, {
    machineId,
    computerVersion: machine?.computerVersion,
    daemonVersion: machine?.daemonVersion,
    runtime,
  });
}

/** 409: a personal assistant never has a machine (agents_assistant_not_on_machine). */
function sendAssistantCannotUseComputer(res: Response): void {
  const err = new AssistantCannotUseComputerError();
  refuse(res, 409, { code: err.code, error: err.message });
}

// Get agent workspace file tree (relayed to daemon via WebSocket)
/**
 * Read-only workspace of an archived agent, from the Computer that still
 * holds it (which must be online).
 */
async function sendArchivedWorkspace(
  req: Request,
  res: Response,
  agentId: string,
  readFromComputer: (orchestrator: AgentOrchestrator, machineId: string) => Promise<object>,
): Promise<void> {
  const archive: AgentArchiveRow | null = await getAgentArchive(agentId);
  try {
    if (archive?.workspaceState === "on_computer" && archive.machineId) {
      const orchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
      const machineId = archive.machineId;
      const routing = await handleMachineLocalRouting(req, res, machineId, () => orchestrator.hasMachineLocally(machineId));
      if (routing === "handled") return;
      if (routing !== "confirmed_local") {
        res.status(409).json({ error: "The Computer that holds this workspace is offline.", code: "machine_offline" });
        return;
      }
      res.json({ ...await readFromComputer(orchestrator, machineId), source: "computer" });
      return;
    }
    res.status(409).json({ error: "This archived agent's workspace cannot be browsed.", code: "archive_workspace_unavailable" });
  } catch (err) {
    const failure = responseForAgentRouteFailure(err);
    if (failure.code !== "internal_error") {
      res.status(failure.status).json({ error: "The Computer that holds this workspace did not answer.", code: failure.code });
      return;
    }
    throw err;
  }
}

agentRouter.get("/:id/workspace-files", async (req, res) => {
  try {
    const agent = await agentService.getAgent(req.params.id, true);
    if (!agent || agent.serverId !== req.serverId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    if (!await canInspectAgentPrivateSurfaces(req.serverId!, req.userId!, agent)) {
      res.status(403).json({ error: "The `editAgents` capability or human creator authority is required to view agent workspace" });
      return;
    }
    if (agent.deletedAt) {
      const dirPath = typeof req.query.dirPath === "string" && req.query.dirPath ? req.query.dirPath : undefined;
      const includeHidden = req.query.includeHidden === "true";
      await sendArchivedWorkspace(req, res, agent.id, (orchestrator, machineId) =>
        orchestrator.getAgentFileTree(agent.id, dirPath, includeHidden, machineId).then((files) => ({ files })));
      return;
    }
    // A hosted agent has no machine: its provider serves the workspace.
    const hostedRuntime = isExternalAgentRuntime(agent.runtime) ? await getHostedRuntimeSummary(agent.id) : null;
    if (hostedRuntime) {
      if (await isAgentRuntimeProviderKillSwitched(hostedRuntime.provider)) {
        sendAgentRuntimeProviderError(res, hostedRuntimeDisabledError());
        return;
      }
      const dirPath = typeof req.query.dirPath === "string" && req.query.dirPath ? req.query.dirPath : undefined;
      const result = await listHostedAgentWorkspaceFiles(agent.id, { dirPath, includeHidden: req.query.includeHidden === "true" });
      if (result.kind !== "ok") {
        const failure = sendHostedSurfaceFailure(res, result, "workspace");
        addTraceEvent("agent.workspace.list.failed", {
          route_action: "workspace_list",
          outcome: "error",
          runtime_host: "hosted",
          reason: failure.reason,
          http_status: failure.status,
          response_code: failure.code,
        });
        return;
      }
      res.json(result.body);
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
    await traceWorkspaceComputerTarget(res, agent.machineId, agent.runtime);
    // A revoked Computer never connects again: say so now instead of routing to
    // a stale owner and timing out (504).
    if (await agentOrchestrator.isMachineAccessRevoked(agent.machineId)) {
      addTraceEvent("agent.workspace.list.rejected", {
        route_action: "workspace_list",
        outcome: "error",
        reason: "computer_access_revoked",
        http_status: 409,
        response_code: "computer_access_revoked",
      });
      sendWorkspaceComputerAccessRevoked(res);
      return;
    }

    const routing = await handleMachineLocalRouting(
      req,
      res,
      agent.machineId,
      () => agentOrchestrator.hasMachineLocally(agent.machineId!),
    );
    if (routing === "handled") return;
    if (routing !== "confirmed_local") {
      sendMachineAffinityUnavailable(res, agent.machineId, routing);
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
    const agent = await agentService.getAgent(req.params.id, true);
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
    if (agent.deletedAt) {
      await sendArchivedWorkspace(req, res, agent.id, (orchestrator, machineId) =>
        orchestrator.readAgentFile(agent.id, filePath, machineId)
          .then((file) => ({ path: filePath, ...file, modifiedAt: new Date().toISOString() })));
      return;
    }
    // A hosted agent has no machine: its provider serves the workspace.
    const hostedRuntime = isExternalAgentRuntime(agent.runtime) ? await getHostedRuntimeSummary(agent.id) : null;
    if (hostedRuntime) {
      if (await isAgentRuntimeProviderKillSwitched(hostedRuntime.provider)) {
        sendAgentRuntimeProviderError(res, hostedRuntimeDisabledError());
        return;
      }
      const result = await readHostedAgentWorkspaceFile(agent.id, filePath);
      if (result.kind !== "ok") {
        const failure = sendHostedSurfaceFailure(res, result, "workspace");
        addTraceEvent("agent.workspace.read.failed", {
          route_action: "workspace_read",
          outcome: "error",
          runtime_host: "hosted",
          reason: failure.reason,
          http_status: failure.status,
          response_code: failure.code,
        });
        return;
      }
      const file = result.body;
      res.json({
        path: file.path ?? filePath,
        content: file.content,
        binary: file.binary,
        size: file.size,
        mimeType: file.mimeType ?? undefined,
        encoding: file.encoding ?? undefined,
        modifiedAt: file.modifiedAt ?? new Date().toISOString(),
      });
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
    await traceWorkspaceComputerTarget(res, agent.machineId, agent.runtime);
    // A revoked Computer never connects again: say so now instead of routing to
    // a stale owner and timing out (504).
    if (await agentOrchestrator.isMachineAccessRevoked(agent.machineId)) {
      addTraceEvent("agent.workspace.read.rejected", {
        route_action: "workspace_read",
        outcome: "error",
        reason: "computer_access_revoked",
        http_status: 409,
        response_code: "computer_access_revoked",
      });
      sendWorkspaceComputerAccessRevoked(res);
      return;
    }

    const routing = await handleMachineLocalRouting(
      req,
      res,
      agent.machineId,
      () => agentOrchestrator.hasMachineLocally(agent.machineId!),
    );
    if (routing === "handled") return;
    if (routing !== "confirmed_local") {
      sendMachineAffinityUnavailable(res, agent.machineId, routing);
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
    const probes = computerProbeCacheFor(req.app);
    const skillsTarget = { machineId: agent.machineId ?? null, runtime: agent.runtime, agentId: req.params.id };

    if (agent.machineId) {
      const machine = await machineService.getMachine(asMachineId(agent.machineId));
      setRequestTraceComputerTarget(res, {
        machineId: agent.machineId,
        computerVersion: machine?.computerVersion,
        daemonVersion: machine?.daemonVersion,
        runtime: agent.runtime,
      });
      const routing = await handleMachineLocalProbeRouting(
        req,
        res,
        agent.machineId,
        () => agentOrchestrator.hasMachineLocally(agent.machineId!),
      );
      if (routing === "handled") return;
      if (isMachineLocalReplayFailure(routing)) {
        // The owner replica did not answer in time: the shared cache, never a 504.
        setRequestTraceErrorCode(res, machineLocalReplayFailureCode(routing));
        sendAgentSkillsAnswer(res, await probes.cachedSkills(skillsTarget));
        return;
      }
      if (routing !== "confirmed_local") {
        sendMachineAffinityUnavailable(res, agent.machineId, routing);
        return;
      }
    }

    skillsListRuntime = agent.runtime;
    skillsListStartedAt = performance.now();
    sendAgentSkillsAnswer(res, await probes.probeSkills(
      skillsTarget,
      () => agentOrchestrator.getAgentSkills(req.params.id, agent.runtime),
    ));
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
    sendJsonServerError(req, res, {
      error: "Failed to load agent scopes",
      logPrefix: "agents.scopes.read error:",
      err,
    });
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
      const set = await withFencedAgentAuthority(req.serverId!, req.userId!, req.params.id, "editAgents", (tx) =>
        agentScopesService.resetAgentScopesToDefault({
          agentId: req.params.id,
          updatedByUserId: req.userId!,
        }, { executor: tx }));
      res.json(set);
      return;
    }
    if (!Array.isArray(body.scopes)) {
      res.status(400).json({ error: "scopes must be an array of scope literals" });
      return;
    }
    const set = await withFencedAgentAuthority(req.serverId!, req.userId!, req.params.id, "editAgents", (tx) =>
      agentScopesService.updateAgentScopes({
        agentId: req.params.id,
        scopes: body.scopes as readonly string[],
        updatedByUserId: req.userId!,
      }, { executor: tx }));
    // TODO(noel): emit `agent:scope-updated` over ws so daemon caches hot-swap
    // without the next CLI/MCP call paying the DB read. Wire is the
    // `AgentScopeSet` wire shape, sent verbatim. Tracked at #proj-permission:10bdc2c9.
    res.json(set);
  } catch (err) {
    if (err instanceof ServerMembershipRevokedError) {
      res.status(403).json({ error: err.message });
      return;
    }
    if (err instanceof FencedAuthorizationDeniedError) {
      if (err.reason === "not_found") {
        res.status(404).json({ error: "Agent not found" });
      } else {
        res.status(403).json({ error: "The `editAgents` capability or human creator authority is required to update agent scopes" });
      }
      return;
    }
    if (err instanceof agentScopesService.AgentScopesNotFoundError) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    if (err instanceof agentScopesService.DedicatedAgentScopeError) {
      res.status(422).json({ error: err.message, code: "raftbench_service_scope_invalid" });
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to update agent scopes",
      logPrefix: "agents.scopes.update error:",
      err,
    });
  }
});


/**
 * Same fence as `withFencedAgentAuthority`, for an ARCHIVED agent: the
 * `deleteAgents` (or creator) authority is re-checked against the locked row.
 */
async function withFencedArchivedAgentAuthority<T>(
  serverId: string,
  userId: string,
  agentId: string,
  run: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  return withActorMembershipFence(serverId, userId, async (tx, lockedRole) => {
    const [locked] = await tx
      .select({ id: agents.id, serverId: agents.serverId, creatorType: agents.creatorType, creatorId: agents.creatorId, assistantOwnerUserId: agents.assistantOwnerUserId })
      .from(agents)
      .where(and(eq(agents.id, agentId), isNotNull(agents.deletedAt)))
      .for("update");
    // Another person's assistant is not found here either (agentFindableBy).
    if (!locked || locked.serverId !== serverId || !isAgentFindableBy({ userId }, locked)) throw new FencedAuthorizationDeniedError("not_found");
    if (!userCanActOnAgentResource(lockedRole, userId, await withAssistantOwnerMembership(serverId, locked, tx), "deleteAgents")) {
      throw new FencedAuthorizationDeniedError("forbidden");
    }
    return run(tx);
  });
}

// Task #91: agent authority writes re-authorize inside the write transaction under a share lock on the caller's membership
// row (member row first), then an update lock on the agent row (agent row second). The role and creator relation used for
// the decision are the ones read under those locks. The agent row is locked FOR UPDATE, not FOR SHARE, because several
// callers update that row next: upgrading a shared lock would let two concurrent writers deadlock.
async function withFencedAgentAuthority<T>(
  serverId: string,
  userId: string,
  agentId: string,
  capability: Parameters<typeof userCanActOnAgentResource>[3],
  run: (tx: DatabaseTransaction, lockedRole: Parameters<typeof userCanActOnAgentResource>[0]) => Promise<T>,
): Promise<T> {
  return withActorMembershipFence(serverId, userId, async (tx, lockedRole) => {
    const [locked] = await tx
      .select({ id: agents.id, serverId: agents.serverId, creatorType: agents.creatorType, creatorId: agents.creatorId, assistantOwnerUserId: agents.assistantOwnerUserId })
      .from(agents)
      .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
      .for("update");
    // Another person's assistant is not found here either (agentFindableBy),
    // whatever the caller's role: re-decided under the locks.
    if (!locked || locked.serverId !== serverId || !isAgentFindableBy({ userId }, locked)) throw new FencedAuthorizationDeniedError("not_found");
    const subject = capability === "deleteAgents" ? await withAssistantOwnerMembership(serverId, locked, tx) : locked;
    if (!userCanActOnAgentResource(lockedRole, userId, subject, capability)) {
      throw new FencedAuthorizationDeniedError("forbidden");
    }
    return run(tx, lockedRole);
  });
}

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
//   - scopes: subset of ALLOWED_AGENT_CAPABILITIES. Defaults to
//     DEFAULT_EXTERNAL_AGENT_CAPABILITIES (least privilege) when omitted.
//   - External agents only: 400 `agent_not_external` for managed agents.
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
    // A non-UUID id names no agent: the same 404, not the uuid cast's error.
    const agent = isUuid(req.params.id) ? await agentService.getAgent(req.params.id, true) : null;
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

    // The token exchanges for an `sk_agent_*`: external agents only (a
    // managed agent's credentials come from its Computer).
    if (!isExternalAgentRuntime(agent.runtime)) {
      res.status(400).json({
        error: "Bootstrap tokens can only be issued for external agents; a managed agent's credentials come from its computer",
        code: "agent_not_external",
      });
      return;
    }

    const body = (req.body ?? {}) as { scopes?: unknown; ttlMs?: unknown };

    // Default scope = the least-privilege external-agent set; elevated
    // scopes (`server`, `mcp`) must be named explicitly.
    const requested = resolveRequestedAgentCapabilities(body.scopes, DEFAULT_EXTERNAL_AGENT_CAPABILITIES);
    if (!requested.ok) {
      res.status(400).json({ error: requested.error, code: requested.code });
      return;
    }
    const scopes = requested.scopes;

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

    // Two-step verification on: this sign-in passed it in the last 10 minutes (stepUpGate.ts).
    const webSessionFamilyId = webSessionFamilyOf(req);
    if (await refuseWithoutRecentSecondFactor(res, req.userId!, webSessionFamilyId, "agent_bootstrap_token")) return;
    // A token is a key to be: the same per-person and per-agent budget as a
    // direct mint (agentCredentialMintLimits.ts). The live-key cap applies when
    // it is exchanged (mintAgentCredential), not here: a token is not a key,
    // and it expires within 24 hours.
    await enforceAgentCredentialMintRate({ userId: req.userId!, agentId: agent.id });

    // The raw token is generated inside the fenced transaction and returned only after it commits.
    // The person's web session is recorded on the token (and the credential it
    // is exchanged for) and fenced live: a security revoke of it revokes both
    // (webSessionIssuedKeys.ts).
    const issued = await withFencedAgentAuthority(req.serverId!, req.userId!, agent.id, "issueAgentCredentials", async (tx, lockedRole) => {
      if (webSessionFamilyId) await lockLiveSessionFamily(tx, webSessionFamilyId, req.userId!);
      const token = await issueAgentBootstrapToken({
        agentId: agent.id,
        serverId: req.serverId!,
        issuedByUserId: req.userId!,
        issuedByWebSessionFamilyId: webSessionFamilyId,
        scopes,
        ttlMs,
      }, { executor: tx });
      // Ids and scopes only: never the token or its prefix.
      await recordIntegrationAuditEvent({
        serverId: req.serverId!,
        eventType: "agent_credential.bootstrap_token_issued",
        outcome: "success",
        source: "web",
        actor: { type: "human", id: req.userId! },
        subject: { type: "agent", id: agent.id },
        target: { type: "agent_bootstrap_token", id: token.tokenId },
        metadata: {
          agentId: agent.id,
          bootstrapTokenId: token.tokenId,
          scopes: token.scopes,
          expiresAt: token.ttlExpiresAt.toISOString(),
          ...serverAuditContextMetadata({ actorRole: lockedRole }),
        },
      }, tx);
      return token;
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
    if (err instanceof DeviceSessionRevokedError) {
      respondInvalidOrExpiredToken(res);
      return;
    }
    if (err instanceof ServerMembershipRevokedError) {
      res.status(403).json({ error: err.message });
      return;
    }
    if (err instanceof FencedAuthorizationDeniedError) {
      if (err.reason === "not_found") {
        res.status(404).json({ error: "Agent not found", code: "agent_missing" });
      } else {
        res.status(403).json({
          error: "The `issueAgentCredentials` capability or human creator authority is required to issue agent bootstrap tokens",
          code: "insufficient_role",
        });
      }
      return;
    }
    if (err instanceof Error) {
      if (err.message === "agent_missing") {
        res.status(404).json({ error: "Agent not found", code: "agent_missing" });
        return;
      }
      if (err.message === "agent_not_external") {
        res.status(400).json({
          error: "Bootstrap tokens can only be issued for external agents; a managed agent's credentials come from its computer",
          code: "agent_not_external",
        });
        return;
      }
      if (err.message === "agent_server_mismatch") {
        // Defense-in-depth — should already be caught by the 404 above.
        res.status(404).json({ error: "Agent not found", code: "agent_missing" });
        return;
      }
    }
    sendJsonServerError(req, res, {
      error: "Failed to issue bootstrap token",
      logPrefix: "agents.bootstrap-tokens.issue error:",
      err,
    });
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

// ── "My assistant" (RFC 075 v4) ────────────────────────────────────────────
// Mounted at /api/servers/:id/assistant (servers.ts), behind the server
// membership check. Each person manages only their own assistant; nobody can
// create or delete someone else's here. Nobody renames one: every assistant is Ottie.
export const myAssistantRouter: RouterType = Router({ mergeParams: true });

// A Guest has no personal assistant: it belongs to one channel, and an
// assistant is a member of the whole Server acting for its owner. GET answers
// as for a Server without the feature; everything else is refused, before any
// handler reads or writes.
myAssistantRouter.use(async (req, res, next) => {
  if (await getActorServerRoleInServer(req.serverId!, "user", req.userId!) !== "guest") {
    next();
    return;
  }
  if (req.method === "GET" && req.path === "/") {
    res.json({ enabled: false, assistant: null });
    return;
  }
  res.status(403).json({ error: "Guests can't have a personal assistant.", code: assistantService.ASSISTANT_NOT_ENABLED_CODE });
});

async function myAssistantView(serverId: string, userId: string) {
  return {
    enabled: await assistantService.isMyAssistantAvailable(serverId),
    assistant: await assistantService.getMyAssistant(serverId, userId),
  };
}

myAssistantRouter.get("/", async (req, res) => {
  try {
    res.json(await myAssistantView(req.serverId!, req.userId!));
  } catch (err) {
    console.error("my-assistant: get failed:", err);
    res.status(500).json({ error: "Failed to load your assistant" });
  }
});

myAssistantRouter.post("/", async (req, res) => {
  try {
    const serverId = req.serverId!;
    const userId = req.userId!;
    if (!await assistantService.isMyAssistantAvailable(serverId)) {
      res.status(403).json({ error: "Personal assistants are not enabled on this server.", code: assistantService.ASSISTANT_NOT_ENABLED_CODE });
      return;
    }
    // Every assistant is Ottie: a `name` in the body (older clients send one) is ignored.
    const [owner] = await getDb().select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
    if (!owner) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    try {
      const { agentId } = await assistantService.createMyAssistant({ serverId, userId, ownerHandle: owner.name });
      const io = req.app.get("io") as SocketServer | undefined;
      const dmChannelId = await channelService.findHumanAgentDmChannelId(serverId, userId, agentId);
      if (dmChannelId) {
        io?.to(`user:${userId}`).emit("dm:new", { channelId: dmChannelId });
      }
      const created = await agentService.getAgent(agentId);
      if (created) {
        const result = await agentService.enrichAgentWithCreatorProfile(withServerRoleProjection(withAgentProjection(created), "member"));
        broadcastAgentCreated(io, result);
      }
      res.status(201).json(await myAssistantView(serverId, userId));
    } catch (err) {
      if (err instanceof assistantService.AssistantExistsError) {
        res.status(409).json({ error: err.message, code: "assistant_exists", ...await myAssistantView(serverId, userId) });
        return;
      }
      if (err instanceof AgentRuntimeProviderError) {
        res.status(403).json({ error: "Personal assistants are not enabled on this server.", code: assistantService.ASSISTANT_NOT_ENABLED_CODE });
        return;
      }
      // An assistant takes no agent seat, so no capacity answer here.
      if (err instanceof ServerMembershipRevokedError) {
        res.status(403).json({ error: err.message });
        return;
      }
      throw err;
    }
  } catch (err) {
    console.error("my-assistant: create failed:", err);
    res.status(500).json({ error: "Failed to create your assistant" });
  }
});

myAssistantRouter.patch("/", async (req, res) => {
  try {
    const serverId = req.serverId!;
    const userId = req.userId!;
    const mine = await assistantService.getMyAssistant(serverId, userId);
    if (!mine) {
      res.status(404).json({ error: "You have no assistant in this server.", code: "assistant_not_found" });
      return;
    }
    const body = (req.body ?? {}) as { name?: unknown; readsDms?: unknown; sendAsOwner?: unknown; ownerNotes?: unknown };
    // Every assistant is Ottie: its name is fixed, so a rename is refused and nothing changes.
    if (body.name !== undefined) {
      res.status(400).json({ error: `An assistant's name is fixed: ${assistantService.ASSISTANT_DISPLAY_NAME}.`, code: "assistant_name_fixed" });
      return;
    }
    if (body.readsDms === undefined && body.sendAsOwner === undefined && body.ownerNotes === undefined) {
      res.status(400).json({ error: "Send readsDms, sendAsOwner or ownerNotes.", code: "invalid_request" });
      return;
    }
    const ownerNotes = body.ownerNotes === undefined ? null : assistantService.normalizeAssistantOwnerNotes(body.ownerNotes);
    if (ownerNotes && !ownerNotes.ok) {
      res.status(400).json({ error: ownerNotes.reason, code: "invalid_owner_notes" });
      return;
    }
    if (body.sendAsOwner !== undefined && typeof body.sendAsOwner !== "boolean") {
      res.status(400).json({ error: "sendAsOwner must be true or false.", code: "invalid_send_as_owner" });
      return;
    }
    const sendAsOwner = body.sendAsOwner as boolean | undefined;
    if (body.readsDms !== undefined && typeof body.readsDms !== "boolean") {
      res.status(400).json({ error: "readsDms must be true or false.", code: "invalid_reads_dms" });
      return;
    }
    const readsDms = body.readsDms as boolean | undefined;
    const afterCommit: Array<() => void> = [];
    await withFencedAgentAuthority(serverId, userId, mine.agentId, "editAgents", async (tx) => {
      // RFC 077: the owner's notes, sent after Raft's fixed instructions.
      if (ownerNotes?.ok) await assistantService.setAssistantOwnerNotes(mine.agentId, ownerNotes.notes, tx);
      // Hosted runtime: new notes reach the provider as an ordered PATCH.
      if (ownerNotes?.ok && await noteProvisionedAgentProfileEdit(tx, mine.agentId)) afterCommit.push(kickAgentRuntimeProvisionWorker);
      // RFC 077: the owner's own switch for DM reading; the next read and doorbell follow it.
      if (readsDms !== undefined) await assistantService.setAssistantReadsDms(mine.agentId, readsDms, tx);
      // RFC 077: the owner's opt-in for sending as them; off refuses the next send.
      if (sendAsOwner !== undefined) await setAssistantSendAsOwner(mine.agentId, sendAsOwner, tx);
    });
    for (const effect of afterCommit) effect();
    res.json(await myAssistantView(serverId, userId));
  } catch (err) {
    if (err instanceof FencedAuthorizationDeniedError) {
      res.status(err.reason === "not_found" ? 404 : 403).json({ error: "You cannot change this assistant.", code: err.reason === "not_found" ? "assistant_not_found" : "forbidden" });
      return;
    }
    console.error("my-assistant: update failed:", err);
    res.status(500).json({ error: "Failed to update your assistant" });
  }
});

// What an assistant changed of the caller's own settings, newest first: their
// theme in this server, and their UI language and time zone (account-wide)
// changed from any server, each with the server it was made in; and what it did
// as them in this server (owner actions: mute, notification level, sidebar). The audit rows
// whose subject is the caller, so each person reads only their own. Works
// after the assistant itself was deleted too.
myAssistantRouter.get("/setting-changes", async (req, res) => {
  try {
    const [settings, actions] = await Promise.all([
      listOwnerSettingChanges(req.serverId!, req.userId!),
      listOwnerActionChanges(req.serverId!, req.userId!),
    ]);
    // One list, newest first: each settings section shows its own kinds.
    const changes = [...settings, ...actions].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    res.json({ changes });
  } catch (err) {
    console.error("my-assistant: setting changes failed:", err);
    res.status(500).json({ error: "Failed to load what your assistant changed" });
  }
});

// RFC 077 PR 2b: the owner retracts a message their assistant sent as them.
// Only its author (the owner), only a delegated message; works after the
// assistant itself was deleted too.
myAssistantRouter.delete("/delegated/:messageId", async (req, res) => {
  try {
    const messageId = String(req.params.messageId);
    if (!/^[0-9a-f-]{36}$/i.test(messageId)) {
      res.status(404).json({ error: "No message your assistant sent for you has this id.", code: "message_not_found" });
      return;
    }
    res.json(await retractDelegatedMessage({ io: req.app.get("io"), serverId: req.serverId!, userId: req.userId!, messageId }));
  } catch (err) {
    if (err instanceof AssistantSendAsOwnerError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    console.error("my-assistant: retract failed:", err);
    res.status(500).json({ error: "Failed to retract the message" });
  }
});

myAssistantRouter.delete("/", async (req, res) => {
  try {
    const serverId = req.serverId!;
    const userId = req.userId!;
    const mine = await assistantService.getMyAssistant(serverId, userId);
    if (!mine) {
      res.status(404).json({ error: "You have no assistant in this server.", code: "assistant_not_found" });
      return;
    }
    // A cloud agent: no Computer to stop and no workspace to choose about.
    await archiveAgentAsUser(req, mine.agentId, "keep");
    res.json({ enabled: await assistantService.isMyAssistantAvailable(serverId), assistant: null });
  } catch (err) {
    if (err instanceof FencedAuthorizationDeniedError) {
      res.status(err.reason === "not_found" ? 404 : 403).json({ error: "You cannot delete this assistant.", code: err.reason === "not_found" ? "assistant_not_found" : "forbidden" });
      return;
    }
    if (err instanceof AgentArchiveError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    console.error("my-assistant: delete failed:", err);
    res.status(500).json({ error: "Failed to delete your assistant" });
  }
});
