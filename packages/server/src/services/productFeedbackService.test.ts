import assert from "node:assert/strict";
import { test } from "vitest";
import {
  ProductFeedbackConfigurationError,
  ProductFeedbackUpstreamError,
  ProductFeedbackValidationError,
  isProductFeedbackConfigured,
  normalizeProductFeedbackMetadata,
  productFeedbackReporterId,
  submitProductFeedback,
} from "./productFeedbackService.js";

const ENV = {
  HANDS_FEEDBACK_BASE_URL: "https://hands.example/",
  HANDS_FEEDBACK_APP_SLUG: "raft-web",
  HANDS_FEEDBACK_CLIENT_KEY: "qk_test",
  HANDS_FEEDBACK_APP_TOKEN: "hands_app_test",
  HANDS_FEEDBACK_REPORTER_ID_SECRET: "reporter-id-secret",
} as NodeJS.ProcessEnv;

test("product feedback capability requires all five deployment settings", () => {
  assert.equal(isProductFeedbackConfigured(ENV), true);
  assert.equal(isProductFeedbackConfigured({ ...ENV, HANDS_FEEDBACK_BASE_URL: "" }), false);
  assert.equal(isProductFeedbackConfigured({ ...ENV, HANDS_FEEDBACK_APP_SLUG: undefined }), false);
  assert.equal(isProductFeedbackConfigured({ ...ENV, HANDS_FEEDBACK_CLIENT_KEY: "" }), false);
  assert.equal(isProductFeedbackConfigured({ ...ENV, HANDS_FEEDBACK_APP_TOKEN: undefined }), false);
  assert.equal(isProductFeedbackConfigured({ ...ENV, HANDS_FEEDBACK_REPORTER_ID_SECRET: "   " }), false);
});

test("submitProductFeedback maps Idea, consent, metadata, attachment, and fixed submission id", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const receipt = await submitProductFeedback({
    submissionId: "11111111-1111-4111-8111-111111111111",
    kind: "idea",
    message: "A compact command palette would help.",
    contact: "Avery (@avery) <avery@example.com>",
    userId: "user-1",
    metadata: normalizeProductFeedbackMetadata({
      webVersion: "server-v1.1.0",
      locale: "en-US",
      browser: "Test Browser 1",
      osVersion: "Test OS",
      viewport: "1280x720@2",
    }),
    attachments: [{
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      filename: "screenshot.png",
      contentType: "image/png",
    }],
  }, {
    env: ENV,
    fetchImpl: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return new Response(JSON.stringify({
        id: "ticket-1",
        status: "open",
        reference: "raft-web · ticket ticket-1",
        ticket_url: "https://admin.example/ticket-1",
        attachments: 1,
      }), { status: 201, headers: { "Content-Type": "application/json" } });
    },
  });

  assert.equal(requestUrl, "https://hands.example/public/v2/apps/raft-web/feedback");
  assert.equal(new Headers(requestInit?.headers).get("X-Hands-Client-Key"), "qk_test");
  assert.equal(new Headers(requestInit?.headers).get("Authorization"), "Bearer hands_app_test");
  const reporterId = new Headers(requestInit?.headers).get("X-Hands-Reporter-Id");
  assert.match(reporterId ?? "", /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(reporterId, "user-1");
  assert.equal(new Headers(requestInit?.headers).has("X-Hands-Reporter-Key"), false);
  const body = requestInit?.body as FormData;
  assert.equal(body.get("message"), "A compact command palette would help.");
  assert.equal(body.get("kind"), "feedback");
  assert.equal(body.get("submission_id"), "11111111-1111-4111-8111-111111111111");
  assert.equal(body.get("contact"), "Avery (@avery) <avery@example.com>");
  assert.equal((body.getAll("attachments")[0] as File).name, "screenshot.png");
  assert.deepEqual(JSON.parse(String(body.get("metadata"))), {
    product_type: "web",
    client_kind: "web",
    platform: "web",
    surface: "settings.feedback",
    feedback_type: "idea",
    contact_consent: true,
    client_version: "server-v1.1.0",
    web_version: "server-v1.1.0",
    locale: "en-US",
    browser: "Test Browser 1",
    os_version: "Test OS",
    viewport: "1280x720@2",
  });
  assert.deepEqual(receipt, {
    id: "ticket-1",
    status: "open",
    reference: "raft-web · ticket ticket-1",
    attachments: 1,
  });
  assert.equal("ticket_url" in receipt, false, "admin ticket URL must never cross the Raft API boundary");
});

