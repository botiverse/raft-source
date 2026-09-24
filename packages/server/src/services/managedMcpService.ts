import { and, asc, eq, sql } from "drizzle-orm";
import {
  currentDate,
  MANAGED_MCP_TRANSPORT,
  formatManagedMcpRuntimeToolName,
  type ManagedMcpAgentCatalogResponse,
  type ManagedMcpAuthMode,
  type ManagedMcpCallRequest,
  type ManagedMcpCallResult,
  type ManagedMcpCredentialPatch,
  type ManagedMcpProvider,
  type ManagedMcpRuntimeSnapshot,
  type ManagedMcpServerView,
  type ManagedMcpToolCatalogEntry,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import {
  agents,
  integrationAuditEvents,
  managedMcpAssignments,
  managedMcpCredentials,
  managedMcpOAuthAttempts,
  managedMcpServers,
} from "../db/schema.js";
import {
  decryptManagedMcpHeaders,
  encryptManagedMcpHeaders,
  normalizeManagedMcpHeaders,
} from "./managedMcpCredentialService.js";
import {
  callManagedMcpTool,
  callManagedMcpOAuthTool,
  listManagedMcpOAuthTools,
  listManagedMcpTools,
  ManagedMcpGatewayError,
  validateManagedMcpEndpoint,
} from "./managedMcpGateway.js";
import { recordIntegrationAuditEvent } from "./integrationAuditService.js";
import { withManagedMcpOAuth } from "./managedMcpOAuthService.js";

export class ManagedMcpServiceError extends Error {
  constructor(
    message: string,
    readonly code:
      | "managed_mcp_agent_not_found"
      | "managed_mcp_server_not_found"
      | "managed_mcp_assignment_not_found"
      | "managed_mcp_assignment_stale"
      | "managed_mcp_config_stale"
      | "managed_mcp_server_disabled"
      | "managed_mcp_auth_invalid"
      | "managed_mcp_tool_not_allowed",
  ) {
    super(message);
    this.name = "ManagedMcpServiceError";
  }
}

const RECOMMENDATIONS: ManagedMcpAgentCatalogResponse["recommendations"] = [
  {
    id: "notion",
    name: "Notion",
    description: "Search and update the Notion workspace you authorize.",
    provider: "notion",
    authMode: "oauth",
    endpointUrl: "https://mcp.notion.com/mcp",
    credentialHeaderNames: [],
  },
  {
    id: "linear",
    name: "Linear",
    description: "Find, create, and update Linear issues, projects, and comments.",
    provider: "linear",
    authMode: "oauth",
    endpointUrl: "https://mcp.linear.app/mcp",
    credentialHeaderNames: [],
  },
];

const PROVIDER_ENDPOINTS: Partial<Record<ManagedMcpProvider, string>> = {
  notion: "https://mcp.notion.com/mcp",
  linear: "https://mcp.linear.app/mcp",
};

type ServerRow = typeof managedMcpServers.$inferSelect;
type AssignmentRow = typeof managedMcpAssignments.$inferSelect;
type CredentialRow = typeof managedMcpCredentials.$inferSelect;
type UsageRow = {
  invocationCount: number;
  lastInvokedAt: Date;
  lastToolName: string;
};

function serializeServer(
  row: ServerRow,
  assignment: AssignmentRow | null,
  credential: CredentialRow | null,
  usage: UsageRow | null = null,
): ManagedMcpServerView {
  const publicEndpointUrl = new URL(row.endpointUrl);
  publicEndpointUrl.search = "";
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    provider: row.provider,
    authMode: row.authMode,
    oauthStatus: row.oauthStatus,
    transport: MANAGED_MCP_TRANSPORT,
    endpointUrl: publicEndpointUrl.toString(),
    enabled: row.enabled,
    configVersion: row.configVersion,
    catalogVersion: row.catalogVersion,
    toolCatalog: row.toolCatalog,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    lastCheckError: row.lastCheckError,
    credentialHeaderNames: credential?.headerNames ?? [],
    hasCredentials: Boolean(credential?.encryptedHeaders || credential?.encryptedOAuth),
    assignment: assignment ? {
      enabled: assignment.enabled,
      allowedTools: assignment.allowedTools,
      version: assignment.assignmentVersion,
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

async function requireAgent(serverId: string, agentId: string) {
  const [agent] = await getDb()
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.serverId, serverId)))
    .limit(1);
  if (!agent) throw new ManagedMcpServiceError("Agent not found", "managed_mcp_agent_not_found");
}

