/**
 * task #1357 item 1: the model limits reports of Built-in custom gateway
 * agents (`agent:model_limits`) and the one signal derived from them: whether
 * the current session has reported a Raft default for a limit.
 *
 * Storage: one row per (agent, Computer, daemon instance)
 * (`agent_model_limits_reports`): the newest report that daemon process sent
 * for the agent. A frame only ever writes the row of its own Computer and
 * instance, ordered within it by (config_revision, seq) (seq grows per daemon
 * process); no daemon clock is compared (`observed_at` is display only). So a
 * frame paused in the handler, a late frame of an old process, or a late
 * commit on another replica can only touch its own instance's row, never
 * another process's result. The upsert also requires that the agent is still
 * on that Computer and that the revision is not ahead of
 * `agents.config_revision`; the orchestrator takes frames only on the
 * machine's current socket naming the instance its ready declared.
 *
 * Rows accumulate per instance (each daemon restart adds one per agent) until
 * the agent or the Computer is deleted (FK cascade). There is deliberately no
 * cleanup on ready: a late cleanup of an old connection could delete the new
 * instance's row. Retention is a follow-up.
 *
 * Signal: `defaultsReported` is true iff some row (any instance: which one is
 * the current one is not provable) is from the agent's current Computer, for
 * its current config revision and its current session (none known: false),
 * and has at least one field with source `raft_default`. It never says the
 * limits are confirmed or that the catalog matched: no row, or rows without a
 * default, read as nothing to show.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  hydrateRuntimeConfig,
  isBuiltInRuntimeCustomModelPresetProviderId,
  isBuiltInRuntimeGatewayProviderId,
  modelLimitsHaveDefaultValues,
  parseModelLimits,
  type AgentModelLimitsFrame,
  type ModelLimits,
  type RuntimeConfig,
  type RuntimeConfigHydrationInput,
} from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agentModelLimitsReports, agentProviderConnections, agents, providerConnections } from "../db/schema";

export interface StoredAgentModelLimitsReport {
  machineId: string;
  daemonInstanceId: string;
  launchId: string | null;
  sessionId: string;
  configRevision: number;
  seq: number;
  observedAt: Date;
  receivedAt: Date;
  runtime: string;
  modelLimits: ModelLimits;
}

/** A validated `agent:model_limits` frame, or null when any field is malformed (untrusted wire data). */
export function parseAgentModelLimitsFrame(msg: unknown): AgentModelLimitsFrame | null {
  if (!msg || typeof msg !== "object") return null;
  const frame = msg as Record<string, unknown>;
  if (frame.type !== "agent:model_limits" || frame.v !== 1) return null;
  if (typeof frame.agentId !== "string" || !frame.agentId) return null;
  if (frame.launchId !== undefined && (typeof frame.launchId !== "string" || !frame.launchId)) return null;
  if (typeof frame.sessionId !== "string" || !frame.sessionId || frame.sessionId.length > 512) return null;
  if (typeof frame.configRevision !== "number" || !Number.isSafeInteger(frame.configRevision) || frame.configRevision < 0) return null;
  if (typeof frame.seq !== "number" || !Number.isSafeInteger(frame.seq) || frame.seq < 0) return null;
  if (typeof frame.observedAtMs !== "number" || !Number.isFinite(frame.observedAtMs) || frame.observedAtMs <= 0) return null;
  if (typeof frame.runtime !== "string" || !frame.runtime) return null;
  if (typeof frame.daemonInstanceId !== "string" || !frame.daemonInstanceId.trim() || frame.daemonInstanceId.length > 128) return null;
  const modelLimits = parseModelLimits(frame.modelLimits);
  if (!modelLimits) return null;
  return {
    type: "agent:model_limits",
    v: 1,
    agentId: frame.agentId,
    ...(frame.launchId !== undefined ? { launchId: frame.launchId as string } : {}),
    sessionId: frame.sessionId,
    configRevision: frame.configRevision,
    daemonInstanceId: frame.daemonInstanceId,
    seq: frame.seq,
    observedAtMs: frame.observedAtMs,
    runtime: frame.runtime,
    modelLimits,
  };
}

export type RecordAgentModelLimitsOutcome = "stored" | "not_newer";

/**
 * Stores the report in its own (agent, Computer, daemon instance) row when it
 * is newer there by (config_revision, seq), and the agent is still on
 * `machineId` with a config revision at or above the report's. "not_newer"
 * covers an exact re-send (idempotent) as well as an older or refused report.
 */
export async function recordAgentModelLimitsReport(input: {
  serverId: string;
  machineId: string;
  frame: AgentModelLimitsFrame;
  db?: DatabaseExecutor;
}): Promise<RecordAgentModelLimitsOutcome> {
  return upsertAgentModelLimitsReport(input, input.db ?? getDb());
}

