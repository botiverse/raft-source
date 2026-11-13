import assert from "node:assert/strict";

import {
  DAEMON_CAPABILITY_MODEL_LIMITS_REPORT_V1,
  modelLimitsHaveDefaultValues,
  parseModelLimits,
} from "./agentModelLimits";

test("the capability string is stable on the wire", () => {
  assert.equal(DAEMON_CAPABILITY_MODEL_LIMITS_REPORT_V1, "agent:model-limits-report-v1");
});

test("parseModelLimits keeps each field's own source and rejects malformed values", () => {
  const mixed = { contextWindow: { value: 64_000, source: "catalog" }, maxTokens: { value: 8192, source: "raft_default" } };
  assert.deepEqual(parseModelLimits(mixed), mixed);
  assert.equal(parseModelLimits(null), null);
  assert.equal(parseModelLimits({ contextWindow: mixed.contextWindow }), null, "both fields are required");
  assert.equal(parseModelLimits({ ...mixed, maxTokens: { value: 8192, source: "guess" } }), null, "unknown source");
  assert.equal(parseModelLimits({ ...mixed, maxTokens: { value: 0, source: "catalog" } }), null, "not positive");
  assert.equal(parseModelLimits({ ...mixed, maxTokens: { value: 1.5, source: "catalog" } }), null, "not an integer");
  assert.equal(parseModelLimits({ ...mixed, maxTokens: { value: "8192", source: "catalog" } }), null, "not a number");
  const fromGateway = { contextWindow: { value: 262_144, source: "gateway" }, maxTokens: { value: 64_000, source: "agent_config" } };
  assert.deepEqual(parseModelLimits(fromGateway), fromGateway, "gateway is a source (#proj-runtime:#53)");
});

test("any raft_default field means default values are in use; one field is enough", () => {
  const catalog = { value: 1, source: "catalog" } as const;
  const raftDefault = { value: 1, source: "raft_default" } as const;
  assert.equal(modelLimitsHaveDefaultValues({ contextWindow: catalog, maxTokens: catalog }), false);
  assert.equal(modelLimitsHaveDefaultValues({ contextWindow: catalog, maxTokens: raftDefault }), true);
  assert.equal(modelLimitsHaveDefaultValues({ contextWindow: raftDefault, maxTokens: catalog }), true);
  const gateway = { value: 1, source: "gateway" } as const;
  assert.equal(modelLimitsHaveDefaultValues({ contextWindow: gateway, maxTokens: gateway }), false, "a gateway value is never a default");
});
