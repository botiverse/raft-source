/**
 * MCP Apps: create / read / update / delete an App backed by an MCP server.
 *
 * `appId` is `managed_mcp_servers.id`, the identity the Agent API, the runtime snapshot and the
 * action cards already use. The generic App root (`raft_apps`, via `app_mcp_profiles`) is returned
 * as `rootAppId` when the migration trigger has written one.
 */
import { mcpAgentGrantAllows, mcpAutoGrantCoversAgent } from "./managedMcpAgentGrant";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import {
  canonicalizeOAuthClientCategory,
  currentDate,
  MANAGED_MCP_TRANSPORT,
  managedMcpOAuthClientPolicy,
  type ManagedMcpAuthMode,
  type ManagedMcpOAuthClientMode,
  type ManagedMcpToolCatalogEntry,
  type AppAgentAccess,
  type McpAppListItem,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import {
  actionCards,
  agents,
  appMcpProfiles,
  managedMcpAssignments,
  managedMcpCredentials,
  managedMcpOAuthAttempts,
  managedMcpServers,
} from "../db/schema";
import { actorHasServerCapabilityInServer } from "../lib/actorPermissions";
import { listedServerAgent } from "./agentMemberListPolicy";
import { ManagedMcpGatewayError, validateManagedMcpEndpoint } from "./managedMcpGateway";
import { listManagedMcpConnections, type ManagedMcpConnectionView } from "./managedMcpConnectionService";
import { availableRaftOAuthClientKind } from "./managedMcpRaftOAuthClient";
import { managedMcpOAuthClientModeForApp } from "./managedMcpOAuthClientMode";
import {
  admitFromRows,
  applyMcpAppServerChange,
  assertTemplateFieldsUnchanged,
  deleteManagedMcpServer,
  insertMcpAppRow,
  loadPersonalGrants,
  ManagedMcpServiceError,
  mcpAppSourceKind,
  publicManagedMcpEndpoint,
  rethrowIfMcpAppNameTaken,
  recordMcpServerVouchEvent,
  refreshManagedMcpCatalog,
  validateManagedMcpConfiguredEndpoint,
} from "./managedMcpService";
import { probeManagedMcpEndpointWithCatalog, type McpProbeResult } from "./managedMcpProbe";
import { mcpPersonalAccountsEnabled } from "./managedMcpPersonalAccounts";
import { findActiveMcpAppTemplate, findMcpAppTemplate, mcpAppTemplatePublisherNames } from "./mcpAppTemplates";
import { normalizeWhenToUse, storeIntegrationLogo } from "./oauthService";
import { getCdnStorage, getStorage } from "./storageService";
import { clientLogoUrl } from "../config/privacyMode";

type AppRow = typeof managedMcpServers.$inferSelect;
type CredentialAuthStatus = (typeof managedMcpCredentials.$inferSelect)["authStatus"];
type Prober = typeof probeManagedMcpEndpointWithCatalog;

const LEGACY_PROVIDERS = new Set(["notion", "linear"]);

export interface McpAppProfileInput {
  name?: string;
  description?: string | null;
  homepageUrl?: string | null;
  category?: string | null;
  whenToUse?: string | null;
}

export interface McpAppView {
  id: string;
  rootAppId: string | null;
  kind: "mcp";
  sections: Array<"profile" | "mcp_server" | "connections" | "agents" | "distribution" | "danger">;
  profile: { name: string; description: string | null; homepageUrl: string | null; logoUrl: string | null; category: string | null; whenToUse: string | null };
  source: McpAppListItem["source"];
  server: {
    endpointUrl: string;
    transport: typeof MANAGED_MCP_TRANSPORT;
    authKind: ManagedMcpAuthMode;
    requiredHeaderNames: string[];
    serverInfo: AppRow["serverInfo"];
    authProbe: AppRow["authProbe"];
    /** This deployment has Raft's own OAuth client for this provider: Connections can sign in without one of their own. */
    raftOAuthClient: boolean;
    /** How Connections get an OAuth client: automatic registration, a registered client, or either; null while the template's mode cannot be confirmed (sign-in is refused). */
    oauthClientMode: ManagedMcpOAuthClientMode | null;
    health: { status: "reachable" | "unreachable" | "unknown"; checkedAt: string | null; error: string | null; latencyMs: number | null };
    toolCount: number;
    /** `annotations`: the tool's boolean hints, absent when it declared none. */
    tools: Array<{ name: string; title?: string; description?: string; annotations?: NonNullable<ManagedMcpToolCatalogEntry["annotations"]> }>;
    enabled: boolean;
  };
  /**
   * Every Connection for a viewer who manages integrations (with `ownerKind` and `owner`); for
   * anyone else only their own personal Connections (RFC 087 §7.2).
   */
  connections: ManagedMcpConnectionView[];
  /**
   * "Members can connect their own account" (D1), for every viewer. False while the Server flag
   * `mcp_personal_accounts` is off, whatever is stored (the toggle is not offered then).
   */
  membersCanConnect: boolean;
  /** `mcp_personal_accounts` on for this Server: whether the toggle and personal sign-in exist here. */
  personalAccounts: boolean;
  /**
   * The account each of the viewer's own Agents (created by them, or their personal assistant) uses
   * for this App now (R15: kind and label): null when it is refused. `connectionId` only when the
   * viewer may see it (a manager, or their own personal Connection).
   */
  myAgents: Array<{ agentId: string; account: McpAgentAccountView | null }>;
  defaultConnectionId: string | null;
  /** `noConnection`: pinned to a Connection that was deleted or is no longer usable by that Agent (refused until one is chosen). */
  agentsSummary: { total: number; usingDefault: number; pinned: number; noConnection: number; off: number; actionNeeded: number };
  /** Which listed agents have the App (the same rule as agentsSummary; "off" ones are excepted). */
  agentAccess: AppAgentAccess;
  /**
   * The Server vouched for the App (`server_vouched_at`): every agent here is granted it
   * automatically (mcpAutoGrantCoversAgent), whoever created it. Shown to every viewer, like
   * agentAccess; only an owner or admin changes it (PUT /api/mcp/apps/:appId/server-vouch).
   */
  serverVouched: boolean;
  serverVouchedAt: string | null;
  distribution: { kind: "server_local"; publishStatus: "private" };
  viewer: { canManage: boolean };
}

export interface McpAgentAccountView {
  kind: "personal" | "shared";
  connectionId?: string;
  name: string | null;
  label: string | null;
  /** A personal account's owner. */
  ownerUserId?: string;
}

/** `publishers`: mcpAppTemplatePublisherNames(), read once per request. */
function sourceOf(app: AppRow, publishers: ReadonlyMap<string, string | null>): McpAppView["source"] {
  const kind = mcpAppSourceKind(app);
  const templateKey = app.templateKey ?? (kind === "template" ? app.provider : null);
  const publisherName = kind === "template" && templateKey ? publishers.get(templateKey) ?? null : null;
  return { kind, templateKey, maintainedByRaft: kind === "template", publisherName };
}

const TOOL_HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

/** The boolean hints a tool declared, or null when it declared none. */
function toolAnnotations(tool: ManagedMcpToolCatalogEntry): NonNullable<ManagedMcpToolCatalogEntry["annotations"]> | null {
  const hints: NonNullable<ManagedMcpToolCatalogEntry["annotations"]> = {};
  for (const hint of TOOL_HINTS) {
    const value = tool.annotations?.[hint];
    if (typeof value === "boolean") hints[hint] = value;
  }
  return Object.keys(hints).length > 0 ? hints : null;
}

function healthOf(app: AppRow): McpAppView["server"]["health"] {
  return {
    status: app.lastCheckError ? "unreachable" : app.lastCheckedAt ? "reachable" : "unknown",
    checkedAt: app.lastCheckedAt?.toISOString() ?? null,
    error: app.lastCheckError,
    latencyMs: app.lastLatencyMs,
  };
}

async function loadApp(serverId: string, appId: string): Promise<AppRow> {
  const [app] = await getDb()
    .select()
    .from(managedMcpServers)
    .where(and(eq(managedMcpServers.id, appId), eq(managedMcpServers.serverId, serverId)))
    .limit(1);
  if (!app) throw new ManagedMcpServiceError("MCP App not found", "managed_mcp_server_not_found");
  return app;
}

async function openCardCounts(serverId: string): Promise<Map<string, number>> {
  const rows = await getDb()
    .select({ mcpServerId: sql<string>`${actionCards.payload} ->> 'mcpServerId'`, count: sql<number>`count(*)::int` })
    .from(actionCards)
    .where(and(
      eq(actionCards.serverId, serverId),
      eq(actionCards.actionType, "integration:connect_mcp"),
      eq(actionCards.state, "prepared"),
    ))
    .groupBy(sql`${actionCards.payload} ->> 'mcpServerId'`);
  return new Map(rows.map((row) => [row.mcpServerId, row.count]));
}

/**
 * agentsSummary and agentAccess from one read of the Server's agents (and one of the App's personal
 * grants). Whether an Agent has the App is the call path's grant (`admitFromRows`): a member's
 * personal grant counts, an explicit off beats it. The summary's modes describe the admin layer.
 */
async function agentsUse(serverId: string, app: AppRow, actionNeeded: number): Promise<Pick<McpAppView, "agentsSummary" | "agentAccess">> {
  const personalGrantByAgent = new Map((await loadPersonalGrants(getDb(), serverId, { mcpServerId: app.id })).map((grant) => [grant.agentId, grant]));
  const rows = await getDb()
    .select({
      id: agents.id,
      // agentAccess names only the agents member lists show: never someone's personal assistant.
      listed: listedServerAgent(),
      enabled: managedMcpAssignments.enabled,
      connectionMode: managedMcpAssignments.connectionMode,
      boundConnectionId: managedMcpAssignments.boundConnectionId,
      creatorType: agents.creatorType,
      creatorId: agents.creatorId,
    })
    .from(agents)
    .leftJoin(managedMcpAssignments, and(eq(managedMcpAssignments.agentId, agents.id), eq(managedMcpAssignments.mcpServerId, app.id)))
    .where(and(eq(agents.serverId, serverId), isNull(agents.deletedAt)))
    .orderBy(asc(agents.createdAt), asc(agents.id));
  const connections = new Map((await getDb()
    .select({ id: managedMcpCredentials.id, ownerKind: managedMcpCredentials.ownerKind })
    .from(managedMcpCredentials)
    .where(and(eq(managedMcpCredentials.serverId, serverId), eq(managedMcpCredentials.mcpServerId, app.id))))
    .map((connection) => [connection.id, connection]));
  const summary = { total: rows.length, usingDefault: 0, pinned: 0, noConnection: 0, off: 0, actionNeeded };
  const agentIds: string[] = [];
  const exceptAgentIds: string[] = [];
  for (const row of rows) {
    // "Off" is every Agent that does not have the App: revoked, or never granted (automatically, by a
    // person, or with a member's own account).
    const assignment = row.enabled === null || row.connectionMode === null
      ? null
      : { enabled: row.enabled, connectionMode: row.connectionMode, boundConnectionId: row.boundConnectionId };
    const { grant } = admitFromRows({
      server: app,
      assignment,
      autoGranted: mcpAutoGrantCoversAgent(app, row),
      personalGrant: personalGrantByAgent.get(row.id) ?? null,
      boundCredential: null,
      defaultCredential: null,
    });
    const allowed = mcpAgentGrantAllows(grant);
    if (row.listed) (allowed ? agentIds : exceptAgentIds).push(row.id);
    if (!allowed) summary.off += 1;
    else if (row.connectionMode === "pinned") {
      // The same rule as the Agent's own view and the call path: a shared Connection of this App.
      const bound = row.boundConnectionId ? connections.get(row.boundConnectionId) ?? null : null;
      if (bound?.ownerKind === "shared") summary.pinned += 1;
      else summary.noConnection += 1;
    } else summary.usingDefault += 1;
  }
  return { agentsSummary: summary, agentAccess: { allAgents: exceptAgentIds.length === 0, agentIds, exceptAgentIds } };
}

/**
 * The account each of the viewer's own Agents uses for this App, by the call path's own decision
 * (`admitFromRows`): the personal grant first, then the shared pin or the default.
 */
async function viewerAgentAccounts(serverId: string, app: AppRow, viewerUserId: string, canManage: boolean): Promise<McpAppView["myAgents"]> {
  const own = await getDb()
    .select({
      id: agents.id,
      creatorType: agents.creatorType,
      creatorId: agents.creatorId,
      enabled: managedMcpAssignments.enabled,
      connectionMode: managedMcpAssignments.connectionMode,
      boundConnectionId: managedMcpAssignments.boundConnectionId,
    })
    .from(agents)
    .leftJoin(managedMcpAssignments, and(eq(managedMcpAssignments.agentId, agents.id), eq(managedMcpAssignments.mcpServerId, app.id)))
    .where(and(
      eq(agents.serverId, serverId),
      isNull(agents.deletedAt),
      or(
        eq(agents.assistantOwnerUserId, viewerUserId),
        and(isNull(agents.assistantOwnerUserId), eq(agents.creatorType, "user"), eq(agents.creatorId, viewerUserId)),
      ),
    ))
    .orderBy(asc(agents.createdAt), asc(agents.id));
  if (own.length === 0) return [];
  const connections = await getDb()
    .select({
      id: managedMcpCredentials.id,
      mcpServerId: managedMcpCredentials.mcpServerId,
      isServerDefault: managedMcpCredentials.isServerDefault,
      ownerKind: managedMcpCredentials.ownerKind,
      ownerUserId: managedMcpCredentials.ownerUserId,
      authStatus: managedMcpCredentials.authStatus,
      name: managedMcpCredentials.name,
      accountLabel: managedMcpCredentials.accountLabel,
      authorizedEndpointUrl: managedMcpCredentials.authorizedEndpointUrl,
      headerNames: managedMcpCredentials.headerNames,
    })
    .from(managedMcpCredentials)
    .where(and(eq(managedMcpCredentials.serverId, serverId), eq(managedMcpCredentials.mcpServerId, app.id)));
  const byId = new Map(connections.map((connection) => [connection.id, connection]));
  const defaultCredential = connections.find((connection) => connection.isServerDefault) ?? null;
  const ownIds = new Set(own.map((agent) => agent.id));
  const grants = new Map((await loadPersonalGrants(getDb(), serverId, { mcpServerId: app.id }))
    .filter((grant) => ownIds.has(grant.agentId))
    .map((grant) => [grant.agentId, grant]));
  return own.map((agent) => {
    const assignment = agent.enabled === null || agent.connectionMode === null
      ? null
      : { enabled: agent.enabled, connectionMode: agent.connectionMode, boundConnectionId: agent.boundConnectionId };
    const grant = grants.get(agent.id);
    const grantConnection = grant ? byId.get(grant.connection.id) : undefined;
    const decision = admitFromRows({
      server: app,
      assignment,
      autoGranted: mcpAutoGrantCoversAgent(app, agent),
      personalGrant: grant && grantConnection ? { connection: grantConnection, ownerIsMember: grant.ownerIsMember } : null,
      boundCredential: agent.boundConnectionId ? byId.get(agent.boundConnectionId) ?? null : null,
      defaultCredential,
    });
    const used = decision.block === null && decision.connection.allowed && decision.connection.credentialId
      ? byId.get(decision.connection.credentialId) ?? null
      : null;
    if (!used) return { agentId: agent.id, account: null };
    const seeId = canManage || (used.ownerKind === "personal" && used.ownerUserId === viewerUserId);
    return {
      agentId: agent.id,
      account: {
        kind: used.ownerKind,
        ...(seeId ? { connectionId: used.id } : {}),
        name: used.name,
        label: used.accountLabel,
        ...(used.ownerKind === "personal" && used.ownerUserId ? { ownerUserId: used.ownerUserId } : {}),
      },
    };
  });
}

export async function getMcpAppView(serverId: string, appId: string, viewerUserId: string): Promise<McpAppView> {
  const app = await loadApp(serverId, appId);
  const canManage = await actorHasServerCapabilityInServer(serverId, "user", viewerUserId, "manageIntegrations");
  const personalAccounts = await mcpPersonalAccountsEnabled(serverId);
  const [root] = await getDb()
    .select({ appId: appMcpProfiles.appId })
    .from(appMcpProfiles)
    .where(eq(appMcpProfiles.managedMcpServerId, app.id))
    .limit(1);
  const connections = await listManagedMcpConnections(serverId, appId);
  const actionNeeded = (await openCardCounts(serverId)).get(app.id) ?? 0;
  const publishers = await mcpAppTemplatePublisherNames();
  return {
    id: app.id,
    rootAppId: root?.appId ?? null,
    kind: "mcp",
    sections: ["profile", "mcp_server", "connections", "agents", "distribution", "danger"],
    profile: {
      name: app.name,
      description: app.description,
      homepageUrl: app.homepageUrl,
      logoUrl: clientLogoUrl(app.logoUrl),
      category: app.category,
      whenToUse: app.whenToUse,
    },
    source: sourceOf(app, publishers),
    server: {
      endpointUrl: publicManagedMcpEndpoint(app.endpointUrl),
      transport: MANAGED_MCP_TRANSPORT,
      authKind: app.authMode,
      requiredHeaderNames: app.requiredHeaderNames ?? [],
      serverInfo: app.serverInfo,
      authProbe: app.authProbe,
      raftOAuthClient: availableRaftOAuthClientKind(managedMcpOAuthClientPolicy(app.endpointUrl)) !== null,
      oauthClientMode: await managedMcpOAuthClientModeForApp(app),
      health: healthOf(app),
      toolCount: app.toolCatalog.length,
      tools: app.toolCatalog.map((tool) => {
        const annotations = toolAnnotations(tool);
        return {
          name: tool.name,
          ...(tool.title ? { title: tool.title } : {}),
          ...(tool.description ? { description: tool.description } : {}),
          ...(annotations ? { annotations } : {}),
        };
      }),
      enabled: app.enabled,
    },
    // Connection ids, names and account labels are for the people who manage them, and a member's
    // own Connections for that member.
    connections: canManage
      ? connections
      : connections.filter((connection) => connection.ownerKind === "personal" && connection.owner?.userId === viewerUserId),
    membersCanConnect: personalAccounts && app.membersCanConnect,
    personalAccounts,
    myAgents: await viewerAgentAccounts(serverId, app, viewerUserId, canManage),
    defaultConnectionId: canManage ? connections.find((connection) => connection.isServerDefault)?.id ?? null : null,
    ...await agentsUse(serverId, app, actionNeeded),
    serverVouched: app.serverVouchedAt !== null,
    serverVouchedAt: app.serverVouchedAt?.toISOString() ?? null,
    distribution: { kind: "server_local", publishStatus: "private" },
    viewer: { canManage },
  };
}

/**
 * `viewerUserId`: the person viewing the list. The default Connection's status is shown only to
 * someone who manages integrations, as getMcpAppView shows Connections; null hides it.
 */
export async function listMcpApps(serverId: string, viewerUserId: string | null): Promise<McpAppListItem[]> {
  const [apps, connectionCounts, cards, canManage, publishers] = await Promise.all([
    getDb().select().from(managedMcpServers).where(eq(managedMcpServers.serverId, serverId)).orderBy(asc(managedMcpServers.name)),
    getDb()
      .select({
        mcpServerId: managedMcpCredentials.mcpServerId,
        count: sql<number>`count(*)::int`,
        // RFC 087: what a viewer without manageIntegrations counts: the shared Connections (counted for
        // everyone before personal ones existed) and their own personal ones, as the App view shows them
        // their own; never other members' accounts.
        visibleCount: sql<number>`(count(*) FILTER (WHERE ${managedMcpCredentials.ownerKind} = 'shared'${viewerUserId ? sql` OR ${managedMcpCredentials.ownerUserId} = ${viewerUserId}` : sql``}))::int`,
        // At most one default per App (idx_managed_mcp_credentials_default).
        defaultStatus: sql<CredentialAuthStatus | null>`(array_agg(${managedMcpCredentials.authStatus}) FILTER (WHERE ${managedMcpCredentials.isServerDefault}))[1]`,
      })
      .from(managedMcpCredentials)
      .where(eq(managedMcpCredentials.serverId, serverId))
      .groupBy(managedMcpCredentials.mcpServerId),
    openCardCounts(serverId),
    viewerUserId ? actorHasServerCapabilityInServer(serverId, "user", viewerUserId, "manageIntegrations") : false,
    mcpAppTemplatePublisherNames(),
  ]);
  const counts = new Map(connectionCounts.map((row) => [row.mcpServerId, row]));
  return apps.map((app) => ({
    kind: "mcp" as const,
    id: app.id,
    name: app.name,
    description: app.description,
    logoUrl: clientLogoUrl(app.logoUrl),
    homepageUrl: app.homepageUrl,
    category: app.category,
    distribution: "server_local" as const,
    source: sourceOf(app, publishers),
    status: {
      health: healthOf(app).status,
      toolCount: app.toolCatalog.length,
      connectionCount: (canManage ? counts.get(app.id)?.count : counts.get(app.id)?.visibleCount) ?? 0,
      actionNeeded: cards.get(app.id) ?? 0,
      defaultConnectionStatus: canManage ? counts.get(app.id)?.defaultStatus ?? null : null,
    },
  }));
}

/* ------------------------------------------------------------------ input validation */

function invalid(message: string): never {
  throw new ManagedMcpServiceError(message, "managed_mcp_app_invalid");
}

function normalizeProfile(input: McpAppProfileInput, requireName: boolean) {
  const out: Partial<Pick<AppRow, "name" | "description" | "homepageUrl" | "category" | "whenToUse">> = {};
  if (input.name !== undefined || requireName) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name || name.length > 120) invalid("profile.name is required (at most 120 characters)");
    out.name = name;
  }
  if (input.description !== undefined) {
    if (input.description !== null && (typeof input.description !== "string" || input.description.length > 4_000)) invalid("profile.description is invalid");
    out.description = input.description?.trim() || null;
  }
  if (input.homepageUrl !== undefined) {
    if (input.homepageUrl === null || input.homepageUrl === "") out.homepageUrl = null;
    else {
      let url: URL | null = null;
      try { url = typeof input.homepageUrl === "string" ? new URL(input.homepageUrl) : null; } catch { url = null; }
      if (!url || url.protocol !== "https:" || input.homepageUrl.length > 2_000) invalid("profile.homepageUrl must be an https URL");
      out.homepageUrl = url.toString();
    }
  }
  if (input.category !== undefined) {
    if (input.category === null || input.category === "") out.category = null;
    else {
      const category = canonicalizeOAuthClientCategory(input.category);
      if (!category) invalid("profile.category is not a known category");
      out.category = category;
    }
  }
  if (input.whenToUse !== undefined) {
    if (input.whenToUse !== null && typeof input.whenToUse !== "string") invalid("profile.whenToUse is invalid");
    try {
      out.whenToUse = normalizeWhenToUse(input.whenToUse);
    } catch (error) {
      invalid(error instanceof Error ? `profile.${error.message}` : "profile.whenToUse is invalid");
    }
  }
  return out;
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u;

