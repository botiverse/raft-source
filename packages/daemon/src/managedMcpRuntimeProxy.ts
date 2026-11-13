import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  type ManagedMcpCallRequest,
  type ManagedMcpCallResult,
  type ManagedMcpRuntimeSnapshot,
} from "@botiverse/raft-shared";
import { applyLoopbackNoProxyEnv } from "./loopbackNoProxy";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { logger } from "./logger";
import { managedMcpRefusalGuidance } from "./managedMcpRefusal";
import {
  confirmRuntimeTurnOrigin,
  type RuntimeTurnOriginReader,
} from "./runtimeTurnOrigin";

const HOST = "127.0.0.1";
const MAX_REQUEST_BYTES = 1024 * 1024;

const MANAGED_MCP_RUNTIME_SERVER_NAME_PREFIX = "rm";
const MAX_NATIVE_MCP_TOOL_NAME_LENGTH = 48;

type ManagedMcpDiscoveryUnavailableReason =
  | "missing_server_url"
  | "missing_agent_credential"
  | "unsupported_catalog_version"
  | "discovery_failed";

type Registration = {
  agentId: string;
  launchId: string | null;
  /**
   * The process this registration was created for, and that process's turn-origin getter. A call
   * carries an origin only when the getter's snapshot names this same process instance -- never an
   * agent-wide or "most recent" value (task #21, @peng).
   */
  processInstanceId?: string | null;
  readTurnOrigin?: RuntimeTurnOriginReader;
  snapshot: ManagedMcpRuntimeSnapshot;
  loadSnapshot?: () => Promise<ManagedMcpRuntimeSnapshot>;
  callTool: (request: ManagedMcpCallRequest) => Promise<ManagedMcpCallResult>;
};

type ProxyState = {
  server: http.Server;
  baseUrl: string;
};

const registrations = new Map<string, Registration>();
const launchCleanups = new Map<string, Set<() => void>>();
let proxyState: ProxyState | null = null;
let proxyStart: Promise<ProxyState> | null = null;

type JsonConfigLayer = {
  id: string;
  apply: (config: Record<string, unknown>) => Record<string, unknown>;
};

type JsonConfigState = {
  original: string | null;
  originalMode: number | null;
  lastWritten: string | null;
  layers: Map<string, JsonConfigLayer>;
};

const jsonConfigStates = new Map<string, JsonConfigState>();

function emitManagedMcpDiscoveryWarning(
  input: {
    agentId: string;
    onWarning?: (message: string) => void;
  },
  reason: ManagedMcpDiscoveryUnavailableReason,
  detail = "",
): void {
  const warning = `Managed MCP discovery unavailable for this session [reason=${reason}${detail}]`;
  if (input.onWarning) input.onWarning(warning);
  else logger.warn(`[Agent ${input.agentId}] ${warning}`);
}

function managedMcpDiscoveryFailureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const httpStatus = /\bHTTP ([1-5][0-9]{2})\b/u.exec(message)?.[1];
  if (httpStatus) return `,http_status=${httpStatus}`;
  if (error instanceof TypeError) return ",transport=network";
  return "";
}

function launchKey(
  agentId: string,
  launchId: string | null | undefined,
): string {
  return `${agentId}\u0000${launchId ?? ""}`;
}

function registerLaunchCleanup(
  input: { agentId: string; launchId?: string | null },
  cleanup: () => void,
): void {
  const key = launchKey(input.agentId, input.launchId);
  const cleanups = launchCleanups.get(key) ?? new Set<() => void>();
  cleanups.add(cleanup);
  launchCleanups.set(key, cleanups);
}

function runLaunchCleanups(input: {
  agentId: string;
  launchId?: string | null;
}): void {
  const key = launchKey(input.agentId, input.launchId);
  const cleanups = launchCleanups.get(key);
  launchCleanups.delete(key);
  if (!cleanups) return;
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch {
      // Cleanup is best-effort. Registration removal already revoked the URL.
    }
  }
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "runtime";
}

