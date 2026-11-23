/**
 * MCP App accounts (RFC 087 §6, §7.2): who manages an App's Connections and which Agents use them.
 *
 *   PUT    /api/mcp/apps/:appId/members-can-connect    setMembersCanConnect
 *   PUT    /api/mcp/connections/:connectionId/agents   setMcpConnectionAgents
 *   PUT    /api/mcp/connections/:connectionId/agents/:agentId   setMcpConnectionAgents (add; the Connect card)
 *   DELETE /api/mcp/connections/:connectionId          deleteMcpConnection (also the App-scoped DELETE)
 *   GET    /api/mcp/accounts                           listMcpAccounts
 *
 * A shared Connection is the admins' (`manageExternalAuth`): "All agents" is the App's default, "Only
 * these agents" the Agents pinned to it. A personal Connection is its owner's: they give it to Agents
 * through personal grants (managedMcpPersonalGrants.ts). The routes check the person's own session
 * and the role under the membership fence; these functions check what depends on the rows.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { ServerRole } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agents, managedMcpAssignments, managedMcpCredentials, managedMcpPersonalGrants, managedMcpServers } from "../db/schema";
import { actorHasServerCapabilityInServer, actorRoleHasServerCapability, getActorServerRoleInServer } from "../lib/actorPermissions";
import { lockActorMembershipRow, withActorMembershipFence } from "../lib/actorMembershipFence";
import { clientLogoUrl } from "../config/privacyMode";
import { agentFindableBy } from "./agentMemberListPolicy";
import { bumpAgentConfigRevision } from "./agentConfigRevision";
import { externalChannelsOfServerSql } from "./externalChannelFreezeState";
import { notifyPersonalConnectionRevoked } from "./managedMcpAccountNotices";
import { diffPins, recordMcpConnectionAudit, recordMembersCanConnectAudit } from "./managedMcpConnectionAudit";
import { setServerDefaultConnection } from "./managedMcpConnectionService";
import { disconnectManagedMcpOAuthConnection } from "./managedMcpOAuthService";
import { mcpPersonalAccountsEnabled } from "./managedMcpPersonalAccounts";
import { loadAgentsVisibleTo, requireAgentsVisibleTo, writePersonalGrants, type PersonalGrantsResult } from "./managedMcpPersonalGrants";
import { readSignedInByDeparted, signedInByView, type ManagedMcpSignedInBy } from "./managedMcpSignedInBy";
import { ManagedMcpServiceError, setManagedMcpAssignment } from "./managedMcpService";

type CredentialRow = typeof managedMcpCredentials.$inferSelect;

/* ------------------------------------------------------------------ members_can_connect */

/**
 * Turns "Members can connect their own account" on or off for an App (D1), in the caller's fenced
 * transaction, audited when it changes. The Server flag must be on (the route asks first). Off stops
 * new personal Connections and personal sign-ins only; existing ones and their grants stay (Q26).
 */
export async function setMembersCanConnect(tx: DatabaseExecutor, input: {
  serverId: string;
  appId: string;
  actorUserId: string;
  actorRole: ServerRole;
  enabled: boolean;
}): Promise<{ changed: boolean }> {
  const [app] = await tx
    .select({ id: managedMcpServers.id, name: managedMcpServers.name, membersCanConnect: managedMcpServers.membersCanConnect })
    .from(managedMcpServers)
    .where(and(eq(managedMcpServers.id, input.appId), eq(managedMcpServers.serverId, input.serverId)))
    .for("update");
  if (!app) throw new ManagedMcpServiceError("MCP App not found", "managed_mcp_server_not_found");
  if (app.membersCanConnect === input.enabled) return { changed: false };
  await tx.update(managedMcpServers)
    .set({ membersCanConnect: input.enabled, updatedAt: new Date() })
    .where(eq(managedMcpServers.id, app.id));
  await recordMembersCanConnectAudit(tx, {
    serverId: input.serverId,
    app,
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    enabled: input.enabled,
    previous: app.membersCanConnect,
  });
  return { changed: true };
}

/* ------------------------------------------------------------------ shared pins: audit */

/**
 * The shared pins of these Agents on these Apps: `${agentId}:${appId}` → the bound Connection (null:
 * following the default, or pinned to nothing). Read before and after a write to audit what it changed.
 */
