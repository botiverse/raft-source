// Thin HTTP client for the agent-facing `raft` CLI. It keeps the command
// layer legacy-shaped while selecting the right transport/surface from
// `AgentContext.clientMode` (§11 contract enum, sign-locked by XX):
//   - legacy-machine: call existing `/internal/agent/:id/*` machine routes
//     with `sk_machine_*`. Pre-RFC-v0.8 daemons only.
//   - managed-runner: call the daemon-local proxy, which forwards to
//     `/internal/agent-api/*` with the daemon-held `sk_agent_*`. The bearer
//     in this CLI process is a short-lived proxy token, not sk_agent_*.
//   - self-hosted-runner: CLI calls `/internal/agent-api/*` directly with a
//     real `sk_agent_*` loaded from a profile credential file written by
//     `raft agent login`.
//     WIP(self-hosted-runner-layer1): profile credential + agent-api client
//     only; runner lifecycle/runtime integration is not implemented here.
//
// In managed-runner mode the local daemon-owned wrapper injects a
// local proxy token into this short-lived CLI process. The daemon proxy holds
// the sk_agent_* bearer in memory. The client rewrites legacy
// `/internal/agent/:id/*` calls to the id-less
// `/internal/agent-api/*` surface where the server derives acting identity
// from the credential row. The proxy forwards only these rewritten agent-api
// calls to the real server with the daemon-held credential.

import type { Dispatcher } from "undici";
import {
  guideAppCapabilities,
  MANUAL_CONTEXT_CAPABILITY,
  PLAN_UPGRADE_CARD_CAPABILITY,
  INBOX_ITEMS_CAPABILITY,
  RAFT_CLI_ENTRY_HEADER,
  RAFT_CLI_STABLE_ENTRY,
  RAFT_CLIENT_CAPABILITIES_HEADER,
  RAFT_CLIENT_VERSION_HEADER,
} from "@botiverse/raft-shared/src/agentCliSurface";
import { buildAgentApiEventsPath } from "./agentApiPath";
import type { AgentContext } from "./auth/env";
import { apiFailureError, localProxyLifecycleError } from "./core/apiFailure";
import { isHttpRedirect, requestJsonOverHttp, type JsonTransportInit, type TransportResponse } from "./httpTransport";
import { buildFetchDispatcher, describeFetchFailure, fetchWithDispatcher } from "./proxy";
import {
  boundedOriginalMessage,
  emitCliTransportNormalizedError,
  routeFamilyForPath,
  targetHostClassForUrl,
  upstreamLayerForFetchError,
} from "./transportTrace";
import { normalizeVersion, readCliVersion } from "./version";

/**
 * `X-Raft-Client-Capabilities` on every JSON and multipart request: the Manual
 * context contract, that `raft action prepare` posts `plan:upgrade` cards (so
 * the Server may hint one), and the guide-app tokens.
 */
const CLI_CLIENT_CAPABILITIES = [MANUAL_CONTEXT_CAPABILITY, PLAN_UPGRADE_CARD_CAPABILITY, INBOX_ITEMS_CAPABILITY, ...guideAppCapabilities()].join(",");

let cliVersionHeaderValue: string | null | undefined;

/** `X-Raft-Client-Version`: this CLI's version, so the server can split agent requests by it; null when unknown. */
function cliVersionHeader(): string | null {
  if (cliVersionHeaderValue === undefined) cliVersionHeaderValue = normalizeVersion(readCliVersion());
  return cliVersionHeaderValue;
}

type ProxyAwareRequestInit = RequestInit & { dispatcher?: Dispatcher };

type JsonTransport = (url: URL, init: JsonTransportInit) => Promise<TransportResponse>;
let jsonTransport: JsonTransport = requestJsonOverHttp;

/**
 * Test-only seam: route plain JSON requests through `transport` instead of
 * node:http (tests that stub `globalThis.fetch` pass a fetch adapter).
 * Returns the previous transport.
 */
export function setJsonTransportForTests(transport: JsonTransport): JsonTransport {
  const previous = jsonTransport;
  jsonTransport = transport;
  return previous;
}

