// View Context grants (#wg-ax:#15; shared agentContextViewGrant.ts): the
// table's reads and writes, and the one decision on whether a grant lets an
// agent view another agent's context now.
//
// Warden's rule. A grant is usable only while, at that moment:
// - the target agent is on the grant's server, not deleted, and not a personal
//   assistant (never viewable through a grant, whoever granted it);
// - the grantee (the viewing agent) is on that server, not deleted, and an
//   ordinary agent (not a personal assistant, an App Bot or a later kind);
// - the grant is not revoked;
// - the granter's account is not retired, the granter is still an owner or
//   admin of the server (Tenny: a granter who loses that role takes the grant
//   with them, even for agents they created), and canViewAgentContext(granter,
//   target) holds.
// findUsableAgentContextViewGrant decides all of it, on every call
// (agentContextQueryApi.ts) and again when the result arrives
// (agentContextViewService.ts recheck), so the two cannot drift.
//
// Nothing deletes or rewrites a grant when one of these stops holding: the
// row stays and is unusable until it holds again or someone revokes it. The
// one exception is account deletion: the cleanup removes the grants the
// deleted account gave (accountDeletion/tableClassification.ts).

import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  asAgentContextViewGrantId,
  isAdminOrOwner,
  mintAgentContextViewGrantId,
  type AgentContextViewGrant,
  type AgentContextViewGrantId,
  type AgentContextViewGrantUnusableReason,
  type ServerRole,
} from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agentContextViewGrants, agents, serverMembers, users } from "../db/schema";
import { canViewAgentContext, getActorServerRoleInServer } from "../lib/actorPermissions";
import { agentKindOf } from "./agentMemberListPolicy";
import { getAgent } from "./agentService";
import { recordIntegrationAuditEvent, serverAuditContextMetadata } from "./integrationAuditService";

/** The fields of a target agent the decision reads. */
export type AgentContextViewGrantTarget = {
  id: string;
  serverId: string;
  creatorType: string | null;
  creatorId: string | null;
  assistantOwnerUserId: string | null;
  managedByAppInstallId?: string | null;
};

export type UsableAgentContextViewGrant = { id: AgentContextViewGrantId; granterUserId: string };

/** Only ordinary agents hold a grant: not a personal assistant, an App Bot or any later kind. */
function isOrdinaryAgent(agent: { assistantOwnerUserId?: string | null; managedByAppInstallId?: string | null }): boolean {
  return agentKindOf(agent) === "ordinary";
}

/**
 * The grant that lets `viewerAgentId` view `target`'s context on `serverId`
 * right now, or null. With `grantId` (the result-arrival recheck), only that
 * grant counts. Never for an agent viewing itself (that needs no grant).
 */
export async function findUsableAgentContextViewGrant(input: {
  serverId: string;
  viewerAgentId: string;
  target: AgentContextViewGrantTarget;
  grantId?: AgentContextViewGrantId;
}): Promise<UsableAgentContextViewGrant | null> {
  const { serverId, viewerAgentId, target } = input;
  if (target.id === viewerAgentId || target.serverId !== serverId) return null;
  // A personal assistant's context is never viewable through a grant, even its owner's.
  if (target.assistantOwnerUserId) return null;
  const viewer = await getAgent(viewerAgentId);
  if (!viewer || viewer.serverId !== serverId || !isOrdinaryAgent(viewer)) return null;
  const [grant] = await getDb()
    .select({ id: agentContextViewGrants.id, granterUserId: agentContextViewGrants.granterUserId })
    .from(agentContextViewGrants)
    .innerJoin(users, eq(users.id, agentContextViewGrants.granterUserId))
    .where(and(
      eq(agentContextViewGrants.serverId, serverId),
      eq(agentContextViewGrants.granteeAgentId, viewerAgentId),
      isNull(agentContextViewGrants.revokedAt),
      // A deleted account keeps its membership row (history), so retirement is read here.
      isNull(users.retiredAt),
      ...(input.grantId ? [eq(agentContextViewGrants.id, input.grantId)] : []),
    ))
    .limit(1);
  if (!grant) return null;
  if (!isAdminOrOwner(await getActorServerRoleInServer(serverId, "user", grant.granterUserId))) return null;
  if (!await canViewAgentContext(serverId, grant.granterUserId, target)) return null;
  return grant;
}

/** Display names of current, not retired, non-Guest members of the server among `userIds`. */
export async function namedServerMembers(serverId: string, userIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  const rows = await getDb()
    .select({ id: users.id, name: sql<string>`coalesce(${users.displayName}, ${users.name})` })
    .from(serverMembers)
    .innerJoin(users, eq(users.id, serverMembers.userId))
    .where(and(
      eq(serverMembers.serverId, serverId),
      inArray(serverMembers.userId, ids),
      ne(serverMembers.role, "guest"),
      isNull(users.retiredAt),
    ));
  return new Map(rows.map((row) => [row.id, row.name]));
}

