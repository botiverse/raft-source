import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { buildVitestArguments } from "../scripts/runTestShard";
import { watchSpawnedChildExit } from "../scripts/runServerShardWithWatchdog";
import { formatFileTimings, readFileTimings, recordFileTiming, SERVER_SHARD_TIMINGS_ENV } from "../scripts/serverShardTimings";

test("file timing summaries keep completed work, distinguish active time, and report truncated metadata", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "raft-shard-timing-summary-"));
  const journal = path.join(directory, "timings.jsonl");
  try {
    recordFileTiming(journal, { event: "run-start", files: 3 });
    recordFileTiming(journal, { event: "queued", file: "finished.test.ts", at: 100 });
    recordFileTiming(journal, { event: "finished", file: "finished.test.ts", durationMs: 7, wallMs: 12, state: "passed" });
    recordFileTiming(journal, { event: "queued", file: "active.test.ts", at: 110 });
    appendFileSync(journal, '{"event":"finished"');
    const summary = readFileTimings(journal, 150);
    assert.deepEqual(summary.completed.map(({ file, durationMs, wallMs }) => ({ file, durationMs, wallMs })),
      [{ file: "finished.test.ts", durationMs: 7, wallMs: 12 }]);
    assert.deepEqual(summary.unfinished, [{ file: "active.test.ts", elapsedMs: 40 }]);
    assert.equal(summary.notStarted, 1);
    assert.equal(summary.invalidRecords, 1);
    assert.equal(summary.runFinished, false, "an interrupted run is not reported as complete");
    const text = formatFileTimings(2, "watchdog", summary);
    assert.match(text, /\[serverShardTimings\] completed .*finished\.test\.ts/);
    assert.match(text, /\[serverShardTimings\] unfinished .*active\.test\.ts/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the real Vitest reporter and watchdog retain a completed file and an unfinished file at timeout", { timeout: 20_000 }, async () => {
  const serverDirectory = fileURLToPath(new URL("..", import.meta.url));
  const directory = mkdtempSync(path.join(tmpdir(), "raft-shard-timing-contract-"));
  const journal = path.join(directory, "timings.jsonl");
  const config = path.join(directory, "vitest.config.mjs");
  const passed = path.join(directory, "a.test.ts");
  const unfinished = path.join(directory, "b.test.ts");
  writeFileSync(passed, 'test("completed", () => { expect(1).toBe(1); });\n');
  writeFileSync(unfinished, 'test("unfinished", async () => { await new Promise(() => {}); });\n');
  writeFileSync(config, `export default {
    root: ${JSON.stringify(directory)},
    test: { globals: true, include: ["*.test.ts"], maxWorkers: 1, fileParallelism: false, testTimeout: 0,
      sequence: { sequencer: class { shard(files) { return files; } sort(files) { return [...files].sort((a,b) => a.moduleId.localeCompare(b.moduleId)); } } }
    }
  };\n`);
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir(), NODE_ENV: "test", [SERVER_SHARD_TIMINGS_ENV]: journal };
  const child = spawn(process.execPath, [
    path.join(serverDirectory, "node_modules/vitest/vitest.mjs"),
    ...buildVitestArguments([path.basename(passed), path.basename(unfinished)], env), "--config", config,
  ], { cwd: directory, env, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "pipe"] });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-4_000); });
  try {
    const deadline = Date.now() + 15_000;
    let ready = false;
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      const summary = readFileTimings(journal);
      if (summary.completed.some((file) => file.file === "a.test.ts") && summary.unfinished.some((file) => file.file === "b.test.ts")) {
        ready = true; break;
      }
      await delay(20);
    }
    assert.ok(ready, `the actual reporter must record both files before arming the short watchdog: ${stderr}`);
    const output: string[] = [];
    const exitCode = await watchSpawnedChildExit(child, {
      shard: 3, timeoutMs: 100, killGraceMs: 25, timingJournal: journal,
      emit: () => {}, writeTimingSummary: (text) => output.push(text),
    });
    assert.equal(exitCode, 124, "timing collection cannot turn a hung test green");
    assert.equal(output.length, 1, "the real watchdog emits one final summary");
    assert.match(output[0], /"reason":"watchdog"/);
    assert.match(output[0], /\[serverShardTimings\] completed .*a\.test\.ts/);
    assert.match(output[0], /\[serverShardTimings\] unfinished .*b\.test\.ts/);
    // Vitest can report its interrupted run end after SIGTERM, before SIGKILL.
    // runFinished records that callback, not whether every file completed.
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      if (process.platform === "win32") child.kill("SIGKILL");
      else { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    }
    await exited;
    rmSync(directory, { recursive: true, force: true });
  }
});
