import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { AxSurfaceText } from "@botiverse/raft-shared";
import { AGENT_BODY_CONTINUATION_PREFIX, foldAgentOneLineText, indentAgentBodyContinuationLines } from "@botiverse/raft-shared";
import { axSurface } from "./agentRuntimeInput";
import type { SessionSummary } from "./agentHost/oarSessionSummary";

/**
 * RFC 070 constructed wake panel (the "v3" arm from §9): built at recycle
 * time from the retired session's transcript tail plus live re-reads of the
 * objects still on disk. The transcript is used as the ACTION LOG (what was
 * tried, what failed), never replayed verbatim; file contents are re-read
 * from the world when possible so the panel shows current state, and content
 * that could not be re-read is labeled with when it was last observed.
 *
 * Evaluation note (2026-09-12): the original offline metrics (entity recall,
 * open-loop retention) and the live jury rubric rewarded prior-work
 * orientation and are superseded. The standard now is behavioral equivalence
 * with real full-context continuations at idle boundaries — in 1,301 such
 * continuations: ~8% opened with a ritual, ~20% touched a prior unresolved
 * failure early, ~8% redid a succeeded command. A construction is good when
 * an agent given it behaves like that distribution, message-first.
 */

const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;
const DEFAULT_PANEL_BUDGET_TOKENS = 8_000;
const OBJECT_CONTENT_CAP_TOKENS = 700;
const RECENT_ACTIONS = 12;
const REREAD_FILE_MAX_BYTES = 64 * 1024;
const RECENT_MESSAGES_DEFAULT = 25;
const MESSAGE_MAX_TOKENS = 2_000;
const MESSAGES_SECTION_CAP_TOKENS = 4_000;
/** Messages are cheap to scan (line grep, no JSON semantics needed beyond
 * chunking), so their harvest window is deeper than the action window. */
const MESSAGE_SCAN_TAIL_BYTES = 16 * 1024 * 1024;
const STALE_OBJECT_BODY_CAP_TOKENS = 300;
/** The summary keeps up to 4,000 characters of the last note. */
const LAST_NOTE_CAP_TOKENS = 1_000;
/** Objects last touched longer ago than this before the session's final
 * action are "out of play": they render as bare pointers with no body. In a
 * real full context, hours-old work is diluted across hundreds of thousands
 * of tokens; a 10k panel concentrates it, so an old note's "Next step:" line
 * gains salience it never had and reads as a live agenda (the R1 bench's
 * dominant misdirection). */
const OBJECT_IN_PLAY_WINDOW_MS = 2 * 3_600_000;
/** Fallback in-play gate (by action index) for transcripts without usable
 * timestamps. */
const OBJECT_IN_PLAY_ACTIONS = 40;
const MAX_PANEL_OBJECTS = 14;

/**
 * RFC 070 §6.5, warm path only. A warm stop cuts a session mid-work, so the
 * panel carries more of the agent's own working state than a cold one: its
 * last notes (the last assistant text of each of its last turns), its open
 * todo list, and a longer action tail. All mechanical, all bounded.
 */
export const WARM_RECENT_ACTIONS = 30;
/** How many turns' last notes the warm panel shows. */
export const WARM_NOTES_MAX = 2;
/** Each note is cut at this many characters (~750 tokens), with a marker. */
export const WARM_NOTE_MAX_CHARS = 3_000;
/** Open todo items shown, and each item's length. */
export const WARM_TODOS_MAX = 20;
export const WARM_TODO_ITEM_MAX_CHARS = 200;
/** One warm action line is cut at this length. */
const WARM_ACTION_LINE_MAX_CHARS = 240;
/** The warm panel's messages section is capped lower than the cold one's (4,000), leaving room for the additions. */
const WARM_MESSAGES_SECTION_CAP_TOKENS = 2_500;
/** The objects in play keep at least this much of a warm panel (a quarter of a smaller budget). */
const WARM_OBJECTS_FLOOR_TOKENS = 1_500;
/** A lone note that must give way is first cut to this length. */
const WARM_NOTE_SHRUNK_CHARS = 1_000;

/** Token-shaped values an agent may type into a command or a note; masked in
 * the OAR summary's action summaries and in the warm panel's own additions. */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // A PEM private key block, whole, or to the end of a cut text only when key
  // material follows the BEGIN line (a bare mention, e.g. in a grep, stays).
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----|\s*\n[A-Za-z0-9+/=]{16,}[\s\S]*$)/g, "[private key]"],
  // AWS access key ids; JWTs (three base64url parts, the first a JSON header).
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "***"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "***"],
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]{12,}/g, "$1***"],
  [/\b((?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abpr])[-_][A-Za-z0-9_-]{12,})/g, "***"],
  [/((?:token|api[_-]?key|secret|password|passwd)\s*[=:]\s*)[^\s&'"]{6,}/gi, "$1***"],
];

/** Mask token-shaped values (shared with the OAR host's session summary). */
export function maskSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((masked, [pattern, replacement]) => masked.replace(pattern, replacement), text);
}

/** Never inject these files' contents into a constructed panel, from either
 * source (live re-read or transcript residue): a workspace routinely holds
 * credentials the retired session read legitimately in place. */
const SENSITIVE_PATH_RE = /(secret|credential|password|token|\.key$|\.pem$)/i;

const FAIL_RE = /(exit code [1-9]|error|Error|ERROR|not found|No such file|failed|Failed|Traceback|refus)/;
const MUTATING_RE = new RegExp(
  "(^|[;&|]\\s*)(rm|mv|cp|mkdir|touch|sed\\s+-i|tee|git\\s+(commit|add|checkout|stash|reset|push)|"
  + "npm\\s+(i|install|run)|pnpm\\s+(i|install|add|run)|pip\\s+install|docker\\s+(run|rm|build)|"
  + "cargo\\s+|make\\b|chmod|ln\\s|raft\\s+(message\\s+send|task\\s+(claim|create|update|done)))|>>?\\s*\\S",
);

/** Whether a shell command changes state (files, installs, raft writes); shared with the OAR host's session summary. */
export function isMutatingCommand(command: string): boolean {
  return MUTATING_RE.test(command);
}

export interface TranscriptAction {
  i: number;
  tool: string;
  input: Record<string, unknown>;
  result: string;
  ok: boolean;
  mutating: boolean;
  ts: string | null;
}

function tokens(text: string): number {
  return Math.max(1, Math.floor((text.length + 3) / 4));
}

