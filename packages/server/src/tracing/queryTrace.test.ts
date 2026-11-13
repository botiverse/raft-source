import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { boundedErrorClass, boundedErrorTypeName, errorDiagnosisAttrs, queryFailureDiagnostics, queryFailureReason, queryFailureTraceAttrs, traceErrorMessage, traceQuerySpan } from "./queryTrace";
import { runWithTraceSpan } from "./semanticTrace";
import { traceRouteFailure } from "./routeFailure";

test("query failure attrs classify timeout and never emit raw database content", () => {
  const error = Object.assign(
    new Error("canceling statement due to statement timeout DETAIL: user query secret@example.test https://private.test"),
    { code: "57014" },
  );

  const attrs = queryFailureTraceAttrs(error);
  assert.deepEqual(attrs, {
    outcome: "error",
    reason: "statement_timeout",
    error_class: "DatabaseError",
    error_message: "Database statement canceled by timeout",
    sqlstate: "57014",
    // Added by the failure-classification change: the constructor name only.
    // The exhaustive comparison is deliberate -- it forces any new attribute
    // to be declared here, and the raw-content assertion below still holds.
    error_type: "Error",
  });
  const serialized = JSON.stringify(attrs);
  assert.doesNotMatch(serialized, /secret@example|private\.test|DETAIL|user query/);
});

test("query failure attrs reject hostile error names and non-SQLSTATE codes", () => {
  const error = Object.assign(new Error("private"), {
    name: "secret-user-class",
    code: "secret-user-code",
  });
  const attrs = queryFailureTraceAttrs(error);
  assert.equal(attrs.error_class, "DatabaseError");
  assert.equal(attrs.reason, "database_error");
  assert.equal("sqlstate" in attrs, false);
  assert.doesNotMatch(JSON.stringify(attrs), /secret-user/);
});

test("traceQuerySpan emits a parent-linked failed child with exact query binding", async () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  const root = tracer.startSpan("server.http.request", { surface: "server", kind: "server" });
  // Policy (tygg, 2026-09-20): the failure REASON is carried in tracing; row
  // VALUES still never leak. PG puts values in the secondary fields, so the
  // sensitive value is planted in DETAIL and must be stripped while the
  // primary message survives.
  const error = Object.assign(
    new Error(
      "duplicate key value violates unique constraint \"messages_pkey\" "
      + "DETAIL: Key (id)=(sensitive parameter) already exists.",
    ),
    { code: "23505" },
  );

  await assert.rejects(
    runWithTraceSpan(root, () => traceQuerySpan({
      queryName: "messages.insert",
      phase: "message_persist",
      attrs: { sender_type: "agent" },
    }, async () => { throw error; }), tracer),
    error,
  );
  root.end("error");

  const child = sink.getAllSpans().find((span) => span.name === "server.db.query");
  assert.ok(child);
  assert.equal(child.context.parentSpanId, root.context.spanId);
  assert.equal(child.status, "error");
  assert.equal(child.attrs?.query_name, "messages.insert");
  assert.equal(child.attrs?.phase, "message_persist");
  assert.equal(child.attrs?.reason, "database_error");
  assert.equal(child.attrs?.sqlstate, "23505");
  assert.equal(
    child.attrs?.error_message,
    "duplicate key value violates unique constraint \"messages_pkey\"",
  );
  assert.equal(JSON.stringify(child.attrs).includes("sensitive parameter"), false);
});

test("query failure diagnostics mark statement timeout retryable and carry the scrubbed primary message", () => {
  const error = Object.assign(
    new Error("canceling statement due to statement timeout DETAIL: user query secret@example.test"),
    { code: "57014" },
  );

  const diagnostics = queryFailureDiagnostics(error, 6_000);
  assert.deepEqual(diagnostics, {
    sqlstate: "57014",
    retryable: "true",
    error_message: "canceling statement due to statement timeout",
    timeout_bucket: "5-15s",
  });
  const serialized = JSON.stringify(diagnostics);
  assert.doesNotMatch(serialized, /secret@example|DETAIL|user query/);
});

test("query failure diagnostics stay conservative for hostile errors", () => {
  const error = Object.assign(new Error("private"), {
    name: "secret-user-class",
    code: "secret-user-code",
  });
  const diagnostics = queryFailureDiagnostics(error, 42);
  assert.equal("sqlstate" in diagnostics, false);
  assert.equal(diagnostics.retryable, "false");
  assert.equal(diagnostics.timeout_bucket, "<1s");
  assert.doesNotMatch(JSON.stringify(diagnostics), /secret-user/);
});

