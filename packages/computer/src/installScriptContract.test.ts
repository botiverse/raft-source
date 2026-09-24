import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { runNamedCase } from "./test/runNamedCase.js";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { bootstrapStable, slotArtifactPath } from "@botiverse/k-carrier";
import { buildOsSupervisorSpec } from "./osSupervisor.js";
import { COMPUTER_VERSION } from "./version.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const installScriptPath = resolve(repoRoot, "packages/computer/scripts/install.sh");
const windowsInstallScriptPath = resolve(repoRoot, "packages/computer/scripts/install.ps1");
const execFileAsync = promisify(execFile);

async function writeNodeSupervisorPreload(root: string): Promise<string> {
  const preload = resolve(root, "supervisor-preload.cjs");
  await writeFile(
    preload,
    `const fs = require("node:fs");
if (process.argv[1] && process.argv[1].endsWith("__supervisor")) {
  if (process.env.RAFT_TEST_SUPERVISOR_LOG) fs.appendFileSync(process.env.RAFT_TEST_SUPERVISOR_LOG, process.execPath + "\\n");
  const mode = process.env.RAFT_TEST_SUPERVISOR_MODE || "success";
  if (mode === "incomplete") process.stderr.write("[computer] note: cleanup incomplete; Computer remains usable\\n");
  if (mode === "stop-fail") process.stderr.write("STOP_SIGNAL_FAILED\\n");
  if (mode === "start-fail") process.stderr.write("START_DAEMON_TIMEOUT\\n");
  process.exit(mode === "success" || mode === "incomplete" ? 0 : 42);
}
`,
  );
  return preload;
}

function nodeOptionsWithPreload(preload: string): string {
  return [process.env.NODE_OPTIONS, `--require=${JSON.stringify(preload)}`]
    .filter(Boolean)
    .join(" ");
}

async function writeInstallerFixtureBinary(path: string, version: string): Promise<Buffer> {
  const bytes = Buffer.from(`#!/bin/sh
case "$1" in
  --version) printf '%s\\n' ${JSON.stringify(version)}; exit 0 ;;
  __installer-converge)
    # Model older candidates: the obsolete option rejects rolled-back state.
    for arg in "$@"; do
      if [ "$arg" = "--force-recover" ]; then echo 'K_INSTALLER_RECOVERY_UNSUPPORTED' >&2; exit 41; fi
    done
    if [ -n "$RAFT_TEST_K_ARGS" ]; then printf '%s\\n' "$@" > "$RAFT_TEST_K_ARGS"; fi
    if [ -n "$RAFT_TEST_K_LOG" ]; then printf '%s %s %s\\n' "$2" "$3" "\${RAFT_COMPUTER_DISPATCHER_PATH:-<unset>}" >> "$RAFT_TEST_K_LOG"; fi
    if [ "$RAFT_TEST_K_MODE" = "fail" ]; then echo 'fixture K refused before install-dir mutation' >&2; exit 42; fi
    printf 'converged\\n'; exit 0 ;;
  stop)
    if [ "$RAFT_TEST_K_MODE" = "stop-fail" ]; then echo 'fixture stop refused' >&2; exit 42; fi
    exit 0 ;;
  __supervisor) exit 0 ;;
esac
exit 0
`);
  await writeFile(path, bytes);
  await chmod(path, 0o755);
  return bytes;
}

async function writeWindowsVersionFixture(root: string): Promise<string> {
  const source = resolve(root, "version-fixture.cs");
  const output = resolve(root, "version-fixture.exe");
  const compiler = resolve(root, "compile-version-fixture.ps1");
  await writeFile(
    source,
    `using System;
public static class VersionFixture {
  public static int Main(string[] args) {
    if (args.Length > 0 && args[0] == "--version") {
      Console.WriteLine(Environment.GetEnvironmentVariable("RAFT_TEST_LOCAL_VERSION") ?? "1.0.0");
      return 0;
    }
    if (args.Length > 0 && args[0] == "__supervisor") return 0;
    return 0;
  }
}
`,
  );
  const quotePowerShell = (value: string): string =>
    `'${value.replaceAll("'", "''")}'`;
  await writeFile(
    compiler,
    `$ErrorActionPreference = 'Stop'
$source = Get-Content -LiteralPath ${quotePowerShell(source)} -Raw
Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly ${quotePowerShell(output)} -OutputType ConsoleApplication
`,
  );
  await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    compiler,
  ]);
  return output;
}

async function writeFileCommandShim(root: string, target: string): Promise<string> {
  const fakeBin = resolve(root, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  let description: string;
  switch (target) {
    case "darwin-arm64":
      description = "Mach-O 64-bit executable arm64";
      break;
    case "darwin-x64":
      description = "Mach-O 64-bit executable x86_64";
      break;
    case "linux-arm64":
      description = "ELF 64-bit LSB executable, aarch64";
      break;
    case "linux-x64":
      description = "ELF 64-bit LSB executable, x86-64";
      break;
    default:
      description = "fixture executable";
      break;
  }
  const shim = resolve(fakeBin, "file");
  await writeFile(shim, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(description)}\n`);
  await chmod(shim, 0o755);
  return fakeBin;
}

test("install.sh selects the native Apple Silicon carrier even from a translated shell", async () => {
  const script = readFileSync(installScriptPath, "utf8");
  const detectFn = script.match(/detect_target\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(detectFn);

  const run = async (os: string, machine: string, arm64Hardware: boolean): Promise<string> => {
    const harness = `set -eu
err() { printf '%s\\n' "$1" >&2; exit 1; }
uname() { if [ "$1" = "-s" ]; then printf '%s\\n' "$TEST_OS"; else printf '%s\\n' "$TEST_MACHINE"; fi; }
darwin_hardware_supports_arm64() { [ "$TEST_ARM64_HARDWARE" = "1" ]; }
${detectFn}
detect_target
printf '%s\\n' "$TARGET"
`;
    const result = await execFileAsync("sh", ["-c", harness], {
      env: {
        ...process.env,
        TEST_OS: os,
        TEST_MACHINE: machine,
        TEST_ARM64_HARDWARE: arm64Hardware ? "1" : "0",
      },
    });
    return result.stdout.trim();
  };

  assert.equal(await run("Darwin", "x86_64", true), "darwin-arm64");
  assert.equal(await run("Darwin", "x86_64", false), "darwin-x64");
  assert.equal(await run("Linux", "x86_64", true), "linux-x64");
});

test("install.sh executable retirement boundary accepts incomplete cleanup but fails stop/start errors honestly", async (t) => {
  if (process.platform === "win32") {
    t.skip();
    return;
  }
  const root = await mkdtemp(resolve(tmpdir(), "raft-install-retire-shell-"));
  t.onTestFinished(async () => rm(root, { recursive: true, force: true }));
  const installDir = resolve(root, "bin");
  const fake = resolve(installDir, "raft-computer");
  await mkdir(installDir, { recursive: true });
  await writeFile(
    fake,
    `#!/bin/sh
case "$RAFT_TEST_SUPERVISOR_MODE" in
  incomplete) echo '[computer] note: cleanup incomplete; Computer remains usable' >&2; exit 0 ;;
  stop-fail) echo 'STOP_SIGNAL_FAILED' >&2; exit 42 ;;
  start-fail) echo 'START_DAEMON_TIMEOUT' >&2; exit 42 ;;
esac
`,
  );
  await chmod(fake, 0o755);
  const script = readFileSync(installScriptPath, "utf8");
  const fn = script.match(/retire_legacy_supervisor\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(fn);
  const harness = resolve(root, "harness.sh");
  await writeFile(
    harness,
    `#!/bin/sh
