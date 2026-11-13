import assert from "node:assert/strict";
import type { RawEvent } from "@botiverse/oar";
import { test } from "vitest";
import { BasicTracer, createSpanAttrContractTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { DAEMON_CORE_TRACE_ATTR_CONTRACTS } from "../core";
import { traceRows } from "../testing/traceRows";
import { CodexSessionTraces } from "./oarCodexTraces";

const mcpFrame = (name: string, status: string): RawEvent =>
  ({ kind: "frame", sessionId: "s", agentPath: [], seq: 1, receivedAt: 1, body: { type: "mcpServer/startupStatus/updated", native: { name, status }, events: [] } }) as unknown as RawEvent;

function setup(resumed = false, managedMcpServerName: string | null = "raft") {
  const seen: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  const traces = new CodexSessionTraces({ developerInstructions: "You are Otter", resumed, managedMcpServerName }, (name, attrs) => seen.push({ name, attrs }));
  return { traces, seen };
}

test("opening traces the tooling and the instruction shape, in lengths and hashes", () => {
  const { traces, seen } = setup(true);
  traces.opened();
  assert.deepEqual(seen.map((row) => row.name), ["daemon.runtime.tooling.exposure", "daemon.codex.request_instruction_shape"]);
  assert.equal(seen[0]!.attrs.session_request_method, "thread/resume");
  assert.equal(seen[0]!.attrs.managed_mcp_status, "pending");
  const shape = seen[1]!.attrs;
  assert.equal(shape.observation_phase, "thread_request_sent");
  assert.equal(shape.session_request_method, "thread/resume");
  assert.equal(shape.developer_instructions_match_standing, true);
  assert.ok(!JSON.stringify(seen).includes("You are Otter"));
});

test("the managed MCP server settling traces the tooling once; another server doesn't", () => {
  const { traces, seen } = setup();
  traces.observeRecord(mcpFrame("other", "ready"));
  traces.observeRecord(mcpFrame("raft", "starting"));
  assert.equal(seen.length, 0);
  traces.observeRecord(mcpFrame("raft", "failed"));
  traces.observeRecord(mcpFrame("raft", "ready"));
  assert.deepEqual(seen.map((row) => row.attrs.managed_mcp_status), ["failed"]);
  const none = setup(false, null);
  none.traces.opened();
  assert.equal(none.seen[0]!.attrs.managed_mcp_status, "not_configured");
  assert.equal(none.seen[0]!.attrs.managed_mcp_configured, false);
});

test("compaction: each end of it, and the first request after", () => {
  const { traces, seen } = setup();
  traces.observeEvent("turn_started");
  assert.equal(seen.length, 0);
  traces.observeEvent("compaction_started");
  traces.observeEvent("compaction_ended");
  traces.observeEvent("turn_started");
  traces.observeEvent("turn_started");
  assert.deepEqual(seen.map((row) => [row.attrs.observation_phase, row.attrs.compaction_starts_count, row.attrs.compaction_finishes_count]), [
    ["compaction_started", 1, 0],
    ["compaction_finished", 1, 1],
    ["post_compaction_first_request", 1, 1],
  ]);
});

test("through the real attribute contract, the shape event keeps who it's about", () => {
  const sink = new MemoryTraceSink();
  const tracer = createSpanAttrContractTracer(new BasicTracer({ sink }), DAEMON_CORE_TRACE_ATTR_CONTRACTS);
  const traces = new CodexSessionTraces({ developerInstructions: "x", resumed: false, managedMcpServerName: null }, (name, attrs) => {
    tracer.emitEvent(name, { surface: "daemon", attrs: { agent_id: "a1", launch_id: "l1", process_instance_id: "p1", host: "oar", ...attrs } });
  });
  traces.opened();
  const shape = traceRows(sink).find((row) => row.name === "daemon.codex.request_instruction_shape")!.attrs as Record<string, unknown>;
  assert.equal(shape.agent_id, "a1");
  assert.equal(shape.launch_id, "l1");
  assert.equal(shape.process_instance_id, "p1");
  assert.equal(shape.host, "oar");
  assert.equal(shape.observation_phase, "thread_request_sent");
});
