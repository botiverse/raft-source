import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InstallationSnapshot, Session } from "@botiverse/oar";
import type { AgentConfig } from "@botiverse/raft-shared";
import { buildOpenCodeLaunchEnv, openCodeSessionRecordPath, writeOpenCodeSessionRecord } from "../drivers/opencode";
import type { SpawnContext } from "../drivers/types";
import { RuntimeExecutableNotFoundError } from "../spawnFailureErrors";
import { OarLaunchDeclined } from "./oarLaunch";
import {
  createOpenGate,
  isOarOpencodeVersion,
  opencodeOarLaunch,
  opencodeReleaseOf,
  prepareOpencodeOarLaunch,
  type OpencodeLaunchDeps,
} from "./oarOpencodeLaunch";

const ctx = (overrides: Partial<AgentConfig> = {}, slockHome = "/raft-home"): SpawnContext => ({
  agentId: "agent-1",
  config: {
    name: "o", displayName: null, description: null, model: "opencode/gpt-5-nano", runtime: "opencode", reasoningEffort: null,
    envVars: null, sessionId: null, serverUrl: "http://localhost:3001", authToken: "", ...overrides,
  },
  standingPrompt: "standing instructions",
  prompt: "first input",
  workingDirectory: "/work/agent-1",
  slockCliPath: "/bin/raft",
  daemonApiKey: "sk_machine_test",
  slockHome,
});

const MANAGED_MCP = { name: "rmAbc123", url: "http://127.0.0.1:4100/mcp/oc-token", endpointUrl: "http://127.0.0.1:4100/mcp", token: "oc-token" };

test("version gate: 1.x from 1.18.30, 2.x from 2.0.27, nothing from 3.0 or unreadable", () => {
  for (const version of ["1.18.30", "1.18.35", "1.19.0", "opencode v2.0.27", "2.0.27", "2.3.0", "opencode v2.2.7", "2.3.0-beta.1"]) {
    assert.equal(isOarOpencodeVersion(version), true, version);
  }
  for (const version of ["1.14.30", "1.18.29", "2.0.26", "opencode v2.0.0", "3.0.0", "0.9.9", "", "opencode", undefined, null]) {
    assert.equal(isOarOpencodeVersion(version), false, String(version));
  }
  assert.deepEqual(opencodeReleaseOf("opencode v2.3.1"), { major: 2, minor: 3, patch: 1 });
  assert.equal(opencodeReleaseOf("3.0.0"), null);
});

test("a 2.x launch: the driver's environment, model, resume and managed MCP as a session server; never OAR's prompt options", () => {
  const launch = opencodeOarLaunch(ctx(), {
    command: "/usr/local/bin/opencode",
    release: { major: 2, minor: 3, patch: 0 },
    env: { PATH: "/bin", OPENCODE_CONFIG_CONTENT: "{}", PWD: "/work/agent-1" },
    resume: "ses_123",
    managedMcp: MANAGED_MCP,
    record: null,
  }, { HOME: "/h", SLOCK_API_KEY: "secret" });
  assert.deepEqual(launch.installation, { kind: "available", via: "executable", command: "/usr/local/bin/opencode", version: "2.3.0" });
  assert.equal(launch.runtimeId, "opencode");
  assert.deepEqual(launch.options.env, { PATH: "/bin", OPENCODE_CONFIG_CONTENT: "{}", PWD: "/work/agent-1", HOME: null, SLOCK_API_KEY: null });
  assert.equal(launch.options.cwd, "/work/agent-1");
  assert.equal(launch.options.model, "opencode/gpt-5-nano");
  assert.equal(launch.options.resume, "ses_123");
  assert.equal(launch.options.systemPrompt, undefined, "OAR refuses systemPrompt on OpenCode 2.x: the standing prompt is in Raft's config");
  assert.equal(launch.options.appendSystemPrompt, undefined);
  assert.equal(launch.options.effort, undefined);
  assert.equal(launch.options.launchArgs, undefined, "2.x has no --pure; its environment isolates it");
  assert.deepEqual(launch.options.mcpServers, [
    { name: "rmAbc123", type: "http", url: "http://127.0.0.1:4100/mcp", headers: { Authorization: "Bearer oc-token" } },
  ]);
  assert.equal(JSON.stringify(launch.options.env).includes("oc-token"), false, "the token is not in the environment");
  assert.equal(launch.busyDelivery, "now");
  assert.equal(launch.promptFirst, true);
  assert.equal(launch.newSessionOnResumeElsewhere, true);
});

