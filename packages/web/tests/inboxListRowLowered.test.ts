import assert from "node:assert/strict";
import type { InboxItem } from "../src/store/inboxStore";
import { reportListRowsLowered } from "../src/store/inboxListRowLowered";
import { __setStateTransitionEmitterForTest } from "../src/utils/stateTransitionTrace";

// #triage:#244 diagnostic: a list answer that leaves a row below what it served names the step.
const row = (channelId: string, unreadCount: number) => ({ kind: "channel", channelId, unreadCount, hasMention: false } as unknown as InboxItem);

function capture() {
  const events: Array<Record<string, unknown>> = [];
  __setStateTransitionEmitterForTest((name, attrs) => {
    if (name === "slock.state.transition") events.push(attrs as Record<string, unknown>);
  });
  return events;
}

afterEach(() => __setStateTransitionEmitterForTest(null));

test("a row the answer served at 8 and the page left at 0 names the first step that lowered it, with counts only", () => {
  const events = capture();
  reportListRowsLowered({
    served: [row("a", 8), row("b", 2)],
    before: [row("a", 8), row("b", 2)],
    stages: [["ledger", [row("a", 8), row("b", 2)]], ["read_hold", [row("a", 0), row("b", 2)]], ["projection", [row("a", 0), row("b", 2)]]],
    reason: "reconnect", trigger: undefined, rowPosition: true, now: 1,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]["inbox.lowered.step"], "read_hold");
  assert.deepEqual(
    ["before", "served", "after", "fetch_reason", "fetch_trigger", "row_position"].map((k) => events[0][`inbox.lowered.${k}`]),
    ["8", "8", "0", "reconnect", "none", "true"],
  );
  assert.ok(!JSON.stringify(events[0]).includes('"a"'), "no row or channel id");
});

test("nothing is sent when every row ends at or above what was served", () => {
  const events = capture();
  reportListRowsLowered({
    served: [row("a", 8)], before: [row("a", 9)],
    stages: [["merge", [row("a", 9)]], ["projection", [row("a", 8)]]],
    reason: "resume_gap", trigger: undefined, rowPosition: false, now: 1,
  });
  assert.equal(events.length, 0);
});
