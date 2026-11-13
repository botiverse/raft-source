import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { createProviderHttpClient } from "../daemonFetch";
import { createPiSdkEventMappingState, mapPiSdkEventToParsedEvents } from "./pi";

function message(content: AssistantMessage["content"] = []): AssistantMessage {
  return { role: "assistant", content, api: "openai-completions", provider: "synthetic", model: "synthetic",
    timestamp: 1, stopReason: "stop", usage: { input: 3, output: 432, cacheRead: 0, cacheWrite: 0, totalTokens: 435,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function mapper() {
  const state = createPiSdkEventMappingState("session-a");
  const map = (event: unknown) => mapPiSdkEventToParsedEvents(event as AgentSessionEvent, state);
  const end = (reply: unknown) => map({ type: "message_end", message: reply }).filter((e) => e.kind === "runtime_diagnostic");
  const start = () => map({ type: "message_start", message: message() });
  const update = (assistantMessageEvent: unknown) => map({ type: "message_update", message: message(), assistantMessageEvent });
  return { state, map, start, update, end };
}

test.each([
  [[], "empty_response"],
  [[{ type: "text", text: "" }], "empty_response"],
  [[{ type: "text", text: " \n\t" }], "whitespace_response"],
  [[{ type: "text", text: "answer" }], null],
  [[{ type: "thinking", thinking: "private thought" }], null],
  [[{ type: "toolCall", id: "call-1", name: "read", arguments: {} }], null],
  [[{ type: "text", text: " " }, { type: "future_block" }], null],
  [[{ type: "text", text: 4 }], null],
  [null, null],
])("normal response classification %j → %s", (content, expected) => {
  const { end } = mapper();
  const events = end({ ...message(), content });
  assert.deepEqual(events.map((e) => e.itemType), expected ? [expected] : []);
  for (const event of events) assert.equal(event.severity, "info");
});

test.each(["text", "thinking", "toolcall"])("streamed %s evidence survives an empty final snapshot", (kind) => {
  const m = mapper(); m.start();
  if (kind === "toolcall") m.update({ type: "toolcall_start", contentIndex: 0, partial: message([{ type: "toolCall", id: "1", name: "read", arguments: {} }]) });
  else {
    m.update({ type: `${kind}_delta`, contentIndex: 0, delta: "evidence", partial: message() });
    m.update({ type: `${kind}_end`, contentIndex: 0, content: "evidence", partial: message() });
  }
  assert.deepEqual(m.end(message()), []);
});

test("each finalized SDK message has its own identity, independent of timestamp and previous tool calls", () => {
  const m = mapper();
  m.start(); m.end(message([{ type: "toolCall", id: "1", name: "read", arguments: {} }]));
  const empty = message();
  m.start(); assert.equal(m.end(empty).length, 1);
  assert.deepEqual(m.end(empty), [], "replayed final SDK object is not another message");
  assert.equal(m.end(message()).length, 1, "a different SDK object at the same timestamp is another response");
  assert.equal(m.state.pendingTurnEnd, false, "message_end cannot complete the whole agent turn");
  m.start(); assert.deepEqual(m.end(message([{ type: "text", text: "continued answer" }])), []);
  assert.deepEqual(m.map({ type: "agent_end", messages: [] }), []);
  assert.equal(m.map({ type: "agent_settled", aborted: false }).filter((e) => e.kind === "turn_end").length, 1);
});

test.each(["error", "aborted", "length", "toolUse"])("%s is not a normal empty completion", (stopReason) => {
  const m = mapper(); m.start();
  assert.deepEqual(m.end({ ...message(), stopReason }), []);
});

test("startup, session change, failed message and cancellation do not leak stream evidence", () => {
  const m = mapper();
  const seed = () => { m.start(); m.update({ type: "text_delta", delta: "previous", contentIndex: 0, partial: message() }); };
  seed(); m.map({ type: "agent_start" }); assert.equal(m.end(message()).length, 1);
  seed(); m.state.sessionId = "session-b"; assert.equal(m.end(message()).length, 1);
  seed(); m.end({ ...message(), stopReason: "error" }); assert.equal(m.end(message()).length, 1);
  seed(); m.map({ type: "agent_settled", aborted: true }); assert.equal(m.end(message()).length, 0);
  m.map({ type: "agent_start" }); assert.equal(m.end(message()).length, 1);
});

test("the captured role/empty-stop stream passes through the actual Pi SDK and yields one notice", async () => {
  const server = createServer((req, res) => {
    req.resume();
    const chunk = (delta: object, finish_reason: string | null, usage?: object) => `data: ${JSON.stringify({
      id: "synthetic", object: "chat.completion.chunk", created: 1, model: "synthetic",
      choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
    })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(chunk({ role: "assistant" }, null) + chunk({}, "stop", { prompt_tokens: 3, completion_tokens: 432, total_tokens: 435 }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const transport = createProviderHttpClient({}, "synthetic-empty-response");
  try {
    const model: Model<"openai-completions"> = { id: "synthetic", name: "synthetic", api: "openai-completions", provider: "synthetic",
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 };
    const stream = streamSimple(model, normalizeContext({ messages: [{ role: "user", content: "synthetic", timestamp: 1 }] }),
      { apiKey: "synthetic", fetch: transport.fetch, timeoutMs: 1000, maxRetries: 0 });
    const m = mapper(); m.start();
    for await (const event of stream) m.update(event);
    const result = await stream.result();
    assert.equal(result.stopReason, "stop");
    assert.equal(result.usage.output, 432);
    assert.deepEqual(result.content, []);
    assert.equal(m.end(result).length, 1);
    assert.equal(m.end(result).length, 0);
  } finally {
    transport.dispose(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});


test("replaying an older final message cannot erase the current response's stream evidence", () => {
  const m = mapper(); const old = message(); m.end(old);
  m.start(); m.update({ type: "text_delta", delta: "current response", contentIndex: 0, partial: message() });
  assert.deepEqual(m.end(old), []);
  assert.deepEqual(m.end(message()), []);
});

test("a stream error followed by a malformed successful empty final is indeterminate", () => {
  const m = mapper(); m.start();
  m.update({ type: "error", error: { ...message(), stopReason: "error", errorMessage: "synthetic" } });
  assert.deepEqual(m.end(message()), []);
});


test.each([
  { type: "text_start", contentIndex: 0, partial: { content: [{ type: "future_block" }] } },
  { type: "text_delta", contentIndex: 0, delta: " ", partial: { content: [{ type: "text", text: 42 }] } },
  { type: "future_event", contentIndex: 0 },
  { type: "text_start", contentIndex: 0, partial: null },
  { type: "text_delta", contentIndex: 0, delta: 42, partial: { content: [] } },
  { type: "text_end", contentIndex: 0, content: null, partial: { content: [] } },
])("unfamiliar or malformed streamed blocks/events remain indeterminate with an empty final snapshot: %j", (event) => {
  const m = mapper(); m.start(); m.update(event);
  assert.deepEqual(m.end(message()), []);
});


test("an interleaved non-assistant message end cannot consume the assistant's stream evidence", () => {
  const m = mapper(); m.start();
  m.update({ type: "text_start", contentIndex: 0, partial: { content: [{ type: "future_block" }] } });
  m.map({ type: "message_end", message: { role: "user", content: "queued input", timestamp: 2 } });
  assert.deepEqual(m.end(message()), []);
});
