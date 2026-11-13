import assert from "node:assert/strict";
import { idsToViewportEdge, isRangeSelectableMessage, messageIdsInRange, rangeSelectablePredicate } from "../src/components/message/messageRangeSelection";
import { messageTimelineMessages } from "../src/components/message/messageTimelineShared";
import type { Message } from "../src/store/messageStore";
import { useSelectionStore } from "../src/store/selectionStore";

// Select to here / Shift+click (task #235): the range is pure, from the
// timeline's order, never from the mounted rows.

const IDS = ["a", "b", "c", "d", "e"];

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "m", channelId: "ch", senderType: "user", senderId: "u", senderName: "Ada",
    messageType: "chat", content: "hi", createdAt: "2026-07-03T00:00:00.000Z", seq: 1, ...overrides,
  };
}

describe("messageIdsInRange", () => {
  it("takes a forward range, both ends included, in list order", () => {
    assert.deepEqual(messageIdsInRange(IDS, "b", "d"), ["b", "c", "d"]);
  });

  it("takes a backward range in list order too", () => {
    assert.deepEqual(messageIdsInRange(IDS, "d", "a"), ["a", "b", "c", "d"]);
  });

  it("has no range without an anchor, or with one no longer in the list", () => {
    assert.equal(messageIdsInRange(IDS, null, "c"), null);
    assert.equal(messageIdsInRange(IDS, undefined, "c"), null);
    assert.equal(messageIdsInRange(IDS, "gone", "c"), null);
    assert.equal(messageIdsInRange(IDS, "a", "gone"), null);
  });

  it("skips what can't be selected", () => {
    assert.deepEqual(messageIdsInRange(IDS, "a", "e", (id) => id !== "b" && id !== "d"), ["a", "c", "e"]);
  });

  it("anchor equal to target is that one message", () => {
    assert.deepEqual(messageIdsInRange(IDS, "c", "c"), ["c"]);
    assert.deepEqual(messageIdsInRange(IDS, "c", "c", () => false), []);
  });
});

// Select to here, the pill (task #235): from the anchor to the edge of the view
// furthest from it. The timeline is a..j; the view shows e..g.
describe("idsToViewportEdge", () => {
  const ORDER = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
  const VIEW = ["e", "f", "g"];

  it("anchor above the view: down to the last message in view, which is the next anchor", () => {
    assert.deepEqual(idsToViewportEdge(ORDER, "b", VIEW), { ids: ["b", "c", "d", "e", "f", "g"], edgeId: "g", direction: "up" });
  });

  it("anchor below the view: up to the first message in view", () => {
    assert.deepEqual(idsToViewportEdge(ORDER, "i", VIEW), { ids: ["e", "f", "g", "h", "i"], edgeId: "e", direction: "down" });
  });

  it("skips what can't be selected, and an edge that can't be is passed over for the next one in view", () => {
    // d is an action card; g, the bottom edge, a system message.
    const selectable = (id: string) => id !== "d" && id !== "g";
    assert.deepEqual(idsToViewportEdge(ORDER, "b", VIEW, selectable), { ids: ["b", "c", "e", "f"], edgeId: "f", direction: "up" });
    assert.deepEqual(idsToViewportEdge(ORDER, "j", ["f", "g"], (id) => id !== "f"), { ids: ["g", "h", "i", "j"], edgeId: "g", direction: "down" });
  });

  it("nothing to take when nothing in view can be selected", () => {
    assert.equal(idsToViewportEdge(ORDER, "b", VIEW, (id) => !VIEW.includes(id)), null);
  });

  it("nothing to take without an anchor, or with one not in the timeline", () => {
    assert.equal(idsToViewportEdge(ORDER, null, VIEW), null);
    assert.equal(idsToViewportEdge(ORDER, undefined, VIEW), null);
    assert.equal(idsToViewportEdge(ORDER, "gone", VIEW), null);
  });

  it("nothing to take while the anchor is in view (the pill is hidden), or with nothing in view", () => {
    assert.equal(idsToViewportEdge(ORDER, "f", VIEW), null);
    assert.equal(idsToViewportEdge(ORDER, "e", VIEW), null);
    assert.equal(idsToViewportEdge(ORDER, "b", []), null);
  });

  it("reads the view in any order", () => {
    assert.deepEqual(idsToViewportEdge(ORDER, "a", ["g", "e", "f"])?.edgeId, "g");
  });
});

