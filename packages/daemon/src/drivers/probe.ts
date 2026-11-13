import { ambientProcessEnv } from "../processEnvPatch";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { logger } from "../logger";
import type { RuntimeProbeUnavailableReason } from "./types";
import { createWindowsPowerShellChildEnv } from "./windowsPowerShellEnv";
import { type ProbeChildCleanup, ProbeChildError, runProbeChild } from "./probeChild";

export interface ProbeDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  execIsElectron?: boolean;
  /** Optional authoritative SEA classification for the current executable. */
  execIsSea?: boolean;
  /** Optional authoritative Node-capability classification for the current executable. */
  hasNodeRuntime?: boolean;
  cwd?: string;
  homeDir?: string;
  warn?: (message: string) => void;
  existsSyncFn?: (filePath: string) => boolean;
  /** task #1358 — monotonic clock stand-in (ms) for probe-cache expiry; defaults to performance.now(). */
  nowFn?: () => number;
  /** Optional fs.statSync stand-in (mtime/size probe cache keys). */
  statSyncFn?: (filePath: string) => { mtimeMs: number; size: number };
  /** Optional stand-in for OAR's `desktopBuildExecutables` (the Codex Desktop build CLIs in a Windows `bin` folder, newest first). */
  codexDesktopBuildsFn?: (bin: string) => readonly string[];
  execFileSyncFn?: typeof execFileSync;
  /** Optional fs.readFileSync stand-in (Windows batch wrapper parsing). */
  readFileSyncFn?: (filePath: string, encoding: "utf8") => string;
  windowsEnvironmentReaderFn?: WindowsEnvironmentReader;
  /** task #1277 — stand-in for the bounded child runner behind the `*Async` probes (the async twin of `execFileSyncFn`). */
  runProbeChildFn?: typeof runProbeChild;
  windowsEnvironmentReaderAsyncFn?: WindowsEnvironmentReaderAsync;
  /**
   * task #1277 — cancels an in-flight `*Async` probe. Operation-scoped: the
   * caller binds it to what the probe serves (a form request, a launch), never
   * to the connection by default.
   */
  signal?: AbortSignal;
}

export interface WindowsEnvironmentScopes {
  machine?: NodeJS.ProcessEnv;
  user?: NodeJS.ProcessEnv;
}

/**
 * task #1240 — a reader that could not produce scopes says why, so the lookup
 * timing can tell a killed (timed out) environment child from a failed one.
 */
export interface WindowsEnvironmentReadResult {
  scopes: WindowsEnvironmentScopes | null;
  failure?: { outcome: "timeout" | "exit" | "spawn_error"; truncated: boolean };
}

export type WindowsEnvironmentReader = (
  env: NodeJS.ProcessEnv,
  execFileSyncFn: typeof execFileSync,
  warn?: (message: string) => void,
) => WindowsEnvironmentScopes | WindowsEnvironmentReadResult | null;

export type WindowsEnvironmentReaderAsync = (
  env: NodeJS.ProcessEnv,
  runChild: typeof runProbeChild,
  warn?: (message: string) => void,
  signal?: AbortSignal,
) => Promise<WindowsEnvironmentScopes | WindowsEnvironmentReadResult | null>;

function normalizeExecOutput(raw: unknown): string {
  return Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw ?? "");
}

const WINDOWS_ENVIRONMENT_SCRIPT = [
  "& {",
  "  $result = [ordered]@{}",
  "  foreach ($scope in @('Machine', 'User')) {",
  "    $scopeEnv = [Environment]::GetEnvironmentVariables($scope)",
  "    $scopeObj = [ordered]@{}",
  "    foreach ($key in $scopeEnv.Keys) {",
  "      $value = $scopeEnv[$key]",
  "      if ($null -ne $value) { $scopeObj[$key] = [string]$value }",
  "    }",
  "    $result[$scope] = $scopeObj",
  "  }",
  "  $result | ConvertTo-Json -Compress -Depth 3",
  "}",
].join("\n");

const WINDOWS_ENVIRONMENT_ERROR_SUMMARY_MAX_LENGTH = 240;

