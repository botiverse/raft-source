import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

import { isProcessAlive, isProcessAliveWith } from "./process-primitives";

// A live pid that answers signal 0 (this test process), with /proc reads faked.
const pid = process.pid;
const selfStat = () => `${pid} (node) R 1 1 1 0 -1`;
const stat = (state: string, comm = "raft runner") => () => `${pid} (${comm}) ${state} 1 ${pid} ${pid} 0 -1 4194560`;
const fail = (code: string) => () => {
  throw Object.assign(new Error(code), { code });
};

test("isProcessAlive: a Linux zombie (exited, not reaped) answers signal 0 but is not alive", () => {
  assert.equal(isProcessAliveWith(pid, { platform: "linux", readProcStat: stat("Z"), readSelfStat: selfStat, selfPid: pid }), false);
  assert.equal(isProcessAliveWith(pid, { platform: "linux", readProcStat: stat("X"), readSelfStat: selfStat, selfPid: pid }), false);
  // comm can hold spaces and parens: the state is read after the last ')'.
  assert.equal(isProcessAliveWith(pid, { platform: "linux", readProcStat: stat("Z", "a) S (b"), readSelfStat: selfStat, selfPid: pid }), false);
  assert.equal(isProcessAliveWith(pid, { platform: "linux", readProcStat: stat("S", "a) Z (b"), readSelfStat: selfStat, selfPid: pid }), true);
});

test("isProcessAlive: a running or sleeping Linux process is alive", () => {
  for (const state of ["R", "S", "D", "T"]) {
    assert.equal(isProcessAliveWith(pid, { platform: "linux", readProcStat: stat(state), readSelfStat: selfStat, selfPid: pid }), true, state);
  }
});

test("isProcessAlive: /proc/<pid>/stat gone means gone; any other /proc trouble keeps the signal-0 answer", () => {
  assert.equal(isProcessAliveWith(pid, { platform: "linux", readProcStat: fail("ENOENT"), readSelfStat: selfStat, selfPid: pid }), false);
  assert.equal(isProcessAliveWith(pid, { platform: "linux", readProcStat: fail("EACCES"), readSelfStat: selfStat, selfPid: pid }), true);
  assert.equal(isProcessAliveWith(pid, { platform: "linux", readProcStat: () => "junk", readSelfStat: selfStat, selfPid: pid }), true);
  // /proc mounted for another pid namespace says nothing about this pid.
  assert.equal(isProcessAliveWith(pid, { platform: "linux", readProcStat: stat("Z"), readSelfStat: () => "1 (init) S 0", selfPid: pid }), true);
  assert.equal(isProcessAliveWith(pid, { platform: "linux", readProcStat: stat("Z"), readSelfStat: fail("ENOENT"), selfPid: pid }), true);
});

test("isProcessAlive: other platforms keep signal 0 alone", () => {
  const readProcStat = () => assert.fail("no /proc read off Linux");
  assert.equal(isProcessAliveWith(pid, { platform: "darwin", readProcStat, readSelfStat: selfStat, selfPid: pid }), true);
  assert.equal(isProcessAliveWith(pid, { platform: "win32", readProcStat, readSelfStat: selfStat, selfPid: pid }), true);
});

test.runIf(process.platform === "linux")("isProcessAlive: a real unreaped child on Linux reads as dead", async () => {
  // `sleep 0` exits; its parent (the shell, exec'd into `sleep 30`) never reaps it.
  const parent = spawn("sh", ["-c", "sleep 0 & echo $!; exec sleep 30"], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    const [chunk] = (await once(parent.stdout!, "data")) as [Buffer];
    const zombie = Number(chunk.toString().trim());
    assert.ok(Number.isInteger(zombie) && zombie > 0);
    const deadline = Date.now() + 5_000;
    while (isProcessAlive(zombie) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.equal(isProcessAlive(zombie), false);
    assert.ok(isProcessAlive(parent.pid!), "the parent is alive");
  } finally {
    parent.kill("SIGKILL");
  }
});
