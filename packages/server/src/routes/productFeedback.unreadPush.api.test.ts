// A ticket read through Raft pushes the reader's new unread total of the app
// the ticket lives in to their own connections, from the total the Hands
// detail answer already carries (no extra Hands call): the web app's on
// product_feedback:unread, a mobile app's on product_feedback:app_unread with
// its source, never on the web event. The value a client starts from is its
// own app's unread_total in the list.
import { accessTokenForTest, fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import { PRODUCT_FEEDBACK_APP_UNREAD_EVENT, PRODUCT_FEEDBACK_UNREAD_EVENT } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { users } from "../db/schema";
import { resetProductFeedbackRouteBindingCacheForTest } from "../services/productFeedbackRouteBindingService";
import {
  resetProductFeedbackBreakersForTest,
  resetProductFeedbackReporterSessionCacheForTest,
} from "../services/productFeedbackConversationService";
import { CachedProductFeedbackApps, setProductFeedbackAppsForTest } from "../services/productFeedbackApps";
import { setProductFeedbackUnreadRealtimeIO } from "../services/productFeedbackUnreadRealtime";
import { handsFeedbackEnv } from "../test/handsFeedbackStub";
import { openTestApp } from "../test/integration/app";

const test = createApiTest();
const TICKET_ID = "33333333-3333-4333-8333-333333333333";
const ANDROID_APP_ID = "5d2c7a90-91e4-4b7b-8a35-6c0e4f9b2d22";
const IOS_APP_ID = "0b6f1c1e-3a52-4d0c-9f6e-2a8a7f1d4c11";

function detail(unreadTotal: number) {
  return {
    ticket: {
      id: TICKET_ID, kind: "feedback", status: "open", closure_reason: null, duplicate_of_ticket_id: null,
      message: "ticket text", version_name: null, channel: null, created_at: 1_700_000_000_000, updated_at: 1_700_000_000_001,
      attachment_count: 0, comment_count: 1, latest_comment_at: 1_700_000_000_001, unread: false, unread_count: 0,
    },
    comments: [{ id: "44444444-4444-4444-8444-444444444444", author_type: "staff", body: "staff reply", created_at: 1_700_000_000_001 }],
    next_comment_cursor: null,
    attachments: [],
    unread_total: unreadTotal,
  };
}

test("a ticket read pushes the new unread total of the ticket's app to the reader's own connections only: the web app's on product_feedback:unread, a mobile app's on product_feedback:app_unread; a failed read pushes nothing", async () => {
  const requests: string[] = [];
  let detailStatus = 200;
  // Each app answers its own totals, as Hands does: the reporter's unread
  // total after a read (the detail) and on the list.
  const totals = (appId: string) => appId === ANDROID_APP_ID ? { afterRead: 5, list: 7 }
    : appId === IOS_APP_ID ? { afterRead: 1, list: 4 }
      : { afterRead: 3, list: 2 };
  const hands = createHttpServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    requests.push(`${req.method} ${req.url}`);
    res.setHeader("Content-Type", "application/json");
    const appId = req.url?.match(/^\/api\/apps\/([^/]+)\//)?.[1] ?? "";
    if (req.method === "PUT" && req.url?.includes("/reporter-feedback/route-subject")) {
      res.writeHead(201);
      res.end(JSON.stringify({ changed: true, subject_version: "v1" }));
      return;
    }
    if (req.method === "GET" && req.url?.includes(`/reporter-feedback/${TICKET_ID}?`)) {
      res.writeHead(detailStatus);
      res.end(JSON.stringify(detailStatus === 200 ? detail(totals(appId).afterRead) : { error: "no" }));
      return;
    }
    if (req.method === "GET" && req.url?.includes("/reporter-feedback?")) {
      res.writeHead(200);
      res.end(JSON.stringify({ tickets: [], next_cursor: null, unread_total: totals(appId).list }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: "unexpected request" }));
  });
  await new Promise<void>((resolve) => hands.listen(0, "127.0.0.1", resolve));
  const { port } = hands.address() as AddressInfo;
  const env = handsFeedbackEnv(`http://127.0.0.1:${port}`);
  const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  // Each mobile source on its own app, with the shared secrets (never the legacy ones).
  const mobileApp = (source: string, appId: string, reporterIntegrationId: string) => ({
    app_slug: `raft-feedback-${source}`, app_id: appId, reporter_integration_id: reporterIntegrationId,
    credential_revision: "1", client_key: `qk_${source}`, token: `${source}_token`,
  });
  setProductFeedbackAppsForTest(new CachedProductFeedbackApps(
    async () => JSON.stringify({
      shared: {
        reporter_id_secret: "multi-reporter-secret",
        route_subject_root: Buffer.alloc(32, 9).toString("base64url"),
        cursor_secret: "multi-cursor-secret",
      },
      android: mobileApp("android", ANDROID_APP_ID, "3c1f6a2e-8d47-4e19-b0a3-7f5d2c9e6b33"),
      ios: mobileApp("ios", IOS_APP_ID, "9414a84b-7b41-44a2-96b5-b3617ec057cc"),
    }),
    { HANDS_FEEDBACK_APPS_SSM_PARAMETER: "/slock/staging/HANDS_FEEDBACK_APPS" },
  ));
  resetProductFeedbackRouteBindingCacheForTest();
  resetProductFeedbackReporterSessionCacheForTest();
  resetProductFeedbackBreakersForTest();
  const frames: Array<{ room: string; event: string; payload: unknown }> = [];
  setProductFeedbackUnreadRealtimeIO({
    to: (room: string) => ({ emit: (event: string, payload: unknown) => { frames.push({ room, event, payload }); return true; } }),
  } as never);
  const app = await openTestApp("pglite://", 0);
  try {
    const [user] = await getDb().insert(users).values({
      email: "feedback-unread-push@slock.test", name: "feedback-unread-push", displayName: "Feedback Reader",
      passwordHash: await fixturePasswordHash("password123"), emailVerified: true, profileSetupCompletedAt: new Date(),
    }).returning();
    const token = await accessTokenForTest(user!.id);
    const get = (path: string, headers: Record<string, string> = {}) => fetch(`${app.baseUrl}/api/product-feedback/tickets${path}`, {
      headers: { Authorization: `Bearer ${token}`, ...headers },
    });
    const read = (headers: Record<string, string> = {}, query = "") => get(`/${TICKET_ID}${query}`, headers);
    /** The Hands calls since the last look, without the route-binding PUTs and the query. */
    const handsCalls = () => requests.splice(0).filter((line) => !line.startsWith("PUT ")).map((line) => line.split("?")[0]);
    const webFrame = (unreadTotal: number) => ({ room: `user:${user!.id}`, event: PRODUCT_FEEDBACK_UNREAD_EVENT, payload: { userId: user!.id, unreadTotal } });
    const appFrame = (source: string, unreadTotal: number) => ({ room: `user:${user!.id}`, event: PRODUCT_FEEDBACK_APP_UNREAD_EVENT, payload: { source, unreadTotal } });

    // A web read: unchanged.
    const response = await read();
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { unread_total: number }).unread_total, 3);
    assert.deepEqual(frames, [webFrame(3)]);
    assert.ok(requests.every((line) => !line.includes("mark_read")), "a person's read marks the ticket read, as before");
    assert.deepEqual(handsCalls(), [`GET /api/apps/${env.HANDS_FEEDBACK_APP_ID}/reporter-feedback/${TICKET_ID}`], "the push adds no Hands call");

    // A read from the Android App: that app's total, on the app event with its source; nothing on the web event.
    frames.length = 0;
    const android = await read({ "X-Raft-Client-Kind": "android" });
    assert.equal(android.status, 200);
    assert.equal((await android.json() as { unread_total: number }).unread_total, 5);
    assert.deepEqual(frames, [appFrame("android", 5)], "a mobile app's total is not the web dot's");
    assert.deepEqual(handsCalls(), [`GET /api/apps/${ANDROID_APP_ID}/reporter-feedback/${TICKET_ID}`], "the push adds no Hands call");

    // The web opening an App's ticket by its link (no client kind header): the
    // read moved that app's receipt, so that app's event, and still not the web's.
    frames.length = 0;
    const linked = await read({}, "?platform=android");
    assert.equal(linked.status, 200);
    assert.equal((await linked.json() as { ticket: { id: string } }).ticket.id, TICKET_ID);
    assert.deepEqual(frames, [appFrame("android", 5)], "an App's ticket read from the web pushes that App's total, not the web's");
    assert.deepEqual(handsCalls(), [`GET /api/apps/${ANDROID_APP_ID}/reporter-feedback/${TICKET_ID}`]);

    // `platform` names the ticket's app whatever the client's own kind.
    frames.length = 0;
    assert.equal((await read({ "X-Raft-Client-Kind": "android" }, "?platform=ios")).status, 200);
    assert.deepEqual(frames, [appFrame("ios", 1)]);
    frames.length = 0;
    assert.equal((await read({ "X-Raft-Client-Kind": "android" }, "?platform=web")).status, 200);
    assert.deepEqual(frames, [webFrame(3)]);

    // Where a client's dot starts (on start and reconnect): its own app's total in the list, which pushes nothing.
    frames.length = 0;
    requests.length = 0;
    const androidList = await get("?limit=1", { "X-Raft-Client-Kind": "android" });
    assert.equal(androidList.status, 200);
    assert.equal((await androidList.json() as { unread_total: number }).unread_total, 7);
    assert.equal((await (await get("?limit=1", { "X-Raft-Client-Kind": "ios" })).json() as { unread_total: number }).unread_total, 4);
    assert.equal((await (await get("?limit=1")).json() as { unread_total: number }).unread_total, 2);
    assert.deepEqual(handsCalls(), [ANDROID_APP_ID, IOS_APP_ID, env.HANDS_FEEDBACK_APP_ID].map((appId) => `GET /api/apps/${appId}/reporter-feedback`));
    assert.deepEqual(frames, []);

    // A failed read pushes nothing, on either event.
    detailStatus = 503;
    assert.equal((await read()).status, 503);
    assert.equal((await read({ "X-Raft-Client-Kind": "android" })).status, 503);
    assert.deepEqual(frames, []);
  } finally {
    await app.close();
    setProductFeedbackUnreadRealtimeIO(null);
    setProductFeedbackAppsForTest(null);
    resetProductFeedbackRouteBindingCacheForTest();
    resetProductFeedbackReporterSessionCacheForTest();
    resetProductFeedbackBreakersForTest();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve, reject) => hands.close((error) => error ? reject(error) : resolve()));
  }
});
