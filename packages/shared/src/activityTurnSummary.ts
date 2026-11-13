/**
 * Per-turn activity summary (task #17, RFC 069 §6 summary row).
 *
 * One record per agent turn: when it ran, how it ended, who woke the agent,
 * what kinds of work it did (counts), which steps did not go as planned, the
 * id of its last reply and the last text the runtime output (`lastText`). It
 * carries no tool input, tool output or message body: the Activity overview
 * reads only these records, and a reply's text is fetched by message id under
 * the message's own visibility rules. `lastText` is the agent's own output
 * that went to no one (it is in the raw activity log too, for the same
 * audience), capped at ACTIVITY_TURN_LAST_TEXT_LIMIT.
 *
 * The daemon (managed agents) and the server (external / hosted agents) build
 * it with the same accumulator below, so both producers emit one shape.
 */
import type { AgentActivityDetailKind, AgentActivityKind, AgentAppEventSummary, TrajectoryEntry } from "./index";
import { normalizeToolDisplayInvocation, resolveToolSemantic, type ToolSemantic } from "./toolDisplay";

/**
 * What a tool call did, for a friendly count ("ran 3 commands, read a file").
 * The first ten values are OAR's `ToolActionKind` (`@botiverse/oar/observe`)
 * so an OAR-hosted runtime maps one to one; the rest are Raft's own: Raft CLI
 * actions and a split of shell commands into version control and checks.
 */
export const ACTIVITY_ACTION_KINDS = [
  "run_command",
  "read_file",
  "edit_file",
  "search",
  "web",
  "fetch",
  "subagent",
  "mcp",
  "wait",
  "other",
  "send_message",
  "read_messages",
  "raft_action",
  "version_control",
  "run_checks",
] as const;
export type ActivityActionKind = (typeof ACTIVITY_ACTION_KINDS)[number];

export const ACTIVITY_TURN_OUTCOMES = ["completed", "failed", "interrupted", "unknown"] as const;
export type ActivityTurnOutcome = (typeof ACTIVITY_TURN_OUTCOMES)[number];

/** Why a step counts as not going as planned. */
export const ACTIVITY_PROBLEM_REASONS = [
  /** The tool call itself failed (`ok: false`). */
  "call_failed",
  /** The command ran and exited non-zero (`ok` true or unknown, `exitCode` ≠ 0). */
  "exit_nonzero",
  /** A message send was held as a draft (unread messages in the target). */
  "send_held",
] as const;
export type ActivityProblemReason = (typeof ACTIVITY_PROBLEM_REASONS)[number];

export interface ActivityTurnProblem {
  kind: ActivityActionKind;
  reason: ActivityProblemReason;
  exitCode?: number;
  /** Epoch ms when the step ended. */
  at: number;
}

export interface ActivityTurnTrigger {
  /** Raft target the waking message came from, e.g. `#proj-runtime:9b526607` or `dm:@alice`. */
  target?: string;
  /**
   * The channel / DM / thread the message was posted in. Readers check the
   * viewer's access with it and show a private channel or DM they cannot see
   * without its name.
   */
  channelId?: string;
  /** Sender handle without `@`. */
  sender?: string;
  messageId?: string;
}

const ACTIVITY_TURN_TRIGGER_FIELDS = ["target", "channelId", "sender", "messageId"] as const;

/**
 * A trigger read back from stored rows or a daemon frame: its known fields,
 * which must be strings. A malformed one (a field of another type, not an
 * object) is no trigger: readers show none rather than fail.
 */
export function readActivityTurnTrigger(value: unknown): ActivityTurnTrigger | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const trigger: ActivityTurnTrigger = {};
  for (const field of ACTIVITY_TURN_TRIGGER_FIELDS) {
    const fieldValue = record[field];
    if (fieldValue === undefined) continue;
    if (typeof fieldValue !== "string") return undefined;
    trigger[field] = fieldValue;
  }
  return trigger;
}

export interface ActivityTurnSummary {
  v: 1;
  /** Epoch ms, producer clock. */
  startedAt: number;
  endedAt: number;
  outcome: ActivityTurnOutcome;
  trigger?: ActivityTurnTrigger;
  /** Tool calls by kind, each kind once, in first-seen order. */
  actions: { kind: ActivityActionKind; count: number }[];
  toolCalls: number;
  /** At most ACTIVITY_TURN_PROBLEM_LIMIT, oldest first; `problemCount` is the full count. */
  problems: ActivityTurnProblem[];
  problemCount: number;
  messagesSent: number;
  lastReplyMessageId?: string;
  /**
   * The last text the runtime output in the turn (typically the agent's own
   * account of what it did), never sent to anyone: the last run of output
   * text entries with nothing else between them, trimmed, at most
   * ACTIVITY_TURN_LAST_TEXT_LIMIT characters (capActivityTurnLastText).
   * Absent when the turn output no text, and from older producers.
   */
  lastText?: string;
  /**
   * The turn ended on the runtime's provider usage limit (a used-up quota,
   * e.g. a weekly limit), and when the runtime said it resets (epoch ms) if it
   * said. A run of such turns is the daemon retrying until the reset, which
   * readers show as one wait rather than turn by turn. Absent otherwise, and
   * from older producers.
   */
  usageLimit?: ActivityTurnUsageLimit;
  /**
   * What the turn used, as token counts the runtime reported for this turn
   * only (a cumulative source already turned into its per-turn change), and
   * the model it ran on. Numbers and the model name only: never prompt text,
   * paths or account details. A count the runtime does not report is absent
   * (readers show it as unknown, not 0). Absent from turns that used nothing
   * the runtime counts, from runtimes that report no usage, and from older
   * producers. The server adds it to its per-day usage table
   * (agent_usage_daily) once per turn.
   */
  tokens?: ActivityTurnTokens;
}