INSTALL_DIR=${JSON.stringify(installDir)}
BIN_NAME=raft-computer
err() { printf '[install] error: %s\\n' "$1" >&2; exit 1; }
${fn}
retire_legacy_supervisor
`,
  );
  await chmod(harness, 0o755);

  const run = async (mode: string) => {
    try {
      const result = await execFileAsync("sh", [harness], {
        env: { ...process.env, RAFT_TEST_SUPERVISOR_MODE: mode },
      });
      return { code: 0, stderr: result.stderr };
    } catch (error) {
      const failed = error as { code?: number; stderr?: string };
      return { code: failed.code ?? -1, stderr: failed.stderr ?? "" };
    }
  };
  const incomplete = await run("incomplete");
  assert.equal(incomplete.code, 0);
  assert.match(incomplete.stderr, /Computer remains usable/);
  for (const mode of ["stop-fail", "start-fail"]) {
    const failed = await run(mode);
    assert.notEqual(failed.code, 0);
    assert.match(failed.stderr, /could not complete its detached lifecycle/);
    assert.doesNotMatch(failed.stderr, /remains usable|optional old OS autostart cleanup/i);
  }
});

test("install.sh resets remote and corrupt K state without invoking the upgrade engine", async (t) => {
  if (!['darwin', 'linux'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch)) {
    t.skip();
    return;
  }
  const root = await mkdtemp(resolve(tmpdir(), "raft-install-reset-"));
  t.onTestFinished(async () => rm(root, { recursive: true, force: true }));
  const version = "1.0.29";
  const target = `${process.platform}-${process.arch}`;
  const releaseRoot = resolve(root, "release");
  const releaseDir = resolve(releaseRoot, version);
  const fileName = `raft-computer-${target}`;
  await mkdir(releaseDir, { recursive: true });
  const bytes = await writeInstallerFixtureBinary(resolve(releaseDir, fileName), version);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const wasm = Buffer.from("fixture wasm");
  await writeFile(resolve(releaseDir, "photon_rs_bg.wasm"), wasm);
  await writeFile(resolve(releaseDir, "manifest.json"), JSON.stringify({ version,
    photonWasm: { file: "photon_rs_bg.wasm", sha256: createHash("sha256").update(wasm).digest("hex"), size: wasm.length },
    targets: { [target]: { file: fileName, sha256, size: bytes.length } },
  }));
  const fakeBin = await writeFileCommandShim(root, target);
  for (const mode of ["remote", "corrupt", "stop-fail", "live-lock"]) {
    const home = resolve(root, mode);
    const stateHome = resolve(home, ".slock");
    const k = resolve(stateHome, "computer/k");
    const installDir = resolve(home, "bin");
    const log = resolve(home, "k-call.log");
    await mkdir(k, { recursive: true });
    const receipt = mode === "corrupt" ? "unparseable old journal" : JSON.stringify({
      id: "remote-failed", phase: "failed", outcome: "failed", acknowledgedAtMs: null,
      provenance: { who: "origin-server", carrier: "web" }, metadata: { originServerId: "origin-server" },
    });
    await writeFile(resolve(k, "operation.json"), receipt);
    await writeFile(resolve(k, "other-state"), "keep every old byte");
    if (mode === "live-lock") await writeFile(resolve(k, "upgrade.lock"), JSON.stringify({ pid: process.pid, acquiredAtMs: 1 }));
    await writeFile(resolve(stateHome, "credentials-sentinel"), "do not touch credentials");
    const env = { ...process.env, HOME: home, SLOCK_HOME: stateHome, RAFT_HOME: stateHome,
      RAFT_COMPUTER_INSTALL_DIR: installDir, RAFT_COMPUTER_NO_MODIFY_PATH: "1",
      RAFT_COMPUTER_RELEASE_BACKEND: "legacy-cdn",
      RAFT_COMPUTER_RELEASE_BASE: `file://${releaseRoot}`, RAFT_COMPUTER_VERSION: version,
      RAFT_TEST_K_MODE: mode === "stop-fail" ? mode : "fail", RAFT_TEST_K_LOG: log,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    };
    if (mode === "stop-fail") {
      await assert.rejects(execFileAsync("sh", [installScriptPath], { env }), /fixture stop refused/);
      assert.equal(await readFile(resolve(k, "operation.json"), "utf8"), receipt);
      assert.equal(existsSync(resolve(installDir, "raft-computer")), false);
    } else {
      await execFileAsync("sh", [installScriptPath], { env });
      assert.equal(existsSync(k), false, "no live old K directory after reset");
      const backups = await readdir(resolve(stateHome, "computer/k-quarantine"));
      assert.equal(backups.length, 1);
      const backup = resolve(stateHome, "computer/k-quarantine", backups[0]!, "k");
      assert.equal(await readFile(resolve(backup, "operation.json"), "utf8"), receipt);
      assert.equal(await readFile(resolve(backup, "other-state"), "utf8"), "keep every old byte");
      assert.deepEqual(await readFile(resolve(installDir, "raft-computer")), bytes);
    }
    assert.equal(existsSync(log), false, "never invoke __installer-converge");
    assert.equal(await readFile(resolve(stateHome, "credentials-sentinel"), "utf8"), "do not touch credentials");
  }
});

test("install.sh exposes automatic recovery without a separate recovery switch", async () => {
  const script = readFileSync(installScriptPath, "utf8");
  assert.doesNotMatch(script, /force-recover|FORCE_RECOVER/u);
  assert.doesNotMatch(script, /__installer-converge/u);
  if (process.platform === "win32") return;
  const help = await execFileAsync("sh", [installScriptPath, "--help"]);
  assert.doesNotMatch(help.stderr, /force-recover/u);
  await assert.rejects(execFileAsync("sh", [installScriptPath, "--force-recover"]),
    /unknown option: --force-recover/u);
});

