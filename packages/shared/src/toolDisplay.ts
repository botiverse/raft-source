import { formatDmPeerRef, isDmPeerKind, parseDmPeerRef } from "./dmPeerRef";

export type ToolSemantic =
  | "send_message"
  | "check_messages"
  | "wait_for_message"
  | "receive_message"
  | "read_history"
  | "search_messages"
  | "list_server"
  | "list_tasks"
  | "create_tasks"
  | "claim_tasks"
  | "unclaim_task"
  | "update_task_status"
  | "add_channel_member"
  | "join_channel"
  | "leave_channel"
  | "upload_file"
  | "view_file"
  | "read_file"
  | "write_file"
  | "edit_file"
  | "bash"
  | "glob"
  | "grep"
  | "web_fetch"
  | "web_search"
  | "todo_write"
  | "schedule_reminder"
  | "list_reminders"
  | "cancel_reminder"
  | "collab_tool_call"
  | "spawn_subagent";

type ToolSummaryKind =
  | "none"
  | "subagent_description"
  | "collab_task"
  | "file_path"
  | "command"
  | "pattern"
  | "query"
  | "url"
  | "message_target"
  | "history_target"
  | "channel"
  | "claim_tasks"
  | "task_ref"
  | "target"
  | "reminder_title"
  | "reminder_id";

interface ToolDisplayMetadata {
  logLabel: string;
  activityLabel: string;
  summaryKind: ToolSummaryKind;
}

const TOOL_DISPLAY_METADATA: Record<ToolSemantic, ToolDisplayMetadata> = {
  send_message: { logLabel: "Sending message", activityLabel: "Sending message…", summaryKind: "message_target" },
  check_messages: { logLabel: "Checking messages", activityLabel: "Checking messages…", summaryKind: "none" },
  wait_for_message: { logLabel: "Waiting for messages", activityLabel: "Waiting for messages…", summaryKind: "none" },
  receive_message: { logLabel: "Checking messages", activityLabel: "Checking messages…", summaryKind: "none" },
  read_history: { logLabel: "Reading history", activityLabel: "Reading history…", summaryKind: "history_target" },
  search_messages: { logLabel: "Searching messages", activityLabel: "Searching messages…", summaryKind: "query" },
  list_server: { logLabel: "Viewing server info", activityLabel: "Viewing server info…", summaryKind: "none" },
  list_tasks: { logLabel: "Listing tasks", activityLabel: "Listing tasks…", summaryKind: "channel" },
  create_tasks: { logLabel: "Creating tasks", activityLabel: "Creating tasks…", summaryKind: "channel" },
  claim_tasks: { logLabel: "Claiming tasks", activityLabel: "Claiming tasks…", summaryKind: "claim_tasks" },
  unclaim_task: { logLabel: "Unclaiming task", activityLabel: "Unclaiming task…", summaryKind: "task_ref" },
  update_task_status: { logLabel: "Updating task status", activityLabel: "Updating task status…", summaryKind: "task_ref" },
  add_channel_member: { logLabel: "Adding channel member", activityLabel: "Adding channel member…", summaryKind: "target" },
  join_channel: { logLabel: "Joining channel", activityLabel: "Joining channel…", summaryKind: "target" },
  leave_channel: { logLabel: "Leaving channel", activityLabel: "Leaving channel…", summaryKind: "target" },
  upload_file: { logLabel: "Uploading file", activityLabel: "Uploading file…", summaryKind: "file_path" },
  view_file: { logLabel: "Viewing file", activityLabel: "Viewing file…", summaryKind: "none" },
  read_file: { logLabel: "Reading file", activityLabel: "Reading file…", summaryKind: "file_path" },
  write_file: { logLabel: "Writing file", activityLabel: "Writing file…", summaryKind: "file_path" },
  edit_file: { logLabel: "Editing file", activityLabel: "Editing file…", summaryKind: "file_path" },
  bash: { logLabel: "Running command", activityLabel: "Running command…", summaryKind: "command" },
  glob: { logLabel: "Searching files", activityLabel: "Searching files…", summaryKind: "pattern" },
  grep: { logLabel: "Searching code", activityLabel: "Searching code…", summaryKind: "pattern" },
  web_fetch: { logLabel: "Fetching web", activityLabel: "Fetching web…", summaryKind: "url" },
  web_search: { logLabel: "Searching web", activityLabel: "Searching web…", summaryKind: "query" },
  todo_write: { logLabel: "Updating tasks", activityLabel: "Updating tasks…", summaryKind: "none" },
  schedule_reminder: { logLabel: "Scheduling reminder", activityLabel: "Scheduling reminder…", summaryKind: "reminder_title" },
  list_reminders: { logLabel: "Listing reminders", activityLabel: "Listing reminders…", summaryKind: "none" },
  cancel_reminder: { logLabel: "Canceling reminder", activityLabel: "Canceling reminder…", summaryKind: "reminder_id" },
  collab_tool_call: { logLabel: "Collaborating", activityLabel: "Collaborating…", summaryKind: "collab_task" },
  spawn_subagent: { logLabel: "Starting sub-agent", activityLabel: "Starting sub-agent…", summaryKind: "subagent_description" },
};

