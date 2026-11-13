import assert from "node:assert/strict";
import type { Event, RawEvent } from "@botiverse/oar";
import { OarActivityProjector } from "./oarActivity";
import { CodexActivityReader } from "./oarCodexActivity";

const ROOT = "thread-root";
let seq = 0;
const frame = (type: string, native: Record<string, unknown>, sessionId = ROOT): RawEvent =>
  ({ kind: "frame", sessionId, agentPath: [], seq: ++seq, receivedAt: seq, body: { type, native, events: [] } }) as unknown as RawEvent;
const event = (body: Record<string, unknown>, receivedAt = 0): Event =>
  ({ sessionId: ROOT, agentPath: [], seq: ++seq, receivedAt, ...body }) as unknown as Event;

function setup() {
  const codex = new CodexActivityReader(ROOT);
  const projector = new OarActivityProjector(codex);
  codex.observe(frame("turn/started", { threadId: ROOT, turn: { id: "t-1" } }));
  return { codex, projector };
}

function toolStarts(facts: ReturnType<OarActivityProjector["facts"]>) {
  return facts.map((fact) => {
    const entry = fact.entries[0];
    return entry?.kind === "tool_start" ? { detail: fact.detail, detailKind: fact.detailKind, toolName: entry.toolName, toolInput: entry.toolInput, callId: entry.callId } : null;
  });
}

test("a command reads as the legacy shell call, and a raft command as what it does", () => {
  const { projector } = setup();
  const [ls] = toolStarts(projector.facts(event({ kind: "tool_call_started", callId: "cmd-1", tool: "commandExecution", input: "/bin/bash -lc 'ls -la'" })));
  assert.equal(ls?.detailKind, "running_command");
  assert.equal(ls?.callId, "cmd-1");
  assert.notEqual(ls?.toolName, "commandExecution");
  assert.match(ls?.toolInput ?? "", /ls -la/);
  const [send] = toolStarts(projector.facts(event({ kind: "tool_call_started", callId: "cmd-2", tool: "commandExecution", input: "/bin/bash -lc \"raft message send --target '#general' <<'RAFTMSG'\nhi\nRAFTMSG\"" })));
  assert.equal(send?.toolName, "send_message");
});

test("an MCP call is named by the server and tool OAR reports", () => {
  const { projector } = setup();
  const [call] = toolStarts(projector.facts(event({ kind: "tool_call_started", callId: "mcp-1", tool: "mcpToolCall", server: "github", toolName: "create_issue", input: JSON.stringify({ title: "x" }) })));
  assert.equal(call?.toolName, "mcp_github_create_issue");
});

test("a file change is one call per changed file, and its end closes each", () => {
  const { projector } = setup();
  const changes = [{ path: "/w/a.ts", kind: { type: "update" } }, { path: "/w/b.ts", kind: { type: "add" } }];
  const starts = toolStarts(projector.facts(event({ kind: "tool_call_started", callId: "fc-1", tool: "fileChange", input: JSON.stringify(changes) }, 10)));
  assert.deepEqual(starts.map((start) => [start?.toolName, start?.callId]), [["file_change", "fc-1:0"], ["file_change", "fc-1:1"]]);
  const ends = projector.facts(event({ kind: "tool_call_ended", callId: "fc-1", result: "ok" }, 30));
  assert.deepEqual(ends.map((fact) => fact.entries[0]), [
    { kind: "status", activity: "working", detail: "Tool finished", detailKind: "tool_end", tool: { callId: "fc-1:0", ok: true, durationMs: 20 } },
    { kind: "status", activity: "working", detail: "Tool finished", detailKind: "tool_end", tool: { callId: "fc-1:1", ok: true, durationMs: 20 } },
  ]);
});

