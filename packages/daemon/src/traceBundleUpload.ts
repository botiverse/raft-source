import { createHash, randomBytes, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { errorClassOf, errorCodeOf } from "@botiverse/raft-shared";
import type { Tracer } from "@botiverse/raft-shared";
import { DirectUploadTargetOriginError, uploadWithSignedCapability } from "./directUploadCapability";
import { logger } from "./logger";
import { bucketDelayMs, computeTraceJitter, NO_JITTER, traceFileFamily, type TraceJitter } from "@botiverse/raft-trace-client";

const TRACE_UPLOAD_SCOPE = "daemon-trace-bundle:create";
const DEFAULT_UPLOAD_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MIN_FILE_AGE_MS = 60 * 1000;

/**
 * What the uploader knows about itself across restarts.
 *
 * On disk so that a question like "when did this machine last try, and has it
 * been failing since?" can be answered from the machine itself — the case
 * #408 is about is one where nothing reached the server, so a server-side
 * record is precisely what is missing.
 *
 * NOTE: nothing reads this file yet. It is written here so the history exists
 * when someone goes looking; wiring a reader (the feedback/evidence bundle is
 * the obvious candidate — it already collects from `machineDir`, though today
 * only `traces/daemon-trace-*.jsonl`) is a separate change. Recorded rather
 * than left implicit, so it does not quietly stay write-only (@Stone).
 */
interface UploaderState {
  lastPassAt: string;
  lastPassTrigger: string;
  lastPassCandidates: number;
  lastPassUploaded: number;
  /** Consecutive passes that uploaded nothing while having something to upload. */
  consecutiveFailedPasses: number;
  lastSuccessAt?: string;
}

/**
 * Read back defensively: the file is JSON off a disk that another version, or a
 * half-finished edit, may have written. An unchecked `as UploaderState` lets a
 * string through, and `"3" + 1` is `"31"` — which would then be written back to
 * the file AND onto the span, turning one bad field into a permanent one
 * (@Stone).
 */
function normalizeUploaderState(raw: Record<string, unknown>): UploaderState {
  const count = raw.consecutiveFailedPasses;
  const lastSuccessAt = raw.lastSuccessAt;
  return {
    lastPassAt: typeof raw.lastPassAt === "string" ? raw.lastPassAt : "",
    lastPassTrigger: typeof raw.lastPassTrigger === "string" ? raw.lastPassTrigger : "",
    lastPassCandidates: Number.isSafeInteger(raw.lastPassCandidates) ? raw.lastPassCandidates as number : 0,
    lastPassUploaded: Number.isSafeInteger(raw.lastPassUploaded) ? raw.lastPassUploaded as number : 0,
    consecutiveFailedPasses:
      typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : 0,
    ...(typeof lastSuccessAt === "string" ? { lastSuccessAt } : {}),
  };
}

interface WriteFailureShape {
  total: number;
  lastCode: string | null;
  lastOutcome: string | null;
  rollbacks: number;
  rotations: number;
  droppedAttrsByReason?: Record<string, number>;
  droppedAttrNames?: Record<string, number>;
  droppedAttrNamesOverflow?: number;
}

interface AttrDropReportShape {
  prunedNames: readonly string[];
  prunedNamesOverflow: number;
  prunedTotal: number;
  windowByReason: Record<string, number>;
  windowNames: Record<string, number>;
  windowNamesFull: boolean;
  cumulativeByReason: Record<string, number>;
  reportsUndelivered: number;
}

/**
 * Bounded attrs for one window of sanitizer drops.
 *
 * Emitted only when that window actually dropped something, so a healthy sink
 * adds no keys. Names come from the window's table, which the sink caps; they
 * are key names, never values.
 */
/**
 * Pruned-without-receipt, always beside its denominator.
 *
 * **Precondition, for whoever adds cleanup to `trace-uploads/` later.** This
 * figure is computed by checking pruned filenames against the receipts in that
 * directory, so receipts must be retained at least as long as the OLDEST file
 * still in `traces/`. A file's last chance to be uploaded is the span of time it
 * remains in `traces/`; a receipt only has to outlive that. Delete receipts
 * sooner and an already-uploaded file looks like one that was never sent, which
 * inflates this number rather than breaking anything visibly (@Manjusaka,
 * @Leiysky). The constraint is on the *action* of adding cleanup, which is why
 * it is also recorded on the card — someone trimming that directory to save
 * disk will be editing elsewhere and would never see this comment.
 *
 * "Three deleted with no receipt" means something entirely different when three
 * files were deleted than when three thousand were, so the total is reported in
 * the same breath and a reader can form the ratio without fetching a second
 * number (@Leiysky). When the name buffer overflowed the figure is a LOWER
 * bound, and `pruned_names_overflow` is what says so.
 */
function prunedAttrs(
  report: AttrDropReportShape | null,
  withoutReceipt: number,
): Record<string, string | number> {
  if (!report || !(report.prunedTotal > 0)) return {};
  return {
    pruned_total: report.prunedTotal,
    pruned_without_receipt: withoutReceipt,
    ...(report.prunedNamesOverflow > 0 ? { pruned_names_overflow: report.prunedNamesOverflow } : {}),
  };
}

function attrDropReportAttrs(report: AttrDropReportShape | null): Record<string, string | number | boolean> {
  if (!report) return {};
  const windowTotal = Object.values(report.windowByReason).reduce((sum, n) => sum + n, 0);
  const cumulativeTotal = Object.values(report.cumulativeByReason).reduce((sum, n) => sum + n, 0);
  if (windowTotal <= 0 && cumulativeTotal <= 0 && report.reportsUndelivered <= 0) return {};
  const names = Object.keys(report.windowNames).sort();
  return {
    sink_attrs_dropped_window: windowTotal,
    sink_attrs_dropped_cumulative: cumulativeTotal,
    ...(names.length > 0 ? { sink_attrs_dropped_window_names: names.join(",") } : {}),
    ...(report.windowNamesFull ? { sink_attrs_dropped_window_names_full: true } : {}),
    ...(report.reportsUndelivered > 0
      ? { attr_drop_reports_undelivered: report.reportsUndelivered }
      : {}),
  };
}

/**
 * Bounded attrs for sink write failures. Emitted only when there is something
 * to report, so a healthy machine adds no keys. `last_error_code` is already
 * folded to a closed set by the sink (`reportedFsErrorCode`).
 */
function traceWriteFailureAttrs(stats: WriteFailureShape | null | undefined): Record<string, string | number> {
  if (!stats) return {};
  // Attribute drops are NOT reported here: they belong to the window report,
  // which is produced by the same drain call. Emitting them from both places
  // would give a reader two numbers for one thing on different schedules.
  if (stats.total <= 0) return {};
  return {
    sink_write_failures: stats.total,
    sink_write_truncated: stats.rollbacks,
    sink_write_rotated: stats.rotations,
    ...(stats.lastCode ? { sink_write_last_error_code: stats.lastCode } : {}),
    ...(stats.lastOutcome ? { sink_write_last_outcome: stats.lastOutcome } : {}),
  };
}

/**
 * Pull the server-minted upload identity out of the attestation metadata.
 *
 * Typed narrowly and defensively: the attestation `metadata` is
 * `Record<string, unknown>` off the wire, and an older server may not send
 * these at all. A missing value is recorded as absent rather than as a
 * placeholder, so a receipt never claims a join key it does not have.
 */
function readServerUploadIdentity(metadata: Record<string, unknown> | undefined): {
  uploadId?: string;
  objectKey?: string;
} {
  const uploadId = metadata?.uploadId;
  const objectKey = metadata?.objectKey;
  return {
    ...(typeof uploadId === "string" && uploadId.length > 0 ? { uploadId } : {}),
    ...(typeof objectKey === "string" && objectKey.length > 0 ? { objectKey } : {}),
  };
}
const DEFAULT_MAX_FILES_PER_RUN = 4;
// Task #364: one pass of 4 files per 5 min sustains ~20 MiB (rotating files are
// 5 MiB) while prune keeps 8 per family, so a busy machine's backlog was pruned
// before upload. While a pass leaves files deferred and made progress, run more
// passes shortly after, bounded per interval so the upload server sees at most
// (1 + max) x 4 files per machine per interval.
const DEFAULT_CATCHUP_DELAY_MS = 15 * 1000;
const DEFAULT_MAX_CATCHUP_PASSES_PER_INTERVAL = 4;

/**
 * Pick this pass's files oldest-first within each family, taking one family at
 * a time in turn. A plain sorted slice puts every rotating file
 * (`daemon-trace-2…`) ahead of `cli-transport-` and `diag-`, so under a
 * rotating backlog those families never got a slot and were pruned unsent.
 */
export function selectFilesForPass(sortedFiles: readonly string[], maxFiles: number): string[] {
  const byFamily = new Map<string, string[]>();
  for (const file of sortedFiles) {
    const family = traceFileFamily(path.basename(file));
    const list = byFamily.get(family);
    if (list) list.push(file);
    else byFamily.set(family, [file]);
  }
  const queues = [...byFamily.values()];
  const selected: string[] = [];
  while (selected.length < maxFiles && queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      if (selected.length >= maxFiles) break;
      const next = queue.shift();
      if (next) selected.push(next);
    }
  }
  return selected;
}

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