test("install.sh resets K and restarts a real SEA service", async (t) => {
  const nativeBinary = process.env.RAFT_TEST_NATIVE_COMPUTER?.trim();
  if (!["darwin", "linux"].includes(process.platform) || !nativeBinary) {
    t.skip();
    return;
  }

  const root = await mkdtemp(resolve(tmpdir(), "raft-install-native-k-"));
  // Keep the IPC socket path below macOS's sockaddr_un limit while retaining
  // a real /tmp -> /private/tmp slot alias for the K resident identity tooth.
  const stateRoot = await mkdtemp("/tmp/raft-k-state-");
  const home = resolve(root, "home");
  const stateHome = resolve(stateRoot, ".slock");
  const kStateDir = resolve(stateHome, "computer", "k");
  const installDir = resolve(home, "bin");
  const releaseRoot = resolve(root, "release");
  const version = process.env.RAFT_TEST_NATIVE_VERSION ?? COMPUTER_VERSION;
  const target = `${process.platform}-${process.arch}`;
  const fileName = `raft-computer-${target}`;
  const releaseDir = resolve(releaseRoot, version);
  const candidate = resolve(releaseDir, fileName);
  const mktempLog = resolve(root, "mktemp-paths.log");
  const shimDir = resolve(root, "shim-bin");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    SLOCK_HOME: stateHome,
    RAFT_HOME: stateHome,
    RAFT_COMPUTER_INSTALL_DIR: installDir,
    RAFT_COMPUTER_NO_MODIFY_PATH: "1",
    RAFT_COMPUTER_RELEASE_BACKEND: "legacy-cdn",
    RAFT_COMPUTER_RELEASE_BASE: `file://${releaseRoot}`,
    RAFT_COMPUTER_VERSION: version,
    RAFT_TEST_MKTEMP_LOG: mktempLog,
    PATH: `${shimDir}:${process.env.PATH ?? ""}`,
  };

  t.onTestFinished(async () => {
    const installed = resolve(installDir, "raft-computer");
    await execFileAsync(installed, ["stop"], { env, timeout: 15_000 }).catch(() => {});
    await rm(root, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
  });

  await mkdir(releaseDir, { recursive: true });
  await mkdir(shimDir, { recursive: true });
  await copyFile(nativeBinary, candidate);
  await chmod(candidate, 0o755);
  const candidateBytes = await readFile(candidate);
  const candidateSha256 = createHash("sha256").update(candidateBytes).digest("hex");
  const photonWasm = Buffer.from("native installer convergence fixture\n");
  await writeFile(resolve(releaseDir, "photon_rs_bg.wasm"), photonWasm);
  await writeFile(resolve(releaseDir, "manifest.json"), JSON.stringify({
    version,
    photonWasm: {
      file: "photon_rs_bg.wasm",
      sha256: createHash("sha256").update(photonWasm).digest("hex"),
      size: photonWasm.length,
    },
    targets: {
      [target]: {
        file: fileName,
        sha256: candidateSha256,
        size: candidateBytes.length,
      },
    },
  }));
  const mktempShim = resolve(shimDir, "mktemp");
  await writeFile(mktempShim, `#!/bin/sh
value="$(/usr/bin/mktemp "$@")" || exit $?
canonical="$(/bin/realpath "$value")" || exit $?
printf '%s\t%s\n' "$value" "$canonical" >> "$RAFT_TEST_MKTEMP_LOG"
printf '%s\n' "$value"
`);
  await chmod(mktempShim, 0o755);

  await bootstrapStable({
    stateDir: kStateDir,
    version,
    artifactPath: nativeBinary,
  });
  const stable = slotArtifactPath(kStateDir, "stable");
  const canonicalStable = await realpath(stable);
  assert.match(stable, /^\/tmp\//u);
  if (process.platform === "darwin") {
    assert.match(canonicalStable, /^\/private\/tmp\//u);
    assert.notEqual(stable, canonicalStable);
  }
  const serverId = "00000000-0000-4000-8000-000000000001";
  const serverDir = resolve(stateHome, "computer/servers", serverId);
  await mkdir(serverDir, { recursive: true });
  await writeFile(resolve(serverDir, "runner.state.json"), JSON.stringify({
    kind: "computer-attachment", serverId, serverMachineId: "fixture-machine",
    apiKey: "test-fixture-only", serverUrl: "http://127.0.0.1:1",
  }));
  const remoteReceipt = JSON.stringify({ formatVersion: 1, id: "remote-failed",
    startedAtMs: 1, updatedAtMs: 2, fromVersion: "1.0.23", targetVersion: "1.0.28",
    previousStableVersion: "1.0.23", phase: "failed", outcome: "failed",
    reason: "recovery settled at promoted with stable 1.0.23",
    provenance: { who: serverId, carrier: "web" }, metadata: { originServerId: serverId },
    acknowledgedAtMs: null,
  });
  await writeFile(resolve(kStateDir, "operation.json"), remoteReceipt);
  const service = spawn(stable, ["__service"], {
    env,
    detached: true,
    stdio: "ignore",
  });
  service.unref();
  t.onTestFinished(() => {
    if (service.pid === undefined) return;
    try {
      process.kill(service.pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  });
  let serviceReady = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const status = await execFileAsync(stable, ["status"], { env, timeout: 1_000 });
      if (/Service:\s+running/u.test(String(status.stdout))) {
        serviceReady = true;
        break;
      }
    } catch {
      await delay(100);
    }
  }
  assert.equal(serviceReady, true, "pre-upgrade K stable service must answer IPC");

  let result: Awaited<ReturnType<typeof execFileAsync>>;
  try {
    result = await execFileAsync("sh", [installScriptPath], {
      env,
      timeout: 60_000,
    });
  } catch (error) {
    // The synthetic attachment deliberately has no listening server. The
    // installer must report runner readiness failure honestly, while the
    // independent assertions below still prove service replacement/reset.
    const failed = error as { stderr: string; stdout: string };
    assert.match(failed.stderr, /Timed out waiting for 1 server runner/);
    result = { stdout: failed.stdout, stderr: failed.stderr } as typeof result;
  }
  assert.match(String(result.stderr), /installed to/u);
  assert.equal(
    createHash("sha256").update(await readFile(resolve(installDir, "raft-computer"))).digest("hex"),
    candidateSha256,
  );
  assert.equal(existsSync(kStateDir), false, "installer resets K instead of driving a new K operation");
  const status = await execFileAsync(resolve(installDir, "raft-computer"), ["status"], { env });
  assert.match(String(status.stdout), new RegExp(`Service version: +${version.replaceAll(".", "\\.")}`));

  const [rawTempPath = "", canonicalTempPath = ""] = (await readFile(mktempLog, "utf8"))
    .trim()
    .split("\n")[0]
    ?.split("\t") ?? [];
  if (process.platform === "darwin") {
    assert.match(rawTempPath, /^\/var\/folders\//u);
    assert.match(canonicalTempPath, /^\/private\/var\/folders\//u);
  }
  const backups = await readdir(resolve(stateHome, "computer/k-quarantine"));
  assert.equal(await readFile(resolve(stateHome, "computer/k-quarantine", backups[0]!, "k/operation.json"), "utf8"), remoteReceipt);
});

test("install.sh downgrade guard distinguishes dispatcher-self from newer K stable", async (t) => {
  if (process.platform === "win32") {
    t.skip();
    return;
  }
  const root = await mkdtemp(resolve(tmpdir(), "raft-install-version-sources-"));
  t.onTestFinished(async () => rm(root, { recursive: true, force: true }));
  const home = resolve(root, "home");
  const stateHome = resolve(home, ".slock");
  const installDir = resolve(home, "bin");
  const existing = resolve(installDir, "raft-computer");
  await mkdir(installDir, { recursive: true });
  await writeFile(existing, `#!/bin/sh
if [ "$1" = "--version" ]; then
  if [ "$SLOCK_HOME" = ${JSON.stringify(stateHome)} ]; then printf '1.0.19\\n'; else printf '1.0.17\\n'; fi
  exit 0
fi
exit 0
`);
  await chmod(existing, 0o755);
  const before = await readFile(existing);
  const result = await execFileAsync("sh", [installScriptPath], {
    env: {
      ...process.env,
      HOME: home,
      SLOCK_HOME: stateHome,
      RAFT_COMPUTER_INSTALL_DIR: installDir,
      RAFT_COMPUTER_NO_MODIFY_PATH: "1",
      RAFT_COMPUTER_RELEASE_BACKEND: "legacy-cdn",
      RAFT_COMPUTER_RELEASE_BASE: "https://must-not-be-read.invalid",
      RAFT_COMPUTER_VERSION: "1.0.18",
    },
  });
  assert.match(result.stderr, /effective K stable reached through .* v1\.0\.19 is NEWER/u);
  assert.equal(
    Buffer.compare(before, await readFile(existing)),
    0,
    "newer stable evidence must refuse without replacing the older dispatcher bytes",
  );
});

test("install.sh enforces SemVer prerelease downgrade precedence in the real installer process", async (t) => {
  if (
    !["darwin", "linux"].includes(process.platform) ||
    !["arm64", "x64"].includes(process.arch)
  ) {
    t.skip();
    return;
  }

  const cases: Array<{
    name: string;
    local: string;
    target: string;
    outcome: "refuse" | "install" | "malformed";
    force?: boolean;
  }> = [
    {
      name: "stable to older alpha refuses",
      local: "1.0.18",
      target: "1.0.17-staging.sha.abc123",
      outcome: "refuse",
    },
    {
      name: "stable to higher alpha installs",
      local: "1.0.18",
      target: "1.0.19-staging.sha.abc123",
      outcome: "install",
    },
    {
      name: "newer prerelease ordinal refuses",
      local: "1.0.19-staging.2",
      target: "1.0.19-staging.1",
      outcome: "refuse",
    },
    {
      name: "prerelease to stable installs",
      local: "1.0.19-staging.1",
      target: "1.0.19",
      outcome: "install",
    },
    {
      name: "stable to same-core prerelease refuses",
      local: "1.0.19",
      target: "1.0.19-staging.9",
      outcome: "refuse",
    },
    {
      name: "equal prerelease reverifies and installs",
      local: "1.0.19-staging.1",
      target: "1.0.19-staging.1",
      outcome: "install",
    },
    {
      name: "force permits stable to older alpha",
      local: "1.0.18",
      target: "1.0.17-staging.1",
      outcome: "install",
      force: true,
    },
    {
      name: "malformed target fails closed",
      local: "1.0.18",
      target: "1.0.19-staging.01",
      outcome: "malformed",
    },
    {
      name: "malformed local fails closed",
      local: "1.0.19-staging..1",
      target: "1.0.20",
      outcome: "malformed",
    },
    {
      name: "force does not permit malformed local",
      local: "1.0.19-staging..1",
      target: "1.0.18",
      outcome: "malformed",
      force: true,
    },
  ];

  for (const scenario of cases) {
    await runNamedCase(scenario.name, async () => {
      const root = await mkdtemp(
        resolve(tmpdir(), "raft-install-semver-posix-"),
      );
      t.onTestFinished(async () => rm(root, { recursive: true, force: true }));
      const home = resolve(root, "home");
      const stateHome = resolve(home, ".slock");
      const installDir = resolve(home, "bin");
      const existing = resolve(installDir, "raft-computer");
      const sidecar = resolve(installDir, "photon_rs_bg.wasm");
      const channel = resolve(stateHome, "computer", "channel");
      const stateSentinel = resolve(stateHome, "computer", "state-sentinel");
      const releaseRoot = resolve(root, "release");
      const target = `${process.platform}-${process.arch}`;
      await mkdir(installDir, { recursive: true });
      await mkdir(resolve(stateHome, "computer"), { recursive: true });
      await mkdir(releaseRoot, { recursive: true });
      await writeInstallerFixtureBinary(existing, scenario.local);
      await writeFile(sidecar, "original sidecar\n");
      await writeFile(channel, "preview\n");
      await writeFile(stateSentinel, "original state\n");
      const before = {
        binary: await readFile(existing),
        sidecar: await readFile(sidecar),
        channel: await readFile(channel),
        state: await readFile(stateSentinel),
      };

      let candidate: Buffer | null = null;
      if (scenario.outcome === "install") {
        const releaseDir = resolve(releaseRoot, scenario.target);
        const file = `raft-computer-${target}`;
        await mkdir(releaseDir, { recursive: true });
        candidate = await writeInstallerFixtureBinary(
          resolve(releaseDir, file),
          scenario.target,
        );
        const photonWasm = Buffer.from(`sidecar ${scenario.target}\n`);
        await writeFile(resolve(releaseDir, "photon_rs_bg.wasm"), photonWasm);
        await writeFile(
          resolve(releaseDir, "manifest.json"),
          JSON.stringify({
            version: scenario.target,
            photonWasm: {
              file: "photon_rs_bg.wasm",
              sha256: createHash("sha256").update(photonWasm).digest("hex"),
              size: photonWasm.length,
            },
            targets: {
              [target]: {
                file,
                sha256: createHash("sha256").update(candidate).digest("hex"),
                size: candidate.length,
              },
            },
          }),
        );
      }

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home,
        SLOCK_HOME: stateHome,
        RAFT_COMPUTER_INSTALL_DIR: installDir,
        RAFT_COMPUTER_RELEASE_BACKEND: "legacy-cdn",
        RAFT_COMPUTER_RELEASE_BASE: `file://${releaseRoot}`,
        RAFT_COMPUTER_VERSION: scenario.target,
        RAFT_COMPUTER_INSTALL_CHANNEL: "alpha",
        RAFT_COMPUTER_NO_MODIFY_PATH: "1",
        PATH: `${await writeFileCommandShim(root, target)}:${process.env.PATH ?? ""}`,
      };
      if (scenario.force) env.RAFT_COMPUTER_FORCE = "1";

      let code = 0;
      let stderr = "";
      try {
        const result = await execFileAsync("sh", [installScriptPath], { env });
        stderr = result.stderr;
      } catch (error) {
        const failed = error as { code?: number; stderr?: string };
        code = failed.code ?? -1;
        stderr = failed.stderr ?? "";
      }

      if (scenario.outcome === "install") {
        assert.equal(code, 0, stderr);
        assert.ok(candidate);
        assert.equal(
          Buffer.compare(await readFile(existing), candidate),
          0,
          "target candidate must replace the dispatcher",
        );
        assert.equal(
          (await execFileAsync(existing, ["--version"])).stdout.trim(),
          scenario.target,
        );
        assert.equal((await readFile(channel, "utf8")).trim(), "alpha");
        assert.equal(
          (await readFile(stateSentinel, "utf8")).trim(),
          "original state",
        );
        assert.match(stderr, /binary (?:sha256|platform) verified/u);
      } else {
        assert.equal(code === 0, scenario.outcome === "refuse", stderr);
        if (scenario.outcome === "refuse") {
          assert.match(
            stderr,
            /is NEWER than the target .* refusing to downgrade/u,
          );
        } else {
          assert.match(stderr, /invalid (?:release version|SemVer)/u);
        }
        assert.equal(
          Buffer.compare(await readFile(existing), before.binary),
          0,
          "refused/malformed arm must not replace binary",
        );
        assert.equal(
          Buffer.compare(await readFile(sidecar), before.sidecar),
          0,
          "refused/malformed arm must not replace sidecar",
        );
        assert.equal(
          Buffer.compare(await readFile(channel), before.channel),
          0,
          "refused/malformed arm must not change channel",
        );
        assert.equal(
          Buffer.compare(await readFile(stateSentinel), before.state),
          0,
          "refused/malformed arm must not change state",
        );
      }
    });
  }
});

test("install.ps1 enforces SemVer prerelease downgrade precedence in the real installer process", async (t) => {
  if (process.platform !== "win32") {
    t.skip();
    return;
  }

  const root = await mkdtemp(resolve(tmpdir(), "raft-install-semver-windows-"));
  t.onTestFinished(async () => rm(root, { recursive: true, force: true }));
  const versionFixture = await writeWindowsVersionFixture(root);
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    res.statusCode = 503;
    res.end("intentional process-branch sentinel");
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  t.onTestFinished(
    async () =>
      new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const cases: Array<{
    name: string;
    local: string;
    target: string;
    outcome: "refuse" | "proceed" | "malformed";
    force?: boolean;
  }> = [
    {
      name: "stable to older alpha refuses",
      local: "1.0.18",
      target: "1.0.17-staging.sha.abc123",
      outcome: "refuse",
    },
    {
      name: "stable to higher alpha proceeds",
      local: "1.0.18",
      target: "1.0.19-staging.sha.abc123",
      outcome: "proceed",
    },
    {
      name: "newer prerelease ordinal refuses",
      local: "1.0.19-staging.2",
      target: "1.0.19-staging.1",
      outcome: "refuse",
    },
    {
      name: "prerelease to stable proceeds",
      local: "1.0.19-staging.1",
      target: "1.0.19",
      outcome: "proceed",
    },
    {
      name: "stable to same-core prerelease refuses",
      local: "1.0.19",
      target: "1.0.19-staging.9",
      outcome: "refuse",
    },
    {
      name: "equal prerelease reverifies",
      local: "1.0.19-staging.1",
      target: "1.0.19-staging.1",
      outcome: "proceed",
    },
    {
      name: "force permits stable to older alpha",
      local: "1.0.18",
      target: "1.0.17-staging.1",
      outcome: "proceed",
      force: true,
    },
    {
      name: "malformed target fails closed",
      local: "1.0.18",
      target: "1.0.19-staging.01",
      outcome: "malformed",
    },
    {
      name: "malformed local fails closed",
      local: "1.0.19-staging..1",
      target: "1.0.20",
      outcome: "malformed",
    },
    {
      name: "force does not permit malformed local",
      local: "1.0.19-staging..1",
      target: "1.0.18",
      outcome: "malformed",
      force: true,
    },
  ];

  for (const [index, scenario] of cases.entries()) {
    await runNamedCase(scenario.name, async () => {
      requests.length = 0;
      const caseRoot = resolve(root, `case-${index}`);
      const home = resolve(caseRoot, "home");
      const stateHome = resolve(home, ".slock");
      const installDir = resolve(home, "bin");
      const destination = resolve(installDir, "raft-computer.exe");
      const sidecar = resolve(installDir, "photon_rs_bg.wasm");
      const channel = resolve(stateHome, "computer", "channel");
      const stateSentinel = resolve(stateHome, "computer", "state-sentinel");
      const temp = resolve(caseRoot, "temp");
      await mkdir(installDir, { recursive: true });
      await mkdir(resolve(stateHome, "computer"), { recursive: true });
      await mkdir(temp, { recursive: true });
      await copyFile(versionFixture, destination);
      await writeFile(sidecar, "original sidecar\n");
      await writeFile(channel, "preview\n");
      await writeFile(stateSentinel, "original state\n");
      const before = {
        binary: await readFile(destination),
        sidecar: await readFile(sidecar),
        channel: await readFile(channel),
        state: await readFile(stateSentinel),
      };
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        USERPROFILE: home,
        TEMP: temp,
        TMP: temp,
        SLOCK_HOME: stateHome,
        RAFT_COMPUTER_INSTALL_DIR: installDir,
        RAFT_COMPUTER_RELEASE_BACKEND: "legacy-cdn",
        RAFT_COMPUTER_RELEASE_BASE: `http://127.0.0.1:${address.port}`,
        RAFT_COMPUTER_VERSION: scenario.target,
        RAFT_COMPUTER_INSTALL_CHANNEL: "alpha",
        RAFT_COMPUTER_NO_MODIFY_PATH: "1",
        RAFT_TEST_LOCAL_VERSION: scenario.local,
      };
      if (scenario.force) env.RAFT_COMPUTER_FORCE = "1";
      for (const key of Object.keys(env)) {
        if (key.toLowerCase() === "psmodulepath") delete env[key];
      }

      let code = 0;
      let stdout = "";
      let stderr = "";
      try {
        const result = await execFileAsync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            windowsInstallScriptPath,
          ],
          { env },
        );
        stdout = result.stdout;
        stderr = result.stderr;
      } catch (error) {
        const failed = error as {
          code?: number;
          stdout?: string;
          stderr?: string;
        };
        code = failed.code ?? -1;
        stdout = failed.stdout ?? "";
        stderr = failed.stderr ?? "";
      }

      if (scenario.outcome === "refuse") {
        assert.equal(code, 0, stderr);
        assert.match(stdout, /is newer than target .* refusing to downgrade/iu);
        assert.deepEqual(
          requests,
          [],
          "refused downgrade must not fetch a manifest",
        );
      } else if (scenario.outcome === "malformed") {
        assert.notEqual(code, 0);
        assert.match(stderr, /invalid SemVer/iu);
        assert.deepEqual(
          requests,
          [],
          "malformed version must fail before any manifest request",
        );
      } else {
        assert.notEqual(
          code,
          0,
          "sentinel manifest response must terminate a proceeded installer",
        );
        assert.deepEqual(
          requests,
          [`/${scenario.target}/manifest.json`],
          "higher/equal/force arm must execute the real manifest-fetch branch",
        );
      }

      assert.equal(
        Buffer.compare(await readFile(destination), before.binary),
        0,
        "pre-install refusal/failure must not replace binary",
      );
      assert.equal(
        Buffer.compare(await readFile(sidecar), before.sidecar),
        0,
        "pre-install refusal/failure must not replace sidecar",
      );
      assert.equal(
        Buffer.compare(await readFile(channel), before.channel),
        0,
        "pre-install refusal/failure must not change channel",
      );
      assert.equal(
        Buffer.compare(await readFile(stateSentinel), before.state),
        0,
        "pre-install refusal/failure must not change state",
      );
    });
  }
});

test("install.ps1 executable retirement boundary accepts incomplete cleanup but fails stop/start errors honestly", async (t) => {
  if (process.platform !== "win32") {
    t.skip();
    return;
  }
  const root = await mkdtemp(resolve(tmpdir(), "raft-install-retire-ps1-"));
  t.onTestFinished(async () => rm(root, { recursive: true, force: true }));
  const source = readFileSync(windowsInstallScriptPath, "utf8");
  const retire = source.match(
    new RegExp("function " + "Retire-LegacySupervisor[\\s\\S]*?\\n\\}"),
  )?.[0];
  const fail = source.match(/function Fail[\s\S]*?\n\}/)?.[0];
  assert.ok(retire && fail);
  const fake = resolve(root, "fake-computer.ps1");
  await writeFile(
    fake,
    `switch ($env:RAFT_TEST_SUPERVISOR_MODE) {
  'incomplete' { [Console]::Error.WriteLine('[computer] note: cleanup incomplete; Computer remains usable'); exit 0 }
  'stop-fail' { [Console]::Error.WriteLine('STOP_SIGNAL_FAILED'); exit 42 }
  'start-fail' { [Console]::Error.WriteLine('START_DAEMON_TIMEOUT'); exit 42 }
}
`,
  );
  const harness = resolve(root, "harness.ps1");
  await writeFile(
    harness,
    `$ErrorActionPreference = 'Stop'
${fail}
${retire}
try { Retire-LegacySupervisor ${JSON.stringify(fake)} } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
`,
  );
  const run = async (mode: string) => {
    try {
      const result = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harness],
        { env: { ...process.env, RAFT_TEST_SUPERVISOR_MODE: mode } },
      );
      return { code: 0, stderr: result.stderr };
    } catch (error) {
      const failed = error as { code?: number; stderr?: string };
      return { code: failed.code ?? -1, stderr: failed.stderr ?? "" };
    }
  };
  const incomplete = await run("incomplete");
  assert.equal(incomplete.code, 0);
  assert.match(incomplete.stderr, /Computer remains usable/);
  for (const mode of ["stop-fail", "start-fail"]) {
    const failed = await run(mode);
    assert.notEqual(failed.code, 0);
    assert.match(failed.stderr, /could not complete its detached lifecycle/);
    assert.doesNotMatch(failed.stderr, /remains usable|optional old OS autostart cleanup/i);
  }
});

