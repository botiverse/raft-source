import {
  DAEMON_API_BASE_PATH,
  daemonApiContract,
  parseDaemonApiResponse,
  type DaemonApiContract,
  type DaemonApiMethod,
  type DaemonApiRequestBodyByRoute,
  type DaemonApiRequestQueryByRoute,
  type DaemonApiResponseByRoute,
  type DaemonApiRouteKey,
} from "./daemonApiContract.js";
import { z } from "zod";

export type DaemonApiRawClientErrorReason =
  | "request_contract_mismatch"
  | "transport_error"
  | "http_error"
  | "empty_response"
  | "response_contract_mismatch";

export interface DaemonApiRawTransportRequest<K extends DaemonApiRouteKey = DaemonApiRouteKey> {
  routeKey: K;
  method: DaemonApiMethod;
  path: string;
  body?: unknown;
}

export interface DaemonApiRawTransportResponse {
  ok: boolean;
  status: number;
  data: unknown | null;
  error: string | null;
  errorCode?: string | null;
  suggestedNextAction?: string | null;
}

export interface DaemonApiRawTransport {
  request(input: DaemonApiRawTransportRequest): Promise<DaemonApiRawTransportResponse>;
}

export type DaemonApiContractRejectionCause =
  | "invalid_json_syntax"
  | "missing_field"
  | "wrong_type"
  | "unknown_field"
  | "unsupported_contract_version";

export type DaemonApiContractRejectionKind =
  | "absent"
  | "array"
  | "boolean"
  | "enum"
  | "function"
  | "integer"
  | "invalid_json"
  | "literal"
  | "nan"
  | "null"
  | "number"
  | "object"
  | "string"
  | "undefined"
  | "unavailable"
  | "unknown"
  | "unknown_field";

export interface DaemonApiContractRejectionDiagnostic {
  cause: DaemonApiContractRejectionCause;
  path: string;
  expected_kind: DaemonApiContractRejectionKind;
  actual_kind: DaemonApiContractRejectionKind;
}

export type DaemonApiRawSuccess<K extends DaemonApiRouteKey> = {
  ok: true;
  routeKey: K;
  status: number;
  data: DaemonApiResponseByRoute[K];
};

export type DaemonApiRawFailure<K extends DaemonApiRouteKey = DaemonApiRouteKey> = {
  ok: false;
  routeKey?: K;
  status?: number;
  reason: DaemonApiRawClientErrorReason;
  message: string;
  contractRejection?: DaemonApiContractRejectionDiagnostic;
  errorCode?: string | null;
  suggestedNextAction?: string | null;
  cause?: unknown;
  response?: unknown;
};

export type DaemonApiRawResult<K extends DaemonApiRouteKey> = DaemonApiRawSuccess<K> | DaemonApiRawFailure<K>;

export interface DaemonApiRawClientOptions {
  /** Defaults to the daemon-bound id-less agent-api compatibility surface. */
  pathPrefix?: string;
}

export type DaemonApiRawClientResource = DaemonApiContract[DaemonApiRouteKey]["client"]["resource"];
export type DaemonApiRawClientResourceMethod<R extends DaemonApiRawClientResource> = {
  [K in DaemonApiRouteKey]: DaemonApiContract[K]["client"] extends { resource: R; method: infer M extends string } ? M : never;
}[DaemonApiRouteKey];
export type DaemonApiRouteKeyForClient<
  R extends DaemonApiRawClientResource,
  M extends DaemonApiRawClientResourceMethod<R>,
> = {
  [K in DaemonApiRouteKey]: DaemonApiContract[K]["client"] extends { resource: R; method: M } ? K : never;
}[DaemonApiRouteKey];
type DaemonApiResponseForClient<R extends DaemonApiRawClientResource, M extends DaemonApiRawClientResourceMethod<R>> =
  DaemonApiResponseByRoute[DaemonApiRouteKeyForClient<R, M>];

export type DaemonApiRawClientMethodArgs<K extends DaemonApiRouteKey> =
  [DaemonApiRequestQueryByRoute[K]] extends [never]
    ? [DaemonApiRequestBodyByRoute[K]] extends [never]
      ? []
      : [body: DaemonApiRequestBodyByRoute[K]]
    : [DaemonApiRequestBodyByRoute[K]] extends [never]
      ? [query: DaemonApiRequestQueryByRoute[K]]
      : [query: DaemonApiRequestQueryByRoute[K], body: DaemonApiRequestBodyByRoute[K]];

