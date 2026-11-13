// A card's rich excerpt of a Markdown entry: its first blocks as data
// (ArtifactPreview `excerpt`'s `blocks`, shared artifactExcerptBlocks.ts;
// #proj-workspace:#220). excerpt.ts stores it beside the plain `text`, which
// markdownExcerpt makes and every older client reads.
//
// One pass over the lines, no Markdown library, for one reason: a push waits
// for this on the event loop, on up to 64 KiB an agent chose, and it has to be
// linear on hostile input (Tenny's hold, #proj-workspace:#218). Neither parser
// the repo has can say that. `marked` (the page's, content-worker) is a stack
// of backtracking regexes and isn't a Server dependency. micromark (shared's)
// walks back over every event for each closing `*` (attention's resolver) and
// re-enters every open container on each line. So this reads what a card shows,
// not all of Markdown: a nested quote is a quote, a heading in a list is the
// item's words, and where it differs from the page the card only reads a
// little differently. It draws nothing the page doesn't say.
//
// Linear because: each line is read once, by anchored patterns over a line
// with its whitespace collapsed (the fence, HTML and table loops move the same
// cursor on); a table's next line is read once more, to see that it is the
// delimiter row. Inline work is only on a block's first
// INLINE_SOURCE_MAX_CHARS, by the same passes as markdownExcerpt (readableText.ts,
// which says why each is linear) and the run pairing below, where each step
// empties a run. The pass stops as soon as the words, rows or spans are used up.
//
// Bounded because: ExcerptBlockWriter spends the shared limits (rows, bytes of
// words, spans) as it writes, and what is left over the JSON limit goes last
// block first. The result goes through parseArtifactExcerptBlocks like anything
// a client reads.
//
// Inert because: every string here is shown as a text node, and nothing keeps
// a URL. Characters are as markdownExcerpt's: no control or format character,
// and outside code no `<` that could start a tag (noTagStart, per span).
import {
  ARTIFACT_EXCERPT_BLOCKS_MAX_BYTES,
  ARTIFACT_EXCERPT_BLOCKS_MAX_ROWS,
  ARTIFACT_EXCERPT_BLOCKS_MAX_SPANS,
  ARTIFACT_EXCERPT_BLOCKS_MAX_TEXT_BYTES,
  ARTIFACT_EXCERPT_CODE_LINE_MAX_CHARS,
  ARTIFACT_EXCERPT_CODE_MAX_LINES,
  ARTIFACT_EXCERPT_IMAGE_ALT_MAX_CHARS,
  ARTIFACT_EXCERPT_TABLE_MAX_COLUMNS,
  ARTIFACT_EXCERPT_TABLE_MAX_ROWS,
  parseArtifactExcerptBlocks,
  type ArtifactExcerptBlock,
  type ArtifactExcerptListItem,
  type ArtifactExcerptSpan,
} from "@botiverse/raft-shared";
import { attributeOf, BLOCKS, CODE_MARK_FIRST, EXCERPT_SKIPPED_BLOCK, excerptSource, maskCodeSpans, noTagStart, reduceInline, withoutInlineMarkup } from "./readableText";

/** A block's source read for its words: twice the words a card may hold, as a link's URL or a span's markers go. */
const INLINE_SOURCE_MAX_CHARS = 2 * ARTIFACT_EXCERPT_BLOCKS_MAX_TEXT_BYTES;

/** Script-like blocks a page shows nothing of; the others EXCERPT_SKIPPED_BLOCK names draw something there. */
const INVISIBLE_BLOCKS = new Set(["script", "style", "noscript", "template"]);

/** The first `max` code units, not ending inside a code point (Postgres refuses a lone surrogate in jsonb). */
const cutUnits = (text: string, max: number): string =>
  (text.length <= max ? text : text.slice(0, max).replace(/[\uD800-\uDBFF]$/, ""));

/** The first `max` code points. */
const clipChars = (text: string, max: number): string => Array.from(cutUnits(text, max * 2)).slice(0, max).join("");

/** The longest start of `text` of at most `max` UTF-8 bytes, whole code points only. */
function clipBytes(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text;
  let bytes = 0;
  let end = 0;
  for (const point of text) {
    bytes += Buffer.byteLength(point);
    if (bytes > max) break;
    end += point.length;
  }
  return text.slice(0, end);
}

