import assert from "node:assert/strict";
import { afterEach, vi } from "vitest";
import { BasicTracer, MemoryTraceSink, PRODUCT_FEEDBACK_UNREAD_EVENT } from "@botiverse/raft-shared";
import {
  getProductFeedbackTicket,
  resetProductFeedbackBreakersForTest,
  resetProductFeedbackReporterSessionCacheForTest,
} from "./productFeedbackConversationService";
import { resetProductFeedbackRouteBindingCacheForTest } from "./productFeedbackRouteBindingService";
import { mintProductFeedbackRouteSubject } from "./productFeedbackRouteSubject";
import { productFeedbackReporterId } from "./productFeedbackService";
import { setProductFeedbackUnreadRealtimeIO } from "./productFeedbackUnreadRealtime";
import {
  memoryProductFeedbackReconcileState,
  PRODUCT_FEEDBACK_RECONCILE_CLAIM_KEY,
  readProductFeedbackReconcileConfig,
  redisProductFeedbackReconcileState,
  runProductFeedbackUnreadReconcile,
  startProductFeedbackUnreadReconcileWorker,
  type ProductFeedbackReconcileConfig,
  type ProductFeedbackReconcileDeps,
} from "./productFeedbackUnreadReconcile";

const APP_ID = "850a1eca-2664-4e44-9020-51fbdf7a8a70";
const INTEGRATION = `legacy-feedback:${APP_ID}`;
const SECRET = "reporter-id-secret";
const ROUTE_ROOT = Buffer.alloc(32, 7).toString("base64url");
const ENV = {
  HANDS_FEEDBACK_BASE_URL: "https://hands.example/",
  HANDS_FEEDBACK_APP_ID: APP_ID,
  HANDS_FEEDBACK_CONVERSATION_APP_TOKEN: "conversation-token",
  HANDS_FEEDBACK_CONVERSATION_CREDENTIAL_REVISION: "token-revision-1",
  HANDS_FEEDBACK_CURSOR_SECRET: "cursor-secret",
  HANDS_FEEDBACK_REPORTER_INTEGRATION_ID: INTEGRATION,
  HANDS_FEEDBACK_REPORTER_ID_SECRET: SECRET,
  HANDS_FEEDBACK_ROUTE_SUBJECT_KEY_ID: "v1",
  HANDS_FEEDBACK_ROUTE_SUBJECT_ROOT: ROUTE_ROOT,
  HANDS_FEEDBACK_UNREAD_RECONCILE_ENABLED: "true",
} as NodeJS.ProcessEnv;

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const reporter = (userId: string) => productFeedbackReporterId(userId, SECRET);
const subject = (userId: string) => mintProductFeedbackRouteSubject({
  root: ROUTE_ROOT, userId, coordinate: { appId: APP_ID, reporterIntegrationId: INTEGRATION, reporterId: reporter(userId) },
});
const T1 = "aaaaaaaa-0000-4000-8000-000000000001";
const T2 = "aaaaaaaa-0000-4000-8000-000000000002";
const T3 = "aaaaaaaa-0000-4000-8000-000000000003";
const C1 = "cccccccc-0000-4000-8000-000000000001";
const C2 = "cccccccc-0000-4000-8000-000000000002";
const C3 = "cccccccc-0000-4000-8000-000000000003";
const REPLY_TEXT = "staff public reply text";

type Comment = { id: string; author_type: "reporter" | "staff" | "system"; body: string; created_at?: number };
type Change = { ticket_id: string; route_subject: string | null; reporter_id: string; comment_id?: string | null };

/** A change of `userId`'s ticket, as Hands sends it. */
function change(ticketId: string, userId: string, commentId?: string | null): Change {
  return { ticket_id: ticketId, route_subject: subject(userId), reporter_id: reporter(userId), ...(commentId === undefined ? {} : { comment_id: commentId }) };
}

function publicTicket(id: string) {
  return {
    id, kind: "feedback", status: "open", closure_reason: null, duplicate_of_ticket_id: null,
    message: "private ticket message", version_name: null, channel: null, created_at: 1_700_000_000_000, updated_at: 1_700_000_000_001,
    attachment_count: 0, comment_count: 1, latest_comment_at: 1_700_000_000_001, unread: false, unread_count: 0,
  };
}

/**
 * A Hands stand-in for the reporter change feed and the reporter detail.
 * The detail shows public comments only, as Hands does (an internal note
 * never appears in it); a ticket's comments may span several pages.
 */
