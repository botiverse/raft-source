import { beforeEach, describe, expect, it } from "vitest";
import type { DesktopWebPreviewInUse, DesktopWebPreviewTabList, DesktopWebPreviewTabsBridge } from "@botiverse/raft-shared";

import { BROWSER_MARKABLE_DELAY_MS, browserInUseByOwner, setBrowserMarkable, useBrowserInUseStore } from "../src/features/webPreview/browserInUseStore";
import { mirrorBrowserTabsList, useBrowserTabsStore } from "../src/features/webPreview/browserTabsStore";
import { attachBrowserViews } from "../src/features/webPreview/browserViews";

// What the built-in browser's kept pages of each conversation left do (Raft Desktop, `tabs.list.onInUse`): the
// store the sidebar marks rows from, followed for the tab list mirror's life, and the web saying it shows the mark
// (`present` with `inUseMarks`), and which conversations it can mark (`setMarkable`), so the shell keeps a page
// using a device only for those.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const markableSettled = () => new Promise<void>((resolve) => setTimeout(resolve, BROWSER_MARKABLE_DELAY_MS + 20));
const byOwner = () => useBrowserInUseStore.getState().byOwner;

function fakeShell(options: { inUse?: boolean } = {}) {
  const shell = {
    inUse: null as ((inUse: DesktopWebPreviewInUse[]) => void) | null,
    presented: [] as [string | null, boolean, { backgroundMedia?: boolean; inUseMarks?: boolean } | undefined][],
    asked: 0,
    markable: [] as string[][],
  };
  const list: DesktopWebPreviewTabList = { browsers: [{ owner: "c1", activeId: "m1", tabs: [{ id: "m1", url: "https://example.com/", title: "A", loading: false }] }] };
  const tabs = {
    open: () => {}, activate: () => {}, close: () => {}, closeAll: () => {}, back: () => {}, forward: () => {}, reload: () => {},
    setBounds: () => {}, setVisible: async () => null, onState: () => () => {}, setMuted: () => {},
    list: {
      get: async () => { shell.asked += 1; return list; },
      dispatch: async () => list,
      present: (owner: string | null, showing: boolean, presentOptions?: { backgroundMedia?: boolean; inUseMarks?: boolean }) => { shell.presented.push([owner, showing, presentOptions]); },
      onChange: () => () => {},
      ...(options.inUse === false ? null : {
        onInUse: (handler: (inUse: DesktopWebPreviewInUse[]) => void) => { shell.inUse = handler; return () => { shell.inUse = null; }; },
        setMarkable: (owners: string[]) => { shell.markable.push(owners); },
      }),
    },
  } satisfies DesktopWebPreviewTabsBridge;
  return { shell, tabs };
}

beforeEach(() => {
  mirrorBrowserTabsList(null, null);
  useBrowserTabsStore.setState({ browsers: {}, addressFocus: {} });
  useBrowserInUseStore.setState({ byOwner: {}, markable: null });
});

