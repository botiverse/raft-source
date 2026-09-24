// DiagnosticsPushService — V0 Sync diagnostics surface for the menu-bar
// (#wg-raft-computer:f2a02081 task #97 → deferred to task #11 → re-opened
// 2026-06-22 by tygg). Yingjun interface lock msg=2753a3ad: b2 semantic —
// return `{queued, correlationId, expectedWindowSec}` immediately and let
// the existing periodic uploader pick the marker up within ~5min, NOT a
// `{reportId, traceId}` that the caller can't actually look up yet.
//
// What this lib call does:
//   1. Generate `correlationId` (uuid).
//   2. Precondition-check (closed reason union, no surprise throws):
//      - NO_TRACE_DIR  — `<computerDir>/traces/` not writable
//      - UPLOAD_DISABLED — env gate (`RAFT_COMPUTER_LOCAL_TRACE=0` flips
//        the Computer tracer to no-op; without local sink, no marker can
//        be written; without daemon traces, no bundle gets uploaded)
//      - OFFLINE — no user session AND no attachments (nothing to upload
//        under, and the user can't recover the marker from any account)
//   3. Write a single marker span (`diagnostics.push`) into:
//      - `<computerDir>/traces/` (computer.cli / menu-bar surface)
//      - each per-server runner's `${SLOCK_HOME}/machines/machine-<fp16>/
//        traces/` (daemon surface) — derived from each attachment's apiKey
//        via the daemon's `getDaemonMachineLockId` (16-hex prefix of
//        sha256(apiKey))
//   4. Return `{status:"queued", correlationId, expectedWindowSec: 300}`.
//      By default, real upload happens on the daemon's existing 5-min
//      periodic uploader pass; migration callers may opt into a forced
//      scrubbed upload pass when they need immediate recoverable evidence.
//      The caller (menu-bar) shows the user an "uploads within ~5 min,
//      keep the menu-bar running" message — honest async UX.
//
// What this DOES NOT do (default user-action path):
//   - Force immediate upload. That remains opt-in so menu-bar keeps the
//     honest queued UX while migration can produce an explicit upload
//     success/failure result.
//   - Per-runner online check. The daemon decides whether to upload on its
//     next periodic tick — if the runner is offline, the marker stays on
//     disk + uploads when the runner comes back. Same as any other trace.
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { currentDate } from "@botiverse/raft-shared";

import {
  computerDir,
  serverRunnerPidReadFallback,
  serverRunnerLogReadFallback,
  serversDir,
  serviceLogPath,
  userSessionPath,
} from "../paths.js";
import { isProcessAlive, readPidfileAt } from "../internal/process-primitives.js";
import type { ComputerApiEvent } from "../lib/events.js";
import { canonicalizeServerUrl } from "../serverUrl.js";
import { buildStatusReport } from "../status.js";

/** Per-runner upload-bearing marker prefix. MUST start with `daemon-trace-`
 *  so the daemon `DaemonTraceBundleUploader.findUploadCandidates` glob
 *  (`startsWith("daemon-trace-") && endsWith(".jsonl")`, traceBundleUpload.ts)
 *  actually picks it up — a `diagnostics-marker-*` name (the original shipped
 *  name) NEVER matched, so the marker sat on disk and every shipped
 *  correlationId was a dead id. (#wg-raft-computer task #102 / a87e1bdb.) */
const RUNNER_MARKER_PREFIX = "daemon-trace-diag-";
/** Computer-surface (computerDir/traces) breadcrumb prefix. LOCAL-ONLY: there
 *  is NO uploader pointed at computerDir (the only DaemonTraceBundleUploader is
 *  per-runner, daemon/core.ts), so this file is for local inspection / doctor
 *  only and is deliberately NOT given the `daemon-trace-` name. Upload happens
 *  exclusively through the per-runner markers. */
const COMPUTER_BREADCRUMB_PREFIX = "diagnostics-marker-";
/** ~5min — the daemon's `DEFAULT_UPLOAD_INTERVAL_MS`. Kept as a number so
 *  the menu-bar can render an honest expected-window. */
