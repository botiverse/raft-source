import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import { getDb } from "../db/index.js";
import { users } from "../db/schema.js";
import { signAccessToken } from "../middleware/auth.js";
import { resetProductFeedbackRouteBindingCacheForTest } from "../services/productFeedbackRouteBindingService.js";
import {
  resetProductFeedbackBreakersForTest,
  resetProductFeedbackReporterSessionCacheForTest,
} from "../services/productFeedbackConversationService.js";
import { openTestApp } from "../test/integration/app.js";
import { buildProductFeedbackContact } from "./productFeedback.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seedUser() {
  const [user] = await getDb().insert(users).values({
    email: "feedback@slock.test",
    name: "feedback-user",
    displayName: "Feedback User",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

type CapturedHandsRequest = {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
};

const TEST_REPORTER_INTEGRATION_ID = "22222222-2222-4222-8222-222222222222";

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function multipartField(body: string, contentType: string | undefined, name: string): string {
  const boundary = contentType?.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[1]
    ?? contentType?.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[2];
  assert.ok(boundary, "multipart boundary should be present");
  const part = body.split(`--${boundary}`).find((candidate) => (
    candidate.includes(`name="${name}"`)
  ));
  assert.ok(part, `multipart field ${name} should be present`);
  const [, value = ""] = part.split(/\r?\n\r?\n/);
  return value.replace(/\r?\n--$/, "").trimEnd();
}

async function withHandsFeedbackUpstream<T>(
  run: (baseUrl: string, requests: CapturedHandsRequest[]) => Promise<T>,
  submitResponse: { status: number; body: Record<string, unknown>; serverTiming?: string } = {
    status: 201,
    body: { id: "ticket-native", status: "open", attachments: 0 },
  },
  closeResponse: { status: number; body: Record<string, unknown> } | null = null,
): Promise<T> {
  const requests: CapturedHandsRequest[] = [];
  const server = createHttpServer(async (req, res) => {
    const body = await readRequestBody(req);
    requests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
      body,
    });
    if (req.method === "PUT" && req.url?.includes("/reporter-feedback/route-subject")) {
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ changed: true, subject_version: "v1" }));
      return;
    }
    if (req.method === "POST" && req.url?.endsWith("/reporter-feedback/session")) {
      res.writeHead(201, {
        "Content-Type": "application/json",
        "Server-Timing": "hands_session_mint;dur=10.0",
      });
      res.end(JSON.stringify({
        session_token: "hrps_v1_api-test-session",
        expires_at: Math.floor(Date.now() / 1_000) + 30,
        reporter_integration_id: TEST_REPORTER_INTEGRATION_ID,
        scopes: ["feedback:comment", "feedback:read"],
      }));
      return;
    }
    if (req.method === "GET" && req.url?.includes("/reporter-feedback?")) {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Server-Timing": "hands_session_verify;dur=1.0, hands_list;dur=2.0",
      });
      res.end(JSON.stringify({ tickets: [], next_cursor: null, unread_total: 0 }));
      return;
    }
    if (req.method === "POST" && req.url?.endsWith("/close")) {
      const ticketId = req.url.split("/").at(-2) ?? "";
      res.writeHead(closeResponse?.status ?? 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(closeResponse?.body ?? {
        id: ticketId,
        status: "closed",
        closure_reason: "completed",
        duplicate_of_ticket_id: null,
        updated_at: 1_700_000_000_030,
        changed: true,
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/public/v2/apps/raft-web/feedback") {
      res.writeHead(submitResponse.status, {
        "Content-Type": "application/json",
        ...(submitResponse.serverTiming ? { "Server-Timing": submitResponse.serverTiming } : {}),
      });
      res.end(JSON.stringify(submitResponse.body));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unexpected request" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`, requests);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test("product feedback returns bounded Hands diagnostics beside the stable integration code", async () => {
  await withHandsFeedbackUpstream(async (baseUrl) => (
    withFeedbackEnv(baseUrl, async () => {
      const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
      try {
        const user = await seedUser();
        const token = signAccessToken(user.id);
        const form = new FormData();
        form.set("type", "idea");
        form.set("message", "Expose a safe upstream diagnostic.");
        form.set("submission_id", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        form.set("may_contact", "false");
        const response = await fetch(`${app.baseUrl}/api/product-feedback`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        });
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), {
          error: "Feedback service is temporarily unavailable",
          code: "feedback_integration_unavailable",
          upstream_status: 403,
          upstream_error: "trusted reporter identity requires feedback:write permission for this app",
        });
      } finally {
        await app.close();
      }
    })
  ), {
    status: 403,
    body: {
      error: "trusted reporter identity requires feedback:write permission for this app",
      secret: "must not be projected",
    },
  });
});

