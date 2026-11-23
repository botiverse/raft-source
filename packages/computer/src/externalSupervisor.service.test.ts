import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import * as externalInstaller from "./externalInstaller";
import { readLastRemoteUpgradeReceipt } from "./externalInstaller";
import { collectRemoteUpgradeSteps } from "./remoteUpgradeTrace";
import { runService } from "./service";
import { readSupervisorRecord, supervisorRecordPath, systemdScopeProbeArgs, writeSupervisorRecord, type ExternalSupervisorRecord, type SystemctlRunner, type SystemdScopeProbe } from "./externalSupervisor";
import { ServiceClientError } from "./lib/types";

const RECORD: ExternalSupervisorRecord = { kind: "systemd", scope: "user", unit: "raft-computer.service", invocationId: "inv", pid: process.pid, recordedAt: "t" };
const SYSTEM_RECORD: ExternalSupervisorRecord = { ...RECORD, scope: "system" };

/** The probe must not run on this path (an old installer never needs a scope). */
const noProbe: SystemdScopeProbe = async () => { throw new Error("the scope probe must not run here"); };

/** systemd lets (or refuses) this process a transient scope; records the manager asked. */
function scopeProbe(answer: { code: number | null; stderr?: string }): { probe: SystemdScopeProbe; scopes: string[] } {
  const scopes: string[] = [];
  const probe: SystemdScopeProbe = async (scope) => {
    scopes.push(scope);
    return { code: answer.code, stdout: "", stderr: answer.stderr ?? "" };
  };
  return { probe, scopes };
}

function systemctlAnswering(killMode: string): { runner: SystemctlRunner; calls: string[] } {
  const calls: string[] = [];
  const runner: SystemctlRunner = async (scope, args) => {
    calls.push(`${scope}:${args.join(" ")}`);
    if (args[0] === "show" && args[2] === "KillMode") return { code: 0, stdout: `${killMode}\n`, stderr: "" };
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  return { runner, calls };
}

async function withServiceHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "raft-supervised-service-"));
  const oldRaft = process.env.RAFT_HOME;
  const oldSlock = process.env.SLOCK_HOME;
  const oldOptIn = process.env.RAFT_COMPUTER_EXTERNAL_SUPERVISOR;
  process.env.RAFT_HOME = home;
  process.env.SLOCK_HOME = home;
  delete process.env.RAFT_COMPUTER_EXTERNAL_SUPERVISOR;
  mkdirSync(join(home, "computer"), { recursive: true });
  writeFileSync(join(home, "computer", "channel"), "latest");
  try {
    return await fn(home);
  } finally {
    if (oldRaft === undefined) delete process.env.RAFT_HOME; else process.env.RAFT_HOME = oldRaft;
    if (oldSlock === undefined) delete process.env.SLOCK_HOME; else process.env.SLOCK_HOME = oldSlock;
    if (oldOptIn === undefined) delete process.env.RAFT_COMPUTER_EXTERNAL_SUPERVISOR; else process.env.RAFT_COMPUTER_EXTERNAL_SUPERVISOR = oldOptIn;
    rmSync(home, { recursive: true, force: true });
  }
}

const remote = (requestId: string, targetVersion?: string) =>
  ({ scope: "remote" as const, requestId, originServerId: "test-server", trigger: "web" as const, ...(targetVersion ? { targetVersion } : {}) });

/** Resolve "the installer", let the service's pre-spawn check run, then report a pid. */
function launchThroughVeto() {
  return vi.spyOn(externalInstaller, "launchInstallerDetached").mockImplementation(
    async (_home, _args, _id, _env, stats, beforeSpawn) => {
      if (stats) stats.resolved = true;
      await beforeSpawn?.("/fake/raft-computer-installer");
      return 4321;
    });
}

