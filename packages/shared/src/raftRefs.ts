import { markdownStructure, visitOutsideRanges } from "./markdownRanges";
import type { SourceRange } from "./markdownRanges";
export const RAFT_REF_CHANNEL_NAME_PATTERN = String.raw`[\p{L}\p{N}_-]+`;
export const RAFT_REF_USER_NAME_PATTERN = RAFT_REF_CHANNEL_NAME_PATTERN;
// Built-in app conversations use dotted peer names. Keep this a literal
// peer-name grammar (not a path/glob): dots are the only addition to the
// existing word/hyphen alphabet.
// A DM peer may carry an explicit kind (`skyzh~agent`, see dmPeerRef.ts) when a
// human and an agent in one server share a name.
export const RAFT_REF_DM_PEER_PATTERN = String.raw`[\w.-]+(?:~(?:agent|human))?(?![\w.~-])`;
export const RAFT_REF_THREAD_SHORT_ID_PATTERN = String.raw`[\da-f]{6,8}`;
export const RAFT_REF_MESSAGE_ID_PATTERN = String.raw`[A-Za-z0-9][A-Za-z0-9-]{1,63}`;
export const RAFT_REF_TASK_NUMBER_PATTERN = String.raw`[1-9]\d*`;
/**
 * THE task ref separator: a task ref is its conversation, this, then the task
 * number (`#proj:#7`, `dm:@peer:#7`). The exact syntax is not final, so every
 * scanner, parser and formatter (shared, web, CLI) derives from this one
 * constant through {@link formatRaftChannelTaskRef} / {@link formatRaftDmTaskRef}
 * and the regex factories below — changing the separator is a one-line edit.
 * A replacement must not be a channel-name or DM-peer character
 * (letters, digits, `_`, `-`, `.`, `~`), and not `:` + hex (thread short ids).
 */
export const RAFT_TASK_REF_SEPARATOR = ":#";
const RAFT_TASK_REF_SEPARATOR_PATTERN = RAFT_TASK_REF_SEPARATOR.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
// The number must end the token: no word character, path segment, or a
// second separator may follow (`#proj:#7a`, `#proj:#7:#8` are not task refs).
const RAFT_TASK_REF_END_PATTERN = String.raw`(?![\p{L}\p{N}_/-]|${RAFT_TASK_REF_SEPARATOR_PATTERN})`;

/** `#channel:#7` for task 7 of channel `channel` (separator: {@link RAFT_TASK_REF_SEPARATOR}). */
export function formatRaftChannelTaskRef(channelName: string, taskNumber: number): RaftChannelTaskTargetString {
  return `#${channelName}${RAFT_TASK_REF_SEPARATOR}${taskNumber}`;
}

/** `dm:@peer:#7` for task 7 of the DM with `peer`. */
export function formatRaftDmTaskRef(peerName: string, taskNumber: number): RaftDmTaskTargetString {
  return `dm:@${peerName}${RAFT_TASK_REF_SEPARATOR}${taskNumber}`;
}
export const RAFT_REF_COMPUTER_ID_PATTERN = String.raw`[\da-f]{8}-[\da-f]{4}-[1-5][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}`;
export const RAFT_REF_APP_ID_PATTERN = String.raw`[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+`;

// Han, kana and hangul may follow a handle directly: CJK writing puts particles
// and suffixes (`@ops的`, `@opsさん`, `@ops와`) against the name without a
// space. Latin letters, digits, `_` and `-` still continue the handle.
const RAFT_MENTION_CJK_SUFFIX_START = String.raw`[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]`;
const RAFT_MENTION_CJK_SUFFIX_START_RE = new RegExp(`^${RAFT_MENTION_CJK_SUFFIX_START}`, "u");
const RAFT_MENTION_NON_CJK_HANDLE_END_RE = /[\p{Script=Latin}\p{N}_-]$/u;

