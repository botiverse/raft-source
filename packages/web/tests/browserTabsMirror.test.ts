import { beforeEach, describe, expect, it } from "vitest";
import type { DesktopWebPreviewTabIntent, DesktopWebPreviewTabList, DesktopWebPreviewTabsBridge } from "@botiverse/raft-shared";

import { browserTabsListInShell, mirrorBrowserTabsList, useBrowserTabsStore } from "../src/features/webPreview/browserTabsStore";
import { attachBrowserViews, setBrowserShowing } from "../src/features/webPreview/browserViews";

// The tab list is the shell's (#proj-workspace:#295): on a shell with `webPreview.tabs.list` the store mirrors it and
// every change is an intent; on an older shell the store is the list, as before.
const conversation = "c1";
const store = () => useBrowserTabsStore.getState();
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const listed = (...urls: (string | null)[]): DesktopWebPreviewTabList => ({
  browsers: urls.length === 0 ? [] : [{ owner: conversation, activeId: "m1", tabs: urls.map((url, index) => ({ id: `m${index + 1}`, url, title: url ? `Page ${index + 1}` : "", loading: false })) }],
});

/** A shell that keeps the list: it answers each intent with whatever the test says the list is now. */
function fakeShell(initial: DesktopWebPreviewTabList = listed()) {
  const shell = {
    now: initial,
    asked: [] as string[],
    intents: [] as DesktopWebPreviewTabIntent[],
    presented: [] as [string | null, boolean][],
    views: [] as string[],
    change: (_list: DesktopWebPreviewTabList) => {},
  };
  const record = (name: string) => (...args: unknown[]) => { shell.views.push(`${name}:${args.join(",")}`); };
  const tabs = {
    open: record("open"), activate: record("activate"), close: record("close"), closeAll: record("closeAll"),
    back: record("back"), forward: record("forward"), reload: record("reload"), setBounds: () => {}, setVisible: async () => null,
    onState: () => () => {},
    onRequest: () => () => {},
    list: {
      get: async (account: string) => { shell.asked.push(account); return shell.now; },
      dispatch: async (intent: DesktopWebPreviewTabIntent) => { shell.intents.push(intent); return shell.now; },
      present: (owner: string | null, showing: boolean) => { shell.presented.push([owner, showing]); },
      onChange: (handler: (list: DesktopWebPreviewTabList) => void) => { shell.change = handler; return () => { shell.change = () => {}; }; },
    },
  } satisfies DesktopWebPreviewTabsBridge;
  return { shell, tabs };
}

beforeEach(() => {
  mirrorBrowserTabsList(null, null);
  useBrowserTabsStore.setState({ browsers: {}, addressFocus: {} });
});

