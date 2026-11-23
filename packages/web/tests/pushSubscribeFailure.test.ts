import assert from "node:assert/strict";
import "./helpers/domSetup";
import api from "../src/api/client";
import { autoResubscribeAndRecord, enablePushAndRecord, WEB_PUSH_AUTO_RESUBSCRIBE_LOCK } from "../src/utils/pushEnableRecording";
import {
  buildPushSubscribeFailure,
  clearPushSubscribeFailure,
  pushSubscribeFailureDetail,
  pushSubscribeRetryBackoffMs,
  readPushSubscribeFailure,
  rememberPushSubscribeFailure,
  shouldAutoRetryPushSubscribe,
  subscriptionFailedDetail,
  WEB_PUSH_SUBSCRIBE_FAILURE_KEY_PREFIX,
} from "../src/utils/pushSubscribeFailure";
import type { PushSubscribeFailure, PushSubscribeFailureKind } from "../src/utils/pushSubscribeFailure";
import { WEB_APP_VERSION } from "../src/utils/webAppVersion";

// The automatic re-subscribe's retry guard after a failed subscribe
// (#13764, #triage:7269cce5): the same failure again doubles the wait up to a
// day, a new app version does not retry, and every failure row has a detail.

const HOUR = 60 * 60 * 1000;
const EDGE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";
const FIREFOX_UA = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";

const originalUserAgent = Object.getOwnPropertyDescriptor(navigator, "userAgent");
const originalApi = { get: api.get, post: api.post };
const originalNotification = Object.getOwnPropertyDescriptor(globalThis, "Notification");
const originalWindowNotification = Object.getOwnPropertyDescriptor(window, "Notification");
const originalPushManager = Object.getOwnPropertyDescriptor(window, "PushManager");
const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");

function restoreProperty(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

function setUserAgent(ua: string) {
  Object.defineProperty(navigator, "userAgent", { configurable: true, get: () => ua });
}

function fail(kind: PushSubscribeFailureKind, now: number, overrides: { name?: string; endpoint?: string | null; permission?: string } = {}): PushSubscribeFailure {
  const error = Object.assign(new Error("Registration failed - push service error"), { name: overrides.name ?? "AbortError" });
  return rememberPushSubscribeFailure(buildPushSubscribeFailure({
    kind,
    error,
    permission: overrides.permission ?? "granted",
    endpoint: overrides.endpoint === undefined ? null : overrides.endpoint,
    now,
  }));
}

const retries = (now: number, endpoint: string | null = null) => shouldAutoRetryPushSubscribe({ permission: "granted", endpoint, now });

beforeEach(() => {
  window.localStorage.clear();
  clearPushSubscribeFailure();
  setUserAgent(EDGE_UA);
});

afterEach(() => {
  restoreProperty(navigator, "userAgent", originalUserAgent);
  api.get = originalApi.get;
  api.post = originalApi.post;
  restoreProperty(globalThis, "Notification", originalNotification);
  restoreProperty(window, "Notification", originalWindowNotification);
  restoreProperty(window, "PushManager", originalPushManager);
  restoreProperty(navigator, "serviceWorker", originalServiceWorker);
  restoreProperty(navigator, "locks", originalLocks);
  window.localStorage.clear();
});

const SUBSCRIBE_ERROR = () => Object.assign(new Error("Registration failed - push service error"), { name: "AbortError" });

/** Permission granted, no subscription, a server key; `subscribe` as given. Returns the recorded prompt events. */
function installPushEnvironment(subscribe: () => Promise<unknown>): Array<Record<string, unknown>> {
  const notification = { permission: "granted", requestPermission: async () => "granted" };
  Object.defineProperty(globalThis, "Notification", { configurable: true, value: notification });
  Object.defineProperty(window, "Notification", { configurable: true, value: notification });
  Object.defineProperty(window, "PushManager", { configurable: true, value: class PushManager {} });
  const registration = { update: async () => {}, pushManager: { getSubscription: async () => null, subscribe } };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { getRegistration: async () => registration, register: async () => registration },
  });
  api.get = (async () => ({ data: { publicKey: "AQ" } })) as unknown as typeof api.get;
  const events: Array<Record<string, unknown>> = [];
  api.post = (async (url: string, body?: Record<string, unknown>) => {
    if (url === "/push/prompt-events" && body) events.push(body);
    return { data: {} };
  }) as unknown as typeof api.post;
  return events;
}

