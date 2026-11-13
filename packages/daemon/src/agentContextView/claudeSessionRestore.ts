import { createHash } from "node:crypto";
import {
  type AgentContextView,
  type AgentContextViewCompaction,
  type AgentContextViewMessage,
  type AgentContextViewMessageRole,
  type AgentContextViewPart,
  type AgentContextViewTool,
  type AgentContextViewTrigger,
  type JsonValue,
} from "@botiverse/raft-shared";

/**
 * View Context v0 (step 1): restore, from a Claude Code session JSONL, the one
 * model request that produced a Raft message, and its response.
 *
 * Claude Code (2.1.30x) records every model request in its session file:
 * - `api-request-shape` {shapeHash, shape: {system, tools}}: the request's
 *   system prompt and tool list, written once per distinct shape.
 * - `api-request-blob` {hash, message}: a message that has no ordinary
 *   transcript record (mid-conversation `system` messages, attachments).
 * - `api-request` {id, timestamp, shapeHash, params, base?, keep, tail,
 *   cacheControl, requestDigest}: the request's messages are the first
 *   `keep` messages of request `base` followed by `tail`, a list of message
 *   hashes. A hash names an `api-request-blob` or an ordinary transcript
 *   message: the assistant records of one response (`requestRef` = the
 *   request id, one content block per record, ordered by `apiBlockIndex`,
 *   tool inputs as sent in `wireToolInputs`) merged into one message, or a
 *   run of consecutive `user` records merged into one message, or a message
 *   the runtime wrote itself (an assistant record without `requestRef`, e.g.
 *   an API error) as `{role, content}`.
 *
 * Message hash: SHA-256 (hex) of the message as compact JSON with object keys
 * sorted. `requestDigest`: the same over the whole request body
 * `{...params, system, tools, messages}` with every string `content` written
 * as one text block and `cache_control` set at each `cacheControl` path.
 * Recomputing it (`claudeRequestDigest`) proves a restoration exact.
 */

type Obj = Record<string, unknown>;

/** A message as the provider API takes it (`{role, content}`, plus whatever else the runtime put there). */
export type ClaudeApiMessage = Obj & { role: string; content: unknown };

export interface ClaudeSessionRecord {
  /** Byte offset of the line's first byte in the file. */
  start: number;
  value: Obj;
}