/** A JsonTransport that sends through the current `globalThis.fetch`. */
export const globalFetchJsonTransport: JsonTransport = (url, init) => fetch(url, init);

export interface ApiResponse<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
  errorCode?: string | null;
  suggestedNextAction?: string | null;
  proxy?: ApiProxyDiagnostics | null;
  /** A refusal's parsed JSON body (`details` and all), for callers that explain it. */
  errorBody?: unknown;
}

export interface ApiProxyDiagnostics {
  layer?: string | null;
  correlationId?: string | null;
  failureClass?: string | null;
  causeCode?: string | null;
  routeFamily?: string | null;
  upstreamLayer?: string | null;
  upstreamStatus?: number | null;
  responseStarted?: boolean | null;
  responseComplete?: boolean | null;
  targetHostClass?: string | null;
  launchId?: string | null;
  downstreamCaller?: string | null;
  upstream?: string | null;
}

export interface BodyResponse {
  ok: boolean;
  status: number;
  response: Response;
  error: string | null;
  /** The Server's machine code (`errorCode` or `code` in a JSON error body, e.g. `HISTORY_LIMITED`). */
  errorCode?: string | null;
  /** The refusal's text step (`suggestedNextAction` or `suggested_next_action`), as on the JSON path. */
  suggestedNextAction?: string | null;
  /** A JSON refusal's parsed body (`details`, `suggestedNextAction` and all), as on the JSON path. */
  errorBody?: unknown;
}

export interface BinaryResponse {
  ok: boolean;
  status: number;
  body: Uint8Array;
  error: string | null;
  errorCode?: string | null;
  proxy?: ApiProxyDiagnostics | null;
  suggestedNextAction?: string | null;
  /** A JSON refusal's parsed body, so a binary route's refusal explains itself like a JSON route's. */
  errorBody?: unknown;
}

export class ApiClient {
  constructor(private readonly ctx: AgentContext) {}

  private usesAgentApiSurface(): boolean {
    return this.ctx.clientMode === "managed-runner" || this.ctx.clientMode === "self-hosted-runner";
  }

  private rewriteAgentCredentialPath(pathname: string): string {
    if (!this.usesAgentApiSurface()) return pathname;

    const attachmentDownload = /^\/api\/attachments\/([^/?]+)(.*)$/.exec(pathname);
    if (attachmentDownload) {
      return `/internal/agent-api/attachments/${attachmentDownload[1]}${attachmentDownload[2] ?? ""}`;
    }

    const agentPrefix = `/internal/agent/${encodeURIComponent(this.ctx.agentId)}`;
    if (!pathname.startsWith(agentPrefix)) return pathname;

    const suffix = pathname.slice(agentPrefix.length);
    if (suffix === "/server") return "/internal/agent-api/server";
    if (suffix === "/server/avatar") return "/internal/agent-api/server/avatar";
    if (suffix === "/send") return "/internal/agent-api/send";
    if (suffix.startsWith("/history")) return `/internal/agent-api/history${suffix.slice("/history".length)}`;
    if (suffix.startsWith("/search")) return `/internal/agent-api/search${suffix.slice("/search".length)}`;
    const messageResolve = /^\/messages\/([^/]+)\/resolve$/.exec(suffix);
    if (messageResolve) {
      return `/internal/agent-api/messages/${messageResolve[1]}/resolve`;
    }
    if (suffix.startsWith("/channel-members")) return `/internal/agent-api/channel-members${suffix.slice("/channel-members".length)}`;
    if (suffix === "/knowledge" || suffix.startsWith("/knowledge?")) {
      return `/internal/agent-api/knowledge${suffix.slice("/knowledge".length)}`;
    }
    if (suffix === "/profile" || suffix.startsWith("/profile/")) return `/internal/agent-api${suffix}`;
    if (suffix === "/integrations" || suffix.startsWith("/integrations/")) return `/internal/agent-api${suffix}`;
    if (suffix === "/upload") return "/internal/agent-api/upload";
    if (suffix === "/resolve-channel") return "/internal/agent-api/resolve-channel";
    if (suffix === "/threads") return "/internal/agent-api/threads";
    if (suffix === "/threads/unfollow") return "/internal/agent-api/threads/unfollow";
    if (suffix === "/prepare-action") return "/internal/agent-api/prepare-action";
    if (suffix === "/channels") return "/internal/agent-api/channels";
    if (suffix === "/tasks" || suffix.startsWith("/tasks?") || suffix.startsWith("/tasks/")) {
      return `/internal/agent-api${suffix}`;
    }
    if (suffix === "/reminders" || suffix.startsWith("/reminders?") || suffix.startsWith("/reminders/")) {
      return `/internal/agent-api${suffix}`;
    }
    if (suffix === "/mention-actions/pending" || suffix === "/mention-actions/execute") {
      return `/internal/agent-api${suffix}`;
    }
    if (suffix === "/receive" || suffix.startsWith("/receive?")) {
      return buildAgentApiEventsPath({ since: "latest" });
    }

    const reaction = /^\/messages\/([^/]+)\/reactions$/.exec(suffix);
    if (reaction) {
      return `/internal/agent-api/messages/${reaction[1]}/reactions`;
    }

    const channelMembership = /^\/channels\/([^/]+)\/(join|leave|mute|unmute)$/.exec(suffix);
    if (channelMembership) {
      return `/internal/agent-api/channels/${channelMembership[1]}/${channelMembership[2]}`;
    }
    const channelUpdate = /^\/channels\/([^/]+)$/.exec(suffix);
    if (channelUpdate) {
      return `/internal/agent-api/channels/${channelUpdate[1]}`;
    }
    const channelAddMember = /^\/channels\/([^/]+)\/members$/.exec(suffix);
    if (channelAddMember) {
      return `/internal/agent-api/channels/${channelAddMember[1]}/members`;
    }

    return pathname;
  }

