import assert from "node:assert/strict";

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

  assert.deepEqual(ids, { loud: ["joined-public", "private", "dm"], mutedChannels: [] });
  assert.equal(hasChatAttentionUnread(ids, { private: 2 }), true);
  assert.equal(hasChatAttentionUnread(ids, { dm: 1 }), true);
});

test("unjoined public unread remains row-level state without lighting Chat", () => {
  const unreadCounts = { "public-discovery": 3 };
  const ids = selectChatAttentionChannelIds(
    [{ id: "public-discovery", type: "channel", joined: false }],
    [],
  );

  assert.deepEqual(ids, { loud: [], mutedChannels: [] });
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

test("a muted channel's plain unread stays quiet and does not light Chat", () => {
  const ids = selectChatAttentionChannelIds(
    [
      { id: "muted-public", type: "channel", joined: true, activityMuted: true },
      { id: "muted-private", type: "private", joined: true, activityMuted: true },
    ],
    [],
  );

  assert.deepEqual(ids, { loud: [], mutedChannels: ["muted-public", "muted-private"] });
  assert.equal(hasChatAttentionUnread(ids, { "muted-public": 3, "muted-private": 2 }, {}), false);
});

test("a muted channel lights Chat only with the row's @you mention marker", () => {
  const ids = selectChatAttentionChannelIds(
    [{ id: "muted-public", type: "channel", joined: true, activityMuted: true }],
    [],
  );

  assert.equal(hasChatAttentionUnread(ids, { "muted-public": 1 }, { "muted-public": true }), true);
  // A stale mention flag with nothing unread does not light Chat.
  assert.equal(hasChatAttentionUnread(ids, {}, { "muted-public": true }), false);
});

test("a muted DM never lights Chat, even when it mentions the viewer", () => {
  const ids = selectChatAttentionChannelIds([], [{ id: "muted-dm", activityMuted: true }]);

  assert.deepEqual(ids, { loud: [], mutedChannels: [] });
  assert.equal(hasChatAttentionUnread(ids, { "muted-dm": 4 }, { "muted-dm": true }), false);
});

test("unmuted unread still lights Chat next to a quiet muted channel", () => {
  const ids = selectChatAttentionChannelIds(
    [
      { id: "muted-public", type: "channel", joined: true, activityMuted: true },
      { id: "joined-public", type: "channel", joined: true, activityMuted: false },
    ],
    [{ id: "dm", activityMuted: false }],
  );

  assert.equal(hasChatAttentionUnread(ids, { "muted-public": 5, "joined-public": 1 }, {}), true);
  assert.equal(hasChatAttentionUnread(ids, { "muted-public": 5, dm: 1 }, {}), true);
});
