// Which transport ApiClient.request uses: node:http for plain JSON requests,
// fetch for redirects and whenever an HTTP proxy dispatcher applies.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, test } from "vitest";

import type { AgentContext } from "./auth/env";
import { ApiClient } from "./client";
import { setCanonicalFetchImplForTests } from "./proxy";

const ctxFor = (serverUrl: string): AgentContext => ({
  agentId: "agent-1",
  serverId: "server-1",
  serverUrl,
  token: "sk_agent_test",
  clientMode: "self-hosted-runner",
  secretSource: "profile-credential-file",
  activeCapabilities: null,
} as AgentContext);

const originalFetch = globalThis.fetch;
const proxyEnvKeys = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"];
const savedEnv = Object.fromEntries(proxyEnvKeys.map((key) => [key, process.env[key]]));
let server: Server | null = null;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  for (const key of proxyEnvKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

test("a plain JSON request goes over node:http, not fetch", async () => {
  globalThis.fetch = (async () => { throw new Error("fetch must not be used"); }) as typeof fetch;
  const paths: string[] = [];
  const base = await listen((req, res) => {
    paths.push(req.url ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const response = await new ApiClient(ctxFor(base)).request("GET", "/internal/agent-api/server");
  assert.equal(response.ok, true);
  assert.deepEqual(response.data, { ok: true });
  assert.deepEqual(paths, ["/internal/agent-api/server"]);
});

test("a redirect is re-sent through fetch, which follows it as before", async () => {
  const base = await listen((req, res) => {
    if (req.url === "/internal/agent-api/server") {
      res.writeHead(307, { location: "/internal/agent-api/server-moved" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ moved: true }));
  });
  let fetchCalls = 0;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls += 1;
    return originalFetch(input, init);
  }) as typeof fetch;
  const response = await new ApiClient(ctxFor(base)).request("GET", "/internal/agent-api/server");
  assert.deepEqual(response.data, { moved: true });
  assert.equal(fetchCalls, 1);
});

test("with an HTTP proxy configured, the request goes to the package fetch with the proxy dispatcher", async () => {
  process.env.HTTP_PROXY = "http://127.0.0.1:9";
  delete process.env.NO_PROXY;
  delete process.env.no_proxy;
  const inits: Array<RequestInit & { dispatcher?: unknown }> = [];
  // The dispatcher is a package-undici ProxyAgent, so it must ride the package
  // fetch, never Node's built-in fetch (another undici major).
  const previousImpl = setCanonicalFetchImplForTests((async (_input: RequestInfo | URL, init?: RequestInit) => {
    inits.push(init ?? {});
    return new Response(JSON.stringify({ viaProxy: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch);
  try {
    const response = await new ApiClient(ctxFor("http://api.example.test")).request("GET", "/internal/agent-api/server");
    assert.deepEqual(response.data, { viaProxy: true });
  } finally {
    setCanonicalFetchImplForTests(previousImpl);
  }
  assert.equal(inits.length, 1);
  assert.ok(inits[0]!.dispatcher, "the undici ProxyAgent is passed to the package fetch");
});

test("https honours NODE_EXTRA_CA_CERTS (self-signed CA)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "raft-cli-ca-"));
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
      "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
    ], { stdio: "ignore" });
    const httpsServer = createHttpsServer(
      { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) },
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ tls: true }));
      },
    );
    await new Promise<void>((resolve) => httpsServer.listen(0, "127.0.0.1", () => resolve()));
    const url = `https://127.0.0.1:${(httpsServer.address() as AddressInfo).port}/internal/agent-api/server`;
    const script = join(dir, "probe.ts");
    writeFileSync(script, [
      `import { requestJsonOverHttp } from ${JSON.stringify(fileURLToPath(new URL("./httpTransport.ts", import.meta.url)))};`,
      `requestJsonOverHttp(new URL(${JSON.stringify(url)}), { method: "GET", headers: {} })`,
      `  .then(async (res) => { console.log(await res.text()); })`,
      `  .catch((error) => { console.log("ERR " + (error?.cause?.code ?? error?.message)); });`,
    ].join("\n"));
    // The CA is read at process start, so each case runs in a child process.
    const run = (env: NodeJS.ProcessEnv) => new Promise<string>((resolve) => {
      const child = spawn(process.execPath, ["--import", "@oxc-node/core/register", script], { env, cwd: process.cwd() });
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
      child.on("exit", () => resolve(out.trim()));
    });
    const baseEnv = { ...process.env };
    delete baseEnv.NODE_EXTRA_CA_CERTS;
    try {
      assert.match(await run(baseEnv), /^ERR (DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/);
      assert.equal(await run({ ...baseEnv, NODE_EXTRA_CA_CERTS: join(dir, "cert.pem") }), JSON.stringify({ tls: true }));
    } finally {
      await new Promise<void>((resolve) => httpsServer.close(() => resolve()));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

