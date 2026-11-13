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
import { ClaudeEventNormalizer, claudeToolResultOutcome, parseClaudeRateLimitInfo } from "./claudeEventNormalizer";

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

test("a task's task_type says whether it is a sub-agent; a command task's later envelopes, which name none, keep it", () => {
  // Envelopes as Claude Code 2.1.311 sends them (captured 2026-11-05): a
  // foreground Bash that ran ~7 s, and an Agent tool sub-agent.
  const bashStarted = JSON.stringify({ type: "system", subtype: "task_started", task_id: "b13bfy1qy", run_id: "0mw35citi-86e1bf53", tool_use_id: "toolu_01BK8sa4u2hD8tmMi7ajhuTn", description: "Sleep 7 seconds then echo done", is_backgrounded: false, task_type: "local_bash", uuid: "6c08dce7-195a-46b3-a56d-0a979b9acbb2", session_id: "s-task-kind" });
  const bashDone = JSON.stringify({ type: "system", subtype: "task_notification", task_id: "b13bfy1qy", run_id: "0mw35citi-86e1bf53", tool_use_id: "toolu_01BK8sa4u2hD8tmMi7ajhuTn", status: "completed", output_file: "", summary: "Sleep 7 seconds then echo done", uuid: "72269056-9dac-4cd2-b29a-28f9031ca331", session_id: "s-task-kind" });
  const agentStarted = JSON.stringify({ type: "system", subtype: "task_started", task_id: "ab0d4888d1aa52da2", tool_use_id: "toolu_01Wk5KTNo6jeNbZw4KNXDzqK", description: "Reply with hi", subagent_type: "general-purpose", is_backgrounded: true, spawn_depth: 1, task_type: "local_agent", session_id: "s-task-kind" });
  const agentDone = JSON.stringify({ type: "system", subtype: "task_notification", task_id: "ab0d4888d1aa52da2", tool_use_id: "toolu_01Wk5KTNo6jeNbZw4KNXDzqK", status: "completed", session_id: "s-task-kind" });

  const [started] = normalizer.normalizeLine(bashStarted) as any[];
  assert.equal(started.kind, "subagent_progress");
  assert.equal(started.taskKind, "command");
  // A notification with no closed status is not the task's end: the kind stays.
  const noStatus = JSON.stringify({ type: "system", subtype: "task_notification", task_id: "b13bfy1qy", session_id: "s-task-kind" });
  assert.equal((normalizer.normalizeLine(noStatus)[0] as any).taskKind, "command");
  const [done] = normalizer.normalizeLine(bashDone) as any[];
  assert.equal(done.taskKind, "command", "the notification names no task_type: the started one carries over");
  assert.equal(done.taskStatus, "completed");
  assert.equal((normalizer.normalizeLine(agentStarted)[0] as any).taskKind, "agent");
  assert.equal((normalizer.normalizeLine(agentDone)[0] as any).taskKind, undefined);
  // An envelope with no task_type for an unknown task is a sub-agent, as before.
  assert.equal((normalizer.normalizeLine(JSON.stringify({ type: "system", subtype: "task_started", task_id: "old" }))[0] as any).taskKind, undefined);
  assert.equal((normalizer.normalizeLine(JSON.stringify({ type: "system", subtype: "task_started", task_id: "w1", task_type: "local_workflow" }))[0] as any).taskKind, "other");
  assert.equal((normalizer.normalizeLine(JSON.stringify({ type: "system", subtype: "task_started", task_id: "tm1", task_type: "in_process_teammate" }))[0] as any).taskKind, "agent");
});

test("6b: system task_progress and task_notification map to bounded phases", () => {
  const progressLine = JSON.stringify({ type: "system", subtype: "task_progress", task_id: "t1" });
  const notificationLine = JSON.stringify({ type: "system", subtype: "task_notification", task_id: "t1" });

  assert.equal(normalizer.normalizeLine(progressLine)[0]?.kind, "subagent_progress");
  assert.equal((normalizer.normalizeLine(progressLine)[0] as any)?.phase, "progress");
  assert.equal((normalizer.normalizeLine(notificationLine)[0] as any)?.phase, "notification");
  assert.equal((normalizer.normalizeLine(notificationLine)[0] as any)?.taskStatus, undefined, "no status field: nothing invented");
});

