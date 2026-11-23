// OpenCode detection from OAR's installation (readOpenCodeInstallation): the
// runtime inventory, Raft's version range on top, and the Windows npm shim
// `npm i -g @opencode/cli` writes (`SET dp0=%~dp0`, `"%dp0%\...\opencode.exe"`),
// which Raft's own lookup could not see. The last test runs OAR for real: a
// POSIX script, or on Windows (the Windows contract job) that exact npm shim.
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InstallationProbeOptions, InstallationSnapshot } from "@botiverse/oar";
import { lookupCommandOnPathAsync } from "./probe";
import { OpenCodeDriver, probeOpenCodeInstallation, readOpenCodeInstallation, readOpenCodeVersionDetailedAsync, resolveOpenCodeSpawnAsync } from "./opencode";

const NPM_PREFIX = "C:\\Users\\tester\\AppData\\Roaming\\npm";
const NPM_SHIM_INSTALLATION: InstallationSnapshot = { kind: "available", via: "executable", command: `${NPM_PREFIX}\\opencode.cmd`, version: "opencode v2.3.0" };

test("an npm @opencode/cli install OAR finds on Windows is detected, with its version", async () => {
  const driver = new OpenCodeDriver({ readInstallation: async () => NPM_SHIM_INSTALLATION });
  assert.deepEqual(await driver.probeAsync(), { available: true, version: "opencode v2.3.0" });
  // 1.x keeps working the same way.
  assert.deepEqual(
    await probeOpenCodeInstallation(async () => ({ kind: "available", via: "executable", command: "/usr/local/bin/opencode", version: "1.18.35" })),
    { available: true, version: "1.18.35" },
  );
});

test("not found is not_installed; a found CLI whose --version could not run is probe_failed, with no path in the diagnostic", async () => {
  assert.deepEqual(await probeOpenCodeInstallation(async () => ({ kind: "not_found" })), { available: false, unavailableReason: "not_installed" });
  const failed = await probeOpenCodeInstallation(async () => {
    throw Object.assign(new Error(`Failed to run ${NPM_PREFIX}\\opencode.cmd --version`), { code: "ETIMEDOUT" });
  });
  assert.equal(failed.available, false);
  assert.equal(failed.unavailableReason, "probe_failed");
  assert.match(failed.diagnostic ?? "", /ETIMEDOUT/);
  assert.ok(!(failed.diagnostic ?? "").includes("tester"), failed.diagnostic);
  // A version it cannot read stays available, as Raft's own probe reported it.
  assert.deepEqual(await probeOpenCodeInstallation(async () => ({ kind: "available", via: "executable", command: "/usr/local/bin/opencode" })), { available: true });
});

test("Raft's supported range still applies to OAR's version: too old, an early 2.0 beta, or 3.x is unsupported_version", async () => {
  for (const version of ["1.14.20", "opencode v2.0.26", "opencode v3.0.1"]) {
    const result = await probeOpenCodeInstallation(async () => ({ kind: "available", via: "executable", command: "/usr/local/bin/opencode", version }));
    assert.equal(result.available, false, version);
    assert.equal(result.unavailableReason, "unsupported_version", version);
    assert.match(result.version ?? "", /requires >= 1\.14\.30 \(1\.x\) or >= 2\.0\.27/, version);
  }
  const refused = await probeOpenCodeInstallation(async () => ({ kind: "unsupported", code: "version_unsupported", via: "executable", command: "/usr/local/bin/opencode", reason: "too old", installedVersion: "1.0.0" }));
  assert.equal(refused.unavailableReason, "unsupported_version");
});

