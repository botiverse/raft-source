import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { isAgentContextViewDaemonFailureReason } from "@botiverse/raft-shared";
import { resolveSelfExec, type SelfExecHost } from "@botiverse/raft-shared/src/selfExec";
import { ambientProcessEnv } from "../processEnvPatch";
import { currentSelfExecHost } from "../runtimeDetectionRound";
import { contextViewRestoreFailure, type ContextViewRestored, type ContextViewRestoreRequest } from "./contextViewRestore";
import { CONTEXT_VIEW_RESTORE_CHILD_MODE } from "./contextViewRestoreChild";
import { contextViewMemoryBytes } from "./contextViewSource";

export interface ContextViewRestoreOptions {
  /** Shorter than the default when the request already waited in the queue. */
  timeoutMs?: number;
  /** Ends the child: the daemon is stopping. */
  signal?: AbortSignal;
}

export type ContextViewRestorer = (request: ContextViewRestoreRequest, options?: ContextViewRestoreOptions) => Promise<ContextViewRestored>;

/**
 * A restore past this is `read_failed`, which offers a retry: with the source
 * cap and the Kimi record limit in place, a slow restore points at a busy host
 * more than at the file. Well inside the viewer's 30 s wait
 * (AGENT_CONTEXT_VIEW_VIEWER_WAIT_MS), leaving time for the result's POST.
 */
export const CONTEXT_VIEW_RESTORE_TIMEOUT_MS = 25_000;

/**
 * The most heap a restore child gets. A Claude Code session file at the source
 * cap (512 MiB) measured 750 MiB on the heap, and content made of many small
 * objects can cost more, plus the Kimi SDK when it loads. Past its limit the
 * child dies alone and the answer is `too_large`.
 */
export const CONTEXT_VIEW_RESTORE_MAX_HEAP_MB = 1024;

/**
 * An explicit flag switches off V8's own sizing from the memory limit, so this
 * has to do it: a quarter of the machine or container, at most the constant. On
 * a 1 GB container 1024 would leave the kernel's OOM killer to act before the
 * heap limit, and it might pick the daemon or an agent, not this child.
 */
export function contextViewRestoreHeapLimitMb(memoryBytes: number = contextViewMemoryBytes()): number {
  return Math.max(64, Math.min(CONTEXT_VIEW_RESTORE_MAX_HEAP_MB, Math.floor(memoryBytes / 4 / 2 ** 20)));
}

/**
 * Argv-level node flags the child must not inherit from the daemon's own launch
 * (a command-line flag wins over NODE_OPTIONS): another heap limit, or an
 * inspector that would stall every restore into its timeout.
 */
export function contextViewRestoreHost(host: SelfExecHost): SelfExecHost {
  return { ...host, execArgv: host.execArgv.filter((arg) => !/^--(?:max-old-space-size|max_old_space_size|inspect)/.test(arg)) };
}

/** Room for the `{outcome, attrs}` line before the body. */
const OUTPUT_HEADER_MAX_BYTES = 64 * 1024;
/** Enough of stderr to see V8's fatal line, which comes after a short GC trace. */
const STDERR_TAIL_BYTES = 16 * 1024;
const HEAP_EXHAUSTED_RE = /heap out of memory|Allocation failed/;

