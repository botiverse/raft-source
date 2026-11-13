import assert from "node:assert/strict";

import {
  computerInstallCommand,
  COMPUTER_CDN_BASE_PROD,
  DEFAULT_COMPUTER_SERVER_URL,
  getComputerCommands,
  getComputerSetupCommand,
  LEGACY_DEFAULT_COMPUTER_SERVER_URL,
  STAGING_COMPUTER_SERVER_URL,
  windowsComputerInstallCommand,
} from "../src/utils/computerSetupCommand";

// Non-prod (staging / slockdev) commands share a per-server isolated home/bin
// while remaining separate copy steps. Mirrors getComputerCommands' builder.
function isolatedCommands(slug: string, deploymentEnv: string, serverUrlArg = "") {
  const home = `$HOME/.raft-computer-${slug}`;
  const environment = `RAFT_HOME="${home}" RAFT_COMPUTER_INSTALL_DIR="${home}/bin"`;
  return {
    install: `${environment} sh -c '${computerInstallCommand(deploymentEnv)}'`,
    setup: `${environment} "${home}/bin/raft-computer" setup /${slug}${serverUrlArg}`,
    status: `${environment} "${home}/bin/raft-computer" status`,
    doctor: `${environment} "${home}/bin/raft-computer" doctor`,
    upgrade: `${environment} "${home}/bin/raft-computer" upgrade`,
    restartService: `${environment} "${home}/bin/raft-computer" restart`,
    restart: `${environment} "${home}/bin/raft-computer" restart /${slug}`,
    stop: `${environment} "${home}/bin/raft-computer" stop`,
    start: `${environment} "${home}/bin/raft-computer" start`,
  };
}

function productionCommand(slug: string, setupArgs = ""): string {
  return `raft-computer setup /${slug}${setupArgs}`;
}

function isolatedWindowsCommands(slug: string, deploymentEnv: string, serverUrlArg = "") {
  const home = `$env:USERPROFILE\\.raft-computer-${slug}`;
  const environment = `$env:RAFT_HOME = "${home}"; $env:RAFT_COMPUTER_INSTALL_DIR = "$env:RAFT_HOME\\bin";`;
  const binary = `& "$env:RAFT_COMPUTER_INSTALL_DIR\\raft-computer.exe"`;
  return {
    install: `${environment} ${windowsComputerInstallCommand(deploymentEnv)}`,
    setup: `${environment} ${binary} setup /${slug}${serverUrlArg}`,
    installAndSetup: null,
    status: `${environment} ${binary} status`,
    doctor: `${environment} ${binary} doctor`,
    upgrade: `${environment} ${binary} upgrade`,
    restartService: `${environment} ${binary} restart`,
    restart: `${environment} ${binary} restart /${slug}`,
    stop: `${environment} ${binary} stop`,
    start: `${environment} ${binary} start`,
  };
}

test("Computer setup command omits production server-url for the default hosted API", () => {
  assert.equal(
    getComputerSetupCommand("botiverse", "production", DEFAULT_COMPUTER_SERVER_URL),
    productionCommand("botiverse"),
  );
  assert.equal(
    getComputerSetupCommand("botiverse", "production", `${DEFAULT_COMPUTER_SERVER_URL}/`),
    productionCommand("botiverse"),
  );
  assert.equal(
    getComputerSetupCommand("botiverse", "production", LEGACY_DEFAULT_COMPUTER_SERVER_URL),
    productionCommand("botiverse"),
  );
});

test("Computer setup command includes custom production server-url when provided", () => {
  assert.equal(
    getComputerSetupCommand("botiverse", "production", "https://api.custom.example.test"),
    productionCommand("botiverse", " --server-url https://api.custom.example.test"),
  );
});

test("Computer setup command omits production server-url when absent", () => {
  assert.equal(
    getComputerSetupCommand("botiverse", "production"),
    productionCommand("botiverse"),
  );
});

test("Computer setup command isolates the staging command with a per-server home/bin", () => {
  assert.equal(
    getComputerSetupCommand("botiverse", "staging"),
    isolatedCommands("botiverse", "staging", ` --server-url ${STAGING_COMPUTER_SERVER_URL}`).setup,
  );
});

