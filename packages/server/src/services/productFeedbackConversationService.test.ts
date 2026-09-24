import assert from "node:assert/strict";
import { test } from "vitest";
import { createHmac } from "node:crypto";
import {
  closeProductFeedbackTicket,
  commentOnProductFeedbackTicket,
  decodeProductFeedbackCursor,
  encodeProductFeedbackCursor,
  getProductFeedbackAttachment,
  getProductFeedbackTicket,
  isProductFeedbackConversationConfigured,
  listProductFeedbackTickets,
  ProductFeedbackConversationError,
  productFeedbackConversationFailureLog,
  resetProductFeedbackBreakersForTest,
  resetProductFeedbackReporterSessionCacheForTest,
  safeProductFeedbackContentType,
  safeProductFeedbackFilename,
} from "./productFeedbackConversationService.js";

const ENV = {
  HANDS_FEEDBACK_BASE_URL: "https://hands.example/",
  HANDS_FEEDBACK_APP_ID: "850a1eca-2664-4e44-9020-51fbdf7a8a70",
  HANDS_FEEDBACK_CONVERSATION_APP_TOKEN: "conversation-token",
  HANDS_FEEDBACK_CONVERSATION_CREDENTIAL_REVISION: "token-revision-1",
  HANDS_FEEDBACK_CURSOR_SECRET: "cursor-secret",
} as NodeJS.ProcessEnv;

const INTEGRATION = "44444444-4444-4444-8444-444444444444";
const SESSION_ENV = {
  ...ENV,
  HANDS_FEEDBACK_CONVERSATION_SESSION_ENABLED: "true",
  HANDS_FEEDBACK_REPORTER_INTEGRATION_ID: INTEGRATION,
} as NodeJS.ProcessEnv;

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const TICKET = "33333333-3333-4333-8333-333333333333";

function ticket(overrides: Record<string, unknown> = {}) {
  return {
    id: TICKET,
    kind: "feedback",
    status: "open",
    closure_reason: null,
    duplicate_of_ticket_id: null,
    message: "Please add a compact command palette.",
    version_name: null,
    channel: "production",
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_001,
    attachment_count: 0,
    comment_count: 0,
    latest_comment_at: null,
    unread: false,
    unread_count: 0,
    ...overrides,
  };
}

function listResponse(headers?: HeadersInit): Response {
  return Response.json({ tickets: [], next_cursor: null, unread_total: 0 }, { headers });
}

test("cursor matches the frozen RFC 8785/HMAC vector", () => {
  const token = encodeProductFeedbackCursor({
    route: "ticket_list",
    userId: "fixture-user",
    ticketId: null,
    handsCursor: "c",
    issuedAtMs: 1_700_000_000_000,
  }, Buffer.alloc(32).toString("latin1"));
  assert.equal(
    token,
    "eyJoYW5kc19jdXJzb3IiOiJjIiwiaXNzdWVkX2F0X21zIjoxNzAwMDAwMDAwMDAwLCJyb3V0ZSI6InRpY2tldF9saXN0IiwidGlja2V0X2lkIjpudWxsLCJ1c2VyX2JpbmRpbmciOiJTdDRhYmxWSUtOS2tMXzh0amg0cjBUMnVZQnY5U1QyLVFaODlaWTIta0dzIiwidiI6MX0.OcPvqN6t1izh_2-5Ze99wH-Eaeo50Kh8S0NvCwwFmAQ",
  );
  assert.equal(decodeProductFeedbackCursor(token, {
    route: "ticket_list",
    userId: "fixture-user",
    ticketId: null,
    nowMs: 1_700_000_000_000,
  }, Buffer.alloc(32).toString("latin1")), "c");
});

