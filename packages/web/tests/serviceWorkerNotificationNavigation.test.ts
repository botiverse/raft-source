import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { serviceWorkerNavigationPath } from "../src/notifications/webPushServiceWorkerMessages";

const origin = "https://app.raft.build";

type MockWindowClient = {
  id?: string;
  url: string;
  focused?: boolean;
  postMessage: (message: unknown) => void;
  focus: () => Promise<void>;
};

function loadNotificationClickHandler(clients: MockWindowClient[], openedUrls: string[]) {
  return loadServiceWorkerHandlers(clients, openedUrls).click;
}

function loadServiceWorkerHandlers(clients: MockWindowClient[], openedUrls: string[], cacheStore = new Map<string, string>()) {
  const source = readFileSync(resolve(process.cwd(), "public/sw.js"), "utf8");
  const handlers = new Map<string, (event: any) => void>();
  const serviceWorkerGlobal = {
    location: new URL(origin),
    addEventListener(type: string, handler: (event: any) => void) {
      assert.ok(!handlers.has(type), `one ${type} listener`);
      handlers.set(type, handler);
    },
    skipWaiting: () => Promise.resolve(),
    clients: {
      claim: () => Promise.resolve(),
      matchAll: () => Promise.resolve(clients),
      openWindow: async (url: string) => {
        openedUrls.push(url);
      },
    },
    registration: {
      showNotification: () => Promise.resolve(),
    },
  };

  vm.runInNewContext(source, {
    self: serviceWorkerGlobal,
    caches: {
      keys: async () => [],
      delete: async () => true,
      open: async (cacheName: string) => ({
        match: async (key: string) => {
          const body = cacheStore.get(`${cacheName} ${key}`);
          return body === undefined ? undefined : new Response(body);
        },
        put: async (key: unknown, response: Response) => {
          if (typeof key === "string") cacheStore.set(`${cacheName} ${key}`, await response.text());
        },
      }),
    },
    fetch: async () => new Response("", { status: 404 }),
    URL,
    Response,
  });

  const click = handlers.get("notificationclick");
  assert.ok(click, "expected service worker notificationclick handler");
  const message = handlers.get("message");
  assert.ok(message, "expected service worker message handler");
  /** A window telling the worker how it is displayed, as the page bridge does. */
  const announceDisplayMode = async (source: MockWindowClient, standalone: boolean) => {
    let completion: Promise<void> | undefined;
    message({
      data: { type: "RAFT_CLIENT_DISPLAY_MODE", standalone },
      source,
      waitUntil(promise: Promise<void>) {
        completion = promise;
      },
    });
    await completion;
  };
  return { click, announceDisplayMode };
}

async function clickNotification(handler: (event: any) => void, targetUrl: string) {
  let completion: Promise<void> | undefined;
  let closed = false;
  handler({
    notification: {
      data: { url: targetUrl },
      close() {
        closed = true;
      },
    },
    waitUntil(promise: Promise<void>) {
      completion = promise;
    },
  });
  assert.ok(completion, "expected notification click work to be registered");
  await completion;
  assert.equal(closed, true);
}

test("serviceWorkerNavigationPath accepts same-origin push notification navigation", () => {
  assert.equal(
    serviceWorkerNavigationPath(
      {
        type: "RAFT_PUSH_NOTIFICATION_NAVIGATE",
        url: "https://app.raft.build/s/dev/channel/general?msg=1#reply",
      },
      origin,
    ),
    "/s/dev/channel/general?msg=1#reply",
  );

  assert.equal(
    serviceWorkerNavigationPath(
      {
        type: "RAFT_PUSH_NOTIFICATION_NAVIGATE",
        url: "/s/dev/dm/dm-1?thread=dm-1%3Aparent",
      },
      origin,
    ),
    "/s/dev/dm/dm-1?thread=dm-1%3Aparent",
  );
});

