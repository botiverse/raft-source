// Tests for ClaudeEventNormalizer — the parser-only surface extracted out of
// ClaudeDriver in PR #2220. These tests target the normalizer class directly
// (`new ClaudeEventNormalizer().normalizeLine(line)`) instead of going through
// `driver.parseLine`; that keeps parser regressions attributable to the
// normalizer file alone, not to driver-level wiring.
//
// Driver-level tests (buildClaudeArgs / buildSystemPrompt / probe / launch
// args) remain in claude.test.ts. The driver still has a delegation-shape
// test there that exercises parseLine end-to-end via the public surface.
//
// Per #proj-runtime:991a69e6 msg=5cc3370b item (2) + msg=69001509 sequence —
// independent tiny PR after #2220 merge, owned by Huaihuai, reviewed by Hao.

import assert from "node:assert/strict";
import { test } from "vitest";
import { ClaudeEventNormalizer } from "./claudeEventNormalizer.js";

const normalizer = new ClaudeEventNormalizer();

test("normalizes result error_during_execution errors", () => {
  const events = normalizer.normalizeLine(JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    stop_reason: null,
    errors: ["MCP server failed"],
    result: "",
    session_id: "session-1",
  }));

  assert.deepEqual(events, [
    { kind: "error", message: "MCP server failed" },
    { kind: "turn_end", sessionId: "session-1" },
  ]);
});

test("normalizes result success errors when is_error is true", () => {
  const events = normalizer.normalizeLine(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: true,
    stop_reason: null,
    errors: [],
    result: "Authentication failed",
    session_id: "session-2",
  }));

  assert.deepEqual(events, [
    { kind: "error", message: "Authentication failed" },
    { kind: "turn_end", sessionId: "session-2" },
  ]);
});

test("normalizes budget limit result subtype as an error", () => {
  const events = normalizer.normalizeLine(JSON.stringify({
    type: "result",
    subtype: "error_max_budget_usd",
    is_error: false,
    stop_reason: null,
    errors: [],
    result: "",
    session_id: "session-3",
  }));

  assert.deepEqual(events, [
    { kind: "error", message: "Budget limit exceeded" },
    { kind: "turn_end", sessionId: "session-3" },
  ]);
});

test("normalizes provider API failure assistant text as an error", () => {
  const events = normalizer.normalizeLine(JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "API Error: Unable to connect to API (ECONNRESET)" },
      ],
    },
  }));

  assert.deepEqual(events, [
    { kind: "error", message: "API Error: Unable to connect to API (ECONNRESET)" },
  ]);
});

test("normalizes provider API 400 assistant text as an error", () => {
  const message = "API Error: 400 messages.2.content.0.text.start_timestamp: Extra inputs are not permitted";
  const events = normalizer.normalizeLine(JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: message },
      ],
    },
  }));

  assert.deepEqual(events, [
    { kind: "error", message },
  ]);
});

test("keeps provider context-overflow assistant text on the error channel for daemon diagnostics", () => {
  const message = "API Error: 400 maximum context length is 100 tokens; you requested 101 tokens";
  const events = normalizer.normalizeLine(JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: message },
      ],
    },
  }));

  assert.deepEqual(events, [
    { kind: "error", message },
  ]);
});

test("leaves embedded API failure discussion assistant text as text", () => {
  const events = normalizer.normalizeLine(JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "I found the relevant failure: API Error: Unable to connect to API (ECONNRESET)." },
      ],
    },
  }));

  assert.deepEqual(events, [
    { kind: "text", text: "I found the relevant failure: API Error: Unable to connect to API (ECONNRESET)." },
  ]);
});

test("does not convert API failure text to error when the turn also emits a tool call", () => {
  const events = normalizer.normalizeLine(JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "API Error: Unable to connect to API (ECONNRESET)" },
        { type: "tool_use", name: "shell", input: { command: "true" } },
      ],
    },
  }));

  assert.deepEqual(events, [
    { kind: "text", text: "API Error: Unable to connect to API (ECONNRESET)" },
    { kind: "tool_call", name: "shell", input: { command: "true" } },
  ]);
});

test("normalizes compaction start from system status events", () => {
  const events = normalizer.normalizeLine(JSON.stringify({
    type: "system",
    subtype: "status",
    status: "compacting",
    session_id: "session-compact-1",
  }));

  assert.deepEqual(events, [
    { kind: "compaction_started" },
  ]);
});

test("normalizes requesting status as internal progress", () => {
  const line = JSON.stringify({
    type: "system",
    subtype: "status",
    status: "requesting",
    session_id: "session-requesting-1",
  });

  assert.deepEqual(normalizer.normalizeLine(line), [
    {
      kind: "internal_progress",
      source: "claude_system_status",
      itemType: "requesting",
      payloadBytes: Buffer.byteLength(line, "utf8"),
    },
  ]);
});

