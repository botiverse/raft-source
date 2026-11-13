/**
 * Lives next to the formatters it reads (agentInbox.ts, idleTaskReminder.ts)
 * so a format change that the parser does not follow fails in the same PR:
 * the daemon's round-trip tests (agentRuntimeInput.deliveryParse.test.ts)
 * parse what the real formatters write (#wg-ax:#19).
 *
 * What Raft put into a user message (the daemon's turn input,
 * packages/daemon/src/agentRuntimeInput.ts), read back into notices for the
 * View Context timeline (AgentContextViewContent). Pure: a text in, its
 * segments out, each a range of the text, so the card can show the original
 * text of each notice and search can number matches in the text as it is.
 *
 * Formats read (each starts a line):
 * - `[Raft inbox notice:` … a line `]`, then the reading guidance line
 *   (formatInboxUpdateRuntimeInput, formatAgentInboxDelta in
 *   packages/shared/src/agentInbox.ts): `Inbox update: N messages pending …`,
 *   then per target `<target>  pending: N messages · … · latest sender @x · …`
 *   and an optional `  latest @x: "<JSON string>" (preview; …)` line; and
 *   RFC 081's rows (`inboxRowV2`), which read alongside: contexts recorded
 *   before keep the old ones.
 * - `[Raft task notice: N tasks are waiting on you.` … `No change → no reply
 *   needed.]` (formatIdleTaskReminderNotice in
 *   packages/shared/src/agentText/idleTaskReminder.ts), one task per line:
 *   `<ref> [<status>] <title> — <why>`.
 * - A message header `[target=… msg=… time=… type=…] @sender: body`, the
 *   body's continuation lines prefixed `  │ ` (formatIncomingMessage).
 * - Any other line starting `[Raft …]` (thread context, follow restored, a
 *   non-member notice, or a format this build doesn't know): a generic notice.
 * A known prefix whose body doesn't read as its format is a generic notice
 * too, never text inline. Everything between notices (the envelope's "New
 * message received:", "Respond as appropriate…") is a text segment.
 */

export type RaftInboxTarget = {
  target: string;
  pending: number | null;
  latestSender: string | null;
  /** The latest message's preview, as the notice quoted it (unquoted here). */
  preview: string | null;
  mentioned: boolean;
};

export type RaftTaskItem = { ref: string; status: string; title: string; why: string | null };

export type RaftField = { key: string; value: string };

type Range = { start: number; end: number };

export type RaftNoticeSegment = Range & (
  | { kind: "text" }
  | { kind: "inbox"; pendingTotal: number | null; targets: RaftInboxTarget[] }
  | { kind: "task"; count: number | null; tasks: RaftTaskItem[] }
  | {
    kind: "message";
    /** The header's fields as written (target, msg, time, type, …). */
    fields: RaftField[];
    target: string | null;
    time: string | null;
    sender: string | null;
    /** The body as the sender wrote it (continuation prefixes removed). */
    body: string;
  }
  | { kind: "generic"; label: string }
);

export type RaftNoticeKind = Exclude<RaftNoticeSegment["kind"], "text">;

/** A text Raft delivered: its segments in order, and how many of them are notices (at least one). */
export type RaftDelivery = { segments: RaftNoticeSegment[]; notices: number };

type Line = { start: number; text: string };

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (;;) {
    const newline = text.indexOf("\n", start);
    if (newline === -1) {
      lines.push({ start, text: text.slice(start) });
      return lines;
    }
    lines.push({ start, text: text.slice(start, newline) });
    start = newline + 1;
  }
}

function lineEnd(line: Line): number {
  return line.start + line.text.length;
}

/** How far one notice may run: a notice without its closing line is read no further than this, so unclosed openers cost a bounded scan each. */
const MAX_NOTICE_LINES = 2_000;
const MAX_NOTICE_CHARS = 64 * 1024;

/** The text, its lines, and for each line the next line that opens a notice (or `lines.length`). */
type Scan = { text: string; lines: readonly Line[]; nextOpener: readonly number[] };

