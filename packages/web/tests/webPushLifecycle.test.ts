import assert from "node:assert/strict";
import "./helpers/domSetup";
import api from "../src/api/client";
import {
  disablePushNotifications,
  enablePushNotifications,
  ensurePushSubscriptionIfAllowed,
  isWebPushOptedOut,
  runWebTestNotification,
  WEB_PUSH_ENDPOINT_KEY,
  WEB_PUSH_OPT_OUT_KEY,
} from "../src/utils/pushNotifications";
import { reconcileWebPushSubscription, startWebPushLifecycle } from "../src/notifications/webPushLifecycle";
import { createNotificationShownAcker } from "../src/notifications/webPushTestAck";

// The Web Push subscription's upkeep (design §8, §9.1, §9.2): opt-out is
// respected by every automatic path, a VAPID key change resubscribes, a
// revoked permission deletes the server's copy, a rotated endpoint is reported
// with oldEndpoint.

const originalApi = { get: api.get, post: api.post, delete: api.delete };
const originalNotification = Object.getOwnPropertyDescriptor(globalThis, "Notification");
const originalWindowNotification = Object.getOwnPropertyDescriptor(window, "Notification");
const originalPushManager = Object.getOwnPropertyDescriptor(window, "PushManager");
const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");

function restoreProperty(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

// "AQ" decodes to [1].
const VAPID_KEY = "AQ";

interface FakeSubscription {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer | null };
  unsubscribed: boolean;
  toJSON: () => { endpoint: string; keys: { p256dh: string; auth: string } };
  unsubscribe: () => Promise<boolean>;
}

let permission: NotificationPermission;
let current: FakeSubscription | null;
let subscribeCount: number;
let nextEndpoint: number;
let posts: Array<{ url: string; body: any }>;
let deletes: string[];

function fakeSubscription(endpoint: string, key: number[] | null = [1]): FakeSubscription {
  const subscription: FakeSubscription = {
    endpoint,
    options: { applicationServerKey: key ? new Uint8Array(key).buffer : null },
    unsubscribed: false,
    toJSON: () => ({ endpoint, keys: { p256dh: "p", auth: "a" } }),
    unsubscribe: async () => {
      subscription.unsubscribed = true;
      if (current === subscription) current = null;
      return true;
    },
  };
  return subscription;
}

const registration = {
  update: async () => {},
  pushManager: {
    getSubscription: async () => current,
    subscribe: async (options: { applicationServerKey: Uint8Array }) => {
      subscribeCount += 1;
      nextEndpoint += 1;
      current = fakeSubscription(`https://push.example/sub-${nextEndpoint}`, [...new Uint8Array(options.applicationServerKey)]);
      return current;
    },
  },
};

beforeEach(() => {
  permission = "granted";
  current = null;
  subscribeCount = 0;
  nextEndpoint = 0;
  posts = [];
  deletes = [];
  window.localStorage.clear();
  const notification = {
    get permission() {
      return permission;
    },
    requestPermission: async () => permission,
  };
  Object.defineProperty(globalThis, "Notification", { configurable: true, value: notification });
  Object.defineProperty(window, "Notification", { configurable: true, value: notification });
  Object.defineProperty(window, "PushManager", { configurable: true, value: class PushManager {} });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      getRegistration: async () => registration,
      register: async () => registration,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
  Reflect.deleteProperty(globalThis, "caches");
  api.get = (async (url: string) => {
    if (url === "/push/vapid-key") return { data: { publicKey: VAPID_KEY } };
    throw new Error(`Unexpected GET ${url}`);
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    posts.push({ url, body });
    return { data: {} };
  }) as typeof api.post;
  api.delete = (async (url: string, config?: { data?: { endpoint?: string } }) => {
    assert.equal(url, "/push/subscribe");
    deletes.push(config?.data?.endpoint ?? "");
    return { data: {} };
  }) as typeof api.delete;
});

afterEach(() => {
  api.get = originalApi.get;
  api.post = originalApi.post;
  api.delete = originalApi.delete;
  restoreProperty(globalThis, "Notification", originalNotification);
  restoreProperty(window, "Notification", originalWindowNotification);
  restoreProperty(window, "PushManager", originalPushManager);
  restoreProperty(navigator, "serviceWorker", originalServiceWorker);
  restoreProperty(globalThis, "caches", originalCaches);
  window.localStorage.clear();
});

const subscribePosts = () => posts.filter((post) => post.url === "/push/subscribe");

