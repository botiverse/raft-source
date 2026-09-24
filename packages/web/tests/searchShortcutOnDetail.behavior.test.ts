import assert from "node:assert/strict";
import test from "node:test";

import { routeGlobalSearchShortcut } from "../src/utils/searchFocusRequest";

test("global search shortcut focuses exact and detail search routes in place", () => {
  for (const pathname of [
    "/s/server/search",
    "/s/server/search/message/message-1",
  ]) {
    const calls: string[] = [];
    const result = routeGlobalSearchShortcut({
      pathname,
      searchPath: "/s/server/search",
      focusMountedSearch: () => calls.push("focus"),
      navigateToSearch: () => calls.push("navigate"),
    });

    assert.equal(result, "focused");
    assert.deepEqual(calls, ["focus"]);
  }
});

test("global search shortcut navigates from a non-search route", () => {
  const calls: string[] = [];
  const result = routeGlobalSearchShortcut({
    pathname: "/s/server/channel/channel-1",
    searchPath: "/s/server/search",
    focusMountedSearch: () => calls.push("focus"),
    navigateToSearch: () => calls.push("navigate"),
  });

  assert.equal(result, "navigated");
  assert.deepEqual(calls, ["navigate"]);
});
