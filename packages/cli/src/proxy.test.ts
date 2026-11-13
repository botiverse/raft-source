import assert from "node:assert/strict";
import http from "node:http";
import net, { type Socket } from "node:net";
import { gzipSync } from "node:zlib";

import {
  buildFetchDispatcher,
  CanonicalFetchTransportError,
  credentialFreeDiagnosticUrl,
  fetchWithCanonicalProxy,
  fetchWithDispatcher,
} from "./proxy";

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

function trackSockets(server: http.Server): Set<Socket> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return sockets;
}

test("canonical fetch reaches a proxy-only target and preserves a direct no-proxy route", async () => {
  const origin = http.createServer(async (request, response) => {
    if (request.url === "/request") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      response.writeHead(302, {
        location: "/manifest",
        "content-type": "application/json",
        connection: "close",
      });
      response.end(JSON.stringify({
        method: request.method,
        body: Buffer.concat(chunks).toString(),
        header: request.headers["x-fixture"],
      }));
      return;
    }
    response.writeHead(200, {
      "content-type": "application/json",
      "content-encoding": "gzip",
      "set-cookie": ["fixture-session=synthetic; Path=/; HttpOnly", "fixture-second=synthetic; Path=/"],
      connection: "close",
    });
    response.end(gzipSync(JSON.stringify({ ok: true })));
  });
  const originSockets = trackSockets(origin);
  const originPort = await listen(origin);

  let proxyConnects = 0;
  const proxy = http.createServer((_request, response) => {
    response.writeHead(501);
    response.end();
  });
  const proxySockets = trackSockets(proxy);
  proxy.on("connect", (_request, downstream, head) => {
    proxyConnects += 1;
    const upstream = net.connect(originPort, "127.0.0.1", () => {
      downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      downstream.pipe(upstream);
      upstream.pipe(downstream);
    });
    upstream.once("error", () => downstream.destroy());
    downstream.once("error", () => upstream.destroy());
  });
  const proxyPort = await listen(proxy);

  const proxyOnlyUrl = `http://proxy-only.invalid:${originPort}/manifest`;
  const directUrl = `http://127.0.0.1:${originPort}/manifest`;
  try {
    await assert.rejects(
      () => fetchWithCanonicalProxy(proxyOnlyUrl, {}, {}),
      (error: unknown) => {
        assert.ok(error instanceof CanonicalFetchTransportError);
        assert.equal(error.diagnostics.causeClass, "dns");
        assert.equal(error.diagnostics.proxyUsed, false);
        assert.equal(error.diagnostics.url, proxyOnlyUrl);
        return true;
      },
    );

    const proxied = await fetchWithCanonicalProxy(proxyOnlyUrl, {}, {
      HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
    });
    assert.equal(proxied.status, 200);
    assert.equal(proxied.headers.get("content-encoding"), "gzip");
    assert.deepEqual(proxied.headers.getSetCookie(), [
      "fixture-session=synthetic; Path=/; HttpOnly", "fixture-second=synthetic; Path=/",
    ]);
    assert.deepEqual(await proxied.json(), { ok: true });
    assert.equal(proxyConnects, 1);

    const allProxied = await fetchWithCanonicalProxy(proxyOnlyUrl, {}, {
      ALL_PROXY: `http://127.0.0.1:${proxyPort}`,
    });
    assert.equal(allProxied.status, 200);
    assert.equal(allProxied.headers.get("content-encoding"), "gzip");
    assert.deepEqual(allProxied.headers.getSetCookie(), [
      "fixture-session=synthetic; Path=/; HttpOnly", "fixture-second=synthetic; Path=/",
    ]);
    assert.deepEqual(await allProxied.json(), { ok: true });
    // Native Node Request must survive the undici version boundary, including
    // init overrides and its streamed body. Manual redirects must stay manual.
    const request = new Request(`http://proxy-only.invalid:${originPort}/request`, {
      method: "POST",
      headers: { "x-fixture": "original" },
      body: "native request body",
      redirect: "manual",
    });
    const requestResponse = await fetchWithCanonicalProxy(request, {
      headers: { "x-fixture": "override" },
    }, { HTTP_PROXY: `http://127.0.0.1:${proxyPort}` });
    assert.equal(requestResponse.status, 302);
    assert.equal(requestResponse.headers.get("location"), "/manifest");
    assert.deepEqual(await requestResponse.json(), {
      method: "POST", body: "native request body", header: "override",
    });
    assert.equal(request.bodyUsed, true);

    const controller = new AbortController();
    const cancelled = new Request(proxyOnlyUrl, { signal: controller.signal });
    controller.abort();
    await assert.rejects(
      () => fetchWithCanonicalProxy(cancelled, {}, { HTTP_PROXY: `http://127.0.0.1:${proxyPort}` }),
      (error: unknown) => {
        assert.ok(error instanceof CanonicalFetchTransportError);
        assert.ok(error.cause instanceof DOMException);
        assert.equal(error.cause.name, "AbortError");
        assert.equal(error.diagnostics.proxyUsed, true);
        return true;
      },
    );
    const proxyConnectsBeforeDirect = proxyConnects;
    assert.ok(proxyConnectsBeforeDirect >= 1);

    const direct = await fetchWithCanonicalProxy(directUrl, {}, {});
    assert.equal(direct.status, 200);
    assert.equal(direct.headers.get("content-encoding"), "gzip");
    assert.deepEqual(direct.headers.getSetCookie(), [
      "fixture-session=synthetic; Path=/; HttpOnly", "fixture-second=synthetic; Path=/",
    ]);
    assert.deepEqual(await direct.json(), { ok: true });
    assert.equal(proxyConnects, proxyConnectsBeforeDirect, "the direct target must not silently route through the proxy");

    const bypassed = await fetchWithCanonicalProxy(directUrl, {}, {
      HTTP_PROXY: "http://127.0.0.1:1",
      NO_PROXY: "127.0.0.1",
    });
    assert.equal(bypassed.status, 200);
    assert.equal(bypassed.headers.get("content-encoding"), "gzip");
    assert.deepEqual(bypassed.headers.getSetCookie(), [
      "fixture-session=synthetic; Path=/; HttpOnly", "fixture-second=synthetic; Path=/",
    ]);
    assert.deepEqual(await bypassed.json(), { ok: true });
    assert.equal(proxyConnects, proxyConnectsBeforeDirect, "NO_PROXY must keep the reachable target direct");
  } finally {
    for (const socket of proxySockets) socket.destroy();
    for (const socket of originSockets) socket.destroy();
    await Promise.all([
      new Promise<void>((resolve) => proxy.close(() => resolve())),
      new Promise<void>((resolve) => origin.close(() => resolve())),
    ]);
  }
});

