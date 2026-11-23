import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentConfig } from "@botiverse/raft-shared";
import type { SpawnContext } from "../drivers/types";
import type { SessionCapabilityDeclaration } from "@botiverse/oar";
import { dshRuntime } from "@botiverse/oar/runtimes/dsh";
import { qoderRuntime } from "@botiverse/oar/runtimes/qoder";
import { qwenRuntime } from "@botiverse/oar/runtimes/qwen";
import { oarOnlyLaunch, oarOnlyLaunchPolicy, prepareOarOnlyLaunch, RAFT_ADMITS_MANAGED_MCP } from "./oarOnlyLaunch";
import { oarInstalledSessionCapabilities } from "../oarLoader";
import type { OarOnlyRuntimeId } from "../drivers/index";
import { __resetManagedMcpRuntimeProxyForTest, unregisterManagedMcpRuntimeProxyForLaunch } from "../managedMcpRuntimeProxy";
import { RuntimeExecutableNotFoundError } from "../spawnFailureErrors";
import { RuntimeVersionTooOldError } from "../runtimeLaunchVersion";
import { OarOnlyDriver } from "../drivers/oarOnly";

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
/** An installation whose version OAR read (its capability answer is per version). */
const installationAt = (version: string) => ({ ...installation, version });

const REAL_RUNTIMES = { qwen: qwenRuntime, qoder: qoderRuntime, dsh: dshRuntime } as const;
/** OAR's real capability answer for this runtime's installation. */
const REAL_VERSIONS = { qwen: "0.26.9", qoder: "1.1.78", dsh: "0.1.0" } as const;
const realCaps = (runtimeId: OarOnlyRuntimeId, version: string = REAL_VERSIONS[runtimeId]): SessionCapabilityDeclaration =>
  oarInstalledSessionCapabilities(REAL_RUNTIMES[runtimeId], installationAt(version) as never);

test("launch policy from OAR's capability answer alone: steer false holds busy input for the turn end, steer true or unknown steers", () => {
  // Fake capability answers: busy delivery reads no runtime id at all.
  const fakeId = "dsh" as const;
  assert.equal(oarOnlyLaunchPolicy(fakeId, { steer: false }).busyDelivery, "after_turn");
  assert.equal(oarOnlyLaunchPolicy(fakeId, { steer: true }).busyDelivery, "now");
  assert.equal(oarOnlyLaunchPolicy(fakeId, {}).busyDelivery, "now", "unknown is not false");
});

test("launch policy from OAR's capability answer alone: managed MCP needs a verified http transport and no MCP or credentials refusal", () => {
  // Fake capability answers on the one id Raft admits, so only OAR's answer varies.
  const fakeId = "qwen" as const;
  const http = { mcpTransports: ["stdio", "http"] } as const;
  assert.ok(RAFT_ADMITS_MANAGED_MCP.has(fakeId));
  assert.equal(oarOnlyLaunchPolicy(fakeId, http).managedMcp, true);
  assert.equal(oarOnlyLaunchPolicy(fakeId, {}).managedMcp, false, "transports unverified (absent) is not http");
  assert.equal(oarOnlyLaunchPolicy(fakeId, { mcpTransports: ["stdio"] }).managedMcp, false, "stdio only");
  assert.equal(oarOnlyLaunchPolicy(fakeId, { mcpTransports: [] }).managedMcp, false, "MCP refused");
  assert.equal(oarOnlyLaunchPolicy(fakeId, { ...http, refusedSessionOptions: { fork: "no fork" } }).managedMcp, true, "an unrelated refusal");
  assert.equal(oarOnlyLaunchPolicy(fakeId, { ...http, refusedSessionOptions: { mcpServerCredentials: "no credentials" } }).managedMcp, false);
  assert.equal(oarOnlyLaunchPolicy(fakeId, { ...http, refusedSessionOptions: { mcpServers: "no MCP" } }).managedMcp, false);
  const managedMcp = { name: "rmAbc123", url: "http://127.0.0.1:4100/mcp/t", endpointUrl: "http://127.0.0.1:4100/mcp", token: "t" };
  assert.throws(() => oarOnlyLaunch(fakeId, ctx(), {}, installation, { refusedSessionOptions: { mcpServerCredentials: "no" } }, {}, managedMcp), /takes no managed MCP/);
});

