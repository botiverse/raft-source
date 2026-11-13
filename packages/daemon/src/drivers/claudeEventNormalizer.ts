import type { SubagentLineage } from "@botiverse/raft-shared";
import { CREDENTIAL_PROBLEM_MESSAGES, type CredentialProblemCode } from "../runtimeErrorDiagnostics";
import { SendIntentArgumentScanner } from "./sendIntentScanner";
import type { ParsedEvent, ProviderQuotaObservation, ProviderQuotaRateLimitType } from "./types";

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

/**
 * What a `system` task-lifecycle envelope's `task_type` says the task is.
 * Claude Code runs sub-agents (`local_agent`, `remote_agent`) and also shell
 * commands (`local_bash`, foreground ones too once they run a few seconds) as
 * tasks with the same envelopes; only an agent task is a sub-agent. Any other
 * named type is "other". Undefined when the envelope names none (older
 * Claude Code, which only sent these for sub-agents).
 */
function taskKindFromType(value: unknown): "agent" | "command" | "other" | undefined {
  const taskType = finiteString(value);
  if (!taskType) return undefined;
  if (taskType === "local_bash") return "command";
  // Agents and agent-team teammates (`in_process_teammate`) are sub-agents.
  return /agent|teammate/.test(taskType) ? "agent" : "other";
}

