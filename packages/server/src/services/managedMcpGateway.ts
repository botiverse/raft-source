import dns from "node:dns";
import { BlockList, isIP } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { auth, UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { OAuthError, ServerError, TemporarilyUnavailableError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { Agent, fetch as undiciFetch } from "undici";
import {
  clearClockTimeout,
  MANAGED_MCP_MAX_CATALOG_BYTES,
  MANAGED_MCP_MAX_RESULT_BYTES,
  MANAGED_MCP_MAX_TOOLS_PER_SERVER,
  setClockTimeout,
  type ManagedMcpCallResult,
  type ManagedMcpJsonSchema,
  type ManagedMcpResultContent,
  type ManagedMcpToolCatalogEntry,
} from "@botiverse/raft-shared";

const MCP_TIMEOUT_MS = 20_000;
const MCP_MAX_HTTP_RESPONSE_BYTES = 1024 * 1024;
const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedAddresses.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64],
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20], ["5f00::", 16],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blockedAddresses.addSubnet(network, prefix, "ipv6");

export class ManagedMcpGatewayError extends Error {
  constructor(
    message: string,
    readonly code:
      | "managed_mcp_endpoint_invalid"
      | "managed_mcp_endpoint_blocked"
      | "managed_mcp_unreachable"
      | "managed_mcp_oauth_required"
      | "managed_mcp_catalog_invalid"
      | "managed_mcp_result_too_large"
      | "managed_mcp_result_invalid",
  ) {
    super(message);
    this.name = "ManagedMcpGatewayError";
  }
}

export function normalizeManagedMcpClientError(error: unknown, timedOut: boolean): ManagedMcpGatewayError {
  if (error instanceof ManagedMcpGatewayError) return error;
  const oauthFailureRequiresReconnect = error instanceof UnauthorizedError
    || (error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403))
    || (error instanceof OAuthError && !(error instanceof ServerError) && !(error instanceof TemporarilyUnavailableError));
  if (oauthFailureRequiresReconnect) {
    return new ManagedMcpGatewayError("MCP OAuth authorization expired; reconnect from Settings", "managed_mcp_oauth_required");
  }
  return new ManagedMcpGatewayError(
    timedOut ? "MCP request timed out" : "MCP server could not be reached",
    "managed_mcp_unreachable",
  );
}

function normalizedMappedIpv4(address: string): string {
  return address.toLowerCase().startsWith("::ffff:") ? address.slice(7) : address;
}

export function isManagedMcpAddressAllowed(address: string): boolean {
  const normalized = normalizedMappedIpv4(address);
  const family = isIP(normalized);
  return family !== 0 && !blockedAddresses.check(normalized, family === 4 ? "ipv4" : "ipv6");
}

export function validateManagedMcpEndpoint(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ManagedMcpGatewayError("MCP endpoint must be a valid URL", "managed_mcp_endpoint_invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new ManagedMcpGatewayError("MCP endpoint must be an HTTPS URL without credentials or a fragment", "managed_mcp_endpoint_invalid");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "").replace(/^\[|\]$/gu, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new ManagedMcpGatewayError("MCP endpoint host is not allowed", "managed_mcp_endpoint_blocked");
  }
  if (isIP(hostname) && !isManagedMcpAddressAllowed(hostname)) {
    throw new ManagedMcpGatewayError("MCP endpoint address is not allowed", "managed_mcp_endpoint_blocked");
  }
  return url;
}

async function safeLookup(
  hostname: string,
  options: dns.LookupOneOptions | dns.LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
): Promise<void> {
  try {
    const addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    if (addresses.length === 0 || addresses.some(({ address }) => !isManagedMcpAddressAllowed(address))) {
      callback(Object.assign(new Error("MCP endpoint resolved to a blocked address"), { code: "EACCES" }), "", 0);
      return;
    }
    if ("all" in options && options.all) {
      callback(null, addresses);
      return;
    }
    const requestedFamily = "family" in options && typeof options.family === "number" ? options.family : 0;
    const selected = addresses.find((item) => requestedFamily === 0 || item.family === requestedFamily) ?? addresses[0];
    callback(null, selected.address, selected.family);
  } catch (error) {
    callback(error as NodeJS.ErrnoException, "", 0);
  }
}

