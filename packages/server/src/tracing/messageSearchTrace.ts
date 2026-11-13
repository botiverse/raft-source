import type { TraceAttributes } from "@botiverse/raft-shared";
import { sanitizeRouteErrorMessage } from "./routeFailure";
import { errorClassOf } from "./semanticTrace";

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
  /** Tokens the search actually uses (tokenizeSearchText); only the service knows it. */
  queryTokenCount?: number;
}): TraceAttributes {
  return {
    event_kind: MESSAGE_SEARCH_TRACE_KIND,
    query_present: params.query.length > 0,
    query_length_bucket: queryLengthBucket(params.query),
    query_script: queryScript(params.query),
    ...(params.queryTokenCount === undefined
      ? {}
      : { query_term_count_bucket: queryTermCountBucket(params.queryTokenCount) }),
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
    error_class: errorClassOf(error),
    ...(cause instanceof Error ? { error_cause_class: cause.name } : {}),
    ...(errorCode ? { error_code: errorCode, sqlstate: errorCode } : {}),
    error_message: sanitizeRouteErrorMessage(scrubSearchErrorMessage(message, context.query)),
  };
}

export function queryLengthBucket(query: string): "empty" | "short" | "medium" | "long" {
  const length = query.trim().length;
  if (length === 0) return "empty";
  if (length <= 32) return "short";
  if (length <= 128) return "medium";
  return "long";
}

// Shape only, never the text: which script the query is written in, so
// relevance work can be split by CJK vs Latin without reading the query.
export function queryScript(query: string): "empty" | "cjk" | "latin" | "mixed" | "other" {
  const trimmed = query.trim();
  if (!trimmed) return "empty";
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(trimmed);
  const latin = /\p{Script=Latin}/u.test(trimmed);
  if (cjk && latin) return "mixed";
  if (cjk) return "cjk";
  if (latin) return "latin";
  return "other";
}

export function queryTermCountBucket(count: number): "0" | "1" | "2" | "3" | "4+" {
  if (count <= 0) return "0";
  if (count >= 4) return "4+";
  return String(count) as "1" | "2" | "3";
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