test("a 1.x launch: --pure as the driver passes it, no new session for a resume elsewhere; the default model is OpenCode's", () => {
  const launch = opencodeOarLaunch(ctx({ model: "default" }), {
    command: "/usr/local/bin/opencode",
    release: { major: 1, minor: 18, patch: 35 },
    env: {},
    resume: null,
    record: null,
  }, {});
  assert.deepEqual(launch.options.launchArgs, ["--pure"]);
  assert.equal(launch.options.model, undefined);
  assert.equal(launch.options.resume, undefined);
  assert.equal("mcpServers" in launch.options, false);
  assert.equal(launch.newSessionOnResumeElsewhere, undefined);
  assert.equal(launch.installation.kind === "available" && launch.installation.via === "executable" ? launch.installation.version : null, "1.18.35");
});

test("the OAR environment: the slock agent selected by default_agent, no managed MCP in the config, 2.x isolation, PWD the workspace", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "oc-oar-env-"));
  try {
    const context = ctx({}, home);
    const v2 = buildOpenCodeLaunchEnv(context, { PATH: "/bin" }, { home, version: "opencode v2.3.0", managedMcp: null, selectDefaultAgent: true });
    const config = JSON.parse(String(v2.env.OPENCODE_CONFIG_CONTENT)) as Record<string, unknown>;
    assert.equal(config.default_agent, "slock");
    assert.equal((config.agent as Record<string, { prompt?: string }>).slock?.prompt, "standing instructions");
    assert.deepEqual(config.mcp, {});
    assert.equal("plugin" in config, false);
    assert.equal(v2.env.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
    assert.equal(v2.env.OPENCODE_CONFIG_DIR, path.join(home, "opencode-config-empty"));
    assert.equal(v2.env.PWD, "/work/agent-1");
    assert.equal(v2.env.PATH, "/bin");
    const v1 = buildOpenCodeLaunchEnv(context, {}, { home, version: "1.18.35", managedMcp: null, selectDefaultAgent: true });
    assert.equal(v1.env.OPENCODE_DISABLE_PROJECT_CONFIG, undefined, "1.x keeps the driver's isolation (--pure)");
    assert.equal(v1.env.PWD, "/work/agent-1");
    // The legacy driver's own: the agent named by --agent, no default_agent.
    const legacy = buildOpenCodeLaunchEnv(context, {}, { home, version: "1.18.35", managedMcp: { name: "rm", url: "http://x/mcp/t" }, selectDefaultAgent: false });
    assert.equal(legacy.config.default_agent, undefined);
    assert.ok((legacy.config.mcp as Record<string, unknown>).rm);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function deps(version: string, overrides: Partial<OpencodeLaunchDeps> = {}): OpencodeLaunchDeps {
  return {
    readInstallation: async () => ({ kind: "available", via: "executable", command: "/usr/local/bin/opencode", version }),
    prepareEnvironment: async () => ({ PATH: "/bin" }),
    prepareManagedMcp: async () => null,
    openGate: undefined,
    inherited: {},
    ...overrides,
  };
}

async function declined(promise: Promise<unknown>): Promise<string> {
  let thrown: unknown;
  await promise.catch((error: unknown) => { thrown = error; });
  assert.ok(thrown instanceof OarLaunchDeclined, `expected OarLaunchDeclined, got ${String(thrown)}`);
  return thrown.reason;
}

test("prepare: an OpenCode outside the verified range, or of unknown version, is declined before anything is built", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "oc-oar-prep-"));
  let built = 0;
  const counting = { prepareEnvironment: async () => { built += 1; return {}; } };
  try {
    assert.equal(await declined(prepareOpencodeOarLaunch(ctx({}, home), deps("1.18.29", counting))), "opencode_version_unsupported");
    assert.equal(await declined(prepareOpencodeOarLaunch(ctx({}, home), deps("opencode v3.0.1", counting))), "opencode_version_unsupported");
    // OAR's `--version` failed to run, exited non-zero (no version), or printed no version.
    for (const readInstallation of [
      async (): Promise<InstallationSnapshot> => { throw Object.assign(new Error("Failed to run opencode --version"), { code: "ETIMEDOUT" }); },
      async (): Promise<InstallationSnapshot> => ({ kind: "available", via: "executable", command: "/usr/local/bin/opencode" }),
      async (): Promise<InstallationSnapshot> => ({ kind: "available", via: "executable", command: "/usr/local/bin/opencode", version: "usage: opencode" }),
    ]) {
      assert.equal(await declined(prepareOpencodeOarLaunch(ctx({}, home), deps("x", { ...counting, readInstallation }))), "opencode_version_unknown");
    }
    assert.equal(built, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("prepare: never resumes across OpenCode major lines on 1.x; the driver's refusal stays the driver's to show", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "oc-oar-major-"));
  try {
    const recordPath = openCodeSessionRecordPath(home, "agent-1");
    writeOpenCodeSessionRecord(recordPath, { version: 1, sessionId: "ses_new", opencodeMajor: 2, opencodeVersion: "opencode v2.3.0", recordedAt: "2026-11-01T00:00:00Z" });
    // A 2.x session on a 1.x CLI (a downgrade): the driver's refusal.
    assert.equal(await declined(prepareOpencodeOarLaunch(ctx({ sessionId: "ses_new" }, home), deps("1.18.35"))), "opencode_session_refused:major_mismatch");
    writeOpenCodeSessionRecord(recordPath, { version: 1, sessionId: "ses_old", opencodeMajor: 1, opencodeVersion: "1.18.35", recordedAt: "2026-11-01T00:00:00Z" });
    // The same major: resumed, and the record is already right.
    const resumed = await prepareOpencodeOarLaunch(ctx({ sessionId: "ses_old" }, home), deps("1.18.35"));
    assert.equal(resumed.options.resume, "ses_old");
    assert.equal(resumed.newSessionOnResumeElsewhere, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("prepare: after an upgrade to 2.x, a 1.x or unrecorded session goes to OAR, whose not-listed refusal opens a new session (never the driver's stuck refusal)", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "oc-oar-upgrade-"));
  try {
    const recordPath = openCodeSessionRecordPath(home, "agent-1");
    // No record and a 2.x CLI: a pre-record session, made by 1.x.
    const unrecorded = await prepareOpencodeOarLaunch(ctx({ sessionId: "ses_old" }, home), deps("opencode v2.3.0"));
    assert.equal(unrecorded.options.resume, "ses_old", "OAR checks OpenCode's own session list");
    assert.equal(unrecorded.newSessionOnResumeElsewhere, true, "a session 2.x doesn't list becomes a new session");
    // A 1.x record and a 2.x CLI: the same.
    writeOpenCodeSessionRecord(recordPath, { version: 1, sessionId: "ses_old", opencodeMajor: 1, opencodeVersion: "1.18.35", recordedAt: "2026-11-01T00:00:00Z" });
    const upgraded = await prepareOpencodeOarLaunch(ctx({ sessionId: "ses_old" }, home), deps("opencode v2.3.0"));
    assert.equal(upgraded.options.resume, "ses_old");
    assert.equal(upgraded.newSessionOnResumeElsewhere, true);
    // Should 2.x list and resume it, the session is recorded as 2.x's from now on.
    await upgraded.sessionOpened!({ id: "ses_old" } as Session);
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as { sessionId: string; opencodeMajor: number };
    assert.deepEqual([record.sessionId, record.opencodeMajor], ["ses_old", 2]);
    // An unreadable record proves nothing: still the driver's refusal.
    writeFileSync(recordPath, "{not json");
    assert.equal(await declined(prepareOpencodeOarLaunch(ctx({ sessionId: "ses_old" }, home), deps("opencode v2.3.0"))), "opencode_session_refused:record_unreadable");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("prepare: OAR launches the command of OAR's own installation (a Windows npm @opencode/cli shim included); none found is runtime_not_found", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "oc-oar-installation-"));
  try {
    const shim = "C:\\Users\\tester\\AppData\\Roaming\\npm\\opencode.cmd";
    const launch = await prepareOpencodeOarLaunch(ctx({}, home), deps("x", {
      readInstallation: async () => ({ kind: "available", via: "executable", command: shim, version: "opencode v2.3.0" }),
    }));
    assert.deepEqual(launch.installation, { kind: "available", via: "executable", command: shim, version: "2.3.0" });
    await assert.rejects(
      prepareOpencodeOarLaunch(ctx({}, home), deps("x", { readInstallation: async () => ({ kind: "not_found" }) })),
      (error: unknown) => error instanceof RuntimeExecutableNotFoundError,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("prepare: the opened session's OpenCode major is recorded, as the driver records it; a matching resume is left as it is", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "oc-oar-record-"));
  try {
    const recordPath = openCodeSessionRecordPath(home, "agent-1");
    const fresh = await prepareOpencodeOarLaunch(ctx({}, home), deps("opencode v2.3.0"));
    assert.equal(fresh.options.resume, undefined);
    assert.ok(fresh.sessionOpened);
    await fresh.sessionOpened({ id: "ses_new" } as Session);
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as { sessionId: string; opencodeMajor: number; opencodeVersion: string };
    assert.equal(record.sessionId, "ses_new");
    assert.equal(record.opencodeMajor, 2);
    assert.equal(record.opencodeVersion, "opencode v2.3.0");

    const resumed = await prepareOpencodeOarLaunch(ctx({ sessionId: "ses_new" }, home), deps("2.3.1"));
    assert.equal(resumed.options.resume, "ses_new");
    rmSync(recordPath);
    await resumed.sessionOpened!({ id: "ses_new" } as Session);
    assert.throws(() => readFileSync(recordPath), /ENOENT/, "the record was right: not rewritten");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("prepare: managed MCP is attached as the driver attaches it, as a session server", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "oc-oar-mcp-"));
  try {
    const launch = await prepareOpencodeOarLaunch(ctx({}, home), deps("1.18.35", { prepareManagedMcp: async () => MANAGED_MCP }));
    assert.equal(launch.options.mcpServers?.[0]?.name, "rmAbc123");
    assert.ok(launch.openGate, "opened through the Computer's OpenCode open queue");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("open gate: one open at a time, in order; a start stopped while it waits never opens and does not unblock the next early", async () => {
  const gate = createOpenGate();
  const log: string[] = [];
  let releaseFirst!: () => void;
  const firstOpen = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const session = (id: string) => ({ id }) as Session;
  const first = gate(async () => { log.push("open 1"); await firstOpen; log.push("opened 1"); return session("1"); }, new AbortController().signal);
  const stopped = new AbortController();
  const second = gate(async () => { log.push("open 2"); return session("2"); }, stopped.signal);
  const third = gate(async () => { log.push("open 3"); return session("3"); }, new AbortController().signal);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(log, ["open 1"]);
  stopped.abort();
  await assert.rejects(second, { name: "AbortError" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(log, ["open 1"], "the third still waits for the first");
  releaseFirst();
  assert.equal((await first).id, "1");
  assert.equal((await third).id, "3");
  assert.deepEqual(log, ["open 1", "opened 1", "open 3"]);
  // A failed open frees the gate too.
  await assert.rejects(gate(async () => { throw new Error("spawn failed"); }, new AbortController().signal), /spawn failed/);
  assert.equal((await gate(async () => session("4"), new AbortController().signal)).id, "4");
});

test("OAR upgrade check: OAR's OpenCode takes launchArgs, model, resume and session MCP servers, and reports v1 vs v2 installation capabilities", async () => {
  const { opencodeRuntime } = await import("@botiverse/oar/runtimes/opencode");
  const { oarInstalledSessionCapabilities } = await import("../oarLoader");
  const v1 = oarInstalledSessionCapabilities(opencodeRuntime, { kind: "available", via: "executable", command: "/usr/bin/opencode", version: "1.18.30" });
  const v2 = oarInstalledSessionCapabilities(opencodeRuntime, { kind: "available", via: "executable", command: "/usr/bin/opencode", version: "2.2.7" });
  for (const caps of [v1, v2]) {
    const refused: Readonly<Record<string, string | undefined>> = caps.refusedSessionOptions ?? {};
    for (const option of ["launchArgs", "model", "resume", "mcpServers", "env", "cwd"]) {
      assert.equal(refused[option], undefined, option);
    }
  }
  assert.ok(v1.refusedSessionOptions?.fork, "OpenCode v1 refuses fork per-installation");
  assert.equal(v1.manualCompaction?.kind, "unsupported");
  assert.equal(v2.refusedSessionOptions?.fork, undefined, "OpenCode v2 allows fork");
  assert.equal(v2.manualCompaction?.kind, "supported");
});
