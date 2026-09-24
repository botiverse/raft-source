import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";

import {
  buildLaunchdDiscoveryPath,
  buildOsSupervisorSpec,
  buildSupervisorCommandPlan,
  classifySupervisorDefinition,
  describeOsSupervisorKind,
  isOwnedHistoricalLaunchdDefinition,
  quoteWindowsArgument,
} from "./osSupervisor.js";
import { buildSystemdDiscoveryPath } from "./systemdDiscoveryPath.js";
import {
  retireLegacyOsSupervisor,
  resolveOsSupervisorSpec,
  type SupervisorCommandRunner,
} from "./osSupervisorRuntime.js";
import { createWindowsPowerShellChildEnv } from "./windowsPowerShellEnv.js";

const home = "/tmp/raft home/.slock";
const binary = "/tmp/raft bin/raft-computer";

test("OS supervisor identity is stable per Computer home and never embeds path bytes", () => {
  const first = buildOsSupervisorSpec({
    platform: "linux",
    slockHome: home,
    binaryPath: binary,
    userHome: "/tmp/user",
    uid: 1000,
  });
  const same = buildOsSupervisorSpec({
    platform: "linux",
    slockHome: `${home}/../.slock`,
    binaryPath: binary,
    userHome: "/tmp/user",
    uid: 1000,
  });
  const other = buildOsSupervisorSpec({
    platform: "linux",
    slockHome: "/tmp/other/.slock",
    binaryPath: binary,
    userHome: "/tmp/user",
    uid: 1000,
  });

  assert.equal(first.id, same.id);
  assert.notEqual(first.id, other.id);
  assert.match(first.id, /^raft-computer-[a-f0-9]{16}\.service$/);
  assert.doesNotMatch(first.id, /tmp|raft home|\.slock/);
});

test("systemd-user definition pins one current binary, one home, and restart policy", () => {
  const spec = buildOsSupervisorSpec({
    platform: "linux",
    slockHome: home,
    binaryPath: binary,
    userHome: "/tmp/user",
    uid: 1000,
  });

  assert.equal(spec.kind, "systemd-user");
  assert.equal(
    spec.definitionPath,
    `/tmp/user/.config/systemd/user/${spec.id}`,
  );
  assert.match(spec.definition, /^\[Unit\]/m);
  assert.match(
    spec.definition,
    /^Environment="PATH=\/tmp\/user\/\.local\/bin:\/tmp\/user\/\.volta\/bin:\/tmp\/user\/\.asdf\/shims:\/tmp\/user\/\.local\/share\/mise\/shims:\/home\/linuxbrew\/\.linuxbrew\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin:\/usr\/local\/sbin:\/usr\/sbin:\/sbin"$/m,
  );
  assert.match(
    spec.definition,
    /^ExecStart="\/tmp\/raft bin\/raft-computer" "__service" "--slock-home" "\/tmp\/raft home\/\.slock" "--os-supervised" "systemd-user"$/m,
  );
  assert.match(spec.definition, /^Restart=always$/m);
  assert.match(spec.definition, /^RestartSec=2$/m);
  assert.match(spec.definition, /^WantedBy=default\.target$/m);
  assert.equal(classifySupervisorDefinition(spec, spec.definition), "exact");
  assert.equal(
    classifySupervisorDefinition(
      spec,
      spec.definition.replace(/^Environment="PATH=[^"]*"\n/m, ""),
    ),
    "repairable",
    "an owned pre-PATH unit must converge through installer repair",
  );
});

