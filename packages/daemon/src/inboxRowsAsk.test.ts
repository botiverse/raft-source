// The wake-up notice's rows ask (inboxRowsAsk.ts): one request in flight per
// agent, arrivals folded into one follow-up, an answer used only for the rows
// it covers, no ask after a 403/404, a hard timeout, abort on stop, and one
// counts-only event per ask.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { AGENT_API_INBOX_ROWS_MAX_TARGETS, parseTraceparent, type AgentApiInboxRowsResponse } from "@botiverse/raft-shared";
import {
  INBOX_ROWS_ASK_TIMEOUT_MS,
  INBOX_ROWS_CALL_EVENT,
  INBOX_ROWS_NOTICE_EVENT,
  INBOX_ROWS_REASK_DELAY_MS,
  InboxRowsAsk,
  inboxRowsTargets,
  type InboxRowsFetchAsAgent,
  type InboxRowsTarget,
} from "./inboxRowsAsk";

const channel = (n: number) => `11111111-aaaa-4bbb-8ccc-${String(n).padStart(12, "0")}`;
const A = channel(1);
const B = channel(2);
const C = channel(3);

type ServerRow = AgentApiInboxRowsResponse["rows"][number];
const serverRow = (channelId: string, unread: number): ServerRow => ({
  channelId,
  target: `#c-${channelId.slice(-2)}`,
  kind: "conversation",
  unread,
  latestSender: null,
  preview: null,
  previewTruncated: false,
  firstUnreadAt: null,
  latestAt: null,
  preLaunch: false,
});
const OTHER = { conversations: 2, messages: 9, mentions: 0, dms: 0 };
const answer = (rows: ServerRow[]): AgentApiInboxRowsResponse => ({ rows, behind: 0, otherUnread: OTHER });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Call = {
  targets: InboxRowsTarget[];
  traceparent: string | undefined;
  signal: AbortSignal | undefined;
  respond: (response: Response | null) => void;
  fail: (error: unknown) => void;
};

function harness(options: { timeoutMs?: number } = {}) {
  const calls: Call[] = [];
  const events: Array<{ name: string; attrs: Record<string, unknown>; status: string | undefined; traceparent: string | null | undefined }> = [];
  const fetchAsAgent: InboxRowsFetchAsAgent = (_agentId, pathname, init) => new Promise((resolve, reject) => {
    assert.equal(pathname, "/internal/agent-api/inbox/rows");
    assert.equal(init.method, "POST");
    calls.push({ targets: (init.body as { targets: InboxRowsTarget[] }).targets, traceparent: init.traceparent, signal: init.signal, respond: resolve, fail: reject });
  });
  const ask = new InboxRowsAsk({
    host: "legacy",
    fetchAsAgent,
    recordEvent: (name, attrs, status, traceparent) => { events.push({ name, attrs, status, traceparent }); },
    ...options,
  });
  const callEvents = () => events.filter((event) => event.name === INBOX_ROWS_CALL_EVENT);
  return { ask, calls, events, callEvents };
}

/** Lets the settled promises of an ask run (no timer advances). */
const settle = async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); };
const row = (channelId: string, latestSeq: number) => ({ channelId, latestSeq });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

test("targets: third-party rows and rows with no seq are skipped, one per conversation, newest first, at most 50", () => {
  assert.deepEqual(inboxRowsTargets([
    row(A, 5),
    { channelId: "third-party-agent-events:agent-1", latestSeq: 9 },
    { channelId: B },
    { latestSeq: 4 },
    row(C, 0),
    row(A.toUpperCase(), 7),
    row(C, 6),
  ]), [{ channelId: A.toUpperCase(), newestSeq: 7 }, { channelId: C, newestSeq: 6 }]);
  const many = Array.from({ length: 60 }, (_, index) => row(channel(100 + index), index + 1));
  const targets = inboxRowsTargets(many);
  assert.equal(targets.length, AGENT_API_INBOX_ROWS_MAX_TARGETS);
  assert.equal(targets[0]!.newestSeq, 60, "the newest are kept");
  assert.equal(targets.at(-1)!.newestSeq, 11);
});

