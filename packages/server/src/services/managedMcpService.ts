import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  currentDate,
  MANAGED_MCP_TRANSPORT,
  formatManagedMcpPromptName,
  formatManagedMcpRuntimeToolName,
  type ManagedMcpAgentCatalogResponse,
  type ManagedMcpAgentConnectionView,
  type ManagedMcpAgentGrant,
  type ManagedMcpAuthMode,
  type ManagedMcpCallRequest,
  type ManagedMcpCallResult,
  type ManagedMcpCredentialPatch,
  type ManagedMcpProvider,
  type ManagedMcpRuntimeSnapshot,
  type ManagedMcpRuntimeTool,
  type ManagedMcpServerView,
  type ManagedMcpToolCatalogEntry,
} from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import {
  actionCards,
  agents,
  integrationAuditEvents,
  managedMcpAssignments,
  managedMcpCredentials,
  managedMcpOAuthAttempts,
  managedMcpServers,
} from "../db/schema";
import {
  decryptManagedMcpHeaders,
  encryptManagedMcpHeaders,
  normalizeManagedMcpHeaders,
} from "./managedMcpCredentialService";
import {
  callManagedMcpTool,
  callManagedMcpOAuthTool,
  listManagedMcpOAuthTools,
  listManagedMcpTools,
  ManagedMcpGatewayError,
  validateManagedMcpEndpoint,
} from "./managedMcpGateway";
import { recordIntegrationAuditEvent } from "./integrationAuditService";
import { connectionAudienceMatches } from "./managedMcpConnectionAudience";
import { mcpAgentGrant, mcpAgentGrantAllows, mcpAutoGrantResolver } from "./managedMcpAgentGrant";
import {
  MCP_CONNECTION_NOT_USABLE_CALL_MESSAGE,
  MCP_CONNECTION_NOT_USABLE_MESSAGE,
  mcpAgentOwnerUserId,
  mcpConnectionUsableByAgent,
} from "./managedMcpConnectionOwnership";
import {
  postgresConstraintName,
  postgresErrorCode,
  resolveOpenMcpConnectionCard,
} from "./managedMcpConnectionCardService";
import { ManagedMcpOAuthError, withManagedMcpOAuth } from "./managedMcpOAuthService";
import { findActiveMcpAppTemplate, listMcpAppTemplates } from "./mcpAppTemplates";
import { mapWithConcurrency } from "../lib/mapWithConcurrency";
// Cyclic on purpose (the inventory reads this module's catalogue); used only inside functions.
import { listAgentMcpAppsForIntegrationInventory } from "./managedMcpIntegrationInventory";

/** Apps resolved at once when a list asks whether each App's creator may grant it automatically. */
const MCP_AUTO_GRANT_CONCURRENCY = 4;

export class ManagedMcpServiceError extends Error {
  constructor(
    message: string,
    readonly code:
      | "managed_mcp_agent_not_found"
      | "managed_mcp_server_not_found"
      // Also the answer for "exists, but belongs to another App". Deliberately indistinguishable;
      // see `resolveAssignmentBinding`.
      | "managed_mcp_connection_not_found"
      // The Connection exists in this App but this Agent may not use it: neither the server default
      // nor created by the Agent's owner (403; see `mcpConnectionUsableByAgent`).
      | "managed_mcp_connection_not_usable"
      | "managed_mcp_assignment_not_found"
      | "managed_mcp_assignment_stale"
      | "managed_mcp_config_stale"
      | "managed_mcp_server_disabled"
      | "managed_mcp_auth_invalid"
      | "managed_mcp_tool_not_allowed"
      // A human switched this App off for this Agent. Not a Connection problem: no card.
      | "managed_mcp_app_off"
      | "managed_mcp_login_required"
      // A Connection must supply exactly the App's header names (400).
      | "managed_mcp_headers_incomplete"
      // An App with no recorded header names and no Connection to take them from (409).
      | "managed_mcp_header_names_unset"
      // The App uses no credentials, so it has no Connections.
      | "managed_mcp_connection_not_needed"
      | "managed_mcp_template_not_found"
      // A recommended App's endpoint and auth kind belong to Raft (409).
      | "managed_mcp_template_field_locked"
      // A PATCH key for a section an MCP App does not have (400).
      | "managed_mcp_app_section_not_supported"
      | "managed_mcp_app_invalid"
      | "managed_mcp_app_name_taken",
    /**
     * The message is already worded for the agent (it says what to do next), so the agent API sends
     * it as is rather than the generic text for its code (`managedMcpAgentErrors`).
     */
    readonly agentFacing = false,
  ) {
    super(message);
    this.name = "ManagedMcpServiceError";
  }

  /** The App tool this refusal is about, when it is not the tool the agent called (`call_tool`). */
  toolName?: string;
  /**
   * The App a refusal is about when the call named the Raft Apps tools (`RAFT_APPS_MCP_SERVER_ID`)
   * rather than the App itself, so the route raises the Connect card for that App.
   */
  app?: { id: string; configVersion: number };
}

/**
 * App names are unique per Raft server (`idx_managed_mcp_servers_server_name`). The services check
 * first for a friendly answer, but two concurrent writes can both pass that check; the loser hits
 * the index and must get the same 409, not a 500.
 */
export function rethrowIfMcpAppNameTaken(error: unknown): never {
  if (postgresErrorCode(error) === "23505" && postgresConstraintName(error) === "idx_managed_mcp_servers_server_name") {
    throw new ManagedMcpServiceError("An MCP App with this name already exists", "managed_mcp_app_name_taken");
  }
  throw error;
}

/** The legacy `recommendations` field, filled from the recommended-App templates it predates. */
async function legacyRecommendations(): Promise<ManagedMcpAgentCatalogResponse["recommendations"]> {
  return (await listMcpAppTemplates())
    .filter((template) => template.authKind === "oauth" && (template.key === "notion" || template.key === "linear"))
    .map((template) => ({
      id: template.key,
      name: template.name,
      description: template.description,
      provider: template.key as "notion" | "linear",
      authMode: "oauth" as const,
      endpointUrl: template.endpointUrl,
      credentialHeaderNames: [],
    }));
}

type ServerRow = typeof managedMcpServers.$inferSelect;
type AssignmentRow = typeof managedMcpAssignments.$inferSelect;
type CredentialRow = typeof managedMcpCredentials.$inferSelect;
type UsageRow = {
  invocationCount: number;
  lastInvokedAt: Date;
  lastToolName: string;
};

/**
 * The Connection columns admission and the catalogue read. Never the encrypted secrets: a reader
 * that only needs "is there one" gets `hasSecret`.
 */
type ConnectionFacts = Pick<CredentialRow, "id" | "mcpServerId" | "isServerDefault" | "createdByUserId" | "authStatus" | "name" | "authorizedEndpointUrl" | "headerNames">;
type CredentialSummary = Pick<CredentialRow, "headerNames"> & (
  | Pick<CredentialRow, "encryptedHeaders" | "encryptedOAuth">
  | { hasSecret: boolean }
);

/** Display an endpoint without components that may contain credentials. */
export function publicManagedMcpEndpoint(endpointUrl: string): string {
  try {
    const url = new URL(endpointUrl);
    if (url.protocol !== "https:" || !url.hostname) return "";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    // Legacy data may not be a URL. An empty display is safer than returning
    // the raw value or failing the entire App list.
    return "";
  }
}

function serializeServer(
  row: ServerRow,
  assignment: AssignmentRow | null,
  credential: CredentialSummary | null,
  usage: UsageRow | null = null,
): ManagedMcpServerView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    provider: row.provider,
    authMode: row.authMode,
    oauthStatus: row.oauthStatus,
    transport: MANAGED_MCP_TRANSPORT,
    endpointUrl: publicManagedMcpEndpoint(row.endpointUrl),
    enabled: row.enabled,
    configVersion: row.configVersion,
    catalogVersion: row.catalogVersion,
    toolCatalog: row.toolCatalog,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    lastCheckError: row.lastCheckError,
    credentialHeaderNames: credential?.headerNames ?? [],
    // Canonicalised here rather than through a shared helper with the new path: if both sides
    // called one function, the parity comparison for this field would be an identity and the
    // case/sort-drift tooth could never fail.
    requiredCredentialHeaderNames: [...new Set(row.requiredHeaderNames ?? [])]
      .sort((left, right) => left.localeCompare(right)),
    hasCredentials: credential === null
      ? false
      : "hasSecret" in credential ? credential.hasSecret : Boolean(credential.encryptedHeaders || credential.encryptedOAuth),
    assignment: assignment ? {
      enabled: assignment.enabled,
      allowedTools: assignment.allowedTools,
      version: assignment.assignmentVersion,
      hasBoundConnection: assignment.boundConnectionId !== null,
    } : null,
    usage: usage ? {
      invocationCount: usage.invocationCount,
      lastInvokedAt: usage.lastInvokedAt.toISOString(),
      lastToolName: usage.lastToolName,
    } : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function requireAgent(serverId: string, agentId: string, db: DatabaseExecutor = getDb()) {
  const [agent] = await db
    .select({ id: agents.id, creatorType: agents.creatorType, creatorId: agents.creatorId, assistantOwnerUserId: agents.assistantOwnerUserId })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.serverId, serverId)))
    .limit(1);
  if (!agent) throw new ManagedMcpServiceError("Agent not found", "managed_mcp_agent_not_found");
  return agent;
}

async function loadServer(serverId: string, mcpServerId: string, db: DatabaseExecutor = getDb()): Promise<ServerRow> {
  const [row] = await db
    .select()
    .from(managedMcpServers)
    .where(and(eq(managedMcpServers.id, mcpServerId), eq(managedMcpServers.serverId, serverId)))
    .limit(1);
  if (!row) throw new ManagedMcpServiceError("MCP server not found", "managed_mcp_server_not_found");
  return row;
}

/**
 * Every column of a new server-default Connection, written explicitly. The table's defaults
 * (`is_server_default = true`, `auth_status = 'ready'`) exist only so that rows an older binary
 * inserts during a rolling deploy keep today's meaning; new code must not lean on them.
 */
function newConnectionFields(input: { authMode: "oauth" | "headers"; name: string; userId: string | null }) {
  return {
    isServerDefault: true,
    name: input.name,
    authKind: input.authMode,
    authStatus: input.authMode === "oauth" ? "needs_auth" as const : "ready" as const,
    createdByUserId: input.userId,
  };
}

/**
 * The App's server-default Connection: what an Agent in `default` mode uses, and what App-level
 * flows (catalogue refresh, the original single-credential edit and test paths, the catalogue view)
 * mean by "this MCP server's credential". At most one exists per App
 * (`idx_managed_mcp_credentials_default`). An App can have further Connections that are only used
 * by Agents explicitly granted them.
 */
async function loadDefaultConnection(serverId: string, mcpServerId: string, db: DatabaseExecutor = getDb()): Promise<CredentialRow | null> {
  const [row] = await db
    .select()
    .from(managedMcpCredentials)
    .where(and(
      eq(managedMcpCredentials.serverId, serverId),
      eq(managedMcpCredentials.mcpServerId, mcpServerId),
      eq(managedMcpCredentials.isServerDefault, true),
    ))
    .limit(1);
  return row ?? null;
}

function prepareHeaders(headers: Record<string, string>): Pick<CredentialRow, "encryptedHeaders" | "headerNames"> {
  const normalized = normalizeManagedMcpHeaders(headers);
  const headerNames = Object.keys(normalized).sort((left, right) => left.localeCompare(right));
  return {
    encryptedHeaders: headerNames.length > 0 ? encryptManagedMcpHeaders(normalized) : null,
    headerNames,
  };
}

function applyHeaderPatch(
  currentHeaders: Record<string, string>,
  patch: ManagedMcpCredentialPatch,
): Record<string, string> {
  if (!Array.isArray(patch.removeHeaderNames) || patch.removeHeaderNames.length > 64) {
    throw new ManagedMcpServiceError("Credential header patch is invalid", "managed_mcp_auth_invalid");
  }
  const removals = new Set(patch.removeHeaderNames.map((name) => {
    if (typeof name !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u.test(name.trim())) {
      throw new ManagedMcpServiceError("Credential header patch is invalid", "managed_mcp_auth_invalid");
    }
    return name.trim().toLowerCase();
  }));
  const result = Object.fromEntries(Object.entries(currentHeaders).filter(([name]) => !removals.has(name.toLowerCase())));
  const upserts = normalizeManagedMcpHeaders(patch.upsertHeaders);
  for (const [name, value] of Object.entries(upserts)) {
    for (const existingName of Object.keys(result)) {
      if (existingName.toLowerCase() === name.toLowerCase()) delete result[existingName];
    }
    result[name] = value;
  }
  return result;
}

