/**
 * Calibration ratio core for the shard-manifest workflow. Detects when a
 * fresh `profileTestShards` run was taken on hardware that does not match
 * the pinned CI-representative baseline — the failure mode that promoted
 * cluster #13 anchor 5 ("artifact-generation silent gauge") from theoretical
 * to firsthand on 2026-05-29: a contended agent VM wrote a manifest whose
 * per-file timings were uniformly ~1.8x the baseline, the live N* dropped
 * 11 → 10, and nothing in the integrity check caught it.
 *
 * Two callers share this core:
 *   - `auditShardManifestHistory.ts` — retrospective git-log scan
 *   - the refresh-time preflight guard (separate workstream, skyzh) —
 *     prospective write-gate that calls `assessCalibration` and refuses
 *     a manifest write when the median ratio is outside the band.
 *
 * Design notes pinned in #proj-dx:2961b0b4 msg=e074eb1e:
 *
 *   1. Baseline ≠ live manifest. The live manifest may itself be degraded
 *      (it is, as of 2026-05-29: 0440c535 N*=10), so using it as the
 *      reference would poison the comparison — a clean CI-representative
 *      profile would land at median ~0.55x and be rejected as "too fast"
 *      when it is in fact the correct read. The baseline is pinned in a
 *      separate `calibration-baseline.json`, updated via PR review only.
 *
 *   2. Asymmetric ternary. Slow direction is a known-wrong failure mode
 *      (CPU contention on agent VM); fast direction is ambiguous (real
 *      speedup vs. baseline drift vs. test-set shrinkage). Refusing fast
 *      reads would block legitimate CI-env refreshes, so the asymmetry is
 *      intentional:
 *        - median > HIGH (default 1.3)  → invalid (refuse write)
 *        - median ∈ [LOW, HIGH]         → verified
 *        - median < LOW (default 0.77)  → degraded (surface only)
 *
 *   3. Common-files-only ratio. The new run may add or drop tests; ratios
 *      are only meaningful over files present in both samples. If the
 *      overlap is small (< OVERLAP_MIN of the new run), the baseline is
 *      structurally stale and the result is `degraded` regardless of
 *      ratio — the operator must re-pin before trusting calibration.
 */

import { readFileSync } from "node:fs";

export interface FileTiming {
  file: string;
  durationMs: number;
}

export interface CalibrationBaseline {
  schemaVersion: number;
  runner: "agent-vm-ci-representative" | "ci-runner";
  sourceCommit: string;
  recordedAt: string;
  nodeVersion: string;
  totalDurationMsLocal: number;
  maxFileDurationMsLocal: number;
  totalFiles: number;
  note?: string;
  fileTimings: FileTiming[];
}

export type CalibrationStatus = "verified" | "degraded" | "invalid";

export interface CalibrationOptions {
  /** Reject above this median ratio (current/baseline). Default 1.3. */
  highThreshold?: number;
  /** Surface below this median ratio. Default 0.77 (≈ 1/1.3). */
  lowThreshold?: number;
  /** Minimum (commonFiles / currentFiles) before the baseline is treated as stale. Default 0.6. */
  overlapMin?: number;
  /** Ignore files with baseline durationMs below this. Default 1000. */
  minDurationMs?: number;
  /** Cap how many worst-deviating files appear in `sample`. Default 6. */
  sampleSize?: number;
}

export interface CalibrationResult {
  status: CalibrationStatus;
  /** Median of per-file (current/baseline). NaN if n === 0. */
  medianRatio: number;
  /** Mean ratio — sanity-check companion to median. NaN if n === 0. */
  meanRatio: number;
  /** Number of common files used in the ratio computation. */
  n: number;
  /** commonFiles / currentFiles — falls below `overlapMin` when baseline is stale. */
  overlap: number;
  /** Worst-deviating files (largest |log(ratio)|), capped by `sampleSize`. */
  sample: Array<{ file: string; baselineMs: number; currentMs: number; ratio: number }>;
  /** Short machine-readable reason — useful for guard error messages. */
  reason: string;
}

export type CalibrationProvenance =
  | { baselineStatus: "absent" }
  | {
      baselineStatus: "present";
      status: CalibrationStatus;
      medianRatio: number | null;
      n: number;
      overlap: number;
      baselineSourceCommit: string;
      bypass?: true;
    };