const EXPECTED_WINDOW_SEC = 300;
const RUNNER_LOG_TAIL_MAX_LINES = 120;
const RUNNER_LOG_TAIL_MAX_LINE_CHARS = 1_000;
const DEFAULT_TRACE_UPLOAD_URL = "https://slock-trace-upload.botiverse.dev";
const TRACE_UPLOAD_SCOPE = "daemon-trace-bundle:create";
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface DiagnosticsForcedUploadResult {
  serverId: string;
  status: "uploaded" | "no_candidates" | "failed";
  attempted: number;
  uploaded: number;
  bundleSizeBytes?: number;
  errorClass?: string;
}

export interface DiagnosticsLocalBundleResult {
  bundleId: string;
  path: string;
  sizeBytes: number;
}

export type DiagnosticsPushFailReason =
  | "OFFLINE"
  | "NO_TRACE_DIR"
  | "UPLOAD_DISABLED"
  /** No RUNNING runner to carry the upload. Upload only happens through a
   *  per-runner `DaemonTraceBundleUploader` (the only layer with an uploader +
   *  server credential). With zero running runners there is NO upload path, so
   *  we fail-closed rather than return a `queued` correlationId that could
   *  never be looked up (dead-id honesty violation). (task #102.) */
  | "NO_RUNNER";

export type DiagnosticsPushResult =
  | {
      status: "queued";
      /** Stable id the user can quote when filing an issue. Matches the
       *  marker span's `correlationId` attr in every trace dir it was
       *  written into, so a Slock-side query can find it across surfaces. */
      correlationId: string;
      /** Best-effort estimate of when the marker will reach the
       *  upload-worker. Real upload happens on each daemon's existing 5-min
       *  periodic pass. */
      expectedWindowSec: number;
      /** Trace-dir paths the marker was written into. Useful for the
       *  presenter to show "wrote marker to N surfaces" and for tests. */
      markerPaths: string[];
      /** Present only when the caller requested a forced upload pass. */
      uploadResults?: DiagnosticsForcedUploadResult[];
    }
  | {
      status: "failed";
      reason: DiagnosticsPushFailReason;
      /**
       * Present when we cannot queue/upload through a runner but still wrote a
       * local redacted bundle the user can copy/share manually. This is
       * deliberately not a correlationId: no server-side upload is implied.
       */
      localBundle?: DiagnosticsLocalBundleResult;
    };

export interface DiagnosticsPushInput {
  /** The Computer install root the marker is written under. Required
   *  per the BUG 3 sweep convention (compile-required, no ambient env). */
  slockHome: string;
}

export interface DiagnosticsPushOptions {
  signal?: AbortSignal;
  onEvent?: (event: ComputerApiEvent) => void;
  forceUploadNow?: boolean;
  includeComputerTraceRecords?: boolean;
  migrationAttemptId?: string;
  correlationId?: string;
  trigger?: "user_action" | "migration";
  workerUrl?: string;
  fetchImpl?: FetchLike;
}

function emit(opts: DiagnosticsPushOptions | undefined, event: ComputerApiEvent): void {
  const cb = opts?.onEvent;
  if (!cb) return;
  try {
    cb(event);
  } catch {
    // onEvent is best-effort.
  }
}

interface ServerAttachmentLite {
  serverId: string;
  apiKey: string;
  serverUrl: string;
}

async function listAttachmentApiKeys(slockHome: string): Promise<ServerAttachmentLite[]> {
  const root = serversDir(slockHome);
  let names: string[];
  try {
    names = await readdir(root);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const out: ServerAttachmentLite[] = [];
  for (const name of names) {
    try {
      const file = path.join(root, name, "runner.state.json");
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw) as { serverId?: unknown; apiKey?: unknown; serverUrl?: unknown };
      if (
        typeof parsed.serverId === "string" &&
        typeof parsed.apiKey === "string" &&
        parsed.apiKey.length > 0 &&
        typeof parsed.serverUrl === "string" &&
        parsed.serverUrl.length > 0
      ) {
        out.push({ serverId: parsed.serverId, apiKey: parsed.apiKey, serverUrl: canonicalizeServerUrl(parsed.serverUrl) });
      }
    } catch {
      // Skip unreadable / partial attachments — they're tracked by `doctor`.
    }
  }
  return out;
}

function daemonMachineDir(slockHome: string, apiKey: string): string {
  // Mirrors `packages/daemon/src/machineLock.ts::getDaemonMachineLockId` —
  // `machine-<sha256(apiKey).slice(0,16)>`. Duplicated here intentionally
  // so the Computer lib doesn't import from daemon (one-way dependency
  // direction is daemon → computer, not the reverse). If the daemon ever
  // changes the lockId derivation, the contract test below will fail
  // (apiKey fixture → derived path comparison).
  const fp = createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
  return path.join(slockHome, "machines", `machine-${fp}`);
}

