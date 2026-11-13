import assert from "node:assert/strict";
import {
  canUseBrowserBack,
  navigationStackFromEntries,
  nextNavigationDepth,
  nextNavigationEntries,
  resolveMobileBackAction,
  UNKNOWN_NAVIGATION_ENTRY,
} from "../src/hooks/useAppNavigate";

test("PUSH increments the depth counter", () => {
  assert.equal(nextNavigationDepth(0, "PUSH"), 1);
  assert.equal(nextNavigationDepth(3, "PUSH"), 4);
});

test("POP decrements the depth counter and clamps at 0", () => {
  assert.equal(nextNavigationDepth(2, "POP"), 1);
  assert.equal(nextNavigationDepth(1, "POP"), 0);
  assert.equal(nextNavigationDepth(0, "POP"), 0);
});

test("REPLACE leaves the depth counter unchanged", () => {
  // Without this guarantee the cold-start semantic fallback (which uses
  // navigate({replace:true})) would falsely look like an in-app push and
  // strand the user on the next back press.
  assert.equal(nextNavigationDepth(0, "REPLACE"), 0);
  assert.equal(nextNavigationDepth(5, "REPLACE"), 5);
});

test("cold start at deep URL: depth=0 → back falls back to semantic parent", () => {
  // Notification tap → /s/dev/channel/abc → no in-app history yet.
  assert.deepEqual(
    resolveMobileBackAction(0, "/s/dev/channel/abc"),
    { kind: "fallback", path: "/s/dev/channel/abc" },
  );
});

test("after in-app PUSH: depth>0 → back uses browser history", () => {
  assert.deepEqual(resolveMobileBackAction(1, "/s/dev"), { kind: "back" });
  assert.deepEqual(resolveMobileBackAction(7, "/s/dev"), { kind: "back" });
});

test("same-server in-app history still unwinds via browser back", () => {
  assert.deepEqual(
    resolveMobileBackAction(
      ["/s/dev", "/s/dev/search?q=hello", "/s/dev/channel/abc"],
      "/s/dev",
    ),
    { kind: "back" },
  );
  assert.equal(
    canUseBrowserBack("/s/dev/search?q=hello", "/s/dev/channel/abc"),
    true,
  );
});

test("mobile detail back does not pop into a different server", () => {
  assert.deepEqual(
    resolveMobileBackAction(
      ["/s/previous-server", "/s/current-server/channel/abc?thread=abc:p1"],
      "/s/current-server/channel/abc",
    ),
    { kind: "fallback", path: "/s/current-server/channel/abc" },
  );
  assert.equal(
    canUseBrowserBack("/s/previous-server", "/s/current-server/channel/abc"),
    false,
  );
});

test("callback fallbacks inherit the current server scope", () => {
  // `useMobileBack(closeThread)` scopes callback fallbacks to `/s/<current>`.
  // That lets an overlay close itself instead of browser-popping into a
  // different server that happened to be earlier in this tab's history.
  assert.deepEqual(
    resolveMobileBackAction(
      ["/s/alpha/channel/a", "/s/bravo/tasks?thread=c:p"],
      "/s/bravo",
    ),
    { kind: "fallback", path: "/s/bravo" },
  );
});

test("fallback destination can differ from the current-server safety scope", () => {
  assert.deepEqual(
    resolveMobileBackAction(
      ["/s/alpha/channel/a", "/s/bravo/channel/b"],
      "/",
      "/s/bravo/channel/b",
    ),
    { kind: "fallback", path: "/" },
  );
});

test("notification → thread → back → channel → back → chat tab root", () => {
  // The exact regression: PWA cold-starts at a thread permalink, user expects
  // back to walk thread → parent channel → chat tab root. Each fallback hop
  // is a REPLACE so the counter must stay at 0 the whole way down.
  let depth = 0;
  assert.deepEqual(
    resolveMobileBackAction(depth, "/s/dev/channel/abc"),
    { kind: "fallback", path: "/s/dev/channel/abc" },
  );
  depth = nextNavigationDepth(depth, "REPLACE");
  assert.deepEqual(
    resolveMobileBackAction(depth, "/s/dev"),
    { kind: "fallback", path: "/s/dev" },
  );
});