test("nothing to ask about: no request and no promise", () => {
  const { ask, calls } = harness();
  assert.equal(ask.ask("agent-1", "s1", [{ channelId: "third-party-agent-events:agent-1", latestSeq: 9 }], "queued"), null);
  assert.equal(ask.ask("agent-1", "s1", [], "queued"), null);
  assert.equal(calls.length, 0);
});

test("arrivals while a request is in flight fold into exactly one follow-up ask", async () => {
  const { ask, calls, callEvents } = harness();
  const first = ask.ask("agent-1", "s1", [row(A, 10)], "queued");
  assert.ok(first);
  assert.equal(calls.length, 1);
  // Five more messages while it is in flight: no request each.
  const later = [11, 12, 13, 14, 15].map((seq) => ask.ask("agent-1", "s1", [row(A, seq), row(B, seq)], "queued"));
  assert.equal(calls.length, 1, "one request in flight at most");
  assert.ok(later.every((promise) => promise === later[0]), "they wait for the same follow-up");
  assert.notEqual(later[0], first);
  // Asking again about what is already in flight joins it.
  assert.equal(ask.ask("agent-1", "s1", [row(A, 10)], "queued"), first);

  calls[0]!.respond(json(answer([serverRow(A, 3)])));
  await settle();
  assert.equal(calls.length, 2, "one follow-up");
  assert.deepEqual(calls[1]!.targets, [{ channelId: A, newestSeq: 15 }, { channelId: B, newestSeq: 15 }]);
  let followUpSettled = false;
  void later[0]!.then(() => { followUpSettled = true; });
  await settle();
  assert.equal(followUpSettled, false, "the folded asks wait for the follow-up, not for the first request");
  calls[1]!.respond(json(answer([serverRow(A, 8), serverRow(B, 1)])));
  await settle();
  assert.equal(followUpSettled, true);
  assert.equal(calls.length, 2, "and nothing after it");
  assert.equal(callEvents().length, 2);
  // Covered now: asking again sends nothing.
  assert.equal(ask.ask("agent-1", "s1", [row(A, 15), row(B, 15)], "queued"), null);
  assert.equal(calls.length, 2);
});

test("coverage, not age: an older answer does not number a newer message's row", async () => {
  const { ask, calls } = harness();
  void ask.ask("agent-1", "s1", [row(A, 10), row(B, 20)], "queued");
  calls[0]!.respond(json(answer([serverRow(A, 3), serverRow(B, 4)])));
  await settle();

  // Exactly what was asked: both rows and the older-unread numbers.
  const exact = ask.covered("agent-1", "s1", [row(A, 10), row(B, 20)]);
  assert.deepEqual(exact.response?.rows.map((r) => [r.channelId, r.unread]), [[A, 3], [B, 4]]);
  assert.deepEqual(exact.older, OTHER);

  // A newer message in A: its row is not covered, so it gets no Server row; B keeps its number.
  const newer = ask.covered("agent-1", "s1", [row(A, 11), row(B, 20)]);
  assert.deepEqual(newer.response?.rows.map((r) => r.channelId), [B]);
  assert.equal(newer.older, null, "not every listed row is covered: no older-unread line");

  // An hour later the same answer still covers the same rows: age is never the test.
  vi.advanceTimersByTime(60 * 60 * 1000);
  assert.deepEqual(ask.covered("agent-1", "s1", [row(A, 10), row(B, 20)]).response?.rows.length, 2);

  // Fewer rows listed than asked: the asked set is not the listed set, so otherUnread is not passed on.
  const fewer = ask.covered("agent-1", "s1", [row(B, 20)]);
  assert.deepEqual(fewer.response?.rows.map((r) => r.channelId), [B]);
  assert.equal(fewer.older, null);

  // A conversation that was never asked about, and a row with no seq: not covered.
  assert.deepEqual(ask.covered("agent-1", "s1", [row(C, 1), { channelId: A }]), { response: null, ids: new Set(), older: null });
  // Rows that are not conversations do not count against "all covered".
  assert.deepEqual(ask.covered("agent-1", "s1", [row(A, 10), row(B, 20), { channelId: "third-party-agent-events:agent-1", latestSeq: 99 }]).older, OTHER);
  // Another session never sees it.
  assert.deepEqual(ask.covered("agent-1", "s2", [row(A, 10), row(B, 20)]), { response: null, ids: new Set(), older: null });
});

