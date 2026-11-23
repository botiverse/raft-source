// The only two ways a check touches the machine. `exec` runs an argv the
// check declared, without a shell, with stdin closed, stderr dropped, a fixed
// empty working directory and a minimal environment: the service's own env
// carries the Computer's credentials, and `gh` & co. are whatever an agent may
// have planted first on PATH. `readKeys` reads a file the check declared,
// keeping declared keys only.
import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import type { Readable } from "node:stream";
import { killRuntimeDetectionTree, type KillTreeOptions } from "../runtimeDetectionRound";
import { DECLARED_FILE_MAX_BYTES, readDeclaredKeys, readRegularFile } from "./declaredFile";
import type { CheckContext, ComputerCheck, DeclaredFile, ExecResult, ReadKeysResult } from "./types";

export const CHECK_COMMAND_TIMEOUT_MS = 5_000;
export const CHECK_MAX_CONCURRENT_COMMANDS = 3;
export const CHECK_STDOUT_MAX_BYTES = 64 * 1024;
export { DECLARED_FILE_MAX_BYTES };

/**
 * The child environment allowlist. From the parent: PATH (matched without
 * regard to case on Windows, where it is often `Path`, and passed as `PATH`),
 * LANG and LC_*. Set here: HOME (the Computer service user's home, never the
 * parent's value) and the switches below. Nothing else is passed.
 *
 * - GH_PROMPT_DISABLED, NO_UPDATE_NOTIFIER, NPM_CONFIG_UPDATE_NOTIFIER, CI:
 *   no prompts and no update checks.
 * - COREPACK_ENABLE_NETWORK=0: a `pnpm` that is a Corepack shim must not
 *   download a package manager to answer `--version`.
 * - VERCEL_TELEMETRY_DISABLED=1: `vercel --version` sends no telemetry.
 *
 * On Windows libuv adds a few system variables to every child whether or not
 * they are passed (SYSTEMROOT, SYSTEMDRIVE, WINDIR, TEMP, USERPROFILE,
 * USERNAME, USERDOMAIN, HOMEDRIVE, HOMEPATH, LOGONSERVER, copied from the
 * parent when absent); Windows programs cannot start without some of them.
 * None of them carries a Computer credential.
 */
const PASSED_ENV = /^(LANG|LC_[A-Z_]+)$/;
const QUIET_ENV: Readonly<Record<string, string>> = {
  GH_PROMPT_DISABLED: "1",
  NO_UPDATE_NOTIFIER: "1",
  NPM_CONFIG_UPDATE_NOTIFIER: "false",
  CI: "1",
  COREPACK_ENABLE_NETWORK: "0",
  VERCEL_TELEMETRY_DISABLED: "1",
};

/** See the allowlist above. */
export function checkChildEnv(
  parent: Readonly<Record<string, string | undefined>>,
  homeDir: string,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (platform === "win32" ? key.toUpperCase() === "PATH" : key === "PATH") env.PATH = value;
    else if (PASSED_ENV.test(key)) env[key] = value;
  }
  return { ...env, HOME: homeDir, ...QUIET_ENV };
}

export interface CheckChildProcess {
  pid?: number;
  stdout: Readable | null;
  once(event: "error", listener: (err: NodeJS.ErrnoException) => void): unknown;
  once(event: "close", listener: (code: number | null) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
}

export type CheckSpawn = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    stdio: ["ignore", "pipe", "ignore"];
    shell: false;
    windowsHide: true;
    detached: boolean;
  },
) => CheckChildProcess;

/**
 * `%SystemRoot%\System32\taskkill.exe`, by absolute path: a bare `taskkill`
 * is looked up on PATH, where an agent may have planted one.
 */
export function windowsTaskkillPath(systemRoot: string | undefined = process.env.SystemRoot): string {
  return path.win32.join(systemRoot || "C:\\Windows", "System32", "taskkill.exe");
}

/**
 * Kills a check command's process tree. On Windows taskkill runs from its
 * absolute path with the command's own minimal env, never the daemon's.
 */
export function killCheckTree(
  pid: number,
  platform: NodeJS.Platform,
  env: Record<string, string>,
  options: Pick<KillTreeOptions, "spawnFn"> & { systemRoot?: string } = {},
): void {
  killRuntimeDetectionTree(pid, platform, { taskkill: windowsTaskkillPath(options.systemRoot), env, spawnFn: options.spawnFn });
}

