import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

type FetchListener = (event: {
  request: Request;
  respondWith: (promise: Promise<Response>) => void;
  waitUntil: (promise: Promise<unknown>) => void;
}) => void;

function loadServiceWorker({ online, cached, networkResponse }: { online: boolean; cached?: Response; networkResponse: () => Response }) {
  const listeners = new Map<string, (...args: never[]) => void>();
  const cacheWrites: Array<{ request: Request; response: Response }> = [];
  const fetches: Array<{ url: string; init?: RequestInit }> = [];
  const cache = {
    match: async () => cached,
    put: async (request: Request, response: Response) => {
      cacheWrites.push({ request, response });
    },
  };
  const self = {
    location: { origin: "https://raft.example" },
    navigator: { onLine: online },
    addEventListener: (type: string, listener: (...args: never[]) => void) => listeners.set(type, listener),
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined, matchAll: async () => [], openWindow: async () => undefined },
    registration: { showNotification: async () => undefined },
  };
  const caches = { open: async () => cache, keys: async () => [], delete: async () => true };
  return { listeners, cacheWrites, fetches, context: {
    URL, Request, Response, self, caches, setTimeout: (fn: () => void) => { fn(); return 0; },
    fetch: async (req: Request | string, init?: RequestInit) => {
      fetches.push({ url: typeof req === "string" ? req : req.url, init });
      return networkResponse();
    },
  } };
}

async function serviceWorkerHarness(
  networkResponse: Response,
  requestPath = "/assets/app.js",
) {
  const listeners = new Map<string, (...args: never[]) => void>();
  const cacheWrites: Array<{ request: Request; response: Response }> = [];
  let fetchCalls = 0;

  const cache = {
    match: async () => undefined,
    put: async (request: Request, response: Response) => {
      cacheWrites.push({ request, response });
    },
  };
  const self = {
    location: { origin: "https://raft.example" },
    // Offline: the worker answers build assets from its cache (online it leaves them to the HTTP cache, below).
    navigator: { onLine: false },
    addEventListener: (type: string, listener: (...args: never[]) => void) => listeners.set(type, listener),
    skipWaiting: async () => undefined,
    clients: {
      claim: async () => undefined,
      matchAll: async () => [],
      openWindow: async () => undefined,
    },
    registration: { showNotification: async () => undefined },
  };
  const caches = {
    open: async () => cache,
    keys: async () => [],
    delete: async () => true,
  };
  const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  vm.runInNewContext(source, {
    URL,
    Request,
    Response,
    self,
    caches,
    fetch: async () => {
      fetchCalls += 1;
      return networkResponse;
    },
  });

  const request = new Request(`https://raft.example${requestPath}`);
  let responsePromise: Promise<Response> | undefined;
  (listeners.get("fetch") as FetchListener)({
    request,
    respondWith: (promise) => {
      responsePromise = promise;
    },
    waitUntil: () => {},
  });
  assert.ok(responsePromise, "offline, a same-origin build asset is answered by the service worker");
  const response = await responsePromise;
  await Promise.resolve();

  return { response, cacheWrites, fetchCalls };
}

test("service worker rejects an HTML fallback returned for a build asset", async () => {
  const result = await serviceWorkerHarness(new Response("<html>app shell</html>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  }));

  assert.equal(result.fetchCalls, 1);
  assert.equal(result.response.status, 404);
  assert.equal(await result.response.text(), "");
  assert.equal(result.cacheWrites.length, 0, "HTML fallback bytes must never enter the asset cache");
});

test("service worker admits a successful JavaScript asset into its cache", async () => {
  const result = await serviceWorkerHarness(new Response("export const ready = true;", {
    status: 200,
    headers: { "content-type": "application/javascript" },
  }));

  assert.equal(result.fetchCalls, 1);
  assert.equal(result.response.status, 200);
  assert.equal(await result.response.text(), "export const ready = true;");
  assert.equal(result.cacheWrites.length, 1);
  assert.equal(result.cacheWrites[0]?.request.url, "https://raft.example/assets/app.js");
  assert.equal(await result.cacheWrites[0]?.response.text(), "export const ready = true;");
});

test("service worker rejects a successful response outside the asset admission policy", async () => {
  const result = await serviceWorkerHarness(new Response("not a build asset", {
    status: 200,
    headers: { "content-type": "text/plain" },
  }), "/assets/unknown");

  assert.equal(result.fetchCalls, 1);
  assert.equal(result.response.status, 200);
  assert.equal(await result.response.text(), "not a build asset");
  assert.equal(
    result.cacheWrites.length,
    0,
    "a generic successful response must not enter the immutable asset cache",
  );
});

async function onlineFetch(cached?: Response, url = "https://raft.example/assets/app-shell-AbC123.js") {
  const sw = loadServiceWorker({
    online: true,
    cached,
    networkResponse: () => new Response("export const ready = true;", { status: 200, headers: { "content-type": "application/javascript" } }),
  });
  const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  vm.runInNewContext(source, sw.context);
  let answered = false;
  const background: Promise<unknown>[] = [];
  (sw.listeners.get("fetch") as FetchListener)({
    request: new Request(url),
    respondWith: () => { answered = true; },
    waitUntil: (promise) => { background.push(promise); },
  });
  await Promise.all(background);
  return { ...sw, answered };
}

test("online, a build asset is left to the browser's HTTP cache: the worker doesn't answer it", async () => {
  const result = await onlineFetch();
  assert.equal(result.answered, false, "no respondWith: no worker round trip, compressed bytes from the HTTP cache");
});

test("online, a build asset missing from the asset cache is added in the background, from the HTTP cache", async () => {
  const result = await onlineFetch();
  assert.equal(result.fetches.length, 1);
  assert.equal(result.fetches[0]?.init?.cache, "force-cache", "read from disk, not downloaded a second time");
  assert.equal(result.cacheWrites.length, 1, "kept for the kept HTML (usableShell) and for offline");
  assert.equal(result.cacheWrites[0]?.request.url, "https://raft.example/assets/app-shell-AbC123.js");
});

test("online, a build asset already in the asset cache is not fetched again", async () => {
  const result = await onlineFetch(new Response("cached"));
  assert.equal(result.answered, false);
  assert.equal(result.fetches.length, 0);
  assert.equal(result.cacheWrites.length, 0);
});

test("a locale catalog chunk the page loads is kept for offline, as any build file", async () => {
  // en and the other catalogs are lazy chunks the boot modulepreloads
  // (boot/bootInlineScript.ts), not files the HTML names, so the kept HTML
  // doesn't list them: the reader's own catalogs are cached here when the page
  // loads them, and an offline open runs from them.
  const result = await onlineFetch(undefined, "https://raft.example/assets/zh-cn-OMFUHzMG.js");
  assert.equal(result.answered, false);
  assert.equal(result.cacheWrites.length, 1);
  assert.equal(result.cacheWrites[0]?.request.url, "https://raft.example/assets/zh-cn-OMFUHzMG.js");
});
