/**
 * MCP App Connections: the server default, and what happens around a Connection's sign-in.
 *
 * Every Connection is shared by the Raft server. An Agent uses the App's server default unless it
 * is pinned to a specific Connection (managed_mcp_assignments); there is at most one default per
 * App (`idx_managed_mcp_credentials_default`).
 */
import { mcpAgentGrant, mcpAgentGrantAllows, mcpAutoGrantCoversAgent, mcpAutoGrantCreatorScope } from "./managedMcpAgentGrant";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { currentDate, type ManagedMcpToolCatalogEntry } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agents, managedMcpAssignments, managedMcpCredentials, managedMcpServers } from "../db/schema";
import { actorHasServerCapabilityInServer } from "../lib/actorPermissions";
import { encryptManagedMcpHeaders, normalizeManagedMcpHeaders } from "./managedMcpCredentialService";
import { listManagedMcpTools } from "./managedMcpGateway";
import {
  APP_OAUTH_STATUS_FOR_CONNECTION,
  completeManagedMcpOAuthConnection,
  type ManagedMcpOAuthCompletion,
} from "./managedMcpOAuthService";
import { hasConfiguredManagedMcpOAuthClient } from "./managedMcpOAuthClient";
import { ManagedMcpServiceError, resolveAdmittedConnectionCardsForApp } from "./managedMcpService";

/**
 * Makes `connectionId` the App's server default (`null` leaves the App with none), in the caller's
 * transaction, then closes the Connect cards of every Agent this admits.
 *
 * The App row is locked first so two concurrent changes serialize instead of racing into the
 * one-default index. For an OAuth App the App-level `oauth_status` mirror follows the new default.
 */
export async function setServerDefaultConnection(
  tx: DatabaseExecutor,
  input: { serverId: string; mcpServerId: string; connectionId: string | null; userId: string },
  /** Collects the closed cards' messages, for the caller to announce after commit (announceResolvedActionCards). */
  closedCards?: string[],
): Promise<{ previousDefaultConnectionId: string | null; defaultConnectionId: string | null; resolvedCards: number }> {
  const [app] = await tx
    .select({ id: managedMcpServers.id, authMode: managedMcpServers.authMode })
    .from(managedMcpServers)
    .where(and(eq(managedMcpServers.id, input.mcpServerId), eq(managedMcpServers.serverId, input.serverId)))
    .for("update");
  if (!app) throw new ManagedMcpServiceError("MCP server not found", "managed_mcp_server_not_found");
  const connections = await tx
    .select({
      id: managedMcpCredentials.id,
      isServerDefault: managedMcpCredentials.isServerDefault,
      authStatus: managedMcpCredentials.authStatus,
    })
    .from(managedMcpCredentials)
    .where(and(eq(managedMcpCredentials.serverId, input.serverId), eq(managedMcpCredentials.mcpServerId, input.mcpServerId)));
  const previous = connections.find((connection) => connection.isServerDefault) ?? null;
  const next = input.connectionId === null ? null : connections.find((connection) => connection.id === input.connectionId);
  if (next === undefined) {
    throw new ManagedMcpServiceError("MCP connection not found", "managed_mcp_connection_not_found");
  }
  if (previous && previous.id !== next?.id) {
    await tx.update(managedMcpCredentials)
      .set({ isServerDefault: false, updatedAt: new Date() })
      .where(and(eq(managedMcpCredentials.mcpServerId, input.mcpServerId), eq(managedMcpCredentials.isServerDefault, true)));
  }
  if (next && !next.isServerDefault) {
    await tx.update(managedMcpCredentials)
      .set({ isServerDefault: true, updatedAt: new Date() })
      .where(eq(managedMcpCredentials.id, next.id));
  }
  if (app.authMode === "oauth") {
    await tx.update(managedMcpServers)
      .set({ oauthStatus: next ? APP_OAUTH_STATUS_FOR_CONNECTION[next.authStatus] : "disconnected", updatedAt: new Date() })
      .where(eq(managedMcpServers.id, app.id));
  }
  const resolvedCards = await resolveAdmittedConnectionCardsForApp(tx, input, closedCards);
  return { previousDefaultConnectionId: previous?.id ?? null, defaultConnectionId: next?.id ?? null, resolvedCards };
}