test("a file change whose start listed no files announces them from the completed item", () => {
  const { codex, projector } = setup();
  assert.deepEqual(projector.facts(event({ kind: "tool_call_started", callId: "fc-2", tool: "fileChange", input: "[]" })), []);
  codex.observe(frame("item/completed", { threadId: ROOT, item: { type: "fileChange", id: "fc-2", status: "completed", changes: [{ path: "/w/c.ts", kind: { type: "add" } }] } }));
  const facts = projector.facts(event({ kind: "tool_call_ended", callId: "fc-2", result: "ok" }));
  assert.deepEqual(facts.map((fact) => fact.detailKind), ["tool_started", "tool_end"]);
  assert.equal(facts[0]?.entries[0]?.kind === "tool_start" && facts[0].entries[0].callId, "fc-2:0");
  assert.equal((facts[1]?.entries[0] as { tool?: { callId?: string } }).tool?.callId, "fc-2:0");
  // A file change with no files at either end shows nothing, and never a bare end.
  projector.facts(event({ kind: "tool_call_started", callId: "fc-3", tool: "fileChange" }));
  codex.observe(frame("item/completed", { threadId: ROOT, item: { type: "fileChange", id: "fc-3", status: "completed" } }));
  assert.deepEqual(projector.facts(event({ kind: "tool_call_ended", callId: "fc-3" })), []);
});

test("a web search reads as web_search with its query", () => {
  const { projector } = setup();
  const [search] = toolStarts(projector.facts(event({ kind: "tool_call_started", callId: "ws-1", tool: "webSearch", input: "oar codex" })));
  assert.equal(search?.toolName, "web_search");
  assert.match(search?.toolInput ?? "", /oar codex/);
});

test("commentary stays out of the text rows; a final answer and a message with no phase are shown", () => {
  const { codex, projector } = setup();
  codex.observe(frame("item/started", { threadId: ROOT, item: { type: "agentMessage", id: "m-1", phase: "commentary", text: "" } }));
  assert.deepEqual(projector.facts(event({ kind: "text_delta", text: "Let me look.", messageId: "m-1" })), []);
  codex.observe(frame("item/started", { threadId: ROOT, item: { type: "agentMessage", id: "m-2", phase: "final_answer", text: "" } }));
  assert.equal(projector.facts(event({ kind: "text_delta", text: "Done.", messageId: "m-2" }))[0]?.entries[0]?.kind, "text");
  codex.observe(frame("item/started", { threadId: ROOT, item: { type: "agentMessage", id: "m-3", text: "" } }));
  assert.equal(projector.facts(event({ kind: "text_delta", text: "Also.", messageId: "m-3" })).length, 1);
  // A phase on the delta itself wins (the driver's order).
  codex.observe(frame("item/agentMessage/delta", { threadId: ROOT, itemId: "m-4", delta: "x", phase: "commentary" }));
  assert.deepEqual(projector.facts(event({ kind: "text_delta", text: "x", messageId: "m-4" })), []);
});

test("leading whitespace waits for the first character; a blank final answer is reported at the end", () => {
  const { codex, projector } = setup();
  codex.observe(frame("item/started", { threadId: ROOT, item: { type: "agentMessage", id: "m-1", phase: "final_answer", text: "" } }));
  assert.deepEqual(projector.facts(event({ kind: "text_delta", text: "\n ", messageId: "m-1" })), []);
  assert.deepEqual(projector.facts(event({ kind: "text_delta", text: "Hi", messageId: "m-1" }))[0]?.entries, [{ kind: "text", text: "\n Hi" }]);
  assert.equal(codex.blankFinalAnswer(), null);

  codex.observe(frame("turn/started", { threadId: ROOT, turn: { id: "t-2" } }));
  codex.observe(frame("item/started", { threadId: ROOT, item: { type: "agentMessage", id: "m-2", phase: "commentary", text: "" } }));
  projector.facts(event({ kind: "text_delta", text: "Working on it", messageId: "m-2" }));
  codex.observe(frame("item/started", { threadId: ROOT, item: { type: "agentMessage", id: "m-3", phase: "final_answer", text: "" } }));
  assert.deepEqual(projector.facts(event({ kind: "text_delta", text: "  \n", messageId: "m-3" })), []);
  assert.equal(codex.blankFinalAnswer()?.itemType, "codex_blank_final_answer");
  // Once per turn: a repeated turn end does not report it again.
  assert.equal(codex.blankFinalAnswer(), null);

  // A turn with no assistant text at all is not a blank answer.
  codex.observe(frame("turn/started", { threadId: ROOT, turn: { id: "t-3" } }));
  assert.equal(codex.blankFinalAnswer(), null);
});

