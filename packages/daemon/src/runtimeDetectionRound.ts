import { ambientProcessEnv } from "./processEnvPatch";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { resolveSelfExec, selfExecHostFromProcess, type SelfExecHost } from "@botiverse/raft-shared/src/selfExec";
import type { RuntimeDetection, RuntimeDetectionCheckedRuntime } from "./core";
import { seaDetected } from "./drivers/nodeHostLaunch";
import { liveHostExecutablePath } from "./drivers/liveHostExecutable";
import { parseRuntimeDetectionChildLine, RUNTIME_DETECTION_CHILD_MODE } from "./runtimeDetectionChild";

/**
 * task #1268: one runtime detection round in a child process, bounded by a
 * real deadline. The parent streams the child's per-runtime results so an
 * early end (deadline, crash, cancel) still yields a partial inventory plus the
 * exact list of runtimes that were never probed.
 */

/** Whole-round deadline; env `RAFT_RUNTIME_DETECTION_DEADLINE_MS` overrides (>= 1000). */
export const RUNTIME_DETECTION_ROUND_DEADLINE_MS = 90_000;
/**
 * After a kill (deadline or cancel) the result waits this long for the child's
 * `close` before settling with `cleanup.childExited: false`. "Kill requested"
 * is never reported as "cleaned up".
 */
export const RUNTIME_DETECTION_CLEANUP_VERIFY_MS = 5_000;

export type RuntimeDetectionRoundResult =
  | { status: "complete"; detection: RuntimeDetection; durationMs: number }
  | {
      status: "incomplete";
      reason: "deadline" | "child_failed" | "cancelled";
      /** Partial inventory assembled from the runtimes the child did report. */
      detection: RuntimeDetection;
      /** Known runtime ids the child never reported, in catalog order. */
      unfinishedRuntimes: string[];
      durationMs: number;
      exitCode?: number | null;
      signal?: string | null;
      /** Credential-free, path-free failure detail (child error line or spawn error code). */
      detail?: string;
      /**
       * Present when the round killed its child (deadline / cancel): whether the
       * child's exit was observed within the verification window. A false value
       * means a probe may still be running and must be reported, not hidden.
       * `waitedMs` is the measured time until the exit was observed, or, when
       * it was not, the verification window itself (the timer that ended the
       * wait is what defines "waited"; a wall-clock measurement can read a
       * millisecond short of it because libuv's timer clock is coarse).
       */
      cleanup?: { childExited: boolean; waitedMs: number };
    };

export interface RuntimeDetectionSelfExec {
  command: string;
  args: string[];
}

export interface RuntimeDetectionRoundOptions {
  /** Every runtime id the round is expected to report, in catalog order. */
  knownRuntimeIds: readonly string[];
  deadlineMs?: number;
  selfExec?: RuntimeDetectionSelfExec;
  spawnFn?: typeof nodeSpawn;
  /** How long to wait for the killed child's close before reporting cleanup as unconfirmed. */
  cleanupVerifyMs?: number;
  platform?: NodeJS.Platform;
  killTree?: (pid: number, platform: NodeJS.Platform) => void;
  env?: NodeJS.ProcessEnv;
}

export interface RuntimeDetectionRoundHandle {
  result: Promise<RuntimeDetectionRoundResult>;
  /** Kill the child and its process tree; the result settles as incomplete/cancelled. */
  cancel(): void;
}

/** The running process as a self-exec host; a SEA re-execs its live path. */
export function currentSelfExecHost(): SelfExecHost {
  const isSea = seaDetected() === true;
  return selfExecHostFromProcess(process, isSea, isSea ? liveHostExecutablePath() : process.execPath);
}

/**
 * Argv that re-executes this daemon in detection-child mode, per host shape
 * (resolveSelfExec): Node + execArgv + the entry script, the SEA binary
 * itself, or the Electron app launcher whose argv guard routes the mode. The
 * standalone daemon entry, the Computer entry and Raft Desktop's main all
 * dispatch `__detect-runtimes`.
 */
export function defaultRuntimeDetectionSelfExec(host: SelfExecHost = currentSelfExecHost()): RuntimeDetectionSelfExec {
  const { command, args } = resolveSelfExec([RUNTIME_DETECTION_CHILD_MODE], host);
  return { command, args };
}

/**
 * Kill the detection child and everything it started (npm, PowerShell, probe
 * children). POSIX: the child runs in its own process group, so -pid reaches
 * the whole tree; Windows has no groups, so `taskkill /T` walks it.
 */
export function killRuntimeDetectionTree(pid: number, platform: NodeJS.Platform): void {
  try {
    if (platform === "win32") {
      nodeSpawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, env: ambientProcessEnv() }).on("error", () => {});
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // already gone
  }
}

export function runtimeDetectionDeadlineMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RAFT_RUNTIME_DETECTION_DEADLINE_MS;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 1000 ? Math.floor(parsed) : RUNTIME_DETECTION_ROUND_DEADLINE_MS;
}

