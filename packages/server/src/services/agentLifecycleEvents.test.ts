import assert from "node:assert/strict";
import { test } from "vitest";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { runWithTraceSpan } from "../tracing/semanticTrace.js";
import {
  AGENT_LIFECYCLE_EVENT_TRACE_NAME,
  AGENT_LIFECYCLE_PROJECTION_TRACE_NAME,
  createAgentLifecycleEvent,
  createAgentLifecycleProjectionTraceRows,
  emitAgentLifecycleEventTrace,
  emitAgentLifecycleProjectionTraces,
  sanitizeLifecycleTraceAttrs,
  toAgentLifecycleEventTraceAttrs,
  toAgentLifecycleProjectionTraceAttrs,
} from "./agentLifecycleEvents.js";

test("agent lifecycle event identity is canonical and independent from trace identity", () => {
  const event = createAgentLifecycleEvent(
    {
      serverId: "server-1",
      agentId: "agent-1",
      machineId: "machine-1",
      launchId: "launch-1",
      eventType: "runtime_interrupted",
      actor: "daemon",
      source: "daemon",
      reason: "daemon_upgrade",
      correlationId: "daemon-window-1",
      occurredAt: "2026-05-12T06:01:08.000Z",
    },
    { createId: () => "event-1" },
  );

  assert.equal(event.lifecycleEventId, "event-1");
  assert.equal(event.correlationId, "daemon-window-1");
  assert.equal(
    event.idempotencyKey,
    "agent_lifecycle:server-1:agent-1:runtime_interrupted:daemon_upgrade:machine-1:launch-1:daemon-window-1",
  );
  assert.equal(
    event.producerFactId,
    "agent_lifecycle_fact:agent_lifecycle:server-1:agent-1:runtime_interrupted:daemon_upgrade:machine-1:launch-1:daemon-window-1",
  );

  const attrs = toAgentLifecycleEventTraceAttrs(event);
  assert.equal(attrs.lifecycle_event_id, "event-1");
  assert.equal(attrs.correlation_id, "daemon-window-1");
  assert.equal(attrs.producer_fact_id, event.producerFactId);
  assert.equal(attrs.trace_id, undefined);
  assert.equal(attrs.span_id, undefined);
});

test("daemon process generations do not change canonical lifecycle identity", () => {
  const canonicalInput = {
    serverId: "server-1",
    agentId: "agent-1",
    machineId: "machine-1",
    launchId: "launch-1",
    eventType: "runtime_interrupted" as const,
    actor: "daemon" as const,
    source: "daemon" as const,
    reason: "daemon_restart" as const,
    correlationId: "restart-window-1",
    occurredAt: "2026-07-11T15:00:00.000Z",
  };

  const beforeRestart = createAgentLifecycleEvent(
    { ...canonicalInput, attrs: { daemon_instance_id: "daemon-generation-1" } },
    { createId: () => "event-before-restart" },
  );
  const afterRestartReplay = createAgentLifecycleEvent(
    { ...canonicalInput, attrs: { daemon_instance_id: "daemon-generation-2" } },
    { createId: () => "event-after-restart" },
  );

  assert.equal(afterRestartReplay.idempotencyKey, beforeRestart.idempotencyKey);
  assert.equal(afterRestartReplay.producerFactId, beforeRestart.producerFactId);
  assert.equal(
    afterRestartReplay.producerFactId,
    "agent_lifecycle_fact:agent_lifecycle:server-1:agent-1:runtime_interrupted:daemon_restart:machine-1:launch-1:restart-window-1",
  );
});

