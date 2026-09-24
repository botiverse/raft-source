import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  AGENT_MIGRATION_BUNDLE_CONTENT_TYPE,
  AGENT_MIGRATION_COMMIT_MARKER_PATH,
  AGENT_MIGRATION_CONTROL_SCHEMA_VERSION,
  AGENT_MIGRATION_MAX_ARCHIVE_ENTRIES,
  AGENT_MIGRATION_MAX_CHUNKS,
  AGENT_MIGRATION_MAX_CONTROL_MANIFEST_BYTES,
  AGENT_MIGRATION_MIN_CHUNK_BYTES,
  AGENT_MIGRATION_RESUMABLE_CAPABILITIES,
  AGENT_MIGRATION_RESUMABLE_PROTOCOL,
  MAX_AGENT_MIGRATION_TRANSPORT_BYTES,
  agentMigrationTransferSummarySchema,
  currentDate,
  type AgentMigrationControlManifest,
  type AgentMigrationSourceQuiesceReceipt,
  type AgentMigrationTerminalFailureCode,
  type AgentMigrationTransferSummary,
  type AgentMigrationUpdatedPayload,
  type ServerToMachineMessage,
} from "@botiverse/raft-shared";
import { getDb, isDatabaseInitialized, type DatabaseExecutor } from "../db/index.js";
import {
  agentMigrationChunkReceipts,
  agentMigrationReceiptChannels,
  agentMigrations,
  agentRuntimeProfiles,
  agents,
  channelAgents,
  channels,
  machines,
} from "../db/schema.js";
import { createAgentLifecycleEvent, type AgentLifecycleEvent, type AgentLifecycleEventType, type AgentLifecycleReason } from "./agentLifecycleEvents.js";
import {
  enqueueAgentMigrationCanceledReceipt,
  enqueueAgentMigrationCompletedReceipt,
  enqueueAgentMigrationFailedReceipt,
  type AgentMigrationReceiptEnqueueHooks,
} from "./agentMigrationReceiptService.js";
import { getStorage, type StorageBackend } from "./storageService.js";

export type AgentMigrationRow = typeof agentMigrations.$inferSelect;
export type AgentMigrationState = AgentMigrationRow["state"];
export type AgentMigrationTransportFailureCode = AgentMigrationTerminalFailureCode;

export const ACTIVE_AGENT_MIGRATION_STATES = [
  "provisioning",
  "prep",
  "ready",
  "in_transit",
  "arriving",
  "starting",
] as const;
export type ActiveAgentMigrationState = typeof ACTIVE_AGENT_MIGRATION_STATES[number];
const TRANSFER_ACTIVE_AGENT_MIGRATION_STATES = [
  "provisioning",
  "prep",
  "ready",
  "in_transit",
  "arriving",
  "starting",
] as const satisfies readonly ActiveAgentMigrationState[];
export type AgentMigrationCancelDisposition = NonNullable<AgentMigrationRow["cancelDisposition"]>;
export type AgentMigrationCancelRole = "source" | "target";
export type AgentMigrationCancelMessage = Extract<ServerToMachineMessage, { type: "machine:migration:cancel" }>;
export interface AgentMigrationCancellationRequestResult {
  migration: AgentMigrationRow;
  disposition: AgentMigrationCancelDisposition;
  dispatch: "required" | "none";
}
export type AgentMigrationCancelCleanupExecutor = "server" | "healthy_steward";
export type AgentMigrationAutoStartFailureStage = "orchestrator" | "start_agent" | "legacy";
export type AgentMigrationAutoStartFailureCode =
  | "orchestrator_unavailable"
  | "start_not_dispatched"
  | "start_threw"
  | "legacy_auto_start_failed";
export interface AgentMigrationCancellationCleanupClaim {
  migration: AgentMigrationRow;
  dispatch: "required" | "none";
  leaseId: string | null;
  deliveries: Array<{ machineId: string; message: AgentMigrationCancelMessage }>;
}
export type AgentMigrationAutoStartRemediationExecutor = "server" | "healthy_steward";
export type AgentMigrationAutoStartRemediationCandidateVariant = "typed_failed" | "orphaned_dispatch";
export interface AgentMigrationAutoStartRemediationClaim {
  migration: AgentMigrationRow;
  action: "dispatch" | "terminal";
  leaseId: string | null;
  candidateVariant: AgentMigrationAutoStartRemediationCandidateVariant;
}
export const AGENT_MIGRATION_CANCEL_MAX_DISPATCH_ATTEMPTS = 3;
export const AGENT_MIGRATION_CANCEL_ATTENTION_WINDOW_MS = 2 * 60 * 1000;
export const AGENT_MIGRATION_CANCEL_CLEANUP_LEASE_MS = 30_000;
export const AGENT_MIGRATION_AUTO_START_MAX_RETRY_ATTEMPTS = 3;
export const AGENT_MIGRATION_AUTO_START_REMEDIATION_WINDOW_MS = 2 * 60 * 1000;
export const AGENT_MIGRATION_AUTO_START_REMEDIATION_LEASE_MS = 30_000;
export const DEFAULT_AGENT_MIGRATION_TRANSPORT_MAX_BYTES = MAX_AGENT_MIGRATION_TRANSPORT_BYTES;
export const AGENT_MIGRATION_AUTO_START_LEASE_MS = 30_000;
const DEFAULT_AGENT_MIGRATION_TRANSPORT_LEASE_MS = 60 * 60 * 1000;
const AGENT_MIGRATION_CHUNK_URL_BATCH_LIMIT = 64;

export interface AgentMigrationDeadlines {
  prepDeadlineAt: Date;
  transferDeadlineAt: Date;
  arrivalDeadlineAt: Date;
}

export interface BeginAgentMigrationInput {
  agentId: string;
  targetMachineId: string;
  initiatedByUserId?: string | null;
  now?: Date;
  prepDeadlineMs?: number;
  transferDeadlineMs?: number;
  arrivalDeadlineMs?: number;
}

export interface BeginAgentMigrationProvisioningInput extends BeginAgentMigrationInput {
  transportProvider?: "object_store" | "tunnel";
  sourceTransferUrl: string;
  targetTransferUrl: string;
  transportSessionId?: string;
  transportLeaseMs?: number;
  transportMaxBytes?: number;
}

export type AgentMigrationTransportLeaseMessage = Extract<ServerToMachineMessage, { type: "machine:migration_transport:lease" }>;

export interface AgentMigrationTransportLeaseDelivery {
  machineId: string;
  role: "source" | "target";
  message: AgentMigrationTransportLeaseMessage;
}

export interface AgentMigrationProvisioningResult {
  migration: AgentMigrationRow;
  source: AgentMigrationTransportLeaseDelivery;
  target: AgentMigrationTransportLeaseDelivery;
}

export interface AgentMigrationObjectStoreTransferProvision {
  provider: "object_store";
  sessionId: string;
  sourceTransferUrl: string;
  targetTransferUrl: string;
  leaseMs: number;
  maxBytes: number;
  storageKey: string;
}

export interface AgentMigrationTransferLeaseState {
  provider?: "object_store" | "tunnel" | null;
  role?: "source" | "target" | null;
  transferKind?: "upload" | "download" | "exposed_endpoint" | "peer_endpoint" | null;
  leaseSource?: "server" | "env" | null;
  migrationId?: string | null;
  migrationGeneration?: string | null;
  sessionId?: string | null;
  expiresAt?: string | Date | null;
  maxBytes?: number | null;
}

export type AgentMigrationTransferLeaseReadyVerdict =
  | { ready: true }
  | {
      ready: false;
      code: "MIGRATION_TRANSPORT_NOT_PROVISIONED" | "MIGRATION_TRANSPORT_LOST";
      reason:
        | "missing"
        | "provider_mismatch"
        | "role_mismatch"
        | "transfer_kind_mismatch"
        | "lease_source_mismatch"
        | "migration_mismatch"
        | "generation_mismatch"
        | "session_mismatch"
        | "expires_at_invalid"
        | "expired"
        | "max_bytes_invalid"
        | "max_bytes_exceeds_grant";
    };

export type ZenMigratingDeliveryDecision =
  | { action: "deliver"; reason: "no-active-migration" | "migration-protocol" | "owner-pierce" | "target-starting" }
  | { action: "queue"; reason: "zen-migrating" }
  | { action: "deadline-expired"; reason: "prep-deadline" | "transfer-deadline" | "arrival-deadline" };

export type AgentMigrationLifecycleEventType = Extract<
  AgentLifecycleEventType,
  "migration_started" | "migration_completed" | "migration_aborted"
>;

export interface AgentMigrationGateStatus {
  migration: AgentMigrationRow | null;
  expiredLifecycleEvent?: AgentLifecycleEvent;
}

export interface AgentMigrationTargetImportView {
  migrationId: string;
  grantKey: string;
  migrationRef: string;
  migrationGeneration: string;
  state: AgentMigrationState;
  sourceMachineId: string;
  targetMachineId: string;
  agentId: string;
  manifestPath: string | null;
  manifestSha256: string | null;
  canDriveTargetImport: true;
}

export interface AgentMigrationTargetArrivalResult {
  migration: AgentMigrationTargetImportView;
  autoStart: "dispatch" | "observe" | "none";
}

export interface AgentMigrationChunkTransferPlanEntry {
  index: number;
  sizeBytes: number;
  sha256: string;
  method: "PUT" | "GET";
  url: string;
}

export interface AgentMigrationChunkTransferPlan {
  migrationId: string;
  migrationGeneration: string;
  leaseId: string;
  controlSha256: string;
  chunks: AgentMigrationChunkTransferPlanEntry[];
  nextCursor: number | null;
  complete: boolean;
}

const DEFAULT_PREP_DEADLINE_MS = 10 * 60 * 1000;
const DEFAULT_TRANSFER_DEADLINE_MS = 60 * 60 * 1000;
const DEFAULT_ARRIVAL_DEADLINE_MS = 10 * 60 * 1000;
const AGENT_MIGRATION_OBJECT_STORE_CONTENT_TYPE = AGENT_MIGRATION_BUNDLE_CONTENT_TYPE;

function addMs(now: Date, ms: number): Date {
  return new Date(now.getTime() + ms);
}

function positiveDeadlineMs(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_ARRIVAL_DEADLINE_MS;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createTransportToken(): string {
  return `slock_migration_${randomBytes(32).toString("base64url")}`;
}

function createMigrationSupportRef(): string {
  return `mig_${randomBytes(16).toString("base64url")}`;
}

function createMigrationCancelGeneration(): string {
  return `migration_cancel_${randomBytes(24).toString("base64url")}`;
}

function normalizeTransferUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("MIGRATION_TRANSPORT_URL_INVALID");
  }
  return parsed.toString();
}