test("cursor rejects padded segments and signed extra keys before Hands traffic", async () => {
  const key = "cursor-secret";
  const valid = encodeProductFeedbackCursor({
    route: "ticket_list", userId: USER, ticketId: null, handsCursor: "raw", issuedAtMs: 1_000_000,
  }, key);
  const [payloadSegment, macSegment] = valid.split(".");
  const padded = `${payloadSegment}=.${macSegment}=`;
  const user = createHmac("sha256", key).update(`feedback-cursor-user:${USER}`).digest("base64url");
  const extraPayload = `{"extra":true,"hands_cursor":"raw","issued_at_ms":1000000,"route":"ticket_list","ticket_id":null,"user_binding":"${user}","v":1}`;
  const extra = `${Buffer.from(extraPayload).toString("base64url")}.${createHmac("sha256", key).update(extraPayload).digest("base64url")}`;
  let calls = 0;
  for (const cursor of [padded, extra]) {
    await assert.rejects(listProductFeedbackTickets({
      userId: USER,
      reporterId: "opaque-reporter",
      limit: 20,
      cursor,
      env: ENV,
      now: () => 1_000_000,
      fetchImpl: async () => {
        calls += 1;
        return Response.json({ tickets: [], next_cursor: null, unread_total: 0 });
      },
    }), (error: unknown) => error instanceof ProductFeedbackConversationError && error.code === "feedback_invalid");
  }
  assert.equal(calls, 0);
});

test("cursor rejects cross-user, cross-route, and excessive future skew locally", () => {
  const token = encodeProductFeedbackCursor({
    route: "ticket_list", userId: USER, ticketId: null, handsCursor: "hands", issuedAtMs: 1_000_000,
  }, "key");
  for (const expected of [
    { route: "ticket_list" as const, userId: OTHER_USER, ticketId: null, nowMs: 1_000_000 },
    { route: "ticket_comments" as const, userId: USER, ticketId: TICKET, nowMs: 1_000_000 },
    { route: "ticket_list" as const, userId: USER, ticketId: null, nowMs: 699_999 },
  ]) {
    assert.throws(
      () => decodeProductFeedbackCursor(token, expected, "key"),
      (error: unknown) => error instanceof ProductFeedbackConversationError && error.code === "feedback_invalid",
    );
  }
});

