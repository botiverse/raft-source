import type { DesktopWebPreviewTabsBridge } from "@botiverse/raft-shared";

import { useBrowserTabsStore } from "./browserTabsStore";

/**
 * Keeps the shell's native views (raftDesktop.webPreview.tabs, one per tab)
 * in step with the built-in browser's tab list (browserTabsStore). The list
 * says what should exist; this module asks the shell for exactly that, and
 * nothing in the UI talks to the shell about a tab's life directly.
 *
 * What is alive when:
 * - Views exist only for the conversation on screen (a channel panel that
 *   hosts the side window is mounted: `attach`). Leaving it destroys every
 *   view (`closeAll`); the tab list stays, and coming back loads the tab in
 *   front again at its last address (its Back / Forward history is gone).
 * - A tab's view is made when the tab first comes to the front, and then kept
 *   until the tab closes: switching tabs keeps each page as it was.
 * - Only the tab in front shows, and only while the browser's panel is on
 *   screen (`setShowing`): parked behind the Artifact, every view is hidden
 *   (`activate(null)`) but none is destroyed.
 */

let bridge: DesktopWebPreviewTabsBridge | null = null;
let unsubscribeState: (() => void) | null = null;
let unsubscribeStore: (() => void) | null = null;
/** The conversations whose channel panel is mounted, each with how many mounts hold it. */
const attached = new Map<string, number>();
/** The conversation whose browser panel (its placeholder) is on screen. */
let showing: string | null = null;
/** Whose views the shell holds now. */
let owner: string | null = null;
/** The tabs with a view, each with the `navigation` its address was last sent at. */
const live = new Map<string, number>();
/** The tab the shell was last told to show. */
let shown: string | null = null;

/** The attached conversation with a browser; of several (two channel panels), the one in front last. */
function wantedOwner(): string | null {
  const { browsers } = useBrowserTabsStore.getState();
  let wanted: string | null = null;
  for (const conversationId of attached.keys()) {
    const browser = browsers[conversationId];
    if (browser && (wanted === null || browser.frontAt > browsers[wanted]!.frontAt)) wanted = conversationId;
  }
  return wanted;
}

function reconcile(): void {
  if (!bridge) return;
  const wanted = wantedOwner();
  if (wanted !== owner) {
    if (owner !== null) bridge.closeAll();
    live.clear();
    shown = null;
    owner = wanted;
  }
  if (owner === null) return;
  const browser = useBrowserTabsStore.getState().browsers[owner]!;
  for (const tabId of live.keys()) {
    if (browser.tabs.some((tab) => tab.id === tabId)) continue;
    bridge.close(tabId);
    live.delete(tabId);
    if (shown === tabId) shown = null;
  }
  for (const tab of browser.tabs) {
    if (tab.url === null) continue;
    const sent = live.get(tab.id);
    // A view is made for the tab in front; one that exists follows each address asked of it.
    if (sent === undefined ? tab.id !== browser.activeId : tab.navigation <= sent) continue;
    bridge.open(owner, tab.id, tab.url);
    live.set(tab.id, tab.navigation);
  }
  const front = showing === owner && live.has(browser.activeId) ? browser.activeId : null;
  if (front !== shown) {
    bridge.activate(front);
    shown = front;
  }
}

function connect(next: DesktopWebPreviewTabsBridge): void {
  if (bridge === next) return;
  disconnect();
  bridge = next;
  unsubscribeState = next.onState((state) => {
    if (owner !== null && state && typeof state.tabId === "string") useBrowserTabsStore.getState().applyState(owner, state);
  });
  unsubscribeStore = useBrowserTabsStore.subscribe(reconcile);
}

function disconnect(): void {
  if (bridge && owner !== null) bridge.closeAll();
  unsubscribeState?.();
  unsubscribeStore?.();
  unsubscribeState = null;
  unsubscribeStore = null;
  bridge = null;
  owner = null;
  shown = null;
  live.clear();
}

/**
 * A channel panel that hosts the side window is mounted for `conversationId`:
 * its browser's views may exist. Returns the detach, which destroys them when
 * it was the last mount (the window left the conversation).
 */
export function attachBrowserViews(tabs: DesktopWebPreviewTabsBridge, conversationId: string): () => void {
  connect(tabs);
  attached.set(conversationId, (attached.get(conversationId) ?? 0) + 1);
  reconcile();
  return () => {
    const count = (attached.get(conversationId) ?? 1) - 1;
    if (count > 0) attached.set(conversationId, count);
    else attached.delete(conversationId);
    reconcile();
    if (attached.size === 0) disconnect();
  };
}

/** The browser's panel for `conversationId` is on screen (its placeholder mounted), or no longer. */
export function setBrowserShowing(conversationId: string, on: boolean): void {
  if (on) showing = conversationId;
  else if (showing === conversationId) showing = null;
  else return;
  reconcile();
}
