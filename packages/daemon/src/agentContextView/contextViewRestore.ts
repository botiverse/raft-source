import { answerAgentContextQuery, type AgentContextQuery, type AgentContextViewDaemonFailureReason, type AgentContextViewTooLargeCause } from "@botiverse/raft-shared";
import { ClaudeSessionIndex, findClaudeSendOffset, parseClaudeSessionRecords, restoreClaudeContextView } from "./claudeSessionRestore";
import { redactContextView, totalRedactions } from "./contextViewRedaction";
import { serializeContextViewResult } from "./contextViewResultPost";
import { readContextViewSource } from "./contextViewSource";
import { restoreCodexContextView } from "./codexRolloutRestore";
import { type KimiRequestRebuilder, restoreKimiContextView } from "./kimiSessionRestore";
import { isPiRequestLogRuntime } from "./piRequestLog";
import { restorePiContextView } from "./piRequestRestore";

/** What one restore needs: plain data, because it crosses into the restore's child process. */
export interface ContextViewRestoreRequest {
  runtime: string;
  file: string;
  allowedRoots: readonly string[];
  /** Byte length of the file when the message was sent; null when the message has no index line. */
  offset: number | null;
  messageId: string;
  sessionId: string;
  /** Cap on the serialized result body. */
  maxBytes: number;
  /** An agent's search or read: the answer is entries of the view, never the view itself. */
  query?: AgentContextQuery;
}

export type ContextViewRestoreOutcome = "ok" | AgentContextViewDaemonFailureReason;

export interface ContextViewRestored {
  /** The result body, serialized as it will be posted. */
  json: string;
  outcome: ContextViewRestoreOutcome;
  /** Trace attributes: low cardinality, no content or paths. */
  attrs: Record<string, unknown>;
}

/** What the viewer is told of a `too_large`, by its `failure_detail`. */
const TOO_LARGE_CAUSES: Readonly<Record<string, AgentContextViewTooLargeCause>> = {
  source_too_large: "session_file",
  view_over_max_bytes: "request",
  view_over_runtime_limit: "request",
  answer_over_max_bytes: "request",
  restore_child_output_over_cap: "request",
  restore_child_out_of_memory: "restore_limit",
  too_many_context_records: "restore_limit",
};

export function contextViewRestoreFailure(reason: AgentContextViewDaemonFailureReason, detail: string, attrs: Record<string, unknown> = {}): ContextViewRestored {
  return {
    json: serializeContextViewResult({ ok: false, reason, ...(reason === "too_large" && TOO_LARGE_CAUSES[detail] ? { tooLargeCause: TOO_LARGE_CAUSES[detail] } : {}) }),
    outcome: reason,
    attrs: { ...attrs, failure_detail: detail },
  };
}

function restoredView(context: ReturnType<typeof redactContextView>, maxBytes: number, attrs: Record<string, unknown>): ContextViewRestored {
  const json = serializeContextViewResult({ ok: true, context });
  const bytes = Buffer.byteLength(json, "utf8");
  const measured = {
    ...attrs,
    message_count: context.messages.length,
    trigger_found: context.trigger !== null,
    redactions_total: totalRedactions(context.redactions),
    ...Object.fromEntries(Object.entries(context.redactions).map(([kind, n]) => [`redacted_${kind}`, n])),
    view_bytes: bytes,
  };
  if (bytes > maxBytes) return contextViewRestoreFailure("too_large", "view_over_max_bytes", measured);
  return { json, outcome: "ok", attrs: measured };
}