export async function readSharedPins(
  executor: DatabaseExecutor,
  serverId: string,
  pairs: ReadonlyArray<{ agentId: string; mcpServerId: string }>,
): Promise<Map<string, string | null>> {
  const pins = new Map<string, string | null>(pairs.map((pair) => [`${pair.agentId}:${pair.mcpServerId}`, null]));
  if (pairs.length === 0) return pins;
  const rows = await executor
    .select({ agentId: managedMcpAssignments.agentId, mcpServerId: managedMcpAssignments.mcpServerId, boundConnectionId: managedMcpAssignments.boundConnectionId })
    .from(managedMcpAssignments)
    .where(and(
      eq(managedMcpAssignments.serverId, serverId),
      eq(managedMcpAssignments.connectionMode, "pinned"),
      inArray(managedMcpAssignments.agentId, [...new Set(pairs.map((pair) => pair.agentId))]),
      inArray(managedMcpAssignments.mcpServerId, [...new Set(pairs.map((pair) => pair.mcpServerId))]),
    ));
  for (const row of rows) {
    const key = `${row.agentId}:${row.mcpServerId}`;
    if (pins.has(key)) pins.set(key, row.boundConnectionId);
  }
  return pins;
}

/**
 * `mcp_connection.agents_changed` for every shared Connection whose pins changed between the two
 * reads. `connectionCreatedBy` / `byConnectionCreator` make an admin pinning Agents to a Connection
 * someone else added visible (Tenny). Used by the agents API and the assignments routes alike.
 */
export async function auditSharedPinChanges(tx: DatabaseExecutor, input: {
  serverId: string;
  actorUserId: string;
  actorRole?: ServerRole | null;
  before: ReadonlyMap<string, string | null>;
  after: ReadonlyMap<string, string | null>;
  via: "agents_api" | "assignments" | "sign_in";
}): Promise<void> {
  const changes = diffPins(input.before, input.after);
  if (changes.length === 0) return;
  const rows = await tx
    .select({
      id: managedMcpCredentials.id,
      ownerKind: managedMcpCredentials.ownerKind,
      ownerUserId: managedMcpCredentials.ownerUserId,
      createdByUserId: managedMcpCredentials.createdByUserId,
      appId: managedMcpServers.id,
      appName: managedMcpServers.name,
    })
    .from(managedMcpCredentials)
    .innerJoin(managedMcpServers, eq(managedMcpServers.id, managedMcpCredentials.mcpServerId))
    .where(and(eq(managedMcpCredentials.serverId, input.serverId), inArray(managedMcpCredentials.id, changes.map((change) => change.connectionId))));
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const change of changes) {
    const row = byId.get(change.connectionId);
    if (!row) continue;
    await recordMcpConnectionAudit(tx, {
      eventType: "mcp_connection.agents_changed",
      serverId: input.serverId,
      app: { id: row.appId, name: row.appName },
      connection: { id: row.id, ownerKind: row.ownerKind, ownerUserId: row.ownerUserId },
      actorUserId: input.actorUserId,
      actorRole: input.actorRole ?? null,
      metadata: {
        granted_by: input.actorUserId,
        added: change.added,
        removed: change.removed,
        moved_from: change.movedFrom,
        connectionCreatedBy: row.createdByUserId,
        byConnectionCreator: row.createdByUserId === input.actorUserId,
        via: input.via,
      },
    });
  }
}

/* ------------------------------------------------------------------ agents API */

export interface McpConnectionAgentsResult {
  connectionId: string;
  kind: "shared" | "personal";
  /** A shared Connection that is the App's default ("All agents"). Always false for a personal one. */
  allAgents: boolean;
  /** The Agents given it now: personal grants, or shared pins. */
  agentIds: string[];
  added: string[];
  removed: string[];
  /** Added Agents that used another account this way before (another member's own, or another shared pin). */
  moved: Array<{ agentId: string; fromConnectionId: string; fromKind: "shared" | "personal"; fromOwnerUserId: string | null }>;
}