const KNOWN_TOOL_ALIASES = {
  send_message: "send_message",
  check_messages: "check_messages",
  wait_for_message: "wait_for_message",
  receive_message: "receive_message",
  read_history: "read_history",
  search_messages: "search_messages",
  list_server: "list_server",
  list_tasks: "list_tasks",
  create_tasks: "create_tasks",
  claim_tasks: "claim_tasks",
  unclaim_task: "unclaim_task",
  update_task_status: "update_task_status",
  add_channel_member: "add_channel_member",
  join_channel: "join_channel",
  leave_channel: "leave_channel",
  upload_file: "upload_file",
  view_file: "view_file",
  Read: "read_file",
  read_file: "read_file",
  ReadFile: "read_file",
  file_read: "read_file",
  Write: "write_file",
  write_file: "write_file",
  WriteFile: "write_file",
  file_write: "write_file",
  Edit: "edit_file",
  edit_file: "edit_file",
  EditFile: "edit_file",
  file_change: "edit_file",
  StrReplaceFile: "edit_file",
  Bash: "bash",
  bash: "bash",
  shell: "bash",
  Shell: "bash",
  command_execution: "bash",
  run_shell_command: "bash",
  run_terminal_command: "bash",
  Glob: "glob",
  glob: "glob",
  search_files: "glob",
  Grep: "grep",
  grep: "grep",
  WebFetch: "web_fetch",
  web_fetch: "web_fetch",
  fetch_url: "web_fetch",
  FetchURL: "web_fetch",
  WebSearch: "web_search",
  web_search: "web_search",
  SearchWeb: "web_search",
  TodoWrite: "todo_write",
  SetTodoList: "todo_write",
  schedule_reminder: "schedule_reminder",
  list_reminders: "list_reminders",
  cancel_reminder: "cancel_reminder",
  collab_tool_call: "collab_tool_call",
  // Claude Code's sub-agent tool (named Task before Agent).
  Agent: "spawn_subagent",
  Task: "spawn_subagent",
} as const satisfies Record<string, ToolSemantic>;

const MCP_CHAT_NAMESPACE_PREFIXES = ["mcp__chat__", "mcp_chat_"] as const;

function normalizeToolLookupName(toolName: string): string {
  for (const prefix of MCP_CHAT_NAMESPACE_PREFIXES) {
    if (toolName.startsWith(prefix)) {
      return toolName.slice(prefix.length);
    }
  }
  return toolName;
}

function stripToolNamespace(toolName: string): string {
  const normalized = normalizeToolLookupName(toolName);
  return normalized.replace(/^mcp__\w+__/, "");
}

function truncateLabel(text: string, max = 20): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function formatTaskNumbers(value: unknown): string {
  if (Array.isArray(value)) return value.map((taskNumber) => `#t${taskNumber}`).join(",");
  if (value == null || value === "") return "";
  return `#t${value}`;
}

function asObject(input: unknown): Record<string, any> | null {
  return input && typeof input === "object" ? (input as Record<string, any>) : null;
}

export interface ToolDisplayInvocation {
  toolName: string;
  input: unknown;
}

export function resolveToolSemantic(toolName: string): ToolSemantic | null {
  const normalized = normalizeToolLookupName(toolName);
  return KNOWN_TOOL_ALIASES[normalized as keyof typeof KNOWN_TOOL_ALIASES] ?? null;
}

function tokenizeShellCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const ch of command) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }

    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === "\\") {
        escaping = true;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (ch === "\\") {
      escaping = true;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (escaping || quote) return null;
  if (current) tokens.push(current);
  return tokens;
}

function isEnvAssignmentToken(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

function isRaftExecutableToken(token: string): boolean {
  // The wrapper may appear as a Unix-style path (".slock/slock") or a Windows
  // path (".slock\\slock.cmd"). Strip both separator conventions without pulling
  // in node:path so this module stays browser-safe for @botiverse/raft-web.
  const lastSep = Math.max(token.lastIndexOf("/"), token.lastIndexOf("\\"));
  const base = (lastSep >= 0 ? token.slice(lastSep + 1) : token).toLowerCase();
  return base === "slock" || base === "slock.cmd" || base === "raft" || base === "raft.cmd";
}

function isShellExecutableToken(token: string): boolean {
  const lastSep = Math.max(token.lastIndexOf("/"), token.lastIndexOf("\\"));
  const base = (lastSep >= 0 ? token.slice(lastSep + 1) : token).toLowerCase();
  return base === "bash" || base === "zsh" || base === "sh";
}

function findRaftExecutableIndex(tokens: string[]): number {
  const commandStartIndexes = [0];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === "|" || tokens[i] === "&&" || tokens[i] === "||" || tokens[i] === ";") {
      commandStartIndexes.push(i + 1);
    }
  }

  for (const start of commandStartIndexes) {
    let executableIndex = start;
    while (executableIndex < tokens.length && isEnvAssignmentToken(tokens[executableIndex]!)) {
      executableIndex += 1;
    }
    if (executableIndex < tokens.length && isRaftExecutableToken(tokens[executableIndex]!)) {
      return executableIndex;
    }
  }

  return -1;
}

/**
 * Unwrap shell wrappers like `/bin/zsh -lc "actual command"`.
 * Looks for a flag ending with `c` (e.g. `-c`, `-lc`) and returns the next token
 * which is the actual command payload.
 */
function unwrapShellPayload(tokens: string[], executableIndex: number): string | null {
  if (!isShellExecutableToken(tokens[executableIndex]!)) return null;

  for (let i = executableIndex + 1; i < tokens.length; i++) {
    const arg = tokens[i]!;
    if (arg.startsWith("-") && arg.endsWith("c")) {
      return i + 1 < tokens.length ? tokens[i + 1]! : null;
    }
    if (!arg.startsWith("-")) break;
  }
  return null;
}

function readOptionValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === flag && i + 1 < args.length) {
      values.push(args[i + 1]!);
      i += 1;
      continue;
    }

    if (arg.startsWith(`${flag}=`)) {
      values.push(arg.slice(flag.length + 1));
    }
  }
  return values;
}

function readOptionValue(args: string[], flag: string): string | undefined {
  return readOptionValues(args, flag).at(-1);
}

function parsePositiveIntegers(args: string[], flag: string): number[] {
  return readOptionValues(args, flag)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && Number.isInteger(value) && value > 0);
}

