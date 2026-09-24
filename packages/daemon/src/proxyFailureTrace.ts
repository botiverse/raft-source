import type { AgentProxyFailure, AgentProxyTransportNormalizedError } from "./agentCredentialProxy.js";
import { routeFamilyForPath } from "./agentCredentialProxy.js";

export type DaemonProxyFailureReason =
  | "local_daemon_state_invalid"
  | "dns"
  | "tcp"
  | "tls"
  | "read_timeout"
  | "proxy_connect"
  | "fly_edge"
  | "unknown";

function failureReason(input: AgentProxyFailure): DaemonProxyFailureReason {
  if (input.lifecycleInvalidContext) return "local_daemon_state_invalid";
  const causeCode = (input.causeCode ?? "").toUpperCase();
  const text = `${input.errorCause ?? ""} ${input.errorMessage}`.toLowerCase();
  if (/enotfound|eai_again|\bdns\b/.test(text)) return "dns";
  if (/econnrefused|econnreset|epipe|und_err_socket|\bsocket\b|other side closed|terminated/.test(text)) return "tcp";
  if (/certificate|\btls\b/.test(text)) return "tls";
  if (causeCode === "UND_ERR_HEADERS_TIMEOUT" || causeCode === "UND_ERR_BODY_TIMEOUT") return "read_timeout";
  if (/\bproxy\b/.test(text)) return "proxy_connect";
  if (/\bfly\b/.test(text)) return "fly_edge";
  return "unknown";
}

function boundedErrorClass(value: string): "TypeError" | "AbortError" | "Error" | "OtherError" {
  if (value === "TypeError") return "TypeError";
  if (value === "AbortError") return "AbortError";
  if (value === "Error") return "Error";
  return "OtherError";
}

function boundedMethod(value: string): string {
  const method = value.toUpperCase();
  return ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(method)
    ? method
    : "OTHER";
}

function cannedExcerpt(reason: DaemonProxyFailureReason): string {
  switch (reason) {
    case "local_daemon_state_invalid": return "Local daemon lifecycle state rejected the proxy request";
    case "dns": return "Upstream DNS resolution failed";
    case "tcp": return "Upstream TCP connection failed";
    case "tls": return "Upstream TLS negotiation failed";
    case "read_timeout": return "Upstream response timed out";
    case "proxy_connect": return "Upstream proxy connection failed";
    case "fly_edge": return "Upstream edge transport failed";
    case "unknown": return "Proxy request failed with an unclassified cause";
  }
}

export function daemonProxyFailureTraceAttrs(input: AgentProxyFailure): Record<string, unknown> {
  const reason = failureReason(input);
  return {
    route_family: routeFamilyForPath(input.pathname),
    method: boundedMethod(input.method),
    outcome: "error",
    reason,
    error_class: boundedErrorClass(input.errorName),
    error_excerpt: cannedExcerpt(reason),
    ...(input.failureClass ? { failure_class: input.failureClass } : {}),
    ...(typeof input.responseStarted === "boolean" ? { response_started: input.responseStarted } : {}),
    ...(typeof input.responseComplete === "boolean" ? { response_complete: input.responseComplete } : {}),
    ...(input.causeCode ? { cause_code: input.causeCode } : {}),
    ...(typeof input.responseStatusCode === "number" ? { response_status_code: input.responseStatusCode } : {}),
    response_code_present: Boolean(input.responseCode),
  };
}

export function daemonTransportErrorExcerpt(input: AgentProxyTransportNormalizedError): string {
  if (input.normalizedCode === "local_daemon_state_invalid") {
    return "Local daemon lifecycle state rejected the proxy request";
  }
  if (input.normalizedCode === "server_5xx") return "Upstream server returned a 5xx response";
  switch (input.upstreamLayer) {
    case "dns": return "Upstream DNS resolution failed";
    case "tcp": return "Upstream TCP connection failed";
    case "tls": return "Upstream TLS negotiation failed";
    case "read_timeout": return "Upstream response timed out";
    case "proxy_connect": return "Upstream proxy connection failed";
    case "fly_edge": return "Upstream edge transport failed";
    case "body_decode_failure": return "Upstream response body could not be decoded";
    case "http_status": return "Upstream HTTP request failed";
    case "unknown": return "Proxy transport failed with an unclassified cause";
  }
}