function elide(text: string, limit: number): string {
  const flat = foldAgentOneLineText(text || "");
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, Math.max(0, limit - 1))}…`;
}

/** The panel's own section tags: a quoted body may not close one. */
const PANEL_CLOSING_TAG_RE = /<\/(objects-in-play|object|recent-messages|recent-actions|last-notes|last-note|turn-note|open-todos)\b/gi;
/** A line that opens or closes one of the wake panel's sections (or the memory block's). */
const PANEL_SECTION_TAG_LINE_RE = /^<\/?(?:objects-in-play|object|recent-messages|recent-actions|last-notes|last-note|turn-note|open-todos|memory-index)\b/;

/**
 * An object's content as the panel shows it. It may come from anywhere (an
 * uploaded attachment, a fetched page, a repository file), so every line is
 * quoted like a message body, the first one too, and the panel's closing tags
 * in it are escaped: a file can neither end the block nor start a line that
 * reads as the panel's own, or as a received message's header.
 */
function quotePanelObjectBody(body: string): string {
  return `${AGENT_BODY_CONTINUATION_PREFIX}${indentAgentBodyContinuationLines(body.replace(PANEL_CLOSING_TAG_RE, "&lt;/$1"))}`;
}

/** An object's name inside an attribute: one line, quotes and ampersands escaped. */
function panelAttribute(value: string): string {
  return foldAgentOneLineText(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function callForm(action: TranscriptAction, valueWidth = 44): string {
  const parts = Object.entries(action.input)
    .filter(([key]) => key !== "description")
    .map(([key, value]) => `${key}=${elide(typeof value === "string" ? value : JSON.stringify(value ?? ""), valueWidth)}`);
  return `${action.tool}(${parts.join(" ")})`;
}

/** The raft CLI's display clock ("YYYY-MM-DD HH:MM:SSZ"). Every timestamp
 * the panel renders itself uses this one format, so action lines, sent lines
 * and received messages cross-reference without translation. */
function cliClock(ts: string | null): string | null {
  if (!ts || !Number.isFinite(Date.parse(ts))) return null;
  return new Date(ts).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function actionLine(action: TranscriptAction): string {
  const mark = !action.ok ? " !" : action.mutating ? " *" : "  ";
  const result = action.result ? ` → ${elide(action.result, 60)}` : "";
  // Dated in the same clock as the messages section: undated action lines
  // left a judge unable to tell which daily-maintenance cycle was current
  // (R2 bench, b0), and a second format would reintroduce the clock-style
  // mismatch fixed in R3.
  const when = cliClock(action.ts);
  return `s${String(action.i).padEnd(5)}${mark} ${when ? `${when} ` : ""}${callForm(action)}${result}`;
}

/** Read the transcript tail as JSONL lines (partial first record dropped). */
async function readTranscriptTailLines(
  transcriptPath: string,
  tailBytes: number,
): Promise<string[] | null> {
  let text: string;
  let droppedHead = false;
  try {
    const info = await stat(transcriptPath);
    const readStart = Math.max(0, info.size - tailBytes);
    droppedHead = readStart > 0;
    const fd = await open(transcriptPath, "r");
    try {
      const buffer = Buffer.alloc(info.size - readStart);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const result = await fd.read(buffer, bytesRead, buffer.length - bytesRead, readStart + bytesRead);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      text = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await fd.close();
    }
  } catch {
    return null;
  }
  const lines = text.split("\n");
  if (droppedHead) lines.shift(); // partial first record in a mid-file window
  return lines;
}

/** Parse the transcript tail into ordered tool actions (call + result). */
export async function parseTranscriptActions(
  transcriptPath: string,
  tailBytes: number = TRANSCRIPT_TAIL_BYTES,
): Promise<TranscriptAction[]> {
  const lines = await readTranscriptTailLines(transcriptPath, tailBytes);
  if (lines === null) return [];

  const calls = new Map<string, { tool: string; input: Record<string, unknown>; ts: string | null }>();
  const results = new Map<string, { text: string; isError: boolean }>();
  const order: string[] = [];
  for (const line of lines) {
    if (!line) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const message = record.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    if (record.type === "assistant") {
      for (const block of content) {
        if (block && typeof block === "object" && (block as Record<string, unknown>).type === "tool_use") {
          const b = block as Record<string, unknown>;
          const id = typeof b.id === "string" ? b.id : null;
          if (!id) continue;
          calls.set(id, {
            tool: typeof b.name === "string" ? b.name : "?",
            input: (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, unknown>,
            ts: typeof record.timestamp === "string" ? record.timestamp : null,
          });
          order.push(id);
        }
      }
    } else if (record.type === "user") {
      for (const block of content) {
        if (block && typeof block === "object" && (block as Record<string, unknown>).type === "tool_result") {
          const b = block as Record<string, unknown>;
          const id = typeof b.tool_use_id === "string" ? b.tool_use_id : null;
          if (!id) continue;
          const value = b.content;
          const resultText = typeof value === "string"
            ? value
            : Array.isArray(value)
              ? value.map((x) => (x && typeof x === "object" ? String((x as Record<string, unknown>).text ?? "") : "")).join(" ")
              : "";
          results.set(id, { text: resultText, isError: b.is_error === true });
        }
      }
    }
  }

  const actions: TranscriptAction[] = [];
  order.forEach((id, index) => {
    const call = calls.get(id);
    if (!call) return;
    const result = results.get(id) ?? { text: "", isError: false };
    const command = typeof call.input.command === "string" ? call.input.command : "";
    actions.push({
      i: index,
      tool: call.tool,
      input: call.input,
      result: result.text,
      ok: !(result.isError || FAIL_RE.test(result.text.slice(0, 400))),
      mutating: call.tool === "Edit" || call.tool === "Write" || MUTATING_RE.test(command),
      ts: call.ts,
    });
  });
  return actions;
}

/** The agent's own last assistant text of one turn (warm panel, §6.5). */
export interface PanelNote {
  at: string | null;
  text: string;
}

export interface PanelTodoItem {
  text: string;
  /** Normalized: `pending`, `in_progress`, `completed`, or the runtime's own word. */
  status: string;
}

/** The agent's latest todo / plan list (warm panel, §6.5): open items only, and how many there were in all. */
export interface PanelTodos {
  at: string | null;
  open: PanelTodoItem[];
  total: number;
}

const CLOSED_TODO_STATUSES = new Set(["completed", "complete", "done", "deleted", "cancelled", "canceled"]);

/** `inProgress` / `in-progress` / `IN_PROGRESS` all read `in_progress`. */
export function normalizeTodoStatus(status: unknown): string {
  if (typeof status !== "string" || !status.trim()) return "pending";
  return status.trim().replace(/([a-z])([A-Z])/g, "$1_$2").replace(/[-\s]+/g, "_").toLowerCase();
}

/**
 * A todo / plan list from its items (any of `content`, `text`, `step`,
 * `subject`, `title` names an item; `status` its state): open items kept in
 * list order. Null when nothing in it is an item.
 */
export function todosFromItems(items: unknown, at: string | null): PanelTodos | null {
  const all = todoItems(items);
  return all ? openTodos(all, at) : null;
}

/** A list's items in order (see `todosFromItems`); null when the value is not a list of items. */
export function todoItems(items: unknown): PanelTodoItem[] | null {
  if (!Array.isArray(items)) return null;
  const all: PanelTodoItem[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const text = [record.content, record.text, record.step, record.subject, record.title].find((value) => typeof value === "string" && value.trim());
    if (typeof text !== "string") continue;
    all.push({ text: text.trim(), status: normalizeTodoStatus(record.status) });
  }
  return all.length > 0 || items.length === 0 ? all : null;
}

/** The open items of a whole list. */
export function openTodos(all: readonly PanelTodoItem[], at: string | null): PanelTodos {
  return { at, open: all.filter((item) => !CLOSED_TODO_STATUSES.has(item.status)), total: all.length };
}

const TASK_CREATED_RE = /\bTask #?([\w-]+) created\b/;

/**
 * The warm panel's working state from a Claude transcript tail (§6.5): the
 * last assistant text of each of the last turns, and the latest todo list
 * (TodoWrite's whole list, or the TaskCreate / TaskUpdate tools' tasks,
 * whichever changed last). Notes are of the last 2 turns that had text: a
 * turn ends where the agent's own text was the last thing in the session and
 * a user prompt follows it (or at an interrupt). A prompt that lands while the
 * turn is still running (after a tool call or its result: a message the
 * daemon wrote into a busy turn, a steer) continues that turn. Sub-agent
 * (sidechain), meta and compact-summary records are not the agent's own and
 * are skipped.
 */
export async function collectClaudeWorkingState(
  transcriptPath: string,
  tailBytes: number = TRANSCRIPT_TAIL_BYTES,
): Promise<{ notes: PanelNote[]; todos: PanelTodos | null }> {
  const lines = await readTranscriptTailLines(transcriptPath, tailBytes);
  if (lines === null) return { notes: [], todos: null };
  const notes: PanelNote[] = [];
  // The turn's latest text; `open` until a tool call follows it.
  const turn: { note: (PanelNote & { messageId: string | null; open: boolean }) | null } = { note: null };
  const endTurn = () => {
    if (turn.note && turn.note.text.trim()) notes.push({ at: turn.note.at, text: turn.note.text.trim() });
    turn.note = null;
  };
  let todoWrite: { order: number; todos: PanelTodos | null } | null = null;
  const tasks = new Map<string, PanelTodoItem>();
  let tasksOrder = -1;
  let tasksAt: string | null = null;
  const pendingCreates = new Map<string, { subject: string; status: string }>();
  // What the main chain said last: a prompt ends the turn only after the agent's own text.
  let lastSaid: "assistant_text" | "assistant_tool" | "tool_result" | "prompt" | null = null;
  const prompt = (text: string) => {
    if (/^\s*\[Request interrupted/.test(text)) {
      endTurn();
      lastSaid = null;
      return;
    }
    if (lastSaid === null || lastSaid === "assistant_text") endTurn();
    lastSaid = "prompt";
  };
  let order = 0;
  for (const line of lines) {
    if (!line) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record.isSidechain === true || record.isCompactSummary === true || record.isMeta === true) continue;
    order += 1;
    const ts = typeof record.timestamp === "string" ? record.timestamp : null;
    const message = record.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (record.type === "user") {
      if (typeof content === "string") {
        if (content.trim()) prompt(content);
        continue;
      }
      if (!Array.isArray(content)) continue;
      let toolResult = false;
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type !== "tool_result") continue;
        toolResult = true;
        const id = typeof b.tool_use_id === "string" ? b.tool_use_id : null;
        const create = id ? pendingCreates.get(id) : undefined;
        if (!id || !create) continue;
        pendingCreates.delete(id);
        const value = b.content;
        const text = typeof value === "string"
          ? value
          : Array.isArray(value) ? value.map((x) => (x && typeof x === "object" ? String((x as Record<string, unknown>).text ?? "") : "")).join(" ") : "";
        const taskId = TASK_CREATED_RE.exec(text)?.[1];
        if (!taskId || b.is_error === true) continue;
        tasks.set(taskId, { text: create.subject, status: create.status });
        tasksOrder = order;
        tasksAt = ts;
      }
      if (toolResult) {
        lastSaid = "tool_result";
        continue;
      }
      const promptText = content
        .map((block) => (block && typeof block === "object" && (block as Record<string, unknown>).type === "text" ? String((block as Record<string, unknown>).text ?? "") : ""))
        .join("\n");
      if (promptText.trim()) prompt(promptText);
      continue;
    }
    if (record.type !== "assistant" || !Array.isArray(content)) continue;
    const messageId = typeof message?.id === "string" ? message.id : null;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        // Claude Code writes one record per content block: consecutive text
        // blocks of one assistant message are one text.
        const current = turn.note;
        if (current && current.open && messageId !== null && current.messageId === messageId) current.text += `\n\n${b.text}`;
        else turn.note = { at: ts, text: b.text, messageId, open: true };
        lastSaid = "assistant_text";
      } else if (b.type === "tool_use") {
        if (turn.note) turn.note.open = false;
        lastSaid = "assistant_tool";
        const input = (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, unknown>;
        const id = typeof b.id === "string" ? b.id : null;
        if (b.name === "TodoWrite") {
          todoWrite = { order, todos: todosFromItems(input.todos, ts) };
        } else if (b.name === "TaskCreate" && id && typeof input.subject === "string") {
          pendingCreates.set(id, { subject: input.subject, status: normalizeTodoStatus(input.status) });
        } else if (b.name === "TaskUpdate" && (typeof input.taskId === "string" || typeof input.taskId === "number")) {
          const taskId = String(input.taskId);
          const existing = tasks.get(taskId);
          const status = input.status === undefined ? existing?.status ?? "pending" : normalizeTodoStatus(input.status);
          // A task this tail never saw created (its create is older) changes
          // nothing known, so it never hides a newer TodoWrite list.
          let changed = false;
          if (status === "deleted") changed = tasks.delete(taskId);
          else if (existing || typeof input.subject === "string") {
            tasks.set(taskId, { text: typeof input.subject === "string" ? input.subject : existing!.text, status });
            changed = true;
          }
          if (changed) {
            tasksOrder = order;
            tasksAt = ts;
          }
        }
      }
    }
  }
  endTurn();
  let todos: PanelTodos | null = null;
  if (todoWrite && todoWrite.order > tasksOrder) todos = todoWrite.todos;
  else if (tasksOrder >= 0) {
    todos = tasks.size > 0 ? openTodos([...tasks.values()], tasksAt) : null;
  }
  return { notes: notes.slice(-WARM_NOTES_MAX), todos };
}

/** One message the retired session saw or sent. Received messages keep the
 * raft CLI's own display rendering VERBATIM (`[target=… msg=… time=…] @… : …`)
 * — the format agents already read every day — so the panel splices rather
 * than re-renders. Only sent messages are synthesized (the transcript holds
 * the send command, not a display form). */
export interface PanelMessage {
  /** The display text, ready to splice into the panel. */
  raw: string;
  /** `msg=` id when present; dedupe key. */
  msgId: string | null;
  /** Parsed `time=` attribute (or send timestamp); sort key. */
  ts: string | null;
  self: boolean;
}

const SEND_COMMAND_RE = /\braft\s+message\s+send\b/;
/**
 * The one command whose output lists received messages as `[target=…]`
 * lines: `raft message check`, run on its own (a trailing `2>&1` allowed).
 * Any other tool output (a file, a web page, another program, a pipeline
 * around the CLI) is never read for messages: a line in it can look like a
 * header without being one.
 */
const MESSAGE_CHECK_COMMAND_RE = /^\s*raft\s+message\s+check(?:\s+--?[\w-]+(?:[ =][\w"'#:@.-]+)?)*\s*(?:2>&1\s*)?$/;
/**
 * The same rule for the OAR host's session summary, which also reads
 * `raft message read` and `raft task read` (a task ref as the one positional
 * argument): one line, plain flags and refs only, no `$`, backtick, quote
 * nesting, `;`, `|`, `&` or newline, so nothing else can print into the output.
 */
const RAFT_MESSAGE_READER_COMMAND_RE = /^[ \t]*raft[ \t]+(?:message[ \t]+(?:check|read)|task[ \t]+read)(?:[ \t]+(?:--?[\w-]+(?:[ =](?:"[\w#:@.~ -]+"|'[\w#:@.~ -]+'|[\w#:@.~-]+))?|"[\w#:@.~-]+"|'[\w#:@.~-]+'|[\w#:@.~-]+))*[ \t]*(?:2>&1[ \t]*)?$/;

/** Whether a command's whole output is a raft CLI listing of received messages. */
export function isRaftMessageReaderCommand(command: string): boolean {
  return RAFT_MESSAGE_READER_COMMAND_RE.test(command);
}
/**
 * A received message's header exactly as the CLI and the daemon print it:
 * `[target=… msg=<8 hex> time=YYYY-MM-DD HH:MM:SSZ type=<sender kind>`, then
 * optional attributes, then `] `. A line that starts like a header but isn't
 * one is not a message.
 */
const MESSAGE_HEADER_RE = /^\[target=\S+ msg=[0-9a-f]{8} time=\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z type=(?:human|agent|system|third_party_app)(?: [^\]\n]*)?\] /;
const MSG_ATTR_RE = /\bmsg=([\w-]+)/;
const TIME_ATTR_RE = /\btime=([0-9T:\- ]+Z?)/;
/** Ephemeral system chrome: reminder firings and catch-up notices describe a
 * past MOMENT, not durable conversation — a stale copy near the bottom of the
 * scrollback reads as a live obligation (top misdirection in the gold bench).
 * Informative system messages (task assignments etc.) stay. */
const EPHEMERAL_SYSTEM_RE = /@system[^\n]*(reminder|Next iteration|catch-?up)|^\[system reminder/im;

/** Split a block of text into per-message chunks at `[target=` line starts,
 * keeping each chunk's text verbatim (continuation lines included). */
export function parseMessageChunks(text: string): PanelMessage[] {
  const out: PanelMessage[] = [];
  let current: string[] | null = null;
  const finalize = () => {
    if (!current) return;
    let raw = current.join("\n").replace(/\s*No more new (?:inbox )?messages\.\s*$/, "").trimEnd();
    if (raw.length > 0
      && !/@system[^\n]*stopped following this thread/.test(raw)
      && !EPHEMERAL_SYSTEM_RE.test(raw)) {
      out.push({
        raw,
        msgId: MSG_ATTR_RE.exec(current[0]!)?.[1] ?? null,
        ts: TIME_ATTR_RE.exec(current[0]!)?.[1]?.trim() ?? null,
        self: false,
      });
    }
    current = null;
  };
  for (const line of text.split("\n")) {
    if (MESSAGE_HEADER_RE.test(line)) {
      finalize();
      current = [line];
    } else if (line.startsWith("[target=")) {
      // Looks like a header but isn't one: it ends the chunk, and starts none.
      finalize();
    } else if (PANEL_SECTION_TAG_LINE_RE.test(line)) {
      // One of the wake panel's own tags (a fresh session's first input
      // carries the panel, and the OAR session summary reads that input): it
      // ends the chunk, so a tag never rides along as message text.
      finalize();
    } else if (/^No more new (?:inbox )?messages\.?$/.test(line.trim())) {
      // CLI end-of-listing trailer: closes the chunk so that whatever the
      // surrounding tool output prints next (progress notes, echo debris)
      // is never absorbed as message continuation lines.
      finalize();
    } else if (current && current.length < 80 && line.trim().length > 0) {
      current.push(line);
    } else if (current) {
      finalize();
    }
  }
  finalize();
  return out;
}

/** Extract the sent body from a `raft message send` command string: heredoc
 * first (the CLI guide recommends it; the delimiter line may carry a trailing
 * pipeline, `<<'SLOCKMSG' 2>&1 | tail -8`), then the longest quoted argument.
 * Returns null when the command carries no body at all (e.g. a bare
 * `--send-draft` resend, whose body lives in the guard-blocked attempt). */
export function parseSentMessage(command: string, ts: string | null): PanelMessage | null {
  const target = /--target[=\s]+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command);
  if (!target) return null;
  // An unexpanded shell variable as the target means the transcript cannot
  // tell us who received it — and the surrounding compound command's quoted
  // strings (grep patterns, echoes) are then the only body candidates.
  if ((target[1] ?? target[2] ?? target[3] ?? "").includes("$")) return null;
  // A draft resend never carries a new body; quoted strings elsewhere in a
  // compound command (`…; echo "---"; raft inbox check`) must not be mistaken
  // for one.
  if (/--send-draft\b/.test(command)) return null;
  let body: string | null = null;
  const heredoc = /<<-?\s*['"]?([A-Za-z_][\w]*)['"]?[^\n]*\n([\s\S]*?)\n\1(?:\s|$)/.exec(command);
  if (heredoc) {
    body = heredoc[2]!;
  } else {
    // Scan only the send invocation itself, not later commands in a pipeline:
    // cut at the first unquoted `;`, `|`, or newline (a grep pattern after a
    // pipe is a convincing fake body).
    let cut = command.slice(command.search(SEND_COMMAND_RE));
    let quote: string | null = null;
    for (let i = 0; i < cut.length; i += 1) {
      const ch = cut[i]!;
      if (quote) {
        if (ch === quote) quote = null;
        else if (ch === "\\" && quote === '"') i += 1;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ";" || ch === "|" || ch === "\n") {
        cut = cut.slice(0, i);
        break;
      }
    }
    const sendSegment = cut.replace(target[0], "");
    let longest = "";
    for (const match of sendSegment.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)) {
      const candidate = match[1] ?? match[2] ?? "";
      if (candidate.length > longest.length) longest = candidate;
    }
    body = longest.length > 0 ? longest : null;
  }
  if (body === null || body.trim().length === 0) return null;
  const targetName = target[1] ?? target[2] ?? target[3] ?? "?";
  // The CLI display clock, not raw transcript ISO: a sent line whose clock
  // format differs from its received neighbors reads as a timezone mismatch
  // and makes a correct interleave look mis-sorted (R2 bench, b0).
  const displayTs = cliClock(ts) ?? ts;
  // Only the reconstructed body (and the target token) are ours to prefix.
  // Received lines elsewhere in this panel are copied from earlier tool output
  // that the CLI already rendered; prefixing them again would double the
  // marker and would not repair pre-fix lines (HaoHao, task #362 review).
  return {
    raw: `[target=${indentAgentBodyContinuationLines(targetName)}${displayTs ? ` time=${displayTs}` : ""}] you sent: ${indentAgentBodyContinuationLines(body.trim())}`,
    msgId: null,
    ts,
    self: true,
  };
}

/**
 * Reconstruct the messages the retired session recently saw or sent, from its
 * transcript tail: `raft message check/read/search` tool results, message
 * bodies carried by wake inputs, and `raft message send` commands (rendered
 * first-person). Deduplicated by message id, newest `max` kept, transcript
 * order preserved. A lossy view by construction — the section header says so.
 */
export async function collectRecentMessages(
  transcriptPath: string,
  max: number,
  tailBytes: number = MESSAGE_SCAN_TAIL_BYTES,
): Promise<PanelMessage[]> {
  const lines = await readTranscriptTailLines(transcriptPath, tailBytes);
  if (lines === null) return [];

  // Send attempts pair with their tool results: a guard-blocked attempt holds
  // the body, the follow-up `--send-draft` confirms delivery. Only confirmed
  // sends are listed as the agent's own words.
  const sendAttempts = new Map<string, { message: PanelMessage | null; target: string | null }>();
  // Tool calls whose output may list received messages (MESSAGE_CHECK_COMMAND_RE).
  const messageCheckCalls = new Set<string>();
  const pendingDraftByTarget = new Map<string, PanelMessage>();
  const found: PanelMessage[] = [];
  for (const line of lines) {
    if (!line) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = typeof record.timestamp === "string" ? record.timestamp : null;
    const message = record.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (record.type === "assistant" && Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object" || (block as Record<string, unknown>).type !== "tool_use") continue;
        const b = block as Record<string, unknown>;
        const id = typeof b.id === "string" ? b.id : null;
        const input = (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, unknown>;
        const command = typeof input.command === "string" ? input.command : "";
        if (id && MESSAGE_CHECK_COMMAND_RE.test(command)) messageCheckCalls.add(id);
        if (!id || !command || !SEND_COMMAND_RE.test(command)) continue;
        const targetMatch = /--target[=\s]+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command);
        sendAttempts.set(id, {
          message: parseSentMessage(command, ts),
          target: targetMatch ? targetMatch[1] ?? targetMatch[2] ?? targetMatch[3] ?? null : null,
        });
      }
    } else if (record.type === "user") {
      const handleResult = (id: string | null, resultText: string) => {
        if (id !== null && sendAttempts.has(id)) {
          const attempt = sendAttempts.get(id)!;
          const delivered = /Message sent/.test(resultText);
          if (attempt.message) {
            if (delivered) found.push(attempt.message);
            else if (attempt.target) pendingDraftByTarget.set(attempt.target, attempt.message);
          } else if (delivered && attempt.target) {
            // Bodyless resend (`--send-draft`): the delivered content is the
            // guard-blocked attempt pending for the same target.
            const pending = pendingDraftByTarget.get(attempt.target);
            if (pending) {
              found.push(pending);
              pendingDraftByTarget.delete(attempt.target);
            }
          }
          return;
        }
        if (id !== null && messageCheckCalls.has(id) && resultText.includes("[target=")) found.push(...parseMessageChunks(resultText));
      };
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const b = block as Record<string, unknown>;
          if (b.type === "tool_result") {
            const value = b.content;
            const resultText = typeof value === "string"
              ? value
              : Array.isArray(value)
                ? value.map((x) => (x && typeof x === "object" ? String((x as Record<string, unknown>).text ?? "") : "")).join("\n")
                : "";
            handleResult(typeof b.tool_use_id === "string" ? b.tool_use_id : null, resultText);
          } else if (b.type === "text" && typeof b.text === "string" && b.text.includes("[target=")) {
            found.push(...parseMessageChunks(b.text));
          }
        }
      } else if (typeof content === "string" && content.includes("[target=")) {
        found.push(...parseMessageChunks(content));
      }
    }
  }

  return orderRecentMessages(found, max);
}

/**
 * The recent-messages window from messages in encounter order, shared by the
 * transcript and the session-summary builds: deduped by message id (falling
 * back to sender side + body), longest body deciding content, sorted by the
 * messages' own timestamps, newest `max` kept.
 */
export function orderRecentMessages(found: readonly PanelMessage[], max: number): PanelMessage[] {
  // Dedupe by message id (falling back to target+body), newest occurrence
  // deciding order, longest body deciding content.
  const byKey = new Map<string, { message: PanelMessage; order: number }>();
  found.forEach((message, index) => {
    const key = message.msgId ?? `${message.self}|${message.raw.slice(0, 100)}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.order = index;
      if (message.raw.length > existing.message.raw.length) existing.message = message;
    } else {
      byKey.set(key, { message, order: index });
    }
  });
  // True chronological order by the messages' own timestamps: transcript
  // encounter order lies when an old message is re-presented by a later
  // catch-up (it would sort to the bottom and read as current — the top
  // misdirection in the gold bench).
  const sortValue = (entry: { message: PanelMessage; order: number }): number => {
    const ts = entry.message.ts;
    if (ts) {
      const parsed = Date.parse(ts.includes("T") ? ts : ts.replace(" ", "T"));
      if (Number.isFinite(parsed)) return parsed;
    }
    return entry.order; // ts-less entries keep encounter order at the epoch floor
  };
  return [...byKey.values()]
    .sort((a, b) => sortValue(a) - sortValue(b) || a.order - b.order)
    .slice(-Math.max(0, max))
    .map((entry) => entry.message);
}

