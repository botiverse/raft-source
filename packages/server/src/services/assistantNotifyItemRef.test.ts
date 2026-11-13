import assert from "node:assert/strict";

import type { CheckItem } from "./assistantCheckService";
import { itemRef } from "./assistantNotifyService";

const item = (over: Partial<CheckItem>): CheckItem => ({
  channelId: "c-1", channelName: "room", channelType: "channel", kind: "channel", why: "mention",
  parentChannelId: null, parentMessageId: null, firstUnreadMessageId: "m1234567-aaaa", latestSeq: 3,
  latestSenderName: "ana", senderId: "u-ana", mention: true, dm: false, unread: 1, ...over,
});

test("itemRef: a channel names its first unread message; a thread the message it hangs off", () => {
  assert.equal(itemRef(item({})), "#room:m1234567");
  assert.equal(itemRef(item({ kind: "thread", parentChannelId: "c-0", parentMessageId: "p7654321-bbbb" })), "#room:p7654321");
});

test("itemRef: a task conversation (task v2, no parent message) names its task", () => {
  assert.equal(itemRef(item({ kind: "thread", parentChannelId: "c-0", taskNumber: 7 })), "#room:#7");
  assert.equal(itemRef(item({ kind: "thread", channelType: "dm", dm: true, channelName: "bo", parentChannelId: "d-0", taskNumber: 7 })), "dm:@bo:#7");
});