test("Computer setup command carries --machine for identity-carried adoption (task #239)", () => {
  assert.equal(
    getComputerSetupCommand("botiverse", "production", undefined, { machineId: "0f0f0f0f-1111-2222-3333-444444444444" }),
    productionCommand("botiverse", " --machine 0f0f0f0f-1111-2222-3333-444444444444"),
  );
  assert.equal(
    getComputerSetupCommand("botiverse", "staging", undefined, { machineId: "0f0f0f0f-1111-2222-3333-444444444444" }),
    isolatedCommands(
      "botiverse",
      "staging",
      ` --server-url ${STAGING_COMPUTER_SERVER_URL} --machine 0f0f0f0f-1111-2222-3333-444444444444`,
    ).setup,
  );
  // null/absent machineId keeps the plain command byte-identical.
  assert.equal(
    getComputerSetupCommand("botiverse", "production", undefined, { machineId: null }),
    productionCommand("botiverse"),
  );
});

test("Computer setup command is available on every server (GA — botiverse gate removed)", () => {
  assert.equal(
    getComputerSetupCommand("other-server", "production"),
    productionCommand("other-server"),
  );
  assert.equal(
    getComputerSetupCommand("/other-server", "staging"),
    isolatedCommands("other-server", "staging", ` --server-url ${STAGING_COMPUTER_SERVER_URL}`).setup,
  );
});

test("Computer setup command isolates the slockdev command with a per-server home/bin", () => {
  assert.equal(
    getComputerSetupCommand("dev", "slockdev", "http://localhost:13036"),
    isolatedCommands("dev", "slockdev", " --server-url http://localhost:13036").setup,
  );
});