function headersEqual(left: Record<string, string>, right: Record<string, string>): boolean {
  const normalizeEntries = (headers: Record<string, string>) => Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([leftName], [rightName]) => leftName.localeCompare(rightName));
  return JSON.stringify(normalizeEntries(left)) === JSON.stringify(normalizeEntries(right));
}

function endpointOrigin(endpointUrl: string): string {
  return validateManagedMcpEndpoint(endpointUrl).origin;
}

export function validateManagedMcpConfiguredEndpoint(raw: string): URL {
  const url = validateManagedMcpEndpoint(raw);
  if (url.search) {
    throw new ManagedMcpGatewayError(
      "MCP endpoint query parameters are not allowed; use encrypted credential headers",
      "managed_mcp_endpoint_invalid",
    );
  }
  return url;
}

function patchExplicitlyReplacesStoredHeaders(
  currentHeaders: Record<string, string>,
  patch: ManagedMcpCredentialPatch,
): boolean {
  const upsertedNames = new Set(
    Object.keys(normalizeManagedMcpHeaders(patch.upsertHeaders)).map((name) => name.toLowerCase()),
  );
  const removedNames = new Set(patch.removeHeaderNames.map((name) => name.trim().toLowerCase()));
  return Object.keys(currentHeaders).every((name) => {
    const normalizedName = name.toLowerCase();
    return upsertedNames.has(normalizedName) || removedNames.has(normalizedName);
  });
}

function assertNoImplicitCrossOriginHeaderReuse(input: {
  previousEndpointUrl: string;
  nextEndpointUrl: string;
  currentHeaders: Record<string, string>;
  replacementHeaders?: Record<string, string>;
  credentialPatch?: ManagedMcpCredentialPatch;
}): void {
  if (
    endpointOrigin(input.previousEndpointUrl) === endpointOrigin(input.nextEndpointUrl)
    || input.replacementHeaders !== undefined
    || Object.keys(input.currentHeaders).length === 0
    || (input.credentialPatch !== undefined
      && patchExplicitlyReplacesStoredHeaders(input.currentHeaders, input.credentialPatch))
  ) return;
  throw new ManagedMcpServiceError(
    "Credential headers cannot be reused across endpoint origins; provide every header value again",
    "managed_mcp_auth_invalid",
  );
}

async function normalizeConnection(input: {
  provider: ManagedMcpProvider;
  authMode: ManagedMcpAuthMode;
  endpointUrl: string;
  headers?: Record<string, string>;
}): Promise<{ endpointUrl: string; preparedHeaders: Pick<CredentialRow, "encryptedHeaders" | "headerNames"> | null }> {
  if (input.provider !== "custom" && input.authMode !== "oauth") {
    throw new ManagedMcpServiceError("Notion and Linear connections require OAuth", "managed_mcp_auth_invalid");
  }
  const managedTemplate = input.provider === "custom" ? null : await findActiveMcpAppTemplate(input.provider);
  if (input.provider !== "custom" && !managedTemplate) {
    // Retired/unknown managed provider: refuse creation outright rather than silently treating it
    // as a free endpoint. Existing Apps of that provider are unaffected (logo/detail lookups use
    // the retired-tolerant findMcpAppTemplate).
    throw new ManagedMcpServiceError("MCP App template not found", "managed_mcp_template_not_found");
  }
  const fixedEndpoint = managedTemplate?.endpointUrl;
  const endpointUrl = validateManagedMcpConfiguredEndpoint(input.endpointUrl).toString();
  if (fixedEndpoint && endpointUrl !== fixedEndpoint) {
    throw new ManagedMcpServiceError("Managed provider endpoint cannot be changed", "managed_mcp_auth_invalid");
  }
  if (input.authMode === "oauth" && input.headers !== undefined && Object.keys(input.headers).length > 0) {
    throw new ManagedMcpServiceError("OAuth connections cannot also use credential headers", "managed_mcp_auth_invalid");
  }
  if (input.authMode === "none" && input.headers !== undefined && Object.keys(input.headers).length > 0) {
    throw new ManagedMcpServiceError("Unauthenticated connections cannot include credential headers", "managed_mcp_auth_invalid");
  }
  return {
    endpointUrl: fixedEndpoint ?? endpointUrl,
    preparedHeaders: input.authMode === "headers" && input.headers !== undefined ? prepareHeaders(input.headers) : null,
  };
}

/** Where an App came from. A NULL `source_kind` is a row older than MCP Apps: a named provider is a template. */
export function mcpAppSourceKind(app: Pick<ServerRow, "sourceKind" | "provider">): "url" | "template" {
  return app.sourceKind ?? (app.provider !== "custom" ? "template" : "url");
}

/**
 * A recommended App's endpoint and auth kind belong to Raft. Enforced for EVERY write path (the
 * MCP App PATCH and the original `PATCH /servers/:id`), so neither can move a template App.
 */
export function assertTemplateFieldsUnchanged(
  app: ServerRow,
  next: { provider: ManagedMcpProvider; authMode: ManagedMcpAuthMode; endpointUrl: string },
): void {
  if (mcpAppSourceKind(app) !== "template") return;
  if (next.provider !== app.provider || next.authMode !== app.authMode || next.endpointUrl !== app.endpointUrl) {
    throw new ManagedMcpServiceError("A recommended App's server and sign-in are maintained by Raft", "managed_mcp_template_field_locked");
  }
}

/** Profile fields a caller may write in the same statement as an endpoint / auth change. */
export type McpAppRowValues = Partial<Pick<ServerRow, "name" | "description" | "enabled" | "homepageUrl" | "category" | "whenToUse" | "requiredHeaderNames" | "updatedByUserId">>;

/**
 * The ONE implementation of "this App now talks to a different server, or signs in differently".
 * Both PATCH routes call it, so the rules cannot drift between them:
 *
 *   - the App row is locked and must still be the configuration the caller validated against
 *   - catalogue, health, server info and auth probe describe the old server: all cleared
 *   - config and catalogue versions are bumped; pending sign-ins are failed
 *   - EVERY Connection (not only the default) loses its OAuth tokens: they are bound to the server
 *   - a new origin, or a new auth kind, also clears every Connection's API-key values and marks it
 *     `needs_auth`, so a key is never sent to a host it was not entered for
 *   - auth kind `none`: the App has no Connections; pins go back to "follow the default"
 *
 * `authorized_endpoint_url` is left as it was: a cleared Connection is re-stamped when it is
 * signed in or validated again, and until then a stale stamp is one more reason it is refused.
 */
async function lockServerConfigUnchanged(tx: DatabaseExecutor, current: ServerRow): Promise<void> {
  const [locked] = await tx
    .select({
      configVersion: managedMcpServers.configVersion,
      endpointUrl: managedMcpServers.endpointUrl,
      authMode: managedMcpServers.authMode,
    })
    .from(managedMcpServers)
    .where(and(eq(managedMcpServers.id, current.id), eq(managedMcpServers.serverId, current.serverId)))
    .for("update");
  if (!locked) throw new ManagedMcpServiceError("MCP server not found", "managed_mcp_server_not_found");
  if (locked.configVersion !== current.configVersion
    || locked.endpointUrl !== current.endpointUrl
    || locked.authMode !== current.authMode) {
    throw new ManagedMcpServiceError("MCP server configuration changed; reload and try again", "managed_mcp_config_stale");
  }
}

export async function applyMcpAppServerChange(
  tx: DatabaseExecutor,
  current: ServerRow,
  next: { endpointUrl: string; authMode: ManagedMcpAuthMode; provider: ManagedMcpProvider },
  appValues: McpAppRowValues = {},
): Promise<ServerRow> {
  const [locked] = await tx
    .select({ configVersion: managedMcpServers.configVersion })
    .from(managedMcpServers)
    .where(and(eq(managedMcpServers.id, current.id), eq(managedMcpServers.serverId, current.serverId)))
    .for("update");
  if (!locked) throw new ManagedMcpServiceError("MCP server not found", "managed_mcp_server_not_found");
  if (locked.configVersion !== current.configVersion) {
    throw new ManagedMcpServiceError("MCP server configuration changed; reload and try again", "managed_mcp_config_stale");
  }
  const [row] = await tx.update(managedMcpServers).set({
    ...appValues,
    endpointUrl: next.endpointUrl,
    authMode: next.authMode,
    provider: next.provider,
    oauthStatus: next.authMode === "oauth" ? "disconnected" : "connected",
    toolCatalog: [],
    catalogVersion: sql`${managedMcpServers.catalogVersion} + 1`,
    configVersion: sql`${managedMcpServers.configVersion} + 1`,
    lastCheckedAt: null,
    lastCheckError: null,
    serverInfo: null,
    authProbe: null,
    updatedAt: currentDate(),
  }).where(eq(managedMcpServers.id, current.id)).returning();
  await tx.update(managedMcpOAuthAttempts).set({ status: "failed" }).where(and(
    eq(managedMcpOAuthAttempts.serverId, current.serverId),
    eq(managedMcpOAuthAttempts.mcpServerId, current.id),
    eq(managedMcpOAuthAttempts.status, "pending"),
  ));
  if (next.authMode === "none") {
    // An App that needs no credential has no Connections. Its pins go back to "follow the default"
    // in the same transaction: left alone they would sit pinned to nothing, and if the App later
    // needed credentials again those Agents would stay refused with no visible reason.
    await tx.update(managedMcpAssignments)
      .set({ connectionMode: "default", boundConnectionId: null, updatedAt: currentDate() })
      .where(and(
        eq(managedMcpAssignments.serverId, current.serverId),
        eq(managedMcpAssignments.mcpServerId, current.id),
        eq(managedMcpAssignments.connectionMode, "pinned"),
      ));
    await tx.delete(managedMcpCredentials).where(eq(managedMcpCredentials.mcpServerId, current.id));
    return row;
  }
  const authChanged = next.authMode !== current.authMode;
  const keepKeys = next.authMode === "headers"
    && !authChanged
    && endpointOrigin(current.endpointUrl) === endpointOrigin(next.endpointUrl);
  await tx.update(managedMcpCredentials).set({
    encryptedOAuth: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    authKind: next.authMode,
    ...(keepKeys ? {} : {
      encryptedHeaders: null,
      authStatus: "needs_auth" as const,
      // The names stay for the same auth kind, so the UI can ask for the values again.
      ...(authChanged ? { headerNames: [] } : {}),
    }),
    credentialVersion: sql`${managedMcpCredentials.credentialVersion} + 1`,
    updatedAt: currentDate(),
  }).where(and(eq(managedMcpCredentials.serverId, current.serverId), eq(managedMcpCredentials.mcpServerId, current.id)));
  return row;
}

/** The Agent's assignment row for this App before a write, if any. */
async function currentAssignment(
  db: DatabaseExecutor,
  input: { agentId: string; mcpServerId: string },
): Promise<AssignmentRow | null> {
  const [current] = await db
    .select()
    .from(managedMcpAssignments)
    .where(and(eq(managedMcpAssignments.agentId, input.agentId), eq(managedMcpAssignments.mcpServerId, input.mcpServerId)))
    .limit(1);
  return current ?? null;
}

/**
 * How this Agent uses one App right now: its mode and what a call would get, judged by
 * `admitManagedMcpCall` (the call path's rule) from the Connections already loaded.
 * See `ManagedMcpAgentConnectionView`.
 */
