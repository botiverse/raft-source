/**
 * Probe for a pasted MCP server URL: what it takes to use it. Nothing is persisted; creating an
 * App re-runs the probe server-side, so a client's result is never authoritative.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  extractResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import {
  clearClockTimeout,
  setClockTimeout,
  type ManagedMcpToolCatalogEntry,
} from "@botiverse/raft-shared";
import { createSafeFetch, ManagedMcpGatewayError, normalizeManagedMcpToolCatalog } from "./managedMcpGateway";
import { validateManagedMcpConfiguredEndpoint } from "./managedMcpService";

const PROBE_TIMEOUT_MS = 15_000;

export type McpProbeOutcome = "ready" | "oauth" | "headers" | "unreachable";
export type McpOAuthRegistration = "dcr" | "cimd" | "manual_required";

export interface McpProbeResult {
  endpointUrl: string;
  outcome: McpProbeOutcome;
  latencyMs: number | null;
  serverInfo?: { protocolVersion: string; name?: string; version?: string };
  /** `ready` only. */
  tools?: { count: number; names: string[] };
  oauth?: { issuer: string; registration: McpOAuthRegistration; scopes: string[] };
  suggestedHeaderNames?: string[];
  error?: { code: string; message: string };
}

type FetchLike = typeof globalThis.fetch;

/**
 * The probe plus, for a `ready` server, its full tool catalogue (the public result carries names
 * only). `fetch` is a test seam; production always uses the SSRF-safe fetch.
 */
