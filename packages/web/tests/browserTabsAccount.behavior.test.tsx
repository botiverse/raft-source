// The tab store's mirror of the shell's list follows whoever is signed in (#proj-workspace:#295), not a panel's
// effect: the shell drops the list on every sign-out and hears a page again only once it asks for a list.
// Needs a DOM: run with RAFT_WEB_TEST_DOM=1.
import "./helpers/domSetup";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { DesktopWebPreviewTabIntent, DesktopWebPreviewTabList, DesktopWebPreviewTabsBridge } from "@botiverse/raft-shared";

import { browserTabsListInShell, useBrowserTabsStore } from "../src/features/webPreview/browserTabsStore";
import { useBrowserTabsList } from "../src/features/webPreview/useWebPreview";
import { useAuthStore } from "../src/store/authStore";

const conversation = "c1";
const listed = (revision: number, ...urls: string[]): DesktopWebPreviewTabList => ({
  revision,
  browsers: urls.length === 0 ? [] : [{ owner: conversation, activeId: "m1", tabs: urls.map((url, index) => ({ id: `m${index + 1}`, url, title: "", loading: false })) }],
});

/** A shell that keeps the list as main does: a page is the list's owner from its `get` until a sign-out drops the list. */
function fakeShell() {
  const shell = { now: listed(1, "https://example.com/a"), asked: [] as string[], intents: [] as DesktopWebPreviewTabIntent[], owner: false };
  const none = () => {};
  const tabs = {
    open: none, activate: none, close: none, closeAll: none, back: none, forward: none, reload: none, setBounds: none, setVisible: async () => null,
    onState: () => none,
    onRequest: () => none,
    list: {
      get: async (account: string) => { shell.asked.push(account); shell.owner = true; return shell.now; },
      dispatch: async (intent: DesktopWebPreviewTabIntent) => {
        shell.intents.push(intent);
        if (!shell.owner) throw new Error("web_preview.tab_list_not_owner");
        return shell.now;
      },
      present: none,
      onChange: () => none,
    },
  } satisfies DesktopWebPreviewTabsBridge;
  return { shell, tabs };
}

const settle = () => act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
const user = (id: string | null) => act(() => { useAuthStore.setState({ user: id ? ({ id } as never) : null }); });

afterEach(() => {
  cleanup();
  act(() => { useAuthStore.setState({ user: null }); });
  useBrowserTabsStore.setState({ browsers: {}, addressFocus: {} });
});

it("signed out with the panel unmounted in the same commit, then the same account signs in again: the list is asked for again and the browser works", async () => {
  const { shell, tabs } = fakeShell();
  function Panel() {
    useBrowserTabsList(tabs);
    return null;
  }
  // The panel is there only for someone signed in: the sign-out takes it away in the commit that has no user.
  function App() {
    const signedIn = useAuthStore((state) => state.user !== null);
    return signedIn ? <Panel /> : null;
  }
  user("user-1");
  render(<App />);
  await settle();
  expect(shell.asked).toEqual(["user-1"]);
  expect(Object.keys(useBrowserTabsStore.getState().browsers)).toEqual([conversation]);

  // Sign-out: the shell drops the list (every sign-out does) and no longer holds this page as its owner.
  shell.owner = false;
  shell.now = listed(2);
  user(null);
  expect(browserTabsListInShell()).toBe(false);
  expect(useBrowserTabsStore.getState().browsers).toEqual({});

  user("user-1");
  await settle();
  expect(shell.asked).toEqual(["user-1", "user-1"]);
  // The browser works: a change is an intent the shell takes, and its answer shows.
  shell.now = listed(3, "https://example.com/back");
  act(() => { useBrowserTabsStore.getState().openUrl(conversation, "https://example.com/back"); });
  await settle();
  expect(shell.intents).toEqual([{ type: "open", owner: conversation, url: "https://example.com/back" }]);
  expect(useBrowserTabsStore.getState().browsers[conversation]!.tabs.map((tab) => tab.url)).toEqual(["https://example.com/back"]);
  // No refusal was met on the way (the list was asked for before the intent, not after it).
  expect(shell.asked).toEqual(["user-1", "user-1"]);
});
