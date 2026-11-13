import { ambientProcessEnv } from "../processEnvPatch";
import {
  type ChildProcess,
  spawn,
  spawnSync,
} from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access as fsAccess } from "node:fs/promises";

import {
  createBashTool,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";
import { clearClockTimeout, setClockTimeout } from "@botiverse/raft-shared";
import { Type } from "typebox";

import { createWindowsPowerShellChildEnv } from "./windowsPowerShellEnv";
import { defaultProcessTreeOps, type ProcessTreeEntry, type ProcessTreeOps } from "./processTree";
import type { PiToolExecutionObserver } from "./piToolExecutionObservability";

const POWERSHELL_STDIN_LOADER = [
  "$raftReader = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.Encoding]::ASCII, $false)",
  "try { $raftEncodedScript = $raftReader.ReadToEnd() } finally { $raftReader.Dispose() }",
  "$raftScript = [System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String($raftEncodedScript))",
  "& ([ScriptBlock]::Create($raftScript))",
].join("\r\n");
const POWERSHELL_ARGS = [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
  POWERSHELL_STDIN_LOADER,
] as const;
const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;
const EXIT_STDIO_GRACE_MS = 100;

export interface PiCommandToolDeps {
  platform?: NodeJS.Platform;
  spawn?: typeof spawn;
  killProcessTree?: (pid: number) => void;
  /** Test seam: the descendant snapshot taken before the group kill. */
  processTree?: Pick<ProcessTreeOps, "snapshotDescendants" | "killEntries">;
  observer?: PiToolExecutionObserver;
  /** Test seam for DEFAULT_COMMAND_TIMEOUT_SECONDS. */
  defaultTimeoutSeconds?: number;
}

function killWindowsProcessTree(pid: number): void {
  const killer = spawn("taskkill.exe", ["/F", "/T", "/PID", String(pid)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: ambientProcessEnv(),
  });
  killer.unref();
}

function killPosixProcessTree(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process already exited.
    }
  }
}

function resolvePosixShell(): { shell: string; args: string[] } {
  if (existsSync("/bin/bash")) return { shell: "/bin/bash", args: ["-c"] };
  try {
    const result = spawnSync("which", ["bash"], {
      env: ambientProcessEnv(),
      encoding: "utf8",
      timeout: 5_000,
    });
    const shell = result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : "";
    if (shell) return { shell, args: ["-c"] };
  } catch {
    // Fall through to the same POSIX shell fallback as Pi.
  }
  return { shell: "sh", args: ["-c"] };
}

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("Invalid timeout: must be a finite number of seconds");
  }
  const timeoutMs = timeout * 1000;
  if (timeoutMs > 2_147_483_647) {
    throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  return timeoutMs;
}

function waitForChildProcess(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let postExitTimer: unknown;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;

    const cleanup = () => {
      if (postExitTimer) clearClockTimeout(postExitTimer);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
    };
    const finalize = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(code);
    };
    const maybeFinalizeAfterExit = () => {
      if (exited && stdoutEnded && stderrEnded) finalize(exitCode);
    };
    const armIdleTimer = () => {
      if (postExitTimer) clearClockTimeout(postExitTimer);
      postExitTimer = setClockTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
    };
    const onData = () => {
      if (exited && !settled) armIdleTimer();
    };
    const onStdoutEnd = () => {
      stdoutEnded = true;
      maybeFinalizeAfterExit();
    };
    const onStderrEnd = () => {
      stderrEnded = true;
      maybeFinalizeAfterExit();
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null) => {
      exited = true;
      exitCode = code;
      maybeFinalizeAfterExit();
      if (!settled) armIdleTimer();
    };
    const onClose = (code: number | null) => finalize(code);

    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

export function buildPiPowerShellScript(command: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    // `::new`, not `New-Object`: Windows PowerShell 5.1 ignores a
    // PSObject-wrapped $OutputEncoding when piping into a native command and
    // falls back to ASCII, so CJK reached e.g. `node`/`git` as "????".
    "$utf8NoBom = [System.Text.UTF8Encoding]::new($false)",
    "[Console]::OutputEncoding = $utf8NoBom",
    "$OutputEncoding = $utf8NoBom",
    "$global:LASTEXITCODE = 0",
    "& {",
    command,
    "}",
    "$raftCommandSucceeded = $?",
    "$raftNativeExitCode = $global:LASTEXITCODE",
    "if ($raftNativeExitCode -ne 0) { exit $raftNativeExitCode }",
    "if (-not $raftCommandSucceeded) { exit 1 }",
    "exit 0",
    "",
  ].join("\r\n");
}