test("install.ps1 downloads, verifies, decompresses, and completes same-version installs on Windows", async (t) => {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch)) {
    t.skip();
    return;
  }

  const root = await mkdtemp(resolve(tmpdir(), "raft-computer-install-windows-"));
  const binary = await readFile(process.execPath);
  const compressed = gzipSync(binary);
  const photonWasm = Buffer.from("fixture photon wasm\n");
  const version = process.versions.node;
  const target = `win32-${process.arch}`;
  const file = `raft-computer-${target}.exe`;
  const manifest = JSON.stringify({
    name: "raft-computer",
    version,
    photonWasm: {
      file: "photon_rs_bg.wasm",
      sha256: createHash("sha256").update(photonWasm).digest("hex"),
      size: photonWasm.length,
    },
    targets: {
      [target]: {
        file,
        sha256: createHash("sha256").update(binary).digest("hex"),
        size: binary.length,
        gz: {
          file: `${file}.gz`,
          sha256: createHash("sha256").update(compressed).digest("hex"),
          size: compressed.length,
        },
      },
    },
  });
  const server = createServer((req, res) => {
    if (req.url === `/${version}/manifest.json`) {
      res.setHeader("content-type", "application/json");
      res.end(manifest);
      return;
    }
    if (req.url === `/${version}/${file}.gz`) {
      res.setHeader("content-type", "application/gzip");
      res.end(compressed);
      return;
    }
    if (req.url === `/${version}/photon_rs_bg.wasm`) {
      res.setHeader("content-type", "application/wasm");
      res.end(photonWasm);
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });

  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const home = resolve(root, "home");
    const installDir = resolve(home, ".local", "bin");
    const slockHome = resolve(home, ".slock");
    const tempDir = resolve(root, "temp");
    const preload = await writeNodeSupervisorPreload(root);
    const supervisorLog = resolve(root, "supervisor.log");
    await mkdir(home, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      USERPROFILE: home,
      TEMP: tempDir,
      TMP: tempDir,
      SLOCK_HOME: slockHome,
      RAFT_COMPUTER_INSTALL_DIR: installDir,
      RAFT_COMPUTER_RELEASE_BACKEND: "legacy-cdn",
      RAFT_COMPUTER_RELEASE_BASE: `http://127.0.0.1:${address.port}`,
      RAFT_COMPUTER_VERSION: "9.9.9",
      RAFT_COMPUTER_INSTALL_CHANNEL: "alpha",
      RAFT_COMPUTER_NO_MODIFY_PATH: "1",
      NODE_OPTIONS: nodeOptionsWithPreload(preload),
      RAFT_TEST_SUPERVISOR_LOG: supervisorLog,
    };
    // The pwsh Actions shell exports a PS7-only module path. Let Windows PowerShell initialize its own.
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === "psmodulepath") delete env[key];
    }
    assert.equal(
      Object.keys(env).some((key) => key.toLowerCase() === "psmodulepath"),
      false,
      "Windows PowerShell child env must not inherit PSModulePath",
    );
    await mkdir(tempDir, { recursive: true });

    const first = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        windowsInstallScriptPath,
        "-Version",
        version,
      ],
      { env },
    );
    assert.equal(existsSync(supervisorLog), false, "pure fresh Windows install must skip migration");
    await rm(resolve(installDir, "raft-computer.exe"), { force: true });
    await mkdir(resolve(slockHome, "computer"), { recursive: true });
    const second = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        windowsInstallScriptPath,
        "-Version",
        version,
      ],
      { env },
    );

    assert.ok(existsSync(resolve(installDir, "raft-computer.exe")));
    assert.equal(
      createHash("sha256").update(await readFile(resolve(installDir, "photon_rs_bg.wasm"))).digest("hex"),
      createHash("sha256").update(photonWasm).digest("hex"),
    );
    assert.equal((await readFile(resolve(slockHome, "computer", "channel"), "utf8")).trim(), "alpha");
    assert.match(first.stdout, /binary sha256 and PE architecture verified/);
    assert.match(first.stdout, /installed to/);
    assert.match(second.stdout, /installed to/);
    assert.equal(
      await realpath((await readFile(supervisorLog, "utf8")).trim()),
      await realpath(resolve(installDir, "raft-computer.exe")),
      "existing same-home Computer state must trigger migration even when destination B was absent",
    );
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(root, { recursive: true, force: true });
  }
});

