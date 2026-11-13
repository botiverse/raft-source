import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAgentContextViewResultBody } from "@botiverse/raft-shared";
import { afterEach, beforeEach, test } from "vitest";
import { PiRequestLog } from "./piRequestLog";
import { restorePiContextView } from "./piRequestRestore";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "pi-request-restore-"));
  file = path.join(dir, "s1.jsonl");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const facts = (api: string) => ({ sessionId: "s1", provider: "p", api, model: "the-model" });
const size = () => statSync(file).size;
const restore = (offset: number) => restorePiContextView({ buffer: readFileSync(file), offset, messageId: "m1", runtime: "pi", sessionId: "s1" });

function viewOf(offset: number) {
  const restored = restore(offset);
  assert.ok(restored.ok, JSON.stringify(restored));
  // What the server accepts: a view it refuses is no view at all.
  const parsed = parseAgentContextViewResultBody({ ok: true, context: restored.view });
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return restored;
}

const SEND = { command: 'raft message send --target "#general"' };

test("anthropic-messages: system, tools, every kind of part, the reply and the send", () => {
  const log = new PiRequestLog(() => dir);
  const shape = {
    model: "the-model", max_tokens: 100,
    system: [{ type: "text", text: "You are Otter" }, { type: "text", text: "Be brief" }],
    tools: [{ name: "Bash", description: "Run", input_schema: { type: "object" } }],
  };
  const messages: unknown[] = [
    { role: "user", content: "hello" },
    { role: "assistant", content: [{ type: "thinking", thinking: "hm", signature: "s" }, { type: "redacted_thinking", data: "x" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a.txt" }] }, { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(4000) } }, { type: "server_thing" }] },
  ];
  log.record({ ...shape, messages }, facts("anthropic-messages"));
  const offset = size();
  log.record({ ...shape, max_tokens: 90, messages: [...messages, { role: "assistant", content: [{ type: "text", text: "sending" }, { type: "tool_use", id: "t2", name: "Bash", input: SEND }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "sent" }] }] }, facts("anthropic-messages"));

  const { view, responseFound } = viewOf(offset);
  assert.equal(responseFound, true);
  assert.deepEqual(view.system, [{ text: "You are Otter" }, { text: "Be brief" }]);
  assert.deepEqual(view.tools, [{ name: "Bash", description: "Run", inputSchema: { type: "object" } }]);
  assert.equal(view.model, "the-model");
  assert.equal(view.verification, "verified");
  assert.deepEqual(view.source, { kind: "captured", format: "raft-request-log", version: "1" });
  assert.deepEqual(view.messages[1]!.parts, [
    { kind: "thinking", text: "hm" },
    { kind: "thinking", text: null },
    { kind: "tool_use", toolName: "Bash", toolUseId: "t1", input: { command: "ls" } },
  ]);
  assert.deepEqual(view.messages[2]!.parts, [
    { kind: "tool_result", toolName: "Bash", toolUseId: "t1", output: "a.txt", isError: false },
    { kind: "image", mediaType: "image/png", sizeBytes: 3000 },
    { kind: "unknown", originalKind: "server_thing" },
  ]);
  assert.equal(view.messages.length, 4, "the request's messages and the reply, not what came after it");
  assert.deepEqual(view.trigger, { messageIndex: 3, partIndex: 1, toolUseId: "t2" });
});

test("openai-completions: leading system messages lift out; calls and results pair up", () => {
  const log = new PiRequestLog(() => dir);
  log.record({
    model: "m", tools: [{ type: "function", function: { name: "bash", description: "Run", parameters: { type: "object" } } }],
    messages: [
      { role: "developer", content: "You are Otter" },
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${"A".repeat(4000)}` } }] },
      { role: "assistant", content: null, reasoning_content: "thinking", tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "a.txt" },
      { role: "system", content: "a later system message" },
    ],
  }, facts("openai-completions"));
  const { view, responseFound } = viewOf(size());
  assert.equal(responseFound, false);
  assert.equal(view.trigger, null);
  assert.deepEqual(view.system, [{ text: "You are Otter" }]);
  assert.deepEqual(view.tools, [{ name: "bash", description: "Run", inputSchema: { type: "object" } }]);
  assert.deepEqual(view.messages, [
    { role: "user", parts: [{ kind: "text", text: "look" }, { kind: "image", mediaType: "image/jpeg", sizeBytes: 3000 }] },
    { role: "assistant", parts: [{ kind: "thinking", text: "thinking" }, { kind: "tool_use", toolName: "bash", toolUseId: "c1", input: { command: "ls" } }] },
    { role: "tool", parts: [{ kind: "tool_result", toolName: "bash", toolUseId: "c1", output: "a.txt", isError: false }] },
    { role: "system", parts: [{ kind: "text", text: "a later system message" }] },
  ]);
});

test("openai-responses: instructions, items and encrypted reasoning", () => {
  const log = new PiRequestLog(() => dir);
  log.record({
    model: "m", instructions: "You are Otter", tools: [{ type: "function", name: "bash", description: "Run", parameters: {} }, { type: "web_search" }],
    input: [
      { role: "user", content: [{ type: "input_text", text: "hi" }, { type: "input_image", image_url: `data:image/png;base64,${"A".repeat(4000)}` }] },
      { type: "reasoning", summary: [], encrypted_content: "yyy" },
      { type: "function_call", call_id: "c1", name: "bash", arguments: '{"command":"ls"}' },
      { type: "function_call_output", call_id: "c1", output: "a.txt" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
      { type: "future_item" },
    ],
  }, facts("openai-responses"));
  const { view } = viewOf(size());
  assert.deepEqual(view.system, [{ text: "You are Otter" }]);
  assert.deepEqual(view.tools.map((entry) => entry.name), ["bash", "web_search"]);
  assert.deepEqual(view.messages.map((message) => [message.role, message.parts.map((part) => part.kind)]), [
    ["user", ["text", "image"]],
    ["assistant", ["thinking", "tool_use"]],
    ["tool", ["tool_result"]],
    ["assistant", ["text"]],
    ["user", ["unknown"]],
  ]);
  assert.deepEqual(view.messages[1]!.parts[0], { kind: "thinking", text: null });
  assert.equal((view.messages[2]!.parts[0] as { toolName: string }).toolName, "bash");
});

test("google-generative-ai: config holds system and tools; parts of every kind", () => {
  const log = new PiRequestLog(() => dir);
  log.record({
    model: "m",
    config: { maxOutputTokens: 10, systemInstruction: "You are Otter", tools: [{ functionDeclarations: [{ name: "bash", description: "Run", parametersJsonSchema: { type: "object" } }] }] },
    contents: [
      { role: "user", parts: [{ text: "hi" }, { inlineData: { mimeType: "image/webp", data: "A".repeat(4000) } }] },
      { role: "model", parts: [{ text: "hm", thought: true }, { functionCall: { id: "g1", name: "bash", args: { command: "ls" } } }] },
      { role: "user", parts: [{ functionResponse: { id: "g1", name: "bash", response: { output: "a.txt" } } }, { videoMetadata: {} }] },
    ],
  }, facts("google-generative-ai"));
  const { view } = viewOf(size());
  assert.deepEqual(view.system, [{ text: "You are Otter" }]);
  assert.deepEqual(view.tools, [{ name: "bash", description: "Run", inputSchema: { type: "object" } }]);
  assert.deepEqual(view.messages[0]!.parts[1], { kind: "image", mediaType: "image/webp", sizeBytes: 3000 });
  assert.deepEqual(view.messages[1], { role: "assistant", parts: [{ kind: "thinking", text: "hm" }, { kind: "tool_use", toolName: "bash", toolUseId: "g1", input: { command: "ls" } }] });
  assert.deepEqual(view.messages[2]!.parts, [
    { kind: "tool_result", toolName: "bash", toolUseId: "g1", output: '{"output":"a.txt"}', isError: false },
    { kind: "unknown", originalKind: "videoMetadata" },
  ]);
});

const sendCall = (id: string) => ({ type: "tool_use", id, name: "Bash", input: SEND });
const sendResult = (id: string, messageId: string) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `Message sent. Message ID: ${messageId}` }] });

test("verified needs the send: its result's Message ID, or a send call in the reply", () => {
  const log = new PiRequestLog(() => dir);
  const hi = { role: "user", content: "hi" };
  log.record({ messages: [hi] }, facts("anthropic-messages"));
  const offset = size();
  assert.equal(viewOf(offset).view.verification, undefined, "no next request yet: shown, unverified");
  log.record({ messages: [hi, { role: "assistant", content: [{ type: "text", text: "no send here" }] }, { role: "user", content: "more" }] }, facts("anthropic-messages"));
  const unrelated = viewOf(offset);
  assert.equal(unrelated.responseFound, true);
  assert.equal(unrelated.view.trigger, null);
  assert.equal(unrelated.view.verification, undefined, "a reply with no send is no proof");
});

test("two sends in one reply each highlight their own call", () => {
  const log = new PiRequestLog(() => dir);
  const hi = { role: "user", content: "hi" };
  log.record({ messages: [hi] }, facts("anthropic-messages"));
  const offset = size();
  log.record({ messages: [hi, { role: "assistant", content: [sendCall("a"), sendCall("b")] }, { role: "user", content: [
    { type: "tool_result", tool_use_id: "a", content: "Message ID: m1" },
    { type: "tool_result", tool_use_id: "b", content: "Message ID: m2" },
  ] }] }, facts("anthropic-messages"));
  const { view } = viewOf(offset);
  assert.deepEqual(view.trigger, { messageIndex: 1, partIndex: 0, toolUseId: "a" });
  assert.equal(view.verification, "verified");
});

test("an offset taken after the next request still finds the send's request", () => {
  const log = new PiRequestLog(() => dir);
  const hi = { role: "user", content: "hi" };
  const reply = { role: "assistant", content: [sendCall("a")] };
  log.record({ messages: [hi] }, facts("anthropic-messages"));
  log.record({ messages: [hi, reply, sendResult("a", "m1")] }, facts("anthropic-messages"));
  const { view } = viewOf(size());
  assert.equal(view.messages.length, 2, "the first request and its reply");
  assert.deepEqual(view.trigger, { messageIndex: 1, partIndex: 0, toolUseId: "a" });
});

test("no badge when what follows contradicts the send call", () => {
  const log = new PiRequestLog(() => dir);
  const hi = { role: "user", content: "hi" };
  log.record({ messages: [hi] }, facts("anthropic-messages"));
  const offset = size();
  log.record({ messages: [hi, { role: "assistant", content: [sendCall("y")] }, sendResult("y", "another-message")] }, facts("anthropic-messages"));
  const other = viewOf(offset);
  assert.equal(other.view.trigger, null, "that call sent another message: a background send landed here");
  assert.equal(other.view.verification, undefined);

  rmSync(file);
  const again = new PiRequestLog(() => dir);
  again.record({ messages: [hi] }, facts("anthropic-messages"));
  const second = size();
  again.record({ messages: [hi, { role: "assistant", content: [sendCall("y")] }, sendResult("elsewhere", "m1")] }, facts("anthropic-messages"));
  assert.equal(viewOf(second).view.verification, undefined, "this message's result is another call's");
});

test("a failed send here isn't this message's when its result is in a later turn", () => {
  const log = new PiRequestLog(() => dir);
  const hi = { role: "user", content: "hi" };
  log.record({ messages: [hi] }, facts("anthropic-messages"));
  const offset = size();
  log.record({ messages: [hi,
    { role: "assistant", content: [sendCall("failed")] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "failed", content: "error: network" }] },
    { role: "assistant", content: [sendCall("retry")] },
    sendResult("retry", "m1"),
  ] }, facts("anthropic-messages"));
  assert.equal(viewOf(offset).view.verification, undefined);
});

test("--json output is read like the plain one", () => {
  const log = new PiRequestLog(() => dir);
  const hi = { role: "user", content: "hi" };
  log.record({ messages: [hi] }, facts("anthropic-messages"));
  const offset = size();
  log.record({ messages: [hi, { role: "assistant", content: [sendCall("a"), sendCall("b")] }, { role: "user", content: [
    { type: "tool_result", tool_use_id: "a", content: '{"messageId":"m1"}' },
    { type: "tool_result", tool_use_id: "b", content: '{"messageId":"m2"}' },
  ] }] }, facts("anthropic-messages"));
  assert.deepEqual(viewOf(offset).view.trigger, { messageIndex: 1, partIndex: 0, toolUseId: "a" });
  rmSync(file);
  const other = new PiRequestLog(() => dir);
  other.record({ messages: [hi] }, facts("anthropic-messages"));
  const second = size();
  other.record({ messages: [hi, { role: "assistant", content: [sendCall("a")] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: '{"messageId":"another"}' }] }] }, facts("anthropic-messages"));
  assert.equal(viewOf(second).view.verification, undefined);
});

test("a provider without call ids pairs results with calls in order", () => {
  const log = new PiRequestLog(() => dir);
  const hi = { role: "user", parts: [{ text: "hi" }] };
  const call = { functionCall: { name: "bash", args: SEND } };
  log.record({ config: {}, contents: [hi] }, facts("google-generative-ai"));
  const offset = size();
  log.record({ config: {}, contents: [hi, { role: "model", parts: [call, call] }, { role: "user", parts: [
    { functionResponse: { name: "bash", response: { output: "Message ID: m1" } } },
    { functionResponse: { name: "bash", response: { output: "Message ID: m2" } } },
  ] }] }, facts("google-generative-ai"));
  assert.deepEqual(viewOf(offset).view.trigger, { messageIndex: 1, partIndex: 0, toolUseId: null });
});

test("a gap marked when it happened, after the send, costs only the reply", () => {
  const log = new PiRequestLog(() => dir);
  log.record({ messages: [{ role: "user", content: "hi" }] }, facts("anthropic-messages"));
  const offset = size();
  log.record({ context: { messages: [] } }, facts("pi-messages"));
  const restored = viewOf(offset);
  assert.equal(restored.responseFound, false);
  assert.equal(restored.view.verification, undefined);
});

test("a body that won't be recorded creates no log for a session with none", () => {
  new PiRequestLog(() => dir).record({ context: { messages: [] } }, facts("pi-messages"));
  assert.equal(existsSync(file), false);
});

test("a longer id is not this message's", () => {
  const log = new PiRequestLog(() => dir);
  const hi = { role: "user", content: "hi" };
  log.record({ messages: [hi] }, facts("anthropic-messages"));
  log.record({ messages: [hi, { role: "assistant", content: [sendCall("a")] }, sendResult("a", "m1-other")] }, facts("anthropic-messages"));
  assert.equal(viewOf(size()).view.messages.length, 3);
});

test("requests that went unrecorded around the send are refused, not guessed over", () => {
  let on = true;
  const log = new PiRequestLog(() => (on ? dir : null));
  const hi = { role: "user", content: "hi" };
  log.record({ messages: [hi] }, facts("anthropic-messages"));
  on = false;
  log.record({ messages: [hi, { role: "user", content: "unseen" }] }, facts("anthropic-messages"));
  on = true;
  const offset = size();
  assert.equal(viewOf(offset).view.verification, undefined, "nothing in the file says so yet: not verified");
  log.record({ messages: [hi, { role: "user", content: "unseen" }, { role: "assistant", content: [sendCall("a")] }] }, facts("anthropic-messages"));
  assert.deepEqual(restore(offset), { ok: false, failure: "not_recorded", refusal: "gap_off" });
});

test("a body that won't be recorded is marked at once", () => {
  const log = new PiRequestLog(() => dir);
  log.record({ messages: [{ role: "user", content: "hi" }] }, facts("anthropic-messages"));
  log.record({ context: { messages: [] } }, facts("pi-messages"));
  log.record({ context: { messages: [] } }, facts("pi-messages"));
  assert.deepEqual(restore(size()), { ok: false, failure: "not_recorded", refusal: "gap_unknown_body" });
  assert.equal(readFileSync(file, "utf8").split('"type":"gap"').length, 2, "once");
});

test("an offset past the end is another log under the same id", () => {
  new PiRequestLog(() => dir).record({ messages: [] }, facts("anthropic-messages"));
  assert.deepEqual(restore(size() + 1), { ok: false, failure: "not_found", refusal: "offset_past_end" });
});

test("a Responses reply is all its items, up to the tool's output", () => {
  const log = new PiRequestLog(() => dir);
  const hi = { role: "user", content: [{ type: "input_text", text: "hi" }] };
  log.record({ input: [hi] }, facts("openai-responses"));
  const offset = size();
  log.record({ input: [hi,
    { type: "reasoning", summary: [{ text: "hm" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "sending" }] },
    { type: "function_call", call_id: "c1", name: "bash", arguments: JSON.stringify(SEND) },
    { type: "function_call_output", call_id: "c1", output: "Message ID: m1" },
  ] }, facts("openai-responses"));
  const { view } = viewOf(offset);
  assert.deepEqual(view.messages[1]!.parts.map((part) => part.kind), ["thinking", "text", "tool_use"]);
  assert.deepEqual(view.trigger, { messageIndex: 1, partIndex: 2, toolUseId: "c1" });
  assert.equal(view.verification, "verified");
});

test("OpenRouter's breakpoint turning a tool's string into a block doesn't lose the reply", () => {
  const log = new PiRequestLog(() => dir);
  const hi = { role: "user", content: "hi" };
  log.record({ messages: [hi, { role: "tool", tool_call_id: "c0", content: [{ type: "text", text: "out", cache_control: { type: "ephemeral" } }] }] }, facts("openai-completions"));
  const offset = size();
  log.record({ messages: [hi, { role: "tool", tool_call_id: "c0", content: "out" }, { role: "assistant", content: "the reply" }] }, facts("openai-completions"));
  assert.equal(viewOf(offset).responseFound, true);
});

test("a cache-warming replay doesn't hide the reply", () => {
  const log = new PiRequestLog(() => dir);
  const hi = { role: "user", content: "hi" };
  log.record({ max_tokens: 100, messages: [hi] }, facts("anthropic-messages"));
  const offset = size();
  log.record({ max_tokens: 1, messages: [hi] }, facts("anthropic-messages"));
  log.record({ max_tokens: 100, messages: [hi, { role: "assistant", content: [sendCall("a")] }, sendResult("a", "m1")] }, facts("anthropic-messages"));
  assert.equal(viewOf(offset).view.verification, "verified");
});

test("what a provider puts elsewhere still shows: reasoning fields, Gemini tool images and errors", () => {
  const log = new PiRequestLog(() => dir);
  log.record({ messages: [
    { role: "assistant", content: "a", reasoning_text: "thought" },
    { role: "assistant", content: "b", reasoning_details: [{ type: "reasoning.encrypted" }] },
  ] }, facts("openai-completions"));
  assert.deepEqual(viewOf(size()).view.messages.map((message) => message.parts[0]), [{ kind: "thinking", text: "thought" }, { kind: "thinking", text: null }]);
  rmSync(file);
  new PiRequestLog(() => dir).record({ config: {}, contents: [{ role: "user", parts: [
    { functionResponse: { name: "shot", response: { output: "ok" }, parts: [{ inlineData: { mimeType: "image/png", data: "A".repeat(4000) } }] } },
    { functionResponse: { name: "bad", response: { error: "boom" } } },
  ] }] }, facts("google-vertex"));
  assert.deepEqual(viewOf(size()).view.messages[0]!.parts.map((part) => (part.kind === "tool_result" ? part.isError : part.kind)), [false, "image", true]);
});

test("the request shown is the last before the send, through several", () => {
  const log = new PiRequestLog(() => dir);
  const one = { role: "user", content: "one" };
  const two = { role: "assistant", content: [{ type: "text", text: "two" }] };
  const three = { role: "user", content: "three" };
  log.record({ messages: [one] }, facts("anthropic-messages"));
  const first = size();
  log.record({ messages: [one, two, three] }, facts("anthropic-messages"));
  const second = size();
  log.record({ messages: [{ role: "user", content: "summary" }] }, facts("anthropic-messages"));
  assert.equal(viewOf(first).view.messages.length, 2, "with the reply the next request kept");
  assert.deepEqual(viewOf(second).view.messages.map((message) => message.role), ["user", "assistant", "user"]);
  const rewritten = viewOf(second);
  assert.equal(rewritten.responseFound, false, "the next request rewrote history: no reply can be read");
  assert.equal(rewritten.view.verification, undefined);
});

test("Anthropic's cache breakpoint moving off the last message doesn't lose the reply", () => {
  const log = new PiRequestLog(() => dir);
  const text = { type: "text", text: "hi" };
  log.record({ messages: [{ role: "user", content: [{ ...text, cache_control: { type: "ephemeral" } }] }] }, facts("anthropic-messages"));
  const offset = size();
  log.record({ messages: [{ role: "user", content: [text] }, { role: "assistant", content: [{ type: "text", text: "the reply" }] }, { role: "user", content: [{ type: "text", text: "next", cache_control: { type: "ephemeral" } }] }] }, facts("anthropic-messages"));
  const restored = viewOf(offset);
  assert.equal(restored.responseFound, true);
  assert.deepEqual(restored.view.messages.at(-1), { role: "assistant", parts: [{ kind: "text", text: "the reply" }] });
});

test("a compaction summary at the start says so", () => {
  const log = new PiRequestLog(() => dir);
  const text = "The conversation history before this point was compacted into the following summary:\n\n<summary>did things</summary>";
  log.record({ messages: [{ role: "user", content: text }] }, facts("anthropic-messages"));
  assert.deepEqual(viewOf(size()).view.compaction, { happened: true, summary: { kind: "text", text } });
});

test("a refusal, never a best guess", () => {
  const log = new PiRequestLog(() => dir);
  const messages = [{ role: "user", content: "secret words" }];
  log.record({ system: "be", messages }, facts("anthropic-messages"));
  const good = readFileSync(file, "utf8");

  const refused = (text: string, offset = Buffer.byteLength(text)) => {
    writeFileSync(file, text);
    return restore(offset);
  };
  assert.deepEqual(refused(good.replace("secret words", "other words")), { ok: false, failure: "context_mismatch", refusal: "hash_mismatch" }, "a message edited");
  assert.deepEqual(refused(good.replace('"system":"be"', '"system":"xx"')), { ok: false, failure: "context_mismatch", refusal: "hash_mismatch" }, "the shape edited");
  const lines = good.trim().split("\n");
  assert.deepEqual(refused(`${lines.filter((line) => !line.includes('"type":"blob"')).join("\n")}\n`), { ok: false, failure: "context_mismatch", refusal: "hash_mismatch" }, "a message gone");
  const request = JSON.parse(lines.at(-1)!);
  assert.deepEqual(refused(`${lines.slice(0, -1).join("\n")}\n${JSON.stringify({ ...request, keep: 3, base: "nope" })}\n`), { ok: false, failure: "context_mismatch", refusal: "hash_mismatch" }, "a base that isn't there");
  assert.deepEqual(refused(good, 0), { ok: false, failure: "not_found", refusal: "no_request" });
  assert.deepEqual(refused(good.replace('"api":"anthropic-messages"', '"api":"bedrock-converse-stream"')), { ok: false, failure: "unsupported_runtime", refusal: "api_bedrock-converse-stream" });
  assert.deepEqual(refused(`${good}${JSON.stringify({ type: "gap", reason: "off", at: "x" })}\n`), { ok: false, failure: "not_recorded", refusal: "gap_off" }, "the last recorded request may not be this message's");
});

test("a line cut by a crash is passed over, and the request after it is still whole", () => {
  const log = new PiRequestLog(() => dir);
  log.record({ messages: [{ role: "user", content: "1" }] }, facts("anthropic-messages"));
  writeFileSync(file, `${readFileSync(file, "utf8")}{"type":"blob","hash":"cut`);
  new PiRequestLog(() => dir).record({ messages: [{ role: "user", content: "2" }] }, facts("anthropic-messages"));
  assert.deepEqual(viewOf(size()).view.messages, [{ role: "user", parts: [{ kind: "text", text: "2" }] }]);
});