  private normalizeAgentCredentialResponse<T>(pathname: string, data: T): T {
    if (!this.usesAgentApiSurface()) return data;
    if (!pathname.includes("/internal/agent-api/events")) return data;
    const value = data as { events?: unknown[] };
    if (!Array.isArray(value.events)) return data;
    return { ...(data as Record<string, unknown>), messages: value.events } as T;
  }

  private buildAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${this.ctx.token}`,
      "X-Agent-Id": this.ctx.agentId,
      "X-Raft-Client": "cli",
    };
    if (this.ctx.clientMode === "managed-runner" && this.ctx.entry === RAFT_CLI_STABLE_ENTRY) {
      headers[RAFT_CLI_ENTRY_HEADER] = RAFT_CLI_STABLE_ENTRY;
    }
    const version = cliVersionHeader();
    if (version) headers[RAFT_CLIENT_VERSION_HEADER] = version;
    if (this.ctx.serverId) headers["X-Server-Id"] = this.ctx.serverId;
    return headers;
  }

  private async parseJsonResponse<T>(res: TransportResponse): Promise<ApiResponse<T>> {
    let data: T | null = null;
    let error: string | null = null;
    let errorCode: string | null = null;
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      let readFailed = false;
      const rawBody = await res.text().catch(() => {
        readFailed = true;
        return null;
      });
      if (readFailed) {
        const proxy = proxyDiagnosticsForResponseBodyFailure(res);
        if (proxy) {
          return {
            ok: false,
            status: 502,
            data: null,
            error: "failed to proxy local agent request",
            errorCode: "agent_proxy_failed",
            proxy,
          };
        }
        return {
          ok: false,
          status: res.status,
          data: null,
          error: `Invalid JSON response from server/proxy (HTTP ${res.status})`,
          errorCode: "INVALID_JSON_RESPONSE",
        };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody ?? "");
      } catch {
        return {
          ok: false,
          status: res.status,
          data: null,
          error: `Invalid JSON response from server/proxy (HTTP ${res.status})`,
          errorCode: "INVALID_JSON_RESPONSE",
        };
      }
      if (res.ok) {
        data = parsed as T;
      } else {
        const body = parsed as
          | {
            error?: string;
            errorCode?: string;
            code?: string;
            message?: string;
            requiredScope?: string;
            reason?: string;
            suggestedNextAction?: string;
            suggested_next_action?: string;
            proxy?: unknown;
          }
          | null;
        // 403 with `requiredScope` is the agent-permission deny shape from
        // requireAgentScope middleware. Rewrite the wire error into something
        // the agent can act on. An authorized human must inspect the scope
        // grant; the old profile Permissions tab no longer exists.
        if (res.status === 403 && body?.requiredScope) {
          errorCode = "SCOPE_DENIED";
          error =
            `Permission denied. This agent lacks the \`${body.requiredScope}\` ` +
            `capability, so this command can't run. Ask an authorized human to ` +
            `inspect or update this agent's scope grant through the API.`;
        } else {
          // Contract-shaped errors (attachment upload sessions) carry
          // `{ code, message }` with no `error`.
          error = body?.error ?? body?.message ?? `HTTP ${res.status}`;
          errorCode = body?.errorCode ?? body?.code ?? null;
        }
        const suggestedNextAction = body?.suggestedNextAction ?? body?.suggested_next_action;
        return {
          ok: res.ok,
          status: res.status,
          data,
          error,
          errorCode,
          suggestedNextAction,
          proxy: parseProxyDiagnostics(body?.proxy),
          errorBody: body,
        };
      }
    } else if (!res.ok) {
      error = `HTTP ${res.status}`;
    }
    return { ok: res.ok, status: res.status, data, error, errorCode };
  }

  private throwProxyFailure<T>(response: ApiResponse<T>): void {
    if (response.status >= 500 && response.errorCode === "agent_proxy_failed") {
      throw apiFailureError(response, "CHECK_FAILED");
    }
    this.throwLaunchLifecycleRefusal(response);
  }

  // The launch this CLI ran from has ended (or the agent has none): no
  // command can do anything about it, so every command says it the same way.
  private throwLaunchLifecycleRefusal(response: Parameters<typeof localProxyLifecycleError>[0]): void {
    if (this.ctx.clientMode !== "managed-runner") return;
    const lifecycle = localProxyLifecycleError(response);
    if (lifecycle) throw lifecycle;
  }

  private fetchWithTransportTrace(url: URL, pathname: string, init: ProxyAwareRequestInit): Promise<Response> {
    const { dispatcher } = init;
    return this.sendWithTransportTrace(url, pathname, () => (
      dispatcher ? fetchWithDispatcher(url, { ...init, dispatcher }) : fetch(url, init)
    ));
  }

  // Plain JSON requests go over node:http (see httpTransport.ts). A redirect is
  // re-sent through fetch, which follows it exactly as before.
  private async requestJsonWithTransportTrace(url: URL, pathname: string, init: JsonTransportInit): Promise<TransportResponse> {
    const res = await this.sendWithTransportTrace(url, pathname, () => jsonTransport(url, init));
    if (!isHttpRedirect(res.status)) return res;
    return this.fetchWithTransportTrace(url, pathname, init);
  }

  private async sendWithTransportTrace<R extends { status: number }>(
    url: URL,
    pathname: string,
    send: () => Promise<R>,
  ): Promise<R> {
    try {
      const res = await send();
      if (res.status >= 500) {
        this.emitTransportNormalizedError({
          url,
          pathname,
          normalizedCode: "server_5xx",
          responseStarted: true,
          upstreamLayer: "http_status",
          upstreamStatus: res.status,
        });
      }
      return res;
    } catch (err) {
      this.emitTransportNormalizedError({
        url,
        pathname,
        normalizedCode: "transport_failure",
        responseStarted: false,
        upstreamLayer: upstreamLayerForFetchError(url, err),
        originalMessage: boundedOriginalMessage(err),
      });
      throw err;
    }
  }

  private emitTransportNormalizedError(input: {
    url: URL;
    pathname: string;
    normalizedCode: "transport_failure" | "server_5xx";
    responseStarted: boolean;
    upstreamLayer: ReturnType<typeof upstreamLayerForFetchError> | "http_status";
    upstreamStatus?: number | null;
    originalMessage?: string;
  }): void {
    emitCliTransportNormalizedError({
      producer: "cli",
      normalized_code: input.normalizedCode,
      route_family: routeFamilyForPath(input.pathname),
      response_started: input.responseStarted,
      upstream_layer: input.upstreamLayer,
      ...(input.upstreamStatus === undefined || input.upstreamStatus === null ? {} : { upstream_status: input.upstreamStatus }),
      ...(input.originalMessage ? { original_message: input.originalMessage } : {}),
      ...(this.ctx.serverId ? { serverId: this.ctx.serverId } : {}),
      agentId: this.ctx.agentId,
      target_host_class: targetHostClassForUrl(input.url),
    });
  }

  async request<T>(
    method: string,
    pathname: string,
    body?: unknown,
    options?: { headers?: Record<string, string>; signal?: AbortSignal },
  ): Promise<ApiResponse<T>> {
    pathname = this.rewriteAgentCredentialPath(pathname);
    const url = new URL(pathname, this.ctx.serverUrl);
    const headers = this.buildAuthHeaders();
    headers["Content-Type"] = "application/json";
    // Per-request capability declarations (task #178 events ack lease). Auth
    // and capability headers below stay authoritative over these.
    Object.assign(headers, options?.headers);
    // Rollout carrier: new CLIs hard-require Manual intent/reason locally and
    // advertise that contract explicitly. New servers may therefore enforce
    // it without breaking older published CLI/daemon fleets. The plan:upgrade
    // token lets the Server's Free-limit refusals and history notes hint an
    // upgrade card this CLI can post. The guide-app tokens name the
    // first-party app entries this CLI was built with, so the self-hosted
    // guide (`raft auth whoami --prompt`) names only commands it has.
    headers[RAFT_CLIENT_CAPABILITIES_HEADER] = CLI_CLIENT_CAPABILITIES;
    // This header is the session-side half of the v0.8 active-capability
    // intersection. The server still enforces credential max scopes first;
    // when present, this set can further deny otherwise-authorized commands
    // with `unsupported_capability`.
    if (this.ctx.activeCapabilities && this.ctx.activeCapabilities.length > 0) {
      headers["X-Slock-Agent-Active-Capabilities"] = this.ctx.activeCapabilities.join(",");
    }
    const dispatcher = await buildFetchDispatcher(url.toString());
    const init: JsonTransportInit = {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: options?.signal,
    };
    // Through an HTTP proxy the request stays on fetch + the undici dispatcher.
    const res = dispatcher
      ? await this.fetchWithTransportTrace(url, pathname, { ...init, dispatcher })
      : await this.requestJsonWithTransportTrace(url, pathname, init);
    const parsed = await this.parseJsonResponse<T>(res);
    this.throwProxyFailure(parsed);
    if (parsed.ok && parsed.data !== null) {
      parsed.data = this.normalizeAgentCredentialResponse(pathname, parsed.data);
    }
    return parsed;
  }

  // Multipart upload. Caller builds the FormData (file part + any text fields).
  // Content-Type intentionally omitted so fetch sets the correct multipart
  // boundary itself.
  async requestMultipart<T>(
    method: string,
    pathname: string,
    form: FormData,
  ): Promise<ApiResponse<T>> {
    pathname = this.rewriteAgentCredentialPath(pathname);
    const url = new URL(pathname, this.ctx.serverUrl);
    const dispatcher = await buildFetchDispatcher(url.toString());
    const headers = this.buildAuthHeaders();
    // An attachment upload's Free-limit refusal hints the upgrade card only to a client that declares it can post one.
    headers[RAFT_CLIENT_CAPABILITIES_HEADER] = CLI_CLIENT_CAPABILITIES;
    if (this.ctx.activeCapabilities && this.ctx.activeCapabilities.length > 0) {
      headers["X-Slock-Agent-Active-Capabilities"] = this.ctx.activeCapabilities.join(",");
    }
    const init: ProxyAwareRequestInit = {
      method,
      headers,
      body: form,
    };
    if (dispatcher) init.dispatcher = dispatcher;
    const res = await this.fetchWithTransportTrace(url, pathname, init);
    const parsed = await this.parseJsonResponse<T>(res);
    this.throwProxyFailure(parsed);
    return parsed;
  }

  /** Send raw bytes (an Artifact upload: `PUT …/uploads/:sha256`); the answer is parsed like any JSON route. */
  async requestRawBody<T>(
    method: string,
    pathname: string,
    bytes: Uint8Array,
    contentType = "application/octet-stream",
  ): Promise<ApiResponse<T>> {
    pathname = this.rewriteAgentCredentialPath(pathname);
    const url = new URL(pathname, this.ctx.serverUrl);
    const dispatcher = await buildFetchDispatcher(url.toString());
    const headers = this.buildAuthHeaders();
    if (this.ctx.activeCapabilities && this.ctx.activeCapabilities.length > 0) {
      headers["X-Slock-Agent-Active-Capabilities"] = this.ctx.activeCapabilities.join(",");
    }
    headers["Content-Type"] = contentType;
    const body = new Uint8Array(bytes.byteLength);
    body.set(bytes);
    const init: ProxyAwareRequestInit = { method, headers, body };
    if (dispatcher) init.dispatcher = dispatcher;
    const res = await this.fetchWithTransportTrace(url, pathname, init);
    const parsed = await this.parseJsonResponse<T>(res);
    this.throwProxyFailure(parsed);
    return parsed;
  }

  private async requestBody(
    method: string,
    pathname: string,
    redirect: RequestRedirect = "follow",
  ): Promise<BodyResponse> {
    pathname = this.rewriteAgentCredentialPath(pathname);
    const url = new URL(pathname, this.ctx.serverUrl);
    const dispatcher = await buildFetchDispatcher(url.toString());
    const headers = this.buildAuthHeaders();
    if (this.ctx.activeCapabilities && this.ctx.activeCapabilities.length > 0) {
      headers["X-Slock-Agent-Active-Capabilities"] = this.ctx.activeCapabilities.join(",");
    }
    const init: ProxyAwareRequestInit = {
      method,
      headers,
      redirect,
    };
    if (dispatcher) init.dispatcher = dispatcher;
    const res = await this.fetchWithTransportTrace(url, pathname, init);
    let error: string | null = null;
    let errorCode: string | null = null;
    let errorBody: unknown;
    let suggestedNextAction: string | null = null;
    if (!res.ok) {
      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const parsed = await res.json().catch(() => null) as { error?: string; errorCode?: string; code?: string; suggestedNextAction?: string } | null;
        if (parsed !== null) errorBody = parsed;
        const step = parsed?.suggestedNextAction ?? (parsed as { suggested_next_action?: unknown } | null)?.suggested_next_action;
        suggestedNextAction = typeof step === "string" ? step : null;
        error = parsed?.error ?? `HTTP ${res.status}`;
        // Same machine code the JSON path reads, so a binary route's refusal keeps it.
        const code = parsed?.errorCode ?? parsed?.code;
        errorCode = typeof code === "string" ? code : null;
        this.throwLaunchLifecycleRefusal({
          status: res.status,
          error,
          errorCode,
          suggestedNextAction,
          errorBody: parsed,
        });
      } else {
        error = `HTTP ${res.status}`;
      }
    }
    return {
      ok: res.ok,
      status: res.status,
      response: res,
      error,
      errorCode,
      ...(suggestedNextAction !== null ? { suggestedNextAction } : {}),
      ...(errorBody !== undefined ? { errorBody } : {}),
    };
  }

  async requestBinary(method: string, pathname: string): Promise<BinaryResponse> {
    const rewrittenPathname = this.rewriteAgentCredentialPath(pathname);
    const requestUrl = new URL(rewrittenPathname, this.ctx.serverUrl);
    const res = await this.requestBody(method, rewrittenPathname, "manual");
    if (res.status === 302) {
      const location = res.response.headers.get("location");
      let objectUrl: URL | null = null;
      try {
        objectUrl = location ? new URL(location, requestUrl) : null;
      } catch {
        objectUrl = null;
      }
      if (
        method.toUpperCase() !== "GET"
        || !objectUrl
        || objectUrl.protocol !== "https:"
        || objectUrl.origin === requestUrl.origin
        || objectUrl.username.length > 0
        || objectUrl.password.length > 0
      ) {
        return {
          ok: false,
          status: 502,
          body: new Uint8Array(),
          error: "Attachment redirect target was rejected",
        };
      }

      const dispatcher = await buildFetchDispatcher(objectUrl.toString());
      const init: ProxyAwareRequestInit = {
        method: "GET",
        redirect: "error",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      };
      if (dispatcher) init.dispatcher = dispatcher;
      let objectResponse: Response;
      try {
        objectResponse = await this.fetchWithTransportTrace(objectUrl, rewrittenPathname, init);
      } catch (cause) {
        throw new Error(
          `Attachment object download failed (${describeFetchFailure(objectUrl, cause, Boolean(dispatcher))})`,
          { cause },
        );
      }
      if (!objectResponse.ok) {
        return {
          ok: false,
          status: objectResponse.status,
          body: new Uint8Array(),
          error: `HTTP ${objectResponse.status}`,
        };
      }
      return {
        ok: true,
        status: objectResponse.status,
        body: new Uint8Array(await objectResponse.arrayBuffer()),
        error: null,
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        body: new Uint8Array(),
        error: res.error,
        errorCode: res.errorCode ?? null,
        ...(res.suggestedNextAction ? { suggestedNextAction: res.suggestedNextAction } : {}),
        ...(res.errorBody !== undefined ? { errorBody: res.errorBody } : {}),
      };
    }
    try {
      return {
        ok: true,
        status: res.status,
        body: new Uint8Array(await res.response.arrayBuffer()),
        error: null,
      };
    } catch {
      const proxy = proxyDiagnosticsForResponseBodyFailure(res.response);
      if (proxy) {
        return {
          ok: false,
          status: 502,
          body: new Uint8Array(),
          error: "failed to proxy local agent request",
          errorCode: "agent_proxy_failed",
          proxy,
        };
      }
      throw new Error("Response body stream failed");
    }
  }

  async streamWakeHints(query: URLSearchParams): Promise<BodyResponse> {
    return this.requestBody("GET", `/internal/agent-api/wake-hints/stream?${query.toString()}`);
  }
}

