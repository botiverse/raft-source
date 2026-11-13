// The readable text of an Artifact's entry file, for the signed-out
// `index.md` and `meta` routes (publicRoutes.ts): what an AI tool or a link
// preview reads instead of the page. The bytes are untrusted agent output;
// nothing here renders them, and the routes never answer them as HTML.
//
// HTML has no parser among the server's dependencies, so a small tokenizer:
// one pass, linear in the input. It drops comments, doctypes, processing
// instructions and every tag; skips the contents of script, style, noscript,
// template, svg and title (the header names the title) with their nested
// tags; decodes character references; keeps block breaks (a line break per
// block element, `#` before a heading, `- ` before a list item); keeps an
// image's alt text where the image is; and keeps `pre`'s whitespace.
// Anything malformed ends as text or is dropped, never as markup in the
// output that wasn't text in the input.
//
// What these rules make is stored (publicText.ts, `version_texts`): change
// them and bump READABLE_TEXT_EXTRACTOR, so stored rows are made again.
//
// markdownExcerpt, at the end, is a card's excerpt of a Markdown entry
// (excerpt.ts stores it): a rule of its own, not covered by that version.
// excerptBlocks.ts makes the same start as data, with what is exported here.
import { ARTIFACT_EXCERPT_MAX_CHARS, ARTIFACT_PUBLIC_DESCRIPTION_MAX_CHARS, plainActionCardText } from "@botiverse/raft-shared";

/**
 * The version of the rules here (and of the description's in publicText.ts),
 * stored with each row of `version_texts`: a row of an older one is computed
 * again. 1: an image's alt text kept; a leading heading repeating the title
 * left out of the description.
 */
export const READABLE_TEXT_EXTRACTOR = 1;

/** Elements whose contents are never text a reader sees. */
const SKIPPED = new Set(["script", "style", "noscript", "template", "svg", "title"]);
/** Elements whose contents are raw text: they end only at their own end tag. */
const RAW_TEXT = new Set(["script", "style", "noscript", "template", "title", "textarea", "xmp"]);
/** Blocks with a blank line before and after them. */
const PARAGRAPHS = new Set(["blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "ol", "p", "pre", "table", "ul"]);
/** Elements that start and end a line. */
export const BLOCKS = new Set([
  "address", "article", "aside", "blockquote", "body", "br", "caption", "dd", "details", "dialog", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr",
  "html", "legend", "li", "main", "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "tfoot", "thead", "tr",
  "ul",
]);

const NAMED_REFERENCES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  mdash: "—", ndash: "–", hellip: "…", middot: "·", bull: "•", copy: "©", reg: "®", trade: "™",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", times: "×", divide: "÷",
  deg: "°", plusmn: "±", larr: "←", rarr: "→", uarr: "↑", darr: "↓", euro: "€", pound: "£", yen: "¥", cent: "¢",
  sect: "§", para: "¶", shy: "",
};

/** `text` with its character references decoded; an unknown or invalid one stays as written. */
export function decodeCharacterReferences(text: string): string {
  return text.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});?/g, (whole, ref: string) => {
    if (ref.startsWith("#")) {
      const code = ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "�";
      return String.fromCodePoint(code);
    }
    // Names are case-sensitive; only the table's own entries (never "constructor" and the like).
    return Object.hasOwn(NAMED_REFERENCES, ref) ? NAMED_REFERENCES[ref]! : whole;
  });
}

/** Where the tag starting at `start` (`<`) ends: just past its `>` outside quotes, or -1 when it never does. */
function tagEnd(html: string, start: number): number {
  let quote: string | null = null;
  for (let i = start + 1; i < html.length; i += 1) {
    const c = html[i]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "\"" || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i + 1;
    }
  }
  return -1;
}

/**
 * The value of the attribute `name` (lowercase) of the start tag `tag` (from
 * its `<` to its `>`), undecoded; null when it has none. Attributes are read
 * in order as a browser reads them, so a quoted value is never taken for one.
 */
