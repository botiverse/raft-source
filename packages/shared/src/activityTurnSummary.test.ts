import assert from "node:assert/strict";
import { test } from "vitest";
import {
  ACTIVITY_TURN_LAST_TEXT_LIMIT,
  ACTIVITY_TURN_PROBLEM_LIMIT,
  ActivityTurnAccumulator,
  capActivityTurnLastText,
  classifyShellCommand,
  classifyToolCall,
  DAEMON_LOG_TURN_BOUNDARIES,
  EMPTY_WAKE_CONTINUATION_MS,
  readActivityTurnTrigger,
  readDaemonTurnSummary,
  TurnSummaryTracker,
  turnOutcomeForActivity,
  isRuntimeProgressDetailKind,
  type ActivityTurnSummary,
} from "./activityTurnSummary";
import type { TrajectoryEntry } from "./index";

test("shell commands classify by their leading program, prefixes stripped", () => {
  assert.equal(classifyShellCommand("grep -rn foo src | head"), "search");
  assert.equal(classifyShellCommand("cd /repo/packages/server && sed -n 1,40p src/a.ts"), "read_file");
  assert.equal(classifyShellCommand("export PATH=/x:$PATH; npx vitest run src/a.test.ts"), "run_checks");
  assert.equal(classifyShellCommand("NODE_OPTIONS=--max-old-space-size=6144 npx tsc --noEmit"), "run_checks");
  assert.equal(classifyShellCommand("pnpm --filter @botiverse/raft-web test settings"), "run_checks");
  assert.equal(classifyShellCommand("git push origin HEAD:refs/heads/agent/x"), "version_control");
  assert.equal(classifyShellCommand("stamp pr merge 9983 --repo botiverse/slock"), "version_control");
  assert.equal(classifyShellCommand("python3 - <<'EOF'\nprint(1)\nEOF"), "run_command");
  // Only the first line decides: a later `vitest` in a heredoc body does not.
  assert.equal(classifyShellCommand("grep -n test package.json\nnpx vitest"), "search");
});

test("tool calls classify across runtime tool names and Raft CLI commands", () => {
  assert.equal(classifyToolCall("Read", "src/a.ts"), "read_file");
  assert.equal(classifyToolCall("StrReplaceFile", "src/a.ts"), "edit_file");
  assert.equal(classifyToolCall("command_execution", "git status"), "version_control");
  assert.equal(classifyToolCall("Bash", "raft message send --target \"#proj-runtime:9b526607\" <<'RAFTMSG'"), "send_message");
  assert.equal(classifyToolCall("Bash", "raft message read --target \"#proj-runtime:9b526607\" --unread"), "read_messages");
  assert.equal(classifyToolCall("Bash", "raft task claim --channel \"#proj-runtime\" --number 17"), "raft_action");
  assert.equal(classifyToolCall("send_message", ""), "send_message");
  assert.equal(classifyToolCall("WebSearch", "oar"), "web");
  assert.equal(classifyToolCall("mcp__linear__create_issue", ""), "mcp");
  assert.equal(classifyToolCall("SomethingNew", ""), "other");
  // External hooks carry the tool input as JSON.
  assert.equal(classifyToolCall("Bash", JSON.stringify({ command: "npx vitest run", description: "Run tests" })), "run_checks");
  assert.equal(classifyToolCall("Bash", JSON.stringify({ command: "raft message send --target \"#general\" <<'M'" })), "send_message");
  assert.equal(classifyToolCall("Read", JSON.stringify({ file_path: "src/a.ts" })), "read_file");
});

const start = (toolName: string, toolInput: string, callId?: string): TrajectoryEntry => ({ kind: "tool_start", toolName, toolInput, ...(callId ? { callId } : {}) });
const end = (tool: { callId?: string; ok?: boolean; exitCode?: number; durationMs?: number }): TrajectoryEntry => ({
  kind: "status", activity: "working", detail: "Tool finished", detailKind: "tool_end", tool,
});