test("systemd discovery PATH admits selected runtime-manager bins but rejects arbitrary parent entries", () => {
  const runtimeSearchPath = [
    "/tmp/hostile",
    ".nvm/versions/node/v99.0.0/bin",
    "/home/example/.nvm/versions/node/v24.15.0/bin",
    "/home/example/.asdf/installs/nodejs/22.1.0/bin",
    "/home/example/.local/share/mise/installs/node/23.0.0/bin",
    "/home/example/.local/share/fnm/node-versions/v20.0.0/installation/bin",
    "/opt/custom/bin",
    "/home/example/.nvm/versions/node/v24.15.0/bin",
  ].join(":");

  assert.equal(
    buildSystemdDiscoveryPath("/home/example", runtimeSearchPath),
    [
      "/home/example/.nvm/versions/node/v24.15.0/bin",
      "/home/example/.asdf/installs/nodejs/22.1.0/bin",
      "/home/example/.local/share/mise/installs/node/23.0.0/bin",
      "/home/example/.local/share/fnm/node-versions/v20.0.0/installation/bin",
      "/home/example/.local/bin",
      "/home/example/.volta/bin",
      "/home/example/.asdf/shims",
      "/home/example/.local/share/mise/shims",
      "/home/linuxbrew/.linuxbrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/local/sbin",
      "/usr/sbin",
      "/sbin",
    ].join(":"),
  );
});

test("systemd unit persists an NVM Codex bin without inheriting unrelated shell PATH", () => {
  const spec = buildOsSupervisorSpec({
    platform: "linux",
    slockHome: "/home/example/.slock",
    binaryPath: "/home/example/.local/bin/raft-computer",
    userHome: "/home/example",
    runtimeSearchPath:
      "/tmp/credential-helper:/home/example/.nvm/versions/node/v24.15.0/bin:/opt/private/bin",
    uid: 1000,
  });

  assert.match(
    spec.definition,
    /^Environment="PATH=\/home\/example\/\.nvm\/versions\/node\/v24\.15\.0\/bin:/m,
  );
  assert.doesNotMatch(spec.definition, /credential-helper|\/opt\/private/);
});

test("systemd spec resolution observes the installer runtime PATH through the allowlist", async () => {
  const spec = await resolveOsSupervisorSpec(
    "/home/example/.slock",
    "/home/example/.local/bin/raft-computer",
    {
      platform: "linux",
      userHome: "/home/example",
      runtimeSearchPath:
        "/tmp/hostile:/home/example/.nvm/versions/node/v24.15.0/bin",
      uid: 1000,
    },
  );

  assert.match(
    spec.definition,
    /^Environment="PATH=\/home\/example\/\.nvm\/versions\/node\/v24\.15\.0\/bin:/m,
  );
  assert.doesNotMatch(spec.definition, /\/tmp\/hostile/);
});

