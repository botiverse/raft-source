import {
  AGENT_API_BASE_PATH,
  agentApiContract,
  getAgentApiResponseKind,
  parseAgentApiResponse,
  type AgentApiContract,
  type AgentApiMethod,
  type AgentApiRequestBodyByRoute,
  type AgentApiRequestParamsByRoute,
  type AgentApiRequestQueryByRoute,
  type AgentApiResponseByRoute,
  type AgentApiRouteKey,
} from "./agentApiContract.js";

export type AgentApiRawClientErrorReason =
  | "missing_route"
  | "missing_path_param"
  | "request_contract_mismatch"
  | "transport_error"
  | "http_error"
  | "empty_response"
  | "response_contract_mismatch";

export interface AgentApiRawTransportRequest<K extends AgentApiRouteKey = AgentApiRouteKey> {
  routeKey: K;
  method: AgentApiMethod;
  path: string;
  body?: unknown;
}

export interface AgentApiRawTransportResponse {
  ok: boolean;
  status: number;
  data: unknown | null;
  error: string | null;
  errorCode?: string | null;
  suggestedNextAction?: string | null;
  proxy?: unknown;
}

export interface AgentApiRawTransport {
  request(input: AgentApiRawTransportRequest): Promise<AgentApiRawTransportResponse>;
}

export type AgentApiRawSuccess<K extends AgentApiRouteKey> = {
  ok: true;
  routeKey: K;
  status: number;
  data: AgentApiResponseByRoute[K];
};

export type AgentApiRawFailure<K extends AgentApiRouteKey = AgentApiRouteKey> = {
  ok: false;
  routeKey?: K;
  status?: number;
  reason: AgentApiRawClientErrorReason;
  message: string;
  errorCode?: string | null;
  suggestedNextAction?: string | null;
  proxy?: unknown;
  cause?: unknown;
  response?: unknown;
};

export type AgentApiRawResult<K extends AgentApiRouteKey> = AgentApiRawSuccess<K> | AgentApiRawFailure<K>;

export interface AgentApiRawClientOptions {
  /**
   * Defaults to the id-less credential-derived agent-api surface. CLI legacy
   * adapters can pass `/internal/agent/:agentId` without changing SDK semantics.
   */
  pathPrefix?: string;
}

export type AgentApiRawClientResource = AgentApiContract[AgentApiRouteKey]["client"]["resource"];
export type AgentApiRawClientResourceMethod<R extends AgentApiRawClientResource> = {
  [K in AgentApiRouteKey]: AgentApiContract[K]["client"] extends { resource: R; method: infer M extends string } ? M : never;
}[AgentApiRouteKey];
export type AgentApiRouteKeyForClient<
  R extends AgentApiRawClientResource,
  M extends AgentApiRawClientResourceMethod<R>,
> = {
  [K in AgentApiRouteKey]: AgentApiContract[K]["client"] extends { resource: R; method: M } ? K : never;
}[AgentApiRouteKey];
type AgentApiResponseForClient<R extends AgentApiRawClientResource, M extends AgentApiRawClientResourceMethod<R>> =
  AgentApiResponseByRoute[AgentApiRouteKeyForClient<R, M>];

export type AgentApiRawClientMethodArgs<K extends AgentApiRouteKey> =
  [AgentApiRequestParamsByRoute[K]] extends [never]
    ? [AgentApiRequestQueryByRoute[K]] extends [never]
      ? [AgentApiRequestBodyByRoute[K]] extends [never]
        ? []
        : [body: AgentApiRequestBodyByRoute[K]]
      : [query: AgentApiRequestQueryByRoute[K]]
    : [AgentApiRequestQueryByRoute[K]] extends [never]
      ? [AgentApiRequestBodyByRoute[K]] extends [never]
        ? [params: AgentApiRequestParamsByRoute[K]]
        : [params: AgentApiRequestParamsByRoute[K], body: AgentApiRequestBodyByRoute[K]]
      : [AgentApiRequestBodyByRoute[K]] extends [never]
        ? [params: AgentApiRequestParamsByRoute[K], query: AgentApiRequestQueryByRoute[K]]
        : [
          params: AgentApiRequestParamsByRoute[K],
          query: AgentApiRequestQueryByRoute[K],
          body: AgentApiRequestBodyByRoute[K],
        ];

export type AgentApiRawClientMethod<K extends AgentApiRouteKey> = (
  ...args: AgentApiRawClientMethodArgs<K>
) => Promise<AgentApiRawResult<K>>;

