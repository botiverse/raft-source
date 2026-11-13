import { isRaftAppHostname } from "@botiverse/raft-shared";
import { create } from "zustand";

import { getDesktopBridge } from "../../utils/desktopBridge";
import { useBrowserTabsStore } from "./browserTabsStore";
import { webPreviewUrl } from "./webPreviewAddress";

export { webPreviewUrl };

/**
 * Web preview (web_preview_v0): one web page open beside a conversation, in
 * the channel's side area where an Artifact opens (WebPreviewPanel). One page
 * at a time; opening another replaces it. The side area shows whichever of it
 * and an open Artifact was opened last (ChatPanel), so closing the page gives
 * the Artifact back. The frame's rules (sandbox, phone width) live here too,
 * beside the store the panel reads.
 */

/** As an Artifact's (ARTIFACT_CARD_MIN_WIDTH): a page needs a document's width beside the messages. */
export const WEB_PREVIEW_MIN_WIDTH = 480;
/** The phone frame's width: an iPhone 12–16's CSS width. */
export const WEB_PREVIEW_PHONE_WIDTH = 390;

/**
 * The frame's sandbox (security boundary; PR "Security"). The page is another
 * origin than Raft's, so none of these reach Raft itself:
 * - allow-scripts: almost every site needs script to render at all.
 * - allow-same-origin: the page keeps its OWN origin (its cookies, storage,
 *   fetches to itself); without it most sites break (logins, SPAs, CSRF
 *   tokens). It grants nothing over Raft: the frame's origin differs from
 *   Raft's, so the same-origin policy still walls Raft's DOM, storage and
 *   cookies off from it. (The one unsafe pairing, allow-scripts with
 *   allow-same-origin on a SAME-origin document, can't happen: Raft's own
 *   hosts are never previewed, webPreviewTarget.)
 * - allow-forms: search boxes and sign-in forms submit.
 * - allow-popups + allow-popups-to-escape-sandbox: a link the page opens in a
 *   new tab opens as a normal page (in the desktop app, the system browser),
 *   not one stuck with this sandbox.
 * - allow-downloads: a download the person starts in the page works.
 * Left out on purpose: allow-top-navigation(-by-user-activation) (the page
 * can never navigate Raft away), allow-modals (no alert/confirm/print over
 * Raft), allow-pointer-lock, allow-presentation, allow-orientation-lock,
 * allow-storage-access-by-user-activation.
 */
export const WEB_PREVIEW_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads";

export type WebPreviewWidth = "desktop" | "phone";

export interface WebPreviewPage {
  /** The address as WHATWG parses it (http or https only). */
  url: string;
  /** The channel (or DM) panel it opens beside. */
  conversationId: string;
}

interface WebPreviewState {
  page: WebPreviewPage | null;
  openedAt: number;
  width: WebPreviewWidth;
  /** Bumped by Refresh: the frame mounts again. */
  reloads: number;
  open: (page: WebPreviewPage) => void;
  close: () => void;
  setWidth: (width: WebPreviewWidth) => void;
  reload: () => void;
}


/**
 * The page a card button can open beside the conversation, or null: http(s)
 * only, and not one of Raft's own app hosts (`raftHostnames`, the page's and
 * the deployment's: those links already open in the app). Credentials in the
 * address (`https://user:pass@…`) are never framed either.
 */
export function webPreviewTarget(href: string | undefined | null, raftHostnames: readonly string[]): URL | null {
  const url = webPreviewUrl(href);
  if (!url || url.username || url.password) return null;
  if (isRaftAppHostname(url.hostname, raftHostnames)) return null;
  return url;
}

/**
 * Whether the page can be framed at all. A plain-http page inside Raft (an
 * https page, or the desktop app's secure app:// origin) is mixed content the
 * browser blocks, so it is never framed: the panel says so and offers a new
 * tab. Decided by the address alone, the same on every host.
 */
export function canFrameWebPreview(url: string): boolean {
  return webPreviewUrl(url)?.protocol === "https:";
}

/**
 * Whether the panel can show the page: in Raft Desktop's native view
 * (desktop_web_preview_view_v0, `nativeView`) any http(s) page, plain http
 * included (a real browser view, not a frame, so no mixed content; local dev
 * servers are mostly http; security review, 2026-11-12), its address bar
 * marking it Not secure. Else only what can be framed (canFrameWebPreview).
 */
