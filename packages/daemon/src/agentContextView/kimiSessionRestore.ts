import type {
  AgentContextView,
  AgentContextViewCompaction,
  AgentContextViewDaemonFailureReason,
  AgentContextViewMessage,
  AgentContextViewPart,
  AgentContextViewTokens,
  AgentContextViewVerification,
} from "@botiverse/raft-shared";
import type { LlmRequestRebuildRefusal } from "@botiverse/kimi-code-sdk";
import type { JsonValue } from "@botiverse/raft-shared";
import { findContextViewTrigger, SEND_COMMAND_RE } from "./claudeSessionRestore";

/**
 * View Context: restore, from a kimi-sdk session's `wire.jsonl`, the one model
 * request that produced a Raft message.
 *
 * The rebuild itself is the SDK's (`rebuildLastLlmRequest`, our Kimi fork): the
 * same folds and projection that built the real request, with the checks it
 * records. This file picks the records to hand it and turns its answer into an
 * AgentContextView. A check that fails is a refusal, never a best guess.
 */

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One wire record, as the SDK's rebuild takes it. */
export type KimiWireRecord = { type: string; [key: string]: unknown };

type KimiContentPart = { type: string; [key: string]: unknown };
type KimiToolCall = { id: string; name?: string; arguments?: string | null };

export interface KimiRebuiltMessage {
  role: string;
  content: readonly KimiContentPart[];
  toolCalls?: readonly KimiToolCall[];
  toolCallId?: string;
}

/** The part of the SDK's `LlmRequestRebuild` this reader uses. */
export type KimiRequestRebuild =
  | {
      status: "rebuilt";
      verification: AgentContextViewVerification;
      request: { model: string };
      protocolVersion?: string;
      systemPrompt: string;
      tools: readonly { name: string; description: string; parameters: Record<string, unknown> }[];
      messages: readonly KimiRebuiltMessage[];
      response?: KimiRebuiltMessage;
    }
  | { status: "refused"; reason: string; detail: string };

export type KimiRequestRebuilder = (records: Iterable<KimiWireRecord>) => KimiRequestRebuild;

function parseWireRecord(line: string): KimiWireRecord | null {
  try {
    const record: unknown = JSON.parse(line);
    return isObj(record) && typeof record.type === "string" ? (record as KimiWireRecord) : null;
  } catch {
    return null;
  }
}

/** Stands in for a line that is not a record: no fold reads it. */
const UNREADABLE_LINE: KimiWireRecord = { type: "raft.unreadable_line" };

/**
 * The file's whole lines, as records; a torn last line is left out. A bad line
 * keeps its place, because the wire's branch records refer to line numbers.
 */
export function parseKimiWireRecords(buffer: Buffer): KimiWireRecord[] {
  const records: KimiWireRecord[] = [];
  let start = 0;
  while (start < buffer.length) {
    const end = buffer.indexOf(0x0a, start);
    if (end < 0) break;
    records.push(parseWireRecord(buffer.toString("utf8", start, end)) ?? UNREADABLE_LINE);
    start = end + 1;
  }
  return records;
}

function toolResultCallId(record: KimiWireRecord | null): string | null {
  if (record?.type !== "context.append_loop_event" || !isObj(record.event)) return null;
  if (record.event.type !== "tool.result") return null;
  return typeof record.event.toolCallId === "string" ? record.event.toolCallId : null;
}

function lineAt(buffer: Buffer, at: number): { start: number; record: KimiWireRecord | null } {
  const start = buffer.lastIndexOf(0x0a, at) + 1;
  const end = buffer.indexOf(0x0a, at);
  return { start, record: end < 0 ? null : parseWireRecord(buffer.toString("utf8", start, end)) };
}

/** The `tool.call` record for an id, searched back from `before`, with where its line starts. */
function findToolCall(buffer: Buffer, toolCallId: string, before: number): { start: number; event: Obj } | null {
  const needle = Buffer.from(`"toolCallId":${JSON.stringify(toolCallId)}`, "utf8");
  let at = buffer.lastIndexOf(needle, before);
  while (at >= 0) {
    const { start, record } = lineAt(buffer, at);
    if (record?.type === "context.append_loop_event" && isObj(record.event) && record.event.type === "tool.call") {
      return { start, event: record.event };
    }
    at = at === 0 ? -1 : buffer.lastIndexOf(needle, at - 1);
  }
  return null;
}

function shellCommand(event: Obj): string | null {
  const command = isObj(event.args) ? event.args.command : undefined;
  return typeof command === "string" ? command : null;
}

export interface KimiSendRecord {
  /** Where the tool result reporting the message starts: the request that made the call is the last one before it. */
  offset: number;
  toolCallId: string;
}

/**
 * The tool result of the call that sent the message: it reports
 * `Message ID: <messageId>`, and its call is a send, or was already running when
 * the message was indexed and is a shell command (a script around the CLI). A
 * later output that only quotes the id (a `cat` of a log) is neither, and nor is
 * the parent's `Agent` call around a sub-agent's send, whose final text quotes it.
 */
