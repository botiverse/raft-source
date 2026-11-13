import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import type { RunnerRecord } from "./lib/runnerStateMachine";
import { shutdownService } from "./lib/serviceShutdown";
import {
  serverAttachmentPath,
  serverConnectedMarkerPath,
  serverRunnerLockConflictPath,
  serverRunnerLockConflictReportPath,
  serverRunnerPidPath,
  serverRunnerStopIntentPath,
  serverRunnerVersionPath,
} from "./paths";
import {
  claimRunnerLockConflictReports,
  deferredLockOwner,
  describeDeferredOwnerNotStopped,
  lockAgeDaysBucket,
  readRunnerLockConflictMarker,
  type DeferredOwnerIdentity,
} from "./runnerLockConflict";
import {
  stopUnmanagedRunner,
  handleRunnerExitForSupervisor,
  parseDaemonLockConflictLockPath,
  parseDaemonLockConflictOwnerPid,
  parseDaemonLockConflictOwnerStartedAt,
  parseDaemonLockConflictOwnerStartReadable,
} from "./service";

const SERVER = "33333333-3333-4333-8333-333333333333";
const LOCK_PATH = "C:\\Users\\me\\.slock\\machines\\machine-e64f259009a007e0\\daemon.lock";
const CONFLICT_TEXT =
  "raft-computer: Another Slock daemon is already running for this machine key " +
  `(pid=10424, startedAt=2026-10-28T05:35:31.074Z, host=DESKTOP-F431GV8). Lock: ${LOCK_PATH}. ` +
  "Stop the existing daemon first, or use a different machine key/state directory.\n";

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "computer-lock-conflict-"));
  try {
    await mkdir(join(serverRunnerPidPath(home, SERVER), ".."), { recursive: true });
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function exitOnConflict(
  home: string,
  diagnosticText: string,
  ownerAlive: boolean,
): Promise<{ rec: RunnerRecord; transitions: string[]; reconciles: number[] }> {
  const rec: RunnerRecord = { serverId: SERVER, lifecycle: "starting", stopping: false };
  const transitions: string[] = [];
  const reconciles: number[] = [];
  await handleRunnerExitForSupervisor({
    slockHome: home,
    serverId: SERVER,
    rec,
    code: 1,
    signal: null,
    diagnosticText,
    isOwnerProcessAlive: () => ownerAlive,
    emitTransition: (_id, from, to, trigger) => transitions.push(`${from}->${to}:${trigger}`),
    scheduleReconcile: (ms) => reconciles.push(ms),
    writeStderr: () => {},
    nowMs: () => 1_700_000_000_000,
  });
  return { rec, transitions, reconciles };
}

test("the daemon's lock conflict error names the owner pid and the lock directory", () => {
  assert.equal(parseDaemonLockConflictOwnerPid(CONFLICT_TEXT), 10424);
  assert.equal(parseDaemonLockConflictLockPath(CONFLICT_TEXT), LOCK_PATH);
  assert.equal(parseDaemonLockConflictLockPath("Another Slock daemon is already running (unknown owner)."), null);
  assert.equal(parseDaemonLockConflictLockPath(`crash. Lock: ${LOCK_PATH}. Stop the existing daemon first`), null);
});

test("deferring to a live lock owner records the conflict for start, bound to this service, and does not respawn", async () => {
  await withHome(async (home) => {
    const { rec, transitions, reconciles } = await exitOnConflict(home, CONFLICT_TEXT, true);
    assert.equal(rec.lifecycle, "running");
    assert.equal(rec.externalPid, 10424);
    assert.deepEqual(reconciles, [], "no restart is scheduled: no tight loop");
    assert.deepEqual(transitions, ["starting->running:exit-already-running"]);
    assert.equal((await readFile(serverRunnerPidPath(home, SERVER), "utf8")).trim(), "10424");
    assert.deepEqual(readRunnerLockConflictMarker(serverRunnerLockConflictPath(home, SERVER)), {
      servicePid: process.pid,
      ownerPid: 10424,
      lockPath: LOCK_PATH,
      recordedAt: 1_700_000_000_000,
    });
  });
});

test("an owner gone during handoff clears the record and retries once after the backoff", async () => {
  await withHome(async (home) => {
    await writeFile(serverRunnerLockConflictPath(home, SERVER), JSON.stringify({ servicePid: process.pid, ownerPid: 10424, lockPath: null, recordedAt: 1 }));
    const { rec, reconciles } = await exitOnConflict(home, CONFLICT_TEXT, false);
    assert.equal(rec.lifecycle, "stopped");
    assert.equal(reconciles.length, 1);
    assert.ok(reconciles[0]! > 0, "the retry waits for the restart backoff");
    assert.equal(readRunnerLockConflictMarker(serverRunnerLockConflictPath(home, SERVER)), null);
  });
});

test("a conflict with no identifiable owner parks the runner and records an unknown owner", async () => {
  await withHome(async (home) => {
    const { rec, reconciles } = await exitOnConflict(home, "Another Slock daemon is already running for this machine key (unknown owner).", true);
    assert.equal(rec.lifecycle, "degraded");
    assert.deepEqual(reconciles, []);
    assert.deepEqual(readRunnerLockConflictMarker(serverRunnerLockConflictPath(home, SERVER)), {
      servicePid: process.pid,
      ownerPid: null,
      lockPath: null,
      recordedAt: 1_700_000_000_000,
    });
  });
});

// Who the lock owner is: for display and messages only. A runner that
// outlived its service holds the lock and has left its own version evidence;
// an unrelated program that got a dead runner's pid carries the same files
// but started after them; a start that cannot be read (always on Linux) and a
// pid no evidence names are each their own answer.
const EVIDENCE_AT = "2026-11-13T08:00:00.000Z";

async function writeRunnerEvidence(home: string, pid = 10424): Promise<void> {
  await writeFile(serverRunnerVersionPath(home, SERVER), JSON.stringify({ version: "1.22.0", installRoot: "/raft", pid, writtenAt: EVIDENCE_AT }));
}

test("who a deferred-to owner is, judged from its evidence and its start on every call; nothing in the record vouches for it", async () => {
  await withHome(async (home) => {
    await writeRunnerEvidence(home);
    await writeFile(serverRunnerPidPath(home, SERVER), "10424");
    const markerPath = serverRunnerLockConflictPath(home, SERVER);
    const record = (extra: Record<string, unknown> = {}) =>
      writeFile(markerPath, JSON.stringify({ servicePid: process.pid, ownerPid: 10424, lockPath: null, recordedAt: 1, ...extra }));
    const earlier = Date.parse(EVIDENCE_AT) - 2_000;
    const later = Date.parse(EVIDENCE_AT) + 10 * 60_000;
    const who = async (startedAtMs: number | undefined) => {
      let reads = 0;
      const owner = await deferredLockOwner(home, SERVER, { isAlive: () => true, processStartTimeMs: async () => { reads += 1; return startedAtMs; } });
      return { identity: owner?.identity, connected: owner?.connected, reads };
    };

    await record();
    assert.deepEqual(await who(earlier), { identity: "own-runner", connected: false, reads: 1 });
    assert.deepEqual(await who(later), { identity: "another-program", connected: false, reads: 1 });
    assert.deepEqual(await who(undefined), { identity: "unread", connected: false, reads: 1 });
    assert.deepEqual(await who(Number.NaN), { identity: "unread", connected: false, reads: 1 });

    // Connected is a separate question: its own marker.
    await writeFile(serverConnectedMarkerPath(home, SERVER), JSON.stringify({ pid: 10424, connectedAt: 1 }));
    assert.deepEqual(await who(earlier), { identity: "own-runner", connected: true, reads: 1 });

    // A verdict left in the record by an earlier build, in either shape: the
    // record is still read, the verdict is not. The pid is a later process's.
    for (const leftover of [
      { ownerVerdict: { owner: "own-runner", evidenceAt: EVIDENCE_AT } },
      { ownerVerdict: { owner: "own-runner", evidenceAt: null } },
      { owner: "runner", ownerEvidenceAt: EVIDENCE_AT },
    ]) {
      await record(leftover);
      assert.deepEqual(readRunnerLockConflictMarker(markerPath), { servicePid: process.pid, ownerPid: 10424, lockPath: null, recordedAt: 1 });
      assert.deepEqual(await who(later), { identity: "another-program", connected: true, reads: 1 }, JSON.stringify(leftover));
    }

    // No evidence names the pid: nothing to compare a start with, so none is read.
    await writeRunnerEvidence(home, 999999999);
    assert.deepEqual(await who(earlier), { identity: "unknown", connected: true, reads: 0 });

    // A record an earlier service left whose pid is no longer the one in runner.pid, or is gone, names nobody.
    await writeFile(serverRunnerPidPath(home, SERVER), "4242");
    assert.equal(await deferredLockOwner(home, SERVER, { isAlive: () => true }), null);
    await writeFile(serverRunnerPidPath(home, SERVER), "10424");
    assert.equal(await deferredLockOwner(home, SERVER, { isAlive: () => false }), null);
  });
});

test("what stop and detach say about an owner left running: its own words only for this server's runner whose start was read", () => {
  assert.equal(
    describeDeferredOwnerNotStopped({ pid: 7720, identity: "own-runner" }, "win32"),
    "this server's runner (pid 7720), started by an earlier Computer service, is still running and was not stopped. " +
      "Check it with `Get-CimInstance Win32_Process -Filter \"ProcessId=7720\" | Format-List ProcessId,Name,CreationDate,ExecutablePath`; ending that process stops it.",
  );
  const others: DeferredOwnerIdentity[] = ["another-program", "unread", "unknown"];
  for (const identity of others) {
    const line = describeDeferredOwnerNotStopped({ pid: 7720, identity }, "darwin");
    assert.equal(
      line,
      "Not stopped: pid 7720 holds this machine's daemon lock and was not started by this Computer service, so it was not signalled. " +
        "Check whether pid 7720 is really a Raft daemon with `ps -o pid,lstart,command -p 7720`. If it is, stop that daemon yourself.",
      identity,
    );
  }
});

// The service signals only processes it started. The pid it deferred to came
// from a lock file: on a real Windows machine it was explorer.exe, and a
// SIGTERM ends a Windows process outright.

/** Every signal sent through process.kill while `run` runs: none reaches a real process. */
async function recordingProcessKill(run: () => Promise<void>): Promise<string[]> {
  const sent: string[] = [];
  const realKill = process.kill;
  process.kill = ((pid: number, signal?: string | number) => {
    if (signal === 0 || signal === undefined) return realKill.call(process, pid, 0);
    sent.push(`${pid}:${signal}`);
    return true;
  }) as typeof process.kill;
  try {
    await run();
  } finally {
    process.kill = realKill;
  }
  return sent;
}

function ownRunner(pid: number, signals: string[]): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid,
    kill: (signal: NodeJS.Signals) => { signals.push(`child ${pid}:${signal}`); return true; },
  }) as unknown as ChildProcess;
}

