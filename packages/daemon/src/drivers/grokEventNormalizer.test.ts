import assert from "node:assert/strict";
import { test } from "vitest";
import { GrokEventNormalizer, type GrokJsonRpcMessage } from "./grokEventNormalizer.js";

function notification(sessionId: string, update: Record<string, unknown>): GrokJsonRpcMessage {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update },
  };
}

test("grok normalizer surfaces assistant text and thought chunks for the active session", () => {
  const normalizer = new GrokEventNormalizer();
  normalizer.adoptSession("session-1");

  assert.deepEqual(normalizer.normalizeNotification(notification("session-1", {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "answer" },
  })), [{ kind: "text", text: "answer" }]);
  assert.deepEqual(normalizer.normalizeNotification(notification("session-1", {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "reasoning" },
  })), [{ kind: "thinking", text: "reasoning" }]);

  assert.deepEqual(normalizer.normalizeNotification(notification("other-session", {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "wrong session" },
  })), []);
});

test("grok normalizer joins tool deltas and emits each call and output once", () => {
  const normalizer = new GrokEventNormalizer();
  normalizer.adoptSession("session-1");
  normalizer.beginPrompt();

  const firstDelta = normalizer.normalizeNotification(notification("session-1", {
    sessionUpdate: "tool_call_delta_chunk",
    tool_call_id: "tool-1",
    tool_index: 0,
    name: "shell",
  }));
  const secondDelta = normalizer.normalizeNotification(notification("session-1", {
    sessionUpdate: "tool_call_delta_chunk",
    tool_index: 0,
    arguments_delta: "{\"command\":\"pwd\"}",
  }));
  assert.equal(firstDelta[0]?.kind, "internal_progress");
  assert.equal(secondDelta[0]?.kind, "internal_progress");

  const call = notification("session-1", {
    sessionUpdate: "tool_call",
    toolCallId: "tool-1",
    title: "Run command",
    _meta: { "x.ai/tool": { name: "shell" } },
  });
  assert.deepEqual(normalizer.normalizeNotification(call), [{
    kind: "tool_call",
    name: "shell",
    input: { command: "pwd" },
  }]);
  assert.equal(normalizer.normalizeNotification(call)[0]?.kind, "internal_progress");

  const completed = notification("session-1", {
    sessionUpdate: "tool_call_update",
    toolCallId: "tool-1",
    status: "completed",
    rawOutput: { stdout: "/tmp" },
  });
  assert.deepEqual(normalizer.normalizeNotification(completed), [{ kind: "tool_output", name: "shell" }]);
  assert.equal(normalizer.normalizeNotification(completed)[0]?.kind, "internal_progress");
});

test("grok normalizer deduplicates terminal notification and prompt response", () => {
  const normalizer = new GrokEventNormalizer();
  normalizer.adoptSession("session-1");
  const generation = normalizer.beginPrompt();

  const terminal = normalizer.normalizeNotification(notification("session-1", {
    sessionUpdate: "turn_completed",
    prompt_id: "prompt-1",
    stop_reason: "end_turn",
    usage: {
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      cachedReadTokens: 2,
      reasoningTokens: 1,
      modelCalls: 2,
      apiDurationMs: 125,
      numTurns: 1,
    },
  }));

  assert.deepEqual(terminal, [
    {
      kind: "telemetry",
      name: "token_usage",
      source: "grok_acp",
      usageKind: "per_turn",
      sessionId: "session-1",
      turnId: "prompt-1",
      attrs: {
        input_tokens: 10,
        output_tokens: 4,
        total_tokens: 14,
        cached_read_tokens: 2,
        reasoning_tokens: 1,
        model_calls: 2,
        api_duration_ms: 125,
        num_turns: 1,
      },
    },
    { kind: "turn_end", sessionId: "session-1" },
  ]);
  assert.equal(normalizer.canSteerBusy, false);
  assert.deepEqual(normalizer.finishPrompt(generation, {
    stopReason: "end_turn",
    promptId: "prompt-1",
  }), []);
});

test("grok normalizer does not let a late terminal notification complete the next prompt", () => {
  const normalizer = new GrokEventNormalizer();
  normalizer.adoptSession("session-1");
  const firstGeneration = normalizer.beginPrompt();

  assert.deepEqual(normalizer.finishPrompt(firstGeneration, {
    stopReason: "end_turn",
    promptId: "prompt-1",
  }), [{ kind: "turn_end", sessionId: "session-1" }]);

  const secondGeneration = normalizer.beginPrompt();
  assert.equal(normalizer.canSteerBusy, true);
  assert.deepEqual(normalizer.normalizeNotification(notification("session-1", {
    sessionUpdate: "turn_completed",
    prompt_id: "prompt-1",
    stop_reason: "end_turn",
  })), []);
  assert.equal(normalizer.canSteerBusy, true);

  assert.deepEqual(normalizer.finishPrompt(secondGeneration, {
    stopReason: "end_turn",
    promptId: "prompt-2",
  }), [{ kind: "turn_end", sessionId: "session-1" }]);
  assert.equal(normalizer.canSteerBusy, false);
});

test("grok normalizer completes an autonomous successor turn with its own prompt id", () => {
  const normalizer = new GrokEventNormalizer();
  normalizer.adoptSession("session-1");
  const initialGeneration = normalizer.beginPrompt();

  assert.deepEqual(normalizer.finishPrompt(initialGeneration, {
    stopReason: "end_turn",
    promptId: "prompt-1",
  }), [{ kind: "turn_end", sessionId: "session-1" }]);
  assert.equal(normalizer.canSteerBusy, false);

  const autonomousTerminal = notification("session-1", {
    sessionUpdate: "turn_completed",
    prompt_id: "task-completed-call-1",
    stop_reason: "end_turn",
  });
  assert.deepEqual(normalizer.normalizeNotification(autonomousTerminal), [
    { kind: "turn_end", sessionId: "session-1" },
  ]);
  assert.deepEqual(
    normalizer.normalizeNotification(autonomousTerminal),
    [],
    "the autonomous terminal must be emitted exactly once",
  );
});