const WORD = /[\p{L}\p{N}]/u;
const isSpace = (character: string | undefined): boolean => character === undefined || character === " ";

/** Which of a line's `*` and `_` runs pair up, and what each run left over: withoutPairedAsterisks' rule, with `_` read at a word's edge. */
function pairRuns(line: string, runs: RegExpExecArray[]): { left: number[]; bold: number[]; italic: number[] } {
  const left = runs.map((run) => run[0].length);
  const bold = runs.map(() => 0);
  const italic = runs.map(() => 0);
  const open = new Map<string, number[]>([["*", []], ["_", []]]);
  runs.forEach((run, at) => {
    const marker = run[0][0]!;
    const stack = open.get(marker)!;
    const before = line[run.index - 1];
    const after = line[run.index + run[0].length];
    const underscore = marker === "_";
    const closes = !isSpace(before) && (!underscore || after === undefined || !WORD.test(after));
    const opens = !isSpace(after) && (!underscore || before === undefined || !WORD.test(before));
    while (closes && left[at]! > 0 && stack.length > 0) {
      const opener = stack[stack.length - 1]!;
      const paired = Math.min(left[opener]!, left[at]!);
      left[opener]! -= paired;
      left[at]! -= paired;
      // Two markers are bold, one italic, three both.
      bold[opener]! += paired >> 1;
      bold[at]! -= paired >> 1;
      italic[opener]! += paired & 1;
      italic[at]! -= paired & 1;
      if (left[opener] === 0) stack.pop();
    }
    if (left[at]! > 0 && opens) stack.push(at);
  });
  return { left, bold, italic };
}

/** A run that paired with nothing, at a word's edge: a bold cut off by the block's end, not a `2 * 3` or a `snake_case`. */
function atWordEdge(line: string, run: RegExpExecArray): boolean {
  const before = line[run.index - 1];
  const after = line[run.index + run[0].length];
  return ((before === undefined || !WORD.test(before)) && !isSpace(after))
    || (!isSpace(before) && (after === undefined || !WORD.test(after)));
}

const CODE_MARK = /[\uE000-\uF8FF]/;
const CODE_MARK_SPLIT = /([\uE000-\uF8FF])/;

const sameStyle = (a: ArtifactExcerptSpan, b: ArtifactExcerptSpan): boolean => a.bold === b.bold && a.italic === b.italic && a.code === b.code;

