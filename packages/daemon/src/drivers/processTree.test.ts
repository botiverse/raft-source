import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { calibratedBootTimeMs, containerOffsetMs, readSelfStart, createProcessTreeOps, entriesStartedSince, killProcessTreeSnapshot, linuxClockTicksPerSecond, readDescendants, readProcessStartIdentity, readProcessStartIdentitySync, readProcessStartTimeMsSync, snapshotDescendants, snapshotProcessTree, taskkillTreeArgs } from "./processTree";

const rows = [
  { pid: 1, ppid: 0, pgid: 1 },
  { pid: 100, ppid: 1, pgid: 100 }, // the daemon
  { pid: 200, ppid: 100, pgid: 100 }, // the runtime, in the daemon's group
  { pid: 300, ppid: 200, pgid: 300 }, // a tool shell started detached
  { pid: 301, ppid: 300, pgid: 300 }, // the command, in the shell's group
  { pid: 302, ppid: 300, pgid: 302 }, // a child that called setsid
  { pid: 400, ppid: 1, pgid: 400 }, // unrelated
];

test("the snapshot is every descendant of the runtime, not the runtime, its parent or unrelated processes", async () => {
  const entries = await snapshotDescendants(200, { platform: "linux", ownPid: 100, listProcesses: async () => rows });

  assert.deepEqual(entries.map((entry) => entry.pid).sort(), [300, 301, 302]);
});

test("a root that is not this process's child is never walked", async () => {
  assert.deepEqual(await snapshotDescendants(300, { platform: "linux", ownPid: 100, listProcesses: async () => rows }), []);
  assert.deepEqual(await snapshotDescendants(999, { platform: "linux", ownPid: 100, listProcesses: async () => rows }), []);
});

test("readDescendants tells an unreadable tree (null) from one with no descendants ([])", async () => {
  const deps = { platform: "linux" as const, ownPid: 100, listProcesses: async () => rows };
  assert.deepEqual(await readDescendants(500, { ...deps, listProcesses: async () => [...rows, { pid: 500, ppid: 100, pgid: 500 }] }), []);
  assert.equal(await readDescendants(999, deps), null, "a root that is not this process's child");
  assert.equal(await readDescendants(200, { ...deps, listProcesses: async () => { throw new Error("EACCES"); } }), null);
  assert.equal(await readDescendants(200, { ...deps, platform: "win32" }), null);
  assert.deepEqual(await snapshotDescendants(200, { ...deps, platform: "win32" }), [], "the snapshot keeps its empty answer");
});

