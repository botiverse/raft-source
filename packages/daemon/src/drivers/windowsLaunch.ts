import { ambientProcessEnv } from "../processEnvPatch";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { RuntimeExecutableNotFoundError } from "../spawnFailureErrors";
import { NodeHostUnavailableError, resolveNodeHostLaunch } from "./nodeHostLaunch";
import { type CommandLookup, formatCommandLookupTiming, lookupCommandOnPath, lookupCommandOnPathAsync, type ProbeDeps, WINDOWS_COMMAND_RESOLVE_TIMEOUT_MS } from "./probe";

/**
 * Runtime launches never go through cmd.exe.
 *
 * With `shell: true` on Windows, Node joins the argv with spaces into a single
 * cmd.exe command line without quoting anything. Runtime argv carries model
 * names, session ids, JSON settings and, for per-turn runtimes, the whole
 * prompt — so spaces split arguments, newlines cut the command short, and
 * cmd.exe metacharacters are interpreted instead of passed through.
 *
 * Node also refuses to spawn a `.cmd`/`.bat` file without a shell, so a batch
 * shim on PATH is resolved to what it would have run and launched directly:
 * npm/pnpm shims (`"%dp0%\node_modules\pkg\cli.js" %*`) become
 * `<node> <entry> ...args`, and shims wrapping an `.exe` become that `.exe`.
 * A shim we cannot resolve is a launch error, never a cmd.exe fallback.
 */
export interface DirectLaunch {
  command: string;
  args: string[];
  /** Set when the launch needs a different environment (e.g. Electron node mode). */
  env?: NodeJS.ProcessEnv;
  shell: false;
}

export interface WindowsLaunchDeps extends ProbeDeps {
  /**
   * Runtime-specific resolution for a batch wrapper on PATH, tried before the
   * generic shim parser (e.g. Cursor's wrapper runs a PowerShell script that
   * picks a versioned node.exe + index.js). Return null to fall through.
   */
  resolveBatchLaunch?: (shimPath: string, args: string[]) => DirectLaunch | null;
}

export function isWindowsBatchFile(command: string): boolean {
  const ext = path.win32.extname(command).toLowerCase();
  return ext === ".cmd" || ext === ".bat";
}

const SHIM_TARGET_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".exe", ".cmd", ".bat"]);
const SHIM_DIR_PREFIX = /^(?:%~dp0|%dp0%)\\*/i;

/**
 * Quoted paths a batch shim runs, in file order: npm and pnpm shims reference
 * the target relative to the shim (`%dp0%` / `%~dp0`), scoop shims by absolute
 * path. `node.exe` is the interpreter an npm shim prefers, not the CLI itself;
 * anything still holding a `%variable%` is not a path we can know.
 */
export function windowsShimTargets(shimPath: string, deps: WindowsLaunchDeps = {}): string[] {
  const readFileSyncFn = deps.readFileSyncFn ?? ((filePath: string) => readFileSync(filePath, "utf8"));
  let raw: string;
  try {
    raw = String(readFileSyncFn(shimPath, "utf8"));
  } catch {
    return [];
  }
  const winPath = path.win32;
  const shimDir = winPath.dirname(shimPath);
  const targets: string[] = [];
  for (const match of raw.matchAll(/"([^"\r\n]+)"/g)) {
    const quoted = match[1]!;
    const relative = quoted.replace(SHIM_DIR_PREFIX, "");
    const candidate = relative === quoted ? quoted : winPath.join(shimDir, relative);
    if (candidate.includes("%") || !winPath.isAbsolute(candidate)) continue;
    if (!SHIM_TARGET_EXTENSIONS.has(winPath.extname(candidate).toLowerCase())) continue;
    if (winPath.basename(candidate).toLowerCase() === "node.exe") continue;
    const target = winPath.normalize(candidate);
    if (target.toLowerCase() === winPath.normalize(shimPath).toLowerCase()) continue;
    if (!targets.includes(target)) targets.push(target);
  }
  return targets;
}

/**
 * Why a Windows runtime launch could not be resolved; recorded on the spawn
 * failure. Only `not_on_path` means the PATH lookup ran and reported the
 * command absent. `lookup_timed_out` / `lookup_failed` /
 * `lookup_permission_denied` mean the lookup itself did not deliver a verdict
 * (task #1240): the command may well be installed, so the message must not
 * tell the user to install it.
 */
export type WindowsLaunchFailureReason =
  | "not_on_path"
  | "lookup_timed_out"
  | "lookup_failed"
  | "lookup_permission_denied"
  | "batch_target_unresolved"
  | "node_unavailable";

/** Map an undecided PATH lookup to the launch failure reason it is reported under. */
function lookupMissReason(lookup: CommandLookup): Exclude<WindowsLaunchFailureReason, "batch_target_unresolved" | "node_unavailable"> {
  switch (lookup.missReason) {
    case "probe_timeout": return "lookup_timed_out";
    case "permission_denied": return "lookup_permission_denied";
    case "probe_failed": return "lookup_failed";
    case "not_installed":
    case "unsupported_version":
    case undefined:
    default:
      return "not_on_path";
  }
}

