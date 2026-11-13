import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useLocation } from "react-router-dom";
import api from "../../api/client";
import { useAuthStore } from "../../store/authStore";
import { useServerStore } from "../../store/serverStore";
import { DEEP_LINKS_FLAG_KEY, useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { isMessageLinkLanding, noteMessageLinkLocation, parseMessageLink } from "../../utils/messageLinkLanding";
import type { MessageLinkTarget } from "../../utils/messageLinkLanding";
import { notePageLocation, pageLandingAt, subscribePageLanding } from "../../utils/pageLanding";
import type { PageLanding } from "../../utils/pageLanding";

/**
 * deep_links_v1 (default off). Signed in, it is the current server's flag,
 * like every other web flag. The in-app browser guide and the open-in-app
 * offers also show on signed-out pages (people arriving from a chat, usually
 * signed in to the app and not to the web), where no server flag can be read:
 * there they ask the before-login endpoint (GET /public/feature-flags), which only
 * answers for flags marked answerable before login and only from platform
 * rules and the default, so it is on there only once FFA turns it on for
 * everyone (docs/contracts/pre-auth-feature-flags.md).
 */
export function useDeepLinksFlag(options: { serverId?: string | null } = {}): { enabled: boolean; resolved: boolean } {
  const { enabled, state } = useServerFeatureFlag(DEEP_LINKS_FLAG_KEY, options);
  return { enabled, resolved: state === "enabled" || state === "disabled" || state === "undetermined" };
}

let publicFlagRead: Promise<boolean> | null = null;

/** The before-login answer, read once per page. Any failure is off. */
export function readPublicDeepLinksFlag(): Promise<boolean> {
  publicFlagRead ??= api
    .get<{ flags?: Record<string, boolean> }>("/public/feature-flags", {
      params: { keys: DEEP_LINKS_FLAG_KEY, platform: "web" },
    })
    .then(({ data }) => data?.flags?.[DEEP_LINKS_FLAG_KEY] === true)
    .catch(() => false);
  return publicFlagRead;
}

export function resetPublicDeepLinksFlagForTests(): void {
  publicFlagRead = null;
}

/** The before-login answer as state; false until it arrives, and never asked while `active` is false. */
export function usePublicDeepLinksFlag(active: boolean): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void readPublicDeepLinksFlag().then((value) => {
      if (!cancelled) setEnabled(value);
    });
    return () => {
      cancelled = true;
    };
  }, [active]);
  return active && enabled;
}

/** The guide's gate: the server's flag when someone is signed in to a server, else the before-login answer. */
export function useDeepLinksGuideFlag(): boolean {
  const signedIn = useAuthStore((s) => s.user !== null);
  const serverId = useServerStore((s) => s.current?.id ?? null);
  const server = useDeepLinksFlag();
  const usePublic = !signedIn || !serverId;
  const publicFlag = usePublicDeepLinksFlag(usePublic);
  return usePublic ? publicFlag : server.enabled;
}

/**
 * The open-in-app offers' gate. Signed in they show in a workspace, behind
 * its server's flag, as before. Signed out (the sign-in page of a landed
 * workspace address) there is no server to ask: the before-login answer, as
 * the guide, so there they appear only once the flag is on for everyone.
 */
export function useOpenInAppOfferFlag(): boolean {
  const signedIn = useAuthStore((s) => s.user !== null);
  const server = useDeepLinksFlag();
  const publicFlag = usePublicDeepLinksFlag(!signedIn);
  return signedIn ? server.enabled : publicFlag;
}

/**
 * The message link this page landed on (from a link, a fresh load or Raft
 * Desktop's raft:// hand-off), with the flag that decides whether the
 * link-specific states apply. Null `target` for any other address, including
 * one the app wrote itself.
 */
export function useLandedMessageLink(pathname: string, search: string): {
  target: MessageLinkTarget | null;
  enabled: boolean;
  resolved: boolean;
} {
  const flag = useDeepLinksFlag();
  const target = isMessageLinkLanding(pathname, search) ? parseMessageLink(pathname, search) : null;
  return { target, enabled: flag.enabled, resolved: flag.resolved };
}

/**
 * The workspace layout reports each location it shows, so a landed message
 * link counts once: after the app moves on, coming back to that address
 * (Chat's remembered tab, History, the sidebar) is not a landing again.
 */
export function useMessageLinkLandingLifetime(pathname: string, search: string): void {
  useEffect(() => {
    noteMessageLinkLocation(pathname, search);
  }, [pathname, search]);
}

/**
 * The address this browser landed on (any page, utils/pageLanding.ts), while
 * the app still shows that page: what the open-in-app offers are about. Null
 * once the person has gone elsewhere, and for an address the app wrote itself.
 */
export function usePageLanding(): PageLanding | null {
  const { pathname } = useLocation();
  const read = useCallback(() => pageLandingAt(pathname), [pathname]);
  return useSyncExternalStore(subscribePageLanding, read, read);
}

/**
 * While the page a link landed on is on screen and the open-in-app offers may
 * show there (the flag on), the announcement dialog waits (#proj-mobile:#128,
 * InNOut on 1.23.0): a phone that came from a link got "Open in the Raft app"
 * and "Raft is better in the app" at once, the dialog's scrim over the row's
 * Open. One app prompt at a time: the one about the link. Once the person
 * moves on the landing is spent and announcements show as before.
 */
export function useLandingHoldsAnnouncements(): boolean {
  const landing = usePageLanding();
  const offered = useOpenInAppOfferFlag();
  return offered && landing !== null;
}

/** The offers' strip reports each page the workspace shows, so a landing is spent once the app moves on from it. */
export function usePageLandingLifetime(): void {
  const { pathname } = useLocation();
  useEffect(() => {
    notePageLocation(pathname);
  }, [pathname]);
}

/** The conversation itself, without the link's `msg` / `thread`: where Back goes when the message can't be shown. */
export function conversationPathOf(target: MessageLinkTarget): string {
  return `/s/${encodeURIComponent(target.serverSlug)}/${target.routeKind}/${encodeURIComponent(target.channelId)}`;
}

/** The server's start, for a conversation that can't be shown at all. */
export function serverPathOf(target: MessageLinkTarget): string {
  return `/s/${encodeURIComponent(target.serverSlug)}`;
}
