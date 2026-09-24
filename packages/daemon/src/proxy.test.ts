import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { test } from "vitest";
import { HttpsProxyAgent } from "https-proxy-agent";
import { Agent, ProxyAgent } from "undici";
import {
  buildFetchDispatcher,
  buildIsolatedFetchDispatcher,
  buildWebSocketOptions,
  validateProviderProxyEnv,
  evictFetchDispatcher,
  evictIsolatedFetchDispatcher,
} from "./proxy.js";
import { daemonFetch } from "./daemonFetch.js";

test("buildWebSocketOptions returns a proxy agent when wss proxy env is configured", () => {
  const options = buildWebSocketOptions("wss://api.slock.ai/daemon/connect?key=test", {
    HTTPS_PROXY: "http://proxy.internal:8080",
  });

  assert.ok(options);
  assert.ok(options.agent instanceof HttpsProxyAgent);
});

test("buildWebSocketOptions honors NO_PROXY for localhost and internal domains", () => {
  assert.equal(
    buildWebSocketOptions("ws://localhost:3001/daemon/connect?key=test", {
      HTTP_PROXY: "http://proxy.internal:8080",
      NO_PROXY: "localhost,.internal",
    }),
    undefined,
  );

  assert.equal(
    buildWebSocketOptions("wss://api.corp.internal/daemon/connect?key=test", {
      HTTPS_PROXY: "http://proxy.internal:8080",
      NO_PROXY: "localhost,.internal",
    }),
    undefined,
  );
});

test("buildFetchDispatcher returns a proxy dispatcher when https proxy env is configured", () => {
  const dispatcher = buildFetchDispatcher("https://api.slock.ai/internal/agent/123/receive", {
    HTTPS_PROXY: "http://proxy.internal:8080",
  });

  assert.ok(dispatcher instanceof ProxyAgent);
});

test("buildFetchDispatcher honors NO_PROXY for localhost and internal domains", () => {
  assert.equal(
    buildFetchDispatcher("http://localhost:3001/internal/agent/123/receive", {
      HTTP_PROXY: "http://proxy.internal:8080",
      NO_PROXY: "localhost,.internal",
    }),
    undefined,
  );

  assert.equal(
    buildFetchDispatcher("https://api.corp.internal/internal/agent/123/receive", {
      HTTPS_PROXY: "http://proxy.internal:8080",
      NO_PROXY: "localhost,.internal",
    }),
    undefined,
  );
});

test("Pi provider dispatcher rejects unsupported proxy protocols with a typed value-free error", () => {
  assert.throws(
    () => validateProviderProxyEnv({ ALL_PROXY: "socks5://proxy.internal:1080" }),
    (error: unknown) => {
      assert.equal(
        (error as { code?: unknown }).code,
        "PI_PROVIDER_PROXY_PROTOCOL_UNSUPPORTED",
      );
      assert.doesNotMatch(String((error as Error).message), /proxy\.internal|1080|socks5/iu);
      return true;
    },
  );
});

// A sink "proxy": accepts the TCP connection and the CONNECT request, replies
// 200 Connection Established, then never relays an origin response — TCP
// half-open / black-hole, the real degraded-proxy shape. Because the tunnel to
// the origin never completes, undici's CONNECT-establish timeout (the
// `requestTls.timeout` connector) must fire before any Response is produced,
// surfacing as UND_ERR_CONNECT_TIMEOUT. (The headers-hang leg, where the tunnel
// IS established but the origin never sends headers, is covered separately by
// the headers-leg test below.) This is hard evidence that the ProxyAgent timeout
// options actually take effect at runtime; a constructor accepting the option
// does not prove it fires.
function startSinkProxy(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      socket.once("data", () => {
        // Reply 200 to the CONNECT, then go silent — never relay an origin
        // response, so the tunnel-to-origin never completes and the
        // requestTls.timeout (connect) bound fires.
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise((res) => {
            for (const s of sockets) s.destroy();
            server.close(() => res());
          }),
      });
    });
  });
}