function fakeHands(input: {
  pages?: Record<string, { changes: Change[]; next_cursor: string; has_more?: boolean }>;
  /** Comment pages per ticket (one page when a flat list). */
  comments?: Record<string, Comment[] | Comment[][]>;
  unread?: Record<string, number>;
  /** Statuses a ticket's detail answers, one per call (the last one repeats); 200 serves it. */
  detailStatus?: Record<string, number[]>;
  /** Detail reads of these tickets wait this long (or until aborted). */
  detailDelayMs?: Record<string, number>;
  changesStatus?: number;
  changesHeaders?: Record<string, string>;
}) {
  const requests: Array<{ url: URL; authorization: string | null; reporterHeader: string | null }> = [];
  const unread = input.unread ?? {};
  const fetchImpl = (async (target: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(target));
    const headers = new Headers(init?.headers);
    requests.push({ url, authorization: headers.get("authorization"), reporterHeader: headers.get("x-hands-reporter-id") });
    if (url.pathname === `/api/apps/${APP_ID}/reporter-feedback/changes`) {
      if (input.changesStatus) return Response.json({ error: "no" }, { status: input.changesStatus, headers: input.changesHeaders });
      const cursor = url.searchParams.get("cursor");
      // Without a cursor: Hands' current position only, no history.
      if (cursor === null) return Response.json({ changes: [], next_cursor: "position-0", has_more: false });
      const page = input.pages?.[cursor];
      if (!page) return Response.json({ error: "invalid_cursor" }, { status: 400 });
      return Response.json({ has_more: false, ...page });
    }
    const detail = url.pathname.match(new RegExp(`^/api/apps/${APP_ID}/reporter-feedback/([0-9a-f-]{36})$`));
    if (detail) {
      const id = detail[1]!;
      const delay = input.detailDelayMs?.[id];
      if (delay !== undefined) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delay);
          init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal!.reason); }, { once: true });
        });
      }
      const statuses = input.detailStatus?.[id];
      const status = statuses ? (statuses.length > 1 ? statuses.shift()! : statuses[0]!) : 200;
      if (status !== 200) return Response.json({ error: "no" }, { status, headers: status === 429 ? { "Retry-After": "120" } : {} });
      const raw = input.comments?.[id] ?? [];
      const pages = (raw.length > 0 && Array.isArray(raw[0]) ? raw : [raw]) as Comment[][];
      const index = Number((url.searchParams.get("comment_cursor") ?? "p0").slice(1));
      const comments = (pages[index] ?? []).map((comment, position) => ({ created_at: 1_700_000_000_000 + position, ...comment }));
      return Response.json({
        ticket: publicTicket(id), comments, attachments: [],
        next_comment_cursor: index + 1 < pages.length ? `p${index + 1}` : null,
        unread_total: unread[headers.get("x-hands-reporter-id") ?? ""] ?? 0,
      });
    }
    return Response.json({ error: "unexpected" }, { status: 599 });
  }) as typeof fetch;
  const detailRequests = () => requests.filter((r) => /\/reporter-feedback\/[0-9a-f-]{36}$/.test(r.url.pathname));
  return { fetchImpl, requests, detailRequests };
}

function reconcileConfig(): ProductFeedbackReconcileConfig {
  const read = readProductFeedbackReconcileConfig(ENV);
  assert.ok("config" in read, "configured");
  return read.config;
}

function captureSocket() {
  const frames: Array<{ room: string; event: string; payload: unknown }> = [];
  setProductFeedbackUnreadRealtimeIO({
    to: (room: string) => ({ emit: (event: string, payload: unknown) => { frames.push({ room, event, payload }); return true; } }),
  } as never);
  return frames;
}

/** A state whose cursor is already `cursor` (the job ran before). */
function stateAt(cursor = "cursor-0") {
  const state = memoryProductFeedbackReconcileState();
  state.cursors.set(APP_ID, cursor);
  return state;
}

const quietLog = { warn: () => {} };

/** The trace events of `name` (recorded as log events in the root span). */
function traceEvents(sink: MemoryTraceSink, name: string) {
  return sink.getAllLogEvents().filter((event) => event.name === name);
}

function run(deps: Omit<ProductFeedbackReconcileDeps, "config">) {
  return runProductFeedbackUnreadReconcile({ config: reconcileConfig(), log: quietLog, ticketRetryDelaysMs: [0, 0], ...deps });
}

afterEach(() => {
  setProductFeedbackUnreadRealtimeIO(null);
  resetProductFeedbackBreakersForTest();
  resetProductFeedbackReporterSessionCacheForTest();
  resetProductFeedbackRouteBindingCacheForTest();
});