test("serviceWorkerNavigationPath rejects non-navigation and cross-origin messages", () => {
  assert.equal(serviceWorkerNavigationPath(null, origin), null);
  assert.equal(serviceWorkerNavigationPath({ type: "OTHER", url: "/s/dev" }, origin), null);
  assert.equal(
    serviceWorkerNavigationPath(
      { type: "RAFT_PUSH_NOTIFICATION_NAVIGATE", url: "https://evil.example/s/dev" },
      origin,
    ),
    null,
  );
  assert.equal(serviceWorkerNavigationPath({ type: "RAFT_PUSH_NOTIFICATION_NAVIGATE", url: 42 }, origin), null);
});

test("notification click focuses the tab already showing the exact thread", async () => {
  const targetUrl = "/s/dev/channel/general?thread=thread-target&msg=message-new";
  const activity: Array<{ client: string; action: string; value?: unknown }> = [];
  const openedUrls: string[] = [];
  const makeClient = (client: string, url: string): MockWindowClient => ({
    url,
    postMessage(message) {
      activity.push({ client, action: "message", value: JSON.parse(JSON.stringify(message)) });
    },
    async focus() {
      activity.push({ client, action: "focus" });
    },
  });
  const handler = loadNotificationClickHandler(
    [
      makeClient("other-channel", `${origin}/s/dev/channel/random`),
      makeClient("other-thread", `${origin}/s/dev/channel/general?thread=thread-other`),
      makeClient("target-thread", `${origin}/s/dev/channel/general?thread=thread-target&msg=message-old`),
    ],
    openedUrls,
  );

  await clickNotification(handler, targetUrl);

  assert.deepEqual(activity, [
    {
      client: "target-thread",
      action: "message",
      value: { type: "RAFT_PUSH_NOTIFICATION_NAVIGATE", url: targetUrl },
    },
    { client: "target-thread", action: "focus" },
  ]);
  assert.deepEqual(openedUrls, []);
});

function recordingTab(activity: unknown[], id: string, url: string, extra: Partial<MockWindowClient> = {}): MockWindowClient {
  return {
    id,
    url,
    // Copied out of the worker's VM realm so it compares as a plain object.
    postMessage: (message) => activity.push({ to: id, message: JSON.parse(JSON.stringify(message)) }),
    focus: async () => {
      activity.push(`focus:${id}`);
    },
    ...extra,
  };
}

function navigatedTo(activity: unknown[], id: string, url: string) {
  assert.deepEqual(activity, [
    { to: id, message: { type: "RAFT_PUSH_NOTIFICATION_NAVIGATE", url } },
    `focus:${id}`,
  ]);
}

// Was #6624's "opens a new tab instead of replacing an unrelated Raft tab": a
// Raft tab is not unrelated to a Raft notification, and in-app routing keeps
// its state, so the tab is reused and routed (no reload, no second tab).
test("notification click reuses a Raft tab on the target's server and routes it in-app", async () => {
  const targetUrl = "/s/dev/channel/general?msg=message-target";
  const activity: unknown[] = [];
  const openedUrls: string[] = [];
  const handler = loadNotificationClickHandler(
    [
      recordingTab(activity, "other-channel", `${origin}/s/dev/channel/random`),
      recordingTab(activity, "other-thread", `${origin}/s/dev/channel/general?thread=thread-other`),
    ],
    openedUrls,
  );

  await clickNotification(handler, targetUrl);

  navigatedTo(activity, "other-channel", targetUrl);
  assert.deepEqual(openedUrls, []);
});