test("buildFetchDispatcher caches one dispatcher per proxy URL", () => {
  const env = { HTTPS_PROXY: "http://proxy.cache-reuse.test:8080" };
  const first = buildFetchDispatcher("https://api.slock.ai/internal/agent/1/receive", env);
  const second = buildFetchDispatcher("https://api.slock.ai/internal/agent/2/receive", env);

  assert.ok(first instanceof ProxyAgent);
  assert.equal(second, first, "same proxy URL reuses the cached dispatcher (keep-alive pooling)");
});

test("isolated fetch lanes do not share connection pools with daemon backlog traffic", () => {
  const directUrl = "http://127.0.0.1:3001/internal/agent-api/send";
  const shared = buildFetchDispatcher(directUrl, {});
  const proxyLane = buildIsolatedFetchDispatcher(directUrl, "agent-credential-proxy", {});
  const proxyLaneAgain = buildIsolatedFetchDispatcher(directUrl, "agent-credential-proxy", {});
  const backlogLane = buildIsolatedFetchDispatcher(directUrl, "daemon-backlog", {});

  assert.equal(shared, undefined, "ordinary direct daemon fetches retain the global dispatcher");
  assert.ok(proxyLane instanceof Agent, "the credential proxy owns an explicit direct connection pool");
  assert.equal(proxyLaneAgain, proxyLane, "one lane reuses its own keep-alive pool");
  assert.notEqual(backlogLane, proxyLane, "other daemon traffic cannot occupy the credential-proxy pool");

  assert.equal(evictIsolatedFetchDispatcher(directUrl, "daemon-backlog", {}), true);
  assert.equal(
    buildIsolatedFetchDispatcher(directUrl, "agent-credential-proxy", {}),
    proxyLane,
    "evicting a failed backlog lane does not churn the credential-proxy pool",
  );

  const proxyEnv = { HTTPS_PROXY: "http://127.0.0.1:8899" };
  const proxiedUrl = "https://api.raft.build/internal/agent-api/send";
  const sharedProxyPool = buildFetchDispatcher(proxiedUrl, proxyEnv);
  const isolatedProxyPool = buildIsolatedFetchDispatcher(proxiedUrl, "agent-credential-proxy", proxyEnv);
  assert.ok(sharedProxyPool instanceof ProxyAgent);
  assert.ok(isolatedProxyPool instanceof ProxyAgent);
  assert.notEqual(isolatedProxyPool, sharedProxyPool, "proxied credential traffic also owns a separate pool");

  evictIsolatedFetchDispatcher(directUrl, "agent-credential-proxy", {});
  evictIsolatedFetchDispatcher(proxiedUrl, "agent-credential-proxy", proxyEnv);
  evictFetchDispatcher(proxiedUrl, proxyEnv);
});

test("isolated fetch lanes key a route-specific headers timeout without changing sibling pools", () => {
  const url = "http://127.0.0.1:3001/internal/agent-api/upload";
  const env = { SLOCK_DAEMON_FETCH_PRE_RESPONSE_TIMEOUT_MS: "30000" };
  const ordinary = buildIsolatedFetchDispatcher(url, "credential-lane-timeout-test", env);
  const extended = buildIsolatedFetchDispatcher(url, "credential-lane-timeout-test", env, 300_000);

  assert.notEqual(extended, ordinary, "a long upload headers timeout must not widen an existing pool");
  assert.equal(
    buildIsolatedFetchDispatcher(url, "credential-lane-timeout-test", env, 300_000),
    extended,
    "the same lane and timeout reuse their dedicated pool",
  );
  assert.equal(
    evictIsolatedFetchDispatcher(url, "credential-lane-timeout-test", env, 300_000),
    true,
    "the extended pool is independently evictable",
  );
  assert.equal(
    buildIsolatedFetchDispatcher(url, "credential-lane-timeout-test", env),
    ordinary,
    "evicting the extended pool leaves the ordinary short-timeout pool intact",
  );

  evictIsolatedFetchDispatcher(url, "credential-lane-timeout-test", env);
});