/**
 * The OAuth callback: completes the sign-in on its Connection, then applies what the sign-in was
 * started for.
 *
 * `intent.makeDefault` is honoured only if the person who started the sign-in may STILL manage the
 * server's integrations; their role is re-read now, not trusted from when they started. A sign-in
 * never pins an Agent: granting the new Connection to an Agent is a separate, explicit step.
 * Either way the open Connect cards this sign-in satisfied are closed.
 */
export async function completeManagedMcpOAuthCallback(input: {
  state: string;
  authorizationCode: string;
}, closedCards?: string[]): Promise<ManagedMcpOAuthCompletion> {
  const completion = await completeManagedMcpOAuthConnection(input);
  const makeDefault = completion.intent?.makeDefault === true
    && await actorHasServerCapabilityInServer(completion.serverId, "user", completion.userId, "manageIntegrations");
  await getDb().transaction(async (tx) => {
    const target = { serverId: completion.serverId, mcpServerId: completion.mcpServerId, userId: completion.userId };
    if (makeDefault) {
      await setServerDefaultConnection(tx, { ...target, connectionId: completion.connectionId }, closedCards);
    } else {
      await resolveAdmittedConnectionCardsForApp(tx, target, closedCards);
    }
  });
  return completion;
}

/* ------------------------------------------------------------------ Connection CRUD (API-key headers) */

type CredentialRow = typeof managedMcpCredentials.$inferSelect;
type AppRow = typeof managedMcpServers.$inferSelect;
type ToolLister = (endpoint: string, headers: Record<string, string>) => Promise<ManagedMcpToolCatalogEntry[]>;

