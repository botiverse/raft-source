/**
 * Writing a member's personal grants (RFC 087 §4.3, §6): which Agents use their own Connection of an
 * App. Shared by the agents API (PUT /api/mcp/connections/:connectionId/agents) and a personal
 * sign-in's callback (intent.agentIds), so both apply the same checks at the moment of the write.
 *
 * - The Connection is the owner's personal one and the owner may still hold one (the Server flag on,
 *   a member who is not a guest: personalOwnerRefusal). The App's members_can_connect is NOT asked:
 *   turning it off stops new Connections only (Q26), so the owner keeps choosing agents for theirs.
 * - An Agent may be any Agent on the Server the owner can find (agentFindableBy): their own personal
 *   assistant, never someone else's. Deleted Agents are not on the Server.
 * - One personal grant per Agent and App (the table's key): giving an Agent that uses another
 *   member's account (or another of the owner's own) MOVES it, in this transaction. The previous
 *   owner is reported for the notice.
 * - Writes serialize per App on its row (FOR UPDATE, the order setServerDefaultConnection locks in),
 *   so two members giving one Agent at once each see the other's grant as the one they replace.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { ServerRole } from "@botiverse/raft-shared";
import type { DatabaseExecutor } from "../db/index";
import { agents, managedMcpCredentials, managedMcpPersonalGrants, managedMcpServers } from "../db/schema";
import { agentFindableBy } from "./agentMemberListPolicy";
import { bumpAgentConfigRevision } from "./agentConfigRevision";
import { recordMcpConnectionAudit } from "./managedMcpConnectionAudit";
import type { PersonalGrantNotice } from "./managedMcpAccountNotices";
import { PERSONAL_ACCOUNT_REFUSAL_MESSAGES, personalOwnerRefusal } from "./managedMcpPersonalAccounts";
import { ManagedMcpServiceError, resolveAdmittedConnectionCardsForApp } from "./managedMcpService";

/** At most this many Agents in one write. */
export const MAX_AGENTS_PER_WRITE = 100;

export type VisibleAgent = {
  id: string;
  creatorType: "user" | "agent" | null;
  creatorId: string | null;
  assistantOwnerUserId: string | null;
};

/**
 * The Agents of `agentIds` on this Server that `viewerUserId` may find (not deleted; never another
 * person's personal assistant). Those missing from the result are, to the viewer, no Agent.
 */
export async function loadAgentsVisibleTo(
  executor: DatabaseExecutor,
  serverId: string,
  viewerUserId: string,
  agentIds: readonly string[],
): Promise<Map<string, VisibleAgent>> {
  if (agentIds.length === 0) return new Map();
  const rows = await executor
    .select({
      id: agents.id,
      creatorType: agents.creatorType,
      creatorId: agents.creatorId,
      assistantOwnerUserId: agents.assistantOwnerUserId,
    })
    .from(agents)
    .where(and(
      eq(agents.serverId, serverId),
      inArray(agents.id, [...agentIds]),
      isNull(agents.deletedAt),
      agentFindableBy({ userId: viewerUserId }),
    ));
  return new Map(rows.map((row) => [row.id, row]));
}

/** Every listed Agent visible to the viewer, or `managed_mcp_agent_not_found` (unknown and hidden alike). */
export async function requireAgentsVisibleTo(
  executor: DatabaseExecutor,
  serverId: string,
  viewerUserId: string,
  agentIds: readonly string[],
): Promise<Map<string, VisibleAgent>> {
  const found = await loadAgentsVisibleTo(executor, serverId, viewerUserId, agentIds);
  if (agentIds.some((agentId) => !found.has(agentId))) {
    throw new ManagedMcpServiceError("Agent not found", "managed_mcp_agent_not_found");
  }
  return found;
}