test("task #917: under systemd with KillMode=control-group an installer older than 0.3.21 is refused before spawn and settled as this request's failed receipt", async () => {
  await withServiceHome(async (home) => {
    const launch = launchThroughVeto();
    const { runner, calls } = systemctlAnswering("control-group");
    try {
      let exercised = false;
      await runService({
        stopAfterMutationsReady: true,
        detectSystemdSupervisorFn: async () => RECORD,
        systemctl: runner,
        systemdScopeProbe: noProbe,
        readInstallerVersionFn: async () => "0.3.20",
        onMutationsReady: async (mutations) => {
          await assert.rejects(
            () => mutations.upgradeStart!(remote("req-1", "1.0.33")),
            (err: unknown) => err instanceof ServiceClientError && err.code === "UPGRADE_START_REJECTED" && /KillMode=process/.test(err.message) && /0\.3\.20/.test(err.message),
          );
          exercised = true;
        },
      });
      assert.equal(exercised, true);
      assert.deepEqual(calls, ["user:show -P KillMode raft-computer.service"]);
      assert.deepEqual(await readSupervisorRecord(home), RECORD, "the service records who supervises it");
      const receipt = await readLastRemoteUpgradeReceipt(home);
      assert.equal(receipt?.targetVersion, "1.0.33");
      assert.equal(receipt?.outcome, "failed");
      assert.match(receipt?.reason ?? "", /raft-computer\.service with KillMode=control-group/);
      const steps = (await collectRemoteUpgradeSteps(home, { serverId: "test-server" })).events;
      assert.deepEqual(steps.map((event) => [event.step, event.outcome, event.errorCode, event.killMode]), [
        ["received", "ok", undefined, "control-group"],
        ["download", "ok", undefined, undefined],
        ["installer_spawned", "failed", "unsafe_kill_mode", "control-group"],
      ]);
    } finally {
      launch.mockRestore();
    }
  });
});

test("installer 0.3.21: under systemd with KillMode=control-group an installer that leaves the unit itself is launched once systemd grants this service a scope", async () => {
  await withServiceHome(async (home) => {
    const launch = launchThroughVeto();
    // A non-default saved channel: the received step must read the file, also for an exact-version request.
    writeFileSync(join(home, "computer", "channel"), "alpha");
    const { probe, scopes } = scopeProbe({ code: 0 });
    try {
      await runService({
        stopAfterMutationsReady: true,
        detectSystemdSupervisorFn: async () => RECORD,
        systemctl: systemctlAnswering("control-group").runner,
        systemdScopeProbe: probe,
        readInstallerVersionFn: async () => "0.3.21",
        onMutationsReady: async (mutations) => {
          assert.deepEqual(await mutations.upgradeStart!(remote("req-3", "1.0.33")), { status: "started", upgradeId: "req-3", targetVersion: "1.0.33" });
        },
      });
      assert.equal(launch.mock.calls.length, 1);
      assert.deepEqual(scopes, ["user"], "asked the unit's own manager, once, before the spawn");
      const steps = (await collectRemoteUpgradeSteps(home, { serverId: "test-server" })).events;
      assert.deepEqual(steps.map((event) => [event.step, event.outcome, event.killMode]).slice(0, 3), [
        ["received", "ok", "control-group"],
        ["download", "ok", undefined],
        ["installer_spawned", "ok", "control-group"],
      ]);
      // #67: the channels this machine follows, on the received step: the saved release channel
      // (also for an exact-version request) and the installer channel (default main).
      assert.deepEqual([steps[0]!.channel, steps[0]!.installerChannel], ["alpha", "main"]);
    } finally {
      launch.mockRestore();
    }
  });
});

