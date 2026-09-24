import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  atomicWriteJson,
  createCheckpoint,
  digestEnvironment,
  hashCompatibility,
  loadOrCreateCheckpoint,
  readCheckpoint,
  runCommandWithDeadline,
  runProfileInvocation,
  sealCheckpoint,
  updateSummary,
} from "./profileDomTests.mjs";

function temporaryDirectory(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "profile-dom-tests-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function assertProcessGone(pid, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`process ${pid} survived its process-group deadline`);
}

function killIfPresent(pid) {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function compatibility(overrides = {}) {
  const base = {
    source: {
      commit: "a".repeat(40),
      branch: "test/profile",
      dirty: false,
      dirtyStatusSha256: null,
      resumeSafe: true,
    },
    environment: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      effectiveTZ: "Asia/Singapore",
      effectiveChildEnvironmentSha256: digestEnvironment({
        PATH: "/usr/bin",
        TZ: "Asia/Singapore",
      }),
    },
    selection: {
      root: "packages/web/tests",
      pattern: "**/*.test.tsx",
      files: ["tests/a.test.tsx", "tests/b.test.tsx"],
      count: 2,
    },
    runner: {
      serial: true,
      cwd: "/repo/packages/web",
      executable: process.execPath,
      argsTemplate: ["--test", "{file}"],
      environment: { TZ: "Asia/Singapore" },
      perFileTimeoutMs: 1_000,
      totalTimeoutMs: 10_000,
      killGraceMs: 50,
      testTimeoutMs: 500,
      maxFilesPerInvocation: 1,
    },
  };
  return {
    ...base,
    ...overrides,
    source: { ...base.source, ...overrides.source },
    environment: { ...base.environment, ...overrides.environment },
    selection: { ...base.selection, ...overrides.selection },
    runner: { ...base.runner, ...overrides.runner },
  };
}

function passedOutcome(file, durationMs = 10) {
  return {
    status: "passed",
    startedAt: "2026-07-13T00:00:00.000Z",
    finishedAt: "2026-07-13T00:00:00.010Z",
    durationMs,
    exitCode: 0,
    signal: null,
    interruptSignal: null,
    termSent: false,
    killSent: false,
    spawnError: null,
    stdoutTail: "",
    stderrTail: "",
    command: [process.execPath, "--test", file],
    cwd: "/repo/packages/web",
  };
}

function totalTimeoutOutcome(file) {
  return {
    ...passedOutcome(file, 25),
    status: "total_timeout",
    exitCode: null,
    signal: "SIGTERM",
    termSent: true,
  };
}

test("atomic checkpoint replacement preserves the old JSON if pre-rename work fails", (t) => {
  const directory = temporaryDirectory(t);
  const checkpointPath = path.join(directory, "profile.json");
  const original = { generation: 1, payload: "old" };
  atomicWriteJson(checkpointPath, original);
  assert.deepEqual(JSON.parse(readFileSync(checkpointPath, "utf8")), original);

  assert.throws(
    () => atomicWriteJson(checkpointPath, { generation: 2, payload: "new" }, {
      beforeRename: () => {
        throw new Error("injected before rename");
      },
    }),
    /injected before rename/,
  );
  assert.deepEqual(JSON.parse(readFileSync(checkpointPath, "utf8")), original);
  assert.deepEqual(readdirSync(directory), ["profile.json"]);

  const replacement = { generation: 3, payload: "final" };
  atomicWriteJson(checkpointPath, replacement);
  assert.deepEqual(JSON.parse(readFileSync(checkpointPath, "utf8")), replacement);
  assert.deepEqual(readdirSync(directory), ["profile.json"]);
});

test("process-group timeout escalates from SIGTERM to SIGKILL", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process groups are not available on Windows");
    return;
  }
  const childScript = String.raw`
    const { spawn } = require("node:child_process");
    const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    console.log("grandchild=" + grandchild.pid);
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
  `;
  const outcome = await runCommandWithDeadline({
    executable: process.execPath,
    args: ["-e", childScript],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 250,
    deadlineKind: "per_file",
    killGraceMs: 75,
  });

  assert.equal(outcome.status, "timed_out");
  assert.equal(outcome.termSent, true);
  assert.equal(outcome.killSent, true);
  assert.equal(outcome.signal, "SIGKILL");
  const grandchildPid = Number(outcome.stdoutTail.match(/grandchild=(\d+)/)?.[1]);
  assert.ok(Number.isInteger(grandchildPid), `missing grandchild pid in ${JSON.stringify(outcome.stdoutTail)}`);
  t.after(() => killIfPresent(grandchildPid));

  await assertProcessGone(grandchildPid);
});

