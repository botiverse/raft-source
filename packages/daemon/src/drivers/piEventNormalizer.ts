import type { ParsedEvent } from "./types.js";

/**
 * Pi (and builtin, which extends PiDriver) token-usage normalizer.
 *
 * The pi SDK `message_end` event's `message` is a pi-ai `AssistantMessage` that
 * carries a `usage` object (`@earendil-works/pi-ai` `interface Usage`): top-level
 * token counts plus a nested per-category `cost` breakdown. The daemon previously
 * narrowed `message` to `{role, stopReason, errorMessage}` and discarded usage.
 * This normalizer typed-extracts the usage (tokens AND cost) into a `token_usage`
 * telemetry ParsedEvent so the daemon emits `daemon.runtime.telemetry.token_usage`
 * for the pi/builtin runtimes.
 *
 * pi-ai `Usage` shape (as of pi-ai 0.83.x):
 *   { input, output, cacheRead, cacheWrite, cacheWrite1h?, reasoning?, totalTokens,
 *     cost: { input, output, cacheRead, cacheWrite, total } }
 * `usage` rides on each AssistantMessage, so it is per-turn (per assistant message).
 *
 * Value-provenance discipline (shared with grok/codex/claude/gemini normalizers):
 * - typed extraction only (finite-number guard); explicit allowlist; NO raw
 *   passthrough of the usage/cost objects;
 * - mark-absent, never zero-fill: a missing field yields no attr; absent/empty
 *   usage yields NO telemetry event (returns null). A field *present* with value 0
 *   is a real reported 0 and IS emitted (present-0 != absent).
 */

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// [wireKey, attrKey] — top-level token counts on pi-ai Usage.
const PI_TOKEN_MAPPINGS = [
  ["input", "input_tokens"],
  ["output", "output_tokens"],
  ["cacheRead", "cached_read_tokens"],
  ["cacheWrite", "cache_write_tokens"],
  ["cacheWrite1h", "cache_write_1h_tokens"],
  ["reasoning", "reasoning_tokens"],
  ["totalTokens", "total_tokens"],
] as const;

// [wireKey, attrKey] — nested Usage.cost.* (USD). `total` aligns with the
// `totalCostUsd` attr the cost read-side already consumes (claude normalizer).
const PI_COST_MAPPINGS = [
  ["total", "totalCostUsd"],
  ["input", "cost_input_usd"],
  ["output", "cost_output_usd"],
  ["cacheRead", "cost_cache_read_usd"],
  ["cacheWrite", "cost_cache_write_usd"],
] as const;

export function extractPiUsageAttrs(usage: unknown): Record<string, number> {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return {};
  const source = usage as Record<string, unknown>;
  const attrs: Record<string, number> = {};
  for (const [wireKey, attrKey] of PI_TOKEN_MAPPINGS) {
    const candidate = finiteNumber(source[wireKey]);
    if (candidate !== undefined) attrs[attrKey] = candidate;
  }
  const cost = source.cost;
  if (cost && typeof cost === "object" && !Array.isArray(cost)) {
    const costSource = cost as Record<string, unknown>;
    for (const [wireKey, attrKey] of PI_COST_MAPPINGS) {
      const candidate = finiteNumber(costSource[wireKey]);
      if (candidate !== undefined) attrs[attrKey] = candidate;
    }
  }
  return attrs;
}

/**
 * Build a `token_usage` telemetry event from a pi `message_end` event's
 * `message.usage`. Returns null when no usage field is present (never emits a
 * zero/empty-usage event).
 */
export function buildPiTokenUsageEvent(
  message: unknown,
  sessionId: string | null,
): Extract<ParsedEvent, { kind: "telemetry" }> | null {
  if (!message || typeof message !== "object") return null;
  const attrs = extractPiUsageAttrs((message as Record<string, unknown>).usage);
  if (Object.keys(attrs).length === 0) return null;
  return {
    kind: "telemetry",
    name: "token_usage",
    source: "pi_message_end_usage",
    usageKind: "per_turn",
    sessionId: sessionId ?? undefined,
    attrs,
  };
}
