import { useProfileStore } from "../src/store/profileStore";
import { useSearchContentStore } from "../src/store/searchContentStore";
import { isThreadMaximized, useUIStore } from "../src/store/uiStore";
import { useThreadStore } from "../src/store/threadStore";
import { useMessageStore } from "../src/store/messageStore";
import { holdAutoRead, releaseAutoRead } from "../src/store/autoReadHold";
import assert from "node:assert/strict";
import {
  canAutoMarkLiveAppendRead,
  canAutoMarkCurrentChannelRead,
  filterUnreadCountsByLocalReadSuppressions,
} from "../src/store/messageStore";

test("filters stale unread snapshots while a local read is still settling", () => {
  const suppressions = new Map([
    ["channel-read-locally", { seq: 42, expiresAt: 2_000 }],
  ]);

  const filtered = filterUnreadCountsByLocalReadSuppressions(
    {
      "channel-read-locally": 3,
      "channel-still-unread": 2,
    },
    suppressions,
    1_000,
  );

  assert.deepEqual(filtered, { "channel-still-unread": 2 });
});

test("allows server unread snapshots through after the local read suppression expires", () => {
  const suppressions = new Map([
    ["channel-read-locally", { seq: 42, expiresAt: 2_000 }],
  ]);

  const filtered = filterUnreadCountsByLocalReadSuppressions(
    { "channel-read-locally": 3 },
    suppressions,
    2_001,
  );

  assert.deepEqual(filtered, { "channel-read-locally": 3 });
  assert.equal(suppressions.has("channel-read-locally"), false);
});

test("auto-read only runs when the document is visible and focused", () => {
  assert.equal(
    canAutoMarkCurrentChannelRead({ visibilityState: "visible", hasFocus: () => true }, () => true),
    true
  );
  assert.equal(
    canAutoMarkCurrentChannelRead({ visibilityState: "hidden", hasFocus: () => true }, () => true),
    false
  );
  assert.equal(
    canAutoMarkCurrentChannelRead({ visibilityState: "visible", hasFocus: () => false }, () => true),
    false
  );
  assert.equal(
    canAutoMarkCurrentChannelRead({ visibilityState: "visible", hasFocus: () => true }, () => false),
    false
  );
});

test("live append auto-read requires explicit user activity in this tab", () => {
  assert.equal(
    canAutoMarkLiveAppendRead(
      { visibilityState: "visible", hasFocus: () => true },
      () => true,
      () => false,
    ),
    false
  );
  assert.equal(
    canAutoMarkLiveAppendRead(
      { visibilityState: "visible", hasFocus: () => true },
      () => true,
      () => true,
    ),
    true
  );
  assert.equal(
    canAutoMarkLiveAppendRead(
      { visibilityState: "hidden", hasFocus: () => true },
      () => true,
      () => true,
    ),
    false
  );
  assert.equal(
    canAutoMarkLiveAppendRead(
      { visibilityState: "visible", hasFocus: () => false },
      () => true,
      () => true,
    ),
    false
  );
});


test("maximized thread suppresses channel auto-read until the channel is restored", () => {
  const ui = useUIStore.getState();
  const thread = useThreadStore.getState();
  const messages = useMessageStore.getState();
  try {
    useThreadStore.setState({ openParentMessageId: "parent", openParentChannelId: "channel", taskModal: null });
    useMessageStore.setState({ currentChannelId: "channel" });
    useUIStore.setState({ threadMaximized: false });
    const doc = { visibilityState: "visible" as const, hasFocus: () => true };
    useUIStore.getState().toggleThreadMaximized();
    assert.equal(canAutoMarkCurrentChannelRead(doc, () => true), false);
    assert.equal(canAutoMarkLiveAppendRead(doc, () => true, () => true), false);
    assert.equal(canAutoMarkLiveAppendRead(doc, () => true, () => true, "thread"), true);
    useMessageStore.setState({ currentChannelId: "other" });
    assert.equal(canAutoMarkCurrentChannelRead(doc, () => true), true);
    useMessageStore.setState({ currentChannelId: "channel" });
    useUIStore.getState().toggleThreadMaximized();
    assert.equal(canAutoMarkCurrentChannelRead(doc, () => true), true);
    useUIStore.getState().toggleThreadMaximized();
    useThreadStore.getState().closeThread();
    assert.equal(useUIStore.getState().threadMaximized, false);
    assert.equal(canAutoMarkCurrentChannelRead(doc, () => true), true);
  } finally {
    useUIStore.setState(ui); useThreadStore.setState(thread); useMessageStore.setState(messages);
  }
});

