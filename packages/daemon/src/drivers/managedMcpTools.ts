import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import {
  type ManagedMcpCallResult,
  type ManagedMcpRuntimeSnapshot,
  type ManagedMcpRuntimeTool,
} from "@botiverse/raft-shared";

const MANAGED_MCP_HTTP_TIMEOUT_MS = 25_000;

class ManagedMcpHttpError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
    this.name = "ManagedMcpHttpError";
  }
}
async function requestJson<T>(input: {
  url: URL;
  token: string;
  method?: "GET" | "POST";
  body?: unknown;
  signal?: AbortSignal;
}): Promise<T> {
  const timeout = AbortSignal.timeout(MANAGED_MCP_HTTP_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  const response = await fetch(input.url, {
    method: input.method ?? "GET",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "X-Slock-Agent-Active-Capabilities": "mcp",
      ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    signal,
  });
  const payload = await response.json().catch(() => null) as { error?: unknown; code?: unknown } | T | null;
  if (!response.ok) {
    const error = typeof (payload as { error?: unknown } | null)?.error === "string"
      ? (payload as { error: string }).error
      : `HTTP ${response.status}`;
    const code = typeof (payload as { code?: unknown } | null)?.code === "string"
      ? (payload as { code: string }).code
      : null;
    throw new ManagedMcpHttpError(error, response.status, code);
  }
  return payload as T;
}

function isRuntimeSnapshot(value: unknown): value is ManagedMcpRuntimeSnapshot {
  return typeof value === "object"
    && value !== null
    && (value as { catalogVersion?: unknown }).catalogVersion === 1
    && Array.isArray((value as { tools?: unknown }).tools);
}

function resultText(result: ManagedMcpCallResult): string {
  return result.content
    .filter((block): block is Extract<ManagedMcpCallResult["content"][number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .slice(0, 4_000) || "Managed MCP tool failed";
}

function buildTool(input: {
  tool: ManagedMcpRuntimeTool;
  serverUrl: string;
  token: string;
}): ToolDefinition {
  const { tool } = input;
  return {
    name: tool.runtimeName,
    label: tool.title || `${tool.serverName}: ${tool.toolName}`,
    description: tool.description || `Call ${tool.toolName} on the managed MCP server ${tool.serverName}.`,
    promptSnippet: `${tool.runtimeName}: ${tool.description || `Call ${tool.toolName} on ${tool.serverName}`}`,
    parameters: tool.inputSchema as TSchema,
    async execute(_toolCallId, params, signal) {
      const result = await requestJson<ManagedMcpCallResult>({
        url: new URL("/internal/agent-api/mcp/call", input.serverUrl),
        token: input.token,
        method: "POST",
        body: {
          mcpServerId: tool.mcpServerId,
          toolName: tool.toolName,
          arguments: params as Record<string, unknown>,
          expectedConfigVersion: tool.configVersion,
          expectedAssignmentVersion: tool.assignmentVersion,
        },
        signal,
      });
      if (result.isError) throw new Error(resultText(result));
      return {
        content: result.content.map((block) => block.type === "text"
          ? { type: "text" as const, text: block.text }
          : { type: "image" as const, data: block.data, mimeType: block.mimeType }),
        details: {
          managedMcp: true,
          mcpServerId: tool.mcpServerId,
          toolName: tool.toolName,
          ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
        },
      };
    },
  };
}

export async function createManagedMcpPiTools(input: {
  serverUrl: string;
  agentCredentialKey: string | null | undefined;
  onWarning?: (message: string) => void;
}): Promise<ToolDefinition[]> {
  if (!input.agentCredentialKey) return [];
  try {
    const snapshot = await requestJson<ManagedMcpRuntimeSnapshot>({
      url: new URL("/internal/agent-api/mcp/tools", input.serverUrl),
      token: input.agentCredentialKey,
    });
    if (!isRuntimeSnapshot(snapshot)) throw new Error("Managed MCP snapshot contract is invalid");
    return snapshot.tools.map((tool) => buildTool({
      tool,
      serverUrl: input.serverUrl,
      token: input.agentCredentialKey!,
    }));
  } catch (error) {
    const detail = error instanceof ManagedMcpHttpError
      ? `${error.code ?? "managed_mcp_http_error"} (${error.status})`
      : error instanceof Error ? error.message.slice(0, 200) : "unknown error";
    input.onWarning?.(`Managed MCP tools unavailable for this session: ${detail}`);
    return [];
  }
}
