import assert from "node:assert/strict";
import type { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { servicePidPath, serviceVersionPath } from "../paths";
import {
  readProcessStartTimeMs,
  START_TIME_READ_BEFORE_ACTING_TIMEOUT_MS,
  START_TIME_READ_TIMEOUT_MS,
} from "./process-primitives";
import { findLiveServicePid, findLiveServicePidReadOnly } from "./service-pid-fallback";

// A service that ended with its Windows sign-in session leaves run/service.pid
// and service-version.json behind, and the pid goes to an unrelated program.
const RECORDED_AT = "2026-11-13T08:00:00.000Z";
const LATER = Date.parse(RECORDED_AT) + 10 * 60_000;

async function withServiceRecord(pid: number, fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-service-pid-"));
  try {
    await mkdir(dirname(servicePidPath(home)), { recursive: true });
    await writeFile(servicePidPath(home), String(pid));
    await writeFile(serviceVersionPath(home), JSON.stringify({ version: "1.22.0", installRoot: "/raft", pid, writtenAt: RECORDED_AT }));
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("a live recorded pid that is another program is stale: cleared by the read-write walk, kept by the read-only one", async () => {
  await withServiceRecord(7720, async (home) => {
    const identity = { isProcessAlive: (pid: number) => pid === 7720, endpointAnswers: async () => false, processStartTimeMs: async () => LATER };
    const readOnly = await findLiveServicePidReadOnly(home, identity);
    assert.equal(readOnly.pid, null);
    assert.equal(readOnly.otherProgramPid, 7720);

    const cleared: string[] = [];
    const walk = await findLiveServicePid(home, { ...identity, clearPidfile: async (path) => { cleared.push(path); } });
    assert.deepEqual({ pid: walk.pid, stale: walk.firstStalePid, other: walk.otherProgramPid }, { pid: null, stale: 7720, other: 7720 });
    assert.deepEqual(cleared, [servicePidPath(home)]);
  });
});

// Telling the pid apart takes seconds (an IPC probe, a PowerShell start). A
// service that started meanwhile has written its own pid into the same file.
test("a pid record that changed while its old pid was being told apart is never unlinked", async () => {
  await withServiceRecord(7720, async (home) => {
    for (const [rewritten, expected] of [
      [8844, { pid: 8844, other: undefined }], // a service that just started: found, not cleared
      [null, { pid: null, other: undefined }], // already removed by someone else
    ] as const) {
      let reads = 0;
      const cleared: string[] = [];
      const walk = await findLiveServicePid(home, {
        readPidfile: async () => (reads++ === 0 ? 7720 : rewritten),
        isProcessAlive: () => true,
        endpointAnswers: async () => false,
        processStartTimeMs: async () => LATER,
        clearPidfile: async (path) => { cleared.push(path); },
      });
      assert.deepEqual({ pid: walk.pid, other: walk.otherProgramPid }, expected, String(rewritten));
      assert.deepEqual(cleared, [], String(rewritten));
      assert.equal(reads, 2, "read again after the probe");
    }
  });
});

test("the start read waits 5 s for a display and 20 s before a command acts on it, with the daemon's command", async () => {
  assert.equal(START_TIME_READ_TIMEOUT_MS, 5_000);
  assert.equal(START_TIME_READ_BEFORE_ACTING_TIMEOUT_MS, 20_000);
  const calls: Array<{ command: string; args: readonly string[]; timeout: unknown }> = [];
  const fake = ((command: string, args: readonly string[], options: { timeout?: number }, done: (err: Error | null, stdout: string) => void) => {
    calls.push({ command, args, timeout: options.timeout });
    done(null, command === "ps" ? "Thu Nov  5 10:15:42 2026\n" : "2026-11-11T09:00:00.1234567Z\r\n");
  }) as unknown as typeof execFile;

  assert.equal(await readProcessStartTimeMs(7720, { platform: "win32", execFile: fake }), Date.UTC(2026, 10, 11, 9, 0, 0) + 123);
  assert.equal(
    await readProcessStartTimeMs(7720, { platform: "darwin", timeoutMs: START_TIME_READ_BEFORE_ACTING_TIMEOUT_MS, execFile: fake }),
    new Date(2026, 10, 5, 10, 15, 42).getTime(),
  );
  assert.deepEqual(calls.map((call) => [call.command, call.timeout]), [["powershell.exe", 5_000], ["ps", 20_000]]);
  assert.match(calls[0]!.args.join(" "), /Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=7720"/);
  assert.deepEqual(calls[1]!.args, ["-o", "lstart=", "-p", "7720"]);

  // Linux and a failed read are unknown, never a guess.
  assert.equal(await readProcessStartTimeMs(7720, { platform: "linux", execFile: fake }), undefined);
  const failing = ((_c: string, _a: readonly string[], _o: unknown, done: (err: Error | null, stdout: string) => void) => done(new Error("timed out"), "")) as unknown as typeof execFile;
  assert.equal(await readProcessStartTimeMs(7720, { platform: "win32", execFile: failing }), undefined);
  assert.equal(calls.length, 2);
});