test("#67: a system unit run without the right to open a scope refuses the upgrade before spawn, in the installer's held words, instead of a held after the download", async () => {
  await withServiceHome(async (home) => {
    const launch = launchThroughVeto();
    const { probe, scopes } = scopeProbe({
      code: 1,
      stderr: "Failed to start transient scope unit: Access denied as the requested operation requires interactive authentication. However, interactive authentication has not been enabled by the calling program.\n",
    });
    try {
      await runService({
        stopAfterMutationsReady: true,
        detectSystemdSupervisorFn: async () => SYSTEM_RECORD,
        systemctl: systemctlAnswering("control-group").runner,
        systemdScopeProbe: probe,
        readInstallerVersionFn: async () => "0.4.1",
        onMutationsReady: async (mutations) => {
          await assert.rejects(
            mutations.upgradeStart!(remote("req-scope", "1.22.0")),
            (err: unknown) => err instanceof ServiceClientError && err.code === "UPGRADE_START_REJECTED"
              // The installer's own `held` words (the server reads them as installation_held), plus systemd's.
              && /runs in systemd unit raft-computer\.service, which would stop the upgrade together with the service, and the upgrade could not move out of it \(systemd-run: Failed to start transient scope unit: Access denied/.test(err.message)
              && /`systemctl stop raft-computer\.service`, run the install command, then `systemctl start raft-computer\.service`/.test(err.message)
              && !/KillMode=process/.test(err.message),
          );
        },
      });
      assert.deepEqual(scopes, ["system"], "the system manager, as the installer would use");
      assert.equal(launch.mock.calls.length, 1, "the installer was resolved (the veto runs right before spawn)");
      const receipt = await readLastRemoteUpgradeReceipt(home);
      assert.equal(receipt?.targetVersion, "1.22.0");
      assert.equal(receipt?.outcome, "failed");
      assert.match(receipt?.reason ?? "", /could not move out of it \(systemd-run:/);
      const steps = (await collectRemoteUpgradeSteps(home, { serverId: "test-server" })).events;
      assert.deepEqual(steps.map((event) => [event.step, event.outcome, event.errorCode]), [
        ["received", "ok", undefined],
        ["download", "ok", undefined],
        ["installer_spawned", "failed", "scope_unavailable"],
      ]);
    } finally {
      launch.mockRestore();
    }
  });
});

test("#67: the scope probe asks systemd the way the installer does: --user only for a user unit", () => {
  assert.deepEqual(systemdScopeProbeArgs("user"), ["--user", "--scope", "--quiet", "--collect", "--no-ask-password", "--", "true"]);
  assert.deepEqual(systemdScopeProbeArgs("system"), ["--scope", "--quiet", "--collect", "--no-ask-password", "--", "true"]);
});

test("#67: a safe KillMode does not spare the new installer the probe (it escapes whatever the KillMode): refused when systemd says no", async () => {
  await withServiceHome(async (home) => {
    const launch = launchThroughVeto();
    const { probe, scopes } = scopeProbe({ code: null, stderr: "systemd-run did not finish within 15 s" });
    try {
      await runService({
        stopAfterMutationsReady: true,
        detectSystemdSupervisorFn: async () => RECORD,
        systemctl: systemctlAnswering("process").runner,
        systemdScopeProbe: probe,
        readInstallerVersionFn: async () => "0.4.1",
        onMutationsReady: async (mutations) => {
          await assert.rejects(
            mutations.upgradeStart!(remote("req-safe-new", "1.22.0")),
            (err: unknown) => err instanceof ServiceClientError && err.code === "UPGRADE_START_REJECTED"
              && /\(systemd-run: systemd-run did not finish within 15 s\)/.test(err.message)
              && /`systemctl --user stop raft-computer\.service`/.test(err.message),
          );
        },
      });
      assert.deepEqual(scopes, ["user"]);
      const receipt = await readLastRemoteUpgradeReceipt(home);
      assert.equal(receipt?.outcome, "failed");
    } finally {
      launch.mockRestore();
    }
  });
});

test("#67: under a safe KillMode an old installer is launched without any probe (it never needs a scope)", async () => {
  await withServiceHome(async () => {
    const launch = launchThroughVeto();
    try {
      await runService({
        stopAfterMutationsReady: true,
        detectSystemdSupervisorFn: async () => RECORD,
        systemctl: systemctlAnswering("process").runner,
        systemdScopeProbe: noProbe,
        readInstallerVersionFn: async () => "0.3.20",
        onMutationsReady: async (mutations) => {
          assert.deepEqual(await mutations.upgradeStart!(remote("req-safe-old", "1.0.33")), { status: "started", upgradeId: "req-safe-old", targetVersion: "1.0.33" });
        },
      });
      assert.equal(launch.mock.calls.length, 1);
    } finally {
      launch.mockRestore();
    }
  });
});

test("task #917: an installer whose version cannot be read counts as old under an unsafe KillMode", async () => {
  await withServiceHome(async () => {
    const launch = launchThroughVeto();
    try {
      await runService({
        stopAfterMutationsReady: true,
        detectSystemdSupervisorFn: async () => RECORD,
        systemctl: systemctlAnswering("control-group").runner,
        systemdScopeProbe: noProbe,
        readInstallerVersionFn: async () => null,
        onMutationsReady: async (mutations) => {
          await assert.rejects(() => mutations.upgradeStart!(remote("req-4")),
            (err: unknown) => err instanceof ServiceClientError && err.code === "UPGRADE_START_REJECTED" && /unknown version/.test(err.message));
        },
      });
    } finally {
      launch.mockRestore();
    }
  });
});

test("task #917: under systemd with KillMode=process the upgrade proceeds through the installer as before; an alpha installer channel is recorded (#67)", async () => {
  await withServiceHome(async (home) => {
    const launch = vi.spyOn(externalInstaller, "launchInstallerDetached").mockResolvedValue(4321);
    const previousInstallerChannel = process.env.RAFT_COMPUTER_INSTALLER_CHANNEL;
    process.env.RAFT_COMPUTER_INSTALLER_CHANNEL = "alpha";
    try {
      await runService({
        stopAfterMutationsReady: true,
        detectSystemdSupervisorFn: async () => RECORD,
        systemctl: systemctlAnswering("process").runner,
        onMutationsReady: async (mutations) => {
          assert.deepEqual(await mutations.upgradeStart!(remote("req-2", "1.0.34")), { status: "started", upgradeId: "req-2", targetVersion: "1.0.34" });
        },
      });
      assert.equal(launch.mock.calls.length, 1);
      const received = (await collectRemoteUpgradeSteps(home, { serverId: "test-server" })).events.find((event) => event.step === "received");
      assert.deepEqual([received?.channel, received?.installerChannel], ["latest", "alpha"], "an rc installer after the stable is explained by this field");
    } finally {
      if (previousInstallerChannel === undefined) delete process.env.RAFT_COMPUTER_INSTALLER_CHANNEL; else process.env.RAFT_COMPUTER_INSTALLER_CHANNEL = previousInstallerChannel;
      launch.mockRestore();
    }
  });
});

test("task #917: a supervised restart exits for the supervisor instead of spawning a replacement", async () => {
  await withServiceHome(async () => {
    let signalled = 0;
    await runService({
      stopAfterMutationsReady: true,
      detectSystemdSupervisorFn: async () => RECORD,
      systemctl: systemctlAnswering("process").runner,
      signalSelfForRelaunch: () => { signalled += 1; },
      onMutationsReady: async (mutations) => {
        assert.deepEqual(await mutations.restartService(), { status: "accepted" });
        await new Promise((resolve) => setImmediate(resolve));
      },
    });
    assert.equal(signalled, 1, "the hand-off asks this process to shut down exactly once");
  });
});

test("task #917: the generic opt-in gets the exit hand-off for restart and a settled refusal for upgrade", async () => {
  await withServiceHome(async (home) => {
    process.env.RAFT_COMPUTER_EXTERNAL_SUPERVISOR = "1";
    const launch = vi.spyOn(externalInstaller, "launchInstallerDetached").mockResolvedValue(4321);
    let signalled = 0;
    try {
      await runService({
        stopAfterMutationsReady: true,
        detectSystemdSupervisorFn: async () => null,
        signalSelfForRelaunch: () => { signalled += 1; },
        onMutationsReady: async (mutations) => {
          await assert.rejects(
            () => mutations.upgradeStart!(remote("req-3", "1.0.35")),
            (err: unknown) => err instanceof ServiceClientError && err.code === "UPGRADE_START_REJECTED" && /RAFT_COMPUTER_EXTERNAL_SUPERVISOR/.test(err.message),
          );
          assert.deepEqual(await mutations.restartService(), { status: "accepted" });
          await new Promise((resolve) => setImmediate(resolve));
        },
      });
      assert.equal(launch.mock.calls.length, 0);
      assert.equal(signalled, 1);
      assert.equal(existsSync(supervisorRecordPath(home)), false, "no systemd record for a generic supervisor");
      assert.equal((await readLastRemoteUpgradeReceipt(home))?.outcome, "failed");
    } finally {
      launch.mockRestore();
    }
  });
});

test("task #917: an unsupervised service clears a stale supervisor record so a plain start is not captured by an old unit", async () => {
  await withServiceHome(async (home) => {
    await writeSupervisorRecord(home, RECORD);
    await runService({ stopAfterMutationsReady: true, detectSystemdSupervisorFn: async () => null, onMutationsReady: async () => undefined });
    assert.equal(await readSupervisorRecord(home), null);
  });
});