async function upsertAgentModelLimitsReport(
  input: { serverId: string; machineId: string; frame: AgentModelLimitsFrame },
  db: DatabaseExecutor,
): Promise<RecordAgentModelLimitsOutcome> {
  const { frame } = input;
  const observedAt = new Date(frame.observedAtMs);
  const result = await db.execute<{ agent_id: string }>(sql`
    INSERT INTO ${agentModelLimitsReports} (
      agent_id, server_id, machine_id, daemon_instance_id, launch_id, session_id, config_revision, seq, observed_at, runtime, model_limits, received_at
    )
    SELECT ${agents.id}, ${input.serverId}, ${input.machineId}, ${frame.daemonInstanceId}, ${frame.launchId ?? null}, ${frame.sessionId},
      ${frame.configRevision}, ${frame.seq}, ${observedAt}, ${frame.runtime}, ${JSON.stringify(frame.modelLimits)}::jsonb, now()
    FROM ${agents}
    WHERE ${agents.id} = ${frame.agentId}
      AND ${agents.serverId} = ${input.serverId}
      AND ${agents.machineId} = ${input.machineId}
      AND ${agents.configRevision} >= ${frame.configRevision}
    ON CONFLICT (agent_id, machine_id, daemon_instance_id) DO UPDATE SET
      server_id = excluded.server_id,
      launch_id = excluded.launch_id,
      session_id = excluded.session_id,
      config_revision = excluded.config_revision,
      seq = excluded.seq,
      observed_at = excluded.observed_at,
      runtime = excluded.runtime,
      model_limits = excluded.model_limits,
      received_at = excluded.received_at
    WHERE (excluded.config_revision, excluded.seq) > (${agentModelLimitsReports.configRevision}, ${agentModelLimitsReports.seq})
    RETURNING agent_id`);
  return result.rows.length > 0 ? "stored" : "not_newer";
}

function storedReportOf(row: typeof agentModelLimitsReports.$inferSelect): StoredAgentModelLimitsReport | null {
  const modelLimits = parseModelLimits(row.modelLimits);
  if (!modelLimits) return null;
  return {
    machineId: row.machineId,
    daemonInstanceId: row.daemonInstanceId,
    launchId: row.launchId,
    sessionId: row.sessionId,
    configRevision: row.configRevision,
    seq: row.seq,
    observedAt: row.observedAt,
    receivedAt: row.receivedAt,
    runtime: row.runtime,
    modelLimits,
  };
}

/**
 * Whether the agent's saved config is a Built-in custom model reached through
 * a gateway: a direct gateway provider, or a provider connection whose
 * provider is a gateway one and that has an endpoint (`connection`). The
 * daemon reports limits for exactly these (`resolveBuiltInGatewayLaunch`,
 * `configureBuiltInGatewayCustomModel`), and for a typed model on a preset
 * provider that takes one (task #10: OpenRouter,
 * `configureBuiltInPresetCustomModel`).
 */
export function isBuiltInGatewayCustomModelConfig(
  runtimeConfig: RuntimeConfig | null | undefined,
  connection: { providerId: string; endpointUrl: string | null } | null,
): boolean {
  if (!runtimeConfig || runtimeConfig.runtime !== "builtin") return false;
  if (runtimeConfig.model.kind !== "custom") return false;
  if (runtimeConfig.provider.kind === "gateway") return true;
  if (runtimeConfig.provider.kind === "preset") {
    return isBuiltInRuntimeCustomModelPresetProviderId(runtimeConfig.provider.providerId);
  }
  return runtimeConfig.provider.kind === "connection"
    && connection !== null
    && isBuiltInRuntimeGatewayProviderId(connection.providerId)
    && Boolean(connection.endpointUrl);
}

/** The signal the agent detail, the directory and the PATCH answer carry. */
export interface AgentModelLimitsWarning {
  /** The current session on the current Computer, for the current config revision, has reported a Raft default for at least one limit. */
  defaultsReported: boolean;
}

/** Whether one agent's stored reports raise the signal (see the header); pure. */
export function deriveAgentModelLimitsWarning(input: {
  agent: { machineId: string | null; configRevision: number; sessionId: string | null };
  reports: readonly StoredAgentModelLimitsReport[];
}): AgentModelLimitsWarning {
  const { agent } = input;
  // Stored rows always name a Computer and a session, so an agent without
  // either matches none.
  const defaultsReported = input.reports.some((report) =>
    report.machineId === agent.machineId
    && report.configRevision === agent.configRevision
    && report.sessionId === agent.sessionId
    && modelLimitsHaveDefaultValues(report.modelLimits));
  return { defaultsReported };
}

/**
 * The agents' `modelLimits`, for a detail, a list or a PATCH answer: only
 * agents whose saved config is a Built-in custom gateway model get an entry.
 * Each agent's revision, Computer and session are read from the database
 * here, not taken from a caller's cache. A handful of queries whatever the
 * number of agents.
 */
