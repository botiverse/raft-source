import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
  AgentO11yDaemonClient,
  AgentO11yFastCheckError,
  assertAgentO11yEventFastCheck,
  buildAgentO11yDaemonEvent,
} from "./agentO11yClient.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("builds daemon o11y events with top-level snake_case turn_id", () => {
  const event = buildAgentO11yDaemonEvent({
    event_kind: "turn",
    agent_id: "agent-1",
    turn_id: "turn-1",
    occurred_at: "2026-05-24T00:00:00.000Z",
    payload_tier: "T0",
    turn_trigger_hash: "sha256:abc",
    fields: {
      runtime: "claude",
      outcome: "ok",
      token_count: 12,
    },
  });

  assert.equal(event.turn_id, "turn-1");
  assert.equal("turnId" in event, false);
  assert.equal("runtime_turn_id" in event, false);
});

test("fast-check rejects non-canonical turn_id carrier variants", () => {
  for (const event of [
    {
      event_kind: "turn",
      agent_id: "agent-1",
      turn_id: "turn-1",
      occurred_at: "2026-05-24T00:00:00.000Z",
      turnId: "turn-1",
    },
    {
      event_kind: "turn",
      agent_id: "agent-1",
      turn_id: "turn-1",
      occurred_at: "2026-05-24T00:00:00.000Z",
      runtime_turn_id: "turn-1",
    },
    {
      event_kind: "turn",
      agent_id: "agent-1",
      turn_id: "turn-1",
      occurred_at: "2026-05-24T00:00:00.000Z",
      metadata: { turn_id: "turn-1" },
    },
  ]) {
    assert.throws(() => assertAgentO11yEventFastCheck(event), AgentO11yFastCheckError);
  }
});

test("fast-check rejects raw payload shaped fields before HTTP", async () => {
  let called = false;
  const client = new AgentO11yDaemonClient({
    serverUrl: "https://server.test",
    daemonApiKey: "sk_machine_test",
    fetchImpl: async () => {
      called = true;
      return jsonResponse({ accepted: 1 });
    },
  });

  const result = await client.postEvents([{
    event_kind: "turn",
    agent_id: "agent-1",
    turn_id: "turn-1",
    occurred_at: "2026-05-24T00:00:00.000Z",
    fields: { prompt: "raw user prompt" },
  }]);

  assert.equal(called, false);
  assert.deepEqual(result, {
    ok: false,
    status: null,
    code: "daemon_o11y_fast_check_failed",
    message: "raw payload field fields.prompt is not allowed for payload_tier=T0",
    retryable: false,
  });
});

test("fast-check rejects stale payload_mode wire field before HTTP", async () => {
  let called = false;
  const client = new AgentO11yDaemonClient({
    serverUrl: "https://server.test",
    daemonApiKey: "sk_machine_test",
    fetchImpl: async () => {
      called = true;
      return jsonResponse({ accepted: 1 });
    },
  });

  const result = await client.postEvents([{
    event_kind: "turn",
    agent_id: "agent-1",
    turn_id: "turn-1",
    occurred_at: "2026-05-24T00:00:00.000Z",
    payload_mode: "T0",
  } as never]);

  assert.equal(called, false);
  assert.deepEqual(result, {
    ok: false,
    status: null,
    code: "daemon_o11y_fast_check_failed",
    message: "stale wire field payload_mode is not allowed",
    retryable: false,
  });
});

test("fast-check rejects tenant identity fields before HTTP", async () => {
  let called = false;
  const client = new AgentO11yDaemonClient({
    serverUrl: "https://server.test",
    daemonApiKey: "sk_machine_test",
    fetchImpl: async () => {
      called = true;
      return jsonResponse({ accepted: 1 });
    },
  });

  const result = await client.postEvents([{
    event_kind: "turn",
    agent_id: "agent-1",
    turn_id: "turn-1",
    occurred_at: "2026-05-24T00:00:00.000Z",
    fields: { server_id: "forged-server" },
  }]);

  assert.equal(called, false);
  assert.deepEqual(result, {
    ok: false,
    status: null,
    code: "daemon_o11y_fast_check_failed",
    message: "tenant identity field fields.server_id is not allowed",
    retryable: false,
  });
});

test("posts daemon o11y batch to server endpoint with existing daemon credential", async () => {
  const calls: Array<{ url: string; init?: RequestInit; body: unknown }> = [];
  const client = new AgentO11yDaemonClient({
    serverUrl: "https://server.test/base",
    daemonApiKey: "sk_machine_test",
    fetchImpl: async (url, init) => {
      calls.push({
        url,
        init,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      return jsonResponse({ accepted: 1 }, 202);
    },
  });
  const event = buildAgentO11yDaemonEvent({
    event_kind: "step",
    agent_id: "agent-1",
    turn_id: "turn-1",
    occurred_at: "2026-05-24T00:00:00.000Z",
    payload_tier: "T0",
    step_input_hash: "sha256:def",
    fields: { tool_name: "slock.message.check" },
  });

  assert.deepEqual(await client.postEvents([event]), { ok: true, status: 202, accepted: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://server.test/internal/computer/agent-o11y/events");
  assert.equal(calls[0].init?.method, "POST");
  assert.deepEqual(calls[0].init?.headers, {
    "Authorization": "Bearer sk_machine_test",
    "Content-Type": "application/json",
    "X-Raft-Client": "daemon-agent-o11y",
  });
  assert.deepEqual(calls[0].body, { events: [event] });
  assert.equal("serverId" in (calls[0].body as { events: unknown[] }), false);
  assert.equal("machineId" in (calls[0].body as { events: unknown[] }), false);
});

test("treats 4xx server rejection as non-retryable to avoid local retry storms", async () => {
  const client = new AgentO11yDaemonClient({
    serverUrl: "https://server.test",
    daemonApiKey: "sk_machine_test",
    fetchImpl: async () => jsonResponse({ code: "agent_o11y_batch_too_large", message: "batch too large" }, 413),
  });
  const event = buildAgentO11yDaemonEvent({
    event_kind: "turn",
    agent_id: "agent-1",
    turn_id: "turn-1",
    occurred_at: "2026-05-24T00:00:00.000Z",
  });

  assert.deepEqual(await client.postEvents([event]), {
    ok: false,
    status: 413,
    code: "agent_o11y_batch_too_large",
    message: "batch too large",
    retryable: false,
  });
});

test("treats network failures as retryable transport failures", async () => {
  const client = new AgentO11yDaemonClient({
    serverUrl: "https://server.test",
    daemonApiKey: "sk_machine_test",
    fetchImpl: async () => {
      throw new Error("socket hang up");
    },
  });
  const event = buildAgentO11yDaemonEvent({
    event_kind: "turn",
    agent_id: "agent-1",
    turn_id: "turn-1",
    occurred_at: "2026-05-24T00:00:00.000Z",
  });

  assert.deepEqual(await client.postEvents([event]), {
    ok: false,
    status: null,
    code: "agent_o11y_events_request_failed",
    message: "socket hang up",
    retryable: true,
  });
});

test("daemon-side o11y client never references ScopeDB keys or direct ingest", async () => {
  const source = await readFile(fileURLToPath(new URL("./agentO11yClient.ts", import.meta.url)), "utf8");
  assert.equal(source.includes("SCOPEDB_AGENT_O11Y_WRITE_KEY"), false);
  assert.equal(source.includes("scopedb"), false);
  assert.equal(source.includes("/ingest"), false);
});
