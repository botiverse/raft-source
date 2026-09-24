import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  aggregateByFile,
  classifyProfileVerdict,
  classifyProfileTimings,
  normalizeReportFile,
  resolveSourceCommit,
} from "../scripts/perf/profileE2eShards.js";
import type {
  PlaywrightJsonReport,
} from "../scripts/perf/profileE2eShards.js";
import { assignOrphans } from "../scripts/runE2eShard.js";

// Asserts on private CI/deploy files that the source-available snapshot does not
// carry; skipped when an exported snapshot's RELEASE_SOURCE marker is present.
const inSourceSnapshot = existsSync(path.join(path.resolve(import.meta.dirname, "../../.."), "RELEASE_SOURCE"));

test("failed-but-timed specs remain usable and explicit", () => {
  const report: PlaywrightJsonReport = {
    stats: { expected: 1, unexpected: 1, flaky: 0, skipped: 0 },
    suites: [{
      specs: [
        { file: "tests/e2e/tests/pass.spec.ts", tests: [{ results: [{ duration: 120, status: "passed" }] }] },
        { file: "tests/e2e/tests/red.spec.ts", tests: [{ results: [{ duration: 340, status: "failed" }] }] },
      ],
    }],
  };

  const classified = classifyProfileTimings(
    ["tests/e2e/tests/pass.spec.ts", "tests/e2e/tests/red.spec.ts"],
    aggregateByFile(report),
  );

  assert.deepEqual(classified.missingTimingFiles, []);
  assert.deepEqual(classified.failedTimedFiles, ["tests/e2e/tests/red.spec.ts"]);
  assert.deepEqual(classified.timings, [
    { file: "tests/e2e/tests/pass.spec.ts", durationMs: 120, profileStatus: "passed" },
    { file: "tests/e2e/tests/red.spec.ts", durationMs: 340, profileStatus: "failed" },
  ]);
});

test("Playwright rootDir-relative report files normalize to the manifest namespace", () => {
  const report: PlaywrightJsonReport = {
    suites: [{
      specs: [
        { file: "agents/claude-model-picker.spec.ts", tests: [{ results: [{ duration: 30_000, status: "failed" }] }] },
      ],
    }],
  };
  const manifestFile = "tests/e2e/tests/agents/claude-model-picker.spec.ts";
  const aggregated = aggregateByFile(report);

  assert.deepEqual(aggregated.get(manifestFile), { durationMs: 30_000, ok: false });
  assert.deepEqual(classifyProfileTimings([manifestFile], aggregated), {
    timings: [{ file: manifestFile, durationMs: 30_000, profileStatus: "failed" }],
    failedTimedFiles: [manifestFile],
    missingTimingFiles: [],
  });
});

test("normalized and absolute Playwright paths keep one manifest key", () => {
  const relative = "tests/e2e/tests/thread/inbox-contract.spec.ts";
  const absolute = path.resolve(import.meta.dirname, "../tests/e2e/tests/thread/inbox-contract.spec.ts");

  assert.equal(normalizeReportFile(relative), relative);
  assert.equal(normalizeReportFile(absolute), relative);
});

test("missing or zero-duration coverage is rejected separately from failures", () => {
  const classified = classifyProfileTimings(
    ["tests/e2e/tests/missing.spec.ts", "tests/e2e/tests/not-timed.spec.ts"],
    new Map([["tests/e2e/tests/not-timed.spec.ts", { durationMs: 0, ok: false }]]),
  );

  assert.deepEqual(classified.timings, []);
  assert.deepEqual(classified.failedTimedFiles, []);
  assert.deepEqual(classified.missingTimingFiles, [
    "tests/e2e/tests/missing.spec.ts",
    "tests/e2e/tests/not-timed.spec.ts",
  ]);
});

test("positive file timings cannot hide process or global profile failures", () => {
  const report: PlaywrightJsonReport = {
    stats: { expected: 58, unexpected: 1, flaky: 0, skipped: 0 },
    errors: [{ message: "global teardown failed" }],
  };

  assert.deepEqual(classifyProfileVerdict([], report, "nonzero"), {
    verdict: "failed_but_timed",
    reasons: ["process_nonzero", "global_error", "unexpected_tests"],
    globalErrorCount: 1,
  });
  assert.deepEqual(classifyProfileVerdict([], { stats: { unexpected: 0 }, errors: [] }, "zero"), {
    verdict: "passed",
    reasons: [],
    globalErrorCount: 0,
  });
});

