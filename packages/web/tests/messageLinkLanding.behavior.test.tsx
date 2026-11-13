import assert from "node:assert/strict";
import "./helpers/domSetup";
import {
  captureMessageLinkLanding,
  isMessageLinkLanding,
  isMessageLinkLandingFromOutside,
  isThreadMismatch,
  markMessageLinkHandOff,
  noteMessageLinkLocation,
  parseMessageLink,
  resetMessageLinkLandingForTests,
} from "../src/utils/messageLinkLanding";
import { movePageLanding, notePageLocation, pageLandingAt, spendPageLanding, subscribePageLanding } from "../src/utils/pageLanding";
import { getExternalBrowserLoginUrl } from "../src/utils/socialAuth";

// Deep links v1 (item d): the message link format "Copy link" builds, and
// which addresses count as a landing (a link, a fresh load, a raft:// hand-off).

afterEach(() => {
  resetMessageLinkLandingForTests();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "raftDesktop");
  window.history.replaceState(null, "", "/");
});

test("a message link is a conversation path with msg and/or thread", () => {
  assert.deepEqual(parseMessageLink("/s/acme/channel/c1", "?msg=m1"), {
    serverSlug: "acme",
    routeKind: "channel",
    channelId: "c1",
    messageId: "m1",
    thread: null,
    threadChannelId: null,
    threadParentMessageId: null,
  });
  const reply = parseMessageLink("/s/acme/dm/d1", "?msg=r1&thread=d1%3Ap1");
  assert.equal(reply?.routeKind, "dm");
  assert.equal(reply?.threadChannelId, "d1");
  assert.equal(reply?.threadParentMessageId, "p1");
  assert.equal(parseMessageLink("/s/acme/channel/c1", "?thread=c1:p1")?.messageId, null);
  assert.equal(parseMessageLink("/s/acme/channel/c1", ""), null, "a channel, not a message");
  assert.equal(parseMessageLink("/s/acme/search", "?msg=m1"), null);
  assert.equal(parseMessageLink("/s/acme/channel/c1/extra", "?msg=m1"), null);
});

test("a thread naming another conversation, or no parent, rejects the link", () => {
  assert.equal(isThreadMismatch(parseMessageLink("/s/acme/channel/c1", "?thread=c1:p1")!), false);
  assert.equal(isThreadMismatch(parseMessageLink("/s/acme/channel/c1", "?msg=m1")!), false);
  assert.equal(isThreadMismatch(parseMessageLink("/s/acme/channel/c1", "?thread=c2:p1&msg=r1")!), true);
  assert.equal(isThreadMismatch(parseMessageLink("/s/acme/channel/c1", "?thread=c1:")!), true);
  assert.equal(isThreadMismatch(parseMessageLink("/s/acme/channel/c1", "?thread=p1")!), true);
});

test("the first load is the landing, whatever the app adds to its query", () => {
  resetMessageLinkLandingForTests({ pathname: "/s/acme/channel/c1", search: "?msg=m1&thread=c1:p1" });
  assert.equal(isMessageLinkLanding("/s/acme/channel/c1", "?thread=c1:p1&msg=m1&profile=u1"), true);
  assert.equal(isMessageLinkLanding("/s/acme/channel/c1", "?msg=m2&thread=c1:p1"), false);
  assert.equal(isMessageLinkLanding("/s/acme/channel/c2", "?msg=m1&thread=c1:p1"), false);
});

test("from outside: no referrer or another origin; not from Raft itself", () => {
  resetMessageLinkLandingForTests({ pathname: "/s/acme/channel/c1", search: "?msg=m1" });
  assert.equal(isMessageLinkLandingFromOutside("/s/acme/channel/c1", "?msg=m1"), true);
  resetMessageLinkLandingForTests({ pathname: "/s/acme/channel/c1", search: "?msg=m1", referrer: "https://mail.example.com/x", origin: "https://app.raft.build" });
  assert.equal(isMessageLinkLandingFromOutside("/s/acme/channel/c1", "?msg=m1"), true);
  resetMessageLinkLandingForTests({ pathname: "/s/acme/channel/c1", search: "?msg=m1", referrer: "https://app.raft.build/s/acme", origin: "https://app.raft.build" });
  assert.equal(isMessageLinkLandingFromOutside("/s/acme/channel/c1", "?msg=m1"), false);
  assert.equal(isMessageLinkLanding("/s/acme/channel/c1", "?msg=m1"), true, "still a landing for the empty state");
});

