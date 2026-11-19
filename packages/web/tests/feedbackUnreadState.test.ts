import assert from "node:assert/strict";
import api from "../src/api/client";
import { createHandsFeedbackTransport } from "../src/feedback/createHandsFeedbackTransport";
import {
  __resetFeedbackUnreadBackoffForTest,
  acceptFeedbackAppUnreadPush,
  acceptFeedbackUnreadPush,
  captureFeedbackUnreadListRead,
  captureFeedbackUnreadUpdate,
  feedbackUnreadSnapshot,
  refreshFeedbackUnreadAfterReconnect,
  retainFeedbackUnread,
} from "../src/feedback/feedbackUnreadState";

// The "new reply" dot once the Feedback list merges every client's tickets:
// each app's total from `unread_by_source`, summed; and, while the server
// sends no `unread_by_source`, the web's total exactly as before.

const USER = "user-1";
const originalGet = api.get;
let listParams: Array<Record<string, unknown>> = [];
let release: (() => void) | null = null;

function answerLists(...pages: unknown[]) {
  api.get = (async (_url: string, config?: { params?: Record<string, unknown> }) => {
    listParams.push(config?.params ?? {});
    return { data: pages.shift() };
  }) as typeof api.get;
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function retain() {
  release = retainFeedbackUnread(USER, (id) => id === USER);
  await settle();
}

const dot = () => feedbackUnreadSnapshot(USER);

beforeEach(() => {
  listParams = [];
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
});

afterEach(() => {
  release?.();
  release = null;
  __resetFeedbackUnreadBackoffForTest();
  api.get = originalGet;
  vi.unstubAllGlobals();
});

test("the background read asks every app; with unread_by_source the dot is their sum, and each push replaces its app", async () => {
  answerLists({ tickets: [], next_cursor: null, unread_total: 3, unread_by_source: { web: 1, android: 2 } });
  await retain();
  assert.deepEqual(listParams[0], { limit: 1, sources: "all", degraded_ok: 1 });
  assert.equal(dot(), 3);

  acceptFeedbackAppUnreadPush({ source: "android", unreadTotal: 0 });
  assert.equal(dot(), 1, "the Android App's push replaces Android's share");
  acceptFeedbackUnreadPush({ userId: USER, unreadTotal: 5 });
  assert.equal(dot(), 5, "the web push replaces the web's share");
  acceptFeedbackAppUnreadPush({ source: "ios", unreadTotal: 2 });
  assert.equal(dot(), 7);
  // Not an app this build knows, or not a count: nothing.
  acceptFeedbackAppUnreadPush({ source: "symbian" as never, unreadTotal: 9 });
  acceptFeedbackAppUnreadPush({ source: "android", unreadTotal: -1 });
  assert.equal(dot(), 7);
});

test("a ticket read replaces its app's share; an app missing from a later read keeps its value", async () => {
  answerLists(
    { tickets: [], next_cursor: null, unread_total: 3, unread_by_source: { web: 1, android: 2 } },
    // Android didn't answer: no key, and the sum is null.
    { tickets: [], next_cursor: null, unread_total: null, unread_by_source: { web: 4 } },
  );
  await retain();
  captureFeedbackUnreadUpdate()(0, "android");
  assert.equal(dot(), 1);
  captureFeedbackUnreadUpdate()(1, "ohos");
  assert.equal(dot(), 2);
  refreshFeedbackUnreadAfterReconnect();
  await settle();
  assert.equal(dot(), 5, "web 4 + android 0 (kept) + ohos 1 (kept)");
});

test("the panel's own list read: its first page sets the shares, a cursor page that knows no total changes nothing", async () => {
  answerLists({ tickets: [], next_cursor: null, unread_total: 3, unread_by_source: { web: 1, android: 2 } });
  await retain();
  // One ticket a page: an empty page with a next cursor is followed (transport).
  const ticket = (id: string) => ({
    id, kind: "feedback", status: "open", closure_reason: null, duplicate_of_ticket_id: null, message: "A ticket",
    created_at: 1, updated_at: 2, unread: false, unread_count: 0, attachment_count: 0, comment_count: 0,
  });
  const pages = [
    { tickets: [ticket("11111111-1111-4111-8111-111111111111")], next_cursor: "a", unread_total: 6, unread_by_source: { web: 2, android: 4 } },
    { tickets: [ticket("22222222-2222-4222-8222-222222222222")], next_cursor: "b", unread_total: null },
    { tickets: [ticket("33333333-3333-4333-8333-333333333333")], next_cursor: null },
  ];
  answerLists(...pages);
  const transport = createHandsFeedbackTransport(api, { allSources: true, captureListUnread: captureFeedbackUnreadListRead });
  const signal = new AbortController().signal;
  await transport.listTickets({ limit: 20, signal });
  assert.equal(dot(), 6);
  await transport.listTickets({ cursor: "a", limit: 20, signal });
  await transport.listTickets({ cursor: "b", limit: 20, signal });
  assert.equal(dot(), 6, "null and absent totals keep the dot");
});

test("without unread_by_source (older server) the dot is the list's total, web pushes and web ticket reads replace it, other apps are ignored", async () => {
  answerLists({ tickets: [], next_cursor: null, unread_total: 4 });
  await retain();
  assert.equal(dot(), 4);
  acceptFeedbackAppUnreadPush({ source: "android", unreadTotal: 0 });
  captureFeedbackUnreadUpdate()(9, "android");
  assert.equal(dot(), 4, "another app's push or ticket read says nothing about the web's total");
  acceptFeedbackUnreadPush({ userId: USER, unreadTotal: 2 });
  assert.equal(dot(), 2);
  captureFeedbackUnreadUpdate()(1, "web");
  assert.equal(dot(), 1);

  // A first page that knows no total (an app unavailable) keeps the count.
  answerLists({ tickets: [], next_cursor: null, unread_total: null });
  refreshFeedbackUnreadAfterReconnect();
  await settle();
  assert.equal(dot(), 1);
  // And a cursor page through the panel's transport, too.
  answerLists({ tickets: [], next_cursor: null, unread_total: null });
  await createHandsFeedbackTransport(api, { allSources: true, captureListUnread: captureFeedbackUnreadListRead })
    .listTickets({ cursor: "a", limit: 20, signal: new AbortController().signal });
  assert.equal(dot(), 1);
});
