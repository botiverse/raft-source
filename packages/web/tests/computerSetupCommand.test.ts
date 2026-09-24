import assert from "node:assert/strict";
import test from "node:test";

import {
  computerInstallCommand,
  COMPUTER_CDN_BASE_PROD,
  COMPUTER_CDN_BASE_STAGING,
  DEFAULT_COMPUTER_SERVER_URL,
  getDaemonConnectCommand,
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
    status: `${environment} ${binary} status`,
    doctor: `${environment} ${binary} doctor`,
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

test("Computer setup command ignores legacyApiKey option (CLI flags removed in RFC v9 PR-impl-3)", () => {
  // The CLI no longer accepts `--adopt-legacy` / `--legacy-api-key` —
  // legacy-daemon adoption is driven by an interactive TTY prompt inside
  // `raft-computer setup`. The web option is preserved as a no-op so
  // existing callsites don't need to change.
  assert.equal(
    getComputerSetupCommand("botiverse", "production", undefined, { legacyApiKey: "sk_machine_test" }),
    productionCommand("botiverse"),
  );
  assert.equal(
    getComputerSetupCommand("botiverse", "staging", undefined, { legacyApiKey: "sk_machine_test" }),
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
    for (const command of Object.values(commands)) {
      assert.match(command, /\$env:RAFT_HOME = "\$env:USERPROFILE\\\.raft-computer-acme"/);
      assert.match(command, /\$env:RAFT_COMPUTER_INSTALL_DIR = "\$env:RAFT_HOME\\bin"/);
      assert.doesNotMatch(command, /RAFT_HOME="\$HOME| sh -c |npx\.cmd|raft-daemon/);
    }
    assert.match(commands.install, /install\.ps1"? \| iex$/);
    assert.match(commands.setup, /& "\$env:RAFT_COMPUTER_INSTALL_DIR\\raft-computer\.exe" setup \/acme/);
    if (env === "staging") {
      assert.match(commands.install, /RAFT_COMPUTER_RELEASE_BASE/);
      assert.match(commands.install, /RAFT_COMPUTER_INSTALL_CHANNEL = "alpha"/);
      assert.match(commands.install, new RegExp(COMPUTER_CDN_BASE_STAGING.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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
        restartService: commands.restartService,
        restart: commands.restart,
        stop: commands.stop,
        start: commands.start,
      },
      {
        status: expected.status,
        doctor: expected.doctor,
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

test("Computer install command is a curl one-liner against the env's CDN", () => {
  assert.equal(
    computerInstallCommand("production"),
    `curl -fsSL ${COMPUTER_CDN_BASE_PROD}/install.sh | sh`,
  );
  assert.equal(
    computerInstallCommand("staging"),
    `curl -fsSL ${COMPUTER_CDN_BASE_STAGING}/install.sh | RAFT_COMPUTER_RELEASE_BASE=${COMPUTER_CDN_BASE_STAGING} RAFT_COMPUTER_INSTALL_CHANNEL=alpha sh`,
  );
  // slockdev / unset fall back to the prod CDN (only staging gets the staging bucket).
  assert.equal(computerInstallCommand("slockdev"), `curl -fsSL ${COMPUTER_CDN_BASE_PROD}/install.sh | sh`);
  assert.equal(computerInstallCommand(undefined), `curl -fsSL ${COMPUTER_CDN_BASE_PROD}/install.sh | sh`);
});

test("Computer fresh install command pins a validated published version at the installer process", () => {
  assert.equal(
    computerInstallCommand("production", "1.0.14"),
    `curl -fsSL ${COMPUTER_CDN_BASE_PROD}/install.sh | RAFT_COMPUTER_VERSION=1.0.14 sh`,
  );
  assert.equal(
    computerInstallCommand("staging", "1.0.14"),
    `curl -fsSL ${COMPUTER_CDN_BASE_STAGING}/install.sh | RAFT_COMPUTER_RELEASE_BASE=${COMPUTER_CDN_BASE_STAGING} RAFT_COMPUTER_INSTALL_CHANNEL=alpha RAFT_COMPUTER_VERSION=1.0.14 sh`,
  );
  assert.equal(
    computerInstallCommand("production", "1.0.14; touch /tmp/nope"),
    `curl -fsSL ${COMPUTER_CDN_BASE_PROD}/install.sh | sh`,
  );
});

test("Windows Computer install command is a PowerShell one-liner against the env's CDN", () => {
  assert.equal(
    windowsComputerInstallCommand("production"),
    `irm ${COMPUTER_CDN_BASE_PROD}/install.ps1 | iex`,
  );
  assert.equal(
    windowsComputerInstallCommand("staging"),
    `$env:RAFT_COMPUTER_RELEASE_BASE = "${COMPUTER_CDN_BASE_STAGING}"; $env:RAFT_COMPUTER_INSTALL_CHANNEL = "alpha"; irm "$env:RAFT_COMPUTER_RELEASE_BASE/install.ps1" | iex`,
  );
  assert.equal(
    windowsComputerInstallCommand("production", "1.0.14"),
    `$env:RAFT_COMPUTER_VERSION = "1.0.14"; irm ${COMPUTER_CDN_BASE_PROD}/install.ps1 | iex`,
  );
  assert.equal(
    windowsComputerInstallCommand("staging", "1.0.14"),
    `$env:RAFT_COMPUTER_RELEASE_BASE = "${COMPUTER_CDN_BASE_STAGING}"; $env:RAFT_COMPUTER_INSTALL_CHANNEL = "alpha"; $env:RAFT_COMPUTER_VERSION = "1.0.14"; irm "$env:RAFT_COMPUTER_RELEASE_BASE/install.ps1" | iex`,
  );
});

test("Computer setup command uses the installed Raft binary without path details", () => {
  const command = getComputerSetupCommand("botiverse", "production");
  assert.equal(command, "raft-computer setup /botiverse");
  assert.doesNotMatch(command ?? "", /curl|export PATH|\.local\/bin|\/raft-computer/);
  assert.doesNotMatch(command ?? "", /npm install/);
  assert.doesNotMatch(command ?? "", /@slock-ai\/computer/);
  assert.doesNotMatch(command ?? "", new RegExp(["slock", "computer setup"].join("-")));
});

test("daemon connect command uses POSIX comments only on macOS/Linux", () => {
  assert.equal(
    getDaemonConnectCommand({
      apiKey: "sk_machine_test",
      distTag: "staging",
      platform: "mac-linux",
      serverName: "botiverse",
      serverUrl: "https://api.raft.build",
    }),
    "npx @botiverse/raft-daemon@staging --server-url https://api.raft.build --api-key sk_machine_test # botiverse",
  );
});

test("Windows daemon connect command uses npx.cmd and no shell comment", () => {
  assert.equal(
    getDaemonConnectCommand({
      apiKey: "sk_machine_test",
      platform: "windows",
      serverName: "botiverse",
      serverUrl: "https://api.raft.build",
    }),
    "npx.cmd @botiverse/raft-daemon@latest --server-url https://api.raft.build --api-key sk_machine_test",
  );
});