export type UploadTrigger = "initial" | "interval" | "manual" | "catchup";

export interface DaemonTraceBundleUploaderOptions {
  machineDir: string;
  serverUrl: string;
  apiKey: string;
  /**
   * Machine-level upload URL (env or default; see traceUploadUrl.ts). Used for
   * the Computer's diagnostics markers (`daemon-trace-diag-*`), which carry
   * every runner's log tail and so must never go to one server's receiver.
   */
  /** Machine-level receiver; null when this runner has none (a server that is not Raft's, nothing configured). */
  workerUrl: string | null;
  /**
   * Upload URL for this runner's own bundles, read per upload so it follows
   * the attached server's `machine:context`. Falls back to `workerUrl`.
   * `serverProvided` pins every hop to that URL's origin (no redirects, PUT
   * target on the same origin): the daemon did not choose that receiver.
   */
  runnerWorkerUrl?: () => RunnerWorkerTarget;
  /** RAFT_PRIVACY_MODE, read per upload (the server can turn it on after start): nothing is uploaded. */
  privacyMode?: () => boolean;
  tracer?: Tracer;
  fetchImpl?: FetchLike;
  intervalMs?: number;
  minFileAgeMs?: number;
  maxFilesPerRun?: number;
  /** Delay before a catch-up pass while a backlog remains (task #364). */
  catchupDelayMs?: number;
  /** Catch-up passes allowed between two interval ticks (task #364). */
  maxCatchupPassesPerInterval?: number;
  currentFileProvider?: () => string | null;
  /**
   * Write-failure counters from the local sink.
   *
   * The sink cannot report its own failures through a span — it is the span
   * writer, and the file it would write to is the one that just failed. So the
   * counts ride out on the next upload that does succeed. See task #419.
   */
  /**
   * Drains the sink's attribute-drop window. Called once per upload pass: the
   * window advances on the read, and a pass that fails to deliver its report
   * says so through `noteUndelivered` rather than by rewinding.
   */
  /**
   * One call returns the write-failure snapshot and this window's attribute
   * drops, and advances the window. Two separate reads would leave a name
   * dropped between them with no defined window.
   */
  sinkReportProvider?: {
    drain: () => { writeFailures: WriteFailureShape; attrDrops: AttrDropReportShape } | null;
    noteUndelivered: () => void;
  };
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

export interface RunnerWorkerTarget {
  /** Null: no receiver for this runner (a server that is not Raft's, nothing configured); nothing is uploaded. */
  url: string | null;
  serverProvided: boolean;
}

export class DaemonTraceBundleUploader {
  private readonly options: DaemonTraceBundleUploaderOptions;
  private readonly jitter: TraceJitter;
  private readonly timers: Timers;
  private initialDelayTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setTimeout> | null = null;
  private catchupTimer: ReturnType<typeof setTimeout> | null = null;
  private catchupPassesThisInterval = 0;
  /** A scheduled pass still uploading; at most one runs at a time. */
  private scheduledPassInFlight = false;
  private stopped = false;
  private warnedTargetOrigin = false;

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
      void this.runScheduledPass("initial");
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
    if (this.catchupTimer) {
      this.timers.clearTimeout(this.catchupTimer);
      this.catchupTimer = null;
    }
  }