test("projection rows include wake eligibility and semantic dedupe as first-class trace attrs", () => {
  const event = createAgentLifecycleEvent(
    {
      serverId: "server-1",
      agentId: "agent-1",
      eventType: "manual_stop_requested",
      actor: "human",
      source: "web",
      reason: "manual_stop",
      correlationId: "manual-stop-1",
      occurredAt: "2026-05-12T08:00:00.000Z",
    },
    { createId: () => "event-manual-stop-1" },
  );

  const rows = createAgentLifecycleProjectionTraceRows(event, [
    {
      projectionKind: "db_status",
      outcome: "applied",
      attrs: { intent_state: "manual_stopped" },
    },
    {
      projectionKind: "wake_eligibility",
      outcome: "applied",
      dedupeKey: "agent:stopCommand:stop-request-1",
      attrs: { wake_eligibility: false, wake_block_reason: "manual_stopped" },
    },
    {
      projectionKind: "activity_log",
      outcome: "deduped",
      dedupeKey: "agent:stopCommand:stop-request-1",
      skippedReason: "duplicate",
      attrs: { label_kind: "stopped" },
    },
  ]);

  assert.deepEqual(rows.map((row) => row.projectionKind), [
    "db_status",
    "wake_eligibility",
    "activity_log",
  ]);
  const wakeEligibility = rows.find((row) => row.projectionKind === "wake_eligibility");
  const activityLog = rows.find((row) => row.projectionKind === "activity_log");
  assert.equal(wakeEligibility?.dedupeKey, "agent:stopCommand:stop-request-1");
  assert.equal(wakeEligibility?.attrs?.wake_eligibility, false);
  assert.equal(activityLog?.outcome, "deduped");
  assert.equal(activityLog?.skippedReason, "duplicate");
  assert.equal(rows.every((row) => row.lifecycleEventId === event.lifecycleEventId), true);
  assert.equal(rows.every((row) => row.correlationId === event.correlationId), true);
  assert.equal(rows.every((row) => row.idempotencyKey === event.idempotencyKey), true);
  assert.equal(rows.every((row) => row.producerFactId === event.producerFactId), true);
  assert.equal(toAgentLifecycleEventTraceAttrs(event).dedupe_key, undefined);
});

test("trace attrs drop raw text and secret fields while preserving low-cardinality fields", () => {
  assert.deepEqual(
    sanitizeLifecycleTraceAttrs({
      activity_status: "working",
      correlation_id: "wrong-correlation",
      projection_kind: "wrong-projection",
      agent_id: "wrong-agent",
      reason_bucket: "runtime",
      content: "raw user text",
      stderr: "stack",
      auth_token: "secret",
      count: 2,
      wake_eligible: true,
    }),
    {
      activity_status: "working",
      reason_bucket: "runtime",
      count: 2,
      wake_eligible: true,
    },
  );
});

test("custom attrs cannot override canonical trace identity fields", () => {
  const event = createAgentLifecycleEvent(
    {
      serverId: "server-1",
      agentId: "agent-1",
      eventType: "runtime_interrupted",
      actor: "daemon",
      source: "daemon",
      reason: "daemon_upgrade",
      correlationId: "canonical-correlation",
      idempotencyKey: "canonical-idempotency",
      occurredAt: "2026-05-12T06:01:08.000Z",
      attrs: {
        correlation_id: "custom-correlation",
        lifecycle_event_id: "custom-event",
        producer_fact_id: "custom-fact",
        agent_id: "custom-agent",
        event_type: "custom-event-type",
        safe_bucket: "custom",
      },
    },
    { createId: () => "canonical-event" },
  );
  const eventAttrs = toAgentLifecycleEventTraceAttrs(event);

  assert.equal(eventAttrs.lifecycle_event_id, "canonical-event");
  assert.equal(eventAttrs.correlation_id, "canonical-correlation");
  assert.equal(eventAttrs.idempotency_key, "canonical-idempotency");
  assert.equal(eventAttrs.producer_fact_id, "agent_lifecycle_fact:canonical-idempotency");
  assert.equal(eventAttrs.agent_id, "agent-1");
  assert.equal(eventAttrs.event_type, "runtime_interrupted");
  assert.equal(eventAttrs.safe_bucket, "custom");

  const [projection] = createAgentLifecycleProjectionTraceRows(event, [{
      projectionKind: "activity_log",
      outcome: "deduped",
      dedupeKey: "canonical-dedupe",
      skippedReason: "duplicate",
      attrs: {
        producer_fact_id: "custom-fact",
        projection_kind: "custom-projection",
        outcome: "custom-outcome",
      dedupe_key: "custom-dedupe",
      projection_skipped_reason: "custom-skip",
      safe_projection_bucket: "custom",
    },
  }]);
  assert.ok(projection);
  const projectionAttrs = toAgentLifecycleProjectionTraceAttrs(projection);

  assert.equal(projectionAttrs.projection_kind, "activity_log");
  assert.equal(projectionAttrs.outcome, "deduped");
  assert.equal(projectionAttrs.dedupe_key, "canonical-dedupe");
  assert.equal(projectionAttrs.producer_fact_id, "agent_lifecycle_fact:canonical-idempotency");
  assert.equal(projectionAttrs.projection_skipped_reason, "duplicate");
  assert.equal(projectionAttrs.safe_projection_bucket, "custom");
});

