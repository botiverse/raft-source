import { useCallback, useEffect, useRef, useState } from "react";

import { useRaftPermalinkHostnames } from "../../store/raftAppHosts";
import { readWebLinkOpenPreference, writeWebLinkOpenPreference } from "../../store/webLinkOpenPreference";
import type { WebLinkOpenPreference } from "../../store/webLinkOpenPreference";
import { useDesktopWebPreviewView } from "./useWebPreview";
import { WebLinkChoiceDialog } from "./WebLinkChoiceDialog";
import { canOpenWebLinkBeside, offerWebLinkMenu, openWebLinkBehind, openWebLinkBeside } from "./webLinkOpen";
import { linkIntentOf, routeShellLink, webLinkOf } from "./webLinkRouting";
import { openWebPreviewInNewTab } from "./webPreviewStore";

/**
 * Where every content link in Raft's own UI is decided (webLinkRouting.ts):
 * one listener on the document for a click, a middle click and a right-click
 * on a marked link, in Raft Desktop with its built-in browser
 * (desktop_web_preview_view_v0); elsewhere it does nothing and every link is
 * the anchor it was. Mounted once, by the layout.
 *
 * It runs after the components' own handlers (React's are on its root, below
 * the document): a link whose own handler already took the event (an
 * Artifact opened in place, a card button's authored rule) is left to it.
 */
export function WebLinkRouter() {
  const view = useDesktopWebPreviewView();
  const raftHostnames = useRaftPermalinkHostnames();
  const [asking, setAsking] = useState<{ href: string; element: HTMLAnchorElement } | null>(null);
  const hosts = useRef(raftHostnames);
  hosts.current = raftHostnames;

  useEffect(() => {
    if (!view) return;
    const onActivate = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      const anchor = webLinkOf(event.target);
      const intent = linkIntentOf(event);
      if (!anchor || !intent) return;
      const href = anchor.href;
      const outcome = routeShellLink(href, intent, readWebLinkOpenPreference(), hosts.current, canOpenWebLinkBeside(href, anchor, hosts.current));
      if (outcome.kind === "default" || outcome.kind === "refuse-visible") return;
      event.preventDefault();
      if (outcome.kind === "ask-first") setAsking({ href, element: anchor });
      else if (outcome.kind === "browser-tab" && outcome.where === "new-background") openWebLinkBehind(href, anchor, hosts.current);
      else if (outcome.kind === "browser-tab") openWebLinkBeside(href, anchor, hosts.current);
      else if (outcome.kind === "system-browser") openWebPreviewInNewTab(href);
    };
    // Not prevented: the shell's native menu follows, with Open Beside for this link.
    const onContextMenu = (event: MouseEvent) => {
      const anchor = webLinkOf(event.target);
      if (anchor) offerWebLinkMenu(view, anchor.href, anchor, hosts.current);
    };
    document.addEventListener("click", onActivate);
    document.addEventListener("auxclick", onActivate);
    document.addEventListener("contextmenu", onContextMenu);
    return () => {
      document.removeEventListener("click", onActivate);
      document.removeEventListener("auxclick", onActivate);
      document.removeEventListener("contextmenu", onContextMenu);
    };
  }, [view]);

  const handleChoose = useCallback((preference: WebLinkOpenPreference) => {
    const link = asking;
    setAsking(null);
    if (!link) return;
    writeWebLinkOpenPreference(preference);
    // The same link again, now with the answer.
    const outcome = routeShellLink(link.href, "plain", preference, hosts.current, canOpenWebLinkBeside(link.href, link.element, hosts.current));
    if (outcome.kind === "browser-tab") openWebLinkBeside(link.href, link.element, hosts.current);
    else openWebPreviewInNewTab(link.href);
  }, [asking]);
  // Dismissed (Esc or ×): the system browser this time, asked again next time.
  const handleDismiss = useCallback(() => {
    const link = asking;
    setAsking(null);
    if (link) openWebPreviewInNewTab(link.href);
  }, [asking]);

  return asking ? <WebLinkChoiceDialog onChoose={handleChoose} onDismiss={handleDismiss} /> : null;
}