test("a turn folds into counts, problems and the last reply", () => {
  const acc = new ActivityTurnAccumulator(1_000, { target: "#proj-runtime:9b526607", sender: "Tenny", messageId: "07a75d55" });
  acc.addEntry(start("Bash", "raft message read --target \"#proj-runtime:9b526607\" --unread", "t1"), 1_100);
  acc.addEntry(end({ callId: "t1", ok: true }), 1_200);
  acc.addEntry(start("Bash", "grep -rn listRecentActivityLog src", "t2"), 1_300);
  acc.addEntry(start("Bash", "sed -n 1,40p src/a.ts", "t3"), 1_310);
  acc.addEntry(end({ callId: "t3", ok: true }), 1_320);
  acc.addEntry(end({ callId: "t2", ok: true }), 1_330);
  acc.addEntry(start("Bash", "npx vitest run src/routes/agents.api.test.ts", "t4"), 1_400);
  acc.addEntry(end({ callId: "t4", ok: true, exitCode: 1, durationMs: 6200 }), 7_600);
  acc.addEntry(start("Edit", "src/routes/agents.api.test.ts", "t5"), 7_700);
  acc.addEntry(end({ callId: "t5", ok: false }), 7_710);
  acc.addEntry({ kind: "thinking", text: "" }, 7_720);
  acc.noteSendHeld(7_800);
  acc.noteMessageSent("ae33b93f");
  acc.noteMessageSent("d2c98a0b");

  assert.deepEqual(acc.finish("completed", 8_000), {
    v: 1,
    startedAt: 1_000,
    endedAt: 8_000,
    outcome: "completed",
    trigger: { target: "#proj-runtime:9b526607", sender: "Tenny", messageId: "07a75d55" },
    actions: [
      { kind: "read_messages", count: 1 },
      { kind: "search", count: 1 },
      { kind: "read_file", count: 1 },
      { kind: "run_checks", count: 1 },
      { kind: "edit_file", count: 1 },
    ],
    toolCalls: 5,
    problems: [
      { kind: "run_checks", reason: "exit_nonzero", exitCode: 1, at: 7_600 },
      { kind: "edit_file", reason: "call_failed", at: 7_710 },
      { kind: "send_message", reason: "send_held", at: 7_800 },
    ],
    problemCount: 3,
    messagesSent: 2,
    lastReplyMessageId: "d2c98a0b",
  });
});

test("ends without a call id pair up in order; an unknown outcome is not a problem", () => {
  const acc = new ActivityTurnAccumulator(0);
  acc.addEntry(start("Bash", "git status"), 1);
  acc.addEntry(start("Read", "a.ts"), 2);
  acc.addEntry(end({ ok: false }), 3);
  acc.addEntry(end({}), 4);
  acc.addEntry(end({ callId: "nobody", exitCode: 0 }), 5);
  const summary = acc.finish("interrupted", 6);
  assert.deepEqual(summary.problems, [{ kind: "version_control", reason: "call_failed", at: 3 }]);
  assert.equal(summary.trigger, undefined);
  assert.equal(summary.lastReplyMessageId, undefined);
});

test("problems are capped but still counted", () => {
  const acc = new ActivityTurnAccumulator(0);
  for (let i = 0; i < ACTIVITY_TURN_PROBLEM_LIMIT + 5; i += 1) {
    acc.addEntry(start("Bash", "pnpm test", `c${i}`), i);
    acc.addEntry(end({ callId: `c${i}`, ok: true, exitCode: 1 }), i);
  }
  const summary = acc.finish("completed", 100);
  assert.equal(summary.problems.length, ACTIVITY_TURN_PROBLEM_LIMIT);
  assert.equal(summary.problemCount, ACTIVITY_TURN_PROBLEM_LIMIT + 5);
});

const summariesOf = (entries: readonly TrajectoryEntry[]): ActivityTurnSummary[] => entries.flatMap((entry) => entry.kind === "turn_summary" ? [entry.summary] : []);
const tenny = { target: "#proj-runtime:9b526607", sender: "Tenny", messageId: "m1" };

