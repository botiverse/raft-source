// #wg-rbac:#27: every daemon-side use of an agent's runner key goes out with
// the key as renewed: the credential proxy the agent's `raft` CLI talks to
// (and its wake-hint stream), and managed MCP. A 401 agent_credential_expired
// on the way renews and sends once more; another 401 is relayed as is.
import assert from "node:assert/strict";
import http from "node:http";
import {
  __resetAgentCredentialProxyForTest,
  registerAgentCredentialProxy,
} from "./agentCredentialProxy";
import { createManagedMcpPiTools } from "./drivers/managedMcpTools";
import { __resetManagedMcpRuntimeProxyForTest, prepareManagedMcpRuntimeProxy } from "./managedMcpRuntimeProxy";
import {
  __resetRunnerCredentialRenewalForTest,
  currentRunnerCredentialKey,
  installRunnerCredentialRenewer,
  trackRunnerCredential,
} from "./runnerCredentialRenewal";

const AGENT = "agent-renew";
const LAUNCH = "launch-renew";
const OLD_KEY = "sk_agent_old_key";
const NEW_KEY = "sk_agent_new_key";
const EXPIRED = JSON.stringify({ error: "This agent credential has expired", code: "agent_credential_expired" });

type Upstream = {
  serverUrl: string;
  /** `<key> <METHOD> <path>` per agent-api request, in order. */
  seen: string[];
  /** The request body of each agent-api request, in order. */
  bodies: string[];
  renewCalls: number;
  /** Keys refused with a plain 401 (revoked). */
  revoked: Set<string>;
};

async function withUpstream(fn: (upstream: Upstream) => Promise<void>): Promise<void> {
  const upstream: Upstream = { serverUrl: "", seen: [], bodies: [], renewCalls: 0, revoked: new Set() };
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const received = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://upstream.local");
    const key = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (url.pathname === `/internal/computer/runners/${AGENT}/credentials/renew`) {
      upstream.renewCalls += 1;
      assert.equal(key, "sk_computer_test");
      const now = Date.now();
      res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({
        credentialId: "cred-new",
        apiKey: NEW_KEY,
        expiresAt: new Date(now + 7 * 86_400_000).toISOString(),
        scopes: ["read"],
        agentId: AGENT,
        replacedCredentialId: "cred-old",
        replacedExpiresAt: new Date(now + 300_000).toISOString(),
      }));
      return;
    }
    upstream.seen.push(`${key} ${req.method} ${url.pathname}`);
    upstream.bodies.push(received);
    if (upstream.revoked.has(key)) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "Invalid agent credential" }));
      return;
    }
    if (url.pathname === "/internal/agent-api/wake-hints/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (key === OLD_KEY) {
        // As the server ends the stream of a key whose expiry passed.
        res.write(": ka\n\n");
        res.end(`event: credential-expired\ndata: {"code":"agent_credential_expired"}\n\n`);
      } else {
        res.end(": ka\n\n");
      }
      return;
    }
    if (key === OLD_KEY) {
      res.writeHead(401, { "content-type": "application/json" }).end(EXPIRED);
      return;
    }
    if (url.pathname === "/internal/agent-api/mcp/tools") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ catalogVersion: 1, tools: [] }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, method: req.method, echoed: received }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  upstream.serverUrl = `http://127.0.0.1:${address.port}`;
  const events: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  const uninstall = installRunnerCredentialRenewer({
    serverUrl: upstream.serverUrl,
    computerKey: () => "sk_computer_test",
    fetch: (url, init) => fetch(url, init),
    freshMint: async () => { throw new Error("not expected: renewal succeeds"); },
    revoke: () => { throw new Error("not expected: nothing to revoke"); },
    isHeld: () => true,
    recordEvent: (name, attrs) => { events.push({ name, attrs }); },
  });
  trackRunnerCredential({
    agentId: AGENT,
    runtime: "claude",
    credential: { apiKey: OLD_KEY, credentialId: "cred-old", expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() },
  });
  try {
    await fn(upstream);
    for (const event of events) assert.ok(!JSON.stringify(event.attrs).includes("sk_agent_"), "no key in trace attrs");
  } finally {
    uninstall();
    __resetRunnerCredentialRenewalForTest();
    await __resetAgentCredentialProxyForTest();
    await __resetManagedMcpRuntimeProxyForTest();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function registerProxy(serverUrl: string) {
  return registerAgentCredentialProxy({
    agentId: AGENT,
    launchId: LAUNCH,
    serverUrl,
    apiKey: OLD_KEY,
    activeCapabilities: "read",
  });
}

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(() => {
  __resetRunnerCredentialRenewalForTest();
});

// Teeth: send the proxy's request without fetchWithRunnerCredential -> the 401 reaches the CLI -> RED.
test("the proxy renews on 401 agent_credential_expired, sends the request once more, then uses the new key", async () => {
  await withUpstream(async (upstream) => {
    const proxy = await registerProxy(upstream.serverUrl);
    const sentBody = JSON.stringify({ emoji: "+1", messageId: "m-1", note: "ünïcode ✓".repeat(200) });
    const post = await fetch(`${proxy.proxyUrl}/internal/agent-api/reactions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${proxy.proxyToken}`, "content-type": "application/json" },
      body: sentBody,
    });
    assert.equal(post.status, 200);
    assert.deepEqual(await post.json(), { ok: true, method: "POST", echoed: sentBody }, "the retry carries the body intact");
    assert.deepEqual(upstream.bodies, [sentBody, sentBody], "both sends carried the full body");
    assert.equal(upstream.renewCalls, 1);
    assert.deepEqual(upstream.seen, [
      `${OLD_KEY} POST /internal/agent-api/reactions`,
      `${NEW_KEY} POST /internal/agent-api/reactions`,
    ]);
    assert.equal(currentRunnerCredentialKey(OLD_KEY), NEW_KEY);

    upstream.seen.length = 0;
    const next = await fetch(`${proxy.proxyUrl}/internal/agent-api/server`, { headers: { Authorization: `Bearer ${proxy.proxyToken}` } });
    assert.equal(next.status, 200);
    assert.deepEqual(upstream.seen, [`${NEW_KEY} GET /internal/agent-api/server`], "the old key is no longer sent");
  });
});