function normalizeRequiredHeaderNames(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16 || value.some((name) => typeof name !== "string" || !HEADER_NAME.test(name.trim()))) {
    invalid("requiredHeaderNames must list between 1 and 16 header names");
  }
  const names = (value as string[]).map((name) => name.trim());
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) invalid("requiredHeaderNames must be unique");
  return names.sort((left, right) => left.localeCompare(right));
}

async function assertNameFree(serverId: string, name: string, exceptId?: string): Promise<void> {
  const [taken] = await getDb()
    .select({ id: managedMcpServers.id })
    .from(managedMcpServers)
    .where(and(eq(managedMcpServers.serverId, serverId), eq(managedMcpServers.name, name)))
    .limit(1);
  if (taken && taken.id !== exceptId) {
    throw new ManagedMcpServiceError("An MCP App with this name already exists", "managed_mcp_app_name_taken");
  }
}

/* ------------------------------------------------------------------ create */

export type McpAppSource = { kind: "url"; endpointUrl: string } | { kind: "template"; templateKey: string; endpointUrl?: string };

/**
 * Creates an App. For a template, Raft supplies the endpoint and auth kind and the request may not
 * override them. For a URL the server probes the endpoint itself: an unreachable server writes
 * nothing (503); an auth-less App must complete its handshake, and its catalogue is stored before
 * returning. An App starts with no Connection.
 */