describe("the tab store on a shell that keeps the list", () => {
  it("asks the shell for the list as it is (after a reload or a restart: the tabs that were open) and follows its changes", async () => {
    const { shell, tabs } = fakeShell(listed("https://example.com/a", "https://example.com/b"));
    mirrorBrowserTabsList(tabs.list, "user-1");
    expect(browserTabsListInShell()).toBe(true);
    expect(store().browsers).toEqual({});
    await settle();
    expect(shell.asked).toEqual(["user-1"]);
    const browser = store().browsers[conversation]!;
    expect(browser.tabs.map((tab) => [tab.id, tab.url, tab.title, tab.loading])).toEqual([["m1", "https://example.com/a", "Page 1", false], ["m2", "https://example.com/b", "Page 2", false]]);
    expect(browser.activeId).toBe("m1");
    // The same list again changes nothing (no render); a change replaces only what changed.
    shell.change(listed("https://example.com/a", "https://example.com/b"));
    expect(store().browsers[conversation]).toBe(browser);
    const loading = listed("https://example.com/a", "https://example.com/b");
    loading.browsers[0]!.tabs[1]!.loading = true;
    shell.change(loading);
    expect(store().browsers[conversation]!.tabs[0]).toBe(browser.tabs[0]);
    expect(store().browsers[conversation]!.tabs[1]!.loading).toBe(true);
    // A repeat for the same account does not ask again.
    mirrorBrowserTabsList(tabs.list, "user-1");
    expect(shell.asked).toEqual(["user-1"]);
  });

  it("each change is an intent, and what the shell answers is what shows: only the tab in front and the order show ahead of the answer", async () => {
    const { shell, tabs } = fakeShell(listed("https://example.com/a", "https://example.com/b"));
    mirrorBrowserTabsList(tabs.list, "user-1");
    await settle();
    const before = store().browsers[conversation]!;
    store().navigate(conversation, "m1", "https://example.org/");
    store().closeTab(conversation, "m2");
    expect(store().openUrlInTab(conversation, "https://example.net/", { background: true, afterTabId: "m1" })).toBe(true);
    store().newTab(conversation);
    store().close(conversation);
    expect(store().browsers[conversation]).toBe(before);
    store().activate(conversation, "m2");
    store().moveTab(conversation, "m1", "right");
    expect(store().browsers[conversation]!.activeId).toBe("m2");
    expect(store().browsers[conversation]!.tabs.map((tab) => tab.id)).toEqual(["m2", "m1"]);
    expect(store().addressFocus).toEqual({});
    expect(shell.intents).toEqual([
      { type: "navigate", owner: conversation, tabId: "m1", url: "https://example.org/" },
      { type: "close-tab", owner: conversation, tabId: "m2" },
      { type: "open-tab", owner: conversation, url: "https://example.net/", background: true, afterTabId: "m1" },
      { type: "new-tab", owner: conversation },
      { type: "close", owner: conversation },
      { type: "activate", owner: conversation, tabId: "m2" },
      { type: "move", owner: conversation, tabId: "m1", to: "right" },
    ]);
    // The shell answered every one with the list unchanged (it refused them): that is what shows.
    await settle();
    expect(store().browsers[conversation]!.activeId).toBe("m1");
    expect(store().browsers[conversation]!.tabs.map((tab) => tab.id)).toEqual(["m1", "m2"]);
    expect(store().addressFocus).toEqual({ [conversation]: 1 });
    // The shell's answer (here: it closed the browser) is the state.
    shell.now = listed();
    store().activate(conversation, "m2");
    await settle();
    expect(store().browsers).toEqual({});
  });

  /** The shell's list with `ids` in that order, `activeId` in front, as its change number `revision`. */
  const revised = (revision: number, activeId: string, ids: string[], titles: Record<string, string> = {}): DesktopWebPreviewTabList => ({
    revision,
    browsers: [{ owner: conversation, activeId, tabs: ids.map((id) => ({ id, url: `https://example.com/${id}`, title: titles[id] ?? id, loading: false })) }],
  });

  /** A shell whose answers to intents come when the test says (`answer`, `refuse`), oldest first. */
  function slowShell(initial: DesktopWebPreviewTabList) {
    const made = fakeShell(initial);
    const waiting: { resolve: (list: DesktopWebPreviewTabList) => void; reject: (error: Error) => void }[] = [];
    made.tabs.list.dispatch = (intent: DesktopWebPreviewTabIntent) => {
      made.shell.intents.push(intent);
      return new Promise<DesktopWebPreviewTabList>((resolve, reject) => { waiting.push({ resolve, reject }); });
    };
    const answer = async (list: DesktopWebPreviewTabList) => { waiting.shift()!.resolve(list); await settle(); };
    const refuse = async () => { waiting.shift()!.reject(new Error("web_preview.tab_list_not_owner")); await settle(); };
    return { ...made, answer, refuse };
  }

  it("two presses of Next tab in a row go two tabs on: the second starts from the first one's result, not from what the shell last said", async () => {
    const { shell, tabs, answer } = slowShell(revised(1, "m1", ["m1", "m2", "m3"]));
    mirrorBrowserTabsList(tabs.list, "user-1");
    await settle();
    store().runCommand(conversation, { type: "command", command: "next-tab", tabId: "m1" });
    store().runCommand(conversation, { type: "command", command: "next-tab", tabId: "m1" });
    expect(shell.intents).toEqual([{ type: "activate", owner: conversation, tabId: "m2" }, { type: "activate", owner: conversation, tabId: "m3" }]);
    expect(store().browsers[conversation]!.activeId).toBe("m3");
    // The first answer does not take the front back to the tab between.
    await answer(revised(2, "m2", ["m1", "m2", "m3"]));
    expect(store().browsers[conversation]!.activeId).toBe("m3");
    await answer(revised(3, "m3", ["m1", "m2", "m3"]));
    expect(store().browsers[conversation]!.activeId).toBe("m3");
    // The shell stays the authority: once it has answered, what it says shows, whatever was asked.
    store().activate(conversation, "m1");
    expect(store().browsers[conversation]!.activeId).toBe("m1");
    await answer(revised(3, "m3", ["m1", "m2", "m3"]));
    expect(store().browsers[conversation]!.activeId).toBe("m3");
  });

  it("a tab moved stays where it was dropped while the shell answers, through a change that crosses it; a refused move goes back", async () => {
    const { shell, tabs, answer, refuse } = slowShell(revised(1, "m1", ["m1", "m2", "m3"]));
    mirrorBrowserTabsList(tabs.list, "user-1");
    await settle();
    const order = () => store().browsers[conversation]!.tabs.map((tab) => tab.id);
    store().moveTab(conversation, "m1", "right");
    expect(order()).toEqual(["m2", "m1", "m3"]);
    // A page's title changed meanwhile: the list the shell sent still has the order before the move.
    shell.change(revised(2, "m1", ["m1", "m2", "m3"], { m3: "Renamed" }));
    expect(order()).toEqual(["m2", "m1", "m3"]);
    expect(store().browsers[conversation]!.tabs[2]!.title).toBe("Renamed");
    // The shell's change for the move itself, then its answer: once each, not moved twice.
    shell.change(revised(3, "m1", ["m2", "m1", "m3"], { m3: "Renamed" }));
    expect(order()).toEqual(["m2", "m1", "m3"]);
    await answer(revised(3, "m1", ["m2", "m1", "m3"], { m3: "Renamed" }));
    expect(order()).toEqual(["m2", "m1", "m3"]);
    // Refused (the shell no longer holds this page as the list's owner): what it last said shows again.
    store().moveTab(conversation, "m3", "left");
    expect(order()).toEqual(["m2", "m3", "m1"]);
    await refuse();
    expect(order()).toEqual(["m2", "m1", "m3"]);
  });

  it("an answer that arrives after a newer change does not replace it: of two lists the larger revision stands", async () => {
    const { shell, tabs, answer } = slowShell(revised(1, "m1", ["m1", "m2"]));
    mirrorBrowserTabsList(tabs.list, "user-1");
    await settle();
    store().navigate(conversation, "m1", "https://example.org/");
    // The shell handled the intent (revision 2), then the page reported its title (revision 3); the change is heard first.
    shell.change(revised(3, "m1", ["m1", "m2"], { m1: "Loaded" }));
    expect(store().browsers[conversation]!.tabs[0]!.title).toBe("Loaded");
    await answer(revised(2, "m1", ["m1", "m2"], { m1: "" }));
    expect(store().browsers[conversation]!.tabs[0]!.title).toBe("Loaded");
    // An older change after a newer one is dropped the same way; the same revision again, or a newer one, is taken.
    shell.change(revised(2, "m2", ["m1", "m2"]));
    expect(store().browsers[conversation]!.activeId).toBe("m1");
    shell.change(revised(4, "m2", ["m1", "m2"]));
    expect(store().browsers[conversation]!.activeId).toBe("m2");
    // Another account's list starts over: its first answer is taken whatever its number.
    shell.now = revised(1, "m1", ["m1"]);
    mirrorBrowserTabsList(tabs.list, "user-2");
    await settle();
    expect(store().browsers[conversation]!.tabs.map((tab) => tab.id)).toEqual(["m1"]);
  });

  it("a tab's address, title and loading state are the list's alone: the shell's per-tab report gives only Back / Forward and the refusal", async () => {
    const { tabs } = fakeShell(listed("https://example.com/a"));
    mirrorBrowserTabsList(tabs.list, "user-1");
    await settle();
    const blocked = { url: "https://popup.example/", reason: "popup" as const, at: 5 };
    store().applyState(conversation, { tabId: "m1", url: "https://example.com/elsewhere", title: "Another title", canGoBack: true, canGoForward: true, loading: true, blocked });
    expect(store().browsers[conversation]!.tabs[0]).toMatchObject({ url: "https://example.com/a", title: "Page 1", loading: false, canGoBack: true, canGoForward: true, blocked });
  });

  it("signing out with the conversation's panel still mounted tells the shell the window is on no browser, on the list's own channel", async () => {
    const { shell, tabs } = fakeShell(listed("https://example.com/a"));
    mirrorBrowserTabsList(tabs.list, "user-1");
    const detach = attachBrowserViews(tabs, conversation);
    setBrowserShowing(conversation, true);
    await settle();
    expect(shell.presented).toEqual([[conversation, true]]);
    mirrorBrowserTabsList(tabs.list, null);
    expect(shell.presented).toEqual([[conversation, true], [null, false]]);
    expect(store().browsers).toEqual({});
    // The panel unmounts later: nothing more to say, and never the calls the shell does not hear from this page.
    setBrowserShowing(conversation, false);
    detach();
    expect(shell.presented).toEqual([[conversation, true], [null, false]]);
    expect(shell.views).toEqual([]);
    // Signed in again: the browser the shell answers with is presented afresh.
    mirrorBrowserTabsList(tabs.list, "user-1");
    const again = attachBrowserViews(tabs, conversation);
    setBrowserShowing(conversation, true);
    await settle();
    expect(shell.presented.at(-1)).toEqual([conversation, true]);
    setBrowserShowing(conversation, false);
    again();
  });

  it("a refused intent (the shell dropped this page as the list's owner) asks for the list again, once, and sends the intent once more: the browser works again", async () => {
    const { shell, tabs } = fakeShell(listed("https://example.com/a"));
    mirrorBrowserTabsList(tabs.list, "user-1");
    await settle();
    // The shell forgot the list (a storage clear after this page asked): it refuses until the page asks again.
    let owner = false;
    const dispatch = tabs.list.dispatch;
    tabs.list.dispatch = async (intent) => {
      if (owner) return dispatch(intent);
      shell.intents.push(intent);
      throw new Error("web_preview.tab_list_not_owner");
    };
    const get = tabs.list.get;
    tabs.list.get = async (account) => { owner = true; return get(account); };
    shell.now = { ...listed("https://example.com/new"), revision: 7 };
    store().openUrl(conversation, "https://example.com/new");
    await settle();
    await settle();
    expect(shell.asked).toEqual(["user-1", "user-1"]);
    expect(shell.intents).toEqual([{ type: "open", owner: conversation, url: "https://example.com/new" }, { type: "open", owner: conversation, url: "https://example.com/new" }]);
    expect(store().browsers[conversation]!.tabs.map((tab) => tab.url)).toEqual(["https://example.com/new"]);
    // A shell that goes on refusing: one more ask and one more try for each intent, never a loop.
    owner = false;
    tabs.list.get = get;
    shell.asked.length = 0;
    shell.intents.length = 0;
    store().navigate(conversation, "m1", "https://example.com/again");
    for (let turn = 0; turn < 5; turn += 1) await settle();
    expect(shell.asked).toEqual(["user-1"]);
    expect(shell.intents.length).toBe(2);
  });

  it("opening a page beside brings the browser the shell answers with to the front", async () => {
    const { shell, tabs } = fakeShell();
    mirrorBrowserTabsList(tabs.list, "user-1");
    await settle();
    shell.now = listed("https://example.com/a");
    store().openUrl(conversation, "https://example.com/a");
    expect(store().browsers).toEqual({});
    await settle();
    expect(shell.intents).toEqual([{ type: "open", owner: conversation, url: "https://example.com/a" }]);
    expect(store().browsers[conversation]!.frontAt).toBeGreaterThan(0);
    // What only this page knows of a tab stays through the shell's answers.
    store().applyState(conversation, { tabId: "m1", url: "https://example.com/a", title: "Page 1", canGoBack: true, canGoForward: false, loading: false, blocked: null });
    shell.change({ browsers: [{ owner: conversation, activeId: "m1", tabs: [{ id: "m1", url: "https://example.com/a", title: "Renamed", loading: false }] }] });
    expect(store().browsers[conversation]!.tabs[0]).toMatchObject({ title: "Renamed", canGoBack: true });
  });

  it("an address the app would not show is not taken from the shell either; a malformed list is no tabs", async () => {
    const { shell, tabs } = fakeShell({ browsers: [{ owner: conversation, activeId: "gone", tabs: [{ id: "m1", url: "javascript:alert(1)", title: 5 as never, loading: "yes" as never }] }] });
    mirrorBrowserTabsList(tabs.list, "user-1");
    await settle();
    expect(store().browsers[conversation]).toMatchObject({ activeId: "m1", tabs: [{ id: "m1", url: null, title: "", loading: false }] });
    for (const bad of [null, "tabs", { browsers: "none" }, { browsers: [null, { owner: 5 }, { owner: "c", activeId: "m1", tabs: [] }] }]) {
      shell.change(bad as never);
      expect(store().browsers).toEqual({});
    }
  });

  it("another account starts from what the shell answers for it; signed out, the store is empty and its own again", async () => {
    const { shell, tabs } = fakeShell(listed("https://example.com/a"));
    mirrorBrowserTabsList(tabs.list, "user-1");
    await settle();
    shell.now = listed();
    mirrorBrowserTabsList(tabs.list, "user-2");
    expect(store().browsers).toEqual({});
    await settle();
    expect(shell.asked).toEqual(["user-1", "user-2"]);
    expect(store().browsers).toEqual({});
    mirrorBrowserTabsList(tabs.list, null);
    expect(browserTabsListInShell()).toBe(false);
    // An answer that comes after is dropped.
    shell.change(listed("https://example.com/late"));
    expect(store().browsers).toEqual({});
  });

  it("the views are the shell's: the web only says which conversation's browser it is on and whether its panel shows", async () => {
    const { shell, tabs } = fakeShell(listed("https://example.com/a", "https://example.com/b"));
    mirrorBrowserTabsList(tabs.list, "user-1");
    // As after a reload of the page: the panel mounts before the shell has answered.
    const detach = attachBrowserViews(tabs, conversation);
    setBrowserShowing(conversation, true);
    expect(shell.presented).toEqual([]);
    await settle();
    expect(shell.presented).toEqual([[conversation, true]]);
    setBrowserShowing(conversation, false);
    shell.change(listed("https://example.com/a"));
    expect(shell.presented).toEqual([[conversation, true], [conversation, false]]);
    // The list asked again for another account: the shell starts from nothing, so the browser is presented again.
    setBrowserShowing(conversation, true);
    mirrorBrowserTabsList(tabs.list, "user-2");
    await settle();
    expect(shell.presented.slice(2)).toEqual([[conversation, true], [null, false], [conversation, true]]);
    detach();
    expect(shell.presented.at(-1)).toEqual([null, false]);
    expect(shell.views).toEqual([]);
  });
});

describe("the tab store on a shell from before the list", () => {
  it("is the list itself and drives the views, as before", () => {
    const { shell, tabs } = fakeShell();
    const { list: _list, ...old } = tabs;
    expect(browserTabsListInShell()).toBe(false);
    const detach = attachBrowserViews(old, conversation);
    store().openUrl(conversation, "https://example.com/a");
    setBrowserShowing(conversation, true);
    const tab = store().browsers[conversation]!.tabs[0]!;
    expect(shell.views).toEqual([`open:${conversation},${tab.id},https://example.com/a`, `activate:${tab.id}`]);
    expect(shell.intents).toEqual([]);
    setBrowserShowing(conversation, false);
    detach();
    expect(shell.presented).toEqual([]);
  });
});