interface HotObject {
  name: string;
  key: string;
  last: number;
  touches: number;
  content: string | null;
  isFile: boolean;
  lastTs: string | null;
}

/** Path-like tokens in free text (commands, patches); shared with the OAR host's session summary. */
export function pathsIn(text: string): string[] {
  const out = new Set<string>();
  const re = /[\w.~@/-]*[/][\w.@/-]+|\b[\w-]+\.(?:ts|js|py|md|json|yml|yaml|toml|jsonl|sh|tsx|html|css|txt|lock)\b/g;
  for (const match of text.matchAll(re)) {
    const p = match[0].replace(/^[.,;:'"()[\]]+|[.,;:'"()[\]]+$/g, "");
    if (p.length < 4 || p.startsWith("http")) continue;
    out.add(p);
  }
  return [...out];
}

/** Objects the agent worked on: files (by path) and distinct shell commands
 * (deduplicated by shape, latest output wins). */
export function hotObjects(actions: readonly TranscriptAction[]): HotObject[] {
  const index = new Map<string, HotObject>();
  // Files only (2026-09-12): command-shape objects ("$ raft task list" dumps,
  // held-draft outputs with embedded "Next action:" affordances) were the gold
  // bench's most-cited misdirection — stale operational residue that reads as
  // an agenda. Durable working state lives in files.
  for (const action of actions) {
    const command = typeof action.input.command === "string" ? action.input.command : "";
    const filePaths = new Set<string>();
    if (typeof action.input.file_path === "string") filePaths.add(action.input.file_path);
    for (const p of pathsIn(command)) filePaths.add(p);
    let content: string | null = null;
    if (action.tool === "Read") content = action.result;
    else if (action.tool === "Write" && typeof action.input.content === "string") content = action.input.content;
    else if (action.tool === "Edit" && typeof action.input.new_string === "string") content = action.input.new_string;
    for (const filePath of filePaths) {
      // Prose containing a slash ("tool/infra", "/marketplace") and device
      // paths match the path regex; a real working file has an extension on
      // its final segment. Directories add nothing over their files.
      const lastSegment = filePath.split("/").filter(Boolean).at(-1) ?? "";
      if (filePath.startsWith("/dev/") || filePath.endsWith("/") || !lastSegment.includes(".")) continue;
      const segments = filePath.split("/").filter(Boolean);
      const key = segments.length > 1 ? segments.slice(-2).join("/") : segments[0] ?? filePath;
      const entry = index.get(key) ?? { name: filePath, key, last: 0, touches: 0, content: null, isFile: true, lastTs: null };
      entry.last = action.i;
      entry.touches += 1;
      entry.lastTs = action.ts;
      if (content) entry.content = content;
      if (filePath.startsWith("/")) entry.name = filePath;
      index.set(key, entry);
    }
  }
  return [...index.values()];
}

async function rereadFile(filePath: string): Promise<string | null> {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size > REREAD_FILE_MAX_BYTES) return null;
    const bytes = await readFile(filePath);
    // A binary file (an image, an archive) decodes to noise that costs the
    // panel's budget and says nothing: a NUL byte marks it, as git does.
    if (bytes.includes(0)) return null;
    return bytes.toString("utf8");
  } catch {
    return null;
  }
}

