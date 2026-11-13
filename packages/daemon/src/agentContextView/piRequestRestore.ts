import { createHash } from "node:crypto";
import type { AgentContextView, AgentContextViewDaemonFailureReason, AgentContextViewMessage, AgentContextViewMessageRole, AgentContextViewPart, AgentContextViewTool, AgentContextViewTrigger, JsonValue } from "@botiverse/raft-shared";
import { SEND_COMMAND_RE } from "./claudeSessionRestore";
import { piRequestDigest } from "./piRequestLog";

/**
 * View Context: restores, from a session's request log (`piRequestLog.ts`), the
 * request that was in flight when a Raft message was sent. Hashes that don't
 * match, or a `gap` where this message's request should be, are refused.
 *
 * The hashes prove the log is intact, not that this request sent the message.
 * The log has no responses, but the next request holds the reply and the send's
 * tool result: `verified` needs that result's `Message ID`, or a send call whose
 * result reports no other message. Without either (the agent stopped, or
 * compaction rewrote the history) the view is shown unverified. No tokens either way.
 */

type Obj = Record<string, unknown>;

interface RequestRecord {
  id: string;
  at: string | null;
  api: string | null;
  model: string | null;
  params: Obj;
  shapeHash: string;
  base: string | null;
  keep: number;
  tail: string[];
  digest: string;
}

type LogEntry = (RequestRecord | { gap: string }) & { end: number };

interface LogIndex {
  shapes: Map<string, Obj>;
  blobs: Map<string, unknown>;
  requests: Map<string, RequestRecord>;
  order: LogEntry[];
}

export type PiRestoreResult =
  | { ok: true; view: AgentContextView; responseFound: boolean; api: string }
  | { ok: false; failure: AgentContextViewDaemonFailureReason; refusal: string };

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function readRequest(record: Obj): RequestRecord | null {
  const { id, shapeHash, keep, tail, digest, base, params } = record;
  if (typeof id !== "string" || typeof shapeHash !== "string" || typeof digest !== "string") return null;
  if (typeof keep !== "number" || !Array.isArray(tail) || !tail.every((hash) => typeof hash === "string")) return null;
  return {
    id, shapeHash, keep, digest, tail: tail as string[],
    at: str(record.at), api: str(record.api), model: str(record.model),
    params: isObj(params) ? params : {}, base: str(base),
  };
}

/** A line that doesn't parse is a cut one: the writer moves past it. A record it relied on being gone fails the hashes. */
function indexLog(buffer: Buffer): LogIndex {
  const index: LogIndex = { shapes: new Map(), blobs: new Map(), requests: new Map(), order: [] };
  let start = 0;
  while (start < buffer.length) {
    const newline = buffer.indexOf(0x0a, start);
    const end = newline === -1 ? buffer.length : newline + 1;
    let record: unknown;
    try {
      record = JSON.parse(buffer.toString("utf8", start, end));
    } catch {
      record = null;
    }
    start = end;
    if (!isObj(record)) continue;
    switch (record.type) {
      case "shape":
        if (typeof record.hash === "string" && isObj(record.shape)) index.shapes.set(record.hash, record.shape);
        break;
      case "blob":
        if (typeof record.hash === "string") index.blobs.set(record.hash, record.message);
        break;
      case "request": {
        const request = readRequest(record);
        if (request) {
          index.requests.set(request.id, request);
          index.order.push({ ...request, end });
        }
        break;
      }
      case "gap":
        index.order.push({ gap: str(record.reason) ?? "unknown", end });
        break;
    }
  }
  return index;
}

function messageHashes(index: LogIndex, request: RequestRecord): string[] | null {
  const chain: RequestRecord[] = [];
  const seen = new Set<string>();
  let at: RequestRecord | undefined = request;
  while (at) {
    if (seen.has(at.id)) return null;
    seen.add(at.id);
    chain.push(at);
    if (at.base === null) break;
    at = index.requests.get(at.base);
    if (!at) return null;
  }
  const hashes: string[] = [];
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const step = chain[i]!;
    if (step.keep > hashes.length) return null;
    hashes.length = step.keep;
    for (const hash of step.tail) hashes.push(hash);
  }
  return hashes;
}

