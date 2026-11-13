// /internal/computer/* — RFC v0.8 Computer control-plane surface.
//
// Slice-1 active surface:
//   POST /internal/computer/runners/:agentId/credentials — runner mint
//
// Auth is wired upstream via `authFromRegistry()` which dispatches to
// `requireComputerAuth` based on the entry in `routeAuthPolicy`. By the
// time these handlers run:
//   - req.principalKind === "computer"
//   - req.computerId   === <computer attachment id>
//   - req.serverId     === <computer's bound server id>
//
// Cross-principal rejection (RFC §5.6) is enforced by the dispatcher; an
// sk_agent_* caller hitting this surface gets 401 invalid_principal before
// reaching here. Phase 1 accepts sk_machine_* as a Computer alias until the
// wire prefix migration lands.

import { Router, type Request, type Response, type Router as RouterType } from "express";
import rateLimit from "express-rate-limit";
import type { Server as SocketServer } from "socket.io";
import {
  AGENT_MIGRATION_TERMINAL_FAILURE_CODES,
  DAEMON_CAPABILITY_RUNNER_CREDENTIAL_RENEW_V1,
  currentDate,
  type AgentMigrationControlManifest,
  type AgentMigrationSourceQuiesceReceipt,
} from "@botiverse/raft-shared";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/index";
import { agents, computers, machines, servers } from "../db/schema";
import { handleMachineLocalRouting } from "../machineLocalReplay";
import { createMachineLocalComputerLifecycleOperation } from "../services/computerLifecycleOperationService";
import { revokeComputerKeyInTransaction } from "../services/computerKeyRevocation";
import { noticeOwnersOfDetachedComputer } from "../services/computerDetachedNotices";
import { OthersAgentsOnComputerError, unbindForcedOthersAgents, type OthersAgentOnMachine } from "../services/computerAgents";
import { parseAgentIdList, withOwnerNotifyTimes } from "../services/accountDeletion/ownerNotices";
import { postAgentActionRequiredNotice } from "../services/agentActionRequiredNoticeService";
import { newAuditOperationId, recordIntegrationAuditEvent, serverAuditContextMetadata } from "../services/integrationAuditService";
import { closeDeviceSessionKeys } from "../services/deviceSessionKeys";
import { addTraceEvent } from "../tracing/semanticTrace";
import {
  ALLOWED_AGENT_CAPABILITIES,
  mintAgentCredential,
  normalizeAgentCapabilities,
  renewRunnerCredential,
  revokeAgentCredentialWithOutcome,
  runnerCredentialExpiresAt,
  type AgentCapability,
  type RunnerCredentialRenewRefusal,
} from "../services/agentCredentialService";
import { refuse, rateLimitRefusal, type RefusalStatus } from "../lib/refusal";
import { broadcastAgentCredentialRevocation } from "../replicaRouter";
import {
  ProviderConnectionError,
  resolveProviderConnectionLaunch,
} from "../services/providerConnectionService";
import { isProviderConnectionsEnabled, isProviderProbesEnabled } from "../services/providerConnectionFeature";
import {
  materializeProviderProbe,
  ProviderProbeError,
} from "../services/providerProbeService";
import { isProviderProbeId } from "@botiverse/raft-shared";
// task #30 PR-A: preflight derives its principal/path view DIRECTLY from the
// live auth registry — never a copied/static `EXPECTED_PRINCIPALS` list. A
// registry gap therefore fails preflight and real auth identically (the
// fake-unregistered-path test is the regression form of that invariant).
import {
  routeAuthPolicy,
  CLAIMED_AUTH_POLICY_PREFIXES,
} from "../middleware/routeAuthPolicy";
import { SERVER_VERSION } from "../version";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import { archiveMigrationSourceWorkspace } from "../services/agentMigrationSourceArchive";
import {
  acknowledgeAgentMigrationCancellation,
  assertAgentMigrationTargetArrivalArchivable,
  completeAgentMigrationAutoStart,
  completeAgentMigrationResumableUpload,
  flipAgentMigrationTargetImport,
  getAgentMigrationTargetImport,
  getAgentMigrationResumableControl,
  markAgentMigrationTransportLostForComputer,
  agentMigrationSizeFailureNeedsConfigPush,
  markAgentMigrationTargetImportArrived,
  planAgentMigrationChunkTransfers,
  prepareAgentMigrationStreamedChunk,
  recordAgentMigrationChunkReceipt,
  recordAgentMigrationSourceArchiveAttemptFailed,
  recordAgentMigrationSourceWorkspaceArchived,
  recordAgentMigrationSourceBuildProgress,
  recordAgentMigrationSourceQuiesced,
  registerAgentMigrationControlManifest,
  recordAgentMigrationAutoStartFailure,
  startAgentMigrationTargetImport,
  type AgentMigrationTransportFailureCode,
  type AgentMigrationTargetImportView,
} from "../services/agentMigrationService";
import {
  emitAgentMigrationUpdated,
  emitAgentMigrationUpdatedByRef,
} from "../services/agentMigrationRealtime";
import { sendJsonServerError } from "./errorResponse";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { setRequestTraceComputerCaller } from "../middleware/requestObservability";

export const internalComputerRouter: RouterType = Router();

const AGENT_MIGRATION_TRANSPORT_FAILURE_CODES: ReadonlySet<AgentMigrationTransportFailureCode> =
  new Set(AGENT_MIGRATION_TERMINAL_FAILURE_CODES);
// Code-shaped only (no free text): stored verbatim in transport_error_code.
const AGENT_MIGRATION_TRANSPORT_DETAIL_CODE_PATTERN = /^[A-Za-z0-9_:.-]{1,160}$/;

function jsonBody(req: { body?: unknown }): Record<string, unknown> {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
}

function requiredString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function migrationTransportToken(req: { headers: Record<string, string | string[] | undefined> }): string | null {
  const value = req.headers["x-raft-migration-token"];
  const token = Array.isArray(value) ? value[0] : value;
  return typeof token === "string" && token.trim() ? token.trim() : null;
}

async function computerMigrationContext(
  req: { serverId?: string; machineId?: string; computerId?: string; params?: Record<string, string | undefined> },
  res: { locals?: Record<string, unknown> },
) {
  const serverId = req.serverId ?? null;
  let machineId = req.machineId ?? null;
  if (serverId && !machineId && req.computerId) {
    const [computer] = await getDb()
      .select({ machineId: computers.machineId })
      .from(computers)
      .where(eq(computers.id, req.computerId));
    machineId = computer?.machineId ?? null;
  }
  if (!serverId || !machineId) return null;
  setRequestTraceComputerCaller(res, { machineId, migrationId: req.params?.migrationId });
  return { serverId, machineId };
}

async function targetImportContext(
  req: { serverId?: string; machineId?: string; computerId?: string; params?: Record<string, string | undefined> },
  res: { locals?: Record<string, unknown> },
) {
  const ctx = await computerMigrationContext(req, res);
  if (!ctx) return null;
  return { serverId: ctx.serverId, targetMachineId: ctx.machineId };
}

function sendMigrationTargetImport(res: Response, view: AgentMigrationTargetImportView): void {
  res.status(200).json({ ok: true, migration: view });
}

