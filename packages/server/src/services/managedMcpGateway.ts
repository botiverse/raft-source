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
      | "managed_mcp_oauth_client_registration_unsupported"
      | "managed_mcp_endpoint_auth_rejected"
      | "managed_mcp_catalog_invalid"
      | "managed_mcp_result_too_large"
      | "managed_mcp_result_invalid",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ManagedMcpGatewayError";
  }
}

// A private marker for this guard's own DNS refusal. An unrelated EACCES must not be
// reported as a network-policy decision, even when undici wraps it in a fetch error.
class ManagedMcpLookupBlockedError extends Error {
  readonly code = "EACCES";

  constructor() {
    super("MCP endpoint resolved to a blocked address");
    this.name = "ManagedMcpLookupBlockedError";
  }
}

function isManagedMcpLookupBlocked(error: unknown): boolean {
  const seen = new Set<Error>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof ManagedMcpLookupBlockedError) return true;
    seen.add(current);
    current = current.cause;
  }
  return false;
}

/**
 * Error copy must follow the connection's auth mode. A 401/403 on an OAuth
 * connection means the grant expired (reconnect); the same status on a
 * none/headers connection is the endpoint rejecting our request and must never
 * be described with OAuth wording (Astro MCP ticket afe07b8d: unauthenticated
 * endpoint failing with "OAuth authorization expired").
 */
export type ManagedMcpAuthKind = "none" | "headers" | "oauth";