export interface CalibrationGateOptions {
  allowUncalibrated?: boolean;
  /** Captured load/parse error when the baseline is unavailable. */
  baselineError?: unknown;
}

export interface CalibrationGateResult {
  calibration: CalibrationResult | null;
  provenance: CalibrationProvenance;
  writeAllowed: boolean;
  /** Exit 3 distinguishes calibration refusal from profile/test failure. */
  exitCode: 3 | null;
  diagnostics: {
    info: string[];
    warnings: string[];
    errors: string[];
  };
}

const DEFAULTS: Required<CalibrationOptions> = {
  highThreshold: 1.3,
  lowThreshold: 0.77,
  overlapMin: 0.6,
  minDurationMs: 1000,
  sampleSize: 6,
};

export function loadBaseline(path: string): CalibrationBaseline {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as CalibrationBaseline;
  if (!Array.isArray(parsed.fileTimings) || parsed.fileTimings.length === 0) {
    throw new Error(`Calibration baseline at ${path} has no fileTimings`);
  }
  return parsed;
}

export function toTimingMap(timings: readonly FileTiming[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of timings) m.set(t.file, t.durationMs);
  return m;
}

function median(xs: number[]): number {
  if (xs.length === 0) return Number.NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return Number.NaN;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function assessCalibration(
  current: readonly FileTiming[],
  baseline: CalibrationBaseline,
  opts: CalibrationOptions = {},
): CalibrationResult {
  // Object spread would let an explicit `undefined` in `opts` clobber a
  // DEFAULTS entry — turning a forgotten threshold into a silent no-op.
  // Only fold in keys whose values are actually present.
  const o: Required<CalibrationOptions> = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as Array<keyof CalibrationOptions>) {
    const v = opts[key];
    if (v !== undefined) o[key] = v;
  }
  const baseMap = toTimingMap(baseline.fileTimings);
  const curMap = toTimingMap(current);

  // Two separate joins:
  //   - `commonFiles` answers "is the file *set* still similar?"  (overlap signal)
  //   - `pairs`        answers "given the files we both have above the noise
  //                     floor, what's the timing ratio?"          (ratio signal)
  // Counting overlap only over the noise-floor-filtered set would conflate
  // "test files are short" with "baseline is stale" — the former is normal
  // for a healthy refresh, the latter is the signal we want this to surface.
  const commonFiles: string[] = [];
  for (const file of curMap.keys()) if (baseMap.has(file)) commonFiles.push(file);
  const overlap = curMap.size > 0 ? commonFiles.length / curMap.size : 0;

  // Ratios over common files where the baseline read isn't sub-noise.
  const pairs: Array<{ file: string; baselineMs: number; currentMs: number; ratio: number }> = [];
  for (const file of commonFiles) {
    const baseMs = baseMap.get(file)!;
    if (baseMs < o.minDurationMs) continue;
    const curMs = curMap.get(file)!;
    pairs.push({ file, baselineMs: baseMs, currentMs: curMs, ratio: curMs / baseMs });
  }
  const ratios = pairs.map((p) => p.ratio);
  const medianRatio = median(ratios);
  const meanRatio = mean(ratios);

  const sample = [...pairs]
    .sort((a, b) => Math.abs(Math.log(b.ratio)) - Math.abs(Math.log(a.ratio)))
    .slice(0, o.sampleSize);

  if (pairs.length === 0) {
    return {
      status: "degraded",
      medianRatio: Number.NaN,
      meanRatio: Number.NaN,
      n: 0,
      overlap,
      sample: [],
      reason: "no common files between current and baseline — baseline is structurally stale, re-pin",
    };
  }

  if (overlap < o.overlapMin) {
    return {
      status: "degraded",
      medianRatio,
      meanRatio,
      n: pairs.length,
      overlap,
      sample,
      reason: `file-overlap ${(overlap * 100).toFixed(0)}% < ${(o.overlapMin * 100).toFixed(0)}% — baseline is stale, re-pin before trusting calibration`,
    };
  }

  if (medianRatio > o.highThreshold) {
    return {
      status: "invalid",
      medianRatio,
      meanRatio,
      n: pairs.length,
      overlap,
      sample,
      reason: `median ratio ${medianRatio.toFixed(2)}x > ${o.highThreshold}x — machine is slower than baseline (CPU contention / non-CI-representative), refuse write per cluster #13`,
    };
  }

  if (medianRatio < o.lowThreshold) {
    return {
      status: "degraded",
      medianRatio,
      meanRatio,
      n: pairs.length,
      overlap,
      sample,
      reason: `median ratio ${medianRatio.toFixed(2)}x < ${o.lowThreshold}x — machine faster than baseline OR baseline drift OR test set shrunk; surface for owner review, do not auto-refuse`,
    };
  }

  return {
    status: "verified",
    medianRatio,
    meanRatio,
    n: pairs.length,
    overlap,
    sample,
    reason: `median ratio ${medianRatio.toFixed(2)}x within [${o.lowThreshold}, ${o.highThreshold}]`,
  };
}