function sendMigrationError(res: Response, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const byMessage: Record<string, { status: number; code: string; error: string }> = {
    MIGRATION_NOT_FOUND: { status: 404, code: "migration_missing", error: "Migration not found" },
    MIGRATION_NOT_READY: { status: 409, code: "migration_not_ready", error: "Migration is not ready for transfer" },
    MIGRATION_NOT_IN_PREP: { status: 409, code: "migration_not_in_prep", error: "Migration is not in prep" },
    MIGRATION_NOT_FLIPPABLE: { status: 409, code: "migration_not_flippable", error: "Migration is not ready to flip" },
    MIGRATION_NOT_ARRIVING: { status: 409, code: "migration_not_arriving", error: "Migration is not arriving" },
    MIGRATION_PREP_DEADLINE_EXPIRED: { status: 409, code: "migration_prep_deadline_expired", error: "Migration prep deadline expired" },
    MIGRATION_TRANSFER_DEADLINE_EXPIRED: { status: 409, code: "migration_transfer_deadline_expired", error: "Migration transfer deadline expired" },
    MIGRATION_ARRIVAL_DEADLINE_EXPIRED: { status: 409, code: "migration_arrival_deadline_expired", error: "Migration arrival deadline expired" },
    MIGRATION_CONCURRENT_UPDATE: { status: 409, code: "migration_concurrent_update", error: "Migration changed concurrently" },
    MIGRATION_SOURCE_MACHINE_MISMATCH: { status: 409, code: "migration_source_machine_mismatch", error: "Source machine no longer owns the agent" },
    MIGRATION_TARGET_COMPUTER_DETACHED: { status: 409, code: "migration_target_computer_detached", error: "This Computer's key was revoked; the migration failed" },
    MIGRATION_NOT_ACTIVE: { status: 409, code: "migration_not_active", error: "Migration is not active" },
    MIGRATION_TRANSFER_ENDED: { status: 410, code: "migration_transfer_ended", error: "Migration has ended; stop transferring" },
    MIGRATION_RESUMABLE_PROTOCOL_REQUIRED: { status: 409, code: "migration_resumable_protocol_required", error: "Resumable migration protocol is required" },
    MIGRATION_TRANSPORT_TOKEN_INVALID: { status: 401, code: "migration_transport_token_invalid", error: "Migration transport token is invalid" },
    MIGRATION_LEASE_EXPIRED: { status: 410, code: "migration_lease_expired", error: "Migration transfer lease expired" },
    MIGRATION_GENERATION_STALE: { status: 409, code: "migration_generation_stale", error: "Migration generation is stale" },
    MIGRATION_CANCEL_GENERATION_STALE: { status: 409, code: "migration_cancel_generation_stale", error: "Migration cancel generation is stale" },
    MIGRATION_CANCEL_NOT_REQUESTED: { status: 409, code: "migration_cancel_not_requested", error: "Migration cancellation was not requested" },
    MIGRATION_CANCEL_OUTCOME_MISMATCH: { status: 409, code: "migration_cancel_outcome_mismatch", error: "Migration cancel outcome does not match the frozen disposition" },
    MIGRATION_SOURCE_NOT_QUIESCED: { status: 409, code: "migration_source_not_quiesced", error: "Source runtime is not quiesced" },
    MIGRATION_SOURCE_QUIESCE_RECEIPT_INVALID: { status: 400, code: "migration_source_quiesce_receipt_invalid", error: "Source quiesce receipt is invalid" },
    MIGRATION_SOURCE_PROGRESS_INVALID: { status: 400, code: "migration_source_progress_invalid", error: "Source build progress is invalid" },
    MIGRATION_SOURCE_QUIESCE_RECEIPT_CONFLICT: { status: 409, code: "migration_source_quiesce_receipt_conflict", error: "Source quiesce receipt conflicts with the active generation" },
    MIGRATION_CONTROL_MANIFEST_INVALID: { status: 400, code: "migration_control_manifest_invalid", error: "Migration control manifest is invalid" },
    MIGRATION_CONTROL_MANIFEST_TOO_LARGE: { status: 413, code: "migration_control_manifest_too_large", error: "Migration control manifest exceeds its fixed budget" },
    MIGRATION_CONTROL_MANIFEST_CONFLICT: { status: 409, code: "migration_control_manifest_conflict", error: "Migration control manifest conflicts with the active generation" },
    MIGRATION_CONTROL_MANIFEST_MISSING: { status: 409, code: "migration_control_manifest_missing", error: "Migration control manifest is not registered" },
    MIGRATION_STREAMED_CHUNK_INVALID: { status: 400, code: "migration_streamed_chunk_invalid", error: "Streamed chunk is invalid" },
    MIGRATION_CHUNK_RECEIPT_MISMATCH: { status: 409, code: "migration_chunk_receipt_mismatch", error: "Migration chunk receipt does not match the active control manifest" },
    MIGRATION_CHUNK_RECEIPT_SET_MISMATCH: { status: 409, code: "migration_chunk_receipt_set_mismatch", error: "Migration chunk receipt set does not match the active control manifest" },
    MIGRATION_CHUNKS_MISSING: { status: 409, code: "migration_chunks_missing", error: "Migration chunks are still missing" },
    MIGRATION_SOURCE_WORKSPACE_ARCHIVE_FAILED: { status: 503, code: "migration_source_workspace_archive_failed", error: "Migration source workspace archival is not yet confirmed" },
    MIGRATION_SOURCE_WORKSPACE_ARCHIVE_PENDING: { status: 409, code: "migration_source_workspace_archive_pending", error: "Migration source workspace archival is not yet confirmed" },
  };
  const mapped = byMessage[message];
  if (mapped) {
    res.status(mapped.status).json({ error: mapped.error, code: mapped.code });
    return;
  }
  console.error("internal.computer.agent-migrations error:", err);
  res.status(500).json({ error: "Failed to drive migration target import", code: "migration_target_import_failed" });
}

/**
 * POST /internal/computer/preflight
 *
 * task #30 PR-A — synthetic, READ-ONLY, side-effect-free attach/login
 * preflight (RFC v0.8 §9). `raft-computer attach/login` calls this BEFORE
 * writing any local attachment state; it must never mint a credential,
 * write `agent_credentials`, create runner-lifecycle rows, or emit audit.
 *
 * The endpoint being reachable at all already proves three contract
 * properties via the existing `authFromRegistry()` dispatcher — no extra
 * logic here:
 *   - it is explicitly registered as `sk_computer` (an unregistered sibling
 *     under `/internal/computer/` fail-closes upstream with
 *     `401 auth_policy_unregistered_path`);
 *   - a wrong principal (e.g. `sk_agent_*`) fail-closes upstream with
 *     `401 invalid_principal` before reaching this handler.
 *
 * The response is derived live from `routeAuthPolicy` /
 * `CLAIMED_AUTH_POLICY_PREFIXES` so the client can verify the server's
 * surface + auth-registry + principal split are aligned, WITHOUT the server
 * keeping a parallel hand-written list that could silently drift.
 */
internalComputerRouter.post("/preflight", async (req, res) => {
  // Derived live from the registry — NOT a static list. Distinct principals
  // registered anywhere + the computer-surface route view.
  const claimedPrefixes = [...CLAIMED_AUTH_POLICY_PREFIXES];
  const registeredPrincipals = [
    ...new Set(routeAuthPolicy.map((e) => e.principal)),
  ].sort();
  const computerSurface = routeAuthPolicy
    .filter((e) => e.path.startsWith("/internal/computer/"))
    .map((e) => ({ method: e.method, path: e.path, principal: e.principal }));

  let serverSlug: string | null = null;
  if (req.serverId) {
    const db = getDb();
    const [server] = await db
      .select({ slug: servers.slug })
      .from(servers)
      .where(and(eq(servers.id, req.serverId), isNull(servers.deletedAt)));
    serverSlug = server?.slug ?? null;
  }

  res.status(200).json({
    ok: true,
    serverSlug,
    surfaceVersion: SERVER_VERSION,
    claimedPrefixes,
    registeredPrincipals,
    computerSurface,
    // Capability echo: confirms the principal split was actually enforced
    // for THIS request (set by requireComputerAuth upstream). No secrets.
    principal: {
      kind: req.principalKind ?? null,
      computerId: req.computerId ?? null,
      serverId: req.serverId ?? null,
    },
  });
});

// ---------------------------------------------------------------------------
// Device-auth PR 3c: what the Computer CLI used a person's session for, done
// with the machine's own key. Each route acts on the presenting key's own
// Computer and machine only: the machine comes from that key's live
// `computers` row, never from the request, so a key can never reach another
// machine. The Phase 1 sk_machine_* alias (requireComputerAuth sets
// req.machineId) has no `computers` row and is refused here.
// ---------------------------------------------------------------------------

type OwnComputer = { computerId: string; serverId: string; machineId: string; name: string };

/** The presenting key's own live Computer, or an answer already sent. */
async function ownComputerOrRefuse(
  req: { computerId?: string; serverId?: string; machineId?: string },
  res: Response,
): Promise<OwnComputer | null> {
  if (req.machineId) {
    res.status(403).json({
      error: "This route needs a Computer key (sk_computer_*); a legacy machine key cannot use it",
      code: "computer_key_required",
    });
    return null;
  }
  if (!req.computerId || !req.serverId) {
    res.status(500).json({ error: "Computer authentication state missing", code: "computer_binding_missing" });
    return null;
  }
  const [row] = await getDb()
    .select({ id: computers.id, serverId: computers.serverId, machineId: computers.machineId, name: computers.name })
    .from(computers)
    .where(and(eq(computers.id, req.computerId), eq(computers.serverId, req.serverId), isNull(computers.revokedAt)))
    .limit(1);
  if (!row) {
    res.status(401).json({ error: "This Computer's key was revoked", code: "computer_revoked" });
    return null;
  }
  if (!row.machineId) {
    res.status(409).json({ error: "This Computer has no machine on the server", code: "machine_binding_missing" });
    return null;
  }
  return { computerId: row.id, serverId: row.serverId, machineId: row.machineId, name: row.name };
}

const MACHINE_LOCAL_LIFECYCLE_ACTIONS: ReadonlySet<string> = new Set(["start", "stop", "restart"]);
const LIFECYCLE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /internal/computer/lifecycle-operations
 *
 * The same start/stop/restart record as POST
 * /api/servers/:id/machines/:machineId/computer-lifecycle-operations (which
 * stays for older Computers), authenticated by this Computer's own key and
 * recorded as "this machine, locally" (cause machine_local, no actor user).
 * Body: { action: start|stop|restart, operationId, parentOperationId }. A
 * `machineId` or `serverId` in the body that is not this key's own is
 * refused; upgrade (a Hands release decision) stays on the person's route.
 */