export interface ManagedMcpConnectionView {
  id: string;
  name: string | null;
  authKind: "headers" | "oauth";
  isServerDefault: boolean;
  status: CredentialRow["authStatus"];
  accountLabel: string | null;
  /** Presence only; omitted when encrypted state cannot be read. */
  hasConfiguredOAuthClient?: boolean;
  /** Names only; header values are write-only. */
  headerNames: string[];
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export function serializeConnection(row: CredentialRow, app: Pick<AppRow, "authMode">): ManagedMcpConnectionView {
  return {
    id: row.id,
    name: row.name,
    authKind: row.authKind ?? (app.authMode === "oauth" ? "oauth" : "headers"),
    isServerDefault: row.isServerDefault,
    status: row.authStatus,
    accountLabel: row.accountLabel,
    hasConfiguredOAuthClient: hasConfiguredManagedMcpOAuthClient(row.encryptedOAuth),
    headerNames: row.headerNames,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
  };
}

async function loadApp(db: DatabaseExecutor, serverId: string, mcpServerId: string, lock = false): Promise<AppRow> {
  const query = db
    .select()
    .from(managedMcpServers)
    .where(and(eq(managedMcpServers.id, mcpServerId), eq(managedMcpServers.serverId, serverId)));
  const [app] = lock ? await query.for("update") : await query;
  if (!app) throw new ManagedMcpServiceError("MCP server not found", "managed_mcp_server_not_found");
  return app;
}

export async function listManagedMcpConnections(serverId: string, mcpServerId: string, db: DatabaseExecutor = getDb()): Promise<ManagedMcpConnectionView[]> {
  const app = await loadApp(db, serverId, mcpServerId);
  const rows = await db
    .select()
    .from(managedMcpCredentials)
    .where(and(eq(managedMcpCredentials.serverId, serverId), eq(managedMcpCredentials.mcpServerId, mcpServerId)))
    .orderBy(asc(managedMcpCredentials.createdAt), asc(managedMcpCredentials.id));
  return rows.map((row) => serializeConnection(row, app));
}

/**
 * The header names every Connection of this App must supply, as a complete set: the App's
 * `required_header_names`, or for an App created before they were recorded, the names its
 * Connections already use (the default's first, then the oldest). With neither, the names are
 * never invented from the request: the admin sets them on the App first (409).
 */
async function requiredHeaderNames(db: DatabaseExecutor, app: AppRow): Promise<string[]> {
  if (app.requiredHeaderNames && app.requiredHeaderNames.length > 0) return app.requiredHeaderNames;
  const rows = await db
    .select({ headerNames: managedMcpCredentials.headerNames })
    .from(managedMcpCredentials)
    .where(eq(managedMcpCredentials.mcpServerId, app.id))
    .orderBy(desc(managedMcpCredentials.isServerDefault), asc(managedMcpCredentials.createdAt), asc(managedMcpCredentials.id));
  const recorded = rows.find((row) => row.headerNames.length > 0);
  if (recorded) return recorded.headerNames;
  throw new ManagedMcpServiceError(
    "This App has no recorded API-key header names; set requiredHeaderNames on the App first",
    "managed_mcp_header_names_unset",
  );
}

function assertCompleteHeaderSet(headers: Record<string, string>, required: string[]): void {
  const supplied = Object.keys(headers).map((name) => name.toLowerCase()).sort();
  const expected = required.map((name) => name.toLowerCase()).sort();
  const complete = supplied.length === expected.length && supplied.every((name, index) => name === expected[index]);
  if (!complete) {
    throw new ManagedMcpServiceError(`Provide exactly these headers: ${required.join(", ")}`, "managed_mcp_headers_incomplete");
  }
}

function assertHeaderApp(app: AppRow): void {
  if (app.authMode === "none") {
    throw new ManagedMcpServiceError("This MCP App needs no connection", "managed_mcp_connection_not_needed");
  }
  if (app.authMode !== "headers") {
    throw new ManagedMcpServiceError("This MCP App signs in with OAuth; start a sign-in instead", "managed_mcp_auth_invalid");
  }
}

/** The App row as the handshake saw it; a write after a concurrent endpoint change is refused. */
function sameAppConfig(app: AppRow) {
  return and(
    eq(managedMcpServers.id, app.id),
    eq(managedMcpServers.configVersion, app.configVersion),
    eq(managedMcpServers.endpointUrl, app.endpointUrl),
    eq(managedMcpServers.authMode, app.authMode),
  );
}

async function writeCatalogFromHandshake(tx: DatabaseExecutor, app: AppRow, toolCatalog: ManagedMcpToolCatalogEntry[]): Promise<void> {
  await tx.update(managedMcpServers).set({
    toolCatalog,
    catalogVersion: sql`${managedMcpServers.catalogVersion} + 1`,
    lastCheckedAt: currentDate(),
    lastCheckError: null,
    updatedAt: currentDate(),
  }).where(sameAppConfig(app));
}

/**
 * Adds an API-key Connection. The handshake runs FIRST, with the supplied headers: a server that
 * refuses them, or cannot be reached, leaves no row behind. When the Connection is (or becomes)
 * the default, the App's tool catalogue is taken from that handshake.
 */
export async function createManagedMcpHeaderConnection(input: {
  serverId: string;
  userId: string;
  mcpServerId: string;
  name: string;
  headers: Record<string, string>;
  makeDefault?: boolean;
}, deps: { listTools?: ToolLister } = {}, closedCards?: string[]): Promise<ManagedMcpConnectionView> {
  const app = await loadApp(getDb(), input.serverId, input.mcpServerId);
  assertHeaderApp(app);
  const headers = normalizeManagedMcpHeaders(input.headers);
  assertCompleteHeaderSet(headers, await requiredHeaderNames(getDb(), app));
  const toolCatalog = await (deps.listTools ?? listManagedMcpTools)(app.endpointUrl, headers);
  return getDb().transaction(async (tx) => {
    const locked = await loadApp(tx, input.serverId, input.mcpServerId, true);
    if (locked.configVersion !== app.configVersion || locked.endpointUrl !== app.endpointUrl || locked.authMode !== app.authMode) {
      throw new ManagedMcpServiceError("MCP server configuration changed during the handshake", "managed_mcp_config_stale");
    }
    const headerNames = Object.keys(headers).sort((left, right) => left.localeCompare(right));
    const [row] = await tx.insert(managedMcpCredentials).values({
      serverId: input.serverId,
      mcpServerId: input.mcpServerId,
      isServerDefault: false,
      name: input.name,
      authKind: "headers",
      authStatus: "ready",
      encryptedHeaders: encryptManagedMcpHeaders(headers),
      headerNames,
      // The server the handshake just validated these values against.
      authorizedEndpointUrl: app.endpointUrl,
      lastCheckedAt: currentDate(),
      createdByUserId: input.userId,
    }).returning();
    if (input.makeDefault) {
      await setServerDefaultConnection(tx, { serverId: input.serverId, mcpServerId: input.mcpServerId, connectionId: row.id, userId: input.userId }, closedCards);
      await writeCatalogFromHandshake(tx, app, toolCatalog);
    }
    const [saved] = await tx.select().from(managedMcpCredentials).where(eq(managedMcpCredentials.id, row.id));
    return serializeConnection(saved, app);
  });
}

/**
 * Renames a Connection and/or replaces its API-key headers. New header values are a full,
 * write-only replacement checked by a handshake before anything is written.
 */
export async function updateManagedMcpConnection(input: {
  serverId: string;
  userId: string;
  mcpServerId: string;
  connectionId: string;
  name?: string;
  headers?: Record<string, string>;
}, deps: { listTools?: ToolLister } = {}, closedCards?: string[]): Promise<ManagedMcpConnectionView> {
  const app = await loadApp(getDb(), input.serverId, input.mcpServerId);
  const existing = await loadConnection(getDb(), input);
  let replacement: { headers: Record<string, string>; toolCatalog: ManagedMcpToolCatalogEntry[] } | null = null;
  if (input.headers !== undefined) {
    assertHeaderApp(app);
    const headers = normalizeManagedMcpHeaders(input.headers);
    assertCompleteHeaderSet(headers, await requiredHeaderNames(getDb(), app));
    replacement = { headers, toolCatalog: await (deps.listTools ?? listManagedMcpTools)(app.endpointUrl, headers) };
  }
  return getDb().transaction(async (tx) => {
    if (replacement) {
      // Same fence as the create path: the key is stored as `ready` only for the configuration the
      // handshake ran against. A concurrent endpoint change would otherwise get a key validated for
      // the old server written as ready on the new one.
      const locked = await loadApp(tx, input.serverId, input.mcpServerId, true);
      if (locked.configVersion !== app.configVersion || locked.endpointUrl !== app.endpointUrl || locked.authMode !== app.authMode) {
        throw new ManagedMcpServiceError("MCP server configuration changed during the handshake", "managed_mcp_config_stale");
      }
    }
    const [row] = await tx.update(managedMcpCredentials).set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(replacement ? {
        encryptedHeaders: encryptManagedMcpHeaders(replacement.headers),
        headerNames: Object.keys(replacement.headers).sort((left, right) => left.localeCompare(right)),
        authStatus: "ready" as const,
        authorizedEndpointUrl: app.endpointUrl,
        lastError: null,
        lastCheckedAt: currentDate(),
        credentialVersion: sql`${managedMcpCredentials.credentialVersion} + 1`,
      } : {}),
      updatedAt: currentDate(),
    }).where(eq(managedMcpCredentials.id, existing.id)).returning();
    if (!row) throw new ManagedMcpServiceError("MCP connection not found", "managed_mcp_connection_not_found");
    if (replacement && row.isServerDefault) await writeCatalogFromHandshake(tx, app, replacement.toolCatalog);
    if (replacement) await resolveAdmittedConnectionCardsForApp(tx, { serverId: input.serverId, mcpServerId: input.mcpServerId, userId: input.userId }, closedCards);
    return serializeConnection(row, app);
  });
}