test("ids are matched without letter case", async () => {
  const { ask, calls } = harness();
  void ask.ask("agent-1", "s1", [row(A.toUpperCase(), 10)], "queued");
  calls[0]!.respond(json(answer([serverRow(A, 3)])));
  await settle();
  assert.equal(ask.covered("agent-1", "s1", [row(A.toUpperCase(), 10)]).response?.rows.length, 1);
});

for (const status of [403, 404]) {
  test(`after an HTTP ${status} the session is not asked again; another session is`, async () => {
    const { ask, calls, callEvents } = harness();
    void ask.ask("agent-1", "s1", [row(A, 10)], "queued");
    void ask.ask("agent-1", "s1", [row(A, 11)], "queued");
    calls[0]!.respond(json({ error: "no" }, status));
    await settle();
    assert.equal(calls.length, 1, "the folded follow-up is not sent either");
    assert.equal(ask.stopped("agent-1", "s1"), true);
    assert.equal(ask.ask("agent-1", "s1", [row(A, 12)], "queued"), null);
    assert.equal(calls.length, 1);
    assert.equal(callEvents()[0]!.attrs.failure_reason, `http_${status}`);
    // The memo is the session's: a new session asks again.
    assert.equal(ask.stopped("agent-1", "s2"), false);
    assert.ok(ask.ask("agent-1", "s2", [row(A, 12)], "queued"));
    assert.equal(calls.length, 2);
  });
}

test("other failures are not remembered, and nothing is retried", async () => {
  const { ask, calls, callEvents } = harness();
  void ask.ask("agent-1", "s1", [row(A, 10)], "queued");
  calls[0]!.respond(json({ error: "INBOX_UNAVAILABLE" }, 503));
  await settle();
  assert.equal(calls.length, 1, "no retry");
  assert.equal(ask.stopped("agent-1", "s1"), false);
  assert.deepEqual(ask.covered("agent-1", "s1", [row(A, 10)]), { response: null, ids: new Set(), older: null });
  void ask.ask("agent-1", "s1", [row(A, 11)], "queued");
  calls[1]!.respond(json({ error: "bad" }, 400));
  await settle();
  void ask.ask("agent-1", "s1", [row(A, 12)], "queued");
  calls[2]!.fail(new Error("socket hang up"));
  await settle();
  void ask.ask("agent-1", "s1", [row(A, 13)], "queued");
  calls[3]!.respond(json({ rows: "nope" }));
  await settle();
  void ask.ask("agent-1", "s1", [row(A, 14)], "queued");
  calls[4]!.respond(null);
  await settle();
  assert.deepEqual(callEvents().map((event) => event.attrs.failure_reason), ["http_5xx", "http_4xx", "network", "contract", "no_credential"]);
  assert.ok(callEvents().every((event) => event.attrs.outcome === "fallback" && event.status === "error"));
});