function agentConnectionView(
  server: ServerRow,
  assignment: AssignmentRow | null,
  connections: { byId: Map<string, ConnectionFacts>; defaultConnection: ConnectionFacts | null },
  includeConnectionName: boolean,
  autoGranted: boolean,
  agentOwnerUserId: string | null,
): ManagedMcpAgentConnectionView {
  // The call path's decision, from the rows this catalogue already loaded.
  const decision = admitFromRows({
    server,
    assignment,
    autoGranted,
    agentOwnerUserId,
    boundCredential: assignment?.boundConnectionId ? connections.byId.get(assignment.boundConnectionId) ?? null : null,
    defaultCredential: connections.defaultConnection,
  });
  const mode = !mcpAgentGrantAllows(decision.grant) ? "off" : assignment?.connectionMode === "pinned" ? "pinned" : "default";
  const status = decision.block?.code === "managed_mcp_server_disabled"
    ? "disabled"
    : decision.connection.allowed
      ? "ready"
      : decision.used?.authStatus === "expired" ? "authorization_expired" : "login_required";
  // As the call path judges a pin (`admitFromRows`): this App's own Connection, usable by this Agent.
  // `connections.byId` spans the whole server, so another App's Connection is checked out here too.
  const bound = assignment?.boundConnectionId ? connections.byId.get(assignment.boundConnectionId) ?? null : null;
  const connectionMissing = mode === "pinned"
    && (bound === null || bound.mcpServerId !== server.id || !mcpConnectionUsableByAgent(bound, agentOwnerUserId));
  return {
    mode,
    status,
    connectionName: includeConnectionName ? decision.used?.name ?? null : null,
    ...(connectionMissing ? { connectionMissing: true } : {}),
    grant: decision.grant,
  };
}

export async function listAgentManagedMcpCatalog(
  serverId: string,
  agentId: string,
  /** Name the Connection each App would use; only for a viewer who may manage this Agent or integrations. */
  options: {
    includeConnectionNames?: boolean;
    /** The Agent's creator and owner, when the caller already loaded the Agent in this server (saves a read). */
    agent?: { creatorType: string | null; creatorId: string | null; assistantOwnerUserId: string | null };
  } = {},
): Promise<ManagedMcpAgentCatalogResponse> {
  const agent = options.agent ?? await requireAgent(serverId, agentId);
  const agentOwnerUserId = mcpAgentOwnerUserId(agent);
  const autoGranted = mcpAutoGrantResolver(getDb(), serverId, agent);
  const [rows, credentialRows, usageRows] = await Promise.all([
    getDb()
      .select({
        server: managedMcpServers,
        assignment: managedMcpAssignments,
      })
      .from(managedMcpServers)
      .leftJoin(managedMcpAssignments, and(
        eq(managedMcpAssignments.mcpServerId, managedMcpServers.id),
        eq(managedMcpAssignments.agentId, agentId),
      ))
      .where(eq(managedMcpServers.serverId, serverId))
      .orderBy(asc(managedMcpServers.name)),
    // ⚠️ Read separately rather than left-joined. The join was single-valued only because of the
    // retained `UNIQUE (mcp_server_id)`; when the contract migration drops it, joining here would
    // multiply every catalogue row by its Connection count -- the same shape the resolver had.
    // Every Connection: the App-level view describes the server default, and the Agent's own
    // state needs the Connection it is pinned to.
    // Only what admission and the view read; the encrypted secrets are never selected here.
    getDb()
      .select({
        id: managedMcpCredentials.id,
        mcpServerId: managedMcpCredentials.mcpServerId,
        isServerDefault: managedMcpCredentials.isServerDefault,
        createdByUserId: managedMcpCredentials.createdByUserId,
        authStatus: managedMcpCredentials.authStatus,
        name: managedMcpCredentials.name,
        authorizedEndpointUrl: managedMcpCredentials.authorizedEndpointUrl,
        headerNames: managedMcpCredentials.headerNames,
        hasSecret: sql<boolean>`(${managedMcpCredentials.encryptedHeaders} IS NOT NULL OR ${managedMcpCredentials.encryptedOAuth} IS NOT NULL)`,
      })
      .from(managedMcpCredentials)
      .where(eq(managedMcpCredentials.serverId, serverId))
      .orderBy(asc(managedMcpCredentials.createdAt), asc(managedMcpCredentials.id)),
    getDb()
      .select({
        mcpServerId: integrationAuditEvents.targetId,
        invocationCount: sql<number>`count(*)::int`,
        lastInvokedAt: sql<Date>`(array_agg(${integrationAuditEvents.createdAt} ORDER BY ${integrationAuditEvents.createdAt} DESC, ${integrationAuditEvents.id} DESC))[1]`,
        lastToolName: sql<string>`(array_agg((${integrationAuditEvents.metadata} ->> 'toolName') ORDER BY ${integrationAuditEvents.createdAt} DESC, ${integrationAuditEvents.id} DESC))[1]`,
      })
      .from(integrationAuditEvents)
      .where(and(
        eq(integrationAuditEvents.serverId, serverId),
        eq(integrationAuditEvents.eventType, "managed_mcp.tool_invocation_admitted"),
        eq(integrationAuditEvents.outcome, "success"),
        eq(integrationAuditEvents.actorType, "agent"),
        eq(integrationAuditEvents.actorId, agentId),
        eq(integrationAuditEvents.subjectType, "agent"),
        eq(integrationAuditEvents.subjectId, agentId),
        eq(integrationAuditEvents.targetType, "managed_mcp_server"),
      ))
      .groupBy(integrationAuditEvents.targetId),
  ]);
  const credentialById = new Map(credentialRows.map((credential) => [credential.id, credential]));
  const credentialByMcpServerId = new Map<string, typeof credentialRows[number]>();
  for (const credential of credentialRows) {
    if (!credential.isServerDefault) continue;
    if (!credentialByMcpServerId.has(credential.mcpServerId)) {
      credentialByMcpServerId.set(credential.mcpServerId, credential);
    }
  }
  const usageByMcpServerId = new Map<string, UsageRow>();
  for (const usage of usageRows) {
    if (!usage.mcpServerId || !usage.lastInvokedAt || !usage.lastToolName) continue;
    const lastInvokedAt = usage.lastInvokedAt instanceof Date
      ? usage.lastInvokedAt
      : new Date(String(usage.lastInvokedAt));
    if (Number.isNaN(lastInvokedAt.getTime())) continue;
    usageByMcpServerId.set(usage.mcpServerId, {
      invocationCount: usage.invocationCount,
      lastInvokedAt,
      lastToolName: usage.lastToolName,
    });
  }
  return {
    // Each row may ask whether its App's creator can manage external auth (one query per creator,
    // memoized by the resolver): bounded so a server with many Apps never borrows the whole pool.
    servers: await mapWithConcurrency(rows, MCP_AUTO_GRANT_CONCURRENCY, async (row) => {
      const defaultConnection = credentialByMcpServerId.get(row.server.id) ?? null;
      return {
        ...serializeServer(row.server, row.assignment, defaultConnection, usageByMcpServerId.get(row.server.id) ?? null),
        logoUrl: row.server.logoUrl,
        homepageUrl: row.server.homepageUrl,
        agentConnection: agentConnectionView(
          row.server,
          row.assignment,
          { byId: credentialById, defaultConnection },
          options.includeConnectionNames === true,
          await autoGranted(row.server),
          agentOwnerUserId,
        ),
      };
    }),
    recommendations: await legacyRecommendations(),
  };
}

export async function listManagedMcpServerCatalog(serverId: string): Promise<ManagedMcpAgentCatalogResponse> {
  const rows = await getDb()
    .select({ server: managedMcpServers, credential: managedMcpCredentials })
    .from(managedMcpServers)
    // Joined on the server-default Connection only: joining every Connection would repeat the App row
    // once per Connection.
    .leftJoin(managedMcpCredentials, and(
      eq(managedMcpCredentials.mcpServerId, managedMcpServers.id),
      eq(managedMcpCredentials.isServerDefault, true),
    ))
    .where(eq(managedMcpServers.serverId, serverId))
    .orderBy(asc(managedMcpServers.name));
  return {
    servers: rows.map((row) => serializeServer(row.server, null, row.credential)),
    recommendations: await legacyRecommendations(),
  };
}

export async function createManagedMcpServer(input: {
  serverId: string;
  userId: string;
  name: string;
  description?: string | null;
  provider?: ManagedMcpProvider;
  authMode?: ManagedMcpAuthMode;
  endpointUrl: string;
  enabled?: boolean;
  headers?: Record<string, string>;
}): Promise<ManagedMcpServerView> {
  const provider = input.provider ?? "custom";
  const authMode = input.authMode ?? (input.headers === undefined ? "none" : "headers");
  const { endpointUrl, preparedHeaders } = await normalizeConnection({ ...input, provider, authMode });
  const result = await getDb().transaction(async (tx) => {
    const [row] = await tx.insert(managedMcpServers).values({
      serverId: input.serverId,
      name: input.name,
      description: input.description ?? null,
      provider,
      authMode,
      oauthStatus: authMode === "oauth" ? "disconnected" : "connected",
      endpointUrl,
      enabled: input.enabled ?? true,
      createdByUserId: input.userId,
      updatedByUserId: input.userId,
    }).returning();
    const credential = authMode === "none" ? null : (await tx.insert(managedMcpCredentials).values({
      serverId: input.serverId,
      mcpServerId: row.id,
      ...(preparedHeaders ?? {}),
      ...newConnectionFields({ authMode, name: row.name, userId: input.userId }),
      ...(authMode === "headers" ? { authorizedEndpointUrl: endpointUrl } : {}),
    }).returning())[0];
    return { row, credential };
  }).catch(rethrowIfMcpAppNameTaken);
  return serializeServer(result.row, null, result.credential);
}


/**
 * The original single-credential edit (`PATCH /servers/:id`). Endpoint and auth-kind changes go
 * through `applyMcpAppServerChange`, the same code the MCP App PATCH uses, so this older route
 * enforces the same template lock and the same per-Connection clearing; it only additionally edits
 * the server-default Connection's API-key headers.
 */
