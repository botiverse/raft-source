import assert from "node:assert/strict";
import { test } from "vitest";
import { extractGeminiUsageAttrs, buildGeminiTokenUsageEvent } from "./geminiEventNormalizer.js";

test("extractGeminiUsageAttrs: present numeric total_tokens is extracted", () => {
  assert.deepEqual(extractGeminiUsageAttrs({ total_tokens: 1000 }), { total_tokens: 1000 });
});

test("extractGeminiUsageAttrs: present total_tokens=0 is a real reported 0, extracted (present != absent)", () => {
  assert.deepEqual(extractGeminiUsageAttrs({ total_tokens: 0 }), { total_tokens: 0 });
});

test("extractGeminiUsageAttrs: empty stats yields no attrs (absent, not zero-filled)", () => {
  assert.deepEqual(extractGeminiUsageAttrs({}), {});
});

test("extractGeminiUsageAttrs: missing/absent stats yields no attrs, never fabricated", () => {
  assert.deepEqual(extractGeminiUsageAttrs(undefined), {});
  assert.deepEqual(extractGeminiUsageAttrs(null), {});
});

test("extractGeminiUsageAttrs: non-numeric total_tokens is NOT extracted (no zero-fake, no coercion)", () => {
  assert.deepEqual(extractGeminiUsageAttrs({ total_tokens: "1000" }), {});
  assert.deepEqual(extractGeminiUsageAttrs({ total_tokens: null }), {});
});

test("extractGeminiUsageAttrs: non-finite total_tokens is NOT extracted", () => {
  assert.deepEqual(extractGeminiUsageAttrs({ total_tokens: Number.NaN }), {});
  assert.deepEqual(extractGeminiUsageAttrs({ total_tokens: Number.POSITIVE_INFINITY }), {});
});

test("extractGeminiUsageAttrs: unknown stats keys are ignored (explicit allowlist, no raw passthrough)", () => {
  assert.deepEqual(
    extractGeminiUsageAttrs({ total_tokens: 5, some_unknown_gemini_field: 42, nested: { x: 1 } }),
    { total_tokens: 5 },
  );
});

test("extractGeminiUsageAttrs: array is not treated as a stats object", () => {
  assert.deepEqual(extractGeminiUsageAttrs([1, 2, 3] as unknown), {});
});

test("buildGeminiTokenUsageEvent: usage present -> per-turn token_usage telemetry event", () => {
  assert.deepEqual(buildGeminiTokenUsageEvent({ total_tokens: 1000 }, "sess-1"), {
    kind: "telemetry",
    name: "token_usage",
    source: "gemini_result_stats",
    usageKind: "per_turn",
    sessionId: "sess-1",
    attrs: { total_tokens: 1000 },
  });
});

test("buildGeminiTokenUsageEvent: present total_tokens=0 still emits (present 0, not absent)", () => {
  const event = buildGeminiTokenUsageEvent({ total_tokens: 0 }, "sess-1");
  assert.equal(event?.kind, "telemetry");
  assert.deepEqual(event?.attrs, { total_tokens: 0 });
});

test("buildGeminiTokenUsageEvent: no usage field -> null (mark-absent, never zero/empty-usage event)", () => {
  assert.equal(buildGeminiTokenUsageEvent({}, "sess-1"), null);
  assert.equal(buildGeminiTokenUsageEvent(undefined, null), null);
  assert.equal(buildGeminiTokenUsageEvent({ total_tokens: "nope" }, "sess-1"), null);
});

test("buildGeminiTokenUsageEvent: null sessionId is normalized to undefined", () => {
  const event = buildGeminiTokenUsageEvent({ total_tokens: 7 }, null);
  assert.equal(event?.sessionId, undefined);
});
