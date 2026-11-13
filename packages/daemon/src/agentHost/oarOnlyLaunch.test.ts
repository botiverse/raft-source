import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentConfig } from "@botiverse/raft-shared";
import type { SpawnContext } from "../drivers/types";
import { OAR_ONLY_MANAGED_MCP, oarOnlyLaunch, prepareOarOnlyLaunch, QWEN_MIN_HTTP_MCP_VERSION, qwenTakesHttpMcp } from "./oarOnlyLaunch";
import { __resetManagedMcpRuntimeProxyForTest, unregisterManagedMcpRuntimeProxyForLaunch } from "../managedMcpRuntimeProxy";
import { RuntimeExecutableNotFoundError } from "../spawnFailureErrors";

const ctx = (overrides: Partial<AgentConfig> = {}): SpawnContext => ({
  agentId: "agent-1",
  config: {
    name: "q", displayName: null, description: null, model: "qwen3-coder-plus", runtime: "qwen", reasoningEffort: "high",
    envVars: null, sessionId: "qwen-session-1", serverUrl: "http://localhost:3001", authToken: "", ...overrides,
  },
  standingPrompt: "standing instructions",
  prompt: "first input",
  workingDirectory: "/work/agent-1",
  slockCliPath: "/bin/raft",
  daemonApiKey: "sk_machine_test",
});

const installation = { kind: "available", via: "executable", command: "/opt/qwen" } as const;

test("an OAR-only launch: OAR's executable, the standing prompt as system prompt, model, effort and resume", () => {
  assert.deepEqual(oarOnlyLaunch("qwen", ctx(), { PATH: "/bin" }, installation, {}), {
    runtimeId: "qwen",
    installation,
    options: {
      cwd: "/work/agent-1",
      env: { PATH: "/bin" },
      systemPrompt: "standing instructions",
      model: "qwen3-coder-plus",
      effort: "high",
      resume: "qwen-session-1",
    },
    busyDelivery: "after_turn",
  });
  const fresh = oarOnlyLaunch("qoder", ctx({ runtime: "qoder", model: "default", sessionId: null }), {}, installation, {});
  assert.equal(fresh.options.model, undefined);
  assert.equal(fresh.options.effort, undefined, "no effort without a chosen model");
  assert.equal(fresh.options.resume, undefined);
});

test("managed MCP: Qwen takes it as a session MCP server; Qoder never does (OAR would write the token to a file the agent can read)", () => {
  const managedMcp = { name: "rmAbc123", url: "http://127.0.0.1:4100/mcp/qwen-token", endpointUrl: "http://127.0.0.1:4100/mcp", token: "qwen-token" };
  const qwen = oarOnlyLaunch("qwen", ctx(), { PATH: "/bin" }, installation, {}, managedMcp);
  assert.deepEqual(qwen.options.mcpServers, [
    { name: "rmAbc123", type: "http", url: "http://127.0.0.1:4100/mcp", headers: { Authorization: "Bearer qwen-token" } },
  ]);
  assert.equal(qwen.options.resume, "qwen-session-1", "given again on resume");
  assert.equal(JSON.stringify(qwen.options.env).includes("qwen-token"), false);
  assert.equal("mcpServers" in oarOnlyLaunch("qwen", ctx(), {}, installation, {}).options, false, "none without managed MCP");
  assert.deepEqual(OAR_ONLY_MANAGED_MCP, { qwen: true, qoder: false, codebuddy: false });
  assert.throws(() => oarOnlyLaunch("codebuddy", ctx({ runtime: "codebuddy" }), {}, installation, {}, managedMcp), /takes no managed MCP/);
  assert.throws(() => oarOnlyLaunch("qoder", ctx({ runtime: "qoder" }), {}, installation, {}, managedMcp), /takes no managed MCP/);
  assert.equal("mcpServers" in oarOnlyLaunch("qoder", ctx({ runtime: "qoder" }), {}, installation, {}).options, false);
});

test("busy deliveries: Qoder steers natively, Qwen's and CodeBuddy's wait for the turn end", () => {
  assert.equal(oarOnlyLaunch("qoder", ctx({ runtime: "qoder" }), {}, installation, {}).busyDelivery, "now");
  assert.equal(oarOnlyLaunch("qwen", ctx(), {}, installation, {}).busyDelivery, "after_turn");
  assert.equal(oarOnlyLaunch("codebuddy", ctx({ runtime: "codebuddy" }), {}, installation, {}).busyDelivery, "after_turn");
});

test("a CodeBuddy launch: the standing prompt as its system prompt, the chosen model and its thought level, resume", () => {
  const launch = oarOnlyLaunch("codebuddy", ctx({ runtime: "codebuddy", model: "cb-model", reasoningEffort: "medium", sessionId: "cb-session-1" }), {}, installation, {});
  assert.deepEqual(launch.options, {
    cwd: "/work/agent-1",
    env: {},
    systemPrompt: "standing instructions",
    model: "cb-model",
    effort: "medium",
    resume: "cb-session-1",
  });
});

