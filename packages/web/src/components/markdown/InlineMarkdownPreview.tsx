import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import type { Components, Options } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";
import { InlineCode } from "@botiverse/raft-ui";
import { remarkAutolinkBareUrls } from "../../utils/markdownAutolink";

const INLINE_PREVIEW_CODE_CLASS =
  "border-0 bg-transparent p-0 font-normal leading-[inherit] text-inherit";

const REMARK_PLUGINS: Options["remarkPlugins"] = [remarkGfm, remarkCjkFriendly, remarkAutolinkBareUrls, remarkBreaks];

// Preview cards wrap this renderer in line-clamp utilities. Keep every
// markdown construct inline so hidden list/table content cannot reserve
// extra height below the visible preview on mobile Safari.
const INLINE_COMPONENTS: Components = {
  p: ({ children }) => <span>{children}</span>,
  code: ({ children }) => (
    <InlineCode className={INLINE_PREVIEW_CODE_CLASS}>{children}</InlineCode>
  ),
  br: () => <span> </span>,
  ul: ({ children }) => <span>{children}</span>,
  ol: ({ children }) => <span>{children}</span>,
  li: ({ children }) => <span>{children} </span>,
  blockquote: ({ children }) => <span>{children}</span>,
  h1: ({ children }) => <span>{children}</span>,
  h2: ({ children }) => <span>{children}</span>,
  h3: ({ children }) => <span>{children}</span>,
  h4: ({ children }) => <span>{children}</span>,
  h5: ({ children }) => <span>{children}</span>,
  h6: ({ children }) => <span>{children}</span>,
  pre: ({ children }) => <span className="font-mono">{children}</span>,
  table: ({ children }) => <span>{children}</span>,
  thead: ({ children }) => <span>{children}</span>,
  tbody: ({ children }) => <span>{children}</span>,
  tr: ({ children }) => <span>{children}</span>,
  th: ({ children }) => <span>{children} </span>,
  td: ({ children }) => <span>{children} </span>,
  hr: () => <span> </span>,
};

// Text the markdown pipeline renders as one plain paragraph: no character it
// gives meaning to on a single line, no line break, nothing it links (a URL,
// a www. host, an email) and no block marker at the start. Most previews are
// plain prose, and parsing each one was about a quarter of the first render
// of a page of Activity rows (task #5). Anything else takes the parser.
// A thematic break (---) and NUL (which the parser replaces) count too.
const MARKDOWN_SIGNIFICANT = /[\0\n\r*_~`[\]<\\&]|https?:|www\.|\S@\S|^\s|\s$|^\d+[.)](\s|$)|^(-{3,}|[-+](\s|$))|^#{1,6}(\s|$)|^>/;

/** Whether `markdown` renders as nothing but its own text (see MARKDOWN_SIGNIFICANT). */
export function isPlainPreviewText(markdown: string): boolean {
  return markdown.length > 0 && !MARKDOWN_SIGNIFICANT.test(markdown);
}

interface InlineMarkdownPreviewProps {
  markdown: string;
  linkClassName?: string;
}

export default function InlineMarkdownPreview({ markdown, linkClassName }: InlineMarkdownPreviewProps) {
  // The same <span> the parser renders the paragraph as (INLINE_COMPONENTS.p).
  if (isPlainPreviewText(markdown)) return <span>{markdown}</span>;
  return <ParsedMarkdownPreview markdown={markdown} linkClassName={linkClassName} />;
}

/** The preview through the markdown parser. Exported for the plain-text equivalence test. */
export function ParsedMarkdownPreview({
  markdown,
  // Links in a preview are spans (the whole card is the click target), so
  // they keep the link colour but not the underline a clickable link has.
  linkClassName = "text-foreground-link",
}: InlineMarkdownPreviewProps) {
  const components = useMemo<Components>(
    () => ({
      ...INLINE_COMPONENTS,
      a: ({ children }) => <span className={linkClassName}>{children}</span>,
    }),
    [linkClassName],
  );

  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>
      {markdown}
    </ReactMarkdown>
  );
}