  /**
   * A scheduled pass, followed by a bounded catch-up pass while it left files
   * deferred and uploaded at least one (a failing upload does not retry faster;
   * the interval tick picks it up again).
   */
  private async runScheduledPass(trigger: UploadTrigger): Promise<void> {
    // One pass at a time. A file is skipped only once its receipt exists, and
    // the receipt is written after its upload finishes, so two overlapping
    // passes would both pick the same oldest files and upload them twice. On a
    // slow, backlogged machine a catch-up chain can still be running when the
    // next interval tick fires; that tick is skipped and the chain carries on
    // (review of #9105, HaoHao).
    if (this.scheduledPassInFlight) return;
    if (trigger !== "catchup") {
      this.catchupPassesThisInterval = 0;
      if (this.catchupTimer) {
        this.timers.clearTimeout(this.catchupTimer);
        this.catchupTimer = null;
      }
    }
    let result: { uploaded: number; deferred: number };
    this.scheduledPassInFlight = true;
    try {
      result = await this.uploadOnce(trigger);
    } catch {
      return;
    } finally {
      this.scheduledPassInFlight = false;
    }
    const maxCatchup = this.options.maxCatchupPassesPerInterval ?? DEFAULT_MAX_CATCHUP_PASSES_PER_INTERVAL;
    if (this.stopped || result.deferred === 0 || result.uploaded === 0) return;
    if (this.catchupPassesThisInterval >= maxCatchup || this.catchupTimer) return;
    this.catchupPassesThisInterval += 1;
    this.catchupTimer = this.timers.setTimeout(() => {
      this.catchupTimer = null;
      if (this.stopped) return;
      void this.runScheduledPass("catchup");
    }, this.options.catchupDelayMs ?? DEFAULT_CATCHUP_DELAY_MS);
  }