test("the first run (no stored cursor) only records Hands' current position: no detail read, no push", async () => {
  const hands = fakeHands({});
  const state = memoryProductFeedbackReconcileState();
  const frames = captureSocket();
  const result = await run({ state, fetchImpl: hands.fetchImpl });
  assert.equal(result.outcome, "ok");
  assert.equal(result.cursorInitialized, true);
  assert.equal(state.cursors.get(APP_ID), "position-0");
  assert.equal(hands.requests.length, 1);
  assert.equal(hands.requests[0]!.url.searchParams.has("cursor"), false);
  assert.deepEqual(frames, []);
});

test("a change with a new public reply pushes the detail's unread_total to the reporter's own connections, then saves the cursor", async () => {
  const hands = fakeHands({
    pages: {
      "cursor-0": { changes: [change(T1, USER_A, C1)], next_cursor: "cursor-1", has_more: true },
      "cursor-1": { changes: [change(T3, USER_B, C3)], next_cursor: "cursor-2" },
    },
    comments: { [T1]: [{ id: C1, author_type: "staff", body: REPLY_TEXT }], [T3]: [{ id: C3, author_type: "system", body: REPLY_TEXT }] },
    unread: { [reporter(USER_A)]: 2, [reporter(USER_B)]: 1 },
  });
  const state = stateAt();
  const frames = captureSocket();
  const result = await run({ state, fetchImpl: hands.fetchImpl });
  assert.equal(result.outcome, "ok");
  assert.equal(result.pages, 2);
  assert.equal(result.ticketsWithNewReply, 2, "a staff and a system reply both count");
  assert.equal(state.cursors.get(APP_ID), "cursor-2");
  assert.ok((await state.getLastSuccessAt(APP_ID))! > 0);
  assert.deepEqual(frames, [
    { room: `user:${USER_A}`, event: PRODUCT_FEEDBACK_UNREAD_EVENT, payload: { userId: USER_A, unreadTotal: 2 } },
    { room: `user:${USER_B}`, event: PRODUCT_FEEDBACK_UNREAD_EVENT, payload: { userId: USER_B, unreadTotal: 1 } },
  ]);
  // The conversation token itself; the feed with no reporter header, the detail as the reporter.
  for (const request of hands.requests) assert.equal(request.authorization, "Bearer conversation-token");
  for (const request of hands.requests.filter((r) => r.url.pathname.endsWith("/changes"))) {
    assert.equal(request.reporterHeader, null);
    assert.equal(request.url.searchParams.get("limit"), "100");
  }
  assert.deepEqual(hands.detailRequests().map((r) => r.reporterHeader), [reporter(USER_A), reporter(USER_B)]);
});

test("every background detail read, on every comment page, carries mark_read=false; none is ever made without it", async () => {
  const hands = fakeHands({
    pages: { "cursor-0": { changes: [change(T1, USER_A, C2), change(T2, USER_A), change(T3, USER_B, C3)], next_cursor: "cursor-1" } },
    comments: {
      // Three pages, the newest staff reply on the last.
      [T1]: [[{ id: C1, author_type: "staff", body: "old" }], [{ id: "dddddddd-0000-4000-8000-000000000001", author_type: "reporter", body: "me" }], [{ id: C2, author_type: "staff", body: REPLY_TEXT }]],
      [T2]: [],
      [T3]: [{ id: C3, author_type: "staff", body: REPLY_TEXT }],
    },
  });
  const pushes: unknown[] = [];
  const state = stateAt();
  await run({ state, fetchImpl: hands.fetchImpl, push: (...args) => pushes.push(args) });
  assert.deepEqual(hands.detailRequests().map((r) => r.url.searchParams.get("comment_cursor")), [null, "p1", "p2", null, null]);
  for (const request of hands.detailRequests()) {
    assert.equal(request.url.searchParams.get("mark_read"), "false", `${request.url.pathname} must not mark read`);
  }
  for (const request of hands.requests) {
    assert.ok(
      request.url.pathname.endsWith("/reporter-feedback/changes") || request.url.searchParams.get("mark_read") === "false",
      `unexpected background request ${request.url.pathname}`,
    );
  }
  assert.equal(await state.getSeenComment(APP_ID, T1), C2, "the reply on the last page is the newest");
  assert.equal(pushes.length, 2);
});