export type DaemonApiRawClientMethod<K extends DaemonApiRouteKey> = (
  ...args: DaemonApiRawClientMethodArgs<K>
) => Promise<DaemonApiRawResult<K>>;

export type DaemonApiRawClient = {
  [R in DaemonApiRawClientResource]: {
    [M in DaemonApiRawClientResourceMethod<R>]: DaemonApiRawClientMethod<DaemonApiRouteKeyForClient<R, M>>;
  };
};

function failure<K extends DaemonApiRouteKey>(
  routeKey: K | undefined,
  reason: DaemonApiRawClientErrorReason,
  message: string,
  details: Omit<DaemonApiRawFailure<K>, "ok" | "routeKey" | "reason" | "message"> = {},
): DaemonApiRawFailure<K> {
  return {
    ok: false,
    ...(routeKey ? { routeKey } : {}),
    reason,
    message,
    ...details,
  };
}

const knownDaemonApiPathSegments = new Set([
  "acceptedCount",
  "acknowledged_app_sources",
  "acknowledgedAtMs",
  "actionCli",
  "adapterInstance",
  "appId",
  "attention_hint",
  "attentionHint",
  "channelId",
  "channelType",
  "commandId",
  "computerVersion",
  "copy",
  "copy_version",
  "coreSessionId",
  "created_at",
  "createdAt",
  "createdAtMs",
  "daemonVersion",
  "dropped",
  "droppedCount",
  "epoch_ms",
  "event_id",
  "eventId",
  "events",
  "firstPendingMsgId",
  "firstPendingSeq",
  "flags",
  "has_more",
  "hint_id",
  "hintId",
  "hints",
  "id",
  "itemId",
  "items",
  "k",
  "K",
  "kind",
  "last_hint_seq",
  "last_seen_hint_seq",
  "latestMsgId",
  "latestSenderName",
  "latestSenderType",
  "latestSeq",
  "limit",
  "message_id",
  "messageId",
  "notificationClass",
  "observation",
  "ok",
  "ownerAgentId",
  "pending_app_items",
  "pending_messages",
  "pending_targets",
  "pendingCount",
  "primaryAction",
  "reason",
  "rejectedCount",
  "remaining_app_items",
  "retention",
  "revision",
  "row",
  "rows",
  "schema",
  "scope",
  "seq",
  "since",
  "source",
  "sourceRef",
  "suggested_command",
  "summary",
  "target",
  "target_type",
  "targetType",
  "thresholds",
  "title",
  "trigger",
  "wake_hints",
  "wake_reason",
  "window_ms",
]);

function sanitizeContractPath(path: readonly (string | number)[], options: { unknownKey?: boolean } = {}): string {
  let rendered = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      rendered += "[*]";
      continue;
    }
    if (rendered) rendered += ".";
    if (knownDaemonApiPathSegments.has(segment)) {
      rendered += segment;
      continue;
    }
    rendered += "<dynamic-key>";
  }
  if (options.unknownKey) {
    if (rendered) rendered += ".";
    rendered += "<unknown-key>";
  }
  return rendered || (options.unknownKey ? "<unknown-key>" : "<root>");
}

function kindFromValue(value: unknown): DaemonApiContractRejectionKind {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "nan";
    if (Number.isInteger(value)) return "integer";
    return "number";
  }
  switch (typeof value) {
    case "boolean":
      return "boolean";
    case "function":
      return "function";
    case "object":
      return "object";
    case "string":
      return "string";
    default:
      return "unknown";
  }
}

function kindFromZodKind(value: unknown): DaemonApiContractRejectionKind {
  switch (value) {
    case "array":
    case "boolean":
    case "function":
    case "integer":
    case "nan":
    case "null":
    case "number":
    case "object":
    case "string":
    case "undefined":
      return value;
    default:
      return "unknown";
  }
}