test("list strips unknown upstream keys and wraps Hands cursor", async () => {
  let calls = 0;
  const result = await listProductFeedbackTickets({
    userId: USER,
    reporterId: "opaque-reporter",
    limit: 20,
    env: ENV,
    now: () => 1_700_000_000_000,
    fetchImpl: async (_url, init) => {
      calls += 1;
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer conversation-token");
      assert.equal(new Headers(init?.headers).get("X-Hands-Reporter-Id"), "opaque-reporter");
      return Response.json({
        tickets: [{ ...ticket({ kind: "bug", unread: true, unread_count: 2 }), contact: "must-not-cross" }],
        next_cursor: "hands-next",
        unread_total: 1,
      });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.tickets[0]?.unread, true);
  assert.equal(result.tickets[0]?.unread_count, 2);
  assert.equal(result.unread_total, 1);
  assert.equal(result.tickets[0]?.kind, "bug", "Raft Problem tickets must remain representable");
  assert.equal("contact" in (result.tickets[0] ?? {}), false);
  assert.equal(decodeProductFeedbackCursor(result.next_cursor!, {
    route: "ticket_list", userId: USER, ticketId: null, nowMs: 1_700_000_000_000,
  }, "cursor-secret"), "hands-next");
});

test("reporter sessions stay disabled unless the separate Raft flag is exactly true", () => {
  assert.equal(isProductFeedbackConversationConfigured({
    ...ENV,
    HANDS_FEEDBACK_CONVERSATION_SESSION_ENABLED: "TRUE",
  }), true);
  assert.equal(isProductFeedbackConversationConfigured({
    ...SESSION_ENV,
    HANDS_FEEDBACK_REPORTER_INTEGRATION_ID: `legacy-feedback:${ENV.HANDS_FEEDBACK_APP_ID}`,
  }), false, "flag-on session cache requires the canonical integration id in its cache key");
});

test("reporter session mint is single-flight and warm requests reuse the exact server-only cache entry", async () => {
  resetProductFeedbackReporterSessionCacheForTest();
  const now = 1_700_000_000_000;
  let mintCalls = 0;
  let listCalls = 0;
  let releaseMint!: () => void;
  const mintBarrier = new Promise<void>((resolve) => { releaseMint = resolve; });
  const timings: Array<string | null> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/reporter-feedback/session")) {
      mintCalls += 1;
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer conversation-token");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        scopes: ["feedback:comment", "feedback:read"],
      });
      await mintBarrier;
      return Response.json({
        session_token: "hrps_v1_test-session",
        expires_at: (now + 30_000) / 1_000,
        reporter_integration_id: INTEGRATION,
        scopes: ["feedback:comment", "feedback:read"],
      }, { status: 201, headers: { "Server-Timing": "hands_session_mint;dur=10.0" } });
    }
    listCalls += 1;
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer hrps_v1_test-session");
    return listResponse({ "Server-Timing": "hands_session_verify;dur=1.0, hands_list;dur=2.0" });
  };
  const invoke = () => listProductFeedbackTickets({
    userId: USER,
    reporterId: "opaque-reporter",
    limit: 20,
    env: SESSION_ENV,
    now: () => now,
    fetchImpl,
    onUpstreamServerTiming: (value) => timings.push(value),
  });
  const first = invoke();
  const second = invoke();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mintCalls, 1, "concurrent cold requests share one mint");
  releaseMint();
  await Promise.all([first, second]);
  await invoke();
  assert.equal(mintCalls, 1);
  assert.equal(listCalls, 3);
  assert.deepEqual(timings, [
    "hands_session_mint;dur=10.0, hands_session_verify;dur=1.0, hands_list;dur=2.0",
    "hands_session_mint;dur=10.0, hands_session_verify;dur=1.0, hands_list;dur=2.0",
    "hands_session_verify;dur=1.0, hands_list;dur=2.0",
  ]);
});

test("reporter session cache key isolates reporter, integration, and credential revision", async () => {
  resetProductFeedbackReporterSessionCacheForTest();
  const now = 1_700_000_000_000;
  const integrationB = "55555555-5555-4555-8555-555555555555";
  let mintCalls = 0;
  let expectedIntegration = INTEGRATION;
  const fetchImpl: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/reporter-feedback/session")) {
      mintCalls += 1;
      const reporter = new Headers(init?.headers).get("X-Hands-Reporter-Id");
      return Response.json({
        session_token: `hrps_v1_session-${mintCalls}-${reporter}`,
        expires_at: (now + 30_000) / 1_000,
        reporter_integration_id: expectedIntegration,
        scopes: ["feedback:comment", "feedback:read"],
      }, { status: 201 });
    }
    return listResponse();
  };
  const invoke = (reporterId: string, env: NodeJS.ProcessEnv) => listProductFeedbackTickets({
    userId: USER, reporterId, limit: 20, env, now: () => now, fetchImpl,
  });
  await invoke("reporter-a-opaque", SESSION_ENV);
  await invoke("reporter-a-opaque", SESSION_ENV);
  await invoke("reporter-b-opaque", SESSION_ENV);
  await invoke("reporter-a-opaque", {
    ...SESSION_ENV,
    HANDS_FEEDBACK_CONVERSATION_CREDENTIAL_REVISION: "token-revision-2",
  });
  expectedIntegration = integrationB;
  await invoke("reporter-a-opaque", {
    ...SESSION_ENV,
    HANDS_FEEDBACK_REPORTER_INTEGRATION_ID: integrationB,
  });
  assert.equal(mintCalls, 4, "only the identical six-part key reuses a session");
});