export async function updateManagedMcpServer(input: {
  serverId: string;
  userId: string;
  mcpServerId: string;
  name?: string;
  description?: string | null;
  provider?: ManagedMcpProvider;
  authMode?: ManagedMcpAuthMode;
  endpointUrl?: string;
  enabled?: boolean;
  headers?: Record<string, string>;
  credentialPatch?: ManagedMcpCredentialPatch;
}, deps: { afterRead?: () => Promise<void> } = {}): Promise<ManagedMcpServerView> {
  const current = await loadServer(input.serverId, input.mcpServerId);
  // Before anything else, and before any write: a rejected update must leave nothing behind.
  const provider = input.provider ?? current.provider;
  if (input.headers !== undefined && input.credentialPatch !== undefined) {
    throw new ManagedMcpServiceError("Provide headers or credentialPatch, not both", "managed_mcp_auth_invalid");
  }
  const authMode = input.authMode ?? (input.headers !== undefined || input.credentialPatch !== undefined ? "headers" : current.authMode);
  const nextEndpointUrl = input.endpointUrl === undefined
    ? current.endpointUrl
    : validateManagedMcpConfiguredEndpoint(input.endpointUrl).toString();
  assertTemplateFieldsUnchanged(current, { provider, authMode, endpointUrl: nextEndpointUrl });
  const originChanged = endpointOrigin(nextEndpointUrl) !== endpointOrigin(current.endpointUrl);
  const needsCurrentHeaders = input.credentialPatch !== undefined
    || (originChanged && authMode === "headers" && input.headers === undefined);
  const currentHeaders = needsCurrentHeaders
    ? decryptManagedMcpHeaders((await loadDefaultConnection(input.serverId, input.mcpServerId))?.encryptedHeaders)
    : undefined;
  const patchedHeaders = input.credentialPatch === undefined
    ? undefined
    : applyHeaderPatch(currentHeaders!, input.credentialPatch);
  if (originChanged && authMode === "headers") {
    assertNoImplicitCrossOriginHeaderReuse({
      previousEndpointUrl: current.endpointUrl,
      nextEndpointUrl,
      currentHeaders: currentHeaders ?? {},
      ...(input.headers !== undefined ? { replacementHeaders: input.headers } : {}),
      ...(input.credentialPatch !== undefined ? { credentialPatch: input.credentialPatch } : {}),
    });
  }
  const identityChanged = provider !== current.provider
    || authMode !== current.authMode
    || nextEndpointUrl !== current.endpointUrl;
  const patchChanged = patchedHeaders !== undefined && !headersEqual(currentHeaders!, patchedHeaders);
  const connectionChanged = identityChanged || input.headers !== undefined || patchChanged;
  const runtimeChanged = connectionChanged || (input.enabled !== undefined && input.enabled !== current.enabled);
  const normalized = connectionChanged ? await normalizeConnection({
    provider,
    authMode,
    endpointUrl: nextEndpointUrl,
    ...(input.headers !== undefined ? { headers: input.headers } : patchedHeaders !== undefined ? { headers: patchedHeaders } : {}),
  }) : null;
  const preparedHeaders = normalized?.preparedHeaders ?? null;
  const appValues: McpAppRowValues = {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    updatedByUserId: input.userId,
  };
  // Test seam: the window between reading `current` and writing, where a concurrent edit can land.
  await deps.afterRead?.();
  const result = await getDb().transaction(async (tx) => {
    let row: ServerRow;
    if (identityChanged) {
      row = await applyMcpAppServerChange(tx, current, { endpointUrl: normalized!.endpointUrl, authMode, provider }, appValues);
    } else {
      // A key change must be fenced like a move: these values were validated against `current`, so a
      // concurrent endpoint or auth change since the read would store them for a server they were
      // never entered for (and stamp them with that server's URL below).
      if (connectionChanged) await lockServerConfigUnchanged(tx, current);
      [row] = await tx.update(managedMcpServers).set({
        ...appValues,
        ...(runtimeChanged ? { configVersion: sql`${managedMcpServers.configVersion} + 1` } : {}),
        ...(connectionChanged ? {
          oauthStatus: authMode === "oauth" ? "disconnected" : "connected",
          toolCatalog: [],
          catalogVersion: sql`${managedMcpServers.catalogVersion} + 1`,
          lastCheckedAt: null,
          lastCheckError: null,
        } : {}),
        updatedAt: currentDate(),
      }).where(and(eq(managedMcpServers.id, input.mcpServerId), eq(managedMcpServers.serverId, input.serverId))).returning();
      if (runtimeChanged) {
        await tx
          .update(managedMcpOAuthAttempts)
          .set({ status: "failed" })
          .where(and(
            eq(managedMcpOAuthAttempts.serverId, input.serverId),
            eq(managedMcpOAuthAttempts.mcpServerId, input.mcpServerId),
            eq(managedMcpOAuthAttempts.status, "pending"),
          ));
      }
    }
    let credential: CredentialRow | null = null;
    if (connectionChanged && authMode !== "none") {
      // This route edits the App's own credential, which is its server-default Connection.
      const existing = await loadDefaultConnection(input.serverId, input.mcpServerId, tx);
      const connectionAuthKind = authMode === "oauth" ? "oauth" as const : "headers" as const;
      // Header values written here are for THIS endpoint; recorded so admission can tell.
      // The URL the caller validated, never the row as written: that may have moved since.
      const audience = connectionAuthKind === "headers" ? { authorizedEndpointUrl: normalized!.endpointUrl } : {};
      if (existing && preparedHeaders) {
        [credential] = await tx.update(managedMcpCredentials).set({
          ...preparedHeaders,
          ...audience,
          authKind: "headers",
          authStatus: "ready",
          lastError: null,
          credentialVersion: sql`${managedMcpCredentials.credentialVersion} + 1`,
          updatedAt: currentDate(),
        }).where(eq(managedMcpCredentials.id, existing.id)).returning();
      } else if (!existing) {
        [credential] = await tx.insert(managedMcpCredentials).values({
          serverId: input.serverId,
          mcpServerId: input.mcpServerId,
          ...(preparedHeaders ?? {}),
          ...newConnectionFields({ authMode: connectionAuthKind, name: row.name, userId: input.userId }),
          ...audience,
        }).returning();
      }
    }
    return { row, credential };
  }).catch(rethrowIfMcpAppNameTaken);
  return serializeServer(
    result.row,
    null,
    result.credential ?? await loadDefaultConnection(input.serverId, input.mcpServerId),
  );
}

export async function deleteManagedMcpServer(serverId: string, mcpServerId: string): Promise<void> {
  const rows = await getDb().delete(managedMcpServers)
    .where(and(eq(managedMcpServers.id, mcpServerId), eq(managedMcpServers.serverId, serverId)))
    .returning({ id: managedMcpServers.id });
  if (rows.length === 0) throw new ManagedMcpServiceError("MCP server not found", "managed_mcp_server_not_found");
}

type ManagedMcpCatalogLoader = (
  server: ServerRow,
  credential: CredentialRow | null,
) => Promise<ManagedMcpToolCatalogEntry[]>;

const loadManagedMcpCatalog: ManagedMcpCatalogLoader = async (
  server,
  credential,
) => server.authMode === "oauth"
  ? withManagedMcpOAuth(
      server.serverId,
      server.id,
      (oauthServer, provider) =>
        listManagedMcpOAuthTools(oauthServer.endpointUrl, provider),
      server.configVersion,
    )
  : listManagedMcpTools(
      server.endpointUrl,
      server.authMode === "headers"
        ? decryptManagedMcpHeaders(credential?.encryptedHeaders)
        : {},
    );

async function refreshManagedMcpCatalogWithLoader(
  serverId: string,
  mcpServerId: string,
  loader: ManagedMcpCatalogLoader,
): Promise<ManagedMcpServerView> {
  const server = await loadServer(serverId, mcpServerId);
  const credential = await loadDefaultConnection(serverId, mcpServerId);
  const configFence = and(
    eq(managedMcpServers.id, server.id),
    eq(managedMcpServers.serverId, server.serverId),
    eq(managedMcpServers.configVersion, server.configVersion),
    eq(managedMcpServers.provider, server.provider),
    eq(managedMcpServers.authMode, server.authMode),
    eq(managedMcpServers.endpointUrl, server.endpointUrl),
  );
  try {
    // Never send a key to a server it was not validated for (see `connectionAudienceMatches`).
    if (server.authMode === "headers" && credential && !connectionAudienceMatches(credential, server)) {
      throw new ManagedMcpServiceError("The MCP server address changed; enter the API key again", "managed_mcp_login_required");
    }
    const toolCatalog = await loader(server, credential);
    const [updated] = await getDb().update(managedMcpServers).set({
      toolCatalog,
      catalogVersion: sql`${managedMcpServers.catalogVersion} + 1`,
      lastCheckedAt: currentDate(),
      lastCheckError: null,
      updatedAt: currentDate(),
    }).where(configFence).returning();
    if (!updated) {
      throw new ManagedMcpServiceError(
        "MCP server configuration changed during catalog refresh",
        "managed_mcp_config_stale",
      );
    }
    return serializeServer(updated, null, credential);
  } catch (error) {
    await getDb().update(managedMcpServers).set({
      lastCheckedAt: currentDate(),
      lastCheckError: error instanceof Error ? error.message.slice(0, 500) : "MCP catalog refresh failed",
      updatedAt: currentDate(),
    }).where(configFence);
    throw error;
  }
}

export async function refreshManagedMcpCatalog(
  serverId: string,
  mcpServerId: string,
): Promise<ManagedMcpServerView> {
  return refreshManagedMcpCatalogWithLoader(
    serverId,
    mcpServerId,
    loadManagedMcpCatalog,
  );
}

export async function __refreshManagedMcpCatalogWithLoaderForTest(
  serverId: string,
  mcpServerId: string,
  loader: ManagedMcpCatalogLoader,
): Promise<ManagedMcpServerView> {
  return refreshManagedMcpCatalogWithLoader(serverId, mcpServerId, loader);
}

/**
 * Resolves which Connection an Agent should use, from what the caller asked for.
 *
 * `undefined` leaves the current choice alone, `null` means "follow the App's server default", and a
 * string pins the Agent to that Connection, which must belong to this App on this Raft server.
 *
 * ⚠️ A Connection that does not exist and one that belongs to another App produce the IDENTICAL
 * error, so the response cannot be used to probe ids. Same stance as `resolveMcpCallOrigin`.
 *
 * A pin must also name a Connection this Agent may use: the App's server default, or one the Agent's
 * OWNER created (`mcpConnectionUsableByAgent`). Anything else is refused with
 * `managed_mcp_connection_not_usable`, so managing an Agent never lets someone act with another
 * person's account. Following the default (`null`) is always allowed.
 */
async function resolveAssignmentBinding(input: {
  serverId: string;
  mcpServerId: string;
  connectionId: string | null | undefined;
  /** `mcpAgentOwnerUserId` of the Agent being bound; required so no caller can skip the check. */
  agentOwnerUserId: string | null;
  db: DatabaseExecutor;
}): Promise<{ connectionMode: "default" | "pinned"; boundConnectionId: string | null } | null> {
  if (input.connectionId === undefined) return null;
  if (input.connectionId === null) return { connectionMode: "default", boundConnectionId: null };
  const [credential] = await input.db
    .select({ id: managedMcpCredentials.id, isServerDefault: managedMcpCredentials.isServerDefault, createdByUserId: managedMcpCredentials.createdByUserId })
    .from(managedMcpCredentials)
    .where(and(
      eq(managedMcpCredentials.id, input.connectionId),
      eq(managedMcpCredentials.serverId, input.serverId),
      eq(managedMcpCredentials.mcpServerId, input.mcpServerId),
    ))
    .limit(1);
  if (!credential) {
    throw new ManagedMcpServiceError("MCP connection not found", "managed_mcp_connection_not_found");
  }
  if (!mcpConnectionUsableByAgent(credential, input.agentOwnerUserId)) {
    throw new ManagedMcpServiceError(MCP_CONNECTION_NOT_USABLE_MESSAGE, "managed_mcp_connection_not_usable");
  }
  return { connectionMode: "pinned", boundConnectionId: credential.id };
}

export async function setManagedMcpAssignment(input: {
  serverId: string;
  userId: string;
  agentId: string;
  mcpServerId: string;
  /** Omit to keep the current value (a new row starts enabled). */
  enabled?: boolean;
  /** Omit to keep the current restriction (a new row starts unrestricted); `null` lifts it. */
  allowedTools?: string[] | null;
  /** Omit to leave the current choice; `null` follows the server default; an id pins. See `resolveAssignmentBinding`. */
  connectionId?: string | null;
}, options: { executor?: DatabaseExecutor; closedCards?: string[] } = {}): Promise<ManagedMcpServerView> {
  // Inside a fenced transaction every read goes through the executor: a separate getDb() read would wait on the
  // caller's transaction on a single-connection database and needlessly take a second pool connection on Postgres.
  const db = options.executor ?? getDb();
  const agent = await requireAgent(input.serverId, input.agentId, db);
  const server = await loadServer(input.serverId, input.mcpServerId, db);
  if (input.allowedTools !== undefined && input.allowedTools !== null) {
    const catalogNames = new Set(server.toolCatalog.map((tool) => tool.name));
    if (input.allowedTools.some((toolName) => !catalogNames.has(toolName))) {
      throw new ManagedMcpServiceError("Assignment contains a tool outside the current catalog", "managed_mcp_tool_not_allowed");
    }
  }
  // Judged as the CALLER, inside the caller's fence when there is one, and before the write.
  const binding = await resolveAssignmentBinding({
    serverId: input.serverId,
    mcpServerId: input.mcpServerId,
    connectionId: input.connectionId,
    agentOwnerUserId: mcpAgentOwnerUserId(agent),
    db,
  });
  // Granting needs no usable Connection (yezizp, #wg-mcp b3f9feed 1): the Agent is offered the
  // App's tools (or the connect request), and its first call is refused by admission with
  // login_required, which raises the Connect card. Admission is where "connected" is decided.
  const current = await currentAssignment(db, input);
  // A first row written without `enabled` keeps what the Agent had: the automatic grant decides.
  const enabledForNewRow = input.enabled
    ?? (current ? current.enabled : await mcpAutoGrantResolver(db, input.serverId, agent)(server));
  // The upsert is the authority write; with an executor it joins the caller's fenced transaction.
  const [assignment] = await db.insert(managedMcpAssignments).values({
    serverId: input.serverId,
    agentId: input.agentId,
    mcpServerId: input.mcpServerId,
    enabled: enabledForNewRow,
    allowedTools: input.allowedTools ?? null,
    ...(binding ?? {}),
    updatedByUserId: input.userId,
  }).onConflictDoUpdate({
    target: [managedMcpAssignments.agentId, managedMcpAssignments.mcpServerId],
    set: {
      // Only what the caller sent. A control that changes the Connection must not silently lift a
      // tool restriction or switch an Agent back on (@Huarong).
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.allowedTools !== undefined ? { allowedTools: input.allowedTools } : {}),
      // Spread only when the caller said something about the binding; otherwise the existing
      // columns are left in place rather than being silently cleared by an unrelated edit.
      ...(binding ?? {}),
      assignmentVersion: sql`${managedMcpAssignments.assignmentVersion} + 1`,
      updatedByUserId: input.userId,
      updatedAt: currentDate(),
    },
  }).returning();
  // An authorization granted here satisfies any open Connect card for this (Agent, MCP), even
  // though the operator never opened the card's dialog. Leaving it `prepared` would both mislead
  // the channel and block the next genuine refusal from raising a fresh card (reuse finds the
  // stale one). Best-effort by construction: it only ever closes a card the runtime would now
  // admit, and it is computed with the runtime's own predicate. The caller announces a closed card
  // after commit (announceResolvedActionCards), so the Agent that asked hears how it ended.
  const closed = await resolveOpenMcpConnectionCard(db, {
    serverId: input.serverId,
    agentId: input.agentId,
    mcpServerId: input.mcpServerId,
    userId: input.userId,
    authorized: await isMcpConnectionAuthorized(db, input.serverId, input.agentId, input.mcpServerId),
  });
  if (closed) options.closedCards?.push(closed.messageId);
  return serializeServer(await loadServer(input.serverId, input.mcpServerId, db), assignment, await loadDefaultConnection(input.serverId, input.mcpServerId, db));
}

