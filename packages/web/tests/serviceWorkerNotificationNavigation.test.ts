import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { serviceWorkerNavigationPath } from "../src/components/pwa/ServiceWorkerNavigationBridge";

const origin = "https://app.raft.build";

type MockWindowClient = {
  url: string;
  postMessage: (message: unknown) => void;
  focus: () => Promise<void>;
};

function loadNotificationClickHandler(clients: MockWindowClient[], openedUrls: string[]) {
  const source = readFileSync(resolve(process.cwd(), "public/sw.js"), "utf8");
  const handlers = new Map<string, (event: any) => void>();
  const serviceWorkerGlobal = {
    location: new URL(origin),
    addEventListener(type: string, handler: (event: any) => void) {
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
      open: async () => ({
        match: async () => undefined,
        put: async () => undefined,
      }),
    },
    fetch: async () => new Response("", { status: 404 }),
    URL,
    Response,
  });

  const handler = handlers.get("notificationclick");
  assert.ok(handler, "expected service worker notificationclick handler");
  return handler;
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

test("notification click opens a new tab instead of replacing an unrelated Raft tab", async () => {
  const targetUrl = "/s/dev/channel/general?msg=message-target";
  const activity: string[] = [];
  const openedUrls: string[] = [];
  const handler = loadNotificationClickHandler(
    [
      {
        url: `${origin}/s/dev/channel/random`,
        postMessage: () => activity.push("message:other-channel"),
        focus: async () => {
          activity.push("focus:other-channel");
        },
      },
      {
        url: `${origin}/s/dev/channel/general?thread=thread-other`,
        postMessage: () => activity.push("message:other-thread"),
        focus: async () => {
          activity.push("focus:other-thread");
        },
      },
    ],
    openedUrls,
  );

  await clickNotification(handler, targetUrl);

  assert.deepEqual(activity, []);
  assert.deepEqual(openedUrls, [targetUrl]);
});

test("service worker treats HTML returned for built asset URLs as a 404 and does not cache it", async () => {
  const source = readFileSync(resolve(process.cwd(), "public/sw.js"), "utf8");
  const handlers = new Map<string, (event: any) => void>();
  const cachedResponses = new Map<string, Response>();
  let networkResponse = new Response("", { status: 500 });

  const serviceWorkerGlobal = {
    location: new URL(origin),
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