export function normalizeManagedMcpClientError(error: unknown, timedOut: boolean, authKind: ManagedMcpAuthKind = "none"): ManagedMcpGatewayError {
  if (error instanceof ManagedMcpGatewayError) return error;
  const endpointRejected = error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403);
  if (authKind === "oauth") {
    const oauthFailureRequiresReconnect = error instanceof UnauthorizedError
      || endpointRejected
      || (error instanceof OAuthError && !(error instanceof ServerError) && !(error instanceof TemporarilyUnavailableError));
    if (oauthFailureRequiresReconnect) {
      return new ManagedMcpGatewayError("MCP OAuth authorization expired; reconnect from Settings", "managed_mcp_oauth_required", { cause: error });
    }
  } else if (endpointRejected) {
    return new ManagedMcpGatewayError(
      authKind === "headers"
        ? "MCP endpoint rejected the configured credentials (401/403)"
        : "MCP endpoint rejected the request (401/403) without credentials configured for it",
      "managed_mcp_endpoint_auth_rejected",
      { cause: error },
    );
  }
  return new ManagedMcpGatewayError(
    timedOut ? "MCP request timed out" : "MCP server could not be reached",
    "managed_mcp_unreachable",
    { cause: error },
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
    if (addresses.length === 0) {
      callback(Object.assign(new Error("MCP endpoint did not resolve to an address"), { code: "EACCES" }), "", 0);
      return;
    }
    if (addresses.some(({ address }) => !isManagedMcpAddressAllowed(address))) {
      callback(new ManagedMcpLookupBlockedError(), "", 0);
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

export function createSafeFetch(
  // Non-MCP callers keep their existing fetch error contract.
  opts: { timeoutMs?: number; reportPolicyRefusal?: boolean } = {},
): { fetch: typeof globalThis.fetch; close: () => Promise<void> } {
  const timeoutMs = opts.timeoutMs ?? MCP_TIMEOUT_MS;
  const dispatcher = new Agent({
    connect: { lookup: safeLookup as never },
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    maxResponseSize: MCP_MAX_HTTP_RESPONSE_BYTES,
  });
  const fetch = ((input: URL | RequestInfo, init?: RequestInit) => {
    const rawUrl = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
    validateManagedMcpEndpoint(rawUrl);
    return undiciFetch(input as never, {
      ...init,
      redirect: "error",
      dispatcher,
    } as never).catch((error: unknown) => {
      if (opts.reportPolicyRefusal && isManagedMcpLookupBlocked(error)) {
        throw new ManagedMcpGatewayError("The server's network security check blocked this address", "managed_mcp_endpoint_blocked", { cause: error });
      }
      throw error;
    }) as unknown as Promise<Response>;
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

export function normalizeManagedMcpClientErrorForConnection(
  error: unknown,
  timedOut: boolean,
  headers: Record<string, string>,
  authProvider?: OAuthClientProvider,
  authKind: ManagedMcpAuthKind = "none",
): ManagedMcpGatewayError {
  const effectiveAuthKind = authProvider
    ? "oauth"
    : authKind === "none" && Object.keys(headers).length > 0
      ? "headers"
      : authKind;
  return normalizeManagedMcpClientError(error, timedOut, effectiveAuthKind);
}

const OAUTH_FAILURE_DETAIL_MAX = 300;
const OAUTH_ERROR_CODE = /^[a-z0-9_.-]{1,64}$/iu;
const SECRET_KEYS = "access_token|refresh_token|id_token|client_secret|code_verifier|code|password|secret|token|api[_-]?key|authorization";
// A quoted value is replaced whole (it may contain spaces); an unquoted one up to its delimiter.
const QUOTED_SECRET_ASSIGNMENT = new RegExp(`\\b(${SECRET_KEYS})(["']?\\s*[:=]\\s*)("|')(?:(?!\\3)[^\\\\]|\\\\.)*\\3`, "giu");
const SECRET_ASSIGNMENT = new RegExp(`\\b(${SECRET_KEYS})(["']?\\s*[:=]\\s*["']?)[^\\s"'&,;]+`, "giu");
const BEARER = /\b(bearer|basic)\s+[^\s"',;]+/giu;
// Opaque credentials (Google access tokens, JWTs) are long unbroken runs; URLs break on "/" and ":".
const OPAQUE = /[A-Za-z0-9._~+-]{40,}/gu;

function redactOAuthFailureText(text: string): string {
  return text
    .replace(BEARER, "$1 [redacted]")
    .replace(QUOTED_SECRET_ASSIGNMENT, "$1$2$3[redacted]$3")
    .replace(SECRET_ASSIGNMENT, "$1$2[redacted]")
    .replace(OPAQUE, "[redacted]")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Only a provider's human-readable message field; any other body shape yields nothing. */
function httpErrorMessage(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as { error?: unknown; error_description?: unknown; message?: unknown };
  const nested = record.error && typeof record.error === "object" ? (record.error as { message?: unknown }).message : undefined;
  const candidate = [nested, record.error_description, record.message].find((value) => typeof value === "string" && value.trim());
  return typeof candidate === "string" ? candidate : null;
}

/**
 * The provider's own reason behind a failed sign-in step, safe for a Connection's status line and
 * a log entry: the OAuth error code with its description, or the MCP endpoint's HTTP status with
 * the message field of its JSON error (Google says which API is disabled there). Only those fields
 * are read, credential-shaped text is redacted before truncation, and anything else, including
 * Raft's own internal errors, yields null so the caller shows a generic line.
 */
export function managedMcpOAuthFailureDetail(error: unknown): string | null {
  let root: unknown = error;
  while (root instanceof ManagedMcpGatewayError && root.cause !== undefined) root = root.cause;
  let detail: string;
  if (root instanceof OAuthError) {
    const code = OAUTH_ERROR_CODE.test(root.errorCode) ? root.errorCode : "oauth_error";
    // The SDK wraps a body that is not an OAuth error as `HTTP <status>: ... Raw body: <body>`;
    // keep only the status from it, never the body.
    const unparsed = /Invalid OAuth error response|Raw body:/u.test(root.message);
    const status = unparsed ? /^HTTP (\d{3})\b/u.exec(root.message)?.[1] : undefined;
    const description = unparsed
      ? (status ? `HTTP ${status}` : "")
      : root.message && root.message !== root.errorCode ? redactOAuthFailureText(root.message) : "";
    detail = description ? `${code}: ${description}` : code;
  } else if (root instanceof StreamableHTTPError && root.code !== undefined && root.code > 0) {
    const body = root.message.replace(/^Streamable HTTP error: (Error POSTing to endpoint: )?/u, "");
    const message = httpErrorMessage(body);
    detail = message ? `HTTP ${root.code}: ${redactOAuthFailureText(message)}` : `HTTP ${root.code}`;
  } else {
    return null;
  }
  return detail.length > OAUTH_FAILURE_DETAIL_MAX ? `${detail.slice(0, OAUTH_FAILURE_DETAIL_MAX - 1)}…` : detail;
}

/**
 * The provider's failure as a fixed vocabulary only: a standard OAuth error code (RFC 6749 / 6750) or
 * an HTTP status. Unlike `managedMcpOAuthFailureDetail` it never carries provider-supplied text, so
 * it can go on a tool call's status line and into the log.
 */
const STANDARD_OAUTH_ERROR_CODES = new Set([
  "invalid_request", "invalid_client", "invalid_grant", "unauthorized_client", "unsupported_grant_type",
  "invalid_scope", "invalid_token", "insufficient_scope", "access_denied", "server_error", "temporarily_unavailable",
]);

export function managedMcpOAuthFailureCategory(error: unknown): string | null {
  let root: unknown = error;
  while (root instanceof ManagedMcpGatewayError && root.cause !== undefined) root = root.cause;
  if (root instanceof OAuthError) return STANDARD_OAUTH_ERROR_CODES.has(root.errorCode) ? root.errorCode : "oauth_error";
  if (root instanceof StreamableHTTPError && Number.isInteger(root.code) && root.code! >= 100 && root.code! <= 599) return `HTTP ${root.code}`;
  return null;
}

async function withClient<T>(
  endpoint: string,
  headers: Record<string, string>,
  operation: (client: Client, signal: AbortSignal) => Promise<T>,
  authProvider?: OAuthClientProvider,
  authKind: ManagedMcpAuthKind = "none",
): Promise<T> {
  const url = validateManagedMcpEndpoint(endpoint);
  const controller = new AbortController();
  const timeout = setClockTimeout(() => controller.abort(), MCP_TIMEOUT_MS);
  const client = new Client({ name: "raft-managed-mcp", version: "1.0.0" });
  const safeFetch = createSafeFetch({ reportPolicyRefusal: true });
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
    throw normalizeManagedMcpClientErrorForConnection(error, controller.signal.aborted, headers, authProvider, authKind);
  } finally {
    clearClockTimeout(timeout);
    await client.close().catch(() => undefined);
    await safeFetch.close().catch(() => undefined);
  }
}

export async function collectManagedMcpTools(client: Pick<Client, "listTools">, signal: AbortSignal): Promise<ManagedMcpToolCatalogEntry[]> {
  const tools: ManagedMcpToolCatalogEntry[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, { signal, timeout: MCP_TIMEOUT_MS });
    tools.push(...normalizeManagedMcpToolCatalog(page.tools));
    // Check cumulative count/size and duplicate names, not just each page.
    normalizeManagedMcpToolCatalog(tools);
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      if (!cursor || cursors.has(cursor) || cursors.size >= MANAGED_MCP_MAX_TOOLS_PER_SERVER) {
        throw new ManagedMcpGatewayError("MCP tool pagination did not terminate", "managed_mcp_catalog_invalid");
      }
      cursors.add(cursor);
    }
  } while (cursor !== undefined);
  return tools;
}

export async function listManagedMcpTools(endpoint: string, headers: Record<string, string>): Promise<ManagedMcpToolCatalogEntry[]> {
  return withClient(endpoint, headers, async (client, signal) => {
    return collectManagedMcpTools(client, signal);
  });
}

/**
 * Why starting a sign-in failed. Providers such as Google publish neither a registration endpoint
 * nor client metadata document support, so automatic registration cannot work there; the SDK
 * reports that only as a plain Error with this wording, which the test pins against the SDK.
 */
export function managedMcpOAuthStartError(error: unknown): ManagedMcpGatewayError {
  if (error instanceof ManagedMcpGatewayError && error.code === "managed_mcp_endpoint_blocked") return error;
  if (error instanceof Error && error.message.includes("does not support dynamic client registration")) {
    return new ManagedMcpGatewayError(
      "This MCP server does not support automatic client registration; register an OAuth client with the provider and enter it",
      "managed_mcp_oauth_client_registration_unsupported",
    );
  }
  return new ManagedMcpGatewayError(
    "MCP OAuth setup failed; check the client configuration and provider requirements",
    "managed_mcp_unreachable",
  );
}

export async function startManagedMcpOAuth(
  endpoint: string,
  provider: OAuthClientProvider,
  /** Tests only: answers discovery in place of the network. */
  fetchFn?: typeof fetch,
): Promise<"AUTHORIZED" | "REDIRECT"> {
  const url = validateManagedMcpEndpoint(endpoint);
  const safeFetch = createSafeFetch({ reportPolicyRefusal: true });
  try {
    // The client's scope, when set, is the whole request; the SDK falls back to the server's
    // full scopes_supported only when it is not.
    return await auth(provider, { serverUrl: url, scope: provider.clientMetadata.scope, fetchFn: fetchFn ?? safeFetch.fetch });
  } catch (error) {
    throw managedMcpOAuthStartError(error);
  } finally {
    await safeFetch.close().catch(() => undefined);
  }
}

export async function completeManagedMcpOAuth(
  endpoint: string,
  provider: OAuthClientProvider,
  authorizationCode: string,
  /** Tests only: answers discovery and the token endpoint in place of the network. */
  fetchFn?: typeof fetch,
): Promise<void> {
  const url = validateManagedMcpEndpoint(endpoint);
  const safeFetch = createSafeFetch({ reportPolicyRefusal: true });
  try {
    const result = await auth(provider, { serverUrl: url, authorizationCode, fetchFn: fetchFn ?? safeFetch.fetch });
    if (result !== "AUTHORIZED") {
      throw new ManagedMcpGatewayError("MCP OAuth did not complete", "managed_mcp_oauth_required");
    }
  } catch (error) {
    if (error instanceof ManagedMcpGatewayError) throw error;
    throw new ManagedMcpGatewayError(
      "MCP OAuth token exchange failed; check the client configuration and reconnect",
      "managed_mcp_unreachable",
      { cause: error },
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
    return collectManagedMcpTools(client, signal);
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
