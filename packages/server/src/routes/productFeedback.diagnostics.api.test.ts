import { accessTokenForTest, fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import { getDb } from "../db/index";
import { users } from "../db/schema";
import { resetProductFeedbackRouteBindingCacheForTest } from "../services/productFeedbackRouteBindingService";
import {
  resetProductFeedbackBreakersForTest,
  resetProductFeedbackReporterSessionCacheForTest,
} from "../services/productFeedbackConversationService";
import { setProductFeedbackAppsForTest } from "../services/productFeedbackApps";
import { setMobileFeedbackAppsForTest } from "../test/handsFeedbackStub";

// Mobile diagnostics: the host uploads the zip through Hands' presign endpoint
// and the web page submits only the reference; the server forwards it in the
// create request's `presigned` field (spec v3, #raft-mobile-reconcile:6f867e95).

const test = createApiTest();

const APP_ID = "11111111-1111-4111-8111-111111111111";
const R2_KEY = `feedback/${APP_ID}/presigned/0f0e0d0c-0b0a-4908-8706-050403020100-diagnostics.zip`;
const DIAGNOSTICS = { r2_key: R2_KEY, filename: "diagnostics.zip", content_type: "application/zip", size: 4_096 };

type Captured = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };
type HandsCreateResponse = { status: number; body: Record<string, unknown> };

