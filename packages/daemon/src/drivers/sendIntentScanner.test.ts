import assert from "node:assert/strict";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { ClaudeEventNormalizer } from "./claudeEventNormalizer";
import { GrokEventNormalizer, type GrokJsonRpcMessage } from "./grokEventNormalizer";
import { createKimiSdkEventMappingState, mapKimiSdkEventToParsedEvents } from "./kimi-sdk";
import { createPiSdkEventMappingState, mapPiSdkEventToParsedEvents } from "./pi";
import { extractPartialJsonStringField, MAX_SCANNED_ARGS_CHARS, SendIntentArgumentScanner } from "./sendIntentScanner";
import type { ParsedEvent } from "./types";

const SEND_COMMAND = "raft message send --target '#general' <<'EOF'\nit's \"done\" \\o/ — ok\nEOF";
const SEND_ARGS_JSON = JSON.stringify({ command: SEND_COMMAND, description: "Post the update" });
/** Where in the JSON the target token is complete (its closing quote). */
const TARGET_READY_AT = SEND_ARGS_JSON.indexOf("'#general'") + "'#general'".length;

function chunks(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function sendIntents(events: ParsedEvent[]): Array<Extract<ParsedEvent, { kind: "send_intent" }>> {
  return events.filter((event): event is Extract<ParsedEvent, { kind: "send_intent" }> => event.kind === "send_intent");
}

describe("extractPartialJsonStringField", () => {
  test("reads a complete field and decodes escapes", () => {
    assert.deepEqual(extractPartialJsonStringField(SEND_ARGS_JSON, "command"), { value: SEND_COMMAND, complete: true });
    assert.deepEqual(
      extractPartialJsonStringField(JSON.stringify({ command: "a\u00e9\u{1F600}\tb" }), "command"),
      { value: "a\u00e9\u{1F600}\tb", complete: true },
    );
    assert.deepEqual(extractPartialJsonStringField('{"command":"x\\u00e9"}', "command"), { value: "xé", complete: true });
  });

  test("reads an unterminated value, dropping a cut-off escape", () => {
    assert.deepEqual(extractPartialJsonStringField('{"command": "raft mess', "command"), { value: "raft mess", complete: false });
    assert.deepEqual(extractPartialJsonStringField('{"command":"a\\', "command"), { value: "a", complete: false });
    assert.deepEqual(extractPartialJsonStringField('{"command":"a\\u00', "command"), { value: "a", complete: false });
    assert.deepEqual(extractPartialJsonStringField('{"command":"a\\"b', "command"), { value: 'a"b', complete: false });
  });

  test("skips other fields, nested values included", () => {
    const json = JSON.stringify({ description: 'has "command": "fake"', opts: { command: "nested", list: ["}", "{"] }, timeout: 5, command: "real" });
    assert.deepEqual(extractPartialJsonStringField(json, "command"), { value: "real", complete: true });
    assert.equal(extractPartialJsonStringField('{"description":"still typ', "command"), null);
    assert.equal(extractPartialJsonStringField('{"comm', "command"), null);
    assert.equal(extractPartialJsonStringField("", "command"), null);
    assert.equal(extractPartialJsonStringField('{"command": 5}', "command"), null);
    assert.equal(extractPartialJsonStringField("[1,2]", "command"), null);
  });

  test("every prefix of a JSON object yields a prefix of the field", () => {
    for (let end = 0; end <= SEND_ARGS_JSON.length; end += 1) {
      const got = extractPartialJsonStringField(SEND_ARGS_JSON.slice(0, end), "command");
      if (got) assert.ok(SEND_COMMAND.startsWith(got.value), `prefix ${end}: ${JSON.stringify(got.value)}`);
    }
  });
});

describe("SendIntentArgumentScanner", () => {
  test("one early intent, once the target token is complete", () => {
    const scanner = new SendIntentArgumentScanner();
    let consumed = 0;
    const found: Array<{ at: number; event: unknown }> = [];
    for (const chunk of chunks(SEND_ARGS_JSON, 3)) {
      consumed += chunk.length;
      const event = scanner.append("call-1", "Bash", chunk);
      if (event) found.push({ at: consumed, event });
    }
    assert.equal(found.length, 1);
    assert.deepEqual(found[0]!.event, { kind: "send_intent", callId: "call-1", target: "#general", early: true });
    assert.ok(found[0]!.at >= TARGET_READY_AT && found[0]!.at < TARGET_READY_AT + 3);
    // Complete arguments afterwards do not announce it again.
    assert.equal(scanner.complete("call-1", "Bash", { command: SEND_COMMAND }), null);
  });

  test("ignores non-shell tools and non-send commands", () => {
    const scanner = new SendIntentArgumentScanner();
    assert.equal(scanner.append("c1", "Read", SEND_ARGS_JSON), null);
    assert.equal(scanner.append("c2", "Bash", JSON.stringify({ command: "ls -la" })), null);
    assert.equal(scanner.complete("c3", "Bash", { command: "raft message read --channel '#x'" }), null);
  });

  test("one-character fragments (escapes split across them) find the same target once", () => {
    const command = "printf x; raft message send --target 'dm:@caf\u00e9~human' <<'EOF'\n\"hi\"\nEOF";
    const json = JSON.stringify({ command, description: "x" }).replace("\u00e9", "\\u00e9");
    assert.equal(JSON.parse(json).command, command);
    const scanner = new SendIntentArgumentScanner();
    const found = chunks(json, 1).map((chunk) => scanner.append("c1", "Bash", chunk)).filter(Boolean);
    assert.deepEqual(found, [{ kind: "send_intent", callId: "c1", target: "dm:@caf\u00e9~human", early: true }]);
  });

  test("argument text past the cap stops the scan; the finished call is still read", () => {
    const scanner = new SendIntentArgumentScanner();
    // A large field before `command`: extraction keeps returning null.
    const json = JSON.stringify({ description: "d".repeat(MAX_SCANNED_ARGS_CHARS), command: SEND_COMMAND });
    const found = chunks(json, 64).map((chunk) => scanner.append("c1", "Bash", chunk)).filter(Boolean);
    assert.deepEqual(found, []);
    assert.deepEqual(scanner.complete("c1", "Bash", JSON.parse(json)), {
      kind: "send_intent", callId: "c1", target: "#general", early: false,
    });
  });

  test("a body-first command past the command cap is announced when complete", () => {
    const scanner = new SendIntentArgumentScanner();
    const command = `printf '%s' '${"b".repeat(5_000)}' | raft message send --target '#general'`;
    const found = chunks(JSON.stringify({ command }), 50).map((chunk) => scanner.append("c1", "Bash", chunk)).filter(Boolean);
    assert.deepEqual(found, []);
    assert.deepEqual(scanner.complete("c1", "Bash", { command }), {
      kind: "send_intent", callId: "c1", target: "#general", early: false,
    });
  });

  test("complete arguments without streaming give a late intent", () => {
    const scanner = new SendIntentArgumentScanner();
    assert.deepEqual(scanner.complete("c1", "bash", { command: SEND_COMMAND }), {
      kind: "send_intent", callId: "c1", target: "#general", early: false,
    });
  });
});

describe("Claude normalizer: send_intent from streaming tool_use", () => {
  const streamRow = (event: Record<string, unknown>, parent: string | null = null) => JSON.stringify({
    type: "stream_event",
    event,
    session_id: "session-1",
    parent_tool_use_id: parent,
    uuid: "u",
  });

  function feed(normalizer: ClaudeEventNormalizer, parent: string | null = null): ParsedEvent[] {
    const lines = [
      streamRow({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [] } }, parent),
      streamRow({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, parent),
      streamRow({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Posting." } }, parent),
      streamRow({ type: "content_block_stop", index: 0 }, parent),
      streamRow({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_01", name: "Bash", input: {} } }, parent),
      streamRow({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "" } }, parent),
      ...chunks(SEND_ARGS_JSON, 5).map((partial_json) =>
        streamRow({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json } }, parent)),
      streamRow({ type: "content_block_stop", index: 1 }, parent),
    ];
    return lines.flatMap((line) => normalizer.normalizeLine(line));
  }

  test("emits one send_intent for the main agent's Bash call and keeps internal_progress", () => {
    const normalizer = new ClaudeEventNormalizer();
    const events = feed(normalizer);
    assert.deepEqual(sendIntents(events), [{ kind: "send_intent", callId: "toolu_01", target: "#general", early: true }]);
    assert.equal(events.filter((event) => event.kind === "internal_progress").length, events.length - 1);
    // The finished assistant row still reports the tool_call as before.
    const assistant = normalizer.normalizeLine(JSON.stringify({
      type: "assistant",
      session_id: "session-1",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_use", id: "toolu_01", name: "Bash", input: { command: SEND_COMMAND } }] },
    }));
    assert.deepEqual(assistant, [{ kind: "tool_call", name: "Bash", input: { command: SEND_COMMAND }, callId: "toolu_01" }]);
  });

  test("skips a subagent's streaming tool_use", () => {
    assert.deepEqual(sendIntents(feed(new ClaudeEventNormalizer(), "toolu_parent")), []);
  });

  test("a new message resets block indexes", () => {
    const normalizer = new ClaudeEventNormalizer();
    normalizer.normalizeLine(streamRow({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_a", name: "Bash", input: {} } }));
    normalizer.normalizeLine(streamRow({ type: "message_start", message: {} }));
    const events = normalizer.normalizeLine(streamRow({
      type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: SEND_ARGS_JSON },
    }));
    assert.deepEqual(sendIntents(events), []);
  });
});

describe("Grok normalizer: send_intent from tool_call_delta_chunk", () => {
  const notification = (update: Record<string, unknown>): GrokJsonRpcMessage => ({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "session-1", update },
  });

  test("emits one send_intent while arguments stream, then the usual tool_call", () => {
    const normalizer = new GrokEventNormalizer();
    normalizer.adoptSession("session-1");
    normalizer.beginPrompt();
    const events = [
      ...normalizer.normalizeNotification(notification({
        sessionUpdate: "tool_call_delta_chunk", tool_call_id: "tool-1", tool_index: 0, name: "run_terminal_command",
      })),
      ...chunks(SEND_ARGS_JSON, 4).flatMap((arguments_delta) => normalizer.normalizeNotification(notification({
        sessionUpdate: "tool_call_delta_chunk", tool_index: 0, arguments_delta,
      }))),
    ];
    assert.deepEqual(sendIntents(events), [{ kind: "send_intent", callId: "tool-1", target: "#general", early: true }]);
    const call = normalizer.normalizeNotification(notification({ sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Run" }));
    assert.equal(call[0]?.kind, "tool_call");
    assert.deepEqual((call[0] as { input: unknown }).input, { command: SEND_COMMAND, description: "Post the update" });
  });
});

describe("Kimi SDK mapping: send_intent from tool.call.delta", () => {
  test("accumulates argumentsPart per call id", () => {
    const state = createKimiSdkEventMappingState("kimi-session-1");
    state.sessionAnnounced = true;
    const base = { agentId: "a", sessionId: "kimi-session-1", turnId: 1 };
    const events = [
      ...mapKimiSdkEventToParsedEvents({ ...base, type: "tool.call.delta", toolCallId: "t1", name: "Bash" } as never, state),
      ...chunks(SEND_ARGS_JSON, 6).flatMap((argumentsPart) =>
        mapKimiSdkEventToParsedEvents({ ...base, type: "tool.call.delta", toolCallId: "t1", name: "Bash", argumentsPart } as never, state)),
    ];
    assert.deepEqual(events, [{ kind: "send_intent", callId: "t1", target: "#general", early: true }]);
    // A delta of a non-shell tool stays dropped.
    assert.deepEqual(mapKimiSdkEventToParsedEvents({ ...base, type: "tool.call.delta", toolCallId: "t2", name: "ReadFile", argumentsPart: SEND_ARGS_JSON } as never, state), []);
  });
});

describe("Pi mapping: send_intent from toolcall_start/delta/end", () => {
  const update = (assistantMessageEvent: Record<string, unknown>) =>
    ({ type: "message_update", message: {}, assistantMessageEvent } as unknown as AgentSessionEvent);
  const partialWith = (id: string, name: string) => ({ content: [{ type: "text", text: "" }, { type: "toolCall", id, name, arguments: {} }] });

  test("streams the arguments JSON of the live tool call", () => {
    const state = createPiSdkEventMappingState("pi-session");
    state.sessionAnnounced = true;
    const partial = partialWith("call_1", "bash");
    const events = [
      ...mapPiSdkEventToParsedEvents(update({ type: "toolcall_start", contentIndex: 1, partial }), state),
      ...chunks(SEND_ARGS_JSON, 7).flatMap((delta) =>
        mapPiSdkEventToParsedEvents(update({ type: "toolcall_delta", contentIndex: 1, delta, partial }), state)),
      ...mapPiSdkEventToParsedEvents(update({
        type: "toolcall_end", contentIndex: 1, partial,
        toolCall: { type: "toolCall", id: "call_1", name: "bash", arguments: { command: SEND_COMMAND } },
      }), state),
    ];
    assert.deepEqual(events, [{ kind: "send_intent", callId: "call_1", target: "#general", early: true }]);
  });

  test("a provider without deltas is read at toolcall_end", () => {
    const state = createPiSdkEventMappingState("pi-session");
    state.sessionAnnounced = true;
    const events = mapPiSdkEventToParsedEvents(update({
      type: "toolcall_end", contentIndex: 0, partial: partialWith("call_2", "bash"),
      toolCall: { type: "toolCall", id: "call_2", name: "bash", arguments: { command: SEND_COMMAND } },
    }), state);
    assert.deepEqual(events, [{ kind: "send_intent", callId: "call_2", target: "#general", early: false }]);
  });
});

test("SendIntentArgumentScanner: the name may arrive after the first fragments; other tools settle at once", () => {
  const scanner = new SendIntentArgumentScanner();
  const [head, ...rest] = chunks(SEND_ARGS_JSON, 10);
  assert.equal(scanner.append("late-name", undefined, head), null);
  const found = rest.map((chunk, i) => scanner.append("late-name", i === 0 ? "Bash" : undefined, chunk)).filter(Boolean);
  assert.deepEqual(found, [{ kind: "send_intent", callId: "late-name", target: "#general", early: true }]);

  assert.equal(scanner.append("write", "Write", '{"content":"raft message send --target \'#x\' '), null);
  assert.equal(scanner.append("write", undefined, SEND_ARGS_JSON), null);
});