test("disable writes the opt-out first, unsubscribes and deletes; a later focus does not subscribe again", async () => {
  current = fakeSubscription("https://push.example/on");
  window.localStorage.setItem(WEB_PUSH_ENDPOINT_KEY, "https://push.example/on");
  let optOutWhenUnsubscribing: string | null = null;
  const unsubscribe = current.unsubscribe;
  current.unsubscribe = async () => {
    optOutWhenUnsubscribing = window.localStorage.getItem(WEB_PUSH_OPT_OUT_KEY);
    return unsubscribe();
  };

  assert.equal(await disablePushNotifications(), true);
  assert.equal(optOutWhenUnsubscribing, "1");
  assert.equal(isWebPushOptedOut(), true);
  assert.deepEqual(deletes, ["https://push.example/on"]);
  assert.equal(window.localStorage.getItem(WEB_PUSH_ENDPOINT_KEY), null);

  const stop = startWebPushLifecycle();
  try {
    window.dispatchEvent(new window.Event("focus"));
    await reconcileWebPushSubscription("focus");
    assert.equal(await ensurePushSubscriptionIfAllowed(), "opted_out");
  } finally {
    stop();
  }
  assert.equal(subscribeCount, 0);
  assert.deepEqual(subscribePosts(), []);
});

test("an explicit Enable clears the opt-out and subscribes", async () => {
  window.localStorage.setItem(WEB_PUSH_OPT_OUT_KEY, "1");
  assert.equal(await enablePushNotifications(), "granted");
  assert.equal(isWebPushOptedOut(), false);
  assert.equal(subscribeCount, 1);
  assert.equal(subscribePosts()[0].body.endpoint, "https://push.example/sub-1");
  assert.equal(window.localStorage.getItem(WEB_PUSH_ENDPOINT_KEY), "https://push.example/sub-1");
});

test("enable replaces an existing subscription made with another VAPID key", async () => {
  const stale = fakeSubscription("https://push.example/stale", [9, 9]);
  current = stale;
  assert.equal(await enablePushNotifications(), "granted");
  assert.equal(stale.unsubscribed, true);
  assert.equal(subscribeCount, 1);
  assert.deepEqual(subscribePosts().map((post) => post.body), [
    { endpoint: "https://push.example/sub-1", keys: { p256dh: "p", auth: "a" }, oldEndpoint: "https://push.example/stale" },
  ]);
});

test("enable keeps a subscription made with the current key", async () => {
  current = fakeSubscription("https://push.example/good", [1]);
  window.localStorage.setItem(WEB_PUSH_ENDPOINT_KEY, "https://push.example/good");
  assert.equal(await enablePushNotifications(), "granted");
  assert.equal(subscribeCount, 0);
  assert.deepEqual(subscribePosts().map((post) => post.body), [
    { endpoint: "https://push.example/good", keys: { p256dh: "p", auth: "a" } },
  ]);
});

test("at start, a VAPID key mismatch unsubscribes, subscribes again and reports the old endpoint", async () => {
  const stale = fakeSubscription("https://push.example/stale", [7]);
  current = stale;
  window.localStorage.setItem(WEB_PUSH_ENDPOINT_KEY, "https://push.example/stale");

  assert.equal(await reconcileWebPushSubscription("start"), "resubscribed");
  assert.equal(stale.unsubscribed, true);
  assert.equal(subscribeCount, 1);
  assert.equal(subscribePosts().length, 1);
  assert.equal(subscribePosts()[0].body.endpoint, "https://push.example/sub-1");
  assert.equal(subscribePosts()[0].body.oldEndpoint, "https://push.example/stale");
  assert.equal(window.localStorage.getItem(WEB_PUSH_ENDPOINT_KEY), "https://push.example/sub-1");
});

test("a VAPID mismatch while opted out only unsubscribes and deletes", async () => {
  current = fakeSubscription("https://push.example/stale", [7]);
  window.localStorage.setItem(WEB_PUSH_OPT_OUT_KEY, "1");
  assert.equal(await reconcileWebPushSubscription("start"), "opted_out");
  assert.equal(subscribeCount, 0);
  assert.equal(current, null);
  assert.deepEqual(deletes, ["https://push.example/stale"]);
  assert.deepEqual(subscribePosts(), []);
});

