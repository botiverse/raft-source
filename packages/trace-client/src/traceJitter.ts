import { createHash } from "node:crypto";

/**
 * Deterministic per-machine jitter for the daemon trace pipeline.
 *
 * We derive three independent offsets from the stable machine lockId
 * (`machine-<apiKey fingerprint prefix>`), so that after a simultaneous
 * fleet-wide restart every daemon lands in a different phase slot. This
 * prevents thundering-herd spikes on:
 *   - the initial upload drain after startup
 *   - the periodic upload tick
 *   - the `maxFileAgeMs` rotation on `LocalRotatingTraceSink`
 *
 * Using a stable hash (instead of per-tick random) keeps a given machine
 * in the same relative phase across restarts, which is the whole point —
 * we do NOT want daemons to re-cluster after every restart.
 */
export interface TraceJitter {
  /** Delay before first upload attempt after daemon start (0 - 30s). */
  initialUploadDelayMs: number;
  /** Added to the configured upload interval to keep machines out of phase (0 - 60s). */
  uploadIntervalJitterMs: number;
  /** Added to the configured trace max file age to de-phase age rotation (0 - 60s). */
  maxFileAgeJitterMs: number;
}

const INITIAL_UPLOAD_DELAY_SPAN_MS = 30_000;
const UPLOAD_INTERVAL_JITTER_SPAN_MS = 60_000;
const MAX_FILE_AGE_JITTER_SPAN_MS = 60_000;

export function computeTraceJitter(lockId: string): TraceJitter {
  const seed = createHash("sha256").update(lockId).digest();
  return {
    initialUploadDelayMs: seed.readUInt32BE(0) % INITIAL_UPLOAD_DELAY_SPAN_MS,
    uploadIntervalJitterMs: seed.readUInt32BE(4) % UPLOAD_INTERVAL_JITTER_SPAN_MS,
    maxFileAgeJitterMs: seed.readUInt32BE(8) % MAX_FILE_AGE_JITTER_SPAN_MS,
  };
}

/** Zero-jitter fallback for tests and code paths where a lockId is unavailable. */
export const NO_JITTER: TraceJitter = {
  initialUploadDelayMs: 0,
  uploadIntervalJitterMs: 0,
  maxFileAgeJitterMs: 0,
};

/** Bucket a delay in milliseconds into a coarse label for observability attrs. */
export function bucketDelayMs(delayMs: number): string {
  if (delayMs < 1000) return "0-1s";
  if (delayMs < 5000) return "1-5s";
  if (delayMs < 15000) return "5-15s";
  if (delayMs < 30000) return "15-30s";
  if (delayMs < 60000) return "30-60s";
  if (delayMs < 300_000) return "60s-5m";
  if (delayMs < 600_000) return "5-10m";
  return "10m+";
}