export interface ContextViewRestoreRunnerDeps {
  spawnFn?: typeof nodeSpawn;
  host?: SelfExecHost;
  env?: NodeJS.ProcessEnv;
  maxHeapMb?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * The heap limit goes through the environment: a SEA hands all its argv to the
 * app, never to node. It replaces any NODE_OPTIONS the daemon inherited, whose
 * preloads or flags could write to the stdout this protocol reads or abort the
 * child: a restore needs none of them.
 */
export function contextViewRestoreChildEnv(env: NodeJS.ProcessEnv, maxHeapMb = contextViewRestoreHeapLimitMb()): NodeJS.ProcessEnv {
  return { ...env, NODE_OPTIONS: `--max-old-space-size=${maxHeapMb}` };
}

function sourceBytes(file: string): number | undefined {
  try {
    return statSync(file).size;
  } catch {
    return undefined;
  }
}

function decodeOutput(output: Buffer): ContextViewRestored | null {
  const lineEnd = output.indexOf(0x0a);
  if (lineEnd < 0) return null;
  try {
    const header = JSON.parse(output.toString("utf8", 0, lineEnd)) as { outcome?: unknown; attrs?: unknown };
    const { outcome } = header;
    if ((outcome !== "ok" && !isAgentContextViewDaemonFailureReason(outcome)) || typeof header.attrs !== "object" || header.attrs === null) return null;
    return { outcome, attrs: header.attrs as Record<string, unknown>, json: output.toString("utf8", lineEnd + 1) };
  } catch {
    return null;
  }
}

/** One restore in a child process of this binary. Never rejects: a child that fails is a failure body. */
export function restoreContextViewInChild(request: ContextViewRestoreRequest, options: ContextViewRestoreOptions = {}, deps: ContextViewRestoreRunnerDeps = {}): Promise<ContextViewRestored> {
  const spawnFn = deps.spawnFn ?? nodeSpawn;
  const setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const maxOutput = request.maxBytes + OUTPUT_HEADER_MAX_BYTES;

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let timer: unknown;
    const settle = (restored: ContextViewRestored) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      resolve({ ...restored, attrs: { ...restored.attrs, restore_child: true, restore_child_ms: Date.now() - startedAt } });
    };

    if (options.signal?.aborted) {
      settle(contextViewRestoreFailure("read_failed", "restore_child_aborted"));
      return;
    }

    let child: ChildProcess;
    try {
      const { command, args } = resolveSelfExec([CONTEXT_VIEW_RESTORE_CHILD_MODE], contextViewRestoreHost(deps.host ?? currentSelfExecHost()));
      child = spawnFn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: contextViewRestoreChildEnv(deps.env ?? ambientProcessEnv(), deps.maxHeapMb),
      });
    } catch (error) {
      settle(contextViewRestoreFailure("read_failed", "restore_child_spawn_failed", { error_class: error instanceof Error ? error.name : "Error" }));
      return;
    }

    const failed = (reason: "read_failed" | "too_large", detail: string, attrs: Record<string, unknown> = {}) =>
      contextViewRestoreFailure(reason, detail, { source_bytes: sourceBytes(request.file), ...attrs });
    const stop = (restored: ContextViewRestored) => {
      child.kill("SIGKILL");
      settle(restored);
    };
    timer = setTimer(() => stop(failed("read_failed", "restore_child_timeout")), options.timeoutMs ?? CONTEXT_VIEW_RESTORE_TIMEOUT_MS);
    const onAbort = () => stop(failed("read_failed", "restore_child_aborted"));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("close", () => options.signal?.removeEventListener("abort", onAbort));

    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
    });

    const chunks: Buffer[] = [];
    let received = 0;
    child.stdout?.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxOutput) {
        stop(failed("too_large", "restore_child_output_over_cap"));
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", (error) => settle(contextViewRestoreFailure("read_failed", "restore_child_spawn_failed", { error_class: error.name })));
    child.on("close", (code, signal) => {
      const decoded = code === 0 ? decodeOutput(Buffer.concat(chunks)) : null;
      if (decoded) return settle(decoded);
      const exit = { child_signal: signal ?? undefined, child_exit_code: code ?? undefined };
      // Only V8's own fatal line says memory: a SIGABRT or SIGKILL alone can be anything, and a retry may help.
      if (HEAP_EXHAUSTED_RE.test(stderrTail)) return settle(failed("too_large", "restore_child_out_of_memory", exit));
      settle(failed("read_failed", "restore_child_failed", exit));
    });
    // A child gone before it read its request surfaces at `close`.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(JSON.stringify(request));
  });
}
