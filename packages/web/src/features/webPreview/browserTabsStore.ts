import type { DesktopWebPreviewBlocked, DesktopWebPreviewMediaKind, DesktopWebPreviewPermissionPrompt, DesktopWebPreviewSitePermissions, DesktopWebPreviewSiteSetting, DesktopWebPreviewTabIntent, DesktopWebPreviewTabList, DesktopWebPreviewTabListBridge, DesktopWebPreviewTabRequest, DesktopWebPreviewTabState } from "@botiverse/raft-shared";
import { create } from "zustand";

import { webPreviewUrl } from "./webPreviewAddress";

/**
 * The built-in browser's tabs (Raft Desktop, desktop_web_preview_view_v0, a
 * shell with `raftDesktop.webPreview.tabs`): one browser per conversation,
 * each a list of tabs and the one in front.
 *
 * Who keeps the list (#proj-workspace:#295):
 * - a shell with `webPreview.tabs.list` keeps it itself, across a reload of
 *   this page and a restart of the app. This store is then a mirror
 *   (mirrorBrowserTabsList): it holds what the shell last said, every change
 *   to the tabs is an intent sent to the shell, and the list it answers with
 *   is what shows. Which tab is in front and the tabs' order change here at
 *   once and are kept over the shell's list until the shell has answered the
 *   intent (`pending`), so a second key press starts from the first one's
 *   result and a dragged tab does not snap back; the shell's answer then
 *   stands. Of two lists the one with the larger `revision` is the newer: an
 *   older one that arrives late is dropped. A tab's address, title and
 *   loading state come only from the list; the shell's per-tab report
 *   (`applyState`) gives Back / Forward and the refusal notice. Only what is
 *   this page's own stays here: which of the browser and the Artifact is in
 *   front (`frontAt`, `parkedAt`), a dismissed notice, the address bar's
 *   focus;
 * - an older shell: this store is the list, in memory only, and the pages are
 *   the shell's native views (browserViews.ts keeps the two in step).
 *
 * A page opened beside the
 * conversation goes to the tab that already shows that address, else to a new
 * tab; at the cap it replaces the page of the tab in front (that tab's Back
 * returns to what it showed).
 *
 * Pinned tabs (#proj-workspace:#297, a shell with `list.pins`): the shell's
 * list carries the window's pinned tabs apart from each conversation's own.
 * Here every conversation's browser is its strip as it shows: the pinned tabs
 * first (`pinned` on the tab), then its own, and `activeId` the one in front.
 * A conversation with no tabs of its own has no entry in `browsers`: while the
 * pinned tabs' panel is open its browser is `pinnedOnly`, the same for every
 * such conversation (`browserOf` gives either). The cap counts the strip:
 * pinned and own tabs together.
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
  /** What the page last asked for and the shell refused (the notice under the address row), until its next navigation. */
  blocked: DesktopWebPreviewBlocked | null;
  /** The refusal the person dismissed (its `at`): not shown again. */
  blockedDismissedAt: number;
  /** A pinned tab: the window's, not this conversation's. It leads the strip and stays beside every conversation. */
  pinned?: boolean;
  /** The device prompt waiting for the person (the bar under the address row); absent or null: none. */
  permissionPrompt?: DesktopWebPreviewPermissionPrompt | null;
  /** The tab's site and its device settings (the address row's site settings); absent or null: the page may not ask. */
  site?: DesktopWebPreviewSitePermissions | null;
  /** The devices the page was given (the indicator on the tab and in the address row). */
  media?: DesktopWebPreviewMediaKind[];
  /** Sound comes out of the page (the speaker on the tab, #proj-workspace:#299); absent: a shell that does not say. */
  audible?: boolean;
  /** The person muted the tab (the speaker on it). */
  muted?: boolean;
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
  /** Each conversation's browser, for the ones with tabs of their own. */
  browsers: Record<string, Browser>;
  /** The browser beside a conversation with no tabs of its own: the pinned tabs, while their panel is open; else null. */
  pinnedOnly: Browser | null;
  /**
   * Per conversation: bumped when that browser's address bar should take focus (New tab, the address field's key).
   * Another conversation's bar, mounted at the same time, is not asked.
   */
  addressFocus: Record<string, number>;
  /**
   * Per conversation: the find field of its browser (find in page), while it is open. What it says is what should
   * be searched; browserViews.ts asks the shell for exactly that.
   */
  find: Record<string, BrowserFind>;
  /** Opens the find field for the tab (or, already open for it, gives it the keyboard again). */
  openFind: (conversationId: string, tabId: string) => void;
  /** What the find field holds: the page is searched for it from the first match; empty ends the search. */
  setFindText: (conversationId: string, text: string) => void;
  /** The match after (`forward`) or before the one marked. Nothing with no find field for the tab, or no text in it. */
  stepFind: (conversationId: string, tabId: string, forward: boolean) => void;
  /** The shell's count for the search the field holds. */
  applyFound: (conversationId: string, tabId: string, matches: number, active: number) => void;
  closeFind: (conversationId: string) => void;
  /** Shows `url` in the conversation's browser, in front: the tab already on it, else a new tab. */
  openUrl: (conversationId: string, url: string) => void;
  /**
   * A new tab on `url`, whatever tabs already show it (a link opened in a new tab or window): after the tab that
   * asked (`afterTabId`), else at the end; behind the tab in front when `background`. False at the cap: nothing opens.
   */
  openUrlInTab: (conversationId: string, url: string, options?: { background?: boolean; afterTabId?: string }) => boolean;
  /** Puts the tab's refusal notice away. */
  dismissBlocked: (conversationId: string, tabId: string) => void;
  /** A new empty tab, in front, the address bar focused. Nothing at the cap. */
  newTab: (conversationId: string) => void;
  activate: (conversationId: string, tabId: string) => void;
  /** Closes the tab; its right neighbour comes to the front, else its left; the last tab closes the browser. */
  closeTab: (conversationId: string, tabId: string) => void;
  /** Moves the tab to where `toTabId` stands (a drag in the strip), or one place left or right (the keyboard). */
  moveTab: (conversationId: string, tabId: string, to: string | "left" | "right") => void;
  /**
   * A browser command pressed with the keyboard focus in a tab's page (the shell decided the key: its one shortcut
   * table). Close closes the tab that had the focus; next, previous and the numbered ones go from the tab in front.
   */
  runCommand: (conversationId: string, request: BrowserTabCommand) => void;
  /** Loads `url` in the tab (the address bar). */
  navigate: (conversationId: string, tabId: string, url: string) => void;
  /** Makes the tab the window's: it leads every conversation's strip (a shell with `list.pins`). */
  pinTab: (conversationId: string, tabId: string) => void;
  /** Gives the pinned tab to this conversation, first of its own tabs. */
  unpinTab: (conversationId: string, tabId: string) => void;
  /** A new tab on the tab's address, in front. */
  duplicateTab: (conversationId: string, tabId: string) => void;
  /** Closes the conversation's own tabs but this one; a pinned tab stays. */
  closeOtherTabs: (conversationId: string, tabId: string) => void;
  /** Closes the conversation's own tabs after this one; a pinned tab stays. */
  closeTabsToRight: (conversationId: string, tabId: string) => void;
  /** Closes the browser and every tab of the conversation's own (the pinned ones stay the window's); focus goes back to what opened it (webPreviewStore). */
  close: (conversationId: string) => void;
  /** Brings the browser in front of the Artifact. */
  toFront: (conversationId: string) => void;
  /** Lets the Artifact in front; the browser and its tabs stay open behind it. */
  park: (conversationId: string) => void;
  /** The shell's report of a tab's page. */
  applyState: (conversationId: string, state: DesktopWebPreviewTabState) => void;
}

