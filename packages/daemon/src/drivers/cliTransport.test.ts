// Tests for prepareCliTransport wrapper generation across platforms.

import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { deriveCliFallbackCandidates, deriveOpencliFallbackCandidates, prepareCliTransport, regenerateExistingOpencliWrappers, SLOCK_AGENT_LAUNCH_DIR_ENV, upgradeExistingAgentWrappers, writeOpencliWrapper } from "./cliTransport.js";
import { applyLoopbackNoProxyEnv } from "../loopbackNoProxy.js";
import type { SpawnContext } from "./types.js";

const originalSlockHome = process.env.SLOCK_HOME;
const testSlockHome = mkdtempSync(path.join(os.tmpdir(), "slock-cli-home-"));
let nextLaunchId = 0;

beforeAll(() => {
  process.env.SLOCK_HOME = testSlockHome;
});

afterAll(() => {
  if (originalSlockHome === undefined) {
    delete process.env.SLOCK_HOME;
  } else {
    process.env.SLOCK_HOME = originalSlockHome;
  }
  rmSync(testSlockHome, { recursive: true, force: true });
});

function makeCtx(workDir: string, configOverrides: Record<string, unknown> = {}): SpawnContext {
  return {
    agentId: "test-agent-id",
    config: {
      runtime: "claude",
      serverUrl: "https://test.slock.dev",
      authToken: "test-token-123",
      ...configOverrides,
    } as any,
    standingPrompt: "standing prompt",
    prompt: "test prompt",
    workingDirectory: workDir,
    launchId: `test-launch-${++nextLaunchId}`,
    slockCliPath: "/fake/cli/index.js",
    daemonApiKey: "daemon-key-456",
  };
}

