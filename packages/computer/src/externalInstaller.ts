// The external installer is the only thing that installs, upgrades or
// repairs Computer. Computer resolves one immutable installer, verifies its
// bytes and executes it directly. Shell/PowerShell bootstraps are only for
// users installing Computer for the first time. Installer behavior:
// https://botiverse.github.io/k-carrier/installer.html
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import type { Channel } from "./lib/channelState";
import {
  normalizeComputerUpgradeInstallerCode,
  normalizeComputerUpgradeInstallerDiagnosticCode,
  parseComputerUpgradeInstallerReport,
  withComputerUpgradeInstallerReport,
  type ComputerLastUpgradeReceipt,
} from "@botiverse/raft-shared";
import { computerDir, resolveRaftHome } from "./paths";
import { COMPUTER_VERSION } from "./version";
import { computerFetch } from "./proxy";
import { describeNetworkError } from "./networkError";

const DEFAULT_INSTALLER_BASE = "https://hands.build/dl/raft-computer-installer";
const MAX_INSTALLER_BYTES = 64 * 1024 * 1024;

/** What resolving the installer cost; filled in as it goes, so a failure still reports it. */
export interface InstallerDownloadStats {
  /** Bytes of the installer executable fetched (0 when the verified cache was reused). */
  bytes?: number;
  cached?: boolean;
  /** Set once the installer is resolved; a launch failure after this is not a download failure. */
  resolved?: boolean;
  /** The spawn failed once and succeeded on the retry; what failed first ("spawn EBADF"). */
  spawnRetriedAfter?: string;
}

export { describeNetworkError };

/** Download attempts per file; a 5xx answer is retried, other HTTP answers and size limits are not. */
export const INSTALLER_DOWNLOAD_ATTEMPTS = 3;
const defaultRetryDelay = (attempt: number) => new Promise<void>((resolve) => setTimeout(resolve, attempt * 2_000));
let retryDelay = defaultRetryDelay;
/** Tests replace the wait between attempts. */
export function setInstallerDownloadRetryDelayForTests(delay: ((attempt: number) => Promise<void>) | null): void {
  retryDelay = delay ?? defaultRetryDelay;
}

class InstallerHttpError extends Error {
  /** A 5xx (e.g. a storage hiccup behind Hands) may succeed on the next try; a 4xx or a size limit will not. */
  constructor(message: string, readonly retryable = false) {
    super(message);
  }
}

/**
 * A network-level failure (the connection, TLS, a proxy dropping it) or a 5xx
 * answer is retried with backoff; the last one names its cause. A timed-out
 * attempt is not retried: its budget already ran out.
 */
async function withNetworkRetry<T>(code: string, attempt: () => Promise<T>): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await attempt();
    } catch (error) {
      if (error instanceof InstallerHttpError) {
        if (!error.retryable) throw error;
        if (n >= INSTALLER_DOWNLOAD_ATTEMPTS) throw new InstallerHttpError(`${error.message} after ${n} attempts`);
        await retryDelay(n);
        continue;
      }
      const cause = describeNetworkError(error);
      const timedOut = /(^|\/)(TimeoutError|AbortError)(\/|$)/.test(cause);
      if (timedOut || n >= INSTALLER_DOWNLOAD_ATTEMPTS) {
        throw new Error(`${code}: ${cause}${n > 1 ? ` after ${n} attempts` : ""}`, { cause: error });
      }
      await retryDelay(n);
    }
  }
}

/** Public downloads carry no account headers and have bounded bodies/time. */
async function download(url: string, maximum: number): Promise<Buffer> {
  return withNetworkRetry("installer_download_failed", () => downloadOnce(url, maximum));
}

async function downloadOnce(url: string, maximum: number): Promise<Buffer> {
  const response = await computerFetch(url, { signal: AbortSignal.timeout(180_000), headers: { "user-agent": "raft-computer-installer-client" } });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new InstallerHttpError(`installer_download_failed: HTTP ${response.status}`, response.status >= 500);
  }
  const blocks: Buffer[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new InstallerHttpError("installer_download_too_large");
      blocks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(blocks, size);
}

