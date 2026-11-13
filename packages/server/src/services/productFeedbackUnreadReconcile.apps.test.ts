// The unread reconcile over every Hands feedback app
// (productFeedbackUnreadReconcile.ts): the web app's job as it was, and one
// job per mobile source that has an app, each with its own claim, cursor,
// state and event; on a task, the web app's tick and the mobile sources' tick
// share nothing but the timer. The web app's own behaviour is in
// productFeedbackUnreadReconcile.test.ts.
import assert from "node:assert/strict";
import { afterEach, vi } from "vitest";
import {
  BasicTracer,
  MemoryTraceSink,
  PRODUCT_FEEDBACK_APP_UNREAD_EVENT,
  PRODUCT_FEEDBACK_UNREAD_EVENT,
} from "@botiverse/raft-shared";
import { CachedProductFeedbackApps, resolveProductFeedbackEnv, type ProductFeedbackSource } from "./productFeedbackApps";
import {
  resetProductFeedbackBreakersForTest,
  resetProductFeedbackReporterSessionCacheForTest,
} from "./productFeedbackConversationService";
import { readProductFeedbackRouteConfig, resetProductFeedbackRouteBindingCacheForTest } from "./productFeedbackRouteBindingService";
import { mintProductFeedbackRouteSubject } from "./productFeedbackRouteSubject";
import { productFeedbackReporterId } from "./productFeedbackService";
import { setProductFeedbackUnreadRealtimeIO } from "./productFeedbackUnreadRealtime";
import {
  memoryProductFeedbackReconcileState,
  PRODUCT_FEEDBACK_RECONCILE_CLAIM_KEY,
  productFeedbackReconcileClaimKey,
  productFeedbackReconcileCursorKey,
  readProductFeedbackReconcileAppConfig,
  readProductFeedbackReconcileConfig,
  redisProductFeedbackReconcileState,
  runProductFeedbackUnreadReconcile,
  startProductFeedbackUnreadReconcileWorker,
  type ProductFeedbackReconcileConfig,
  type ProductFeedbackReconcileState,
  type ProductFeedbackReconcileWorkerHandle,
} from "./productFeedbackUnreadReconcile";

const WEB_APP_ID = "850a1eca-2664-4e44-9020-51fbdf7a8a70";
const IOS_APP_ID = "0b6f1c1e-3a52-4d0c-9f6e-2a8a7f1d4c11";
const ANDROID_APP_ID = "5d2c7a90-91e4-4b7b-8a35-6c0e4f9b2d22";
const APPS_PARAMETER = "/slock/staging/HANDS_FEEDBACK_APPS";
/** The process env: the web (single) app, the job's switch, and the name of the mobile apps' parameter. */
const ENV = {
  HANDS_FEEDBACK_BASE_URL: "https://hands.example/",
  HANDS_FEEDBACK_APP_ID: WEB_APP_ID,
  HANDS_FEEDBACK_CONVERSATION_APP_TOKEN: "web-conversation-token",
  HANDS_FEEDBACK_CONVERSATION_CREDENTIAL_REVISION: "token-revision-1",
  HANDS_FEEDBACK_CURSOR_SECRET: "cursor-secret",
  HANDS_FEEDBACK_REPORTER_INTEGRATION_ID: `legacy-feedback:${WEB_APP_ID}`,
  HANDS_FEEDBACK_REPORTER_ID_SECRET: "legacy-reporter-id-secret",
  HANDS_FEEDBACK_ROUTE_SUBJECT_KEY_ID: "v1",
  HANDS_FEEDBACK_ROUTE_SUBJECT_ROOT: Buffer.alloc(32, 7).toString("base64url"),
  HANDS_FEEDBACK_UNREAD_RECONCILE_ENABLED: "true",
  HANDS_FEEDBACK_APPS_SSM_PARAMETER: APPS_PARAMETER,
} as NodeJS.ProcessEnv;

// The shared secrets of the mobile apps are never the legacy ones.
const SHARED = {
  reporter_id_secret: "multi-reporter-id-secret",
  route_subject_root: Buffer.alloc(32, 9).toString("base64url"),
  cursor_secret: "multi-cursor-secret",
};
const IOS_ENTRY = {
  app_slug: "raft-feedback-ios", app_id: IOS_APP_ID, reporter_integration_id: "9414a84b-7b41-44a2-96b5-b3617ec057cc",
  credential_revision: "1", client_key: "qk_ios", token: "ios-token",
};
const ANDROID_ENTRY = {
  app_slug: "raft-feedback-android", app_id: ANDROID_APP_ID, reporter_integration_id: "3c1f6a2e-8d47-4e19-b0a3-7f5d2c9e6b33",
  credential_revision: "1", client_key: "qk_android", token: "android-token",
};
/** iOS and Android have an app; HarmonyOS has none. */
const APPS_JSON = JSON.stringify({ shared: SHARED, ios: IOS_ENTRY, android: ANDROID_ENTRY });

/** The apps parameter as `read` answers it now (nothing cached, so a changed answer is seen at once). */
function appsOf(read: () => string | null = () => APPS_JSON): CachedProductFeedbackApps {
  return new CachedProductFeedbackApps(async () => read(), { HANDS_FEEDBACK_APPS_SSM_PARAMETER: APPS_PARAMETER }, 0, Date.now, 0);
}

/** The env view the routes and the job use for `source`'s app. */
function envOf(source: ProductFeedbackSource): Promise<NodeJS.ProcessEnv> {
  return resolveProductFeedbackEnv({ source, env: ENV, apps: appsOf() });
}