test("task #1260: task_notification carries its closed terminal status; other values and other phases carry none", () => {
  for (const status of ["completed", "failed", "stopped"] as const) {
    const line = JSON.stringify({ type: "system", subtype: "task_notification", task_id: "t1", tool_use_id: "toolu_1", status, summary: "secret summary text" });
    const [event] = normalizer.normalizeLine(line) as any[];
    assert.equal(event?.phase, "notification");
    assert.equal(event?.taskStatus, status);
    assert.equal(event?.taskId, "t1");
    assert.doesNotMatch(JSON.stringify(event), /secret summary/, "summary text never leaves the envelope");
  }
  const odd = JSON.stringify({ type: "system", subtype: "task_notification", task_id: "t1", status: "exploded" });
  assert.equal((normalizer.normalizeLine(odd)[0] as any)?.taskStatus, undefined);
  const started = JSON.stringify({ type: "system", subtype: "task_started", task_id: "t1", status: "completed" });
  assert.equal((normalizer.normalizeLine(started)[0] as any)?.taskStatus, undefined, "status is read on notifications only");
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
    { kind: "tool_output", name: "toolu_123", callId: "toolu_123", ok: true },
  ]);
});

// task #379 — Claude Code wraps API errors (usage limits, auth, overload) in an
// assistant message carrying the SDK `error` field. Field sample (KopiC,
// #proj-runtime:f0eadc47): `error: "rate_limit"`, model `<synthetic>`, text
// "You've reached your Fable limit. ...", followed by a result with is_error.
const QUOTA_TEXT = "You've reached your Fable limit. Switch to another model, or manage usage credits at claude.ai.";

function syntheticApiErrorAssistant(error: string, text: string, extraContent: unknown[] = []) {
  return JSON.stringify({
    type: "assistant",
    error,
    message: { model: "<synthetic>", content: [{ type: "text", text }, ...extraContent] },
    session_id: "session-379",
  });
}

test("task #379: an assistant message with the SDK error field is an error, not model text", () => {
  const fresh = new ClaudeEventNormalizer();
  assert.deepEqual(fresh.normalizeLine(syntheticApiErrorAssistant("rate_limit", QUOTA_TEXT)), [
    {
      kind: "error",
      message: QUOTA_TEXT,
      nativeReasonPresent: true,
      reasonProvenance: "runtime_error_event",
      providerLimit: { kind: "quota_exhausted" },
      // The typed code, for the error's trace class (RateLimitError).
      providerError: { codes: ["rate_limit"] },
    },
  ]);
});

test("task #379: the result of a turn whose API error was already reported does not report it twice", () => {
  const fresh = new ClaudeEventNormalizer();
  fresh.normalizeLine(syntheticApiErrorAssistant("rate_limit", QUOTA_TEXT));
  assert.deepEqual(fresh.normalizeLine(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: true,
    result: QUOTA_TEXT,
    session_id: "session-379",
  })), [{ kind: "turn_end", sessionId: "session-379" }]);
  // The suppression is per turn: the next failed result still reports.
  assert.deepEqual(fresh.normalizeLine(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: true,
    result: "Execution failed for another reason",
    session_id: "session-379",
  })), [
    { kind: "error", message: "Execution failed for another reason" },
    { kind: "turn_end", sessionId: "session-379" },
  ]);
});

const BEFORE_RESET_MS = 1791800000 * 1000;

test("task #379: a rejected rate-limit window marks the limit as used up and carries its reported reset time", () => {
  const fresh = new ClaudeEventNormalizer(() => BEFORE_RESET_MS);
  fresh.normalizeLine(JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: { status: "rejected", resetsAt: 1791900000, rateLimitType: "seven_day" },
    session_id: "session-379",
  }));
  const [event] = fresh.normalizeLine(syntheticApiErrorAssistant("rate_limit", "API Error: Rate limit reached"));
  assert.deepEqual(event && event.kind === "error" ? event.providerLimit : null, {
    kind: "quota_exhausted",
    resetsAt: new Date(1791900000 * 1000).toISOString(),
  });
});

test("task #379: a rate limit without used-up evidence stays a transient throttle", () => {
  const fresh = new ClaudeEventNormalizer();
  fresh.normalizeLine(JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed_warning", resetsAt: 1791900000 },
    session_id: "session-379",
  }));
  const [event] = fresh.normalizeLine(syntheticApiErrorAssistant("rate_limit", "API Error: Request rate limited, retrying shortly"));
  assert.deepEqual(event && event.kind === "error" ? event.providerLimit : null, { kind: "transient_rate_limit" });
});