test("Raft Desktop's raft:// hand-off lands like a fresh load, but is not 'from outside' for the banner", () => {
  markMessageLinkHandOff("/s/acme/channel/c1?msg=m1");
  assert.equal(isMessageLinkLanding("/s/acme/channel/c1", "?msg=m1"), true);
  assert.equal(isMessageLinkLandingFromOutside("/s/acme/channel/c1", "?msg=m1"), false);
  markMessageLinkHandOff("/s/acme/channel/c1");
  assert.equal(isMessageLinkLanding("/s/acme/channel/c1", ""), false);
});

test("a landing counts once: spent when the app moves on from it, not by a detour before it is shown", () => {
  resetMessageLinkLandingForTests({ pathname: "/s/acme/channel/c1", search: "?msg=m1" });
  noteMessageLinkLocation("/s/acme", "");
  assert.equal(isMessageLinkLanding("/s/acme/channel/c1", "?msg=m1"), true, "not shown yet: a detour keeps it");
  noteMessageLinkLocation("/s/acme/channel/c1", "?msg=m1");
  noteMessageLinkLocation("/s/acme/channel/c1", "?profile=u1&msg=m1");
  assert.equal(isMessageLinkLanding("/s/acme/channel/c1", "?msg=m1"), true, "panel params on the same link keep it");
  noteMessageLinkLocation("/s/acme/activity", "");
  assert.equal(isMessageLinkLanding("/s/acme/channel/c1", "?msg=m1"), false, "back later is an address the app wrote");
  assert.equal(isMessageLinkLandingFromOutside("/s/acme/channel/c1", "?msg=m1"), false);
});

test("a raft:// hand-off is spent the same way, and a new hand-off of it lands again", () => {
  markMessageLinkHandOff("/s/acme/channel/c1?msg=m1");
  noteMessageLinkLocation("/s/acme/channel/c1", "?msg=m1");
  noteMessageLinkLocation("/s/acme/channel/c2", "");
  assert.equal(isMessageLinkLanding("/s/acme/channel/c1", "?msg=m1"), false);
  markMessageLinkHandOff("/s/acme/channel/c1?msg=m1");
  assert.equal(isMessageLinkLanding("/s/acme/channel/c1", "?msg=m1"), true);
});

test("signing in from an in-app browser keeps the link's query in the system browser", () => {
  const url = new URL(getExternalBrowserLoginUrl("/s/acme/channel/c1?msg=m1&thread=c1%3Ap1"));
  assert.equal(url.origin, window.location.origin);
  assert.equal(url.pathname, "/s/acme/channel/c1");
  assert.equal(url.searchParams.get("msg"), "m1");
  assert.equal(url.searchParams.get("thread"), "c1:p1");
  assert.equal(new URL(getExternalBrowserLoginUrl("//evil.example/x")).origin, window.location.origin);
});

// The page landing (utils/pageLanding.ts): the same first load, kept for any
// address, for the open-in-app offers.

test("the page landing is whatever address the page was first loaded on, with where it came from", () => {
  resetMessageLinkLandingForTests({ pathname: "/s/acme/tasks", search: "?task=c1%3Atask%3A7", referrer: "https://mail.example.com/x", origin: "https://app.raft.build" });
  assert.deepEqual(pageLandingAt("/s/acme/tasks"), { pathname: "/s/acme/tasks", search: "?task=c1%3Atask%3A7", fromOutside: true });
  assert.equal(pageLandingAt("/s/acme/channel/c1"), null, "another page");
  assert.equal(isMessageLinkLanding("/s/acme/tasks", "?task=c1%3Atask%3A7"), false, "not a message link: none of its states");

  resetMessageLinkLandingForTests({ pathname: "/s/acme/tasks", search: "", referrer: "https://app.raft.build/s/acme", origin: "https://app.raft.build" });
  assert.equal(pageLandingAt("/s/acme/tasks")?.fromOutside, false, "followed from inside Raft");

  // A message link is both, each with its own rule.
  resetMessageLinkLandingForTests({ pathname: "/s/acme/channel/c1", search: "?msg=m1" });
  assert.equal(isMessageLinkLanding("/s/acme/channel/c1", "?msg=m1"), true);
  assert.equal(pageLandingAt("/s/acme/channel/c1")?.search, "?msg=m1");
});

