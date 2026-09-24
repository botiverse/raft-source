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
  | "collab_tool_call";

type ToolSummaryKind =
  | "none"
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
  list_server: { logLabel: "Listing server", activityLabel: "Listing server…", summaryKind: "none" },
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
  collab_tool_call: { logLabel: "Collaborating", activityLabel: "Collaborating…", summaryKind: "none" },
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
  }
}
