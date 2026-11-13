import assert from "node:assert/strict";
import type { Event } from "@botiverse/oar";
import { OarActivityProjector } from "./oarActivity";

const envelope = { sessionId: "s-1", agentPath: [] as string[], seq: 1, receivedAt: 0 };
const event = (body: Record<string, unknown>, agentPath: string[] = [], receivedAt = 0): Event => ({ ...envelope, agentPath, receivedAt, ...body }) as unknown as Event;
const facts = (e: Event, projector = new OarActivityProjector()) => projector.facts(e);

test("text, reasoning, tool and compaction events map to the legacy activity shapes", () => {
  assert.deepEqual(facts(event({ kind: "text_delta", text: "hi" })), [{
    activityKind: "working", detail: "", detailKind: "model_response_started", entries: [{ kind: "text", text: "hi" }],
  }]);
  assert.deepEqual(facts(event({ kind: "reasoning", content: { kind: "text", text: "hmm" } })), [{
    activityKind: "thinking", detail: "", detailKind: "thinking_started", entries: [{ kind: "thinking", text: "hmm" }],
  }]);
  const projector = new OarActivityProjector();
  const [tool] = projector.facts(event({ kind: "tool_call_started", callId: "c-1", tool: "run_terminal_command", input: JSON.stringify({ command: "ls" }) }, [], 1_000));
  assert.equal(tool?.activityKind, "working");
  assert.equal(tool?.entries[0]?.kind, "tool_start");
  assert.equal(tool?.entries[0]?.kind === "tool_start" && tool.entries[0].callId, "c-1");
  assert.equal(facts(event({ kind: "compaction_started" }))[0]?.detailKind, "compacting_context");
  assert.equal(facts(event({ kind: "compaction_ended", outcome: "completed" }))[0]?.detailKind, "compaction_finished");
  assert.equal(facts(event({ kind: "compaction_ended", outcome: "failed", reason: "x" }))[0]?.detailKind, "runtime_error");
});

test("a tool end carries its call id, outcome, exit code and duration, as the process manager's does", () => {
  const projector = new OarActivityProjector();
  projector.facts(event({ kind: "tool_call_started", callId: "c-1", tool: "run_terminal_command", input: "{}" }, [], 1_000));
  assert.deepEqual(projector.facts(event({ kind: "tool_call_ended", callId: "c-1", result: "failed", exitCode: 2 }, [], 3_500)), [{
    activityKind: "working", detail: "Tool finished", detailKind: "tool_end",
    // A command that ran is ok whatever its exit status (ToolCallOutcome).
    entries: [{ kind: "status", activity: "working", detail: "Tool finished", detailKind: "tool_end", tool: { callId: "c-1", ok: true, durationMs: 2_500, exitCode: 2 } }],
  }]);
  // No start seen (and nothing reported): just the id.
  assert.deepEqual(projector.facts(event({ kind: "tool_call_ended", callId: "c-9" }))[0]?.entries, [
    { kind: "status", activity: "working", detail: "Tool finished", detailKind: "tool_end", tool: { callId: "c-9" } },
  ]);
  // A failed call that ran no command.
  assert.deepEqual(projector.facts(event({ kind: "tool_call_ended", callId: "c-8", result: "failed" }))[0]?.entries, [
    { kind: "status", activity: "working", detail: "Tool finished", detailKind: "tool_end", tool: { callId: "c-8", ok: false } },
  ]);
});

test("a sub-agent's events, empty text and facts without activity map to nothing", () => {
  assert.deepEqual(facts(event({ kind: "text_delta", text: "child" }, ["child-1"])), []);
  assert.deepEqual(facts(event({ kind: "text_delta", text: "" })), []);
  assert.deepEqual(facts(event({ kind: "reasoning", content: { kind: "redacted" } })), []);
  assert.deepEqual(facts(event({ kind: "usage", usage: {} })), []);
  assert.deepEqual(facts(event({ kind: "turn_ended", outcome: { kind: "completed" } })), []);
});

test("a tool input that is not JSON (or was truncated) still names the tool", () => {
  const [tool] = facts(event({ kind: "tool_call_started", callId: "c-2", tool: "edit_file", input: "{\"path\": \"a" }));
  assert.equal(tool?.entries[0]?.kind === "tool_start" && tool.entries[0].toolName, "edit_file");
});

test("a runtime reading renames tool calls, splits ends, and keeps text out", () => {
  const projector = new OarActivityProjector({
    toolCalls: (e) => (e.tool === "pair" ? [{ name: "shell", input: { command: "a" }, callId: `${e.callId}:0` }, { name: "shell", input: { command: "b" }, callId: `${e.callId}:1` }] : null),
    toolEnds: (e) => (e.callId === "p" ? { late: [], callIds: ["p:0", "p:1"] } : null),
    visibleText: (e) => (e.text === "aside" ? "" : null),
  });
  assert.deepEqual(projector.facts(event({ kind: "tool_call_started", callId: "p", tool: "pair" })).map((f) => f.entries[0]?.kind === "tool_start" && f.entries[0].callId), ["p:0", "p:1"]);
  assert.deepEqual(projector.facts(event({ kind: "tool_call_ended", callId: "p" })).map((f) => (f.entries[0] as { tool?: { callId?: string } }).tool?.callId), ["p:0", "p:1"]);
  assert.deepEqual(projector.facts(event({ kind: "text_delta", text: "aside" })), []);
  assert.equal(projector.facts(event({ kind: "text_delta", text: "said" })).length, 1);
});