test("the hard timeout: a request that never answers is given up at 800 ms, with the duration on the event", async () => {
  const { ask, calls, callEvents } = harness();
  assert.equal(INBOX_ROWS_ASK_TIMEOUT_MS, 800);
  let settled = false;
  void ask.ask("agent-1", "s1", [row(A, 10)], "idle_hold")!.then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(799);
  assert.equal(settled, false);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(settled, true);
  assert.equal(calls[0]!.signal?.aborted, true, "the request is aborted");
  const event = callEvents()[0]!;
  assert.equal(event.attrs.outcome, "fallback");
  assert.equal(event.attrs.failure_reason, "timeout");
  assert.equal(event.attrs.duration_ms, 800);
  assert.equal(event.attrs.timeout_ms, 800);
  assert.deepEqual(ask.covered("agent-1", "s1", [row(A, 10)]), { response: null, ids: new Set(), older: null });
  assert.equal(ask.stopped("agent-1", "s1"), false);
  // An answer that arrives after the limit is not taken.
  calls[0]!.respond(json(answer([serverRow(A, 3)])));
  await settle();
  assert.deepEqual(ask.covered("agent-1", "s1", [row(A, 10)]), { response: null, ids: new Set(), older: null });
  assert.equal(callEvents().length, 1);
});

test("a stop aborts the request in flight and drops the folded follow-up", async () => {
  const { ask, calls, callEvents } = harness();
  let firstSettled = false;
  let followUpSettled = false;
  void ask.ask("agent-1", "s1", [row(A, 10)], "queued")!.then(() => { firstSettled = true; });
  void ask.ask("agent-1", "s1", [row(A, 11)], "queued")!.then(() => { followUpSettled = true; });
  await vi.advanceTimersByTimeAsync(120);
  ask.reset("agent-1");
  await settle();
  assert.equal(calls[0]!.signal?.aborted, true);
  assert.equal(firstSettled, true);
  assert.equal(followUpSettled, true, "whoever waited is released");
  assert.equal(calls.length, 1, "no follow-up after a stop");
  const event = callEvents()[0]!;
  assert.equal(event.attrs.failure_reason, "aborted");
  assert.equal(event.attrs.duration_ms, 120);
  // A late answer is not kept for the next session of the agent.
  calls[0]!.respond(json(answer([serverRow(A, 3)])));
  await settle();
  assert.deepEqual(ask.covered("agent-1", "s1", [row(A, 10)]), { response: null, ids: new Set(), older: null });
});

test("a session change aborts the old session's request and forgets its answer; shutdown aborts every agent's", async () => {
  const { ask, calls, callEvents } = harness();
  void ask.ask("agent-1", "s1", [row(A, 10)], "queued");
  calls[0]!.respond(json(answer([serverRow(A, 3)])));
  await settle();
  void ask.ask("agent-1", "s1", [row(A, 11)], "queued");
  ask.noteSession("agent-1", "s1");
  assert.equal(calls[1]!.signal?.aborted, false, "the same session: nothing happens");
  ask.noteSession("agent-1", "s2");
  await settle();
  assert.equal(calls[1]!.signal?.aborted, true);
  assert.equal(callEvents()[1]!.attrs.failure_reason, "aborted");
  assert.deepEqual(ask.covered("agent-1", "s1", [row(A, 10)]), { response: null, ids: new Set(), older: null });

  void ask.ask("agent-1", "s2", [row(A, 12)], "queued");
  void ask.ask("agent-2", "s9", [row(B, 1)], "queued");
  ask.resetAll();
  await settle();
  assert.equal(calls[2]!.signal?.aborted, true);
  assert.equal(calls[3]!.signal?.aborted, true);
});

