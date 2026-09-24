import {
  AGENT_API_BASE_PATH,
  agentApiContract,
  getAgentApiResponseKind,
  type AgentApiRequestBodyByRoute,
  type AgentApiRequestParamsByRoute,
  type AgentApiRequestQueryByRoute,
  type AgentApiResponseByRoute,
  type AgentApiRouteKey,
} from "./agentApiContract.js";
import {
  createAgentApiRawClient,
  requestAgentApiRawRoute,
  type AgentApiRawClient,
  type AgentApiRawClientErrorReason,
  type AgentApiRawClientMethod,
  type AgentApiRawFailure,
  type AgentApiRawResult,
  type AgentApiRawSuccess,
  type AgentApiRawTransport,
  type AgentApiRawTransportRequest,
  type AgentApiRawTransportResponse,
} from "./agentApiRawClient.js";

export type AgentApiClientResponse<K extends AgentApiRouteKey> = AgentApiResponseByRoute[K];
export type AgentApiClientErrorKind = "transport" | "http" | "validation";
export type AgentApiClientErrorReason = AgentApiRawClientErrorReason;

export interface AgentApiClientSuccess<K extends AgentApiRouteKey> {
  ok: true;
  routeKey: K;
  status: number;
  data: AgentApiClientResponse<K>;
}

export type AgentApiClientError =
  | {
    kind: "transport";
    reason: "transport_error";
    message: string;
    cause?: unknown;
  }
  | {
    kind: "http";
    reason: "http_error";
    message: string;
    status: number;
    errorCode?: string | null;
    suggestedNextAction?: string | null;
    proxy?: unknown;
    response?: unknown;
  }
  | {
    kind: "validation";
    reason: Exclude<AgentApiRawClientErrorReason, "transport_error" | "http_error">;
    message: string;
    status?: number;
    cause?: unknown;
    response?: unknown;
  };

export interface AgentApiClientFailure<K extends AgentApiRouteKey = AgentApiRouteKey> {
  ok: false;
  routeKey?: K;
  status?: number;
  error: AgentApiClientError;
}

export type AgentApiClientResult<K extends AgentApiRouteKey> = AgentApiClientSuccess<K> | AgentApiClientFailure<K>;
export type AgentApiClientMethod<K extends AgentApiRouteKey> = (
  ...args: Parameters<AgentApiRawClientMethod<K>>
) => Promise<AgentApiClientResult<K>>;

export type AgentApiClientMethods = {
  [R in keyof AgentApiRawClient]: {
    [M in keyof AgentApiRawClient[R]]: AgentApiRawClient[R][M] extends AgentApiRawClientMethod<infer K>
      ? AgentApiClientMethod<K>
      : never;
  };
};

export interface AgentApiClientRequestOptions<K extends AgentApiRouteKey> {
  params?: AgentApiRequestParamsByRoute[K];
  query?: AgentApiRequestQueryByRoute[K];
  body?: AgentApiRequestBodyByRoute[K];
}

export type AgentApiClient = AgentApiClientMethods & {
  request<K extends AgentApiRouteKey>(
    routeKey: K,
    options?: AgentApiClientRequestOptions<K>,
  ): Promise<AgentApiClientResult<K>>;
};

export type AgentApiAuthHeaders = Record<string, string>;
export type AgentApiAuthStrategy =
  | AgentApiAuthHeaders
  | ((request: AgentApiRawTransportRequest) => AgentApiAuthHeaders | Promise<AgentApiAuthHeaders>);

export interface AgentApiFetchTransportOptions {
  baseUrl: string;
  headers?: AgentApiAuthHeaders;
  auth?: AgentApiAuthStrategy;
  fetch?: typeof fetch;
  retry?: {
    attempts?: number;
  };
  throttle?: {
    beforeRequest?: (request: AgentApiRawTransportRequest) => Promise<void> | void;
  };
}

export type AgentApiClientTransport = AgentApiRawTransport;