function summarizeWindowsEnvironmentError(error: unknown): string {
  const details = error as {
    code?: unknown;
    signal?: unknown;
    status?: unknown;
    stderr?: unknown;
  };
  const exit = typeof details?.status === "number" ? String(details.status) : "unknown";
  const code = typeof details?.code === "string" ? details.code : "unknown";
  const signal = typeof details?.signal === "string" ? details.signal : "none";
  const stderr = normalizeExecOutput(details?.stderr).trim().replace(/\s+/g, " ");
  const fallback = error instanceof Error ? error.message.trim().replace(/\s+/g, " ") : String(error);
  const rawSummary = stderr || fallback || "no child error detail";
  const summary = rawSummary.length > WINDOWS_ENVIRONMENT_ERROR_SUMMARY_MAX_LENGTH
    ? `${rawSummary.slice(0, WINDOWS_ENVIRONMENT_ERROR_SUMMARY_MAX_LENGTH - 3)}...`
    : rawSummary;
  return `[Daemon] Windows environment refresh failed (exit=${exit}, code=${code}, signal=${signal}): ${summary}`;
}

// Each runtime is probed again on reconnect/config refresh, so a slow lookup
// fails this inventory pass without becoming a cached permanent miss. The
// budget covers powershell.exe process start plus Get-Command; a lookup that
// exceeds it is reported as `probe_timeout`, never as `not_installed`
// (task #1240).
//
// 5000 ms (was 1000): this lookup is a hard gate before every Windows launch,
// so a budget that is too short means the runtime never starts on a slow
// machine, while a longer budget costs nothing on a machine that answers in
// time (CI measurement 2026-10-13, 30 lookups under the old 1000 ms budget:
// Get-Command 0.2–0.44 s, environment read 0.2–0.4 s, none truncated; a user
// reported 1.0–1.2 s PowerShell starts, which CI does not reproduce). It is
// the same budget the environment read below already had, so one lookup is
// bounded by 2 × 5000 ms; the daemon's runtime start timeout (2 min, 10 for OpenCode) and the
// per-runtime detection loop sit above it, both far larger.
export const WINDOWS_COMMAND_RESOLVE_TIMEOUT_MS = 5000;
/** Budget for the Machine/User environment read that precedes a Windows lookup. */
export const WINDOWS_ENVIRONMENT_READ_TIMEOUT_MS = 5000;

/**
 * task #1240 — how long each child of a command lookup took. Phase, duration,
 * budget and outcome only: never the environment values, command output or
 * resolved path (a Windows path carries the user name).
 */
export interface CommandLookupTiming {
  phase: "windows_environment" | "windows_get_command" | "posix_which";
  /** Elapsed wall-clock time of the child as observed by the daemon (hrtime), in ms. */
  ms: number;
  budgetMs: number | null;
  outcome: "ok" | "timeout" | "exit" | "spawn_error";
  /**
   * The child was killed at its budget: `ms` is then the elapsed time until
   * the kill was observed (a censored value, at or slightly above `budgetMs`),
   * never a completion time.
   */
  truncated: boolean;
  /** task #1277 — set by the async probes when the child was killed: whether its tree was seen to end. */
  cleanup?: ProbeChildCleanup;
}

/** Bounded one-line rendering for diagnostics and logs (no values, no paths). */
export function formatCommandLookupTiming(timing: readonly CommandLookupTiming[] | undefined): string | undefined {
  if (!timing || timing.length === 0) return undefined;
  return timing
    .map((entry) => `${entry.phase.replace(/^windows_|^posix_/, "").replace("_", "-")} ${Math.round(entry.ms)} ms ${entry.outcome}${entry.truncated ? " (truncated)" : ""}${entry.budgetMs !== null ? ` (budget ${entry.budgetMs} ms)` : ""}`)
    .join(", ");
}

function elapsedMs(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1e6;
}

/** The failure side of timingOutcome: a thrown child never yields "ok". */
function childFailureOutcome(error: unknown): NonNullable<WindowsEnvironmentReadResult["failure"]> {
  const outcome = timingOutcome(error);
  return { outcome: outcome.outcome === "ok" ? "spawn_error" : outcome.outcome, truncated: outcome.truncated };
}