export interface ManagedMcpAssignmentUpdate {
  mcpServerId: string;
  /** Omit to keep the current value (a new row starts enabled). */
  enabled?: boolean;
  /** Omit to keep the current restriction (a new row starts unrestricted); `null` lifts it. */
  allowedTools?: string[] | null;
  /** Omit to leave the current choice; `null` follows the server default; an id pins. See `resolveAssignmentBinding`. */
  connectionId?: string | null;
}

export async function applyManagedMcpAssignments(input: {
  serverId: string;
  userId: string;
  agentId: string;
  assignments: ManagedMcpAssignmentUpdate[];
}): Promise<ManagedMcpAgentCatalogResponse> {
  await writeManagedMcpAssignments(input);
  return listAgentManagedMcpCatalog(input.serverId, input.agentId);
}

/**
 * Validates and upserts a bulk assignment update. With an executor the upserts join the caller's fenced transaction
 * (task #91) as a savepoint; the caller reads the catalog back after its commit.
 */
export async function writeManagedMcpAssignments(input: {
  serverId: string;
  userId: string;
  agentId: string;
  assignments: ManagedMcpAssignmentUpdate[];
}, options: { executor?: DatabaseExecutor; closedCards?: string[] } = {}): Promise<void> {
  const db = options.executor ?? getDb();
  const agent = await requireAgent(input.serverId, input.agentId, db);
  const autoGranted = mcpAutoGrantResolver(db, input.serverId, agent);
  const uniqueIds = new Set(input.assignments.map((assignment) => assignment.mcpServerId));
  if (uniqueIds.size !== input.assignments.length) {
    throw new ManagedMcpServiceError("MCP assignment updates must be unique", "managed_mcp_assignment_stale");
  }

  const servers: ServerRow[] = [];
  for (const assignment of input.assignments) servers.push(await loadServer(input.serverId, assignment.mcpServerId, db));
  input.assignments.forEach((assignment, index) => {
    if (assignment.allowedTools === undefined || assignment.allowedTools === null) return;
    const catalogNames = new Set(servers[index].toolCatalog.map((tool) => tool.name));
    if (assignment.allowedTools.some((toolName) => !catalogNames.has(toolName))) {
      throw new ManagedMcpServiceError("Assignment contains a tool outside the current catalog", "managed_mcp_tool_not_allowed");
    }
  });

  // With an executor the caller already owns the transaction, so write on it directly rather than opening a nested
  // savepoint; without one the upserts still commit atomically in their own transaction.
  const writeAll = async (tx: DatabaseExecutor) => {
    for (const [index, assignment] of input.assignments.entries()) {
      // Each binding is resolved against ITS own MCP server, inside this transaction, so a bulk
      // update cannot smuggle one Agent a Connection from a different App.
      const binding = await resolveAssignmentBinding({
        serverId: input.serverId,
        mcpServerId: assignment.mcpServerId,
        connectionId: assignment.connectionId,
        agentOwnerUserId: mcpAgentOwnerUserId(agent),
        db: tx,
      });
      const current = await currentAssignment(tx, { agentId: input.agentId, mcpServerId: assignment.mcpServerId });
      await tx.insert(managedMcpAssignments).values({
        serverId: input.serverId,
        agentId: input.agentId,
        mcpServerId: assignment.mcpServerId,
        enabled: assignment.enabled ?? (current ? current.enabled : await autoGranted(servers[index])),
        allowedTools: assignment.allowedTools ?? null,
        ...(binding ?? {}),
        updatedByUserId: input.userId,
      }).onConflictDoUpdate({
        target: [managedMcpAssignments.agentId, managedMcpAssignments.mcpServerId],
        set: {
          ...(assignment.enabled !== undefined ? { enabled: assignment.enabled } : {}),
          ...(assignment.allowedTools !== undefined ? { allowedTools: assignment.allowedTools } : {}),
          ...(binding ?? {}),
          assignmentVersion: sql`${managedMcpAssignments.assignmentVersion} + 1`,
          updatedByUserId: input.userId,
          updatedAt: currentDate(),
        },
      });
      // Same rule as the single-assignment path: an authorization granted here closes the open
      // Connect card for that (Agent, MCP), whichever surface granted it.
      const closed = await resolveOpenMcpConnectionCard(tx, {
        serverId: input.serverId,
        agentId: input.agentId,
        mcpServerId: assignment.mcpServerId,
        userId: input.userId,
        authorized: await isMcpConnectionAuthorized(tx, input.serverId, input.agentId, assignment.mcpServerId),
      });
      if (closed) options.closedCards?.push(closed.messageId);
    }
  };
  if (options.executor) {
    await writeAll(options.executor);
  } else {
    await getDb().transaction(writeAll);
  }
}

export async function testManagedMcpConfiguration(input: {
  serverId: string;
  mcpServerId?: string;
  endpointUrl: string;
  authMode?: Exclude<ManagedMcpAuthMode, "oauth">;
  headers?: Record<string, string>;
  credentialPatch?: ManagedMcpCredentialPatch;
}): Promise<ManagedMcpToolCatalogEntry[]> {
  const current = input.mcpServerId ? await loadServer(input.serverId, input.mcpServerId) : null;
  if (input.headers !== undefined && input.credentialPatch !== undefined) {
    throw new ManagedMcpServiceError("Provide headers or credentialPatch, not both", "managed_mcp_auth_invalid");
  }
  if (input.authMode === "none" && input.headers !== undefined && Object.keys(input.headers).length > 0) {
    throw new ManagedMcpServiceError("Unauthenticated connections cannot include credential headers", "managed_mcp_auth_invalid");
  }
  const storedHeaders = input.mcpServerId
    ? decryptManagedMcpHeaders((await loadDefaultConnection(input.serverId, input.mcpServerId))?.encryptedHeaders)
    : {};
  const endpointUrl = validateManagedMcpConfiguredEndpoint(input.endpointUrl).toString();
  const headers = input.credentialPatch !== undefined
    ? applyHeaderPatch(storedHeaders, input.credentialPatch)
    : input.headers === undefined ? storedHeaders : normalizeManagedMcpHeaders(input.headers);
  if (current && input.authMode !== "none") {
    assertNoImplicitCrossOriginHeaderReuse({
      previousEndpointUrl: current.endpointUrl,
      nextEndpointUrl: endpointUrl,
      currentHeaders: storedHeaders,
      ...(input.headers !== undefined ? { replacementHeaders: input.headers } : {}),
      ...(input.credentialPatch !== undefined ? { credentialPatch: input.credentialPatch } : {}),
    });
  }
  return listManagedMcpTools(endpointUrl, input.authMode === "none" ? {} : headers);
}

/**
 * The Raft Apps tools: three fixed tools every Agent's managed MCP snapshot carries, whatever Apps
 * the Server has. They are how an Agent reaches an MCP App whose own tools are not in its tool list:
 * a runtime reads tools/list once per session and the managed MCP proxy sends no list_changed, so an
 * App created, granted or connected after the session started (even one whose session began with no
 * Apps at all) is otherwise unreachable until a restart.
 *
 *   raft_apps_list   the Apps this Agent can see (the `raft integration list` inventory), with grant,
 *                    state and the `raft integration login` request for any that need one
 *   raft_app_tools   {app}: one App's current tools for this Agent (allowedTools honoured)
 *   raft_app_call    {app, name, arguments}: calls one of them through the same path as a native
 *                    tool call (`executeManagedMcpCall`: grant, allowedTools, admission, Connection,
 *                    usage audit)
 *
 * They are addressed by a reserved App id (`RAFT_APPS_MCP_SERVER_ID`, never a real App), so the
 * snapshot and call shapes stay as daemons know them; their names are namespaced so none can be
 * mistaken for an App's own tool. A refusal about an App (`login_required` while it has no usable
 * Connection) raises that App's Connect card, as its own tool would.
 */
export const RAFT_APPS_MCP_SERVER_ID = "7a17a995-0000-4000-8000-000000000000";
export const RAFT_APPS_LIST_TOOL = "raft_apps_list";
export const RAFT_APP_TOOLS_TOOL = "raft_app_tools";
export const RAFT_APP_CALL_TOOL = "raft_app_call";

const RAFT_APPS_WHEN = "Use this when an MCP App's own tools are not in your tool list (for example, it was added or connected after your session started).";
const RAFT_APP_ARG = { type: "string", description: `The App's id or exact name, as listed by ${RAFT_APPS_LIST_TOOL}.` };

