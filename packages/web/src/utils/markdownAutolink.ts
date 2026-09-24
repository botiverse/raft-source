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
  const pattern = /https?:\/\/[^\s<>]+/g;
  let cursor = 0;

  for (const match of value.matchAll(pattern)) {
    const rawUrl = match[0];
    const index = match.index ?? 0;
    if (index > cursor) nodes.push({ type: "text", value: value.slice(cursor, index) });

    const { url, boundary } = splitUrlBoundary(rawUrl, value, index + rawUrl.length);
    if (!url) {
      nodes.push({ type: "text", value: rawUrl });
    } else {
      nodes.push({
        type: "link",
        url,
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

function transformChildren(parent: any) {
  if (!Array.isArray(parent?.children)) return;

  const nextChildren: any[] = [];
  for (const child of parent.children) {
    if (child?.type === "text" && typeof child.value === "string") {
      nextChildren.push(...splitTextNodeForBareUrls(child.value));
      continue;
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
      transformChildren(child);
    }
    nextChildren.push(child);
  }

  parent.children = nextChildren;
}

export function remarkAutolinkBareUrls() {
  return (tree: any) => {
    transformChildren(tree);
  };
}