export function attributeOf(tag: string, name: string): string | null {
  const nameEnd = /^<[a-zA-Z][a-zA-Z0-9:-]*/.exec(tag)?.[0].length ?? tag.length;
  let i = nameEnd;
  const end = tag.endsWith(">") ? tag.length - 1 : tag.length;
  while (i < end) {
    while (i < end && /[\s/]/.test(tag[i]!)) i += 1;
    const start = i;
    while (i < end && !/[\s/=]/.test(tag[i]!)) i += 1;
    const attribute = tag.slice(start, i).toLowerCase();
    if (attribute === "") break;
    while (i < end && /\s/.test(tag[i]!)) i += 1;
    let value = "";
    if (tag[i] === "=") {
      i += 1;
      while (i < end && /\s/.test(tag[i]!)) i += 1;
      const quote = tag[i];
      if (quote === "\"" || quote === "'") {
        const close = tag.indexOf(quote, i + 1);
        const stop = close < 0 || close > end ? end : close;
        value = tag.slice(i + 1, stop);
        i = stop + 1;
      } else {
        const begin = i;
        while (i < end && !/\s/.test(tag[i]!)) i += 1;
        value = tag.slice(begin, i);
      }
    }
    if (attribute === name) return value;
  }
  return null;
}

/** Where the element `name`'s own end tag starts at or after `from` (case-insensitive), or the end of the input. */
function rawTextEnd(lower: string, name: string, from: number): number {
  const at = lower.indexOf(`</${name}`, from);
  return at < 0 ? lower.length : at;
}

/**
 * The readable text of an HTML document: lines of text, one block per line,
 * blank lines between paragraphs at most one, every line trimmed.
 */
export function htmlReadableText(html: string): string {
  const lower = html.toLowerCase();
  const out: string[] = [];
  /** The last two characters written: no space at a line's start or after another outside `pre`, no doubled break. */
  let tail = "\n\n";
  const emit = (chunk: string) => {
    if (chunk === "") return;
    out.push(chunk);
    tail = (tail + chunk).slice(-2);
  };
  const lastChar = () => tail[1]!;
  /** End the line (once), and with `blank` leave a blank line after it. */
  const lineBreak = (blank: boolean) => {
    if (lastChar() !== "\n") emit("\n");
    if (blank && tail !== "\n\n") emit("\n");
  };
  let pre = 0;
  /** Depth inside a skipped element that may nest (svg). */
  let skipping: { name: string; depth: number } | null = null;
  const text = (chunk: string) => {
    if (skipping || chunk === "") return;
    const decoded = decodeCharacterReferences(chunk);
    if (pre > 0) {
      emit(decoded);
      return;
    }
    const collapsed = decoded.replace(/\s+/g, " ");
    emit(lastChar() === " " || lastChar() === "\n" ? collapsed.replace(/^ /, "") : collapsed);
  };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      text(html.slice(i));
      break;
    }
    text(html.slice(i, lt));
    if (lower.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const next = html[lt + 1] ?? "";
    if (next === "!" || next === "?") {
      const end = html.indexOf(">", lt + 2);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    const closing = next === "/";
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9:-]*/.exec(html.slice(lt + (closing ? 2 : 1), lt + (closing ? 2 : 1) + 64));
    if (!nameMatch) {
      // Not a tag: a bare "<" is text.
      text("<");
      i = lt + 1;
      continue;
    }
    const end = tagEnd(html, lt);
    if (end < 0) break; // An unterminated tag: nothing after it is text.
    const name = nameMatch[0].toLowerCase();
    const selfClosing = html[end - 2] === "/";
    i = end;
    if (skipping) {
      if (name === skipping.name) {
        if (closing) skipping.depth -= 1;
        else if (!selfClosing) skipping.depth += 1;
        if (skipping.depth === 0) skipping = null;
      }
      continue;
    }
    if (!closing && RAW_TEXT.has(name) && !selfClosing) {
      // Raw text up to its own end tag; the end tag itself is then read as any other.
      const stop = rawTextEnd(lower, name, end);
      if (!SKIPPED.has(name)) text(html.slice(end, stop));
      i = stop;
      continue;
    }
    if (!closing && SKIPPED.has(name)) {
      if (!selfClosing) skipping = { name, depth: 1 };
      continue;
    }
    if (!closing && name === "img") {
      // What the image says, where it is (none for a decorative one, `alt=""`), apart from the words around it.
      const alt = attributeOf(html.slice(lt, end), "alt");
      if (alt && alt.trim() !== "") text(` ${alt} `);
      continue;
    }
    if (name === "pre") pre = Math.max(0, pre + (closing ? -1 : 1));
    if (BLOCKS.has(name)) {
      // A paragraph-like block also leaves a blank line around it.
      lineBreak(PARAGRAPHS.has(name));
      if (!closing && /^h[1-6]$/.test(name)) emit(`${"#".repeat(Number(name[1]))} `);
      else if (!closing && name === "li") emit("- ");
    } else if (!closing && (name === "td" || name === "th") && lastChar() !== " " && lastChar() !== "\n") {
      emit(" ");
    }
  }
  return tidyLines(out.join(""));
}

