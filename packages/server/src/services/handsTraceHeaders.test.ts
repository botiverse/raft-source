import { strict as assert } from "node:assert";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { test } from "vitest";
import { runWithTraceSpan } from "../tracing/semanticTrace";
import { handsReporterRouteTemplate, handsTraceHeaders } from "./handsTraceHeaders";

test("X-Trace-Id carries the current W3C trace id inside a trace, and nothing outside one", () => {
  assert.deepEqual(handsTraceHeaders(), {});
  const tracer = new BasicTracer({ sink: new MemoryTraceSink() });
  const request = tracer.startSpan("server.http.request", { surface: "server", kind: "server" });
  const headers = runWithTraceSpan(request, () => handsTraceHeaders(), tracer);
  request.end("ok");
  assert.equal(headers["X-Trace-Id"], request.context.traceId);
  assert.match(headers["X-Trace-Id"]!, /^[0-9a-f]{32}$/);
});

test("the Hands route keeps the template and drops every id and the query", () => {
  const app = "850a1eca-2664-4e44-9020-51fbdf7a8a70";
  const ticket = "33333333-3333-4333-8333-333333333333";
  assert.equal(handsReporterRouteTemplate(`/api/apps/${app}/reporter-feedback?cursor=x&limit=20`), "/api/apps/:appId/reporter-feedback");
  assert.equal(handsReporterRouteTemplate(`/api/apps/${app}/reporter-feedback/${ticket}?unread=1`), "/api/apps/:appId/reporter-feedback/:ticketId");
  assert.equal(handsReporterRouteTemplate(`/api/apps/${app}/reporter-feedback/${ticket}/close`), "/api/apps/:appId/reporter-feedback/:ticketId/close");
  assert.equal(handsReporterRouteTemplate(`/api/apps/${app}/reporter-feedback/${ticket}/attachments/att-1`), "/api/apps/:appId/reporter-feedback/:ticketId/attachments/:attachmentId");
  assert.equal(handsReporterRouteTemplate(`/api/apps/${app}/reporter-feedback/route-subject`), "/api/apps/:appId/reporter-feedback/route-subject");
});
