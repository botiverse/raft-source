import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forkHeapExecArgv, isCi, localMaxWorkers } from "../../../scripts/vitest/localRunLimits";
import {
  agentIdFromEnv,
  classifyModuleErrors,
  crashedFiles,
  pruneRunRecords,
  RUN_RECORD_MAX_AGE_MS,
  RunRecordReporter,
} from "../../../scripts/vitest/runRecordReporter";
import type { RunRecord } from "../../../scripts/vitest/runRecordReporter";

test("a fork that dies mid-file is attributed to that file as a worker OOM exit", () => {
  // Shape Vitest 5.0.3 reports when a fork aborts on its V8 heap limit.
  const error = {
    message: "[vitest-pool]: Worker forks emitted error.",
    cause: {
      message:
        "Worker exited unexpectedly with signal SIGABRT during started state while running test file /w/packages/web/tests/a.test.ts",
    },
  };
  assert.deepEqual(crashedFiles([error]), [{ file: "/w/packages/web/tests/a.test.ts", detail: "worker exited with signal SIGABRT" }]);
  assert.deepEqual(crashedFiles([{ message: "unrelated" }]), []);
});

test("module failures classify timeouts apart from assertion failures", () => {
  assert.deepEqual(classifyModuleErrors([{ name: "Error", message: "Test timed out in 200ms.\nIf this is..." }]), {
    reason: "timeout",
    detail: "Test timed out in 200ms.",
  });
  assert.deepEqual(classifyModuleErrors([{ name: "AssertionError", message: "expected 1 to be 2" }]), {
    reason: "assertion-failure",
    detail: "AssertionError: expected 1 to be 2",
  });
});

test("only CI=true or CI=1 count as CI", () => {
  assert.equal(isCi({ CI: "true" }), true);
  assert.equal(isCi({ CI: "1" }), true);
  for (const value of [undefined, "", "false", "0", "yes", "TRUE"]) {
    assert.equal(isCi({ CI: value }), false, `CI=${JSON.stringify(value)}`);
  }
});

test("local limits: 2 workers and a 4096 MiB fork heap unless overridden", () => {
  assert.equal(localMaxWorkers({}), 2);
  assert.equal(localMaxWorkers({ RAFT_TEST_MAX_WORKERS: "3" }), 3);
  assert.throws(() => localMaxWorkers({ RAFT_TEST_MAX_WORKERS: "0" }), /positive integer/);
  assert.deepEqual(forkHeapExecArgv({}), ["--max-old-space-size=4096"]);
  assert.deepEqual(forkHeapExecArgv({ NODE_OPTIONS: "--max-old-space-size=2048" }), []);
  assert.deepEqual(forkHeapExecArgv({ NODE_OPTIONS: "--max-old-space-size=2048", RAFT_TEST_MAX_OLD_SPACE_MB: "1024" }), [
    "--max-old-space-size=1024",
  ]);
});

test("agentId comes only from SLOCK_AGENT_ID", () => {
  assert.equal(agentIdFromEnv({ SLOCK_AGENT_ID: "agent-1", SLOCK_CURRENT_AGENT_ID: "other", USER: "u" }), "agent-1");
  assert.equal(agentIdFromEnv({ SLOCK_CURRENT_AGENT_ID: "other", USER: "u" }), null);
  assert.equal(agentIdFromEnv({ SLOCK_AGENT_ID: "" }), null);
});

test("a run start prunes records older than 14 days and records driverPid and agentId", () => {
  const dir = mkdtempSync(join(tmpdir(), "raft-tests-"));
  try {
    const now = Date.now();
    const stamp = (name: string, ageMs: number) => {
      writeFileSync(join(dir, name), "{}\n");
      const at = (now - ageMs) / 1000;
      utimesSync(join(dir, name), at, at);
    };
    const day = 24 * 60 * 60 * 1000;
    stamp("old.json", RUN_RECORD_MAX_AGE_MS + day);
    stamp("recent.json", 13 * day);
    stamp("old-note.txt", RUN_RECORD_MAX_AGE_MS + day);
    assert.deepEqual(pruneRunRecords(dir, now), ["old.json"]);
    assert.deepEqual(readdirSync(dir).sort(), ["old-note.txt", "recent.json"]);
    assert.deepEqual(pruneRunRecords(join(dir, "missing")), []);

    stamp("old.json", RUN_RECORD_MAX_AGE_MS + day);
    const reporter = new RunRecordReporter({
      packageName: "@botiverse/raft-server",
      dom: false,
      worktree: "/w",
      dir,
      env: { SLOCK_AGENT_ID: "agent-1" },
    });
    reporter.onTestRunStart();
    const records = readdirSync(dir).filter((name) => name.endsWith(".json") && name !== "recent.json");
    assert.equal(records.length, 1, `old.json pruned, one new record: ${records.join(", ")}`);
    const record = JSON.parse(readFileSync(join(dir, records[0]!), "utf8")) as RunRecord;
    assert.equal(record.driverPid, process.pid);
    assert.equal(record.agentId, "agent-1");
    assert.equal(record.package, "@botiverse/raft-server");
    assert.equal(record.endedAt, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