interface ApiRequestRecord {
  start: number;
  id: string;
  timestamp: string | null;
  version: string | null;
  sessionId: string | null;
  shapeHash: string | null;
  params: Obj;
  base: string | null;
  keep: number;
  tail: string[];
  cacheControl: { path: (string | number)[]; value: unknown }[];
  requestDigest: string | null;
}

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A value read by JSON.parse is a JSON value; absent becomes null. */
function parsedJson(value: unknown): JsonValue {
  return value === undefined ? null : (value as JsonValue);
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Compact JSON with object keys sorted (undefined members dropped, as JSON.stringify does). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  const obj = value as Obj;
  const keys = Object.keys(obj).filter((key) => obj[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`).join(",")}}`;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function claudeMessageHash(message: unknown): string {
  return sha256Hex(canonicalJson(message));
}

/** Every JSON line of the file with its byte offset; a line that does not parse is skipped. */
export function parseClaudeSessionRecords(buffer: Buffer): ClaudeSessionRecord[] {
  const records: ClaudeSessionRecord[] = [];
  let start = 0;
  while (start < buffer.length) {
    let end = buffer.indexOf(0x0a, start);
    if (end < 0) end = buffer.length;
    if (end > start) {
      try {
        const value: unknown = JSON.parse(buffer.toString("utf8", start, end));
        if (isObj(value)) records.push({ start, value });
      } catch {
        // A torn last line (the runtime is mid-write) or a foreign line.
      }
    }
    start = end + 1;
  }
  return records;
}

function readApiRequest(record: ClaudeSessionRecord): ApiRequestRecord | null {
  const v = record.value;
  const id = str(v.id);
  if (!id) return null;
  const tail = Array.isArray(v.tail) ? v.tail.filter((hash): hash is string => typeof hash === "string") : [];
  const cacheControl = Array.isArray(v.cacheControl)
    ? v.cacheControl.flatMap((entry) => {
      if (!isObj(entry) || !Array.isArray(entry.path)) return [];
      const path = entry.path.filter((part): part is string | number => typeof part === "string" || typeof part === "number");
      return path.length === entry.path.length ? [{ path, value: entry.value }] : [];
    })
    : [];
  return {
    start: record.start,
    id,
    timestamp: str(v.timestamp),
    version: str(v.version),
    sessionId: str(v.sessionId),
    shapeHash: str(v.shapeHash),
    params: isObj(v.params) ? v.params : {},
    base: str(v.base),
    keep: typeof v.keep === "number" && Number.isSafeInteger(v.keep) && v.keep >= 0 ? v.keep : 0,
    tail,
    cacheControl,
    requestDigest: str(v.requestDigest),
  };
}

function contentBlocks(content: unknown): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

/** One response: its assistant records merged into one message, blocks in `apiBlockIndex` order. */
function mergeAssistantRecords(records: Obj[]): ClaudeApiMessage {
  const ordered = records
    .map((value, order) => ({ value, order, index: typeof value.apiBlockIndex === "number" ? value.apiBlockIndex : Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.index - b.index || a.order - b.order);
  const content: unknown[] = [];
  for (const { value } of ordered) {
    const message = isObj(value.message) ? value.message : {};
    const wireInputs = isObj(value.wireToolInputs) ? value.wireToolInputs : null;
    for (const block of contentBlocks(message.content)) {
      if (wireInputs && isObj(block) && block.type === "tool_use" && typeof block.id === "string" && block.id in wireInputs) {
        content.push({ ...block, input: wireInputs[block.id] });
      } else {
        content.push(block);
      }
    }
  }
  return { role: "assistant", content };
}

/** The parsed session: requests, shapes, and every message a tail hash may name. */
export class ClaudeSessionIndex {
  readonly requests: ApiRequestRecord[] = [];
  readonly requestsById = new Map<string, ApiRequestRecord>();
  readonly shapes = new Map<string, Obj>();
  readonly messages = new Map<string, ClaudeApiMessage>();
  /** Assistant records per request id (`requestRef`), in file order. */
  readonly responses = new Map<string, Obj[]>();
  /** `user` records in file order, for the trigger's tool result. */
  readonly userRecords: ClaudeSessionRecord[] = [];
  /** Byte offsets of `compact_boundary` records. */
  readonly compactBoundaries: number[] = [];
  /** Compact summaries (`isCompactSummary` user records), with their offsets. */
  readonly compactSummaries: { start: number; text: string | null }[] = [];

  constructor(records: readonly ClaudeSessionRecord[]) {
    let userRun: Obj[] = [];
    const flushUserRun = () => {
      if (userRun.length === 0) return;
      const content: unknown[] = [];
      for (const record of userRun) {
        const message = isObj(record.message) ? record.message : {};
        content.push(...contentBlocks(message.content));
        this.addMessage(message);
      }
      this.addMessage({ role: "user", content });
      userRun = [];
    };
    for (const record of records) {
      const v = record.value;
      switch (v.type) {
        case "api-request": {
          flushUserRun();
          const request = readApiRequest(record);
          if (request) {
            this.requests.push(request);
            this.requestsById.set(request.id, request);
          }
          break;
        }
        case "api-request-shape":
          if (typeof v.shapeHash === "string" && isObj(v.shape)) this.shapes.set(v.shapeHash, v.shape);
          break;
        case "api-request-blob":
          if (typeof v.hash === "string" && isObj(v.message) && typeof v.message.role === "string") {
            this.messages.set(v.hash, v.message as ClaudeApiMessage);
          }
          break;
        case "assistant": {
          flushUserRun();
          const ref = str(v.requestRef);
          if (ref) {
            const list = this.responses.get(ref);
            if (list) list.push(v);
            else this.responses.set(ref, [v]);
          } else if (isObj(v.message) && typeof v.message.role === "string") {
            // A message the runtime wrote itself (an API error, `model: "<synthetic>"`):
            // no response record, yet a later (resumed) request sends it as {role, content}.
            this.addMessage({ role: v.message.role, content: v.message.content });
          }
          break;
        }
        case "user":
          if (isObj(v.message)) {
            userRun.push(v);
            this.userRecords.push(record);
            if (v.isCompactSummary === true) this.compactSummaries.push({ start: record.start, text: flattenText(v.message.content) });
          }
          break;
        case "system":
          if (v.subtype === "compact_boundary") this.compactBoundaries.push(record.start);
          break;
        default:
          break;
      }
    }
    flushUserRun();
    for (const list of this.responses.values()) this.addMessage(mergeAssistantRecords(list));
  }

  private addMessage(message: Obj): void {
    if (typeof message.role !== "string") return;
    const hash = claudeMessageHash(message);
    if (!this.messages.has(hash)) this.messages.set(hash, message as ClaudeApiMessage);
  }

  /** The last request whose record starts before `offset`. */
  requestAtOrBefore(offset: number): ApiRequestRecord | null {
    let found: ApiRequestRecord | null = null;
    for (const request of this.requests) {
      if (request.start < offset) found = request;
      else break;
    }
    return found;
  }

  /**
   * The request's messages (base prefix + tail), or why they cannot be
   * restored. A tail hash the file has no message for is kept as null (a
   * record shape this reader does not know yet); every later request that
   * keeps it carries the gap too, so it is not fatal.
   */
  requestMessages(target: ApiRequestRecord): { ok: true; messages: (ClaudeApiMessage | null)[]; unresolved: number } | { ok: false; reason: "missing_base" | "base_cycle" } {
    const chain: ApiRequestRecord[] = [];
    const seen = new Set<string>();
    let current: ApiRequestRecord | undefined = target;
    while (current) {
      if (seen.has(current.id)) return { ok: false, reason: "base_cycle" };
      seen.add(current.id);
      chain.push(current);
      if (!current.base) break;
      const base = this.requestsById.get(current.base);
      if (!base) return { ok: false, reason: "missing_base" };
      current = base;
    }
    let messages: (ClaudeApiMessage | null)[] = [];
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const request = chain[i]!;
      const next = request.base ? messages.slice(0, request.keep) : [];
      for (const hash of request.tail) next.push(this.messages.get(hash) ?? null);
      messages = next;
    }
    return { ok: true, messages, unresolved: messages.filter((message) => message === null).length };
  }

  /** The response to a request: its assistant records merged, or null when none was recorded. */
  response(requestId: string): { message: ClaudeApiMessage; usage: Obj | null } | null {
    const records = this.responses.get(requestId);
    if (!records || records.length === 0) return null;
    let usage: Obj | null = null;
    for (const record of records) {
      const message = isObj(record.message) ? record.message : null;
      if (message && isObj(message.usage)) usage = message.usage;
    }
    return { message: mergeAssistantRecords(records), usage };
  }
}

/** A deep copy with no shared objects (a message repeated in a request must not share its `cache_control`). */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The request body the digest covers (see the module comment). */
export function claudeRequestBody(
  params: Obj,
  shape: Obj,
  messages: readonly ClaudeApiMessage[],
  cacheControl: readonly { path: readonly (string | number)[]; value: unknown }[],
): Obj {
  const body = cloneJson({ ...params, system: shape.system, tools: shape.tools, messages }) as Obj;
  for (const message of body.messages as Obj[]) {
    if (typeof message.content === "string") message.content = [{ type: "text", text: message.content }];
  }
  for (const entry of cacheControl) {
    let node: unknown = body;
    for (const key of entry.path) {
      if (Array.isArray(node) && typeof key === "number") node = node[key];
      else if (isObj(node) && typeof key === "string") node = node[key];
      else {
        node = undefined;
        break;
      }
    }
    if (isObj(node)) node.cache_control = cloneJson(entry.value);
  }
  return body;
}

export function claudeRequestDigest(index: ClaudeSessionIndex, request: ApiRequestRecord): string | null {
  const shape = request.shapeHash ? index.shapes.get(request.shapeHash) : undefined;
  if (!shape) return null;
  const restored = index.requestMessages(request);
  if (!restored.ok || restored.unresolved > 0) return null;
  return sha256Hex(canonicalJson(claudeRequestBody(request.params, shape, restored.messages as ClaudeApiMessage[], request.cacheControl)));
}

export interface ClaudeDigestReport {
  requests: number;
  matched: number;
  mismatched: number;
  /** Requests whose messages or shape could not be resolved at all. */
  unresolved: number;
  /** Requests that carry no digest to check against. */
  noDigest: number;
}

/** How many of the session's requests restore exactly (their recomputed digest equals `requestDigest`). */
export function verifyClaudeSessionDigests(index: ClaudeSessionIndex): ClaudeDigestReport {
  const report: ClaudeDigestReport = { requests: index.requests.length, matched: 0, mismatched: 0, unresolved: 0, noDigest: 0 };
  for (const request of index.requests) {
    if (!request.requestDigest) {
      report.noDigest += 1;
      continue;
    }
    const digest = claudeRequestDigest(index, request);
    if (digest === null) report.unresolved += 1;
    else if (digest === request.requestDigest) report.matched += 1;
    else report.mismatched += 1;
  }
  return report;
}

// ---------------------------------------------------------------------------
// Mapping to the shared AgentContextView.

function flattenText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const texts = content.flatMap((block) => (isObj(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []));
  return texts.length > 0 ? texts.join("\n") : null;
}

function base64DecodedBytes(data: unknown): number | null {
  if (typeof data !== "string") return null;
  const trimmed = data.replace(/\s+/g, "");
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding);
}

function imagePart(block: Obj): AgentContextViewPart {
  const source = isObj(block.source) ? block.source : {};
  return {
    kind: "image",
    mediaType: str(source.media_type),
    sizeBytes: source.type === "base64" ? base64DecodedBytes(source.data) : null,
  };
}

const TOOL_USE_BLOCK_TYPES = new Set(["tool_use", "server_tool_use", "mcp_tool_use"]);

function isToolResultBlockType(type: unknown): boolean {
  return typeof type === "string" && (type === "tool_result" || type.endsWith("_tool_result"));
}

/** A tool result's content flattened to text; its images become their own parts. */
function toolResultParts(block: Obj, toolNames: ReadonlyMap<string, string>): AgentContextViewPart[] {
  const toolUseId = str(block.tool_use_id);
  const images: AgentContextViewPart[] = [];
  const texts: string[] = [];
  const content = block.content;
  if (typeof content === "string") texts.push(content);
  else if (Array.isArray(content)) {
    for (const item of content) {
      if (!isObj(item)) continue;
      if (item.type === "text" && typeof item.text === "string") texts.push(item.text);
      else if (item.type === "image") images.push(imagePart(item));
      else if (item.type === "tool_reference" && typeof item.tool_name === "string") texts.push(`[tool reference: ${item.tool_name}]`);
      else if (typeof item.type === "string") texts.push(`[${item.type}]`);
    }
  } else if (content !== undefined && content !== null) {
    texts.push(JSON.stringify(content));
  }
  return [
    {
      kind: "tool_result",
      toolName: toolUseId ? toolNames.get(toolUseId) ?? null : null,
      toolUseId,
      output: texts.join("\n"),
      isError: block.is_error === true,
    },
    ...images,
  ];
}

function blockParts(block: unknown, toolNames: ReadonlyMap<string, string>): AgentContextViewPart[] {
  if (typeof block === "string") return [{ kind: "text", text: block }];
  if (!isObj(block)) return [];
  const type = block.type;
  if (type === "text") return [{ kind: "text", text: typeof block.text === "string" ? block.text : "" }];
  if (type === "thinking") {
    const text = typeof block.thinking === "string" && block.thinking.length > 0 ? block.thinking : null;
    return [{ kind: "thinking", text }];
  }
  if (type === "redacted_thinking") return [{ kind: "thinking", text: null }];
  if (typeof type === "string" && TOOL_USE_BLOCK_TYPES.has(type)) {
    return [{ kind: "tool_use", toolName: str(block.name) || "unknown", toolUseId: str(block.id), input: parsedJson(block.input) }];
  }
  if (isToolResultBlockType(type)) return toolResultParts(block, toolNames);
  if (type === "image") return [imagePart(block)];
  if (type === "compaction") return [{ kind: "compaction", text: typeof block.content === "string" ? block.content : null }];
  if (type === "tool_addition") {
    const tool = isObj(block.tool) ? block.tool : {};
    return [{ kind: "text", text: `[tool added: ${str(tool.name) ?? "unknown"}]` }];
  }
  if (type === "document") {
    const source = isObj(block.source) ? block.source : {};
    return [{ kind: "text", text: `[document${typeof source.media_type === "string" ? `: ${source.media_type}` : ""}]` }];
  }
  return [{ kind: "text", text: `[${typeof type === "string" ? type.slice(0, 64) : "block"}]` }];
}

function viewRole(role: string): AgentContextViewMessageRole {
  return role === "assistant" || role === "system" ? role : "user";
}

function toolNamesOf(messages: readonly (ClaudeApiMessage | null)[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (!message) continue;
    for (const block of contentBlocks(message.content)) {
      if (isObj(block) && typeof block.type === "string" && TOOL_USE_BLOCK_TYPES.has(block.type) && typeof block.id === "string" && typeof block.name === "string") {
        names.set(block.id, block.name);
      }
    }
  }
  return names;
}

/** In place of a message the session file does not hold (`requestMessages`). */
export const CLAUDE_UNRESTORED_MESSAGE_TEXT = "[This message is not in the session file and could not be restored.]";

function toViewMessages(messages: readonly (ClaudeApiMessage | null)[]): AgentContextViewMessage[] {
  const toolNames = toolNamesOf(messages);
  return messages.map((message) => (message === null ? { role: "user", parts: [{ kind: "text", text: CLAUDE_UNRESTORED_MESSAGE_TEXT }] } : {
    role: viewRole(message.role),
    parts: contentBlocks(message.content).flatMap((block) => blockParts(block, toolNames)),
  }));
}

function viewSystem(shape: Obj): { text: string }[] {
  const system = shape.system;
  if (typeof system === "string") return [{ text: system }];
  if (!Array.isArray(system)) return [];
  return system.flatMap((block) => (isObj(block) && typeof block.text === "string" ? [{ text: block.text }] : []));
}

function viewTools(shape: Obj): AgentContextViewTool[] {
  if (!Array.isArray(shape.tools)) return [];
  return shape.tools.flatMap((tool): AgentContextViewTool[] => {
    if (!isObj(tool) || typeof tool.name !== "string" || tool.name.length === 0) return [];
    const schema = tool.input_schema;
    return [{
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema: parsedJson(schema),
    }];
  });
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function viewTokens(usage: Obj | null): AgentContextView["tokens"] {
  if (!usage) return { input: null, cacheRead: null, total: null };
  const uncached = count(usage.input_tokens);
  const cacheWrite = count(usage.cache_creation_input_tokens) ?? 0;
  const cacheRead = count(usage.cache_read_input_tokens);
  const input = uncached === null ? null : uncached + cacheWrite;
  return { input, cacheRead, total: input === null ? null : input + (cacheRead ?? 0) };
}

/** A Bash command that sends a Raft message (`raft message send`, `raft task reply`, or the legacy `slock` name). */
export const SEND_COMMAND_RE = /\b(?:raft|slock)\s+(?:message\s+send|task\s+reply)\b/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The tool_use id whose result reports this message id (`Message ID: <id>` in the CLI's output). */
function toolUseIdReportingMessage(index: ClaudeSessionIndex, after: number, messageId: string): string | null {
  const pattern = new RegExp(`Message ID: ${escapeRegExp(messageId)}(?![A-Za-z0-9_-])`);
  for (const record of index.userRecords) {
    if (record.start < after) continue;
    const message = isObj(record.value.message) ? record.value.message : {};
    for (const block of contentBlocks(message.content)) {
      if (!isObj(block) || !isToolResultBlockType(block.type) || typeof block.tool_use_id !== "string") continue;
      const output = toolResultParts(block, new Map())[0];
      if (output?.kind === "tool_result" && pattern.test(output.output)) return block.tool_use_id;
    }
  }
  return null;
}

export function findContextViewTrigger(
  messages: readonly AgentContextViewMessage[],
  responseIndex: number | null,
  reportingToolUseId: string | null,
): AgentContextViewTrigger | null {
  if (responseIndex === null) return null;
  const parts = messages[responseIndex]?.parts ?? [];
  if (reportingToolUseId) {
    const partIndex = parts.findIndex((part) => part.kind === "tool_use" && part.toolUseId === reportingToolUseId);
    if (partIndex >= 0) return { messageIndex: responseIndex, partIndex, toolUseId: reportingToolUseId };
  }
  for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
    const part = parts[partIndex]!;
    if (part.kind !== "tool_use") continue;
    const command = isObj(part.input) ? part.input.command : undefined;
    if (typeof command === "string" && SEND_COMMAND_RE.test(command)) {
      return { messageIndex: responseIndex, partIndex, toolUseId: part.toolUseId };
    }
  }
  return null;
}

function viewCompaction(index: ClaudeSessionIndex, before: number, messages: readonly AgentContextViewMessage[]): AgentContextViewCompaction {
  const inline = messages.flatMap((message) => message.parts).find((part) => part.kind === "compaction");
  if (inline && inline.kind === "compaction") {
    return { happened: true, summary: inline.text === null ? { kind: "encrypted" } : { kind: "text", text: inline.text } };
  }
  if (!index.compactBoundaries.some((start) => start < before)) return { happened: false };
  const summary = index.compactSummaries.filter((entry) => entry.start < before).at(-1);
  return { happened: true, summary: summary?.text != null ? { kind: "text", text: summary.text } : null };
}

/**
 * The byte offset to restore at for a message with no index line: the start
 * of the tool result that reports `Message ID: <messageId>` (it follows the
 * request that made the call). Null when the file has none.
 */
export function findClaudeSendOffset(buffer: Buffer, messageId: string): number | null {
  const needle = Buffer.from(`Message ID: ${messageId}`, "utf8");
  let at = buffer.indexOf(needle);
  while (at >= 0) {
    const next = buffer[at + needle.length];
    const boundary = next === undefined || !/[A-Za-z0-9_-]/.test(String.fromCharCode(next));
    if (boundary) {
      const lineStart = buffer.lastIndexOf(0x0a, at) + 1;
      let lineEnd = buffer.indexOf(0x0a, at);
      if (lineEnd < 0) lineEnd = buffer.length;
      try {
        const record: unknown = JSON.parse(buffer.toString("utf8", lineStart, lineEnd));
        if (isObj(record) && record.type === "user") return lineStart;
      } catch {
        // not a whole record; keep looking
      }
    }
    at = buffer.indexOf(needle, at + needle.length);
  }
  return null;
}

export type ClaudeRestoreFailure = "no_request" | "missing_shape" | "missing_base" | "base_cycle";

export type ClaudeRestoreResult =
  | {
      ok: true;
      /** Not yet redacted: `redactions` is empty. */
      view: AgentContextView;
      /** The recomputed request digest equals the recorded one; null when the record has none. */
      digestMatch: boolean | null;
      responseFound: boolean;
      /** Messages the file does not hold (shown as CLAUDE_UNRESTORED_MESSAGE_TEXT); the digest cannot match then. */
      unrestoredMessages: number;
    }
  | { ok: false; failure: ClaudeRestoreFailure };

export interface ClaudeRestoreInput {
  index: ClaudeSessionIndex;
  /** Byte length of the session file when the message was sent (or the start of the tool result reporting it). */
  offset: number;
  messageId: string;
  runtime: string;
  /** Used when the request record names none. */
  sessionId: string;
}

/** The request before `offset` plus its response, as an AgentContextView. */
export function restoreClaudeContextView(input: ClaudeRestoreInput): ClaudeRestoreResult {
  const { index } = input;
  const request = index.requestAtOrBefore(input.offset);
  if (!request) return { ok: false, failure: "no_request" };
  const shape = request.shapeHash ? index.shapes.get(request.shapeHash) : undefined;
  if (!shape) return { ok: false, failure: "missing_shape" };
  const restored = index.requestMessages(request);
  if (!restored.ok) return { ok: false, failure: restored.reason };

  const digestMatch = !request.requestDigest
    ? null
    : restored.unresolved > 0
      ? false
      : sha256Hex(canonicalJson(claudeRequestBody(request.params, shape, restored.messages as ClaudeApiMessage[], request.cacheControl))) === request.requestDigest;
  const response = index.response(request.id);
  const apiMessages = response ? [...restored.messages, response.message] : restored.messages;
  const messages = toViewMessages(apiMessages);
  const responseIndex = response ? messages.length - 1 : null;
  const trigger = findContextViewTrigger(messages, responseIndex, toolUseIdReportingMessage(index, request.start, input.messageId));
  const model = str(request.params.model);
  const requestAt = request.timestamp && !Number.isNaN(Date.parse(request.timestamp)) && /^\d{4}-\d{2}-\d{2}T/.test(request.timestamp)
    ? request.timestamp
    : null;

  return {
    ok: true,
    digestMatch,
    responseFound: response !== null,
    unrestoredMessages: restored.unresolved,
    view: {
      runtime: input.runtime,
      model,
      sessionId: request.sessionId || input.sessionId,
      requestAt,
      messageId: input.messageId,
      tokens: viewTokens(response?.usage ?? null),
      system: viewSystem(shape),
      tools: viewTools(shape),
      messages,
      compaction: viewCompaction(index, request.start, messages),
      trigger,
      redactions: {},
      source: { kind: "native", format: "claude-jsonl", version: request.version },
      ...(digestMatch === true ? { verification: "verified" as const } : {}),
    },
  };
}