function timingOutcome(error: unknown): { outcome: CommandLookupTiming["outcome"]; truncated: boolean } {
  const details = error && typeof error === "object" ? (error as { code?: unknown; status?: unknown }) : {};
  if (details.code === "ETIMEDOUT") return { outcome: "timeout", truncated: true };
  if (typeof details.status === "number") return { outcome: "exit", truncated: false };
  return { outcome: "spawn_error", truncated: false };
}

function normalizeProcessEnv(value: unknown): NodeJS.ProcessEnv {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const env: NodeJS.ProcessEnv = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (rawValue !== undefined && rawValue !== null) {
      env[key] = String(rawValue);
    }
  }
  return env;
}

function readWindowsMachineUserEnvironment(
  env: NodeJS.ProcessEnv,
  execFileSyncFn: typeof execFileSync,
  warn?: (message: string) => void,
): WindowsEnvironmentReadResult {
  try {
    const output = normalizeExecOutput(execFileSyncFn("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_ENVIRONMENT_SCRIPT,
    ], {
      stdio: ["ignore", "pipe", "ignore"],
      env: createWindowsPowerShellChildEnv(env),
      timeout: WINDOWS_ENVIRONMENT_READ_TIMEOUT_MS,
    }));
    const parsed = JSON.parse(output || "{}") as { Machine?: unknown; User?: unknown };
    return {
      scopes: {
        machine: normalizeProcessEnv(parsed.Machine),
        user: normalizeProcessEnv(parsed.User),
      },
    };
  } catch (error) {
    warn?.(summarizeWindowsEnvironmentError(error));
    return { scopes: null, failure: childFailureOutcome(error) };
  }
}

function findEnvKey(env: NodeJS.ProcessEnv | undefined, name: string): string | null {
  if (!env) return null;
  const lowerName = name.toLowerCase();
  const keys = Object.keys(env);
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    const key = keys[index]!;
    if (key.toLowerCase() === lowerName) return key;
  }
  return null;
}

function getEnvValue(env: NodeJS.ProcessEnv | undefined, name: string): string | undefined {
  const key = findEnvKey(env, name);
  return key ? env?.[key] : undefined;
}

function setEnvValue(env: NodeJS.ProcessEnv, key: string, value: string): void {
  const existingKey = findEnvKey(env, key);
  if (existingKey && existingKey !== key) {
    delete env[existingKey];
  }
  env[key] = value;
}

function mergeWindowsPathSegments(values: Array<string | undefined>): string | undefined {
  const segments: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    for (const rawSegment of value.split(";")) {
      const segment = rawSegment.trim();
      if (!segment) continue;
      const key = segment.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      segments.push(segment);
    }
  }
  return segments.length > 0 ? segments.join(";") : undefined;
}

function mergeWindowsEnvironmentScopes(
  baseEnv: NodeJS.ProcessEnv,
  scopes: WindowsEnvironmentScopes,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = {};
  const layers = [scopes.machine ?? {}, scopes.user ?? {}, baseEnv];

  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined || key.toLowerCase() === "path") continue;
      setEnvValue(merged, key, value);
    }
  }

  const pathKey = findEnvKey(baseEnv, "Path")
    ?? findEnvKey(scopes.machine, "Path")
    ?? findEnvKey(scopes.user, "Path")
    ?? "Path";
  // Keep daemon/agent overrides first, then append Machine/User PATH entries
  // that a long-lived daemon process may not have inherited yet.
  const pathValue = mergeWindowsPathSegments([
    getEnvValue(baseEnv, "Path"),
    getEnvValue(scopes.machine, "Path"),
    getEnvValue(scopes.user, "Path"),
  ]);
  if (pathValue) {
    merged[pathKey] = pathValue;
  }

  return merged;
}