test("canonical fetch diagnostics keep bounded cause classes and redact URL credentials", () => {
  const cases: Array<{
    code: string;
    message: string;
    syscall?: string;
    proxyUsed: boolean;
    expected: CanonicalFetchTransportError["diagnostics"]["causeClass"];
  }> = [
    { code: "ENOTFOUND", message: "getaddrinfo failed", proxyUsed: false, expected: "dns" },
    // Some resolvers fail a lookup with a code other than ENOTFOUND, and the
    // message names the host: neither may turn a lookup failure into "proxy".
    { code: "EBUSY", message: "getaddrinfo EBUSY proxy-only.invalid", syscall: "getaddrinfo", proxyUsed: false, expected: "dns" },
    { code: "ECONNREFUSED", message: "connection refused", proxyUsed: false, expected: "connect" },
    { code: "CERT_HAS_EXPIRED", message: "certificate has expired", proxyUsed: false, expected: "tls" },
    { code: "ETIMEDOUT", message: "connection timed out", proxyUsed: false, expected: "timeout" },
    { code: "ECONNRESET", message: "proxy socket reset", proxyUsed: true, expected: "proxy" },
  ];

  for (const fixture of cases) {
    const cause = Object.assign(new Error(fixture.message), { code: fixture.code, syscall: fixture.syscall });
    const error = new CanonicalFetchTransportError({
      url: "https://user:password@example.test/callback?code=one-time-secret&state=sensitive#fragment",
      cause: Object.assign(new TypeError("fetch failed"), { cause }),
      proxyUsed: fixture.proxyUsed,
    });
    assert.equal(error.diagnostics.causeClass, fixture.expected);
    assert.equal(error.diagnostics.causeCode, fixture.code);
    assert.equal(
      error.diagnostics.url,
      "https://example.test/callback?code=%5Bredacted%5D&state=%5Bredacted%5D",
    );
    assert.doesNotMatch(error.message, /password|one-time-secret|sensitive|fragment/);
  }

  assert.equal(
    credentialFreeDiagnosticUrl("https://user:password@example.test/callback?code=secret#fragment"),
    "https://example.test/callback?code=%5Bredacted%5D",
  );

  const cyclicCause = Object.assign(new Error("cyclic failure"), { cause: undefined as unknown });
  cyclicCause.cause = cyclicCause;
  const cyclicError = new CanonicalFetchTransportError({
    url: "https://example.test/manifest",
    cause: cyclicCause,
    proxyUsed: false,
  });
  assert.equal(cyclicError.diagnostics.causeClass, "unknown");
});

test("fetchWithDispatcher sends a FormData body through a real proxy with the package dispatcher", async () => {
  const origin = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    response.writeHead(200, { "content-type": "application/json", connection: "close" });
    response.end(JSON.stringify({
      method: request.method,
      contentType: request.headers["content-type"] ?? "",
      hasField: body.includes("field-value"),
    }));
  });
  const originSockets = trackSockets(origin);
  const originPort = await listen(origin);

  let proxyConnects = 0;
  const proxy = http.createServer((_request, response) => {
    response.writeHead(501);
    response.end();
  });
  const proxySockets = trackSockets(proxy);
  proxy.on("connect", (_request, downstream, head) => {
    proxyConnects += 1;
    const upstream = net.connect(originPort, "127.0.0.1", () => {
      downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      downstream.pipe(upstream);
      upstream.pipe(downstream);
    });
    upstream.once("error", () => downstream.destroy());
    downstream.once("error", () => upstream.destroy());
  });
  const proxyPort = await listen(proxy);

  const url = `http://proxy-only.invalid:${originPort}/upload`;
  try {
    const dispatcher = await buildFetchDispatcher(url, { HTTP_PROXY: `http://127.0.0.1:${proxyPort}` });
    assert.ok(dispatcher);
    const form = new FormData();
    form.append("field", "field-value");
    const response = await fetchWithDispatcher(url, { method: "POST", body: form, dispatcher });
    assert.equal(response.status, 200);
    const echoed = await response.json() as { method: string; contentType: string; hasField: boolean };
    assert.equal(echoed.method, "POST");
    assert.match(echoed.contentType, /^multipart\/form-data; boundary=/);
    assert.equal(echoed.hasField, true);
    assert.equal(proxyConnects, 1);
  } finally {
    for (const socket of proxySockets) socket.destroy();
    for (const socket of originSockets) socket.destroy();
    await Promise.all([
      new Promise<void>((resolve) => proxy.close(() => resolve())),
      new Promise<void>((resolve) => origin.close(() => resolve())),
    ]);
  }
});
