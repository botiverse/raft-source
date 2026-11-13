import assert from "node:assert/strict";
import { AGENT_SEND_INTENT_REFRESH_MS, type AgentSendIntentFrame } from "@botiverse/raft-shared";
import { AgentSendIntentTracker, sendTargetOfCompleteCall } from "./agentSendIntentTracker";

const SEND = "raft message send --target '#general' <<'EOF'\nhello\nEOF";

function harness(options: { capable?: boolean; maxLifetimeMs?: number } = {}) {
  const frames: AgentSendIntentFrame[] = [];
  let nowMs = 1_000;
  let nextTimer = 1;
  const timers = new Map<number, { fn: () => void; ms: number; dueMs: number }>();
  const tracker = new AgentSendIntentTracker({
    send: (frame) => frames.push(frame),
    now: () => nowMs,
    setInterval: ((fn: () => void, ms: number) => {
      const id = nextTimer++;
      timers.set(id, { fn, ms, dueMs: nowMs + ms });
      return id;
    }) as never,
    clearInterval: ((id: number) => {
      timers.delete(id);
    }) as never,
    ...(options.maxLifetimeMs !== undefined ? { maxLifetimeMs: options.maxLifetimeMs } : {}),
  });
  tracker.setCapable(options.capable ?? true);
  const advance = (ms: number) => {
    const until = nowMs + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.dueMs <= until).sort((a, b) => a[1].dueMs - b[1].dueMs)[0];
      if (!due) break;
      nowMs = due[1].dueMs;
      due[1].dueMs += due[1].ms;
      due[1].fn();
    }
    nowMs = until;
  };
  return { tracker, frames, advance, timers };
}

test("start once, refresh while live, end once on that call's output", () => {
  const { tracker, frames, advance, timers } = harness();
  tracker.start("agent-1", { callId: "toolu_1", target: "#general", early: true, launchId: "launch-1" });
  tracker.start("agent-1", { callId: "toolu_1", target: "#general", early: true, launchId: "launch-1" });
  // The complete tool call for the same id is not a second intent.
  tracker.noteToolCall("agent-1", { callId: "toolu_1", name: "Bash", input: { command: SEND }, launchId: "launch-1" });
  assert.deepEqual(frames, [{
    type: "agent:send_intent", agentId: "agent-1", launchId: "launch-1", callId: "toolu_1", phase: "start", target: "#general", early: true,
  }]);

  advance(AGENT_SEND_INTENT_REFRESH_MS * 2 + 1);
  assert.deepEqual(frames.map((f) => f.phase), ["start", "start", "start"]);

  tracker.noteToolOutput("agent-1", "other-call");
  assert.equal(frames.length, 3);
  tracker.noteToolOutput("agent-1", "toolu_1");
  assert.deepEqual(frames.at(-1), { type: "agent:send_intent", agentId: "agent-1", launchId: "launch-1", callId: "toolu_1", phase: "end" });
  tracker.noteToolOutput("agent-1", "toolu_1");
  tracker.endAll("agent-1");
  advance(AGENT_SEND_INTENT_REFRESH_MS * 3);
  assert.equal(frames.length, 4);
  assert.equal(timers.size, 0);
});

test("late fallback: a complete shell send without an early intent", () => {
  const { tracker, frames } = harness();
  tracker.noteToolCall("agent-1", { callId: "c1", name: "Bash", input: { command: "ls" } });
  tracker.noteToolCall("agent-1", { callId: "c2", name: "Read", input: { command: SEND } });
  assert.equal(frames.length, 0);
  tracker.noteToolCall("agent-1", { callId: "c3", name: "command_execution", input: { command: `/bin/zsh -lc "${SEND}"` } });
  assert.deepEqual(frames, [{ type: "agent:send_intent", agentId: "agent-1", callId: "c3", phase: "start", target: "#general", early: false }]);
});

test("a runtime without call ids: minted id, ended by the next tool output", () => {
  const { tracker, frames } = harness();
  tracker.noteToolCall("agent-1", { name: "shell", input: { command: SEND } });
  assert.equal(frames.length, 1);
  const callId = frames[0]!.callId;
  assert.match(callId, /^daemon-send-\d+$/);
  tracker.noteToolOutput("agent-1", undefined);
  assert.deepEqual(frames.at(-1), { type: "agent:send_intent", agentId: "agent-1", callId, phase: "end" });
});

test("turn end / exit ends every live intent of that agent only", () => {
  const { tracker, frames, timers } = harness();
  tracker.start("agent-1", { callId: "a", target: "#one", early: true });
  tracker.start("agent-1", { callId: "b", target: "dm:@sam", early: true });
  tracker.start("agent-2", { callId: "c", target: "#two", early: true });
  tracker.endAll("agent-1");
  assert.deepEqual(frames.filter((f) => f.phase === "end").map((f) => f.callId), ["a", "b"]);
  assert.equal(tracker.liveCount("agent-2"), 1);
  assert.equal(timers.size, 1);
});

test("live intents per agent are bounded", () => {
  const { tracker, frames } = harness();
  for (let i = 0; i < 6; i += 1) tracker.start("agent-1", { callId: `c${i}`, target: "#x", early: true });
  assert.equal(tracker.liveCount("agent-1"), 4);
  assert.equal(frames.length, 4);
});

test("a call that never reports output stops after the lifetime bound", () => {
  const { tracker, frames, advance } = harness({ maxLifetimeMs: AGENT_SEND_INTENT_REFRESH_MS * 3 });
  tracker.start("agent-1", { callId: "stuck", target: "#x", early: true });
  advance(AGENT_SEND_INTENT_REFRESH_MS * 10);
  assert.deepEqual(frames.map((f) => f.phase), ["start", "start", "start", "end"]);
});

test("no frames without the server capability; losing it drops intents silently", () => {
  const off = harness({ capable: false });
  off.tracker.start("agent-1", { callId: "a", target: "#x", early: true });
  off.tracker.noteToolCall("agent-1", { callId: "b", name: "Bash", input: { command: SEND } });
  off.advance(AGENT_SEND_INTENT_REFRESH_MS * 2);
  off.tracker.endAll("agent-1");
  assert.equal(off.frames.length, 0);
  assert.equal(off.timers.size, 0);

  const on = harness();
  on.tracker.start("agent-1", { callId: "a", target: "#x", early: true });
  on.tracker.setCapable(false);
  on.advance(AGENT_SEND_INTENT_REFRESH_MS * 2);
  on.tracker.endAll("agent-1");
  assert.equal(on.frames.length, 1);
  assert.equal(on.timers.size, 0);
});

test("a throwing transport does not escape", () => {
  const tracker = new AgentSendIntentTracker({ send: () => { throw new Error("socket closed"); } });
  tracker.setCapable(true);
  tracker.start("agent-1", { callId: "a", target: "#x", early: true });
  tracker.endAll("agent-1");
});

test("sendTargetOfCompleteCall reads shell sends and chat send_message tools", () => {
  assert.equal(sendTargetOfCompleteCall("Bash", { command: SEND }), "#general");
  assert.equal(sendTargetOfCompleteCall("mcp__chat__send_message", { target: "#chat" }), "#chat");
  assert.equal(sendTargetOfCompleteCall("Bash", { command: 42 }), null);
  assert.equal(sendTargetOfCompleteCall("Bash", null), null);
  assert.equal(sendTargetOfCompleteCall("WebFetch", { url: "x" }), null);
});