test("off Linux, psStartTimes reads every start from one `ps lstart` listing (C locale); an unparsable start stays unknown", async () => {
  const calls: Array<{ command: string; args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
  const psOutput = [
    "    1     0     1 Mon Nov  2 08:00:00 2026",
    "  100     1   100 Thu Nov  5 09:00:00 2026", // the daemon
    "  200   100   200 Thu Nov  5 09:00:05 2026", // the runtime
    "  300   200   300 Thu Nov  5 10:15:42 2026",
    "  301   300   300 garbled",
    "",
  ].join("\n");
  const entries = await readDescendants(200, {
    platform: "darwin",
    ownPid: 100,
    psStartTimes: true,
    runCommand: async (command, args, env) => { calls.push({ command, args, env }); return psOutput; },
  });
  assert.deepEqual(calls, [{ command: "ps", args: ["-A", "-o", "pid=,ppid=,pgid=,lstart="], env: { LC_ALL: "C" } }]);
  assert.deepEqual(entries, [
    { pid: 300, pgid: 300, startedAtMs: new Date(2026, 10, 5, 10, 15, 42).getTime() },
    { pid: 301, pgid: 300 },
  ]);
});

test("group leaders are killed as a group, other descendants by pid, and the daemon's group never", () => {
  const signalled: number[] = [];
  const entries = [
    { pid: 300, pgid: 300 },
    { pid: 301, pgid: 300 },
    { pid: 302, pgid: 302 },
    { pid: 500, pgid: 100 }, // a descendant left in the daemon's group
  ];

  killProcessTreeSnapshot(entries, { kill: (pid) => void signalled.push(pid), readStartTime: () => undefined });

  assert.deepEqual(signalled, [-300, 301, -302, 500]);
  assert.ok(!signalled.includes(-100), "the daemon's own group must not be signalled");
});

test("an entry whose pid now belongs to a newer process is skipped", () => {
  const signalled: number[] = [];

  killProcessTreeSnapshot([{ pid: 300, pgid: 300, startTime: "111" }, { pid: 301, pgid: 300, startTime: "222" }], {
    kill: (pid) => void signalled.push(pid),
    readStartTime: (pid) => (pid === 300 ? "999" : "222"),
  });

  assert.deepEqual(signalled, [301]);
});

test("Windows has no snapshot; the forced kill walks the live tree instead", async () => {
  assert.deepEqual(await snapshotDescendants(200, { platform: "win32", listProcesses: async () => rows }), []);
});

test("reconciler step 5: the snapshot says whether the runtime leads its own group; a reused or foreign pid never does", async () => {
  const groupRows = [
    { pid: 100, ppid: 1, pgid: 100 }, // the daemon
    { pid: 200, ppid: 100, pgid: 200 }, // the runtime, spawned detached
    { pid: 201, ppid: 200, pgid: 200 }, // an MCP server in its group
    { pid: 300, ppid: 1, pgid: 300 }, // someone else's group leader
  ];
  const tree = await snapshotProcessTree(200, { platform: "linux", ownPid: 100, listProcesses: async () => groupRows, bootTimeMs: () => undefined });
  assert.equal(tree.rootLeadsGroup, true);
  assert.deepEqual(tree.descendants.map((entry) => entry.pid), [201]);
  assert.equal((await snapshotProcessTree(300, { platform: "linux", ownPid: 100, listProcesses: async () => groupRows })).rootLeadsGroup, false);
  assert.equal((await snapshotProcessTree(200, { platform: "linux", ownPid: 100, listProcesses: async () => rows })).rootLeadsGroup, false, "a runtime in the daemon's group");
});

test("reconciler step 5: the forced kill signals the runtime's group once, plus what left it; never a group it does not lead", () => {
  const signalled: number[] = [];
  const ops = createProcessTreeOps({ platform: "linux", kill: (pid) => void signalled.push(pid), readStartTime: () => undefined });
  const descendants = [
    { pid: 201, pgid: 200 }, // in the runtime's group
    { pid: 300, pgid: 300 }, // a tool shell started detached
    { pid: 301, pgid: 300 },
  ];

  assert.equal(ops.forceKill(200, { descendants, rootLeadsGroup: true }), 4);
  assert.deepEqual(signalled, [-200, -300, 301]);

  signalled.length = 0;
  ops.forceKill(200, { descendants, rootLeadsGroup: false });
  assert.deepEqual(signalled, [201, -300, 301], "not a group leader: never -pid");
});

test("reconciler step 5 (Windows): the forced kill is `taskkill /PID <pid> /T /F` on the runtime, which walks the live tree", () => {
  const runs: string[][] = [];
  const signalled: number[] = [];
  const ops = createProcessTreeOps({ platform: "win32", taskkill: (args) => void runs.push([...args]), kill: (pid) => void signalled.push(pid) });

  assert.equal(ops.forceKill(4242, { descendants: [], rootLeadsGroup: false }), 1);
  assert.deepEqual(runs, [["/PID", "4242", "/T", "/F"]]);
  assert.deepEqual(taskkillTreeArgs(7), ["/PID", "7", "/T", "/F"]);
  assert.deepEqual(signalled, [], "no POSIX group signal on Windows");
  assert.equal(ops.forceKill(undefined, []), 0, "no pid, nothing to walk");
});

test(
  "real processes: a detached command and a setsid child below a killed root are all gone after the forced kill",
  { skip: process.platform === "win32" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "process-tree-"));
    const pids = join(dir, "pids");
    // root -> detached shell (own group) -> sleep + setsid sleep
    const root = spawn(
      process.execPath,
      ["-e", `require("child_process").spawn("sh", ["-c", "sleep 60 & echo $! >> ${pids}; setsid sleep 61 & echo $! >> ${pids}; wait"], { detached: true, stdio: "ignore" }); setInterval(() => {}, 1000);`],
      { stdio: "ignore" },
    );
    let leaves: number[] = [];
    for (let i = 0; i < 100 && leaves.length < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      leaves = (await readFile(pids, "utf8").catch(() => "")).split("\n").filter(Boolean).map(Number);
    }
    assert.equal(leaves.length, 2, "precondition: both leaves started");

    const ops = createProcessTreeOps();
    const snapshot = await ops.snapshotDescendants(root.pid!);
    root.kill("SIGKILL");
    ops.forceKill(root.pid, snapshot);

    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 100 && leaves.some(alive); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(leaves.filter(alive), [], "no leaf of the tree may survive");
  },
);