export interface McpConnectionAgentsWrite {
  serverId: string;
  connectionId: string;
  actorUserId: string;
  /** Read under the caller's membership fence. */
  actorRole: ServerRole;
  allAgents?: boolean;
  agentIds: string[];
  /**
   * `replace` (default): the Connection is given to exactly `agentIds` (PUT .../agents).
   * `add`: `agentIds` are given it too and nothing is taken away (`allAgents` refused): the Connect
   * card's choice (PUT .../agents/:agentId) and a sign-in's callback (RFC 087 §7.1).
   */
  mode?: "replace" | "add";
  /** As PersonalGrantsWrite: an Agent the actor can't find is refused (default) or skipped (the callback). */
  onUnavailable?: "refuse" | "skip";
  /** For the audit; default `agents_api`. */
  via?: "agents_api" | "sign_in";
}

/**
 * Chooses a Connection's Agents, in the caller's fenced transaction.
 *
 * Personal: the owner only (writePersonalGrants `replace`, or `add`); `allAgents` is refused.
 *
 * Shared: `manageExternalAuth`. `allAgents: true` makes it the App's default (agents created later
 * included; `agentIds` must then be empty). `allAgents: false` gives the default up (the App has none
 * until one is set); omitted leaves it. `agentIds` are the Agents pinned to it, exactly: listed ones
 * are pinned (an Agent pinned elsewhere moves), and an Agent pinned to it that is no longer listed
 * goes back to following the App's default, its shared account by D3 (rather than staying pinned to
 * nothing, refused). Pinning never grants or revokes the App itself (`enabled` is left alone).
 *
 * `mode: "add"` (the Connect card's choice, a sign-in's callback): the listed Agents are given it,
 * nobody is taken away, the default is not touched; the same authority as above.
 */
