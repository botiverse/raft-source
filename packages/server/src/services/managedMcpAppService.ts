/**
 * MCP Apps: create / read / update / delete an App backed by an MCP server.
 *
 * `appId` is `managed_mcp_servers.id`, the identity the Agent API, the runtime snapshot and the
 * action cards already use. The generic App root (`raft_apps`, via `app_mcp_profiles`) is returned
 * as `rootAppId` when the migration trigger has written one.
 */
import { mcpAgentGrant, mcpAgentGrantAllows, mcpAutoGrantCoversAgent, mcpAutoGrantCreatorScope } from "./managedMcpAgentGrant";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  canonicalizeOAuthClientCategory,
  currentDate,
  MANAGED_MCP_TRANSPORT,
  managedMcpOAuthClientPolicy,
  type ManagedMcpAuthMode,
  type ManagedMcpOAuthClientMode,
  type ManagedMcpToolCatalogEntry,
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
import { mcpAgentOwnerUserId, mcpConnectionUsableByAgent } from "./managedMcpConnectionOwnership";
import { actorHasServerCapabilityInServer } from "../lib/actorPermissions";
import { ManagedMcpGatewayError, validateManagedMcpEndpoint } from "./managedMcpGateway";
import { listManagedMcpConnections, type ManagedMcpConnectionView } from "./managedMcpConnectionService";
import { availableRaftOAuthClientKind } from "./managedMcpRaftOAuthClient";
import { managedMcpOAuthClientModeForApp } from "./managedMcpOAuthClientMode";
import {
  applyMcpAppServerChange,
  assertTemplateFieldsUnchanged,
  deleteManagedMcpServer,
  ManagedMcpServiceError,
  mcpAppSourceKind,
  publicManagedMcpEndpoint,
  rethrowIfMcpAppNameTaken,
  refreshManagedMcpCatalog,
  validateManagedMcpConfiguredEndpoint,
} from "./managedMcpService";
import { probeManagedMcpEndpointWithCatalog, type McpProbeResult } from "./managedMcpProbe";
import { findActiveMcpAppTemplate, findMcpAppTemplate } from "./mcpAppTemplates";
import { normalizeWhenToUse, storeIntegrationLogo } from "./oauthService";
import { getCdnStorage, getStorage } from "./storageService";
import { clientLogoUrl } from "../config/privacyMode";

type AppRow = typeof managedMcpServers.$inferSelect;
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
  source: { kind: "url" | "template"; templateKey: string | null; maintainedByRaft: boolean };
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
    tools: Array<{ name: string; title?: string; description?: string }>;
    enabled: boolean;
  };
  /** Only for a viewer who manages integrations; empty otherwise. */
  connections: ManagedMcpConnectionView[];
  defaultConnectionId: string | null;
  /** `noConnection`: pinned to a Connection that was deleted or is no longer usable by that Agent (refused until one is chosen). */
  agentsSummary: { total: number; usingDefault: number; pinned: number; noConnection: number; off: number; actionNeeded: number };
  distribution: { kind: "server_local"; publishStatus: "private" };
  viewer: { canManage: boolean };
}