export function withWindowsUserEnvironment(
  env: NodeJS.ProcessEnv,
  deps: ProbeDeps = {},
  timing?: CommandLookupTiming[],
): NodeJS.ProcessEnv {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") return env;

  const execFileSyncFn = deps.execFileSyncFn ?? execFileSync;
  const reader = deps.windowsEnvironmentReaderFn ?? readWindowsMachineUserEnvironment;
  const warn = deps.warn ?? ((message: string) => logger.warn(message));
  // The default reader keeps the environment child's structured outcome
  // (timeout / exit / spawn failure) next to its warning, so a killed 5 s
  // environment read is recorded as a truncated timeout, not as a plain
  // failure; injected readers may still return bare scopes or null.
  const startedAt = process.hrtime.bigint();
  const read = normalizeWindowsEnvironmentRead(reader(env, execFileSyncFn, warn));
  timing?.push({
    phase: "windows_environment",
    ms: elapsedMs(startedAt),
    budgetMs: WINDOWS_ENVIRONMENT_READ_TIMEOUT_MS,
    outcome: read.scopes ? "ok" : (read.failure?.outcome ?? "spawn_error"),
    truncated: read.scopes ? false : (read.failure?.truncated ?? false),
  });
  if (!read.scopes) return env;

  return mergeWindowsEnvironmentScopes(env, read.scopes);
}

/** Readers may return scopes (or null) directly; the default reader also says why it failed. */
function normalizeWindowsEnvironmentRead(value: WindowsEnvironmentScopes | WindowsEnvironmentReadResult | null): WindowsEnvironmentReadResult {
  if (value && typeof value === "object" && "scopes" in value) return value as WindowsEnvironmentReadResult;
  return { scopes: value as WindowsEnvironmentScopes | null };
}

function resolveCommandOnWindows(
  command: string,
  env: NodeJS.ProcessEnv,
  execFileSyncFn: typeof execFileSync,
  existsSyncFn: (filePath: string) => boolean,
  timing: CommandLookupTiming[],
): CommandLookup {
  // Only a CommandNotFoundException means "not on PATH"; it exits with a
  // reserved code. Any other failure of the lookup exits 1 (PowerShell's
  // default for an uncaught error) and is not evidence that the command is
  // absent.
  const script =
    "& {try { $cmd = Get-Command -Name $args[0] -ErrorAction Stop | Select-Object -First 1 } " +
    `catch [System.Management.Automation.CommandNotFoundException] { exit ${WINDOWS_LOOKUP_NOT_FOUND_EXIT} }; ` +
    "if ($cmd.Path) { $cmd.Path } " +
    "elseif ($cmd.Source) { $cmd.Source } " +
    "elseif ($cmd.Definition) { $cmd.Definition } }";

  const startedAt = process.hrtime.bigint();
  try {
    const output = normalizeExecOutput(execFileSyncFn("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
      command,
    ], {
      stdio: ["ignore", "pipe", "ignore"],
      env: createWindowsPowerShellChildEnv(env),
      timeout: WINDOWS_COMMAND_RESOLVE_TIMEOUT_MS,
    }));
    timing.push({ phase: "windows_get_command", ms: elapsedMs(startedAt), budgetMs: WINDOWS_COMMAND_RESOLVE_TIMEOUT_MS, outcome: "ok", truncated: false });
    const resolved = output.trim().split(/\r?\n/)[0];
    // Found but with no usable path, or a lookup that printed nothing: not a miss.
    if (!resolved) return { command: null, missReason: "probe_failed", timing };

    // PowerShell Get-Command prefers .ps1, but cmd.exe cannot execute .ps1
    // (it opens Notepad or hangs). Prefer .cmd > .bat > .exe / extensionless
    // in the same directory.
    const lowerResolved = resolved.toLowerCase();
    if (lowerResolved.endsWith(".ps1")) {
      const dir = path.dirname(resolved);
      const base = path.basename(resolved, ".ps1");
      const alternatives = [
        path.join(dir, `${base}.cmd`),
        path.join(dir, `${base}.bat`),
        path.join(dir, `${base}.exe`),
        path.join(dir, base),
      ];
      for (const alt of alternatives) {
        if (existsSyncFn(alt)) return { command: alt, timing };
      }
      // Found, but only as a PowerShell script cmd.exe cannot run.
      return { command: null, missReason: "probe_failed", timing };
    }

    return { command: resolved, timing };
  } catch (error) {
    timing.push({ phase: "windows_get_command", ms: elapsedMs(startedAt), budgetMs: WINDOWS_COMMAND_RESOLVE_TIMEOUT_MS, ...timingOutcome(error) });
    return { command: null, missReason: classifyCommandLookupFailure(error, WINDOWS_LOOKUP_NOT_FOUND_EXIT), timing };
  }
}

