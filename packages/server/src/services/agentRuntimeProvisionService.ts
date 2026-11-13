/**
 * Provisioning of external agents onto a hosted runtime provider
 * (raft-agent-provider.v1) — records, state machine and the worker.
 *
 * State machine (one `agent_runtime_provisions` row per Agent):
 *
 *   provisioning ──POST 2xx──────────────▶ active ──(edit)──▶ PATCH, stays active
 *        │  └─5xx/timeout/network: backoff, same body
 *        └──401/409/422/other 4xx, or no provider config──▶ failed ──retry──▶ provisioning
 *   any ──Raft agent deleted (credentials revoked in the same tx)──▶ deleting
 *   deleting ──DELETE by-raft-agent 2xx/404──▶ deleted   (other answers: backoff, tombstone kept)
 *
 * Import (rows created with an `import_source`): the POST carries
 * `awaitImport: true`; once active, the worker sends the workspace import
 * exactly once (Idempotency by `import_ref`, else the Raft agent id) and
 * stamps `imported_at` on a 2xx. Import failures are recorded in the `import_error_*`
 * fields, never in the POST's: a 5xx backs off, a 4xx sets
 * `import_failed_at` until a manual retry, which re-imports and never
 * re-POSTs.
 *
 * providerAgentId is stored for display and for PATCH; delete and the live
 * status passthrough address the provider by Raft agent id.
 *
 * The raw sk_agent key is minted in the Agent-create transaction and kept
 * encrypted on the row only until the provider accepted it; it is nulled on
 * POST success and on delete. It is never logged or returned by any API.
 *
 * Single executor per Agent: the worker claims a row with a conditional UPDATE
 * on an expired lease (lease_owner / lease_generation / lease_expires_at), and
 * every result write is guarded by the same owner and generation, so a stale
 * executor can neither run concurrently nor commit a result. Rows are
 * processed one operation at a time, so provider calls for one Agent are
 * ordered; edits are last-write-wins (the PATCH sends the Agent's current
 * name/instructions and marks the revision it read as synced).
 */
import { ASSISTANT_INSTRUCTIONS_VERSION, assistantInstructionsWithOwnerNotes } from "./assistantInstructions";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import {
  clearClockInterval,
  currentDate,
  noopTracer,
  setClockInterval,
  type Tracer,
  type AgentHostedRuntimeSummary,
  type AgentRuntimeProviderKind,
} from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agentCredentials, agentRuntimeProvisions, agents, assistantOwnerNotes, serverMembers, servers } from "../db/schema";
import { ASSISTANT_AGENT_CAPABILITIES, HOSTED_RUNTIME_AGENT_CAPABILITIES, mintAgentCredential } from "./agentCredentialService";
import { recordAgentCredentialsBulkRevoked, recordIntegrationAuditEvent, type ServerAuditContext } from "./integrationAuditService";
import {
  AgentRuntimeProviderError,
  assertAgentRuntimeProviderSecretKeyConfigured,
  decryptProviderSecret,
  encryptProviderSecret,
  getRaftOrigin,
  getRaftbenchCanaryServerId,
  type AgentRuntimeProviderTarget,
  providerAgentByRaftIdPath,
  providerAgentExistenceByRaftIdPath,
  PROVIDER_IMPORT_TIMEOUT_MS,
  providerAgentImportPath,
  providerAgentPath,
  providerAgentStopPath,
  providerRequest,
  resolveProviderConfig,
  type ProviderCallResult,
} from "./agentRuntimeProviderService";
import { isAgentRuntimeProviderEnabledForServer } from "./agentRuntimeProviderFeature";
import { isHostedModelPickerEnabled } from "./hostedAgentModelService";
import { dueHostedRuntimeModelPickers, dueHostedRuntimeServerPlans, ensureServerModelPickerSynced, getHostedRuntimePlan, syncHostedRuntimeModelPickers, syncHostedRuntimeServerPlans } from "./hostedRuntimeServerPlanSync";
import { addTraceEvent, getCurrentTraceContext, recordTraceEvent, withTraceRoot } from "../tracing/semanticTrace";
import {
  buildProvisionImportBody,
  getProvisionImportSource,
  notifyProvisionImported,
  notifyProvisionImportFailed,
  ProvisionImportSourceError,
} from "./agentRuntimeProvisionImport";

export const PROVISION_LEASE_MS = 60_000;
export const PROVISION_RETRY_BASE_MS = 5_000;
export const PROVISION_RETRY_MAX_MS = 15 * 60_000;
const PROVIDER_NAME_MAX = 60;
const PROVIDER_INSTRUCTIONS_MAX = 8_000;
const DRAIN_BATCH = 20;

type ProvisionRow = typeof agentRuntimeProvisions.$inferSelect;

const credentialScope = (agentId: string) => `agent-runtime-provision-credential:${agentId}`;

/** The name the provider shows: the Agent's display name, else its handle; the provider caps names at 60. */
export function providerAgentName(agent: { name: string; displayName: string | null }): string {
  const display = agent.displayName?.trim();
  return (display || agent.name).slice(0, PROVIDER_NAME_MAX);
}

/**
 * Raft has no separate system-prompt field; the Agent's description is its
 * instructions. A personal assistant gets Raft's assistant instructions
 * instead, then its owner's notes (RFC 077).
 */
export function providerAgentInstructions(agent: { description: string | null; assistantOwnerNotes?: string | null }, options: { assistant?: boolean } = {}): string {
  if (options.assistant) return assistantInstructionsWithOwnerNotes(agent.assistantOwnerNotes).slice(0, PROVIDER_INSTRUCTIONS_MAX);
  return (agent.description ?? "").slice(0, PROVIDER_INSTRUCTIONS_MAX);
}

/** The Raft instructions version the provider gets with this agent's instructions, or null when Raft sends none. */
export function providerInstructionsVersion(options: { assistant?: boolean }): string | null {
  return options.assistant ? ASSISTANT_INSTRUCTIONS_VERSION : null;
}

export function provisionBackoffMs(attempt: number): number {
  const exponent = Math.max(0, Math.min(20, attempt - 1));
  return Math.min(PROVISION_RETRY_MAX_MS, PROVISION_RETRY_BASE_MS * 2 ** exponent);
}

// ---------------------------------------------------------------------------
// Writes made inside the caller's transaction
// ---------------------------------------------------------------------------

/**
 * Request-time checks for `provider` on POST /api/agents, before anything is
 * written: the server's feature flag, then the deployment configuration.
 */
