import type { ParsedEvent } from "./types";

export type JsonRpcId = number | string;

export interface JsonRpcMessage {
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, any>;
  result?: Record<string, any>;
  error?: { message?: string };
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

function boundedString(value: unknown, limit = 1_000): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit - 1)}…`;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function codexMessageThreadId(message: JsonRpcMessage): string | undefined {
  return nonEmptyString(message.params?.threadId)
    ?? nonEmptyString(message.params?.thread?.id)
    ?? nonEmptyString(message.params?.sessionId);
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

function codexThreadStatusChangedDiagnostics(
  message: JsonRpcMessage,
): Extract<ParsedEvent, { kind: "runtime_diagnostic" }>[] {
  if (message.method !== "thread/status/changed") return [];
  const params = message.params ?? {};
  const status = params.status ?? params.thread?.status;
  if (!status || typeof status !== "object") return [];

  const statusType = nonEmptyString(status.type);
  const sessionId = codexMessageThreadId(message);
  if (statusType === "systemError") {
    const explicitReason = boundedString(status.message)
      ?? boundedString(status.error?.message)
      ?? getCodexNotificationErrorMessage(params);
    if (explicitReason) return [];
    return [{
      kind: "runtime_diagnostic",
      severity: "warning",
      source: "codex_app_server_notification",
      itemType: "codex_thread_system_error_without_reason",
      message: "Codex thread entered system error state without a reason",
      payloadBytes: payloadBytes(params),
      reasonPresent: false,
      ...(sessionId ? { sessionId } : {}),
    }];
  }

  if (statusType !== "active" || !Array.isArray(status.activeFlags)) return [];
  const activeFlags = (status.activeFlags as unknown[])
    .filter((flag): flag is string => typeof flag === "string");
  const waitFlags = activeFlags.filter((flag) =>
    flag === "waitingOnApproval" || flag === "waitingOnUserInput");
  if (waitFlags.length === 0) return [];
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

/**
 * The warnings one app-server notification carries (`configWarning`, `warning`,
 * `guardianWarning`, `deprecationNotice`, a thread waiting on approval or
 * input, a system error without a reason), extracted from OAR raw frames by
 * `agentHost/oarCodexActivity.ts`. A system error's turn failure reaches the
 * host as the turn's own outcome.
 */
export function codexNotificationDiagnostics(
  method: string,
  params: unknown,
): Extract<ParsedEvent, { kind: "runtime_diagnostic" }>[] {
  const message: JsonRpcMessage = { method, params: params && typeof params === "object" ? params as JsonRpcMessage["params"] : {} };
  const diagnostic = codexNotificationDiagnosticEvent(message);
  if (diagnostic) return [diagnostic];
  return codexThreadStatusChangedDiagnostics(message);
}

export function codexMcpToolName(item: Record<string, any>): string {
  const tool = nonEmptyString(item.tool) ?? "unknown";
  const server = nonEmptyString(item.server);
  return server ? `mcp_${server}_${tool}` : `mcp_${tool}`;
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
export function codexBlankFinalAnswerDiagnostic(
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
