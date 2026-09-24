import type { ParsedEvent, RuntimeTurnAttribution } from "./types.js";

export type GrokJsonRpcId = number | string;

export interface GrokJsonRpcMessage {
  jsonrpc?: string;
  id?: GrokJsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface GrokPromptCompletion {
  stopReason?: unknown;
  promptId?: unknown;
  agentResult?: unknown;
  usage?: unknown;
}

interface ToolState {
  name: string;
  arguments: string;
  callEmitted: boolean;
  outputEmitted: boolean;
}

const TERMINAL_TOOL_STATUSES = new Set(["completed", "failed", "cancelled"]);
// Grok mints this prompt-id family for background-task completions that begin
// inside the runtime after the daemon-originated prompt has already finished.
// Since no daemon request exists for that successor, it has no generation to
// join until its terminal notification arrives.
const GROK_AUTONOMOUS_SUCCESSOR_PROMPT_PREFIX = "task-completed-call-";

export function parseGrokJsonRpcLine(line: string): GrokJsonRpcMessage | null {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as GrokJsonRpcMessage
      : null;
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function payloadBytes(value: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return undefined;
  }
}

function internalProgress(itemType: string, payload: unknown): Extract<ParsedEvent, { kind: "internal_progress" }> {
  return {
    kind: "internal_progress",
    source: "grok_acp_notification",
    itemType,
    payloadBytes: payloadBytes(payload),
  };
}

function toolName(update: Record<string, unknown>, fallback = "tool"): string {
  const meta = recordValue(update._meta);
  const tool = recordValue(meta?.["x.ai/tool"]);
  return nonEmptyString(tool?.name)
    ?? nonEmptyString(update.name)
    ?? nonEmptyString(update.title)
    ?? fallback;
}

function parseAccumulatedArguments(value: string): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return { arguments: value };
  }
}

function numericUsageAttrs(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const mappings = [
    ["inputTokens", "input_tokens"],
    ["outputTokens", "output_tokens"],
    ["totalTokens", "total_tokens"],
    ["cachedReadTokens", "cached_read_tokens"],
    ["reasoningTokens", "reasoning_tokens"],
    ["modelCalls", "model_calls"],
    ["apiDurationMs", "api_duration_ms"],
    ["numTurns", "num_turns"],
  ] as const;
  const attrs: Record<string, number> = {};
  for (const [wireKey, attrKey] of mappings) {
    const candidate = source[wireKey];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      attrs[attrKey] = candidate;
    }
  }
  return attrs;
}

export class GrokEventNormalizer {
  private sessionIdValue: string | null = null;
  private nextTurnGeneration = 0;
  private activeTurnGeneration: number | null = null;
  private lastCompletedTurnGeneration: number | null = null;
  private completedTurnGenerations = new Set<number>();
  private generationByPromptId = new Map<string, number>();
  private promptIdsByGeneration = new Map<number, Set<string>>();
  private completedAutonomousSuccessorPromptIds = new Set<string>();
  private toolCalls = new Map<string, ToolState>();
  private toolCallIdsByIndex = new Map<number, string>();

  reset(): void {
    this.sessionIdValue = null;
    this.nextTurnGeneration = 0;
    this.activeTurnGeneration = null;
    this.lastCompletedTurnGeneration = null;
    this.completedTurnGenerations.clear();
    this.generationByPromptId.clear();
    this.promptIdsByGeneration.clear();
    this.completedAutonomousSuccessorPromptIds.clear();
    this.toolCalls.clear();
    this.toolCallIdsByIndex.clear();
  }

  get sessionId(): string | null {
    return this.sessionIdValue;
  }

  get canSteerBusy(): boolean {
    return this.activeTurnGeneration !== null;
  }

  adoptSession(sessionId: string): void {
    this.sessionIdValue = sessionId;
  }

  beginPrompt(): number {
    this.nextTurnGeneration += 1;
    this.activeTurnGeneration = this.nextTurnGeneration;
    this.toolCalls.clear();
    this.toolCallIdsByIndex.clear();
    return this.nextTurnGeneration;
  }

  abortPrompt(generation: number): void {
    if (this.activeTurnGeneration === generation) {
      this.activeTurnGeneration = null;
    }
    this.forgetPromptIdsForGeneration(generation);
  }