export function createPiPowerShellOperations(
  deps: Pick<PiCommandToolDeps, "spawn" | "killProcessTree" | "observer"> = {},
): BashOperations {
  const spawnProcess = deps.spawn ?? spawn;
  const killProcessTree = deps.killProcessTree ?? killWindowsProcessTree;

  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      if (signal?.aborted) throw new Error("aborted");
      if (
        timeout !== undefined &&
        (!Number.isFinite(timeout) ||
          timeout <= 0 ||
          timeout > MAX_TIMEOUT_SECONDS)
      ) {
        throw new Error(
          `Invalid timeout: must be between 0 and ${MAX_TIMEOUT_SECONDS} seconds`,
        );
      }

      const child = spawnProcess("powershell.exe", [...POWERSHELL_ARGS], {
        cwd,
        env: createWindowsPowerShellChildEnv(env),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      deps.observer?.observeProcessSpawned(child, {
        processTreeTracking: "unknown",
        stdioMode: "pipe",
      });
      const observeData = (data: Buffer) => {
        deps.observer?.observeProcessProgress(data.byteLength);
        onData(data);
      };
      child.stdout.on("data", observeData);
      child.stderr.on("data", observeData);
      child.stdin.on("error", () => undefined);
      child.stdin.end(
        Buffer.from(buildPiPowerShellScript(command), "utf16le").toString(
          "base64",
        ),
      );

      let timedOut = false;
      const terminate = () => {
        if (child.pid) killProcessTree(child.pid);
      };
      const timeoutHandle =
        timeout === undefined
          ? undefined
          : setClockTimeout(() => {
              timedOut = true;
              terminate();
            }, timeout * 1000);
      const onAbort = () => terminate();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) terminate();

      try {
        const exitCode = await new Promise<number | null>((resolve, reject) => {
          child.once("error", (error) => {
            deps.observer?.observeProcessExit({
              code: null,
              signal: null,
              spawnError: true,
            });
            reject(error);
          });
          child.once("close", (code, signal) => {
            deps.observer?.observeProcessExit({ code, signal });
            resolve(code);
          });
        });
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) {
          deps.observer?.observeTimeout();
          throw new Error(`timeout:${timeout}`);
        }
        return { exitCode };
      } finally {
        if (timeoutHandle) clearClockTimeout(timeoutHandle);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

export function createPiPosixOperations(
  deps: Pick<PiCommandToolDeps, "spawn" | "killProcessTree" | "processTree" | "observer"> = {},
): BashOperations {
  const spawnProcess = deps.spawn ?? spawn;
  const killProcessTree = deps.killProcessTree ?? killPosixProcessTree;
  const processTree = deps.processTree ?? defaultProcessTreeOps;

  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      const timeoutMs = resolveTimeoutMs(timeout);
      if (signal?.aborted) throw new Error("aborted");
      try {
        await fsAccess(cwd, constants.F_OK);
      } catch {
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
      }

      const shellConfig = resolvePosixShell();
      const child = spawnProcess(shellConfig.shell, [...shellConfig.args, command], {
        cwd,
        detached: true,
        env: env ?? ambientProcessEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      deps.observer?.observeProcessSpawned(child, {
        processTreeTracking: "process_group",
        stdioMode: "pipe",
      });

      let timedOut = false;
      let timeoutHandle: unknown;
      // task #25 step 2: the group kill misses a child that left the group
      // (`setsid`), and once the shell dies that child can no longer be found
      // from it. Read the tree first, then kill the group and the tree.
      const terminate = () => {
        const pid = child.pid;
        if (!pid) return;
        void processTree.snapshotDescendants(pid).then(
          (tree: ProcessTreeEntry[]) => {
            killProcessTree(pid);
            processTree.killEntries(tree);
          },
          () => killProcessTree(pid),
        );
      };
      const onAbort = () => terminate();
      const observeData = (data: Buffer) => {
        deps.observer?.observeProcessProgress(data.byteLength);
        onData(data);
      };

      try {
        if (timeoutMs !== undefined) {
          timeoutHandle = setClockTimeout(() => {
            timedOut = true;
            terminate();
          }, timeoutMs);
        }
        child.stdout?.on("data", observeData);
        child.stderr?.on("data", observeData);
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }
        child.once("error", () => {
          deps.observer?.observeProcessExit({
            code: null,
            signal: null,
            spawnError: true,
          });
        });
        child.once("exit", (code, exitSignal) => {
          deps.observer?.observeProcessExit({ code, signal: exitSignal });
        });
        const exitCode = await waitForChildProcess(child);
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) {
          deps.observer?.observeTimeout();
          throw new Error(`timeout:${timeout}`);
        }
        return { exitCode };
      } finally {
        if (timeoutHandle) clearClockTimeout(timeoutHandle);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

/**
 * Pi's command tool has no default timeout, so a command that never exits
 * (a dev server, a watcher, a prompt for input) keeps the agent's turn open
 * forever. A call without a timeout gets this one; the process tree is killed
 * when it runs out, like an explicit timeout. An explicit timeout is kept as
 * passed, so long builds can still ask for more. Claude Code's 10 minute
 * Bash limit moves the command to the background instead; Pi has no
 * background path, so the limit kills.
 */
export const DEFAULT_COMMAND_TIMEOUT_SECONDS = 600;

export function defaultCommandTimeoutHint(text: string, timeoutSeconds = DEFAULT_COMMAND_TIMEOUT_SECONDS): string {
  return `${text}\n\nThe command was stopped by the default limit of ${timeoutSeconds} seconds for commands run without a timeout. ` +
    "If it needs longer, run it again with an explicit timeout in seconds, " +
    "or start it in the background with its output redirected to a file and check that file.";
}

type PiCommandTool = ReturnType<typeof createBashTool>;

function withDefaultCommandTimeout(tool: PiCommandTool, timeoutSeconds: number): PiCommandTool {
  const execute = tool.execute.bind(tool);
  const parameters = tool.parameters;
  const timedOutAtDefault = `Command timed out after ${timeoutSeconds} seconds`;
  return {
    ...tool,
    description: `${tool.description} Commands run without a timeout are stopped after ${timeoutSeconds} seconds;` +
      " pass a larger timeout for a command that needs longer.",
    parameters: {
      ...parameters,
      properties: {
        ...parameters.properties,
        timeout: Type.Optional(Type.Number({ description: `Timeout in seconds (optional, default ${timeoutSeconds})` })),
      },
    },
    execute: async (toolCallId, params, ...rest) => {
      if (params.timeout !== undefined) return execute(toolCallId, params, ...rest);
      try {
        return await execute(toolCallId, { ...params, timeout: timeoutSeconds }, ...rest);
      } catch (err) {
        if (err instanceof Error && err.message.endsWith(timedOutAtDefault)) {
          throw new Error(defaultCommandTimeoutHint(err.message, timeoutSeconds));
        }
        throw err;
      }
    },
  };
}

export function createPiCommandTool(
  cwd: string,
  toolSpawnEnv: NodeJS.ProcessEnv,
  deps: PiCommandToolDeps = {},
): ReturnType<typeof createBashTool> {
  const platform = deps.platform ?? process.platform;
  const tool = createBashTool(cwd, {
    ...(platform === "win32"
      ? { operations: createPiPowerShellOperations(deps) }
      // Built-in and Pi both use Raft's POSIX operations (same `bash -c`
      // spawn as Pi's own), so both get the tree kill above.
      : { operations: createPiPosixOperations(deps) }),
    spawnHook: (spawnContext) => ({
      ...spawnContext,
      env: {
        ...spawnContext.env,
        ...toolSpawnEnv,
      },
    }),
  });

  const labeledTool = withDefaultCommandTimeout(platform !== "win32"
    ? tool
    : {
        ...tool,
        label: "PowerShell",
        description:
          "Execute a Windows PowerShell 5.1 command in the current working directory. " +
          "Use PowerShell syntax, not Bash syntax. Standard output and standard error are returned.",
      }, deps.defaultTimeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS);
  if (!deps.observer) return labeledTool;

  const execute = labeledTool.execute.bind(labeledTool);
  return {
    ...labeledTool,
    execute: (runtimeToolCallId, params, signal, onUpdate) =>
      deps.observer!.runToolExecution(
        runtimeToolCallId,
        signal,
        () => execute(runtimeToolCallId, params, signal, onUpdate),
      ),
  };
}