test("expired session plus mint failure never falls back to stale bytes", async () => {
  resetProductFeedbackReporterSessionCacheForTest();
  let now = 1_700_000_000_000;
  let mintCalls = 0;
  let listCalls = 0;
  const fetchImpl: typeof fetch = async (url) => {
    if (String(url).endsWith("/reporter-feedback/session")) {
      mintCalls += 1;
      if (mintCalls > 1) return new Response("unavailable", { status: 503 });
      return Response.json({
        session_token: "hrps_v1_short-session",
        expires_at: (now + 30_000) / 1_000,
        reporter_integration_id: INTEGRATION,
        scopes: ["feedback:comment", "feedback:read"],
      }, { status: 201 });
    }
    listCalls += 1;
    return listResponse();
  };
  const invoke = () => listProductFeedbackTickets({
    userId: USER, reporterId: "opaque-reporter", limit: 20,
    env: SESSION_ENV, now: () => now, fetchImpl,
  });
  await invoke();
  now += 26_000;
  await assert.rejects(invoke, (error: unknown) => (
    error instanceof ProductFeedbackConversationError
    && error.code === "feedback_service_unavailable"
  ));
  assert.equal(mintCalls, 2);
  assert.equal(listCalls, 1, "stale bearer never reaches the reporter route");
});

test("mint response must match the configured integration and closed DTO", async () => {
  resetProductFeedbackBreakersForTest();
  resetProductFeedbackReporterSessionCacheForTest();
  let routeCalls = 0;
  await assert.rejects(listProductFeedbackTickets({
    userId: USER,
    reporterId: "opaque-reporter",
    limit: 20,
    env: SESSION_ENV,
    now: () => 1_700_000_000_000,
    fetchImpl: async (url) => {
      if (String(url).endsWith("/reporter-feedback/session")) {
        return Response.json({
          session_token: "hrps_v1_wrong-integration",
          expires_at: 1_700_000_030,
          reporter_integration_id: "66666666-6666-4666-8666-666666666666",
          scopes: ["feedback:comment", "feedback:read"],
        }, { status: 201 });
      }
      routeCalls += 1;
      return listResponse();
    },
  }), (error: unknown) => (
    error instanceof ProductFeedbackConversationError
    && error.code === "feedback_service_unavailable"
    && error.diagnostic.stage === "reporter_session_receipt"
    && error.diagnostic.upstreamStatus === 201
    && error.diagnostic.breakerFailures === 1
    && error.diagnostic.breakerOpen === false
  ));
  assert.equal(routeCalls, 0);
});