test("the newest reply is chosen by time, not by its place in the list", async () => {
  const state = stateAt();
  await state.setSeenComment(APP_ID, T1, C2);
  const pushes: unknown[] = [];
  // Newest first: a position-based pick would take C1 and push again.
  const hands = fakeHands({
    pages: { "cursor-0": { changes: [change(T1, USER_A)], next_cursor: "cursor-1" } },
    comments: { [T1]: [{ id: C2, author_type: "staff", body: REPLY_TEXT, created_at: 2_000 }, { id: C1, author_type: "staff", body: "old", created_at: 1_000 }] },
  });
  await run({ state, fetchImpl: hands.fetchImpl, push: (...args) => pushes.push(args) });
  assert.deepEqual(pushes, []);
});

test("an internal-only change (no new public reply) pushes nothing and reads no unread total", async () => {
  const state = stateAt();
  await state.setSeenComment(APP_ID, T1, C1);
  const pushes: unknown[] = [];
  // No comment_id in the item: the detail decides, and shows only C1, already seen.
  const hands = fakeHands({
    pages: { "cursor-0": { changes: [change(T1, USER_A)], next_cursor: "cursor-1" } },
    comments: { [T1]: [{ id: C1, author_type: "staff", body: REPLY_TEXT }] },
  });
  const result = await run({ state, fetchImpl: hands.fetchImpl, push: (...args) => pushes.push(args) });
  assert.equal(result.outcome, "ok");
  assert.deepEqual(pushes, []);
  assert.ok(hands.requests.every((r) => !r.url.pathname.endsWith("/reporter-feedback")), "no list read");
  assert.equal(state.cursors.get(APP_ID), "cursor-1");
});

test("a change whose comment_id is null or already seen reads no detail and pushes nothing", async () => {
  const state = stateAt();
  await state.setSeenComment(APP_ID, T1, C1);
  // A ticket whose reply was seen before: null still means no reply to check.
  await state.setSeenComment(APP_ID, T2, C2);
  const pushes: unknown[] = [];
  const hands = fakeHands({
    pages: { "cursor-0": { changes: [change(T1, USER_A, C1), change(T2, USER_A, null)], next_cursor: "cursor-1" } },
    comments: { [T1]: [{ id: C3, author_type: "staff", body: REPLY_TEXT }] },
  });
  const result = await run({ state, fetchImpl: hands.fetchImpl, push: (...args) => pushes.push(args) });
  assert.equal(result.outcome, "ok");
  assert.equal(hands.detailRequests().length, 0);
  assert.deepEqual(pushes, []);
  assert.equal(state.cursors.get(APP_ID), "cursor-1");
});

test("a public reply and an internal note merged into one change push exactly once", async () => {
  const state = stateAt();
  await state.setSeenComment(APP_ID, T1, C1);
  const frames = captureSocket();
  const hands = fakeHands({
    pages: { "cursor-0": { changes: [change(T1, USER_A, C2)], next_cursor: "cursor-1" } },
    comments: { [T1]: [{ id: C1, author_type: "staff", body: "old" }, { id: C2, author_type: "staff", body: REPLY_TEXT }] },
    unread: { [reporter(USER_A)]: 1 },
  });
  await run({ state, fetchImpl: hands.fetchImpl });
  assert.deepEqual(frames.map((frame) => frame.payload), [{ userId: USER_A, unreadTotal: 1 }]);
});

test("the same change replayed (a deploy repeats the page) does not push a second time", async () => {
  const state = stateAt();
  const pushes: unknown[] = [];
  const hands = fakeHands({
    pages: { "cursor-0": { changes: [change(T1, USER_A)], next_cursor: "cursor-1" } },
    comments: { [T1]: [{ id: C1, author_type: "staff", body: REPLY_TEXT }] },
  });
  await run({ state, fetchImpl: hands.fetchImpl, push: (...args) => pushes.push(args) });
  assert.equal(pushes.length, 1);
  state.expireClaim();
  state.cursors.set(APP_ID, "cursor-0");
  assert.equal((await run({ state, fetchImpl: hands.fetchImpl, push: (...args) => pushes.push(args) })).outcome, "ok");
  assert.equal(pushes.length, 1, "no second push for the same reply");
});

test("a reporter's own reply is not a new reply for them", async () => {
  const pushes: unknown[] = [];
  const hands = fakeHands({
    pages: { "cursor-0": { changes: [change(T1, USER_A)], next_cursor: "cursor-1" } },
    comments: { [T1]: [{ id: C1, author_type: "reporter", body: "my own reply" }] },
  });
  await run({ state: stateAt(), fetchImpl: hands.fetchImpl, push: (...args) => pushes.push(args) });
  assert.deepEqual(pushes, []);
});