export async function createMcpApp(input: {
  serverId: string;
  userId: string;
  source: McpAppSource;
  profile: McpAppProfileInput;
  authKind?: ManagedMcpAuthMode;
  requiredHeaderNames?: unknown;
  /**
   * The creator is a person in their own session (POST /api/mcp/apps; not their assistant, not a
   * card dispatch): the App is vouched for (`server_vouched_at`) when they hold manageExternalAuth
   * on the Server now (`insertMcpAppRow`).
   */
  vouchAsCreator?: boolean;
}, deps: { probe?: Prober } = {}): Promise<McpAppView> {
  const profile = normalizeProfile(input.profile, true);
  let values: Partial<AppRow> & Pick<AppRow, "endpointUrl" | "authMode" | "provider">;
  let toolCatalog: ManagedMcpToolCatalogEntry[] = [];
  let probe: McpProbeResult | null = null;
  if (input.source.kind === "template") {
    const template = await findActiveMcpAppTemplate(input.source.templateKey);
    if (!template) throw new ManagedMcpServiceError("MCP App template not found", "managed_mcp_template_not_found");
    if (
      (input.source.endpointUrl !== undefined && input.source.endpointUrl !== template.endpointUrl)
      || (input.authKind !== undefined && input.authKind !== template.authKind)
      || input.requiredHeaderNames !== undefined
    ) {
      throw new ManagedMcpServiceError("A recommended App's server and sign-in are maintained by Raft", "managed_mcp_template_field_locked");
    }
    // Keep the create boundary aligned with the gateway even if the catalog
    // validator later changes. Template queries may be needed by a provider.
    validateManagedMcpEndpoint(template.endpointUrl);
    values = {
      endpointUrl: template.endpointUrl,
      authMode: template.authKind,
      // Older binaries derive a fixed endpoint from `provider`; keep it for the keys they know.
      provider: LEGACY_PROVIDERS.has(template.key) ? template.key as AppRow["provider"] : "custom",
      sourceKind: "template",
      templateKey: template.key,
      homepageUrl: template.homepageUrl,
      logoUrl: template.logoUrl,
      category: template.category,
    };
  } else {
    const endpointUrl = validateManagedMcpConfiguredEndpoint(input.source.endpointUrl).toString();
    const probed = await (deps.probe ?? probeManagedMcpEndpointWithCatalog)(endpointUrl);
    probe = probed.result;
    if (probe.outcome === "unreachable") {
      throw new ManagedMcpGatewayError(
        probe.error?.message ?? "MCP server could not be reached",
        probe.error?.code === "managed_mcp_endpoint_blocked" ? "managed_mcp_endpoint_blocked" : "managed_mcp_unreachable",
      );
    }
    const authKind = input.authKind ?? (probe.outcome === "ready" ? "none" : probe.outcome);
    // The page's choice came from its own earlier probe: a server that stopped offering OAuth since
    // then is refused, not saved as a sign-in nobody can complete.
    if (authKind === "oauth" && probe.outcome !== "oauth") {
      throw new ManagedMcpServiceError("This MCP server no longer offers OAuth sign-in; check it again", "managed_mcp_auth_invalid");
    }
    if (authKind === "none") {
      // Allowed when this probe listed the tools without a token: a `ready` server, or one that also
      // offers OAuth (`oauth` with a catalogue) where the user chose to use it without signing in.
      if (!probed.toolCatalog) {
        throw new ManagedMcpServiceError("This MCP server requires credentials", "managed_mcp_auth_invalid");
      }
      toolCatalog = probed.toolCatalog;
    }
    values = {
      endpointUrl,
      authMode: authKind,
      provider: "custom",
      sourceKind: "url",
      ...(authKind === "headers" ? { requiredHeaderNames: normalizeRequiredHeaderNames(input.requiredHeaderNames ?? probe.suggestedHeaderNames) } : {}),
      ...(probe.oauth ? { authProbe: probe.oauth } : {}),
      ...(probe.serverInfo ? { serverInfo: probe.serverInfo } : {}),
      lastLatencyMs: probe.latencyMs,
    };
  }
  if (values.authMode !== "headers" && input.requiredHeaderNames !== undefined && input.source.kind === "url") {
    invalid("requiredHeaderNames only applies to an App that uses API-key headers");
  }
  await assertNameFree(input.serverId, profile.name!);
  const now = currentDate();
  const row = await getDb().transaction((tx) => insertMcpAppRow(tx, {
    serverId: input.serverId,
    ...values,
    ...profile,
    name: profile.name!,
    oauthStatus: values.authMode === "oauth" ? "disconnected" : "connected",
    enabled: true,
    toolCatalog,
    catalogVersion: toolCatalog.length > 0 ? 1 : 0,
    lastCheckedAt: probe?.outcome === "ready" || (probe && values.authMode === "none") ? now : null,
    createdByUserId: input.userId,
    updatedByUserId: input.userId,
  }, input.vouchAsCreator)).catch(rethrowIfMcpAppNameTaken);
  return getMcpAppView(input.serverId, row.id, input.userId);
}