export function writeManagedMcpRuntimeConfigFile(input: {
  agentId: string;
  launchId?: string | null;
  slockHome: string;
  runtime: string;
  filename: string;
  content: string;
}): string {
  const directory = path.join(
    input.slockHome,
    "managed-mcp-runtime",
    safePathSegment(input.agentId),
    safePathSegment(input.launchId ?? "launch"),
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filePath = path.join(
    directory,
    `${safePathSegment(input.runtime)}-${safePathSegment(input.filename)}`,
  );
  writeFileSync(filePath, input.content, { encoding: "utf8", mode: 0o600 });
  chmodSync(filePath, 0o600);
  registerLaunchCleanup(input, () => {
    rmSync(filePath, { force: true });
  });
  return filePath;
}

function parseJsonObject(
  raw: string | null,
  filePath: string,
): Record<string, unknown> {
  if (raw === null || raw.trim() === "") return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Managed MCP cannot overlay non-object JSON config ${filePath}`,
    );
  }
  return parsed as Record<string, unknown>;
}

function renderJsonConfig(filePath: string, state: JsonConfigState): string {
  let config = parseJsonObject(state.original, filePath);
  for (const layer of state.layers.values()) config = layer.apply(config);
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function installManagedMcpRuntimeJsonOverlay(input: {
  agentId: string;
  launchId?: string | null;
  filePath: string;
  apply: (config: Record<string, unknown>) => Record<string, unknown>;
}): void {
  let state = jsonConfigStates.get(input.filePath);
  if (!state) {
    const original = existsSync(input.filePath)
      ? readFileSync(input.filePath, "utf8")
      : null;
    // Validate before touching a user-owned file.
    parseJsonObject(original, input.filePath);
    state = {
      original,
      originalMode:
        original === null ? null : statSync(input.filePath).mode & 0o777,
      lastWritten: original,
      layers: new Map(),
    };
    jsonConfigStates.set(input.filePath, state);
  }

  const layerId = randomBytes(16).toString("hex");
  state.layers.set(layerId, { id: layerId, apply: input.apply });
  const rendered = renderJsonConfig(input.filePath, state);
  mkdirSync(path.dirname(input.filePath), { recursive: true });
  // `mode` only applies to a new file: narrow a user's 0644 file before it holds the token.
  if (existsSync(input.filePath)) chmodSync(input.filePath, 0o600);
  writeFileSync(input.filePath, rendered, { encoding: "utf8", mode: 0o600 });
  state.lastWritten = rendered;

  registerLaunchCleanup(input, () => {
    const current = existsSync(input.filePath)
      ? readFileSync(input.filePath, "utf8")
      : null;
    if (current !== state?.lastWritten) {
      jsonConfigStates.delete(input.filePath);
      return;
    }
    state.layers.delete(layerId);
    if (state.layers.size > 0) {
      const next = renderJsonConfig(input.filePath, state);
      writeFileSync(input.filePath, next, { encoding: "utf8", mode: 0o600 });
      state.lastWritten = next;
      return;
    }
    if (state.original === null) {
      rmSync(input.filePath, { force: true });
    } else {
      writeFileSync(input.filePath, state.original, {
        encoding: "utf8",
        mode: state.originalMode ?? 0o600,
      });
      if (state.originalMode !== null)
        chmodSync(input.filePath, state.originalMode);
    }
    jsonConfigStates.delete(input.filePath);
  });
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_REQUEST_BYTES)
      throw new Error("managed MCP runtime request is too large");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

async function requestAgentApi<T>(input: {
  serverUrl: string;
  token: string;
  path: string;
  body?: unknown;
}): Promise<T> {
  const response = await fetch(new URL(input.path, input.serverUrl), {
    method: input.body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "X-Slock-Agent-Active-Capabilities": "mcp",
      ...(input.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    signal: AbortSignal.timeout(25_000),
  });
  const payload = (await response.json().catch(() => null)) as
    | T
    | { error?: unknown; code?: unknown; connectionRequested?: unknown; suggestedNextAction?: unknown }
    | null;
  if (!response.ok) {
    // The Server's own sentence plus what happens next. Previously this surfaced only
    // `HTTP 409 (some_code)`, which tells the model nothing it can act on.
    const code =
      typeof (payload as { code?: unknown } | null)?.code === "string"
        ? (payload as { code: string }).code
        : null;
    const message =
      typeof (payload as { error?: unknown } | null)?.error === "string"
        ? (payload as { error: string }).error
        : `Raft MCP gateway request failed: HTTP ${response.status}`;
    const connectionRequested =
      (payload as { connectionRequested?: unknown } | null)?.connectionRequested === true;
    const agentWorded =
      typeof (payload as { suggestedNextAction?: unknown } | null)?.suggestedNextAction === "string";
    throw new Error(managedMcpRefusalGuidance({ message, code, connectionRequested, agentWorded }));
  }
  return payload as T;
}

function toolError(error: unknown): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text:
          error instanceof Error
            ? error.message.slice(0, 500)
            : "Managed MCP tool call failed",
      },
    ],
  };
}

function nativeMcpToolName(runtimeName: string, toolName: string): string {
  const digest = createHash("sha256")
    .update(runtimeName)
    .digest("hex")
    .slice(0, 8);
  const readable = toolName.replace(/[^a-zA-Z0-9_-]+/g, "_") || "tool";
  const prefix = `r${digest}_`;
  return `${prefix}${readable.slice(0, MAX_NATIVE_MCP_TOOL_NAME_LENGTH - prefix.length)}`;
}

async function loadNativeTools(registration: Registration) {
  const snapshot = registration.loadSnapshot
    ? await registration.loadSnapshot()
    : registration.snapshot;
  if (snapshot.catalogVersion !== 1) {
    throw new Error(
      `Unsupported managed MCP catalog version ${snapshot.catalogVersion}`,
    );
  }
  registration.snapshot = snapshot;
  return snapshot.tools.map((tool) => ({
    nativeName: nativeMcpToolName(tool.runtimeName, tool.toolName),
    tool,
  }));
}

function createMcpServer(registration: Registration): Server {
  const server = new Server(
    { name: "raft-managed-mcp-runtime", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const nativeTools = await loadNativeTools(registration);
    return {
      tools: nativeTools.map(({ nativeName, tool }) => ({
        name: nativeName,
        ...(tool.title ? { title: tool.title } : {}),
        description: tool.description
          ? `${tool.description}\n\nManaged MCP source: ${tool.serverName} / ${tool.toolName}.`
          : `Call ${tool.toolName} on ${tool.serverName}.`,
        inputSchema: tool.inputSchema,
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      })),
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    // Read the turn origin FIRST, before any await: this is the turn the runtime issued the call in.
    // It is re-confirmed just before forwarding, so a turn that ends during the snapshot reload
    // sends the call without an origin instead of with the next turn's.
    const capturedOrigin = registration.readTurnOrigin?.() ?? null;
    try {
      const nativeTools = await loadNativeTools(registration);
      const tool = nativeTools.find(
        (candidate) => candidate.nativeName === request.params.name,
      )?.tool;
      if (!tool) {
        return toolError(
          new Error(
            `Managed MCP tool ${request.params.name} is not currently available to this Agent`,
          ),
        );
      }
      const origin = confirmRuntimeTurnOrigin({
        read: registration.readTurnOrigin,
        captured: capturedOrigin,
        expectedProcessInstanceId: registration.processInstanceId,
      });
      const result = await registration.callTool({
        mcpServerId: tool.mcpServerId,
        toolName: tool.toolName,
        arguments: request.params.arguments ?? {},
        expectedConfigVersion: tool.configVersion,
        expectedAssignmentVersion: tool.assignmentVersion,
        ...(origin ? { origin } : {}),
      });
      return result as CallToolResult;
    } catch (error) {
      return toolError(error);
    }
  });
  return server;
}

async function handleRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const pathname = new URL(request.url ?? "/", "http://managed-mcp.local")
    .pathname;
  // The token is in the path, or (runtimes that read it from their own
  // environment, so it never sits in a process's arguments) a bearer header.
  const token = pathname.startsWith("/mcp/")
    ? pathname.slice("/mcp/".length)
    : pathname === "/mcp"
      ? bearerToken(request.headers.authorization)
      : "";
  const registration = registrations.get(token);
  if (!registration) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ error: "managed MCP runtime endpoint not found" }),
    );
    return;
  }

  const server = createMcpServer(registration);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    const body =
      request.method === "POST" ? await readJsonBody(request) : undefined;
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
  } catch (error) {
    if (!response.headersSent) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32603,
            message:
              error instanceof Error
                ? error.message.slice(0, 500)
                : "Managed MCP runtime proxy failed",
          },
        }),
      );
    } else if (!response.writableEnded) {
      response.end();
    }
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

async function ensureProxy(): Promise<ProxyState> {
  if (proxyState) return proxyState;
  if (!proxyStart) {
    proxyStart = new Promise<ProxyState>((resolve, reject) => {
      const server = http.createServer((request, response) => {
        void handleRequest(request, response);
      });
      server.once("error", reject);
      server.listen(0, HOST, () => {
        server.off("error", reject);
        const address = server.address() as AddressInfo | null;
        if (!address) {
          reject(new Error("managed MCP runtime proxy did not bind"));
          return;
        }
        server.unref();
        resolve({ server, baseUrl: `http://${HOST}:${address.port}` });
      });
    });
  }
  try {
    proxyState = await proxyStart;
    return proxyState;
  } finally {
    proxyStart = null;
  }
}