test("profile source commit is explicit and exact in GitHub Actions", () => {
  const sha = "2bf9298bca0acfeba725df9079aa3f04fbc2ea75";

  assert.equal(resolveSourceCommit({
    GITHUB_ACTIONS: "true",
    GITHUB_SHA: sha,
    E2E_PROFILE_SOURCE_COMMIT: sha,
  }, () => null), sha);
  assert.throws(
    () => resolveSourceCommit({ GITHUB_ACTIONS: "true", GITHUB_SHA: sha }, () => sha),
    /requires E2E_PROFILE_SOURCE_COMMIT and GITHUB_SHA/,
  );
  assert.throws(
    () => resolveSourceCommit({
      GITHUB_ACTIONS: "true",
      GITHUB_SHA: sha,
      E2E_PROFILE_SOURCE_COMMIT: "not-a-sha",
    }, () => null),
    /lowercase 40-character Git SHA/,
  );
  assert.throws(
    () => resolveSourceCommit({
      GITHUB_ACTIONS: "true",
      GITHUB_SHA: sha,
      E2E_PROFILE_SOURCE_COMMIT: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }, () => null),
    /does not match GITHUB_SHA/,
  );
  assert.equal(resolveSourceCommit({}, () => sha), sha);
  assert.throws(() => resolveSourceCommit({}, () => null), /must be a lowercase 40-character Git SHA/);
});

test("stale-manifest orphans distribute deterministically instead of piling onto shard 1", () => {
  const shards = [
    { shard: 1, expectedDurationMs: 10_000, files: [] },
    { shard: 2, expectedDurationMs: 10_000, files: [] },
    { shard: 3, expectedDurationMs: 10_000, files: [] },
  ];
  const orphans = Array.from({ length: 6 }, (_, index) => `tests/e2e/tests/orphan-${index}.spec.ts`);

  const forward = assignOrphans(shards, orphans, 5_000);
  const reverse = assignOrphans(shards, [...orphans].reverse(), 5_000);

  assert.deepEqual([...forward], [...reverse]);
  assert.deepEqual(new Set(forward.values()), new Set([1, 2, 3]));
});

test("committed e2e shard manifest exactly covers every on-disk spec", () => {
  const webRoot = path.resolve(import.meta.dirname, "..");
  const specsRoot = path.join(webRoot, "tests/e2e/tests");
  const manifest = JSON.parse(readFileSync(path.join(webRoot, "e2e-shard-manifest.json"), "utf8")) as {
    totalFiles: number;
    fileTimings: Array<{ file: string }>;
    shards: Array<{ files: string[] }>;
  };

  const onDisk: string[] = [];
  function walk(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && absolute.endsWith(".spec.ts")) {
        onDisk.push(path.relative(webRoot, absolute).split(path.sep).join("/"));
      }
    }
  }
  walk(specsRoot);

  const assigned = manifest.shards.flatMap((shard) => shard.files).sort();
  const timed = manifest.fileTimings.map((timing) => timing.file).sort();
  onDisk.sort();

  assert.equal(manifest.totalFiles, onDisk.length);
  assert.deepEqual(assigned, onDisk);
  assert.deepEqual(timed, onDisk);
});

test("committed e2e shard duration totals reconcile with recorded file timings", () => {
  const manifest = JSON.parse(readFileSync(
    path.resolve(import.meta.dirname, "../e2e-shard-manifest.json"),
    "utf8",
  )) as {
    totalDurationMsLocal: number;
    fileTimings: Array<{ file: string; durationMs: number }>;
    shards: Array<{ shard: number; expectedDurationMs: number; files: string[] }>;
  };

  assert.equal(
    manifest.totalDurationMsLocal,
    manifest.fileTimings.reduce((sum, timing) => sum + timing.durationMs, 0),
    "manifest total must equal the sum of recorded file timings",
  );
  for (const shard of manifest.shards) {
    const assignedTimings = manifest.fileTimings.filter((timing) => shard.files.includes(timing.file));
    assert.equal(
      shard.expectedDurationMs,
      assignedTimings.reduce((sum, timing) => sum + timing.durationMs, 0),
      `shard ${shard.shard} total must equal its assigned file timings`,
    );
  }
});

