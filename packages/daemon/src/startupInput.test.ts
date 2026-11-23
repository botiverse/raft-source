// The resume rungs of the start ladder with the open tasks a resumed start
// names (`agent:start` `openTasks`): an agent holding unfinished work is not
// told to stop.
import assert from "node:assert/strict";

import type { AgentConfig, AgentMessage, AgentStartOpenTasks } from "@botiverse/raft-shared";

import {
  formatResumeEmptyPrompt,
  formatResumeOpenTasksPrompt,
  formatResumeUnreadSummaryPrompt,
  projectThreadJoinContextsForRuntimeInput,
} from "./agentRuntimeInput";
import { exampleMessage, exampleUnreadSummary } from "./axExampleFixtures";
import { getDriver } from "./drivers/index";
import { planStartupInput, type StartupInputRequest } from "./startupInput";

const driver = getDriver("codex");
const runtimeConfig = { name: "agent-1", runtime: "codex", sessionId: "session-1" } as AgentConfig;
const openTasks: AgentStartOpenTasks = {
  tasks: [
    { ref: "#proj:#7", title: "Ship the resume prompt", status: "in_progress" },
    { ref: "dm:@ada:#3", title: "Draft the note", status: "todo" },
  ],
  more: 1,
};

function plan(overrides: Partial<StartupInputRequest> = {}) {
  return planStartupInput({
    driver,
    runtimeConfig,
    isResume: true,
    nativeStandingPrompt: Boolean(driver.supportsNativeStandingPrompt),
    standingPromptReachesSession: false,
    standingPromptInFirstInput: false,
    wakeMessageTransient: false,
    startingInboxMessages: [],
    projectThreadJoinContexts: (messages, render) => projectThreadJoinContextsForRuntimeInput(messages, () => undefined, render),
    ...overrides,
  });
}