/**
 * Resolve a free-text mention token against known handles.
 *
 * An exact match wins. Otherwise the token is split only where the writing
 * system changes: a Latin/digit/`_`/`-` character followed by Han, kana or
 * hangul. Nothing is guessed inside one script, so `@opsteam` never reaches
 * `ops` and a CJK handle with a glued particle (`@민수가`) stays unresolved;
 * the composer's identity-backed mention covers that case. If the split point
 * is a guess (two valid splits both name members, or a longer member name is
 * also a prefix of the token), the token stays unresolved.
 */
export function resolveRaftMentionHandle(
  token: string,
  isKnownHandle: (handle: string) => boolean,
): { handle: string; suffix: string } | null {
  if (isKnownHandle(token)) return { handle: token, suffix: "" };
  const chars = Array.from(token);
  const splits = [];
  for (let length = 1; length < chars.length; length += 1) {
    const handle = chars.slice(0, length).join("");
    const suffix = chars.slice(length).join("");
    if (!RAFT_MENTION_NON_CJK_HANDLE_END_RE.test(handle)) continue;
    if (!RAFT_MENTION_CJK_SUFFIX_START_RE.test(suffix)) continue;
    if (isKnownHandle(handle)) splits.push({ length, handle, suffix });
  }
  // `ops` and `ops君a` for `@ops君a的`: two members fit, so the split is a guess.
  if (splits.length !== 1) return null;
  const [{ length, handle, suffix }] = splits;
  // A longer member name also fits (`ops` and `ops君` for `@ops君的`).
  for (let longer = length + 1; longer < chars.length; longer += 1) {
    if (isKnownHandle(chars.slice(0, longer).join(""))) return null;
  }
  return { handle, suffix };
}

export function createRaftUserRefRegex(): RegExp {
  return new RegExp(`(^|[^\\p{L}\\p{N}_-])@(${RAFT_REF_USER_NAME_PATTERN})`, "gu");
}

/**
 * Match one identity-backed mention that the composer already resolved.
 *
 * Unlike free-text discovery, this intentionally has no left boundary: a
 * selected mention remains an entity in `草案@Mona` or `draft@Mona`. On the
 * right it may be followed by Han, kana or hangul (`@Mona的`), but not by
 * Latin letters, digits, `_` or `-`. The
 * caller must already hold structured identity metadata for `handle`; using
 * this regex to discover mentions in arbitrary text would turn emails and
 * package-like strings into accidental notifications.
 */
export function createRaftStructuredUserRefRegex(handle: string): RegExp | null {
  if (!new RegExp(`^${RAFT_REF_USER_NAME_PATTERN}$`, "u").test(handle)) return null;
  const escapedHandle = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@${escapedHandle}(?!(?!${RAFT_MENTION_CJK_SUFFIX_START})[\\p{L}\\p{N}_-])`, "gu");
}

export function createRaftChannelThreadRefRegex(): RegExp {
  return new RegExp(`#(${RAFT_REF_CHANNEL_NAME_PATTERN}):(${RAFT_REF_THREAD_SHORT_ID_PATTERN})`, "giu");
}

export function createRaftChannelRefRegex(): RegExp {
  return new RegExp(`#(${RAFT_REF_CHANNEL_NAME_PATTERN})`, "gu");
}

export function createRaftDmThreadRefRegex(): RegExp {
  return new RegExp(`dm:@(${RAFT_REF_DM_PEER_PATTERN}):(${RAFT_REF_THREAD_SHORT_ID_PATTERN})`, "giu");
}

export function createRaftDmRefRegex(): RegExp {
  return new RegExp(`dm:@(${RAFT_REF_DM_PEER_PATTERN})`, "giu");
}

/**
 * A `dm:@name~<suffix>` token whose suffix is not a known peer kind
 * (`~bot`, `~agentXYZ`, a bare `~`). Renderers claim it as plain text so it
 * never degrades into a link to a different target (`dm:@name` or `@name`).
 * Run after the valid DM passes; it also matches valid refs.
 */
export function createRaftMalformedDmKindRefRegex(): RegExp {
  return new RegExp(String.raw`dm:@[\w.-]+~[\w.~-]*(?::${RAFT_REF_THREAD_SHORT_ID_PATTERN})?`, "giu");
}

