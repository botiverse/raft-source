import type { SubagentLineage } from "@botiverse/raft-shared";
import type { ParsedEvent } from "./types.js";

type TelemetryAttrs = Extract<ParsedEvent, { kind: "telemetry" }>["attrs"];

/**
 * Extract EXPLICIT subagent lineage from a Claude stream row (APM 1.6 6b).
 *
 * Subagent-ness is derived ONLY from structured lineage fields Claude emits on
 * inner subagent assistant/user rows — `parent_tool_use_id`, `subagent_type`,
 * `task_description`/`task_id`. It is NEVER inferred from display text. Returns
 * undefined when no lineage is present so the caller keeps the row flat (6a).
 *
 * Only closed ids / bounded tokens are preserved — never raw prompt or output
 * (Q8 discipline). `task_description` is intentionally NOT copied here; it is
 * free-form content, and lineage is keyed on ids + the bounded `subagent_type`.
 */
function extractSubagentLineage(event: Record<string, any>): SubagentLineage["subagent"] | undefined {
  const parentToolUseId = finiteString(event.parent_tool_use_id);
  const subagentType = finiteString(event.subagent_type);
  if (!parentToolUseId && !subagentType) return undefined;
  return {
    ...(parentToolUseId ? { parentToolUseId } : {}),
    ...(subagentType ? { subagentType } : {}),
    phase: "active",
  };
}

/** Map a Claude `system` task-lifecycle subtype to a bounded subagent phase. */
function taskLifecyclePhase(subtype: string): "started" | "progress" | "notification" | null {
  switch (subtype) {
    case "task_started":
      return "started";
    case "task_progress":
      return "progress";
    case "task_notification":
      return "notification";
    default:
      return null;
  }
}

function collectResultErrorDetail(message: Record<string, any>, fallback: string): string {
  const parts: string[] = [];
  if (Array.isArray(message.errors)) {
    for (const err of message.errors) {
      if (typeof err === "string" && err.trim()) parts.push(err.trim());
    }
  }
  if (typeof message.result === "string" && message.result.trim()) {
    parts.push(message.result.trim());
  }
  return parts.join(" | ") || fallback;
}

