import assert from "node:assert/strict";
import { createIntl } from "react-intl";
import {
  buildMessageTimelineRows,
  messageTimelineRowKey,
  messageTimelineRowKeyOfMessageId,
} from "../src/components/message/messageTimelineShared";
import type { MessageTimelineLeadingRow } from "../src/components/message/messageTimelineShared";
import { buildSystemMessageRenderStates, foldedSystemMessageIds } from "../src/components/message/systemMessageGrouping";
import { computeMessagePlacements, placeByIndex } from "../src/hooks/useMessagePlacement";
import { mergedMessages } from "../src/i18n/messages";
import type { Message } from "../src/store/messageStore";

// The virtual timeline's own logic that needs no layout: which rows the list
// gets (a collapsed system-message group is one row), where a jump to a
// message goes, and where an unmounted message sits relative to the view.
// The wrapper's behaviour on a stubbed scroller is in
// virtualMessageTimeline.behavior.test.tsx; the list itself is covered in
// Playwright (tests/e2e/tests/virtual-timeline.spec.ts).

const intl = createIntl({ locale: "en", defaultLocale: "en", messages: mergedMessages("en") });

function message(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    channelId: "channel-1",
    senderType: "user",
    senderId: "user-1",
    content: id,
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function taskEvent(n: number): Message {
  return message(`event-${n}`, { messageType: "system", senderId: "system", content: `Alice claimed #${n} "Task ${n}"` });
}

function collapsedChannel(events: number, tail: number) {
  const messages = [
    message("before"),
    ...Array.from({ length: events }, (_, i) => taskEvent(i + 1)),
    ...Array.from({ length: tail }, (_, i) => message(`tail-${i + 1}`)),
  ];
  const folded = foldedSystemMessageIds(messages, buildSystemMessageRenderStates(messages, intl.formatMessage));
  return { messages, folded };
}

test("a collapsed system-message group is one row: its hidden messages are not rows", () => {
  const { messages, folded } = collapsedChannel(60, 3);
  assert.equal(folded.size, 59, "every event but the summary's own is folded");
  for (const [id, owner] of folded) {
    assert.match(id, /^event-/);
    assert.equal(owner, "event-1");
  }
  const leading: MessageTimelineLeadingRow[] = [{ kind: "boundary", variant: "start" }];
  const rows = buildMessageTimelineRows(leading, messages, folded);
  assert.deepEqual(rows.map(messageTimelineRowKey), [
    "boundary:start",
    "message:before",
    "message:event-1",
    "message:tail-1",
    "message:tail-2",
    "message:tail-3",
  ]);
});

test("rows are stable per message object, and nothing is folded without groups", () => {
  const messages = [message("a"), message("b")];
  const first = buildMessageTimelineRows([], messages);
  const again = buildMessageTimelineRows([], [...messages, message("c")]);
  assert.equal(first[0], again[0], "an unchanged message keeps its row object");
  assert.equal(again.length, 3);
  assert.equal(foldedSystemMessageIds(messages, buildSystemMessageRenderStates(messages, intl.formatMessage)).size, 0);
});

test("a single system message between chat messages is its own row", () => {
  const messages = [message("a"), taskEvent(1), message("b"), taskEvent(2), taskEvent(3)];
  const folded = foldedSystemMessageIds(messages, buildSystemMessageRenderStates(messages, intl.formatMessage));
  assert.deepEqual([...folded], [["event-3", "event-2"]]);
});

test("a jump to a folded message goes to its group's row; the thread parent to the parent row", () => {
  const { folded } = collapsedChannel(5, 1);
  const parent: MessageTimelineLeadingRow[] = [{ kind: "parent", message: message("root") }];
  assert.equal(messageTimelineRowKeyOfMessageId("event-4", parent, folded), "message:event-1");
  assert.equal(messageTimelineRowKeyOfMessageId("tail-1", parent, folded), "message:tail-1");
  assert.equal(messageTimelineRowKeyOfMessageId("root", parent, folded), "parent:root");
});

test("an unmounted loaded message is placed by its index against the rows in view", () => {
  const order = new Map(["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"].map((id, i) => [id, i]));
  const bounds = { top: 100, bottom: 500 };
  // Mounted: m3 (above the view, overscan), m4..m6 (in view), m7 (below).
  const rows = [
    { id: "m3", top: 20, bottom: 90 },
    { id: "m4", top: 100, bottom: 200 },
    { id: "m5", top: 200, bottom: 300 },
    { id: "m6", top: 300, bottom: 400 },
    { id: "m7", top: 520, bottom: 600 },
  ];
  const placements = computeMessagePlacements(["m1", "m3", "m5", "m7", "m9", "not-loaded"], rows, bounds, order);
  assert.deepEqual(Object.fromEntries(placements), {
    m1: "above",
    m3: "above",
    m5: "visible",
    m7: "below",
    m9: "below",
  });
  assert.equal(placements.has("not-loaded"), false, "a message not loaded is the caller's to place");
  // Nothing mounted: no basis, nothing placed by index.
  assert.equal(computeMessagePlacements(["m1"], [], bounds, order).size, 0);
  assert.equal(placeByIndex(5, { first: 4, last: 6 }), "visible");
});
