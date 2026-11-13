import assert from "node:assert/strict";
import { messageHoverToolbarActions } from "../src/components/message/MessageHoverToolbar";

// Task #115: the hover toolbar's buttons, in the message context menu's order.
test("the toolbar lists its buttons in order, and only those that apply", () => {
  assert.deepEqual(messageHoverToolbarActions({ canForward: true }), ["reaction", "thread", "forward", "bookmark"]);
  assert.deepEqual(messageHoverToolbarActions({ canForward: true, canMore: true }), ["reaction", "thread", "forward", "bookmark", "more"]);
  assert.deepEqual(messageHoverToolbarActions({ canForward: false, hideThreadActions: true }), ["reaction", "bookmark"]);
  assert.deepEqual(messageHoverToolbarActions({ canForward: false, isSystem: true }), ["thread", "bookmark"]);
  assert.deepEqual(messageHoverToolbarActions({ canForward: false, canReact: false }), ["thread", "bookmark"]);
});