test("launchd user definition is an exact per-user KeepAlive job", () => {
  const spec = buildOsSupervisorSpec({
    platform: "darwin",
    slockHome: home,
    binaryPath: binary,
    userHome: "/Users/example",
    uid: 501,
  });

  assert.equal(spec.kind, "launchd-user");
  assert.match(spec.id, /^build\.raft\.computer\.[a-f0-9]{16}$/);
  assert.equal(
    spec.definitionPath,
    `/Users/example/Library/LaunchAgents/${spec.id}.plist`,
  );
  assert.match(spec.definition, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(spec.definition, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(spec.definition, /<string>__service<\/string>/);
  assert.match(
    spec.definition,
    /<string>--slock-home<\/string>\s*<string>\/tmp\/raft home\/\.slock<\/string>/,
  );
  assert.match(
    spec.definition,
    /<string>--os-supervised<\/string>\s*<string>launchd-user<\/string>/,
  );
  assert.match(
    spec.definition,
    /<key>PATH<\/key>\s*<string>\/Users\/example\/\.local\/bin:\/opt\/homebrew\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/,
  );
  assert.equal(classifySupervisorDefinition(spec, spec.definition), "exact");
});

test("launchd discovery PATH is deterministic and independent of hostile or empty parent PATH", () => {
  const originalPath = process.env.PATH;
  try {
    for (const parentPath of [
      "/tmp/hostile:/opt/homebrew/bin:/tmp/hostile",
      "",
    ]) {
      process.env.PATH = parentPath;
      assert.equal(
        buildLaunchdDiscoveryPath("/Users/example"),
        "/Users/example/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      );

      const spec = buildOsSupervisorSpec({
        platform: "darwin",
        slockHome: home,
        binaryPath: binary,
        userHome: "/Users/example",
        uid: 501,
      });
      assert.doesNotMatch(spec.definition, /\/tmp\/hostile/);
    }
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("supervisor PATH policies leave the Windows definition unchanged", () => {
  const linux = buildOsSupervisorSpec({
    platform: "linux",
    slockHome: home,
    binaryPath: binary,
    userHome: "/tmp/user",
    uid: 1000,
  });
  const windows = buildOsSupervisorSpec({
    platform: "win32",
    slockHome: "C:\\Users\\Example User\\.slock",
    binaryPath: "C:\\Users\\Example User\\.local\\bin\\raft-computer.exe",
    userHome: "C:\\Users\\Example User",
    uid: null,
    windowsUserId: "S-1-5-21-1234",
  });

  assert.match(linux.definition, /^Environment="PATH=/m);
  assert.doesNotMatch(windows.definition, /<key>PATH<\/key>|<Environment>/);
});

test("Windows per-user scheduled task pins AtLogOn and bounded RestartOnFailure", () => {
  const spec = buildOsSupervisorSpec({
    platform: "win32",
    slockHome: "C:\\Users\\Example User\\.slock",
    binaryPath: "C:\\Users\\Example User\\.local\\bin\\raft-computer.exe",
    userHome: "C:\\Users\\Example User",
    uid: null,
    windowsUserId: "S-1-5-21-1234",
  });

  assert.equal(spec.kind, "windows-task");
  assert.equal(
    describeOsSupervisorKind(spec.kind),
    "Windows per-user scheduled task (not an SCM service)",
  );
  assert.match(spec.id, /^\\Raft-Computer-[a-f0-9]{16}$/);
  assert.equal(spec.definitionPath, null);
  assert.match(spec.definition, /<LogonTrigger>/);
  assert.match(spec.definition, /<UserId>S-1-5-21-1234<\/UserId>/);
  assert.match(
    spec.definition,
    /<RestartOnFailure>\s*<Interval>PT2S<\/Interval>\s*<Count>999<\/Count>/,
  );
  assert.match(
    spec.definition,
    /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/,
  );
  assert.match(
    spec.definition,
    /<Command>C:\\Users\\Example User\\\.local\\bin\\raft-computer\.exe<\/Command>/,
  );
  assert.match(
    spec.definition,
    /<Arguments>__service --slock-home &quot;C:\\Users\\Example User\\\.slock&quot; --os-supervised windows-task<\/Arguments>/,
  );

  const schedulerReadback = spec.definition
    .replace(
      '<?xml version="1.0" encoding="UTF-16"?>',
      '<?xml version="1.0" encoding="UTF-16" ?>',
    )
    .replace(
      "    <Enabled>true</Enabled>\n    <RestartOnFailure>",
      "    <Enabled>false</Enabled>\n    <RestartOnFailure>",
    )
    .replaceAll("\n", "\r\n");
  assert.equal(
    classifySupervisorDefinition(spec, schedulerReadback),
    "exact",
    "Task Scheduler formatting and the mutable disabled bit are not definition drift",
  );
  assert.equal(
    classifySupervisorDefinition(
      spec,
      schedulerReadback.replace(
        "      <Enabled>true</Enabled>\r\n      <UserId>",
        "      <Enabled>false</Enabled>\r\n      <UserId>",
      ),
    ),
    "repairable",
    "a disabled AtLogOn trigger is policy drift even when the task itself is owned",
  );
});

test("definition ownership distinguishes repairable same-home bytes from foreign jobs", () => {
  const current = buildOsSupervisorSpec({
    platform: "linux",
    slockHome: home,
    binaryPath: binary,
    userHome: "/tmp/user",
    uid: 1000,
  });
  const oldBinary = buildOsSupervisorSpec({
    platform: "linux",
    slockHome: home,
    binaryPath: "/old/path/raft-computer",
    userHome: "/tmp/user",
    uid: 1000,
  });

  assert.equal(
    classifySupervisorDefinition(current, oldBinary.definition),
    "repairable",
  );
  assert.equal(
    classifySupervisorDefinition(
      current,
      current.definition.replace(home, "/foreign/home"),
    ),
    "foreign",
  );
  assert.equal(
    classifySupervisorDefinition(current, "[Service]\nExecStart=/bin/true\n"),
    "foreign",
  );
  assert.equal(classifySupervisorDefinition(current, null), "absent");
});

test("Windows argument quoting follows CommandLineToArgvW boundaries", () => {
  assert.equal(quoteWindowsArgument("plain"), "plain");
  assert.equal(quoteWindowsArgument("two words"), '"two words"');
  assert.equal(quoteWindowsArgument('a"b'), '"a\\\"b"');
  assert.equal(
    quoteWindowsArgument("trailing slash\\"),
    '"trailing slash\\\\"',
  );
});

test("Windows PowerShell child env removes every PSModulePath case variant without mutation", () => {
  const source: NodeJS.ProcessEnv = {
    Path: "C:\\Windows\\System32",
    PSModulePath: "C:\\Program Files\\PowerShell\\Modules",
    psmodulepath: "C:\\Users\\Me\\Documents\\PowerShell\\Modules",
    TASK_ENV: "present",
  };
  const original = { ...source };
  const childEnv = createWindowsPowerShellChildEnv(source);
  assert.deepEqual(childEnv, {
    Path: "C:\\Windows\\System32",
    TASK_ENV: "present",
  });
  assert.deepEqual(source, original);
});

test("Windows supervisor PowerShell probes discard inherited PSModulePath", async () => {
  const previous = process.env.PSModulePath;
  process.env.PSModulePath = "C:\\Program Files\\PowerShell\\7\\Modules";
  let observedEnv: NodeJS.ProcessEnv | undefined;
  try {
    await resolveOsSupervisorSpec(
      "C:\\Users\\Me\\.slock",
      "C:\\bin\\raft-computer.exe",
      {
        platform: "win32",
        userHome: "C:\\Users\\Me",
        runCommand: async (_command, _args, options) => {
          observedEnv = options?.env;
          return { stdout: "S-1-5-21-1\n", stderr: "" };
        },
      },
    );
  } finally {
    if (previous === undefined) delete process.env.PSModulePath;
    else process.env.PSModulePath = previous;
  }
  assert.ok(observedEnv);
  assert.equal(
    Object.keys(observedEnv).some(
      (key) => key.toLowerCase() === "psmodulepath",
    ),
    false,
  );
});

test("stop plans disable the OS owner before ending the service, so no restart policy can race", () => {
  const systemd = buildOsSupervisorSpec({
    platform: "linux",
    slockHome: home,
    binaryPath: binary,
    userHome: "/tmp/user",
    uid: 1000,
  });
  assert.deepEqual(buildSupervisorCommandPlan(systemd, "stop", { uid: 1000 }), [
    { command: "systemctl", args: ["--user", "disable", "--now", systemd.id] },
  ]);

  const launchd = buildOsSupervisorSpec({
    platform: "darwin",
    slockHome: home,
    binaryPath: binary,
    userHome: "/tmp/user",
    uid: 501,
  });
  assert.deepEqual(buildSupervisorCommandPlan(launchd, "stop", { uid: 501 }), [
    { command: "launchctl", args: ["disable", `gui/501/${launchd.id}`] },
    {
      command: "launchctl",
      args: ["bootout", `gui/501/${launchd.id}`],
      allowFailure: true,
    },
  ]);

  const windows = buildOsSupervisorSpec({
    platform: "win32",
    slockHome: "C:\\Users\\Me\\.slock",
    binaryPath: "C:\\bin\\raft-computer.exe",
    userHome: "C:\\Users\\Me",
    uid: null,
    windowsUserId: "S-1-5-21-1",
  });
  assert.deepEqual(buildSupervisorCommandPlan(windows, "stop", { uid: null }), [
    {
      command: "schtasks.exe",
      args: ["/Change", "/TN", windows.id, "/DISABLE"],
    },
    {
      command: "schtasks.exe",
      args: ["/End", "/TN", windows.id],
      allowFailure: true,
    },
  ]);
});

test("shipped supervisor surface can only inspect or retire managers, never create, start, or repair them", async () => {
  const cli = await readFile(join(import.meta.dirname, "cli.ts"), "utf8");
  const supervisorBlock = cli.slice(
    cli.indexOf("const supervisorCommand"),
    cli.indexOf("async function runCli"),
  );
  assert.match(supervisorBlock, /\.command\("retire-legacy"/);
  assert.doesNotMatch(supervisorBlock, /\.command\("(?:repair|status|start)"/);
  assert.doesNotMatch(supervisorBlock, /inspectOsSupervisor|mutateOsSupervisor/);

  const runtime = await readFile(
    join(import.meta.dirname, "osSupervisorRuntime.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    runtime,
    /export async function (?:inspectOsSupervisor|mutateOsSupervisor|reconcileOwnedOsSupervisorDefinition)/,
  );

  const plans = [
    buildSupervisorCommandPlan(
      buildOsSupervisorSpec({
        platform: "linux",
        slockHome: home,
        binaryPath: binary,
        userHome: "/tmp/user",
        uid: 1000,
      }),
      "stop",
      { uid: 1000 },
    ),
    buildSupervisorCommandPlan(
      buildOsSupervisorSpec({
        platform: "darwin",
        slockHome: home,
        binaryPath: binary,
        userHome: "/tmp/user",
        uid: 501,
      }),
      "status",
      { uid: 501 },
    ),
    buildSupervisorCommandPlan(
      buildOsSupervisorSpec({
        platform: "win32",
        slockHome: "C:\\Users\\Me\\.slock",
        binaryPath: "C:\\bin\\raft-computer.exe",
        userHome: "C:\\Users\\Me",
        uid: null,
        windowsUserId: "S-1-5-21-1",
      }),
      "status",
      { uid: null },
    ),
  ];
  const commandArgs = plans.flatMap((plan) => plan.flatMap((step) => step.args));
  for (const forbidden of [
    "enable",
    "bootstrap",
    "kickstart",
    "restart",
    "/Create",
    "/ENABLE",
    "/Run",
  ]) {
    assert.equal(commandArgs.includes(forbidden), false, `forbidden manager mutation ${forbidden}`);
  }
});

test("legacy supervisor retirement makes zero manager calls on a fresh POSIX install", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "raft-os-retire-fresh-"));
  t.onTestFinished(async () => rm(root, { recursive: true, force: true }));
  let managerCalls = 0;
  const result = await retireLegacyOsSupervisor(
    join(root, ".slock"),
    join(root, "bin", "raft-computer"),
    {
      platform: "linux",
      userHome: root,
      uid: 1000,
      runCommand: async () => {
        managerCalls += 1;
        throw new Error("fresh install must not touch systemd");
      },
    },
  );
  assert.equal(result.status, "absent");
  assert.equal(managerCalls, 0);
});

test("legacy launchd retirement unloads, deletes, and receipts exactly once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "raft-os-retire-launchd-"));
  t.onTestFinished(async () => rm(root, { recursive: true, force: true }));
  const slockHome = join(root, ".slock");
  const binaryPath = join(root, "bin", "raft-computer");
  const spec = buildOsSupervisorSpec({
    platform: "darwin",
    slockHome,
    binaryPath,
    userHome: root,
    uid: 501,
  });
  await mkdir(dirname(spec.definitionPath!), { recursive: true });
  await writeFile(spec.definitionPath!, spec.definition);
  const calls: string[] = [];
  const runCommand: SupervisorCommandRunner = async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "launchctl" && args[0] === "print") {
      throw new Error("Could not find service");
    }
    return { stdout: "", stderr: "" };
  };

  const first = await retireLegacyOsSupervisor(slockHome, binaryPath, {
    platform: "darwin",
    userHome: root,
    uid: 501,
    runCommand,
  });
  assert.equal(first.status, "retired");
  assert.equal(first.managerUnloaded, true);
  assert.equal(first.definitionRemoved, true);
  await assert.rejects(readFile(spec.definitionPath!, "utf8"), /ENOENT/);
  assert.match(
    await readFile(first.receiptPath, "utf8"),
    /"managerUnloaded": true/,
  );
  assert.ok(calls.some((call) => call.includes("launchctl bootout gui/501/")));

  const callsAfterFirst = calls.length;
  const replay = await retireLegacyOsSupervisor(slockHome, binaryPath, {
    platform: "darwin",
    userHome: root,
    uid: 501,
    runCommand,
  });
  assert.equal(replay.status, "already-retired");
  assert.equal(
    calls.length,
    callsAfterFirst,
    "receipt must suppress every later manager call",
  );
});

test("historical launchd ownership is anchored to label family, home, argv, and owner token", () => {
  const spec = buildOsSupervisorSpec({
    platform: "darwin",
    slockHome: home,
    binaryPath: binary,
    userHome: "/tmp/user",
    uid: 501,
  });
  assert.equal(
    isOwnedHistoricalLaunchdDefinition(home, spec.id, spec.definition),
    true,
  );
  assert.equal(
    isOwnedHistoricalLaunchdDefinition(home, "com.agiletortoise.Drafts", spec.definition),
    false,
    "a substring match for raft must not classify Drafts as a Computer job",
  );
  assert.equal(
    isOwnedHistoricalLaunchdDefinition("/tmp/other-home", spec.id, spec.definition),
    false,
  );
  assert.equal(
    isOwnedHistoricalLaunchdDefinition(
      home,
      spec.id,
      spec.definition.replace(spec.ownerToken, "raft-computer-os-supervisor-v1-0000000000000000"),
    ),
    false,
  );
});

test("stale retirement receipt cannot hide a later-discovered historical launchd label", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "raft-os-retire-stale-receipt-"));
  t.onTestFinished(async () => rm(root, { recursive: true, force: true }));
  const slockHome = join(root, ".slock");
  const binaryPath = join(root, "bin", "raft-computer");
  const spec = buildOsSupervisorSpec({
    platform: "darwin",
    slockHome,
    binaryPath,
    userHome: root,
    uid: 501,
  });
  await mkdir(dirname(spec.definitionPath!), { recursive: true });
  await writeFile(spec.definitionPath!, spec.definition);
  const calls: string[] = [];
  const runCommand: SupervisorCommandRunner = async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "launchctl" && args[0] === "print") {
      throw new Error("Could not find service");
    }
    return { stdout: "", stderr: "" };
  };
  const deps = {
    platform: "darwin" as const,
    userHome: root,
    uid: 501,
    runCommand,
  };

  assert.equal(
    (await retireLegacyOsSupervisor(slockHome, binaryPath, deps)).status,
    "retired",
  );
  const currentHash = spec.id.slice("build.raft.computer.".length);
  const historicalHash = currentHash === "0123456789abcdef"
    ? "fedcba9876543210"
    : "0123456789abcdef";
  const historicalId = `build.raft.computer.${historicalHash}`;
  const historicalPath = join(dirname(spec.definitionPath!), `${historicalId}.plist`);
  const historicalDefinition = spec.definition
    .replaceAll(spec.id, historicalId)
    .replaceAll(spec.ownerToken, `raft-computer-os-supervisor-v1-${historicalHash}`);
  await writeFile(historicalPath, historicalDefinition);

  const callsBeforeStaleReceiptReplay = calls.length;
  const staleReceiptReplay = await retireLegacyOsSupervisor(
    slockHome,
    binaryPath,
    deps,
  );
  assert.equal(staleReceiptReplay.status, "retired");
  assert.ok(calls.length > callsBeforeStaleReceiptReplay);
  assert.ok(
    calls.some((call) => call.includes(`bootout gui/501/${historicalId}`)),
  );
  await assert.rejects(readFile(historicalPath, "utf8"), /ENOENT/);

  const callsBeforeCleanReplay = calls.length;
  const cleanReplay = await retireLegacyOsSupervisor(slockHome, binaryPath, deps);
  assert.equal(cleanReplay.status, "already-retired");
  assert.equal(
    calls.length,
    callsBeforeCleanReplay,
    "a clean replay may scan definitions but must make zero manager calls",
  );
});