test("permission revoked in the browser: the subscription is deleted on the server and forgotten", async () => {
  permission = "denied";
  current = fakeSubscription("https://push.example/on");
  window.localStorage.setItem(WEB_PUSH_ENDPOINT_KEY, "https://push.example/on");
  assert.equal(await reconcileWebPushSubscription("focus"), "revoked");
  assert.deepEqual(deletes, ["https://push.example/on"]);
  assert.equal(window.localStorage.getItem(WEB_PUSH_ENDPOINT_KEY), null);

  // The browser already dropped the subscription: the remembered endpoint is deleted.
  deletes = [];
  permission = "default";
  current = null;
  window.localStorage.setItem(WEB_PUSH_ENDPOINT_KEY, "https://push.example/gone");
  assert.equal(await reconcileWebPushSubscription("visible"), "revoked");
  assert.deepEqual(deletes, ["https://push.example/gone"]);

  // Nothing known: nothing to do.
  deletes = [];
  assert.equal(await reconcileWebPushSubscription("visible"), "nothing");
  assert.deepEqual(deletes, []);
});

test("the lifecycle checks the permission on window focus and when the page becomes visible", async () => {
  const stop = startWebPushLifecycle();
  try {
    await reconcileWebPushSubscription("start");
    permission = "denied";
    window.localStorage.setItem(WEB_PUSH_ENDPOINT_KEY, "https://push.example/a");
    window.dispatchEvent(new window.Event("focus"));
    await reconcileWebPushSubscription("focus");
    assert.deepEqual(deletes, ["https://push.example/a"]);
  } finally {
    stop();
  }
});

test("a rotated endpoint is reported with the remembered one as oldEndpoint", async () => {
  current = fakeSubscription("https://push.example/new");
  window.localStorage.setItem(WEB_PUSH_ENDPOINT_KEY, "https://push.example/old");
  assert.equal(await reconcileWebPushSubscription("focus"), "reported");
  assert.deepEqual(subscribePosts().map((post) => post.body), [
    { endpoint: "https://push.example/new", keys: { p256dh: "p", auth: "a" }, oldEndpoint: "https://push.example/old" },
  ]);
  assert.equal(await reconcileWebPushSubscription("focus"), "in_sync");
  assert.equal(subscribePosts().length, 1);
});

test("the worker's pushsubscriptionchange record is reported and then cleared", async () => {
  const store = new Map<string, string>([[
    "raft-client-state-v1 /__raft/push-subscription-change",
    JSON.stringify({ oldEndpoint: "https://push.example/before-change", endpoint: "https://push.example/new" }),
  ]]);
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      open: async (name: string) => ({
        match: async (key: string) => {
          const body = store.get(`${name} ${key}`);
          return body === undefined ? undefined : new Response(body);
        },
        delete: async (key: string) => store.delete(`${name} ${key}`),
      }),
    },
  });
  current = fakeSubscription("https://push.example/new");
  window.localStorage.setItem(WEB_PUSH_ENDPOINT_KEY, "https://push.example/new");

  assert.equal(await reconcileWebPushSubscription("subscription_changed"), "reported");
  assert.equal(subscribePosts()[0].body.oldEndpoint, "https://push.example/before-change");
  assert.equal(store.size, 0);
});

test("a subscription the push service dropped is made again when it had been on, never when it was not", async () => {
  assert.equal(await reconcileWebPushSubscription("start"), "nothing");
  assert.equal(subscribeCount, 0);

  window.localStorage.setItem(WEB_PUSH_ENDPOINT_KEY, "https://push.example/dropped");
  assert.equal(await reconcileWebPushSubscription("start"), "resubscribed");
  assert.equal(subscribeCount, 1);
  assert.equal(subscribePosts()[0].body.oldEndpoint, "https://push.example/dropped");
});

test("the test notification needs a subscription, and the shown ack is sent once per test id", async () => {
  assert.deepEqual(await runWebTestNotification(), { state: "failed", reason: "not_subscribed" });

  const acks: Array<[string, boolean]> = [];
  const ackOnce = createNotificationShownAcker((testId, shown) => acks.push([testId, shown]));
  assert.equal(ackOnce({ type: "RAFT_NOTIFICATION_SHOWN", testId: "t1", shown: true }), true);
  assert.equal(ackOnce({ type: "RAFT_NOTIFICATION_SHOWN", testId: "t1", shown: true }), false);
  assert.equal(ackOnce({ type: "RAFT_NOTIFICATION_SHOWN", testId: "t2", shown: false }), true);
  assert.equal(ackOnce({ type: "OTHER", testId: "t3", shown: true }), false);
  assert.equal(ackOnce({ type: "RAFT_NOTIFICATION_SHOWN", testId: "t4" }), false);
  assert.deepEqual(acks, [["t1", true], ["t2", false]]);
});