export function createRaftMessageRefRegex(): RegExp {
  return new RegExp(
    `#(${RAFT_REF_CHANNEL_NAME_PATTERN})(?::(${RAFT_REF_THREAD_SHORT_ID_PATTERN}))?\\s+msg=(${RAFT_REF_MESSAGE_ID_PATTERN})`,
    "giu",
  );
}

/**
 * A channel-qualified task ref, `#channel:#7` (task v2). Channel names never
 * contain the separator, so the split is unambiguous. Match it before
 * `#channel` and bare `#N` refs, which would otherwise claim `#channel` (or a
 * numeric `#12`) and leave `/7` as text. Groups: channel name, task number.
 */
export function createRaftChannelTaskRefRegex(): RegExp {
  return new RegExp(
    `#(${RAFT_REF_CHANNEL_NAME_PATTERN})${RAFT_TASK_REF_SEPARATOR_PATTERN}(${RAFT_REF_TASK_NUMBER_PATTERN})${RAFT_TASK_REF_END_PATTERN}`,
    "gu",
  );
}

/** A task in a DM, `dm:@peer:#7`. Match it before `dm:@peer`. Groups: peer, task number. */
export function createRaftDmTaskRefRegex(): RegExp {
  return new RegExp(
    `dm:@(${RAFT_REF_DM_PEER_PATTERN})${RAFT_TASK_REF_SEPARATOR_PATTERN}(${RAFT_REF_TASK_NUMBER_PATTERN})${RAFT_TASK_REF_END_PATTERN}`,
    "giu",
  );
}

export function createRaftBareTaskRefRegex(): RegExp {
  return new RegExp(`(^|[^\\w/])(?:(task\\s+))?#(${RAFT_REF_TASK_NUMBER_PATTERN})\\b`, "giu");
}

export type RaftRefTarget =
  | { kind: "user"; name: string }
  | { kind: "computer"; machineId: string }
  | { kind: "app"; appId: string }
  | { kind: "channel"; channelName: string }
  | { kind: "channel-thread"; channelName: string; threadShortId: string }
  | { kind: "dm"; peerName: string }
  | { kind: "dm-thread"; peerName: string; threadShortId: string }
  /**
   * A task ref. `channelName` (`#channel:#7`) or `peerName` (`dm:@peer:#7`)
   * names the conversation the task belongs to; neither set is the legacy
   * `task #7`, which readers resolve in the conversation they are reading.
   * At most one of the two is set.
   */
  | { kind: "task"; taskNumber: number; channelName?: string; peerName?: string }
  | {
      kind: "message";
      channelName: string;
      messageId: string;
      threadParentShortId: string | null;
    }
  | {
      kind: "dm-message";
      peerName: string;
      messageId: string;
      threadParentShortId: string | null;
    };

/**
 * The wire form of a {@link RaftRefTarget}, expressed as a template-literal
 * type so the *shape* of a serialized target is checked at compile time rather
 * than being an opaque `string`. {@link formatRaftRefTarget} returns this, and
 * code that constructs targets by hand can annotate against it to catch a
 * dropped `@`, a missing sigil, or a malformed thread suffix before runtime.
 *
 * Note: this constrains structure, not the character classes inside each
 * segment (those stay enforced by the runtime regexes / {@link parseRaftRefTarget}).
 */
export type RaftTargetString =
  | `@${string}` // user
  | `computer:${string}` // managed Computer machine id
  | `app:${string}` // installed RAP app id
  | `#${string}` // channel  (also the prefix of channel-thread / message; order-independent in a union)
  | `#${string}:${string}` // channel-thread
  | `dm:@${string}` // dm
  | `dm:@${string}:${string}` // dm-thread
  | `task #${number}` // task, legacy (resolved in the reader's current channel)
  | RaftChannelTaskTargetString // task in a channel
  | RaftDmTaskTargetString // task in a DM
  | `#${string} msg=${string}` // message, top-level
  | `#${string}:${string} msg=${string}` // message, in a thread
  | `dm:@${string} msg=${string}` // dm message, top-level
  | `dm:@${string}:${string} msg=${string}`; // dm message, in a thread

