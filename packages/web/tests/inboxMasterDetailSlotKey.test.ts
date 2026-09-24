import assert from "node:assert/strict";
import test from "node:test";
import { getInboxItemKey } from "../src/store/inboxStore";
import type { InboxItem } from "../src/store/inboxStore";
import {
  parseSearchOpenParam,
  formatSearchOpenParam,
  useSearchContentStore,
} from "../src/store/searchContentStore";
import type {
  SearchContentSlot,
} from "../src/store/searchContentStore";

// Activity (Inbox) master/detail (stdrc #proj-activity:171042a3 2026-06-23):
// clicking a row opens it in col 3 via the shared content slot, exactly like a
// /search result. Two invariants make the "selected row stays highlighted in
// the master list" affordance work and are easy to silently break:
//
//   1. ThreadsInbox.handleOpen builds the slot id from the SAME field
//      getInboxItemKey derives the row key from (threadChannelId for threads,
//      channelId for channel/dm). If those diverge, the open row won't light up.
//   2. openItemKey = `${slot.kind}:${slot.id}` must equal getInboxItemKey for
//      the row that was opened.
//
// This test pins both by round-tripping a row → slot → key for every
// master/detail-eligible inbox kind.

function slotForItem(item: InboxItem): SearchContentSlot | null {
  // Mirror of ThreadsInbox.handleOpen's slot construction (desktop path).
  if (item.kind === "thread") return { kind: "thread", id: item.threadChannelId };
  if (item.kind === "dm") return { kind: "dm", id: item.channelId };
  if (item.kind === "channel") return { kind: "channel", id: item.channelId };
  // mention_action opens a channel slot but is intentionally not row-matched.
  return null;
}

const channelItem = {
  kind: "channel",
  channelId: "chan-1",
} as unknown as InboxItem;

const dmItem = {
  kind: "dm",
  channelId: "dm-1",
} as unknown as InboxItem;

const threadItem = {
  kind: "thread",
  threadChannelId: "thread-1",
  parentChannelId: "parent-1",
  parentMessageId: "pmsg-1",
} as unknown as InboxItem;

test("inbox master/detail — open slot key matches the row key for channel/dm/thread", () => {
  for (const item of [channelItem, dmItem, threadItem]) {
    const slot = slotForItem(item);
    assert.ok(slot, `expected a slot for kind ${item.kind}`);
    const openItemKey = `${slot.kind}:${slot.id}`;
    assert.equal(
      openItemKey,
      getInboxItemKey(item),
      `open slot key must equal the inbox row key for kind ${item.kind}`,
    );
  }
});

test("inbox master/detail — slot kinds round-trip through the ?open= URL param", () => {
  // The shared searchContentStore URL param must encode every kind the Activity
  // master/detail can open, so cold-load deeplinks (/inbox?open=thread:x)
  // restore the same col-3 surface.
  for (const slot of [channelItem, dmItem, threadItem].map(slotForItem)) {
    assert.ok(slot);
    const encoded = formatSearchOpenParam(slot);
    assert.deepEqual(parseSearchOpenParam(encoded), { kind: slot.kind, id: slot.id });
  }
});

test("search entity detail slots round-trip through the ?open= URL param", () => {
  const slots: SearchContentSlot[] = [
    { kind: "channel", id: "channel-1" },
    { kind: "dm", id: "dm-1" },
    { kind: "agent", id: "agent-1" },
    { kind: "human", id: "human-1" },
    { kind: "machine", id: "computer-1" },
  ];

  for (const slot of slots) {
    const encoded = formatSearchOpenParam(slot);
    assert.deepEqual(parseSearchOpenParam(encoded), slot);
  }
});

test("consuming Activity thread focus preserves the selected thread and retires only its message anchor", () => {
  useSearchContentStore.setState({
    slot: { kind: "thread", id: "thread-a", messageId: "reply-old" },
  });

  useSearchContentStore.getState().consumeMessageFocus("thread", "thread-a");
  assert.deepEqual(useSearchContentStore.getState().slot, {
    kind: "thread",
    id: "thread-a",
    messageId: undefined,
  });

  const retained = useSearchContentStore.getState().slot;
  useSearchContentStore.getState().consumeMessageFocus("thread", "thread-b");
  assert.equal(useSearchContentStore.getState().slot, retained, "a stale panel must not clear the active slot");
});