/** Bootstrap arguments for one exact version, or for the saved channel. */
export function installerArgs(input: { targetVersion?: string; channel?: Channel; allowDowngrade?: boolean }): string[] {
  const downgrade = input.allowDowngrade ? ["--allow-downgrade"] : [];
  if (input.targetVersion) return ["upgrade", "--version", input.targetVersion, ...downgrade];
  const channel = input.channel ?? "latest";
  if (channel.startsWith("pinned:")) return ["upgrade", "--version", channel.slice("pinned:".length)];
  // "latest" is Computer's spelling of the installer's "main". Every other
  // saved channel (alpha, or a named feature channel from task #816) is
  // forwarded as its own slug: the installer, not this adapter, decides which
  // slugs it serves, so an unsupported channel fails loudly there instead of
  // being silently rewritten to main.
  return ["upgrade", "--channel", channel === "latest" ? "main" : channel];
}

/**
 * The installer release channel this machine fetches from
 * (`RAFT_COMPUTER_INSTALLER_CHANNEL`, operator-set; default `main`). One rule
 * for the download and for the upgrade trace that names it, so the trace can
 * never disagree with what was fetched: blank or whitespace means the default.
 */
export function installerChannel(env: NodeJS.ProcessEnv = process.env): string {
  return env.RAFT_COMPUTER_INSTALLER_CHANNEL?.trim() || "main";
}

/** Resolve once, verify, and return a direct executable invocation (never a shell). */
export async function installerCommand(args: string[], env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform, arch: string = process.arch,
  stats: InstallerDownloadStats = {}): Promise<{ command: string; args: string[] }> {
  const target = `${platform}-${arch}`;
  if (!["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"].includes(target)) {
    throw new Error("unsupported_installer_target");
  }
  const base = new URL(env.RAFT_COMPUTER_INSTALLER_DL_BASE ?? DEFAULT_INSTALLER_BASE);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
  if ((base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) || base.username || base.password || base.search || base.hash) {
    throw new Error("invalid_installer_download_base");
  }
  const channel = installerChannel(env);
  const channelUrl = `${base.href.replace(/\/$/, "")}/${encodeURIComponent(channel)}/${target}`;
  // A non-redirect answer names its status (an unexplained
  // `installer_release_unavailable` told nothing, AndyLok 685fdea3); a 5xx
  // behind Hands is retried like a download.
  const response = await withNetworkRetry("installer_release_unavailable", async () => {
    const answer = await computerFetch(channelUrl, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    await answer.body?.cancel();
    if (answer.status !== 302) throw new InstallerHttpError(`installer_release_unavailable: HTTP ${answer.status}`, answer.status >= 500);
    return answer;
  });
  const location = response.headers.get("location");
  if (!location) throw new Error("installer_release_unavailable: redirect without a location");
  const release = new URL(location, channelUrl);
  const prefix = `${base.pathname.replace(/\/$/, "")}/releases/`;
  const rest = release.pathname.slice(prefix.length);
  if (release.origin !== base.origin || !release.pathname.startsWith(prefix)
    || !new RegExp(`^[a-zA-Z0-9_-]+/${target}$`).test(rest) || release.search || release.hash || release.username || release.password) {
    throw new Error("invalid_immutable_installer_release");
  }
  const filename = `raft-computer-installer${platform === "win32" ? ".exe" : ""}`;
  const relative = `native/${target}/${filename}`;
  const sums = (await download(`${release.href}?kind=sha256sums`, 65_536)).toString("utf8");
  const matches = sums.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).filter((parts) => parts[1] === relative);
  if (matches.length !== 1 || matches[0].length !== 2 || !/^[a-fA-F0-9]{64}$/.test(matches[0][0])) throw new Error("invalid_installer_checksum");
  const expected = matches[0][0].toLowerCase();
  // Immutable content-addressed paths prevent a concurrent launch from seeing
  // another release replace its executable. Cached bytes are rechecked each time.
  const directory = join(computerDir(resolveRaftHome(env)), "installer", "bin", target, expected);
  const command = join(directory, filename);
  const valid = async () => {
    try {
      const info = await lstat(command);
      return info.isFile() && info.size <= MAX_INSTALLER_BYTES
        && createHash("sha256").update(await readFile(command)).digest("hex") === expected;
    } catch { return false; }
  };
  stats.cached = await valid();
  stats.bytes = 0;
  if (!stats.cached) {
    const bytes = await download(release.href, MAX_INSTALLER_BYTES);
    stats.bytes = bytes.byteLength;
    if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error("installer_checksum_mismatch");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(join(directory, ".download-"));
    try {
      const staged = join(temporary, filename);
      await writeFile(staged, bytes, { mode: 0o700 });
      try { await rename(staged, command); }
      catch (error) { if (!await valid()) throw error; }
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  await chmod(command, 0o700);
  stats.resolved = true;
  return { command, args: [...args] };
}

/**
 * Variables that describe one installer run: which operation it is, who asked
 * for it, whether it may prompt, and which caller is waiting. They change
 * whether the installer asks for confirmation and what its receipt records,
 * so they belong to that single run and must never outlive it. A Computer
 * started by the installer would otherwise hand them to every runner and
 * agent, and a later local `raft-computer upgrade` would reuse a finished
 * web upgrade's id and `remote:` label (#proj-raft-computer:#32).
 * Configuration such as RAFT_COMPUTER_INSTALLER_CHANNEL is not listed: it is
 * meant to persist.
 */
export const INSTALLER_OPERATION_ENV_VARS = [
  "RAFT_COMPUTER_OPERATION_ID",
  "RAFT_COMPUTER_APPROVED_BY",
  "RAFT_COMPUTER_NON_INTERACTIVE",
  "RAFT_COMPUTER_INSTALLER_CALLER",
] as const;

/** Remove the per-run installer variables in place; returns the same object. */
export function scrubInstallerOperationEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const name of INSTALLER_OPERATION_ENV_VARS) delete env[name];
  return env;
}