test("process-group escalation survives the direct leader exiting on SIGTERM", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process groups are not available on Windows");
    return;
  }
  const childScript = String.raw`
    const { spawn } = require("node:child_process");
    const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    console.log("grandchild=" + grandchild.pid);
    setInterval(() => {}, 1000);
  `;
  const outcome = await runCommandWithDeadline({
    executable: process.execPath,
    args: ["-e", childScript],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 250,
    deadlineKind: "per_file",
    killGraceMs: 75,
  });

  assert.equal(outcome.status, "timed_out");
  assert.equal(outcome.termSent, true);
  assert.equal(outcome.killSent, true);
  assert.equal(outcome.signal, "SIGTERM");
  const grandchildPid = Number(outcome.stdoutTail.match(/grandchild=(\d+)/)?.[1]);
  assert.ok(Number.isInteger(grandchildPid), `missing grandchild pid in ${JSON.stringify(outcome.stdoutTail)}`);
  t.after(() => killIfPresent(grandchildPid));
  await assertProcessGone(grandchildPid);
});

test("max-files checkpoint resumes pending files without rerunning completed files", async (t) => {
  const directory = temporaryDirectory(t);
  const checkpointPath = path.join(directory, "profile.json");
  const currentCompatibility = compatibility();
  const created = loadOrCreateCheckpoint({ checkpointPath, compatibility: currentCompatibility });
  const calls = [];
  const runFile = async (file) => {
    calls.push(file);
    return passedOutcome(file);
  };

  const first = await runProfileInvocation({
    checkpoint: created.checkpoint,
    checkpointPath,
    runFile,
    totalTimeoutMs: 10_000,
    perFileTimeoutMs: 1_000,
    maxFiles: 1,
    abortController: new AbortController(),
    argv: ["profiler", "--max-files", "1"],
  });
  assert.equal(first.stopReason, "max_files");
  assert.deepEqual(first.checkpoint.files.map((file) => file.status), ["passed", "pending"]);

  const resumed = loadOrCreateCheckpoint({ checkpointPath, compatibility: currentCompatibility });
  assert.equal(resumed.resumed, true);
  const second = await runProfileInvocation({
    checkpoint: resumed.checkpoint,
    checkpointPath,
    runFile,
    totalTimeoutMs: 10_000,
    perFileTimeoutMs: 1_000,
    maxFiles: 1,
    abortController: new AbortController(),
    argv: ["profiler", "--max-files", "1"],
  });

  assert.equal(second.stopReason, "complete");
  assert.deepEqual(calls, ["tests/a.test.tsx", "tests/b.test.tsx"]);
  assert.deepEqual(second.checkpoint.files.map((file) => file.status), ["passed", "passed"]);
  assert.equal(second.checkpoint.files[0].attempts.length, 1);
  assert.equal(second.checkpoint.files[1].attempts.length, 1);
  assert.equal(second.summary.pending, 0);
});

test("total-timeout attempts stay pending and are retried on an identical resume", async (t) => {
  const directory = temporaryDirectory(t);
  const checkpointPath = path.join(directory, "profile.json");
  const currentCompatibility = compatibility({
    selection: { files: ["tests/a.test.tsx"], count: 1 },
    runner: { maxFilesPerInvocation: null },
  });
  const created = loadOrCreateCheckpoint({ checkpointPath, compatibility: currentCompatibility });
  let calls = 0;
  const first = await runProfileInvocation({
    checkpoint: created.checkpoint,
    checkpointPath,
    runFile: async (file) => {
      calls += 1;
      return totalTimeoutOutcome(file);
    },
    totalTimeoutMs: 10_000,
    perFileTimeoutMs: 1_000,
    maxFiles: null,
    abortController: new AbortController(),
  });
  assert.equal(first.stopReason, "total_deadline");
  assert.equal(first.checkpoint.files[0].status, "pending");
  assert.equal(first.checkpoint.files[0].attempts[0].status, "total_timeout");

  const resumed = loadOrCreateCheckpoint({ checkpointPath, compatibility: currentCompatibility });
  const second = await runProfileInvocation({
    checkpoint: resumed.checkpoint,
    checkpointPath,
    runFile: async (file) => {
      calls += 1;
      return passedOutcome(file);
    },
    totalTimeoutMs: 10_000,
    perFileTimeoutMs: 1_000,
    maxFiles: null,
    abortController: new AbortController(),
  });
  assert.equal(second.stopReason, "complete");
  assert.equal(second.checkpoint.files[0].status, "passed");
  assert.deepEqual(second.checkpoint.files[0].attempts.map((attempt) => attempt.status), ["total_timeout", "passed"]);
  assert.equal(calls, 2);
});