test("an empty wake is held and the work after it continues it: one turn with the wake's trigger and start", () => {
  const tracker = new TurnSummaryTracker();
  tracker.begin("a", 1_000, tenny);
  assert.deepEqual(tracker.finish("a", "completed", 2_000), [], "the empty wake is not published at its idle");
  assert.deepEqual(tracker.observe("a", [{ kind: "text", text: "looking" }], 2_500), []);
  assert.deepEqual(tracker.finish("a", "completed", 2_600), [], "another idle within the bound keeps it held");
  assert.deepEqual(tracker.observe("a", [start("Bash", "npx vitest run", "t1")], 30_000), []);
  tracker.observe("a", [end({ callId: "t1", ok: true })], 31_000);
  tracker.noteSendOutcome("a", { state: "sent", messageId: "r1" }, 32_000);
  const [summary, ...rest] = summariesOf(tracker.finish("a", "completed", 40_000));
  assert.equal(rest.length, 0);
  assert.deepEqual(summary, {
    v: 1,
    startedAt: 1_000,
    endedAt: 40_000,
    outcome: "completed",
    trigger: tenny,
    actions: [{ kind: "run_checks", count: 1 }],
    toolCalls: 1,
    problems: [],
    problemCount: 0,
    messagesSent: 1,
    lastReplyMessageId: "r1",
    lastText: "looking",
  });
});

test("a send alone also continues a held empty wake", () => {
  const tracker = new TurnSummaryTracker();
  tracker.begin("a", 1_000, tenny);
  tracker.finish("a", "completed", 2_000);
  tracker.noteSendOutcome("a", { state: "sent", messageId: "r1" }, 3_000);
  const [summary] = summariesOf(tracker.finish("a", "completed", 4_000));
  assert.equal(summary?.startedAt, 1_000);
  assert.equal(summary?.messagesSent, 1);
});

test("a real empty wake is published as it ended by the next wake, a stop, or a frame after the bound", () => {
  const nextWake = new TurnSummaryTracker();
  nextWake.begin("a", 1_000, tenny);
  nextWake.finish("a", "completed", 2_000);
  const [wake] = summariesOf(nextWake.begin("a", 500_000, { ...tenny, messageId: "m2" }));
  assert.deepEqual(wake && { startedAt: wake.startedAt, endedAt: wake.endedAt, outcome: wake.outcome, toolCalls: wake.toolCalls, trigger: wake.trigger }, {
    startedAt: 1_000, endedAt: 2_000, outcome: "completed", toolCalls: 0, trigger: tenny,
  });
  assert.deepEqual(nextWake.finish("a", "completed", 501_000), [], "the new wake is held in turn");

  const stop = new TurnSummaryTracker();
  stop.begin("a", 1_000, tenny);
  stop.finish("a", "completed", 2_000);
  const [stopped] = summariesOf(stop.finish("a", "interrupted", 5_000));
  assert.equal(stopped?.outcome, "completed", "it ended at its idle; the stop only publishes it");
  assert.equal(stopped?.endedAt, 2_000);

  const late = new TurnSummaryTracker();
  late.begin("a", 1_000, tenny);
  late.finish("a", "completed", 2_000);
  const lateAt = 2_000 + EMPTY_WAKE_CONTINUATION_MS + 1;
  const [released] = summariesOf(late.observe("a", [start("Bash", "ls", "t1")], lateAt));
  assert.equal(released?.toolCalls, 0, "work after the bound does not join it");
  const [follower] = summariesOf(late.finish("a", "completed", lateAt + 1_000));
  assert.deepEqual({ startedAt: follower?.startedAt, trigger: follower?.trigger, toolCalls: follower?.toolCalls }, { startedAt: lateAt, trigger: undefined, toolCalls: 1 });
});

test("only an empty completed turn with a trigger is held", () => {
  const noTrigger = new TurnSummaryTracker();
  noTrigger.begin("a", 1_000, undefined);
  assert.equal(summariesOf(noTrigger.finish("a", "completed", 2_000)).length, 1);

  const interrupted = new TurnSummaryTracker();
  interrupted.begin("a", 1_000, tenny);
  assert.equal(summariesOf(interrupted.finish("a", "interrupted", 2_000))[0]?.outcome, "interrupted");

  const worked = new TurnSummaryTracker();
  worked.begin("a", 1_000, tenny);
  worked.noteSendOutcome("a", { state: "held" }, 1_500);
  assert.equal(summariesOf(worked.finish("a", "completed", 2_000))[0]?.problemCount, 1);
});

