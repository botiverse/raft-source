// Agent API /events drain tests. The CLI no longer has a machine-token
// compatibility receive/ack path.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { AgentContext } from "../../auth/env.js";
import { drainInbox } from "./_inbox.js";

const ctx: AgentContext = {
  agentId: "agent_test",
  serverUrl: "http://localhost:9999",
  serverId: null,
  token: "sk_agent_test",
  clientMode: "self-hosted-runner",
  secretSource: "profile-credential-file",
  activeCapabilities: null,
};

interface FetchCall {
  url: string;
  init: RequestInit;
}

function installFetchMock(handlers: Array<(call: FetchCall) => Response>): { calls: FetchCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  let i = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const call: FetchCall = { url, init: init ?? {} };
    calls.push(call);
    const handler = handlers[i++];
    if (!handler) throw new Error(`Unexpected fetch call #${i}: ${url}`);
    return handler(call);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("drainInbox: uses agent-api events without a separate ack call", async () => {
  const { calls, restore } = installFetchMock([
    () => jsonResponse(200, agentEvents([{ seq: 22, content: "agent event" }])),
  ]);

  try {
    const result = await drainInbox(ctx, { block: false });
    assert.deepEqual(result.messages, [{ seq: 22, content: "agent event" }]);
  } finally {
    restore();
  }

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/internal/agent-api/events");
  assert.equal(url.searchParams.get("since"), "latest");
});

function agentEvents(messages: Array<{ seq: number; content: string }>, hasMore = false) {
  const last = messages[messages.length - 1];
  return {
    events: messages,
    last_seen_msgId: last ? `msg-${last.seq}` : null,
    last_seen_seq: last?.seq ?? null,
    reply_target: null,
    pending_notice_ids: [],
    wake_reason: null,
    has_more: hasMore,
  };
}

test("drainInbox: block opts still use non-blocking agent-api events", async () => {
  const { calls, restore } = installFetchMock([
    () => jsonResponse(200, agentEvents([])),
  ]);

  try {
    await drainInbox(ctx, { block: true, timeoutMs: 5000 });
  } finally {
    restore();
  }

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/internal/agent-api/events");
  assert.equal(url.searchParams.get("since"), "latest");
  assert.equal(url.searchParams.has("block"), false);
  assert.equal(url.searchParams.has("timeout"), false);
});
// task #80 — multi-round read completeness: agent-api /events returns a
// limit-trimmed batch with has_more; a single call under-reads big backlogs.
// drainInbox must loop to completion so `message check` returns everything.

const agentContext = {
  agentId: "agent-drain",
  serverUrl: "http://stub.local",
  clientMode: "self-hosted-runner",
  profileSlug: "t",
} as unknown as AgentContext;

function batchedClient(batches: Array<{ messages: Array<{ seq: number; content: string }>; has_more: boolean }>) {
  let call = 0;
  return {
    calls: () => call,
    request: async () => {
      const batch = batches[Math.min(call, batches.length - 1)]!;
      call += 1;
      return { ok: true, status: 200, error: null, data: agentEvents(batch.messages, batch.has_more) };
    },
  };
}

test("drainInbox loops until has_more=false and returns the full backlog (task #80)", async () => {
  const client = batchedClient([
    { messages: [{ seq: 1, content: "m1" }, { seq: 2, content: "m2" }], has_more: true },
    { messages: [{ seq: 3, content: "m3" }], has_more: true },
    { messages: [{ seq: 4, content: "m4" }], has_more: false },
  ]);
  const result = await drainInbox(agentContext, { block: false }, client as never);
  assert.deepEqual(result.messages.map((m) => m.seq), [1, 2, 3, 4]);
  assert.equal(result.drainedMore, true);
  assert.equal(result.hasMore, undefined);
  assert.equal(result.drainComplete, true);
  assert.equal(client.calls(), 3);
});

test("drainInbox with explicit has_more=false records that the drain is complete", async () => {
  const client = batchedClient([{ messages: [{ seq: 9, content: "only" }], has_more: false }]);
  const result = await drainInbox(agentContext, { block: false }, client as never);
  assert.equal(result.messages.length, 1);
  assert.equal(result.drainedMore, undefined);
  assert.equal(result.hasMore, undefined);
  assert.equal(result.drainComplete, true);
  assert.equal(client.calls(), 1);
});

test("drainInbox returns the partial set when a follow-up round fails (rest stays pending)", async () => {
  let call = 0;
  const client = {
    request: async () => {
      call += 1;
      if (call === 1) return { ok: true, status: 200, error: null, data: agentEvents([{ seq: 1, content: "m1" }], true) };
      return { ok: false, status: 503, error: "deploy", data: null };
    },
  };
  const result = await drainInbox(agentContext, { block: false }, client as never);
  assert.deepEqual(result.messages.map((m) => m.seq), [1]);
  assert.equal(result.drainedMore, true);
  assert.equal(result.hasMore, true);
});

test("drainInbox stops at the safety cap even if has_more never clears", async () => {
  let call = 0;
  const client = {
    request: async () => {
      call += 1;
      return { ok: true, status: 200, error: null, data: agentEvents([{ seq: call, content: `m${call}` }], true) };
    },
  };
  const result = await drainInbox(agentContext, { block: false }, client as never);
  assert.equal(call, 50);
  assert.equal(result.messages.length, 50);
  assert.equal(result.drainedMore, true);
  assert.equal(result.hasMore, true);
});

test("drainInbox returns accumulated has_more batches in seq order", async () => {
  const client = batchedClient([
    { messages: [{ seq: 33, content: "third" }], has_more: true },
    { messages: [{ seq: 31, content: "first" }], has_more: true },
    { messages: [{ seq: 32, content: "second" }], has_more: false },
  ]);
  const result = await drainInbox(agentContext, { block: false }, client as never);
  assert.deepEqual(result.messages.map((m) => m.seq), [31, 32, 33]);
  assert.equal(result.drainedMore, true);
  assert.equal(result.hasMore, undefined);
  assert.equal(result.drainComplete, true);
});