/**
 * The marker is a single-line `type:"span"` jsonl record. Same schema as
 * the daemon's `LocalRotatingTraceSink::toLocalTraceRecord` — duplicated
 * inline (the daemon's helper is module-private) and the contract test
 * pins the on-disk shape against a `LocalRotatingTraceSink`-emitted span
 * so a future schema bump trips a single source of truth.
 */
function buildMarkerLine(
  correlationId: string,
  surface: "computer" | "daemon",
  opts: { trigger?: "user_action" | "migration"; migrationAttemptId?: string; forcedUpload?: boolean } = {},
): string {
  const nowMs = Date.now();
  const isoStart = new Date(nowMs).toISOString();
  const traceId = randomUUID().replace(/-/g, "");
  const spanId = randomUUID().replace(/-/g, "").slice(0, 16);
  const record = {
    type: "span",
    schema_version: 1,
    trace_id: traceId,
    span_id: spanId,
    parent_span_id: undefined,
    name: "diagnostics.push",
    surface,
    kind: "internal",
    status: "ok",
    start_time: isoStart,
    end_time: isoStart,
    duration_ms: 0,
    attrs: {
      // The contract IDs whitelist — `correlationId` is the only payload
      // attribute and is explicitly OK to retain raw in `DIAGNOSTIC_ID_ATTRS`-
      // style filtering (it IS a diagnostic correlation id, no PII).
      diagnostics_correlation_id: correlationId,
      diagnostics_window_sec_bucket: EXPECTED_WINDOW_SEC,
      diagnostics_trigger: opts.trigger ?? "user_action",
      ...(opts.migrationAttemptId ? { migration_attempt_id: opts.migrationAttemptId } : {}),
      ...(opts.forcedUpload ? { diagnostics_upload_forced: true } : {}),
    },
    events: [],
  };
  return `${JSON.stringify(record)}\n`;
}

async function writeMarker(
  traceDir: string,
  fileName: string,
  correlationId: string,
  surface: "computer" | "daemon",
  opts: {
    trigger?: "user_action" | "migration";
    migrationAttemptId?: string;
    forcedUpload?: boolean;
    extraLines?: string[];
  } = {},
): Promise<string> {
  await mkdir(traceDir, { recursive: true, mode: 0o700 });
  const file = path.join(traceDir, fileName);
  await writeFile(file, buildMarkerLine(correlationId, surface, opts) + (opts.extraLines ?? []).join(""), { mode: 0o600 });
  return file;
}

async function readComputerTraceRecords(slockHome: string): Promise<string[]> {
  const traceDir = path.join(computerDir(slockHome), "traces");
  let names: string[];
  try {
    names = await readdir(traceDir);
  } catch {
    return [];
  }
  const lines: string[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".jsonl")).sort()) {
    if (name.startsWith(COMPUTER_BREADCRUMB_PREFIX)) continue;
    try {
      const file = path.join(traceDir, name);
      const info = await stat(file);
      if (!info.isFile() || info.size <= 0) continue;
      for (const line of (await readFile(file, "utf8")).split(/\n/)) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line) as { type?: unknown };
        if (parsed.type === "span") lines.push(`${line}\n`);
      }
    } catch {
      // Skip malformed local records; diagnostics must not fail setup.
    }
  }
  return lines;
}