export async function getAgentModelLimitsWarnings(input: {
  agents: ReadonlyArray<{ id: string; serverId: string; runtimeConfig: RuntimeConfig | null | undefined }>;
  db?: DatabaseExecutor;
}): Promise<Map<string, AgentModelLimitsWarning>> {
  const db = input.db ?? getDb();
  const warnings = new Map<string, AgentModelLimitsWarning>();
  const eligible = await modelLimitsEligible(input.agents, db);
  if (eligible.length === 0) return warnings;
  const eligibleIds = eligible.map((agent) => agent.id);
  const agentRows = await db.select({ id: agents.id, machineId: agents.machineId, configRevision: agents.configRevision, sessionId: agents.sessionId })
    .from(agents).where(inArray(agents.id, eligibleIds));
  const reportRows = await db.select().from(agentModelLimitsReports).where(inArray(agentModelLimitsReports.agentId, eligibleIds));
  const reportsOf = new Map<string, StoredAgentModelLimitsReport[]>();
  for (const row of reportRows) {
    const report = storedReportOf(row);
    if (report) reportsOf.set(row.agentId, [...(reportsOf.get(row.agentId) ?? []), report]);
  }
  for (const agent of agentRows) {
    warnings.set(agent.id, deriveAgentModelLimitsWarning({ agent, reports: reportsOf.get(agent.id) ?? [] }));
  }
  return warnings;
}

/** The agents (of those given) whose saved config gets a `modelLimits` status: one query for their connections. */
async function modelLimitsEligible<T extends { id: string; serverId: string; runtimeConfig: RuntimeConfig | null | undefined }>(
  candidatesIn: ReadonlyArray<T>,
  db: DatabaseExecutor,
): Promise<T[]> {
  const candidates = candidatesIn.filter((agent) => agent.runtimeConfig?.runtime === "builtin" && agent.runtimeConfig.model.kind === "custom");
  if (candidates.length === 0) return [];
  const connectionIds = candidates.filter((agent) => agent.runtimeConfig?.runtime === "builtin" && agent.runtimeConfig.provider.kind === "connection").map((agent) => agent.id);
  const connectionRows = connectionIds.length === 0 ? [] : await db.select({ agentId: agentProviderConnections.agentId, serverId: agentProviderConnections.serverId, providerId: providerConnections.providerId, endpointUrl: providerConnections.endpointUrl })
    .from(agentProviderConnections)
    .innerJoin(providerConnections, and(
      eq(providerConnections.serverId, agentProviderConnections.serverId),
      eq(providerConnections.id, agentProviderConnections.connectionId),
    ))
    .where(inArray(agentProviderConnections.agentId, connectionIds));
  const connectionOf = new Map(connectionRows.map((row) => [`${row.serverId}:${row.agentId}`, { providerId: row.providerId, endpointUrl: row.endpointUrl }]));
  return candidates.filter((agent) => isBuiltInGatewayCustomModelConfig(agent.runtimeConfig, connectionOf.get(`${agent.serverId}:${agent.id}`) ?? null));
}

/**
 * The agents with a `modelLimits` signal among the given ids: whom to push
 * `agent:updated` to when an input of that signal changed (a session, a
 * config revision), and no one else.
 */
export async function listModelLimitsAgents(
  where: { agentIds: readonly string[] },
  db: DatabaseExecutor = getDb(),
): Promise<Array<{ id: string; serverId: string; assistantOwnerUserId: string | null }>> {
  if (where.agentIds.length === 0) return [];
  const rows = await db.select({
    id: agents.id,
    serverId: agents.serverId,
    assistantOwnerUserId: agents.assistantOwnerUserId,
    runtime: agents.runtime,
    model: agents.model,
    runtimeConfig: agents.runtimeConfig,
    reasoningEffort: agents.reasoningEffort,
    envVars: agents.envVars,
  }).from(agents).where(and(
    eq(agents.runtime, "builtin"),
    inArray(agents.id, [...where.agentIds]),
  ));
  const hydrated = rows.flatMap((row) => {
    try {
      return [{ ...row, runtimeConfig: hydrateRuntimeConfig(row as RuntimeConfigHydrationInput) }];
    } catch {
      return [];
    }
  });
  return (await modelLimitsEligible(hydrated, db)).map(({ id, serverId, assistantOwnerUserId }) => ({ id, serverId, assistantOwnerUserId }));
}

/** One agent's `modelLimits`, or null when its saved config is not a Built-in custom gateway model. */
export async function getAgentModelLimitsWarning(input: {
  agentId: string;
  serverId: string;
  runtimeConfig: RuntimeConfig | null | undefined;
  db?: DatabaseExecutor;
}): Promise<AgentModelLimitsWarning | null> {
  const warnings = await getAgentModelLimitsWarnings({
    agents: [{ id: input.agentId, serverId: input.serverId, runtimeConfig: input.runtimeConfig }],
    ...(input.db ? { db: input.db } : {}),
  });
  return warnings.get(input.agentId) ?? null;
}
