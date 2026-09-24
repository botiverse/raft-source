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
  hasCredentials: boolean;
  assignment: ManagedMcpAssignmentView | null;
  usage: ManagedMcpUsageView | null;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedMcpAgentCatalogResponse {
  servers: ManagedMcpServerView[];
  recommendations: ManagedMcpRecommendation[];
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

export interface ManagedMcpRuntimeSnapshot {
  catalogVersion: 1;
  tools: ManagedMcpRuntimeTool[];
}

export interface ManagedMcpCallRequest {
  mcpServerId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  expectedConfigVersion: number;
  expectedAssignmentVersion: number;
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

export function formatManagedMcpRuntimeToolName(mcpServerId: string, toolName: string): string {
  const serverPart = mcpServerId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "server";
  const toolPart = toolName
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "tool";
  return `mcp_${serverPart}_${toolPart}_${stableToolNameHash(`${mcpServerId}:${toolName}`)}`;
}