export function createSafeFetch(): { fetch: typeof globalThis.fetch; close: () => Promise<void> } {
  const dispatcher = new Agent({
    connect: { lookup: safeLookup as never },
    headersTimeout: MCP_TIMEOUT_MS,
    bodyTimeout: MCP_TIMEOUT_MS,
    maxResponseSize: MCP_MAX_HTTP_RESPONSE_BYTES,
  });
  const fetch = ((input: URL | RequestInfo, init?: RequestInit) => {
    const rawUrl = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
    validateManagedMcpEndpoint(rawUrl);
    return undiciFetch(input as never, {
      ...(init ?? {}),
      redirect: "error",
      dispatcher,
    } as never) as unknown as Promise<Response>;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, close: () => dispatcher.close() };
}

function normalizeInputSchema(value: unknown): ManagedMcpJsonSchema {
  if (typeof value !== "object" || value === null || Array.isArray(value) || (value as { type?: unknown }).type !== "object") {
    throw new ManagedMcpGatewayError("MCP tool inputSchema must be an object schema", "managed_mcp_catalog_invalid");
  }
  return value as ManagedMcpJsonSchema;
}

export function normalizeManagedMcpToolCatalog(tools: unknown[]): ManagedMcpToolCatalogEntry[] {
  if (tools.length > MANAGED_MCP_MAX_TOOLS_PER_SERVER) {
    throw new ManagedMcpGatewayError("MCP server exposes too many tools", "managed_mcp_catalog_invalid");
  }
  const names = new Set<string>();
  const normalized = tools.map((raw) => {
    if (typeof raw !== "object" || raw === null) {
      throw new ManagedMcpGatewayError("MCP tool catalog is invalid", "managed_mcp_catalog_invalid");
    }
    const tool = raw as Record<string, unknown>;
    if (
      typeof tool.name !== "string"
      || !tool.name.trim()
      || tool.name !== tool.name.trim()
      || tool.name.length > 128
      || names.has(tool.name)
    ) {
      throw new ManagedMcpGatewayError("MCP tool names must be non-empty and unique", "managed_mcp_catalog_invalid");
    }
    names.add(tool.name);
    return {
      name: tool.name,
      ...(typeof tool.title === "string" ? { title: tool.title.slice(0, 200) } : {}),
      ...(typeof tool.description === "string" ? { description: tool.description.slice(0, 4_000) } : {}),
      inputSchema: normalizeInputSchema(tool.inputSchema),
      ...(typeof tool.annotations === "object" && tool.annotations !== null ? {
        annotations: Object.fromEntries(
          ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]
            .filter((key) => typeof (tool.annotations as Record<string, unknown>)[key] === "boolean")
            .map((key) => [key, (tool.annotations as Record<string, boolean>)[key]]),
        ) as ManagedMcpToolCatalogEntry["annotations"],
      } : {}),
    };
  });
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MANAGED_MCP_MAX_CATALOG_BYTES) {
    throw new ManagedMcpGatewayError("MCP tool catalog exceeds the size limit", "managed_mcp_catalog_invalid");
  }
  return normalized;
}

function normalizeCallResult(raw: unknown): ManagedMcpCallResult {
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { content?: unknown }).content)) {
    throw new ManagedMcpGatewayError("MCP tool returned an invalid result", "managed_mcp_result_invalid");
  }
  const result = raw as { content: unknown[]; isError?: unknown; structuredContent?: unknown };
  const content: ManagedMcpResultContent[] = result.content.map((item) => {
    if (typeof item !== "object" || item === null) {
      throw new ManagedMcpGatewayError("MCP tool returned unsupported content", "managed_mcp_result_invalid");
    }
    const block = item as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") return { type: "text", text: block.text };
    if (
      block.type === "image"
      && typeof block.data === "string"
      && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(block.data)
      && typeof block.mimeType === "string"
      && /^image\/[A-Za-z0-9!#$&^_.+-]{1,100}$/u.test(block.mimeType)
    ) {
      return { type: "image", data: block.data, mimeType: block.mimeType };
    }
    throw new ManagedMcpGatewayError("MCP tool returned unsupported content", "managed_mcp_result_invalid");
  });
  const normalized: ManagedMcpCallResult = {
    content,
    isError: result.isError === true,
    ...(typeof result.structuredContent === "object" && result.structuredContent !== null && !Array.isArray(result.structuredContent)
      ? { structuredContent: result.structuredContent as Record<string, unknown> }
      : {}),
  };
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MANAGED_MCP_MAX_RESULT_BYTES) {
    throw new ManagedMcpGatewayError("MCP tool result exceeds the size limit", "managed_mcp_result_too_large");
  }
  return normalized;
}

