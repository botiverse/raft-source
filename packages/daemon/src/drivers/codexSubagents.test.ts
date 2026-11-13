/**
 * Codex sub-agents (the `multi_agent` tools, on by default since Codex 0.16x)
 * are recorded in the activity log under the sub-agent, as Claude's are.
 *
 * The wire shapes are trimmed from a live `codex app-server` 0.166.0 session
 * driven by a scripted Responses server (#proj-runtime:#41): the main thread
 * calls `spawn_agent`, the spawn item names the new thread in
 * `receiverThreadIds`, and the sub-agent's own `turn/*` and `item/*`
 * notifications arrive on the same connection under its thread id. No
 * `thread/started` is sent for the sub-agent's thread. The main turn may end
 * while the sub-agent is still running.
 */
import assert from "node:assert/strict";
import { CodexEventNormalizer } from "./codexEventNormalizer";
import type { ParsedEvent } from "./types";

const MAIN = "01a1a271-8bdf-7060-a9f1-16b0144b3c9b";
const CHILD = "01a1a271-8c14-7ad1-a20e-c0338af43387";
const GRANDCHILD = "01a1a271-9999-7ad1-a20e-c0338af43387";
const MAIN_TURN = "01a1a271-8bea-77e0-aa1e-0438c35b88b7";
const CHILD_TURN = "01a1a271-8c17-7f03-ab03-af73bbe52a9d";

function normalize(normalizer: CodexEventNormalizer, message: unknown): ParsedEvent[] {
  return normalizer.normalizeMessage(message as never).events;
}

function started(): CodexEventNormalizer {
  const normalizer = new CodexEventNormalizer();
  normalize(normalizer, { method: "thread/started", params: { thread: { id: MAIN } } });
  normalize(normalizer, { method: "turn/started", params: { threadId: MAIN, turn: { id: MAIN_TURN } } });
  return normalizer;
}

function spawnItem(status: "inProgress" | "completed", sender: string, receivers: string[], states: Record<string, string>, id = "call_2"): unknown {
  return {
    type: "collabAgentToolCall",
    id,
    tool: "spawnAgent",
    status,
    senderThreadId: sender,
    receiverThreadIds: receivers,
    prompt: "CHILD_TASK say hi",
    model: "gpt-5.5",
    reasoningEffort: "medium",
    agentsStates: Object.fromEntries(Object.entries(states).map(([thread, s]) => [thread, { status: s, message: null }])),
  };
}

function spawn(normalizer: CodexEventNormalizer, states: Record<string, string> = { [CHILD]: "pendingInit" }): ParsedEvent[] {
  return [
    ...normalize(normalizer, { method: "item/started", params: { threadId: MAIN, turnId: MAIN_TURN, item: spawnItem("inProgress", MAIN, [], {}) } }),
    ...normalize(normalizer, { method: "item/completed", params: { threadId: MAIN, turnId: MAIN_TURN, item: spawnItem("completed", MAIN, [CHILD], states) } }),
  ];
}

const childLineage = { parentToolUseId: "call_2", taskId: CHILD };

test("a spawn starts the sub-agent, and its finished turn ends it", () => {
  const normalizer = started();
  assert.deepEqual(spawn(normalizer), [
    { kind: "tool_call", name: "collab_tool_call", input: { tool: "spawnAgent", prompt: "CHILD_TASK say hi" }, callId: "call_2" },
    { kind: "tool_output", name: "collab_tool_call", callId: "call_2" },
    { kind: "subagent_progress", source: "codex_subagent_thread", phase: "started", ...childLineage },
  ]);
  // Its first turn does not start it a second time.
  assert.deepEqual(normalize(normalizer, { method: "turn/started", params: { threadId: CHILD, turn: { id: CHILD_TURN, rootTurnId: MAIN_TURN } } }), []);
  assert.deepEqual(
    normalize(normalizer, { method: "turn/completed", params: { threadId: CHILD, turn: { id: CHILD_TURN, status: "completed" } } }),
    [{ kind: "subagent_progress", source: "codex_subagent_thread", phase: "notification", taskStatus: "completed", ...childLineage }],
  );
});

