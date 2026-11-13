// View Context on this Server: the relay's database-bound parts (the result's
// re-check, the audit rows per view) and the viewers list read
// (GET /api/agents/:id/context-views). The relay itself is agentContextViewRelay.ts.
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import {
  AGENT_CONTEXT_VIEW_FEATURE_FLAG_KEY,
  asAgentContextViewGrantId,
  isAgentContextViewFailureReason,
  redactDiagnosticSecrets,
  type AgentContextViewOutcome,
  type AgentContextViewQueryRecord,
  type AgentContextViewRecord,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agents, integrationAuditEvents, serverMembers, users } from "../db/schema";
import { canViewAgentContext } from "../lib/actorPermissions";
import { getLocalReplicaReplayEndpoint, REPLICA_ID } from "../replicaRouter";
import { getAgent } from "./agentService";
import { loadAgentComputer } from "./agentContextViewStatusService";
import { evaluateFeatureFlag } from "./featureFlagService";
import { findUsableAgentContextViewGrant, namedServerMembers } from "./agentContextViewGrantService";
import { recordIntegrationAuditEvent, recordIntegrationAuditEventBestEffort } from "./integrationAuditService";
import {
  AgentContextViewRelay,
  type AgentContextViewAttemptEntry,
  type AgentContextViewAuditEntry,
  type AgentContextViewGrantUse,
  type AgentContextViewRecheck,
  type AgentContextViewRelayDeps,
} from "./agentContextViewRelay";
import { redisAgentContextViewRequestStore, type AgentContextViewRequestRecord } from "./replicaStateStore";

// Two append-only rows per view, linked by the row's `request_id` (the audit
// table is insert-only, so the outcome cannot be written into the attempt's row):
// - CONTEXT_VIEW_REQUESTED, the attempt: required, written before the request
//   is stored or sent, so every context read has a record.
// - CONTEXT_VIEWED, the outcome: best-effort, written when the view ends. An
//   attempt without one (the write failed, or the viewer's replica stopped
//   mid-view) is listed `cancelled`.
const CONTEXT_VIEW_REQUESTED = "agent.context_view_requested";
const CONTEXT_VIEWED = "agent.context_viewed";

/** The most views the viewers list returns (newest first). */
export const AGENT_CONTEXT_VIEWS_LIMIT = 100;

/**
 * When the result arrives, the request's own refusal rule again, in the same
 * order: the agent as it is now (missing, deleted or another Server's), the
 * flag and the viewer's access (canViewAgentContext) are all `refused` (the
 * viewer gets the unknown-agent 404). Only once those pass is a change of
 * Computer told apart, as `agent_moved`.
 *
 * An agent viewer (its search or read): its own context needs only the flag.
 * Another agent's needs the very grant the request used, still usable
 * (findUsableAgentContextViewGrant: not revoked, the viewer still an ordinary
 * agent of the server, the target not a personal assistant, the granter's
 * account live and canViewAgentContext(granter, target) true now); a record
 * without a grant id (an older replica's) is refused. A refused result is
 * never delivered.
 */
export async function recheckAgentContextViewRequest(record: AgentContextViewRequestRecord): Promise<AgentContextViewRecheck> {
  const agent = await getAgent(record.agentId);
  if (!agent || agent.serverId !== record.serverId) return "refused";
  if (record.viewerKind === "agent") {
    const flag = await evaluateFeatureFlag({ key: AGENT_CONTEXT_VIEW_FEATURE_FLAG_KEY, serverId: record.serverId });
    if (!flag.enabled) return "refused";
    if (record.viewerUserId !== agent.id) {
      if (!record.grantId) return "refused";
      const grant = await findUsableAgentContextViewGrant({
        serverId: record.serverId,
        viewerAgentId: record.viewerUserId,
        target: agent,
        grantId: record.grantId,
      });
      if (!grant) return "refused";
    }
    return agent.machineId === record.machineId ? "ok" : "agent_moved";
  }
  const flag = await evaluateFeatureFlag({ key: AGENT_CONTEXT_VIEW_FEATURE_FLAG_KEY, serverId: record.serverId, userId: record.viewerUserId });
  if (!flag.enabled || !await canViewAgentContext(record.serverId, record.viewerUserId, agent)) return "refused";
  return agent.machineId === record.machineId ? "ok" : "agent_moved";
}

/**
 * An agent's query as stored: the search text redacted like any diagnostic
 * text, never longer than the CLI allows; and the grant it used, if any, with
 * that grant's granter (whose grant it was).
 */
