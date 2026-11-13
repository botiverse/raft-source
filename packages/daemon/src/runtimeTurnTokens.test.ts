import assert from "node:assert/strict";
import { test } from "vitest";
import type { ParsedEvent } from "./drivers/index";
import { activityTurnTokensFrom, createTurnTokenAccumulator, noteTurnTokenUsage, turnTokenTraceAttrs } from "./runtimeTurnTokens";

type TelemetryEvent = Extract<ParsedEvent, { kind: "telemetry" }>;
const usage = (source: string, attrs: TelemetryEvent["attrs"]): TelemetryEvent => ({ kind: "telemetry", name: "token_usage", source, attrs });

test("Claude's per-turn result usage maps to the four turn fields", () => {
  const acc = createTurnTokenAccumulator();
  noteTurnTokenUsage(acc, usage("claude_result_usage", { inputTokens: 12, outputTokens: 900, cachedInputTokens: 80_000, cacheCreationInputTokens: 3_000, totalCostUsd: 0.4 }));
  assert.deepEqual(turnTokenTraceAttrs(acc), { input_tokens: 12, output_tokens: 900, cache_read_tokens: 80_000, cache_write_tokens: 3_000 });
});

test("per-call reports (pi messages, Kimi steps) add up over the turn", () => {
  const acc = createTurnTokenAccumulator();
  noteTurnTokenUsage(acc, usage("pi_message_end_usage", { input_tokens: 100, output_tokens: 10, cached_read_tokens: 1_000 }));
  noteTurnTokenUsage(acc, usage("pi_message_end_usage", { input_tokens: 50, output_tokens: 5, cached_read_tokens: 1_100 }));
  // pi never reported cache writes, so the field stays off rather than 0.
  assert.deepEqual(turnTokenTraceAttrs(acc), { input_tokens: 150, output_tokens: 15, cache_read_tokens: 2_100 });

  const kimi = createTurnTokenAccumulator();
  noteTurnTokenUsage(kimi, usage("kimi_turn_step_completed_usage", { input_tokens: 7, output_tokens: 3, cached_read_tokens: 0, cache_write_tokens: 40 }));
  assert.deepEqual(turnTokenTraceAttrs(kimi), { input_tokens: 7, output_tokens: 3, cache_read_tokens: 0, cache_write_tokens: 40 });
});

test("Codex session totals become this turn's usage, with cached input split out", () => {
  const acc = createTurnTokenAccumulator();
  // The thread had used 10,000 input (8,000 cached) and 500 output before
  // this turn; the turn's first call adds 3,000 input (2,500 cached) and 100 output.
  noteTurnTokenUsage(acc, usage("codex_thread_token_usage_updated", {
    inputTokens: 13_000, cachedInputTokens: 10_500, outputTokens: 600,
    lastInputTokens: 3_000, lastCachedInputTokens: 2_500, lastOutputTokens: 100,
  }));
  noteTurnTokenUsage(acc, usage("codex_thread_token_usage_updated", {
    inputTokens: 17_000, cachedInputTokens: 13_500, outputTokens: 800,
    lastInputTokens: 4_000, lastCachedInputTokens: 3_000, lastOutputTokens: 200,
  }));
  assert.deepEqual(turnTokenTraceAttrs(acc), { input_tokens: 1_500, output_tokens: 300, cache_read_tokens: 5_500, last_request_context_tokens: 4_000 });
});

test("#54: the turn's last request context: Claude's from the normalizer, Codex's last input (cached included); the summed fields can't size it", () => {
  const claude = createTurnTokenAccumulator();
  noteTurnTokenUsage(claude, usage("claude_result_usage", { inputTokens: 30, outputTokens: 900, cachedInputTokens: 900_000, cacheCreationInputTokens: 5_000, lastRequestContextTokens: 310_000 }));
  assert.equal(turnTokenTraceAttrs(claude).last_request_context_tokens, 310_000, "not the 905k summed over the turn's calls");
  const codex = createTurnTokenAccumulator();
  noteTurnTokenUsage(codex, usage("codex_thread_token_usage_updated", { inputTokens: 900_000, cachedInputTokens: 800_000, outputTokens: 600, lastInputTokens: 250_000, lastCachedInputTokens: 240_000, lastOutputTokens: 100 }));
  assert.equal(turnTokenTraceAttrs(codex).last_request_context_tokens, 250_000);
  const pi = createTurnTokenAccumulator();
  noteTurnTokenUsage(pi, usage("pi_message_end_usage", { input_tokens: 100, output_tokens: 10 }));
  assert.equal(turnTokenTraceAttrs(pi).last_request_context_tokens, undefined, "not reported: left off");
});

test("unusable reports leave the fields off", () => {
  const noLast = createTurnTokenAccumulator();
  noteTurnTokenUsage(noLast, usage("codex_thread_token_usage_updated", { inputTokens: 13_000, cachedInputTokens: 10_500, outputTokens: 600 }));
  assert.deepEqual(turnTokenTraceAttrs(noLast), {});

  const reset = createTurnTokenAccumulator();
  noteTurnTokenUsage(reset, usage("codex_thread_token_usage_updated", {
    inputTokens: 13_000, cachedInputTokens: 10_500, outputTokens: 600, lastInputTokens: 3_000, lastCachedInputTokens: 2_500, lastOutputTokens: 100,
  }));
  noteTurnTokenUsage(reset, usage("codex_thread_token_usage_updated", {
    inputTokens: 900, cachedInputTokens: 0, outputTokens: 20, lastInputTokens: 900, lastCachedInputTokens: 0, lastOutputTokens: 20,
  }));
  assert.deepEqual(turnTokenTraceAttrs(reset), { last_request_context_tokens: 900 }, "totals that went backwards give no number; the last call's own size still holds");

  const gemini = createTurnTokenAccumulator();
  noteTurnTokenUsage(gemini, usage("gemini_result_stats", { total_tokens: 5_000 }));
  noteTurnTokenUsage(gemini, { kind: "telemetry", name: "rate_limits", source: "claude_result_usage", attrs: { inputTokens: 1 } });
  assert.deepEqual(turnTokenTraceAttrs(gemini), {});
});

test("Pi Anthropic provider_request sizes add up over the turn, and its tokens are not counted twice", () => {
  const acc = createTurnTokenAccumulator();
  const request = (attrs: TelemetryEvent["attrs"]): TelemetryEvent => ({ kind: "telemetry", name: "provider_request", source: "pi_anthropic_request", attrs });
  noteTurnTokenUsage(acc, usage("pi_message_end_usage", { input_tokens: 100, output_tokens: 10 }));
  noteTurnTokenUsage(acc, request({ request_bytes: 9_000, input_tokens: 100 }));
  noteTurnTokenUsage(acc, request({ request_bytes: 400, input_tokens: 5 }));
  assert.deepEqual(turnTokenTraceAttrs(acc), {
    input_tokens: 100,
    output_tokens: 10,
    provider_request_bytes: 9_400,
    provider_requests_count: 2,
  });
});

test("activityTurnTokensFrom: the turn's counts, its last request's context and the model; unreported counts stay absent", () => {
  const acc = createTurnTokenAccumulator();
  noteTurnTokenUsage(acc, usage("claude_result_usage", { inputTokens: 12, outputTokens: 900, cachedInputTokens: 80_000, lastRequestContextTokens: 81_000 }));
  assert.deepEqual(activityTurnTokensFrom(acc, "claude-opus"), { input: 12, cacheRead: 80_000, output: 900, contextUsed: 81_000, model: "claude-opus" });
  assert.deepEqual(activityTurnTokensFrom(createTurnTokenAccumulator(), undefined), {});
});
