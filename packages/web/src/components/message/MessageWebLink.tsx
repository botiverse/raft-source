import { useCallback, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { MarkdownLink } from "@botiverse/raft-ui";
import type { DesktopWebPreviewBridge } from "@botiverse/raft-shared";
import { useDesktopWebPreviewView } from "../../features/webPreview/useWebPreview";
import { WebLinkChoiceDialog } from "../../features/webPreview/WebLinkChoiceDialog";
import { canOpenWebLinkBeside, offerWebLinkMenu, openWebLinkBeside } from "../../features/webPreview/webLinkOpen";
import { openWebPreviewInNewTab } from "../../features/webPreview/webPreviewStore";
import { useRaftPermalinkHostnames } from "../../store/raftAppHosts";
import { readWebLinkOpenPreference, writeWebLinkOpenPreference } from "../../store/webLinkOpenPreference";
import type { WebLinkOpenPreference } from "../../store/webLinkOpenPreference";

/**
 * A plain link in a message's text (a Markdown link or a bare URL that is not
 * a mention, a Raft link, an App's chip or a custom protocol): the author's
 * link, opening a new tab. In Raft Desktop with its web preview view
 * (desktop_web_preview_view_v0 and raftDesktop.webPreview), a plain click on
 * an http(s) page follows Settings › Appearance › How web links open: beside
 * the conversation, or the system browser; until that is chosen the first
 * click asks (WebLinkChoiceDialog). Anywhere else (a browser tab, the flag
 * off, an older shell) it is the same link as before.
 */
export function MessageWebLink({ href, children }: { href: string | undefined; children?: ReactNode }) {
  const view = useDesktopWebPreviewView();
  if (!view || !href) return <MarkdownLink href={href} target="_blank" rel="noopener noreferrer">{children}</MarkdownLink>;
  return <DesktopMessageWebLink href={href} view={view}>{children}</DesktopMessageWebLink>;
}

function DesktopMessageWebLink({ href, view, children }: { href: string; view: DesktopWebPreviewBridge; children?: ReactNode }) {
  const raftHostnames = useRaftPermalinkHostnames();
  const linkRef = useRef<HTMLAnchorElement | null>(null);
  const [asking, setAsking] = useState(false);

  const handleClick = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    // A modified or middle click, and a link Raft doesn't show beside (its own
    // pages, mailto:, no conversation to open beside): the link as it was.
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const preference = readWebLinkOpenPreference();
    if (preference === "browser" || !canOpenWebLinkBeside(href, event.currentTarget, raftHostnames)) return;
    event.preventDefault();
    if (preference === "beside") openWebLinkBeside(href, event.currentTarget, raftHostnames);
    else setAsking(true);
  }, [href, raftHostnames]);

  // Not prevented: the shell's native menu follows, with Open Beside for this link.
  const handleContextMenu = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    offerWebLinkMenu(view, href, event.currentTarget, raftHostnames);
  }, [href, raftHostnames, view]);

  const handleChoose = useCallback((preference: WebLinkOpenPreference) => {
    setAsking(false);
    writeWebLinkOpenPreference(preference);
    if (preference === "beside") openWebLinkBeside(href, linkRef.current, raftHostnames);
    else openWebPreviewInNewTab(href);
  }, [href, raftHostnames]);
  // Esc, × or the scrim: nothing is remembered, and the link opens as it always did.
  const handleDismiss = useCallback(() => {
    setAsking(false);
    openWebPreviewInNewTab(href);
  }, [href]);

  return (
    <>
      <MarkdownLink ref={linkRef} href={href} target="_blank" rel="noopener noreferrer" onClick={handleClick} onContextMenu={handleContextMenu}>
        {children}
      </MarkdownLink>
      {asking ? <WebLinkChoiceDialog onChoose={handleChoose} onDismiss={handleDismiss} /> : null}
    </>
  );
}
