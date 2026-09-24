import type { Components } from "react-markdown";
import { useIntl } from "react-intl";

export type MarkdownOutlineItem = {
  id: string;
  level: 1 | 2 | 3;
  sourceLine: number;
  title: string;
};

const FENCE_RE = /^\s*(```|~~~)/;
const ATX_HEADING_RE = /^(#{1,3})\s+(.+?)\s*$/;
const TRAILING_HASHES_RE = /\s+#+\s*$/;

export function extractMarkdownOutline(markdown: string): MarkdownOutlineItem[] {
  const seen = new Map<string, number>();
  const outline: MarkdownOutlineItem[] = [];
  let inFence = false;

  const lines = markdown.split(/\r?\n/);
  for (const [lineIndex, line] of lines.entries()) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line.startsWith("    ")) continue;

    const match = line.match(ATX_HEADING_RE);
    if (!match) continue;

    const title = cleanHeadingText(match[2]);
    if (!title) continue;

    const baseId = slugifyHeading(title);
    const count = seen.get(baseId) ?? 0;
    seen.set(baseId, count + 1);
    outline.push({
      id: count === 0 ? baseId : `${baseId}-${count + 1}`,
      level: match[1].length as 1 | 2 | 3,
      sourceLine: lineIndex + 1,
      title,
    });
  }

  return outline;
}

export function createMarkdownOutlineHeadingComponents(
  outline: MarkdownOutlineItem[],
): Components {
  const idBySourceLine = new Map(outline.map((item) => [item.sourceLine, item.id]));

  return {
    h1: ({ children, node }) => (
      <h1
        id={headingIdForNode(node, idBySourceLine)}
        className="scroll-mt-20 text-3xl font-bold mt-6 mb-3 leading-tight"
      >
        {children}
      </h1>
    ),
    h2: ({ children, node }) => (
      <h2
        id={headingIdForNode(node, idBySourceLine)}
        className="scroll-mt-20 text-2xl font-bold mt-5 mb-2.5 leading-tight"
      >
        {children}
      </h2>
    ),
    h3: ({ children, node }) => (
      <h3
        id={headingIdForNode(node, idBySourceLine)}
        className="scroll-mt-20 text-xl font-bold mt-4 mb-2 leading-tight"
      >
        {children}
      </h3>
    ),
  };
}

export function MarkdownOutlineNav({ outline }: { outline: MarkdownOutlineItem[] }) {
  const { formatMessage } = useIntl();
  if (outline.length === 0) return null;

  return (
    <nav
      aria-label={formatMessage({ id: "markdown.outline.ariaLabel" })}
      className="border-l-2 border-black/20 pl-4 text-sm"
    >
      <div className="mb-2 font-mono text-[11px] font-bold uppercase tracking-widest text-black/50">
        {formatMessage({ id: "markdown.outline.title" })}
      </div>
      <ol className="space-y-1.5">
        {outline.map((item) => (
          <li key={item.id} className={outlineIndentClass(item.level)}>
            <a
              href={`#${item.id}`}
              className="block truncate text-[13px] font-medium text-black/55 hover:text-black"
              title={item.title}
            >
              {item.title}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function cleanHeadingText(raw: string) {
  return raw
    .replace(TRAILING_HASHES_RE, "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .trim();
}

function slugifyHeading(title: string) {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

function outlineIndentClass(level: MarkdownOutlineItem["level"]) {
  if (level === 2) return "pl-3";
  if (level === 3) return "pl-6";
  return "";
}

function headingIdForNode(
  node: { position?: { start?: { line?: number } } } | undefined,
  idBySourceLine: Map<number, string>,
) {
  const sourceLine = node?.position?.start?.line;
  return typeof sourceLine === "number" ? idBySourceLine.get(sourceLine) : undefined;
}