function parseProxyDiagnostics(value: unknown): ApiProxyDiagnostics | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  return {
    layer: stringValue(body.layer),
    correlationId: stringValue(body.correlationId) ?? stringValue(body.correlation_id),
    failureClass: stringValue(body.failureClass) ?? stringValue(body.failure_class),
    causeCode: stringValue(body.causeCode) ?? stringValue(body.cause_code),
    routeFamily: stringValue(body.routeFamily) ?? stringValue(body.route_family),
    upstreamLayer: stringValue(body.upstreamLayer) ?? stringValue(body.upstream_layer),
    upstreamStatus: numberValue(body.upstreamStatus) ?? numberValue(body.upstream_status),
    responseStarted: booleanValue(body.responseStarted) ?? booleanValue(body.response_started),
    responseComplete: booleanValue(body.responseComplete) ?? booleanValue(body.response_complete),
    targetHostClass: stringValue(body.targetHostClass) ?? stringValue(body.target_host_class),
    launchId: stringValue(body.launchId) ?? stringValue(body.launch_id),
    downstreamCaller: stringValue(body.downstreamCaller) ?? stringValue(body.downstream_caller),
    upstream: stringValue(body.upstream),
  };
}

function proxyDiagnosticsForResponseBodyFailure(res: Pick<TransportResponse, "headers">): ApiProxyDiagnostics | null {
  if (res.headers.get("x-raft-proxy-stream-carrier") !== "1") return null;
  const correlationId = res.headers.get("x-raft-correlation-id");
  if (!correlationId) return null;
  return {
    layer: "local_daemon_proxy",
    correlationId,
    failureClass: "mid_response_transport",
    causeCode: "RESPONSE_BODY_STREAM_FAILED",
    routeFamily: res.headers.get("x-raft-proxy-route-family"),
    upstreamLayer: "body_stream",
    responseStarted: true,
    responseComplete: false,
    targetHostClass: res.headers.get("x-raft-proxy-target-host-class"),
    launchId: res.headers.get("x-raft-proxy-launch-id"),
    downstreamCaller: "cli",
    upstream: "server",
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
