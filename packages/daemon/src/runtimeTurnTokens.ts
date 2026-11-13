import type { ActivityTurnTokens } from "@botiverse/raft-shared";
import type { ParsedEvent } from "./drivers/index";

type TelemetryEvent = Extract<ParsedEvent, { kind: "telemetry" }>;

/**
 * Tokens one turn used, split the way providers bill them: `input` is uncached
 * input only, `cacheRead` and `cacheWrite` are the cached parts, and `output`
 * includes reasoning. A field a runtime does not report stays undefined, never
 * 0, so a missing number is not mistaken for a free turn.
 */
export interface TurnTokenCounts {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;

export interface TurnTokenAccumulator {
  /** Sum of per-call or per-turn reports. */
  added: TurnTokenCounts;
  /** Codex reports running session totals: the totals just before this turn's
   * first model call, and the latest totals. */
  sessionBase?: TurnTokenCounts;
  sessionLatest?: TurnTokenCounts;
  /**
   * #proj-runtime:#54: the context the turn's last model request carried
   * (input + cache read + cache write of that one request). The counts above
   * are summed over every request, so they can't size the context for a
   * threshold; this can. Claude and Codex report it.
   */
  lastRequestContextTokens?: number;
  /**
   * #runtime-watch:#1: what the turn's provider calls put on the wire, summed,
   * and how many calls (`provider_request` telemetry; Pi on
   * `anthropic-messages` only); absent for runtimes that do not report it.
   */
  requestBytes?: number;
  providerRequests?: number;
}

export function createTurnTokenAccumulator(): TurnTokenAccumulator {
  return { added: {} };
}

function num(attrs: TelemetryEvent["attrs"], key: string): number | undefined {
  const value = attrs[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function counts(input: number | undefined, output: number | undefined, cacheRead: number | undefined, cacheWrite: number | undefined): TurnTokenCounts {
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
  };
}

// Codex counts cached input inside `inputTokens`; split it out.
function codexCounts(attrs: TelemetryEvent["attrs"], prefix: "" | "last"): TurnTokenCounts | null {
  const key = (name: string) => (prefix ? `${prefix}${name[0]!.toUpperCase()}${name.slice(1)}` : name);
  const input = num(attrs, key("inputTokens"));
  const cached = num(attrs, key("cachedInputTokens"));
  const output = num(attrs, key("outputTokens"));
  if (input === undefined || cached === undefined || output === undefined) return null;
  return counts(input - cached, output, cached, undefined);
}

function addCounts(into: TurnTokenCounts, next: TurnTokenCounts): void {
  for (const field of TOKEN_FIELDS) {
    const value = next[field];
    if (value !== undefined) into[field] = (into[field] ?? 0) + value;
  }
}

/** Folds one `token_usage` report into the open turn. Sources whose numbers
 * are not known to mean the same thing (gemini reports only a total) are
 * skipped rather than guessed. */
export function noteTurnTokenUsage(acc: TurnTokenAccumulator, event: TelemetryEvent): void {
  if (event.name === "provider_request") {
    noteTurnProviderRequest(acc, event);
    return;
  }
  if (event.name !== "token_usage") return;
  const { attrs } = event;
  switch (event.source) {
    case "claude_result_usage": {
      addCounts(acc.added, counts(num(attrs, "inputTokens"), num(attrs, "outputTokens"), num(attrs, "cachedInputTokens"), num(attrs, "cacheCreationInputTokens")));
      const lastRequest = num(attrs, "lastRequestContextTokens");
      if (lastRequest !== undefined) acc.lastRequestContextTokens = lastRequest;
      return;
    }
    case "pi_message_end_usage":
    case "kimi_turn_step_completed_usage":
      addCounts(acc.added, counts(num(attrs, "input_tokens"), num(attrs, "output_tokens"), num(attrs, "cached_read_tokens"), num(attrs, "cache_write_tokens")));
      return;
    case "codex_thread_token_usage_updated": {
      // Codex counts cached input inside inputTokens, so the last call's input is its whole context.
      const lastInput = num(attrs, "lastInputTokens");
      if (lastInput !== undefined) acc.lastRequestContextTokens = lastInput;
      const total = codexCounts(attrs, "");
      if (!total) return;
      if (!acc.sessionBase) {
        // Totals before this report = totals minus the call it reports, so the
        // first turn after a resume needs no earlier state.
        const last = codexCounts(attrs, "last");
        if (!last) return;
        acc.sessionBase = {};
        for (const field of TOKEN_FIELDS) {
          if (total[field] !== undefined && last[field] !== undefined) acc.sessionBase[field] = total[field]! - last[field]!;
        }
      }
      acc.sessionLatest = total;
      return;
    }
  }
}

/** One provider call's wire size (`provider_request`); its tokens come with the runtime's own `token_usage`. */
function noteTurnProviderRequest(acc: TurnTokenAccumulator, event: TelemetryEvent): void {
  const bytes = num(event.attrs, "request_bytes");
  if (bytes === undefined) return;
  acc.requestBytes = (acc.requestBytes ?? 0) + bytes;
  acc.providerRequests = (acc.providerRequests ?? 0) + 1;
}

/**
 * Folds a running session total into the open turn, as Codex's running totals
 * are folded: `before` is the session's total before this report (the first
 * report of the turn fixes the turn's base), `latest` the total now. For a
 * host that reads the session totals itself (the OAR host's `usage` events,
 * counted from the session's open).
 */
export function noteTurnSessionTokenTotals(acc: TurnTokenAccumulator, before: TurnTokenCounts, latest: TurnTokenCounts): void {
  acc.sessionBase ??= { ...before };
  acc.sessionLatest = { ...latest };
}

export function turnTokenCounts(acc: TurnTokenAccumulator): TurnTokenCounts {
  const result: TurnTokenCounts = { ...acc.added };
  if (acc.sessionBase && acc.sessionLatest) {
    const delta: TurnTokenCounts = {};
    for (const field of TOKEN_FIELDS) {
      const base = acc.sessionBase[field];
      const latest = acc.sessionLatest[field];
      if (base === undefined || latest === undefined) continue;
      // Totals that went backwards (a reset session) give no usable number.
      if (latest < base) return { ...acc.added };
      delta[field] = latest - base;
    }
    addCounts(result, delta);
  }
  return result;
}

export function turnTokenTraceAttrs(acc: TurnTokenAccumulator): Record<string, number> {
  const tokens = turnTokenCounts(acc);
  return {
    ...(tokens.input !== undefined ? { input_tokens: tokens.input } : {}),
    ...(tokens.output !== undefined ? { output_tokens: tokens.output } : {}),
    ...(tokens.cacheRead !== undefined ? { cache_read_tokens: tokens.cacheRead } : {}),
    ...(tokens.cacheWrite !== undefined ? { cache_write_tokens: tokens.cacheWrite } : {}),
    ...(acc.lastRequestContextTokens !== undefined ? { last_request_context_tokens: acc.lastRequestContextTokens } : {}),
    ...(acc.requestBytes !== undefined ? { provider_request_bytes: acc.requestBytes } : {}),
    ...(acc.providerRequests !== undefined ? { provider_requests_count: acc.providerRequests } : {}),
  };
}

/**
 * A turn's counts as its Activity summary carries them
 * (ActivityTurnSummary.tokens): the four counts this accumulator knows, the
 * context the last request carried, and the model. A count the runtime did
 * not report stays absent.
 */
export function activityTurnTokensFrom(acc: TurnTokenAccumulator, model: string | undefined): ActivityTurnTokens {
  const counts = turnTokenCounts(acc);
  return {
    ...(counts.input !== undefined ? { input: counts.input } : {}),
    ...(counts.cacheRead !== undefined ? { cacheRead: counts.cacheRead } : {}),
    ...(counts.cacheWrite !== undefined ? { cacheWrite: counts.cacheWrite } : {}),
    ...(counts.output !== undefined ? { output: counts.output } : {}),
    ...(acc.lastRequestContextTokens !== undefined ? { contextUsed: acc.lastRequestContextTokens } : {}),
    ...(model ? { model } : {}),
  };
}