test("a Claude API error carries its typed code and status; a result error carries them when it reports them", () => {
  const fresh = new ClaudeEventNormalizer();
  const [event] = fresh.normalizeLine(JSON.stringify({
    type: "assistant",
    error: "rate_limit",
    is_api_error_message: true,
    api_error_status: 429,
    api_error_code: "rate_limit_error",
    message: { model: "<synthetic>", content: [{ type: "text", text: "You've hit your limit · resets 1pm (UTC)" }] },
    session_id: "session-379",
  }));
  assert.deepEqual(event && event.kind === "error" ? event.providerError : null, { codes: ["rate_limit_error", "rate_limit"], httpStatus: 429 });

  const [resultError] = new ClaudeEventNormalizer().normalizeLine(JSON.stringify({
    type: "result", subtype: "success", is_error: true, api_error_status: 529, result: "API Error: Overloaded", session_id: "session-379",
  }));
  assert.deepEqual(resultError, { kind: "error", message: "API Error: Overloaded", providerError: { httpStatus: 529 } });
});

test("task #379: other SDK errors are errors without a provider-limit classification", () => {
  const fresh = new ClaudeEventNormalizer();
  assert.deepEqual(fresh.normalizeLine(syntheticApiErrorAssistant("overloaded", "API Error: Overloaded")), [
    { kind: "error", message: "API Error: Overloaded", nativeReasonPresent: true, reasonProvenance: "runtime_error_event", providerError: { codes: ["overloaded"] } },
  ]);
});

test("task #379: ordinary model text and messages with tool calls are unchanged", () => {
  const fresh = new ClaudeEventNormalizer();
  // Model text that merely mentions a limit is still model text.
  assert.deepEqual(fresh.normalizeLine(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "You've reached your Fable limit is what the user saw." }] },
  })), [{ kind: "text", text: "You've reached your Fable limit is what the user saw." }]);
  // A message that also calls a tool is a working turn, never an API-error wrapper.
  const events = fresh.normalizeLine(syntheticApiErrorAssistant("rate_limit", QUOTA_TEXT, [
    { type: "tool_use", name: "Bash", input: { command: "true" } },
  ]));
  assert.deepEqual(events.map((event) => event.kind), ["text", "tool_call"]);
});

test("task #379: a rejected window past its reported reset is no longer used-up evidence", () => {
  let now = BEFORE_RESET_MS;
  const fresh = new ClaudeEventNormalizer(() => now);
  fresh.normalizeLine(JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: { status: "rejected", resetsAt: 1791900000 },
    session_id: "session-379",
  }));
  now = 1791900001 * 1000;
  const [event] = fresh.normalizeLine(syntheticApiErrorAssistant("rate_limit", "API Error: Request rate limited, retrying shortly"));
  assert.deepEqual(event && event.kind === "error" ? event.providerLimit : null, { kind: "transient_rate_limit" });
});

test("task #379: a rejected window from another session is not used-up evidence (reviewer counterexample)", () => {
  // Huaihuai's counterexample on 300884c4: rejected/resetsAt=1 for session
  // old, system/init for session new, then an ordinary throttle.
  const fresh = new ClaudeEventNormalizer(() => 0);
  fresh.normalizeLine(JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: { status: "rejected", resetsAt: 1 },
    session_id: "session-old",
  }));
  fresh.normalizeLine(JSON.stringify({ type: "system", subtype: "init", session_id: "session-new" }));
  const [event] = fresh.normalizeLine(JSON.stringify({
    type: "assistant",
    error: "rate_limit",
    message: { model: "<synthetic>", content: [{ type: "text", text: "Too many requests, retry shortly" }] },
    session_id: "session-new",
  }));
  assert.deepEqual(event && event.kind === "error" ? event.providerLimit : null, { kind: "transient_rate_limit" });
});

