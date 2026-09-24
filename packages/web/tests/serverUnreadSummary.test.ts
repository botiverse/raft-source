import assert from "node:assert/strict";
import test from "node:test";
import {
  hasOtherServerActivityUnread,
  hasOtherServerLoudUnread,
  parseServerUnreadSummaryRows,
  retainServerUnreadSummary,
} from "../src/utils/serverUnreadSummary";

test("parseServerUnreadSummaryRows preserves counts, mute state, and known Activity values", () => {
  assert.deepEqual(
    parseServerUnreadSummaryRows([
      { serverId: "server-a", unreadCount: 2, serverPushMuted: true, activityUnreadCount: 0 },
      { serverId: "server-b", unreadCount: 3.8, serverPushMuted: false, activityUnreadCount: 5 },
      { serverId: "server-c", unreadCount: -4, serverPushMuted: true, activityUnreadCount: -1 },
      { serverId: "server-d", unreadCount: 1, serverPushMuted: false },
      { serverId: 123, unreadCount: 9, serverPushMuted: true, activityUnreadCount: 4 },
    ]),
    {
      "server-a": { unreadCount: 2, serverPushMuted: true, activityUnreadCount: 0 },
      "server-b": { unreadCount: 3, serverPushMuted: false, activityUnreadCount: 5 },
      "server-c": { unreadCount: 0, serverPushMuted: true },
      "server-d": { unreadCount: 1, serverPushMuted: false },
    },
  );
});

test("hasOtherServerActivityUnread ignores current server and unknown counts", () => {
  const servers = [{ id: "current" }, { id: "known" }, { id: "unknown" }];
  assert.equal(
    hasOtherServerActivityUnread(servers, { id: "current" }, {
      current: { unreadCount: 1, serverPushMuted: false, activityUnreadCount: 4 },
      known: { unreadCount: 0, serverPushMuted: true, activityUnreadCount: 2 },
      unknown: { unreadCount: 9, serverPushMuted: false },
    }),
    true,
  );
  assert.equal(
    hasOtherServerActivityUnread(servers, { id: "current" }, {
      current: { unreadCount: 1, serverPushMuted: false, activityUnreadCount: 4 },
      known: { unreadCount: 0, serverPushMuted: true, activityUnreadCount: 0 },
      unknown: { unreadCount: 9, serverPushMuted: false },
    }),
    false,
  );
});

test("hasOtherServerLoudUnread ignores current and muted servers", () => {
  const servers = [{ id: "current" }, { id: "muted" }, { id: "quiet" }, { id: "loud" }];

  assert.equal(
    hasOtherServerLoudUnread(servers, { id: "current" }, {
      current: { unreadCount: 4, serverPushMuted: false },
      muted: { unreadCount: 7, serverPushMuted: true },
      quiet: { unreadCount: 0, serverPushMuted: false },
    }),
    false,
  );

  assert.equal(
    hasOtherServerLoudUnread(servers, { id: "current" }, {
      current: { unreadCount: 4, serverPushMuted: false },
      muted: { unreadCount: 7, serverPushMuted: true },
      quiet: { unreadCount: 0, serverPushMuted: false },
      loud: { unreadCount: 1, serverPushMuted: false },
    }),
    true,
  );
  assert.equal(
    hasOtherServerLoudUnread(servers, undefined, {
      current: { unreadCount: 4, serverPushMuted: false },
    }),
    true,
  );
});


test("unchanged reconciliation preserves identity, but count, mute, coverage and server changes publish", () => {
  const previous = { a: { unreadCount: 1, serverPushMuted: false } };
  assert.equal(retainServerUnreadSummary(previous, { a: { ...previous.a } }), previous);
  for (const next of [
    { a: { ...previous.a, unreadCount: 2 } },
    { a: { ...previous.a, serverPushMuted: true } },
    { a: { ...previous.a, activityUnreadCount: 0 } },
    {},
    { b: { ...previous.a } },
  ]) {
    assert.equal(retainServerUnreadSummary(previous, next), next);
  }
});