export interface ActivityTurnTokens {
  /** Input that was not read from the prompt cache. */
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** All output, reasoning included. */
  output?: number;
  /** The part of `output` the runtime reports as reasoning, when it does. */
  reasoningOutput?: number;
  /** The model the turn ran on, as the runtime names it (at most 120 characters). */
  model?: string;
  /** Context in use when the turn ended, and the model's context window, when known. */
  contextUsed?: number;
  contextWindow?: number;
}

/** The count fields of ActivityTurnTokens, in their stored order. */
export const ACTIVITY_TURN_TOKEN_COUNT_FIELDS = ["input", "cacheRead", "cacheWrite", "output", "reasoningOutput"] as const;
export type ActivityTurnTokenCountField = (typeof ACTIVITY_TURN_TOKEN_COUNT_FIELDS)[number];

const ACTIVITY_TURN_MODEL_LIMIT = 120;

/**
 * A turn's `tokens` as a producer reported it, each field kept only when it
 * has its known shape (counts: non-negative integers; model: a non-blank
 * string, cut to 120 characters). Undefined when nothing is left, so a turn
 * with no readable usage stores no `tokens` at all.
 */
export function readActivityTurnTokens(value: unknown): ActivityTurnTokens | undefined {
  if (!isRecord(value)) return undefined;
  const tokens: ActivityTurnTokens = {};
  for (const field of [...ACTIVITY_TURN_TOKEN_COUNT_FIELDS, "contextUsed", "contextWindow"] as const) {
    if (isCount(value[field])) tokens[field] = value[field];
  }
  if (typeof value.model === "string" && value.model.trim()) tokens.model = value.model.trim().slice(0, ACTIVITY_TURN_MODEL_LIMIT);
  return Object.keys(tokens).length > 0 ? tokens : undefined;
}

export interface ActivityTurnUsageLimit {
  /** Epoch ms, as the runtime reported it. */
  resetsAt?: number;
}

export const ACTIVITY_TURN_PROBLEM_LIMIT = 20;

/** Most characters (UTF-16 code units) a turn's `lastText` keeps, its ellipsis included. */
export const ACTIVITY_TURN_LAST_TEXT_LIMIT = 2_000;

/**
 * A turn's last text cut to ACTIVITY_TURN_LAST_TEXT_LIMIT: the start kept and
 * an ellipsis ("…") put where it was cut, as the daemon cuts a trajectory text
 * row, never inside a surrogate pair. A text within the limit is returned as
 * is, so cutting again changes nothing.
 */