test("a server leaving the managed set never signals the lock owner the service deferred to: it forgets it and says so", async () => {
  await withHome(async (home) => {
    // Also when every file says that owner is this server's own runner: no evidence authorises a signal.
    await writeRunnerEvidence(home);
    await writeFile(serverConnectedMarkerPath(home, SERVER), JSON.stringify({ pid: 10424, connectedAt: 1 }));
    const { rec } = await exitOnConflict(home, CONFLICT_TEXT, true);
    assert.equal(rec.externalPid, 10424);
    const transitions: string[] = [];
    const log: string[] = [];
    const sent = await recordingProcessKill(() => stopUnmanagedRunner({
      slockHome: home,
      rec,
      emitTransition: (_id, from, to, trigger) => transitions.push(`${from}->${to}:${trigger}`),
      writeStderr: (text) => log.push(text),
    }));
    assert.deepEqual(sent, [], "no signal to a pid this service did not start");
    assert.equal(rec.externalPid, undefined);
    assert.equal(rec.lifecycle, "stopped");
    assert.equal(rec.stopping, false);
    assert.deepEqual(transitions, ["running->stopped:operator-stop"]);
    assert.equal(existsSync(serverRunnerPidPath(home, SERVER)), false, "the pid the service wrote for it is gone");
    assert.equal(readRunnerLockConflictMarker(serverRunnerLockConflictPath(home, SERVER)), null);
    assert.equal(existsSync(serverRunnerStopIntentPath(home, SERVER)), false, "no stop intent addressed to it");
    assert.match(log.join(""), /^Service: server 33333333-3333-4333-8333-333333333333 is no longer managed\. Not stopped: pid 10424 holds this machine's daemon lock and was not started by this Computer service, so it was not signalled\. Check whether pid 10424 is really a Raft daemon with `[^`]*10424[^`]*`\. If it is, stop that daemon yourself\.\n$/);
  });
});

test("a server leaving the managed set still stops the runner this service started, as before", async () => {
  await withHome(async (home) => {
    const signals: string[] = [];
    const rec: RunnerRecord = { serverId: SERVER, lifecycle: "running", stopping: false, child: ownRunner(4242, signals) };
    const sent = await recordingProcessKill(() => stopUnmanagedRunner({ slockHome: home, rec, emitTransition: () => {}, writeStderr: () => {} }));
    assert.deepEqual(signals, ["child 4242:SIGTERM"]);
    assert.deepEqual(sent, []);
    assert.equal(rec.stopping, true, "its exit is an operator stop, not a crash");
    assert.deepEqual(JSON.parse(await readFile(serverRunnerStopIntentPath(home, SERVER), "utf8")), { pid: 4242, source: "service_unmanaged" });
  });
});

test("service shutdown signals its own runners and leaves a deferred-to lock owner alone, without waiting for it", async () => {
  const signals: string[] = [];
  let waits = 0;
  const own: RunnerRecord = { serverId: "own", lifecycle: "running", stopping: false };
  own.child = Object.assign(new EventEmitter(), {
    pid: 4242,
    kill: (signal: NodeJS.Signals) => { signals.push(`child 4242:${signal}`); own.child = undefined; return true; },
  }) as unknown as ChildProcess;
  const deferred: RunnerRecord = { serverId: "deferred", lifecycle: "running", stopping: false, externalPid: 10424 };
  const warnings: string[] = [];
  const sent = await recordingProcessKill(() => shutdownService({
    runners: new Map([["own", own], ["deferred", deferred]]),
    closeIpc: () => undefined,
    isProcessAlive: () => true,
    clearServicePidfile: async () => {},
    restartRequested: false,
    sleep: async () => { waits += 1; },
    writeWarning: (message) => warnings.push(message),
    exit: () => {},
  }));
  assert.equal(waits, 0, "the child is gone: the live lock owner holds nothing up");
  assert.deepEqual(signals, ["child 4242:SIGTERM"]);
  assert.deepEqual(sent, [], "no signal to a pid this service did not start");
  assert.equal(deferred.externalPid, 10424, "left recorded: status keeps showing the lock's holder");
  assert.match(warnings.join(""), /external machine-lock owner pid 10424 still live at shutdown \(unproven; not killing\)/);
});

// Telemetry relay: the conflicted runner exits at once, so the service
// leaves a coarse report that the next connected runner claims and emits as
// daemon.machine_lock.conflict.

// The owner's lock is 44 days older than the conflict (exitOnConflict's clock).
const NEW_CONFLICT_TEXT = CONFLICT_TEXT
  .replace("startedAt=2026-10-28T05:35:31.074Z", "startedAt=2023-10-01T00:00:00.000Z")
  .replace("host=DESKTOP-F431GV8)", "host=DESKTOP-F431GV8, ownerStart=unreadable)");
const NOW_MS = 1_700_000_000_000;

async function writeAttachment(home: string, serverId: string): Promise<void> {
  const file = serverAttachmentPath(home, serverId);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, JSON.stringify({
    kind: "computer-attachment",
    serverId,
    serverSlug: `s-${serverId.slice(0, 4)}`,
    serverMachineId: `cm-${serverId}`,
    apiKey: `sk_computer_${serverId}`,
    serverUrl: "https://api.example.test",
  }), { mode: 0o600 });
}