test("a profile suspends Focus Mode until it closes; content navigation restores the layout", () => {
  const ui = useUIStore.getState();
  const thread = useThreadStore.getState();
  const messages = useMessageStore.getState();
  const profile = useProfileStore.getState();
  const search = useSearchContentStore.getState();
  const doc = { visibilityState: "visible" as const, hasFocus: () => true };
  try {
    useThreadStore.setState({ openParentMessageId: "parent", openParentChannelId: "channel" });
    useMessageStore.setState({ currentChannelId: "channel" });
    useUIStore.setState({ threadMaximized: true });
    assert.equal(isThreadMaximized(true, "parent", "channel", "channel"), true);
    assert.equal(canAutoMarkCurrentChannelRead(doc, () => true), false);
    // The channel shows beside the profile, so it is readable meanwhile.
    useProfileStore.getState().openProfile("agent", "agent-1", { openSource: "thread" });
    assert.equal(useUIStore.getState().threadMaximized, true);
    assert.equal(canAutoMarkCurrentChannelRead(doc, () => true), true);
    useProfileStore.getState().closeProfile();
    assert.equal(canAutoMarkCurrentChannelRead(doc, () => true), false);
    useProfileStore.getState().openExternalProfile("ext", {} as never, { channelId: "channel" });
    assert.equal(useUIStore.getState().threadMaximized, true);
    useProfileStore.getState().closeProfile();
    useSearchContentStore.getState().open({ kind: "channel", id: "channel" });
    assert.equal(useUIStore.getState().threadMaximized, false);
    assert.equal(canAutoMarkCurrentChannelRead(doc, () => true), true);
    assert.equal(isThreadMaximized(true, "parent", "channel", "channel", true), false);
    assert.equal(isThreadMaximized(true, null, "channel", "channel"), false);
    assert.equal(isThreadMaximized(true, "parent", "channel", "other"), false);
  } finally {
    useUIStore.setState(ui); useThreadStore.setState(thread); useMessageStore.setState(messages);
    useProfileStore.setState(profile); useSearchContentStore.setState(search);
  }
});

test("a conversation Activity reopened on its own is not auto-read until released; others still are", () => {
  const previousChannel = useMessageStore.getState().currentChannelId;
  const previousUnread = useMessageStore.getState().unreadCounts;
  const previousMessages = useMessageStore.getState().messages;
  let readCalls = 0;
  let ended = 0;
  try {
    holdAutoRead("reopened", { read: () => { readCalls += 1; }, end: () => { ended += 1; } });
    useMessageStore.setState({
      currentChannelId: "reopened",
      unreadCounts: { reopened: 3, another: 2 },
      messages: [{ id: "m1", channelId: "reopened", seq: 7 } as never],
      hasNewer: false,
    });
    useMessageStore.getState().markCurrentChannelRead();
    assert.equal(useMessageStore.getState().unreadCounts.reopened, 3, "the held conversation keeps its unread");
    releaseAutoRead({ read: true });
    assert.equal(readCalls, 1);
    assert.equal(ended, 1);
    useMessageStore.getState().markCurrentChannelRead();
    assert.equal(useMessageStore.getState().unreadCounts.reopened, undefined, "released, it reads as usual");
    holdAutoRead("reopened", { read: () => { readCalls += 1; } });
    releaseAutoRead({ read: false });
    assert.equal(readCalls, 1, "leaving it does not read it");
  } finally {
    releaseAutoRead({ read: false });
    useMessageStore.setState({ currentChannelId: previousChannel, unreadCounts: previousUnread, messages: previousMessages });
  }
});