async function withUpstream<T>(
  createResponse: HandsCreateResponse,
  run: (baseUrl: string, requests: Captured[]) => Promise<T>,
): Promise<T> {
  const requests: Captured[] = [];
  const server = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
    res.setHeader("Content-Type", "application/json");
    if (req.method === "PUT" && req.url?.includes("/reporter-feedback/route-subject")) {
      res.writeHead(201);
      res.end(JSON.stringify({ changed: true, subject_version: "v1" }));
      return;
    }
    if (req.method === "POST" && /^\/public\/v2\/apps\/[^/]+\/feedback$/.test(req.url ?? "")) {
      res.writeHead(createResponse.status);
      res.end(JSON.stringify(createResponse.body));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: "unexpected request" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`, requests);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

const ENV_KEYS = [
  "HANDS_FEEDBACK_BASE_URL", "HANDS_FEEDBACK_APP_SLUG", "HANDS_FEEDBACK_CLIENT_KEY", "HANDS_FEEDBACK_APP_TOKEN",
  "HANDS_FEEDBACK_REPORTER_ID_SECRET", "HANDS_FEEDBACK_APP_ID", "HANDS_FEEDBACK_CONVERSATION_APP_TOKEN",
  "HANDS_FEEDBACK_CONVERSATION_CREDENTIAL_REVISION", "HANDS_FEEDBACK_CURSOR_SECRET",
  "HANDS_FEEDBACK_REPORTER_INTEGRATION_ID", "HANDS_FEEDBACK_ROUTE_SUBJECT_KEY_ID", "HANDS_FEEDBACK_ROUTE_SUBJECT_ROOT",
] as const;

async function withEnv<T>(baseUrl: string, run: () => Promise<T>): Promise<T> {
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    HANDS_FEEDBACK_BASE_URL: baseUrl,
    HANDS_FEEDBACK_APP_SLUG: "raft-feedback",
    HANDS_FEEDBACK_CLIENT_KEY: "qk_test",
    HANDS_FEEDBACK_APP_TOKEN: "app_token",
    HANDS_FEEDBACK_REPORTER_ID_SECRET: "reporter-secret",
    HANDS_FEEDBACK_APP_ID: APP_ID,
    HANDS_FEEDBACK_CONVERSATION_APP_TOKEN: "conversation_token",
    HANDS_FEEDBACK_CONVERSATION_CREDENTIAL_REVISION: "revision",
    HANDS_FEEDBACK_CURSOR_SECRET: "cursor-secret",
    HANDS_FEEDBACK_REPORTER_INTEGRATION_ID: `legacy-feedback:${APP_ID}`,
    HANDS_FEEDBACK_ROUTE_SUBJECT_KEY_ID: "v1",
    HANDS_FEEDBACK_ROUTE_SUBJECT_ROOT: Buffer.alloc(32, 1).toString("base64url"),
  });
  setMobileFeedbackAppsForTest();
  resetProductFeedbackRouteBindingCacheForTest();
  resetProductFeedbackReporterSessionCacheForTest();
  resetProductFeedbackBreakersForTest();
  try {
    return await run();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    setProductFeedbackAppsForTest(null);
    resetProductFeedbackRouteBindingCacheForTest();
    resetProductFeedbackReporterSessionCacheForTest();
    resetProductFeedbackBreakersForTest();
  }
}

// Submissions are rate-limited per user (10/hour), so every submission below
// comes from its own user.
let seededUsers = 0;
async function seedToken(): Promise<string> {
  seededUsers += 1;
  const [user] = await getDb().insert(users).values({
    email: `diagnostics-feedback-${seededUsers}@slock.test`,
    name: `diagnostics-feedback-${seededUsers}`,
    displayName: "Diagnostics Feedback",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return accessTokenForTest(user!.id);
}

function submitForm(clientKind: string, diagnostics?: string): FormData {
  const form = new FormData();
  form.set("type", "problem");
  form.set("message", `feedback from ${clientKind}`);
  form.set("submission_id", "77777777-7777-4777-8777-777777777777");
  form.set("may_contact", "false");
  form.set("metadata", JSON.stringify({ client_kind: clientKind, platform: clientKind, client_version: "1.0.0" }));
  if (diagnostics !== undefined) form.set("diagnostics", diagnostics);
  return form;
}

function multipartField(body: string, contentType: string | undefined, name: string): string | undefined {
  const boundary = contentType?.match(/boundary=(?:"([^"]+)"|([^;]+))/);
  assert.ok(boundary, "multipart boundary should be present");
  const part = body.split(`--${boundary[1] ?? boundary[2]}`).find((candidate) => candidate.includes(`name="${name}"`));
  if (!part) return undefined;
  const [, value = ""] = part.split(/\r?\n\r?\n/);
  return value.replace(/\r?\n--$/, "").trimEnd();
}

async function submit(baseUrl: string, clientKind: string, diagnostics?: string) {
  const token = await seedToken();
  const response = await fetch(`${baseUrl}/api/product-feedback`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "X-Raft-Client-Kind": clientKind },
    body: submitForm(clientKind, diagnostics),
  });
  return { status: response.status, body: await response.json() as { code?: string; id?: string } };
}

const CREATED: HandsCreateResponse = { status: 201, body: { id: "ticket-1", status: "open", attachments: 1 } };

test("each mobile source forwards the diagnostics reference to Hands as `presigned`", async ({ app }) => {
  await withUpstream(CREATED, async (baseUrl, requests) => withEnv(baseUrl, async () => {
    for (const clientKind of ["android", "ios", "ohos"]) {
      const before = requests.length;
      const result = await submit(app.baseUrl, clientKind, JSON.stringify(DIAGNOSTICS));
      assert.equal(result.status, 201, `${clientKind}: ${JSON.stringify(result.body)}`);
      const create = requests.slice(before).find((request) => request.method === "POST" && request.url.endsWith("/feedback"));
      assert.ok(create, `${clientKind}: Hands create request`);
      const presigned = multipartField(create.body, create.headers["content-type"], "presigned");
      assert.deepEqual(JSON.parse(presigned ?? "null"), [DIAGNOSTICS]);
    }
  }));
});

test("a submission without diagnostics sends no `presigned` field", async ({ app }) => {
  await withUpstream(CREATED, async (baseUrl, requests) => withEnv(baseUrl, async () => {
    const result = await submit(app.baseUrl, "android");
    assert.equal(result.status, 201);
    const create = requests.find((request) => request.method === "POST" && request.url.endsWith("/feedback"));
    assert.ok(create);
    assert.equal(multipartField(create.body, create.headers["content-type"], "presigned"), undefined);
  }));
});

test("web and malformed diagnostics are rejected before any Hands traffic", async ({ app }) => {
  await withUpstream(CREATED, async (baseUrl, requests) => withEnv(baseUrl, async () => {
    const cases: Array<[string, string]> = [
      ["web", JSON.stringify(DIAGNOSTICS)],
      ["android", "not json"],
      ["android", JSON.stringify([DIAGNOSTICS])],
      ["android", JSON.stringify({ ...DIAGNOSTICS, content_type: "image/png" })],
      ["android", JSON.stringify({ ...DIAGNOSTICS, filename: "diagnostics.tar" })],
      ["android", JSON.stringify({ ...DIAGNOSTICS, filename: "../diagnostics.zip" })],
      ["android", JSON.stringify({ ...DIAGNOSTICS, size: 0 })],
      ["android", JSON.stringify({ ...DIAGNOSTICS, size: 200 * 1024 * 1024 + 1 })],
      ["android", JSON.stringify({ ...DIAGNOSTICS, size: "4096" })],
      ["android", JSON.stringify({ ...DIAGNOSTICS, r2_key: `feedback/${APP_ID}/inline/0f0e0d0c-0b0a-4908-8706-050403020100-d.zip` })],
      ["android", JSON.stringify({ ...DIAGNOSTICS, r2_key: `feedback/${APP_ID}/presigned/not-a-uuid-d.zip` })],
      ["android", JSON.stringify({ ...DIAGNOSTICS, r2_key: `feedback/${APP_ID}/presigned/0f0e0d0c-0b0a-4908-8706-050403020100-a/b.zip` })],
      ["android", JSON.stringify({ ...DIAGNOSTICS, upload_url: "https://r2.example/put" })],
    ];
    for (const [clientKind, diagnostics] of cases) {
      const result = await submit(app.baseUrl, clientKind, diagnostics);
      assert.equal(result.status, 400, `${clientKind} ${diagnostics}`);
      assert.equal(result.body.code, "feedback_diagnostics_invalid", `${clientKind} ${diagnostics}`);
    }
    assert.equal(requests.length, 0, "invalid diagnostics never reach Hands");
  }));
});

test("a Hands presigned_* code maps to feedback_diagnostics_rejected", async ({ app }) => {
  for (const code of ["presigned_invalid", "presigned_not_found", "presigned_size_mismatch"]) {
    await withUpstream({ status: 400, body: { error: "anything", code } }, async (baseUrl) => withEnv(baseUrl, async () => {
      const result = await submit(app.baseUrl, "android", JSON.stringify(DIAGNOSTICS));
      assert.equal(result.status, 400, code);
      assert.equal(result.body.code, "feedback_diagnostics_rejected", code);
    }));
  }
});

test("everything else from Hands stays an ordinary failure", async ({ app }) => {
  const ordinary: Array<[HandsCreateResponse, string | undefined, number, string]> = [
    // Hands no longer guarantees anything for a text without a code.
    [{ status: 400, body: { error: "invalid presigned r2_key" } }, JSON.stringify(DIAGNOSTICS), 400, "feedback_invalid"],
    [{ status: 400, body: { error: `presigned upload not found: ${R2_KEY}` } }, JSON.stringify(DIAGNOSTICS), 400, "feedback_invalid"],
    // Unknown, differently cased, padded or non-string codes.
    [{ status: 400, body: { error: "x", code: "attachments_limit_exceeded" } }, JSON.stringify(DIAGNOSTICS), 400, "feedback_invalid"],
    [{ status: 400, body: { error: "x", code: "PRESIGNED_INVALID" } }, JSON.stringify(DIAGNOSTICS), 400, "feedback_invalid"],
    [{ status: 400, body: { error: "x", code: "presigned_invalid " } }, JSON.stringify(DIAGNOSTICS), 400, "feedback_invalid"],
    [{ status: 400, body: { error: "x", code: 400 } }, JSON.stringify(DIAGNOSTICS), 400, "feedback_invalid"],
    // A presigned code on a request without diagnostics, or on a non-400.
    [{ status: 400, body: { error: "x", code: "presigned_invalid" } }, undefined, 400, "feedback_invalid"],
    [{ status: 422, body: { error: "x", code: "presigned_invalid" } }, JSON.stringify(DIAGNOSTICS), 503, "feedback_service_unavailable"],
    // The submission_id already has a ticket: Hands answers 409 (Hands #684).
    [{ status: 409, body: { error: "submission_id already used with a different payload" } }, JSON.stringify(DIAGNOSTICS), 409, "feedback_submission_conflict"],
  ];
  for (const [response, diagnostics, status, code] of ordinary) {
    await withUpstream(response, async (baseUrl) => withEnv(baseUrl, async () => {
      const result = await submit(app.baseUrl, "android", diagnostics);
      assert.equal(result.status, status, JSON.stringify(response));
      assert.equal(result.body.code, code, JSON.stringify(response));
    }));
  }
});
