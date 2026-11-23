// An Artifact version's links to other Raft Artifacts (#proj-workspace:#336):
// read from the text of its Markdown and HTML files, so the viewer can name
// the Artifacts a page links to (their live titles) and, later, an Artifact
// can list what links to it, without anyone reading the page's DOM.
// references.ts reads the files and stores the result; this is the pure part.
//
// - Which links: an `http(s)` address (or a `//host/...` one, read as https)
//   that shared parseArtifactRef reads as an Artifact id on this deployment's
//   hosts (`appHosts`: platform/links, as message cards read links): the app's
//   `/artifacts/<id>[/v/<n>]` and `/s/<slug>/artifacts/<id>`, the redirect host,
//   the content origin. A relative link, a link by name, an old per-version
//   link and every other host name none. A link to the Artifact itself is left
//   out: its title is the page's own.
// - HTML: `<a href>` and `<area href>` (readableText.ts htmlLinks), none in a
//   comment, a script, a style, a template or another raw-text element.
// - Markdown: inline links (`[words](url)`), reference links and their
//   definitions, autolinks (`<url>`), GFM's literal links, and raw `<a href>`
//   in the page's HTML. A literal link is where the content Worker's
//   renderer (marked) makes one: it starts wherever `http(s)://` is written,
//   after any character ("结论：https://…", "abchttps://…"), and ends before
//   full-width punctuation as before a space (shared bareLinkEnd.ts:
//   "见 https://…/artifacts/X（v10）" links `…/artifacts/X`). None in fenced
//   code, an inline code span, a comment or a script-like element, and an
//   image (`![alt](src)`) isn't a link. Not a
//   CommonMark parser, on purpose: what a push makes is read on the event
//   loop, and the parsers the repo has are not linear on hostile input
//   (excerptBlocks.ts says why; Tenny's hold, #proj-workspace:#218). So a link
//   is read within one line (a link whose words wrap onto the next line is
//   missed), and an indented code block is read as text, as messages read it.
//   Every pass is linear: anchored or bounded scans, no regex that can fail a
//   start and read on.
// - `bare`: the link's text is its own address (an autolink, a literal link,
//   `[url](url)`, `<a href="url">url</a>`), by WHATWG URL comparison, as
//   message cards decide it (shared isBareLink): the only links the viewer
//   relabels with the target's title. Words the author gave a link stay.
// - Once per file and address (WHATWG `href`), in the file's order, bare when
//   any of its links is; files in the order given (references.ts: the entry
//   first, then by path); at most CONTENT_LINKS_MAX in all, the first ones.
//
// Change these rules and bump CONTENT_LINKS_EXTRACTOR: stored references are
// read again for the current version when asked for (references.ts).
import { ARTIFACT_CONTENT_LINKS_MAX, artifactFileType, FULL_WIDTH_PUNCTUATION, parseArtifactRef, type ArtifactId } from "@botiverse/raft-shared";
import { decodeCharacterReferences, htmlLinks } from "./readableText";

/** The version of the rules here, stored per version (`versions.references_extractor`). */
export const CONTENT_LINKS_EXTRACTOR = 2;
/** The most links kept of a version: the platform's per-source limit (platform/references OBJECT_REFERENCES_MAX_PER_SOURCE), and what the links route answers at most (shared ARTIFACT_CONTENT_LINKS_MAX). */
export const CONTENT_LINKS_MAX = ARTIFACT_CONTENT_LINKS_MAX;
/** The longest address kept (WHATWG href); a longer link is left out. */
export const CONTENT_LINK_HREF_MAX_CHARS = 2048;
/** The longest file path whose links are kept (UTF-8 bytes): a reference's facts stay small. */
const CONTENT_LINK_PATH_MAX_BYTES = 1024;
/** CommonMark's longest link label. */
const LABEL_MAX_CHARS = 999;
/** The longest link title read (`[words](url "title")`). */
const TITLE_MAX_CHARS = 1000;