function bearerToken(header: string | undefined): string {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  return match ? match[1] : "";
}

/**
 * A launch's managed MCP endpoint. `url` carries the token in its path, for
 * runtimes that read it from a 0600 file or their own environment;
 * `endpointUrl` + `token` (sent as `Authorization: Bearer`) is for config that
 * would otherwise put the URL in a process's arguments, which other OS users
 * can read.
 */
export interface ManagedMcpRuntimeEndpoint {
  name: string;
  url: string;
  endpointUrl: string;
  token: string;
}

export async function registerManagedMcpRuntimeProxy(
  input: Registration,
): Promise<ManagedMcpRuntimeEndpoint> {
  applyLoopbackNoProxyEnv(process.env);
  const state = await ensureProxy();
  const token = randomBytes(32).toString("base64url");
  registrations.set(token, input);
  const serverNameSuffix = token.replace(/[^a-zA-Z0-9]/g, "").slice(0, 6);
  return {
    // Alphanumeric and launch-unique keeps every supported runtime's config
    // grammar happy and cannot collide with a user's existing MCP server key.
    name: `${MANAGED_MCP_RUNTIME_SERVER_NAME_PREFIX}${serverNameSuffix}`,
    url: `${state.baseUrl}/mcp/${token}`,
    endpointUrl: `${state.baseUrl}/mcp`,
    token,
  };
}

