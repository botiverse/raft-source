import { describe, expect, it, vi } from "vitest";
import { hashLlmRequestMessages, rebuildLastLlmRequest } from "@botiverse/kimi-code-sdk";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseAgentContextView } from "@botiverse/raft-shared";
import {
  findKimiSendRecord,
  KIMI_RESTORE_MAX_CONTEXT_RECORDS,
  type KimiRebuiltMessage,
  type KimiRequestRebuild,
  type KimiRequestRebuilder,
  type KimiWireRecord,
  parseKimiWireRecords,
  restoreKimiContextView,
} from "./kimiSessionRestore";

const MESSAGE_ID = "11111111-2222-4333-8444-555555555555";

function jsonl(records: readonly KimiWireRecord[]): Buffer {
  return Buffer.from(records.map((record) => `${JSON.stringify(record)}\n`).join(""), "utf8");
}

const REQUEST: KimiWireRecord = { type: "llm.request", kind: "loop", model: "kimi-k9", time: Date.UTC(2026, 10, 6, 1, 2, 3) };
const USAGE: KimiWireRecord = { type: "usage.record", usageScope: "turn", usage: { inputOther: 10, inputCacheRead: 5, inputCacheCreation: 1, output: 3 } };

function toolResult(toolCallId: string, output: unknown): KimiWireRecord {
  return { type: "context.append_loop_event", event: { type: "tool.result", toolCallId, result: { output } } };
}

function toolCall(toolCallId: string, command: string): KimiWireRecord {
  return { type: "context.append_loop_event", event: { type: "tool.call", toolCallId, name: "Bash", args: { command } } };
}

const SEND_CALL = toolCall("call_send", "raft message send --target x");
const SEND_RESULT = toolResult("call_send", `Message sent to #general. Message ID: ${MESSAGE_ID}`);

const USER: KimiRebuiltMessage = { role: "user", content: [{ type: "text", text: "Say hi" }], toolCalls: [] };
const RESPONSE: KimiRebuiltMessage = {
  role: "assistant",
  content: [{ type: "think", think: "ok" }, { type: "text", text: "Sending." }],
  toolCalls: [
    { id: "call_other", name: "Bash", arguments: "{\"command\":\"ls\"}" },
    { id: "call_send", name: "Bash", arguments: "{\"command\":\"raft message send --target x\"}" },
  ],
};

function rebuilt(overrides: Partial<Extract<KimiRequestRebuild, { status: "rebuilt" }>> = {}): KimiRequestRebuild {
  return {
    status: "rebuilt",
    verification: "verified",
    request: { model: "kimi-k9" },
    protocolVersion: "1.5",
    systemPrompt: "You are Kimi.",
    tools: [{ name: "Bash", description: "Run", parameters: { type: "object" } }],
    messages: [USER],
    response: RESPONSE,
    ...overrides,
  };
}

function restore(buffer: Buffer, rebuild: KimiRequestRebuilder, offset: number | null = null) {
  return restoreKimiContextView({ buffer, offset, messageId: MESSAGE_ID, runtime: "kimi-sdk", sessionId: "sess-1", rebuild });
}