internalComputerRouter.post("/lifecycle-operations", async (req, res) => {
  try {
    const body = jsonBody(req);
    const action = body.action;
    const operationId = body.operationId;
    const parentOperationId = body.parentOperationId;
    if (typeof action !== "string" || !MACHINE_LOCAL_LIFECYCLE_ACTIONS.has(action)) {
      res.status(400).json({ error: "Unknown Computer lifecycle action", code: "unknown_action" });
      return;
    }
    if (typeof operationId !== "string" || !LIFECYCLE_UUID_RE.test(operationId)) {
      res.status(400).json({ error: "A valid operationId is required", code: "invalid_operation_id" });
      return;
    }
    if (typeof parentOperationId !== "string" || !LIFECYCLE_UUID_RE.test(parentOperationId)) {
      res.status(400).json({ error: "A valid parentOperationId is required", code: "invalid_parent_operation_id" });
      return;
    }
    if (body.targetVersion !== undefined || body.completionMode !== undefined) {
      res.status(400).json({ error: "Only start, stop and restart are recorded here", code: "invalid_target_version" });
      return;
    }
    const own = await ownComputerOrRefuse(req, res);
    if (!own) return;
    if ((body.machineId !== undefined && body.machineId !== own.machineId)
      || (body.serverId !== undefined && body.serverId !== own.serverId)) {
      res.status(403).json({ error: "A Computer records only its own lifecycle", code: "computer_machine_mismatch" });
      return;
    }
    const orchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    const routing = await handleMachineLocalRouting(
      req,
      res,
      own.machineId,
      () => orchestrator.hasMachineLocally(own.machineId),
    );
    if (routing === "handled") return;
    const connectionEpoch = routing === "confirmed_local"
      ? orchestrator.getMachineConnectionEpoch?.(own.machineId) ?? null
      : null;
    if (action === "start" && connectionEpoch) {
      res.status(409).json({ error: "Computer is already online", code: "computer_already_online" });
      return;
    }
    if (action !== "start" && !connectionEpoch) {
      res.status(409).json({ error: "Computer is not online", code: "computer_offline" });
      return;
    }
    // Under a share lock on this key's live row: a revoke (web, link, detach)
    // updates it first, so a record either commits before it or finds the key
    // revoked and writes nothing.
    const operation = await getDb().transaction(async (tx) => {
      const [live] = await tx
        .select({ id: computers.id })
        .from(computers)
        .where(and(eq(computers.id, own.computerId), isNull(computers.revokedAt)))
        .for("share");
      if (!live) return "revoked" as const;
      return createMachineLocalComputerLifecycleOperation({
        operationId,
        parentOperationId,
        serverId: own.serverId,
        machineId: own.machineId,
        action: action as "start" | "stop" | "restart",
        connectionEpochBefore: connectionEpoch,
      }, { executor: tx });
    });
    if (operation === "revoked") {
      res.status(401).json({ error: "This Computer's key was revoked", code: "computer_revoked" });
      return;
    }
    if (!operation) {
      res.status(409).json({ error: "Operation identity does not match", code: "computer_lifecycle_operation_conflict" });
      return;
    }
    addTraceEvent("operation.intent.recorded", {
      operation_id: operation.operationId,
      action,
      server_id: own.serverId,
      machine_id: own.machineId,
      dispatch_mode: "local",
      cause: "machine_local",
    });
    res.status(201).json({ operationId: operation.operationId, action });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to record the Computer lifecycle operation",
      code: "computer_lifecycle_record_failed",
      logPrefix: "[internal.computer] lifecycle-operations failed",
      err,
    });
  }
});

/**
 * GET /internal/computer/self
 *
 * How the server sees this Computer, for `raft-computer doctor`: its own row
 * and machine only, and only what doctor shows (names, ids, how many agents
 * are assigned to the machine). Nothing about other machines or people.
 */
internalComputerRouter.get("/self", async (req, res) => {
  try {
    const own = await ownComputerOrRefuse(req, res);
    if (!own) return;
    const db = getDb();
    const [machine] = await db
      .select({ name: machines.name })
      .from(machines)
      .where(and(eq(machines.id, own.machineId), eq(machines.serverId, own.serverId)))
      .limit(1);
    if (!machine) {
      res.status(409).json({ error: "This Computer has no machine on the server", code: "machine_binding_missing" });
      return;
    }
    const [count] = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(agents)
      .where(and(eq(agents.serverId, own.serverId), eq(agents.machineId, own.machineId), isNull(agents.deletedAt)));
    res.status(200).json({
      computer: {
        computerId: own.computerId,
        computerName: own.name,
        serverId: own.serverId,
        machineId: own.machineId,
        machineName: machine.name,
        agentCount: Number(count?.value) || 0,
      },
    });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to read this Computer",
      code: "computer_self_failed",
      logPrefix: "[internal.computer] self failed",
      err,
    });
  }
});

/**
 * POST /internal/computer/detach
 *
 * `raft-computer detach <server>`: this Computer revokes its own key on this
 * server, with every runner key (`sk_agent_*`) its machine minted, and their
 * connections are closed after commit (computerKeyRevocation.ts, via
 * `detach`). The machine, its agents and their history stay, as with the web
 * revoke; the machine comes back only with a new attach. It reaches nothing
 * else: no other Computer, machine or person. The Computer deletes its local
 * credential only after this answers 200.
 *
 * Gated like the web revoke by the person who attached it (routes/servers.ts
 * revoke-computer-key; Tenny, #triage:d10ace06 msg=670f6e97), or a detach from
 * the command line would get around that gate and the account deletion's:
 * someone else's live agent on the machine (as the machine's person,
 * `machines.user_id`, sees it, as on the web)
 * refuses it, 409 `others_agents_on_computer` with the same `agents` list,
 * until it is moved or the body's `forceAgentIds` names every one of them.
 * Then they are unbound and stopped (not deleted) in the revoke's transaction,
 * audited (`computer.revoke_unbound_others_agents`, via `detach`), and each
 * owner is told after commit. The list is read under the machine row lock
 * (FOR UPDATE) held until commit, so no bind lands in between
 * (computerAgents.ts lockMachineTakingAgents).
 *   { forceAgentIds?: string[] } -> { ok, computerId, machineId, unboundAgentIds }
 */
internalComputerRouter.post("/detach", async (req, res) => {
  // Whose view the 409's agent list and its notice times are in: the machine's person.
  const gate = { attacherUserId: null as string | null };
  try {
    const own = await ownComputerOrRefuse(req, res);
    if (!own) return;
    const rawForce = jsonBody(req).forceAgentIds;
    const forceAgentIds = rawForce === undefined ? [] : parseAgentIdList(rawForce);
    if (!forceAgentIds) {
      res.status(400).json({ error: "forceAgentIds must be a list of at most 200 agent ids.", code: "invalid_force_agent_ids" });
      return;
    }
    const now = currentDate();
    const outcome = await getDb().transaction(async (tx) => {
      // The machine row FOR UPDATE first, as the web revoke takes it (then the Computer row).
      const [machine] = await tx
        .select({ id: machines.id, userId: machines.userId, name: machines.name })
        .from(machines)
        .where(and(eq(machines.id, own.machineId), eq(machines.serverId, own.serverId)))
        .for("update");
      // Then the Computer row FOR UPDATE, held until commit: a revoke that takes no machine lock (the revoke
      // link, the security cascades) either commits first, and this finds the key revoked and unbinds nothing,
      // or waits for this one.
      const [live] = await tx
        .select({ id: computers.id })
        .from(computers)
        .where(and(eq(computers.id, own.computerId), isNull(computers.revokedAt)))
        .for("update");
      let unbound: OthersAgentOnMachine[] = [];
      // A key revoked meanwhile is refused below whatever is on the machine.
      if (machine && live) {
        // "Other people's" as the machine's person sees it (`machines.user_id`), the same rule as the web revoke,
        // even for a legacy machine an admin adopted (whose Computer's attached_by_user_id is the admin).
        gate.attacherUserId = machine.userId;
        unbound = await unbindForcedOthersAgents(tx, { machineId: machine.id, attacherUserId: machine.userId, forceAgentIds, now });
      }
      const operationId = newAuditOperationId();
      if (unbound.length > 0) {
        await recordIntegrationAuditEvent({
          serverId: own.serverId,
          eventType: "computer.revoke_unbound_others_agents",
          outcome: "success",
          // Asked by the Computer itself with its own key, never by a person: the actor is that Computer (a
          // system actor whose id is the Computer's; the audit actor kinds have no machine kind), so the record
          // does not read as the machine's person having done it.
          source: "cli",
          actor: { type: "system", id: own.computerId },
          requester: null,
          target: { type: "machine", id: own.machineId },
          metadata: { agentIds: unbound.map((agent) => agent.id), machineId: own.machineId, computerId: own.computerId, via: "detach", ...serverAuditContextMetadata({ operationId }) },
        }, tx);
      }
      const result = await revokeComputerKeyInTransaction(tx, { computerId: own.computerId, by: { via: "detach" }, now, operationId });
      return {
        result,
        unbound: unbound.map((agent) => ({ agentId: agent.id, ownerUserId: agent.owner?.id ?? null })),
        computerName: machine?.name ?? own.name,
      };
    });
    const { result } = outcome;
    if (!result?.revoked) {
      // Revoked by something else between auth and here: the key is dead, its
      // cascade ran with that revoke (this call repaired anything still live).
      if (result) await closeDeviceSessionKeys(result.reach);
      res.status(401).json({ error: "This Computer's key was revoked", code: "computer_revoked" });
      return;
    }
    await closeDeviceSessionKeys(result.reach);
    const io = req.app.get("io") as SocketServer | undefined;
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    await noticeOwnersOfDetachedComputer(io, agentOrchestrator, result.detached);
    // The agents unbound by force are no longer on the machine: their owners are told here.
    for (const agent of outcome.unbound) {
      agentOrchestrator?.evictCache(agent.agentId);
      if (!agent.ownerUserId || !io || !agentOrchestrator) continue;
      await postAgentActionRequiredNotice(io, agentOrchestrator, {
        agentId: agent.agentId,
        ownerUserId: agent.ownerUserId,
        notice: { kind: "computer_detached", computerName: outcome.computerName },
      }).catch((err) => console.warn("[internal.computer] unbound agent notice failed", { agentId: agent.agentId, err: serializeErrorForLog(err) }));
    }
    io?.to(`server:${own.serverId}`).emit("machine:updated", {
      serverId: own.serverId,
      machineId: own.machineId,
    });
    res.status(200).json({ ok: true, computerId: own.computerId, machineId: own.machineId, unboundAgentIds: outcome.unbound.map((agent) => agent.agentId) });
  } catch (err) {
    if (err instanceof OthersAgentsOnComputerError && gate.attacherUserId) {
      res.status(409).json({
        error: "Other people's agents run on this computer. Ask their owners to move them first, or name them to unbind them.",
        code: "others_agents_on_computer",
        agents: await withOwnerNotifyTimes(gate.attacherUserId, err.agents, currentDate().getTime()),
      });
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to detach this Computer",
      code: "computer_detach_failed",
      logPrefix: "[internal.computer] detach failed",
      err,
    });
  }
});

/**
 * GET /internal/computer/agent-migrations/by-id/:migrationId
 *
 * Target import view. The authenticated target Computer can resolve the
 * migration id once server ownership and target-machine binding match.
 */
