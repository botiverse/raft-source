// DOM nodes never go to node:assert as values (tests/assertionNullCompareGuard.test.ts).
// The built-in browser's refusal notice (BrowserBlockedNotice) is Raft's own words and button. Where the button
// opens an address the PAGE chose (a Raft page: Open in Raft; another application's link: Open link), the notice
// shows that address before it is pressed (Tenny, PR #14758):
// - a web address: its host, never cut and never the user:password@ before it, then path, query and fragment, cut;
// - another application's link: its scheme, then its target, cut;
// - the whole address on hover (title); always text, never markup, and only ASCII as WHATWG serializes it;
// - Raft's sign-in and a pop-up show none: their button opens the tab's own page, not the page-chosen address;
// - `storage` (the shell makes no page: the site data an earlier account left could not be cleared) says so in its
//   own words, shows no address, and its button opens the tab's address in the person's browser.
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DesktopWebPreviewBlocked } from "@botiverse/raft-shared";

import { TestIntlProvider } from "./helpers/intl";
import { BrowserBlockedNotice } from "../src/features/webPreview/BrowserBlockedNotice";
import type { BrowserTab } from "../src/features/webPreview/browserTabsStore";
import { BLOCKED_ADDRESS_REST_MAX, blockedAddressParts } from "../src/features/webPreview/webPreviewAddress";

const PAGE = "https://example.com/page";
let opened: string[] = [];
const realOpen = window.open;

beforeEach(() => {
  opened = [];
  window.open = ((url?: string | URL) => { opened.push(String(url)); return null; }) as typeof window.open;
});
afterEach(() => {
  cleanup();
  window.open = realOpen;
});

function show(url: string, reason: DesktopWebPreviewBlocked["reason"]) {
  const tab = { id: "t1", url: PAGE } as BrowserTab;
  render(<TestIntlProvider><BrowserBlockedNotice conversationId="c1" tab={tab} blocked={{ url, reason, at: 1 }} /></TestIntlProvider>);
  const address = screen.queryByTestId("web-preview-blocked-address");
  return { address, action: screen.queryByTestId("web-preview-blocked-action") };
}

test("the address a page chose: host whole, the rest cut, ASCII only", () => {
  assert.deepEqual(blockedAddressParts("https://app.raft.build/s/x/channel/y?a=1#b"), { lead: "app.raft.build", rest: "/s/x/channel/y?a=1#b", full: "https://app.raft.build/s/x/channel/y?a=1#b" });
  assert.deepEqual(blockedAddressParts("https://app.raft.build/"), { lead: "app.raft.build", rest: "", full: "https://app.raft.build/" });
  const long = `https://app.raft.build:8443/${"p".repeat(200)}`;
  const parts = blockedAddressParts(long)!;
  assert.equal(parts.lead, "app.raft.build:8443");
  assert.equal(parts.rest, `/${"p".repeat(BLOCKED_ADDRESS_REST_MAX - 1)}…`);
  assert.equal(parts.full, long);
  // The host is the real one, not what stands before an @.
  assert.equal(blockedAddressParts("https://accounts.example.com@app.raft.build/x")!.lead, "app.raft.build");
  assert.deepEqual(blockedAddressParts("mailto:someone@example.com"), { lead: "mailto:", rest: "someone@example.com", full: "mailto:someone@example.com" });
  assert.equal(blockedAddressParts(`mailto:${"a".repeat(100)}@example.com`)!.rest, `${"a".repeat(BLOCKED_ADDRESS_REST_MAX)}…`);
  // A right-to-left override or a look-alike letter of the page's choosing never reaches the notice as such.
  for (const tricky of ["https://app.raft.build/‮gnp.exe", "mailto:‮moc.elpmaxe@x", "https://аpp.raft.build/x"]) {
    const { lead, rest, full } = blockedAddressParts(tricky)!;
    assert.match(`${lead}${rest}${full}`, /^[\x21-\x7E…]*$/, tricky);
  }
  assert.equal(blockedAddressParts("not an address"), null);
});

test("a Raft page: the notice shows where Open in Raft goes, the whole address on hover, and opens that", () => {
  const url = `https://app.raft.build/s/x/channel/${"y".repeat(80)}`;
  const { address, action } = show(url, "raft");
  assert.ok(address !== null, "the address shows");
  assert.equal(address.textContent, `app.raft.build/s/x/channel/${"y".repeat(BLOCKED_ADDRESS_REST_MAX - "/s/x/channel/".length)}…`);
  assert.equal(address.getAttribute("title"), url);
  fireEvent.click(action!);
  assert.deepEqual(opened, [url]);
});

test("another application's link: the scheme and its target; markup in the address stays text", () => {
  const markup = "mailto:<img src=x onerror=alert(1)>@example.com";
  const { address, action } = show(markup, "scheme");
  assert.ok(address !== null, "the address shows");
  assert.equal(address.textContent, markup);
  assert.equal(address.getAttribute("title"), markup);
  assert.equal(address.querySelectorAll("img").length, 0);
  assert.equal(address.querySelectorAll("*").length, 2, "two spans of text: the scheme and its target");
  assert.ok(action !== null, "mailto is a scheme Raft hands out");
  cleanup();
  // A scheme Raft doesn't hand out: the address still shows, with no button.
  const other = show("zoommtg://zoom.us/join?confno=1", "scheme");
  assert.equal(other.address?.textContent, "zoommtg://zoom.us/join?confno=1");
  assert.ok(other.action === null, "no button");
});

test("Raft's sign-in and a pop-up: no page-chosen address, and the button opens the tab's own page", () => {
  for (const [url, reason] of [["https://app.raft.build/login-with-raft/setup?flow=oidc", "raft-sign-in"], ["https://evil.example/next", "popup"]] as const) {
    opened = [];
    const { address, action } = show(url, reason);
    assert.ok(address === null, `${reason}: no address`);
    fireEvent.click(action!);
    assert.deepEqual(opened, [PAGE], reason);
    cleanup();
  }
});

test("no page because the browser's saved site data could not be cleared: its own words, no address, Open in browser for the tab's address", () => {
  const { address, action } = show(PAGE, "storage");
  assert.equal(screen.getByTestId("web-preview-blocked").getAttribute("data-reason"), "storage");
  const words = screen.getByTestId("web-preview-blocked-text").textContent ?? "";
  assert.match(words, /couldn't be cleared/);
  assert.match(words, /Restart Raft/);
  assert.ok(address === null, "no address");
  fireEvent.click(action!);
  assert.deepEqual(opened, [PAGE]);
});