test("query failure diagnostics mark connection-class sqlstates retryable", () => {
  for (const code of ["08006", "57P01", "57P02", "57P03"]) {
    const diagnostics = queryFailureDiagnostics(Object.assign(new Error("boom"), { code }), 1_200);
    assert.deepEqual(diagnostics, {
      sqlstate: code,
      retryable: "true",
      error_message: "boom",
      timeout_bucket: "1-5s",
    });
  }
  const aborted = queryFailureDiagnostics(Object.assign(new Error("aborted"), { name: "AbortError" }), 20_000);
  assert.equal(aborted.retryable, "false");
  assert.equal(aborted.timeout_bucket, ">15s");
});

test("traceQuerySpan emits db_system and timeout_bucket on success", async () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  const root = tracer.startSpan("server.http.request", { surface: "server", kind: "server" });

  const result = await runWithTraceSpan(root, () => traceQuerySpan({
    queryName: "messages.search",
    phase: "visibility_candidates_enrich",
    dbSystem: "postgresql",
  }, async () => "ok"), tracer);
  root.end();

  assert.equal(result, "ok");
  const child = sink.getAllSpans().find((span) => span.name === "server.db.query");
  assert.ok(child);
  assert.equal(child.status, "ok");
  assert.equal(child.attrs?.db_system, "postgresql");
  assert.equal(child.attrs?.outcome, "success");
  assert.match(String(child.attrs?.timeout_bucket), /^(<1s|1-5s|5-15s|>15s)$/);
});

test("traceQuerySpan failure carries sqlstate, retryable, and timeout_bucket with no raw content", async () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  const root = tracer.startSpan("server.http.request", { surface: "server", kind: "server" });
  const error = Object.assign(
    new Error("canceling statement due to statement timeout DETAIL: secret@example.test"),
    { code: "57014" },
  );

  await assert.rejects(
    runWithTraceSpan(root, () => traceQuerySpan({
      queryName: "channels.inbox",
      phase: "inbox_read",
      dbSystem: "postgresql",
    }, async () => { throw error; }), tracer),
    error,
  );
  root.end("error");

  const child = sink.getAllSpans().find((span) => span.name === "server.db.query");
  assert.ok(child);
  assert.equal(child.status, "error");
  assert.equal(child.attrs?.db_system, "postgresql");
  assert.equal(child.attrs?.sqlstate, "57014");
  assert.equal(child.attrs?.retryable, "true");
  assert.match(String(child.attrs?.timeout_bucket), /^(<1s|1-5s|5-15s|>15s)$/);
  assert.equal(JSON.stringify(child.attrs).includes("secret@example"), false);
});

class FakeDriverError extends Error {
  code: string;
  constructor(code: string) {
    super("relation does not exist");
    this.name = "PostgresError";
    this.code = code;
  }
}

test("a driver error wrapped deeper than one cause is still classified as a database error", () => {
  const driver = new FakeDriverError("23505");
  const onceWrapped = new Error("insert failed", { cause: driver });
  const twiceWrapped = new Error("persist failed", { cause: onceWrapped });
  const thriceWrapped = new Error("send failed", { cause: twiceWrapped });

  // One level was already handled before this change; the deeper ones are the
  // regression -- they used to read as `unknown`, which is the same signature
  // an application error produces.
  assert.equal(queryFailureReason(onceWrapped), "database_error");
  assert.equal(queryFailureReason(twiceWrapped), "database_error");
  assert.equal(queryFailureReason(thriceWrapped), "database_error");
  assert.equal(boundedErrorClass(thriceWrapped), "DatabaseError");
  assert.equal(queryFailureTraceAttrs(thriceWrapped).sqlstate, "23505");
});

test("a statement timeout keeps its reason through deep wrapping", () => {
  const wrapped = new Error("a", { cause: new Error("b", { cause: new FakeDriverError("57014") }) });
  assert.equal(queryFailureReason(wrapped), "statement_timeout");
});

test("an application error stays unknown but is now distinguishable by type", () => {
  class ValidationError extends Error {}
  const appError = new ValidationError("channel is archived");

  // Control: the reason is deliberately unchanged. If this flipped, the walk
  // would be inventing database errors out of application failures.
  assert.equal(queryFailureReason(appError), "unknown");
  assert.equal(boundedErrorClass(appError), "Error");

  const attrs = queryFailureTraceAttrs(appError);
  assert.equal(attrs.reason, "unknown");
  assert.equal(attrs.error_type, "ValidationError");
  // The real message must never be recorded, only the canned excerpt.
  assert.equal(attrs.error_message, "Database operation failed with an unclassified cause");
  assert.ok(!JSON.stringify(attrs).includes("channel is archived"));
});