test("prepareCliTransport: unix writes bash wrapper only", { skip: process.platform === "win32" }, async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  try {
    const ctx = makeCtx(tmp);
    const result = await prepareCliTransport(ctx, {}, "linux");

    const posixPath = path.join(result.slockDir, "slock");
    assert.ok(existsSync(posixPath), "POSIX wrapper should exist");

    const raftPosixPath = path.join(result.slockDir, "raft");
    assert.ok(existsSync(raftPosixPath), "POSIX raft wrapper should exist");
    assert.equal(readFileSync(raftPosixPath, "utf8"), readFileSync(posixPath, "utf8"), "raft and slock wrappers should delegate to the same core");
    assert.ok(statSync(raftPosixPath).mode & 0o111, "raft wrapper should be executable");

    const cmdPath = path.join(result.slockDir, "slock.cmd");
    assert.ok(!existsSync(cmdPath), "slock.cmd should NOT exist on non-win32");
    assert.ok(!existsSync(path.join(result.slockDir, "raft.cmd")), "raft.cmd should NOT exist on non-win32");

    const body = readFileSync(posixPath, "utf8");
    assert.match(body, /^#!\/usr\/bin\/env bash/);
    assert.match(body, /SLOCK_LOOPBACK_NO_PROXY='127\.0\.0\.1,localhost'/);
    assert.match(body, /SLOCK_EXISTING_NO_PROXY="\$\{NO_PROXY:-\}"/);
    assert.match(body, /NO_PROXY="\$\{SLOCK_LOOPBACK_NO_PROXY\}\$\{SLOCK_EXISTING_NO_PROXY:\+,\$SLOCK_EXISTING_NO_PROXY\}"/);
    assert.match(body, /no_proxy="\$NO_PROXY"/);
    assert.match(body, /\/fake\/cli\/index\.js/);

    assert.equal(result.wrapperPath, posixPath);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareCliTransport derives runtime env from structured runtimeConfig", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  try {
    const ctx = makeCtx(tmp, {
      runtime: "claude",
      model: "stale-legacy-model",
      envVars: { SHOULD_NOT_USE: "legacy" },
      runtimeConfig: {
        version: 1,
        runtime: "claude",
        provider: { kind: "custom", apiUrl: "https://gateway.example.test/v1", apiKey: "sk-ant-test" },
        model: { kind: "custom", name: "claude-opus-4-6" },
        mode: { kind: "default" },
        envVars: { TEAM_FLAG: "enabled" },
      },
    });
    const result = await prepareCliTransport(ctx, {}, "linux");

    assert.equal(result.spawnEnv.TEAM_FLAG, "enabled");
    assert.equal(result.spawnEnv.ANTHROPIC_BASE_URL, "https://gateway.example.test/v1");
    assert.equal(result.spawnEnv.ANTHROPIC_API_KEY, "sk-ant-test");
    assert.equal(result.spawnEnv.ANTHROPIC_CUSTOM_MODEL_OPTION, "claude-opus-4-6");
    assert.equal(result.spawnEnv.SHOULD_NOT_USE, undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareCliTransport: runtime process env prepends loopback NO_PROXY", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  try {
    const ctx = makeCtx(tmp, {
      envVars: {
        HTTP_PROXY: "http://proxy.internal:8080",
        HTTPS_PROXY: "http://secure-proxy.internal:8080",
        NO_PROXY: "corp.internal,127.0.0.1",
        no_proxy: "lower.internal,localhost",
      },
    });
    const result = await prepareCliTransport(ctx, {}, "linux");

    assert.equal(result.spawnEnv.HTTP_PROXY, "http://proxy.internal:8080");
    assert.equal(result.spawnEnv.HTTPS_PROXY, "http://secure-proxy.internal:8080");
    assert.equal(result.spawnEnv.NO_PROXY, "127.0.0.1,localhost,corp.internal,lower.internal");
    assert.equal(result.spawnEnv.no_proxy, "127.0.0.1,localhost,corp.internal,lower.internal");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("applyLoopbackNoProxyEnv preserves existing bypass entries without duplicates", () => {
  const env = applyLoopbackNoProxyEnv({
    NO_PROXY: "example.internal,LOCALHOST",
    no_proxy: "metadata.google.internal,127.0.0.1",
  });

  assert.equal(env.NO_PROXY, "127.0.0.1,localhost,example.internal,metadata.google.internal");
  assert.equal(env.no_proxy, env.NO_PROXY);
});

test("prepareCliTransport: win32 writes both bash and .cmd wrappers", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  try {
    const ctx = makeCtx(tmp);
    const result = await prepareCliTransport(ctx, {}, "win32");

    const posixPath = path.join(result.slockDir, "slock");
    assert.ok(existsSync(posixPath), "POSIX wrapper should still exist (for Git Bash)");

    const cmdPath = path.join(result.slockDir, "slock.cmd");
    assert.ok(existsSync(cmdPath), "slock.cmd should exist on win32");
    const psPath = path.join(result.slockDir, "slock.ps1");
    assert.ok(existsSync(psPath), "slock.ps1 should exist on win32 for PowerShell pipeline encoding");

    const raftPosixPath = path.join(result.slockDir, "raft");
    assert.ok(existsSync(raftPosixPath), "POSIX raft wrapper should exist on win32 (for Git Bash)");
    assert.equal(readFileSync(raftPosixPath, "utf8"), readFileSync(posixPath, "utf8"));
    const raftCmdPath = path.join(result.slockDir, "raft.cmd");
    assert.ok(existsSync(raftCmdPath), "raft.cmd should exist on win32");
    assert.equal(readFileSync(raftCmdPath, "utf8"), readFileSync(cmdPath, "utf8"));
    const raftPsPath = path.join(result.slockDir, "raft.ps1");
    assert.ok(existsSync(raftPsPath), "raft.ps1 should exist on win32");
    assert.equal(readFileSync(raftPsPath, "utf8"), readFileSync(psPath, "utf8"));

    const cmdBody = readFileSync(cmdPath, "utf8");
    assert.match(cmdBody, /@echo off/);
    assert.match(cmdBody, /chcp 65001 >NUL 2>NUL/);
    assert.match(cmdBody, /set PYTHONIOENCODING=utf-8/);
    assert.match(cmdBody, /set "SLOCK_LOOPBACK_NO_PROXY=127\.0\.0\.1,localhost"/);
    assert.match(cmdBody, /set "SLOCK_EXISTING_NO_PROXY=%NO_PROXY%"/);
    assert.match(cmdBody, /if defined SLOCK_EXISTING_NO_PROXY \(set "NO_PROXY=%SLOCK_LOOPBACK_NO_PROXY%,%SLOCK_EXISTING_NO_PROXY%"\) else set "NO_PROXY=%SLOCK_LOOPBACK_NO_PROXY%"/);
    assert.match(cmdBody, /set "no_proxy=%NO_PROXY%"/);
    assert.match(cmdBody, /\/fake\/cli\/index\.js/);
    assert.match(cmdBody, /%\*/);
    assert.match(cmdBody, /\r\n/, "should use CRLF line endings");

    const psBody = readFileSync(psPath, "utf8");
    assert.match(psBody, /\$OutputEncoding = \$utf8NoBom/);
    assert.match(psBody, /\[Console\]::OutputEncoding = \$utf8NoBom/);
    assert.match(psBody, /\$loopbackNoProxy = '127\.0\.0\.1,localhost'/);
    assert.match(psBody, /\$existingNoProxy = @\(\$env:NO_PROXY, \$env:no_proxy\) \| Where-Object \{ \$_ \}/);
    assert.match(psBody, /\$env:NO_PROXY = \$mergedNoProxy/);
    assert.match(psBody, /\$env:no_proxy = \$mergedNoProxy/);
    assert.match(psBody, /\$input \| & \$node \$cli @args/);
    assert.match(psBody, /\/fake\/cli\/index\.js/);

    assert.equal(result.wrapperPath, cmdPath);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareCliTransport: win32 forces UTF-8 runtime process environment", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  try {
    const ctx = makeCtx(tmp, {
      envVars: {
        PYTHONIOENCODING: "gbk",
        PYTHONUTF8: "0",
        LANG: "zh_CN.GBK",
        LC_ALL: "zh_CN.GBK",
        NODE_OPTIONS: "--inspect",
      },
    });
    const result = await prepareCliTransport(ctx, {
      NODE_OPTIONS: "--trace-warnings",
    }, "win32");

    assert.equal(result.spawnEnv.PYTHONIOENCODING, "utf-8");
    assert.equal(result.spawnEnv.PYTHONUTF8, "1");
    assert.equal(result.spawnEnv.LANG, "C.UTF-8");
    assert.equal(result.spawnEnv.LC_ALL, "C.UTF-8");
    assert.equal(result.spawnEnv.NODE_OPTIONS, "--trace-warnings");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareCliTransport: POSIX slock wrapper prepends loopback NO_PROXY at execution", { skip: process.platform === "win32" }, async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  try {
    const cliPath = path.join(tmp, "fake-cli.cjs");
    const outPath = path.join(tmp, "env.json");
    writeFileSync(cliPath, `
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.SLOCK_TEST_OUT, JSON.stringify({
  NO_PROXY: process.env.NO_PROXY,
  no_proxy: process.env.no_proxy,
}), "utf8");
`, "utf8");

    const ctx = makeCtx(tmp);
    ctx.slockCliPath = cliPath;
    const result = await prepareCliTransport(ctx, {}, "linux");

    const run = spawnSync(result.wrapperPath, ["server", "info"], {
      env: {
        ...process.env,
        NO_PROXY: "corp.internal",
        no_proxy: "lower.internal",
        SLOCK_TEST_OUT: outPath,
      },
      encoding: "utf8",
    });

    assert.equal(run.status, 0, run.stderr || run.stdout);
    const env = JSON.parse(readFileSync(outPath, "utf8")) as {
      NO_PROXY?: string;
      no_proxy?: string;
    };
    assert.equal(env.NO_PROXY, "127.0.0.1,localhost,corp.internal,lower.internal");
    assert.equal(env.no_proxy, "127.0.0.1,localhost,corp.internal,lower.internal");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareCliTransport: win32 PowerShell wrapper forwards pipeline input as UTF-8", { skip: process.platform !== "win32" }, async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  try {
    const cliPath = path.join(tmp, "fake-cli.cjs");
    const outPath = path.join(tmp, "stdin.txt");
    writeFileSync(cliPath, `
const { writeFileSync } = require("node:fs");
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
process.stdin.on("end", () => {
  writeFileSync(process.env.SLOCK_TEST_OUT, Buffer.concat(chunks).toString("utf8"), "utf8");
});
`, "utf8");

    const ctx = makeCtx(tmp);
    ctx.slockCliPath = cliPath;
    const transport = await prepareCliTransport(ctx, {}, "win32");

    const text = String.fromCodePoint(0x4e2d, 0x6587, 0x7f16, 0x7801, 0x6d4b, 0x8bd5, 0x901a, 0x8fc7);
    const command = [
      `$env:PATH = ${JSON.stringify(transport.slockDir)} + ';' + $env:PATH`,
      "$OutputEncoding = [System.Text.Encoding]::ASCII",
      "@'",
      text,
      "'@ | slock message send --target dm:@alice",
    ].join("\r\n");

    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
      env: { ...process.env, SLOCK_TEST_OUT: outPath },
      encoding: "utf8",
      timeout: 10_000,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(readFileSync(outPath, "utf8").trim(), text);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareCliTransport: non-win32 does not force locale env", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  try {
    const ctx = makeCtx(tmp, {
      envVars: {
        PYTHONIOENCODING: "gbk",
        PYTHONUTF8: "0",
      },
    });
    const result = await prepareCliTransport(ctx, {}, "linux");

    assert.equal(result.spawnEnv.PYTHONIOENCODING, "gbk");
    assert.equal(result.spawnEnv.PYTHONUTF8, "0");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareCliTransport: token file and env are platform-independent", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  const slockHome = path.join(tmp, "home");
  const oldSlockHome = process.env.SLOCK_HOME;
  try {
    process.env.SLOCK_HOME = slockHome;
    const ctx = makeCtx(tmp);
    const result = await prepareCliTransport(ctx, {}, "win32");

    // Token file written
    const token = readFileSync(result.tokenFile, "utf8");
    assert.equal(token, "test-token-123");

    // Env vars set correctly
    assert.equal(result.spawnEnv.SLOCK_AGENT_ID, "test-agent-id");
    assert.equal(result.spawnEnv.SLOCK_SERVER_URL, "https://test.slock.dev");
    assert.equal(result.spawnEnv.SLOCK_AGENT_TOKEN_FILE, undefined);
    assert.equal(result.spawnEnv.SLOCK_AGENT_TOKEN, undefined);
    assert.equal(result.spawnEnv.SLOCK_HOME, slockHome);

    // PATH prepended
    assert.ok(result.spawnEnv.PATH?.startsWith(result.slockDir));
  } finally {
    if (oldSlockHome === undefined) {
      delete process.env.SLOCK_HOME;
    } else {
      process.env.SLOCK_HOME = oldSlockHome;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareCliTransport: managed launches strip ambient external-profile selectors", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-profile-strip-"));
  const previous = {
    RAFT_PROFILE: process.env.RAFT_PROFILE,
    SLOCK_PROFILE: process.env.SLOCK_PROFILE,
    RAFT_PROFILE_DIR: process.env.RAFT_PROFILE_DIR,
    SLOCK_PROFILE_DIR: process.env.SLOCK_PROFILE_DIR,
  };
  try {
    process.env.RAFT_PROFILE = "foreign-ambient";
    process.env.SLOCK_PROFILE = "foreign-ambient";
    process.env.RAFT_PROFILE_DIR = path.join(tmp, "foreign-raft");
    process.env.SLOCK_PROFILE_DIR = path.join(tmp, "foreign-slock");
    const ctx = makeCtx(tmp, {
      envVars: {
        RAFT_PROFILE: "foreign-config",
        SLOCK_PROFILE: "foreign-config",
      },
    });
    const result = await prepareCliTransport(ctx, {
      RAFT_PROFILE_DIR: path.join(tmp, "foreign-extra"),
    }, "linux");

    assert.equal(result.spawnEnv.RAFT_PROFILE, undefined);
    assert.equal(result.spawnEnv.SLOCK_PROFILE, undefined);
    assert.equal(result.spawnEnv.RAFT_PROFILE_DIR, undefined);
    assert.equal(result.spawnEnv.SLOCK_PROFILE_DIR, undefined);
    assert.equal(result.spawnEnv.SLOCK_CLI_TRANSPORT_DIR, result.slockDir);

    const wrapper = readFileSync(result.wrapperPath, "utf8");
    const clearIdx = wrapper.indexOf("unset RAFT_PROFILE SLOCK_PROFILE RAFT_PROFILE_DIR SLOCK_PROFILE_DIR");
    const execIdx = wrapper.lastIndexOf("exec ");
    assert.ok(clearIdx > 0, "wrapper must clear inherited external-profile selectors");
    assert.ok(clearIdx < execIdx, "profile selectors must be cleared before the managed CLI exec");

    const windows = await prepareCliTransport(ctx, {}, "win32");
    const cmdWrapper = readFileSync(path.join(windows.slockDir, "raft.cmd"), "utf8");
    const psWrapper = readFileSync(path.join(windows.slockDir, "raft.ps1"), "utf8");
    assert.ok(cmdWrapper.indexOf('set "RAFT_PROFILE="') < cmdWrapper.indexOf('set "SLOCK_AGENT_ID='));
    assert.ok(psWrapper.indexOf("Remove-Item Env:RAFT_PROFILE") < psWrapper.indexOf("$env:SLOCK_AGENT_ID="));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareCliTransport: transport files live outside workspace and stale workspace files are cleaned", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  const slockHome = mkdtempSync(path.join(os.tmpdir(), "slock-cli-home-"));
  const oldSlockHome = process.env.SLOCK_HOME;
  try {
    process.env.SLOCK_HOME = slockHome;
    const workspaceSlockDir = path.join(tmp, ".slock");
    mkdirSync(workspaceSlockDir, { recursive: true });
    for (const filename of ["agent-token", "slock", "raft", "opencli"]) {
      writeFileSync(path.join(workspaceSlockDir, filename), "stale transport");
    }
    writeFileSync(path.join(workspaceSlockDir, "runtime-sessions.keep"), "preserve me");

    const ctx = makeCtx(tmp);
    const result = await prepareCliTransport(ctx, {}, "linux");

    assert.ok(result.slockDir.startsWith(path.join(slockHome, "cli-transport", "test-agent-id")));
    assert.ok(!result.slockDir.startsWith(tmp), "transport directory should be outside the model workspace");
    assert.ok(!result.slockDir.startsWith(workspaceSlockDir));
    assert.ok(existsSync(path.join(result.slockDir, "slock")), "daemon-owned wrapper should exist");
    assert.ok(existsSync(path.join(result.slockDir, "raft")), "daemon-owned raft wrapper should exist");
    assert.ok(existsSync(result.tokenFile), "daemon-owned legacy token file should exist");
    assert.equal(result.spawnEnv.SLOCK_AGENT_TOKEN_FILE, undefined);

    for (const filename of ["agent-token", "slock", "raft", "opencli"]) {
      assert.ok(!existsSync(path.join(workspaceSlockDir, filename)), `${filename} should be removed from workspace .slock`);
    }
    assert.equal(readFileSync(path.join(workspaceSlockDir, "runtime-sessions.keep"), "utf8"), "preserve me");
  } finally {
    if (oldSlockHome === undefined) {
      delete process.env.SLOCK_HOME;
    } else {
      process.env.SLOCK_HOME = oldSlockHome;
    }
    rmSync(slockHome, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});

const gitAvailable = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

test.skipIf(!gitAvailable)("prepareCliTransport: generated transport files do not enter workspace git status or git add", async () => {

  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  const slockHome = mkdtempSync(path.join(os.tmpdir(), "slock-cli-home-"));
  const oldSlockHome = process.env.SLOCK_HOME;
  try {
    process.env.SLOCK_HOME = slockHome;
    const init = spawnSync("git", ["init"], {
      cwd: tmp,
      encoding: "utf8",
    });
    assert.equal(init.status, 0, init.stderr || init.stdout);

    const ctx = makeCtx(tmp);
    const result = await prepareCliTransport(ctx, {}, "linux");

    assert.ok(!result.slockDir.startsWith(tmp), "transport directory should be outside the git workspace");

    const statusBeforeAdd = spawnSync("git", ["status", "--short"], {
      cwd: tmp,
      encoding: "utf8",
    });
    assert.equal(statusBeforeAdd.status, 0, statusBeforeAdd.stderr || statusBeforeAdd.stdout);
    assert.equal(statusBeforeAdd.stdout.trim(), "");

    const add = spawnSync("git", ["add", "-A"], {
      cwd: tmp,
      encoding: "utf8",
    });
    assert.equal(add.status, 0, add.stderr || add.stdout);

    const staged = spawnSync("git", ["diff", "--cached", "--name-only"], {
      cwd: tmp,
      encoding: "utf8",
    });
    assert.equal(staged.status, 0, staged.stderr || staged.stdout);
    assert.equal(staged.stdout.trim(), "");
  } finally {
    if (oldSlockHome === undefined) {
      delete process.env.SLOCK_HOME;
    } else {
      process.env.SLOCK_HOME = oldSlockHome;
    }
    rmSync(slockHome, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareCliTransport: SLOCK_HOME is normalized and cannot be overridden by agent env", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  const slockHome = path.join(tmp, "home", "..", "home");
  const oldSlockHome = process.env.SLOCK_HOME;
  try {
    process.env.SLOCK_HOME = slockHome;
    const ctx = makeCtx(tmp, {
      envVars: {
        SLOCK_HOME: path.join(tmp, "wrong-config-home"),
      },
    });
    const result = await prepareCliTransport(
      ctx,
      { SLOCK_HOME: path.join(tmp, "wrong-extra-home") },
      "linux",
    );

    assert.equal(result.spawnEnv.SLOCK_HOME, path.resolve(slockHome));
  } finally {
    if (oldSlockHome === undefined) {
      delete process.env.SLOCK_HOME;
    } else {
      process.env.SLOCK_HOME = oldSlockHome;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareCliTransport: without agentCredentialKey, no credential file or env var", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  try {
    const ctx = makeCtx(tmp);
    const result = await prepareCliTransport(ctx, {}, "linux");

    assert.equal(result.agentCredentialProxyUrl, null);
    assert.equal(result.spawnEnv.SLOCK_AGENT_PROXY_URL, undefined);
    assert.equal(result.spawnEnv.SLOCK_AGENT_PROXY_TOKEN, undefined);
    assert.equal(result.spawnEnv.SLOCK_AGENT_CREDENTIAL_KEY, undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareCliTransport: agentCredentialKey uses scoped proxy without legacy token file", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  const oldSlockHome = process.env.SLOCK_HOME;
  try {
    process.env.SLOCK_HOME = path.join(tmp, "home");
    const staleSlockDir = path.join(tmp, ".slock");
    mkdirSync(staleSlockDir, { recursive: true });
    writeFileSync(path.join(staleSlockDir, "agent-token"), "stale-machine-token", { mode: 0o600 });
    const ctx = makeCtx(tmp, {
      agentCredentialKey: "sk_agent_abc123def456",
      envVars: {
        // Try to sneak the raw key through agent envVars — must be scrubbed.
        SLOCK_AGENT_CREDENTIAL_KEY: "sk_agent_leaked",
      },
    });
    ctx.daemonVersion = "1.0.15";
    ctx.computerVersion = "1.0.16";
    const result = await prepareCliTransport(
      ctx,
      // Try to sneak through extraEnv too.
      { SLOCK_AGENT_CREDENTIAL_KEY: "sk_agent_leaked_extra" },
      "linux",
    );

    assert.ok(result.agentCredentialProxyUrl, "local proxy URL returned");
    assert.match(result.agentCredentialProxyUrl!, /^http:\/\/127\.0\.0\.1:\d+$/);

    // Runtime env has no raw key. When the scoped proxy is available, do not
    // also expose the legacy machine token.
    assert.equal(result.spawnEnv.SLOCK_AGENT_CREDENTIAL_KEY, undefined);
    assert.equal(result.spawnEnv.SLOCK_AGENT_PROXY_URL, undefined);
    assert.equal(result.spawnEnv.SLOCK_AGENT_PROXY_TOKEN, undefined);
    assert.equal(result.spawnEnv.SLOCK_AGENT_PROXY_TOKEN_FILE, undefined);
    assert.equal(result.spawnEnv.SLOCK_AGENT_TOKEN_FILE, undefined);
    assert.ok(!existsSync(result.tokenFile), "stale legacy machine token file should be removed on proxy path");
    assert.ok(!existsSync(path.join(staleSlockDir, "agent-token")), "stale workspace token file should be removed on proxy path");

    const wrapper = readFileSync(result.wrapperPath, "utf8");
    assert.doesNotMatch(wrapper, /sk_agent_abc123def456/);
    assert.doesNotMatch(wrapper, /SLOCK_AGENT_TOKEN_FILE/);
    assert.doesNotMatch(wrapper, /SLOCK_AGENT_PROXY_TOKEN=/);
    assert.match(wrapper, /SLOCK_AGENT_PROXY_URL=/);
    assert.match(wrapper, /SLOCK_AGENT_PROXY_TOKEN_FILE=/);

    const tokenFileMatch = wrapper.match(/SLOCK_AGENT_PROXY_TOKEN_FILE='([^']+)'/);
    assert.ok(tokenFileMatch, "wrapper should reference daemon-owned proxy token file");
    const proxyTokenFile = tokenFileMatch[1]!;
    assert.ok(proxyTokenFile.startsWith(path.join(process.env.SLOCK_HOME!, "agent-proxy-tokens")));
    const proxyToken = readFileSync(proxyTokenFile, "utf8");
    assert.match(proxyToken, /^sap_/);
    if (process.platform !== "win32") {
      assert.equal(statSync(proxyTokenFile).mode & 0o777, 0o600);
    }

    const versionResponse = await fetch(`${result.agentCredentialProxyUrl}/internal/agent-api/runtime-version`, {
      headers: { Authorization: `Bearer ${proxyToken}` },
    });
    assert.equal(versionResponse.status, 200);
    assert.deepEqual(await versionResponse.json(), {
      daemonVersion: "1.0.15",
      computerVersion: "1.0.16",
      observation: "live_daemon_process",
    });
  } finally {
    if (oldSlockHome === undefined) {
      delete process.env.SLOCK_HOME;
    } else {
      process.env.SLOCK_HOME = oldSlockHome;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── wrapper self-sufficiency (in-process SDK driver regression) ────────────
//
// Reported by @Xinran on Kimi SDK first-launch (#proj-runtime:6eaa9ce1, 2026-06-17):
// `raft message check` from inside an in-process SDK runtime's bash tool failed
// with `MISSING_AGENT_ID` / `MISSING_SERVER_URL` because the wrapper was relying
// on these vars being inherited from `spawnEnv`. That works for child-process
// drivers (claude/codex/kimi/etc.) where daemon spawns a child with `env: spawnEnv`,
// but NOT for in-process SDK drivers (kimi-sdk, pi) where the bash tool inherits
// `daemon process.env` — which doesn't carry per-spawn agent identity. Wrapper
// must be self-sufficient: inline-export every var the CLI requires.

test("prepareCliTransport: POSIX wrapper inline-exports SLOCK_AGENT_ID + SLOCK_SERVER_URL (proxy path)", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  const oldSlockHome = process.env.SLOCK_HOME;
  process.env.SLOCK_HOME = path.join(tmp, "slock-home");
  try {
    const ctx = makeCtx(tmp, {
      agentCredentialKey: "sk_agent_proxywrap_test",
    });
    const result = await prepareCliTransport(ctx, {}, "linux");

    const wrapper = readFileSync(result.wrapperPath, "utf8");
    // Identity vars MUST be inline-exported, not just on spawnEnv — otherwise
    // an in-process SDK runtime's bash tool can't satisfy the CLI's
    // MISSING_AGENT_ID / MISSING_SERVER_URL preflight.
    assert.match(wrapper, /SLOCK_AGENT_ID='test-agent-id'/);
    assert.match(wrapper, /SLOCK_SERVER_URL='https:\/\/test\.slock\.dev'/);
    // Proxy path is unchanged: still uses PROXY_TOKEN_FILE (path), not raw token.
    assert.match(wrapper, /SLOCK_AGENT_PROXY_TOKEN_FILE=/);
    // Non-proxy fallback's SLOCK_AGENT_TOKEN_FILE must NOT appear on proxy path.
    assert.doesNotMatch(wrapper, /SLOCK_AGENT_TOKEN_FILE/);
  } finally {
    if (oldSlockHome === undefined) {
      delete process.env.SLOCK_HOME;
    } else {
      process.env.SLOCK_HOME = oldSlockHome;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareCliTransport: POSIX wrapper inline-exports SLOCK_AGENT_ID + SLOCK_SERVER_URL + SLOCK_AGENT_TOKEN_FILE (non-proxy / legacy path)", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  try {
    const ctx = makeCtx(tmp);
    const result = await prepareCliTransport(ctx, {}, "linux");

    assert.equal(result.agentCredentialProxyUrl, null, "no proxy in this scenario");
    const wrapper = readFileSync(result.wrapperPath, "utf8");
    assert.match(wrapper, /SLOCK_AGENT_ID='test-agent-id'/);
    assert.match(wrapper, /SLOCK_SERVER_URL='https:\/\/test\.slock\.dev'/);
    // Non-proxy path must include the legacy token file PATH (not contents)
    // so a CLI process started via the wrapper can authenticate without
    // relying on the parent process's env.
    assert.match(wrapper, /SLOCK_AGENT_TOKEN_FILE='[^']+'/);
    // Token CONTENTS must never be inlined; only the file path.
    assert.doesNotMatch(wrapper, /test-token-123/);
    assert.doesNotMatch(wrapper, /SLOCK_AGENT_PROXY_/, "no proxy vars on legacy path");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareCliTransport: in-process SDK callsite — running the wrapper without agent-specific vars in process.env still resolves identity from the wrapper itself", async () => {
  // Simulates the kimi-sdk / pi failure mode @Xinran hit: bash tool runs the
  // wrapper script with an env that does NOT contain SLOCK_AGENT_ID /
  // SLOCK_SERVER_URL (because the daemon process never has per-agent vars
  // — those are only on spawnEnv for child-process spawns). After this fix,
  // the wrapper itself sets them, so a child invoked from a clean env still
  // sees them via the wrapper's inline export.
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  const oldSlockHome = process.env.SLOCK_HOME;
  process.env.SLOCK_HOME = path.join(tmp, "slock-home");
  try {
    const ctx = makeCtx(tmp, { agentCredentialKey: "sk_agent_inproc_test" });
    const result = await prepareCliTransport(ctx, {}, "linux");
    const wrapper = readFileSync(result.wrapperPath, "utf8");

    // Source-level guard: the wrapper script's text contains literal
    // `VAR=value` exports for the identity vars BEFORE the `exec` line,
    // so a child shell parsing the wrapper sees them inline (not via
    // parent-env lookup). Greps for the assignment pattern + ordering.
    const execIdx = wrapper.lastIndexOf("exec ");
    assert.ok(execIdx > 0, "wrapper should have an exec line");
    const beforeExec = wrapper.slice(0, execIdx);
    assert.match(beforeExec, /SLOCK_AGENT_ID=/, "agent id assignment must precede exec");
    assert.match(beforeExec, /SLOCK_SERVER_URL=/, "server url assignment must precede exec");
  } finally {
    if (oldSlockHome === undefined) {
      delete process.env.SLOCK_HOME;
    } else {
      process.env.SLOCK_HOME = oldSlockHome;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareCliTransport: empty agentCredentialKey treated as absent", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  try {
    const ctx = makeCtx(tmp, { agentCredentialKey: "" });
    const result = await prepareCliTransport(ctx, {}, "linux");

    assert.equal(result.agentCredentialProxyUrl, null);
    assert.equal(result.spawnEnv.SLOCK_AGENT_PROXY_URL, undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareCliTransport: writes opencli POSIX wrapper alongside slock wrapper", { skip: process.platform === "win32" }, async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  try {
    const ctx = makeCtx(tmp);
    const result = await prepareCliTransport(ctx, {}, "linux");

    const opencliPath = path.join(result.slockDir, "opencli");
    assert.ok(existsSync(opencliPath), "opencli POSIX wrapper should exist");

    const body = readFileSync(opencliPath, "utf8");
    assert.match(body, /^#!\/usr\/bin\/env bash/);
    // Wrapper execs node against the resolved @jackwener/opencli main script.
    assert.match(body, /@jackwener\/opencli\/dist\/src\/main\.js/);
    assert.match(body, /"\$@"/);

    const opencliCmdPath = path.join(result.slockDir, "opencli.cmd");
    assert.ok(!existsSync(opencliCmdPath), "opencli.cmd should NOT exist on non-win32");

    // Wrapper file is executable.
    assert.equal(statSync(opencliPath).mode & 0o100, 0o100);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareCliTransport: win32 writes opencli.cmd with UTF-8 prelude", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  try {
    const ctx = makeCtx(tmp);
    const result = await prepareCliTransport(ctx, {}, "win32");

    const opencliCmdPath = path.join(result.slockDir, "opencli.cmd");
    assert.ok(existsSync(opencliCmdPath), "opencli.cmd should exist on win32");

    const body = readFileSync(opencliCmdPath, "utf8");
    assert.match(body, /@echo off/);
    assert.match(body, /chcp 65001 >NUL 2>NUL/);
    assert.match(body, /@jackwener\\opencli\\dist\\src\\main\.js|@jackwener\/opencli\/dist\/src\/main\.js/);
    assert.match(body, /%\*/);
    assert.match(body, /\r\n/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareCliTransport: opencli wrapper is on the spawned PATH via slockDir prepend", async () => {
  // Regression guard for the integration contract: opencli must be invokable
  // by name from the spawned runtime, not just present on disk.
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  try {
    const ctx = makeCtx(tmp);
    const result = await prepareCliTransport(ctx, {}, "linux");

    const opencliPath = path.join(result.slockDir, "opencli");
    assert.ok(existsSync(opencliPath));
    // slockDir is the first PATH entry, so `opencli` resolves there.
    const firstPathEntry = result.spawnEnv.PATH?.split(path.delimiter)[0];
    assert.equal(firstPathEntry, result.slockDir);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareCliTransport: exposes current runtime context as read-only env", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  try {
    const ctx = makeCtx(tmp);
    ctx.config.runtimeContext = {
      agentId: "agent-1",
      serverId: "server-1",
      machineId: "machine-1",
      machineName: "Dev Mac",
      machineHostname: "dev-mac.local",
      machineOs: "darwin arm64",
      daemonVersion: "0.41.1",
      workspacePath: tmp,
    };
    const result = await prepareCliTransport(ctx, {}, "linux");

    assert.equal(result.spawnEnv.SLOCK_CURRENT_AGENT_ID, "agent-1");
    assert.equal(result.spawnEnv.SLOCK_CURRENT_SERVER_ID, "server-1");
    assert.equal(result.spawnEnv.RAFT_CURRENT_COMPUTER_ID, "machine-1");
    assert.equal(result.spawnEnv.RAFT_CURRENT_COMPUTER_NAME, "Dev Mac");
    assert.equal(result.spawnEnv.RAFT_CURRENT_COMPUTER_HOSTNAME, "dev-mac.local");
    assert.equal(result.spawnEnv.RAFT_CURRENT_COMPUTER_OS, "darwin arm64");
    assert.equal(result.spawnEnv.SLOCK_CURRENT_DAEMON_VERSION, "0.41.1");
    assert.equal(result.spawnEnv.SLOCK_CURRENT_WORKSPACE_PATH, tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareCliTransport: passes CLI transport trace dir when provided", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  try {
    const ctx = makeCtx(tmp);
    ctx.cliTransportTraceDir = path.join(tmp, "machine", "traces");
    const result = await prepareCliTransport(ctx, {}, "linux");

    assert.equal(result.spawnEnv.SLOCK_CLI_TRANSPORT_TRACE_DIR, ctx.cliTransportTraceDir);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("deriveCliFallbackCandidates maps nested computer tree to top-level installs", { skip: process.platform === "win32" }, () => {
  const nested = "/opt/homebrew/lib/node_modules/@botiverse/raft-computer/node_modules/@slock-ai/daemon/dist/cli/index.js";
  const candidates = deriveCliFallbackCandidates(nested);
  assert.deepEqual(candidates, [
    "/opt/homebrew/lib/node_modules/@botiverse/raft-daemon/dist/cli/index.js",
    "/opt/homebrew/lib/node_modules/@slock-ai/daemon/dist/cli/index.js",
  ]);
});

test("deriveCliFallbackCandidates skips SEA sentinel and non-package paths", () => {
  assert.deepEqual(deriveCliFallbackCandidates("__cli"), []);
  assert.deepEqual(deriveCliFallbackCandidates(""), []);
  assert.deepEqual(deriveCliFallbackCandidates("/srv/checkout/packages/cli/dist/index.js"), []);
});

test("deriveCliFallbackCandidates excludes the broken path itself when already top-level", { skip: process.platform === "win32" }, () => {
  const topLevel = "/opt/homebrew/lib/node_modules/@slock-ai/daemon/dist/cli/index.js";
  const candidates = deriveCliFallbackCandidates(topLevel);
  assert.deepEqual(candidates, [
    "/opt/homebrew/lib/node_modules/@botiverse/raft-daemon/dist/cli/index.js",
  ]);
});

test("prepareCliTransport: spawn-time fallback re-points wrappers when baked CLI path is gone", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  try {
    // Simulate the field breakage: the nested computer tree the daemon was
    // started from is deleted, but a top-level daemon install exists.
    const globalRoot = path.join(tmp, "global", "node_modules");
    const nestedCli = path.join(globalRoot, "@botiverse", "raft-computer", "node_modules", "@slock-ai", "daemon", "dist", "cli", "index.js");
    const topLevelCli = path.join(globalRoot, "@slock-ai", "daemon", "dist", "cli", "index.js");
    mkdirSync(path.dirname(topLevelCli), { recursive: true });
    writeFileSync(topLevelCli, "// fake cli\n");

    const ctx = makeCtx(tmp);
    ctx.slockCliPath = nestedCli;
    const result = await prepareCliTransport(ctx, {}, "linux");

    const body = readFileSync(path.join(result.slockDir, "slock"), "utf8");
    assert.ok(body.includes(`SLOCK_CLI='${topLevelCli}'`), "wrapper should bake the existing top-level CLI as primary");
    assert.ok(!body.includes(`SLOCK_CLI='${nestedCli}'`), "wrapper must not keep the dead nested path as primary");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareCliTransport: wrappers carry exec-time fallback candidates", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  try {
    const globalRoot = path.join(tmp, "global", "node_modules");
    const bakedCli = path.join(globalRoot, "@slock-ai", "daemon", "dist", "cli", "index.js");
    mkdirSync(path.dirname(bakedCli), { recursive: true });
    writeFileSync(bakedCli, "// fake cli\n");

    const ctx = makeCtx(tmp);
    ctx.slockCliPath = bakedCli;
    const result = await prepareCliTransport(ctx, {}, "win32");

    const posixBody = readFileSync(path.join(result.slockDir, "slock"), "utf8");
    assert.match(posixBody, /if \[ ! -e "\$SLOCK_CLI" \]; then/);
    assert.ok(posixBody.includes(path.join(globalRoot, "@botiverse", "raft-daemon", "dist", "cli", "index.js")));

    const cmdBody = readFileSync(path.join(result.slockDir, "slock.cmd"), "utf8");
    assert.match(cmdBody, /if not exist "%SLOCK_CLI%" set "SLOCK_CLI=/);

    const psBody = readFileSync(path.join(result.slockDir, "slock.ps1"), "utf8");
    assert.match(psBody, /if \(-not \(Test-Path \$cli\)\) \{/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareCliTransport: SEA __cli sentinel gets no fallback block", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  try {
    const ctx = makeCtx(tmp);
    ctx.slockCliPath = "__cli";
    const result = await prepareCliTransport(ctx, {}, "linux");
    const body = readFileSync(path.join(result.slockDir, "slock"), "utf8");
    assert.ok(body.includes("SLOCK_CLI='__cli'"), "sentinel must pass through unchanged");
    assert.ok(!body.includes("if [ ! -e"), "no fallback block for SEA sentinel");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("deriveOpencliFallbackCandidates re-roots nested computer paths at the global top level", { skip: process.platform === "win32" }, () => {
  const nested = "/opt/homebrew/lib/node_modules/@botiverse/raft-computer/node_modules/@jackwener/opencli/dist/index.js";
  assert.deepEqual(deriveOpencliFallbackCandidates(nested), [
    "/opt/homebrew/lib/node_modules/@jackwener/opencli/dist/index.js",
  ]);
  // already top-level → candidate equals input → no fallback
  assert.deepEqual(deriveOpencliFallbackCandidates("/opt/homebrew/lib/node_modules/@jackwener/opencli/dist/index.js"), []);
  // not an opencli path / no node_modules → no fallback
  assert.deepEqual(deriveOpencliFallbackCandidates("/srv/checkout/packages/opencli/dist/index.js"), []);
  assert.deepEqual(deriveOpencliFallbackCandidates(""), []);
});

test("prepareCliTransport: opencli wrapper carries exec-time fallback when nested-resolved", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  try {
    const ctx = makeCtx(tmp);
    const result = await prepareCliTransport(ctx, {}, "linux");
    const opencliWrapper = path.join(result.slockDir, "opencli");
    if (!existsSync(opencliWrapper)) return; // daemon build without opencli dep — nothing to assert
    const body = readFileSync(opencliWrapper, "utf8");
    assert.match(body, /OPENCLI_BIN='/);
    assert.match(body, /exec '[^']+' "\$OPENCLI_BIN" "\$@"/);
    // fallback block only when the resolved path is a nested computer-tree path;
    // in this repo checkout it resolves to the workspace node_modules, so just
    // pin that the wrapper executes via the variable (self-heal seam present).
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("writeOpencliWrapper: writes credential-free wrapper that execs the resolved bin", { skip: process.platform === "win32" }, () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-opencli-write-"));
  try {
    const slockDir = path.join(tmp, ".slock");
    mkdirSync(slockDir, { recursive: true });
    const bin = "/opt/homebrew/lib/node_modules/@jackwener/opencli/dist/src/main.js";
    writeOpencliWrapper(slockDir, bin, "linux");
    const body = readFileSync(path.join(slockDir, "opencli"), "utf8");
    assert.match(body, /^#!\/usr\/bin\/env bash/);
    assert.match(body, new RegExp(`OPENCLI_BIN='${bin.replace(/\//g, "\\/")}'`));
    assert.match(body, /exec '[^']+' "\$OPENCLI_BIN" "\$@"/);
    // top-level bin → no nested re-root fallback block
    assert.doesNotMatch(body, /if \[ ! -e "\$OPENCLI_BIN" \]/);
    // credential-free: no token/proxy/sk_ material in the opencli wrapper
    assert.doesNotMatch(body, /TOKEN|PROXY|sk_/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("writeOpencliWrapper: nested computer-tree bin bakes self-heal re-root to top-level", { skip: process.platform === "win32" }, () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-opencli-heal-"));
  try {
    const slockDir = path.join(tmp, ".slock");
    mkdirSync(slockDir, { recursive: true });
    const nested = "/opt/homebrew/lib/node_modules/@botiverse/raft-computer/node_modules/@jackwener/opencli/dist/src/main.js";
    writeOpencliWrapper(slockDir, nested, "linux");
    const body = readFileSync(path.join(slockDir, "opencli"), "utf8");
    // exec-time fallback re-roots the (subpath-preserving) nested path to the top-level install
    assert.match(body, /if \[ ! -e "\$OPENCLI_BIN" \]/);
    assert.match(body, /OPENCLI_BIN='\/opt\/homebrew\/lib\/node_modules\/@jackwener\/opencli\/dist\/src\/main\.js'/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("regenerateExistingOpencliWrappers: rewrites existing wrappers only, never creates for non-opencli agents", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "slock-opencli-regen-"));
  try {
    const bin = "/opt/homebrew/lib/node_modules/@jackwener/opencli/dist/src/main.js";
    // two agents with STALE opencli wrappers (old hardcoded-path form, no self-heal)
    const staleBody = "#!/usr/bin/env bash\nexec '/usr/bin/node' '/opt/homebrew/lib/node_modules/@botiverse/raft-computer/node_modules/@jackwener/opencli/dist/src/main.js' \"$@\"\n";
    for (const id of ["agent-a", "agent-b"]) {
      const sd = path.join(root, id, ".slock");
      mkdirSync(sd, { recursive: true });
      writeFileSync(path.join(sd, "opencli"), staleBody, { mode: 0o755 });
    }
    // an agent that does NOT use opencli (has .slock but no opencli wrapper)
    const noOpencli = path.join(root, "agent-c", ".slock");
    mkdirSync(noOpencli, { recursive: true });
    writeFileSync(path.join(noOpencli, "slock"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

    const result = regenerateExistingOpencliWrappers(root, "linux", bin);
    assert.deepEqual(result, { scanned: 2, rewritten: 2 });

    // existing wrappers were rewritten to the current variable-exec form
    for (const id of ["agent-a", "agent-b"]) {
      const body = readFileSync(path.join(root, id, ".slock", "opencli"), "utf8");
      assert.match(body, /OPENCLI_BIN=/);
      assert.match(body, /exec '[^']+' "\$OPENCLI_BIN" "\$@"/);
      assert.doesNotMatch(body, /@botiverse\/raft-computer\/node_modules/); // stale path gone
    }
    // the non-opencli agent never gets an opencli wrapper synthesized
    assert.ok(!existsSync(path.join(noOpencli, "opencli")), "must not create opencli wrapper for non-opencli agent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("regenerateExistingOpencliWrappers: no opencli resolvable → no-op {0,0}", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "slock-opencli-noop-"));
  try {
    const sd = path.join(root, "agent-a", ".slock");
    mkdirSync(sd, { recursive: true });
    writeFileSync(path.join(sd, "opencli"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    const result = regenerateExistingOpencliWrappers(root, "linux", null);
    assert.deepEqual(result, { scanned: 0, rewritten: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// task #402: when the daemon host IS the Electron binary (packaged Computer),
// the generated wrappers exec `process.execPath` = the Electron binary. Without
// ELECTRON_RUN_AS_NODE=1 the CLI helper boots the Electron GUI app (NSApplication
// run loop) and never exits, so `raft message check` hangs and the managed turn
// silently stalls. These wrappers MUST inject ELECTRON_RUN_AS_NODE=1 under an
// Electron host, and MUST NOT under a plain-node host (zero side effect).
test("prepareCliTransport: Electron host injects ELECTRON_RUN_AS_NODE into POSIX slock/raft wrappers", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  try {
    const ctx = makeCtx(tmp);
    const result = await prepareCliTransport(ctx, {}, "linux", /* execIsElectron */ true);
    for (const name of ["slock", "raft"]) {
      const body = readFileSync(path.join(result.slockDir, name), "utf8");
      assert.match(body, /export ELECTRON_RUN_AS_NODE=1/, `${name} wrapper must set ELECTRON_RUN_AS_NODE under Electron host`);
      // Must be set BEFORE the final exec line (so the exec'd Electron runs as Node).
      // The launch-forwarding guard contains a conditional `exec` for stale-wrapper
      // forwarding, so we compare against the last exec occurrence.
      assert.ok(
        body.indexOf("export ELECTRON_RUN_AS_NODE=1") < body.lastIndexOf("exec "),
        `${name} wrapper must export ELECTRON_RUN_AS_NODE=1 before the final exec`,
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareCliTransport: plain-node host does NOT inject ELECTRON_RUN_AS_NODE (POSIX)", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  try {
    const ctx = makeCtx(tmp);
    const result = await prepareCliTransport(ctx, {}, "linux", /* execIsElectron */ false);
    for (const name of ["slock", "raft"]) {
      const body = readFileSync(path.join(result.slockDir, name), "utf8");
      assert.doesNotMatch(body, /ELECTRON_RUN_AS_NODE/, `${name} wrapper must not mention ELECTRON_RUN_AS_NODE under plain-node host`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareCliTransport: Electron host injects ELECTRON_RUN_AS_NODE into win32 .cmd and .ps1 wrappers", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  try {
    const ctx = makeCtx(tmp);
    const result = await prepareCliTransport(ctx, {}, "win32", /* execIsElectron */ true);
    for (const name of ["slock.cmd", "raft.cmd"]) {
      const body = readFileSync(path.join(result.slockDir, name), "utf8");
      assert.match(body, /set "ELECTRON_RUN_AS_NODE=1"/, `${name} must set ELECTRON_RUN_AS_NODE under Electron host`);
    }
    for (const name of ["slock.ps1", "raft.ps1"]) {
      const body = readFileSync(path.join(result.slockDir, name), "utf8");
      assert.match(body, /\$env:ELECTRON_RUN_AS_NODE = '1'/, `${name} must set ELECTRON_RUN_AS_NODE under Electron host`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("writeOpencliWrapper: Electron host injects ELECTRON_RUN_AS_NODE (posix + cmd)", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-opencli-test-"));
  try {
    const bin = path.join(tmp, "opencli-main.js");
    writeFileSync(bin, "// opencli\n");
    // posix
    const sdPosix = path.join(tmp, "posix");
    mkdirSync(sdPosix, { recursive: true });
    writeOpencliWrapper(sdPosix, bin, "linux", /* execIsElectron */ true);
    const posixBody = readFileSync(path.join(sdPosix, "opencli"), "utf8");
    assert.match(posixBody, /export ELECTRON_RUN_AS_NODE=1/);
    assert.ok(posixBody.indexOf("export ELECTRON_RUN_AS_NODE=1") < posixBody.indexOf("exec "));
    // plain-node host: no injection
    const sdPlain = path.join(tmp, "plain");
    mkdirSync(sdPlain, { recursive: true });
    writeOpencliWrapper(sdPlain, bin, "linux", /* execIsElectron */ false);
    assert.doesNotMatch(readFileSync(path.join(sdPlain, "opencli"), "utf8"), /ELECTRON_RUN_AS_NODE/);
    // win32 cmd
    const sdWin = path.join(tmp, "win");
    mkdirSync(sdWin, { recursive: true });
    writeOpencliWrapper(sdWin, bin, "win32", /* execIsElectron */ true);
    assert.match(readFileSync(path.join(sdWin, "opencli.cmd"), "utf8"), /set "ELECTRON_RUN_AS_NODE=1"/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── launch forwarding guard (Stop→Start stale-wrapper protection) ───────────
//
// When a daemon restarts, the new launch writes fresh wrappers (W2) with W2
// credentials. Any cached absolute path to an old launch's wrapper (W1) must
// forward to W2 before W1's stale credential/proxy env is read. The guard is
// embedded in every daemon-generated wrapper and activated by SLOCK_AGENT_LAUNCH_DIR.

test("prepareCliTransport: POSIX wrapper embeds launch forwarding guard before credentials", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-guard-"));
  try {
    const ctx = makeCtx(tmp);
    const result = await prepareCliTransport(ctx, {}, "linux");
    const body = readFileSync(path.join(result.slockDir, "slock"), "utf8");
    assert.match(body, /# slock-daemon-generated/);
    assert.match(body, /SLOCK_OWN_LAUNCH_DIR=/);
    assert.match(body, /SLOCK_AGENT_LAUNCH_DIR/);
    // Guard must appear before the credential line so stale wrappers forward
    // before any stale credential env is set.
    const guardIdx = body.indexOf("SLOCK_OWN_LAUNCH_DIR=");
    const credentialIdx = body.indexOf("SLOCK_AGENT_TOKEN_FILE=");
    assert.ok(guardIdx > 0);
    assert.ok(credentialIdx > 0);
    assert.ok(guardIdx < credentialIdx, "launch guard must precede credential line");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareCliTransport: win32 .cmd wrapper embeds launch forwarding guard after @echo off", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-guard-"));
  try {
    const ctx = makeCtx(tmp);
    const result = await prepareCliTransport(ctx, {}, "win32");
    const body = readFileSync(path.join(result.slockDir, "slock.cmd"), "utf8");
    assert.match(body, /@REM slock-daemon-generated/);
    assert.match(body, /set "SLOCK_OWN_LAUNCH_DIR=/);
    assert.match(body, /SLOCK_AGENT_LAUNCH_DIR/);
    const lines = body.split(/\r?\n/);
    assert.equal(lines[0], "@echo off");
    assert.ok(lines[1].includes("slock-daemon-generated"), "guard should immediately follow @echo off");
    // Backslash separators and special sequences must survive TypeScript string
    // literal generation without being interpreted as escapes or newlines.
    assert.match(body, /!SLOCK_AGENT_ROOT!\\!SLOCK_SEL!/);
    assert.match(body, /if exist "!SLOCK_FORWARD_DIR!\\" \(/);
    assert.doesNotMatch(body, /!SLOCK_FORWARD_DIR!\\nul/);
    assert.match(body, /!SLOCK_FORWARD_DIR!\\%~nx0/);
    assert.doesNotMatch(body, /(?<!\r)\n/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareCliTransport: win32 .ps1 wrapper embeds launch forwarding guard at the top", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-guard-"));
  try {
    const ctx = makeCtx(tmp);
    const result = await prepareCliTransport(ctx, {}, "win32");
    const body = readFileSync(path.join(result.slockDir, "slock.ps1"), "utf8");
    assert.match(body, /# slock-daemon-generated/);
    assert.match(body, /\$SlockOwnLaunchDir = /);
    assert.match(body, /\$env:SLOCK_AGENT_LAUNCH_DIR/);
    const lines = body.split(/\r?\n/);
    assert.ok(lines[0].includes("slock-daemon-generated"), "guard should be the first line of the ps1 wrapper");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareCliTransport: returns slockHome and sets SLOCK_AGENT_LAUNCH_DIR in spawnEnv", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-guard-"));
  const slockHome = path.join(tmp, "home");
  const oldSlockHome = process.env.SLOCK_HOME;
  try {
    process.env.SLOCK_HOME = slockHome;
    const ctx = makeCtx(tmp);
    const result = await prepareCliTransport(ctx, {}, "linux");
    assert.equal(result.slockHome, path.resolve(slockHome));
    assert.equal(result.spawnEnv[SLOCK_AGENT_LAUNCH_DIR_ENV], path.basename(result.slockDir));
    assert.ok(result.spawnEnv.PATH?.startsWith(result.slockDir));
  } finally {
    if (oldSlockHome === undefined) {
      delete process.env.SLOCK_HOME;
    } else {
      process.env.SLOCK_HOME = oldSlockHome;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("upgradeExistingAgentWrappers: upgrades prior-launch daemon wrappers and skips current launch", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "slock-upgrade-"));
  try {
    const agentId = "test-agent-id";
    const agentRoot = path.join(root, agentId);
    const oldLaunchDir = path.join(agentRoot, "pid-11111");
    const currentLaunchDir = path.join(agentRoot, "pid-22222");
    mkdirSync(oldLaunchDir, { recursive: true });
    mkdirSync(currentLaunchDir, { recursive: true });

    // Old launch wrappers (pre-guard shape, daemon-generated).
    const oldPosix = `#!/usr/bin/env bash\nSLOCK_AGENT_ID='test-agent-id' SLOCK_SERVER_URL='https://test.slock.dev' SLOCK_AGENT_TOKEN_FILE='/old/token' exec /old/node /old/cli "$@"\n`;
    writeFileSync(path.join(oldLaunchDir, "slock"), oldPosix, { mode: 0o755 });
    writeFileSync(path.join(oldLaunchDir, "raft"), oldPosix, { mode: 0o755 });

    // Current launch wrappers (new guard shape).
    writeFileSync(path.join(currentLaunchDir, "slock"), "# current\n", { mode: 0o755 });

    // Foreign / non-daemon file that should not be touched.
    writeFileSync(path.join(oldLaunchDir, "user-script.sh"), "# user\n");

    const result = upgradeExistingAgentWrappers(agentRoot, currentLaunchDir, "linux");
    assert.equal(result.scanned, 2, "should scan the two old wrapper files");
    assert.equal(result.upgraded, 2, "should upgrade both old wrappers");

    const upgradedBody = readFileSync(path.join(oldLaunchDir, "slock"), "utf8");
    assert.match(upgradedBody, /# slock-daemon-generated/);
    assert.match(upgradedBody, /SLOCK_OWN_LAUNCH_DIR=/);
    // It must still retain the original identity/credential wiring.
    assert.match(upgradedBody, /SLOCK_AGENT_ID='test-agent-id'/);
    assert.match(upgradedBody, /SLOCK_SERVER_URL='https:\/\/test\.slock\.dev'/);

    // Current launch and foreign files unchanged.
    assert.equal(readFileSync(path.join(currentLaunchDir, "slock"), "utf8"), "# current\n");
    assert.equal(readFileSync(path.join(oldLaunchDir, "user-script.sh"), "utf8"), "# user\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("upgradeExistingAgentWrappers: skips symlinks and non-regular files", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "slock-upgrade-skip-"));
  try {
    const agentRoot = path.join(root, "agent");
    const oldLaunchDir = path.join(agentRoot, "pid-11111");
    const currentLaunchDir = path.join(agentRoot, "pid-22222");
    mkdirSync(oldLaunchDir, { recursive: true });
    mkdirSync(currentLaunchDir, { recursive: true });

    const oldPosix = `#!/usr/bin/env bash\nSLOCK_AGENT_ID='a' SLOCK_SERVER_URL='https://x' exec /n "$@"\n`;
    const regularPath = path.join(oldLaunchDir, "slock");
    writeFileSync(regularPath, oldPosix, { mode: 0o755 });

    // Symlink to the regular wrapper.
    const symlinkPath = path.join(oldLaunchDir, "raft");
    try {
      // Windows tests may not have symlink privileges; skip if it fails.
      // eslint-disable-next-line @slock-ai/node/prefer-symlink
      require("node:fs").symlinkSync(regularPath, symlinkPath);
    } catch {
      return;
    }

    const result = upgradeExistingAgentWrappers(agentRoot, currentLaunchDir, "linux");
    assert.equal(result.scanned, 1, "only the regular file should be scanned");
    assert.equal(result.upgraded, 1, "only the regular file should be upgraded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── adversarial launch forwarding guard execution tests ────────────────────
//
// The guard must deterministically route stale absolute wrapper invocations to
// the current launch while rejecting traversal, foreign-agent selectors, and
// missing selectors. These tests spawn the actual generated wrappers.

function makeTokenPrintingCli(tmp: string): string {
  const cli = path.join(tmp, "fake-cli.cjs");
  writeFileSync(
    cli,
    `const { readFileSync } = require("node:fs");\n` +
      `const tokenFile = process.env.SLOCK_AGENT_TOKEN_FILE || process.env.SLOCK_AGENT_PROXY_TOKEN_FILE || "NO_TOKEN";\n` +
      `try { console.log(readFileSync(tokenFile, "utf8").trim()); } catch (e) { console.log("ERR:" + e.message); }\n`,
    "utf8",
  );
  return cli;
}

function runWrapper(wrapperPath: string, env: Record<string, string | undefined>): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(wrapperPath, ["message", "check"], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  }) as { status: number | null; stdout: string; stderr: string };
  return result;
}

async function setupForwardedLaunchFixture(tmp: string): Promise<{
  agentRoot: string;
  w1Wrapper: string;
  w2Wrapper: string;
  w2Dir: string;
}> {
  const slockHome = path.join(tmp, "home");
  process.env.SLOCK_HOME = slockHome;
  const fakeCli = makeTokenPrintingCli(tmp);
  const agentId = "agent-a";
  const agentRoot = path.join(slockHome, "cli-transport", agentId);

  // W1: old daemon wrapper shape without a guard.
  const w1Dir = path.join(agentRoot, "w1");
  mkdirSync(w1Dir, { recursive: true });
  writeFileSync(path.join(w1Dir, "agent-token"), "W1", { mode: 0o600 });
  const w1Body =
    `#!/usr/bin/env bash\n` +
    `SLOCK_AGENT_ID='agent-a' SLOCK_SERVER_URL='https://x' ` +
    `SLOCK_AGENT_TOKEN_FILE='${path.join(w1Dir, "agent-token")}' ` +
    `exec ${process.execPath} ${fakeCli} "$@"\n`;
  writeFileSync(path.join(w1Dir, "raft"), w1Body, { mode: 0o755 });

  // W2: generated by prepareCliTransport. This also upgrades the W1 wrapper
  // with the launch forwarding guard.
  const ctx = makeCtx(tmp);
  ctx.agentId = agentId;
  ctx.launchId = "w2";
  ctx.slockCliPath = fakeCli;
  (ctx.config as { authToken: string }).authToken = "W2";
  const transport = await prepareCliTransport(ctx, {}, "linux");

  return {
    agentRoot,
    w1Wrapper: path.join(w1Dir, "raft"),
    w2Wrapper: path.join(transport.slockDir, "raft"),
    w2Dir: transport.slockDir,
  };
}

test("launch forwarding guard: W2 selector executing W1 absolute wrapper forwards to W2", { skip: process.platform === "win32" }, async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-forward-"));
  const oldSlockHome = process.env.SLOCK_HOME;
  try {
    const { w1Wrapper, w2Wrapper } = await setupForwardedLaunchFixture(tmp);
    assert.ok(existsSync(w2Wrapper), "W2 raft wrapper must exist");

    const result = runWrapper(w1Wrapper, { SLOCK_AGENT_LAUNCH_DIR: "w2" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout.trim(), "W2", "W1 wrapper with W2 selector must forward to W2");
  } finally {
    if (oldSlockHome === undefined) delete process.env.SLOCK_HOME;
    else process.env.SLOCK_HOME = oldSlockHome;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("launch forwarding guard: rejects own, empty, foreign, and traversal selectors", { skip: process.platform === "win32" }, async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-forward-reject-"));
  const oldSlockHome = process.env.SLOCK_HOME;
  try {
    const { w1Wrapper, agentRoot } = await setupForwardedLaunchFixture(tmp);

    // Foreign agent wrapper (agent-b/wb). It is never reachable from agent-a.
    const wbDir = path.join(slockHomeFromFixture(tmp, "agent-b"), "wb");
    mkdirSync(wbDir, { recursive: true });
    writeFileSync(path.join(wbDir, "agent-token"), "B", { mode: 0o600 });
    const wbBody =
      `#!/usr/bin/env bash\n` +
      `SLOCK_AGENT_ID='agent-b' SLOCK_SERVER_URL='https://x' ` +
      `SLOCK_AGENT_TOKEN_FILE='${path.join(wbDir, "agent-token")}' ` +
      `exec ${process.execPath} ${makeTokenPrintingCli(tmp)} "$@"\n`;
    writeFileSync(path.join(wbDir, "raft"), wbBody, { mode: 0o755 });

    const cases: Array<{ selector?: string; expected: string; label: string }> = [
      { selector: undefined, expected: "W1", label: "no selector" },
      { selector: "w1", expected: "W1", label: "own selector" },
      { selector: "wb", expected: "W1", label: "foreign launch part under own agent root" },
      { selector: "agent-a/../agent-b/wb", expected: "W1", label: "traversal selector" },
    ];

    for (const { selector, expected, label } of cases) {
      const env: Record<string, string | undefined> = selector === undefined ? {} : { SLOCK_AGENT_LAUNCH_DIR: selector };
      const result = runWrapper(w1Wrapper, env);
      assert.equal(result.status, 0, `${label}: ${result.stderr || result.stdout}`);
      assert.equal(result.stdout.trim(), expected, `${label} must not forward`);
    }
  } finally {
    if (oldSlockHome === undefined) delete process.env.SLOCK_HOME;
    else process.env.SLOCK_HOME = oldSlockHome;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("launch forwarding guard: rejects symlink launch directory pointing to foreign agent", { skip: process.platform === "win32" }, async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-forward-symlink-dir-"));
  const oldSlockHome = process.env.SLOCK_HOME;
  try {
    const { w1Wrapper, agentRoot } = await setupForwardedLaunchFixture(tmp);

    // Foreign agent-b/wb with a wrapper that prints "B".
    const wbDir = path.join(slockHomeFromFixture(tmp, "agent-b"), "wb");
    mkdirSync(wbDir, { recursive: true });
    writeFileSync(path.join(wbDir, "agent-token"), "B", { mode: 0o600 });
    const wbBody =
      `#!/usr/bin/env bash\n` +
      `SLOCK_AGENT_ID='agent-b' SLOCK_SERVER_URL='https://x' ` +
      `SLOCK_AGENT_TOKEN_FILE='${path.join(wbDir, "agent-token")}' ` +
      `exec ${process.execPath} ${makeTokenPrintingCli(tmp)} "$@"\n`;
    writeFileSync(path.join(wbDir, "raft"), wbBody, { mode: 0o755 });

    // Symlink launch dir under agent-a that points to the foreign agent tree.
    const symlinkDir = path.join(agentRoot, "w2-symlink");
    try {
      symlinkSync(wbDir, symlinkDir);
    } catch {
      // Symlinks may require privileges on Windows; skip if we cannot create one.
      return;
    }

    const result = runWrapper(w1Wrapper, { SLOCK_AGENT_LAUNCH_DIR: "w2-symlink" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout.trim(), "W1", "symlink launch dir to foreign agent must fail-closed to W1");
  } finally {
    if (oldSlockHome === undefined) delete process.env.SLOCK_HOME;
    else process.env.SLOCK_HOME = oldSlockHome;
    rmSync(tmp, { recursive: true, force: true });
  }
});

function slockHomeFromFixture(tmp: string, agentId?: string): string {
  const home = path.join(tmp, "home", "cli-transport");
  return agentId ? path.join(home, agentId) : home;
}

test("launch forwarding guard: mutation test — no forward without guard/upgrade", { skip: process.platform === "win32" }, async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-forward-mutation-"));
  const oldSlockHome = process.env.SLOCK_HOME;
  try {
    process.env.SLOCK_HOME = path.join(tmp, "home");
    const fakeCli = makeTokenPrintingCli(tmp);
    const agentId = "agent-a";
    const agentRoot = path.join(process.env.SLOCK_HOME, "cli-transport", agentId);

    // W2 wrapper first, so prepareCliTransport does not upgrade W1 yet.
    const ctxW2 = makeCtx(tmp);
    ctxW2.agentId = agentId;
    ctxW2.launchId = "w2";
    ctxW2.slockCliPath = fakeCli;
    (ctxW2.config as { authToken: string }).authToken = "W2";
    const w2Transport = await prepareCliTransport(ctxW2, {}, "linux");

    // W1 old wrapper written after W2 generation (no guard).
    const w1Dir = path.join(agentRoot, "w1");
    mkdirSync(w1Dir, { recursive: true });
    writeFileSync(path.join(w1Dir, "agent-token"), "W1", { mode: 0o600 });
    const w1Body =
      `#!/usr/bin/env bash\n` +
      `SLOCK_AGENT_ID='agent-a' SLOCK_SERVER_URL='https://x' ` +
      `SLOCK_AGENT_TOKEN_FILE='${path.join(w1Dir, "agent-token")}' ` +
      `exec ${process.execPath} ${fakeCli} "$@"\n`;
    const w1Wrapper = path.join(w1Dir, "raft");
    writeFileSync(w1Wrapper, w1Body, { mode: 0o755 });

    // RED: without the guard, W2 selector runs W1's credential.
    const red = runWrapper(w1Wrapper, { SLOCK_AGENT_LAUNCH_DIR: "w2" });
    assert.equal(red.status, 0, red.stderr || red.stdout);
    assert.equal(red.stdout.trim(), "W1", "pre-upgrade wrapper must not forward (RED)");

    // GREEN: after upgrading W1 with the guard, W2 selector forwards.
    upgradeExistingAgentWrappers(agentRoot, w2Transport.slockDir, "linux");
    const green = runWrapper(w1Wrapper, { SLOCK_AGENT_LAUNCH_DIR: "w2" });
    assert.equal(green.status, 0, green.stderr || green.stdout);
    assert.equal(green.stdout.trim(), "W2", "upgraded wrapper must forward to W2 (GREEN)");
  } finally {
    if (oldSlockHome === undefined) delete process.env.SLOCK_HOME;
    else process.env.SLOCK_HOME = oldSlockHome;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("upgradeExistingAgentWrappers: skips symlink launch dirs", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "slock-upgrade-symlink-dir-"));
  try {
    const agentRoot = path.join(root, "agent");
    const w1Dir = path.join(agentRoot, "w1");
    const w2Link = path.join(agentRoot, "w2-link");
    const currentLaunchDir = path.join(agentRoot, "w3");
    mkdirSync(w1Dir, { recursive: true });
    mkdirSync(currentLaunchDir, { recursive: true });

    const oldPosix = `#!/usr/bin/env bash\nSLOCK_AGENT_ID='a' SLOCK_SERVER_URL='https://x' exec /n "$@"\n`;
    writeFileSync(path.join(w1Dir, "slock"), oldPosix, { mode: 0o755 });

    try {
      symlinkSync(path.join(agentRoot, ".."), w2Link);
    } catch {
      // Symlinks may require privileges on Windows; skip the test if we cannot
      // create one.
      return;
    }

    const result = upgradeExistingAgentWrappers(agentRoot, currentLaunchDir, "linux");
    assert.equal(result.scanned, 1, "only the regular launch dir should be scanned");
    assert.equal(result.upgraded, 1, "only the regular launch dir should be upgraded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("launch forwarding guard: win32 .cmd W2 selector forwards argv and exit code from W1 absolute wrapper", { skip: process.platform !== "win32" }, async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-forward-cmd-"));
  const oldSlockHome = process.env.SLOCK_HOME;
  try {
    process.env.SLOCK_HOME = path.join(tmp, "home");
    const agentId = "agent-a";
    const agentRoot = path.join(process.env.SLOCK_HOME, "cli-transport", agentId);

    function makeArgvEchoCli(outPath: string, exitCode: number): string {
      const cli = path.join(tmp, `fake-cli-${exitCode}.cjs`);
      const outPathJson = JSON.stringify(outPath);
      writeFileSync(
        cli,
        `const { writeFileSync } = require("node:fs");\n` +
          `const { argv, exit } = require("node:process");\n` +
          `writeFileSync(${outPathJson}, JSON.stringify(argv.slice(2)), "utf8");\n` +
          `exit(${exitCode});\n`,
        "utf8",
      );
      return cli;
    }

    function safeRemove(p: string): void {
      try {
        rmSync(p);
      } catch {
        // ignore absent files
      }
    }

    // W1 old .cmd wrapper shape without a guard.
    const w1Dir = path.join(agentRoot, "w1");
    mkdirSync(w1Dir, { recursive: true });
    const w1Out = path.join(w1Dir, "w1-out.json");
    const w1Cli = makeArgvEchoCli(w1Out, 0);
    const w1Cmd = path.join(w1Dir, "raft.cmd");
    const w1Body = [
      "@echo off",
      'set "SLOCK_AGENT_ID=agent-a"',
      'set "SLOCK_SERVER_URL=https://x"',
      `"${process.execPath}" "${w1Cli}" %*`,
      "",
    ].join("\r\n");
    writeFileSync(w1Cmd, w1Body + "\r\n");

    // W2 generated by prepareCliTransport; upgrades W1.cmd.
    // W2 fake CLI exits with a non-zero code so we can prove the outer cmd.exe
    // surface receives the forwarded process's exit code unchanged.
    const w2Out = path.join(tmp, "w2-out.json");
    const w2Cli = makeArgvEchoCli(w2Out, 42);
    const ctx = makeCtx(tmp);
    ctx.agentId = agentId;
    ctx.launchId = "w2";
    ctx.slockCliPath = w2Cli;
    (ctx.config as { authToken: string }).authToken = "W2";
    await prepareCliTransport(ctx, {}, "win32");

    // Diagnostic: evaluate the same predicates the production .cmd guard uses,
    // then actually invoke the W1 wrapper and report which sentinel fired.
    // All probes run inside a single cmd.exe so path/env semantics match the
    // real invocation exactly. No production code changes.
    const diagOut = path.join(tmp, "diag.txt");
    const fsutilOut = path.join(tmp, "fsutil.txt");
    const diagCmd = path.join(tmp, "diag.cmd");
    const diagBody = [
      "@echo off",
      "setlocal enabledelayedexpansion",
      `set "SLOCK_AGENT_ROOT=${agentRoot}"`,
      `set "SLOCK_OWN_LAUNCH_DIR=w1"`,
      'set "SLOCK_AGENT_LAUNCH_DIR=w2"',
      `set "DIAG_OUT=${diagOut}"`,
      `set "W1_CMD=${w1Cmd}"`,
      `set "W1_OUT=${w1Out}"`,
      `set "W2_OUT=${w2Out}"`,
      '(echo selector=%SLOCK_AGENT_LAUNCH_DIR%) > "%DIAG_OUT%"',
      '(echo own=%SLOCK_OWN_LAUNCH_DIR%) >> "%DIAG_OUT%"',
      '(echo root=%SLOCK_AGENT_ROOT%) >> "%DIAG_OUT%"',
      'set "SLOCK_FORWARD_DIR=%SLOCK_AGENT_ROOT%\\%SLOCK_AGENT_LAUNCH_DIR%"',
      '(echo forwardDir=%SLOCK_FORWARD_DIR%) >> "%DIAG_OUT%"',
      'if exist "%SLOCK_FORWARD_DIR%\\nul" (echo existNul=YES) else (echo existNul=NO) >> "%DIAG_OUT%"',
      'if exist "%SLOCK_FORWARD_DIR%\\" (echo existTrailingSlash=YES) else (echo existTrailingSlash=NO) >> "%DIAG_OUT%"',
      `fsutil reparsepoint query "%SLOCK_FORWARD_DIR%" > "${fsutilOut}" 2>&1`,
      '(echo fsutilErrorlevel=%errorlevel%) >> "%DIAG_OUT%"',
      '(echo fsutilOutput=) >> "%DIAG_OUT%"',
      `type "${fsutilOut}" >> "%DIAG_OUT%"`,
      'set "SLOCK_FORWARD_WRAPPER=%SLOCK_FORWARD_DIR%\\raft.cmd"',
      '(echo forwardWrapper=%SLOCK_FORWARD_WRAPPER%) >> "%DIAG_OUT%"',
      'if exist "%SLOCK_FORWARD_WRAPPER%" (echo wrapperExists=YES) else (echo wrapperExists=NO) >> "%DIAG_OUT%"',
      'if not exist "%SLOCK_FORWARD_WRAPPER%\\" (echo wrapperNotDir=YES) else (echo wrapperNotDir=NO) >> "%DIAG_OUT%"',
      'call "%W1_CMD%" message check',
      '(echo w1CmdErrorlevel=%errorlevel%) >> "%DIAG_OUT%"',
      'if exist "%W1_OUT%" (echo w1OutExists=YES) else (echo w1OutExists=NO) >> "%DIAG_OUT%"',
      'if exist "%W2_OUT%" (echo w2OutExists=YES) else (echo w2OutExists=NO) >> "%DIAG_OUT%"',
      "endlocal",
    ].join("\r\n");
    writeFileSync(diagCmd, diagBody + "\r\n");
    const diagResult = spawnSync("cmd.exe", ["/c", diagCmd], {
      env: { ...process.env, SLOCK_AGENT_LAUNCH_DIR: "w2" },
      encoding: "utf8",
    }) as { status: number | null; stdout: string; stderr: string };
    const diagText = existsSync(diagOut) ? readFileSync(diagOut, "utf8") : "<diag file missing>";
    console.log(
      "WIN32_GUARD_DIAGNOSTIC:\n" +
        diagText +
        "\ndiag_status=" +
        diagResult.status +
        " diag_stdout=" +
        diagResult.stdout +
        " diag_stderr=" +
        diagResult.stderr,
    );

    const result = spawnSync("cmd.exe", ["/c", w1Cmd, "message", "check"], {
      env: { ...process.env, SLOCK_AGENT_LAUNCH_DIR: "w2" },
      encoding: "utf8",
    }) as { status: number | null; stdout: string; stderr: string };
    const w2Ran = existsSync(w2Out);
    const w1Ran = existsSync(w1Out);
    assert.equal(w2Ran, true, `W2 must execute (w2Out exists); status=${result.status}; stdout=${result.stdout}; stderr=${result.stderr}`);
    assert.equal(w1Ran, false, `W1 must not execute when selector forwards to W2; status=${result.status}`);
    assert.equal(result.status, 42, `W2 exit code must propagate to outer cmd.exe; w2Ran=${w2Ran}, w1Ran=${w1Ran}`);
    const forwardedArgv = JSON.parse(readFileSync(w2Out, "utf8")) as string[];
    assert.deepEqual(forwardedArgv, ["message", "check"], "W1.cmd must forward argv unchanged to W2");

    // Traversal selector must be rejected and execute W1 instead.
    safeRemove(w1Out);
    safeRemove(w2Out);
    const traversal = spawnSync("cmd.exe", ["/c", w1Cmd, "message", "check"], {
      env: { ...process.env, SLOCK_AGENT_LAUNCH_DIR: "agent-a/../agent-b/wb" },
      encoding: "utf8",
    }) as { status: number | null; stdout: string; stderr: string };
    assert.equal(existsSync(w1Out), true, "traversal selector must execute W1 (w1Out exists)");
    assert.equal(existsSync(w2Out), false, "traversal selector must not execute W2 (w2Out absent)");
    assert.equal(traversal.status, 0, traversal.stderr || traversal.stdout);
    const traversalArgv = JSON.parse(readFileSync(w1Out, "utf8")) as string[];
    assert.deepEqual(traversalArgv, ["message", "check"], "traversal selector must fail-closed to W1");

    // Directory reparse point / symlink parent must be rejected.
    const foreignDir = path.join(process.env.SLOCK_HOME, "cli-transport", "agent-b", "wb");
    mkdirSync(foreignDir, { recursive: true });
    const foreignOut = path.join(tmp, "foreign-out.json");
    const foreignCli = makeArgvEchoCli(foreignOut, 99);
    const foreignCmd = path.join(foreignDir, "raft.cmd");
    writeFileSync(
      foreignCmd,
      [
        "@echo off",
        'set "SLOCK_AGENT_ID=agent-b"',
        'set "SLOCK_SERVER_URL=https://x"',
        `"${process.execPath}" "${foreignCli}" %*`,
        "",
      ].join("\r\n") + "\r\n",
    );

    const linkName = path.join(agentRoot, "w2-link");
    let linkCreated = false;
    try {
      // Junctions do not require elevated privileges on Windows and are reparse
      // points, so they exercise the fsutil check in the .cmd guard.
      symlinkSync(foreignDir, linkName, "junction");
      linkCreated = true;
    } catch {
      // If junction creation fails (non-Windows or missing privileges), skip the
      // reparse-point sub-test; the traversal assertion above still pins the
      // fail-closed behavior for malformed selectors.
    }

    if (linkCreated) {
      safeRemove(w1Out);
      const linkResult = spawnSync("cmd.exe", ["/c", w1Cmd, "message", "check"], {
        env: { ...process.env, SLOCK_AGENT_LAUNCH_DIR: "w2-link" },
        encoding: "utf8",
      }) as { status: number | null; stdout: string; stderr: string };
      assert.equal(existsSync(w1Out), true, "junction launch dir must execute W1 (w1Out exists)");
      assert.equal(existsSync(foreignOut), false, "foreign wrapper must not execute when parent is a reparse point (foreignOut absent)");
      assert.equal(linkResult.status, 0, linkResult.stderr || linkResult.stdout);
      const linkArgv = JSON.parse(readFileSync(w1Out, "utf8")) as string[];
      assert.deepEqual(linkArgv, ["message", "check"], "symlink/junction launch dir parent must fail-closed to W1");
    }
  } finally {
    if (oldSlockHome === undefined) delete process.env.SLOCK_HOME;
    else process.env.SLOCK_HOME = oldSlockHome;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("writeOpencliWrapper survives a SEA host instead of throwing before its own SEA path", () => {
  // The regression this pins reached review PASS and hosted green: making
  // resolveNodeHostLaunch throw for `sea` cut this function off before the
  // Computer's own SEA handling, which would have broken CLI transport on
  // every official install. Nothing caught it because the test host is plain
  // Node, so the SEA branch could not be exercised at all.
  const dir = mkdtempSync(path.join(os.tmpdir(), "opencli-sea-"));
  try {
    const bin = path.join(dir, "opencli");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    // Must not throw.
    writeOpencliWrapper(dir, bin, "linux", false, () => true);
    const wrapper = readFileSync(path.join(dir, "opencli"), "utf8");
    assert.ok(wrapper.length > 0, "a SEA host must still get a wrapper written");
    assert.doesNotMatch(wrapper, /ELECTRON_RUN_AS_NODE/, "a SEA is not Electron and must not get its flag");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeOpencliWrapper treats an unidentified host explicitly, not as Electron", () => {
  // `unknown` is a decision, not an inheritance: we did not identify the host,
  // so we must not guess that it wants the Electron flag.
  const dir = mkdtempSync(path.join(os.tmpdir(), "opencli-unknown-"));
  try {
    const bin = path.join(dir, "opencli");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeOpencliWrapper(dir, bin, "linux", false, () => undefined);
    const wrapper = readFileSync(path.join(dir, "opencli"), "utf8");
    assert.ok(wrapper.length > 0);
    assert.doesNotMatch(wrapper, /ELECTRON_RUN_AS_NODE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prepareCliTransport survives a SEA host instead of throwing before the __cli path", async () => {
  // Mirror of the writeOpencliWrapper tooth. Both call sites got the same code
  // change; only one got a seam, so reverting THIS site's guard alone left the
  // suite green. One red proves one site is guarded, not both — sites that
  // share a change need independently reachable states.
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-sea-"));
  try {
    const ctx = makeCtx(tmp);
    const result = await prepareCliTransport(ctx, {}, "linux", false, () => true);
    assert.ok(existsSync(path.join(result.slockDir, "slock")), "a SEA host must still get its wrappers prepared");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareCliTransport treats an unidentified host explicitly, not as Electron", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-unknown-"));
  try {
    const ctx = makeCtx(tmp);
    const result = await prepareCliTransport(ctx, {}, "linux", false, () => undefined);
    const wrapper = readFileSync(path.join(result.slockDir, "slock"), "utf8");
    assert.doesNotMatch(wrapper, /ELECTRON_RUN_AS_NODE/, "an unidentified host must not be guessed into Electron mode");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