test("codex warnings become diagnostics; other threads' frames and request records are ignored", () => {
  const codex = new CodexActivityReader(ROOT);
  assert.deepEqual(codex.observe(frame("configWarning", { summary: "bad key", details: "x = 1", path: "/c/config.toml" })).map((d) => [d.itemType, d.message, d.path]), [["configWarning", "bad key", "/c/config.toml"]]);
  assert.equal(codex.observe(frame("deprecationNotice", { summary: "old flag" }))[0]?.itemType, "deprecationNotice");
  assert.equal(codex.observe(frame("thread/status/changed", { threadId: ROOT, status: { type: "active", activeFlags: ["waitingOnApproval"] } }))[0]?.message, "Codex thread is waiting on approval");
  // A system error with a reason fails the turn; that reaches the host as the turn's outcome.
  assert.deepEqual(codex.observe(frame("thread/status/changed", { threadId: ROOT, status: { type: "systemError", message: "boom" } })), []);
  assert.deepEqual(codex.observe(frame("warning", { message: "child" }, "thread-child")), []);
  assert.deepEqual(codex.observe({ kind: "request", id: "r", direction: "toRuntime", sessionId: ROOT, agentPath: [], seq: ++seq, receivedAt: 0, body: { kind: "abort" } } as unknown as RawEvent), []);
  assert.deepEqual(codex.observe(frame("item/agentMessage/delta", { threadId: ROOT, itemId: "m", delta: "x" })), []);
});

test("review mode is read from its items, and never outlives its turn", () => {
  const { codex } = setup();
  assert.equal(codex.inReview, false);
  codex.observe(frame("item/started", { threadId: ROOT, item: { type: "enteredReviewMode", id: "r-1", review: "x" } }));
  assert.equal(codex.inReview, true);
  codex.observe(frame("item/completed", { threadId: ROOT, item: { type: "exitedReviewMode", id: "r-2", review: "x" } }));
  assert.equal(codex.inReview, false);
  codex.observe(frame("item/started", { threadId: ROOT, item: { type: "enteredReviewMode", id: "r-3" } }));
  codex.observe(frame("turn/completed", { threadId: ROOT, turn: { id: "t-1", status: "completed" } }));
  assert.equal(codex.inReview, false, "a lost exit item does not hold deliveries past the turn");
  // Another thread's review is not this agent's.
  codex.observe(frame("item/started", { threadId: "thread-child", item: { type: "enteredReviewMode", id: "r-4" } }, "thread-child"));
  assert.equal(codex.inReview, false);
});

