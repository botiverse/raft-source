import {
  DAEMON_API_BASE_PATH,
  type DaemonApiRequestBodyByRoute,
  type DaemonApiRequestQueryByRoute,
  type DaemonApiResponseByRoute,
  type DaemonApiRouteKey,
} from "./daemonApiContract.js";
import {
  createDaemonApiRawClient,
  requestDaemonApiRawRoute,
  type DaemonApiRawClient,
  type DaemonApiRawClientMethod,
  type DaemonApiRawClientErrorReason,
  type DaemonApiContractRejectionDiagnostic,
  type DaemonApiRawFailure,
  type DaemonApiRawResult,
  type DaemonApiRawSuccess,
  type DaemonApiRawTransport,
  type DaemonApiRawTransportRequest,
  type DaemonApiRawTransportResponse,
} from "./daemonApiRawClient.js";

export type DaemonApiClientResponse<K extends DaemonApiRouteKey> = DaemonApiResponseByRoute[K];
export type DaemonApiClientErrorKind = "transport" | "http" | "validation";
export type DaemonApiClientErrorReason = DaemonApiRawClientErrorReason;

export interface DaemonApiClientSuccess<K extends DaemonApiRouteKey> {
  ok: true;
  routeKey: K;
  status: number;
  data: DaemonApiClientResponse<K>;
}

export type DaemonApiClientError =
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
    response?: unknown;
  }
  | {
    kind: "validation";
    reason: Exclude<DaemonApiRawClientErrorReason, "transport_error" | "http_error">;
    message: string;
    status?: number;
    contractRejection?: DaemonApiContractRejectionDiagnostic;
    cause?: unknown;
    response?: unknown;
  };

export interface DaemonApiClientFailure<K extends DaemonApiRouteKey = DaemonApiRouteKey> {
  ok: false;
  routeKey?: K;
  status?: number;
  error: DaemonApiClientError;
}

export type DaemonApiClientResult<K extends DaemonApiRouteKey> = DaemonApiClientSuccess<K> | DaemonApiClientFailure<K>;
export type DaemonApiClientMethod<K extends DaemonApiRouteKey> = (
  ...args: Parameters<DaemonApiRawClientMethod<K>>
) => Promise<DaemonApiClientResult<K>>;

export type DaemonApiClientMethods = {
  [R in keyof DaemonApiRawClient]: {
    [M in keyof DaemonApiRawClient[R]]: DaemonApiRawClient[R][M] extends (...args: infer A) => Promise<DaemonApiRawResult<infer K>>
      ? (...args: A) => Promise<DaemonApiClientResult<K>>
      : never;
  };
};

export interface DaemonApiClientRequestOptions<K extends DaemonApiRouteKey> {
  query?: DaemonApiRequestQueryByRoute[K];
  body?: DaemonApiRequestBodyByRoute[K];
}

export type DaemonApiClient = DaemonApiClientMethods & {
  request<K extends DaemonApiRouteKey>(
    routeKey: K,
    options?: DaemonApiClientRequestOptions<K>,
  ): Promise<DaemonApiClientResult<K>>;
};

export type DaemonApiAuthHeaders = Record<string, string>;
export type DaemonApiAuthStrategy =
  | DaemonApiAuthHeaders
  | ((request: DaemonApiRawTransportRequest) => DaemonApiAuthHeaders | Promise<DaemonApiAuthHeaders>);

export interface DaemonApiFetchTransportOptions {
  baseUrl: string;
  headers?: DaemonApiAuthHeaders;
  auth?: DaemonApiAuthStrategy;
  fetch?: typeof fetch;
}

export type DaemonApiClientTransport = DaemonApiRawTransport;

export interface DaemonApiClientOptions {
  /** Defaults to the daemon-bound id-less agent-api compatibility surface. */
  pathPrefix?: string;
  transport?: DaemonApiClientTransport;
  fetch?: DaemonApiFetchTransportOptions;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function mergeHeaders(...headers: Array<DaemonApiAuthHeaders | undefined>): DaemonApiAuthHeaders {
  return Object.assign({}, ...headers.filter(Boolean));
}

const invalidJsonSyntaxSentinel = Symbol("daemonApiInvalidJsonSyntax");

async function authHeadersForRequest(
  auth: DaemonApiAuthStrategy | undefined,
  request: DaemonApiRawTransportRequest,
): Promise<DaemonApiAuthHeaders | undefined> {
  if (!auth) return undefined;
  return typeof auth === "function" ? auth(request) : auth;
}

async function parseFetchResponse(response: Response): Promise<unknown | null> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {
      [invalidJsonSyntaxSentinel]: true,
    };
  }
}