test("Computer command bundle keeps production default and gives non-prod steps the same isolated env", () => {
  // Production: never isolated — real users want a single Computer at the
  // default ~/.local/bin + ~/.slock.
  const prod = getComputerCommands("botiverse", "production");
  assert.ok(prod);
  assert.doesNotMatch(`${prod.install}\n${prod.setup}`, /RAFT_HOME=|SLOCK_HOME=|RAFT_COMPUTER_INSTALL_DIR=/);
  assert.equal(prod.install, computerInstallCommand("production"));
  assert.equal(prod.setup, productionCommand("botiverse"));
  assert.equal(prod.status, "raft-computer status");
  assert.equal(prod.doctor, "raft-computer doctor");
  assert.equal(prod.upgrade, "raft-computer upgrade");
  assert.equal(prod.restartService, "raft-computer restart");
  assert.equal(prod.restart, "raft-computer restart /botiverse");
  assert.equal(prod.stop, "raft-computer stop");
  assert.equal(prod.start, "raft-computer start");

  // Staging/slockdev: each independent step carries the same per-server env;
  // setup invokes the isolated binary without reinstalling it.
  for (const env of ["staging", "slockdev"] as const) {
    const commands = getComputerCommands("acme", env, "http://localhost:1");
    assert.ok(commands);
    for (const command of [
      commands.install,
      commands.setup,
      commands.status,
      commands.doctor,
      commands.restartService,
      commands.restart,
      commands.stop,
      commands.start,
    ]) {
      assert.match(command, /RAFT_HOME="\$HOME\/\.raft-computer-acme"/);
      assert.doesNotMatch(command, /SLOCK_HOME=/);
      assert.match(command, /RAFT_COMPUTER_INSTALL_DIR="\$HOME\/\.raft-computer-acme\/bin"/);
    }
    assert.match(commands.install, /sh -c 'curl -fsSL/);
    assert.match(commands.setup, /"\$HOME\/\.raft-computer-acme\/bin\/raft-computer" setup \/acme/);
    assert.equal(commands.status, isolatedCommands("acme", env).status);
    assert.equal(commands.doctor, isolatedCommands("acme", env).doctor);
    assert.equal(commands.restartService, isolatedCommands("acme", env).restartService);
    assert.equal(commands.restart, isolatedCommands("acme", env).restart);
    assert.equal(commands.stop, isolatedCommands("acme", env).stop);
    assert.equal(commands.start, isolatedCommands("acme", env).start);
  }
});

test("Windows Computer production commands use the published PowerShell installer and Raft CLI", () => {
  const commands = getComputerCommands("botiverse", "production", DEFAULT_COMPUTER_SERVER_URL, {
    platform: "windows",
  });
  assert.ok(commands);
  assert.equal(commands.install, `irm ${COMPUTER_CDN_BASE_PROD}/install.ps1 | iex`);
  assert.equal(commands.setup, "raft-computer setup /botiverse");
  assert.doesNotMatch(`${commands.install}\n${commands.setup}`, /raft-daemon|npx\.cmd|install\.sh|RAFT_HOME/);
});

test("Windows Computer staging and slockdev commands are self-contained PowerShell cells", () => {
  for (const env of ["staging", "slockdev"] as const) {
    const commands = getComputerCommands("acme", env, "http://localhost:13036", {
      machineId: "machine-windows",
      platform: "windows",
    });
    const serverUrlArg = env === "staging"
      ? ` --server-url ${STAGING_COMPUTER_SERVER_URL} --machine machine-windows`
      : " --server-url http://localhost:13036 --machine machine-windows";
    const expected = isolatedWindowsCommands("acme", env, serverUrlArg);
    assert.ok(commands);
    assert.deepEqual(commands, expected);
    for (const command of Object.values(commands).filter((value): value is string => value !== null)) {
      assert.match(command, /\$env:RAFT_HOME = "\$env:USERPROFILE\\\.raft-computer-acme"/);
      assert.match(command, /\$env:RAFT_COMPUTER_INSTALL_DIR = "\$env:RAFT_HOME\\bin"/);
      assert.doesNotMatch(command, /RAFT_HOME="\$HOME| sh -c |npx\.cmd|raft-daemon/);
    }
    assert.match(commands.install, env === "staging"
      ? /& \(\[scriptblock\]::Create\(\(irm https:\/\/cdn\.raft\.build\/computer\/install\.ps1\)\)\) --channel alpha$/
      : /install\.ps1"? \| iex$/);
    assert.match(commands.setup, /& "\$env:RAFT_COMPUTER_INSTALL_DIR\\raft-computer\.exe" setup \/acme/);
    if (env === "staging") {
      assert.doesNotMatch(commands.install, /RAFT_COMPUTER_RELEASE_BASE/, "the installer no longer reads it");
      assert.doesNotMatch(commands.install, /RAFT_COMPUTER_INSTALL_CHANNEL/, "the staging bootstrap defaults to alpha itself");
      assert.match(commands.install, new RegExp(COMPUTER_CDN_BASE_PROD.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(commands.install, /cdn-staging/);
    }
  }
});

test("Computer terminal commands are exact-copy isolated cells in staging and slockdev", () => {
  for (const env of ["staging", "slockdev"] as const) {
    const commands = getComputerCommands("botiverse", env, "http://localhost:13036");
    const expected = isolatedCommands("botiverse", env);
    assert.ok(commands);
    assert.deepEqual(
      {
        status: commands.status,
        doctor: commands.doctor,
        upgrade: commands.upgrade,
        restartService: commands.restartService,
        restart: commands.restart,
        stop: commands.stop,
        start: commands.start,
      },
      {
        status: expected.status,
        doctor: expected.doctor,
        upgrade: expected.upgrade,
        restartService: expected.restartService,
        restart: expected.restart,
        stop: expected.stop,
        start: expected.start,
      },
      `${env} terminal surfaces must copy one environment-aware Computer bundle`,
    );
  }
});

test("Computer command shapes are table-driven across env and fresh/migrate/recovery surfaces", () => {
  const environments = ["production", "staging", "slockdev"] as const;
  const surfaces = [
    { name: "fresh", options: {}, machineArg: "" },
    { name: "migrate", options: { machineId: "machine-migrate" }, machineArg: " --machine machine-migrate" },
    { name: "recovery", options: { machineId: "machine-recovery" }, machineArg: " --machine machine-recovery" },
  ] as const;

  for (const env of environments) {
    for (const surface of surfaces) {
      const commands = getComputerCommands("acme", env, "http://localhost:13036", surface.options);
      assert.ok(commands, `${env}/${surface.name} should produce a command pair`);
      assert.equal(commands.install.match(/curl -fsSL/g)?.length, 1, `${env}/${surface.name} install should contain one curl`);
      assert.doesNotMatch(commands.setup, /curl|install\.sh/, `${env}/${surface.name} setup must not reinstall`);
      assert.match(commands.setup, new RegExp(`setup /acme(?: --server-url [^ ]+)?${surface.machineArg}$`));

      const combined = `${commands.install}\n${commands.setup}`;
      if (env === "production") {
        assert.doesNotMatch(combined, /RAFT_HOME=|SLOCK_HOME=|RAFT_COMPUTER_INSTALL_DIR=/);
      } else {
        assert.equal(combined.match(/RAFT_HOME="\$HOME\/\.raft-computer-acme"/g)?.length, 2);
        assert.doesNotMatch(combined, /SLOCK_HOME=/);
        assert.equal(combined.match(/RAFT_COMPUTER_INSTALL_DIR="\$HOME\/\.raft-computer-acme\/bin"/g)?.length, 2);
      }
    }
  }
});

test("Computer install command is a curl one-liner against the production entry script", () => {
  assert.equal(
    computerInstallCommand("production"),
    `curl -fsSL ${COMPUTER_CDN_BASE_PROD}/install.sh | sh`,
  );
  assert.equal(
    computerInstallCommand("staging"),
    "curl -fsSL https://cdn.raft.build/computer/install.sh | sh -s -- --channel alpha",
  );
  // slockdev / unset install the default channel (only staging selects alpha).
  assert.equal(computerInstallCommand("slockdev"), `curl -fsSL ${COMPUTER_CDN_BASE_PROD}/install.sh | sh`);
  assert.equal(computerInstallCommand(undefined), `curl -fsSL ${COMPUTER_CDN_BASE_PROD}/install.sh | sh`);
});

test("Computer fresh install command pins a validated published version at the installer process", () => {
  assert.equal(
    computerInstallCommand("production", "1.0.14"),
    `curl -fsSL ${COMPUTER_CDN_BASE_PROD}/install.sh | RAFT_COMPUTER_VERSION=1.0.14 sh`,
  );
  assert.equal(
    // The pin wins: the installer rejects --version together with --channel.
    computerInstallCommand("staging", "1.0.14"),
    "curl -fsSL https://cdn.raft.build/computer/install.sh | RAFT_COMPUTER_VERSION=1.0.14 sh",
  );
  assert.equal(
    computerInstallCommand("production", "1.0.14; touch /tmp/nope"),
    `curl -fsSL ${COMPUTER_CDN_BASE_PROD}/install.sh | sh`,
  );
});

test("Windows Computer install command is a PowerShell one-liner against the production entry script", () => {
  assert.equal(
    windowsComputerInstallCommand("production"),
    `irm ${COMPUTER_CDN_BASE_PROD}/install.ps1 | iex`,
  );
  assert.equal(
    windowsComputerInstallCommand("staging"),
    "& ([scriptblock]::Create((irm https://cdn.raft.build/computer/install.ps1))) --channel alpha",
  );
  assert.equal(
    windowsComputerInstallCommand("production", "1.0.14"),
    `$env:RAFT_COMPUTER_VERSION = "1.0.14"; irm ${COMPUTER_CDN_BASE_PROD}/install.ps1 | iex`,
  );
  assert.equal(
    windowsComputerInstallCommand("staging", "1.0.14"),
    '$env:RAFT_COMPUTER_VERSION = "1.0.14"; irm https://cdn.raft.build/computer/install.ps1 | iex',
  );
  assert.doesNotMatch(windowsComputerInstallCommand("staging", "1.0.14"), /--channel/);
});

test("mac/Linux production offers one paste that installs then runs setup; Windows and isolated envs keep two steps", () => {
  const prod = getComputerCommands("acme", "production", DEFAULT_COMPUTER_SERVER_URL);
  assert.equal(prod?.installAndSetup, `curl -fsSL ${COMPUTER_CDN_BASE_PROD}/install.sh | sh -s -- --setup /acme`);
  // Setup arguments ride after --setup, exactly as the separate setup step has them.
  const custom = getComputerCommands("acme", "production", "https://raft.example.com", { machineId: "m-1" });
  assert.equal(
    custom?.installAndSetup,
    `curl -fsSL ${COMPUTER_CDN_BASE_PROD}/install.sh | sh -s -- --setup /acme --server-url https://raft.example.com --machine m-1`,
  );
  // A version pin stays on the installer process, before -s.
  const pinned = getComputerCommands("acme", "production", DEFAULT_COMPUTER_SERVER_URL, { version: "1.0.45" });
  assert.equal(pinned?.installAndSetup, `curl -fsSL ${COMPUTER_CDN_BASE_PROD}/install.sh | RAFT_COMPUTER_VERSION=1.0.45 sh -s -- --setup /acme`);
  // Windows pastes `irm … | iex`, which cannot take arguments: two steps.
  assert.equal(getComputerCommands("acme", "production", DEFAULT_COMPUTER_SERVER_URL, { platform: "windows" })?.installAndSetup, null);
  for (const env of ["staging", "slockdev"]) {
    assert.equal(getComputerCommands("acme", env, "https://x.example.com")?.installAndSetup, null);
  }
});

test("Computer setup command uses the installed Raft binary without path details", () => {
  const command = getComputerSetupCommand("botiverse", "production");
  assert.equal(command, "raft-computer setup /botiverse");
  assert.doesNotMatch(command ?? "", /curl|export PATH|\.local\/bin|\/raft-computer/);
  assert.doesNotMatch(command ?? "", /npm install/);
  assert.doesNotMatch(command ?? "", /@slock-ai\/computer/);
  assert.doesNotMatch(command ?? "", new RegExp(["slock", "computer setup"].join("-")));
});

test("the retired standalone daemon connect command is not exported", async () => {
  const commands = await import("../src/utils/computerSetupCommand");
  assert.equal("getDaemonConnectCommand" in commands, false);
});

test("staging isolated installs use the production entry script on the alpha channel; a version pin drops the channel", () => {
  const home = "$HOME/.raft-computer-acme";
  const environment = `RAFT_HOME="${home}" RAFT_COMPUTER_INSTALL_DIR="${home}/bin"`;
  assert.equal(
    getComputerCommands("acme", "staging")?.install,
    `${environment} sh -c 'curl -fsSL https://cdn.raft.build/computer/install.sh | sh -s -- --channel alpha'`,
  );
  assert.equal(
    getComputerCommands("acme", "staging", undefined, { version: "1.0.45" })?.install,
    `${environment} sh -c 'curl -fsSL https://cdn.raft.build/computer/install.sh | RAFT_COMPUTER_VERSION=1.0.45 sh'`,
  );
  const windowsEnvironment = '$env:RAFT_HOME = "$env:USERPROFILE\\.raft-computer-acme"; $env:RAFT_COMPUTER_INSTALL_DIR = "$env:RAFT_HOME\\bin";';
  assert.equal(
    getComputerCommands("acme", "staging", undefined, { platform: "windows" })?.install,
    `${windowsEnvironment} & ([scriptblock]::Create((irm https://cdn.raft.build/computer/install.ps1))) --channel alpha`,
  );
  assert.equal(
    getComputerCommands("acme", "staging", undefined, { platform: "windows", version: "1.0.45" })?.install,
    `${windowsEnvironment} $env:RAFT_COMPUTER_VERSION = "1.0.45"; irm https://cdn.raft.build/computer/install.ps1 | iex`,
  );
  for (const platform of ["mac-linux", "windows"] as const) {
    const commands = getComputerCommands("acme", "staging", undefined, { platform });
    for (const command of Object.values(commands ?? {}).filter((value): value is string => typeof value === "string")) {
      assert.doesNotMatch(command, /cdn-staging|computer\/staging/);
    }
  }
});
