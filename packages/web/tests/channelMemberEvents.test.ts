import assert from "node:assert/strict";
import test from "node:test";
import {
  notifyAllChannelMembersChanged,
  notifyChannelMembersChanged,
  subscribeChannelMembersChanged,
} from "../src/store/channelMemberEvents.js";

test("channel member change notifications fan out by channel id", () => {
  const seen: Array<string | null> = [];
  const unsubscribe = subscribeChannelMembersChanged((channelId) => {
    seen.push(channelId);
  });

  notifyChannelMembersChanged("channel-a");
  notifyChannelMembersChanged("channel-b");
  unsubscribe();
  notifyChannelMembersChanged("channel-c");

  assert.deepEqual(seen, ["channel-a", "channel-b"]);
});

test("server-wide member change notifications invalidate every channel snapshot", () => {
  const seen: Array<string | null> = [];
  const unsubscribe = subscribeChannelMembersChanged((channelId) => {
    seen.push(channelId);
  });

  notifyChannelMembersChanged("channel-a");
  notifyAllChannelMembersChanged();
  unsubscribe();

  assert.deepEqual(seen, ["channel-a", null]);
});
