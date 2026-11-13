/**
 * The OAR host's per-agent session summary (#wg-ax task #3, RFC 070 §6.2 on
 * OAR): what a fresh session needs to know about what was going on lately,
 * folded from the OAR record stream and kept on disk so it survives a daemon
 * restart. OAR keeps records in memory only and a resumed session starts at
 * seq 0 with no replay, so this file is the durable copy.
 *
 * One file per agent, `<raft home>/agent-session-summaries/<agentId>.json`,
 * rewritten whole when a turn starts (its prompt accepted), at each root turn
 * end, and when the session ends. It is in
 * the daemon's own state, never the agent's workspace: a file the daemon
 * writes inside the workspace can be redirected by a symlink the agent plants
 * (Tenny, #12626 review), which a sandboxed runtime must not be able to use.
 * It is a cache for the briefing: an agent migrated to another machine starts
 * without one. Facts only:
 * - `messages` / `actions` / `files` are rolling windows across sessions,
 *   each entry tagged with its session;
 * - `context`, `turns`, `compactions` and `wake` describe the current session
 *   and reset when another one starts;
 * - no file contents (the briefing re-reads files live), no tool output except
 *   message blocks the raft CLI printed, nothing sent to the server.
 * Only the root agent of the root session is recorded: sub-agents and child
 * sessions are another context.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RawEvent, ToolOutputPart } from "@botiverse/oar";
import { isMutatingCommand, isRaftMessageReaderCommand, maskSecrets, parseMessageChunks, parseSentMessage, pathsIn, todoItems, type PanelTodoItem } from "../wakeBriefingPanel";

export const SESSION_SUMMARY_VERSION = 1;
const MAX_MESSAGES = 25;
const MAX_ACTIONS = 40;
const MAX_FILES = 14;
const MESSAGE_MAX_CHARS = 8_000;
const WAKE_MAX_CHARS = 8_000;
const NOTE_MAX_CHARS = 4_000;
/** Turn notes kept for the warm panel (RFC 070 §6.5), and todo items. */
const MAX_NOTES = 2;
const MAX_TODO_ITEMS = 50;
const TODO_ITEM_MAX_CHARS = 500;
/** Codex app-server's plan notification (`params.plan`: `{ step, status }` items). */
const CODEX_PLAN_UPDATED = "turn/plan/updated";
/** ACP's (Grok's) plan update: `session/update` with `params.update.sessionUpdate: "plan"` (`entries`: `{ content, status }`). */
const ACP_SESSION_UPDATE = "session/update";
const COMMAND_SUMMARY_MAX_CHARS = 200;

export interface SessionSummaryMessage {
  sessionId: string;
  direction: "received" | "sent";
  at: string | null;
  target: string | null;
  msgId: string | null;
  /** As rendered: a received message keeps the CLI's header line; a sent one is `[target=…] you sent: …`. */
  raw: string;
}

export interface SessionSummaryAction {
  sessionId: string;
  at: string;
  tool: string;
  /** The command, cut at 200 characters; paths are never cut and are in `paths`. */
  summary: string;
  paths: string[];
  result: "ok" | "failed" | null;
  exitCode?: number | null;
  mutating: boolean;
}

export interface SessionSummaryFile {
  sessionId: string;
  /** Absolute when the runtime named it absolute or relative to the agent's workspace. */
  path: string;
  lastAt: string;
  touches: number;
  last: "read" | "edited";
}

