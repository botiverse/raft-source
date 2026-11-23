import assert from "node:assert/strict";
import type { InboxItem } from "../src/store/inboxStore";
import { __resetPendingLocalReadsForTest, LOCAL_READ_ACK_WINDOW_MS, noteLocalReadAck, reportListRowsLowered } from "../src/store/inboxListRowLowered";
import { __setStateTransitionEmitterForTest, __setUrgentStateTransitionEmitterForTest } from "../src/utils/stateTransitionTrace";

// #triage:#244 diagnostic: a list answer that leaves a row below what it served names the step.
const row = (channelId: string, unreadCount: number) => ({ kind: "channel", channelId, unreadCount, hasMention: false } as unknown as InboxItem);

function capture() {
  const events: Array<Record<string, unknown>> = [];
  __setStateTransitionEmitterForTest((name, attrs) => {
    if (name === "slock.state.transition") events.push(attrs as Record<string, unknown>);
  });
  return events;
}

afterEach(() => {
  __resetPendingLocalReadsForTest();
  vi.useRealTimers();
  __setStateTransitionEmitterForTest(null);
  __setUrgentStateTransitionEmitterForTest(null);
});

test("a row the answer served at 8 and the page left at 0 names the first step that lowered it, with its counts", () => {
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
  assert.equal(events[0]["inbox.lowered.scope_id"], "a");
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

type Frontier = { kind: "present"; readStateVersion: number; maxReadSeq: string; latestActivity: { messageId: string; seq: string } | null };
const frontier = (version: number, readSeq: string, latestSeq: string): Frontier => ({ kind: "present", readStateVersion: version, maxReadSeq: readSeq, latestActivity: { messageId: "m", seq: latestSeq } });
const eventName = (attrs: Record<string, unknown>) => (attrs as { key?: { event?: string } }).key?.event;

test("a ledger step with a newer read that covers the answer's latest activity is a correction, not a lowering", () => {
  const events = capture();
  reportListRowsLowered({
    served: [row("a", 3)],
    servedFrontiers: [frontier(4, "90", "100")],
    ledgerOf: () => ({ readStateVersion: 5, maxReadSeq: 100 }),
    before: [],
    stages: [["ledger", [row("a", 0)]], ["projection", [row("a", 0)]]],
    reason: "initial", trigger: undefined, rowPosition: true, now: 1,
  });
  assert.equal(events.length, 1);
  assert.equal(eventName(events[0]), "activity:list_row_corrected");
  assert.deepEqual(
    ["step", "scope_id", "served_read_version", "served_read_seq", "served_latest_activity_seq", "ledger_read_version", "ledger_read_seq"].map((k) => events[0][`inbox.lowered.${k}`]),
    ["ledger", "a", "4", "90", "100", "5", "100"],
  );
});

test("a ledger step whose read stops below the answer's latest activity, or isn't newer, stays a lowering", () => {
  const events = capture();
  reportListRowsLowered({
    served: [row("a", 3), row("b", 2)],
    servedFrontiers: [frontier(4, "90", "100"), frontier(6, "90", "100")],
    ledgerOf: (scopeId) => (scopeId === "a" ? { readStateVersion: 5, maxReadSeq: 99 } : { readStateVersion: 5, maxReadSeq: 100 }),
    before: [],
    stages: [["ledger", [row("a", 0), row("b", 0)]], ["projection", [row("a", 0), row("b", 0)]]],
    reason: "visibility", trigger: undefined, rowPosition: true, now: 1,
  });
  assert.deepEqual(events.map(eventName), ["activity:list_row_lowered", "activity:list_row_lowered"]);
});

test("other steps stay lowerings even with a covering ledger read", () => {
  const events = capture();
  reportListRowsLowered({
    served: [row("a", 3)],
    servedFrontiers: [frontier(4, "90", "100")],
    ledgerOf: () => ({ readStateVersion: 5, maxReadSeq: 100 }),
    before: [],
    stages: [["ledger", [row("a", 3)]], ["read_hold", [row("a", 0)]], ["projection", [row("a", 0)]]],
    reason: "reconnect", trigger: undefined, rowPosition: true, now: 1,
  });
  assert.deepEqual(events.map(eventName), ["activity:list_row_lowered"]);
  assert.equal(events[0]["inbox.lowered.step"], "read_hold");
});

test("a row served twice in one answer is reported once", () => {
  const events = capture();
  reportListRowsLowered({
    served: [row("a", 3), row("a", 3)],
    before: [],
    stages: [["read_hold", [row("a", 0)]], ["projection", [row("a", 0)]]],
    reason: "reconnect", trigger: undefined, rowPosition: true, now: 1,
  });
  assert.equal(events.length, 1);
});

// Tenny, #triage:#244 (2026-11-16): a local_read lowering whose own read ack lands within the window and covers the answer is a correction.
function lowerByLocalRead(scopeId: string, latestSeq: string) {
  reportListRowsLowered({
    served: [row(scopeId, 20)],
    servedFrontiers: [frontier(4, "80", latestSeq)],
    ledgerOf: () => ({ readStateVersion: 4, maxReadSeq: 80 }),
    before: [row(scopeId, 20)],
    stages: [["ledger", [row(scopeId, 20)]], ["local_read", [row(scopeId, 0)]], ["projection", [row(scopeId, 0)]]],
    reason: "realtime_fallback", trigger: "thread_reply", rowPosition: true, now: 1_000,
  });
}

test("a local_read lowering is held, then sent as corrected when this tab's read ack covers the served latest activity", () => {
  vi.useFakeTimers();
  const events = capture();
  lowerByLocalRead("t", "100");
  assert.equal(events.length, 0);
  noteLocalReadAck("t", 100, 1_039);
  assert.deepEqual(events.map(eventName), ["activity:list_row_corrected"]);
  assert.deepEqual(
    ["step", "served", "after", "scope_id", "served_latest_activity_seq", "ack_read_seq", "ack_delay_ms"].map((k) => events[0][`inbox.lowered.${k}`]),
    ["local_read", "20", "0", "t", "100", "100", "39"],
  );
  vi.advanceTimersByTime(LOCAL_READ_ACK_WINDOW_MS);
  assert.equal(events.length, 1);
});

test("a local_read lowering stays a lowering when the ack stops below the served latest activity", () => {
  vi.useFakeTimers();
  const events = capture();
  lowerByLocalRead("t", "100");
  noteLocalReadAck("t", 99, 1_050);
  assert.deepEqual(events.map(eventName), ["activity:list_row_lowered"]);
  assert.equal(events[0]["inbox.lowered.ack_read_seq"], "99");
});

test("a local_read lowering with no ack inside the window is sent as a lowering when the window ends; a later ack changes nothing", () => {
  vi.useFakeTimers();
  const events = capture();
  lowerByLocalRead("t", "100");
  noteLocalReadAck("other", 100, 1_010);
  vi.advanceTimersByTime(LOCAL_READ_ACK_WINDOW_MS - 1);
  assert.equal(events.length, 0);
  vi.advanceTimersByTime(1);
  assert.deepEqual(events.map(eventName), ["activity:list_row_lowered"]);
  assert.deepEqual(["ack_read_seq", "ack_delay_ms"].map((k) => events[0][`inbox.lowered.${k}`]), ["-", "-"]);
  noteLocalReadAck("t", 100, 7_000);
  assert.equal(events.length, 1);
});

test("an ack without a usable seq is ignored, so a later valid ack in the window still decides", () => {
  vi.useFakeTimers();
  const events = capture();
  lowerByLocalRead("t", "100");
  noteLocalReadAck("t", undefined, 1_010);
  noteLocalReadAck("t", 1.5, 1_020);
  noteLocalReadAck("t", "abc", 1_030);
  assert.equal(events.length, 0);
  noteLocalReadAck("t", "100", 1_040);
  assert.deepEqual(events.map(eventName), ["activity:list_row_corrected"]);
});

test("a non-numeric served latest activity seq makes it a lowering, not a throw", () => {
  vi.useFakeTimers();
  const events = capture();
  lowerByLocalRead("t", "x1");
  noteLocalReadAck("t", 100, 1_010);
  assert.deepEqual(events.map(eventName), ["activity:list_row_lowered"]);
});

test("rows still held when the page goes away are sent at once, with keepalive, as lowerings (held_end=pagehide)", () => {
  vi.useFakeTimers();
  const queued = capture();
  const urgent: Array<Record<string, unknown>> = [];
  __setUrgentStateTransitionEmitterForTest((_name, attrs) => urgent.push(attrs));
  // Node test env: a bare EventTarget stands in for the window the module listens on.
  const page = new EventTarget();
  Object.defineProperty(globalThis, "window", { value: page, configurable: true });
  try {
    lowerByLocalRead("t", "100");
    lowerByLocalRead("u", "100");
    page.dispatchEvent(new Event("pagehide"));
  } finally {
    __resetPendingLocalReadsForTest();
    Reflect.deleteProperty(globalThis, "window");
  }
  assert.equal(queued.length, 0);
  assert.deepEqual(urgent.map(eventName), ["activity:list_row_lowered", "activity:list_row_lowered"]);
  assert.deepEqual(urgent.map((e) => [e["inbox.lowered.held_end"], e["inbox.lowered.ack_read_seq"]]), [["pagehide", "-"], ["pagehide", "-"]]);
  vi.advanceTimersByTime(LOCAL_READ_ACK_WINDOW_MS);
  noteLocalReadAck("t", 100, 2_000);
  assert.equal(queued.length + urgent.length, 2);
});

test("held_end says how each hold ended, and is '-' for a row that was never held", () => {
  vi.useFakeTimers();
  const events = capture();
  lowerByLocalRead("t", "100");
  noteLocalReadAck("t", 100, 1_010);
  lowerByLocalRead("u", "100");
  vi.advanceTimersByTime(LOCAL_READ_ACK_WINDOW_MS);
  reportListRowsLowered({
    served: [row("a", 3)], before: [], stages: [["read_hold", [row("a", 0)]]],
    reason: "initial", trigger: undefined, rowPosition: true, now: 1,
  });
  assert.deepEqual(events.map((e) => e["inbox.lowered.held_end"]), ["ack", "window", "-"]);
});

// #triage:#244 (2026-11-19): `class` tells expected lowerings from defects, and one lowering is sent once per window.
test("class: a correction is expected, a local_read hold that saw no ack is ack_pending, a read_hold lowering unexplained", () => {
  vi.useFakeTimers();
  const events = capture();
  lowerByLocalRead("t", "100");
  noteLocalReadAck("t", 100, 1_010);
  lowerByLocalRead("u", "100");
  vi.advanceTimersByTime(LOCAL_READ_ACK_WINDOW_MS);
  reportListRowsLowered({
    served: [row("a", 3)], before: [], stages: [["read_hold", [row("a", 0)]]],
    reason: "initial", trigger: undefined, rowPosition: true, now: 1,
  });
  assert.deepEqual(events.map((e) => e["inbox.lowered.class"]), ["expected", "ack_pending", "unexplained"]);
});

test("class: a merge or projection lowering of an answer read under an older read than this client's is expected; otherwise unexplained", () => {
  const events = capture();
  for (const [scope, step, ledger] of [
    ["a", "merge", { readStateVersion: 5, maxReadSeq: 95 }],
    ["b", "projection", { readStateVersion: 5, maxReadSeq: 95 }],
    ["c", "projection", { readStateVersion: 4, maxReadSeq: 90 }],
  ] as const) {
    reportListRowsLowered({
      served: [row(scope, 3)], servedFrontiers: [frontier(4, "90", "100")], ledgerOf: () => ledger,
      before: [], stages: [["ledger", [row(scope, 3)]], [step, [row(scope, 1)]]],
      reason: "realtime_fallback", trigger: "thread_reply", rowPosition: true, now: 1,
    });
  }
  assert.deepEqual(events.map((e) => [e["inbox.lowered.step"], e["inbox.lowered.class"]]), [["merge", "expected"], ["projection", "expected"], ["projection", "unexplained"]]);
  assert.deepEqual(events.map(eventName), ["activity:list_row_lowered", "activity:list_row_lowered", "activity:list_row_lowered"], "event names unchanged");
});

test("the same lowering is sent once per window; the next after it is a repeat carrying the re-reads not sent", async () => {
  const { LOWERED_REPORT_WINDOW_MS } = await import("../src/store/inboxListRowLowered");
  const events = capture();
  const reread = (now: number, after = 1) => reportListRowsLowered({
    served: [row("a", 53)], servedFrontiers: [frontier(4, "90", "143")],
    before: [row("a", 1)], stages: [["merge", [row("a", 53)]], ["projection", [row("a", after)]]],
    reason: "realtime_fallback", trigger: "thread_reply", rowPosition: true, now,
  });
  reread(1_000);
  reread(3_500);
  reread(6_000);
  assert.equal(events.length, 1);
  assert.deepEqual(["dedupe", "suppressed"].map((k) => events[0][`inbox.lowered.${k}`]), ["first", "0"]);
  reread(7_000, 2);
  assert.equal(events.length, 2, "a different lowering of the row is its own report");
  reread(1_000 + LOWERED_REPORT_WINDOW_MS + 1);
  assert.equal(events.length, 3);
  assert.deepEqual(["dedupe", "suppressed"].map((k) => events[2][`inbox.lowered.${k}`]), ["repeat", "2"]);
});

test("a repeat is carried one window from the end of the reported window, not from when its expiry was noticed", async () => {
  const { LOWERED_REPORT_WINDOW_MS: W } = await import("../src/store/inboxListRowLowered");
  const events = capture();
  const reread = (scope: string, now: number) => reportListRowsLowered({
    served: [row(scope, 53)], servedFrontiers: [frontier(4, "90", "143")],
    before: [row(scope, 1)], stages: [["projection", [row(scope, 1)]]],
    reason: "realtime_fallback", trigger: "thread_reply", rowPosition: true, now,
  });
  reread("a", 1_000);
  reread("a", 2_000); // suppressed: the window [1 000, 1 000 + W] carries a repeat
  reread("b", 1_000 + W + W / 2); // another row's answer notices the expiry late
  reread("a", 1_000 + 2 * W + 1); // more than one window after the window ended
  const aEvents = events.filter((e) => e["inbox.lowered.scope_id"] === "a");
  assert.deepEqual(aEvents.map((e) => [e["inbox.lowered.dedupe"], e["inbox.lowered.suppressed"]]), [["first", "0"], ["first", "0"]]);
});

test("a projection lowering carries the projection's inputs and how its coverage stands", () => {
  const events = capture();
  const projection = { unreadCount: 1, hasMention: false, firstUnreadMessageId: "m", firstMentionMessageId: null, complete: true, throughSeq: 143, loadedSeqsAboveRead: [91, 143], readSeq: 90, loadedCount: 3, loadedMinSeq: 90 };
  reportListRowsLowered({
    served: [{ ...row("a", 53), latestActivitySeq: "120", readStateLatestActivitySeq: "120" } as unknown as InboxItem],
    servedFrontiers: [frontier(4, "90", "120")],
    projectionOf: (scopeId) => (scopeId === "a" ? projection : null),
    before: [row("a", 1)], stages: [["projection", [row("a", 1)]]],
    reason: "realtime_fallback", trigger: "thread_reply", rowPosition: true, now: 1,
  });
  assert.deepEqual(
    ["proj_unread", "proj_read_seq", "proj_through_seq", "proj_loaded_above_read", "proj_loaded_count", "proj_loaded_min_seq", "proj_coverage"].map((k) => events[0][`inbox.lowered.${k}`]),
    ["1", "90", "143", "2", "3", "90", "gap"],
  );
});

test("a row with no activity seq is judged by its loaded last message, as the projection's proof is (reply-less thread)", () => {
  const events = capture();
  const projection = { unreadCount: 1, hasMention: false, firstUnreadMessageId: "m", firstMentionMessageId: null, complete: true, throughSeq: 143, loadedSeqsAboveRead: [91, 143], readSeq: 90, loadedCount: 3, loadedMinSeq: 90 };
  const served = { ...row("noseq", 5), lastMessageId: "m143" } as unknown as InboxItem;
  const report = (loadedSeqOf?: (scopeId: string) => (messageId: string) => number | null, now = 1) => reportListRowsLowered({
    served: [served], projectionOf: (scopeId) => (scopeId === "noseq" ? projection : null), loadedSeqOf,
    before: [row("noseq", 1)], stages: [["projection", [row("noseq", 1)]]],
    reason: "realtime_fallback", trigger: "thread_reply", rowPosition: true, now,
  });
  report((scopeId) => (messageId) => (scopeId === "noseq" && messageId === "m143" ? 143 : null));
  assert.equal(events[0]["inbox.lowered.proj_coverage"], "proven");
  report(undefined, 10 * 60 * 60 * 1000);
  assert.equal(events.at(-1)?.["inbox.lowered.proj_coverage"], "null_activity", "its last message not loaded");
});

test("an ack before the hold that does not cover the served latest activity leaves the row held for its own ack", () => {
  vi.useFakeTimers();
  const events = capture();
  noteLocalReadAck("t", 90, 900);
  lowerByLocalRead("t", "100");
  assert.equal(events.length, 0, "an older read's ack does not settle the hold");
  noteLocalReadAck("t", 100, 1_200);
  assert.deepEqual(events.map(eventName), ["activity:list_row_corrected"]);
  assert.deepEqual(["held_end", "ack_read_seq"].map((k) => events[0][`inbox.lowered.${k}`]), ["ack", "100"]);
});

test("an ack before the hold that does not cover the served latest activity ends with the window as before", () => {
  vi.useFakeTimers();
  const events = capture();
  noteLocalReadAck("t", 90, 900);
  lowerByLocalRead("t", "100");
  vi.advanceTimersByTime(LOCAL_READ_ACK_WINDOW_MS);
  assert.deepEqual(events.map(eventName), ["activity:list_row_lowered"]);
  assert.equal(events[0]["inbox.lowered.held_end"], "window");
});

test("a local_read lowering whose ack landed before the hold is settled at once by that ack", () => {
  const events = capture();
  noteLocalReadAck("t", 100, 900);
  lowerByLocalRead("t", "100");
  assert.deepEqual(events.map(eventName), ["activity:list_row_corrected"]);
  assert.deepEqual(["held_end", "ack_read_seq", "ack_delay_ms"].map((k) => events[0][`inbox.lowered.${k}`]), ["ack_before_hold", "100", "-100"]);
});