test("nothing of the change feed or the detail (ticket text, reply bodies, ids, subjects) is pushed", async () => {
  const frames = captureSocket();
  const hands = fakeHands({
    pages: { "cursor-0": { changes: [change(T1, USER_A, C1)], next_cursor: "cursor-1" } },
    comments: { [T1]: [{ id: C1, author_type: "staff", body: REPLY_TEXT }] },
    unread: { [reporter(USER_A)]: 4 },
  });
  await run({ state: stateAt(), fetchImpl: hands.fetchImpl });
  assert.equal(frames.length, 1);
  assert.deepEqual(Object.keys(frames[0]!.payload as object).sort(), ["unreadTotal", "userId"]);
  const serialized = JSON.stringify(frames);
  for (const leak of [REPLY_TEXT, "private ticket message", T1, C1, subject(USER_A), reporter(USER_A)]) {
    assert.ok(!serialized.includes(leak), `pushed frame must not carry ${leak}`);
  }
});

test("an unbound ticket, a subject that does not open with its reporter id, or a malformed item is skipped without a detail read", async () => {
  const hands = fakeHands({
    pages: { "cursor-0": { changes: [
      { ticket_id: T1, route_subject: null, reporter_id: reporter(USER_A), comment_id: C1 },
      // B's subject sent with A's reporter id: it does not open, no recipient is guessed.
      { ticket_id: T3, route_subject: subject(USER_B), reporter_id: reporter(USER_A), comment_id: C3 },
      { ticket_id: "not-a-ticket", route_subject: subject(USER_A), reporter_id: reporter(USER_A), comment_id: C1 },
    ], next_cursor: "cursor-1" } },
  });
  const pushes: unknown[] = [];
  const state = stateAt();
  const result = await run({ state, fetchImpl: hands.fetchImpl, push: (...args) => pushes.push(args) });
  assert.equal(result.outcome, "ok");
  assert.equal(result.ticketsUnbound, 1);
  assert.equal(result.ticketsUnmapped, 2);
  assert.equal(hands.detailRequests().length, 0);
  assert.deepEqual(pushes, []);
  assert.equal(state.cursors.get(APP_ID), "cursor-1");
});

test("only one run per claim window across tasks; a second task skips and calls Hands not at all", async () => {
  const hands = fakeHands({ pages: { "cursor-0": { changes: [], next_cursor: "cursor-0" } } });
  const state = stateAt();
  const once = () => run({ state, fetchImpl: hands.fetchImpl, push: () => {} });
  const [first, second] = await Promise.all([once(), once()]);
  assert.deepEqual([first.outcome, second.outcome].sort(), ["ok", "skipped_locked"]);
  const calls = hands.requests.length;
  assert.equal((await once()).outcome, "skipped_locked", "a finished run keeps the claim for the window");
  assert.equal(hands.requests.length, calls);
});

test("a ticket that fails persistently is retried, skipped with a warn event, and the cursor advances in the same run", async () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  const warnings: string[] = [];
  const pushes: string[] = [];
  const state = stateAt();
  const hands = fakeHands({
    pages: { "cursor-0": { changes: [change(T1, USER_A, C1), change(T3, USER_B, C3)], next_cursor: "cursor-1" } },
    comments: { [T1]: [{ id: C1, author_type: "staff", body: REPLY_TEXT }], [T3]: [{ id: C3, author_type: "staff", body: REPLY_TEXT }] },
    detailStatus: { [T1]: [503] },
  });
  const result = await run({ state, fetchImpl: hands.fetchImpl, push: (userId) => pushes.push(userId), tracer, log: { warn: (line: string) => warnings.push(line) } });
  assert.equal(result.outcome, "ok");
  assert.equal(result.ticketsFailed, 1);
  assert.equal(hands.detailRequests().filter((r) => r.url.pathname.endsWith(T1)).length, 3, "one read and two retries");
  assert.deepEqual(pushes, [USER_B], "the failing ticket holds no other");
  assert.equal(state.cursors.get(APP_ID), "cursor-1");
  const skipped = traceEvents(sink, "server.product_feedback.unread_reconcile.ticket_skipped")[0];
  assert.ok(skipped, "warn event recorded");
  assert.match(JSON.stringify(skipped), /"level":"warn"/);
  assert.match(JSON.stringify(skipped), new RegExp(`"ticket_id":"${T1}"`));
  assert.match(JSON.stringify(skipped), /"error_code":"feedback_service_unavailable"/);
  assert.ok(warnings.some((line) => line.includes(T1) && line.includes("feedback_service_unavailable")));
});