/**
 * The last line a notice opened at line `index` may reach: before the next
 * line that opens one, within MAX_NOTICE_LINES lines and MAX_NOTICE_CHARS
 * characters of its start.
 */
function noticeLimit(scan: Scan, index: number): number {
  const { lines } = scan;
  const start = lines[index]!.start;
  const cap = Math.min(scan.nextOpener[index]! - 1, index + MAX_NOTICE_LINES - 1, lines.length - 1);
  let last = index;
  while (last < cap && lines[last + 1]!.start - start <= MAX_NOTICE_CHARS) last++;
  return last;
}

/** The index of the `]` closing the `[` at `from`, before `until`; -1 when none does. */
function closingBracket(text: string, from: number, until: number): number {
  let depth = 0;
  const end = Math.min(until, from + MAX_NOTICE_CHARS);
  for (let index = from; index < end; index++) {
    const char = text[index];
    if (char === "[") depth++;
    else if (char === "]" && --depth === 0) return index;
  }
  return -1;
}

/** The line holding `offset`, from `first` on. */
function lineAt(lines: readonly Line[], first: number, offset: number): number {
  let index = first;
  while (index + 1 < lines.length && lines[index + 1]!.start <= offset) index++;
  return index;
}

type Found = { segment: RaftNoticeSegment; next: number };

/** A bracketed `[Raft …]` from line `index` as a generic notice: to the end of the line its bracket closes on (its own line when it doesn't close within its limit). */
function generic(scan: Scan, index: number): Found {
  const { text, lines } = scan;
  const line = lines[index]!;
  const close = closingBracket(text, line.start, lineEnd(lines[noticeLimit(scan, index)]!));
  const last = close === -1 ? index : lineAt(lines, index, close);
  const label = /^\[Raft ([^:\]]+)/.exec(line.text)?.[1]?.trim() ?? "";
  return { segment: { kind: "generic", label, start: line.start, end: lineEnd(lines[last]!) }, next: last + 1 };
}

const INBOX_HEADER = /^Inbox update: (?:(\d+) messages? pending)?/;
const INBOX_ROW = /^(\S.*?) {2}pending: (\d+) messages?(.*)$/;
const INBOX_PREVIEW = /^ {2}latest(?: @([^:]+))?: ("(?:[^"\\]|\\.)*")/;
/**
 * RFC 081 rows (#13788, behind its flag): `<target> · <part> · <part>…`, parts
 * in order and only when present: `N unread`, `first msg=<8>`, `mentions you`
 * / `mentions you Nx`, `N new, not yet delivered`, `N suppressed (not
 * delivered)`, `latest @x`, `attention_hint=<json>`; a task's target reads
 * `task #ch:#7`; the third-party row `Third-party app events · N pending · …`,
 * with inbox items on `… · N not in this list · …` (#13807).
 * Under a row: `  "<JSON>" (preview)` / `(truncated preview)`, `  read: …`, and
 * an indented `[Raft notice: …]` for a non-member mention.
 */
const INBOX_ROW_V2 = /^(\S[^·]*?) · (.+)$/;
const INBOX_PREVIEW_V2 = /^ {2}("(?:[^"\\]|\\.)*") \((?:truncated )?preview\)/;

function inboxRowV2(line: string): RaftInboxTarget | null {
  const row = INBOX_ROW_V2.exec(line);
  if (!row) return null;
  const parts = row[2]!.split(" · ");
  const count = (pattern: RegExp): number | null => {
    for (const part of parts) {
      const match = pattern.exec(part);
      if (match) return Number(match[1]);
    }
    return null;
  };
  const latest = parts.map((part) => /^latest @(\S+)$/.exec(part)?.[1]).find((sender) => sender !== undefined);
  return {
    target: row[1]!.replace(/^task /, ""),
    pending: count(/^(\d+) unread$/) ?? count(/^(\d+) new, not yet delivered$/) ?? count(/^(\d+) pending$/) ?? count(/^(\d+) not in this list$/),
    latestSender: latest ?? null,
    preview: null,
    mentioned: parts.some((part) => /^mentions you(?: \d+x)?$/.test(part)),
  };
}