/** A block's words as spans: what reduceInline makes, with bold, italic and code kept apart. Links are their words; images, tags and comments go. */
function excerptSpans(source: string): ArtifactExcerptSpan[] {
  const { masked, spans: codeSpans } = maskCodeSpans(cutUnits(source, INLINE_SOURCE_MAX_CHARS));
  const line = withoutInlineMarkup(masked);
  const spans: ArtifactExcerptSpan[] = [];
  const push = (span: ArtifactExcerptSpan) => {
    if (span.text === "") return;
    const last = spans[spans.length - 1];
    if (last && sameStyle(last, span)) last.text += span.text;
    else spans.push(span);
  };
  let bold = 0;
  let italic = 0;
  const pushWords = (words: string) => {
    const style = { ...(bold > 0 ? { bold: true as const } : {}), ...(italic > 0 ? { italic: true as const } : {}) };
    // Split on the code spans' marks (private use: the source has none left).
    for (const part of words.split(CODE_MARK_SPLIT)) {
      if (part.length === 1 && CODE_MARK.test(part)) push({ text: codeSpans[part.charCodeAt(0) - CODE_MARK_FIRST] ?? "", ...style, code: true });
      else push({ text: noTagStart(part.replace(/\\([\\`*_{}[\]()#+.!|<>~-])/g, "$1").replace(/ +/g, " ")), ...style });
    }
  };
  const runs = [...line.matchAll(/\\.|\*+|_+/g)].filter((run) => run[0][0] !== "\\");
  const { left, bold: boldAt, italic: italicAt } = pairRuns(line, runs);
  let from = 0;
  runs.forEach((run, at) => {
    pushWords(line.slice(from, run.index));
    bold += boldAt[at]!;
    italic += italicAt[at]!;
    if (left[at]! > 0 && !atWordEdge(line, run)) pushWords(run[0].slice(0, left[at]));
    from = run.index + run[0].length;
  });
  pushWords(line.slice(from));
  return trimSpans(spans);
}

/** No space at either end of a block's words. */
function trimSpans(spans: ArtifactExcerptSpan[]): ArtifactExcerptSpan[] {
  while (spans.length > 0 && spans[0]!.text.trim() === "") spans.shift();
  while (spans.length > 0 && spans[spans.length - 1]!.text.trim() === "") spans.pop();
  if (spans.length === 0) return spans;
  spans[0]!.text = spans[0]!.text.trimStart();
  spans[spans.length - 1]!.text = spans[spans.length - 1]!.text.trimEnd();
  return spans;
}

/** The blocks so far and what they may still spend (shared artifactExcerptBlocks.ts). */
class ExcerptBlockWriter {
  readonly blocks: ArtifactExcerptBlock[] = [];
  rows = ARTIFACT_EXCERPT_BLOCKS_MAX_ROWS;
  private bytes = ARTIFACT_EXCERPT_BLOCKS_MAX_TEXT_BYTES;
  private spans = ARTIFACT_EXCERPT_BLOCKS_MAX_SPANS;

  get full(): boolean {
    return this.rows <= 0 || this.bytes <= 0 || this.spans <= 0;
  }

  private spendWords(text: string): string {
    const kept = clipBytes(text, this.bytes);
    // Cut, or nothing fits: the words are used up, whatever is left of them.
    this.bytes = kept.length < text.length ? 0 : this.bytes - Buffer.byteLength(kept);
    return kept;
  }

  /** As many of `source`'s spans as there is room for. */
  private take(source: string): ArtifactExcerptSpan[] {
    const kept: ArtifactExcerptSpan[] = [];
    for (const span of excerptSpans(source)) {
      if (this.bytes <= 0 || this.spans <= 0) break;
      const text = this.spendWords(span.text);
      this.spans -= 1;
      if (text !== "") kept.push({ ...span, text });
    }
    return kept;
  }

  /** Nothing past the rows: a line can flush an open block and then write its own. */
  private write(block: ArtifactExcerptBlock, rows = 1) {
    if (rows > this.rows) return;
    this.blocks.push(block);
    this.rows -= rows;
  }

  words(type: "paragraph" | "quote", source: string) {
    const spans = this.take(source);
    if (spans.length > 0) this.write({ type, spans });
  }

  heading(level: number, source: string) {
    const spans = this.take(source);
    if (spans.length > 0) this.write({ type: "heading", level, spans });
  }

  list(items: readonly OpenListItem[]) {
    const kept: ArtifactExcerptListItem[] = [];
    for (const { source, ...item } of items) {
      if (this.full || kept.length >= this.rows) break;
      const spans = this.take(source);
      if (spans.length > 0) kept.push({ ...item, spans });
    }
    if (kept.length > 0) this.write({ type: "list", items: kept }, kept.length);
  }

  code(lines: readonly string[]) {
    const kept: string[] = [];
    for (const line of lines.slice(0, Math.min(this.rows, ARTIFACT_EXCERPT_CODE_MAX_LINES))) {
      kept.push(this.spendWords(clipChars(line, ARTIFACT_EXCERPT_CODE_LINE_MAX_CHARS)));
      if (this.bytes <= 0) break;
    }
    while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
    if (kept.length > 0) this.write({ type: "code", lines: kept }, kept.length);
  }

  table(header: readonly string[], rows: readonly (readonly string[])[]) {
    const cells = (row: readonly string[]) => row.slice(0, ARTIFACT_EXCERPT_TABLE_MAX_COLUMNS).map((cell) => this.take(cell));
    const head = cells(header);
    const body: ArtifactExcerptSpan[][][] = [];
    for (const row of rows.slice(0, ARTIFACT_EXCERPT_TABLE_MAX_ROWS)) {
      if (this.full || body.length + 2 > this.rows) break;
      body.push(cells(row));
    }
    this.write({ type: "table", header: head, rows: body }, 1 + body.length);
  }

  image(alt: string) {
    this.write({ type: "image", alt: this.spendWords(reduceInline(clipChars(alt, ARTIFACT_EXCERPT_IMAGE_ALT_MAX_CHARS)).trim()) });
  }

  /** A line of several images: one row, however many. */
  images(count: number) {
    this.write({ type: "images", count });
  }

  /** Several blocks of HTML in a row (a page's layout) say the one thing. */
  diagram() {
    if (this.blocks[this.blocks.length - 1]?.type !== "diagram") this.write({ type: "diagram" });
  }

  rule() {
    this.write({ type: "rule" });
  }
}

type OpenListItem = Omit<ArtifactExcerptListItem, "spans"> & { source: string };
type OpenBlock =
  | { kind: "paragraph" | "quote"; source: string }
  | { kind: "list"; base: number; blank: boolean; items: OpenListItem[] };

/** `source` and a next line, as far as anyone reads it (a wrapped line is a space in Markdown). */
function joined(source: string, line: string): string {
  if (source.length >= INLINE_SOURCE_MAX_CHARS) return source;
  return cutUnits(source === "" ? line : `${source} ${line}`, INLINE_SOURCE_MAX_CHARS);
}

/** How far in a line starts, a tab counting as 4. */
function indentOf(raw: string): number {
  let width = 0;
  for (const character of /^[ \t]*/.exec(raw)![0]) width += character === "\t" ? 4 : 1;
  return width;
}

/** A line of nothing but three or more of the same `-`, `*` or `_`. */
function isRule(line: string): boolean {
  if (!/^[-*_ ]+$/.test(line)) return false;
  const marks = line.replaceAll(" ", "");
  return marks.length >= 3 && marks === marks[0]!.repeat(marks.length);
}

/** The cells of a table row; an escaped `|` is a cell's. */
const cellsOf = (row: string): string[] =>
  row.replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map((cell) => cell.trim());

/** The columns `raw`, a table's delimiter row, says there are; 0 when it is no such row. */
function delimiterColumns(raw: string): number {
  const row = raw.replaceAll(" ", "").trim();
  if (!/^[|:-]+$/.test(row) || !/^\|?:?-+:?(?:\|:?-+:?)*\|?$/.test(row)) return 0;
  return cellsOf(row).length;
}

/** An image, or an image that is a link, alone: `![alt](src)`, `![alt][ref]`, `[![alt](src)](href)`. */
const IMAGE = / ?(?:!\[([^[\]]*)\](?:\([^()]*\)|\[[^[\]]*\])|\[!\[([^[\]]*)\](?:\([^()]*\)|\[[^[\]]*\])\](?:\([^()]*\)|\[[^[\]]*\]))/gy;

/** The alt texts of a line that holds images and nothing else, else null. Each match starts where the last ended, so nothing is read twice. */
function imagesOf(line: string): string[] | null {
  const alts: string[] = [];
  let end = 0;
  for (const match of line.matchAll(IMAGE)) {
    alts.push(match[1] ?? match[2] ?? "");
    end = match.index + match[0].length;
  }
  return alts.length > 0 && end === line.length ? alts : null;
}

/** The index after the first line from `from` holding `needle` (lowercase), or the end. */
function afterLineWith(lines: readonly string[], from: number, needle: string): number {
  for (let at = from; at < lines.length; at += 1) {
    if (lines[at]!.toLowerCase().includes(needle)) return at + 1;
  }
  return lines.length;
}

/** The index of the next blank line from `from`, or the end. */
function blankLineFrom(lines: readonly string[], from: number): number {
  for (let at = from; at < lines.length; at += 1) {
    if (lines[at]!.trim() === "") return at;
  }
  return lines.length;
}

/** A fence's lines (at most `keep`, without the fence's own `indent` characters) and the index after it. An unclosed fence runs to the end. */
function fencedLines(lines: readonly string[], from: number, marker: string, indent: number, keep: number): { kept: string[]; next: number } {
  const kept: string[] = [];
  for (let at = from; at < lines.length; at += 1) {
    const raw = lines[at]!;
    const line = raw.trim();
    if (line.length >= marker.length && line[0] === marker[0] && (/^`+$/.test(line) || /^~+$/.test(line))) return { kept, next: at + 1 };
    if (kept.length < keep) kept.push(raw.slice(Math.min(indent, /^[ \t]*/.exec(raw)![0].length)).trimEnd());
  }
  return { kept, next: lines.length };
}

/** An indented code block's lines from `from` (at most `keep`) and the index after it. */
function indentedLines(lines: readonly string[], from: number, keep: number): { kept: string[]; next: number } {
  const kept: string[] = [];
  let at = from;
  for (; at < lines.length; at += 1) {
    const raw = lines[at]!;
    if (raw.trim() !== "" && !/^(?: {4}|\t)/.test(raw)) break;
    if (kept.length < keep) kept.push(raw.replace(/^(?: {4}|\t)/, "").trimEnd());
  }
  return { kept, next: at };
}

const OPENING_TAG = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/;
const LIST_ITEM = /^(?:[-*+]|(\d{1,9})[.)])(?: +|$)(?:\[([ xX])\](?: +|$))?/;
const HEADING = /^(#{1,6})(?: +|$)/;

/**
 * A line starting with a tag, when it is one of the HTML block's: writes what it
 * says and answers the index to go on from; null when it is a paragraph's.
 */
function htmlLine(out: ExcerptBlockWriter, lines: readonly string[], at: number, line: string, inParagraph: boolean, flush: () => void): number | null {
  const skipped = EXCERPT_SKIPPED_BLOCK.exec(line)?.[1]?.toLowerCase();
  if (skipped) {
    flush();
    if (!INVISIBLE_BLOCKS.has(skipped)) out.diagram();
    return line.toLowerCase().includes(`</${skipped}`) ? at : afterLineWith(lines, at, `</${skipped}`);
  }
  const tag = OPENING_TAG.exec(line);
  if (!tag) return null;
  const name = tag[2]!.toLowerCase();
  // One tag and nothing else; not an autolink (`<https://a.test>`), which is a paragraph's.
  const aloneTag = /^<\/?[a-zA-Z][a-zA-Z0-9-]*(?: [^<>]*)?\/?>$/.test(line);
  // The end of a block already left, or a line break, says nothing.
  if (tag[1] === "/" || name === "br") return aloneTag && BLOCKS.has(name) ? at : null;
  if (name === "hr") {
    flush();
    out.rule();
    return at;
  }
  if (name === "img" && aloneTag) {
    flush();
    out.image(attributeOf(line, "alt") ?? "");
    return at;
  }
  if (!BLOCKS.has(name) && name !== "center" && (!aloneTag || inParagraph)) return null;
  flush();
  out.diagram();
  return blankLineFrom(lines, at);
}

/**
 * The first blocks of a Markdown entry, for a card; null when there are none or
 * they can't be drawn (the card shows its `text`). See the top of this file.
 */
export function markdownExcerptBlocks(markdown: string, title: string | null): ArtifactExcerptBlock[] | null {
  const lines = excerptSource(markdown, title).split("\n");
  const out = new ExcerptBlockWriter();
  let open: OpenBlock | null = null;
  const flush = () => {
    const closing = open;
    open = null;
    if (closing?.kind === "list") out.list(closing.items);
    else if (closing) out.words(closing.kind, closing.source);
  };

  let at = 0;
  while (at < lines.length && !out.full) {
    const raw = lines[at]!;
    const current: OpenBlock | null = open;
    at += 1;
    const line = raw.replace(/\s+/g, " ").trim();
    if (line === "") {
      if (current?.kind === "list") current.blank = true;
      else flush();
      continue;
    }
    if (current === null && /^(?: {4}|\t)/.test(raw)) {
      const { kept, next } = indentedLines(lines, at - 1, ARTIFACT_EXCERPT_CODE_MAX_LINES);
      at = next;
      out.code(kept);
      continue;
    }
    const fence = /^(?:`{3,}|~{3,})/.exec(line)?.[0];
    if (fence && (fence[0] === "~" || !line.slice(fence.length).includes("`"))) {
      flush();
      const language = /^\S*/.exec(line.slice(fence.length).trim())![0].toLowerCase();
      const mermaid = language === "mermaid";
      const { kept, next } = fencedLines(lines, at, fence, /^[ \t]*/.exec(raw)![0].length, mermaid ? 0 : ARTIFACT_EXCERPT_CODE_MAX_LINES);
      at = next;
      if (mermaid) out.diagram();
      else out.code(kept);
      continue;
    }
    if (line.startsWith("<!--")) {
      if (!line.includes("-->")) at = afterLineWith(lines, at, "-->");
      continue;
    }
    if (line[0] === "<") {
      const next = htmlLine(out, lines, at, line, current?.kind === "paragraph", flush);
      if (next !== null) {
        at = next;
        continue;
      }
    }
    if (current?.kind === "paragraph" && /^(?:=+|-+)$/.test(line)) {
      open = null;
      out.heading(line[0] === "=" ? 1 : 2, current.source);
      continue;
    }
    if (isRule(line)) {
      flush();
      out.rule();
      continue;
    }
    // A table's delimiter row with no header, a line of `=`; link and footnote definitions.
    if (/^[|:=~ -]+$/.test(line) || /^\[[^\]]*\]:/.test(line)) continue;
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      out.heading(heading[1]!.length, line.slice(heading[0].length).replace(/ #+$/, ""));
      continue;
    }
    if (line[0] === ">") {
      const words = line.replace(/^[> ]+/, "").replace(HEADING, "").replace(LIST_ITEM, "");
      if (current?.kind === "quote") {
        current.source = joined(current.source, words);
      } else {
        flush();
        open = { kind: "quote", source: words };
      }
      continue;
    }
    const item = LIST_ITEM.exec(line);
    // In a paragraph only a list starting at 1, with words, starts one (a year may end a wrapped line and a sentence).
    const interrupts = current?.kind !== "paragraph" || ((item?.[1] === undefined || Number(item[1]) === 1) && line.length > (item?.[0].length ?? 0));
    if (item && interrupts) {
      const indent = indentOf(raw);
      const list: OpenBlock = current?.kind === "list" ? current : { kind: "list", base: indent, blank: false, items: [] };
      if (list !== current) flush();
      open = list;
      list.blank = false;
      list.items.push({
        level: indent >= list.base + 2 ? 1 : 0,
        ...(item[1] === undefined ? {} : { order: Number(item[1]) }),
        ...(item[2] === undefined ? {} : { checked: item[2] !== " " }),
        source: cutUnits(line.slice(item[0].length), INLINE_SOURCE_MAX_CHARS),
      });
      if (list.items.length >= out.rows) flush();
      continue;
    }
    const columns = line.includes("|") && at < lines.length ? delimiterColumns(lines[at]!) : 0;
    const header = columns > 0 ? cellsOf(line) : null;
    if (header?.length === columns) {
      flush();
      at += 1;
      const rows: string[][] = [];
      for (; at < lines.length; at += 1) {
        const row = lines[at]!.replace(/\s+/g, " ").trim();
        if (row === "" || !row.includes("|")) break;
        if (rows.length < ARTIFACT_EXCERPT_TABLE_MAX_ROWS) rows.push(cellsOf(row));
      }
      out.table(header, rows);
      continue;
    }
    const images = current?.kind === "paragraph" ? null : imagesOf(line);
    if (images) {
      flush();
      if (images.length === 1) out.image(images[0]!);
      else out.images(images.length);
      continue;
    }
    if (current?.kind === "list") {
      if (!current.blank || indentOf(raw) >= 2) {
        const last = current.items[current.items.length - 1]!;
        last.source = joined(last.source, line);
        current.blank = false;
        continue;
      }
      flush();
    }
    if (current?.kind === "paragraph" || current?.kind === "quote") current.source = joined(current.source, line);
    else open = { kind: "paragraph", source: cutUnits(line, INLINE_SOURCE_MAX_CHARS) };
  }
  flush();

  const { blocks } = out;
  while (blocks.length > 0 && Buffer.byteLength(JSON.stringify(blocks)) > ARTIFACT_EXCERPT_BLOCKS_MAX_BYTES) blocks.pop();
  return parseArtifactExcerptBlocks(blocks);
}