test("grok normalizer does not invent a turn for an unknown ordinary terminal", () => {
  const normalizer = new GrokEventNormalizer();
  normalizer.adoptSession("session-1");
  const generation = normalizer.beginPrompt();
  assert.deepEqual(normalizer.finishPrompt(generation, {
    stopReason: "end_turn",
    promptId: "prompt-1",
  }), [{ kind: "turn_end", sessionId: "session-1" }]);

  assert.deepEqual(normalizer.normalizeNotification(notification("session-1", {
    sessionUpdate: "turn_completed",
    prompt_id: "unknown-late-prompt",
    stop_reason: "end_turn",
  })), []);
  assert.equal(normalizer.canSteerBusy, false);
});

test("grok autonomous successor terminal cannot complete a newer foreground turn", () => {
  const normalizer = new GrokEventNormalizer();
  normalizer.adoptSession("session-1");
  const firstGeneration = normalizer.beginPrompt();
  assert.deepEqual(normalizer.finishPrompt(firstGeneration, {
    stopReason: "end_turn",
    promptId: "prompt-1",
  }), [{ kind: "turn_end", sessionId: "session-1" }]);

  const foregroundGeneration = normalizer.beginPrompt();
  const backgroundTerminal = notification("session-1", {
    sessionUpdate: "turn_completed",
    prompt_id: "task-completed-call-1",
    stop_reason: "end_turn",
  });
  assert.deepEqual(normalizer.normalizeNotification(backgroundTerminal), []);
  assert.equal(normalizer.canSteerBusy, true);

  assert.deepEqual(normalizer.finishPrompt(foregroundGeneration, {
    stopReason: "end_turn",
    promptId: "prompt-2",
  }), [{ kind: "turn_end", sessionId: "session-1" }]);
  assert.equal(normalizer.canSteerBusy, false);
  assert.deepEqual(
    normalizer.normalizeNotification(backgroundTerminal),
    [],
    "a suppressed background completion must stay deduplicated after the foreground turn",
  );
});

test("grok normalizer explicitly attributes concrete output to active and completed generations", () => {
  const normalizer = new GrokEventNormalizer();
  normalizer.adoptSession("session-1");
  const firstGeneration = normalizer.beginPrompt();

  assert.deepEqual(normalizer.normalizeNotification(notification("session-1", {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "active answer" },
  })), [{
    kind: "text",
    text: "active answer",
    runtimeTurn: {
      generation: firstGeneration,
      state: "active",
    },
  }]);

  assert.deepEqual(normalizer.finishPrompt(firstGeneration, {
    stopReason: "end_turn",
    promptId: "prompt-1",
  }), [{ kind: "turn_end", sessionId: "session-1" }]);
  assert.deepEqual(normalizer.normalizeNotification(notification("session-1", {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "late thought" },
  })), [{
    kind: "thinking",
    text: "late thought",
    runtimeTurn: {
      generation: firstGeneration,
      state: "completed",
    },
  }]);

  const secondGeneration = normalizer.beginPrompt();
  assert.deepEqual(normalizer.normalizeNotification(notification("session-1", {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "next turn thought" },
  })), [{
    kind: "thinking",
    text: "next turn thought",
    runtimeTurn: {
      generation: secondGeneration,
      state: "active",
    },
  }]);
});

test("grok normalizer keeps interaction lifecycle internal and bounds unknown extensions", () => {
  const normalizer = new GrokEventNormalizer();
  normalizer.adoptSession("session-1");

  const pending = normalizer.normalizeNotification(notification("session-1", {
    sessionUpdate: "pending_interaction",
    tool_call_id: "tool-1",
    kind: "permission",
  }));
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.kind, "internal_progress");
  if (pending[0]?.kind !== "internal_progress") assert.fail("expected internal progress");
  assert.deepEqual({ ...pending[0], payloadBytes: undefined }, {
    kind: "internal_progress",
    source: "grok_acp_notification",
    itemType: "pending_interaction",
    payloadBytes: undefined,
  });
  assert.ok((pending[0].payloadBytes ?? 0) > 0);

  const resolved = normalizer.normalizeNotification(notification("session-1", {
    sessionUpdate: "interaction_resolved",
    tool_call_id: "tool-1",
  }));
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.kind, "internal_progress");
  if (resolved[0]?.kind !== "internal_progress") assert.fail("expected internal progress");
  assert.deepEqual({ ...resolved[0], payloadBytes: undefined }, {
    kind: "internal_progress",
    source: "grok_acp_notification",
    itemType: "interaction_resolved",
    payloadBytes: undefined,
  });
  assert.ok((resolved[0].payloadBytes ?? 0) > 0);

  const unknown = normalizer.normalizeNotification({
    jsonrpc: "2.0",
    method: "_x.ai/session/prompt_complete",
    params: { sessionId: "session-1", promptId: "prompt-1" },
  });
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0]?.kind, "internal_progress");
  if (unknown[0]?.kind !== "internal_progress") assert.fail("expected internal progress");
  assert.deepEqual({ ...unknown[0], payloadBytes: undefined }, {
    kind: "internal_progress",
    source: "grok_acp_notification",
    itemType: "_x.ai/session/prompt_complete",
    payloadBytes: undefined,
  });
  assert.ok((unknown[0].payloadBytes ?? 0) > 0);
});