/** The request's messages, each checked against its hash. */
function verifiedMessages(index: LogIndex, request: RequestRecord): unknown[] | null {
  const hashes = messageHashes(index, request);
  const shape = index.shapes.get(request.shapeHash);
  if (!hashes || !shape || sha256Hex(JSON.stringify(shape)) !== request.shapeHash) return null;
  if (piRequestDigest(request.shapeHash, JSON.stringify(request.params), hashes) !== request.digest) return null;
  const messages: unknown[] = [];
  for (const hash of hashes) {
    if (!index.blobs.has(hash)) return null;
    const message = index.blobs.get(hash);
    if (sha256Hex(JSON.stringify(message)) !== hash) return null;
    messages.push(message);
  }
  return messages;
}

function bodyParts(index: LogIndex, request: RequestRecord): Obj {
  const shape = index.shapes.get(request.shapeHash)!;
  const { config, ...params } = request.params;
  const body: Obj = { ...shape, ...params };
  if (isObj(config) || isObj(shape.config)) body.config = { ...(isObj(shape.config) ? shape.config : {}), ...(isObj(config) ? config : {}) };
  return body;
}

// ---------------------------------------------------------------------------
// The media marker, as `piRequestLogMediaMarker` writes it.

const MEDIA_MARKER = /^\[raft:media (\S+) (\d+) bytes sha256=[0-9a-f]{64}\]$/;

function imagePart(value: unknown, mediaType: unknown): AgentContextViewPart {
  const marker = MEDIA_MARKER.exec(str(value) ?? "");
  const named = marker && marker[1] !== "unknown" ? marker[1]! : str(mediaType);
  return { kind: "image", mediaType: named, sizeBytes: marker ? Number(marker[2]) : null };
}

function jsonInput(value: unknown): JsonValue {
  if (typeof value !== "string") return (value ?? null) as JsonValue;
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return value;
  }
}

export function textOfOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => (isObj(part) && typeof part.text === "string" ? part.text : isObj(part) ? `[${str(part.type) ?? "part"}]` : String(part))).join("\n");
  }
  return JSON.stringify(value ?? null);
}

function unknownPart(value: unknown): AgentContextViewPart {
  return { kind: "unknown", originalKind: isObj(value) ? str(value.type) ?? "object" : typeof value };
}

function tool(name: unknown, description: unknown, schema: unknown): AgentContextViewTool {
  return { name: str(name) ?? "unknown", description: str(description) ?? "", inputSchema: (schema ?? null) as JsonValue };
}

function systemTexts(value: unknown): { text: string }[] {
  if (typeof value === "string") return value ? [{ text: value }] : [];
  if (!Array.isArray(value)) return [];
  return value.flatMap((block) => (isObj(block) && typeof block.text === "string" ? [{ text: block.text }] : []));
}

type Projection = {
  system: { text: string }[];
  tools: AgentContextViewTool[];
  messages: AgentContextViewMessage[];
};

function namesOfCalls(messages: readonly AgentContextViewMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.kind === "tool_use" && part.toolUseId) names.set(part.toolUseId, part.toolName);
    }
  }
  return names;
}

/** A tool result names its tool by the call's id: filled in once all the calls are read. */
export function withToolNames(messages: AgentContextViewMessage[]): AgentContextViewMessage[] {
  const names = namesOfCalls(messages);
  return messages.map((message) => ({
    role: message.role,
    parts: message.parts.map((part) => (part.kind === "tool_result" && part.toolName === null && part.toolUseId
      ? { ...part, toolName: names.get(part.toolUseId) ?? null }
      : part)),
  }));
}