export async function setMcpConnectionAgents(
  tx: DatabaseExecutor,
  input: McpConnectionAgentsWrite,
  closedCards?: string[],
): Promise<{ result: McpConnectionAgentsResult; personal: PersonalGrantsResult | null; changedAgentIds: string[] }> {
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
  const agentIds = [...new Set(input.agentIds)];
  const adding = input.mode === "add";
  const via = input.via ?? "agents_api";
  if (adding && input.allAgents !== undefined) {
    throw new ManagedMcpServiceError("Giving an account to some agents doesn't change All agents.", "managed_mcp_connection_request_invalid");
  }

  if (connection.ownerKind === "personal") {
    if (connection.ownerUserId !== input.actorUserId) {
      throw new ManagedMcpServiceError("Only the person whose own account this is can choose its agents.", "managed_mcp_connection_forbidden");
    }
    if (input.allAgents === true) {
      throw new ManagedMcpServiceError("A member's own account can't be given to all agents; choose them.", "managed_mcp_connection_request_invalid");
    }
    const personal = await writePersonalGrants(tx, {
      serverId: input.serverId,
      connectionId: connection.id,
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      agentIds,
      mode: adding ? "add" : "replace",
      // Refused unless the caller asked to skip (the callback): the card's choice names one Agent.
      onUnavailable: input.onUnavailable ?? "refuse",
      via,
    }, closedCards);
    return {
      result: {
        connectionId: connection.id,
        kind: "personal",
        allAgents: false,
        agentIds: personal.agentIds,
        added: personal.added,
        removed: personal.removed,
        moved: personal.moved.map((move) => ({ agentId: move.agentId, fromConnectionId: move.fromConnectionId, fromKind: "personal" as const, fromOwnerUserId: move.fromOwnerUserId })),
      },
      personal,
      changedAgentIds: [...personal.added, ...personal.removed],
    };
  }

  if (!actorRoleHasServerCapability(input.actorRole, "manageExternalAuth")) {
    throw new ManagedMcpServiceError("Only a server admin can choose which agents use a shared account.", "managed_mcp_connection_forbidden");
  }
  if (input.allAgents === true && agentIds.length > 0) {
    throw new ManagedMcpServiceError("allAgents covers every agent; send no agentIds with it.", "managed_mcp_connection_request_invalid");
  }
  // The App row first, in the order setServerDefaultConnection locks: one shared-account change per App at a time.
  const [app] = await tx
    .select({ id: managedMcpServers.id })
    .from(managedMcpServers)
    .where(and(eq(managedMcpServers.id, connection.mcpServerId), eq(managedMcpServers.serverId, input.serverId)))
    .for("update");
  if (!app) throw new ManagedMcpServiceError("MCP App not found", "managed_mcp_server_not_found");
  const visibleAgents = input.onUnavailable === "skip"
    ? await loadAgentsVisibleTo(tx, input.serverId, input.actorUserId, agentIds)
    : await requireAgentsVisibleTo(tx, input.serverId, input.actorUserId, agentIds);
  const listed = agentIds.filter((agentId) => visibleAgents.has(agentId));
  // The list an admin saves is the list they can see: an Agent pinned here that they can't find
  // (another person's personal assistant, pinned by its owner) is neither returned nor unpinned.
  const pinnedNow = (await tx
    .select({ agentId: managedMcpAssignments.agentId })
    .from(managedMcpAssignments)
    .innerJoin(agents, eq(agents.id, managedMcpAssignments.agentId))
    .where(and(
      eq(managedMcpAssignments.mcpServerId, app.id),
      eq(managedMcpAssignments.connectionMode, "pinned"),
      eq(managedMcpAssignments.boundConnectionId, connection.id),
      eq(agents.serverId, input.serverId),
      isNull(agents.deletedAt),
      agentFindableBy({ userId: input.actorUserId }),
    )))
    .map((row) => row.agentId);
  const wanted = new Set(listed);
  const added = listed.filter((agentId) => !pinnedNow.includes(agentId));
  // Adding takes nobody away; "All agents" keeps the pins it had.
  const removed = adding || input.allAgents === true ? [] : pinnedNow.filter((agentId) => !wanted.has(agentId));
  const touched = [...added, ...removed].map((agentId) => ({ agentId, mcpServerId: app.id }));
  const before = await readSharedPins(tx, input.serverId, touched);

  // The default ("All agents") is audited by setServerDefaultConnection, for every write that moves it.
  const [current] = await tx
    .select({ isServerDefault: managedMcpCredentials.isServerDefault })
    .from(managedMcpCredentials)
    .where(eq(managedMcpCredentials.id, connection.id));
  const defaultChange = { serverId: input.serverId, mcpServerId: app.id, userId: input.actorUserId, actorRole: input.actorRole, via };
  if (input.allAgents === true && !current?.isServerDefault) {
    await setServerDefaultConnection(tx, { ...defaultChange, connectionId: connection.id }, closedCards);
  } else if (input.allAgents === false && current?.isServerDefault) {
    await setServerDefaultConnection(tx, { ...defaultChange, connectionId: null }, closedCards);
  }
  for (const agentId of added) {
    await setManagedMcpAssignment({ serverId: input.serverId, userId: input.actorUserId, agentId, mcpServerId: app.id, connectionId: connection.id }, { executor: tx, closedCards });
  }
  for (const agentId of removed) {
    await setManagedMcpAssignment({ serverId: input.serverId, userId: input.actorUserId, agentId, mcpServerId: app.id, connectionId: null }, { executor: tx, closedCards });
  }
  const after = await readSharedPins(tx, input.serverId, touched);
  // As the assignments routes: the daemon takes a new config only when the revision moves.
  await bumpAgentConfigRevision(tx, [...added, ...removed]);
  await auditSharedPinChanges(tx, {
    serverId: input.serverId,
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    before,
    after,
    via,
  });
  const moved = added.flatMap((agentId) => {
    const from = before.get(`${agentId}:${app.id}`) ?? null;
    return from && from !== connection.id ? [{ agentId, fromConnectionId: from, fromKind: "shared" as const, fromOwnerUserId: null }] : [];
  });
  return {
    result: {
      connectionId: connection.id,
      kind: "shared",
      allAgents: input.allAgents ?? current?.isServerDefault ?? false,
      agentIds: adding || input.allAgents === true ? [...new Set([...pinnedNow, ...added])] : listed,
      added,
      removed,
      moved,
    },
    personal: null,
    changedAgentIds: [...added, ...removed],
  };
}

/* ------------------------------------------------------------------ delete / revoke */

export interface McpConnectionDelete {
  serverId: string;
  connectionId: string;
  /** The App-scoped route names it; the account-scoped one does not. */
  appId?: string;
  actorUserId: string;
}

/**
 * Deletes a Connection: a personal one by its owner, or by an admin (`manageExternalAuth`: revoke,
 * D5, its owner is told); a shared one by whoever manages integrations (as before). The person's own
 * session is the route's.
 *
 * Tokens go first, with Disconnect's helper (disconnectManagedMcpOAuthConnection: under the lease,
 * pending sign-ins failed, tokens deleted), then the row; its personal grants cascade, and Agents
 * fall back to their shared account. Agents pinned to a deleted shared Connection stay pinned to
 * nothing and are refused (the dead-pin rule). Audited `mcp_connection.deleted`.
 */