function raftAppsTools(): ManagedMcpRuntimeTool[] {
  const tools: Array<Pick<ManagedMcpRuntimeTool, "toolName" | "title" | "description" | "inputSchema" | "annotations">> = [
    {
      toolName: RAFT_APPS_LIST_TOOL,
      title: "List Raft MCP Apps",
      description: `${RAFT_APPS_WHEN} Lists the MCP Apps on this Raft Server you can see: whether you have each one, whether it is connected, and for any you cannot use yet the \`raft integration login --service <id> --target <channel-or-thread>\` command that asks a person for it. If there are none, it returns an empty list and says no MCP Apps are available: there is nothing to request.`,
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    {
      toolName: RAFT_APP_TOOLS_TOOL,
      title: "List an MCP App's tools",
      description: `${RAFT_APPS_WHEN} Lists one App's current tools (name, description, input schema) that you may call with ${RAFT_APP_CALL_TOOL}. If you do not have the App it says so and gives the login command to ask for it; if it is not connected for you yet, the call asks a person in this conversation to connect it (wait for them, then call again).`,
      inputSchema: { type: "object", properties: { app: RAFT_APP_ARG }, required: ["app"] },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    {
      toolName: RAFT_APP_CALL_TOOL,
      title: "Call an MCP App's tool",
      description: `${RAFT_APPS_WHEN} Calls one of an App's tools by name (see ${RAFT_APP_TOOLS_TOOL}) with its arguments, exactly as if it were in your tool list. If you do not have the App it says so and gives the login command to ask for it; if it is not connected for you yet, the call asks a person in this conversation to connect it (wait for them, then call again).`,
      inputSchema: {
        type: "object",
        properties: {
          app: RAFT_APP_ARG,
          name: { type: "string", description: `The tool to call, as listed by ${RAFT_APP_TOOLS_TOOL}.` },
          arguments: { type: "object", description: "The tool's arguments, matching its input schema." },
        },
        required: ["app", "name"],
      },
      annotations: {},
    },
  ];
  return tools.map((tool) => ({
    mcpServerId: RAFT_APPS_MCP_SERVER_ID,
    serverName: "Raft Apps",
    toolName: tool.toolName,
    // Fixed and namespaced: App tools are always `mcp_<app>_<tool>_<hash>`.
    runtimeName: tool.toolName,
    ...(tool.title ? { title: tool.title } : {}),
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema,
    ...(tool.annotations && Object.keys(tool.annotations).length > 0 ? { annotations: tool.annotations } : {}),
    configVersion: 1,
    assignmentVersion: 1,
  }));
}

/**
 * The per-App generic tools an earlier snapshot offered (`list_tools`, `call_tool`, and before them
 * `request_connection`). New snapshots carry the Raft Apps tools instead; a session started on the
 * earlier snapshot may still name these, so the call path keeps answering them.
 */
const MANAGED_MCP_LIST_TOOLS_TOOL = "list_tools";
const MANAGED_MCP_CALL_TOOL_TOOL = "call_tool";
const LEGACY_CONNECT_REQUEST_TOOL = "request_connection";

type GenericToolKind = "list" | "call";

/** Whether this call names a per-App generic tool (and not a real tool of the App with that name). */
function genericToolKind(server: Pick<ServerRow, "toolCatalog">, toolName: string): GenericToolKind | null {
  if (server.toolCatalog.some((tool) => tool.name === toolName)) return null;
  if (toolName === MANAGED_MCP_LIST_TOOLS_TOOL || toolName === LEGACY_CONNECT_REQUEST_TOOL) return "list";
  if (toolName === MANAGED_MCP_CALL_TOOL_TOOL) return "call";
  return null;
}

/** Where the per-App generic tools were offered: Apps that sign in, unless limited to no tools. */
// Now only serves legacy snapshots that still list the per-App list_tools / call_tool / request_connection.
function offersGenericTools(
  server: Pick<ServerRow, "authMode">,
  assignment: Pick<AssignmentRow, "allowedTools"> | null,
): boolean {
  return server.authMode !== "none" && !(assignment?.allowedTools && assignment.allowedTools.length === 0);
}

/** The App's tools this Agent may call, for `list_tools`. */
function listToolsResult(server: ServerRow, assignment: AssignmentRow | null): ManagedMcpCallResult {
  const allowed = assignment?.allowedTools ?? null;
  const tools = server.toolCatalog
    .filter((tool) => allowed === null || allowed.includes(tool.name))
    .map((tool) => ({
      name: tool.name,
      ...(tool.title ? { title: tool.title } : {}),
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: tool.inputSchema,
    }));
  const appName = formatManagedMcpPromptName(server.name);
  const text = tools.length === 0
    ? `${appName} is connected for you, but its tool list has not been read yet. A person can refresh it in the App's settings.`
    : `${appName} has ${tools.length} tool${tools.length === 1 ? "" : "s"} you may call with ${RAFT_APP_CALL_TOOL} {"app": ${JSON.stringify(server.id)}, "name": "<tool>", "arguments": {...}}:\n${JSON.stringify(tools, null, 2)}`;
  return { content: [{ type: "text", text }], isError: false, structuredContent: { app: { id: server.id, name: server.name }, tools } };
}

export async function getManagedMcpRuntimeSnapshot(serverId: string, agentId: string): Promise<ManagedMcpRuntimeSnapshot> {
  const agent = await requireAgent(serverId, agentId);
  const autoGranted = mcpAutoGrantResolver(getDb(), serverId, agent);
  const rows = await getDb().select({ server: managedMcpServers, assignment: managedMcpAssignments })
    .from(managedMcpServers)
    .leftJoin(managedMcpAssignments, and(
      eq(managedMcpAssignments.mcpServerId, managedMcpServers.id),
      eq(managedMcpAssignments.serverId, serverId),
      eq(managedMcpAssignments.agentId, agentId),
    ))
    .where(and(
      eq(managedMcpServers.serverId, serverId),
      eq(managedMcpServers.enabled, true),
    ))
    .orderBy(asc(managedMcpServers.name));
  // Not granted to this Agent (revoked, or never granted automatically): no tools at all.
  const granted = await mapWithConcurrency(rows, MCP_AUTO_GRANT_CONCURRENCY, async ({ server, assignment }) => (
    mcpAgentGrantAllows(mcpAgentGrant(assignment, await autoGranted(server)))
  ));
  // An App this Agent has but cannot use yet (no usable Connection: never signed in, signing in,
  // expired, or the OAuth sign-in dropped) is ALSO listed apart, so an agent that reads this list
  // (raft-sdk) can tell the user it needs (re)connecting instead of acting as if it were never set
  // up. Its tools stay offered below: a call is what raises the Connect card. Judged by the call
  // path's own rule (`admitFromRows`), from the Connections loaded once for the whole snapshot.
  const needsConnection = rows.filter(({ server }, index) => granted[index] && server.authMode !== "none");
  const connectionRows = needsConnection.length === 0 ? [] : await getDb()
    .select({
      id: managedMcpCredentials.id,
      mcpServerId: managedMcpCredentials.mcpServerId,
      isServerDefault: managedMcpCredentials.isServerDefault,
      createdByUserId: managedMcpCredentials.createdByUserId,
      authStatus: managedMcpCredentials.authStatus,
      name: managedMcpCredentials.name,
      authorizedEndpointUrl: managedMcpCredentials.authorizedEndpointUrl,
      headerNames: managedMcpCredentials.headerNames,
    })
    .from(managedMcpCredentials)
    .where(eq(managedMcpCredentials.serverId, serverId));
  const agentOwnerUserId = mcpAgentOwnerUserId(agent);
  const connectionById = new Map(connectionRows.map((row) => [row.id, row]));
  const unavailable = needsConnection
    .filter(({ server, assignment }) => {
      const decision = admitFromRows({
        server,
        assignment,
        autoGranted: true,
        agentOwnerUserId,
        boundCredential: assignment?.boundConnectionId ? connectionById.get(assignment.boundConnectionId) ?? null : null,
        defaultCredential: connectionRows.find((row) => row.mcpServerId === server.id && row.isServerDefault) ?? null,
      });
      return decision.block === null && !decision.connection.allowed;
    })
    .map(({ server }) => ({ mcpServerId: server.id, serverName: server.name, status: "reconnect_required" as const }));
  const unavailableIds = new Set(unavailable.map((entry) => entry.mcpServerId));
  return {
    catalogVersion: 1,
    ...(unavailable.length > 0 ? { unavailable } : {}),
    tools: [...rows.flatMap(({ server, assignment }, index) => {
      if (!granted[index]) return [];
      // Offered whatever the state of the Connection (missing, signing in, expired): a call is then
      // refused with `login_required`, which raises the card that tells a human what to fix. Hiding
      // the tools instead left nothing to call, so nobody was ever asked.
      return server.toolCatalog.filter(tool => !assignment || assignment.allowedTools === null || assignment.allowedTools.includes(tool.name)).map((tool) => ({
        mcpServerId: server.id,
        serverName: server.name,
        toolName: tool.name,
        runtimeName: formatManagedMcpRuntimeToolName(server.id, tool.name),
        ...(tool.title ? { title: tool.title } : {}),
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema,
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
        configVersion: server.configVersion,
        assignmentVersion: assignment?.assignmentVersion ?? 1,
      }));
    }), ...raftAppsTools()],
  };
}


/**
 * Which Connection, if any, an Agent's MCP call may use. One rule for every MCP App.
 *
 * Inputs are already narrowed to THIS App: `boundCredential` is the Connection the Agent is pinned
 * to (looked up by id and scoped to this App, null if it no longer exists), and `defaultCredential`
 * is the App's server default. The caller must send exactly the credential this names and no other.
 *
 *   no assignment row          → follow the default (the long-standing "every Agent inherits")
 *   assignment, enabled=false  → off; refused before this function (managed_mcp_app_off)
 *   connection_mode 'default'  → the server default; none means login_required
 *   connection_mode 'pinned'   → that Connection; gone means login_required, and so does one this
 *                                Agent may not use (`mcpConnectionUsableByAgent`: not the server
 *                                default and not created by the Agent's owner), with `detail`
 *                                `not_usable` so the refusal can say what to do
 *
 * The rule with teeth: a pin whose Connection was deleted, or may not be used by this Agent, does
 * NOT fall back to the server default. Falling back would silently re-grant, through another
 * credential, access that was deliberately scoped. Every denial is the same `login_required`, so
 * nothing here tells a caller whether a Connection exists.
 *
 * An App whose auth mode is `none` needs no Connection: it is admitted with `credentialId: null`.
 */
type ManagedMcpAdmission =
  | { allowed: true; credentialId: string | null }
  | {
    allowed: false;
    reason: "login_required";
    /** `not_usable`: the pinned Connection exists but belongs to someone other than the Agent's owner. */
    detail?: "not_usable";
  };

type AdmissionConnection = {
  id: string;
  authStatus: string;
  isServerDefault: boolean;
  /** Who signed it in; null when unknown (usable only as the server default). */
  createdByUserId: string | null;
  /** `connectionAudienceMatches`: false when the secret was recorded for another server. */
  audienceMatches?: boolean;
};

export function admitManagedMcpCall(input: {
  requiresCredential: boolean;
  assignment: { connectionMode: "default" | "pinned"; boundConnectionId: string | null } | null;
  boundCredential: AdmissionConnection | null;
  defaultCredential: AdmissionConnection | null;
  /**
   * The Agent's owner (`mcpAgentOwnerUserId`); null when it has none. Required, so every caller says
   * whose Agent this is: a pinned Connection is admitted only if this Agent may use it.
   */
  agentOwnerUserId: string | null;
  /**
   * For an OAuth App: `server.oauth_status === 'connected'`, the mirror of its default Connection
   * that older binaries maintain. Only consulted when the admitted Connection IS the default, so a
   * Connection pinned to an Agent is judged by its own status alone.
   */
  appOAuthConnected?: boolean;
}): ManagedMcpAdmission {
  const deny = { allowed: false, reason: "login_required" } as const;
  if (!input.requiresCredential) return { allowed: true, credentialId: null };
  const pinned = input.assignment?.connectionMode === "pinned";
  const connection = pinned
    ? (input.assignment?.boundConnectionId ? input.boundCredential : null)
    : input.defaultCredential;
  if (!connection) return deny;
  // Someone else's Connection: refused before its state is looked at (signing it in again would not
  // help), and never replaced by the default.
  if (pinned && !mcpConnectionUsableByAgent(connection, input.agentOwnerUserId)) {
    return { ...deny, detail: "not_usable" };
  }
  // A Connection that is waiting for sign-in, or whose sign-in expired, cannot be used yet.
  if (connection.authStatus !== "ready") return deny;
  // Authorized for a different server than the App now points at: never send that secret.
  if (connection.audienceMatches === false) return deny;
  if (connection.isServerDefault && input.appOAuthConnected === false) return deny;
  return { allowed: true, credentialId: connection.id };
}

/**
 * Server-level reasons a call is refused before any Connection question is asked.
 *
 * Extracted so `executeManagedMcpCall` and `isMcpConnectionAuthorized` cannot drift: the card's
 * "executed" is defined as "the runtime would admit this call now", and that has to include the
 * states that refuse every Agent regardless of their Connection.
 */
export function managedMcpServerCallBlock(
  server: Pick<typeof managedMcpServers.$inferSelect, "enabled">,
): { code: ManagedMcpServiceError["code"]; message: string } | null {
  // An OAuth App whose sign-in is missing or expired is NOT blocked here: that is a question about
  // a Connection, answered by admission per Agent (a pinned Connection can be ready while the
  // default is not), and its refusal is `login_required`, which raises a Connect card.
  if (!server.enabled) return { code: "managed_mcp_server_disabled", message: "MCP server is disabled" };
  return null;
}

/** What admission reads from one App, one assignment row and the Connections it names. */
export interface McpAdmissionRows<C extends ConnectionFacts = ConnectionFacts> {
  server: Pick<ServerRow, "id" | "enabled" | "authMode" | "oauthStatus" | "endpointUrl">;
  assignment: Pick<AssignmentRow, "enabled" | "connectionMode" | "boundConnectionId"> | null;
  /** `mcpAutoGrantResolver` for this Agent and App. */
  autoGranted: boolean;
  /** `mcpAgentOwnerUserId` of this Agent (null: it has no owner, so only the default is usable). */
  agentOwnerUserId: string | null;
  /** The row named by `boundConnectionId`, as looked up (it may belong to another App; it is scoped here). */
  boundCredential: C | null;
  /** The App's server-default Connection. */
  defaultCredential: C | null;
}

export interface McpAdmissionDecision<C extends ConnectionFacts = ConnectionFacts> {
  /** Refused before any Connection question: the App is disabled, or this Agent does not have it. */
  block: { code: "managed_mcp_server_disabled" | "managed_mcp_app_off"; message: string } | null;
  grant: ManagedMcpAgentGrant;
  /** Whether the Connection this Agent would use is admitted, judged even when `block` is set. */
  connection: ReturnType<typeof admitManagedMcpCall>;
  /** That Connection (scoped to this App), or null. */
  used: C | null;
}

/**
 * THE admission decision, from rows already loaded. Pure, so the call path (`executeManagedMcpCall`),
 * `isMcpConnectionAuthorized` and an Agent's catalogue (`agentConnectionView`) cannot disagree: each
 * loads the rows its own way and asks this. Order: a disabled App, then the grant (revoked / never
 * granted), then the Connection (pin scoped to this App, its audience, the OAuth mirror).
 */
export function admitFromRows<C extends ConnectionFacts>(input: McpAdmissionRows<C>): McpAdmissionDecision<C> {
  const { server, assignment } = input;
  const grant = mcpAgentGrant(assignment, input.autoGranted);
  const pinned = assignment?.connectionMode === "pinned";
  // A bound id from another App is not this App's Connection: refused, never followed.
  const boundCredential = pinned && assignment?.boundConnectionId && input.boundCredential?.mcpServerId === server.id
    && input.boundCredential.id === assignment.boundConnectionId
    ? input.boundCredential
    : null;
  const defaultCredential = input.defaultCredential?.mcpServerId === server.id && input.defaultCredential.isServerDefault
    ? input.defaultCredential
    : null;
  const judged = (row: C | null) => row && { ...row, audienceMatches: connectionAudienceMatches(row, server) };
  const connection = admitManagedMcpCall({
    requiresCredential: server.authMode !== "none",
    assignment: assignment ? { connectionMode: assignment.connectionMode, boundConnectionId: assignment.boundConnectionId } : null,
    boundCredential: judged(boundCredential),
    defaultCredential: judged(defaultCredential),
    agentOwnerUserId: input.agentOwnerUserId,
    ...(server.authMode === "oauth" ? { appOAuthConnected: server.oauthStatus === "connected" } : {}),
  });
  const serverBlock = managedMcpServerCallBlock(server);
  const block = serverBlock
    ? { code: "managed_mcp_server_disabled" as const, message: serverBlock.message }
    : grant === "revoked"
      ? { code: "managed_mcp_app_off" as const, message: "This MCP App was revoked for this agent" }
      : grant === "not_granted"
        ? { code: "managed_mcp_app_off" as const, message: "This MCP App is not granted to this agent" }
        : null;
  return { block, grant, connection, used: server.authMode === "none" ? null : pinned ? boundCredential : defaultCredential };
}

/**
 * Loads the Connections admission needs (scoped to this App) and runs `admitManagedMcpCall`.
 * The ONLY place the call path and `isMcpConnectionAuthorized` get their answer from, so the
 * "would the runtime admit this now?" question cannot be answered two ways.
 */
async function admitWithConnections(
  executor: DatabaseExecutor,
  serverId: string,
  server: McpAdmissionRows["server"],
  assignment: Pick<AssignmentRow, "enabled" | "connectionMode" | "boundConnectionId"> | null,
  autoGranted: boolean,
  agentOwnerUserId: string | null,
): Promise<McpAdmissionDecision<CredentialRow> & { boundCredential: CredentialRow | null; defaultCredential: CredentialRow | null }> {
  const pinned = assignment?.connectionMode === "pinned";
  const boundCredential = pinned && assignment?.boundConnectionId
    ? (await executor.select().from(managedMcpCredentials).where(and(
        eq(managedMcpCredentials.id, assignment.boundConnectionId),
        eq(managedMcpCredentials.serverId, serverId),
        eq(managedMcpCredentials.mcpServerId, server.id),
      )).limit(1))[0] ?? null
    : null;
  const defaultCredential = pinned ? null : await loadDefaultConnection(serverId, server.id, executor);
  return {
    ...admitFromRows({ server, assignment, autoGranted, agentOwnerUserId, boundCredential, defaultCredential }),
    boundCredential,
    defaultCredential,
  };
}

/**
 * Is this Agent REALLY authorized to use this MCP App right now?
 *
 * Exists so the `integration:connect_mcp` action card can be marked executed against the world
 * rather than against a client's claim (@Huarong). It uses `admitWithConnections`, the same path the
 * runtime call takes, so a card can never say "connected" for an Agent that is still refused.
 */
export async function isMcpConnectionAuthorized(
  executor: DatabaseExecutor,
  serverId: string,
  agentId: string,
  mcpServerId: string,
): Promise<boolean> {
  return (await agentMcpAdmission(executor, serverId, agentId, mcpServerId)).authorized;
}

/**
 * The Connection this Agent's calls to the App are admitted with right now, or null when they are
 * refused (or the App needs no Connection). Same decision as `isMcpConnectionAuthorized`.
 */
export async function admittedMcpConnectionId(
  executor: DatabaseExecutor,
  serverId: string,
  agentId: string,
  mcpServerId: string,
): Promise<string | null> {
  const admission = await agentMcpAdmission(executor, serverId, agentId, mcpServerId);
  return admission.authorized ? admission.credentialId : null;
}

async function agentMcpAdmission(
  executor: DatabaseExecutor,
  serverId: string,
  agentId: string,
  mcpServerId: string,
): Promise<{ authorized: boolean; credentialId: string | null }> {
  const [row] = await executor
    .select({
      server: managedMcpServers,
      assignment: managedMcpAssignments,
      agent: { creatorType: agents.creatorType, creatorId: agents.creatorId, assistantOwnerUserId: agents.assistantOwnerUserId },
    })
    .from(managedMcpServers)
    .innerJoin(agents, and(eq(agents.id, agentId), eq(agents.serverId, serverId)))
    .leftJoin(managedMcpAssignments, and(
      eq(managedMcpAssignments.mcpServerId, managedMcpServers.id),
      eq(managedMcpAssignments.serverId, serverId),
      eq(managedMcpAssignments.agentId, agentId),
    ))
    .where(and(eq(managedMcpServers.id, mcpServerId), eq(managedMcpServers.serverId, serverId)))
    .limit(1);
  if (!row) return { authorized: false, credentialId: null };
  // The call path's own decision (`admitFromRows`): a disabled App, a revoked or never-granted App,
  // and a Connection problem all mean "not authorized".
  const autoGranted = await mcpAutoGrantResolver(executor, serverId, row.agent)(row.server);
  const decision = await admitWithConnections(executor, serverId, row.server, row.assignment, autoGranted, mcpAgentOwnerUserId(row.agent));
  const authorized = decision.block === null && decision.connection.allowed;
  return { authorized, credentialId: decision.connection.allowed ? decision.connection.credentialId : null };
}

/**
 * Closes every open Connect card for this App whose Agent the runtime would now admit.
 *
 * For writes that change admission for many Agents at once (a new server default, a completed
 * sign-in): the Agents are the ones with an open card for the App, each re-judged with the same
 * predicate the call path uses. Returns how many cards were closed.
 */
export async function resolveAdmittedConnectionCardsForApp(
  executor: DatabaseExecutor,
  input: { serverId: string; mcpServerId: string; userId: string },
  /** Collects each closed card's message, for the caller to announce after commit. */
  closedCards?: string[],
): Promise<number> {
  const open = await executor
    .selectDistinct({ agentId: actionCards.requesterAgentId })
    .from(actionCards)
    .where(and(
      eq(actionCards.serverId, input.serverId),
      eq(actionCards.actionType, "integration:connect_mcp"),
      eq(actionCards.state, "prepared"),
      sql`${actionCards.payload} ->> 'mcpServerId' = ${input.mcpServerId}`,
    ));
  let resolved = 0;
  for (const { agentId } of open) {
    // connect_mcp cards are agent-asked; a person's card never matches the type filter.
    if (!agentId) continue;
    const closed = await resolveOpenMcpConnectionCard(executor, {
      serverId: input.serverId,
      agentId,
      mcpServerId: input.mcpServerId,
      userId: input.userId,
      authorized: await isMcpConnectionAuthorized(executor, input.serverId, agentId, input.mcpServerId),
    });
    if (closed) {
      resolved += 1;
      closedCards?.push(closed.messageId);
    }
  }
  return resolved;
}

async function recordManagedMcpUsage(input: {
  serverId: string;
  agentId: string;
  mcpServerId: string;
  toolName: string;
}): Promise<void> {
  // This records successful Server admission, before provider I/O. Arguments
  // and results never enter the audit ledger; the Agent usage view needs only
  // the MCP identity, aggregate count, and most recently admitted tool.
  await recordIntegrationAuditEvent({
    serverId: input.serverId,
    eventType: "managed_mcp.tool_invocation_admitted",
    outcome: "success",
    source: "api",
    actor: { type: "agent", id: input.agentId },
    subject: { type: "agent", id: input.agentId },
    target: { type: "managed_mcp_server", id: input.mcpServerId },
    metadata: { toolName: input.toolName },
  });
}

/**
 * The call path's refusal for a Connection admission denied. Always `login_required`, which raises the
 * Connect card so a human can fix it; when the cause is a pin to someone else's Connection the message
 * says what fixes it (worded for the agent, so the agent API sends it as is).
 */
function connectionRefusal(admission: Extract<ManagedMcpAdmission, { allowed: false }>): ManagedMcpServiceError {
  return admission.detail === "not_usable"
    ? new ManagedMcpServiceError(MCP_CONNECTION_NOT_USABLE_CALL_MESSAGE, "managed_mcp_login_required", true)
    : new ManagedMcpServiceError("MCP connection is not authorized for this agent", "managed_mcp_login_required");
}

type ManagedMcpToolCaller = typeof callManagedMcpTool;
type ManagedMcpOAuthToolCaller = typeof callManagedMcpOAuthTool;

export async function executeManagedMcpCall(
  serverId: string,
  agentId: string,
  request: ManagedMcpCallRequest,
  callTool: ManagedMcpToolCaller = callManagedMcpTool,
  callOAuthTool: ManagedMcpOAuthToolCaller = callManagedMcpOAuthTool,
): Promise<ManagedMcpCallResult> {
  if (request.mcpServerId === RAFT_APPS_MCP_SERVER_ID) return executeRaftAppsTool(serverId, agentId, request, callTool, callOAuthTool);
  const agent = await requireAgent(serverId, agentId);
  const db = getDb();
  // The credential is NOT joined here: "a credential for this MCP" is the wrong question once an
  // App can have several Connections. Admission below names the one this Agent may use.
  const [row] = await db.select({ server: managedMcpServers, assignment: managedMcpAssignments })
    .from(managedMcpServers)
    .leftJoin(managedMcpAssignments, and(
      eq(managedMcpAssignments.mcpServerId, managedMcpServers.id),
      eq(managedMcpAssignments.serverId, serverId),
      eq(managedMcpAssignments.agentId, agentId),
    ))
    .where(and(
      eq(managedMcpServers.id, request.mcpServerId),
      eq(managedMcpServers.serverId, serverId),
    ))
    .limit(1);
  if (!row) throw new ManagedMcpServiceError("MCP server not found", "managed_mcp_server_not_found");
  const serverBlock = managedMcpServerCallBlock(row.server);
  if (serverBlock) throw new ManagedMcpServiceError(serverBlock.message, serverBlock.code);
  if (row.server.configVersion !== request.expectedConfigVersion) throw new ManagedMcpServiceError("MCP server configuration changed", "managed_mcp_config_stale");
  // The per-App `list_tools` / `call_tool` of an earlier snapshot: the same grant and admission checks as a real
  // tool below; the tool restriction applies to the tool `call_tool` names, in the nested call.
  const namedGeneric = genericToolKind(row.server, request.toolName);
  const generic = namedGeneric;
  if (generic === null && !row.server.toolCatalog.some((tool) => tool.name === request.toolName)) throw new ManagedMcpServiceError("MCP tool is not in the current catalog", "managed_mcp_tool_not_allowed");
  // Refused exactly where the snapshot does not offer them (an auth-less App, an Agent limited to no tools).
  if (generic !== null && !offersGenericTools(row.server, row.assignment)) throw new ManagedMcpServiceError("MCP tool is not allowed for this agent", "managed_mcp_tool_not_allowed");
  // No assignment inherits the App with its server default; explicit restrictions always govern
  // admission, including calls from older runtimes with stale snapshots.
  //
  // ⚠️ Order matters. A tool restriction and "switched off" are not Connection problems: no amount
  // of connecting widens `allowedTools` or turns the App back on, so neither may answer
  // `login_required` (which raises a Connect card that could never resolve anything).
  if (row.assignment && generic === null) {
    if (row.assignment.allowedTools !== null && !row.assignment.allowedTools.includes(request.toolName)) {
      throw new ManagedMcpServiceError("MCP tool is not allowed for this agent", "managed_mcp_tool_not_allowed");
    }
  }
  // The credential this call may use, and the ONLY one it may send. Lookups are scoped to THIS App,
  // so a pin naming another App's Connection resolves to nothing and is refused, not followed.
  // Revoked / never granted is decided here too (`admitFromRows`), before any Connection question.
  const autoGranted = await mcpAutoGrantResolver(db, serverId, agent)(row.server);
  const { block, connection: admission, boundCredential, defaultCredential } = await admitWithConnections(
    db, serverId, row.server, row.assignment, autoGranted, mcpAgentOwnerUserId(agent),
  );
  if (block) throw new ManagedMcpServiceError(block.message, block.code);
  if (!admission.allowed) throw connectionRefusal(admission);
  if (generic === "list") return listToolsResult(row.server, row.assignment);
  if (generic === "call") {
    const name = request.arguments.name;
    const args = request.arguments.arguments ?? {};
    // Names come from the App's setup and the remote server: quoted on one line (formatManagedMcpPromptName).
    const appName = formatManagedMcpPromptName(row.server.name);
    if (typeof name !== "string" || name.trim() === "") {
      throw new ManagedMcpServiceError(`${MANAGED_MCP_CALL_TOOL_TOOL} needs "name": one of ${appName}'s tools (see ${MANAGED_MCP_LIST_TOOLS_TOOL})`, "managed_mcp_tool_not_allowed", true);
    }
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      throw new ManagedMcpServiceError(`${MANAGED_MCP_CALL_TOOL_TOOL} needs "arguments" as an object`, "managed_mcp_tool_not_allowed", true);
    }
    if (!row.server.toolCatalog.some((tool) => tool.name === name)) {
      throw new ManagedMcpServiceError(`${appName} has no tool named ${formatManagedMcpPromptName(name)}; call ${RAFT_APP_TOOLS_TOOL} for its current tools`, "managed_mcp_tool_not_allowed", true);
    }
    // The named tool goes through this whole function again, as a native call would: catalogue,
    // allowedTools, grant, admission, Connection, usage audit, provider call. It is a real tool of
    // the catalogue (checked above), so it cannot be a generic tool again. A refusal is about that
    // tool, so it names it rather than `call_tool`.
    return executeManagedMcpCall(serverId, agentId, { ...request, toolName: name, arguments: args as Record<string, unknown> }, callTool, callOAuthTool)
      .catch((error: unknown) => {
        if (error instanceof ManagedMcpServiceError && error.toolName === undefined) error.toolName = name;
        throw error;
      });
  }
  // Take the credential admission NAMED; never re-derive one.
  const credential = admission.credentialId === null
    ? null
    : boundCredential?.id === admission.credentialId
      ? boundCredential
      : defaultCredential?.id === admission.credentialId ? defaultCredential : null;
  if (!credential && admission.credentialId !== null) {
    throw new ManagedMcpServiceError("MCP connection is not authorized for this agent", "managed_mcp_login_required");
  }
  await recordManagedMcpUsage({
    serverId,
    agentId,
    mcpServerId: row.server.id,
    toolName: request.toolName,
  });
  if (row.server.authMode === "oauth") {
    try {
      // Under THIS Connection's lease, with its tokens: a pinned Agent never borrows the default's.
      return await withManagedMcpOAuth(
        serverId,
        row.server.id,
        (server, provider) => callOAuthTool({
          endpoint: server.endpointUrl,
          provider,
          name: request.toolName,
          arguments: request.arguments,
        }),
        request.expectedConfigVersion,
        credential!.id,
      );
    } catch (error) {
      // The sign-in expired (refresh failed) and the Connection is now marked `expired`. To the Agent
      // this is the same Connection problem admission refuses, so it raises the same card.
      if (
        (error instanceof ManagedMcpGatewayError || error instanceof ManagedMcpOAuthError)
        && error.code === "managed_mcp_oauth_required"
      ) {
        throw new ManagedMcpServiceError("MCP connection is not authorized for this agent", "managed_mcp_login_required");
      }
      throw error;
    }
  }
  return callTool({
    endpoint: row.server.endpointUrl,
    headers: row.server.authMode === "headers" ? decryptManagedMcpHeaders(credential?.encryptedHeaders) : {},
    name: request.toolName,
    arguments: request.arguments,
  });
}

/* ------------------------------------------------------------------ Raft Apps tools */

type InventoryApp = Awaited<ReturnType<typeof listAgentMcpAppsForIntegrationInventory>>[number];

function raftAppLoginCommand(app: Pick<InventoryApp, "id">): string {
  return `raft integration login --service ${JSON.stringify(app.id)} --target <channel-or-thread>`;
}

function raftAppsResult(text: string, structuredContent: Record<string, unknown>): ManagedMcpCallResult {
  return { content: [{ type: "text", text }], isError: false, structuredContent };
}

/** `raft_apps_list`: the `raft integration list` inventory, with the next step for each App. */
function raftAppsListResult(apps: readonly InventoryApp[]): ManagedMcpCallResult {
  if (apps.length === 0) {
    return raftAppsResult("No MCP Apps are available to you on this Raft Server. There is nothing to request.", { apps: [] });
  }
  const rows = apps.map((app) => {
    const granted = app.grant === undefined || app.grant === "granted";
    const next = app.state === "disabled"
      ? "switched off on this Server; a Server owner/admin can switch it on"
      : granted && app.state === "ready"
        ? `ready: call its tools (or ${RAFT_APP_CALL_TOOL})`
        : `${granted ? "not connected for you yet" : "you do not have it yet"}: run \`${raftAppLoginCommand(app)}\` to ask a person for it`
          + (granted ? `, or call one of its tools (or ${RAFT_APP_CALL_TOOL}) from a conversation, which asks there` : "");
    return { id: app.id, name: app.name, description: app.description, grant: app.grant ?? "granted", state: app.state, toolCount: app.toolCount, next };
  });
  const text = `${rows.length} MCP App${rows.length === 1 ? "" : "s"} on this Raft Server:\n`
    + rows.map((row) => `- ${formatManagedMcpPromptName(row.name)} (id ${row.id}): ${row.toolCount} tool${row.toolCount === 1 ? "" : "s"}; ${row.next}`).join("\n");
  return raftAppsResult(text, { apps: rows });
}

/** The `app` argument: an id, or an exact name; an ambiguous name lists the ids it could mean. */
function resolveRaftApp(apps: readonly InventoryApp[], value: unknown): InventoryApp {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ManagedMcpServiceError(`"app" is required: an App id or exact name from ${RAFT_APPS_LIST_TOOL}`, "managed_mcp_tool_not_allowed");
  }
  const wanted = value.trim();
  const byId = apps.find((app) => app.id === wanted);
  if (byId) return byId;
  const byName = apps.filter((app) => app.name === wanted);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    throw new ManagedMcpServiceError(`Several MCP Apps are named "${wanted}"; name one by id: ${byName.map((app) => app.id).join(", ")}`, "managed_mcp_tool_not_allowed");
  }
  throw new ManagedMcpServiceError(
    apps.length === 0
      ? "No MCP Apps are available to you on this Raft Server. There is nothing to request."
      : `No MCP App "${wanted}" is available to you; call ${RAFT_APPS_LIST_TOOL} for the ones that are`,
    "managed_mcp_server_not_found",
  );
}

