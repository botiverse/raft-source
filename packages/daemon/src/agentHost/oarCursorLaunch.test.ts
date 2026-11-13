// Cursor on OAR (#oar-raft:#10): the launch Raft hands OAR's Cursor runtime.
// No network: managed MCP is given as a fixed endpoint, and the one prepared
// launch below has no runner credential, so no tool catalog is fetched.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentConfig } from "@botiverse/raft-shared";
import type { SpawnContext } from "../drivers/types";
import { buildCliTransportDir } from "../drivers/cliTransport";
import { cursorSdkAvailable } from "../oarLoader";
import { isCursorSdkSessionId, runtimeHostSessionDrop } from "../runtimeSpec";
import {
  CURSOR_CHILD_INHERITED_ENV,
  cursorAuthEnv,
  cursorChildEnv,
  cursorOarLaunch,
  cursorSdkModel,
  cursorSdkAuthFile,
  cursorSdkCredentialPresent,
  cursorSdkSignIn,
  prepareCursorOarLaunch,
} from "./oarCursorLaunch";

const SDK_SESSION = "agent-0b9e8f2a-5c1d-4e7f-9a3b-2d6c8e4f1a07";
const CLI_SESSION = "0b9e8f2a-5c1d-4e7f-9a3b-2d6c8e4f1a07";
const ENV = { HOME: "/home/me", PATH: "/raft/bin:/usr/bin", SHELL: "/bin/sh", SLOCK_AGENT_ID: "agent-1" };

const ctx = (overrides: Partial<AgentConfig> = {}, extra: Partial<SpawnContext> = {}): SpawnContext => ({
  agentId: "agent-1",
  config: {
    name: "c", displayName: null, description: null, model: "default", runtime: "cursor", reasoningEffort: null,
    envVars: null, sessionId: null, serverUrl: "http://localhost:3001", authToken: "", ...overrides,
  },
  standingPrompt: "standing instructions",
  prompt: "first input",
  workingDirectory: "/work/agent-1",
  slockCliPath: "/bin/raft",
  daemonApiKey: "sk_machine_test",
  ...extra,
});

test("a cursor launch: cwd, the child's env, model and an SDK resume only; no system prompt, effort or launch args; steers", () => {
  const launch = cursorOarLaunch(ctx({ model: "claude-4.5-sonnet", reasoningEffort: "high", sessionId: SDK_SESSION }), { env: ENV });
  assert.deepEqual(launch, {
    runtimeId: "cursor",
    installation: { kind: "available", via: "bundled" },
    options: { cwd: "/work/agent-1", env: ENV, model: "claude-4.5-sonnet", resume: SDK_SESSION },
    busyDelivery: "now",
  });
  for (const refused of ["systemPrompt", "appendSystemPrompt", "effort", "launchArgs"]) {
    assert.equal(refused in launch.options, false, refused);
  }
});

test("a Cursor CLI session id is never resumed through the SDK", () => {
  assert.equal(cursorOarLaunch(ctx({ sessionId: CLI_SESSION }), { env: ENV }).options.resume, undefined);
  assert.equal(cursorOarLaunch(ctx({ sessionId: null }), { env: ENV }).options.resume, undefined);
});

test("model ids: the Cursor CLI's default and auto are the SDK's default (no model given); others pass as is", () => {
  assert.equal(cursorSdkModel("default"), null);
  assert.equal(cursorSdkModel("auto"), null);
  assert.equal(cursorSdkModel("Auto"), null);
  assert.equal(cursorSdkModel(""), null);
  assert.equal(cursorSdkModel(null), null);
  assert.equal(cursorSdkModel("gpt-5.5"), "gpt-5.5");
  assert.equal("model" in cursorOarLaunch(ctx({ model: "auto" }), { env: ENV }).options, false);
});

test("managed MCP goes as a session MCP server with the token in a bearer header, never in the URL or the environment", () => {
  const managedMcp = { name: "rmAbc123", url: "http://127.0.0.1:4100/mcp/cursor-token", endpointUrl: "http://127.0.0.1:4100/mcp", token: "cursor-token" };
  const launch = cursorOarLaunch(ctx({ sessionId: SDK_SESSION }), { env: ENV, managedMcp });
  assert.deepEqual(launch.options.mcpServers, [
    { name: "rmAbc123", type: "http", url: "http://127.0.0.1:4100/mcp", headers: { Authorization: "Bearer cursor-token" } },
  ]);
  assert.equal(launch.options.resume, SDK_SESSION, "given again on resume");
  assert.equal(JSON.stringify(launch.options.env).includes("cursor-token"), false);
  assert.equal("mcpServers" in cursorOarLaunch(ctx(), { env: ENV, managedMcp: null }).options, false);
});

