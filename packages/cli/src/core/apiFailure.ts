import type { RaftOpError } from "@botiverse/raft-shared";
import { agentApiRateLimitedSentence, localProxyLifecycleCliCode, parseAgentApiRateLimitedBody } from "@botiverse/raft-shared/src/agentCliSurface";

import type { ApiProxyDiagnostics, ApiResponse } from "../client";
import { CliError, type CliErrorCode } from "./errors";

/**
 * Core's 429 RATE_LIMITED (a first-party app's writes over the agent's
 * budget; shared agentApiRateLimit.ts) as a CliError: the Server's sentence
 * (which writes, the limit, the wait), then the wait and `again`, the command
 * to run once it is over (core/commandLine.ts). The CLI never retries it
 * itself: the agent decides, so a write is not posted twice behind its back.
 */
export function rateLimitedCliError(
  error: Pick<RaftOpError, "message"> & { retryAfterSeconds: number },
  again: string | null | undefined,
  /** What the refusal left behind, said before the wait (a push: nothing pushed, files already sent kept). */
  leftBehind?: string,
): CliError {
  const seconds = error.retryAfterSeconds;
  const waitFor = `${seconds} second${seconds === 1 ? "" : "s"}`;
  const wait = leftBehind
    ? `${leftBehind} Wait ${waitFor}, then run the same command again`
    : `Wait ${waitFor}, then run the same command again (the refused request changed nothing)`;
  return new CliError({
    code: "RATE_LIMITED",
    message: error.message,
    retryable: true,
    suggestedNextAction: again ? `${wait}:\n${again}` : `${wait}.`,
  });
}

/**
 * A response that is core's 429 RATE_LIMITED (the agent's or the Server's
 * write budget, shared agentApiRateLimit.ts: an app's writes, or core's
 * writes that post or fan out): the sentence to show and the wait, else null.
 */
export function rateLimitedResponse(
  response: Pick<ApiResponse<unknown>, "status" | "errorBody">,
): { message: string; retryAfterSeconds: number } | null {
  if (response.status !== 429) return null;
  const body = parseAgentApiRateLimitedBody(response.errorBody);
  if (!body) return null;
  return { message: agentApiRateLimitedSentence(body), retryAfterSeconds: body.details.retryAfterSeconds };
}

/**
 * rateLimitedResponse as rateLimitedCliError, else null. Commands call it
 * before their own refusal code, so every budgeted write says how long to
 * wait and is marked retryable, whatever the command.
 */
export function rateLimitedResponseError(
  response: Pick<ApiResponse<unknown>, "status" | "errorBody">,
  again?: string | null,
  leftBehind?: string,
): CliError | null {
  const limited = rateLimitedResponse(response);
  return limited ? rateLimitedCliError(limited, again, leftBehind) : null;
}

/**
 * The daemon proxy's refusal of a request it can no longer serve
 * (#proj-raft-computer:#58): the launch this CLI ran from has ended and a
 * newer session replaced it (LAUNCH_SUPERSEDED), the agent has no running
 * session (AGENT_NOT_RUNNING), or a stable-entry request named another agent
 * (AGENT_ID_MISMATCH). The proxy's sentence and next action (which name only
 * the agent's stable entry) are shown as it sent them. Nothing reached the
 * Server, so nothing was done. Null for any other response.
 */
export function localProxyLifecycleError(
  response: Pick<ApiResponse<unknown>, "status" | "errorCode" | "suggestedNextAction" | "errorBody"> & { error?: string | null },
): CliError | null {
  if (response.status !== 410 && response.status !== 403) return null;
  const code = localProxyLifecycleCliCode(response.errorCode);
  if (!code) return null;
  const body = response.errorBody && typeof response.errorBody === "object" ? response.errorBody as Record<string, unknown> : {};
  const stableEntry = typeof body.stableEntry === "string" ? body.stableEntry : undefined;
  return new CliError({
    code,
    message: response.error ?? `HTTP ${response.status}`,
    effect: "not_executed",
    retryable: false,
    ...(response.suggestedNextAction ? { suggestedNextAction: response.suggestedNextAction } : {}),
    ...(stableEntry ? { details: { stableEntry } } : {}),
  });
}

type ApiFailure = Pick<ApiResponse<unknown>, "status" | "errorCode" | "suggestedNextAction" | "proxy" | "errorBody"> & {
  error?: string | null;
};