test("task #379: a rejected window without a reset time does not cross into another session", () => {
  // Expiry cannot decide this case (no resetsAt), so only the session scope can.
  const fresh = new ClaudeEventNormalizer(() => BEFORE_RESET_MS);
  fresh.normalizeLine(JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: { status: "rejected" },
    session_id: "session-old",
  }));
  const [sameSession] = fresh.normalizeLine(JSON.stringify({
    type: "assistant",
    error: "rate_limit",
    message: { model: "<synthetic>", content: [{ type: "text", text: "Too many requests, retry shortly" }] },
    session_id: "session-old",
  }));
  assert.deepEqual(sameSession && sameSession.kind === "error" ? sameSession.providerLimit : null, { kind: "quota_exhausted" });
  fresh.normalizeLine(JSON.stringify({ type: "result", subtype: "success", is_error: true, session_id: "session-old" }));
  fresh.normalizeLine(JSON.stringify({ type: "system", subtype: "init", session_id: "session-new" }));
  const [otherSession] = fresh.normalizeLine(JSON.stringify({
    type: "assistant",
    error: "rate_limit",
    message: { model: "<synthetic>", content: [{ type: "text", text: "Too many requests, retry shortly" }] },
    session_id: "session-new",
  }));
  assert.deepEqual(otherSession && otherSession.kind === "error" ? otherSession.providerLimit : null, { kind: "transient_rate_limit" });
});

test("task #17: tool_use carries its id and tool_result its outcome; a non-zero Bash exit is an ok call with the exit code", () => {
  const n = new ClaudeEventNormalizer();
  assert.deepEqual(n.normalizeLine(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "toolu_9", name: "Bash", input: { command: "pnpm test" } }] },
  })), [{ kind: "tool_call", name: "Bash", input: { command: "pnpm test" }, callId: "toolu_9" }]);
  // Shape from a real Claude Code transcript: "Exit code 1\n…" with is_error.
  assert.deepEqual(n.normalizeLine(JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_9", content: "Exit code 1\n2 tests failed", is_error: true }] },
  })), [{ kind: "tool_output", name: "toolu_9", callId: "toolu_9", ok: true, exitCode: 1 }]);
  assert.deepEqual(n.normalizeLine(JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_10", content: [{ type: "text", text: "File does not exist." }], is_error: true }] },
  })), [{ kind: "tool_output", name: "toolu_10", callId: "toolu_10", ok: false }]);
});

// Pins the text format claudeToolResultOutcome depends on. Claude Code reports a
// non-zero Bash exit only as text ("Exit code N" first line, is_error true). If
// a Claude Code upgrade changes that wording, this test must be updated together
// with the matcher; otherwise non-zero exits silently degrade to ok: false.
test("task #17: Exit code N format of Claude Code Bash tool_result maps to ok with the exit code", () => {
  assert.deepEqual(claudeToolResultOutcome({ is_error: true, content: "Exit code 1\n2 tests failed" }), { ok: true, exitCode: 1 });
  assert.deepEqual(claudeToolResultOutcome({ is_error: true, content: "Exit code 127\nbash: foo: command not found" }), { ok: true, exitCode: 127 });
  assert.deepEqual(claudeToolResultOutcome({ is_error: true, content: [{ type: "text", text: "Exit code 2" }] }), { ok: true, exitCode: 2 });
  // Only the leading line counts: an exit-code mention elsewhere is not the Bash format.
  assert.deepEqual(claudeToolResultOutcome({ is_error: true, content: "Error: tool failed (Exit code 1)" }), { ok: false });
  assert.deepEqual(claudeToolResultOutcome({ is_error: true, content: "Exit code: 1" }), { ok: false });
  assert.deepEqual(claudeToolResultOutcome({ is_error: false, content: "Exit code 1" }), { ok: true });
  assert.deepEqual(claudeToolResultOutcome({ content: "done" }), { ok: true });
});

test("task #25 step 2: the failed result after a requested interrupt ends the turn as interrupted, without an error, once", () => {
  const fresh = new ClaudeEventNormalizer();
  const interruptedResult = JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    stop_reason: null,
    result: "",
    session_id: "session-1",
  });

  fresh.noteInterruptRequested();
  assert.deepEqual(
    fresh.normalizeLine(interruptedResult).filter((event) => event.kind !== "telemetry"),
    [{ kind: "turn_end", sessionId: "session-1", interrupted: true }],
  );
  assert.ok(
    fresh.normalizeLine(interruptedResult).some((event) => event.kind === "error"),
    "a later failure without a requested interrupt is an error again",
  );
  assert.deepEqual(fresh.normalizeLine(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "raft-interrupt-1" } })), []);
});

