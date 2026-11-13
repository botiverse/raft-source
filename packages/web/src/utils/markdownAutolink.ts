import { alignWithSource, pointAt } from "./markdownSourceAlignment";
import { webUrlFromRaftDeepLink } from "./raftDeepLinkWebUrl";
const CJK_URL_BOUNDARY_PUNCTUATION = "，。、；：！？）》」』】》〉”’（《「『【〈“‘";
const ASCII_CLOSING_PUNCTUATION_PAIRS: Record<string, string> = {
  ")": "(",
  "]": "[",
  "}": "{",
};

function countChar(text: string, char: string): number {
  let count = 0;
  for (const current of text) {
    if (current === char) count += 1;
  }
  return count;
}

function isCjkTextOrWhitespace(char: string): boolean {
  return /[\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char);
}

function shouldTreatAsciiCommaAsBoundary(source: string, nextIndex: number): boolean {
  const nextChar = source[nextIndex] ?? "";
  return isCjkTextOrWhitespace(nextChar);
}

function firstCjkBoundaryIndex(text: string): number {
  for (let index = 0; index < text.length; index += 1) {
    if (CJK_URL_BOUNDARY_PUNCTUATION.includes(text[index])) return index;
  }
  return -1;
}

function firstAsciiCommaBoundaryIndex(text: string, source: string, nextIndex: number): number {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== ",") continue;
    const nextChar = text[index + 1] ?? source[nextIndex] ?? "";
    if (isCjkTextOrWhitespace(nextChar)) return index;
  }
  return -1;
}

function splitUrlBoundary(rawUrl: string, source: string, nextIndex: number) {
  let url = rawUrl;
  let boundary = "";

  const cjkBoundaryIndex = firstCjkBoundaryIndex(url);
  if (cjkBoundaryIndex >= 0) {
    boundary = url.slice(cjkBoundaryIndex);
    url = url.slice(0, cjkBoundaryIndex);
  }

  const asciiCommaBoundaryIndex = firstAsciiCommaBoundaryIndex(url, source, nextIndex);
  if (asciiCommaBoundaryIndex >= 0) {
    boundary = `${url.slice(asciiCommaBoundaryIndex)}${boundary}`;
    url = url.slice(0, asciiCommaBoundaryIndex);
  }

  return trimTrailingUrlBoundary(url, boundary, source, nextIndex);
}

function trimTrailingUrlBoundary(rawUrl: string, initialBoundary: string, source: string, nextIndex: number) {
  let url = rawUrl;
  let boundary = initialBoundary;

  if (url.endsWith(",") && shouldTreatAsciiCommaAsBoundary(source, nextIndex)) {
    boundary = `,${boundary}`;
    url = url.slice(0, -1);
  }

  while (url.length > 0 && CJK_URL_BOUNDARY_PUNCTUATION.includes(url.at(-1) ?? "")) {
    boundary = `${url.at(-1)}${boundary}`;
    url = url.slice(0, -1);
  }

  while (url.length > 0) {
    const closing = url.at(-1) ?? "";
    const opening = ASCII_CLOSING_PUNCTUATION_PAIRS[closing];
    if (!opening) break;

    const openCount = countChar(url, opening);
    const closeCount = countChar(url, closing);
    if (closeCount <= openCount) break;

    boundary = `${closing}${boundary}`;
    url = url.slice(0, -1);
  }

  return { url, boundary };
}