export function runRuntimeDetectionRound(options: RuntimeDetectionRoundOptions): RuntimeDetectionRoundHandle {
  const platform = options.platform ?? process.platform;
  const spawnFn = options.spawnFn ?? nodeSpawn;
  const killTree = options.killTree ?? killRuntimeDetectionTree;
  const deadlineMs = options.deadlineMs ?? runtimeDetectionDeadlineMs();
  const selfExec = options.selfExec ?? defaultRuntimeDetectionSelfExec();
  const startedAt = process.hrtime.bigint();
  const elapsedMs = () => Number((process.hrtime.bigint() - startedAt) / 1_000_000n);

  const ids: string[] = [];
  const versions: Record<string, string> = {};
  const diagnostics: Record<string, string> = {};
  const unavailableReasons: Record<string, RuntimeDetection["unavailableReasons"] extends infer U ? (U extends Record<string, infer R> ? R : never) : never> = {};
  const reported = new Set<string>();
  const partial = (): RuntimeDetection => ({
    ids: [...ids],
    versions: { ...versions },
    ...(Object.keys(diagnostics).length > 0 ? { diagnostics: { ...diagnostics } } : {}),
    ...(Object.keys(unavailableReasons).length > 0 ? { unavailableReasons: { ...unavailableReasons } } : {}),
  });
  const unfinished = () => options.knownRuntimeIds.filter((id) => !reported.has(id));

  let child: ChildProcess | null = null;
  let settled = false;
  /** A kill is in progress: the ordinary close handler must not settle first. */
  let killing = false;
  let done: RuntimeDetection | null = null;
  let childError: string | undefined;
  let timer: NodeJS.Timeout | null = null;
  let resolveResult!: (result: RuntimeDetectionRoundResult) => void;
  const result = new Promise<RuntimeDetectionRoundResult>((resolve) => { resolveResult = resolve; });

  const settle = (value: RuntimeDetectionRoundResult) => {
    if (settled) return;
    settled = true;
    if (timer) { clearTimeout(timer); timer = null; }
    resolveResult(value);
  };
  let childClosed = false;
  const kill = () => {
    if (child?.pid) killTree(child.pid, platform);
  };
  /** Kill, then wait (bounded) for the child's close so cleanup is observed, not assumed. */
  const killAndSettle = (reason: "deadline" | "cancelled") => {
    kill();
    const killedAt = process.hrtime.bigint();
    const verifyMs = options.cleanupVerifyMs ?? RUNTIME_DETECTION_CLEANUP_VERIFY_MS;
    const measuredMs = () => Number((process.hrtime.bigint() - killedAt) / 1_000_000n);
    const finish = (childExited: boolean) => settle({
      status: "incomplete",
      reason,
      detection: partial(),
      unfinishedRuntimes: unfinished(),
      durationMs: elapsedMs(),
      // Observed exit: how long it took. Not observed: the window we waited,
      // as enforced by the timer below (never a wall-clock reading that can
      // fall a millisecond short of it).
      cleanup: { childExited, waitedMs: childExited ? measuredMs() : verifyMs },
    });
    if (childClosed || !child) { finish(childClosed); return; }
    const verifyTimer = setTimeout(() => finish(false), verifyMs);
    verifyTimer.unref?.();
    child.once("close", () => { clearTimeout(verifyTimer); finish(true); });
  };

  const recordChecked = (checked: RuntimeDetectionCheckedRuntime) => {
    if (reported.has(checked.runtime)) return;
    reported.add(checked.runtime);
    if (checked.available) ids.push(checked.runtime);
    if (checked.version) versions[checked.runtime] = checked.version;
    if (checked.diagnostic) diagnostics[checked.runtime] = checked.diagnostic;
    if (checked.unavailableReason) unavailableReasons[checked.runtime] = checked.unavailableReason;
  };

  try {
    child = spawnFn(selfExec.command, selfExec.args, {
      stdio: ["ignore", "pipe", "ignore"],
      env: options.env ?? ambientProcessEnv(),
      detached: platform !== "win32",
      windowsHide: true,
    });
  } catch (error) {
    settle({
      status: "incomplete",
      reason: "child_failed",
      detection: partial(),
      unfinishedRuntimes: unfinished(),
      durationMs: elapsedMs(),
      detail: `spawn threw ${(error as { code?: string }).code ?? "unknown"}`,
    });
    return { result, cancel: () => {} };
  }

  child.on("error", (error: NodeJS.ErrnoException) => {
    settle({
      status: "incomplete",
      reason: "child_failed",
      detection: partial(),
      unfinishedRuntimes: unfinished(),
      durationMs: elapsedMs(),
      detail: `spawn error ${error.code ?? "unknown"}`,
    });
  });

  if (child.stdout) {
    const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    lines.on("line", (line) => {
      const parsed = parseRuntimeDetectionChildLine(line);
      if (!parsed) return;
      if (parsed.event === "checked") {
        const { event: _event, ...checked } = parsed;
        recordChecked(checked);
      } else if (parsed.event === "done") {
        for (const id of parsed.detection.ids) reported.add(id);
        done = parsed.detection;
      } else {
        childError = parsed.message;
      }
    });
  }

  child.on("close", (code, signal) => {
    childClosed = true;
    if (settled || killing) return;
    if (done && code === 0) {
      settle({ status: "complete", detection: done, durationMs: elapsedMs() });
      return;
    }
    settle({
      status: "incomplete",
      reason: "child_failed",
      detection: partial(),
      unfinishedRuntimes: unfinished(),
      durationMs: elapsedMs(),
      exitCode: code,
      signal,
      ...(childError ? { detail: childError.slice(0, 200) } : {}),
    });
  });

  timer = setTimeout(() => {
    if (settled || killing) return;
    killing = true;
    killAndSettle("deadline");
  }, deadlineMs);
  timer.unref?.();

  return {
    result,
    cancel: () => {
      if (settled || killing) return;
      killing = true;
      if (timer) { clearTimeout(timer); timer = null; }
      killAndSettle("cancelled");
    },
  };
}
