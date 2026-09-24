import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";

import {
  buildMacosLoginCarrierSpec,
  convergeAppHostLifecycle,
  convergeCliHostLifecycle,
  readHostLifecycleMarker,
  readHostLifecycleRecoveryStatus,
  refreshCliLoginCarrierIfOwned,
  removeHostLifecycle,
  type HostLifecycleCommandRunner,
} from "./macosLoginCarrier.js";
import { buildStatusReport } from "./status.js";
import { runDoctorChecks } from "./doctor.js";

function launchctlHarness() {
  const jobs = new Map<string, string>();
  const calls: string[][] = [];
  const run: HostLifecycleCommandRunner = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "/usr/bin/plutil") {
      assert.deepEqual(args.slice(0, 5), [
        "-extract",
        "CFBundleIdentifier",
        "raw",
        "-o",
        "-",
      ]);
      const raw = await readFile(args[5]!, "utf8");
      const bundleId = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/u.exec(raw)?.[1];
      if (!bundleId) throw new Error("bundle id missing");
      return { stdout: `${bundleId}\n`, stderr: "" };
    }
    assert.equal(command, "/bin/launchctl");
    if (args[0] === "print" && args.length === 2 && /^gui\/\d+$/.test(args[1]!)) {
      return { stdout: `${args[1]} = { type = domain }\n`, stderr: "" };
    }
    if (args[0] === "bootstrap") {
      const definition = await readFile(args[2]!, "utf8");
      const label = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/u.exec(definition)?.[1];
      assert.ok(label);
      jobs.set(`${args[1]}/${label}`, definition);
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "bootout") {
      jobs.delete(args[1]!);
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "print" && args.length === 2) {
      const definition = jobs.get(args[1]!);
      if (!definition) throw new Error("job missing");
      return { stdout: `${args[1]} = { ${definition} }\n`, stderr: "" };
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
  return { calls, jobs, run };
}

test("macOS CLI login carrier is a distinct RunAtLoad job without KeepAlive or retired argv", async () => {
  const spec = buildMacosLoginCarrierSpec({
    slockHome: "/Users/example/.slock",
    dispatcherPath: "/Users/example/.local/bin/raft-computer",
    userHome: "/Users/example",
    uid: 501,
  });
  assert.match(spec.label, /^build\.raft\.computer\.login\.[0-9a-f]{16}$/u);
  assert.deepEqual(spec.args, ["__service", "--slock-home", "/Users/example/.slock"]);
  assert.match(spec.definition, /<key>RunAtLoad<\/key>\s*<true\/>/u);
  assert.doesNotMatch(spec.definition, /<key>KeepAlive<\/key>/u);
  assert.doesNotMatch(spec.definition, /--os-supervised|RAFT_COMPUTER_SUPERVISOR_OWNER/u);
});