/**
 * A browser's find field: the tab whose page it searches, and for what. It is the tab's: it shows while that tab is
 * in front, and comes back with it. `focus` is a new number each time Find is asked (the field takes the keyboard
 * and selects its text, once per number: never again when it only comes back with its tab), `step` each time the next or previous match is asked (`forward` says which). `found` is the
 * shell's count for `text` (`active` is 1-based; 0: none marked), null before the first answer.
 */
export interface BrowserFind {
  tabId: string;
  text: string;
  focus: number;
  step: number;
  forward: boolean;
  found: { matches: number; active: number } | null;
}

/** The last `focus` handed out: one sequence for every find field, so a number is never asked twice. */
let findFocus = 0;

export type BrowserTabCommand = Extract<DesktopWebPreviewTabRequest, { type: "command" }>;

/** The shell's tab list, while this store mirrors it; null: the store is the list. */
let shellList: DesktopWebPreviewTabListBridge | null = null;
/** The account the shell's list was asked for. */
let shellAccount: string | null = null;
/** Bumped each time the mirror starts or ends: an answer to an earlier one is dropped. */
let connection = 0;
/** When a conversation's browser was last asked to the front, for the browser the shell's answer brings. */
const askedFront = new Map<string, number>();

/** Whether the shell keeps the tab list (this store mirrors it). */
export function browserTabsListInShell(): boolean {
  return shellList !== null;
}

/** What the store shows of the shell's list. */
interface Mirror {
  browsers: Record<string, Browser>;
  pinnedOnly: Browser | null;
}

