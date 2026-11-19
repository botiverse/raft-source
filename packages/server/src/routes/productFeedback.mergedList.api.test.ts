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
import {
  CachedProductFeedbackApps,
  setProductFeedbackAppsForTest,
} from "../services/productFeedbackApps";

// `GET /api/product-feedback/tickets?sources=all`: one list across the apps a
// person files into (productFeedbackMergedList.ts, #triage:#366). The fake
// Hands keeps a list per app, pages by its own cursor, and can be told to
// fail for one app.

const test = createApiTest();

const LEGACY_APP_ID = "11111111-1111-4111-8111-111111111111";
const ANDROID_APP_ID = "a48a84f8-04ed-4db3-9297-189a14a36afc";
const IOS_APP_ID = "fbfaceca-6d27-47e1-9c20-e56a39535339";

type Captured = { method: string; url: string; headers: IncomingMessage["headers"] };
type HandsTicket = Record<string, unknown>;

// Activity times are offsets from one epoch, so the fixtures read as an order.
const T0 = 1_762_000_000_000;

function handsTicket(n: number, activity: number, extra: HandsTicket = {}): HandsTicket {
  // Hands orders by latest public comment, else creation; these have no comments.
  const updatedAt = T0 + activity + 1_000;
  return {
    id: `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`,
    kind: "feedback",
    status: "open",
    closure_reason: null,
    duplicate_of_ticket_id: null,
    message: `ticket ${n}`,
    version_name: null,
    channel: null,
    created_at: updatedAt - 1_000,
    updated_at: updatedAt,
    attachment_count: 0,
    comment_count: 0,
    latest_comment_at: null,
    unread: false,
    unread_count: 0,
    ...extra,
  };
}

type FakeApp = { tickets: HandsTicket[]; unread: number; pageSize: number; fail?: number; bindFail?: number };

