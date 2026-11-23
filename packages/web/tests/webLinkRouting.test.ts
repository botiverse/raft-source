import { beforeEach, describe, expect, it } from "vitest";

import { BROWSER_MAX_TABS, browserTabBlocked, useBrowserTabsStore } from "../src/features/webPreview/browserTabsStore";
import { linkIntentOf, routeShellLink } from "../src/features/webPreview/webLinkRouting";
import { webPreviewTarget } from "../src/features/webPreview/webPreviewStore";

// Raft's own UI's side of the link router (#proj-workspace:#293): what a pointer event on a content link asks for,
// and what the shared table answers for it. The table itself is packages/shared linkRouter.test.ts.
const event = (type: string, button: number, keys: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey" | "altKey", boolean>> = {}) =>
  ({ type, button, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...keys });

describe("linkIntentOf", () => {
  it.each([
    ["a plain click", event("click", 0), "plain"],
    ["Ctrl-click", event("click", 0, { ctrlKey: true }), "new-tab"],
    ["Cmd-click", event("click", 0, { metaKey: true }), "new-tab"],
    ["a middle click", event("auxclick", 1), "new-tab"],
    ["Shift-click", event("click", 0, { shiftKey: true }), "new-window"],
    ["Alt-click (the browser's own)", event("click", 0, { altKey: true }), null],
    ["a right click", event("auxclick", 2), null],
    ["another event", event("mousedown", 0), null],
  ])("%s", (_name, input, intent) => {
    expect(linkIntentOf(input)).toBe(intent);
  });
});

describe("routeShellLink", () => {
  const raft = ["app.example.test"];
  const kind = (href: string, intent: "plain" | "new-tab", preference: "beside" | "browser" | null, browser = true) => {
    const outcome = routeShellLink(href, intent, preference, raft, browser);
    return outcome.kind === "browser-tab" ? outcome.where : outcome.kind;
  };

  it("follows the person's choice for a page outside Raft, and asks once before it is made", () => {
    expect(kind("https://example.com/", "plain", "beside")).toBe("new-foreground");
    expect(kind("https://example.com/", "plain", "browser")).toBe("default");
    expect(kind("https://example.com/", "plain", null)).toBe("ask-first");
    expect(kind("https://example.com/", "new-tab", "beside")).toBe("new-background");
  });

  it("leaves Raft's own pages, other applications' links and a host without the browser as they were", () => {
    expect(kind("https://app.example.test/s/x/channel/y", "plain", "beside")).toBe("default");
    expect(kind("mailto:a@example.com", "plain", "beside")).toBe("default");
    expect(kind("https://example.com/", "plain", "beside", false)).toBe("default");
  });

  it("takes a Raft host with the trailing dots of a fully-qualified name for Raft's own, and an outside one for outside", () => {
    for (const href of ["https://app.example.test./s/x/channel/y", "https://APP.EXAMPLE.TEST./", "https://app.example.test../", "https://app.raft.build./x", "https://APP.RAFT.BUILD./", "https://app.raft.build../"]) {
      expect(kind(href, "plain", "beside"), href).toBe("default");
      expect(webPreviewTarget(href, raft), href).toBeNull();
    }
    expect(kind("https://example.com./", "plain", "beside")).toBe("new-foreground");
    expect(webPreviewTarget("https://example.com./", raft)?.href).toBe("https://example.com./");
  });
});

describe("openUrl: the tab that shows the link (a shell that keeps no list)", () => {
  const conversation = "c1";
  const link = "https://example.com/a";
  const store = () => useBrowserTabsStore.getState();
  const labels = () => store().browsers[conversation]!.tabs.map((tab) => `${tab.id === store().browsers[conversation]!.activeId ? "*" : ""}${tab.url}`);
  const report = (url: string, loading: boolean) => store().applyState(conversation, { tabId: store().browsers[conversation]!.tabs[0]!.id, url, title: "", canGoBack: false, canGoForward: false, loading });
  beforeEach(() => {
    useBrowserTabsStore.setState({ browsers: {} });
    store().openUrl(conversation, link);
    store().openUrl(conversation, "https://example.com/b");
  });

  // As a shell reports a tab: on did-start-loading (the address before, loading), each commit, and did-stop-loading.
  it("comes to the front while it is on the link, or still on the load the link asked for (redirected by the server or a script)", () => {
    store().openUrl(conversation, link);
    expect(labels()).toEqual([`*${link}`, "https://example.com/b"]);
    // A report of the page before the load started is not the load stopping.
    report("about:blank", false);
    report("about:blank", true);
    report(link, true);
    // The shortener's page sends it on by script before it stops: still the asked load.
    report("https://sso.example/hop", true);
    report("https://example.com/landed", true);
    report("https://example.com/landed", false);
    store().openUrl(conversation, "https://example.com/b");
    store().openUrl(conversation, link);
    expect(labels()).toEqual(["*https://example.com/landed", "https://example.com/b"]);
  });

  it("is a new tab once the page went on to another address after that load stopped", () => {
    report("about:blank", true);
    report("https://example.com/landed", true);
    report("https://example.com/landed", false);
    // A link in the page: did-start-loading still at the address before, then the new one, then the stop.
    report("https://example.com/landed", true);
    report("https://example.com/next", true);
    report("https://example.com/next", false);
    store().openUrl(conversation, link);
    expect(labels()).toEqual(["https://example.com/next", "https://example.com/b", `*${link}`]);
  });
});

describe("openUrlInTab: a tab a page or a new-tab click asked for", () => {
  const conversation = "c1";
  const store = () => useBrowserTabsStore.getState();
  const labels = () => store().browsers[conversation]!.tabs.map((tab) => `${tab.id === store().browsers[conversation]!.activeId ? "*" : ""}${tab.url}`);
  beforeEach(() => {
    useBrowserTabsStore.setState({ browsers: {} });
    store().openUrl(conversation, "https://example.com/a");
    store().openUrl(conversation, "https://example.com/b");
    store().activate(conversation, store().browsers[conversation]!.tabs[0]!.id);
  });

  it("stands after the tab that asked, behind it when in the background", () => {
    const opener = store().browsers[conversation]!.tabs[0]!.id;
    expect(store().openUrlInTab(conversation, "https://example.com/c", { background: true, afterTabId: opener })).toBe(true);
    expect(labels()).toEqual(["*https://example.com/a", "https://example.com/c", "https://example.com/b"]);
  });

  it("comes to the front otherwise, and is a new tab even for an address another tab shows", () => {
    expect(store().openUrlInTab(conversation, "https://example.com/b")).toBe(true);
    expect(labels()).toEqual(["https://example.com/a", "https://example.com/b", "*https://example.com/b"]);
  });

  it("opens nothing at the cap, with no browser, or for an address that isn't a web page", () => {
    for (let index = 2; index < BROWSER_MAX_TABS; index += 1) store().openUrlInTab(conversation, `https://example.com/${index}`, { background: true });
    expect(store().openUrlInTab(conversation, "https://example.com/more")).toBe(false);
    expect(store().openUrlInTab("nobody", "https://example.com/")).toBe(false);
    useBrowserTabsStore.setState({ browsers: {} });
    store().openUrl(conversation, "https://example.com/a");
    expect(store().openUrlInTab(conversation, "javascript:alert(1)")).toBe(false);
  });
});

describe("a tab's refusal notice", () => {
  it("is read only when well formed", () => {
    expect(browserTabBlocked({ url: "https://app.raft.build/x", reason: "raft", at: 5 })).toEqual({ url: "https://app.raft.build/x", reason: "raft", at: 5 });
    // The shell's own refusal to make a page (its storage could not be emptied) is one of them.
    expect(browserTabBlocked({ url: "https://example.com/", reason: "storage", at: 6 })).toEqual({ url: "https://example.com/", reason: "storage", at: 6 });
    // A download handed to the system browser (#292): its file name kept (download only), cut to 200 characters.
    expect(browserTabBlocked({ url: "https://example.com/r.pdf", reason: "download", file: " r.pdf ", at: 7 })).toEqual({ url: "https://example.com/r.pdf", reason: "download", file: "r.pdf", at: 7 });
    expect(browserTabBlocked({ url: "https://example.com/r", reason: "download", at: 7 })).toEqual({ url: "https://example.com/r", reason: "download", at: 7 });
    expect(browserTabBlocked({ url: "https://example.com/r", reason: "download", file: "x".repeat(300), at: 7 })!.file).toHaveLength(200);
    expect(browserTabBlocked({ url: "mailto:a@b.c", reason: "scheme", file: "ignored", at: 8 })).toEqual({ url: "mailto:a@b.c", reason: "scheme", at: 8 });
    for (const value of [null, undefined, "raft", { url: 1, reason: "raft", at: 5 }, { url: "x", reason: "other", at: 5 }, { url: "x", reason: "raft" }]) expect(browserTabBlocked(value)).toBeNull();
  });

  it("is shown until dismissed, and again for the next refusal", () => {
    useBrowserTabsStore.setState({ browsers: {} });
    const store = () => useBrowserTabsStore.getState();
    store().openUrl("c1", "https://example.com/a");
    const tab = () => store().browsers.c1!.tabs[0]!;
    const state = (at: number | null) => ({ tabId: tab().id, url: "https://example.com/a", title: "A", canGoBack: false, canGoForward: false, loading: false, blocked: at === null ? null : { url: "https://app.raft.build/x", reason: "raft" as const, at } });
    const shown = () => tab().blocked !== null && tab().blocked!.at !== tab().blockedDismissedAt;
    store().applyState("c1", state(10));
    expect(shown()).toBe(true);
    store().dismissBlocked("c1", tab().id);
    expect(shown()).toBe(false);
    store().applyState("c1", state(20));
    expect(shown()).toBe(true);
    store().applyState("c1", state(null));
    expect(shown()).toBe(false);
  });
});
