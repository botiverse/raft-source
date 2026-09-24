import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "vitest";
import { ProxyAgent } from "undici";
import { createProviderHttpClient, daemonFetch, withDaemonFetchProxy } from "./daemonFetch.js";
import {
  buildIsolatedFetchDispatcher,
  evictIsolatedFetchDispatcher,
} from "./proxy.js";

test("daemonFetch accepts a native Request without passing the Request object to undici", async () => {
  const seen: { method?: string; testHeader?: string; body: string } = { body: "" };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.method = req.method;
      const header = req.headers["x-test"];
      seen.testHeader = Array.isArray(header) ? header[0] : header;
      seen.body = Buffer.concat(chunks).toString("utf8");
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const response = await daemonFetch(
      new Request(`http://127.0.0.1:${port}/native-request`, {
        method: "POST",
        headers: { "x-test": "from-request" },
        body: "hello-request",
      }),
      undefined,
      { NO_PROXY: "127.0.0.1" },
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
    assert.equal(seen.method, "POST");
    assert.equal(seen.testHeader, "from-request");
    assert.equal(seen.body, "hello-request");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("daemonFetch Request init.headers replace original Request headers", async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(String(req.headers.authorization ?? ""));
    seen.push(String(req.headers["x-keep"] ?? ""));
    seen.push(String(req.headers["x-new"] ?? ""));
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const response = await daemonFetch(
      new Request(`http://127.0.0.1:${port}/replace-headers`, {
        headers: { Authorization: "Bearer old", "x-keep": "old-keep" },
      }),
      { headers: { "x-new": "only-new" } },
      { NO_PROXY: "127.0.0.1" },
    );
    assert.equal(response.status, 200);
    assert.equal(seen[0], "");
    assert.equal(seen[1], "");
    assert.equal(seen[2], "only-new");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("daemonFetch rejects POST Request overridden to GET with a body", async () => {
  await assert.rejects(
    () => daemonFetch(
      new Request("http://127.0.0.1:1/get-with-body", { method: "POST", body: "nope" }),
      { method: "GET" },
      { NO_PROXY: "127.0.0.1" },
    ),
    /body/i,
  );
});

test("daemonFetch passes URL plus ReadableStream body with duplex half through to undici", async () => {
  const seen = { body: "" };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.body = Buffer.concat(chunks).toString("utf8");
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk-a"));
        controller.close();
      },
    });
    const response = await daemonFetch(
      `http://127.0.0.1:${port}/stream-upload`,
      { method: "POST", body: stream, duplex: "half" },
      { NO_PROXY: "127.0.0.1" },
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
    assert.equal(seen.body, "chunk-a");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("daemonFetch accepts Request plus stream body with duplex half", async () => {
  const seen = { body: "" };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.body = Buffer.concat(chunks).toString("utf8");
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk-req"));
        controller.close();
      },
    });
    const response = await daemonFetch(
      new Request(`http://127.0.0.1:${port}/request-stream`, { method: "POST" }),
      { body: stream, duplex: "half" },
      { NO_PROXY: "127.0.0.1" },
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
    assert.equal(seen.body, "chunk-req");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("daemonFetch uses package undici.fetch, not globalThis.fetch", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const originalFetch = globalThis.fetch;
  let globalFetchCalls = 0;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    globalFetchCalls += 1;
    return originalFetch(...args);
  }) as typeof fetch;

  try {
    const response = await daemonFetch(`http://127.0.0.1:${port}/same-undici`, { method: "GET" }, {
      NO_PROXY: "127.0.0.1",
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
    assert.equal(globalFetchCalls, 0, "Node 26 global fetch + undici 7 dispatcher drops Content-Encoding");
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("withDaemonFetchProxy attaches an undici proxy dispatcher from HTTPS_PROXY", () => {
  const init = withDaemonFetchProxy("https://api.slock.ai/internal/computer/runners/agent-1/credentials", {
    method: "POST",
  }, {
    HTTPS_PROXY: "http://proxy.internal:8080",
  });

  assert.equal(init.method, "POST");
  assert.ok(init.dispatcher instanceof ProxyAgent);
});

test("withDaemonFetchProxy honors NO_PROXY bypasses", () => {
  const init = withDaemonFetchProxy("https://api.corp.internal/internal/computer/runners/agent-1/credentials", {
    method: "POST",
  }, {
    HTTPS_PROXY: "http://proxy.internal:8080",
    NO_PROXY: ".internal",
  });

  assert.equal(init.method, "POST");
  assert.equal(init.dispatcher, undefined);
});

test("provider HTTP clients own and dispose their isolated dispatcher pools", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const targetUrl = `http://127.0.0.1:${port}/provider`;
  const isolationKey = "pi-provider-dispose-test";
  const env = { NO_PROXY: "127.0.0.1" };
  const client = createProviderHttpClient(env, isolationKey);

  try {
    const response = await client.fetch(targetUrl);
    assert.equal(await response.text(), "ok");
    const ownedPool = buildIsolatedFetchDispatcher(
      targetUrl,
      isolationKey,
      env,
      undefined,
      0,
    );

    client.dispose();

    const rebuiltPool = buildIsolatedFetchDispatcher(
      targetUrl,
      isolationKey,
      env,
      undefined,
      0,
    );
    assert.notEqual(rebuiltPool, ownedPool, "dispose must release the session-owned pool");
    await assert.rejects(client.fetch(targetUrl), /client is disposed/u);
  } finally {
    client.dispose();
    evictIsolatedFetchDispatcher(targetUrl, isolationKey, env, undefined, 0);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