test("a ticket that fails once is read again within the run and pushed", async () => {
  const pushes: string[] = [];
  const hands = fakeHands({
    pages: { "cursor-0": { changes: [change(T1, USER_A, C1)], next_cursor: "cursor-1" } },
    comments: { [T1]: [{ id: C1, author_type: "staff", body: REPLY_TEXT }] },
    detailStatus: { [T1]: [503, 200] },
  });
  const result = await run({ state: stateAt(), fetchImpl: hands.fetchImpl, push: (userId) => pushes.push(userId) });
  assert.equal(result.ticketsFailed, 0);
  assert.deepEqual(pushes, [USER_A]);
});

test("a deadline mid-page keeps the tickets done; later runs go on from there and finish the page", async () => {
  const state = stateAt();
  const pushes: string[] = [];
  const hands = fakeHands({
    pages: { "cursor-0": { changes: [change(T1, USER_A, C1), change(T2, USER_A, C2), change(T3, USER_B, C3)], next_cursor: "cursor-1" } },
    comments: {
      [T1]: [{ id: C1, author_type: "staff", body: REPLY_TEXT }],
      [T2]: [{ id: C2, author_type: "staff", body: REPLY_TEXT }],
      [T3]: [{ id: C3, author_type: "staff", body: REPLY_TEXT }],
    },
    detailDelayMs: { [T1]: 150, [T2]: 150, [T3]: 150 },
  });
  const outcomes: string[] = [];
  for (let attempt = 0; attempt < 3 && state.cursors.get(APP_ID) === "cursor-0"; attempt += 1) {
    state.expireClaim();
    const result = await run({ state, fetchImpl: hands.fetchImpl, push: (userId) => pushes.push(userId), runBudgetMs: 250, ticketBudgetMs: 0 });
    outcomes.push(result.outcome);
  }
  assert.equal(outcomes[0], "partial");
  assert.equal(state.cursors.get(APP_ID), "cursor-1", "the page was finished over several runs");
  assert.deepEqual(pushes.sort(), [USER_A, USER_A, USER_B].sort(), "each reply pushed once");
});

test("a page no run gets further into is passed after three runs (cursor_forced_advance)", async () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  const state = stateAt();
  const hands = fakeHands({
    pages: { "cursor-0": { changes: [change(T1, USER_A, C1)], next_cursor: "cursor-1" } },
    comments: { [T1]: [{ id: C1, author_type: "staff", body: REPLY_TEXT }] },
    detailDelayMs: { [T1]: 10_000 },
  });
  const results = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    state.expireClaim();
    results.push(await run({ state, fetchImpl: hands.fetchImpl, runBudgetMs: 60, ticketBudgetMs: 0, tracer }));
  }
  assert.deepEqual(results.map((result) => result.cursorForcedAdvance), [false, false, true]);
  assert.equal(state.cursors.get(APP_ID), "cursor-1");
  assert.equal(traceEvents(sink, "server.product_feedback.unread_reconcile.cursor_forced_advance").length, 1);
});

test("a 429 ends the run, keeps the cursor, and no run calls Hands before Retry-After", async () => {
  const state = stateAt();
  const limited = fakeHands({ changesStatus: 429, changesHeaders: { "Retry-After": "120" } });
  const first = await run({ state, fetchImpl: limited.fetchImpl });
  assert.equal(first.outcome, "rate_limited");
  assert.equal(first.errorCode, "changes_rate_limited");
  assert.ok((await state.getNotBefore(APP_ID))! >= Date.now() + 100_000);
  state.expireClaim();
  const healthy = fakeHands({ pages: { "cursor-0": { changes: [], next_cursor: "cursor-1" } } });
  assert.equal((await run({ state, fetchImpl: healthy.fetchImpl })).outcome, "skipped_backoff");
  assert.equal(healthy.requests.length, 0);
  assert.equal(state.cursors.get(APP_ID), "cursor-0");

  // A detail 429 too.
  const detailState = stateAt();
  const detailLimited = fakeHands({
    pages: { "cursor-0": { changes: [change(T1, USER_A, C1)], next_cursor: "cursor-1" } },
    detailStatus: { [T1]: [429] },
  });
  const viaDetail = await run({ state: detailState, fetchImpl: detailLimited.fetchImpl });
  assert.equal(viaDetail.outcome, "rate_limited");
  assert.equal(detailLimited.detailRequests().length, 1, "a 429 is not retried");
  assert.equal(detailState.cursors.get(APP_ID), "cursor-0");
});

