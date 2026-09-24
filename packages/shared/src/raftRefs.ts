export const RAFT_REF_CHANNEL_NAME_PATTERN = String.raw`[\p{L}\p{N}_-]+`;
export const RAFT_REF_USER_NAME_PATTERN = RAFT_REF_CHANNEL_NAME_PATTERN;
// Built-in app conversations use dotted peer names. Keep this a literal
// peer-name grammar (not a path/glob): dots are the only addition to the
// existing word/hyphen alphabet.
export const RAFT_REF_DM_PEER_PATTERN = String.raw`[\w.-]+`;
export const RAFT_REF_THREAD_SHORT_ID_PATTERN = String.raw`[\da-f]{6,8}`;
export const RAFT_REF_MESSAGE_ID_PATTERN = String.raw`[A-Za-z0-9][A-Za-z0-9-]{1,63}`;
export const RAFT_REF_TASK_NUMBER_PATTERN = String.raw`[1-9]\d*`;
export const RAFT_REF_COMPUTER_ID_PATTERN = String.raw`[\da-f]{8}-[\da-f]{4}-[1-5][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}`;
export const RAFT_REF_APP_ID_PATTERN = String.raw`[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+`;

export function createRaftUserRefRegex(): RegExp {
  return new RegExp(`(^|[^\\p{L}\\p{N}_-])@(${RAFT_REF_USER_NAME_PATTERN})`, "gu");
}

/**
 * Match one identity-backed mention that the composer already resolved.
 *
 * Unlike free-text discovery, this intentionally has no left boundary: a
 * selected mention remains an entity in `草案@Mona` or `draft@Mona`. The
 * caller must already hold structured identity metadata for `handle`; using
 * this regex to discover mentions in arbitrary text would turn emails and
 * package-like strings into accidental notifications.
 */