test("daemonFetch bounds direct credential-proxy pre-response hangs without aborting a slow body", async () => {
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    if (req.url === "/hang") return;
    res.writeHead(200, { "content-type": "application/json" });
    res.write("{");
    const timer = setTimeout(() => res.end('"ok":true}'), 300);
    timer.unref?.();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  const env = { SLOCK_DAEMON_FETCH_PRE_RESPONSE_TIMEOUT_MS: "100" };
  const options = { isolationKey: "agent-credential-proxy-test" };
  const siblingOptions = { isolationKey: "daemon-backlog-test" };
  const targetOrigin = `http://127.0.0.1:${port}`;
  const originalPool = buildIsolatedFetchDispatcher(targetOrigin, options.isolationKey, env);
  const siblingPool = buildIsolatedFetchDispatcher(targetOrigin, siblingOptions.isolationKey, env);

  try {
    const startedAt = Date.now();
    let caught: unknown;
    await daemonFetch(`http://127.0.0.1:${port}/hang`, { method: "GET" }, env, options).catch((err) => {
      caught = err;
    });
    const elapsed = Date.now() - startedAt;
    assert.ok(caught, "a direct origin that never sends headers must reject");
    assert.ok(elapsed < 2_000, `direct pre-response timeout should be bounded, took ${elapsed}ms`);
    assert.notEqual(
      buildIsolatedFetchDispatcher(targetOrigin, options.isolationKey, env),
      originalPool,
      "a rejected request evicts only its lane's pool",
    );
    assert.equal(
      buildIsolatedFetchDispatcher(targetOrigin, siblingOptions.isolationKey, env),
      siblingPool,
      "the rejected credential request does not churn another lane",
    );

    const response = await daemonFetch(`http://127.0.0.1:${port}/slow`, { method: "GET" }, env, options);
    assert.deepEqual(await response.json(), { ok: true }, "timeout is cleared once headers arrive");
  } finally {
    evictIsolatedFetchDispatcher(targetOrigin, options.isolationKey, env);
    evictIsolatedFetchDispatcher(targetOrigin, siblingOptions.isolationKey, env);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// Connect-establish leg: the proxy accepts the TCP CONNECT but never completes
// the tunnel to the origin (no relayed response). undici bounds this via the
// `requestTls.timeout` connector option (default would be 10s). Asserted
// bounded, not exact — undici's connect timer adds a coarse additive overhead.
test("daemonFetch: CONNECT-establish leg is bounded (UND_ERR_CONNECT_TIMEOUT)", async () => {
  const sink = await startSinkProxy();
  try {
    const env = {
      HTTPS_PROXY: sink.url,
      // Small value keeps the test fast; proves the knob fires well under the
      // undici 10s default, not that it fires at an exact millisecond.
      SLOCK_DAEMON_FETCH_PRE_RESPONSE_TIMEOUT_MS: "300",
    };
    const url = "https://api.slock.ai/internal/agent-api/send";

    assert.ok(buildFetchDispatcher(url, env) instanceof ProxyAgent);

    const startedAt = Date.now();
    let caught: unknown;
    await daemonFetch(url, { method: "POST" }, env).catch((err) => {
      caught = err;
    });
    const elapsed = Date.now() - startedAt;

    assert.ok(caught, "a black-hole proxy must reject before any Response is produced");
    // Bounded well under undici's 10s connect default — proves the knob took effect.
    assert.ok(elapsed < 5_000, `connect timeout should fire well under 5s, took ${elapsed}ms`);
    const cause = (caught as { cause?: { code?: string } })?.cause?.code;
    assert.equal(
      cause,
      "UND_ERR_CONNECT_TIMEOUT",
      `expected undici connect-timeout, got cause=${String(cause)}`,
    );
  } finally {
    await sink.close();
  }
});

// Headers-hang leg: the tunnel to the origin establishes, but the origin never
// sends response headers (silent — never calls writeHead). undici bounds this
// via `headersTimeout` (default would be 5min — the leg that turns a flaky proxy
// into a near-permanent send outage). Asserted bounded, not exact.
test("daemonFetch: headers-hang leg is bounded (UND_ERR_HEADERS_TIMEOUT)", async () => {
  const net2 = await startTunnelProxyAndOrigin((_req, _res) => {
    // Never send headers or body — hold the request open.
  });
  try {
    const env = {
      // Origin is plain http: → proxy resolved from HTTP_PROXY (see getProxyUrlForTarget).
      HTTP_PROXY: net2.proxyUrl,
      SLOCK_DAEMON_FETCH_PRE_RESPONSE_TIMEOUT_MS: "300",
    };
    const startedAt = Date.now();
    let caught: unknown;
    await daemonFetch(`${net2.originUrl}/hang`, { method: "GET" }, env).catch((err) => {
      caught = err;
    });
    const elapsed = Date.now() - startedAt;

    assert.ok(caught, "an origin that never sends headers must reject pre-response");
    // Bounded well under undici's 5min headers default — proves the knob took effect.
    assert.ok(elapsed < 5_000, `headers timeout should fire well under 5s, took ${elapsed}ms`);
    const cause = (caught as { cause?: { code?: string } })?.cause?.code;
    assert.equal(
      cause,
      "UND_ERR_HEADERS_TIMEOUT",
      `expected undici headers-timeout, got cause=${String(cause)}`,
    );
  } finally {
    await net2.close();
  }
});

// A real CONNECT proxy tunneling to a local origin whose request handler is
// supplied by the caller. Used both for the headers-hang leg (a silent handler
// that never responds) and the slow-body regression guard (headers flushed
// immediately, body delayed). connect.timeout + requestTls.timeout +
// headersTimeout are all pre-response, so a slow-but-legitimate body must NOT
// be aborted by them.
function startTunnelProxyAndOrigin(
  originHandler: http.RequestListener,
): Promise<{
  proxyUrl: string;
  originUrl: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const origin = http.createServer(originHandler);
    // clientSocket from the http 'connect' event is a Duplex; upstream is a
    // net.Socket. Both extend Duplex, so widen the set to hold either.
    const sockets = new Set<Duplex>();
    const proxy = http.createServer((_req, res) => {
      res.writeHead(405);
      res.end();
    });
    proxy.on("connect", (req, clientSocket, head) => {
      sockets.add(clientSocket);
      clientSocket.on("close", () => sockets.delete(clientSocket));
      clientSocket.on("error", () => {});
      const [host, port] = req.url!.split(":");
      const upstream = net.connect(Number(port), host, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head?.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      upstream.on("error", () => {});
    });
    origin.listen(0, "127.0.0.1", () => {
      const originPort = (origin.address() as net.AddressInfo).port;
      proxy.listen(0, "127.0.0.1", () => {
        const proxyPort = (proxy.address() as net.AddressInfo).port;
        resolve({
          proxyUrl: `http://127.0.0.1:${proxyPort}`,
          originUrl: `http://127.0.0.1:${originPort}`,
          close: () =>
            new Promise((res) => {
              for (const s of sockets) s.destroy();
              proxy.close(() => origin.close(() => res()));
            }),
        });
      });
    });
  });
}

test("daemonFetch: a slow-but-legit response body is NOT aborted by the pre-response timeout", async () => {
  // Headers flush immediately; the body's final chunk arrives 700ms later — well
  // past the 300ms pre-response timeout. A whole-request deadline would kill this;
  // a pre-response timeout (connect/requestTls/headers) must not touch the body.
  const net2 = await startTunnelProxyAndOrigin((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write("{");
    const t = setTimeout(() => res.end('"ok":true}'), 700);
    t.unref?.();
  });
  try {
    const env = {
      // Origin is plain http: → proxy resolved from HTTP_PROXY (see getProxyUrlForTarget).
      HTTP_PROXY: net2.proxyUrl,
      SLOCK_DAEMON_FETCH_PRE_RESPONSE_TIMEOUT_MS: "300",
    };
    const res = await daemonFetch(`${net2.originUrl}/slow`, { method: "GET" }, env);
    assert.equal(res.status, 200, "headers arrive within the pre-response window");
    const body = await res.json();
    assert.deepEqual(body, { ok: true }, "slow body completes without being aborted");
  } finally {
    await net2.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Narrow dispatcher eviction (#76). Safety invariant: evict the cached ProxyAgent
// ONLY on a transport / pre-response failure (fetch rejected, no Response), NEVER
// on a Response (any status, including server 4xx/5xx). Each test uses a distinct
// proxy URL so the module-level cache identity checks are isolated.
// ─────────────────────────────────────────────────────────────────────────────

test("evictFetchDispatcher returns false when no proxy applies (direct / bypassed)", () => {
  // No proxy env → nothing cached to evict.
  assert.equal(evictFetchDispatcher("https://api.slock.ai/internal/agent-api/send", {}), false);
  // NO_PROXY bypass → goes direct, nothing cached to evict.
  assert.equal(
    evictFetchDispatcher("http://localhost:3001/internal/agent-api/send", {
      HTTP_PROXY: "http://proxy.internal:8080",
      NO_PROXY: "localhost",
    }),
    false,
  );
});

test("evictFetchDispatcher drops the cached dispatcher so the next build rebuilds", () => {
  const env = { HTTPS_PROXY: "http://proxy.evict-unit.test:8080" };
  const url = "https://api.slock.ai/internal/agent-api/send";

  const first = buildFetchDispatcher(url, env);
  assert.ok(first instanceof ProxyAgent);
  assert.equal(buildFetchDispatcher(url, env), first, "cached before eviction");

  assert.equal(evictFetchDispatcher(url, env), true, "evicts the cached dispatcher");

  const rebuilt = buildFetchDispatcher(url, env);
  assert.ok(rebuilt instanceof ProxyAgent);
  assert.notEqual(rebuilt, first, "next build constructs a FRESH dispatcher after eviction");

  // Second evict with nothing cached for an unrelated round is false.
  assert.equal(
    evictFetchDispatcher("https://api.slock.ai/internal/agent-api/send", {
      HTTPS_PROXY: "http://proxy.evict-unit-empty.test:8080",
    }),
    false,
  );
});

test("daemonFetch EVICTS the cached dispatcher on a transport reject (black-hole proxy)", async () => {
  const sink = await startSinkProxy();
  try {
    const env = {
      HTTPS_PROXY: sink.url,
      SLOCK_DAEMON_FETCH_PRE_RESPONSE_TIMEOUT_MS: "300",
    };
    const url = "https://api.slock.ai/internal/agent-api/send";

    const before = buildFetchDispatcher(url, env);
    assert.ok(before instanceof ProxyAgent);

    let caught: unknown;
    await daemonFetch(url, { method: "POST" }, env).catch((err) => {
      caught = err;
    });
    assert.ok(caught, "black-hole proxy rejects pre-response (transport failure)");

    // The poisoned dispatcher must have been evicted: the NEXT build is fresh.
    const after = buildFetchDispatcher(url, env);
    assert.ok(after instanceof ProxyAgent);
    assert.notEqual(after, before, "transport reject evicts → next build rebuilds a fresh dispatcher");
  } finally {
    await sink.close();
  }
});

test("daemonFetch does NOT evict on a server 5xx Response (transport worked)", async () => {
  // Origin returns a real 500 Response — the dispatcher reached the origin and
  // got a response, so the transport is healthy and must stay cached.
  const net2 = await startTunnelProxyAndOrigin((_req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end('{"error":"boom"}');
  });
  try {
    const env = {
      HTTP_PROXY: net2.proxyUrl,
      SLOCK_DAEMON_FETCH_PRE_RESPONSE_TIMEOUT_MS: "300",
    };
    const url = `${net2.originUrl}/boom`;

    const before = buildFetchDispatcher(url, env);
    assert.ok(before instanceof ProxyAgent);

    const res = await daemonFetch(url, { method: "POST" }, env);
    assert.equal(res.status, 500, "server 5xx resolves as a Response, not a transport reject");
    await res.text();

    const after = buildFetchDispatcher(url, env);
    assert.equal(after, before, "a 5xx Response must NOT evict — the dispatcher is healthy");
  } finally {
    await net2.close();
  }
});

test("daemonFetch does NOT evict on a server 4xx Response (transport worked)", async () => {
  const net2 = await startTunnelProxyAndOrigin((_req, res) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":"not_found"}');
  });
  try {
    const env = {
      HTTP_PROXY: net2.proxyUrl,
      SLOCK_DAEMON_FETCH_PRE_RESPONSE_TIMEOUT_MS: "300",
    };
    const url = `${net2.originUrl}/missing`;

    const before = buildFetchDispatcher(url, env);
    assert.ok(before instanceof ProxyAgent);

    const res = await daemonFetch(url, { method: "GET" }, env);
    assert.equal(res.status, 404);
    await res.text();

    const after = buildFetchDispatcher(url, env);
    assert.equal(after, before, "a 4xx Response must NOT evict — the dispatcher is healthy");
  } finally {
    await net2.close();
  }
});