/** A stand-in for the bounded Redis client: `status` as ioredis reports it; every command fails unless given. */
function fakeRedis(status: string, get: () => Promise<string | null> = () => Promise.reject(new Error("Connection is closed."))) {
  const client = { status, get: vi.fn(get), set: vi.fn(get), eval: vi.fn(get), del: vi.fn(get) };
  return { client, state: redisProductFeedbackReconcileState(() => client as never) };
}

test("a run before the Redis client first connects (a task just started) skips: not failed, no Hands call, no state write", async () => {
  const sink = new MemoryTraceSink();
  const hands = fakeHands({});
  const { client, state } = fakeRedis("connecting");
  const result = await run({ state, fetchImpl: hands.fetchImpl, push: () => {}, tracer: new BasicTracer({ sink }) });
  assert.equal(result.outcome, "skipped_not_ready");
  assert.equal(result.errorCode, null);
  assert.equal(hands.requests.length, 0);
  for (const command of [client.get, client.set, client.eval, client.del]) assert.equal(command.mock.calls.length, 0);
  const runEvent = JSON.stringify(traceEvents(sink, "server.product_feedback.unread_reconcile.run"));
  assert.match(runEvent, /"outcome":"skipped_not_ready"/);
  assert.doesNotMatch(runEvent, /error_code/);
});

test("a Redis client that was ready and fails a command (an outage) still fails the run with state_unavailable", async () => {
  const hands = fakeHands({});
  const { client, state } = fakeRedis("ready");
  const first = await run({ state, fetchImpl: hands.fetchImpl, push: () => {} });
  assert.equal(first.outcome, "failed");
  assert.equal(first.errorCode, "state_unavailable");
  client.status = "reconnecting";
  const second = await run({ state, fetchImpl: hands.fetchImpl, push: () => {} });
  assert.deepEqual([second.outcome, second.errorCode], ["failed", "state_unavailable"], "a dropped connection is an outage, not a boot");
  assert.equal(hands.requests.length, 0);
});

test("a run that lost its claim does not save its cursor", async () => {
  const state = stateAt();
  const hands = fakeHands({
    pages: { "cursor-0": { changes: [change(T1, USER_A, C1)], next_cursor: "cursor-1" } },
    comments: { [T1]: [{ id: C1, author_type: "staff", body: REPLY_TEXT }] },
  });
  const result = await run({ state, fetchImpl: hands.fetchImpl, push: () => state.expireClaim() });
  assert.equal(result.errorCode, "claim_lost");
  assert.equal(state.cursors.get(APP_ID), "cursor-0");
});

test("a rejected cursor resets to Hands' current position at once, never silently: a warn event with last_success_at and the gap", async () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  const warnings: string[] = [];
  const state = memoryProductFeedbackReconcileState();
  // The last good page, 10 minutes ago.
  const lastSuccess = Date.now() - 600_000;
  await state.claim("earlier-run", 60_000, PRODUCT_FEEDBACK_RECONCILE_CLAIM_KEY);
  await state.saveCursor("earlier-run", APP_ID, "stale-cursor", lastSuccess, PRODUCT_FEEDBACK_RECONCILE_CLAIM_KEY);
  state.expireClaim();
  const hands = fakeHands({ pages: {} });
  const result = await run({ state, fetchImpl: hands.fetchImpl, tracer, log: { warn: (line: string) => warnings.push(line) } });
  assert.equal(result.outcome, "cursor_reset");
  assert.equal(state.cursors.get(APP_ID), "position-0");
  assert.deepEqual(hands.requests.map((r) => r.url.searchParams.get("cursor")), ["stale-cursor", null]);
  const reset = traceEvents(sink, "server.product_feedback.unread_reconcile.cursor_reset")[0];
  assert.ok(reset, "cursor_reset event recorded");
  const attrs = (reset as { attrs?: Record<string, unknown> }).attrs ?? {};
  assert.equal(attrs.level, "warn");
  assert.equal(attrs.reason, "changes_invalid_cursor");
  assert.equal(attrs.last_success_at, new Date(lastSuccess).toISOString());
  assert.ok(Number(attrs.gap_seconds) >= 600);
  assert.ok(warnings.some((line) => line.includes("cursor reset") && line.includes(new Date(lastSuccess).toISOString())));
});