test("install.sh survives nested evidence objects inside a target (1.0.6 apple-block regression)", async (t) => {
  if (!["darwin", "linux"].includes(process.platform) || !["arm64", "x64"].includes(process.arch)) {
    t.skip();
    return;
  }
  if (!existsSync(process.execPath)) {
    t.skip();
    return;
  }

  // The 1.0.6 signing pipeline embedded an `apple` evidence object — carrying
  // its own nested file/sha256/size keys — inside darwin targets. The flat
  // greedy manifest slicing then resolved FILE to a receipt json and filled
  // the gz fields from raw values: every darwin curl|sh downloaded the raw
  // binary, its sha "verified", and gunzip died (task #332). This cell runs
  // the REAL installer against a manifest of that exact shape; the poisoned
  // extraction cannot install the correct bytes through the gzip path.
  const root = await mkdtemp(resolve(tmpdir(), "raft-computer-install-evidence-"));
  try {
    const version = "0.0.2-test";
    const target = `${process.platform}-${process.arch}`;
    const releaseDir = resolve(root, "release", version);
    const home = resolve(root, "user-home");
    const installDir = resolve(home, ".local", "bin");
    const slockHome = resolve(root, "home");
    const fileName = `raft-computer-${target}`;
    await mkdir(releaseDir, { recursive: true });
    const bytes = await writeInstallerFixtureBinary(resolve(releaseDir, fileName), version);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const compressed = gzipSync(bytes);
    const decoy = Buffer.from("poison: not the binary, must never be selected\n");
    const photonWasm = Buffer.from("fixture photon wasm\n");
    await writeFile(resolve(releaseDir, `${fileName}.gz`), compressed);
    await writeFile(resolve(releaseDir, `${fileName}.notarization.receipt.json`), decoy);
    await writeFile(resolve(releaseDir, "photon_rs_bg.wasm"), photonWasm);
    await writeFile(
      resolve(releaseDir, "manifest.json"),
      JSON.stringify(
        {
          version,
          photonWasm: {
            file: "photon_rs_bg.wasm",
            sha256: createHash("sha256").update(photonWasm).digest("hex"),
            size: photonWasm.length,
          },
          targets: {
            [target]: {
              file: fileName,
              sha256,
              size: bytes.length,
              apple: {
                signature: { type: "developer-id-application", teamId: "TESTTEAM00" },
                notarization: {
                  status: "Accepted",
                  evidence: {
                    receipt: {
                      file: `${fileName}.notarization.receipt.json`,
                      sha256: createHash("sha256").update(decoy).digest("hex"),
                      size: decoy.length,
                    },
                  },
                },
              },
              gz: {
                file: `${fileName}.gz`,
                sha256: createHash("sha256").update(compressed).digest("hex"),
                size: compressed.length,
              },
            },
          },
        },
        null,
        2,
      ),
    );

    const env = {
      ...process.env,
      HOME: home,
      SLOCK_HOME: slockHome,
      RAFT_COMPUTER_INSTALL_DIR: installDir,
      RAFT_COMPUTER_NO_MODIFY_PATH: "1",
      RAFT_COMPUTER_RELEASE_BACKEND: "legacy-cdn",
      RAFT_COMPUTER_RELEASE_BASE: `file://${resolve(root, "release")}`,
      RAFT_COMPUTER_VERSION: version,
      RAFT_COMPUTER_INSTALL_CHANNEL: "alpha",
      PATH: `${await writeFileCommandShim(root, target)}:${process.env.PATH ?? ""}`,
    };
    const out = await execFileAsync("sh", [installScriptPath], { env });
    const log = `${out.stdout}\n${out.stderr}`;
    assert.match(log, /downloaded gzip sha256 verified/);
    assert.match(log, /binary sha256 verified/);
    const installed = await readFile(resolve(installDir, "raft-computer"));
    assert.equal(
      createHash("sha256").update(installed).digest("hex"),
      sha256,
      "installed bytes must be the raw binary, not a receipt or the gz carrier",
    );
    assert.equal(
      createHash("sha256").update(await readFile(resolve(installDir, "photon_rs_bg.wasm"))).digest("hex"),
      createHash("sha256").update(photonWasm).digest("hex"),
      "installer must place the verified image processing resource beside the SEA binary",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("install.sh persists alpha channel and adds default bin to zsh PATH idempotently", async (t) => {
  if (!["darwin", "linux"].includes(process.platform) || !["arm64", "x64"].includes(process.arch)) {
    t.skip();
    return;
  }
  if (!existsSync(process.execPath)) {
    t.skip();
    return;
  }

  const root = await mkdtemp(resolve(tmpdir(), "raft-computer-install-channel-"));
  try {
    const version = "0.0.1-test";
    const target = `${process.platform}-${process.arch}`;
    const releaseDir = resolve(root, "release", version);
    const home = resolve(root, "user-home");
    const installDir = resolve(home, ".local", "bin");
    const slockHome = resolve(root, "home");
    const fileName = `raft-computer-${target}`;
    const binaryPath = resolve(releaseDir, fileName);
    await mkdir(releaseDir, { recursive: true });
    const bytes = await writeInstallerFixtureBinary(binaryPath, version);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const photonWasm = Buffer.from("fixture photon wasm\n");
    await writeFile(resolve(releaseDir, "photon_rs_bg.wasm"), photonWasm);
    await writeFile(
      resolve(releaseDir, "manifest.json"),
      JSON.stringify({
        version,
        photonWasm: {
          file: "photon_rs_bg.wasm",
          sha256: createHash("sha256").update(photonWasm).digest("hex"),
          size: photonWasm.length,
        },
        targets: {
          [target]: {
            file: fileName,
            sha256,
            size: bytes.length,
          },
        },
      }),
    );
    await writeFile(resolve(root, "release", "manifest.json"), JSON.stringify({ version }));

    const legacyDefinition = buildOsSupervisorSpec({
      platform: process.platform,
      slockHome,
      binaryPath: resolve(installDir, "raft-computer"),
      userHome: home,
      uid: process.getuid?.() ?? null,
      xdgConfigHome: join(home, ".config"),
    }).definitionPath!;
    const legacyDefinitionBytes = "legacy OS supervisor definition\nkeep byte-for-byte\n";
    await mkdir(resolve(legacyDefinition, ".."), { recursive: true });
    await writeFile(legacyDefinition, legacyDefinitionBytes);

    const env = {
      ...process.env,
      HOME: home,
      SHELL: "/bin/zsh",
      ZDOTDIR: home,
      SLOCK_HOME: slockHome,
      RAFT_COMPUTER_INSTALL_DIR: installDir,
      RAFT_COMPUTER_NO_MODIFY_PATH: "0",
      RAFT_COMPUTER_RELEASE_BACKEND: "legacy-cdn",
      RAFT_COMPUTER_RELEASE_BASE: `file://${resolve(root, "release")}`,
      RAFT_COMPUTER_VERSION: version,
      RAFT_COMPUTER_INSTALL_CHANNEL: "alpha",
      PATH: `${await writeFileCommandShim(root, target)}:${process.env.PATH ?? ""}`,
    };
    const firstInstall = await execFileAsync("sh", [installScriptPath], { env });
    await execFileAsync("sh", [installScriptPath], { env });

    assert.equal((await readFile(resolve(slockHome, "computer", "channel"), "utf8")).trim(), "alpha");
    assert.equal((await stat(resolve(slockHome, "computer", "channel"))).mode & 0o777, 0o600);
    assert.ok(existsSync(resolve(installDir, "raft-computer")));
    assert.equal(
      createHash("sha256").update(await readFile(resolve(installDir, "photon_rs_bg.wasm"))).digest("hex"),
      createHash("sha256").update(photonWasm).digest("hex"),
      "installer must place the verified image processing resource beside the SEA binary",
    );
    assert.equal(await readFile(legacyDefinition, "utf8"), legacyDefinitionBytes);
    const zshrc = await readFile(resolve(home, ".zshrc"), "utf8");
    assert.equal(zshrc.match(/^# raft-computer$/gm)?.length, 1);
    assert.equal(zshrc.match(/^export PATH="\$HOME\/\.local\/bin:\$PATH"$/gm)?.length, 1);
    assert.match(firstInstall.stderr, /Open a new terminal to use raft-computer/);
    assert.match(firstInstall.stderr, /to use it in this terminal, run: export PATH="\$HOME\/\.local\/bin:\$PATH"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- Hands release-authority version selection ---

type HandsLatestAsset = {
  platform: string;
  arch: string;
  variant: null | string;
  filetype: string;
  size_bytes: number;
  sha256: string;
  download_url: string;
};

function handsAssetForTarget(target: string, sha256: string, size: number): HandsLatestAsset {
  const [platform, arch] = target.split("-");
  assert.ok(platform);
  assert.ok(arch);
  return {
    platform,
    arch,
    variant: null,
    filetype: "binary",
    size_bytes: size,
    sha256,
    download_url: `https://hands.invalid/download/${target}`,
  };
}

function handsLatestBody(version: string, channel: string, assets: HandsLatestAsset[] = []): string {
  return JSON.stringify({
    app: { slug: "test-app", platform: "desktop" },
    channel,
    build: {
      id: "build-fixture",
      version,
      version_code: 1,
      release_type: "stable",
      changelog: null,
      release_notes: null,
      force_update: false,
      released_at: 0,
    },
    assets,
    scoped: { scope_type: "full", scope_value: "all", release_id: "release-fixture" },
    // Decoy: an unanchored "version" scrape must never pick this up.
    fallback_release: { version: "9.9.9-decoy" },
    expires_in: 300,
  });
}

async function startHandsFixture(options: {
  appSlug: string;
  channel: string;
  version: string;
  assets?: HandsLatestAsset[];
}): Promise<{ origin: string; requests: string[]; close: () => Promise<void> }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    const url = new URL(req.url ?? "/", "http://fixture");
    if (options.channel.startsWith("pinned:") && url.pathname === `/public/v2/apps/${options.appSlug}/updates/check`
      && url.searchParams.get("version") === options.version && url.searchParams.get("channel") === "main") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ update_available: true, release: { version: options.version }, artifact: options.assets?.[0] }));
      return;
    }
    if (req.url === `/public/v2/apps/${options.appSlug}/latest?channel=${options.channel}&product_type=cli-binary`) {
      res.setHeader("content-type", "application/json");
      res.end(handsLatestBody(options.version, options.channel, options.assets ?? []));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "no active release", code: "no_active_release" }));
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}

async function writePosixReleaseFixture(root: string, version: string, target: string): Promise<{
  fileName: string;
  sha256: string;
  size: number;
  asset: HandsLatestAsset;
}> {
  const releaseDir = resolve(root, "release", version);
  const fileName = `raft-computer-${target}`;
  await mkdir(releaseDir, { recursive: true });
  const bytes = await writeInstallerFixtureBinary(resolve(releaseDir, fileName), version);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const photonWasm = Buffer.from("fixture photon wasm\n");
  await writeFile(resolve(releaseDir, "photon_rs_bg.wasm"), photonWasm);
  await writeFile(
    resolve(releaseDir, "manifest.json"),
    JSON.stringify({
      version,
      photonWasm: {
        file: "photon_rs_bg.wasm",
        sha256: createHash("sha256").update(photonWasm).digest("hex"),
        size: photonWasm.length,
      },
      targets: {
        [target]: {
          file: fileName,
          sha256,
          size: bytes.length,
        },
      },
    }),
  );
  return { fileName, sha256, size: bytes.length, asset: handsAssetForTarget(target, sha256, bytes.length) };
}

function posixInstallerHostSupported(t: { skip: () => void }): boolean {
  if (!["darwin", "linux"].includes(process.platform) || !["arm64", "x64"].includes(process.arch)) {
    t.skip();
    return false;
  }
  if (!existsSync(process.execPath)) {
    t.skip();
    return false;
  }
  return true;
}

async function handsSelectionEnv(root: string, target: string, overrides: Record<string, string>): Promise<NodeJS.ProcessEnv> {
  const home = resolve(root, "user-home");
  await mkdir(home, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    SHELL: "/bin/sh",
    SLOCK_HOME: resolve(root, "home"),
    RAFT_COMPUTER_INSTALL_DIR: resolve(home, ".local", "bin"),
    RAFT_COMPUTER_NO_MODIFY_PATH: "1",
    RAFT_COMPUTER_RELEASE_BACKEND: "legacy-cdn",
    RAFT_COMPUTER_RELEASE_BASE: `file://${resolve(root, "release")}`,
    PATH: `${await writeFileCommandShim(root, target)}:${process.env.PATH ?? ""}`,
    ...overrides,
  };
  delete env.RAFT_COMPUTER_VERSION;
  delete env.RAFT_COMPUTER_INSTALL_CHANNEL;
  for (const [key, value] of Object.entries(overrides)) env[key] = value;
  return env;
}

test("install.sh resolves the main-channel version from Hands on a cold install", async (t) => {
  if (!posixInstallerHostSupported(t)) return;

  const root = await mkdtemp(resolve(tmpdir(), "raft-computer-install-hands-main-"));
  const version = "0.0.1-test";
  const target = `${process.platform}-${process.arch}`;
  const release = await writePosixReleaseFixture(root, version, target);
  const hands = await startHandsFixture({ appSlug: "test-app", channel: "main", version, assets: [release.asset] });
  try {
    const env = await handsSelectionEnv(root, target, {
      RAFT_COMPUTER_HANDS_ORIGIN: hands.origin,
      RAFT_COMPUTER_HANDS_APP: "test-app",
    });
    await execFileAsync("sh", [installScriptPath], { env });

    assert.ok(existsSync(resolve(root, "user-home", ".local", "bin", "raft-computer")));
    assert.deepEqual(hands.requests, ["/public/v2/apps/test-app/latest?channel=main&product_type=cli-binary"]);
    assert.ok(
      !existsSync(resolve(root, "home", "computer", "channel")),
      "a cold main-channel install must not invent a persisted channel",
    );
  } finally {
    await hands.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("install.sh --channel overrides the environment and persists the selected public channel", async (t) => {
  if (!posixInstallerHostSupported(t)) return;

  const cases = [
    {
      cli: "alpha",
      args: ["--channel=alpha"],
      env: "latest",
      hands: "alpha",
      persisted: "alpha",
    },
    { cli: "main", args: ["--channel", "main"], env: "alpha", hands: "main", persisted: "latest" },
  ] as const;

  for (const scenario of cases) {
    await runNamedCase(scenario.cli, async () => {
      const root = await mkdtemp(resolve(tmpdir(), `raft-computer-install-cli-${scenario.cli}-`));
      const version = "0.0.1-test";
      const target = `${process.platform}-${process.arch}`;
      const release = await writePosixReleaseFixture(root, version, target);
      const hands = await startHandsFixture({
        appSlug: "test-app",
        channel: scenario.hands,
        version,
        assets: [release.asset],
      });
      try {
        const env = await handsSelectionEnv(root, target, {
          RAFT_COMPUTER_HANDS_ORIGIN: hands.origin,
          RAFT_COMPUTER_HANDS_APP: "test-app",
          RAFT_COMPUTER_INSTALL_CHANNEL: scenario.env,
        });
        await execFileAsync("sh", [installScriptPath, ...scenario.args], { env });

        assert.deepEqual(hands.requests, [
          `/public/v2/apps/test-app/latest?channel=${scenario.hands}&product_type=cli-binary`,
        ]);
        assert.equal(
          (await readFile(resolve(root, "home", "computer", "channel"), "utf8")).trim(),
          scenario.persisted,
        );
      } finally {
        await hands.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("install.sh explicit legacy-CDN --version overrides the environment", async (t) => {
  if (!posixInstallerHostSupported(t)) return;

  const root = await mkdtemp(resolve(tmpdir(), "raft-computer-install-cli-version-"));
  const version = "0.0.1-test";
  const target = `${process.platform}-${process.arch}`;
  try {
    await writePosixReleaseFixture(root, version, target);
    const env = await handsSelectionEnv(root, target, {
      RAFT_COMPUTER_VERSION: "9.9.9",
      RAFT_COMPUTER_HANDS_ORIGIN: "https://must-not-be-read.invalid",
    });
    await execFileAsync("sh", [installScriptPath, `--version=${version}`], { env });

    assert.ok(existsSync(resolve(root, "user-home", ".local", "bin", "raft-computer")));
    assert.equal(existsSync(resolve(root, "home", "computer", "channel")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("install.sh exposes help and rejects invalid command-line channels before network access", async () => {
  const help = await execFileAsync("sh", [installScriptPath, "--help"]);
  assert.match(help.stderr, /Usage: install\.sh \[--channel main\|alpha\] \[--version <semver>\]/);

  await assert.rejects(
    execFileAsync("sh", [installScriptPath, "--channel", "beta"], {
      env: {
        ...process.env,
        RAFT_COMPUTER_RELEASE_BACKEND: "legacy-cdn",
        RAFT_COMPUTER_RELEASE_BASE: "https://must-not-be-read.invalid",
        RAFT_COMPUTER_HANDS_ORIGIN: "https://must-not-be-read.invalid",
      },
    }),
    (error: { stderr?: string }) => {
      assert.match(error.stderr ?? "", /invalid --channel: beta/);
      assert.doesNotMatch(error.stderr ?? "", /resolving the active/);
      return true;
    },
  );
});

test("install.sh refuses Hands/CDN identity drift before downloading assets", async (t) => {
  if (!posixInstallerHostSupported(t)) return;

  const cases: Array<{
    name: string;
    assets: (release: Awaited<ReturnType<typeof writePosixReleaseFixture>>) => HandsLatestAsset[];
    error: RegExp;
  }> = [
    {
      name: "sha mismatch",
      assets: (release) => [{ ...release.asset, sha256: "0".repeat(64) }],
      error: /Hands\/CDN identity mismatch/u,
    },
    {
      name: "size mismatch",
      assets: (release) => [{ ...release.asset, size_bytes: release.size + 1 }],
      error: /Hands\/CDN identity mismatch/u,
    },
    {
      name: "missing platform asset",
      assets: () => [],
      error: /must carry exactly one raw asset/u,
    },
  ];

  for (const scenario of cases) {
    await runNamedCase(scenario.name, async () => {
      const root = await mkdtemp(resolve(tmpdir(), "raft-computer-install-hands-drift-"));
      const version = "0.0.1-test";
      const target = `${process.platform}-${process.arch}`;
      const release = await writePosixReleaseFixture(root, version, target);
      const manifest = await readFile(resolve(root, "release", version, "manifest.json"), "utf8");
      const requests: string[] = [];
      const server = createServer((req, res) => {
        requests.push(req.url ?? "");
        if (req.url === "/public/v2/apps/test-app/latest?channel=main&product_type=cli-binary") {
          res.setHeader("content-type", "application/json");
          res.end(handsLatestBody(version, "main", scenario.assets(release)));
          return;
        }
        if (req.url === `/${version}/manifest.json`) {
          res.setHeader("content-type", "application/json");
          res.end(manifest);
          return;
        }
        res.statusCode = 500;
        res.end("asset download must not happen");
      });
      try {
        await new Promise<void>((resolveListen, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolveListen);
        });
        const address = server.address();
        assert.ok(address && typeof address === "object");
        const env = await handsSelectionEnv(root, target, {
          RAFT_COMPUTER_RELEASE_BACKEND: "legacy-cdn",
          RAFT_COMPUTER_RELEASE_BASE: `http://127.0.0.1:${address.port}`,
          RAFT_COMPUTER_HANDS_ORIGIN: `http://127.0.0.1:${address.port}`,
          RAFT_COMPUTER_HANDS_APP: "test-app",
        });
        await assert.rejects(
          execFileAsync("sh", [installScriptPath], { env }),
          (error: { stderr?: string }) => {
            assert.match(error.stderr ?? "", scenario.error);
            assert.match(error.stderr ?? "", /Refusing before download|refusing before download/u);
            return true;
          },
        );
        assert.deepEqual(requests, [
          "/public/v2/apps/test-app/latest?channel=main&product_type=cli-binary",
          `/${version}/manifest.json`,
        ]);
        assert.equal(existsSync(resolve(root, "user-home", ".local", "bin")), false);
      } finally {
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("install.sh refuses a channel install when Hands is unavailable instead of falling back to the CDN pointer", async (t) => {
  if (!posixInstallerHostSupported(t)) return;

  const root = await mkdtemp(resolve(tmpdir(), "raft-computer-install-hands-down-"));
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    res.statusCode = 503;
    res.end("release authority unavailable");
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const target = `${process.platform}-${process.arch}`;
    const env = await handsSelectionEnv(root, target, {
      RAFT_COMPUTER_RELEASE_BACKEND: "legacy-cdn",
      RAFT_COMPUTER_RELEASE_BASE: "https://must-not-be-read.invalid",
      RAFT_COMPUTER_HANDS_ORIGIN: `http://127.0.0.1:${address.port}`,
      RAFT_COMPUTER_HANDS_APP: "test-app",
    });
    await assert.rejects(
      execFileAsync("sh", [installScriptPath], { env }),
      (error: { stderr?: string }) => {
        assert.match(error.stderr ?? "", /refusing to install without the release authority/);
        assert.doesNotMatch(
          error.stderr ?? "",
          /must-not-be-read\.invalid/,
          "the refusal must happen before any CDN read is attempted",
        );
        return true;
      },
    );
    assert.equal(requests.length, 1, "the installer must not retry the release authority");
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(root, { recursive: true, force: true });
  }
});

test("install.sh re-install honors the persisted alpha channel when no channel env is set", async (t) => {
  if (!posixInstallerHostSupported(t)) return;

  const root = await mkdtemp(resolve(tmpdir(), "raft-computer-install-hands-alpha-"));
  const version = "0.0.1-test";
  const target = `${process.platform}-${process.arch}`;
  const release = await writePosixReleaseFixture(root, version, target);
  const hands = await startHandsFixture({ appSlug: "test-app", channel: "alpha", version, assets: [release.asset] });
  try {
    const channelDir = resolve(root, "home", "computer");
    await mkdir(channelDir, { recursive: true });
    await writeFile(resolve(channelDir, "channel"), "alpha\n");
    const env = await handsSelectionEnv(root, target, {
      RAFT_COMPUTER_HANDS_ORIGIN: hands.origin,
      RAFT_COMPUTER_HANDS_APP: "test-app",
    });
    await execFileAsync("sh", [installScriptPath], { env });

    assert.ok(existsSync(resolve(root, "user-home", ".local", "bin", "raft-computer")));
    assert.deepEqual(hands.requests, ["/public/v2/apps/test-app/latest?channel=alpha&product_type=cli-binary"]);
    assert.equal((await readFile(resolve(channelDir, "channel"), "utf8")).trim(), "alpha");
  } finally {
    await hands.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("install.sh explicit legacy-CDN pinned channel supports offline custom releases", async (t) => {
  if (!posixInstallerHostSupported(t)) return;

  const root = await mkdtemp(resolve(tmpdir(), "raft-computer-install-hands-pinned-"));
  const version = "0.0.1-test";
  const target = `${process.platform}-${process.arch}`;
  try {
    await writePosixReleaseFixture(root, version, target);
    const env = await handsSelectionEnv(root, target, {
      // Any Hands contact would fail the install, so success proves zero calls.
      RAFT_COMPUTER_HANDS_ORIGIN: "https://must-not-be-read.invalid",
      RAFT_COMPUTER_INSTALL_CHANNEL: `pinned:${version}`,
    });
    await execFileAsync("sh", [installScriptPath], { env });

    assert.ok(existsSync(resolve(root, "user-home", ".local", "bin", "raft-computer")));
    assert.equal(
      (await readFile(resolve(root, "home", "computer", "channel"), "utf8")).trim(),
      `pinned:${version}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("install.ps1 rejects an explicitly empty version before env or Hands fallback", async (t) => {
  if (process.platform !== "win32") {
    t.skip();
    return;
  }

  const root = await mkdtemp(resolve(tmpdir(), "raft-computer-install-win-empty-version-"));
  try {
    const home = resolve(root, "home");
    const tempDir = resolve(root, "temp");
    await mkdir(home, { recursive: true });
    await mkdir(tempDir, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      USERPROFILE: home,
      TEMP: tempDir,
      TMP: tempDir,
      RAFT_COMPUTER_VERSION: "9.9.9",
      RAFT_COMPUTER_RELEASE_BACKEND: "legacy-cdn",
      RAFT_COMPUTER_RELEASE_BASE: "https://must-not-be-read.invalid",
      RAFT_COMPUTER_HANDS_ORIGIN: "https://must-not-be-read.invalid",
      RAFT_COMPUTER_NO_MODIFY_PATH: "1",
    };
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === "psmodulepath") delete env[key];
    }

    for (const supplied of ["", "   "]) {
      await assert.rejects(
        execFileAsync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            windowsInstallScriptPath,
            "-Version",
            supplied,
          ],
          { env },
        ),
        (error: { stdout?: string; stderr?: string }) => {
          const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
          assert.match(output, /invalid -Version: expected a SemVer value/);
          assert.doesNotMatch(output, /resolving the active/);
          assert.doesNotMatch(output, /must-not-be-read\.invalid/);
          return true;
        },
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("install.ps1 -Channel main overrides the environment and persists latest on Windows", async (t) => {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch)) {
    t.skip();
    return;
  }

  const root = await mkdtemp(resolve(tmpdir(), "raft-computer-install-win-hands-"));
  const binary = await readFile(process.execPath);
  const compressed = gzipSync(binary);
  const photonWasm = Buffer.from("fixture photon wasm\n");
  const version = process.versions.node;
  const target = `win32-${process.arch}`;
  const file = `raft-computer-${target}.exe`;
  const manifest = JSON.stringify({
    name: "raft-computer",
    version,
    photonWasm: {
      file: "photon_rs_bg.wasm",
      sha256: createHash("sha256").update(photonWasm).digest("hex"),
      size: photonWasm.length,
    },
    targets: {
      [target]: {
        file,
        sha256: createHash("sha256").update(binary).digest("hex"),
        size: binary.length,
        gz: {
          file: `${file}.gz`,
          sha256: createHash("sha256").update(compressed).digest("hex"),
          size: compressed.length,
        },
      },
    },
  });
  const handsRequests: string[] = [];
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/public/")) handsRequests.push(req.url);
    if (req.url === "/public/v2/apps/test-app/latest?channel=main&product_type=cli-binary") {
      res.setHeader("content-type", "application/json");
      res.end(handsLatestBody(version, "main", [
        handsAssetForTarget(target, createHash("sha256").update(binary).digest("hex"), binary.length),
      ]));
      return;
    }
    if (req.url === `/${version}/manifest.json`) {
      res.setHeader("content-type", "application/json");
      res.end(manifest);
      return;
    }
    if (req.url === `/${version}/${file}.gz`) {
      res.setHeader("content-type", "application/gzip");
      res.end(compressed);
      return;
    }
    if (req.url === `/${version}/photon_rs_bg.wasm`) {
      res.setHeader("content-type", "application/wasm");
      res.end(photonWasm);
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });

  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const home = resolve(root, "home");
    const installDir = resolve(home, ".local", "bin");
    const slockHome = resolve(home, ".slock");
    const tempDir = resolve(root, "temp");
    const preload = await writeNodeSupervisorPreload(root);
    const supervisorLog = resolve(root, "supervisor.log");
    await mkdir(home, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      USERPROFILE: home,
      TEMP: tempDir,
      TMP: tempDir,
      SLOCK_HOME: slockHome,
      RAFT_COMPUTER_INSTALL_DIR: installDir,
      RAFT_COMPUTER_RELEASE_BACKEND: "legacy-cdn",
      RAFT_COMPUTER_RELEASE_BASE: `http://127.0.0.1:${address.port}`,
      RAFT_COMPUTER_HANDS_ORIGIN: `http://127.0.0.1:${address.port}`,
      RAFT_COMPUTER_HANDS_APP: "test-app",
      RAFT_COMPUTER_INSTALL_CHANNEL: "alpha",
      RAFT_COMPUTER_NO_MODIFY_PATH: "1",
      NODE_OPTIONS: nodeOptionsWithPreload(preload),
      RAFT_TEST_SUPERVISOR_LOG: supervisorLog,
    };
    delete env.RAFT_COMPUTER_VERSION;
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === "psmodulepath") delete env[key];
    }
    await mkdir(tempDir, { recursive: true });

    const run = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        windowsInstallScriptPath,
        "-Channel",
        "main",
      ],
      { env },
    );

    assert.ok(existsSync(resolve(installDir, "raft-computer.exe")));
    assert.deepEqual(handsRequests, ["/public/v2/apps/test-app/latest?channel=main&product_type=cli-binary"]);
    assert.match(run.stdout, /resolving the active main release from Hands \(test-app\)/);
    assert.match(run.stdout, /installed to/);
    assert.equal(
      (await readFile(resolve(slockHome, "computer", "channel"), "utf8")).trim(),
      "latest",
      "the public main option must persist the updater's existing latest token",
    );
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(root, { recursive: true, force: true });
  }
});

test("install.ps1 refuses Hands/CDN identity drift before downloading assets on Windows", async (t) => {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch)) {
    t.skip();
    return;
  }

  const cases: Array<{
    name: string;
    assets: (asset: HandsLatestAsset) => HandsLatestAsset[];
    error: RegExp;
  }> = [
    {
      name: "sha mismatch",
      assets: (asset) => [{ ...asset, sha256: "0".repeat(64) }],
      error: /Hands\/CDN identity mismatch/u,
    },
    {
      name: "size mismatch",
      assets: (asset) => [{ ...asset, size_bytes: asset.size_bytes + 1 }],
      error: /Hands\/CDN identity mismatch/u,
    },
    {
      name: "missing platform asset",
      assets: () => [],
      error: /must carry exactly one raw asset/u,
    },
  ];

  for (const scenario of cases) {
    await runNamedCase(scenario.name, async () => {
      const root = await mkdtemp(resolve(tmpdir(), "raft-computer-install-win-hands-drift-"));
      const binary = await readFile(process.execPath);
      const photonWasm = Buffer.from("fixture photon wasm\n");
      const version = process.versions.node;
      const target = `win32-${process.arch}`;
      const file = `raft-computer-${target}.exe`;
      const sha256 = createHash("sha256").update(binary).digest("hex");
      const manifest = JSON.stringify({
        name: "raft-computer",
        version,
        photonWasm: {
          file: "photon_rs_bg.wasm",
          sha256: createHash("sha256").update(photonWasm).digest("hex"),
          size: photonWasm.length,
        },
        targets: {
          [target]: {
            file,
            sha256,
            size: binary.length,
          },
        },
      });
      const handsAsset = handsAssetForTarget(target, sha256, binary.length);
      const requests: string[] = [];
      const server = createServer((req, res) => {
        requests.push(req.url ?? "");
        if (req.url === "/public/v2/apps/test-app/latest?channel=main&product_type=cli-binary") {
          res.setHeader("content-type", "application/json");
          res.end(handsLatestBody(version, "main", scenario.assets(handsAsset)));
          return;
        }
        if (req.url === `/${version}/manifest.json`) {
          res.setHeader("content-type", "application/json");
          res.end(manifest);
          return;
        }
        res.statusCode = 500;
        res.end("asset download must not happen");
      });
      try {
        await new Promise<void>((resolveListen, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolveListen);
        });
        const address = server.address();
        assert.ok(address && typeof address === "object");
        const home = resolve(root, "home");
        const tempDir = resolve(root, "temp");
        await mkdir(home, { recursive: true });
        await mkdir(tempDir, { recursive: true });
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          USERPROFILE: home,
          TEMP: tempDir,
          TMP: tempDir,
          SLOCK_HOME: resolve(home, ".slock"),
          RAFT_COMPUTER_INSTALL_DIR: resolve(home, ".local", "bin"),
          RAFT_COMPUTER_RELEASE_BACKEND: "legacy-cdn",
          RAFT_COMPUTER_RELEASE_BASE: `http://127.0.0.1:${address.port}`,
          RAFT_COMPUTER_HANDS_ORIGIN: `http://127.0.0.1:${address.port}`,
          RAFT_COMPUTER_HANDS_APP: "test-app",
          RAFT_COMPUTER_NO_MODIFY_PATH: "1",
        };
        delete env.RAFT_COMPUTER_VERSION;
        delete env.RAFT_COMPUTER_INSTALL_CHANNEL;
        for (const key of Object.keys(env)) {
          if (key.toLowerCase() === "psmodulepath") delete env[key];
        }

        await assert.rejects(
          execFileAsync(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", windowsInstallScriptPath],
            { env },
          ),
          (error: { stderr?: string }) => {
            assert.match(error.stderr ?? "", scenario.error);
            assert.match(error.stderr ?? "", /Refusing before download/u);
            return true;
          },
        );
        assert.deepEqual(requests, [
          "/public/v2/apps/test-app/latest?channel=main&product_type=cli-binary",
          `/${version}/manifest.json`,
        ]);
        assert.equal(existsSync(resolve(home, ".local", "bin")), false);
      } finally {
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("install.ps1 refuses a channel install when Hands is unavailable instead of falling back to the CDN pointer", async (t) => {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch)) {
    t.skip();
    return;
  }

  const root = await mkdtemp(resolve(tmpdir(), "raft-computer-install-win-hands-down-"));
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    res.statusCode = 503;
    res.end("release authority unavailable");
  });
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const home = resolve(root, "home");
    const tempDir = resolve(root, "temp");
    await mkdir(home, { recursive: true });
    await mkdir(tempDir, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      USERPROFILE: home,
      TEMP: tempDir,
      TMP: tempDir,
      SLOCK_HOME: resolve(home, ".slock"),
      RAFT_COMPUTER_INSTALL_DIR: resolve(home, ".local", "bin"),
      RAFT_COMPUTER_RELEASE_BACKEND: "legacy-cdn",
      RAFT_COMPUTER_RELEASE_BASE: "https://must-not-be-read.invalid",
      RAFT_COMPUTER_HANDS_ORIGIN: `http://127.0.0.1:${address.port}`,
      RAFT_COMPUTER_HANDS_APP: "test-app",
      RAFT_COMPUTER_NO_MODIFY_PATH: "1",
    };
    delete env.RAFT_COMPUTER_VERSION;
    delete env.RAFT_COMPUTER_INSTALL_CHANNEL;
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === "psmodulepath") delete env[key];
    }

    await assert.rejects(
      execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", windowsInstallScriptPath],
        { env },
      ),
      (error: { stderr?: string }) => {
        assert.match(error.stderr ?? "", /Refusing to install without the release authority/);
        assert.doesNotMatch(
          error.stderr ?? "",
          /must-not-be-read\.invalid/,
          "the refusal must happen before any CDN read is attempted",
        );
        return true;
      },
    );
    assert.equal(requests.length, 1, "the installer must not retry the release authority");
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(root, { recursive: true, force: true });
  }
});

test("pinned installer requires Hands identity and rejects CDN drift", async (t) => {
  if (!posixInstallerHostSupported(t)) return;
  for (const drift of [false, true]) {
    const root = await mkdtemp(resolve(tmpdir(), "audit-pinned-installer-"));
    const version = "0.0.1-test";
    const target = `${process.platform}-${process.arch}`;
    const fixture = await writePosixReleaseFixture(root, version, target);
    const hands = await startHandsFixture({ appSlug: "test-app", channel: `pinned:${version}`, version,
      assets: [{ ...fixture.asset, ...(drift ? { sha256: "0".repeat(64) } : {}) }],
    });
    try {
      const env = await handsSelectionEnv(root, target, { RAFT_COMPUTER_VERSION: version,
        RAFT_COMPUTER_RELEASE_BACKEND: "hands", RAFT_COMPUTER_HANDS_ORIGIN: hands.origin,
        RAFT_COMPUTER_HANDS_APP: "test-app" });
      const install = execFileAsync("sh", [installScriptPath], { env });
      if (drift) {
        await assert.rejects(install, /Hands\/CDN identity mismatch/);
        assert.equal(existsSync(resolve(root, "user-home", ".local", "bin", "raft-computer")), false);
      } else await install;
      assert.equal(hands.requests.length, 1);
      const request = new URL(hands.requests[0]!, hands.origin);
      assert.equal(request.pathname, "/public/v2/apps/test-app/updates/check");
      assert.equal(request.searchParams.get("version"), version);
      assert.equal(request.searchParams.get("platform"), process.platform);
      assert.equal(request.searchParams.get("arch"), process.arch);
    } finally { await hands.close(); await rm(root, { recursive: true, force: true }); }
  }
});