function parseLeaseExpiry(value: string | Date | null | undefined): number | null {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function transferKindForRole(
  provider: AgentMigrationTransportLeaseMessage["provider"],
  role: "source" | "target",
): AgentMigrationTransportLeaseMessage["transferKind"] {
  if (provider === "object_store") return role === "source" ? "upload" : "download";
  return role === "source" ? "exposed_endpoint" : "peer_endpoint";
}

function objectStoreKey(sessionId: string): string {
  return `agent-migrations/${sessionId}/bundle`;
}

function storagePresignExpiresInSeconds(leaseMs: number): number {
  return Math.max(60, Math.ceil(leaseMs / 1000));
}

function arrivalWindowMs(row: Pick<AgentMigrationRow, "transferDeadlineAt" | "arrivalDeadlineAt">): number {
  return positiveDeadlineMs(row.arrivalDeadlineAt.getTime() - row.transferDeadlineAt.getTime());
}

function isActiveState(state: AgentMigrationState): state is ActiveAgentMigrationState {
  return (ACTIVE_AGENT_MIGRATION_STATES as readonly string[]).includes(state);
}

function isTransferActiveState(
  state: AgentMigrationState,
): state is typeof TRANSFER_ACTIVE_AGENT_MIGRATION_STATES[number] {
  return (TRANSFER_ACTIVE_AGENT_MIGRATION_STATES as readonly string[]).includes(state);
}

function migrationLifecycleReason(eventType: AgentMigrationLifecycleEventType): AgentLifecycleReason {
  if (eventType === "migration_started") return "migration_prepare";
  if (eventType === "migration_completed") return "migration_arrived";
  return "migration_abort";
}

function migrationLifecycleMachineId(row: AgentMigrationRow, eventType: AgentMigrationLifecycleEventType): string {
  if (eventType === "migration_completed") return row.targetMachineId;
  if (eventType === "migration_aborted" && row.flippedAt) return row.targetMachineId;
  return row.sourceMachineId;
}

export function agentMigrationGeneration(row: Pick<AgentMigrationRow, "id" | "revision">): string {
  return `agent_migration:${row.id}:${row.revision}`;
}

export async function provisionAgentMigrationObjectStoreTransfer(input: {
  sessionId?: string;
  leaseMs?: number;
  maxBytes?: number;
  storage?: StorageBackend | null;
} = {}): Promise<AgentMigrationObjectStoreTransferProvision> {
  const storage = input.storage ?? getStorage();
  if (!storage?.getPresignedPutUrl || !storage.getPresignedUrl) {
    throw new Error("MIGRATION_TRANSPORT_PROVISION_FAILED");
  }
  const sessionId = input.sessionId ?? randomUUID();
  const leaseMs = input.leaseMs ?? DEFAULT_AGENT_MIGRATION_TRANSPORT_LEASE_MS;
  const maxBytes = input.maxBytes ?? DEFAULT_AGENT_MIGRATION_TRANSPORT_MAX_BYTES;
  const storageKey = objectStoreKey(sessionId);
  const expiresIn = storagePresignExpiresInSeconds(leaseMs);
  const [sourceTransferUrl, targetTransferUrl] = await Promise.all([
    storage.getPresignedPutUrl(storageKey, { expiresIn }),
    storage.getPresignedUrl(storageKey, {
      expiresIn,
      responseContentDisposition: `attachment; filename="agent-migration-${sessionId}.bundle"`,
      responseContentType: AGENT_MIGRATION_OBJECT_STORE_CONTENT_TYPE,
    }),
  ]);
  return {
    provider: "object_store",
    sessionId,
    sourceTransferUrl,
    targetTransferUrl,
    leaseMs,
    maxBytes,
    storageKey,
  };
}

export function evaluateAgentMigrationTransferLeaseReady(input: {
  migration: Pick<
    AgentMigrationRow,
    "id" | "revision" | "transportProvider" | "transportSessionId" | "transportLeaseSource" | "transportMaxBytes"
  >;
  lease: AgentMigrationTransferLeaseState | null | undefined;
  role: "source" | "target";
  now?: Date;
}): AgentMigrationTransferLeaseReadyVerdict {
  const { migration, lease, role } = input;
  if (!lease) return { ready: false, code: "MIGRATION_TRANSPORT_NOT_PROVISIONED", reason: "missing" };
  const provider = migration.transportProvider === "tunnel" ? "tunnel" : "object_store";
  if (lease.provider !== provider) {
    return { ready: false, code: "MIGRATION_TRANSPORT_NOT_PROVISIONED", reason: "provider_mismatch" };
  }
  if (lease.role !== role) {
    return { ready: false, code: "MIGRATION_TRANSPORT_NOT_PROVISIONED", reason: "role_mismatch" };
  }
  if (lease.transferKind !== transferKindForRole(provider, role)) {
    return { ready: false, code: "MIGRATION_TRANSPORT_NOT_PROVISIONED", reason: "transfer_kind_mismatch" };
  }
  if (lease.leaseSource !== "server" || migration.transportLeaseSource !== "server") {
    return { ready: false, code: "MIGRATION_TRANSPORT_NOT_PROVISIONED", reason: "lease_source_mismatch" };
  }
  if (lease.migrationId !== migration.id) {
    return { ready: false, code: "MIGRATION_TRANSPORT_NOT_PROVISIONED", reason: "migration_mismatch" };
  }
  if (lease.migrationGeneration !== agentMigrationGeneration(migration)) {
    return { ready: false, code: "MIGRATION_TRANSPORT_NOT_PROVISIONED", reason: "generation_mismatch" };
  }
  if (!migration.transportSessionId || lease.sessionId !== migration.transportSessionId) {
    return { ready: false, code: "MIGRATION_TRANSPORT_NOT_PROVISIONED", reason: "session_mismatch" };
  }
  const expiresAtMs = parseLeaseExpiry(lease.expiresAt);
  if (expiresAtMs === null) {
    return { ready: false, code: "MIGRATION_TRANSPORT_NOT_PROVISIONED", reason: "expires_at_invalid" };
  }
  if ((input.now ?? currentDate()).getTime() >= expiresAtMs) {
    return { ready: false, code: "MIGRATION_TRANSPORT_LOST", reason: "expired" };
  }
  if (!Number.isFinite(lease.maxBytes ?? NaN) || (lease.maxBytes ?? 0) <= 0) {
    return { ready: false, code: "MIGRATION_TRANSPORT_NOT_PROVISIONED", reason: "max_bytes_invalid" };
  }
  if (migration.transportMaxBytes && (lease.maxBytes ?? 0) > migration.transportMaxBytes) {
    return { ready: false, code: "MIGRATION_TRANSPORT_NOT_PROVISIONED", reason: "max_bytes_exceeds_grant" };
  }
  return { ready: true };
}

export async function recordAgentMigrationSourceQuiesced(input: {
  migrationId: string;
  serverId: string;
  sourceMachineId: string;
  transportToken: string;
  receipt: AgentMigrationSourceQuiesceReceipt;
  now?: Date;
}): Promise<AgentMigrationRow> {
  const db = getDb();
  const now = input.now ?? currentDate();
  return await db.transaction(async (tx) => {
    const [row] = await tx.select().from(agentMigrations)
      .where(eq(agentMigrations.id, input.migrationId))
      .limit(1)
      .for("update");
    assertResumableMigrationActor(row, {
      serverId: input.serverId,
      machineId: input.sourceMachineId,
      role: "source",
      transportToken: input.transportToken,
    });
    if (!row.transportGeneration || !row.transportLeaseId) {
      throw new Error("MIGRATION_RESUMABLE_PROTOCOL_REQUIRED");
    }
    const receipt = input.receipt;
    if (
      receipt.schemaVersion !== "agent-migration-quiesce/v1"
      || receipt.migrationId !== row.id
      || receipt.migrationGeneration !== row.transportGeneration
      || receipt.agentId !== row.agentId
      || receipt.sourceMachineId !== row.sourceMachineId
      || receipt.sourceRuntimeState !== "stopped"
      || receipt.actor !== "migration"
      || !receipt.launchSessionIdentity
      || receipt.expectedRuntimeRevision !== String(row.transportExpectedMigrationRevision)
      || !Number.isFinite(Date.parse(receipt.stoppedAt))
    ) {
      throw new Error("MIGRATION_SOURCE_QUIESCE_RECEIPT_INVALID");
    }
    if (row.sourceQuiesceReceipt) {
      if (canonicalJson(row.sourceQuiesceReceipt) !== canonicalJson(receipt)) {
        throw new Error("MIGRATION_SOURCE_QUIESCE_RECEIPT_CONFLICT");
      }
      return row;
    }
    const [updated] = await tx.update(agentMigrations)
      .set({
        sourceQuiesceReceipt: receipt,
        sourceQuiescedAt: now,
        revision: row.revision + 1,
        updatedAt: now,
      })
      .where(and(eq(agentMigrations.id, row.id), eq(agentMigrations.revision, row.revision)))
      .returning();
    if (!updated) throw new Error("MIGRATION_CONCURRENT_UPDATE");
    return updated;
  });
}

export async function registerAgentMigrationControlManifest(input: {
  migrationId: string;
  serverId: string;
  sourceMachineId: string;
  transportToken: string;
  control: AgentMigrationControlManifest;
  now?: Date;
}): Promise<{ migration: AgentMigrationRow; controlSha256: string; missingChunkIndexes: number[] }> {
  const db = getDb();
  const now = input.now ?? currentDate();
  return await db.transaction(async (tx) => {
    const [row] = await tx.select().from(agentMigrations)
      .where(eq(agentMigrations.id, input.migrationId))
      .limit(1)
      .for("update");
    assertResumableMigrationActor(row, {
      serverId: input.serverId,
      machineId: input.sourceMachineId,
      role: "source",
      transportToken: input.transportToken,
    });
    if (!row.sourceQuiesceReceipt || !row.sourceQuiescedAt) {
      throw new Error("MIGRATION_SOURCE_NOT_QUIESCED");
    }
    const validation = validateControlManifestForMigration(input.control, row);
    if (row.transportControlSha256 && row.transportControlSha256 !== validation.sha256) {
      throw new Error("MIGRATION_CONTROL_MANIFEST_CONFLICT");
    }
    let migration = row;
    if (!row.transportControlSha256) {
      const [updated] = await tx.update(agentMigrations)
        .set({
          transportControlManifest: input.control,
          transportControlSha256: validation.sha256,
          transportControlRegisteredAt: now,
          revision: row.revision + 1,
          updatedAt: now,
        })
        .where(and(eq(agentMigrations.id, row.id), eq(agentMigrations.revision, row.revision)))
        .returning();
      if (!updated) throw new Error("MIGRATION_CONCURRENT_UPDATE");
      migration = updated;
      await tx.insert(agentMigrationChunkReceipts)
        .values(input.control.bundle.chunks.map((chunk) => ({
          migrationId: row.id,
          transportGeneration: input.control.identity.migrationGeneration,
          leaseId: input.control.identity.leaseId,
          chunkIndex: chunk.index,
          sizeBytes: chunk.sizeBytes,
          sha256: chunk.sha256,
          createdAt: now,
          updatedAt: now,
        })))
        .onConflictDoNothing();
    }
    const receipts = await tx.select().from(agentMigrationChunkReceipts)
      .where(and(
        eq(agentMigrationChunkReceipts.migrationId, row.id),
        eq(agentMigrationChunkReceipts.transportGeneration, input.control.identity.migrationGeneration),
      ))
      .orderBy(asc(agentMigrationChunkReceipts.chunkIndex));
    assertChunkRowsMatchControl(receipts, input.control);
    return {
      migration,
      controlSha256: validation.sha256,
      missingChunkIndexes: receipts.filter((receipt) => !receipt.sourceReceiptAt).map((receipt) => receipt.chunkIndex),
    };
  });
}

export async function getAgentMigrationResumableControl(input: {
  migrationId: string;
  serverId: string;
  machineId: string;
  role: "source" | "target";
  transportToken: string;
}): Promise<{ control: AgentMigrationControlManifest; controlSha256: string; uploadComplete: boolean }> {
  const db = getDb();
  const [row] = await db.select().from(agentMigrations)
    .where(eq(agentMigrations.id, input.migrationId))
    .limit(1);
  assertResumableMigrationActor(row, input);
  if (!row.transportControlManifest || !row.transportControlSha256) {
    throw new Error("MIGRATION_CONTROL_MANIFEST_MISSING");
  }
  validateControlManifestForMigration(row.transportControlManifest, row);
  return {
    control: row.transportControlManifest,
    controlSha256: row.transportControlSha256,
    uploadComplete: Boolean(row.transportUploadCompletedAt),
  };
}

export async function planAgentMigrationChunkTransfers(input: {
  migrationId: string;
  serverId: string;
  machineId: string;
  role: "source" | "target";
  transportToken: string;
  cursor?: number;
  storage?: StorageBackend | null;
}): Promise<AgentMigrationChunkTransferPlan> {
  const db = getDb();
  const [row] = await db.select().from(agentMigrations)
    .where(eq(agentMigrations.id, input.migrationId))
    .limit(1);
  assertResumableMigrationActor(row, input);
  if (
    !row.transportControlManifest
    || !row.transportControlSha256
    || !row.transportGeneration
    || !row.transportLeaseId
    || !row.transportSessionId
    || !row.transportExpiresAt
  ) {
    throw new Error("MIGRATION_CONTROL_MANIFEST_MISSING");
  }
  if (input.role === "target" && !row.transportUploadCompletedAt) {
    throw new Error("MIGRATION_NOT_READY");
  }
  if (currentDate().getTime() >= row.transportExpiresAt.getTime()) {
    throw new Error("MIGRATION_LEASE_EXPIRED");
  }
  const storage = input.storage ?? getStorage();
  if (!storage?.getPresignedPutUrl || !storage.getPresignedUrl) {
    throw new Error("MIGRATION_TRANSPORT_PROVISION_FAILED");
  }
  const receipts = await db.select().from(agentMigrationChunkReceipts)
    .where(and(
      eq(agentMigrationChunkReceipts.migrationId, row.id),
      eq(agentMigrationChunkReceipts.transportGeneration, row.transportGeneration),
    ))
    .orderBy(asc(agentMigrationChunkReceipts.chunkIndex));
  assertChunkRowsMatchControl(receipts, row.transportControlManifest);
  const cursor = Number.isSafeInteger(input.cursor) && (input.cursor ?? 0) >= 0 ? input.cursor ?? 0 : 0;
  const candidates = receipts.filter((receipt) =>
    receipt.chunkIndex >= cursor
    && (input.role === "source"
      ? receipt.sourceReceiptAt === null
      : receipt.sourceReceiptAt !== null && receipt.targetReceiptAt === null));
  const batch = candidates.slice(0, AGENT_MIGRATION_CHUNK_URL_BATCH_LIMIT);
  const expiresIn = storagePresignExpiresInSeconds(
    Math.max(1_000, row.transportExpiresAt.getTime() - currentDate().getTime()),
  );
  const chunks = await Promise.all(batch.map(async (receipt) => ({
    index: receipt.chunkIndex,
    sizeBytes: receipt.sizeBytes,
    sha256: receipt.sha256,
    method: input.role === "source" ? "PUT" as const : "GET" as const,
    url: input.role === "source"
      ? await storage.getPresignedPutUrl!(
          resumableChunkStorageKey(row.transportSessionId!, row.transportGeneration!, receipt.chunkIndex),
          { expiresIn, contentType: "application/octet-stream" },
        )
      : await storage.getPresignedUrl!(
          resumableChunkStorageKey(row.transportSessionId!, row.transportGeneration!, receipt.chunkIndex),
          { expiresIn, responseContentType: "application/octet-stream" },
        ),
  })));
  const nextCandidate = candidates[batch.length];
  return {
    migrationId: row.id,
    migrationGeneration: row.transportGeneration,
    leaseId: row.transportLeaseId,
    controlSha256: row.transportControlSha256,
    chunks,
    nextCursor: nextCandidate?.chunkIndex ?? null,
    complete: candidates.length === 0,
  };
}

export async function recordAgentMigrationChunkReceipt(input: {
  migrationId: string;
  serverId: string;
  machineId: string;
  role: "source" | "target";
  transportToken: string;
  migrationGeneration: string;
  leaseId: string;
  chunkIndex: number;
  sizeBytes: number;
  sha256: string;
  etag?: string | null;
  now?: Date;
}): Promise<{ outcome: "recorded" | "reused" }> {
  const db = getDb();
  const now = input.now ?? currentDate();
  return await db.transaction(async (tx) => {
    const [row] = await tx.select().from(agentMigrations)
      .where(eq(agentMigrations.id, input.migrationId))
      .limit(1)
      .for("update");
    assertResumableMigrationActor(row, input);
    if (
      input.migrationGeneration !== row.transportGeneration
      || input.leaseId !== row.transportLeaseId
    ) {
      throw new Error("MIGRATION_GENERATION_STALE");
    }
    const [receipt] = await tx.select().from(agentMigrationChunkReceipts)
      .where(and(
        eq(agentMigrationChunkReceipts.migrationId, row.id),
        eq(agentMigrationChunkReceipts.transportGeneration, input.migrationGeneration),
        eq(agentMigrationChunkReceipts.chunkIndex, input.chunkIndex),
      ))
      .limit(1)
      .for("update");
    if (
      !receipt
      || receipt.leaseId !== input.leaseId
      || receipt.sizeBytes !== input.sizeBytes
      || receipt.sha256 !== input.sha256
    ) {
      throw new Error("MIGRATION_CHUNK_RECEIPT_MISMATCH");
    }
    const alreadyRecorded = input.role === "source"
      ? receipt.sourceReceiptAt !== null
      : receipt.targetReceiptAt !== null;
    if (alreadyRecorded) return { outcome: "reused" };
    await tx.update(agentMigrationChunkReceipts)
      .set(input.role === "source"
        ? { sourceEtag: input.etag ?? null, sourceReceiptAt: now, updatedAt: now }
        : { targetReceiptAt: now, updatedAt: now })
      .where(and(
        eq(agentMigrationChunkReceipts.migrationId, row.id),
        eq(agentMigrationChunkReceipts.transportGeneration, input.migrationGeneration),
        eq(agentMigrationChunkReceipts.chunkIndex, input.chunkIndex),
      ));
    return { outcome: "recorded" };
  });
}

export async function completeAgentMigrationResumableUpload(input: {
  migrationId: string;
  serverId: string;
  sourceMachineId: string;
  transportToken: string;
  migrationGeneration: string;
  leaseId: string;
  controlSha256: string;
  now?: Date;
}): Promise<AgentMigrationRow> {
  const db = getDb();
  const now = input.now ?? currentDate();
  return await db.transaction(async (tx) => {
    const [row] = await tx.select().from(agentMigrations)
      .where(eq(agentMigrations.id, input.migrationId))
      .limit(1)
      .for("update");
    assertResumableMigrationActor(row, {
      serverId: input.serverId,
      machineId: input.sourceMachineId,
      role: "source",
      transportToken: input.transportToken,
    });
    if (
      row.transportGeneration !== input.migrationGeneration
      || row.transportLeaseId !== input.leaseId
      || row.transportControlSha256 !== input.controlSha256
      || !row.transportControlManifest
    ) {
      throw new Error("MIGRATION_GENERATION_STALE");
    }
    const validation = validateControlManifestForMigration(row.transportControlManifest, row);
    if (validation.sha256 !== row.transportControlSha256) {
      throw new Error("MIGRATION_CONTROL_MANIFEST_INVALID");
    }
    if (row.transferSummary && !isDeepStrictEqual(row.transferSummary, validation.transferSummary)) {
      throw new Error("MIGRATION_TRANSFER_SUMMARY_CONFLICT");
    }
    const receipts = await tx.select().from(agentMigrationChunkReceipts)
      .where(and(
        eq(agentMigrationChunkReceipts.migrationId, row.id),
        eq(agentMigrationChunkReceipts.transportGeneration, input.migrationGeneration),
      ))
      .orderBy(asc(agentMigrationChunkReceipts.chunkIndex));
    assertChunkRowsMatchControl(receipts, row.transportControlManifest);
    if (receipts.some((receipt) => !receipt.sourceReceiptAt)) {
      throw new Error("MIGRATION_CHUNKS_MISSING");
    }
    if (row.transportUploadCompletedAt && row.state === "ready") return row;
    if (row.state !== "provisioning" && row.state !== "prep") {
      throw new Error("MIGRATION_NOT_IN_PREP");
    }
    const [updated] = await tx.update(agentMigrations)
      .set({
        state: "ready",
        manifestPath: `object-store:${row.transportSessionId}/control.json`,
        manifestSha256: input.controlSha256,
        transferSummary: validation.transferSummary,
        transportProvisionedAt: row.transportProvisionedAt ?? now,
        transportUploadCompletedAt: now,
        transportErrorCode: null,
        transportErrorMessage: null,
        readyAt: now,
        revision: row.revision + 1,
        updatedAt: now,
      })
      .where(and(eq(agentMigrations.id, row.id), eq(agentMigrations.revision, row.revision)))
      .returning();
    if (!updated) throw new Error("MIGRATION_CONCURRENT_UPDATE");
    return updated;
  });
}

function assertResumableMigrationActor(
  row: AgentMigrationRow | undefined,
  input: {
    serverId: string;
    machineId: string;
    role: "source" | "target";
    transportToken: string;
  },
): asserts row is AgentMigrationRow {
  if (
    !row
    || row.serverId !== input.serverId
    || (input.role === "source" ? row.sourceMachineId : row.targetMachineId) !== input.machineId
  ) {
    throw new Error("MIGRATION_NOT_FOUND");
  }
  if (!isTransferActiveState(row.state)) throw new Error("MIGRATION_NOT_ACTIVE");
  if (
    row.transportProtocol !== AGENT_MIGRATION_RESUMABLE_PROTOCOL
    || !row.transportGeneration
    || !row.transportLeaseId
    || row.transportExpectedMigrationRevision === null
  ) {
    throw new Error("MIGRATION_RESUMABLE_PROTOCOL_REQUIRED");
  }
  const expectedHash = input.role === "source"
    ? row.sourceTransportTokenHash
    : row.targetTransportTokenHash;
  if (!expectedHash || !safeHashEquals(expectedHash, sha256(input.transportToken))) {
    throw new Error("MIGRATION_TRANSPORT_TOKEN_INVALID");
  }
  if (!row.transportExpiresAt || currentDate().getTime() >= row.transportExpiresAt.getTime()) {
    throw new Error("MIGRATION_LEASE_EXPIRED");
  }
}

function validateControlManifestForMigration(
  control: AgentMigrationControlManifest,
  row: AgentMigrationRow,
): { sha256: string; bytes: number; transferSummary: AgentMigrationTransferSummary } {
  if (
    !control
    || typeof control !== "object"
    || control.schemaVersion !== AGENT_MIGRATION_CONTROL_SCHEMA_VERSION
    || control.protocol !== AGENT_MIGRATION_RESUMABLE_PROTOCOL
    || !control.identity
    || !control.capability
    || !Array.isArray(control.capability.required)
    || !control.bundle
    || !Array.isArray(control.bundle.chunks)
    || !control.archive
    || !Array.isArray(control.archive.allowedEntryTypes)
    || !control.commit
    || control.identity.migrationId !== row.id
    || control.identity.migrationGeneration !== row.transportGeneration
    || control.identity.leaseId !== row.transportLeaseId
    || control.identity.agentId !== row.agentId
    || control.identity.sourceMachineId !== row.sourceMachineId
    || control.identity.targetMachineId !== row.targetMachineId
    || control.bundle.contentType !== AGENT_MIGRATION_BUNDLE_CONTENT_TYPE
    || !Number.isSafeInteger(control.bundle.totalBytes)
    || control.bundle.totalBytes <= 0
    || control.bundle.totalBytes > (row.transportMaxBytes ?? 0)
    || !/^[0-9a-f]{64}$/.test(control.bundle.sha256)
    || !Number.isSafeInteger(control.bundle.chunkSizeBytes)
    || control.bundle.chunkSizeBytes < AGENT_MIGRATION_MIN_CHUNK_BYTES
    || control.bundle.chunks.length === 0
    || control.bundle.chunks.length > AGENT_MIGRATION_MAX_CHUNKS
    || control.capability.required.length !== AGENT_MIGRATION_RESUMABLE_CAPABILITIES.length
    || !AGENT_MIGRATION_RESUMABLE_CAPABILITIES.every((capability) =>
      control.capability.required.includes(capability))
    || control.archive.format !== "tar+gzip"
    || control.archive.allowedEntryTypes.length !== 2
    || control.archive.allowedEntryTypes[0] !== "file"
    || control.archive.allowedEntryTypes[1] !== "symlink"
    || !Number.isSafeInteger(control.archive.entryCount)
    || control.archive.entryCount < 0
    || control.archive.entryCount > AGENT_MIGRATION_MAX_ARCHIVE_ENTRIES
    || !Number.isSafeInteger(control.archive.expandedBytes)
    || control.archive.expandedBytes < 0
    || !Number.isSafeInteger(control.archive.maxEntryBytes)
    || control.archive.maxEntryBytes < 0
    || control.archive.maxEntryBytes > control.archive.expandedBytes
    || control.commit.mode !== "atomic-rename"
    || control.commit.markerPath !== AGENT_MIGRATION_COMMIT_MARKER_PATH
    || control.commit.requireWholeBundleDigest !== true
    || control.commit.requireAllChunkDigests !== true
    || control.commit.existingWorkspace !== "idle-or-same-commit"
  ) {
    throw new Error("MIGRATION_CONTROL_MANIFEST_INVALID");
  }
  let offsetBytes = 0;
  for (let index = 0; index < control.bundle.chunks.length; index += 1) {
    const chunk = control.bundle.chunks[index];
    if (
      chunk.index !== index
      || chunk.offsetBytes !== offsetBytes
      || !Number.isSafeInteger(chunk.sizeBytes)
      || chunk.sizeBytes <= 0
      || chunk.sizeBytes > control.bundle.chunkSizeBytes
      || !/^[0-9a-f]{64}$/.test(chunk.sha256)
    ) {
      throw new Error("MIGRATION_CONTROL_MANIFEST_INVALID");
    }
    offsetBytes += chunk.sizeBytes;
  }
  if (offsetBytes !== control.bundle.totalBytes) {
    throw new Error("MIGRATION_CONTROL_MANIFEST_INVALID");
  }
  const transferSummary = agentMigrationTransferSummarySchema.safeParse(control.transferSummary);
  if (
    !transferSummary.success
    || transferSummary.data.includedFileCount !== control.archive.entryCount
    || transferSummary.data.includedBytes !== control.archive.expandedBytes
  ) {
    throw new Error("MIGRATION_CONTROL_MANIFEST_INVALID");
  }
  const payload = Buffer.from(canonicalJson(control), "utf8");
  if (payload.byteLength > AGENT_MIGRATION_MAX_CONTROL_MANIFEST_BYTES) {
    throw new Error("MIGRATION_CONTROL_MANIFEST_TOO_LARGE");
  }
  return {
    sha256: createHash("sha256").update(payload).digest("hex"),
    bytes: payload.byteLength,
    transferSummary: transferSummary.data,
  };
}

function assertChunkRowsMatchControl(
  receipts: Array<typeof agentMigrationChunkReceipts.$inferSelect>,
  control: AgentMigrationControlManifest,
): void {
  if (receipts.length !== control.bundle.chunks.length) {
    throw new Error("MIGRATION_CHUNK_RECEIPT_SET_MISMATCH");
  }
  for (const expected of control.bundle.chunks) {
    const receipt = receipts[expected.index];
    if (
      !receipt
      || receipt.chunkIndex !== expected.index
      || receipt.sizeBytes !== expected.sizeBytes
      || receipt.sha256 !== expected.sha256
      || receipt.leaseId !== control.identity.leaseId
      || receipt.transportGeneration !== control.identity.migrationGeneration
    ) {
      throw new Error("MIGRATION_CHUNK_RECEIPT_SET_MISMATCH");
    }
  }
}

function resumableChunkStorageKey(sessionId: string, generation: string, chunkIndex: number): string {
  const safeGeneration = createHash("sha256").update(generation).digest("hex").slice(0, 24);
  return `agent-migrations/${sessionId}/resumable/${safeGeneration}/chunks/${chunkIndex}`;
}

function safeHashEquals(leftHex: string, rightHex: string): boolean {
  const left = Buffer.from(leftHex, "hex");
  const right = Buffer.from(rightHex, "hex");
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      result[key] = sortJsonValue((value as Record<string, unknown>)[key]);
      return result;
    }, {});
}