test("the type name is bounded and never carries a value", () => {
  assert.equal(boundedErrorTypeName(new Error("x")), "Error");
  assert.equal(boundedErrorTypeName(null), undefined);
  assert.equal(boundedErrorTypeName("a string"), undefined);
  const odd = { constructor: { name: "has spaces and (parens)" } };
  assert.equal(boundedErrorTypeName(odd), undefined);
});

test("a cyclic cause chain terminates instead of hanging", () => {
  const a = new Error("a") as Error & { cause?: unknown };
  const b = new Error("b") as Error & { cause?: unknown };
  a.cause = b;
  b.cause = a;
  assert.equal(queryFailureReason(a), "unknown");
});

// Shape taken from the installed drizzle-orm 0.45.2 `DrizzleQueryError`:
// it carries `query`/`params`, sets `cause` to the driver error, and has no
// `code` of its own -- which is why these read as `error_class=Error`.
class DrizzleQueryError extends Error {
  query: string;
  params: unknown[];
  constructor(cause: unknown) {
    super("Failed query: insert into inbox_notification_facts ...");
    // Faithful to drizzle-orm 0.45.2: it does NOT assign `this.name`, so the
    // inherited `.name` stays "Error" and only `constructor.name` identifies
    // the wrapper. That is precisely why `error_type` reads the constructor.
    this.query = "insert into inbox_notification_facts ...";
    this.params = [];
    this.cause = cause;
  }
}

test("a statement timeout wrapped by DrizzleQueryError and one more layer is classified", () => {
  // Observed production signature (task #380): query_canceled inside
  // DrizzleQueryError, itself wrapped again by the caller, reading as
  // `reason=unknown / error_class=Error`.
  const pgTimeout = new FakeDriverError("57014");
  const drizzle = new DrizzleQueryError(pgTimeout);
  const rewrapped = new Error("message persist failed", { cause: drizzle });

  assert.equal(queryFailureReason(rewrapped), "statement_timeout");
  assert.equal(queryFailureTraceAttrs(rewrapped).sqlstate, "57014");
  assert.equal(boundedErrorTypeName(rewrapped), "Error");
  // `.name` on a real DrizzleQueryError is the inherited "Error"; the
  // constructor is what names the wrapper.
  assert.equal(drizzle.name, "Error");
  assert.equal(boundedErrorTypeName(drizzle), "DrizzleQueryError");
});

test("the scrubbed message comes from the innermost layer, not the query restatement", () => {
  // A DrizzleQueryError's own message is a restatement of the statement
  // ("Failed query: insert into ..."). The SQL-start cut reduces that to
  // "Failed query:", which says LESS than a canned string would. The reason
  // lives in the driver error one layer down, so the chain must be walked.
  // Without this, a wrapped failure records "Failed" and the field cannot
  // answer why -- the exact defect #8032 set out to remove.
  const driver = new FakeDriverError("42P01");
  assert.equal(traceErrorMessage(driver), "relation does not exist");

  const wrapped = new DrizzleQueryError(driver);
  assert.equal(
    traceErrorMessage(wrapped),
    "relation does not exist",
    "the driver's own message must win over the wrapper's query restatement",
  );

  const rewrapped = new Error("message persist failed", { cause: wrapped });
  assert.equal(
    traceErrorMessage(rewrapped),
    "relation does not exist",
    "the innermost layer still wins through multiple wrappers",
  );

  // An unwrapped error still reports its own scrubbed message.
  assert.equal(traceErrorMessage(new Error("channel is archived")), "channel is archived");
});

test("an outer transport code does not shadow the SQLSTATE beneath it", () => {
  // A proxy/transport layer can carry its own `code`. Returning that first
  // would classify a statement timeout as a generic database error and drop
  // the SQLSTATE entirely.
  const pgTimeout = new FakeDriverError("57014");
  const transport = new Error("socket hang up", { cause: new DrizzleQueryError(pgTimeout) }) as Error & { code?: string };
  transport.code = "ETIMEDOUT";

  assert.equal(queryFailureReason(transport), "statement_timeout");
  assert.equal(queryFailureTraceAttrs(transport).sqlstate, "57014");
});

test("a transport code is still reported when there is no SQLSTATE below it", () => {
  // Control for the preference above: it must not discard a real code when
  // that code is the only one present.
  const transport = new Error("socket hang up") as Error & { code?: string };
  transport.code = "ECONNRESET";
  assert.equal(queryFailureReason(transport), "database_error");
  assert.equal(queryFailureTraceAttrs(transport).sqlstate, undefined);
});