test("mint response rejects oversized actual bytes before the reporter route", async () => {
  resetProductFeedbackReporterSessionCacheForTest();
  let routeCalls = 0;
  await assert.rejects(listProductFeedbackTickets({
    userId: USER,
    reporterId: "opaque-reporter",
    limit: 20,
    env: SESSION_ENV,
    now: () => 1_700_000_000_000,
    fetchImpl: async (url) => {
      if (String(url).endsWith("/reporter-feedback/session")) {
        return new Response(JSON.stringify({ padding: "x".repeat(9_000) }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      routeCalls += 1;
      return listResponse();
    },
  }), (error: unknown) => (
    error instanceof ProductFeedbackConversationError
    && error.code === "feedback_service_unavailable"
  ));
  assert.equal(routeCalls, 0);
});

test("a rejected session is evicted so the next request mints instead of replaying it", async () => {
  resetProductFeedbackBreakersForTest();
  resetProductFeedbackReporterSessionCacheForTest();
  const now = 1_700_000_000_000;
  let mintCalls = 0;
  let routeCalls = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/reporter-feedback/session")) {
      mintCalls += 1;
      return Response.json({
        session_token: `hrps_v1_session-${mintCalls}`,
        expires_at: (now + 30_000) / 1_000,
        reporter_integration_id: INTEGRATION,
        scopes: ["feedback:comment", "feedback:read"],
      }, { status: 201 });
    }
    routeCalls += 1;
    const bearer = new Headers(init?.headers).get("Authorization");
    return bearer === "Bearer hrps_v1_session-1"
      ? new Response("rejected", { status: 401 })
      : listResponse();
  };
  const invoke = () => listProductFeedbackTickets({
    userId: USER, reporterId: "opaque-reporter", limit: 20,
    env: SESSION_ENV, now: () => now, fetchImpl,
  });
  await assert.rejects(invoke, (error: unknown) => (
    error instanceof ProductFeedbackConversationError
    && error.code === "feedback_integration_unavailable"
  ));
  await invoke();
  assert.equal(mintCalls, 2);
  assert.equal(routeCalls, 2);
});

test("unknown enum rejects the entire DTO and repeated invalid DTO opens the breaker", async () => {
  resetProductFeedbackBreakersForTest();
  let calls = 0;
  const invoke = () => listProductFeedbackTickets({
    userId: USER,
    reporterId: "opaque-reporter",
    limit: 20,
    env: ENV,
    now: () => 10_000,
    fetchImpl: async () => {
      calls += 1;
      return Response.json({ tickets: [ticket({ status: "future_status" })], next_cursor: null, unread_total: 0 });
    },
  });
  await assert.rejects(invoke, ProductFeedbackConversationError);
  await assert.rejects(invoke, ProductFeedbackConversationError);
  await assert.rejects(invoke, ProductFeedbackConversationError);
  await assert.rejects(invoke, ProductFeedbackConversationError);
  assert.equal(calls, 3, "open breaker must reject the fourth request without Hands traffic");
});

test("breaker preserves integration error class after three 401 responses", async () => {
  resetProductFeedbackBreakersForTest();
  let calls = 0;
  const invoke = () => listProductFeedbackTickets({
    userId: USER,
    reporterId: "opaque-reporter",
    limit: 20,
    env: ENV,
    now: () => 20_000,
    fetchImpl: async () => {
      calls += 1;
      return new Response("unauthorized", { status: 401 });
    },
  });
  for (let index = 0; index < 4; index += 1) {
    await assert.rejects(invoke, (error: unknown) => (
      error instanceof ProductFeedbackConversationError
      && error.code === "feedback_integration_unavailable"
    ));
  }
  assert.equal(calls, 3);
});

test("429 normalizes HTTP-date Retry-After and never opens the breaker", async () => {
  resetProductFeedbackBreakersForTest();
  let calls = 0;
  const now = 1_700_000_000_000;
  const invoke = () => listProductFeedbackTickets({
    userId: USER,
    reporterId: "opaque-reporter",
    limit: 20,
    env: ENV,
    now: () => now,
    fetchImpl: async () => {
      calls += 1;
      return new Response("limited", {
        status: 429,
        headers: { "Retry-After": new Date(now + 13_000).toUTCString() },
      });
    },
  });
  for (let index = 0; index < 4; index += 1) {
    await assert.rejects(invoke, (error: unknown) => {
      assert.ok(error instanceof ProductFeedbackConversationError);
      assert.equal(error.code, "feedback_rate_limited");
      assert.equal(error.retryAfterSeconds, 13);
      return true;
    });
  }
  assert.equal(calls, 4, "rate limiting must not count toward the breaker");
});

test("detail carries the Hands-authoritative unread total after the read receipt", async () => {
  const result = await getProductFeedbackTicket({
    userId: USER,
    reporterId: "opaque-reporter",
    ticketId: TICKET,
    commentLimit: 50,
    env: ENV,
    fetchImpl: async () => Response.json({
      ticket: ticket(),
      comments: [{
        id: "44444444-4444-4444-8444-444444444444",
        author_type: "staff",
        body: "We are looking into it.",
        created_at: 1_700_000_000_010,
      }],
      attachments: [{
        id: "77777777-7777-4777-8777-777777777777",
        filename: "bad\\name\r\nX-Evil: yes",
        content_type: "image/png",
        size_bytes: 12,
        created_at: 1_700_000_000_011,
      }],
      next_comment_cursor: null,
      unread_total: 0,
    }),
  });
  assert.equal(result.comments.length, 1);
  assert.equal(result.unread_total, 0);
  assert.equal(result.attachments[0]?.filename, "badnameX-Evil: yes");
});

test("comment forwards multipart attachments and validates the Hands idempotency receipt", async () => {
  const result = await commentOnProductFeedbackTicket({
    reporterId: "opaque-reporter",
    ticketId: TICKET,
    body: "  Is there an update?  ",
    submissionId: "55555555-5555-4555-8555-555555555555",
    attachments: [{
      buffer: Buffer.from("image-bytes"),
      filename: "screen shot.png",
      contentType: "image/png",
    }],
    env: ENV,
    fetchImpl: async (_url, init) => {
      assert.ok(init?.body instanceof FormData);
      assert.equal(init.body.get("body"), "Is there an update?");
      assert.equal(init.body.get("submission_id"), "55555555-5555-4555-8555-555555555555");
      const attachment = init.body.get("attachments");
      assert.ok(attachment instanceof File);
      assert.equal(attachment.name, "screen shot.png");
      assert.equal(attachment.type, "image/png");
      assert.equal(await attachment.text(), "image-bytes");
      return Response.json({
        id: "66666666-6666-4666-8666-666666666666",
        ticket_id: TICKET,
        created_at: 1_700_000_000_020,
        idempotent_replay: false,
      }, { status: 201 });
    },
  });
  assert.equal(result.status, 201);
  assert.deepEqual(result.comment, {
    id: "66666666-6666-4666-8666-666666666666",
    author_type: "reporter",
    body: "Is there an update?",
    created_at: 1_700_000_000_020,
  });
});

test("close posts to the reporter-owned endpoint and validates changed and replay receipts", async () => {
  const updatedAt = 1_700_000_000_030;
  const receipts = [
    { id: TICKET, status: "closed", closure_reason: "completed", duplicate_of_ticket_id: null, updated_at: updatedAt, changed: true },
    { id: TICKET, status: "closed", closure_reason: "completed", duplicate_of_ticket_id: null, updated_at: null, changed: false },
  ];
  const paths: string[] = [];
  const methods: string[] = [];

  for (const expected of receipts) {
    const result = await closeProductFeedbackTicket({
      reporterId: "opaque-reporter",
      ticketId: TICKET,
      reason: "completed",
      env: ENV,
      fetchImpl: async (url, init) => {
        paths.push(String(url));
        methods.push(init?.method ?? "GET");
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("Authorization"), "Bearer conversation-token");
        assert.equal(headers.get("X-Hands-Reporter-Id"), "opaque-reporter");
        assert.deepEqual(JSON.parse(String(init?.body)), { reason: "completed" });
        return Response.json(expected);
      },
    });
    assert.deepEqual(result, {
      status: "closed",
      closure_reason: "completed",
      duplicate_of_ticket_id: null,
      updated_at: expected.updated_at,
      changed: expected.changed,
    });
  }

  assert.deepEqual(methods, ["POST", "POST"]);
  assert.ok(paths.every((path) => path.endsWith(`/reporter-feedback/${TICKET}/close`)));
});