function sourceOf(app: AppRow): McpAppView["source"] {
  const kind = mcpAppSourceKind(app);
  const templateKey = app.templateKey ?? (kind === "template" ? app.provider : null);
  return { kind, templateKey, maintainedByRaft: kind === "template" };
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

async function agentsSummary(serverId: string, app: AppRow, actionNeeded: number): Promise<McpAppView["agentsSummary"]> {
  const rows = await getDb()
    .select({
      enabled: managedMcpAssignments.enabled,
      connectionMode: managedMcpAssignments.connectionMode,
      boundConnectionId: managedMcpAssignments.boundConnectionId,
      creatorType: agents.creatorType,
      creatorId: agents.creatorId,
      assistantOwnerUserId: agents.assistantOwnerUserId,
    })
    .from(agents)
    .leftJoin(managedMcpAssignments, and(eq(managedMcpAssignments.agentId, agents.id), eq(managedMcpAssignments.mcpServerId, app.id)))
    .where(and(eq(agents.serverId, serverId), isNull(agents.deletedAt)));
  const creatorScope = await mcpAutoGrantCreatorScope(getDb(), serverId, app);
  const connections = new Map((await getDb()
    .select({ id: managedMcpCredentials.id, isServerDefault: managedMcpCredentials.isServerDefault, createdByUserId: managedMcpCredentials.createdByUserId })
    .from(managedMcpCredentials)
    .where(and(eq(managedMcpCredentials.serverId, serverId), eq(managedMcpCredentials.mcpServerId, app.id))))
    .map((connection) => [connection.id, connection]));
  const summary = { total: rows.length, usingDefault: 0, pinned: 0, noConnection: 0, off: 0, actionNeeded };
  for (const row of rows) {
    // "Off" is every Agent that does not have the App: revoked, or never granted automatically.
    const assignment = row.enabled === null ? null : { enabled: row.enabled };
    if (!mcpAgentGrantAllows(mcpAgentGrant(assignment, mcpAutoGrantCoversAgent(creatorScope, row)))) summary.off += 1;
    else if (row.connectionMode === "pinned") {
      // The same rule as the Agent's own view and the call path (`mcpConnectionUsableByAgent`).
      const bound = row.boundConnectionId ? connections.get(row.boundConnectionId) ?? null : null;
      if (bound && mcpConnectionUsableByAgent(bound, mcpAgentOwnerUserId(row))) summary.pinned += 1;
      else summary.noConnection += 1;
    } else summary.usingDefault += 1;
  }
  return summary;
}

export async function getMcpAppView(serverId: string, appId: string, viewerUserId: string): Promise<McpAppView> {
  const app = await loadApp(serverId, appId);
  const canManage = await actorHasServerCapabilityInServer(serverId, "user", viewerUserId, "manageIntegrations");
  const [root] = await getDb()
    .select({ appId: appMcpProfiles.appId })
    .from(appMcpProfiles)
    .where(eq(appMcpProfiles.managedMcpServerId, app.id))
    .limit(1);
  const connections = await listManagedMcpConnections(serverId, appId);
  const actionNeeded = (await openCardCounts(serverId)).get(app.id) ?? 0;
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
    source: sourceOf(app),
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
      tools: app.toolCatalog.map((tool) => ({
        name: tool.name,
        ...(tool.title ? { title: tool.title } : {}),
        ...(tool.description ? { description: tool.description } : {}),
      })),
      enabled: app.enabled,
    },
    // Connection ids, names and account labels are for the people who manage them.
    connections: canManage ? connections : [],
    defaultConnectionId: canManage ? connections.find((connection) => connection.isServerDefault)?.id ?? null : null,
    agentsSummary: await agentsSummary(serverId, app, actionNeeded),
    distribution: { kind: "server_local", publishStatus: "private" },
    viewer: { canManage },
  };
}

export async function listMcpApps(serverId: string): Promise<McpAppListItem[]> {
  const [apps, connectionCounts, cards] = await Promise.all([
    getDb().select().from(managedMcpServers).where(eq(managedMcpServers.serverId, serverId)).orderBy(asc(managedMcpServers.name)),
    getDb()
      .select({ mcpServerId: managedMcpCredentials.mcpServerId, count: sql<number>`count(*)::int` })
      .from(managedMcpCredentials)
      .where(eq(managedMcpCredentials.serverId, serverId))
      .groupBy(managedMcpCredentials.mcpServerId),
    openCardCounts(serverId),
  ]);
  const counts = new Map(connectionCounts.map((row) => [row.mcpServerId, row.count]));
  return apps.map((app) => ({
    kind: "mcp" as const,
    id: app.id,
    name: app.name,
    description: app.description,
    logoUrl: clientLogoUrl(app.logoUrl),
    homepageUrl: app.homepageUrl,
    category: app.category,
    distribution: "server_local" as const,
    source: sourceOf(app),
    status: {
      health: healthOf(app).status,
      toolCount: app.toolCatalog.length,
      connectionCount: counts.get(app.id) ?? 0,
      actionNeeded: cards.get(app.id) ?? 0,
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
  const [row] = await getDb().insert(managedMcpServers).values({
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
  }).returning().catch(rethrowIfMcpAppNameTaken);
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
    if (sourceOf(app).kind === "template") {
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