export async function deleteMcpConnection(input: McpConnectionDelete): Promise<void> {
  // Authorized under the caller's membership row lock BEFORE any token is touched: someone who lost
  // the right, or a refusal, never wipes a sign-in.
  const row = await withActorMembershipFence(input.serverId, input.actorUserId, async (tx, role) => {
    const found = await loadConnectionRow(tx, input);
    assertMayDelete(found, input.actorUserId, role);
    return found;
  });
  // Tokens before the row (Disconnect's helper, under the lease).
  await disconnectStoredSignIn(input.serverId, row);
  const grantedAgentIds = await getDb().transaction(async (tx) => {
    // Re-read under the caller's membership row lock, as every fenced write (task #91).
    const lockedRole = await lockActorMembershipRow(tx, input.serverId, input.actorUserId);
    const [lockedApp] = await tx
      .select({ id: managedMcpServers.id, name: managedMcpServers.name, authMode: managedMcpServers.authMode })
      .from(managedMcpServers)
      .where(and(eq(managedMcpServers.id, row.mcpServerId), eq(managedMcpServers.serverId, input.serverId)))
      .for("update");
    if (!lockedApp) throw new ManagedMcpServiceError("MCP App not found", "managed_mcp_server_not_found");
    assertMayDelete(row, input.actorUserId, lockedRole);
    const granted = (await tx
      .select({ agentId: managedMcpPersonalGrants.agentId })
      .from(managedMcpPersonalGrants)
      .where(eq(managedMcpPersonalGrants.connectionId, row.id)))
      .map((grant) => grant.agentId);
    const [deleted] = await tx.delete(managedMcpCredentials)
      .where(and(eq(managedMcpCredentials.id, row.id), eq(managedMcpCredentials.serverId, input.serverId)))
      .returning({ isServerDefault: managedMcpCredentials.isServerDefault });
    if (!deleted) throw new ManagedMcpServiceError("MCP connection not found", "managed_mcp_connection_not_found");
    if (deleted.isServerDefault && lockedApp.authMode === "oauth") {
      await tx.update(managedMcpServers).set({ oauthStatus: "disconnected", updatedAt: new Date() }).where(eq(managedMcpServers.id, lockedApp.id));
    }
    const revokedByOther = row.ownerKind === "personal" && row.ownerUserId !== input.actorUserId;
    await recordMcpConnectionAudit(tx, {
      eventType: "mcp_connection.deleted",
      serverId: input.serverId,
      app: { id: lockedApp.id, name: lockedApp.name },
      connection: { id: row.id, ownerKind: row.ownerKind, ownerUserId: row.ownerUserId },
      actorUserId: input.actorUserId,
      actorRole: lockedRole,
      metadata: {
        ...(revokedByOther ? { revokedBy: input.actorUserId } : {}),
        wasServerDefault: deleted.isServerDefault,
        ...(granted.length > 0 ? { agentIds: granted } : {}),
      },
    });
    return granted;
  });
  if (row.ownerKind === "personal" && row.ownerUserId && row.ownerUserId !== input.actorUserId) {
    await notifyPersonalConnectionRevoked({
      serverId: input.serverId,
      appId: row.mcpServerId,
      connectionId: row.id,
      ownerUserId: row.ownerUserId,
      revokerUserId: input.actorUserId,
      agentCount: grantedAgentIds.length,
    });
  }
}

/**
 * Signs a Connection out (DELETE /api/mcp/apps/:appId/connections/:connectionId/oauth): tokens
 * deleted with Disconnect's helper, the row, its default flag, pins and grants kept (`needs_auth`;
 * Agents given a personal one fall back meanwhile). A personal Connection: its owner, or an admin
 * (`manageExternalAuth`: a revoke, its owner told); a shared one: manageIntegrations +
 * manageExternalAuth, as before. Authorized under the membership fence before the tokens go, then
 * audited (`mcp_connection.signed_out`, `revokedBy` when not the owner).
 */