test("fresh launchd retirement ignores unanchored application labels with zero manager calls", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "raft-os-retire-anchored-"));
  t.onTestFinished(async () => rm(root, { recursive: true, force: true }));
  const launchAgents = join(root, "Library", "LaunchAgents");
  await mkdir(launchAgents, { recursive: true });
  await writeFile(join(launchAgents, "com.agiletortoise.Drafts.plist"), "raft");
  let managerCalls = 0;
  const result = await retireLegacyOsSupervisor(
    join(root, ".slock"),
    join(root, "bin", "raft-computer"),
    {
      platform: "darwin",
      userHome: root,
      uid: 501,
      runCommand: async () => {
        managerCalls += 1;
        throw new Error("unanchored definitions must not touch launchctl");
      },
    },
  );
  assert.equal(result.status, "absent");
  assert.equal(managerCalls, 0);
});

test("legacy Windows task pointing at install dir A is retired when installer moves to B", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "raft-os-retire-windows-ab-"));
  t.onTestFinished(async () => rm(root, { recursive: true, force: true }));
  const slockHome = join(root, "home");
  const binaryA = "C:\\old\\raft-computer.exe";
  const binaryB = "D:\\new\\raft-computer.exe";
  const specA = buildOsSupervisorSpec({
    platform: "win32",
    slockHome,
    binaryPath: binaryA,
    userHome: "C:\\Users\\Me",
    uid: null,
    windowsUserId: "S-1-5-21-1",
  });
  let present = true;
  const calls: string[] = [];
  const runCommand: SupervisorCommandRunner = async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "schtasks.exe" && args[0] === "/Delete") {
      present = false;
      return { stdout: "", stderr: "" };
    }
    if (command === "schtasks.exe" && args[0] === "/Query") {
      if (!present) {
        // With `/HRESULT` a missing task exits 0x80070002. The message is
        // deliberately still English here so this test cannot pass by matching
        // text — absence has to come from the typed code.
        throw Object.assign(
          new Error("ERROR: The system cannot find the task specified."),
          { code: 0x80070002 },
        );
      }
      return { stdout: specA.definition, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };

  const result = await retireLegacyOsSupervisor(slockHome, binaryB, {
    platform: "win32",
    userHome: "C:\\Users\\Me",
    windowsUserId: "S-1-5-21-1",
    runCommand,
  });
  assert.equal(result.status, "retired");
  assert.equal(result.id, specA.id, "manager identity must follow home, not install dir");
  assert.ok(calls.some((call) => call.includes("/Change") && call.includes("/DISABLE")));
  assert.ok(calls.some((call) => call.includes("/End")));
  assert.ok(calls.some((call) => call.includes("/Delete")));
  assert.match(await readFile(result.receiptPath, "utf8"), /"definitionRemoved": true/);
});

test("legacy supervisor cleanup failure is nonblocking and explicitly says Computer remains usable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "raft-os-retire-failure-"));
  t.onTestFinished(async () => rm(root, { recursive: true, force: true }));
  const slockHome = join(root, ".slock");
  const binaryPath = join(root, "bin", "raft-computer");
  const xdgConfigHome = join(root, ".config");
  const spec = buildOsSupervisorSpec({
    platform: "linux",
    slockHome,
    binaryPath,
    userHome: root,
    uid: 1000,
    xdgConfigHome,
  });
  await mkdir(dirname(spec.definitionPath!), { recursive: true });
  await writeFile(spec.definitionPath!, spec.definition);

  const result = await retireLegacyOsSupervisor(slockHome, binaryPath, {
    platform: "linux",
    userHome: root,
    uid: 1000,
    xdgConfigHome,
    runCommand: async () => {
      throw new Error("user bus unavailable");
    },
  });
  assert.equal(result.status, "incomplete");
  assert.match(result.message, /legacy_os_supervisor_cleanup_incomplete/);
  assert.match(result.message, /Computer remains usable/);
  assert.doesNotMatch(result.message, /service unavailable|start failed/i);
  assert.equal(await readFile(spec.definitionPath!, "utf8"), spec.definition);
});