/** Lines without trailing whitespace, no more than one blank line in a row, none at either end. */
function tidyLines(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd());
  const kept: string[] = [];
  for (const line of lines) {
    // A heading or list marker with nothing after it says nothing.
    const bare = /^(#{1,6}|-)\s*$/.test(line) ? "" : line;
    if (bare === "" && (kept.length === 0 || kept[kept.length - 1] === "")) continue;
    kept.push(bare);
  }
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  return kept.join("\n");
}

/**
 * `text` with each `[words](target)` reduced to its words (with `opener` `![`,
 * each image to its alt text); `\[([^\]]*)\]\([^)]*\)` across lines, as a
 * scan. An opener is read up to the next `]`, so every opener before that `]`
 * has the same fate: a `]` without `(` rules them all out at once, and no `]`
 * or `)` left rules out all that follow. No character is read twice.
 */
function withoutLinks(text: string, opener: "[" | "!["): string {
  let out = "";
  let from = 0;
  let at = text.indexOf(opener);
  while (at >= 0) {
    const close = text.indexOf("]", at + opener.length);
    if (close < 0) break;
    if (text[close + 1] !== "(") {
      at = text.indexOf(opener, close + 1);
      continue;
    }
    const end = text.indexOf(")", close + 2);
    if (end < 0) break;
    out += text.slice(from, at) + text.slice(at + opener.length, close);
    from = end + 1;
    at = text.indexOf(opener, from);
  }
  return out + text.slice(from);
}

/** The emphasis and code markers by first character, in the order a start tries them. */
const EMPHASIS_MARKERS = new Map([["*", ["**", "*"]], ["_", ["__", "_"]], ["`", ["`"]], ["~", ["~~"]]]);

/** The first `marker` after the text starting at `start` with no space before it, or -1. */
function emphasisClose(line: string, marker: string, start: number): number {
  for (let close = line.indexOf(marker, start + 1); close >= 0; close = line.indexOf(marker, close + 1)) {
    if (/\S/.test(line[close - 1]!)) return close;
  }
  return -1;
}

/**
 * The line without each pair of a marker around text that doesn't start or end
 * with a space; `(\*\*|__|\*|_|`|~~)(?=\S)([^\n]*?\S)\1` as a scan. A search
 * that finds a close is paid for by the text it takes. One that finds none
 * goes to the line's end, but only once per marker: a later start can only
 * close at fewer places.
 */
function withoutEmphasis(line: string): string {
  const unclosed = new Set<string>();
  let out = "";
  let from = 0;
  for (let at = 0; at < line.length; at += 1) {
    for (const marker of EMPHASIS_MARKERS.get(line[at]!) ?? []) {
      const start = at + marker.length;
      if (unclosed.has(marker) || !line.startsWith(marker, at) || !/\S/.test(line[start] ?? " ")) continue;
      const close = emphasisClose(line, marker, start);
      if (close < 0) {
        unclosed.add(marker);
        continue;
      }
      out += line.slice(from, at) + line.slice(start, close);
      from = close + marker.length;
      at = from - 1;
      break;
    }
  }
  return out + line.slice(from);
}

/** `text` without `<[^>]*>`. After the last `>` no `<` can close, and before it every `<` does, so the regex never fails a start. */
function withoutTags(text: string): string {
  const end = text.lastIndexOf(">") + 1;
  return text.slice(0, end).replace(/<[^>]*>/g, "") + text.slice(end);
}

/**
 * Markdown with its markup lightly removed (for a description only): headings,
 * quotes, list markers, emphasis, links and images.
 *
 * Every pass is linear in its input, whatever a public page holds (publicText.ts
 * runs this on 200 KB of Markdown and on the text of 2 MiB of HTML, on the event
 * loop, before `describe` keeps 160 characters of it). The two regexes left
 * only start at a line's start and never reach past its end. Links, emphasis
 * and tags are scans or guarded: as bare regexes a start that fails reads on to
 * the end of the text (of the line, for emphasis), so a long run of `[`, `*a `
 * or `<` costs the square of its length.
 */