// GFM finds bare http links and leaves a sentence's closing punctuation out;
// it never sees raft:// links, so trim the same marks here.
const TRAILING_SENTENCE_PUNCTUATION = /[.,!?;:'"*]+$/;

function splitRaftLinkBoundary(rawUrl: string, source: string, nextIndex: number) {
  let { url, boundary } = splitUrlBoundary(rawUrl, source, nextIndex);
  for (;;) {
    const trailing = TRAILING_SENTENCE_PUNCTUATION.exec(url)?.[0];
    if (!trailing) break;
    url = url.slice(0, -trailing.length);
    boundary = `${trailing}${boundary}`;
    const balanced = trimTrailingUrlBoundary(url, boundary, source, nextIndex);
    if (balanced.url === url) break;
    ({ url, boundary } = balanced);
  }
  return { url, boundary };
}

function splitAutolinkBoundary(rawUrl: string) {
  return splitUrlBoundary(rawUrl, "", -1);
}

function isBareAutolinkNode(node: any): boolean {
  if (node?.type !== "link" || typeof node.url !== "string") return false;
  if (!Array.isArray(node.children) || node.children.length !== 1) return false;
  const child = node.children[0];
  return child?.type === "text" && child.value === node.url;
}

function splitTextNodeForBareUrls(value: string): any[] {
  const nodes: any[] = [];
  // `raft://` links to a server route (Raft Desktop's copied links) too: they
  // link to the same route on the web, keeping the text as written.
  const pattern = /https?:\/\/[^\s<>]+|(?<![\p{L}\p{N}_])raft:\/\/[^\s<>]+/gu;
  let cursor = 0;

  for (const match of value.matchAll(pattern)) {
    const rawUrl = match[0];
    const index = match.index ?? 0;
    if (index > cursor) nodes.push({ type: "text", value: value.slice(cursor, index) });

    const { url, boundary } = rawUrl.startsWith("raft:")
      ? splitRaftLinkBoundary(rawUrl, value, index + rawUrl.length)
      : splitUrlBoundary(rawUrl, value, index + rawUrl.length);
    const href = url.startsWith("raft:") ? webUrlFromRaftDeepLink(url) : url;
    if (!url || !href) {
      nodes.push({ type: "text", value: rawUrl });
    } else {
      nodes.push({
        type: "link",
        url: href,
        title: null,
        children: [{ type: "text", value: url }],
      });
      if (boundary) nodes.push({ type: "text", value: boundary });
    }

    cursor = index + rawUrl.length;
  }

  if (cursor < value.length) nodes.push({ type: "text", value: value.slice(cursor) });
  return nodes;
}

// Give each split piece the source position of the text it came from, so
// later plugins can still read the source (message refs check escapes).
type PositionedPiece = {
  type: string;
  value?: string;
  children?: Array<{ value: string }>;
  position?: { start: ReturnType<typeof pointAt>; end: ReturnType<typeof pointAt> };
};
type ParsedText = { value: string; position?: { start?: { offset?: number }; end?: { offset?: number } } };

function withSourcePositions<T extends PositionedPiece>(nodes: T[], original: ParsedText, source: string | undefined): T[] {
  const start = original?.position?.start?.offset;
  const end = original?.position?.end?.offset;
  if (source === undefined || start === undefined || end === undefined) return nodes;
  const { offsets } = alignWithSource(original.value, source.slice(start, end), start);
  let cursor = 0;
  for (const node of nodes) {
    const length = (node.type === "text" ? node.value : node.children?.[0]?.value)?.length ?? 0;
    if (node.type === "text") {
      node.position = { start: pointAt(source, offsets[cursor]), end: pointAt(source, offsets[cursor + length]) };
    }
    cursor += length;
  }
  return nodes;
}

// GFM drops a trailing `_` or `~` from a bare URL so `_https://x.com_` reads
// as emphasis. When the mark closed nothing it is left as text right after
// the link, and the link points at the wrong address: login links often end
// in a random token such as `state=Ab_`. Put those marks back into the URL.
const TRAILING_URL_MARKS = /^[_~]+/;

function restoreTrailingUrlMarks(children: any[], source?: string) {
  if (source === undefined) return;
  for (let index = 0; index < children.length - 1; index += 1) {
    const link = children[index];
    const next = children[index + 1];
    if (!isBareAutolinkNode(link) || next?.type !== "text" || typeof next.value !== "string") continue;
    // Only a URL written bare: `<url>` and `[url](url)` already mark their end.
    const linkStart = link.position?.start?.offset;
    const linkEnd = link.position?.end?.offset;
    const textStart = next.position?.start?.offset;
    if (linkStart === undefined || linkEnd !== textStart || source.slice(linkStart, linkEnd) !== link.url) continue;
    const marks = TRAILING_URL_MARKS.exec(next.value)?.[0];
    if (!marks) continue;
    link.url += marks;
    link.children[0].value += marks;
    next.value = next.value.slice(marks.length);
    const end = linkEnd + marks.length;
    link.position.end = pointAt(source, end);
    if (link.children[0].position) link.children[0].position.end = pointAt(source, end);
    next.position.start = pointAt(source, end);
    if (!next.value) {
      children.splice(index + 1, 1);
    }
  }
}

// GFM ends a bare URL at the next space, and it only lets go of trailing marks,
// so in `**https://x.com**（说明` the URL takes the closing `**` and the text after
// it, and the bold never closes: the marks show as text, one of them in the link.
// A mark that closes one opened before the URL ends the URL, as it does after
// `https://x.com**` at the end of a line. No opener: `**` stays in the URL, where
// it can be part of the address. `_` isn't here: it is common in addresses.
const EMPHASIS_MARKS = [
  { mark: "**", type: "strong" },
  { mark: "~~", type: "delete" },
  { mark: "*", type: "emphasis" },
];

type InlineNode = {
  type: string;
  value?: string;
  url?: string;
  title?: null;
  children?: InlineNode[];
  position?: ParsedText["position"];
};

function sourceOf(node: InlineNode, source?: string): string | undefined {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  return source === undefined || start === undefined || end === undefined ? undefined : source.slice(start, end);
}

// What can stand before an opening mark: as in CommonMark, not a letter, digit or
// `_` (`2*3`, `file_*.txt`), but CJK text can, as remark-cjk-friendly lets it.
function canPrecedeMark(char: string | undefined): boolean {
  return char === undefined || isCjkTextOrWhitespace(char) || (char !== "_" && /[\p{P}\p{S}]/u.test(char));
}

function opensEmphasis(text: InlineNode, mark: string, source?: string): boolean {
  const value = text.value ?? "";
  const at = value.lastIndexOf(mark);
  const before = value[at - 1];
  const next = value[at + mark.length];
  if (next !== undefined && /\s/.test(next)) return false;
  if (mark === "*" && (before === "*" || next === "*")) return false;
  if (!canPrecedeMark(before)) return false;
  const written = sourceOf(text, source);
  if (written === undefined) return true;
  // `\*` and `&ast;` are the text `*`, and they open nothing.
  const offset = alignWithSource(value, written, 0).offsets[at];
  return offset !== undefined && written.startsWith(mark, offset);
}

// A mark inside a word of the address is the address's own (`?a=*b`).
function closesEmphasis(url: string, close: number, mark: string): boolean {
  const next = url[close + mark.length];
  if (close <= 0 || (next !== undefined && /[A-Za-z0-9_]/.test(next))) return false;
  return mark !== "*" || (url[close - 1] !== "*" && next !== "*");
}

function closeEmphasisInsideBareUrls(children: InlineNode[], source?: string) {
  for (let index = children.length - 1; index > 0; index -= 1) {
    const link = children[index];
    if (!link?.url || !isBareAutolinkNode(link)) continue;
    // Only a URL written bare: `[url](url)` marks its own end.
    const written = sourceOf(link, source);
    if (written !== undefined && written !== link.url) continue;
    for (const { mark, type } of EMPHASIS_MARKS) {
      const close = link.url.indexOf(mark);
      if (!closesEmphasis(link.url, close, mark)) continue;
      const opensHere = (node: InlineNode | undefined) => node?.type === "text" && node.value?.includes(mark);
      let openerIndex = index - 1;
      while (openerIndex >= 0 && !opensHere(children[openerIndex])) openerIndex -= 1;
      const opener = children[openerIndex];
      if (!opener?.value || !opensEmphasis(opener, mark, source)) continue;
      const open = opener.value.lastIndexOf(mark);
      const before = opener.value.slice(0, open);
      const inside = opener.value.slice(open + mark.length);
      const url = link.url.slice(0, close);
      const after = link.url.slice(close + mark.length);
      children.splice(
        openerIndex,
        index - openerIndex + 1,
        ...(before ? [{ type: "text", value: before }] : []),
        {
          type,
          children: [
            ...(inside ? [{ type: "text", value: inside }] : []),
            ...children.slice(openerIndex + 1, index),
            { type: "link", url, title: null, children: [{ type: "text", value: url }] },
          ],
        },
        ...(after ? [{ type: "text", value: after }] : []),
      );
      index = openerIndex;
      break;
    }
  }
}

function transformChildren(parent: any, source?: string) {
  if (!Array.isArray(parent?.children)) return;

  closeEmphasisInsideBareUrls(parent.children, source);
  restoreTrailingUrlMarks(parent.children, source);
  const nextChildren: any[] = [];
  for (const child of parent.children) {
    if (child?.type === "text" && typeof child.value === "string") {
      const split = splitTextNodeForBareUrls(child.value);
      // Keep source positions: message refs read the source through them to
      // tell `\<target>` from `<target>`. No URL: the parsed node as is.
      if (split.length === 1 && split[0].type === "text" && split[0].value === child.value) {
        nextChildren.push(child);
      } else {
        nextChildren.push(...withSourcePositions(split, child, source));
      }
      continue;
    }

    // `[label](raft:///s/…)`, `<raft:///s/…>` and `[r]: raft:///s/…`: the
    // sanitizer drops the raft: scheme, so point them at the same route on the web.
    if ((child?.type === "link" || child?.type === "definition") && typeof child.url === "string" && child.url.startsWith("raft:")) {
      const href = webUrlFromRaftDeepLink(child.url);
      if (href) {
        nextChildren.push({ ...child, url: href });
        continue;
      }
    }

    if (isBareAutolinkNode(child)) {
      const { url, boundary } = splitAutolinkBoundary(child.url);
      if (boundary && url) {
        nextChildren.push({
          ...child,
          url,
          children: [{ ...child.children[0], value: url }],
        });
        nextChildren.push({ type: "text", value: boundary });
        continue;
      }
    }

    if (
      child?.type !== "link" &&
      child?.type !== "linkReference" &&
      child?.type !== "definition" &&
      child?.type !== "inlineCode" &&
      child?.type !== "code" &&
      child?.type !== "html"
    ) {
      transformChildren(child, source);
    }
    nextChildren.push(child);
  }

  parent.children = nextChildren;
}

export function remarkAutolinkBareUrls() {
  return (tree: any, file?: { value?: unknown }) => {
    transformChildren(tree, file?.value === undefined ? undefined : String(file.value));
  };
}
