import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";
import { BasicTracer, MemoryTraceSink, type TraceLogEvent } from "@botiverse/raft-shared";
import { traceAgentIdHash, traceMachineIdHash, traceServerIdHash } from "./traceIdentity";
import { __traceIdHashForTests, TraceIdHashTraceSink } from "./traceIdHashTraceSink";

const AGENT_ID = "0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b";
const MACHINE_ID = "1c2d3e4f-5061-4728-9bac-1d2e3f4a5b6c";
const SERVER_ID = "2d3e4f50-6172-4839-8cbd-2e3f4a5b6c7d";
const USER_ID = "3e4f5061-7283-494a-9dce-3f4a5b6c7d8e";

let savedSecret: string | undefined;
beforeEach(() => {
  savedSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "trace-id-hash-sink-test-secret";
  __traceIdHashForTests.reset();
});
afterEach(() => {
  if (savedSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = savedSecret;
  __traceIdHashForTests.reset();
});

function exportedSpan(attrs: Record<string, unknown>, eventAttrs?: Record<string, unknown>) {
  const memory = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink: new TraceIdHashTraceSink(memory) });
  const span = tracer.startSpan("server.agent.wake", { surface: "server", kind: "internal", attrs });
  if (eventAttrs) span.addEvent("machine.ready.pending_inbox_wake.planned", eventAttrs);
  span.end();
  return memory.getAllSpans()[0]!;
}

test("a raw agent, machine or server id gets the hash request spans carry; the raw id stays", () => {
  const out = exportedSpan({ agent_id: AGENT_ID, machine_id: MACHINE_ID, server_id: SERVER_ID, action: "attempt-wake" });
  assert.deepEqual(out.attrs, {
    agent_id: AGENT_ID,
    machine_id: MACHINE_ID,
    server_id: SERVER_ID,
    action: "attempt-wake",
    // The same functions requestObservability.ts and its callers use, so one hash joins both halves.
    agent_id_hash: traceAgentIdHash(AGENT_ID),
    machine_id_hash: traceMachineIdHash(MACHINE_ID),
    server_id_hash: traceServerIdHash(SERVER_ID),
  });
  assert.match(String(out.attrs?.agent_id_hash), /^[0-9a-f]{16}$/);
});

test("span events get the hash too", () => {
  const out = exportedSpan({ action: "x" }, { agent_id: AGENT_ID, seq: 3 });
  assert.deepEqual(out.attrs, { action: "x" }, "attrs without one of the ids are untouched");
  assert.deepEqual(out.events[0]!.attrs, { agent_id: AGENT_ID, seq: 3, agent_id_hash: traceAgentIdHash(AGENT_ID) });
});

test("a hash already on the span is not overwritten", () => {
  const out = exportedSpan({ agent_id: AGENT_ID, agent_id_hash: "feedfacefeedface" });
  assert.equal(out.attrs?.agent_id_hash, "feedfacefeedface");
});

test("only the three ids: a user id is neither hashed nor given any key here", () => {
  const out = exportedSpan({ user_id: USER_ID, channel_id: "c-1", message_id: "m-1", agent_id: "" });
  assert.deepEqual(out.attrs, { user_id: USER_ID, channel_id: "c-1", message_id: "m-1", agent_id: "" });
});

test("a non-string id (a presence boolean under the same key) is left alone", () => {
  const out = exportedSpan({ agent_id: true, machine_id: 7 });
  assert.deepEqual(out.attrs, { agent_id: true, machine_id: 7 });
});

test("without the key nothing is added, and it starts working once the key exists", () => {
  delete process.env.JWT_SECRET;
  assert.deepEqual(exportedSpan({ agent_id: AGENT_ID }).attrs, { agent_id: AGENT_ID });
  process.env.JWT_SECRET = "trace-id-hash-sink-test-secret";
  assert.equal(exportedSpan({ agent_id: AGENT_ID }).attrs?.agent_id_hash, traceAgentIdHash(AGENT_ID));
});

test("log events get the hash", () => {
  const logs: TraceLogEvent[] = [];
  const sink = new TraceIdHashTraceSink({ record: () => undefined, recordLogEvent: (event) => { logs.push(event); } });
  sink.recordLogEvent({ name: "server.machine.disk_sample", timeMs: 1, surface: "server", context: null, attrs: { machine_id: MACHINE_ID, used_pct: 71 } });
  assert.deepEqual(logs[0]!.attrs, { machine_id: MACHINE_ID, used_pct: 71, machine_id_hash: traceMachineIdHash(MACHINE_ID) });
});

test("a changed JWT_SECRET changes the exported hash at once (the cache follows the key)", () => {
  const before = exportedSpan({ agent_id: AGENT_ID }).attrs?.agent_id_hash;
  process.env.JWT_SECRET = "another-secret-for-rotation";
  const after = exportedSpan({ agent_id: AGENT_ID }).attrs?.agent_id_hash;
  assert.equal(after, traceAgentIdHash(AGENT_ID));
  assert.notEqual(after, before);
});