test("each run leaves one span and one run event with bounded counts and no user ids, subjects or tokens", async () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  const hands = fakeHands({
    pages: { "cursor-0": { changes: [change(T1, USER_A, C1)], next_cursor: "cursor-1" } },
    comments: { [T1]: [{ id: C1, author_type: "staff", body: REPLY_TEXT }] },
  });
  await run({ state: stateAt(), fetchImpl: hands.fetchImpl, push: () => {}, tracer });
  const spans = sink.getAllSpans();
  assert.ok(spans.find((span) => span.name === "server.product_feedback.unread_reconcile"));
  const serialized = JSON.stringify([spans, sink.getAllLogEvents()]);
  for (const leak of [USER_A, reporter(USER_A), subject(USER_A), T1, C1, "conversation-token", REPLY_TEXT, "cursor-0", "cursor-1"]) {
    assert.ok(!serialized.includes(leak), `trace must not carry ${leak}`);
  }
  const runEvent = traceEvents(sink, "server.product_feedback.unread_reconcile.run")[0];
  assert.ok(runEvent, "run event recorded");
  for (const attr of [/"outcome":"ok"/, /"users_pushed":1/, /"tickets_changed":1/, /"tickets_failed":0/, /"pages":1/, /"duration_ms":\d+/]) {
    assert.match(JSON.stringify(runEvent), attr);
  }
  const changeSpan = spans.find((span) => span.name === "server.product_feedback.unread_reconcile.hands_request");
  assert.equal(changeSpan?.attrs?.hands_route, "/api/apps/:appId/reporter-feedback/changes");
});

test("tickets failing in a row stop the run with the cursor kept, and never open the breaker people's reads use", async () => {
  const hands = fakeHands({
    pages: { "cursor-0": { changes: [change(T1, USER_A, C1), change(T2, USER_A, C2), change(T3, USER_B, C3)], next_cursor: "cursor-1" } },
    detailStatus: { [T1]: [503], [T2]: [503], [T3]: [503] },
  });
  const state = stateAt();
  const result = await run({ state, fetchImpl: hands.fetchImpl });
  assert.equal(result.ticketsFailed, 3);
  assert.equal(result.outcome, "partial");
  assert.equal(result.errorCode, "details_failing");
  assert.equal(state.cursors.get(APP_ID), "cursor-0", "Hands failing, not a ticket: the page is kept");
  // A person's read right after: not refused by an open breaker.
  const ok = fakeHands({ comments: { [T1]: [] } });
  const detail = await getProductFeedbackTicket({
    userId: USER_A, reporterId: reporter(USER_A), ticketId: T1, commentLimit: 50, env: ENV, fetchImpl: ok.fetchImpl,
  });
  assert.equal(detail.ticket.id, T1);
  assert.equal(ok.detailRequests()[0]!.url.searchParams.has("mark_read"), false, "a person's read marks read as before");
});

test("stop() aborts a run in flight and returns promptly; the cursor stays", async () => {
  const state = stateAt();
  let aborted = false;
  let started!: () => void;
  const inFlight = new Promise<void>((resolve) => { started = resolve; });
  const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    started();
    init?.signal?.addEventListener("abort", () => { aborted = true; reject(init.signal!.reason); }, { once: true });
  })) as typeof fetch;
  const worker = startProductFeedbackUnreadReconcileWorker({ env: ENV, intervalMs: 60_000, deps: { state, fetchImpl, push: () => {} } });
  const tick = worker.tick();
  await inFlight;
  const stoppedAt = Date.now();
  await worker.stop();
  await tick;
  assert.ok(Date.now() - stoppedAt < 1_000, "stop() does not wait for the Hands timeout");
  assert.equal(aborted, true);
  assert.equal(state.cursors.get(APP_ID), "cursor-0");
});

test("without HANDS_FEEDBACK_UNREAD_RECONCILE_ENABLED=true the job is off: no timer, no Hands call, one log line", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  try {
    // A complete conversation configuration alone never turns it on.
    const env = { ...ENV, HANDS_FEEDBACK_UNREAD_RECONCILE_ENABLED: undefined };
    assert.deepEqual(readProductFeedbackReconcileConfig(env), { disabled: "not_enabled" });
    assert.deepEqual(readProductFeedbackReconcileConfig({ ...ENV, HANDS_FEEDBACK_CONVERSATION_APP_TOKEN: undefined }), { disabled: "conversation_unconfigured" });
    const worker = startProductFeedbackUnreadReconcileWorker({ env, intervalMs: 1 });
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await worker.stop();
    assert.equal(fetchSpy.mock.calls.length, 0);
    assert.deepEqual(info.mock.calls.map((call) => String(call[0])), ["[product-feedback] unread reconcile off (not_enabled)"]);
  } finally {
    info.mockRestore();
    fetchSpy.mockRestore();
  }
});