export async function assertProviderProvisioningAvailable(serverId: string, kind: AgentRuntimeProviderKind, target: AgentRuntimeProviderTarget = "default"): Promise<void> {
  if (!await isAgentRuntimeProviderEnabledForServer(serverId, kind)) {
    throw new AgentRuntimeProviderError("Cloud agents are not enabled for this server", "agent_runtime_provider_disabled");
  }
  if (!resolveProviderConfig(kind, process.env, target)) {
    throw new AgentRuntimeProviderError("Cloud agents are not configured on this deployment", "agent_runtime_provider_not_configured");
  }
  if (!getRaftOrigin()) {
    throw new AgentRuntimeProviderError("SERVER_URL must be configured so the provider can reach this Raft", "agent_runtime_provider_origin_unconfigured");
  }
  assertAgentRuntimeProviderSecretKeyConfigured();
}

/**
 * Called inside the Agent-create transaction: mint the Agent's credential with
 * the hosted-runtime capabilities (the creator's authority applies; this
 * replaces the device login a human would otherwise do) and record the
 * provisioning intent. Nothing reaches the provider until the create commits.
 */
export async function recordAgentProvisioning(tx: DatabaseExecutor, input: {
  agent: { id: string; serverId: string; name: string; displayName: string | null; description: string | null };
  provider: AgentRuntimeProviderKind;
  target?: AgentRuntimeProviderTarget;
  createdByUserId: string;
  /** An offered model id the creator picked; null/absent = the provider's default. */
  model?: string | null;
  profile?: "raftbench_service";
  /** A personal assistant (RFC 075 v4): its credential carries only ASSISTANT_AGENT_CAPABILITIES. */
  assistant?: boolean;
  /** Workspace import after create: a registered source (agentRuntimeProvisionImport) and its reference. */
  importSource?: string;
  importRef?: string | null;
}): Promise<void> {
  const target = input.target ?? "default";
  // Serialize target enrollment with other creates in the same synthetic server.
  await tx.select({ id: servers.id }).from(servers).where(eq(servers.id, input.agent.serverId)).for("update");
  const existingTargets = await tx.select({ target: agentRuntimeProvisions.providerTarget }).from(agentRuntimeProvisions)
    .where(eq(agentRuntimeProvisions.serverId, input.agent.serverId));
  if (existingTargets.some(row => row.target !== target)) {
    throw new AgentRuntimeProviderError("This server cannot mix official and canary provisions", "agent_runtime_provider_disabled");
  }
  if (target === "canary" || input.agent.serverId === getRaftbenchCanaryServerId()) {
    const [member] = await tx.select({ role: serverMembers.role }).from(serverMembers)
      .where(and(eq(serverMembers.serverId, input.agent.serverId), eq(serverMembers.userId, input.createdByUserId))).for("share");
    if (target !== "canary" || input.profile !== "raftbench_service" || input.agent.serverId !== getRaftbenchCanaryServerId()
      || !member || !["owner", "admin"].includes(member.role) || !resolveProviderConfig(input.provider, process.env, target)) {
      throw new AgentRuntimeProviderError("Only an administrator can create a canary RaftBench service on the enrolled synthetic staging server", "agent_runtime_provider_disabled");
    }
  }
  const minted = await mintAgentCredential({
    agentId: input.agent.id,
    scopes: input.profile === "raftbench_service" ? ["read", "raftbench"]
      : input.assistant ? ASSISTANT_AGENT_CAPABILITIES
      : HOSTED_RUNTIME_AGENT_CAPABILITIES,
    name: "Cloud runtime",
    // The provider holds this key and no person ever sees it, so it names no
    // issuer; the creator who triggered it is the audit event's actor below.
    issuedVia: "provision",
    createdByUserId: null,
    requireExternalRuntime: true,
  }, { executor: tx });
  // The creator's authority mints it; ids and scopes only, never the key.
  await recordIntegrationAuditEvent({
    serverId: minted.serverId,
    eventType: "agent_credential.issued",
    outcome: "success",
    source: "web",
    actor: { type: "human", id: input.createdByUserId },
    subject: { type: "agent", id: minted.agentId },
    target: { type: "agent_credential", id: minted.credentialId },
    metadata: { agentId: minted.agentId, credentialId: minted.credentialId, scopes: minted.scopes, issuedVia: minted.issuedVia },
  }, tx);
  const now = currentDate();
  await tx.insert(agentRuntimeProvisions).values({
    agentId: input.agent.id,
    serverId: input.agent.serverId,
    provider: input.provider,
    providerTarget: target,
    state: "provisioning",
    credentialId: minted.credentialId,
    encryptedCredential: encryptProviderSecret(minted.apiKey, credentialScope(input.agent.id)),
    provisionedName: providerAgentName(input.agent),
    provisionedInstructions: providerAgentInstructions(input.agent, { assistant: input.assistant === true }),
    instructionsVersion: providerInstructionsVersion({ assistant: input.assistant === true }),
    provisionedModel: input.model ?? null,
    provisionedProfile: input.profile ?? null,
    importSource: input.importSource ?? null,
    importRef: input.importRef ?? null,
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

/** An Agent's name or instructions changed: queue a PATCH (no-op for Agents without a provisioning record). */
export async function noteProvisionedAgentProfileEdit(tx: DatabaseExecutor, agentId: string): Promise<boolean> {
  const now = currentDate();
  const rows = await tx.update(agentRuntimeProvisions).set({
    desiredRevision: sql`${agentRuntimeProvisions.desiredRevision} + 1`,
    // A due PATCH starts a fresh backoff; provisioning/failed rows keep their schedule.
    attemptCount: sql`CASE WHEN ${agentRuntimeProvisions.state} = 'active' THEN 0 ELSE ${agentRuntimeProvisions.attemptCount} END`,
    nextAttemptAt: sql`CASE WHEN ${agentRuntimeProvisions.state} = 'active' THEN ${now.toISOString()}::timestamptz ELSE ${agentRuntimeProvisions.nextAttemptAt} END`,
    updatedAt: now,
  }).where(and(
    eq(agentRuntimeProvisions.agentId, agentId),
    sql`${agentRuntimeProvisions.state} IN ('provisioning', 'active', 'failed')`,
  )).returning({ agentId: agentRuntimeProvisions.agentId });
  return rows.length > 0;
}

/**
 * Called inside the Agent-delete transaction, after the Agent row is
 * soft-deleted: revoke every active credential of the Agent FIRST (in this
 * transaction, so it is committed before the worker can issue the provider
 * DELETE) and turn the record into a deletion tombstone.
 */
export async function beginProvisionedAgentDeletion(tx: DatabaseExecutor, agentId: string, revokedByUserId: string | null, audit?: ServerAuditContext): Promise<boolean> {
  const [row] = await tx.select({ state: agentRuntimeProvisions.state, serverId: agentRuntimeProvisions.serverId })
    .from(agentRuntimeProvisions)
    .where(eq(agentRuntimeProvisions.agentId, agentId))
    .for("update");
  if (!row || row.state === "deleted" || row.state === "deleting") return false;
  const now = currentDate();
  const revoked = await tx.update(agentCredentials).set({
    revokedAt: now,
    revokedReason: "agent_deleted",
    ...(revokedByUserId ? { revokedByUserId } : {}),
  }).where(and(eq(agentCredentials.agentId, agentId), isNull(agentCredentials.revokedAt)))
    .returning({ id: agentCredentials.id });
  await recordAgentCredentialsBulkRevoked({
    serverId: row.serverId, agentId, actorUserId: revokedByUserId, revokedCount: revoked.length, reason: "agent_deleted", audit,
  }, tx);
  await tx.update(agentRuntimeProvisions).set({
    state: "deleting",
    encryptedCredential: null,
    attemptCount: 0,
    nextAttemptAt: now,
    lastErrorCode: null,
    lastErrorMessage: null,
    lastErrorHttpStatus: null,
    lastErrorAt: null,
    updatedAt: now,
  }).where(eq(agentRuntimeProvisions.agentId, agentId));
  return true;
}

/**
 * DELETE the provider's agent now, outside the worker, for a caller that must
 * know it is gone before acting (a hosted Cindy converted to a computer).
 * True for 2xx (Antiproton answers `deleted`, also on a repeat) and 404 (it
 * never had the agent); false for anything else, so the caller keeps the row.
 */
export async function deleteProviderAgentNow(agentId: string, serverId: string): Promise<boolean> {
  const [row] = await getDb().select({ provider: agentRuntimeProvisions.provider, providerTarget: agentRuntimeProvisions.providerTarget }).from(agentRuntimeProvisions)
    .where(eq(agentRuntimeProvisions.agentId, agentId)).limit(1);
  if (!row) return true;
  const config = resolveProviderConfig(row.provider, process.env, row.providerTarget);
  if (!config) return false;
  const result = await providerRequest(config, "DELETE", providerAgentByRaftIdPath(agentId, serverId));
  return result.kind === "response" && ((result.status >= 200 && result.status < 300) || result.status === 404);
}

/** What the provider knows about a Raft agent id (antiproton `GET …/by-raft-agent/:id/existence`). */
export type ProviderAgentExistence = "exists" | "deleted" | "never_existed" | "elsewhere" | "unknown";
const PROVIDER_AGENT_EXISTENCE_STATES: ReadonlySet<string> = new Set(["exists", "deleted", "never_existed", "elsewhere"]);

/**
 * Ask the provider whether it ever had the agent, with the provider and
 * server the provision row was created with (never re-derived). `deleted`:
 * the id can never be created again; `elsewhere`: found under another
 * tenant, so the ids do not match. `unknown` for anything that does not
 * answer the question (network, non-2xx, unexpected body).
 */
export async function probeProviderAgent(agentId: string): Promise<ProviderAgentExistence> {
  const [row] = await getDb().select({
    provider: agentRuntimeProvisions.provider,
    providerTarget: agentRuntimeProvisions.providerTarget,
    serverId: agentRuntimeProvisions.serverId,
  })
    .from(agentRuntimeProvisions)
    .where(eq(agentRuntimeProvisions.agentId, agentId)).limit(1);
  if (!row) return "unknown";
  const config = resolveProviderConfig(row.provider, process.env, row.providerTarget);
  if (!config) return "unknown";
  const result = await providerRequest(config, "GET", providerAgentExistenceByRaftIdPath(agentId, row.serverId));
  if (result.kind === "network" || result.status < 200 || result.status >= 300) return "unknown";
  const state = (result.body as { state?: unknown } | null)?.state;
  return typeof state === "string" && PROVIDER_AGENT_EXISTENCE_STATES.has(state) ? state as ProviderAgentExistence : "unknown";
}

export type HostedAgentStopOutcome =
  | { kind: "not_hosted" }
  | { kind: "interrupted" }
  | { kind: "not_running" }
  | { kind: "failed"; code: string };

/**
 * Owner stop of a hosted agent: the provider interrupts its running turn and
 * keeps the agent. Idempotent; an agent the provider never created or already
 * dropped has nothing running. `not_hosted`: no provision row (an agent that
 * runs itself), stop stays unsupported. Traced as `server.hosted_agent.stop`
 * so a failed stop can alert even without the provider's own telemetry.
 */
export async function stopHostedAgentTurn(agentId: string, serverId: string): Promise<HostedAgentStopOutcome> {
  const [row] = await getDb().select({ provider: agentRuntimeProvisions.provider, providerTarget: agentRuntimeProvisions.providerTarget }).from(agentRuntimeProvisions)
    .where(eq(agentRuntimeProvisions.agentId, agentId)).limit(1);
  if (!row) return { kind: "not_hosted" };
  const startedAt = Date.now();
  const outcome = await requestHostedAgentStop(row.provider, agentId, serverId, row.providerTarget);
  recordTraceEvent("server.hosted_agent.stop", {
    agent_id: agentId,
    server_id: serverId,
    outcome: outcome.kind,
    ...(outcome.kind === "failed" ? { error_code: outcome.code } : {}),
    duration_ms: Date.now() - startedAt,
  });
  return outcome;
}

async function requestHostedAgentStop(provider: typeof agentRuntimeProvisions.$inferSelect.provider, agentId: string, serverId: string, target: AgentRuntimeProviderTarget): Promise<Exclude<HostedAgentStopOutcome, { kind: "not_hosted" }>> {
  const config = resolveProviderConfig(provider, process.env, target);
  if (!config) return { kind: "failed", code: "provider_not_configured" };
  const result = await providerRequest(config, "POST", providerAgentStopPath(agentId, serverId));
  if (result.kind === "network") return { kind: "failed", code: result.code };
  if (result.status === 404) return { kind: "not_running" };
  if (result.status < 200 || result.status >= 300) return { kind: "failed", code: result.error?.code ?? `http_${result.status}` };
  const reported = (result.body as { result?: unknown } | null)?.result;
  return reported === "interrupted" ? { kind: "interrupted" } : { kind: "not_running" };
}

/**
 * Inside the caller's transaction, after the provider confirmed the delete:
 * revoke the agent's credentials and settle the provision as deleted, with no
 * worker DELETE left to do. The agent row itself is the caller's.
 */
export async function settleProvisionDeleted(tx: DatabaseExecutor, agentId: string, revokedByUserId: string | null): Promise<void> {
  const now = currentDate();
  const revoked = await tx.update(agentCredentials).set({
    revokedAt: now,
    revokedReason: "agent_deleted",
    ...(revokedByUserId ? { revokedByUserId } : {}),
  }).where(and(eq(agentCredentials.agentId, agentId), isNull(agentCredentials.revokedAt)))
    .returning({ id: agentCredentials.id });
  const [agent] = revoked.length > 0
    ? await tx.select({ serverId: agents.serverId }).from(agents).where(eq(agents.id, agentId))
    : [];
  if (agent) {
    await recordAgentCredentialsBulkRevoked({
      serverId: agent.serverId, agentId, actorUserId: revokedByUserId, revokedCount: revoked.length, reason: "agent_deleted",
    }, tx);
  }
  await tx.update(agentRuntimeProvisions).set({
    state: "deleted",
    deletedAt: now,
    encryptedCredential: null,
    pushRegistered: false,
    leaseOwner: null,
    leaseExpiresAt: null,
    updatedAt: now,
  }).where(eq(agentRuntimeProvisions.agentId, agentId));
}

export type RetryProvisionOutcome = "requeued" | "not_found" | "nothing_to_retry" | "model_required";

/**
 * Provider codes for a POST it refused because of the picked model. Resending
 * the same body would be refused again, so a retry must carry a model the
 * creator chose again (the provider writes nothing for a refused POST, so a
 * changed body under the same Idempotency-Key is a first create).
 */
const MODEL_PICKER_DISABLED_CODE = "model_picker_disabled";
export const PROVISION_MODEL_REFUSAL_CODES: ReadonlySet<string> = new Set(["unknown_model", "model_locked", MODEL_PICKER_DISABLED_CODE]);

export function provisionNeedsModelChoice(row: { state: string; lastErrorCode: string | null }): boolean {
  return row.state === "failed" && row.lastErrorCode !== null && PROVISION_MODEL_REFUSAL_CODES.has(row.lastErrorCode);
}

/**
 * Manual retry: failed → provisioning; a stuck PATCH/DELETE is made due now.
 * After a model refusal the caller passes the model chosen again (`null` =
 * the provider's default, never applied silently); without one the retry is
 * `model_required`.
 */
export async function retryAgentProvisioning(
  tx: DatabaseExecutor,
  agentId: string,
  options: { model?: string | null } = {},
): Promise<RetryProvisionOutcome> {
  const [row] = await tx.select().from(agentRuntimeProvisions)
    .where(eq(agentRuntimeProvisions.agentId, agentId))
    .for("update");
  if (!row) return "not_found";
  const now = currentDate();
  const reset = { attemptCount: 0, nextAttemptAt: now, updatedAt: now };
  if (row.state === "failed") {
    if (!row.encryptedCredential) return "nothing_to_retry";
    const modelChoice = provisionNeedsModelChoice(row);
    if (modelChoice && options.model === undefined) return "model_required";
    await tx.update(agentRuntimeProvisions).set({
      ...reset,
      state: "provisioning",
      ...(modelChoice ? { provisionedModel: options.model ?? null } : {}),
    })
      .where(eq(agentRuntimeProvisions.agentId, agentId));
    return "requeued";
  }
  if (row.state === "active" && row.importFailedAt) {
    // Re-import only: the provider already has the agent.
    await tx.update(agentRuntimeProvisions).set({ ...reset, importFailedAt: null })
      .where(eq(agentRuntimeProvisions.agentId, agentId));
    return "requeued";
  }
  if (row.state === "active" && (row.lastErrorCode || row.desiredRevision > row.syncedRevision)) {
    // Re-send the current profile even if the last PATCH gave up on its revision.
    await tx.update(agentRuntimeProvisions).set({
      ...reset,
      desiredRevision: Math.max(row.desiredRevision, row.syncedRevision + 1),
    }).where(eq(agentRuntimeProvisions.agentId, agentId));
    return "requeued";
  }
  if (row.state === "provisioning" || row.state === "deleting") {
    await tx.update(agentRuntimeProvisions).set(reset).where(eq(agentRuntimeProvisions.agentId, agentId));
    return "requeued";
  }
  return "nothing_to_retry";
}

// ---------------------------------------------------------------------------
// Read surface
// ---------------------------------------------------------------------------

export function toHostedRuntimeSummary(row: ProvisionRow): AgentHostedRuntimeSummary {
  const retrying = row.state === "provisioning" || row.state === "deleting"
    || (row.state === "active" && (row.desiredRevision > row.syncedRevision || importPending(row)));
  return {
    provider: row.provider,
    state: row.state,
    providerAgentId: row.providerAgentId,
    syncPending: row.desiredRevision > row.syncedRevision && row.state !== "deleted" && row.state !== "deleting",
    push: row.pushRegistered === null ? null : { registered: row.pushRegistered, error: row.pushError },
    lastError: row.lastErrorCode
      ? {
          code: row.lastErrorCode,
          message: row.lastErrorMessage ?? "",
          httpStatus: row.lastErrorHttpStatus,
          at: (row.lastErrorAt ?? row.updatedAt).toISOString(),
        }
      : null,
    attemptCount: row.attemptCount,
    nextAttemptAt: retrying ? row.nextAttemptAt.toISOString() : null,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    retryNeedsModel: provisionNeedsModelChoice(row),
    import: row.importSource === null
      ? null
      : {
          state: row.importedAt ? "done" : row.importFailedAt ? "failed" : "pending",
          error: row.importErrorCode && !row.importedAt
            ? {
                code: row.importErrorCode,
                message: row.importErrorMessage ?? "",
                httpStatus: row.importErrorHttpStatus,
                at: (row.importErrorAt ?? row.updatedAt).toISOString(),
              }
            : null,
        },
  };
}

export async function getHostedRuntimeSummaries(agentIds: readonly string[]): Promise<Map<string, AgentHostedRuntimeSummary>> {
  const result = new Map<string, AgentHostedRuntimeSummary>();
  if (agentIds.length === 0) return result;
  const rows = await getDb().select().from(agentRuntimeProvisions)
    .where(inArray(agentRuntimeProvisions.agentId, [...agentIds]));
  for (const row of rows) result.set(row.agentId, toHostedRuntimeSummary(row));
  return result;
}

export async function getHostedRuntimeSummary(agentId: string): Promise<AgentHostedRuntimeSummary | null> {
  return (await getHostedRuntimeSummaries([agentId])).get(agentId) ?? null;
}

/** Optional passthrough of the provider's own view (incl. live push status). */
export async function fetchProviderAgentStatus(agentId: string): Promise<
  | { kind: "ok"; status: unknown }
  | { kind: "unavailable"; reason: string }
> {
  const [row] = await getDb().select().from(agentRuntimeProvisions)
    .where(eq(agentRuntimeProvisions.agentId, agentId)).limit(1);
  if (!row) return { kind: "unavailable", reason: "not_provisioned" };
  const config = resolveProviderConfig(row.provider, process.env, row.providerTarget);
  if (!config) return { kind: "unavailable", reason: "provider_not_configured" };
  const result = await providerRequest(config, "GET", providerAgentByRaftIdPath(row.agentId, row.serverId));
  if (result.kind === "network") return { kind: "unavailable", reason: result.code };
  if (result.status < 200 || result.status >= 300) return { kind: "unavailable", reason: result.error?.code ?? `http_${result.status}` };
  return { kind: "ok", status: result.body };
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

type Operation = "post" | "import" | "patch" | "delete";

function importPending(row: Pick<ProvisionRow, "importSource" | "importedAt" | "importFailedAt">): boolean {
  return row.importSource !== null && row.importedAt === null && row.importFailedAt === null;
}

function operationFor(row: ProvisionRow): Operation | null {
  if (row.state === "provisioning") return "post";
  if (row.state === "deleting") return "delete";
  // The import comes first: nothing else should reach the agent before its workspace.
  if (row.state === "active" && importPending(row)) return "import";
  if (row.state === "active" && row.desiredRevision > row.syncedRevision) return "patch";
  return null;
}

const dueCondition = (now: Date) => and(
  lte(agentRuntimeProvisions.nextAttemptAt, now),
  or(isNull(agentRuntimeProvisions.leaseExpiresAt), lt(agentRuntimeProvisions.leaseExpiresAt, now)),
  or(
    sql`${agentRuntimeProvisions.state} IN ('provisioning', 'deleting')`,
    and(eq(agentRuntimeProvisions.state, "active"), gt(agentRuntimeProvisions.desiredRevision, agentRuntimeProvisions.syncedRevision)),
    and(
      eq(agentRuntimeProvisions.state, "active"),
      sql`${agentRuntimeProvisions.importSource} IS NOT NULL`,
      isNull(agentRuntimeProvisions.importedAt),
      isNull(agentRuntimeProvisions.importFailedAt),
    ),
  ),
);

/** Claim one specific due row. Exactly one executor wins; the loser gets null. */
export async function claimProvision(agentId: string, leaseOwner: string, now: Date, executor: DatabaseExecutor = getDb()): Promise<ProvisionRow | null> {
  const [claimed] = await executor.update(agentRuntimeProvisions).set({
    leaseOwner,
    leaseExpiresAt: new Date(now.getTime() + PROVISION_LEASE_MS),
    leaseGeneration: sql`${agentRuntimeProvisions.leaseGeneration} + 1`,
    attemptCount: sql`${agentRuntimeProvisions.attemptCount} + 1`,
  }).where(and(eq(agentRuntimeProvisions.agentId, agentId), dueCondition(now))).returning();
  return claimed ?? null;
}

type Outcome =
  | { kind: "post_ok"; providerAgentId: string; push: { registered: boolean; error: string | null } }
  | { kind: "patch_ok"; revision: number; instructionsVersion?: string | null }
  | { kind: "delete_ok" }
  | { kind: "import_ok" }
  | { kind: "import_retry"; code: string; message: string; httpStatus: number | null }
  | { kind: "import_failed"; code: string; message: string; httpStatus: number | null }
  | { kind: "retry"; code: string; message: string; httpStatus: number | null }
  | { kind: "terminal"; code: string; message: string; httpStatus: number | null };

function classify(result: ProviderCallResult): { retryable: boolean; code: string; message: string; httpStatus: number | null } {
  if (result.kind === "network") {
    return { retryable: true, code: result.code === "timeout" ? "provider_timeout" : "provider_unreachable", message: `Provider request failed (${result.code})`, httpStatus: null };
  }
  const retryable = result.status >= 500 || result.status === 408 || result.status === 425 || result.status === 429;
  return {
    retryable,
    code: result.error?.code ?? `http_${result.status}`,
    message: result.error?.message || `Provider answered HTTP ${result.status}`,
    httpStatus: result.status,
  };
}

function parsePostBody(body: unknown): { providerAgentId: string; push: { registered: boolean; error: string | null } } | null {
  if (typeof body !== "object" || body === null) return null;
  const { providerAgentId, push } = body as { providerAgentId?: unknown; push?: unknown };
  if (typeof providerAgentId !== "string" || !providerAgentId || providerAgentId.length > 200) return null;
  const pushObj = typeof push === "object" && push !== null ? push as { registered?: unknown; error?: unknown } : {};
  return {
    providerAgentId,
    push: {
      registered: pushObj.registered === true,
      error: typeof pushObj.error === "string" ? pushObj.error.slice(0, 500) : null,
    },
  };
}

async function execute(row: ProvisionRow, op: Operation): Promise<Outcome> {
  // Existing rows keep being driven (edits, deletes) even if the server's flag
  // is later turned off; the flag only gates new creates.
  const config = resolveProviderConfig(row.provider, process.env, row.providerTarget);
  if (!config) {
    // POST cannot proceed without a provider; a DELETE tombstone keeps waiting for one.
    return { kind: op === "post" ? "terminal" : "retry", code: "agent_runtime_provider_not_configured", message: "Cloud agents are not configured on this deployment", httpStatus: null };
  }

  if (op === "delete") {
    // Always by Raft agent id: a POST may have succeeded at the provider even
    // though Raft never saw the answer (no providerAgentId stored).
    const result = await providerRequest(config, "DELETE", providerAgentByRaftIdPath(row.agentId, row.serverId));
    if (result.kind === "response" && ((result.status >= 200 && result.status < 300) || result.status === 404)) return { kind: "delete_ok" };
    const c = classify(result);
    // Delete never gives up: the tombstone stays until 2xx/404.
    return { kind: "retry", code: c.code, message: c.message, httpStatus: c.httpStatus };
  }

  if (op === "post") {
    const raftOrigin = getRaftOrigin();
    if (!raftOrigin) {
      return { kind: "terminal", code: "agent_runtime_provider_origin_unconfigured", message: "SERVER_URL is not configured", httpStatus: null };
    }
    if (!row.encryptedCredential) {
      return { kind: "terminal", code: "credential_unavailable", message: "The agent credential for provisioning is no longer available", httpStatus: null };
    }
    let credential: string;
    try {
      credential = decryptProviderSecret(row.encryptedCredential, credentialScope(row.agentId));
    } catch (error) {
      return { kind: "terminal", code: "credential_unavailable", message: error instanceof Error ? error.message : "Stored credential is unreadable", httpStatus: null };
    }
    // Byte-identical on every retry: frozen fields only.
    const body = {
      raftAgentId: row.agentId,
      raftServerId: row.serverId,
      raftOrigin,
      name: row.provisionedName,
      instructions: row.provisionedInstructions,
      credential,
      ...(row.provisionedProfile ? { profile: row.provisionedProfile } : {}),
      // Left out when nothing was picked: the worker never fills in a default.
      ...(row.provisionedModel !== null ? { model: row.provisionedModel } : {}),
      // The provider queues pushes without starting a turn until the import lands.
      ...(row.importSource !== null ? { awaitImport: true } : {}),
      // Hosted Cindy only: her first reply skips thinking so it lands fast (antiproton#882),
      // and the platform's onboarding budget pays for her, not the server's (antiproton#884).
      ...(row.importSource === "cindy_seed" ? { firstTurn: { reasoning: "off" }, budget: "onboarding" } : {}),
      // Server-level and read live: the provider leaves it out of the replay comparison.
      plan: await getHostedRuntimePlan(row.serverId),
    };
    // A picked model is allowed only where the provider knows the server may pick.
    if (row.provisionedModel !== null) await ensureServerModelPickerSynced(row.serverId, row.provider);
    const result = await providerRequest(config, "POST", "/provision/agents", { body, idempotencyKey: row.agentId });
    if (result.kind === "response" && result.status >= 200 && result.status < 300) {
      const parsed = parsePostBody(result.body);
      if (parsed) return { kind: "post_ok", ...parsed };
      return { kind: "retry", code: "provider_response_invalid", message: "The provider answered without a providerAgentId", httpStatus: result.status };
    }
    const c = classify(result);
    // `model_picker_disabled` while the server may pick: the provider has not yet
    // learned it; the sync delivers it and the same POST succeeds (cody). If the
    // picker was turned off meanwhile, it is final, so the agent is not stuck
    // provisioning forever, and a retry asks for a model again (Tenny).
    if (c.httpStatus === 403 && c.code === MODEL_PICKER_DISABLED_CODE) {
      const stillPicking = await isHostedModelPickerEnabled(row.serverId);
      return { kind: stillPicking ? "retry" : "terminal", code: c.code, message: c.message, httpStatus: c.httpStatus };
    }
    return { kind: c.retryable ? "retry" : "terminal", code: c.code, message: c.message, httpStatus: c.httpStatus };
  }

  if (op === "import") return executeImport(config, row);

  // PATCH: last write wins — send the Agent's current profile.
  const [agent] = await getDb().select({
    name: agents.name,
    displayName: agents.displayName,
    description: agents.description,
    assistantOwnerUserId: agents.assistantOwnerUserId,
    assistantOwnerNotes: assistantOwnerNotes.notes,
  }).from(agents).leftJoin(assistantOwnerNotes, eq(assistantOwnerNotes.agentId, agents.id)).where(eq(agents.id, row.agentId)).limit(1);
  if (!agent || !row.providerAgentId) {
    return { kind: "patch_ok", revision: row.desiredRevision };
  }
  const assistant = agent.assistantOwnerUserId !== null;
  const result = await providerRequest(config, "PATCH", providerAgentPath(row.providerAgentId, row.serverId), {
    body: { name: providerAgentName(agent), instructions: providerAgentInstructions(agent, { assistant }) },
  });
  if (result.kind === "response" && result.status >= 200 && result.status < 300) {
    return { kind: "patch_ok", revision: row.desiredRevision, instructionsVersion: providerInstructionsVersion({ assistant }) };
  }
  const c = classify(result);
  return { kind: c.retryable ? "retry" : "terminal", code: c.code, message: c.message, httpStatus: c.httpStatus };
}

async function executeImport(config: { baseUrl: string; token: string }, row: ProvisionRow): Promise<Outcome> {
  const source = getProvisionImportSource(row.importSource!);
  if (!source) {
    return { kind: "import_failed", code: "import_source_unknown", message: `No import source "${row.importSource}" on this server`, httpStatus: null };
  }
  let body;
  try {
    body = buildProvisionImportBody(row.importRef ?? row.agentId, await source({ agentId: row.agentId, serverId: row.serverId, importRef: row.importRef }));
  } catch (error) {
    if (error instanceof ProvisionImportSourceError) {
      return { kind: error.retryable ? "import_retry" : "import_failed", code: error.code, message: error.message, httpStatus: null };
    }
    throw error;
  }
  const result = await providerRequest(config, "POST", providerAgentImportPath(row.agentId, row.serverId), {
    body,
    idempotencyKey: body.migrationId,
    timeoutMs: PROVIDER_IMPORT_TIMEOUT_MS,
  });
  // A lost answer is retried with the same migrationId and body, which the provider answers 2xx again.
  // 409 already_imported (a different import was sealed) or agent_active fails the import for a human to look at.
  // Sources build files at import time, so if the first import landed with its answer lost and the content
  // changed before the retry (e.g. a release changed Cindy's seed), the retry gets already_imported: the two
  // sides really disagree, and that is reported, not counted as done.
  if (result.kind === "response" && result.status >= 200 && result.status < 300) return { kind: "import_ok" };
  const c = classify(result);
  return { kind: c.retryable ? "import_retry" : "import_failed", code: c.code, message: c.message, httpStatus: c.httpStatus };
}

/** Commit an outcome iff this executor still holds the lease it claimed with. */
async function finish(claimed: ProvisionRow, op: Operation, outcome: Outcome, now: Date): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const [current] = await tx.select().from(agentRuntimeProvisions)
      .where(and(
        eq(agentRuntimeProvisions.agentId, claimed.agentId),
        eq(agentRuntimeProvisions.leaseOwner, claimed.leaseOwner!),
        eq(agentRuntimeProvisions.leaseGeneration, claimed.leaseGeneration),
      ))
      .for("update");
    if (!current) return false;
    const release = { leaseOwner: null, leaseExpiresAt: null, updatedAt: now };
    const clearError = { lastErrorCode: null, lastErrorMessage: null, lastErrorHttpStatus: null, lastErrorAt: null };
    const clearImportError = { importErrorCode: null, importErrorMessage: null, importErrorHttpStatus: null, importErrorAt: null };
    // The row may have moved on while the call was in flight (e.g. the Agent
    // was deleted during a POST). Only the claimed state may be transitioned.
    const stateUnchanged = current.state === claimed.state;
    let patch: Partial<typeof agentRuntimeProvisions.$inferInsert>;
    switch (outcome.kind) {
      case "post_ok":
        patch = {
          ...release,
          ...clearError,
          providerAgentId: outcome.providerAgentId,
          encryptedCredential: null,
          pushRegistered: outcome.push.registered,
          pushError: outcome.push.error,
          attemptCount: 0,
          nextAttemptAt: now,
          ...(stateUnchanged ? { state: "active" as const, activatedAt: now } : {}),
        };
        break;
      case "patch_ok":
        patch = {
          ...release,
          ...clearError,
          ...(outcome.instructionsVersion !== undefined ? { instructionsVersion: outcome.instructionsVersion } : {}),
          syncedRevision: Math.max(current.syncedRevision, outcome.revision),
          attemptCount: 0,
          nextAttemptAt: now,
        };
        break;
      case "import_ok":
        patch = stateUnchanged
          ? { ...release, ...clearImportError, importedAt: now, attemptCount: 0, nextAttemptAt: now }
          : { ...release, nextAttemptAt: now };
        break;
      case "import_retry":
      case "import_failed": {
        const importError = { importErrorCode: outcome.code, importErrorMessage: outcome.message, importErrorHttpStatus: outcome.httpStatus, importErrorAt: now };
        if (!stateUnchanged) patch = { ...release, nextAttemptAt: now };
        else if (outcome.kind === "import_failed") patch = { ...release, ...importError, importFailedAt: now, attemptCount: 0 };
        else patch = { ...release, ...importError, nextAttemptAt: new Date(now.getTime() + provisionBackoffMs(current.attemptCount)) };
        break;
      }
      case "delete_ok":
        patch = stateUnchanged
          ? { ...release, ...clearError, state: "deleted", deletedAt: now, encryptedCredential: null, pushRegistered: false, attemptCount: 0 }
          : { ...release, nextAttemptAt: now };
        break;
      case "retry":
        patch = {
          ...release,
          lastErrorCode: outcome.code,
          lastErrorMessage: outcome.message,
          lastErrorHttpStatus: outcome.httpStatus,
          lastErrorAt: now,
          nextAttemptAt: stateUnchanged ? new Date(now.getTime() + provisionBackoffMs(current.attemptCount)) : now,
        };
        break;
      case "terminal": {
        const error = { lastErrorCode: outcome.code, lastErrorMessage: outcome.message, lastErrorHttpStatus: outcome.httpStatus, lastErrorAt: now };
        if (!stateUnchanged) {
          patch = { ...release, nextAttemptAt: now };
        } else if (op === "post") {
          patch = { ...release, ...error, state: "failed" };
        } else {
          // A refused PATCH gives up on this revision (visible error; the next edit or a retry re-sends).
          patch = { ...release, ...error, syncedRevision: Math.max(current.syncedRevision, claimed.desiredRevision), nextAttemptAt: now };
        }
        break;
      }
    }
    await tx.update(agentRuntimeProvisions).set(patch).where(eq(agentRuntimeProvisions.agentId, claimed.agentId));
    return true;
  });
}

export interface ProvisionDrainSummary { claimed: number; succeeded: number; retried: number; failed: number }

/** Process due rows once. Safe to run concurrently on every replica. */
/**
 * RFC 077: an upgrade of Raft's assistant instructions reaches every live
 * assistant without a script. An active assistant
 * provision with nothing pending and no standing error whose provider got
 * another version (or none)
 * is queued for one PATCH, exactly like a profile edit; the worker records the
 * version it sent. Returns how many were queued.
 */
export async function queueAssistantInstructionUpgrades(now: Date = currentDate()): Promise<number> {
  const rows = await getDb().update(agentRuntimeProvisions).set({
    desiredRevision: sql`${agentRuntimeProvisions.desiredRevision} + 1`,
    attemptCount: 0,
    nextAttemptAt: now,
    updatedAt: now,
  }).where(and(
    eq(agentRuntimeProvisions.state, "active"),
    eq(agentRuntimeProvisions.syncedRevision, agentRuntimeProvisions.desiredRevision),
    // A PATCH the provider refused for good is not resent every pass (the error shows; an edit or retry resends).
    isNull(agentRuntimeProvisions.lastErrorCode),
    sql`${agentRuntimeProvisions.instructionsVersion} IS DISTINCT FROM ${ASSISTANT_INSTRUCTIONS_VERSION}`,
    sql`EXISTS (SELECT 1 FROM ${agents} WHERE ${agents.id} = ${agentRuntimeProvisions.agentId} AND ${agents.assistantOwnerUserId} IS NOT NULL AND ${agents.deletedAt} IS NULL)`,
  )).returning({ agentId: agentRuntimeProvisions.agentId });
  return rows.length;
}

export async function drainAgentRuntimeProvisions(input: {
  leaseOwner?: string;
  batchSize?: number;
  now?: () => Date;
  /** Checked before each claim: a stopping worker finishes what it holds and claims nothing more. */
  shouldStop?: () => boolean;
  /** Opens a root span per operation when the drain runs outside a trace (the poll), so the provider gets a trace id. */
  tracer?: Tracer;
} = {}): Promise<ProvisionDrainSummary> {
  const leaseOwner = input.leaseOwner ?? defaultLeaseOwner;
  const clock = input.now ?? currentDate;
  const summary: ProvisionDrainSummary = { claimed: 0, succeeded: 0, retried: 0, failed: 0 };
  await queueAssistantInstructionUpgrades(clock());
  const candidates = await getDb().select({ agentId: agentRuntimeProvisions.agentId })
    .from(agentRuntimeProvisions)
    .where(dueCondition(clock()))
    .orderBy(agentRuntimeProvisions.nextAttemptAt)
    .limit(input.batchSize ?? DRAIN_BATCH);
  for (const candidate of candidates) {
    if (input.shouldStop?.()) break;
    const claimed = await claimProvision(candidate.agentId, leaseOwner, clock());
    if (!claimed) continue;
    const op = operationFor(claimed);
    if (!op) {
      await getDb().update(agentRuntimeProvisions).set({ leaseOwner: null, leaseExpiresAt: null })
        .where(and(eq(agentRuntimeProvisions.agentId, claimed.agentId), eq(agentRuntimeProvisions.leaseGeneration, claimed.leaseGeneration)));
      continue;
    }
    summary.claimed += 1;
    let outcome: Outcome;
    try {
      outcome = input.tracer && !getCurrentTraceContext()
        ? await withTraceRoot(input.tracer, "server.agent_runtime_provision.operation", { surface: "server", kind: "internal", attrs: { op } }, () => execute(claimed, op))
        : await execute(claimed, op);
    } catch (error) {
      const internal = { code: "internal_error", message: error instanceof Error ? error.name : "internal error", httpStatus: null };
      outcome = op === "import" ? { kind: "import_retry", ...internal } : { kind: "retry", ...internal };
    }
    const committed = await finish(claimed, op, outcome, clock());
    if (!committed) continue;
    if (outcome.kind === "retry" || outcome.kind === "import_retry") summary.retried += 1;
    else if (outcome.kind === "terminal" || outcome.kind === "import_failed") summary.failed += 1;
    else summary.succeeded += 1;
    if (outcome.kind === "import_ok") {
      await notifyProvisionImported({ agentId: claimed.agentId, serverId: claimed.serverId, importSource: claimed.importSource! });
    } else if (outcome.kind === "import_failed") {
      await notifyProvisionImportFailed({
        agentId: claimed.agentId,
        serverId: claimed.serverId,
        importSource: claimed.importSource!,
        code: outcome.code,
        httpStatus: outcome.httpStatus,
      });
    }
    if (outcome.kind === "retry" || outcome.kind === "terminal" || outcome.kind === "import_retry" || outcome.kind === "import_failed") {
      console.warn(`[AgentRuntimeProvision] agent=${claimed.agentId} op=${op} outcome=${outcome.kind} code=${outcome.code} status=${outcome.httpStatus ?? "-"}`);
    }
  }
  return summary;
}

const defaultLeaseOwner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
let running: { kick: () => void } | null = null;

/** Servers' plans are re-checked this often, and right after a kick from a plan change. */
const PLAN_SYNC_INTERVAL_MS = 60_000;
const PLAN_SYNC_HEARTBEAT_MS = 60 * 60_000;
let planSyncRequested = false;

/** A server's plan changed: send it to the provider on this replica's next pass. */
export function kickHostedRuntimePlanSync(): void {
  planSyncRequested = true;
  running?.kick();
}

/** Nudge this replica's worker after a create/edit/delete/retry commits (others poll). */
export function kickAgentRuntimeProvisionWorker(): void {
  running?.kick();
}

/** How long shutdown waits for an in-flight drain; well under the server's exit deadline. */
export const PROVISION_SHUTDOWN_WAIT_MS = 10_000;

export function startAgentRuntimeProvisionWorker(input: { intervalMs?: number; tracer?: Tracer; shutdownWaitMs?: number } = {}) {
  const tracer = input.tracer ?? noopTracer;
  let draining: Promise<void> | null = null;
  let again = false;
  let stopping = false;
  let lastPlanSync = 0;
  let lastPlanSyncSpan = 0;
  const run = () => {
    if (stopping) return;
    if (draining) { again = true; return; }
    const syncPlans = planSyncRequested || Date.now() - lastPlanSync >= PLAN_SYNC_INTERVAL_MS;
    if (syncPlans) { planSyncRequested = false; lastPlanSync = Date.now(); }
    draining = drainAgentRuntimeProvisions({ tracer, shouldStop: () => stopping })
      .then(async () => {
        if (!syncPlans || stopping || (!resolveProviderConfig("antiproton") && !resolveProviderConfig("antiproton", process.env, "canary"))) return;
        // A pass with work opens a span (the per-server events need one to land
        // on); an idle pass does so only hourly, as proof the worker is alive.
        const due = await dueHostedRuntimeServerPlans();
        const pickers = await dueHostedRuntimeModelPickers();
        if (due.length === 0 && pickers.length === 0 && Date.now() - lastPlanSyncSpan < PLAN_SYNC_HEARTBEAT_MS) return;
        lastPlanSyncSpan = Date.now();
        await withTraceRoot(tracer, "server.hosted_runtime.plan_sync", { surface: "server", kind: "internal" }, async () => {
          const summary = await syncHostedRuntimeServerPlans({ due });
          const pickerSummary = await syncHostedRuntimeModelPickers({ due: pickers });
          addTraceEvent("server.hosted_runtime.plan_sync.result", {
            ...summary,
            model_picker_checked: pickerSummary.checked,
            model_picker_synced: pickerSummary.synced,
            model_picker_failed: pickerSummary.failed,
          });
        });
      })
      .catch((error: unknown) => {
        console.error("[AgentRuntimeProvision] drain failed", error instanceof Error ? error.name : "unknown");
      })
      .finally(() => {
        draining = null;
        if (again && !stopping) { again = false; setImmediate(run); }
      });
  };
  running = { kick: () => setImmediate(run) };
  run();
  const handle = setClockInterval(run, input.intervalMs ?? 5_000);
  if (typeof handle === "object" && handle && "unref" in handle && typeof handle.unref === "function") handle.unref();
  return {
    /**
     * Stop polling and claiming, then wait (bounded) for the operation in
     * flight so a provider call is not cut by the process exit and its row
     * is not left behind a lease. A SIGKILL still cuts it: the lease expiry
     * stays the backstop.
     */
    async stop(): Promise<void> {
      stopping = true;
      running = null;
      clearClockInterval(handle);
      const inFlight = draining;
      if (!inFlight) return;
      const waitMs = input.shutdownWaitMs ?? PROVISION_SHUTDOWN_WAIT_MS;
      const started = Date.now();
      await withTraceRoot(tracer, "server.agent_runtime_provision.shutdown_wait", { surface: "server", kind: "internal" }, async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const outcome = await Promise.race([
          inFlight.then(() => "settled" as const),
          new Promise<"timed_out">((resolve) => { timer = setTimeout(() => resolve("timed_out"), waitMs); }),
        ]);
        if (timer) clearTimeout(timer);
        const waitedMs = Date.now() - started;
        addTraceEvent("server.agent_runtime_provision.shutdown_wait.result", { outcome, waited_ms: waitedMs });
        if (outcome === "timed_out") console.warn(`[AgentRuntimeProvision] shutdown gave up waiting for an in-flight operation after ${waitedMs}ms`);
      });
    },
  };
}