test("normalizes stream events as metadata-only internal progress", () => {
  const line = JSON.stringify({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "partial text must not be rendered" },
    },
    session_id: "session-stream-1",
  });

  assert.deepEqual(normalizer.normalizeLine(line), [
    {
      kind: "internal_progress",
      source: "claude_stream_event",
      itemType: "content_block_delta",
      payloadBytes: Buffer.byteLength(line, "utf8"),
    },
  ]);
});

test("normalizes empty stream event types to unknown", () => {
  const line = JSON.stringify({
    type: "stream_event",
    event: { type: "" },
  });

  assert.deepEqual(normalizer.normalizeLine(line), [
    {
      kind: "internal_progress",
      source: "claude_stream_event",
      itemType: "unknown",
      payloadBytes: Buffer.byteLength(line, "utf8"),
    },
  ]);
});

test("normalizes compaction finish from compact boundary events", () => {
  const events = normalizer.normalizeLine(JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
    session_id: "session-compact-1",
    compact_metadata: {
      trigger: "manual",
      pre_tokens: 13127,
      post_tokens: 570,
      duration_ms: 15420,
    },
  }));

  assert.deepEqual(events, [
    { kind: "compaction_finished" },
  ]);
});

test("does not double-count compaction finish from compact result status", () => {
  const events = normalizer.normalizeLine(JSON.stringify({
    type: "system",
    subtype: "status",
    status: null,
    compact_result: "success",
    session_id: "session-compact-1",
  }));

  assert.deepEqual(events, []);
});

test("normalizes max_tokens result errors when Claude marks the result as error", () => {
  const events = normalizer.normalizeLine(JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    stop_reason: "max_tokens",
    errors: ["some error"],
    result: "Token limit reached",
    session_id: "session-4",
  }));

  assert.deepEqual(events, [
    { kind: "error", message: "some error | Token limit reached" },
    { kind: "turn_end", sessionId: "session-4" },
  ]);
});

test("does not treat non-error max_tokens result stops as execution errors", () => {
  const events = normalizer.normalizeLine(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    stop_reason: "max_tokens",
    errors: [],
    result: "Partial answer before output token limit",
    session_id: "session-4b",
  }));

  assert.deepEqual(events, [
    { kind: "turn_end", sessionId: "session-4b" },
  ]);
});

test("normalizes terminal result usage as per-turn token telemetry", () => {
  const events = normalizer.normalizeLine(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    stop_reason: "end_turn",
    session_id: "session-usage-1",
    uuid: "result-usage-1",
    result: "ok",
    duration_ms: 4979,
    duration_api_ms: 3568,
    total_cost_usd: 0.39431375,
    num_turns: 1,
    fast_mode_state: "off",
    permission_denials: [],
    usage: {
      input_tokens: 154,
      output_tokens: 4,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 30,
      service_tier: "standard",
      inference_geo: "us",
      speed: "standard",
      iterations: [],
      server_tool_use: {
        web_search_requests: 1,
        web_fetch_requests: 2,
        future_query_text: "must not be emitted",
        future_location_flag: true,
        future_token_count: 999,
      },
      cache_creation: {
        ephemeral_1h_input_tokens: 11,
        ephemeral_5m_input_tokens: 19,
        future_cache_label: "must not be emitted",
        future_cache_flag: true,
        future_cache_tokens: 999,
      },
    },
    modelUsage: {
      "claude-opus-4-8": {
        inputTokens: 154,
        outputTokens: 4,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 30,
        webSearchRequests: 1,
        costUSD: 0.39431375,
        contextWindow: 200000,
        maxOutputTokens: 64000,
      },
    },
  }));

  assert.deepEqual(events, [
    {
      kind: "telemetry",
      name: "token_usage",
      source: "claude_result_usage",
      usageKind: "per_turn",
      sessionId: "session-usage-1",
      runtimeResultId: "result-usage-1",
      attrs: {
        totalCostUsd: 0.39431375,
        durationMs: 4979,
        durationApiMs: 3568,
        numTurns: 1,
        resultSubtype: "success",
        stopReason: "end_turn",
        resultIsError: false,
        fastModeState: "off",
        permissionDenialsCount: 0,
        serviceTier: "standard",
        inferenceGeo: "us",
        usageSpeed: "standard",
        usageIterationsCount: 0,
        serverToolUseWebSearchRequests: 1,
        serverToolUseWebFetchRequests: 2,
        cacheCreationEphemeral1hInputTokens: 11,
        cacheCreationEphemeral5mInputTokens: 19,
        modelUsageModelCount: 1,
        modelUsageModels: "claude-opus-4-8",
        modelUsageJson: "{\"claude-opus-4-8\":{\"inputTokens\":154,\"outputTokens\":4,\"cacheReadInputTokens\":20,\"cacheCreationInputTokens\":30,\"webSearchRequests\":1,\"costUSD\":0.39431375,\"contextWindow\":200000,\"maxOutputTokens\":64000}}",
        modelUsageInputTokens: 154,
        modelUsageOutputTokens: 4,
        modelUsageCachedInputTokens: 20,
        modelUsageCacheCreationInputTokens: 30,
        modelUsageWebSearchRequests: 1,
        modelUsageCostUsd: 0.39431375,
        modelUsageMaxContextWindow: 200000,
        modelUsageMaxOutputTokens: 64000,
        inputTokens: 154,
        outputTokens: 4,
        cachedInputTokens: 20,
        cacheCreationInputTokens: 30,
        totalTokens: 208,
      },
    },
    { kind: "turn_end", sessionId: "session-usage-1" },
  ]);
});

