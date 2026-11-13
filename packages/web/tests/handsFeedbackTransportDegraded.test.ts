import assert from "node:assert/strict";
import type { AxiosInstance } from "axios";
import { createHandsFeedbackTransport } from "../src/feedback/createHandsFeedbackTransport";

// Server #12566: with `degraded_ok=1` on the first page, a transient Hands
// failure answers 200 with this instead of 503.
const DEGRADED_PAGE = { tickets: [], next_cursor: null, unread_total: null, degraded: true, retry_after_seconds: 5 };
const REAL_PAGE = {
  tickets: [{
    id: "33333333-3333-4333-8333-333333333333",
    kind: "feedback",
    status: "open",
    closure_reason: null,
    duplicate_of_ticket_id: null,
    message: "A ticket",
    created_at: 1,
    updated_at: 2,
    unread: true,
    unread_count: 1,
    attachment_count: 0,
    comment_count: 1,
  }],
  next_cursor: "next",
  unread_total: 1,
};

/** An api whose list answers come from `answer`; records each call's params and when it was made. */
function fakeApi(answer: (call: number) => unknown) {
  const calls: Array<{ params: Record<string, unknown>; at: number }> = [];
  const api = {
    get: async (_url: string, config?: { params?: Record<string, unknown> }) => {
      calls.push({ params: config?.params ?? {}, at: Date.now() });
      return { data: answer(calls.length) };
    },
  } as unknown as AxiosInstance;
  return { api, calls };
}

async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

test("the first page opts into the degraded answer; a later page does not", async () => {
  const { api, calls } = fakeApi(() => REAL_PAGE);
  const transport = createHandsFeedbackTransport(api);
  await transport.listTickets({ limit: 20, signal: new AbortController().signal });
  await transport.listTickets({ cursor: "next", limit: 20, signal: new AbortController().signal });
  assert.deepEqual(calls[0]?.params, { limit: 20, degraded_ok: 1 });
  // A later page can't degrade server-side: an empty one would read as the end.
  assert.deepEqual(calls[1]?.params, { limit: 20, cursor: "next" });
});

test("a degraded page is never handed to the list: it retries from retry_after_seconds, doubling to 60 s, until a real page", async () => {
  vi.useFakeTimers();
  const t0 = Date.now();
  const { api, calls } = fakeApi((call) => (call <= 7 ? DEGRADED_PAGE : REAL_PAGE));
  const changes: boolean[] = [];
  const transport = createHandsFeedbackTransport(api, { onListDegradedChange: (degraded) => changes.push(degraded) });
  let page: Awaited<ReturnType<typeof transport.listTickets>> | null = null;
  const pending = transport.listTickets({ limit: 20, signal: new AbortController().signal }).then((value) => { page = value; });
  await flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(changes, [true], "the host learns the list is degraded");
  assert.equal(page, null, "the empty degraded page does not resolve the list (no false empty state)");

  for (const wait of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]) {
    const before = calls.length;
    await vi.advanceTimersByTimeAsync(wait - 1);
    assert.equal(calls.length, before, `nothing before ${wait} ms`);
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(calls.length, before + 1, `retried after ${wait} ms`);
    assert.ok(vi.getTimerCount() <= 1, "one retry timer at a time");
  }
  await pending;
  assert.equal(calls.length, 8);
  assert.equal(calls[7]!.at - t0, 255_000);
  assert.equal(page!.unreadTotal, 1, "the real page's total, never the degraded null");
  assert.equal(page!.tickets.length, 1);
  assert.deepEqual(changes, [true, false], "a real page clears the degraded state");
  assert.equal(vi.getTimerCount(), 0);
});

test("retries stop when the list's signal aborts (unmount, a newer load)", async () => {
  vi.useFakeTimers();
  const { api, calls } = fakeApi(() => DEGRADED_PAGE);
  const changes: boolean[] = [];
  const transport = createHandsFeedbackTransport(api, { onListDegradedChange: (degraded) => changes.push(degraded) });
  const controller = new AbortController();
  let outcome = "pending";
  void transport.listTickets({ limit: 20, signal: controller.signal })
    .then(() => { outcome = "resolved"; }, () => { outcome = "rejected"; });
  await flush();
  await vi.advanceTimersByTimeAsync(5_000);
  assert.equal(calls.length, 2);
  assert.equal(vi.getTimerCount(), 1);
  controller.abort();
  await flush();
  // Checked, not awaited: a wait that ignored the abort would hang here.
  assert.equal(outcome, "rejected", "the read ends as soon as the list aborts");
  assert.equal(vi.getTimerCount(), 0, "the pending retry timer is cleared");
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  assert.equal(calls.length, 2, "no request after the abort");
  assert.deepEqual(changes, [true, false], "the degraded notice goes with it");
});
