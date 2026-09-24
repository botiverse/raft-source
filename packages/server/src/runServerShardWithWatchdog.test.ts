import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SERVER_SHARD_WATCHDOG_EXIT_CODE,
  SERVER_SHARD_WATCHDOG_TIMEOUT_MS,
  runWithExitWatchdog,
  type ProcessDidNotExitReceipt,
} from "../scripts/runServerShardWithWatchdog.js";

const SERVER_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const REPO_ROOT = path.resolve(SERVER_DIR, "../..");
// Asserts on private CI/deploy files that the source-available snapshot does not
// carry; skipped when an exported snapshot's RELEASE_SOURCE marker is present.
const inSourceSnapshot = existsSync(path.join(REPO_ROOT, "RELEASE_SOURCE"));

test("passes through a child that exits cleanly", async () => {
  const exitCode = await runWithExitWatchdog({
    command: process.execPath,
    args: ["--input-type=module", "-e", "process.exit(0)"],
    cwd: SERVER_DIR,
    shard: 3,
    timeoutMs: 2_000,
    killGraceMs: 25,
    stdio: "ignore",
  });
  assert.equal(exitCode, 0);
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
    const exitCode = await runWithExitWatchdog({
      command: process.execPath,
      args: [
        "--input-type=module",
        "-e",
        [
          "import { spawn } from 'node:child_process';",
          "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 400)'], { stdio: 'inherit' });",
          "process.exit(0);",
        ].join(""),
      ],
      cwd: SERVER_DIR,
      shard: 4,
      timeoutMs: 100,
      killGraceMs: 25,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(exitCode, 0);
  },
);

test(
  "a child whose test passes but whose process stays live emits PROCESS_DID_NOT_EXIT and RED",
  { timeout: 5_000 },
  async () => {
    const receipts: ProcessDidNotExitReceipt[] = [];
    const exitCode = await runWithExitWatchdog({
      command: process.execPath,
      args: [
        "--input-type=module",
        "-e",
        [
          "const phase = 'assertion phase completed';",
          "setInterval(() => {}, 1000);",
        ].join(""),
      ],
      cwd: SERVER_DIR,
      shard: 5,
      timeoutMs: 100,
      killGraceMs: 25,
      stdio: "ignore",
      emit: (receipt) => receipts.push(receipt),
    });

    assert.equal(exitCode, SERVER_SHARD_WATCHDOG_EXIT_CODE);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].classification, "PROCESS_DID_NOT_EXIT");
    assert.equal(receipts[0].shard, 5);
    assert.equal(receipts[0].timeoutMs, 100);
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

test.skipIf(inSourceSnapshot)("Hosted wiring keeps a hard job ceiling above the named watchdog and never force-exits tests", () => {
  const workflow = readFileSync(
    path.join(REPO_ROOT, ".github/workflows/test.yml"),
    "utf8",
  );
  const unitServer = workflow.match(
    /\n  unit-server:\n(?<body>[\s\S]*?)\n  unit-server-gate:\n/,
  )?.groups?.body;
  assert.ok(unitServer, "unit-server job block must remain discoverable");
  assert.match(unitServer, /\n    timeout-minutes: 25\n/);
  assert.ok(25 * 60_000 > SERVER_SHARD_WATCHDOG_TIMEOUT_MS);
  assert.match(
    unitServer,
    /pnpm exec tsx scripts\/runServerShardWithWatchdog\.ts \$\{\{ matrix\.shard \}\}/,
  );
  assert.doesNotMatch(unitServer, /--test-force-exit/);
});
