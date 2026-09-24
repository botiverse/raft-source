import assert from "node:assert/strict";
import test from "node:test";
import {
  canUseBrowserBack,
  nextNavigationDepth,
  nextNavigationStack,
  resolveMobileBackAction,
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

test("navigation stack tracks push, replace, and pop paths", () => {
  let stack = nextNavigationStack([], "REPLACE", "/s/dev");
  assert.deepEqual(stack, ["/s/dev"]);

  stack = nextNavigationStack(stack, "PUSH", "/s/dev/search");
  assert.deepEqual(stack, ["/s/dev", "/s/dev/search"]);

  stack = nextNavigationStack(stack, "REPLACE", "/s/dev/search?q=hello");
  assert.deepEqual(stack, ["/s/dev", "/s/dev/search?q=hello"]);

  stack = nextNavigationStack(stack, "POP", "/s/dev");
  assert.deepEqual(stack, ["/s/dev"]);
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