test("release forgets an agent's turn and hands back only a held empty wake", () => {
  const tracker = new TurnSummaryTracker();
  tracker.begin("a", 1_000, tenny);
  tracker.finish("a", "completed", 2_000);
  assert.deepEqual(summariesOf(tracker.release("a")).map((summary) => summary.endedAt), [2_000]);
  assert.deepEqual(tracker.release("a"), []);
  tracker.begin("b", 1_000, tenny);
  tracker.observe("b", [start("Bash", "ls", "t1")], 1_500);
  assert.deepEqual(tracker.release("b"), [], "an open turn has no end to report");
  assert.deepEqual(tracker.finish("b", "completed", 3_000), [], "and is gone");
});

test("a trigger read back keeps its string fields; a malformed one is no trigger", () => {
  assert.deepEqual(readActivityTurnTrigger({ ...tenny, extra: 1 }), tenny);
  assert.equal(readActivityTurnTrigger({ target: 5 }), undefined);
  assert.equal(readActivityTurnTrigger("#general"), undefined);
  assert.equal(readActivityTurnTrigger(null), undefined);
  const received = (trigger: unknown): TrajectoryEntry => ({ kind: "status", activity: "working", detail: "Message received", detailKind: "model_request_started", trigger } as TrajectoryEntry);
  assert.deepEqual(DAEMON_LOG_TURN_BOUNDARIES.turnStart(received(tenny)), tenny);
  assert.deepEqual(DAEMON_LOG_TURN_BOUNDARIES.turnStart(received({ target: 5, channelId: "c" })), {}, "the turn still opens, without a trigger");
});

const plain: ActivityTurnSummary = {
  v: 1, startedAt: 1_000, endedAt: 2_000, outcome: "completed", actions: [], toolCalls: 0, problems: [], problemCount: 0, messagesSent: 0,
};

test("a daemon turn summary reads back as the accumulator built it: the producer and the server agree", () => {
  const acc = new ActivityTurnAccumulator(1_000, tenny);
  acc.addEntry(start("Bash", "npx vitest run a.test.ts", "t1"), 1_100);
  acc.addEntry(end({ callId: "t1", ok: true, exitCode: 1 }), 1_200);
  acc.addEntry(start("Edit", "a.ts", "t2"), 1_300);
  acc.addEntry(end({ callId: "t2", ok: false }), 1_310);
  for (let i = 0; i < ACTIVITY_TURN_PROBLEM_LIMIT + 2; i += 1) acc.noteSendHeld(1_400 + i);
  acc.noteMessageSent("reply-1");
  const built = acc.finish("failed", 2_000);
  assert.deepEqual(readDaemonTurnSummary(built), built);
  const bare = new ActivityTurnAccumulator(0).finish("interrupted", 5);
  assert.deepEqual(readDaemonTurnSummary(bare), bare);
});

test("a daemon turn summary keeps only the fields a producer owns: unknown and server-owned keys are dropped", () => {
  const forged = {
    ...plain,
    trigger: { ...tenny, channelId: "c1", display: { kind: "channel", channelName: "ceo-private" }, appEvent: { appName: "Forged", summary: "x" }, hidden: "dm", unresolved: true },
    appEvents: [{ id: "e" }],
    appEventCount: 9,
    sentMessageIds: ["forged"],
    sentMessageCount: 9,
    hiddenSentCount: 9,
    running: true,
    id: "forged-id",
    somethingNew: { nested: true },
  };
  assert.deepEqual(readDaemonTurnSummary(forged), { ...plain, trigger: { ...tenny, channelId: "c1" } });
});

