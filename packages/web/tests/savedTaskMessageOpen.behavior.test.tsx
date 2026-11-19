import "./helpers/domSetup";
import assert from "node:assert/strict";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import SavedPanel from "../src/components/saved/SavedPanel";
import { useSavedStore } from "../src/store/savedStore";
import type { SavedEntry } from "../src/store/savedStore";
import { useServerStore } from "../src/store/serverStore";
import { useThreadStore } from "../src/store/threadStore";
import { renderWithIntl } from "./helpers/intl";

// artin: a saved message from a task's own conversation (task v2) opened as
// its conversation id, `/channel/<task conversation>`: the bare `#task-…`
// sub-conversation with only a Join that can't work, no way to reply. It opens
// the task over its channel, at the message, as search and Activity open one.

const originalSaved = useSavedStore.getState();
const originalServer = useServerStore.getState();
const originalThread = useThreadStore.getState();

const TASK_ENTRY: SavedEntry = {
  messageId: "msg-3",
  channelId: "ch-task-7",
  channelName: "task-959a9d55",
  channelType: "task",
  content: "the saved task message",
  senderType: "user",
  senderId: "user-1",
  senderName: "Lagoon",
  senderAvatarUrl: null,
  createdAt: "2026-11-14T03:02:00.000Z",
  savedAt: "2026-11-14T03:03:00.000Z",
  parentChannelId: "ch-general",
  parentChannelName: "general",
  parentChannelType: "channel",
  parentMessageId: null,
  taskId: "task-7",
  taskNumber: 7,
  taskTitle: "Hands feedback",
};

let shown = "";
function LocationProbe() {
  const location = useLocation();
  shown = `${location.pathname}${location.search}`;
  return null;
}

beforeEach(() => {
  useServerStore.setState({ current: { id: "srv-1", slug: "raft", name: "Raft" } as never });
  useSavedStore.setState({
    saved: [TASK_ENTRY],
    total: 1,
    hasMore: false,
    loading: false,
    loadSaved: async () => true,
  });
});

afterEach(() => {
  cleanup();
  useSavedStore.setState(originalSaved, true);
  useServerStore.setState(originalServer, true);
  useThreadStore.setState(originalThread, true);
});

test("a saved task message opens the task over its channel, at the message, not the task's own channel page", async () => {
  renderWithIntl(
    <MemoryRouter initialEntries={["/s/raft/saved"]}>
      <Routes>
        <Route path="/s/raft/saved" element={<SavedPanel />} />
        <Route path="*" element={null} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
  const row = screen.getByText("the saved task message").closest("[data-saved-row]");
  if (!row) throw new Error("no saved row");
  assert.equal(row.textContent?.includes("#general"), true, "the row names the task's channel");
  assert.equal(row.textContent?.includes("task-959a9d55"), false, "not the conversation's internal name");
  await act(async () => {
    fireEvent.click(row);
  });
  assert.equal(shown.startsWith("/s/raft/channel/ch-general?"), true, `opened ${shown}`);
  assert.equal(new URLSearchParams(shown.split("?")[1]).get("task"), "ch-general:task:task-7");
  const taskModal = useThreadStore.getState().taskModal;
  assert.equal(taskModal?.taskId, "task-7");
  assert.equal(taskModal?.threadChannelId, "ch-task-7");
  assert.equal(taskModal?.focusedMessageId, "msg-3");
});
