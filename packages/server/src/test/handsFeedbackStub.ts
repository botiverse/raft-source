// A Hands stand-in for product feedback sends: it records every request and
// answers the feedback POST, plus the single-app feedback env pointing at it
// (and the mobile sources' apps on that same app).
// Used by the feedback card tests (the dialog's POST /api/product-feedback and
// the card's form, POST /api/actions/:messageId/execute). The env alone, with
// or without Hands feedback configured, is for preparing feedback cards: an
// agent may prepare one only where feedback is configured.
import assert from "node:assert/strict";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import { CachedProductFeedbackApps, setProductFeedbackAppsForTest } from "../services/productFeedbackApps";
import { resetProductFeedbackRouteBindingCacheForTest } from "../services/productFeedbackRouteBindingService";

export const HANDS_TICKET_ID = "33333333-3333-4333-8333-333333333333";
export const FEEDBACK_PATH = "/public/v2/apps/raft-web/feedback";

export type CapturedRequest = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export function multipartField(request: CapturedRequest, name: string): string | undefined {
  const match = request.headers["content-type"]?.match(/boundary=(?:"([^"]+)"|([^;]+))/);
  const boundary = match?.[1] ?? match?.[2];
  assert.ok(boundary, "multipart boundary should be present");
  const part = request.body.split(`--${boundary}`).find((candidate) => candidate.includes(`name="${name}"`));
  if (!part) return undefined;
  const [, value = ""] = part.split(/\r?\n\r?\n/);
  return value.replace(/\r?\n--$/, "").trimEnd();
}

/** The feedback POSTs Hands received (not the route-binding PUTs). */
export const filedTickets = (requests: CapturedRequest[]) =>
  requests.filter((request) => request.method === "POST" && request.url === FEEDBACK_PATH);

export type HandsReply = { status: number; body: Record<string, unknown> };
export const HANDS_TICKET_REPLY: HandsReply = { status: 201, body: { id: HANDS_TICKET_ID, status: "open", reference: "FB-7", attachments: 0 } };

/**
 * Every HANDS_FEEDBACK_* the single-app feedback reads (sending, the
 * reporter's conversations and the route binding), with Hands at `baseUrl`.
 */
export function handsFeedbackEnv(baseUrl: string): Record<string, string> {
  return {
    HANDS_FEEDBACK_BASE_URL: baseUrl,
    HANDS_FEEDBACK_APP_SLUG: "raft-web",
    HANDS_FEEDBACK_CLIENT_KEY: "qk_test",
    HANDS_FEEDBACK_APP_TOKEN: "hands_app_test",
    HANDS_FEEDBACK_REPORTER_ID_SECRET: "reporter-id-secret",
    HANDS_FEEDBACK_APP_ID: "11111111-1111-4111-8111-111111111111",
    HANDS_FEEDBACK_CONVERSATION_APP_TOKEN: "hands_conversation_test",
    HANDS_FEEDBACK_CONVERSATION_CREDENTIAL_REVISION: "test-revision",
    HANDS_FEEDBACK_CURSOR_SECRET: "test-cursor-secret",
    HANDS_FEEDBACK_REPORTER_INTEGRATION_ID: "legacy-feedback:11111111-1111-4111-8111-111111111111",
    HANDS_FEEDBACK_ROUTE_SUBJECT_KEY_ID: "v1",
    HANDS_FEEDBACK_ROUTE_SUBJECT_ROOT: Buffer.alloc(32, 1).toString("base64url"),
  };
}

/**
 * The HANDS_FEEDBACK_APPS JSON with every mobile source on the single app in
 * process.env (read when the JSON is read), so a stub that answers one app
 * serves the mobile sources too, which always route through their own entry.
 */
export function setMobileFeedbackAppsForTest(): void {
  setProductFeedbackAppsForTest(new CachedProductFeedbackApps(async () => {
    const entry = {
      app_slug: process.env.HANDS_FEEDBACK_APP_SLUG,
      app_id: process.env.HANDS_FEEDBACK_APP_ID,
      reporter_integration_id: process.env.HANDS_FEEDBACK_REPORTER_INTEGRATION_ID,
      credential_revision: process.env.HANDS_FEEDBACK_CONVERSATION_CREDENTIAL_REVISION,
      client_key: process.env.HANDS_FEEDBACK_CLIENT_KEY,
      token: process.env.HANDS_FEEDBACK_APP_TOKEN,
    };
    return JSON.stringify({
      shared: {
        reporter_id_secret: process.env.HANDS_FEEDBACK_REPORTER_ID_SECRET,
        route_subject_root: process.env.HANDS_FEEDBACK_ROUTE_SUBJECT_ROOT,
        cursor_secret: process.env.HANDS_FEEDBACK_CURSOR_SECRET,
      },
      ios: entry,
      android: entry,
      ohos: entry,
    });
  }, { HANDS_FEEDBACK_APPS_SSM_PARAMETER: "/slock/staging/HANDS_FEEDBACK_APPS" }, 0, Date.now, 0));
}

/** Run with `env` in process.env (an undefined value unsets the key), then put back what was there. */
async function withProcessEnv<T>(env: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  const apply = (values: Iterable<[string, string | undefined]>) => {
    for (const [key, value] of values) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(Object.entries(env));
  try {
    return await run();
  } finally {
    apply(previous);
  }
}

/**
 * Hands feedback configured, as on production and staging (nothing answers
 * at its URL): where an agent may prepare a `feedback:submit` card.
 */
export function withHandsFeedbackConfigured<T>(run: () => Promise<T>): Promise<T> {
  return withProcessEnv(handsFeedbackEnv("http://127.0.0.1:9"), run);
}

/** No Hands feedback (every HANDS_FEEDBACK_* unset), as on a self-hosted or local deployment. */
export function withoutHandsFeedback<T>(run: () => Promise<T>): Promise<T> {
  return withProcessEnv(Object.fromEntries(Object.keys(handsFeedbackEnv("")).map((key) => [key, undefined])), run);
}

export async function withHands<T>(run: (requests: CapturedRequest[]) => Promise<T>, reply: () => HandsReply | Promise<HandsReply> = () => HANDS_TICKET_REPLY): Promise<T> {
  const requests: CapturedRequest[] = [];
  const hands = createHttpServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
    if (req.method === "PUT" && req.url?.includes("/reporter-feedback/route-subject")) {
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ changed: true, subject_version: "v1" }));
      return;
    }
    if (req.method === "POST" && req.url === FEEDBACK_PATH) {
      const { status, body: replyBody } = await reply();
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(replyBody));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unexpected request" }));
  });
  await new Promise<void>((resolve) => hands.listen(0, "127.0.0.1", resolve));
  const { port } = hands.address() as AddressInfo;
  const env = handsFeedbackEnv(`http://127.0.0.1:${port}`);
  const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  setMobileFeedbackAppsForTest();
  resetProductFeedbackRouteBindingCacheForTest();
  try {
    return await run(requests);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    setProductFeedbackAppsForTest(null);
    resetProductFeedbackRouteBindingCacheForTest();
    await new Promise<void>((resolve, reject) => hands.close((error) => error ? reject(error) : resolve()));
  }
}