test("telemetry: token usage and rate limits read as the legacy driver reads them, from the root thread only", () => {
  const codex = new CodexActivityReader(ROOT);
  const usage = {
    threadId: ROOT,
    tokenUsage: {
      total: { totalTokens: 9000, inputTokens: 8000, cachedInputTokens: 4000, outputTokens: 1000, reasoningOutputTokens: 10 },
      last: { totalTokens: 500, inputTokens: 400, cachedInputTokens: 100, outputTokens: 100 },
      modelContextWindow: 1000,
    },
  };

  assert.deepEqual(codex.telemetry(frame("thread/tokenUsage/updated", usage)), {
    kind: "telemetry",
    name: "token_usage",
    source: "codex_thread_token_usage_updated",
    usageKind: "cumulative_session",
    attrs: {
      totalTokens: 9000,
      inputTokens: 8000,
      cachedInputTokens: 4000,
      outputTokens: 1000,
      reasoningOutputTokens: 10,
      lastInputTokens: 400,
      lastCachedInputTokens: 100,
      lastOutputTokens: 100,
      modelContextWindow: 1000,
      cachedInputRatio: 0.5,
      contextUtilization: 0.5,
    },
  });
  assert.deepEqual(
    codex.telemetry(frame("account/rateLimits/updated", { rateLimits: { limitId: "codex", planType: "pro", primary: { usedPercent: 12, windowDurationMins: 300 } } })),
    {
      kind: "telemetry",
      name: "rate_limits",
      source: "codex_account_rate_limits_updated",
      attrs: { limitId: "codex", planType: "pro", usedPercent: 12, windowDurationMins: 300 },
    },
  );

  // Stamped with the turn the frame names, else the running turn (the driver's rule).
  codex.observe(frame("turn/started", { threadId: ROOT, turn: { id: "t-9" } }));
  assert.equal(codex.telemetry(frame("thread/tokenUsage/updated", usage))?.turnId, "t-9");
  assert.equal(codex.telemetry(frame("thread/tokenUsage/updated", { ...usage, turnId: "t-8" }))?.turnId, "t-8");

  assert.equal(codex.telemetry(frame("thread/tokenUsage/updated", usage, "thread-child")), null);
  assert.equal(codex.telemetry(frame("turn/started", { threadId: ROOT })), null);
  assert.equal(codex.telemetry({ ...frame("thread/tokenUsage/updated", usage), agentPath: ["sub"] } as RawEvent), null);
});

test("turnShowedText: visible text counts; commentary and whitespace don't; a new turn starts over", () => {
  const codex = new CodexActivityReader(ROOT);
  codex.observe(frame("turn/started", { threadId: ROOT, turn: { id: "t-1" } }));
  assert.equal(codex.turnShowedText, false);

  codex.observe(frame("item/started", { threadId: ROOT, item: { type: "agentMessage", id: "m-1", phase: "commentary" } }));
  codex.visibleText({ kind: "text_delta", text: "looking", messageId: "m-1" } as never);
  codex.visibleText({ kind: "text_delta", text: "   ", messageId: "m-2" } as never);
  assert.equal(codex.turnShowedText, false);

  codex.visibleText({ kind: "text_delta", text: "done", messageId: "m-3" } as never);
  assert.equal(codex.turnShowedText, true);

  codex.observe(frame("turn/started", { threadId: ROOT, turn: { id: "t-2" } }));
  assert.equal(codex.turnShowedText, false);
});

test("a sub-agent call: OAR's event with what it asked (0.94), as the legacy driver shows it", () => {
  const { projector } = setup();
  const fact = projector.facts(event({ kind: "tool_call_started", callId: "collab-1", tool: "collabAgentToolCall", input: JSON.stringify({ tool: "spawnAgent", prompt: "say hi" }) }));
  const [call] = toolStarts(fact);
  assert.equal(call?.toolName, "collab_tool_call");
  assert.match(String(call?.toolInput), /spawnAgent/);
});

test("a completed message with no deltas (OAR 0.89): shown once as visible text, unless its phase says commentary", () => {
  const codex = new CodexActivityReader(ROOT);
  codex.observe(frame("turn/started", { threadId: ROOT, turn: { id: "t-1" } }));
  codex.observe(frame("item/started", { threadId: ROOT, item: { type: "agentMessage", id: "m-1" } }));
  assert.equal(codex.visibleText({ kind: "text_delta", text: "Looking.", messageId: "m-1", phase: "commentary" } as never), "");
  assert.equal(codex.turnShowedText, false);

  codex.observe(frame("item/started", { threadId: ROOT, item: { type: "agentMessage", id: "m-2" } }));
  assert.equal(codex.visibleText({ kind: "text_delta", text: "Done.", messageId: "m-2", phase: "final_answer" } as never), "Done.");
  assert.equal(codex.turnShowedText, true);
});