/* ------------------------------------------------------------------ update */

const PATCH_KEYS = new Set(["profile", "endpointUrl", "enabled", "requiredHeaderNames"]);
const PROFILE_KEYS = new Set(["name", "description", "homepageUrl", "category", "whenToUse"]);

/**
 * Updates an App's profile, endpoint or on/off state. Sections an MCP App does not have (sign-in
 * redirect URLs, scopes, App notifications, ...) are refused by name rather than ignored.
 *
 * An endpoint change invalidates the catalogue and every OAuth sign-in (tokens are bound to the
 * server). If the origin changes, API-key values are cleared too, so a key is never sent to a host
 * it was not entered for; each Connection then needs its key again (`needs_auth`).
 */
export async function updateMcpApp(input: {
  serverId: string;
  userId: string;
  appId: string;
  patch: Record<string, unknown>;
}): Promise<McpAppView> {
  const unsupported = Object.keys(input.patch).filter((key) => !PATCH_KEYS.has(key));
  const profilePatch = input.patch.profile;
  if (profilePatch !== undefined && (typeof profilePatch !== "object" || profilePatch === null || Array.isArray(profilePatch))) {
    invalid("profile must be an object");
  }
  unsupported.push(...Object.keys((profilePatch ?? {}) as object).filter((key) => !PROFILE_KEYS.has(key)).map((key) => `profile.${key}`));
  if (unsupported.length > 0) {
    throw new ManagedMcpServiceError(`Not supported for an MCP App: ${unsupported.join(", ")}`, "managed_mcp_app_section_not_supported");
  }
  if (input.patch.enabled !== undefined && typeof input.patch.enabled !== "boolean") invalid("enabled must be a boolean");
  const app = await loadApp(input.serverId, input.appId);
  const profile = normalizeProfile((profilePatch ?? {}) as McpAppProfileInput, false);
  if (profile.name !== undefined) await assertNameFree(input.serverId, profile.name, app.id);
  let endpointUrl: string | undefined;
  if (input.patch.endpointUrl !== undefined) {
    if (typeof input.patch.endpointUrl !== "string") invalid("endpointUrl must be a string");
    const next = validateManagedMcpConfiguredEndpoint(input.patch.endpointUrl).toString();
    assertTemplateFieldsUnchanged(app, { provider: app.provider, authMode: app.authMode, endpointUrl: next });
    if (next !== app.endpointUrl) endpointUrl = next;
  }
  const enabledChanged = typeof input.patch.enabled === "boolean" && input.patch.enabled !== app.enabled;
  // The header names every new or replaced key must supply. Needed for an App created before names
  // were recorded once it has no Connection left to take them from. Existing Connections keep theirs.
  let requiredHeaderNames: string[] | undefined;
  if (input.patch.requiredHeaderNames !== undefined) {
    if (mcpAppSourceKind(app) === "template") {
      throw new ManagedMcpServiceError("A recommended App's sign-in is maintained by Raft", "managed_mcp_template_field_locked");
    }
    if (app.authMode !== "headers") invalid("requiredHeaderNames only applies to an App that uses API-key headers");
    requiredHeaderNames = normalizeRequiredHeaderNames(input.patch.requiredHeaderNames);
  }
  const appValues = {
    ...profile,
    ...(enabledChanged ? { enabled: input.patch.enabled as boolean } : {}),
    ...(requiredHeaderNames !== undefined ? { requiredHeaderNames } : {}),
    updatedByUserId: input.userId,
  };
  await getDb().transaction(async (tx) => {
    if (endpointUrl !== undefined) {
      // Same code as the original `PATCH /servers/:id`: every Connection is cleared as the move requires.
      await applyMcpAppServerChange(tx, app, { endpointUrl, authMode: app.authMode, provider: app.provider }, appValues);
      return;
    }
    await tx.update(managedMcpServers).set({
      ...appValues,
      ...(enabledChanged ? { configVersion: sql`${managedMcpServers.configVersion} + 1` } : {}),
      updatedAt: currentDate(),
    }).where(eq(managedMcpServers.id, app.id));
  }).catch(rethrowIfMcpAppNameTaken);
  return getMcpAppView(input.serverId, app.id, input.userId);
}