export type RaftChannelTaskTargetString = `#${string}${typeof RAFT_TASK_REF_SEPARATOR}${number}`;
export type RaftDmTaskTargetString = `dm:@${string}${typeof RAFT_TASK_REF_SEPARATOR}${number}`;

const USER_RE = new RegExp(String.raw`^@(${RAFT_REF_USER_NAME_PATTERN})$`, "u");
const COMPUTER_RE = new RegExp(String.raw`^computer:(${RAFT_REF_COMPUTER_ID_PATTERN})$`, "iu");
const APP_RE = new RegExp(String.raw`^app:(${RAFT_REF_APP_ID_PATTERN})$`, "u");
const CHANNEL_RE = new RegExp(String.raw`^#(${RAFT_REF_CHANNEL_NAME_PATTERN})$`, "u");
const CHANNEL_THREAD_RE = new RegExp(
  String.raw`^#(${RAFT_REF_CHANNEL_NAME_PATTERN}):(${RAFT_REF_THREAD_SHORT_ID_PATTERN})$`,
  "iu",
);
const DM_RE = new RegExp(String.raw`^dm:@(${RAFT_REF_DM_PEER_PATTERN})$`, "iu");
const DM_THREAD_RE = new RegExp(
  String.raw`^dm:@(${RAFT_REF_DM_PEER_PATTERN}):(${RAFT_REF_THREAD_SHORT_ID_PATTERN})$`,
  "iu",
);
const TASK_RE = new RegExp(String.raw`^task\s+#(${RAFT_REF_TASK_NUMBER_PATTERN})$`, "iu");
const CHANNEL_TASK_RE = new RegExp(
  String.raw`^#(${RAFT_REF_CHANNEL_NAME_PATTERN})${RAFT_TASK_REF_SEPARATOR_PATTERN}(${RAFT_REF_TASK_NUMBER_PATTERN})$`,
  "u",
);
const DM_TASK_RE = new RegExp(
  String.raw`^dm:@(${RAFT_REF_DM_PEER_PATTERN})${RAFT_TASK_REF_SEPARATOR_PATTERN}(${RAFT_REF_TASK_NUMBER_PATTERN})$`,
  "iu",
);
const CHANNEL_MESSAGE_RE = new RegExp(
  String.raw`^#(${RAFT_REF_CHANNEL_NAME_PATTERN})(?::(${RAFT_REF_THREAD_SHORT_ID_PATTERN}))?\s+msg=(${RAFT_REF_MESSAGE_ID_PATTERN})$`,
  "iu",
);
const DM_MESSAGE_RE = new RegExp(
  String.raw`^dm:@(${RAFT_REF_DM_PEER_PATTERN})(?::(${RAFT_REF_THREAD_SHORT_ID_PATTERN}))?\s+msg=(${RAFT_REF_MESSAGE_ID_PATTERN})$`,
  "iu",
);

