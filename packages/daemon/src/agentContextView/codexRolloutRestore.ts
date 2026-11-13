import type { AgentContextView, AgentContextViewDaemonFailureReason } from "@botiverse/raft-shared";
import { compactionOf, findSendCall, holdsSendResult, projectResponses, reportsMessage, textOfOutput, withToolNames } from "./piRequestRestore";

/**
 * View Context: restores from a Codex rollout (its session JSONL) the request
 * in flight when a Raft message was sent. Checked against real requests on Codex
 * 0.167.0 with a catalog model: a turn's `input` is the rollout's `response_item`s
 * so far, without `internal_chat_message_metadata_passthrough`; a `compacted`
 * record's `replacement_history` replaces them. The first item is the
 * `additional_tools` that hold the tool list, and the instructions are
 * developer messages.
 *
 * A rollout has no hash of the request, so a view is never `verified`: its source
 * says it was rebuilt. A reply with no send of this message means it isn't this
 * request (as Kimi's): refused. One with no `additional_tools` (an older Codex, or a model
 * outside its catalog, whose tools go top-level and aren't kept) can't say what
 * tools the model had, so it's refused rather than shown without them.
 */

type Obj = Record<string, unknown>;

interface Located {
  item: Obj;
  /** The record's time. */
  at: string | null;
}

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What the model produced, as against what it was given. Named narrowly: this is
 * Codex's internal format, and an item we don't know belongs with what it was
 * given (`agent_message`, `configuration_update`), not in a reply that hides it.
 */
function isReplyItem(item: Obj): boolean {
  if (item.type === "message" || typeof item.role === "string") return item.role === "assistant";
  return item.type === "reasoning" || (typeof item.type === "string" && item.type.endsWith("_call"));
}

function isResultItem(item: Obj): boolean {
  return typeof item.type === "string" && item.type.endsWith("_output");
}

function usageOf(record: Obj): AgentContextView["tokens"] | null {
  const payload = isObj(record.payload) ? record.payload : {};
  const usage = isObj(payload.usage) ? payload.usage : null;
  if (!usage) return null;
  const count = (value: unknown) => (typeof value === "number" ? value : null);
  return { input: count(usage.input_tokens), cacheRead: count(usage.cached_input_tokens), total: count(usage.total_tokens) };
}

export type CodexRestoreResult =
  | { ok: true; view: AgentContextView; responseFound: boolean }
  | { ok: false; failure: AgentContextViewDaemonFailureReason; refusal: string };

export interface CodexRestoreInput {
  buffer: Buffer;
  /** The rollout's length when the message was sent; null finds the send's result in the file. */
  offset: number | null;
  messageId: string;
  runtime: string;
  sessionId: string;
}

function cleanItem(value: Obj): Obj {
  const { internal_chat_message_metadata_passthrough: _internal, ...item } = value;
  return item;
}

function recordsOf(buffer: Buffer): { record: Obj; end: number }[] {
  const records: { record: Obj; end: number }[] = [];
  let start = 0;
  while (start < buffer.length) {
    const newline = buffer.indexOf(0x0a, start);
    const end = newline === -1 ? buffer.length : newline + 1;
    let record: unknown = null;
    try {
      record = JSON.parse(buffer.toString("utf8", start, end));
    } catch {
      // A line Codex was still writing.
    }
    if (isObj(record)) records.push({ record, end });
    start = end;
  }
  return records;
}

