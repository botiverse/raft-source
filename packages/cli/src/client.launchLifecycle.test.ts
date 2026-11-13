// #proj-raft-computer:#58: the daemon proxy's refusals for an ended launch,
// and the stable entry's header.
import assert from "node:assert/strict";
import http from "node:http";
import { loadAgentContext, type AgentContext } from "./auth/env";
import { ApiClient } from "./client";
import { CliError } from "./core/errors";
import { formatErrorEnvelope } from "./core/renderer";

async function withProxy(
  answer: { status: number; body: unknown },
  fn: (url: string, seen: http.IncomingHttpHeaders[]) => Promise<void>,
): Promise<void> {
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers);
    res.writeHead(answer.status, { "content-type": "application/json" }).end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await fn(`http://127.0.0.1:${address.port}`, seen);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const ctx = (serverUrl: string, extra: Partial<AgentContext> = {}): AgentContext => ({
  agentId: "agent-1",
  serverId: null,
  serverUrl,
  token: "sap_x",
  clientMode: "managed-runner",
  secretSource: "agent-proxy-token-file",
  activeCapabilities: null,
  ...extra,
});

test("RAFT_CLI_ENTRY=stable_entry marks a managed context, and only that value", () => {
  const env = { SLOCK_AGENT_ID: "agent-1", SLOCK_SERVER_URL: "https://s", SLOCK_AGENT_PROXY_URL: "http://127.0.0.1:1", SLOCK_AGENT_PROXY_TOKEN: "sap_x" };
  assert.equal(loadAgentContext({ ...env, RAFT_CLI_ENTRY: "stable_entry" }).entry, "stable_entry");
  assert.equal(loadAgentContext({ ...env, RAFT_CLI_ENTRY: "other" }).entry, undefined);
  assert.equal(loadAgentContext(env).entry, undefined);
});

test("the stable entry names itself to the proxy; a launch wrapper does not", async () => {
  await withProxy({ status: 200, body: { ok: true } }, async (url, seen) => {
    await new ApiClient(ctx(url, { entry: "stable_entry" })).request("GET", "/internal/agent-api/server");
    await new ApiClient(ctx(url)).request("GET", "/internal/agent-api/server");
    assert.equal(seen[0]?.["x-raft-cli-entry"], "stable_entry");
    assert.equal(seen[0]?.["x-agent-id"], "agent-1");
    assert.equal(seen[1]?.["x-raft-cli-entry"], undefined);
  });
});

test("LAUNCH_SUPERSEDED from the proxy is one envelope for every command", async () => {
  await withProxy({
    status: 410,
    body: {
      error: "This command ran through the Raft transport of a session of this agent that has ended; a newer session replaced it. Nothing was sent.",
      code: "launch_superseded",
      suggestedNextAction: "Run `/h/.slock/cli-transport/agent-1/current/raft <command>` instead.",
      stableEntry: "/h/.slock/cli-transport/agent-1/current/raft",
    },
  }, async (url) => {
    const error = await new ApiClient(ctx(url)).request("GET", "/internal/agent-api/server").then(
      () => assert.fail("must throw"),
      (err: unknown) => err,
    );
    assert.ok(error instanceof CliError);
    assert.equal(error.code, "LAUNCH_SUPERSEDED");
    assert.equal(error.exitCode, 1);
    assert.deepEqual(error.details, { stableEntry: "/h/.slock/cli-transport/agent-1/current/raft" });
    const text = formatErrorEnvelope(error);
    assert.match(text, /^Error: This command ran through the Raft transport/m);
    assert.match(text, /^Code: LAUNCH_SUPERSEDED$/m);
    assert.match(text, /^Next action: Run `\/h\/\.slock\/cli-transport\/agent-1\/current\/raft <command>` instead\.$/m);
  });
});

test("a self-hosted CLI never reads a Server answer as a proxy lifecycle refusal", async () => {
  await withProxy({ status: 410, body: { error: "gone", code: "launch_superseded" } }, async (url) => {
    const response = await new ApiClient(ctx(url, { clientMode: "self-hosted-runner", secretSource: "profile-credential-file" }))
      .request("GET", "/internal/agent-api/server");
    assert.equal(response.ok, false);
    assert.equal(response.status, 410);
  });
});