function describeUndecidedLookup(runtimeId: string, commandName: string, reason: WindowsLaunchFailureReason): string {
  const retry = `This is not evidence that ${runtimeId} is missing; Raft looks it up again on the next start. If it keeps happening, check that \`${commandName}\` runs in a new terminal, then restart Raft Computer.`;
  switch (reason) {
    // Each message states only what the failure code proves: a timeout says
    // the whole lookup exceeded its budget, not why; `lookup_failed` covers a
    // non-3 exit, a missing or unlaunchable powershell.exe, empty output, or a
    // hit that is only a .ps1 — none of which names a cause.
    case "lookup_timed_out":
      return `Cannot start ${runtimeId} on Windows: the PATH lookup for \`${commandName}\` did not finish within ${WINDOWS_COMMAND_RESOLVE_TIMEOUT_MS} ms. ${retry}`;
    case "lookup_permission_denied":
      return `Cannot start ${runtimeId} on Windows: the PATH lookup for \`${commandName}\` was denied permission to run. ${retry}`;
    default:
      return `Cannot start ${runtimeId} on Windows: the PATH lookup for \`${commandName}\` did not produce a usable result. ${retry}`;
  }
}

function launchFailure(runtimeId: string, reason: WindowsLaunchFailureReason, message: string): RuntimeExecutableNotFoundError {
  return new RuntimeExecutableNotFoundError({ runtimeId, message, reason });
}

function resolveNodeForShim(runtimeId: string, shimPath: string, deps: WindowsLaunchDeps): { command: string; env?: NodeJS.ProcessEnv; execArgv?: string[] } {
  try {
    const host = resolveNodeHostLaunch({
      env: deps.env ?? ambientProcessEnv(),
      execPath: deps.execPath,
      execIsElectron: deps.execIsElectron,
      execIsSea: deps.execIsSea,
      hasNodeRuntime: deps.hasNodeRuntime,
    });
    return { command: host.command, env: host.env, execArgv: host.execArgv };
  } catch (error) {
    if (!(error instanceof NodeHostUnavailableError)) throw error;
  }
  // The daemon host cannot run JavaScript (single-file build). Use the
  // interpreter the shim itself would have picked: its sibling node.exe, then
  // node on PATH.
  const existsSyncFn = deps.existsSyncFn ?? existsSync;
  const sibling = path.win32.join(path.win32.dirname(shimPath), "node.exe");
  if (existsSyncFn(sibling)) return { command: sibling };
  const nodeLookup = lookupCommandOnPath("node", deps);
  const onPath = nodeLookup.command;
  if (onPath && !isWindowsBatchFile(onPath)) return { command: onPath };
  if (!onPath && lookupMissReason(nodeLookup) !== "not_on_path") {
    const reason = lookupMissReason(nodeLookup);
    throw launchFailure(runtimeId, reason, describeUndecidedLookup(runtimeId, "node", reason));
  }
  throw launchFailure(
    runtimeId,
    "node_unavailable",
    `Cannot start ${runtimeId} on Windows: ${path.win32.basename(shimPath)} runs a Node.js script, but node.exe was not found next to it or on PATH. Install Node.js (https://nodejs.org) and restart Raft Computer, or install a native ${runtimeId} executable.`,
  );
}

/**
 * task #1277 — {@link resolveNodeForShim} off the event loop: the `node` PATH
 * lookup runs through the bounded probe child; every other step is file I/O.
 */
async function resolveNodeForShimAsync(runtimeId: string, shimPath: string, deps: WindowsLaunchDeps): Promise<{ command: string; env?: NodeJS.ProcessEnv; execArgv?: string[] }> {
  try {
    const host = resolveNodeHostLaunch({
      env: deps.env ?? ambientProcessEnv(),
      execPath: deps.execPath,
      execIsElectron: deps.execIsElectron,
      execIsSea: deps.execIsSea,
      hasNodeRuntime: deps.hasNodeRuntime,
    });
    return { command: host.command, env: host.env, execArgv: host.execArgv };
  } catch (error) {
    if (!(error instanceof NodeHostUnavailableError)) throw error;
  }
  const existsSyncFn = deps.existsSyncFn ?? existsSync;
  const sibling = path.win32.join(path.win32.dirname(shimPath), "node.exe");
  if (existsSyncFn(sibling)) return { command: sibling };
  const nodeLookup = await lookupCommandOnPathAsync("node", deps);
  const onPath = nodeLookup.command;
  if (onPath && !isWindowsBatchFile(onPath)) return { command: onPath };
  if (!onPath && lookupMissReason(nodeLookup) !== "not_on_path") {
    const reason = lookupMissReason(nodeLookup);
    throw launchFailure(runtimeId, reason, describeUndecidedLookup(runtimeId, "node", reason));
  }
  throw launchFailure(
    runtimeId,
    "node_unavailable",
    `Cannot start ${runtimeId} on Windows: ${path.win32.basename(shimPath)} runs a Node.js script, but node.exe was not found next to it or on PATH. Install Node.js (https://nodejs.org) and restart Raft Computer, or install a native ${runtimeId} executable.`,
  );
}

