// installSystemCaTrust (shared/src/systemTrust.ts) as the Computer's entry
// installs it: a CA that only the OS store trusts (a TLS-re-signing proxy's
// CA, here a self-signed cert injected as the "system" list) must be trusted
// by computerFetch, directly and through its HTTPS_PROXY tunnel.
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

import { fetch } from "undici";
import {
  installSystemCaTrust,
  resetSystemCaTrustForTest,
  systemCaTrustTraceAttrs,
} from "@botiverse/raft-shared/src/systemTrust";

import { buildFetchDispatcher, computerFetch } from "./proxy";

// Self-signed CA cert for 127.0.0.1 / localhost, valid until 2126.
const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgLh8KdKLwsY+YCXps
dfPvwCauEUx8W7d1sml0xISSLSShRANCAASqJc9loABzVkrq4+ByyttPKXugpZA6
BN2SkTNwwjkj0eefhO+1BGJyI6u0pnhGeQJrQkWwbGmR9ldFPBfJ6fsM
-----END PRIVATE KEY-----
`;
const CERT = `-----BEGIN CERTIFICATE-----
MIIBrjCCAVWgAwIBAgIUBmuiWKJYZ3JTFi44Vu95bUsOYnQwCgYIKoZIzj0EAwIw
HjEcMBoGA1UEAwwTcmFmdC1zeXN0ZW0tY2EtdGVzdDAgFw0yNjExMTYxNzI5NDha
GA8yMTI2MTAyMzE3Mjk0OFowHjEcMBoGA1UEAwwTcmFmdC1zeXN0ZW0tY2EtdGVz
dDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABKolz2WgAHNWSurj4HLK208pe6Cl
kDoE3ZKRM3DCOSPR55+E77UEYnIjq7SmeEZ5AmtCRbBsaZH2V0U8F8np+wyjbzBt
MB0GA1UdDgQWBBQ3c/POZgA7zvgiEeg+Xbgkv8I+wzAfBgNVHSMEGDAWgBQ3c/PO
ZgA7zvgiEeg+Xbgkv8I+wzAaBgNVHREEEzARhwR/AAABgglsb2NhbGhvc3QwDwYD
VR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNHADBEAiBvW++FgeQYYim5O/PdP5fz
Uko8NcvBx7MxQNM7UanJbQIgOx8iCQEosHH3dz1eUWcWhy2zzqvIbFbLfg2ta5TU
3eQ=
-----END CERTIFICATE-----
`;

type TlsCaApis = {
  getCACertificates(type: "default"): string[];
  setDefaultCACertificates(certs: string[]): void;
};
const tlsCa = tls as unknown as TlsCaApis;
const originalDefaults = tlsCa.getCACertificates("default");

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server has no TCP address");
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function certErrorCode(error: unknown): string {
  let current: unknown = error;
  while (current instanceof Error) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = current.cause;
  }
  return String(error);
}

const UNTRUSTED = /SELF_SIGNED|UNABLE_TO_VERIFY/;

function fakeClock(readings: number[]): () => number {
  let index = 0;
  return () => readings[Math.min(index++, readings.length - 1)]!;
}

afterEach(() => {
  resetSystemCaTrustForTest();
  tlsCa.setDefaultCACertificates(originalDefaults);
});

test("a CA only the OS store trusts is trusted by computerFetch, direct and via the proxy tunnel, once installed", async () => {
  const origin = https.createServer({ key: KEY, cert: CERT }, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json", connection: "close" });
    response.end(JSON.stringify({ ok: true }));
  });
  const originPort = await listen(origin);
  const proxy = http.createServer((_request, response) => {
    response.writeHead(501);
    response.end();
  });
  proxy.on("connect", (_request, downstream, head) => {
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
  const direct = `https://127.0.0.1:${originPort}/release`;
  const viaProxy = `https://localhost:${originPort}/release`;
  const dispatcher = buildFetchDispatcher(viaProxy, { HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` });
  assert.ok(dispatcher);

  try {
    // Node's own roots: the re-signed cert is rejected on both paths.
    await assert.rejects(computerFetch(direct), (error) => UNTRUSTED.test(certErrorCode(error)));
    await assert.rejects(fetch(viaProxy, { dispatcher }), (error) => UNTRUSTED.test(certErrorCode(error)));

    // The OS store hands back bundled roots too, formatted differently (a
    // trailing newline Node's bundled PEMs lack): those are not new.
    const outcome = installSystemCaTrust({
      getSystemCerts: () => [CERT, `${originalDefaults[0]!}\n`, `\n${originalDefaults[1]!}\n`, CERT],
      now: fakeClock([10, 17]),
    });
    assert.deepEqual(outcome, {
      status: "installed",
      systemCaCount: 4,
      addedCaCount: 1,
      unparsableCaCount: 0,
      durationMs: 7,
    });
    assert.deepEqual(systemCaTrustTraceAttrs(), {
      system_ca_status: "installed",
      duration_ms: 7,
      system_ca_count: 4,
      system_ca_added_count: 1,
      system_ca_unparsable_count: 0,
    });

    const response = await computerFetch(direct);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    const proxied = await fetch(viaProxy, { dispatcher });
    assert.equal(proxied.status, 200);
    assert.deepEqual(await proxied.json(), { ok: true });
    // Bundled roots stay trusted alongside the system ones.
    assert.equal(tlsCa.getCACertificates("default").length, originalDefaults.length + 1);
  } finally {
    await dispatcher.close();
    await close(proxy);
    await close(origin);
  }
});

test("install is idempotent: a second call reads nothing and keeps the first outcome", () => {
  let systemReads = 0;
  let sets = 0;
  const deps = {
    getDefaultCerts: () => [originalDefaults[0]!],
    getSystemCerts: () => {
      systemReads += 1;
      return [originalDefaults[0]!, CERT];
    },
    setDefaultCerts: () => {
      sets += 1;
    },
  };
  const first = installSystemCaTrust(deps);
  const second = installSystemCaTrust(deps);
  assert.equal(second, first);
  assert.equal(systemReads, 1);
  assert.equal(sets, 1);
});

test("an already-trusted store adds nothing and leaves the default list alone; an unparsable entry is skipped and counted, never handed to the setter", () => {
  let sets = 0;
  const unchanged = installSystemCaTrust({
    getDefaultCerts: () => [originalDefaults[0]!],
    getSystemCerts: () => [`${originalDefaults[0]!}\n`],
    setDefaultCerts: () => { sets += 1; },
  });
  assert.equal(unchanged.status === "installed" && unchanged.addedCaCount, 0);
  assert.equal(sets, 0);

  resetSystemCaTrustForTest();
  let junkSets = 0;
  const withJunk = installSystemCaTrust({
    getDefaultCerts: () => [originalDefaults[0]!],
    // A malformed block would make the real setter throw (ERR_OSSL_PEM_BAD_BASE64_DECODE).
    getSystemCerts: () => ["not a pem", "-----BEGIN CERTIFICATE-----\n!!!\n-----END CERTIFICATE-----\n"],
    setDefaultCerts: () => { junkSets += 1; },
  });
  assert.equal(withJunk.status, "installed");
  assert.equal(withJunk.status === "installed" && withJunk.addedCaCount, 0);
  assert.equal(withJunk.status === "installed" && withJunk.unparsableCaCount, 2);
  assert.equal(junkSets, 0, "nothing new, so the default list is left alone");
});

test("a failing store read keeps Node's defaults and records only the error class", () => {
  let sets = 0;
  const outcome = installSystemCaTrust({
    now: fakeClock([100, 103]),
    getDefaultCerts: () => ["bundled"],
    getSystemCerts: () => {
      throw Object.assign(new Error("keychain unavailable: secret detail"), { code: "ERR_STORE" });
    },
    setDefaultCerts: () => {
      sets += 1;
    },
  });
  assert.deepEqual(outcome, { status: "failed", errorClass: "Error:ERR_STORE", durationMs: 3 });
  assert.equal(sets, 0);
  assert.deepEqual(systemCaTrustTraceAttrs(), {
    system_ca_status: "failed",
    duration_ms: 3,
    error_class: "Error:ERR_STORE",
  });
});