export function findKimiSendRecord(buffer: Buffer, messageId: string, indexOffset: number | null = null): KimiSendRecord | null {
  const needle = Buffer.from(`Message ID: ${messageId}`, "utf8");
  let at = buffer.indexOf(needle);
  while (at >= 0) {
    const next = buffer[at + needle.length];
    if (next === undefined || !/[A-Za-z0-9_-]/.test(String.fromCharCode(next))) {
      const { start, record } = lineAt(buffer, at);
      const toolCallId = toolResultCallId(record);
      if (toolCallId) {
        const call = findToolCall(buffer, toolCallId, start);
        const command = call ? shellCommand(call.event) : null;
        if (call && command !== null && (SEND_COMMAND_RE.test(command) || (indexOffset !== null && call.start < indexOffset))) {
          return { offset: start, toolCallId };
        }
      }
    }
    at = buffer.indexOf(needle, at + needle.length);
  }
  return null;
}

const DATA_URL_RE = /^data:([^;,]+)?(;base64)?,/;

function mediaUrl(part: KimiContentPart): string | null {
  const media = part.imageUrl ?? part.audioUrl ?? part.videoUrl;
  const url = isObj(media) ? media.url : undefined;
  return typeof url === "string" ? url : null;
}

function imagePart(part: KimiContentPart): AgentContextViewPart {
  const url = mediaUrl(part);
  const match = url ? DATA_URL_RE.exec(url) : null;
  if (!url || !match) return { kind: "image", mediaType: null, sizeBytes: null };
  const payload = url.length - match[0].length;
  return {
    kind: "image",
    mediaType: match[1] ?? null,
    sizeBytes: match[2] ? Math.floor((payload * 3) / 4) : null,
  };
}

function contentParts(content: readonly KimiContentPart[]): AgentContextViewPart[] {
  return content.map((part): AgentContextViewPart => {
    switch (part.type) {
      case "text":
        return { kind: "text", text: typeof part.text === "string" ? part.text : "" };
      case "think":
        return { kind: "thinking", text: typeof part.think === "string" && part.think ? part.think : null };
      case "image_url":
        return imagePart(part);
      default:
        return { kind: "text", text: `[${part.type}]` };
    }
  });
}

function toolInput(args: string | null | undefined): JsonValue {
  if (!args) return {};
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

/** How the SDK renders a failed tool's result for the model; the projected message has no error field. */
const TOOL_ERROR_OUTPUT_RE = /^(?:Wall time: [^\n]*\n)?<system>ERROR/;

function viewMessage(message: KimiRebuiltMessage, toolNames: ReadonlyMap<string, string>): AgentContextViewMessage {
  if (message.role === "tool") {
    const parts = contentParts(message.content);
    const output = parts.flatMap((part) => (part.kind === "text" ? [part.text] : [])).join("\n");
    const toolUseId = message.toolCallId ?? null;
    return {
      role: "tool",
      parts: [
        {
          kind: "tool_result",
          toolName: (toolUseId && toolNames.get(toolUseId)) || null,
          toolUseId,
          output,
          isError: TOOL_ERROR_OUTPUT_RE.test(output),
        },
        ...parts.filter((part) => part.kind === "image"),
      ],
    };
  }
  const role = message.role === "system" || message.role === "assistant" ? message.role : "user";
  return {
    role,
    parts: [
      ...contentParts(message.content),
      ...(message.toolCalls ?? []).map((call): AgentContextViewPart => ({
        kind: "tool_use",
        toolName: call.name || "unknown",
        toolUseId: call.id,
        input: toolInput(call.arguments),
      })),
    ],
  };
}

function isoTime(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function viewTokens(usage: unknown): AgentContextViewTokens {
  if (!isObj(usage)) return { input: null, cacheRead: null, total: null };
  const input = count(usage.inputOther) + count(usage.inputCacheCreation);
  const cacheRead = count(usage.inputCacheRead);
  // The SDK records an empty usage when the provider reported none: unknown, not zero.
  if (input + cacheRead === 0) return { input: null, cacheRead: null, total: null };
  return { input, cacheRead, total: input + cacheRead };
}

/** The last loop request in the records, with what the wire says of it around the rebuild: when it went and what it cost. */
function requestFacts(records: readonly KimiWireRecord[]): { requestAt: string | null; tokens: AgentContextViewTokens; compaction: AgentContextViewCompaction } {
  let last = -1;
  let compaction: AgentContextViewCompaction = { happened: false };
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.type === "llm.request" && record.kind === "loop") last = index;
  }
  for (let index = 0; index < last; index += 1) {
    const record = records[index]!;
    if (record.type === "context.clear") compaction = { happened: false };
    if (record.type !== "context.apply_compaction") continue;
    const text = typeof record.contextSummary === "string" ? record.contextSummary : record.summary;
    compaction = { happened: true, summary: typeof text === "string" ? { kind: "text", text } : null };
  }
  let usage: unknown = null;
  for (let index = last + 1; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.type === "llm.request") break;
    if (record.type === "usage.record" && record.usageScope === "turn") {
      usage = record.usage;
      break;
    }
  }
  return { requestAt: last < 0 ? null : isoTime(records[last]!.time), tokens: viewTokens(usage), compaction };
}

