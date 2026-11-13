/**
 * Back to Popover steps back when the page it came from is the entry right
 * before (Artea: a step back is better than a new page), so the browser's own
 * Back afterwards doesn't return to the assistant page.
 */
import assert from "node:assert/strict";
import { test } from "vitest";

import { shrinkNavigation } from "../src/assistant/assistantExpand";

const from = { serverId: "server-1", path: "/s/server/channel/c1", historyIdx: 4 };

test("the page it came from is the entry right before: step back", () => {
  assert.deepEqual(shrinkNavigation(from, 5), { back: true });
});

test("anything else goes there in place of this entry", () => {
  assert.deepEqual(shrinkNavigation(from, 7), { back: false, path: from.path }, "moved on since");
  assert.deepEqual(shrinkNavigation(from, null), { back: false, path: from.path }, "no history index");
  assert.deepEqual(shrinkNavigation({ ...from, historyIdx: null }, 5), { back: false, path: from.path }, "origin index unknown");
});