function targetImportView(row: AgentMigrationRow): AgentMigrationTargetImportView {
  return {
    migrationId: row.id,
    grantKey: row.grantKey,
    migrationRef: row.supportRef,
    migrationGeneration: agentMigrationGeneration(row),
    state: row.state,
    sourceMachineId: row.sourceMachineId,
    targetMachineId: row.targetMachineId,
    agentId: row.agentId,
    manifestPath: row.manifestPath,
    manifestSha256: row.manifestSha256,
    canDriveTargetImport: true,
  };
}

function assertTargetImportRow(input: {
  row: AgentMigrationRow | undefined;
  serverId: string;
  targetMachineId: string;
}): AgentMigrationRow {
  const { row, serverId, targetMachineId } = input;
  if (!row || row.serverId !== serverId || row.targetMachineId !== targetMachineId) {
    throw new Error("MIGRATION_NOT_FOUND");
  }
  return row;
}

function assertMigrationGeneration(row: AgentMigrationRow, migrationGeneration: string): void {
  if (!migrationGeneration || migrationGeneration !== agentMigrationGeneration(row)) {
    throw new Error("MIGRATION_GENERATION_STALE");
  }
}

async function agentHolderMachineId(
  executor: DatabaseExecutor,
  agentId: string,
): Promise<string | null> {
  const [row] = await executor.select({ machineId: agents.machineId })
    .from(agents)
    .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
    .limit(1);
  return row?.machineId ?? null;
}

async function isAgentHeldByTarget(executor: DatabaseExecutor, row: AgentMigrationRow): Promise<boolean> {
  return await agentHolderMachineId(executor, row.agentId) === row.targetMachineId;
}

async function finalizeAgentHolderProjection(
  executor: DatabaseExecutor,
  migration: AgentMigrationRow,
  now: Date,
): Promise<void> {
  const [updatedAgent] = await executor.update(agents)
    .set({
      machineId: migration.targetMachineId,
      sessionId: null,
      updatedAt: now,
    })
    .where(and(
      eq(agents.id, migration.agentId),
      eq(agents.machineId, migration.targetMachineId),
      isNull(agents.deletedAt),
    ))
    .returning({ id: agents.id });
  if (!updatedAgent) throw new Error("MIGRATION_SOURCE_MACHINE_MISMATCH");
}

