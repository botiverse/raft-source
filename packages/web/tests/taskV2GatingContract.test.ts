// Task v2 (`task_v2_conversations_v0`) moves a channel's tasks into a card
// beside the message list. The mounted behavior lives in taskChipList /
// channelTasksPanel / messageInputAsTaskShortcut behavior tests; this file
// pins the side-card store's persistence.

import assert from "node:assert/strict";

test("channelSideCardStore round-trips open state through localStorage", async () => {
  const storage = new Map<string, string>([["slock:channelSideCards", JSON.stringify({ tasks: true, files: "yes" })]]);
  const fakeWindow = {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
    },
  };
  const hadWindow = "window" in globalThis;
  const previousWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = fakeWindow;
  try {
    vi.resetModules();
    const { useChannelSideCardStore } = await import("../src/store/channelSideCardStore");

    // Only a literal `true` opens a card; the filter is not persisted.
    assert.deepEqual(useChannelSideCardStore.getState().open, { tasks: true, files: false });
    assert.equal(useChannelSideCardStore.getState().taskFilter, "all");

    useChannelSideCardStore.getState().setCardOpen("files", true);
    assert.deepEqual(JSON.parse(storage.get("slock:channelSideCards") ?? "null"), { tasks: true, files: true });

    useChannelSideCardStore.getState().setCardOpen("tasks", false);
    assert.deepEqual(JSON.parse(storage.get("slock:channelSideCards") ?? "null"), { tasks: false, files: true });

    useChannelSideCardStore.getState().setTaskFilter("mine");
    assert.equal(storage.size, 1);

    // Opening a card makes it the one shown where only one fits.
    useChannelSideCardStore.getState().setCardOpen("tasks", true);
    assert.ok(useChannelSideCardStore.getState().cardFocusAt.tasks > 0);

    // A folded card stays folded across reloads.
    useChannelSideCardStore.getState().setCardCollapsed("files", true);
    assert.deepEqual(JSON.parse(storage.get("slock:channelSideCardsCollapsed") ?? "null"), { tasks: false, files: true });
  } finally {
    if (hadWindow) (globalThis as { window?: unknown }).window = previousWindow;
    else delete (globalThis as { window?: unknown }).window;
    vi.resetModules();
  }
});
