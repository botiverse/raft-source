import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SERVER_SHARD_WATCHDOG_EXIT_CODE,
  runWithExitWatchdog,
  type ProcessDidNotExitReceipt,
  watchSpawnedChildExit,
} from "../scripts/runServerShardWithWatchdog";
import { recordFileTiming } from "../scripts/serverShardTimings";

const SERVER_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const FIXTURE_STARTUP_TIMEOUT_MS = 2_000;
const EXIT_WATCHDOG_TEST_TIMEOUT_MS = 100;
const SLOW_FIXTURE_STARTUP_MS = 150;

async function spawnReadyWatchdogFixture(source: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", source],
    {
      cwd: SERVER_DIR,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );

  try {
    const [message] = await once(child, "message", {
      signal: AbortSignal.timeout(FIXTURE_STARTUP_TIMEOUT_MS),
    });
    assert.equal(message, "ready");
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }

  return child;
}

test("passes through a child that exits cleanly", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "raft-shard-normal-exit-"));
  const journal = path.join(directory, "timings.jsonl");
  try {
    recordFileTiming(journal, { event: "run-start", files: 1 });
    recordFileTiming(journal, { event: "finished", file: "done.test.ts", durationMs: 2, wallMs: 5, state: "passed" });
    recordFileTiming(journal, { event: "run-end" });
    const output: string[] = [];
    const exitCode = await runWithExitWatchdog({
      command: process.execPath,
      args: ["--input-type=module", "-e", "process.exit(0)"],
      cwd: SERVER_DIR,
      shard: 3,
      timeoutMs: 2_000,
      killGraceMs: 25,
      stdio: "ignore",
      timingJournal: journal,
      writeTimingSummary: (text) => output.push(text),
    });
    assert.equal(exitCode, 0);
    assert.equal(output.length, 1, "normal completion also emits the final table");
    assert.match(output[0], /"reason":"exit"/);
    assert.match(output[0], /"runFinished":true/);
    assert.match(output[0], /\[serverShardTimings\] completed .*done\.test\.ts/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("passes through an ordinary non-zero child exit", async () => {
  const exitCode = await runWithExitWatchdog({
    command: process.execPath,
    args: ["--input-type=module", "-e", "process.exit(23)"],
    cwd: SERVER_DIR,
    shard: 4,
    timeoutMs: 2_000,
    killGraceMs: 25,
    stdio: "ignore",
  });
  assert.equal(exitCode, 23);
});

test(
  "settles on child exit even when a descendant keeps a stdio pipe open",
  { timeout: 5_000 },
  async () => {
    assert.ok(SLOW_FIXTURE_STARTUP_MS > EXIT_WATCHDOG_TEST_TIMEOUT_MS);
    const child = await spawnReadyWatchdogFixture(
      [
        "import { spawn } from 'node:child_process';",
        `await new Promise((resolve) => setTimeout(resolve, ${SLOW_FIXTURE_STARTUP_MS}));`,
        "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 400)'], { stdio: 'inherit' });",
        "process.send?.('ready');",
        "process.on('message', (message) => { if (message === 'exit') process.exit(0); });",
      ].join(""),
    );
    const exitCodePromise = watchSpawnedChildExit(child, {
      shard: 4,
      timeoutMs: EXIT_WATCHDOG_TEST_TIMEOUT_MS,
      killGraceMs: 25,
    });
    child.send?.("exit");
    const exitCode = await exitCodePromise;
    assert.equal(exitCode, 0);
  },
);

test(
  "a child whose test passes but whose process stays live emits PROCESS_DID_NOT_EXIT and RED",
  { timeout: 5_000 },
  async () => {
    const receipts: ProcessDidNotExitReceipt[] = [];
    const child = await spawnReadyWatchdogFixture(
      [
        "const phase = 'assertion phase completed';",
        "setInterval(() => {}, 1000);",
        "process.send?.('ready');",
      ].join(""),
    );
    const exitCode = await watchSpawnedChildExit(child, {
      shard: 5,
      timeoutMs: EXIT_WATCHDOG_TEST_TIMEOUT_MS,
      killGraceMs: 25,
      emit: (receipt) => receipts.push(receipt),
    });

    assert.equal(exitCode, SERVER_SHARD_WATCHDOG_EXIT_CODE);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].classification, "PROCESS_DID_NOT_EXIT");
    assert.equal(receipts[0].shard, 5);
    assert.equal(receipts[0].timeoutMs, EXIT_WATCHDOG_TEST_TIMEOUT_MS);
    assert.ok(receipts[0].childPid > 0);
    if (process.platform === "linux") {
      assert.ok(
        receipts[0].processTree.entries.some((entry) =>
          entry.command.includes("assertion phase completed"),
        ),
        `expected process-tree witness, got ${JSON.stringify(receipts[0].processTree)}`,
      );
    }
  },
);

test(
  "receipt emission failure cannot turn a process timeout green",
  { timeout: 5_000 },
  async () => {
    let emitCalls = 0;
    const exitCode = await runWithExitWatchdog({
      command: process.execPath,
      args: ["--input-type=module", "-e", "setInterval(() => {}, 1000)"],
      cwd: SERVER_DIR,
      shard: 6,
      timeoutMs: 100,
      killGraceMs: 25,
      stdio: "ignore",
      emit: () => {
        emitCalls += 1;
        throw new Error("synthetic receipt sink failure");
      },
    });

    assert.equal(emitCalls, 1);
    assert.equal(exitCode, SERVER_SHARD_WATCHDOG_EXIT_CODE);
  },
);
