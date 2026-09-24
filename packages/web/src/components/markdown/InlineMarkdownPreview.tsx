import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { InlineCode } from "raft-ui";
import { remarkAutolinkBareUrls } from "../../utils/markdownAutolink";

const INLINE_PREVIEW_CODE_CLASS =
  "border-0 bg-transparent p-0 font-normal leading-[inherit] text-inherit";

export default function InlineMarkdownPreview({
  markdown,
  linkClassName = "text-blue-700 underline decoration-2 underline-offset-2",
}: {
  markdown: string;
  linkClassName?: string;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkAutolinkBareUrls, remarkBreaks]}
      components={{
        // Preview cards wrap this renderer in line-clamp utilities. Keep every
        // markdown construct inline so hidden list/table content cannot reserve
        // extra height below the visible preview on mobile Safari.
        p: ({ children }) => <span>{children}</span>,
        a: ({ children }) => <span className={linkClassName}>{children}</span>,
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
      }}
    >
      {markdown}
    </ReactMarkdown>
  );
}
