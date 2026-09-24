import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";
import {
  assessCalibration,
  evaluateCalibrationGate,
  type CalibrationBaseline,
  type FileTiming,
} from "./manifestCalibration.js";

function baselineFrom(timings: FileTiming[]): CalibrationBaseline {
  return {
    schemaVersion: 1,
    runner: "agent-vm-ci-representative",
    sourceCommit: "test",
    recordedAt: "2026-05-29T00:00:00.000Z",
    nodeVersion: "v25.9.0",
    totalDurationMsLocal: timings.reduce((a, t) => a + t.durationMs, 0),
    maxFileDurationMsLocal: Math.max(...timings.map((t) => t.durationMs)),
    totalFiles: timings.length,
    fileTimings: timings,
  };
}

// Synthetic per-file timings — values picked so a uniform multiplier
// applied to every file produces a clean median we can pin against.
const base: FileTiming[] = [
  { file: "a.test.ts", durationMs: 10000 },
  { file: "b.test.ts", durationMs: 8000 },
  { file: "c.test.ts", durationMs: 5000 },
  { file: "d.test.ts", durationMs: 3000 },
  { file: "e.test.ts", durationMs: 2000 },
];

function scaled(factor: number): FileTiming[] {
  return base.map((t) => ({ ...t, durationMs: Math.round(t.durationMs * factor) }));
}

test("verified when current matches baseline within the band", () => {
  const r = assessCalibration(scaled(1.05), baselineFrom(base));
  assert.equal(r.status, "verified");
  assert.equal(r.n, 5);
  assert.equal(r.overlap, 1);
  assert.ok(Math.abs(r.medianRatio - 1.05) < 0.001);
});

test("invalid when machine is uniformly slow (cluster #13 anchor 5 shape)", () => {
  // Joy 5/25 → live 0440c535 was ~1.8x baseline; assertion mirrors that real case.
  const r = assessCalibration(scaled(1.8), baselineFrom(base));
  assert.equal(r.status, "invalid");
  assert.ok(r.medianRatio > 1.3);
  assert.match(r.reason, /refuse write/);
});

test("degraded (not invalid) when machine is uniformly fast", () => {
  // Asymmetric ternary: fast direction surfaces but does NOT auto-refuse —
  // could be a real CI-env speedup, baseline drift, or test-set shrinkage.
  const r = assessCalibration(scaled(0.5), baselineFrom(base));
  assert.equal(r.status, "degraded");
  assert.ok(r.medianRatio < 0.77);
  assert.match(r.reason, /surface for owner review/);
});

test("degraded when file overlap is below threshold (baseline stale)", () => {
  // Current set shares only 1 file with baseline → overlap = 0.2.
  const current: FileTiming[] = [
    { file: "a.test.ts", durationMs: 10000 },
    { file: "new1.test.ts", durationMs: 5000 },
    { file: "new2.test.ts", durationMs: 4000 },
    { file: "new3.test.ts", durationMs: 3000 },
    { file: "new4.test.ts", durationMs: 2000 },
  ];
  const r = assessCalibration(current, baselineFrom(base));
  assert.equal(r.status, "degraded");
  assert.ok(r.overlap < 0.6);
  assert.match(r.reason, /baseline is stale/);
});

test("degraded with empty result when no files overlap at all", () => {
  const current: FileTiming[] = [{ file: "totally-new.test.ts", durationMs: 5000 }];
  const r = assessCalibration(current, baselineFrom(base));
  assert.equal(r.status, "degraded");
  assert.equal(r.n, 0);
  assert.ok(Number.isNaN(r.medianRatio));
  assert.match(r.reason, /no common files/);
});

test("ignores baseline files below minDurationMs noise floor", () => {
  const withNoise = [...base, { file: "noise.test.ts", durationMs: 100 }];
  // Current shifts the noise file by 10x — it must NOT pull the ratio.
  const current = [...scaled(1.05), { file: "noise.test.ts", durationMs: 1000 }];
  const r = assessCalibration(current, baselineFrom(withNoise));
  assert.equal(r.status, "verified");
  assert.equal(r.n, 5, "noise.test.ts must be excluded from ratio");
});

test("explicit `undefined` in opts does NOT clobber defaults (regression)", () => {
  // Spreading `{ highThreshold: undefined }` onto DEFAULTS would silently
  // turn off the high gate — a slow-machine refresh would then pass through
  // as `verified`, defeating the whole guard. The core must treat undefined
  // as "no override" rather than "value of undefined".
  const r = assessCalibration(scaled(1.8), baselineFrom(base), {
    highThreshold: undefined,
    lowThreshold: undefined,
  });
  assert.equal(r.status, "invalid");
});