/** The closed terminal statuses a `task_notification` may carry; anything else is dropped, not echoed. */
function taskNotificationStatus(value: unknown): "completed" | "failed" | "stopped" | undefined {
  return value === "completed" || value === "failed" || value === "stopped" ? value : undefined;
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

// task #379: wording Claude Code uses when an account or budget limit is used
// up (as opposed to a short throttle). Matched only on assistant messages that
// already carry the SDK `error` field, never on free model text.
const CLAUDE_QUOTA_EXHAUSTED_TEXT = [
  /\breached your\b[^.\n]{0,60}\blimit\b/i,
  /\bout of usage credits\b/i,
  /\bhit your\b[^.\n]{0,60}\b(?:budget|spend limit|limit)\b/i,
  /\bused your included\b[^.\n]{0,60}\busage\b/i,
];

type ClaudeRateLimitObservation = { status: string; resetsAtSec?: number };

/**
 * #proj-raft-computer:#68: Claude Code's typed API error on an assistant or
 * result line. Live stream-json (2.1.3xx) is snake_case: `error` (the SDK
 * category), `is_api_error_message`, `api_error_status`, `api_error_code`,
 * `api_error_origin`; the result line repeats the code with `subtype:
 * "success"` and `is_error: true`. Persisted session JSONL is camelCase
 * (`isApiErrorMessage`) with `error` and no status. Fixtures:
 * drivers/fixtures/claude-verification-required.{live,jsonl}.json.
 */
function claudeApiErrorCodes(event: Record<string, unknown>): string[] {
  return [event.error, event.api_error_code, event.apiErrorCode].filter((value): value is string => typeof value === "string" && value.length > 0);
}

/**
 * The typed API error a Claude line carries, for the error's trace class and
 * HTTP status: its codes (`api_error_code`, the SDK `error` category) and
 * `api_error_status`. Undefined when the line has none.
 */
function claudeProviderError(event: Record<string, unknown>): { codes?: string[]; httpStatus?: number } | undefined {
  const codes = [...new Set([event.api_error_code, event.apiErrorCode, event.error].filter((value): value is string => typeof value === "string" && value.length > 0))];
  const status = event.api_error_status ?? event.apiErrorStatus;
  const httpStatus = typeof status === "number" && Number.isInteger(status) ? status : undefined;
  if (codes.length === 0 && httpStatus === undefined) return undefined;
  return { ...(codes.length > 0 ? { codes } : {}), ...(httpStatus !== undefined ? { httpStatus } : {}) };
}

/**
 * An account problem only its holder can resolve, by Claude's typed code
 * (never its wording): the account must be verified.
 */
function classifyClaudeAccountProblem(codes: readonly string[]): CredentialProblemCode | null {
  return codes.includes("verification_required") ? "verification_required" : null;
}

function classifyClaudeProviderLimit(
  sdkError: string,
  text: string,
  lastRateLimit: ClaudeRateLimitObservation | null,
  nowMs: number,
): { kind: "quota_exhausted" | "transient_rate_limit"; resetsAt?: string } | undefined {
  if (sdkError === "billing_error") return { kind: "quota_exhausted" };
  if (sdkError !== "rate_limit") return undefined;
  // A rejected window is evidence only until its reported reset: after that
  // the same session can hit an ordinary throttle, which must stay transient.
  const rejectedWindowCurrent = lastRateLimit?.status === "rejected"
    && (lastRateLimit.resetsAtSec === undefined || lastRateLimit.resetsAtSec * 1000 > nowMs);
  if (lastRateLimit && rejectedWindowCurrent) {
    return lastRateLimit.resetsAtSec !== undefined
      ? { kind: "quota_exhausted", resetsAt: new Date(lastRateLimit.resetsAtSec * 1000).toISOString() }
      : { kind: "quota_exhausted" };
  }
  if (CLAUDE_QUOTA_EXHAUSTED_TEXT.some((pattern) => pattern.test(text))) return { kind: "quota_exhausted" };
  return { kind: "transient_rate_limit" };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The fields of a Claude `stream_event` row the send-intent scan reads; everything is checked before use. */
interface ClaudeStreamEvent {
  type?: unknown;
  index?: unknown;
  content_block?: { type?: unknown; id?: unknown; name?: unknown } | null;
  delta?: { type?: unknown; partial_json?: unknown } | null;
}

function finiteString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const PROVIDER_QUOTA_STATUSES = new Set(["allowed", "allowed_warning", "rejected"]);
const PROVIDER_QUOTA_RATE_LIMIT_TYPES: ReadonlySet<string> = new Set<ProviderQuotaRateLimitType>([
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_overage_included",
  "overage",
]);
/** The furthest ahead a reported reset is believed; later (or millisecond-scale) values are not resets. */
export const PROVIDER_QUOTA_MAX_RESET_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Read the top-level fields of a Claude Code `rate_limit_event.rate_limit_info`
 * (2.1.317 schema: `status`, `utilization`, `surpassedThreshold`,
 * `rateLimitType`, `resetsAt` in epoch seconds). Anything without a known
 * `status` is not a reading; fields of the wrong type are dropped, and so is
 * a `resetsAt` beyond the coming year (a past one is kept: that window already reset).
 */
export function parseClaudeRateLimitInfo(info: unknown, nowMs: number): ProviderQuotaObservation | undefined {
  if (!info || typeof info !== "object" || Array.isArray(info)) return undefined;
  const fields = info as Record<string, unknown>;
  const status = fields.status;
  if (typeof status !== "string" || !PROVIDER_QUOTA_STATUSES.has(status)) return undefined;
  const utilization = finiteNumber(fields.utilization);
  const surpassedThreshold = finiteNumber(fields.surpassedThreshold);
  const rateLimitType = typeof fields.rateLimitType === "string" && PROVIDER_QUOTA_RATE_LIMIT_TYPES.has(fields.rateLimitType)
    ? fields.rateLimitType as ProviderQuotaRateLimitType
    : undefined;
  const resetsAtSec = finiteNumber(fields.resetsAt);
  const resetsAtMs = resetsAtSec !== undefined ? resetsAtSec * 1000 : undefined;
  // A past reset is kept (that window has already reset, so the store expires
  // the reading at once); one beyond the coming year is not a reset.
  const plausibleReset = resetsAtMs !== undefined && resetsAtMs > 0 && resetsAtMs < nowMs + PROVIDER_QUOTA_MAX_RESET_AHEAD_MS;
  return {
    status: status as ProviderQuotaObservation["status"],
    ...(utilization !== undefined && utilization >= 0 ? { utilization } : {}),
    ...(surpassedThreshold !== undefined && surpassedThreshold >= 0 ? { surpassedThreshold } : {}),
    ...(rateLimitType ? { rateLimitType } : {}),
    ...(plausibleReset ? { resetsAtMs } : {}),
  };
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

/** input + cache read + cache write of one request's `usage`: the context that request carried; null when absent. */
function claudeRequestContextTokens(usage: unknown): number | null {
  if (!usage || typeof usage !== "object") return null;
  const record = usage as Record<string, unknown>;
  const parts = [record.input_tokens, record.cache_read_input_tokens, record.cache_creation_input_tokens].map(finiteNumber);
  if (parts.every((part) => part === undefined)) return null;
  return parts.reduce<number>((sum, part) => sum + (part ?? 0), 0);
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
  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  private currentSession: string | null = null;
  private lastRateLimit: ClaudeRateLimitObservation | null = null;
  // task #379: set when this turn's assistant message already reported a
  // runtime-declared API error, so the turn's `result` does not count it twice.
  private turnApiErrorReported = false;
  /**
   * #proj-runtime:#54: the context the main agent's last model request carried
   * (input + cache read + cache write of that request's `usage`). The result's
   * usage is summed over every request of the turn, so it can't tell how big
   * the context is now; this one can.
   */
  private lastRequestContextTokens: number | null = null;
  /** task #25 step 2: the daemon asked to interrupt this turn; its failed result is the interrupt, not an error. */
  private interruptRequested = false;
  /**
   * Agent typing line: the main agent's streaming `tool_use` blocks by content
   * index (`content_block_start` names the id; `input_json_delta` carries the
   * arguments), reset by each `message_start`.
   */
  private streamingToolUseIds = new Map<number, string>();
  private readonly sendIntentScanner = new SendIntentArgumentScanner();
  /**
   * The kind `task_started` named for each task that is not a sub-agent: its
   * progress and notification envelopes name no `task_type`. Forgotten at the
   * task's notification.
   */
  private readonly nonAgentTasks = new Map<string, "command" | "other">();

  noteInterruptRequested(): void {
    this.interruptRequested = true;
  }

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
      if (eventSessionId !== this.currentSession) {
        // task #379: rate-limit observations and per-turn error state belong
        // to one session; another session must not inherit them.
        this.lastRateLimit = null;
        this.turnApiErrorReported = false;
      }
      this.currentSession = eventSessionId;
    }

    const pushResultError = (message: Record<string, any>, fallback: string) => {
      const providerError = message.is_error === true ? claudeProviderError(message) : undefined;
      events.push({ kind: "error", message: collectResultErrorDetail(message, fallback), ...(providerError ? { providerError } : {}) });
    };

    switch (event.type) {
      case "rate_limit_event": {
        const info = event.rate_limit_info && typeof event.rate_limit_info === "object"
          ? event.rate_limit_info
          : {};
        const status = finiteString(info.status);
        if (status) this.lastRateLimit = { status, resetsAtSec: finiteNumber(info.resetsAt) };
        const providerQuota = parseClaudeRateLimitInfo(event.rate_limit_info, this.nowMs());
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
          ...(providerQuota ? { providerQuota } : {}),
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
            const taskId = finiteString(event.task_id);
            const namedKind = taskKindFromType(event.task_type);
            const taskKind = namedKind ?? (taskId ? this.nonAgentTasks.get(taskId) : undefined);
            if (taskId && phase === "started" && (taskKind === "command" || taskKind === "other")) this.nonAgentTasks.set(taskId, taskKind);
            // Forgotten only at the end the daemon takes as one (a closed status).
            if (taskId && phase === "notification" && taskNotificationStatus(event.status)) this.nonAgentTasks.delete(taskId);
            events.push({
              kind: "subagent_progress",
              source: "claude_task_lifecycle",
              phase,
              ...(taskKind ? { taskKind } : {}),
              ...(finiteString(event.task_id) ? { taskId: finiteString(event.task_id)! } : {}),
              // `system` task-lifecycle envelopes carry the outer Agent tool id
              // as `tool_use_id`; belt-and-suspenders fall back to
              // `parent_tool_use_id` in case a Claude version names it that way
              // on the envelope (confirmed field name = tool_use_id, @Huarong).
              ...(finiteString(event.tool_use_id) ?? finiteString(event.parent_tool_use_id)
                ? { parentToolUseId: (finiteString(event.tool_use_id) ?? finiteString(event.parent_tool_use_id))! }
                : {}),
              ...(finiteString(event.subagent_type) ? { subagentType: finiteString(event.subagent_type)! } : {}),
              ...(phase === "notification" && taskNotificationStatus(event.status) ? { taskStatus: taskNotificationStatus(event.status)! } : {}),
              ...(finiteString(event.last_tool_name) ? { lastToolName: finiteString(event.last_tool_name)! } : {}),
              payloadBytes: Buffer.byteLength(line, "utf8"),
            });
          }
        }
        break;

      case "stream_event": {
        events.push({
          kind: "internal_progress",
          source: "claude_stream_event",
          itemType: typeof event.event?.type === "string" && event.event.type.length > 0
            ? event.event.type
            : "unknown",
          payloadBytes: Buffer.byteLength(line, "utf8"),
        });
        const sendIntent = this.scanStreamEventForSendIntent(event);
        if (sendIntent) events.push(sendIntent);
        break;
      }

      case "assistant": {
        const content = event.message?.content;
        // Inner subagent assistant rows carry EXPLICIT lineage; preserve it on
        // the emitted content events so the daemon marks them as subagent
        // activity (APM 1.6 6b). Absent lineage → flat, ordinary events.
        const subagent = extractSubagentLineage(event);
        if (!subagent) {
          const requestContext = claudeRequestContextTokens(event.message?.usage);
          if (requestContext !== null) this.lastRequestContextTokens = requestContext;
        }
        const withLineage = subagent ? { subagent } : {};
        if (Array.isArray(content)) {
          const hasToolUse = content.some((block) => block?.type === "tool_use");
          // task #379: Claude Code marks an assistant message that wraps an
          // API error (usage limit, auth, overload, ...) with a top-level SDK
          // `error` field; its text is a CLI-generated notice, not model
          // output, so it must not count as runtime progress.
          const sdkError = !hasToolUse && !subagent && typeof event.error === "string" && event.error
            ? event.error
            : null;
          const accountProblem = sdkError ? classifyClaudeAccountProblem(claudeApiErrorCodes(event)) : null;
          const providerError = sdkError ? claudeProviderError(event) : undefined;
          for (const block of content) {
            if (block.type === "thinking" && block.thinking) {
              events.push({ kind: "thinking", text: block.thinking, ...withLineage });
            } else if (block.type === "text" && block.text) {
              if (accountProblem) {
                if (this.turnApiErrorReported) continue;
                this.turnApiErrorReported = true;
                events.push({
                  kind: "error",
                  message: CREDENTIAL_PROBLEM_MESSAGES[accountProblem],
                  nativeReasonPresent: true,
                  reasonProvenance: "runtime_error_event",
                  ...(providerError ? { providerError } : {}),
                });
              } else if (sdkError) {
                const providerLimit = classifyClaudeProviderLimit(sdkError, block.text, this.lastRateLimit, this.nowMs());
                this.turnApiErrorReported = true;
                events.push({
                  kind: "error",
                  message: block.text,
                  nativeReasonPresent: true,
                  reasonProvenance: "runtime_error_event",
                  ...(providerLimit ? { providerLimit } : {}),
                  ...(providerError ? { providerError } : {}),
                });
              } else if (isProviderApiFailureText(block.text, hasToolUse)) {
                events.push({ kind: "error", message: block.text });
              } else {
                events.push({ kind: "text", text: block.text, ...withLineage });
              }
            } else if (block.type === "tool_use") {
              events.push({
                kind: "tool_call",
                name: block.name || "unknown_tool",
                input: block.input,
                ...(typeof block.id === "string" && block.id ? { callId: block.id } : {}),
                ...withLineage,
              });
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
              events.push({
                kind: "tool_output",
                name: block.name || block.tool_use_id || "tool_result",
                ...(typeof block.tool_use_id === "string" && block.tool_use_id ? { callId: block.tool_use_id } : {}),
                ...claudeToolResultOutcome(block),
                ...withLineage,
              });
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
        if (usageTelemetry && this.lastRequestContextTokens !== null && usageTelemetry.kind === "telemetry") {
          usageTelemetry.attrs.lastRequestContextTokens = this.lastRequestContextTokens;
        }
        const isMaxTokenError = stopReason === "max_tokens" &&
          (event.is_error === true || subtype !== "success");
        // task #379: the assistant message already reported this turn's API
        // error; the generic result failure is the same fact, not a second one.
        const apiErrorAlreadyReported = this.turnApiErrorReported;
        this.turnApiErrorReported = false;
        const interrupted = this.interruptRequested && subtype !== "success";
        this.interruptRequested = false;
        if (interrupted) {
          if (usageTelemetry) events.push(usageTelemetry);
          events.push({ kind: "turn_end", sessionId: resultSessionId || undefined, interrupted: true });
          break;
        }

        // #proj-raft-computer:#68: a result whose typed API error is an
        // account problem, with no assistant line before it: the same fixed text.
        const resultAccountProblem = event.is_error === true && !apiErrorAlreadyReported
          ? classifyClaudeAccountProblem(claudeApiErrorCodes(event))
          : null;
        const resultProviderError = resultAccountProblem ? claudeProviderError(event) : undefined;
        switch (subtype) {
          case "success":
            if (resultAccountProblem) {
              events.push({
                kind: "error",
                message: CREDENTIAL_PROBLEM_MESSAGES[resultAccountProblem],
                nativeReasonPresent: true,
                reasonProvenance: "runtime_error_event",
                ...(resultProviderError ? { providerError: resultProviderError } : {}),
              });
            } else if (event.is_error && !apiErrorAlreadyReported) {
              pushResultError(event, "Execution failed");
            }
            break;

          case "error_during_execution":
            if ((stopReason !== "max_tokens" || isMaxTokenError) && !apiErrorAlreadyReported) {
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

  /**
   * Agent typing line: a `raft message send` target in the main agent's
   * streaming Bash arguments. A subagent's stream (explicit
   * `parent_tool_use_id`) is not the agent speaking for itself and is skipped.
   */
  private scanStreamEventForSendIntent(row: Record<string, unknown>): Extract<ParsedEvent, { kind: "send_intent" }> | null {
    if (extractSubagentLineage(row)) return null;
    const streamEvent = row.event as ClaudeStreamEvent | null | undefined;
    if (!streamEvent || typeof streamEvent !== "object") return null;
    switch (streamEvent.type) {
      case "message_start":
        this.streamingToolUseIds.clear();
        return null;
      case "content_block_start": {
        const block = streamEvent.content_block;
        if (typeof streamEvent.index !== "number" || block?.type !== "tool_use") return null;
        const id = finiteString(block.id);
        if (!id) return null;
        this.streamingToolUseIds.set(streamEvent.index, id);
        // Registers the name; an input already present at start is `{}`.
        return this.sendIntentScanner.append(id, finiteString(block.name), undefined);
      }
      case "content_block_delta": {
        const delta = streamEvent.delta;
        if (typeof streamEvent.index !== "number" || delta?.type !== "input_json_delta") return null;
        const id = this.streamingToolUseIds.get(streamEvent.index);
        if (!id || typeof delta.partial_json !== "string") return null;
        return this.sendIntentScanner.append(id, undefined, delta.partial_json);
      }
      case "content_block_stop":
        if (typeof streamEvent.index === "number") this.streamingToolUseIds.delete(streamEvent.index);
        return null;
      default:
        return null;
    }
  }
}

/**
 * Whether a tool_result means the tool call itself failed. Claude Code reports
 * a Bash command that exited non-zero as `is_error: true` with the content
 * starting "Exit code N": the command ran, so that is `ok: true` with the exit
 * code. Any other error result is a failed call.
 *
 * FRAGILE: Claude Code has no structured exit code on tool_result, so this
 * matches its text. If the wording changes, every non-zero Bash exit falls back
 * to `ok: false` (a run with failing tests would show as failed steps). The
 * format is pinned by the "Exit code N format" test in
 * claudeEventNormalizer.test.ts; update both together.
 */
export function claudeToolResultOutcome(block: { is_error?: unknown; content?: unknown }): { ok?: boolean; exitCode?: number } {
  // `is_error` defaults to false in the Messages API.
  if (block.is_error !== true) return { ok: true };
  const text = typeof block.content === "string"
    ? block.content
    : Array.isArray(block.content)
      ? block.content.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("")
      : "";
  const exit = /^Exit code (\d+)\b/.exec(text);
  return exit ? { ok: true, exitCode: Number(exit[1]) } : { ok: false };
}