export function canShowWebPreview(url: string, nativeView: boolean): boolean {
  return nativeView ? webPreviewUrl(url) !== null : canFrameWebPreview(url);
}

/** Where focus goes back to when the panel closes: the card button that opened it. */
let returnFocusTo: HTMLElement | null = null;

export function setWebPreviewReturnFocus(element: HTMLElement | null): void {
  returnFocusTo = element;
}

function takeWebPreviewReturnFocus(): HTMLElement | null {
  const element = returnFocusTo;
  returnFocusTo = null;
  return element?.isConnected ? element : null;
}

export const useWebPreviewStore = create<WebPreviewState>((set, get) => ({
  page: null,
  openedAt: 0,
  width: "desktop",
  reloads: 0,
  open: ({ url, conversationId }) => {
    const parsed = webPreviewUrl(url);
    if (!parsed) return;
    set({ page: { url: parsed.href, conversationId }, openedAt: Date.now(), reloads: 0 });
  },
  close: () => {
    if (get().page === null) return;
    set({ page: null });
    takeWebPreviewReturnFocus()?.focus();
  },
  setWidth: (width) => set({ width }),
  reload: () => set({ reloads: get().reloads + 1 }),
}));

// The built-in browser closed (its last tab, or Close): focus goes back to what opened it, as the panel's does.
useBrowserTabsStore.subscribe((state, previous) => {
  if (Object.keys(previous.browsers).some((conversationId) => !(conversationId in state.browsers))) takeWebPreviewReturnFocus()?.focus();
});

/** The attribute a channel panel's body carries: the conversation a web preview opened from inside it goes beside. */
export const WEB_PREVIEW_HOST_ATTRIBUTE = "data-web-preview-host";

/**
 * The conversation a preview opened from `from` goes beside: the channel
 * panel it is in, else (a thread beside its channel) the one channel panel on
 * screen. Null where there is none: the caller opens a new tab instead.
 */
export function webPreviewHostOf(from: Element | null): string | null {
  const own = from?.closest(`[${WEB_PREVIEW_HOST_ATTRIBUTE}]`)?.getAttribute(WEB_PREVIEW_HOST_ATTRIBUTE);
  if (own) return own;
  if (typeof document === "undefined") return null;
  const hosts = [...document.querySelectorAll<HTMLElement>(`[${WEB_PREVIEW_HOST_ATTRIBUTE}]`)].filter(
    (element) => !element.closest("[inert]") && (typeof element.checkVisibility !== "function" || element.checkVisibility()),
  );
  return hosts.length === 1 ? hosts[0]!.getAttribute(WEB_PREVIEW_HOST_ATTRIBUTE) : null;
}

/** Opens a page in a new tab without opener or referrer, as a message link does. */
export function openWebPreviewInNewTab(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Opens `url` beside the conversation `from` is in (its channel panel, or the
 * one on screen), focus returning to `returnFocus` when it closes. False when
 * it can't open there: no conversation hosts it, or the page is one Raft
 * doesn't show (Raft's own hosts; http, unless `nativeView`: Raft Desktop's
 * native view, canShowWebPreview); the caller then opens a new tab.
 */
export function openWebPreviewBeside(
  url: string,
  from: Element | null,
  returnFocus: HTMLElement | null,
  raftHostnames: readonly string[],
  nativeView = false,
): boolean {
  const target = webPreviewTarget(url, raftHostnames);
  if (!target || !canShowWebPreview(target.href, nativeView)) return false;
  const conversationId = webPreviewHostOf(from);
  if (!conversationId) return false;
  setWebPreviewReturnFocus(returnFocus);
  // Raft Desktop's built-in browser (a shell with tabs): a tab of the conversation's browser (browserTabsStore).
  // A shell without them, or the frame: the one page.
  if (nativeView && getDesktopBridge()?.webPreview?.tabs) useBrowserTabsStore.getState().openUrl(conversationId, target.href);
  else useWebPreviewStore.getState().open({ url: target.href, conversationId });
  return true;
}