function resolveRaftCliInvocation(toolName: string, input: unknown): ToolDisplayInvocation | null {
  if (resolveToolSemantic(toolName) !== "bash") return null;

  const value = asObject(input);
  if (!value || typeof value.command !== "string") return null;

  const tokens = tokenizeShellCommand(value.command);
  if (!tokens || tokens.length === 0) return null;

  const firstExecutableIndex = (() => {
    let index = 0;
    while (index < tokens.length && isEnvAssignmentToken(tokens[index]!)) index += 1;
    return index;
  })();
  if (firstExecutableIndex >= tokens.length) return null;

  // Handle shell wrappers like `/bin/zsh -lc "slock message send ..."`.
  // Some runtimes (e.g. Codex) emit the full shell invocation as the command.
  if (isShellExecutableToken(tokens[firstExecutableIndex]!)) {
    const innerCommand = unwrapShellPayload(tokens, firstExecutableIndex);
    if (innerCommand) {
      return resolveRaftCliInvocation(toolName, { command: innerCommand });
    }
  }

  const executableIndex = findRaftExecutableIndex(tokens);
  if (executableIndex < 0) return null;

  const cliArgs = tokens.slice(executableIndex + 1);
  const [resource, action, ...rest] = cliArgs;
  if (!resource || !action) return null;

  switch (`${resource} ${action}`) {
    case "message send":
      return { toolName: "send_message", input: { target: readOptionValue(rest, "--target") } };
    case "message check":
      return { toolName: "check_messages", input: {} };
    case "message read":
      return { toolName: "read_history", input: { channel: readOptionValue(rest, "--channel") } };
    case "message search":
      return { toolName: "search_messages", input: { query: readOptionValue(rest, "--query") } };
    case "server info":
      return { toolName: "list_server", input: {} };
    case "server update":
      return {
        toolName: "update_server",
        input: {
          name: readOptionValue(rest, "--name"),
          avatar_file: readOptionValue(rest, "--avatar-file"),
        },
      };
    case "channel members":
      return { toolName: "list_channel_members", input: { channel: rest[0] } };
    case "channel update":
      return {
        toolName: "update_channel",
        input: {
          target: readOptionValue(rest, "--target"),
          name: readOptionValue(rest, "--name"),
          description: readOptionValue(rest, "--description"),
          visibility: rest.includes("--private") ? "private" : rest.includes("--public") ? "public" : undefined,
        },
      };
    case "channel archive":
      return {
        toolName: "archive_channel",
        input: { target: readOptionValue(rest, "--target") },
      };
    case "channel unarchive":
      return {
        toolName: "unarchive_channel",
        input: { target: readOptionValue(rest, "--target") },
      };
    case "channel add-member":
      return {
        toolName: "add_channel_member",
        input: {
          target: readOptionValue(rest, "--target"),
          user: readOptionValue(rest, "--user"),
          agent: readOptionValue(rest, "--agent"),
        },
      };
    case "channel remove-member":
      return {
        toolName: "remove_channel_member",
        input: {
          target: readOptionValue(rest, "--target"),
          user: readOptionValue(rest, "--user"),
          agent: readOptionValue(rest, "--agent"),
        },
      };
    case "channel join":
      return { toolName: "join_channel", input: { target: readOptionValue(rest, "--target") } };
    case "channel leave":
      return { toolName: "leave_channel", input: { target: readOptionValue(rest, "--target") } };
    case "task list":
      return { toolName: "list_tasks", input: { channel: readOptionValue(rest, "--channel") } };
    case "task create":
      return { toolName: "create_tasks", input: { channel: readOptionValue(rest, "--channel") } };
    case "task claim":
      return {
        toolName: "claim_tasks",
        input: {
          channel: readOptionValue(rest, "--channel"),
          task_numbers: parsePositiveIntegers(rest, "--number"),
        },
      };
    case "task unclaim":
      return {
        toolName: "unclaim_task",
        input: {
          channel: readOptionValue(rest, "--channel"),
          task_number: parsePositiveIntegers(rest, "--number")[0],
        },
      };
    case "task update":
      return {
        toolName: "update_task_status",
        input: {
          channel: readOptionValue(rest, "--channel"),
          task_number: parsePositiveIntegers(rest, "--number")[0],
        },
      };
    case "attachment upload":
      return { toolName: "upload_file", input: { path: readOptionValue(rest, "--path") } };
    case "attachment view":
      return { toolName: "view_file", input: {} };
    case "reminder schedule":
      return { toolName: "schedule_reminder", input: { title: readOptionValue(rest, "--title") } };
    case "reminder list":
      return { toolName: "list_reminders", input: {} };
    case "reminder cancel":
      return { toolName: "cancel_reminder", input: { reminder_id: readOptionValue(rest, "--id") } };
    default:
      return null;
  }
}

export function normalizeToolDisplayInvocation(toolName: string, input: unknown): ToolDisplayInvocation {
  return resolveRaftCliInvocation(toolName, input) ?? { toolName, input };
}

export function getToolLogLabel(toolName: string): string {
  const semantic = resolveToolSemantic(toolName);
  if (semantic) return TOOL_DISPLAY_METADATA[semantic].logLabel;
  return stripToolNamespace(toolName);
}

export function getToolActivityLabel(toolName: string): string {
  const semantic = resolveToolSemantic(toolName);
  if (semantic) return TOOL_DISPLAY_METADATA[semantic].activityLabel;
  return `Using ${truncateLabel(stripToolNamespace(toolName))}…`;
}

export function shouldHideToolStartInActivityLog(toolName: string): boolean {
  // `send_message` is a transient operation whose human-visible value is in the
  // resulting message or send outcome, not in a durable "Sending message" row.
  return resolveToolSemantic(toolName) === "send_message";
}

