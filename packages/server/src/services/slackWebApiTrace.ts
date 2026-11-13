import type { TraceAttributes } from "@botiverse/raft-shared";

import { withTraceChildSpan } from "../tracing/semanticTrace";
import type { SlackWebApiTransportResult } from "./slackProviderAdapter";

export const SLACK_WEB_API_REQUEST_SPAN = "server.slack_bridge.slack_api.request";

// Web API method names are code constants (`conversations.members`), but the
// span only ever carries a bounded method-shaped string; anything else is
// recorded as "other" so a caller bug cannot put arbitrary text on a span.
const SLACK_METHOD_PATTERN = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+){1,3}$/;
// Slack `error` codes are short snake_case identifiers (`ratelimited`,
// `channel_not_found`). Anything else is collapsed so body text never leaks.
const SLACK_ERROR_CODE_PATTERN = /^[a-z0-9_]{1,64}$/;

export type SlackWebApiRequestOutcome = "ok" | "http_error" | "slack_error" | "transport_error";

function slackMethodAttr(method: string): string {
  return method.length <= 80 && SLACK_METHOD_PATTERN.test(method) ? method : "other";
}

function retryAfterSeconds(headers: Readonly<Record<string, string | undefined>>): number | null {
  const raw = Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after")?.[1];
  if (!raw || !/^\d+$/.test(raw.trim())) return null;
  const seconds = Number(raw.trim());
  return Number.isSafeInteger(seconds) ? seconds : null;
}

/**
 * Span attrs for one Slack Web API result. Only the HTTP status, Slack's
 * `error` code, the Retry-After seconds and transport failure codes are
 * read; tokens, URLs, request/response bodies and Slack ids never are.
 */
export function slackWebApiResultTraceAttrs(result: SlackWebApiTransportResult): TraceAttributes {
  if (result.kind !== "response") {
    return {
      outcome: "transport_error" satisfies SlackWebApiRequestOutcome,
      rate_limited: false,
      transport_phase: result.phase,
      error_code: result.code,
    };
  }
  const rawError = result.body.ok === true ? undefined : result.body.error;
  const slackError = typeof rawError === "string"
    ? (SLACK_ERROR_CODE_PATTERN.test(rawError) ? rawError : "other")
    : null;
  const outcome: SlackWebApiRequestOutcome = result.status >= 400
    ? "http_error"
    : result.body.ok === true ? "ok" : "slack_error";
  const retryAfter = retryAfterSeconds(result.headers);
  return {
    outcome,
    http_status: result.status,
    rate_limited: result.status === 429 || slackError === "ratelimited",
    ...(retryAfter !== null ? { retry_after_s: retryAfter } : {}),
    ...(slackError !== null ? { slack_error: slackError } : {}),
  };
}

/**
 * Run one outbound Slack Web API request in a
 * `server.slack_bridge.slack_api.request` client span, so background work
 * such as the Slack Bridge lifecycle drain shows Slack latency, HTTP status,
 * 429s and Retry-After instead of an unexplained gap. Outside a trace this is
 * a no-op span. `send` must not throw for HTTP or transport failures.
 */
export function traceSlackWebApiRequest(
  method: string,
  send: () => Promise<SlackWebApiTransportResult>,
): Promise<SlackWebApiTransportResult> {
  return withTraceChildSpan(
    SLACK_WEB_API_REQUEST_SPAN,
    { surface: "server", kind: "client", attrs: { slack_method: slackMethodAttr(method) } },
    send,
    {
      onSuccess: slackWebApiResultTraceAttrs,
      onError: () => ({ outcome: "transport_error" satisfies SlackWebApiRequestOutcome, rate_limited: false }),
    },
  );
}