test("lifecycle traces emit event and projection rows onto the active span", () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "a".repeat(32),
    spanIdGenerator: (() => {
      let next = 1;
      return () => String(next++).padStart(16, "0");
    })(),
  });
  const span = tracer.startSpan("server.machine.ready.reconcile", {
    surface: "server",
    kind: "internal",
  });

  const event = createAgentLifecycleEvent(
    {
      serverId: "server-1",
      agentId: "agent-1",
      machineId: "machine-1",
      eventType: "runtime_interrupted",
      actor: "daemon",
      source: "ready_reconcile",
      reason: "daemon_restart",
      correlationId: "daemon-window-1",
      occurredAt: "2026-05-12T06:01:17.000Z",
    },
    { createId: () => "event-ready-reconcile-1" },
  );
  const rows = createAgentLifecycleProjectionTraceRows(event, [
    {
      projectionKind: "db_status",
      outcome: "skipped",
      skippedReason: "not_authoritative_in_phase_1",
      attrs: { runtime_state: "interrupted" },
    },
    {
      projectionKind: "wake_eligibility",
      outcome: "applied",
      attrs: { wake_eligibility: true, source_version: "phase1-test" },
    },
    {
      projectionKind: "live_activity",
      outcome: "applied",
      attrs: { activity_status: "offline", detail_kind: "daemon_restart" },
    },
    {
      projectionKind: "activity_log",
      outcome: "deduped",
      dedupeKey: "agent:machine:restartWindow:window-1",
      skippedReason: "duplicate",
      attrs: { label_kind: "daemon_restart" },
    },
  ]);

  runWithTraceSpan(span, () => {
    emitAgentLifecycleEventTrace(event);
    emitAgentLifecycleProjectionTraces(rows);
  });
  span.end();

  const [recorded] = sink.getAllSpans();
  assert.ok(recorded);
  assert.deepEqual(recorded.events.map((traceEvent) => traceEvent.name), [
    AGENT_LIFECYCLE_EVENT_TRACE_NAME,
    AGENT_LIFECYCLE_PROJECTION_TRACE_NAME,
    AGENT_LIFECYCLE_PROJECTION_TRACE_NAME,
    AGENT_LIFECYCLE_PROJECTION_TRACE_NAME,
    AGENT_LIFECYCLE_PROJECTION_TRACE_NAME,
  ]);
  const projectionKinds = recorded.events
    .filter((traceEvent) => traceEvent.name === AGENT_LIFECYCLE_PROJECTION_TRACE_NAME)
    .map((traceEvent) => traceEvent.attrs?.projection_kind);
  assert.deepEqual(projectionKinds, ["db_status", "wake_eligibility", "live_activity", "activity_log"]);
  assert.equal(recorded.events[0]?.attrs?.lifecycle_event_id, "event-ready-reconcile-1");
  assert.equal(
    recorded.events[0]?.attrs?.producer_fact_id,
    "agent_lifecycle_fact:agent_lifecycle:server-1:agent-1:runtime_interrupted:daemon_restart:machine-1:no_launch:daemon-window-1",
  );
  assert.equal(recorded.events[1]?.attrs?.producer_fact_id, recorded.events[0]?.attrs?.producer_fact_id);
  assert.equal(recorded.events[4]?.attrs?.dedupe_key, "agent:machine:restartWindow:window-1");
});