test("search result → channel → back → search → back → root (no loop)", () => {
  // Regression: the search page used to PUSH to firstChannelId on back, so
  // pressing back on the search page would land on a channel — then chat
  // mobile-back from that channel would POP back to search, repeat forever.
  // With handleBack using the same mobile-back primitive, both legs POP.
  let depth = 0;
  depth = nextNavigationDepth(depth, "PUSH"); // enter search
  depth = nextNavigationDepth(depth, "REPLACE"); // typing query (replace ?q=)
  depth = nextNavigationDepth(depth, "PUSH"); // open result → channel
  assert.equal(depth, 2);
  assert.deepEqual(resolveMobileBackAction(depth, "/s/dev"), { kind: "back" });
  depth = nextNavigationDepth(depth, "POP"); // chat mobile-back → search
  assert.equal(depth, 1);
  assert.deepEqual(resolveMobileBackAction(depth, "/s/dev"), { kind: "back" });
  depth = nextNavigationDepth(depth, "POP"); // search mobile-back → origin
  assert.equal(depth, 0);
  assert.deepEqual(
    resolveMobileBackAction(depth, "/s/dev"),
    { kind: "fallback", path: "/s/dev" },
  );
});

test("in-app PUSH chain unwinds via real history then falls back at the bottom", () => {
  let depth = 0;
  depth = nextNavigationDepth(depth, "PUSH");
  depth = nextNavigationDepth(depth, "PUSH");
  assert.equal(depth, 2);
  assert.deepEqual(resolveMobileBackAction(depth, "/s/dev"), { kind: "back" });
  depth = nextNavigationDepth(depth, "POP");
  depth = nextNavigationDepth(depth, "POP");
  assert.equal(depth, 0);
  assert.deepEqual(
    resolveMobileBackAction(depth, "/s/dev"),
    { kind: "fallback", path: "/s/dev" },
  );
});

test("index-keyed records: a multi-entry POP or Forward lands at its real index; PUSH discards records at/after it; unknown gaps stay unknown", () => {
  let entries = nextNavigationEntries({}, "REPLACE", 0, "/s/other");
  entries = nextNavigationEntries(entries, "PUSH", 1, "/s/dev/channel/b");
  entries = nextNavigationEntries(entries, "PUSH", 2, "/s/dev/channel/c");
  entries = nextNavigationEntries(entries, "PUSH", 3, "/s/dev/channel/d");
  entries = nextNavigationEntries(entries, "PUSH", 4, "/s/dev/channel/e");
  entries = nextNavigationEntries(entries, "POP", 1, "/s/dev/channel/b"); // go(-3)
  entries = nextNavigationEntries(entries, "POP", 4, "/s/dev/channel/e"); // go(+3): records, discards nothing
  entries = nextNavigationEntries(entries, "POP", 2, "/s/dev/channel/c"); // go(-2)
  assert.deepEqual(navigationStackFromEntries(entries, 2), ["/s/other", "/s/dev/channel/b", "/s/dev/channel/c"]);
  // The decision the reviewer's sequence hinges on: previous entry is b (same server) → browser back.
  assert.deepEqual(resolveMobileBackAction(navigationStackFromEntries(entries, 2), "/s/dev"), { kind: "back" });
  // A PUSH from c discards d/e records.
  const pushed = nextNavigationEntries(entries, "PUSH", 3, "/s/dev/channel/x");
  assert.deepEqual(Object.keys(pushed).map(Number), [0, 1, 2, 3]);
  // Unknown predecessors (reload landed on idx 2): the gap is explicit and never a back target.
  const afterReload = nextNavigationEntries({}, "POP", 2, "/s/dev/channel/c");
  assert.deepEqual(navigationStackFromEntries(afterReload, 2), [UNKNOWN_NAVIGATION_ENTRY, UNKNOWN_NAVIGATION_ENTRY, "/s/dev/channel/c"]);
  assert.deepEqual(resolveMobileBackAction(navigationStackFromEntries(afterReload, 2), "/s/dev"), { kind: "fallback", path: "/s/dev" });
  assert.deepEqual(resolveMobileBackAction(navigationStackFromEntries(afterReload, 2), "/"), { kind: "fallback", path: "/" });
});