  normalizeNotification(message: GrokJsonRpcMessage): ParsedEvent[] {
    const params = message.params ?? {};
    const notificationSessionId = nonEmptyString(params.sessionId);
    if (notificationSessionId) {
      if (!this.sessionIdValue || notificationSessionId !== this.sessionIdValue) return [];
    }

    const update = recordValue(params.update);
    if (!update) {
      return message.method ? [internalProgress(message.method, params)] : [];
    }

    const updateKind = nonEmptyString(update.sessionUpdate);
    if (!updateKind) return [internalProgress(message.method ?? "session/update", update)];

    switch (updateKind) {
      case "agent_message_chunk": {
        const content = recordValue(update.content);
        const text = content?.type === "text" ? content.text : null;
        return typeof text === "string" && text.length > 0
          ? [{
              kind: "text",
              text,
              ...this.runtimeTurnAttributionPatch(),
            }]
          : [internalProgress(updateKind, update)];
      }

      case "agent_thought_chunk": {
        const content = recordValue(update.content);
        const text = content?.type === "text" ? content.text : null;
        return typeof text === "string" && text.length > 0
          ? [{
              kind: "thinking",
              text,
              ...this.runtimeTurnAttributionPatch(),
            }]
          : [internalProgress(updateKind, update)];
      }

      case "tool_call_delta_chunk": {
        const index = typeof update.tool_index === "number" ? update.tool_index : null;
        const wireId = nonEmptyString(update.tool_call_id);
        if (index !== null && wireId) this.toolCallIdsByIndex.set(index, wireId);
        const toolCallId = wireId ?? (index !== null ? this.toolCallIdsByIndex.get(index) ?? null : null);
        if (toolCallId) {
          const existing = this.toolCalls.get(toolCallId) ?? {
            name: toolName(update),
            arguments: "",
            callEmitted: false,
            outputEmitted: false,
          };
          existing.name = toolName(update, existing.name);
          if (typeof update.arguments_delta === "string") {
            existing.arguments += update.arguments_delta;
          }
          this.toolCalls.set(toolCallId, existing);
        }
        return [internalProgress(updateKind, update)];
      }

      case "tool_call": {
        const toolCallId = nonEmptyString(update.toolCallId) ?? `anonymous-${this.toolCalls.size + 1}`;
        const existing = this.toolCalls.get(toolCallId) ?? {
          name: toolName(update),
          arguments: "",
          callEmitted: false,
          outputEmitted: false,
        };
        existing.name = toolName(update, existing.name);
        this.toolCalls.set(toolCallId, existing);
        if (existing.callEmitted) return [internalProgress(updateKind, update)];
        existing.callEmitted = true;
        return [{
          kind: "tool_call",
          name: existing.name,
          input: update.rawInput ?? parseAccumulatedArguments(existing.arguments),
        }];
      }

      case "tool_call_update": {
        const toolCallId = nonEmptyString(update.toolCallId);
        const status = nonEmptyString(update.status);
        if (!toolCallId || !status || !TERMINAL_TOOL_STATUSES.has(status)) {
          return [internalProgress(updateKind, update)];
        }
        const existing = this.toolCalls.get(toolCallId) ?? {
          name: toolName(update),
          arguments: "",
          callEmitted: false,
          outputEmitted: false,
        };
        this.toolCalls.set(toolCallId, existing);
        if (existing.outputEmitted) return [internalProgress(updateKind, update)];
        existing.outputEmitted = true;
        return [{ kind: "tool_output", name: existing.name }];
      }

      case "pending_interaction":
      case "interaction_resolved":
        // Grok broadcasts this pair around blocking reverse requests. Raft
        // launches Grok in non-interactive always-approve mode, so permission
        // requests normally resolve immediately; unsupported interactive
        // requests are rejected separately by the JSON-RPC client. Neither
        // lifecycle notification is itself an actionable user warning.
        return [internalProgress(updateKind, update)];

      case "turn_completed": {
        const promptId = nonEmptyString(update.prompt_id);
        if (promptId?.startsWith(GROK_AUTONOMOUS_SUCCESSOR_PROMPT_PREFIX)) {
          if (this.completedAutonomousSuccessorPromptIds.has(promptId)) return [];
          this.rememberAutonomousSuccessorCompletion(promptId);
          // A background completion is not the terminal for a newer
          // daemon-originated foreground turn. The foreground terminal will
          // publish the eventual Idle transition, so only synthesize a turn
          // when no active generation can be closed accidentally.
          if (this.activeTurnGeneration !== null) return [];
        }
        const generation = promptId
          ? this.generationByPromptId.get(promptId)
            ?? this.activeTurnGeneration
            ?? this.beginAutonomousSuccessorCompletion(promptId)
          : this.activeTurnGeneration;
        return this.finishPrompt(generation, {
          stopReason: update.stop_reason,
          promptId,
          agentResult: update.agent_result,
          usage: update.usage,
        });
      }

      default:
        return [internalProgress(updateKind, update)];
    }
  }

