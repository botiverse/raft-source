import { currentTimeMs, type TraceAttributes } from "@botiverse/raft-shared";
import { withTraceChildSpan } from "./semanticTrace";

export type QueryFailureReason =
  | "statement_timeout"
  | "client_aborted"
  | "database_error"
  | "unknown";

// Driver errors carry their SQLSTATE on `.code`, but they reach us wrapped by
// however many layers sit between the query and here. Checking only the error
// and its immediate cause classified anything wrapped twice as "unknown",
// which is indistinguishable from an application error that never had a code
// at all.
const MAX_CAUSE_DEPTH = 8;

function isSqlStateShaped(code: string): boolean {
  return /^[0-9A-Z]{5}$/.test(code);
}

function errorCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  // A transport wrapper can carry its own non-SQLSTATE `code` (ETIMEDOUT,
  // ECONNRESET) above the driver error that actually explains the failure.
  // Taking the first code found would let that shadow the SQLSTATE, so prefer
  // a SQLSTATE-shaped code from anywhere in the chain and fall back to the
  // outermost code only when no SQLSTATE exists.
  let fallback: string | undefined;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (current === null || typeof current !== "object") break;
    // Cause chains can be cyclic; a repeat means there is nothing new below.
    if (seen.has(current)) break;
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && code) {
      if (isSqlStateShaped(code)) return code;
      fallback ??= code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return fallback;
}

/**
 * The error's constructor name, bounded to a conservative character set and
 * length. This is type information only -- never a message, and never a value
 * -- so it can be attached to a failure span that deliberately refuses to
 * record the real error text.
 */
export function boundedErrorTypeName(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const name = (error as { constructor?: { name?: unknown } }).constructor?.name;
  if (typeof name !== "string" || !name) return undefined;
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) return undefined;
  return name;
}

export function boundedErrorClass(error: unknown): string {
  if (errorCode(error)) return "DatabaseError";
  if (error instanceof Error && error.name === "AbortError") return "AbortError";
  if (error instanceof Error) return "Error";
  return "NonError";
}

function sqlState(error: unknown): string | undefined {
  const code = errorCode(error);
  return code && isSqlStateShaped(code) ? code : undefined;
}