internalComputerRouter.get("/agent-migrations/by-id/:migrationId", async (req, res) => {
  try {
    const ctx = await targetImportContext(req, res);
    if (!ctx) {
      res.status(500).json({ error: "Computer machine binding missing", code: "machine_binding_missing" });
      return;
    }
    const view = await getAgentMigrationTargetImport({
      migrationId: req.params.migrationId,
      serverId: ctx.serverId,
      targetMachineId: ctx.targetMachineId,
    });
    sendMigrationTargetImport(res, view);
  } catch (err) {
    sendMigrationError(res, err);
  }
});

internalComputerRouter.post("/agent-migrations/by-id/:migrationId/transport-lost", async (req, res) => {
  try {
    const ctx = await computerMigrationContext(req, res);
    if (!ctx) {
      res.status(500).json({ error: "Computer machine binding missing", code: "machine_binding_missing" });
      return;
    }
    const body = jsonBody(req);
    const code = typeof body.code === "string"
      && AGENT_MIGRATION_TRANSPORT_FAILURE_CODES.has(body.code as AgentMigrationTransportFailureCode)
      ? body.code as AgentMigrationTransportFailureCode
      : "MIGRATION_TRANSPORT_LOST";
    const message = typeof body.message === "string" && body.message.length > 0
      ? body.message.slice(0, 500)
      : null;
    // Newer daemons also send the unfiltered cause; older ones only send `code`.
    const detailCode = typeof body.detailCode === "string"
      && AGENT_MIGRATION_TRANSPORT_DETAIL_CODE_PATTERN.test(body.detailCode)
      ? body.detailCode
      : null;
    const transportGeneration = typeof body.transportGeneration === "string" && body.transportGeneration.length <= 200
      ? body.transportGeneration
      : null;
    const orchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    // The reporter is connected (it is sending this); as the source its
    // capabilities pick the next step a size failure's receipt offers.
    const reporterTransport = await orchestrator?.getMachineMigrationTransport(ctx.machineId);
    const migration = await markAgentMigrationTransportLostForComputer({
      migrationId: req.params.migrationId,
      serverId: ctx.serverId,
      machineId: ctx.machineId,
      code,
      detailCode,
      transportGeneration,
      message,
      reporterMigrationCapabilities: reporterTransport?.capabilities ?? null,
    });
    await emitAgentMigrationUpdated(req.app.get("io") as SocketServer | undefined, migration);
    if (agentMigrationSizeFailureNeedsConfigPush(migration)) {
      // The size failure is in the agent's migrationReadiness now (its config
      // revision moved with the failure). Best effort: a later start carries it too.
      try {
        await orchestrator?.applyAgentConfig(migration.agentId);
      } catch (err) {
        addTraceEvent("server.agent.migration_readiness_push_failed", {
          agent_id: migration.agentId,
          migration_id: migration.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    res.status(200).json({
      ok: true,
      migration: {
        id: migration.id,
        state: migration.state,
        failureReason: migration.failureReason,
        transportErrorCode: migration.transportErrorCode,
      },
    });
  } catch (err) {
    sendMigrationError(res, err);
  }
});

internalComputerRouter.post("/agent-migrations/by-id/:migrationId/cancel-ack", async (req, res) => {
  try {
    const ctx = await computerMigrationContext(req, res);
    if (!ctx) {
      res.status(500).json({ error: "Computer machine binding missing", code: "machine_binding_missing" });
      return;
    }
    const body = jsonBody(req);
    const migrationRef = requiredString(body, "migrationRef");
    const transportGeneration = requiredString(body, "transportGeneration");
    const cancelGeneration = requiredString(body, "cancelGeneration");
    const role = body.role === "source" || body.role === "target" ? body.role : null;
    const outcome = body.outcome === "cleaned" || body.outcome === "stopped" || body.outcome === "needs_attention"
      ? body.outcome
      : null;
    if (!migrationRef || !transportGeneration || !cancelGeneration || !role || !outcome) {
      res.status(400).json({
        error: "migrationRef, transportGeneration, cancelGeneration, role, and outcome are required",
        code: "migration_cancel_ack_input_required",
      });
      return;
    }
    const migration = await acknowledgeAgentMigrationCancellation({
      migrationId: req.params.migrationId,
      migrationRef,
      transportGeneration,
      cancelGeneration,
      serverId: ctx.serverId,
      machineId: ctx.machineId,
      role,
      outcome,
      errorCode: typeof body.errorCode === "string" ? body.errorCode.slice(0, 100) : null,
      errorMessage: typeof body.errorMessage === "string" ? body.errorMessage.slice(0, 500) : null,
    });
    await emitAgentMigrationUpdated(req.app.get("io") as SocketServer | undefined, migration);
    res.status(200).json({
      ok: true,
      migration: {
        migrationRef: migration.supportRef,
        state: migration.state,
        revision: migration.revision,
        disposition: migration.cancelDisposition,
      },
    });
  } catch (err) {
    sendMigrationError(res, err);
  }
});

internalComputerRouter.post("/agent-migrations/by-id/:migrationId/resumable/source-quiesced", async (req, res) => {
  try {
    const ctx = await computerMigrationContext(req, res);
    const token = migrationTransportToken(req);
    if (!ctx || !token) {
      res.status(token ? 500 : 401).json({ error: token ? "Computer machine binding missing" : "Migration transport token missing", code: token ? "machine_binding_missing" : "migration_transport_token_missing" });
      return;
    }
    const body = jsonBody(req);
    const receipt = body.receipt;
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
      res.status(400).json({ error: "receipt is required", code: "migration_source_quiesce_receipt_required" });
      return;
    }
    const migration = await recordAgentMigrationSourceQuiesced({
      migrationId: req.params.migrationId,
      serverId: ctx.serverId,
      sourceMachineId: ctx.machineId,
      transportToken: token,
      receipt: receipt as AgentMigrationSourceQuiesceReceipt,
    });
    await emitAgentMigrationUpdated(req.app.get("io") as SocketServer | undefined, migration);
    res.status(200).json({ ok: true, migrationGeneration: migration.transportGeneration, leaseId: migration.transportLeaseId });
  } catch (err) {
    sendMigrationError(res, err);
  }
});

internalComputerRouter.post("/agent-migrations/by-id/:migrationId/resumable/source-progress", async (req, res) => {
  try {
    const ctx = await computerMigrationContext(req, res);
    const token = migrationTransportToken(req);
    if (!ctx || !token) {
      res.status(token ? 500 : 401).json({ error: token ? "Computer machine binding missing" : "Migration transport token missing", code: token ? "machine_binding_missing" : "migration_transport_token_missing" });
      return;
    }
    const recorded = await recordAgentMigrationSourceBuildProgress({
      migrationId: req.params.migrationId,
      serverId: ctx.serverId,
      sourceMachineId: ctx.machineId,
      transportToken: token,
      report: jsonBody(req),
    });
    res.status(200).json({
      ok: true,
      advanced: recorded.advanced,
      prepDeadlineAt: recorded.migration.prepDeadlineAt.toISOString(),
    });
  } catch (err) {
    sendMigrationError(res, err);
  }
});

internalComputerRouter.post("/agent-migrations/by-id/:migrationId/resumable/control", async (req, res) => {
  try {
    const ctx = await computerMigrationContext(req, res);
    const token = migrationTransportToken(req);
    if (!ctx || !token) {
      res.status(token ? 500 : 401).json({ error: token ? "Computer machine binding missing" : "Migration transport token missing", code: token ? "machine_binding_missing" : "migration_transport_token_missing" });
      return;
    }
    const control = jsonBody(req).control;
    if (!control || typeof control !== "object" || Array.isArray(control)) {
      res.status(400).json({ error: "control is required", code: "migration_control_manifest_required" });
      return;
    }
    const registered = await registerAgentMigrationControlManifest({
      migrationId: req.params.migrationId,
      serverId: ctx.serverId,
      sourceMachineId: ctx.machineId,
      transportToken: token,
      control: control as AgentMigrationControlManifest,
    });
    await emitAgentMigrationUpdated(
      req.app.get("io") as SocketServer | undefined,
      registered.migration,
    );
    res.status(200).json({
      ok: true,
      controlSha256: registered.controlSha256,
      missingChunkIndexes: registered.missingChunkIndexes,
    });
  } catch (err) {
    sendMigrationError(res, err);
  }
});

internalComputerRouter.get("/agent-migrations/by-id/:migrationId/resumable/control", async (req, res) => {
  try {
    const ctx = await computerMigrationContext(req, res);
    const token = migrationTransportToken(req);
    const role = req.query.role === "source" || req.query.role === "target" ? req.query.role : null;
    if (!ctx || !token || !role) {
      res.status(!token ? 401 : !role ? 400 : 500).json({ error: !token ? "Migration transport token missing" : !role ? "role is required" : "Computer machine binding missing", code: !token ? "migration_transport_token_missing" : !role ? "migration_role_required" : "machine_binding_missing" });
      return;
    }
    const result = await getAgentMigrationResumableControl({
      migrationId: req.params.migrationId,
      serverId: ctx.serverId,
      machineId: ctx.machineId,
      role,
      transportToken: token,
    });
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    sendMigrationError(res, err);
  }
});

internalComputerRouter.get("/agent-migrations/by-id/:migrationId/resumable/chunks", async (req, res) => {
  try {
    const ctx = await computerMigrationContext(req, res);
    const token = migrationTransportToken(req);
    const role = req.query.role === "source" || req.query.role === "target" ? req.query.role : null;
    const cursor = req.query.cursor === undefined ? undefined : Number(req.query.cursor);
    if (!ctx || !token || !role || (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0))) {
      res.status(!token ? 401 : !role || cursor !== undefined ? 400 : 500).json({ error: !token ? "Migration transport token missing" : !role ? "role is required" : cursor !== undefined ? "cursor is invalid" : "Computer machine binding missing", code: !token ? "migration_transport_token_missing" : !role ? "migration_role_required" : cursor !== undefined ? "migration_cursor_invalid" : "machine_binding_missing" });
      return;
    }
    const plan = await planAgentMigrationChunkTransfers({
      migrationId: req.params.migrationId,
      serverId: ctx.serverId,
      machineId: ctx.machineId,
      role,
      transportToken: token,
      cursor,
    });
    res.status(200).json({ ok: true, ...plan });
  } catch (err) {
    sendMigrationError(res, err);
  }
});

// Streamed bundles: the source asks for an upload URL for each chunk as soon
// as it is packed, before the control manifest exists.
internalComputerRouter.post("/agent-migrations/by-id/:migrationId/resumable/stream-chunks/:chunkIndex", async (req, res) => {
  try {
    const ctx = await computerMigrationContext(req, res);
    const token = migrationTransportToken(req);
    const body = jsonBody(req);
    const migrationGeneration = requiredString(body, "migrationGeneration");
    const leaseId = requiredString(body, "leaseId");
    const sha256 = requiredString(body, "sha256");
    if (!ctx || !token || !migrationGeneration || !leaseId || !sha256) {
      res.status(!token ? 401 : 400).json({ error: !token ? "Migration transport token missing" : "Streamed chunk is invalid", code: !token ? "migration_transport_token_missing" : "migration_streamed_chunk_invalid" });
      return;
    }
    const result = await prepareAgentMigrationStreamedChunk({
      migrationId: req.params.migrationId,
      serverId: ctx.serverId,
      sourceMachineId: ctx.machineId,
      transportToken: token,
      migrationGeneration,
      leaseId,
      chunkIndex: Number(req.params.chunkIndex),
      sizeBytes: body.sizeBytes as number,
      sha256,
    });
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    sendMigrationError(res, err);
  }
});

internalComputerRouter.post("/agent-migrations/by-id/:migrationId/resumable/chunks/:chunkIndex/receipt", async (req, res) => {
  try {
    const ctx = await computerMigrationContext(req, res);
    const token = migrationTransportToken(req);
    const body = jsonBody(req);
    const role = body.role === "source" || body.role === "target" ? body.role : null;
    const chunkIndex = Number(req.params.chunkIndex);
    const migrationGeneration = requiredString(body, "migrationGeneration");
    const leaseId = requiredString(body, "leaseId");
    const sha256 = requiredString(body, "sha256");
    const sizeBytes = body.sizeBytes;
    if (!ctx || !token || !role || !migrationGeneration || !leaseId || !sha256 || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || !Number.isSafeInteger(sizeBytes) || (sizeBytes as number) <= 0) {
      res.status(!token ? 401 : 400).json({ error: !token ? "Migration transport token missing" : "Chunk receipt is invalid", code: !token ? "migration_transport_token_missing" : "migration_chunk_receipt_invalid" });
      return;
    }
    const result = await recordAgentMigrationChunkReceipt({
      migrationId: req.params.migrationId,
      serverId: ctx.serverId,
      machineId: ctx.machineId,
      role,
      transportToken: token,
      migrationGeneration,
      leaseId,
      chunkIndex,
      sizeBytes: sizeBytes as number,
      sha256,
      etag: typeof body.etag === "string" ? body.etag.slice(0, 256) : null,
    });
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    sendMigrationError(res, err);
  }
});

internalComputerRouter.post("/agent-migrations/by-id/:migrationId/resumable/upload-complete", async (req, res) => {
  try {
    const ctx = await computerMigrationContext(req, res);
    const token = migrationTransportToken(req);
    const body = jsonBody(req);
    const migrationGeneration = requiredString(body, "migrationGeneration");
    const leaseId = requiredString(body, "leaseId");
    const controlSha256 = requiredString(body, "controlSha256");
    if (!ctx || !token || !migrationGeneration || !leaseId || !controlSha256) {
      res.status(!token ? 401 : 400).json({ error: !token ? "Migration transport token missing" : "Upload completion is invalid", code: !token ? "migration_transport_token_missing" : "migration_upload_completion_invalid" });
      return;
    }
    const migration = await completeAgentMigrationResumableUpload({
      migrationId: req.params.migrationId,
      serverId: ctx.serverId,
      sourceMachineId: ctx.machineId,
      transportToken: token,
      migrationGeneration,
      leaseId,
      controlSha256,
    });
    await emitAgentMigrationUpdated(req.app.get("io") as SocketServer | undefined, migration);
    res.status(200).json({ ok: true, state: migration.state, manifestSha256: migration.manifestSha256 });
  } catch (err) {
    sendMigrationError(res, err);
  }
});

// Target-side steps (start import, flip, arrived). Only the authenticated
// target Computer may drive them; every call echoes the current
// migrationGeneration and receives the next one back.
internalComputerRouter.post("/agent-migrations/by-id/:migrationId/start-transfer", async (req, res) => {
  try {
    const ctx = await targetImportContext(req, res);
    if (!ctx) {
      res.status(500).json({ error: "Computer machine binding missing", code: "machine_binding_missing" });
      return;
    }
    const migrationGeneration = requiredString(jsonBody(req), "migrationGeneration");
    if (!migrationGeneration) {
      res.status(400).json({ error: "migrationGeneration is required", code: "migration_generation_required" });
      return;
    }
    const view = await startAgentMigrationTargetImport({
      migrationId: req.params.migrationId,
      migrationGeneration,
      serverId: ctx.serverId,
      targetMachineId: ctx.targetMachineId,
    });
    await emitAgentMigrationUpdatedByRef(req.app.get("io") as SocketServer | undefined, ctx.serverId, view.migrationRef);
    sendMigrationTargetImport(res, view);
  } catch (err) {
    sendMigrationError(res, err);
  }
});

internalComputerRouter.post("/agent-migrations/by-id/:migrationId/flip-machine", async (req, res) => {
  try {
    const ctx = await targetImportContext(req, res);
    if (!ctx) {
      res.status(500).json({ error: "Computer machine binding missing", code: "machine_binding_missing" });
      return;
    }
    const migrationGeneration = requiredString(jsonBody(req), "migrationGeneration");
    if (!migrationGeneration) {
      res.status(400).json({ error: "migrationGeneration is required", code: "migration_generation_required" });
      return;
    }
    const view = await flipAgentMigrationTargetImport({
      migrationId: req.params.migrationId,
      migrationGeneration,
      serverId: ctx.serverId,
      targetMachineId: ctx.targetMachineId,
    });
    // The flip revoked the source's runner credentials: close their open streams.
    await broadcastAgentCredentialRevocation(view.agentId);
    await emitAgentMigrationUpdatedByRef(req.app.get("io") as SocketServer | undefined, ctx.serverId, view.migrationRef);
    // task #1357 item 1: another Computer: the Raft-defaults signal changes.
    await (req.app.get("agentOrchestrator") as AgentOrchestrator | undefined)?.notifyModelLimitsChanged?.({ agentIds: [view.agentId] });
    sendMigrationTargetImport(res, view);
  } catch (err) {
    sendMigrationError(res, err);
  }
});

internalComputerRouter.post("/agent-migrations/by-id/:migrationId/arrived", async (req, res) => {
  try {
    const ctx = await targetImportContext(req, res);
    if (!ctx) {
      res.status(500).json({ error: "Computer machine binding missing", code: "machine_binding_missing" });
      return;
    }
    const body = jsonBody(req);
    const migrationGeneration = requiredString(body, "migrationGeneration");
    if (!migrationGeneration) {
      res.status(400).json({ error: "migrationGeneration is required", code: "migration_generation_required" });
      return;
    }
    const reportPath = body.reportPath === undefined || body.reportPath === null ? null : requiredString(body, "reportPath");
    const reportSha256 = body.reportSha256 === undefined || body.reportSha256 === null ? null : requiredString(body, "reportSha256");
    if (body.reportPath !== undefined && body.reportPath !== null && !reportPath) {
      res.status(400).json({ error: "reportPath must be a non-empty string", code: "report_path_invalid" });
      return;
    }
    if (body.reportSha256 !== undefined && body.reportSha256 !== null && !reportSha256) {
      res.status(400).json({ error: "reportSha256 must be a non-empty string", code: "report_sha256_invalid" });
      return;
    }
    const orchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    const arrivalStartedAt = currentDate();
    const current = await assertAgentMigrationTargetArrivalArchivable({
      migrationId: req.params.migrationId,
      migrationGeneration,
      serverId: ctx.serverId,
      targetMachineId: ctx.targetMachineId,
      now: arrivalStartedAt,
    });
    const archiveConfirmedAt = currentDate();
    let arrivalGeneration = current.migrationGeneration;
    const archive = await archiveMigrationSourceWorkspace(orchestrator, current);
    if (archive.ok) {
      const archived = await recordAgentMigrationSourceWorkspaceArchived({
        migrationId: req.params.migrationId,
        migrationGeneration: current.migrationGeneration,
        serverId: ctx.serverId,
        targetMachineId: ctx.targetMachineId,
        now: archiveConfirmedAt,
      });
      arrivalGeneration = archived.migrationGeneration;
    } else {
      // The flip already committed: the agent belongs to the target. Leave the
      // source copy to the background retry instead of failing the migration.
      await recordAgentMigrationSourceArchiveAttemptFailed({
        migrationId: current.migrationId,
        errorCode: archive.errorCode,
        now: archiveConfirmedAt,
      });
    }
    const arrival = await markAgentMigrationTargetImportArrived({
      migrationId: req.params.migrationId,
      migrationGeneration: arrivalGeneration,
      serverId: ctx.serverId,
      targetMachineId: ctx.targetMachineId,
      reportPath,
      reportSha256,
      now: archiveConfirmedAt,
    });
    const arrived = arrival.migration;
    const io = req.app.get("io") as SocketServer | undefined;
    await emitAgentMigrationUpdatedByRef(io, ctx.serverId, arrived.migrationRef);
    if (arrival.autoStart !== "dispatch") {
      sendMigrationTargetImport(res, arrived);
      return;
    }

    if (!orchestrator || typeof orchestrator.startAgent !== "function") {
      const failed = await recordAgentMigrationAutoStartFailure({
        migrationId: arrived.migrationId,
        agentId: arrived.agentId,
        targetMachineId: arrived.targetMachineId,
        stage: "orchestrator",
        code: "orchestrator_unavailable",
      });
      await emitAgentMigrationUpdatedByRef(io, ctx.serverId, arrived.migrationRef);
      sendMigrationTargetImport(res, {
        ...arrived,
        state: failed.state,
        migrationGeneration: `agent_migration:${failed.id}:${failed.revision}`,
      });
      return;
    }

    let completedView: AgentMigrationTargetImportView;
    try {
      const startResult = await orchestrator.startAgent(arrived.agentId);
      if (startResult.outcome !== "dispatched") {
        const failed = await recordAgentMigrationAutoStartFailure({
          migrationId: arrived.migrationId,
          agentId: arrived.agentId,
          targetMachineId: arrived.targetMachineId,
          stage: "start_agent",
          code: "start_not_dispatched",
        });
        await emitAgentMigrationUpdatedByRef(io, ctx.serverId, arrived.migrationRef);
        sendMigrationTargetImport(res, {
          ...arrived,
          state: failed.state,
          migrationGeneration: `agent_migration:${failed.id}:${failed.revision}`,
        });
        return;
      }
      const completed = await completeAgentMigrationAutoStart({
        migrationId: arrived.migrationId,
        agentId: arrived.agentId,
        targetMachineId: arrived.targetMachineId,
      });
      await emitAgentMigrationUpdatedByRef(io, ctx.serverId, arrived.migrationRef);
      completedView = {
        ...arrived,
        state: completed.state,
        migrationGeneration: `agent_migration:${completed.id}:${completed.revision}`,
      };
    } catch (err) {
      console.error("internal.computer.agent-migrations auto-start error:", err);
      const failed = await recordAgentMigrationAutoStartFailure({
        migrationId: arrived.migrationId,
        agentId: arrived.agentId,
        targetMachineId: arrived.targetMachineId,
        stage: "start_agent",
        code: "start_threw",
      });
      await emitAgentMigrationUpdatedByRef(io, ctx.serverId, arrived.migrationRef);
      sendMigrationTargetImport(res, {
        ...arrived,
        state: failed.state,
        migrationGeneration: `agent_migration:${failed.id}:${failed.revision}`,
      });
      return;
    }
    sendMigrationTargetImport(res, completedView);
  } catch (err) {
    sendMigrationError(res, err);
  }
});

/**
 * GET /internal/computer/runners
 *
 * task #30 PR-C (RFC v0.8 §12) — list the runners on the Computer's
 * bound server.
 *
 * §12 CONTROL-PLANE WHITELIST IS ENFORCED HERE, SERVER-SIDE. The drizzle
 * SELECT projects ONLY the safe control-plane fields below; the raw
 * `agents` row is never loaded and never serialized. This is
 * defense-in-depth, NOT a client-side filter: even a tampered/forged
 * client cannot make the server emit `sessionId`, `envVars`,
 * `description`, internal ids, etc. — they are not in the query at all.
 * Adding a field here is the ONLY way to widen the surface, which makes
 * the whitelist auditable in one place.
 *
 * Always the authenticated machine's runners. `scope=server` (sent by
 * `raft-computer runners list --all`) is still accepted but no longer widens the
 * list to every agent on the server (#proj-raft-computer:8e6a4629).
 */
const RUNNER_LIST_WHITELIST = ["agentId", "name", "status", "model", "runtime"] as const;

internalComputerRouter.get("/runners", async (req, res) => {
  try {
    const serverId = req.serverId;
    if (!serverId) {
      res.status(500).json({ error: "Computer authentication state missing" });
      return;
    }
    const scope = typeof req.query.scope === "string" ? req.query.scope : null;
    if (scope && scope !== "machine" && scope !== "server") {
      res.status(400).json({ error: "Invalid runners scope", code: "invalid_scope" });
      return;
    }
    const db = getDb();
    let machineId: string | null = req.machineId ?? null;
    if (!machineId) {
      if (!req.computerId) {
        res.status(500).json({ error: "Computer authentication state missing", code: "computer_binding_missing" });
        return;
      }
      const [computer] = await db
        .select({ machineId: computers.machineId })
        .from(computers)
        .where(eq(computers.id, req.computerId));
      machineId = computer?.machineId ?? null;
    }
    if (!machineId) {
      res.status(500).json({ error: "Computer machine binding missing", code: "machine_binding_missing" });
      return;
    }
    const conditions = [
      eq(agents.serverId, serverId),
      isNull(agents.deletedAt),
      eq(agents.machineId, machineId as string),
    ];
    // Projection IS the whitelist. No `select()` of the whole row, ever.
    const rows = await db
      .select({
        agentId: agents.id,
        name: agents.name,
        status: agents.status,
        model: agents.model,
        runtime: agents.runtime,
      })
      .from(agents)
      .where(and(...conditions));

    res.status(200).json({
      // Echo the whitelist so the client (and the regression test) can
      // assert the server's surface contract without a parallel list.
      whitelist: [...RUNNER_LIST_WHITELIST],
      runners: rows,
    });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to list runners",
      logPrefix: "internal.computer.runners.list error:",
      err,
    });
  }
});