/** Execute directly on this terminal; installation policy belongs to the binary. */
export async function runInstallerAttended(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  options: { unattended?: boolean } = {},
): Promise<number> {
  // A local upgrade is its own operation: never inherit a previous run's id,
  // approval label or non-interactive flag from the environment.
  env = scrubInstallerOperationEnv({ ...env });
  // `raft-computer upgrade --yes` (Raft Desktop's Update Now): nobody answers
  // the installer's question, so the run is explicitly unattended and reads
  // nothing from stdin.
  const unattended = options.unattended === true;
  const invocation = await installerCommand(unattended ? [...args, "--yes"] : args, env);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      stdio: unattended ? ["ignore", "inherit", "inherit"] : "inherit",
      env: { ...env, RAFT_COMPUTER_INSTALLER_CALLER: "waiting-cli-v1", ...(unattended ? { RAFT_COMPUTER_NON_INTERACTIVE: "1" } : {}) },
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** First installer that leaves the service's systemd unit before stopping it (installer#48/#49). */
export const UNIT_ESCAPING_INSTALLER_VERSION = "0.3.21";

/** The resolved installer's own `--version` ("0.3.21"), or null when it cannot be read. */
export function readInstallerVersion(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, ["--version"], { timeout: 10_000, maxBuffer: 4_096 }, (error, stdout) => {
      const match = error ? null : /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/.exec(String(stdout));
      resolve(match ? match[1] : null);
    });
  });
}

/**
 * The detached installer could not be started: the OS refused the spawn
 * itself, twice. `message` starts with the fixed code (remoteUpgradeTrace
 * `upgradeErrorCode` reads it) and names what failed (`spawn EBADF`), so the
 * trace can count what the OS said without any path.
 */
export class InstallerLaunchError extends Error {
  constructor(readonly causes: readonly string[], readonly attempts: number) {
    super(`installer_launch_failed: ${[...new Set(causes)].join(",")} (${attempts} attempts)`);
    this.name = "InstallerLaunchError";
  }
}

/** `<syscall> <code>` of an OS error ("spawn EBADF", "open EACCES"), else its message's last token. */
function spawnCause(error: unknown): string {
  const { code, syscall } = (error ?? {}) as { code?: unknown; syscall?: unknown };
  if (typeof code === "string" && code) return `${typeof syscall === "string" && syscall ? syscall : "spawn"} ${code}`.slice(0, 40);
  const message = error instanceof Error ? error.message : String(error);
  return (/[A-Za-z0-9_]+$/.exec(message.trim())?.[0] ?? "unknown").slice(0, 40);
}

