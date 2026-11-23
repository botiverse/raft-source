// DOM nodes never go to node:assert as values (tests/assertionNullCompareGuard.test.ts).
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { anchorAt } from "../src/apps/artifacts/ArtifactCommentBubble";
import { captureLiveAnchor } from "../src/apps/artifacts/artifactCommentsShapes";
import { getMessageSelectionShortcutTarget } from "../src/components/message/messageSelectionShortcutUtils";

function mockRect(left: number, top: number, width: number, height: number): DOMRect {
  const box = { x: left, y: top, width, height, top, left, right: left + width, bottom: top + height };
  return { ...box, toJSON: () => box } as DOMRect;
}

test("anchorAt without live anchor returns static rect and no contextElement", () => {
  const anchor = anchorAt({ x: 40, y: 120, width: 80, height: 24 });
  assert.equal("contextElement" in anchor, false);
  const rect = anchor.getBoundingClientRect();
  assert.equal(rect.left, 40);
  assert.equal(rect.top, 120);
  assert.equal(rect.width, 80);
  assert.equal(rect.height, 24);
});

test("captureLiveAnchor + anchorAt tracks scroll/resize delta without drift across re-creation (revealSent handoff)", () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  let hostLeft = 200;
  let hostTop = 300;
  host.getBoundingClientRect = () => mockRect(hostLeft, hostTop, 400, 500);

  const originalRect = { x: 240, y: 360, width: 64, height: 20 };
  const live = captureLiveAnchor(originalRect, host);
  assert.equal(live !== null, true);
  assert.equal(live?.dx, 40);
  assert.equal(live?.dy, 60);

  const composeAnchor = anchorAt(originalRect, live);
  assert.equal("contextElement" in composeAnchor && composeAnchor.contextElement === host, true);
  assert.equal(composeAnchor.getBoundingClientRect().left, 240);
  assert.equal(composeAnchor.getBoundingClientRect().top, 360);

  // User scrolls down 150px and widens sidebar by 20px while composing.
  hostLeft = 220;
  hostTop = 150;
  assert.equal(composeAnchor.getBoundingClientRect().left, 260);
  assert.equal(composeAnchor.getBoundingClientRect().top, 210);

  // Comment is sent (`revealSent` hands `{ rect: originalRect, liveAnchor: live }` to a brand-new
  // ThreadBubble, or BubbleShell re-memoizes anchorAt after scroll): offset must NOT drift.
  const threadAnchor = anchorAt(originalRect, live);
  assert.equal(threadAnchor.getBoundingClientRect().left, 260);
  assert.equal(threadAnchor.getBoundingClientRect().top, 210);

  // Subsequent scroll continues tracking accurately.
  hostTop = 50;
  assert.equal(threadAnchor.getBoundingClientRect().top, 110);

  // Disconnecting the host falls back to the captured rect without throwing.
  host.remove();
  const detached = threadAnchor.getBoundingClientRect();
  assert.equal(detached.left, 240);
  assert.equal(detached.top, 360);
});

test("getMessageSelectionShortcutTarget attaches messageBody as contextElement and tracks live range movement", () => {
  const body = document.createElement("div");
  body.dataset.messageSelectable = "true";
  body.dataset.quoteChannelId = "ch-1";
  body.dataset.messageId = "m-42";
  const textNode = document.createTextNode("hello tracked world");
  body.appendChild(textNode);
  document.body.appendChild(body);

  let rectTop = 250;
  let rectWidth = 120;
  const origGetClientRects = Range.prototype.getClientRects;
  const origGetBoundingClientRect = Range.prototype.getBoundingClientRect;
  Range.prototype.getClientRects = function getClientRects() {
    return [mockRect(100, rectTop, rectWidth, 18)] as unknown as DOMRectList;
  };
  Range.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return mockRect(100, rectTop, rectWidth, 18);
  };

  try {
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 13);

    const selection = {
      isCollapsed: false,
      rangeCount: 1,
      anchorNode: textNode,
      anchorOffset: 0,
      focusNode: textNode,
      focusOffset: 13,
      toString: () => "hello tracked",
      getRangeAt: () => range,
    } as unknown as Selection;

    const target = getMessageSelectionShortcutTarget(selection);
    assert.equal(target !== null, true);
    assert.equal(target?.messageBody === body, true);
    assert.equal(target?.anchor.contextElement === body, true);
    assert.equal(target?.anchor.getBoundingClientRect().top, 250);

    // Simulate scrolling the message list upward by 90px: live anchor updates immediately.
    rectTop = 160;
    assert.equal(target?.anchor.getBoundingClientRect().top, 160);

    // Zero-area ranges are rejected.
    rectWidth = 0;
    assert.equal(getMessageSelectionShortcutTarget(selection) === null, true);
  } finally {
    Range.prototype.getClientRects = origGetClientRects;
    Range.prototype.getBoundingClientRect = origGetBoundingClientRect;
    body.remove();
  }
});
