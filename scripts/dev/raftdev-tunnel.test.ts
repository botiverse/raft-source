/** `raftdev stop` ends the cloudflared tunnel a plain `start` opened (#triage task #148). */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { recordTunnelProcess, stopRecordedTunnel, type TunnelProbes } from "./raftdev";

function tempFile(): string {
  const root = mkdtempSync(join(tmpdir(), "raftdev-tunnel-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "demo", "tunnel.json");
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Linux only: there a zombie child counts as gone (/proc state Z); macOS's `ps`
// still reports one, and this test process is the sleeper's parent.
test.skipIf(process.platform !== "linux")("a detached process recorded at start is gone after stop", async () => {
  const file = tempFile();
  // Stands in for cloudflared: spawned the same way (detached, unref'd), so it outlives its parent like the tunnel.
  const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
  child.unref();
  const pid = child.pid!;
  const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
  onTestFinished(() => { if (isRunning(pid)) process.kill(pid, "SIGKILL"); });

  recordTunnelProcess(file, pid);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).pid, pid);
  assert.ok(isRunning(pid));

  assert.deepEqual(stopRecordedTunnel(file), { outcome: "stopped", pid });
  assert.equal(existsSync(file), false, "the record goes with the stopped tunnel");
  // This test process is the parent here, so it reaps the child (cloudflared's parent, `start`, has exited).
  assert.equal(await exited, "SIGTERM");
  assert.equal(isRunning(pid), false);
});

function fakeProbes(overrides: Partial<TunnelProbes> & { signals?: number[] }): TunnelProbes {
  return {
    starttimeOf: () => "1000",
    bootId: () => "boot-a",
    signal: (pid) => { overrides.signals?.push(pid); },
    sleepMs: () => {},
    ...overrides,
  };
}

test("a reused pid or a new boot is the old tunnel gone: nothing is signalled", () => {
  const file = tempFile();
  recordTunnelProcess(file, 4242, fakeProbes({}));

  const signals: number[] = [];
  assert.deepEqual(
    stopRecordedTunnel(file, fakeProbes({ signals, starttimeOf: () => "2000" })),
    { outcome: "gone", pid: 4242 },
  );
  assert.equal(existsSync(file), false, "a gone tunnel's record goes too");
  recordTunnelProcess(file, 4242, fakeProbes({}));
  assert.deepEqual(
    stopRecordedTunnel(file, fakeProbes({ signals, bootId: () => "boot-b" })),
    { outcome: "gone", pid: 4242 },
  );
  assert.deepEqual(signals, []);
});

test("a tunnel that outlives SIGTERM is reported, not forgotten", () => {
  const file = tempFile();
  recordTunnelProcess(file, 4242, fakeProbes({}));
  const signals: number[] = [];

  assert.deepEqual(stopRecordedTunnel(file, fakeProbes({ signals }), 3_000), { outcome: "still-running", pid: 4242 });
  // Once, then again after a second (cloudflared's grace period ends on the second SIGTERM).
  assert.deepEqual(signals, [4242, 4242]);
  assert.ok(existsSync(file), "the record stays for a retry");
  // ...and the retry still finds the tunnel by it.
  assert.deepEqual(stopRecordedTunnel(file, fakeProbes({ signals }), 0), { outcome: "still-running", pid: 4242 });
  assert.deepEqual(signals, [4242, 4242, 4242]);
});

test("no record, an unreadable record, or a process with no start time to record is nothing to stop", () => {
  const file = tempFile();
  assert.deepEqual(stopRecordedTunnel(file), { outcome: "none" });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "{not json");
  assert.deepEqual(stopRecordedTunnel(file, fakeProbes({})), { outcome: "none" });
  assert.equal(existsSync(file), false);

  recordTunnelProcess(file, 4242, fakeProbes({ starttimeOf: () => null }));
  assert.equal(existsSync(file), false);

  recordTunnelProcess(file, undefined, fakeProbes({}));
  assert.equal(existsSync(file), false);
});

test("a tunnel that exits within its grace period is not signalled twice", () => {
  const file = tempFile();
  recordTunnelProcess(file, 4242, fakeProbes({}));
  const signals: number[] = [];
  let checks = 0;
  // Alive for the first few checks after the SIGTERM, then gone.
  const starttimeOf = (): string | null => (checks++ < 4 ? "1000" : null);

  assert.deepEqual(stopRecordedTunnel(file, fakeProbes({ signals, starttimeOf })), { outcome: "stopped", pid: 4242 });
  assert.deepEqual(signals, [4242]);
});