export function parseRaftRefTarget(rawTarget: string): RaftRefTarget | null {
  const target = rawTarget.trim();
  if (!target) return null;

  const channelMessage = CHANNEL_MESSAGE_RE.exec(target);
  if (channelMessage) {
    return {
      kind: "message",
      channelName: channelMessage[1],
      threadParentShortId: channelMessage[2] ?? null,
      messageId: channelMessage[3],
    };
  }

  const dmMessage = DM_MESSAGE_RE.exec(target);
  if (dmMessage) {
    return {
      kind: "dm-message",
      peerName: dmMessage[1],
      threadParentShortId: dmMessage[2] ?? null,
      messageId: dmMessage[3],
    };
  }

  const channelThread = CHANNEL_THREAD_RE.exec(target);
  if (channelThread) {
    return { kind: "channel-thread", channelName: channelThread[1], threadShortId: channelThread[2] };
  }

  const dmThread = DM_THREAD_RE.exec(target);
  if (dmThread) {
    return { kind: "dm-thread", peerName: dmThread[1], threadShortId: dmThread[2] };
  }

  const task = TASK_RE.exec(target);
  if (task) return { kind: "task", taskNumber: Number(task[1]) };

  const channelTask = CHANNEL_TASK_RE.exec(target);
  if (channelTask) return { kind: "task", channelName: channelTask[1], taskNumber: Number(channelTask[2]) };

  const dmTask = DM_TASK_RE.exec(target);
  if (dmTask) return { kind: "task", peerName: dmTask[1], taskNumber: Number(dmTask[2]) };

  const computer = COMPUTER_RE.exec(target);
  if (computer) return { kind: "computer", machineId: computer[1].toLowerCase() };

  const app = APP_RE.exec(target);
  if (app) return { kind: "app", appId: app[1] };

  const user = USER_RE.exec(target);
  if (user) return { kind: "user", name: user[1] };

  const channel = CHANNEL_RE.exec(target);
  if (channel) return { kind: "channel", channelName: channel[1] };

  const dm = DM_RE.exec(target);
  if (dm) return { kind: "dm", peerName: dm[1] };

  return null;
}

/**
 * The conversation a task ref names: `#channel:#7` is `#channel`, `dm:@peer:#7` is `dm:@peer`. Null
 * for anything that isn't a task ref, and for the legacy `task #7`, which names no conversation.
 * By the ref's shape alone: the task isn't looked up.
 */
export function taskRefConversationTarget(target: string): string | null {
  const parsed = parseRaftRefTarget(target);
  if (parsed?.kind !== "task") return null;
  if (parsed.channelName !== undefined) return `#${parsed.channelName}`;
  if (parsed.peerName !== undefined) return `dm:@${parsed.peerName}`;
  return null;
}

export function formatRaftRefTarget(target: RaftRefTarget): RaftTargetString {
  switch (target.kind) {
    case "user":
      return `@${target.name}`;
    case "computer":
      return `computer:${target.machineId}`;
    case "app":
      return `app:${target.appId}`;
    case "channel":
      return `#${target.channelName}`;
    case "channel-thread":
      return `#${target.channelName}:${target.threadShortId}`;
    case "dm":
      return `dm:@${target.peerName}`;
    case "dm-thread":
      return `dm:@${target.peerName}:${target.threadShortId}`;
    case "task":
      if (target.channelName !== undefined) return formatRaftChannelTaskRef(target.channelName, target.taskNumber);
      if (target.peerName !== undefined) return formatRaftDmTaskRef(target.peerName, target.taskNumber);
      return `task #${target.taskNumber}`;
    case "message":
      return target.threadParentShortId
        ? `#${target.channelName}:${target.threadParentShortId} msg=${target.messageId}`
        : `#${target.channelName} msg=${target.messageId}`;
    case "dm-message":
      return target.threadParentShortId
        ? `dm:@${target.peerName}:${target.threadParentShortId} msg=${target.messageId}`
        : `dm:@${target.peerName} msg=${target.messageId}`;
  }
}

export interface ExtractedRaftRefTarget {
  raw: string;
  target: RaftRefTarget;
  start: number;
  end: number;
}

export interface ExtractRaftRefTargetsOptions {
  dedupe?: boolean;
  includeMarkdownCode?: boolean;
}

/**
 * Run `replacer` over every stretch of `source` outside markdown code, as the
 * markdown parser sees it (task #762: `~~~` fences, longer backtick runs and
 * unclosed fences included), and return the reassembled text. Code is copied
 * through unchanged.
 */
export function replaceOutsideMarkdownCode(
  source: string,
  replacer: (chunk: string) => string,
): string {
  let output = "";
  let cursor = 0;
  visitOutsideRanges(source, markdownStructure(source).code, (chunk, offset) => {
    output += source.slice(cursor, offset) + replacer(chunk);
    cursor = offset + chunk.length;
  });
  return output + source.slice(cursor);
}

/** Visit each stretch of `source` outside markdown code, with its offset. */
export function visitOutsideMarkdownCode(
  source: string,
  visitor: (chunk: string, offset: number) => void,
) {
  visitOutsideRanges(source, markdownStructure(source).code, visitor);
}

