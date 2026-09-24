import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { FeedbackTransportError } from "@botiverse/hands-feedback-react/source";
import api from "../src/api/client";
import {
  feedbackTransportError,
  handsFeedbackTransport,
} from "../src/feedback/handsFeedbackTransport";

const originalGet = api.get;
const originalPost = api.post;
const TICKET = "33333333-3333-4333-8333-333333333333";

function apiTicket(overrides: Record<string, unknown> = {}) {
  return {
    id: TICKET,
    kind: "feedback",
    status: "in_progress",
    closure_reason: null,
    duplicate_of_ticket_id: null,
    message: "Please keep the workspace open.",
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_001_000,
    unread: true,
    unread_count: 2,
    attachment_count: 1,
    comment_count: 3,
    ...overrides,
  };
}

function apiDetail() {
  return {
    ticket: apiTicket({ unread: false, unread_count: 0 }),
    comments: [{
      id: "44444444-4444-4444-8444-444444444444",
      author_type: "staff",
      body: "The fix is ready.",
      created_at: 1_700_000_001_000,
    }],
    attachments: [{
      id: "55555555-5555-4555-8555-555555555555",
      filename: "screen.png",
      content_type: "image/png",
      size_bytes: 12,
      created_at: 1_700_000_000_000,
    }],
    next_comment_cursor: null,
    unread_total: 0,
  };
}

afterEach(() => {
  api.get = originalGet;
  api.post = originalPost;
});
test("transport maps authoritative list and detail unread fields", async () => {
  const calls: Array<{ url: string; params: unknown }> = [];
  api.get = (async (url: string, config?: { params?: unknown }) => {
    calls.push({ url, params: config?.params });
    if (url === "/product-feedback/tickets") {
      return { data: { tickets: [apiTicket()], next_cursor: "next", unread_total: 1 } };
    }
    return { data: apiDetail() };
  }) as typeof api.get;

  const signal = new AbortController().signal;
  const page = await handsFeedbackTransport.listTickets({ limit: 20, signal });
  assert.equal(page.unreadTotal, 1);
  assert.equal(page.tickets[0]?.unread, true);
  assert.equal(page.tickets[0]?.unreadCount, 2);

  const detail = await handsFeedbackTransport.getTicket({
    ticketId: TICKET,
    commentLimit: 100,
    signal,
  });
  assert.equal(detail.unreadTotal, 0);
  assert.equal(detail.ticket.unread, false);
  assert.deepEqual(calls.map((call) => call.url), [
    "/product-feedback/tickets",
    `/product-feedback/tickets/${TICKET}`,
  ]);
});

test("attachment preview reads the authenticated ticket attachment as a blob", async () => {
  const attachmentId = "55555555-5555-4555-8555-555555555555";
  const blob = new Blob(["image"], { type: "image/png" });
  let request: { url: string; responseType?: string; signal?: AbortSignal } | null = null;
  api.get = (async (
    url: string,
    config?: { responseType?: string; signal?: AbortSignal },
  ) => {
    request = { url, ...config };
    return { data: blob };
  }) as typeof api.get;
  const signal = new AbortController().signal;

  const result = await handsFeedbackTransport.getAttachment?.({
    ticketId: TICKET,
    attachmentId,
    signal,
  });

  assert.equal(result, blob);
  assert.deepEqual(request, {
    url: `/product-feedback/tickets/${TICKET}/attachments/${attachmentId}`,
    responseType: "blob",
    signal,
  });
});

test("reply sends ordered multipart files then refreshes authoritative detail", async () => {
  let submission: FormData | null = null;
  api.post = (async (
    _url: string,
    body: FormData,
    config?: { onUploadProgress?: (event: { loaded: number; total?: number }) => void },
  ) => {
    submission = body;
    config?.onUploadProgress?.({ loaded: 37, total: 100 });
    return { data: { id: "comment" } };
  }) as typeof api.post;
  api.get = (async () => ({ data: apiDetail() })) as typeof api.get;
  const progress: Array<[number, number]> = [];
  const attachment = new File(["image"], "screen shot.png", { type: "image/png" });

  const detail = await handsFeedbackTransport.addComment({
    ticketId: TICKET,
    body: "Here is the reproduction.",
    submissionId: "66666666-6666-4666-8666-666666666666",
    attachments: [attachment],
    signal: new AbortController().signal,
    onAttachmentProgress: ({ index, progress: value }) => progress.push([index, value]),
  });

  assert.equal(submission?.get("body"), "Here is the reproduction.");
  assert.equal(submission?.get("submission_id"), "66666666-6666-4666-8666-666666666666");
  assert.equal((submission?.get("attachments") as File).name, "screen shot.png");
  assert.deepEqual(progress, [[0, 0], [0, 0.37], [0, 1]]);
  assert.equal(detail.unreadTotal, 0);
});

test("close posts once then refreshes authoritative closed detail", async () => {
  const calls: string[] = [];
  api.post = (async (url: string, body: unknown) => {
    calls.push(`POST ${url}`);
    assert.deepEqual(body, { reason: "completed" });
    return { data: {
      id: TICKET,
      status: "closed",
      closure_reason: "completed",
      duplicate_of_ticket_id: null,
      updated_at: 1,
      changed: true,
    } };
  }) as typeof api.post;
  api.get = (async (url: string) => {
    calls.push(`GET ${url}`);
    return { data: apiDetail() };
  }) as typeof api.get;

  const detail = await handsFeedbackTransport.closeTicket?.({
    ticketId: TICKET,
    reason: "completed",
    signal: new AbortController().signal,
  });

  assert.deepEqual(calls, [
    `POST /product-feedback/tickets/${TICKET}/close`,
    `GET /product-feedback/tickets/${TICKET}`,
  ]);
  assert.equal(detail?.ticket.id, TICKET);
  assert.equal(detail?.unreadTotal, 0);
});

test("create uses the existing private submission endpoint and then opens its ticket", async () => {
  let submission: FormData | null = null;
  const progress: Array<[number, number]> = [];
  api.post = (async (
    url: string,
    body: FormData,
    config?: { onUploadProgress?: (event: { loaded: number; total?: number }) => void },
  ) => {
    assert.equal(url, "/product-feedback");
    submission = body;
    config?.onUploadProgress?.({ loaded: 72, total: 100 });
    return { data: { id: TICKET } };
  }) as typeof api.post;
  api.get = (async () => ({ data: apiDetail() })) as typeof api.get;

  const detail = await handsFeedbackTransport.createTicket({
    kind: "bug",
    message: "The composer jumps.",
    submissionId: "77777777-7777-4777-8777-777777777777",
    attachments: [
      new File(["image"], "create.png", { type: "image/png" }),
    ],
    signal: new AbortController().signal,
    onAttachmentProgress: ({ index, progress: value }) =>
      progress.push([index, value]),
  });

  assert.equal(submission?.get("type"), "problem");
  assert.equal(submission?.get("may_contact"), "false");
  assert.deepEqual(progress, [[0, 0], [0, 0.72], [0, 1]]);
  assert.equal(detail.ticket.id, TICKET);
});

test("transport exposes only the SDK closed error vocabulary", () => {
  for (const [code, expected] of [
    ["feedback_comment_conflict", "conflict"],
    ["feedback_not_found", "not_found"],
    ["feedback_rate_limited", "rate_limited"],
    ["feedback_attachment_type_invalid", "invalid"],
  ] as const) {
    const error = feedbackTransportError({ response: { data: { code } } });
    assert.ok(error instanceof FeedbackTransportError);
    assert.equal(error.code, expected);
  }
});