function valueAtPath(value: unknown, path: readonly (string | number)[]): unknown {
  let current = value;
  for (const segment of path) {
    if (current === null || current === undefined) return undefined;
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function diagnosticFromZodError(cause: unknown, input?: unknown): DaemonApiContractRejectionDiagnostic | undefined {
  if (!(cause instanceof z.ZodError)) return undefined;
  const issue = cause.issues[0] as z.ZodIssue | undefined;
  if (!issue) return undefined;
  const path = issue.path.filter((segment): segment is string | number =>
    typeof segment === "string" || typeof segment === "number"
  );
  const rawIssue = issue as unknown as Record<string, unknown>;
  const issueCode = String(issue.code);
  if (issue.code === "unrecognized_keys") {
    return {
      cause: "unknown_field",
      path: sanitizeContractPath(path, { unknownKey: true }),
      expected_kind: "absent",
      actual_kind: "unknown_field",
    };
  }
  const received = rawIssue.received;
  const expected = rawIssue.expected;
  const expected_kind: DaemonApiContractRejectionKind = issueCode === "invalid_literal" || issueCode === "invalid_value"
    ? "literal"
    : issueCode === "invalid_enum_value"
      ? "enum"
      : kindFromZodKind(expected);
  const rejectedValue = valueAtPath(input, path);
  const actual_kind = issueCode === "invalid_type" && "received" in rawIssue
    ? kindFromZodKind(received)
    : "received" in rawIssue
      ? kindFromValue(received)
      : kindFromValue(rejectedValue);
  const lastPathSegment = path[path.length - 1];
  const isVersionField = typeof lastPathSegment === "string" && /(?:^|_)(?:schema|version)$|Version$/.test(lastPathSegment);
  const rejectionCause: DaemonApiContractRejectionCause = received === "undefined" || actual_kind === "undefined"
    ? "missing_field"
    : isVersionField && (issueCode === "invalid_literal" || issueCode === "invalid_value" || issueCode === "invalid_enum_value")
      ? "unsupported_contract_version"
      : "wrong_type";
  return {
    cause: rejectionCause,
    path: sanitizeContractPath(path),
    expected_kind,
    actual_kind,
  };
}

function invalidJsonSyntaxDiagnostic(): DaemonApiContractRejectionDiagnostic {
  return {
    cause: "invalid_json_syntax",
    path: "<unavailable>",
    expected_kind: "unavailable",
    actual_kind: "unavailable",
  };
}

function encodeQuery<K extends DaemonApiRouteKey>(
  routeKey: K,
  query: DaemonApiRequestQueryByRoute[K] | undefined,
): URLSearchParams | DaemonApiRawFailure<K> | undefined {
  if (query === undefined) return undefined;
  const route = daemonApiContract[routeKey];
  let parsed: Record<string, unknown>;
  try {
    parsed = "query" in route.request ? route.request.query.parse(query) as Record<string, unknown> : {};
  } catch (cause) {
    return failure(routeKey, "request_contract_mismatch", `Daemon API ${route.key} query did not match the shared contract`, {
      contractRejection: diagnosticFromZodError(cause, query),
    });
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

function parseBody<K extends DaemonApiRouteKey>(
  routeKey: K,
  body: DaemonApiRequestBodyByRoute[K] | undefined,
): DaemonApiRequestBodyByRoute[K] | undefined | DaemonApiRawFailure<K> {
  if (body === undefined) return undefined;
  const route = daemonApiContract[routeKey];
  try {
    return ("body" in route.request ? route.request.body.parse(body) : undefined) as DaemonApiRequestBodyByRoute[K] | undefined;
  } catch (cause) {
    return failure(routeKey, "request_contract_mismatch", `Daemon API ${route.key} body did not match the shared contract`, {
      contractRejection: diagnosticFromZodError(cause, body),
    });
  }
}

function isDaemonApiRawFailure<K extends DaemonApiRouteKey>(
  value: unknown,
): value is DaemonApiRawFailure<K> {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { reason?: unknown }).reason === "string" &&
    typeof (value as { message?: unknown }).message === "string",
  );
}

export function buildDaemonApiRawRoutePath<K extends DaemonApiRouteKey>(
  routeKey: K,
  options: {
    pathPrefix?: string;
    query?: DaemonApiRequestQueryByRoute[K];
  } = {},
): string | DaemonApiRawFailure<K> {
  const route = daemonApiContract[routeKey];
  const query = encodeQuery(routeKey, options.query);
  if (query && !(query instanceof URLSearchParams)) return query;
  const suffix = query && query.size > 0 ? `?${query.toString()}` : "";
  return `${options.pathPrefix ?? DAEMON_API_BASE_PATH}${route.path}${suffix}`;
}

export async function requestDaemonApiRawRoute<K extends DaemonApiRouteKey>(
  transport: DaemonApiRawTransport,
  routeKey: K,
  options: {
    pathPrefix?: string;
    query?: DaemonApiRequestQueryByRoute[K];
    body?: DaemonApiRequestBodyByRoute[K];
  } = {},
): Promise<DaemonApiRawResult<K>> {
  const route = daemonApiContract[routeKey];
  const path = buildDaemonApiRawRoutePath(routeKey, options);
  if (typeof path !== "string") return path;
  const body = parseBody(routeKey, options.body);
  if (isDaemonApiRawFailure<K>(body)) return body;

  let response: DaemonApiRawTransportResponse;
  try {
    response = await transport.request({
      routeKey,
      method: route.method,
      path,
      body,
    });
  } catch (cause) {
    return failure(routeKey, "transport_error", `Daemon API ${route.key} transport request failed`, { cause });
  }

  if (!response.ok && response.errorCode === "INVALID_JSON_RESPONSE") {
    return failure(routeKey, "response_contract_mismatch", `Daemon API ${route.key} response did not contain valid JSON`, {
      status: response.status,
      contractRejection: invalidJsonSyntaxDiagnostic(),
    });
  }
  if (!response.ok) {
    return failure(routeKey, "http_error", response.error ?? `HTTP ${response.status}`, {
      status: response.status,
      errorCode: response.errorCode,
      suggestedNextAction: response.suggestedNextAction,
      response: response.data,
    });
  }
  if (response.data === null) {
    return failure(routeKey, "response_contract_mismatch", `Daemon API ${route.key} response did not contain valid JSON`, {
      status: response.status,
      contractRejection: invalidJsonSyntaxDiagnostic(),
    });
  }

  try {
    return {
      ok: true,
      routeKey,
      status: response.status,
      data: parseDaemonApiResponse(routeKey, response.data),
    };
  } catch (cause) {
    return failure(routeKey, "response_contract_mismatch", `Daemon API ${route.key} response did not match the shared contract`, {
      status: response.status,
      contractRejection: diagnosticFromZodError(cause, response.data),
    });
  }
}

function requestOptionsFromMethodArgs<K extends DaemonApiRouteKey>(
  routeKey: K,
  pathPrefix: string,
  args: readonly unknown[],
): {
  pathPrefix: string;
  query?: DaemonApiRequestQueryByRoute[K];
  body?: DaemonApiRequestBodyByRoute[K];
} {
  const route = daemonApiContract[routeKey];
  let index = 0;
  const requestOptions: {
    pathPrefix: string;
    query?: DaemonApiRequestQueryByRoute[K];
    body?: DaemonApiRequestBodyByRoute[K];
  } = { pathPrefix };
  if ("query" in route.request) {
    requestOptions.query = args[index++] as DaemonApiRequestQueryByRoute[K];
  }
  if ("body" in route.request) {
    requestOptions.body = args[index++] as DaemonApiRequestBodyByRoute[K];
  }
  return requestOptions;
}

export function createDaemonApiRawClient(
  transport: DaemonApiRawTransport,
  options: DaemonApiRawClientOptions = {},
): DaemonApiRawClient {
  const pathPrefix = options.pathPrefix ?? DAEMON_API_BASE_PATH;
  const client: Partial<Record<DaemonApiRawClientResource, Record<string, unknown>>> = {};
  for (const route of Object.values(daemonApiContract)) {
    const routeKey = route.key as DaemonApiRouteKey;
    const { resource, method } = route.client as {
      resource: DaemonApiRawClientResource;
      method: string;
    };
    const resourceClient = client[resource] ??= {};
    resourceClient[method] = (...args: unknown[]) =>
      requestDaemonApiRawRoute(
        transport,
        routeKey,
        requestOptionsFromMethodArgs(routeKey, pathPrefix, args),
      );
  }
  return client as DaemonApiRawClient;
}

export type DaemonApiRawClientMethodResult<
  R extends DaemonApiRawClientResource,
  M extends DaemonApiRawClientResourceMethod<R>,
> = DaemonApiRawResult<DaemonApiRouteKeyForClient<R, M>>;

export type DaemonApiRawClientMethodResponse<
  R extends DaemonApiRawClientResource,
  M extends DaemonApiRawClientResourceMethod<R>,
> = DaemonApiResponseForClient<R, M>;
