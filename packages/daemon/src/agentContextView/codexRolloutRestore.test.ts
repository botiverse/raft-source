import assert from "node:assert/strict";
import { test } from "vitest";
import { parseAgentContextViewResultBody } from "@botiverse/raft-shared";
import { restoreCodexContextView } from "./codexRolloutRestore";

// Records in the shape of a real Codex 0.167.0 rollout with a catalog model.
const line = (type: string, payload: unknown, timestamp = "2026-11-06T11:12:53.000Z") => `${JSON.stringify({ timestamp, type, payload })}\n`;
const passthrough = { internal_chat_message_metadata_passthrough: { turn_id: "t" } };
const item = (payload: Record<string, unknown>) => line("response_item", { ...payload, ...passthrough });
const SEND = JSON.stringify({ cmd: 'raft message send --target "#general"' });

const head = line("session_meta", { id: "thread-1", cli_version: "0.167.0" })
  + item({
    type: "additional_tools", id: "at", role: "developer",
    tools: [
      { type: "function", name: "exec_command", description: "Run", parameters: { type: "object" } },
      { type: "namespace", name: "collaboration", tools: [{ type: "function", name: "spawn_agent", description: "Spawn", parameters: {} }] },
    ],
  })
  + item({ type: "message", id: "d1", role: "developer", content: [{ type: "input_text", text: "You are Codex" }] })
  + line("turn_context", { model: "gpt-6.1-sol" })
  + item({ type: "message", id: "u1", role: "user", content: [{ type: "input_text", text: "hi" }] });

const reasoning = item({ type: "reasoning", id: "r1", summary: [{ type: "summary_text", text: "hm" }], encrypted_content: "ENC" });
const sendCall = (id = "c1", args = SEND) => item({ type: "function_call", id: `f${id}`, call_id: id, name: "exec_command", arguments: args });
const output = (id = "c1", text = "Output:\nMessage sent. Message ID: m1") => item({ type: "function_call_output", id: `o${id}`, call_id: id, output: text });
const usage = (input: number) => line("token_usage_record", { response_id: "r", usage: { input_tokens: input, cached_input_tokens: 2, total_tokens: input + 1 } });

function restore(text: string, offset: number | null = Buffer.byteLength(text), messageId = "m1") {
  const restored = restoreCodexContextView({ buffer: Buffer.from(text), offset, messageId, runtime: "codex", sessionId: "thread-1" });
  if (restored.ok) assert.ok(parseAgentContextViewResultBody({ ok: true, context: restored.view }).ok, "the server accepts it");
  return restored;
}

function viewOf(text: string, offset?: number | null, messageId?: string) {
  const restored = restore(text, offset, messageId);
  assert.ok(restored.ok, JSON.stringify(restored));
  return restored;
}

test("the request before the send: instructions, flattened tools, the reply and the send", () => {
  const before = head + reasoning + sendCall() + usage(100);
  const { view, responseFound } = viewOf(before + output() + item({ type: "message", id: "a2", role: "assistant", content: [{ type: "output_text", text: "done" }] }) + usage(200), Buffer.byteLength(before));
  assert.equal(responseFound, true);
  assert.equal(view.model, "gpt-6.1-sol");
  assert.deepEqual(view.source, { kind: "native", format: "codex-rollout", version: "0.167.0" });
  assert.equal(view.verification, undefined, "a rollout has no hash of the request");
  assert.deepEqual(view.system, [{ text: "You are Codex" }]);
  assert.deepEqual(view.tools.map((tool) => tool.name), ["exec_command", "collaboration.spawn_agent"]);
  assert.deepEqual(view.tokens, { input: 100, cacheRead: 2, total: 101 });
  assert.deepEqual(view.messages.map((message) => [message.role, message.parts.map((part) => part.kind)]), [
    ["user", ["text"]],
    ["assistant", ["thinking", "tool_use"]],
  ]);
  assert.deepEqual(view.trigger, { messageIndex: 1, partIndex: 1, toolUseId: "c1" });
  assert.ok(!JSON.stringify(view).includes("internal_chat"));
});