/** A hot object with its live re-read resolved (I/O done by the collector so
 * the registered panel formatter below stays pure). */
export interface ResolvedPanelObject {
  name: string;
  touches: number;
  lastTs: string | null;
  isFile: boolean;
  /** Transcript-sourced content (last Read result / written content). */
  transcriptBody: string | null;
  /** Live file content re-read at construction time, when possible. */
  rereadBody: string | null;
  /** Touched near the session's end. Out-of-play objects render as bare
   * pointers: name and last-observed time, no body. */
  inPlay: boolean;
}

export interface ConstructedPanelInput {
  messages: PanelMessage[];
  objects: ResolvedPanelObject[];
  tail: TranscriptAction[];
  totalActions: number;
  budgetTokens: number;
  /** The agent's own final text of a recent turn (the OAR session summary's `lastNote`); delivered to no one. */
  lastNote?: { at: string; text: string } | null;
  /** Warm path only (§6.5): the last assistant text of each of the last turns, oldest first; delivered to no one. */
  notes?: PanelNote[];
  /** Warm path only (§6.5): the agent's latest todo / plan list (open items). */
  todos?: PanelTodos | null;
  /** Warm path only (§6.5): each action line is cut at this many characters. */
  actionLineMaxChars?: number;
  /** Warm path (§6.5): the sections give way in a fixed order so the whole fits the budget (`formatWarmPanel`). */
  warm?: boolean;
}

