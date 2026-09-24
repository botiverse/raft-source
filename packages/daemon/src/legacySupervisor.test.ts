import assert from "node:assert/strict";
import { test } from "vitest";
import {
  detectLegacyDaemonSupervisorWithProbe,
  type LegacyDaemonSupervisorProbe,
} from "./legacySupervisor.js";

function probe(
  overrides: Partial<LegacyDaemonSupervisorProbe> = {},
): LegacyDaemonSupervisorProbe {
  return {
    pid: 42,
    platform: "linux",
    env: {},
    execFile: (file, args) => {
      if (file === "ps" && args[1] === "ppid=") return "1\n";
      return undefined;
    },
    readFile: () => undefined,
    ...overrides,
  };
}

test("detectLegacyDaemonSupervisor returns exact PM2 delete guidance", () => {
  const result = detectLegacyDaemonSupervisorWithProbe(
    probe({
      env: { PM2_HOME: "/tmp/pm2" },
      execFile: (file, args) => {
        if (file === "ps" && args[1] === "ppid=") return "1\n";
        if (file === "pm2" && args[0] === "jlist") {
          return JSON.stringify([{ name: "legacy daemon", pid: 42 }]);
        }
        return undefined;
      },
    }),
  );

  assert.deepEqual(result, {
    kind: "pm2",
    detail: 'PM2 app "legacy daemon" is supervising this legacy daemon.',
    cleanupCommands: ["pm2 delete 'legacy daemon'", "pm2 save"],
  });
});

test("detectLegacyDaemonSupervisor quotes PM2 app names", () => {
  const result = detectLegacyDaemonSupervisorWithProbe(
    probe({
      env: { pm_id: "0" },
      execFile: (file, args) => {
        if (file === "ps" && args[1] === "ppid=") return "1\n";
        if (file === "pm2")
          return JSON.stringify([{ name: "legacy's daemon", pid: 42 }]);
        return undefined;
      },
    }),
  );

  assert.equal(result?.cleanupCommands[0], "pm2 delete 'legacy'\\''s daemon'");
});

test("detectLegacyDaemonSupervisor resolves a user systemd unit from cgroup", () => {
  const result = detectLegacyDaemonSupervisorWithProbe(
    probe({
      readFile: (file) =>
        file === "/proc/42/cgroup"
          ? "0::/user.slice/user-1000.slice/user@1000.service/app.slice/raft-daemon.service\n"
          : undefined,
    }),
  );

  assert.deepEqual(result, {
    kind: "systemd",
    detail:
      'systemd unit "raft-daemon.service" is supervising this legacy daemon.',
    cleanupCommands: ["systemctl --user disable --now 'raft-daemon.service'"],
  });
});

test("detectLegacyDaemonSupervisor resolves a launchd label", () => {
  const result = detectLegacyDaemonSupervisorWithProbe(
    probe({
      platform: "darwin",
      env: { XPC_SERVICE_NAME: "com.botiverse.raft-daemon" },
    }),
  );

  assert.deepEqual(result, {
    kind: "launchd",
    detail:
      'launchd job "com.botiverse.raft-daemon" is supervising this legacy daemon.',
    cleanupCommands: [
      "launchctl bootout gui/$(id -u)/'com.botiverse.raft-daemon'",
      "rm -f ~/Library/LaunchAgents/'com.botiverse.raft-daemon.plist'",
    ],
  });
});

test("detectLegacyDaemonSupervisor returns undefined without supervisor evidence", () => {
  let pm2Called = false;
  const result = detectLegacyDaemonSupervisorWithProbe(
    probe({
      execFile: (file, args) => {
        if (file === "pm2") pm2Called = true;
        if (file === "ps" && args[1] === "ppid=") return "1\n";
        return undefined;
      },
    }),
  );

  assert.equal(result, undefined);
  assert.equal(
    pm2Called,
    false,
    "PM2 must not be started just to probe an unrelated daemon",
  );
});

test("detectLegacyDaemonSupervisor ignores an ordinary systemd user-session cgroup", () => {
  const result = detectLegacyDaemonSupervisorWithProbe(
    probe({
      execFile: (file, args) => {
        if (file === "ps" && args[1] === "ppid=")
          return args[3] === "42" ? "9\n" : "1\n";
        if (file === "ps" && args[1] === "command=")
          return "/usr/lib/systemd/systemd --user\n";
        return undefined;
      },
      readFile: () =>
        "0::/user.slice/user-1000.slice/user@1000.service/app.slice/vte-spawn.scope\n",
    }),
  );

  assert.equal(result, undefined);
});