  finishPrompt(generation: number | null | undefined, completion: GrokPromptCompletion): ParsedEvent[] {
    if (generation === null || generation === undefined) return [];
    const promptId = nonEmptyString(completion.promptId) ?? undefined;
    if (promptId) this.rememberPromptGeneration(promptId, generation);
    if (this.completedTurnGenerations.has(generation)) return [];
    this.completedTurnGenerations.add(generation);
    this.lastCompletedTurnGeneration = generation;
    if (this.completedTurnGenerations.size > 32) {
      const oldest = this.completedTurnGenerations.values().next().value;
      if (oldest !== undefined) {
        this.completedTurnGenerations.delete(oldest);
        this.forgetPromptIdsForGeneration(oldest);
      }
    }
    if (this.activeTurnGeneration === generation) {
      this.activeTurnGeneration = null;
    }

    const stopReason = nonEmptyString(completion.stopReason) ?? "unknown";
    const agentResult = nonEmptyString(completion.agentResult);
    const events: ParsedEvent[] = [];
    const usageAttrs = numericUsageAttrs(completion.usage);
    if (Object.keys(usageAttrs).length > 0) {
      events.push({
        kind: "telemetry",
        name: "token_usage",
        source: "grok_acp",
        usageKind: "per_turn",
        ...(this.sessionIdValue ? { sessionId: this.sessionIdValue } : {}),
        ...(promptId ? { turnId: promptId } : {}),
        attrs: usageAttrs,
      });
    }
    if (stopReason === "error") {
      events.push({ kind: "error", message: agentResult ?? "Grok Build turn failed" });
    } else if (stopReason === "cancelled") {
      events.push({ kind: "error", message: agentResult ?? "Grok Build turn was cancelled" });
    }
    events.push({ kind: "turn_end", ...(this.sessionIdValue ? { sessionId: this.sessionIdValue } : {}) });
    this.toolCalls.clear();
    this.toolCallIdsByIndex.clear();
    return events;
  }

  private rememberPromptGeneration(promptId: string, generation: number): void {
    const existingGeneration = this.generationByPromptId.get(promptId);
    if (existingGeneration !== undefined) return;

    this.generationByPromptId.set(promptId, generation);
    const promptIds = this.promptIdsByGeneration.get(generation) ?? new Set<string>();
    promptIds.add(promptId);
    this.promptIdsByGeneration.set(generation, promptIds);
  }

  private beginAutonomousSuccessorCompletion(promptId: string): number | null {
    if (!promptId.startsWith(GROK_AUTONOMOUS_SUCCESSOR_PROMPT_PREFIX)) return null;
    this.nextTurnGeneration += 1;
    this.rememberPromptGeneration(promptId, this.nextTurnGeneration);
    return this.nextTurnGeneration;
  }

  private rememberAutonomousSuccessorCompletion(promptId: string): void {
    this.completedAutonomousSuccessorPromptIds.add(promptId);
    if (this.completedAutonomousSuccessorPromptIds.size <= 32) return;
    const oldest = this.completedAutonomousSuccessorPromptIds.values().next().value;
    if (oldest !== undefined) this.completedAutonomousSuccessorPromptIds.delete(oldest);
  }

  private runtimeTurnAttributionPatch(): { runtimeTurn?: RuntimeTurnAttribution } {
    if (this.activeTurnGeneration !== null) {
      return {
        runtimeTurn: {
          generation: this.activeTurnGeneration,
          state: "active",
        },
      };
    }
    if (this.lastCompletedTurnGeneration !== null) {
      return {
        runtimeTurn: {
          generation: this.lastCompletedTurnGeneration,
          state: "completed",
        },
      };
    }
    return {};
  }

  private forgetPromptIdsForGeneration(generation: number): void {
    const promptIds = this.promptIdsByGeneration.get(generation);
    if (!promptIds) return;
    for (const promptId of promptIds) {
      if (this.generationByPromptId.get(promptId) === generation) {
        this.generationByPromptId.delete(promptId);
      }
    }
    this.promptIdsByGeneration.delete(generation);
  }
}
