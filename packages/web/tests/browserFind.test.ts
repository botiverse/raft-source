import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DesktopWebPreviewFound, DesktopWebPreviewTabRequest, DesktopWebPreviewTabState, DesktopWebPreviewTabsBridge } from "@botiverse/raft-shared";

import { useBrowserTabsStore } from "../src/features/webPreview/browserTabsStore";
import { attachBrowserViews, closeBrowserFind, setBrowserShowing } from "../src/features/webPreview/browserViews";

// Find in page (#proj-workspace:#292). The find field only says what should be searched (the list's `find`);
// browserViews.ts asks the shell for exactly that. The shell decides the keys (apps/desktop webPreviewCommands.ts)
// and runs the search in the tab's page (webPreviewTabs.ts).
const conversation = "c1";
const store = () => useBrowserTabsStore.getState();
const browser = () => store().browsers[conversation]!;
const find = () => store().find[conversation];

function shell(options: { find?: boolean } = {}) {
  const calls: string[] = [];
  const handlers: { request?: (request: DesktopWebPreviewTabRequest) => void; state?: (state: DesktopWebPreviewTabState) => void; found?: (found: DesktopWebPreviewFound) => void } = {};
  const bridge = {
    open: () => {},
    activate: () => {},
    close: () => {},
    closeAll: () => {},
    onState: (handler: (state: DesktopWebPreviewTabState) => void) => { handlers.state = handler; return () => {}; },
    onRequest: (handler: (request: DesktopWebPreviewTabRequest) => void) => { handlers.request = handler; return () => {}; },
    ...(options.find === false ? null : {
      find: (tabId: string, text: string, how: { forward: boolean; fresh: boolean }) => calls.push(`find ${tabId} "${text}" ${how.fresh ? "fresh" : how.forward ? "next" : "previous"}`),
      stopFind: (tabId: string, focusPage: boolean) => calls.push(`stop ${tabId}${focusPage ? " focus" : ""}`),
      onFound: (handler: (found: DesktopWebPreviewFound) => void) => { handlers.found = handler; return () => {}; },
    }),
  } as unknown as DesktopWebPreviewTabsBridge;
  return { bridge, calls, handlers };
}