async function loadConnection(
  db: DatabaseExecutor,
  input: { serverId: string; mcpServerId: string; connectionId: string },
): Promise<CredentialRow> {
  const [row] = await db
    .select()
    .from(managedMcpCredentials)
    .where(and(
      eq(managedMcpCredentials.id, input.connectionId),
      eq(managedMcpCredentials.serverId, input.serverId),
      eq(managedMcpCredentials.mcpServerId, input.mcpServerId),
    ))
    .limit(1);
  if (!row) throw new ManagedMcpServiceError("MCP connection not found", "managed_mcp_connection_not_found");
  return row;
}

/**
 * Deletes a Connection.
 *
 * Agents pinned to it stay pinned to nothing (the FK sets the binding NULL) and are REFUSED; they
 * never fall back to the default, because that would re-grant through another account access that
 * was deliberately scoped (the dead-pin rule in `admitManagedMcpCall`). If it was the default, the
 * App has no default until someone sets one, and Agents following the default are refused too.
 */
export async function deleteManagedMcpConnection(input: {
  serverId: string;
  mcpServerId: string;
  connectionId: string;
}): Promise<void> {
  await getDb().transaction(async (tx) => {
    const app = await loadApp(tx, input.serverId, input.mcpServerId, true);
    const [deleted] = await tx.delete(managedMcpCredentials).where(and(
      eq(managedMcpCredentials.id, input.connectionId),
      eq(managedMcpCredentials.serverId, input.serverId),
      eq(managedMcpCredentials.mcpServerId, input.mcpServerId),
    )).returning({ isServerDefault: managedMcpCredentials.isServerDefault });
    if (!deleted) throw new ManagedMcpServiceError("MCP connection not found", "managed_mcp_connection_not_found");
    if (deleted.isServerDefault && app.authMode === "oauth") {
      await tx.update(managedMcpServers).set({ oauthStatus: "disconnected", updatedAt: currentDate() }).where(eq(managedMcpServers.id, app.id));
    }
  });
}

