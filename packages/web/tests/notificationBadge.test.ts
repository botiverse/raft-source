// The one badge (contract §1.4): Activity unread over every server whose
// level is not none. Web: "(N)" title prefix, dotted favicon, app badge.
// Desktop: setBadgeCount.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import "./helpers/domSetup";
import { render } from "@testing-library/react";
import { createElement } from "react";
import {
  DOTTED_FAVICON_ASSETS,
  computeNotificationBadge,
  currentNotificationBadge,
  desktopBadgeRenderer,
  setFaviconDot,
  startNotificationBadge,
  webBadgeRenderer,
} from "../src/notifications/badge";
import { useNotificationSettingsStore } from "../src/store/notificationSettingsStore";
import { useServerStore } from "../src/store/serverStore";
import { documentTitleWithUnread, setDocumentTitleUnreadCount, useBrowserDocumentTitle } from "../src/utils/browserDocumentTitle";
import type { ServerUnreadSummary } from "../src/utils/serverUnreadSummary";

const initial = { server: useServerStore.getState(), settings: useNotificationSettingsStore.getState() };

afterEach(() => {
  useServerStore.setState(initial.server, true);
  useNotificationSettingsStore.setState(initial.settings, true);
  setDocumentTitleUnreadCount(0);
  document.head.innerHTML = "";
});

const summary = (activityUnreadCount?: number): ServerUnreadSummary => ({
  unreadCount: 99,
  serverPushMuted: false,
  ...(activityUnreadCount === undefined ? {} : { activityUnreadCount }),
});

test("formula: Activity unread summed over servers not set to none; rows without a proven count skipped", () => {
  const levels: Record<string, "all" | "mentions" | "none"> = { a: "all", m: "mentions", n: "none", u: "all" };
  const n = computeNotificationBadge(
    { a: summary(3), m: summary(2), n: summary(50), u: summary(undefined), z: summary(0) },
    (id) => levels[id] ?? "all",
  );
  assert.equal(n, 5, "none excluded, mentions included, a row without activityUnreadCount skipped (not unreadCount)");
  assert.equal(computeNotificationBadge({}, () => "all"), 0);
});

test("from the stores: loaded server levels win, else the legacy server mute", () => {
  useServerStore.setState({
    servers: [{ id: "a", serverPushMuted: false }, { id: "b", serverPushMuted: true }, { id: "c", serverPushMuted: false }],
    serverUnreadCounts: { a: summary(1), b: summary(4), c: summary(2) },
  } as never);
  useNotificationSettingsStore.setState({ serverLevels: {} });
  assert.equal(currentNotificationBadge(), 3, "b muted (legacy) = none");
  useNotificationSettingsStore.setState({ serverLevels: { b: "mentions", c: "none" } });
  assert.equal(currentNotificationBadge(), 5);
});

test("runtime: renders on store changes only when the number changes; disposing renders 0", () => {
  useServerStore.setState({ servers: [{ id: "a" }], serverUnreadCounts: { a: summary(2) } } as never);
  const rendered: number[] = [];
  const stop = startNotificationBadge((n) => rendered.push(n));
  assert.deepEqual(rendered, [2]);
  useServerStore.setState({ serverUnreadCounts: { a: summary(2) } } as never);
  assert.deepEqual(rendered, [2], "same number: no render");
  useServerStore.setState({ serverUnreadCounts: { a: summary(7) } } as never);
  useNotificationSettingsStore.setState({ serverLevels: { a: "none" } });
  assert.deepEqual(rendered, [2, 7, 0]);
  useNotificationSettingsStore.setState({ serverLevels: { a: "all" } });
  stop();
  assert.deepEqual(rendered, [2, 7, 0, 7, 0]);
  useServerStore.setState({ serverUnreadCounts: { a: summary(9) } } as never);
  assert.equal(rendered.length, 5, "stopped");
});

test("desktop: setBadgeCount(N)", () => {
  const counts: number[] = [];
  useServerStore.setState({ servers: [{ id: "a" }], serverUnreadCounts: { a: summary(4) } } as never);
  const stop = startNotificationBadge(desktopBadgeRenderer({ setBadgeCount: (n) => counts.push(n) }));
  stop();
  assert.deepEqual(counts, [4, 0]);
});

function TitleHarness({ title }: { title: string }) {
  useBrowserDocumentTitle(title);
  return null;
}

test("title: (N) before the route title, kept across route changes, removed at 0", () => {
  assert.equal(documentTitleWithUnread("Raft", 0), "Raft");
  assert.equal(documentTitleWithUnread("#eng | Acme | Raft", 12), "(12) #eng | Acme | Raft");
  const view = render(createElement(TitleHarness, { title: "#eng | Acme | Raft" }));
  assert.equal(document.title, "#eng | Acme | Raft");
  setDocumentTitleUnreadCount(3);
  assert.equal(document.title, "(3) #eng | Acme | Raft");
  view.rerender(createElement(TitleHarness, { title: "#ops | Acme | Raft" }));
  assert.equal(document.title, "(3) #ops | Acme | Raft");
  setDocumentTitleUnreadCount(0);
  assert.equal(document.title, "#ops | Acme | Raft");
  setDocumentTitleUnreadCount(1);
  view.unmount();
  assert.equal(document.title, "(1) Raft", "the generic title keeps the prefix");
});

function installIcons() {
  document.head.innerHTML = [
    '<link rel="icon" href="/favicon.ico?v=1" sizes="any">',
    '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png?v=1">',
    '<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png?v=1">',
    '<link rel="icon" type="image/png" sizes="192x192" href="/android-chrome-192x192.png?v=1">',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
  ].join("");
}
const icons = () => [...document.querySelectorAll("link")].map((l) => `${l.getAttribute("rel")} ${l.getAttribute("href")} ${l.getAttribute("type") ?? "-"}`);

test("favicon: every icon link swaps to its dotted variant and back exactly", () => {
  installIcons();
  const original = icons();
  setFaviconDot(document, true);
  assert.deepEqual(icons(), [
    "icon /favicon-dot-32x32.png image/png",
    "icon /favicon-dot-32x32.png image/png",
    "icon /favicon-dot-16x16.png image/png",
    "icon /favicon-dot-192x192.png image/png",
    "apple-touch-icon /apple-touch-icon.png -",
  ]);
  setFaviconDot(document, true);
  setFaviconDot(document, false);
  assert.deepEqual(icons(), original, "restored, including the .ico link without a type");
  for (const asset of DOTTED_FAVICON_ASSETS) assert.ok(existsSync(resolve(import.meta.dirname, "../public", asset.slice(1))), asset);
});

test("web renderer: title, favicon and the app badge together", async () => {
  installIcons();
  const calls: string[] = [];
  const nav = {
    setAppBadge: async (n?: number) => { calls.push(`set ${n}`); },
    clearAppBadge: async () => { calls.push("clear"); },
  };
  const renderBadge = webBadgeRenderer({ document, navigator: nav });
  renderBadge(4);
  assert.equal(document.title.startsWith("(4) "), true);
  assert.ok(icons()[0]!.includes("favicon-dot"));
  renderBadge(0);
  assert.equal(document.title.startsWith("("), false);
  assert.ok(!icons()[0]!.includes("favicon-dot"));
  assert.deepEqual(calls, ["set 4", "clear"]);
  // No Badging API, or a rejecting one: harmless.
  webBadgeRenderer({ document, navigator: {} })(2);
  webBadgeRenderer({ document, navigator: { setAppBadge: () => Promise.reject(new Error("not installed")) } })(3);
  await new Promise((r) => setTimeout(r, 0));
});