/**
 * The checks a call to the App would pass before its tool is looked at: the App is on, this Agent
 * has it (`admitFromRows` grant), and a Connection admits it. Throws what that call would throw.
 */
async function admitAgentForApp(serverId: string, agentId: string, appId: string) {
  const agent = await requireAgent(serverId, agentId);
  const db = getDb();
  const [row] = await db.select({ server: managedMcpServers, assignment: managedMcpAssignments })
    .from(managedMcpServers)
    .leftJoin(managedMcpAssignments, and(
      eq(managedMcpAssignments.mcpServerId, managedMcpServers.id),
      eq(managedMcpAssignments.serverId, serverId),
      eq(managedMcpAssignments.agentId, agentId),
    ))
    .where(and(eq(managedMcpServers.id, appId), eq(managedMcpServers.serverId, serverId)))
    .limit(1);
  if (!row) throw new ManagedMcpServiceError("MCP server not found", "managed_mcp_server_not_found");
  const autoGranted = await mcpAutoGrantResolver(db, serverId, agent)(row.server);
  const { block, connection } = await admitWithConnections(db, serverId, row.server, row.assignment, autoGranted, mcpAgentOwnerUserId(agent));
  if (block) throw new ManagedMcpServiceError(block.message, block.code);
  if (!connection.allowed) throw connectionRefusal(connection);
  return row;
}