/** The conversation's browser: its own, else (no tabs of its own) the pinned tabs while their panel is open. */
export function browserOf(state: Mirror, conversationId: string): Browser | undefined {
  return state.browsers[conversationId] ?? state.pinnedOnly ?? undefined;
}

/** The mirror with the conversation's browser changed (the same object where `change` gives the browser back). */
function changedBrowser(view: Mirror, conversationId: string, change: (browser: Browser) => Browser): Mirror {
  const own = view.browsers[conversationId];
  const browser = own ?? view.pinnedOnly;
  if (!browser) return view;
  const next = change(browser);
  if (next === browser) return view;
  return own ? { ...view, browsers: { ...view.browsers, [conversationId]: next } } : { ...view, pinnedOnly: next };
}

/** One listed tab as the store keeps it: `was` where nothing of it changed, with what only this page knows of it. */
function mirroredTab(listed: unknown, was: BrowserTab | undefined, pinned: boolean): BrowserTab | null {
  const listedTab = listed as { id?: unknown; url?: unknown; title?: unknown; loading?: unknown } | null;
  if (!listedTab || typeof listedTab.id !== "string") return null;
  const url = typeof listedTab.url === "string" ? webPreviewUrl(listedTab.url)?.href ?? null : null;
  const title = typeof listedTab.title === "string" ? listedTab.title : "";
  const loading = listedTab.loading === true;
  return was && was.url === url && was.title === title && was.loading === loading && (was.pinned === true) === pinned
    ? was
    : { ...(was ?? { id: listedTab.id, navigation: 0, canGoBack: false, canGoForward: false, blocked: null, blockedDismissedAt: 0 }), url, askedUrl: url, title, loading, pinned };
}

function sameTabs(a: readonly BrowserTab[], b: readonly BrowserTab[]): boolean {
  return a.length === b.length && a.every((tab, index) => tab === b[index]);
}

/**
 * The shell's list as this store keeps it: a tab keeps what only this page knows of it (also when it is pinned or
 * unpinned); nothing changed keeps its object. Each conversation's browser is its strip: the pinned tabs, then its
 * own.
 */
function mirrored(list: unknown, previous: Mirror): Mirror {
  const browsers: Record<string, Browser> = {};
  const record = list && typeof list === "object" ? (list as DesktopWebPreviewTabList) : null;
  const listed = record && Array.isArray(record.browsers) ? record.browsers : [];
  // Every tab the store held, by id: a pinned tab is one object in every strip.
  const known = new Map<string, BrowserTab>();
  for (const browser of [previous.pinnedOnly, ...Object.values(previous.browsers)]) {
    for (const tab of browser?.tabs ?? []) if (!known.has(tab.id) || tab.pinned) known.set(tab.id, tab);
  }
  const listedPinned = record?.pinned && Array.isArray(record.pinned.tabs) ? record.pinned : null;
  const pinnedTabs: BrowserTab[] = [];
  for (const each of listedPinned?.tabs ?? []) {
    const tab = mirroredTab(each, known.get((each as { id?: string } | null)?.id ?? ""), true);
    if (tab) pinnedTabs.push(tab);
  }
  const pinnedActiveId = pinnedTabs.find((tab) => tab.id === listedPinned?.activeId)?.id ?? pinnedTabs[0]?.id ?? null;
  let same = true;
  for (const each of listed) {
    if (!each || typeof each.owner !== "string" || typeof each.activeId !== "string" || !Array.isArray(each.tabs) || each.tabs.length === 0) continue;
    const before = previous.browsers[each.owner];
    const own: BrowserTab[] = [];
    for (const listedTab of each.tabs) {
      const id = (listedTab as { id?: string } | null)?.id ?? "";
      const tab = mirroredTab(listedTab, before?.tabs.find((was) => was.id === id) ?? known.get(id), false);
      if (tab) own.push(tab);
    }
    if (own.length === 0) continue;
    const tabs = [...pinnedTabs, ...own];
    const activeId = each.pinnedFront === true && pinnedActiveId !== null ? pinnedActiveId : own.some((tab) => tab.id === each.activeId) ? each.activeId : own[0]!.id;
    // A conversation that had only the pinned tabs keeps their panel's times: it does not go behind the Artifact.
    const times = before ?? previous.pinnedOnly;
    const browser = before && sameTabs(before.tabs, tabs) && before.activeId === activeId
      ? before
      : { tabs, activeId, frontAt: before?.frontAt ?? askedFront.get(each.owner) ?? times?.frontAt ?? 0, parkedAt: times?.parkedAt ?? 0 };
    if (browser !== before) same = false;
    askedFront.delete(each.owner);
    browsers[each.owner] = browser;
  }
  let pinnedOnly: Browser | null = null;
  if (listedPinned?.open === true && pinnedActiveId !== null) {
    const before = previous.pinnedOnly;
    pinnedOnly = before && sameTabs(before.tabs, pinnedTabs) && before.activeId === pinnedActiveId
      ? before
      : { tabs: pinnedTabs, activeId: pinnedActiveId, frontAt: before?.frontAt ?? Date.now(), parkedAt: before?.parkedAt ?? 0 };
  }
  if (same && pinnedOnly === previous.pinnedOnly && Object.keys(previous.browsers).length === Object.keys(browsers).length) return previous;
  return { browsers: same && Object.keys(previous.browsers).length === Object.keys(browsers).length ? previous.browsers : browsers, pinnedOnly };
}