export function apiFailureError(
  response: ApiFailure,
  fallbackCode: string,
  options: {
    server5xxCode?: CliErrorCode;
    suggestedNextAction?: string;
  } = {},
): CliError {
  const rateLimited = rateLimitedResponseError(response);
  if (rateLimited) return rateLimited;
  const lifecycle = localProxyLifecycleError(response);
  if (lifecycle) return lifecycle;
  const proxyFailure = response.status >= 500 && response.errorCode === "agent_proxy_failed";
  const code = response.status >= 500
    ? proxyFailure
      ? "PROXY_5XX"
      : (response.errorCode as CliErrorCode | undefined) ?? options.server5xxCode ?? "SERVER_5XX"
    : (response.errorCode as CliErrorCode | undefined) ?? fallbackCode as CliErrorCode;
  return new CliError({
    code,
    message: response.error ?? `HTTP ${response.status}`,
    suggestedNextAction: options.suggestedNextAction
      ?? response.suggestedNextAction
      ?? (proxyFailure ? proxyFailureNextAction(response.proxy) : undefined),
    ...proxyCliErrorOptions(response.proxy),
  });
}

/**
 * Default `Next action` for a 5xx envelope generated by the local daemon proxy
 * (`code: agent_proxy_failed`), chosen by the proxy's own `failure_class`.
 *
 * The daemon writes a transport log line and span for every proxy failure, but
 * what that record contains differs by class:
 *
 * - `upstream_http_response`: the upstream answered with a 5xx that is not a
 *   deliberate answer (one with its own `error` and `code`, which the proxy
 *   relays as is). The proxy reads the upstream body and discards it; its log
 *   and span keep only the status and failure codes. The transport log therefore cannot show what the server
 *   said. The correlation id is minted by the daemon and returned downstream
 *   only; the server saw the daemon's `traceparent`, so the server-side join
 *   key is the trace id carried by the daemon proxy span that records this
 *   correlation id.
 * - `post_response_local`: the upstream response arrived in full and the local
 *   daemon then failed while processing it (task #369). Neither the network nor
 *   the server failed, so the next step is the daemon's own log, not the server.
 * - transport classes (`pre_response_transport`, `mid_response_transport`) and
 *   unknown/missing diagnostics: the proxy log records the underlying transport
 *   error and its cause, which the receipt does not carry, so inspecting it is
 *   the right first step.
 *
 * The agent reading this cannot open daemon logs or traces, so every class
 * starts with what it can do (retry once, without doing a write twice; then
 * hand the correlation id to the Computer's owner), and the diagnosis above
 * follows for whoever investigates.
 */
const PROXY_FAILURE_AGENT_STEP =
  "Retry once in a few seconds; if the command writes something, first check whether it already took effect, so it is not done twice. "
  + "If it keeps failing, tell your Computer's owner and include the correlation id. For whoever investigates: ";

export function proxyFailureNextAction(proxy: ApiProxyDiagnostics | null | undefined): string {
  return PROXY_FAILURE_AGENT_STEP + proxyFailureDiagnosis(proxy);
}

function proxyFailureDiagnosis(proxy: ApiProxyDiagnostics | null | undefined): string {
  if (proxy?.failureClass === "upstream_http_response") {
    const status = typeof proxy.upstreamStatus === "number" ? `HTTP ${proxy.upstreamStatus}` : "a 5xx";
    return `The local daemon proxy relayed ${status} from upstream and discarded the upstream response body; `
      + "its transport log records only the status and failure class. The correlation id is local to this daemon: "
      + "find the daemon proxy span that carries it, take that span's trace id, and read the server-side trace "
      + "for the request before attributing this to the server; if no such trace is found, the attribution stays unknown.";
  }
  if (proxy?.failureClass === "post_response_local") {
    return "The upstream response arrived in full; the local daemon then failed while processing it. "
      + "This is a local daemon fault, not a server or network failure: use the correlation id to find the "
      + "daemon proxy log line, whose error message names the local step that failed.";
  }
  return "This 5xx was generated by the local daemon proxy; use the correlation id to inspect daemon proxy transport logs before attributing it to the server.";
}

export function proxyCliErrorOptions(proxy: ApiProxyDiagnostics | null | undefined): {
  layer?: string;
  correlationId?: string;
  proxyFailureClass?: string;
  proxyCauseCode?: string;
  proxyRouteFamily?: string;
  proxyUpstreamLayer?: string;
  proxyUpstreamStatus?: number;
  proxyResponseStarted?: boolean | null;
  proxyResponseComplete?: boolean | null;
} {
  if (!proxy) return {};
  return {
    layer: proxy.layer ?? undefined,
    correlationId: proxy.correlationId ?? undefined,
    proxyFailureClass: proxy.failureClass ?? undefined,
    proxyCauseCode: proxy.causeCode ?? undefined,
    proxyRouteFamily: proxy.routeFamily ?? undefined,
    proxyUpstreamLayer: proxy.upstreamLayer ?? undefined,
    proxyUpstreamStatus: proxy.upstreamStatus ?? undefined,
    proxyResponseStarted: proxy.responseStarted ?? undefined,
    proxyResponseComplete: proxy.responseComplete ?? undefined,
  };
}