test("markerless CLI-only Mac with no Desktop claims exactly one carrier", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-carrier-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const dispatcherPath = path.join(home, ".local", "bin", "raft-computer");
  const harness = launchctlHarness();
  try {
    const result = await convergeCliHostLifecycle(slockHome, "enabled", {
      platform: "darwin",
      userHome: home,
      uid: 501,
      dispatcherPath,
      legacyDesktopBundlePath: path.join(root, "Applications", "Raft Computer.app"),
      runCommand: harness.run,
    });
    assert.equal(result.owner, "cli");
    assert.equal(result.enabled, true);
    assert.equal(harness.jobs.size, 1);
    const marker = await readHostLifecycleMarker(slockHome);
    assert.equal(marker?.owner, "cli");
    assert.equal(marker?.enabled, true);
    assert.equal(marker?.dispatcherPath, dispatcherPath);
    assert.equal(await readFile(result.definitionPath!, "utf8"), result.definition);
    const markerMode = (await stat(path.join(slockHome, "computer", "host-lifecycle-owner.json"))).mode & 0o777;
    assert.equal(markerMode, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("markerless legacy Desktop install leaves ownership unknown with zero launchd mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-legacy-app-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const legacyDesktopBundlePath = path.join(root, "Applications", "Raft Computer.app");
  const infoPlistPath = path.join(legacyDesktopBundlePath, "Contents", "Info.plist");
  const harness = launchctlHarness();
  try {
    await mkdir(path.dirname(infoPlistPath), { recursive: true });
    await writeFile(
      infoPlistPath,
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<plist><dict>",
        "<key>CFBundleIdentifier</key>",
        "<string>build.raft.computer-app</string>",
        "</dict></plist>",
      ].join("\n"),
    );
    await assert.rejects(
      convergeCliHostLifecycle(slockHome, "enabled", {
        platform: "darwin",
        userHome: home,
        uid: 501,
        dispatcherPath: path.join(home, ".local", "bin", "raft-computer"),
        legacyDesktopBundlePath,
        runCommand: harness.run,
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "HOST_LIFECYCLE_OWNER_AMBIGUOUS");
        assert.match((error as Error).message, /open or upgrade Raft Desktop/i);
        return true;
      },
    );
    assert.equal(
      harness.calls.filter(([command]) => command === "/bin/launchctl").length,
      0,
      "ownership ambiguity must stop before any launchd read or mutation",
    );
    assert.equal(harness.jobs.size, 0);
    const spec = buildMacosLoginCarrierSpec({
      slockHome,
      dispatcherPath: path.join(home, ".local", "bin", "raft-computer"),
      userHome: home,
      uid: 501,
    });
    await assert.rejects(readFile(spec.definitionPath, "utf8"), { code: "ENOENT" });
    assert.equal(await readHostLifecycleMarker(slockHome), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("markerless canonical Desktop anomalies fail before launchd or carrier files", async () => {
  for (const shape of ["identity-mismatch", "bundle-symlink", "contents-symlink", "plist-symlink"] as const) {
    const root = await mkdtemp(path.join(os.tmpdir(), `raft-macos-login-${shape}-`));
    const home = path.join(root, "user");
    const slockHome = path.join(home, ".slock");
    const bundlePath = path.join(root, "Applications", "Raft Computer.app");
    const realBundlePath = path.join(root, "Relocated.app");
    const targetPath = shape === "bundle-symlink" ? realBundlePath : bundlePath;
    const harness = launchctlHarness();
    try {
      const realContentsPath = shape === "contents-symlink"
        ? path.join(root, "RelocatedContents")
        : path.join(targetPath, "Contents");
      const realPlistPath = shape === "plist-symlink"
        ? path.join(root, "RelocatedInfo.plist")
        : path.join(realContentsPath, "Info.plist");
      await mkdir(realContentsPath, { recursive: true });
      await writeFile(
        realPlistPath,
        "<plist><dict><key>CFBundleIdentifier</key><string>example.invalid</string></dict></plist>\n",
      );
      if (shape === "bundle-symlink") {
        await mkdir(path.dirname(bundlePath), { recursive: true });
        await symlink(realBundlePath, bundlePath);
      } else if (shape === "contents-symlink") {
        await mkdir(bundlePath, { recursive: true });
        await symlink(realContentsPath, path.join(bundlePath, "Contents"));
      } else if (shape === "plist-symlink") {
        await symlink(realPlistPath, path.join(realContentsPath, "Info.plist"));
      }
      await assert.rejects(
        convergeCliHostLifecycle(slockHome, "enabled", {
          platform: "darwin",
          userHome: home,
          uid: 501,
          dispatcherPath: path.join(home, ".local", "bin", "raft-computer"),
          legacyDesktopBundlePath: bundlePath,
          runCommand: harness.run,
        }),
        (error: unknown) => {
          assert.equal(
            (error as { code?: string }).code,
            "HOST_LIFECYCLE_DESKTOP_IDENTITY_UNVERIFIED",
          );
          return true;
        },
      );
      assert.equal(harness.calls.length, shape === "identity-mismatch" ? 1 : 0);
      assert.equal(harness.jobs.size, 0);
      const spec = buildMacosLoginCarrierSpec({
        slockHome,
        dispatcherPath: path.join(home, ".local", "bin", "raft-computer"),
        userHome: home,
        uid: 501,
      });
      await assert.rejects(readFile(spec.definitionPath, "utf8"), { code: "ENOENT" });
      assert.equal(await readHostLifecycleMarker(slockHome), null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("registration failure is fail-closed and never publishes an enabled marker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-carrier-red-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const dispatcherPath = path.join(home, ".local", "bin", "raft-computer");
  const run: HostLifecycleCommandRunner = async (_command, args) => {
    if (args[0] === "print" && args[1] === "gui/501") return { stdout: "domain", stderr: "" };
    throw new Error("bootstrap denied");
  };
  try {
    await assert.rejects(
      convergeCliHostLifecycle(slockHome, "enabled", {
        platform: "darwin",
        userHome: home,
        uid: 501,
        dispatcherPath,
        legacyDesktopBundlePath: path.join(root, "Applications", "Raft Computer.app"),
        runCommand: run,
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "HOST_LIFECYCLE_REGISTRATION_FAILED");
        return true;
      },
    );
    assert.equal(await readHostLifecycleMarker(slockHome), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("live readback mismatch removes the unverified job and definition before failing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-readback-red-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const dispatcherPath = path.join(home, ".local", "bin", "raft-computer");
  const harness = launchctlHarness();
  const spec = buildMacosLoginCarrierSpec({
    slockHome,
    dispatcherPath,
    userHome: home,
    uid: 501,
  });
  try {
    await assert.rejects(
      convergeCliHostLifecycle(slockHome, "enabled", {
        platform: "darwin",
        userHome: home,
        uid: 501,
        dispatcherPath,
        legacyDesktopBundlePath: path.join(root, "Applications", "Raft Computer.app"),
        runCommand: async (command, args) => {
          if (
            args[0] === "print"
            && args[1] === `${spec.domain}/${spec.label}`
            && harness.jobs.has(args[1])
          ) {
            return { stdout: `${spec.label} = { unexpected program }`, stderr: "" };
          }
          return harness.run(command, args);
        },
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "HOST_LIFECYCLE_READBACK_FAILED");
        return true;
      },
    );
    assert.equal(harness.jobs.size, 0);
    await assert.rejects(readFile(spec.definitionPath, "utf8"), { code: "ENOENT" });
    assert.equal(await readHostLifecycleMarker(slockHome), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refresh replacement failure restores the last verified CLI carrier and propagates failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-replace-red-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const harness = launchctlHarness();
  const baseDeps = {
    platform: "darwin" as const,
    userHome: home,
    uid: 501,
    dispatcherPath: path.join(home, ".local", "bin", "raft-computer"),
    legacyDesktopBundlePath: path.join(root, "Applications", "Raft Computer.app"),
    runCommand: harness.run,
  };
  try {
    await convergeCliHostLifecycle(slockHome, "enabled", baseDeps);
    const previousMarker = await readHostLifecycleMarker(slockHome);
    const previousDefinition = await readFile(previousMarker!.definitionPath!, "utf8");
    let rejectedReplacement = false;
    let anchorObservedBeforeBootout = false;
    await assert.rejects(
      refreshCliLoginCarrierIfOwned(slockHome, {
        ...baseDeps,
        dispatcherPath: path.join(home, ".local", "bin", "raft-computer-next"),
        runCommand: async (command, args) => {
          if (args[0] === "bootout" && !anchorObservedBeforeBootout) {
            const anchorPath = path.join(
              slockHome,
              "computer",
              "host-lifecycle-pending-replace.json",
            );
            assert.equal((await stat(anchorPath)).mode & 0o777, 0o600);
            assert.equal((await readHostLifecycleRecoveryStatus(slockHome))?.status, "pending-replace");
            assert.equal(await readHostLifecycleMarker(slockHome), null);
            anchorObservedBeforeBootout = true;
          }
          if (args[0] === "bootstrap" && !rejectedReplacement) {
            assert.equal(await readHostLifecycleMarker(slockHome), null);
            rejectedReplacement = true;
            throw new Error("bootstrap denied");
          }
          return harness.run(command, args);
        },
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "HOST_LIFECYCLE_REGISTRATION_FAILED");
        return true;
      },
    );
    assert.equal(anchorObservedBeforeBootout, true);
    assert.deepEqual(await readHostLifecycleMarker(slockHome), previousMarker);
    assert.equal(await readFile(previousMarker!.definitionPath!, "utf8"), previousDefinition);
    assert.equal(harness.jobs.size, 1);
    assert.ok([...harness.jobs.values()][0]!.includes(previousMarker!.dispatcherPath!));
    assert.equal(await readHostLifecycleRecoveryStatus(slockHome), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refresh readback mismatch rolls back the prior job, definition, and owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-readback-rollback-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const harness = launchctlHarness();
  const baseDeps = {
    platform: "darwin" as const,
    userHome: home,
    uid: 501,
    dispatcherPath: path.join(home, ".local", "bin", "raft-computer"),
    legacyDesktopBundlePath: path.join(root, "Applications", "Raft Computer.app"),
    runCommand: harness.run,
  };
  try {
    await convergeCliHostLifecycle(slockHome, "enabled", baseDeps);
    const previousMarker = await readHostLifecycleMarker(slockHome);
    const previousDefinition = await readFile(previousMarker!.definitionPath!, "utf8");
    await assert.rejects(
      refreshCliLoginCarrierIfOwned(slockHome, {
        ...baseDeps,
        dispatcherPath: path.join(home, ".local", "bin", "raft-computer-next"),
        runCommand: async (command, args, signal) => {
          if (
            args[0] === "print"
            && args[1]?.includes("build.raft.computer.login.")
            && [...harness.jobs.values()][0]?.includes("raft-computer-next")
          ) {
            return { stdout: "unexpected live job", stderr: "" };
          }
          return harness.run(command, args, signal);
        },
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "HOST_LIFECYCLE_READBACK_FAILED");
        return true;
      },
    );
    assert.deepEqual(await readHostLifecycleMarker(slockHome), previousMarker);
    assert.equal(await readFile(previousMarker!.definitionPath!, "utf8"), previousDefinition);
    assert.equal(harness.jobs.size, 1);
    assert.ok([...harness.jobs.values()][0]!.includes(previousMarker!.dispatcherPath!));
    assert.equal(await readHostLifecycleRecoveryStatus(slockHome), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rollback failure removes the enabled marker and surfaces one durable degraded receipt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-rollback-red-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const harness = launchctlHarness();
  const baseDeps = {
    platform: "darwin" as const,
    userHome: home,
    uid: 501,
    dispatcherPath: path.join(home, ".local", "bin", "raft-computer"),
    legacyDesktopBundlePath: path.join(root, "Applications", "Raft Computer.app"),
    runCommand: harness.run,
  };
  try {
    await convergeCliHostLifecycle(slockHome, "enabled", baseDeps);
    await assert.rejects(
      refreshCliLoginCarrierIfOwned(slockHome, {
        ...baseDeps,
        dispatcherPath: path.join(home, ".local", "bin", "raft-computer-next"),
        runCommand: async (command, args, signal) => {
          if (args[0] === "bootstrap") throw new Error("all replacement bootstraps denied");
          return harness.run(command, args, signal);
        },
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "HOST_LIFECYCLE_ROLLBACK_FAILED");
        return true;
      },
    );
    assert.equal(await readHostLifecycleMarker(slockHome), null);
    assert.equal((await readHostLifecycleRecoveryStatus(slockHome))?.status, "degraded");
    assert.equal(
      (await stat(path.join(slockHome, "computer", "host-lifecycle-pending-replace.json"))).mode & 0o777,
      0o600,
    );
    const status = await buildStatusReport(slockHome);
    assert.equal(status.hostLifecycle?.status, "degraded");
    const doctor = await runDoctorChecks(slockHome);
    assert.ok(
      doctor.some((check) => check.name === "macOS login carrier" && !check.ok),
      "doctor must consume the same durable degraded receipt",
    );
    await refreshCliLoginCarrierIfOwned(slockHome, baseDeps);
    assert.equal((await readHostLifecycleMarker(slockHome))?.dispatcherPath, baseDeps.dispatcherPath);
    assert.equal(await readHostLifecycleRecoveryStatus(slockHome), null);
    assert.equal(harness.jobs.size, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("insufficient shared deadline refuses replacement before anchor, marker, job, or definition mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-budget-red-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const harness = launchctlHarness();
  const baseDeps = {
    platform: "darwin" as const,
    userHome: home,
    uid: 501,
    dispatcherPath: path.join(home, ".local", "bin", "raft-computer"),
    legacyDesktopBundlePath: path.join(root, "Applications", "Raft Computer.app"),
    runCommand: harness.run,
  };
  try {
    await convergeCliHostLifecycle(slockHome, "enabled", baseDeps);
    const marker = await readHostLifecycleMarker(slockHome);
    const definition = await readFile(marker!.definitionPath!, "utf8");
    const callsBefore = harness.calls.length;
    await assert.rejects(
      refreshCliLoginCarrierIfOwned(slockHome, {
        ...baseDeps,
        dispatcherPath: path.join(home, ".local", "bin", "raft-computer-next"),
        deadlineAtMs: 11_999,
        now: () => 0,
      }),
      (error: unknown) => {
        assert.equal(
          (error as { code?: string }).code,
          "HOST_LIFECYCLE_REFRESH_BUDGET_INSUFFICIENT",
        );
        return true;
      },
    );
    assert.equal(
      harness.calls.slice(callsBefore).some(([, action]) => action === "bootout" || action === "bootstrap"),
      false,
    );
    assert.deepEqual(await readHostLifecycleMarker(slockHome), marker);
    assert.equal(await readFile(marker!.definitionPath!, "utf8"), definition);
    assert.equal(harness.jobs.size, 1);
    assert.equal(await readHostLifecycleRecoveryStatus(slockHome), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replacement uses the deadline remainder minus rollback reserve and restores on timeout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-forward-timeout-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const harness = launchctlHarness();
  const baseDeps = {
    platform: "darwin" as const,
    userHome: home,
    uid: 501,
    dispatcherPath: path.join(home, ".local", "bin", "raft-computer"),
    legacyDesktopBundlePath: path.join(root, "Applications", "Raft Computer.app"),
    runCommand: harness.run,
  };
  try {
    await convergeCliHostLifecycle(slockHome, "enabled", baseDeps);
    const marker = await readHostLifecycleMarker(slockHome);
    const definition = await readFile(marker!.definitionPath!, "utf8");
    let scheduledMs: number | null = null;
    await assert.rejects(
      refreshCliLoginCarrierIfOwned(slockHome, {
        ...baseDeps,
        dispatcherPath: path.join(home, ".local", "bin", "raft-computer-next"),
        deadlineAtMs: 12_000,
        now: () => 0,
        setTimeoutFn: (fn, ms) => {
          scheduledMs = ms;
          queueMicrotask(fn);
          return Symbol("forward-deadline");
        },
        clearTimeoutFn: () => undefined,
        runCommand: async (command, args, signal) => {
          if (signal?.aborted) {
            const error = new Error("aborted") as NodeJS.ErrnoException;
            error.code = "ABORT_ERR";
            throw error;
          }
          return harness.run(command, args, signal);
        },
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "HOST_LIFECYCLE_REFRESH_TIMEOUT");
        return true;
      },
    );
    assert.equal(scheduledMs, 2_000);
    assert.deepEqual(await readHostLifecycleMarker(slockHome), marker);
    assert.equal(await readFile(marker!.definitionPath!, "utf8"), definition);
    assert.equal(harness.jobs.size, 1);
    assert.ok([...harness.jobs.values()][0]!.includes(marker!.dispatcherPath!));
    assert.equal(await readHostLifecycleRecoveryStatus(slockHome), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stop disables CLI post-login activation and start re-enables one job", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-toggle-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const harness = launchctlHarness();
  const deps = {
    platform: "darwin" as const,
    userHome: home,
    uid: 501,
    dispatcherPath: path.join(home, ".local", "bin", "raft-computer"),
    legacyDesktopBundlePath: path.join(root, "Applications", "Raft Computer.app"),
    runCommand: harness.run,
  };
  try {
    await convergeCliHostLifecycle(slockHome, "enabled", deps);
    await convergeCliHostLifecycle(slockHome, "disabled", deps);
    assert.equal(harness.jobs.size, 0);
    assert.equal((await readHostLifecycleMarker(slockHome))?.enabled, false);
    await refreshCliLoginCarrierIfOwned(slockHome, deps);
    assert.equal(harness.jobs.size, 0, "upgrade refresh must preserve an explicitly disabled carrier");
    await convergeCliHostLifecycle(slockHome, "enabled", deps);
    assert.equal(harness.jobs.size, 1);
    assert.equal((await readHostLifecycleMarker(slockHome))?.enabled, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("re-enabling an exact live CLI carrier is readback-only and does not restart it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-idempotent-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const harness = launchctlHarness();
  const deps = {
    platform: "darwin" as const,
    userHome: home,
    uid: 501,
    dispatcherPath: path.join(home, ".local", "bin", "raft-computer"),
    legacyDesktopBundlePath: path.join(root, "Applications", "Raft Computer.app"),
    runCommand: harness.run,
  };
  try {
    await convergeCliHostLifecycle(slockHome, "enabled", deps);
    const marker = await readHostLifecycleMarker(slockHome);
    const markerFile = path.join(slockHome, "computer", "host-lifecycle-owner.json");
    const markerMtime = (await stat(markerFile, { bigint: true })).mtimeNs;
    const definitionMtime = (
      await stat(marker!.definitionPath!, { bigint: true })
    ).mtimeNs;
    const bootstrapCount = harness.calls.filter((call) => call[1] === "bootstrap").length;
    await refreshCliLoginCarrierIfOwned(slockHome, deps);
    assert.equal(
      harness.calls.filter((call) => call[1] === "bootstrap").length,
      bootstrapCount,
    );
    assert.equal((await stat(markerFile, { bigint: true })).mtimeNs, markerMtime);
    assert.equal(
      (await stat(marker!.definitionPath!, { bigint: true })).mtimeNs,
      definitionMtime,
      "healthy refresh must not rewrite the definition",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a CLI-owned Mac ignores a later Desktop install and refreshes one existing carrier", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-known-cli-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const legacyDesktopBundlePath = path.join(root, "Applications", "Raft Computer.app");
  const harness = launchctlHarness();
  const deps = {
    platform: "darwin" as const,
    userHome: home,
    uid: 501,
    dispatcherPath: path.join(home, ".local", "bin", "raft-computer"),
    legacyDesktopBundlePath,
    runCommand: harness.run,
  };
  try {
    await convergeCliHostLifecycle(slockHome, "enabled", deps);
    const marker = await readHostLifecycleMarker(slockHome);
    const bootstrapCount = harness.calls.filter(([, action]) => action === "bootstrap").length;
    await mkdir(path.join(legacyDesktopBundlePath, "Contents"), { recursive: true });
    await writeFile(
      path.join(legacyDesktopBundlePath, "Contents", "Info.plist"),
      "<plist><dict><key>CFBundleIdentifier</key><string>build.raft.computer-app</string></dict></plist>\n",
    );

    await convergeCliHostLifecycle(slockHome, "enabled", deps);
    await refreshCliLoginCarrierIfOwned(slockHome, deps);

    assert.equal(harness.jobs.size, 1);
    assert.equal(
      harness.calls.filter(([, action]) => action === "bootstrap").length,
      bootstrapCount,
    );
    assert.deepEqual(await readHostLifecycleMarker(slockHome), marker);
    assert.equal(
      harness.calls.filter(([command]) => command === "/usr/bin/plutil").length,
      0,
      "known CLI ownership must bypass markerless Desktop ambiguity detection",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("App claim removes the CLI job before Electron set/get and preserves a single durable owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-owner-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const harness = launchctlHarness();
  const order: string[] = [];
  const deps = {
    platform: "darwin" as const,
    userHome: home,
    uid: 501,
    dispatcherPath: path.join(home, ".local", "bin", "raft-computer"),
    legacyDesktopBundlePath: path.join(root, "Applications", "Raft Computer.app"),
    runCommand: async (...args: Parameters<HostLifecycleCommandRunner>) => {
      if (args[1][0] === "bootout") order.push("bootout");
      return harness.run(...args);
    },
  };
  let openAtLogin = false;
  try {
    await convergeCliHostLifecycle(slockHome, "enabled", deps);
    await convergeAppHostLifecycle(slockHome, true, {
      ...deps,
      setOpenAtLogin: (enabled) => {
        order.push("set-electron");
        openAtLogin = enabled;
      },
      getOpenAtLogin: () => {
        order.push("get-electron");
        return openAtLogin;
      },
    });
    assert.ok(order.indexOf("bootout") < order.indexOf("set-electron"));
    assert.equal(harness.jobs.size, 0);
    assert.deepEqual(await readHostLifecycleMarker(slockHome), {
      formatVersion: 1,
      owner: "app",
      enabled: true,
      dispatcherPath: null,
      label: null,
      definitionPath: null,
    });
    await refreshCliLoginCarrierIfOwned(slockHome, deps);
    assert.equal(harness.jobs.size, 0, "K refresh must not replace Electron lifecycle ownership");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI convergence yields to an App-owned marker and never enables its carrier", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-cli-yields-app-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const harness = launchctlHarness();
  const deps = {
    platform: "darwin" as const,
    userHome: home,
    uid: 501,
    dispatcherPath: path.join(home, ".local", "bin", "raft-computer"),
    legacyDesktopBundlePath: path.join(root, "Applications", "Raft Computer.app"),
    runCommand: harness.run,
  };
  let openAtLogin = true;
  try {
    await convergeAppHostLifecycle(slockHome, true, {
      ...deps,
      setOpenAtLogin: (enabled) => { openAtLogin = enabled; },
      getOpenAtLogin: () => openAtLogin,
    });
    const bootstrapCount = harness.calls.filter(([, action]) => action === "bootstrap").length;
    const result = await convergeCliHostLifecycle(slockHome, "enabled", deps);
    assert.equal(result.owner, "app");
    assert.equal(harness.jobs.size, 0);
    assert.equal(
      harness.calls.filter(([, action]) => action === "bootstrap").length,
      bootstrapCount,
      "CLI must not enable a launchd carrier while the App marker owns lifecycle",
    );
    assert.equal((await readHostLifecycleMarker(slockHome))?.owner, "app");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("App ownership is fail-closed when Electron openAtLogin readback disagrees", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-app-red-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const harness = launchctlHarness();
  try {
    await assert.rejects(
      convergeAppHostLifecycle(slockHome, true, {
        platform: "darwin",
        userHome: home,
        uid: 501,
        dispatcherPath: path.join(home, ".local", "bin", "raft-computer"),
        runCommand: harness.run,
        setOpenAtLogin: () => undefined,
        getOpenAtLogin: () => false,
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "HOST_LIFECYCLE_APP_READBACK_FAILED");
        return true;
      },
    );
    assert.equal(await readHostLifecycleMarker(slockHome), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remove seam proves zero live job, zero definition and zero owner marker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-remove-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const harness = launchctlHarness();
  const deps = {
    platform: "darwin" as const,
    userHome: home,
    uid: 501,
    dispatcherPath: path.join(home, ".local", "bin", "raft-computer"),
    legacyDesktopBundlePath: path.join(root, "Applications", "Raft Computer.app"),
    runCommand: harness.run,
  };
  try {
    await convergeCliHostLifecycle(slockHome, "enabled", deps);
    const removed = await removeHostLifecycle(slockHome, deps);
    assert.equal(removed.status, "removed");
    assert.equal(harness.jobs.size, 0);
    assert.equal(await readHostLifecycleMarker(slockHome), null);
    await assert.rejects(readFile(removed.definitionPath!, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remove seam fails closed for App ownership unless Electron removal is read back", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-app-remove-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const harness = launchctlHarness();
  const deps = {
    platform: "darwin" as const,
    userHome: home,
    uid: 501,
    dispatcherPath: path.join(home, ".local", "bin", "raft-computer"),
    runCommand: harness.run,
  };
  let openAtLogin = true;
  try {
    await convergeAppHostLifecycle(slockHome, true, {
      ...deps,
      setOpenAtLogin: (enabled) => { openAtLogin = enabled; },
      getOpenAtLogin: () => openAtLogin,
    });
    await assert.rejects(removeHostLifecycle(slockHome, deps), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "HOST_LIFECYCLE_APP_OWNER_REQUIRED");
      return true;
    });
    await removeHostLifecycle(slockHome, {
      ...deps,
      setOpenAtLogin: (enabled) => { openAtLogin = enabled; },
      getOpenAtLogin: () => openAtLogin,
    });
    assert.equal(openAtLogin, false);
    assert.equal(await readHostLifecycleMarker(slockHome), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