/** A message renders IN FULL: a truncated message reads as complete and
 * invites confident mistakes, so the budget drops whole old messages instead.
 * Only a single pathological giant is cut, with an explicit marker. */
function messageLine(message: PanelMessage): string {
  // A message body may not close a panel section either.
  const raw = message.raw.replace(PANEL_CLOSING_TAG_RE, "&lt;/$1");
  if (tokens(raw) <= MESSAGE_MAX_TOKENS) return raw;
  return `${raw.slice(0, MESSAGE_MAX_TOKENS * 4)}\n[… truncated — read the channel for the rest]`;
}

function messagesSection(lines: readonly string[]): string[] {
  if (lines.length === 0) return [];
  // The note is a fact, not advice: "re-read channels for authority" was
  // cited by two of three R1 judges as inviting a history-reconstruction
  // ritual before the trigger. The panel states what it holds and stops.
  return [
    '<recent-messages order="newest last" note="recent tail only; older messages not shown">',
    lines.join("\n\n"),
    "</recent-messages>",
    "",
  ];
}

function lastNoteSection(lastNote: ConstructedPanelInput["lastNote"]): string[] {
  if (!lastNote || !lastNote.text.trim()) return [];
  // Dated and stated as a fact, no advice: an old note's "next I'll do X"
  // reads as a live agenda otherwise (the residue the objects section
  // guards against), so the reader sees when it was written and that no
  // one received it, and judges it against what came after.
  const written = cliClock(lastNote.at);
  let text = lastNote.text.trim();
  if (tokens(text) > LAST_NOTE_CAP_TOKENS) text = `${text.slice(0, LAST_NOTE_CAP_TOKENS * 4)}\n[… truncated]`;
  return [
    `<last-note${written ? ` written="${written}"` : ""} note="your own text at the end of a turn; delivered to no one">`,
    quotePanelObjectBody(text),
    "</last-note>",
    "",
  ];
}

