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

import { Router, type Response, type Router as RouterType } from "express";
import type { Server as SocketServer } from "socket.io";
import {
  AGENT_MIGRATION_TERMINAL_FAILURE_CODES,
  agentMigrationTransferSummarySchema,
  currentDate,
  type AgentMigrationControlManifest,
  type AgentMigrationSourceQuiesceReceipt,
} from "@botiverse/raft-shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { agents, computers, servers } from "../db/schema.js";
import {
  ALLOWED_AGENT_CAPABILITIES,
  mintAgentCredential,
  normalizeAgentCapabilities,
  revokeAgentCredential,
  type AgentCapability,
} from "../services/agentCredentialService.js";
import {
  ProviderConnectionError,
  resolveProviderConnectionLaunch,
} from "../services/providerConnectionService.js";
import { isProviderConnectionsEnabled } from "../services/providerConnectionFeature.js";
import {
  validateAgentO11yBatch,
  type AgentO11yAcceptedEvent,
} from "../services/agentO11yValidation.js";
import {
  AgentO11yWriterUnavailableError,
  getAgentO11yScopeDbWriter,
} from "../services/agentO11yScopeDbWriter.js";
// task #30 PR-A: preflight derives its principal/path view DIRECTLY from the
// live auth registry — never a copied/static `EXPECTED_PRINCIPALS` list. A
// registry gap therefore fails preflight and real auth identically (the
// fake-unregistered-path test is the regression form of that invariant).
import {
  routeAuthPolicy,
  CLAIMED_AUTH_POLICY_PREFIXES,
} from "../middleware/routeAuthPolicy.js";
import { SERVER_VERSION } from "../version.js";
import type { AgentOrchestrator } from "../services/agentOrchestrator.js";
import {
  acknowledgeAgentMigrationCancellation,
  assertAgentMigrationTargetArrivalArchivable,
  completeAgentMigrationAutoStart,
  completeAgentMigrationResumableUpload,
  flipAgentMigrationTargetImport,
  getAgentMigrationTargetImport,
  getAgentMigrationTargetImportById,
  getAgentMigrationResumableControl,
  markAgentMigrationSourceReadyForComputer,
  markAgentMigrationTransportLostForComputer,
  markAgentMigrationTargetImportArrived,
  planAgentMigrationChunkTransfers,
  recordAgentMigrationChunkReceipt,
  recordAgentMigrationSourceWorkspaceArchived,
  recordAgentMigrationSourceQuiesced,
  registerAgentMigrationControlManifest,
  recordAgentMigrationAutoStartFailure,
  startAgentMigrationTargetImport,
  type AgentMigrationTransportFailureCode,
  type AgentMigrationTargetImportView,
} from "../services/agentMigrationService.js";
import {
  emitAgentMigrationUpdated,
  emitAgentMigrationUpdatedByRef,
} from "../services/agentMigrationRealtime.js";

export const internalComputerRouter: RouterType = Router();

const AGENT_MIGRATION_TRANSPORT_FAILURE_CODES: ReadonlySet<AgentMigrationTransportFailureCode> =
  new Set(AGENT_MIGRATION_TERMINAL_FAILURE_CODES);

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

async function computerMigrationContext(req: { serverId?: string; machineId?: string; computerId?: string }) {
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
  return { serverId, machineId };
}

async function targetImportContext(req: { serverId?: string; machineId?: string; computerId?: string }) {
  const ctx = await computerMigrationContext(req);
  if (!ctx) return null;
  return { serverId: ctx.serverId, targetMachineId: ctx.machineId };
}

function sendMigrationTargetImport(res: Response, view: AgentMigrationTargetImportView): void {
  res.status(200).json({ ok: true, migration: view });
}