test("the daemon's conflict error says the owner's startedAt and whether its start was readable; an older daemon's does not", () => {
  assert.equal(parseDaemonLockConflictOwnerStartedAt(NEW_CONFLICT_TEXT), "2023-10-01T00:00:00.000Z");
  assert.equal(parseDaemonLockConflictOwnerStartedAt(CONFLICT_TEXT), "2026-10-28T05:35:31.074Z");
  assert.equal(parseDaemonLockConflictOwnerStartReadable(NEW_CONFLICT_TEXT), false);
  assert.equal(parseDaemonLockConflictOwnerStartReadable(NEW_CONFLICT_TEXT.replace("=unreadable", "=readable")), true);
  assert.equal(parseDaemonLockConflictOwnerStartReadable(CONFLICT_TEXT), null);
  assert.equal(parseDaemonLockConflictOwnerStartedAt("crash startedAt=2026-10-28T05:35:31.074Z"), null);
  // The pid and lock parsers still read the longer owner text.
  assert.equal(parseDaemonLockConflictOwnerPid(NEW_CONFLICT_TEXT), 10424);
  assert.equal(parseDaemonLockConflictLockPath(NEW_CONFLICT_TEXT), LOCK_PATH);
});

test("lock age buckets are coarse days, unknown without a sane startedAt", () => {
  const day = 24 * 60 * 60 * 1000;
  const at = (ageMs: number) => lockAgeDaysBucket(new Date(NOW_MS - ageMs).toISOString(), NOW_MS);
  assert.equal(at(0), "lt_1");
  assert.equal(at(day - 1), "lt_1");
  assert.equal(at(day), "1_to_7");
  assert.equal(at(7 * day), "7_to_30");
  assert.equal(at(30 * day), "gt_30");
  assert.equal(at(-1), "unknown");
  assert.equal(lockAgeDaysBucket(null, NOW_MS), "unknown");
  assert.equal(lockAgeDaysBucket("garbage", NOW_MS), "unknown");
});

