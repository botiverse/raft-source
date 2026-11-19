// The tab's own menu and the pinned tabs' look (#proj-workspace:#297). Needs a DOM: run with RAFT_WEB_TEST_DOM=1.
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DesktopWebPreviewTabIntent, DesktopWebPreviewTabList, DesktopWebPreviewTabsBridge } from "@botiverse/raft-shared";

import { TestIntlProvider } from "./helpers/intl";
import { BrowserTabStrip } from "../src/features/webPreview/BrowserTabStrip";
import { browserOf, mirrorBrowserTabsList, useBrowserTabsStore } from "../src/features/webPreview/browserTabsStore";

const tab = (id: string, url: string | null = `https://example.com/${id}`) => ({ id, url, title: url ? `Page ${id}` : "", loading: false });
const LIST: DesktopWebPreviewTabList = {
  browsers: [{ owner: "c1", activeId: "b", tabs: [tab("a"), tab("b"), tab("c"), tab("empty", null)] }, { owner: "c2", activeId: "x", tabs: [tab("x")] }],
  pinned: { tabs: [tab("p1"), tab("p2")], activeId: "p1", open: true },
};

function shell(pins: boolean, list = LIST) {
  const intents: DesktopWebPreviewTabIntent[] = [];
  const reloaded: string[] = [];
  const bridge = {
    open: () => {}, activate: () => {}, close: () => {}, closeAll: () => {}, back: () => {}, forward: () => {}, reload: (tabId: string) => { reloaded.push(tabId); }, setBounds: () => {}, setVisible: async () => null,
    onState: () => () => {},
    list: {
      get: async () => list,
      dispatch: async (intent: DesktopWebPreviewTabIntent) => { intents.push(intent); return list; },
      present: () => {},
      onChange: () => () => {},
      ...(pins ? { pins: true as const } : null),
    },
  } satisfies DesktopWebPreviewTabsBridge;
  return { bridge, intents, reloaded };
}

function Strip({ bridge, conversationId = "c1" }: { bridge: DesktopWebPreviewTabsBridge; conversationId?: string }) {
  const browser = useBrowserTabsStore((s) => browserOf(s, conversationId));
  if (!browser) return null;
  return <BrowserTabStrip bridge={bridge} conversationId={conversationId} tabs={browser.tabs} activeId={browser.activeId} tabsShown={browser.tabs.length} measureFront={() => {}} />;
}

async function strip(pins = true, conversationId = "c1", list = LIST) {
  const fake = shell(pins, list);
  mirrorBrowserTabsList(fake.bridge.list, "user-1");
  render(<TestIntlProvider><Strip bridge={fake.bridge} conversationId={conversationId} /></TestIntlProvider>);
  await screen.findAllByTestId("web-preview-tab-slot");
  return fake;
}

const slot = (tabId: string) => document.querySelector<HTMLElement>(`[data-tab-id="${tabId}"]`)!;
/** Opens the tab's menu as a right-click does, and as the context-menu key or Shift+F10 on the focused tab does: the browser's `contextmenu` on the tab. */
async function menuOf(tabId: string) {
  fireEvent.contextMenu(slot(tabId).querySelector('[role="tab"]')!);
  return screen.findByTestId("web-preview-tab-menu");
}
const item = (name: string) => screen.getByTestId(`web-preview-tab-menu-${name}`);
const disabled = (name: string) => item(name).getAttribute("aria-disabled") === "true" || item(name).hasAttribute("data-disabled");
const names = () => [...screen.getByTestId("web-preview-tab-menu").querySelectorAll('[role="menuitem"]')].map((each) => each.textContent);

beforeEach(() => {
  mirrorBrowserTabsList(null, null);
  useBrowserTabsStore.setState({ browsers: {}, pinnedOnly: null, addressFocus: {} });
});
afterEach(cleanup);