/**
 * POST /internal/computer/runners/:agentId/stop
 *
 * task #30 PR-C (RFC v0.8 §12) — Computer-initiated control-plane stop
 * of one of its runners. Server-mediated: reuses the existing
 * orchestrator stop path (which signals the daemon over its WS), so the
 * Computer CLI stays thin and cross-platform with no local IPC.
 *
 * Cross-server isolation is THIS handler's responsibility (same shape as
 * the credential-mint handler): a Computer attached to server A cannot
 * stop server B's agent — same 404 `agent_missing` (no existence leak).
 * The stop itself is idempotent (orchestrator.stopAgent no-ops on an
 * unknown / already-stopped agent).
 */
internalComputerRouter.post("/runners/:agentId/stop", async (req, res) => {
  try {
    const context = await computerMigrationContext(req, res);
    const serverId = context?.serverId;
    if (!context || !serverId) {
      res.status(500).json({ error: "Computer authentication state missing" });
      return;
    }
    const targetAgentId = req.params.agentId;
    const db = getDb();
    const [agentRow] = await db
      .select({ id: agents.id, serverId: agents.serverId, machineId: agents.machineId })
      .from(agents)
      .where(and(eq(agents.id, targetAgentId), isNull(agents.deletedAt)));
    if (!agentRow || agentRow.serverId !== serverId || agentRow.machineId !== context.machineId) {
      // Uniform 404 — never leak whether another server's agent exists.
      res.status(404).json({ error: "Agent not found", code: "agent_missing" });
      return;
    }

    const orchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    if (!orchestrator || typeof orchestrator.stopAgent !== "function") {
      res.status(503).json({ error: "Orchestrator unavailable", code: "orchestrator_unavailable" });
      return;
    }
    await orchestrator.stopAgent(targetAgentId, "manual");
    res.status(200).json({ ok: true, agentId: targetAgentId });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to stop runner",
      logPrefix: "internal.computer.runners.stop error:",
      err,
    });
  }
});