async function finalizeRuntimeProfileProjection(
  executor: DatabaseExecutor,
  migration: AgentMigrationRow,
  now: Date,
): Promise<void> {
  const [profile] = await executor.select()
    .from(agentRuntimeProfiles)
    .where(eq(agentRuntimeProfiles.agentId, migration.agentId))
    .limit(1);
  if (!profile) return;
  const [updatedProfile] = await executor.update(agentRuntimeProfiles)
    .set({
      machineId: migration.targetMachineId,
      baselineMachineId: migration.targetMachineId,
      baselineRuntimeProfileFingerprint: profile.pendingAfterRuntimeProfileFingerprint ?? profile.runtimeProfileFingerprint,
      baselineRuntime: profile.pendingAfterRuntime ?? profile.runtime,
      baselineModel: profile.pendingAfterModel ?? profile.model,
      baselineReasoningEffort: profile.pendingAfterReasoningEffort ?? profile.reasoningEffort,
      baselineExecutionMode: profile.pendingAfterExecutionMode ?? profile.executionMode,
      baselineDaemonVersion: profile.pendingAfterDaemonVersion ?? profile.daemonVersion,
      sessionRefLabel: null,
      sessionRefPath: null,
      sessionRefMachineId: null,
      sessionRefRuntime: null,
      sessionRefReachable: null,
      sessionRefReason: null,
      migrationStatus: "stable",
      pendingKind: null,
      pendingKey: null,
      pendingBeforeRuntimeProfileFingerprint: null,
      pendingAfterRuntimeProfileFingerprint: null,
      pendingBeforeMachineId: null,
      pendingAfterMachineId: null,
      pendingBeforeRuntime: null,
      pendingAfterRuntime: null,
      pendingBeforeModel: null,
      pendingAfterModel: null,
      pendingBeforeReasoningEffort: null,
      pendingAfterReasoningEffort: null,
      pendingBeforeExecutionMode: null,
      pendingAfterExecutionMode: null,
      pendingBeforeDaemonVersion: null,
      pendingAfterDaemonVersion: null,
      pendingPreviousSessionLabel: null,
      pendingPreviousSessionPath: null,
      pendingPreviousSessionMachineId: null,
      pendingPreviousSessionRuntime: null,
      pendingPreviousSessionReachable: null,
      pendingPreviousSessionReason: null,
      pendingReleaseNotesUrl: null,
      migrationDeliveredAt: null,
      migrationDeliveredLaunchId: null,
      migratingSince: null,
      lastMigrationNudgeAt: null,
      migrationNudgeCount: 0,
      migrationHandledAt: now,
      migrationHandledLaunchId: null,
      revision: profile.revision + 1,
      updatedAt: now,
    })
    .where(and(
      eq(agentRuntimeProfiles.agentId, migration.agentId),
      eq(agentRuntimeProfiles.revision, profile.revision),
    ))
    .returning({ agentId: agentRuntimeProfiles.agentId });
  if (!updatedProfile) throw new Error("MIGRATION_CONCURRENT_UPDATE");
}

export function createAgentMigrationLifecycleEvent(input: {
  migration: AgentMigrationRow;
  eventType: AgentMigrationLifecycleEventType;
  occurredAt?: Date | string;
}): AgentLifecycleEvent {
  const { migration, eventType } = input;
  return createAgentLifecycleEvent({
    serverId: migration.serverId,
    agentId: migration.agentId,
    machineId: migrationLifecycleMachineId(migration, eventType),
    eventType,
    actor: "server",
    source: "server",
    reason: migrationLifecycleReason(eventType),
    correlationId: `agent_migration:${migration.supportRef}`,
    idempotencyKey: `agent_migration:${migration.supportRef}:${eventType}:${migration.revision}`,
    occurredAt: input.occurredAt,
    attrs: {
      migration_ref: migration.supportRef,
      migration_state: migration.state,
      source_machine_id: migration.sourceMachineId,
      target_machine_id: migration.targetMachineId,
    },
  });
}

function deadlineForState(row: Pick<AgentMigrationRow, "state" | "prepDeadlineAt" | "transferDeadlineAt" | "arrivalDeadlineAt">): {
  deadline: Date;
  reason: Extract<ZenMigratingDeliveryDecision, { action: "deadline-expired" }>["reason"];
} {
  if (row.state === "provisioning" || row.state === "prep") return { deadline: row.prepDeadlineAt, reason: "prep-deadline" };
  if (row.state === "arriving") {
    return { deadline: row.arrivalDeadlineAt, reason: "arrival-deadline" };
  }
  if (row.state === "starting") throw new Error("MIGRATION_STARTING_HAS_NO_DEADLINE");
  return { deadline: row.transferDeadlineAt, reason: "transfer-deadline" };
}

export function planZenMigratingDelivery(input: {
  migration: Pick<AgentMigrationRow, "state" | "prepDeadlineAt" | "transferDeadlineAt" | "arrivalDeadlineAt"> | null;
  now?: Date;
  migrationProtocol?: boolean;
  ownerPierce?: boolean;
}): ZenMigratingDeliveryDecision {
  if (!input.migration || !isActiveState(input.migration.state)) {
    return { action: "deliver", reason: "no-active-migration" };
  }
  if (input.migration.state === "starting") {
    return { action: "deliver", reason: "target-starting" };
  }
  const now = input.now ?? currentDate();
  const { deadline, reason } = deadlineForState(input.migration);
  if (now.getTime() > deadline.getTime()) {
    return { action: "deadline-expired", reason };
  }
  if (input.migrationProtocol) return { action: "deliver", reason: "migration-protocol" };
  if (input.ownerPierce) return { action: "deliver", reason: "owner-pierce" };
  return { action: "queue", reason: "zen-migrating" };
}

async function abortElapsedDeadlineMigration(
  migration: AgentMigrationRow,
  deadlineReason: Extract<ZenMigratingDeliveryDecision, { action: "deadline-expired" }>["reason"],
  now: Date,
  executor: DatabaseExecutor,
): Promise<AgentMigrationRow | null> {
  const [updated] = await executor.update(agentMigrations)
    .set({
      state: "aborted",
      abortReason: deadlineReason,
      abortedAt: now,
      transportTeardownAt: now,
      revision: migration.revision + 1,
      updatedAt: now,
    })
    .where(and(
      eq(agentMigrations.id, migration.id),
      eq(agentMigrations.revision, migration.revision),
      inArray(agentMigrations.state, [...TRANSFER_ACTIVE_AGENT_MIGRATION_STATES]),
    ))
    .returning();
  return updated ?? null;
}

export async function getAgentMigrationGateStatus(
  agentId: string,
  executor?: DatabaseExecutor,
  now: Date = currentDate(),
): Promise<AgentMigrationGateStatus> {
  if (!executor && !isDatabaseInitialized()) return { migration: null };
  const db = executor ?? getDb();
  const [row] = await db.select()
    .from(agentMigrations)
    .where(and(
      eq(agentMigrations.agentId, agentId),
      inArray(agentMigrations.state, [...ACTIVE_AGENT_MIGRATION_STATES]),
    ))
    .limit(1);
  if (!row) return { migration: null };
  const decision = planZenMigratingDelivery({ migration: row, now });
  if (decision.action === "deadline-expired") {
    const aborted = await abortElapsedDeadlineMigration(row, decision.reason, now, db);
    return {
      migration: null,
      ...(aborted
        ? {
            expiredLifecycleEvent: createAgentMigrationLifecycleEvent({
              migration: aborted,
              eventType: "migration_aborted",
              occurredAt: now,
            }),
          }
        : {}),
    };
  }
  return { migration: row };
}

export async function getActiveAgentMigration(
  agentId: string,
  executor?: DatabaseExecutor,
  now: Date = currentDate(),
): Promise<AgentMigrationRow | null> {
  return (await getAgentMigrationGateStatus(agentId, executor, now)).migration;
}

export async function getLatestAgentMigration(
  agentId: string,
  executor?: DatabaseExecutor,
  now: Date = currentDate(),
): Promise<AgentMigrationRow | null> {
  const db = executor ?? getDb();
  const active = await getAgentMigrationGateStatus(agentId, db, now);
  if (active.migration) return active.migration;
  const [row] = await db.select()
    .from(agentMigrations)
    .where(eq(agentMigrations.agentId, agentId))
    .orderBy(desc(agentMigrations.updatedAt), desc(agentMigrations.createdAt), desc(agentMigrations.id))
    .limit(1);
  return row ?? null;
}

export async function getAgentMigrationHistory(
  agentId: string,
  limit = 10,
  executor?: DatabaseExecutor,
  now: Date = currentDate(),
): Promise<AgentMigrationRow[]> {
  const db = executor ?? getDb();
  const boundedLimit = Math.max(1, Math.min(25, Math.floor(limit)));
  await getAgentMigrationGateStatus(agentId, db, now);
  return db.select()
    .from(agentMigrations)
    .where(eq(agentMigrations.agentId, agentId))
    .orderBy(desc(agentMigrations.updatedAt), desc(agentMigrations.createdAt), desc(agentMigrations.id))
    .limit(boundedLimit);
}

export async function isAgentZenMigrating(agentId: string, executor?: DatabaseExecutor, now: Date = currentDate()): Promise<boolean> {
  const migration = await getActiveAgentMigration(agentId, executor, now);
  return migration !== null && planZenMigratingDelivery({ migration, now }).action === "queue";
}

async function insertAgentMigration(
  input: BeginAgentMigrationInput,
  executor: DatabaseExecutor,
  supportRefFactory: () => string = createMigrationSupportRef,
): Promise<AgentMigrationRow> {
  const now = input.now ?? currentDate();
  const transferDeadlineAt = addMs(now, input.transferDeadlineMs ?? DEFAULT_TRANSFER_DEADLINE_MS);
  const deadlines: AgentMigrationDeadlines = {
    prepDeadlineAt: addMs(now, input.prepDeadlineMs ?? DEFAULT_PREP_DEADLINE_MS),
    transferDeadlineAt,
    arrivalDeadlineAt: addMs(transferDeadlineAt, input.arrivalDeadlineMs ?? DEFAULT_ARRIVAL_DEADLINE_MS),
  };

  const [agent] = await executor.select()
    .from(agents)
    .where(and(eq(agents.id, input.agentId), isNull(agents.deletedAt)))
    .limit(1);
  if (!agent) throw new Error("AGENT_NOT_FOUND");
  if (!agent.machineId) throw new Error("AGENT_HAS_NO_SOURCE_MACHINE");

  // Lock both machine rows in a stable order so migration creation serializes
  // with Computer deletion after terminal history becomes FK-independent.
  const migrationMachines = await executor.select()
    .from(machines)
    .where(and(
      eq(machines.serverId, agent.serverId),
      inArray(machines.id, [agent.machineId, input.targetMachineId]),
    ))
    .orderBy(asc(machines.id))
    .for("update");
  const sourceMachine = migrationMachines.find((machine) => machine.id === agent.machineId);
  const targetMachine = migrationMachines.find((machine) => machine.id === input.targetMachineId);
  if (!sourceMachine) throw new Error("AGENT_HAS_NO_SOURCE_MACHINE");
  if (!targetMachine || targetMachine.serverId !== agent.serverId) {
    throw new Error("TARGET_MACHINE_NOT_IN_AGENT_SERVER");
  }
  if (targetMachine.id === agent.machineId) {
    throw new Error("TARGET_MACHINE_MATCHES_SOURCE");
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const [row] = await executor.insert(agentMigrations)
      .values({
        serverId: agent.serverId,
        agentId: agent.id,
        sourceMachineId: agent.machineId,
        targetMachineId: targetMachine.id,
        sourceMachineNameSnapshot: sourceMachine.name,
        targetMachineNameSnapshot: targetMachine.name,
        receiptChannelId: null,
        supportRef: supportRefFactory(),
        contractVersion: 2,
        grantKey: `agent_migration:${randomUUID()}`,
        initiatedByUserId: input.initiatedByUserId ?? null,
        prepDeadlineAt: deadlines.prepDeadlineAt,
        transferDeadlineAt: deadlines.transferDeadlineAt,
        arrivalDeadlineAt: deadlines.arrivalDeadlineAt,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: agentMigrations.supportRef })
      .returning();
    if (row) {
      const receiptChannelId = randomUUID();
      await executor.insert(channels).values({
        id: receiptChannelId,
        serverId: row.serverId,
        name: `migration-receipt-${row.supportRef}`,
        description: "Private migration completion receipt",
        type: "dm",
        createdAt: now,
      });
      await executor.insert(channelAgents).values({
        channelId: receiptChannelId,
        agentId: row.agentId,
        addedAt: now,
      });
      const [withReceiptSurface] = await executor.update(agentMigrations)
        .set({ receiptChannelId })
        .where(and(
          eq(agentMigrations.id, row.id),
          isNull(agentMigrations.receiptChannelId),
        ))
        .returning();
      if (!withReceiptSurface) throw new Error("MIGRATION_RECEIPT_SURFACE_CREATE_FAILED");
      await executor.insert(agentMigrationReceiptChannels).values({
        channelId: receiptChannelId,
        migrationId: row.id,
        serverId: row.serverId,
        agentId: row.agentId,
        createdAt: now,
      });
      return withReceiptSurface;
    }
  }
  throw new Error("MIGRATION_SUPPORT_REF_COLLISION_RETRY_EXHAUSTED");
}