describe("find in page", () => {
  let detach: (() => void) | null = null;
  const attach = (options?: { find?: boolean }) => {
    const made = shell(options);
    detach = attachBrowserViews(made.bridge, conversation);
    setBrowserShowing(conversation, true);
    return made;
  };
  beforeEach(() => {
    useBrowserTabsStore.setState({ browsers: {}, addressFocus: {}, find: {} });
    for (const page of ["a", "b"]) store().openUrl(conversation, `https://example.com/${page}`);
  });
  afterEach(() => {
    setBrowserShowing(conversation, false);
    detach?.();
    detach = null;
  });

  it("the find key from a page opens the field for that tab; again, it takes the keyboard again and keeps its text", () => {
    const { handlers, calls } = attach();
    const b = browser().activeId;
    handlers.request!({ type: "command", command: "find", tabId: b });
    const first = find()!.focus;
    expect(find()).toEqual({ tabId: b, text: "", focus: first, step: 0, forward: true, found: null });
    store().setFindText(conversation, "raft");
    handlers.request!({ type: "command", command: "find", tabId: b });
    expect(find()).toMatchObject({ tabId: b, text: "raft" });
    expect(find()!.focus).toBeGreaterThan(first);
    expect(calls).toEqual([`find ${b} "raft" fresh`]);
  });

  it("typing searches from the first match; next and previous move from the match marked; no text ends the search", () => {
    const { handlers, calls } = attach();
    const b = browser().activeId;
    store().openFind(conversation, b);
    expect(calls).toEqual([]);
    store().setFindText(conversation, "r");
    store().setFindText(conversation, "ra");
    handlers.request!({ type: "command", command: "find-next", tabId: b });
    handlers.request!({ type: "command", command: "find-previous", tabId: b });
    store().stepFind(conversation, b, true);
    expect(calls).toEqual([`find ${b} "r" fresh`, `find ${b} "ra" fresh`, `find ${b} "ra" next`, `find ${b} "ra" previous`, `find ${b} "ra" next`]);
    handlers.found!({ tabId: b, matches: 12, active: 3 });
    expect(find()!.found).toEqual({ matches: 12, active: 3 });
    store().setFindText(conversation, "");
    expect(calls.at(-1)).toBe(`stop ${b}`);
    expect(find()!.found).toBeNull();
    // Nothing to step through, and an answer that comes late is nobody's.
    store().stepFind(conversation, b, true);
    handlers.found!({ tabId: b, matches: 12, active: 4 });
    expect(calls).toHaveLength(6);
    expect(find()!.found).toBeNull();
  });

  it("the next-match key with no field open, or no text in it, does nothing: no field appears without the keyboard", () => {
    const { handlers, calls } = attach();
    const b = browser().activeId;
    handlers.request!({ type: "command", command: "find-next", tabId: b });
    expect(find()).toBeUndefined();
    store().openFind(conversation, b);
    handlers.request!({ type: "command", command: "find-previous", tabId: b });
    expect(find()!.step).toBe(0);
    expect(calls).toEqual([]);
  });

  it("an answer for a search that ended is nobody's, even with a text in the field", () => {
    const { handlers } = attach();
    const [a, b] = browser().tabs.map((tab) => tab.id) as [string, string];
    store().openFind(conversation, b);
    store().setFindText(conversation, "raft");
    store().activate(conversation, a);
    handlers.found!({ tabId: b, matches: 12, active: 3 });
    expect(find()!.found).toBeNull();
  });

  it("the field goes with its tab, and a search of the browser left behind is ended when the panel goes", () => {
    const { calls } = attach();
    const [a, b] = browser().tabs.map((tab) => tab.id) as [string, string];
    store().openFind(conversation, b);
    store().setFindText(conversation, "raft");
    store().closeTab(conversation, b);
    expect(calls.at(-1)).toBe(`stop ${b}`);
    expect(find()).toBeUndefined();
    store().openFind(conversation, a);
    store().setFindText(conversation, "docs");
    detach!();
    detach = null;
    expect(calls.at(-1)).toBe(`stop ${a}`);
  });

  it("the search is its tab's: another tab in front ends it in the shell, and coming back searches again", () => {
    const { calls } = attach();
    const [a, b] = browser().tabs.map((tab) => tab.id) as [string, string];
    store().openFind(conversation, b);
    store().setFindText(conversation, "raft");
    store().activate(conversation, a);
    expect(calls).toEqual([`find ${b} "raft" fresh`, `stop ${b}`]);
    expect(find()).toMatchObject({ tabId: b, text: "raft" });
    store().activate(conversation, b);
    expect(calls.at(-1)).toBe(`find ${b} "raft" fresh`);
    // The panel behind the Artifact: nothing is searched in a page nobody sees.
    setBrowserShowing(conversation, false);
    expect(calls.at(-1)).toBe(`stop ${b}`);
  });

  it("a page that finishes loading with the field open is searched again", () => {
    const { handlers, calls } = attach();
    const b = browser().activeId;
    store().openFind(conversation, b);
    store().setFindText(conversation, "raft");
    const state = { tabId: b, url: "https://example.com/next", title: "Next", canGoBack: true, canGoForward: false };
    // The first report ends the load the tab opened with: the page was searched while it loaded, so once more.
    handlers.state!({ ...state, loading: false } as DesktopWebPreviewTabState);
    calls.length = 0;
    handlers.state!({ ...state, loading: true } as DesktopWebPreviewTabState);
    expect(calls).toHaveLength(0);
    handlers.state!({ ...state, loading: false } as DesktopWebPreviewTabState);
    expect(calls).toEqual([`find ${b} "raft" fresh`]);
    // A report that changes nothing about loading searches nothing more.
    handlers.state!({ ...state, title: "Next!", loading: false } as DesktopWebPreviewTabState);
    expect(calls).toHaveLength(1);
  });

  it("Close ends the search and hands the page the keyboard; closing the browser drops the field", () => {
    const { calls } = attach();
    const b = browser().activeId;
    store().openFind(conversation, b);
    store().setFindText(conversation, "raft");
    closeBrowserFind(conversation);
    expect(calls.at(-1)).toBe(`stop ${b} focus`);
    expect(find()).toBeUndefined();
    // Nothing left to end.
    store().activate(conversation, browser().tabs[0]!.id);
    expect(calls).toHaveLength(2);
    store().openFind(conversation, browser().activeId);
    store().close(conversation);
    expect(find()).toBeUndefined();
  });

  it("a shell that predates find in page is asked nothing", () => {
    attach({ find: false });
    const b = browser().activeId;
    store().openFind(conversation, b);
    expect(() => { store().setFindText(conversation, "raft"); store().stepFind(conversation, b, true); closeBrowserFind(conversation); }).not.toThrow();
    expect(find()).toBeUndefined();
  });
});
