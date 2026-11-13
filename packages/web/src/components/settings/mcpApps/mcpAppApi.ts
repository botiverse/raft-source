/**
 * What the MCP App editor reads from and sends to `/api/mcp` (server: routes/managedMcp.ts,
 * services/managedMcpAppService.ts, managedMcpConnectionService.ts, managedMcpProbe.ts).
 *
 * These mirror the server's response shapes field for field. They live here, not in shared, until
 * the server's own interfaces move to shared (follow-up): the list item already did (S5).
 */
import type { IntlShape } from "react-intl";
import type { ManagedMcpAuthMode, ManagedMcpOAuthClientMode } from "@botiverse/raft-shared";
import type { MessageId } from "../../../i18n/messages";

export type McpAppSectionId = "profile" | "mcp_server" | "connections" | "agents" | "distribution" | "danger";

/** The rail of an MCP App editor, in order. There is no Login with Raft and no App Notifications. */
export const MCP_APP_SECTION_IDS: readonly McpAppSectionId[] = ["profile", "mcp_server", "connections", "agents", "distribution", "danger"];

export type McpProbeOutcome = "ready" | "oauth" | "headers" | "unreachable";
export type McpOAuthRegistration = "dcr" | "cimd" | "manual_required";

export interface McpProbeResult {
  endpointUrl: string;
  outcome: McpProbeOutcome;
  latencyMs: number | null;
  serverInfo?: { protocolVersion: string; name?: string; version?: string };
  tools?: { count: number; names: string[] };
  oauth?: { issuer: string; registration: McpOAuthRegistration; scopes: string[] };
  suggestedHeaderNames?: string[];
  error?: { code: string; message: string };
}

export type McpConnectionStatus = "ready" | "pending" | "needs_auth" | "expired" | "error";

