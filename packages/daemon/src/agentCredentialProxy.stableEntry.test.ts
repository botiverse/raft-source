// #proj-raft-computer:#58: a process that outlived its session calls the
// ended launch's transport (LAUNCH_SUPERSEDED / AGENT_NOT_RUNNING), or the
// agent's stable entry, which the proxy serves with the agent's current
// launch only.
import assert from "node:assert/strict";
import http from "node:http";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { ApiClient } from "../../cli/src/client";
import type { AgentContext } from "../../cli/src/auth/env";
import { CliError } from "../../cli/src/core/errors";
import { formatErrorEnvelope } from "../../cli/src/core/renderer";
import {
  __resetAgentCredentialProxyForTest,
  registerAgentCredentialProxy,
  unregisterAgentCredentialProxiesForAgent,
  unregisterAgentCredentialProxyForLaunch,
} from "./agentCredentialProxy";

const AGENT = "agent-simons";
const OLD_LAUNCH = "b5b6d993-0000-4000-8000-000000000001";
const NEW_LAUNCH = "360baf1f-0000-4000-8000-000000000002";
const STABLE_ENTRY = `/home/trader/.slock/cli-transport/${AGENT}/current/raft`;

type Seen = { authorization?: string; launchId?: string; entry?: string; agentId?: string };