function queryMetadata(query: AgentContextViewQueryRecord | undefined, grant: AgentContextViewGrantUse | undefined): Record<string, unknown> {
  const used = grant ? { grantId: grant.id, granterUserId: grant.granterUserId } : {};
  if (!query) return used;
  if (query.mode === "read") return { mode: "read", around: query.around, ...used };
  return { mode: "search", query: redactDiagnosticSecrets(query.query).text.slice(0, 200), ...(query.matches === null ? {} : { matches: query.matches }), ...used };
}

/** The attempt's row, for every view that passed the access check; throws when it could not be written. Never anything from the context. */
export async function recordAgentContextViewAttempt(entry: AgentContextViewAttemptEntry): Promise<void> {
  const byAgent = entry.viewerKind === "agent";
  await recordIntegrationAuditEvent({
    serverId: entry.serverId,
    eventType: CONTEXT_VIEW_REQUESTED,
    outcome: "success",
    source: byAgent ? "cli" : "web",
    actor: { type: byAgent ? "agent" : "human", id: entry.viewerUserId },
    subject: { type: "agent", id: entry.agentId },
    target: { type: "message", id: entry.messageId },
    requestId: entry.requestId,
    metadata: {
      agentId: entry.agentId,
      messageId: entry.messageId,
      machineId: entry.machineId,
      viewerType: byAgent ? "agent" : "user",
      ...queryMetadata(entry.query, entry.grant),
    },
  });
}

/** The attempt's outcome row (best-effort). Never anything from the context. */
export async function recordAgentContextView(entry: AgentContextViewAuditEntry): Promise<void> {
  const byAgent = entry.viewerKind === "agent";
  await recordIntegrationAuditEventBestEffort({
    serverId: entry.serverId,
    eventType: CONTEXT_VIEWED,
    outcome: entry.outcome === "ok" ? "success" : "failure",
    source: byAgent ? "cli" : "web",
    actor: { type: byAgent ? "agent" : "human", id: entry.viewerUserId },
    subject: { type: "agent", id: entry.agentId },
    target: { type: "message", id: entry.messageId },
    requestId: entry.requestId,
    metadata: {
      agentId: entry.agentId,
      messageId: entry.messageId,
      machineId: entry.machineId,
      viewerType: byAgent ? "agent" : "user",
      ...queryMetadata(entry.query, entry.grant),
      outcome: entry.outcome,
      ...(entry.bytes !== null ? { bytes: entry.bytes } : {}),
      runtime: entry.runtime,
      durationMs: entry.durationMs,
    },
  });
}

/**
 * Who viewed the agent's context (optionally for one message): one entry per
 * attempt, newest first, at most AGENT_CONTEXT_VIEWS_LIMIT, with its outcome
 * (`cancelled` when no outcome row was written). A viewer is named only while
 * a current, not retired, non-Guest member of the agent's Server; otherwise
 * null ("former member").
 */