/** A file's text, as references.ts read it (a prefix of a large file). */
export interface ContentFile {
  path: string;
  text: string;
}

/** One link of a version to another Artifact. */
export interface ContentLink {
  /** The file it is in. */
  path: string;
  /** The link's WHATWG href. */
  href: string;
  targetId: ArtifactId;
  /** The version it pins (`/v/<n>`), or null for the Artifact's current one. */
  targetVersion: number | null;
  /** Its text is its own address: the viewer may show the target's title instead. */
  bare: boolean;
}

/** A link as a file writes it: the address as written, its text (null: bare by its syntax), where it starts. */
export interface WrittenLink {
  href: string;
  text: string | null;
  offset: number;
}

/** `text` with every character but line breaks made a space: offsets stay. */
const blank = (text: string): string => text.replace(/[^\n]/g, " ");

/** `line` with each [start, end) of `ranges` blanked, in one pass (they may overlap, in any order). */
function blankRanges(line: string, ranges: ReadonlyArray<readonly [number, number]>): string {
  if (ranges.length === 0) return line;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let out = "";
  let from = 0;
  for (const [start, end] of sorted) {
    if (end <= from) continue;
    const at = Math.max(start, from);
    out += line.slice(from, at) + " ".repeat(end - at);
    from = end;
  }
  return out + line.slice(from);
}

/** The most of a link's words kept: compared with its address only, which is shorter. */
const WORDS_MAX_CHARS = 2 * CONTENT_LINK_HREF_MAX_CHARS;

/**
 * The line with its inline code spans blanked (CommonMark's: a run of
 * backticks up to the next run of the same length; an escaped one is no
 * run). `next` is worked out once from the end (readableText.ts
 * maskCodeSpans' way), so a run with no partner costs no search.
 */
function blankCodeSpans(line: string): string {
  const runs = [...line.matchAll(/\\.|`+/g)].filter((run) => run[0][0] === "`");
  if (runs.length < 2) return line;
  const next: Array<number | undefined> = runs.map(() => undefined);
  const seen = new Map<number, number>();
  for (let at = runs.length - 1; at >= 0; at -= 1) {
    next[at] = seen.get(runs[at]![0].length);
    seen.set(runs[at]![0].length, at);
  }
  const spans: Array<[number, number]> = [];
  for (let at = 0; at < runs.length;) {
    const close = next[at];
    if (close === undefined) {
      at += 1;
      continue;
    }
    spans.push([runs[at]!.index, runs[close]!.index + runs[close]![0].length]);
    at = close + 1;
  }
  return blankRanges(line, spans);
}

/** Raw-text elements whose contents a Markdown page never shows as text or links. */
const RAW_ELEMENTS = ["script", "style", "template", "textarea", "noscript", "xmp", "title"];

/**
 * Markdown with what holds no link blanked, offsets kept: fenced code (```
 * or ~~~, closed by a fence of the same character at least as long),
 * inline code spans, comments, and the contents of script-like elements.
 */
function withoutCode(markdown: string): string {
  const lines = markdown.split("\n");
  let fence: { char: string; length: number } | null = null;
  const kept = lines.map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence.char && marker.length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
      return blank(line);
    }
    if (marker && !(marker[0] === "`" && line.slice(line.indexOf(marker) + marker.length).includes("`"))) {
      fence = { char: marker[0]!, length: marker.length };
      return blank(line);
    }
    return blankCodeSpans(line);
  });
  const text = kept.join("\n");
  const lower = text.toLowerCase();
  let out = "";
  let from = 0;
  for (let at = lower.indexOf("<", from); at >= 0; at = lower.indexOf("<", Math.max(at + 1, from))) {
    let end = -1;
    if (lower.startsWith("<!--", at)) {
      const close = lower.indexOf("-->", at + 4);
      end = close < 0 ? text.length : close + 3;
    } else {
      const name = RAW_ELEMENTS.find((element) => lower.startsWith(element, at + 1) && !/[a-z0-9-]/.test(lower[at + 1 + element.length] ?? ""));
      if (name) {
        const close = lower.indexOf(`</${name}`, at + 1 + name.length);
        end = close < 0 ? text.length : close;
      }
    }
    if (end < 0) continue;
    out += text.slice(from, at) + blank(text.slice(at, end));
    from = end;
  }
  return out + text.slice(from);
}

