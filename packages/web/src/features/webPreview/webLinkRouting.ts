import { classifyLinkTarget, routeLink } from "@botiverse/raft-shared";
import type { LinkIntent, LinkOutcome, LinkPreference } from "@botiverse/raft-shared";

/**
 * Raft's own UI's side of the link router (packages/shared linkRouter.ts,
 * origin "shell"; #proj-workspace:#293). A link to a page outside Raft that
 * a person reads in a conversation (a message's link, an App's chip, a card's
 * title or navigate button, a channel's description) is marked as one
 * (`webLinkProps`), and every activation of a marked link is decided in one
 * place (WebLinkRouter, a listener on the document), by the same rule: the
 * person's How web links open choice, the first-time question, a new tab for
 * Ctrl/Cmd-click and a middle click. No component decides for itself.
 *
 * A link that isn't marked is not content: the app's own chrome (billing,
 * setup, sign-in, docs) keeps opening outside, as it must.
 */
export const WEB_LINK_ATTRIBUTE = "data-web-link";

/** The props that mark an anchor as a content link the router decides for. */
export const webLinkProps = { [WEB_LINK_ATTRIBUTE]: "" } as const;

/** What a pointer event on a link asks for, or null where the router leaves the event alone (Alt-click, other buttons). */
export function linkIntentOf(event: { type: string; button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): LinkIntent | null {
  if (event.altKey) return null;
  if (event.type === "auxclick") return event.button === 1 ? "new-tab" : null;
  if (event.type !== "click" || event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey) return "new-tab";
  return event.shiftKey ? "new-window" : "plain";
}

/** The marked link an event started in, or null. */
export function webLinkOf(target: EventTarget | null): HTMLAnchorElement | null {
  if (!(target instanceof Element)) return null;
  const anchor = target.closest<HTMLAnchorElement>(`a[${WEB_LINK_ATTRIBUTE}][href]`);
  return anchor && !anchor.hasAttribute("download") ? anchor : null;
}

/** The router's outcome for a marked link in Raft's own UI. `browser`: the built-in browser can open it beside its conversation. */
export function routeShellLink(href: string, intent: LinkIntent, preference: LinkPreference, raftHostnames: readonly string[], browser: boolean): LinkOutcome {
  return routeLink({ target: classifyLinkTarget(href, raftHostnames), intent, origin: "shell", preference, browser });
}