export interface LaunchInstallerDeps {
  /** Tests: the spawn and the installer resolution; the pause before the one retry. */
  spawnImpl?: typeof spawn;
  resolveCommand?: typeof installerCommand;
  retryDelayMs?: number;
}

const LAUNCH_RETRY_DELAY_MS = 500;

/**
 * A detached native installer survives service replacement. Acceptance is not completion.
 * `beforeSpawn` sees the verified installer and may veto the launch by throwing.
 *
 * The spawn itself has failed with `EBADF` on macOS a few times (11-01, 11-04,
 * 11-13; cause unknown, #67), both here and after a drain, and the request
 * then failed with only "spawn EBADF" behind it. The spawn is tried once more
 * with a freshly opened log file; a second failure is InstallerLaunchError.
 */
export async function launchInstallerDetached(slockHome: string, args: string[], requestId: string,
  env: NodeJS.ProcessEnv = process.env, stats?: InstallerDownloadStats,
  beforeSpawn?: (command: string) => Promise<void>, deps: LaunchInstallerDeps = {}): Promise<number | null> {
  const childEnv = { ...env, RAFT_COMPUTER_INSTALLER_CALLER: undefined, RAFT_HOME: slockHome, SLOCK_HOME: slockHome, RAFT_COMPUTER_NON_INTERACTIVE: "1",
    RAFT_COMPUTER_OPERATION_ID: requestId, RAFT_COMPUTER_APPROVED_BY: `remote:${requestId}` };
  const invocation = await (deps.resolveCommand ?? installerCommand)(args, childEnv, undefined, undefined, stats);
  await beforeSpawn?.(invocation.command);
  const logDir = join(computerDir(slockHome), "installer", "launches");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${createHash("sha256").update(requestId).digest("hex")}.log`);
  const spawnOnce = async (): Promise<number | null> => {
    const log = openSync(logPath, "a");
    let child;
    try {
      child = (deps.spawnImpl ?? spawn)(invocation.command, invocation.args, { detached: true, stdio: ["ignore", log, log], env: childEnv });
    } finally { closeSync(log); }
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    return child.pid ?? null;
  };
  try {
    return await spawnOnce();
  } catch (first) {
    const firstCause = spawnCause(first);
    await new Promise<void>((resolve) => setTimeout(resolve, deps.retryDelayMs ?? LAUNCH_RETRY_DELAY_MS));
    try {
      const pid = await spawnOnce();
      // The cause is unknown: keep the evidence of a failure the retry hid.
      if (stats) stats.spawnRetriedAfter = firstCause;
      process.stderr.write(`[installer] spawn retried after ${firstCause} (request ${requestId})\n`);
      return pid;
    } catch (second) {
      throw new InstallerLaunchError([firstCause, spawnCause(second)], 2);
    }
  }
}

/** Read only a settled, request-bound proof from the installer, never infer it from launch. */
export async function readInstallerUpgradeEvidence(slockHome: string, requestId: string): Promise<{ targetVersion: string; deadProcessIdentities: string[] } | null> {
  const name = createHash("sha256").update(requestId).digest("hex");
  try {
    const file = await open(join(computerDir(slockHome), "installer", "receipts", `${name}.json`), "r");
    let raw: Buffer;
    try {
      const buffer = Buffer.alloc(65_537);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 65_536) return null;
      raw = buffer.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
    const receipt = JSON.parse(raw.toString("utf8"));
    if (receipt.protocol !== "raft-computer-installer/v3" || receipt.id !== requestId
      || receipt.operation !== "upgrade" || receipt.outcome !== "promoted" || receipt.exitCode !== 0
      || typeof receipt.targetVersion !== "string") return null;
    const dead = JSON.parse(receipt.detail?.deadProcessIdentities);
    if (!Array.isArray(dead) || !dead.length || dead.some((value) => typeof value !== "string" || !value)) return null;
    return { targetVersion: receipt.targetVersion, deadProcessIdentities: dead };
  } catch {
    return null;
  }
}

// ---- Remote upgrade v2 (task #873) ----
// The Computer that launched the installer is gone by the time the receipt
// exists, so the request identity is parked in a tiny marker; the successor
// reads the receipt through it once, purely to carry a one-line reason.
const LAST_REMOTE_UPGRADE_MARKER = "last-remote-upgrade.json";

/** `drainMs` (reconciler step 13): the drain the web upgrade waits before its installer runs; it extends the readback window. */
export async function recordRemoteUpgradeLaunch(slockHome: string, input: { requestId: string; targetVersion?: string; originServerId?: string; drainMs?: number }): Promise<void> {
  const dir = join(computerDir(slockHome), "installer");
  mkdirSync(dir, { recursive: true });
  await writeFile(join(dir, LAST_REMOTE_UPGRADE_MARKER), JSON.stringify({ ...input, launchedAt: new Date().toISOString() }), "utf8");
}

/**
 * task #917: Computer refused to launch the installer (external supervisor
 * cannot be upgraded in place). Settle the request the same way the installer
 * would, as a `failed` receipt under the request id, so the successor relay
 * and the server read one terminal outcome instead of waiting for a deadline.
 * The shape follows raft-computer-installer/v3 (rust/report.rs) so a later
 * installer run with the same id reads a valid historical receipt.
 */
export async function recordRemoteUpgradeRefusal(slockHome: string, input: {
  requestId: string;
  targetVersion?: string;
  reason: string;
  /** What refused; `external_supervisor` unless said (step 13: `launch_after_drain`, the spawn after a drain failed). */
  refusal?: "external_supervisor" | "launch_after_drain";
}): Promise<void> {
  const dir = join(computerDir(slockHome), "installer", "receipts");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const reason = input.reason.replace(/[\u0000-\u001f\u007f]+/gu, " ").slice(0, 2048);
  const receipt = {
    protocol: "raft-computer-installer/v3",
    installerVersion: `raft-computer/${COMPUTER_VERSION}`,
    id: input.requestId,
    operation: "upgrade",
    presence: "unattended",
    targetVersion: input.targetVersion ?? null,
    fromVersion: COMPUTER_VERSION,
    approvedBy: `remote:${input.requestId}`,
    outcome: "failed",
    exitCode: 1,
    reason,
    line: input.refusal === "launch_after_drain"
      ? "Raft Computer could not start the installer after its agents finished their work."
      : "Raft Computer did not start the upgrade: the service is managed by an external supervisor that must be configured first.",
    nextStep: null,
    finishedAtMs: Date.now(),
    detail: { refusedBy: "raft-computer", refusal: input.refusal ?? "external_supervisor" },
  };
  await writeFile(join(dir, `${createHash("sha256").update(input.requestId).digest("hex")}.json`), JSON.stringify(receipt), { encoding: "utf8", mode: 0o600 });
}

export async function readLastRemoteUpgradeReceipt(slockHome: string): Promise<ComputerLastUpgradeReceipt | null> {
  try {
    const marker = JSON.parse(await readFile(join(computerDir(slockHome), "installer", LAST_REMOTE_UPGRADE_MARKER), "utf8"));
    if (typeof marker?.requestId !== "string") return null;
    return await readRemoteUpgradeReceipt(slockHome, marker.requestId, typeof marker.targetVersion === "string" ? marker.targetVersion : undefined);
  } catch {
    return null;
  }
}

/**
 * The upgrade reached its target. `repaired` is the installer finding the
 * existing installation damaged and installing the requested version over it
 * (rust/operation.rs Kind::Repair, exit 0): an upgrade that also repaired, not
 * a failure. `installed` is the installer finding no installation it manages
 * and installing the requested version fresh (Kind::Fresh, exit 0); it is a
 * success only when the installer read the running service back at that
 * version (`detail.readback` "service"). With "candidate" nothing was started,
 * so whatever ran before may still be running.
 */
export function upgradeReceiptSucceeded(receipt: { outcome?: unknown; exitCode?: unknown; detail?: { readback?: unknown } | null }): boolean {
  if (receipt.outcome === "promoted") return true;
  if (receipt.exitCode !== 0) return false;
  return receipt.outcome === "repaired" || (receipt.outcome === "installed" && receipt.detail?.readback === "service");
}

/** The installer's receipt for one request, reduced to what the server consumes; null until it exists. */
async function readRemoteUpgradeReceipt(slockHome: string, requestId: string, fallbackTargetVersion?: string): Promise<ComputerLastUpgradeReceipt | null> {
  try {
    const name = createHash("sha256").update(requestId).digest("hex");
    const raw = await readFile(join(computerDir(slockHome), "installer", "receipts", `${name}.json`), "utf8");
    if (raw.length > 65_536) return null;
    const receipt = JSON.parse(raw);
    if (receipt.protocol !== "raft-computer-installer/v3" || receipt.id !== requestId || receipt.operation !== "upgrade") return null;
    const targetVersion = typeof receipt.targetVersion === "string" ? receipt.targetVersion : fallbackTargetVersion;
    if (typeof targetVersion !== "string") return null;
    const outcome: ComputerLastUpgradeReceipt["outcome"] = upgradeReceiptSucceeded(receipt)
      ? "promoted"
      // The installer writes kebab-case (`rolled-back`, rust/report.rs); the
      // snake_case spelling is accepted for receipts written before that.
      : receipt.outcome === "rolled-back" || receipt.outcome === "rolled_back" || receipt.rolledBack === true
        ? "rolled_back"
        : receipt.exitCode === 2
          ? "held"
          : receipt.exitCode === 3
            ? "unresolved"
            : "failed";
    const reason = typeof receipt.reason === "string" ? receipt.reason
      : typeof receipt.error === "string" ? receipt.error
      : typeof receipt.detail?.reason === "string" ? receipt.detail.reason
      : undefined;
    if (outcome === "promoted") return { targetVersion, outcome, ...(reason ? { reason } : {}) };
    const code = normalizeComputerUpgradeInstallerCode(receipt.code);
    const diagnosticCode = installerDiagnosticCode(receipt.detail?.diagnostic);
    return {
      targetVersion,
      outcome,
      ...(reason ? { reason } : {}),
      ...(code ? { code } : {}),
      ...(diagnosticCode ? { diagnosticCode } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The update engine's error class leading a receipt's `detail.diagnostic`
 * (`DOWNLOAD_FAILED: overall timeout` → `DOWNLOAD_FAILED`), else null. The
 * installer prefixes a cause carried over from an earlier run with
 * `upgrade still requires recovery: ` (rust/operation.rs
 * record_failure_diagnostic) and reads past it itself (recorded_cause); so
 * does this. Only the token goes on, never the text.
 */
export function installerDiagnosticCode(diagnostic: unknown): string | null {
  if (typeof diagnostic !== "string") return null;
  const cause = diagnostic.startsWith("upgrade still requires recovery: ")
    ? diagnostic.slice("upgrade still requires recovery: ".length)
    : diagnostic;
  return normalizeComputerUpgradeInstallerDiagnosticCode(/^([A-Z][A-Z0-9_]*)(?::|$)/u.exec(cause)?.[1]);
}

/**
 * The error the launching runner throws for an installer that gave up
 * without stopping the service: the text older Servers read
 * (`UPGRADE_INSTALLER_FAILED: <reason>`, unchanged), and the receipt's
 * outcome and codes as fixed fields for `computer:upgrade:done`.
 */
export function remoteUpgradeInstallerFailure(receipt: ComputerLastUpgradeReceipt): Error {
  const error = new Error(`UPGRADE_INSTALLER_FAILED: ${receipt.reason ?? `installer_${receipt.outcome}`}`);
  const report = parseComputerUpgradeInstallerReport({
    installerOutcome: receipt.outcome,
    installerCode: receipt.code,
    installerDiagnosticCode: receipt.diagnosticCode,
  });
  return report ? withComputerUpgradeInstallerReport(error, report) : error;
}

/** Matches the server's request deadline (UPGRADE_REQUEST_DEADLINE_MS); a later report settles nothing. */
export const REMOTE_UPGRADE_FAILURE_WATCH_MS = 30 * 60 * 1000;

/**
 * Remote upgrade v2 readback while the launching runner is still alive. A
 * promoted or rolled-back installer has already stopped this service, so the
 * successor's `ready` relays the receipt. An installer that gives up before
 * stopping it (held, preflight or download failure) leaves the service up and
 * connected: no reconnect ever comes, and without this the request waits out
 * its whole deadline as `no_response` (task #873 follow-up, 2026-10-19).
 * Resolves with that receipt, or null once it is promoted or the wait ends.
 */
export async function waitForRemoteUpgradeFailureReceipt(slockHome: string, requestId: string, options: {
  targetVersion?: string;
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
} = {}): Promise<ComputerLastUpgradeReceipt | null> {
  const receipt = await waitForRemoteUpgradeReceipt(slockHome, requestId, options);
  return receipt && receipt.outcome !== "promoted" ? receipt : null;
}

/** The request's receipt once it appears (promoted included), or null when the wait ends first. */
async function waitForRemoteUpgradeReceipt(slockHome: string, requestId: string, options: {
  targetVersion?: string;
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<ComputerLastUpgradeReceipt | null> {
  const timeoutMs = options.timeoutMs ?? REMOTE_UPGRADE_FAILURE_WATCH_MS;
  const pollMs = options.pollMs ?? 5_000;
  const now = options.now ?? Date.now;
  // unref: a runner shutting down for the upgrade must not wait on this poll.
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref(); }));
  const deadline = now() + timeoutMs;
  for (;;) {
    const receipt = await readRemoteUpgradeReceipt(slockHome, requestId, options.targetVersion);
    if (receipt) return receipt;
    if (now() >= deadline) return null;
    await sleep(pollMs);
  }
}


/**
 * The successor half of the readback above. A rolled-back (or failed after
 * stopping) installer restarts the old service and only then writes its
 * receipt, so that service's first `ready` carries none and the server keeps
 * the request open until the deadline. While the last web upgrade launched for
 * this server is inside its deadline and has no receipt yet, wait for it;
 * resolves with a non-promoted receipt, or null.
 *
 * A promoted receipt resolves `{ requestId, succeeded: true }`: the new
 * version's `ready` came before the installer's receipt, so the steps derived
 * from it (`new_version_started`, `installer_finished`) are sent now rather
 * than at the next reconnect (9081e716: still unsent 1.5 h after, 11-15).
 */
export async function watchRemoteUpgradeOutcome(slockHome: string, serverId: string, options: {
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
} = {}): Promise<{ requestId: string; succeeded: true } | { requestId: string; outcome: ComputerLastUpgradeReceipt["outcome"]; reason: string; code?: string; diagnosticCode?: string } | null> {
  const now = options.now ?? Date.now;
  let marker: { requestId?: unknown; targetVersion?: unknown; originServerId?: unknown; launchedAt?: unknown; drainMs?: unknown };
  try {
    marker = JSON.parse(await readFile(join(computerDir(slockHome), "installer", LAST_REMOTE_UPGRADE_MARKER), "utf8"));
  } catch {
    return null;
  }
  if (typeof marker?.requestId !== "string") return null;
  // Markers written before originServerId existed are left to the deadline.
  if (marker.originServerId !== serverId) return null;
  const launchedAtMs = typeof marker.launchedAt === "string" ? Date.parse(marker.launchedAt) : NaN;
  const drainMs = typeof marker.drainMs === "number" && Number.isFinite(marker.drainMs) && marker.drainMs > 0 ? marker.drainMs : 0;
  const remainingMs = launchedAtMs + REMOTE_UPGRADE_FAILURE_WATCH_MS + drainMs - now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;
  const targetVersion = typeof marker.targetVersion === "string" ? marker.targetVersion : undefined;
  // Already there: the `ready` that preceded this call carried it (a failure
  // is not reported twice). A promotion still has its steps sent: they are
  // acknowledged per step, so a second send sends nothing again.
  const present = await readRemoteUpgradeReceipt(slockHome, marker.requestId, targetVersion);
  if (present) return present.outcome === "promoted" ? { requestId: marker.requestId, succeeded: true } : null;
  const failure = await waitForRemoteUpgradeReceipt(slockHome, marker.requestId, {
    ...(targetVersion ? { targetVersion } : {}),
    timeoutMs: remainingMs,
    ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    now,
  });
  if (!failure) return null;
  if (failure.outcome === "promoted") return { requestId: marker.requestId, succeeded: true };
  return {
    requestId: marker.requestId,
    outcome: failure.outcome,
    reason: failure.reason ?? `installer_${failure.outcome}`,
    ...(failure.code ? { code: failure.code } : {}),
    ...(failure.diagnosticCode ? { diagnosticCode: failure.diagnosticCode } : {}),
  };
}
