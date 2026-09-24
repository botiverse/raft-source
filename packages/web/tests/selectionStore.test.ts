import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { useSelectionStore } from "../src/store/selectionStore";

describe("selectionStore", () => {
  beforeEach(() => {
    useSelectionStore.getState().exit();
  });

  it("enter() seeds selectedIds with the supplied initialIds", () => {
    useSelectionStore.getState().enter("ch-1", ["m1", "m2", "m3"]);
    const s = useSelectionStore.getState();
    assert.equal(s.isActive, true);
    assert.equal(s.channelId, "ch-1");
    assert.equal(s.threadRootId, null);
    assert.deepEqual([...s.selectedIds].sort(), ["m1", "m2", "m3"]);
  });

  it("enterThread() defaults to selecting just the root id when initialIds is empty", () => {
    useSelectionStore.getState().enterThread("thread-ch", "root-id", "parent-ch");
    const s = useSelectionStore.getState();
    assert.equal(s.threadRootId, "root-id");
    assert.equal(s.threadRootChannelId, "parent-ch");
    assert.equal(s.channelId, "thread-ch");
    assert.deepEqual([...s.selectedIds], ["root-id"]);
  });

  it("enterThread() pre-selects only the supplied trigger id", () => {
    useSelectionStore
      .getState()
      .enterThread("thread-ch", "root-id", "parent-ch", ["r1"]);
    assert.deepEqual([...useSelectionStore.getState().selectedIds], ["r1"]);
  });

  it("selectAll() replaces the active selection with parent + every reply", () => {
    useSelectionStore.getState().enterThread("thread-ch", "root-id", "parent-ch", ["r1"]);
    useSelectionStore.getState().selectAll(["root-id", "r1", "r2"]);
    assert.deepEqual([...useSelectionStore.getState().selectedIds].sort(), [
      "r1",
      "r2",
      "root-id",
    ]);
  });

  it("toggleWithThread() flips parent + replies as a group", () => {
    useSelectionStore.getState().enter("ch-1", ["other"]);
    useSelectionStore.getState().toggleWithThread("p", ["r1", "r2"]);
    assert.deepEqual([...useSelectionStore.getState().selectedIds].sort(), [
      "other",
      "p",
      "r1",
      "r2",
    ]);
    // Toggling again removes the whole group.
    useSelectionStore.getState().toggleWithThread("p", ["r1", "r2"]);
    assert.deepEqual([...useSelectionStore.getState().selectedIds], ["other"]);
  });

  it("exit() clears everything including thread anchors", () => {
    useSelectionStore.getState().enterThread("t", "root", "p", ["root", "r1"]);
    useSelectionStore.getState().exit();
    const s = useSelectionStore.getState();
    assert.equal(s.isActive, false);
    assert.equal(s.channelId, null);
    assert.equal(s.threadRootId, null);
    assert.equal(s.threadRootChannelId, null);
    assert.equal(s.selectedIds.size, 0);
  });
});