test("a recorded conflict leaves one coarse report, claimed once by whichever runner flushes first", async () => {
  await withHome(async (home) => {
    await writeAttachment(home, SERVER);
    await exitOnConflict(home, NEW_CONFLICT_TEXT, true);
    const raw = await readFile(serverRunnerLockConflictReportPath(home, SERVER), "utf8");
    // Only coarse facts on disk: no pid, no path, no ids.
    assert.deepEqual(JSON.parse(raw), { ownerStartReadable: false, lockAgeDays: "gt_30" });
    const [first, second] = await Promise.all([claimRunnerLockConflictReports(home), claimRunnerLockConflictReports(home)]);
    assert.deepEqual([...first, ...second], [{ ownerStartReadable: false, lockAgeDays: "gt_30" }]);
    assert.deepEqual(await claimRunnerLockConflictReports(home), []);
    // The record start reads stays.
    assert.ok(readRunnerLockConflictMarker(serverRunnerLockConflictPath(home, SERVER)));
  });
});

test("reports of every attached server are claimed; an older daemon's error reports readability unknown", async () => {
  await withHome(async (home) => {
    const OTHER = "44444444-4444-4444-8444-444444444444";
    await writeAttachment(home, SERVER);
    await writeAttachment(home, OTHER);
    await exitOnConflict(home, CONFLICT_TEXT, true);
    await writeFile(serverRunnerLockConflictReportPath(home, OTHER), JSON.stringify({ ownerStartReadable: true, lockAgeDays: "lt_1" }));
    const reports = await claimRunnerLockConflictReports(home);
    // CONFLICT_TEXT's startedAt is after exitOnConflict's clock: no sane age.
    assert.deepEqual(reports.sort((a, b) => a.lockAgeDays.localeCompare(b.lockAgeDays)), [
      { ownerStartReadable: true, lockAgeDays: "lt_1" },
      { ownerStartReadable: null, lockAgeDays: "unknown" },
    ]);
  });
});

test("an owner gone during handoff is no lasting conflict: nothing to report", async () => {
  await withHome(async (home) => {
    await writeAttachment(home, SERVER);
    await exitOnConflict(home, NEW_CONFLICT_TEXT, false);
    assert.deepEqual(await claimRunnerLockConflictReports(home), []);
  });
});

test("a conflict with no identifiable owner is reported too", async () => {
  await withHome(async (home) => {
    await writeAttachment(home, SERVER);
    await exitOnConflict(home, "Another Slock daemon is already running for this machine key (unknown owner).", true);
    assert.deepEqual(await claimRunnerLockConflictReports(home), [{ ownerStartReadable: null, lockAgeDays: "unknown" }]);
  });
});
