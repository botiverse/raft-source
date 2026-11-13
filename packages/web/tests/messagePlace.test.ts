import assert from "node:assert/strict";
import { vi } from "vitest";

import { useChannelStore } from "../src/store/channelStore";
import type { Channel } from "../src/store/channelStore";
import { useThreadStore } from "../src/store/threadStore";
import { openMessagePlace, resolveMessagePlace } from "../src/utils/messagePlace";
import type { ConversationIdentity, MessagePlaceNav } from "../src/utils/messagePlace";

// cindyz, #triage:#107: an agent's activity holds only the conversation a
// message was posted in and its id. "Open message" opened that conversation
// as a page, so a thread reply landed on the bare thread sub-conversation
// ("thread-fc8d488f"). Where each kind of message opens (Noel for tasks):
//   - a channel or DM message: that channel or DM, at the message;
//   - a thread reply: its parent channel with the thread open, at the reply;
//   - a task message: the task's own conversation over its channel, at it.

const GENERAL = { id: "ch-general", name: "general", type: "channel" } as Channel;
const JOINT = { id: "ch-joint", name: "joint", type: "joint" } as Channel;
const DM = { id: "dm-alice", name: "alice", type: "dm" } as Channel;

beforeEach(() => {
  useChannelStore.setState({ channels: [GENERAL, JOINT], dmChannels: [DM] });
});

function loader(rows: Record<string, ConversationIdentity>) {
  return vi.fn(async (channelId: string) => {
    const row = rows[channelId];
    if (!row) throw new Error("404");
    return row;
  });
}

test("a channel or DM message in the sidebar opens in place, with no lookup", async () => {
  const load = loader({});
  assert.deepEqual(await resolveMessagePlace("ch-general", "m1", load), { kind: "channel", channelId: "ch-general", messageId: "m1" });
  assert.deepEqual(await resolveMessagePlace("dm-alice", "m2", load), { kind: "dm", channelId: "dm-alice", messageId: "m2" });
  assert.equal(load.mock.calls.length, 0);
});

test("a thread reply opens in its parent channel with the thread open at the reply", async () => {
  const load = loader({ "th-1": { type: "thread", parentChannelId: "ch-general", parentMessageId: "parent-1" } });
  assert.deepEqual(await resolveMessagePlace("th-1", "reply-1", load), {
    kind: "thread",
    parentChannelId: "ch-general",
    parentMessageId: "parent-1",
    parentRouteKind: "channel",
    messageId: "reply-1",
  });
});

test("a reply in a DM's thread opens under the DM route", async () => {
  const load = loader({ "th-dm": { type: "thread", parentChannelId: "dm-alice", parentMessageId: "parent-2" } });
  const place = await resolveMessagePlace("th-dm", "reply-2", load);
  assert.equal(place.kind, "thread");
  assert.equal(place.kind === "thread" && place.parentRouteKind, "dm");
});

test("a task message opens the task's own conversation, at the message", async () => {
  const load = loader({ "task-conv": { type: "task", parentChannelId: "ch-general", taskId: "task-7" } });
  assert.deepEqual(await resolveMessagePlace("task-conv", "m3", load), {
    kind: "task",
    taskId: "task-7",
    parentChannelId: "ch-general",
    parentRouteKind: "channel",
    conversationChannelId: "task-conv",
    messageId: "m3",
  });
});

test("a joint channel's task leaves the conversation to the dialog, as search does", async () => {
  const load = loader({ "task-joint": { type: "task", parentChannelId: "ch-joint", taskId: "task-8" } });
  const place = await resolveMessagePlace("task-joint", "m4", load);
  assert.equal(place.kind === "task" && place.conversationChannelId, null);
});

test("a conversation that cannot be looked up opens where the message was posted, as before", async () => {
  assert.deepEqual(await resolveMessagePlace("unknown", "m5", loader({})), { kind: "channel", channelId: "unknown", messageId: "m5" });
});

function fakeNav() {
  return {
    toMessage: vi.fn(),
    toDmMessage: vi.fn(),
    toThreadMessage: vi.fn(),
    toTaskConversation: vi.fn((_channel: string, _task: string, _kind?: string, onNavigated?: () => void) => onNavigated?.()),
  };
}

test("each place opens through its own route", () => {
  const nav = fakeNav();
  const asNav: MessagePlaceNav = nav;
  openMessagePlace({ kind: "channel", channelId: "ch-general", messageId: "m1" }, asNav);
  assert.deepEqual(nav.toMessage.mock.calls[0], ["ch-general", "m1"]);
  openMessagePlace({ kind: "dm", channelId: "dm-alice", messageId: "m2" }, asNav);
  assert.deepEqual(nav.toDmMessage.mock.calls[0], ["dm-alice", "m2"]);
  openMessagePlace({ kind: "thread", parentChannelId: "ch-general", parentMessageId: "p1", parentRouteKind: "channel", messageId: "r1" }, asNav);
  assert.deepEqual(nav.toThreadMessage.mock.calls[0], ["ch-general", "p1", "r1", "channel"]);
  assert.equal(nav.toMessage.mock.calls.length, 1, "a thread reply never opens its sub-conversation as a page");
});

test("a task message opens the task conversation over its channel, then focuses the message", () => {
  const nav = fakeNav();
  const openTaskConversation = vi.spyOn(useThreadStore.getState(), "openTaskConversation").mockImplementation(() => {});
  try {
    openMessagePlace(
      { kind: "task", taskId: "task-7", parentChannelId: "ch-general", parentRouteKind: "channel", conversationChannelId: "task-conv", messageId: "m3" },
      nav,
    );
    assert.deepEqual(nav.toTaskConversation.mock.calls[0]?.slice(0, 3), ["ch-general", "task-7", "channel"]);
    assert.deepEqual(openTaskConversation.mock.calls[0]?.[0], {
      taskId: "task-7",
      parentChannelId: "ch-general",
      conversationChannelId: "task-conv",
      focusedMessageId: "m3",
    });
    assert.equal(nav.toMessage.mock.calls.length, 0, "not the channel timeline");
  } finally {
    openTaskConversation.mockRestore();
  }
});