// A bare URL the parser did not link (glued to a word, e.g. `seehttps://…`)
// is still a link on the web (remarkAutolinkBareUrls), so its `@` is not a
// mention either.
const BARE_URL_PATTERN = /https?:\/\/[^\s<>]+/g;

/**
 * What mention matching does not read inside prose, applied in this order:
 * an escaped user ref (`\<@dave>`) is taken out, a bare URL becomes a space.
 */
const MENTION_PROSE_MASKS: ReadonlyArray<readonly [pattern: RegExp, replacement: string]> = [
  [/\\<@[\p{L}\p{N}_-]+>/gu, ""],
  [BARE_URL_PATTERN, " "],
];

/**
 * Visit the source where an `@handle` is a mention: outside code, links and
 * block quotes, the same places the web renders mention chips (task #762).
 * A quote repeats someone else's words; replying with one must not notify
 * the people it names again. Labels
 * and URLs of links are not mentions; a link whose destination is a user ref
 * (`[label](<@dave>)`, `<@dave>` as an autolink) is reported as that handle.
 */
function visitMentionProseSource(
  source: string,
  visitChunk: (chunk: string, offset: number) => void,
  visitLinkedHandle: (handle: string, link: SourceRange) => void,
) {
  const { code, links, quotes } = markdownStructure(source);
  visitOutsideRanges(source, [...code, ...links, ...quotes], visitChunk);
  for (const link of links) {
    if (!link.angleBracketed) continue;
    if (quotes.some((quote) => link.start >= quote.start && link.end <= quote.end)) continue;
    const target = parseRaftRefTarget(link.url);
    if (target?.kind === "user") visitLinkedHandle(target.name, link);
  }
}

/** The same, each stretch as mention matching reads it (MENTION_PROSE_MASKS). */
function visitMentionProse(
  source: string,
  visitText: (chunk: string) => void,
  visitLinkedHandle: (handle: string) => void,
) {
  visitMentionProseSource(
    source,
    (chunk) => visitText(MENTION_PROSE_MASKS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), chunk)),
    visitLinkedHandle,
  );
}

/**
 * `chunk` as visitMentionProse reads it, with where in `chunk` each of its
 * characters was written (a replacement stands where what it replaced began).
 */
function mentionProseWithOrigins(chunk: string): { text: string; origins: number[] } {
  let text = chunk;
  let origins = Array.from({ length: chunk.length }, (_, index) => index);
  for (const [pattern, replacement] of MENTION_PROSE_MASKS) {
    let masked = "";
    const maskedOrigins: number[] = [];
    let cursor = 0;
    const keepUntil = (end: number) => {
      masked += text.slice(cursor, end);
      for (let index = cursor; index < end; index += 1) maskedOrigins.push(origins[index]!);
    };
    for (const match of text.matchAll(pattern)) {
      keepUntil(match.index);
      masked += replacement;
      for (let index = 0; index < replacement.length; index += 1) maskedOrigins.push(origins[match.index]!);
      cursor = match.index + match[0].length;
    }
    if (cursor === 0) continue;
    keepUntil(text.length);
    text = masked;
    origins = maskedOrigins;
  }
  return { text, origins };
}

export function extractRaftMentionHandles(source: string): string[] {
  const handles = new Set<string>();
  visitMentionProse(
    source,
    (chunk) => {
      for (const match of chunk.matchAll(createRaftUserRefRegex())) handles.add(match[2]);
    },
    (handle) => handles.add(handle),
  );
  return [...handles];
}

/**
 * Whether an already-selected structured mention still has an exact visible
 * token in the authored message. Code, link labels, URLs and block quotes stay
 * non-mention surfaces, matching free-text extraction and the web's mention chips.
 */
export function structuredRaftMentionStillAppears(source: string, handle: string): boolean {
  const mentionRegex = createRaftStructuredUserRefRegex(handle);
  if (!mentionRegex) return false;
  let appears = false;
  visitMentionProse(
    source,
    (chunk) => {
      mentionRegex.lastIndex = 0;
      if (mentionRegex.test(chunk)) appears = true;
    },
    (linked) => {
      if (linked === handle) appears = true;
    },
  );
  return appears;
}

