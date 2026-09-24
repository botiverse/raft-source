import assert from "node:assert/strict";
import test from "node:test";
import {
  channelFilterOptionLabel,
  inboxChannelFilterOptions,
  itemFilterChannelId,
  itemFilterChannelLabel,
} from "../src/components/thread/inboxChannelFilter";
import type {
  ChannelLike,
} from "../src/components/thread/inboxChannelFilter";
import type { InboxItem } from "../src/store/inboxStore";

function channelItem(channelId: string, channelName: string, kind: "channel" | "dm" = "channel"): InboxItem {
  return {
    kind,
    channelId,
    channelName,
    channelType: kind === "dm" ? "dm" : "channel",
    lastMessageId: "m1",
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    lastMessageAt: "2026-07-11T00:00:00Z",
    lastMessagePreview: "hi",
    lastMessageSenderType: "user",
    lastMessageSenderId: "u1",
    lastMessageSenderName: "U",
    unreadCount: 0,
    hasMention: false,
  };
}

function threadItem(threadChannelId: string, parentChannelId: string, parentChannelName: string): InboxItem {
  return {
    kind: "thread",
    threadChannelId,
    parentMessageId: "pm",
    parentChannelId,
    parentChannelName,
    parentChannelType: "channel",
    parentMessagePreview: "p",
    parentMessageSenderType: "user",
    parentMessageSenderId: "u1",
    latestActivityPreview: "reply",
    latestActivitySenderType: "user",
    latestActivitySenderId: "u2",
    latestActivityMessageId: "am",
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    replyCount: 1,
    lastActivityAt: "2026-07-11T00:00:00Z",
    lastReplyAt: "2026-07-11T00:00:00Z",
    unreadCount: 1,
    hasMention: false,
    taskNumber: null,
    taskStatus: null,
    taskClaimedByName: null,
  };
}

function mentionItem(channelId: string, channelName: string): InboxItem {
  return {
    kind: "mention_action",
    id: "ma",
    channelId,
    channelName,
    channelType: "channel",
    messageId: "mid",
    messagePreview: "@you",
    createdAt: "2026-07-11T00:00:00Z",
    pendingMentionActions: [],
    unreadCount: 0,
    hasMention: false,
  };
}

test("itemFilterChannelId groups a thread under its parent channel, not its thread channel", () => {
  assert.equal(itemFilterChannelId(threadItem("thread-xyz", "eng", "engineering")), "eng");
  assert.equal(itemFilterChannelId(channelItem("eng", "engineering")), "eng");
  assert.equal(itemFilterChannelId(channelItem("dm-1", "Alice", "dm")), "dm-1");
  assert.equal(itemFilterChannelId(mentionItem("eng", "engineering")), "eng");
});

test("itemFilterChannelLabel resolves DM peer name and parent-channel prefixes", () => {
  const dmChannels: ChannelLike[] = [{ id: "dm-1", name: "fallback", type: "dm", peerDisplayName: "Alice", peerName: "alice" }];
  assert.equal(itemFilterChannelLabel(channelItem("dm-1", "fallback", "dm"), [], dmChannels), "@Alice");
  assert.equal(itemFilterChannelLabel(threadItem("t1", "eng", "engineering"), [], []), "#engineering");
  assert.equal(itemFilterChannelLabel(channelItem("eng", "engineering"), [], []), "#engineering");
});

test("channelFilterOptionLabel uses peer labels for DMs", () => {
  assert.equal(channelFilterOptionLabel({ id: "dm-1", name: "fallback", type: "dm", peerDisplayName: "Alice" }), "@Alice");
  assert.equal(channelFilterOptionLabel({ id: "eng", name: "engineering", type: "channel" }), "#engineering");
});

test("inboxChannelFilterOptions dedups, excludes threads and archived channels, and sorts by label", () => {
  const channels: ChannelLike[] = [
    { id: "random", name: "random", type: "channel" },
    { id: "eng", name: "engineering", type: "channel" },
    { id: "thread-1", name: "thread", type: "thread" },
    { id: "archived", name: "archived", type: "channel", archivedAt: "2026-07-11T00:00:00Z" },
  ];
  const dmChannels: ChannelLike[] = [
    { id: "dm-1", name: "fallback", type: "dm", peerDisplayName: "Alice" },
    { id: "eng", name: "duplicate", type: "channel" },
  ];
  assert.deepEqual(inboxChannelFilterOptions(channels, dmChannels), [
    { id: "dm-1", label: "@Alice" },
    { id: "eng", label: "#engineering" },
    { id: "random", label: "#random" },
  ]);
});
