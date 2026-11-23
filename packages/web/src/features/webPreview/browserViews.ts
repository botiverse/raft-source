import type { DesktopWebPreviewTabsBridge } from "@botiverse/raft-shared";

import { browserOf, browserTabsListInShell, useBrowserTabsStore } from "./browserTabsStore";

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
 *
 * A pinned tab (#proj-workspace:#297) is the window's: the shell keeps its
 * view when the window leaves a conversation, and this module presents a
 * conversation with no tabs of its own while the pinned tabs' panel is open.
 *
 * Find in page (#proj-workspace:#292) follows the same rule: the list's find
 * field (`find`) says what should be searched, and this module asks the
 * shell for exactly that: a search while the field's tab is in front and its
 * panel on screen, from the first match when the text changes, the next or
 * previous match when asked, again when its page finishes loading, and none
 * otherwise. A shell that predates it is asked nothing.
 *
 * On a shell that keeps the tab list itself (`tabs.list`,
 * #proj-workspace:#295) the views are the shell's to make and destroy, by the
 * same rules. This module then only says which conversation's browser the
 * window is on and whether its panel is on screen (`list.present`); after a
 * reload of this page that is what takes the views, still alive, back.
 * Where the shell can mute a tab (`setMuted`) it is told this web shows the
 * speaker on a tab (`backgroundMedia`, #proj-workspace:#299): a tab behind
 * plays on and is heard, a page that plays outlives the conversation left
 * (while it plays), and switching away from a playing video puts it in
 * picture-in-picture, as Chrome does (apps/desktop webPreviewPlayback.ts).
 * Where the shell says what the kept pages of a conversation left do
 * (`list.onInUse`) it is told this web marks it on the conversation's sidebar
 * row (`inUseMarks`): a page using the microphone or the camera then
 * outlives the conversation left too (under the same rules), while that
 * conversation has a row in the sidebar on screen (`setMarkable`, from
 * browserTabsStore), where it would otherwise be closed, unseen and unmarked.
 */

let bridge: DesktopWebPreviewTabsBridge | null = null;
let unsubscribeState: (() => void) | null = null;
let unsubscribeRequest: (() => void) | null = null;
let unsubscribeStore: (() => void) | null = null;
let unsubscribeFound: (() => void) | null = null;
/** The search the shell was last asked for: whose, its tab, its text, the list's `step` it was at, and whether its page was loading then. */
let searching: { owner: string; tabId: string; text: string; step: number; loading: boolean } | null = null;
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
/** What a shell that keeps the list was last told (`present`): the owner and whether its panel is on screen. */
let presented: string | null = null;

/** What this web shows of the pages the shell keeps (`present`'s options): a speaker on a tab, the row's mark. */
function presentOptions(tabs: DesktopWebPreviewTabsBridge): { backgroundMedia: boolean; inUseMarks: boolean } {
  return { backgroundMedia: tabs.setMuted !== undefined, inUseMarks: tabs.list?.onInUse !== undefined && tabs.list.setMarkable !== undefined };
}

/** The attached conversation with a browser; of several (two channel panels), the one in front last. */
function wantedOwner(): string | null {
  // A conversation with no tabs of its own has the pinned tabs' browser, while their panel is open (browserOf).
  const state = useBrowserTabsStore.getState();
  let wanted: string | null = null;
  for (const conversationId of attached.keys()) {
    const browser = browserOf(state, conversationId);
    if (browser && (wanted === null || browser.frontAt > browserOf(state, wanted)!.frontAt)) wanted = conversationId;
  }
  return wanted;
}

/** The shell's search is what the find field of the browser on screen says (the tab in front's, with a text). */
function reconcileFind(): void {
  if (!bridge?.find || !bridge.stopFind) return;
  const state = useBrowserTabsStore.getState();
  const browser = owner !== null ? browserOf(state, owner) : null;
  const open = owner !== null ? state.find[owner] : undefined;
  // The field is its tab's: it goes with the tab (this runs again for the change; nothing below is left to do then).
  if (owner !== null && open && browser && !browser.tabs.some((each) => each.id === open.tabId)) {
    state.closeFind(owner);
    return;
  }
  const find = showing === owner ? open : undefined;
  const tab = find && browser?.activeId === find.tabId ? browser.tabs.find((each) => each.id === find.tabId) : undefined;
  const wanted = owner !== null && find && tab && tab.url !== null && find.text !== "" ? find : null;
  if (searching && (!wanted || wanted.tabId !== searching.tabId || owner !== searching.owner)) {
    bridge.stopFind(searching.tabId, false);
    searching = null;
  }
  if (!wanted || !tab || owner === null) return;
  // From the first match for a text that changed, and again once the searched page finished loading (a navigation,
  // a reload: the marks went with the page before); else the next or previous match when one was asked.
  if (!searching || searching.text !== wanted.text || (searching.loading && !tab.loading)) bridge.find(wanted.tabId, wanted.text, { forward: true, fresh: true });
  else if (searching.step !== wanted.step) bridge.find(wanted.tabId, wanted.text, { forward: wanted.forward, fresh: false });
  searching = { owner, tabId: wanted.tabId, text: wanted.text, step: wanted.step, loading: tab.loading };
}

function reconcile(): void {
  reconcileViews();
  reconcileFind();
}

function reconcileViews(): void {
  if (!bridge) return;
  // The mirror ended (a sign-out) with a browser still presented: the shell is told the window is on none, on the
  // list's own channel (it does not hear `closeAll` from a page whose list it keeps), so no page of the account
  // that left stays painted or audible.
  const mirroring = browserTabsListInShell();
  const wanted = mirroring || presented === null ? wantedOwner() : null;
  if (bridge.list && (mirroring || presented !== null)) {
    owner = wanted;
    const next = `${showing === wanted}:${wanted ?? ""}`;
    if (wanted === null ? presented === null : next === presented) return;
    presented = wanted === null ? null : next;
    // This web shows the speaker on a tab where the shell can mute one: a tab behind plays on, heard (#299); and the
    // row's mark where the shell says what kept pages do.
    bridge.list.present(wanted, wanted !== null && showing === wanted, presentOptions(bridge));
    return;
  }
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
  unsubscribeFound = next.onFound?.((found) => {
    if (owner === null || !found || typeof found.tabId !== "string" || typeof found.matches !== "number" || typeof found.active !== "number") return;
    // An answer for a search already ended or replaced by another tab's is nobody's.
    if (searching?.tabId === found.tabId) useBrowserTabsStore.getState().applyFound(owner, found.tabId, found.matches, found.active);
  }) ?? null;
  // What a tab's page asks the browser for (the link router's outcome, from the shell): a new tab, after the one
  // that asked. At the cap a tab in front takes the tab that asked instead (as a page opened beside does).
  unsubscribeRequest = next.onRequest?.((request) => {
    if (owner === null || !request) return;
    const store = useBrowserTabsStore.getState();
    // A browser key pressed in a tab's page: the shell decided which command it is, the tab list carries it out.
    if (request.type === "command" && typeof request.tabId === "string") {
      store.runCommand(owner, request);
      return;
    }
    if (request.type !== "open-tab" || typeof request.url !== "string") return;
    const opener = typeof request.openerTabId === "string" ? request.openerTabId : undefined;
    if (store.openUrlInTab(owner, request.url, { background: request.background === true, afterTabId: opener })) return;
    if (request.background !== true && opener) store.navigate(owner, opener, request.url);
  }) ?? null;
  unsubscribeStore = useBrowserTabsStore.subscribe(reconcile);
}

function disconnect(): void {
  if (bridge?.list && (browserTabsListInShell() || presented !== null)) {
    if (presented !== null) bridge.list.present(null, false, presentOptions(bridge));
  } else if (bridge && owner !== null) bridge.closeAll();
  presented = null;
  unsubscribeState?.();
  unsubscribeRequest?.();
  unsubscribeStore?.();
  unsubscribeFound?.();
  unsubscribeFound = null;
  // No marks left in a page whose find field is gone.
  if (searching) bridge?.stopFind?.(searching.tabId, false);
  searching = null;
  unsubscribeState = null;
  unsubscribeRequest = null;
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

/** Whether the shell has find in page (its three calls come together); one that predates it gets no find field. */
export function hasBrowserFind(tabs: DesktopWebPreviewTabsBridge): boolean {
  return typeof tabs.find === "function" && typeof tabs.stopFind === "function" && typeof tabs.onFound === "function";
}

/**
 * Closes the conversation's find field (its Close, or Escape in it): the search ends, its marks go, and the page it
 * searched takes the keyboard back.
 */
export function closeBrowserFind(conversationId: string): void {
  const find = useBrowserTabsStore.getState().find[conversationId];
  if (!find) return;
  if (conversationId === owner) {
    bridge?.stopFind?.(find.tabId, true);
    if (searching?.tabId === find.tabId) searching = null;
  }
  useBrowserTabsStore.getState().closeFind(conversationId);
}

/** The browser's panel for `conversationId` is on screen (its placeholder mounted), or no longer. */
export function setBrowserShowing(conversationId: string, on: boolean): void {
  if (on) showing = conversationId;
  else if (showing === conversationId) showing = null;
  else return;
  reconcile();
}
