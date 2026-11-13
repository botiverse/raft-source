// Remote upgrade step log. A web upgrade crosses a service restart, so the
// process that saw a step is often not the one that can report it: each step is
// appended under the request id here, and whichever runner of the origin server
// is connected next sends it (daemon `daemon.computer_upgrade.step`) and acks it.
// Steps the Computer cannot see itself (installer outcome, a stalled installer)
// are derived from the installer's receipt and plan. Best-effort throughout: a
// failure here must never change the upgrade itself.
//
// Each step is sent once per request, the first time it is seen. In a rollback
// the second `service_started` (the old version coming back) is therefore not
// sent; `rolled_back` is what says the old service was restored, so a missing
// second start does not mean the service never came back. Three exceptions: a
// service stop/start after the receipt exists (inside the request's deadline)
// is sent once per step, version and process (`afterReceipt`), an unresolved
// receipt the installer's supervisor later rewrites is sent once more as
// `installer_receipt_updated`, and `start_command` (next paragraph).
//
// `start_command` is the installer's own `raft-computer start` (it judges a
// version by that exit code): whether it succeeded, its error code and what its
// readiness wait saw, as counts and closed-set codes in `reason` (no server
// ids, paths or stderr). The candidate's and the rollback's start are both
// sent: once per version and outcome. The counts ride in `reason` because an
// older version's runner (the one restored by a rollback) forwards that field;
// such a runner keys the step by name only, so it sends the first start alone,
// and a step this version already sent may be sent once more by it. A start the
// installer killed (45 s) leaves no step.
//
// Every receipt also yields `installer_finished` (success included) with what
// the installer left behind, read from files the deployed installers already
// write (rust/operation.rs, rust/host.rs, k-carrier state.rs): the receipt's
// installer version and outcome, the engine's own error (plan.json
// `detail.diagnostic`, which the receipt's may hide behind "upgrade still
// requires recovery"), K's operation phase/outcome/reason (k/operation.json)
// and the last start the installer made (product-state.json `lastStart`).
import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { computerDir } from "./paths";
import { REMOTE_UPGRADE_FAILURE_WATCH_MS } from "./externalInstaller";
import type { StartReadinessReport } from "./machineReadiness";

export type RemoteUpgradeStep =
  | "received"
  | "download"
  /** Reconciler step 13: the runners drained before the spawn (`phase`: quiet | deadline | ended; `reason`: who was still working). */
  | "drain"
  | "installer_spawned"
  | "service_stopped"
  | "service_started"
  | "start_command"
  | "new_version_started"
  | "rolled_back"
  | "installer_finished"
  | "installer_receipt_updated"
  | "installer_stalled"
  | "reported";

export interface RemoteUpgradeStepRecord {
  requestId: string;
  step: RemoteUpgradeStep;
  outcome: "ok" | "failed" | "skipped";
  atMs: number;
  originServerId?: string;
  fromVersion?: string;
  targetVersion?: string;
  durationMs?: number;
  errorCode?: string;
  reason?: string;
  supervisor?: string;
  killMode?: string;
  bytes?: number;
  version?: string;
  phase?: string;
  via?: string;
  /** The installer's own error behind a failed receipt (`detail.diagnostic`), bounded and redacted. */
  diagnostic?: string;
  /**
   * A candidate that would not start (rolled back): the installer's failure
   * class and exit code for that start. Its stderr stays in the installer's
   * local mode-0600 record (rust/operation.rs), never in the trace.
   */
  startFailure?: string;
  startExitCode?: number;
  /** Receipt fields, on `installer_finished` / `installer_receipt_updated` and the step the receipt maps to. */
  installerVersion?: string;
  /** The receipt's own outcome, snake_case (`promoted`, `repaired`, `rolled_back`, `unresolved`, …). */
  receiptOutcome?: string;
  /** The installer's engine error from plan.json `detail.diagnostic`, bounded and redacted. */
  engineDiagnostic?: string;
  /** K's operation record for this request (k/operation.json): phase, outcome, reason (redacted). */
  enginePhase?: string;
  engineOutcome?: string;
  engineReason?: string;
  /** The installer's last start for this request (product-state.json `lastStart`): `candidate` or `previous`. */
  lastStartSlot?: string;
  lastStartVersion?: string;
  lastStartSucceeded?: boolean;
  /** That start's failure class and exit code (its diagnostics file); stderr stays local. */
  lastStartFailure?: string;
  lastStartExitCode?: number;
  /** A service stop/start recorded after the receipt existed. */
  afterReceipt?: boolean;
  /** The service process of an `afterReceipt` transition (dedupe only; not sent). */
  pid?: number;
}