test("product feedback exposes only fixed duration-only upstream timing metrics", async () => {
  await withHandsFeedbackUpstream(async (baseUrl) => (
    withFeedbackEnv(baseUrl, async () => {
      const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
      try {
        const user = await seedUser();
        const token = signAccessToken(user.id);
        const form = new FormData();
        form.set("type", "idea");
        form.set("message", "Measure the trusted feedback path.");
        form.set("submission_id", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
        form.set("may_contact", "false");
        const response = await fetch(`${app.baseUrl}/api/product-feedback`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        });
        assert.equal(response.status, 201);
        const timing = response.headers.get("server-timing");
        assert.match(
          timing ?? "",
          /^raft_feedback_hands;dur=\d+\.\d, hands_auth;dur=10\.0, hands_preflight;dur=20\.0, hands_commit;dur=30\.0, hands_postcommit;dur=40\.0$/,
        );
        assert.doesNotMatch(timing ?? "", /ticket_id|description|secret/i);
      } finally {
        await app.close();
      }
    })
  ), {
    status: 201,
    body: { id: "ticket-timing", status: "open", attachments: 0 },
    serverTiming: [
      "hands_auth;dur=10.0",
      "hands_preflight;dur=20.0",
      "hands_commit;dur=30.0",
      "hands_postcommit;dur=40.0",
      "ticket_id;dur=1",
      "hands_list;desc=secret;dur=2",
    ].join(", "),
  });
});