/** Web Locks with `ifAvailable`, shared by every "tab" in this test. */
function installLocks(): string[] {
  const held = new Set<string>();
  const requested: string[] = [];
  const locks = {
    request: async (name: string, options: { ifAvailable?: boolean }, callback: (lock: unknown) => Promise<unknown>) => {
      requested.push(name);
      assert.equal(options.ifAvailable, true);
      if (held.has(name)) return callback(null);
      held.add(name);
      try {
        return await callback({ name, mode: "exclusive" });
      } finally {
        held.delete(name);
      }
    },
  };
  Object.defineProperty(navigator, "locks", { configurable: true, value: locks });
  return requested;
}

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const originalError = console.error;
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.error = originalError;
  }
}

function storeRaw(record: Record<string, unknown>) {
  window.localStorage.setItem(`${WEB_PUSH_SUBSCRIBE_FAILURE_KEY_PREFIX}anonymous`, JSON.stringify(record));
}

test("the same failure again doubles the wait: 1 h, 2 h, 4 h, … capped at 24 h", () => {
  let now = 1_000_000;
  const waits: number[] = [];
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const stored = fail("push_subscribe", now);
    assert.equal(stored.streak, attempt);
    const wait = pushSubscribeRetryBackoffMs(stored);
    waits.push(wait / HOUR);
    assert.equal(retries(now + wait - 1), false, `attempt ${attempt}: not before ${wait / HOUR} h`);
    assert.equal(retries(now + wait), true, `attempt ${attempt}: again after ${wait / HOUR} h`);
    now += wait;
  }
  assert.deepEqual(waits, [1, 2, 4, 8, 16, 24, 24, 24]);
});

test("a browser already at a day stays at a day", () => {
  setUserAgent(FIREFOX_UA);
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const stored = fail("push_subscribe", attempt * 30 * HOUR);
    assert.equal(stored.browser, "firefox");
    assert.equal(stored.streak, attempt);
    assert.equal(pushSubscribeRetryBackoffMs(stored), 24 * HOUR);
  }
});

test("another kind or error, another endpoint or permission, or a success starts the streak again", () => {
  fail("push_subscribe", 0);
  assert.equal(fail("push_subscribe", HOUR).streak, 2);
  assert.equal(fail("report", 2 * HOUR).streak, 1, "another stage");
  assert.equal(fail("report", 3 * HOUR).streak, 2);
  assert.equal(fail("report", 4 * HOUR, { name: "NetworkError" }).streak, 1, "another reason");
  assert.equal(fail("report", 5 * HOUR, { name: "NetworkError", endpoint: "https://push.example/a" }).streak, 1, "another endpoint");
  assert.equal(fail("report", 6 * HOUR, { name: "NetworkError", endpoint: "https://push.example/a" }).streak, 2);
  // A success (subscribeAndSave) or permission leaving granted (the banner) clears the record.
  clearPushSubscribeFailure();
  assert.equal(fail("report", 7 * HOUR, { name: "NetworkError", endpoint: "https://push.example/a" }).streak, 1, "after a success");
});

test("another signed-in person has their own streak", () => {
  const token = (sub: string) => `h.${btoa(JSON.stringify({ type: "access", sub })).replace(/=+$/, "")}.s`;
  window.localStorage.setItem("slock_access_token", token("person-a"));
  fail("push_subscribe", 0);
  assert.equal(fail("push_subscribe", HOUR).streak, 2);
  window.localStorage.setItem("slock_access_token", token("person-b"));
  assert.equal(readPushSubscribeFailure(), null);
  assert.equal(retries(2 * HOUR), true);
  assert.equal(fail("push_subscribe", 2 * HOUR).streak, 1);
  assert.deepEqual(
    Object.keys(window.localStorage).filter((key) => key.startsWith(WEB_PUSH_SUBSCRIBE_FAILURE_KEY_PREFIX)).sort(),
    [`${WEB_PUSH_SUBSCRIBE_FAILURE_KEY_PREFIX}person-a`, `${WEB_PUSH_SUBSCRIBE_FAILURE_KEY_PREFIX}person-b`],
  );
});

