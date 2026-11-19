import { beforeEach, describe, expect, it } from "vitest";
import type { DesktopWebPreviewTabIntent, DesktopWebPreviewTabList, DesktopWebPreviewTabState, DesktopWebPreviewTabsBridge } from "@botiverse/raft-shared";

import { fitBrowserHead, PINNED_TAB_WIDTH, splitBrowserTabs, TAB_MIN_WIDTH } from "../src/features/webPreview/browserHeadFit";
import { BROWSER_MAX_TABS, browserOf, canPinBrowserTab, mirrorBrowserTabsList, moveBrowserTab, useBrowserTabsStore } from "../src/features/webPreview/browserTabsStore";
import { attachBrowserViews, setBrowserShowing } from "../src/features/webPreview/browserViews";

// Pinned tabs (#proj-workspace:#297): the shell's list carries the window's pinned tabs apart from each
// conversation's own; the store shows every conversation its strip (the pinned tabs, then its own), and a
// conversation with no tabs of its own the pinned tabs while their panel is open.
const store = () => useBrowserTabsStore.getState();
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const tab = (id: string) => ({ id, url: `https://example.com/${id}`, title: `Page ${id}`, loading: false });
const list = (pinned: string[], browsers: Record<string, string[]>, more: { open?: boolean; front?: string; pinnedFront?: string[] } = {}): DesktopWebPreviewTabList => ({
  browsers: Object.entries(browsers).map(([owner, ids]) => ({ owner, activeId: ids[0]!, tabs: ids.map(tab), ...(more.pinnedFront?.includes(owner) ? { pinnedFront: true } : null) })),
  ...(pinned.length > 0 ? { pinned: { tabs: pinned.map(tab), activeId: more.front ?? pinned[0]!, open: more.open ?? true } } : null),
});
/** The conversation's strip as ids, the pinned ones marked, the one in front in brackets. */
const strip = (conversationId: string) => {
  const browser = browserOf(store(), conversationId);
  return browser ? browser.tabs.map((each) => { const name = `${each.pinned ? "*" : ""}${each.id}`; return each.id === browser.activeId ? `[${name}]` : name; }).join(" ") : null;
};

function fakeShell(initial: DesktopWebPreviewTabList, pins = true) {
  const shell = {
    now: initial,
    intents: [] as DesktopWebPreviewTabIntent[],
    presented: [] as [string | null, boolean][],
    change: (_list: DesktopWebPreviewTabList) => {},
    state: (_state: DesktopWebPreviewTabState) => {},
  };
  const tabs = {
    open: () => {}, activate: () => {}, close: () => {}, closeAll: () => {}, back: () => {}, forward: () => {}, reload: () => {}, setBounds: () => {}, setVisible: async () => null,
    onState: (handler: (state: DesktopWebPreviewTabState) => void) => { shell.state = handler; return () => {}; },
    onRequest: () => () => {},
    list: {
      get: async () => shell.now,
      dispatch: async (intent: DesktopWebPreviewTabIntent) => { shell.intents.push(intent); return shell.now; },
      present: (owner: string | null, showing: boolean) => { shell.presented.push([owner, showing]); },
      onChange: (handler: (next: DesktopWebPreviewTabList) => void) => { shell.change = handler; return () => {}; },
      ...(pins ? { pins: true as const } : null),
    },
  } satisfies DesktopWebPreviewTabsBridge;
  return { shell, tabs };
}

async function mirror(initial: DesktopWebPreviewTabList, pins = true) {
  const fake = fakeShell(initial, pins);
  mirrorBrowserTabsList(fake.tabs.list, "user-1");
  await settle();
  return fake;
}

beforeEach(() => {
  mirrorBrowserTabsList(null, null);
  useBrowserTabsStore.setState({ browsers: {}, pinnedOnly: null, addressFocus: {} });
});

