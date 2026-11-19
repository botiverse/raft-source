import assert from "node:assert/strict";
import type { AxiosInstance } from "axios";
import { createHandsFeedbackTransport } from "../src/feedback/createHandsFeedbackTransport";
import { resetFeedbackTicketPlatformsForTest } from "../src/feedback/feedbackTicketPlatform";
import type { FeedbackListUnread } from "../src/feedback/productFeedbackListContract";

// `?sources=all` (server #14722): one list of every Hands app's tickets, each
// naming its app (`source`) and the client it was filed from (`client`).

const ANDROID_TICKET = "98c7adbd-1111-4111-8111-111111111111";
const WEB_TICKET = "33333333-3333-4333-8333-333333333333";
const IOS_TICKET = "77777777-7777-4777-8777-777777777777";

function row(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    kind: "feedback",
    status: "open",
    closure_reason: null,
    duplicate_of_ticket_id: null,
    message: "A ticket",
    created_at: 1,
    updated_at: 2,
    unread: false,
    unread_count: 0,
    attachment_count: 0,
    comment_count: 0,
    ...overrides,
  };
}

function detail(ticket: Record<string, unknown>, unreadTotal: number) {
  return { ticket, comments: [], attachments: [], next_comment_cursor: null, unread_total: unreadTotal };
}

type Call = { method: "get" | "post"; url: string; params: Record<string, unknown> };

/** Answers list reads from `pages` in order, a ticket read from `details[id]`. */
function fakeApi(pages: unknown[], details: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const answer = (method: Call["method"]) => async (url: string, ...rest: unknown[]) => {
    const config = (method === "get" ? rest[0] : rest[1]) as { params?: Record<string, unknown> } | undefined;
    calls.push({ method, url, params: config?.params ?? {} });
    if (url === "/product-feedback/tickets") return { data: pages.shift() };
    const id = /\/tickets\/([0-9a-f-]{36})/.exec(url)?.[1] ?? "";
    return { data: details[id] ?? detail(row(id), 0) };
  };
  return { api: { get: answer("get"), post: answer("post") } as unknown as AxiosInstance, calls };
}

const signal = () => new AbortController().signal;

afterEach(() => {
  resetFeedbackTicketPlatformsForTest();
});

test("the web's list asks every app on every page; each ticket's app routes its later calls", async () => {
  const { api, calls } = fakeApi([
    {
      tickets: [
        row(ANDROID_TICKET, { source: "android", client: "android" }),
        row(WEB_TICKET, { source: "web", client: "desktop" }),
      ],
      next_cursor: "next",
      unread_total: 0,
    },
    { tickets: [], next_cursor: null, unread_total: null },
  ]);
  const transport = createHandsFeedbackTransport(api, { allSources: true });
  await transport.listTickets({ limit: 20, signal: signal() });
  await transport.listTickets({ cursor: "next", limit: 20, signal: signal() });
  assert.deepEqual(calls[0]?.params, { limit: 20, sources: "all", degraded_ok: 1 });
  assert.deepEqual(calls[1]?.params, { limit: 20, sources: "all", cursor: "next" });

  await transport.getTicket({ ticketId: ANDROID_TICKET, commentLimit: 100, signal: signal() });
  await transport.closeTicket?.({ ticketId: ANDROID_TICKET, reason: "completed", signal: signal() });
  await transport.getTicket({ ticketId: WEB_TICKET, commentLimit: 100, signal: signal() });
  const ticketCalls = calls.slice(2);
  assert.deepEqual(ticketCalls.map((call) => call.params.platform), ["android", "android", "android", undefined]);
});

test("without allSources (the native page) the list is the caller's own app, as before", async () => {
  const { api, calls } = fakeApi([{ tickets: [], next_cursor: null, unread_total: 0 }]);
  await createHandsFeedbackTransport(api).listTickets({ limit: 20, signal: signal() });
  assert.deepEqual(calls[0]?.params, { limit: 20, degraded_ok: 1 });
});

test("a ticket read records the app its detail names", async () => {
  const { api, calls } = fakeApi([], {
    [IOS_TICKET]: detail(row(IOS_TICKET, { source: "ios", client: "ios" }), 3),
  });
  const updates: Array<[number, string]> = [];
  const transport = createHandsFeedbackTransport(api, {
    captureUnread: () => (count, source) => { updates.push([count, source]); },
  });
  const first = await transport.getTicket({ ticketId: IOS_TICKET, commentLimit: 100, signal: signal() });
  await transport.addComment({ ticketId: IOS_TICKET, body: "More", submissionId: "s", attachments: [], signal: signal() });
  assert.equal(first.ticket.client, "ios");
  assert.deepEqual(calls.map((call) => call.params.platform), [undefined, "ios", "ios"]);
  assert.deepEqual(updates, [[3, "ios"], [3, "ios"]], "the detail's total is reported as its app's");
});

