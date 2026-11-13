import { memo, useMemo } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import type { Components } from "react-markdown";
import { CodeBlock, CodeBlockBody, CodeBlockPre, InlineCode, MarkdownLink, MessageItemSearchMatch, TextLinkExternalIcon } from "@botiverse/raft-ui";

import MarkdownContent from "../markdown/MarkdownContent";
import { AGENT_CONTEXT_VIEW_MATCH_PROPERTY, AGENT_CONTEXT_VIEW_REHYPE_PLUGINS, agentContextViewRemarkPlugins } from "./agentContextViewMarkdownSubset";
import type { AgentContextViewMarkdownSearch } from "./agentContextViewMarkdownSubset";

function hostOf(href: string | undefined): string | null {
  if (!href || !/^https?:/i.test(href)) return null;
  try {
    return new URL(href).hostname || null;
  } catch {
    return null;
  }
}

/**
 * A link leaves Raft in a new tab (↗), its site after it, unless the text is
 * itself a URL on exactly that host (a bare link): text that only mentions a
 * host (`paypal.com?evil.example`) never hides where the link goes.
 */
function ContextLink({ href, children }: { href?: string; children?: ReactNode }) {
  const { formatMessage } = useIntl();
  const host = hostOf(href);
  const text = typeof children === "string" ? children : null;
  const showsWhere = text !== null && host !== null && hostOf(text) === host;
  return (
    <>
      <MarkdownLink href={href} target="_blank" rel="noopener noreferrer">
        {children}
        <TextLinkExternalIcon label={formatMessage({ id: "common.opensInNewTab" })} />
      </MarkdownLink>
      {host && !showsWhere ? <span className="ms-1 text-foreground-hint" data-testid="agent-context-view-link-host">{host}</span> : null}
    </>
  );
}

function CodeRegion({ children }: { children?: ReactNode }) {
  const { formatMessage } = useIntl();
  return (
    <CodeBlock className="min-w-0 max-w-full">
      <CodeBlockBody>
        <CodeBlockPre className="whitespace-pre-wrap wrap-break-word" aria-label={formatMessage({ id: "ui.codeBlock.region" })}>
          {children}
        </CodeBlockPre>
      </CodeBlockBody>
    </CodeBlock>
  );
}

const COMPONENTS: Components = {
  // Headings at the transcript's size: weight, not size, sets them apart.
  h1: ({ children }) => <p className="mt-2 mb-1 font-semibold first:mt-0">{children}</p>,
  h2: ({ children }) => <p className="mt-2 mb-1 font-semibold first:mt-0">{children}</p>,
  h3: ({ children }) => <p className="mt-2 mb-1 font-semibold first:mt-0">{children}</p>,
  h4: ({ children }) => <p className="mt-2 mb-1 font-semibold first:mt-0">{children}</p>,
  h5: ({ children }) => <p className="mt-2 mb-1 font-semibold first:mt-0">{children}</p>,
  h6: ({ children }) => <p className="mt-2 mb-1 font-semibold text-foreground-muted first:mt-0">{children}</p>,
  pre: ({ children }) => <CodeRegion>{children}</CodeRegion>,
  // Code is only code: never chat's formula (KaTeX, `language-math`) or diagram renderer.
  code: ({ className, children }) => (className ? <code className={className}>{children}</code> : <InlineCode appearance="message">{children}</InlineCode>),
  a: ({ href, children }) => <ContextLink href={href}>{children}</ContextLink>,
  // Never reached (an image is drawn as its source text); never an <img> either way.
  img: ({ alt }) => <span>{alt}</span>,
  mark: ({ node, children }) => {
    const current = node?.properties?.[AGENT_CONTEXT_VIEW_MATCH_PROPERTY] === "current";
    return (
      <MessageItemSearchMatch
        className={current ? "outline-2 outline-foreground" : undefined}
        data-agent-context-view-match={current ? "current" : "other"}
        data-testid="agent-context-view-match"
      >
        {children}
      </MessageItemSearchMatch>
    );
  },
};

/**
 * Text an agent was given or wrote (a system prompt block, a user or
 * assistant message), as Markdown at the transcript's size: the allowlist,
 * marks and breaks of agentContextViewMarkdown, chat's lists, quotes and
 * inline code (MarkdownContent), code wrapped on the code surface.
 */
export const AgentContextViewMarkdown = memo(function AgentContextViewMarkdown({ source, search, testId }: {
  source: string;
  search: AgentContextViewMarkdownSearch | null;
  testId?: string;
}) {
  const remarkPlugins = useMemo(() => agentContextViewRemarkPlugins(search), [search]);
  return (
    <div className="min-w-0 text-callout text-foreground wrap-break-word" data-testid={testId} data-agent-context-view-markdown="">
      <MarkdownContent
        source={source}
        density="compact"
        remarkPlugins={remarkPlugins}
        rehypePlugins={AGENT_CONTEXT_VIEW_REHYPE_PLUGINS}
        components={COMPONENTS}
      />
    </div>
  );
});