test("close rejects a mismatched upstream ticket receipt", async () => {
  resetProductFeedbackBreakersForTest();
  let caught: ProductFeedbackConversationError | null = null;
  try {
    await closeProductFeedbackTicket({
      reporterId: "opaque-reporter",
      ticketId: TICKET,
      reason: "completed",
      env: ENV,
      fetchImpl: async () => Response.json({
        id: OTHER_USER,
        status: "closed",
        closure_reason: "completed",
        duplicate_of_ticket_id: null,
        updated_at: 1_700_000_000_030,
        changed: true,
      }),
    });
  } catch (error) {
    assert.ok(error instanceof ProductFeedbackConversationError);
    caught = error;
  }
  assert.ok(caught);
  assert.equal(caught.code, "feedback_service_unavailable");
  assert.deepEqual(productFeedbackConversationFailureLog("close", caught), {
    operation: "close",
    code: "feedback_service_unavailable",
    failure_stage: "close_receipt",
    upstream_status: 200,
    breaker_failures: 1,
    breaker_open: false,
  });
  const serialized = JSON.stringify(productFeedbackConversationFailureLog("close", caught));
  assert.doesNotMatch(serialized, new RegExp(TICKET));
  assert.doesNotMatch(serialized, /opaque-reporter/);
});

test("close diagnostics distinguish upstream response, transport, and breaker-open failures", async () => {
  const invoke = async (fetchImpl: typeof fetch): Promise<ProductFeedbackConversationError> => {
    try {
      await closeProductFeedbackTicket({
        reporterId: "opaque-reporter",
        ticketId: TICKET,
        reason: "completed",
        env: ENV,
        now: () => 10_000,
        fetchImpl,
      });
    } catch (error) {
      assert.ok(error instanceof ProductFeedbackConversationError);
      return error;
    }
    assert.fail("expected close to fail");
  };

  resetProductFeedbackBreakersForTest();
  const responseFailure = await invoke(async () => new Response("unavailable", { status: 502 }));
  assert.deepEqual(responseFailure.diagnostic, {
    stage: "upstream_response",
    upstreamStatus: 502,
    breakerFailures: 1,
    breakerOpen: false,
  });

  resetProductFeedbackBreakersForTest();
  const transportFailure = await invoke(async () => { throw new Error("network unavailable"); });
  assert.deepEqual(transportFailure.diagnostic, {
    stage: "upstream_transport",
    upstreamStatus: null,
    breakerFailures: 1,
    breakerOpen: false,
  });

  resetProductFeedbackBreakersForTest();
  let calls = 0;
  const failingFetch: typeof fetch = async () => {
    calls += 1;
    return new Response("unavailable", { status: 503 });
  };
  await invoke(failingFetch);
  await invoke(failingFetch);
  await invoke(failingFetch);
  const breakerFailure = await invoke(failingFetch);
  assert.equal(calls, 3);
  assert.deepEqual(breakerFailure.diagnostic, {
    stage: "breaker_open",
    upstreamStatus: null,
    breakerFailures: 3,
    breakerOpen: true,
  });
});