/** The violated constraint's name from the driver error chain (an identifier, never a value). */
function dbConstraintName(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (current === null || typeof current !== "object" || seen.has(current)) return undefined;
    seen.add(current);
    const constraint = (current as { constraint?: unknown }).constraint;
    if (typeof constraint === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(constraint)) return constraint;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * What a route failure can say about its cause without its text
 * (#proj-o11y:#29): the SQLSTATE and constraint name of a database error and
 * the error's type name. Postgres error text often carries the offending
 * value (`Key (email)=(...) already exists`), so it stays out; these are codes
 * and identifiers only.
 */
export function errorDiagnosisAttrs(error: unknown): TraceAttributes {
  const code = sqlState(error);
  const constraint = code ? dbConstraintName(error) : undefined;
  const typeName = boundedErrorTypeName(error);
  return {
    ...(code ? { sqlstate: code } : {}),
    ...(constraint ? { db_constraint: constraint } : {}),
    ...(typeName ? { error_type: typeName } : {}),
  };
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
  const typeName = boundedErrorTypeName(error);
  return {
    outcome: "error",
    reason,
    error_class: boundedErrorClass(error),
    error_message: cannedQueryErrorExcerpt(reason),
    ...(code ? { sqlstate: code } : {}),
    // `reason: "unknown"` alone cannot say whether the cause was an
    // application error or a driver error we failed to unwrap. The type name
    // separates those without recording any error text.
    ...(typeName ? { error_type: typeName } : {}),
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
/**
 * Upper bound on the recorded message. Generous on purpose: the point is to keep
 * the reason INTACT, and a driver message that needs more than this is already
 * pathological. Only the tail is dropped, because drivers put the reason first.
 */
const TRACE_ERROR_MESSAGE_MAX_CHARS = 4_096;

/**
 * Postgres puts row VALUES in the secondary fields of an error — DETAIL on a
 * unique violation prints the conflicting key, e.g. `Key (email)=(a@b.test)`.
 * Those must never reach a trace store. The primary message before the first
 * such marker is the reason and carries no row data, so that is what we keep.
 *
 * Connection/pool-layer failures (`timeout exceeded when trying to connect`,
 * ECONNREFUSED, `Connection terminated unexpectedly`) have no secondary fields
 * at all, and those are exactly the failures that were unreadable during the
 * 2026-09-19 incident — so this trade costs nothing where it matters most.
 */
const TRACE_ERROR_MESSAGE_SECONDARY_FIELD = /\b(DETAIL|HINT|CONTEXT|QUERY|WHERE)\s*:/i;

/** Connection strings carry credentials in userinfo and name internal hosts;
 * neither belongs in a trace store. The scheme is kept so the message still
 * reads ("connect failed for <redacted-url>"). */
const TRACE_ERROR_MESSAGE_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi;

/**
 * libpq KEYWORD-FORM DSN secrets -- `host=db user=raft password=hunter2` has no
 * scheme, so TRACE_ERROR_MESSAGE_URL cannot see it. The key is kept -- its name
 * is the diagnosis -- and only the value removed. Mirrors SPILLED_DSN_SECRET in
 * ./routeFailure.ts; the two are consolidated by the shared-enforcer work.
 */
const TRACE_ERROR_MESSAGE_DSN_SECRET =
  /\b(pass(?:word|file)|sslkey|sslcert|sslrootcert|sslpassword|token|secret)\s*=\s*('(?:[^']|'')*'|"[^"]*"|\S+)/gi;
/// Keeps the key and redacts only the value; `$1` is the key. A value may be
/// quoted and contain spaces, so a bare \S+ would stop at the first space and
/// leak the remainder.
const TRACE_ERROR_MESSAGE_DSN_SECRET_REPLACEMENT = "$1=<redacted-secret>";

/** Some wrappers append the statement text to a failure message. Query text is
 * parameterized but still names our schema; cut from the first bare uppercase
 * statement keyword — driver prose ("could not select...") is lowercase and
 * survives. */
const TRACE_ERROR_MESSAGE_SQL_START =
  /\b(SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE)\b/;

/** Scrub ONE layer's message. Returns undefined when that layer says nothing usable. */
function scrubOneMessage(source: unknown): string | undefined {
  const raw = source instanceof Error
    ? source.message
    : typeof source === "string" ? source : undefined;
  if (!raw) return undefined;
  const [primary] = raw.split(TRACE_ERROR_MESSAGE_SECONDARY_FIELD);
  const urlRedacted = (primary ?? "")
    .replace(TRACE_ERROR_MESSAGE_URL, "<redacted-url>")
    .replace(TRACE_ERROR_MESSAGE_DSN_SECRET, TRACE_ERROR_MESSAGE_DSN_SECRET_REPLACEMENT);
  const sqlStart = urlRedacted.match(TRACE_ERROR_MESSAGE_SQL_START);
  const sqlCut = sqlStart?.index !== undefined ? urlRedacted.slice(0, sqlStart.index) : urlRedacted;
  const collapsed = sqlCut.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  return collapsed.length > TRACE_ERROR_MESSAGE_MAX_CHARS
    ? `${collapsed.slice(0, TRACE_ERROR_MESSAGE_MAX_CHARS)}…`
    : collapsed;
}

/**
 * A quoted literal in driver prose: where Postgres inlines a failing VALUE.
 *
 * Not every quoted literal is data. A unique-violation names its constraint --
 * `"messages_pkey"` -- which is schema vocabulary: no user data, and the most
 * useful part of that message. Only quoted content that looks like DATA (an
 * identifier, an address, a URL, anything carrying spaces or punctuation that a
 * bare lowercase name would not) counts as a value. A plain `[a-z_][a-z0-9_]*`
 * literal is treated as a name and left in place.
 */
const TRACE_ERROR_MESSAGE_QUOTED_VALUE = /"([^"]{1,})"/g;
const TRACE_ERROR_MESSAGE_SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;
function messageEmbedsValue(message: string): boolean {
  for (const match of message.matchAll(TRACE_ERROR_MESSAGE_QUOTED_VALUE)) {
    if (!TRACE_ERROR_MESSAGE_SCHEMA_NAME.test(match[1] ?? "")) return true;
  }
  return false;
}

/**
 * The scrubbed failure message, returned only when the text carries no inlined value.
 *
 * WHY THIS FIELD EXISTS (stated where it is consumed, and unchanged): `error_class`
 * is one coarse token and `sqlstate` is absent for every socket/pool-layer failure,
 * so without the message a failed query cannot say why. Measured over 12h of
 * production db spans, 8 of the 11 records that carry a message are exactly that
 * case -- a statement timeout, which holds no user data.
 *
 * WHY THE TEXT IS SOMETIMES WITHHELD: the comment above the secondary-field split
 * assumed the primary message holds the cause and no row data. That assumption is
 * false for a whole class of Postgres errors, where the value is INLINED in the
 * primary text:
 *
 *     invalid input syntax for type uuid: "6f38f98d-..."
 *
 * so the message is dropped whenever it contains a quoted literal, and the caller
 * falls back to the canned excerpt plus the SQLSTATE (22P02 already names that
 * cause). Errors whose wording carries no value -- statement timeouts, unique
 * violations naming a constraint -- keep their message.
 *
 * ⚠️ SCOPE -- READ THIS BEFORE TREATING THE RULE AS A GUARANTEE.
 *
 * The direction of this rule is FAIL-OPEN: it withholds the message only when
 * it RECOGNISES an inlined value. Anything it does not recognise is carried --
 * an unquoted identifier, a value whose wording it has not seen, a form
 * introduced by a future Postgres version. An attachment UUID was observed
 * reaching this field in production, and that is an instance of the default
 * behaviour, not an exception to it.
 *
 * So the coverage cannot be enumerated, and a list of "what it does not catch"
 * would read as if it were complete. To use this as a guarantee, invert the
 * default first: withhold unless the message is positively known to be
 * value-free.
 */
export function traceErrorMessage(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  let message: string | undefined;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    const scrubbed = scrubOneMessage(current);
    if (scrubbed) message = scrubbed;
    if (current === null || typeof current !== "object") break;
    if (seen.has(current)) break;
    seen.add(current);
    const next = (current as { cause?: unknown }).cause;
    if (next === undefined) break;
    current = next;
  }
  if (message !== undefined && messageEmbedsValue(message)) {
    return undefined;
  }
  return message;
}

export function queryFailureDiagnostics(
  error: unknown,
  durationMs: number,
): {
  sqlstate?: string;
  retryable: "true" | "false";
  timeout_bucket: string;
  error_message?: string;
} {
  const code = sqlState(error);
  const retryable = code !== undefined && (
    code === "57014"
    || code.startsWith("08")
    || code === "57P01"
    || code === "57P02"
    || code === "57P03"
  );
  const message = traceErrorMessage(error);
  return {
    ...(code ? { sqlstate: code } : {}),
    retryable: retryable ? "true" : "false",
    timeout_bucket: timeoutBucket(durationMs),
    // error_class is a single coarse token and sqlstate is absent for every
    // socket/pool-layer failure, so without the message a failed query cannot
    // say why it failed. Carried for ALL db systems, not just RisingWave.
    ...(message ? { error_message: message } : {}),
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