export async function probeManagedMcpEndpointWithCatalog(
  rawEndpointUrl: string,
  deps: { fetch?: FetchLike; timeoutMs?: number } = {},
): Promise<{ result: McpProbeResult; toolCatalog: ManagedMcpToolCatalogEntry[] | null }> {
  // Invalid or blocked URLs are refused before any I/O (a 400, not an outcome).
  const url = validateManagedMcpConfiguredEndpoint(rawEndpointUrl);
  const endpointUrl = url.toString();
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  // ONE deadline for the whole probe: the handshake AND the metadata discovery after a 401. Every
  // request is tied to `controller.signal`; on its own the SDK's discovery can make ~10 sequential
  // requests, each of which would otherwise get the full per-request timeout.
  const controller = new AbortController();
  const safeFetch = deps.fetch ? null : createSafeFetch({ timeoutMs, reportPolicyRefusal: true });
  const rawFetch = (deps.fetch ?? safeFetch!.fetch) as FetchLike;
  const baseFetch: FetchLike = (input, init) => rawFetch(input, {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
  });
  // The MCP endpoint's own last HTTP answer: what an unauthenticated client was told.
  let endpointStatus: number | null = null;
  let endpointHeaders: Headers | null = null;
  const recordingFetch: FetchLike = async (input, init) => {
    const response = await baseFetch(input, init);
    const requested = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
    if (requested === endpointUrl) {
      endpointStatus = response.status;
      endpointHeaders = response.headers;
    }
    return response;
  };
  const timer = setClockTimeout(() => controller.abort(), timeoutMs);
  const client = new Client({ name: "raft-managed-mcp", version: "1.0.0" });
  const startedAt = Date.now();
  const latency = () => Date.now() - startedAt;
  try {
    const transport = new StreamableHTTPClientTransport(url, {
      fetch: recordingFetch,
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1_000, maxReconnectionDelay: 1_000, reconnectionDelayGrowFactor: 1 },
    });
    try {
      await client.connect(transport, { signal: controller.signal, timeout: timeoutMs });
      const listed = await client.listTools(undefined, { signal: controller.signal, timeout: timeoutMs });
      const toolCatalog = normalizeManagedMcpToolCatalog(listed.tools);
      const version = client.getServerVersion();
      // Some servers (Google's Workspace MCP) answer the handshake and tools/list without a token and
      // only refuse tool calls, so "ready" alone is not "no sign-in". One that publishes RFC 9728
      // protected-resource metadata naming an authorization server is an OAuth server.
      const advertised = await classifyAdvertisedOAuth(url, recordingFetch, latency(), controller.signal);
      if (advertised.kind === "blocked") {
        return { result: { endpointUrl, outcome: "unreachable", latencyMs: null, error: { code: advertised.error.code, message: advertised.error.message } }, toolCatalog: null };
      }
      if (advertised.kind === "incomplete") {
        return {
          result: {
            endpointUrl,
            outcome: "unreachable",
            latencyMs: null,
            error: { code: "managed_mcp_unreachable", message: "Could not finish checking how this MCP server signs in; try again" },
          },
          toolCatalog: null,
        };
      }
      if (advertised.kind === "oauth") {
        // Tools were listed without a token, so the App may still be added without sign-in; the
        // catalogue is kept for that choice (the create route re-probes and checks it).
        return {
          result: { ...advertised.result, tools: { count: toolCatalog.length, names: toolCatalog.map((tool) => tool.name) } },
          toolCatalog,
        };
      }
      return {
        result: {
          endpointUrl,
          outcome: "ready",
          latencyMs: latency(),
          serverInfo: {
            protocolVersion: transport.protocolVersion ?? "unknown",
            ...(version?.name ? { name: version.name } : {}),
            ...(version?.version ? { version: version.version } : {}),
          },
          tools: { count: toolCatalog.length, names: toolCatalog.map((tool) => tool.name) },
        },
        toolCatalog,
      };
    } catch (error) {
      const latencyMs = latency();
      if (error instanceof ManagedMcpGatewayError && error.code === "managed_mcp_catalog_invalid") {
        return { result: { endpointUrl, outcome: "unreachable", latencyMs, error: { code: error.code, message: error.message } }, toolCatalog: null };
      }
      if (error instanceof ManagedMcpGatewayError && error.code === "managed_mcp_endpoint_blocked") {
        return { result: { endpointUrl, outcome: "unreachable", latencyMs: null, error: { code: error.code, message: error.message } }, toolCatalog: null };
      }
      const status = endpointStatus as number | null;
      if (status === 401 && !controller.signal.aborted) {
        try {
          const classified = await classifyUnauthorized(url, endpointHeaders, recordingFetch, latencyMs);
          // Discovery swallows ordinary errors; a deadline hit there is still "did not answer in time",
          // not a guess of "headers" from metadata that never arrived.
          if (!controller.signal.aborted) return { result: classified, toolCatalog: null };
        } catch (discoveryError) {
          if (discoveryError instanceof ManagedMcpGatewayError && discoveryError.code === "managed_mcp_endpoint_blocked") {
            return { result: { endpointUrl, outcome: "unreachable", latencyMs: null, error: { code: discoveryError.code, message: discoveryError.message } }, toolCatalog: null };
          }
          throw discoveryError;
        }
      }
      if (status === 403) {
        return { result: { endpointUrl, outcome: "headers", latencyMs, suggestedHeaderNames: ["Authorization"] }, toolCatalog: null };
      }
      return {
        result: {
          endpointUrl,
          outcome: "unreachable",
          latencyMs: null,
          error: {
            code: "managed_mcp_unreachable",
            message: controller.signal.aborted
              ? "MCP server did not answer in time"
              : status !== null ? `MCP server answered HTTP ${status}` : "MCP server could not be reached",
          },
        },
        toolCatalog: null,
      };
    }
  } finally {
    clearClockTimeout(timer);
    await client.close().catch(() => undefined);
    await safeFetch?.close().catch(() => undefined);
  }
}

export async function probeManagedMcpEndpoint(rawEndpointUrl: string, deps: { fetch?: FetchLike } = {}): Promise<McpProbeResult> {
  return (await probeManagedMcpEndpointWithCatalog(rawEndpointUrl, deps)).result;
}

/**
 * A 401: find the authorization server (RFC 9728 protected-resource metadata, else the server's
 * own origin, the way the SDK's `auth()` falls back) and how Raft could register a client with it.
 * No authorization-server metadata at all means the server wants a key, not OAuth.
 */
async function classifyUnauthorized(
  url: URL,
  headers: Headers | null,
  fetchFn: FetchLike,
  latencyMs: number,
): Promise<McpProbeResult> {
  const endpointUrl = url.toString();
  const resourceMetadataUrl = headers ? extractResourceMetadataUrl(new Response(null, { headers })) : undefined;
  const resourceMetadata = await discoverOAuthProtectedResourceMetadata(
    url,
    resourceMetadataUrl ? { resourceMetadataUrl } : {},
    fetchFn,
  ).catch(ignoreNonPolicyDiscoveryError);
  const authorizationServer = resourceMetadata?.authorization_servers?.[0] ?? new URL("/", url).toString();
  return await oauthProbeResult(endpointUrl, authorizationServer, resourceMetadata?.scopes_supported, fetchFn, latencyMs)
    ?? { endpointUrl, outcome: "headers", latencyMs, suggestedHeaderNames: ["Authorization"] };
}