export function summarizeToolInput(toolName: string, input: unknown): string {
  const semantic = resolveToolSemantic(toolName);
  const value = asObject(input);
  if (!semantic || !value) return "";

  switch (TOOL_DISPLAY_METADATA[semantic].summaryKind) {
    case "none":
      return "";
    case "file_path":
      return value.file_path || value.path || "";
    case "command": {
      const command = value.command || "";
      return typeof command === "string" && command.length > 100 ? `${command.slice(0, 100)}…` : command;
    }
    case "pattern":
      return value.pattern || value.query || "";
    case "query":
      return value.query || "";
    case "url":
      return value.url || "";
    case "message_target":
      return value.target || value.channel || (value.dm_to ? `DM:@${value.dm_to}` : "");
    case "history_target":
      return value.target || value.channel || "";
    case "channel":
      return value.channel || "";
    case "claim_tasks": {
      const tasks = formatTaskNumbers(value.task_numbers);
      return value.channel && tasks ? `${value.channel} ${tasks}` : (value.channel || "");
    }
    case "task_ref":
      return value.channel && value.task_number != null ? `${value.channel} #t${value.task_number}` : "";
    case "target":
      return value.target || "";
    case "reminder_title": {
      const title = value.title;
      return typeof title === "string" ? truncateLabel(title, 40) : "";
    }
    case "reminder_id": {
      const id = value.reminder_id;
      return typeof id === "string" ? `#${id.slice(0, 8)}` : "";
    }
    case "subagent_description":
      return summarizeSubagentDescription(value);
    case "collab_task":
      return summarizeCollabTask(value);
  }
}

function cutTask(task: string): string {
  return task.length > 100 ? `${task.slice(0, 100)}…` : task;
}

/**
 * What a Claude sub-agent was asked, as the Sub-agents view titles it: the
 * Agent call's short `description` only, never the prompt. Without one the
 * view shows the sub-agent's type.
 */
function summarizeSubagentDescription(value: Record<string, unknown>): string {
  return typeof value.description === "string" ? cutTask(value.description.trim()) : "";
}

/**
 * A Codex collab call (spawnAgent, wait, ...) has only a prompt: its
 * operation and the prompt's first line, cut like a command.
 */
function summarizeCollabTask(value: Record<string, unknown>): string {
  const prompt = typeof value.prompt === "string" ? cutTask((value.prompt.trim().split("\n", 1)[0] ?? "").trim()) : "";
  const operation = typeof value.tool === "string" ? value.tool : "";
  return operation && prompt ? `${operation}: ${prompt}` : operation || prompt;
}

// ── Agent typing line: where is this shell command about to post? ──────────
//
// `findRaftSendTarget` reads the `--target` of the first
// `raft message send` (or `slock message send`) in a shell command. With
// `partial: true` the command is still being generated (streamed tool-call
// arguments): an unclosed quote or heredoc after the target is fine, but the
// target itself is returned only once its token is complete, never a
// half-typed prefix. It is a display hint (agentTyping.ts), never an
// authorization: the server resolves and checks the target.

interface SendTargetShellWord {
  kind: "word";
  value: string;
  /** Followed by a delimiter (or, with `partial`, ended by a closing quote at the end of input). */
  complete: boolean;
}

type SendTargetShellToken =
  | SendTargetShellWord
  /** A control operator or newline: ends a simple command. */
  | { kind: "op" }
  /** A redirection (`<`, `>`, `2>&1`, `<<EOF`, `<<<`): consumes the next word, if any. */
  | { kind: "redir"; consumesWord: boolean };

interface PendingHeredoc {
  delimiter: string;
  stripTabs: boolean;
}

const SEND_TARGET_VALUE_OPTIONS = new Set([
  "--target",
  "--channel",
  "--peer-kind",
  "--expected-draft-key",
  "--content",
  "--attachment-id",
  "--mention",
]);

/**
 * A small POSIX-shell lexer, enough to find `raft message send --target X` in
 * a command (complete or still streaming). Words keep quote removal; heredoc
 * bodies are skipped; `#` at a word start comments to the end of the line.
 */