function unquote(value: string): string | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function inbox(scan: Scan, index: number): Found {
  const { lines } = scan;
  const limit = noticeLimit(scan, index);
  let close = -1;
  for (let at = index + 1; at <= limit; at++) {
    if (lines[at]!.text.trim() === "]") {
      close = at;
      break;
    }
  }
  const header = close === -1 ? null : INBOX_HEADER.exec(lines[index + 1]?.text ?? "");
  if (close === -1 || !header) return generic(scan, index);
  const targets: RaftInboxTarget[] = [];
  for (let at = index + 2; at < close; at++) {
    const row = INBOX_ROW.exec(lines[at]!.text);
    if (row) {
      const details = row[3] ?? "";
      targets.push({
        target: row[1]!,
        pending: Number(row[2]),
        latestSender: / latest sender @(\S+)/.exec(details)?.[1] ?? null,
        preview: null,
        mentioned: details.includes("you were mentioned"),
      });
      continue;
    }
    const rowV2 = inboxRowV2(lines[at]!.text);
    if (rowV2) {
      targets.push(rowV2);
      continue;
    }
    const previewV2 = INBOX_PREVIEW_V2.exec(lines[at]!.text);
    if (previewV2 && targets.length > 0) {
      targets.at(-1)!.preview = unquote(previewV2[1]!);
      continue;
    }
    const preview = INBOX_PREVIEW.exec(lines[at]!.text);
    const last = targets.at(-1);
    if (preview && last) {
      last.preview = unquote(preview[2]!);
      last.latestSender ??= preview[1]?.trim() ?? null;
    }
  }
  // The reading guidance under the bracket is the notice's too.
  // RFC 081 rewords it around `raft inbox read --target <item>`.
  const guidance = lines[close + 1]?.text ?? "";
  const last = guidance.startsWith("These messages have not been read") || guidance.includes("raft inbox read --target <item>") ? close + 1 : close;
  return {
    segment: { kind: "inbox", pendingTotal: header[1] ? Number(header[1]) : null, targets, start: lines[index]!.start, end: lineEnd(lines[last]!) },
    next: last + 1,
  };
}

const TASK_HEADER = /^\[Raft task notice: (\d+) tasks? (?:is|are) waiting on you\./;
const TASK_LINE = /^(\S*#\d+) \[([a-z_]+)\] (.*?)(?: — (.*))?$/;

function task(scan: Scan, index: number): Found {
  const { text, lines } = scan;
  const limit = noticeLimit(scan, index);
  // The notice's last line; a title with an unpaired bracket can't move it.
  let last = -1;
  for (let at = index; at <= limit; at++) {
    if (/no reply needed\.\]\s*$/.test(lines[at]!.text)) {
      last = at;
      break;
    }
  }
  if (last === -1) {
    const close = closingBracket(text, lines[index]!.start, lineEnd(lines[limit]!));
    if (close !== -1) last = lineAt(lines, index, close);
  }
  const header = TASK_HEADER.exec(lines[index]!.text);
  const tasks: RaftTaskItem[] = [];
  for (let at = index + 1; last !== -1 && at <= last; at++) {
    const item = TASK_LINE.exec(lines[at]!.text);
    if (item) tasks.push({ ref: item[1]!, status: item[2]!, title: item[3]!, why: item[4] ?? null });
  }
  if (last === -1 || (!header && tasks.length === 0)) return generic(scan, index);
  return {
    segment: { kind: "task", count: header ? Number(header[1]) : null, tasks, start: lines[index]!.start, end: lineEnd(lines[last]!) },
    next: last + 1,
  };
}

const HEADER = /^\[(target=[^\]]*)\] ?(.*)$/;
/**
 * The sender handle formatSenderHandleText writes: `@name`, ` (timezone)`,
 * then either ` — description: body` or `: body`. A description is free text
 * and may hold ": " itself, so where there is one the split is ambiguous: the
 * body is then the rest of the line from the description on, never a guess.
 */
const SENDER = /^@([^\s:]+)(?: \([^)]*\))?(?: — (.*)|: ?(.*))$/;
const CONTINUATION = "  │ ";