async function executeRaftAppsTool(
  serverId: string,
  agentId: string,
  request: ManagedMcpCallRequest,
  callTool: ManagedMcpToolCaller,
  callOAuthTool: ManagedMcpOAuthToolCaller,
): Promise<ManagedMcpCallResult> {
  await requireAgent(serverId, agentId);
  const apps = await listAgentMcpAppsForIntegrationInventory(serverId, agentId);
  if (request.toolName === RAFT_APPS_LIST_TOOL) return raftAppsListResult(apps);
  if (request.toolName !== RAFT_APP_TOOLS_TOOL && request.toolName !== RAFT_APP_CALL_TOOL) {
    throw new ManagedMcpServiceError(`There is no Raft Apps tool named "${request.toolName}"`, "managed_mcp_tool_not_allowed");
  }
  const app = resolveRaftApp(apps, request.arguments.app);
  try {
    let row: Awaited<ReturnType<typeof admitAgentForApp>>;
    try {
      row = await admitAgentForApp(serverId, agentId, app.id);
    } catch (error) {
      // Not this Agent's App: no card (connecting would not grant it); say how to ask for it.
      if (error instanceof ManagedMcpServiceError && error.code === "managed_mcp_app_off") {
        throw new ManagedMcpServiceError(
          `You do not have the MCP App ${formatManagedMcpPromptName(app.name)} (${app.grant === "revoked" ? "revoked" : "not granted"}). Ask a person for it: ${raftAppLoginCommand(app)}`,
          "managed_mcp_app_off",
        );
      }
      throw error;
    }
    if (request.toolName === RAFT_APP_TOOLS_TOOL) return listToolsResult(row.server, row.assignment);
    const name = request.arguments.name;
    const args = request.arguments.arguments ?? {};
    if (typeof name !== "string" || name.trim() === "") {
      throw new ManagedMcpServiceError(`${RAFT_APP_CALL_TOOL} needs "name": one of ${formatManagedMcpPromptName(app.name)}'s tools (see ${RAFT_APP_TOOLS_TOOL})`, "managed_mcp_tool_not_allowed", true);
    }
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      throw new ManagedMcpServiceError(`${RAFT_APP_CALL_TOOL} needs "arguments" as an object`, "managed_mcp_tool_not_allowed", true);
    }
    if (!row.server.toolCatalog.some((tool) => tool.name === name)) {
      throw new ManagedMcpServiceError(`${formatManagedMcpPromptName(app.name)} has no tool named ${formatManagedMcpPromptName(name)}; call ${RAFT_APP_TOOLS_TOOL} for its current tools`, "managed_mcp_tool_not_allowed", true);
    }
    // The named tool takes the whole native path again: catalogue, allowedTools, grant, admission,
    // Connection, usage audit, provider call. It is a real catalogue tool, so it is never re-routed.
    return await executeManagedMcpCall(serverId, agentId, {
      ...request,
      mcpServerId: app.id,
      toolName: name,
      arguments: args as Record<string, unknown>,
      expectedConfigVersion: row.server.configVersion,
      expectedAssignmentVersion: row.assignment?.assignmentVersion ?? 1,
    }, callTool, callOAuthTool);
  } catch (error) {
    // Refusals about the App go back as the App's: the route raises its Connect card.
    if (error instanceof ManagedMcpServiceError && !error.app) {
      const [current] = await getDb().select({ configVersion: managedMcpServers.configVersion }).from(managedMcpServers)
        .where(eq(managedMcpServers.id, app.id)).limit(1);
      error.app = { id: app.id, configVersion: current?.configVersion ?? 1 };
    }
    throw error;
  }
}