/**
 * Result of looking a command up on PATH. `missReason` is set only when
 * `command` is null: "not_installed" means the lookup itself ran and reported
 * the command absent; any other reason means the lookup could not decide
 * (timed out, locator missing, ...), so the caller must not treat it as absent.
 */
export interface CommandLookup {
  command: string | null;
  missReason?: RuntimeProbeUnavailableReason;
  /** task #1240 — per-child timing of this lookup (Windows only today). */
  timing?: CommandLookupTiming[];
}

/** Exit code the Windows lookup script reserves for "Get-Command found nothing". */
const WINDOWS_LOOKUP_NOT_FOUND_EXIT = 3;
/** `which` (debianutils, GNU, BusyBox, macOS) exits 1 when a command is not found; 2+ is a usage/internal error. */
const POSIX_WHICH_NOT_FOUND_EXIT = 1;

function classifyCommandLookupFailure(error: unknown, notFoundExit: number): RuntimeProbeUnavailableReason {
  // Only the locator's own "not found" status means absent. Any other exit
  // status (the locator failed) or a spawn error (timeout, missing locator,
  // EACCES) cannot tell us the command is missing.
  const status = error && typeof error === "object" ? (error as { status?: unknown }).status : undefined;
  if (status === notFoundExit) return "not_installed";
  return classifyProbeExecFailure(error);
}

const POSIX_USER_BIN_DIRS = [[".local", "bin"], [".kimi-code", "bin"]] as const;

export function resolveCommandOnPath(command: string, deps: ProbeDeps = {}): string | null {
  return lookupCommandOnPath(command, deps).command;
}

/** {@link resolveCommandOnPath} plus a structured reason when the command was not resolved. */
export function lookupCommandOnPath(command: string, deps: ProbeDeps = {}): CommandLookup {
  const platform = deps.platform ?? process.platform;
  const timing: CommandLookupTiming[] = [];
  const env = withWindowsUserEnvironment(deps.env ?? ambientProcessEnv(), deps, timing);
  const execFileSyncFn = deps.execFileSyncFn ?? execFileSync;
  const existsSyncFn = deps.existsSyncFn ?? existsSync;
  if (platform === "win32") {
    return resolveCommandOnWindows(command, env, execFileSyncFn, existsSyncFn, timing);
  }
  const locator = "which";

  let missReason: RuntimeProbeUnavailableReason = "not_installed";
  try {
    const output = normalizeExecOutput(execFileSyncFn(locator, [command], {
      stdio: ["ignore", "pipe", "ignore"],
      env,
    }));
    const resolved = output.trim().split(/\r?\n/)[0];
    if (resolved) return { command: resolved };
    // `which` succeeded but printed nothing: not evidence of absence.
    missReason = "probe_failed";
  } catch (error) {
    // Fall through to the user-local bin directories.
    missReason = classifyCommandLookupFailure(error, POSIX_WHICH_NOT_FOUND_EXIT);
  }
  // A service started from a non-login context (installer, cron, `env -i`)
  // inherits the system default PATH, which omits the user-local bin
  // directories where the Claude Code, Codex, Grok and Kimi installers put
  // their binaries.
  const homeDir = deps.homeDir ?? env.HOME;
  const fallback = homeDir
    ? firstExistingPath(
      POSIX_USER_BIN_DIRS.map((segments) => path.posix.join(homeDir, ...segments, command)),
      deps,
    )
    : null;
  return fallback ? { command: fallback } : { command: null, missReason };
}

/**
 * Classify a failed probe child process (execFileSync error) by its structured
 * fields. The command was already resolved, so this never returns
 * "not_installed": a resolved command that fails to exec (even with ENOENT,
 * e.g. a missing shebang interpreter) is a broken install, not a missing one.
 */
export function classifyProbeExecFailure(error: unknown): Exclude<RuntimeProbeUnavailableReason, "not_installed" | "unsupported_version"> {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (code === "ETIMEDOUT") return "probe_timeout";
  if (code === "EACCES" || code === "EPERM") return "permission_denied";
  return "probe_failed";
}