function lexShellForSendTarget(command: string, partial: boolean): SendTargetShellToken[] {
  const tokens: SendTargetShellToken[] = [];
  const pendingHeredocs: PendingHeredoc[] = [];
  let word: string | null = null;
  let endedByQuote = false;
  let i = 0;
  const n = command.length;

  const finishWord = () => {
    if (word !== null) tokens.push({ kind: "word", value: word, complete: true });
    word = null;
    endedByQuote = false;
  };

  /** Reads one word starting at `i` (quotes removed); used for heredoc delimiters. */
  const readRawWord = (): { value: string; quoted: boolean } | null => {
    while (i < n && (command[i] === " " || command[i] === "\t")) i += 1;
    let value = "";
    let quoted = false;
    let read = false;
    while (i < n) {
      const ch = command[i]!;
      if (ch === "'" || ch === '"') {
        const close = command.indexOf(ch, i + 1);
        if (close < 0) return null;
        value += command.slice(i + 1, close);
        quoted = true;
        read = true;
        i = close + 1;
        continue;
      }
      if (ch === "\\" && i + 1 < n) {
        value += command[i + 1];
        quoted = true;
        read = true;
        i += 2;
        continue;
      }
      if (/\s/.test(ch) || ch === ";" || ch === "|" || ch === "&" || ch === "<" || ch === ">" || ch === "(" || ch === ")") break;
      value += ch;
      read = true;
      i += 1;
    }
    return read ? { value, quoted } : null;
  };

  /** After a newline: skip the bodies of the heredocs opened on that line. Returns false if input ran out. */
  const skipHeredocBodies = (): boolean => {
    while (pendingHeredocs.length > 0) {
      const heredoc = pendingHeredocs.shift()!;
      for (;;) {
        if (i >= n) return false;
        const eol = command.indexOf("\n", i);
        const lineEnd = eol < 0 ? n : eol;
        let line = command.slice(i, lineEnd);
        if (heredoc.stripTabs) line = line.replace(/^\t+/, "");
        // An unterminated last line of a streaming command may still grow.
        if (eol < 0 && partial) return false;
        i = eol < 0 ? n : eol + 1;
        if (line === heredoc.delimiter) break;
        if (eol < 0) return false;
      }
    }
    return true;
  };

  while (i < n) {
    const ch = command[i]!;

    if (ch === "'" || ch === '"') {
      word ??= "";
      endedByQuote = false;
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const c = command[j]!;
        if (c === ch) {
          closed = true;
          break;
        }
        if (ch === '"' && c === "\\" && j + 1 < n) {
          const next = command[j + 1]!;
          if (next === "\n") {
            j += 2;
            continue;
          }
          word += next === '"' || next === "\\" || next === "$" || next === "`" ? next : `\\${next}`;
          j += 2;
          continue;
        }
        if (ch === '"' && c === "\\") break; // trailing backslash: unterminated
        word += c;
        j += 1;
      }
      if (!closed) {
        tokens.push({ kind: "word", value: word, complete: false });
        return tokens;
      }
      i = j + 1;
      endedByQuote = true;
      continue;
    }

    if (ch === "\\") {
      if (i + 1 >= n) {
        tokens.push({ kind: "word", value: word ?? "", complete: false });
        return tokens;
      }
      if (command[i + 1] === "\n") {
        i += 2;
        continue;
      }
      word = (word ?? "") + command[i + 1];
      endedByQuote = false;
      i += 2;
      continue;
    }

    if (ch === "\n") {
      finishWord();
      tokens.push({ kind: "op" });
      i += 1;
      if (!skipHeredocBodies()) return tokens;
      continue;
    }

    if (ch === " " || ch === "\t" || ch === "\r") {
      finishWord();
      i += 1;
      continue;
    }

    if (ch === "#" && word === null) {
      const eol = command.indexOf("\n", i);
      if (eol < 0) return tokens;
      i = eol;
      continue;
    }

    if (ch === "|" || ch === ";" || ch === "(" || ch === ")") {
      finishWord();
      tokens.push({ kind: "op" });
      i += command[i + 1] === ch || (ch === "|" && command[i + 1] === "&") ? 2 : 1;
      continue;
    }

    if (ch === "&") {
      if (command[i + 1] === ">") {
        // `&>file` / `&>>file`
        finishWord();
        i += command[i + 2] === ">" ? 3 : 2;
        tokens.push({ kind: "redir", consumesWord: true });
        continue;
      }
      finishWord();
      tokens.push({ kind: "op" });
      i += command[i + 1] === "&" ? 2 : 1;
      continue;
    }

    if (ch === "<" || ch === ">") {
      // A word of digits right before is the redirected fd (`2>&1`).
      if (word !== null && /^\d+$/.test(word) && !endedByQuote) word = null;
      finishWord();
      if (ch === "<" && command.startsWith("<<<", i)) {
        i += 3;
        tokens.push({ kind: "redir", consumesWord: true });
        continue;
      }
      if (ch === "<" && command[i + 1] === "<") {
        const stripTabs = command[i + 2] === "-";
        i += stripTabs ? 3 : 2;
        const delimiter = readRawWord();
        if (!delimiter) {
          // The delimiter is still being typed (or missing).
          return tokens;
        }
        pendingHeredocs.push({ delimiter: delimiter.value, stripTabs });
        tokens.push({ kind: "redir", consumesWord: false });
        continue;
      }
      i += 1;
      if (command[i] === ">" || command[i] === "&" || command[i] === "|") i += 1;
      tokens.push({ kind: "redir", consumesWord: true });
      continue;
    }

    word = (word ?? "") + ch;
    endedByQuote = false;
    i += 1;
  }

  if (word !== null) {
    tokens.push({ kind: "word", value: word, complete: !partial || endedByQuote });
  }
  return tokens;
}