const MAX_SHIM_DEPTH = 3;

/**
 * Turn an already-resolved Windows command path into a direct launch.
 */
export function resolveWindowsDirectLaunch(
  runtimeId: string,
  command: string,
  args: string[],
  deps: WindowsLaunchDeps = {},
): DirectLaunch {
  const existsSyncFn = deps.existsSyncFn ?? existsSync;
  let current = command;
  let shim = command;
  for (let depth = 0; depth <= MAX_SHIM_DEPTH; depth += 1) {
    if (!isWindowsBatchFile(current)) {
      if (![".js", ".mjs", ".cjs"].includes(path.win32.extname(current).toLowerCase())) {
        return { command: current, args, shell: false };
      }
      const node = resolveNodeForShim(runtimeId, shim, deps);
      return { command: node.command, args: [...(node.execArgv ?? []), current, ...args], ...(node.env ? { env: node.env } : {}), shell: false };
    }
    const next = windowsShimTargets(current, deps).find((candidate) => existsSyncFn(candidate));
    if (!next) break;
    shim = current;
    current = next;
  }
  throw launchFailure(
    runtimeId,
    "batch_target_unresolved",
    `Cannot start ${runtimeId} on Windows: ${path.win32.basename(command)} is a batch wrapper (.cmd/.bat) whose target program could not be found, and Raft does not start runtimes through cmd.exe. Reinstall ${runtimeId} with npm (npm install -g) or install its native .exe, then restart Raft Computer.`,
  );
}

/** task #1277 — {@link resolveWindowsDirectLaunch} off the event loop. */
export async function resolveWindowsDirectLaunchAsync(
  runtimeId: string,
  command: string,
  args: string[],
  deps: WindowsLaunchDeps = {},
): Promise<DirectLaunch> {
  const existsSyncFn = deps.existsSyncFn ?? existsSync;
  let current = command;
  let shim = command;
  for (let depth = 0; depth <= MAX_SHIM_DEPTH; depth += 1) {
    if (!isWindowsBatchFile(current)) {
      if (![".js", ".mjs", ".cjs"].includes(path.win32.extname(current).toLowerCase())) {
        return { command: current, args, shell: false };
      }
      const node = await resolveNodeForShimAsync(runtimeId, shim, deps);
      return { command: node.command, args: [...(node.execArgv ?? []), current, ...args], ...(node.env ? { env: node.env } : {}), shell: false };
    }
    const next = windowsShimTargets(current, deps).find((candidate) => existsSyncFn(candidate));
    if (!next) break;
    shim = current;
    current = next;
  }
  throw launchFailure(
    runtimeId,
    "batch_target_unresolved",
    `Cannot start ${runtimeId} on Windows: ${path.win32.basename(command)} is a batch wrapper (.cmd/.bat) whose target program could not be found, and Raft does not start runtimes through cmd.exe. Reinstall ${runtimeId} with npm (npm install -g) or install its native .exe, then restart Raft Computer.`,
  );
}

/**
 * Launch spec for a runtime CLI found by name. Off Windows the name is passed
 * to spawn unchanged (PATH lookup by the OS), as before.
 */
export function resolveRuntimeLaunch(
  runtimeId: string,
  commandName: string,
  args: string[],
  deps: WindowsLaunchDeps = {},
): DirectLaunch {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") return { command: commandName, args, shell: false };
  const lookup = lookupCommandOnPath(commandName, deps);
  const command = lookup.command;
  if (!command) {
    const reason = lookupMissReason(lookup);
    if (reason !== "not_on_path") {
      // task #1240: the per-child timing rides on the log message (phase, ms,
      // budget, outcome), never on the user-facing copy, which stays neutral.
      const timing = formatCommandLookupTiming(lookup.timing);
      throw launchFailure(runtimeId, reason, `${describeUndecidedLookup(runtimeId, commandName, reason)}${timing ? ` [lookup: ${timing}]` : ""}`);
    }
    throw launchFailure(
      runtimeId,
      "not_on_path",
      `Cannot start ${runtimeId} on Windows: \`${commandName}\` was not found on PATH. Install it, check that \`${commandName}\` runs in a new terminal, then restart Raft Computer.`,
    );
  }
  if (deps.resolveBatchLaunch && isWindowsBatchFile(command)) {
    const launch = deps.resolveBatchLaunch(command, args);
    if (launch) return launch;
  }
  return resolveWindowsDirectLaunch(runtimeId, command, args, deps);
}