describe("the mirror with pinned tabs", () => {
  it("shows every conversation its strip: the pinned tabs first, then its own; the one in front is its own unless a pinned one was brought forward there", async () => {
    await mirror(list(["p1", "p2"], { c1: ["a", "b"], c2: ["x"] }, { front: "p2", pinnedFront: ["c2"] }));
    expect(strip("c1")).toBe("*p1 *p2 [a] b");
    expect(strip("c2")).toBe("*p1 [*p2] x");
    // One object for a pinned tab in every strip.
    expect(store().browsers.c1!.tabs[0]).toBe(store().browsers.c2!.tabs[0]);
  });

  it("a conversation with no tabs of its own has the pinned tabs while their panel is open, and nothing once it is closed", async () => {
    const { shell } = await mirror(list(["p1", "p2"], { c1: ["a"] }, { front: "p2" }));
    expect(strip("c9")).toBe("*p1 [*p2]");
    const browser = browserOf(store(), "c9");
    shell.change({ ...list(["p1", "p2"], { c1: ["a"] }, { front: "p2" }), revision: 2 });
    expect(browserOf(store(), "c9")).toBe(browser);
    shell.change({ ...list(["p1", "p2"], { c1: ["a"] }, { front: "p2", open: false }), revision: 3 });
    expect(strip("c9")).toBeNull();
    expect(strip("c1")).toBe("*p1 *p2 [a]");
    // No pinned tab at all (also a shell from before them): as it was.
    shell.change({ ...list([], { c1: ["a"] }), revision: 4 });
    expect([strip("c1"), strip("c9")]).toEqual(["[a]", null]);
  });

  it("the views are presented for a conversation with only the pinned tabs, as for one with tabs of its own", async () => {
    const { shell, tabs } = await mirror(list(["p1"], {}));
    const detach = attachBrowserViews(tabs, "c9");
    setBrowserShowing("c9", true);
    expect(shell.presented).toEqual([["c9", false], ["c9", true]]);
    shell.change({ ...list(["p1"], {}, { open: false }), revision: 2 });
    expect(shell.presented.at(-1)).toEqual([null, false]);
    setBrowserShowing("c9", false);
    detach();
  });

  it("a tab keeps what only this page knows of it when it is pinned or unpinned, and a pinned tab's report reaches every strip", async () => {
    const { shell, tabs } = await mirror(list([], { c1: ["a", "b"], c2: ["x"] }));
    const detach = attachBrowserViews(tabs, "c1");
    shell.state({ tabId: "a", url: "https://example.com/a", title: "Page a", canGoBack: true, canGoForward: false, loading: false });
    expect(store().browsers.c1!.tabs[0]!.canGoBack).toBe(true);
    shell.change({ ...list(["a"], { c1: ["b"], c2: ["x"] }), revision: 2 });
    expect(strip("c1")).toBe("*a [b]");
    expect(store().browsers.c2!.tabs[0]).toMatchObject({ id: "a", pinned: true, canGoBack: true });
    shell.state({ tabId: "a", url: "https://example.com/a", title: "Page a", canGoBack: true, canGoForward: true, loading: false });
    expect([store().browsers.c1!.tabs[0]!.canGoForward, store().browsers.c2!.tabs[0]!.canGoForward, store().pinnedOnly!.tabs[0]!.canGoForward]).toEqual([true, true, true]);
    shell.change({ ...list([], { c1: ["b"], c2: ["a", "x"] }), revision: 3 });
    expect(store().browsers.c2!.tabs[0]).toMatchObject({ id: "a", pinned: false, canGoBack: true, canGoForward: true });
    detach();
  });
});