test("one event per ask: counts, the call site, the trace id of the request, and no conversation id or name", async () => {
  const { ask, calls, events, callEvents } = harness();
  void ask.ask("agent-1", "s1", [row(A, 10), row(B, 20), row(C, 30)], "session_start");
  await vi.advanceTimersByTimeAsync(42);
  calls[0]!.respond(json(answer([serverRow(A, 3), serverRow(B, 4)])));
  await settle();
  const event = callEvents()[0]!;
  const trace = parseTraceparent(calls[0]!.traceparent);
  assert.ok(trace, "the request carries a trace header");
  assert.deepEqual(event.attrs, {
    agentId: "agent-1",
    host: "legacy",
    call_site: "session_start",
    outcome: "ok",
    duration_ms: 42,
    timeout_ms: 800,
    targets: 3,
    rows: 2,
    partial: true,
    behind: 0,
    with_behind_mode: "off",
    trace_id: trace.traceId,
  });
  assert.equal(event.status, "ok");
  assert.equal(event.traceparent, calls[0]!.traceparent, "the event joins the request's trace");

  // Every row answered: not partial.
  void ask.ask("agent-2", "s1", [row(A, 10)], "queued");
  calls[1]!.respond(json(answer([serverRow(A, 3)])));
  await settle();
  assert.equal("partial" in callEvents()[1]!.attrs, false);
  assert.equal("failure_reason" in callEvents()[1]!.attrs, false);

  // The notice event: whether the answer was used is known only at notice time.
  ask.recordNotice("agent-1", "s1", { answerUsed: true, listedRows: 3, numberlessRows: 1 });
  assert.deepEqual(events.at(-1), {
    name: INBOX_ROWS_NOTICE_EVENT,
    attrs: { agentId: "agent-1", host: "legacy", call_site: "session_start", answer_used: true, listed_rows: 3, numberless_rows: 1 },
    status: undefined,
    traceparent: undefined,
  });

  const recorded = JSON.stringify(events);
  for (const id of [A, B, C]) assert.equal(recorded.includes(id), false, "no conversation id in an event");
  assert.equal(recorded.includes("#c-"), false, "no conversation name in an event");
});

test("a recorder that throws does not wedge the session: the flight is cleared, nothing rejects, the next ask goes out", async () => {
  const calls: Call[] = [];
  let recorded = 0;
  const ask = new InboxRowsAsk({
    host: "legacy",
    fetchAsAgent: (_agentId, _pathname, init) => new Promise((resolve, reject) => {
      calls.push({ targets: (init.body as { targets: InboxRowsTarget[] }).targets, traceparent: init.traceparent, signal: init.signal, respond: resolve, fail: reject });
    }),
    recordEvent: () => { recorded += 1; throw new Error("the trace sink is broken"); },
  });
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => { rejections.push(reason); };
  process.on("unhandledRejection", onRejection);
  try {
    let settled = false;
    const first = ask.ask("agent-1", "s1", [row(A, 10)], "queued")!;
    void first.then(() => { settled = true; });
    // Nobody waits on this one (as a queued ask): it must not reject unhandled either.
    void ask.ask("agent-1", "s1", [row(A, 11)], "queued");
    calls[0]!.respond(json(answer([serverRow(A, 3)])));
    await settle();
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(settled, true, "the ask settles");
    assert.equal(calls.length, 2, "the folded follow-up still goes out");
    calls[1]!.respond(json(answer([serverRow(A, 4)])));
    await settle();
    assert.equal(ask.covered("agent-1", "s1", [row(A, 11)]).response?.rows[0]!.unread, 4, "the answers are kept");
    // Not stuck behind a flight that was never cleared.
    assert.ok(ask.ask("agent-1", "s1", [row(A, 12)], "queued"));
    assert.equal(calls.length, 3);
    assert.doesNotThrow(() => ask.recordNotice("agent-1", "s1", { answerUsed: true, listedRows: 1, numberlessRows: 0 }));
    assert.ok(recorded >= 3);
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(rejections, []);
  } finally {
    process.off("unhandledRejection", onRejection);
    ask.resetAll();
  }
});