test("the real OAR qwen, qoder and dsh keep their busy delivery and managed MCP (OAR 0.124.0 capability answers)", () => {
  const decided = Object.fromEntries((["qwen", "qoder", "dsh"] as const).map((id) => [id, oarOnlyLaunchPolicy(id, realCaps(id))]));
  assert.deepEqual(decided, {
    qwen: { busyDelivery: "after_turn", managedMcp: true },
    qoder: { busyDelivery: "now", managedMcp: false },
    dsh: { busyDelivery: "now", managedMcp: false },
  });
  // Why: qwen declares steer false; qoder steer true; dsh leaves steer to its handshake and refuses credentialed MCP entries.
  assert.equal(realCaps("qwen").steer, false);
  assert.equal(realCaps("qoder").steer, true);
  assert.equal(realCaps("dsh").steer, undefined);
  assert.ok(realCaps("dsh").refusedSessionOptions?.mcpServerCredentials);
  // Qoder declares http and refuses no credentials: withheld by Raft's allow-list only, until OAR's audit #core:#347 (#oar-raft:#39).
  assert.deepEqual(realCaps("qoder").mcpTransports, ["stdio", "http"]);
  assert.equal(realCaps("qoder").refusedSessionOptions?.mcpServerCredentials, undefined);
  // DSH declares stdio only.
  assert.deepEqual(realCaps("dsh").mcpTransports, ["stdio"]);
  assert.deepEqual([...RAFT_ADMITS_MANAGED_MCP], ["qwen"]);
});

test("Qwen's HTTP MCP floor comes from OAR's answer for the installed version: 0.26.0 and later take it, older or unreadable do not", () => {
  for (const version of ["0.26.0", "0.26.9", "0.27.0"]) assert.equal(oarOnlyLaunchPolicy("qwen", realCaps("qwen", version)).managedMcp, true, version);
  assert.equal(oarOnlyLaunchPolicy("qwen", realCaps("qwen", "0.25.9")).managedMcp, false, "0.25.9 declares stdio only");
  assert.equal(oarOnlyLaunchPolicy("qwen", oarInstalledSessionCapabilities(qwenRuntime, installation)).managedMcp, false, "no version read: transports unknown");
});

test("managed MCP fails closed: an OAR-only runtime Raft has not checked gets no token even when OAR declares http and refuses nothing", () => {
  assert.equal(oarOnlyLaunchPolicy("qoder", { mcpTransports: ["stdio", "http"] }).managedMcp, false);
  assert.equal(oarOnlyLaunchPolicy("dsh", { mcpTransports: ["stdio", "http"] }).managedMcp, false);
});