function buildTransportLeaseDelivery(input: {
  migration: AgentMigrationRow;
  role: "source" | "target";
  token: string;
}): AgentMigrationTransportLeaseDelivery {
  const { migration, role, token } = input;
  const provider = migration.transportProvider === "tunnel" ? "tunnel" : "object_store";
  const url = role === "source" ? migration.sourceTransportUrl : migration.targetTransportUrl;
  if (!url || !migration.transportSessionId || !migration.transportExpiresAt || !migration.transportMaxBytes) {
    throw new Error("MIGRATION_TRANSPORT_NOT_PROVISIONED");
  }
  return {
    machineId: role === "source" ? migration.sourceMachineId : migration.targetMachineId,
    role,
    message: {
      type: "machine:migration_transport:lease",
      agentId: migration.agentId,
      migrationId: migration.id,
      migrationRef: migration.supportRef,
      migrationGeneration: agentMigrationGeneration(migration),
      sessionId: migration.transportSessionId,
      role,
      provider,
      transferKind: transferKindForRole(provider, role),
      url,
      leaseSource: "server",
      bearerToken: token,
      expiresAt: migration.transportExpiresAt.toISOString(),
      maxBytes: migration.transportMaxBytes,
      ...(migration.transportProtocol === AGENT_MIGRATION_RESUMABLE_PROTOCOL
        && migration.transportGeneration
        && migration.transportLeaseId
        && migration.transportExpectedMigrationRevision !== null
        ? {
            protocol: AGENT_MIGRATION_RESUMABLE_PROTOCOL,
            capabilities: [...AGENT_MIGRATION_RESUMABLE_CAPABILITIES],
            controlUrl: `/internal/computer/agent-migrations/by-id/${encodeURIComponent(migration.id)}/resumable`,
            leaseId: migration.transportLeaseId,
            transportGeneration: migration.transportGeneration,
            sourceMachineId: migration.sourceMachineId,
            targetMachineId: migration.targetMachineId,
            expectedMigrationRevision: migration.transportExpectedMigrationRevision,
          }
        : {}),
    },
  };
}

async function insertAgentMigrationProvisioning(
  input: BeginAgentMigrationProvisioningInput,
  executor: DatabaseExecutor,
): Promise<AgentMigrationProvisioningResult> {
  const now = input.now ?? currentDate();
  const transportSessionId = input.transportSessionId ?? randomUUID();
  const transportGeneration = `agent_migration_transport:${randomUUID()}`;
  const sourceToken = createTransportToken();
  const targetToken = createTransportToken();
  const row = await insertAgentMigration(input, executor);
  const [updated] = await executor.update(agentMigrations)
    .set({
      state: "provisioning",
      transportSessionId,
      transportProvider: input.transportProvider ?? "object_store",
      sourceTransportUrl: normalizeTransferUrl(input.sourceTransferUrl),
      targetTransportUrl: normalizeTransferUrl(input.targetTransferUrl),
      transportLeaseSource: "server",
      transportExpiresAt: addMs(now, input.transportLeaseMs ?? DEFAULT_AGENT_MIGRATION_TRANSPORT_LEASE_MS),
      transportMaxBytes: input.transportMaxBytes ?? DEFAULT_AGENT_MIGRATION_TRANSPORT_MAX_BYTES,
      sourceTransportTokenHash: sha256(sourceToken),
      targetTransportTokenHash: sha256(targetToken),
      transportProvisioningStartedAt: now,
      transportProtocol: AGENT_MIGRATION_RESUMABLE_PROTOCOL,
      transportGeneration,
      transportLeaseId: transportSessionId,
      transportExpectedMigrationRevision: row.revision + 1,
      revision: row.revision + 1,
      updatedAt: now,
    })
    .where(and(eq(agentMigrations.id, row.id), eq(agentMigrations.revision, row.revision)))
    .returning();
  if (!updated) throw new Error("MIGRATION_CONCURRENT_UPDATE");
  return {
    migration: updated,
    source: buildTransportLeaseDelivery({ migration: updated, role: "source", token: sourceToken }),
    target: buildTransportLeaseDelivery({ migration: updated, role: "target", token: targetToken }),
  };
}

export async function beginAgentMigration(
  input: BeginAgentMigrationInput,
  executor: DatabaseExecutor = getDb(),
): Promise<AgentMigrationRow> {
  if ("transaction" in executor) {
    return await executor.transaction(async (tx) => insertAgentMigration(input, tx));
  }
  return await insertAgentMigration(input, executor);
}

export async function beginAgentMigrationProvisioning(
  input: BeginAgentMigrationProvisioningInput,
  executor: DatabaseExecutor = getDb(),
): Promise<AgentMigrationProvisioningResult> {
  if ("transaction" in executor) {
    return await executor.transaction(async (tx) => insertAgentMigrationProvisioning(input, tx));
  }
  return await insertAgentMigrationProvisioning(input, executor);
}

export async function markAgentMigrationTransportProvisioned(input: {
  migrationId: string;
  now?: Date;
}): Promise<AgentMigrationRow> {
  const db = getDb();
  const now = input.now ?? currentDate();
  return await db.transaction(async (tx) => {
    const [row] = await tx.select().from(agentMigrations).where(eq(agentMigrations.id, input.migrationId)).limit(1);
    if (!row) throw new Error("MIGRATION_NOT_FOUND");
    if (row.state !== "provisioning") throw new Error("MIGRATION_NOT_PROVISIONING");
    const [updated] = await tx.update(agentMigrations)
      .set({
        state: "prep",
        transportProvisionedAt: now,
        transportErrorCode: null,
        transportErrorMessage: null,
        revision: row.revision + 1,
        updatedAt: now,
      })
      .where(and(eq(agentMigrations.id, row.id), eq(agentMigrations.revision, row.revision)))
      .returning();
    if (!updated) throw new Error("MIGRATION_CONCURRENT_UPDATE");
    return updated;
  });
}

export async function markAgentMigrationTransportProvisionFailed(input: {
  migrationId: string;
  code?: string;
  message?: string | null;
  now?: Date;
}): Promise<AgentMigrationRow | null> {
  const db = getDb();
  const now = input.now ?? currentDate();
  const code = input.code ?? "MIGRATION_TRANSPORT_PROVISION_FAILED";
  return await db.transaction(async (tx) => {
    const [updated] = await tx.update(agentMigrations)
      .set({
        state: "failed",
        failureReason: code,
        transportProvisionFailedAt: now,
        transportTeardownAt: now,
        transportErrorCode: code,
        transportErrorMessage: input.message ?? null,
        revision: sql`${agentMigrations.revision} + 1`,
        updatedAt: now,
      })
      .where(and(eq(agentMigrations.id, input.migrationId), eq(agentMigrations.state, "provisioning")))
      .returning();
    if (!updated) return null;
    await enqueueAgentMigrationFailedReceipt(tx, updated, now);
    return updated;
  });
}

export async function markAgentMigrationTransportLost(input: {
  migrationId: string;
  message?: string | null;
  now?: Date;
}): Promise<AgentMigrationRow | null> {
  const db = getDb();
  const now = input.now ?? currentDate();
  return await db.transaction(async (tx) => {
    const [updated] = await tx.update(agentMigrations)
      .set({
        state: "failed",
        failureReason: "MIGRATION_TRANSPORT_LOST",
        transportLostAt: now,
        transportTeardownAt: now,
        transportErrorCode: "MIGRATION_TRANSPORT_LOST",
        transportErrorMessage: input.message ?? null,
        revision: sql`${agentMigrations.revision} + 1`,
        updatedAt: now,
      })
      .where(and(
        eq(agentMigrations.id, input.migrationId),
        inArray(agentMigrations.state, [...TRANSFER_ACTIVE_AGENT_MIGRATION_STATES]),
      ))
      .returning();
    if (!updated) return null;
    await enqueueAgentMigrationFailedReceipt(tx, updated, now);
    return updated;
  });
}

export async function markAgentMigrationTransportLostForComputer(input: {
  migrationId: string;
  serverId: string;
  machineId: string;
  code?: AgentMigrationTransportFailureCode;
  message?: string | null;
  now?: Date;
}): Promise<AgentMigrationRow> {
  const db = getDb();
  const now = input.now ?? currentDate();
  return await db.transaction(async (tx) => {
    const [row] = await tx.select().from(agentMigrations).where(eq(agentMigrations.id, input.migrationId)).limit(1);
    if (
      !row
      || row.serverId !== input.serverId
      || (row.sourceMachineId !== input.machineId && row.targetMachineId !== input.machineId)
    ) {
      throw new Error("MIGRATION_NOT_FOUND");
    }
    const code = input.code ?? "MIGRATION_TRANSPORT_LOST";
    if (row.state === "failed" && row.transportErrorCode === code) {
      return row;
    }
    if (!isTransferActiveState(row.state)) {
      throw new Error("MIGRATION_NOT_ACTIVE");
    }

    const [updated] = await tx.update(agentMigrations)
      .set({
        state: "failed",
        failureReason: code,
        transportLostAt: now,
        transportTeardownAt: now,
        transportErrorCode: code,
        transportErrorMessage: input.message ?? null,
        revision: row.revision + 1,
        updatedAt: now,
      })
      .where(and(eq(agentMigrations.id, row.id), eq(agentMigrations.revision, row.revision)))
      .returning();
    if (!updated) throw new Error("MIGRATION_CONCURRENT_UPDATE");
    await enqueueAgentMigrationFailedReceipt(tx, updated, now);
    return updated;
  });
}

export async function markAgentMigrationSourceReadyForComputer(input: {
  migrationId: string;
  serverId: string;
  sourceMachineId: string;
  manifestPath: string;
  manifestSha256?: string | null;
  transferSummary: AgentMigrationTransferSummary;
  now?: Date;
}): Promise<AgentMigrationRow> {
  const db = getDb();
  const now = input.now ?? currentDate();
  return await db.transaction(async (tx) => {
    const [row] = await tx.select().from(agentMigrations).where(eq(agentMigrations.id, input.migrationId)).limit(1);
    if (!row || row.serverId !== input.serverId || row.sourceMachineId !== input.sourceMachineId) {
      throw new Error("MIGRATION_NOT_FOUND");
    }
    const transferSummary = agentMigrationTransferSummarySchema.parse(input.transferSummary);
    if (
      row.state === "ready"
      && row.manifestPath === input.manifestPath
      && row.manifestSha256 === (input.manifestSha256 ?? null)
      && isDeepStrictEqual(row.transferSummary, transferSummary)
    ) {
      return row;
    }
    if (row.state !== "provisioning" && row.state !== "prep") throw new Error("MIGRATION_NOT_IN_PREP");
    if (now.getTime() > row.prepDeadlineAt.getTime()) throw new Error("MIGRATION_PREP_DEADLINE_EXPIRED");

    const [updated] = await tx.update(agentMigrations)
      .set({
        state: "ready",
        manifestPath: input.manifestPath,
        manifestSha256: input.manifestSha256 ?? null,
        transferSummary,
        transportProvisionedAt: row.transportProvisionedAt ?? now,
        transportErrorCode: null,
        transportErrorMessage: null,
        readyAt: now,
        revision: row.revision + 1,
        updatedAt: now,
      })
      .where(and(eq(agentMigrations.id, row.id), eq(agentMigrations.revision, row.revision)))
      .returning();
    if (!updated) throw new Error("MIGRATION_CONCURRENT_UPDATE");
    return updated;
  });
}

export async function markAgentMigrationReady(input: {
  grantKey: string;
  manifestPath: string;
  manifestSha256?: string | null;
  now?: Date;
}): Promise<AgentMigrationRow> {
  const db = getDb();
  const now = input.now ?? currentDate();
  return await db.transaction(async (tx) => {
    const [row] = await tx.select().from(agentMigrations).where(eq(agentMigrations.grantKey, input.grantKey)).limit(1);
    if (!row) throw new Error("MIGRATION_NOT_FOUND");
    if (row.state !== "prep") throw new Error("MIGRATION_NOT_IN_PREP");
    if (now.getTime() > row.prepDeadlineAt.getTime()) throw new Error("MIGRATION_PREP_DEADLINE_EXPIRED");

    const [updated] = await tx.update(agentMigrations)
      .set({
        state: "ready",
        manifestPath: input.manifestPath,
        manifestSha256: input.manifestSha256 ?? null,
        readyAt: now,
        revision: row.revision + 1,
        updatedAt: now,
      })
      .where(and(eq(agentMigrations.id, row.id), eq(agentMigrations.revision, row.revision)))
      .returning();
    if (!updated) throw new Error("MIGRATION_CONCURRENT_UPDATE");
    return updated;
  });
}

export async function getAgentMigrationTargetImport(input: {
  grantKey: string;
  serverId: string;
  targetMachineId: string;
}): Promise<AgentMigrationTargetImportView> {
  const db = getDb();
  const [row] = await db.select().from(agentMigrations).where(eq(agentMigrations.grantKey, input.grantKey)).limit(1);
  return targetImportView(assertTargetImportRow({ row, serverId: input.serverId, targetMachineId: input.targetMachineId }));
}

export async function getAgentMigrationTargetImportById(input: {
  migrationId: string;
  serverId: string;
  targetMachineId: string;
}): Promise<AgentMigrationTargetImportView> {
  const db = getDb();
  const [row] = await db.select().from(agentMigrations).where(eq(agentMigrations.id, input.migrationId)).limit(1);
  return targetImportView(assertTargetImportRow({ row, serverId: input.serverId, targetMachineId: input.targetMachineId }));
}

export async function assertAgentMigrationTargetArrivalArchivable(input: {
  grantKey: string;
  migrationGeneration: string;
  serverId: string;
  targetMachineId: string;
  now?: Date;
}): Promise<AgentMigrationTargetImportView> {
  const db = getDb();
  const now = input.now ?? currentDate();
  return await db.transaction(async (tx) => {
    const [row] = await tx.select().from(agentMigrations).where(eq(agentMigrations.grantKey, input.grantKey)).limit(1);
    const migration = assertTargetImportRow({ row, serverId: input.serverId, targetMachineId: input.targetMachineId });
    const archivableState = migration.state === "arriving"
      || migration.state === "starting"
      || migration.state === "completed";
    if (
      archivableState
      && migration.sourceWorkspaceArchivedAt
      && await isAgentHeldByTarget(tx, migration)
    ) {
      return targetImportView(migration);
    }
    assertMigrationGeneration(migration, input.migrationGeneration);
    if (!archivableState) throw new Error("MIGRATION_NOT_ARRIVING");
    if (
      migration.state === "arriving"
      && now.getTime() > migration.arrivalDeadlineAt.getTime()
    ) {
      throw new Error("MIGRATION_ARRIVAL_DEADLINE_EXPIRED");
    }
    if (!await isAgentHeldByTarget(tx, migration)) throw new Error("MIGRATION_SOURCE_MACHINE_MISMATCH");
    return targetImportView(migration);
  });
}