const SECRET_PATTERNS: RegExp[] = [
  /sk_[a-z]+_[A-Za-z0-9._-]+/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:sk|sk-ant|sk-proj|xox[baprs]?)-[A-Za-z0-9_-]{8,}\b/g,
  /\beyJ[A-Za-z0-9._-]{20,}/g,
  /\b[A-Fa-f0-9]{40,}\b/g,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /\/Users\/[^\s"'<>:]+(?:\/[^\s"'<>:]+)*/g,
  /\/home\/[^\s"'<>:]+(?:\/[^\s"'<>:]+)*/g,
  /[A-Za-z]:\\Users\\[^\s"'<>:]+(?:\\[^\s"'<>:]+)*/g,
];

function redactUrlQuery(value: string): string {
  try {
    const url = new URL(value);
    if (url.search) url.search = "?[REDACTED_QUERY]";
    if (url.username) url.username = "[REDACTED_USER]";
    if (url.password) url.password = "[REDACTED_PASSWORD]";
    return url.toString();
  } catch {
    return value.replace(/\?.*$/, "?[REDACTED_QUERY]");
  }
}

function redactDiagnosticText(text: string): string {
  let out = text.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => redactUrlQuery(url));
  for (const re of SECRET_PATTERNS) out = out.replace(re, "***REDACTED***");
  return out;
}

interface RedactedTail {
  lines: string[];
  sourceLineCount: number;
  truncated: boolean;
  lineTruncatedCount: number;
  maxLines: number;
  maxLineChars: number;
}

function boundDiagnosticLine(line: string, maxChars: number): { text: string; truncated: boolean } {
  if (line.length <= maxChars) return { text: line, truncated: false };
  return { text: `${line.slice(0, maxChars)}...[truncated]`, truncated: true };
}

function redactedTailFromText(text: string, maxLines = RUNNER_LOG_TAIL_MAX_LINES, maxLineChars = RUNNER_LOG_TAIL_MAX_LINE_CHARS): RedactedTail {
  const allLines = text.split(/\r?\n/).filter(Boolean);
  const tailLines = allLines.slice(-maxLines);
  let lineTruncatedCount = 0;
  const lines = tailLines.map((line) => {
    const bounded = boundDiagnosticLine(redactDiagnosticText(line), maxLineChars);
    if (bounded.truncated) lineTruncatedCount += 1;
    return bounded.text;
  });
  return {
    lines,
    sourceLineCount: allLines.length,
    truncated: allLines.length > maxLines,
    lineTruncatedCount,
    maxLines,
    maxLineChars,
  };
}

async function readRedactedTailInfo(file: string, maxLines = RUNNER_LOG_TAIL_MAX_LINES): Promise<RedactedTail | null> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size <= 0) return redactedTailFromText("", maxLines);
    const raw = await readFile(file, "utf8");
    return redactedTailFromText(raw, maxLines);
  } catch {
    return null;
  }
}

async function readRedactedTail(file: string, maxLines = RUNNER_LOG_TAIL_MAX_LINES): Promise<string[] | null> {
  return (await readRedactedTailInfo(file, maxLines))?.lines ?? null;
}

function runnerLogPathKind(logPath: string): "runner.log" | "server-runner.log" | "unknown" {
  const name = path.basename(logPath);
  if (name === "runner.log" || name === "server-runner.log") return name;
  return "unknown";
}

function buildRunnerLogTailLine(input: {
  correlationId: string;
  attachment: ServerAttachmentLite;
  logPath: string;
  tail: RedactedTail | null;
  trigger?: "user_action" | "migration";
  migrationAttemptId?: string;
  forcedUpload?: boolean;
  nowIso?: string;
}): string {
  const isoStart = input.nowIso ?? currentDate().toISOString();
  const traceId = randomUUID().replace(/-/g, "");
  const spanId = randomUUID().replace(/-/g, "").slice(0, 16);
  const tail = input.tail;
  const record = {
    type: "span",
    schema_version: 1,
    trace_id: traceId,
    span_id: spanId,
    parent_span_id: undefined,
    name: "diagnostics.runner_log_tail",
    surface: "computer",
    kind: "internal",
    status: tail ? "ok" : "error",
    start_time: isoStart,
    end_time: isoStart,
    duration_ms: 0,
    attrs: {
      diagnostics_correlation_id: input.correlationId,
      diagnostics_trigger: input.trigger ?? "user_action",
      diagnostics_consent_surface: "diagnostics_push",
      ...(input.migrationAttemptId ? { migration_attempt_id: input.migrationAttemptId } : {}),
      ...(input.forcedUpload ? { diagnostics_upload_forced: true } : {}),
      server_id: input.attachment.serverId,
      log_path_kind: runnerLogPathKind(input.logPath),
      read_status: tail ? "ok" : "unreadable",
      lines_count: tail?.lines.length ?? 0,
      source_line_count: tail?.sourceLineCount ?? 0,
      max_lines: tail?.maxLines ?? RUNNER_LOG_TAIL_MAX_LINES,
      max_line_chars: tail?.maxLineChars ?? RUNNER_LOG_TAIL_MAX_LINE_CHARS,
      tail_truncated: tail?.truncated ?? false,
      line_truncated_count: tail?.lineTruncatedCount ?? 0,
    },
    events: (tail?.lines ?? []).map((text, index) => ({
      name: "runner.log.line",
      time: isoStart,
      attrs: {
        line_index: index,
        text,
      },
    })),
  };
  return `${JSON.stringify(record)}\n`;
}