/** A change shown before the shell has answered its intent: what the browser looks like with it (the same object where it changes nothing). */
type Optimistic = (view: Mirror) => Mirror;

/** The shell's list as last received (the newest by `revision`, whatever it is: a malformed one is no tabs); null: none yet. */
let shellAnswer: { list: unknown } | null = null;
/** The `revision` of `shellAnswer`; -1: none, or the shell sends none. */
let shellRevision = -1;
/** The changes shown ahead of the shell's answer, oldest first. Each goes when its intent is answered or refused. */
let pending: Optimistic[] = [];

/** What shows: the shell's list, with the changes it has not answered yet on top. */
function showShellList(): void {
  const state = useBrowserTabsStore.getState();
  const previous: Mirror = { browsers: state.browsers, pinnedOnly: state.pinnedOnly };
  let view = shellAnswer === null ? previous : mirrored(shellAnswer.list, previous);
  for (const change of pending) view = change(view);
  if (view.browsers !== previous.browsers || view.pinnedOnly !== previous.pinnedOnly) useBrowserTabsStore.setState({ browsers: view.browsers, pinnedOnly: view.pinnedOnly });
}

function applyShellList(list: unknown, from: number): void {
  if (from !== connection) return;
  const revision = list && typeof list === "object" && typeof (list as DesktopWebPreviewTabList).revision === "number" ? (list as DesktopWebPreviewTabList).revision! : null;
  // An answer that arrives after a newer change: the newer list stands.
  if (revision === null || revision >= shellRevision) {
    shellAnswer = { list };
    if (revision !== null) shellRevision = revision;
  }
  showShellList();
}

/**
 * Asks the shell for a change to the list; what it answers is what shows. `optimistic` shows the change at once and
 * until the answer (or the refusal) comes. `then` runs once the answer is in the store. A refusal means the shell
 * no longer holds this page as the list's owner (it dropped the list: a sign-out, its storage emptied): the list is
 * asked for again, once, and the intent sent once more after it (`again`); refused a second time, it is left.
 */
function ask(intent: DesktopWebPreviewTabIntent, then?: () => void, optimistic?: Optimistic, again = false): void {
  const from = connection;
  if (!shellList) return;
  if (optimistic) {
    pending.push(optimistic);
    showShellList();
  }
  const settled = (): boolean => {
    if (from !== connection) return false;
    if (optimistic) pending = pending.filter((each) => each !== optimistic);
    return true;
  };
  void shellList.dispatch(intent).then((list) => {
    if (!settled()) return;
    applyShellList(list, from);
    then?.();
  }, () => {
    // Refused (the shell does not hold this page as the list's owner): what it last said shows again.
    if (!settled()) return;
    showShellList();
    const list = shellList;
    if (again || !list || !shellAccount) return;
    void list.get(shellAccount).then((answer) => {
      if (from !== connection) return;
      applyShellList(answer, from);
      ask(intent, then, undefined, true);
    }, () => {});
  });
}

/** The tab in front, as asked: nothing where the browser or the tab is gone, or it is in front already. */
function activated(conversationId: string, tabId: string): Optimistic {
  return (view) => changedBrowser(view, conversationId, (browser) => (browser.activeId === tabId || !browser.tabs.some((tab) => tab.id === tabId) ? browser : { ...browser, activeId: tabId }));
}

/** The tabs in the order asked for (`order`: their ids): the tabs it names take that order among themselves; any other stays where it stands. */
function ordered(conversationId: string, order: readonly string[]): Optimistic {
  return (view) => changedBrowser(view, conversationId, (browser) => {
    const named = order.map((id) => browser.tabs.find((tab) => tab.id === id)).filter((tab): tab is BrowserTab => tab !== undefined);
    let next = 0;
    const tabs = browser.tabs.map((tab) => (order.includes(tab.id) ? named[next++]! : tab));
    return sameTabs(tabs, browser.tabs) ? browser : { ...browser, tabs };
  });
}

let unsubscribeShellList: (() => void) | null = null;