/**
 * POST /internal/computer/runners/:agentId/credentials
 *
 * RFC v0.8 — Computer-requested runner credential mint.
 *
 * The Computer host (authenticated via sk_computer_*) requests a fresh
 * `sk_agent_*` credential for an agent it will run locally as a runner.
 * The agent MUST belong to the Computer's bound server.
 *
 * Body: { scopes?: AgentCapability[], name?: string | null }
 *   - scopes: subset of ALLOWED_AGENT_CAPABILITIES. Defaults to all.
 *   - name:   human label for the credential (e.g. "computer-Maria-runner-claude").
 *
 * Response 201: { credentialId, apiKey, scopes, agentId, agentName, serverId, expiresAt }
 *   - expiresAt: ISO time, 7 days out, when the calling Machine's daemon
 *     declared `runner-credential-renew:v1`; null (never expires) otherwise.
 *   - apiKey is the raw `sk_agent_*` key, returned exactly once. The
 *     Computer host MUST store it in its private credential store and
 *     never log it.
 *
 * Errors:
 *   404 agent_missing               — agent not found OR cross-server
 *   400 scopes_invalid              — any value outside the v0 enum
 *   400 scopes_empty                — empty after normalization
 *   400 name_invalid                — name is non-string / too long
 *   500                             — unexpected
 */
/**
 * What a Computer may put on an `sk_agent_*` it mints (Tenny,
 * #proj-raft-computer:8e6a4629): exactly what the daemon asks for
 * (RUNNER_CREDENTIAL_SCOPES): the external-agent default plus `server` and `mcp`.
 * Role checks still run live on every call, so `server` lets an admin agent
 * edit the server and nothing more for a member agent. Never `raftbench`.
 * Also the default when the request names no scopes.
 */
export const COMPUTER_MINTABLE_AGENT_CAPABILITIES = [
  "send",
  "read",
  "mentions",
  "tasks",
  "reactions",
  "server",
  "channels",
  "knowledge",
  "mcp",
] as const satisfies readonly AgentCapability[];
const COMPUTER_MINTABLE_AGENT_CAPABILITY_SET: ReadonlySet<AgentCapability> = new Set(COMPUTER_MINTABLE_AGENT_CAPABILITIES);