// ---------------------------------------------------------------------------
// anthropic-messages

function anthropicPart(block: unknown): AgentContextViewPart {
  if (!isObj(block)) return unknownPart(block);
  switch (block.type) {
    case "text":
      return { kind: "text", text: str(block.text) ?? "" };
    case "thinking":
      return { kind: "thinking", text: str(block.thinking) };
    case "redacted_thinking":
      return { kind: "thinking", text: null };
    case "tool_use":
      return { kind: "tool_use", toolName: str(block.name) ?? "unknown", toolUseId: str(block.id), input: (block.input ?? null) as JsonValue };
    case "tool_result":
      return { kind: "tool_result", toolName: null, toolUseId: str(block.tool_use_id), output: textOfOutput(block.content), isError: block.is_error === true };
    case "image": {
      const source = isObj(block.source) ? block.source : {};
      return imagePart(source.data, source.media_type);
    }
    default:
      return unknownPart(block);
  }
}

function projectAnthropic(body: Obj, messages: unknown[], role: (value: unknown) => AgentContextViewMessageRole): Projection {
  return {
    system: systemTexts(body.system),
    tools: (Array.isArray(body.tools) ? body.tools : []).filter(isObj).map((entry) => tool(entry.name, entry.description, entry.input_schema)),
    messages: messages.filter(isObj).map((message) => ({
      role: role(message.role),
      parts: typeof message.content === "string"
        ? [{ kind: "text" as const, text: message.content }]
        : (Array.isArray(message.content) ? message.content : []).map(anthropicPart),
    })),
  };
}

// ---------------------------------------------------------------------------
// openai-completions