test("the page landing counts once: spent when the app moves on, not by a detour before it is shown", () => {
  resetMessageLinkLandingForTests({ pathname: "/s/acme/tasks", search: "" });
  notePageLocation("/s/acme/channel/c9");
  assert.equal(pageLandingAt("/s/acme/tasks") !== null, true, "not shown yet: a detour keeps it");
  notePageLocation("/s/acme/tasks");
  notePageLocation("/s/acme/tasks");
  assert.equal(pageLandingAt("/s/acme/tasks") !== null, true);
  notePageLocation("/s/acme/channel/c1");
  assert.equal(pageLandingAt("/s/acme/tasks"), null, "back later is an address the app wrote");
  notePageLocation("/s/acme/tasks");
  assert.equal(pageLandingAt("/s/acme/tasks"), null);
});

test("the app's own redirect of the landed address carries the landing with it, once", () => {
  resetMessageLinkLandingForTests({ pathname: "/s/acme", search: "" });
  notePageLocation("/s/acme");
  movePageLanding("/s/acme", "/s/acme/channel/c1");
  // The address it left may still be reported while the redirect is on its way.
  notePageLocation("/s/acme");
  assert.equal(pageLandingAt("/s/acme/channel/c1")?.pathname, "/s/acme", "still about the address the person opened");
  assert.equal(pageLandingAt("/s/acme") !== null, true, "and still on screen while the redirect is on its way");
  notePageLocation("/s/acme/channel/c1");
  assert.equal(pageLandingAt("/s/acme"), null, "arrived: the landed address is no longer where it shows");
  // Only the landed address's own redirect: any later move is the person's.
  movePageLanding("/s/acme/channel/c1", "/s/acme/channel/c2");
  assert.equal(pageLandingAt("/s/acme/channel/c2"), null);
  notePageLocation("/s/acme/channel/c2");
  assert.equal(pageLandingAt("/s/acme/channel/c1"), null, "spent");

  // The redirect may run before the landed address was ever reported.
  resetMessageLinkLandingForTests({ pathname: "/s/acme", search: "" });
  movePageLanding("/s/acme", "/s/acme/channel/c1");
  notePageLocation("/s/acme");
  notePageLocation("/s/acme/channel/c1");
  assert.equal(pageLandingAt("/s/acme/channel/c1") !== null, true);
  notePageLocation("/s/acme");
  assert.equal(pageLandingAt("/s/acme/channel/c1"), null, "going back to the landed address later is a move like any other");
});

test("a landing that shows nothing is spent at once, and those watching are told", () => {
  resetMessageLinkLandingForTests({ pathname: "/s/acme/channel/c1", search: "?msg=m1" });
  let told = 0;
  const unsubscribe = subscribePageLanding(() => { told += 1; });
  spendPageLanding();
  assert.equal(pageLandingAt("/s/acme/channel/c1"), null);
  assert.equal(told, 1);
  assert.equal(isMessageLinkLanding("/s/acme/channel/c1", "?msg=m1"), true, "the message-link states keep their own record");
  unsubscribe();
});

function bootAt(address: string, navigation: "navigate" | "reload" | "back_forward") {
  resetMessageLinkLandingForTests();
  window.history.replaceState(null, "", address);
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([{ type: navigation } as unknown as PerformanceEntry]);
  captureMessageLinkLanding();
}

test("at boot: a fresh load is the landing, for any page and for a message link; a reload or Back/Forward is not", () => {
  bootAt("/s/acme/tasks", "navigate");
  assert.deepEqual(pageLandingAt("/s/acme/tasks"), { pathname: "/s/acme/tasks", search: "", fromOutside: true });

  bootAt("/s/acme/channel/c1?msg=m1", "navigate");
  assert.equal(pageLandingAt("/s/acme/channel/c1")?.search, "?msg=m1");
  assert.equal(isMessageLinkLanding("/s/acme/channel/c1", "?msg=m1"), true);
  assert.equal(isMessageLinkLandingFromOutside("/s/acme/channel/c1", "?msg=m1"), true);

  for (const navigation of ["reload", "back_forward"] as const) {
    bootAt("/s/acme/channel/c1?msg=m1", navigation);
    assert.equal(pageLandingAt("/s/acme/channel/c1"), null, navigation);
    assert.equal(isMessageLinkLanding("/s/acme/channel/c1", "?msg=m1"), false, navigation);
  }
});

test("at boot: Raft Desktop reopening the page after an update restart is not a landing", () => {
  (window as { raftDesktop?: unknown }).raftDesktop = { isDesktop: true, launch: { resumedRoute: "/s/acme/channel/c1?msg=m1" } };
  bootAt("/s/acme/channel/c1?msg=m1", "navigate");
  assert.equal(pageLandingAt("/s/acme/channel/c1"), null);
  assert.equal(isMessageLinkLanding("/s/acme/channel/c1", "?msg=m1"), false);
});
