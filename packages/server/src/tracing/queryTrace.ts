import { currentTimeMs, type TraceAttributes } from "@botiverse/raft-shared";
import { withTraceChildSpan } from "./semanticTrace.js";

export type QueryFailureReason =
  | "statement_timeout"
  | "client_aborted"
  | "database_error"
  | "unknown";

function errorCode(error: unknown): string | undefined {
  const direct = error as { code?: unknown } | null;
  const cause = (error as { cause?: unknown } | null)?.cause as { code?: unknown } | null;
  if (typeof direct?.code === "string" && direct.code) return direct.code;
  if (typeof cause?.code === "string" && cause.code) return cause.code;
  return undefined;
}

export function boundedErrorClass(error: unknown): string {
  if (errorCode(error)) return "DatabaseError";
  if (error instanceof Error && error.name === "AbortError") return "AbortError";
  if (error instanceof Error) return "Error";
  return "NonError";
}

function sqlState(error: unknown): string | undefined {
  const code = errorCode(error);
  return code && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

export function queryFailureReason(error: unknown): QueryFailureReason {
  const code = errorCode(error);
  if (code === "57014") return "statement_timeout";
  if (error instanceof Error && error.name === "AbortError") return "client_aborted";
  if (code) return "database_error";
  return "unknown";
}

function cannedQueryErrorExcerpt(reason: QueryFailureReason): string {
  switch (reason) {
    case "statement_timeout": return "Database statement canceled by timeout";
    case "client_aborted": return "Database statement canceled after client abort";
    case "database_error": return "Database statement failed";
    case "unknown": return "Database operation failed with an unclassified cause";
  }
}

export function queryFailureTraceAttrs(error: unknown): TraceAttributes {
  const reason = queryFailureReason(error);
  const code = sqlState(error);
  return {
    outcome: "error",
    reason,
    error_class: boundedErrorClass(error),
    error_message: cannedQueryErrorExcerpt(reason),
    ...(code ? { sqlstate: code } : {}),
  };
}

export function timeoutBucket(durationMs: number): string {
  if (durationMs < 1000) return "<1s";
  if (durationMs < 5000) return "1-5s";
  if (durationMs < 15000) return "5-15s";
  return ">15s";
}

/**
 * Conservative failure diagnostics: only well-known retryable SQLSTATEs
 * (statement timeout, connection loss, admin shutdown) flip retryable to
 * "true"; everything else stays "false" rather than guessing.
 */
export function queryFailureDiagnostics(
  error: unknown,
  durationMs: number,
): { sqlstate?: string; retryable: "true" | "false"; timeout_bucket: string } {
  const code = sqlState(error);
  const retryable = code !== undefined && (
    code === "57014"
    || code.startsWith("08")
    || code === "57P01"
    || code === "57P02"
    || code === "57P03"
  );
  return {
    ...(code ? { sqlstate: code } : {}),
    retryable: retryable ? "true" : "false",
    timeout_bucket: timeoutBucket(durationMs),
  };
}

export async function traceQuerySpan<T>(
  input: {
    queryName: string;
    phase: string;
    dbSystem?: string;
    attrs?: TraceAttributes;
    successAttrs?: (result: T) => TraceAttributes;
  },
  work: () => Promise<T>,
): Promise<T> {
  const startedAt = currentTimeMs();
  return withTraceChildSpan(
    "server.db.query",
    {
      surface: "server",
      kind: "client",
      attrs: {
        event_kind: "db_query",
        query_name: input.queryName,
        phase: input.phase,
        ...(input.dbSystem ? { db_system: input.dbSystem } : {}),
        ...input.attrs,
      },
    },
    work,
    {
      onSuccess: (result) => ({
        outcome: "success",
        reason: "query_completed",
        timeout_bucket: timeoutBucket(currentTimeMs() - startedAt),
        ...input.successAttrs?.(result),
      }),
      onError: (error) => ({
        ...queryFailureTraceAttrs(error),
        ...queryFailureDiagnostics(error, currentTimeMs() - startedAt),
        ...(input.dbSystem ? { db_system: input.dbSystem } : {}),
      }),
    },
  );
}