test("a daemon turn summary's nested entries are rebuilt from their known shapes; bad ones are dropped", () => {
  const summary = readDaemonTurnSummary({
    ...plain,
    actions: [
      { kind: "run_command", count: 2, label: "forged" },
      { kind: "launch_missiles", count: 1 },
      { kind: "search", count: "3" },
      { kind: "search", count: 0 },
      { kind: "search", count: 1.5 },
      "read_file",
      null,
      { kind: "run_command", count: 1 },
    ],
    toolCalls: 3,
    problems: [
      { kind: "run_checks", reason: "exit_nonzero", exitCode: 1, at: 1_500, detail: "secret output" },
      { kind: "run_checks", reason: "exploded", at: 1_500 },
      { kind: "nope", reason: "call_failed", at: 1_500 },
      { kind: "edit_file", reason: "call_failed", at: "soon" },
      { kind: "edit_file", reason: "call_failed", exitCode: "1", at: 1_600 },
      { kind: "edit_file", reason: "call_failed", at: 1_700 },
    ],
    problemCount: 6,
    lastReplyMessageId: 7,
  });
  assert.deepEqual(summary, {
    ...plain,
    actions: [{ kind: "run_command", count: 3 }],
    toolCalls: 3,
    problems: [
      { kind: "run_checks", reason: "exit_nonzero", exitCode: 1, at: 1_500 },
      { kind: "edit_file", reason: "call_failed", at: 1_700 },
    ],
    problemCount: 6,
  });
  const capped = readDaemonTurnSummary({ ...plain, problems: Array.from({ length: ACTIVITY_TURN_PROBLEM_LIMIT + 3 }, (_, at) => ({ kind: "other", reason: "call_failed", at })) });
  assert.equal(capped?.problems.length, ACTIVITY_TURN_PROBLEM_LIMIT);
  assert.equal(capped?.problemCount, ACTIVITY_TURN_PROBLEM_LIMIT, "at least the listed problems are counted");
});

test("a daemon turn summary is lenient within a plausible shape and refused outside it", () => {
  assert.deepEqual(readDaemonTurnSummary({ ...plain, outcome: "exploded" }), { ...plain, outcome: "unknown" }, "a newer outcome reads as unknown");
  assert.deepEqual(
    readDaemonTurnSummary({ ...plain, actions: [{ kind: "search", count: 2 }], toolCalls: -1, problemCount: "x", messagesSent: null }),
    { ...plain, actions: [{ kind: "search", count: 2 }], toolCalls: 2 },
    "bad counts fall back to what the lists say",
  );
  assert.deepEqual(readDaemonTurnSummary({ ...plain, trigger: {} }), plain, "an empty trigger is no trigger");
  for (const bad of [
    null, "summary", [plain],
    { ...plain, v: 2 },
    { ...plain, startedAt: Number.NaN },
    { ...plain, endedAt: 500 },
    { ...plain, outcome: undefined },
    { ...plain, actions: {} },
    { ...plain, problems: undefined },
    { ...plain, trigger: { target: 5 } },
    { ...plain, trigger: "#general" },
  ]) {
    assert.equal(readDaemonTurnSummary(bad), undefined, JSON.stringify(bad));
  }
});

const text = (value: string, subagent?: boolean): TrajectoryEntry => ({ kind: "text", text: value, ...(subagent ? { subagent: { parentToolUseId: "agent-1" } } : {}) });

test("the turn's last text is its last run of output text: pieces in a row join, anything else starts a new one", () => {
  const acc = new ActivityTurnAccumulator(0);
  assert.equal(acc.finish("completed", 1).lastText, undefined, "no text, no lastText");
  acc.addEntry(text("Looking at the failing test."), 1);
  acc.addEntry(start("Bash", "npx vitest run", "t1"), 2);
  acc.addEntry(end({ callId: "t1", ok: true }), 3);
  assert.equal(acc.running(4).lastText, "Looking at the failing test.", "the running turn shows it too");
  // A runtime streams its final reply in pieces.
  acc.addEntry(text("Ran the command, replied "), 4);
  acc.addEntry(text("'done'; the #general message said no reply needed.\n"), 5);
  // Blank text, a subagent's text and thinking are not the agent's output text.
  acc.addEntry(text("  \n"), 6);
  acc.addEntry(text("subagent report", true), 7);
  acc.addEntry({ kind: "thinking", text: "should I reply?" }, 8);
  assert.equal(acc.finish("completed", 9).lastText, "Ran the command, replied 'done'; the #general message said no reply needed.");
  acc.addEntry(text("So I didn't reply."), 10);
  assert.equal(acc.finish("completed", 11).lastText, "So I didn't reply.", "thinking ended the run: the next text starts a new one");
});