/**
 * The shell keeps the tab list (`webPreview.tabs.list`): this store mirrors
 * it for the signed-in `account`, for the rest of the page's life. Asks for
 * the list as it is now (after a reload of this page, or a restart: the tabs
 * that were open) and follows every change. A repeat for the same account
 * does nothing; another account drops what the store held and asks again;
 * null (signed out, or no such shell) ends the mirror and empties the store.
 */
export function mirrorBrowserTabsList(list: DesktopWebPreviewTabListBridge | null, account: string | null): void {
  const next = list && account ? list : null;
  if (next === shellList && (next === null || account === shellAccount)) return;
  const had = shellList !== null;
  unsubscribeShellList?.();
  unsubscribeShellList = null;
  connection += 1;
  shellAnswer = null;
  shellRevision = -1;
  pending = [];
  askedFront.clear();
  shellList = next;
  shellAccount = next ? account : null;
  // One account's tabs never show for the next: the store starts from what the shell answers.
  const held = useBrowserTabsStore.getState();
  if (had && (Object.keys(held.browsers).length > 0 || held.pinnedOnly !== null || Object.keys(held.find).length > 0)) useBrowserTabsStore.setState({ browsers: {}, pinnedOnly: null, find: {} });
  if (!next || !account) return;
  const from = connection;
  unsubscribeShellList = next.onChange((answer) => applyShellList(answer, from));
  void next.get(account).then((answer) => applyShellList(answer, from), () => {});
}

let sequence = 0;

function newTabId(): string {
  sequence += 1;
  return `t${Date.now().toString(36)}${sequence.toString(36)}`;
}

function tabFor(url: string | null): BrowserTab {
  return { id: newTabId(), url, askedUrl: url, navigation: url ? 1 : 0, title: "", canGoBack: false, canGoForward: false, loading: url !== null, blocked: null, blockedDismissedAt: 0 };
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

/** Whether the shell has pinned tabs and the tab menu's intents (`list.pins`): without it none of them is offered. */
export function browserTabsPinsInShell(): boolean {
  return shellList?.pins === true;
}

/**
 * Whether one more of the conversation's tabs can be pinned: the cap counts the strip, pinned and own tabs together,
 * beside every conversation, with room left for one tab of a conversation's own (the shell's rule, which refuses
 * the pin otherwise; here it disables the menu's item).
 */
export function canPinBrowserTab(state: Mirror, conversationId: string): boolean {
  const pinned = browserOf(state, conversationId)?.tabs.filter((tab) => tab.pinned).length ?? 0;
  let others = 1;
  for (const [owner, browser] of Object.entries(state.browsers)) {
    if (owner !== conversationId) others = Math.max(others, browser.tabs.length - pinned);
  }
  return pinned + 1 + others <= BROWSER_MAX_TABS;
}

/**
 * The tabs with `tabId` moved to where `to` stands (another tab's id), or one place `left` or `right`; the same array
 * where nothing moves (an unknown id, itself, past either end, or past the line between the pinned tabs and the
 * others: a pinned tab moves among the pinned ones only, any other among its own). The others keep their order.
 */
export function moveBrowserTab<T extends { id: string; pinned?: boolean }>(tabs: readonly T[], tabId: string, to: string): readonly T[] {
  const from = tabs.findIndex((tab) => tab.id === tabId);
  const target = to === "left" ? from - 1 : to === "right" ? from + 1 : tabs.findIndex((tab) => tab.id === to);
  if (from < 0 || target < 0 || target >= tabs.length || target === from) return tabs;
  if ((tabs[from]!.pinned === true) !== (tabs[target]!.pinned === true)) return tabs;
  const next = [...tabs];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved!);
  return next;
}

const BLOCKED_REASONS: readonly string[] = ["raft", "raft-sign-in", "scheme", "popup", "storage", "download", "media-system"];
const MEDIA_KINDS: readonly DesktopWebPreviewMediaKind[] = ["microphone", "camera"];

/** A list of devices from the shell: the known ones, once each, in a fixed order. */
export function browserMediaKinds(value: unknown): DesktopWebPreviewMediaKind[] {
  return Array.isArray(value) ? MEDIA_KINDS.filter((kind) => value.includes(kind)) : [];
}

function siteSetting(value: unknown): DesktopWebPreviewSiteSetting {
  return value === "allow" || value === "block" ? value : "ask";
}

/** The shell's device prompt for a tab, checked; null where there is none (or it is not one). */
export function browserPermissionPrompt(value: unknown): DesktopWebPreviewPermissionPrompt | null {
  if (!value || typeof value !== "object") return null;
  const { id, origin, kinds } = value as Record<string, unknown>;
  const asked = browserMediaKinds(kinds);
  return typeof id === "string" && typeof origin === "string" && asked.length > 0 ? { id, origin, kinds: asked } : null;
}