export type AgentApiRawClient = {
  [R in AgentApiRawClientResource]: {
    [M in AgentApiRawClientResourceMethod<R>]: AgentApiRawClientMethod<AgentApiRouteKeyForClient<R, M>>;
  };
};

function failure<K extends AgentApiRouteKey>(
  routeKey: K | undefined,
  reason: AgentApiRawClientErrorReason,
  message: string,
  details: Omit<AgentApiRawFailure<K>, "ok" | "routeKey" | "reason" | "message"> = {},
): AgentApiRawFailure<K> {
  return {
    ok: false,
    ...(routeKey ? { routeKey } : {}),
    reason,
    message,
    ...details,
  };
}

function encodePathParams<K extends AgentApiRouteKey>(
  routeKey: K,
  params: AgentApiRequestParamsByRoute[K] | undefined,
): string | AgentApiRawFailure<K> {
  const route = agentApiContract[routeKey];
  let parsed: Record<string, unknown>;
  try {
    parsed = "params" in route.request ? route.request.params.parse(params ?? {}) as Record<string, unknown> : {};
  } catch (cause) {
    return failure(routeKey, "request_contract_mismatch", `Agent API ${route.key} path params did not match the shared contract`, { cause });
  }

  return route.path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (_match, key: string) => {
    const value = parsed[key];
    if (value === undefined || value === null) {
      throw new MissingPathParamError(route.key, key);
    }
    return encodeURIComponent(String(value));
  });
}

class MissingPathParamError extends Error {
  constructor(readonly routeKey: string, readonly paramName: string) {
    super(`Missing agent-api path parameter ${paramName} for ${routeKey}`);
  }
}

function encodeQuery<K extends AgentApiRouteKey>(
  routeKey: K,
  query: AgentApiRequestQueryByRoute[K] | undefined,
): URLSearchParams | AgentApiRawFailure<K> | undefined {
  if (query === undefined) return undefined;
  const route = agentApiContract[routeKey];
  let parsed: Record<string, unknown>;
  try {
    parsed = "query" in route.request ? route.request.query.parse(query) as Record<string, unknown> : {};
  } catch (cause) {
    return failure(routeKey, "request_contract_mismatch", `Agent API ${route.key} query did not match the shared contract`, { cause });
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(parsed)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
      continue;
    }
    params.set(key, String(value));
  }
  return params;
}

function parseBody<K extends AgentApiRouteKey>(
  routeKey: K,
  body: AgentApiRequestBodyByRoute[K] | undefined,
): AgentApiRequestBodyByRoute[K] | undefined | AgentApiRawFailure<K> {
  if (body === undefined) return undefined;
  const route = agentApiContract[routeKey];
  try {
    return ("body" in route.request ? route.request.body.parse(body) : undefined) as AgentApiRequestBodyByRoute[K] | undefined;
  } catch (cause) {
    return failure(routeKey, "request_contract_mismatch", `Agent API ${route.key} body did not match the shared contract`, { cause });
  }
}

function isAgentApiRawFailure<K extends AgentApiRouteKey>(
  value: unknown,
): value is AgentApiRawFailure<K> {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { reason?: unknown }).reason === "string" &&
    typeof (value as { message?: unknown }).message === "string",
  );
}

export function buildAgentApiRawRoutePath<K extends AgentApiRouteKey>(
  routeKey: K,
  options: {
    pathPrefix?: string;
    params?: AgentApiRequestParamsByRoute[K];
    query?: AgentApiRequestQueryByRoute[K];
  } = {},
): string | AgentApiRawFailure<K> {
  let path: string;
  try {
    const encodedPath = encodePathParams(routeKey, options.params);
    if (typeof encodedPath !== "string") return encodedPath;
    path = encodedPath;
  } catch (cause) {
    if (cause instanceof MissingPathParamError) {
      return failure(routeKey, "missing_path_param", cause.message, { cause });
    }
    throw cause;
  }
  const query = encodeQuery(routeKey, options.query);
  if (query && !(query instanceof URLSearchParams)) return query;
  const suffix = query && query.size > 0 ? `?${query.toString()}` : "";
  return `${options.pathPrefix ?? AGENT_API_BASE_PATH}${path}${suffix}`;
}