test("the last text is cut to ACTIVITY_TURN_LAST_TEXT_LIMIT with an ellipsis, never inside a surrogate pair", () => {
  const acc = new ActivityTurnAccumulator(0);
  for (let i = 0; i < 30; i += 1) acc.addEntry(text("x".repeat(100)), i);
  const cut = acc.finish("completed", 31).lastText!;
  assert.equal(cut.length, ACTIVITY_TURN_LAST_TEXT_LIMIT);
  assert.ok(cut.endsWith("x…"));
  assert.equal(capActivityTurnLastText(cut), cut, "cutting again changes nothing");
  // An emoji (two code units) straddling the cut is dropped whole.
  const emoji = capActivityTurnLastText(`${"a".repeat(ACTIVITY_TURN_LAST_TEXT_LIMIT - 2)}😀tail`);
  assert.equal(emoji, `${"a".repeat(ACTIVITY_TURN_LAST_TEXT_LIMIT - 2)}…`);
  assert.equal(capActivityTurnLastText("short"), "short");
});

test("a daemon turn summary keeps a lastText string, cut again to the limit; anything else is dropped", () => {
  const acc = new ActivityTurnAccumulator(1_000, tenny);
  acc.addEntry(text("No reply needed."), 1_100);
  const built = acc.finish("completed", 2_000);
  assert.equal(built.lastText, "No reply needed.");
  assert.deepEqual(readDaemonTurnSummary(built), built, "the accumulator's output passes through unchanged");
  assert.equal(readDaemonTurnSummary({ ...plain, lastText: "y".repeat(ACTIVITY_TURN_LAST_TEXT_LIMIT + 500) })?.lastText?.length, ACTIVITY_TURN_LAST_TEXT_LIMIT);
  for (const bad of [42, null, { text: "x" }, ["x"], "", "   "]) {
    assert.deepEqual(readDaemonTurnSummary({ ...plain, lastText: bad }), plain, JSON.stringify(bad));
  }
});

test("output text alone never opens a turn", () => {
  const none = new TurnSummaryTracker();
  assert.deepEqual(none.observe("a", [text("hello")], 1_000), []);
  assert.deepEqual(none.finish("a", "completed", 2_000), [], "text alone opened no turn");
});

test("an empty wake that said why it did nothing is held with its text, and text after it does not take it up", () => {
  const held = new TurnSummaryTracker();
  held.begin("a", 1_000, tenny);
  held.observe("a", [text("The #general message said no reply needed.")], 1_500);
  assert.deepEqual(held.finish("a", "completed", 2_000), [], "still an empty wake: text is not work");
  held.observe("a", [text("Picking up a notice.")], 2_500);
  const [wake] = summariesOf(held.begin("a", 500_000, { ...tenny, messageId: "m2" }));
  assert.deepEqual(wake && { endedAt: wake.endedAt, outcome: wake.outcome, toolCalls: wake.toolCalls, lastText: wake.lastText }, {
    endedAt: 2_000, outcome: "completed", toolCalls: 0, lastText: "The #general message said no reply needed.",
  }, "published as it ended");
});

test("text after the runtime ended the turn keeps that end: the turn closes as the runtime said", () => {
  const ended = new TurnSummaryTracker();
  ended.begin("a", 1_000, tenny);
  ended.observe("a", [start("Bash", "ls", "t1")], 1_100);
  ended.noteRuntimeTurnEnd("a", "completed");
  ended.observe("a", [text("Done: listed the files.")], 1_200);
  const [closed] = summariesOf(ended.begin("a", 1_300, tenny));
  assert.deepEqual(closed && { outcome: closed.outcome, lastText: closed.lastText }, { outcome: "completed", lastText: "Done: listed the files." });
});