test("#54: the result's usage carries the context the main agent's last request carried; a sub-agent's request doesn't count", () => {
  const fresh = new ClaudeEventNormalizer();
  const assistant = (usage: Record<string, number>, lineage?: Record<string, unknown>) => JSON.stringify({
    type: "assistant",
    ...(lineage ?? {}),
    message: { content: [{ type: "text", text: "working" }], usage },
  });
  fresh.normalizeLine(assistant({ input_tokens: 10, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 5_000 }));
  fresh.normalizeLine(assistant({ input_tokens: 20, cache_read_input_tokens: 205_000, cache_creation_input_tokens: 3_000 }));
  fresh.normalizeLine(assistant({ input_tokens: 1, cache_read_input_tokens: 999_999 }, { parent_tool_use_id: "toolu_sub" }));
  const events = fresh.normalizeLine(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    stop_reason: "end_turn",
    usage: { input_tokens: 30, output_tokens: 9, cache_read_input_tokens: 405_000, cache_creation_input_tokens: 8_000 },
  }));
  const usage = events.find((event) => event.kind === "telemetry");
  assert.ok(usage && usage.kind === "telemetry");
  assert.equal(usage.attrs.lastRequestContextTokens, 208_020, "the last main request: 20 + 205,000 + 3,000, not the turn's sum");
  assert.equal(usage.attrs.inputTokens, 30, "the per-turn sum is unchanged");
});

// Shape confirmed from the rate_limit_info schema in Claude Code 2.1.317
// (top-level status / resetsAt in epoch seconds / rateLimitType / utilization /
// surpassedThreshold, plus overage and per-window fields the daemon ignores).
test("rate_limit_event: a warning reading carries a provider quota observation", () => {
  const fresh = new ClaudeEventNormalizer(() => BEFORE_RESET_MS);
  const events = fresh.normalizeLine(JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed_warning",
      resetsAt: 1791900000,
      rateLimitType: "five_hour",
      utilization: 0.91,
      surpassedThreshold: 0.9,
      isUsingOverage: false,
      overageStatus: "rejected",
      overageDisabledReason: "org_level_disabled",
      unifiedWindows: { five_hour: { utilization: 0.91, resetsAt: 1791900000, status: "allowed_warning", surpassedThreshold: 0.9 } },
    },
    uuid: "c0ffee00-0000-4000-8000-000000000000",
    session_id: "session-quota",
  }));
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event?.kind, "telemetry");
  assert.deepEqual(event?.kind === "telemetry" ? event.providerQuota : null, {
    status: "allowed_warning",
    utilization: 0.91,
    surpassedThreshold: 0.9,
    rateLimitType: "five_hour",
    resetsAtMs: 1791900000 * 1000,
  });
  assert.deepEqual(event?.kind === "telemetry" ? event.attrs : null, {
    status: "allowed_warning",
    resetsAt: 1791900000,
    rateLimitType: "five_hour",
    overageStatus: "rejected",
    isUsingOverage: false,
  }, "the existing rate_limits telemetry is unchanged");
});

test("rate_limit_event: malformed or unknown rate_limit_info yields no quota observation", () => {
  for (const info of [undefined, null, "allowed", [], {}, { status: "maybe" }, { status: 3 }]) {
    assert.equal(parseClaudeRateLimitInfo(info, BEFORE_RESET_MS), undefined, JSON.stringify(info));
    const fresh = new ClaudeEventNormalizer();
    const [event] = fresh.normalizeLine(JSON.stringify({ type: "rate_limit_event", rate_limit_info: info, session_id: "s" }));
    assert.equal(event?.kind === "telemetry" ? event.providerQuota : "not telemetry", undefined);
  }
  assert.deepEqual(
    parseClaudeRateLimitInfo({ status: "allowed", utilization: "high", resetsAt: "soon", rateLimitType: "ten_minute", surpassedThreshold: Number.NaN }, BEFORE_RESET_MS),
    { status: "allowed" },
    "fields of the wrong type are dropped",
  );
  assert.deepEqual(new ClaudeEventNormalizer().normalizeLine("{not json"), []);
});

