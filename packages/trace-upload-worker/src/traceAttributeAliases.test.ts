import assert from "node:assert/strict";
import test from "node:test";
import { dedupeTraceAttributeAliases } from "./traceAttributeAliases.js";

test("dedupeTraceAttributeAliases removes equal legacy aliases without mutating the input", () => {
  const attrs = {
    agentId: "agent-1",
    agent_id: "agent-1",
    outcome: "working",
  };

  const deduped = dedupeTraceAttributeAliases(attrs);

  assert.deepEqual(deduped, {
    agent_id: "agent-1",
    outcome: "working",
  });
  assert.equal(attrs.agentId, "agent-1");
});

test("dedupeTraceAttributeAliases preserves a lone legacy spelling", () => {
  const attrs = { agentId: "agent-1" };
  assert.equal(dedupeTraceAttributeAliases(attrs), attrs);
  assert.deepEqual(dedupeTraceAttributeAliases(attrs), attrs);
});

test("dedupeTraceAttributeAliases preserves conflicting spellings", () => {
  const attrs = {
    agentId: "legacy-agent",
    agent_id: "canonical-agent",
  };

  assert.equal(dedupeTraceAttributeAliases(attrs), attrs);
  assert.deepEqual(dedupeTraceAttributeAliases(attrs), attrs);
});