type SendTargetSearch =
  | { status: "found"; target: string }
  /** A `message send` was found but its target is not complete yet (partial input only). */
  | { status: "pending" }
  | { status: "none" };

const DM_TARGET_RE = /^dm:@/i;
const DM_THREAD_SUFFIX_RE = /:([0-9a-f]{8})$/i;

/** The CLI's `--peer-kind` rewrite (packages/cli `applyDmPeerKind`); null where the CLI would refuse. */
function applySendTargetPeerKind(target: string, rawKind: string | undefined): string | null {
  if (rawKind === undefined) return target;
  const kind = rawKind.trim().toLowerCase();
  if (!isDmPeerKind(kind) || !DM_TARGET_RE.test(target)) return null;
  const rest = target.slice(4);
  const thread = DM_THREAD_SUFFIX_RE.exec(rest);
  const parsed = parseDmPeerRef(thread ? rest.slice(0, thread.index) : rest);
  if (!parsed.ok || (parsed.peerKind !== null && parsed.peerKind !== kind)) return null;
  return `${target.slice(0, 4)}${formatDmPeerRef(parsed.peerName, kind)}${thread ? thread[0] : ""}`;
}

function searchSimpleCommand(
  words: SendTargetShellWord[],
  terminated: boolean,
  partial: boolean,
  depth: number,
): SendTargetSearch {
  let index = 0;
  while (index < words.length && words[index]!.complete && isEnvAssignmentToken(words[index]!.value)) index += 1;
  const executable = words[index];
  if (!executable || !executable.complete) return { status: "none" };

  if (isShellExecutableToken(executable.value)) {
    if (depth >= 2) return { status: "none" };
    for (let k = index + 1; k < words.length; k += 1) {
      const arg = words[k]!;
      if (!arg.complete) return { status: "none" };
      if (!arg.value.startsWith("-")) return { status: "none" };
      if (arg.value.endsWith("c")) {
        const payload = words[k + 1];
        if (!payload) return { status: "none" };
        return searchCommand(payload.value, partial && !payload.complete, depth + 1);
      }
    }
    return { status: "none" };
  }

  if (!isRaftExecutableToken(executable.value)) return { status: "none" };
  const resource = words[index + 1];
  const action = words[index + 2];
  if (!resource?.complete || !action?.complete) return { status: "none" };
  if (resource.value === "task" && action.value === "reply") {
    return searchTaskReplyTarget(words, index + 3, terminated, partial);
  }
  if (resource.value !== "message" || action.value !== "send") return { status: "none" };

  let target: string | undefined;
  let legacyChannel: string | undefined;
  let peerKind: string | undefined;
  let targetPending = false;
  let peerKindPending = false;
  for (let k = index + 3; k < words.length; k += 1) {
    const arg = words[k]!;
    if (!arg.complete) {
      if (arg.value.startsWith("--target=") || arg.value.startsWith("--channel=")) targetPending = true;
      if (arg.value.startsWith("--peer-kind=")) peerKindPending = true;
      break;
    }
    if (arg.value === "--") break;
    // Help prints usage and sends nothing; so does discarding a draft.
    if (arg.value === "--discard-draft" || arg.value === "--help" || arg.value === "-h") return { status: "none" };
    const eq = arg.value.indexOf("=");
    const flag = eq > 0 && arg.value.startsWith("--") ? arg.value.slice(0, eq) : arg.value;
    let value: string | undefined;
    if (eq > 0 && flag !== arg.value) {
      value = arg.value.slice(eq + 1);
    } else if (SEND_TARGET_VALUE_OPTIONS.has(flag)) {
      const next = words[k + 1];
      if (!next || !next.complete) {
        if (flag === "--target" || flag === "--channel") targetPending = true;
        if (flag === "--peer-kind") peerKindPending = true;
        break;
      }
      value = next.value;
      k += 1;
    } else {
      continue;
    }
    if (flag === "--target") target = value;
    else if (flag === "--channel") legacyChannel = value;
    else if (flag === "--peer-kind") peerKind = value;
  }

  const raw = (target?.trim() || legacyChannel?.trim()) || undefined;
  const argsFinished = terminated || !partial;
  if (!raw || (targetPending && !argsFinished)) {
    // Still streaming: a target may yet be (re)typed on this command.
    return argsFinished ? { status: "none" } : { status: "pending" };
  }
  if (partial && !argsFinished) {
    // A DM target may still get a `--peer-kind` later on the line; wait for it
    // (or for the end of the options) rather than announce the wrong DM.
    if (peerKindPending) return { status: "pending" };
    if (DM_TARGET_RE.test(raw) && !raw.includes("~") && peerKind === undefined) return { status: "pending" };
  }
  const resolved = applySendTargetPeerKind(raw, peerKind);
  return resolved ? { status: "found", target: resolved } : { status: "none" };
}

