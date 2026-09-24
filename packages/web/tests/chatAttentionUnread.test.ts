import assert from "node:assert/strict";
import test from "node:test";

import {
  hasChatAttentionUnread,
  selectChatAttentionChannelIds,
} from "../src/utils/chatAttentionUnread";

test("Chat attention includes joined public channels, private channels, and DMs", () => {
  const ids = selectChatAttentionChannelIds(
    [
      { id: "joined-public", type: "channel", joined: true },
      { id: "private", type: "private" },
    ],
    [{ id: "dm" }],
  );

  assert.deepEqual(ids, ["joined-public", "private", "dm"]);
  assert.equal(hasChatAttentionUnread(ids, { private: 2 }), true);
  assert.equal(hasChatAttentionUnread(ids, { dm: 1 }), true);
});

test("unjoined public unread remains row-level state without lighting Chat", () => {
  const unreadCounts = { "public-discovery": 3 };
  const ids = selectChatAttentionChannelIds(
    [{ id: "public-discovery", type: "channel", joined: false }],
    [],
  );

  assert.deepEqual(ids, []);
  assert.equal(hasChatAttentionUnread(ids, unreadCounts), false);
  assert.equal(unreadCounts["public-discovery"], 3);
});

test("an unjoined public unread cannot mask eligible Chat attention", () => {
  const ids = selectChatAttentionChannelIds(
    [
      { id: "public-discovery", type: "channel", joined: false },
      { id: "joined-public", type: "channel", joined: true },
    ],
    [],
  );

  assert.equal(hasChatAttentionUnread(ids, {
    "public-discovery": 4,
    "joined-public": 1,
  }), true);
});