export function markdownPlainText(markdown: string): string {
  const unmarked = withoutLinks(withoutLinks(markdown.replace(/^```.*$/gm, ""), "!["), "[")
    .replace(/^[ \t]{0,3}(#{1,6}|>+|[-*+]|\d+[.)])[ \t]+/gm, "");
  return withoutTags(unmarked.split("\n").map(withoutEmphasis).join("\n"));
}

/** The longest first line withoutTitleHeading reads as a heading (a title is at most a few hundred characters). */
const TITLE_HEADING_MAX_CHARS = 1000;

/** A heading's words as compared with a title: whitespace collapsed, case folded. */
const comparable = (text: string): string => text.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Markdown (or an HTML page's readable text, whose headings are Markdown's)
 * without its first heading when that heading only repeats `title`
 * (whitespace and case aside, its emphasis and links read as their words), so
 * a description doesn't start with what the preview already shows as its
 * title. Anything else as it was.
 */
export function withoutTitleHeading(text: string, title: string | null): string {
  if (!title || comparable(title) === "") return text;
  // The first line that isn't blank, if it is short enough to be a title's heading (no regex over a long line).
  const lineStart = /^(?:[ \t]*\r?\n)*/.exec(text)![0].length;
  const newline = text.indexOf("\n", lineStart);
  const lineEnd = newline < 0 ? text.length : newline;
  if (lineEnd - lineStart > TITLE_HEADING_MAX_CHARS) return text;
  // An ATX heading: at most three spaces in; a closing run of `#` isn't its text.
  const heading = /^[ \t]{0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t\r]*$/.exec(text.slice(lineStart, lineEnd));
  if (!heading || comparable(markdownPlainText(heading[1]!)) !== comparable(title)) return text;
  return text.slice(newline < 0 ? text.length : newline + 1);
}

/**
 * A preview's description of `text`: whitespace collapsed, at most
 * ARTIFACT_PUBLIC_DESCRIPTION_MAX_CHARS characters cut at a word (a single
 * word longer than that is cut where it reaches it), then "…" when cut.
 */
export function describe(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(collapsed);
  if (chars.length <= ARTIFACT_PUBLIC_DESCRIPTION_MAX_CHARS) return collapsed;
  const head = chars.slice(0, ARTIFACT_PUBLIC_DESCRIPTION_MAX_CHARS + 1).join("");
  const space = head.lastIndexOf(" ");
  const cut = space > 0 ? head.slice(0, space) : chars.slice(0, ARTIFACT_PUBLIC_DESCRIPTION_MAX_CHARS).join("");
  return `${cut.replace(/[\s.,;:!?·–—-]+$/u, "")}…`;
}

/** Elements whose contents a Markdown page never shows as text; a block of one is left out whole. */
export const EXCERPT_SKIPPED_BLOCK = /^<(script|style|noscript|template|svg|iframe|object)\b/i;

/** Links and images: an image says nothing here (a badge's alt is noise); a link says its words. */
const reduceLinks = (line: string): string => line
  .replace(/!\[[^[\]]*\](?:\([^()]*\)|\[[^[\]]*\])/g, "")
  .replace(/\[\^[^[\]]*\]/g, "")
  .replace(/\[([^[\]]*)\](?:\([^()]*\)|\[[^[\]]*\])/g, "$1");

/** What stands for an inline code span while a line is reduced: a private use character per span (markdownExcerpt removes any the entry had). */
export const CODE_MARK_FIRST = 0xe000;
const CODE_MARK_COUNT = 0x1900;

/**
 * The line with each inline code span (CommonMark's: a run of backticks up to
 * the next run of the same length) replaced by its mark, and the spans' text.
 * `next` is worked out once from the end, so a run with no partner costs no
 * search. Past CODE_MARK_COUNT spans the rest is ordinary text.
 */
export function maskCodeSpans(line: string): { masked: string; spans: string[] } {
  const runs = [...line.matchAll(/\\.|`+/g)].filter((run) => run[0][0] === "`");
  const next: Array<number | undefined> = runs.map(() => undefined);
  const seen = new Map<number, number>();
  for (let at = runs.length - 1; at >= 0; at -= 1) {
    next[at] = seen.get(runs[at]![0].length);
    seen.set(runs[at]![0].length, at);
  }
  const spans: string[] = [];
  let masked = "";
  let from = 0;
  for (let at = 0; at < runs.length && spans.length < CODE_MARK_COUNT;) {
    const close = next[at];
    if (close === undefined) {
      at += 1;
      continue;
    }
    const start = runs[at]!.index;
    masked += line.slice(from, start) + String.fromCharCode(CODE_MARK_FIRST + spans.length);
    spans.push(line.slice(start + runs[at]![0].length, runs[close]!.index).trim());
    from = runs[close]!.index + runs[close]![0].length;
    at = close + 1;
  }
  return { masked: masked + line.slice(from), spans };
}

/**
 * The line without each pair of `*` runs. Paired, not read from what is beside
 * them: CommonMark's flanking rule (and the word-edge rule below) wants
 * punctuation or a space outside a run, which Chinese doesn't write, so
 * `带**粗体**` has a letter before its opener. A run may close after anything but
 * a space and open before anything but one; an escaped `*` is no run. Each
 * step of the loop empties a run, so it is linear.
 */
function withoutPairedAsterisks(line: string): string {
  const runs = [...line.matchAll(/\\.|\*+/g)].filter((run) => run[0][0] === "*");
  const left = runs.map((run) => run[0].length);
  const open: number[] = [];
  runs.forEach((run, at) => {
    const end = run.index + run[0].length;
    if (run.index > 0 && line[run.index - 1] !== " ") {
      while (left[at]! > 0 && open.length > 0) {
        const opener = open[open.length - 1]!;
        const paired = Math.min(left[opener]!, left[at]!);
        left[opener]! -= paired;
        left[at]! -= paired;
        if (left[opener] === 0) open.pop();
      }
    }
    if (left[at]! > 0 && end < line.length && line[end] !== " ") open.push(at);
  });
  let kept = "";
  let from = 0;
  runs.forEach((run, at) => {
    kept += line.slice(from, run.index) + run[0].slice(0, left[at]);
    from = run.index + run[0].length;
  });
  return kept + line.slice(from);
}

/**
 * No `<` a browser could read as starting a tag (a run of them at once, so
 * removing one reveals none), nor one before a code span's mark, whose text may
 * start with a letter.
 */
export const noTagStart = (text: string): string =>
  text.replace(/<+/g, (run, at: number) => (/[a-zA-Z/!?\uE000-\uF8FF]/.test(text[at + run.length] ?? "") ? "" : run));

/** A line with its code spans masked, without links' and images' markup, comments, tags and loose code and strikethrough markers. */
export const withoutInlineMarkup = (masked: string): string => reduceLinks(masked)
  .replace(/<!--(?:(?!<!--).)*?-->/g, "")
  .replace(/<\/?[a-zA-Z][^<>]*>/g, "")
  .replace(/`+|~~+/g, "");

/**
 * Inline markers. Code spans first, and only their marks go through the rest:
 * their text is the author's, as written. Tags and comments go; `*` pairs go,
 * then a run left at a word's edge (a bold wrapped onto the next line, `_`,
 * which never opens inside a word), so `2 * 3` and `snake_case` stay.
 */
export function reduceInline(line: string): string {
  const { masked, spans } = maskCodeSpans(line);
  const reduced = withoutPairedAsterisks(withoutInlineMarkup(masked))
    .replace(/(?<=^|[^\p{L}\p{N}*_\\])[*_]+(?=[^\s*_])|(?<=[^\s*_\\])[*_]+(?=$|[^\p{L}\p{N}*_])/gu, "")
    .replace(/\\([\\`*_{}[\]()#+.!|<>~-])/g, "$1")
    .replace(/ +/g, " ");
  return noTagStart(reduced).replace(/[\uE000-\uF8FF]/g, (mark) => spans[mark.charCodeAt(0) - CODE_MARK_FIRST] ?? "");
}

/**
 * What an excerpt is made from: the entry without invisible characters, front
 * matter or a first heading repeating `title`, with `\n` line ends. Linear.
 */
export function excerptSource(markdown: string, title: string | null): string {
  // First, so no invisible character splits what the passes after this look for.
  let text = plainActionCardText(markdown.replace(/[\uE000-\uF8FF\uFFFD]/g, ""), Number.POSITIVE_INFINITY, { multiline: true });
  const frontMatter = /^(---|\+\+\+)[ \t]*\n/.exec(text);
  if (frontMatter) {
    const close = text.indexOf(`\n${frontMatter[1]}`, frontMatter[0].length - 1);
    if (close >= 0) text = text.slice(close + 1 + frontMatter[1]!.length);
  }
  return withoutTitleHeading(text, title);
}

/**
 * A card's excerpt of a Markdown entry (ArtifactPreview `excerpt`): its start
 * as plain text, one line per block (a heading, a paragraph with its wrapped
 * lines joined, a list item, a table row), at most ARTIFACT_EXCERPT_MAX_CHARS
 * code points; null when nothing is left to show. Left out: front matter, a
 * first heading repeating `title` (the card says it), code fences' markers,
 * rules, table separators, link reference definitions, images, HTML tags,
 * comments and the contents of script-like blocks; links keep their words only.
 * Code keeps its text as the author wrote it, `<b>` included, inline and fenced.
 *
 * Rendering it as text is what keeps it inert, and that is the boundary:
 * code means an excerpt can hold tag-shaped text. For the rest, a second line of
 * defence: outside code no `<` that could start a tag survives (noTagStart, over
 * each line once reduced); character references stay as written (decoding one
 * could make a tag); and no
 * control or format character survives (plainActionCardText: bidi overrides,
 * NUL, which Postgres refuses in text), nor the U+FFFD of bytes that weren't
 * UTF-8.
 *
 * Every pass is linear in its input, whatever an agent writes: a character
 * class excludes what starts the next attempt, and no whitespace run is
 * scanned from two starts (each line's is collapsed first). A push waits for
 * this.
 */
export function markdownExcerpt(markdown: string, title: string | null): string | null {
  const text = excerptSource(markdown, title);

  const blocks: string[] = [];
  /** A plain line next joins the last block (a paragraph's wrapped lines, a list item's). */
  let joining = false;
  let fence: string | null = null;
  /** The end of an HTML block being left out (lowercase), or null. */
  let skippingTo: string | null = null;
  let kept = 0;
  const keep = (block: string, joinable: boolean) => {
    blocks.push(block);
    kept += block.length;
    joining = joinable;
  };
  for (const raw of text.split("\n")) {
    // Enough for the cut below however wide its characters (a code point is at most two units).
    if (kept > 2 * ARTIFACT_EXCERPT_MAX_CHARS) break;
    if (skippingTo !== null) {
      if (raw.toLowerCase().includes(skippingTo)) skippingTo = null;
      continue;
    }
    const line = raw.replace(/\s+/g, " ").trim();
    const marker = /^(`{3,}|~{3,})/.exec(line)?.[1]?.[0] ?? null;
    if (fence !== null) {
      if (marker === fence) fence = null;
      else if (line !== "") keep(raw.trimEnd(), false);
      continue;
    }
    if (marker !== null) {
      fence = marker;
      joining = false;
      continue;
    }
    if (line === "") {
      joining = false;
      continue;
    }
    const skipped = EXCERPT_SKIPPED_BLOCK.exec(line)?.[1];
    if (skipped) {
      if (!line.toLowerCase().includes(`</${skipped.toLowerCase()}`)) skippingTo = `</${skipped.toLowerCase()}`;
      joining = false;
      continue;
    }
    if (line.startsWith("<!--")) {
      if (!line.includes("-->")) skippingTo = "-->";
      joining = false;
      continue;
    }
    // Rules, setext underlines, table separators; link reference definitions.
    if (/^[|:=*_~ -]+$/.test(line) || /^\[[^\]]*\]:/.test(line)) continue;
    const unquoted = line.replace(/^[> ]+/, "");
    const heading = /^#{1,6} +/.exec(unquoted);
    const listed = /^(?:[-*+]|\d{1,9}[.)]) +(?:\[[ xX]\] +)?/.exec(unquoted);
    if (heading) {
      const words = reduceInline(unquoted.slice(heading[0].length).replace(/ #+$/, "")).trim();
      if (words !== "") keep(words, false);
    } else if (listed) {
      const words = reduceInline(unquoted.slice(listed[0].length)).trim();
      if (words !== "") keep(words, true);
    } else if (unquoted.startsWith("|")) {
      const cells = reduceInline(unquoted.replace(/^\|/, "").replace(/\|$/, "")).split("|").map((cell) => cell.trim()).filter((cell) => cell !== "");
      if (cells.length > 0) keep(cells.join(" · "), false);
    } else {
      const words = reduceInline(unquoted).trim();
      if (words === "") continue;
      if (joining) {
        blocks[blocks.length - 1] += ` ${words}`;
        kept += words.length + 1;
      } else {
        keep(words, true);
      }
    }
  }
  const excerpt = plainActionCardText(blocks.join("\n"), ARTIFACT_EXCERPT_MAX_CHARS, { multiline: true });
  return excerpt === "" ? null : excerpt;
}