test("a known client is passed to the SDK; an unknown or missing one is dropped", async () => {
  const { api } = fakeApi([{
    tickets: [
      row(ANDROID_TICKET, { source: "android", client: "desktop" }),
      row(WEB_TICKET, { source: "web", client: "symbian" }),
      row(IOS_TICKET),
    ],
    next_cursor: null,
    unread_total: 0,
  }]);
  const page = await createHandsFeedbackTransport(api, { allSources: true }).listTickets({ limit: 20, signal: signal() });
  assert.deepEqual(page.tickets.map((ticket) => ticket.client), ["desktop", undefined, undefined]);
  assert.equal("client" in page.tickets[1]!, false);
});

test("a page that knows no total (null or absent) hands the SDK the last known one and the dot nothing", async () => {
  const { api } = fakeApi([
    { tickets: [row(WEB_TICKET)], next_cursor: "a", unread_total: 4, unread_by_source: { web: 1, android: 3 } },
    { tickets: [row(ANDROID_TICKET)], next_cursor: "b", unread_total: null },
    { tickets: [row(IOS_TICKET)], next_cursor: null },
  ]);
  const reads: FeedbackListUnread[] = [];
  const transport = createHandsFeedbackTransport(api, {
    allSources: true,
    captureListUnread: () => (unread) => { reads.push(unread); },
  });
  const totals: number[] = [];
  totals.push((await transport.listTickets({ limit: 20, signal: signal() })).unreadTotal);
  totals.push((await transport.listTickets({ cursor: "a", limit: 20, signal: signal() })).unreadTotal);
  totals.push((await transport.listTickets({ cursor: "b", limit: 20, signal: signal() })).unreadTotal);
  // The SDK throws on anything but a count: the last known one stands in.
  assert.deepEqual(totals, [4, 4, 4]);
  assert.deepEqual(reads, [
    { total: 4, bySource: { web: 1, android: 3 } },
    { total: null, bySource: null },
    { total: null, bySource: null },
  ]);
});

test("an app unavailable on the first page: the SDK's total is the answering apps' sum, as the dot", async () => {
  const { api } = fakeApi([
    { tickets: [row(WEB_TICKET)], next_cursor: null, unread_total: null, unread_by_source: { web: 2, ios: 1 }, unavailable_sources: ["android"] },
  ]);
  const page = await createHandsFeedbackTransport(api, { allSources: true }).listTickets({ limit: 20, signal: signal() });
  assert.equal(page.unreadTotal, 3);
});

test("an empty page with a next cursor is followed, so a first page is never drawn as 'no feedback'", async () => {
  const { api, calls } = fakeApi([
    { tickets: [], next_cursor: "a", unread_total: 1, unread_by_source: { web: 1 } },
    { tickets: [], next_cursor: "b" },
    { tickets: [row(ANDROID_TICKET, { source: "android" })], next_cursor: "c" },
  ]);
  const reads: FeedbackListUnread[] = [];
  const transport = createHandsFeedbackTransport(api, {
    allSources: true,
    captureListUnread: () => (unread) => { reads.push(unread); },
  });
  const page = await transport.listTickets({ limit: 20, signal: signal() });
  assert.deepEqual(page.tickets.map((ticket) => ticket.id), [ANDROID_TICKET]);
  assert.equal(page.nextCursor, "c");
  assert.equal(page.unreadTotal, 1, "the first page's total, not a later page's");
  assert.deepEqual(calls.map((call) => call.params.cursor), [undefined, "a", "b"]);
  assert.deepEqual(reads[0], { total: 1, bySource: { web: 1 } });
});

test("following empty pages stops after a bound and ends the list on next_cursor null", async () => {
  const pages = Array.from({ length: 10 }, (_, index) => ({ tickets: [], next_cursor: `c${index}`, unread_total: index === 0 ? 0 : null }));
  const { api, calls } = fakeApi(pages);
  const page = await createHandsFeedbackTransport(api, { allSources: true }).listTickets({ limit: 20, signal: signal() });
  assert.equal(calls.length, 6, "the first page and five more at most");
  assert.equal(page.nextCursor, "c5", "the SDK can still load more");
  const { api: endApi } = fakeApi([{ tickets: [], next_cursor: null, unread_total: 0 }]);
  const end = await createHandsFeedbackTransport(endApi, { allSources: true }).listTickets({ limit: 20, signal: signal() });
  assert.deepEqual(end.tickets, []);
  assert.equal(end.nextCursor, null);
});