test("sample surfaces the worst-deviating files for guard error messages", () => {
  const current: FileTiming[] = [
    { file: "a.test.ts", durationMs: 10500 }, // 1.05x
    { file: "b.test.ts", durationMs: 8400 }, // 1.05x
    { file: "c.test.ts", durationMs: 25000 }, // 5.0x  ← worst
    { file: "d.test.ts", durationMs: 3150 }, // 1.05x
    { file: "e.test.ts", durationMs: 2100 }, // 1.05x
  ];
  const r = assessCalibration(current, baselineFrom(base));
  assert.equal(r.sample[0].file, "c.test.ts");
});

test("write gate emits verified provenance for a representative profile", () => {
  const r = evaluateCalibrationGate(scaled(1.05), baselineFrom(base));

  assert.equal(r.writeAllowed, true);
  assert.equal(r.exitCode, null);
  assert.deepEqual(r.provenance, {
    baselineStatus: "present",
    status: "verified",
    medianRatio: 1.05,
    n: 5,
    overlap: 1,
    baselineSourceCommit: "test",
  });
  assert.match(r.diagnostics.info.join("\n"), /status=verified medianRatio=1\.05x/);
  assert.deepEqual(r.diagnostics.warnings, []);
  assert.deepEqual(r.diagnostics.errors, []);
});

test("write gate refuses an invalid profile with exit 3 when no override is present", () => {
  const r = evaluateCalibrationGate(scaled(1.8), baselineFrom(base));

  assert.equal(r.writeAllowed, false);
  assert.equal(r.exitCode, 3);
  assert.equal(r.provenance.baselineStatus, "present");
  assert.equal("bypass" in r.provenance, false);
  assert.match(r.diagnostics.errors.join("\n"), /REFUSING to write manifest/);
  assert.deepEqual(r.diagnostics.warnings, []);
});

test("write gate makes an invalid override loud and stamps bypass=true", () => {
  const r = evaluateCalibrationGate(scaled(1.8), baselineFrom(base), {
    allowUncalibrated: true,
  });

  assert.equal(r.writeAllowed, true);
  assert.equal(r.exitCode, null);
  assert.equal(r.provenance.baselineStatus, "present");
  assert.equal(r.provenance.status, "invalid");
  assert.equal(r.provenance.bypass, true);
  assert.equal(r.diagnostics.warnings[0], "============================================================");
  assert.equal(r.diagnostics.warnings.at(-1), "============================================================");
  assert.match(r.diagnostics.warnings.join("\n"), /CALIBRATION BYPASSED via --allow-uncalibrated/);
  assert.match(r.diagnostics.warnings.join("\n"), /Do NOT rely on N\*/);
});

test("write gate preserves bootstrap policy when the baseline is absent", () => {
  const r = evaluateCalibrationGate(base, null, {
    baselineError: new Error("ENOENT calibration-baseline.json"),
  });

  assert.equal(r.writeAllowed, true, "baseline absence is warning-only by #2279 design");
  assert.equal(r.exitCode, null);
  assert.equal(r.calibration, null);
  assert.deepEqual(r.provenance, { baselineStatus: "absent" });
  assert.match(r.diagnostics.warnings.join("\n"), /proceeding WITHOUT gate/);
  assert.match(r.diagnostics.warnings.join("\n"), /ENOENT calibration-baseline\.json/);
  assert.deepEqual(r.diagnostics.errors, []);
});