export interface McpConnectionView {
  id: string;
  name: string | null;
  authKind: "headers" | "oauth";
  isServerDefault: boolean;
  status: McpConnectionStatus;
  accountLabel: string | null;
  hasConfiguredOAuthClient?: boolean;
  headerNames: string[];
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface McpAppView {
  id: string;
  rootAppId: string | null;
  kind: "mcp";
  sections: McpAppSectionId[];
  profile: {
    name: string;
    description: string | null;
    homepageUrl: string | null;
    logoUrl: string | null;
    category: string | null;
    whenToUse: string | null;
  };
  source: { kind: "url" | "template"; templateKey: string | null; maintainedByRaft: boolean };
  server: {
    endpointUrl: string;
    transport: "streamable_http";
    authKind: ManagedMcpAuthMode;
    requiredHeaderNames: string[];
    serverInfo: { protocolVersion: string; name?: string; version?: string } | null;
    authProbe: { issuer: string; registration: McpOAuthRegistration; scopes: string[] } | null;
    /** Raft has its own OAuth client for this provider here (absent from older servers: false). */
    raftOAuthClient?: boolean;
    /** How Connections get an OAuth client (absent from older servers: either; null: cannot be confirmed now, sign-in is refused). */
    oauthClientMode?: ManagedMcpOAuthClientMode | null;
    health: { status: "reachable" | "unreachable" | "unknown"; checkedAt: string | null; error: string | null; latencyMs: number | null };
    toolCount: number;
    tools: Array<{ name: string; title?: string; description?: string }>;
    enabled: boolean;
  };
  /** Only for a viewer who manages integrations; empty otherwise. */
  connections: McpConnectionView[];
  defaultConnectionId: string | null;
  /** `noConnection`: pinned to a Connection that was deleted or can't be used (absent from an older server). */
  agentsSummary: { total: number; usingDefault: number; pinned: number; noConnection?: number; off: number; actionNeeded: number };
  distribution: { kind: "server_local"; publishStatus: "private" };
  viewer: { canManage: boolean };
}

export interface McpAppProfileDraft {
  name: string;
  description: string;
  homepageUrl: string;
  category: string;
  whenToUse: string;
}

export interface McpDefaultImpact {
  currentDefaultConnectionId: string | null;
  agentsChangingNow: number;
  agentsTotal: number;
  agentsFollowingDefault: number;
  pinnedUnchanged: number;
  offUnchanged: number;
  futureAgentsInherit: true;
}

/**
 * `GET /mcp/servers/:id/connection-authorization?agentId=` (server: managedMcpConnectionCardService):
 * what THIS viewer may do about one Agent's Connection to one App, computed fresh on every read.
 */
export interface McpConnectionAuthorizationView {
  viewerRole: "server_manager" | "agent_manager" | "observer";
  /** Absent from an older server. */
  app?: { name: string; authKind: ManagedMcpAuthMode } | null;
  candidates: Array<{ connectionId: string; name: string | null; isServerDefault: boolean; status: McpConnectionStatus }>;
  binding: { present: boolean; visibleToViewer: boolean; connectionId: string | null };
  canAuthorizeNew: boolean;
  canSetServerDefault: boolean;
  /**
   * A Connection this viewer creates could be pinned to this Agent (they are its owner); otherwise the
   * Agent could use it only as the App's server default. Absent from an older server: treated as true.
   */
  newConnectionPinnable?: boolean;
  /** A Connection this viewer signed in for this Agent that it does not use yet ("Ready to grant"). */
  pendingGrant?: { connectionId: string; name: string | null } | null;
}

export type McpOAuthAttemptStatus = "pending" | "connected" | "failed" | "expired";

export interface McpOAuthStartResponse {
  authorizationUrl: string;
  attemptId: string;
  connectionId: string;
}

/** The auth kind an App created from this probe result gets: what the server would pick too. */
export function authKindForProbe(outcome: Exclude<McpProbeOutcome, "unreachable">): ManagedMcpAuthMode {
  return outcome === "ready" ? "none" : outcome;
}

/** Header names as the server compares them: trimmed, non-empty, case-insensitive, unordered. */
export function sameHeaderNames(left: string[], right: string[]): boolean {
  const norm = (names: string[]) => names.map((name) => name.trim().toLowerCase()).filter(Boolean).sort();
  const a = norm(left);
  const b = norm(right);
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

export function profileDraftFromView(view: McpAppView): McpAppProfileDraft {
  return {
    name: view.profile.name,
    description: view.profile.description ?? "",
    homepageUrl: view.profile.homepageUrl ?? "",
    category: view.profile.category ?? "",
    whenToUse: view.profile.whenToUse ?? "",
  };
}

/** The profile as the server takes it: empty optional fields are cleared, not sent as "". */
export function profilePayload(draft: McpAppProfileDraft) {
  return {
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    homepageUrl: draft.homepageUrl.trim() || null,
    category: draft.category || null,
    whenToUse: draft.whenToUse.trim() || null,
  };
}

/** The sign-in URL the server returned is not a web page, so it was not opened. */
export class McpOAuthUnsafeUrlError extends Error {
  constructor() {
    super("The sign-in URL is not an https URL");
    this.name = "McpOAuthUnsafeUrlError";
  }
}

/** Server error codes (every `/api/mcp` code carries the `managed_mcp_` prefix) and their sentences. */
export const ERROR_MESSAGE_IDS: Readonly<Record<string, MessageId>> = {
  managed_mcp_probe_rate_limited: "settings.mcpApp.error.rateLimited",
  managed_mcp_unreachable: "settings.mcpApp.error.unreachable",
  managed_mcp_template_field_locked: "settings.mcpApp.error.templateLocked",
  managed_mcp_template_not_found: "settings.mcpApp.error.templateNotFound",
  managed_mcp_app_name_taken: "settings.mcpApp.error.nameTaken",
  managed_mcp_header_names_unset: "settings.mcpApp.error.headerNamesUnset",
  managed_mcp_endpoint_invalid: "settings.mcpApp.error.endpointInvalid",
  managed_mcp_endpoint_blocked: "settings.mcpApp.error.endpointBlocked",
  managed_mcp_endpoint_auth_rejected: "settings.mcpApp.error.credentialsRejected",
  managed_mcp_headers_incomplete: "settings.mcpApp.error.headersIncomplete",
  managed_mcp_connection_limit_reached: "settings.mcpApp.error.connectionLimit",
  managed_mcp_oauth_busy: "settings.mcpApp.error.oauthBusy",
  managed_mcp_oauth_client_registration_unsupported: "settings.mcpApp.error.oauthUnsupported",
  managed_mcp_config_stale: "settings.mcpApp.error.configStale",
  managed_mcp_server_not_found: "settings.mcpApp.error.appNotFound",
  managed_mcp_connection_not_found: "settings.mcpApp.error.connectionNotFound",
  managed_mcp_connection_not_usable: "settings.mcpApp.error.connectionNotUsable",
  managed_mcp_forbidden: "settings.mcpApp.error.forbidden",
};

/**
 * A failed `/api/mcp` request as a sentence for the person who made it. Known codes are translated;
 * a 429 without a known code is still "too many attempts"; anything else shows the server's message,
 * which names the field it refused, or a generic line.
 */
export function mcpAppErrorMessage(error: unknown, formatMessage: IntlShape["formatMessage"]): string {
  if (error instanceof McpOAuthUnsafeUrlError) return formatMessage({ id: "settings.mcpApp.error.oauthUnsafeUrl" });
  const response = (error as { response?: { status?: number; data?: { code?: unknown; error?: unknown } } } | null)?.response;
  const code = typeof response?.data?.code === "string" ? response.data.code : null;
  const known = code ? ERROR_MESSAGE_IDS[code] : undefined;
  if (known) return formatMessage({ id: known });
  if (response?.status === 429) return formatMessage({ id: "settings.mcpApp.error.rateLimited" });
  if (typeof response?.data?.error === "string" && response.data.error.trim()) return response.data.error;
  return formatMessage({ id: "settings.mcpApp.error.generic" });
}