function notesSection(notes: readonly PanelNote[], capChars: number): string[] {
  if (notes.length === 0) return [];
  // As the last note: dated facts, no advice. Each is the agent's own last
  // text of one turn (narration before a tool call included: a warm stop
  // cuts work in progress), so the reader sees where it left off.
  const lines = ['<last-notes order="oldest first" note="your own last text of each of your last turns; delivered to no one">'];
  for (const note of notes) {
    const written = cliClock(note.at);
    const text = maskSecrets(note.text.trim());
    const truncated = text.length > capChars;
    lines.push(
      `<turn-note${written ? ` written="${written}"` : ""}>`,
      quotePanelObjectBody(text.slice(0, capChars)) + (truncated ? "\n[… truncated]" : ""),
      "</turn-note>",
    );
  }
  lines.push("</last-notes>", "");
  return lines;
}

function todosSection(todos: PanelTodos | null | undefined, maxItems: number): string[] {
  if (!todos || todos.open.length === 0 || maxItems <= 0) return [];
  const written = cliClock(todos.at);
  const shown = todos.open.slice(0, maxItems);
  const items = shown.map((item) => `- [${elide(item.status, 24)}] ${elide(maskSecrets(item.text), WARM_TODO_ITEM_MAX_CHARS)}`);
  if (todos.open.length > shown.length) items.push(`[… ${todos.open.length - shown.length} more open items]`);
  return [
    `<open-todos${written ? ` written="${written}"` : ""} open="${todos.open.length} of ${todos.total}" note="your own todo list as you last wrote it; open items only">`,
    quotePanelObjectBody(items.join("\n")),
    "</open-todos>",
    "",
  ];
}

function actionsSection(tail: readonly TranscriptAction[], totalActions: number, lineCap: number | undefined): string[] {
  return [
    `<recent-actions span="${tail.length} of ${totalActions}" order="oldest first">`,
    ...tail.map((action) => {
      const line = actionLine(action);
      return lineCap !== undefined && line.length > lineCap ? `${line.slice(0, lineCap - 1)}…` : line;
    }),
    "</recent-actions>",
  ];
}

/** The objects section within `left` tokens (an estimate: line prefixes and joins may run a little over). */
function objectsSection(objects: readonly ResolvedPanelObject[], budgetLeft: number): string[] {
  let left = budgetLeft;
  const objectLines: string[] = ["<objects-in-play>"];
  for (const object of objects.slice(0, MAX_PANEL_OBJECTS)) {
    if (left <= 80) break;
    if (!object.inPlay) {
      // Bare pointer, no body, no advice: hours-old note files carry
      // imperative residue ("Next step: …") that reads as a live agenda.
      const pointer = `<object name="${panelAttribute(object.name)}" touched="${object.touches}x"`
        + `${object.lastTs ? ` last-observed="${object.lastTs}"` : ""}/>`;
      objectLines.push(pointer);
      left -= tokens(pointer);
      continue;
    }
    let body = SENSITIVE_PATH_RE.test(object.name) ? null : object.transcriptBody;
    let freshness = object.lastTs ? `last observed ${object.lastTs}` : "last observed earlier";
    if (object.rereadBody !== null) {
      body = object.rereadBody;
      freshness = "current — re-read just now";
    } else if (object.isFile && body) {
      freshness += "; could not re-read, may be stale";
    }
    if (!body) {
      // An in-play object with no recoverable content renders in the same
      // pointer form as an out-of-play one; an empty tag pair says nothing.
      const pointer = `<object name="${panelAttribute(object.name)}" touched="${object.touches}x"`
        + `${object.lastTs ? ` last-observed="${object.lastTs}"` : ""}/>`;
      objectLines.push(pointer);
      left -= tokens(pointer);
      continue;
    }
    const title = `<object name="${panelAttribute(object.name)}" touched="${object.touches}x" freshness="${freshness}">`;
    left -= tokens(title) + 4;
    objectLines.push(title);
    if (body) {
      const cap = object.rereadBody !== null ? OBJECT_CONTENT_CAP_TOKENS : STALE_OBJECT_BODY_CAP_TOKENS;
      const share = Math.min(cap, left);
      let clipped = body.slice(0, share * 4);
      const truncated = clipped.length < body.length;
      if (truncated) {
        // Cut on a line boundary and say so: a mid-sentence cut reads as
        // complete and manufactures an information gap (R1 bench, b5).
        const lastBreak = clipped.lastIndexOf("\n");
        if (lastBreak > clipped.length / 2) clipped = clipped.slice(0, lastBreak);
      }
      const quoted = quotePanelObjectBody(clipped) + (truncated ? "\n[… truncated]" : "");
      objectLines.push(quoted);
      left -= tokens(quoted);
    }
    objectLines.push("</object>");
  }
  objectLines.push("</objects-in-play>");
  return objectLines;
}

function renderPanel(sections: readonly string[], objectLines: readonly string[], tailSection: readonly string[]): string {
  return [...sections, ...objectLines, "", ...tailSection].join("\n");
}

/**
 * The warm panel (§6.5) within its budget. Its additions can outgrow the
 * budget the cold sections were sized for, so they give way in a fixed order
 * until the objects in play keep their floor and the whole fits: the messages
 * section is capped lower from the start, then the todo list shrinks (5 items,
 * then none), then the notes (the older one, then the newer cut to 1,000
 * characters, then none), then the action tail (12 lines), the last note, the
 * oldest messages one by one, and the action tail by halves.
 */