/** The shell's site settings for a tab, checked; null where there are none. */
export function browserSitePermissions(value: unknown): DesktopWebPreviewSitePermissions | null {
  if (!value || typeof value !== "object") return null;
  const { origin, microphone, camera } = value as Record<string, unknown>;
  return typeof origin === "string" ? { origin, microphone: siteSetting(microphone), camera: siteSetting(camera) } : null;
}

/** The shell's refusal as the tab keeps it, or null: only a well-formed one (the shell is trusted, its input is still read). */
export function browserTabBlocked(value: unknown): DesktopWebPreviewBlocked | null {
  if (!value || typeof value !== "object") return null;
  const { url, reason, at, file } = value as Record<string, unknown>;
  if (typeof url !== "string" || typeof reason !== "string" || !BLOCKED_REASONS.includes(reason) || typeof at !== "number") return null;
  // A download's file name: shown as text, cut to the shell's 200 characters again.
  const name = reason === "download" && typeof file === "string" && file.trim() ? file.trim().slice(0, 200) : null;
  const media = reason === "media-system" ? browserMediaKinds((value as Record<string, unknown>).media) : [];
  return { url, reason: reason as DesktopWebPreviewBlocked["reason"], at, ...(name ? { file: name } : {}), ...(media.length > 0 ? { media } : {}) };
}

function withTab(browser: Browser, tabId: string, change: (tab: BrowserTab) => BrowserTab): Browser {
  return { ...browser, tabs: browser.tabs.map((tab) => (tab.id === tabId ? change(tab) : tab)) };
}

function loading(tab: BrowserTab, url: string): BrowserTab {
  return { ...tab, url, askedUrl: url, navigation: tab.navigation + 1, title: "", loading: true };
}

