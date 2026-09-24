import assert from "node:assert/strict";
import { test } from "vitest";
import {
  BasicTracer,
  MemoryTraceSink,
  traceEventRowsForSpan,
} from "@botiverse/raft-shared";

import { runWithTraceSpan } from "../tracing/semanticTrace.js";
import { recordEmailLoginRejectedTrace } from "./authLoginTrace.js";

const TRACE_RESOURCE = {
  serviceName: "slock-server",
  deploymentEnvironment: "test",
};

for (const reason of ["user_missing", "password_mismatch"] as const) {
  test(`email login rejection ${reason} is queryable by typed reason and request trace`, () => {
    const sink = new MemoryTraceSink();
    const tracer = new BasicTracer({
      sink,
      traceIdGenerator: () => "a".repeat(32),
      spanIdGenerator: () => "b".repeat(16),
    });
    const span = tracer.startSpan("server.http.request", {
      surface: "server",
      kind: "server",
    });

    let correlationId: string | undefined;
    runWithTraceSpan(span, () => {
      correlationId = recordEmailLoginRejectedTrace(reason);
    }, tracer);
    span.end();

    assert.equal(correlationId, "a".repeat(32));
    const [completed] = sink.getAllSpans();
    const [row] = traceEventRowsForSpan(completed, TRACE_RESOURCE);
    assert.equal(row.event_name, "auth.login.rejected");
    assert.equal(row.event_kind, "auth_login");
    assert.equal(row.outcome, "rejected");
    assert.equal(row.reason, reason);
    assert.equal(row.source, "email_login");
    assert.equal(row.trace_id, correlationId);
    assert.equal(row.session_id, null);
    assert.equal(row.request_id, null);
  });
}