export async function listAgentContextViews(input: { serverId: string; agentId: string; messageId?: string }): Promise<AgentContextViewRecord[]> {
  const ofThisAgent = (eventType: string) => and(
    eq(integrationAuditEvents.serverId, input.serverId),
    eq(integrationAuditEvents.eventType, eventType),
    eq(integrationAuditEvents.subjectType, "agent"),
    eq(integrationAuditEvents.subjectId, input.agentId),
    ...(input.messageId ? [eq(integrationAuditEvents.targetId, input.messageId)] : []),
  );
  const attempts = await getDb()
    .select({
      requestId: integrationAuditEvents.requestId,
      at: integrationAuditEvents.createdAt,
      viewerId: users.id,
      viewerName: sql<string | null>`coalesce(${users.displayName}, ${users.name})`,
      actorType: integrationAuditEvents.actorType,
      actorId: integrationAuditEvents.actorId,
      metadata: integrationAuditEvents.metadata,
      agentViewerName: sql<string | null>`(select coalesce(${agents.displayName}, ${agents.name}) from ${agents} where ${agents.id} = ${integrationAuditEvents.actorId} and ${agents.serverId} = ${input.serverId} and ${agents.deletedAt} is null)`,
    })
    .from(integrationAuditEvents)
    .leftJoin(users, and(
      eq(users.id, integrationAuditEvents.actorId),
      isNull(users.retiredAt),
      sql`exists (select 1 from ${serverMembers} where ${serverMembers.serverId} = ${input.serverId} and ${serverMembers.userId} = ${users.id} and ${serverMembers.role} <> 'guest')`,
    ))
    .where(ofThisAgent(CONTEXT_VIEW_REQUESTED))
    .orderBy(desc(integrationAuditEvents.createdAt), desc(integrationAuditEvents.id))
    .limit(AGENT_CONTEXT_VIEWS_LIMIT);
  const requestIds = attempts.flatMap((row) => row.requestId ? [row.requestId] : []);
  const oldest = attempts.at(-1)?.at;
  // The outcome rows of these attempts (each written at or after its attempt).
  const outcomes = requestIds.length > 0 && oldest
    ? await getDb()
      .select({
        requestId: integrationAuditEvents.requestId,
        outcome: sql<string | null>`${integrationAuditEvents.metadata}->>'outcome'`,
      })
      .from(integrationAuditEvents)
      .where(and(
        ofThisAgent(CONTEXT_VIEWED),
        gte(integrationAuditEvents.createdAt, oldest),
        inArray(integrationAuditEvents.requestId, requestIds),
      ))
    : [];
  // Whose grant each agent's view of another agent used, named while a current member.
  const granterIds = attempts.flatMap((row) => {
    const id = row.actorType === "agent" ? row.metadata?.granterUserId : undefined;
    return typeof id === "string" ? [id] : [];
  });
  const granterNames = await namedServerMembers(input.serverId, granterIds);
  const outcomeByRequest = new Map<string, AgentContextViewOutcome>();
  for (const row of outcomes) {
    const outcome = readOutcome(row.outcome);
    if (row.requestId && outcome) outcomeByRequest.set(row.requestId, outcome);
  }
  return attempts.map((row): AgentContextViewRecord => {
    const outcome = (row.requestId ? outcomeByRequest.get(row.requestId) : undefined) ?? "cancelled";
    if (row.actorType === "agent") {
      // An agent's search or read: named while it is still an agent of this Server.
      const query = readQueryRecord(row.metadata);
      const grant = readGrantRecord(row.metadata, granterNames);
      return {
        viewer: row.actorId && row.agentViewerName !== null ? { id: row.actorId, name: row.agentViewerName } : null,
        viewerKind: "agent",
        at: row.at.toISOString(),
        outcome,
        ...(query ? { query } : {}),
        ...(grant ? { grant } : {}),
      };
    }
    return { viewer: row.viewerId ? { id: row.viewerId, name: row.viewerName ?? "" } : null, at: row.at.toISOString(), outcome };
  });
}

function readQueryRecord(metadata: Record<string, unknown> | null): AgentContextViewQueryRecord | null {
  if (!metadata) return null;
  if (metadata.mode === "read" && typeof metadata.around === "string") return { mode: "read", around: metadata.around };
  if (metadata.mode === "search" && typeof metadata.query === "string") {
    return { mode: "search", query: metadata.query, matches: typeof metadata.matches === "number" ? metadata.matches : null };
  }
  return null;
}

function readGrantRecord(metadata: Record<string, unknown> | null, granterNames: Map<string, string>): AgentContextViewRecord["grant"] | null {
  const grantId = typeof metadata?.grantId === "string" ? asAgentContextViewGrantId(metadata.grantId) : null;
  if (!grantId) return null;
  const granterId = typeof metadata?.granterUserId === "string" ? metadata.granterUserId : null;
  const granterName = granterId ? granterNames.get(granterId) : undefined;
  return { id: grantId, granter: granterId && granterName !== undefined ? { id: granterId, name: granterName } : null };
}

function readOutcome(value: string | null): AgentContextViewOutcome | null {
  if (value === "ok" || value === "refused" || value === "cancelled") return value;
  return isAgentContextViewFailureReason(value) ? value : null;
}

/** The relay with this Server's store, replica identity and database checks; tests may override parts. */
export function createAgentContextViewRelay(overrides: Partial<AgentContextViewRelayDeps> = {}): AgentContextViewRelay {
  return new AgentContextViewRelay({
    store: redisAgentContextViewRequestStore,
    replicaId: REPLICA_ID,
    replicaEndpoint: getLocalReplicaReplayEndpoint,
    recheck: recheckAgentContextViewRequest,
    recordAttempt: recordAgentContextViewAttempt,
    describeComputer: async (machineId, serverId) => {
      const found = await loadAgentComputer(machineId, serverId);
      return { computer: found?.computer ?? null, computerOwner: found?.computerOwner ?? null };
    },
    audit: recordAgentContextView,
    ...overrides,
  });
}