export function firstExistingPath(candidates: string[], deps: ProbeDeps = {}): string | null {
  const exists = deps.existsSyncFn ?? existsSync;
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

export function readCommandVersion(command: string, args: string[] = [], deps: ProbeDeps = {}): string | null {
  const env = withWindowsUserEnvironment(deps.env ?? ambientProcessEnv(), deps);
  const execFileSyncFn = deps.execFileSyncFn ?? execFileSync;
  try {
    const output = normalizeExecOutput(execFileSyncFn(command, [...args, "--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
      ...(deps.cwd ? { cwd: deps.cwd } : {}),
      timeout: 5000,
    }));
    return output.trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

export function resolveHomePath(relativePath: string, deps: ProbeDeps = {}): string {
  const homeDir = deps.homeDir ?? deps.env?.HOME ?? process.env.HOME ?? "";
  return path.join(homeDir, relativePath);
}

// ── task #1277: asynchronous twins of the probes above ────────────────────
//
// Same command, environment, classification and timing as the synchronous
// probes; the difference is where the child runs. The synchronous probes stay
// for callers that already execute inside the detection child (#9665) and for
// launch paths not yet migrated. Each `*Async` twin runs its child through
// `runProbeChild`: bounded, killable as a tree, cleanup reported apart from
// the timeout.

/**
 * Budget for the POSIX `which` lookup in the async probe. The synchronous
 * lookup has none; a `which` that exceeds it is `probe_timeout`, never
 * `not_installed` (task #1242).
 */
export const POSIX_WHICH_TIMEOUT_MS = 5000;

const WINDOWS_ENVIRONMENT_ARGS = ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_ENVIRONMENT_SCRIPT] as const;

async function readWindowsMachineUserEnvironmentAsync(
  env: NodeJS.ProcessEnv,
  runChild: typeof runProbeChild,
  warn?: (message: string) => void,
  signal?: AbortSignal,
): Promise<WindowsEnvironmentReadResult> {
  try {
    const { stdout } = await runChild("powershell.exe", [...WINDOWS_ENVIRONMENT_ARGS], {
      env: createWindowsPowerShellChildEnv(env),
      timeoutMs: WINDOWS_ENVIRONMENT_READ_TIMEOUT_MS,
      stderr: "ignore",
      platform: "win32",
      signal,
    });
    const parsed = JSON.parse(stdout || "{}") as { Machine?: unknown; User?: unknown };
    return {
      scopes: {
        machine: normalizeProcessEnv(parsed.Machine),
        user: normalizeProcessEnv(parsed.User),
      },
    };
  } catch (error) {
    rethrowIfAborted(error, signal);
    warn?.(summarizeWindowsEnvironmentError(error));
    return { scopes: null, failure: childFailureOutcome(error) };
  }
}

/**
 * A cancelled probe is not a verdict. Once the operation's signal is aborted,
 * the async probes stop at the first child failure and rethrow the abort:
 * no classification, no fallback lookup, so a caller never proceeds (or
 * launches) on the strength of a probe that was told to stop.
 */
function rethrowIfAborted(error: unknown, signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (error instanceof ProbeChildError && error.code === "ABORT_ERR") throw error;
  throw new ProbeChildError("probe aborted", { code: "ABORT_ERR" });
}

function cleanupOf(error: unknown): { cleanup?: ProbeChildCleanup } {
  const cleanup = error && typeof error === "object" ? (error as { cleanup?: ProbeChildCleanup }).cleanup : undefined;
  return cleanup ? { cleanup } : {};
}

export async function withWindowsUserEnvironmentAsync(
  env: NodeJS.ProcessEnv,
  deps: ProbeDeps = {},
  timing?: CommandLookupTiming[],
): Promise<NodeJS.ProcessEnv> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") return env;

  const runChild = deps.runProbeChildFn ?? runProbeChild;
  const warn = deps.warn ?? ((message: string) => logger.warn(message));
  const startedAt = process.hrtime.bigint();
  // An injected synchronous reader is honoured so one test double serves both
  // twins; otherwise the async reader runs the same PowerShell script.
  const read = normalizeWindowsEnvironmentRead(
    deps.windowsEnvironmentReaderAsyncFn
      ? await deps.windowsEnvironmentReaderAsyncFn(env, runChild, warn, deps.signal)
      : deps.windowsEnvironmentReaderFn
        ? deps.windowsEnvironmentReaderFn(env, deps.execFileSyncFn ?? execFileSync, warn)
        : await readWindowsMachineUserEnvironmentAsync(env, runChild, warn, deps.signal),
  );
  timing?.push({
    phase: "windows_environment",
    ms: elapsedMs(startedAt),
    budgetMs: WINDOWS_ENVIRONMENT_READ_TIMEOUT_MS,
    outcome: read.scopes ? "ok" : (read.failure?.outcome ?? "spawn_error"),
    truncated: read.scopes ? false : (read.failure?.truncated ?? false),
  });
  if (!read.scopes) return env;
  return mergeWindowsEnvironmentScopes(env, read.scopes);
}

async function resolveCommandOnWindowsAsync(
  command: string,
  env: NodeJS.ProcessEnv,
  runChild: typeof runProbeChild,
  existsSyncFn: (filePath: string) => boolean,
  timing: CommandLookupTiming[],
  signal?: AbortSignal,
): Promise<CommandLookup> {
  const script =
    "& {try { $cmd = Get-Command -Name $args[0] -ErrorAction Stop | Select-Object -First 1 } " +
    `catch [System.Management.Automation.CommandNotFoundException] { exit ${WINDOWS_LOOKUP_NOT_FOUND_EXIT} }; ` +
    "if ($cmd.Path) { $cmd.Path } " +
    "elseif ($cmd.Source) { $cmd.Source } " +
    "elseif ($cmd.Definition) { $cmd.Definition } }";

  const startedAt = process.hrtime.bigint();
  let output: string;
  try {
    output = (await runChild("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script, command], {
      env: createWindowsPowerShellChildEnv(env),
      timeoutMs: WINDOWS_COMMAND_RESOLVE_TIMEOUT_MS,
      stderr: "ignore",
      platform: "win32",
      signal,
    })).stdout;
  } catch (error) {
    rethrowIfAborted(error, signal);
    timing.push({ phase: "windows_get_command", ms: elapsedMs(startedAt), budgetMs: WINDOWS_COMMAND_RESOLVE_TIMEOUT_MS, ...timingOutcome(error), ...cleanupOf(error) });
    return { command: null, missReason: classifyCommandLookupFailure(error, WINDOWS_LOOKUP_NOT_FOUND_EXIT), timing };
  }
  timing.push({ phase: "windows_get_command", ms: elapsedMs(startedAt), budgetMs: WINDOWS_COMMAND_RESOLVE_TIMEOUT_MS, outcome: "ok", truncated: false });
  const resolved = output.trim().split(/\r?\n/)[0];
  if (!resolved) return { command: null, missReason: "probe_failed", timing };
  if (resolved.toLowerCase().endsWith(".ps1")) {
    const dir = path.dirname(resolved);
    const base = path.basename(resolved, ".ps1");
    for (const alt of [path.join(dir, `${base}.cmd`), path.join(dir, `${base}.bat`), path.join(dir, `${base}.exe`), path.join(dir, base)]) {
      if (existsSyncFn(alt)) return { command: alt, timing };
    }
    return { command: null, missReason: "probe_failed", timing };
  }
  return { command: resolved, timing };
}

