import type { ParsedEvent } from "./types.js";
import type { JsonRpcMessage } from "./codexEventNormalizer.js";

type TelemetryAttrs = Extract<ParsedEvent, { kind: "telemetry" }>["attrs"];

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function finiteString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function ratio(numerator: number | undefined, denominator: number | undefined): number | undefined {
  if (numerator === undefined || denominator === undefined || denominator <= 0) return undefined;
  return Number((numerator / denominator).toFixed(6));
}

function withDefined(attrs: Record<string, unknown>): TelemetryAttrs {
  return Object.fromEntries(Object.entries(attrs).filter(([, value]) => value !== undefined)) as TelemetryAttrs;
}

function parseTokenUsageTelemetry(message: JsonRpcMessage): ParsedEvent | null {
  const usage = message.params?.tokenUsage;
  const total = usage?.total;
  if (!total || typeof total !== "object") return null;

  const inputTokens = finiteNumber(total.inputTokens);
  const cachedInputTokens = finiteNumber(total.cachedInputTokens);
  const totalTokens = finiteNumber(total.totalTokens);
  const modelContextWindow = finiteNumber(usage.modelContextWindow);

  const attrs = withDefined({
    totalTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens: finiteNumber(total.outputTokens),
    reasoningOutputTokens: finiteNumber(total.reasoningOutputTokens),
    modelContextWindow,
    cachedInputRatio: ratio(cachedInputTokens, inputTokens),
    contextUtilization: ratio(totalTokens, modelContextWindow),
  });
  if (Object.keys(attrs).length === 0) return null;
  return {
    kind: "telemetry",
    name: "token_usage",
    source: "codex_thread_token_usage_updated",
    usageKind: "cumulative_session",
    attrs,
  };
}

function parseRateLimitTelemetry(message: JsonRpcMessage): ParsedEvent | null {
  const rateLimits = message.params?.rateLimits;
  const primary = rateLimits?.primary;
  if (!rateLimits || typeof rateLimits !== "object" || !primary || typeof primary !== "object") return null;

  const attrs = withDefined({
    limitId: finiteString(rateLimits.limitId),
    planType: finiteString(rateLimits.planType),
    usedPercent: finiteNumber(primary.usedPercent),
    windowDurationMins: finiteNumber(primary.windowDurationMins),
    resetsAt: finiteNumber(primary.resetsAt),
  });
  if (Object.keys(attrs).length === 0) return null;
  return {
    kind: "telemetry",
    name: "rate_limits",
    source: "codex_account_rate_limits_updated",
    attrs,
  };
}

export function parseCodexTelemetryEvent(message: JsonRpcMessage): ParsedEvent | null {
  switch (message.method) {
    case "thread/tokenUsage/updated":
      return parseTokenUsageTelemetry(message);
    case "account/rateLimits/updated":
      return parseRateLimitTelemetry(message);
    default:
      return null;
  }
}