/**
 * A server that worked without a token: OAuth only when it publishes protected-resource metadata
 * for THIS endpoint (the resource check sign-in applies) naming an authorization server whose
 * metadata answers. "No metadata" (4xx, malformed, wrong resource, no authorization server) keeps
 * it `ready`; a check that did not finish (network error, 5xx, the probe deadline) is `incomplete`,
 * never saved as "no sign-in". No fallback to the server's own origin, unlike after a 401.
 */
async function classifyAdvertisedOAuth(
  url: URL,
  fetchFn: FetchLike,
  latencyMs: number,
  signal: AbortSignal,
): Promise<
  | { kind: "none" }
  | { kind: "incomplete" }
  | { kind: "blocked"; error: ManagedMcpGatewayError }
  | { kind: "oauth"; result: McpProbeResult }
> {
  let unfinished = false;
  let blocked: ManagedMcpGatewayError | null = null;
  // Discovery goes through the SDK's own functions, so the requests (headers, path-aware then root
  // address) are the ones sign-in will send. Those functions treat a network failure like "not
  // found"; watching the requests is what tells the two apart. Each successful body is read here,
  // so a response cut off mid-read is "unfinished" and only a complete body that does not parse is
  // "malformed". A destination the network policy refuses is reported as such, as after a 401.
  const watchedFetch: FetchLike = async (input, init) => {
    try {
      const response = await fetchFn(input, init);
      if (response.status >= 500) unfinished = true;
      if (!response.ok) return response;
      const body = await response.text();
      // A 204/205 has no body, and the Response constructor refuses one (even "") for it.
      const bodyless = response.status === 204 || response.status === 205;
      return new Response(bodyless ? null : body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      if (error instanceof ManagedMcpGatewayError && error.code === "managed_mcp_endpoint_blocked") blocked ??= error;
      else unfinished = true;
      throw error;
    }
  };
  const outcome = () => blocked
    ? { kind: "blocked" as const, error: blocked }
    : unfinished || signal.aborted ? { kind: "incomplete" as const } : null;
  const resourceMetadata = await discoverOAuthProtectedResourceMetadata(url, {}, watchedFetch).catch(() => undefined);
  const stopped = outcome();
  if (stopped) return stopped;
  const authorizationServer = resourceMetadata?.authorization_servers?.[0];
  if (!resourceMetadata || !authorizationServer) return { kind: "none" };
  if (!checkResourceAllowed({ requestedResource: resourceUrlFromServerUrl(url), configuredResource: resourceMetadata.resource })) {
    return { kind: "none" };
  }
  let result: McpProbeResult | null = null;
  try {
    result = await oauthProbeResult(url.toString(), authorizationServer, resourceMetadata.scopes_supported, watchedFetch, latencyMs);
  } catch {
    // A refusal by the network policy was recorded above; anything else that throws is malformed.
  }
  return outcome() ?? (result ? { kind: "oauth", result } : { kind: "none" });
}

async function oauthProbeResult(
  endpointUrl: string,
  authorizationServer: string,
  resourceScopes: string[] | undefined,
  fetchFn: FetchLike,
  latencyMs: number,
): Promise<McpProbeResult | null> {
  const metadata = await discoverAuthorizationServerMetadata(authorizationServer, { fetchFn }).catch(ignoreNonPolicyDiscoveryError);
  if (!metadata) return null;
  const registration: McpOAuthRegistration = metadata.registration_endpoint
    ? "dcr"
    : (metadata as { client_id_metadata_document_supported?: boolean }).client_id_metadata_document_supported
      ? "cimd"
      : "manual_required";
  return {
    endpointUrl,
    outcome: "oauth",
    latencyMs,
    oauth: {
      issuer: metadata.issuer,
      registration,
      scopes: resourceScopes ?? metadata.scopes_supported ?? [],
    },
  };
}

function ignoreNonPolicyDiscoveryError(error: unknown): undefined {
  if (error instanceof ManagedMcpGatewayError && error.code === "managed_mcp_endpoint_blocked") throw error;
  return undefined;
}
