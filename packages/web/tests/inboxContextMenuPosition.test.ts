import assert from "node:assert/strict";
import test from "node:test";

import {
  INBOX_CONTEXT_MENU_HEIGHT,
  INBOX_CONTEXT_MENU_VIEWPORT_MARGIN,
  INBOX_CONTEXT_MENU_WIDTH,
  placeInboxContextMenu,
} from "../src/components/thread/inboxContextMenuPosition";
import type { InboxItem } from "../src/store/inboxStore";

const item = { kind: "channel" } as InboxItem;

test("activity context menu clamps away from the mobile right edge", () => {
  const position = placeInboxContextMenu({
    x: 382,
    y: 680,
    item,
    viewport: { width: 393, height: 852 },
  });

  assert.equal(position.x, 198);
  assert.equal(position.y, 680);
  assert.ok(position.x + INBOX_CONTEXT_MENU_WIDTH <= 393 - INBOX_CONTEXT_MENU_VIEWPORT_MARGIN);
  assert.equal(position.maxWidth, 377);
});

test("activity context menu clamps upward near the mobile bottom edge", () => {
  const position = placeInboxContextMenu({
    x: 250,
    y: 810,
    item,
    viewport: { width: 393, height: 852 },
  });

  assert.equal(position.x, 66);
  assert.equal(position.y, 714);
  assert.ok(position.y + INBOX_CONTEXT_MENU_HEIGHT <= 852 - INBOX_CONTEXT_MENU_VIEWPORT_MARGIN);
});