/** A reference label as CommonMark matches it: whitespace collapsed, case folded. */
const labelKey = (label: string): string => label.replace(/\s+/g, " ").trim().toLowerCase();

/** A destination as written: backslash escapes and character references resolved. */
const destination = (raw: string): string => decodeCharacterReferences(raw.replace(/\\([!-/:-@[-`{-~])/g, "$1"));

/**
 * The inline link destination starting at `at` (just past `(`): `<…>`, or a
 * run without spaces whose parentheses balance, then an optional title and
 * `)`. Null when it isn't one. Reads at most CONTENT_LINK_HREF_MAX_CHARS and a
 * title's line, so a hostile line costs no square.
 */
function inlineDestination(line: string, at: number, budget: ScanBudget): { raw: string; end: number } | null {
  if (budget.left <= 0) return null;
  const read = destinationAt(line, at);
  budget.left -= read.read;
  return read.dest;
}

/** The most characters a file's link destinations are read for in all: past it, no `[words](url)` more is read in that file. */
const DESTINATION_SCAN_CHARS = 8 * 1024 * 1024;
/** What is left of a file's DESTINATION_SCAN_CHARS. */
interface ScanBudget {
  left: number;
}

/** inlineDestination's reading, and how many characters it read. */
function destinationAt(line: string, at: number): { dest: { raw: string; end: number } | null; read: number } {
  const none = (i: number) => ({ dest: null, read: i - at });
  let i = at;
  while (line[i] === " " || line[i] === "\t") i += 1;
  let raw: string;
  const limit = Math.min(line.length, i + CONTENT_LINK_HREF_MAX_CHARS + 2);
  if (line[i] === "<") {
    const inside = line.slice(i + 1, limit);
    const close = inside.indexOf(">");
    if (close < 0 || inside.slice(0, close).includes("<")) return none(limit);
    raw = inside.slice(0, close);
    i += close + 2;
  } else {
    const start = i;
    let depth = 0;
    for (; i < limit; i += 1) {
      const c = line[i]!;
      if (c === "\\") { i += 1; continue; }
      if (c === " " || c === "\t") break;
      if (c === "(") {
        // CommonMark's limit on nested parentheses in a destination.
        depth += 1;
        if (depth > 32) return none(i);
      } else if (c === ")") {
        if (depth === 0) break;
        depth -= 1;
      }
    }
    if (i >= limit && i < line.length) return none(i);
    raw = line.slice(start, i);
  }
  while (line[i] === " " || line[i] === "\t") i += 1;
  if (line[i] === "\"" || line[i] === "'" || line[i] === "(") {
    const closer = line[i] === "(" ? ")" : line[i]!;
    const close = line.slice(i + 1, i + 1 + TITLE_MAX_CHARS).indexOf(closer);
    if (close < 0) return none(Math.min(line.length, i + 1 + TITLE_MAX_CHARS));
    i += close + 2;
    while (line[i] === " " || line[i] === "\t") i += 1;
  }
  return line[i] === ")" ? { dest: { raw, end: i + 1 }, read: i + 1 - at } : none(i);
}

/**
 * GFM's literal links as the content Worker renders them: marked's text rule stops before
 * `http(s)://` wherever it is written, so a link starts there whatever comes before it (`：`, `（`,
 * a letter), not only after a space or `*_~(` as GFM's spec has it. One ends before whitespace,
 * `<` or full-width punctuation (shared bareLinkEnd.ts): `https://a（https://b）` is two. The
 * punctuation is out of the link's characters, not cut off after a match, and nothing is matched
 * before the link, so the pass stays linear: no start can fail after reading on.
 */
const LITERAL_LINK = new RegExp(`https?:\\/\\/[^\\s<${FULL_WIDTH_PUNCTUATION}]+`, "gi");

/** GFM's literal link's end: no trailing punctuation, nor a `)` it doesn't open. */
function trimLiteral(url: string): string {
  let end = url.length;
  let unopened = 0;
  for (const c of url) unopened += c === ")" ? 1 : c === "(" ? -1 : 0;
  for (;;) {
    const last = url[end - 1];
    if (last !== undefined && "?!.,:*_~'\";".includes(last)) {
      end -= 1;
    } else if (last === ")" && unopened > 0) {
      end -= 1;
      unopened -= 1;
    } else {
      return url.slice(0, end);
    }
  }
}

/** One line's links (its code and tags already handled by the caller), offsets from `base`. */
function lineLinks(line: string, base: number, definitions: ReadonlyMap<string, string>, found: WrittenLink[], budget: ScanBudget): void {
  const autolinks: Array<[number, number]> = [];
  // Autolinks first: `<https://…>` looks like a tag.
  for (const match of line.matchAll(/<(https?:\/\/[^\s<>]*)>/gi)) {
    // `[words](<url>)` is the link's destination, read with its brackets below.
    if (line.startsWith("](", match.index - 2)) continue;
    found.push({ href: match[1]!, text: null, offset: base + match.index });
    autolinks.push([match.index, match.index + match[0].length]);
  }
  // Tags: raw HTML's links are htmlLinks'; an attribute's address is no literal link.
  let rest = blankRanges(line, autolinks).replace(/<\/?[a-zA-Z][^<>]*>/g, blank);
  // Brackets: a stack pairs each `]` with the nearest open `[`, once.
  const openers: number[] = [];
  const syntax: Array<[number, number]> = [];
  for (let i = 0; i < rest.length; i += 1) {
    const c = rest[i];
    if (c === "\\") { i += 1; continue; }
    if (c === "[") { openers.push(i); continue; }
    if (c !== "]" || openers.length === 0) continue;
    const open = openers.pop()!;
    const image = rest[open - 1] === "!";
    // Only words short enough to be an address or a label are read (deep nesting copies nothing).
    const words = i - open - 1 <= WORDS_MAX_CHARS ? rest.slice(open + 1, i) : "";
    let href: string | null = null;
    let end = i + 1;
    if (rest[i + 1] === "(") {
      const dest = inlineDestination(rest, i + 2, budget);
      if (dest) {
        href = destination(dest.raw);
        end = dest.end;
      }
    } else if (rest[i + 1] === "[") {
      const labelled = rest.slice(i + 2, i + 3 + LABEL_MAX_CHARS);
      const close = labelled.indexOf("]");
      if (close >= 0) {
        const label = labelled.slice(0, close);
        href = definitions.get(labelKey(label === "" ? words : label)) ?? null;
        if (href !== null) end = i + 3 + close;
      }
    } else if (words.length <= LABEL_MAX_CHARS) {
      href = definitions.get(labelKey(words)) ?? null;
    }
    if (href === null) continue;
    syntax.push([image ? open - 1 : open, end]);
    if (!image) {
      found.push({ href, text: words, offset: base + open });
      // A link holds no link: no open `[` before it makes one any more.
      openers.length = 0;
    }
    i = end - 1;
  }
  rest = blankRanges(rest, syntax);
  // GFM's literal links (LITERAL_LINK).
  for (const match of rest.matchAll(LITERAL_LINK)) {
    found.push({ href: trimLiteral(match[0]), text: null, offset: base + match.index });
  }
}

/** A Markdown file's links to anywhere, in order (the header's rules). */
export function markdownLinks(markdown: string): WrittenLink[] {
  const text = withoutCode(markdown.replace(/\r\n?/g, (crlf) => " ".repeat(crlf.length - 1) + "\n"));
  const found: WrittenLink[] = htmlLinks(text).map((link) => ({ href: link.href, text: link.text, offset: link.offset }));
  const definitions = new Map<string, string>();
  const lines = text.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const definition = /^ {0,3}\[([^\]]{1,999})\]:[ \t]*(?:<([^<>\n]*)>|(\S+))/.exec(line);
    if (definition) {
      const key = labelKey(definition[1]!);
      // The first definition of a label wins.
      if (key !== "" && !definitions.has(key)) definitions.set(key, destination(definition[2] ?? definition[3]!));
      kept.push(blank(line));
    } else {
      kept.push(line);
    }
  }
  let base = 0;
  const budget: ScanBudget = { left: DESTINATION_SCAN_CHARS };
  for (const line of kept) {
    lineLinks(line, base, definitions, found, budget);
    base += line.length + 1;
  }
  return found.sort((a, b) => a.offset - b.offset);
}

/** Words as a link shows them, for comparing with its address: emphasis or code markers around them dropped. */
function shownWords(words: string): string {
  let out = words.trim();
  for (let round = 0; round < 3; round += 1) {
    const marked = /^([*_`~]+)(.+)\1$/s.exec(out);
    if (!marked) break;
    out = marked[2]!.trim();
  }
  return out.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

/** Whether `words` are the link's own address (shared isBareLink's rule: equal WHATWG hrefs). */
function isBare(words: string, href: string): boolean {
  // Longer words can't be an address this short (and the marker pass stays cheap).
  if (words.length > 2 * CONTENT_LINK_HREF_MAX_CHARS) return false;
  try {
    return new URL(shownWords(words)).href === href;
  } catch {
    return false;
  }
}

/** The link's WHATWG href when it is an absolute http(s) address (or `//host/…`) of at most CONTENT_LINK_HREF_MAX_CHARS; else null. */
function absoluteHref(written: string): string | null {
  const trimmed = written.trim();
  const raw = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
  if (raw.length > 2 * CONTENT_LINK_HREF_MAX_CHARS || !/^https?:\/\//i.test(raw)) return null;
  try {
    const href = new URL(raw).href;
    return href.length <= CONTENT_LINK_HREF_MAX_CHARS ? href : null;
  } catch {
    return null;
  }
}

/**
 * A version's links to other Artifacts (the header's rules), from its files
 * in the order given. `selfId`: the version's own Artifact, left out.
 * `appHosts`: this deployment's app hosts (platform/links appHosts).
 */
export function contentLinks(files: readonly ContentFile[], opts: { selfId: string; appHosts: readonly string[] }): ContentLink[] {
  const links = new Map<string, ContentLink>();
  for (const file of files) {
    if (Buffer.byteLength(file.path) > CONTENT_LINK_PATH_MAX_BYTES) continue;
    const kind = artifactFileType(file.path).kind;
    const written = kind === "html" ? htmlLinks(file.text) : kind === "markdown" ? markdownLinks(file.text) : [];
    for (const link of written) {
      const href = absoluteHref(link.href);
      if (href === null) continue;
      const ref = parseArtifactRef(href, { appHosts: opts.appHosts });
      if (ref.kind !== "id" || ref.id === opts.selfId) continue;
      const bare = link.text === null || isBare(link.text, href);
      const key = `${file.path}\n${href}`;
      const had = links.get(key);
      if (had) {
        had.bare ||= bare;
        continue;
      }
      if (links.size >= CONTENT_LINKS_MAX) continue;
      links.set(key, { path: file.path, href, targetId: ref.id, targetVersion: ref.version ?? null, bare });
    }
  }
  return [...links.values()];
}