test("two listed rows that claim one channel id: neither takes the Server's row, and older unread is not passed on", async () => {
  const { ask, calls } = harness();
  void ask.ask("agent-1", "s1", [row(A, 10), row(B, 20)], "queued");
  calls[0]!.respond(json(answer([serverRow(A, 3), serverRow(B, 4)])));
  await settle();
  // A thread row with no id of its own falls back to its parent's: A is listed twice.
  const covered = ask.covered("agent-1", "s1", [row(A, 10), row(A.toUpperCase(), 9), row(B, 20)]);
  assert.deepEqual(covered.response?.rows.map((r) => r.channelId), [B], "only the row with its own id is numbered");
  assert.equal(covered.older, null);
  assert.deepEqual(ask.covered("agent-1", "s1", [row(A, 10), row(A, 10)]), { response: null, ids: new Set(), older: null });
});

test("a conversation answered without a row is not remembered as asked: a later ask names it again", async () => {
  const h = harness();
  void h.ask.ask("agent", "s1", [row(A, 5), row(B, 7)], "idle_hold");
  // The view had A, not B's new message yet.
  h.calls[0]!.respond(json({ ...answer([serverRow(A, 2)]), behind: 1 }));
  await settle();
  assert.equal(h.callEvents()[0]!.attrs.behind, 1);
  assert.equal(h.callEvents()[0]!.attrs.partial, true);
  // B prints without a number; A keeps its number; no "older unread" (not every listed row is covered).
  const first = h.ask.covered("agent", "s1", [row(A, 5), row(B, 7)]);
  assert.deepEqual(first.response?.rows.map((r) => r.channelId), [A]);
  assert.equal(first.older, null);
  // A alone is covered: nothing to ask. B is asked again.
  assert.equal(h.ask.ask("agent", "s1", [row(A, 5)], "idle_hold"), null);
  assert.notEqual(h.ask.ask("agent", "s1", [row(A, 5), row(B, 7)], "idle_hold"), null);
  assert.equal(h.calls.length, 2);
  h.calls[1]!.respond(json(answer([serverRow(A, 2), serverRow(B, 1)])));
  await settle();
  const second = h.ask.covered("agent", "s1", [row(A, 5), row(B, 7)]);
  assert.deepEqual(second.response?.rows.map((r) => r.channelId).sort(), [A, B].sort());
  assert.deepEqual(second.older, OTHER);
  // An idle delivery writes its notice at once: no second ask by timer.
  await vi.advanceTimersByTimeAsync(INBOX_ROWS_REASK_DELAY_MS * 3);
  assert.equal(h.calls.length, 2);
});

test("a row left out with behind 0 (a new message in a conversation the view has no row for) is asked again too", async () => {
  const h = harness();
  void h.ask.ask("agent", "s1", [row(B, 7)], "idle_hold");
  h.calls[0]!.respond(json(answer([])));
  await settle();
  assert.equal(h.ask.covered("agent", "s1", [row(B, 7)]).response, null);
  assert.notEqual(h.ask.ask("agent", "s1", [row(B, 7)], "idle_hold"), null);
  assert.equal(h.calls.length, 2);
});

test("a busy agent's ask that left a conversation out is sent once more after a moment, and only once", async () => {
  const h = harness();
  void h.ask.ask("agent", "s1", [row(A, 5), row(B, 7)], "queued");
  h.calls[0]!.respond(json({ ...answer([serverRow(A, 2)]), behind: 1 }));
  await settle();
  assert.equal(h.calls.length, 1);
  await vi.advanceTimersByTimeAsync(INBOX_ROWS_REASK_DELAY_MS);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1]!.targets, h.calls[0]!.targets);
  // Still without B: the second ask schedules no third.
  h.calls[1]!.respond(json({ ...answer([serverRow(A, 2)]), behind: 1 }));
  await settle();
  assert.equal(h.callEvents()[1]!.attrs.reask, true);
  await vi.advanceTimersByTimeAsync(INBOX_ROWS_REASK_DELAY_MS * 3);
  assert.equal(h.calls.length, 2);
});

