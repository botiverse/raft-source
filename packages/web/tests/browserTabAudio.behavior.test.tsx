// The speaker on a tab of the built-in browser (#proj-workspace:#299, as Chrome's): shown while the page plays sound
// or the tab is muted, and a click (or the tab's menu) mutes and unmutes it. Needs a DOM: run with RAFT_WEB_TEST_DOM=1.
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { DesktopWebPreviewTabList, DesktopWebPreviewTabsBridge, DesktopWebPreviewTabState } from "@botiverse/raft-shared";

import { TestIntlProvider } from "./helpers/intl";
import { BrowserTabStrip } from "../src/features/webPreview/BrowserTabStrip";
import { browserOf, mirrorBrowserTabsList, useBrowserTabsStore } from "../src/features/webPreview/browserTabsStore";

const tab = (id: string) => ({ id, url: `https://example.com/${id}`, title: `Page ${id}`, loading: false });
const LIST: DesktopWebPreviewTabList = {
  browsers: [{ owner: "c1", activeId: "b", tabs: [tab("a"), tab("b")] }],
  pinned: { tabs: [tab("p1")], activeId: null, open: true },
};

function shell(canMute: boolean) {
  const mutes: [string, boolean][] = [];
  const bridge: DesktopWebPreviewTabsBridge = {
    open: () => {}, activate: () => {}, close: () => {}, closeAll: () => {}, back: () => {}, forward: () => {}, reload: () => {}, setBounds: () => {}, setVisible: async () => null,
    onState: () => () => {},
    ...(canMute ? { setMuted: (tabId: string, muted: boolean) => { mutes.push([tabId, muted]); } } : null),
    list: { get: async () => LIST, dispatch: async () => LIST, present: () => {}, onChange: () => () => {}, pins: true },
  };
  return { bridge, mutes };
}

function Strip({ bridge }: { bridge: DesktopWebPreviewTabsBridge }) {
  const browser = useBrowserTabsStore((s) => browserOf(s, "c1"));
  if (!browser) return null;
  return <BrowserTabStrip bridge={bridge} conversationId="c1" tabs={browser.tabs} activeId={browser.activeId} tabsShown={browser.tabs.length} measureFront={() => {}} />;
}

async function strip(canMute = true) {
  const fake = shell(canMute);
  mirrorBrowserTabsList(fake.bridge.list!, "user-1");
  render(<TestIntlProvider><Strip bridge={fake.bridge} /></TestIntlProvider>);
  await screen.findAllByTestId("web-preview-tab-slot");
  return fake;
}

/** What the shell reports for the tab's page. */
function report(tabId: string, sound: { audible?: boolean; muted?: boolean }) {
  const state: DesktopWebPreviewTabState = { tabId, url: `https://example.com/${tabId}`, title: `Page ${tabId}`, canGoBack: false, canGoForward: false, loading: false, blocked: null, ...sound };
  act(() => useBrowserTabsStore.getState().applyState("c1", state));
}

const slot = (tabId: string) => document.querySelector<HTMLElement>(`[data-tab-id="${tabId}"]`)!;
const muteOf = (tabId: string) => slot(tabId).querySelector<HTMLButtonElement>('[data-testid="web-preview-tab-mute"]');

beforeEach(() => {
  mirrorBrowserTabsList(null, null);
  useBrowserTabsStore.setState({ browsers: {}, pinnedOnly: null, addressFocus: {} });
});
afterEach(cleanup);

it("a tab whose page plays sound shows a speaker; a click mutes it, and the muted tab's crossed-out speaker unmutes it", async () => {
  const { mutes } = await strip();
  expect(muteOf("a")).toBeNull();
  report("a", { audible: true, muted: false });
  const speaker = muteOf("a")!;
  expect(speaker.getAttribute("aria-label")).toBe("Mute Page a");
  expect(muteOf("b")).toBeNull();
  fireEvent.click(speaker);
  expect(mutes).toEqual([["a", true]]);
  // The tab in front did not change: the click is the speaker's, not the tab's.
  expect(browserOf(useBrowserTabsStore.getState(), "c1")!.activeId).toBe("b");
  report("a", { audible: true, muted: true });
  expect(muteOf("a")!.getAttribute("aria-label")).toBe("Unmute Page a");
  expect(muteOf("a")!.hasAttribute("data-muted")).toBe(true);
  // Muted and silent: the crossed-out speaker stays, as Chrome's, so the tab can be unmuted.
  report("a", { audible: false, muted: true });
  fireEvent.click(muteOf("a")!);
  expect(mutes).toEqual([["a", true], ["a", false]]);
  report("a", { audible: false, muted: false });
  expect(muteOf("a")).toBeNull();
});

it("a shell that cannot mute a tab (or says nothing of sound) shows no speaker", async () => {
  await strip(false);
  report("a", { audible: true, muted: false });
  expect(muteOf("a")).toBeNull();
  cleanup();
  await strip(true);
  report("a", {});
  expect(muteOf("a")).toBeNull();
});

it("the tab's menu mutes and unmutes it; a pinned tab's speaker takes its icon's place", async () => {
  const { mutes } = await strip();
  report("p1", { audible: true, muted: false });
  expect(slot("p1").querySelector('[data-testid="web-preview-tab-speaker"]')!.getAttribute("aria-label")).toBe("Playing audio");
  expect(muteOf("p1")).toBeNull();
  fireEvent.contextMenu(slot("p1").querySelector('[role="tab"]')!);
  fireEvent.click(await screen.findByTestId("web-preview-tab-menu-mute"));
  expect(mutes).toEqual([["p1", true]]);
  report("p1", { audible: true, muted: true });
  expect(slot("p1").querySelector('[data-testid="web-preview-tab-speaker"]')!.getAttribute("aria-label")).toBe("Muted");
});