test("notification click prefers a tab on the target's server over a focused tab on another server", async () => {
  const targetUrl = `${origin}/s/dev/dm/dm-1?msg=m1`;
  const activity: unknown[] = [];
  const openedUrls: string[] = [];
  const handler = loadNotificationClickHandler(
    [
      recordingTab(activity, "other-server", `${origin}/s/acme/channel/general`, { focused: true }),
      recordingTab(activity, "settings-elsewhere", `${origin}/settings/notifications`),
      recordingTab(activity, "same-server", `${origin}/s/dev/agent/a1`),
      recordingTab(activity, "same-server-focused", `${origin}/s/dev/channel/random`, { focused: true }),
    ],
    openedUrls,
  );

  await clickNotification(handler, targetUrl);

  // Among the target server's tabs, the focused one.
  navigatedTo(activity, "same-server-focused", targetUrl);
  assert.deepEqual(openedUrls, []);
});

test("notification click falls back to any Raft tab, focused first, and never to a non-app page", async () => {
  const targetUrl = "/s/dev/channel/general?msg=m1";
  const activity: unknown[] = [];
  const openedUrls: string[] = [];
  const handler = loadNotificationClickHandler(
    [
      recordingTab(activity, "api-page", `${origin}/api/health`, { focused: true }),
      recordingTab(activity, "file", `${origin}/robots.txt`, { focused: true }),
      recordingTab(activity, "other-server", `${origin}/s/acme/channel/general`),
      recordingTab(activity, "home-focused", `${origin}/`, { focused: true }),
    ],
    openedUrls,
  );

  await clickNotification(handler, targetUrl);

  navigatedTo(activity, "home-focused", targetUrl);
  assert.deepEqual(openedUrls, []);
});

test("notification click opens a window only when no Raft window exists", async () => {
  const targetUrl = "/s/dev/channel/general?msg=m1";
  const activity: unknown[] = [];
  const openedUrls: string[] = [];
  const handler = loadNotificationClickHandler(
    [
      recordingTab(activity, "api-page", `${origin}/api/health`),
      recordingTab(activity, "cross-origin", "https://elsewhere.example/s/dev/channel/general"),
    ],
    openedUrls,
  );
  await clickNotification(handler, targetUrl);
  assert.deepEqual(activity, []);
  assert.deepEqual(openedUrls, [targetUrl]);

  await clickNotification(loadNotificationClickHandler([], openedUrls), targetUrl);
  assert.deepEqual(openedUrls, [targetUrl, targetUrl]);
});

test("notification click brings the installed app window to the target instead of opening a second window", async () => {
  const targetUrl = "/s/dev/channel/general?msg=message-target";
  const activity: unknown[] = [];
  const openedUrls: string[] = [];
  const browserTab: MockWindowClient = {
    id: "browser-tab",
    url: `${origin}/s/dev/channel/random`,
    focused: true,
    postMessage: () => activity.push("message:browser-tab"),
    focus: async () => {
      activity.push("focus:browser-tab");
    },
  };
  const appWindow: MockWindowClient = {
    id: "app-window",
    url: `${origin}/s/dev/channel/other`,
    // Copied out of the worker's VM realm so it compares as a plain object.
    postMessage: (message) => activity.push(JSON.parse(JSON.stringify(message))),
    focus: async () => {
      activity.push("focus:app-window");
    },
  };
  const cacheStore = new Map<string, string>();
  const first = loadServiceWorkerHandlers([browserTab, appWindow], openedUrls, cacheStore);
  await first.announceDisplayMode(browserTab, false);
  await first.announceDisplayMode(appWindow, true);

  // The click is handled by a freshly started worker: only the cache carries over.
  const restarted = loadServiceWorkerHandlers([browserTab, appWindow], openedUrls, cacheStore);
  await clickNotification(restarted.click, targetUrl);

  assert.deepEqual(activity, [
    { type: "RAFT_PUSH_NOTIFICATION_NAVIGATE", url: targetUrl },
    "focus:app-window",
  ]);
  assert.deepEqual(openedUrls, []);
});