test("task #25 step 2: Linux start times become wall-clock times and select what a turn started", async () => {
  const timedRows = [
    { pid: 100, ppid: 1, pgid: 100 },
    { pid: 200, ppid: 100, pgid: 100 },
    { pid: 300, ppid: 200, pgid: 300, startTime: "1000" }, // 10 s after boot
    { pid: 301, ppid: 200, pgid: 301, startTime: "5000" }, // 50 s after boot
    { pid: 302, ppid: 200, pgid: 302 }, // unknown start
  ];
  const entries = await snapshotDescendants(200, {
    platform: "linux",
    ownPid: 100,
    listProcesses: async () => timedRows,
    bootTimeMs: () => 1_000_000,
    clockTicksPerSecond: () => 100,
  });
  assert.deepEqual(
    entries.map((entry) => [entry.pid, entry.startedAtMs]),
    [[300, 1_010_000], [301, 1_050_000], [302, undefined]],
  );

  const { selected, leftAlone } = entriesStartedSince(entries, 1_030_000);
  assert.deepEqual(selected.map((entry) => entry.pid), [301], "only what started at or after the turn's start");
  assert.equal(leftAlone, 2, "an older process and one of unknown age are left alone");
});

test("task #25 step 2: start times follow the kernel's USER_HZ, read once from getconf", async () => {
  const entries = await snapshotDescendants(200, {
    platform: "linux",
    ownPid: 100,
    listProcesses: async () => [
      { pid: 100, ppid: 1, pgid: 100 },
      { pid: 200, ppid: 100, pgid: 100 },
      { pid: 300, ppid: 200, pgid: 300, startTime: "1000" },
    ],
    bootTimeMs: () => 1_000_000,
    clockTicksPerSecond: () => 1_000,
  });
  assert.equal(entries[0]!.startedAtMs, 1_001_000, "1000 ticks at 1000 Hz is one second");
  if (process.platform === "linux") assert.ok(linuxClockTicksPerSecond() > 0);
});

test("boot time is calibrated from the daemon's own start, which an LXC container's /proc/uptime cannot shift", () => {
  // comm with spaces and parens; starttime (field 22) = 360_000 ticks = 3_600 s after boot.
  const selfStat = "1234 (node (raft) x) S 1 1234 1234 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 360000 0 0";
  const self = readSelfStart({ selfStat: () => selfStat, nowMs: () => 10_000_000, uptimeSeconds: () => 60 });
  assert.deepEqual(self, { wallMs: 10_000_000 - 60_000, ticks: 360_000 });
  // Started 60 s ago, 3_600 s after boot.
  assert.equal(calibratedBootTimeMs(self!, 100), 10_000_000 - 60_000 - 3_600_000);
  assert.equal(readSelfStart({ selfStat: () => "garbage", nowMs: () => 1, uptimeSeconds: () => 1 }), undefined);
});

test("only an LXC-sized gap between the two boot times is taken as the container's offset", () => {
  assert.equal(containerOffsetMs(1_000_000, 1_000_400), 0, "within a second: noise, keep /proc/uptime");
  assert.equal(containerOffsetMs(9_509_000, 1_000_000), 8_509_000, "container uptime: hours of offset");
  assert.equal(containerOffsetMs(undefined, 1_000_000), 0);
  assert.equal(containerOffsetMs(1_000_000, undefined), 0);
});

test("readProcessStartTimeMsSync: Linux start is boot time plus /proc starttime ticks", () => {
  const stat = "4242 (node (x) y) S 1 4242 4242 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 12345 0 0";
  assert.equal(
    readProcessStartTimeMsSync(4242, { platform: "linux", readProcStat: () => stat, bootTimeMs: () => 1_000_000, clockTicksPerSecond: () => 100 }),
    1_000_000 + 123_450,
  );
  assert.equal(readProcessStartTimeMsSync(4242, { platform: "linux", readProcStat: () => { throw new Error("ENOENT"); } }), undefined);
  assert.equal(readProcessStartTimeMsSync(4242, { platform: "linux", readProcStat: () => stat, bootTimeMs: () => undefined }), undefined);
});