export async function signOutMcpConnection(input: McpConnectionDelete & { appId: string }): Promise<void> {
  const { row, role } = await withActorMembershipFence(input.serverId, input.actorUserId, async (tx, lockedRole) => {
    const found = await loadConnectionRow(tx, input);
    const allowed = found.ownerKind === "personal"
      ? found.ownerUserId === input.actorUserId || actorRoleHasServerCapability(lockedRole, "manageExternalAuth")
      : actorRoleHasServerCapability(lockedRole, "manageIntegrations") && actorRoleHasServerCapability(lockedRole, "manageExternalAuth");
    if (!allowed) {
      throw new ManagedMcpServiceError(
        found.ownerKind === "personal"
          ? "Only the person whose own account this is, or a server admin, can sign it out."
          : "Only a server admin can sign out a shared account.",
        "managed_mcp_connection_forbidden",
      );
    }
    return { row: found, role: lockedRole };
  });
  await disconnectManagedMcpOAuthConnection(input.serverId, input.appId, row.id);
  const revokedByOther = row.ownerKind === "personal" && row.ownerUserId !== input.actorUserId;
  const [app] = await getDb().select({ name: managedMcpServers.name }).from(managedMcpServers).where(eq(managedMcpServers.id, row.mcpServerId));
  const granted = revokedByOther
    ? await getDb().select({ agentId: managedMcpPersonalGrants.agentId }).from(managedMcpPersonalGrants).where(eq(managedMcpPersonalGrants.connectionId, row.id))
    : [];
  await recordMcpConnectionAudit(getDb(), {
    eventType: "mcp_connection.signed_out",
    serverId: input.serverId,
    app: { id: row.mcpServerId, name: app?.name ?? "" },
    connection: { id: row.id, ownerKind: row.ownerKind, ownerUserId: row.ownerUserId },
    actorUserId: input.actorUserId,
    actorRole: role,
    metadata: revokedByOther ? { revokedBy: input.actorUserId } : {},
  });
  if (revokedByOther && row.ownerUserId) {
    await notifyPersonalConnectionRevoked({
      serverId: input.serverId,
      appId: row.mcpServerId,
      connectionId: row.id,
      ownerUserId: row.ownerUserId,
      revokerUserId: input.actorUserId,
      agentCount: granted.length,
      action: "signed_out",
    });
  }
}

/**
 * Who may rename a Connection or replace its key (PATCH /api/mcp/apps/:appId/connections/:connectionId),
 * asked before the edit: a personal Connection's owner only, a name only (personal API-key
 * Connections are not built, O2); a shared one whoever manages integrations, as before. Returns the
 * Connection's kind so the route can ask for the person's own session on a personal one.
 */
export async function assertMayEditMcpConnection(input: McpConnectionDelete & { appId: string; replacesKey: boolean }): Promise<"shared" | "personal"> {
  const row = await loadConnectionRow(getDb(), input);
  const role = await getActorServerRoleInServer(input.serverId, "user", input.actorUserId);
  if (row.ownerKind === "personal") {
    if (row.ownerUserId !== input.actorUserId || role === null) {
      throw new ManagedMcpServiceError("Only the person whose own account this is can rename it.", "managed_mcp_connection_forbidden");
    }
    if (input.replacesKey) {
      throw new ManagedMcpServiceError("A member's own account signs in with OAuth; it has no key to replace.", "managed_mcp_connection_request_invalid");
    }
    return "personal";
  }
  if (!actorRoleHasServerCapability(role, "manageIntegrations")) {
    throw new ManagedMcpServiceError("manageIntegrations capability required", "managed_mcp_connection_forbidden");
  }
  return "shared";
}

/** A Connection's owner kind on this Server (and App), or null when there is none. */
export async function mcpConnectionKind(serverId: string, connectionId: string, appId?: string): Promise<"shared" | "personal" | null> {
  const [row] = await getDb()
    .select({ ownerKind: managedMcpCredentials.ownerKind })
    .from(managedMcpCredentials)
    .where(and(
      eq(managedMcpCredentials.id, connectionId),
      eq(managedMcpCredentials.serverId, serverId),
      appId ? eq(managedMcpCredentials.mcpServerId, appId) : undefined,
    ))
    .limit(1);
  return row?.ownerKind ?? null;
}