async function configOf(source: ProductFeedbackSource): Promise<ProductFeedbackReconcileConfig> {
  const read = source === "web" ? readProductFeedbackReconcileConfig(ENV) : readProductFeedbackReconcileAppConfig(source, await envOf(source));
  assert.ok("config" in read, `${source} configured`);
  return read.config;
}

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const T1 = "aaaaaaaa-0000-4000-8000-000000000001";
const T2 = "aaaaaaaa-0000-4000-8000-000000000002";
const C1 = "cccccccc-0000-4000-8000-000000000001";
const C2 = "cccccccc-0000-4000-8000-000000000002";

type Comment = { id: string; author_type: "reporter" | "staff" | "system"; body: string };
type Change = { ticket_id: string; route_subject: string | null; reporter_id: string; comment_id?: string | null };

/**
 * A change of `userId`'s ticket in the app of `env`, as Hands sends it: the
 * reporter id and the route subject the route binding gives that user in that
 * app (ensureProductFeedbackRouteBinding: both from the app's own route
 * configuration, so a mobile app's from the shared secrets).
 */
function change(env: NodeJS.ProcessEnv, ticketId: string, userId: string, commentId: string): Change {
  const route = readProductFeedbackRouteConfig(env);
  const reporterId = productFeedbackReporterId(userId, route.reporterIdSecret);
  const routeSubject = mintProductFeedbackRouteSubject({
    root: route.root, userId, coordinate: { appId: route.appId, reporterIntegrationId: route.reporterIntegrationId, reporterId },
  });
  return { ticket_id: ticketId, route_subject: routeSubject, reporter_id: reporterId, comment_id: commentId };
}

const staffReply = (id: string): Comment[] => [{ id, author_type: "staff", body: "staff public reply text" }];
/** A feed position with nothing new (what a later tick reads). */
const idle = (cursor: string) => ({ [cursor]: { changes: [], next_cursor: cursor } });

type FakeApp = {
  pages?: Record<string, { changes: Change[]; next_cursor: string; has_more?: boolean }>;
  comments?: Record<string, Comment[]>;
  /** The reporter's unread total in this app, as its detail answers it. */
  unreadTotal?: number;
  changesStatus?: number;
  changesHeaders?: Record<string, string>;
};

/** A Hands stand-in keeping each app's change feed and tickets apart, as Hands does; an app it does not have answers 404. */
function fakeHands(apps: Record<string, FakeApp>) {
  const requests: Array<{ appId: string | null; feed: boolean; url: URL; authorization: string | null; reporterHeader: string | null }> = [];
  const fetchImpl = (async (target: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(target));
    const headers = new Headers(init?.headers);
    const match = url.pathname.match(/^\/api\/apps\/([0-9a-f-]{36})\/reporter-feedback\/(changes|[0-9a-f-]{36})$/);
    const appId = match?.[1] ?? null;
    const what = match?.[2] ?? "";
    requests.push({ appId, feed: what === "changes", url, authorization: headers.get("authorization"), reporterHeader: headers.get("x-hands-reporter-id") });
    const app = appId ? apps[appId] : undefined;
    if (!app) return Response.json({ error: "not_found" }, { status: 404 });
    if (what === "changes") {
      if (app.changesStatus) return Response.json({ error: "no" }, { status: app.changesStatus, headers: app.changesHeaders });
      const cursor = url.searchParams.get("cursor");
      // Without a cursor: Hands' current position only, no history.
      if (cursor === null) return Response.json({ changes: [], next_cursor: "position-0", has_more: false });
      const page = app.pages?.[cursor];
      if (!page) return Response.json({ error: "invalid_cursor" }, { status: 400 });
      return Response.json({ has_more: false, ...page });
    }
    return Response.json({
      ticket: {
        id: what, kind: "feedback", status: "open", closure_reason: null, duplicate_of_ticket_id: null,
        message: "private ticket message", version_name: null, channel: null, created_at: 1_700_000_000_000, updated_at: 1_700_000_000_001,
        attachment_count: 0, comment_count: 1, latest_comment_at: 1_700_000_000_001, unread: false, unread_count: 0,
      },
      comments: (app.comments?.[what] ?? []).map((comment, position) => ({ created_at: 1_700_000_000_000 + position, ...comment })),
      attachments: [], next_comment_cursor: null, unread_total: app.unreadTotal ?? 0,
    });
  }) as typeof fetch;
  /** The apps whose change feed was read, in order, from request `from` on. */
  const feedReads = (from = 0) => requests.slice(from).filter((request) => request.feed).map((request) => request.appId);
  return { fetchImpl, requests, feedReads };
}

function captureSocket() {
  const frames: Array<{ room: string; event: string; payload: unknown }> = [];
  setProductFeedbackUnreadRealtimeIO({
    to: (room: string) => ({ emit: (event: string, payload: unknown) => { frames.push({ room, event, payload }); return true; } }),
  } as never);
  return frames;
}

/** A state where the job already ran for each of `appIds` (their cursor is `cursor-0`). */
function stateAt(...appIds: string[]) {
  const state = memoryProductFeedbackReconcileState();
  for (const appId of appIds) state.cursors.set(appId, "cursor-0");
  return state;
}

const RUN_EVENT = "server.product_feedback.unread_reconcile.run";

/** The attributes of the run events recorded so far, in order. */
function runEvents(sink: MemoryTraceSink): Array<Record<string, unknown>> {
  return sink.getAllLogEvents().filter((event) => event.name === RUN_EVENT).map((event) => ({ ...event.attrs }));
}