export const useBrowserTabsStore = create<BrowserTabsState>((set, get) => {
  // The conversation's browser: its own, else the pinned tabs' (browserOf); `put` writes back the one it read.
  const browserAt = (conversationId: string) => browserOf(get(), conversationId);
  const put = (conversationId: string, browser: Browser) => {
    const state = get();
    if (!state.browsers[conversationId] && state.pinnedOnly) set({ pinnedOnly: browser });
    else set({ browsers: { ...state.browsers, [conversationId]: browser } });
  };
  /** One of the tab menu's intents, on a shell that knows them. */
  const askOfTab = (type: "pin" | "unpin" | "duplicate" | "close-others" | "close-right", conversationId: string, tabId: string) => {
    if (!browserTabsPinsInShell() || !browserAt(conversationId)?.tabs.some((tab) => tab.id === tabId)) return;
    ask({ type, owner: conversationId, tabId });
  };
  const focusAddress = (conversationId: string) => ({ ...get().addressFocus, [conversationId]: (get().addressFocus[conversationId] ?? 0) + 1 });
  return {
    browsers: {},
    pinnedOnly: null,
    addressFocus: {},
    find: {},
    openFind: (conversationId, tabId) => {
      const open = get().find[conversationId];
      findFocus += 1;
      const next: BrowserFind = open?.tabId === tabId ? { ...open, focus: findFocus } : { tabId, text: "", focus: findFocus, step: 0, forward: true, found: null };
      set({ find: { ...get().find, [conversationId]: next } });
    },
    setFindText: (conversationId, text) => {
      const open = get().find[conversationId];
      if (!open || open.text === text) return;
      // The count of the text before stays until the shell answers for this one; no text, no count.
      set({ find: { ...get().find, [conversationId]: { ...open, text, found: text === "" ? null : open.found } } });
    },
    stepFind: (conversationId, tabId, forward) => {
      const open = get().find[conversationId];
      if (open?.tabId !== tabId || open.text === "") return;
      set({ find: { ...get().find, [conversationId]: { ...open, step: open.step + 1, forward } } });
    },
    applyFound: (conversationId, tabId, matches, active) => {
      const open = get().find[conversationId];
      if (!open || open.tabId !== tabId || open.text === "") return;
      if (open.found?.matches === matches && open.found.active === active) return;
      set({ find: { ...get().find, [conversationId]: { ...open, found: { matches, active } } } });
    },
    closeFind: (conversationId) => {
      if (!get().find[conversationId]) return;
      const { [conversationId]: _closed, ...find } = get().find;
      set({ find });
    },
    openUrl: (conversationId, href) => {
      const url = webPreviewUrl(href)?.href;
      if (!url) return;
      const browser = browserAt(conversationId);
      const frontAt = Date.now();
      if (shellList) {
        if (browser) put(conversationId, { ...browser, frontAt });
        else askedFront.set(conversationId, frontAt);
        ask({ type: "open", owner: conversationId, url });
        return;
      }
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
    openUrlInTab: (conversationId, href, options = {}) => {
      const url = webPreviewUrl(href)?.href;
      const browser = browserAt(conversationId);
      if (!url || !browser || browser.tabs.length >= BROWSER_MAX_TABS) return false;
      if (shellList) {
        if (!options.background) put(conversationId, { ...browser, frontAt: Date.now() });
        ask({ type: "open-tab", owner: conversationId, url, background: options.background === true, afterTabId: options.afterTabId });
        return true;
      }
      const tab = tabFor(url);
      const opener = options.afterTabId ? browser.tabs.findIndex((candidate) => candidate.id === options.afterTabId) : -1;
      const at = opener < 0 ? browser.tabs.length : opener + 1;
      const tabs = [...browser.tabs.slice(0, at), tab, ...browser.tabs.slice(at)];
      // A tab behind has no view until it comes to the front (browserViews): it loads then.
      put(conversationId, options.background ? { ...browser, tabs } : { ...browser, tabs, activeId: tab.id, frontAt: Date.now() });
      return true;
    },
    dismissBlocked: (conversationId, tabId) => {
      const browser = browserAt(conversationId);
      const tab = browser?.tabs.find((candidate) => candidate.id === tabId);
      if (!browser || !tab?.blocked) return;
      put(conversationId, withTab(browser, tabId, (current) => ({ ...current, blockedDismissedAt: current.blocked?.at ?? 0 })));
    },
    newTab: (conversationId) => {
      const browser = browserAt(conversationId);
      if (!browser || browser.tabs.length >= BROWSER_MAX_TABS) return;
      if (shellList) {
        // The address bar takes the focus once the new tab is the one in front.
        ask({ type: "new-tab", owner: conversationId }, () => set({ addressFocus: focusAddress(conversationId) }));
        return;
      }
      const tab = tabFor(null);
      set({ browsers: { ...get().browsers, [conversationId]: { ...browser, tabs: [...browser.tabs, tab], activeId: tab.id } }, addressFocus: focusAddress(conversationId) });
    },
    activate: (conversationId, tabId) => {
      const browser = browserAt(conversationId);
      if (!browser || browser.activeId === tabId || !browser.tabs.some((tab) => tab.id === tabId)) return;
      if (shellList) {
        // In front at once: the next key press goes on from here, not from what the shell last said.
        ask({ type: "activate", owner: conversationId, tabId }, undefined, activated(conversationId, tabId));
        return;
      }
      put(conversationId, { ...browser, activeId: tabId });
    },
    closeTab: (conversationId, tabId) => {
      const browser = browserAt(conversationId);
      const index = browser ? browser.tabs.findIndex((tab) => tab.id === tabId) : -1;
      if (!browser || index < 0) return;
      if (shellList) {
        ask({ type: "close-tab", owner: conversationId, tabId });
        return;
      }
      if (browser.tabs.length === 1) {
        get().close(conversationId);
        return;
      }
      const tabs = browser.tabs.filter((tab) => tab.id !== tabId);
      // The right neighbour takes its place, else the left one.
      const activeId = browser.activeId === tabId ? (tabs[index] ?? tabs[index - 1]!).id : browser.activeId;
      put(conversationId, { ...browser, tabs, activeId });
    },
    moveTab: (conversationId, tabId, to) => {
      const browser = browserAt(conversationId);
      if (!browser) return;
      if (shellList) {
        const moved = moveBrowserTab(browser.tabs, tabId, to);
        // Where it was dropped at once (no snap back while the shell answers), as an order: showing it twice moves nothing twice.
        if (moved !== browser.tabs) ask({ type: "move", owner: conversationId, tabId, to }, undefined, ordered(conversationId, moved.map((tab) => tab.id)));
        return;
      }
      const tabs = moveBrowserTab(browser.tabs, tabId, to);
      if (tabs !== browser.tabs) put(conversationId, { ...browser, tabs: [...tabs] });
    },
    runCommand: (conversationId, request) => {
      const browser = browserAt(conversationId);
      if (!browser) return;
      const { tabs } = browser;
      const front = tabs.findIndex((tab) => tab.id === browser.activeId);
      switch (request.command) {
        case "close-tab": get().closeTab(conversationId, request.tabId); break;
        case "new-tab": get().newTab(conversationId); break;
        case "focus-address": set({ addressFocus: focusAddress(conversationId) }); break;
        // Find in page, for the tab whose page had the keyboard (the one in front).
        case "find": get().openFind(conversationId, request.tabId); break;
        case "find-next": get().stepFind(conversationId, request.tabId, true); break;
        case "find-previous": get().stepFind(conversationId, request.tabId, false); break;
        // Round the ends, as a browser's.
        case "next-tab":
        case "previous-tab": {
          const tab = tabs[(front + (request.command === "next-tab" ? 1 : tabs.length - 1)) % tabs.length];
          if (tab) get().activate(conversationId, tab.id);
          break;
        }
        case "select-tab": {
          // -1: the last tab. A number past the last tab does nothing.
          const tab = request.index === -1 ? tabs.at(-1) : typeof request.index === "number" ? tabs[request.index] : undefined;
          if (tab) get().activate(conversationId, tab.id);
          break;
        }
        default: break;
      }
    },
    navigate: (conversationId, tabId, href) => {
      const url = webPreviewUrl(href)?.href;
      const browser = browserAt(conversationId);
      if (!url || !browser) return;
      if (shellList) {
        ask({ type: "navigate", owner: conversationId, tabId, url });
        return;
      }
      put(conversationId, withTab(browser, tabId, (tab) => loading(tab, url)));
    },
    pinTab: (conversationId, tabId) => askOfTab("pin", conversationId, tabId),
    unpinTab: (conversationId, tabId) => askOfTab("unpin", conversationId, tabId),
    duplicateTab: (conversationId, tabId) => {
      // In front: the browser comes in front of the Artifact, as for any tab opened in front.
      const browser = browserAt(conversationId);
      if (browser && browserTabsPinsInShell()) put(conversationId, { ...browser, frontAt: Date.now() });
      askOfTab("duplicate", conversationId, tabId);
    },
    closeOtherTabs: (conversationId, tabId) => askOfTab("close-others", conversationId, tabId),
    closeTabsToRight: (conversationId, tabId) => askOfTab("close-right", conversationId, tabId),
    close: (conversationId) => {
      if (!browserAt(conversationId)) return;
      // The find field goes with the browser.
      get().closeFind(conversationId);
      if (shellList) {
        ask({ type: "close", owner: conversationId });
        return;
      }
      const { [conversationId]: _closed, ...browsers } = get().browsers;
      set({ browsers });
    },
    toFront: (conversationId) => {
      const browser = browserAt(conversationId);
      if (browser) put(conversationId, { ...browser, frontAt: Date.now() });
    },
    park: (conversationId) => {
      const browser = browserAt(conversationId);
      if (browser) put(conversationId, { ...browser, parkedAt: Date.now() });
    },
    applyState: (conversationId, state) => {
      const browser = browserAt(conversationId);
      const tab = browser?.tabs.find((candidate) => candidate.id === state.tabId);
      if (!browser || !tab) return;
      const blocked = browserTabBlocked(state.blocked);
      // A pinned tab is in every strip: its report is every strip's.
      const putTab = (next: BrowserTab) => {
        if (!tab.pinned) {
          put(conversationId, withTab(browser, tab.id, () => next));
          return;
        }
        const everywhere = (each: Browser) => (each.tabs.some((one) => one.id === tab.id) ? withTab(each, tab.id, () => next) : each);
        const held = get();
        set({ browsers: Object.fromEntries(Object.entries(held.browsers).map(([id, each]) => [id, everywhere(each)])), pinnedOnly: held.pinnedOnly ? everywhere(held.pinnedOnly) : null });
      };
      // The shell keeps the list: the tab's address, title and loading state are the list's alone (one writer), and
      // this report gives what the list does not carry.
      const mirror = shellList !== null;
      // Only an http(s) address is the tab's (never about:blank before the first load, or an error page's).
      const url = mirror ? tab.url : webPreviewUrl(state.url)?.href ?? tab.url;
      const title = mirror ? tab.title : typeof state.title === "string" ? state.title : tab.title;
      // A shell before site permissions says nothing of them: nothing shows.
      const permissionPrompt = browserPermissionPrompt(state.permissionPrompt);
      const site = browserSitePermissions(state.site);
      const media = browserMediaKinds(state.media);
      // A shell before the speaker on a tab says nothing of what plays: none shows.
      const audible = state.audible === true;
      const muted = state.muted === true;
      const next: BrowserTab = { ...tab, url, title, canGoBack: state.canGoBack === true, canGoForward: state.canGoForward === true, loading: mirror ? tab.loading : state.loading === true, blocked, permissionPrompt, site, media, audible, muted };
      const samePermissions = (tab.permissionPrompt?.id ?? null) === (permissionPrompt?.id ?? null)
        && JSON.stringify(tab.site ?? null) === JSON.stringify(site)
        && (tab.media ?? []).join() === media.join()
        && (tab.audible === true) === audible && (tab.muted === true) === muted;
      if (samePermissions && next.url === tab.url && next.title === tab.title && next.canGoBack === tab.canGoBack && next.canGoForward === tab.canGoForward && next.loading === tab.loading && next.blocked?.at === tab.blocked?.at && next.blocked?.url === tab.blocked?.url) return;
      putTab(next);
    },
  };
});