async function loadConnectionRow(executor: DatabaseExecutor, input: { serverId: string; connectionId: string; appId?: string }): Promise<CredentialRow> {
  const [row] = await executor
    .select()
    .from(managedMcpCredentials)
    .where(and(
      eq(managedMcpCredentials.id, input.connectionId),
      eq(managedMcpCredentials.serverId, input.serverId),
      input.appId ? eq(managedMcpCredentials.mcpServerId, input.appId) : undefined,
    ))
    .limit(1);
  if (!row) throw new ManagedMcpServiceError("MCP connection not found", "managed_mcp_connection_not_found");
  return row;
}

/** An OAuth Connection's stored sign-in, deleted with Disconnect's helper; nothing for a key or a never-signed-in row. */
async function disconnectStoredSignIn(serverId: string, row: CredentialRow): Promise<void> {
  const [app] = await getDb()
    .select({ authMode: managedMcpServers.authMode })
    .from(managedMcpServers)
    .where(eq(managedMcpServers.id, row.mcpServerId));
  const oauth = (row.authKind ?? (app?.authMode === "oauth" ? "oauth" : "headers")) === "oauth";
  if (oauth && app?.authMode === "oauth" && row.encryptedOAuth !== null) {
    await disconnectManagedMcpOAuthConnection(serverId, row.mcpServerId, row.id);
  }
}

function assertMayDelete(row: Pick<CredentialRow, "ownerKind" | "ownerUserId">, actorUserId: string, role: ServerRole | null): void {
  const allowed = row.ownerKind === "personal"
    ? (role !== null && row.ownerUserId === actorUserId) || actorRoleHasServerCapability(role, "manageExternalAuth")
    : actorRoleHasServerCapability(role, "manageIntegrations");
  if (!allowed) {
    throw new ManagedMcpServiceError(
      row.ownerKind === "personal"
        ? "Only the person whose own account this is, or a server admin, can remove it."
        : "Only a server admin can remove a shared account.",
      "managed_mcp_connection_forbidden",
    );
  }
}

/* ------------------------------------------------------------------ accounts read */

export interface McpAccountAgent {
  agentId: string;
  /** In an external channel of this Server (a Guest's channel, or a joint channel another Server shares; D8). */
  inExternalChannels: boolean;
}

export interface McpAccountRow {
  connectionId: string;
  app: { id: string; name: string; logoUrl: string | null };
  name: string | null;
  /** The provider's account label (e.g. an email or workspace), as the Connection view shows it. */
  label: string | null;
  kind: "shared" | "personal";
  owner: ManagedMcpSignedInBy;
  signedInBy: ManagedMcpSignedInBy;
  status: CredentialRow["authStatus"];
  /** A shared Connection that is the App's default: every Agent with the App uses it unless pinned or given a personal one. */
  allAgents: boolean;
  /** Personal: the Agents given it. Shared: the Agents pinned to it. Only Agents the viewer can find. */
  agents: McpAccountAgent[];
  createdAt: string;
}

export interface McpAccountsView {
  /** The viewer's own personal Connections, every App of this Server. */
  mine: McpAccountRow[];
  /** Admins only: every shared Connection. */
  shared?: McpAccountRow[];
  /** Admins only: every other member's personal Connections (D5). */
  members?: McpAccountRow[];
  /** `mcp_personal_accounts` on for this Server. */
  personalAccounts: boolean;
}

/**
 * The Server's accounts as this viewer may see them (§7.2). Admins (`manageIntegrations`, who see
 * every Connection in the App view) get `shared` and `members` too. Four reads whatever the size:
 * the Connections, their personal grants, their pins, and one for which of those Agents are in an
 * external channel (externalChannelsOfServerSql, the definition the external-channel limits use).
 */
