import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  serverAttachmentPath,
  serverRunnerLockConflictPath,
  serverRunnerPidPath,
  serverRunnerVersionPath,
  servicePidPath,
  serviceVersionPath,
} from "./paths";
import { formatServiceStarted, runStop } from "./startStop";

// A Computer started from a terminal does not come back by itself (decision of
// 2026-09-30, macosLoginCarrier.ts), and on Windows it ends with the sign-in
// session. A person on a real Windows machine signed out, signed in and found
// it gone: the start line had only said "keeps running after this terminal
// closes".
const AGAIN = "run `raft-computer start` again then, or use Raft Desktop, which starts it whenever Raft Desktop opens unless you stopped it.";

test("start line: a CLI-started service says when it has to be started again", () => {
  assert.equal(
    formatServiceStarted(5732, { cliDetached: true, logindSessionRisk: false, platform: "win32" }),
    `Service started (pid 5732); keeps running after this terminal closes. It stops when you sign out of Windows or the machine restarts: ${AGAIN}`,
  );
  for (const platform of ["darwin", "linux"] as const) {
    assert.equal(
      formatServiceStarted(5732, { cliDetached: true, logindSessionRisk: false, platform }),
      `Service started (pid 5732); keeps running after this terminal closes. It does not start by itself after the machine restarts: ${AGAIN}`,
    );
  }
  assert.equal(
    formatServiceStarted(5732, { cliDetached: true, logindSessionRisk: true, platform: "linux" }),
    `Service started (pid 5732); keeps running after this terminal closes, but stops when this login session ends: ${AGAIN}`,
  );
});

test("start line: a service under a systemd unit or hosted by an app keeps the plain line", () => {
  for (const platform of ["win32", "darwin", "linux"] as const) {
    assert.equal(
      formatServiceStarted(4242, { cliDetached: false, logindSessionRisk: false, platform }),
      "Service started (pid 4242); keeps running after this terminal closes.",
    );
  }
  assert.equal(
    formatServiceStarted(4242, { cliDetached: false, logindSessionRisk: true, platform: "linux" }),
    "Service started (pid 4242); keeps running after this terminal closes, but stops when this login session ends.",
  );
});