// Teeth: renew on every 401 in fetchWithRunnerCredential -> a renewal is sent -> RED.
test("the proxy relays another 401 (a revoked key) without renewing", async () => {
  await withUpstream(async (upstream) => {
    upstream.revoked.add(OLD_KEY);
    const proxy = await registerProxy(upstream.serverUrl);
    const res = await fetch(`${proxy.proxyUrl}/internal/agent-api/server`, { headers: { Authorization: `Bearer ${proxy.proxyToken}` } });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "Invalid agent credential" });
    assert.equal(upstream.renewCalls, 0);
    assert.deepEqual(upstream.seen, [`${OLD_KEY} GET /internal/agent-api/server`]);
  });
});

// Teeth: drop the credential-expired tap in the proxy's stream loop -> the
// reconnect goes out with the old key first -> RED.
test("a wake-hint stream ending credential-expired renews the key, and the reconnect goes out with the new one", async () => {
  await withUpstream(async (upstream) => {
    const proxy = await registerProxy(upstream.serverUrl);
    const stream = await fetch(`${proxy.proxyUrl}/internal/agent-api/wake-hints/stream?since=latest`, { headers: { Authorization: `Bearer ${proxy.proxyToken}` } });
    assert.equal(stream.status, 200);
    assert.match(await stream.text(), /event: credential-expired/);
    await until(() => upstream.renewCalls === 1 && currentRunnerCredentialKey(OLD_KEY) === NEW_KEY, "renewed after the stream ended");

    upstream.seen.length = 0;
    const reconnect = await fetch(`${proxy.proxyUrl}/internal/agent-api/wake-hints/stream?since=latest`, { headers: { Authorization: `Bearer ${proxy.proxyToken}` } });
    assert.equal(reconnect.status, 200);
    assert.equal(await reconnect.text(), ": ka\n\n");
    assert.deepEqual(upstream.seen, [`${NEW_KEY} GET /internal/agent-api/wake-hints/stream`]);
    assert.equal(upstream.renewCalls, 1);
  });
});

// Teeth: drop fetchWithRunnerCredential from requestAgentApi / requestJson -> discovery fails -> RED.
test("managed MCP (runtime proxy and Pi tools) renews on an expired key and keeps the new one", async () => {
  await withUpstream(async (upstream) => {
    const warnings: string[] = [];
    const endpoint = await prepareManagedMcpRuntimeProxy({
      agentId: AGENT,
      launchId: LAUNCH,
      serverUrl: upstream.serverUrl,
      agentCredentialKey: OLD_KEY,
      onWarning: (message) => warnings.push(message),
    });
    assert.ok(endpoint, `managed MCP attached (${warnings.join("; ")})`);
    assert.deepEqual(upstream.seen, [
      `${OLD_KEY} GET /internal/agent-api/mcp/tools`,
      `${NEW_KEY} GET /internal/agent-api/mcp/tools`,
    ]);

    // A Pi session built with the launch's first key sends the renewed one.
    upstream.seen.length = 0;
    const tools = await createManagedMcpPiTools({
      serverUrl: upstream.serverUrl,
      agentCredentialKey: OLD_KEY,
      onWarning: (message) => warnings.push(message),
    });
    assert.deepEqual(tools, []);
    assert.deepEqual(warnings, []);
    assert.deepEqual(upstream.seen, [`${NEW_KEY} GET /internal/agent-api/mcp/tools`]);
    assert.equal(upstream.renewCalls, 1);
  });
});