test("the child's environment: the daemon variables a shell and Node need, SHELL=/bin/sh, then the launch's own, which win", () => {
  const daemon = {
    HOME: "/home/me", PATH: "/usr/bin", TMPDIR: "/tmp/me", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", USER: "me", LOGNAME: "me",
    HTTPS_PROXY: "http://proxy:3128", CURSOR_API_KEY: "daemon-key", SHELL: "/usr/bin/zsh",
    SLOCK_DAEMON_API_KEY_FILE: "/home/me/.raft/daemon-key", OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel", RAFT_PROFILE: "dev",
  };
  const env = cursorChildEnv(daemon, { PATH: "/raft/wrapper:/usr/bin", SLOCK_AGENT_ID: "agent-1", OPENAI_API_KEY: "agent-var" });
  assert.deepEqual(env, {
    HOME: "/home/me", PATH: "/raft/wrapper:/usr/bin", TMPDIR: "/tmp/me", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", USER: "me", LOGNAME: "me",
    HTTPS_PROXY: "http://proxy:3128", CURSOR_API_KEY: "daemon-key", SHELL: "/bin/sh",
    SLOCK_AGENT_ID: "agent-1", OPENAI_API_KEY: "agent-var",
  });
  assert.ok(CURSOR_CHILD_INHERITED_ENV.every((name) => !name.startsWith("SLOCK_") && !name.startsWith("RAFT_")), "no Raft or daemon variable is inherited by name");
  // The agent's own SHELL or key wins over the defaults.
  assert.equal(cursorChildEnv(daemon, { SHELL: "/bin/bash" }).SHELL, "/bin/bash");
  assert.equal(cursorChildEnv(daemon, { CURSOR_API_KEY: "agent-key" }).CURSOR_API_KEY, "agent-key");
});

test("a sign-in read runs in the agent's environment: its CURSOR_API_KEY and HOME over the daemon's", () => {
  const daemon = { HOME: "/home/me", PATH: "/usr/bin", CURSOR_API_KEY: "daemon-key", SLOCK_DAEMON_API_KEY_FILE: "/k" };
  assert.deepEqual(cursorAuthEnv(null, daemon), { HOME: "/home/me", PATH: "/usr/bin", CURSOR_API_KEY: "daemon-key", SHELL: "/bin/sh" });
  assert.deepEqual(cursorAuthEnv({ CURSOR_API_KEY: "agent-key", HOME: "/home/agent" }, daemon), { HOME: "/home/agent", PATH: "/usr/bin", CURSOR_API_KEY: "agent-key", SHELL: "/bin/sh" });
});

test("a prepared cursor launch writes no workspace .cursor/mcp.json (the legacy driver's token-in-URL file)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oar-cursor-launch-"));
  try {
    const workingDirectory = path.join(root, "agent-1");
    // No runner credential: no proxy and no tool catalog request.
    const launch = await prepareCursorOarLaunch(ctx({}, { workingDirectory, slockHome: path.join(root, "home"), slockCliPath: process.execPath }));
    assert.equal(launch.runtimeId, "cursor");
    assert.equal(existsSync(path.join(workingDirectory, ".cursor", "mcp.json")), false);
    assert.equal("mcpServers" in launch.options, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the SDK is signed in with its stored login or CURSOR_API_KEY, signed out only on a definite logged_out", () => {
  assert.equal(cursorSdkSignIn({ kind: "logged_in", source: "Cursor.auth.status" }), "signed_in");
  assert.equal(cursorSdkSignIn({ kind: "unknown", configured: ["environment: CURSOR_API_KEY"], source: "Cursor.auth.status" }), "signed_in");
  assert.equal(cursorSdkSignIn({ kind: "logged_out", source: "Cursor.auth.status" }), "signed_out");
  assert.equal(cursorSdkSignIn({ kind: "unknown", detail: "Cursor.auth.status did not answer" }), "unknown", "a late or failed read is not signed out");
});

test("no CURSOR_API_KEY and no SDK auth file: no sign-in to look for, without loading the SDK", () => {
  const seen: string[] = [];
  const exists = (present: boolean) => (file: string) => { seen.push(file); return present; };
  assert.equal(cursorSdkCredentialPresent({ env: {}, homeDir: "/home/me", exists: exists(false) }), false);
  assert.deepEqual(seen, [path.join("/home/me", ".cursor", "sdk", "auth.json")]);
  assert.equal(cursorSdkAuthFile("/home/me"), path.join("/home/me", ".cursor", "sdk", "auth.json"));
  assert.equal(cursorSdkCredentialPresent({ env: {}, homeDir: "/home/me", exists: exists(true) }), true);
  assert.equal(cursorSdkCredentialPresent({ env: { CURSOR_API_KEY: "key" }, homeDir: "/home/me", exists: exists(false) }), true);
});