test("manifest refresh matches formal runner contracts and builds e2e dist first", { skip: inSourceSnapshot && "source-available snapshot has no private CI/deploy files" }, () => {
  const webRoot = path.resolve(import.meta.dirname, "..");
  const repoRoot = path.resolve(webRoot, "../..");
  const refreshWorkflow = readFileSync(path.join(repoRoot, ".github/workflows/manifest-refresh.yml"), "utf8");
  const testWorkflow = readFileSync(path.join(repoRoot, ".github/workflows/test.yml"), "utf8");

  function jobBlock(workflow: string, jobName: string): string {
    const marker = `  ${jobName}:\n`;
    const start = workflow.indexOf(marker);
    assert.notEqual(start, -1, `missing ${jobName} job`);
    const tail = workflow.slice(start + marker.length);
    const nextJob = tail.search(/^  [a-z0-9-]+:\n/m);
    return nextJob === -1 ? tail : tail.slice(0, nextJob);
  }

  function exactRunnerContract(job: string) {
    return {
      runsOn: job.match(/^\s+runs-on:\s+(\S+)$/m)?.[1],
      image: job.match(/^\s+image:\s+(\S+)$/m)?.[1],
      build: job.match(/^\s+run:\s+(VITE_E2E=true VITE_API_URL=\S+ pnpm --filter @botiverse\/raft-web exec vite build)$/m)?.[1],
    };
  }

  const profileJob = jobBlock(refreshWorkflow, "profile-e2e");
  const formalJob = jobBlock(testWorkflow, "e2e");
  const profileContract = exactRunnerContract(profileJob);
  const formalContract = exactRunnerContract(formalJob);

  assert.ok(profileContract.image);
  assert.ok(profileContract.build);
  assert.deepEqual(profileContract, formalContract);
  assert.ok(profileJob.indexOf(profileContract.build) < profileJob.indexOf("pnpm exec tsx scripts/perf/profileE2eShards.ts"));
  assert.match(profileJob, /E2E_PROFILE_SOURCE_COMMIT: \$\{\{ github\.sha \}\}/);
  assert.match(profileJob, /- name: Report e2e profile verdict\n\s+shell: bash\n/);

  const profileServerJob = jobBlock(refreshWorkflow, "profile-server");
  const formalServerJob = jobBlock(testWorkflow, "unit-server");
  const profileServerRunner = profileServerJob.match(/^\s+runs-on:\s+(\S+)$/m)?.[1];
  const formalServerRunner = formalServerJob.match(/^\s+runs-on:\s+(\S+)$/m)?.[1];
  assert.ok(profileServerRunner);
  assert.equal(profileServerRunner, formalServerRunner);

  const publishJob = jobBlock(refreshWorkflow, "publish");
  assert.equal(publishJob.match(/^\s+runs-on:\s+(\S+)$/m)?.[1], profileServerRunner);
  assert.match(publishJob, /- name: Upload paired manifest handoff\n/);
  assert.match(publishJob, /name: manifest-refresh-handoff\n/);
  assert.match(publishJob, /- name: Publish refresh branch when token allows\n/);
  assert.ok(publishJob.indexOf("actions/setup-node@v5") < publishJob.indexOf("manifest-refresh-push.mjs"));
  assert.match(publishJob, /manifest-refresh-push\.mjs --remote origin --branch/);
  assert.match(
    publishJob,
    /steps\.diff\.outputs\.changed == 'true' && steps\.branch_transport\.outputs\.mode == 'push'/,
  );
  assert.match(
    publishJob,
    /steps\.diff\.outputs\.changed == 'true' && steps\.branch_transport\.outputs\.mode == 'artifact_handoff'/,
  );
});