  /**
   * Drive a single upload pass. `trigger` is surfaced as a span attribute so
   * we can distinguish startup drain vs steady-state ticks in ScopeDB.
   */
  async uploadOnce(trigger: UploadTrigger = "manual"): Promise<{ attempted: number; uploaded: number; deferred: number }> {
    // A span for the PASS, not just for each file. Today a pass that finds
    // nothing emits no span at all, so "scanned and found zero" and "never ran"
    // are the same absence — and #408 is a machine that quietly stopped
    // uploading, which is precisely the first of those two.
    const span = this.options.tracer?.startSpan("daemon.bundle.upload_pass", {
      surface: "daemon",
      kind: "internal",
      attrs: { upload_trigger: trigger },
    });
    // Everything below is inside the try, including the drain. An exception
    // anywhere in the pass would otherwise leave the span unended — and an
    // unended span is no record, which is the same "never ran" appearance this
    // span exists to remove. Today `findUploadCandidates` and `uploadFile`
    // swallow their own failures, but that is a convention, not a guarantee,
    // and a convention is not what a diagnostic should rest on (@Stone).
    let report: { writeFailures: WriteFailureShape; attrDrops: AttrDropReportShape } | null = null;
    let delivered = false;
    try {
      report = this.options.sinkReportProvider?.drain() ?? null;
      const { files, readdirFailed } = await this.findUploadCandidates();
      const considered = selectFilesForPass(files, this.options.maxFilesPerRun ?? DEFAULT_MAX_FILES_PER_RUN);
      const prunedWithoutReceipt = report
        ? await this.countPrunedWithoutReceipt(report.attrDrops.prunedNames ?? [])
        : 0;
      let uploaded = 0;
      for (const file of considered) {
        if (await this.uploadFile(file, trigger)) uploaded += 1;
      }
      // A pass counts as failing only when it had something to upload and
      // uploaded none of it. A pass with nothing to do is not a failure, and
      // counting it as one would make an idle machine look broken.
      const passFailed = considered.length > 0 && uploaded === 0;
      const previous = await this.readUploaderState();
      const nowIso = new Date().toISOString();
      await this.writeUploaderState({
        lastPassAt: nowIso,
        lastPassTrigger: trigger,
        lastPassCandidates: files.length,
        lastPassUploaded: uploaded,
        consecutiveFailedPasses: passFailed ? (previous?.consecutiveFailedPasses ?? 0) + 1 : 0,
        ...(uploaded > 0
          ? { lastSuccessAt: nowIso }
          : previous?.lastSuccessAt
            ? { lastSuccessAt: previous.lastSuccessAt }
            : {}),
      });

      delivered = span !== undefined;
      span?.end(readdirFailed ? "error" : "ok", {
        attrs: {
          candidates: files.length,
          considered: considered.length,
          uploaded,
          failed: considered.length - uploaded,
          deferred: files.length - considered.length,
          readdir_failed: readdirFailed,
          consecutive_failed_passes: passFailed ? (previous?.consecutiveFailedPasses ?? 0) + 1 : 0,
          ...attrDropReportAttrs(report?.attrDrops ?? null),
          ...prunedAttrs(report?.attrDrops ?? null, prunedWithoutReceipt),
          ...traceWriteFailureAttrs(report?.writeFailures ?? null),
        },
      });
      return { attempted: files.length, uploaded, deferred: files.length - considered.length };
    } catch (err) {
      // The pass still gets a record, carrying the window it already drained.
      delivered = span !== undefined;
      span?.end("error", {
        attrs: {
          pass_exception_class: errorClassOf(err),
          ...((): Record<string, string> => {
            const code = errorCodeOf(err);
            return code ? { pass_exception_code: code } : {};
          })(),
          ...attrDropReportAttrs(report?.attrDrops ?? null),
          ...traceWriteFailureAttrs(report?.writeFailures ?? null),
        },
      });
      throw err;
    } finally {
      // The window advanced when it was read. If no span carried it, say so
      // rather than rewinding — a name belongs to exactly one window.
      if (report && !delivered) this.options.sinkReportProvider?.noteUndelivered();
    }
  }