test("wherever the offset falls, the request is the same one", () => {
  const untilInput = head;
  const untilReply = untilInput + reasoning + sendCall();
  const whole = untilReply + output() + item({ type: "message", id: "a2", role: "assistant", content: [] });
  for (const offset of [untilInput, untilReply, untilReply + output()].map((text) => Buffer.byteLength(text))) {
    const { view } = viewOf(whole, offset);
    assert.equal(view.messages.length, 2, `offset ${offset}`);
    assert.deepEqual(view.trigger, { messageIndex: 1, partIndex: 1, toolUseId: "c1" });
  }
});

test("with no index line, the send's result places it", () => {
  const { view } = viewOf(head + sendCall() + output(), null);
  assert.deepEqual(view.trigger, { messageIndex: 1, partIndex: 0, toolUseId: "c1" });
  assert.deepEqual(restore(head + sendCall() + output(), null, "other"), { ok: false, failure: "not_found", refusal: "not_in_session" });
});

test("no tokens from a later request when this reply has none yet", () => {
  const before = head + sendCall();
  assert.deepEqual(viewOf(before + output() + usage(50), Buffer.byteLength(before)).view.tokens, { input: 50, cacheRead: 2, total: 51 });
  assert.deepEqual(viewOf(before).view.tokens, { input: null, cacheRead: null, total: null });
});

test("compaction replaces the history, and says so", () => {
  const replacement = [
    { type: "additional_tools", role: "developer", tools: [] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "a summary" }], ...passthrough },
  ];
  const text = head + sendCall("old") + output("old", "old") + usage(9) + line("compacted", { message: "Another language model started...", replacement_history: replacement });
  const { view } = viewOf(text + sendCall() + output());
  assert.deepEqual(view.compaction, { happened: true, summary: { kind: "text", text: "Another language model started..." } });
  assert.deepEqual(view.messages[0], { role: "user", parts: [{ kind: "text", text: "a summary" }] });
  assert.equal(view.tools.length, 0);
  assert.equal(view.tokens.input, null, "the usage before the compaction was another request's");
});

test("a compaction after the send doesn't lend its history to the reply", () => {
  const before = head + sendCall();
  const { view } = viewOf(before + line("compacted", { message: "m", replacement_history: [] }) + item({ type: "message", id: "x", role: "assistant", content: [] }), Buffer.byteLength(before));
  assert.equal(view.messages.length, 2);
  assert.equal(view.compaction.happened, false);
});

test("a remote compaction's ciphertext says encrypted", () => {
  const text = line("session_meta", {}) + item({ type: "additional_tools", tools: [] }) + line("compacted", { message: "", replacement_history: [{ type: "additional_tools", tools: [] }, { type: "compaction", encrypted_content: "x" }] });
  assert.deepEqual(viewOf(text).view.compaction, { happened: true, summary: { kind: "encrypted" } });
});

test("a reply that didn't send it isn't its request: a sub-agent's send lands on the root's rollout", () => {
  const before = head + sendCall();
  assert.deepEqual(restore(before + output("c1", "Message ID: another"), Buffer.byteLength(before)), { ok: false, failure: "not_found", refusal: "no_send_call" });
  const waiting = head + item({ type: "function_call", id: "w", call_id: "w", name: "wait_agent", arguments: "{}" });
  assert.deepEqual(restore(waiting), { ok: false, failure: "not_found", refusal: "no_send_call" });
});

test("a send reported later in this thread is shown, with no one call to point at", () => {
  const before = head + sendCall();
  const script = before + output("c1", "still running") + item({ type: "function_call", id: "fw", call_id: "w", name: "wait", arguments: "{}" }) + output("w", "Message ID: m1");
  const { view, responseFound } = viewOf(script, Buffer.byteLength(before));
  assert.equal(responseFound, true);
  assert.equal(view.trigger, null);
  const other = before + output("c1", "Message ID: another") + item({ type: "function_call", id: "fw", call_id: "w", name: "wait", arguments: "{}" }) + output("w", "Message ID: m1");
  assert.equal(viewOf(other, Buffer.byteLength(before)).responseFound, true, "shown, though its call's result names another message");
});