async function loadServer(serverId: string, mcpServerId: string): Promise<ServerRow> {
  const [row] = await getDb()
    .select()
    .from(managedMcpServers)
    .where(and(eq(managedMcpServers.id, mcpServerId), eq(managedMcpServers.serverId, serverId)))
    .limit(1);
  if (!row) throw new ManagedMcpServiceError("MCP server not found", "managed_mcp_server_not_found");
  return row;
}

async function loadCredentials(serverId: string, mcpServerId: string): Promise<CredentialRow | null> {
  const [row] = await getDb()
    .select()
    .from(managedMcpCredentials)
    .where(and(eq(managedMcpCredentials.serverId, serverId), eq(managedMcpCredentials.mcpServerId, mcpServerId)))
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

function validateManagedMcpConfiguredEndpoint(raw: string): URL {
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

function normalizeConnection(input: {
  provider: ManagedMcpProvider;
  authMode: ManagedMcpAuthMode;
  endpointUrl: string;
  headers?: Record<string, string>;
}): { endpointUrl: string; preparedHeaders: Pick<CredentialRow, "encryptedHeaders" | "headerNames"> | null } {
  if (input.provider !== "custom" && input.authMode !== "oauth") {
    throw new ManagedMcpServiceError("Notion and Linear connections require OAuth", "managed_mcp_auth_invalid");
  }
  const fixedEndpoint = PROVIDER_ENDPOINTS[input.provider];
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

function assertAssignmentCanBeEnabled(server: ServerRow, enabled: boolean): void {
  if (enabled && server.authMode === "oauth" && server.oauthStatus !== "connected") {
    throw new ManagedMcpServiceError("OAuth MCP connections must be connected before assignment", "managed_mcp_auth_invalid");
  }
}

export async function listAgentManagedMcpCatalog(serverId: string, agentId: string): Promise<ManagedMcpAgentCatalogResponse> {
  await requireAgent(serverId, agentId);
  const [rows, usageRows] = await Promise.all([
    getDb()
      .select({
        server: managedMcpServers,
        assignment: managedMcpAssignments,
        credential: managedMcpCredentials,
      })
      .from(managedMcpServers)
      .leftJoin(managedMcpAssignments, and(
        eq(managedMcpAssignments.mcpServerId, managedMcpServers.id),
        eq(managedMcpAssignments.agentId, agentId),
      ))
      .leftJoin(managedMcpCredentials, eq(managedMcpCredentials.mcpServerId, managedMcpServers.id))
      .where(eq(managedMcpServers.serverId, serverId))
      .orderBy(asc(managedMcpServers.name)),
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
    servers: rows.map((row) => serializeServer(
      row.server,
      row.assignment,
      row.credential,
      usageByMcpServerId.get(row.server.id) ?? null,
    )),
    recommendations: RECOMMENDATIONS,
  };
}

export async function listManagedMcpServerCatalog(serverId: string): Promise<ManagedMcpAgentCatalogResponse> {
  const rows = await getDb()
    .select({ server: managedMcpServers, credential: managedMcpCredentials })
    .from(managedMcpServers)
    .leftJoin(managedMcpCredentials, eq(managedMcpCredentials.mcpServerId, managedMcpServers.id))
    .where(eq(managedMcpServers.serverId, serverId))
    .orderBy(asc(managedMcpServers.name));
  return {
    servers: rows.map((row) => serializeServer(row.server, null, row.credential)),
    recommendations: RECOMMENDATIONS,
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
  const { endpointUrl, preparedHeaders } = normalizeConnection({ ...input, provider, authMode });
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
    }).returning())[0];
    return { row, credential };
  });
  return serializeServer(result.row, null, result.credential);
}

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
}): Promise<ManagedMcpServerView> {
  const current = await loadServer(input.serverId, input.mcpServerId);
  const provider = input.provider ?? current.provider;
  if (input.headers !== undefined && input.credentialPatch !== undefined) {
    throw new ManagedMcpServiceError("Provide headers or credentialPatch, not both", "managed_mcp_auth_invalid");
  }
  const authMode = input.authMode ?? (input.headers !== undefined || input.credentialPatch !== undefined ? "headers" : current.authMode);
  const nextEndpointUrl = input.endpointUrl === undefined
    ? current.endpointUrl
    : validateManagedMcpConfiguredEndpoint(input.endpointUrl).toString();
  const originChanged = endpointOrigin(nextEndpointUrl) !== endpointOrigin(current.endpointUrl);
  const needsCurrentHeaders = input.credentialPatch !== undefined
    || (originChanged && authMode === "headers" && input.headers === undefined);
  const currentHeaders = needsCurrentHeaders
    ? decryptManagedMcpHeaders((await loadCredentials(input.serverId, input.mcpServerId))?.encryptedHeaders)
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
  const normalized = connectionChanged ? normalizeConnection({
    provider,
    authMode,
    endpointUrl: nextEndpointUrl,
    ...(input.headers !== undefined ? { headers: input.headers } : patchedHeaders !== undefined ? { headers: patchedHeaders } : {}),
  }) : null;
  const endpointUrl = normalized?.endpointUrl;
  const preparedHeaders = normalized?.preparedHeaders ?? null;
  const catalogInvalidated = connectionChanged;
  const result = await getDb().transaction(async (tx) => {
    const [row] = await tx.update(managedMcpServers).set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.provider !== undefined ? { provider } : {}),
      ...(input.authMode !== undefined ? { authMode } : {}),
      ...(endpointUrl !== undefined ? { endpointUrl } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(runtimeChanged ? { configVersion: sql`${managedMcpServers.configVersion} + 1` } : {}),
      ...(catalogInvalidated ? {
        oauthStatus: authMode === "oauth" ? "disconnected" : "connected",
        toolCatalog: [],
        catalogVersion: sql`${managedMcpServers.catalogVersion} + 1`,
        lastCheckedAt: null,
        lastCheckError: null,
      } : {}),
      updatedByUserId: input.userId,
      updatedAt: currentDate(),
    }).where(and(eq(managedMcpServers.id, input.mcpServerId), eq(managedMcpServers.serverId, input.serverId))).returning();
    if (runtimeChanged) {
      await tx
        .update(managedMcpOAuthAttempts)
        .set({ status: "failed" })
        .where(
          and(
            eq(managedMcpOAuthAttempts.serverId, input.serverId),
            eq(managedMcpOAuthAttempts.mcpServerId, input.mcpServerId),
            eq(managedMcpOAuthAttempts.status, "pending"),
          ),
        );
    }
    let credential: CredentialRow | null = null;
    if (connectionChanged && authMode === "none") {
      await tx.delete(managedMcpCredentials).where(eq(managedMcpCredentials.mcpServerId, input.mcpServerId));
    } else if (connectionChanged) {
      const clearOAuth = authMode !== "oauth" || identityChanged;
      const clearHeaders = authMode !== "headers";
      credential = (await tx.insert(managedMcpCredentials).values({
        serverId: input.serverId,
        mcpServerId: input.mcpServerId,
        ...(preparedHeaders ?? {}),
      }).onConflictDoUpdate({
        target: managedMcpCredentials.mcpServerId,
        set: {
          ...(preparedHeaders ?? {}),
          ...(clearHeaders ? { encryptedHeaders: null, headerNames: [] } : {}),
          ...(clearOAuth ? { encryptedOAuth: null } : {}),
          ...(identityChanged ? { leaseOwner: null, leaseExpiresAt: null } : {}),
          credentialVersion: sql`${managedMcpCredentials.credentialVersion} + 1`,
          updatedAt: currentDate(),
        },
      }).returning())[0];
    }
    return { row, credential };
  });
  return serializeServer(
    result.row,
    null,
    result.credential ?? await loadCredentials(input.serverId, input.mcpServerId),
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
  const credential = await loadCredentials(serverId, mcpServerId);
  const configFence = and(
    eq(managedMcpServers.id, server.id),
    eq(managedMcpServers.serverId, server.serverId),
    eq(managedMcpServers.configVersion, server.configVersion),
    eq(managedMcpServers.provider, server.provider),
    eq(managedMcpServers.authMode, server.authMode),
    eq(managedMcpServers.endpointUrl, server.endpointUrl),
  );
  try {
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

export async function setManagedMcpAssignment(input: {
  serverId: string;
  userId: string;
  agentId: string;
  mcpServerId: string;
  enabled: boolean;
  allowedTools: string[] | null;
}): Promise<ManagedMcpServerView> {
  const [, server] = await Promise.all([requireAgent(input.serverId, input.agentId), loadServer(input.serverId, input.mcpServerId)]);
  assertAssignmentCanBeEnabled(server, input.enabled);
  if (input.allowedTools !== null) {
    const catalogNames = new Set(server.toolCatalog.map((tool) => tool.name));
    if (input.allowedTools.some((toolName) => !catalogNames.has(toolName))) {
      throw new ManagedMcpServiceError("Assignment contains a tool outside the current catalog", "managed_mcp_tool_not_allowed");
    }
  }
  const [assignment] = await getDb().insert(managedMcpAssignments).values({
    serverId: input.serverId,
    agentId: input.agentId,
    mcpServerId: input.mcpServerId,
    enabled: input.enabled,
    allowedTools: input.allowedTools,
    updatedByUserId: input.userId,
  }).onConflictDoUpdate({
    target: [managedMcpAssignments.agentId, managedMcpAssignments.mcpServerId],
    set: {
      enabled: input.enabled,
      allowedTools: input.allowedTools,
      assignmentVersion: sql`${managedMcpAssignments.assignmentVersion} + 1`,
      updatedByUserId: input.userId,
      updatedAt: currentDate(),
    },
  }).returning();
  return serializeServer(await loadServer(input.serverId, input.mcpServerId), assignment, await loadCredentials(input.serverId, input.mcpServerId));
}

export interface ManagedMcpAssignmentUpdate {
  mcpServerId: string;
  enabled: boolean;
  allowedTools: string[] | null;
}

export async function applyManagedMcpAssignments(input: {
  serverId: string;
  userId: string;
  agentId: string;
  assignments: ManagedMcpAssignmentUpdate[];
}): Promise<ManagedMcpAgentCatalogResponse> {
  await requireAgent(input.serverId, input.agentId);
  const uniqueIds = new Set(input.assignments.map((assignment) => assignment.mcpServerId));
  if (uniqueIds.size !== input.assignments.length) {
    throw new ManagedMcpServiceError("MCP assignment updates must be unique", "managed_mcp_assignment_stale");
  }

  const servers = await Promise.all(input.assignments.map((assignment) => loadServer(input.serverId, assignment.mcpServerId)));
  input.assignments.forEach((assignment, index) => {
    assertAssignmentCanBeEnabled(servers[index], assignment.enabled);
    if (assignment.allowedTools === null) return;
    const catalogNames = new Set(servers[index].toolCatalog.map((tool) => tool.name));
    if (assignment.allowedTools.some((toolName) => !catalogNames.has(toolName))) {
      throw new ManagedMcpServiceError("Assignment contains a tool outside the current catalog", "managed_mcp_tool_not_allowed");
    }
  });

  await getDb().transaction(async (tx) => {
    for (const assignment of input.assignments) {
      await tx.insert(managedMcpAssignments).values({
        serverId: input.serverId,
        agentId: input.agentId,
        mcpServerId: assignment.mcpServerId,
        enabled: assignment.enabled,
        allowedTools: assignment.allowedTools,
        updatedByUserId: input.userId,
      }).onConflictDoUpdate({
        target: [managedMcpAssignments.agentId, managedMcpAssignments.mcpServerId],
        set: {
          enabled: assignment.enabled,
          allowedTools: assignment.allowedTools,
          assignmentVersion: sql`${managedMcpAssignments.assignmentVersion} + 1`,
          updatedByUserId: input.userId,
          updatedAt: currentDate(),
        },
      });
    }
  });

  return listAgentManagedMcpCatalog(input.serverId, input.agentId);
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
    ? decryptManagedMcpHeaders((await loadCredentials(input.serverId, input.mcpServerId))?.encryptedHeaders)
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

export async function getManagedMcpRuntimeSnapshot(serverId: string, agentId: string): Promise<ManagedMcpRuntimeSnapshot> {
  await requireAgent(serverId, agentId);
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
  return {
    catalogVersion: 1,
    tools: rows.flatMap(({ server, assignment }) => {
      if (server.authMode === "oauth" && server.oauthStatus !== "connected") return [];
      if (assignment && !assignment.enabled) return [];
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
    }),
  };
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

type ManagedMcpToolCaller = typeof callManagedMcpTool;
type ManagedMcpOAuthToolCaller = typeof callManagedMcpOAuthTool;

export async function executeManagedMcpCall(
  serverId: string,
  agentId: string,
  request: ManagedMcpCallRequest,
  callTool: ManagedMcpToolCaller = callManagedMcpTool,
  callOAuthTool: ManagedMcpOAuthToolCaller = callManagedMcpOAuthTool,
): Promise<ManagedMcpCallResult> {
  await requireAgent(serverId, agentId);
  const [row] = await getDb().select({ server: managedMcpServers, credential: managedMcpCredentials, assignment: managedMcpAssignments })
    .from(managedMcpServers)
    .leftJoin(managedMcpAssignments, and(
      eq(managedMcpAssignments.mcpServerId, managedMcpServers.id),
      eq(managedMcpAssignments.serverId, serverId),
      eq(managedMcpAssignments.agentId, agentId),
    ))
    .leftJoin(managedMcpCredentials, eq(managedMcpCredentials.mcpServerId, managedMcpServers.id))
    .where(and(
      eq(managedMcpServers.id, request.mcpServerId),
      eq(managedMcpServers.serverId, serverId),
    ))
    .limit(1);
  if (!row) throw new ManagedMcpServiceError("MCP server not found", "managed_mcp_server_not_found");
  if (!row.server.enabled) throw new ManagedMcpServiceError("MCP server is disabled", "managed_mcp_server_disabled");
  if (row.server.authMode === "oauth" && row.server.oauthStatus !== "connected") {
    throw new ManagedMcpServiceError("MCP OAuth connection is not connected", "managed_mcp_auth_invalid");
  }
  if (row.server.configVersion !== request.expectedConfigVersion) throw new ManagedMcpServiceError("MCP server configuration changed", "managed_mcp_config_stale");
  if (!row.server.toolCatalog.some((tool) => tool.name === request.toolName)) throw new ManagedMcpServiceError("MCP tool is not in the current catalog", "managed_mcp_tool_not_allowed");
  // No assignment inherits the server catalog; explicit restrictions always
  // govern admission, including calls from older runtimes with stale snapshots.
  if (row.assignment && (!row.assignment.enabled || (row.assignment.allowedTools !== null && !row.assignment.allowedTools.includes(request.toolName)))) {
    throw new ManagedMcpServiceError("MCP tool is not allowed for this agent", "managed_mcp_tool_not_allowed");
  }
  await recordManagedMcpUsage({
    serverId,
    agentId,
    mcpServerId: row.server.id,
    toolName: request.toolName,
  });
  if (row.server.authMode === "oauth") {
    return withManagedMcpOAuth(
      serverId,
      row.server.id,
      (server, provider) => callOAuthTool({
        endpoint: server.endpointUrl,
        provider,
        name: request.toolName,
        arguments: request.arguments,
      }),
      request.expectedConfigVersion,
    );
  }
  return callTool({
    endpoint: row.server.endpointUrl,
    headers: row.server.authMode === "headers" ? decryptManagedMcpHeaders(row.credential?.encryptedHeaders) : {},
    name: request.toolName,
    arguments: request.arguments,
  });
}
