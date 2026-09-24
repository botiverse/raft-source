import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

type FetchListener = (event: {
  request: Request;
  respondWith: (promise: Promise<Response>) => void;
}) => void;

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
  });
  assert.ok(responsePromise, "same-origin build asset should be handled by the service worker");
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