test("runtime-host:oar:cursor: only on Linux, outside the SEA build, where the SDK resolves", () => {
  const found = () => "file:///opt/raft/node_modules/@cursor/sdk/dist/index.js";
  const missing = () => { throw Object.assign(new Error("Cannot find package '@cursor/sdk'"), { code: "ERR_MODULE_NOT_FOUND" }); };
  assert.equal(cursorSdkAvailable({ platform: "linux", sea: false, resolve: found }), true);
  assert.equal(cursorSdkAvailable({ platform: "linux", sea: false, resolve: missing }), false);
  assert.equal(cursorSdkAvailable({ platform: "linux", sea: true, resolve: found }), false);
  assert.equal(cursorSdkAvailable({ platform: "linux", sea: undefined, resolve: found }), false, "an unanswered SEA probe is not a yes");
  assert.equal(cursorSdkAvailable({ platform: "darwin", sea: false, resolve: found }), false);
  assert.equal(cursorSdkAvailable({ platform: "win32", sea: false, resolve: found }), false);
  // The SDK's child runs on the daemon's own Node; @cursor/sdk 1.3.1 needs 22.13 or newer.
  assert.equal(cursorSdkAvailable({ platform: "linux", sea: false, nodeVersion: "22.12.0", resolve: found }), false);
  assert.equal(cursorSdkAvailable({ platform: "linux", sea: false, nodeVersion: "20.19.0", resolve: found }), false);
  assert.equal(cursorSdkAvailable({ platform: "linux", sea: false, nodeVersion: "22.13.0", resolve: found }), true);
  assert.equal(cursorSdkAvailable({ platform: "linux", sea: false, nodeVersion: "24.1.0", resolve: found }), true);
});

test("Cursor sessions belong to one host: CLI ids to the legacy driver, agent- ids to the SDK", () => {
  assert.equal(isCursorSdkSessionId(SDK_SESSION), true);
  assert.equal(isCursorSdkSessionId(CLI_SESSION), false);
  assert.equal(isCursorSdkSessionId("agent-nope"), false);
  assert.equal(runtimeHostSessionDrop("cursor", CLI_SESSION, "oar"), "runtime_host_changed");
  assert.equal(runtimeHostSessionDrop("cursor", SDK_SESSION, "oar"), null);
  assert.equal(runtimeHostSessionDrop("cursor", SDK_SESSION, "legacy"), "runtime_host_changed");
  assert.equal(runtimeHostSessionDrop("cursor", CLI_SESSION, "legacy"), null);
  assert.equal(runtimeHostSessionDrop("grok", SDK_SESSION, "legacy"), null, "only Cursor");
  assert.equal(runtimeHostSessionDrop("cursor", null, "oar"), null);
});

// Tenny's first test for Cursor on OAR, enabled with OAR 0.101's subprocess
// execution (`envBase: "clean"`): the SDK's child, and so the agent's tool
// shells, get only the launch's environment. What the real tool shell sees
// is OAR's own test (tests/cursor/cursor-subprocess-env.test.ts, fake SDK);
// this pins what Raft hands it.
test("the agent's tool shell does not see daemon-only environment variables", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oar-cursor-env-"));
  const daemonOnly = { SLOCK_DAEMON_API_KEY_FILE: path.join(root, "daemon-key"), RAFT_PROFILE: "dev", OTEL_EXPORTER_OTLP_HEADERS: "x-secret=1" };
  const saved = Object.fromEntries(Object.keys(daemonOnly).map((name) => [name, process.env[name]]));
  Object.assign(process.env, daemonOnly);
  try {
    const slockHome = path.join(root, "home");
    const launch = await prepareCursorOarLaunch(ctx({ envVars: { OPENAI_API_KEY: "agent-var" } }, { workingDirectory: path.join(root, "agent-1"), slockHome, slockCliPath: process.execPath }));
    const env = launch.options.env;
    assert.ok(env, "the launch hands the tool shells an environment of their own");
    // Daemon-only: the Computer's key file pointer, profile selectors and telemetry settings are absent.
    for (const name of Object.keys(daemonOnly)) assert.equal(name in env, false, name);
    assert.equal(env.SLOCK_AGENT_ID, "agent-1");
    assert.equal(env.OPENAI_API_KEY, "agent-var", "the agent's own env vars");
    assert.equal(env.SHELL, "/bin/sh");
    assert.equal(env.HOME, process.env.HOME);
    // The raft wrapper dir is first on PATH: `raft` resolves without an absolute path.
    assert.equal(env.PATH!.split(path.delimiter)[0], buildCliTransportDir(slockHome, "agent-1", null));
    assert.ok(existsSync(path.join(env.PATH!.split(path.delimiter)[0]!, "raft")));
    assert.equal(Object.values(env).some((value) => value === null), false, "a clean base needs no removals");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
