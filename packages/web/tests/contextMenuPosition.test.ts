import assert from "node:assert/strict";
import test from "node:test";

import { CONTEXT_MENU_VIEWPORT_MARGIN, placeContextMenu } from "../src/components/ui/contextMenuPosition";

test("shared context menu placement flips away from viewport edges", () => {
  const position = placeContextMenu({
    x: 382,
    y: 810,
    width: 184,
    height: 96,
    viewport: { width: 393, height: 852 },
  });

  assert.equal(position.x, 198);
  assert.equal(position.y, 714);
  assert.equal(position.maxWidth, 393 - CONTEXT_MENU_VIEWPORT_MARGIN * 2);
  assert.equal(position.maxHeight, 852 - CONTEXT_MENU_VIEWPORT_MARGIN * 2);
});