export interface RemoteUpgradeStepTrace extends RemoteUpgradeStepRecord {
  deliveredLateMs: number;
  afterDeadline: boolean;
}

const MAX_LOG_BYTES = 64 * 1024;
/** Logs no runner ever delivered (origin server detached, …) are dropped after this. */
const MAX_LOG_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const TERMINAL_STEPS: ReadonlySet<RemoteUpgradeStep> = new Set(["new_version_started", "rolled_back", "installer_finished", "installer_receipt_updated", "installer_stalled"]);
const MAX_RECORD_BYTES = 65_536;

const traceDir = (slockHome: string) => join(computerDir(slockHome), "installer", "upgrade-trace");
const requestKey = (requestId: string) => createHash("sha256").update(requestId).digest("hex");

/**
 * One-line, bounded, control-free text for a span attribute, with the account
 * segment of home paths masked (the server's traceSafeUpgradeReason does the same).
 */
export function traceSafeText(value: string, max = 200): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    // The user name only: stop at the next separator or punctuation.
    .replace(/(\/Users\/|\/home\/)[^/\s"'`;,)]+/giu, "$1~")
    .replace(/([A-Za-z]:\\Users\\)[^\\\s"'`;,)]+/giu, "$1~")
    .trim()
    .slice(0, max);
}

const DIAGNOSTIC_REDACT_INPUT_MAX = 4096;

/**
 * Installer error text for a trace: traceSafeText plus no personal data or
 * secrets it could carry. Redacted over the text, then bounded, so a cut
 * never leaves a key or signature without the prefix that marks it. The
 * input is first cut to DIAGNOSTIC_REDACT_INPUT_MAX: the redaction's
 * patterns grow with the square of a long unbroken token, and a plan.json
 * diagnostic may be up to the file's 1 MB (seconds to minutes of a blocked
 * event loop otherwise). Only the first `max` characters are ever sent.
 */
export function traceSafeDiagnostic(value: string, max = 300): string {
  return traceSafeText(
    value
      .slice(0, DIAGNOSTIC_REDACT_INPUT_MAX)
      // Any Windows user dir: C:\Users\x, C:/Users/x, JSON-escaped C:\\Users\\x.
      .replace(/([A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/))[^\\/\s"'`;,)]+/giu, "$1~")
      // URL credentials and query strings (a presigned URL's signature).
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@"']+@/giu, "$1…@")
      .replace(/(https?:\/\/[^\s?#"')]+)[?#][^\s"'),;]*/giu, "$1?…")
      .replace(/\b(bearer|basic)(\s+)[^\s"'),;]+/giu, "$1$2…")
      .replace(/\b([a-z_-]*(?:token|secret|passw(?:or)?d|api[_-]?key|sig(?:nature)?|credential)[a-z_-]*)(\s*[=:]\s*)[^\s&"'),;]+/giu, "$1$2…")
      .replace(/\b(sk|rk|ak)_[A-Za-z0-9_-]{8,}/gu, "$1_…")
      .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_.-]+)/gu, "…")
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/gu, "…@…"),
    max,
  );
}

/** First token of an internal error message (`installer_download_failed: HTTP 404` → `installer_download_failed`). */
export function upgradeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = /^[A-Za-z][A-Za-z0-9_]*/.exec(message.trim())?.[0];
  return code ? code.slice(0, 64) : "unknown";
}

export async function appendRemoteUpgradeStep(slockHome: string, record: RemoteUpgradeStepRecord): Promise<void> {
  try {
    const dir = traceDir(slockHome);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const clean = { ...record, ...(record.reason ? { reason: traceSafeText(record.reason) } : {}) };
    await appendFile(join(dir, `${requestKey(record.requestId)}.jsonl`), `${JSON.stringify(clean)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Telemetry only.
  }
}

/** The request the last web upgrade launched, if it is still inside the server's deadline. */
async function readLaunchMarker(slockHome: string): Promise<{ requestId: string; launchedAtMs: number; targetVersion?: string; originServerId?: string; drainMs?: number } | null> {
  try {
    const marker = JSON.parse(await readFile(join(computerDir(slockHome), "installer", "last-remote-upgrade.json"), "utf8"));
    if (typeof marker?.requestId !== "string") return null;
    const launchedAtMs = Date.parse(marker.launchedAt);
    if (!Number.isFinite(launchedAtMs)) return null;
    return {
      requestId: marker.requestId,
      launchedAtMs,
      ...(typeof marker.targetVersion === "string" ? { targetVersion: marker.targetVersion } : {}),
      ...(typeof marker.originServerId === "string" ? { originServerId: marker.originServerId } : {}),
      ...(typeof marker.drainMs === "number" && Number.isFinite(marker.drainMs) && marker.drainMs > 0 ? { drainMs: marker.drainMs } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Called on service start and stop: while a web upgrade launched in the last
 * deadline window has no receipt yet, the service going down or coming up is a
 * step of that upgrade (the installer stopping it, or starting the new or the
 * restored version). Once the receipt exists (a supervisor retry or recovery
 * restarting a version) it is still recorded, marked `afterReceipt`, and sent
 * once per step, version and process.
 */
export async function noteServiceTransitionForRemoteUpgrade(slockHome: string, step: "service_stopped" | "service_started", version: string, nowMs = Date.now(), pid = process.pid): Promise<void> {
  const marker = await readLaunchMarker(slockHome);
  if (!marker || nowMs - marker.launchedAtMs > REMOTE_UPGRADE_FAILURE_WATCH_MS + (marker.drainMs ?? 0)) return;
  const receipt = await readRawReceipt(slockHome, marker.requestId);
  // Computer refused the launch: no installer runs, so a restart is not part of it.
  if (receipt?.refusedByComputer) return;
  // The request has its result and another installer operation now owns the
  // product (a local `raft-computer upgrade` or an app update): this restart
  // is that operation's, not a late step of the request. Both records are
  // written before the installer stops or starts the service (rust/host.rs
  // prepare, k-carrier state.rs).
  if (receipt && await anotherInstallerOperationOwnsProduct(slockHome, marker.requestId)) return;
  await appendRemoteUpgradeStep(slockHome, {
    requestId: marker.requestId,
    step,
    outcome: "ok",
    atMs: nowMs,
    durationMs: nowMs - marker.launchedAtMs,
    version,
    ...(marker.targetVersion ? { targetVersion: marker.targetVersion } : {}),
    ...(marker.originServerId ? { originServerId: marker.originServerId } : {}),
    ...(receipt ? { afterReceipt: true, pid } : {}),
  });
}

/** What `raft-computer start` reports of itself when the installer runs it. */
export interface StartCommandNote {
  version: string;
  outcome: "ok" | "failed" | "skipped";
  /** The start's error code (`START_DAEMON_TIMEOUT`, …), from the closed set of Computer error codes. */
  errorCode?: string;
  /** Absent when the start ended before its readiness wait. */
  readiness?: StartReadinessReport | null;
}

/** `targets=3 ready=1 not_ready=runner-absent:2 partial=false unlinked=0 waited_ms=30012`: numbers and reason codes only. */
export function startReadinessSummary(readiness: StartReadinessReport): string {
  const count = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0);
  const notReady = Object.entries(readiness.notReady)
    .filter((entry): entry is [string, number] => /^[a-z-]{1,40}$/u.test(entry[0]) && typeof entry[1] === "number" && entry[1] > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, runners]) => `${code}:${count(runners)}`)
    .join(",");
  return [
    `targets=${count(readiness.targets)}`,
    `ready=${count(readiness.ready)}`,
    `not_ready=${notReady || "none"}`,
    `partial=${readiness.partial === true}`,
    `unlinked=${count(readiness.unlinked)}`,
    `waited_ms=${count(readiness.waitedMs)}`,
  ].join(" ");
}

/**
 * Called by `raft-computer start` when the external installer runs it
 * (`RAFT_COMPUTER_INSTALLER_LIFECYCLE=1`): while a web upgrade launched in the
 * last deadline window is this machine's last, that start is the installer
 * starting the new or the restored version, and its exit code is what the
 * installer promotes or rolls back on. After the receipt exists (a supervisor
 * retry) it is marked `afterReceipt`. Another installer operation's start (a
 * local `raft-computer upgrade`, an app update) is not this request's: the
 * installer writes its product record before it starts the service.
 */
export async function noteStartCommandForRemoteUpgrade(slockHome: string, start: StartCommandNote, nowMs = Date.now()): Promise<void> {
  try {
    const marker = await readLaunchMarker(slockHome);
    if (!marker || nowMs - marker.launchedAtMs > REMOTE_UPGRADE_FAILURE_WATCH_MS + (marker.drainMs ?? 0)) return;
    const receipt = await readRawReceipt(slockHome, marker.requestId);
    if (receipt?.refusedByComputer) return;
    if (await anotherInstallerOperationOwnsProduct(slockHome, marker.requestId)) return;
    await appendRemoteUpgradeStep(slockHome, {
      requestId: marker.requestId,
      step: "start_command",
      outcome: start.outcome,
      atMs: nowMs,
      durationMs: nowMs - marker.launchedAtMs,
      version: traceSafeText(start.version, 64),
      // A Computer error code is an identifier; anything else is not sent.
      ...(start.errorCode ? { errorCode: /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(start.errorCode) ? start.errorCode : "unknown" } : {}),
      ...(start.readiness ? { reason: startReadinessSummary(start.readiness) } : {}),
      ...(marker.targetVersion ? { targetVersion: marker.targetVersion } : {}),
      ...(marker.originServerId ? { originServerId: marker.originServerId } : {}),
      ...(receipt ? { afterReceipt: true } : {}),
    });
  } catch {
    // Telemetry only.
  }
}

interface RawReceipt {
  outcome: string;
  installerVersion?: string;
  exitCode?: number;
  code?: string;
  reason?: string;
  finishedAtMs?: number;
  fromVersion?: string;
  targetVersion?: string;
  /** rust/operation.rs plan detail: "service" when the installer read the running service back. */
  readback?: string;
  refusedByComputer: boolean;
  diagnostic?: string;
  startFailureRef?: string;
}

async function readRawReceipt(slockHome: string, requestId: string): Promise<RawReceipt | null> {
  try {
    const raw = await readFile(join(computerDir(slockHome), "installer", "receipts", `${requestKey(requestId)}.json`), "utf8");
    if (raw.length > 65_536) return null;
    const receipt = JSON.parse(raw);
    if (receipt?.protocol !== "raft-computer-installer/v3" || receipt.id !== requestId || receipt.operation !== "upgrade") return null;
    return {
      outcome: typeof receipt.outcome === "string" ? receipt.outcome : "unknown",
      ...(typeof receipt.installerVersion === "string" ? { installerVersion: receipt.installerVersion } : {}),
      ...(typeof receipt.exitCode === "number" ? { exitCode: receipt.exitCode } : {}),
      ...(typeof receipt.code === "string" ? { code: receipt.code } : {}),
      ...(typeof receipt.reason === "string" ? { reason: receipt.reason } : {}),
      ...(typeof receipt.finishedAtMs === "number" ? { finishedAtMs: receipt.finishedAtMs } : {}),
      ...(typeof receipt.fromVersion === "string" ? { fromVersion: receipt.fromVersion } : {}),
      ...(typeof receipt.targetVersion === "string" ? { targetVersion: receipt.targetVersion } : {}),
      ...(typeof receipt.detail?.readback === "string" ? { readback: receipt.detail.readback } : {}),
      refusedByComputer: receipt.detail?.refusedBy === "raft-computer",
      ...(typeof receipt.detail?.diagnostic === "string" ? { diagnostic: receipt.detail.diagnostic } : {}),
      ...(typeof receipt.detail?.startFailureDiagnostic === "string" ? { startFailureRef: receipt.detail.startFailureDiagnostic } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The installer's record of a candidate start that failed (rust/host.rs
 * StartDiagnostic), named by the receipt's opaque `diagnostics/<uuid>.json`
 * reference: the failure class and the exit code (its stderr stays local).
 */
async function readStartFailure(slockHome: string, ref: string): Promise<Pick<RemoteUpgradeStepRecord, "startFailure" | "startExitCode"> | null> {
  if (!/^diagnostics\/[0-9a-f-]{36}\.json$/iu.test(ref)) return null;
  try {
    const raw = await readFile(join(computerDir(slockHome), "installer", ref), "utf8");
    if (raw.length > 65_536) return null;
    const record = JSON.parse(raw);
    const failure = typeof record?.failure === "string" ? traceSafeText(record.failure, 64) : "";
    return {
      ...(failure ? { startFailure: failure } : {}),
      ...(Number.isInteger(record?.exitCode) ? { startExitCode: record.exitCode } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The installer's persisted plan for a run (rust/operation.rs Plan): its phase,
 * and `detail.diagnostic`, the engine's own error. The receipt's diagnostic can
 * be the installer's later "upgrade still requires recovery" (rust/operation.rs
 * resume), written without saving the plan again, so the plan keeps the engine's
 * error. Gone once the installer cleans up a finished run.
 */
async function readInstallerPlan(slockHome: string, requestId: string): Promise<{ phase?: string; diagnostic?: string; atMs: number } | null> {
  try {
    const path = join(computerDir(slockHome), "installer", "operations", requestKey(requestId), "plan.json");
    const [raw, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    if (raw.length > 1_048_576) return null;
    const plan = JSON.parse(raw);
    const phase = typeof plan?.phase === "string" ? traceSafeText(plan.phase, 32) : "";
    const diagnostic = typeof plan?.detail?.diagnostic === "string" ? traceSafeDiagnostic(plan.detail.diagnostic) : "";
    return { ...(phase ? { phase } : {}), ...(diagnostic ? { diagnostic } : {}), atMs: Math.round(info.mtimeMs) };
  } catch {
    return null;
  }
}

/** Fields read from k-carrier's Operation and the installer's ProductState; each is checked before use. */
interface EngineOperationFile { id?: unknown; phase?: unknown; outcome?: unknown; reason?: unknown }
interface ProductStateFile { operationId?: unknown; lastStart?: { slot?: unknown; version?: unknown; succeeded?: unknown; failureDiagnostic?: unknown } | null }

async function readSmallJson<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    return raw.length > MAX_RECORD_BYTES ? null : JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** The installer's product record or K's operation names an operation other than this request. */
async function anotherInstallerOperationOwnsProduct(slockHome: string, requestId: string): Promise<boolean> {
  const [state, operation] = await Promise.all([
    readSmallJson<ProductStateFile>(join(computerDir(slockHome), "installer", "product-state.json")),
    readSmallJson<EngineOperationFile>(join(computerDir(slockHome), "k", "operation.json")),
  ]);
  return [state?.operationId, operation?.id].some((id) => typeof id === "string" && id !== requestId);
}

/** K's operation record (k-carrier state.rs Operation, `<computer>/k/operation.json`), only while it is this request's. */
async function readEngineOperation(slockHome: string, requestId: string): Promise<Pick<RemoteUpgradeStepRecord, "enginePhase" | "engineOutcome" | "engineReason">> {
  const operation = await readSmallJson<EngineOperationFile>(join(computerDir(slockHome), "k", "operation.json"));
  if (operation?.id !== requestId) return {};
  const phase = typeof operation.phase === "string" ? traceSafeText(operation.phase, 32) : "";
  const outcome = typeof operation.outcome === "string" ? traceSafeText(operation.outcome, 32) : "";
  const reason = typeof operation.reason === "string" ? traceSafeDiagnostic(operation.reason, 200) : "";
  return { ...(phase ? { enginePhase: phase } : {}), ...(outcome ? { engineOutcome: outcome } : {}), ...(reason ? { engineReason: reason } : {}) };
}

const START_SLOTS: Record<string, string> = { experiment: "candidate", stable: "previous" };

/**
 * The installer's last start for this request (rust/host.rs ProductState
 * `lastStart`, `<computer>/installer/product-state.json`): which version it
 * started, whether that worked and, when it did not, the failure class and exit
 * code of its diagnostics file (a failed start of either version is recorded).
 */
async function readLastStart(slockHome: string, requestId: string): Promise<Pick<RemoteUpgradeStepRecord, "lastStartSlot" | "lastStartVersion" | "lastStartSucceeded" | "lastStartFailure" | "lastStartExitCode">> {
  const state = await readSmallJson<ProductStateFile>(join(computerDir(slockHome), "installer", "product-state.json"));
  const start = state?.operationId === requestId ? state.lastStart : null;
  if (!start || typeof start !== "object") return {};
  const slot = typeof start.slot === "string" ? START_SLOTS[start.slot] ?? traceSafeText(start.slot, 32) : "";
  const version = typeof start.version === "string" ? traceSafeText(start.version, 64) : "";
  const failure = typeof start.failureDiagnostic === "string" ? await readStartFailure(slockHome, start.failureDiagnostic) : null;
  return {
    ...(slot ? { lastStartSlot: slot } : {}),
    ...(version ? { lastStartVersion: version } : {}),
    ...(typeof start.succeeded === "boolean" ? { lastStartSucceeded: start.succeeded } : {}),
    ...(failure?.startFailure ? { lastStartFailure: failure.startFailure } : {}),
    ...(failure?.startExitCode !== undefined ? { lastStartExitCode: failure.startExitCode } : {}),
  };
}

/** What a receipt adds to the steps derived from it. */
async function receiptDetail(slockHome: string, requestId: string, receipt: RawReceipt, plan: { diagnostic?: string } | null): Promise<Partial<RemoteUpgradeStepRecord>> {
  return {
    ...(receipt.installerVersion ? { installerVersion: traceSafeText(receipt.installerVersion, 64) } : {}),
    receiptOutcome: receiptOutcome(receipt),
    ...(plan?.diagnostic ? { engineDiagnostic: plan.diagnostic } : {}),
    ...await readEngineOperation(slockHome, requestId),
    ...await readLastStart(slockHome, requestId),
  };
}

const receiptOutcome = (receipt: RawReceipt) => traceSafeText(receipt.outcome, 32).replace(/-/gu, "_");

/**
 * Steps are sent once; a service transition after the receipt once per step,
 * version and process; the installer's `start` once per version and outcome
 * (the candidate's and the rollback's are different versions).
 */
const deliveryKey = (record: RemoteUpgradeStepRecord) => {
  if (record.step === "start_command") return `${record.step}:${record.version ?? ""}:${record.outcome}`;
  return record.afterReceipt ? `${record.step}:${record.version ?? ""}:${record.pid ?? ""}` : record.step;
};
/** Marks, in the delivered list, which receipt outcome `installer_finished` carried. */
const RECEIPT_KEY = "receipt:";

function receiptStep(receipt: RawReceipt): Pick<RemoteUpgradeStepRecord, "step" | "outcome" | "errorCode"> {
  switch (receipt.outcome) {
    case "promoted": return { step: "new_version_started", outcome: "ok" };
    // Upgraded over a damaged installation (exit 0): the target runs; the code says it was repaired.
    case "repaired":
      if (receipt.exitCode === 0) return { step: "new_version_started", outcome: "ok", errorCode: "repaired" };
      return { step: "installer_finished", outcome: "failed", errorCode: receipt.code ?? receipt.outcome };
    // Installed fresh because no managed installation was found (exit 0), and
    // the running service was read back at the target: the target runs.
    case "installed":
      if (receipt.exitCode === 0 && receipt.readback === "service") return { step: "new_version_started", outcome: "ok", errorCode: "installed" };
      return { step: "installer_finished", outcome: "failed", errorCode: receipt.code ?? receipt.outcome };
    case "up-to-date": return { step: "new_version_started", outcome: "skipped" };
    case "rolled-back":
    case "rolled_back": return { step: "rolled_back", outcome: "failed", errorCode: receipt.code ?? "rolled_back" };
    default: return { step: "installer_finished", outcome: "failed", errorCode: receipt.code ?? receipt.outcome };
  }
}

function parseLog(raw: string): RemoteUpgradeStepRecord[] {
  const records: RemoteUpgradeStepRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (typeof record?.requestId === "string" && typeof record.step === "string" && typeof record.atMs === "number") records.push(record);
    } catch {
      // A torn last line from a crash mid-append.
    }
  }
  return records;
}

/**
 * Everything not yet delivered for requests this server started, oldest first,
 * plus the ack that marks them delivered. One event per request and step: a
 * step seen twice (a second restart) is sent once. `relayedInReady` means the
 * caller has just sent a `ready` carrying the last upgrade's receipt.
 */
export async function collectRemoteUpgradeSteps(slockHome: string, options: {
  serverId: string;
  relayedInReady?: boolean;
  nowMs?: number;
}): Promise<{ events: RemoteUpgradeStepTrace[]; ack: () => Promise<void> }> {
  const nowMs = options.nowMs ?? Date.now();
  const dir = traceDir(slockHome);
  const events: RemoteUpgradeStepTrace[] = [];
  const acks: Array<() => Promise<void>> = [];
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => /^[0-9a-f]{64}\.jsonl$/.test(name));
  } catch {
    return { events, ack: async () => {} };
  }
  const marker = await readLaunchMarker(slockHome);
  for (const name of names) {
    const logPath = join(dir, name);
    const deliveredPath = join(dir, name.replace(/\.jsonl$/, ".delivered"));
    let records: RemoteUpgradeStepRecord[];
    let delivered: Set<string>;
    try {
      const raw = await readFile(logPath, "utf8");
      if (raw.length > MAX_LOG_BYTES) {
        // Never sent, so never acknowledged: removed, or it would stay for good.
        acks.push(async () => { await rm(logPath, { force: true }); await rm(deliveredPath, { force: true }); });
        continue;
      }
      records = parseLog(raw);
      delivered = new Set((await readFile(deliveredPath, "utf8").catch(() => "")).split("\n").filter(Boolean));
    } catch {
      continue;
    }
    const first = records[0];
    if (!first) continue;
    if (nowMs - first.atMs > MAX_LOG_AGE_MS) {
      acks.push(async () => { await rm(logPath, { force: true }); await rm(deliveredPath, { force: true }); });
      continue;
    }
    // Another server's runner reports its own request.
    const origin = records.find((record) => record.originServerId)?.originServerId;
    if (origin && origin !== options.serverId) continue;
    const { requestId, fromVersion, targetVersion } = first;
    const startedAtMs = (records.find((record) => record.step === "received") ?? first).atMs;
    // The server's deadline for this request: a web upgrade that waits for
    // its agents first (reconciler step 13) gets the drain on top.
    const deadlineMs = REMOTE_UPGRADE_FAILURE_WATCH_MS + (marker?.requestId === requestId ? marker.drainMs ?? 0 : 0);
    // Only service transitions after the receipt, logged once this request's
    // log was already finished and removed: the receipt was sent with it.
    const continuation = records.every((record) => record.afterReceipt);
    const derived: RemoteUpgradeStepRecord[] = [];
    const receipt = continuation ? null : await readRawReceipt(slockHome, requestId);
    const outcome = receipt && !receipt.refusedByComputer ? receiptOutcome(receipt) : undefined;
    if (receipt && !receipt.refusedByComputer) {
      const step = receiptStep(receipt);
      // A failed receipt's reason is product copy ("Raft Computer 1.0.47 is
      // running."); the phase the installer reached says where it failed.
      const failed = step.outcome === "failed";
      const plan = await readInstallerPlan(slockHome, requestId);
      const startFailure = failed && receipt.startFailureRef ? await readStartFailure(slockHome, receipt.startFailureRef) : null;
      const fromReceipt: RemoteUpgradeStepRecord = {
        requestId,
        ...step,
        atMs: receipt.finishedAtMs ?? nowMs,
        durationMs: Math.max(0, (receipt.finishedAtMs ?? nowMs) - startedAtMs),
        ...(receipt.reason ? { reason: traceSafeText(receipt.reason) } : {}),
        ...(failed && plan?.phase ? { phase: plan.phase } : {}),
        // The reason is product copy; the installer's own error says what failed.
        ...(failed && receipt.diagnostic ? { diagnostic: traceSafeDiagnostic(receipt.diagnostic) } : {}),
        ...startFailure,
        ...await receiptDetail(slockHome, requestId, receipt, plan),
      };
      derived.push(fromReceipt);
      // Every receipt, success included, is also an `installer_finished`.
      if (fromReceipt.step !== "installer_finished") derived.push({ ...fromReceipt, step: "installer_finished" });
      // A supervisor retry rewrote the receipt `installer_finished` carried.
      const sent = [...delivered].find((key) => key.startsWith(RECEIPT_KEY))?.slice(RECEIPT_KEY.length);
      if (sent !== undefined && sent !== outcome) derived.push({ ...fromReceipt, step: "installer_receipt_updated" });
      if (options.relayedInReady && marker?.requestId === requestId) {
        derived.push({ requestId, step: "reported", outcome: "ok", atMs: nowMs, via: "ready" });
      }
    } else if (!receipt && !continuation && nowMs - startedAtMs > deadlineMs
      && records.some((record) => record.step === "installer_spawned" && record.outcome === "ok")) {
      // Past the deadline with no receipt: say where the installer stopped.
      const plan = await readInstallerPlan(slockHome, requestId);
      derived.push({
        requestId,
        step: "installer_stalled",
        outcome: "failed",
        atMs: plan?.phase ? plan.atMs : nowMs,
        errorCode: plan?.phase ? "installer_no_receipt" : "installer_no_plan",
        ...(plan?.phase ? { phase: plan.phase } : {}),
      });
    }
    const pending: RemoteUpgradeStepTrace[] = [];
    const pendingKeys: string[] = [];
    for (const record of [...records, ...derived]) {
      const key = deliveryKey(record);
      if (delivered.has(key) || pendingKeys.includes(key)) continue;
      pendingKeys.push(key);
      pending.push({
        ...record,
        ...(fromVersion && !record.fromVersion ? { fromVersion } : {}),
        ...(targetVersion && !record.targetVersion ? { targetVersion } : {}),
        deliveredLateMs: Math.max(0, nowMs - record.atMs),
        afterDeadline: nowMs - startedAtMs > deadlineMs,
      });
    }
    events.push(...pending);
    if (outcome !== undefined && pendingKeys.includes("installer_finished")) pendingKeys.push(`${RECEIPT_KEY}${outcome}`);
    const done = [...delivered, ...pendingKeys];
    // An unresolved receipt may still be rewritten by the installer's
    // supervisor: the log stays (until MAX_LOG_AGE_MS) to report that once.
    const finished = (done.some((step) => TERMINAL_STEPS.has(step as RemoteUpgradeStep))
      || records.some((record) => record.step === "received" && record.outcome === "failed")
      || (continuation && nowMs - startedAtMs > deadlineMs))
      && outcome !== "unresolved";
    acks.push(async () => {
      if (finished) {
        await rm(logPath, { force: true });
        await rm(deliveredPath, { force: true });
      } else if (pendingKeys.length) {
        await appendFile(deliveredPath, pendingKeys.map((key) => `${key}\n`).join(""), { encoding: "utf8", mode: 0o600 });
      }
    });
  }
  events.sort((a, b) => a.atMs - b.atMs);
  return {
    events,
    ack: async () => {
      for (const ack of acks) await ack().catch(() => undefined);
    },
  };
}
