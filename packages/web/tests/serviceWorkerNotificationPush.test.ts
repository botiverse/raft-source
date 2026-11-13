import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

// public/sw.js run in a VM: the push envelope render, the test-notification
// ack message, retraction and pushsubscriptionchange
// (docs/contracts/notifications.md §3.2, §4.4, §5, §6).

const origin = "https://app.raft.build";

type Shown = { title: string; options: Record<string, any> };

interface WorkerHarness {
  handlers: Map<string, (event: any) => void>;
  shown: Shown[];
  posted: unknown[];
  cacheStore: Map<string, string>;
  subscribeCalls: unknown[];
  notifications: Array<{ data: any; closed: boolean; close: () => void }>;
  notificationFilters: unknown[];
}

function loadWorker(options: {
  clients?: Array<{ url: string; focused?: boolean; visibilityState?: string }>;
  showNotificationFails?: boolean;
  subscribeResult?: { endpoint: string } | null;
} = {}): WorkerHarness {
  const source = readFileSync(resolve(process.cwd(), "public/sw.js"), "utf8");
  const harness: WorkerHarness = {
    handlers: new Map(),
    shown: [],
    posted: [],
    cacheStore: new Map(),
    subscribeCalls: [],
    notifications: [],
    notificationFilters: [],
  };
  const clients = (options.clients ?? [{ url: `${origin}/s/dev/channel/random` }]).map((client) => ({
    ...client,
    postMessage: (message: unknown) => harness.posted.push(JSON.parse(JSON.stringify(message))),
    focus: async () => {},
  }));
  const serviceWorkerGlobal = {
    location: new URL(origin),
    addEventListener(type: string, handler: (event: any) => void) {
      harness.handlers.set(type, handler);
    },
    skipWaiting: () => Promise.resolve(),
    clients: {
      claim: () => Promise.resolve(),
      matchAll: () => Promise.resolve(clients),
      openWindow: async () => {},
    },
    registration: {
      showNotification: async (title: string, notificationOptions: Record<string, any>) => {
        if (options.showNotificationFails) throw new TypeError("No notification permission");
        harness.shown.push({ title, options: JSON.parse(JSON.stringify(notificationOptions)) });
      },
      getNotifications: async (filter?: { tag?: string }) => {
        harness.notificationFilters.push(JSON.parse(JSON.stringify(filter ?? null)));
        return harness.notifications;
      },
      pushManager: {
        subscribe: async (subscribeOptions: unknown) => {
          harness.subscribeCalls.push(subscribeOptions);
          if (options.subscribeResult === null) throw new Error("subscribe failed");
          return options.subscribeResult ?? { endpoint: "https://push.example/new" };
        },
      },
    },
  };
  vm.runInNewContext(source, {
    self: serviceWorkerGlobal,
    caches: {
      keys: async () => [],
      delete: async () => true,
      open: async (cacheName: string) => ({
        match: async (key: string) => {
          const body = harness.cacheStore.get(`${cacheName} ${key}`);
          return body === undefined ? undefined : new Response(body);
        },
        put: async (key: unknown, response: Response) => {
          if (typeof key === "string") harness.cacheStore.set(`${cacheName} ${key}`, await response.text());
        },
      }),
    },
    fetch: async () => new Response("", { status: 404 }),
    URL,
    Response,
  });
  return harness;
}

async function dispatch(harness: WorkerHarness, type: string, event: Record<string, unknown>): Promise<void> {
  const handler = harness.handlers.get(type);
  assert.ok(handler, `expected a ${type} handler`);
  let completion: Promise<unknown> | undefined;
  handler({
    ...event,
    waitUntil(promise: Promise<unknown>) {
      completion = promise;
    },
  });
  await completion;
}

function pushEvent(payload: unknown) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return { data: { text: () => text } };
}

test("the push envelope renders with tag = groupKey, renotify, silent and the retraction data", async () => {
  const worker = loadWorker();
  await dispatch(worker, "push", pushEvent({
    v: 1,
    id: "message:m1",
    title: "#general",
    body: "Ana: hi",
    tag: "srv:ch",
    groupKey: "srv:ch",
    seq: 42,
    silent: true,
    url: `${origin}/s/dev/channel/ch?msg=m1`,
  }));

  assert.equal(worker.shown.length, 1);
  const [{ title, options }] = worker.shown;
  assert.equal(title, "#general");
  assert.equal(options.body, "Ana: hi");
  assert.equal(options.tag, "srv:ch");
  assert.equal(options.renotify, true);
  assert.equal(options.silent, true);
  assert.deepEqual(options.data, {
    url: `${origin}/s/dev/channel/ch?msg=m1`,
    groupKey: "srv:ch",
    seq: 42,
    id: "message:m1",
    testId: null,
  });
  assert.deepEqual(worker.posted, [], "only a test notification tells the page");
});

test("an older payload (title, body, tag, url) still renders, and no tag falls back to slock-push without renotify", async () => {
  const worker = loadWorker();
  await dispatch(worker, "push", pushEvent({ title: "Old", body: "Body", tag: "legacy-tag", url: "/s/dev/channel/x" }));
  await dispatch(worker, "push", pushEvent({}));
  await dispatch(worker, "push", pushEvent("plain text"));

  assert.equal(worker.shown[0].options.tag, "legacy-tag");
  assert.equal(worker.shown[0].options.renotify, true);
  assert.equal(worker.shown[0].options.silent, false);
  assert.deepEqual(worker.shown[0].options.data, { url: "/s/dev/channel/x", groupKey: null, seq: null, id: null, testId: null });

  assert.equal(worker.shown[1].title, "Raft");
  assert.equal(worker.shown[1].options.body, "New activity");
  assert.equal(worker.shown[1].options.tag, "slock-push");
  assert.equal(worker.shown[1].options.renotify, undefined);
  assert.equal(worker.shown[2].options.body, "plain text");
});