/** The worker's "skips <source>" lines among what console.info was given. */
function skipLines(info: { mock: { calls: unknown[][] } }): string[] {
  return info.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("unread reconcile skips"));
}

const quietLog = { warn: () => {} };

/** One minute on a task, one tick after the other so the order is fixed: the web tick, then the mobile tick. */
async function minute(worker: ProductFeedbackReconcileWorkerHandle): Promise<void> {
  await worker.tick();
  await worker.tickMobile();
}

/** A promise settled from outside: a point a test waits for, or holds a fake at. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setProductFeedbackUnreadRealtimeIO(null);
  resetProductFeedbackBreakersForTest();
  resetProductFeedbackReporterSessionCacheForTest();
  resetProductFeedbackRouteBindingCacheForTest();
});

test("a mobile app's new public reply pushes product_feedback:app_unread with its source and total to the reporter's own connections, and nothing on the web event", async () => {
  const androidEnv = await envOf("android");
  const hands = fakeHands({
    [ANDROID_APP_ID]: {
      pages: { "cursor-0": { changes: [change(androidEnv, T1, USER_A, C1)], next_cursor: "cursor-1" } },
      comments: { [T1]: staffReply(C1) },
      unreadTotal: 2,
    },
  });
  const state = stateAt(ANDROID_APP_ID);
  const frames = captureSocket();
  const sink = new MemoryTraceSink();
  const result = await runProductFeedbackUnreadReconcile({
    config: await configOf("android"), state, fetchImpl: hands.fetchImpl, log: quietLog, tracer: new BasicTracer({ sink }),
  });
  assert.equal(result.outcome, "ok");
  assert.equal(result.usersPushed, 1);
  // The only frame: nothing goes out on the web event, which carries the web app's total only.
  assert.deepEqual(frames, [
    { room: `user:${USER_A}`, event: PRODUCT_FEEDBACK_APP_UNREAD_EVENT, payload: { source: "android", unreadTotal: 2 } },
  ]);

  // The Android app, with its own token; the detail as the reporter the shared secret gives, never marking read.
  assert.deepEqual(hands.requests.map((request) => request.appId), [ANDROID_APP_ID, ANDROID_APP_ID]);
  for (const request of hands.requests) assert.equal(request.authorization, "Bearer android-token");
  const detail = hands.requests.find((request) => !request.feed)!;
  assert.equal(detail.reporterHeader, productFeedbackReporterId(USER_A, SHARED.reporter_id_secret));
  assert.equal(detail.url.searchParams.get("mark_read"), "false");

  // Its own cursor and seen reply, by app id; the web app's are untouched.
  assert.equal(state.cursors.get(ANDROID_APP_ID), "cursor-1");
  assert.equal(state.cursors.has(WEB_APP_ID), false);
  assert.equal(await state.getSeenComment(ANDROID_APP_ID, T1), C1);
  assert.equal(await state.getSeenComment(WEB_APP_ID, T1), null);

  // The run can be told from the web app's.
  assert.equal(runEvents(sink)[0]?.source, "android");
  assert.equal(sink.getAllSpans().find((span) => span.name === "server.product_feedback.unread_reconcile")?.attrs?.source, "android");
});

test("a route subject sealed for another app (the web app's, or another mobile app's) does not open in a mobile app's feed: no recipient is guessed", async () => {
  const hands = fakeHands({
    [ANDROID_APP_ID]: {
      pages: { "cursor-0": { changes: [change(ENV, T1, USER_A, C1), change(await envOf("ios"), T2, USER_B, C2)], next_cursor: "cursor-1" } },
      comments: { [T1]: staffReply(C1), [T2]: staffReply(C2) },
      unreadTotal: 2,
    },
  });
  const state = stateAt(ANDROID_APP_ID);
  const frames = captureSocket();
  const result = await runProductFeedbackUnreadReconcile({ config: await configOf("android"), state, fetchImpl: hands.fetchImpl, log: quietLog });
  assert.equal(result.outcome, "ok");
  assert.equal(result.ticketsUnmapped, 2);
  assert.deepEqual(frames, []);
  assert.equal(hands.requests.filter((request) => !request.feed).length, 0, "no detail read for a ticket without a recipient");
});

test("a mobile source's env view carries no job switch: its app is configured from the view alone, and only the process env turns the job on", async () => {
  const androidEnv = await envOf("android");
  assert.equal(androidEnv.HANDS_FEEDBACK_UNREAD_RECONCILE_ENABLED, undefined);
  const read = readProductFeedbackReconcileAppConfig("android", androidEnv);
  assert.ok("config" in read);
  assert.equal(read.config.source, "android");
  assert.equal(read.config.appId, ANDROID_APP_ID);
  assert.equal(read.config.reporterIdSecret, SHARED.reporter_id_secret);
  assert.equal(read.config.routeSubjectRoot, SHARED.route_subject_root);
  // The web reader, given a mobile view, still asks for the switch: a view never passes for the process env.
  assert.deepEqual(readProductFeedbackReconcileConfig(androidEnv), { disabled: "not_enabled" });

  // Mobile apps configured, the switch off: the job is off for every app.
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const hands = fakeHands({ [WEB_APP_ID]: {}, [IOS_APP_ID]: {}, [ANDROID_APP_ID]: {} });
  const worker = startProductFeedbackUnreadReconcileWorker({
    env: { ...ENV, HANDS_FEEDBACK_UNREAD_RECONCILE_ENABLED: undefined }, apps: appsOf(), intervalMs: 60_000,
    deps: { state: memoryProductFeedbackReconcileState(), fetchImpl: hands.fetchImpl },
  });
  await minute(worker);
  await worker.stop();
  assert.equal(hands.requests.length, 0);
  assert.deepEqual(info.mock.calls.map((call) => String(call[0])), ["[product-feedback] unread reconcile off (not_enabled)"]);
});

test("a minute runs the web app and each mobile source that has an app: each on its own event, cursor and claim, from one read of the apps; a source without one is skipped and said once", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const hands = fakeHands({
    [WEB_APP_ID]: {
      pages: { "cursor-0": { changes: [change(ENV, T1, USER_A, C1)], next_cursor: "cursor-1" }, ...idle("cursor-1") },
      comments: { [T1]: staffReply(C1) },
      unreadTotal: 2,
    },
    [IOS_APP_ID]: {
      pages: { "cursor-0": { changes: [change(await envOf("ios"), T1, USER_B, C1)], next_cursor: "cursor-1" }, ...idle("cursor-1") },
      comments: { [T1]: staffReply(C1) },
      unreadTotal: 1,
    },
    [ANDROID_APP_ID]: {
      pages: { "cursor-0": { changes: [change(await envOf("android"), T1, USER_A, C1)], next_cursor: "cursor-1" }, ...idle("cursor-1") },
      comments: { [T1]: staffReply(C1) },
      unreadTotal: 5,
    },
  });
  const state = stateAt(WEB_APP_ID, IOS_APP_ID, ANDROID_APP_ID);
  const frames = captureSocket();
  const sink = new MemoryTraceSink();
  let appsReads = 0;
  const apps = appsOf(() => {
    appsReads += 1;
    return APPS_JSON;
  });
  const worker = startProductFeedbackUnreadReconcileWorker({
    env: ENV, apps, intervalMs: 60_000, tracer: new BasicTracer({ sink }), deps: { state, fetchImpl: hands.fetchImpl },
  });
  try {
    await minute(worker);
    assert.equal(appsReads, 1, "the apps are read once for every source of the mobile tick");
    assert.deepEqual(frames, [
      { room: `user:${USER_A}`, event: PRODUCT_FEEDBACK_UNREAD_EVENT, payload: { userId: USER_A, unreadTotal: 2 } },
      { room: `user:${USER_B}`, event: PRODUCT_FEEDBACK_APP_UNREAD_EVENT, payload: { source: "ios", unreadTotal: 1 } },
      { room: `user:${USER_A}`, event: PRODUCT_FEEDBACK_APP_UNREAD_EVENT, payload: { source: "android", unreadTotal: 5 } },
    ]);
    assert.deepEqual(hands.feedReads(), [WEB_APP_ID, IOS_APP_ID, ANDROID_APP_ID], "the mobile sources one after another");
    for (const request of hands.requests) {
      const token = request.appId === WEB_APP_ID ? "web-conversation-token" : request.appId === IOS_APP_ID ? "ios-token" : "android-token";
      assert.equal(request.authorization, `Bearer ${token}`, "each app is read with its own token");
    }
    for (const appId of [WEB_APP_ID, IOS_APP_ID, ANDROID_APP_ID]) assert.equal(state.cursors.get(appId), "cursor-1");
    // The same ticket id in three apps: three seen replies, one per app.
    for (const appId of [WEB_APP_ID, IOS_APP_ID, ANDROID_APP_ID]) assert.equal(await state.getSeenComment(appId, T1), C1);

    assert.deepEqual(
      runEvents(sink).map((attrs) => [attrs.source, attrs.outcome, attrs.users_pushed ?? attrs.reason]),
      [["web", "ok", 1], ["ios", "ok", 1], ["android", "ok", 1], ["ohos", "disabled", "source_entry_missing"]],
    );
    assert.deepEqual(skipLines(info), ["[product-feedback] unread reconcile skips ohos (source_entry_missing)"]);

    // Within the claim window: every app is locked, Hands is not called.
    const calls = hands.requests.length;
    await minute(worker);
    assert.equal(hands.requests.length, calls);

    // The next minute: each app again from its own cursor, nothing new, and
    // the source without an app is not said again.
    state.expireClaim();
    await minute(worker);
    assert.deepEqual(hands.feedReads(calls), [WEB_APP_ID, IOS_APP_ID, ANDROID_APP_ID]);
    assert.equal(frames.length, 3);
    assert.equal(skipLines(info).length, 1, "one line per source and reason for the life of the process");
    assert.equal(runEvents(sink).filter((attrs) => attrs.outcome === "disabled").length, 1);
    assert.ok(hands.requests.every((request) => request.appId !== null && [WEB_APP_ID, IOS_APP_ID, ANDROID_APP_ID].includes(request.appId)));
  } finally {
    await worker.stop();
  }
});

test("a source without an app, or an apps parameter that cannot be read, is skipped without throwing or holding the web app; the source runs once its entry appears", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  let apps: string | null | Error = new Error("ssm unavailable");
  const hands = fakeHands({
    [WEB_APP_ID]: {
      pages: { "cursor-0": { changes: [change(ENV, T1, USER_A, C1)], next_cursor: "cursor-1" }, ...idle("cursor-1") },
      comments: { [T1]: staffReply(C1) },
      unreadTotal: 2,
    },
    [ANDROID_APP_ID]: {},
  });
  const state = stateAt(WEB_APP_ID);
  const frames = captureSocket();
  const worker = startProductFeedbackUnreadReconcileWorker({
    env: ENV, intervalMs: 60_000, deps: { state, fetchImpl: hands.fetchImpl },
    apps: appsOf(() => {
      if (apps instanceof Error) throw apps;
      return apps;
    }),
  });
  try {
    // The parameter cannot be read: the web app runs as ever.
    await minute(worker);
    assert.deepEqual(frames, [{ room: `user:${USER_A}`, event: PRODUCT_FEEDBACK_UNREAD_EVENT, payload: { userId: USER_A, unreadTotal: 2 } }]);
    assert.deepEqual(hands.feedReads(), [WEB_APP_ID]);
    assert.deepEqual(skipLines(info).sort(), ["android", "ios", "ohos"].map((source) => `[product-feedback] unread reconcile skips ${source} (apps_parameter_unread)`));

    // Readable, with no entry for any source: still only the web app, a new reason said once more.
    apps = JSON.stringify({ shared: SHARED });
    for (let round = 0; round < 3; round += 1) {
      state.expireClaim();
      await minute(worker);
    }
    assert.deepEqual(hands.feedReads(), [WEB_APP_ID, WEB_APP_ID, WEB_APP_ID, WEB_APP_ID]);
    assert.equal(skipLines(info).filter((line) => line.includes("skips android")).length, 2, "one line per reason, not one a minute");
    assert.ok(skipLines(info).includes("[product-feedback] unread reconcile skips android (source_entry_missing)"));
    assert.equal(skipLines(info).length, 6);

    // The entry appears (the parameter is read again each tick): Android starts from Hands' current position.
    apps = JSON.stringify({ shared: SHARED, android: ANDROID_ENTRY });
    state.expireClaim();
    const calls = hands.requests.length;
    await minute(worker);
    assert.deepEqual(hands.feedReads(calls), [WEB_APP_ID, ANDROID_APP_ID]);
    assert.equal(state.cursors.get(ANDROID_APP_ID), "position-0");
    assert.equal(frames.length, 1);
    assert.equal(skipLines(info).length, 6);
  } finally {
    await worker.stop();
  }
});

test("with no apps parameter (a single-app deployment) the worker runs the web app alone and reads nothing for a mobile source", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  let appsRead = 0;
  const hands = fakeHands({ [WEB_APP_ID]: { pages: idle("cursor-0") }, [ANDROID_APP_ID]: {} });
  const state = stateAt(WEB_APP_ID);
  const worker = startProductFeedbackUnreadReconcileWorker({
    env: { ...ENV, HANDS_FEEDBACK_APPS_SSM_PARAMETER: undefined }, intervalMs: 60_000, deps: { state, fetchImpl: hands.fetchImpl },
    apps: appsOf(() => {
      appsRead += 1;
      return APPS_JSON;
    }),
  });
  try {
    await minute(worker);
    assert.deepEqual(hands.feedReads(), [WEB_APP_ID]);
    assert.equal(appsRead, 0);
    assert.deepEqual(info.mock.calls, [], "nothing said: as before the mobile apps");
  } finally {
    await worker.stop();
  }
});

test("an apps read that never answers holds neither the web tick, the mobile tick nor stop(): the web app runs and every mobile source is skipped after one wait", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const hands = fakeHands({ [WEB_APP_ID]: { pages: idle("cursor-0") } });
  let reads = 0;
  const hung = new CachedProductFeedbackApps(() => {
    reads += 1;
    return new Promise<string | null>(() => {});
  }, { HANDS_FEEDBACK_APPS_SSM_PARAMETER: APPS_PARAMETER });
  const worker = startProductFeedbackUnreadReconcileWorker({
    env: ENV, apps: hung, appsReadTimeoutMs: 1, intervalMs: 60_000, deps: { state: stateAt(WEB_APP_ID), fetchImpl: hands.fetchImpl },
  });
  try {
    // The mobile tick first, and not awaited: the web tick does not wait for it.
    const mobile = worker.tickMobile();
    await worker.tick();
    assert.deepEqual(hands.feedReads(), [WEB_APP_ID]);
    await mobile;
    assert.equal(reads, 1, "one read, one wait, for the three sources");
    assert.deepEqual(skipLines(info), ["ios", "android", "ohos"].map((source) => `[product-feedback] unread reconcile skips ${source} (apps_read_timeout)`));
  } finally {
    await worker.stop();
  }

  // stop() while the read is still waited for (its own apps, so its own
  // read): it returns at once, and nothing is said of a source.
  const reading = deferred();
  const waiting = startProductFeedbackUnreadReconcileWorker({
    env: ENV, appsReadTimeoutMs: 600_000, intervalMs: 60_000, deps: { state: stateAt(WEB_APP_ID), fetchImpl: hands.fetchImpl },
    apps: new CachedProductFeedbackApps(() => {
      reading.resolve();
      return new Promise<string | null>(() => {});
    }, { HANDS_FEEDBACK_APPS_SSM_PARAMETER: APPS_PARAMETER }),
  });
  const tick = waiting.tickMobile();
  await reading.promise;
  const stoppedAt = Date.now();
  await waiting.stop();
  await tick;
  assert.ok(Date.now() - stoppedAt < 1_000, "stop() does not wait for the apps read");
  assert.equal(skipLines(info).length, 3);
});

test("a mobile run that outlasts the minute does not make the web app skip its tick: the timer starts the web tick again while the mobile tick is still going", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  // Only the worker's interval is faked (fired by hand below); the clock the claims expire by is the state's.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let now = Date.now();
  const state = memoryProductFeedbackReconcileState(() => now);
  for (const appId of [WEB_APP_ID, IOS_APP_ID, ANDROID_APP_ID]) state.cursors.set(appId, "cursor-0");
  const hands = fakeHands({ [WEB_APP_ID]: { pages: idle("cursor-0") }, [IOS_APP_ID]: { pages: idle("cursor-0") }, [ANDROID_APP_ID]: { pages: idle("cursor-0") } });
  // Hands does not answer the iOS app until released; each read of the web app's feed is a point to wait for.
  const iosAsked = deferred();
  const iosAnswers = deferred();
  const webFeedReads = [deferred(), deferred()];
  let iosCalls = 0;
  let webCalls = 0;
  const fetchImpl = (async (target: string | URL | Request, init?: RequestInit) => {
    const url = String(target);
    if (url.includes(IOS_APP_ID)) {
      iosCalls += 1;
      iosAsked.resolve();
      await iosAnswers.promise;
    }
    if (url.includes(WEB_APP_ID)) webFeedReads[webCalls++]?.resolve();
    return hands.fetchImpl(target, init);
  }) as typeof fetch;
  const worker = startProductFeedbackUnreadReconcileWorker({ env: ENV, apps: appsOf(), intervalMs: 60_000, deps: { state, fetchImpl } });
  try {
    // This minute: the mobile tick is held in the iOS app's run; the web tick runs to its end beside it.
    const mobile = worker.tickMobile();
    await iosAsked.promise;
    await worker.tick();
    assert.equal(webCalls, 1);

    // A minute later the mobile tick is still going. The timer fires: the web tick runs again, the mobile tick is not started twice.
    now += 60_000;
    vi.advanceTimersByTime(60_000);
    await webFeedReads[1]!.promise;
    assert.equal(webCalls, 2, "the web app was read again on time");
    assert.equal(iosCalls, 1, "the mobile tick in flight is not doubled");

    iosAnswers.resolve();
    await mobile;
    assert.deepEqual(hands.feedReads().filter((appId) => appId !== WEB_APP_ID), [IOS_APP_ID, ANDROID_APP_ID], "the held mobile tick went on to the next source");
  } finally {
    iosAnswers.resolve();
    await worker.stop();
  }
});

test("a mobile app that is rate limited or failing leaves the web app's run of the same minute and of the next as they were", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const hands = fakeHands({
    [WEB_APP_ID]: {
      pages: {
        "cursor-0": { changes: [change(ENV, T1, USER_A, C1)], next_cursor: "cursor-1" },
        "cursor-1": { changes: [change(ENV, T2, USER_A, C2)], next_cursor: "cursor-2" },
      },
      comments: { [T1]: staffReply(C1), [T2]: staffReply(C2) },
      unreadTotal: 2,
    },
    [IOS_APP_ID]: { changesStatus: 429, changesHeaders: { "Retry-After": "120" } },
    [ANDROID_APP_ID]: { changesStatus: 503 },
  });
  const state = stateAt(WEB_APP_ID, IOS_APP_ID, ANDROID_APP_ID);
  const frames = captureSocket();
  const sink = new MemoryTraceSink();
  const worker = startProductFeedbackUnreadReconcileWorker({
    env: ENV, apps: appsOf(), intervalMs: 60_000, tracer: new BasicTracer({ sink }), deps: { state, fetchImpl: hands.fetchImpl },
  });
  const webFrame = { room: `user:${USER_A}`, event: PRODUCT_FEEDBACK_UNREAD_EVENT, payload: { userId: USER_A, unreadTotal: 2 } };
  try {
    // The mobile tick first in each minute: whatever it met is behind the web tick.
    await worker.tickMobile();
    await worker.tick();
    assert.deepEqual(frames, [webFrame]);
    assert.equal(state.cursors.get(WEB_APP_ID), "cursor-1");

    state.expireClaim();
    await worker.tickMobile();
    await worker.tick();
    assert.deepEqual(frames, [webFrame, webFrame]);
    assert.equal(state.cursors.get(WEB_APP_ID), "cursor-2");
    assert.equal(await state.getNotBefore(WEB_APP_ID), null, "a mobile app's Retry-After is not the web app's");
    assert.ok((await state.getNotBefore(IOS_APP_ID))! >= Date.now() + 100_000);
    assert.deepEqual(
      runEvents(sink).filter((attrs) => attrs.outcome !== "disabled").map((attrs) => [attrs.source, attrs.outcome]),
      [["ios", "rate_limited"], ["android", "failed"], ["web", "ok"], ["ios", "skipped_backoff"], ["android", "failed"], ["web", "ok"]],
    );
  } finally {
    await worker.stop();
  }
});

test("each app has its own claim: two tasks ticking together make one run per app, and one app's claim never locks another's", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const page = (env: NodeJS.ProcessEnv) => ({
    pages: { "cursor-0": { changes: [change(env, T1, USER_A, C1)], next_cursor: "cursor-1" }, ...idle("cursor-1") },
    comments: { [T1]: staffReply(C1) },
    unreadTotal: 1,
  });
  const hands = fakeHands({ [WEB_APP_ID]: page(ENV), [IOS_APP_ID]: page(await envOf("ios")), [ANDROID_APP_ID]: page(await envOf("android")) });
  const state = stateAt(WEB_APP_ID, IOS_APP_ID, ANDROID_APP_ID);
  const frames = captureSocket();
  const task = () => startProductFeedbackUnreadReconcileWorker({ env: ENV, apps: appsOf(), intervalMs: 60_000, deps: { state, fetchImpl: hands.fetchImpl } });
  const tasks = [task(), task()];
  try {
    await Promise.all(tasks.map(minute));
    assert.deepEqual(hands.feedReads().sort(), [WEB_APP_ID, IOS_APP_ID, ANDROID_APP_ID].sort(), "one run per app between the two tasks");
    assert.deepEqual(frames.map((frame) => frame.event).sort(), [PRODUCT_FEEDBACK_APP_UNREAD_EVENT, PRODUCT_FEEDBACK_APP_UNREAD_EVENT, PRODUCT_FEEDBACK_UNREAD_EVENT]);
    const calls = hands.requests.length;
    await Promise.all(tasks.map(minute));
    assert.equal(hands.requests.length, calls, "a finished run keeps its app's claim for the window");
  } finally {
    await Promise.all(tasks.map((worker) => worker.stop()));
  }

  // Run by run: the Android app's claim locks the Android app only.
  const single = stateAt(WEB_APP_ID, ANDROID_APP_ID);
  const run = async (source: ProductFeedbackSource) =>
    (await runProductFeedbackUnreadReconcile({ config: await configOf(source), state: single, fetchImpl: hands.fetchImpl, push: () => {}, log: quietLog })).outcome;
  assert.deepEqual([await run("android"), await run("web"), await run("android"), await run("web")], ["ok", "ok", "skipped_locked", "skipped_locked"]);
});

test("the web app rate limited and a mobile app failing do not stop the next mobile app of the minute, and each app's backoff is its own", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const hands = fakeHands({
    [WEB_APP_ID]: { changesStatus: 429, changesHeaders: { "Retry-After": "120" } },
    [IOS_APP_ID]: { changesStatus: 503 },
    [ANDROID_APP_ID]: {
      pages: { "cursor-0": { changes: [change(await envOf("android"), T1, USER_A, C1)], next_cursor: "cursor-1" }, ...idle("cursor-1") },
      comments: { [T1]: staffReply(C1) },
      unreadTotal: 4,
    },
  });
  const state = stateAt(WEB_APP_ID, IOS_APP_ID, ANDROID_APP_ID);
  const frames = captureSocket();
  const sink = new MemoryTraceSink();
  const worker = startProductFeedbackUnreadReconcileWorker({
    env: ENV, apps: appsOf(), intervalMs: 60_000, tracer: new BasicTracer({ sink }), deps: { state, fetchImpl: hands.fetchImpl },
  });
  try {
    await minute(worker);
    assert.deepEqual(frames, [{ room: `user:${USER_A}`, event: PRODUCT_FEEDBACK_APP_UNREAD_EVENT, payload: { source: "android", unreadTotal: 4 } }]);
    assert.deepEqual(
      runEvents(sink).filter((attrs) => attrs.outcome !== "disabled").map((attrs) => [attrs.source, attrs.outcome, attrs.error_code ?? null]),
      [["web", "rate_limited", "changes_rate_limited"], ["ios", "failed", "changes_status_5xx"], ["android", "ok", null]],
    );
    assert.equal(state.cursors.get(WEB_APP_ID), "cursor-0");
    assert.equal(state.cursors.get(IOS_APP_ID), "cursor-0");
    assert.equal(state.cursors.get(ANDROID_APP_ID), "cursor-1");
    assert.ok((await state.getNotBefore(WEB_APP_ID))! >= Date.now() + 100_000, "the web app waits for its Retry-After");
    assert.equal(await state.getNotBefore(IOS_APP_ID), null);
    assert.equal(await state.getNotBefore(ANDROID_APP_ID), null);

    // The next minute: the web app is still backing off (not called); the others are read again.
    state.expireClaim();
    const calls = hands.requests.length;
    await minute(worker);
    assert.deepEqual(hands.feedReads(calls), [IOS_APP_ID, ANDROID_APP_ID]);
  } finally {
    await worker.stop();
  }
});

test("a mobile source set on the app of an earlier one (the web app's here) is not run: one job per app", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const hands = fakeHands({ [WEB_APP_ID]: { pages: idle("cursor-0") } });
  const state = stateAt(WEB_APP_ID);
  const worker = startProductFeedbackUnreadReconcileWorker({
    env: ENV, intervalMs: 60_000, deps: { state, fetchImpl: hands.fetchImpl },
    apps: appsOf(() => JSON.stringify({ shared: SHARED, android: { ...ANDROID_ENTRY, app_id: WEB_APP_ID } })),
  });
  try {
    await minute(worker);
    assert.deepEqual(hands.feedReads(), [WEB_APP_ID], "one read of the app's feed, the web job's");
    assert.equal(hands.requests[0]!.authorization, "Bearer web-conversation-token");
    assert.ok(skipLines(info).includes("[product-feedback] unread reconcile skips android (app_shared)"));
  } finally {
    await worker.stop();
  }
});

test("two mobile sources set on one app make one job: the later source is skipped and said once, with no claim or Hands call of its own", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const hands = fakeHands({ [IOS_APP_ID]: { pages: idle("cursor-0") } });
  const memory = stateAt(IOS_APP_ID);
  const claims: string[] = [];
  const state: ProductFeedbackReconcileState = {
    ...memory,
    claim(token, ttlMs, claimKey) {
      claims.push(claimKey);
      return memory.claim(token, ttlMs, claimKey);
    },
  };
  const worker = startProductFeedbackUnreadReconcileWorker({
    env: ENV, intervalMs: 60_000, deps: { state, fetchImpl: hands.fetchImpl },
    apps: appsOf(() => JSON.stringify({ shared: SHARED, ios: IOS_ENTRY, android: { ...ANDROID_ENTRY, app_id: IOS_APP_ID } })),
  });
  try {
    await worker.tickMobile();
    memory.expireClaim();
    await worker.tickMobile();
    const iosClaim = `${PRODUCT_FEEDBACK_RECONCILE_CLAIM_KEY}:${IOS_APP_ID}`;
    assert.deepEqual(claims, [iosClaim, iosClaim], "one claim of the app a minute, the earlier source's");
    assert.deepEqual(hands.feedReads(), [IOS_APP_ID, IOS_APP_ID]);
    for (const request of hands.requests) assert.equal(request.authorization, "Bearer ios-token");
    assert.deepEqual(
      skipLines(info).filter((line) => line.includes("skips android")),
      ["[product-feedback] unread reconcile skips android (app_shared)"],
    );
  } finally {
    await worker.stop();
  }
});

/**
 * The commands the Redis state sends, on an in-memory stand-in for the
 * bounded client: enough of GET, SET (NX, PX), DEL and the save-if-owner
 * script (three keys) for a healthy run, with every key touched recorded.
 */