const REFUSAL_FAILURES: Readonly<Record<LlmRequestRebuildRefusal, AgentContextViewDaemonFailureReason>> = {
  no_request: "not_found",
  replay_failed: "read_failed",
  newer_wire_version: "newer_session_format",
  media_projection: "media_removed",
  system_prompt_mismatch: "context_mismatch",
  tools_unavailable: "context_mismatch",
  tools_mismatch: "context_mismatch",
  message_count_mismatch: "context_mismatch",
  messages_hash_mismatch: "context_mismatch",
};

/**
 * More `context.*` records than this since the last compaction or clear is
 * `too_large`, without trying. The rebuild copies the whole history per record,
 * so its time grows with the square of this count, whatever the file's size:
 * 10k records take about 1 s, 40k about 11 s. The restore's child process has a
 * timeout, so past this the limit only saves the wait for an answer that's the same.
 */
export const KIMI_RESTORE_MAX_CONTEXT_RECORDS = 10_000;

/** The `context.*` records the rebuild's quadratic part covers: from the last compaction or clear before the last loop request. */
function contextRecordsToReplay(records: readonly KimiWireRecord[]): number {
  let target = records.length - 1;
  while (target >= 0 && !(records[target]!.type === "llm.request" && records[target]!.kind === "loop")) target -= 1;
  let count = 0;
  for (let index = target; index >= 0; index -= 1) {
    const { type } = records[index]!;
    if (type === "context.apply_compaction" || type === "context.clear") break;
    if (type.startsWith("context.")) count += 1;
  }
  return count;
}

export type KimiRestoreResult =
  | {
      ok: true;
      /** Not yet redacted: `redactions` is empty. */
      view: AgentContextView;
      responseFound: boolean;
    }
  | { ok: false; failure: AgentContextViewDaemonFailureReason; refusal: string };

export interface KimiRestoreInput {
  buffer: Buffer;
  /** Byte length of the file when the message was sent; null when it has no index line. */
  offset: number | null;
  messageId: string;
  runtime: string;
  sessionId: string;
  rebuild: KimiRequestRebuilder;
}

/** The request behind the message plus its response, as an AgentContextView. */
export function restoreKimiContextView(input: KimiRestoreInput): KimiRestoreResult {
  const send = findKimiSendRecord(input.buffer, input.messageId, input.offset);
  const offset = send?.offset ?? input.offset;
  if (offset === null) return { ok: false, failure: "not_found", refusal: "not_in_session" };

  const records = parseKimiWireRecords(input.buffer.subarray(0, offset));
  if (contextRecordsToReplay(records) > KIMI_RESTORE_MAX_CONTEXT_RECORDS) {
    return { ok: false, failure: "too_large", refusal: "too_many_context_records" };
  }
  const rebuilt = input.rebuild(records);
  if (rebuilt.status === "refused") {
    // A reason from a newer SDK than this map knows is a read failure.
    return { ok: false, failure: (REFUSAL_FAILURES as Readonly<Record<string, AgentContextViewDaemonFailureReason>>)[rebuilt.reason] ?? "read_failed", refusal: rebuilt.reason };
  }

  const toolNames = new Map<string, string>();
  for (const message of [...rebuilt.messages, ...(rebuilt.response ? [rebuilt.response] : [])]) {
    for (const call of message.toolCalls ?? []) {
      if (call.name) toolNames.set(call.id, call.name);
    }
  }
  const apiMessages = rebuilt.response ? [...rebuilt.messages, rebuilt.response] : rebuilt.messages;
  const messages = apiMessages.map((message) => viewMessage(message, toolNames));
  const responseIndex = rebuilt.response ? messages.length - 1 : null;
  const trigger = findContextViewTrigger(messages, responseIndex, send?.toolCallId ?? null);
  // A hash proves the rebuild matches this request, not that this request sent
  // the message. Without a reporting result only a send call in its response
  // does (a sub-agent's send is in another wire: this request isn't it).
  if (!send && !trigger) return { ok: false, failure: "not_found", refusal: "no_send_call" };
  const facts = requestFacts(records);

  return {
    ok: true,
    responseFound: rebuilt.response !== undefined,
    view: {
      runtime: input.runtime,
      model: rebuilt.request.model,
      sessionId: input.sessionId,
      requestAt: facts.requestAt,
      messageId: input.messageId,
      tokens: facts.tokens,
      system: [{ text: rebuilt.systemPrompt }],
      tools: rebuilt.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters as AgentContextView["tools"][number]["inputSchema"] })),
      messages,
      compaction: facts.compaction,
      trigger,
      redactions: {},
      source: { kind: "native", format: "kimi-wire", version: rebuilt.protocolVersion ?? null },
      verification: rebuilt.verification,
    },
  };
}