test("on Windows OAR looks OpenCode up on the PATH refreshed from the registry, so a CLI installed after the Computer started is found", async () => {
  const seen: Array<InstallationProbeOptions | undefined> = [];
  const installation = await readOpenCodeInstallation({
    platform: "win32",
    env: { PATH: "C:\\Windows\\System32", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    windowsEnvironmentReaderFn: () => ({ user: { Path: NPM_PREFIX } }),
    loadRuntime: async () => ({ installation: async (options) => { seen.push(options); return NPM_SHIM_INSTALLATION; } }),
  });
  assert.deepEqual(installation, NPM_SHIM_INSTALLATION);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.env?.PATH, `C:\\Windows\\System32;${NPM_PREFIX}`);
  assert.equal(seen[0]?.env?.PATHEXT, ".COM;.EXE;.BAT;.CMD");
});

test("OAR for real: the installation found on PATH and its --version (on Windows, through the npm @opencode/cli shim)", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "oc-oar-installation-"));
  try {
    if (process.platform === "win32") {
      // What `npm i -g @opencode/cli` writes: a cmd shim naming the package's
      // native binary relative to `%dp0%`. node.exe stands in for opencode.exe.
      const bin = path.join(dir, "node_modules", "@opencode", "cli", "bin");
      mkdirSync(bin, { recursive: true });
      copyFileSync(process.execPath, path.join(bin, "opencode.exe"));
      writeFileSync(path.join(dir, "opencode.cmd"), [
        "@ECHO off",
        "GOTO start",
        ":find_dp0",
        "SET dp0=%~dp0",
        "EXIT /b",
        ":start",
        "SETLOCAL",
        "CALL :find_dp0",
        "\"%dp0%\\node_modules\\@opencode\\cli\\bin\\opencode.exe\"   %*",
        "",
      ].join("\r\n"));
      const installation = await readOpenCodeInstallation({
        platform: "win32",
        env: { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD", USERPROFILE: dir, HOME: dir },
        windowsEnvironmentReaderFn: () => null,
      });
      assert.equal(installation.kind, "available");
      assert.ok(installation.kind === "available" && installation.via === "executable", JSON.stringify(installation));
      assert.equal(installation.command.toLowerCase(), path.join(dir, "opencode.cmd").toLowerCase());
      assert.equal(installation.version, process.version, "the shim's native target ran");
      // The legacy driver, which OpenCode still runs on under Windows, launches
      // the same install: the package's opencode.exe beside the shim, directly.
      // Its PATH lookup starts Windows PowerShell (Get-Command), which needs the
      // environment a real Computer has: with only PATH/PATHEXT/USERPROFILE set it
      // starts slower than the 5 s lookup budget and the lookup comes back empty.
      // So this runs on the runner's own environment, with the shim's directory
      // first on PATH.
      const ambient = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"));
      const winDeps = {
        platform: "win32" as const,
        env: { ...ambient, PATH: [dir, process.env.Path ?? process.env.PATH ?? ""].join(";") },
        windowsEnvironmentReaderFn: () => null,
      };
      // The lookup alone first, so a miss says why (probe_timeout, probe_failed...).
      const lookup = await lookupCommandOnPathAsync("opencode", winDeps);
      assert.equal(lookup.command?.toLowerCase(), path.join(dir, "opencode.cmd").toLowerCase(), JSON.stringify({ missReason: lookup.missReason, timing: lookup.timing }));
      const spec = await resolveOpenCodeSpawnAsync([], winDeps);
      assert.equal(spec.command.toLowerCase(), path.join(bin, "opencode.exe").toLowerCase());
      const read = await readOpenCodeVersionDetailedAsync(winDeps);
      assert.deepEqual(read, { kind: "version", version: process.version });
      return;
    }
    const opencode = path.join(dir, "opencode");
    writeFileSync(opencode, "#!/bin/sh\necho 'opencode v2.3.0'\n");
    chmodSync(opencode, 0o755);
    const installation = await readOpenCodeInstallation({ env: { PATH: dir, HOME: dir } });
    assert.deepEqual(installation, { kind: "available", via: "executable", command: opencode, version: "opencode v2.3.0" });
    assert.deepEqual(await readOpenCodeInstallation({ env: { PATH: path.join(dir, "empty"), HOME: dir } }), { kind: "not_found" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