/* ------------------------------------------------------------------ server vouch */

export type McpAppServerVouchResult = { status: "ok"; changed: boolean } | { status: "not_found" };

/**
 * Vouch for this Server's MCP App, or end the vouch (PUT /api/mcp/apps/:appId/server-vouch; the
 * route checks the person's manageExternalAuth and own session). Idempotent: no write and no audit
 * when nothing changes; the first voucher stays.
 *
 * Ending it stops future automatic grants only. Assignment rows already written stay as they are:
 * an Agent with an enabled row keeps the App (now a person's grant), a revoked one stays revoked.
 * An Agent that had it only by the automatic rule (no row) no longer has it, as when the App's
 * creator was demoted under the old rule; a person grants it to that Agent again.
 */
export async function setMcpAppServerVouch(input: {
  serverId: string;
  appId: string;
  actorUserId: string;
  vouched: boolean;
}): Promise<McpAppServerVouchResult> {
  return getDb().transaction(async (tx) => {
    const [app] = await tx.select({
      id: managedMcpServers.id,
      serverId: managedMcpServers.serverId,
      name: managedMcpServers.name,
      serverVouchedAt: managedMcpServers.serverVouchedAt,
    }).from(managedMcpServers)
      .where(and(eq(managedMcpServers.id, input.appId), eq(managedMcpServers.serverId, input.serverId)))
      .limit(1)
      .for("update");
    if (!app) return { status: "not_found" };
    if ((app.serverVouchedAt !== null) === input.vouched) return { status: "ok", changed: false };
    await tx.update(managedMcpServers)
      .set(input.vouched
        ? { serverVouchedAt: sql`now()`, serverVouchedByUserId: input.actorUserId, updatedAt: currentDate() }
        : { serverVouchedAt: null, serverVouchedByUserId: null, updatedAt: currentDate() })
      .where(eq(managedMcpServers.id, app.id));
    await recordMcpServerVouchEvent(tx, app, input.actorUserId, input.vouched, input.vouched ? "vouched" : "unvouched");
    return { status: "ok", changed: true };
  });
}

