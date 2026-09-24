import type { ParsedEvent } from "./types.js";
import { RuntimeTurnState } from "../runtimeTurnState.js";
import { parseCodexTelemetryEvent } from "./codexTelemetrySidecar.js";

export type JsonRpcId = number | string;

export interface JsonRpcMessage {
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, any>;
  result?: Record<string, any>;
  error?: { message?: string };
}

export interface CodexEventNormalizerResult {
  events: ParsedEvent[];
  threadReady?: string;
  turnStarted?: boolean;
}

export function parseCodexJsonRpcLine(line: string): JsonRpcMessage | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function getCodexNotificationErrorMessage(params: Record<string, any> | undefined): string | null {
  const topLevelMessage = params?.message;
  if (typeof topLevelMessage === "string" && topLevelMessage.trim()) {
    return topLevelMessage;
  }

  const nestedMessage = params?.error?.message;
  if (typeof nestedMessage === "string" && nestedMessage.trim()) {
    return nestedMessage;
  }

  return null;
}

function payloadBytes(value: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return undefined;
  }
}

function codexNotificationProgressEvent(
  itemType: string,
  payload?: unknown,
): Extract<ParsedEvent, { kind: "internal_progress" }> {
  return {
    kind: "internal_progress",
    source: "codex_app_server_notification",
    itemType,
    payloadBytes: payload === undefined ? undefined : payloadBytes(payload),
  };
}