/** An agent's search or read of the redacted view; the view itself never leaves. */
function answeredQuery(context: ReturnType<typeof redactContextView>, query: AgentContextQuery, maxBytes: number, attrs: Record<string, unknown>): ContextViewRestored {
  const body = answerAgentContextQuery(context, query);
  const json = JSON.stringify(body);
  const bytes = Buffer.byteLength(json, "utf8");
  const measured = {
    ...attrs,
    query_kind: query.kind,
    entry_count: body.entryCount,
    ...(body.answer.kind === "search" ? { match_total: body.answer.total, match_shown: body.answer.matches.length } : {}),
    ...(body.answer.kind === "read" ? { entry_found: body.answer.found, ...(body.answer.found ? { entries_omitted: body.answer.omitted } : {}) } : {}),
    answer_bytes: bytes,
  };
  if (bytes > maxBytes) return contextViewRestoreFailure("too_large", "answer_over_max_bytes", measured);
  return { json, outcome: "ok", attrs: measured };
}

async function loadSdkRebuild(): Promise<KimiRequestRebuilder> {
  const { loadKimiSdk } = await import("../drivers/index");
  return (await loadKimiSdk()).rebuildLastLlmRequest as KimiRequestRebuilder;
}

/** Reads a session file and restores the context of one sent message, redacted and serialized. */
export async function restoreContextViewSource(
  request: ContextViewRestoreRequest,
  loadKimiRebuild: () => Promise<KimiRequestRebuilder> = loadSdkRebuild,
): Promise<ContextViewRestored> {
  const { runtime, messageId, sessionId, maxBytes } = request;
  const finish: typeof restoredView = (context, cap, attrs) =>
    request.query ? answeredQuery(context, request.query, cap, attrs) : restoredView(context, cap, attrs);
  const read = await readContextViewSource(request.file, request.allowedRoots);
  if (!read.ok) {
    // Over the source cap is not a read error: a retry fails the same way.
    const reason = read.failure === "missing" ? "not_found" : read.failure === "too_large" ? "too_large" : "read_failed";
    return contextViewRestoreFailure(reason, `source_${read.failure}`);
  }
  const source_bytes = read.buffer.length;

  if (runtime === "kimi-sdk") {
    const restored = restoreKimiContextView({
      buffer: read.buffer,
      offset: request.offset,
      messageId,
      runtime,
      sessionId,
      rebuild: await loadKimiRebuild(),
    });
    if (!restored.ok) return contextViewRestoreFailure(restored.failure, restored.refusal, { source_bytes });
    const context = redactContextView(restored.view);
    return finish(context, maxBytes, { source_bytes, verification: context.verification, response_found: restored.responseFound });
  }

  if (runtime === "codex") {
    const restored = restoreCodexContextView({ buffer: read.buffer, offset: request.offset, messageId, runtime, sessionId });
    if (!restored.ok) return contextViewRestoreFailure(restored.failure, restored.refusal, { source_bytes });
    return finish(redactContextView(restored.view), maxBytes, { source_bytes, response_found: restored.responseFound });
  }

  if (isPiRequestLogRuntime(runtime)) {
    if (request.offset === null) return contextViewRestoreFailure("not_found", "no_index_line", { source_bytes });
    const restored = restorePiContextView({ buffer: read.buffer, offset: request.offset, messageId, runtime, sessionId });
    if (!restored.ok) return contextViewRestoreFailure(restored.failure, restored.refusal, { source_bytes });
    const context = redactContextView(restored.view);
    return finish(context, maxBytes, { source_bytes, verification: context.verification, response_found: restored.responseFound, provider_api: restored.api });
  }

  const offset = request.offset ?? findClaudeSendOffset(read.buffer, messageId);
  if (offset === null) return contextViewRestoreFailure("not_found", "not_in_session", { source_bytes });
  const index = new ClaudeSessionIndex(parseClaudeSessionRecords(read.buffer));
  const restored = restoreClaudeContextView({ index, offset, messageId, runtime, sessionId });
  if (!restored.ok) {
    return contextViewRestoreFailure(restored.failure === "no_request" ? "not_found" : "read_failed", restored.failure, { source_bytes });
  }
  return finish(redactContextView(restored.view), maxBytes, {
    source_bytes,
    digest_match: restored.digestMatch,
    response_found: restored.responseFound,
    unrestored_message_count: restored.unrestoredMessages,
  });
}