async function buildRunnerLogTailLines(input: {
  slockHome: string;
  runningRunners: ServerAttachmentLite[];
  correlationId: string;
  trigger?: "user_action" | "migration";
  migrationAttemptId?: string;
  forcedUpload?: boolean;
  nowIso?: string;
}): Promise<string[]> {
  const lines: string[] = [];
  for (const attachment of input.runningRunners) {
    const logPaths = serverRunnerLogReadFallback(input.slockHome, attachment.serverId);
    for (const logPath of logPaths) {
      const tail = await readRedactedTailInfo(logPath);
      if (!tail || tail.lines.length === 0) continue;
      lines.push(buildRunnerLogTailLine({
        correlationId: input.correlationId,
        attachment,
        logPath,
        tail,
        trigger: input.trigger,
        migrationAttemptId: input.migrationAttemptId,
        forcedUpload: input.forcedUpload,
        nowIso: input.nowIso,
      }));
      break;
    }
  }
  return lines;
}

async function writeLocalDiagnosticsBundle(input: {
  slockHome: string;
  reason: DiagnosticsPushFailReason;
}): Promise<DiagnosticsLocalBundleResult | undefined> {
  const bundleId = randomUUID();
  const outDir = path.join(computerDir(input.slockHome), "diagnostics");
  const outPath = path.join(outDir, `local-diagnostics-${bundleId}.json`);

  let status: unknown;
  try {
    status = await buildStatusReport(input.slockHome);
  } catch (err) {
    status = {
      error: err instanceof Error ? err.name : "Error",
      message: redactDiagnosticText(err instanceof Error ? err.message : String(err)),
    };
  }

  const serviceLog = await readRedactedTail(serviceLogPath(input.slockHome));
  const runners: Array<{ serverId: string; logs: Array<{ path: string; lines: string[] | null }> }> = [];
  const attachments = await listAttachmentApiKeys(input.slockHome).catch(() => [] as ServerAttachmentLite[]);
  for (const attachment of attachments) {
    runners.push({
      serverId: attachment.serverId,
      logs: await Promise.all(
        serverRunnerLogReadFallback(input.slockHome, attachment.serverId).map(async (logPath) => ({
          path: logPath,
          lines: await readRedactedTail(logPath),
        })),
      ),
    });
  }

  const payload = {
    schemaVersion: 1,
    kind: "raft-computer-local-diagnostics",
    createdAt: new Date().toISOString(),
    bundleId,
    reason: input.reason,
    status,
    logs: {
      service: { path: serviceLogPath(input.slockHome), lines: serviceLog },
      runners,
    },
  };

  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  await writeFile(outPath, serialized, { mode: 0o600 });
  return { bundleId, path: outPath, sizeBytes: Buffer.byteLength(serialized) };
}

function joinUrl(base: string, pathname: string): string {
  return `${base.replace(/\/+$/, "")}${pathname}`;
}