test("a new app version does not retry a browser refusal; permission and endpoint still do", () => {
  const stored = fail("push_subscribe", 0, { endpoint: "https://push.example/a" });
  // The same record, written by another release of the web app.
  storeRaw({ ...stored, appVersion: "0.0.1-old" });
  const read = readPushSubscribeFailure()!;
  assert.equal(read.appVersion, "0.0.1-old");
  const wait = pushSubscribeRetryBackoffMs(read);
  assert.equal(wait, HOUR);
  assert.equal(shouldAutoRetryPushSubscribe({ permission: "granted", endpoint: "https://push.example/a", now: wait - 1 }), false);
  assert.equal(shouldAutoRetryPushSubscribe({ permission: "granted", endpoint: "https://push.example/a", now: wait }), true);
  assert.equal(shouldAutoRetryPushSubscribe({ permission: "granted", endpoint: "https://push.example/b", now: 1 }), true);
  assert.equal(shouldAutoRetryPushSubscribe({ permission: "default", endpoint: "https://push.example/a", now: 1 }), true);
  // Failing again after the release continues the browser's streak.
  assert.equal(fail("push_subscribe", wait, { endpoint: "https://push.example/a" }).streak, 2);
});

test("a new app version shortens the wait to the 1 h base for a failure our code may cause, and starts a new streak", () => {
  for (const kind of ["report", "vapid_unavailable", "service_worker", "unexpected"] as const) {
    window.localStorage.clear();
    const stored = fail(kind, 0);
    // Fifth in a row, recorded by another release: 16 h (or a day) under that release.
    storeRaw({ ...stored, streak: 5, appVersion: "0.0.1-old" });
    const read = readPushSubscribeFailure()!;
    assert.equal(pushSubscribeRetryBackoffMs(read), HOUR, kind);
    assert.equal(retries(HOUR - 1), false, `${kind}: not at once`);
    assert.equal(retries(HOUR), true, `${kind}: after the base`);
    assert.equal(fail(kind, HOUR).streak, 1, `${kind}: a new streak under this version`);
    assert.equal(fail(kind, 2 * HOUR).streak, 2, kind);
  }
  // Under the same version the streak keeps doubling.
  window.localStorage.clear();
  fail("report", 0);
  fail("report", HOUR);
  assert.equal(pushSubscribeRetryBackoffMs(fail("report", 3 * HOUR)), 4 * HOUR);
});

test("the failure detail carries the streak and the web app version, under 128 characters", () => {
  fail("push_subscribe", 0);
  const stored = fail("push_subscribe", HOUR);
  const detail = pushSubscribeFailureDetail(stored);
  assert.ok(detail.startsWith(`browser=edge;kind=push_subscribe;n=2;v=${WEB_APP_VERSION};name=AbortError;msg=Registration failed`), detail);
  assert.ok(detail.length <= 120);
  // Records from before the streak existed read as the first failure.
  const legacy: Partial<PushSubscribeFailure> = { ...stored };
  delete legacy.streak;
  storeRaw(legacy);
  assert.equal(readPushSubscribeFailure()?.streak, 1);
  assert.match(pushSubscribeFailureDetail(readPushSubscribeFailure()!), /;n=1;/);
});

test("a long version and error name never cut n= or v=: msg is cut first", () => {
  const longVersion = "1.21.54-rc.12+build.20261119.abcdef0123456789";
  const longName = "SomeVeryLongVendorSpecificPushRegistrationErrorName";
  const failure: PushSubscribeFailure = {
    ...buildPushSubscribeFailure({
      kind: "vapid_unavailable",
      error: Object.assign(new Error("Registration failed - push service error, and then some more words"), { name: longName }),
      permission: "granted",
      endpoint: null,
      now: 0,
    }),
    browser: "chromium",
    appVersion: longVersion,
    streak: 12345,
  };
  const detail = pushSubscribeFailureDetail(failure);
  assert.ok(detail.length <= 120, `${detail.length}: ${detail}`);
  const fields = Object.fromEntries(detail.split(";").map((part) => part.split("=") as [string, string]));
  assert.equal(fields.browser, "chromium");
  assert.equal(fields.kind, "vapid_unavailable");
  assert.equal(fields.n, "12345");
  assert.equal(fields.v, longVersion.slice(0, 24));
  assert.equal(fields.name, longName.slice(0, 40));
  // Nothing left for msg here: it goes before anything else does.
  assert.equal(fields.msg, undefined);
  assert.equal(detail.length, 120);

  // With an ordinary name, msg takes what is left, shortened rather than dropped.
  const ordinary = pushSubscribeFailureDetail({ ...failure, errorName: "AbortError", streak: 3 });
  assert.ok(ordinary.length <= 120, ordinary);
  const ordinaryFields = Object.fromEntries(ordinary.split(";").map((part) => part.split("=") as [string, string]));
  assert.equal(ordinaryFields.n, "3");
  assert.equal(ordinaryFields.v, longVersion.slice(0, 24));
  assert.ok(ordinaryFields.msg, ordinary);
  assert.ok(failure.errorMessage.startsWith(ordinaryFields.msg) && ordinaryFields.msg.length < failure.errorMessage.length, ordinary);
});

