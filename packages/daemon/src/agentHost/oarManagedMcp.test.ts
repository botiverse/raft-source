import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentConfig, ManagedMcpRuntimeSnapshot } from "@botiverse/raft-shared";
import type { SpawnContext } from "../drivers/types";
import { __resetManagedMcpRuntimeProxyForTest, unregisterManagedMcpRuntimeProxyForLaunch } from "../managedMcpRuntimeProxy";
import { managedMcpSessionOptions, managedMcpSessionServer, prepareOarManagedMcp } from "./oarManagedMcp";

const ctx = (overrides: Partial<AgentConfig> = {}): SpawnContext => ({
  agentId: "agent-oar-mcp",
  launchId: "launch-oar-mcp",
  processInstanceId: "process-oar-mcp",
  config: {
    name: "g", displayName: null, description: null, model: "grok-4.5", runtime: "grok", reasoningEffort: null,
    envVars: null, sessionId: null, serverUrl: "https://raft.test", authToken: "", agentCredentialKey: "sk_agent_test", ...overrides,
  },
  standingPrompt: "standing instructions",
  prompt: "first input",
  workingDirectory: "/work/agent-1",
  slockCliPath: "/bin/raft",
  daemonApiKey: "sk_machine_test",
});

const tool = {
  mcpServerId: "22222222-2222-4222-8222-222222222222",
  serverName: "Docs",
  toolName: "search",
  runtimeName: "mcp_docs_search",
  description: "Search docs",
  inputSchema: { type: "object" as const },
  configVersion: 1,
  assignmentVersion: 1,
};

/** Runs `prepareOarManagedMcp` against a Server whose snapshot is `snapshot`. */
async function prepareWith(snapshot: ManagedMcpRuntimeSnapshot, context = ctx(), admit?: () => boolean | Promise<boolean>) {
  serverSnapshot = snapshot;
  return await prepareOarManagedMcp(context, admit);
}

/**
 * The Server, for the whole test: the proxy reads the snapshot again when a
 * runtime lists tools, so the stub stays in place until the test ends. Every
 * other URL (the proxy on loopback, or a stray request the network guard must
 * catch) goes to the real, guarded fetch.
 */
let serverSnapshot: ManagedMcpRuntimeSnapshot | null = null;
const originalFetch = globalThis.fetch;
beforeEach(() => {
  serverSnapshot = null;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    // Only the Server (ctx's serverUrl) is answered; anything else goes to the guarded fetch.
    if (url.origin !== "https://raft.test") return originalFetch(input, init);
    return new Response(JSON.stringify(serverSnapshot ?? { catalogVersion: 1, tools: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await __resetManagedMcpRuntimeProxyForTest();
});

test("the session MCP entry: HTTP to the proxy's bare endpoint, the token only in a bearer header", () => {
  const endpoint = { name: "rmAbc123", endpointUrl: "http://127.0.0.1:4100/mcp", token: "launch-token" };
  const server = managedMcpSessionServer(endpoint);
  assert.deepEqual(server, {
    name: "rmAbc123",
    type: "http",
    url: "http://127.0.0.1:4100/mcp",
    headers: { Authorization: "Bearer launch-token" },
  });
  assert.equal("url" in server && server.url.includes("launch-token"), false, "never in the URL");
  assert.deepEqual(managedMcpSessionOptions(endpoint), { mcpServers: [server] });
  assert.deepEqual(managedMcpSessionOptions(null), {}, "no managed MCP: no mcpServers key at all");
});

test("an agent without managed MCP tools gets no server and no token is minted (a runtime that had none launches as before)", async () => {
  let admitted = 0;
  assert.equal(await prepareWith({ catalogVersion: 1, tools: [] }, ctx(), () => { admitted += 1; return true; }), null);
  assert.equal(admitted, 0, "the runtime's own condition is not even asked");
  // Nothing was registered for the launch: there is no token to revoke.
  assert.equal(unregisterManagedMcpRuntimeProxyForLaunch({ agentId: "agent-oar-mcp", launchId: "launch-oar-mcp" }), 0);
  // No Server URL or credential: discovery is skipped, nothing attached.
  assert.equal(await prepareOarManagedMcp(ctx({ agentCredentialKey: null })), null);
});

test("a runtime's own refusal (e.g. a Qwen too old for HTTP MCP) registers nothing either", async () => {
  assert.equal(await prepareWith({ catalogVersion: 1, tools: [tool] }, ctx(), async () => false), null);
  assert.equal(unregisterManagedMcpRuntimeProxyForLaunch({ agentId: "agent-oar-mcp", launchId: "launch-oar-mcp" }), 0);
});

test("an agent with managed MCP tools gets the launch's proxy; the entry reaches its tools, and launch cleanup revokes it", async () => {
  const endpoint = await prepareWith({ catalogVersion: 1, tools: [tool] });
  assert(endpoint);
  const server = managedMcpSessionServer(endpoint);
  assert("headers" in server);

  // What a runtime does with the entry: connect with its headers and list.
  const connect = async () => {
    const client = new Client({ name: "oar-managed-mcp-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }));
    return client;
  };
  const client = await connect();
  try {
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 1);
  } finally {
    await client.close();
  }

  // Without the header the proxy does not know the caller.
  const anonymous = await fetch(server.url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(anonymous.status, 404);

  // The OAR host's launch cleanup (cleanupLaunchProxiesForLaunch) revokes the token.
  assert.equal(unregisterManagedMcpRuntimeProxyForLaunch({ agentId: "agent-oar-mcp", launchId: "launch-oar-mcp" }), 1);
  await assert.rejects(connect());
});