test("a turn the next one closes ends when the runtime ended it, not when the next one starts", () => {
  // A usage-limit retry: the turn fails at once, the daemon waits an hour, the
  // next attempt opens the next turn. The hour was not part of the first one.
  const tracker = new TurnSummaryTracker();
  tracker.begin("a", 1_000, tenny);
  tracker.noteUsageLimit("a", Date.parse("2026-11-08T07:00:00.000Z"));
  tracker.noteRuntimeTurnEnd("a", "failed", 1_900);
  const [closed] = summariesOf(tracker.begin("a", 3_601_000, tenny, "failed"));
  assert.deepEqual(closed && { startedAt: closed.startedAt, endedAt: closed.endedAt, outcome: closed.outcome, usageLimit: closed.usageLimit }, {
    startedAt: 1_000, endedAt: 1_900, outcome: "failed", usageLimit: { resetsAt: Date.parse("2026-11-08T07:00:00.000Z") },
  });
  // Work after the runtime end continues the turn: its end is no longer the runtime's.
  tracker.noteRuntimeTurnEnd("a", "completed", 3_602_000);
  tracker.observe("a", [start("Bash", "ls", "t1")], 3_603_000);
  const [next] = summariesOf(tracker.begin("a", 3_700_000, tenny));
  assert.equal(next?.endedAt, 3_700_000);
  assert.equal(next?.usageLimit, undefined);
});

test("readDaemonTurnSummary keeps a usage limit and its reset, dropping a reset that is not a time", () => {
  const base = { v: 1, startedAt: 1, endedAt: 2, outcome: "failed", actions: [], toolCalls: 0, problems: [], problemCount: 0, messagesSent: 0 };
  assert.deepEqual(readDaemonTurnSummary({ ...base, usageLimit: { resetsAt: 99 } })?.usageLimit, { resetsAt: 99 });
  assert.deepEqual(readDaemonTurnSummary({ ...base, usageLimit: { resetsAt: "soon" } })?.usageLimit, {});
  assert.equal(readDaemonTurnSummary({ ...base, usageLimit: "yes" })?.usageLimit, undefined);
  assert.equal(readDaemonTurnSummary(base)?.usageLimit, undefined);
});

test("Claude root refusal remains a failed terminal activity, never progress", () => {
  assert.equal(turnOutcomeForActivity("offline", "claude_root_privileges"), "failed");
  assert.equal(isRuntimeProgressDetailKind("claude_root_privileges"), false);
});

test("tokens: kept field by field from their known shapes, and dropped when nothing readable is left", () => {
  const base = { v: 1, startedAt: 1, endedAt: 2, outcome: "completed", actions: [], problems: [] };
  const read = readDaemonTurnSummary({
    ...base,
    tokens: { input: 10, cacheRead: 90, cacheWrite: -1, output: 1.5, reasoningOutput: 3, model: `  ${"m".repeat(130)}  `, contextUsed: 100, contextWindow: "400000", prompt: "secret" },
  });
  assert.deepEqual(read?.tokens, { input: 10, cacheRead: 90, reasoningOutput: 3, contextUsed: 100, model: "m".repeat(120) });
  assert.equal(readDaemonTurnSummary({ ...base, tokens: { input: -1, model: " " } })?.tokens, undefined);
  assert.equal("tokens" in (readDaemonTurnSummary({ ...base }) ?? {}), false);
});

test("tokens: a turn's runtime turns add their counts; model and context take the latest; no tokens, no field", () => {
  const tracker = new TurnSummaryTracker();
  tracker.begin("a", 1_000, tenny);
  tracker.observe("a", [start("Bash", "ls", "t1")], 1_100);
  tracker.noteTokens("a", { input: 10, cacheRead: 100, output: 5, model: "m1", contextUsed: 110 });
  tracker.noteTokens("a", { input: 2, output: 1, model: "m2", contextUsed: 230 });
  const [summary] = summariesOf(tracker.finish("a", "completed", 2_000));
  assert.deepEqual(summary?.tokens, { input: 12, cacheRead: 100, output: 6, model: "m2", contextUsed: 230 });

  const quiet = new TurnSummaryTracker();
  quiet.begin("b", 1_000, tenny);
  quiet.observe("b", [start("Bash", "ls", "t1")], 1_100);
  quiet.noteTokens("b", {});
  const [noTokens] = summariesOf(quiet.finish("b", "completed", 2_000));
  assert.equal(noTokens && "tokens" in noTokens, false);
});
