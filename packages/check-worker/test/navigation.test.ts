import assert from "node:assert/strict";
import test from "node:test";

import { createNavigationGuard, type GuardedRequest } from "../src/navigation";
import { CONTENT_ORIGIN, TICKET_URL } from "./fakes";

/**
 * The check tab's request guard (src/navigation.ts; isolation condition 2): the entry goes, once,
 * with its same-origin redirects; every other top-level navigation is refused, off the content
 * origin or on it; subresources and subframes go (the page's CSP decides those).
 */

const nav = (url: string, overrides: Partial<GuardedRequest> = {}): GuardedRequest => ({ url, isNavigation: true, isMainFrame: true, redirectedFrom: null, ...overrides });

test("the entry, the ticket URL, goes once; a second navigation to it (a reload) is refused", () => {
  const guard = createNavigationGuard(TICKET_URL);
  assert.deepEqual(guard(nav(TICKET_URL)), { allow: true });
  assert.deepEqual(guard(nav(TICKET_URL)), { allow: false, reason: "after_entry" });
});

test("a top-level navigation off the content origin is refused, before or after the entry", () => {
  for (const url of [
    "https://evil.example/",
    "http://w-0f6f4a4e-5d1c-4f43-9a27-6a3a1b9c2d10.w.content.example/",
    `${CONTENT_ORIGIN}:8443/`,
    "https://other-w.w.content.example/",
    "about:blank",
    "data:text/html,hi",
    "javascript:alert(1)",
    "not a url",
  ]) {
    assert.deepEqual(createNavigationGuard(TICKET_URL)(nav(url)), { allow: false, reason: "off_origin" }, url);
    const guard = createNavigationGuard(TICKET_URL);
    guard(nav(TICKET_URL));
    assert.deepEqual(guard(nav(url)), { allow: false, reason: "off_origin" }, url);
  }
});

test("only the entry is shot: a same-origin navigation after it (another page, a script's location change) is refused", () => {
  const guard = createNavigationGuard(TICKET_URL);
  guard(nav(TICKET_URL));
  assert.deepEqual(guard(nav(`${CONTENT_ORIGIN}/page2.html`)), { allow: false, reason: "after_entry" });
  assert.deepEqual(guard(nav(`${CONTENT_ORIGIN}/__porthole/f/abc/index.html`)), { allow: false, reason: "after_entry" });
  // And before it: the first navigation must be the ticket URL itself.
  assert.deepEqual(createNavigationGuard(TICKET_URL)(nav(`${CONTENT_ORIGIN}/`)), { allow: false, reason: "after_entry" });
});

test("the entry's redirects go on its own origin, never off it; another chain's redirect is refused", () => {
  const guard = createNavigationGuard(TICKET_URL);
  guard(nav(TICKET_URL));
  assert.deepEqual(guard(nav(`${CONTENT_ORIGIN}/__porthole/f/abc/`, { redirectedFrom: TICKET_URL })), { allow: true });
  assert.deepEqual(guard(nav("https://evil.example/", { redirectedFrom: TICKET_URL })), { allow: false, reason: "off_origin" });
  assert.deepEqual(guard(nav(`${CONTENT_ORIGIN}/b`, { redirectedFrom: `${CONTENT_ORIGIN}/a` })), { allow: false, reason: "after_entry" });
});

test("subresources and subframe navigations go, wherever they point (the content's CSP is their wall)", () => {
  const guard = createNavigationGuard(TICKET_URL);
  assert.deepEqual(guard(nav("https://cdn.example/lib.js", { isNavigation: false })), { allow: true });
  assert.deepEqual(guard(nav("https://embed.example/", { isMainFrame: false })), { allow: true });
  // They don't use up the entry.
  assert.deepEqual(guard(nav(TICKET_URL)), { allow: true });
});

test("a ticket URL that isn't a URL refuses every top-level navigation", () => {
  const guard = createNavigationGuard("not a url");
  assert.deepEqual(guard(nav("not a url")), { allow: false, reason: "off_origin" });
});