function recordingRedis() {
  const store = new Map<string, string>();
  const keys = new Set<string>();
  const touch = (...names: string[]) => { for (const name of names) keys.add(name); };
  const client = {
    status: "ready",
    async get(key: string) {
      touch(key);
      return store.get(key) ?? null;
    },
    async set(key: string, value: string, ...flags: unknown[]) {
      touch(key);
      if (flags.includes("NX") && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    async del(key: string) {
      touch(key);
      return store.delete(key) ? 1 : 0;
    },
    async eval(_script: string, keyCount: number, ...rest: string[]) {
      assert.equal(keyCount, 3, "only the save-if-owner script is expected in a healthy run");
      const [claimKey, cursorKey, lastSuccessKey, token, cursor, at] = rest as [string, string, string, string, string, string];
      touch(claimKey, cursorKey, lastSuccessKey);
      if (store.get(claimKey) !== token) return 0;
      store.set(cursorKey, cursor);
      store.set(lastSuccessKey, at);
      return 1;
    },
  };
  return { store, keys, state: redisProductFeedbackReconcileState(() => client as never) };
}

test("Redis keys: the web app keeps the claim, cursor and state keys it had; a mobile app's claim, cursor and state carry its own app id", async () => {
  const web = await configOf("web");
  const android = await configOf("android");
  // The web app's claim is the job's one key from before the mobile apps: a
  // task of the older version and one of this version exclude each other.
  assert.equal(PRODUCT_FEEDBACK_RECONCILE_CLAIM_KEY, "slock:product-feedback-unread-reconcile:claim");
  assert.equal(productFeedbackReconcileClaimKey(web), PRODUCT_FEEDBACK_RECONCILE_CLAIM_KEY);
  assert.equal(productFeedbackReconcileClaimKey(android), `slock:product-feedback-unread-reconcile:claim:${ANDROID_APP_ID}`);
  assert.equal(productFeedbackReconcileCursorKey(WEB_APP_ID), `slock:product-feedback-unread-reconcile:cursor:v1:${WEB_APP_ID}`);

  const page = (env: NodeJS.ProcessEnv) => ({
    pages: { "cursor-0": { changes: [change(env, T1, USER_A, C1)], next_cursor: "cursor-1" } },
    comments: { [T1]: staffReply(C1) },
    unreadTotal: 1,
  });
  const hands = fakeHands({ [WEB_APP_ID]: page(ENV), [ANDROID_APP_ID]: page(await envOf("android")) });
  const redis = recordingRedis();
  redis.store.set(productFeedbackReconcileCursorKey(WEB_APP_ID), "cursor-0");
  redis.store.set(productFeedbackReconcileCursorKey(ANDROID_APP_ID), "cursor-0");
  const pushes: string[] = [];
  for (const config of [web, android]) {
    const result = await runProductFeedbackUnreadReconcile({
      config, state: redis.state, fetchImpl: hands.fetchImpl, push: () => pushes.push(config.source), log: quietLog,
    });
    assert.equal(result.outcome, "ok", `${config.source}: the other app's claim does not lock it`);
  }
  assert.deepEqual(pushes, ["web", "android"]);
  assert.equal(redis.store.get(productFeedbackReconcileCursorKey(WEB_APP_ID)), "cursor-1");
  assert.equal(redis.store.get(productFeedbackReconcileCursorKey(ANDROID_APP_ID)), "cursor-1");
  assert.ok(redis.store.has(PRODUCT_FEEDBACK_RECONCILE_CLAIM_KEY), "the web run holds the key older tasks claim");
  assert.ok(redis.store.has(`${PRODUCT_FEEDBACK_RECONCILE_CLAIM_KEY}:${ANDROID_APP_ID}`));

  // Every key is the web app's unchanged one, or names the app it belongs to
  // (the seen-reply key by a hash of app and ticket, so two of them here).
  const prefix = "slock:product-feedback-unread-reconcile";
  const named = [...redis.keys].filter((key) => !key.startsWith(`${prefix}:seen:v1:`)).sort();
  assert.deepEqual(named, [
    `${prefix}:claim`,
    `${prefix}:claim:${ANDROID_APP_ID}`,
    ...[ANDROID_APP_ID, WEB_APP_ID].map((appId) => `${prefix}:cursor:v1:${appId}`),
    ...[ANDROID_APP_ID, WEB_APP_ID].map((appId) => `${prefix}:last-success:v1:${appId}`),
    ...[ANDROID_APP_ID, WEB_APP_ID].map((appId) => `${prefix}:not-before:v1:${appId}`),
    ...[ANDROID_APP_ID, WEB_APP_ID].map((appId) => `${prefix}:stuck:v1:${appId}`),
  ].sort());
  assert.equal([...redis.keys].filter((key) => key.startsWith(`${prefix}:seen:v1:`)).length, 2, "the same ticket id in two apps is two seen replies");
});
