// Tests for prepareCliTransport wrapper generation across platforms.

import { withProcessEnvPatch } from "../processEnvPatch";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildCliTransportDir, spawnCliTransportDir, POWERSHELL_WRAPPER_ENV_NAMES, deriveCliFallbackCandidates, deriveOpencliFallbackCandidates, prepareCliTransport, RAFT_CURRENT_RUNTIME_ENV, setProcSelfExeReaderForTests, regenerateExistingOpencliWrappers, removeStaleAgentTokenFiles, SLOCK_AGENT_LAUNCH_DIR_ENV, upgradeExistingAgentWrappers, resolveOpencliBinPath, writeOpencliWrapper } from "./cliTransport";
import { CONTEXT_GENERATION_FILENAME } from "@botiverse/raft-shared";
import { applyLoopbackNoProxyEnv } from "../loopbackNoProxy";
import type { SpawnContext } from "./types";
import { getDriver } from "./index";
import { setDaemonFetchImplForTests } from "../daemonFetch";

const originalSlockHome = process.env.SLOCK_HOME;
const testSlockHome = mkdtempSync(path.join(os.tmpdir(), "slock-cli-home-"));
let nextLaunchId = 0;
const LAUNCH_CREATED_AT_FILENAME = ".slock-launch-created-at";

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

// D1 (RFC 072 §7.7): the context id exists before the runtime process does, in
// the directory the process is told about, and every spawn gets a new one.
// It is planned by whoever holds the driver (its compaction declaration); the
// transport publishes that plan and never guesses one.
test("prepareCliTransport publishes the spawn context generation it was planned with", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  try {
    const base = { ...makeCtx(tmp, { runtime: "gemini" }), slockHome: testSlockHome };
    const plan = (contextId: string) => ({ contextId, reason: "spawn" as const, compaction: getDriver("gemini").session.compaction });
    const ctx = { ...base, contextGeneration: plan("ctx-1") };
    const first = await prepareCliTransport(ctx, {}, "linux");
    assert.equal(first.spawnEnv.SLOCK_CLI_TRANSPORT_DIR, first.slockDir);
    // The APM derives the same directory for compaction writes from these inputs.
    assert.equal(first.slockDir, buildCliTransportDir(testSlockHome, ctx.agentId, ctx.launchId));
    assert.equal(first.slockDir, spawnCliTransportDir(ctx), "the OAR host plans in this directory");
    const file = path.join(first.slockDir, CONTEXT_GENERATION_FILENAME);
    const firstRecord = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(firstRecord.reason, "spawn");
    assert.equal(firstRecord.runtime, "gemini");
    assert.equal(firstRecord.compactionReported, false, "gemini's driver declares it does not report compaction");
    assert.equal(firstRecord.passiveAx, false, "no gate on the config ⇒ published off");
    assert.equal(firstRecord.contextId, "ctx-1");

    // Same launchId means the same directory: a respawn must still replace the id.
    const second = await prepareCliTransport({ ...ctx, contextGeneration: plan("ctx-2") }, {}, "linux");
    assert.equal(second.slockDir, first.slockDir);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).contextId, "ctx-2");

    // task #359: the composed gate on the spawn config is published as-is.
    await prepareCliTransport({ ...ctx, config: { ...ctx.config, passiveAx: true } as typeof ctx.config }, {}, "linux");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).passiveAx, true);

    // Without a plan nothing says whether the runtime reports compaction: no id is
    // published, and the respawn's earlier one is removed (signal unknown).
    await prepareCliTransport(base, {}, "linux");
    assert.equal(existsSync(file), false);
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