function boundedString(value: unknown, limit = 1_000): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit - 1)}…`;
}

function codexNotificationDiagnosticEvent(
  message: JsonRpcMessage,
): Extract<ParsedEvent, { kind: "runtime_diagnostic" }> | null {
  const params = message.params ?? {};
  let diagnosticMessage: string | undefined;
  let details: string | undefined;

  switch (message.method) {
    case "configWarning":
      diagnosticMessage =
        boundedString(params.summary) ?? boundedString(params.details) ?? "Codex configuration warning";
      details = boundedString(params.details);
      break;
    case "warning":
      diagnosticMessage = boundedString(params.message) ?? "Codex warning";
      break;
    case "guardianWarning":
      diagnosticMessage = boundedString(params.message) ?? "Codex guardian warning";
      break;
    case "deprecationNotice":
      diagnosticMessage =
        boundedString(params.summary) ?? boundedString(params.details) ?? "Codex deprecation notice";
      details = boundedString(params.details);
      break;
    default:
      return null;
  }

  const sessionId = codexMessageThreadId(message);
  const path = boundedString(params.path);
  return {
    kind: "runtime_diagnostic",
    severity: "warning",
    source: "codex_app_server_notification",
    itemType: message.method,
    message: diagnosticMessage,
    ...(details ? { details } : {}),
    ...(path ? { path } : {}),
    ...(params.range !== undefined ? { range: params.range } : {}),
    payloadBytes: payloadBytes(params),
    ...(sessionId ? { sessionId } : {}),
  };
}

function codexThreadStatusChangedEvents(message: JsonRpcMessage): ParsedEvent[] | null {
  if (message.method !== "thread/status/changed") return null;
  const params = message.params ?? {};
  const status = params.status ?? params.thread?.status;
  if (!status || typeof status !== "object") return null;

  const statusType = nonEmptyString(status.type);
  const sessionId = codexMessageThreadId(message);
  if (statusType === "systemError") {
    const explicitReason = boundedString(status.message)
      ?? boundedString(status.error?.message)
      ?? getCodexNotificationErrorMessage(params);
    const statusMessage = explicitReason ?? "Codex thread entered system error state";
    const errorEvent: ParsedEvent = {
      kind: "error",
      message: statusMessage,
      nativeReasonPresent: Boolean(explicitReason),
      reasonProvenance: explicitReason ? "codex_native_reason" : "daemon_fallback",
    };
    if (explicitReason) return [errorEvent];
    return [
      {
        kind: "runtime_diagnostic",
        severity: "warning",
        source: "codex_app_server_notification",
        itemType: "codex_thread_system_error_without_reason",
        message: "Codex thread entered system error state without a reason",
        payloadBytes: payloadBytes(params),
        reasonPresent: false,
        ...(sessionId ? { sessionId } : {}),
      },
      errorEvent,
    ];
  }

  if (statusType !== "active" || !Array.isArray(status.activeFlags)) return null;
  const activeFlags = (status.activeFlags as unknown[])
    .filter((flag): flag is string => typeof flag === "string");
  const waitFlags = activeFlags.filter((flag) =>
    flag === "waitingOnApproval" || flag === "waitingOnUserInput");
  if (waitFlags.length === 0) return null;
  const waitLabel = waitFlags.includes("waitingOnApproval") && waitFlags.includes("waitingOnUserInput")
    ? "approval and user input"
    : waitFlags.includes("waitingOnApproval")
      ? "approval"
      : "user input";
  return [{
    kind: "runtime_diagnostic",
    severity: "warning",
    source: "codex_app_server_notification",
    itemType: "thread/status/changed",
    message: `Codex thread is waiting on ${waitLabel}`,
    details: `Active flags: ${waitFlags.join(", ")}`,
    payloadBytes: payloadBytes(params),
    ...(sessionId ? { sessionId } : {}),
  }];
}

function joinReasoningSummaryText(item: Record<string, any>): string {
  const summary = Array.isArray(item.summary) ? item.summary.filter((entry) => typeof entry === "string") : [];
  return summary.join("\n").trim();
}

function rawResponseItemProgressEvent(message: JsonRpcMessage): ParsedEvent | null {
  if (message.method !== "rawResponseItem/completed") return null;
  const item = message.params?.item ?? message.params?.responseItem ?? message.params?.rawItem ?? message.params;
  if (!item || typeof item !== "object") return null;

  const itemType = typeof item.type === "string" ? item.type : undefined;
  return {
    kind: "internal_progress",
    source: "codex_raw_response_item",
    itemType,
    payloadBytes: payloadBytes(item),
  };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function rawCodexCliErrorEvent(message: JsonRpcMessage): ParsedEvent | null {
  const rawMessage = objectRecord(message);
  const rawType = nonEmptyString(rawMessage?.type);
  if (rawType !== "error" && rawType !== "turn.failed" && rawType !== "result_error") return null;

  const directMessage = boundedString(rawMessage?.message);
  const nestedMessage = boundedString(objectRecord(rawMessage?.error)?.message);
  return {
    kind: "error",
    message: directMessage ?? nestedMessage ?? "Codex runtime failed",
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function codexMcpToolName(item: Record<string, any>): string {
  const tool = nonEmptyString(item.tool) ?? "unknown";
  const server = nonEmptyString(item.server);
  return server ? `mcp_${server}_${tool}` : `mcp_${tool}`;
}

function codexMessageThreadId(message: JsonRpcMessage): string | undefined {
  return nonEmptyString(message.params?.threadId)
    ?? nonEmptyString(message.params?.thread?.id)
    ?? nonEmptyString(message.params?.sessionId);
}

function codexAgentMessagePhase(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function codexAgentMessageDeltaPhase(message: JsonRpcMessage): string | null {
  return codexAgentMessagePhase(message.params?.phase)
    ?? codexAgentMessagePhase(message.params?.item?.phase);
}

function isUserVisibleAgentMessagePhase(phase: string | null): boolean {
  // A missing phase means "phase unknown", not "commentary". The app-server
  // protocol says so outright: providers do not emit it consistently, so legacy
  // models must keep their user-visible behavior.
  return phase === null || phase === "final_answer";
}

/**
 * Blank has two shapes on the wire and both have to count: the field can be
 * absent, or present and made only of whitespace. Codex terminates turns with a
 * whitespace-only `final_answer` routinely — in trace bundle `0cf75ab0`, 78 of
 * 79 turns ended that way — so treating only the absent case as blank would
 * miss almost every real occurrence.
 */
function isBlankAgentMessageText(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

/**
 * The turn produced assistant text, but nothing user-visible reached the user.
 *
 * This is deliberately a report and not a repair. The carrier has no eligible
 * text to fall back on: `task_complete.last_agent_message` is a Codex rollout
 * field that the app-server protocol never sends, and `turn/completed` arrives
 * with `items: []` / `itemsView: "notLoaded"` in practice. Recovering the text
 * would mean promoting commentary, which is a separate product decision. So v1
 * converts a silent blank delivery into one typed, visible fact.
 */
function codexBlankFinalAnswerDiagnostic(
  sessionId: string | null,
): Extract<ParsedEvent, { kind: "runtime_diagnostic" }> {
  return {
    kind: "runtime_diagnostic",
    severity: "warning",
    source: "codex_app_server_notification",
    itemType: "codex_blank_final_answer",
    message: "Codex ended the turn without a user-visible answer",
    details:
      "The runtime produced assistant output during this turn but its final answer was blank, "
      + "so nothing was delivered. The turn's work is not lost; ask the agent to restate its answer.",
    ...(sessionId ? { sessionId } : {}),
  };
}

function codexSuppressedAgentMessageEvent(
  itemType: string,
  phase: string | null,
  text: string,
  itemId?: unknown,
): Extract<ParsedEvent, { kind: "internal_progress" }> {
  return codexNotificationProgressEvent(itemType, {
    ...(typeof itemId === "string" ? { itemId } : {}),
    ...(phase ? { phase } : {}),
    bytes: Buffer.byteLength(text, "utf8"),
  });
}

export class CodexEventNormalizer {
  private currentThreadId: string | null = null;
  private sessionAnnounced = false;
  private streamedAgentMessageIds = new Set<string>();
  private agentMessagePhases = new Map<string, string | null>();
  private streamedReasoningIds = new Set<string>();
  private fileChangeToolCallCounts = new Map<string, number>();
  private turnState = new RuntimeTurnState();
  /**
   * Leading whitespace of a user-visible message that has not produced any
   * visible character yet. Held rather than dropped: once real text arrives it
   * is released verbatim, so a streamed answer keeps its exact bytes. If the
   * message ends without ever producing a visible character, the buffer is
   * discarded and the user is never handed a blank.
   */
  private pendingAgentMessageWhitespace = new Map<string, string>();
  /** Message ids that have already delivered at least one visible character. */
  private visibleAgentMessageIds = new Set<string>();
  /** Any non-blank assistant text this turn, including suppressed commentary. */
  private turnSawAssistantText = false;
  /** Any non-blank user-visible text actually delivered this turn. */
  private turnDeliveredVisibleText = false;

  reset(opts: { threadId?: string | null } = {}) {
    this.currentThreadId = opts.threadId ?? null;
    this.turnState.reset();
    this.sessionAnnounced = false;
    this.streamedAgentMessageIds.clear();
    this.agentMessagePhases.clear();
    this.streamedReasoningIds.clear();
    this.fileChangeToolCallCounts.clear();
    this.resetTurnDeliveryState();
  }

  /**
   * Turn-scoped delivery bookkeeping. Cleared on both turn boundaries so a turn
   * is always judged on its own evidence: an earlier turn's text must never
   * make a later blank turn look answered, and a later turn must never inherit
   * an earlier turn's report.
   */
  private resetTurnDeliveryState() {
    this.pendingAgentMessageWhitespace.clear();
    this.visibleAgentMessageIds.clear();
    this.turnSawAssistantText = false;
    this.turnDeliveredVisibleText = false;
  }

  /**
   * Decides what of `text` may reach the user for one message, and records what
   * that means for the turn. Returns the exact string to deliver, or null when
   * nothing may be delivered yet.
   */
  private admitAgentMessageText(itemId: string | undefined, text: string): string | null {
    if (!isBlankAgentMessageText(text)) this.turnSawAssistantText = true;

    // Without an item id there is nothing to buffer against; fall back to the
    // message-level judgement so a blank still cannot reach the user.
    if (typeof itemId !== "string") {
      if (isBlankAgentMessageText(text)) return null;
      this.turnDeliveredVisibleText = true;
      return text;
    }

    if (this.visibleAgentMessageIds.has(itemId)) {
      // The answer has already begun; interior whitespace is ordinary text.
      return text;
    }

    if (isBlankAgentMessageText(text)) {
      this.pendingAgentMessageWhitespace.set(
        itemId,
        (this.pendingAgentMessageWhitespace.get(itemId) ?? "") + text,
      );
      return null;
    }

    const held = this.pendingAgentMessageWhitespace.get(itemId) ?? "";
    this.pendingAgentMessageWhitespace.delete(itemId);
    this.visibleAgentMessageIds.add(itemId);
    this.turnDeliveredVisibleText = true;
    return held + text;
  }

  private forgetAgentMessage(itemId: string) {
    this.pendingAgentMessageWhitespace.delete(itemId);
    this.visibleAgentMessageIds.delete(itemId);
  }

  get threadId(): string | null {
    return this.currentThreadId;
  }

  get activeTurnId(): string | null {
    return this.turnState.activeTurnId;
  }

  get canSteerBusy(): boolean {
    return this.turnState.canSteerBusy;
  }

  markNonEmptyTurnInput(turnId: string | null | undefined): void {
    this.turnState.markNonEmptyInputForTurn(turnId);
  }

  adoptThreadId(threadId: string) {
    this.currentThreadId = threadId;
  }

  normalizeMessage(message: JsonRpcMessage): CodexEventNormalizerResult {
    const events: ParsedEvent[] = [];

    const rawCliError = rawCodexCliErrorEvent(message);
    if (rawCliError) {
      events.push(rawCliError);
      return { events };
    }

    if (message.result) {
      const thread = message.result.thread;
      if (thread && typeof thread.id === "string") {
        return this.handleThreadReady(thread.id, events);
      }

      const turn = message.result.turn;
      if (turn && typeof turn.id === "string") {
        this.turnState.noteTurnAccepted(turn.id);
        return { events };
      }

      if (typeof message.result.turnId === "string") {
        this.turnState.noteTurnAccepted(message.result.turnId);
        return { events };
      }
    }

    if (message.error) {
      events.push({ kind: "error", message: message.error.message || "Codex app-server request failed" });
      return { events };
    }

    if (this.isSecondaryThreadId(codexMessageThreadId(message))) {
      return { events };
    }

    const telemetry = parseCodexTelemetryEvent(message);
    if (telemetry) {
      if (telemetry.kind === "telemetry" && telemetry.name === "token_usage") {
        this.turnState.markTokenUsage();
      }
      const telemetrySessionId = codexMessageThreadId(message);
      const telemetryTurnId = nonEmptyString(message.params?.turnId)
        ?? nonEmptyString(message.params?.turn?.id);
      if (telemetrySessionId) {
        this.currentThreadId = telemetrySessionId;
      }
      const sessionId = telemetrySessionId ?? this.currentThreadId ?? undefined;
      const turnId = telemetryTurnId ?? this.turnState.activeTurnId ?? undefined;
      events.push({
        ...telemetry,
        ...(sessionId ? { sessionId } : {}),
        ...(turnId ? { turnId } : {}),
      });
      return { events };
    }

    const rawProgress = rawResponseItemProgressEvent(message);
    if (rawProgress) {
      this.turnState.markProgress();
      events.push(rawProgress);
      return { events };
    }

    switch (message.method) {
      case "thread/started": {
        const threadId = message.params?.thread?.id;
        if (typeof threadId === "string") {
          return this.handleThreadReady(threadId, events);
        }
        break;
      }

      case "turn/started": {
        const turnId = message.params?.turn?.id;
        this.turnState.markTurnStarted(typeof turnId === "string" ? turnId : null);
        this.resetTurnDeliveryState();
        events.push({ kind: "thinking", text: "" });
        return { events, turnStarted: true };
      }

      case "item/agentMessage/delta": {
        const delta = message.params?.delta;
        const itemId = message.params?.itemId;
        const phase = codexAgentMessageDeltaPhase(message)
          ?? (typeof itemId === "string" ? this.agentMessagePhases.get(itemId) ?? null : null);
        if (typeof itemId === "string") {
          this.streamedAgentMessageIds.add(itemId);
        }
        if (typeof delta === "string" && delta.length > 0) {
          this.turnState.markProgress();
          if (isUserVisibleAgentMessagePhase(phase)) {
            const deliverable = this.admitAgentMessageText(itemId, delta);
            if (deliverable !== null) events.push({ kind: "text", text: deliverable });
          } else {
            if (!isBlankAgentMessageText(delta)) this.turnSawAssistantText = true;
            events.push(codexSuppressedAgentMessageEvent("agent_message_non_final_delta", phase, delta, itemId));
          }
        }
        break;
      }

      case "item/reasoning/summaryTextDelta": {
        const delta = message.params?.delta;
        const itemId = message.params?.itemId;
        if (typeof itemId === "string") {
          this.streamedReasoningIds.add(itemId);
        }
        if (typeof delta === "string" && delta.length > 0) {
          this.turnState.markProgress();
          events.push({ kind: "thinking", text: delta });
        }
        break;
      }

      case "item/reasoning/textDelta": {
        const delta = message.params?.delta;
        if (typeof delta === "string" && delta.length > 0) {
          this.turnState.markProgress();
          events.push(codexNotificationProgressEvent("reasoning_text_delta", {
            itemId: message.params?.itemId,
            bytes: Buffer.byteLength(delta, "utf8"),
          }));
        }
        break;
      }

      case "item/commandExecution/outputDelta":
      case "item/mcpToolCall/progress":
      case "item/plan/delta":
      case "turn/plan/updated":
      case "turn/diff/updated":
      case "item/fileChange/patchUpdated":
      case "item/fileChange/outputDelta":
      case "command/exec/outputDelta":
      case "process/outputDelta":
      case "process/exited": {
        this.turnState.markProgress();
        events.push(codexNotificationProgressEvent(message.method, message.params));
        break;
      }

      case "configWarning":
      case "warning":
      case "guardianWarning":
      case "deprecationNotice": {
        const diagnostic = codexNotificationDiagnosticEvent(message);
        if (diagnostic) {
          events.push(diagnostic);
        }
        break;
      }

      case "thread/status/changed": {
        const statusEvents = codexThreadStatusChangedEvents(message);
        if (statusEvents) {
          events.push(...statusEvents);
        }
        break;
      }

      case "item/started":
      case "item/completed": {
        const item = message.params?.item;
        if (!item || typeof item !== "object" || typeof item.type !== "string") break;
        const itemType = item.type;
        const isStarted = message.method === "item/started";
        const isCompleted = message.method === "item/completed";

        switch (itemType) {
          case "reasoning":
            if (isCompleted && typeof item.id === "string" && !this.streamedReasoningIds.has(item.id)) {
              const text = joinReasoningSummaryText(item);
              if (text) {
                this.turnState.markProgress();
                events.push({ kind: "thinking", text });
              }
            }
            if (isCompleted && typeof item.id === "string") {
              this.streamedReasoningIds.delete(item.id);
            }
            break;

          case "agentMessage":
            if ((isStarted || isCompleted) && typeof item.id === "string") {
              this.agentMessagePhases.set(item.id, codexAgentMessagePhase(item.phase));
            }
            if (isCompleted && typeof item.id === "string" && !this.streamedAgentMessageIds.has(item.id) && typeof item.text === "string" && item.text.length > 0) {
              const phase = codexAgentMessagePhase(item.phase);
              this.turnState.markProgress();
              if (isUserVisibleAgentMessagePhase(phase)) {
                const deliverable = this.admitAgentMessageText(item.id, item.text);
                if (deliverable !== null) events.push({ kind: "text", text: deliverable });
              } else {
                if (!isBlankAgentMessageText(item.text)) this.turnSawAssistantText = true;
                events.push(codexSuppressedAgentMessageEvent("agent_message_non_final_completed", phase, item.text, item.id));
              }
            }
            if (isCompleted && typeof item.id === "string") {
              this.streamedAgentMessageIds.delete(item.id);
              this.agentMessagePhases.delete(item.id);
              this.forgetAgentMessage(item.id);
            }
            break;

          case "commandExecution":
            if (isStarted && typeof item.command === "string") {
              this.turnState.markProgress();
              events.push({ kind: "tool_call", name: "shell", input: { command: item.command } });
            }
            if (isCompleted) {
              events.push({ kind: "tool_output", name: "shell" });
              this.turnState.markToolBoundary();
            }
            break;

          case "contextCompaction":
            if (isStarted) {
              this.turnState.markProgress();
              events.push({ kind: "compaction_started" });
            }
            if (isCompleted) {
              this.turnState.markProgress();
              events.push({ kind: "compaction_finished" });
            }
            break;

          case "enteredReviewMode":
            if (isStarted) {
              this.turnState.markProgress();
              events.push({ kind: "review_started" });
            }
            break;

          case "exitedReviewMode":
            if (isCompleted) {
              this.turnState.markProgress();
              events.push({ kind: "review_finished" });
            }
            break;

          case "fileChange":
            if (isStarted && Array.isArray(item.changes)) {
              let outputCount = 0;
              for (const change of item.changes) {
                this.turnState.markProgress();
                events.push({
                  kind: "tool_call",
                  name: "file_change",
                  input: { path: change?.path, kind: change?.kind },
                });
                outputCount += 1;
              }
              if (outputCount > 0 && typeof item.id === "string") {
                this.fileChangeToolCallCounts.set(item.id, outputCount);
              }
            }
            if (isCompleted) {
              let outputCount = 0;
              if (typeof item.id === "string") {
                outputCount = this.fileChangeToolCallCounts.get(item.id) ?? 0;
                this.fileChangeToolCallCounts.delete(item.id);
              }
              if (outputCount === 0 && Array.isArray(item.changes)) {
                outputCount = item.changes.length;
              }
              for (let index = 0; index < outputCount; index += 1) {
                events.push({ kind: "tool_output", name: "file_change" });
              }
              if (outputCount > 0) {
                this.turnState.markToolBoundary();
              }
            }
            break;

          case "mcpToolCall":
            if (isStarted) {
              const toolName = codexMcpToolName(item);
              this.turnState.markProgress();
              events.push({ kind: "tool_call", name: toolName, input: item.arguments });
            }
            if (isCompleted) {
              const toolName = codexMcpToolName(item);
              events.push({ kind: "tool_output", name: toolName });
              this.turnState.markToolBoundary();
            }
            break;

          case "collabAgentToolCall":
            if (isStarted) {
              this.turnState.markProgress();
              events.push({ kind: "tool_call", name: "collab_tool_call", input: { tool: item.tool, prompt: item.prompt } });
            }
            if (isCompleted) {
              events.push({ kind: "tool_output", name: "collab_tool_call" });
              this.turnState.markToolBoundary();
            }
            break;

          case "webSearch":
            if (isStarted) {
              this.turnState.markProgress();
              events.push({ kind: "tool_call", name: "web_search", input: { query: item.query } });
            }
            if (isCompleted) {
              events.push({ kind: "tool_output", name: "web_search" });
              this.turnState.markToolBoundary();
            }
            break;
        }
        break;
      }

      case "turn/completed": {
        const turn = message.params?.turn;
        if (turn?.status === "failed") {
          events.push({ kind: "error", message: turn.error?.message || "Codex turn failed" });
        }
        if (turn?.status === "interrupted") {
          const detail = typeof turn?.error?.message === "string" && turn.error.message.length > 0
            ? `: ${turn.error.message}`
            : "";
          events.push({ kind: "error", message: `Codex turn interrupted${detail}` });
        }
        if (turn?.status === "completed" && this.turnState.completedWithoutRuntimeActivity()) {
          const inputEvidence = this.turnState.hasNonEmptyInputEvidence() ? "nonempty" : "unknown";
          const diagnosticMessage =
            "Codex runtime completed an empty turn with no output, progress, or token usage";
          const userMessage = inputEvidence === "nonempty"
            ? "Codex runtime returned an empty response. Please retry."
            : "Codex runtime completed without a response. Please retry.";
          events.push({
            kind: "runtime_diagnostic",
            severity: "warning",
            source: "codex_app_server_notification",
            itemType: "codex_zero_evidence_turn_completed",
            message: diagnosticMessage,
            details:
              "Codex runtime reported turn/completed status=completed after turn/started with no assistant text, reasoning text, tool activity, internal progress, raw response-item progress, or valid thread/tokenUsage/updated payload.",
            payloadBytes: payloadBytes(message.params),
            inputEvidence,
            ...(this.currentThreadId ? { sessionId: this.currentThreadId } : {}),
          });
          events.push({
            kind: "error",
            message: `${userMessage} (codex_zero_evidence_turn_completed)`,
          });
        }
        // A turn that produced assistant text but delivered none of it to the
        // user is the #816 defect. Report it once, here, where the turn is
        // known to be over. A turn that produced nothing at all is not this
        // defect — tool-only turns are legitimately silent (44 of the 79 turns
        // in the specimen) and must stay that way.
        if (this.turnSawAssistantText && !this.turnDeliveredVisibleText) {
          events.push(codexBlankFinalAnswerDiagnostic(this.currentThreadId));
        }

        this.turnState.markTurnCompleted();
        this.streamedAgentMessageIds.clear();
        this.streamedReasoningIds.clear();
        this.fileChangeToolCallCounts.clear();
        this.resetTurnDeliveryState();
        events.push({ kind: "turn_end", sessionId: this.currentThreadId || undefined });
        break;
      }

      case "error":
        if (message.params?.willRetry === true) {
          this.turnState.markProgress();
          events.push(codexNotificationProgressEvent("retryable_error", message.params));
        } else {
          events.push({
            kind: "error",
            message: getCodexNotificationErrorMessage(message.params) || "Unknown Codex app-server error",
          });
        }
        break;
    }

    return { events };
  }

  private isSecondaryThreadId(threadId: string | undefined): boolean {
    return Boolean(threadId && this.currentThreadId && threadId !== this.currentThreadId);
  }

  private handleThreadReady(threadId: string, events: ParsedEvent[]): CodexEventNormalizerResult {
    this.currentThreadId = threadId;
    if (!this.sessionAnnounced) {
      events.push({ kind: "session_init", sessionId: threadId });
      this.sessionAnnounced = true;
    }
    return { events, threadReady: threadId };
  }
}
