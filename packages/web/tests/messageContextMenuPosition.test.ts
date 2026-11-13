import assert from "node:assert/strict";

import { placeTouchMessageContextMenu } from "../src/components/message/messageContextMenuPosition";

test("mobile message context menu anchors to the long-press touch point", () => {
  const position = placeTouchMessageContextMenu({
    x: 640,
    y: 360,
    viewport: { width: 800, height: 900 },
  });

  assert.equal(position.anchorX, 640);
  assert.equal(position.anchorY, 360);
  // 316 wide, it would cross the right edge, so it opens to the left.
  assert.equal(position.x, 640 - 316);
  assert.equal(position.y, 360);
  assert.equal(position.source, "touch");
});

test("mobile message context menu clamps to the visual viewport", () => {
  const position = placeTouchMessageContextMenu({
    x: 760,
    y: 820,
    viewport: { width: 800, height: 900 },
  });

  assert.equal(position.x, 760 - 316);
  assert.equal(position.y, 820 - 400);
});
