import { markdownHeadings } from "@botiverse/raft-shared";
import type { Components } from "react-markdown";
import { useIntl } from "react-intl";
import Tooltip from "../ui/Tooltip";

export type MarkdownOutlineItem = {
  id: string;
  level: 1 | 2 | 3;
  sourceLine: number;
  title: string;
};

/** h1-h3 of `markdown`, with ids unique within the document. Headings come
 *  from the parser the preview renders with (raft-shared), so the outline
 *  and the rendered headings always agree. */
export function extractMarkdownOutline(markdown: string): MarkdownOutlineItem[] {
  const seen = new Map<string, number>();
  const outline: MarkdownOutlineItem[] = [];

  for (const heading of markdownHeadings(markdown)) {
    if (heading.depth > 3 || !heading.text) continue;
    const baseId = slugifyHeading(heading.text);
    const count = seen.get(baseId) ?? 0;
    seen.set(baseId, count + 1);
    outline.push({
      id: count === 0 ? baseId : `${baseId}-${count + 1}`,
      level: heading.depth as 1 | 2 | 3,
      sourceLine: heading.line,
      title: heading.text,
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
        className="scroll-mt-6 text-3xl font-bold mt-6 mb-3 leading-tight"
      >
        {children}
      </h1>
    ),
    h2: ({ children, node }) => (
      <h2
        id={headingIdForNode(node, idBySourceLine)}
        className="scroll-mt-6 text-2xl font-bold mt-5 mb-2.5 leading-tight"
      >
        {children}
      </h2>
    ),
    h3: ({ children, node }) => (
      <h3
        id={headingIdForNode(node, idBySourceLine)}
        className="scroll-mt-6 text-xl font-bold mt-4 mb-2 leading-tight"
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
      className="border-l border-line-hairline pl-4 text-footnote"
    >
      <div className="mb-2 font-bold text-foreground-hint">
        {formatMessage({ id: "markdown.outline.title" })}
      </div>
      <ol className="stack-y-1.5">
        {outline.map((item) => (
          <li key={item.id} className={outlineIndentClass(item.level)}>
            <Tooltip content={item.title}>
              <a
                href={`#${item.id}`}
                className="block truncate rounded-[2px] font-medium text-foreground-muted outline-none hover:text-foreground focus-visible:shadow-focus"
              >
                {item.title}
              </a>
            </Tooltip>
          </li>
        ))}
      </ol>
    </nav>
  );
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
