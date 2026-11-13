import assert from "node:assert/strict";
import { cleanupSessionResources, type Message, type Model } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { afterEach, test } from "vitest";
import { PiAnthropicRequestMeter, type PiAnthropicRequestAttrs } from "./piAnthropicRequests";

// #runtime-watch:#1: Anthropic message threads are on (pi-ai's default for
// api.anthropic.com) and pi-ai alone recovers a thread the server can no longer
// use. These drive pi-ai 1.5.2's real Anthropic adapter offline (a fake fetch
// that answers only for api.anthropic.com) through the meter the Pi driver
// installs, and pin what reaches the wire and what is measured.

const SESSION = "pi-anthropic-threads";
const TOOL = { name: "read", description: "Read a file", parameters: { type: "object" as const, properties: {} } };
const MODEL = {
  id: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_000,
} as unknown as Model<"anthropic-messages">;

afterEach(() => {
  cleanupSessionResources(SESSION);
});

function sse(id: string, text: string): string {
  const events: Array<[string, unknown]> = [
    ["message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: MODEL.id, content: [], usage: { input_tokens: 7, output_tokens: 0, cache_read_input_tokens: 100 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

type WireBody = { thread?: { type: string; previous_message_id?: string }; system?: unknown; tools?: unknown; messages: unknown[] };
type Rejection = { status: number; body: unknown };

const rejection = (status: number, error: Record<string, unknown>): Rejection => ({ status, body: { type: "error", error } });

/** A conversation through pi-ai's Anthropic adapter, observed the way the Pi driver observes it. */
function conversation() {
  const wire: WireBody[] = [];
  const requests: PiAnthropicRequestAttrs[] = [];
  let replies = 0;
  let rejectNext: Rejection | null = null;
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const host = new URL(url instanceof Request ? url.url : String(url)).host;
    if (host !== "api.anthropic.com") throw new Error(`unexpected host ${host}`);
    const body = JSON.parse(String(init?.body)) as WireBody;
    wire.push(body);
    if (rejectNext && body.thread?.type === "continue") {
      const answer = rejectNext;
      rejectNext = null;
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
    }
    replies += 1;
    return new Response(sse(`msg_${replies}`, `reply ${replies}`), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const meter = new PiAnthropicRequestMeter({ warmRecycleFlag: false, emitRequest: (attrs) => requests.push(attrs) });
  const messages: Message[] = [];

  return {
    wire,
    requests,
    async turn(text: string, turnOpts: { reject?: Rejection } = {}) {
      rejectNext = turnOpts.reject ?? null;
      messages.push({ role: "user", content: text, timestamp: messages.length });
      const callOptions = { apiKey: "sk-ant-test-not-a-key", sessionId: SESSION, fetch: fetch as typeof globalThis.fetch };
      const reply = await meter.observe(MODEL, callOptions, (observed) =>
        stream(MODEL, normalizeContext({ systemPrompt: "You are Otter.", tools: [TOOL], messages }), observed)).result();
      // The meter's end runs on the same result; let its `then` settle.
      await new Promise((resolve) => setImmediate(resolve));
      if (reply.stopReason === "stop") messages.push(reply);
      else messages.pop();
      return reply;
    },
  };
}

test("threads are on by default: a second turn continues the thread and is smaller on the wire", async () => {
  const chat = conversation();
  await chat.turn("one");
  await chat.turn("two");
  assert.deepEqual(chat.wire.map((body) => body.thread), [{ type: "create" }, { type: "continue", previous_message_id: "msg_1" }]);
  assert.equal(chat.wire[1]!.system, undefined, "a continue omits the system prompt");
  assert.equal(chat.wire[1]!.tools, undefined, "and the tools");
  assert.ok(Number(chat.requests[1]!.request_bytes) < Number(chat.requests[0]!.request_bytes));
});

test("each call is measured: wire bytes, requests, outcome, tokens and the warm recycle flag", async () => {
  const chat = conversation();
  await chat.turn("one");
  await chat.turn("two");
  assert.equal(chat.requests.length, 2);
  for (const [index, attrs] of chat.requests.entries()) {
    assert.equal(attrs.provider, "anthropic");
    assert.equal(attrs.wake_recycle_warm, false);
    assert.equal(attrs.outcome, "completed");
    assert.equal(attrs.wire_requests_count, 1);
    assert.equal(attrs.request_bytes, Buffer.byteLength(JSON.stringify(chat.wire[index])));
    assert.equal(attrs.last_request_bytes, attrs.request_bytes);
    assert.equal(attrs.input_tokens, 7);
    assert.equal(attrs.cached_read_tokens, 100);
    assert.equal(attrs.output_tokens, 1);
  }
  // No content in the attributes: numbers, booleans and closed values only.
  for (const value of Object.values(chat.requests[1]!)) assert.ok(typeof value !== "string" || /^[a-z_]+$/.test(value), String(value));
});

test("pi-ai recovers a known thread rejection itself: resent in full as a new thread, both requests counted", async () => {
  const chat = conversation();
  await chat.turn("one");
  const reply = await chat.turn("two", { reject: rejection(404, { type: "not_found_error", message: "gone", details: { error_code: "thread_not_found" } }) });
  assert.equal(reply.stopReason, "stop", reply.errorMessage);
  assert.deepEqual(chat.wire.map((body) => body.thread?.type), ["create", "continue", "create"]);
  assert.equal(chat.wire[2]!.messages.length, 3, "the resend carries every message: one, reply 1, two");
  const last = chat.requests.at(-1)!;
  assert.equal(last.wire_requests_count, 2);
  assert.equal(last.request_bytes, Buffer.byteLength(JSON.stringify(chat.wire[1])) + Buffer.byteLength(JSON.stringify(chat.wire[2])));
  assert.equal(last.last_request_bytes, Buffer.byteLength(JSON.stringify(chat.wire[2])));
});

test("a continue rejection pi-ai does not recover is the call's error, and the next turn starts a new thread in full", async () => {
  const chat = conversation();
  await chat.turn("one");
  const reply = await chat.turn("two", { reject: rejection(404, { type: "not_found_error", message: "previous message not found" }) });
  assert.equal(reply.stopReason, "error");
  assert.deepEqual(chat.wire.map((body) => body.thread?.type), ["create", "continue"], "Raft resends nothing");
  assert.equal(chat.requests.at(-1)!.outcome, "error");
  const next = await chat.turn("three");
  assert.equal(next.stopReason, "stop", next.errorMessage);
  assert.equal(chat.wire.at(-1)!.thread?.type, "create");
});

test("other APIs pass straight through unmeasured", async () => {
  const requests: PiAnthropicRequestAttrs[] = [];
  const meter = new PiAnthropicRequestMeter({ warmRecycleFlag: true, emitRequest: (attrs) => requests.push(attrs) });
  const options = { fetch: globalThis.fetch };
  let seen: unknown;
  const result = meter.observe({ api: "openai-completions", provider: "openai" }, options, (observed) => {
    seen = observed;
    return { result: async () => ({ stopReason: "stop" }) };
  });
  await result.result();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seen, options);
  assert.deepEqual(requests, []);
});