test("the sub-agent's messages, reasoning and tools carry its lineage, with call ids of its own", () => {
  const normalizer = started();
  spawn(normalizer);
  const events = [
    ...normalize(normalizer, { method: "item/agentMessage/delta", params: { threadId: CHILD, itemId: "msg_4", delta: "child " } }),
    ...normalize(normalizer, { method: "item/completed", params: { threadId: CHILD, item: { type: "reasoning", id: "rs_1", summary: ["looking"] } } }),
    ...normalize(normalizer, { method: "item/started", params: { threadId: CHILD, item: { type: "commandExecution", id: "call_2", command: "ls" } } }),
    ...normalize(normalizer, { method: "item/completed", params: { threadId: CHILD, item: { type: "commandExecution", id: "call_2", command: "ls" } } }),
    ...normalize(normalizer, { method: "item/completed", params: { threadId: CHILD, item: { type: "fileChange", id: "fc_1", changes: [{ path: "a.ts", kind: "modify" }] } } }),
    ...normalize(normalizer, { method: "item/completed", params: { threadId: CHILD, item: { type: "agentMessage", id: "msg_4", text: "child done", phase: null } } }),
  ];
  const subagent = childLineage;
  assert.deepEqual(events, [
    { kind: "thinking", text: "looking", subagent },
    { kind: "tool_call", name: "shell", input: { command: "ls" }, callId: `${CHILD}:call_2`, subagent },
    { kind: "tool_output", name: "shell", callId: `${CHILD}:call_2`, subagent },
    { kind: "tool_call", name: "file_change", input: { path: "a.ts", kind: "modify" }, callId: `${CHILD}:fc_1:0`, subagent },
    { kind: "tool_output", name: "file_change", callId: `${CHILD}:fc_1:0`, subagent },
    { kind: "text", text: "child done", subagent },
  ]);
});

test("the sub-agent never touches the main turn", () => {
  const normalizer = started();
  spawn(normalizer);
  normalize(normalizer, { method: "turn/completed", params: { threadId: MAIN, turn: { id: MAIN_TURN, status: "completed" } } });
  assert.equal(normalizer.hasLiveTurn, false);

  // After the main turn ended: the sub-agent's error and failed turn are its
  // own, never the agent's error or a turn end.
  const late = [
    ...normalize(normalizer, { method: "error", params: { threadId: CHILD, error: { message: "boom" }, willRetry: false } }),
    ...normalize(normalizer, { method: "thread/tokenUsage/updated", params: { threadId: CHILD, tokenUsage: { total: { totalTokens: 9 } } } }),
    ...normalize(normalizer, { method: "turn/completed", params: { threadId: CHILD, turn: { id: CHILD_TURN, status: "failed", error: { message: "boom" } } } }),
  ];
  assert.deepEqual(late, [{ kind: "subagent_progress", source: "codex_subagent_thread", phase: "notification", taskStatus: "failed", ...childLineage }]);
  assert.equal(normalizer.threadId, MAIN);
  assert.equal(normalizer.hasLiveTurn, false);
});

test("a thread no spawn named is dropped, as before", () => {
  const normalizer = started();
  assert.deepEqual(normalize(normalizer, { method: "item/completed", params: { threadId: "other", item: { type: "agentMessage", id: "m", text: "hi" } } }), []);
  assert.deepEqual(normalize(normalizer, { method: "turn/completed", params: { threadId: "other", turn: { id: "t", status: "completed" } } }), []);
});

test("a sub-agent the spawn reports as already finished is not left running", () => {
  const normalizer = started();
  const events = spawn(normalizer, { [CHILD]: "completed" });
  assert.equal(events.some((event) => event.kind === "subagent_progress"), false);
  assert.deepEqual(normalize(normalizer, { method: "turn/completed", params: { threadId: CHILD, turn: { id: CHILD_TURN, status: "completed" } } }), []);
});

test("a later collab call's agent states end a sub-agent whose turn end was missed", () => {
  const normalizer = started();
  spawn(normalizer);
  const wait = { type: "collabAgentToolCall", id: "call_3", tool: "wait", status: "completed", senderThreadId: MAIN, receiverThreadIds: [CHILD], prompt: null, agentsStates: { [CHILD]: { status: "shutdown", message: null } } };
  assert.deepEqual(normalize(normalizer, { method: "item/completed", params: { threadId: MAIN, item: wait } }), [
    { kind: "tool_output", name: "collab_tool_call", callId: "call_3" },
    { kind: "subagent_progress", source: "codex_subagent_thread", phase: "notification", taskStatus: "stopped", ...childLineage },
  ]);
});

test("a follow-up turn of the sub-agent starts it again", () => {
  const normalizer = started();
  spawn(normalizer);
  normalize(normalizer, { method: "turn/completed", params: { threadId: CHILD, turn: { id: CHILD_TURN, status: "completed" } } });
  assert.deepEqual(
    normalize(normalizer, { method: "turn/started", params: { threadId: CHILD, turn: { id: "t2" } } }),
    [{ kind: "subagent_progress", source: "codex_subagent_thread", phase: "started", ...childLineage }],
  );
  assert.deepEqual(
    normalize(normalizer, { method: "turn/completed", params: { threadId: CHILD, turn: { id: "t2", status: "interrupted" } } }),
    [{ kind: "subagent_progress", source: "codex_subagent_thread", phase: "notification", taskStatus: "stopped", ...childLineage }],
  );
});