/* ------------------------------------------------------------------ server default: impact */

export interface ManagedMcpDefaultImpact {
  currentDefaultConnectionId: string | null;
  /** Agents that follow the default and would switch Connection if this one became the default. */
  agentsChangingNow: number;
  agentsTotal: number;
  /** Agents following the default, whichever Connection it is. */
  agentsFollowingDefault: number;
  pinnedUnchanged: number;
  offUnchanged: number;
  futureAgentsInherit: true;
}

/**
 * What changing the App's server default to `connectionId` (null: no default) would affect. An Agent
 * with no assignment row follows the default, as does an enabled row in `default` mode; pinned and
 * switched-off Agents are not affected.
 */
export async function describeManagedMcpDefaultImpact(input: {
  serverId: string;
  mcpServerId: string;
  connectionId: string | null;
}): Promise<ManagedMcpDefaultImpact> {
  const db = getDb();
  const app = await loadApp(db, input.serverId, input.mcpServerId);
  const connections = await db
    .select({ id: managedMcpCredentials.id, isServerDefault: managedMcpCredentials.isServerDefault })
    .from(managedMcpCredentials)
    .where(and(eq(managedMcpCredentials.serverId, input.serverId), eq(managedMcpCredentials.mcpServerId, input.mcpServerId)));
  if (input.connectionId !== null && !connections.some((connection) => connection.id === input.connectionId)) {
    throw new ManagedMcpServiceError("MCP connection not found", "managed_mcp_connection_not_found");
  }
  const currentDefaultConnectionId = connections.find((connection) => connection.isServerDefault)?.id ?? null;
  const rows = await db
    .select({
      agentId: agents.id,
      enabled: managedMcpAssignments.enabled,
      connectionMode: managedMcpAssignments.connectionMode,
      creatorType: agents.creatorType,
      creatorId: agents.creatorId,
    })
    .from(agents)
    .leftJoin(managedMcpAssignments, and(
      eq(managedMcpAssignments.agentId, agents.id),
      eq(managedMcpAssignments.mcpServerId, input.mcpServerId),
    ))
    .where(and(eq(agents.serverId, input.serverId), isNull(agents.deletedAt)));
  let following = 0;
  let pinned = 0;
  let off = 0;
  const creatorScope = await mcpAutoGrantCreatorScope(db, input.serverId, app);
  for (const row of rows) {
    // An Agent without the App (revoked, or never granted) is unaffected by the default, like one switched off.
    const assignment = row.enabled === null ? null : { enabled: row.enabled };
    if (!mcpAgentGrantAllows(mcpAgentGrant(assignment, mcpAutoGrantCoversAgent(creatorScope, row)))) off += 1;
    else if (row.connectionMode === "pinned") pinned += 1;
    else following += 1;
  }
  return {
    currentDefaultConnectionId,
    agentsChangingNow: input.connectionId === currentDefaultConnectionId ? 0 : following,
    agentsTotal: rows.length,
    agentsFollowingDefault: following,
    pinnedUnchanged: pinned,
    offUnchanged: off,
    futureAgentsInherit: true,
  };
}
