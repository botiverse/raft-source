import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Tracer } from "@botiverse/raft-shared";
import { uploadWithSignedCapability } from "./directUploadCapability.js";
import { bucketDelayMs, computeTraceJitter, NO_JITTER, type TraceJitter } from "@botiverse/raft-trace-client";

const TRACE_UPLOAD_SCOPE = "daemon-trace-bundle:create";
const DEFAULT_UPLOAD_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MIN_FILE_AGE_MS = 60 * 1000;
const DEFAULT_MAX_FILES_PER_RUN = 4;

/**
 * Closed-set of `deployment.environment` values this daemon may self-declare
 * to the upload server. The server applies its own consistency check:
 * `dev` is accepted on non-production servers; other values must match the
 * server's own deployment. See `#proj-o11y:99c372c9` (msg `190440fd`).
 */
const ALLOWED_PRODUCER_DEPLOYMENT_ENVIRONMENTS = new Set([
  "production",
  "staging",
  "dev",
  "test",
  "slockdev",
]);

function readProducerDeploymentEnvironment(): string | undefined {
  const raw = process.env.SLOCK_DAEMON_DEPLOYMENT_ENV;
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (!ALLOWED_PRODUCER_DEPLOYMENT_ENVIRONMENTS.has(trimmed)) return undefined;
  return trimmed;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type TickFn = "setTimeout" | "setInterval" | "clearTimeout" | "clearInterval";
type Timers = Pick<typeof globalThis, TickFn>;

export type UploadTrigger = "initial" | "interval" | "manual";

export interface DaemonTraceBundleUploaderOptions {
  machineDir: string;
  serverUrl: string;
  apiKey: string;
  workerUrl: string;
  tracer?: Tracer;
  fetchImpl?: FetchLike;
  intervalMs?: number;
  minFileAgeMs?: number;
  maxFilesPerRun?: number;
  currentFileProvider?: () => string | null;
  /**
   * Stable machine identity used to derive deterministic jitter. We use
   * `DaemonMachineLockHandle.lockId` (sha256(apiKey) prefix) as the seed so
   * every daemon lands in a different phase slot after fleet restarts, while
   * staying stable across a single daemon's own restarts.
   */
  lockId?: string;
  /** Override the computed jitter (tests only). */
  jitter?: TraceJitter;
  /** Seam for tests to drive timers deterministically. */
  timers?: Timers;
}

export class DaemonTraceBundleUploader {
  private readonly options: DaemonTraceBundleUploaderOptions;
  private readonly jitter: TraceJitter;
  private readonly timers: Timers;
  private initialDelayTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(options: DaemonTraceBundleUploaderOptions) {
    this.options = options;
    this.jitter = options.jitter
      ?? (options.lockId ? computeTraceJitter(options.lockId) : NO_JITTER);
    this.timers = options.timers ?? {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      setInterval: globalThis.setInterval.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
    };
  }

  start(): void {
    if (this.stopped) return;
    if (this.initialDelayTimer || this.intervalTimer) return;

    const initialDelayMs = this.jitter.initialUploadDelayMs;
    this.initialDelayTimer = this.timers.setTimeout(() => {
      this.initialDelayTimer = null;
      if (this.stopped) return;
      void this.uploadOnce("initial");
      this.scheduleNextTick();
    }, initialDelayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.initialDelayTimer) {
      this.timers.clearTimeout(this.initialDelayTimer);
      this.initialDelayTimer = null;
    }
    if (this.intervalTimer) {
      this.timers.clearTimeout(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  /**
   * Drive a single upload pass. `trigger` is surfaced as a span attribute so
   * we can distinguish startup drain vs steady-state ticks in ScopeDB.
   */
  async uploadOnce(trigger: UploadTrigger = "manual"): Promise<{ attempted: number; uploaded: number }> {
    const files = await this.findUploadCandidates();
    let uploaded = 0;
    for (const file of files.slice(0, this.options.maxFilesPerRun ?? DEFAULT_MAX_FILES_PER_RUN)) {
      if (await this.uploadFile(file, trigger)) uploaded += 1;
    }
    return { attempted: files.length, uploaded };
  }

  private scheduleNextTick(): void {
    if (this.stopped) return;
    const baseIntervalMs = this.options.intervalMs
      ?? readPositiveIntegerEnv("SLOCK_DAEMON_TRACE_UPLOAD_INTERVAL_MS", DEFAULT_UPLOAD_INTERVAL_MS);
    const nextMs = baseIntervalMs + this.jitter.uploadIntervalJitterMs;
    this.intervalTimer = this.timers.setTimeout(() => {
      this.intervalTimer = null;
      if (this.stopped) return;
      void this.uploadOnce("interval");
      this.scheduleNextTick();
    }, nextMs);
  }

  private async findUploadCandidates(): Promise<string[]> {
    const traceDir = path.join(this.options.machineDir, "traces");
    let names: string[];
    try {
      names = await readdir(traceDir);
    } catch {
      return [];
    }

    const now = Date.now();
    const minAgeMs = this.options.minFileAgeMs ?? readPositiveIntegerEnv("SLOCK_DAEMON_TRACE_UPLOAD_MIN_FILE_AGE_MS", DEFAULT_MIN_FILE_AGE_MS);
    const currentFile = this.options.currentFileProvider?.();
    const candidates: string[] = [];
    for (const name of names.filter((entry) => entry.startsWith("daemon-trace-") && entry.endsWith(".jsonl")).sort()) {
      const file = path.join(traceDir, name);
      if (currentFile && path.resolve(file) === path.resolve(currentFile)) continue;
      if (await this.isUploaded(file)) continue;
      try {
        const info = await stat(file);
        if (!info.isFile() || info.size <= 0) continue;
        if (now - info.mtimeMs < minAgeMs) continue;
        candidates.push(file);
      } catch {
        // Trace upload must stay fail-open.
      }
    }
    return candidates;
  }

  private async uploadFile(file: string, trigger: UploadTrigger): Promise<boolean> {
    const span = this.options.tracer?.startSpan("daemon.bundle.upload", {
      surface: "daemon",
      kind: "producer",
      attrs: {
        file_present: true,
        worker_url_present: Boolean(this.options.workerUrl),
        upload_trigger: trigger,
        initial_delay_ms_bucket: bucketDelayMs(this.jitter.initialUploadDelayMs),
        interval_jitter_ms_bucket: bucketDelayMs(this.jitter.uploadIntervalJitterMs),
      },
    });
    try {
      const raw = await readFile(file);
      if (raw.byteLength === 0) {
        span?.end("cancelled", { attrs: { outcome: "empty" } });
        return false;
      }
      const gzipped = gzipSync(raw);
      const bundleSha256 = sha256Hex(gzipped);
      const bundleId = randomUUID();
      await uploadWithSignedCapability({
        serverUrl: this.options.serverUrl,
        apiKey: this.options.apiKey,
        workerUrl: this.options.workerUrl,
        scope: TRACE_UPLOAD_SCOPE,
        createPath: "/api/trace-bundles",
        attestationMetadata: {
          bundleId,
          bundleSha256,
          bundleSizeBytes: gzipped.byteLength,
          ...((): Record<string, string> => {
            const env = readProducerDeploymentEnvironment();
            return env ? { deploymentEnvironment: env } : {};
          })(),
        },
        createBody: {
          bundleSha256,
          bundleSizeBytes: gzipped.byteLength,
        },
        uploadBody: new Blob([new Uint8Array(gzipped)], { type: "application/x-ndjson" }),
        fetchImpl: this.options.fetchImpl,
      });
      await this.markUploaded(file, {
        bundleId,
        bundleSha256,
        bundleSizeBytes: gzipped.byteLength,
      });
      span?.end("ok", {
        attrs: {
          bundleId,
          bundle_size_bytes: gzipped.byteLength,
        },
      });
      return true;
    } catch (err) {
      span?.end("error", {
        attrs: {
          error_class: err instanceof Error ? err.name : "Error",
          error_message_present: err instanceof Error && Boolean(err.message),
        },
      });
      return false;
    }
  }

  private uploadStatePath(file: string): string {
    const stateDir = path.join(this.options.machineDir, "trace-uploads");
    return path.join(stateDir, `${path.basename(file)}.uploaded.json`);
  }

  private async isUploaded(file: string): Promise<boolean> {
    try {
      await stat(this.uploadStatePath(file));
      return true;
    } catch {
      return false;
    }
  }

  private async markUploaded(file: string, metadata: Record<string, unknown>): Promise<void> {
    const stateFile = this.uploadStatePath(file);
    await mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
    await writeFile(stateFile, `${JSON.stringify({
      file: path.basename(file),
      uploadedAt: new Date().toISOString(),
      ...metadata,
    }, null, 2)}\n`, { mode: 0o600 });
  }
}

function sha256Hex(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