/**
 * Where an already-selected structured mention is written as one in `source`,
 * in order: each `@handle` in the text structuredRaftMentionStillAppears
 * reads, and each link whose destination is that user ref. What draws a stored
 * mention draws it here and nowhere else, so a name in code, a link or a
 * block quote stays words where it is shown, as it is where it is counted.
 */
export function structuredRaftMentionRanges(source: string, handle: string): SourceRange[] {
  const mentionRegex = createRaftStructuredUserRefRegex(handle);
  if (!mentionRegex) return [];
  const ranges: SourceRange[] = [];
  visitMentionProseSource(
    source,
    (chunk, offset) => {
      const { text, origins } = mentionProseWithOrigins(chunk);
      for (const match of text.matchAll(mentionRegex)) {
        const first = origins[match.index]!;
        const last = origins[match.index + match[0].length - 1]!;
        // A name that only reads as one once something between its letters is
        // taken out is not written in one place: nothing to draw.
        if (last - first !== match[0].length - 1) continue;
        ranges.push({ start: offset + first, end: offset + last + 1 });
      }
    },
    (linked, link) => {
      if (linked === handle) ranges.push({ start: link.start, end: link.end });
    },
  );
  return ranges.sort((a, b) => a.start - b.start);
}

function collectParsedRef(
  refs: Map<string, ExtractedRaftRefTarget>,
  raw: string,
  start: number,
  end: number,
  dedupe: boolean,
) {
  const target = parseRaftRefTarget(raw);
  if (!target) return;
  const canonical = formatRaftRefTarget(target);
  refs.set(dedupe ? canonical : `${start}:${end}:${canonical}`, { raw, target, start, end });
}

