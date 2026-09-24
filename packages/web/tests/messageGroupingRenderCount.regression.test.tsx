// Render-count regression probe for message grouping (#3 task #44, commit 52f711094).
//
// #2642-class regression: `computeMessageGrouping` returned a FRESH
// `MessageGroupState` object per message on every call, and ChatPanel recomputed
// it (useMemo dep = `messages`) on every new message. MessageItem is `memo(...)`
// with the DEFAULT (reference) comparator, so a fresh `groupState` ref broke the
// memo for EVERY mounted row → the whole (non-windowed) list re-rendered on
// message:new, re-introducing the O(N) churn #2642 fixed.
//
// Fix: consume grouping through `useStableMessageGrouping`, which reuses the
// prior per-message state object whenever its 5 fields are unchanged (stable
// ref → memo holds) and hands back a fresh object the moment any field changes
// (ref changes → that row correctly re-renders).
//
// Measurement note (why NOT the Profiler-based createRenderCounter harness):
// React `<Profiler onRender>` fires whenever the Profiler is re-rendered by its
// PARENT, even if the memo'd child inside bails out — so wrapping each row in a
// Profiler and appending from the parent counts the Timeline's re-render, not the
// row's memo bailout (it reports 3 whether or not the fix works). This probe
// instead counts the ROW's OWN render (increment in the Row body), which is
// exactly what the memo bailout gates.
// Run: pnpm --filter @botiverse/raft-web test:dom
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { memo, useState, act } from "react";
import { cleanup, render as rtlRender } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import {
  useStableMessageGrouping,
} from "../src/components/message/messageGrouping";
import type {
  GroupableMessage,
  MessageGroupState,
} from "../src/components/message/messageGrouping";

afterEach(cleanup);

// Per-message render counter, incremented inside the row body — counts the row's
// ACTUAL renders (a memo bailout means the body never runs), unlike a Profiler
// wrapper which fires on any parent re-render.
const rowRenders = new Map<string, number>();

// Mirror MessageItem: memo(...) with the DEFAULT comparator, consuming groupState.
const Row = memo(function Row({
  message,
  groupState,
}: {
  message: GroupableMessage;
  groupState?: MessageGroupState;
}) {
  rowRenders.set(message.id, (rowRenders.get(message.id) ?? 0) + 1);
  return <div data-id={message.id}>{groupState?.showAvatar ? "•" : ""}{message.id}</div>;
});

let setMessages: ((update: (prev: GroupableMessage[]) => GroupableMessage[]) => void) | null = null;

function Timeline({ initial }: { initial: GroupableMessage[] }) {
  const [messages, setState] = useState(initial);
  setMessages = setState;
  // Mirrors ChatPanel: grouping via the stable hook, looked up per row.
  const grouping = useStableMessageGrouping(messages);
  return (
    <>
      {messages.map((m) => (
        <Row key={m.id} message={m} groupState={grouping.get(m.id)} />
      ))}
    </>
  );
}

const M1_M3: GroupableMessage[] = [
  { id: "m1", senderType: "user", senderId: "u1", createdAt: "2026-07-02T10:00:00Z" },
  { id: "m2", senderType: "agent", senderId: "a1", createdAt: "2026-07-02T10:01:00Z" },
  { id: "m3", senderType: "agent", senderId: "a2", createdAt: "2026-07-02T10:02:00Z" },
];

test("[render-perf] appending a message must NOT re-render unchanged mounted rows (message-grouping #2642-class guard)", () => {
  rowRenders.clear();
  render(<Timeline initial={M1_M3} />);
  rowRenders.clear(); // ignore mount renders

  // New message from a NEW sender appended at the end. m1/m2/m3's grouping VALUES
  // are unaffected (m4 is first-in-its-own-group); with stable refs their
  // groupState object is reused, so the default-memo rows must not re-render.
  act(() => {
    setMessages!((prev) => [
      ...prev,
      { id: "m4", senderType: "user", senderId: "u2", createdAt: "2026-07-02T10:03:00Z" },
    ]);
  });

  const unchanged = (rowRenders.get("m1") ?? 0) + (rowRenders.get("m2") ?? 0) + (rowRenders.get("m3") ?? 0);
  assert.equal(
    rowRenders.get("m4"),
    1,
    `the newly appended row should render once (got ${rowRenders.get("m4")})`,
  );
  assert.equal(
    unchanged,
    0,
    `#2642-class regression: ${unchanged} unchanged rows re-rendered on message append ` +
      `(stable groupState refs should let the default-memo rows bail out). Expected 0.`,
  );
});

test("[render-perf] a message whose grouping VALUES genuinely change MUST re-render (no over-suppression)", () => {
  rowRenders.clear();
  render(<Timeline initial={M1_M3} />);
  rowRenders.clear();

  // Prepend an older message from the SAME sender + SAME day as m1. That flips
  // m1 from first-in-group (avatar/name shown, day divider) to a continuation
  // (isFirstInGroup false, showAvatar/showName false, showDayDivider false) — its
  // groupState VALUES change, so its object ref must change and m1 must re-render.
  // m2/m3's relationship to their own previous rows is unchanged → they must not.
  act(() => {
    setMessages!((prev) => [
      { id: "m0", senderType: "user", senderId: "u1", createdAt: "2026-07-02T09:59:00Z" },
      ...prev,
    ]);
  });

  assert.ok(
    (rowRenders.get("m1") ?? 0) >= 1,
    `m1's grouping changed (first-in-group → continuation) so it MUST re-render, but it did not — ` +
      `the reuse cache is over-suppressing genuinely-changed rows.`,
  );
  const stillStable = (rowRenders.get("m2") ?? 0) + (rowRenders.get("m3") ?? 0);
  assert.equal(
    stillStable,
    0,
    `m2/m3's grouping is unaffected by the prepend and must not re-render (got ${stillStable}).`,
  );
});

test("[render-perf] a MIDDLE insert that flips a neighbor's grouping re-renders ONLY that neighbor (position-variant over-suppression guard)", () => {
  rowRenders.clear();
  // m3 CONTINUES m2 here (same sender), unlike the M1_M3 fixture.
  render(
    <Timeline
      initial={[
        { id: "m1", senderType: "user", senderId: "u1", createdAt: "2026-07-02T10:00:00Z" },
        { id: "m2", senderType: "agent", senderId: "a1", createdAt: "2026-07-02T10:01:00Z" },
        { id: "m3", senderType: "agent", senderId: "a1", createdAt: "2026-07-02T10:02:00Z" },
      ]}
    />,
  );
  rowRenders.clear();

  // Insert a DIFFERENT-sender message between m2 and m3. m3's previous row is now
  // mX (different sender), so m3 flips continuation → first-in-group — its VALUES
  // change and it MUST re-render. m1/m2 are unaffected and must not.
  act(() => {
    setMessages!((prev) => [
      prev[0],
      prev[1],
      { id: "mX", senderType: "user", senderId: "u2", createdAt: "2026-07-02T10:01:30Z" },
      prev[2],
    ]);
  });

  assert.ok(
    (rowRenders.get("m3") ?? 0) >= 1,
    `m3's grouping flipped (continuation → first-in-group) on the middle insert so it MUST re-render.`,
  );
  const untouched = (rowRenders.get("m1") ?? 0) + (rowRenders.get("m2") ?? 0);
  assert.equal(
    untouched,
    0,
    `m1/m2 are unaffected by the middle insert and must not re-render (got ${untouched}).`,
  );
});