/** {@link lookupCommandOnPath} off the event loop; same verdicts, plus timing for the POSIX locator. */
export async function lookupCommandOnPathAsync(command: string, deps: ProbeDeps = {}): Promise<CommandLookup> {
  const platform = deps.platform ?? process.platform;
  const timing: CommandLookupTiming[] = [];
  const env = await withWindowsUserEnvironmentAsync(deps.env ?? ambientProcessEnv(), deps, timing);
  const runChild = deps.runProbeChildFn ?? runProbeChild;
  const existsSyncFn = deps.existsSyncFn ?? existsSync;
  if (platform === "win32") {
    return resolveCommandOnWindowsAsync(command, env, runChild, existsSyncFn, timing, deps.signal);
  }

  let missReason: RuntimeProbeUnavailableReason = "not_installed";
  const startedAt = process.hrtime.bigint();
  try {
    const { stdout } = await runChild("which", [command], {
      env,
      timeoutMs: POSIX_WHICH_TIMEOUT_MS,
      stderr: "ignore",
      platform,
      signal: deps.signal,
    });
    timing.push({ phase: "posix_which", ms: elapsedMs(startedAt), budgetMs: POSIX_WHICH_TIMEOUT_MS, outcome: "ok", truncated: false });
    const resolved = stdout.trim().split(/\r?\n/)[0];
    if (resolved) return { command: resolved, timing };
    missReason = "probe_failed";
  } catch (error) {
    // An aborted lookup never falls through to the user-local bin directories.
    rethrowIfAborted(error, deps.signal);
    timing.push({ phase: "posix_which", ms: elapsedMs(startedAt), budgetMs: POSIX_WHICH_TIMEOUT_MS, ...timingOutcome(error), ...cleanupOf(error) });
    missReason = classifyCommandLookupFailure(error, POSIX_WHICH_NOT_FOUND_EXIT);
  }
  const homeDir = deps.homeDir ?? env.HOME;
  const fallback = homeDir
    ? firstExistingPath(POSIX_USER_BIN_DIRS.map((segments) => path.posix.join(homeDir, ...segments, command)), deps)
    : null;
  return fallback ? { command: fallback, timing } : { command: null, missReason, timing };
}