describe("Kimi session restore", () => {
  it("turns the SDK's rebuild into a view the shared parser accepts", () => {
    const result = restore(jsonl([REQUEST, USAGE, SEND_CALL, SEND_RESULT]), () => rebuilt());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const view = parseAgentContextView(JSON.parse(JSON.stringify(result.view)));
    expect(view.ok).toBe(true);
    expect(result.view).toMatchObject({
      runtime: "kimi-sdk",
      model: "kimi-k9",
      sessionId: "sess-1",
      messageId: MESSAGE_ID,
      requestAt: "2026-11-06T01:02:03.000Z",
      tokens: { input: 11, cacheRead: 5, total: 16 },
      system: [{ text: "You are Kimi." }],
      tools: [{ name: "Bash", description: "Run", inputSchema: { type: "object" } }],
      compaction: { happened: false },
      source: { kind: "native", format: "kimi-wire", version: "1.5" },
      verification: "verified",
    });
    expect(result.view.messages[1]?.parts).toEqual([
      { kind: "thinking", text: "ok" },
      { kind: "text", text: "Sending." },
      { kind: "tool_use", toolName: "Bash", toolUseId: "call_other", input: { command: "ls" } },
      { kind: "tool_use", toolName: "Bash", toolUseId: "call_send", input: { command: "raft message send --target x" } },
    ]);
  });

  it("points the trigger at the call whose result reports the message, not just the last send-looking one", () => {
    const send = toolResult("call_other", `Message ID: ${MESSAGE_ID}`);
    const result = restore(jsonl([REQUEST, toolCall("call_other", "raft task reply x"), send]), () => rebuilt());

    expect(result.ok && result.view.trigger).toEqual({ messageIndex: 1, partIndex: 2, toolUseId: "call_other" });
  });

  it("cuts the records at the tool result, so a later request is never picked", () => {
    const rebuild = vi.fn<KimiRequestRebuilder>(() => rebuilt());
    const later: KimiWireRecord = { type: "llm.request", kind: "loop", model: "later" };

    restore(jsonl([REQUEST, SEND_CALL, SEND_RESULT, later]), rebuild);

    expect((rebuild.mock.calls[0]![0] as KimiWireRecord[]).map((record) => record.type)).toEqual(["llm.request", "context.append_loop_event"]);
  });

  it("prefers the send's tool result to an index offset that is too early", () => {
    const rebuild = vi.fn<KimiRequestRebuilder>(() => rebuilt());

    restore(jsonl([REQUEST, SEND_CALL, SEND_RESULT]), rebuild, 0);

    expect(rebuild.mock.calls[0]![0]).toHaveLength(2);
  });

  it("takes a script's result as the send when its call was already running at the index offset", () => {
    const head = jsonl([REQUEST, toolCall("call_send", "./notify.sh")]);
    const buffer = Buffer.concat([head, jsonl([SEND_RESULT])]);

    const result = restore(buffer, () => rebuilt(), head.length);

    expect(result.ok && result.view.trigger).toMatchObject({ toolUseId: "call_send" });
  });

  it("does not take the parent's Agent call for a sub-agent's send, though it was running at the index offset", () => {
    const rebuild = vi.fn<KimiRequestRebuilder>(() => rebuilt({ response: { role: "assistant", content: [], toolCalls: [{ id: "call_agent", name: "Agent", arguments: "{}" }] } }));
    const agentCall: KimiWireRecord = { type: "context.append_loop_event", event: { type: "tool.call", toolCallId: "call_agent", name: "Agent", args: { prompt: "tell them" } } };
    const head = jsonl([REQUEST, agentCall]);
    const buffer = Buffer.concat([head, jsonl([toolResult("call_agent", `Sent it. Message ID: ${MESSAGE_ID}`)])]);

    expect(restore(buffer, rebuild, head.length)).toEqual({ ok: false, failure: "not_found", refusal: "no_send_call" });
  });

  it("answers too_large past the record limit, without running the rebuild", () => {
    const rebuild = vi.fn<KimiRequestRebuilder>(() => rebuilt());
    const appended = Array.from({ length: KIMI_RESTORE_MAX_CONTEXT_RECORDS + 1 }, (): KimiWireRecord => ({ type: "context.append_message" }));

    expect(restore(jsonl([...appended, REQUEST, SEND_CALL, SEND_RESULT]), rebuild)).toEqual({ ok: false, failure: "too_large", refusal: "too_many_context_records" });
    expect(rebuild).not.toHaveBeenCalled();
  });

  it.each(["context.apply_compaction", "context.clear"])("counts the record limit only from the last %s", (type) => {
    const rebuild = vi.fn<KimiRequestRebuilder>(() => rebuilt());
    const appended = Array.from({ length: KIMI_RESTORE_MAX_CONTEXT_RECORDS + 1 }, (): KimiWireRecord => ({ type: "context.append_message" }));

    expect(restore(jsonl([...appended, { type }, REQUEST, SEND_CALL, SEND_RESULT]), rebuild).ok).toBe(true);
  });

  it("counts only the records before the request towards the limit, and only context ones", () => {
    const rebuild = vi.fn<KimiRequestRebuilder>(() => rebuilt());
    const others = Array.from({ length: KIMI_RESTORE_MAX_CONTEXT_RECORDS + 1 }, (): KimiWireRecord => ({ type: "usage.record" }));

    expect(restore(jsonl([...others, REQUEST, SEND_CALL, SEND_RESULT]), rebuild).ok).toBe(true);
  });

  it("does not take a later output that only quotes the id for the send", () => {
    const rebuild = vi.fn<KimiRequestRebuilder>(() => rebuilt());
    const head = jsonl([REQUEST, SEND_CALL]);
    const buffer = Buffer.concat([
      head,
      jsonl([toolResult("call_send", "sent, output piped away"), { type: "llm.request", kind: "loop" }, toolCall("call_cat", "cat send.log"), toolResult("call_cat", `Message ID: ${MESSAGE_ID}`)]),
    ]);

    const result = restore(buffer, rebuild, head.length);

    expect(rebuild.mock.calls[0]![0]).toHaveLength(2);
    expect(result).toMatchObject({ ok: true, view: { trigger: { toolUseId: "call_send" } } });
  });

  it("uses the index offset when no result reports the message, if the request's response holds a send call", () => {
    const rebuild = vi.fn<KimiRequestRebuilder>(() => rebuilt());
    const head = jsonl([REQUEST, SEND_CALL]);
    const buffer = Buffer.concat([head, jsonl([{ type: "llm.request", kind: "loop", model: "later" }])]);

    const result = restore(buffer, rebuild, head.length);

    expect(rebuild.mock.calls[0]![0]).toHaveLength(2);
    expect(result).toMatchObject({ ok: true, view: { trigger: { toolUseId: "call_send" } } });
  });

  it("refuses when nothing ties the request to the message, as with a sub-agent's send", () => {
    const parent: KimiRebuiltMessage = { role: "assistant", content: [], toolCalls: [{ id: "call_agent", name: "Agent", arguments: "{\"prompt\":\"do it\"}" }] };
    const head = jsonl([REQUEST]);

    expect(restore(head, () => rebuilt({ response: parent }), head.length)).toEqual({ ok: false, failure: "not_found", refusal: "no_send_call" });
    expect(restore(head, () => rebuilt({ response: undefined }), head.length)).toEqual({ ok: false, failure: "not_found", refusal: "no_send_call" });
  });

  it("answers not_found for a message with neither a tool result nor an index line", () => {
    const rebuild = vi.fn<KimiRequestRebuilder>(() => rebuilt());

    expect(restore(jsonl([REQUEST]), rebuild)).toEqual({ ok: false, failure: "not_found", refusal: "not_in_session" });
    expect(rebuild).not.toHaveBeenCalled();
  });

  it("keeps a rebuilt-only session labelled as such", () => {
    const result = restore(jsonl([REQUEST, SEND_CALL, SEND_RESULT]), () => rebuilt({ verification: "count_matched" }));

    expect(result.ok && result.view.verification).toBe("count_matched");
  });

  it.each([
    ["messages_hash_mismatch", "context_mismatch"],
    ["message_count_mismatch", "context_mismatch"],
    ["system_prompt_mismatch", "context_mismatch"],
    ["tools_mismatch", "context_mismatch"],
    ["tools_unavailable", "context_mismatch"],
    ["media_projection", "media_removed"],
    ["newer_wire_version", "newer_session_format"],
    ["no_request", "not_found"],
    ["replay_failed", "read_failed"],
    ["a_reason_from_a_newer_sdk", "read_failed"],
  ])("refuses on the SDK's %s as %s", (reason, failure) => {
    const result = restore(jsonl([REQUEST, SEND_CALL, SEND_RESULT]), () => ({ status: "refused", reason, detail: "d" }));

    expect(result).toEqual({ ok: false, failure, refusal: reason });
  });

  it("renders a tool message as its result, with images as their own parts and the call's tool name", () => {
    const toolMessage: KimiRebuiltMessage = {
      role: "tool",
      toolCallId: "call_other",
      content: [
        { type: "text", text: "line 1" },
        { type: "image_url", imageUrl: { url: "data:image/png;base64,AAAA" } },
        { type: "text", text: "line 2" },
      ],
    };
    const result = restore(jsonl([REQUEST, SEND_CALL, SEND_RESULT]), () => rebuilt({ messages: [USER, RESPONSE, toolMessage] }));

    expect(result.ok && result.view.messages[2]).toEqual({
      role: "tool",
      parts: [
        { kind: "tool_result", toolName: "Bash", toolUseId: "call_other", output: "line 1\nline 2", isError: false },
        { kind: "image", mediaType: "image/png", sizeBytes: 3 },
      ],
    });
  });

  it("carries no image bytes, and keeps a dehydrated image as one of unknown type", () => {
    const message: KimiRebuiltMessage = {
      role: "user",
      content: [
        { type: "image_url", imageUrl: { url: "data:image/png;base64,SECRETBYTES" } },
        { type: "image_url", imageUrl: { url: "blobref:abc" } },
      ],
    };
    const result = restore(jsonl([REQUEST, SEND_CALL, SEND_RESULT]), () => rebuilt({ messages: [message] }));

    expect(result.ok && JSON.stringify(result.view)).not.toContain("SECRETBYTES");
    expect(result.ok && result.view.messages[0]?.parts[1]).toEqual({ kind: "image", mediaType: null, sizeBytes: null });
  });

  it("marks a failed tool's result as an error, wall time or not", () => {
    const failed = (text: string): KimiRebuiltMessage => ({ role: "tool", toolCallId: "c", content: [{ type: "text", text }] });
    const result = restore(jsonl([REQUEST, SEND_CALL, SEND_RESULT]), () =>
      rebuilt({ messages: [failed("<system>ERROR: failed.</system>\nboom"), failed("Wall time: 1.000 seconds\n<system>ERROR: failed.</system>"), failed("ERROR is just a word")] }),
    );

    expect(result.ok && result.view.messages.slice(0, 3).map((message) => message.parts[0])).toMatchObject([{ isError: true }, { isError: true }, { isError: false }]);
  });

  it("shows a call with no name as unknown, so the view still parses", () => {
    const response: KimiRebuiltMessage = { role: "assistant", content: [], toolCalls: [{ id: "call_send", arguments: "{}" }] };
    const result = restore(jsonl([REQUEST, SEND_CALL, SEND_RESULT]), () => rebuilt({ response }));

    expect(result.ok && parseAgentContextView(JSON.parse(JSON.stringify(result.view))).ok).toBe(true);
    expect(result.ok && result.view.messages[1]?.parts[0]).toMatchObject({ toolName: "unknown" });
  });

  it("reports tokens as unknown when the provider gave none, and counts cache creation as input", () => {
    const empty: KimiWireRecord = { type: "usage.record", usageScope: "turn", usage: { inputOther: 0, inputCacheRead: 0, inputCacheCreation: 0, output: 0 } };
    const none = restore(jsonl([REQUEST, empty, SEND_CALL, SEND_RESULT]), () => rebuilt());
    expect(none.ok && none.view.tokens).toEqual({ input: null, cacheRead: null, total: null });

    const some = restore(jsonl([REQUEST, USAGE, SEND_CALL, SEND_RESULT]), () => rebuilt());
    expect(some.ok && some.view.tokens).toEqual({ input: 11, cacheRead: 5, total: 16 });
  });

  it("keeps arguments that are not JSON as they are", () => {
    const response: KimiRebuiltMessage = { role: "assistant", content: [], toolCalls: [{ id: "c", name: "Bash", arguments: "{broken" }] };
    const result = restore(jsonl([REQUEST, SEND_CALL, SEND_RESULT]), () => rebuilt({ response }));

    expect(result.ok && result.view.messages[1]?.parts[0]).toMatchObject({ input: "{broken" });
  });

  it("reports the compaction before the request, and none after a clear", () => {
    const compaction: KimiWireRecord = { type: "context.apply_compaction", contextSummary: "Earlier: said hi." };
    const compacted = restore(jsonl([compaction, REQUEST, SEND_CALL, SEND_RESULT]), () => rebuilt());
    expect(compacted.ok && compacted.view.compaction).toEqual({ happened: true, summary: { kind: "text", text: "Earlier: said hi." } });

    const cleared = restore(jsonl([compaction, { type: "context.clear" }, REQUEST, SEND_CALL, SEND_RESULT]), () => rebuilt());
    expect(cleared.ok && cleared.view.compaction).toEqual({ happened: false });
  });

  it("does not take a mention of the id outside a tool result for the send", () => {
    const quoted: KimiWireRecord = { type: "context.append_message", message: { content: [{ type: "text", text: `Message ID: ${MESSAGE_ID}` }] } };

    const call = toolCall("c", "raft message send --target x");
    expect(findKimiSendRecord(jsonl([quoted]), MESSAGE_ID)).toBeNull();
    expect(findKimiSendRecord(jsonl([call, toolResult("c", `Message ID: ${MESSAGE_ID}-extra`)]), MESSAGE_ID)).toBeNull();
    expect(findKimiSendRecord(jsonl([quoted, call, toolResult("c", `Message ID: ${MESSAGE_ID}`)]), MESSAGE_ID)?.toolCallId).toBe("c");
  });

  it("leaves out a torn last line, and keeps a bad line's place so line numbers hold", () => {
    const whole = jsonl([REQUEST]);
    const buffer = Buffer.concat([whole, Buffer.from("not json\n", "utf8"), jsonl([USAGE]), Buffer.from("{\"type\":\"llm.req", "utf8")]);

    expect(parseKimiWireRecords(buffer).map((record) => record.type)).toEqual(["llm.request", "raft.unreadable_line", "usage.record"]);
  });
});