test("readProcessStartTimeMsSync: Windows reads the CIM CreationDate as a UTC round-trip time", () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const started = readProcessStartTimeMsSync(10424, {
    platform: "win32",
    runCommandSync: (command, args) => {
      calls.push({ command, args });
      return "2026-11-11T09:00:00.1234567Z\r\n";
    },
  });
  assert.equal(started, Date.parse("2026-11-11T09:00:00.123Z"));
  assert.equal(calls[0]!.command, "powershell.exe");
  const script = calls[0]!.args.at(-1)!;
  assert.match(script, /Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=10424" -ErrorAction Stop\)\.CreationDate/);
  assert.match(script, /\$d\.ToUniversalTime\(\)\.ToString\('o'\)/);
  assert.doesNotMatch(script, /Get-Process/);
  assert.equal(readProcessStartTimeMsSync(10424, { platform: "win32", runCommandSync: () => "" }), undefined);
  assert.equal(readProcessStartTimeMsSync(10424, { platform: "win32", runCommandSync: () => { throw new Error("Access is denied"); } }), undefined);
});

test("readProcessStartTimeMsSync: Windows takes a DMTF CreationDate too", () => {
  assert.equal(
    readProcessStartTimeMsSync(10424, { platform: "win32", runCommandSync: () => "20261111170000.123456+480\r\n" }),
    Date.parse("2026-11-11T09:00:00.123Z"),
  );
});