export async function resolveCommandOnPathAsync(command: string, deps: ProbeDeps = {}): Promise<string | null> {
  return (await lookupCommandOnPathAsync(command, deps)).command;
}

/** {@link readCommandVersion} off the event loop. */
export async function readCommandVersionAsync(command: string, args: string[] = [], deps: ProbeDeps = {}): Promise<string | null> {
  const read = await readCommandVersionDetailedAsync(command, args, deps);
  return read.kind === "version" ? read.version : null;
}

/** Budget for one `<command> --version` child. */
export const COMMAND_VERSION_TIMEOUT_MS = 5000;

/**
 * task #1365 — what one `--version` read found, keeping why it failed. A
 * failed read is classified like any probe child (timeout, permission, other)
 * and carries a short path-free cause (code, exit status, signal); it is never a
 * version. "empty_output" is a child that exited 0 and printed nothing.
 */
export type CommandVersionRead =
  | { kind: "version"; version: string }
  | {
    kind: "failed";
    reason: Exclude<RuntimeProbeUnavailableReason, "not_installed" | "unsupported_version">;
    detail: string;
  };

function describeVersionReadFailure(error: unknown): string {
  // Structured fields only: stderr can carry local paths, and this cause ends
  // up in user-visible copy.
  const typed = (error ?? {}) as { code?: unknown; status?: unknown; signal?: unknown };
  const parts: string[] = [];
  if (typed.code === "ETIMEDOUT") parts.push(`did not finish within ${COMMAND_VERSION_TIMEOUT_MS} ms`);
  else if (typeof typed.code === "string") parts.push(`error ${typed.code}`);
  if (typeof typed.status === "number") parts.push(`exit status ${typed.status}`);
  if (typeof typed.signal === "string") parts.push(`signal ${typed.signal}`);
  return parts.length > 0 ? parts.join(", ") : "failed without a status";
}

/** {@link readCommandVersionAsync} keeping the failure's classification and cause; a cancel is rethrown, never a verdict. */
export async function readCommandVersionDetailedAsync(command: string, args: string[] = [], deps: ProbeDeps = {}): Promise<CommandVersionRead> {
  const env = await withWindowsUserEnvironmentAsync(deps.env ?? ambientProcessEnv(), deps);
  const runChild = deps.runProbeChildFn ?? runProbeChild;
  try {
    const { stdout } = await runChild(command, [...args, "--version"], {
      env,
      ...(deps.cwd ? { cwd: deps.cwd } : {}),
      timeoutMs: COMMAND_VERSION_TIMEOUT_MS,
      platform: deps.platform ?? process.platform,
      signal: deps.signal,
    });
    const version = stdout.trim().split(/\r?\n/)[0];
    return version ? { kind: "version", version } : { kind: "failed", reason: "probe_failed", detail: "exited 0 without printing a version" };
  } catch (error) {
    rethrowIfAborted(error, deps.signal);
    return { kind: "failed", reason: classifyProbeExecFailure(error), detail: describeVersionReadFailure(error) };
  }
}