function formatWarmPanel(input: ConstructedPanelInput): string {
  const budget = input.budgetTokens;
  const messageLines = input.messages.map(messageLine);
  while (messageLines.length > 1 && tokens(messageLines.join("\n\n")) > WARM_MESSAGES_SECTION_CAP_TOKENS) messageLines.shift();
  let notes = [...(input.notes ?? [])];
  let noteCap = WARM_NOTE_MAX_CHARS;
  let todoMax = WARM_TODOS_MAX;
  let tail = [...input.tail];
  let lastNote = input.lastNote ?? null;
  const floor = input.objects.length > 0 ? Math.min(WARM_OBJECTS_FLOOR_TOKENS, Math.floor(budget / 4)) : 0;
  const shrink = (): boolean => {
    const openTodos = input.todos?.open.length ?? 0;
    if (todoMax > 5 && openTodos > 5) todoMax = 5;
    else if (todoMax > 0 && openTodos > 0) todoMax = 0;
    else if (notes.length > 1) notes = notes.slice(1);
    else if (notes.length === 1 && noteCap > WARM_NOTE_SHRUNK_CHARS && notes[0]!.text.trim().length > WARM_NOTE_SHRUNK_CHARS) noteCap = WARM_NOTE_SHRUNK_CHARS;
    else if (notes.length === 1) notes = [];
    else if (tail.length > RECENT_ACTIONS) tail = tail.slice(-RECENT_ACTIONS);
    else if (lastNote) lastNote = null;
    else if (messageLines.length > 0) messageLines.shift();
    else if (tail.length > 0) tail = tail.slice(Math.ceil(tail.length / 2));
    else return false;
    return true;
  };
  let text = "";
  // Each pass either fits or shrinks one step; the steps are finite.
  for (;;) {
    const sections = [...messagesSection(messageLines), ...lastNoteSection(lastNote), ...notesSection(notes, noteCap), ...todosSection(input.todos, todoMax)];
    const tailSection = actionsSection(tail, input.totalActions, input.actionLineMaxChars);
    let left = budget - tokens(sections.join("\n")) - tokens(tailSection.join("\n")) - 60;
    if (left < floor && shrink()) continue;
    text = renderPanel(sections, objectsSection(input.objects, left), tailSection);
    // The objects' estimate may run over: give them less until the whole fits.
    while (tokens(text) > budget && left > 80) {
      left -= tokens(text) - budget + 16;
      text = renderPanel(sections, objectsSection(input.objects, left), tailSection);
    }
    if (tokens(text) <= budget || !shrink()) return text;
  }
}

export const formatConstructedPanel = axSurface(
  "Constructed wake panel: XML-delimited sections — recent messages (verbatim CLI rendering), objects in play with live re-read freshness, and the recent-actions tail — rendered into a token budget",
  (input: ConstructedPanelInput): string => {
    // XML section boundaries throughout: message bodies and file contents are
    // markdown themselves, so markdown headings cannot delimit them. No
    // open-loops section (removed 2026-09-12): across 1,301 real full-context
    // continuations at idle boundaries, only 20% touched a prior unresolved
    // failure in their next burst — the `!` marks in <recent-actions> keep
    // that information discoverable without front-loading it as an agenda.
    if (input.warm === true) return formatWarmPanel(input);
    const messageLines = input.messages.map(messageLine);
    // Whole oldest messages drop first when the section overruns its cap;
    // the ones that stay are complete.
    while (messageLines.length > 1 && tokens(messageLines.join("\n\n")) > MESSAGES_SECTION_CAP_TOKENS) messageLines.shift();
    const sections = [
      ...messagesSection(messageLines),
      ...lastNoteSection(input.lastNote),
      ...notesSection(input.notes ?? [], WARM_NOTE_MAX_CHARS),
      ...todosSection(input.todos, WARM_TODOS_MAX),
    ];
    const tailSection = actionsSection(input.tail, input.totalActions, input.actionLineMaxChars);
    const left = input.budgetTokens - tokens(sections.join("\n")) - tokens(tailSection.join("\n")) - 60;
    return renderPanel(sections, objectsSection(input.objects, left), tailSection);
  },
  {
    examples: [{
      title: "one received and one sent message, one re-read file, two tail actions",
      args: [{
        messages: [
          { raw: "[target=#proj-x:abcd1234 msg=abc12345 time=2026-08-30 00:00:02Z] @alice: ping, did the deploy finish?", msgId: "abc12345", ts: "2026-08-30 00:00:02Z", self: false },
          { raw: "[target=#proj-x:abcd1234 time=2026-08-30 00:00:03Z] you sent: yes, all green", msgId: null, ts: "2026-08-30T00:00:03.000Z", self: true },
        ],
        objects: [{ name: "/workspace/MEMORY.md", touches: 2, lastTs: "2026-08-30T00:00:00.000Z", isFile: true, transcriptBody: "# Memory", rereadBody: "# Memory\n- updated", inPlay: true }],
        tail: [
          { i: 3, tool: "Bash", input: { command: "pnpm test" }, result: "exit code 1", ok: false, mutating: false, ts: "2026-08-30T00:00:00.000Z" },
          { i: 4, tool: "Read", input: { file_path: "/workspace/MEMORY.md" }, result: "# Memory", ok: true, mutating: false, ts: "2026-08-30T00:00:01.000Z" },
        ],
        totalActions: 5,
        budgetTokens: 8_000,
      }],
    }],
  },
);

/**
 * Build the constructed panel from the retired session's transcript: parse
 * the action log, resolve live re-reads, and render via the registered
 * formatter. Sections, in the order the budget protects them: recent
 * messages, objects in play (live re-read where possible), recent actions.
 */