export async function refreshMcpApp(serverId: string, appId: string, viewerUserId: string): Promise<McpAppView> {
  await refreshManagedMcpCatalog(serverId, appId);
  return getMcpAppView(serverId, appId, viewerUserId);
}

export async function deleteMcpApp(serverId: string, appId: string): Promise<void> {
  const app = await loadApp(serverId, appId);
  await deleteManagedMcpServer(serverId, appId);
  if (app.logoStorageKey) removeStoredLogo(app.logoStorageKey);
}

/* ------------------------------------------------------------------ logo */

function removeStoredLogo(storageKey: string): void {
  const storage = getCdnStorage() || getStorage();
  if (storage) void storage.delete(storageKey).catch(() => undefined);
}

/**
 * An MCP App's logo, exactly as an ordinary App's (`updateOAuthClientLogo`): resized to a square
 * WebP, stored under `integration-logos/<appId>/` and served by `/api/integration-logos`. The row is
 * locked while it changes so two uploads cannot both orphan the other's file.
 */
export async function updateMcpAppLogo(input: { serverId: string; userId: string; appId: string; fileBuffer: Buffer }): Promise<McpAppView> {
  await loadApp(input.serverId, input.appId);
  const nextLogo = await storeIntegrationLogo(input.appId, input.fileBuffer);
  const previous = await getDb().transaction(async (tx) => {
    const [locked] = await tx.select({ logoStorageKey: managedMcpServers.logoStorageKey }).from(managedMcpServers)
      .where(and(eq(managedMcpServers.id, input.appId), eq(managedMcpServers.serverId, input.serverId)))
      .for("update");
    if (!locked) throw new ManagedMcpServiceError("MCP App not found", "managed_mcp_server_not_found");
    await tx.update(managedMcpServers).set({
      logoUrl: nextLogo.logoUrl,
      logoStorageKey: nextLogo.logoStorageKey,
      updatedByUserId: input.userId,
      updatedAt: currentDate(),
    }).where(eq(managedMcpServers.id, input.appId));
    return locked.logoStorageKey;
  });
  if (previous && previous !== nextLogo.logoStorageKey) removeStoredLogo(previous);
  return getMcpAppView(input.serverId, input.appId, input.userId);
}

/** Removes an uploaded logo. An App made from a Raft template goes back to the template's logo. */
export async function clearMcpAppLogo(input: { serverId: string; userId: string; appId: string }): Promise<McpAppView> {
  const app = await loadApp(input.serverId, input.appId);
  const templateLogo = app.templateKey ? (await findMcpAppTemplate(app.templateKey))?.logoUrl ?? null : null;
  await getDb().update(managedMcpServers).set({
    logoUrl: templateLogo,
    logoStorageKey: null,
    updatedByUserId: input.userId,
    updatedAt: currentDate(),
  }).where(and(eq(managedMcpServers.id, app.id), eq(managedMcpServers.serverId, input.serverId)));
  if (app.logoStorageKey) removeStoredLogo(app.logoStorageKey);
  return getMcpAppView(input.serverId, input.appId, input.userId);
}