describe("what the kept pages of each conversation do", () => {
  it("is kept per conversation, checked: only one that does something; sound heard is not also muted; devices in a fixed order", () => {
    const next = browserInUseByOwner([
      { owner: "c1", audible: false, muted: false, media: ["camera", "microphone", "speaker"] },
      { owner: "c2", audible: true, muted: true, media: [] },
      { owner: "c3", audible: false, muted: false, media: [] },
      { owner: "", audible: true, muted: false, media: [] },
      null,
    ], {});
    expect(next).toEqual({
      c1: { audible: false, muted: false, media: ["microphone", "camera"] },
      c2: { audible: true, muted: false, media: [] },
    });
    expect(browserInUseByOwner("not a list", next)).toEqual({});
  });

  it("keeps each unchanged conversation's object, and the whole record where nothing changed (the rows are memo'd)", () => {
    const first = browserInUseByOwner([{ owner: "c1", audible: true, muted: false, media: [] }, { owner: "c2", audible: false, muted: false, media: ["microphone"] }], {});
    expect(browserInUseByOwner([{ owner: "c2", audible: false, muted: false, media: ["microphone"] }, { owner: "c1", audible: true, muted: false, media: [] }], first)).toBe(first);
    const next = browserInUseByOwner([{ owner: "c1", audible: false, muted: true, media: [] }, { owner: "c2", audible: false, muted: false, media: ["microphone"] }], first);
    expect(next).not.toBe(first);
    expect(next.c2).toBe(first.c2);
    expect(next.c1).toEqual({ audible: false, muted: true, media: [] });
  });

  it("follows the shell for the mirror's life, and is forgotten with it (a sign-out, another account)", async () => {
    const { shell, tabs } = fakeShell();
    mirrorBrowserTabsList(tabs.list, "user-1");
    await settle();
    shell.inUse!([{ owner: "c1", audible: false, muted: false, media: ["microphone"] }]);
    expect(byOwner()).toEqual({ c1: { audible: false, muted: false, media: ["microphone"] } });
    const handler = shell.inUse!;
    mirrorBrowserTabsList(tabs.list, "user-2");
    expect(byOwner()).toEqual({});
    // A late word on the mirror before is nobody's.
    handler([{ owner: "c9", audible: true, muted: false, media: [] }]);
    expect(byOwner()).toEqual({});
    mirrorBrowserTabsList(null, null);
    expect(shell.inUse).toBeNull();
    expect(byOwner()).toEqual({});
  });

  it("the web says it shows the mark only to a shell that says what kept pages do; a shell from before is told nothing new", async () => {
    const marked = fakeShell();
    mirrorBrowserTabsList(marked.tabs.list, "user-1");
    await settle();
    const detach = attachBrowserViews(marked.tabs, "c1");
    expect(marked.shell.presented.at(-1)).toEqual(["c1", false, { backgroundMedia: true, inUseMarks: true }]);
    detach();
    // Leaving every conversation keeps saying it: a page using a device stays kept.
    expect(marked.shell.presented.at(-1)).toEqual([null, false, { backgroundMedia: true, inUseMarks: true }]);

    mirrorBrowserTabsList(null, null);
    const before = fakeShell({ inUse: false });
    mirrorBrowserTabsList(before.tabs.list, "user-1");
    await settle();
    const detachBefore = attachBrowserViews(before.tabs, "c1");
    expect(before.shell.presented.at(-1)).toEqual(["c1", false, { backgroundMedia: true, inUseMarks: false }]);
    detachBefore();
  });

  it("the sidebar's markable conversations are kept sorted, once each, and only a change is a new list", () => {
    setBrowserMarkable(["c2", "c1", "c2"]);
    const first = useBrowserInUseStore.getState().markable;
    expect(first).toEqual(["c1", "c2"]);
    setBrowserMarkable(["c1", "c2"]);
    expect(useBrowserInUseStore.getState().markable).toBe(first);
    setBrowserMarkable([]);
    expect(useBrowserInUseStore.getState().markable).toEqual([]);
  });

  it("hands the shell the markable list once the list is had and after each change, the last of a burst, never before the sidebar said", async () => {
    const { shell, tabs } = fakeShell();
    mirrorBrowserTabsList(tabs.list, "user-1");
    await settle();
    await markableSettled();
    expect(shell.markable, "the sidebar has not said: nothing (the list before stands)").toEqual([]);
    setBrowserMarkable(["c1"]);
    setBrowserMarkable(["c1", "c2"]);
    setBrowserMarkable(["c1", "c2", "c3"]);
    await markableSettled();
    expect(shell.markable, "a burst: its last").toEqual([["c1", "c2", "c3"]]);
    // Another server on screen: its rows only.
    setBrowserMarkable(["s2-c1"]);
    await markableSettled();
    expect(shell.markable.at(-1)).toEqual(["s2-c1"]);
    // A DM closed (its row goes): the list without it.
    setBrowserMarkable([]);
    await markableSettled();
    expect(shell.markable.at(-1)).toEqual([]);
    // Another account: the shell starts it from none, and hears the list again after its `get`.
    const sent = shell.markable.length;
    setBrowserMarkable(["c1"]);
    mirrorBrowserTabsList(tabs.list, "user-2");
    await settle();
    await markableSettled();
    expect(shell.asked).toBe(2);
    expect(shell.markable.slice(sent)).toEqual([["c1"]]);
    // The mirror ended: nothing more.
    mirrorBrowserTabsList(null, null);
    setBrowserMarkable(["c9"]);
    await markableSettled();
    expect(shell.markable.slice(sent)).toEqual([["c1"]]);
  });
});