async function withClient<T>(
  endpoint: string,
  headers: Record<string, string>,
  operation: (client: Client, signal: AbortSignal) => Promise<T>,
  authProvider?: OAuthClientProvider,
): Promise<T> {
  const url = validateManagedMcpEndpoint(endpoint);
  const controller = new AbortController();
  const timeout = setClockTimeout(() => controller.abort(), MCP_TIMEOUT_MS);
  const client = new Client({ name: "raft-managed-mcp", version: "1.0.0" });
  const safeFetch = createSafeFetch();
  try {
    const transport = new StreamableHTTPClientTransport(url, {
      fetch: safeFetch.fetch,
      ...(Object.keys(headers).length > 0 ? { requestInit: { headers } } : {}),
      ...(authProvider ? { authProvider } : {}),
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1_000, maxReconnectionDelay: 1_000, reconnectionDelayGrowFactor: 1 },
    });
    await client.connect(transport, { signal: controller.signal, timeout: MCP_TIMEOUT_MS });
    return await operation(client, controller.signal);
  } catch (error) {
    throw normalizeManagedMcpClientError(error, controller.signal.aborted);
  } finally {
    clearClockTimeout(timeout);
    await client.close().catch(() => undefined);
    await safeFetch.close().catch(() => undefined);
  }
}

export async function listManagedMcpTools(endpoint: string, headers: Record<string, string>): Promise<ManagedMcpToolCatalogEntry[]> {
  return withClient(endpoint, headers, async (client, signal) => {
    const result = await client.listTools(undefined, { signal, timeout: MCP_TIMEOUT_MS });
    return normalizeManagedMcpToolCatalog(result.tools);
  });
}

export async function startManagedMcpOAuth(
  endpoint: string,
  provider: OAuthClientProvider,
): Promise<"AUTHORIZED" | "REDIRECT"> {
  const url = validateManagedMcpEndpoint(endpoint);
  const safeFetch = createSafeFetch();
  try {
    return await auth(provider, { serverUrl: url, fetchFn: safeFetch.fetch });
  } catch (error) {
    throw new ManagedMcpGatewayError(
      error instanceof Error ? `MCP OAuth setup failed: ${error.message}` : "MCP OAuth setup failed",
      "managed_mcp_unreachable",
    );
  } finally {
    await safeFetch.close().catch(() => undefined);
  }
}

export async function completeManagedMcpOAuth(
  endpoint: string,
  provider: OAuthClientProvider,
  authorizationCode: string,
): Promise<void> {
  const url = validateManagedMcpEndpoint(endpoint);
  const safeFetch = createSafeFetch();
  try {
    const result = await auth(provider, { serverUrl: url, authorizationCode, fetchFn: safeFetch.fetch });
    if (result !== "AUTHORIZED") {
      throw new ManagedMcpGatewayError("MCP OAuth did not complete", "managed_mcp_oauth_required");
    }
  } catch (error) {
    if (error instanceof ManagedMcpGatewayError) throw error;
    throw new ManagedMcpGatewayError(
      error instanceof Error ? `MCP OAuth token exchange failed: ${error.message}` : "MCP OAuth token exchange failed",
      "managed_mcp_unreachable",
    );
  } finally {
    await safeFetch.close().catch(() => undefined);
  }
}

export async function listManagedMcpOAuthTools(
  endpoint: string,
  provider: OAuthClientProvider,
): Promise<ManagedMcpToolCatalogEntry[]> {
  return withClient(endpoint, {}, async (client, signal) => {
    const result = await client.listTools(undefined, { signal, timeout: MCP_TIMEOUT_MS });
    return normalizeManagedMcpToolCatalog(result.tools);
  }, provider);
}

export async function callManagedMcpTool(input: {
  endpoint: string;
  headers: Record<string, string>;
  name: string;
  arguments: Record<string, unknown>;
}): Promise<ManagedMcpCallResult> {
  return withClient(input.endpoint, input.headers, async (client, signal) => normalizeCallResult(
    await client.callTool({ name: input.name, arguments: input.arguments }, undefined, { signal, timeout: MCP_TIMEOUT_MS }),
  ));
}

export async function callManagedMcpOAuthTool(input: {
  endpoint: string;
  provider: OAuthClientProvider;
  name: string;
  arguments: Record<string, unknown>;
}): Promise<ManagedMcpCallResult> {
  return withClient(input.endpoint, {}, async (client, signal) => normalizeCallResult(
    await client.callTool({ name: input.name, arguments: input.arguments }, undefined, { signal, timeout: MCP_TIMEOUT_MS }),
  ), input.provider);
}
