import type { DesktopWebPreviewTabState } from "@botiverse/raft-shared";
import { create } from "zustand";

import { webPreviewUrl } from "./webPreviewAddress";

/**
 * The built-in browser's tabs (Raft Desktop, desktop_web_preview_view_v0, a
 * shell with `raftDesktop.webPreview.tabs`): one browser per conversation,
 * each a list of tabs and the one in front. In memory only: what a later
 * change may keep across restarts is `{ tabs: [{ url, title }], active }`,
 * which is each tab's `url` and `title` and the index of `activeId`; the rest
 * of a tab is the shell's report of its page and comes back by itself.
 *
 * This store is the list; the pages are the shell's native views
 * (browserViews.ts keeps the two in step). A page opened beside the
 * conversation goes to the tab that already shows that address, else to a new
 * tab; at the cap it replaces the page of the tab in front (that tab's Back
 * returns to what it showed).
 *
 * The side window shows the browser or the conversation's Artifact, whichever
 * came to the front last: `frontAt` against the Artifact's own opening time
 * and `parkedAt` (useArtifactPlaceCard). Parking the browser (`park`) keeps
 * every tab.
 */

/** The most tabs one conversation's browser holds; the shell refuses more views than this too (WEB_PREVIEW_MAX_TABS). */
export const BROWSER_MAX_TABS = 12;