export function createRaftStructuredUserRefRegex(handle: string): RegExp | null {
  if (!new RegExp(`^${RAFT_REF_USER_NAME_PATTERN}$`, "u").test(handle)) return null;
  const escapedHandle = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@${escapedHandle}(?![\\p{L}\\p{N}_-])`, "gu");
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

export function createRaftMessageRefRegex(): RegExp {
  return new RegExp(
    `#(${RAFT_REF_CHANNEL_NAME_PATTERN})(?::(${RAFT_REF_THREAD_SHORT_ID_PATTERN}))?\\s+msg=(${RAFT_REF_MESSAGE_ID_PATTERN})`,
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
  | { kind: "task"; taskNumber: number }
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
  | `task #${number}` // task
  | `#${string} msg=${string}` // message, top-level
  | `#${string}:${string} msg=${string}` // message, in a thread
  | `dm:@${string} msg=${string}` // dm message, top-level
  | `dm:@${string}:${string} msg=${string}`; // dm message, in a thread

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

interface MarkdownCodeSpan {
  start: number;
  end: number;
}

function markdownCodeSpans(source: string): MarkdownCodeSpan[] {
  const spans: MarkdownCodeSpan[] = [];
  const fenced = /```[\s\S]*?```/g;
  for (const match of source.matchAll(fenced)) {
    spans.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
  }

  // FIX A -- scan for inline code only OUTSIDE the fenced regions.
  //
  // Previously the inline pass ran over the whole source and kept any match not
  // WHOLLY inside a fence. A fence's closing backticks and the opening backtick
  // of a following wrapped name therefore paired into a span straddling the
  // fence boundary. That is the commonest shape we write -- a code block, then
  // a backtick-wrapped name -- and the straddle made every consumer's forward
  // cursor skip past the wrapped name into prose, so it was extracted and, on
  // the delivery face, actually paged the person (probe c548d35f; the same
  // message without the fence, 48ca364e, did not page).
  //
  // Discarding straddling matches after the fact is NOT enough: matchAll has
  // already consumed the real name's opening backtick, so its true span is
  // never found and the name still lands in prose. The scan itself has to be
  // confined to the gaps between fences.
  const fences = [...spans];
  const scanInline = (from: number, to: number) => {
    if (from >= to) return;
    const segment = source.slice(from, to);
    for (const match of segment.matchAll(/``[^`]+``|`[^`]+`/g)) {
      const start = from + (match.index ?? 0);
      spans.push({ start, end: start + match[0].length });
    }
  };
  let cursor = 0;
  for (const fence of fences) {
    scanInline(cursor, fence.start);
    cursor = fence.end;
  }
  scanInline(cursor, source.length);

  return spans.sort((a, b) => a.start - b.start);
}

export function replaceOutsideMarkdownCode(
  source: string,
  replacer: (chunk: string) => string,
): string {
  const spans = markdownCodeSpans(source);
  if (spans.length === 0) return replacer(source);

  let output = "";
  let cursor = 0;
  for (const span of spans) {
    // FIX B -- tolerate ranges that overlap or trail the cursor.
    //
    // Independent of FIX A: this walk assumed the ranges were disjoint and
    // ascending, so a straddling range re-emitted [span.start, cursor) -- text
    // already written -- and skipped the replacer for it.
    //
    // The two fixes are NOT equivalent, and an earlier draft of this comment
    // said they were. Measured per-fix (@Huaihuai, four-cell matrix):
    //
    //   variant   extraction (S1)          identity (duplication)
    //   neither   leaks                    broken
    //   A only    clean                    ok
    //   B only    LEAKS                    ok
    //   both      clean                    ok
    //
    // So A alone closes both the leak and the duplication; B alone closes only
    // the duplication.
    //
    // What each deletion would cost, also measured -- and the asymmetry is the
    // opposite of what you would guess:
    //
    //   drop A, keep B  =>  S1 goes red      => the criteria CATCH it
    //                       (harmful, but detectable)
    //   drop B, keep A  =>  both faces green => the criteria MISS it
    //                       (undetectable, and harmless today)
    //
    // The harmful deletion is the detectable one. So B is not here to prevent a
    // regression -- S1 already does that. B is here so that the depth survives:
    // it keeps the walk independent of whether ranges overlap, which is the
    // margin that matters only if A itself ever regresses. That kind of value
    // is the easiest thing to delete during a tidy-up, because by definition it
    // produces no signal while everything is working.
    if (span.end <= cursor) continue;
    const start = span.start > cursor ? span.start : cursor;
    if (start > cursor) output += replacer(source.slice(cursor, start));
    output += source.slice(start, span.end);
    cursor = span.end;
  }
  if (cursor < source.length) output += replacer(source.slice(cursor));
  return output;
}

function visitMarkdownProseChunks(
  source: string,
  visitor: (chunk: string, offset: number) => void,
) {
  const spans = markdownCodeSpans(source);
  if (spans.length === 0) {
    visitor(source, 0);
    return;
  }

  let cursor = 0;
  for (const span of spans) {
    // FIX B (same defect, second consumer). Here a straddling range silently
    // swallowed prose instead of duplicating it -- the visitor was never
    // called for it -- so the failure was invisible rather than visible.
    if (span.end <= cursor) continue;
    const start = span.start > cursor ? span.start : cursor;
    if (start > cursor) visitor(source.slice(cursor, start), cursor);
    cursor = span.end;
  }
  if (cursor < source.length) visitor(source.slice(cursor), cursor);
}

export function extractRaftMentionHandles(source: string): string[] {
  const handles = new Set<string>();

  replaceOutsideMarkdownCode(source, (chunk) => {
    const withoutEscapedAngleRefs = chunk.replace(/\\<@[\p{L}\p{N}_-]+>/gu, "");
    const withoutResourceRefLabels = withoutEscapedAngleRefs.replace(
      /\[((?:\\.|[^\]\\])*)\]\(<([^<>\n]+)>\)/g,
      (match, _label: string, rawTarget: string) => {
        const target = parseRaftRefTarget(rawTarget);
        return target?.kind === "computer" || target?.kind === "app" ? "" : match;
      },
    );
    for (const match of withoutResourceRefLabels.matchAll(createRaftUserRefRegex())) {
      handles.add(match[2]);
    }
    return chunk;
  });

  return [...handles];
}

/**
 * Whether an already-selected structured mention still has an exact visible
 * token in the authored message. Code spans/blocks and typed resource-ref
 * labels stay non-mention surfaces, matching free-text extraction.
 */
export function structuredRaftMentionStillAppears(source: string, handle: string): boolean {
  const mentionRegex = createRaftStructuredUserRefRegex(handle);
  if (!mentionRegex) return false;
  let appears = false;

  replaceOutsideMarkdownCode(source, (chunk) => {
    if (appears) return chunk;
    const withoutEscapedAngleRefs = chunk.replace(/\\<@[\p{L}\p{N}_-]+>/gu, "");
    const withoutResourceRefLabels = withoutEscapedAngleRefs.replace(
      /\[((?:\\.|[^\]\\])*)\]\(<([^<>\n]+)>\)/g,
      (match, _label: string, rawTarget: string) => {
        const target = parseRaftRefTarget(rawTarget);
        return target?.kind === "computer" || target?.kind === "app" ? "" : match;
      },
    );
    mentionRegex.lastIndex = 0;
    appears = mentionRegex.test(withoutResourceRefLabels);
    return chunk;
  });

  return appears;
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
  for (const match of chunk.matchAll(createRaftBareTaskRefRegex())) {
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
    visitMarkdownProseChunks(source, collectChunk);
  }

  return [...refs.values()].sort((a, b) => a.start - b.start || a.end - b.end);
}