internalComputerRouter.post("/runners/:agentId/credentials", async (req, res) => {
  try {
    const computerId = req.computerId;
    const context = await computerMigrationContext(req, res);
    const serverId = context?.serverId;
    if (!computerId || !context || !serverId) {
      // Should never happen — auth middleware sets both. Belt + suspenders.
      res.status(500).json({ error: "Computer authentication state missing" });
      return;
    }

    // Verify the target agent belongs to this Computer’s current machine.
    // The mint primitive does an `agents.deletedAt IS NULL` check internally,
    // but cross-server isolation is THIS handler's responsibility.
    const targetAgentId = req.params.agentId;
    const db = getDb();
    const [agentRow] = await db
      .select({ id: agents.id, serverId: agents.serverId, machineId: agents.machineId })
      .from(agents)
      .where(and(eq(agents.id, targetAgentId), isNull(agents.deletedAt)));
    if (!agentRow) {
      res.status(404).json({ error: "Agent not found", code: "agent_missing" });
      return;
    }
    if (agentRow.serverId !== serverId || agentRow.machineId !== context.machineId) {
      // Same 404 shape as agent_missing — don't leak existence of other
      // servers' agents to a Computer attached to a different server.
      res.status(404).json({ error: "Agent not found", code: "agent_missing" });
      return;
    }

    const body = (req.body ?? {}) as { scopes?: unknown; name?: unknown };

    let scopes: AgentCapability[];
    if (body.scopes === undefined) {
      scopes = [...COMPUTER_MINTABLE_AGENT_CAPABILITIES];
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
      const beyondCeiling = scopes.filter((scope) => !COMPUTER_MINTABLE_AGENT_CAPABILITY_SET.has(scope));
      if (beyondCeiling.length > 0) {
        res.status(403).json({
          error: `A Computer may issue only: ${COMPUTER_MINTABLE_AGENT_CAPABILITIES.join(", ")}`,
          code: "scope_not_allowed_for_computer",
        });
        return;
      }
    }

    let name: string | null = null;
    if (body.name !== undefined && body.name !== null) {
      if (typeof body.name !== "string" || body.name.length === 0 || body.name.length > 200) {
        res.status(400).json({
          error: "name must be a non-empty string up to 200 chars",
          code: "name_invalid",
        });
        return;
      }
      name = body.name;
    }

    // Under a share lock on this Computer's live row: revoking a device login's
    // session revokes the key (UPDATE computers) before the credentials its
    // holder minted, so a mint in flight either commits first and is revoked
    // with them, or finds the key revoked here. The credential carries the
    // family holding the key now (deviceSessionKeys.ts). The sk_machine_*
    // alias (requireComputerAuth sets req.machineId) has no computers row,
    // and no device session issued its key: it mints as before, unfenced.
    // #wg-rbac:#27: a daemon that renews gets a key that expires; any other
    // gets one that never does, as before. Read from the Machine's current
    // connection on any replica (its `ready` capabilities).
    const expiresAt = runnerCredentialExpiresAt(await machineDeclaresRunnerCredentialRenew(req, context.machineId));
    const minted = await db.transaction(async (tx) => {
      let familyId: string | null = null;
      // Only requireComputerAuth's sk_machine_* branch sets req.machineId, so
      // branch on that, never on "no live computers row": a sk_computer_* key
      // revoked mid-mint must still answer computer_revoked below, or it would
      // mint a credential with no family that the revoke cascade misses.
      if (!req.machineId) {
        const [key] = await tx
          .select({ familyId: computers.keyIssuedBySessionFamilyId })
          .from(computers)
          .where(and(eq(computers.id, computerId), isNull(computers.revokedAt)))
          .for("share");
        if (!key) return null;
        familyId = key.familyId;
      }
      return mintAgentCredential({
        agentId: targetAgentId,
        scopes,
        name,
        // No person issued it; the minting Machine is recorded instead (the
        // agent's current Machine, checked above).
        issuedVia: "computer",
        issuedByMachineId: context.machineId,
        issuedBySessionFamilyId: familyId,
        createdByUserId: null,
        expiresAt,
      }, { executor: tx });
    });
    if (!minted) {
      res.status(401).json({ error: "This Computer's key was revoked", code: "computer_revoked" });
      return;
    }

    res.status(201).json({
      credentialId: minted.credentialId,
      // Raw sk_agent_* key — returned exactly once.
      apiKey: minted.apiKey,
      scopes: minted.scopes,
      agentId: minted.agentId,
      agentName: minted.agentName,
      serverId: minted.serverId,
      // ISO time it stops authenticating; null: never (a daemon that does not renew).
      expiresAt: minted.expiresAt?.toISOString() ?? null,
    });
  } catch (err) {
    if (err instanceof Error && err.message === "agent_missing") {
      res.status(404).json({ error: "Agent not found", code: "agent_missing" });
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to mint runner credential", logPrefix: "internal.computer.runners.credentials.mint error:", err });
  }
});

/** Whether the Machine's daemon declared `runner-credential-renew:v1` on its current connection (any replica). */
async function machineDeclaresRunnerCredentialRenew(req: Request, machineId: string): Promise<boolean> {
  const orchestrator = req.app.get("agentOrchestrator") as Partial<AgentOrchestrator> | undefined;
  if (typeof orchestrator?.machineAdvertisesCapability !== "function") return false;
  return orchestrator.machineAdvertisesCapability(machineId, DAEMON_CAPABILITY_RUNNER_CREDENTIAL_RENEW_V1);
}

/** Renewals one Machine may ask for per minute (per replica). A daemon renews each runner key about every 3.5 days. */
export const RUNNER_CREDENTIAL_RENEW_RATE_LIMIT_PER_MINUTE = 60;
let runnerCredentialRenewRateLimit = RUNNER_CREDENTIAL_RENEW_RATE_LIMIT_PER_MINUTE;
/** Tests only: set the per-minute renewal limit (null restores the default). */
export function __setRunnerCredentialRenewRateLimitForTests(limit: number | null): void {
  runnerCredentialRenewRateLimit = limit ?? RUNNER_CREDENTIAL_RENEW_RATE_LIMIT_PER_MINUTE;
}
// replica-local: abuse guard only, per-replica budget is acceptable. Keyed by
// the authenticated Computer (the Machine is resolved in the handler; the key
// is the same Machine's), never by IP.
const runnerCredentialRenewLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: () => runnerCredentialRenewRateLimit,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  keyGenerator: (req) => `renew:${req.machineId ?? req.computerId ?? "unknown"}`,
  handler: rateLimitRefusal(
    "runner_credential_renew_rate_limited",
    "This Computer asked to renew runner credentials too often: wait, then renew again.",
  ),
});

const RUNNER_CREDENTIAL_RENEW_REFUSALS: Record<RunnerCredentialRenewRefusal, { status: RefusalStatus; error: string }> = {
  agent_missing: { status: 404, error: "Agent not found, or it is not on this Computer." },
  credential_missing: { status: 404, error: "No such credential of this agent: mint a new runner credential instead." },
  credential_not_runner: { status: 403, error: "Only a runner credential a Computer minted can be renewed: mint a new one instead." },
  credential_not_issued_by_this_computer: { status: 403, error: "This Computer did not issue this credential: mint a new runner credential instead." },
  credential_revoked: { status: 409, error: "This credential was revoked and is never renewed: mint a new runner credential instead." },
  renew_window_passed: { status: 409, error: "This credential expired more than 7 days ago and can no longer be renewed: mint a new runner credential instead." },
  already_renewed: { status: 409, error: "This credential was already renewed once: mint a new runner credential instead." },
};
const RUNNER_CREDENTIAL_RENEW_REFUSAL_CODES: Record<RunnerCredentialRenewRefusal, string> = {
  agent_missing: "agent_missing",
  credential_missing: "credential_missing",
  credential_not_runner: "credential_not_runner",
  credential_not_issued_by_this_computer: "credential_not_issued_by_this_computer",
  credential_revoked: "runner_credential_revoked",
  renew_window_passed: "runner_credential_renew_window_passed",
  already_renewed: "runner_credential_already_renewed",
};

/**
 * POST /internal/computer/runners/:agentId/credentials/renew
 *
 * #wg-rbac:#27 — a Computer renews a runner credential it minted, before it
 * expires or after a 401 `agent_credential_expired`. Authenticated by the
 * Computer's own key (the same as the mint), never by the old agent key.
 *
 * Body: { credentialId } — the credential to renew.
 *
 * Response 201: { credentialId, apiKey, expiresAt, scopes, agentId, replacedCredentialId, replacedExpiresAt }
 *   - apiKey: the new raw `sk_agent_*`, returned exactly once; expiresAt: ISO,
 *     7 days out. The old key is not revoked: it keeps working until
 *     replacedExpiresAt (at most 5 minutes out), then answers
 *     `agent_credential_expired`.
 *
 * Errors (every one: the daemon mints a new runner credential instead):
 *   400 credential_id_invalid                    — no credentialId in the body
 *   404 agent_missing                            — agent gone, other server, or not on this Machine
 *   403 runner_credential_renew_not_declared     — the daemon did not declare runner-credential-renew:v1
 *   404 credential_missing                       — no such credential of this agent
 *   403 credential_not_runner                    — not a Computer's runner credential
 *   403 credential_not_issued_by_this_computer   — another Machine's
 *   409 runner_credential_revoked                — revoked: never renewed
 *   409 runner_credential_renew_window_passed    — expired more than 7 days ago
 *   409 runner_credential_already_renewed        — renewed before; nothing new is issued
 *   401 computer_revoked                         — the Computer's key was revoked mid-renewal
 *   429 runner_credential_renew_rate_limited     — more than 60 a minute from this Machine
 */
