import assert from "node:assert/strict";
import { test } from "vitest";
import {
  noopTracer,
  TRACE_EVENT_ROW_V2_INGEST_STATEMENT,
  TRACE_EVENT_ROW_V2_LEGACY_INGEST_STATEMENT,
} from "@botiverse/raft-shared";
import { createServerTracerFromEnv } from "./serverTracer.js";

test("createServerTracerFromEnv defaults to noop when OTLP endpoint is unset", () => {
  const runtime = createServerTracerFromEnv({});

  assert.equal(runtime.tracer, noopTracer);
});

test("createServerTracerFromEnv creates a recording tracer when OTLP endpoint is set", async () => {
  const runtime = createServerTracerFromEnv({
    SLOCK_TRACE_OTLP_ENDPOINT: "http://collector:4318",
    SLOCK_TRACE_SERVICE_NAME: "slock-server-test",
    DEPLOYMENT_ENV: "test",
  });

  assert.notEqual(runtime.tracer, noopTracer);
  await runtime.shutdown();
});

test("createServerTracerFromEnv enables event rows independently from OTLP", async () => {
  const runtime = createServerTracerFromEnv({
    RAFT_TRACE_SCOPEDB_SINK: "on",
    SCOPEDB_TRACE_EVENTS_ENDPOINT: "https://scopedb.example",
    SCOPEDB_TRACE_EVENTS_WRITE_KEY: "test-token",
    SLOCK_TRACE_SERVICE_NAME: "slock-server-test",
    DEPLOYMENT_ENV: "test",
  });

  assert.notEqual(runtime.tracer, noopTracer);
  await runtime.shutdown();
});

test("createServerTracerFromEnv accepts the current code-owned statement", async () => {
  const runtime = createServerTracerFromEnv({
    RAFT_TRACE_SCOPEDB_SINK: "on",
    SCOPEDB_TRACE_EVENTS_ENDPOINT: "https://scopedb.example",
    SCOPEDB_TRACE_EVENTS_WRITE_KEY: "test-token",
    SCOPEDB_TRACE_EVENTS_INGEST_STATEMENT: TRACE_EVENT_ROW_V2_INGEST_STATEMENT,
  });

  assert.notEqual(runtime.tracer, noopTracer);
  await runtime.shutdown();
});

test("createServerTracerFromEnv keeps the sink on for the exact legacy statement during mixed rollout", async () => {
  const runtime = createServerTracerFromEnv({
    RAFT_TRACE_SCOPEDB_SINK: "on",
    SCOPEDB_TRACE_EVENTS_ENDPOINT: "https://scopedb.example",
    SCOPEDB_TRACE_EVENTS_WRITE_KEY: "test-token",
    SCOPEDB_TRACE_EVENTS_INGEST_STATEMENT: TRACE_EVENT_ROW_V2_LEGACY_INGEST_STATEMENT,
  });

  assert.notEqual(runtime.tracer, noopTracer);
  await runtime.shutdown();
});

test("createServerTracerFromEnv keeps configured event rows off without the explicit rollout flag", () => {
  const runtime = createServerTracerFromEnv({
    SCOPEDB_TRACE_EVENTS_ENDPOINT: "https://scopedb.example",
    SCOPEDB_TRACE_EVENTS_WRITE_KEY: "test-token",
  });

  assert.equal(runtime.tracer, noopTracer);
});

test("createServerTracerFromEnv fails closed for an invalid ScopeDB rollout flag", () => {
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    const runtime = createServerTracerFromEnv({
      RAFT_TRACE_SCOPEDB_SINK: "enabled",
      SCOPEDB_TRACE_EVENTS_ENDPOINT: "https://scopedb.example",
      SCOPEDB_TRACE_EVENTS_WRITE_KEY: "test-token",
    });

    assert.equal(runtime.tracer, noopTracer);
    assert.match(String(warnings[0]?.[0]), /must be 'on' or 'off'/);
  } finally {
    console.warn = originalWarn;
  }
});

test("createServerTracerFromEnv disables event rows for unsafe bare ingest statements", () => {
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    const runtime = createServerTracerFromEnv({
      RAFT_TRACE_SCOPEDB_SINK: "on",
      SCOPEDB_TRACE_EVENTS_ENDPOINT: "https://scopedb.example",
      SCOPEDB_TRACE_EVENTS_WRITE_KEY: "test-token",
      SCOPEDB_TRACE_EVENTS_INGEST_STATEMENT: "INSERT INTO raft.trace_events_v2",
    });

    assert.equal(runtime.tracer, noopTracer);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]?.[0]), /must match a code-owned compatible projection/);
  } finally {
    console.warn = originalWarn;
  }
});