function extractRaftRefTargetsFromChunk(
  chunk: string,
  chunkOffset: number,
  dedupe: boolean,
): Map<string, ExtractedRaftRefTarget> {
  const refs = new Map<string, ExtractedRaftRefTarget>();
  const occupiedRanges: { start: number; end: number }[] = [];

  function occupy(match: RegExpMatchArray) {
    if (match.index === undefined) return;
    occupiedRanges.push({ start: match.index, end: match.index + match[0].length });
  }

  function isInsideOccupied(match: RegExpMatchArray, offset = 0): boolean {
    if (match.index === undefined) return false;
    const start = match.index + offset;
    const end = start + match[0].length - offset;
    return occupiedRanges.some((range) => start >= range.start && end <= range.end);
  }

  // A resource ref's human-readable label may intentionally begin with `@`,
  // but it is presentation, not a user/agent reference. Occupy the whole named
  // link before the bare scanners run while the angle-target pass below still
  // records the typed Computer/App identity itself.
  for (const match of chunk.matchAll(/\[((?:\\.|[^\]\\])*)\]\(<([^<>\n]+)>\)/g)) {
    const target = parseRaftRefTarget(match[2] ?? "");
    if (target?.kind === "computer" || target?.kind === "app") occupy(match);
  }

  for (const match of chunk.matchAll(new RegExp(String.raw`<([^<>\n]+)>`, "gu"))) {
    const raw = match[1] ?? "";
    const rawStart = (match.index ?? 0) + 1;
    collectParsedRef(refs, raw, chunkOffset + rawStart, chunkOffset + rawStart + raw.length, dedupe);
    occupy(match);
  }

  for (const match of chunk.matchAll(createRaftMessageRefRegex())) {
    collectParsedRef(
      refs,
      match[2] ? `#${match[1]}:${match[2]} msg=${match[3]}` : `#${match[1]} msg=${match[3]}`,
      chunkOffset + (match.index ?? 0),
      chunkOffset + (match.index ?? 0) + match[0].length,
      dedupe,
    );
    occupy(match);
  }
  for (const match of chunk.matchAll(createRaftDmTaskRefRegex())) {
    if (isInsideOccupied(match)) continue;
    collectParsedRef(
      refs,
      formatRaftDmTaskRef(match[1], Number(match[2])),
      chunkOffset + (match.index ?? 0),
      chunkOffset + (match.index ?? 0) + match[0].length,
      dedupe,
    );
    occupy(match);
  }
  for (const match of chunk.matchAll(createRaftDmThreadRefRegex())) {
    collectParsedRef(
      refs,
      `dm:@${match[1]}:${match[2]}`,
      chunkOffset + (match.index ?? 0),
      chunkOffset + (match.index ?? 0) + match[0].length,
      dedupe,
    );
    occupy(match);
  }
  for (const match of chunk.matchAll(createRaftDmRefRegex())) {
    if (isInsideOccupied(match)) continue;
    collectParsedRef(
      refs,
      `dm:@${match[1]}`,
      chunkOffset + (match.index ?? 0),
      chunkOffset + (match.index ?? 0) + match[0].length,
      dedupe,
    );
    occupy(match);
  }
  for (const match of chunk.matchAll(createRaftMalformedDmKindRefRegex())) {
    if (!isInsideOccupied(match)) occupy(match);
  }
  for (const match of chunk.matchAll(createRaftChannelThreadRefRegex())) {
    if (isInsideOccupied(match)) continue;
    collectParsedRef(
      refs,
      `#${match[1]}:${match[2]}`,
      chunkOffset + (match.index ?? 0),
      chunkOffset + (match.index ?? 0) + match[0].length,
      dedupe,
    );
    occupy(match);
  }
  for (const match of chunk.matchAll(createRaftChannelTaskRefRegex())) {
    if (isInsideOccupied(match)) continue;
    collectParsedRef(
      refs,
      formatRaftChannelTaskRef(match[1], Number(match[2])),
      chunkOffset + (match.index ?? 0),
      chunkOffset + (match.index ?? 0) + match[0].length,
      dedupe,
    );
    occupy(match);
  }
  for (const match of chunk.matchAll(createRaftBareTaskRefRegex())) {
    // `#12/7` is a task in channel `12`, not task #12.
    if (isInsideOccupied(match, match[1].length)) continue;
    const raw = `task #${match[3]}`;
    const rawStart = (match.index ?? 0) + match[1].length;
    collectParsedRef(
      refs,
      raw,
      chunkOffset + rawStart,
      chunkOffset + rawStart + match[0].length - match[1].length,
      dedupe,
    );
    occupy(match);
  }
  for (const match of chunk.matchAll(createRaftUserRefRegex())) {
    if (isInsideOccupied(match)) continue;
    const rawStart = (match.index ?? 0) + match[1].length;
    collectParsedRef(
      refs,
      `@${match[2]}`,
      chunkOffset + rawStart,
      chunkOffset + (match.index ?? 0) + match[0].length,
      dedupe,
    );
    occupy(match);
  }
  for (const match of chunk.matchAll(createRaftChannelRefRegex())) {
    if (isInsideOccupied(match)) continue;
    collectParsedRef(
      refs,
      `#${match[1]}`,
      chunkOffset + (match.index ?? 0),
      chunkOffset + (match.index ?? 0) + match[0].length,
      dedupe,
    );
    occupy(match);
  }

  return refs;
}

export function extractRaftRefTargets(
  source: string,
  options: ExtractRaftRefTargetsOptions = {},
): ExtractedRaftRefTarget[] {
  const refs = new Map<string, ExtractedRaftRefTarget>();
  const dedupe = options.dedupe ?? true;

  const collectChunk = (chunk: string, offset: number) => {
    const chunkRefs = extractRaftRefTargetsFromChunk(chunk, offset, dedupe);
    for (const [key, value] of chunkRefs) refs.set(key, value);
  };

  if (options.includeMarkdownCode) {
    collectChunk(source, 0);
  } else {
    visitOutsideMarkdownCode(source, collectChunk);
  }

  return [...refs.values()].sort((a, b) => a.start - b.start || a.end - b.end);
}
