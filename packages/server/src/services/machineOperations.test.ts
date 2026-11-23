import assert from "node:assert/strict";
import { test } from "vitest";
import { asServerId, BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { addTraceEvent, runWithTraceSpan } from "../tracing/semanticTrace";
import { readMachineOperation, resetMachineOperationsForTests, startMachineOperation } from "./machineOperations";

// Tenny on #14843: an operation is read only by the person who started it,
// on its original Server and through the surface that started it.
test("an operation is read by its person on its Server through its own surface only", async () => {
  resetMachineOperationsForTests();
  const serverId = asServerId("00000000-0000-4000-8000-00000000000a");
  const web = { userId: "u1", serverId, surface: "web" };
  const voice = { userId: "u1", serverId, surface: "voice:app-1" };
  const id = await startMachineOperation(voice, async () => ({ status: 200, body: { outcome: "answered" } }), { status: 500, body: {} });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(await readMachineOperation(voice, id), { state: "done", status: 200, body: { outcome: "answered" } });
  assert.deepEqual(await readMachineOperation({ ...voice, serverId: asServerId(serverId.toUpperCase()) }, id), { state: "done", status: 200, body: { outcome: "answered" } }, "UUID spelling does not change the Server");
  assert.equal(await readMachineOperation(web, id), null, "the same person on the web");
  assert.equal(await readMachineOperation({ ...voice, surface: "voice:app-2" }, id), null, "another App of the same person");
  assert.equal(await readMachineOperation({ ...voice, userId: "u2" }, id), null, "another person through the same App");
  assert.equal(await readMachineOperation({ ...voice, serverId: asServerId("00000000-0000-4000-8000-000000000002") }, id), null, "the same person and App through another Server");
});

// #oar-raft:b01e7534: a limit-reset read answered after the 202 left no
// server trace event, because the wait wrote it on the ended request span.
test("trace events the wait adds after the request span ended are kept on the wait's own span", async () => {
  resetMachineOperationsForTests();
  const sink = new MemoryTraceSink();
  let nextSpanId = 0;
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "f".repeat(32),
    spanIdGenerator: () => (++nextSpanId).toString(16).padStart(16, "0"),
  });
  const request = tracer.startSpan("server.http.request", { surface: "server", kind: "server" });
  let answerNow: () => void = () => {};
  const answered = new Promise<void>((resolve) => { answerNow = resolve; });
  const owner = { userId: "u1", serverId: asServerId("00000000-0000-4000-8000-00000000000a"), surface: "web" };
  const id = await runWithTraceSpan(request, () => startMachineOperation(owner, async () => {
    await answered;
    addTraceEvent("machine_operation.test.answered", { outcome: "read" });
    return { status: 200, body: {} };
  }, { status: 500, body: {} }), tracer);
  request.end("ok");
  answerNow();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(await readMachineOperation(owner, id), { state: "done", status: 200, body: {} });
  const wait = sink.getAllSpans().find((span) => span.name === "server.machine_operation.wait");
  assert.ok(wait, "the wait has its own span");
  assert.equal(wait.context.parentSpanId, request.context.spanId, "under the request that started it");
  assert.ok(wait.events.some((event) => event.name === "machine_operation.test.answered"), "the event the wait added is on it");
});