export async function requestAgentApiRawRoute<K extends AgentApiRouteKey>(
  transport: AgentApiRawTransport,
  routeKey: K,
  options: {
    pathPrefix?: string;
    params?: AgentApiRequestParamsByRoute[K];
    query?: AgentApiRequestQueryByRoute[K];
    body?: AgentApiRequestBodyByRoute[K];
  } = {},
): Promise<AgentApiRawResult<K>> {
  const route = agentApiContract[routeKey];
  const path = buildAgentApiRawRoutePath(routeKey, options);
  if (typeof path !== "string") return path;
  const body = parseBody(routeKey, options.body);
  if (isAgentApiRawFailure<K>(body)) return body;

  let response: AgentApiRawTransportResponse;
  try {
    response = await transport.request({
      routeKey,
      method: route.method,
      path,
      body,
    });
  } catch (cause) {
    return failure(routeKey, "transport_error", `Agent API ${route.key} transport request failed`, { cause });
  }

  if (!response.ok) {
    return failure(routeKey, "http_error", response.error ?? `HTTP ${response.status}`, {
      status: response.status,
      errorCode: response.errorCode,
      suggestedNextAction: response.suggestedNextAction,
      proxy: response.proxy,
      response: response.data,
    });
  }
  if (getAgentApiResponseKind(route.response) === "binary") {
    if (!(response.data instanceof Uint8Array)) {
      return failure(routeKey, "response_contract_mismatch", `Agent API ${route.key} response did not contain binary bytes`, {
        status: response.status,
        response: response.data,
      });
    }
    return {
      ok: true,
      routeKey,
      status: response.status,
      data: response.data as AgentApiResponseByRoute[K],
    };
  }
  if (response.data === null) {
    return failure(routeKey, "empty_response", `Agent API ${route.key} returned an empty response body`, {
      status: response.status,
    });
  }

  try {
    return {
      ok: true,
      routeKey,
      status: response.status,
      data: parseAgentApiResponse(routeKey, response.data),
    };
  } catch (cause) {
    return failure(routeKey, "response_contract_mismatch", `Agent API ${route.key} response did not match the shared contract`, {
      status: response.status,
      cause,
      response: response.data,
    });
  }
}

function requestOptionsFromMethodArgs<K extends AgentApiRouteKey>(
  routeKey: K,
  pathPrefix: string,
  args: readonly unknown[],
): {
  pathPrefix: string;
  params?: AgentApiRequestParamsByRoute[K];
  query?: AgentApiRequestQueryByRoute[K];
  body?: AgentApiRequestBodyByRoute[K];
} {
  const route = agentApiContract[routeKey];
  let index = 0;
  const requestOptions: {
    pathPrefix: string;
    params?: AgentApiRequestParamsByRoute[K];
    query?: AgentApiRequestQueryByRoute[K];
    body?: AgentApiRequestBodyByRoute[K];
  } = { pathPrefix };
  if ("params" in route.request) {
    requestOptions.params = args[index++] as AgentApiRequestParamsByRoute[K];
  }
  if ("query" in route.request) {
    requestOptions.query = args[index++] as AgentApiRequestQueryByRoute[K];
  }
  if ("body" in route.request) {
    requestOptions.body = args[index++] as AgentApiRequestBodyByRoute[K];
  }
  return requestOptions;
}

export function createAgentApiRawClient(
  transport: AgentApiRawTransport,
  options: AgentApiRawClientOptions = {},
): AgentApiRawClient {
  const pathPrefix = options.pathPrefix ?? AGENT_API_BASE_PATH;
  const client: Partial<Record<AgentApiRawClientResource, Record<string, unknown>>> = {};
  for (const route of Object.values(agentApiContract)) {
    const routeKey = route.key as AgentApiRouteKey;
    const { resource, method } = route.client as {
      resource: AgentApiRawClientResource;
      method: string;
    };
    const resourceClient = client[resource] ??= {};
    resourceClient[method] = (...args: unknown[]) =>
      requestAgentApiRawRoute(
        transport,
        routeKey,
        requestOptionsFromMethodArgs(routeKey, pathPrefix, args),
      );
  }
  return client as AgentApiRawClient;
}

export type AgentApiRawClientMethodResult<
  R extends AgentApiRawClientResource,
  M extends AgentApiRawClientResourceMethod<R>,
> = AgentApiRawResult<AgentApiRouteKeyForClient<R, M>>;

export type AgentApiRawClientMethodResponse<
  R extends AgentApiRawClientResource,
  M extends AgentApiRawClientResourceMethod<R>,
> = AgentApiResponseForClient<R, M>;