test("normalizes terminal result usage with session identity from init state", () => {
  const scopedNormalizer = new ClaudeEventNormalizer();

  assert.deepEqual(scopedNormalizer.normalizeLine(JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "session-from-init",
  })), [
    { kind: "session_init", sessionId: "session-from-init" },
  ]);

  const events = scopedNormalizer.normalizeLine(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    stop_reason: "end_turn",
    uuid: "result-without-session",
    result: "ok",
    usage: {
      input_tokens: 10,
      output_tokens: 2,
    },
  }));

  assert.deepEqual(events, [
    {
      kind: "telemetry",
      name: "token_usage",
      source: "claude_result_usage",
      usageKind: "per_turn",
      sessionId: "session-from-init",
      runtimeResultId: "result-without-session",
      attrs: {
        resultSubtype: "success",
        stopReason: "end_turn",
        resultIsError: false,
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
      },
    },
    { kind: "turn_end", sessionId: "session-from-init" },
  ]);
  assert.equal(scopedNormalizer.currentSessionId, "session-from-init");
});

test("ignores unknown scalar fields under nested Claude usage objects", () => {
  const [telemetry] = normalizer.normalizeLine(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    stop_reason: "end_turn",
    session_id: "session-usage-unknown-fields",
    uuid: "result-usage-unknown-fields",
    usage: {
      server_tool_use: {
        web_search_requests: 1,
        web_fetch_requests: 2,
        future_scalar_string: "do not emit",
        future_scalar_number: 999,
        future_scalar_boolean: true,
      },
      cache_creation: {
        ephemeral_1h_input_tokens: 3,
        ephemeral_5m_input_tokens: 4,
        future_scalar_string: "do not emit",
        future_scalar_number: 999,
        future_scalar_boolean: true,
      },
    },
  }));

  assert.equal(telemetry?.kind, "telemetry");
  assert.deepEqual(telemetry.attrs, {
    resultSubtype: "success",
    stopReason: "end_turn",
    resultIsError: false,
    serverToolUseWebSearchRequests: 1,
    serverToolUseWebFetchRequests: 2,
    cacheCreationEphemeral1hInputTokens: 3,
    cacheCreationEphemeral5mInputTokens: 4,
  });
});

test("normalizes result metadata when usage tokens are absent", () => {
  const events = normalizer.normalizeLine(JSON.stringify({
    type: "result",
    subtype: "error_max_budget_usd",
    is_error: true,
    stop_reason: "end_turn",
    session_id: "session-cost-1",
    uuid: "result-cost-1",
    result: "Budget limit exceeded",
    errors: ["Budget limit exceeded"],
    total_cost_usd: 0.0702285,
    modelUsage: {
      "claude-haiku-4-5-20251001": {
        inputTokens: 451,
        outputTokens: 56,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 55598,
        webSearchRequests: 0,
        costUSD: 0.0702285,
      },
    },
  }));

  assert.deepEqual(events, [
    { kind: "error", message: "Budget limit exceeded | Budget limit exceeded" },
    {
      kind: "telemetry",
      name: "token_usage",
      source: "claude_result_usage",
      usageKind: "per_turn",
      sessionId: "session-cost-1",
      runtimeResultId: "result-cost-1",
      attrs: {
        totalCostUsd: 0.0702285,
        resultSubtype: "error_max_budget_usd",
        stopReason: "end_turn",
        resultIsError: true,
        modelUsageModelCount: 1,
        modelUsageModels: "claude-haiku-4-5-20251001",
        modelUsageJson: "{\"claude-haiku-4-5-20251001\":{\"inputTokens\":451,\"outputTokens\":56,\"cacheReadInputTokens\":0,\"cacheCreationInputTokens\":55598,\"webSearchRequests\":0,\"costUSD\":0.0702285}}",
        modelUsageInputTokens: 451,
        modelUsageOutputTokens: 56,
        modelUsageCachedInputTokens: 0,
        modelUsageCacheCreationInputTokens: 55598,
        modelUsageWebSearchRequests: 0,
        modelUsageCostUsd: 0.0702285,
      },
    },
    { kind: "turn_end", sessionId: "session-cost-1" },
  ]);
});

