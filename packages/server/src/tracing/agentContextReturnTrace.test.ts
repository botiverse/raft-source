import assert from "node:assert/strict";
import type { Tracer } from "@botiverse/raft-shared";

import { AGENT_CONTEXT_RETURNED_EVENT, agentRequestContextFromHeaders, recordAgentContextReturned } from "./agentContextReturnTrace";
import { launchIdHashAttrs, traceAgentIdHash, traceIdentityHash } from "./traceIdentity";

function capture(): { tracer: Tracer; events: Array<{ name: string; attrs: Record<string, unknown> }> } {
  const events: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  const tracer = {
    emitEvent: (name: string, options: { attrs?: Record<string, unknown> }) => { events.push({ name, attrs: options.attrs ?? {} }); },
  } as unknown as Tracer;
  return { tracer, events };
}

const originalJwtSecret = process.env.JWT_SECRET;
beforeEach(() => { process.env.JWT_SECRET = "trace-identity-test-secret"; });
afterEach(() => {
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalJwtSecret;
});

test("a return is one event: source, seq range and count, launch and context, hashed agent and conversation, no ids or content", () => {
  const { tracer, events } = capture();
  recordAgentContextReturned({
    source: "history",
    agentId: "11111111-1111-4111-8111-111111111111",
    channelId: "22222222-2222-4222-8222-222222222222",
    launchId: "33333333-3333-4333-8333-333333333333",
    contextId: "44444444-4444-4444-8444-444444444444",
    seqs: [105, 101, 103],
  }, tracer);
  assert.equal(events.length, 1);
  const { name, attrs } = events[0]!;
  assert.equal(name, AGENT_CONTEXT_RETURNED_EVENT);
  assert.equal(attrs.source, "history");
  assert.equal(attrs.seq_min, 101);
  assert.equal(attrs.seq_max, 105);
  assert.equal(attrs.seq_count, 3);
  assert.equal(attrs.launch_id, "33333333-3333-4333-8333-333333333333");
  assert.equal(attrs.launch_id_present, true);
  assert.equal(attrs.context_id, "44444444-4444-4444-8444-444444444444");
  assert.equal(attrs.context_id_present, true);
  assert.match(String(attrs.agent_id_hash), /^[0-9a-f]{16}$/);
  assert.match(String(attrs.conversation_id_hash), /^[0-9a-f]{16}$/);
  const serialized = JSON.stringify(attrs);
  assert.doesNotMatch(serialized, /11111111-1111|22222222-2222/, "no raw agent or conversation id");
});

test("nothing returned, nothing recorded; a missing launch or context is marked, not invented", () => {
  const { tracer, events } = capture();
  recordAgentContextReturned({ source: "hold", agentId: "a", channelId: "c", seqs: [] }, tracer);
  assert.equal(events.length, 0);
  recordAgentContextReturned({ source: "delivery", agentId: "a", channelId: "c", seqs: [7] }, tracer);
  assert.equal(events[0]!.attrs.launch_id_present, false);
  assert.equal("launch_id" in events[0]!.attrs, false);
  assert.equal(events[0]!.attrs.context_id_present, false);
  assert.equal("context_id" in events[0]!.attrs, false);
  assert.equal("launch_id_hash" in events[0]!.attrs, false);
  assert.equal("context_id_hash" in events[0]!.attrs, false);
});

test("the launch and context headers are taken only when well formed", () => {
  const id = "33333333-3333-4333-8333-333333333333";
  assert.deepEqual(agentRequestContextFromHeaders({ "x-agent-launch-id": id, "x-agent-context-id": id }), { launchId: id, contextId: id });
  for (const bad of ["x", "not a launch id; drop table", ["a", "b"], undefined]) {
    assert.deepEqual(agentRequestContextFromHeaders({ "x-agent-launch-id": bad, "x-agent-context-id": bad }), { launchId: null, contextId: null });
  }
  assert.deepEqual(agentRequestContextFromHeaders({}), { launchId: null, contextId: null }, "an old daemon sends neither");
});

test("launch and context carry keyed hashes: 16 hex, stable, not the agent hash of the same id", () => {
  const { tracer, events } = capture();
  const launchId = "33333333-3333-4333-8333-333333333333";
  const contextId = "44444444-4444-4444-8444-444444444444";
  const input = { source: "history" as const, agentId: "a", channelId: "c", launchId, contextId, seqs: [1] };
  recordAgentContextReturned(input, tracer);
  recordAgentContextReturned(input, tracer);
  const [first, second] = events.map((event) => event.attrs);
  assert.match(String(first!.launch_id_hash), /^[0-9a-f]{16}$/);
  assert.match(String(first!.context_id_hash), /^[0-9a-f]{16}$/);
  assert.equal(second!.launch_id_hash, first!.launch_id_hash, "stable across events, so they join on one launch");
  assert.equal(second!.context_id_hash, first!.context_id_hash);
  assert.equal(first!.launch_id_hash, traceIdentityHash("launch_id_hash", launchId));
  assert.deepEqual(launchIdHashAttrs(launchId), { launch_id_hash: first!.launch_id_hash }, "the wake events' helper gives the same hash");
  assert.notEqual(first!.launch_id_hash, traceAgentIdHash(launchId), "its own key, not the agent key");
  assert.notEqual(traceIdentityHash("context_id_hash", launchId), first!.launch_id_hash, "launch and context keys differ");
  assert.equal(first!.launch_id_present, true);
  assert.equal(first!.context_id_present, true);
});

test("without a trace identity key the launch and context hashes are absent, not invented", () => {
  delete process.env.JWT_SECRET;
  const { tracer, events } = capture();
  recordAgentContextReturned({ source: "history", agentId: "a", channelId: "c", launchId: "launch-1", contextId: "context-1", seqs: [1] }, tracer);
  assert.equal("launch_id_hash" in events[0]!.attrs, false);
  assert.equal("context_id_hash" in events[0]!.attrs, false);
  assert.deepEqual(launchIdHashAttrs("launch-1"), {});
});