export function unregisterManagedMcpRuntimeProxyForLaunch(input: {
  agentId: string;
  launchId?: string | null;
}): number {
  const launchId = input.launchId ?? null;
  let removed = 0;
  for (const [token, registration] of registrations) {
    if (
      registration.agentId === input.agentId &&
      registration.launchId === launchId
    ) {
      registrations.delete(token);
      removed += 1;
    }
  }
  runLaunchCleanups(input);
  return removed;
}

export function unregisterManagedMcpRuntimeProxiesForAgent(agentId: string): number {
  let removed = 0;
  for (const [token, registration] of registrations) {
    if (registration.agentId !== agentId) continue;
    registrations.delete(token);
    removed += 1;
  }
  const prefix = `${agentId}\u0000`;
  for (const key of [...launchCleanups.keys()]) {
    if (!key.startsWith(prefix)) continue;
    const launchId = key.slice(prefix.length) || null;
    runLaunchCleanups({ agentId, launchId });
  }
  return removed;
}

export async function prepareManagedMcpRuntimeProxy(input: {
  agentId: string;
  launchId?: string | null;
  processInstanceId?: string | null;
  readTurnOrigin?: RuntimeTurnOriginReader;
  serverUrl?: string | null;
  agentCredentialKey?: string | null;
  onWarning?: (message: string) => void;
  /**
   * Decides from the discovered snapshot whether this launch attaches the
   * server at all. Refused: nothing is registered and no token is minted.
   * Omitted: always attached (an empty catalog included).
   */
  admit?: (snapshot: ManagedMcpRuntimeSnapshot) => boolean | Promise<boolean>;
}): Promise<ManagedMcpRuntimeEndpoint | null> {
  if (!input.serverUrl) {
    emitManagedMcpDiscoveryWarning(input, "missing_server_url");
    return null;
  }
  if (!input.agentCredentialKey) {
    emitManagedMcpDiscoveryWarning(input, "missing_agent_credential");
    return null;
  }
  try {
    const snapshot = await requestAgentApi<ManagedMcpRuntimeSnapshot>({
      serverUrl: input.serverUrl,
      token: input.agentCredentialKey,
      path: "/internal/agent-api/mcp/tools",
    });
    if (snapshot.catalogVersion !== 1) {
      emitManagedMcpDiscoveryWarning(input, "unsupported_catalog_version");
      return null;
    }
    if (input.admit && !(await input.admit(snapshot))) return null;
    return await registerManagedMcpRuntimeProxy({
      agentId: input.agentId,
      launchId: input.launchId ?? null,
      processInstanceId: input.processInstanceId ?? null,
      ...(input.readTurnOrigin ? { readTurnOrigin: input.readTurnOrigin } : {}),
      snapshot,
      loadSnapshot: () =>
        requestAgentApi<ManagedMcpRuntimeSnapshot>({
          serverUrl: input.serverUrl!,
          token: input.agentCredentialKey!,
          path: "/internal/agent-api/mcp/tools",
        }),
      callTool: (request) =>
        requestAgentApi<ManagedMcpCallResult>({
          serverUrl: input.serverUrl!,
          token: input.agentCredentialKey!,
          path: "/internal/agent-api/mcp/call",
          body: request,
        }),
    });
  } catch (error) {
    emitManagedMcpDiscoveryWarning(
      input,
      "discovery_failed",
      managedMcpDiscoveryFailureDetail(error),
    );
    return null;
  }
}

export async function __resetManagedMcpRuntimeProxyForTest(): Promise<void> {
  for (const cleanups of launchCleanups.values()) {
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {
        // best-effort test cleanup
      }
    }
  }
  launchCleanups.clear();
  jsonConfigStates.clear();
  registrations.clear();
  const state = proxyState;
  proxyState = null;
  proxyStart = null;
  if (!state) return;
  const closed = new Promise<void>((resolve) =>
    state.server.close(() => resolve()),
  );
  state.server.closeAllConnections();
  await closed;
}
