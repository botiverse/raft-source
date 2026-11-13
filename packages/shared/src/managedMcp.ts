export const MANAGED_MCP_TRANSPORT = "streamable_http" as const;
export const MANAGED_MCP_MAX_TOOLS_PER_SERVER = 200;
export const MANAGED_MCP_MAX_CATALOG_BYTES = 512 * 1024;
export const MANAGED_MCP_MAX_RESULT_BYTES = 512 * 1024;
export const MANAGED_MCP_OAUTH_RESULT_CHANNEL = "raft-managed-mcp-oauth-result";

export type ManagedMcpProvider = "notion" | "linear" | "custom";
export type ManagedMcpAuthMode = "oauth" | "headers" | "none";
export type ManagedMcpOAuthStatus = "disconnected" | "pending" | "connected" | "error";

export type ManagedMcpJsonSchema = {
  type: "object";
  properties?: Record<string, object>;
  required?: string[];
  [key: string]: unknown;
};

export interface ManagedMcpToolCatalogEntry {
  name: string;
  title?: string;
  description?: string;
  inputSchema: ManagedMcpJsonSchema;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface ManagedMcpAssignmentView {
  enabled: boolean;
  allowedTools: string[] | null;
  version: number;
  /**
   * WHETHER this assignment names a Connection -- deliberately a boolean, not the id.
   *
   * ⚠️ This view is returned by `GET /api/mcp/agents/:agentId`, which only requires `viewAgents`.
   * Every ordinary Server member has that. An earlier version of this field carried the raw
   * `bound_connection_id`, which handed every member the exact id of a private Connection they are
   * not allowed to see -- re-breaking the isolation contract this whole change exists to enforce
   * (@Huarong). The UI needed "is it bound?"; the id was information the requirement never asked for.
   *
   * The exact id lives ONLY in `connection-authorization`, which recomputes the viewer's role and
   * returns an id only to a viewer who may edit the Agent AND can see that Connection.
   *
   * ⓘ False is a meaningful, common state: a registry-managed server with an enabled but unbound
   * assignment is refused at call time, and that refusal is what raises the connection card.
   */
  hasBoundConnection: boolean;
}

export interface ManagedMcpUsageView {
  invocationCount: number;
  lastInvokedAt: string;
  lastToolName: string;
}

export interface ManagedMcpCredentialPatch {
  upsertHeaders: Record<string, string>;
  removeHeaderNames: string[];
}

/**
 * How ONE Agent uses an MCP App, as the Agent's Apps tab shows it (`GET /api/mcp/agents/:agentId`).
 *
 * `mode` is the Agent's choice: follow the server default, pinned to one Connection, or switched
 * off. `status` is what a call would get right now, judged by the same admission rule as the call
 * path: a pin whose Connection is gone or not signed in is `login_required` -- it never falls back
 * to the server default. For a switched-off Agent `status` still describes the Connection it would
 * use if switched back on.
 *
 * `connectionName` names the Connection that would be used, and only for a viewer who may manage
 * this Agent or the server's integrations; everyone else gets `null` (no ids, ever).
 */
export interface ManagedMcpAgentConnectionView {
  mode: "default" | "pinned" | "off";
  /** `disabled`: the App itself is switched off on this server, so no Agent's call is admitted. */
  status: "ready" | "login_required" | "authorization_expired" | "disabled";
  connectionName: string | null;
  /**
   * `pinned`, but the Connection is gone (deleted) or no longer usable by this Agent: shown as "no
   * Connection selected". The Agent is refused until someone chooses one; it never falls back to the
   * server default. Absent from an older server.
   */
  connectionMissing?: boolean;
  /**
   * Whether this Agent has the App at all, with an ordinary App's grant rule (see
   * `ManagedMcpAgentGrant`). `mode` is `off` whenever this is not `automatic` or `person`.
   * Absent from an older server, which granted every App to every Agent.
   */
  grant?: ManagedMcpAgentGrant;
}

/**
 * How an Agent holds an MCP App, the same states as an ordinary App's grant:
 * - `automatic`: granted automatically (the App's creator manages external auth or created this Agent)
 * - `person`: a person granted it to this Agent
 * - `revoked`: a person revoked it for this Agent (it stays revoked until someone grants it again)
 * - `not_granted`: not granted automatically, and nobody has granted it
 */
export type ManagedMcpAgentGrant = "automatic" | "person" | "revoked" | "not_granted";

/** Replaced as a whole; omitted on edits to keep the saved client, null to remove it. */
export interface ManagedMcpOAuthClientInput {
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod: "none" | "client_secret_post" | "client_secret_basic";
  scope?: string;
  requestOfflineAccess?: boolean;
}

/**
 * How an OAuth MCP App's Connections get a client, set per recommended template by Raft App admin:
 * `automatic` registration only (DCR or a client metadata document), a user-`registered` client
 * only (the provider has no usable automatic registration), or `either` (the default).
 */
export const MANAGED_MCP_OAUTH_CLIENT_MODES = ["automatic", "registered", "either"] as const;
export type ManagedMcpOAuthClientMode = (typeof MANAGED_MCP_OAUTH_CLIENT_MODES)[number];

/**
 * OAuth client settings Raft fixes for a provider instead of asking the user. Google's Workspace
 * MCP servers (`<service>mcp.googleapis.com`) have no client registration, need a Web client with
 * its secret, need offline access for a refresh token, and list every scope they accept in their
 * resource metadata (Docs includes full Drive access). Raft requests only the scopes each
 * server's tools need, so only the Client ID and secret are the user's to enter.
 */
export interface ManagedMcpOAuthClientPolicy {
  provider: "google";
  /** The Cloud service the user's project must enable, e.g. `docsmcp.googleapis.com`. */
  apiService: string;
  /** The product API the MCP service calls, also to enable, e.g. `docs.googleapis.com`. */
  productApiService: string;
  tokenEndpointAuthMethod: "client_secret_post";
  requestOfflineAccess: true;
  /** The scopes requested, least privilege for the server's tools; never the metadata's full list. */
  scopes: readonly string[];
}

const GOOGLE_WORKSPACE_MCP_HOST = /^([a-z]+)mcp\.googleapis\.com$/u;
const GOOGLE_SCOPE = (name: string) => `https://www.googleapis.com/auth/${name}`;
/**
 * The Workspace MCP servers Raft knows, their product API and the fewest scopes that authorize every
 * tool, from Google's per-tool reference ("Requires one of the following OAuth scopes",
 * developers.google.com/workspace/<product>/api/reference/mcp). Docs, Sheets and Slides tools all
 * accept their own API scope, so no Drive access; Drive needs `drive.readonly` to read and search
 * beyond files Raft opened; every Gmail label tool accepts only `gmail.modify` (or full mail), which
 * also covers reading and drafts; Calendar's write tools need `calendar.events`, which also answers
 * free/busy. The coverage test in managedMcp.test.ts pins each tool's accepted scopes.
 */
const GOOGLE_WORKSPACE_MCP: Readonly<Record<string, { productApi: string; scopes: readonly string[] }>> = {
  docs: { productApi: "docs", scopes: [GOOGLE_SCOPE("documents")] },
  sheets: { productApi: "sheets", scopes: [GOOGLE_SCOPE("spreadsheets")] },
  slides: { productApi: "slides", scopes: [GOOGLE_SCOPE("presentations")] },
  drive: { productApi: "drive", scopes: [GOOGLE_SCOPE("drive.readonly"), GOOGLE_SCOPE("drive.file")] },
  gmail: { productApi: "gmail", scopes: [GOOGLE_SCOPE("gmail.modify")] },
  calendar: { productApi: "calendar-json", scopes: [GOOGLE_SCOPE("calendar.calendarlist.readonly"), GOOGLE_SCOPE("calendar.events")] },
};

/** The policy for a known Google Workspace MCP server; any other endpoint, including an unknown Google one, has none. */
export function managedMcpOAuthClientPolicy(endpointUrl: string): ManagedMcpOAuthClientPolicy | null {
  let host: string;
  try {
    host = new URL(endpointUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  const product = GOOGLE_WORKSPACE_MCP_HOST.exec(host)?.[1];
  // Own keys only: `constructor`, `toString` and the like are not services.
  const known = product && Object.hasOwn(GOOGLE_WORKSPACE_MCP, product) ? GOOGLE_WORKSPACE_MCP[product] : undefined;
  return known
    ? {
        provider: "google",
        apiService: host,
        productApiService: `${known.productApi}.googleapis.com`,
        tokenEndpointAuthMethod: "client_secret_post",
        requestOfflineAccess: true,
        scopes: known.scopes,
      }
    : null;
}

/**
 * A submitted client with the policy's fixed settings applied: the method, offline access and the
 * policy's scopes replace whatever was sent. Removing the client (automatic registration) is not
 * possible under a policy and is returned unchanged for the caller to refuse.
 */
export function applyManagedMcpOAuthClientPolicy<T extends ManagedMcpOAuthClientInput | null | undefined>(
  policy: ManagedMcpOAuthClientPolicy | null,
  client: T,
): T {
  if (!policy || !client) return client;
  return {
    clientId: client.clientId,
    ...(client.clientSecret !== undefined ? { clientSecret: client.clientSecret } : {}),
    tokenEndpointAuthMethod: policy.tokenEndpointAuthMethod,
    scope: policy.scopes.join(" "),
    requestOfflineAccess: policy.requestOfflineAccess,
  } as T;
}

export interface ManagedMcpServerView {
  id: string;
  name: string;
  description: string | null;
  provider: ManagedMcpProvider;
  authMode: ManagedMcpAuthMode;
  oauthStatus: ManagedMcpOAuthStatus;
  transport: typeof MANAGED_MCP_TRANSPORT;
  endpointUrl: string;
  enabled: boolean;
  configVersion: number;
  catalogVersion: number;
  toolCatalog: ManagedMcpToolCatalogEntry[];
  lastCheckedAt: string | null;
  lastCheckError: string | null;
  credentialHeaderNames: string[];
  /**
   * Header names this server REQUIRES, from the pinned registry snapshot it was imported under.
   * A backward-compatible contract extension for task #21, not a disguised zero-output change.
   *
   * Names only. Never values, and deliberately never a per-item "is this one filled" -- that would
   * turn the management view into an oracle for which specific secret is missing.
   * `hasCredentials` keeps reporting overall presence and nothing finer.
   * Empty array when the server requires none; hand-created servers are always empty.
   */
  requiredCredentialHeaderNames: string[];
  hasCredentials: boolean;
  assignment: ManagedMcpAssignmentView | null;
  usage: ManagedMcpUsageView | null;
  /** Only in an Agent's catalogue (`GET /api/mcp/agents/:agentId`). */
  agentConnection?: ManagedMcpAgentConnectionView;
  /** The App's Profile logo and homepage; only in an Agent's catalogue. */
  logoUrl?: string | null;
  homepageUrl?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedMcpAgentCatalogResponse {
  servers: ManagedMcpServerView[];
  recommendations: ManagedMcpRecommendation[];
}

/** One MCP App in the App lists (`GET /api/mcp/apps`). `appId` is `managed_mcp_servers.id`. */
export interface McpAppListItem {
  kind: "mcp";
  id: string;
  name: string;
  description: string | null;
  logoUrl: string | null;
  homepageUrl: string | null;
  category: string | null;
  distribution: "server_local";
  /** Where the App came from; a Raft template (Notion, Linear) is maintained by Raft. */
  source: { kind: "url" | "template"; templateKey: string | null; maintainedByRaft: boolean };
  status: { health: "reachable" | "unreachable" | "unknown"; toolCount: number; connectionCount: number; actionNeeded: number };
}

export interface McpAppListResponse {
  apps: McpAppListItem[];
}

export interface ManagedMcpRecommendation {
  id: string;
  name: string;
  description: string;
  provider: Exclude<ManagedMcpProvider, "custom">;
  authMode: "oauth";
  endpointUrl: string;
  credentialHeaderNames: string[];
}

export interface ManagedMcpRuntimeTool {
  mcpServerId: string;
  serverName: string;
  toolName: string;
  runtimeName: string;
  title?: string;
  description?: string;
  inputSchema: ManagedMcpJsonSchema;
  annotations?: ManagedMcpToolCatalogEntry["annotations"];
  configVersion: number;
  assignmentVersion: number;
}

/**
 * A connector this agent would have tools from, but that is not usable now
 * (an OAuth connection that is not connected). It contributes no tools; it is
 * listed so the agent can say "<serverName> is disconnected; someone who
 * manages this server's integrations has to reconnect it in Raft" instead of
 * acting as if the connector did not exist.
 */
export interface ManagedMcpUnavailableServer {
  mcpServerId: string;
  serverName: string;
  status: "reconnect_required";
}

export interface ManagedMcpRuntimeSnapshot {
  catalogVersion: 1;
  tools: ManagedMcpRuntimeTool[];
  /** Additive; absent from older Servers. Never mapped to tools. */
  unavailable?: ManagedMcpUnavailableServer[];
}

export interface ManagedMcpCallRequest {
  mcpServerId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  expectedConfigVersion: number;
  expectedAssignmentVersion: number;
  /** The foreground turn's source message; absent for background work (see agentApiContract). */
  origin?: { sourceMessageId: string };
}

export type ManagedMcpResultContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ManagedMcpCallResult {
  content: ManagedMcpResultContent[];
  isError: boolean;
  structuredContent?: Record<string, unknown>;
}

function stableToolNameHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** How many characters of a connector or tool name an agent sees. */
export const MANAGED_MCP_PROMPT_NAME_LIMIT = 80;

/** Remote text on one line: control, format and line/paragraph separator characters become spaces. */
export function flattenManagedMcpPromptText(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * A connector or tool name as agents read it, in prompts and error text.
 * `toolName` comes from the remote MCP server (and `serverName` from whoever
 * set the connector up), so neither may break out of the sentence it sits in:
 * one line, capped, and quoted (`JSON.stringify`). Use this for every name
 * that goes into model-facing text.
 */
export function formatManagedMcpPromptName(value: string): string {
  const chars = Array.from(flattenManagedMcpPromptText(value));
  const capped = chars.length > MANAGED_MCP_PROMPT_NAME_LIMIT ? `${chars.slice(0, MANAGED_MCP_PROMPT_NAME_LIMIT).join("")}…` : chars.join("");
  return JSON.stringify(capped);
}

/** The prefix every runtime tool name of this connector starts with (`mcp_<id8>_`). */
export function formatManagedMcpRuntimeToolPrefix(mcpServerId: string): string {
  return `mcp_${mcpServerId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "server"}_`;
}

export function formatManagedMcpRuntimeToolName(mcpServerId: string, toolName: string): string {
  const serverPart = mcpServerId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "server";
  const toolPart = toolName
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "tool";
  return `mcp_${serverPart}_${toolPart}_${stableToolNameHash(`${mcpServerId}:${toolName}`)}`;
}