test("a real driver error from real Drizzle, re-wrapped once, is still classified", async () => {
  // The fixtures above are built by hand from reading drizzle-orm's source.
  // This one uses the real thing: PGlite is real Postgres, and Drizzle wraps its
  // error exactly as production does. PGlite does not honour
  // `statement_timeout`, so 57014 cannot be produced here -- a real SQLSTATE
  // from division by zero stands in for it.
  const client = new PGlite();
  try {
    let thrown: unknown;
    try {
      await drizzle(client).execute(sql`select 1/0`);
    } catch (error) {
      thrown = error;
    }
    // Preconditions: bind the test to the shape it claims to cover. If a
    // Drizzle upgrade moved the code to the top level, these fail loudly
    // instead of the test silently passing for the wrong reason.
    assert.ok(thrown instanceof Error);
    assert.equal((thrown as { code?: unknown }).code, undefined);
    assert.equal(boundedErrorTypeName(thrown), "DrizzleQueryError");

    // Production's `unknown` bucket needed one more layer above Drizzle; this is
    // the case the deeper cause walk exists for.
    const rewrapped = new Error("message persist failed", { cause: thrown });
    assert.equal(queryFailureReason(rewrapped), "database_error");
    assert.equal(queryFailureTraceAttrs(rewrapped).sqlstate, "22012");
    assert.equal(boundedErrorClass(rewrapped), "DatabaseError");
  } finally {
    await client.close();
  }
});


test("traceErrorMessage redacts connection strings in every form", () => {
  // Mirrors the route-side rule; the two are consolidated by the shared
  // enforcer, and until then each must stand alone. A keyword-form DSN carries
  // no scheme, so the URL rule alone cannot see it.
  const spilled = [
    "postgres://raft:synthetic-pw@db.internal:5432/app",
    "connection failed: host=db.internal password=synthetic-pw",
  ];
  for (const message of spilled) {
    const clean = traceErrorMessage(new Error(message));
    assert.ok(!String(clean).includes("synthetic-pw"), `password survived: ${clean}`);
  }
  const spaced = traceErrorMessage(new Error('failed host=db password="synthetic two"'));
  assert.ok(!String(spaced).includes("synthetic"), `spaced value survived: ${spaced}`);
  assert.ok(!String(spaced).includes("two"), `spaced remainder survived: ${spaced}`);
  assert.ok(String(spaced).includes("password="), `key was dropped: ${spaced}`);

  assert.equal(traceErrorMessage(new Error("connection refused")), "connection refused");
});

// #proj-o11y:#29: a route failure names the database cause by code and
// constraint, never by its text (which carries the offending value).
test("errorDiagnosisAttrs gives the SQLSTATE and constraint of a wrapped driver error, never its text", () => {
  const driver = Object.assign(new Error('duplicate key value violates unique constraint "users_email_key" DETAIL: Key (email)=(secret@example.test) already exists.'),
    { code: "23505", constraint: "users_email_key" });
  const wrapped = Object.assign(new Error("Failed query: insert into users ..."), { cause: driver });
  const attrs = errorDiagnosisAttrs(wrapped);
  assert.equal(attrs.sqlstate, "23505");
  assert.equal(attrs.db_constraint, "users_email_key");
  assert.equal(attrs.error_type, "Error");
  assert.ok(!JSON.stringify(attrs).includes("secret@example.test"));
  // A transport code is not a SQLSTATE, and a constraint that is not an identifier is dropped.
  assert.deepEqual(errorDiagnosisAttrs(Object.assign(new Error("x"), { code: "ECONNRESET", constraint: "a b" })), { error_type: "Error" });
  assert.deepEqual(errorDiagnosisAttrs("not an error"), {});
});

test("traceRouteFailure records the SQLSTATE and constraint next to the collapsed message", () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  const driver = Object.assign(new Error("Key (email)=(secret@example.test) already exists."), { code: "23505", constraint: "users_email_key" });
  const root = tracer.startSpan("server.http.request", { surface: "server", kind: "server" });
  runWithTraceSpan(root, () => {
    traceRouteFailure("test.failed", Object.assign(new Error("Failed query: insert"), { cause: driver }), { route_action: "test" });
  }, tracer);
  root.end();
  const event = sink.getAllSpans().flatMap((span) => span.events).find((e) => e.name === "test.failed");
  assert.equal(event?.attrs?.sqlstate, "23505");
  assert.equal(event?.attrs?.db_constraint, "users_email_key");
  assert.equal(event?.attrs?.error_message, "Database query failed");
  assert.ok(!JSON.stringify(sink.getAllSpans()).includes("secret@example.test"));
});