test("a failure event without a failure record of its own still has a detail", () => {
  assert.match(subscriptionFailedDetail(null, "denied"), /^browser=edge;kind=no_failure_record;result=denied;v=/);
});

test("Enable records this attempt's failure even when another tab cleared the record meanwhile", async () => {
  const events = installPushEnvironment(async () => { throw SUBSCRIBE_ERROR(); });
  // Another tab's successful subscribe clears the shared record right after this tab wrote it.
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function patched(this: Storage, key: string, value: string) {
    setItem.call(this, key, value);
    if (key.startsWith(WEB_PUSH_SUBSCRIBE_FAILURE_KEY_PREFIX)) this.removeItem(key);
  };
  try {
    assert.equal(await quietly(() => enablePushAndRecord("test_trigger")), "error");
  } finally {
    Storage.prototype.setItem = setItem;
  }
  await Promise.resolve();
  const failed = events.find((event) => event.event === "web_push_subscription_failed");
  assert.ok(failed, "a failure event");
  assert.match(String(failed.detail), /^browser=edge;kind=push_subscribe;n=1;v=.+;name=AbortError;/);
});

test("two tabs' automatic attempts at once: one subscribe, one failure in the streak (Web Locks)", async () => {
  let subscribeCalls = 0;
  const pendingSubscribes: Array<() => void> = [];
  const events = installPushEnvironment(() => {
    subscribeCalls += 1;
    return new Promise((_resolve, reject) => { pendingSubscribes.push(() => reject(SUBSCRIBE_ERROR())); });
  });
  const requested = installLocks();
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  await quietly(async () => {
    const first = autoResubscribeAndRecord("auto");
    // The first tab reaches pushManager.subscribe holding the lock; then the second tab's focus.
    for (let i = 0; i < 20 && pendingSubscribes.length === 0; i += 1) await tick();
    assert.equal(pendingSubscribes.length, 1, "the first attempt is subscribing");
    const second = autoResubscribeAndRecord("auto");
    for (let i = 0; i < 20; i += 1) await tick();
    for (const reject of pendingSubscribes) reject();
    await Promise.all([first, second]);
  });
  await Promise.resolve();
  assert.deepEqual(requested, [WEB_PUSH_AUTO_RESUBSCRIBE_LOCK, WEB_PUSH_AUTO_RESUBSCRIBE_LOCK]);
  assert.equal(subscribeCalls, 1);
  assert.equal(readPushSubscribeFailure()?.streak, 1);
  assert.equal(events.filter((event) => event.event === "web_push_subscription_failed").length, 1);
  // The guard is checked inside the lock: right after, nobody tries again.
  await quietly(() => autoResubscribeAndRecord("auto"));
  assert.equal(subscribeCalls, 1);
});

test("without Web Locks the automatic attempt runs as before", async () => {
  let subscribeCalls = 0;
  const events = installPushEnvironment(async () => { subscribeCalls += 1; throw SUBSCRIBE_ERROR(); });
  Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
  await quietly(() => autoResubscribeAndRecord("auto"));
  await Promise.resolve();
  assert.equal(subscribeCalls, 1);
  assert.equal(readPushSubscribeFailure()?.streak, 1);
  const failed = events.find((event) => event.event === "web_push_subscription_failed");
  assert.match(String(failed?.detail), /^browser=edge;kind=push_subscribe;n=1;v=/);
});