test("attachment content type distinguishes invalid syntax from safe fallback", () => {
  assert.equal(safeProductFeedbackContentType("image/png"), "image/png");
  assert.equal(safeProductFeedbackContentType("application/pdf"), "application/octet-stream");
  assert.throws(() => safeProductFeedbackContentType("image/png\r\nX-Evil: yes"), ProductFeedbackConversationError);
  const long = `${"a".repeat(119)}😀suffix`;
  const safe = safeProductFeedbackFilename(long);
  assert.equal([...safe].length, 120);
  assert.doesNotThrow(() => encodeURIComponent(safe));
});

test("attachment download does not call detail or mutate the authoritative read receipt", async () => {
  const paths: string[] = [];
  const result = await getProductFeedbackAttachment({
    userId: USER,
    reporterId: "opaque-reporter",
    ticketId: TICKET,
    attachmentId: "77777777-7777-4777-8777-777777777777",
    env: ENV,
    fetchImpl: async (url) => {
      paths.push(String(url));
      return new Response("image-bytes", {
        headers: {
          "content-length": "11",
          "content-type": "image/png",
          "content-disposition": 'attachment; filename="screen.png"',
        },
      });
    },
  });
  assert.equal(paths.length, 1);
  assert.match(paths[0]!, /\/attachments\/77777777-7777-4777-8777-777777777777$/);
  assert.doesNotMatch(paths[0]!, /comment_limit/);
  assert.equal(result.metadata.size_bytes, 11);
  assert.equal(result.filename, "screen.png");
  result.abort();
});