test("a closed or no-longer-standalone app window is not preferred", async () => {
  const targetUrl = "/s/dev/channel/general";
  const openedUrls: string[] = [];
  const cacheStore = new Map<string, string>();

  // The app window announced itself, then was closed: two browser tabs are
  // left and the focused one wins, as with no app window at all.
  let activity: unknown[] = [];
  const closedApp = recordingTab(activity, "closed-app", `${origin}/s/dev/channel/random`);
  await loadServiceWorkerHandlers([closedApp], openedUrls, cacheStore).announceDisplayMode(closedApp, true);
  await clickNotification(
    loadServiceWorkerHandlers(
      [
        recordingTab(activity, "browser-tab", `${origin}/s/dev/channel/random`),
        recordingTab(activity, "focused-tab", `${origin}/s/dev/channel/other`, { focused: true }),
      ],
      openedUrls,
      cacheStore,
    ).click,
    targetUrl,
  );
  navigatedTo(activity, "focused-tab", targetUrl);

  // A window that announced standalone and later announced it is an ordinary
  // tab: listed first, it still loses to the focused tab.
  activity = [];
  const demoted = recordingTab(activity, "demoted", `${origin}/s/dev/channel/random`);
  const focusedTab = recordingTab(activity, "focused-tab", `${origin}/s/dev/channel/other`, { focused: true });
  const worker = loadServiceWorkerHandlers([demoted, focusedTab], openedUrls, cacheStore);
  await worker.announceDisplayMode(demoted, true);
  await worker.announceDisplayMode(demoted, false);
  await clickNotification(worker.click, targetUrl);
  navigatedTo(activity, "focused-tab", targetUrl);

  assert.deepEqual(openedUrls, []);
});

test("offline, the service worker treats HTML returned for built asset URLs as a 404 and does not cache it", async () => {
  const source = readFileSync(resolve(process.cwd(), "public/sw.js"), "utf8");
  const handlers = new Map<string, (event: any) => void>();
  const cachedResponses = new Map<string, Response>();
  let networkResponse = new Response("", { status: 500 });

  const serviceWorkerGlobal = {
    location: new URL(origin),
    // Offline the worker answers build assets itself (online they go to the HTTP cache).
    navigator: { onLine: false },
    addEventListener(type: string, handler: (event: any) => void) {
      handlers.set(type, handler);
    },
    skipWaiting: () => Promise.resolve(),
    clients: {
      claim: () => Promise.resolve(),
      matchAll: () => Promise.resolve([]),
      openWindow: () => Promise.resolve(),
    },
    registration: {
      showNotification: () => Promise.resolve(),
    },
  };

  vm.runInNewContext(source, {
    self: serviceWorkerGlobal,
    caches: {
      keys: async () => [],
      delete: async () => true,
      open: async () => ({
        match: async (request: Request) => cachedResponses.get(request.url),
        put: async (request: Request, response: Response) => {
          cachedResponses.set(request.url, response);
        },
      }),
    },
    fetch: async () => networkResponse.clone(),
    URL,
    Response,
  });

  const fetchHandler = handlers.get("fetch");
  assert.ok(fetchHandler, "expected service worker fetch handler");

  async function fetchAsset(pathname: string): Promise<Response | undefined> {
    let handled: Promise<Response> | undefined;
    fetchHandler({
      request: new Request(new URL(pathname, origin)),
      respondWith(promise: Promise<Response>) {
        handled = promise;
      },
      waitUntil() {},
    });
    return handled;
  }

  networkResponse = new Response("<!doctype html><title>Raft</title>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

  const htmlAsset = await fetchAsset("/assets/index-missing.js");
  assert.equal(htmlAsset?.status, 404);
  assert.equal(cachedResponses.size, 0, "HTML fallbacks must not be cached under asset URLs");

  networkResponse = new Response("console.log('ok')", {
    status: 200,
    headers: { "content-type": "application/javascript" },
  });

  const jsAsset = await fetchAsset("/assets/index-present.js");
  assert.equal(jsAsset?.status, 200);
  assert.equal(cachedResponses.size, 1, "real build assets should still be cached");
});