export function capActivityTurnLastText(text: string): string {
  if (text.length <= ACTIVITY_TURN_LAST_TEXT_LIMIT) return text;
  let end = ACTIVITY_TURN_LAST_TEXT_LIMIT - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}\u2026`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isCount(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

/** `actions` rebuilt from known entries: a known kind and a positive count, each kind once (counts of a repeated kind added up). */
function readActions(value: unknown[]): ActivityTurnSummary["actions"] {
  const counts = new Map<ActivityActionKind, number>();
  for (const entry of value) {
    if (!isRecord(entry) || !includes(ACTIVITY_ACTION_KINDS, entry.kind) || !isCount(entry.count) || entry.count === 0) continue;
    counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + entry.count);
  }
  return [...counts].map(([kind, count]) => ({ kind, count }));
}

/** `problems` rebuilt from known entries (known kind and reason, a time, an integer exit code if any), at most ACTIVITY_TURN_PROBLEM_LIMIT. */
function readProblems(value: unknown[]): ActivityTurnProblem[] {
  const problems: ActivityTurnProblem[] = [];
  for (const entry of value) {
    if (problems.length >= ACTIVITY_TURN_PROBLEM_LIMIT) break;
    if (!isRecord(entry) || !includes(ACTIVITY_ACTION_KINDS, entry.kind) || !includes(ACTIVITY_PROBLEM_REASONS, entry.reason) || !isFiniteNumber(entry.at)) continue;
    if (entry.exitCode !== undefined && !(isFiniteNumber(entry.exitCode) && Number.isInteger(entry.exitCode))) continue;
    problems.push({
      kind: entry.kind,
      reason: entry.reason,
      ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}),
      at: entry.at,
    });
  }
  return problems;
}

/**
 * A turn summary as a producer reported it (a daemon's `turn_summary` frame)
 * or as a stored row holds it, narrowed to what a producer owns: the
 * ActivityTurnSummary fields only, each rebuilt from its known shape.
 * Anything else (fields only the server attaches, such as sent messages, app
 * events or `running`; unknown keys; a trigger's server-resolved names) is
 * dropped, so a producer cannot set it and a row stored before this reader
 * existed reads the same way. The daemon's accumulator output passes through
 * unchanged. A `lastText` that is not a non-blank string is dropped, and a
 * longer one is cut to ACTIVITY_TURN_LAST_TEXT_LIMIT again.
 *
 * Undefined when the summary is not plausible: not version 1, times that are
 * not finite or end before they start, no outcome, `actions` or `problems`
 * that are not lists, or a trigger readers cannot read
 * (readActivityTurnTrigger). Within that, it is lenient: an outcome this
 * version does not know reads as `unknown`, entries of an unknown kind or
 * reason are dropped, and a count that is not a non-negative integer falls
 * back to what the lists say (tool calls: the action counts; problems: the
 * listed ones; messages sent: none).
 */
export function readDaemonTurnSummary(value: unknown): ActivityTurnSummary | undefined {
  if (!isRecord(value)) return undefined;
  const { startedAt, endedAt, outcome, actions, problems } = value;
  if (value.v !== 1 || !isFiniteNumber(startedAt) || !isFiniteNumber(endedAt) || endedAt < startedAt) return undefined;
  if (typeof outcome !== "string" || !Array.isArray(actions) || !Array.isArray(problems)) return undefined;
  const trigger = value.trigger === undefined ? undefined : readActivityTurnTrigger(value.trigger);
  if (value.trigger !== undefined && !trigger) return undefined;
  const readActionsList = readActions(actions);
  const readProblemsList = readProblems(problems);
  return {
    v: 1,
    startedAt,
    endedAt,
    outcome: includes(ACTIVITY_TURN_OUTCOMES, outcome) ? outcome : "unknown",
    ...(trigger && Object.keys(trigger).length > 0 ? { trigger } : {}),
    actions: readActionsList,
    toolCalls: isCount(value.toolCalls) ? value.toolCalls : readActionsList.reduce((sum, action) => sum + action.count, 0),
    problems: readProblemsList,
    problemCount: isCount(value.problemCount) ? Math.max(value.problemCount, readProblemsList.length) : readProblemsList.length,
    messagesSent: isCount(value.messagesSent) ? value.messagesSent : 0,
    ...(typeof value.lastReplyMessageId === "string" && value.lastReplyMessageId ? { lastReplyMessageId: value.lastReplyMessageId } : {}),
    ...(typeof value.lastText === "string" && value.lastText.trim() ? { lastText: capActivityTurnLastText(value.lastText) } : {}),
    ...(isRecord(value.usageLimit)
      ? { usageLimit: isFiniteNumber(value.usageLimit.resetsAt) ? { resetsAt: value.usageLimit.resetsAt } : {} }
      : {}),
    ...withTokens(readActivityTurnTokens(value.tokens)),
  };
}

function withTokens(tokens: ActivityTurnTokens | undefined): { tokens?: ActivityTurnTokens } {
  return tokens ? { tokens } : {};
}

/**
 * One app event (a row of third_party_agent_events: a Stamp PR/CI event, a
 * Reminder firing) delivered to the agent during a turn, as the Activity
 * overview shows it. The same audience as the agent's app events list, so the
 * app's name and the one-line summary only: never the payload, its hash, the
 * resource or token ids.
 */
export interface ActivityTurnAppEventView {
  id: string;
  appName: string;
  /** The OAuth client's key, or a Raft system app's fixed name (`system.assistant`). */
  clientKey: string;
  /** The app's logo, when it has one. Absent from a server that does not send it. */
  logoUrl?: string | null;
  summary: string;
  /** Epoch ms, server clock. */
  deliveredAt: number;
  kind: AgentAppEventSummary["kind"];
}

/** The app event that woke a turn (`trigger.target` `agent-event:<id8>`), when it could be resolved. */
export interface ActivityTurnTriggerAppEvent {
  appName: string;
  summary: string;
}

/**
 * Where the message that woke a turn was posted and who sent it, as the
 * server resolves it from the trigger's ids (`trigger.display`), never from
 * the producer's `target` / `sender` text: the channel's name and whether
 * the message is in a thread from the channel itself, the sender from the
 * message `messageId` names, and for a DM without a message id the DM's
 * other member as the agent sees it. Handles are without `@`. Only for a
 * trigger the viewer may see; older servers do not send it, and readers then
 * fall back to `target` / `sender`.
 */
export type ActivityTurnTriggerDisplay =
  | { kind: "channel" | "thread"; channelName: string; senderName?: string }
  | { kind: "dm"; senderName?: string; peerName?: string };

/**
 * What the Activity overview adds to a turn about app events. Optional and
 * additive: a server that does not send them and a web that does not read
 * them both keep working.
 */
export interface ActivityTurnAppEventsView {
  /** The app events delivered in the turn, oldest first, at most ACTIVITY_TURN_APP_EVENTS_LIMIT. */
  appEvents?: ActivityTurnAppEventView[];
  /** How many were delivered in the turn (the list is capped). */
  appEventCount?: number;
}

export const ACTIVITY_TURN_APP_EVENTS_LIMIT = 50;

/**
 * The turn still running (the Activity overview's `current`): what it has
 * done so far and no outcome yet. `endedAt` is when it was read, so
 * `endedAt - startedAt` is how long it has run until then.
 */
export type RunningActivityTurnSummary = Omit<ActivityTurnSummary, "outcome"> & { running: true };

const SEMANTIC_ACTION: Partial<Record<ToolSemantic, ActivityActionKind>> = {
  send_message: "send_message",
  check_messages: "read_messages",
  wait_for_message: "read_messages",
  receive_message: "read_messages",
  read_history: "read_messages",
  search_messages: "read_messages",
  read_file: "read_file",
  view_file: "read_file",
  write_file: "edit_file",
  edit_file: "edit_file",
  bash: "run_command",
  glob: "search",
  grep: "search",
  web_fetch: "fetch",
  web_search: "web",
  collab_tool_call: "subagent",
  spawn_subagent: "subagent",
};

const RAFT_SEMANTICS = new Set<ToolSemantic>([
  "list_server", "list_tasks", "create_tasks", "claim_tasks", "unclaim_task", "update_task_status",
  "add_channel_member", "join_channel", "leave_channel", "upload_file", "todo_write",
  "schedule_reminder", "list_reminders", "cancel_reminder",
]);

// Leading `cd x &&`, `export A=b;` and `A=b ` prefixes that do not say what a command does.
const COMMAND_PREFIX = /^(?:\s*(?:cd\s+[^;&|]+(?:&&|;)|export\s+[^;&|]+(?:&&|;)|[A-Za-z_][A-Za-z0-9_]*=\S*\s+))+/;
const CHECK_COMMAND = /(?:^|[\s;&|/(])(?:vitest|jest|mocha|pytest|playwright|tsc|oxlint|eslint|ruff|mypy|cargo\s+(?:test|check|clippy)|go\s+(?:test|vet)|(?:npm|pnpm|yarn|bun)\s+(?:(?:--filter|-F)\s+\S+\s+)?(?:run\s+)?(?:test|typecheck|lint|check)\b|node\s+--test|run-vitest)/;
const VCS_COMMAND = /^(?:git|stamp|gh|jj|hg)\s/;
const READ_COMMAND = /^(?:cat|head|tail|less|wc|sed\s+-n|nl|stat|file)\b/;
const SEARCH_COMMAND = /^(?:grep|rg|ag|find|fd|ls|tree)\b/;

/**
 * Split a shell command into a friendlier kind by its leading program. A fixed
 * table, first match wins; anything else stays `run_command`. Raft CLI calls
 * never reach here: they resolve to their own semantic first.
 */
export function classifyShellCommand(command: string): ActivityActionKind {
  const body = command.replace(COMMAND_PREFIX, "").trimStart();
  const firstLine = body.split("\n", 1)[0] ?? "";
  if (CHECK_COMMAND.test(firstLine)) return "run_checks";
  if (VCS_COMMAND.test(firstLine)) return "version_control";
  if (READ_COMMAND.test(firstLine)) return "read_file";
  if (SEARCH_COMMAND.test(firstLine)) return "search";
  return "run_command";
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  if (!text.startsWith("{")) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * Classify one tool call from what a `tool_start` entry carries: the tool name
 * and its input, either the daemon's summary (for a shell tool, the command
 * text) or, from external hooks, the tool input as JSON.
 */
export function classifyToolCall(toolName: string, toolInput: string): ActivityActionKind {
  const input = parseJsonObject(toolInput) ?? { command: toolInput };
  const command = typeof input.command === "string" ? input.command : toolInput;
  const invocation = normalizeToolDisplayInvocation(toolName, input);
  const semantic = resolveToolSemantic(invocation.toolName) ?? resolveToolSemantic(toolName);
  if (semantic === "bash") return classifyShellCommand(command);
  if (semantic && SEMANTIC_ACTION[semantic]) return SEMANTIC_ACTION[semantic]!;
  if (semantic && RAFT_SEMANTICS.has(semantic)) return "raft_action";
  if (toolName.startsWith("mcp__") || toolName.includes("/")) return "mcp";
  return "other";
}

/** A turn's work: a tool call or a tool call's end. Output text and thinking are not. */
function isTurnWork(entry: TrajectoryEntry): boolean {
  return entry.kind === "tool_start" || (entry.kind === "status" && entry.detailKind === "tool_end");
}

/**
 * Folds one turn's activity into an ActivityTurnSummary. Feed it the turn's
 * trajectory entries in order (live, as the daemon produces them, or replayed
 * from storage) plus the send results; `finish` returns the record.
 */
export class ActivityTurnAccumulator {
  private readonly counts = new Map<ActivityActionKind, number>();
  private readonly openCalls = new Map<string, ActivityActionKind>();
  private readonly unmatched: ActivityActionKind[] = [];
  private readonly problems: ActivityTurnProblem[] = [];
  private problemCount = 0;
  private toolCalls = 0;
  private messagesSent = 0;
  private lastReplyMessageId: string | undefined;
  /** The latest run of output text, as the entries carried it. */
  private lastText = "";
  /** The last entry folded was output text: the next one continues the same run. */
  private inTextRun = false;
  private usageLimit: ActivityTurnUsageLimit | undefined;
  private tokens: ActivityTurnTokens | undefined;

  constructor(
    private readonly startedAt: number,
    private readonly trigger?: ActivityTurnTrigger,
  ) {}

  addEntry(entry: TrajectoryEntry, at: number): void {
    // A subagent's entries are its own: its text is not the turn's output,
    // and they do not split the agent's own text.
    if (!("subagent" in entry && entry.subagent)) this.addOutputText(entry);
    if (entry.kind === "tool_start") {
      const kind = classifyToolCall(entry.toolName, entry.toolInput);
      this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1);
      this.toolCalls += 1;
      if (entry.callId) this.openCalls.set(entry.callId, kind);
      else this.unmatched.push(kind);
      return;
    }
    if (entry.kind !== "status" || entry.detailKind !== "tool_end" || !entry.tool) return;
    const { callId, ok, exitCode } = entry.tool;
    let kind: ActivityActionKind = "other";
    if (callId && this.openCalls.has(callId)) {
      kind = this.openCalls.get(callId)!;
      this.openCalls.delete(callId);
    } else if (this.unmatched.length > 0) {
      kind = this.unmatched.shift()!;
    }
    if (ok === false) this.addProblem({ kind, reason: "call_failed", ...(exitCode !== undefined ? { exitCode } : {}), at });
    else if (exitCode !== undefined && exitCode !== 0) this.addProblem({ kind, reason: "exit_nonzero", exitCode, at });
  }

  /**
   * The turn's last text: output text entries in a row (a runtime streams one
   * reply in pieces; the daemon coalesces them only while they keep coming)
   * are one text, and any other entry (a tool call, thinking, a status) ends
   * it, so the next text starts a new one. Blank text changes nothing.
   */
  private addOutputText(entry: TrajectoryEntry): void {
    if (entry.kind !== "text") {
      this.inTextRun = false;
      return;
    }
    if (!entry.text.trim()) return;
    if (!this.inTextRun) this.lastText = "";
    this.inTextRun = true;
    // Past the cap the rest of the run would be cut anyway.
    if (this.lastText.length <= ACTIVITY_TURN_LAST_TEXT_LIMIT) this.lastText += entry.text;
  }

  /** A `raft message send` the server accepted (state `sent`). */
  noteMessageSent(messageId: string | undefined): void {
    this.messagesSent += 1;
    if (messageId) this.lastReplyMessageId = messageId;
  }

  /** A `raft message send` the server held as a draft. */
  noteSendHeld(at: number): void {
    this.addProblem({ kind: "send_message", reason: "send_held", at });
  }

  /** The runtime stopped on its provider usage limit (the last report wins). */
  noteUsageLimit(resetsAt: number | undefined): void {
    this.usageLimit = resetsAt !== undefined && Number.isFinite(resetsAt) ? { resetsAt } : {};
  }

  /**
   * Tokens a runtime turn used (its own counts, not session totals). Counts
   * add up when one summary covers several runtime turns; the model and the
   * context reading are the latest reported.
   */
  noteTokens(tokens: ActivityTurnTokens): void {
    const next = readActivityTurnTokens(tokens);
    if (!next) return;
    const into: ActivityTurnTokens = { ...this.tokens };
    for (const field of ACTIVITY_TURN_TOKEN_COUNT_FIELDS) {
      const value = next[field];
      if (value !== undefined) into[field] = (into[field] ?? 0) + value;
    }
    if (next.model !== undefined) into.model = next.model;
    if (next.contextUsed !== undefined) into.contextUsed = next.contextUsed;
    if (next.contextWindow !== undefined) into.contextWindow = next.contextWindow;
    this.tokens = into;
  }

  finish(outcome: ActivityTurnOutcome, endedAt: number): ActivityTurnSummary {
    return { ...this.soFar(endedAt), outcome };
  }

  /** The turn so far, still running, read at `now`. */
  running(now: number): RunningActivityTurnSummary {
    return { ...this.soFar(now), running: true };
  }

  private soFar(endedAt: number): Omit<ActivityTurnSummary, "outcome"> {
    const lastText = this.lastText.trim();
    return {
      v: 1,
      startedAt: this.startedAt,
      endedAt: Math.max(endedAt, this.startedAt),
      ...(this.trigger && Object.keys(this.trigger).length > 0 ? { trigger: { ...this.trigger } } : {}),
      actions: [...this.counts].map(([kind, count]) => ({ kind, count })),
      toolCalls: this.toolCalls,
      problems: [...this.problems],
      problemCount: this.problemCount,
      messagesSent: this.messagesSent,
      ...(this.lastReplyMessageId ? { lastReplyMessageId: this.lastReplyMessageId } : {}),
      ...(lastText ? { lastText: capActivityTurnLastText(lastText) } : {}),
      ...(this.usageLimit ? { usageLimit: { ...this.usageLimit } } : {}),
      ...(this.tokens ? { tokens: { ...this.tokens } } : {}),
    };
  }

  private addProblem(problem: ActivityTurnProblem): void {
    this.problemCount += 1;
    if (this.problems.length < ACTIVITY_TURN_PROBLEM_LIMIT) this.problems.push(problem);
  }
}

export interface LoggedActivityRow {
  /** Epoch ms the row was recorded at (for external agents: the event's own time). */
  timestamp: number;
  entry: TrajectoryEntry;
}

export interface LoggedTurn<S = ActivityTurnSummary> {
  /** Index in `rows` of the entry that opened the turn; its key identifies the turn. */
  startIndex: number;
  summary: S;
}

/**
 * Rebuild turn summaries from stored activity rows (the server's path for
 * agents without a daemon). Rows are folded in timestamp order (stable for
 * ties), so events that arrived late or out of order land in their turn.
 * A turn opens at a row `turnStart` accepts (a start while a turn is open
 * is part of that turn: a status report saying "working" again mid-turn)
 * and closes at the first later row `turnEnd` gives an outcome for. The row
 * that opens a turn is part of it. A turn still open at the end of `rows` is
 * `open`, read at its last row. `sends` are the messages the agent sent
 * (time + id); each counts in the turn whose time span contains it.
 */
export function summarizeTurnsFromLog(
  rows: readonly LoggedActivityRow[],
  options: {
    turnStart: (entry: TrajectoryEntry) => ActivityTurnTrigger | null;
    turnEnd: (entry: TrajectoryEntry) => ActivityTurnOutcome | null;
    /**
     * Ends that a status stream may take back: if a row `turnStart` accepts
     * follows within `softEndGraceMs`, the turn goes on (a reported "online"
     * blip between two "working" reports is one turn, not two).
     */
    softEnd?: (entry: TrajectoryEntry) => boolean;
    softEndGraceMs?: number;
    sends?: readonly { at: number; messageId?: string }[];
  },
): { turns: LoggedTurn[]; open: LoggedTurn<RunningActivityTurnSummary> | null } {
  const ordered = rows.map((row, index) => ({ ...row, index })).sort((a, b) => a.timestamp - b.timestamp || a.index - b.index);
  const sends = [...(options.sends ?? [])].sort((a, b) => a.at - b.at);
  const grace = options.softEndGraceMs ?? 0;
  const resumesSoon = (position: number) => {
    const endedAt = ordered[position]!.timestamp;
    for (let next = position + 1; next < ordered.length && ordered[next]!.timestamp - endedAt <= grace; next += 1) {
      if (options.turnStart(ordered[next]!.entry)) return true;
    }
    return false;
  };
  const turns: LoggedTurn[] = [];
  let open: { startIndex: number; acc: ActivityTurnAccumulator; startedAt: number } | null = null;
  for (const [position, row] of ordered.entries()) {
    const trigger: ActivityTurnTrigger | null = open ? null : options.turnStart(row.entry);
    if (trigger) {
      open = { startIndex: row.index, acc: new ActivityTurnAccumulator(row.timestamp, Object.keys(trigger).length > 0 ? trigger : undefined), startedAt: row.timestamp };
      open.acc.addEntry(row.entry, row.timestamp);
      continue;
    }
    if (!open) continue;
    open.acc.addEntry(row.entry, row.timestamp);
    const outcome = options.turnEnd(row.entry);
    if (outcome && !(outcome === "completed" && options.softEnd?.(row.entry) && resumesSoon(position))) {
      for (const send of sends) {
        if (send.at >= open.startedAt && send.at <= row.timestamp) open.acc.noteMessageSent(send.messageId);
      }
      turns.push({ startIndex: open.startIndex, summary: open.acc.finish(outcome, row.timestamp) });
      open = null;
    }
  }
  if (!open) return { turns, open: null };
  const startedAt = open.startedAt;
  for (const send of sends) {
    if (send.at >= startedAt) open.acc.noteMessageSent(send.messageId);
  }
  return { turns, open: { startIndex: open.startIndex, summary: open.acc.running(ordered.at(-1)!.timestamp) } };
}

/**
 * Most time between an empty wake's end and the work that continues it.
 * Under Claude Code the daemon hears "turn over" at a `result` while the
 * runtime often keeps working (queued notices, background-task reports); a
 * message handed over in that window opens a turn the next `result` closes
 * about a second later having done nothing, and the real work follows. That
 * work can start well after the wake's end (a model request and thinking come
 * before the first tool call), and the server also compares daemon times with
 * its own (clock skew either way), so the bound is generous. Empty turns are
 * real too (a message read and left unanswered) and trigger-less work has
 * other sources (a background follow-up, a restart): later work is a turn of
 * its own. The daemon holds an empty wake this long (TurnSummaryTracker); the
 * server joins stored pairs within it on read.
 */
export const EMPTY_WAKE_CONTINUATION_MS = 120_000;

/** A completed turn a message opened that did nothing: no tool call, no send, nothing gone wrong. */
export function isEmptyWake(turn: ActivityTurnSummary): boolean {
  return turn.outcome === "completed"
    && turn.toolCalls === 0
    && turn.messagesSent === 0
    && turn.problemCount === 0
    && turn.trigger !== undefined;
}

type TrackedTurn =
  /** `runtimeEnded`: how the runtime said the turn ended, when no end frame carried it, and `runtimeEndedAt` when (see noteRuntimeTurnEnd). */
  | { state: "open"; acc: ActivityTurnAccumulator; runtimeEnded?: ActivityTurnOutcome; runtimeEndedAt?: number }
  /** An empty wake whose summary waits for what follows it (see TurnSummaryTracker). */
  | { state: "held"; acc: ActivityTurnAccumulator; summary: ActivityTurnSummary };

/**
 * Per-agent turn summaries for the Activity overview (task #17). A turn opens
 * when an idle agent is handed a message, folds every trajectory entry the
 * daemon publishes for that agent, and closes on the frame that says the turn
 * is over (idle, stopped, crashed); that frame then carries the summary entry.
 * Only work (a tool call or its end, see observe) opens a turn without a
 * message; output text and thinking only add to a turn already there.
 *
 * An empty wake (`isEmptyWake`) is held rather than published: if work (a
 * tool call or a send) follows within EMPTY_WAKE_CONTINUATION_MS of its end,
 * that work reopens it, so the turn keeps its trigger, start (and so its
 * stored key) and ends when the work does. Otherwise it is a real empty turn
 * (a message read and left unanswered) and is published as it ended, with
 * the next frame that decides it: the next turn's start, a stop or crash, or
 * any frame after the bound. Until one comes it stays unpublished.
 */
export class TurnSummaryTracker {
  private readonly turns = new Map<string, TrackedTurn>();

  /**
   * A new turn. If the previous one never reached an end frame (a lost idle, a
   * daemon that missed the end), it closes here; it and a held empty wake are
   * returned so the caller can publish them with the turn-start frame. It
   * closes as the runtime said it ended (noteRuntimeTurnEnd), else as
   * `previousOutcome`; a caller's "failed" wins over a runtime end. It ends
   * when the runtime said so, not now: the wait until the next turn (a
   * usage-limit backoff can be an hour) was not part of it.
   */
  begin(agentId: string, now: number, trigger: ActivityTurnTrigger | undefined, previousOutcome: ActivityTurnOutcome = "unknown"): TrajectoryEntry[] {
    const previous = this.turns.get(agentId);
    this.turns.set(agentId, { state: "open", acc: new ActivityTurnAccumulator(now, trigger) });
    if (!previous) return [];
    if (previous.state === "held") return [summaryEntry(previous.summary)];
    const outcome = previousOutcome === "failed" ? previousOutcome : previous.runtimeEnded ?? previousOutcome;
    return [summaryEntry(previous.acc.finish(outcome, Math.min(previous.runtimeEndedAt ?? now, now)))];
  }

  /**
   * The runtime ended the open turn, but no end frame says so: messages queued
   * during it are handed over at once as the next turn, or background work
   * keeps the agent "waiting" instead of idle. The next turn's start then
   * closes it with `outcome`, not "unknown". Work that follows (a tool call)
   * clears this: the turn went on. A late send outcome does not.
   */
  noteRuntimeTurnEnd(agentId: string, outcome: ActivityTurnOutcome, at?: number): void {
    const turn = this.turns.get(agentId);
    if (turn?.state !== "open") return;
    this.turns.set(agentId, { state: "open", acc: turn.acc, runtimeEnded: outcome, ...(at !== undefined ? { runtimeEndedAt: at } : {}) });
  }

  /** Tokens a runtime turn of the open turn used (ActivityTurnSummary.tokens). */
  noteTokens(agentId: string, tokens: ActivityTurnTokens): void {
    const turn = this.turns.get(agentId);
    if (turn?.state === "open") turn.acc.noteTokens(tokens);
  }

  /** The open turn stopped on the runtime's provider usage limit (ActivityTurnSummary.usageLimit). */
  noteUsageLimit(agentId: string, resetsAt: number | undefined): void {
    const turn = this.turns.get(agentId);
    if (turn?.state === "open") turn.acc.noteUsageLimit(resetsAt);
  }

  /**
   * Fold published entries; a turn already running when the daemon started is
   * picked up here, without a trigger. Returns a held empty wake this frame
   * comes too late to continue, for the caller to publish with it.
   *
   * Only work (a tool call or its end) opens a turn, takes up a held empty
   * wake again or clears a runtime end (noteRuntimeTurnEnd). A frame without
   * work, such as output text, folds into the turn there is and changes none
   * of that: Claude's text after its `result` is not work going on, and text
   * alone does not make an empty wake a turn of work. A held wake's summary
   * stays as it ended; its text goes on in the accumulator, for the work that
   * may still take it up. With no turn the text belongs to none.
   */
  observe(agentId: string, entries: readonly TrajectoryEntry[], now: number): TrajectoryEntry[] {
    const released = this.releaseExpired(agentId, now);
    if (entries.length === 0) return released;
    if (!entries.some(isTurnWork)) {
      const acc = this.turns.get(agentId)?.acc;
      if (acc) for (const entry of entries) acc.addEntry(entry, now);
      return released;
    }
    // Work takes up a held empty wake again: same trigger, start and accumulator.
    const acc = this.turns.get(agentId)?.acc ?? new ActivityTurnAccumulator(now);
    this.turns.set(agentId, { state: "open", acc });
    for (const entry of entries) acc.addEntry(entry, now);
    return released;
  }

  noteSendOutcome(agentId: string, outcome: { state: "sent"; messageId?: string } | { state: "held" }, now: number): void {
    if (this.isExpired(agentId, now)) return;
    const turn = this.turns.get(agentId);
    if (!turn) return;
    const acc = turn.acc;
    // A send's outcome may arrive after the runtime ended the turn: not new work.
    if (turn.state === "held") this.turns.set(agentId, { state: "open", acc });
    if (outcome.state === "sent") acc.noteMessageSent(outcome.messageId);
    else acc.noteSendHeld(now);
  }

  /**
   * Close the open turn, if any, and return its summary entry; an empty wake
   * is held instead. A held one is published on a stop or crash, or on an end
   * frame after the bound; another idle within it keeps it held.
   */
  finish(agentId: string, outcome: ActivityTurnOutcome, now: number): TrajectoryEntry[] {
    const turn = this.turns.get(agentId);
    if (!turn) return [];
    if (turn.state === "held") {
      if (outcome === "completed" && !this.isExpired(agentId, now)) return [];
      this.turns.delete(agentId);
      return [summaryEntry(turn.summary)];
    }
    const summary = turn.acc.finish(outcome, now);
    if (isEmptyWake(summary)) {
      this.turns.set(agentId, { state: "held", acc: turn.acc, summary });
      return [];
    }
    this.turns.delete(agentId);
    return [summaryEntry(summary)];
  }

  /**
   * Forget the agent's turn (its process is going away for good: an orderly
   * daemon shutdown, an explicit stop). Returns a held empty wake's summary
   * for the caller to publish; an open turn has no end to report and is
   * dropped, as it would be with its process.
   */
  release(agentId: string): TrajectoryEntry[] {
    const turn = this.turns.get(agentId);
    this.turns.delete(agentId);
    return turn?.state === "held" ? [summaryEntry(turn.summary)] : [];
  }

  private isExpired(agentId: string, now: number): boolean {
    const turn = this.turns.get(agentId);
    return turn?.state === "held" && now - turn.summary.endedAt > EMPTY_WAKE_CONTINUATION_MS;
  }

  private releaseExpired(agentId: string, now: number): TrajectoryEntry[] {
    const turn = this.turns.get(agentId);
    if (turn?.state !== "held" || !this.isExpired(agentId, now)) return [];
    this.turns.delete(agentId);
    return [summaryEntry(turn.summary)];
  }
}

function summaryEntry(summary: ActivityTurnSummary): TrajectoryEntry {
  return { kind: "turn_summary", summary };
}

/**
 * Turn boundaries in a daemon-managed agent's stored activity rows, drawn as
 * the daemon's TurnSummaryTracker draws them live: busy work (a tool call, a
 * working or thinking status) opens a turn, and the frame that ends one (idle,
 * offline, or the summary of a turn the next wake closed) closes it. The
 * trigger is the one the opening status names (a newer daemon's "Message
 * received"); older daemons kept it in memory until the turn's summary.
 */
export const DAEMON_LOG_TURN_BOUNDARIES = {
  turnStart: (entry: TrajectoryEntry): ActivityTurnTrigger | null => {
    if (entry.kind === "tool_start") return {};
    if (entry.kind !== "status" || (entry.activity !== "working" && entry.activity !== "thinking")) return null;
    return readActivityTurnTrigger(entry.trigger) ?? {};
  },
  turnEnd: (entry: TrajectoryEntry): ActivityTurnOutcome | null => {
    if (entry.kind === "turn_summary") return ACTIVITY_TURN_OUTCOMES.includes(entry.summary?.outcome) ? entry.summary.outcome : "unknown";
    return entry.kind === "status" ? turnOutcomeForActivity(entry.activity, entry.detailKind) : null;
  },
};

const RUNTIME_PROGRESS_DETAIL_KINDS: ReadonlySet<AgentActivityDetailKind> = new Set<AgentActivityDetailKind>([
  "model_response_started",
  "thinking_started",
  "thinking_end",
  "tool_started",
  "tool_end",
  "running_command",
  "checking_messages",
  "runtime_progress",
  "subagent_activity",
]);

/**
 * Output of a runtime that is already working: a tool call or a progress
 * status. Under Claude Code it keeps coming after the daemon took a `result`
 * as the turn's end; a turn the stored rows open at such a row is that work
 * going on, while one opened by a message handed over, a (re)start or a
 * recovery is not.
 */
export function isRuntimeProgressEntry(entry: TrajectoryEntry): boolean {
  if (entry.kind === "tool_start") return true;
  return entry.kind === "status" && isRuntimeProgressDetailKind(entry.detailKind);
}

/** A detail kind a working runtime's progress reports (see isRuntimeProgressEntry). */
export function isRuntimeProgressDetailKind(detailKind: AgentActivityDetailKind | undefined): boolean {
  return detailKind !== undefined && RUNTIME_PROGRESS_DETAIL_KINDS.has(detailKind);
}

/** Whether a published activity ends the turn, and how. */
export function turnOutcomeForActivity(activityKind: AgentActivityKind, detailKind: AgentActivityDetailKind | undefined): ActivityTurnOutcome | null {
  if (activityKind === "online" && detailKind === "idle") return "completed";
  if (activityKind !== "offline") return null;
  if (detailKind === "runtime_crashed" || detailKind === "claude_root_privileges" || detailKind === "runtime_unavailable") return "failed";
  return "interrupted";
}