test("real product-feedback list entry mints once and reuses a server-only reporter session", async () => {
  await withHandsFeedbackUpstream(async (baseUrl, requests) => (
    withFeedbackEnv(baseUrl, async () => {
      process.env.HANDS_FEEDBACK_CONVERSATION_SESSION_ENABLED = "true";
      process.env.HANDS_FEEDBACK_REPORTER_INTEGRATION_ID = TEST_REPORTER_INTEGRATION_ID;
      resetProductFeedbackReporterSessionCacheForTest();
      const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
      try {
        const user = await seedUser();
        const token = signAccessToken(user.id);
        for (let index = 0; index < 2; index += 1) {
          const response = await fetch(`${app.baseUrl}/api/product-feedback/tickets`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          assert.equal(response.status, 200);
          assert.deepEqual(await response.json(), {
            tickets: [], next_cursor: null, unread_total: 0,
          });
          assert.match(response.headers.get("server-timing") ?? "", /hands_session_verify;dur=1\.0/);
        }
        const mintRequests = requests.filter((request) => request.url.endsWith("/reporter-feedback/session"));
        const listRequests = requests.filter((request) => request.url.includes("/reporter-feedback?"));
        assert.equal(mintRequests.length, 1, "two real API calls share one in-memory mint");
        assert.equal(listRequests.length, 2);
        assert.equal(mintRequests[0]?.headers.authorization, "Bearer hands_conversation_test");
        assert.equal(listRequests[0]?.headers.authorization, "Bearer hrps_v1_api-test-session");
        assert.equal(listRequests[1]?.headers.authorization, "Bearer hrps_v1_api-test-session");
      } finally {
        await app.close();
      }
    })
  ));
});

async function withFeedbackEnv<T>(baseUrl: string, run: () => Promise<T>): Promise<T> {
  const keys = [
    "HANDS_FEEDBACK_BASE_URL",
    "HANDS_FEEDBACK_APP_SLUG",
    "HANDS_FEEDBACK_CLIENT_KEY",
    "HANDS_FEEDBACK_APP_TOKEN",
    "HANDS_FEEDBACK_REPORTER_ID_SECRET",
    "HANDS_FEEDBACK_APP_ID",
    "HANDS_FEEDBACK_CONVERSATION_APP_TOKEN",
    "HANDS_FEEDBACK_CONVERSATION_CREDENTIAL_REVISION",
    "HANDS_FEEDBACK_CONVERSATION_SESSION_ENABLED",
    "HANDS_FEEDBACK_CURSOR_SECRET",
    "HANDS_FEEDBACK_REPORTER_INTEGRATION_ID",
    "HANDS_FEEDBACK_ROUTE_SUBJECT_KEY_ID",
    "HANDS_FEEDBACK_ROUTE_SUBJECT_ROOT",
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.HANDS_FEEDBACK_BASE_URL = baseUrl;
  process.env.HANDS_FEEDBACK_APP_SLUG = "raft-web";
  process.env.HANDS_FEEDBACK_CLIENT_KEY = "qk_test";
  process.env.HANDS_FEEDBACK_APP_TOKEN = "hands_app_test";
  process.env.HANDS_FEEDBACK_REPORTER_ID_SECRET = "reporter-id-secret";
  process.env.HANDS_FEEDBACK_APP_ID = "11111111-1111-4111-8111-111111111111";
  process.env.HANDS_FEEDBACK_CONVERSATION_APP_TOKEN = "hands_conversation_test";
  process.env.HANDS_FEEDBACK_CONVERSATION_CREDENTIAL_REVISION = "test-revision";
  process.env.HANDS_FEEDBACK_CURSOR_SECRET = "test-cursor-secret";
  process.env.HANDS_FEEDBACK_REPORTER_INTEGRATION_ID = "legacy-feedback:11111111-1111-4111-8111-111111111111";
  process.env.HANDS_FEEDBACK_ROUTE_SUBJECT_KEY_ID = "v1";
  process.env.HANDS_FEEDBACK_ROUTE_SUBJECT_ROOT = Buffer.alloc(32, 1).toString("base64url");
  resetProductFeedbackRouteBindingCacheForTest();
  resetProductFeedbackReporterSessionCacheForTest();
  try {
    return await run();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetProductFeedbackRouteBindingCacheForTest();
    resetProductFeedbackReporterSessionCacheForTest();
  }
}

test("product feedback requires authenticated verified user", async ({ app }) => {
  const response = await fetch(`${app.baseUrl}/api/product-feedback`, {
    method: "POST",
    body: new FormData(),
  });
  assert.equal(response.status, 401);
});

test("Raft no longer exposes a feedback webhook that persists a local projection", async ({ app }) => {
  const response = await fetch(`${app.baseUrl}/api/internal/hands-feedback/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 404);
});

test("product feedback validates a fixed draft UUID and fails closed without Hands config", async () => {
  const previousKey = process.env.HANDS_FEEDBACK_CLIENT_KEY;
  delete process.env.HANDS_FEEDBACK_CLIENT_KEY;
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const user = await seedUser();
    const token = signAccessToken(user.id);
    const invalid = new FormData();
    invalid.set("type", "idea");
    invalid.set("message", "Please add a compact command palette.");
    invalid.set("submission_id", "not-a-uuid");
    const invalidResponse = await fetch(`${app.baseUrl}/api/product-feedback`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: invalid,
    });
    assert.equal(invalidResponse.status, 400);
    assert.equal((await invalidResponse.json() as { code: string }).code, "feedback_invalid");

    const valid = new FormData();
    valid.set("type", "idea");
    valid.set("message", "Please add a compact command palette.");
    valid.set("submission_id", "55555555-5555-4555-8555-555555555555");
    valid.set("may_contact", "false");
    const unconfiguredResponse = await fetch(`${app.baseUrl}/api/product-feedback`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: valid,
    });
    assert.equal(unconfiguredResponse.status, 503);
    assert.equal((await unconfiguredResponse.json() as { code: string }).code, "feedback_not_configured");
  } finally {
    if (previousKey === undefined) delete process.env.HANDS_FEEDBACK_CLIENT_KEY;
    else process.env.HANDS_FEEDBACK_CLIENT_KEY = previousKey;
    await app.close();
  }
});

test("product feedback rejects spoofed native attribution before Hands config or traffic", async () => {
  const previousBaseUrl = process.env.HANDS_FEEDBACK_BASE_URL;
  delete process.env.HANDS_FEEDBACK_BASE_URL;
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const user = await seedUser();
    const token = signAccessToken(user.id);
    const form = new FormData();
    form.set("type", "problem");
    form.set("message", "Native attribution should fail closed when spoofed.");
    form.set("submission_id", "66666666-6666-4666-8666-666666666666");
    form.set("may_contact", "false");
    form.set("metadata", JSON.stringify({
      client_kind: "ios",
      platform: "web",
      client_version: "1.0.0",
      browser: "SpoofBrowser",
    }));
    const response = await fetch(`${app.baseUrl}/api/product-feedback`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { code: string }).code, "feedback_invalid");
  } finally {
    if (previousBaseUrl === undefined) delete process.env.HANDS_FEEDBACK_BASE_URL;
    else process.env.HANDS_FEEDBACK_BASE_URL = previousBaseUrl;
    await app.close();
  }
});

test("product feedback accepts native attribution only from a matching trusted client kind", async () => {
  const previousBaseUrl = process.env.HANDS_FEEDBACK_BASE_URL;
  delete process.env.HANDS_FEEDBACK_BASE_URL;
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const user = await seedUser();
    const token = signAccessToken(user.id);
    const form = new FormData();
    form.set("type", "problem");
    form.set("message", "Native attribution should reach the config gate when trusted.");
    form.set("submission_id", "77777777-7777-4777-8777-777777777777");
    form.set("may_contact", "false");
    form.set("metadata", JSON.stringify({
      client_kind: "ios",
      platform: "ios",
      client_version: "1.0.0",
    }));
    const response = await fetch(`${app.baseUrl}/api/product-feedback`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Raft-Client-Kind": "ios",
      },
      body: form,
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json() as { code: string }).code, "feedback_not_configured");
  } finally {
    if (previousBaseUrl === undefined) delete process.env.HANDS_FEEDBACK_BASE_URL;
    else process.env.HANDS_FEEDBACK_BASE_URL = previousBaseUrl;
    await app.close();
  }
});

for (const clientKind of ["ios", "android"] as const) {
  test(`product feedback forwards configured ${clientKind} attribution to Hands metadata`, async () => {
    await withHandsFeedbackUpstream(async (baseUrl, requests) => (
      withFeedbackEnv(baseUrl, async () => {
        const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
        try {
          const user = await seedUser();
          const token = signAccessToken(user.id);
          const form = new FormData();
          form.set("type", "problem");
          form.set("message", `Native ${clientKind} feedback should reach Hands.`);
          form.set("submission_id", clientKind === "ios"
            ? "88888888-8888-4888-8888-888888888888"
            : "99999999-9999-4999-8999-999999999999");
          form.set("may_contact", "false");
          form.set("metadata", JSON.stringify({
            client_kind: clientKind,
            platform: clientKind,
            client_version: clientKind === "ios" ? "1.2.3" : "2026.7.26",
            locale: "en-US",
            os_version: clientKind === "ios" ? "iOS 18.5" : "Android 15",
          }));
          const response = await fetch(`${app.baseUrl}/api/product-feedback`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "X-Raft-Client-Kind": clientKind,
            },
            body: form,
          });
          assert.equal(response.status, 201);
          assert.equal((await response.json() as { id: string }).id, "ticket-native");

          const feedbackRequest = requests.find((request) => (
            request.method === "POST" && request.url === "/public/v2/apps/raft-web/feedback"
          ));
          assert.ok(feedbackRequest, "feedback POST should reach Hands");
          const metadata = JSON.parse(multipartField(
            feedbackRequest.body,
            feedbackRequest.headers["content-type"],
            "metadata",
          )) as Record<string, unknown>;
          assert.equal(metadata.client_kind, clientKind);
          assert.equal(metadata.platform, clientKind);
          assert.equal(metadata.client_version, clientKind === "ios" ? "1.2.3" : "2026.7.26");
          assert.equal(metadata.product_type, clientKind);
          assert.equal(metadata.feedback_type, "problem");
          assert.equal(metadata.contact_consent, false);
          assert.equal(metadata.locale, "en-US");
          assert.equal(metadata.os_version, clientKind === "ios" ? "iOS 18.5" : "Android 15");
          assert.equal("web_version" in metadata, false);
          assert.equal("browser" in metadata, false);
          assert.equal("viewport" in metadata, false);
          assert.equal("userId" in metadata, false);
          assert.equal("reporterId" in metadata, false);
          assert.equal("baseUrl" in metadata, false);
          assert.equal("appToken" in metadata, false);
        } finally {
          await app.close();
        }
      })
    ));
  });
}

test("contact formatting is server-derived and explicit", () => {
  assert.equal(buildProductFeedbackContact({
    email: "avery@example.com",
    name: "avery",
    displayName: "Avery Chen",
  }), "Avery Chen (@avery) <avery@example.com>");
});

test("reporter reply rejects non-image multipart attachments before Hands traffic", async ({ app }) => {
  const user = await seedUser();
  const token = signAccessToken(user.id);
  const form = new FormData();
  form.set("body", "Here is the requested reproduction.");
  form.set("submission_id", "55555555-5555-4555-8555-555555555555");
  form.append("attachments", new File(["private"], "notes.txt", { type: "text/plain" }));
  const response = await fetch(
    `${app.baseUrl}/api/product-feedback/tickets/33333333-3333-4333-8333-333333333333/comments`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    },
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json() as { code: string }).code, "feedback_attachment_type_invalid");
});

test("reporter can close only a canonical ticket through the authenticated API", async () => {
  await withHandsFeedbackUpstream(async (baseUrl, requests) => (
    withFeedbackEnv(baseUrl, async () => {
      const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
      try {
        const user = await seedUser();
        const token = signAccessToken(user.id);
        const ticketId = "33333333-3333-4333-8333-333333333333";
        const response = await fetch(
          `${app.baseUrl}/api/product-feedback/tickets/${ticketId}/close`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ reason: "completed" }),
          },
        );
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
          id: ticketId,
          status: "closed",
          closure_reason: "completed",
          duplicate_of_ticket_id: null,
          updated_at: 1_700_000_000_030,
          changed: true,
        });
        const close = requests.find((request) => request.url.endsWith(`/${ticketId}/close`));
        assert.ok(close);
        assert.equal(close.method, "POST");
        assert.deepEqual(JSON.parse(close.body), { reason: "completed" });
        assert.match(String(close.headers["x-hands-reporter-id"] ?? ""), /^[A-Za-z0-9_-]{16,200}$/);

        const invalid = await fetch(
          `${app.baseUrl}/api/product-feedback/tickets/not-a-uuid/close`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ reason: "completed" }),
          },
        );
        assert.equal(invalid.status, 404);
        assert.equal((await invalid.json() as { code: string }).code, "feedback_not_found");
        assert.equal(
          requests.filter((request) => request.url.endsWith("/not-a-uuid/close")).length,
          0,
        );
      } finally {
        await app.close();
      }
    })
  ));
});

test("close entry logs only the sanitized upstream failure stage", async () => {
  await withHandsFeedbackUpstream(async (baseUrl) => (
    withFeedbackEnv(baseUrl, async () => {
      resetProductFeedbackBreakersForTest();
      const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
      const originalConsoleError = console.error;
      const errors: unknown[][] = [];
      console.error = (...args: unknown[]) => { errors.push(args); };
      try {
        const user = await seedUser();
        const token = signAccessToken(user.id);
        const ticketId = "33333333-3333-4333-8333-333333333333";
        const response = await fetch(
          `${app.baseUrl}/api/product-feedback/tickets/${ticketId}/close`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ reason: "completed" }),
          },
        );
        assert.equal(response.status, 503);
        assert.equal(
          (await response.json() as { code: string }).code,
          "feedback_service_unavailable",
        );
        const diagnostic = errors.find((entry) => (
          entry[0] === "[ProductFeedback] Conversation failure"
        ));
        assert.deepEqual(diagnostic, [
          "[ProductFeedback] Conversation failure",
          {
            operation: "close",
            code: "feedback_service_unavailable",
            failure_stage: "upstream_response",
            upstream_status: 502,
            breaker_failures: 1,
            breaker_open: false,
          },
        ]);
        const serialized = JSON.stringify(diagnostic);
        assert.doesNotMatch(serialized, new RegExp(ticketId));
        assert.doesNotMatch(serialized, /reporter|token|body/i);
      } finally {
        console.error = originalConsoleError;
        await app.close();
      }
    })
  ), undefined, {
    status: 502,
    body: { error: "private upstream body must not be logged" },
  });
});