/** `key=value` pairs; a value runs to the next ` key=` (a time holds a space). */
function headerFields(source: string): RaftField[] {
  const fields: RaftField[] = [];
  const pattern = /(\w+)=(.*?)(?= \w+=|$)/g;
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) fields.push({ key: match[1]!, value: match[2]! });
  return fields;
}

function startsNotice(line: string): boolean {
  return line.startsWith("[target=") || line.startsWith("[Raft ");
}

function message(lines: readonly Line[], index: number): Found | null {
  const line = lines[index]!;
  const header = HEADER.exec(line.text);
  if (!header) return null;
  let last = index;
  while (last + 1 < lines.length) {
    const next = lines[last + 1]!.text;
    if (next.trim() === "" || startsNotice(next) || next.startsWith("Respond as appropriate")) break;
    last++;
  }
  const fields = headerFields(header[1]!);
  const field = (key: string) => fields.find((entry) => entry.key === key)?.value ?? null;
  const rest = header[2] ?? "";
  const sender = SENDER.exec(rest);
  const bodyLines = [sender ? (sender[2] ?? sender[3] ?? "") : rest];
  for (let at = index + 1; at <= last; at++) {
    const text = lines[at]!.text;
    bodyLines.push(text.startsWith(CONTINUATION) ? text.slice(CONTINUATION.length) : text);
  }
  return {
    segment: {
      kind: "message",
      fields,
      target: field("target"),
      time: field("time"),
      sender: sender ? sender[1]! : null,
      body: bodyLines.join("\n"),
      start: line.start,
      end: lineEnd(lines[last]!),
    },
    next: last + 1,
  };
}

function noticeAt(scan: Scan, index: number): Found | null {
  const line = scan.lines[index]!.text;
  if (line.startsWith("[target=")) return message(scan.lines, index);
  if (line.startsWith("[Raft inbox notice:")) return inbox(scan, index);
  if (line.startsWith("[Raft task notice:")) return task(scan, index);
  if (line.startsWith("[Raft ")) return generic(scan, index);
  return null;
}

/** The text's Raft notices and the text between them; null when it holds no notice (plain text). */
export function parseRaftDelivery(text: string): RaftDelivery | null {
  if (!text.includes("[target=") && !text.includes("[Raft ")) return null;
  const lines = splitLines(text);
  const nextOpener = new Array<number>(lines.length);
  for (let index = lines.length - 1, next = lines.length; index >= 0; index--) {
    nextOpener[index] = next;
    if (startsNotice(lines[index]!.text)) next = index;
  }
  const scan: Scan = { text, lines, nextOpener };
  const segments: RaftNoticeSegment[] = [];
  let textStart: number | null = null;
  const flush = (until: number) => {
    if (textStart === null) return;
    let start = textStart;
    let end = until;
    while (start < end && /\s/.test(text[start]!)) start++;
    while (end > start && /\s/.test(text[end - 1]!)) end--;
    if (end > start) segments.push({ kind: "text", start, end });
    textStart = null;
  };
  let notices = 0;
  for (let index = 0; index < lines.length;) {
    const found = noticeAt(scan, index);
    if (found) {
      flush(lines[index]!.start);
      segments.push(found.segment);
      notices++;
      index = found.next;
      continue;
    }
    textStart ??= lines[index]!.start;
    index++;
  }
  flush(text.length);
  return notices > 0 ? { segments, notices } : null;
}

const deliveries = new WeakMap<object, RaftDelivery | null>();

/** A text part's delivery, read once per part however often it is shown or searched. */
export function raftDeliveryOfPart(part: { text: string }): RaftDelivery | null {
  let delivery = deliveries.get(part);
  if (delivery === undefined) {
    delivery = parseRaftDelivery(part.text);
    deliveries.set(part, delivery);
  }
  return delivery;
}

/** The segment holding `offset`, or -1. */
export function raftSegmentAt(segments: readonly RaftNoticeSegment[], offset: number): number {
  return segments.findIndex((segment) => segment.start <= offset && offset < segment.end);
}