export async function recordAgentMigrationSourceWorkspaceArchived(input: {
  grantKey: string;
  migrationGeneration: string;
  serverId: string;
  targetMachineId: string;
  now?: Date;
}): Promise<AgentMigrationTargetImportView> {
  const db = getDb();
  const now = input.now ?? currentDate();
  return await db.transaction(async (tx) => {
    const [row] = await tx.select().from(agentMigrations).where(eq(agentMigrations.grantKey, input.grantKey)).limit(1);
    const migration = assertTargetImportRow({ row, serverId: input.serverId, targetMachineId: input.targetMachineId });
    if (
      migration.sourceWorkspaceArchivedAt
      && (migration.state === "arriving" || migration.state === "starting" || migration.state === "completed")
      && await isAgentHeldByTarget(tx, migration)
    ) {
      return targetImportView(migration);
    }
    assertMigrationGeneration(migration, input.migrationGeneration);
    if (migration.state !== "arriving" && migration.state !== "starting" && migration.state !== "completed") {
      throw new Error("MIGRATION_NOT_ARRIVING");
    }
    if (!await isAgentHeldByTarget(tx, migration)) throw new Error("MIGRATION_SOURCE_MACHINE_MISMATCH");

    const [updated] = await tx.update(agentMigrations)
      .set({
        sourceWorkspaceArchivedAt: now,
        revision: migration.revision + 1,
        updatedAt: now,
      })
      .where(and(
        eq(agentMigrations.id, migration.id),
        eq(agentMigrations.revision, migration.revision),
        isNull(agentMigrations.sourceWorkspaceArchivedAt),
      ))
      .returning();
    if (updated) return targetImportView(updated);

    const [current] = await tx.select().from(agentMigrations).where(eq(agentMigrations.id, migration.id)).limit(1);
    if (
      current?.sourceWorkspaceArchivedAt
      && (current.state === "arriving" || current.state === "starting" || current.state === "completed")
      && await isAgentHeldByTarget(tx, current)
    ) {
      return targetImportView(current);
    }
    throw new Error("MIGRATION_CONCURRENT_UPDATE");
  });
}

export async function startAgentMigrationTargetImport(input: {
  grantKey: string;
  migrationGeneration: string;
  serverId: string;
  targetMachineId: string;
  now?: Date;
}): Promise<AgentMigrationTargetImportView> {
  const db = getDb();
  const now = input.now ?? currentDate();
  return await db.transaction(async (tx) => {
    const [row] = await tx.select().from(agentMigrations).where(eq(agentMigrations.grantKey, input.grantKey)).limit(1);
    const migration = assertTargetImportRow({ row, serverId: input.serverId, targetMachineId: input.targetMachineId });
    assertMigrationGeneration(migration, input.migrationGeneration);
    if (migration.state !== "ready") throw new Error("MIGRATION_NOT_READY");
    if (now.getTime() > migration.transferDeadlineAt.getTime()) throw new Error("MIGRATION_TRANSFER_DEADLINE_EXPIRED");

    const [updated] = await tx.update(agentMigrations)
      .set({ state: "in_transit", revision: migration.revision + 1, updatedAt: now })
      .where(and(eq(agentMigrations.id, migration.id), eq(agentMigrations.revision, migration.revision)))
      .returning();
    if (!updated) throw new Error("MIGRATION_CONCURRENT_UPDATE");
    return targetImportView(updated);
  });
}

export async function flipAgentMigrationTargetImport(input: {
  grantKey: string;
  migrationGeneration: string;
  serverId: string;
  targetMachineId: string;
  now?: Date;
}): Promise<AgentMigrationTargetImportView> {
  const db = getDb();
  const now = input.now ?? currentDate();
  return await db.transaction(async (tx) => {
    const [row] = await tx.select().from(agentMigrations).where(eq(agentMigrations.grantKey, input.grantKey)).limit(1);
    const migration = assertTargetImportRow({ row, serverId: input.serverId, targetMachineId: input.targetMachineId });
    if ((migration.state === "arriving" || migration.state === "completed") && await isAgentHeldByTarget(tx, migration)) {
      return targetImportView(migration);
    }
    assertMigrationGeneration(migration, input.migrationGeneration);
    if (migration.state !== "in_transit") throw new Error("MIGRATION_NOT_FLIPPABLE");
    if (now.getTime() > migration.transferDeadlineAt.getTime()) throw new Error("MIGRATION_TRANSFER_DEADLINE_EXPIRED");
    const nextArrivalDeadlineAt = addMs(now, arrivalWindowMs(migration));

    const [updatedAgent] = await tx.update(agents)
      .set({ machineId: migration.targetMachineId, updatedAt: now })
      .where(and(
        eq(agents.id, migration.agentId),
        eq(agents.machineId, migration.sourceMachineId),
        isNull(agents.deletedAt),
        sql`EXISTS (
          SELECT 1
          FROM ${agentMigrations}
          WHERE ${agentMigrations.id} = ${migration.id}
            AND ${agentMigrations.revision} = ${migration.revision}
            AND ${agentMigrations.state} = 'in_transit'
        )`,
      ))
      .returning({ id: agents.id });
    if (!updatedAgent) {
      const [current] = await tx.select().from(agentMigrations).where(eq(agentMigrations.id, migration.id)).limit(1);
      if (current && (current.state === "arriving" || current.state === "completed") && await isAgentHeldByTarget(tx, current)) {
        return targetImportView(current);
      }
      throw new Error("MIGRATION_SOURCE_MACHINE_MISMATCH");
    }

    const [updated] = await tx.update(agentMigrations)
      .set({
        state: "arriving",
        flippedAt: now,
        arrivalDeadlineAt: nextArrivalDeadlineAt,
        revision: migration.revision + 1,
        updatedAt: now,
      })
      .where(and(
        eq(agentMigrations.id, migration.id),
        eq(agentMigrations.revision, migration.revision),
        eq(agentMigrations.state, "in_transit"),
      ))
      .returning();
    if (!updated) throw new Error("MIGRATION_CONCURRENT_UPDATE");
    return targetImportView(updated);
  });
}

export async function markAgentMigrationTargetImportArrived(input: {
  grantKey: string;
  migrationGeneration: string;
  serverId: string;
  targetMachineId: string;
  reportPath?: string | null;
  reportSha256?: string | null;
  now?: Date;
}): Promise<AgentMigrationTargetArrivalResult> {
  const db = getDb();
  const now = input.now ?? currentDate();
  return await db.transaction(async (tx) => {
    const [row] = await tx.select().from(agentMigrations).where(eq(agentMigrations.grantKey, input.grantKey)).limit(1);
    const migration = assertTargetImportRow({ row, serverId: input.serverId, targetMachineId: input.targetMachineId });
    if (migration.state === "completed" && await isAgentHeldByTarget(tx, migration)) {
      return { migration: targetImportView(migration), autoStart: "none" };
    }
    if (migration.state === "starting" && await isAgentHeldByTarget(tx, migration)) {
      if (migration.failureReason === null) {
        if (now.getTime() < migration.updatedAt.getTime() + AGENT_MIGRATION_AUTO_START_LEASE_MS) {
          return { migration: targetImportView(migration), autoStart: "observe" };
        }
        const [reclaimed] = await tx.update(agentMigrations)
          .set({
            revision: migration.revision + 1,
            updatedAt: now,
          })
          .where(and(
            eq(agentMigrations.id, migration.id),
            eq(agentMigrations.revision, migration.revision),
            eq(agentMigrations.state, "starting"),
            isNull(agentMigrations.failureReason),
          ))
          .returning();
        if (reclaimed) return { migration: targetImportView(reclaimed), autoStart: "dispatch" };
        const [current] = await tx.select().from(agentMigrations).where(eq(agentMigrations.id, migration.id)).limit(1);
        if (!current) throw new Error("MIGRATION_NOT_FOUND");
        return { migration: targetImportView(current), autoStart: "observe" };
      }
      if (migration.failureReason !== "auto_start_failed") {
        return { migration: targetImportView(migration), autoStart: "observe" };
      }
      const [claimed] = await tx.update(agentMigrations)
        .set({
          failureReason: null,
          autoStartRemediationLeaseId: null,
          autoStartRemediationLeaseExpiresAt: null,
          revision: migration.revision + 1,
          updatedAt: now,
        })
        .where(and(
          eq(agentMigrations.id, migration.id),
          eq(agentMigrations.revision, migration.revision),
          eq(agentMigrations.state, "starting"),
          eq(agentMigrations.failureReason, "auto_start_failed"),
        ))
        .returning();
      if (claimed) return { migration: targetImportView(claimed), autoStart: "dispatch" };
      const [current] = await tx.select().from(agentMigrations).where(eq(agentMigrations.id, migration.id)).limit(1);
      if (!current) throw new Error("MIGRATION_NOT_FOUND");
      return { migration: targetImportView(current), autoStart: "observe" };
    }
    assertMigrationGeneration(migration, input.migrationGeneration);
    if (migration.state !== "arriving") throw new Error("MIGRATION_NOT_ARRIVING");
    if (
      !migration.sourceWorkspaceArchivedAt
      && now.getTime() > migration.arrivalDeadlineAt.getTime()
    ) {
      throw new Error("MIGRATION_ARRIVAL_DEADLINE_EXPIRED");
    }
    if (!await isAgentHeldByTarget(tx, migration)) throw new Error("MIGRATION_SOURCE_MACHINE_MISMATCH");
    await finalizeAgentHolderProjection(tx, migration, now);
    await finalizeRuntimeProfileProjection(tx, migration, now);

    const [updated] = await tx.update(agentMigrations)
      .set({
        state: "starting",
        arrivalReportPath: input.reportPath ?? null,
        arrivalReportSha256: input.reportSha256 ?? null,
        failureReason: null,
        autoStartRemediationLeaseId: null,
        autoStartRemediationLeaseExpiresAt: null,
        arrivedAt: now,
        revision: migration.revision + 1,
        updatedAt: now,
      })
      .where(and(
        eq(agentMigrations.id, migration.id),
        eq(agentMigrations.revision, migration.revision),
        eq(agentMigrations.state, "arriving"),
      ))
      .returning();
    if (!updated) {
      const [current] = await tx.select().from(agentMigrations).where(eq(agentMigrations.id, migration.id)).limit(1);
      if (current && (current.state === "starting" || current.state === "completed") && await isAgentHeldByTarget(tx, current)) {
        return {
          migration: targetImportView(current),
          autoStart: current.state === "completed"
            ? "none"
            : current.failureReason === "auto_start_failed"
              ? "dispatch"
              : "observe",
        };
      }
      throw new Error("MIGRATION_CONCURRENT_UPDATE");
    }
    return { migration: targetImportView(updated), autoStart: "dispatch" };
  });
}

export async function completeAgentMigrationAutoStart(input: {
  grantKey: string;
  agentId: string;
  targetMachineId: string;
  remediationLeaseId?: string | null;
  now?: Date;
}, receiptHooks: AgentMigrationReceiptEnqueueHooks = {}): Promise<AgentMigrationRow> {
  const db = getDb();
  const now = input.now ?? currentDate();
  return await db.transaction(async (tx) => {
    const [row] = await tx.select().from(agentMigrations).where(eq(agentMigrations.grantKey, input.grantKey)).limit(1);
    if (!row || row.agentId !== input.agentId || row.targetMachineId !== input.targetMachineId) {
      throw new Error("MIGRATION_NOT_FOUND");
    }
    if (!row.sourceWorkspaceArchivedAt) {
      throw new Error("MIGRATION_SOURCE_WORKSPACE_ARCHIVE_PENDING");
    }
    if (row.state === "completed" && await isAgentHeldByTarget(tx, row)) return row;
    if (row.state !== "starting") throw new Error("MIGRATION_NOT_STARTING");
    if (!await isAgentHeldByTarget(tx, row)) throw new Error("MIGRATION_SOURCE_MACHINE_MISMATCH");

    if (input.remediationLeaseId) {
      const ownsLiveLease =
        row.autoStartRemediationLeaseId === input.remediationLeaseId
        && row.autoStartRemediationLeaseExpiresAt
        && row.autoStartRemediationLeaseExpiresAt.getTime() > now.getTime();
      if (!ownsLiveLease) {
        throw new Error("MIGRATION_AUTO_START_REMEDIATION_LEASE_STALE");
      }
    }

    const [updated] = await tx.update(agentMigrations)
      .set({
        state: "completed",
        failureReason: null,
        autoStartRemediationLeaseId: null,
        autoStartRemediationLeaseExpiresAt: null,
        completedAt: now,
        transportTeardownAt: now,
        revision: row.revision + 1,
        updatedAt: now,
      })
      .where(and(
        eq(agentMigrations.id, row.id),
        eq(agentMigrations.revision, row.revision),
        eq(agentMigrations.state, "starting"),
        ...(input.remediationLeaseId
          ? [
              eq(agentMigrations.autoStartRemediationLeaseId, input.remediationLeaseId),
              gt(agentMigrations.autoStartRemediationLeaseExpiresAt, now),
            ]
          : []),
      ))
      .returning();
    if (!updated) throw new Error("MIGRATION_CONCURRENT_UPDATE");
    await enqueueAgentMigrationCompletedReceipt(tx, updated, now, receiptHooks);
    return updated;
  });
}