test("rate_limit_event: a resetsAt outside the coming year is not a reset", () => {
  const nowSec = BEFORE_RESET_MS / 1000;
  const cases: Array<[string, number]> = [
    ["oversized (new Date would throw)", 1e20],
    ["millisecond-scale", BEFORE_RESET_MS + 3_600_000],
    ["more than a year ahead", nowSec + 366 * 86_400],
  ];
  for (const [label, resetsAt] of cases) {
    assert.deepEqual(parseClaudeRateLimitInfo({ status: "rejected", resetsAt, rateLimitType: "five_hour" }, BEFORE_RESET_MS), {
      status: "rejected",
      rateLimitType: "five_hour",
    }, label);
  }
  assert.deepEqual(
    parseClaudeRateLimitInfo({ status: "rejected", resetsAt: nowSec + 3600 }, BEFORE_RESET_MS),
    { status: "rejected", resetsAtMs: BEFORE_RESET_MS + 3_600_000 },
    "an hour ahead is kept",
  );
  assert.deepEqual(
    parseClaudeRateLimitInfo({ status: "rejected", resetsAt: nowSec - 60 }, BEFORE_RESET_MS),
    { status: "rejected", resetsAtMs: BEFORE_RESET_MS - 60_000 },
    "a past reset is kept, so the store can expire the reading at once",
  );
});

// #proj-raft-computer:#68 — Claude refuses every call until the account
// holder verifies the account (HTTP 403 `verification_required`). Both
// fixtures are real samples: live stream-json (snake_case, a `result` line
// with `subtype: "success"` + `is_error: true`) and persisted session JSONL
// (camelCase `isApiErrorMessage`, no status).
test("#68: verification_required from live stream-json and from session JSONL is one typed account error, never the provider's text", async () => {
  const { readFile } = await import("node:fs/promises");
  const { buildRuntimeErrorActivityDiagnostic, credentialInvalidReasonOf, credentialProblemCodeOf, CREDENTIAL_PROBLEM_MESSAGES } = await import("../runtimeErrorDiagnostics");
  const live = JSON.parse(await readFile(new URL("./fixtures/claude-verification-required.live.json", import.meta.url), "utf8")) as { prompt: { events: unknown[] } };
  const jsonl = JSON.parse(await readFile(new URL("./fixtures/claude-verification-required.jsonl.json", import.meta.url), "utf8")) as { samples: unknown[] };
  const expected = { kind: "error", message: CREDENTIAL_PROBLEM_MESSAGES.verification_required, nativeReasonPresent: true, reasonProvenance: "runtime_error_event" };

  // The typed code and status ride along for the error's trace class and
  // status (AuthError, 403); session JSONL has no status.
  const live403 = { ...expected, providerError: { codes: ["verification_required"], httpStatus: 403 } };
  const fresh = new ClaudeEventNormalizer();
  const [assistantLine, resultLine] = live.prompt.events;
  assert.deepEqual(fresh.normalizeLine(JSON.stringify(assistantLine)), [live403]);
  // The result line repeats the same fact: no second error.
  const resultEvents = fresh.normalizeLine(JSON.stringify(resultLine));
  assert.equal(resultEvents.filter((event) => event.kind === "error").length, 0);
  assert.ok(resultEvents.some((event) => event.kind === "turn_end"));
  // A result line alone (no assistant line before it) still says it once.
  const resultOnly = new ClaudeEventNormalizer().normalizeLine(JSON.stringify(resultLine));
  assert.deepEqual(resultOnly.filter((event) => event.kind === "error"), [live403]);

  for (const sample of jsonl.samples) {
    assert.deepEqual(new ClaudeEventNormalizer().normalizeLine(JSON.stringify(sample)), [{ ...expected, providerError: { codes: ["verification_required"] } }]);
  }

  // Old servers pause and tell the owner: AuthError + user_reauth; the readiness code rides along.
  const message = expected.message;
  assert.equal(credentialInvalidReasonOf(message), "user_reauth");
  assert.equal(credentialProblemCodeOf(message), "verification_required");
  const diagnostic = buildRuntimeErrorActivityDiagnostic(message);
  assert.equal(diagnostic.errorClass, "AuthError");
  assert.equal(diagnostic.requiredAction, "user_reauth");
  assert.equal(diagnostic.readinessCode, "verification_required");
  // The provider's own wording is never classified as an account problem.
  const providerText = "API Error: Your account can't receive replies from Claude right now. You can find the next step in the Anthropic Verification Portal: https://evil.example/verify";
  assert.equal(credentialProblemCodeOf(providerText), null);
  assert.equal(credentialInvalidReasonOf(providerText), null);
});