test("an OAR-only launch: OAR's executable, the standing prompt as system prompt, model, effort and resume", () => {
  assert.deepEqual(oarOnlyLaunch("qwen", ctx(), { PATH: "/bin" }, installation, realCaps("qwen"), {}), {
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
  const fresh = oarOnlyLaunch("qoder", ctx({ runtime: "qoder", model: "default", sessionId: null }), {}, installation, realCaps("qoder"), {});
  assert.equal(fresh.options.model, undefined);
  assert.equal(fresh.options.effort, undefined, "no effort without a chosen model");
  assert.equal(fresh.options.resume, undefined);
});

test("managed MCP: Qwen takes it as a session MCP server; Qoder never does (OAR would write the token to a file the agent can read)", () => {
  const managedMcp = { name: "rmAbc123", url: "http://127.0.0.1:4100/mcp/qwen-token", endpointUrl: "http://127.0.0.1:4100/mcp", token: "qwen-token" };
  const qwen = oarOnlyLaunch("qwen", ctx(), { PATH: "/bin" }, installation, realCaps("qwen"), {}, managedMcp);
  assert.deepEqual(qwen.options.mcpServers, [
    { name: "rmAbc123", type: "http", url: "http://127.0.0.1:4100/mcp", headers: { Authorization: "Bearer qwen-token" } },
  ]);
  assert.equal(qwen.options.resume, "qwen-session-1", "given again on resume");
  assert.equal(JSON.stringify(qwen.options.env).includes("qwen-token"), false);
  assert.equal("mcpServers" in oarOnlyLaunch("qwen", ctx(), {}, installation, realCaps("qwen"), {}).options, false, "none without managed MCP");
  // OAR takes stdio servers only on DSH; Raft's entry is HTTP with a header.
  assert.throws(() => oarOnlyLaunch("dsh", ctx({ runtime: "dsh" }), {}, installation, realCaps("dsh"), {}, managedMcp), /takes no managed MCP/);
  assert.throws(() => oarOnlyLaunch("qoder", ctx({ runtime: "qoder" }), {}, installation, realCaps("qoder"), {}, managedMcp), /takes no managed MCP/);
  assert.equal("mcpServers" in oarOnlyLaunch("qoder", ctx({ runtime: "qoder" }), {}, installation, realCaps("qoder"), {}).options, false);
});

test("busy deliveries: Qoder steers natively, Qwen's wait for the turn end; DSH steers where its session has steer (the host checks)", () => {
  assert.equal(oarOnlyLaunch("qoder", ctx({ runtime: "qoder" }), {}, installation, realCaps("qoder"), {}).busyDelivery, "now");
  assert.equal(oarOnlyLaunch("qwen", ctx(), {}, installation, realCaps("qwen"), {}).busyDelivery, "after_turn");
  assert.equal(oarOnlyLaunch("dsh", ctx({ runtime: "dsh" }), {}, installation, realCaps("dsh"), {}).busyDelivery, "now");
});

test("a DSH launch: the standing prompt as its system prompt (given again on resume), the provider/model and its effort", () => {
  const launch = oarOnlyLaunch("dsh", ctx({ runtime: "dsh", model: "deepseek/deepseek-v4", reasoningEffort: "high", sessionId: "dsh-session-1" }), {}, installation, realCaps("dsh"), {});
  assert.equal(launch.runtimeId, "dsh");
  assert.deepEqual(launch.options, {
    cwd: "/work/agent-1",
    env: {},
    systemPrompt: "standing instructions",
    model: "deepseek/deepseek-v4",
    effort: "high",
    resume: "dsh-session-1",
  });
  const fresh = oarOnlyLaunch("dsh", ctx({ runtime: "dsh", model: "default", sessionId: null }), {}, installation, realCaps("dsh"), {});
  assert.equal(fresh.options.model, undefined, "dsh's own default model");
  assert.equal(fresh.options.effort, undefined);
});

test("DSH detection counts a `dsh` on PATH only when its --version is a semver: Debian's distributed shell (/usr/bin/dsh) is not DeepSeek Harness", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oar-only-dsh-probe-"));
  const probe = (versionOutput: string) => {
    writeFileSync(path.join(root, "dsh"), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(versionOutput)});\n`);
    chmodSync(path.join(root, "dsh"), 0o755);
    return new OarOnlyDriver("dsh", { env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}` } }).probe();
  };
  try {
    assert.deepEqual(probe("0.2.2-rc.5\n"), { available: true, version: "0.2.2-rc.5" });
    assert.equal(probe("v0.3.0\n").available, true);
    const debian = probe("Distributed Shell / Dancer's shell. version 0.25.10\n");
    assert.equal(debian.available, false);
    assert.equal(debian.unavailableReason, "not_installed");
    assert.match(debian.diagnostic ?? "", /does not report a DeepSeek Harness version/);
    assert.equal(probe("").available, false, "no version at all");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a DSH below OAR's floor (0.2.1-rc.5) reads as too old, not as missing: the start and the model list both say update", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oar-only-dsh-floor-"));
  const dsh = path.join(root, "dsh");
  writeFileSync(dsh, `#!${process.execPath}\nprocess.stdout.write("0.2.0\\n");\n`);
  chmodSync(dsh, 0o755);
  const previous = process.env.OAR_DSH_BIN;
  process.env.OAR_DSH_BIN = dsh;
  try {
    await assert.rejects(prepareOarOnlyLaunch("dsh", ctx({ runtime: "dsh", model: "default" })), (error: unknown) =>
      error instanceof RuntimeVersionTooOldError && error.actualVersion === "0.2.0" && error.testedGoodVersion === "0.2.1-rc.5");
    assert.deepEqual(await new OarOnlyDriver("dsh").detectModels(), { kind: "error", retryable: true, code: "protocol_unsupported" });
  } finally {
    if (previous === undefined) delete process.env.OAR_DSH_BIN; else process.env.OAR_DSH_BIN = previous;
    rmSync(root, { recursive: true, force: true });
  }
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

test("a Qoder below OAR's floor (OAR 0.115: 1.1.78) reads as too old, not as missing: the start and the model list both say update", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oar-only-qoder-floor-"));
  const qoder = path.join(root, "qodercli");
  writeFileSync(qoder, `#!${process.execPath}\nprocess.stdout.write("1.0.22\\n");\n`);
  chmodSync(qoder, 0o755);
  const previous = process.env.OAR_QODER_BIN;
  process.env.OAR_QODER_BIN = qoder;
  try {
    await assert.rejects(prepareOarOnlyLaunch("qoder", ctx({ runtime: "qoder", model: "default" })), (error: unknown) =>
      error instanceof RuntimeVersionTooOldError && error.actualVersion === "1.0.22" && error.testedGoodVersion === "1.1.78");
    assert.deepEqual(await new OarOnlyDriver("qoder").detectModels(), { kind: "error", retryable: true, code: "protocol_unsupported" });
  } finally {
    if (previous === undefined) delete process.env.OAR_QODER_BIN; else process.env.OAR_QODER_BIN = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareOarOnlyLaunch: a Qwen below OAR's HTTP MCP floor starts without managed MCP and mints no token; at it, attaches", async () => {
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
  // A new file per version: OAR caches a version per file (path, inode, size, times).
  const withVersion = (version: string) => {
    const bin = path.join(root, `qwen-${version}`);
    writeFileSync(bin, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(`${version}\n`)});\n`);
    chmodSync(bin, 0o755);
    process.env.OAR_QWEN_BIN = bin;
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
