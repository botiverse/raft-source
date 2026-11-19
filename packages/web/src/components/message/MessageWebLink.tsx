import type { ReactNode } from "react";
import { MarkdownLink } from "@botiverse/raft-ui";

import { webLinkProps } from "../../features/webPreview/webLinkRouting";

/**
 * A plain link in a message's text (a Markdown link or a bare URL that is not
 * a mention, a Raft link, an App's chip or a custom protocol): the author's
 * link, opening a new tab. It is a content link (`webLinkProps`): in Raft
 * Desktop with its built-in browser, where it opens is the link router's
 * decision (features/webPreview WebLinkRouter: Settings › Appearance › How
 * web links open, the first-time question, a new tab for Ctrl/Cmd-click and
 * a middle click). Anywhere else it is the same link as before.
 */
export function MessageWebLink({ href, children }: { href: string | undefined; children?: ReactNode }) {
  return <MarkdownLink href={href} target="_blank" rel="noopener noreferrer" {...webLinkProps}>{children}</MarkdownLink>;
}
