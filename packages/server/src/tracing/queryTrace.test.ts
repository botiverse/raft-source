import assert from "node:assert/strict";
import { test } from "vitest";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { queryFailureDiagnostics, queryFailureTraceAttrs, traceQuerySpan } from "./queryTrace.js";
import { runWithTraceSpan } from "./semanticTrace.js";

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
  const error = Object.assign(new Error("sensitive parameter"), { code: "23505" });

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
  assert.equal(JSON.stringify(child.attrs).includes("sensitive parameter"), false);
});

test("query failure diagnostics mark statement timeout retryable without raw content", () => {
  const error = Object.assign(
    new Error("canceling statement due to statement timeout DETAIL: user query secret@example.test"),
    { code: "57014" },
  );

  const diagnostics = queryFailureDiagnostics(error, 6_000);
  assert.deepEqual(diagnostics, {
    sqlstate: "57014",
    retryable: "true",
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