test("a sub-agent's own spawn is followed too", () => {
  const normalizer = started();
  spawn(normalizer);
  const events = normalize(normalizer, {
    method: "item/completed",
    params: { threadId: CHILD, item: spawnItem("completed", CHILD, [GRANDCHILD], { [GRANDCHILD]: "running" }, "call_9") },
  });
  assert.deepEqual(events, [
    { kind: "tool_output", name: "collab_tool_call", callId: `${CHILD}:call_9`, subagent: childLineage },
    // Its lineage is the spawn row's own (qualified) call id.
    { kind: "subagent_progress", source: "codex_subagent_thread", phase: "started", parentToolUseId: `${CHILD}:call_9`, taskId: GRANDCHILD },
  ]);
  assert.deepEqual(
    normalize(normalizer, { method: "item/completed", params: { threadId: GRANDCHILD, item: { type: "agentMessage", id: "m", text: "deep" } } }),
    [{ kind: "text", text: "deep", subagent: { parentToolUseId: `${CHILD}:call_9`, taskId: GRANDCHILD } }],
  );
});

test("a reset forgets the sub-agents", () => {
  const normalizer = started();
  spawn(normalizer);
  normalizer.reset({ threadId: MAIN });
  assert.deepEqual(normalize(normalizer, { method: "turn/completed", params: { threadId: CHILD, turn: { id: CHILD_TURN, status: "completed" } } }), []);
});

test("a sub-agent whose turn ended before the spawn named it is not left running", () => {
  const normalizer = started();
  normalize(normalizer, { method: "item/started", params: { threadId: MAIN, item: spawnItem("inProgress", MAIN, [], {}) } });
  // The sub-agent's whole turn arrives first; its thread is not named yet.
  assert.deepEqual(normalize(normalizer, { method: "turn/started", params: { threadId: CHILD, turn: { id: CHILD_TURN } } }), []);
  assert.deepEqual(normalize(normalizer, { method: "turn/completed", params: { threadId: CHILD, turn: { id: CHILD_TURN, status: "completed" } } }), []);
  // The spawn then names it with a stale state: it never starts.
  const events = normalize(normalizer, { method: "item/completed", params: { threadId: MAIN, item: spawnItem("completed", MAIN, [CHILD], { [CHILD]: "running" }) } });
  assert.equal(events.some((event) => event.kind === "subagent_progress"), false);
});

test("the sub-agent's idle thread status never ends it; its turn end says how the turn ended", () => {
  const normalizer = started();
  spawn(normalizer);
  // As captured: a new thread reports idle before its first turn, and idle
  // again just before its turn/completed.
  assert.deepEqual(normalize(normalizer, { method: "thread/status/changed", params: { threadId: CHILD, status: { type: "idle" } } }), []);
  assert.deepEqual(normalize(normalizer, { method: "turn/started", params: { threadId: CHILD, turn: { id: CHILD_TURN } } }), []);
  assert.deepEqual(normalize(normalizer, { method: "thread/status/changed", params: { threadId: CHILD, status: { type: "idle" } } }), []);
  assert.deepEqual(
    normalize(normalizer, { method: "turn/completed", params: { threadId: CHILD, turn: { id: CHILD_TURN, status: "failed" } } }),
    [{ kind: "subagent_progress", source: "codex_subagent_thread", phase: "notification", taskStatus: "failed", ...childLineage }],
  );
});

test("the sub-agent's thread entering a system error, or unloaded, ends it, never as the agent's error", () => {
  const normalizer = started();
  spawn(normalizer);
  assert.deepEqual(
    normalize(normalizer, { method: "thread/status/changed", params: { threadId: CHILD, status: { type: "systemError" } } }),
    [{ kind: "subagent_progress", source: "codex_subagent_thread", phase: "notification", taskStatus: "failed", ...childLineage }],
  );
  normalize(normalizer, { method: "turn/started", params: { threadId: CHILD, turn: { id: "t2" } } });
  assert.deepEqual(
    normalize(normalizer, { method: "thread/status/changed", params: { threadId: CHILD, status: { type: "notLoaded" } } }),
    [{ kind: "subagent_progress", source: "codex_subagent_thread", phase: "notification", taskStatus: "stopped", ...childLineage }],
  );
});

test("#proj-runtime:#41: the running turn of a sub-agent is known, to stop it, and forgotten when it ends", () => {
  const normalizer = started();
  spawn(normalizer);
  assert.equal(normalizer.runningSubagentTurn(CHILD), null, "no turn of its own yet");
  normalize(normalizer, { method: "turn/started", params: { threadId: CHILD, turn: { id: CHILD_TURN } } });
  assert.deepEqual(normalizer.runningSubagentTurn(CHILD), { threadId: CHILD, turnId: CHILD_TURN });
  assert.equal(normalizer.runningSubagentTurn("unknown"), null);
  normalize(normalizer, { method: "turn/completed", params: { threadId: CHILD, turn: { id: CHILD_TURN, status: "interrupted" } } });
  assert.equal(normalizer.runningSubagentTurn(CHILD), null);
});