test("the second ask is dropped by a stop, and replaced by a newer ask", async () => {
  const h = harness();
  void h.ask.ask("agent", "s1", [row(B, 7)], "queued");
  h.calls[0]!.respond(json(answer([])));
  await settle();
  h.ask.reset("agent");
  await vi.advanceTimersByTimeAsync(INBOX_ROWS_REASK_DELAY_MS * 2);
  assert.equal(h.calls.length, 1);

  void h.ask.ask("agent", "s2", [row(B, 7)], "queued");
  h.calls[1]!.respond(json(answer([])));
  await settle();
  // A newer message arrives before the timer: that ask goes out now and the timer is cancelled.
  void h.ask.ask("agent", "s2", [row(B, 8)], "queued");
  assert.equal(h.calls.length, 3);
  h.calls[2]!.respond(json(answer([serverRow(B, 2)])));
  await settle();
  await vi.advanceTimersByTimeAsync(INBOX_ROWS_REASK_DELAY_MS * 2);
  assert.equal(h.calls.length, 3);
});

test("a full answer schedules no second ask", async () => {
  const h = harness();
  void h.ask.ask("agent", "s1", [row(A, 5)], "queued");
  h.calls[0]!.respond(json(answer([serverRow(A, 2)])));
  await settle();
  await vi.advanceTimersByTimeAsync(INBOX_ROWS_REASK_DELAY_MS * 2);
  assert.equal(h.calls.length, 1);
});

test("an answer that is added to (withBehind) covers every conversation it was asked about, one without a row too, is not asked again, and never covers a newer message", async () => {
  const bodies: unknown[] = [];
  const { ask, calls, callEvents } = harness();
  const first = ask.ask("agent-1", "s1", [row(A, 10), row(B, 20)], "queued");
  assert.equal(calls.length, 1);
  // The view has a row for A only, one message behind; B was fully read and has none.
  const response: AgentApiInboxRowsResponse = { rows: [{ ...serverRow(A, 2), activitySeq: 9 }], withBehind: true, behind: 2, otherUnread: OTHER };
  calls[0]!.respond(json(response));
  await first;
  bodies.push(response);
  assert.equal(callEvents()[0]!.attrs.with_behind_mode, "on");
  // Both are covered, B with no row.
  const covered = ask.covered("agent-1", "s1", [row(A, 10), row(B, 20)]);
  assert.deepEqual([...covered.ids].sort(), [A, B]);
  // A message newer than what was asked is not covered: the answer may predate a read, or an
  // earlier notice may have taken some of what was held, so adding to it would count wrong.
  const newer = ask.covered("agent-1", "s1", [row(A, 50), row(B, 20)]);
  assert.deepEqual([...newer.ids], [B]);
  assert.deepEqual(newer.response?.rows, []);
  assert.equal(newer.older, null);
  assert.deepEqual(covered.response?.rows.map((r) => r.channelId), [A]);
  assert.deepEqual(covered.older, OTHER);
  // A conversation that was not asked about is not covered, and the answer says nothing older for that set.
  const withC = ask.covered("agent-1", "s1", [row(A, 10), row(C, 5)]);
  assert.deepEqual([...withC.ids], [A]);
  assert.equal(withC.older, null);
  // No second ask a moment later: B's missing row is an answer, not a view that is behind.
  await vi.advanceTimersByTimeAsync(INBOX_ROWS_REASK_DELAY_MS * 2);
  assert.equal(calls.length, 1);
  assert.equal(ask.ask("agent-1", "s1", [row(A, 10), row(B, 20)], "queued"), null);
});

test("the ask says withBehind", async () => {
  let body: unknown;
  const ask = new InboxRowsAsk({
    host: "legacy",
    fetchAsAgent: async (_agentId, _pathname, init) => { body = init.body; return json(answer([])); },
    recordEvent: () => {},
  });
  await ask.ask("agent-1", "s1", [row(A, 10)], "queued");
  assert.deepEqual(body, { targets: [{ channelId: A, newestSeq: 10 }], withBehind: true });
});