async function postJson<T>(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<T> {
  const response = await fetchImpl(url, init);
  const text = await response.text();
  const data = text ? JSON.parse(text) as T : {} as T;
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  return data;
}

async function forceUploadTraceFile(input: {
  file: string;
  attachment: ServerAttachmentLite;
  workerUrl: string;
  fetchImpl: FetchLike;
}): Promise<DiagnosticsForcedUploadResult> {
  try {
    const raw = await readFile(input.file);
    if (raw.byteLength === 0) {
      return { serverId: input.attachment.serverId, status: "no_candidates", attempted: 1, uploaded: 0 };
    }
    const gzipped = gzipSync(raw);
    const bundleSha256 = createHash("sha256").update(gzipped).digest("hex");
    const bundleId = randomUUID();
    const capability = await postJson<{ attestation: string }>(
      input.fetchImpl,
      joinUrl(input.attachment.serverUrl, "/internal/machine/scope-attestation"),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${input.attachment.apiKey}`,
        },
        body: JSON.stringify({
          scope: TRACE_UPLOAD_SCOPE,
          metadata: {
            bundleId,
            bundleSha256,
            bundleSizeBytes: gzipped.byteLength,
            ...(process.env.SLOCK_DAEMON_DEPLOYMENT_ENV
              ? { deploymentEnvironment: process.env.SLOCK_DAEMON_DEPLOYMENT_ENV }
              : {}),
          },
        }),
      },
    );
    const session = await postJson<{ upload: { method: string; url: string; headers?: Record<string, string> } }>(
      input.fetchImpl,
      joinUrl(input.workerUrl, "/api/trace-bundles"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bundleSha256,
          bundleSizeBytes: gzipped.byteLength,
          attestation: capability.attestation,
        }),
      },
    );
    const uploadResponse = await input.fetchImpl(session.upload.url, {
      method: session.upload.method,
      headers: session.upload.headers ?? {},
      body: new Blob([new Uint8Array(gzipped)], { type: "application/x-ndjson" }),
    });
    if (!uploadResponse.ok) throw new Error(`HTTP_${uploadResponse.status}`);
    const stateDir = path.join(path.dirname(path.dirname(input.file)), "trace-uploads");
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(stateDir, `${path.basename(input.file)}.uploaded.json`),
      `${JSON.stringify({
        file: path.basename(input.file),
        uploadedAt: new Date().toISOString(),
        bundleId,
        bundleSha256,
        bundleSizeBytes: gzipped.byteLength,
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    return {
      serverId: input.attachment.serverId,
      status: "uploaded",
      attempted: 1,
      uploaded: 1,
      bundleSizeBytes: gzipped.byteLength,
    };
  } catch (err) {
    return {
      serverId: input.attachment.serverId,
      status: "failed",
      attempted: 1,
      uploaded: 0,
      errorClass: err instanceof Error ? err.name : "Error",
    };
  }
}

/** A running runner = an attached server whose per-server runner pidfile points
 *  at a live process. Only a running runner has a live `DaemonTraceBundleUploader`
 *  (+ the server credential) to actually upload the marker, so this is the set
 *  the upload path depends on. (task #102.) */
async function listRunningRunners(
  slockHome: string,
  attachments: ServerAttachmentLite[],
): Promise<ServerAttachmentLite[]> {
  const running: ServerAttachmentLite[] = [];
  for (const a of attachments) {
    for (const pidfile of serverRunnerPidReadFallback(slockHome, a.serverId)) {
      try {
        const pid = await readPidfileAt(pidfile);
        if (pid !== null && isProcessAlive(pid)) {
          running.push(a);
          break;
        }
      } catch {
        // Unreadable pidfile → treat that candidate as not-running.
      }
    }
  }
  return running;
}

export async function diagnosticsPush(
  input: DiagnosticsPushInput,
  options: DiagnosticsPushOptions = {},
): Promise<DiagnosticsPushResult> {
  options.signal?.throwIfAborted?.();
  const { slockHome } = input;

  // --- UPLOAD_DISABLED gate: same env switch the Computer tracer honors.
  // If the tracer is disabled, the menu-bar's altKey-revealed action has
  // nothing to attach to anyway. Honest closed-reason instead of writing
  // a marker that will sit on disk forever.
  if (process.env.RAFT_COMPUTER_LOCAL_TRACE === "0") {
    return { status: "failed", reason: "UPLOAD_DISABLED" };
  }

  // --- OFFLINE gate: no user-session AND no attachments — there's no
  // identity to upload under and no daemon-side uploader to pick up the
  // marker. (We allow "user-session exists but no attachments" — the
  // Computer-level tracer's spans still get uploaded once attach + start
  // run, and the marker is durable on disk.)
  let hasIdentity = false;
  try {
    const raw = await readFile(userSessionPath(slockHome), "utf8");
    const parsed = JSON.parse(raw) as { kind?: unknown; accessToken?: unknown };
    if (parsed.kind === "user-session" && typeof parsed.accessToken === "string" && parsed.accessToken.length > 0) {
      hasIdentity = true;
    }
  } catch {
    // No session → fall through to attachment check.
  }
  const attachments = await listAttachmentApiKeys(slockHome);
  if (!hasIdentity && attachments.length === 0) {
    return { status: "failed", reason: "OFFLINE" };
  }

  // --- NO_RUNNER gate (the upload-path gate, task #102): the marker can only
  // reach the worker through a RUNNING runner's `DaemonTraceBundleUploader`
  // (the only layer with an uploader + server credential). With zero running
  // runners there is no upload path, so fail-closed rather than return a
  // `queued` correlationId that could never be looked up.
  const runningRunners = await listRunningRunners(slockHome, attachments);
  if (runningRunners.length === 0) {
    const localBundle = await writeLocalDiagnosticsBundle({ slockHome, reason: "NO_RUNNER" }).catch(() => undefined);
    return { status: "failed", reason: "NO_RUNNER", ...(localBundle ? { localBundle } : {}) };
  }

  const correlationId = options.correlationId ?? randomUUID();
  const markerPaths: string[] = [];
  const uploadResults: DiagnosticsForcedUploadResult[] = [];
  const extraLines = [
    ...(await buildRunnerLogTailLines({
      slockHome,
      runningRunners,
      correlationId,
      trigger: options.trigger,
      migrationAttemptId: options.migrationAttemptId,
      forcedUpload: options.forceUploadNow,
    })),
    ...(options.includeComputerTraceRecords ? await readComputerTraceRecords(slockHome) : []),
  ];
  const workerUrl = options.workerUrl ?? process.env.SLOCK_DAEMON_TRACE_UPLOAD_URL ?? DEFAULT_TRACE_UPLOAD_URL;

  // 1. Upload-bearing markers: one per RUNNING runner, into that runner's
  // daemon `machineDir/traces` with the `daemon-trace-` glob-matching name so
  // its uploader actually picks it up. Writing into every running runner is
  // intentional redundancy — the server/ScopeDB dedups by correlationId.
  for (const a of runningRunners) {
    try {
      const dir = path.join(daemonMachineDir(slockHome, a.apiKey), "traces");
      const fileName = `${RUNNER_MARKER_PREFIX}${correlationId}.jsonl`;
      const markerPath = await writeMarker(dir, fileName, correlationId, "daemon", {
        trigger: options.trigger,
        migrationAttemptId: options.migrationAttemptId,
        forcedUpload: options.forceUploadNow,
        extraLines,
      });
      markerPaths.push(markerPath);
      if (options.forceUploadNow) {
        uploadResults.push(await forceUploadTraceFile({
          file: markerPath,
          attachment: a,
          workerUrl,
          fetchImpl: options.fetchImpl ?? fetch,
        }));
      }
    } catch {
      // Skip the failing runner — others still carry the marker.
    }
  }

  // If every running-runner write failed, there is no upload-bearing marker on
  // disk → honest NO_TRACE_DIR rather than a queued id that won't upload.
  if (markerPaths.length === 0) {
    return { status: "failed", reason: "NO_TRACE_DIR" };
  }

  // 2. Computer-surface breadcrumb (LOCAL-ONLY — no uploader for computerDir).
  // Best-effort, NOT counted toward the upload path or the result; purely for
  // local inspection / doctor. Failure here is irrelevant to the outcome.
  try {
    const computerTraceDir = path.join(computerDir(slockHome), "traces");
    await writeMarker(
      computerTraceDir,
      `${COMPUTER_BREADCRUMB_PREFIX}${correlationId}.jsonl`,
      correlationId,
      "computer",
      {
        trigger: options.trigger,
        migrationAttemptId: options.migrationAttemptId,
        forcedUpload: options.forceUploadNow,
      },
    );
  } catch {
    // Local breadcrumb is non-essential; ignore.
  }

  // Yingjun's menu-bar branch consumes the typed `diagnosticsPush.queued`
  // step (msg=2753a3ad contract). Emit it AND a prose `log.line` fallback so
  // any non-menu-bar presenter (CLI, tests, future SDK) still gets a human
  // line without subscribing to the typed kind.
  emit(options, { kind: "diagnosticsPush.queued", correlationId });
  emit(options, {
    kind: "log.line",
    line: options.forceUploadNow
      ? `Diagnostics upload attempted on ${runningRunners.length} runner(s). Correlation id ${correlationId}.`
      : `Diagnostics queued on ${runningRunners.length} runner(s). Correlation id ${correlationId}. ` +
        `The next upload pass picks it up within ~${EXPECTED_WINDOW_SEC}s.`,
  });

  return {
    status: "queued",
    correlationId,
    expectedWindowSec: EXPECTED_WINDOW_SEC,
    markerPaths,
    ...(options.forceUploadNow ? { uploadResults } : {}),
  };
}