type GrantRow = { id: AgentContextViewGrantId; agentId: string; agentName: string; granterUserId: string; grantedAt: Date };

const grantColumns = {
  id: agentContextViewGrants.id,
  agentId: agentContextViewGrants.granteeAgentId,
  agentName: sql<string>`coalesce(${agents.displayName}, ${agents.name})`,
  granterUserId: agentContextViewGrants.granterUserId,
  grantedAt: agentContextViewGrants.grantedAt,
};

function toGrant(row: GrantRow, granterNames: Map<string, string>, unusable: Map<string, AgentContextViewGrantUnusableReason>): AgentContextViewGrant {
  const granterName = granterNames.get(row.granterUserId);
  const reason = unusable.get(row.id);
  return {
    id: row.id,
    agent: { id: row.agentId, name: row.agentName },
    granter: granterName === undefined ? null : { id: row.granterUserId, name: granterName },
    grantedAt: row.grantedAt.toISOString(),
    usable: reason === undefined,
    ...(reason ? { unusableReason: reason } : {}),
  };
}

/**
 * The grants among `rows` that fail a target-independent check, with the
 * first that fails: the granter gone (left, or account retired), the granter
 * no longer an owner or admin, the holder no longer an ordinary live agent of
 * the server. The same checks findUsableAgentContextViewGrant runs, minus the
 * per-target ones.
 */
async function unusableGrants(serverId: string, rows: readonly GrantRow[]): Promise<Map<string, AgentContextViewGrantUnusableReason>> {
  const out = new Map<string, AgentContextViewGrantUnusableReason>();
  if (rows.length === 0) return out;
  const db = getDb();
  const [granters, holders] = await Promise.all([
    db.select({ id: serverMembers.userId, role: serverMembers.role, retiredAt: users.retiredAt })
      .from(serverMembers)
      .innerJoin(users, eq(users.id, serverMembers.userId))
      .where(and(eq(serverMembers.serverId, serverId), inArray(serverMembers.userId, [...new Set(rows.map((row) => row.granterUserId))]))),
    db.select({ id: agents.id, serverId: agents.serverId, deletedAt: agents.deletedAt, assistantOwnerUserId: agents.assistantOwnerUserId, managedByAppInstallId: agents.managedByAppInstallId })
      .from(agents)
      .where(inArray(agents.id, [...new Set(rows.map((row) => row.agentId))])),
  ]);
  const granterById = new Map(granters.map((granter) => [granter.id, granter]));
  const holderById = new Map(holders.map((holder) => [holder.id, holder]));
  for (const row of rows) {
    const granter = granterById.get(row.granterUserId);
    const holder = holderById.get(row.agentId);
    if (!granter || granter.retiredAt) out.set(row.id, "granter_gone");
    else if (!isAdminOrOwner(granter.role as ServerRole)) out.set(row.id, "granter_not_admin");
    else if (!holder || holder.deletedAt || holder.serverId !== serverId || !isOrdinaryAgent(holder)) out.set(row.id, "agent_ineligible");
  }
  return out;
}

/** The server's active (unrevoked) grants, newest first, whether or not each is usable right now. */
export async function listActiveAgentContextViewGrants(serverId: string): Promise<AgentContextViewGrant[]> {
  const rows = await getDb()
    .select(grantColumns)
    .from(agentContextViewGrants)
    .innerJoin(agents, eq(agents.id, agentContextViewGrants.granteeAgentId))
    .where(and(eq(agentContextViewGrants.serverId, serverId), isNull(agentContextViewGrants.revokedAt)))
    .orderBy(desc(agentContextViewGrants.grantedAt), desc(agentContextViewGrants.id));
  const [names, unusable] = await Promise.all([
    namedServerMembers(serverId, rows.map((row) => row.granterUserId)),
    unusableGrants(serverId, rows),
  ]);
  return rows.map((row) => toGrant(row, names, unusable));
}

async function activeGrantOf(serverId: string, agentId: string, executor: DatabaseExecutor): Promise<GrantRow | null> {
  const [row] = await executor
    .select(grantColumns)
    .from(agentContextViewGrants)
    .innerJoin(agents, eq(agents.id, agentContextViewGrants.granteeAgentId))
    .where(and(
      eq(agentContextViewGrants.serverId, serverId),
      eq(agentContextViewGrants.granteeAgentId, agentId),
      isNull(agentContextViewGrants.revokedAt),
    ))
    .limit(1);
  return row ?? null;
}