export interface SessionSummary {
  version: typeof SESSION_SUMMARY_VERSION;
  runtime: string;
  sessionId: string;
  updatedAt: string;
  lastActivityAt: string | null;
  /** The last context size the runtime reported; null when it reported none (the fresh-session decision then resumes). */
  context: { tokens: number; window: number | null; at: string } | null;
  turns: { count: number; lastEndedAt: string | null; lastOutcome: string | null };
  compactions: { count: number; lastAt: string | null };
  /** The input that started the session's latest turn. */
  wake: { at: string; input: string } | null;
  /** The final model text of the latest turn that had one: its own note, delivered to no one. */
  lastNote: { sessionId: string; at: string; text: string } | null;
  /**
   * The warm panel's notes (RFC 070 §6.5): the last model text of each of the
   * session's last turns that had one, a tool call after it or not, oldest
   * first. Optional: a file an older daemon wrote has none.
   */
  notes?: Array<{ sessionId: string; at: string; text: string }>;
  /** The latest todo / plan list the runtime reported (codex `turn/plan/updated`, an ACP `plan` update, a `TodoWrite` / `update_plan` call), all items in order. Optional, as `notes`. */
  todos?: { sessionId: string; at: string; items: PanelTodoItem[] } | null;
  messages: SessionSummaryMessage[];
  actions: SessionSummaryAction[];
  files: SessionSummaryFile[];
}