function transportResponseFromFetch(response: Response, data: unknown | null): DaemonApiRawTransportResponse {
  if (
    data &&
    typeof data === "object" &&
    (data as { [invalidJsonSyntaxSentinel]?: unknown })[invalidJsonSyntaxSentinel] === true
  ) {
    return {
      ok: false,
      status: response.status,
      data: null,
      error: `Invalid JSON response from daemon API (HTTP ${response.status})`,
      errorCode: "INVALID_JSON_RESPONSE",
    };
  }
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
    errorCode: typeof objectData.errorCode === "string" ? objectData.errorCode : null,
    suggestedNextAction: typeof objectData.suggestedNextAction === "string" ? objectData.suggestedNextAction : null,
  };
}

export function createDaemonApiFetchTransport(options: DaemonApiFetchTransportOptions): DaemonApiClientTransport {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  return {
    request: async (input) => {
      const authHeaders = await authHeadersForRequest(options.auth, input);
      const headers = mergeHeaders(
        { accept: "application/json" },
        input.body === undefined ? undefined : { "content-type": "application/json" },
        options.headers,
        authHeaders,
      );
      const init: RequestInit = {
        method: input.method,
        headers,
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
      };
      const response = await fetchImpl(`${baseUrl}${input.path}`, init);
      return transportResponseFromFetch(response, await parseFetchResponse(response));
    },
  };
}

function errorFromRawFailure(failure: DaemonApiRawFailure): DaemonApiClientError {
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
      response: failure.response,
    };
  }
  return {
    kind: "validation",
    reason: failure.reason,
    message: failure.message,
    status: failure.status,
    contractRejection: failure.contractRejection,
    cause: failure.cause,
    response: failure.response,
  };
}

export function daemonApiClientResultFromRaw<K extends DaemonApiRouteKey>(
  result: DaemonApiRawResult<K>,
): DaemonApiClientResult<K> {
  if (result.ok) {
    const success: DaemonApiRawSuccess<K> = result;
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

function wrapRawClient(rawClient: DaemonApiRawClient): DaemonApiClientMethods {
  const client: Partial<Record<string, Record<string, unknown>>> = {};
  for (const [resource, methods] of Object.entries(rawClient)) {
    client[resource] = {};
    for (const [method, rawMethod] of Object.entries(methods)) {
      client[resource][method] = async (...args: unknown[]) =>
        daemonApiClientResultFromRaw(await (rawMethod as (...methodArgs: unknown[]) => Promise<DaemonApiRawResult<DaemonApiRouteKey>>)(...args));
    }
  }
  return client as DaemonApiClientMethods;
}

export function createDaemonApiClient(options: DaemonApiClientOptions): DaemonApiClient;
export function createDaemonApiClient(
  transport: DaemonApiClientTransport,
  options?: Pick<DaemonApiClientOptions, "pathPrefix">,
): DaemonApiClient;
export function createDaemonApiClient(
  transportOrOptions: DaemonApiClientTransport | DaemonApiClientOptions,
  maybeOptions: Pick<DaemonApiClientOptions, "pathPrefix"> = {},
): DaemonApiClient {
  const options = "request" in transportOrOptions
    ? { ...maybeOptions, transport: transportOrOptions }
    : transportOrOptions;
  const transport = options.transport ?? (options.fetch ? createDaemonApiFetchTransport(options.fetch) : undefined);
  if (!transport) {
    throw new Error("createDaemonApiClient requires either a transport or fetch options");
  }
  const pathPrefix = options.pathPrefix ?? DAEMON_API_BASE_PATH;
  const rawClient = createDaemonApiRawClient(transport, { pathPrefix });
  const generated = wrapRawClient(rawClient);
  return {
    ...generated,
    request: async (routeKey, requestOptions = {}) => daemonApiClientResultFromRaw(await requestDaemonApiRawRoute(transport, routeKey, {
      pathPrefix,
      ...requestOptions,
    })),
  };
}