export async function recordAgentMigrationAutoStartFailure(input: {
  grantKey: string;
  agentId: string;
  targetMachineId: string;
  stage: AgentMigrationAutoStartFailureStage;
  code: AgentMigrationAutoStartFailureCode;
  remediationLeaseId?: string | null;
  now?: Date;
}): Promise<AgentMigrationRow> {
  const db = getDb();
  const now = input.now ?? currentDate();
  return await db.transaction(async (tx) => {
    const [row] = await tx.select().from(agentMigrations).where(eq(agentMigrations.grantKey, input.grantKey)).limit(1);
    if (!row || row.agentId !== input.agentId || row.targetMachineId !== input.targetMachineId) {
      throw new Error("MIGRATION_NOT_FOUND");
    }
    if (row.state === "completed" && await isAgentHeldByTarget(tx, row)) return row;
    if (row.state !== "starting") throw new Error("MIGRATION_NOT_STARTING");
    if (input.remediationLeaseId) {
      const ownsLiveLease =
        row.autoStartRemediationLeaseId === input.remediationLeaseId
        && row.autoStartRemediationLeaseExpiresAt
        && row.autoStartRemediationLeaseExpiresAt.getTime() > now.getTime();
      if (!ownsLiveLease) {
        throw new Error("MIGRATION_AUTO_START_REMEDIATION_LEASE_STALE");
      }
    }
    const [updated] = await tx.update(agentMigrations)
      .set({
        failureReason: "auto_start_failed",
        autoStartFailureStage: input.stage,
        autoStartFailureCode: input.code,
        revision: row.revision + 1,
        updatedAt: now,
      })
      .where(and(
        eq(agentMigrations.id, row.id),
        eq(agentMigrations.revision, row.revision),
        eq(agentMigrations.state, "starting"),
        ...(input.remediationLeaseId
          ? [
              eq(agentMigrations.autoStartRemediationLeaseId, input.remediationLeaseId),
              gt(agentMigrations.autoStartRemediationLeaseExpiresAt, now),
            ]
          : []),
      ))
      .returning();
    if (!updated) throw new Error("MIGRATION_CONCURRENT_UPDATE");
    return updated;
  });
}

export async function claimAgentMigrationAutoStartRemediation(input: {
  executor: AgentMigrationAutoStartRemediationExecutor;
  workerId: string;
  now?: Date;
  leaseMs?: number;
}): Promise<AgentMigrationAutoStartRemediationClaim | null> {
  if (input.executor !== "server" && input.executor !== "healthy_steward") {
    throw new Error("MIGRATION_AUTO_START_REMEDIATION_EXECUTOR_INVALID");
  }
  const db = getDb();
  const now = input.now ?? currentDate();
  const leaseMs = input.leaseMs ?? AGENT_MIGRATION_AUTO_START_REMEDIATION_LEASE_MS;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("MIGRATION_AUTO_START_REMEDIATION_LEASE_INVALID");

  return await db.transaction(async (tx) => {
    const typedFailedPredicate = and(
      eq(agentMigrations.failureReason, "auto_start_failed"),
      sql`${agentMigrations.autoStartFailureStage} IS NOT NULL`,
      sql`${agentMigrations.autoStartFailureCode} IS NOT NULL`,
    );
    const orphanedDispatchPredicate = and(
      isNull(agentMigrations.failureReason),
      sql`${agentMigrations.autoStartFailureStage} IS NOT NULL`,
      sql`${agentMigrations.autoStartFailureCode} IS NOT NULL`,
      sql`${agentMigrations.autoStartRemediationLeaseId} IS NOT NULL`,
      lte(agentMigrations.autoStartRemediationLeaseExpiresAt, now),
    );
    const [candidate] = await tx.select()
      .from(agentMigrations)
      .where(and(
        eq(agentMigrations.state, "starting"),
        or(typedFailedPredicate, orphanedDispatchPredicate),
        or(
          isNull(agentMigrations.autoStartRemediationLeaseExpiresAt),
          lte(agentMigrations.autoStartRemediationLeaseExpiresAt, now),
        ),
      ))
      .orderBy(asc(agentMigrations.autoStartLastRetryAt), asc(agentMigrations.updatedAt))
      .for("update")
      .limit(1);
    if (!candidate) return null;
    const candidateVariant: AgentMigrationAutoStartRemediationCandidateVariant =
      candidate.failureReason === "auto_start_failed" ? "typed_failed" : "orphaned_dispatch";
    const candidateVariantPredicate = candidateVariant === "typed_failed"
      ? typedFailedPredicate
      : orphanedDispatchPredicate;
    const candidateLeasePredicate = candidate.autoStartRemediationLeaseId
      ? and(
          eq(agentMigrations.autoStartRemediationLeaseId, candidate.autoStartRemediationLeaseId),
          candidate.autoStartRemediationLeaseExpiresAt
            ? eq(agentMigrations.autoStartRemediationLeaseExpiresAt, candidate.autoStartRemediationLeaseExpiresAt)
            : isNull(agentMigrations.autoStartRemediationLeaseExpiresAt),
        )
      : and(
          isNull(agentMigrations.autoStartRemediationLeaseId),
          isNull(agentMigrations.autoStartRemediationLeaseExpiresAt),
        );

    const deadlineAt = candidate.autoStartRetryDeadlineAt
      ?? new Date(now.getTime() + AGENT_MIGRATION_AUTO_START_REMEDIATION_WINDOW_MS);
    const exhausted =
      candidate.autoStartRetryAttempts >= AGENT_MIGRATION_AUTO_START_MAX_RETRY_ATTEMPTS ||
      now.getTime() >= deadlineAt.getTime();

    if (exhausted) {
      const [terminal] = await tx.update(agentMigrations)
        .set({
          state: "failed",
          failureReason: "auto_start_failed",
          transportTeardownAt: now,
          autoStartRemediationLeaseId: null,
          autoStartRemediationLeaseExpiresAt: null,
          revision: candidate.revision + 1,
          updatedAt: now,
        })
        .where(and(
          eq(agentMigrations.id, candidate.id),
          eq(agentMigrations.revision, candidate.revision),
          eq(agentMigrations.state, "starting"),
          candidateVariantPredicate,
          candidateLeasePredicate,
        ))
        .returning();
      if (!terminal) return null;
      await enqueueAgentMigrationFailedReceipt(tx, terminal, now);
      return { migration: terminal, action: "terminal", leaseId: null, candidateVariant };
    }

    const leaseId = `${input.workerId}:${randomUUID()}`;
    const [claimed] = await tx.update(agentMigrations)
      .set({
        failureReason: null,
        autoStartRetryAttempts: candidate.autoStartRetryAttempts + 1,
        autoStartRetryDeadlineAt: deadlineAt,
        autoStartLastRetryAt: now,
        autoStartRemediationLeaseId: leaseId,
        autoStartRemediationLeaseExpiresAt: new Date(now.getTime() + leaseMs),
        revision: candidate.revision + 1,
        updatedAt: now,
      })
      .where(and(
        eq(agentMigrations.id, candidate.id),
        eq(agentMigrations.revision, candidate.revision),
        eq(agentMigrations.state, "starting"),
        candidateVariantPredicate,
        candidateLeasePredicate,
      ))
      .returning();
    if (!claimed) return null;
    return { migration: claimed, action: "dispatch", leaseId, candidateVariant };
  });
}

export async function startAgentMigrationTransfer(grantKey: string, now = currentDate()): Promise<AgentMigrationRow> {
  const db = getDb();
  return await db.transaction(async (tx) => {
    const [row] = await tx.select().from(agentMigrations).where(eq(agentMigrations.grantKey, grantKey)).limit(1);
    if (!row) throw new Error("MIGRATION_NOT_FOUND");
    if (row.state !== "ready") throw new Error("MIGRATION_NOT_READY");
    if (now.getTime() > row.transferDeadlineAt.getTime()) throw new Error("MIGRATION_TRANSFER_DEADLINE_EXPIRED");

    const [updated] = await tx.update(agentMigrations)
      .set({ state: "in_transit", revision: row.revision + 1, updatedAt: now })
      .where(and(eq(agentMigrations.id, row.id), eq(agentMigrations.revision, row.revision)))
      .returning();
    if (!updated) throw new Error("MIGRATION_CONCURRENT_UPDATE");
    return updated;
  });
}

export async function flipAgentMigrationMachine(grantKey: string, now = currentDate()): Promise<AgentMigrationRow> {
  const db = getDb();
  return await db.transaction(async (tx) => {
    const [row] = await tx.select().from(agentMigrations).where(eq(agentMigrations.grantKey, grantKey)).limit(1);
    if (!row) throw new Error("MIGRATION_NOT_FOUND");
    if ((row.state === "arriving" || row.state === "completed") && await isAgentHeldByTarget(tx, row)) return row;
    if (row.state !== "in_transit") throw new Error("MIGRATION_NOT_FLIPPABLE");
    if (now.getTime() > row.transferDeadlineAt.getTime()) throw new Error("MIGRATION_TRANSFER_DEADLINE_EXPIRED");
    const nextArrivalDeadlineAt = addMs(now, arrivalWindowMs(row));

    const [updatedAgent] = await tx.update(agents)
      .set({ machineId: row.targetMachineId, updatedAt: now })
      .where(and(
        eq(agents.id, row.agentId),
        eq(agents.machineId, row.sourceMachineId),
        isNull(agents.deletedAt),
        sql`EXISTS (
          SELECT 1
          FROM ${agentMigrations}
          WHERE ${agentMigrations.id} = ${row.id}
            AND ${agentMigrations.revision} = ${row.revision}
            AND ${agentMigrations.state} = 'in_transit'
        )`,
      ))
      .returning({ id: agents.id });
    if (!updatedAgent) {
      const [current] = await tx.select().from(agentMigrations).where(eq(agentMigrations.id, row.id)).limit(1);
      if (current && (current.state === "arriving" || current.state === "completed") && await isAgentHeldByTarget(tx, current)) {
        return current;
      }
      throw new Error("MIGRATION_SOURCE_MACHINE_MISMATCH");
    }

    const [updated] = await tx.update(agentMigrations)
      .set({
        state: "arriving",
        flippedAt: now,
        arrivalDeadlineAt: nextArrivalDeadlineAt,
        revision: row.revision + 1,
        updatedAt: now,
      })
      .where(and(
        eq(agentMigrations.id, row.id),
        eq(agentMigrations.revision, row.revision),
        eq(agentMigrations.state, "in_transit"),
      ))
      .returning();
    if (!updated) throw new Error("MIGRATION_CONCURRENT_UPDATE");
    return updated;
  });
}

function cancellationDispositionFor(row: AgentMigrationRow): AgentMigrationCancelDisposition {
  return row.flippedAt
    || row.state === "arriving"
    || row.state === "starting"
    || row.state === "completed"
    || row.state === "cancel_requested_post_flip"
    || row.state === "canceled_post_flip"
    ? "post_flip_target_authoritative"
    : "pre_flip_source_authoritative";
}

function cancellationSuccessOutcomeFor(
  disposition: AgentMigrationCancelDisposition,
  role: AgentMigrationCancelRole,
): "cleaned" | "stopped" {
  return disposition === "post_flip_target_authoritative" && role === "target"
    ? "stopped"
    : "cleaned";
}

function canceledStateFor(disposition: AgentMigrationCancelDisposition): Extract<AgentMigrationState, "canceled_pre_flip" | "canceled_post_flip"> {
  return disposition === "pre_flip_source_authoritative" ? "canceled_pre_flip" : "canceled_post_flip";
}

function cancellationCleanupPending(row: Pick<AgentMigrationRow,
  "state" | "cancelGeneration" | "cancelTransportGeneration" | "cancelDisposition" | "cancelSourceAckAt" | "cancelTargetAckAt" | "cancelNeedsAttentionAt"
>): boolean {
  return (row.state === "canceled_pre_flip" || row.state === "canceled_post_flip")
    && Boolean(row.cancelGeneration)
    && Boolean(row.cancelTransportGeneration)
    && Boolean(row.cancelDisposition)
    && !row.cancelNeedsAttentionAt
    && (!row.cancelSourceAckAt || !row.cancelTargetAckAt);
}

function terminalCleanupError(row: Pick<AgentMigrationRow, "cancelAttentionDeadlineAt" | "cancelDispatchAttempts">, now: Date): string | null {
  if (row.cancelAttentionDeadlineAt && now.getTime() > row.cancelAttentionDeadlineAt.getTime()) {
    return "cancel_ack_deadline_exceeded";
  }
  if (row.cancelDispatchAttempts >= AGENT_MIGRATION_CANCEL_MAX_DISPATCH_ATTEMPTS) {
    return "cancel_dispatch_retry_exhausted";
  }
  return null;
}

