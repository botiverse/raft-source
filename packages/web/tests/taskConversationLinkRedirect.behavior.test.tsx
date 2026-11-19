import "./helpers/domSetup";
import assert from "node:assert/strict";
import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigationType, useParams } from "react-router-dom";

import { useTaskConversationRedirect } from "../src/hooks/useTaskConversationRedirect";
import { useChannelStore } from "../src/store/channelStore";
import type { Channel } from "../src/store/channelStore";
import { useServerStore } from "../src/store/serverStore";
import { useThreadStore } from "../src/store/threadStore";
import { notePageLocation, pageLandingAt, resetPageLandingForTests } from "../src/utils/pageLanding";

// A task message's Copy link (the mobile app's, Saved's) is
// `/channel/<task conversation>?msg=…`. Opened, it showed the bare `#task-…`
// sub-conversation with only a Join the server refuses (`thread_membership`).
// The channel route takes the task route instead, in place of the link's
// history entry: the task over its channel, the dialog at the message.

const originalChannels = useChannelStore.getState();
const originalServer = useServerStore.getState();
const originalThread = useThreadStore.getState();

let shown = "";
let navigationType = "";
let pageRendered = false;
function LocationProbe() {
  const location = useLocation();
  shown = `${location.pathname}${location.search}`;
  navigationType = useNavigationType();
  return null;
}

/** ChannelRoute's shape: the redirect, else the channel page. */
function ChannelRouteHarness() {
  const { channelId } = useParams<{ channelId: string }>();
  const toTask = useTaskConversationRedirect(channelId);
  if (toTask) return null;
  // ChannelById: with the row in the store, it would show the conversation's page.
  if (channelId === "ch-task-7" && useChannelStore.getState().channels.some((c) => c.id === channelId)) pageRendered = true;
  return null;
}

function taskConversationRow(parentChannelId: string): Channel {
  return {
    id: "ch-task-7",
    name: "task-959a9d55",
    description: null,
    type: "task",
    createdAt: "2026-11-14T03:00:00.000Z",
    parentChannelId,
    taskId: "task-7",
  } as unknown as Channel;
}

function channelRow(id: string, type: Channel["type"]): Channel {
  return { id, name: id, description: null, type, createdAt: "2026-11-14T03:00:00.000Z" } as Channel;
}

beforeEach(() => {
  shown = "";
  navigationType = "";
  pageRendered = false;
  useServerStore.setState({ current: { id: "srv-1", slug: "raft", name: "Raft" } as never });
  useChannelStore.setState({ channels: [channelRow("ch-general", "channel"), channelRow("ch-joint", "joint")], dmChannels: [channelRow("dm-1", "dm")] });
});

afterEach(() => {
  cleanup();
  resetPageLandingForTests();
  useChannelStore.setState(originalChannels, true);
  useServerStore.setState(originalServer, true);
  useThreadStore.setState(originalThread, true);
});

async function openLink(url: string, parentChannelId: string) {
  render(
    <MemoryRouter initialEntries={["/s/raft/saved", url]} initialIndex={1}>
      <Routes>
        <Route path="/s/raft/channel/:channelId" element={<ChannelRouteHarness />} />
        <Route path="/s/raft/dm/:dmId" element={null} />
        <Route path="*" element={null} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
  // The route's own fetch (ensureChannel) brings the conversation's row.
  await act(async () => {
    useChannelStore.setState((s) => ({ channels: [...s.channels, taskConversationRow(parentChannelId)] }));
  });
}

test("a link to a task's conversation opens the task over its channel, at the message, replacing the link", async () => {
  await openLink("/s/raft/channel/ch-task-7?msg=msg-3", "ch-general");
  assert.equal(shown.startsWith("/s/raft/channel/ch-general?"), true, `ended on ${shown}`);
  assert.equal(new URLSearchParams(shown.split("?")[1]).get("task"), "ch-general:task:task-7");
  assert.equal(navigationType, "REPLACE", "the link's entry is replaced, so Back doesn't return to it");
  assert.equal(pageRendered, false, "the task conversation is never shown as a channel page");
  const taskModal = useThreadStore.getState().taskModal;
  assert.equal(taskModal?.taskId, "task-7");
  assert.equal(taskModal?.threadChannelId, "ch-task-7");
  assert.equal(taskModal?.focusedMessageId, "msg-3");
});

test("a link landed from outside keeps its open-in-app offer on the task route", async () => {
  resetPageLandingForTests({ pathname: "/s/raft/channel/ch-task-7", search: "?msg=msg-3" });
  // The offers' strip has shown it on the landed address.
  notePageLocation("/s/raft/channel/ch-task-7");
  await openLink("/s/raft/channel/ch-task-7?msg=msg-3", "ch-general");
  assert.equal(shown.startsWith("/s/raft/channel/ch-general?"), true, `ended on ${shown}`);
  // The strip notes the new location, as it does on every location change.
  notePageLocation("/s/raft/channel/ch-general");
  assert.equal(pageLandingAt("/s/raft/channel/ch-general")?.pathname, "/s/raft/channel/ch-task-7", "the landing moved with the redirect");
});

test("a DM's task opens over the DM", async () => {
  await openLink("/s/raft/channel/ch-task-7?msg=msg-3", "dm-1");
  assert.equal(shown.startsWith("/s/raft/dm/dm-1?"), true, `ended on ${shown}`);
  assert.equal(useThreadStore.getState().taskModal?.focusedMessageId, "msg-3");
});

test("a joint channel's task leaves its conversation to the dialog, as search does", async () => {
  await openLink("/s/raft/channel/ch-task-7?msg=msg-3", "ch-joint");
  assert.equal(shown.startsWith("/s/raft/channel/ch-joint?"), true, `ended on ${shown}`);
  const taskModal = useThreadStore.getState().taskModal;
  assert.equal(taskModal?.taskId, "task-7");
  assert.equal(taskModal?.threadChannelId == null, true);
  assert.equal(taskModal?.focusedMessageId, "msg-3");
});

test("an ordinary channel's link stays on its page", async () => {
  render(
    <MemoryRouter initialEntries={["/s/raft/channel/ch-general?msg=msg-1"]}>
      <Routes>
        <Route path="/s/raft/channel/:channelId" element={<ChannelRouteHarness />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
  assert.equal(shown, "/s/raft/channel/ch-general?msg=msg-1");
  assert.equal(useThreadStore.getState().taskModal == null, true);
});