/**
 * Apply the refresh-time write policy and build the provenance embedded in the
 * generated manifest. Keeping this decision pure makes the CLI wiring
 * executable-testable without running the full serial server profile.
 *
 * Policy intentionally matches the original #2279 design:
 * - invalid + no override: refuse the write with exit 3;
 * - invalid + override: write, but stamp `bypass: true` and emit a loud banner;
 * - verified/degraded: write and preserve the assessment in provenance;
 * - absent/unreadable baseline: warn, write, and stamp `baselineStatus: absent`.
 *
 * The last case avoids hard-blocking older/bootstrap checkouts while ensuring
 * the resulting artifact cannot be mistaken for calibration-verified.
 */
export function evaluateCalibrationGate(
  current: readonly FileTiming[],
  baseline: CalibrationBaseline | null,
  opts: CalibrationGateOptions = {},
): CalibrationGateResult {
  const diagnostics = { info: [] as string[], warnings: [] as string[], errors: [] as string[] };

  if (!baseline) {
    diagnostics.warnings.push(
      `[calibration] baseline unavailable, proceeding WITHOUT gate ` +
        `(manifest will record baselineStatus=absent): ${String(opts.baselineError ?? "unknown error")}`,
    );
    return {
      calibration: null,
      provenance: { baselineStatus: "absent" },
      writeAllowed: true,
      exitCode: null,
      diagnostics,
    };
  }

  const calibration = assessCalibration(current, baseline);
  diagnostics.info.push(
    `[calibration] status=${calibration.status} medianRatio=${calibration.medianRatio.toFixed(2)}x ` +
      `n=${calibration.n} overlap=${(calibration.overlap * 100).toFixed(0)}% — ${calibration.reason}`,
  );
  if (calibration.status !== "verified") {
    for (const sample of calibration.sample) {
      diagnostics.errors.push(
        `  worst-deviator ${sample.file}: baseline ${sample.baselineMs}ms → ` +
          `current ${sample.currentMs}ms (${sample.ratio.toFixed(2)}x)`,
      );
    }
  }

  let provenance: CalibrationProvenance = {
    baselineStatus: "present",
    status: calibration.status,
    // n===0 yields NaN; JSON.stringify would silently coerce NaN to null.
    medianRatio: Number.isNaN(calibration.medianRatio) ? null : calibration.medianRatio,
    n: calibration.n,
    overlap: calibration.overlap,
    baselineSourceCommit: baseline.sourceCommit,
  };

  if (calibration.status === "invalid") {
    if (opts.allowUncalibrated) {
      provenance = { ...provenance, bypass: true };
      diagnostics.warnings.push(
        "============================================================",
        "⚠️  CALIBRATION BYPASSED via --allow-uncalibrated",
        `⚠️  median ${calibration.medianRatio.toFixed(2)}x > threshold — this machine is NOT calibration-verified.`,
        "⚠️  Manifest provenance will record calibration.bypass=true.",
        "⚠️  Do NOT rely on N* from this manifest without a CI-representative re-profile.",
        "============================================================",
      );
    } else {
      diagnostics.errors.push(
        "[calibration] REFUSING to write manifest: instrument mis-calibrated vs baseline " +
          "(cluster #13 anchor 5). Re-run on a CI-representative machine, or pass " +
          "--allow-uncalibrated to override.",
      );
      return {
        calibration,
        provenance,
        writeAllowed: false,
        exitCode: 3,
        diagnostics,
      };
    }
  }

  return {
    calibration,
    provenance,
    writeAllowed: true,
    exitCode: null,
    diagnostics,
  };
}