test("prepareCliTransport keeps an agent-configured PATH behind the wrapper dir (slock#8610)", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  const originalPath = process.env.PATH;
  process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin"; // minimal service PATH
  try {
    const configured = "/opt/homebrew/bin:/Users/x/.local/bin:/usr/bin:/bin";
    const withAgentPath = await prepareCliTransport(makeCtx(tmp, {
      runtimeConfig: { version: 1, runtime: "claude", provider: { kind: "default" }, model: { kind: "default" }, mode: { kind: "default" }, envVars: { PATH: configured } },
    }), {}, "linux");
    assert.equal(withAgentPath.spawnEnv.PATH, `${withAgentPath.slockDir}${path.delimiter}${configured}`);

    // No configured PATH → the daemon's PATH, as before.
    const plain = await prepareCliTransport(makeCtx(tmp), {}, "linux");
    assert.equal(plain.spawnEnv.PATH, `${plain.slockDir}${path.delimiter}/usr/bin:/bin:/usr/sbin:/sbin`);

    // A driver-supplied PATH wins over both (same precedence as other env vars).
    const driver = await prepareCliTransport(makeCtx(tmp, {
      runtimeConfig: { version: 1, runtime: "claude", provider: { kind: "default" }, model: { kind: "default" }, mode: { kind: "default" }, envVars: { PATH: configured } },
    }), { PATH: "/driver/bin" }, "linux");
    assert.equal(driver.spawnEnv.PATH, `${driver.slockDir}${path.delimiter}/driver/bin`);
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareCliTransport on Windows reads the daemon's `Path` in any case and leaves the runtime one PATH", async () => {
  // Windows process.env is case-insensitive and usually spells it `Path`; the
  // plain copy the transport builds from is not. 1.0.48 read `.PATH` from that
  // copy, found nothing, and gave every Windows runtime only the wrapper dir.
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  const originalPath = process.env.PATH;
  const originalWinPath = process.env.Path;
  delete process.env.PATH;
  process.env.Path = "C:\\Windows\\System32;C:\\Program Files\\nodejs";
  try {
    const result = await prepareCliTransport(makeCtx(tmp), {}, "win32");
    const pathKeys = Object.keys(result.spawnEnv).filter((key) => key.toLowerCase() === "path");
    assert.deepEqual(pathKeys, ["PATH"]);
    assert.equal(result.spawnEnv.PATH, `${result.slockDir}${path.delimiter}C:\\Windows\\System32;C:\\Program Files\\nodejs`);

    // An agent-configured `Path` is found the same way and still wins over the daemon's.
    const configured = await prepareCliTransport(makeCtx(tmp, {
      runtimeConfig: { version: 1, runtime: "claude", provider: { kind: "default" }, model: { kind: "default" }, mode: { kind: "default" }, envVars: { Path: "D:\\tools" } },
    }), {}, "win32");
    assert.deepEqual(Object.keys(configured.spawnEnv).filter((key) => key.toLowerCase() === "path"), ["PATH"]);
    assert.equal(configured.spawnEnv.PATH, `${configured.slockDir}${path.delimiter}D:\\tools`);
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    if (originalWinPath === undefined) delete process.env.Path; else process.env.Path = originalWinPath;
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
    assert.doesNotMatch(cmdBody, /%no_proxy%/, "Windows aliases NO_PROXY and no_proxy, so the wrapper must not read the same value twice");
    assert.match(cmdBody, /if defined SLOCK_EXISTING_NO_PROXY \(set "NO_PROXY=%SLOCK_LOOPBACK_NO_PROXY%,%SLOCK_EXISTING_NO_PROXY%"\) else set "NO_PROXY=%SLOCK_LOOPBACK_NO_PROXY%"/);
    assert.match(cmdBody, /set "no_proxy=%NO_PROXY%"/);
    assert.match(cmdBody, /\/fake\/cli\/index\.js/);
    assert.match(cmdBody, /%\*/);
    assert.match(cmdBody, /\r\n/, "should use CRLF line endings");

    const psBody = readFileSync(psPath, "utf8");
    assert.match(psBody, /\$OutputEncoding = \$utf8NoBom/);
    assert.match(psBody, /\[Console\]::OutputEncoding = \$utf8NoBom/);
    assert.match(psBody, /\$loopbackNoProxy = '127\.0\.0\.1,localhost'/);
    assert.match(psBody, /\$existingNoProxy = if \(\$env:NO_PROXY\) \{ \$env:NO_PROXY -split ',' \} else \{ @\(\) \}/);
    assert.match(psBody, /\$seenNoProxy = \[System\.Collections\.Generic\.HashSet\[string\]\]::new\(\[System\.StringComparer\]::OrdinalIgnoreCase\)/);
    assert.match(psBody, /foreach \(\$entry in \(@\(\$loopbackNoProxy -split ','\) \+ @\(\$existingNoProxy\)\)\)/);
    assert.match(psBody, /\$env:NO_PROXY = \$mergedNoProxy -join ','/);
    assert.doesNotMatch(psBody, /\$env:no_proxy/, "PowerShell must not read or write a second spelling of the same Windows environment variable");
    assert.match(psBody, /\$raftSavedEnv\[\$raftEnvName\] = \[Environment\]::GetEnvironmentVariable\(\$raftEnvName, 'Process'\)/);
    assert.match(psBody, /\} finally \{\r\n  foreach \(\$raftEnvName in \$raftSavedEnv\.Keys\) \{ \[Environment\]::SetEnvironmentVariable\(\$raftEnvName, \$raftSavedEnv\[\$raftEnvName\], 'Process'\) \}/);
    assert.match(psBody, /\[Console\]::OutputEncoding = \$raftSavedConsoleEncoding/);
    assert.match(psBody, /\$raftExitCode = \$LASTEXITCODE/);
    assert.match(psBody, /exit \$raftExitCode/);
    assert.match(psBody, /\$input \| & \$node \$cli @args/);
    assert.match(psBody, /\/fake\/cli\/index\.js/);

    assert.equal(result.wrapperPath, cmdPath);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareCliTransport: a cont wrapper beside raft answers a paused command through raft __continue", { skip: process.platform === "win32" }, async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  try {
    // A stale workspace copy goes with the other legacy transport files.
    mkdirSync(path.join(tmp, ".slock"), { recursive: true });
    writeFileSync(path.join(tmp, ".slock", "cont"), "stale transport");
    const cliPath = path.join(tmp, "fake-cli.cjs");
    const outPath = path.join(tmp, "call.json");
    writeFileSync(cliPath, `
const { readFileSync, writeFileSync } = require("node:fs");
writeFileSync(process.env.SLOCK_TEST_OUT, JSON.stringify({ argv: process.argv.slice(2), stdin: readFileSync(0, "utf8"), agent: process.env.SLOCK_AGENT_ID }), "utf8");
process.exit(10);
`, "utf8");
    const ctx = makeCtx(tmp);
    ctx.slockCliPath = cliPath;
    const result = await prepareCliTransport(ctx, {}, "linux");

    const contPath = path.join(result.slockDir, "cont");
    assert.ok(statSync(contPath).mode & 0o111, "cont should be executable");
    assert.ok(!existsSync(path.join(result.slockDir, "cont.cmd")), "cont.cmd only on win32");
    assert.ok(!existsSync(path.join(tmp, ".slock", "cont")), "stale workspace cont should be removed");
    const body = readFileSync(contPath, "utf8");
    assert.match(body, /^#!\/usr\/bin\/env bash\n/);
    assert.match(body, /exec "\$\(dirname "\$0"\)\/raft" __continue "\$@"\n$/);
    assert.doesNotMatch(body, /SLOCK_AGENT_ID=|TOKEN/, "cont carries no identity or credential of its own");

    const run = spawnSync(contPath, ["k7q2m3x9ab", "b"], {
      env: { ...process.env, SLOCK_TEST_OUT: outPath },
      input: "my new reply\n",
      encoding: "utf8",
    });
    assert.equal(run.status, 10, `exit status passes through: ${run.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(outPath, "utf8")), {
      argv: ["__continue", "k7q2m3x9ab", "b"],
      stdin: "my new reply\n",
      agent: "test-agent-id",
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareCliTransport: win32 writes cont, cont.cmd and cont.ps1 that run raft __continue beside them", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  try {
    const result = await prepareCliTransport(makeCtx(tmp), {}, "win32");
    assert.match(readFileSync(path.join(result.slockDir, "cont"), "utf8"), /exec "\$\(dirname "\$0"\)\/raft" __continue "\$@"/);

    const cmdBody = readFileSync(path.join(result.slockDir, "cont.cmd"), "utf8");
    assert.equal(cmdBody.split("\r\n")[0], "@echo off");
    assert.match(cmdBody, /^"%~dp0raft\.cmd" __continue %\*\r$/m);
    assert.doesNotMatch(cmdBody, /(?<!\r)\n/, "CRLF only");

    const psBody = readFileSync(path.join(result.slockDir, "cont.ps1"), "utf8");
    assert.match(psBody, /\$raft = Join-Path \$PSScriptRoot 'raft\.ps1'/);
    assert.match(psBody, /\$input \| & \$raft __continue @args/);
    assert.match(psBody, /& \$raft __continue @args/);
    assert.match(psBody, /exit \$LASTEXITCODE/);
    for (const wrapper of [cmdBody, psBody]) {
      assert.doesNotMatch(wrapper, /SLOCK_AGENT_ID|TOKEN/, "cont carries no identity or credential of its own");
    }
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

test("prepareCliTransport: win32 PowerShell wrapper restores NO_PROXY and preserves child exit codes", { skip: process.platform !== "win32" }, async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  try {
    const cliPath = path.join(tmp, "fake-cli.cjs");
    const childOutPath = path.join(tmp, "child-no-proxy.txt");
    const sessionOutPath = path.join(tmp, "session-no-proxy.txt");
    writeFileSync(cliPath, `
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.SLOCK_TEST_OUT, process.env.NO_PROXY + "\\n", "utf8");
process.exitCode = process.argv.includes("fail") ? 7 : 0;
`, "utf8");

    const ctx = makeCtx(tmp);
    ctx.slockCliPath = cliPath;
    const transport = await prepareCliTransport(ctx, {}, "win32");
    const psWrapper = path.join(transport.slockDir, "raft.ps1");
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const command = [
      "$env:NO_PROXY = 'corp.internal,LOCALHOST,corp.internal'",
      `& ${quote(psWrapper)} server info`,
      "$firstNoProxy = $env:NO_PROXY",
      "$firstExitCode = $LASTEXITCODE",
      `& ${quote(psWrapper)} server fail`,
      "$secondNoProxy = $env:NO_PROXY",
      "$secondExitCode = $LASTEXITCODE",
      "$utf8NoBom = [System.Text.UTF8Encoding]::new($false)",
      `[System.IO.File]::WriteAllText(${quote(sessionOutPath)}, ($firstNoProxy + [Environment]::NewLine + $firstExitCode + [Environment]::NewLine + $secondNoProxy + [Environment]::NewLine + $secondExitCode), $utf8NoBom)`,
    ].join("\r\n");

    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
      env: { ...process.env, SLOCK_TEST_OUT: childOutPath },
      encoding: "utf8",
      timeout: 10_000,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(readFileSync(childOutPath, "utf8").trim().split(/\r?\n/), [
      "127.0.0.1,localhost,corp.internal",
      "127.0.0.1,localhost,corp.internal",
    ]);
    assert.deepEqual(readFileSync(sessionOutPath, "utf8").split(/\r?\n/), [
      "corp.internal,LOCALHOST,corp.internal",
      "0",
      "corp.internal,LOCALHOST,corp.internal",
      "7",
    ]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("task #384: the PowerShell wrapper only touches env names it snapshots and restores", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  try {
    const ctx = makeCtx(tmp);
    const transport = await prepareCliTransport(ctx, {}, "win32");
    const psBody = readFileSync(path.join(transport.slockDir, "raft.ps1"), "utf8");
    const touched = new Set<string>();
    for (const match of psBody.matchAll(/\$env:([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) touched.add(match[1]!.toUpperCase());
    for (const match of psBody.matchAll(/Remove-Item ([^\r\n-]+)/g)) {
      for (const item of match[1]!.split(",")) {
        const name = /Env:([A-Za-z_][A-Za-z0-9_]*)/.exec(item.trim())?.[1];
        if (name) touched.add(name.toUpperCase());
      }
    }
    const saved = new Set(POWERSHELL_WRAPPER_ENV_NAMES.map((name) => name.toUpperCase()));
    const unsaved = [...touched].filter((name) => !saved.has(name));
    assert.deepEqual(unsaved, [], `env names written or removed by raft.ps1 but never restored: ${unsaved.join(", ")}`);
    assert.ok(touched.size > 0, "the scan found the wrapper's env writes");
    // Every change happens inside the try, so the finally covers it.
    const tryIndex = psBody.indexOf("\r\ntry {\r\n");
    assert.ok(tryIndex > 0);
    assert.doesNotMatch(psBody.slice(0, tryIndex), /\$env:[A-Za-z_]+\s*=|Remove-Item Env:|\[Console\]::OutputEncoding =/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("task #384: win32 raft.ps1 leaves the caller's session env exactly as it found it", { skip: process.platform !== "win32" }, async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  try {
    const cliPath = path.join(tmp, "fake-cli.cjs");
    const childOutPath = path.join(tmp, "child-env.txt");
    const sessionOutPath = path.join(tmp, "session-env.txt");
    writeFileSync(cliPath, `
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.SLOCK_TEST_OUT, [process.env.LANG, process.env.RAFT_PROFILE ?? "<unset>", process.env.SLOCK_AGENT_ID ?? "<unset>"].join("|") + "\\n", "utf8");
process.exitCode = 3;
`, "utf8");
    const ctx = makeCtx(tmp);
    ctx.slockCliPath = cliPath;
    const transport = await prepareCliTransport(ctx, {}, "win32");
    const psWrapper = path.join(transport.slockDir, "raft.ps1");
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const snapshot = "(@($env:LANG, $env:RAFT_PROFILE, $(if (Test-Path Env:SLOCK_AGENT_ID) { 'set' } else { '<unset>' }), [Console]::OutputEncoding.WebName) -join '|')";
    const command = [
      "$env:LANG = 'en_US.UTF-8'",
      "$env:RAFT_PROFILE = 'mine'",
      "Remove-Item Env:SLOCK_AGENT_ID -ErrorAction SilentlyContinue",
      `$before = ${snapshot}`,
      `& ${quote(psWrapper)} server info`,
      "$exitCode = $LASTEXITCODE",
      `$after = ${snapshot}`,
      "$utf8NoBom = [System.Text.UTF8Encoding]::new($false)",
      `[System.IO.File]::WriteAllText(${quote(sessionOutPath)}, ($before + [Environment]::NewLine + $after + [Environment]::NewLine + $exitCode), $utf8NoBom)`,
    ].join("\r\n");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
      env: { ...process.env, SLOCK_TEST_OUT: childOutPath },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const [before, after, exitCode] = readFileSync(sessionOutPath, "utf8").split(/\r?\n/);
    assert.equal(after, before, "LANG, RAFT_PROFILE, the unset SLOCK_AGENT_ID and the console encoding all come back unchanged");
    assert.equal(exitCode, "3");
    // The child still ran with the wrapper's own values.
    const [childLine] = readFileSync(childOutPath, "utf8").trim().split(/\r?\n/);
    const [childLang, childProfile, childAgentId] = childLine!.split("|");
    assert.equal(childLang, "C.UTF-8");
    assert.equal(childProfile, "<unset>");
    assert.notEqual(childAgentId, "<unset>");
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

test("prepareCliTransport: env is platform-independent", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  const slockHome = path.join(tmp, "home");
  const oldSlockHome = process.env.SLOCK_HOME;
  try {
    process.env.SLOCK_HOME = slockHome;
    const ctx = makeCtx(tmp);
    const result = await prepareCliTransport(ctx, {}, "win32");

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
    assert.ok(!existsSync(path.join(result.slockDir, "agent-token")), "no daemon-owned legacy token file");
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
    mkdirSync(spawnCliTransportDir(ctx), { recursive: true });
    writeFileSync(path.join(spawnCliTransportDir(ctx), "agent-token"), "stale-machine-token", { mode: 0o600 });
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
    assert.ok(!existsSync(path.join(result.slockDir, "agent-token")), "stale legacy machine token file should be removed on proxy path");
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

    // The proxy names the agent's runtime and versions to the server (task #15 in #proj-analytics).
    let upstreamHeaders: Headers | null = null;
    setDaemonFetchImplForTests((async (_input: unknown, init?: RequestInit) => {
      upstreamHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as never);
    try {
      const serverResponse = await fetch(`${result.agentCredentialProxyUrl}/internal/agent-api/server`, {
        headers: { Authorization: `Bearer ${proxyToken}` },
      });
      assert.equal(serverResponse.status, 200);
    } finally {
      setDaemonFetchImplForTests(undefined);
    }
    const forwarded = upstreamHeaders as Headers | null;
    assert.equal(forwarded?.get("x-raft-runtime"), "claude");
    assert.equal(forwarded?.get("x-raft-computer-version"), "1.0.16");
    assert.equal(forwarded?.get("x-raft-daemon-version"), "1.0.15");
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

test("prepareCliTransport: a launch without a runner credential gets no Raft credential, never the Computer key", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  const slockHome = path.join(tmp, "home");
  const workspace = path.join(tmp, "workspace");
  const computerKey = "sk_computer_must_not_reach_runtime";
  try {
    // The production config shape (`authToken: ""`) with no runner credential.
    const ctx: SpawnContext = {
      ...makeCtx(workspace, { authToken: "" }),
      daemonApiKey: computerKey,
      slockHome,
    };
    // Older daemons left the Computer key in the launch directory and the workspace.
    const slockDir = spawnCliTransportDir(ctx);
    mkdirSync(slockDir, { recursive: true });
    writeFileSync(path.join(slockDir, "agent-token"), computerKey, { mode: 0o600 });
    mkdirSync(path.join(workspace, ".slock"), { recursive: true });
    writeFileSync(path.join(workspace, ".slock", "agent-token"), computerKey, { mode: 0o600 });

    // win32 writes every wrapper flavor (POSIX, .cmd, .ps1).
    const result = await prepareCliTransport(ctx, {}, "win32");

    assert.equal(result.agentCredentialProxyUrl, null);
    assert.ok(!existsSync(path.join(slockDir, "agent-token")), "stale launch token must be removed");
    for (const name of ["SLOCK_AGENT_TOKEN_FILE", "SLOCK_AGENT_TOKEN", "SLOCK_AGENT_PROXY_URL", "SLOCK_AGENT_PROXY_TOKEN_FILE"]) {
      assert.equal(result.spawnEnv[name], undefined, `${name} must not be in the runtime env`);
    }
    assert.ok(!Object.values(result.spawnEnv).some((value) => value?.includes(computerKey)), "runtime env must not carry the Computer key");
    for (const wrapper of ["slock", "raft", "slock.cmd", "raft.cmd", "slock.ps1", "raft.ps1"]) {
      const body = readFileSync(path.join(slockDir, wrapper), "utf8");
      assert.match(body, /SLOCK_AGENT_ID/, `${wrapper} keeps the agent identity`);
      assert.doesNotMatch(body, /(SLOCK_AGENT_TOKEN_FILE|SLOCK_AGENT_PROXY_URL|SLOCK_AGENT_PROXY_TOKEN_FILE)=/, `${wrapper} must set no credential`);
    }
    const filesHoldingKey: string[] = [];
    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(entryPath);
        else if (readFileSync(entryPath, "utf8").includes(computerKey)) filesHoldingKey.push(entryPath);
      }
    };
    visit(tmp);
    assert.deepEqual(filesHoldingKey, [], "the Computer key must not be on disk under the transport home or workspace");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("removeStaleAgentTokenFiles never follows a symlinked directory and leaves non-files alone", { skip: process.platform === "win32" }, async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-stale-token-"));
  try {
    const slockHome = path.join(tmp, "home");
    const agentsRoot = path.join(tmp, "agents");
    const outside = path.join(tmp, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "agent-token"), "outside", { mode: 0o600 });
    // A launch directory, an agent directory and a workspace `.slock` that are links to `outside`.
    mkdirSync(path.join(slockHome, "cli-transport", "agent-a"), { recursive: true });
    symlinkSync(outside, path.join(slockHome, "cli-transport", "agent-a", "launch-link"));
    symlinkSync(outside, path.join(slockHome, "cli-transport", "agent-link"));
    mkdirSync(path.join(agentsRoot, "agent-a"), { recursive: true });
    symlinkSync(outside, path.join(agentsRoot, "agent-a", ".slock"));
    // A directory named agent-token, and one plain stale file.
    mkdirSync(path.join(slockHome, "cli-transport", "agent-a", "launch-dir", "agent-token"), { recursive: true });
    mkdirSync(path.join(slockHome, "cli-transport", "agent-a", "launch-file"), { recursive: true });
    writeFileSync(path.join(slockHome, "cli-transport", "agent-a", "launch-file", "agent-token"), "stale", { mode: 0o600 });

    assert.deepEqual(removeStaleAgentTokenFiles(slockHome, agentsRoot), { removed: 1, skipped: 1 });
    assert.equal(readFileSync(path.join(outside, "agent-token"), "utf8"), "outside");
    assert.ok(statSync(path.join(slockHome, "cli-transport", "agent-a", "launch-dir", "agent-token")).isDirectory());
    assert.ok(!existsSync(path.join(slockHome, "cli-transport", "agent-a", "launch-file", "agent-token")));
    // Missing roots are not an error.
    assert.deepEqual(removeStaleAgentTokenFiles(path.join(tmp, "absent"), path.join(tmp, "absent-agents")), { removed: 0, skipped: 0 });
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

test("prepareCliTransport: tells the CLI the Server's first-party apps as RAFT_ENABLED_APPS, unset when the Server didn't send them", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  try {
    const on = await prepareCliTransport(makeCtx(tmp, { enabledApps: ["artifacts"] }), {}, "linux");
    assert.equal(on.spawnEnv.RAFT_ENABLED_APPS, "artifacts");
    const none = await prepareCliTransport(makeCtx(tmp, { enabledApps: [] }), {}, "linux");
    assert.equal(none.spawnEnv.RAFT_ENABLED_APPS, "", "none on: empty, not unset");
    const older = await prepareCliTransport(makeCtx(tmp, {}), {}, "linux");
    assert.equal("RAFT_ENABLED_APPS" in older.spawnEnv, false, "an older Server: unknown");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareCliTransport: exposes the agent's runtime id as RAFT_CURRENT_RUNTIME, defaulting to claude", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  try {
    const codex = await prepareCliTransport(makeCtx(tmp, { runtime: "codex" }), {}, "linux");
    assert.equal(codex.spawnEnv[RAFT_CURRENT_RUNTIME_ENV], "codex");
    assert.equal(RAFT_CURRENT_RUNTIME_ENV, "RAFT_CURRENT_RUNTIME");

    const unset = await prepareCliTransport(makeCtx(tmp, { runtime: "" }), {}, "linux");
    assert.equal(unset.spawnEnv.RAFT_CURRENT_RUNTIME, "claude");

    // An agent-configured env var of the same name does not replace it.
    const configured = await prepareCliTransport(makeCtx(tmp, {
      runtime: "claude",
      runtimeConfig: {
        version: 1,
        runtime: "claude",
        provider: { kind: "default" },
        model: { kind: "default" },
        mode: { kind: "default" },
        envVars: { RAFT_CURRENT_RUNTIME: "spoofed", TEAM_FLAG: "enabled" },
      },
    }), {}, "linux");
    assert.equal(configured.spawnEnv.TEAM_FLAG, "enabled");
    assert.equal(configured.spawnEnv.RAFT_CURRENT_RUNTIME, "claude");
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
    assert.deepEqual(result, { scanned: 2, rewritten: 2, skipped: 0 });

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

test("regenerateExistingOpencliWrappers: a wrapper or .slock the agent turned into a link is never written through", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "slock-opencli-link-"));
  try {
    const bin = "/opt/opencli/dist/src/main.js";
    const outside = path.join(root, "outside");
    mkdirSync(outside, { recursive: true });
    const victim = path.join(outside, "victim.sh");
    writeFileSync(victim, "untouched");
    // agent-a: its wrapper is a link to a file outside the workspace.
    mkdirSync(path.join(root, "agent-a", ".slock"), { recursive: true });
    symlinkSync(victim, path.join(root, "agent-a", ".slock", "opencli"));
    // agent-b: its .slock is a link to a directory outside, holding a plain wrapper.
    writeFileSync(path.join(outside, "opencli"), "#!/usr/bin/env bash\nexit 0\n");
    mkdirSync(path.join(root, "agent-b"), { recursive: true });
    symlinkSync(outside, path.join(root, "agent-b", ".slock"));
    // agent-c: a plain wrapper, but on Windows its .cmd sibling is a link.
    mkdirSync(path.join(root, "agent-c", ".slock"), { recursive: true });
    writeFileSync(path.join(root, "agent-c", ".slock", "opencli"), "#!/usr/bin/env bash\nexit 0\n");
    symlinkSync(victim, path.join(root, "agent-c", ".slock", "opencli.cmd"));

    assert.deepEqual(regenerateExistingOpencliWrappers(root, "linux", bin), { scanned: 3, rewritten: 1, skipped: 2 });
    assert.equal(readFileSync(victim, "utf8"), "untouched");
    assert.equal(readFileSync(path.join(outside, "opencli"), "utf8"), "#!/usr/bin/env bash\nexit 0\n");
    assert.match(readFileSync(path.join(root, "agent-c", ".slock", "opencli"), "utf8"), /OPENCLI_BIN=/);

    assert.deepEqual(regenerateExistingOpencliWrappers(root, "win32", bin), { scanned: 3, rewritten: 0, skipped: 3 });
    assert.equal(readFileSync(victim, "utf8"), "untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeOpencliWrapper replaces a link at the wrapper path instead of writing through it", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "slock-opencli-replace-"));
  try {
    const victim = path.join(root, "victim.sh");
    writeFileSync(victim, "untouched");
    const sd = path.join(root, "transport");
    mkdirSync(sd, { recursive: true });
    symlinkSync(victim, path.join(sd, "opencli"));
    writeOpencliWrapper(sd, "/opt/opencli/dist/src/main.js", "linux");
    assert.equal(readFileSync(victim, "utf8"), "untouched");
    assert.match(readFileSync(path.join(sd, "opencli"), "utf8"), /OPENCLI_BIN=/);
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
    assert.deepEqual(result, { scanned: 0, rewritten: 0, skipped: 0 });
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
    const cmdBody = readFileSync(path.join(sdWin, "opencli.cmd"), "utf8");
    assert.match(cmdBody, /set "ELECTRON_RUN_AS_NODE=1"/);
    assert.match(cmdBody, /" "--import" "data:text\/javascript,process\.defaultApp=true" "%OPENCLI_BIN%" %\*/);
    assert.doesNotMatch(readFileSync(path.join(sdPlain, "opencli"), "utf8"), /--import/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// task #159: under Electron's Node mode `process.versions.electron` is set and
// `process.defaultApp` is not, so opencli's commander parse() took the bin path
// as the command: `opencli list` -> "unknown command '<bin>'". This runs the
// real opencli through the wrapper the daemon writes, in a Node child made to
// look like Electron's Node mode (the packaged-app run is in the desktop smoke).
test("writeOpencliWrapper: Electron wrapper runs a real opencli subcommand (task #159)", { skip: process.platform === "win32" }, () => {
  const bin = resolveOpencliBinPath();
  assert.ok(bin, "@jackwener/opencli must resolve from the daemon");
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-opencli-electron-"));
  try {
    const fakeElectron = path.join(tmp, "fake-electron-node-mode.mjs");
    writeFileSync(fakeElectron, "Object.defineProperty(process.versions, 'electron', { value: '44.0.0' });\n");
    const run = (execIsElectron: boolean) => {
      const slockDir = path.join(tmp, execIsElectron ? "electron" : "plain");
      mkdirSync(slockDir, { recursive: true });
      writeOpencliWrapper(slockDir, bin, "linux", execIsElectron);
      return spawnSync("bash", [path.join(slockDir, "opencli"), "list", "-f", "json"], {
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, HOME: tmp, CI: "1", NODE_OPTIONS: `--import="${fakeElectron}"` },
      });
    };
    // Control: a wrapper without the launch options hits the bug in this child.
    // opencli 2.x reports the failure as structured JSON on stdout (older 1.x
    // printed it to stderr), so match the combined output.
    const broken = run(false);
    assert.notEqual(broken.status, 0);
    assert.match(broken.stdout + broken.stderr, /[Uu]nknown command/);
    const fixed = run(true);
    assert.equal(fixed.status, 0, fixed.stderr);
    // opencli 2.x wraps results in an { ok, data } envelope (1.x printed the
    // bare command array).
    const listing = JSON.parse(fixed.stdout) as { ok?: boolean; data?: { commands?: unknown[] } };
    const commands = listing.data?.commands;
    assert.ok(listing.ok === true && Array.isArray(commands) && commands.length > 0, "opencli list returns its command table");
    assert.match(readFileSync(path.join(tmp, "electron", "opencli"), "utf8"), /'--import' 'data:text\/javascript,process\.defaultApp=true'/);
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
    const ctx = makeCtx(tmp, { agentCredentialKey: "sk_agent_guard_order" });
    const result = await prepareCliTransport(ctx, {}, "linux");
    const body = readFileSync(path.join(result.slockDir, "slock"), "utf8");
    assert.match(body, /# slock-daemon-generated/);
    assert.match(body, /SLOCK_OWN_LAUNCH_DIR=/);
    assert.match(body, /SLOCK_AGENT_LAUNCH_DIR/);
    // Guard must appear before the credential line so stale wrappers forward
    // before any stale credential env is set.
    const guardIdx = body.indexOf("SLOCK_OWN_LAUNCH_DIR=");
    const credentialIdx = body.indexOf("SLOCK_AGENT_PROXY_TOKEN_FILE=");
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
    assert.match(body, /!SLOCK_FORWARD_CREATED_AT:~13!"==""/, "cmd marker validation must require no 14th character");
    assert.match(body, /!SLOCK_OWN_CREATED_AT:~13!"==""/, "cmd own-marker validation must require no 14th character");
    assert.match(body, /if defined SLOCK_FORWARD_TARGET goto :slock_forward/);
    assert.match(body, /:slock_forward/);
    assert.match(body, /goto #_undefined_# 2>NUL \|\| title %COMSPEC% & "%%~fF" %\*/);
    assert.ok(
      body.indexOf(":slock_current") < body.indexOf('"%SLOCK_CLI%" %*'),
      "cmd current label must precede the wrapper body so the node invocation remains the last normal-path command",
    );
    assert.match(body.trimEnd().split(/\r?\n/).at(-1) ?? "", /"%SLOCK_CLI%" %\*$/);
    assert.doesNotMatch(body, /"!SLOCK_FORWARD_WRAPPER!" %\*/);
    assert.doesNotMatch(body, /call "!SLOCK_FORWARD_WRAPPER!" %\*/);
    assert.doesNotMatch(body, /exit \/b/i);
    assert.match(body, /launch-forwarding skipped reason=!SLOCK_LAUNCH_FORWARD_SKIP_REASON!/);
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

/** Make a generated wrapper's credential file read `marker`, so the fake CLI names the launch it ran under. */
function markLaunchCredential(wrapperPath: string, marker: string): void {
  const tokenFile = readFileSync(wrapperPath, "utf8").match(/SLOCK_AGENT_PROXY_TOKEN_FILE='([^']+)'/)?.[1];
  assert.ok(tokenFile, "generated wrapper must name its proxy token file");
  writeFileSync(tokenFile, marker, { mode: 0o600 });
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
  w1Dir: string;
  w1Wrapper: string;
  w2Dir: string;
  w2Wrapper: string;
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
  const ctx = makeCtx(tmp, { agentCredentialKey: "sk_agent_w2" });
  ctx.agentId = agentId;
  ctx.launchId = "w2";
  ctx.slockCliPath = fakeCli;
  const transport = await prepareCliTransport(ctx, {}, "linux");
  markLaunchCredential(path.join(transport.slockDir, "raft"), "W2");

  return {
    agentRoot,
    w1Dir,
    w1Wrapper: path.join(w1Dir, "raft"),
    w2Dir: transport.slockDir,
    w2Wrapper: path.join(transport.slockDir, "raft"),
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

test("launch forwarding guard: stale older selector on current wrapper falls through to current launch", { skip: process.platform === "win32" }, async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-stale-selector-"));
  const oldSlockHome = process.env.SLOCK_HOME;
  try {
    const { w2Wrapper } = await setupForwardedLaunchFixture(tmp);

    const result = runWrapper(w2Wrapper, { SLOCK_AGENT_LAUNCH_DIR: "w1" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout.trim(), "W2", "current wrapper must not forward backward to a retained old launch");
  } finally {
    if (oldSlockHome === undefined) delete process.env.SLOCK_HOME;
    else process.env.SLOCK_HOME = oldSlockHome;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("launch forwarding guard: missing selected marker fails closed with a stale-launch diagnostic", { skip: process.platform === "win32" }, async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-marker-missing-"));
  const oldSlockHome = process.env.SLOCK_HOME;
  try {
    const { w1Dir, w2Wrapper } = await setupForwardedLaunchFixture(tmp);
    rmSync(path.join(w1Dir, LAUNCH_CREATED_AT_FILENAME), { force: true });
    assert.equal(existsSync(path.join(w1Dir, LAUNCH_CREATED_AT_FILENAME)), false, "selected launch marker should be absent");

    const result = runWrapper(w2Wrapper, { SLOCK_AGENT_LAUNCH_DIR: "w1" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout.trim(), "W2", "current wrapper must not forward to a selected launch with no marker");
    assert.match(result.stderr, /\[cliTransport\] launch-forwarding skipped reason=selected_marker_missing/);
    assert.doesNotMatch(result.stderr, /W1|W2|test-token-123/, "diagnostic must not expose token-like test payloads");
  } finally {
    if (oldSlockHome === undefined) delete process.env.SLOCK_HOME;
    else process.env.SLOCK_HOME = oldSlockHome;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("launch forwarding guard: stale missing selector on current wrapper falls through to current launch", { skip: process.platform === "win32" }, async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-stale-selector-cleaned-"));
  const oldSlockHome = process.env.SLOCK_HOME;
  try {
    const { w1Dir, w2Wrapper } = await setupForwardedLaunchFixture(tmp);
    rmSync(w1Dir, { recursive: true, force: true });

    const result = runWrapper(w2Wrapper, { SLOCK_AGENT_LAUNCH_DIR: "w1" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout.trim(), "W2", "current wrapper must fall through when the stale selected launch was cleaned");
  } finally {
    if (oldSlockHome === undefined) delete process.env.SLOCK_HOME;
    else process.env.SLOCK_HOME = oldSlockHome;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("launch forwarding guard: marker ordering only forwards toward newer launches", { skip: process.platform === "win32" }, async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-marker-order-"));
  const oldSlockHome = process.env.SLOCK_HOME;
  try {
    const { w1Dir, w1Wrapper, w2Dir, w2Wrapper } = await setupForwardedLaunchFixture(tmp);
    writeFileSync(path.join(w1Dir, LAUNCH_CREATED_AT_FILENAME), "0000000000001");
    writeFileSync(path.join(w2Dir, LAUNCH_CREATED_AT_FILENAME), "0000000000002");

    const forward = runWrapper(w1Wrapper, { SLOCK_AGENT_LAUNCH_DIR: "w2" });
    assert.equal(forward.status, 0, forward.stderr || forward.stdout);
    assert.equal(forward.stdout.trim(), "W2", "old wrapper should still forward to newer current launch");

    const stale = runWrapper(w2Wrapper, { SLOCK_AGENT_LAUNCH_DIR: "w1" });
    assert.equal(stale.status, 0, stale.stderr || stale.stdout);
    assert.equal(stale.stdout.trim(), "W2", "newer wrapper must ignore older retained launch selector");
    assert.match(stale.stderr, /\[cliTransport\] launch-forwarding skipped reason=selected_not_newer/);
  } finally {
    if (oldSlockHome === undefined) delete process.env.SLOCK_HOME;
    else process.env.SLOCK_HOME = oldSlockHome;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("launch forwarding guard: damaged selected marker fails closed to own launch", { skip: process.platform === "win32" }, async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-marker-damaged-"));
  const oldSlockHome = process.env.SLOCK_HOME;
  try {
    const { w1Dir, w2Dir, w2Wrapper } = await setupForwardedLaunchFixture(tmp);
    writeFileSync(path.join(w1Dir, LAUNCH_CREATED_AT_FILENAME), "not-a-launch-time");
    writeFileSync(path.join(w2Dir, LAUNCH_CREATED_AT_FILENAME), "0000000000002");

    const result = runWrapper(w2Wrapper, { SLOCK_AGENT_LAUNCH_DIR: "w1" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout.trim(), "W2", "current wrapper must not forward to a launch with a damaged marker");
    assert.match(result.stderr, /\[cliTransport\] launch-forwarding skipped reason=selected_marker_invalid/);
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
    const ctxW2 = makeCtx(tmp, { agentCredentialKey: "sk_agent_w2" });
    ctxW2.agentId = agentId;
    ctxW2.launchId = "w2";
    ctxW2.slockCliPath = fakeCli;
    const w2Transport = await prepareCliTransport(ctxW2, {}, "linux");
    markLaunchCredential(path.join(w2Transport.slockDir, "raft"), "W2");

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
    const w1Cli = makeArgvEchoCli(w1Out, 17);
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
    assert.equal(
      result.status,
      42,
      `W2 exit code must propagate to outer cmd.exe; w2Ran=${w2Ran}, w1Ran=${w1Ran}; stdout=${result.stdout}; stderr=${result.stderr}`,
    );
    assert.doesNotMatch(result.stderr, /launch-forwarding skipped reason=/, "successful forwarding must not emit a skipped diagnostic");
    const forwardedArgv = JSON.parse(readFileSync(w2Out, "utf8")) as string[];
    assert.deepEqual(forwardedArgv, ["message", "check"], "W1.cmd must forward argv unchanged to W2");

    // A 14-digit numeric marker must NOT be accepted as valid. POSIX/PowerShell
    // use exact /^\d{13}$/; this executable cmd.exe branch pins the batch
    // substring check to the same exact-length contract.
    writeFileSync(path.join(agentRoot, "w2", LAUNCH_CREATED_AT_FILENAME), "00000000000022");
    safeRemove(w1Out);
    safeRemove(w2Out);
    const overlongMarker = spawnSync("cmd.exe", ["/c", w1Cmd, "message", "check"], {
      env: { ...process.env, SLOCK_AGENT_LAUNCH_DIR: "w2" },
      encoding: "utf8",
    }) as { status: number | null; stdout: string; stderr: string };
    assert.equal(existsSync(w1Out), true, "overlong marker must fail-closed to W1 (w1Out exists)");
    assert.equal(existsSync(w2Out), false, "overlong marker must not execute W2 (w2Out absent)");
    assert.equal(overlongMarker.status, 17, overlongMarker.stderr || overlongMarker.stdout);
    assert.match(overlongMarker.stderr, /launch-forwarding skipped reason=selected_marker_invalid/);

    // Traversal selector must be rejected and execute W1 instead.
    safeRemove(w1Out);
    safeRemove(w2Out);
    const traversal = spawnSync("cmd.exe", ["/c", w1Cmd, "message", "check"], {
      env: { ...process.env, SLOCK_AGENT_LAUNCH_DIR: "agent-a/../agent-b/wb" },
      encoding: "utf8",
    }) as { status: number | null; stdout: string; stderr: string };
    assert.equal(existsSync(w1Out), true, "traversal selector must execute W1 (w1Out exists)");
    assert.equal(existsSync(w2Out), false, "traversal selector must not execute W2 (w2Out absent)");
    assert.equal(traversal.status, 17, traversal.stderr || traversal.stdout);
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
      assert.equal(linkResult.status, 17, linkResult.stderr || linkResult.stdout);
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

test("a wrapper written while running from K's experiment slot still runs after promotion renames it to stable", { skip: process.platform === "win32" }, async () => {
  // K starts an upgrade from slots/experiment and promotes it by renaming the
  // directory to slots/stable under the running process (IT-armbian
  // 2026-09-27: every new session's `raft` exec'd the vanished experiment
  // path, exit 127). Run the real wrapper across the rename.
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-k-promote-"));
  const originalExecPath = process.execPath;
  try {
    const experimentDir = path.join(tmp, "k", "slots", "experiment");
    mkdirSync(experimentDir, { recursive: true });
    const artifact = path.join(experimentDir, "artifact.bin");
    writeFileSync(artifact, "#!/bin/sh\necho \"HOST:$0 ARGS:$*\"\n", { mode: 0o755 });
    process.execPath = artifact;
    // The fake artifact is not the running binary, so /proc/self/exe (node)
    // must not be consulted here.
    setProcSelfExeReaderForTests(() => null);
    const ctx = makeCtx(path.join(tmp, "work"));
    ctx.slockCliPath = "__cli";
    const result = await prepareCliTransport(ctx, {}, "linux", false, () => true);
    const wrapper = path.join(result.slockDir, "raft");

    const before = runWrapper(wrapper, {});
    assert.equal(before.status, 0, before.stderr);
    assert.match(before.stdout, new RegExp(`HOST:${artifact} ARGS:__cli message check`));

    renameSync(experimentDir, path.join(tmp, "k", "slots", "stable"));
    const after = runWrapper(wrapper, {});
    assert.equal(after.status, 0, `wrapper must follow the promoted slot: ${after.stderr}`);
    assert.match(after.stdout, new RegExp(`HOST:${path.join(tmp, "k", "slots", "stable", "artifact.bin")} ARGS:__cli message check`));
  } finally {
    setProcSelfExeReaderForTests(null);
    process.execPath = originalExecPath;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("task #28: an agent spawned while a Pi session is being created does not inherit that Pi agent's env", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  const oldSlockHome = process.env.SLOCK_HOME;
  const oldPath = process.env.PATH;
  try {
    process.env.SLOCK_HOME = path.join(tmp, "home");
    let spawnEnv: NodeJS.ProcessEnv | undefined;
    // The Pi session-create patch holds process.env across awaits; another
    // agent's transport is prepared inside that window.
    await withProcessEnvPatch({ TASK28_PI_AGENT_SECRET: "pi-agent-only", PATH: "/pi-agent/bin" }, async () => {
      assert.equal(process.env.TASK28_PI_AGENT_SECRET, "pi-agent-only");
      spawnEnv = (await prepareCliTransport(makeCtx(tmp), {}, "linux")).spawnEnv;
    });
    assert.equal(spawnEnv!.TASK28_PI_AGENT_SECRET, undefined);
    assert.ok(spawnEnv!.PATH?.endsWith(`${path.delimiter}${oldPath ?? ""}`), spawnEnv!.PATH);
    assert.ok(!spawnEnv!.PATH?.includes("/pi-agent/bin"));
    // And the patch is undone afterwards, as before.
    assert.equal(process.env.TASK28_PI_AGENT_SECRET, undefined);
    assert.equal(process.env.PATH, oldPath);
  } finally {
    if (oldSlockHome === undefined) delete process.env.SLOCK_HOME;
    else process.env.SLOCK_HOME = oldSlockHome;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareCliTransport strips the legacy chat-bridge entry bound to this agent and keeps user MCP servers (task #261)", { skip: process.platform === "win32" }, async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-cli-test-"));
  try {
    const ctx = makeCtx(tmp); // agentId "test-agent-id"
    const bridge = {
      command: "node",
      args: ["/opt/old/chat-bridge.js", "--agent-id", ctx.agentId, "--server-url", "u", "--auth-token", "sk_machine_FIXTURE", "--runtime", "claude", "--runtime-actions-only"],
    };
    const rootFile = path.join(tmp, ".slock-claude-mcp.json");
    writeFileSync(rootFile, JSON.stringify({ mcpServers: { chat: bridge } }));
    mkdirSync(path.join(tmp, ".slock"), { recursive: true });
    const mixedFile = path.join(tmp, ".slock", "claude-mcp-config.json");
    writeFileSync(mixedFile, JSON.stringify({ mcpServers: { fetch: { command: "uvx" }, chat: bridge } }));
    const foreign = path.join(tmp, ".gemini");
    mkdirSync(foreign, { recursive: true });
    const foreignFile = path.join(foreign, "settings.json");
    writeFileSync(foreignFile, JSON.stringify({ mcpServers: { chat: { ...bridge, args: bridge.args.map((a) => (a === ctx.agentId ? "someone-else" : a)) } } }));

    await prepareCliTransport(ctx, {}, "linux");

    assert.equal(existsSync(rootFile), false, "file that was entirely the bridge is unlinked");
    assert.deepEqual(JSON.parse(readFileSync(mixedFile, "utf8")), { mcpServers: { fetch: { command: "uvx" } } });
    assert.equal(readFileSync(mixedFile, "utf8").includes("sk_machine_FIXTURE"), false);
    assert.equal(readFileSync(foreignFile, "utf8").includes("sk_machine_FIXTURE"), true, "entry bound to another agent is untouched");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
