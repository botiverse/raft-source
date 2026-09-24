import assert from "node:assert/strict";
import test from "node:test";
import { parseUnreadSnapshot } from "../src/store/messageStore.js";

test("sidebar mention flags ignore read mention history from unread summaries", () => {
  const snapshot = parseUnreadSnapshot({
    channels: {
      "channel-read-mention": {
        unreadCount: 0,
        hasMention: false,
        hasAnyMention: true,
      },
      "channel-unread-mention": {
        unreadCount: 1,
        hasMention: true,
        hasAnyMention: true,
      },
      "channel-unread-plain": {
        unreadCount: 2,
        hasMention: false,
        hasAnyMention: false,
      },
    },
  });

  assert.deepEqual(snapshot.unreadCounts, {
    "channel-unread-mention": 1,
    "channel-unread-plain": 2,
  });
  assert.deepEqual(snapshot.mentionFlags, {
    "channel-unread-mention": true,
  });
});