export async function buildConstructedPanel(args: {
  transcriptPath: string;
  workspacePath?: string;
  budgetTokens?: number;
  /** Max messages in the recent-messages section; 0 disables the section. */
  recentMessagesMax?: number;
  /** A warm recycle (§6.5): add the last notes and open todos, and a longer action tail. */
  warm?: boolean;
}): Promise<AxSurfaceText | null> {
  const budget = args.budgetTokens ?? DEFAULT_PANEL_BUDGET_TOKENS;
  const actions = await parseTranscriptActions(args.transcriptPath);
  if (actions.length < 5) return null;
  const recentMessagesMax = args.recentMessagesMax ?? RECENT_MESSAGES_DEFAULT;
  const messages = recentMessagesMax > 0
    ? await collectRecentMessages(args.transcriptPath, recentMessagesMax)
    : [];

  const maxIndex = Math.max(1, ...actions.map((a) => a.i));
  const lastTsMs = [...actions].reverse()
    .map((a) => (a.ts ? Date.parse(a.ts) : Number.NaN))
    .find((t) => Number.isFinite(t));
  const isInPlay = (object: HotObject): boolean => {
    if (lastTsMs !== undefined && object.lastTs) {
      const objectMs = Date.parse(object.lastTs);
      if (Number.isFinite(objectMs)) return lastTsMs - objectMs <= OBJECT_IN_PLAY_WINDOW_MS;
    }
    return object.last >= maxIndex - OBJECT_IN_PLAY_ACTIONS;
  };
  const ranked = hotObjects(actions)
    .sort((a, b) => b.touches * (0.3 + b.last / maxIndex) - a.touches * (0.3 + a.last / maxIndex))
    .sort((a, b) => Number(isInPlay(b)) - Number(isInPlay(a)));
  const objects: ResolvedPanelObject[] = [];
  for (const object of ranked) {
    const inPlay = isInPlay(object);
    let rereadBody: string | null = null;
    // Relative names resolve against the workspace (agents driving everything
    // through Bash touch files as `notes/x.md`, never absolute). MEMORY.md is
    // owned by the memory-index section — a second copy here is pure
    // duplication. Sensitive files never contribute content.
    const rereadable = inPlay && object.isFile
      && (path.isAbsolute(object.name) || args.workspacePath !== undefined)
      && !/(^|\/)MEMORY\.md$/.test(object.name)
      && !SENSITIVE_PATH_RE.test(object.name);
    if (rereadable) {
      rereadBody = await rereadFile(
        path.isAbsolute(object.name) ? object.name : path.join(args.workspacePath ?? "", object.name),
      );
    }
    objects.push({
      name: object.name,
      touches: object.touches,
      lastTs: object.lastTs,
      isFile: object.isFile,
      transcriptBody: object.content,
      rereadBody,
      inPlay,
    });
  }

  if (!args.warm) {
    return formatConstructedPanel({
      messages,
      objects,
      tail: actions.slice(-RECENT_ACTIONS),
      totalActions: actions.length,
      budgetTokens: budget,
    });
  }
  // Warm (§6.5): the agent's own working state, kept to the in-play window
  // as files are, so an old note or list never reads as current.
  const state = await collectClaudeWorkingState(args.transcriptPath);
  const inWindow = (at: string | null): boolean => {
    if (lastTsMs === undefined || !at) return true;
    const atMs = Date.parse(at);
    return !Number.isFinite(atMs) || lastTsMs - atMs <= OBJECT_IN_PLAY_WINDOW_MS;
  };
  return formatConstructedPanel({
    messages,
    objects,
    tail: actions.slice(-WARM_RECENT_ACTIONS).map(maskedAction),
    totalActions: actions.length,
    budgetTokens: budget,
    notes: state.notes.filter((note) => inWindow(note.at)),
    todos: state.todos && inWindow(state.todos.at) ? state.todos : null,
    actionLineMaxChars: WARM_ACTION_LINE_MAX_CHARS,
    warm: true,
  });
}

/** An action as the warm panel shows it: token-shaped values in its input and result masked. */
function maskedAction(action: TranscriptAction): TranscriptAction {
  const input: Record<string, unknown> = {};
  // callForm shows a non-string value as its JSON; masked in that form.
  for (const [key, value] of Object.entries(action.input)) input[key] = maskSecrets(typeof value === "string" ? value : JSON.stringify(value ?? ""));
  return { ...action, input, result: maskSecrets(action.result) };
}

/**
 * Build the constructed panel from the OAR host's session summary (#wg-ax
 * task #3, RFC 070 §6.2 on OAR): the same sections and the same formatter as
 * the transcript build, so a fresh session on any runtime reads one shape,
 * plus the agent's last note. The summary already holds the windows
 * (messages, actions, files, across sessions); files in play are re-read
 * live, never taken from the summary.
 */
export async function buildConstructedPanelFromSummary(args: {
  summary: SessionSummary;
  workspacePath?: string;
  budgetTokens?: number;
  /** Max messages in the recent-messages section; 0 disables the section. */
  recentMessagesMax?: number;
  /** A warm recycle (§6.5): add the last notes and open todos, and a longer action tail. */
  warm?: boolean;
}): Promise<AxSurfaceText | null> {
  const { summary } = args;
  const budget = args.budgetTokens ?? DEFAULT_PANEL_BUDGET_TOKENS;
  const recentMessagesMax = args.recentMessagesMax ?? RECENT_MESSAGES_DEFAULT;
  const messages = recentMessagesMax > 0
    ? orderRecentMessages(summary.messages.map((message) => ({
      raw: message.raw,
      msgId: message.msgId,
      ts: message.at,
      self: message.direction === "sent",
    })), recentMessagesMax)
    : [];
  const actions: TranscriptAction[] = summary.actions.map((action, index) => ({
    i: index + 1,
    tool: action.tool,
    // The summary keeps a command (cut at 200 characters) or, for a file tool, its paths.
    input: action.summary ? { command: action.summary } : action.paths.length > 0 ? { path: action.paths.join(" ") } : {},
    result: action.result === "failed" ? (typeof action.exitCode === "number" ? `exit code ${action.exitCode}` : "failed") : "",
    ok: action.result !== "failed",
    mutating: action.mutating,
    ts: action.at,
  }));
  const lastActivityMs = Date.parse(summary.lastActivityAt ?? summary.updatedAt);
  const isInPlay = (lastAt: string): boolean => {
    const atMs = Date.parse(lastAt);
    return Number.isFinite(lastActivityMs) && Number.isFinite(atMs) && lastActivityMs - atMs <= OBJECT_IN_PLAY_WINDOW_MS;
  };
  // The note is carried across turns that ended without text and across
  // sessions; only one from this session and near its end is shown, by the
  // same rule as files in play, so an old "next I'll do X" never reads as current.
  const note = summary.lastNote;
  const lastNote = note && note.text.trim() && note.sessionId === summary.sessionId && isInPlay(note.at)
    ? { at: note.at, text: note.text }
    : null;
  // Warm (§6.5): this session's own notes and list, in the same window.
  const notes: PanelNote[] = args.warm
    ? (summary.notes ?? []).filter((n) => n.text.trim() && n.sessionId === summary.sessionId && isInPlay(n.at)).map((n) => ({ at: n.at, text: n.text }))
    : [];
  const todos = args.warm && summary.todos && summary.todos.sessionId === summary.sessionId && isInPlay(summary.todos.at)
    ? openTodos(summary.todos.items, summary.todos.at)
    : null;
  if (messages.length === 0 && actions.length === 0 && !lastNote && notes.length === 0 && !todos) return null;
  const ranked = [...summary.files].sort((a, b) =>
    Number(isInPlay(b.lastAt)) - Number(isInPlay(a.lastAt)) || Date.parse(b.lastAt) - Date.parse(a.lastAt));
  const objects: ResolvedPanelObject[] = [];
  for (const file of ranked) {
    const inPlay = isInPlay(file.lastAt);
    // As in the transcript build: relative paths resolve against the
    // workspace, MEMORY.md is the memory block's, sensitive files never show.
    const rereadable = inPlay
      && (path.isAbsolute(file.path) || args.workspacePath !== undefined)
      && !/(^|\/)MEMORY\.md$/.test(file.path)
      && !SENSITIVE_PATH_RE.test(file.path);
    const rereadBody = rereadable
      ? await rereadFile(path.isAbsolute(file.path) ? file.path : path.join(args.workspacePath ?? "", file.path))
      : null;
    objects.push({ name: file.path, touches: file.touches, lastTs: file.lastAt, isFile: true, transcriptBody: null, rereadBody, inPlay });
  }

  if (!args.warm) {
    return formatConstructedPanel({
      messages,
      objects,
      tail: actions.slice(-RECENT_ACTIONS),
      totalActions: actions.length,
      budgetTokens: budget,
      lastNote,
    });
  }
  // The notes include the turn's final text, so the last note would repeat
  // the newest one; it shows only when no note does.
  return formatConstructedPanel({
    messages,
    objects,
    tail: actions.slice(-WARM_RECENT_ACTIONS).map(maskedAction),
    totalActions: actions.length,
    budgetTokens: budget,
    lastNote: notes.length > 0 ? null : lastNote,
    notes,
    todos,
    actionLineMaxChars: WARM_ACTION_LINE_MAX_CHARS,
    warm: true,
  });
}