function isProviderApiFailureText(value: string, hasToolUse: boolean): boolean {
  return !hasToolUse
    && /^\s*API Error:/i.test(value)
    && (
      /\b(?:ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN)\b/i.test(value)
      || /\bUnable to connect to API\b/i.test(value)
      || /\b(?:timed out|timeout)\b/i.test(value)
      || /\b4\d{2}\b/.test(value)
      || /\b5\d{2}\b/.test(value)
    );
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function finiteString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function withDefined(attrs: Record<string, unknown>): TelemetryAttrs {
  return Object.fromEntries(Object.entries(attrs).filter(([, value]) => value !== undefined)) as TelemetryAttrs;
}

function collectNumericFields(value: unknown, fields: Record<string, string>): TelemetryAttrs {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const attrs: TelemetryAttrs = {};
  for (const [sourceKey, attrKey] of Object.entries(fields)) {
    const numberValue = finiteNumber((value as Record<string, unknown>)[sourceKey]);
    if (numberValue !== undefined) attrs[attrKey] = numberValue;
  }
  return attrs;
}

function collectModelUsageAttrs(value: unknown): TelemetryAttrs {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const sanitized: Record<string, Record<string, number>> = {};
  const aggregate: Record<string, number> = {};
  const knownNumericFields = [
    "inputTokens",
    "outputTokens",
    "cacheReadInputTokens",
    "cacheCreationInputTokens",
    "webSearchRequests",
    "costUSD",
    "contextWindow",
    "maxOutputTokens",
  ];

  for (const [modelName, rawUsage] of Object.entries(value)) {
    if (!rawUsage || typeof rawUsage !== "object" || Array.isArray(rawUsage)) continue;
    const modelUsage: Record<string, number> = {};
    for (const field of knownNumericFields) {
      const numberValue = finiteNumber((rawUsage as Record<string, unknown>)[field]);
      if (numberValue === undefined) continue;
      modelUsage[field] = numberValue;
      const aggregateKey = field === "costUSD" ? "costUsd" : field;
      if (field === "contextWindow" || field === "maxOutputTokens") {
        aggregate[aggregateKey] = Math.max(aggregate[aggregateKey] ?? 0, numberValue);
      } else {
        aggregate[aggregateKey] = (aggregate[aggregateKey] ?? 0) + numberValue;
      }
    }
    if (Object.keys(modelUsage).length > 0) sanitized[modelName] = modelUsage;
  }

  const modelNames = Object.keys(sanitized).sort();
  if (modelNames.length === 0) return {};

  const orderedSanitized = Object.fromEntries(modelNames.map((modelName) => [modelName, sanitized[modelName]]));
  return withDefined({
    modelUsageModelCount: modelNames.length,
    modelUsageModels: modelNames.join(","),
    modelUsageJson: JSON.stringify(orderedSanitized),
    modelUsageInputTokens: aggregate.inputTokens,
    modelUsageOutputTokens: aggregate.outputTokens,
    modelUsageCachedInputTokens: aggregate.cacheReadInputTokens,
    modelUsageCacheCreationInputTokens: aggregate.cacheCreationInputTokens,
    modelUsageWebSearchRequests: aggregate.webSearchRequests,
    modelUsageCostUsd: aggregate.costUsd,
    modelUsageMaxContextWindow: aggregate.contextWindow,
    modelUsageMaxOutputTokens: aggregate.maxOutputTokens,
  });
}

function parseClaudeResultUsageTelemetry(
  event: Record<string, any>,
  sessionId: string | null,
): Extract<ParsedEvent, { kind: "telemetry" }> | null {
  const usage = event.usage && typeof event.usage === "object" ? event.usage : undefined;
  const totalCostUsd = finiteNumber(event.total_cost_usd);
  const modelUsageAttrs = collectModelUsageAttrs(event.modelUsage);
  const hasTelemetrySource = usage !== undefined || totalCostUsd !== undefined || Object.keys(modelUsageAttrs).length > 0;
  if (!hasTelemetrySource) return null;

  const inputTokens = finiteNumber(usage?.input_tokens);
  const outputTokens = finiteNumber(usage?.output_tokens);
  const cachedInputTokens = finiteNumber(usage?.cache_read_input_tokens);
  const cacheCreationInputTokens = finiteNumber(usage?.cache_creation_input_tokens);

  const attrs: TelemetryAttrs = {
    ...withDefined({
      totalCostUsd,
      durationMs: finiteNumber(event.duration_ms),
      durationApiMs: finiteNumber(event.duration_api_ms),
      numTurns: finiteNumber(event.num_turns),
      resultSubtype: finiteString(event.subtype),
      stopReason: finiteString(event.stop_reason),
      resultIsError: typeof event.is_error === "boolean" ? event.is_error : undefined,
      fastModeState: finiteString(event.fast_mode_state),
      permissionDenialsCount: Array.isArray(event.permission_denials) ? event.permission_denials.length : undefined,
      serviceTier: finiteString(usage?.service_tier),
      inferenceGeo: finiteString(usage?.inference_geo),
      usageSpeed: finiteString(usage?.speed),
      usageIterationsCount: Array.isArray(usage?.iterations) ? usage.iterations.length : undefined,
    }),
    ...collectNumericFields(usage?.server_tool_use, {
      web_search_requests: "serverToolUseWebSearchRequests",
      web_fetch_requests: "serverToolUseWebFetchRequests",
    }),
    ...collectNumericFields(usage?.cache_creation, {
      ephemeral_1h_input_tokens: "cacheCreationEphemeral1hInputTokens",
      ephemeral_5m_input_tokens: "cacheCreationEphemeral5mInputTokens",
    }),
    ...modelUsageAttrs,
  };
  if (inputTokens !== undefined) attrs.inputTokens = inputTokens;
  if (outputTokens !== undefined) attrs.outputTokens = outputTokens;
  if (cachedInputTokens !== undefined) attrs.cachedInputTokens = cachedInputTokens;
  if (cacheCreationInputTokens !== undefined) attrs.cacheCreationInputTokens = cacheCreationInputTokens;

  const tokenComponents = [inputTokens, outputTokens, cachedInputTokens, cacheCreationInputTokens];
  const totalTokens = tokenComponents
    .reduce<number>((sum, value) => sum + (value ?? 0), 0);
  if (tokenComponents.some((value) => value !== undefined)) attrs.totalTokens = totalTokens;

  if (Object.keys(attrs).length === 0) return null;

  return {
    kind: "telemetry",
    name: "token_usage",
    source: "claude_result_usage",
    usageKind: "per_turn",
    ...(sessionId ? { sessionId } : {}),
    ...(typeof event.uuid === "string" && event.uuid ? { runtimeResultId: event.uuid } : {}),
    attrs,
  };
}

export class ClaudeEventNormalizer {
  private currentSession: string | null = null;

  get currentSessionId(): string | null {
    return this.currentSession;
  }

  normalizeLine(line: string): ParsedEvent[] {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return [];
    }

    const events: ParsedEvent[] = [];
    const eventSessionId = finiteString(event.session_id);
    if (eventSessionId) {
      this.currentSession = eventSessionId;
    }

    const pushResultError = (message: Record<string, any>, fallback: string) => {
      events.push({ kind: "error", message: collectResultErrorDetail(message, fallback) });
    };

    switch (event.type) {
      case "rate_limit_event": {
        const info = event.rate_limit_info && typeof event.rate_limit_info === "object"
          ? event.rate_limit_info
          : {};
        events.push({
          kind: "telemetry",
          name: "rate_limits",
          source: "claude_rate_limit_event",
          sessionId: eventSessionId ?? undefined,
          attrs: withDefined({
            status: finiteString(info.status),
            resetsAt: finiteNumber(info.resetsAt),
            rateLimitType: finiteString(info.rateLimitType),
            overageStatus: finiteString(info.overageStatus),
            isUsingOverage: typeof info.isUsingOverage === "boolean" ? info.isUsingOverage : undefined,
          }),
        });
        break;
      }

      case "system":
        if (event.subtype === "init" && eventSessionId) {
          events.push({ kind: "session_init", sessionId: eventSessionId });
        }
        // Black-box Claude CLI evidence on 2.1.107 emits:
        // - { type: "system", subtype: "status", status: "compacting" }
        // - { type: "system", subtype: "compact_boundary", ... }
        // We keep the parser narrow to those live-stream seams to avoid
        // double-emitting finish events from intermediate status updates.
        if (event.subtype === "status" && event.status === "compacting") {
          events.push({ kind: "compaction_started" });
        }
        if (event.subtype === "status" && event.status === "requesting") {
          events.push({
            kind: "internal_progress",
            source: "claude_system_status",
            itemType: "requesting",
            payloadBytes: Buffer.byteLength(line, "utf8"),
          });
        }
        if (event.subtype === "compact_boundary") {
          events.push({ kind: "compaction_finished" });
        }
        // Subagent (Claude `Agent` tool) lifecycle envelopes. These carry no
        // content rows of their own — the inner subagent assistant/user rows
        // arrive separately with parent_tool_use_id — so they become a
        // subagent-marked progress signal keyed on the closed lifecycle ids.
        // (APM 1.6 6b). No raw prompt/output is read.
        {
          const phase = typeof event.subtype === "string" ? taskLifecyclePhase(event.subtype) : null;
          if (phase) {
            events.push({
              kind: "subagent_progress",
              source: "claude_task_lifecycle",
              phase,
              ...(finiteString(event.task_id) ? { taskId: finiteString(event.task_id)! } : {}),
              // `system` task-lifecycle envelopes carry the outer Agent tool id
              // as `tool_use_id`; belt-and-suspenders fall back to
              // `parent_tool_use_id` in case a Claude version names it that way
              // on the envelope (confirmed field name = tool_use_id, @Huarong).
              ...(finiteString(event.tool_use_id) ?? finiteString(event.parent_tool_use_id)
                ? { parentToolUseId: (finiteString(event.tool_use_id) ?? finiteString(event.parent_tool_use_id))! }
                : {}),
              ...(finiteString(event.subagent_type) ? { subagentType: finiteString(event.subagent_type)! } : {}),
              ...(finiteString(event.last_tool_name) ? { lastToolName: finiteString(event.last_tool_name)! } : {}),
              payloadBytes: Buffer.byteLength(line, "utf8"),
            });
          }
        }
        break;

      case "stream_event":
        events.push({
          kind: "internal_progress",
          source: "claude_stream_event",
          itemType: typeof event.event?.type === "string" && event.event.type.length > 0
            ? event.event.type
            : "unknown",
          payloadBytes: Buffer.byteLength(line, "utf8"),
        });
        break;

      case "assistant": {
        const content = event.message?.content;
        // Inner subagent assistant rows carry EXPLICIT lineage; preserve it on
        // the emitted content events so the daemon marks them as subagent
        // activity (APM 1.6 6b). Absent lineage → flat, ordinary events.
        const subagent = extractSubagentLineage(event);
        const withLineage = subagent ? { subagent } : {};
        if (Array.isArray(content)) {
          const hasToolUse = content.some((block) => block?.type === "tool_use");
          for (const block of content) {
            if (block.type === "thinking" && block.thinking) {
              events.push({ kind: "thinking", text: block.thinking, ...withLineage });
            } else if (block.type === "text" && block.text) {
              if (isProviderApiFailureText(block.text, hasToolUse)) {
                events.push({ kind: "error", message: block.text });
              } else {
                events.push({ kind: "text", text: block.text, ...withLineage });
              }
            } else if (block.type === "tool_use") {
              events.push({ kind: "tool_call", name: block.name || "unknown_tool", input: block.input, ...withLineage });
            }
          }
        }
        break;
      }

      case "user": {
        const content = event.message?.content;
        const subagent = extractSubagentLineage(event);
        const withLineage = subagent ? { subagent } : {};
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_result") {
              events.push({ kind: "tool_output", name: block.name || block.tool_use_id || "tool_result", ...withLineage });
            }
          }
        }
        break;
      }

      case "result": {
        const subtype = typeof event.subtype === "string" ? event.subtype : "success";
        const stopReason = typeof event.stop_reason === "string" ? event.stop_reason : null;
        const resultSessionId = eventSessionId ?? this.currentSession;
        const usageTelemetry = parseClaudeResultUsageTelemetry(event, resultSessionId);
        const isMaxTokenError = stopReason === "max_tokens" &&
          (event.is_error === true || subtype !== "success");

        switch (subtype) {
          case "success":
            if (event.is_error) {
              pushResultError(event, "Execution failed");
            }
            break;

          case "error_during_execution":
            if (stopReason !== "max_tokens" || isMaxTokenError) {
              pushResultError(event, "Execution failed");
            }
            break;

          case "error_max_budget_usd":
            pushResultError(event, "Budget limit exceeded");
            break;

          case "error_max_turns":
            pushResultError(event, "Max turns exceeded");
            break;

          case "error_max_structured_output_retries":
            pushResultError(event, "Structured output retries exceeded");
            break;
        }
        if (usageTelemetry) events.push(usageTelemetry);
        events.push({ kind: "turn_end", sessionId: resultSessionId || undefined });
        break;
      }
    }

    return events;
  }
}