async function archiveMigrationSourceWorkspace(
  orchestrator: AgentOrchestrator | undefined,
  migration: AgentMigrationTargetImportView,
): Promise<void> {
  if (
    !orchestrator
    || typeof orchestrator.archiveAgentMigrationSourceWorkspace !== "function"
  ) {
    throw new Error("MIGRATION_SOURCE_WORKSPACE_ARCHIVE_FAILED");
  }
  try {
    await orchestrator.archiveAgentMigrationSourceWorkspace(migration.sourceMachineId, {
      migrationId: migration.migrationId,
      agentId: migration.agentId,
    });
  } catch (error) {
    console.error("internal.computer.agent-migrations source archive error:", error);
    throw new Error("MIGRATION_SOURCE_WORKSPACE_ARCHIVE_FAILED");
  }
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
    MIGRATION_NOT_ACTIVE: { status: 409, code: "migration_not_active", error: "Migration is not active" },
    MIGRATION_RESUMABLE_PROTOCOL_REQUIRED: { status: 409, code: "migration_resumable_protocol_required", error: "Resumable migration protocol is required" },
    MIGRATION_TRANSPORT_TOKEN_INVALID: { status: 401, code: "migration_transport_token_invalid", error: "Migration transport token is invalid" },
    MIGRATION_LEASE_EXPIRED: { status: 410, code: "migration_lease_expired", error: "Migration transfer lease expired" },
    MIGRATION_GENERATION_STALE: { status: 409, code: "migration_generation_stale", error: "Migration generation is stale" },
    MIGRATION_CANCEL_GENERATION_STALE: { status: 409, code: "migration_cancel_generation_stale", error: "Migration cancel generation is stale" },
    MIGRATION_CANCEL_NOT_REQUESTED: { status: 409, code: "migration_cancel_not_requested", error: "Migration cancellation was not requested" },
    MIGRATION_CANCEL_OUTCOME_MISMATCH: { status: 409, code: "migration_cancel_outcome_mismatch", error: "Migration cancel outcome does not match the frozen disposition" },
    MIGRATION_SOURCE_NOT_QUIESCED: { status: 409, code: "migration_source_not_quiesced", error: "Source runtime is not quiesced" },
    MIGRATION_SOURCE_QUIESCE_RECEIPT_INVALID: { status: 400, code: "migration_source_quiesce_receipt_invalid", error: "Source quiesce receipt is invalid" },
    MIGRATION_SOURCE_QUIESCE_RECEIPT_CONFLICT: { status: 409, code: "migration_source_quiesce_receipt_conflict", error: "Source quiesce receipt conflicts with the active generation" },
    MIGRATION_CONTROL_MANIFEST_INVALID: { status: 400, code: "migration_control_manifest_invalid", error: "Migration control manifest is invalid" },
    MIGRATION_CONTROL_MANIFEST_TOO_LARGE: { status: 413, code: "migration_control_manifest_too_large", error: "Migration control manifest exceeds its fixed budget" },
    MIGRATION_CONTROL_MANIFEST_CONFLICT: { status: 409, code: "migration_control_manifest_conflict", error: "Migration control manifest conflicts with the active generation" },
    MIGRATION_CONTROL_MANIFEST_MISSING: { status: 409, code: "migration_control_manifest_missing", error: "Migration control manifest is not registered" },
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

/**
 * GET /internal/computer/agent-migrations/by-id/:migrationId
 *
 * E2E/live driver and product-safe target handoff surface. Agent-facing
 * migration begin/status routes expose migration id, not the bearer-like
 * grant key. The authenticated target Computer can resolve that id to the
 * target import view once server ownership and target-machine binding match.
 */
internalComputerRouter.get("/agent-migrations/by-id/:migrationId", async (req, res) => {
  try {
    const ctx = await targetImportContext(req);
    if (!ctx) {
      res.status(500).json({ error: "Computer machine binding missing", code: "machine_binding_missing" });
      return;
    }
    const view = await getAgentMigrationTargetImportById({
      migrationId: req.params.migrationId,
      serverId: ctx.serverId,
      targetMachineId: ctx.targetMachineId,
    });
    sendMigrationTargetImport(res, view);
  } catch (err) {
    sendMigrationError(res, err);
  }
});

internalComputerRouter.post("/agent-migrations/by-id/:migrationId/source-ready", async (req, res) => {
  try {
    const ctx = await computerMigrationContext(req);
    if (!ctx) {
      res.status(500).json({ error: "Computer machine binding missing", code: "machine_binding_missing" });
      return;
    }
    const body = jsonBody(req);
    const manifestPath = requiredString(body, "manifestPath");
    if (!manifestPath) {
      res.status(400).json({ error: "manifestPath is required", code: "manifest_path_required" });
      return;
    }
    const manifestSha256 = body.manifestSha256 === undefined || body.manifestSha256 === null
      ? null
      : requiredString(body, "manifestSha256");
    if (body.manifestSha256 !== undefined && body.manifestSha256 !== null && !manifestSha256) {
      res.status(400).json({ error: "manifestSha256 must be a non-empty string", code: "manifest_sha_invalid" });
      return;
    }
    const transferSummary = agentMigrationTransferSummarySchema.safeParse(body.transferSummary);
    if (!transferSummary.success) {
      res.status(400).json({
        error: "transferSummary must contain bounded pathless migration counts",
        code: "migration_transfer_summary_invalid",
      });
      return;
    }
    const migration = await markAgentMigrationSourceReadyForComputer({
      migrationId: req.params.migrationId,
      serverId: ctx.serverId,
      sourceMachineId: ctx.machineId,
      manifestPath,
      manifestSha256,
      transferSummary: transferSummary.data,
    });
    await emitAgentMigrationUpdated(req.app.get("io") as SocketServer | undefined, migration);
    res.status(200).json({
      ok: true,
      migration: {
        id: migration.id,
        state: migration.state,
        manifestPath: migration.manifestPath,
        manifestSha256: migration.manifestSha256,
      },
    });
  } catch (err) {
    sendMigrationError(res, err);
  }
});

internalComputerRouter.post("/agent-migrations/by-id/:migrationId/transport-lost", async (req, res) => {
  try {
    const ctx = await computerMigrationContext(req);
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
    const migration = await markAgentMigrationTransportLostForComputer({
      migrationId: req.params.migrationId,
      serverId: ctx.serverId,
      machineId: ctx.machineId,
      code,
      message,
    });
    await emitAgentMigrationUpdated(req.app.get("io") as SocketServer | undefined, migration);
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
    const ctx = await computerMigrationContext(req);
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
    const ctx = await computerMigrationContext(req);
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

internalComputerRouter.post("/agent-migrations/by-id/:migrationId/resumable/control", async (req, res) => {
  try {
    const ctx = await computerMigrationContext(req);
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
    const ctx = await computerMigrationContext(req);
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
    const ctx = await computerMigrationContext(req);
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

internalComputerRouter.post("/agent-migrations/by-id/:migrationId/resumable/chunks/:chunkIndex/receipt", async (req, res) => {
  try {
    const ctx = await computerMigrationContext(req);
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
    const ctx = await computerMigrationContext(req);
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

/**
 * GET /internal/computer/agent-migrations/:grantKey
 *
 * task #124 — target-side import/adopt read surface. Only the authenticated
 * target Computer may see or drive the grant. The response carries the
 * current server generation; every mutating callback must echo that exact
 * generation and receives the next one back.
 */
internalComputerRouter.get("/agent-migrations/:grantKey", async (req, res) => {
  try {
    const ctx = await targetImportContext(req);
    if (!ctx) {
      res.status(500).json({ error: "Computer machine binding missing", code: "machine_binding_missing" });
      return;
    }
    const view = await getAgentMigrationTargetImport({
      grantKey: req.params.grantKey,
      serverId: ctx.serverId,
      targetMachineId: ctx.targetMachineId,
    });
    sendMigrationTargetImport(res, view);
  } catch (err) {
    sendMigrationError(res, err);
  }
});

internalComputerRouter.post("/agent-migrations/:grantKey/start-transfer", async (req, res) => {
  try {
    const ctx = await targetImportContext(req);
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
      grantKey: req.params.grantKey,
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

internalComputerRouter.post("/agent-migrations/:grantKey/flip-machine", async (req, res) => {
  try {
    const ctx = await targetImportContext(req);
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
      grantKey: req.params.grantKey,
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

internalComputerRouter.post("/agent-migrations/:grantKey/arrived", async (req, res) => {
  try {
    const ctx = await targetImportContext(req);
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
      grantKey: req.params.grantKey,
      migrationGeneration,
      serverId: ctx.serverId,
      targetMachineId: ctx.targetMachineId,
      now: arrivalStartedAt,
    });
    await archiveMigrationSourceWorkspace(orchestrator, current);
    const archiveConfirmedAt = currentDate();
    const archived = await recordAgentMigrationSourceWorkspaceArchived({
      grantKey: req.params.grantKey,
      migrationGeneration: current.migrationGeneration,
      serverId: ctx.serverId,
      targetMachineId: ctx.targetMachineId,
      now: archiveConfirmedAt,
    });
    const arrival = await markAgentMigrationTargetImportArrived({
      grantKey: req.params.grantKey,
      migrationGeneration: archived.migrationGeneration,
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
        grantKey: arrived.grantKey,
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
          grantKey: arrived.grantKey,
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
        grantKey: arrived.grantKey,
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
        grantKey: arrived.grantKey,
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
 * Default scoping is the authenticated machine. `scope=server` is the
 * explicit legacy/server-wide view used by `raft-computer runners list --all`.
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
    const serverWide = scope === "server";
    if (scope && scope !== "machine" && scope !== "server") {
      res.status(400).json({ error: "Invalid runners scope", code: "invalid_scope" });
      return;
    }
    const db = getDb();
    let machineId: string | null = req.machineId ?? null;
    if (!serverWide && !machineId) {
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
    if (!serverWide && !machineId) {
      res.status(500).json({ error: "Computer machine binding missing", code: "machine_binding_missing" });
      return;
    }
    const conditions = [
      eq(agents.serverId, serverId),
      isNull(agents.deletedAt),
      ...(serverWide ? [] : [eq(agents.machineId, machineId as string)]),
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
    console.error("internal.computer.runners.list error:", err);
    res.status(500).json({ error: "Failed to list runners" });
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
    const context = await computerMigrationContext(req);
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
    console.error("internal.computer.runners.stop error:", err);
    res.status(500).json({ error: "Failed to stop runner" });
  }
});

/**
 * POST /internal/computer/agent-o11y/events
 *
 * Agent observability v0 rev 3.2 — daemon-mediated event ingest. The daemon
 * sends validated local events, but the server remains authoritative:
 * tenant identity is derived from the authenticated Computer principal and
 * PII/carrier invariants are rechecked before writing to ScopeDB.
 */
internalComputerRouter.post("/agent-o11y/events", async (req, res) => {
  try {
    const serverId = req.serverId;
    const computerId = req.computerId;
    if (!serverId || !computerId) {
      res.status(500).json({
        ok: false,
        code: "agent_o11y_auth_state_missing",
        message: "Computer authentication state missing",
      });
      return;
    }

    const validation = validateAgentO11yBatch(req.body);
    if (!validation.ok) {
      res.status(validation.status).json({
        ok: false,
        code: validation.code,
        message: validation.message,
      });
      return;
    }

    // Same boundary as runner mint/stop/revoke: a Computer may only report on
    // agents bound to its own machine, not any agent on the server.
    const ctx = await computerMigrationContext(req);
    const membership = ctx
      ? await verifyAgentO11yAgentsOnMachine(validation.events, ctx)
      : { ok: false as const };
    if (!membership.ok) {
      res.status(403).json({
        ok: false,
        code: "agent_o11y_agent_not_in_server",
        message: "event agent does not belong to the authenticated Computer's machine",
      });
      return;
    }

    const writer = getAgentO11yScopeDbWriter(req.app);
    const result = await writer.writeEvents(validation.events, {
      server_id: serverId,
      computer_id: computerId,
      machine_id: req.machineId ?? null,
    });

    res.status(202).json({ ok: true, accepted: result.accepted });
  } catch (err) {
    if (err instanceof AgentO11yWriterUnavailableError) {
      res.status(503).json({ ok: false, code: err.code, message: err.message });
      return;
    }
    console.error("internal.computer.agent-o11y.events error:", err);
    res.status(500).json({
      ok: false,
      code: "agent_o11y_internal_error",
      message: "Failed to ingest agent observability events",
    });
  }
});

async function verifyAgentO11yAgentsOnMachine(
  events: readonly AgentO11yAcceptedEvent[],
  ctx: { serverId: string; machineId: string },
): Promise<{ ok: true } | { ok: false }> {
  const agentIds = [...new Set(events.map((event) => event.agent_id))];
  if (agentIds.length === 0) return { ok: true };

  const rows = await getDb()
    .select({ id: agents.id })
    .from(agents)
    .where(and(
      inArray(agents.id, agentIds),
      eq(agents.serverId, ctx.serverId),
      eq(agents.machineId, ctx.machineId),
      isNull(agents.deletedAt),
    ));
  return rows.length === agentIds.length ? { ok: true } : { ok: false };
}

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
 * Response 201: { credentialId, apiKey, scopes, agentId, agentName, serverId }
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
internalComputerRouter.post("/runners/:agentId/credentials", async (req, res) => {
  try {
    const computerId = req.computerId;
    const context = await computerMigrationContext(req);
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

    const minted = await mintAgentCredential({
      agentId: targetAgentId,
      scopes,
      name,
      // Audit lineage for sk_computer_* mints lives on the credential row
      // via `created_by_user_id = null` + the implicit `apiKeyPrefix` →
      // (future) Computer attachment cross-reference. Slice-1 keeps the
      // user audit column null; Phase 1 can add `created_by_computer_id`
      // alongside Tao's reshape.
      createdByUserId: null,
    });

    res.status(201).json({
      credentialId: minted.credentialId,
      // Raw sk_agent_* key — returned exactly once.
      apiKey: minted.apiKey,
      scopes: minted.scopes,
      agentId: minted.agentId,
      agentName: minted.agentName,
      serverId: minted.serverId,
    });
  } catch (err) {
    if (err instanceof Error && err.message === "agent_missing") {
      res.status(404).json({ error: "Agent not found", code: "agent_missing" });
      return;
    }
    console.error("internal.computer.runners.credentials.mint error:", err);
    res.status(500).json({ error: "Failed to mint runner credential" });
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
    const context = await computerMigrationContext(req);
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
      res.status(error.code === "provider_connection_key_missing" ? 503 : 409).json({
        error: "Provider connection is unavailable",
        code: "provider_connection_unavailable",
      });
      return;
    }
    console.error("internal.computer.runners.provider-connection error:", error);
    res.status(500).json({ error: "Failed to materialize provider connection" });
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
    const context = await computerMigrationContext(req);
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
    const ok = await revokeAgentCredential({
      credentialId: req.params.credentialId,
      agentId: req.params.agentId,
      serverId,
      reason: "managed_runner_launch_ended",
    });
    if (!ok) {
      res.status(404).json({ error: "Credential not found", code: "credential_missing" });
      return;
    }
    res.status(204).end();
  } catch (err) {
    console.error("internal.computer.runners.credentials.revoke error:", err);
    res.status(500).json({ error: "Failed to revoke runner credential" });
  }
});