  private scheduleNextTick(): void {
    if (this.stopped) return;
    const baseIntervalMs = this.options.intervalMs
      ?? readPositiveIntegerEnv("SLOCK_DAEMON_TRACE_UPLOAD_INTERVAL_MS", DEFAULT_UPLOAD_INTERVAL_MS);
    const nextMs = baseIntervalMs + this.jitter.uploadIntervalJitterMs;
    this.intervalTimer = this.timers.setTimeout(() => {
      this.intervalTimer = null;
      if (this.stopped) return;
      void this.runScheduledPass("interval");
      this.scheduleNextTick();
    }, nextMs);
  }

  private async findUploadCandidates(): Promise<{ files: string[]; readdirFailed: boolean }> {
    const traceDir = path.join(this.options.machineDir, "traces");
    let names: string[];
    try {
      names = await readdir(traceDir);
    } catch {
      // "No candidates" has two causes that look identical from outside: the
      // directory really is empty, or we could not read it. Without this flag a
      // permanently unreadable trace directory reports the same zero as a
      // healthy idle machine — and #408 is exactly a machine that silently
      // stopped uploading (task #408 item 3).
      return { files: [], readdirFailed: true };
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
        // `minAgeMs: 0` means no age check: `Date.now()` is whole
        // milliseconds and `mtimeMs` is not, so a file written in the same
        // millisecond reads as slightly in the future.
        if (minAgeMs > 0 && now - info.mtimeMs < minAgeMs) continue;
        candidates.push(file);
      } catch {
        // Trace upload must stay fail-open.
      }
    }
    return { files: candidates, readdirFailed: false };
  }

  /**
   * How many files prune deleted this window that had never been uploaded.
   *
   * The sink records only what it deleted; the receipt set lives here, so the
   * judging happens on this side. A name with no receipt means those spans left
   * the machine without ever reaching the server — the loss #408 is about.
   */
  private async countPrunedWithoutReceipt(names: readonly string[]): Promise<number> {
    let withoutReceipt = 0;
    for (const name of names) {
      // `uploadStatePath` takes a path and uses its basename, so a bare name is
      // the same lookup the upload path performs.
      if (!await this.isUploaded(path.join(this.options.machineDir, "traces", name))) withoutReceipt += 1;
    }
    return withoutReceipt;
  }

  private uploaderStatePath(): string {
    return path.join(this.options.machineDir, "trace-uploads", "uploader-state.json");
  }

  private async readUploaderState(): Promise<UploaderState | null> {
    try {
      const parsed = JSON.parse(await readFile(this.uploaderStatePath(), "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object") return null;
      return normalizeUploaderState(parsed as Record<string, unknown>);
    } catch {
      // Absent on first run, and unreadable or truncated is treated the same:
      // the state is a convenience, so a bad file must never stop an upload.
      return null;
    }
  }

  /**
   * Replace the state file atomically.
   *
   * Written to a temp name and renamed, so a reader never sees a half-written
   * file and a crash mid-write cannot leave one behind. `writeFile` in place
   * would publish the truncation before the content — and this file exists to
   * be read after exactly the kind of abrupt stop that would cause that.
   */
  private async writeUploaderState(state: UploaderState): Promise<void> {
    const target = this.uploaderStatePath();
    const tmp = `${target}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
    try {
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      // fsync before the rename, matching the salt file. Without it a power
      // loss just after the rename can leave a zero-length target; the next
      // read then returns null, `consecutiveFailedPasses` quietly resets and
      // `lastSuccessAt` is lost — on exactly the machines #408 is about, where
      // that history is the only record there is (@Stone).
      const handle = await open(tmp, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, target);
    } catch {
      // Never let bookkeeping break uploading. A crash between the write and
      // the rename can still strand a `.tmp`; this cleanup only runs when the
      // failure is an exception we catch.
      await rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  /** Diag markers are machine-level; everything else this runner wrote is per-server. */
  private workerTargetFor(file: string): RunnerWorkerTarget {
    if (this.options.privacyMode?.()) return { url: null, serverProvided: false };
    const machineLevel = { url: this.options.workerUrl, serverProvided: false };
    if (traceFileFamily(path.basename(file)) === "diag") return machineLevel;
    const runner = this.options.runnerWorkerUrl?.();
    return runner?.url ? runner : machineLevel;
  }

  private async uploadFile(file: string, trigger: UploadTrigger): Promise<boolean> {
    const { url: workerUrl, serverProvided } = this.workerTargetFor(file);
    // No receiver for this runner (traceUploadUrl.ts): nothing leaves the
    // machine, and no span per file per tick says so.
    if (!workerUrl) return false;
    const span = this.options.tracer?.startSpan("daemon.bundle.upload", {
      surface: "daemon",
      kind: "producer",
      attrs: {
        file_present: true,
        worker_url_present: Boolean(workerUrl),
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
      const { capability } = await uploadWithSignedCapability({
        serverUrl: this.options.serverUrl,
        apiKey: this.options.apiKey,
        workerUrl,
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
        pinWorkerOrigin: serverProvided,
      });
      // The server mints the uploadId and derives the object key from it
      // (`trace-bundles/<serverId>/<machineId>/<uploadId>.jsonl.gz`), and hands
      // both back in the attestation metadata. Until now the daemon discarded
      // them and the receipt recorded only `bundleId`, which is a local
      // randomUUID — so a receipt on disk could not be joined to the stored
      // object or to the upload ledger. Every "did this file actually land"
      // question had to be answered by matching timestamps instead. Task #408.
      const serverUpload = readServerUploadIdentity(capability.metadata);
      await this.markUploaded(file, {
        bundleId,
        bundleSha256,
        bundleSizeBytes: gzipped.byteLength,
        ...serverUpload,
      });
      span?.end("ok", {
        attrs: {
          bundleId,
          bundle_size_bytes: gzipped.byteLength,
          // Identity only, no content: this is the join key to the ledger.
          //
          // The key is `uploadId`, not `upload_id`, and that is load-bearing:
          // `LocalRotatingTraceSink.sanitizeAttrs` drops any attribute whose
          // normalized name ends in `_id` unless it is in DIAGNOSTIC_ID_ATTRS,
          // and that allowlist holds the camelCase `uploadId`. Written as
          // `upload_id` the value is silently deleted on the way to disk and
          // only `upload_id_present` survives — the record would say the key
          // exists while carrying no value. `bundleId` on this same span is
          // spelled the same way for the same reason. (@Stone, #8641 review.)
          ...(serverUpload.uploadId ? { uploadId: serverUpload.uploadId } : {}),
          upload_id_present: Boolean(serverUpload.uploadId),
        },
      });
      return true;
    } catch (err) {
      if (err instanceof DirectUploadTargetOriginError && !this.warnedTargetOrigin) {
        this.warnedTargetOrigin = true;
        logger.warn("[Daemon] Trace upload refused: the server-named receiver returned an upload target on another origin");
      }
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
