import type { ReactNode } from "react";
import { InlineCode } from "@botiverse/raft-ui";
import type { Components, Options } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkGfm from "remark-gfm";
import MarkdownContent, { BaseCodePre } from "../markdown/MarkdownContent";
import { remarkRaftMath } from "../markdown/remarkRaftMath";
import { remarkMessageCardMarkdownSubset } from "./remarkMessageCardMarkdown";

type PluggableList = NonNullable<Options["remarkPlugins"]>;

// The message renderer's parse (compact density adds no indented code), as
// the Server parsed it, then the subset (remarkMessageCardMarkdownSubset):
// no bare-URL or raft:// linking beyond GFM's, no mention chips, no channel or
// task refs, no permalink chips. Math is parsed so a formula is found, and
// then drawn as its source.
const CARD_REMARK_PLUGINS: PluggableList = [remarkGfm, remarkCjkFriendly, remarkRaftMath, remarkBreaks, remarkMessageCardMarkdownSubset];

/** Code is code: a fence is a code block whatever its language (```math is no formula, ```mermaid no diagram). */
function CardMarkdownCode({ className, children }: { className?: string; children?: ReactNode }) {
  return className ? <code className={className}>{children}</code> : <InlineCode appearance="message">{children}</InlineCode>;
}

const CARD_MARKDOWN_COMPONENTS: Components = {
  pre: ({ children }) => <BaseCodePre>{children}</BaseCodePre>,
  code: ({ className, children }) => <CardMarkdownCode className={className}>{children}</CardMarkdownCode>,
};

/**
 * A card's `Markdown` element (RFC 082 §4.8), drawn by the message markdown
 * renderer (MarkdownContent: its styles, its safe links, sanitized, no raw
 * HTML) restricted to the card subset. `@name` and `#channel` stay text. At
 * the card's text size.
 */
export function MessageCardMarkdown({ content }: { content: string }) {
  return (
    <div className="min-w-0 text-sm leading-5 text-foreground break-words [overflow-wrap:anywhere]" data-message-card-markdown="">
      <MarkdownContent source={content} remarkPlugins={CARD_REMARK_PLUGINS} components={CARD_MARKDOWN_COMPONENTS} />
    </div>
  );
}