test("dirty-source checkpoints and stale compatibility fail closed without replacement", (t) => {
  const directory = temporaryDirectory(t);
  const dirtyPath = path.join(directory, "dirty.json");
  const dirtyCompatibility = compatibility({
    source: {
      dirty: true,
      dirtyStatusSha256: "b".repeat(64),
      resumeSafe: false,
    },
  });
  loadOrCreateCheckpoint({ checkpointPath: dirtyPath, compatibility: dirtyCompatibility });
  const dirtyBytes = readFileSync(dirtyPath);
  assert.throws(
    () => loadOrCreateCheckpoint({ checkpointPath: dirtyPath, compatibility: dirtyCompatibility }),
    /Dirty-source checkpoints are not resumable/,
  );
  assert.deepEqual(readFileSync(dirtyPath), dirtyBytes);

  const stalePath = path.join(directory, "stale.json");
  const originalCompatibility = compatibility();
  loadOrCreateCheckpoint({ checkpointPath: stalePath, compatibility: originalCompatibility });
  const staleBytes = readFileSync(stalePath);
  assert.throws(
    () => loadOrCreateCheckpoint({
      checkpointPath: stalePath,
      compatibility: compatibility({ source: { commit: "c".repeat(40) } }),
    }),
    /stale or incompatible/,
  );
  assert.deepEqual(readFileSync(stalePath), staleBytes);
});

test("the complete child environment is compatibility-bound without storing secrets", (t) => {
  const directory = temporaryDirectory(t);
  const checkpointPath = path.join(directory, "environment.json");
  const secretName = "PROFILE_TEST_SECRET";
  const secretValue = "do-not-persist-this-value";
  const childEnvironment = {
    PATH: "/usr/bin",
    TZ: "Asia/Singapore",
    [secretName]: secretValue,
  };
  const currentCompatibility = compatibility({
    environment: {
      effectiveChildEnvironmentSha256: digestEnvironment(childEnvironment),
    },
  });
  loadOrCreateCheckpoint({ checkpointPath, compatibility: currentCompatibility });
  const originalBytes = readFileSync(checkpointPath);
  const checkpointText = originalBytes.toString("utf8");
  assert.equal(checkpointText.includes(secretName), false);
  assert.equal(checkpointText.includes(secretValue), false);

  const changedCompatibility = compatibility({
    environment: {
      effectiveChildEnvironmentSha256: digestEnvironment({
        ...childEnvironment,
        ARBITRARY_UNLISTED_VARIABLE: "changed",
      }),
    },
  });
  assert.throws(
    () => loadOrCreateCheckpoint({ checkpointPath, compatibility: changedCompatibility }),
    /stale or incompatible/,
  );
  assert.deepEqual(readFileSync(checkpointPath), originalBytes);
});

test("full-ledger integrity and attempt ordinals reject corrupt checkpoint history", (t) => {
  const directory = temporaryDirectory(t);
  const checkpointPath = path.join(directory, "corrupt-ledger.json");
  const currentCompatibility = compatibility({
    selection: { files: ["tests/a.test.tsx"], count: 1 },
  });
  const checkpoint = createCheckpoint({
    compatibility: currentCompatibility,
    compatibilityHash: hashCompatibility(currentCompatibility),
  });
  const attempt = { attempt: 1, ...passedOutcome("tests/a.test.tsx") };
  const record = checkpoint.files[0];
  record.status = attempt.status;
  record.durationMs = attempt.durationMs;
  record.exitCode = attempt.exitCode;
  record.signal = attempt.signal;
  record.command = attempt.command;
  record.attempts.push(attempt);
  updateSummary(checkpoint);
  sealCheckpoint(checkpoint);
  atomicWriteJson(checkpointPath, checkpoint);
  assert.equal(readCheckpoint(checkpointPath).files[0].attempts[0].attempt, 1);

  checkpoint.files[0].attempts[0].attempt = 99;
  atomicWriteJson(checkpointPath, checkpoint);
  assert.throws(() => readCheckpoint(checkpointPath), /full-ledger integrity seal disagrees/);

  sealCheckpoint(checkpoint);
  atomicWriteJson(checkpointPath, checkpoint);
  assert.throws(() => readCheckpoint(checkpointPath), /invalid attempt ordinal/);
});

test("a tampered compatibility payload cannot reuse the old hash", (t) => {
  const directory = temporaryDirectory(t);
  const checkpointPath = path.join(directory, "tampered.json");
  const currentCompatibility = compatibility();
  const checkpoint = createCheckpoint({
    compatibility: currentCompatibility,
    compatibilityHash: hashCompatibility(currentCompatibility),
  });
  checkpoint.compatibility.runner.perFileTimeoutMs += 1;
  sealCheckpoint(checkpoint);
  atomicWriteJson(checkpointPath, checkpoint);

  assert.throws(() => readCheckpoint(checkpointPath), /metadata\/hash disagree/);
  assert.equal(existsSync(checkpointPath), true);
});