// The service signals only runners it started. A lock owner it had deferred to
// (on a real Windows machine: explorer.exe) keeps running after `stop`.
test("stop names the lock owner the service had deferred to and left alone; restart and setup say nothing", async () => {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-stop-"));
  const oldHome = process.env.SLOCK_HOME;
  process.env.SLOCK_HOME = home;
  const serverId = "11111111-1111-4111-8111-111111111111";
  const out = async (deps: Parameters<typeof runStop>[0]): Promise<string> => {
    const lines: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      await runStop(deps);
    } finally {
      process.stdout.write = write;
    }
    return lines.join("");
  };
  try {
    await mkdir(dirname(serverAttachmentPath(home, serverId)), { recursive: true });
    await writeFile(serverAttachmentPath(home, serverId), JSON.stringify({
      kind: "computer-attachment", serverId, serverSlug: "alpha", serverMachineId: "cm-1", apiKey: "sk_computer_x", serverUrl: "https://api.example.test",
    }));
    await writeFile(serverRunnerLockConflictPath(home, serverId), JSON.stringify({ servicePid: 5732, ownerPid: 7720, lockPath: null, recordedAt: 1 }));
    await writeFile(serverRunnerPidPath(home, serverId), "7720");
    const killed: number[] = [];
    // No service pidfile: nothing to stop. Only the lock owner (7720) is alive.
    const deps = {
      hostLifecycleOwner: "none" as const,
      recordLifecycleIntent: false,
      readPidfile: async () => null,
      isProcessAlive: (pid: number) => pid === 7720,
      killService: (pid: number) => { killed.push(pid); },
      procJobs: { platform: "win32" as const },
    };

    const plain = await out({ ...deps, jobs: "report" });
    assert.match(
      plain,
      /Service not running\.\n\/alpha: Not stopped: pid 7720 holds this machine's daemon lock and was not started by this Computer service, so it was not signalled\. Check whether pid 7720 is really a Raft daemon with `[^`]*7720[^`]*`\. If it is, stop that daemon yourself\.\n$/,
    );
    assert.equal((await out(deps)).includes("7720"), false);
    assert.deepEqual(killed, []);

    // The owner is this server's own runner, left by an earlier service (its
    // evidence, and a start that was read and is not later): it was not
    // stopped either, and stop says that in its own words. The service is
    // gone, so the verdict it recorded is not used: the start is read.
    const evidenceAt = "2026-11-13T08:00:00.000Z";
    await writeFile(serverRunnerVersionPath(home, serverId), JSON.stringify({ version: "1.22.0", installRoot: "/raft", pid: 7720, writtenAt: evidenceAt }));
    await writeFile(serverRunnerLockConflictPath(home, serverId), JSON.stringify({
      servicePid: 5732, ownerPid: 7720, lockPath: null, recordedAt: 1, ownerVerdict: { owner: "another-program", evidenceAt },
    }));
    assert.match(
      await out({ ...deps, jobs: "report", processStartTimeMs: async () => Date.parse(evidenceAt) - 2_000 }),
      /^Service not running\.\n\/alpha: this server's runner \(pid 7720\), started by an earlier Computer service, is still running and was not stopped\. Check it with `[^`]*7720[^`]*`; ending that process stops it\.\n$/,
    );
    // The same files, but that pid started after the evidence (another
    // program), or its start cannot be read (always on Linux: it must not be
    // called this server's runner on that): the plain line.
    for (const startedAtMs of [Date.parse(evidenceAt) + 600_000, undefined]) {
      assert.match(await out({ ...deps, jobs: "report", processStartTimeMs: async () => startedAtMs }), /\/alpha: Not stopped: pid 7720 holds this machine's daemon lock and was not started by this Computer service, so it was not signalled\./);
    }

    // A conflict record an earlier service left behind: runner.pid no longer
    // names that pid, which is any live process by now. Nothing to report.
    await writeFile(serverRunnerPidPath(home, serverId), "4242");
    assert.equal(await out({ ...deps, jobs: "report" }), "Service not running.\n");
    await rm(serverRunnerPidPath(home, serverId));
    assert.equal(await out({ ...deps, jobs: "report" }), "Service not running.\n");
  } finally {
    if (oldHome === undefined) delete process.env.SLOCK_HOME;
    else process.env.SLOCK_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});

// A service that ended with its Windows sign-in session leaves its pid record
// behind, and the pid goes to an unrelated program: stop used to SIGTERM it.
test("stop does not signal a recorded service pid that is another program, and says so in one line", async () => {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-stop-"));
  const oldHome = process.env.SLOCK_HOME;
  process.env.SLOCK_HOME = home;
  const lines: string[] = [];
  const write = process.stdout.write;
  try {
    await mkdir(dirname(servicePidPath(home)), { recursive: true });
    await writeFile(servicePidPath(home), "7720");
    await writeFile(serviceVersionPath(home), JSON.stringify({ version: "1.22.0", installRoot: "/raft", pid: 7720, writtenAt: "2026-11-13T08:00:00.000Z" }));
    const killed: number[] = [];
    process.stdout.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write;
    // Nothing answers on this home's IPC endpoint; pid 7720 started ten minutes after the service's evidence.
    await runStop({
      hostLifecycleOwner: "none",
      recordLifecycleIntent: false,
      isProcessAlive: (pid) => pid === 7720,
      processStartTimeMs: async () => Date.parse("2026-11-13T08:10:00.000Z"),
      killService: (pid) => { killed.push(pid); },
    });
    process.stdout.write = write;
    assert.deepEqual(killed, []);
    assert.equal(lines.join(""), "Service not running: pid 7720 in its pid file is another program now and was not signalled (cleared the stale pid file).\n");
  } finally {
    process.stdout.write = write;
    if (oldHome === undefined) delete process.env.SLOCK_HOME;
    else process.env.SLOCK_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});