export interface PersonalGrantsWrite {
  serverId: string;
  connectionId: string;
  /** The person writing: the Connection's owner. */
  actorUserId: string;
  actorRole?: ServerRole | null;
  agentIds: readonly string[];
  /**
   * `replace`: the Connection is given to exactly these Agents (the agents API).
   * `add`: these are added, the others kept; Agents the owner can no longer give it to are skipped,
   * never failing the write (a sign-in's callback: the sign-in itself stands).
   */
  mode: "replace" | "add";
  /**
   * An Agent the owner can't give it to (unknown, deleted, someone else's personal assistant):
   * `refuse` fails the write with `managed_mcp_agent_not_found`, `skip` leaves it out. Defaults:
   * `refuse` for `replace`, `skip` for `add` (the sign-in's callback). The Connect card's choice
   * (PUT /api/mcp/connections/:connectionId/agents/:agentId) is an `add` that refuses.
   */
  onUnavailable?: "refuse" | "skip";
  via: "agents_api" | "sign_in";
}

export interface PersonalGrantsResult {
  appId: string;
  agentIds: string[];
  added: string[];
  removed: string[];
  moved: Array<{ agentId: string; fromConnectionId: string; fromOwnerUserId: string | null }>;
  /** For notifyPersonalGrants after commit; null when nothing was granted. */
  notice: PersonalGrantNotice | null;
}