internalComputerRouter.post("/runners/:agentId/credentials/renew", runnerCredentialRenewLimiter);
internalComputerRouter.post("/runners/:agentId/credentials/renew", async (req, res) => {
  try {
    const computerId = req.computerId;
    const context = await computerMigrationContext(req, res);
    if (!computerId || !context) {
      res.status(500).json({ error: "Computer authentication state missing" });
      return;
    }
    const credentialId = requiredString(jsonBody(req), "credentialId");
    if (!credentialId) {
      refuse(res, 400, { code: "credential_id_invalid", error: "The renewal needs the credentialId of the runner credential to renew." });
      return;
    }
    if (!await machineDeclaresRunnerCredentialRenew(req, context.machineId)) {
      refuse(res, 403, {
        code: "runner_credential_renew_not_declared",
        error: "This Computer's daemon did not declare runner credential renewal on its current connection: mint a new runner credential instead.",
      });
      return;
    }

    // As the mint: under a share lock on this Computer's live row, so a device
    // login's revoke either sees the new key (and revokes it with the rest)
    // or this sees the key revoked; the new key carries the family holding the
    // Computer's key now. The sk_machine_* alias has no computers row.
    const renewal = await getDb().transaction(async (tx) => {
      let familyId: string | null = null;
      if (!req.machineId) {
        const [key] = await tx
          .select({ familyId: computers.keyIssuedBySessionFamilyId })
          .from(computers)
          .where(and(eq(computers.id, computerId), isNull(computers.revokedAt)))
          .for("share");
        if (!key) return null;
        familyId = key.familyId;
      }
      return renewRunnerCredential({
        agentId: req.params.agentId,
        serverId: context.serverId,
        machineId: context.machineId,
        credentialId,
        issuedBySessionFamilyId: familyId,
      }, { executor: tx });
    });
    if (!renewal) {
      refuse(res, 401, { code: "computer_revoked", error: "This Computer's key was revoked, so it can no longer renew runner credentials." });
      return;
    }
    if (!renewal.ok) {
      const refusal = RUNNER_CREDENTIAL_RENEW_REFUSALS[renewal.refusal];
      refuse(res, refusal.status, { code: RUNNER_CREDENTIAL_RENEW_REFUSAL_CODES[renewal.refusal], error: refusal.error });
      return;
    }
    res.status(201).json({
      credentialId: renewal.credentialId,
      // Raw sk_agent_* key — returned exactly once.
      apiKey: renewal.apiKey,
      expiresAt: renewal.expiresAt.toISOString(),
      scopes: renewal.scopes,
      agentId: req.params.agentId,
      replacedCredentialId: renewal.replacedCredentialId,
      replacedExpiresAt: renewal.replacedExpiresAt.toISOString(),
    });
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to renew runner credential", logPrefix: "internal.computer.runners.credentials.renew error:", err });
  }
});

/**
 * POST /internal/computer/runners/:agentId/provider-connection
 *
 * Materializes the exact provider assignment only for the Computer currently
 * hosting the Agent. The ordinary agent:start payload remains credential-free.
 */
internalComputerRouter.post("/runners/:agentId/provider-connection", async (req, res) => {
  try {
    const context = await computerMigrationContext(req, res);
    if (!context) {
      res.status(500).json({ error: "Computer authentication state missing" });
      return;
    }
    if (!await isProviderConnectionsEnabled(context.serverId)) {
      res.status(404).json({
        error: "Provider connections are not enabled for this server",
        code: "provider_connections_disabled",
      });
      return;
    }
    const body = jsonBody(req);
    if (Object.keys(body).length !== 1 || typeof body.connectionId !== "string" || !body.connectionId) {
      res.status(400).json({ error: "connectionId is required", code: "provider_connection_invalid" });
      return;
    }

    const targetAgentId = req.params.agentId;
    const [agentRow] = await getDb()
      .select({ id: agents.id })
      .from(agents)
      .where(and(
        eq(agents.id, targetAgentId),
        eq(agents.serverId, context.serverId),
        eq(agents.machineId, context.machineId),
        isNull(agents.deletedAt),
      ));
    if (!agentRow) {
      res.status(404).json({ error: "Agent not found", code: "agent_missing" });
      return;
    }

    const launch = await resolveProviderConnectionLaunch({
      serverId: context.serverId,
      agentId: targetAgentId,
      connectionId: body.connectionId,
    });
    res.status(200).json(launch);
  } catch (error) {
    if (error instanceof ProviderConnectionError) {
      // The try-block locals are not visible here, so derive the observability
      // context straight from the request.
      const failure = providerConnectionLaunchFailureResponse(error, {
        serverId: req.serverId ?? "",
        connectionId: typeof req.body?.connectionId === "string" ? req.body.connectionId : "",
        agentId: req.params.agentId,
      });
      res.status(failure.status).json(failure.body);
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to materialize provider connection", logPrefix: "internal.computer.runners.provider-connection error:", err: error });
  }
});

/**
 * POST /internal/computer/probes/:probeId/materialize
 *
 * One-time, machine-authenticated materialization for a probe claim. The
 * machine command never carries credentials; this endpoint is the only place
 * a probe sees them, and the intent's claim column group makes it exactly
 * once per carrier (same claimant may retry inside the lease).
 */
internalComputerRouter.post("/probes/:probeId/materialize", async (req, res) => {
  try {
    const context = await computerMigrationContext(req, res);
    if (!context) {
      res.status(500).json({ error: "Computer authentication state missing" });
      return;
    }
    if (!await isProviderProbesEnabled(context.serverId)) {
      res.status(404).json({ error: "Provider probes are not enabled for this server", code: "probe_disabled" });
      return;
    }
    const probeId = req.params.probeId;
    if (!isProviderProbeId(probeId)) {
      res.status(400).json({ error: "Provider probe id is invalid", code: "probe_invalid" });
      return;
    }
    const body = jsonBody(req);
    if (Object.keys(body).length !== 1 || typeof body.claimRequestId !== "string" || !body.claimRequestId) {
      res.status(400).json({ error: "claimRequestId is required", code: "probe_invalid" });
      return;
    }
    const orchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    const fact = await orchestrator?.readProbeCarrierFact(context.machineId) ?? null;
    const payload = await materializeProviderProbe({
      serverId: context.serverId,
      probeId,
      machineId: context.machineId,
      claimRequestId: body.claimRequestId,
      fact,
    });
    res.status(200).json(payload);
  } catch (error) {
    if (error instanceof ProviderProbeError) {
      const status = error.code === "probe_not_found" || error.code === "probe_disabled"
        ? 404
        : error.code === "probe_invalid"
          ? 400
          : error.code === "probe_expired"
            ? 410
            : 409;
      res.status(status).json({ error: error.message, code: error.code });
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to materialize probe", logPrefix: "internal.computer.probes.materialize error:", err: error });
  }
});

/**
 * DELETE /internal/computer/runners/:agentId/credentials/:credentialId
 *
 * Managed-runner launch cleanup. External/bootstrap credentials can be
 * long-lived, but Computer-minted managed-runner credentials are bound to the
 * runner launch lifecycle and should be revoked when that launch stops/exits.
 */
internalComputerRouter.delete("/runners/:agentId/credentials/:credentialId", async (req, res) => {
  try {
    const context = await computerMigrationContext(req, res);
    const serverId = context?.serverId;
    if (!context || !serverId) {
      res.status(500).json({ error: "Computer authentication state missing" });
      return;
    }
    const [agent] = await getDb().select({ id: agents.id }).from(agents).where(and(
      eq(agents.id, req.params.agentId), eq(agents.serverId, serverId),
      eq(agents.machineId, context.machineId), isNull(agents.deletedAt),
    ));
    if (!agent) {
      res.status(404).json({ error: "Agent not found", code: "agent_missing" });
      return;
    }
    const outcome = await revokeAgentCredentialWithOutcome({
      credentialId: req.params.credentialId,
      agentId: req.params.agentId,
      serverId,
      reason: "managed_runner_launch_ended",
      issuedByMachineId: context.machineId,
    });
    if (outcome === null) {
      res.status(404).json({ error: "Credential not found", code: "credential_missing" });
      return;
    }
    if (outcome === "not_issued_by_machine") {
      // Human, app, provision and other Machines' credentials of this agent
      // stay valid. Daemons send this DELETE once and only trace the status,
      // so a distinct code is enough for them not to retry.
      res.status(403).json({
        error: "This Computer did not issue this credential",
        code: "credential_not_issued_by_this_computer",
      });
      return;
    }
    await broadcastAgentCredentialRevocation(req.params.agentId);
    res.status(204).end();
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to revoke runner credential",
      logPrefix: "internal.computer.runners.credentials.revoke error:",
      err,
    });
  }
});

/**
 * Launch-failure mapping for the provider materialization exit. The
 * enforcement-blocked case keeps its own response code AND a structured log
 * line so the post-flip 24h monitor can count it separately from generic
 * unavailability (Cardy P1 on the flip runbook).
 */
export function providerConnectionLaunchFailureResponse(
  error: ProviderConnectionError,
  context: { serverId: string; connectionId: string; agentId: string },
): { status: number; body: { error: string; code: string } } {
  if (error.code === "provider_connection_key_missing") {
    return { status: 503, body: { error: "Provider connection is unavailable", code: "provider_connection_key_missing" } };
  }
  if (error.code === "provider_connection_unverified") {
    console.warn("[provider-probe] launch blocked: no fresh Computer verification", {
      serverId: context.serverId,
      connectionId: context.connectionId,
      agentId: context.agentId,
      code: error.code,
    });
    return { status: 409, body: { error: "Provider connection lacks a fresh Computer verification", code: "provider_connection_unverified" } };
  }
  return { status: 409, body: { error: "Provider connection is unavailable", code: "provider_connection_unavailable" } };
}