test("retry: shows as reconnecting with the runtime's reason, scrubbed, in the runtime's wording where it has one", () => {
  const event = { kind: "retry", attempt: 1, reason: "Reconnecting... 1/5", sessionId: "s", agentPath: [], seq: 1, receivedAt: 1 } as unknown as Parameters<OarActivityProjector["facts"]>[0];
  const status = (detail: string) => ({ kind: "status", activity: "working", detail, detailKind: "runtime_reconnecting" });

  assert.deepEqual(new OarActivityProjector().facts(event), [{
    activityKind: "working",
    detail: "Retrying model request",
    detailKind: "runtime_reconnecting",
    entries: [{ kind: "text", text: "Reconnecting... 1/5" }, status("Retrying model request")],
  }]);
  assert.equal(new OarActivityProjector({ retryDetail: "Codex reconnecting to provider…" }).facts(event)[0]?.detail, "Codex reconnecting to provider…");
  assert.deepEqual(new OarActivityProjector().facts({ ...event, reason: undefined } as typeof event)[0]?.entries, [status("Retrying model request")]);
  assert.deepEqual(new OarActivityProjector().facts({ ...event, agentPath: ["child"] } as typeof event), []);
  const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789abcdefgh";
  const scrubbed = new OarActivityProjector().facts({ ...event, reason: `failed: Authorization: Bearer ${secret}` } as typeof event)[0]!;
  assert.ok(!JSON.stringify(scrubbed).includes(secret));
});

test("OAR's classification names a command or a file the same way on every runtime", async () => {
  const { classifyTool } = await import("@botiverse/oar/observe");
  const row = (runtime: string, tool: string, input: unknown) => {
    const projector = new OarActivityProjector({}, (name, text) => classifyTool(runtime, name, text));
    const [fact] = projector.facts(event({ kind: "tool_call_started", callId: "c", tool, input: JSON.stringify(input) }));
    const entry = fact?.entries[0];
    return entry?.kind === "tool_start" ? [fact?.detailKind, entry.toolName, entry.toolInput] : null;
  };
  const command = ["running_command", "bash", "ls -la"];
  assert.deepEqual(row("grok", "run_terminal_command", { command: "ls -la" }), command);
  assert.deepEqual(row("qwen", "run_shell_command", { command: "ls -la" }), command);
  assert.deepEqual(row("qoder", "Bash", { command: "ls -la" }), command);
  assert.deepEqual(row("antigravity", "run_command", { CommandLine: "ls -la" }), command);
  const edit = ["tool_started", "edit_file", "a.ts"];
  assert.deepEqual(row("grok", "search_replace", { file_path: "a.ts", old_string: "x", new_string: "y" }), edit);
  assert.deepEqual(row("antigravity", "edit_file", { Path: "a.ts" }), edit);
  // Since OAR 0.94: reads and searches, the search by its pattern, not its path.
  assert.deepEqual(row("grok", "read_file", { target_file: "a.ts" }), ["tool_started", "read_file", "a.ts"]);
  assert.deepEqual(row("qoder", "Read", { file_path: "a.ts" }), ["tool_started", "read_file", "a.ts"]);
  assert.deepEqual(row("qwen", "grep_search", { pattern: "foo", path: "src" })?.slice(1), ["grep", "foo"]);
  // A long input is capped at the row, whatever the runtime sent.
  const long = row("grok", "search_replace", { file_path: "p".repeat(5000) });
  assert.ok(String(long?.[2]).length <= 2001);
  // A tool OAR doesn't know keeps its own name; so does input that doesn't parse.
  assert.equal(row("grok", "some_custom_tool", { a: 1 })?.[1], "some_custom_tool");
  const projector = new OarActivityProjector({}, (name, text) => classifyTool("grok", name, text));
  const [plain] = projector.facts(event({ kind: "tool_call_started", callId: "d", tool: "some_custom_tool", input: "not json" }));
  assert.equal(plain?.entries[0]?.kind === "tool_start" && plain.entries[0].toolInput, "");
});

test("a raft command classified as a command still reads as the Raft operation it is", async () => {
  const { classifyTool } = await import("@botiverse/oar/observe");
  const projector = new OarActivityProjector({}, (name, text) => classifyTool("grok", name, text));
  const [fact] = projector.facts(event({ kind: "tool_call_started", callId: "e", tool: "run_terminal_command", input: JSON.stringify({ command: "raft message check" }) }));
  assert.equal(fact?.detailKind, "checking_messages");
});