/** Writes the grants in the caller's transaction (after the caller's own authorization). */
export async function writePersonalGrants(
  tx: DatabaseExecutor,
  input: PersonalGrantsWrite,
  closedCards?: string[],
): Promise<PersonalGrantsResult> {
  const [connection] = await tx
    .select({
      id: managedMcpCredentials.id,
      mcpServerId: managedMcpCredentials.mcpServerId,
      ownerKind: managedMcpCredentials.ownerKind,
      ownerUserId: managedMcpCredentials.ownerUserId,
    })
    .from(managedMcpCredentials)
    .where(and(eq(managedMcpCredentials.id, input.connectionId), eq(managedMcpCredentials.serverId, input.serverId)))
    .limit(1);
  if (!connection) throw new ManagedMcpServiceError("MCP connection not found", "managed_mcp_connection_not_found");
  if (connection.ownerKind !== "personal" || connection.ownerUserId !== input.actorUserId) {
    throw new ManagedMcpServiceError("Only the person whose own account this is can choose its agents.", "managed_mcp_connection_forbidden");
  }
  const refusal = await personalOwnerRefusal(tx, { serverId: input.serverId, userId: input.actorUserId });
  if (refusal) throw new ManagedMcpServiceError(PERSONAL_ACCOUNT_REFUSAL_MESSAGES[refusal], refusal);

  const [app] = await tx
    .select({ id: managedMcpServers.id, name: managedMcpServers.name })
    .from(managedMcpServers)
    .where(and(eq(managedMcpServers.id, connection.mcpServerId), eq(managedMcpServers.serverId, input.serverId)))
    .for("update");
  if (!app) throw new ManagedMcpServiceError("MCP App not found", "managed_mcp_server_not_found");
  // Read again under the App's lock, and held: a delete that committed since the first read answers
  // as an unknown Connection here (not a failed insert), and one that starts now waits for this write
  // (deleteMcpConnection locks the App row first too).
  const [held] = await tx
    .select({ id: managedMcpCredentials.id })
    .from(managedMcpCredentials)
    .where(eq(managedMcpCredentials.id, connection.id))
    .for("share");
  if (!held) throw new ManagedMcpServiceError("MCP connection not found", "managed_mcp_connection_not_found");

  const asked = [...new Set(input.agentIds)];
  const visible = (input.onUnavailable ?? (input.mode === "replace" ? "refuse" : "skip")) === "refuse"
    ? await requireAgentsVisibleTo(tx, input.serverId, input.actorUserId, asked)
    : await loadAgentsVisibleTo(tx, input.serverId, input.actorUserId, asked);
  const wanted = asked.filter((agentId) => visible.has(agentId));

  const current = (await tx
    .select({ agentId: managedMcpPersonalGrants.agentId })
    .from(managedMcpPersonalGrants)
    .where(eq(managedMcpPersonalGrants.connectionId, connection.id)))
    .map((row) => row.agentId);
  const currentSet = new Set(current);
  const wantedSet = new Set(wanted);
  const added = wanted.filter((agentId) => !currentSet.has(agentId));
  const removed = input.mode === "replace" ? current.filter((agentId) => !wantedSet.has(agentId)) : [];

  // The grants the added Agents hold on this App now, on another Connection: what a move replaces.
  const replaced = added.length === 0 ? [] : await tx
    .select({
      agentId: managedMcpPersonalGrants.agentId,
      connectionId: managedMcpPersonalGrants.connectionId,
      ownerUserId: managedMcpCredentials.ownerUserId,
    })
    .from(managedMcpPersonalGrants)
    .innerJoin(managedMcpCredentials, eq(managedMcpCredentials.id, managedMcpPersonalGrants.connectionId))
    .where(and(eq(managedMcpPersonalGrants.mcpServerId, app.id), inArray(managedMcpPersonalGrants.agentId, added)))
    .for("update", { of: managedMcpPersonalGrants });
  const moved = replaced.map((row) => ({ agentId: row.agentId, fromConnectionId: row.connectionId, fromOwnerUserId: row.ownerUserId }));

  if (removed.length > 0) {
    await tx.delete(managedMcpPersonalGrants).where(and(
      eq(managedMcpPersonalGrants.connectionId, connection.id),
      inArray(managedMcpPersonalGrants.agentId, removed),
    ));
  }
  if (added.length > 0) {
    await tx.insert(managedMcpPersonalGrants).values(added.map((agentId) => ({
      serverId: input.serverId,
      agentId,
      mcpServerId: app.id,
      connectionId: connection.id,
      grantedByUserId: input.actorUserId,
    }))).onConflictDoUpdate({
      target: [managedMcpPersonalGrants.agentId, managedMcpPersonalGrants.mcpServerId],
      set: {
        connectionId: sql`excluded.connection_id`,
        grantedByUserId: sql`excluded.granted_by_user_id`,
        createdAt: sql`now()`,
      },
    });
  }
  const changed = [...added, ...removed];
  if (changed.length > 0) {
    await recordMcpConnectionAudit(tx, {
      eventType: "mcp_connection.agents_changed",
      serverId: input.serverId,
      app,
      connection: { id: connection.id, ownerKind: "personal", ownerUserId: connection.ownerUserId },
      actorUserId: input.actorUserId,
      actorRole: input.actorRole ?? null,
      metadata: {
        granted_by: input.actorUserId,
        added,
        removed,
        moved_from: moved.map((move) => ({ agentId: move.agentId, connectionId: move.fromConnectionId, ownerKind: "personal", ownerUserId: move.fromOwnerUserId })),
        via: input.via,
      },
    });
    // The Agents' runtime config names the App's account kind (RFC 087 §8, a later change); every call
    // is re-admitted live either way.
    await bumpAgentConfigRevision(tx, changed);
    // A grant can admit an Agent whose Connect card is open: close it, as every other grant does.
    if (added.length > 0) await resolveAdmittedConnectionCardsForApp(tx, { serverId: input.serverId, mcpServerId: app.id, userId: input.actorUserId }, closedCards);
  }
  const movedBy = new Map(moved.map((move) => [move.agentId, { ownerUserId: move.fromOwnerUserId, connectionId: move.fromConnectionId }]));
  const after = input.mode === "replace" ? wanted : [...new Set([...current, ...added])];
  return {
    appId: app.id,
    agentIds: after,
    added,
    removed,
    moved,
    notice: added.length === 0 ? null : {
      serverId: input.serverId,
      appId: app.id,
      granterUserId: input.actorUserId,
      connectionId: connection.id,
      items: added.map((agentId) => {
        const previous = movedBy.get(agentId);
        // Moving between two of the owner's own Connections tells nobody "you lost it".
        const told = previous && previous.ownerUserId !== input.actorUserId ? previous : null;
        return { agentId, previousOwnerUserId: told?.ownerUserId ?? null, previousConnectionId: told?.connectionId ?? null };
      }),
    },
  };
}