test("a resume with nothing new but open tasks names them instead of saying stop", () => {
  const startup = plan({ openTasks });
  assert.equal(startup.promptSource, "resume_open_tasks");
  assert.equal(startup.prompt, formatResumeOpenTasksPrompt(openTasks, driver));
  assert.notEqual(startup.prompt, formatResumeEmptyPrompt(driver));
  assert.match(String(startup.prompt), /#proj:#7 \[in_progress\] Ship the resume prompt/);
  assert.equal(startup.openTasksShown, 2);
  assert.equal(startup.unreadSummaryShown, false);
  assert.equal(startup.startOrigin, null, "a task list is not a message the start answers");
  assert.deepEqual(startup.firstInputMessages, []);
});

test("without open tasks (an older Server, or none held) the empty resume is unchanged", () => {
  const none: Array<AgentStartOpenTasks | undefined> = [undefined, { tasks: [], more: 0 }, { tasks: [], more: 3 }];
  for (const tasks of none) {
    const startup = plan({ openTasks: tasks });
    assert.equal(startup.promptSource, "resume_empty");
    assert.equal(startup.prompt, formatResumeEmptyPrompt(driver));
    assert.equal(startup.openTasksShown, 0);
  }
});

test("the unread catch-up carries the open tasks and does not end on an unconditional stop", () => {
  const startup = plan({ unreadSummary: exampleUnreadSummary, openTasks });
  assert.equal(startup.promptSource, "resume_unread_summary");
  assert.equal(startup.prompt, formatResumeUnreadSummaryPrompt(exampleUnreadSummary, driver, openTasks));
  assert.doesNotMatch(String(startup.prompt), /then stop\./);
  assert.match(String(startup.prompt), /Open tasks assigned to you:\n- #proj:#7 \[in_progress\] Ship the resume prompt\n- dm:@ada:#3 \[todo\] Draft the note\n- …and 1 more: `raft task list --mine`/);
  assert.equal(startup.unreadSummaryShown, true);
  assert.equal(startup.openTasksShown, 2);

  const without = plan({ unreadSummary: exampleUnreadSummary });
  assert.equal(without.prompt, formatResumeUnreadSummaryPrompt(exampleUnreadSummary, driver));
  assert.match(String(without.prompt), /then stop\./);
  assert.equal(without.openTasksShown, 0);
});

test("open tasks never replace a wake message, a resume prompt, or a catch-up; fresh starts also surface open tasks and unread summary (#proj-runtime:#80)", () => {
  const wake: AgentMessage = { ...exampleMessage };
  assert.equal(plan({ openTasks, wakeMessage: wake }).promptSource, "wake_inbox_update");
  assert.equal(plan({ openTasks, resumePrompt: "caller prompt" }).promptSource, "resume_prompt");
  assert.equal(plan({ openTasks, resumeMessages: [wake] }).promptSource, "resume_catchup_inbox");
  assert.equal(plan({ openTasks, startingInboxMessages: [wake] }).promptSource, "starting_inbox_update");

  const freshTasks = plan({ openTasks, isResume: false });
  assert.equal(freshTasks.promptSource, "fresh_open_tasks");
  assert.equal(freshTasks.openTasksShown, 2);

  const freshUnread = plan({ unreadSummary: exampleUnreadSummary, isResume: false });
  assert.equal(freshUnread.promptSource, "fresh_unread_summary");
  assert.equal(freshUnread.unreadSummaryShown, true);

  const brandNew = plan({ isResume: false });
  assert.equal(brandNew.promptSource, "cold_start");
  assert.equal(brandNew.openTasksShown, 0);
});

// --- Focus (docs/contracts/agent-focus.md): focused messages present at a start ---

const focusConfig = { ...runtimeConfig, agentFocus: true } as AgentConfig;
const threadMessage = (id: string, seq: number, extra: Partial<AgentMessage> = {}): AgentMessage => ({
  ...exampleMessage,
  channel_id: "thread-1",
  channel_type: "thread",
  channel_name: "thread-aaaabbbb",
  parent_channel_name: "general",
  parent_channel_type: "channel",
  message_id: id,
  seq,
  content: `body of ${id}`,
  ...extra,
});
const plainMessage = (id: string, seq: number): AgentMessage => ({ ...exampleMessage, channel_id: "channel-2", channel_name: "random", message_id: id, seq, content: `body of ${id}` });
const focusChange = { reason: "mentioned", focused: ["#general:aaaabbbb"], unfocused: [] } as AgentMessage["focus_change"];

/** Every start shape that carries messages, as a request. */
function focusShapes(focused: (id: string, seq: number, extra?: Partial<AgentMessage>) => AgentMessage): Array<[string, Partial<StartupInputRequest>]> {
  const starting = [plainMessage("s1", 11), focused("s2", 12), plainMessage("s3", 13)];
  return [
    ["wake", { wakeMessage: focused("w1", 10, { focus_change: focusChange }) }],
    ["wake + starting inbox", { wakeMessage: focused("w1", 10), startingInboxMessages: starting }],
    ["unfocused wake + starting inbox", { wakeMessage: plainMessage("w1", 10), startingInboxMessages: starting }],
    ["starting inbox", { startingInboxMessages: starting }],
    ["resume catch-up", { resumeMessages: [focused("r1", 8, { focus_change: focusChange }), plainMessage("r2", 9)], startingInboxMessages: starting }],
  ];
}

test("Focus off: a start whose messages carry `focused` plans exactly what it plans without the tag", () => {
  const tagged = focusShapes((id, seq, extra) => threadMessage(id, seq, { focused: true, ...extra }));
  const untagged = focusShapes((id, seq, extra) => threadMessage(id, seq, { ...extra, focus_change: undefined }));
  for (const [index, [name, request]] of tagged.entries()) {
    for (const config of [runtimeConfig, { ...runtimeConfig, agentFocus: false } as AgentConfig]) {
      const off = plan({ ...request, runtimeConfig: config });
      const base = plan({ ...untagged[index]![1], runtimeConfig: config });
      assert.equal(String(off.prompt), String(base.prompt), name);
      assert.equal(off.promptSource, base.promptSource, name);
      assert.deepEqual(off.focusedStartupBodies, [], name);
      assert.deepEqual(off.startupBodyMessages.map((message) => message.message_id), base.startupBodyMessages.map((message) => message.message_id), name);
      assert.deepEqual(off.spawnAnnouncedMessages.map((message) => message.message_id), base.spawnAnnouncedMessages.map((message) => message.message_id), name);
      assert.deepEqual(off.inboxNoticeMessages.map((message) => message.message_id), base.inboxNoticeMessages.map((message) => message.message_id), name);
      assert.doesNotMatch(String(off.prompt), /Raft focused/, name);
    }
  }
  // The shapes that are a notice today stay a notice.
  assert.equal(plan({ wakeMessage: threadMessage("w1", 10, { focused: true }) }).promptSource, "wake_inbox_update");
  assert.equal(plan({ startingInboxMessages: [threadMessage("s2", 12, { focused: true })] }).promptSource, "starting_inbox_update");
});

test("Focus on, nothing focused: the plan is the same as with Focus off", () => {
  const shapes = focusShapes((id, seq, extra) => threadMessage(id, seq, { ...extra, focus_change: undefined }));
  for (const [name, request] of shapes) {
    const on = plan({ ...request, runtimeConfig: focusConfig });
    const off = plan(request);
    assert.equal(String(on.prompt), String(off.prompt), name);
    assert.equal(on.promptSource, off.promptSource, name);
    assert.deepEqual(on.focusedStartupBodies, [], name);
  }
});

test("Focus: a focused wake message is written in full, with the focus_change line, and is a start body", () => {
  const wake = threadMessage("w1", 10, { focused: true, focus_change: focusChange });
  const startup = plan({ runtimeConfig: focusConfig, wakeMessage: wake });
  const text = String(startup.prompt);
  assert.match(text, /^New message received:/);
  assert.match(text, /body of w1/);
  assert.match(text, /\[Raft focused #general:aaaabbbb because you were @mentioned there\./);
  assert.doesNotMatch(text, /count as read|marked read/i);
  assert.doesNotMatch(text, /Raft inbox notice/);
  assert.equal(startup.promptSource, "wake_thread_context");
  assert.equal(startup.wakeMessageDeliveredWithThreadContext, true);
  assert.equal(startup.wakeMessageDeliveredAsInboxUpdate, false);
  assert.deepEqual(startup.focusedStartupBodies, [wake]);
  assert.deepEqual(startup.startupBodyMessages, [wake]);
  assert.deepEqual(startup.firstInputMessages, [wake]);
  assert.deepEqual(startup.inboxNoticeMessages, []);
});

test("Focus: with a focused wake, focused messages that arrived during the start are in full and the rest is the notice, by message", () => {
  const wake = threadMessage("w1", 10, { focused: true });
  const earlier = threadMessage("s0", 9);
  const focusedStarting = threadMessage("s2", 12, { focused: true });
  const other = plainMessage("s3", 13);
  const startup = plan({ runtimeConfig: focusConfig, wakeMessage: wake, startingInboxMessages: [earlier, focusedStarting, other] });
  const text = String(startup.prompt);
  assert.match(text, /^New messages received:/);
  assert.ok(text.indexOf("body of w1") < text.indexOf("body of s2"), "delivery order");
  assert.ok(text.indexOf("body of s2") < text.indexOf("Raft inbox notice"), "the notice comes under the bodies");
  assert.deepEqual(startup.focusedStartupBodies, [wake, focusedStarting]);
  assert.deepEqual(startup.startupBodyMessages, [wake, focusedStarting]);
  // The same conversation's unfocused message (sent before it was focused) is still a notice row.
  assert.deepEqual(startup.inboxNoticeMessages, [earlier, other]);
  // And they are told by this input, so a host records them as told and does not announce them again.
  assert.deepEqual(startup.spawnAnnouncedMessages, [earlier, other]);
  assert.deepEqual(startup.firstInputMessages, [wake, earlier, focusedStarting, other]);
});

test("Focus: an unfocused wake stays a notice row while a focused message from the starting inbox is in full", () => {
  const wake = plainMessage("w1", 10);
  const focusedStarting = threadMessage("s2", 12, { focused: true });
  const startup = plan({ runtimeConfig: focusConfig, wakeMessage: wake, startingInboxMessages: [focusedStarting] });
  const text = String(startup.prompt);
  assert.match(text, /^New message received:/);
  assert.match(text, /body of s2/);
  assert.match(text, /Raft inbox notice/);
  assert.equal(startup.promptSource, "wake_inbox_update");
  assert.equal(startup.wakeMessageDeliveredAsInboxUpdate, true);
  assert.deepEqual(startup.startupBodyMessages, [focusedStarting]);
  assert.deepEqual(startup.inboxNoticeMessages, [wake]);
  assert.deepEqual(startup.spawnAnnouncedMessages, [wake]);
});

test("Focus: focused messages of a starting inbox are in full, the rest is the notice", () => {
  const first = plainMessage("s1", 11);
  const focusedStarting = threadMessage("s2", 12, { focused: true, focus_change: focusChange });
  const startup = plan({ runtimeConfig: focusConfig, startingInboxMessages: [first, focusedStarting] });
  const text = String(startup.prompt);
  assert.match(text, /^New message received:/);
  assert.match(text, /body of s2/);
  assert.match(text, /\[Raft focused #general:aaaabbbb/);
  assert.doesNotMatch(text, /msg=s1 time=/, "listed, not written in full");
  assert.equal(startup.promptSource, "starting_thread_context");
  assert.deepEqual(startup.focusedStartupBodies, [focusedStarting]);
  assert.deepEqual(startup.startupBodyMessages, [focusedStarting]);
  assert.deepEqual(startup.inboxNoticeMessages, [first]);
  assert.deepEqual(startup.spawnAnnouncedMessages, [first]);
});

test("Focus: a resume catch-up names its focused messages and prints their focus_change line; its text is otherwise the same", () => {
  const focusedCatchup = threadMessage("r1", 8, { focused: true, focus_change: focusChange });
  const other = plainMessage("r2", 9);
  const startup = plan({ runtimeConfig: focusConfig, resumeMessages: [focusedCatchup, other] });
  const off = plan({ resumeMessages: [focusedCatchup, other] });
  assert.equal(startup.promptSource, "resume_catchup_inbox");
  assert.deepEqual(startup.focusedStartupBodies, [focusedCatchup]);
  assert.deepEqual(startup.startupBodyMessages, off.startupBodyMessages);
  const line = String(startup.prompt).split("\n").find((each) => each.startsWith("[Raft focused"));
  assert.ok(line, "the focus_change line is printed");
  assert.equal(String(startup.prompt).replace(`${line}\n\n`, ""), String(off.prompt));
});

// --- Focus size limits at a start (docs/contracts/agent-focus.md, "Size limits") ---

const KB = 1024;
const sized = (id: string, seq: number, bytes: number, extra: Partial<AgentMessage> = {}): AgentMessage =>
  threadMessage(id, seq, { focused: true, content: `${id}:`.padEnd(bytes, "x"), ...extra });
const otherThread = { channel_id: "thread-2", channel_name: "thread-ccccdddd" };
const startRows = (startup: ReturnType<typeof plan>) => startup.focusedStartupRows.map((row) => [row.message.message_id, row.limit]);

test("Focus cap: a focused wake over 16 KB is planned exactly as an unfocused wake, and named as a row made by the message limit", () => {
  const wake = sized("w1", 10, 16 * KB + 1);
  const startup = plan({ runtimeConfig: focusConfig, wakeMessage: wake });
  const untagged = plan({ runtimeConfig: focusConfig, wakeMessage: { ...wake, focused: undefined } });
  assert.equal(String(startup.prompt), String(untagged.prompt));
  assert.equal(startup.promptSource, "wake_inbox_update");
  assert.deepEqual(startup.focusedStartupBodies, []);
  assert.deepEqual(startup.startupBodyMessages, []);
  assert.deepEqual(startup.spawnAnnouncedMessages, [wake]);
  assert.deepEqual(startRows(startup), [["w1", "message"]]);
  // One byte less and it is the body.
  const fits = plan({ runtimeConfig: focusConfig, wakeMessage: sized("w1", 10, 16 * KB) });
  assert.equal(fits.promptSource, "wake_thread_context");
  assert.equal(fits.focusedStartupBodies.length, 1);
  assert.deepEqual(startRows(fits), []);
});

test("Focus cap: under a focused wake, the first starting-inbox message that does not fit and the later ones of its conversation are rows; another conversation is still in full", () => {
  const wake = sized("w1", 10, 100);
  const big = sized("s1", 11, 20 * KB);
  const late = sized("s2", 12, 50);
  const other = sized("s3", 13, 50, otherThread);
  const startup = plan({ runtimeConfig: focusConfig, wakeMessage: wake, startingInboxMessages: [big, late, other] });
  assert.deepEqual(startup.focusedStartupBodies, [wake, other]);
  assert.deepEqual(startup.startupBodyMessages, [wake, other]);
  assert.deepEqual(startup.inboxNoticeMessages, [big, late]);
  assert.deepEqual(startup.spawnAnnouncedMessages, [big, late]);
  assert.deepEqual(startRows(startup), [["s1", "message"], ["s2", "message"]]);
  const text = String(startup.prompt);
  assert.match(text, /^New messages received:/);
  assert.match(text, /msg=w1 time=/);
  assert.match(text, /msg=s3 time=/);
  assert.doesNotMatch(text, /msg=s1 time=|msg=s2 time=/);
  assert.match(text, /2 messages pending your read/);
});

test("Focus cap: a starting inbox whose focused bodies pass 32 KB together shows what fits, in arrival order", () => {
  const a = sized("s1", 11, 16 * KB);
  const b = sized("s2", 12, 16 * KB, otherThread);
  const c = sized("s3", 13, 1, { channel_id: "thread-3", channel_name: "thread-eeeeffff" });
  const startup = plan({ runtimeConfig: focusConfig, startingInboxMessages: [a, b, c] });
  assert.deepEqual(startup.focusedStartupBodies, [a, b]);
  assert.deepEqual(startup.inboxNoticeMessages, [c]);
  assert.deepEqual(startRows(startup), [["s3", "write"]]);
  assert.equal(startup.promptSource, "starting_thread_context");
});

test("Focus cap: a starting inbox whose focused messages are all rows is planned exactly as an unfocused one", () => {
  const big = sized("s1", 11, 17 * KB);
  const late = sized("s2", 12, 10);
  const startup = plan({ runtimeConfig: focusConfig, startingInboxMessages: [big, late] });
  const untagged = plan({ runtimeConfig: focusConfig, startingInboxMessages: [{ ...big, focused: undefined }, { ...late, focused: undefined }] });
  assert.equal(String(startup.prompt), String(untagged.prompt));
  assert.equal(startup.promptSource, "starting_inbox_update");
  assert.deepEqual(startup.focusedStartupBodies, []);
  assert.deepEqual(startup.startupBodyMessages, []);
  assert.deepEqual(startRows(startup), [["s1", "message"], ["s2", "message"]]);
});

test("Focus cap: a catch-up message is in full anyway, so no limit applies to it and it is still named for the report", () => {
  const big = sized("r1", 8, 40 * KB);
  const startup = plan({ runtimeConfig: focusConfig, resumeMessages: [big, sized("r2", 9, 10)] });
  assert.deepEqual(startup.focusedStartupBodies.map((message) => message.message_id), ["r1", "r2"]);
  assert.deepEqual(startRows(startup), []);
  assert.match(String(startup.prompt), /msg=r1 time=/);
});

test("Focus cap: a focused wake that brings its thread context is in full whatever its size and spends no budget", () => {
  const context = { reason: "mentioned", parent_target: "#general", thread_target: "#general:aaaabbbb", suggested_read_history_target: "#general:aaaabbbb", parent_message: { message_id: "aaaabbbb-0000-0000-0000-000000000000", sender_name: "richard", sender_type: "human", content: "parent", timestamp: exampleMessage.timestamp, seq: 90 }, recent_messages: [], history_truncated: true } as AgentMessage["thread_join_context"];
  const wake = sized("w1", 10, 40 * KB, { thread_join_context: context });
  const a = sized("s1", 11, 16 * KB, otherThread);
  const b = sized("s2", 12, 16 * KB, { channel_id: "thread-3", channel_name: "thread-eeeeffff" });
  const startup = plan({ runtimeConfig: focusConfig, wakeMessage: wake, startingInboxMessages: [a, b] });
  assert.deepEqual(startup.focusedStartupBodies, [wake, a, b]);
  assert.deepEqual(startRows(startup), []);
  assert.equal(startup.promptSource, "wake_thread_context");
});