describe("rangeSelectablePredicate", () => {
  it("is isRangeSelectableMessage without ids, else membership", () => {
    assert.equal(rangeSelectablePredicate(), isRangeSelectableMessage);
    const inThread = rangeSelectablePredicate(["m"]);
    assert.equal(inThread(message({ messageType: "system" })), true, "the thread's ids decide");
    assert.equal(inThread(message({ id: "other" })), false);
  });
});

describe("isRangeSelectableMessage", () => {
  it("takes plain messages; skips system updates, action cards, forwarded bundles and retracted ones", () => {
    assert.equal(isRangeSelectableMessage(message()), true);
    assert.equal(isRangeSelectableMessage(message({ messageType: "system" })), false);
    assert.equal(isRangeSelectableMessage(message({ actionMetadata: { kind: "task-card" } } as Partial<Message>)), false);
    assert.equal(isRangeSelectableMessage(message({ actionMetadata: { kind: "forwarded-bundle" } } as Partial<Message>)), false);
    assert.equal(isRangeSelectableMessage(message({ deletedAt: "2026-07-03T00:00:00.000Z" } as Partial<Message>)), false);
  });
});

describe("messageTimelineMessages", () => {
  it("is the parent's leading row, then every message; boundaries and a hidden parent add nothing", () => {
    const parent = message({ id: "p" });
    const replies = [message({ id: "r1" }), message({ id: "r2" })];
    assert.deepEqual(
      messageTimelineMessages([{ kind: "parent", message: parent }, { kind: "boundary", variant: "replies-start" }], replies).map((m) => m.id),
      ["p", "r1", "r2"],
    );
    assert.deepEqual(
      messageTimelineMessages([{ kind: "parent", message: null }, { kind: "boundary", variant: "start" }], replies).map((m) => m.id),
      ["r1", "r2"],
    );
  });
});

describe("selectionStore anchor", () => {
  beforeEach(() => useSelectionStore.getState().exit());

  it("starts at the first message, follows what is added (toggles and ranges), and ends with the selection", () => {
    const store = useSelectionStore.getState;
    store().enter("ch", ["b"]);
    assert.equal(store().anchorId, "b");
    store().toggle("d");
    assert.equal(store().anchorId, "d", "an added message is the anchor");
    store().toggle("b");
    assert.equal(store().anchorId, "d", "deselecting another message leaves it");
    store().toggle("b");
    assert.equal(store().anchorId, "b");
    store().toggle("b");
    assert.equal(store().anchorId, null, "deselecting the anchor leaves none");
    store().toggle("d");
    store().toggle("d");
    assert.equal(store().anchorId, "d", "re-added, it is the anchor again");
    store().selectRange(["a", "b", "c"], "a");
    assert.deepEqual([...store().selectedIds].sort(), ["a", "b", "c", "d"], "a range only adds");
    assert.equal(store().anchorId, "a");
    store().selectAll([]);
    assert.equal(store().anchorId, null, "clearing drops the anchor");
    store().exit();
    assert.equal(store().anchorId, null);
  });

  it("a thread entered with nothing anchors at its root", () => {
    useSelectionStore.getState().enterThread("thread", "root", "ch");
    assert.equal(useSelectionStore.getState().anchorId, "root");
  });

  it("does nothing while inactive", () => {
    useSelectionStore.getState().selectRange(["a"], "a");
    assert.equal(useSelectionStore.getState().selectedIds.size, 0);
    assert.equal(useSelectionStore.getState().anchorId, null);
  });
});