test("does not normalize assistant message usage as token telemetry", () => {
  const events = normalizer.normalizeLine(JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      usage: {
        input_tokens: 100,
        output_tokens: 10,
      },
      content: [
        { type: "text", text: "hello" },
      ],
    },
  }));

  assert.deepEqual(events, [
    { kind: "text", text: "hello" },
  ]);
});

// ─────────────────────────────────────────────────────────────────────────────
// APM 1.6 6b — subagent lineage: explicit parent_tool_use_id / `system`
// task-lifecycle envelopes become subagent-marked events carrying closed lineage
// ids; a plain internal_progress WITHOUT lineage stays a flat liveness signal.
// ─────────────────────────────────────────────────────────────────────────────

test("6b: assistant tool_use with parent_tool_use_id preserves subagent lineage (not collapsed to internal_progress)", () => {
  const events = normalizer.normalizeLine(JSON.stringify({
    type: "assistant",
    parent_tool_use_id: "toolu_outer_agent_1",
    subagent_type: "Explore",
    task_description: "must not be emitted as lineage",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", name: "Read", input: { file_path: "/x.ts" } },
      ],
    },
  }));

  assert.deepEqual(events, [
    {
      kind: "tool_call",
      name: "Read",
      input: { file_path: "/x.ts" },
      subagent: { parentToolUseId: "toolu_outer_agent_1", subagentType: "Explore", phase: "active" },
    },
  ]);
  // No raw task_description in lineage.
  assert.doesNotMatch(JSON.stringify(events), /must not be emitted/);
});

test("6b: assistant text with subagent lineage carries the marker", () => {
  const events = normalizer.normalizeLine(JSON.stringify({
    type: "assistant",
    parent_tool_use_id: "toolu_outer_agent_2",
    subagent_type: "Plan",
    message: { role: "assistant", content: [{ type: "text", text: "subagent thought" }] },
  }));

  assert.deepEqual(events, [
    {
      kind: "text",
      text: "subagent thought",
      subagent: { parentToolUseId: "toolu_outer_agent_2", subagentType: "Plan", phase: "active" },
    },
  ]);
});

test("6b: system task_started becomes a subagent_progress signal with closed lineage ids", () => {
  const line = JSON.stringify({
    type: "system",
    subtype: "task_started",
    task_id: "task_abc",
    tool_use_id: "toolu_outer_agent_3",
    subagent_type: "Explore",
    last_tool_name: "Grep",
    session_id: "session-subagent-1",
  });

  assert.deepEqual(normalizer.normalizeLine(line), [
    {
      kind: "subagent_progress",
      source: "claude_task_lifecycle",
      phase: "started",
      taskId: "task_abc",
      parentToolUseId: "toolu_outer_agent_3",
      subagentType: "Explore",
      lastToolName: "Grep",
      payloadBytes: Buffer.byteLength(line, "utf8"),
    },
  ]);
});

test("6b: system task_progress and task_notification map to bounded phases", () => {
  const progressLine = JSON.stringify({ type: "system", subtype: "task_progress", task_id: "t1" });
  const notificationLine = JSON.stringify({ type: "system", subtype: "task_notification", task_id: "t1" });

  assert.equal(normalizer.normalizeLine(progressLine)[0]?.kind, "subagent_progress");
  assert.equal((normalizer.normalizeLine(progressLine)[0] as any)?.phase, "progress");
  assert.equal((normalizer.normalizeLine(notificationLine)[0] as any)?.phase, "notification");
});

test("6a: plain stream_event internal_progress without lineage stays a flat liveness signal (no subagent)", () => {
  const line = JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
    session_id: "session-flat-1",
  });

  const events = normalizer.normalizeLine(line);
  assert.deepEqual(events, [
    {
      kind: "internal_progress",
      source: "claude_stream_event",
      itemType: "content_block_delta",
      payloadBytes: Buffer.byteLength(line, "utf8"),
    },
  ]);
  // Never fabricate subagent lineage from a plain progress row.
  assert.equal((events[0] as any).subagent, undefined);
});

test("6b: assistant WITHOUT lineage stays flat (ordinary tool_call, no subagent marker)", () => {
  const events = normalizer.normalizeLine(JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
  }));

  assert.deepEqual(events, [
    { kind: "tool_call", name: "Bash", input: { command: "ls" } },
  ]);
  assert.equal((events[0] as any).subagent, undefined);
});

test("normalizes user tool_result as a steering boundary", () => {
  const events = normalizer.normalizeLine(JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_123", content: "ok" }],
    },
  }));

  assert.deepEqual(events, [
    { kind: "tool_output", name: "toolu_123" },
  ]);
});