const MESSAGE_SEND_RE = /^\s*raft\s+message\s+send\b/;
const TASK_REPLY_RE = /^\s*raft\s+task\s+reply\s+(?:"([\w#:@.~-]+)"|'([\w#:@.~-]+)'|([\w#:@.~-]+))/;
const HEREDOC_RE = /<<-?\s*['"]?([A-Za-z_]\w*)['"]?[^\n]*\n([\s\S]*?)\n\1(?:\s|$)/;
const TARGET_FLAG_RE = /--target[=\s]+(?:"([^"]+)"|'([^']+)'|(\S+))/;
const DELIVERED_RE = /\b(?:Message sent|Reply sent)\b/;
const SENT_ID_RE = /Message ID: ([0-9a-f]{8})/;
const HEREDOC_BODY_RE = /(<<-?\s*['"]?([A-Za-z_]\w*)['"]?[^\n]*)\n[\s\S]*?\n\2(?=\s|$)/g;
const PATCH_FILE_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
const PATH_FIELDS = ["file_path", "filePath", "path", "notebook_path"] as const;
const EDIT_TOOL_RE = /edit|write|patch|create|delete|move|rename/i;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[… cut at ${max} characters]`;
}

export function emptySessionSummary(runtime: string, sessionId: string, nowMs: number): SessionSummary {
  return {
    version: SESSION_SUMMARY_VERSION,
    runtime,
    sessionId,
    updatedAt: iso(nowMs),
    lastActivityAt: null,
    context: null,
    turns: { count: 0, lastEndedAt: null, lastOutcome: null },
    compactions: { count: 0, lastAt: null },
    wake: null,
    lastNote: null,
    notes: [],
    todos: null,
    messages: [],
    actions: [],
    files: [],
  };
}

/** The summary a session starts from: the rolling windows carry over, the session's own facts reset. */
export function summaryForSession(previous: SessionSummary | null, runtime: string, sessionId: string, nowMs: number): SessionSummary {
  if (previous && previous.sessionId === sessionId) return { ...previous, runtime };
  const fresh = emptySessionSummary(runtime, sessionId, nowMs);
  if (!previous) return fresh;
  return { ...fresh, lastNote: previous.lastNote, messages: previous.messages, actions: previous.actions, files: previous.files };
}

interface ParsedToolInput {
  command: string;
  fields: Record<string, unknown> | null;
}

function parseToolInput(input: string | undefined): ParsedToolInput {
  if (!input) return { command: "", fields: null };
  try {
    const parsed: unknown = JSON.parse(input);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const fields = parsed as Record<string, unknown>;
      const command = typeof fields.command === "string"
        ? fields.command
        : Array.isArray(fields.command) && fields.command.every((part) => typeof part === "string")
          ? fields.command.join(" ")
          : typeof fields.cmd === "string" ? fields.cmd : "";
      return { command, fields };
    }
  } catch {
    // Not JSON: the runtime's own readable invocation (codex reports the command line).
  }
  return { command: input, fields: null };
}

/** File paths a tool call names: path-like fields, patch file headers, and paths inside a command. */
function toolPaths(input: string | undefined, parsed: ParsedToolInput, workingDirectory: string): string[] {
  const found = new Set<string>();
  for (const field of PATH_FIELDS) {
    const value = parsed.fields?.[field];
    if (typeof value === "string" && value) found.add(value);
  }
  for (const match of (input ?? "").matchAll(PATCH_FILE_RE)) found.add(match[1]!.trim());
  // A heredoc body is text the command carries (a message, a file's new
  // content), not files it names: the file a `cat > f <<EOF` writes is outside it.
  for (const candidate of pathsIn(parsed.command.replace(HEREDOC_BODY_RE, "$1"))) found.add(candidate);
  const paths: string[] = [];
  for (const candidate of found) {
    const lastSegment = candidate.split("/").filter(Boolean).at(-1) ?? "";
    // As the Claude panel: devices, directories and extensionless prose are not working files.
    if (candidate.startsWith("/dev/") || candidate.endsWith("/") || !lastSegment.includes(".")) continue;
    const resolved = path.isAbsolute(candidate) || candidate.startsWith("~")
      ? candidate
      : path.resolve(workingDirectory, candidate);
    if (!paths.includes(resolved)) paths.push(resolved);
  }
  return paths;
}

function outputText(content: readonly ToolOutputPart[] | undefined): string {
  if (!content) return "";
  return content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n");
}

interface OpenCall {
  tool: string;
  input: string | undefined;
  at: number;
}

/**
 * Folds one agent's OAR records into its summary. Records arrive in seq
 * order (live or replayed); `observe` ignores what it already folded, so a
 * replay after a resubscribe is harmless.
 */
export class SessionSummaryRecorder {
  private summary: SessionSummary;
  private lastSeq = -1;
  private readonly calls = new Map<string, OpenCall>();
  /** Bodies of sends the CLI held as drafts, by target, until a `--send-draft` delivers or `--discard-draft` drops them. */
  private readonly heldByTarget = new Map<string, SessionSummaryMessage>();
  private turnText: { messageId: string | null; text: string } | null = null;
  /**
   * The turn's latest text, kept past a tool call (the warm panel's note).
   * `open` until a tool call follows it: the next text starts a new one, also
   * when the runtime names no message id (ACP, Grok), so a turn's narration
   * is never glued into one note that keeps only its oldest part. Held to
   * just past the note's cut.
   */
  private turnLastText: { messageId: string | null; text: string; open: boolean } | null = null;
  /** Inputs sent to the runtime, by request id, until the runtime accepts (apply) or rejects (drop) them. */
  private readonly inputs = new Map<string, { kind: "prompt" | "steer" | "queue"; input: string; at: number }>();

  constructor(
    private readonly store: SessionSummaryStore,
    private readonly agentId: string,
    runtime: string,
    private readonly sessionId: string,
    private readonly workingDirectory: string,
    private readonly now: () => number,
  ) {
    this.summary = summaryForSession(store.read(agentId), runtime, sessionId, now());
  }

  current(): SessionSummary {
    return this.summary;
  }

  observe(record: RawEvent): void {
    if (record.seq <= this.lastSeq) return;
    this.lastSeq = record.seq;
    if (record.sessionId !== this.sessionId || record.agentPath.length > 0) return;
    this.summary.lastActivityAt = iso(record.receivedAt);
    if (record.kind === "request") {
      if (record.direction !== "toRuntime") return;
      const body = record.body;
      if (body.kind === "prompt" || body.kind === "steer" || body.kind === "queue") {
        this.inputs.set(record.id, { kind: body.kind, input: body.input, at: record.receivedAt });
      }
      return;
    }
    if (record.kind === "response") {
      const input = this.inputs.get(record.requestId);
      if (!input) return;
      this.inputs.delete(record.requestId);
      // A rejected input (busy, say) stays the host's: it is not what the session saw.
      if (record.body.kind !== "accepted") return;
      this.addReceived(input.input);
      if (input.kind === "prompt") {
        this.summary.wake = { at: iso(input.at), input: cut(input.input, WAKE_MAX_CHARS) };
        this.turnText = null;
        this.turnLastText = null;
        // On disk as the turn starts: a daemon that dies mid-turn leaves a
        // wake later than the last turn end, which reads as "a turn was
        // running", never as a cold session (Sage, #wg-ax task #3).
        this.flush();
      }
      return;
    }
    if (record.kind !== "frame") return;
    this.observePlan(record.body.native, record.receivedAt);
    for (const event of record.body.events) {
      switch (event.kind) {
        case "tool_call_started":
          this.calls.set(event.callId, { tool: event.tool, input: event.input, at: record.receivedAt });
          if (this.turnLastText) this.turnLastText.open = false;
          // Text before a tool call is narration; the note is what the turn said last.
          this.turnText = null;
          break;
        case "tool_call_input": {
          const call = this.calls.get(event.callId);
          if (call) call.input = event.input;
          break;
        }
        case "tool_call_ended": {
          const call = this.calls.get(event.callId);
          if (!call) break;
          this.calls.delete(event.callId);
          this.addAction(call, event.result ?? null, event.exitCode, outputText(event.content));
          break;
        }
        case "text_delta": {
          const messageId = event.messageId ?? null;
          if (!this.turnText || this.turnText.messageId !== messageId) this.turnText = { messageId, text: "" };
          this.turnText.text += event.text;
          if (!this.turnLastText || !this.turnLastText.open || this.turnLastText.messageId !== messageId) {
            // A new text replaces the last one only once it says something.
            if (!event.text.trim() && this.turnLastText?.text.trim()) break;
            this.turnLastText = { messageId, text: "", open: true };
          }
          if (this.turnLastText.text.length <= NOTE_MAX_CHARS) this.turnLastText.text += event.text.slice(0, NOTE_MAX_CHARS + 1 - this.turnLastText.text.length);
          break;
        }
        case "usage": {
          const context = event.usage.context;
          if (context && typeof context.tokens === "number" && context.tokens > 0) {
            this.summary.context = { tokens: context.tokens, window: context.contextWindow ?? null, at: iso(record.receivedAt) };
          }
          break;
        }
        case "compaction_ended":
          this.summary.compactions = { count: this.summary.compactions.count + 1, lastAt: iso(record.receivedAt) };
          // The size before the compaction no longer holds; the next usage report says the new one.
          this.summary.context = null;
          break;
        case "turn_ended": {
          const at = iso(record.receivedAt);
          this.summary.turns = { count: this.summary.turns.count + 1, lastEndedAt: at, lastOutcome: event.outcome.kind };
          const note = this.turnText?.text.trim();
          if (note) this.summary.lastNote = { sessionId: this.sessionId, at, text: cut(note, NOTE_MAX_CHARS) };
          const last = this.turnLastText?.text.trim();
          if (last) this.summary.notes = [...(this.summary.notes ?? []), { sessionId: this.sessionId, at, text: cut(maskSecrets(last), NOTE_MAX_CHARS) }].slice(-MAX_NOTES);
          this.turnText = null;
          this.turnLastText = null;
          this.flush();
          break;
        }
        default:
          break;
      }
    }
  }

  /** Rewrite the file now (turn end, session end). A failed write never reaches the session. */
  flush(): void {
    this.summary.updatedAt = iso(this.now());
    this.store.write(this.agentId, this.summary);
  }

  private addReceived(text: string): void {
    if (!text.includes("[target=")) return;
    for (const message of parseMessageChunks(text)) {
      this.pushMessage({
        sessionId: this.sessionId,
        direction: "received",
        at: message.ts,
        target: /^\[target=(\S+)/.exec(message.raw)?.[1] ?? null,
        msgId: message.msgId,
        raw: cut(message.raw, MESSAGE_MAX_CHARS),
      });
    }
  }

  private addAction(call: OpenCall, result: "ok" | "failed" | null, exitCode: number | null | undefined, output: string): void {
    const parsed = parseToolInput(call.input);
    const paths = toolPaths(call.input, parsed, this.workingDirectory);
    const command = parsed.command.trim();
    const mutating = EDIT_TOOL_RE.test(call.tool) || (command ? isMutatingCommand(command) : false);
    const at = iso(call.at);
    const summary = maskSecrets(command || (parsed.fields ? "" : (call.input ?? "").trim()));
    this.summary.actions = [...this.summary.actions, {
      sessionId: this.sessionId,
      at,
      tool: call.tool,
      summary: summary.length > COMMAND_SUMMARY_MAX_CHARS ? `${summary.slice(0, COMMAND_SUMMARY_MAX_CHARS)}…` : summary,
      paths,
      result,
      ...(exitCode !== undefined ? { exitCode } : {}),
      mutating,
    }].slice(-MAX_ACTIONS);
    for (const filePath of paths) this.touchFile(filePath, at, mutating);
    // A todo tool's whole list (claude-style `TodoWrite`, an `update_plan` call): the latest replaces the last.
    if (parsed.fields && (call.tool === "TodoWrite" || /^update_plan$/i.test(call.tool)) && result !== "failed") {
      this.setTodos(parsed.fields.todos ?? parsed.fields.plan, at);
    }
    if (command) this.observeRaftCommand(command, output, at);
  }

  /** A plan the runtime reported as a notification: Codex `turn/plan/updated`, ACP `session/update` `plan` (Grok). */
  private observePlan(native: unknown, receivedAt: number): void {
    if (!native || typeof native !== "object") return;
    const frame = native as Record<string, unknown>;
    const params = frame.params && typeof frame.params === "object" ? frame.params as Record<string, unknown> : null;
    if (!params) return;
    if (frame.method === CODEX_PLAN_UPDATED) {
      this.setTodos(params.plan, iso(receivedAt));
      return;
    }
    const update = params.update && typeof params.update === "object" ? params.update as Record<string, unknown> : null;
    if (frame.method === ACP_SESSION_UPDATE && update?.sessionUpdate === "plan") this.setTodos(update.entries, iso(receivedAt));
  }

  private setTodos(value: unknown, at: string): void {
    const items = todoItems(value);
    if (!items) return;
    this.summary.todos = {
      sessionId: this.sessionId,
      at,
      items: items.slice(0, MAX_TODO_ITEMS).map((item) => ({ text: cut(maskSecrets(item.text), TODO_ITEM_MAX_CHARS), status: item.status })),
    };
  }

  private touchFile(filePath: string, at: string, mutating: boolean): void {
    const existing = this.summary.files.find((file) => file.path === filePath);
    const rest = this.summary.files.filter((file) => file.path !== filePath);
    const file: SessionSummaryFile = {
      sessionId: this.sessionId,
      path: filePath,
      lastAt: at,
      touches: (existing?.touches ?? 0) + 1,
      last: mutating ? "edited" : "read",
    };
    this.summary.files = [...rest, file].slice(-MAX_FILES);
  }

  private observeRaftCommand(command: string, output: string, at: string): void {
    if (isRaftMessageReaderCommand(command)) {
      if (output.includes("[target=")) this.addReceived(output);
      return;
    }
    const send = this.sentMessage(command, at);
    if (!send) return;
    if (/--discard-draft\b/.test(command)) {
      if (send.target) this.heldByTarget.delete(send.target);
      return;
    }
    const delivered = DELIVERED_RE.test(output);
    const msgId = SENT_ID_RE.exec(output)?.[1] ?? null;
    if (send.message) {
      if (delivered) this.pushMessage({ ...send.message, msgId });
      else if (send.target) this.heldByTarget.set(send.target, send.message);
      return;
    }
    // A bodyless resend (`--send-draft`): the body came with the held attempt to the same target.
    if (delivered && send.target) {
      const held = this.heldByTarget.get(send.target);
      if (held) {
        this.heldByTarget.delete(send.target);
        this.pushMessage({ ...held, at, msgId });
      }
    }
  }

  private sentMessage(command: string, at: string): { target: string | null; message: SessionSummaryMessage | null } | null {
    if (MESSAGE_SEND_RE.test(command)) {
      const flag = TARGET_FLAG_RE.exec(command);
      const target = flag ? flag[1] ?? flag[2] ?? flag[3] ?? null : null;
      const parsed = parseSentMessage(command, at);
      return {
        target,
        message: parsed ? { sessionId: this.sessionId, direction: "sent", at, target, msgId: null, raw: cut(parsed.raw, MESSAGE_MAX_CHARS) } : null,
      };
    }
    const reply = TASK_REPLY_RE.exec(command);
    if (!reply) return null;
    const target = reply[1] ?? reply[2] ?? reply[3] ?? null;
    if (!target) return null;
    // The CLI reads a reply's body from stdin only: the heredoc is the body, never a quoted flag value.
    const body = HEREDOC_RE.exec(command)?.[2]?.trim();
    // Rendered as a send to the ref is (the ref's characters are plain), so both read the same.
    const parsed = body ? parseSentMessage(`raft message send --target "${target}" <<'RAFTBODY'\n${body}\nRAFTBODY`, at) : null;
    return {
      target,
      message: parsed
        ? { sessionId: this.sessionId, direction: "sent", at, target, msgId: null, raw: cut(parsed.raw, MESSAGE_MAX_CHARS) }
        : null,
    };
  }

  private pushMessage(message: SessionSummaryMessage): void {
    const key = (entry: SessionSummaryMessage) => entry.msgId ?? `${entry.direction}|${entry.raw.slice(0, 100)}`;
    const rest = this.summary.messages.filter((entry) => key(entry) !== key(message));
    this.summary.messages = [...rest, message].slice(-MAX_MESSAGES);
  }
}

const isString = (value: unknown): value is string => typeof value === "string";
const isNullableString = (value: unknown): value is string | null => value === null || typeof value === "string";
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function validMessage(value: unknown): value is SessionSummaryMessage {
  return isRecord(value) && isString(value.sessionId) && (value.direction === "received" || value.direction === "sent")
    && isNullableString(value.at) && isNullableString(value.target) && isNullableString(value.msgId) && isString(value.raw);
}

function validAction(value: unknown): value is SessionSummaryAction {
  return isRecord(value) && isString(value.sessionId) && isString(value.at) && isString(value.tool) && isString(value.summary)
    && Array.isArray(value.paths) && value.paths.every(isString)
    && (value.result === "ok" || value.result === "failed" || value.result === null) && typeof value.mutating === "boolean";
}

function validFile(value: unknown): value is SessionSummaryFile {
  return isRecord(value) && isString(value.sessionId) && isString(value.path) && isString(value.lastAt) && isCount(value.touches)
    && (value.last === "read" || value.last === "edited");
}

/**
 * A field that is not what this version writes (an older or newer daemon, a
 * hand edit) is dropped (an entry) or reset (a section), never trusted.
 */
export function sessionSummaryFromJson(value: unknown): SessionSummary | null {
  if (!isRecord(value) || value.version !== SESSION_SUMMARY_VERSION || !isString(value.sessionId) || !isString(value.runtime)) return null;
  const context = isRecord(value.context) && typeof value.context.tokens === "number" && value.context.tokens > 0 && isString(value.context.at)
    ? { tokens: value.context.tokens, window: typeof value.context.window === "number" ? value.context.window : null, at: value.context.at }
    : null;
  const turns = isRecord(value.turns) && isCount(value.turns.count)
    ? { count: value.turns.count, lastEndedAt: isNullableString(value.turns.lastEndedAt) ? value.turns.lastEndedAt : null, lastOutcome: isNullableString(value.turns.lastOutcome) ? value.turns.lastOutcome : null }
    : { count: 0, lastEndedAt: null, lastOutcome: null };
  const compactions = isRecord(value.compactions) && isCount(value.compactions.count)
    ? { count: value.compactions.count, lastAt: isNullableString(value.compactions.lastAt) ? value.compactions.lastAt : null }
    : { count: 0, lastAt: null };
  const wake = isRecord(value.wake) && isString(value.wake.at) && isString(value.wake.input) ? { at: value.wake.at, input: value.wake.input } : null;
  const lastNote = isRecord(value.lastNote) && isString(value.lastNote.sessionId) && isString(value.lastNote.at) && isString(value.lastNote.text)
    ? { sessionId: value.lastNote.sessionId, at: value.lastNote.at, text: value.lastNote.text }
    : null;
  const notes = Array.isArray(value.notes)
    ? value.notes.filter((note): note is { sessionId: string; at: string; text: string } =>
      isRecord(note) && isString(note.sessionId) && isString(note.at) && isString(note.text)).slice(-MAX_NOTES)
    : [];
  const todos = isRecord(value.todos) && isString(value.todos.sessionId) && isString(value.todos.at) && Array.isArray(value.todos.items)
    ? {
      sessionId: value.todos.sessionId,
      at: value.todos.at,
      items: value.todos.items.filter((item): item is PanelTodoItem => isRecord(item) && isString(item.text) && isString(item.status)).slice(0, MAX_TODO_ITEMS),
    }
    : null;
  return {
    version: SESSION_SUMMARY_VERSION,
    runtime: value.runtime,
    sessionId: value.sessionId,
    updatedAt: isString(value.updatedAt) ? value.updatedAt : new Date(0).toISOString(),
    lastActivityAt: isNullableString(value.lastActivityAt) ? value.lastActivityAt : null,
    context,
    turns,
    compactions,
    wake,
    lastNote,
    notes,
    todos,
    messages: (Array.isArray(value.messages) ? value.messages.filter(validMessage) : []).slice(-MAX_MESSAGES),
    actions: (Array.isArray(value.actions) ? value.actions.filter(validAction) : []).slice(-MAX_ACTIONS),
    files: (Array.isArray(value.files) ? value.files.filter(validFile) : []).slice(-MAX_FILES),
  };
}

/** The directory for the summaries, in the daemon's state under the Raft home. */
export function sessionSummaryDir(raftHome: string): string {
  return path.join(raftHome, "agent-session-summaries");
}

/** Reads and writes `<dir>/<agentId>.json` (a fresh temp file, then rename). */
export class SessionSummaryStore {
  constructor(private readonly dir: string, private readonly onError: (agentId: string, error: unknown) => void = () => {}) {}

  filePath(agentId: string): string {
    return path.join(this.dir, `${encodeURIComponent(agentId)}.json`);
  }

  read(agentId: string): SessionSummary | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath(agentId), "utf8"));
    } catch {
      return null;
    }
    return sessionSummaryFromJson(parsed);
  }

  write(agentId: string, summary: SessionSummary): void {
    const file = this.filePath(agentId);
    try {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      // A name nobody can guess, created exclusively: never written through an existing path.
      const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        writeFileSync(temp, `${JSON.stringify(summary)}\n`, { mode: 0o600, flag: "wx" });
        renameSync(temp, file);
      } catch (error) {
        rmSync(temp, { force: true });
        throw error;
      }
    } catch (error) {
      this.onError(agentId, error);
    }
  }
}