export interface AgentApiClientOptions {
  /** Defaults to the id-less credential-derived agent-api surface. */
  pathPrefix?: string;
  transport?: AgentApiClientTransport;
  fetch?: AgentApiFetchTransportOptions;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function mergeHeaders(...headers: Array<AgentApiAuthHeaders | undefined>): AgentApiAuthHeaders {
  return Object.assign({}, ...headers.filter(Boolean));
}

async function authHeadersForRequest(
  auth: AgentApiAuthStrategy | undefined,
  request: AgentApiRawTransportRequest,
): Promise<AgentApiAuthHeaders | undefined> {
  if (!auth) return undefined;
  return typeof auth === "function" ? auth(request) : auth;
}

async function parseFetchResponse(response: Response, responseKind: "json" | "binary"): Promise<unknown | null> {
  if (response.ok && responseKind === "binary") {
    return new Uint8Array(await response.arrayBuffer());
  }
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function transportResponseFromFetch(response: Response, data: unknown | null): AgentApiRawTransportResponse {
  if (response.ok) {
    return {
      ok: true,
      status: response.status,
      data,
      error: null,
    };
  }
  const objectData = data && typeof data === "object" ? data as Record<string, unknown> : {};
  return {
    ok: false,
    status: response.status,
    data,
    error: typeof objectData.error === "string" ? objectData.error : response.statusText || `HTTP ${response.status}`,
    errorCode: typeof objectData.errorCode === "string"
      ? objectData.errorCode
      : typeof objectData.code === "string" ? objectData.code : null,
    suggestedNextAction: typeof objectData.suggestedNextAction === "string" ? objectData.suggestedNextAction : null,
    proxy: objectData.proxy,
  };
}

export function createAgentApiFetchTransport(options: AgentApiFetchTransportOptions): AgentApiClientTransport {
  const fetchImpl = options.fetch ?? fetch;
  const maxAttempts = Math.max(1, options.retry?.attempts ?? 1);
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  return {
    request: async (input) => {
      await options.throttle?.beforeRequest?.(input);
      const authHeaders = await authHeadersForRequest(options.auth, input);
      const responseKind = getAgentApiResponseKind(agentApiContract[input.routeKey].response);
      const headers = mergeHeaders(
        { accept: responseKind === "binary" ? "*/*" : "application/json" },
        input.body === undefined ? undefined : { "content-type": "application/json" },
        options.headers,
        authHeaders,
      );
      const init: RequestInit = {
        method: input.method,
        headers,
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
      };
      let lastError: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const response = await fetchImpl(`${baseUrl}${input.path}`, init);
          return transportResponseFromFetch(response, await parseFetchResponse(response, responseKind));
        } catch (cause) {
          lastError = cause;
          if (attempt === maxAttempts) throw cause;
        }
      }
      throw lastError;
    },
  };
}

function errorFromRawFailure(failure: AgentApiRawFailure): AgentApiClientError {
  if (failure.reason === "transport_error") {
    return {
      kind: "transport",
      reason: failure.reason,
      message: failure.message,
      cause: failure.cause,
    };
  }
  if (failure.reason === "http_error") {
    return {
      kind: "http",
      reason: failure.reason,
      message: failure.message,
      status: failure.status ?? 0,
      errorCode: failure.errorCode,
      suggestedNextAction: failure.suggestedNextAction,
      proxy: failure.proxy,
      response: failure.response,
    };
  }
  return {
    kind: "validation",
    reason: failure.reason,
    message: failure.message,
    status: failure.status,
    cause: failure.cause,
    response: failure.response,
  };
}

export function agentApiClientResultFromRaw<K extends AgentApiRouteKey>(
  result: AgentApiRawResult<K>,
): AgentApiClientResult<K> {
  if (result.ok) {
    const success: AgentApiRawSuccess<K> = result;
    return {
      ok: true,
      routeKey: success.routeKey,
      status: success.status,
      data: success.data,
    };
  }
  return {
    ok: false,
    routeKey: result.routeKey,
    status: result.status,
    error: errorFromRawFailure(result),
  };
}

function wrapRawClient(rawClient: AgentApiRawClient): AgentApiClientMethods {
  const client: Partial<Record<string, Record<string, unknown>>> = {};
  for (const [resource, methods] of Object.entries(rawClient)) {
    client[resource] = {};
    for (const [method, rawMethod] of Object.entries(methods)) {
      client[resource][method] = async (...args: unknown[]) =>
        agentApiClientResultFromRaw(await (rawMethod as (...methodArgs: unknown[]) => Promise<AgentApiRawResult<AgentApiRouteKey>>)(...args));
    }
  }
  return client as AgentApiClientMethods;
}

export function createAgentApiClient(options: AgentApiClientOptions): AgentApiClient;
export function createAgentApiClient(
  transport: AgentApiClientTransport,
  options?: Pick<AgentApiClientOptions, "pathPrefix">,
): AgentApiClient;
export function createAgentApiClient(
  transportOrOptions: AgentApiClientTransport | AgentApiClientOptions,
  maybeOptions: Pick<AgentApiClientOptions, "pathPrefix"> = {},
): AgentApiClient {
  const options = "request" in transportOrOptions
    ? { ...maybeOptions, transport: transportOrOptions }
    : transportOrOptions;
  const transport = options.transport ?? (options.fetch ? createAgentApiFetchTransport(options.fetch) : undefined);
  if (!transport) {
    throw new Error("createAgentApiClient requires either a transport or fetch options");
  }
  const pathPrefix = options.pathPrefix ?? AGENT_API_BASE_PATH;
  const rawClient = createAgentApiRawClient(transport, { pathPrefix });
  const generated = wrapRawClient(rawClient);
  return {
    ...generated,
    request: async (routeKey, requestOptions = {}) => agentApiClientResultFromRaw(await requestAgentApiRawRoute(transport, routeKey, {
      pathPrefix,
      ...requestOptions,
    })),
  };
}
