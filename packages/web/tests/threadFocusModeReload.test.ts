import assert from "node:assert/strict";
import { useUIStore } from "../src/store/uiStore";
import { useThreadStore } from "../src/store/threadStore";

const KEY = "raft.threadFocusParentMessageId";

function installSessionStorage(): Map<string, string> {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
  return data;
}

function openThread(parentMessageId: string, parentChannelId = "channel"): void {
  // The layout decision runs synchronously before openThread's first await.
  void useThreadStore.getState().openThread({
    parentChannelId,
    parentMessageId,
    threadChannelId: `thread-of-${parentMessageId}`,
  }).catch(() => {});
}

test("Focus Mode survives a reload of the same thread (task #49)", () => {
  const ui = useUIStore.getState();
  const thread = useThreadStore.getState();
  const storage = installSessionStorage();
  try {
    useThreadStore.setState({ openParentMessageId: "parent", openParentChannelId: "channel" });
    useUIStore.setState({ threadMaximized: false });
    useUIStore.getState().toggleThreadMaximized("parent");
    assert.equal(storage.get(KEY), "parent");

    // Reload: in-memory state is gone, the URL reopens the same thread.
    useUIStore.setState({ threadMaximized: false });
    useThreadStore.setState({ openParentMessageId: null, openParentChannelId: null });
    openThread("parent");
    assert.equal(useUIStore.getState().threadMaximized, true);
    assert.equal(storage.get(KEY), "parent", "a second reload still restores it");

    // Switching threads in the same channel keeps Focus Mode and follows it.
    useThreadStore.setState({ openParentMessageId: "parent", openParentChannelId: "channel" });
    openThread("sibling");
    assert.equal(useUIStore.getState().threadMaximized, true);
    assert.equal(storage.get(KEY), "sibling");

    // A thread in another channel, closing the thread, or leaving Focus Mode forgets it.
    useThreadStore.setState({ openParentMessageId: "sibling", openParentChannelId: "channel" });
    openThread("elsewhere", "other-channel");
    assert.equal(useUIStore.getState().threadMaximized, false);
    assert.equal(storage.has(KEY), false);
    useUIStore.getState().toggleThreadMaximized("elsewhere");
    useThreadStore.getState().closeThread();
    assert.equal(storage.has(KEY), false);
    useUIStore.getState().toggleThreadMaximized("parent");
    useUIStore.getState().toggleThreadMaximized("parent");
    assert.equal(storage.has(KEY), false);
  } finally {
    useUIStore.setState(ui); useThreadStore.setState(thread);
    delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  }
});

test("a cold load of a different thread does not inherit Focus Mode", () => {
  const ui = useUIStore.getState();
  const thread = useThreadStore.getState();
  const storage = installSessionStorage();
  try {
    storage.set(KEY, "parent");
    useUIStore.setState({ threadMaximized: true });
    useThreadStore.setState({ openParentMessageId: null, openParentChannelId: null });
    openThread("other");
    assert.equal(useUIStore.getState().threadMaximized, false);
    assert.equal(storage.has(KEY), false);
  } finally {
    useUIStore.setState(ui); useThreadStore.setState(thread);
    delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  }
});
