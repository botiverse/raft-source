import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { raiseRuntimeOomScore, RUNTIME_OOM_SCORE_ADJ } from "./oomScore";
import { spawnRuntimeChild } from "./runtimeChild";

// #triage:#169: on Linux an agent runtime is the OOM killer's first choice,
// before the Computer service; raising needs no privilege, lowering is never tried.

test("raises a runtime below the target, leaves one already above it, and is a no-op off Linux", () => {
  const writes: Array<[string, string]> = [];
  const deps = (current: string) => ({
    platform: "linux" as const,
    readFile: () => `${current}\n`,
    writeFile: (path: string, value: string) => { writes.push([path, value]); },
  });
  assert.equal(raiseRuntimeOomScore(42, deps("0")), true);
  assert.deepEqual(writes, [["/proc/42/oom_score_adj", String(RUNTIME_OOM_SCORE_ADJ)]]);
  writes.length = 0;
  assert.equal(raiseRuntimeOomScore(42, deps("800")), true, "already more likely to be killed");
  assert.deepEqual(writes, [], "never lowered");
  assert.equal(raiseRuntimeOomScore(42, { ...deps("0"), platform: "darwin" }), false);
  assert.equal(raiseRuntimeOomScore(undefined, deps("0")), false);
  assert.deepEqual(writes, []);
  assert.equal(raiseRuntimeOomScore(42, { ...deps("0"), writeFile: () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); } }), false,
    "an exited child or a read-only /proc is not an error");
});

test.runIf(process.platform === "linux")("a real runtime child and the tools it starts run at the raised score", async () => {
  const child = spawnRuntimeChild("sh", ["-c", "sleep 0.3; cat /proc/self/oom_score_adj; sh -c 'cat /proc/self/oom_score_adj'"], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  child.stdout!.on("data", (chunk: Buffer) => { out += chunk.toString(); });
  await new Promise((resolve) => child.on("close", resolve));
  const own = Number(readFileSync("/proc/self/oom_score_adj", "utf8"));
  // The child reads after a pause, so the raise has landed; a tool it starts inherits it.
  const expected = Math.max(own, RUNTIME_OOM_SCORE_ADJ);
  assert.deepEqual(out.trim().split("\n").map(Number), [expected, expected]);
  // A plain spawn keeps the daemon's value.
  const plain = spawn("cat", ["/proc/self/oom_score_adj"], { stdio: ["ignore", "pipe", "ignore"] });
  let plainOut = "";
  plain.stdout!.on("data", (chunk: Buffer) => { plainOut += chunk.toString(); });
  await new Promise((resolve) => plain.on("close", resolve));
  assert.equal(Number(plainOut.trim()), own);
});
