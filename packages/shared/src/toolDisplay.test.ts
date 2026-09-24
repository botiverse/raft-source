import assert from "node:assert/strict";
import test from "node:test";
import {
  getToolActivityLabel,
  getToolLogLabel,
  normalizeToolDisplayInvocation,
  resolveToolSemantic,
  shouldHideToolStartInActivityLog,
  summarizeToolInput,
} from "./toolDisplay.js";

test("resolveToolSemantic normalizes chat prefixes and aliases", () => {
  assert.equal(resolveToolSemantic("mcp__chat__join_channel"), "join_channel");
  assert.equal(resolveToolSemantic("mcp_chat_leave_channel"), "leave_channel");
  assert.equal(resolveToolSemantic("ReadFile"), "read_file");
  assert.equal(resolveToolSemantic("command_execution"), "bash");
  assert.equal(resolveToolSemantic("unknown_tool"), null);
});

test("tool labels come from the shared metadata table", () => {
  assert.equal(getToolLogLabel("mcp__chat__send_message"), "Sending message");
  assert.equal(getToolActivityLabel("mcp_chat_list_tasks"), "Listing tasks…");
  assert.equal(getToolLogLabel("Read"), "Reading file");
  assert.equal(getToolActivityLabel("SearchWeb"), "Searching web…");
  assert.equal(getToolLogLabel("unknown_tool_name"), "unknown_tool_name");
  assert.equal(getToolActivityLabel("unknown_tool_with_long_name_here"), "Using unknown_tool_with_lo……");
});

test("activity log hides transient send_message tool rows", () => {
  assert.equal(shouldHideToolStartInActivityLog("mcp__chat__send_message"), true);
  assert.equal(shouldHideToolStartInActivityLog("SearchWeb"), false);
});

test("tool input summaries use the shared summary strategy", () => {
  assert.equal(summarizeToolInput("ReadFile", { path: "/tmp/test.ts" }), "/tmp/test.ts");
  assert.equal(summarizeToolInput("run_shell_command", { command: "ls -la" }), "ls -la");
  // Grok's shell tool is named run_terminal_command; its command must surface in Activity.
  assert.equal(summarizeToolInput("run_terminal_command", { command: "pwd" }), "pwd");
  assert.equal(
    summarizeToolInput("mcp__chat__claim_tasks", { channel: "#dev", task_numbers: [1, 2] }),
    "#dev #t1,#t2",
  );
  assert.equal(
    summarizeToolInput("mcp_chat_update_task_status", { channel: "#dev", task_number: 3 }),
    "#dev #t3",
  );
  assert.equal(summarizeToolInput("join_channel", { target: "#general" }), "#general");
  assert.equal(summarizeToolInput("send_message", { target: "#general" }), "#general");
  assert.equal(summarizeToolInput("unknown_tool", {}), "");
  assert.equal(summarizeToolInput("Read", null), "");
});

test("normalizeToolDisplayInvocation maps slock CLI bash calls back to canonical semantics", () => {
  const sendInvocation = normalizeToolDisplayInvocation("Bash", {
    command: "slock message send --target '#general' <<'EOF'\nhello world\nEOF",
  });
  assert.equal(sendInvocation.toolName, "send_message");
  assert.deepEqual(sendInvocation.input, { target: "#general" });

  const claimInvocation = normalizeToolDisplayInvocation("run_shell_command", {
    command: ".slock/slock task claim --channel '#eng' --number 1 --number 2",
  });
  assert.equal(claimInvocation.toolName, "claim_tasks");
  assert.deepEqual(claimInvocation.input, { channel: "#eng", task_numbers: [1, 2] });

  const equalsSyntaxInvocation = normalizeToolDisplayInvocation("Bash", {
    command: "'C:\\\\tmp\\\\slock.cmd' message send --target=#ops",
  });
  assert.equal(equalsSyntaxInvocation.toolName, "send_message");
  assert.deepEqual(equalsSyntaxInvocation.input, { target: "#ops" });

  const unknownInvocation = normalizeToolDisplayInvocation("Bash", {
    command: "slock auth whoami",
  });
  assert.equal(unknownInvocation.toolName, "Bash");
  assert.deepEqual(unknownInvocation.input, { command: "slock auth whoami" });

  // Shell-wrapped commands (e.g. Codex emits `/bin/zsh -lc "slock ..."`)
  const shellWrappedInvocation = normalizeToolDisplayInvocation("shell", {
    command: `/bin/zsh -lc "slock message send --target 'dm:@someone' <<'EOF'\nhello\nEOF"`,
  });
  assert.equal(shellWrappedInvocation.toolName, "send_message");
  assert.deepEqual(shellWrappedInvocation.input, { target: "dm:@someone" });

  const pipeInvocation = normalizeToolDisplayInvocation("Bash", {
    command: "printf 'hello world' | slock message send --target '#pipeline'",
  });
  assert.equal(pipeInvocation.toolName, "send_message");
  assert.deepEqual(pipeInvocation.input, { target: "#pipeline" });

  const heredocPipeInvocation = normalizeToolDisplayInvocation("Bash", {
    command: "cat <<'EOF' | slock message send --target '#pipeline-heredoc'\nhello world\nEOF",
  });
  assert.equal(heredocPipeInvocation.toolName, "send_message");
  assert.deepEqual(heredocPipeInvocation.input, { target: "#pipeline-heredoc" });

  const shellWrappedCheck = normalizeToolDisplayInvocation("shell", {
    command: `/bin/bash -c "slock message check"`,
  });
  assert.equal(shellWrappedCheck.toolName, "check_messages");

  // Non-slock shell command stays as-is
  const nonSlockShell = normalizeToolDisplayInvocation("shell", {
    command: `/bin/zsh -lc "ls -la"`,
  });
  assert.equal(nonSlockShell.toolName, "shell");
});