test("an item it doesn't know stays with the input: a sub-agent's message that led to the send", () => {
  const agentMessage = item({ type: "agent_message", author: "/root/worker", content: [{ type: "input_text", text: "FINAL_ANSWER" }] });
  const { view, responseFound } = viewOf(head + agentMessage + sendCall() + output());
  assert.equal(responseFound, true);
  assert.deepEqual(view.messages[0]!.parts.map((part) => part.kind), ["text", "unknown"]);
  assert.deepEqual(view.trigger, { messageIndex: 1, partIndex: 0, toolUseId: "c1" });
});

test("a call type it doesn't know is part of the reply, as the projection has it", () => {
  const future = item({ type: "future_tool_call", id: "ft", call_id: "ft" });
  assert.deepEqual(viewOf(head + future + sendCall() + output()).view.trigger, { messageIndex: 1, partIndex: 1, toolUseId: "c1" });
});

test("a hosted tool's call is part of the reply", () => {
  const search = item({ type: "web_search_call", id: "ws", status: "completed", action: { type: "search", query: "x" } });
  const { view } = viewOf(head + search + sendCall() + output());
  assert.deepEqual(view.messages[1]!.parts.map((part) => (part.kind === "tool_use" ? part.toolName : part.kind)), ["web_search", "exec_command"]);
});

test("a later tool list updates the earlier one", () => {
  const update = item({ type: "additional_tools", tools: [{ type: "function", name: "exec_command", description: "Run it", parameters: {} }, { type: "function", name: "new_tool", parameters: {} }] });
  const { view } = viewOf(head + update + sendCall());
  assert.deepEqual(view.tools.map((tool) => [tool.name, tool.description]), [["exec_command", "Run it"], ["collaboration.spawn_agent", "Spawn"], ["new_tool", ""]]);
});

test("--json in an array output counts for a late offset; another tool's text doesn't read as a send", () => {
  const exec = item({ type: "custom_tool_call", id: "e", call_id: "e", name: "exec", input: "raft message send --json" });
  const result = item({ type: "custom_tool_call_output", id: "eo", call_id: "e", output: [{ type: "input_text", text: '{"messageId":"m1"}' }] });
  assert.equal(viewOf(head + exec + result).view.messages.length, 2, "steps back to the request before the call");
  const patch = item({ type: "custom_tool_call", id: "p", call_id: "p", name: "apply_patch", input: "docs: use raft message send" });
  assert.deepEqual(restore(head + patch), { ok: false, failure: "not_found", refusal: "no_send_call" });
});

test("custom tools, and a custom tool's script as the send", () => {
  const custom = item({ type: "custom_tool_call", id: "cc", call_id: "c9", name: "exec", input: 'tools.exec_command({cmd: "raft message send --target x"})' });
  const { view } = viewOf(head + custom + item({ type: "custom_tool_call_output", id: "co", call_id: "c9", output: [{ type: "input_text", text: "ok" }] }), Buffer.byteLength(head + custom));
  assert.deepEqual(view.trigger, { messageIndex: 1, partIndex: 0, toolUseId: "c9" });
});

test("a refusal, not a guess", () => {
  const noTools = line("session_meta", {}) + item({ type: "message", role: "user", content: [] });
  assert.deepEqual(restore(noTools), { ok: false, failure: "unsupported_runtime", refusal: "no_additional_tools" });
  assert.deepEqual(restore(line("session_meta", {})), { ok: false, failure: "not_found", refusal: "no_request" });
  assert.deepEqual(restore(head, Buffer.byteLength(head) + 1), { ok: false, failure: "not_found", refusal: "offset_past_end" });
  assert.deepEqual(restore(head + line("event_msg", { type: "thread_rolled_back", num_turns: 1 })), { ok: false, failure: "context_mismatch", refusal: "rolled_back" });
});

test("a line still being written is passed over", () => {
  const { view } = viewOf(`${head}${sendCall()}{"type":"response_item","payl`, Buffer.byteLength(head));
  assert.equal(view.messages.length, 2);
});