test("submitProductFeedback projects closed native attribution without web-only metadata", async () => {
  const requests: FormData[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    requests.push(init?.body as FormData);
    return new Response(JSON.stringify({ id: `ticket-${requests.length}`, status: "open" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  };

  await submitProductFeedback({
    submissionId: "55555555-5555-4555-8555-555555555555",
    kind: "problem",
    message: "Native feedback should carry iOS attribution.",
    contact: null,
    userId: "ios-user",
    metadata: normalizeProductFeedbackMetadata({
      trustedClientKind: "ios",
      clientKind: "ios",
      platform: "ios",
      clientVersion: "1.2.3",
      locale: "zh-CN",
      osVersion: "iOS 18.5",
    }),
    attachments: [],
  }, { env: ENV, fetchImpl });

  await submitProductFeedback({
    submissionId: "66666666-6666-4666-8666-666666666666",
    kind: "problem",
    message: "Native feedback should carry Android attribution.",
    contact: null,
    userId: "android-user",
    metadata: normalizeProductFeedbackMetadata({
      trustedClientKind: "android",
      clientKind: "android",
      platform: "android",
      clientVersion: "2026.7.26",
      locale: "en-US",
      osVersion: "Android 15",
    }),
    attachments: [],
  }, { env: ENV, fetchImpl });

  assert.deepEqual(JSON.parse(String(requests[0].get("metadata"))), {
    product_type: "ios",
    client_kind: "ios",
    platform: "ios",
    surface: "settings.feedback",
    feedback_type: "problem",
    contact_consent: false,
    client_version: "1.2.3",
    locale: "zh-CN",
    os_version: "iOS 18.5",
  });
  assert.deepEqual(JSON.parse(String(requests[1].get("metadata"))), {
    product_type: "android",
    client_kind: "android",
    platform: "android",
    surface: "settings.feedback",
    feedback_type: "problem",
    contact_consent: false,
    client_version: "2026.7.26",
    locale: "en-US",
    os_version: "Android 15",
  });
  for (const request of requests) {
    const metadata = JSON.parse(String(request.get("metadata"))) as Record<string, unknown>;
    assert.equal("web_version" in metadata, false);
    assert.equal("browser" in metadata, false);
    assert.equal("viewport" in metadata, false);
    assert.equal("userId" in metadata, false);
    assert.equal("reporterId" in metadata, false);
    assert.equal("baseUrl" in metadata, false);
    assert.equal("appToken" in metadata, false);
  }
});

test("normalizeProductFeedbackMetadata rejects unknown and spoofed client attribution before Hands traffic", () => {
  assert.throws(
    () => normalizeProductFeedbackMetadata({ clientKind: "mobile", platform: "ios", clientVersion: "1.0.0" }),
    ProductFeedbackValidationError,
  );
  assert.throws(
    () => normalizeProductFeedbackMetadata({ trustedClientKind: "ios", clientKind: "ios", platform: "web", clientVersion: "1.0.0" }),
    ProductFeedbackValidationError,
  );
  assert.throws(
    () => normalizeProductFeedbackMetadata({ trustedClientKind: "android", clientKind: "android", platform: "android", clientVersion: "1.0.0", browser: "SpoofBrowser" }),
    ProductFeedbackValidationError,
  );
  assert.throws(
    () => normalizeProductFeedbackMetadata({ trustedClientKind: "ios", clientKind: "ios", platform: "ios" }),
    ProductFeedbackValidationError,
  );
  assert.throws(
    () => normalizeProductFeedbackMetadata({ trustedClientKind: "web", clientKind: "ios", platform: "ios", clientVersion: "1.0.0" }),
    ProductFeedbackValidationError,
  );
});

test("submitProductFeedback maps Problem and omits contact without consent", async () => {
  let body: FormData | undefined;
  await submitProductFeedback({
    submissionId: "22222222-2222-4222-8222-222222222222",
    kind: "problem",
    message: "The dialog closes unexpectedly.",
    contact: null,
    userId: "user-2",
    metadata: normalizeProductFeedbackMetadata({}),
    attachments: [],
  }, {
    env: ENV,
    fetchImpl: async (_input, init) => {
      body = init?.body as FormData;
      return new Response(JSON.stringify({ id: "ticket-2", status: "open" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  assert.equal(body?.get("kind"), "bug");
  assert.equal(body?.has("contact"), false);
  assert.equal(JSON.parse(String(body?.get("metadata"))).contact_consent, false);
});

test("submitProductFeedback fails closed when Hands is not configured", async () => {
  await assert.rejects(
    submitProductFeedback({
      submissionId: "33333333-3333-4333-8333-333333333333",
      kind: "idea",
      message: "Hello",
      contact: null,
      userId: "user-3",
      metadata: normalizeProductFeedbackMetadata({}),
      attachments: [],
    }, { env: {} }),
    ProductFeedbackConfigurationError,
  );
});

test("submitProductFeedback preserves status and one bounded controlled upstream JSON error", async () => {
  await assert.rejects(
    submitProductFeedback({
      submissionId: "44444444-4444-4444-8444-444444444444",
      kind: "idea",
      message: "Hello",
      contact: null,
      userId: "user-4",
      metadata: normalizeProductFeedbackMetadata({}),
      attachments: [],
    }, {
      env: ENV,
      fetchImpl: async () => new Response(JSON.stringify({
        error: "  invalid client key\nfor this app  ",
        secret: "must not cross the boundary",
      }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "120" },
      }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProductFeedbackUpstreamError);
      assert.equal(error.upstreamStatus, 429);
      assert.equal(error.retryAfter, "120");
      assert.equal(error.upstreamError, "invalid client key for this app");
      assert.doesNotMatch(error.message, /invalid client key|must not cross/);
      return true;
    },
  );
});

test("submitProductFeedback rejects non-JSON and oversized upstream error bodies", async () => {
  const input = {
    submissionId: "77777777-7777-4777-8777-777777777777",
    kind: "idea" as const,
    message: "Hello",
    contact: null,
    userId: "user-7",
    metadata: normalizeProductFeedbackMetadata({}),
    attachments: [],
  };
  for (const response of [
    new Response("internal stack trace", { status: 500, headers: { "Content-Type": "text/plain" } }),
    new Response(JSON.stringify({ error: "x".repeat(5000) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    }),
  ]) {
    await assert.rejects(
      submitProductFeedback(input, { env: ENV, fetchImpl: async () => response }),
      (error: unknown) => {
        assert.ok(error instanceof ProductFeedbackUpstreamError);
        assert.equal(error.upstreamError, null);
        return true;
      },
    );
  }
});

test("reporter ids are stable per account, isolated across accounts, and irreversible", () => {
  const first = productFeedbackReporterId("user-1", "secret-a");
  assert.equal(first, productFeedbackReporterId("user-1", "secret-a"));
  assert.notEqual(first, productFeedbackReporterId("user-2", "secret-a"));
  assert.notEqual(first, productFeedbackReporterId("user-1", "secret-b"));
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.doesNotMatch(first, /user-1/);
});