export async function listMcpAccounts(serverId: string, viewerUserId: string): Promise<McpAccountsView> {
  const db = getDb();
  const canManage = await actorHasServerCapabilityInServer(serverId, "user", viewerUserId, "manageIntegrations");
  const rows = await db
    .select({ connection: managedMcpCredentials, app: { id: managedMcpServers.id, name: managedMcpServers.name, logoUrl: managedMcpServers.logoUrl } })
    .from(managedMcpCredentials)
    .innerJoin(managedMcpServers, eq(managedMcpServers.id, managedMcpCredentials.mcpServerId))
    .where(and(
      eq(managedMcpCredentials.serverId, serverId),
      canManage ? undefined : and(eq(managedMcpCredentials.ownerKind, "personal"), eq(managedMcpCredentials.ownerUserId, viewerUserId)),
    ))
    .orderBy(asc(managedMcpServers.name), asc(managedMcpCredentials.createdAt), asc(managedMcpCredentials.id));
  const ids = rows.map((row) => row.connection.id);
  const personalIds = rows.filter((row) => row.connection.ownerKind === "personal").map((row) => row.connection.id);
  const sharedIds = rows.filter((row) => row.connection.ownerKind === "shared").map((row) => row.connection.id);
  const visible = and(eq(agents.serverId, serverId), isNull(agents.deletedAt), agentFindableBy({ userId: viewerUserId }));
  const [grants, pins] = await Promise.all([
    personalIds.length === 0 ? [] : db
      .select({ connectionId: managedMcpPersonalGrants.connectionId, agentId: managedMcpPersonalGrants.agentId })
      .from(managedMcpPersonalGrants)
      .innerJoin(agents, eq(agents.id, managedMcpPersonalGrants.agentId))
      .where(and(inArray(managedMcpPersonalGrants.connectionId, personalIds), visible))
      .orderBy(asc(agents.createdAt), asc(agents.id)),
    sharedIds.length === 0 ? [] : db
      .select({ connectionId: sql<string>`${managedMcpAssignments.boundConnectionId}`, agentId: managedMcpAssignments.agentId })
      .from(managedMcpAssignments)
      .innerJoin(agents, eq(agents.id, managedMcpAssignments.agentId))
      .where(and(
        eq(managedMcpAssignments.connectionMode, "pinned"),
        inArray(managedMcpAssignments.boundConnectionId, sharedIds),
        visible,
      ))
      .orderBy(asc(agents.createdAt), asc(agents.id)),
  ]);
  const agentsByConnection = new Map<string, string[]>();
  for (const row of [...grants, ...pins]) agentsByConnection.set(row.connectionId, [...agentsByConnection.get(row.connectionId) ?? [], row.agentId]);
  const external = await agentsInExternalChannels(db, serverId, [...new Set([...grants, ...pins].map((row) => row.agentId))]);
  const departed = await readSignedInByDeparted(db, serverId, rows.flatMap((row) => [row.connection.signedInByUserId, row.connection.ownerUserId]));
  const view = (row: (typeof rows)[number]): McpAccountRow => ({
    connectionId: row.connection.id,
    app: { id: row.app.id, name: row.app.name, logoUrl: clientLogoUrl(row.app.logoUrl) },
    name: row.connection.name,
    label: row.connection.accountLabel,
    kind: row.connection.ownerKind,
    owner: signedInByView(row.connection.ownerUserId, departed),
    signedInBy: signedInByView(row.connection.signedInByUserId, departed),
    status: row.connection.authStatus,
    allAgents: row.connection.isServerDefault,
    agents: (agentsByConnection.get(row.connection.id) ?? []).map((agentId) => ({ agentId, inExternalChannels: external.has(agentId) })),
    createdAt: row.connection.createdAt.toISOString(),
  });
  const mine = rows.filter((row) => row.connection.ownerKind === "personal" && row.connection.ownerUserId === viewerUserId).map(view);
  const personalAccounts = await mcpPersonalAccountsEnabled(serverId);
  if (!canManage) return { mine, personalAccounts };
  return {
    mine,
    shared: rows.filter((row) => row.connection.ownerKind === "shared").map(view),
    members: rows.filter((row) => row.connection.ownerKind === "personal" && row.connection.ownerUserId !== viewerUserId).map(view),
    personalAccounts,
  };
}

/** Which of these Agents are in an external channel of the Server: one query. */
export async function agentsInExternalChannels(executor: DatabaseExecutor, serverId: string, agentIds: readonly string[]): Promise<Set<string>> {
  if (agentIds.length === 0) return new Set();
  const result = await executor.execute<{ agent_id: string }>(sql`
    SELECT DISTINCT ca.agent_id FROM channel_agents ca
     WHERE ca.agent_id IN (${sql.join(agentIds.map((id) => sql`${id}::uuid`), sql`, `)})
       AND ca.channel_id IN (SELECT channel_id FROM (${externalChannelsOfServerSql(serverId)}) external_channels)
  `);
  return new Set(result.rows.map((row) => row.agent_id));
}