describe("the tab menu's intents", () => {
  it("each one is an intent to the shell, naming the conversation the strip is beside; also beside one with only the pinned tabs", async () => {
    const { shell } = await mirror(list(["p1"], { c1: ["a", "b"] }));
    store().pinTab("c1", "a");
    store().unpinTab("c1", "p1");
    store().duplicateTab("c1", "b");
    store().closeOtherTabs("c1", "a");
    store().closeTabsToRight("c1", "p1");
    store().unpinTab("c9", "p1");
    store().activate("c9", "p1");
    store().newTab("c9");
    store().pinTab("c1", "nope");
    expect(shell.intents).toEqual([
      { type: "pin", owner: "c1", tabId: "a" },
      { type: "unpin", owner: "c1", tabId: "p1" },
      { type: "duplicate", owner: "c1", tabId: "b" },
      { type: "close-others", owner: "c1", tabId: "a" },
      { type: "close-right", owner: "c1", tabId: "p1" },
      { type: "unpin", owner: "c9", tabId: "p1" },
      { type: "new-tab", owner: "c9" },
    ]);
  });

  it("a shell from before pinned tabs is asked for none of them", async () => {
    const { shell } = await mirror(list([], { c1: ["a", "b"] }), false);
    store().pinTab("c1", "a");
    store().duplicateTab("c1", "a");
    store().closeOtherTabs("c1", "a");
    store().closeTabsToRight("c1", "a");
    expect(shell.intents).toEqual([]);
  });

  it("the order shown ahead of the shell's answer keeps a tab among its own kind", async () => {
    const { shell } = await mirror(list(["p1", "p2"], { c1: ["a", "b"] }));
    store().moveTab("c1", "p2", "a");
    store().moveTab("c1", "a", "left");
    expect(shell.intents).toEqual([]);
    store().moveTab("c1", "p2", "left");
    store().moveTab("c1", "a", "b");
    expect(strip("c1")).toBe("*p2 *p1 b [a]");
  });
});

describe("rules the strip draws from", () => {
  const tabs = [{ id: "p1", pinned: true }, { id: "p2", pinned: true }, { id: "a" }, { id: "b" }];
  const order = (moved: readonly { id: string }[]) => moved.map((each) => each.id).join(" ");

  it.each([
    ["p1", "right", "p2 p1 a b"],
    ["p2", "p1", "p2 p1 a b"],
    ["b", "a", "p1 p2 b a"],
    ["a", "right", "p1 p2 b a"],
  ])("moves %s to %s among its own kind", (tabId, to, expected) => {
    expect(order(moveBrowserTab(tabs, tabId, to))).toBe(expected);
  });

  it.each([["p2", "right"], ["p2", "a"], ["a", "left"], ["a", "p1"], ["b", "p2"]])("does not move %s to %s: across the line between pinned and own", (tabId, to) => {
    expect(moveBrowserTab(tabs, tabId, to)).toBe(tabs);
  });

  it("one more tab can be pinned while every conversation's strip stays within the cap, a place left for a tab of its own", async () => {
    const own = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => `${prefix}${index}`);
    await mirror(list(["p1"], { c1: own(3, "a"), c2: own(BROWSER_MAX_TABS - 2, "x") }));
    expect(canPinBrowserTab(store(), "c1")).toBe(true);
    await mirror(list(["p1"], { c1: own(3, "a"), c2: own(BROWSER_MAX_TABS - 1, "x") }));
    // c2's strip is full (1 pinned + 11): a pin from c1 would put it past the cap; from c2 itself the strip does not grow.
    expect([canPinBrowserTab(store(), "c1"), canPinBrowserTab(store(), "c2")]).toEqual([false, true]);
    await mirror(list(own(BROWSER_MAX_TABS - 1, "p"), { c1: ["a"] }));
    expect(canPinBrowserTab(store(), "c1")).toBe(false);
  });

  it("the fit counts a pinned tab as its icon's width, and the row keeps the pinned tabs and the one in front", () => {
    const head = { chip: false, tabs: 5, frontWidth: 120, controls: 1, width: 0 };
    const narrowest = (fit: { pinned?: number; frontPinned?: boolean }) => {
      for (let width = 100; width < 2000; width += 1) if (fitBrowserHead({ ...head, ...fit, width }).tabsShown === 5) return width;
      return 0;
    };
    // Two of the five pinned: the row needs two tabs' least width less, and two icons' width more.
    expect(narrowest({}) - narrowest({ pinned: 2 })).toBe(2 * (TAB_MIN_WIDTH - PINNED_TAB_WIDTH));
    // A pinned tab in front: every other tab is at its least width, and the front one takes an icon's.
    expect(narrowest({ pinned: 2 }) - narrowest({ pinned: 2, frontPinned: true })).toBe(120 - TAB_MIN_WIDTH);
    const strip5 = ["p1", "p2", "a", "b", "c"].map((id, index) => ({ id, pinned: index < 2 })) as never[];
    expect(splitBrowserTabs(strip5, "c", 3).row.map((each: { id: string }) => each.id)).toEqual(["p1", "p2", "c"]);
  });
});