export type CreateAgentContextViewGrantResult =
  | { kind: "created" | "existing"; grant: AgentContextViewGrant }
  /** No ordinary, live agent of this server has that id (an assistant or App Bot answers the same). */
  | { kind: "agent_not_grantable" };

/**
 * Grant `agentId` View Context of other agents on `serverId`. The caller has
 * checked the granter is an owner or admin (`granterRole`). One active grant
 * per agent: a second grant returns the first, unchanged. Audited in the same
 * transaction as the row.
 */
export async function createAgentContextViewGrant(input: {
  serverId: string;
  granterUserId: string;
  granterRole: ServerRole;
  agentId: string;
}): Promise<CreateAgentContextViewGrantResult> {
  if (!isAdminOrOwner(input.granterRole)) throw new Error("createAgentContextViewGrant needs an owner or admin granter");
  const agent = await getAgent(input.agentId);
  if (!agent || agent.serverId !== input.serverId || !isOrdinaryAgent(agent)) return { kind: "agent_not_grantable" };
  const result = await getDb().transaction(async (tx) => {
    const [inserted] = await tx.insert(agentContextViewGrants).values({
      id: mintAgentContextViewGrantId(),
      serverId: input.serverId,
      granteeAgentId: agent.id,
      granterUserId: input.granterUserId,
    }).onConflictDoNothing().returning({ id: agentContextViewGrants.id });
    const row = await activeGrantOf(input.serverId, agent.id, tx);
    if (!row) throw new Error("agent context view grant missing after insert");
    if (inserted) {
      await recordIntegrationAuditEvent({
        serverId: input.serverId,
        eventType: "agent.context_view_granted",
        outcome: "success",
        source: "web",
        actor: { type: "human", id: input.granterUserId },
        subject: { type: "agent", id: agent.id },
        target: { type: "agent_context_view_grant", id: row.id },
        metadata: { grantId: row.id, agentId: agent.id, ...serverAuditContextMetadata({ actorRole: input.granterRole }) },
      }, tx);
    }
    return { kind: inserted ? "created" as const : "existing" as const, row };
  });
  const [names, unusable] = await Promise.all([
    namedServerMembers(input.serverId, [result.row.granterUserId]),
    unusableGrants(input.serverId, [result.row]),
  ]);
  return { kind: result.kind, grant: toGrant(result.row, names, unusable) };
}

export type RevokeAgentContextViewGrantResult =
  | { kind: "revoked" | "already_revoked" }
  | { kind: "not_found" }
  /** Neither its granter nor an owner or admin. */
  | { kind: "forbidden" };

/**
 * Revoke a grant of `serverId`: its granter (whatever their role now) or any
 * owner or admin. Idempotent: revoking a revoked grant changes nothing and
 * writes no audit row.
 */
export async function revokeAgentContextViewGrant(input: {
  serverId: string;
  grantId: string;
  userId: string;
  role: ServerRole;
}): Promise<RevokeAgentContextViewGrantResult> {
  const grantId = asAgentContextViewGrantId(input.grantId);
  if (!grantId) return { kind: "not_found" };
  return getDb().transaction(async (tx) => {
    const [grant] = await tx.select().from(agentContextViewGrants)
      .where(and(eq(agentContextViewGrants.id, grantId), eq(agentContextViewGrants.serverId, input.serverId)))
      .limit(1);
    if (!grant) return { kind: "not_found" as const };
    const byGranter = grant.granterUserId === input.userId;
    if (!byGranter && !isAdminOrOwner(input.role)) return { kind: "forbidden" as const };
    if (grant.revokedAt) return { kind: "already_revoked" as const };
    const [revoked] = await tx.update(agentContextViewGrants)
      .set({ revokedAt: new Date(), revokedByUserId: input.userId })
      .where(and(eq(agentContextViewGrants.id, grantId), isNull(agentContextViewGrants.revokedAt)))
      .returning({ id: agentContextViewGrants.id });
    if (!revoked) return { kind: "already_revoked" as const };
    await recordIntegrationAuditEvent({
      serverId: input.serverId,
      eventType: "agent.context_view_grant_revoked",
      outcome: "success",
      source: "web",
      actor: { type: "human", id: input.userId },
      subject: { type: "agent", id: grant.granteeAgentId },
      target: { type: "agent_context_view_grant", id: grant.id },
      metadata: {
        grantId: grant.id,
        agentId: grant.granteeAgentId,
        granterUserId: grant.granterUserId,
        byGranter,
        ...serverAuditContextMetadata({ actorRole: input.role }),
      },
    }, tx);
    return { kind: "revoked" as const };
  });
}