export interface BrowserTab {
  /** Names the tab to the shell: 1 to 64 of A–Z a–z 0–9 _ -. */
  id: string;
  /** The address the tab shows now (the shell's report once it has one); null: an empty tab. */
  url: string | null;
  /** The address last asked for (opened beside, or typed): a page that redirects is still found by it. */
  askedUrl: string | null;
  /** Bumped by each address asked for: the shell loads `url` when it is ahead of what it was sent. */
  navigation: number;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

export interface Browser {
  tabs: BrowserTab[];
  activeId: string;
  /** When it last came to the front of the side window. */
  frontAt: number;
  /** When the Artifact was last let in front of it (the switch chip); 0: never. */
  parkedAt: number;
}

interface BrowserTabsState {
  browsers: Record<string, Browser>;
  /** Bumped when the address bar should take focus (New tab). */
  addressFocus: number;
  /** Shows `url` in the conversation's browser, in front: the tab already on it, else a new tab. */
  openUrl: (conversationId: string, url: string) => void;
  /** A new empty tab, in front, the address bar focused. Nothing at the cap. */
  newTab: (conversationId: string) => void;
  activate: (conversationId: string, tabId: string) => void;
  /** Closes the tab; its right neighbour comes to the front, else its left; the last tab closes the browser. */
  closeTab: (conversationId: string, tabId: string) => void;
  /** Loads `url` in the tab (the address bar). */
  navigate: (conversationId: string, tabId: string, url: string) => void;
  /** Closes the browser and every tab; focus goes back to what opened it (webPreviewStore). */
  close: (conversationId: string) => void;
  /** Brings the browser in front of the Artifact. */
  toFront: (conversationId: string) => void;
  /** Lets the Artifact in front; the browser and its tabs stay open behind it. */
  park: (conversationId: string) => void;
  /** The shell's report of a tab's page. */
  applyState: (conversationId: string, state: DesktopWebPreviewTabState) => void;
}

let sequence = 0;

function newTabId(): string {
  sequence += 1;
  return `t${Date.now().toString(36)}${sequence.toString(36)}`;
}

function tabFor(url: string | null): BrowserTab {
  return { id: newTabId(), url, askedUrl: url, navigation: url ? 1 : 0, title: "", canGoBack: false, canGoForward: false, loading: url !== null };
}

/** The tab's name in the strip: the page's title, else its host, else null (an empty tab: "New tab"). */
export function browserTabLabel(tab: Pick<BrowserTab, "title" | "url">): string | null {
  if (tab.title) return tab.title;
  return tab.url ? webPreviewUrl(tab.url)?.host ?? tab.url : null;
}

/** Whether the address is this computer's or the local network's: the strip marks it with a laptop instead of a globe. */
export function isLocalAddress(url: string | null): boolean {
  const hostname = webPreviewUrl(url)?.hostname;
  if (!hostname) return false;
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname === "[::1]") return true;
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

function withTab(browser: Browser, tabId: string, change: (tab: BrowserTab) => BrowserTab): Browser {
  return { ...browser, tabs: browser.tabs.map((tab) => (tab.id === tabId ? change(tab) : tab)) };
}

function loading(tab: BrowserTab, url: string): BrowserTab {
  return { ...tab, url, askedUrl: url, navigation: tab.navigation + 1, title: "", loading: true };
}

export const useBrowserTabsStore = create<BrowserTabsState>((set, get) => {
  const put = (conversationId: string, browser: Browser) => set({ browsers: { ...get().browsers, [conversationId]: browser } });
  return {
    browsers: {},
    addressFocus: 0,
    openUrl: (conversationId, href) => {
      const url = webPreviewUrl(href)?.href;
      if (!url) return;
      const browser = get().browsers[conversationId];
      const frontAt = Date.now();
      if (!browser) {
        const tab = tabFor(url);
        put(conversationId, { tabs: [tab], activeId: tab.id, frontAt, parkedAt: 0 });
        return;
      }
      const showing = browser.tabs.find((tab) => tab.url === url || tab.askedUrl === url);
      if (showing) {
        put(conversationId, { ...browser, activeId: showing.id, frontAt });
        return;
      }
      if (browser.tabs.length >= BROWSER_MAX_TABS) {
        // No room for another tab: the page takes the tab in front.
        put(conversationId, { ...withTab(browser, browser.activeId, (tab) => loading(tab, url)), frontAt });
        return;
      }
      const tab = tabFor(url);
      put(conversationId, { ...browser, tabs: [...browser.tabs, tab], activeId: tab.id, frontAt });
    },
    newTab: (conversationId) => {
      const browser = get().browsers[conversationId];
      if (!browser || browser.tabs.length >= BROWSER_MAX_TABS) return;
      const tab = tabFor(null);
      set({ browsers: { ...get().browsers, [conversationId]: { ...browser, tabs: [...browser.tabs, tab], activeId: tab.id } }, addressFocus: get().addressFocus + 1 });
    },
    activate: (conversationId, tabId) => {
      const browser = get().browsers[conversationId];
      if (!browser || browser.activeId === tabId || !browser.tabs.some((tab) => tab.id === tabId)) return;
      put(conversationId, { ...browser, activeId: tabId });
    },
    closeTab: (conversationId, tabId) => {
      const browser = get().browsers[conversationId];
      const index = browser ? browser.tabs.findIndex((tab) => tab.id === tabId) : -1;
      if (!browser || index < 0) return;
      if (browser.tabs.length === 1) {
        get().close(conversationId);
        return;
      }
      const tabs = browser.tabs.filter((tab) => tab.id !== tabId);
      // The right neighbour takes its place, else the left one.
      const activeId = browser.activeId === tabId ? (tabs[index] ?? tabs[index - 1]!).id : browser.activeId;
      put(conversationId, { ...browser, tabs, activeId });
    },
    navigate: (conversationId, tabId, href) => {
      const url = webPreviewUrl(href)?.href;
      const browser = get().browsers[conversationId];
      if (!url || !browser) return;
      put(conversationId, withTab(browser, tabId, (tab) => loading(tab, url)));
    },
    close: (conversationId) => {
      if (!get().browsers[conversationId]) return;
      const { [conversationId]: _closed, ...browsers } = get().browsers;
      set({ browsers });
    },
    toFront: (conversationId) => {
      const browser = get().browsers[conversationId];
      if (browser) put(conversationId, { ...browser, frontAt: Date.now() });
    },
    park: (conversationId) => {
      const browser = get().browsers[conversationId];
      if (browser) put(conversationId, { ...browser, parkedAt: Date.now() });
    },
    applyState: (conversationId, state) => {
      const browser = get().browsers[conversationId];
      const tab = browser?.tabs.find((candidate) => candidate.id === state.tabId);
      if (!browser || !tab) return;
      // Only an http(s) address is the tab's (never about:blank before the first load, or an error page's).
      const url = webPreviewUrl(state.url)?.href ?? tab.url;
      const title = typeof state.title === "string" ? state.title : tab.title;
      const next: BrowserTab = { ...tab, url, title, canGoBack: state.canGoBack === true, canGoForward: state.canGoForward === true, loading: state.loading === true };
      if (next.url === tab.url && next.title === tab.title && next.canGoBack === tab.canGoBack && next.canGoForward === tab.canGoForward && next.loading === tab.loading) return;
      put(conversationId, withTab(browser, tab.id, () => next));
    },
  };
});
