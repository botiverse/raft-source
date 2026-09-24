import type { ParsedEvent } from "./types.js";

/**
 * Gemini CLI token-usage normalizer.
 *
 * Gemini CLI `--output-format stream-json` emits a terminal `result` event that
 * carries a `stats` object with token counts. This normalizer typed-extracts the
 * usage numbers into a `token_usage` telemetry ParsedEvent so the daemon can emit
 * `daemon.runtime.telemetry.token_usage` for the gemini runtime.
 *
 * Value-provenance discipline (shared with the grok/codex/claude normalizers):
 * - typed extraction only: a field is copied only when it is a finite number;
 * - explicit allowlist: the raw `stats` object is never passed through;
 * - mark-absent, never zero-fill: a missing field yields no attr, and an
 *   empty/absent `stats` yields NO telemetry event at all (returns null). A
 *   field that is *present* with value 0 is a real reported 0 and IS emitted —
 *   this is the deliberate present-0 vs absent distinction.
 *
 * Only `total_tokens` is verified against the daemon's gemini result contract
 * (see `gemini.test.ts`). Additional gemini `stats` fields are intentionally NOT
 * guessed here; extend `GEMINI_STATS_USAGE_MAPPINGS` only when a real gemini-cli
 * stats field name is confirmed against the runtime's actual event schema.
 */

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// [wireKey, attrKey] — only fields confirmed against the gemini result contract.
const GEMINI_STATS_USAGE_MAPPINGS = [
  ["total_tokens", "total_tokens"],
] as const;

export function extractGeminiUsageAttrs(stats: unknown): Record<string, number> {
  if (!stats || typeof stats !== "object" || Array.isArray(stats)) return {};
  const source = stats as Record<string, unknown>;
  const attrs: Record<string, number> = {};
  for (const [wireKey, attrKey] of GEMINI_STATS_USAGE_MAPPINGS) {
    const candidate = finiteNumber(source[wireKey]);
    if (candidate !== undefined) attrs[attrKey] = candidate;
  }
  return attrs;
}

/**
 * Build a `token_usage` telemetry event from a gemini `result` event's `stats`.
 * Returns null when no usage field is present (never emits a zero/empty-usage
 * event). Gemini runs one process per turn, so the stats are per-turn usage.
 */
export function buildGeminiTokenUsageEvent(
  stats: unknown,
  sessionId: string | null,
): Extract<ParsedEvent, { kind: "telemetry" }> | null {
  const attrs = extractGeminiUsageAttrs(stats);
  if (Object.keys(attrs).length === 0) return null;
  return {
    kind: "telemetry",
    name: "token_usage",
    source: "gemini_result_stats",
    usageKind: "per_turn",
    sessionId: sessionId ?? undefined,
    attrs,
  };
}