test(
  "profileTestShards CLI refuses before write and stamps an explicit bypass",
  { skip: process.platform === "win32" },
  () => {
    // Execute the real CLI source in a two-file fixture instead of re-running
    // the full corpus. The parent process uses the real Node+tsx entrypoint;
    // only the CLI's child `pnpm` and Vitest `node` command are deterministic
    // fakes. This proves both the list/profile/gate/write boundary and that all
    // files share one Vitest process.
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), "manifest-calibration-cli-"));
    try {
      const serverDir = path.join(fixtureRoot, "packages/server");
      const perfDir = path.join(serverDir, "scripts/perf");
      const fakeBin = path.join(fixtureRoot, "fake-bin");
      mkdirSync(perfDir, { recursive: true });
      mkdirSync(fakeBin, { recursive: true });

      const profileSource = new URL("./profileTestShards.ts", import.meta.url);
      const calibrationSource = new URL("./manifestCalibration.ts", import.meta.url);
      const profilePath = path.join(perfDir, "profileTestShards.ts");
      const baselinePath = path.join(perfDir, "calibration-baseline.json");
      copyFileSync(profileSource, profilePath);
      copyFileSync(calibrationSource, path.join(perfDir, "manifestCalibration.ts"));

      const fixtureTimings: FileTiming[] = [
        { file: "src/fixture-a.test.ts", durationMs: 1000 },
        { file: "src/fixture-b.test.ts", durationMs: 1000 },
      ];
      const baseline = baselineFrom(fixtureTimings);
      baseline.sourceCommit = "fixture-baseline";
      writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n");
      for (const fixtureTiming of fixtureTimings) {
        const fixtureTestPath = path.join(serverDir, fixtureTiming.file);
        mkdirSync(path.dirname(fixtureTestPath), { recursive: true });
        writeFileSync(fixtureTestPath, "// child execution is replaced by the deterministic fixture node\n");
      }

      const fakePnpm = path.join(fakeBin, "pnpm");
      const fakeNode = path.join(fakeBin, "node");
      writeFileSync(fakePnpm, "#!/bin/sh\nexit 0\n");
      // The fake emits the same JSON shape as Vitest's reporter. A 1.5s file
      // duration is safely above the 1.3x baseline and keeps both CLI runs
      // deterministic without depending on host load.
      writeFileSync(
        fakeNode,
        [
          "#!/bin/sh",
          "for arg in \"$@\"; do",
          "  case \"$arg\" in",
          "    --outputFile=*) output=${arg#--outputFile=} ;;",
          "  esac",
          "done",
          "printf 'x' >> \"$FAKE_NODE_CALLS\"",
          "printf '{\"success\":true,\"testResults\":[{\"name\":\"%s/src/fixture-a.test.ts\",\"status\":\"passed\",\"startTime\":0,\"endTime\":1500},{\"name\":\"%s/src/fixture-b.test.ts\",\"status\":\"passed\",\"startTime\":0,\"endTime\":1500}]}\\n' \"$PWD\" \"$PWD\" > \"$output\"",
          "exit 0",
          "",
        ].join("\n"),
      );
      chmodSync(fakePnpm, 0o755);
      chmodSync(fakeNode, 0o755);

      const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
      const fakeNodeCalls = path.join(fixtureRoot, "fake-node-calls");
      const env = {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
        FAKE_NODE_CALLS: fakeNodeCalls,
      };
      const run = (args: string[] = []) =>
        spawnSync(process.execPath, ["--import", "tsx", profilePath, ...args], {
          cwd: repoRoot,
          env,
          encoding: "utf8",
          timeout: 20_000,
        });
      const manifestPath = path.join(serverDir, "test-shard-manifest.json");

      const refused = run();
      assert.equal(refused.error, undefined);
      assert.equal(refused.status, 3, refused.stderr || refused.stdout);
      assert.equal(existsSync(manifestPath), false, "refusal must happen before manifest write");
      assert.match(refused.stderr, /REFUSING to write manifest/);
      assert.equal(readFileSync(fakeNodeCalls, "utf8"), "x", "all files must share one Vitest process");

      const bypassed = run(["--allow-uncalibrated"]);
      assert.equal(bypassed.error, undefined);
      assert.equal(bypassed.status, 0, bypassed.stderr || bypassed.stdout);
      assert.match(bypassed.stderr, /CALIBRATION BYPASSED via --allow-uncalibrated/);
      assert.equal(readFileSync(fakeNodeCalls, "utf8"), "xx", "each CLI run must start Vitest once");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        calibration?: {
          baselineStatus?: string;
          status?: string;
          medianRatio?: number;
          n?: number;
          overlap?: number;
          baselineSourceCommit?: string;
          bypass?: boolean;
        };
      };
      assert.equal(manifest.calibration?.baselineStatus, "present");
      assert.equal(manifest.calibration?.status, "invalid");
      assert.ok((manifest.calibration?.medianRatio ?? 0) > 1.3);
      assert.equal(manifest.calibration?.n, 2);
      assert.equal(manifest.calibration?.overlap, 1);
      assert.equal(manifest.calibration?.baselineSourceCommit, baseline.sourceCommit);
      assert.equal(manifest.calibration?.bypass, true);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  },
);
