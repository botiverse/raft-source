// Reconciler step 5, the orphan sweep. RED proof (reverse-verified): drop the
// start-identity comparison in reapOne and the reused-pid test signals an
// unrelated process; drop the SIGKILL of the group and the real orphan (and
// its grandchild) survives.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProcessIdentity } from "./processTree";
import { reapRecordedOrphans, RuntimeProcessLedger, RUNTIME_PROCESS_LEDGER_FILE, type RuntimeProcessRecord } from "./runtimeProcessLedger";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(file: string): Promise<number> {
  for (let i = 0; i < 200; i += 1) {
    const pid = Number((await readFile(file, "utf8").catch(() => "")).trim());
    if (pid > 0) return pid;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no pid in ${file}`);
}

/**
 * What a crashed daemon leaves: a runtime in its own process group that
 * ignores SIGTERM, with a grandchild `sleep` in the group, whose parent is
 * gone (it was reparented).
 */
async function leaveOrphan(dir: string): Promise<{ runtimePid: number; grandchildPid: number }> {
  const runtimePidFile = join(dir, "runtime.pid");
  const grandchildPidFile = join(dir, "grandchild.pid");
  const runtimeScript = [
    `process.on("SIGTERM", () => {});`,
    `const c = require("child_process").spawn("sleep", ["60"], { stdio: "ignore" });`,
    `require("fs").writeFileSync(${JSON.stringify(grandchildPidFile)}, String(c.pid));`,
    `setInterval(() => {}, 1000);`,
  ].join("\n");
  const daemonScript = [
    `const r = require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(runtimeScript)}], { detached: true, stdio: "ignore" });`,
    `require("fs").writeFileSync(${JSON.stringify(runtimePidFile)}, String(r.pid));`,
    `r.unref();`,
  ].join("\n");
  const daemon = spawn(process.execPath, ["-e", daemonScript], { stdio: "ignore" });
  await new Promise((resolve) => daemon.on("exit", resolve));
  const runtimePid = await readPid(runtimePidFile);
  const grandchildPid = await readPid(grandchildPidFile);
  onTestFinished(() => {
    for (const pid of [runtimePid, grandchildPid]) if (pidAlive(pid)) process.kill(pid, "SIGKILL");
  });
  return { runtimePid, grandchildPid };
}

describe.skipIf(process.platform === "win32")("reconciler step 5: the orphan sweep (real processes)", () => {
  test("a recorded live orphan that ignores SIGTERM is reaped with its grandchild: SIGTERM, the grace, SIGKILL of the group", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orphan-sweep-"));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    const { runtimePid, grandchildPid } = await leaveOrphan(dir);
    // The crashed daemon's ledger.
    const before = new RuntimeProcessLedger(join(dir, RUNTIME_PROCESS_LEDGER_FILE));
    await before.record(runtimePid, { agentId: "agent-1", launchId: "launch-1", host: "legacy" });
    assert.match(await readFile(join(dir, RUNTIME_PROCESS_LEDGER_FILE), "utf8"), new RegExp(`"pid":${runtimePid}`));

    // The next daemon.
    const after = new RuntimeProcessLedger(join(dir, RUNTIME_PROCESS_LEDGER_FILE));
    const leftover = after.takeLeftover();
    assert.deepEqual(leftover.map((record) => [record.pid, record.agentId]), [[runtimePid, "agent-1"]]);
    const startedAt = Date.now();
    const result = await reapRecordedOrphans(leftover, { graceMs: 300, confirmMs: 2_000, pollMs: 20 });

    assert.ok(Date.now() - startedAt >= 280, "SIGTERM first, then the grace");
    assert.deepEqual(result.reaped, [runtimePid]);
    assert.deepEqual(result.escalated, [runtimePid], "it ignored SIGTERM: SIGKILLed");
    assert.equal(pidAlive(runtimePid), false);
    assert.equal(pidAlive(grandchildPid), false, "its grandchild in the group is gone too");
  });

  test("a recorded pid that now belongs to another process (start identity mismatch) is never signalled", async () => {
    const other = spawn("sleep", ["30"], { stdio: "ignore", detached: true });
    onTestFinished(() => { if (pidAlive(other.pid!)) process.kill(other.pid!, "SIGKILL"); });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const identity = await readProcessIdentity(other.pid!);
    assert.ok(identity, "precondition: its identity is readable");
    const recorded: RuntimeProcessRecord = {
      pid: other.pid!,
      pgid: other.pid!,
      startIdentity: `${identity.startIdentity}-an-earlier-process`,
      agentId: "agent-1",
      launchId: null,
      host: "legacy",
      recordedAtMs: 0,
    };
    const signals: Array<[number, unknown]> = [];

    const result = await reapRecordedOrphans([recorded], {
      graceMs: 50,
      confirmMs: 50,
      pollMs: 10,
      kill: (pid, signal) => { signals.push([pid, signal]); process.kill(pid, signal); },
    });

    assert.equal(result.skipped, 1);
    assert.deepEqual(result.reaped, []);
    assert.deepEqual(signals, [], "not even a liveness probe");
    assert.equal(pidAlive(other.pid!), true);
  });

  test("the ledger forgets a confirmed exit, and an exit seen while the identity is read is never recorded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orphan-ledger-"));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, RUNTIME_PROCESS_LEDGER_FILE);
    const ledger = new RuntimeProcessLedger(file);
    await ledger.record(process.pid, { agentId: "agent-1", launchId: null, host: "legacy" });
    assert.equal(ledger.has(process.pid), true);
    ledger.forget(process.pid);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).processes, []);

    const recording = ledger.record(process.pid, { agentId: "agent-2", launchId: null, host: "legacy" });
    ledger.forget(process.pid);
    await recording;
    assert.equal(ledger.has(process.pid), false);
  });
});

test("reconciler step 5 (Windows): a recorded orphan with a matching identity is ended with `taskkill /PID <pid> /T /F`", async () => {
  const runs: string[][] = [];
  let alive = true;
  const record: RuntimeProcessRecord = { pid: 4242, pgid: 4242, startIdentity: "win32:1", agentId: "a", launchId: null, host: "legacy", recordedAtMs: 0 };

  const result = await reapRecordedOrphans([record], {
    platform: "win32",
    readIdentity: async (pid) => ({ pid, pgid: pid, startIdentity: "win32:1" }),
    tree: { taskkill: (args) => { runs.push([...args]); alive = false; } },
    kill: () => { if (!alive) throw Object.assign(new Error("gone"), { code: "ESRCH" }); },
    sleep: async () => {},
    confirmMs: 10,
    pollMs: 1,
  });

  assert.deepEqual(runs, [["/PID", "4242", "/T", "/F"]]);
  assert.deepEqual(result.reaped, [4242]);
});

test("reconciler step 5: the start identity is read per platform, never invented", async () => {
  const stat = "4242 (node a) S 1 4242 4242 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 987654 0 0";
  assert.deepEqual(await readProcessIdentity(4242, { platform: "linux", readProcStat: () => stat }), { pid: 4242, pgid: 4242, startIdentity: "linux:987654" });
  assert.deepEqual(
    await readProcessIdentity(4242, { platform: "darwin", runCommand: async () => " 4242 Thu Nov  5 18:00:00 2026\n" }),
    { pid: 4242, pgid: 4242, startIdentity: "ps:Thu Nov 5 18:00:00 2026" },
  );
  assert.deepEqual(
    await readProcessIdentity(4242, { platform: "win32", runCommand: async () => "638666000000000000\r\n" }),
    { pid: 4242, pgid: 4242, startIdentity: "win32:638666000000000000" },
  );
  assert.equal(await readProcessIdentity(4242, { platform: "darwin", runCommand: async () => "" }), null, "gone: null, so never signalled");
  assert.equal(await readProcessIdentity(4242, { platform: "linux", readProcStat: () => { throw new Error("ENOENT"); } }), null);
});

test("reconciler step 5 (OAR): after a session opened, this daemon's unrecorded group-leading children are recorded for the agent; gone ones are pruned after its dispose", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orphan-ledger-oar-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const live = new Set([501, 502, 503]);
  const stat = (pid: number) => {
    if (!live.has(pid)) throw new Error("ENOENT");
    return `${pid} (x) S 100 ${pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${pid}000 0 0`;
  };
  const ledger = new RuntimeProcessLedger(join(dir, RUNTIME_PROCESS_LEDGER_FILE), {
    identity: { platform: "linux", readProcStat: stat },
    tree: {
      platform: "linux",
      ownPid: 100,
      listProcesses: async () => [
        { pid: 501, ppid: 100, pgid: 501 }, // the legacy runtime, recorded already
        { pid: 502, ppid: 100, pgid: 502 }, // the OAR runtime
        { pid: 503, ppid: 502, pgid: 502 }, // its child: not a direct child of the daemon
        { pid: 504, ppid: 100, pgid: 100 }, // a child in the daemon's own group
      ],
    },
  });
  await ledger.record(501, { agentId: "legacy-agent", launchId: null, host: "legacy" });

  await ledger.recordUnrecordedChildren({ agentId: "oar-agent", launchId: "launch-1" });
  const records = JSON.parse(await readFile(join(dir, RUNTIME_PROCESS_LEDGER_FILE), "utf8")).processes as RuntimeProcessRecord[];
  assert.deepEqual(records.map((record) => [record.pid, record.agentId, record.host]), [[501, "legacy-agent", "legacy"], [502, "oar-agent", "oar"]]);

  live.delete(502);
  await ledger.pruneGone("oar-agent");
  assert.equal(ledger.has(502), false);
  assert.equal(ledger.has(501), true, "another host's record stays");
});

test("reconciler step 5 (OAR): settled() waits for every fire-and-forget update to write the ledger (the daemon stop awaits it)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orphan-ledger-settled-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, RUNTIME_PROCESS_LEDGER_FILE);
  const live = new Set([602]);
  let releaseListing!: () => void;
  const listingGate = new Promise<void>((resolve) => { releaseListing = resolve; });
  const ledger = new RuntimeProcessLedger(file, {
    identity: {
      platform: "linux",
      readProcStat: (pid) => {
        if (!live.has(pid)) throw new Error("ENOENT");
        return `${pid} (x) S 100 ${pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${pid}000 0 0`;
      },
    },
    tree: {
      platform: "linux",
      ownPid: 100,
      listProcesses: async () => {
        await listingGate;
        return [{ pid: 602, ppid: 100, pgid: 602 }];
      },
    },
  });
  await ledger.settled(); // nothing in flight

  // What the OAR host's open hook does: fire and forget.
  void ledger.recordUnrecordedChildren({ agentId: "oar-agent", launchId: "launch-1" });
  let settled = false;
  const settling = ledger.settled().then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false, "the listing is still running: its write has not landed");
  await assert.rejects(readFile(file, "utf8"), /ENOENT/, "nothing written yet");

  releaseListing();
  await settling;
  const records = JSON.parse(await readFile(file, "utf8")).processes as RuntimeProcessRecord[];
  assert.deepEqual(records.map((record) => record.pid), [602], "the write landed before settled() resolved");

  // The close hook's prune, also fire and forget, is waited for the same way.
  live.delete(602);
  void ledger.pruneGone("oar-agent");
  await ledger.settled();
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).processes, []);
});