async function withUpstream<T>(
  apps: Record<string, FakeApp>,
  run: (baseUrl: string, requests: Captured[]) => Promise<T>,
): Promise<T> {
  const requests: Captured[] = [];
  const server = createHttpServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    res.setHeader("Content-Type", "application/json");
    if (req.method === "PUT" && req.url?.includes("/reporter-feedback/route-subject")) {
      const app = apps[req.url.split("/")[3]!];
      if (app?.bindFail) {
        res.writeHead(app.bindFail);
        res.end(JSON.stringify({ error: "binding_failed" }));
        return;
      }
      res.writeHead(201);
      res.end(JSON.stringify({ changed: true, subject_version: "v1" }));
      return;
    }
    const detail = req.url?.match(/^\/api\/apps\/([^/]+)\/reporter-feedback\/([0-9a-f-]{36})(?:\?.*)?$/);
    if (req.method === "GET" && detail) {
      const ticket = apps[detail[1]!]?.tickets.find((t) => t.id === detail[2]);
      if (!ticket) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify({ ticket, comments: [], next_comment_cursor: null, attachments: [], unread_total: 0 }));
      return;
    }
    const list = req.url?.match(/^\/api\/apps\/([^/]+)\/reporter-feedback\?(.*)$/);
    if (req.method === "GET" && list) {
      const app = apps[list[1]!];
      if (!app) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      if (app.fail) {
        res.writeHead(app.fail);
        res.end(JSON.stringify({ error: "upstream_failed" }));
        return;
      }
      const params = new URLSearchParams(list[2]);
      const start = params.get("cursor") ? Number(params.get("cursor")!.replace("at-", "")) : 0;
      const size = Math.min(Number(params.get("limit")), app.pageSize);
      const tickets = app.tickets.slice(start, start + size);
      const end = start + tickets.length;
      res.writeHead(200);
      res.end(JSON.stringify({ tickets, next_cursor: end < app.tickets.length ? `at-${end}` : null, unread_total: app.unread }));
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

const LEGACY_KEYS = [
  "HANDS_FEEDBACK_BASE_URL", "HANDS_FEEDBACK_APP_SLUG", "HANDS_FEEDBACK_CLIENT_KEY", "HANDS_FEEDBACK_APP_TOKEN",
  "HANDS_FEEDBACK_REPORTER_ID_SECRET", "HANDS_FEEDBACK_APP_ID", "HANDS_FEEDBACK_CONVERSATION_APP_TOKEN",
  "HANDS_FEEDBACK_CONVERSATION_CREDENTIAL_REVISION", "HANDS_FEEDBACK_CURSOR_SECRET",
  "HANDS_FEEDBACK_REPORTER_INTEGRATION_ID", "HANDS_FEEDBACK_ROUTE_SUBJECT_KEY_ID", "HANDS_FEEDBACK_ROUTE_SUBJECT_ROOT",
  "HANDS_FEEDBACK_APPS_SSM_PARAMETER",
] as const;

async function withEnv<T>(baseUrl: string, run: () => Promise<T>): Promise<T> {
  const previous = new Map(LEGACY_KEYS.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    HANDS_FEEDBACK_BASE_URL: baseUrl,
    HANDS_FEEDBACK_APP_SLUG: "raft-web",
    HANDS_FEEDBACK_CLIENT_KEY: "qk_legacy",
    HANDS_FEEDBACK_APP_TOKEN: "legacy_app_token",
    HANDS_FEEDBACK_REPORTER_ID_SECRET: "legacy-reporter-secret",
    HANDS_FEEDBACK_APP_ID: LEGACY_APP_ID,
    HANDS_FEEDBACK_CONVERSATION_APP_TOKEN: "legacy_conversation_token",
    HANDS_FEEDBACK_CONVERSATION_CREDENTIAL_REVISION: "legacy-revision",
    HANDS_FEEDBACK_CURSOR_SECRET: "legacy-cursor-secret",
    HANDS_FEEDBACK_REPORTER_INTEGRATION_ID: `legacy-feedback:${LEGACY_APP_ID}`,
    HANDS_FEEDBACK_ROUTE_SUBJECT_KEY_ID: "v1",
    HANDS_FEEDBACK_ROUTE_SUBJECT_ROOT: Buffer.alloc(32, 1).toString("base64url"),
    // As deployed: the parameter's name is in the task's env (productFeedbackApps.ts reads it from there).
    HANDS_FEEDBACK_APPS_SSM_PARAMETER: "/slock/staging/HANDS_FEEDBACK_APPS",
  });
  // Android and iOS have apps; ohos has none (not read, not "unavailable").
  setProductFeedbackAppsForTest(appsReader());
  resetProductFeedbackRouteBindingCacheForTest();
  resetProductFeedbackReporterSessionCacheForTest();
  resetProductFeedbackBreakersForTest();
  try {
    return await run();
  } finally {
    for (const key of LEGACY_KEYS) {
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

function appsReader(): CachedProductFeedbackApps {
  return new CachedProductFeedbackApps(
    async () => JSON.stringify({
      shared: {
        reporter_id_secret: "multi-reporter-secret",
        route_subject_root: Buffer.alloc(32, 9).toString("base64url"),
        cursor_secret: "multi-cursor-secret",
      },
      ios: { app_slug: "raft-feedback-ios", app_id: IOS_APP_ID, reporter_integration_id: "9414a84b-7b41-44a2-96b5-b3617ec057cc", credential_revision: "1", client_key: "qk_ios", token: "ios_token" },
      android: { app_slug: "raft-feedback-android", app_id: ANDROID_APP_ID, reporter_integration_id: "a7df6737-1452-4680-a23a-c321277f53f4", credential_revision: "1", client_key: "qk_android", token: "android_token" },
    }),
    { HANDS_FEEDBACK_APPS_SSM_PARAMETER: "/slock/staging/HANDS_FEEDBACK_APPS" },
  );
}

async function seedToken(email = "merged-feedback@slock.test"): Promise<string> {
  const [user] = await getDb().insert(users).values({
    email,
    name: email.split("@")[0]!,
    displayName: "Merged Feedback",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return accessTokenForTest(user!.id);
}

type MergedPage = {
  tickets: Array<{ message: string; source: string; client: string }>;
  next_cursor: string | null;
  unread_total: number | null;
  unread_by_source?: Record<string, number>;
  unavailable_sources?: string[];
  degraded?: boolean;
};

async function listAll(baseUrl: string, token: string, query: Record<string, string> = {}): Promise<{ status: number; body: MergedPage; headers: Headers }> {
  const params = new URLSearchParams({ sources: "all", ...query });
  const response = await fetch(`${baseUrl}/api/product-feedback/tickets?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: await response.json() as MergedPage, headers: response.headers };
}

const THREE_APPS: Record<string, FakeApp> = {
  [LEGACY_APP_ID]: {
    tickets: [handsTicket(1, 900, { client_kind: "web", client_version: "Raft Desktop 1.22.0" }), handsTicket(2, 500, { client_kind: "web", client_version: "1.25.0" }), handsTicket(3, 100)],
    unread: 2, pageSize: 50,
  },
  [ANDROID_APP_ID]: { tickets: [handsTicket(4, 800, { client_kind: "android", client_version: "1.24.0" }), handsTicket(5, 200)], unread: 1, pageSize: 50 },
  [IOS_APP_ID]: { tickets: [handsTicket(6, 700, { client_kind: null, client_version: null })], unread: 0, pageSize: 50 },
};

test("sources=all reads every configured app with its own token, in parallel, and answers one list by latest activity", async ({ app }) => {
  await withUpstream(THREE_APPS, async (baseUrl, requests) => withEnv(baseUrl, async () => {
    const token = await seedToken();
    const { status, body } = await listAll(app.baseUrl, token);
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body.tickets.map((t) => [t.message, t.source, t.client]), [
      ["ticket 1", "web", "desktop"],
      ["ticket 4", "android", "android"],
      ["ticket 6", "ios", "ios"],
      ["ticket 2", "web", "web"],
      ["ticket 5", "android", "android"],
      ["ticket 3", "web", "web"],
    ]);
    assert.equal(body.unread_total, 3, "the sum over the apps");
    // Per app, so a client can replace one entry on a push and re-sum (ohos has no app here: no key).
    assert.deepEqual(body.unread_by_source, { web: 2, android: 1, ios: 0 });
    assert.equal(body.next_cursor, null);
    assert.deepEqual(body.unavailable_sources, []);

    const lists = requests.filter((r) => r.method === "GET");
    assert.deepEqual(
      lists.map((r) => [r.url.split("/")[3], r.headers.authorization]).sort(),
      [[LEGACY_APP_ID, "Bearer legacy_conversation_token"], [ANDROID_APP_ID, "Bearer android_token"], [IOS_APP_ID, "Bearer ios_token"]].sort(),
    );
    // Each app's reporter binding was made with that app's token; ohos (no app) was never asked.
    const bindings = requests.filter((r) => r.method === "PUT");
    assert.deepEqual(bindings.map((r) => r.url.split("/")[3]).sort(), [ANDROID_APP_ID, IOS_APP_ID, LEGACY_APP_ID].sort());
    // Hands' `client_kind` / `client_version` stay inside: the list exposes the derived `client` only.
    assert.equal("client_kind" in (body.tickets[0] as object), false);
  }));
});

test("pages continue across apps through the composite cursor without repeating or skipping a ticket", async ({ app }) => {
  const apps: Record<string, FakeApp> = {
    // android's second page (7: 350) is newer than web's buffered 3 (300): without the
    // frontier hold, 3 would come out before 7.
    [LEGACY_APP_ID]: { tickets: [handsTicket(1, 900), handsTicket(2, 500), handsTicket(3, 300), handsTicket(4, 100)], unread: 2, pageSize: 2 },
    [ANDROID_APP_ID]: { tickets: [handsTicket(5, 800), handsTicket(6, 450), handsTicket(7, 350), handsTicket(8, 50)], unread: 1, pageSize: 2 },
    [IOS_APP_ID]: { tickets: [], unread: 4, pageSize: 2 },
  };
  await withUpstream(apps, async (baseUrl) => withEnv(baseUrl, async () => {
    const token = await seedToken();
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const { status, body } = await listAll(app.baseUrl, token, { limit: "3", ...(cursor ? { cursor } : {}) });
      assert.equal(status, 200, JSON.stringify(body));
      // The sum on the first page; unknown on cursor pages (iOS, read to its end, is not read again).
      assert.equal(body.unread_total, pages === 0 ? 7 : null);
      assert.deepEqual(body.unread_by_source, pages === 0 ? { web: 2, android: 1, ios: 4 } : undefined);
      seen.push(...body.tickets.map((t) => t.message));
      cursor = body.next_cursor;
      pages += 1;
      assert.ok(pages <= 12, "paging ends");
    } while (cursor);
    assert.deepEqual(seen, ["ticket 1", "ticket 5", "ticket 2", "ticket 6", "ticket 7", "ticket 3", "ticket 4", "ticket 8"]);
  }));
});

test("an app that fails is left out and named; its state is kept for the next page; the rest is served", async ({ app }) => {
  const apps: Record<string, FakeApp> = {
    ...THREE_APPS,
    [IOS_APP_ID]: { ...THREE_APPS[IOS_APP_ID]!, fail: 503 },
  };
  await withUpstream(apps, async (baseUrl) => withEnv(baseUrl, async () => {
    const token = await seedToken();
    const { status, body } = await listAll(app.baseUrl, token, { limit: "2" });
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body.tickets.map((t) => t.message), ["ticket 1", "ticket 4"]);
    assert.deepEqual(body.unavailable_sources, ["ios"]);
    assert.equal(body.unread_total, null, "unknown while an app is missing: the client keeps its value");
    assert.deepEqual(body.unread_by_source, { web: 2, android: 1 }, "the apps that answered, so a client can still keep those entries");
    assert.ok(body.next_cursor, "more to read");

    // Hands recovers: the next page includes the iOS ticket where its activity places it.
    apps[IOS_APP_ID]!.fail = undefined;
    const next = await listAll(app.baseUrl, token, { limit: "2", cursor: body.next_cursor! });
    assert.equal(next.status, 200, JSON.stringify(next.body));
    assert.deepEqual(next.body.tickets.map((t) => t.message), ["ticket 6", "ticket 2"]);
    assert.deepEqual(next.body.unavailable_sources, []);
    assert.equal(next.body.unread_total, null, "a cursor page: unknown");
  }));
});

test("a binding that fails for one app, or a Hands 5xx, drops that app; a Hands 400 for one app fails the request as the client's", async ({ app }) => {
  const apps: Record<string, FakeApp> = {
    ...THREE_APPS,
    [ANDROID_APP_ID]: { ...THREE_APPS[ANDROID_APP_ID]!, bindFail: 503 },
  };
  await withUpstream(apps, async (baseUrl) => withEnv(baseUrl, async () => {
    const token = await seedToken();
    const dropped = await listAll(app.baseUrl, token);
    assert.equal(dropped.status, 200, JSON.stringify(dropped.body));
    assert.deepEqual(dropped.body.unavailable_sources, ["android"]);
    assert.deepEqual(dropped.body.tickets.map((t) => t.message), ["ticket 1", "ticket 6", "ticket 2", "ticket 3"]);

    apps[ANDROID_APP_ID] = { ...THREE_APPS[ANDROID_APP_ID]!, fail: 400 };
    const refused = await listAll(app.baseUrl, token);
    assert.equal(refused.status, 400);

    // A rotated token (Hands 401) is not a blip: dropped, but said in the log, with the code and status only.
    apps[ANDROID_APP_ID] = { ...THREE_APPS[ANDROID_APP_ID]!, fail: 401 };
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    let rejected;
    try {
      rejected = await listAll(app.baseUrl, token);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    assert.deepEqual(rejected.body.unavailable_sources, ["android"]);
    assert.ok(warnings.some((line) => line.includes("[product-feedback] list_all source failed (android: feedback_integration_unavailable upstream_response 401)")), warnings.join("\n"));
    assert.equal(warnings.some((line) => line.includes("android_token")), false);
  }));
});

test("the apps parameter unreadable mid-pagination: the mobile apps are unavailable, not gone, and their place is kept", async ({ app }) => {
  const apps: Record<string, FakeApp> = {
    [LEGACY_APP_ID]: { tickets: [handsTicket(1, 900), handsTicket(2, 500), handsTicket(3, 100)], unread: 0, pageSize: 1 },
    [ANDROID_APP_ID]: { tickets: [handsTicket(4, 800), handsTicket(5, 50)], unread: 1, pageSize: 1 },
    [IOS_APP_ID]: { tickets: [], unread: 0, pageSize: 1 },
  };
  await withUpstream(apps, async (baseUrl) => withEnv(baseUrl, async () => {
    const token = await seedToken();
    const first = await listAll(app.baseUrl, token, { limit: "1" });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body.tickets.map((t) => t.message), ["ticket 1"]);

    // SSM blip: the parameter cannot be read (the reader fails; the cache keeps null for 30 s).
    setProductFeedbackAppsForTest(new CachedProductFeedbackApps(
      async () => { throw new Error("ssm down"); },
      { HANDS_FEEDBACK_APPS_SSM_PARAMETER: "/slock/staging/HANDS_FEEDBACK_APPS" },
    ));
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    let second;
    try {
      second = await listAll(app.baseUrl, token, { limit: "1", cursor: first.body.next_cursor! });
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(second.status, 200, JSON.stringify(second.body));
    // iOS was read to its end on the first page, so only android (still being read) is missing.
    assert.deepEqual(second.body.unavailable_sources, ["android"]);
    assert.equal(second.body.unread_total, null);
    // Best effort: what is readable is shown; android's place is kept for when it is back.
    assert.deepEqual(second.body.tickets.map((t) => t.message), ["ticket 2"]);
    assert.ok(warnings.some((line) => line.includes("source unavailable (android: apps_parameter_unread)")), warnings.join("\n"));

    // The parameter is back: android continues from where it was, nothing of its is lost.
    setProductFeedbackAppsForTest(appsReader());
    // Page 1 at limit 1 showed nothing of android's; its second page is read toward its boundary whatever the limit.
    const seen = ["ticket 1", "ticket 2"];
    let cursor = second.body.next_cursor;
    while (cursor) {
      const page = await listAll(app.baseUrl, token, { limit: "1", cursor });
      assert.equal(page.status, 200, JSON.stringify(page.body));
      seen.push(...page.body.tickets.map((t) => t.message));
      cursor = page.body.next_cursor;
      assert.ok(seen.length <= 10);
    }
    assert.deepEqual(seen.sort(), ["ticket 1", "ticket 2", "ticket 3", "ticket 4", "ticket 5"]);
  }));
});

test("a changed limit between pages neither repeats nor skips", async ({ app }) => {
  const apps: Record<string, FakeApp> = {
    [LEGACY_APP_ID]: { tickets: [1, 2, 3, 4, 5, 6, 7].map((n) => handsTicket(n, 1000 - n * 10)), unread: 0, pageSize: 50 },
    [ANDROID_APP_ID]: { tickets: [8, 9].map((n) => handsTicket(n, 1000 - n * 10)), unread: 0, pageSize: 50 },
    [IOS_APP_ID]: { tickets: [], unread: 0, pageSize: 50 },
  };
  await withUpstream(apps, async (baseUrl, requests) => withEnv(baseUrl, async () => {
    const token = await seedToken();
    const first = await listAll(app.baseUrl, token, { limit: "5" });
    assert.deepEqual(first.body.tickets.map((t) => t.message), ["ticket 1", "ticket 2", "ticket 3", "ticket 4", "ticket 5"]);
    const before = requests.length;
    const second = await listAll(app.baseUrl, token, { limit: "2", cursor: first.body.next_cursor! });
    assert.deepEqual(second.body.tickets.map((t) => t.message), ["ticket 6", "ticket 7"]);
    // An app that has shown something is re-read at Hands' whole page, whatever the client's limit.
    const webReads = requests.slice(before).filter((r) => r.method === "GET" && r.url.startsWith(`/api/apps/${LEGACY_APP_ID}/reporter-feedback?`));
    assert.deepEqual(webReads.map((r) => new URLSearchParams(r.url.split("?")[1]).get("limit")), ["50"]);
    const third = await listAll(app.baseUrl, token, { limit: "10", cursor: second.body.next_cursor! });
    assert.deepEqual(third.body.tickets.map((t) => t.message), ["ticket 8", "ticket 9"]);
    assert.equal(third.body.next_cursor, null);
  }));
});

test("the single-app list keeps its shape when Hands sends the new fields; the detail's ticket gains source and client", async ({ app }) => {
  await withUpstream(THREE_APPS, async (baseUrl) => withEnv(baseUrl, async () => {
    const token = await seedToken();
    const single = await fetch(`${app.baseUrl}/api/product-feedback/tickets`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(single.status, 200);
    const list = await single.json() as { tickets: Array<Record<string, unknown>>; unread_total: number };
    assert.equal(list.tickets.length, 3);
    for (const ticket of list.tickets) {
      assert.equal("client_kind" in ticket, false);
      assert.equal("client_version" in ticket, false);
      assert.equal("source" in ticket, false);
      assert.equal("client" in ticket, false);
    }
    assert.equal(list.unread_total, 2);

    const desktopId = THREE_APPS[LEGACY_APP_ID]!.tickets[0]!.id as string;
    const detail = await fetch(`${app.baseUrl}/api/product-feedback/tickets/${desktopId}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(detail.status, 200, await detail.clone().text());
    const body = await detail.json() as { ticket: Record<string, unknown> };
    assert.equal(body.ticket.source, "web");
    assert.equal(body.ticket.client, "desktop");
    assert.equal("client_kind" in body.ticket, false);

    const androidId = THREE_APPS[ANDROID_APP_ID]!.tickets[0]!.id as string;
    const other = await fetch(`${app.baseUrl}/api/product-feedback/tickets/${androidId}?platform=android`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(other.status, 200, await other.clone().text());
    const otherBody = await other.json() as { ticket: Record<string, unknown> };
    assert.deepEqual([otherBody.ticket.source, otherBody.ticket.client], ["android", "android"]);
  }));
});

test("when every app fails the request fails as before: 503, or the degraded page with degraded_ok=1", async ({ app }) => {
  const apps: Record<string, FakeApp> = Object.fromEntries(Object.entries(THREE_APPS).map(([id, a]) => [id, { ...a, fail: 503 }]));
  await withUpstream(apps, async (baseUrl) => withEnv(baseUrl, async () => {
    const token = await seedToken();
    const plain = await listAll(app.baseUrl, token);
    assert.equal(plain.status, 503);
    const degraded = await listAll(app.baseUrl, token, { degraded_ok: "1" });
    assert.equal(degraded.status, 200);
    assert.equal(degraded.body.degraded, true);
    assert.equal(degraded.body.unread_total, null);
  }));
});

test("a sources value other than all is invalid; a composite cursor does not replay for another user", async ({ app }) => {
  await withUpstream({
    [LEGACY_APP_ID]: { tickets: [handsTicket(1, 900), handsTicket(2, 500)], unread: 0, pageSize: 1 },
    [ANDROID_APP_ID]: { tickets: [], unread: 0, pageSize: 1 },
    [IOS_APP_ID]: { tickets: [], unread: 0, pageSize: 1 },
  }, async (baseUrl) => withEnv(baseUrl, async () => {
    const token = await seedToken();
    const bad = await fetch(`${app.baseUrl}/api/product-feedback/tickets?sources=web`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(bad.status, 400);

    const first = await listAll(app.baseUrl, token, { limit: "1" });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.ok(first.body.next_cursor);
    // The same cursor on the single-app list (another route) is invalid too.
    const singleApp = await fetch(`${app.baseUrl}/api/product-feedback/tickets?cursor=${encodeURIComponent(first.body.next_cursor!)}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(singleApp.status, 400);

    const other = await seedToken("merged-feedback-2@slock.test");
    const replay = await listAll(app.baseUrl, other, { limit: "1", cursor: first.body.next_cursor! });
    assert.equal(replay.status, 400);
  }));
});
