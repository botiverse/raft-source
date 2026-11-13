import assert from "node:assert/strict";
import type { AxiosInstance } from "axios";
import { createHandsFeedbackTransport } from "../src/feedback/createHandsFeedbackTransport";
import {
  feedbackTicketPlatformFromSearch,
  rememberFeedbackTicketPlatform,
  resetFeedbackTicketPlatformsForTest,
} from "../src/feedback/feedbackTicketPlatform";

const MOBILE_TICKET = "98c7adbd-1111-4111-8111-111111111111";
const WEB_TICKET = "33333333-3333-4333-8333-333333333333";

function apiDetail(id: string, unreadTotal: number) {
  return {
    ticket: {
      id,
      kind: "bug",
      status: "open",
      closure_reason: null,
      duplicate_of_ticket_id: null,
      message: "Filed in the Android App.",
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_001_000,
      unread: false,
      unread_count: 0,
      attachment_count: 0,
      comment_count: 0,
    },
    comments: [],
    attachments: [],
    next_comment_cursor: null,
    unread_total: unreadTotal,
  };
}

type Call = { method: "get" | "post"; url: string; params: unknown };

function recordingApi(calls: Call[], unreadTotal: number): AxiosInstance {
  const answer = (method: Call["method"]) => async (url: string, ...rest: unknown[]) => {
    const config = (method === "get" ? rest[0] : rest[1]) as { params?: unknown } | undefined;
    calls.push({ method, url, params: config?.params });
    const id = /\/tickets\/([0-9a-f-]{36})/.exec(url)?.[1] ?? "";
    return { data: url.includes("/attachments/") ? new Blob(["image"]) : apiDetail(id, unreadTotal) };
  };
  return { get: answer("get"), post: answer("post") } as unknown as AxiosInstance;
}

afterEach(() => {
  resetFeedbackTicketPlatformsForTest();
});

test("a link's platform names a mobile App; anything else is the web's own app", () => {
  assert.equal(feedbackTicketPlatformFromSearch("?platform=android"), "android");
  assert.equal(feedbackTicketPlatformFromSearch("?x=1&platform=ios"), "ios");
  assert.equal(feedbackTicketPlatformFromSearch("?platform=ohos"), "ohos");
  for (const search of ["", "?platform=web", "?platform=symbian", "?platform=", "?Platform=android"]) {
    assert.equal(feedbackTicketPlatformFromSearch(search), null, search);
  }
});

test("every call about a ticket whose link named a mobile App asks that App, and the web's unread count is left alone", async () => {
  const calls: Call[] = [];
  const unreadUpdates: number[] = [];
  const transport = createHandsFeedbackTransport(recordingApi(calls, 7), {
    captureUnread: () => (count) => { unreadUpdates.push(count); },
  });
  rememberFeedbackTicketPlatform(MOBILE_TICKET, feedbackTicketPlatformFromSearch("?platform=android"));
  const signal = new AbortController().signal;

  await transport.getTicket({ ticketId: MOBILE_TICKET, commentLimit: 100, signal });
  await transport.getAttachment?.({ ticketId: MOBILE_TICKET, attachmentId: "55555555-5555-4555-8555-555555555555", signal });
  await transport.addComment({ ticketId: MOBILE_TICKET, body: "More detail.", submissionId: "44444444-4444-4444-8444-444444444444", attachments: [], signal });
  await transport.closeTicket({ ticketId: MOBILE_TICKET, reason: "completed", signal });

  // detail, attachment, comment + its detail read, close + its detail read
  assert.equal(calls.length, 6);
  for (const call of calls) {
    assert.equal((call.params as { platform?: string } | undefined)?.platform, "android", `${call.method} ${call.url}`);
  }
  assert.deepEqual(unreadUpdates, [], "the Android App's unread total is not the web's");
});

test("a web ticket's calls name no platform and keep updating the web's unread count", async () => {
  const calls: Call[] = [];
  const unreadUpdates: number[] = [];
  const transport = createHandsFeedbackTransport(recordingApi(calls, 2), {
    captureUnread: () => (count) => { unreadUpdates.push(count); },
  });
  rememberFeedbackTicketPlatform(MOBILE_TICKET, "android");
  // A link without a platform records nothing.
  rememberFeedbackTicketPlatform(WEB_TICKET, feedbackTicketPlatformFromSearch(""));
  const signal = new AbortController().signal;

  await transport.getTicket({ ticketId: WEB_TICKET, commentLimit: 100, signal });
  await transport.closeTicket({ ticketId: WEB_TICKET, reason: "completed", signal });

  for (const call of calls) {
    assert.equal("platform" in ((call.params ?? {}) as object), false, `${call.method} ${call.url}`);
  }
  assert.deepEqual(unreadUpdates, [2, 2]);
});