async function withUpstream(fn: (serverUrl: string, seen: Seen[]) => Promise<void>): Promise<void> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    seen.push({
      authorization: req.headers.authorization,
      launchId: req.headers["x-agent-launch-id"] as string | undefined,
      entry: req.headers["x-raft-cli-entry"] as string | undefined,
      agentId: req.headers["x-agent-id"] as string | undefined,
    });
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await fn(`http://127.0.0.1:${address.port}`, seen);
  } finally {
    await __resetAgentCredentialProxyForTest();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function register(serverUrl: string, launchId: string, apiKey: string, tracer?: BasicTracer) {
  return registerAgentCredentialProxy({
    agentId: AGENT,
    launchId,
    serverUrl,
    apiKey,
    activeCapabilities: "read",
    stableEntryPath: STABLE_ENTRY,
    ...(tracer ? { tracer } : {}),
  });
}

function cli(proxyUrl: string, token: string, extra: Partial<AgentContext> = {}): ApiClient {
  return new ApiClient({
    agentId: AGENT,
    serverId: null,
    serverUrl: proxyUrl,
    token,
    clientMode: "managed-runner",
    secretSource: "agent-proxy-token-file",
    activeCapabilities: null,
    ...extra,
  });
}

async function cliFailure(client: ApiClient): Promise<CliError> {
  const error = await client.request("GET", "/internal/agent-api/server").then(
    () => assert.fail("the request must be refused"),
    (err: unknown) => err,
  );
  assert.ok(error instanceof CliError, String(error));
  return error;
}

test("an ended launch's transport answers LAUNCH_SUPERSEDED once a newer session runs, naming only the stable entry", async () => {
  await withUpstream(async (serverUrl, seen) => {
    const old = await register(serverUrl, OLD_LAUNCH, "sk_agent_old");
    // Session rotation: the daemon retires the agent's launches, then starts the new one.
    unregisterAgentCredentialProxiesForAgent(AGENT);
    const current = await register(serverUrl, NEW_LAUNCH, "sk_agent_new");

    const error = await cliFailure(cli(old.proxyUrl, old.proxyToken));
    assert.equal(error.code, "LAUNCH_SUPERSEDED");
    assert.equal(error.effect, "not_executed");
    const envelope = formatErrorEnvelope(error);
    assert.match(envelope, /^Error: This command ran through the Raft transport of a session of this agent that has ended/m);
    assert.match(envelope, /^Code: LAUNCH_SUPERSEDED$/m);
    assert.match(envelope, new RegExp(`^Next action: .*${STABLE_ENTRY.replace(/[/.]/g, "\\$&")} <command>`, "m"));
    // Never the newer launch, its credential, or where it lives.
    for (const secret of [NEW_LAUNCH, "360baf1f", current.proxyToken, "agent-proxy-tokens", "sk_agent_new"]) {
      assert.ok(!envelope.includes(secret), `the envelope must not name ${secret}`);
    }
    const raw = await fetch(`${old.proxyUrl}/internal/agent-api/server`, { headers: { Authorization: `Bearer ${old.proxyToken}` } });
    assert.equal(raw.status, 410);
    const body = await raw.text();
    for (const secret of [NEW_LAUNCH, current.proxyToken]) assert.ok(!body.includes(secret));
    // An older CLI renders the proxy's `error` and `suggestedNextAction` as they are.
    const parsed = JSON.parse(body) as Record<string, unknown>;
    assert.equal(parsed.code, "launch_superseded");
    assert.equal(parsed.stableEntry, STABLE_ENTRY);
    assert.equal(typeof parsed.suggestedNextAction, "string");
    assert.equal(seen.length, 0, "nothing reaches the Server");
  });
});

test("the stable entry is served by the agent's current launch and follows rotation", async () => {
  await withUpstream(async (serverUrl, seen) => {
    const first = await register(serverUrl, OLD_LAUNCH, "sk_agent_old");
    const stable = (token: string) => cli(first.proxyUrl, token, { entry: "stable_entry" });

    await stable(first.proxyToken).request("GET", "/internal/agent-api/server");
    assert.deepEqual(seen.at(-1), { authorization: "Bearer sk_agent_old", launchId: OLD_LAUNCH, entry: "stable_entry", agentId: AGENT });

    // A newer launch registers while the old one is still live: the entry is served by the newer one.
    const second = await register(serverUrl, NEW_LAUNCH, "sk_agent_new");
    await stable(first.proxyToken).request("GET", "/internal/agent-api/server");
    assert.deepEqual(seen.at(-1), { authorization: "Bearer sk_agent_new", launchId: NEW_LAUNCH, entry: "stable_entry", agentId: AGENT });

    // The old launch ends; the entry (rewritten with the new launch's token) keeps working.
    unregisterAgentCredentialProxyForLaunch({ agentId: AGENT, launchId: OLD_LAUNCH });
    await stable(second.proxyToken).request("GET", "/internal/agent-api/server");
    assert.deepEqual(seen.at(-1), { authorization: "Bearer sk_agent_new", launchId: NEW_LAUNCH, entry: "stable_entry", agentId: AGENT });

    // An ended launch's token never works again, stable entry or not.
    const error = await cliFailure(stable(first.proxyToken));
    assert.equal(error.code, "LAUNCH_SUPERSEDED");

    // A launch-wrapper request is not attributed to the stable entry, whatever header the caller sends.
    const forged = await fetch(`${second.proxyUrl}/internal/agent-api/server`, {
      headers: { Authorization: `Bearer ${second.proxyToken}`, "X-Raft-Cli-Entry": "something-else" },
    });
    assert.equal(forged.status, 200);
    assert.equal(seen.at(-1)?.entry, undefined);
  });
});

test("the stable entry stops with the agent's last launch: stopped, deleted or removed", async () => {
  await withUpstream(async (serverUrl, seen) => {
    const launch = await register(serverUrl, NEW_LAUNCH, "sk_agent_new");
    unregisterAgentCredentialProxiesForAgent(AGENT);

    const error = await cliFailure(cli(launch.proxyUrl, launch.proxyToken, { entry: "stable_entry" }));
    assert.equal(error.code, "AGENT_NOT_RUNNING");
    const envelope = formatErrorEnvelope(error);
    assert.match(envelope, /^Code: AGENT_NOT_RUNNING$/m);
    assert.match(envelope, /no running session on this Computer/);
    // The launch wrapper's own transport says the same.
    assert.equal((await cliFailure(cli(launch.proxyUrl, launch.proxyToken))).code, "AGENT_NOT_RUNNING");
    assert.equal(seen.length, 0);
  });
});

test("a stable-entry request naming another agent than its credential's is refused", async () => {
  await withUpstream(async (serverUrl, seen) => {
    const launch = await register(serverUrl, NEW_LAUNCH, "sk_agent_new");

    const error = await cliFailure(cli(launch.proxyUrl, launch.proxyToken, { entry: "stable_entry", agentId: "agent-other" }));
    assert.equal(error.code, "AGENT_ID_MISMATCH");

    const missing = await fetch(`${launch.proxyUrl}/internal/agent-api/server`, {
      headers: { Authorization: `Bearer ${launch.proxyToken}`, "X-Raft-Cli-Entry": "stable_entry" },
    });
    assert.equal(missing.status, 403);
    assert.equal((await missing.json() as { code?: string }).code, "agent_proxy_agent_mismatch");
    assert.equal(seen.length, 0);
  });
});

test("the proxy span says which entry sent the request", async () => {
  await withUpstream(async (serverUrl) => {
    const sink = new MemoryTraceSink();
    const tracer = new BasicTracer({ sink });
    const launch = await register(serverUrl, NEW_LAUNCH, "sk_agent_new", tracer);

    await cli(launch.proxyUrl, launch.proxyToken, { entry: "stable_entry" }).request("GET", "/internal/agent-api/server");
    await cli(launch.proxyUrl, launch.proxyToken).request("GET", "/internal/agent-api/server");
    const spans = sink.getAllSpans().filter((span) => span.name === "daemon.agent_proxy.request");
    assert.deepEqual(spans.map((span) => span.attrs?.via), ["stable_entry", "launch"]);
  });
});

test("a token the proxy never issued keeps its invalid-token answer", async () => {
  await withUpstream(async (serverUrl) => {
    const launch = await register(serverUrl, NEW_LAUNCH, "sk_agent_new");
    const response = await fetch(`${launch.proxyUrl}/internal/agent-api/server`, { headers: { Authorization: "Bearer sap_never_issued" } });
    assert.equal(response.status, 401);
    assert.equal((await response.json() as { code?: string }).code, "invalid_agent_proxy_token");
  });
});