function completionsContent(content: unknown): AgentContextViewPart[] {
  if (typeof content === "string") return content ? [{ kind: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.map((part) => {
    if (!isObj(part)) return unknownPart(part);
    if (part.type === "text") return { kind: "text", text: str(part.text) ?? "" };
    if (part.type === "image_url") return imagePart(isObj(part.image_url) ? part.image_url.url : part.image_url, null);
    return unknownPart(part);
  });
}

function projectCompletions(body: Obj, all: unknown[], role: (value: unknown) => AgentContextViewMessageRole): Projection {
  const messages = all.filter(isObj);
  const lead = messages.findIndex((message) => message.role !== "system" && message.role !== "developer");
  const leading = lead === -1 ? messages : messages.slice(0, lead);
  const system = leading.flatMap((message) => completionsContent(message.content)).flatMap((part) => (part.kind === "text" ? [{ text: part.text }] : []));
  return {
    system,
    tools: (Array.isArray(body.tools) ? body.tools : []).filter(isObj).map((entry) => {
      const fn = isObj(entry.function) ? entry.function : entry;
      return tool(fn.name, fn.description, fn.parameters);
    }),
    messages: messages.slice(leading.length).map((message) => {
      if (message.role === "tool") {
        return { role: "tool" as const, parts: [{ kind: "tool_result" as const, toolName: null, toolUseId: str(message.tool_call_id), output: textOfOutput(message.content), isError: false }] };
      }
      const reasoning = str(message.reasoning_content) ?? str(message.reasoning) ?? str(message.reasoning_text);
      const opaque = !reasoning && Array.isArray(message.reasoning_details) && message.reasoning_details.length > 0;
      const calls = (Array.isArray(message.tool_calls) ? message.tool_calls : []).filter(isObj).map((call): AgentContextViewPart => {
        const fn = isObj(call.function) ? call.function : {};
        return { kind: "tool_use", toolName: str(fn.name) ?? "unknown", toolUseId: str(call.id), input: jsonInput(fn.arguments) };
      });
      return {
        role: role(message.role),
        parts: [...(reasoning || opaque ? [{ kind: "thinking" as const, text: reasoning }] : []), ...completionsContent(message.content), ...calls],
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// openai-responses and its relatives

function responsesContent(content: unknown): AgentContextViewPart[] {
  if (typeof content === "string") return [{ kind: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.map((part) => {
    if (!isObj(part)) return unknownPart(part);
    if (part.type === "input_text" || part.type === "output_text") return { kind: "text", text: str(part.text) ?? "" };
    if (part.type === "input_image") return imagePart(part.image_url, null);
    return unknownPart(part);
  });
}

/** A flat list: Codex nests tools in `namespace` entries, and sends a catalog model's as an `additional_tools` input item. */
function responsesTools(entries: unknown): AgentContextViewTool[] {
  return (Array.isArray(entries) ? entries : []).filter(isObj).flatMap((entry) => {
    if (entry.type === "namespace") {
      return responsesTools(entry.tools).map((inner) => ({ ...inner, name: `${str(entry.name) ?? "namespace"}.${inner.name}` }));
    }
    return [tool(entry.name ?? entry.type, entry.description, entry.parameters ?? entry.format)];
  });
}

export function projectResponses(body: Obj, items: unknown[], role: (value: unknown) => AgentContextViewMessageRole = viewRole): Projection {
  const messages: AgentContextViewMessage[] = [];
  const add = (messageRole: AgentContextViewMessageRole, part: AgentContextViewPart) => {
    const last = messages.at(-1);
    if (last?.role === messageRole) last.parts.push(part);
    else messages.push({ role: messageRole, parts: [part] });
  };
  const leading: { text: string }[] = [];
  const tools = responsesTools(body.tools);
  for (const item of items) {
    if (!isObj(item)) continue;
    if (item.type === "additional_tools") {
      tools.push(...responsesTools(item.tools));
    } else if (item.type === "function_call") {
      add("assistant", { kind: "tool_use", toolName: str(item.name) ?? "unknown", toolUseId: str(item.call_id), input: jsonInput(item.arguments) });
    } else if (item.type === "function_call_output") {
      add("tool", { kind: "tool_result", toolName: null, toolUseId: str(item.call_id), output: textOfOutput(item.output), isError: false });
    } else if (item.type === "reasoning") {
      const summary = (Array.isArray(item.summary) ? item.summary : []).filter(isObj).map((part) => str(part.text) ?? "").join("\n");
      add("assistant", { kind: "thinking", text: summary || null });
    } else if (item.type === "custom_tool_call") {
      add("assistant", { kind: "tool_use", toolName: str(item.name) ?? "unknown", toolUseId: str(item.call_id), input: (item.input ?? null) as JsonValue });
    } else if (item.type === "custom_tool_call_output") {
      add("tool", { kind: "tool_result", toolName: null, toolUseId: str(item.call_id), output: textOfOutput(item.output), isError: false });
    } else if (item.type === "local_shell_call") {
      add("assistant", { kind: "tool_use", toolName: "local_shell", toolUseId: str(item.call_id), input: (item.action ?? null) as JsonValue });
    } else if (item.type === "compaction" || item.type === "context_compaction") {
      // Codex's remote compaction: what the model got is OpenAI's ciphertext.
      add("user", { kind: "compaction", text: null });
    } else if (item.type === "message" || typeof item.role === "string") {
      if ((item.role === "system" || item.role === "developer") && messages.length === 0) {
        for (const part of responsesContent(item.content)) if (part.kind === "text") leading.push({ text: part.text });
      } else {
        for (const part of responsesContent(item.content)) add(role(item.role), part);
      }
    } else if (typeof item.type === "string" && item.type.endsWith("_call")) {
      // A hosted tool's call (`web_search_call`, `image_generation_call`).
      add("assistant", { kind: "tool_use", toolName: item.type.slice(0, -"_call".length), toolUseId: str(item.call_id) ?? str(item.id), input: (item.action ?? null) as JsonValue });
    } else if (typeof item.type === "string" && item.type.endsWith("_output")) {
      add("tool", { kind: "tool_result", toolName: null, toolUseId: str(item.call_id), output: textOfOutput(item.output ?? item.tools), isError: false });
    } else {
      add("user", unknownPart(item));
    }
  }
  // A later `additional_tools` updates the list (Codex, after a model change): the latest of each name.
  const toolsByName = new Map(tools.map((entry) => [entry.name, entry]));
  return {
    system: [...systemTexts(body.instructions), ...leading],
    tools: [...toolsByName.values()],
    messages,
  };
}

// ---------------------------------------------------------------------------
// google-generative-ai

function googleParts(parts: unknown): AgentContextViewPart[] {
  return (Array.isArray(parts) ? parts : []).flatMap((part): AgentContextViewPart[] => {
    if (!isObj(part)) return [unknownPart(part)];
    if (typeof part.text === "string") return [part.thought === true ? { kind: "thinking", text: part.text } : { kind: "text", text: part.text }];
    if (isObj(part.functionCall)) {
      const call = part.functionCall;
      return [{ kind: "tool_use", toolName: str(call.name) ?? "unknown", toolUseId: str(call.id), input: (call.args ?? null) as JsonValue }];
    }
    if (isObj(part.functionResponse)) {
      const response = part.functionResponse;
      const output = isObj(response.response) ? response.response : {};
      return [
        { kind: "tool_result", toolName: str(response.name), toolUseId: str(response.id), output: textOfOutput(response.response), isError: output.error !== undefined },
        // Gemini 3 sends a tool's images beside its output.
        ...googleParts(response.parts),
      ];
    }
    if (isObj(part.inlineData)) return [imagePart(part.inlineData.data, part.inlineData.mimeType)];
    return [{ kind: "unknown", originalKind: Object.keys(part)[0] ?? "part" }];
  });
}

function projectGoogle(body: Obj, contents: unknown[]): Projection {
  const config = isObj(body.config) ? body.config : {};
  const instruction = config.systemInstruction;
  const tools = (Array.isArray(config.tools) ? config.tools : []).filter(isObj).flatMap((entry) => (Array.isArray(entry.functionDeclarations) ? entry.functionDeclarations : []));
  return {
    system: typeof instruction === "string" ? systemTexts(instruction) : isObj(instruction) ? systemTexts(instruction.parts) : [],
    tools: tools.filter(isObj).map((entry) => tool(entry.name, entry.description, entry.parametersJsonSchema ?? entry.parameters)),
    messages: contents.filter(isObj).map((content) => ({
      role: content.role === "model" ? "assistant" as const : "user" as const,
      parts: googleParts(content.parts),
    })),
  };
}

// ---------------------------------------------------------------------------

function viewRole(value: unknown): AgentContextViewMessageRole {
  return value === "assistant" ? "assistant" : value === "system" || value === "developer" ? "system" : value === "tool" ? "tool" : "user";
}

const PROJECTIONS: Readonly<Record<string, (body: Obj, messages: unknown[]) => Projection>> = {
  "anthropic-messages": (body, messages) => projectAnthropic(body, messages, viewRole),
  "openai-completions": (body, messages) => projectCompletions(body, messages, viewRole),
  "openai-responses": (body, messages) => projectResponses(body, messages, viewRole),
  "azure-openai-responses": (body, messages) => projectResponses(body, messages, viewRole),
  "openai-codex-responses": (body, messages) => projectResponses(body, messages, viewRole),
  "google-generative-ai": (body, messages) => projectGoogle(body, messages),
  "google-vertex": (body, messages) => projectGoogle(body, messages),
};

export const PI_RESTORE_SUPPORTED_APIS: readonly string[] = Object.keys(PROJECTIONS);

const GAP_MARKED_LATE: ReadonlySet<string> = new Set(["off", "write_failed"]);

const COMPACTION_PREFIX = "The conversation history before this point was compacted into the following summary:";

export function compactionOf(messages: readonly AgentContextViewMessage[]): AgentContextView["compaction"] {
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.kind === "compaction") return { happened: true, summary: part.text === null ? { kind: "encrypted" } : { kind: "text", text: part.text } };
      if (part.kind === "text" && part.text.startsWith(COMPACTION_PREFIX)) return { happened: true, summary: { kind: "text", text: part.text } };
    }
  }
  return { happened: false };
}

/**
 * The same message on a later request. Anthropic's cache breakpoint moves off the
 * last message, and OpenRouter's turns a tool's string content into a text block.
 */
function sameMessage(a: unknown, b: unknown): boolean {
  const plain = (value: unknown) => JSON.stringify(value, (key, field) => {
    if (key === "cache_control") return undefined;
    if (key === "content" && Array.isArray(field) && field.length === 1 && isObj(field[0]) && field[0].type === "text") return field[0].text;
    return field;
  });
  return plain(a) === plain(b);
}

/** The CLI's own words for a sent message, plain and with `--json`. */
export function reportsMessage(output: string, messageId: string): boolean {
  const report = `Message ID: ${messageId}`;
  const found = output.indexOf(report);
  if (found !== -1 && !/[A-Za-z0-9_-]/.test(output.charAt(found + report.length))) return true;
  return new RegExp(`"messageId":\\s*"${messageId.replace(/[^A-Za-z0-9_-]/g, "\\$&")}"`).test(output);
}

export function holdsSendResult(messages: readonly AgentContextViewMessage[], messageId: string): boolean {
  return messages.some((message) => message.parts.some((part) => part.kind === "tool_result" && reportsMessage(part.output, messageId)));
}

/** A shell call's command: a string, Codex's `exec_command` `cmd`, an argv, or the script of Codex's `exec`. */
function commandText(toolName: string, input: unknown): string {
  if (typeof input === "string") return toolName === "exec" ? input : "";
  if (!isObj(input)) return "";
  const command = input.command ?? input.cmd;
  if (typeof command === "string") return command;
  return Array.isArray(command) ? command.filter((part) => typeof part === "string").join(" ") : "";
}

const REPORTED_MESSAGE = /Message ID: [A-Za-z0-9_-]+|"messageId":\s*"[^"]+"/;

/**
 * The send's call in the reply: the one whose result reports this message, else
 * the last send call whose result reports none. Null when what follows says
 * otherwise: this message's result belongs to another call, or the only send
 * calls here sent other messages. A provider without call ids (Gemini 2.x) has
 * its results in the order of its calls.
 */
export function findSendCall(all: readonly AgentContextViewMessage[], replyIndex: number, following: readonly AgentContextViewMessage[], messageId: string): AgentContextViewTrigger | null {
  const parts = all[replyIndex]!.parts;
  const calls = parts.flatMap((part, partIndex) => (part.kind === "tool_use" ? [{ part, partIndex }] : []));
  const nextReply = following.findIndex((message) => message.role === "assistant");
  const span = nextReply === -1 ? following : following.slice(0, nextReply);
  const results = span.flatMap((message) => message.parts.flatMap((part) => (part.kind === "tool_result" ? [part] : [])));
  const callOf = (result: (typeof results)[number], position: number) => (result.toolUseId
    ? calls.find((call) => call.part.toolUseId === result.toolUseId)
    : calls[position]);

  const reporting = results.findIndex((result) => reportsMessage(result.output, messageId));
  if (reporting !== -1) {
    const call = callOf(results[reporting]!, reporting);
    return call ? { messageIndex: replyIndex, partIndex: call.partIndex, toolUseId: call.part.toolUseId } : null;
  }
  if (holdsSendResult(following, messageId)) return null;
  const reportedOthers = new Set(results.flatMap((result, position) => {
    const call = REPORTED_MESSAGE.test(result.output) ? callOf(result, position) : undefined;
    return call ? [call.partIndex] : [];
  }));
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const { part, partIndex } = calls[i]!;
    if (part.kind !== "tool_use" || reportedOthers.has(partIndex)) continue;
    if (SEND_COMMAND_RE.test(commandText(part.toolName, part.input))) return { messageIndex: replyIndex, partIndex, toolUseId: part.toolUseId };
  }
  return null;
}

export interface PiRestoreInput {
  buffer: Buffer;
  /** The log's length when the message was sent. */
  offset: number;
  messageId: string;
  runtime: string;
  sessionId: string;
}

export function restorePiContextView(input: PiRestoreInput): PiRestoreResult {
  // A log swept and started again under the same id is shorter than the send's offset: not this message's log.
  if (input.offset > input.buffer.length) return { ok: false, failure: "not_found", refusal: "offset_past_end" };
  const index = indexLog(input.buffer);
  const { order } = index;
  let at = order.length - 1;
  while (at >= 0 && order[at]!.end > input.offset) at -= 1;

  const mismatch: PiRestoreResult = { ok: false, failure: "context_mismatch", refusal: "hash_mismatch" };
  let request: RequestRecord;
  let messages: unknown[];
  let projected: Projection;
  let project: (body: Obj, messages: unknown[]) => Projection;
  for (;;) {
    const entry = order[at];
    if (!entry) return { ok: false, failure: "not_found", refusal: "no_request" };
    if ("gap" in entry) return { ok: false, failure: "not_recorded", refusal: `gap_${entry.gap}` };
    request = entry;
    const projection = request.api ? PROJECTIONS[request.api] : undefined;
    if (!projection) return { ok: false, failure: "unsupported_runtime", refusal: `api_${request.api ?? "unknown"}` };
    project = projection;
    const verified = verifiedMessages(index, request);
    if (!verified) return mismatch;
    messages = verified;
    projected = project(bodyParts(index, request), messages);
    // This request already holds the send's result, so the offset came late: the one before it is the send's.
    if (!holdsSendResult(projected.messages, input.messageId)) break;
    at -= 1;
  }

  // The next request that kept these messages. A retry or a cache-warming replay has no more than they do.
  let later: unknown[] | null = null;
  for (let next = at + 1; next < order.length; next += 1) {
    const entry = order[next]!;
    if ("gap" in entry) {
      // Off or a failed write is only marked with the next request, so the miss may be before the send.
      if (GAP_MARKED_LATE.has(entry.gap)) return { ok: false, failure: "not_recorded", refusal: `gap_${entry.gap}` };
      break;
    }
    const candidate = verifiedMessages(index, entry);
    if (!candidate) return mismatch;
    if (candidate.length < messages.length || !messages.every((message, i) => sameMessage(message, candidate[i]))) break;
    if (candidate.length > messages.length) {
      later = candidate;
      break;
    }
  }
  const after = later ? project(bodyParts(index, request), later).messages.slice(projected.messages.length) : [];
  const replyCount = after.findIndex((message) => message.role !== "assistant");
  const reply = replyCount === -1 ? after : after.slice(0, replyCount);
  const all = withToolNames([...projected.messages, ...reply]);
  const trigger = reply.length > 0 ? findSendCall(all, projected.messages.length, after.slice(reply.length), input.messageId) : null;

  return {
    ok: true,
    api: request.api!,
    responseFound: reply.length > 0,
    view: {
      runtime: input.runtime,
      model: request.model,
      sessionId: input.sessionId,
      requestAt: request.at,
      messageId: input.messageId,
      tokens: { input: null, cacheRead: null, total: null },
      system: projected.system,
      tools: projected.tools,
      messages: all,
      compaction: compactionOf(projected.messages),
      trigger,
      redactions: {},
      source: { kind: "captured", format: "raft-request-log", version: "1" },
      ...(trigger ? { verification: "verified" as const } : {}),
    },
  };
}