test("prepareOarOnlyLaunch: the executable OAR's lookup finds, the agent token out of the runtime's environment", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oar-only-launch-"));
  const qwen = path.join(root, "qwen");
  writeFileSync(qwen, `#!${process.execPath}\nprocess.stdout.write("0.4.0\\n");\n`);
  chmodSync(qwen, 0o755);
  const previous = { bin: process.env.OAR_QWEN_BIN, key: process.env.SLOCK_AGENT_TOKEN };
  process.env.OAR_QWEN_BIN = qwen;
  process.env.SLOCK_AGENT_TOKEN = "sk_agent_secret";
  try {
    const launch = await prepareOarOnlyLaunch("qwen", { ...ctx(), workingDirectory: root });
    assert.equal(launch.installation.kind === "available" && launch.installation.via === "executable" && launch.installation.command, qwen);
    assert.equal(launch.options.env?.SLOCK_AGENT_TOKEN, null, "the agent token is removed, never passed");
    assert.equal(launch.options.systemPrompt, "standing instructions");
  } finally {
    if (previous.bin === undefined) delete process.env.OAR_QWEN_BIN; else process.env.OAR_QWEN_BIN = previous.bin;
    if (previous.key === undefined) delete process.env.SLOCK_AGENT_TOKEN; else process.env.SLOCK_AGENT_TOKEN = previous.key;
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareOarOnlyLaunch: no executable is runtime_not_found, named for the owner", async () => {
  const previous = process.env.OAR_QWEN_BIN;
  process.env.OAR_QWEN_BIN = path.join(os.tmpdir(), `no-such-qwen-${process.pid}`);
  try {
    await assert.rejects(prepareOarOnlyLaunch("qwen", ctx()), (error: unknown) =>
      error instanceof RuntimeExecutableNotFoundError && /Qwen Code CLI \(qwen\) was not found/.test(error.message));
  } finally {
    if (previous === undefined) delete process.env.OAR_QWEN_BIN; else process.env.OAR_QWEN_BIN = previous;
  }
});

test("Qwen takes the managed MCP entry only from the oldest version known to take HTTP MCP servers", () => {
  assert.equal(QWEN_MIN_HTTP_MCP_VERSION, "0.26.0");
  for (const version of ["0.26.0", "0.26.9", "0.27.0", "1.0.0"]) assert.equal(qwenTakesHttpMcp(version), true, version);
  for (const version of ["0.25.9", "0.4.0", "not a version", "", null]) assert.equal(qwenTakesHttpMcp(version), false, String(version));
});

test("prepareOarOnlyLaunch: a Qwen below the HTTP MCP floor (or unreadable) starts without managed MCP and mints no token; at it, attaches", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oar-only-launch-mcp-"));
  const qwen = path.join(root, "qwen");
  const previousBin = process.env.OAR_QWEN_BIN;
  const originalFetch = globalThis.fetch;
  process.env.OAR_QWEN_BIN = qwen;
  // The Server's snapshot: this agent has one managed MCP tool.
  globalThis.fetch = (async () => new Response(JSON.stringify({
    catalogVersion: 1,
    tools: [{
      mcpServerId: "22222222-2222-4222-8222-222222222222", serverName: "Docs", toolName: "search", runtimeName: "mcp_docs_search",
      inputSchema: { type: "object" }, configVersion: 1, assignmentVersion: 1,
    }],
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  const launchCtx = { ...ctx({ agentCredentialKey: "sk_agent_test", serverUrl: "https://raft.test" }), launchId: "launch-qwen-mcp", workingDirectory: root };
  const withVersion = (version: string) => {
    writeFileSync(qwen, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(`${version}\n`)});\n`);
    chmodSync(qwen, 0o755);
  };
  try {
    withVersion("0.25.9");
    const old = await prepareOarOnlyLaunch("qwen", launchCtx);
    assert.equal("mcpServers" in old.options, false, "too old: no entry, the start goes on");
    assert.equal(unregisterManagedMcpRuntimeProxyForLaunch({ agentId: "agent-1", launchId: "launch-qwen-mcp" }), 0, "no token was minted");

    withVersion("0.26.9");
    const current = await prepareOarOnlyLaunch("qwen", launchCtx);
    assert.equal(current.options.mcpServers?.length, 1);
    const [server] = current.options.mcpServers!;
    assert(server && "headers" in server);
    assert.match(server.headers!.Authorization!, /^Bearer \S+$/u);
    assert.equal(unregisterManagedMcpRuntimeProxyForLaunch({ agentId: "agent-1", launchId: "launch-qwen-mcp" }), 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousBin === undefined) delete process.env.OAR_QWEN_BIN; else process.env.OAR_QWEN_BIN = previousBin;
    await __resetManagedMcpRuntimeProxyForTest();
    rmSync(root, { recursive: true, force: true });
  }
});
