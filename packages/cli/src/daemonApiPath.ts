import {
  buildDaemonApiRawRoutePath,
  createDaemonApiClient as createSharedDaemonApiClient,
  type DaemonApiClientFailure,
  type DaemonApiClientResult,
  type DaemonApiContractRejectionDiagnostic,
  type DaemonApiRawFailure,
  type DaemonApiRawTransport,
  type DaemonApiRequestBodyByRoute,
  type DaemonApiRequestQueryByRoute,
  type DaemonApiResponseByRoute,
  type DaemonApiRouteKey,
} from "@botiverse/raft-shared";

import type { ApiResponse } from "./client.js";
import { CliError } from "./core/errors.js";

interface CliDaemonApiHttpClient {
  request<T>(method: string, pathname: string, body?: unknown): Promise<ApiResponse<T>>;
}

function rawTransportForClient(client: CliDaemonApiHttpClient): DaemonApiRawTransport {
  return {
    request: (input) => client.request<unknown>(input.method, input.path, input.body),
  };
}

function contractRejectionDetails(
  diagnostic: DaemonApiContractRejectionDiagnostic | undefined,
): Record<string, unknown> | undefined {
  if (!diagnostic) return undefined;
  return {
    daemon_api_contract_rejection: diagnostic,
  };
}

function contractRejectionMessage(message: string, diagnostic: DaemonApiContractRejectionDiagnostic | undefined): string {
  if (!diagnostic) return message;
  return `${message} (cause=${diagnostic.cause}; path=${diagnostic.path}; expected_kind=${diagnostic.expected_kind}; actual_kind=${diagnostic.actual_kind})`;
}

function cliErrorFromRawFailure(failure: DaemonApiRawFailure): CliError {
  switch (failure.reason) {
    case "request_contract_mismatch":
      return new CliError({
        code: "INVALID_ARG",
        message: contractRejectionMessage(failure.message, failure.contractRejection),
        cause: failure.cause,
        details: contractRejectionDetails(failure.contractRejection),
      });
    case "empty_response":
    case "response_contract_mismatch":
      return new CliError({
        code: "INVALID_JSON_RESPONSE",
        message: contractRejectionMessage(failure.message, failure.contractRejection),
        cause: failure.cause,
        details: contractRejectionDetails(failure.contractRejection),
      });
    case "transport_error":
    case "http_error":
      return new CliError({
        code: "CHECK_FAILED",
        message: failure.message,
        cause: failure.cause,
      });
  }
}

function cliErrorFromClientFailure(failure: DaemonApiClientFailure): CliError {
  switch (failure.error.kind) {
    case "validation":
      switch (failure.error.reason) {
        case "request_contract_mismatch":
          return new CliError({
            code: "INVALID_ARG",
            message: contractRejectionMessage(failure.error.message, failure.error.contractRejection),
            cause: failure.error.cause,
            details: contractRejectionDetails(failure.error.contractRejection),
          });
        case "empty_response":
        case "response_contract_mismatch":
          return new CliError({
            code: "INVALID_JSON_RESPONSE",
            message: contractRejectionMessage(failure.error.message, failure.error.contractRejection),
            cause: failure.error.cause,
            details: contractRejectionDetails(failure.error.contractRejection),
          });
      }
      break;
    case "transport":
      return new CliError({
        code: "CHECK_FAILED",
        message: failure.error.message,
        cause: failure.error.cause,
      });
    case "http":
      return new CliError({
        code: "CHECK_FAILED",
        message: failure.error.message,
      });
  }
}

function apiResponseFromClientResult<K extends DaemonApiRouteKey>(
  result: DaemonApiClientResult<K>,
): ApiResponse<DaemonApiResponseByRoute[K]> {
  if (result.ok) {
    return {
      ok: true,
      status: result.status,
      data: result.data,
      error: null,
    };
  }
  if (result.error.kind === "http") {
    return {
      ok: false,
      status: result.error.status,
      data: null,
      error: result.error.message,
      errorCode: result.error.errorCode,
      suggestedNextAction: result.error.suggestedNextAction,
    };
  }
  throw cliErrorFromClientFailure(result);
}

async function requestClientAsApiResponse<K extends DaemonApiRouteKey>(
  result: Promise<DaemonApiClientResult<K>>,
): Promise<ApiResponse<DaemonApiResponseByRoute[K]>> {
  return apiResponseFromClientResult(await result);
}

export function buildDaemonApiRoutePath<K extends DaemonApiRouteKey>(
  routeKey: K,
  query?: DaemonApiRequestQueryByRoute[K],
): string {
  const path = buildDaemonApiRawRoutePath(routeKey, { query });
  if (typeof path === "string") return path;
  throw cliErrorFromRawFailure(path);
}

export function createDaemonApiSurfaceClient(client: CliDaemonApiHttpClient) {
  // Keep command code on generated methods while still routing through the
  // normal CLI ApiClient. ApiClient already knows the active profile's local
  // daemon proxy URL/token; callers should not learn daemon ports or decide
  // which daemon-api paths are intercepted locally versus forwarded upstream.
  const daemonApi = createSharedDaemonApiClient(rawTransportForClient(client));
  return {
    runtime: {
      version: () =>
        requestClientAsApiResponse(daemonApi.runtime.version()),
    },
    inbox: {
      check: () =>
        requestClientAsApiResponse(daemonApi.inbox.check()),
      ack: (body: DaemonApiRequestBodyByRoute["inboxAck"]) =>
        requestClientAsApiResponse(daemonApi.inbox.ack(body)),
    },
    wakeHints: {
      fetch: (query: DaemonApiRequestQueryByRoute["wakeHintsFetch"]) =>
        requestClientAsApiResponse(daemonApi.wakeHints.fetch(query)),
    },
    activity: {
      forward: (body: DaemonApiRequestBodyByRoute["activityForward"]) =>
        requestClientAsApiResponse(daemonApi.activity.forward(body)),
    },
  };
}
