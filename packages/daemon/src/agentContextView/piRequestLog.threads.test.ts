import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupSessionResources, type Message, type Model } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { afterEach, beforeEach, test } from "vitest";
import { recordingRequests } from "../drivers/pi";
import { PiRequestLog } from "./piRequestLog";
import { restorePiContextView } from "./piRequestRestore";

// Pi turns Anthropic message threads on by default for api.anthropic.com: after
// the first turn, the request on the wire is a `continue` with only the new
// messages, and the server holds the system prompt, tools and earlier turns.
// View Context does not record the wire body: it records the body pi-ai hands
// `onPayload`, which pi-ai builds in full before it cuts it down to the thread
// increment. These tests drive pi-ai's real Anthropic request builder (offline,
// a fake fetch that only answers for api.anthropic.com) and pin that order, so
// the restore stays exact with threads on. If a pi-ai upgrade moves the thread
// cut before `onPayload`, they fail here instead of View Context going partial.

const SESSION = "pi-threads-restore";
const TOOL = { name: "read", description: "Read a file", parameters: { type: "object" as const, properties: {} } };
const MODEL = {
  id: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5",
  api: "anthropic-messages",
  provider: "anthropic",
  // The host pi-ai gates threads on; no `compat` override, so threads are pi's default (on).
  baseUrl: "https://api.anthropic.com",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_000,
} as unknown as Model<"anthropic-messages">;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "pi-request-log-threads-"));
});
afterEach(() => {
  cleanupSessionResources(SESSION);
  rmSync(dir, { recursive: true, force: true });
});

function sse(id: string, text: string): string {
  const events: Array<[string, unknown]> = [
    ["message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: MODEL.id, content: [], usage: { input_tokens: 1, output_tokens: 0 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

type WireBody = { thread?: { type: string; previous_message_id?: string }; system?: unknown; tools?: unknown; messages: unknown[] };

/** A conversation driven through pi-ai's Anthropic adapter, recorded the way the Pi driver records it. */
function conversation() {
  const wire: WireBody[] = [];
  const offsets: number[] = [];
  let replies = 0;
  let rejectNextContinue = false;
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const host = new URL(url instanceof Request ? url.url : String(url)).host;
    if (host !== "api.anthropic.com") throw new Error(`unexpected host ${host}`);
    const body = JSON.parse(String(init?.body)) as WireBody;
    wire.push(body);
    if (rejectNextContinue && body.thread?.type === "continue") {
      rejectNextContinue = false;
      return new Response(JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "thread expired", details: { error_code: "thread_not_found" } },
      }), { status: 400, headers: { "content-type": "application/json" } });
    }
    replies += 1;
    return new Response(sse(`msg_${replies}`, `reply ${replies}`), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const log = new PiRequestLog(() => dir);
  const requestLog = { log, sessionId: () => SESSION };
  const messages: Message[] = [];
  const file = path.join(dir, `${SESSION}.jsonl`);

  return {
    wire,
    messages,
    async turn(text: string, opts: { rejectContinue?: boolean } = {}): Promise<void> {
      rejectNextContinue = opts.rejectContinue ?? false;
      messages.push({ role: "user", content: text, timestamp: messages.length });
      const options = recordingRequests(requestLog, MODEL, { apiKey: "sk-ant-test-not-a-key", sessionId: SESSION, fetch: fetch as typeof globalThis.fetch });
      const reply = await stream(MODEL, normalizeContext({ systemPrompt: "You are Otter.", tools: [TOOL], messages }), options).result();
      assert.equal(reply.stopReason, "stop", reply.errorMessage);
      messages.push(reply);
      // Where a send in this turn would read the log.
      offsets.push(statSync(file).size);
    },
    restore(turnIndex: number) {
      return restorePiContextView({ buffer: readFileSync(file), offset: offsets[turnIndex]!, messageId: "m1", runtime: "pi", sessionId: SESSION });
    },
    requestRecords(): number {
      return readFileSync(file, "utf8").trim().split("\n").filter((line) => line.startsWith('{"type":"request"')).length;
    },
  };
}

function texts(view: { messages: Array<{ role: string; parts: Array<{ kind: string; text?: string | null }> }> }): string[] {
  return view.messages.map((message) => `${message.role}:${message.parts.filter((part) => part.kind === "text").map((part) => part.text).join("")}`);
}

test("a threaded chain of three turns restores the whole conversation at every turn", async () => {
  const chat = conversation();
  await chat.turn("one");
  await chat.turn("two");
  await chat.turn("three");

  // The wire really is threaded: one create, then continues holding only the new user message.
  assert.deepEqual(chat.wire.map((body) => body.thread), [
    { type: "create" },
    { type: "continue", previous_message_id: "msg_1" },
    { type: "continue", previous_message_id: "msg_2" },
  ]);
  for (const body of chat.wire.slice(1)) {
    assert.equal(body.system, undefined);
    assert.equal(body.tools, undefined);
    assert.equal(body.messages.length, 1);
  }

  // The log still restores what the model saw: system, tools, every earlier turn.
  const first = chat.restore(0);
  assert.ok(first.ok, JSON.stringify(first));
  // Turn 1's reply comes from turn 2's (full) record.
  assert.deepEqual(texts(first.view), ["user:one", "assistant:reply 1"]);

  const last = chat.restore(2);
  assert.ok(last.ok, JSON.stringify(last));
  assert.deepEqual(last.view.system, [{ text: "You are Otter." }]);
  assert.deepEqual(last.view.tools.map((tool) => tool.name), ["read"]);
  assert.deepEqual(texts(last.view), ["user:one", "assistant:reply 1", "user:two", "assistant:reply 2", "user:three"]);
});

test("a compaction mid-thread (a new full request) and a rejected continue both restore exactly", async () => {
  const chat = conversation();
  await chat.turn("one");
  await chat.turn("two");
  // Compaction: the earlier turns are replaced, so the prefix no longer matches and pi sends a new thread in full.
  chat.messages.splice(0, 2, { role: "user", content: "[summary of one]", timestamp: 1 });
  await chat.turn("three");
  // The server lost the thread: pi resends the same full body as a new thread. One request, one record.
  await chat.turn("four", { rejectContinue: true });

  assert.deepEqual(chat.wire.map((body) => body.thread?.type), ["create", "continue", "create", "continue", "create"]);
  assert.equal(chat.requestRecords(), 4, "the rejected continue and its resend are one request in the log");

  const afterCompaction = chat.restore(2);
  assert.ok(afterCompaction.ok, JSON.stringify(afterCompaction));
  assert.deepEqual(texts(afterCompaction.view), ["user:[summary of one]", "user:two", "assistant:reply 2", "user:three", "assistant:reply 3"]);

  const afterResend = chat.restore(3);
  assert.ok(afterResend.ok, JSON.stringify(afterResend));
  assert.deepEqual(afterResend.view.system, [{ text: "You are Otter." }]);
  assert.deepEqual(texts(afterResend.view), ["user:[summary of one]", "user:two", "assistant:reply 2", "user:three", "assistant:reply 3", "user:four"]);
});
