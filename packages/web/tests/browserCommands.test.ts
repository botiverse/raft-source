import { beforeEach, describe, expect, it } from "vitest";
import type { DesktopWebPreviewTabRequest, DesktopWebPreviewTabsBridge } from "@botiverse/raft-shared";

import { useBrowserTabsStore } from "../src/features/webPreview/browserTabsStore";
import { attachBrowserViews, setBrowserShowing } from "../src/features/webPreview/browserViews";

// A browser key pressed with the focus in a tab's page (#proj-workspace:#294): the shell decides which command it is
// (its one shortcut table, apps/desktop webPreviewCommands.ts) and the web's tab list carries it out.
const conversation = "c1";
const store = () => useBrowserTabsStore.getState();
const browser = () => store().browsers[conversation]!;
const front = () => browser().tabs.findIndex((tab) => tab.id === browser().activeId);
const run = (command: Extract<DesktopWebPreviewTabRequest, { type: "command" }>["command"], tabId = browser().activeId, index?: number) =>
  store().runCommand(conversation, { type: "command", command, tabId, ...(index === undefined ? null : { index }) });

describe("a browser command from a tab's page", () => {
  beforeEach(() => {
    useBrowserTabsStore.setState({ browsers: {}, addressFocus: {} });
    for (const page of ["a", "b", "c"]) store().openUrl(conversation, `https://example.com/${page}`);
  });

  it("goes to the tab after and before the one in front, round the ends", () => {
    expect(front()).toBe(2);
    run("next-tab");
    expect(front()).toBe(0);
    run("next-tab");
    expect(front()).toBe(1);
    run("previous-tab");
    run("previous-tab");
    expect(front()).toBe(2);
  });

  it("goes to a numbered tab, the last one for 9, and nowhere for a number past the last", () => {
    run("select-tab", undefined, 0);
    expect(front()).toBe(0);
    run("select-tab", undefined, -1);
    expect(front()).toBe(2);
    run("select-tab", undefined, 5);
    expect(front()).toBe(2);
  });

  it("closes the tab the key was pressed in; the last tab closes the browser", () => {
    const [a, b, c] = browser().tabs.map((tab) => tab.id);
    run("close-tab", b);
    expect(browser().tabs.map((tab) => tab.id)).toEqual([a, c]);
    expect(browser().activeId).toBe(c);
    run("close-tab", c);
    run("close-tab", a);
    expect(store().browsers[conversation]).toBeUndefined();
  });

  it("opens an empty tab in front, and asks the address field to take the focus", () => {
    run("focus-address");
    expect(store().addressFocus).toEqual({ [conversation]: 1 });
    expect(browser().tabs).toHaveLength(3);
    run("new-tab");
    expect(browser().tabs).toHaveLength(4);
    expect(browser().tabs[front()]!.url).toBeNull();
    expect(store().addressFocus).toEqual({ [conversation]: 2 });
  });

  it("does nothing for next and previous in a browser with no tab", () => {
    useBrowserTabsStore.setState({ browsers: { [conversation]: { ...browser(), tabs: [] } } });
    expect(() => { run("next-tab", "gone"); run("previous-tab", "gone"); }).not.toThrow();
    expect(browser().tabs).toEqual([]);
  });

  it("reaches the tab list from the shell's request, for the conversation whose views the shell holds", () => {
    let request: ((request: DesktopWebPreviewTabRequest) => void) | undefined;
    const calls: string[] = [];
    const bridge = {
      open: (_owner: string, tabId: string) => calls.push(`open ${tabId}`),
      activate: (tabId: string | null) => calls.push(`activate ${tabId}`),
      close: (tabId: string) => calls.push(`close ${tabId}`),
      closeAll: () => calls.push("closeAll"),
      onState: () => () => {},
      onRequest: (handler: (request: DesktopWebPreviewTabRequest) => void) => {
        request = handler;
        return () => {};
      },
    } as unknown as DesktopWebPreviewTabsBridge;
    const detach = attachBrowserViews(bridge, conversation);
    setBrowserShowing(conversation, true);
    const [a, , c] = browser().tabs.map((tab) => tab.id);
    request!({ type: "command", command: "next-tab", tabId: c! });
    expect(browser().activeId).toBe(a);
    expect(calls.slice(-2)).toEqual([`open ${a}`, `activate ${a}`]);
    request!({ type: "command", command: "close-tab", tabId: a! });
    expect(browser().tabs).toHaveLength(2);
    expect(calls).toContain(`close ${a}`);
    // Not a command this web knows (a newer shell): nothing happens.
    request!({ type: "command", command: "find", tabId: c! } as never);
    expect(browser().tabs).toHaveLength(2);
    setBrowserShowing(conversation, false);
    detach();
  });
});