describe("Kimi session restore on the real SDK", () => {
  const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
  const tools = [{ name: "Bash", description: "Run a command", parameters: { type: "object" } }];
  const toolsJson = JSON.stringify(tools);
  const sent = [{ role: "user", content: [{ type: "text", text: "Say hi" }], toolCalls: [] }];

  function session(request: Record<string, unknown>): KimiWireRecord[] {
    return [
      { type: "metadata", protocol_version: "1.5", created_at: 1 },
      { type: "config.update", agentId: "main", systemPrompt: "You are Kimi." },
      { type: "context.append_message", agentId: "main", message: sent[0]! },
      { type: "context.append_loop_event", agentId: "main", event: { type: "step.begin", uuid: "s1", turnId: "0", step: 1 } },
      { type: "llm.tools_snapshot", agentId: "main", hash: sha256(toolsJson), tools },
      {
        type: "llm.request",
        agentId: "main",
        kind: "loop",
        provider: "openai",
        model: "kimi-k9",
        toolSelect: false,
        systemPromptHash: sha256("You are Kimi."),
        toolsHash: sha256(toolsJson),
        messageCount: 1,
        time: Date.UTC(2026, 10, 6),
        ...request,
      },
      { type: "context.append_loop_event", agentId: "main", event: { type: "content.part", stepUuid: "s1", part: { type: "text", text: "Sending." } } },
      { type: "context.append_loop_event", agentId: "main", event: { type: "tool.call", stepUuid: "s1", toolCallId: "call_send", name: "Bash", args: { command: "raft message send --target x" } } },
      { type: "context.append_loop_event", agentId: "main", event: { type: "tool.result", toolCallId: "call_send", result: { output: `Message ID: ${MESSAGE_ID}` } } },
    ];
  }

  const realRebuild = rebuildLastLlmRequest as unknown as KimiRequestRebuilder;
  const hash = hashLlmRequestMessages(sent as unknown as Parameters<typeof hashLlmRequestMessages>[0]);

  it("verifies a session with a messages hash, and the view holds what was sent, the response and the trigger", () => {
    const result = restore(jsonl(session({ messagesHash: hash })), realRebuild);

    if (!result.ok) throw new Error(result.refusal);
    expect(parseAgentContextView(JSON.parse(JSON.stringify(result.view))).ok).toBe(true);
    expect(result.view).toMatchObject({
      verification: "verified",
      system: [{ text: "You are Kimi." }],
      tools: [{ name: "Bash" }],
      trigger: { messageIndex: 1, toolUseId: "call_send" },
      source: { format: "kimi-wire", version: "1.5" },
    });
    expect(result.view.messages[0]).toEqual({ role: "user", parts: [{ kind: "text", text: "Say hi" }] });
    expect(result.view.messages[1]?.parts[0]).toEqual({ kind: "text", text: "Sending." });
  });

  it("labels a session with no hash as count-matched", () => {
    const result = restore(jsonl(session({})), realRebuild);

    expect(result.ok && result.view.verification).toBe("count_matched");
  });

  it("refuses a hash that does not match, as context_mismatch", () => {
    expect(restore(jsonl(session({ messagesHash: "not-the-hash" })), realRebuild)).toEqual({
      ok: false,
      failure: "context_mismatch",
      refusal: "messages_hash_mismatch",
    });
  });
});