export function projectAgentMigrationUpdatedPayload(row: AgentMigrationRow): AgentMigrationUpdatedPayload {
  const disposition = row.cancelDisposition ?? (
    row.state === "cancel_requested_pre_flip" || row.state === "canceled_pre_flip"
      ? "pre_flip_source_authoritative"
      : row.state === "cancel_requested_post_flip" || row.state === "canceled_post_flip"
        ? "post_flip_target_authoritative"
        : null
  );
  return {
    agentId: row.agentId,
    migrationRef: row.supportRef,
    state: row.state,
    revision: row.revision,
    authority: cancellationDispositionFor(row) === "post_flip_target_authoritative" ? "target" : "source",
    disposition,
    needsAttention: Boolean(row.cancelNeedsAttentionAt),
    dispatchAttempts: row.cancelDispatchAttempts,
    attentionDeadlineAt: row.cancelAttentionDeadlineAt?.toISOString() ?? null,
    sourceAcknowledgedAt: row.cancelSourceAckAt?.toISOString() ?? null,
    targetAcknowledgedAt: row.cancelTargetAckAt?.toISOString() ?? null,
    targetOutcome: row.cancelTargetOutcome,
    canceledAt: row.canceledAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function buildAgentMigrationCancellationDeliveries(
  row: AgentMigrationRow,
): Array<{ machineId: string; message: AgentMigrationCancelMessage }> {
  if (
    (row.state !== "cancel_requested_pre_flip"
      && row.state !== "cancel_requested_post_flip"
      && row.state !== "canceled_pre_flip"
      && row.state !== "canceled_post_flip")
    || !row.cancelGeneration
    || !row.cancelTransportGeneration
    || !row.cancelDisposition
  ) {
    throw new Error("MIGRATION_CANCEL_NOT_REQUESTED");
  }
  const base = {
    type: "machine:migration:cancel" as const,
    agentId: row.agentId,
    migrationId: row.id,
    migrationRef: row.supportRef,
    transportGeneration: row.cancelTransportGeneration,
    cancelGeneration: row.cancelGeneration,
    migrationRevision: row.revision,
    sessionId: row.transportSessionId,
    disposition: row.cancelDisposition,
  };
  return [
    {
      machineId: row.sourceMachineId,
      message: { ...base, role: "source", stopAgent: false },
    },
    {
      machineId: row.targetMachineId,
      message: {
        ...base,
        role: "target",
        stopAgent: row.cancelDisposition === "post_flip_target_authoritative",
      },
    },
  ];
}

export async function requestAgentMigrationCancellation(input: {
  agentId: string;
  migrationRef: string;
  expectedRevision: number;
  initiatedByUserId: string;
  reason: string;
  now?: Date;
}): Promise<AgentMigrationCancellationRequestResult> {
  const db = getDb();
  const now = input.now ?? currentDate();
  return await db.transaction(async (tx) => {
    const [row] = await tx.select()
      .from(agentMigrations)
      .where(and(
        eq(agentMigrations.agentId, input.agentId),
        eq(agentMigrations.supportRef, input.migrationRef),
      ))
      .for("update")
      .limit(1);
    if (!row) throw new Error("MIGRATION_NOT_FOUND");

    const disposition = row.cancelDisposition ?? cancellationDispositionFor(row);
    if (row.state === "cancel_requested_pre_flip" || row.state === "cancel_requested_post_flip") {
      const errorCode = terminalCleanupError(row, now);
      const [terminal] = await tx.update(agentMigrations)
        .set({
          state: canceledStateFor(disposition),
          cancelNeedsAttentionAt: errorCode ? now : row.cancelNeedsAttentionAt,
          cancelErrorCode: errorCode ?? row.cancelErrorCode,
          cancelErrorMessage: errorCode
            ? "Cancellation cleanup did not complete inside the bounded retry window"
            : row.cancelErrorMessage,
          canceledAt: row.canceledAt ?? now,
          transportTeardownAt: row.transportTeardownAt ?? now,
          cancelCleanupLeaseId: null,
          cancelCleanupLeaseExpiresAt: null,
          revision: row.revision + 1,
          updatedAt: now,
        })
        .where(eq(agentMigrations.id, row.id))
        .returning();
      if (!terminal) throw new Error("MIGRATION_CONCURRENT_UPDATE");
      await enqueueAgentMigrationCanceledReceipt(tx, terminal, now);
      return { migration: terminal, disposition, dispatch: errorCode ? "none" : "required" };
    }
    if (
      row.state === "canceled_pre_flip"
      || row.state === "canceled_post_flip"
      || row.state === "completed"
      || row.state === "aborted"
      || row.state === "failed"
    ) {
      return { migration: row, disposition, dispatch: "none" };
    }
    if (row.revision !== input.expectedRevision) throw new Error("MIGRATION_REVISION_STALE");

    const [updated] = await tx.update(agentMigrations)
      .set({
        state: canceledStateFor(disposition),
        cancelGeneration: createMigrationCancelGeneration(),
        cancelTransportGeneration: row.transportGeneration ?? agentMigrationGeneration(row),
        cancelDisposition: disposition,
        cancelRequestedAt: now,
        cancelRequestedByUserId: input.initiatedByUserId,
        cancelReason: input.reason,
        cancelDispatchAttempts: 1,
        cancelLastDispatchAt: now,
        cancelAttentionDeadlineAt: addMs(now, AGENT_MIGRATION_CANCEL_ATTENTION_WINDOW_MS),
        cancelSourceAckAt: null,
        cancelSourceOutcome: null,
        cancelTargetAckAt: null,
        cancelTargetOutcome: null,
        cancelNeedsAttentionAt: null,
        cancelErrorCode: null,
        cancelErrorMessage: null,
        cancelCleanupLeaseId: null,
        cancelCleanupLeaseExpiresAt: null,
        canceledAt: now,
        transportTeardownAt: now,
        revision: row.revision + 1,
        updatedAt: now,
      })
      .where(eq(agentMigrations.id, row.id))
      .returning();
    if (!updated) throw new Error("MIGRATION_CONCURRENT_UPDATE");
    await enqueueAgentMigrationCanceledReceipt(tx, updated, now);
    return { migration: updated, disposition, dispatch: "required" };
  });
}

export async function acknowledgeAgentMigrationCancellation(input: {
  migrationId: string;
  migrationRef: string;
  transportGeneration: string;
  cancelGeneration: string;
  serverId: string;
  machineId: string;
  role: AgentMigrationCancelRole;
  outcome: "cleaned" | "stopped" | "needs_attention";
  cleanupLeaseId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  now?: Date;
}): Promise<AgentMigrationRow> {
  const db = getDb();
  const now = input.now ?? currentDate();
  return await db.transaction(async (tx) => {
    const [row] = await tx.select()
      .from(agentMigrations)
      .where(eq(agentMigrations.id, input.migrationId))
      .for("update")
      .limit(1);
    const expectedMachineId = input.role === "source" ? row?.sourceMachineId : row?.targetMachineId;
    if (
      !row
      || row.supportRef !== input.migrationRef
      || row.serverId !== input.serverId
      || expectedMachineId !== input.machineId
    ) {
      throw new Error("MIGRATION_NOT_FOUND");
    }
    if (!row.cancelGeneration || row.cancelGeneration !== input.cancelGeneration) {
      throw new Error("MIGRATION_CANCEL_GENERATION_STALE");
    }
    if (!row.cancelTransportGeneration || row.cancelTransportGeneration !== input.transportGeneration) {
      throw new Error("MIGRATION_GENERATION_STALE");
    }
    const cancellationState = row.state === "cancel_requested_pre_flip"
      || row.state === "cancel_requested_post_flip"
      || row.state === "canceled_pre_flip"
      || row.state === "canceled_post_flip";
    if (!cancellationState || !row.cancelDisposition) {
      throw new Error("MIGRATION_CANCEL_NOT_REQUESTED");
    }
    if (
      input.outcome !== "needs_attention"
      && input.outcome !== cancellationSuccessOutcomeFor(row.cancelDisposition, input.role)
    ) {
      throw new Error("MIGRATION_CANCEL_OUTCOME_MISMATCH");
    }
    if (input.outcome === "needs_attention") {
      if (input.cleanupLeaseId) {
        const ownsLiveLease =
          row.cancelCleanupLeaseId === input.cleanupLeaseId
          && row.cancelCleanupLeaseExpiresAt
          && row.cancelCleanupLeaseExpiresAt.getTime() > now.getTime();
        if (!ownsLiveLease) {
          throw new Error("MIGRATION_CANCEL_CLEANUP_LEASE_STALE");
        }
      }
      if (
        row.cancelNeedsAttentionAt
        && row.cancelErrorCode === (input.errorCode ?? "cleanup_incomplete")
        && row.cancelErrorMessage === (input.errorMessage ?? null)
      ) {
        return row;
      }
      const [updated] = await tx.update(agentMigrations)
        .set({
          cancelNeedsAttentionAt: now,
          cancelErrorCode: input.errorCode ?? "cleanup_incomplete",
          cancelErrorMessage: input.errorMessage ?? null,
          cancelCleanupLeaseId: null,
          cancelCleanupLeaseExpiresAt: null,
          revision: row.revision + 1,
          updatedAt: now,
        })
        .where(and(
          eq(agentMigrations.id, row.id),
          ...(input.cleanupLeaseId
            ? [
                eq(agentMigrations.cancelCleanupLeaseId, input.cleanupLeaseId),
                gt(agentMigrations.cancelCleanupLeaseExpiresAt, now),
              ]
            : []),
        ))
        .returning();
      if (!updated) throw new Error("MIGRATION_CONCURRENT_UPDATE");
      return updated;
    }

    const alreadyAcknowledged = input.role === "source" ? row.cancelSourceAckAt : row.cancelTargetAckAt;
    if (alreadyAcknowledged) return row;
    const sourceAckAt = input.role === "source" ? now : row.cancelSourceAckAt;
    const targetAckAt = input.role === "target" ? now : row.cancelTargetAckAt;
    const terminal = Boolean(sourceAckAt && targetAckAt);
    const terminalState = row.state === "cancel_requested_pre_flip" || row.state === "canceled_pre_flip"
      ? "canceled_pre_flip"
      : "canceled_post_flip";
    const [updated] = await tx.update(agentMigrations)
      .set({
        state: terminal ? terminalState : row.state,
        ...(input.role === "source"
          ? { cancelSourceAckAt: now, cancelSourceOutcome: input.outcome }
          : { cancelTargetAckAt: now, cancelTargetOutcome: input.outcome }),
        cancelNeedsAttentionAt: terminal ? null : row.cancelNeedsAttentionAt,
        cancelErrorCode: terminal ? null : row.cancelErrorCode,
        cancelErrorMessage: terminal ? null : row.cancelErrorMessage,
        cancelCleanupLeaseId: terminal ? null : row.cancelCleanupLeaseId,
        cancelCleanupLeaseExpiresAt: terminal ? null : row.cancelCleanupLeaseExpiresAt,
        canceledAt: terminal ? (row.canceledAt ?? now) : row.canceledAt,
        transportTeardownAt: terminal ? now : row.transportTeardownAt,
        revision: row.revision + 1,
        updatedAt: now,
      })
      .where(eq(agentMigrations.id, row.id))
      .returning();
    if (!updated) throw new Error("MIGRATION_CONCURRENT_UPDATE");
    return updated;
  });
}

export async function claimAgentMigrationCancellationCleanup(input: {
  executor: AgentMigrationCancelCleanupExecutor;
  workerId: string;
  now?: Date;
  leaseMs?: number;
}): Promise<AgentMigrationCancellationCleanupClaim | null> {
  if (input.executor !== "server" && input.executor !== "healthy_steward") {
    throw new Error("MIGRATION_CANCEL_CLEANUP_EXECUTOR_INVALID");
  }
  const db = getDb();
  const now = input.now ?? currentDate();
  const leaseMs = input.leaseMs ?? AGENT_MIGRATION_CANCEL_CLEANUP_LEASE_MS;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("MIGRATION_CANCEL_CLEANUP_LEASE_INVALID");

  return await db.transaction(async (tx) => {
    const [candidate] = await tx.select()
      .from(agentMigrations)
      .where(and(
        inArray(agentMigrations.state, ["canceled_pre_flip", "canceled_post_flip"]),
        isNull(agentMigrations.cancelNeedsAttentionAt),
        or(isNull(agentMigrations.cancelSourceAckAt), isNull(agentMigrations.cancelTargetAckAt)),
        or(
          isNull(agentMigrations.cancelCleanupLeaseExpiresAt),
          lte(agentMigrations.cancelCleanupLeaseExpiresAt, now),
        ),
      ))
      .orderBy(asc(agentMigrations.cancelLastDispatchAt), asc(agentMigrations.updatedAt))
      .for("update")
      .limit(1);
    if (!candidate || !cancellationCleanupPending(candidate)) return null;

    const errorCode = terminalCleanupError(candidate, now);
    if (errorCode) {
      const [attention] = await tx.update(agentMigrations)
        .set({
          cancelNeedsAttentionAt: now,
          cancelErrorCode: errorCode,
          cancelErrorMessage: "Cancellation cleanup did not complete inside the bounded retry window",
          cancelCleanupLeaseId: null,
          cancelCleanupLeaseExpiresAt: null,
          revision: candidate.revision + 1,
          updatedAt: now,
        })
        .where(and(
          eq(agentMigrations.id, candidate.id),
          eq(agentMigrations.revision, candidate.revision),
        ))
        .returning();
      if (!attention) throw new Error("MIGRATION_CANCEL_CLEANUP_CAS_LOST");
      await enqueueAgentMigrationCanceledReceipt(tx, attention, now);
      return { migration: attention, dispatch: "none", leaseId: null, deliveries: [] };
    }

    const leaseId = `${input.workerId}:${randomUUID()}`;
    const [claimed] = await tx.update(agentMigrations)
      .set({
        cancelCleanupLeaseId: leaseId,
        cancelCleanupLeaseExpiresAt: new Date(now.getTime() + leaseMs),
        cancelDispatchAttempts: candidate.cancelDispatchAttempts + 1,
        cancelLastDispatchAt: now,
        revision: candidate.revision + 1,
        updatedAt: now,
      })
      .where(and(
        eq(agentMigrations.id, candidate.id),
        eq(agentMigrations.revision, candidate.revision),
        or(
          isNull(agentMigrations.cancelCleanupLeaseExpiresAt),
          lte(agentMigrations.cancelCleanupLeaseExpiresAt, now),
        ),
      ))
      .returning();
    if (!claimed) return null;
    return {
      migration: claimed,
      dispatch: "required",
      leaseId,
      deliveries: buildAgentMigrationCancellationDeliveries(claimed),
    };
  });
}

export async function abortAgentMigration(input: {
  grantKey: string;
  reason: string;
  rollbackArrivingMachine?: boolean;
  now?: Date;
}): Promise<AgentMigrationRow> {
  const db = getDb();
  const now = input.now ?? currentDate();
  return await db.transaction(async (tx) => {
    const [row] = await tx.select().from(agentMigrations).where(eq(agentMigrations.grantKey, input.grantKey)).limit(1);
    if (!row) throw new Error("MIGRATION_NOT_FOUND");
    if (!isTransferActiveState(row.state)) throw new Error("MIGRATION_NOT_ACTIVE");

    if (row.state === "arriving" && input.rollbackArrivingMachine) {
      await tx.update(agents)
        .set({ machineId: row.sourceMachineId, updatedAt: now })
        .where(and(
          eq(agents.id, row.agentId),
          eq(agents.machineId, row.targetMachineId),
          isNull(agents.deletedAt),
        ));
    }

    const [updated] = await tx.update(agentMigrations)
      .set({
        state: "aborted",
        abortReason: input.reason,
        abortedAt: now,
        transportTeardownAt: now,
        revision: row.revision + 1,
        updatedAt: now,
      })
      .where(and(eq(agentMigrations.id, row.id), eq(agentMigrations.revision, row.revision)))
      .returning();
    if (!updated) throw new Error("MIGRATION_CONCURRENT_UPDATE");
    return updated;
  });
}
