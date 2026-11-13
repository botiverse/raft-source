import type { DesktopWebPreviewBridge } from "@botiverse/raft-shared";
import { openWebPreviewBeside, openWebPreviewInNewTab, webPreviewHostOf, webPreviewTarget } from "./webPreviewStore";

/**
 * A plain web link in a message, in Raft Desktop with its web preview view
 * (desktop_web_preview_view_v0): whether it can open beside the conversation,
 * opening it either way, and the native right-click menu's Open Beside.
 * MessageWebLink decides when; the rules of what opens beside stay
 * webPreviewStore's (http(s), not Raft's own hosts, no credentials, a
 * conversation to open beside).
 */

/** Whether `href` can open beside the conversation `from` is in, in the native view. */
export function canOpenWebLinkBeside(href: string, from: Element | null, raftHostnames: readonly string[]): boolean {
  return webPreviewTarget(href, raftHostnames) !== null && webPreviewHostOf(from) !== null;
}

/** Opens the link beside the conversation, or, where it can't, in the system browser. */
export function openWebLinkBeside(href: string, from: HTMLElement | null, raftHostnames: readonly string[]): void {
  const anchor = from?.isConnected ? from : null;
  if (!openWebPreviewBeside(href, anchor, anchor, raftHostnames, true)) openWebPreviewInNewTab(href);
}

interface OfferedLink {
  url: string;
  element: HTMLElement;
  raftHostnames: readonly string[];
}

/** The link last right-clicked: the only one the native menu's Open Beside may open. */
let offered: OfferedLink | null = null;
const subscribed = new WeakSet<DesktopWebPreviewBridge>();

/**
 * Called from the link's `contextmenu` event: the shell's native menu for
 * this right-click then offers Open Beside (beside its Open in Browser), and
 * picking it opens the link beside the conversation it is in. Nothing on a
 * shell without the two bridge methods: its menu stays as it was.
 */
export function offerWebLinkMenu(bridge: DesktopWebPreviewBridge, href: string, element: HTMLElement, raftHostnames: readonly string[]): void {
  if (!bridge.offerLinkMenu || !bridge.onOpenLinkBeside) return;
  const target = webPreviewTarget(href, raftHostnames);
  if (!target || webPreviewHostOf(element) === null) return;
  if (!subscribed.has(bridge)) {
    subscribed.add(bridge);
    // Kept for the page's life: one listener, whichever link is right-clicked.
    bridge.onOpenLinkBeside((url) => {
      const link = offered;
      if (!link || webPreviewTarget(url, link.raftHostnames)?.href !== link.url) return;
      openWebLinkBeside(link.url, link.element, link.raftHostnames);
    });
  }
  offered = { url: target.href, element, raftHostnames };
  bridge.offerLinkMenu(target.href);
}