// A wire.jsonl written by the real SDK (2.3.1-botiverse.1), not by hand: a
// harness launched the way the kimi-sdk driver launches one (roleAdditional,
// tool base env with a `raft` wrapper on PATH, session-scoped approval), its
// "kimi" provider pointed at a scripted local chat-completions server. Turn 1
// is a plain reply; in turn 2 the model runs `raft message send` through Bash
// (a stub that reports the message id) and then answers. Run with the work
// dir at /work, so the recorded paths are neutral; the file is unedited.
// After a @botiverse/kimi-code-sdk bump, re-record it with
// fixtures/kimi-sdk-wire.record/run.sh, then update the values this test pins
// from the new file (requestAt is the recording's time; the record and
// message shapes change only if the SDK's did).
describe("Kimi session restore on a session the SDK wrote", () => {
  const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
  const wire = readFileSync(path.join(import.meta.dirname, "fixtures", "kimi-sdk-wire.jsonl"));

  it("finds the send, rebuilds the request it came from, and verifies it against the SDK's own hashes", () => {
    const send = findKimiSendRecord(wire, MESSAGE_ID);
    expect(send).toMatchObject({ toolCallId: "call_send_1" });

    const records = parseKimiWireRecords(wire.subarray(0, send!.offset));
    const request = records.filter((record) => record.type === "llm.request" && record.kind === "loop").at(-1)!;
    expect(request).toMatchObject({ turnStep: "1.1", messageCount: 4 });
    const rebuilt = rebuildLastLlmRequest(records as Parameters<typeof rebuildLastLlmRequest>[0]);

    if (rebuilt.status !== "rebuilt") throw new Error(`${rebuilt.reason}: ${rebuilt.detail}`);
    expect(rebuilt.verification).toBe("verified");
    expect(rebuilt.systemPrompt).toContain("fixture-agent");
    expect(sha256(rebuilt.systemPrompt)).toBe(request.systemPromptHash);
    expect(rebuilt.tools.map((tool) => tool.name)).toContain("Bash");
    expect(sha256(JSON.stringify(rebuilt.tools))).toBe(request.toolsHash);
    expect(rebuilt.messages).toHaveLength(4);
    expect(hashLlmRequestMessages(rebuilt.messages)).toBe(request.messagesHash);
  });

  it("restores a view of that request, its response and the send call", () => {
    const result = restore(wire, rebuildLastLlmRequest as unknown as KimiRequestRebuilder);

    if (!result.ok) throw new Error(result.refusal);
    expect(parseAgentContextView(JSON.parse(JSON.stringify(result.view))).ok).toBe(true);
    expect(result.responseFound).toBe(true);
    expect(result.view).toMatchObject({
      model: "kimi-for-coding",
      requestAt: "2026-11-07T18:50:32.305Z",
      tokens: { input: 150, cacheRead: 1100, total: 1250 },
      compaction: { happened: false },
      source: { kind: "native", format: "kimi-wire", version: "1.5" },
      verification: "verified",
      trigger: { messageIndex: 4, partIndex: 2, toolUseId: "call_send_1" },
    });
    expect(result.view.system[0]?.text).toContain("The current working directory is `/work`.");
    expect(result.view.tools.length).toBeGreaterThan(1);
    // The SDK adds the date as a user message of its own after the first prompt.
    expect(result.view.messages.map((message) => [message.role, message.parts.map((part) => part.kind)])).toEqual([
      ["user", ["text"]],
      ["user", ["text"]],
      ["assistant", ["thinking", "text"]],
      ["user", ["text"]],
      ["assistant", ["thinking", "text", "tool_use"]],
    ]);
    expect(result.view.messages[1]?.parts[0]).toMatchObject({ text: expect.stringContaining("<system-reminder>") });
    expect(result.view.messages[4]?.parts).toEqual([
      { kind: "thinking", text: "I should post the greeting with the raft CLI." },
      { kind: "text", text: "Posting it now." },
      { kind: "tool_use", toolName: "Bash", toolUseId: "call_send_1", input: { command: "raft message send --target \"#general\" <<'X'\nHello from the fixture agent.\nX" } },
    ]);
  });
});
