import type { TraceAttributes } from "@botiverse/raft-shared";
import { sanitizeRouteErrorMessage } from "./routeFailure.js";

export const MESSAGE_SEARCH_TRACE_KIND = "message_search";

export function messageSearchParamTraceAttrs(params: {
  query: string;
  channelId?: string;
  senderId?: string;
  senderType?: "user" | "agent";
  mentionTarget?: "self";
  after?: Date;
  before?: Date;
  sort: string;
  limit: number;
  offset: number;
}): TraceAttributes {
  return {
    event_kind: MESSAGE_SEARCH_TRACE_KIND,
    query_present: params.query.length > 0,
    query_length_bucket: queryLengthBucket(params.query),
    channel_filter_present: Boolean(params.channelId),
    sender_filter_present: Boolean(params.senderId),
    sender_type_filter: params.senderType ?? "any",
    mention_target_filter: params.mentionTarget ?? "none",
    after_filter_present: Boolean(params.after),
    before_filter_present: Boolean(params.before),
    sort: params.sort,
    limit: params.limit,
    offset_present: params.offset > 0,
  };
}

export function messageSearchErrorTraceAttrs(error: unknown, context: { query?: string } = {}): TraceAttributes {
  const errorLike = error as { code?: unknown; message?: unknown } | null;
  const cause = (error as { cause?: unknown } | null)?.cause;
  const causeLike = cause as { code?: unknown; message?: unknown } | null;
  const errorCode = typeof errorLike?.code === "string" && errorLike.code
    ? errorLike.code
    : typeof causeLike?.code === "string" && causeLike.code
      ? causeLike.code
    : undefined;
  const message = cause instanceof Error && cause.message
    ? cause.message
    : error instanceof Error
    ? error.message
    : typeof errorLike?.message === "string"
      ? errorLike.message
      : String(error ?? "");

  return {
    error_class: error instanceof Error ? error.name : typeof error,
    ...(cause instanceof Error ? { error_cause_class: cause.name } : {}),
    ...(errorCode ? { error_code: errorCode, sqlstate: errorCode } : {}),
    error_message: sanitizeRouteErrorMessage(scrubSearchErrorMessage(message, context.query)),
  };
}

function queryLengthBucket(query: string): "empty" | "short" | "medium" | "long" {
  const length = query.trim().length;
  if (length === 0) return "empty";
  if (length <= 32) return "short";
  if (length <= 128) return "medium";
  return "long";
}

function scrubSearchErrorMessage(message: string, query: string | undefined): string {
  let scrubbed = message.replace(/\bparams:\s*[\s\S]*$/i, "params: [redacted]");
  const trimmedQuery = query?.trim();
  if (trimmedQuery) {
    scrubbed = replaceAllLiteral(scrubbed, trimmedQuery, "[search_query]");
    const normalizedQuery = trimmedQuery.replace(/[-_\s]+/g, " ").trim();
    if (normalizedQuery && normalizedQuery !== trimmedQuery) {
      scrubbed = replaceAllLiteral(scrubbed, normalizedQuery, "[search_query]");
    }
  }
  return scrubbed;
}

function replaceAllLiteral(input: string, search: string, replacement: string): string {
  return input.replace(new RegExp(escapeRegExp(search), "gi"), replacement);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