test("readProcessStartTimeMsSync: other POSIX reads `ps -o lstart=` in the C locale", () => {
  const calls: Array<{ args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
  const started = readProcessStartTimeMsSync(321, {
    platform: "darwin",
    runCommandSync: (_command, args, env) => {
      calls.push({ args, env });
      return "Thu Nov  5 19:53:52 2026\n";
    },
  });
  assert.equal(started, new Date(2026, 10, 5, 19, 53, 52).getTime());
  assert.deepEqual(calls, [{ args: ["-o", "lstart=", "-p", "321"], env: { LC_ALL: "C" } }]);
  assert.equal(readProcessStartTimeMsSync(321, { platform: "darwin", runCommandSync: () => "" }), undefined);
  assert.equal(readProcessStartTimeMsSync(0, { platform: "darwin", runCommandSync: () => "Thu Nov  5 19:53:52 2026" }), undefined);
});

test.skipIf(process.platform === "win32")("readProcessStartTimeMsSync reads this process's real start, before now", () => {
  const started = readProcessStartTimeMsSync(process.pid);
  assert.ok(started !== undefined);
  const expected = Date.now() - process.uptime() * 1000;
  assert.ok(Math.abs(started - expected) < 5_000, `start ${started} vs expected ${expected}`);
});

test("readProcessStartIdentitySync: Linux is the starttime ticks within a boot id and the reader's pid namespace, no clock read", () => {
  const stat = "4242 (node (x) y) S 1 4242 4242 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 12345 0 0";
  const deps = {
    platform: "linux" as const,
    readProcStat: () => stat,
    readBootId: () => "5c0d1b1e-0000-4000-8000-000000000001\n",
    readPidNamespace: () => "pid:[4026531836]",
    readTimeNamespace: () => "time:[4026531834]",
    readSelfStat: () => "7 (node) S 1 7 7 0 -1 0",
    selfPid: 7,
    bootTimeMs: () => { throw new Error("the identity must not depend on the boot time"); },
  };
  assert.deepEqual(readProcessStartIdentitySync(4242, deps), {
    platform: "linux",
    value: "12345",
    bootId: "5c0d1b1e-0000-4000-8000-000000000001",
    pidNamespace: "pid:[4026531836]",
    timeNamespace: "time:[4026531834]",
  });
  // Older kernels have no ns/time; unreadable namespaces are left out.
  assert.deepEqual(readProcessStartIdentitySync(4242, {
    ...deps,
    readPidNamespace: () => { throw new Error("EACCES"); },
    readTimeNamespace: () => { throw new Error("ENOENT"); },
  }), {
    platform: "linux",
    value: "12345",
    bootId: "5c0d1b1e-0000-4000-8000-000000000001",
  });
  // /proc of an outer pid namespace (`unshare -pf` without --mount-proc):
  // /proc/self/stat names another process, so nothing there is trusted.
  assert.equal(readProcessStartIdentitySync(4242, { ...deps, readSelfStat: () => "1534913 (node) S 1 1 1 0 -1 0" }), undefined);
  assert.equal(readProcessStartIdentitySync(4242, { ...deps, readSelfStat: () => { throw new Error("ENOENT"); } }), undefined);
  assert.equal(readProcessStartIdentitySync(4242, { ...deps, readBootId: () => "" }), undefined);
  assert.equal(readProcessStartIdentitySync(4242, { ...deps, readProcStat: () => { throw new Error("ENOENT"); } }), undefined);
  assert.equal(readProcessStartIdentitySync(4242, { ...deps, readProcStat: () => "garbage" }), undefined);
});

test("readProcessStartIdentitySync: Windows is the CIM CreationDate in UTC microseconds; other POSIX `ps lstart` epoch ms", () => {
  const calls: string[] = [];
  const win = (text: string) => readProcessStartIdentitySync(10424, {
    platform: "win32",
    runCommandSync: (command, args) => {
      calls.push(`${command} ${args.at(-1)}`);
      return text;
    },
  });
  const micros = String(Date.UTC(2026, 10, 11, 9, 0, 0) * 1000 + 123_456);
  assert.deepEqual(win("2026-11-11T09:00:00.1234567Z\r\n"), { platform: "win32", value: micros });
  // The same instant in DMTF form is the same identity.
  assert.deepEqual(win("20261111170000.123456+480"), { platform: "win32", value: micros });
  assert.equal(win(""), undefined);
  assert.match(calls[0]!, /^powershell\.exe .*Win32_Process -Filter "ProcessId=10424"/);

  assert.deepEqual(
    readProcessStartIdentitySync(321, { platform: "darwin", runCommandSync: () => "Thu Nov  5 19:53:52 2026\n" }),
    { platform: "darwin", value: String(new Date(2026, 10, 5, 19, 53, 52).getTime()) },
  );
  assert.equal(readProcessStartIdentitySync(321, { platform: "darwin", runCommandSync: () => { throw new Error("exit 1"); } }), undefined);
  for (const pid of [0, -1, 1.5, Number.NaN]) {
    assert.equal(readProcessStartIdentitySync(pid, { platform: "win32", runCommandSync: () => { throw new Error(`must not run for ${pid}`); } }), undefined);
  }
});

test.skipIf(process.platform === "win32")("readProcessStartIdentitySync reads the same identity for this process twice", () => {
  const first = readProcessStartIdentitySync(process.pid);
  assert.ok(first);
  assert.equal(first.platform, process.platform);
  assert.deepEqual(readProcessStartIdentitySync(process.pid), first);
});

test("readProcessStartIdentity (async) runs the same command and yields the same identity as the sync read; never rejects", async () => {
  for (const [platform, output] of [["win32", "20261111170000.123456+480\r\n"], ["darwin", "Thu Nov  5 19:53:52 2026\n"]] as const) {
    const syncCalls: unknown[] = [];
    const asyncCalls: unknown[] = [];
    const sync = readProcessStartIdentitySync(4242, { platform, runCommandSync: (command, args, env) => { syncCalls.push({ command, args, env }); return output; } });
    const viaAsync = await readProcessStartIdentity(4242, { platform, runCommand: async (command, args, env) => { asyncCalls.push({ command, args, env }); return output; } });
    assert.ok(sync);
    assert.deepEqual(viaAsync, sync, platform);
    assert.deepEqual(asyncCalls, syncCalls, platform);
    assert.equal(await readProcessStartIdentity(4242, { platform, runCommand: async () => { throw new Error("timed out"); } }), undefined);
  }
  assert.equal(await readProcessStartIdentity(0, { platform: "win32", runCommand: async () => { throw new Error("must not run"); } }), undefined);
});

test.skipIf(process.platform === "win32" || process.platform === "linux")("readProcessStartIdentity (async, real ps) equals the sync read for this process", async () => {
  assert.deepEqual(await readProcessStartIdentity(process.pid), readProcessStartIdentitySync(process.pid));
});