const TASK_REPLY_VALUE_OPTIONS = new Set([
  "--target",
  "--channel",
  "--peer-kind",
  "--number",
  "--attachment-id",
  "--mention",
]);
const TASK_REPLY_REF_RE = /^(?:#[^\s:#]+|dm:@[^\s:#]+):#\d+$/i;

/**
 * Task v2: `raft task reply "#channel:#7"` (or `--target "#channel" --number
 * 7`) posts into the task's conversation; its target for the typing line is
 * the task ref (`#channel:#7` / `dm:@peer:#7`), resolved by the server. A
 * `--peer-kind` reply is not announced (the ref has no peer-kind form).
 */
function searchTaskReplyTarget(
  words: SendTargetShellWord[],
  start: number,
  terminated: boolean,
  partial: boolean,
): SendTargetSearch {
  let positional: string | undefined;
  let target: string | undefined;
  let number: string | undefined;
  let pending = false;
  for (let k = start; k < words.length; k += 1) {
    const arg = words[k]!;
    if (!arg.complete) {
      pending = true;
      break;
    }
    if (arg.value === "--") break;
    if (arg.value === "--help" || arg.value === "-h") return { status: "none" };
    const eq = arg.value.indexOf("=");
    const flag = eq > 0 && arg.value.startsWith("--") ? arg.value.slice(0, eq) : arg.value;
    let value: string | undefined;
    if (eq > 0 && flag !== arg.value) {
      value = arg.value.slice(eq + 1);
    } else if (TASK_REPLY_VALUE_OPTIONS.has(flag)) {
      const next = words[k + 1];
      if (!next || !next.complete) {
        pending = true;
        break;
      }
      value = next.value;
      k += 1;
    } else if (arg.value.startsWith("-")) {
      continue;
    } else {
      positional ??= arg.value;
      continue;
    }
    if (flag === "--peer-kind") return { status: "none" };
    if (flag === "--target" || flag === "--channel") target = value;
    else if (flag === "--number") number = value;
  }
  const argsFinished = terminated || !partial;
  const ref = positional?.trim()
    || (target?.trim() && number?.trim() ? `${target.trim()}:#${number.trim().replace(/^#/, "")}` : undefined);
  if (!ref || (pending && !argsFinished)) return argsFinished ? { status: "none" } : { status: "pending" };
  return TASK_REPLY_REF_RE.test(ref) ? { status: "found", target: ref } : { status: "none" };
}

function searchCommand(command: string, partial: boolean, depth: number): SendTargetSearch {
  const tokens = lexShellForSendTarget(command, partial);
  let words: SendTargetShellWord[] = [];
  let skipNextWord = false;
  let sawRedirect = false;
  const flush = (terminated: boolean): SendTargetSearch => {
    const result = words.length > 0 ? searchSimpleCommand(words, terminated, partial, depth) : { status: "none" as const };
    words = [];
    sawRedirect = false;
    return result;
  };
  for (const token of tokens) {
    if (token.kind === "op") {
      skipNextWord = false;
      const result = flush(true);
      if (result.status !== "none") return result;
      continue;
    }
    if (token.kind === "redir") {
      skipNextWord = token.consumesWord;
      sawRedirect = true;
      continue;
    }
    if (skipNextWord) {
      skipNextWord = false;
      continue;
    }
    words.push(token);
  }
  // A redirect (usually the `<<EOF` that starts the body) ends the options in practice.
  return flush(sawRedirect);
}

/**
 * The `--target` of the first `raft message send` in a shell command (or, task
 * v2, the task ref of a `raft task reply`), or null.
 * `partial`: the command is still being generated; see the section comment.
 */
export function findRaftSendTarget(command: string, opts: { partial: boolean }): string | null {
  if (typeof command !== "string" || command.length === 0) return null;
  const result = searchCommand(command, opts.partial, 0);
  return result.status === "found" ? result.target : null;
}