/** Lets at most `limit` commands run at once across every check of a run. */
export function commandSlots(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async (task) => {
    if (running >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    running += 1;
    try {
      return await task();
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  };
}

export interface CheckContextDeps {
  homeDir: string;
  /** An empty directory every command runs in, never the daemon's own cwd. */
  workDir: string;
  parentEnv: Readonly<Record<string, string | undefined>>;
  signal: AbortSignal;
  slots: <T>(task: () => Promise<T>) => Promise<T>;
  spawn?: CheckSpawn;
  commandTimeoutMs?: number;
  platform?: NodeJS.Platform;
  /** Kills a command and everything it started; `env` is the command's own. Tests substitute it. */
  killTree?: (pid: number, platform: NodeJS.Platform, env: Record<string, string>) => void;
}

/**
 * npm, pnpm and vercel are `.cmd` shims on Windows, which cannot be started
 * without cmd.exe (never used here), so "not found" is not evidence that they
 * are missing.
 */
const WINDOWS_SHIM_COMMANDS: ReadonlySet<string> = new Set(["npm", "pnpm", "vercel"]);

function sameArgv(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((part, i) => part === b[i]);
}

interface RunningCommand {
  /** Settles as soon as the answer is known (output, timeout, overflow). */
  result: Promise<ExecResult>;
  /** Settles once the command's process tree is gone. */
  exited: Promise<void>;
}

function startCommand(argv: readonly string[], deps: CheckContextDeps): RunningCommand {
  if (deps.signal.aborted) return { result: Promise.resolve({ unavailable: "timeout" }), exited: Promise.resolve() };
  const platform = deps.platform ?? process.platform;
  const spawn = deps.spawn ?? (nodeSpawn as unknown as CheckSpawn);
  const killTree = deps.killTree ?? killCheckTree;
  const env = checkChildEnv(deps.parentEnv, deps.homeDir, platform);
  let resolveResult!: (result: ExecResult) => void;
  let resolveExited!: () => void;
  const result = new Promise<ExecResult>((resolve) => { resolveResult = resolve; });
  const exited = new Promise<void>((resolve) => { resolveExited = resolve; });

  let settled = false;
  let child: CheckChildProcess | undefined;
  const chunks: Buffer[] = [];
  let bytes = 0;
  const finish = (outcome: ExecResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    deps.signal.removeEventListener("abort", onAbort);
    child?.stdout?.destroy();
    if (!("stdout" in outcome) && child) {
      if (child.pid !== undefined) killTree(child.pid, platform, env);
      else child.kill("SIGKILL");
    }
    resolveResult(outcome);
  };
  const onAbort = () => finish({ unavailable: "timeout" });
  const timer = setTimeout(onAbort, deps.commandTimeoutMs ?? CHECK_COMMAND_TIMEOUT_MS);
  deps.signal.addEventListener("abort", onAbort, { once: true });
  try {
    child = spawn(argv[0]!, argv.slice(1), {
      cwd: deps.workDir,
      env,
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
      windowsHide: true,
      // Own process group on POSIX, so a kill reaches whatever it started.
      detached: platform !== "win32",
    });
  } catch {
    finish({ unavailable: "failed" });
    resolveExited();
    return { result, exited };
  }
  const started = child;
  started.stdout?.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > CHECK_STDOUT_MAX_BYTES) finish({ unavailable: "failed" });
    else chunks.push(chunk);
  });
  started.once("error", (err) => {
    if (err.code === "ENOENT") {
      finish({ unavailable: platform === "win32" && WINDOWS_SHIM_COMMANDS.has(argv[0]!) ? "unsupported" : "not_installed" });
    } else {
      finish({ unavailable: "failed" });
    }
    // No pid: the process never started, and no close will follow.
    if (started.pid === undefined) resolveExited();
  });
  started.once("close", (code) => {
    finish({ stdout: Buffer.concat(chunks).toString("utf8"), exitCode: code ?? -1 });
    resolveExited();
  });
  return { result, exited };
}

export function createCheckContext(check: Pick<ComputerCheck, "id" | "commands" | "files">, deps: CheckContextDeps): CheckContext {
  return {
    signal: deps.signal,
    exec(argv) {
      if (!check.commands.some((declared) => sameArgv(declared, argv))) {
        return Promise.reject(new Error(`computer check ${check.id}: command not declared`));
      }
      // The answer comes back as soon as it is known; the slot is held until
      // the command's process tree has exited.
      return new Promise<ExecResult>((resolve) => {
        void deps.slots(async () => {
          const command = startCommand(argv, deps);
          resolve(await command.result);
          await command.exited;
        });
      });
    },
    async readKeys(file: DeclaredFile, param?: string): Promise<ReadKeysResult> {
      if (!check.files.includes(file)) throw new Error(`computer check ${check.id}: file not declared`);
      let relative = file.path;
      if (relative.includes("{param}")) {
        const shaped = param === undefined ? undefined : file.paramShape?.(param);
        if (shaped === undefined || shaped !== param) throw new Error(`computer check ${check.id}: bad file param`);
        relative = relative.split("{param}").join(shaped);
      }
      if (deps.signal.aborted) return { unavailable: "unreadable" };
      const read = await readRegularFile(path.join(deps.homeDir, relative), DECLARED_FILE_MAX_BYTES);
      return "text" in read ? readDeclaredKeys(file, read.text) : read;
    },
  };
}