export function restoreCodexContextView(input: CodexRestoreInput): CodexRestoreResult {
  let offset = input.offset;
  if (offset === null) {
    const found = input.buffer.indexOf(Buffer.from(`Message ID: ${input.messageId}`, "utf8"));
    if (found === -1) return { ok: false, failure: "not_found", refusal: "not_in_session" };
    offset = found;
  }
  if (offset > input.buffer.length) return { ok: false, failure: "not_found", refusal: "offset_past_end" };

  const records = recordsOf(input.buffer);
  let history: Located[] = [];
  let compaction: AgentContextView["compaction"] = { happened: false };
  let usages: { historyLength: number; tokens: AgentContextView["tokens"] }[] = [];
  let model: string | null = null;
  let cliVersion: string | null = null;
  let next = 0;
  for (; next < records.length && records[next]!.end <= offset; next += 1) {
    const { record } = records[next]!;
    const payload = isObj(record.payload) ? record.payload : {};
    const at = typeof record.timestamp === "string" ? record.timestamp : null;
    if (record.type === "session_meta" && typeof payload.cli_version === "string") cliVersion = payload.cli_version;
    if (record.type === "turn_context" && typeof payload.model === "string") model = payload.model;
    if (record.type === "response_item") history.push({ item: cleanItem(payload), at });
    if (record.type === "token_usage_record") {
      const tokens = usageOf(record);
      if (tokens) usages.push({ historyLength: history.length, tokens });
    }
    if (record.type === "compacted") {
      usages = [];
      compaction = typeof payload.message === "string" && payload.message
        ? { happened: true, summary: { kind: "text", text: payload.message } }
        : { happened: true, summary: null };
      const replacement = Array.isArray(payload.replacement_history) ? payload.replacement_history.filter(isObj) : [];
      history = replacement.map((item) => ({ item: cleanItem(item), at }));
    }
    // What a rollback removes isn't written here to follow: a refusal, not a guess.
    if (record.type === "event_msg" && payload.type === "thread_rolled_back") {
      return { ok: false, failure: "context_mismatch", refusal: "rolled_back" };
    }
  }
  if (history.length === 0) return { ok: false, failure: "not_found", refusal: "no_request" };
  if (!history.some(({ item }) => item.type === "additional_tools")) {
    return { ok: false, failure: "unsupported_runtime", refusal: "no_additional_tools" };
  }

  // The offset came after the send's result: the request is the one before that call.
  const reported = history.findIndex(({ item }) => isResultItem(item) && reportsMessage(textOfOutput(item.output), input.messageId));
  let requestEnd = reported === -1 ? history.length : reported;
  while (reported !== -1 && requestEnd > 0 && isResultItem(history[requestEnd - 1]!.item)) requestEnd -= 1;
  // The offset can fall inside the reply: the request is what came before it.
  while (requestEnd > 0 && isReplyItem(history[requestEnd - 1]!.item)) requestEnd -= 1;
  const requestItems = history.slice(0, requestEnd).map(({ item }) => item);
  const projected = projectResponses({}, requestItems);

  // What follows, up to the next compaction: the rest of the reply and its results.
  const after: Obj[] = history.slice(requestEnd).map(({ item }) => item);
  let tokens = usages.find((usage) => usage.historyLength > requestEnd)?.tokens ?? null;
  for (let i = next; i < records.length; i += 1) {
    const { record } = records[i]!;
    const payload = isObj(record.payload) ? record.payload : {};
    if (record.type === "compacted") break;
    if (record.type === "response_item") after.push(cleanItem(payload));
    if (record.type === "token_usage_record" && tokens === null) tokens = usageOf(record);
  }

  const replyCount = (() => {
    const index = after.findIndex((item) => !isReplyItem(item));
    return index === -1 ? after.length : index;
  })();
  const whole = projectResponses({}, [...requestItems, ...after]);
  const count = projected.messages.length;
  const replied = replyCount > 0 && whole.messages[count]?.role === "assistant";
  const messages = withToolNames(whole.messages);
  const shown = replied ? messages.slice(0, count + 1) : messages.slice(0, count);
  const trigger = replied ? findSendCall(messages, count, messages.slice(count + 1), input.messageId) : null;
  // A reply that didn't send it, and nothing here reports it: a sub-agent's send lands on the root
  // thread's rollout, and this isn't its request. One reported later (a script that printed it after a
  // yield, a retry answered with the same id) is this thread's, with no one call to point at.
  if (replied && !trigger && !holdsSendResult(messages.slice(count + 1), input.messageId)) {
    return { ok: false, failure: "not_found", refusal: "no_send_call" };
  }

  const last = history[requestEnd - 1];
  // Remote compaction leaves ciphertext in the history, and no text in the record.
  const inline = compactionOf(projected.messages);
  return {
    ok: true,
    responseFound: replied,
    view: {
      runtime: input.runtime,
      model,
      sessionId: input.sessionId,
      requestAt: last?.at ?? null,
      messageId: input.messageId,
      tokens: tokens ?? { input: null, cacheRead: null, total: null },
      system: projected.system,
      tools: projected.tools,
      messages: shown,
      compaction: compaction.happened && compaction.summary !== null ? compaction : inline.happened ? inline : compaction,
      trigger,
      redactions: {},
      source: { kind: "native", format: "codex-rollout", version: cliVersion },
    },
  };
}
