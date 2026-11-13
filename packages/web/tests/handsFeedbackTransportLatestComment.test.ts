import assert from "node:assert/strict";
import type { AxiosInstance } from "axios";
import { createHandsFeedbackTransport } from "../src/feedback/createHandsFeedbackTransport";

function row(overrides: Record<string, unknown>) {
  return {
    id: "33333333-3333-4333-8333-333333333333",
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
    comment_count: 1,
    ...overrides,
  };
}

test("the list carries each ticket's latest comment to the feedback SDK", async () => {
  const api = {
    get: async () => ({
      data: {
        tickets: [
          row({ latest_comment: { author_type: "staff", body_preview: "Fixed", created_at: 5 } }),
          row({ id: "55555555-5555-4555-8555-555555555555", latest_comment: null }),
          row({ id: "66666666-6666-4666-8666-666666666666" }),
        ],
        next_cursor: null,
        unread_total: 0,
      },
    }),
  } as unknown as AxiosInstance;
  const page = await createHandsFeedbackTransport(api).listTickets({ limit: 20 });
  assert.deepEqual(page.tickets[0]?.latestComment, {
    authorType: "staff",
    bodyPreview: "Fixed",
    createdAt: 5,
  });
  // Nobody has commented: an explicit null, so the row shows no preview line.
  assert.equal(page.tickets[1]?.latestComment, null);
  // A server that predates the field: left out, not invented.
  assert.equal("latestComment" in (page.tickets[2] ?? {}), false);
});