test("a notification for the conversation the user is looking at is suppressed, a test notification never is", async () => {
  const url = `${origin}/s/dev/channel/general`;
  const worker = loadWorker({ clients: [{ url, focused: true }] });
  await dispatch(worker, "push", pushEvent({ title: "A", groupKey: "s:c", url }));
  assert.equal(worker.shown.length, 0);

  await dispatch(worker, "push", pushEvent({ title: "Test", groupKey: "s:c", url, testId: "t-1" }));
  assert.equal(worker.shown.length, 1);
  assert.equal(worker.shown[0].options.data.testId, "t-1");
});

test("a shown test notification posts RAFT_NOTIFICATION_SHOWN shown:true to every window", async () => {
  const worker = loadWorker({ clients: [{ url: `${origin}/s/dev` }, { url: `${origin}/settings` }] });
  await dispatch(worker, "push", pushEvent({ title: "Test", testId: "t-2", url: "/" }));
  assert.deepEqual(worker.posted, [
    { type: "RAFT_NOTIFICATION_SHOWN", testId: "t-2", shown: true },
    { type: "RAFT_NOTIFICATION_SHOWN", testId: "t-2", shown: true },
  ]);
});

test("a test notification the browser refused to show posts shown:false", async () => {
  const worker = loadWorker({ showNotificationFails: true });
  await assert.rejects(dispatch(worker, "push", pushEvent({ title: "Test", testId: "t-3", url: "/" })));
  assert.deepEqual(worker.posted, [{ type: "RAFT_NOTIFICATION_SHOWN", testId: "t-3", shown: false }]);
});

function addNotification(worker: WorkerHarness, data: Record<string, unknown>) {
  const notification = {
    data,
    closed: false,
    close() {
      notification.closed = true;
    },
  };
  worker.notifications.push(notification);
  return notification;
}

test("retract closes only the group's notifications with seq <= throughSeq", async () => {
  const worker = loadWorker();
  const old = addNotification(worker, { groupKey: "s:c", seq: 3 });
  const atEdge = addNotification(worker, { groupKey: "s:c", seq: 5 });
  const newer = addNotification(worker, { groupKey: "s:c", seq: 6 });
  const noSeq = addNotification(worker, { groupKey: "s:c", seq: null });
  const otherGroup = addNotification(worker, { groupKey: "s:other", seq: 1 });
  const legacy = addNotification(worker, { url: "/" });

  await dispatch(worker, "message", { data: { type: "RAFT_NOTIFICATION_RETRACT", groupKey: "s:c", throughSeq: 5 } });

  assert.deepEqual(
    [old, atEdge, newer, noSeq, otherGroup, legacy].map((notification) => notification.closed),
    [true, true, false, false, false, false],
  );
  assert.deepEqual(worker.notificationFilters, [{ tag: "s:c" }], "only the group's tag is listed");
});

test("retract with throughSeq null closes the whole group", async () => {
  const worker = loadWorker();
  const a = addNotification(worker, { groupKey: "s:c", seq: 3 });
  const b = addNotification(worker, { groupKey: "s:c", seq: null });
  const other = addNotification(worker, { groupKey: "s:d", seq: 1 });

  await dispatch(worker, "message", { data: { type: "RAFT_NOTIFICATION_RETRACT", groupKey: "s:c", throughSeq: null } });

  assert.deepEqual([a.closed, b.closed, other.closed], [true, true, false]);
});

test("the display-locale message still works beside the notification messages", async () => {
  const worker = loadWorker();
  await dispatch(worker, "message", { data: { type: "raft:display-locale", locale: "ja" } });
  assert.equal(worker.cacheStore.get("slock-shell-v1 /__raft/display-locale"), "ja");
});

test("pushsubscriptionchange resubscribes with the old key and leaves oldEndpoint for the page", async () => {
  const worker = loadWorker({ subscribeResult: { endpoint: "https://push.example/rotated" } });
  const applicationServerKey = new Uint8Array([1, 2, 3]).buffer;
  await dispatch(worker, "pushsubscriptionchange", {
    oldSubscription: { endpoint: "https://push.example/old", options: { applicationServerKey } },
    newSubscription: null,
  });

  assert.equal(worker.subscribeCalls.length, 1);
  const call = worker.subscribeCalls[0] as { userVisibleOnly: boolean; applicationServerKey: ArrayBuffer };
  assert.equal(call.userVisibleOnly, true);
  assert.ok(call.applicationServerKey === applicationServerKey, "the old subscription's key");

  const pending = JSON.parse(worker.cacheStore.get("raft-client-state-v1 /__raft/push-subscription-change") ?? "null");
  assert.equal(pending.oldEndpoint, "https://push.example/old");
  assert.equal(pending.endpoint, "https://push.example/rotated");
  assert.deepEqual(worker.posted, [{ type: "RAFT_PUSH_SUBSCRIPTION_CHANGED", oldEndpoint: "https://push.example/old" }]);
});

test("pushsubscriptionchange with a newSubscription from the browser does not subscribe again", async () => {
  const worker = loadWorker();
  await dispatch(worker, "pushsubscriptionchange", {
    oldSubscription: { endpoint: "https://push.example/old", options: { applicationServerKey: new Uint8Array([1]).buffer } },
    newSubscription: { endpoint: "https://push.example/given" },
  });
  assert.equal(worker.subscribeCalls.length, 0);
  const pending = JSON.parse(worker.cacheStore.get("raft-client-state-v1 /__raft/push-subscription-change") ?? "null");
  assert.equal(pending.endpoint, "https://push.example/given");
});
