import assert from "node:assert/strict";
import { test } from "vitest";
import { extractPiUsageAttrs, buildPiTokenUsageEvent } from "./piEventNormalizer.js";

const FULL_USAGE = {
  input: 100,
  output: 200,
  cacheRead: 30,
  cacheWrite: 40,
  cacheWrite1h: 5,
  reasoning: 12,
  totalTokens: 300,
  cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 },
};

test("extractPiUsageAttrs: full pi-ai Usage maps tokens AND nested cost via allowlist", () => {
  assert.deepEqual(extractPiUsageAttrs(FULL_USAGE), {
    input_tokens: 100,
    output_tokens: 200,
    cached_read_tokens: 30,
    cache_write_tokens: 40,
    cache_write_1h_tokens: 5,
    reasoning_tokens: 12,
    total_tokens: 300,
    totalCostUsd: 0.033,
    cost_input_usd: 0.01,
    cost_output_usd: 0.02,
    cost_cache_read_usd: 0.001,
    cost_cache_write_usd: 0.002,
  });
});

test("extractPiUsageAttrs: partial usage extracts only present fields (mark-absent)", () => {
  assert.deepEqual(extractPiUsageAttrs({ input: 10, totalTokens: 10 }), {
    input_tokens: 10,
    total_tokens: 10,
  });
});

test("extractPiUsageAttrs: present 0 is a real reported 0, extracted (present != absent)", () => {
  assert.deepEqual(extractPiUsageAttrs({ output: 0, cost: { total: 0 } }), {
    output_tokens: 0,
    totalCostUsd: 0,
  });
});

test("extractPiUsageAttrs: empty / absent usage yields no attrs, never fabricated", () => {
  assert.deepEqual(extractPiUsageAttrs({}), {});
  assert.deepEqual(extractPiUsageAttrs(undefined), {});
  assert.deepEqual(extractPiUsageAttrs(null), {});
});

test("extractPiUsageAttrs: non-numeric / non-finite fields are NOT extracted (no coerce, no zero-fake)", () => {
  assert.deepEqual(extractPiUsageAttrs({ input: "100", output: Number.NaN, totalTokens: null }), {});
  assert.deepEqual(extractPiUsageAttrs({ input: Number.POSITIVE_INFINITY }), {});
});

test("extractPiUsageAttrs: non-object cost is ignored, tokens still extracted", () => {
  assert.deepEqual(extractPiUsageAttrs({ input: 7, cost: "nope" }), { input_tokens: 7 });
  assert.deepEqual(extractPiUsageAttrs({ input: 7, cost: [1, 2] }), { input_tokens: 7 });
});

test("extractPiUsageAttrs: unknown keys ignored (explicit allowlist, no raw passthrough)", () => {
  assert.deepEqual(
    extractPiUsageAttrs({ input: 1, some_unknown: 42, cost: { total: 0.5, weird: 9 } }),
    { input_tokens: 1, totalCostUsd: 0.5 },
  );
});

test("extractPiUsageAttrs: array usage is not treated as a usage object", () => {
  assert.deepEqual(extractPiUsageAttrs([1, 2, 3] as unknown), {});
});

test("buildPiTokenUsageEvent: message.usage present -> per-turn token_usage telemetry (tokens+cost)", () => {
  assert.deepEqual(buildPiTokenUsageEvent({ role: "assistant", usage: FULL_USAGE }, "pi-1"), {
    kind: "telemetry",
    name: "token_usage",
    source: "pi_message_end_usage",
    usageKind: "per_turn",
    sessionId: "pi-1",
    attrs: {
      input_tokens: 100,
      output_tokens: 200,
      cached_read_tokens: 30,
      cache_write_tokens: 40,
      cache_write_1h_tokens: 5,
      reasoning_tokens: 12,
      total_tokens: 300,
      totalCostUsd: 0.033,
      cost_input_usd: 0.01,
      cost_output_usd: 0.02,
      cost_cache_read_usd: 0.001,
      cost_cache_write_usd: 0.002,
    },
  });
});

test("buildPiTokenUsageEvent: no usage on message -> null (mark-absent, never empty-usage event)", () => {
  assert.equal(buildPiTokenUsageEvent({ role: "assistant", stopReason: "error" }, "pi-1"), null);
  assert.equal(buildPiTokenUsageEvent({ role: "assistant", usage: {} }, "pi-1"), null);
  assert.equal(buildPiTokenUsageEvent(undefined, null), null);
  assert.equal(buildPiTokenUsageEvent("not-an-object" as unknown, "pi-1"), null);
});

test("buildPiTokenUsageEvent: present-0 usage still emits (present 0, not absent)", () => {
  // pi-ai wire key is `totalTokens` (camelCase) -> attr `total_tokens`.
  const event = buildPiTokenUsageEvent({ usage: { totalTokens: 0 } }, "pi-1");
  assert.equal(event?.kind, "telemetry");
  assert.deepEqual(event?.attrs, { total_tokens: 0 });
});

test("buildPiTokenUsageEvent: null sessionId normalized to undefined", () => {
  const event = buildPiTokenUsageEvent({ usage: { input: 3 } }, null);
  assert.equal(event?.sessionId, undefined);
});