test("reminder tool semantics — MCP names + labels", () => {
  assert.equal(resolveToolSemantic("mcp__chat__schedule_reminder"), "schedule_reminder");
  assert.equal(resolveToolSemantic("list_reminders"), "list_reminders");
  assert.equal(resolveToolSemantic("cancel_reminder"), "cancel_reminder");

  assert.equal(getToolLogLabel("schedule_reminder"), "Scheduling reminder");
  assert.equal(getToolActivityLabel("list_reminders"), "Listing reminders…");
  assert.equal(getToolLogLabel("cancel_reminder"), "Canceling reminder");
});

test("reminder summaries render title/id hints", () => {
  assert.equal(
    summarizeToolInput("schedule_reminder", { title: "follow up on PR #982" }),
    "follow up on PR #982",
  );
  assert.equal(
    summarizeToolInput("schedule_reminder", { title: "a".repeat(50) }),
    `${"a".repeat(40)}…`,
  );
  assert.equal(summarizeToolInput("list_reminders", {}), "");
  assert.equal(
    summarizeToolInput("cancel_reminder", { reminder_id: "abcd1234-efgh-5678" }),
    "#abcd1234",
  );
});

test("slock reminder CLI commands map back to MCP reminder semantics", () => {
  const schedule = normalizeToolDisplayInvocation("Bash", {
    command: `slock reminder schedule --title 'follow up on PR #982' --delay-seconds 3600`,
  });
  assert.equal(schedule.toolName, "schedule_reminder");
  assert.deepEqual(schedule.input, { title: "follow up on PR #982" });

  const list = normalizeToolDisplayInvocation("Bash", {
    command: ".slock/slock reminder list --status scheduled,fired",
  });
  assert.equal(list.toolName, "list_reminders");
  assert.deepEqual(list.input, {});

  const cancel = normalizeToolDisplayInvocation("shell", {
    command: `/bin/zsh -lc "slock reminder cancel --id abcd1234"`,
  });
  assert.equal(cancel.toolName, "cancel_reminder");
  assert.deepEqual(cancel.input, { reminder_id: "abcd1234" });
});

test("slock channel membership CLI maps back to channel tool semantics", () => {
  const update = normalizeToolDisplayInvocation("Bash", {
    command: `slock channel update --target '#engineering' --name '#platform' --private`,
  });
  assert.equal(update.toolName, "update_channel");
  assert.deepEqual(update.input, {
    target: "#engineering",
    name: "#platform",
    description: undefined,
    visibility: "private",
  });

  const archive = normalizeToolDisplayInvocation("Bash", {
    command: `raft channel archive --target '#engineering'`,
  });
  assert.equal(archive.toolName, "archive_channel");
  assert.deepEqual(archive.input, { target: "#engineering" });

  const unarchive = normalizeToolDisplayInvocation("Bash", {
    command: `raft channel unarchive --target '#engineering'`,
  });
  assert.equal(unarchive.toolName, "unarchive_channel");
  assert.deepEqual(unarchive.input, { target: "#engineering" });

  const addMember = normalizeToolDisplayInvocation("Bash", {
    command: `slock channel add-member --target '#engineering' --user '@alice'`,
  });
  assert.equal(addMember.toolName, "add_channel_member");
  assert.deepEqual(addMember.input, { target: "#engineering", user: "@alice", agent: undefined });

  const removeMember = normalizeToolDisplayInvocation("Bash", {
    command: `slock channel remove-member --target '#engineering' --agent '@assistant'`,
  });
  assert.equal(removeMember.toolName, "remove_channel_member");
  assert.deepEqual(removeMember.input, { target: "#engineering", user: undefined, agent: "@assistant" });

  const join = normalizeToolDisplayInvocation("Bash", {
    command: `slock channel join --target '#engineering'`,
  });
  assert.equal(join.toolName, "join_channel");
  assert.deepEqual(join.input, { target: "#engineering" });

  const leave = normalizeToolDisplayInvocation("Bash", {
    command: `slock channel leave --target '#engineering'`,
  });
  assert.equal(leave.toolName, "leave_channel");
  assert.deepEqual(leave.input, { target: "#engineering" });
});