it("pinned tabs lead the row with the icon alone: the title is the tab's name, and there is no close button on it", async () => {
  await strip();
  const slots = screen.getAllByTestId("web-preview-tab-slot").map((each) => each.getAttribute("data-tab-id"));
  expect(slots).toEqual(["p1", "p2", "a", "b", "c", "empty"]);
  for (const id of ["p1", "p2"]) {
    const pinned = slot(id);
    expect(pinned.querySelector('[data-testid="web-preview-tab-label"]')).toBeNull();
    expect(pinned.querySelector('[data-testid="web-preview-tab-close"]')).toBeNull();
    expect(pinned.querySelector('[role="tab"]')!.getAttribute("aria-label")).toBe(`Page ${id}, pinned`);
    expect(pinned.querySelector('[role="tab"]')!.hasAttribute("data-pinned")).toBe(true);
  }
  expect(slot("a").querySelector('[data-testid="web-preview-tab-close"]')).not.toBeNull();
  expect(slot("a").textContent).toContain("Page a");
});

it("the menu of a tab: the page's actions, a line, then the closing ones; each sends its intent for that tab", async () => {
  const { intents, reloaded } = await strip();
  const menu = await menuOf("a");
  expect(menu.getAttribute("aria-label")).toBe("Page a");
  expect(names()).toEqual(["Reload", "Duplicate", "Pin tab", "Open in browser", "Copy link address", "Close", "Close other tabs", "Close tabs to the right"]);
  expect(menu.querySelectorAll('[role="separator"]').length).toBe(1);
  expect(["reload", "duplicate", "pin", "open", "copy", "close", "close-others", "close-right"].filter(disabled)).toEqual([]);
  fireEvent.click(item("pin"));
  await waitFor(() => expect(intents).toEqual([{ type: "pin", owner: "c1", tabId: "a" }]));
  for (const [name, type] of [["duplicate", "duplicate"], ["close", "close-tab"], ["close-others", "close-others"], ["close-right", "close-right"]] as const) {
    await menuOf("b");
    fireEvent.click(item(name));
    await waitFor(() => expect(intents.at(-1)).toEqual({ type, owner: "c1", tabId: "b" }));
  }
  await menuOf("c");
  fireEvent.click(item("reload"));
  expect(reloaded).toEqual(["c"]);
});

it("Open in browser hands the address to the system browser, and Copy link address copies it", async () => {
  await strip();
  const opened = vi.spyOn(window, "open").mockReturnValue(null);
  const written: string[] = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { written.push(text); } } });
  await menuOf("c");
  fireEvent.click(item("open"));
  expect(opened).toHaveBeenCalledWith("https://example.com/c", "_blank", "noopener,noreferrer");
  await menuOf("c");
  fireEvent.click(item("copy"));
  await waitFor(() => expect(written).toEqual(["https://example.com/c"]));
  opened.mockRestore();
});

it("a pinned tab's menu says Unpin tab; closing others or to the right from it is offered while the conversation has tabs of its own", async () => {
  const { intents } = await strip();
  await menuOf("p2");
  expect(names()).toContain("Unpin tab");
  expect(names()).not.toContain("Pin tab");
  expect(["close-others", "close-right"].filter(disabled)).toEqual([]);
  fireEvent.click(item("pin"));
  await waitFor(() => expect(intents).toEqual([{ type: "unpin", owner: "c1", tabId: "p2" }]));
});

it("an item that would do nothing is disabled: the page's actions on an empty tab, closing to the right of the last tab, closing others with no other own tab", async () => {
  await strip();
  await menuOf("empty");
  expect(["reload", "duplicate", "pin", "open", "copy", "close", "close-others", "close-right"].filter(disabled)).toEqual(["reload", "duplicate", "open", "copy", "close-right"]);
  cleanup();
  // Beside c2: one own tab after the two pinned ones.
  await strip(true, "c2");
  await menuOf("x");
  expect(["close-others", "close-right", "pin", "close"].filter(disabled)).toEqual(["close-others", "close-right"]);
  cleanup();
  // Beside a conversation with only the pinned tabs.
  await strip(true, "c9");
  await menuOf("p1");
  expect(["close-others", "close-right", "pin", "close"].filter(disabled)).toEqual(["close-others", "close-right"]);
});

it("on a shell from before pinned tabs the menu offers only what that shell can do: no Pin tab, Duplicate or closing of several", async () => {
  const { intents } = await strip(false, "c1", { browsers: LIST.browsers });
  await menuOf("a");
  expect(names()).toEqual(["Reload", "Open in browser", "Copy link address", "Close"]);
  fireEvent.click(item("close"));
  await waitFor(() => expect(intents).toEqual([{ type: "close-tab", owner: "c1", tabId: "a" }]));
});
